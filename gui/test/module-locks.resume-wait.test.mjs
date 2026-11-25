import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

import { poolDirectory, readPoolLocks, releaseModules, takeModules } from '../server/runtime/module-locks.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { engineFixture } from './fakes/fixture.mjs'

export const name = 'module locks — a blocked run\'s resume waits for its modules instead of being refused, its recorded decision reserves them against later starts, through a restart, until it takes them or is stopped'

const P = 'devpanel-project'
const POOL = 'framework-project'
const NL = String.fromCharCode(10)
// A resume of a budget-blocked run raises the budget, as an operator would.
const BUDGET = { maxSteps: 500 }
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')

export default async function (t) {
  const f = await engineFixture()
  const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
  const supervisors = []
  try {
    await fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true })
    await fs.writeFile(path.join(f.configRoot, 'projects', `${POOL}.yaml`), YAML.stringify({ id: POOL, workspace: { base: 'head' } }))
    await fs.writeFile(path.join(f.configRoot, 'projects', `${P}.yaml`), YAML.stringify({ id: P, framework: POOL }))
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, P)).catch(() => {})
    process.env.DEVPANEL_PROJECTS_DIR = projectsDir
    const control = path.join(f.issuesDir, 'control.json')
    await fs.writeFile(control, JSON.stringify({ ledger: path.join(f.issuesDir, 'ledger.jsonl'), delayMs: 300 }))
    process.env.DEVPANEL_FAKE_CONTROL = control
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(HARNESS_MODULE)}` + NL)
    const newSupervisor = () => { const s = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot }); supervisors.push(s); return s }
    let supervisor = newSupervisor()

    const sized = async (name, modules) => {
      const issue = await f.issues.createIssue(P, { name })
      const file = path.join(issue.path, 'issue.json')
      await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), sizing: { affectedModules: modules } }, null, 2) + NL)
      return issue
    }
    const recordOf = async (issue, runId) => JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
    const until = async (test, what) => { const end = Date.now() + 30000; while (!await test()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)) } }
    const reservationOf = (runId) => fs.readFile(path.join(poolDirectory(POOL), 'reservations', `${runId}.json`), 'utf8').then(JSON.parse, () => null)
    const start = (issue) => supervisor.start({ project: P, issueId: issue.id, playbookId: f.playbookId, configRoot: f.configRoot }).catch((e) => e)
    // Another live run holding a module (this process, alive): the waiter must wait behind it.
    const hold = (module) => takeModules({ pool: POOL, modules: [module], runId: 'run-other', project: 'instance-project', issueId: 'other-issue', issuePath: null, startedAt: '2026-01-01T00:00:00Z' })
    // A run of the issue that ended blocked (its step budget spent), with its module given back at its end.
    const blockedRun = async (issue) => {
      const started = await start(issue)
      await until(async () => (await recordOf(issue, started.runId).catch(() => null))?.status === 'running', 'the run to be running')
      await supervisor.stop({ project: P, issueId: issue.id, runId: started.runId, wait: true })
      await until(async () => !supervisor.isActive(P, issue.id), 'the run to settle')
      const file = path.join(issue.path, 'runs', started.runId, 'run.json')
      const record = JSON.parse(await fs.readFile(file, 'utf8'))
      Object.assign(record, { status: 'blocked', blockedReason: 'budget-exhausted', outcome: 'unresolved', endedAt: record.endedAt ?? new Date().toISOString() })
      await fs.writeFile(file, JSON.stringify(record, null, 2))
      return started.runId
    }

    t.section('a blocked run resumed while its module is held: the decision is recorded and the run waits, never refused')
    const waiterIssue = await sized('Resumed while its module is held', ['@c/z'])
    const laterIssue = await sized('Started later, sharing that module', ['@c/z'])
    const unrelatedIssue = await sized('Started later, an unrelated module', ['own-modules/u'])
    const w = await blockedRun(waiterIssue)
    const ended = await recordOf(waiterIssue, w)
    t.eq('the blocked run gave its module back at its end', [ended.status, ended.moduleLocks?.held, ended.moduleLocks?.released?.modules], ['blocked', [], ['@c/z']])
    const other = await hold('@c/z')
    const resumed = await supervisor.resume({ project: P, issueId: waiterIssue.id, runId: w, actor: 'operator', budgets: BUDGET }).catch((e) => e)
    t.eq('the resume is accepted, not refused MODULE_LOCKED', [resumed.code ?? null, resumed.runId], [null, w], `${resumed.status} ${resumed.message}`)
    await until(async () => (await recordOf(waiterIssue, w)).moduleLocks?.waiting, 'the resumed run to wait for its module')
    const waiting = await recordOf(waiterIssue, w)
    t.eq('the decision is on the record', waiting.resumeHistory?.length >= 1, true)
    t.eq('it is live and waits for the module, naming the holder, holding nothing', [waiting.status, waiting.moduleLocks.waiting.modules, waiting.moduleLocks.waiting.holders.map((h) => h.runId), waiting.moduleLocks.held, waiting.moduleLocks.owed], ['running', ['@c/z'], ['run-other'], [], ['@c/z']])
    const told = explainRun(waiting, { active: [] })
    t.eq('a person reads that it waits for modules and that the decision is in', [told.headline, /decision is recorded/.test(told.detail)], ['Waiting for modules another run is working on', true])
    const reservation = await reservationOf(w)
    t.eq('its modules are reserved', [reservation?.modules, reservation?.decision], [['@c/z'], 'resume'])

    t.section('meanwhile a start sharing the module is refused naming the waiter; an unrelated one is admitted')
    const refused = await start(laterIssue)
    t.eq('409, retryable, MODULE_LOCKED', [refused.status, refused.retryable, refused.code], [409, true, 'MODULE_LOCKED'], refused.message)
    t.eq('the waiter is named first: reserved, since when, behind which holder', [refused.holders?.[0]?.runId, refused.holders?.[0]?.reserved, refused.holders?.[0]?.since, refused.holders?.[0]?.behind], [w, true, reservation.since, ['run-other']])
    t.ok('and in words', refused.message?.includes(`reserved by run ${w}`) && refused.message.includes('run-other'), refused.message)
    t.eq('no run directory for the refused issue', await fs.readdir(path.join(laterIssue.path, 'runs')).catch(() => []), [])
    const unrelated = await start(unrelatedIssue)
    t.ok('the unrelated start goes ahead', Boolean(unrelated.runId), unrelated.message)
    const reading = await supervisor.moduleLockReading({ project: P, issueId: laterIssue.id })
    t.eq('readiness, preview and the project page read the waiter: who, since when, behind whom', [reading.reservations.map((r) => [r.runId, r.state, r.since]), reading.reservations[0]?.behind, reading.conflicts[0]?.runId], [[[w, 'waiting', reservation.since]], [{ module: '@c/z', runIds: ['run-other'] }], w])

    t.section('once the holder lets go the waiter takes its module and goes on; its reservation is gone')
    await releaseModules({ pool: POOL, held: other.held })
    await until(async () => (await recordOf(waiterIssue, w)).moduleLocks?.retaken?.length, 'the waiter to take its module')
    const taken = await recordOf(waiterIssue, w)
    t.eq('the set is retaken after a wait, nothing owed', [taken.moduleLocks.retaken.at(-1).modules, Boolean(taken.moduleLocks.retaken.at(-1).waitedFrom), taken.moduleLocks.owed], [['@c/z'], true, undefined])
    t.eq('the wait is excused from the wall clock like any module wait', taken.moduleLockWaits?.map((x) => x.modules), [['@c/z']])
    await until(async () => (await reservationOf(w)) === null, 'its reservation to go')
    t.ok('and the reservation is gone', true)
    await supervisor.settle()
    t.eq('after its end the pool is free of it', (await readPoolLocks(POOL)).filter((l) => l.runId === w), [])

    t.section('a waiter that is stopped frees the module: the next start names only the holder, and starts once it lets go')
    const stopIssue = await sized('Stopped while it waits', ['@c/s'])
    const stopLater = await sized('Started after the stop', ['@c/s'])
    const s = await blockedRun(stopIssue)
    const otherS = await hold('@c/s')
    await supervisor.resume({ project: P, issueId: stopIssue.id, runId: s, actor: 'operator', budgets: BUDGET })
    await until(async () => (await recordOf(stopIssue, s)).moduleLocks?.waiting, 'the run to wait')
    t.eq('while it waits the module is reserved', (await start(stopLater)).holders?.[0]?.runId, s)
    await supervisor.stop({ project: P, issueId: stopIssue.id, runId: s, wait: true })
    await until(async () => !supervisor.isActive(P, stopIssue.id), 'the stop to settle')
    t.eq('the stopped waiter is cancelled and its reservation gone', [(await recordOf(stopIssue, s)).status, await reservationOf(s)], ['cancelled', null])
    const afterStop = await start(stopLater)
    t.eq('the next start is refused by the holder alone', [afterStop.code, afterStop.holders?.map((h) => [h.runId, h.reserved ?? false])], ['MODULE_LOCKED', [['run-other', false]]], afterStop.message)
    await releaseModules({ pool: POOL, held: otherS.held })
    const nowFree = await start(stopLater)
    t.ok('and it starts once the holder lets go', Boolean(nowFree.runId), nowFree.message)
    await supervisor.settle()

    t.section('a paused run answered while its module is held reserves it; a refused answer reserves nothing')
    const pausedIssue = await sized('Paused, then resumed while its module is held', ['@c/p'])
    const pausedLater = await sized('Started while the answered run waits', ['@c/p'])
    const p = await start(pausedIssue)
    await until(async () => (await recordOf(pausedIssue, p.runId).catch(() => null))?.status === 'running', 'the run to be running')
    await supervisor.pause({ project: P, issueId: pausedIssue.id, runId: p.runId })
    await until(async () => !supervisor.isActive(P, pausedIssue.id), 'the pause to settle')
    const otherP = await hold('@c/p')
    const wrong = await supervisor.answer({ project: P, issueId: pausedIssue.id, runId: p.runId, text: 'x', pauseId: 'not-the-pause', actor: 'operator' }).catch((e) => e)
    t.ok('an answer to another pause is refused', Boolean(wrong.status >= 400), wrong.message)
    t.eq('and leaves no reservation', await reservationOf(p.runId), null)
    await supervisor.resume({ project: P, issueId: pausedIssue.id, runId: p.runId, actor: 'operator' })
    await until(async () => (await recordOf(pausedIssue, p.runId)).moduleLocks?.waiting, 'the answered run to wait')
    const sharing = await start(pausedLater)
    t.eq('a start sharing its module is refused naming the answered run', [sharing.code, sharing.holders?.[0]?.runId, sharing.holders?.[0]?.reserved], ['MODULE_LOCKED', p.runId, true], sharing.message)
    await releaseModules({ pool: POOL, held: otherP.held })
    await supervisor.settle()

    t.section('the decision and the reservation survive a restart of the service during the wait')
    const restartIssue = await sized('Waiting when the service restarts', ['@c/t'])
    const restartLater = await sized('Started after the restart', ['@c/t'])
    const r = await blockedRun(restartIssue)
    const otherR = await hold('@c/t')
    await supervisor.resume({ project: P, issueId: restartIssue.id, runId: r, actor: 'operator', budgets: BUDGET })
    await until(async () => (await recordOf(restartIssue, r)).moduleLocks?.waiting, 'the run to wait')
    const before = await reservationOf(r)
    await supervisor.shutdown()
    const down = await recordOf(restartIssue, r)
    t.eq('the shutdown cancels it as a service shutdown, its decision recorded', [down.status, down.stoppedBy, down.resumeHistory?.length >= 1], ['cancelled', 'service-shutdown', true])
    t.eq('and keeps its reservation', (await reservationOf(r))?.since, before.since)
    supervisor = newSupervisor()
    const meanwhile = await start(restartLater)
    t.eq('the next process refuses a sharing start naming the interrupted waiter', [meanwhile.code, meanwhile.holders?.[0]?.runId, meanwhile.holders?.[0]?.state], ['MODULE_LOCKED', r, 'interrupted'], meanwhile.message)
    const { resumed: carried } = await supervisor.resumeInterrupted()
    t.ok('the next start carries its decision on', carried.some((x) => x.runId === r), JSON.stringify(carried))
    await until(async () => (await recordOf(restartIssue, r)).moduleLocks?.waiting, 'the run to wait again')
    const again = await reservationOf(r)
    t.eq('it waits again, its reservation as old as before', [again?.since, again?.decision], [before.since, 'resume'])
    t.eq('still refusing a sharing start, now as a waiting run', (await start(restartLater)).holders?.[0]?.state, 'waiting')
    await releaseModules({ pool: POOL, held: otherR.held })
    await until(async () => (await recordOf(restartIssue, r)).moduleLocks?.retaken?.length, 'the run to take its module')
    await until(async () => (await reservationOf(r)) === null, 'its reservation to go')
    t.eq('and once free it takes the module and goes on, holding it', (await recordOf(restartIssue, r)).moduleLocks.retaken.at(-1).modules, ['@c/t'])
    await supervisor.settle()
  } finally {
    for (const s of supervisors) await s.settle().catch(() => {})
    for (const [key, env] of [['projects', 'DEVPANEL_PROJECTS_DIR'], ['control', 'DEVPANEL_FAKE_CONTROL']]) {
      if (saved[key] === undefined) delete process.env[env]
      else process.env[env] = saved[key]
    }
  }
}
