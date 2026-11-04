import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import * as store from '../server/runtime/store.mjs'
import { excludedChecksMs, interruptedFromEvents, meanRound, wallClockElapsedMs, wallClockRefusal, wallClockStanding } from '../server/runtime/wall-clock.mjs'
import { wallClockAt, wallClockPrefill, wallClockUsedMinutes } from '../src/wall-clock.js'
import { getRun } from '../server/runs-api.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures, scriptFor, simulateProcessDeath } from './fakes/fixture.mjs'

const MIN = 60_000
const T0 = Date.parse('2026-09-10T00:00:00.000Z')
const at = (m) => new Date(T0 + m * MIN).toISOString()
const now = (m) => T0 + m * MIN
const check = (from, minutes) => ({ at: at(from), durationMs: minutes * MIN })
const running = (extra = {}) => ({ status: 'running', startedAt: at(0), steps: [], participants: {}, checkResults: [], budgets: { limits: { wallClockMinutes: 240 } }, ...extra })
const turn = (role, from, to, extra = {}) => ({ number: '001', role, phase: 'implement-review', round: 0, startedAt: at(from), endedAt: at(to), durationMs: (to - from) * MIN, ...extra })
const excluded = (run, m, options) => excludedChecksMs(run, now(m), options) / MIN

const start = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath,
  projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})
const reopen = (f, runId) => resumeRun({
  issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot,
  deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath
})
class Crash extends Error {}
/** Crash where asked, then persist what a restarted server's reconcile() writes. */
async function lostOwner (f, hookName, when, edit = () => {}) {
  const engine = await start(f)
  engine.hooks[hookName] = async (e) => { if (when(e)) { delete e.hooks[hookName]; throw new Crash(hookName) } }
  try { await engine.drive() } catch (error) { if (!(error instanceof Crash)) throw error }
  await simulateProcessDeath(f.issuePath)
  const run = await store.readRun(f.issuePath, engine.runId)
  run.status = 'blocked'
  run.outcome = 'unresolved'
  run.blockedReason = 'recovery-required'
  run.recovery = { required: true, ownerLost: true, reason: 'test', detectedAt: f.clock.iso(), lastActivityAt: f.clock.iso() }
  if (run.workspace?.state === 'active') run.workspace.state = 'retained'
  edit(run)
  await store.writeRun(f.issuePath, engine.runId, run)
  return engine.runId
}
const pendingOf = (run) => Object.values(run.participants).find((p) => p.pendingInvocation)?.pendingInvocation

export default async function (t) {
  t.section('only waiting for checks with no seat turn running is free')
  {
    t.eq('a check alone is free', excluded(running({ checkResults: [check(10, 20)] }), 40), 20)
    t.eq('and leaves the rest of the time counted', wallClockElapsedMs(running({ checkResults: [check(10, 20)] }), now(40)) / MIN, 20)
    t.eq('a check beside a seat turn is not', excluded(running({ checkResults: [check(10, 20)], steps: [turn('auditor-1', 5, 30)] }), 40), 0)
    t.eq('only the part past the turn is', excluded(running({ checkResults: [check(10, 20)], steps: [turn('auditor-1', 5, 25)] }), 40), 5)
    t.eq('a turn in flight is a seat working', excluded(running({ checkResults: [check(10, 20)], participants: { a: { pendingInvocation: { startedAt: at(20) } } } }), 40), 10)
    t.eq('a base drive reused from the cache was another run\'s time', excluded(running({ baselineChecks: [{ ...check(10, 20), reused: { key: 'k' } }] }), 40), 0)
    t.eq('a check never recorded excuses nothing', excluded(running(), 40), 0)
  }

  t.section('the exemption holds during the wait itself')
  {
    t.eq('a running check is free from when it began', excluded(running(), 30, { liveCheckSince: now(10) }), 20)
    t.eq('except beside a seat turn in flight', excluded(running({ participants: { a: { pendingInvocation: { startedAt: at(20) } } } }), 30, { liveCheckSince: now(10) }), 10)
    const standing = wallClockStanding(running(), {}, now(30), { liveCheckSince: now(10) })
    t.eq('the standing the panel reads agrees', [standing.elapsedMs / MIN, standing.excludedChecksMs / MIN, standing.remainingMs / MIN], [10, 20, 230])
  }

  t.section('a stop is not excused twice')
  {
    const pausedOn = running({ status: 'paused', pause: { at: at(20), kind: 'manual' }, checkResults: [check(10, 20)] })
    t.eq('a check settling into a pause counts only up to the stop', wallClockElapsedMs(pausedOn, now(50), { stoppedAt: now(20) }) / MIN, 10)
    const resumed = running({ checkResults: [check(10, 20)], controlSuspendedMs: 30 * MIN, resumeHistory: [{ at: at(50), suspendedMs: 30 * MIN }] })
    t.eq('inside a recorded stop it is the stop\'s', wallClockElapsedMs(resumed, now(60)) / MIN, 20)
    const retried = running({ checkResults: [check(10, 20)], inputRetrySuspendedMs: 30 * MIN, failures: [{ retryStop: { from: at(20), to: at(50) } }] })
    t.eq('so inside an input-limit retry\'s', wallClockElapsedMs(retried, now(60)) / MIN, 20)
    const refreshed = running({ checkResults: [check(0, 5)], checkRefreshSuspendedMs: 20 * MIN, checkRefresh: { stop: { from: at(10), to: at(30) } } })
    t.eq('a located refresh stop leaves a check outside it free', wallClockElapsedMs(refreshed, now(40)) / MIN, 15)
  }

  t.section('a stop only a total records leans towards counting')
  {
    const inside = check(10, 20)
    t.eq('a control total with a check inside it: not excused twice', [wallClockElapsedMs(running({ checkResults: [inside], controlSuspendedMs: 20 * MIN }), now(40)) / MIN, excluded(running({ checkResults: [inside], controlSuspendedMs: 20 * MIN }), 40)], [20, 0])
    t.eq('an older input-retry total, the same', [wallClockElapsedMs(running({ checkResults: [inside], inputRetrySuspendedMs: 20 * MIN, failures: [{ at: at(10) }] }), now(40)) / MIN, excluded(running({ checkResults: [inside], inputRetrySuspendedMs: 20 * MIN, failures: [{ at: at(10) }] }), 40)], [20, 0])
    t.eq('a refresh total, the same', wallClockElapsedMs(running({ checkResults: [inside], checkRefreshSuspendedMs: 20 * MIN }), now(40)) / MIN, 20)
    t.eq('the same stop located: the same answer, so nothing was lost to it', wallClockElapsedMs(running({ checkResults: [inside], controlSuspendedMs: 20 * MIN, resumeHistory: [{ at: at(30), suspendedMs: 20 * MIN }] }), now(40)) / MIN, 20)
    const outside = check(0, 5)
    t.eq('located, a check outside the stop stays free', wallClockElapsedMs(running({ checkResults: [outside], controlSuspendedMs: 20 * MIN, resumeHistory: [{ at: at(30), suspendedMs: 20 * MIN }] }), now(40)) / MIN, 15)
    t.eq('unplaced, it counts: never more budget than the record proves', wallClockElapsedMs(running({ checkResults: [outside], controlSuspendedMs: 20 * MIN }), now(40)) / MIN, 20)
    t.eq('part of a total placed: only the rest comes off', excluded(running({ checkResults: [check(30, 10)], controlSuspendedMs: 15 * MIN, resumeHistory: [{ at: at(20), suspendedMs: 10 * MIN }] }), 50), 5)
    t.eq('an answered wait places its share', excluded(running({ checkResults: [check(30, 10)], controlSuspendedMs: 10 * MIN, steps: [{ role: 'operator', startedAt: at(10), endedAt: at(20) }] }), 50), 10)
  }

  t.section('a turn that never answered is still seat time')
  {
    const interrupted = (to, reason = 'aborted') => [{ invocationId: 'i', startedAt: at(10), endedAt: at(to), reason }]
    t.eq('a check fully beside it excuses nothing', excluded(running({ checkResults: [check(10, 10)], interruptedTurns: interrupted(20) }), 40), 0)
    t.eq('five minutes past its end excuse exactly five', excluded(running({ checkResults: [check(10, 15)], interruptedTurns: interrupted(20) }), 40), 5)
    t.eq('a turn held after it stopped ran until it stopped', excluded(running({ checkResults: [check(10, 20)], participants: { a: { pendingInvocation: { startedAt: at(10), stoppedAt: at(15) } } } }), 40), 15)
    const adopted = { role: 'auditor-1', phase: 'implement-review', round: 0, startedAt: at(10), endedAt: null, durationMs: null }
    t.eq('an adopted turn counts to its adoption', excluded(running({ checkResults: [check(10, 30)], steps: [{ ...adopted, adoptedAt: at(30) }] }), 50), 10)
    t.eq('an older adopted step to the run\'s end', excluded(running({ checkResults: [check(10, 30)], steps: [adopted] }), 50), 0)
    t.eq('an abort no entry explains comes off', excluded(running({ checkResults: [check(10, 20)], timing: { abandonedMs: 5 * MIN } }), 40), 15)
    t.eq('floored at zero', excluded(running({ checkResults: [check(10, 20)], timing: { abandonedMs: 50 * MIN } }), 40), 0)
    t.eq('an explained abort takes nothing off', excluded(running({ checkResults: [check(30, 20)], timing: { abandonedMs: 10 * MIN }, interruptedTurns: [{ startedAt: at(10), endedAt: at(20), reason: 'quarantined', abandonedMs: 10 * MIN }] }), 60), 20)
  }

  t.section('an older record reads its interrupted turns off the journal')
  {
    const events = [
      { type: 'invoking', role: 'a', stepId: 's', invocationId: 'failed', at: at(10) },
      { type: 'checks-started', at: at(11) },
      { type: 'invocation-failed', role: 'a', invocationId: 'failed', at: at(20) },
      { type: 'invoking', role: 'b', invocationId: 'answered', at: at(21) },
      { type: 'invoking', role: 'c', invocationId: 'silent', at: at(22) },
      { type: 'invoking', role: 'c', invocationId: 'next', at: at(30) },
      { type: 'invoking', role: 'd', invocationId: 'held', at: at(31) },
      { type: 'invoking', role: 'e', invocationId: 'last', at: at(32) },
      { type: 'cancelled', role: 'f', invocationId: 'no-start', at: at(35) },
      { type: 'finished', at: at(40) }
    ]
    const run = running({ steps: [{ invocationId: 'answered' }, { invocationId: 'next' }], participants: { d: { pendingInvocation: { invocationId: 'held' } } }, failures: [{ invocationId: 'failed-alone', role: 'g', at: at(38) }] })
    const turns = Object.fromEntries(interruptedFromEvents(events, run).map((e) => [e.invocationId, e]))
    t.eq('an answered or held turn is not one', Object.keys(turns).sort(), ['failed', 'failed-alone', 'last', 'no-start', 'silent'])
    t.eq('a failed turn runs from invoking to its failure', [turns.failed.startedAt, turns.failed.endedAt, turns.failed.reason], [at(10), at(20), 'failed'])
    t.eq('so a check beside it excuses nothing', excluded(running({ checkResults: [check(10, 10)], interruptedTurns: [turns.failed] }), 40), 0)
    t.eq('one nothing ended stops when its seat starts again', turns.silent.endedAt, at(30))
    t.eq('or at the journal\'s end', turns.last.endedAt, at(40))
    t.eq('an ending with no invoking starts with the run', [turns['no-start'].startedAt, turns['no-start'].endedAt, turns['no-start'].reason], [at(0), at(35), 'aborted'])
    t.eq('so does a failure with no event', [turns['failed-alone'].startedAt, turns['failed-alone'].endedAt], [at(0), at(38)])
  }

  t.section('the mean round and the refusals name both numbers')
  {
    const review = { valid: true, contract: 'reviewResult' }
    const steps = [
      turn('coordinator', 0, 10, { number: '001', stepId: 'brief-implement' }), turn('auditor-1', 10, 30, { number: '002', stepId: 'audit-implement-1' }),
      turn('auditor-2', 20, 40, { number: '003', stepId: 'audit-implement-2' }),
      turn('planner', 50, 70, { number: '004', stepId: 'implement', round: 1 }), turn('auditor-1', 70, 90, { number: '005', stepId: 'audit-implement-1', round: 1 }),
      turn('planner', 100, 200, { number: '006', stepId: 'implement', round: 2 })
    ]
    t.eq('completed rounds only, concurrent turns once', meanRound({ steps }, { '002': review, '003': review, '005': review }), { meanRoundMs: 40 * MIN, rounds: 2 })
    t.eq('no completed round, no mean', meanRound({ steps }, {}), { meanRoundMs: null, rounds: 0 })
    t.eq('enough left: no refusal', wallClockRefusal({ limitMinutes: 240, remainingMs: 40 * MIN, meanRoundMs: 40 * MIN, rounds: 2 }), null)
    const short = wallClockRefusal({ limitMinutes: 240, remainingMs: 5 * MIN, meanRoundMs: 34 * MIN, rounds: 3 })
    t.eq('short', short.code, 'WALL_CLOCK_SHORT')
    t.ok('naming both', short.message.includes('5 min') && short.message.includes('34 min (3 rounds)'), short.message)
    const none = wallClockRefusal({ limitMinutes: 240, remainingMs: 5 * MIN, meanRoundMs: null, rounds: 0 })
    t.eq('no mean, nothing to compare', none, null)
    const spent = wallClockRefusal({ limitMinutes: 240, remainingMs: -3 * MIN, meanRoundMs: 34 * MIN, rounds: 3 })
    t.eq('exhausted', [spent.code, spent.detail.remainingMs], ['WALL_CLOCK_EXHAUSTED', 0])
    t.ok('naming both, and that the limit must rise', spent.message.includes('0 min remaining of 240') && spent.message.includes('34 min') && /exhausted budget/.test(spent.message), spent.message)
    t.ok('exhausted with no mean says so', /no mean round time/.test(wallClockRefusal({ limitMinutes: 240, remainingMs: 0, meanRoundMs: null, rounds: 0 }).message))
  }

  t.section('the dialogs start from the run\'s own limit, and never lower one')
  {
    const standing = (extra) => ({ limitMinutes: 240, elapsedMs: 100 * MIN, meanRoundMs: 30 * MIN, rounds: 3, startedUnderRule: 'waiting-excluded', ...extra })
    t.eq('room left: the limit', wallClockPrefill(standing(), { resume: true }), 240)
    t.eq('short: enough for a mean round', wallClockPrefill(standing({ elapsedMs: 230 * MIN }), { resume: true }), 260)
    t.eq('exhausted: the limit again', wallClockPrefill(standing({ elapsedMs: 250 * MIN }), { resume: true }), 490)
    t.eq('a run that started before keeps seven days on Resume', wallClockPrefill(standing({ startedUnderRule: null }), { resume: true }), 10080)
    t.eq('and a limit above that stands', wallClockPrefill(standing({ startedUnderRule: null, limitMinutes: 20000 }), { resume: true }), 20000)
    t.eq('Continue never had that default', wallClockPrefill(standing({ startedUnderRule: null })), 240)
    t.eq('a raise is read against the mean', [wallClockAt(standing({ elapsedMs: 230 * MIN })).short, wallClockAt(standing({ elapsedMs: 230 * MIN }), 300).short], [true, false])
    t.ok('and the text names both', wallClockAt(standing({ elapsedMs: 230 * MIN })).text.includes('10 min left of 240') && wallClockAt(standing()).text.includes('30 min (3 rounds)'))
  }

  t.section('through the engine: the deadline and the budget check read the rule')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    Object.assign(engine.run, { status: 'running', endedAt: null, pause: null, steps: [], checkResults: [], interruptedTurns: [], startedAt: new Date(f.clock.now() - 40 * MIN).toISOString() })
    engine.run.budgets.limits = { wallClockMinutes: 30 }
    t.eq('forty minutes against thirty is spent', engine.budgetExceeded(), 'wallClockMinutes')
    engine.checkRunningSince = f.clock.now() - 20 * MIN
    t.eq('not when twenty were waiting on a check still running', engine.budgetExceeded(), null)
    // A turn in flight, as the deadline always has: it starts now.
    const seat = Object.values(engine.run.participants)[0]
    seat.pendingInvocation = { invocationId: 'turn', startedAt: f.clock.iso() }
    const cancel = engine.armDeadline()
    f.clock.advance(9 * MIN)
    t.eq('and a turn armed now is not cut for them', engine.controller.signal.aborted, false)
    f.clock.advance(1 * MIN)
    // Twenty counted of thirty when it was armed: a turn ticks whatever else runs, so its ten are up.
    t.eq('its own ten minutes count', engine.controller.signal.aborted, true)
    cancel()
    seat.pendingInvocation = null
    engine.checkRunningSince = null
    engine.controller = new AbortController()
    engine.run.checkResults = [{ at: new Date(f.clock.now() - 40 * MIN).toISOString(), durationMs: 40 * MIN }]
    t.eq('once recorded it stays free', engine.budgetExceeded(), null)
    await releaseWorkspace(engine)
  }

  t.section('a wait for a drive slot is check waiting: free with no seat, counted beside one')
  {
    const waited = (extra = {}) => running({ driveSlotWaits: [{ host: 'h', from: at(10), to: at(30), dir: 'checks/001' }], ...extra })
    t.eq('alone, free, though the stopped drive left no result', excluded(waited(), 40), 20)
    t.eq('beside a seat turn, that part counts', excluded(waited({ steps: [turn('author', 10, 20)] }), 40), 10)
    t.eq('inside a check it is not excused twice', excluded(waited({ checkResults: [check(5, 30)] }), 40), 30)
    t.eq('a diagnostic drive is free the same way', excluded(running({ diagnosticDrives: [check(10, 5)] }), 40), 5)
    t.eq('a base reused from the cache was another run\'s time', excluded(running({ baselineChecks: [{ ...check(10, 5), reused: { key: 'k' } }] }), 40), 0)
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    Object.assign(engine.run, { status: 'running', endedAt: null, pause: null, steps: [], checkResults: [], interruptedTurns: [], startedAt: f.clock.iso() })
    engine.run.budgets.limits = { wallClockMinutes: 30 }
    engine.openDriveWaits.set('w', { from: f.clock.now() })
    const seat = Object.values(engine.run.participants)[0]
    seat.pendingInvocation = { invocationId: 'turn', startedAt: f.clock.iso() }
    const cancel = engine.armDeadline()
    f.clock.advance(30 * MIN + 1000)
    t.eq('a wait in progress does not move a working seat\'s deadline', [engine.controller.signal.aborted, engine.abortReason], [true, 'deadline'])
    cancel()
    seat.pendingInvocation = null
    t.eq('with the seat gone the open wait is free again, from when it began', engine.wallClockElapsed(), 0)
    engine.openDriveWaits.clear()
    engine.controller = new AbortController()
    await releaseWorkspace(engine)
  }

  t.section('every drive is read from when it began, and a nested one does not end the outer')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    const began = f.clock.now()
    const inner = []
    await engine.whileChecking(async () => {
      f.clock.advance(MIN)
      await engine.whileChecking(async () => { inner.push(engine.checkRunningSince) })
      inner.push(engine.checkRunningSince)
    })
    t.eq('the outer start stands throughout', inner, [began, began])
    t.eq('and clears at the end', engine.checkRunningSince, null)
    await engine.whileChecking(async () => { throw new Error('drive failed') }).catch(() => {})
    t.eq('also when the drive throws', engine.checkRunningSince, null)
    await releaseWorkspace(engine)
  }

  t.section('supervisor.liveCheckSince reads the engine driving that run, and only that run')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot })
    const P = 'devpanel-project'
    t.eq('no live run: null', supervisor.liveCheckSince(P, f.issue.id, engine.runId), null)
    supervisor.active.set(`${P}/${f.issue.id}`, { runId: engine.runId, engine })
    t.eq('between drives: null', supervisor.liveCheckSince(P, f.issue.id, engine.runId), null)
    const reads = []
    await engine.whileChecking(async () => {
      reads.push(supervisor.liveCheckSince(P, f.issue.id, engine.runId), supervisor.liveCheckSince(P, f.issue.id, 'another-run'), supervisor.liveCheckSince(P, 'another-issue', engine.runId))
    })
    t.eq('during one: its start, for that run alone', reads, [f.clock.now(), null, null])
    t.eq('after it: null', supervisor.liveCheckSince(P, f.issue.id, engine.runId), null)
    supervisor.active.set(`${P}/${f.issue.id}`, { runId: engine.runId })
    t.eq('a record with no engine yet: null', supervisor.liveCheckSince(P, f.issue.id, engine.runId), null)
    supervisor.active.clear()
    await releaseWorkspace(engine)
  }

  t.section('getRun carries the live check to the panel, and both callers pass it')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    const stored = await store.readRun(f.issuePath, engine.runId)
    Object.assign(stored, { status: 'running', endedAt: null, pause: null })
    stored.budgets.limits.wallClockMinutes = 240
    await store.writeRun(f.issuePath, engine.runId, stored)
    const read = async (liveCheckSince) => (await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id, ...(liveCheckSince === undefined ? {} : { liveCheckSince }) })).wallClock
    const idle = await read()
    t.eq('no check running: nothing held', idle.waitingOnCheckAlone, false)
    const since = Date.now() - 10 * MIN
    const alone = await read(since)
    t.eq('a check alone: the panel holds', alone.waitingOnCheckAlone, true)
    t.ok('and its time is excused', Math.abs(alone.excludedChecksMs - idle.excludedChecksMs - 10 * MIN) < MIN, JSON.stringify({ idle, alone }))
    t.ok('in the elapsed figure too', Math.abs(idle.elapsedMs - alone.elapsedMs - 10 * MIN) < MIN, JSON.stringify({ idle, alone }))
    Object.values(stored.participants)[0].pendingInvocation = { invocationId: 'turn', startedAt: new Date(Date.now() - 5 * MIN).toISOString() }
    await store.writeRun(f.issuePath, engine.runId, stored)
    const beside = await read(since)
    t.eq('with a seat working it ticks on', beside.waitingOnCheckAlone, false)
    t.ok('and the seat\'s five minutes count', Math.abs(beside.excludedChecksMs - idle.excludedChecksMs - 5 * MIN) < MIN, JSON.stringify({ idle, beside }))
    const source = (file) => fs.readFile(new URL(`../server/${file}`, import.meta.url), 'utf8')
    t.ok('the API route passes it', (await source('index.js')).includes('liveCheckSince: supervisor.liveCheckSince(req.params.project, req.params.id, req.params.runId)'))
    t.ok('and the top-level supervisor\'s read', (await source('top-supervisor-service.mjs')).includes('liveCheckSince:supervisor.liveCheckSince(project,issueId,runId)'))
    Object.values(stored.participants)[0].pendingInvocation = null
    await store.writeRun(f.issuePath, engine.runId, stored)
    await releaseWorkspace(engine)
  }

  t.section('the run page holds its figure while only a check runs')
  {
    const base = { status: 'running', startedAt: at(0), suspendedMs: 0 }
    const ticking = { ...base, wallClock: { elapsedMs: 20 * MIN, excludedChecksMs: 10 * MIN, waitingOnCheckAlone: false } }
    t.eq('ticks with the page clock, less what is excused', [wallClockUsedMinutes(ticking, now(30)), wallClockUsedMinutes(ticking, now(40))], [20, 30])
    const held = { ...base, wallClock: { elapsedMs: 20 * MIN, excludedChecksMs: 10 * MIN, waitingOnCheckAlone: true } }
    t.eq('held at the server\'s reading, however long the page stays open', [wallClockUsedMinutes(held, now(30)), wallClockUsedMinutes(held, now(90))], [20, 20])
    t.eq('a paused run reads to its pause', wallClockUsedMinutes({ ...base, status: 'paused', pause: { at: at(15) } }, now(90)), 15)
    t.eq('an ended run to its end, less its stops', wallClockUsedMinutes({ ...base, status: 'blocked', endedAt: at(25), suspendedMs: 5 * MIN }, now(90)), 20)
    t.eq('no start, nothing used', wallClockUsedMinutes({ status: 'pending' }, now(90)), 0)
    const view = await fs.readFile(new URL('../src/views/IssueView.vue', import.meta.url), 'utf8')
    t.ok('and the page reads it from here', view.includes('wallClockUsedMinutes(run.value, now.value)'))
  }

  t.section('aborted and failed turns leave an interval that survives a reload')
  {
    const base = scriptFor()
    let hung = false
    const f = await engineFixture({
      script: (args) => {
        if (args.stepId === 'implement' && !hung) { hung = true; return new Promise(() => { args.clock.advance(241 * MIN) }) }
        return base(args)
      }
    })
    const invoke = f.harnesses.fake.invoke
    f.harnesses.fake.invoke = (opts) => invoke({ ...opts, meta: { ...opts.meta, clock: f.clock } })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('the deadline stopped it', run.blockedReason, 'budget-exhausted')
    const [entry] = (await store.readRun(f.issuePath, engine.runId)).interruptedTurns
    t.eq('the record holds the turn', [entry?.reason, entry?.stepId, Date.parse(entry?.endedAt) - Date.parse(entry?.startedAt) >= 241 * MIN, entry?.abandonedMs >= 241 * MIN], ['aborted', 'implement', true, true])
    t.ok('nothing stays pending', Object.values(run.participants).every((p) => !p.pendingInvocation))
    await releaseWorkspace(engine)
  }
  {
    const base = scriptFor()
    const f = await engineFixture({ script: (args) => { if (args.stepId === 'implement') throw new Error('boom'); return base(args) } })
    const engine = await start(f)
    await engine.drive().catch(() => {})
    const saved = await store.readRun(f.issuePath, engine.runId)
    t.eq('a failed turn is on the record', saved.interruptedTurns.map((e) => [e.reason, e.stepId]), [['failed', 'implement']])
    t.ok('with both times', Boolean(saved.interruptedTurns[0].startedAt && saved.interruptedTurns[0].endedAt))
    await simulateProcessDeath(f.issuePath)
    let again = await reopen(f, engine.runId)
    t.eq('still there after a reload', again.run.interruptedTurns.length, 1)
    await again.runLock?.release()

    t.section('an older record is seeded once')
    delete saved.interruptedTurns
    await store.writeRun(f.issuePath, engine.runId, saved)
    again = await reopen(f, engine.runId)
    t.eq('from its journal when absent', again.run.interruptedTurns.map((e) => e.reason), ['failed'])
    await again.runLock?.release()
    saved.interruptedTurns = []
    await store.writeRun(f.issuePath, engine.runId, saved)
    again = await reopen(f, engine.runId)
    t.eq('a present list is not read again', again.run.interruptedTurns, [])
    await again.runLock?.release()
  }

  t.section('a turn silent after its last activity, then lost in a crash')
  {
    const f = await engineFixture({ loseMarker: true })
    let started
    const runId = await lostOwner(f, 'afterInvokeBeforePersist', (e) => e.run.steps.length === 2, (run) => {
      const pending = pendingOf(run)
      started = Date.parse(pending.startedAt)
      delete pending.answeredAt
      pending.activity = { ...pending.activity, lastAt: new Date(started + 2 * MIN).toISOString() }
      run.checkResults.push({ revision: 'other', result: 'passed', at: new Date(started).toISOString(), durationMs: 20 * MIN })
    })
    f.clock.advance(60 * MIN)
    const engine = await reopen(f, runId)
    const outcome = await engine.recoverOwnerLoss()
    t.ok('recovery retries it', outcome.resumed, outcome.reason)
    const lost = engine.run.interruptedTurns.find((e) => e.reason === 'lost')
    t.eq('it ends at its recovery, not its last activity', lost?.endedAt, f.clock.iso())
    t.eq('the check beside it excuses nothing', excludedChecksMs(engine.run, f.clock.now()), 0)
    engine.run.checkResults.push({ revision: 'other', result: 'passed', at: new Date(f.clock.now() + 10 * MIN).toISOString(), durationMs: 5 * MIN })
    t.eq('a check after recovery is excused as ever', excludedChecksMs(engine.run, f.clock.now() + 20 * MIN) / MIN, 5)
    engine.run.checkResults = engine.run.checkResults.filter((c) => c.revision !== 'other')
    await engine.runLock?.release()
  }

  t.section('a turn proved never to have started leaves no entry')
  {
    const f = await engineFixture()
    const runId = await lostOwner(f, 'beforeInvoke', (e) => e.run.steps.length === 2)
    const engine = await reopen(f, runId)
    await engine.recover({ retryUncertain: true })
    t.eq('nothing ran', engine.run.interruptedTurns, [])
    await engine.runLock?.release()
  }

  t.section('an adopted turn: no invented duration, and its overlap counted')
  {
    const f = await engineFixture()
    const runId = await lostOwner(f, 'afterInvokeBeforePersist', (e) => e.run.steps.length === 2, (run) => { delete pendingOf(run).answeredAt })
    f.clock.advance(10 * MIN)
    const engine = await reopen(f, runId)
    await engine.recover({ retryUncertain: true })
    const adopted = engine.run.steps.find((s) => s.durationUnknown)
    t.eq('the step keeps no end and no duration', [adopted?.endedAt, adopted?.durationMs], [null, null])
    t.eq('adoption is recorded beside them', adopted?.adoptedAt, f.clock.iso())
    await engine.runLock?.release()
  }

  t.section('a turn held by integrity ends when it stopped')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    engine.run.interruptedTurns = []
    engine.recordInterruptedTurn('r', { invocationId: 'a', startedAt: at(0), stoppedAt: at(5), abandonedMs: 5 * MIN }, 'quarantined')
    engine.recordInterruptedTurn('r', { invocationId: 'b', startedAt: at(0), answeredAt: at(6) }, 'quarantined')
    engine.recordInterruptedTurn('r', { invocationId: 'c', startedAt: at(0) }, 'quarantined')
    engine.recordInterruptedTurn('r', { invocationId: 'd', startedAt: at(0), derivedFrom: '001' }, 'quarantined')
    t.eq('stopped, answered, or at the disposition; a derived brief had no process', engine.run.interruptedTurns.map((e) => e.endedAt), [at(5), at(6), f.clock.iso()])
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
