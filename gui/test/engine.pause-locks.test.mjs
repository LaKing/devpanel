import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readPoolLocks, releaseModules, releaseRunLocks, takeModules, yieldForPause } from '../server/runtime/module-locks.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

export const name = 'engine — a paused run holds no module locks; its answer is recorded at once and the run waits for the modules itself'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)
const POOL = 'pause-locks-pool'
const hold = { id: 'H1', question: 'Remove loopback from every seat\'s shell?', category: 'security', reason: 'It takes away what the documentation promises each seat.', recommendation: 'Keep loopback.' }
const plan = () => `A plan.${NL}${fence({ summary: 'the plan', basedOnRevision: null, resolves: [], ownerHolds: [hold] })}`
const ran = (run, stepId) => run.steps.filter((s) => s.stepId === stepId).length
const until = async (test) => { const end = Date.now() + 5000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

export default async function (t) {
  const fallback = scriptFor({})
  const f = await engineFixture({ playbook: 'plan-and-implement', script: (turn) => (turn.stepId === 'plan' ? plan() : fallback(turn)) })
  const engine = await startRun({
    playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses,
    stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
  })
  const common = { pool: POOL, project: 'devpanel-project', issueId: f.issue.id, issuePath: f.issuePath }
  // As the supervisor's start leaves it: the issue's triage modules, held by this run.
  const mine = await takeModules({ ...common, modules: ['@c/x', '@c/y'], runId: engine.runId, startedAt: engine.run.startedAt })
  engine.run.moduleLocks = { pool: POOL, project: 'devpanel-project', issueId: f.issue.id, held: mine.held, waiting: null, takenAtStart: ['@c/x', '@c/y'] }
  engine.moduleLockPollMs = 20

  t.section('the pause gives the locks up and records them as owed')
  const paused = await engine.drive()
  t.eq('the run waits for its owner', [paused.status, paused.pause?.kind], ['paused', 'owner-hold'])
  t.eq('while it still holds its modules', (await readPoolLocks(POOL)).map((l) => [l.module, l.state]), [['@c/x', 'held'], ['@c/y', 'held']])
  t.eq('the pause gives them up (the supervisor calls this when it settles a paused run)', await yieldForPause(engine.run), true)
  t.eq('the pool is free', await readPoolLocks(POOL), [])
  t.eq('and the run owes its set', [engine.run.moduleLocks.held, engine.run.moduleLocks.owed, engine.run.moduleLocks.released?.reason], [[], ['@c/x', '@c/y'], 'paused'])
  const releasedAt = engine.run.moduleLocks.released.at
  t.eq('a second call changes nothing', [await yieldForPause(engine.run), engine.run.moduleLocks.released.at], [false, releasedAt])

  t.section('another run takes one of the modules meanwhile, as a start would')
  const other = await takeModules({ pool: POOL, modules: ['@c/x'], runId: 'run-other', project: 'instance-project', issueId: 'other-issue', issuePath: null, startedAt: '2026-01-01T00:00:00Z' })
  t.eq('it is not refused', [other.conflicts, other.held.map((h) => h.module)], [[], ['@c/x']])

  t.section('the answer is recorded at once, whoever holds the modules')
  await engine.answer({ pauseId: paused.pause.id, text: 'Keep loopback for now.', actor: 'owner' })
  t.eq('the decision is a step of the run', engine.run.steps.filter((s) => s.role === 'operator').length, 1)

  t.section('the run then waits for the modules itself, before any turn')
  const driving = engine.drive()
  await until(() => engine.run.moduleLocks.waiting)
  t.eq('it waits for its whole set, naming the holder', [engine.run.moduleLocks.waiting.modules, engine.run.moduleLocks.waiting.holders.map((h) => h.runId)], [['@c/x', '@c/y'], ['run-other']])
  t.eq('holding nothing while it waits', [engine.run.moduleLocks.held, (await readPoolLocks(POOL)).map((l) => [l.module, l.runId])], [[], [['@c/x', 'run-other']]])
  t.eq('no implementation turn ran without the modules', ran(engine.run, 'implement') + ran(engine.run, 'brief-implement'), 0)
  const told = explainRun(engine.run, { active: [] })
  t.ok('a person reads that the answer is in and what the run waits for', told.tone === 'waiting' && /answer is recorded/.test(told.detail) && told.detail.includes('@c/x') && told.detail.includes('run-other'), JSON.stringify(told))

  t.section('once the module is free the run takes its set and goes on to the end')
  await releaseModules({ pool: POOL, held: other.held })
  const done = await driving
  t.eq('the run closed', `${done.status}/${done.outcome}`, 'completed/resolved')
  t.eq('implementation ran after the wait', ran(done, 'implement'), 1)
  t.eq('on the one answer given before it', [done.steps.filter((s) => s.role === 'operator').length, Boolean(done.ownerHolds?.['planner:H1']?.answeredByStep)], [1, true])
  t.eq('holding its set again, nothing owed', [done.moduleLocks.held.map((h) => h.module).sort(), done.moduleLocks.owed, done.moduleLocks.released], [['@c/x', '@c/y'], undefined, undefined])
  t.eq('the retake is on the record with its wait', [done.moduleLocks.retaken?.map((r) => r.modules), Boolean(done.moduleLocks.retaken?.[0]?.waitedFrom)], [[['@c/x', '@c/y']], true])
  t.eq('and the wait is excused from the wall clock like any module wait', done.moduleLockWaits?.map((w) => w.modules), [['@c/x', '@c/y']])
  await releaseRunLocks(done)
  t.eq('the end gives everything back', await readPoolLocks(POOL), [])
  await releaseWorkspace(engine)
}
