import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import * as store from '../server/runtime/store.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

export const name = 'engine — continuing a run whose owner disappeared'

const start = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath,
  projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

class Crash extends Error {}

const reopen = (f, runId) => resumeRun({
  issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot,
  deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath
})

/** Crash where asked, then persist what a restarted server's reconcile() writes. */
async function lostOwner (f, hookName, when) {
  const engine = await start(f)
  engine.hooks[hookName] = async (e) => { if (when(e)) { delete e.hooks[hookName]; throw new Crash(hookName) } }
  try { await engine.drive() } catch (error) { if (!(error instanceof Crash)) throw error }
  await simulateProcessDeath(f.issuePath)
  const run = await store.readRun(f.issuePath, engine.runId)
  run.status = 'blocked'
  run.outcome = 'unresolved'
  run.blockedReason = 'recovery-required'
  run.recovery = { required: true, ownerLost: true, reason: 'the run was live when its owner disappeared — test', detectedAt: f.clock.iso(), lastActivityAt: f.clock.iso() }
  if (run.workspace?.state === 'active') run.workspace.state = 'retained'
  await store.writeRun(f.issuePath, engine.runId, run)
  return engine.runId
}

const startedFor = async (f, stepId) => (await f.fake.ledger.entries()).filter((e) => e.phase === 'started' && e.stepId === stepId).length

export default async function (t) {
  t.section('owner lost between turns: recover offers itself and the run completes')
  {
    const f = await engineFixture()
    const runId = await lostOwner(f, 'afterPersistBeforeAdvance', (e) => e.run.steps.length === 3)
    t.eq('the stranded run offers recover, not only abandon', supportedActions(await store.readRun(f.issuePath, runId)), ['recover', 'abandon'])
    const engine = await reopen(f, runId)
    const outcome = await engine.recoverOwnerLoss({ actor: 'supervisor', origin: 'supervisor' })
    t.ok('recovery resumed it', outcome.resumed, outcome.reason)
    t.eq('the loss is on the record', engine.run.ownerRecoveries?.length, 1)
    t.eq('the resume says who recovered it', [outcome.entry.actor, outcome.entry.origin], ['supervisor', 'supervisor'])
    const resumedEvent = (await store.inspectRunJournal(f.issuePath, runId)).events.filter((e) => e.type === 'operator-resumed').at(-1)
    t.eq('on the event too', [resumedEvent?.actor, resumedEvent?.origin], ['supervisor', 'supervisor'])
    const run = await engine.drive()
    t.eq('and it completes', run.outcome, 'resolved')
    const ids = run.steps.map((s) => s.stepId)
    t.eq('with no step repeated', new Set(ids.map((id, i) => `${id}#${ids.slice(0, i).filter((x) => x === id).length}`)).size, ids.length)
    await releaseWorkspace(engine)
  }

  t.section('owner lost mid-turn with an unattributable invocation and an untouched workspace: retried fresh')
  {
    const f = await engineFixture({ loseMarker: true })
    const runId = await lostOwner(f, 'afterInvokeBeforePersist', (e) => e.run.steps.length === 2)
    const engine = await reopen(f, runId)
    const outcome = await engine.recoverOwnerLoss()
    t.ok('recovery resumed it', outcome.resumed, outcome.reason)
    const run = await engine.drive()
    t.eq('the uncertain turn ran again rather than being adopted', await startedFor(f, 'implement'), 2)
    t.eq('it is recorded once', run.steps.filter((s) => s.stepId === 'implement').length, 1)
    t.eq('and the run completes', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('owner lost while waiting for another run\'s modules: the wait is excused, and a refused recovery leaves Resume')
  {
    const f = await engineFixture()
    const runId = await lostOwner(f, 'afterPersistBeforeAdvance', (e) => e.run.steps.length === 3)
    const run = await store.readRun(f.issuePath, runId)
    const lostAt = run.recovery.lastActivityAt
    const since = new Date(Date.parse(lostAt) - 3 * 3600_000).toISOString()
    // Started five hours before the loss, three of them spent waiting, under a two-hour limit.
    run.startedAt = new Date(Date.parse(lostAt) - 5 * 3600_000).toISOString()
    run.budgets.limits.wallClockMinutes = 120
    run.moduleLocks = { pool: 'devpanel-project', project: 'devpanel-project', issueId: f.issue.id, held: [], waiting: { modules: ['m'], holders: [], since } }
    await store.writeRun(f.issuePath, runId, run)
    const engine = await reopen(f, runId)
    const refused = await engine.recoverOwnerLoss().catch((e) => e)
    t.eq('five hours under a two-hour limit refuses, the excused wait notwithstanding', refused?.code, 'WALL_CLOCK_EXHAUSTED')
    t.eq('the wait the lost owner never ended is on the record', engine.run.moduleLockWaits?.map((w) => [w.from, w.to, w.ownerLost]), [[since, lostAt, true]])
    t.eq('the refused run stands owner-lost', [engine.run.status, engine.run.blockedReason], ['blocked', 'owner-lost'])
    const again = await engine.recoverOwnerLoss().catch((e) => e)
    t.ok('recover no longer applies', again instanceof Error)
    t.eq('and the wait is recorded once', engine.run.moduleLockWaits.length, 1)
    // Two hours counted (five less the three waiting): a limit of 180 leaves an hour.
    const entry = await engine.resumeExecution({ budgets: { wallClockMinutes: 180 }, actor: 'alice', origin: 'test' })
    t.eq('Resume with a raised limit continues it from the time the owner was lost', entry.limits.wallClockMinutes, 180)
    const done = await engine.drive()
    t.eq('and it completes', done.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('a run that is merely blocked is not offered recovery')
  {
    t.eq('recovery-required without owner loss offers only abandon', supportedActions({ status: 'blocked', blockedReason: 'recovery-required', recovery: { required: true, reason: 'writer: invocation x is uncertain' }, integrity: { status: 'clear' }, workspace: { path: '/x', state: 'retained' }, participants: {} }), ['abandon'])
    t.eq('nor is a quarantined one', supportedActions({ status: 'blocked', blockedReason: 'recovery-required', recovery: { required: true, ownerLost: true, reason: 'x' }, integrity: { status: 'quarantined' }, workspace: { path: '/x', state: 'retained' }, participants: {} }).includes('recover'), false)
  }

  await cleanupFixtures()
}
