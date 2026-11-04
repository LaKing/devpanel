import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, resumeRun, releaseOwnership } from '../server/runtime/launch.mjs'
import { inspectRunJournal, readSnapshot } from '../server/runtime/store.mjs'
import { supportedActions, workspaceDisposition } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, blocking, pausingStrategy } from './fakes/fixture.mjs'

const launch = (f, extra = {}) => startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, ...extra })
const reload = (f, runId) => resumeRun({ issuePath: f.issuePath, runId, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, configRoot: f.configRoot, clock: f.clock, deliveryProvider: f.delivery })
async function refuses (fn) { try { await fn(); return null } catch (error) { return error } }

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
}
