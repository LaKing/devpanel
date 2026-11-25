import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, resumeRun, releaseOwnership } from '../server/runtime/launch.mjs'
import { inspectRunJournal, readSnapshot } from '../server/runtime/store.mjs'
import { supportedActions, workspaceDisposition } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, blocking, pausingStrategy } from './fakes/fixture.mjs'

const launch = (f, extra = {}) => startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, ...extra })
const reload = (f, runId, extra = {}) => resumeRun({ issuePath: f.issuePath, runId, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, configRoot: f.configRoot, clock: f.clock, deliveryProvider: f.delivery, ...extra })
async function refuses (fn) { try { await fn(); return null } catch (error) { return error } }

// A plan-and-implement run whose implementation loop has one round, rejected: it ends rounds-exhausted.
async function exhaustedRun ({ launchSteps = null } = {}) {
  const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ implReviews: [[blocking('needs-fix')], []] }) })
  const file = path.join(f.configRoot, 'playbooks', 'plan-and-implement.yaml')
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('budgets:\n', 'overrides:\n  implement-review.maxRounds: 1\nbudgets:\n'))
  const engine = await launch(f)
  if (launchSteps) engine.run.budgets.limits.maxSteps = launchSteps
  await engine.drive()
  return { f, engine }
}
const agentCount = (run) => run.steps.filter((s) => s.role !== 'operator').length
const confirmed = (e) => e.outputs[e.run.steps.at(-1)?.number]?.contract === 'closureConfirmation'
const confirmStep = (e) => e.run.steps.filter((s) => e.outputs[s.number]?.contract === 'closureConfirmation').at(-1)
// What lost the granted round in the reported run is not known: the cap drops back once the confirmation is on the record.
const dropCap = (e) => { e.snapshot.phases.find((p) => p.id === 'implement-review').loop.maxRounds = 1 }
const events = async (f, runId) => (await inspectRunJournal(f.issuePath, runId)).events.map((e) => e.type)

// A run older code left blocked rounds-exhausted after its granted round was approved and confirmed:
// stopped right after the confirmation, recorded as that block, with no approval on the record.
async function legacyRun ({ overrides = true } = {}) {
  const { f, engine } = await exhaustedRun()
  await engine.resumeExecution()
  await releaseOwnership(engine)
  const resumed = await reload(f, engine.runId, { hooks: { afterPersistBeforeAdvance: async (e) => { if (confirmed(e)) e.cancel('requested') } } })
  await resumed.drive()
  Object.assign(resumed.run, { status: 'blocked', blockedReason: 'rounds-exhausted', outcome: 'unresolved', approvals: [], closure: null })
  if (!overrides) delete resumed.run.controlOverrides.rounds
  await resumed.persist({ type: 'finished', reason: 'rounds-exhausted', outcome: 'unresolved' })
  await releaseOwnership(resumed)
  return { f, runId: engine.runId, legacy: await reload(f, engine.runId) }
}

export default async t => {
  t.section('pause completes the current turn, then resumes from persisted state')
  {
    const f = await engineFixture()
    let once = false
    const engine = await launch(f, { hooks: { beforeInvoke: async e => { if (!once) { once = true; await e.requestPause() } } } })
    await engine.drive()
    t.eq('manual pause at the next boundary', engine.run.pause.kind, 'manual')
    t.eq('in-flight result recorded before pausing', engine.run.steps.length, 1)
    t.ok('no pending invocation remains', Object.values(engine.run.participants).every(p => !p.pendingInvocation))
    t.ok('resume is offered', supportedActions(engine.run).includes('resume'))
    t.eq('even unchanged workspaces are retained', workspaceDisposition(engine.run, { unchanged: true, proven: true }).discard, false)
    const step = structuredClone(engine.run.steps[0])
    const sessions = Object.fromEntries(Object.entries(engine.run.participants).map(([k,p]) => [k,p.session]))
    const usage = structuredClone(engine.run.budgets.used)
    const snapshot = await readSnapshot(f.issuePath, engine.runId)
    await releaseOwnership(engine)
    f.clock.advance(8 * 86400000)
    const resumed = await reload(f, engine.runId)
    await resumed.resumeExecution({ actor: 'ada', origin: 'panel' })
    t.eq('the history says who resumed it and from where', [resumed.run.resumeHistory.at(-1).actor, resumed.run.resumeHistory.at(-1).origin], ['ada', 'panel'])
    const resumedEvent = (await inspectRunJournal(f.issuePath, engine.runId)).events.filter((e) => e.type === 'operator-resumed').at(-1)
    t.eq('and so does the event', [resumedEvent?.actor, resumedEvent?.origin], ['ada', 'panel'])
    t.eq('usage is preserved', resumed.run.budgets.used, usage)
    t.eq('sessions are preserved', Object.fromEntries(Object.entries(resumed.run.participants).map(([k,p]) => [k,p.session])), sessions)
    t.eq('paused time does not exhaust the budget', resumed.budgetExceeded(), null)
    t.ok('double resume is refused', Boolean(await refuses(() => resumed.resumeExecution())))
    await resumed.drive()
    t.eq('run completes', resumed.run.status, 'completed')
    t.eq('completed first step is not repeated', resumed.run.steps[0], step)
    t.eq('immutable snapshot unchanged', await readSnapshot(f.issuePath, engine.runId), snapshot)
    await releaseOwnership(resumed)
  }
  t.section('budget-blocked runs keep usage and need enough explicit allowance')
  {
    const f = await engineFixture()
    const engine = await launch(f)
    engine.run.budgets.limits.maxSteps = 1
    await engine.drive()
    t.eq('budget stops after the first step', engine.run.blockedReason, 'budget-exhausted')
    t.ok('a stop time is recorded', Boolean(engine.run.endedAt))
    const session = engine.run.participants.coordinator.session
    t.eq('resume without allowance refuses', (await refuses(() => engine.resumeExecution()))?.status, 422)
    t.eq('invalid budget refuses', (await refuses(() => engine.resumeExecution({ budgets: { maxSteps: '20' } })))?.status, 400)
    f.clock.advance(14 * 86400000)
    await engine.resumeExecution({ budgets: { maxSteps: 100, wallClockMinutes: 10080 } })
    t.eq('spent step remains', engine.run.budgets.used.steps, 1)
    t.eq('same coordinator session', engine.run.participants.coordinator.session, session)
    await engine.drive()
    t.eq('same run completes', engine.run.status, 'completed')
    await releaseOwnership(engine)
  }
  t.section('resume does not skip operator questions or changed workspace checks')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which hostname?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    await engine.drive()
    t.ok('a decision pause offers answer, not resume', supportedActions(engine.run).includes('answer') && !supportedActions(engine.run).includes('resume'))
    t.eq('resume cannot bypass a question', (await refuses(() => engine.resumeExecution()))?.status, 409)
    const at = f.clock.now()
    f.clock.advance(8 * 86400000)
    await engine.answer({ text: 'example.test', actor: 'operator', pauseId: engine.run.pause.id })
    t.eq('decision wait excluded too', engine.run.controlSuspendedMs, f.clock.now() - at)
    await engine.requestPause()
    await engine.drive()
    await fs.appendFile(path.join(engine.run.workspace.path, 'source.txt'), 'outside edit')
    t.eq('changed workspace cannot resume', (await refuses(() => engine.resumeExecution()))?.status, 409)
    t.eq('still paused after refusal', engine.run.status, 'paused')
    await releaseOwnership(engine)
  }
  t.section('round and protocol exhaustion buy one additional attempt, with approvals still required')
  for (const kind of ['rounds', 'protocol']) {
    const script = kind === 'rounds' ? scriptFor({ implReviews: [[blocking('needs-fix')], [blocking('needs-fix')], []] }) : scriptFor({ malformed: new Set(['triage@1', 'triage@2', 'triage@3']) })
    const f = await engineFixture({ script })
    // Two rounds, as the old tight-change allowed: the auditor rejects both.
    const playbookFile = path.join(f.configRoot, 'playbooks', 'implementation.yaml')
    await fs.writeFile(playbookFile, (await fs.readFile(playbookFile, 'utf8')).replace('budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n'))
    const engine = await launch(f)
    engine.run.budgets.limits.maxSteps = 100
    await engine.drive()
    // The same finding twice is not convergence: the loop blocks without asking.
    t.eq(`${kind} is blocked`, engine.run.blockedReason, kind === 'rounds' ? 'rounds-exhausted' : 'protocol-repair-exhausted')
    const count = engine.run.steps.length
    await engine.resumeExecution()
    t.eq(`${kind}: with no name known it says operator, from the panel`, [engine.run.resumeHistory.at(-1).actor, engine.run.resumeHistory.at(-1).origin], ['operator', 'panel'])
    await releaseOwnership(engine)
    const resumed = await reload(f, engine.runId)
    await resumed.drive()
    t.eq(`${kind} completes after explicit continuation`, resumed.run.status, 'completed')
    t.ok(`${kind} preserves earlier attempts`, resumed.run.steps.length > count)
    await releaseOwnership(resumed)
  }

  t.section('historical budget stops restore an unanswered coordinator request')
  {
    const f = await engineFixture({ script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: { question: 'Allow fallback?', reason: 'A policy decision is needed.', category: 'requirement-conflict', recommendation: 'Allow it.' } } }) })
    const engine = await launch(f)
    await engine.drive()
    t.eq('coordinator request was recorded', engine.run.pause.kind, 'operator-request')
    engine.run.status = 'blocked'
    engine.run.blockedReason = 'budget-exhausted'
    engine.run.endedAt = null
    engine.run.pause = null
    await engine.persist({ type: 'budget-exhausted', budget: 'wallClockMinutes' })
    f.clock.advance(10 * 86400000)
    await engine.resumeExecution({ budgets: { wallClockMinutes: 10080 } })
    await engine.drive()
    t.eq('the unanswered question is restored', engine.run.pause?.question, 'Allow fallback?')
    t.eq('no fallback decision was invented', engine.run.steps.filter(s => s.role === 'operator').length, 0)
    await releaseOwnership(engine)
  }

  t.section('Resume refuses when the wall clock left is below the mean round, naming both')
  {
    const hour = 60 * 60_000
    const stopped = async () => {
      const f = await engineFixture()
      let once = false
      const engine = await launch(f, { hooks: { beforeInvoke: async e => { if (!once) { once = true; await e.requestPause() } } } })
      await engine.drive()
      return { f, engine }
    }
    // One completed round of an hour, on the paused run's record.
    const aRound = (engine) => {
      const step = engine.run.steps[0]
      Object.assign(step, { phase: 'implement-review', round: 0, startedAt: new Date(Date.parse(step.endedAt) - hour).toISOString() })
      engine.outputs[step.number] = { valid: true, contract: 'reviewResult', output: { findings: [] } }
    }
    // A plan step that stated a hold in a plan-review loop (owner-holds.mjs planReviewPhases), not asked yet.
    const planHold = (engine) => {
      engine.snapshot.phases.unshift({ id: 'plan-review', loop: { steps: [{ id: 'plan', role: 'planner', context: ['decisions'] }] } })
      engine.run.steps.push({ number: '900', role: 'planner', stepId: 'plan', phase: 'plan-review' })
      engine.outputs['900'] = { valid: true, contract: 'authorArtifact', output: { summary: 'a plan', ownerHolds: [{ id: 'H1', question: 'Q?', category: 'security', reason: 'r', recommendation: 'x' }] } }
    }
    {
      const { f, engine } = await stopped()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      const before = JSON.stringify([engine.run.status, engine.run.pause, engine.run.resumeHistory ?? [], engine.run.budgets.limits])
      const refused = await refuses(() => engine.resumeExecution({}))
      t.eq('refused, with the code and both numbers in detail', [refused?.status, refused?.code, refused?.detail?.remainingMs, refused?.detail?.meanRoundMs, refused?.detail?.rounds], [422, 'WALL_CLOCK_SHORT', 30 * 60_000, hour, 1])
      t.ok('and in the message', refused?.message.includes('30 min') && refused.message.includes('60 min'), refused?.message)
      t.eq('nothing changed on the run', JSON.stringify([engine.run.status, engine.run.pause, engine.run.resumeHistory ?? [], engine.run.budgets.limits]), before)
      const raised = await engine.resumeExecution({ budgets: { wallClockMinutes: 90 } })
      t.eq('a raise that holds a round passes', [raised.wallClock.overridden, raised.wallClock.rule, raised.wallClock.meanRoundMs], [false, 'waiting-excluded', hour])
      await releaseOwnership(engine)
      void f
    }
    {
      const { engine } = await stopped()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      const entry = await engine.resumeExecution({ acceptShortWallClock: true })
      t.eq('an explicit override passes and is recorded', [entry.wallClock.overridden, engine.run.resumeHistory.at(-1).wallClock.remainingMs], [true, 30 * 60_000])
      await releaseOwnership(engine)
    }
    {
      const { engine } = await stopped()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      const entry = await engine.resumeExecution({ guardShortWallClock: false })
      t.eq('owner-loss recovery skips the short check and says it did not override', entry.wallClock.overridden, false)
      await releaseOwnership(engine)
    }
    {
      // (l) A hold stated in plan review and not asked yet lets a Resume past an EXHAUSTED budget only to consult
      // it (continuationLimits consultOnly); a short clock still needs the operator's consent, and only that
      // consent reads as an override.
      const { engine } = await stopped()
      aRound(engine)
      planHold(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      const short = await refuses(() => engine.resumeExecution({}))
      t.eq('(l) a pending plan-review hold does not get a short clock past the refusal', short?.code, 'WALL_CLOCK_SHORT')
      const consented = await engine.resumeExecution({ acceptShortWallClock: true })
      t.eq('(l) with consent it passes as an override, not as consult-only', [consented.wallClock.overridden, consented.consultOnly ?? null], [true, null])
      await releaseOwnership(engine)
    }
    {
      const { engine } = await stopped()
      aRound(engine)
      planHold(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.startedAt = new Date(Date.parse(engine.run.pause.at) - 40 * 60_000).toISOString()
      const entry = await engine.resumeExecution({})
      t.eq('(l) an exhausted clock with the hold pending: let through only to consult, no override recorded', [entry.consultOnly, entry.wallClock.overridden], [true, false])
      await releaseOwnership(engine)
    }
    {
      const { engine } = await stopped()
      engine.run.budgets.limits.wallClockMinutes = 1
      const entry = await engine.resumeExecution({})
      t.eq('with no completed round there is no mean and no refusal', [entry.wallClock.meanRoundMs, entry.wallClock.rounds], [null, 0])
      await releaseOwnership(engine)
    }
    {
      const { engine } = await stopped()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.startedAt = new Date(Date.parse(engine.run.pause.at) - 40 * 60_000).toISOString()
      const spent = await refuses(() => engine.resumeExecution({ acceptShortWallClock: true }))
      t.eq('exhausted: the override does not get past it', [spent?.status, spent?.code, spent?.detail?.remainingMs, spent?.detail?.meanRoundMs], [422, 'WALL_CLOCK_EXHAUSTED', 0, hour])
      t.ok('and the message names both', spent?.message.includes('0 min remaining of 30') && spent.message.includes('60 min') && /exhausted budget/.test(spent.message), spent?.message)
      const short = await refuses(() => engine.resumeExecution({ budgets: { wallClockMinutes: 50 } }))
      t.eq('a raise that still leaves too little is the short refusal', short?.code, 'WALL_CLOCK_SHORT')
      const entry = await engine.resumeExecution({ budgets: { wallClockMinutes: 50 }, acceptShortWallClock: true })
      t.eq('which the override does pass', entry.wallClock.overridden, true)
      await releaseOwnership(engine)
    }
    {
      const { engine } = await stopped()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.budgets.limits.maxSteps = 1
      const other = await refuses(() => engine.resumeExecution({ acceptShortWallClock: true }))
      t.ok('another budget exhausted: its refusal names both numbers too', other?.status === 422 && /exhausted budget/.test(other.message) && other.message.includes('30 min') && other.message.includes('60 min'), other?.message)
      t.eq('with both in detail, and the override does not get past it', [other?.detail?.remainingMs, other?.detail?.meanRoundMs, engine.run.resumeHistory ?? []], [30 * 60_000, hour, []])
      engine.run.budgets.limits.wallClockMinutes = 600
      const room = await refuses(() => engine.resumeExecution({}))
      t.eq('with room on the clock it says only that budget', [room?.message, room?.detail], ['Increase the exhausted budget before resuming. Recorded usage is preserved.', undefined])
      await releaseOwnership(engine)
    }
    {
      const { engine } = await stopped()
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.startedAt = new Date(Date.parse(engine.run.pause.at) - 40 * 60_000).toISOString()
      const spent = await refuses(() => engine.resumeExecution({}))
      t.ok('exhausted with no completed round says so', spent?.code === 'WALL_CLOCK_EXHAUSTED' && /no mean round time/.test(spent.message), spent?.message)
      await releaseOwnership(engine)
    }
  }

  // The step counts of the reproduction, for the budget fixtures below.
  let M = null
  let N = null
  t.section('AC3: maxRounds 1, changes-needed, exhausted, resume, the granted round approved and confirmed: delivered')
  {
    const { f, engine } = await exhaustedRun()
    t.eq('round 1 ends the loop', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked rounds-exhausted')
    M = agentCount(engine.run)
    await engine.resumeExecution()
    await releaseOwnership(engine)
    const resumed = await reload(f, engine.runId)
    await resumed.drive()
    const latest = resumed.run.revisions.at(-1).fingerprint
    t.ok('the granted round approved the latest revision', resumed.run.approvals.some((a) => a.role === 'auditor-1' && a.revision === latest), JSON.stringify(resumed.run.approvals))
    t.eq('the confirmation is satisfied for it', [confirmStep(resumed) && resumed.outputs[confirmStep(resumed).number].output.satisfied, resumed.outputs[confirmStep(resumed).number].output.revision], [true, latest])
    t.eq('delivered', `${resumed.run.status} ${resumed.run.outcome} ${resumed.run.blockedReason}`, 'completed resolved null')
    t.ok('the delivery is on the record', Boolean(resumed.run.delivery) && f.delivery.calls.length === 1)
    N = agentCount(resumed.run)
    await releaseOwnership(resumed)
  }

  t.section('AC1: a loop that reads exhausted after its granted round was approved and confirmed goes on to delivery')
  {
    const { f, engine } = await exhaustedRun()
    await engine.resumeExecution()
    await releaseOwnership(engine)
    const resumed = await reload(f, engine.runId, { hooks: { afterPersistBeforeAdvance: async (e) => { if (confirmed(e)) dropCap(e) } } })
    await resumed.drive()
    t.eq('delivered, not rounds-exhausted', `${resumed.run.status} ${resumed.run.outcome} ${resumed.run.blockedReason}`, 'completed resolved null')
    t.ok('the conversion is on the record', (await events(f, engine.runId)).includes('confirmed-after-exhaustion'))
    await releaseOwnership(resumed)
  }

  t.section('AC1 at the step budget: a confirmation that is the last allowed step still delivers')
  {
    const { f, engine } = await exhaustedRun({ launchSteps: M + 1 })
    t.eq('the first stop is the rounds, not the budget', engine.run.blockedReason, 'rounds-exhausted')
    await engine.resumeExecution({ budgets: { maxSteps: N } })
    await releaseOwnership(engine)
    const resumed = await reload(f, engine.runId)
    await resumed.drive()
    t.eq('delivered, not budget-exhausted', `${resumed.run.status} ${resumed.run.outcome} ${resumed.run.blockedReason}`, 'completed resolved null')
    t.eq('no step past the budget', agentCount(resumed.run), N)
    await releaseOwnership(resumed)
  }

  t.section('a Stop while closure with the budget spent records its holds: cancelled, nothing delivered')
  {
    const { f, engine } = await exhaustedRun({ launchSteps: M + 1 })
    await engine.resumeExecution({ budgets: { maxSteps: N } })
    await releaseOwnership(engine)
    let armed = false
    const resumed = await reload(f, engine.runId, { hooks: { afterPersistBeforeAdvance: async (e) => { if (confirmed(e)) armed = true } } })
    const record = resumed.recordOwnerHolds.bind(resumed)
    // Armed only once the confirmation is recorded, so it fires at the budget-boundary closure.
    resumed.recordOwnerHolds = async () => { await record(); if (armed) { resumed.run.status = 'stopping'; resumed.cancel('requested') } }
    const run = await resumed.drive()
    t.eq('cancelled, with no closure and no delivery', [run.status, run.closure ?? null, f.delivery.calls.length], ['cancelled', null, 0])
    await releaseOwnership(resumed)
  }

  t.section('a contradictory confirmation is not taken for one: the loop stays exhausted and resume grants a round')
  {
    const { f, engine } = await exhaustedRun()
    await engine.resumeExecution()
    await releaseOwnership(engine)
    const resumed = await reload(f, engine.runId, { hooks: { afterPersistBeforeAdvance: async (e) => {
      if (!confirmed(e)) return
      e.outputs[e.run.steps.at(-1).number].output.criteria[0].unmet = 'missing-work'
      dropCap(e)
    } } })
    await resumed.drive()
    t.eq('blocked rounds-exhausted, nothing delivered', [resumed.run.status, resumed.run.blockedReason, resumed.confirmedLatest()], ['blocked', 'rounds-exhausted', false])
    const entry = await resumed.resumeExecution()
    t.eq('resume grants the loop a round', [entry.enteredClosure ?? false, entry.overrides.rounds['implement-review']], [false, 3])
    await releaseOwnership(resumed)
  }

  for (const overrides of [true, false]) {
    t.section(`AC2: a run older code left rounds-exhausted after an approved, confirmed round resumes into delivery (${overrides ? 'with' : 'without'} its granted round)`)
    const { f, runId, legacy } = await legacyRun({ overrides })
    t.ok('its last turn is outside the loop, and no approval is on the record', !legacy.snapshot.phases.find((p) => p.id === legacy.run.phase?.id)?.loop && legacy.run.approvals.length === 0, JSON.stringify(legacy.run.phase))
    const entry = await legacy.resumeExecution()
    t.eq('resume is accepted and grants no round', [entry.enteredClosure, entry.overrides.rounds?.['implement-review'] ?? null], [true, overrides ? 2 : null])
    await legacy.drive()
    t.eq('delivered', `${legacy.run.status} ${legacy.run.outcome} ${legacy.run.blockedReason}`, 'completed resolved null')
    t.ok('the approval the engine accepted counts again', legacy.run.approvals.some((a) => a.role === 'auditor-1' && a.revision === legacy.run.revisions.at(-1).fingerprint))
    void f; void runId
    await releaseOwnership(legacy)
  }

  t.section('a persisted approval nothing derives (carried to a merged candidate) stands until a reset or an accepted later review of its seat')
  {
    const { legacy } = await legacyRun()
    const e = legacy
    const current = e.run.revisions.at(-1).fingerprint
    const review = e.run.steps.filter((s) => s.role === 'auditor-1' && e.outputs[s.number]?.contract === 'reviewResult').at(-1)
    // As a reconcile leaves it: a merged revision, the approval carried to it on its original step.
    e.run.revisions.push({ ...e.run.revisions.at(-1), fingerprint: 'sha256:merged', reconciledFrom: current })
    e.run.approvals = [{ role: 'auditor-1', revision: 'sha256:merged', step: review.number, reconciledFrom: current }]
    const roles = () => e.effectiveApprovals().map((a) => `${a.role}@${a.revision}`)
    t.eq('it stands', roles(), ['auditor-1@sha256:merged'])
    const later = { number: '990', role: 'auditor-1', phase: review.phase, stepId: review.stepId, round: review.round, recheckDrive: 'checks/990', reconcileNotice: 1 }
    e.run.steps.push(later)
    e.outputs['990'] = structuredClone(e.outputs[review.number])
    t.eq('a reconcile notice of that seat replaces nothing', roles(), ['auditor-1@sha256:merged'])
    delete later.reconcileNotice
    t.eq('an accepted re-review of the same round (recheckDrive) replaces it', roles(), [])
    e.run.steps.pop()
    delete e.outputs['990']
    t.eq('without it, it stands again', roles(), ['auditor-1@sha256:merged'])
    e.run.windowResetAfter = review.number
    t.eq('an evidence-window reset past its step drops it', roles(), [])
    await releaseOwnership(legacy)
  }

  t.section('AC2: only approvals the engine accepted are recovered, and a superseded confirmation grants a round')
  {
    const { legacy } = await legacyRun()
    const current = legacy.run.revisions.at(-1).fingerprint
    legacy.run.approvals = [{ role: 'auditor-2', revision: current, step: confirmStep(legacy).number }, { role: 'auditor-3', revision: 'stale', step: confirmStep(legacy).number }]
    t.eq('the accepted review comes back; neither persisted entry stands', legacy.effectiveApprovals().map((a) => a.role), ['auditor-1'])
    legacy.run.supersededSteps = [...(legacy.run.supersededSteps ?? []), confirmStep(legacy).number]
    const entry = await legacy.resumeExecution()
    t.eq('with the confirmation superseded, the loop gets one more round (no 409)', [entry.enteredClosure ?? false, entry.overrides.rounds['implement-review']], [false, 3])
    await releaseOwnership(legacy)
  }
}
