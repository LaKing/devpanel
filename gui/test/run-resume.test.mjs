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

}
