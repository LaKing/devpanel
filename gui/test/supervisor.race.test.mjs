import fs from 'node:fs/promises'
import path from 'node:path'
import { acquire, currentOwner } from '../server/runtime/lock.mjs'
import { hostPlatform } from '../server/runtime/platform.mjs'
import * as store from '../server/runtime/store.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * AC2: markUnowned writes recovery state only while it holds the issue's run
 * lock, and writes nothing when another owner holds it. The new owner appears
 * at the one-shot seam both versions reach between the supervisor's look at the
 * lock and its write: the liveness probe of the dead owner's pid. No sleeps.
 */
const P = 'devpanel-project'
const DEAD_PID = 999999

export default async function (t) {
  if (process.platform !== 'linux') { t.skip('supervisor race', 'the injected platform is linux-shaped'); return }
  const f = await engineFixture()
  const host = hostPlatform()
  let hook = null
  const platform = {
    ...host,
    processStart: async (pid) => {
      if (pid === DEAD_PID) {
        if (hook) { const h = hook; hook = null; await h() }
        return { state: 'absent' }
      }
      return host.processStart(pid)
    }
  }
  const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform })

  /** A run persisted as live whose owner (DEAD_PID) is gone, its lock still on disk. */
  async function orphan (name) {
    const issue = await f.issues.createIssue(P, { name })
    const runId = `2026-01-01T00-00-00-000Z-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`
    await fs.mkdir(path.join(issue.path, 'runs', runId), { recursive: true })
    await store.writeRun(issue.path, runId, {
      runId, issue: { project: P, id: issue.id }, playbook: { id: 'implementation', strategy: 'implementation' },
      status: 'running', startedAt: new Date().toISOString(), phase: { id: 'implement-review', round: 0 },
      participants: {}, steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} }
    })
    const lock = path.join(issue.path, '.run.lock')
    await fs.writeFile(lock, JSON.stringify({ purpose: 'run', token: 'dead', owner: { ...(await currentOwner(runId, { platform })), pid: DEAD_PID, processStartedAt: '1' } }))
    return { issue, runId, lock }
  }

  /** B: takes the dead lock over for the same run and writes the record as its new owner would. */
  const newOwner = (o, state) => async () => {
    state.lock = await acquire(o.lock, { purpose: 'run', runId: o.runId, platform })
    const run = await store.readRun(o.issue.path, o.runId)
    delete run.journal
    await store.writeRun(o.issue.path, o.runId, { ...run, status: 'running', marker: 'B' })
    state.lockText = await fs.readFile(o.lock, 'utf8')
  }

  const settle = async (o, state) => {
    const run = await store.readRun(o.issue.path, o.runId)
    const lockText = await fs.readFile(o.lock, 'utf8').catch(() => null)
    return { run, lockText, same: lockText === state.lockText }
  }

  t.section('R2. stop: an owner that appears after the look keeps its record and its lock')
  {
    const o = await orphan('Stopped across a new owner')
    const state = {}
    hook = newOwner(o, state)
    const stopped = await supervisor.stop({ project: P, issueId: o.issue.id, runId: o.runId }).catch((error) => error)
    t.ok('the new owner took the lock at the seam', Boolean(state.lock?.token))
    const after = await settle(o, state)
    t.eq('the record is the new owner\'s', [after.run.status, after.run.marker ?? null, after.run.blockedReason ?? null], ['running', 'B', null])
    t.ok('the new owner\'s lock is untouched', after.same)
    t.eq('the stop is refused', stopped?.status ?? null, 409)
    await state.lock?.release()
    await fs.rm(path.join(o.issue.path, 'runs'), { recursive: true, force: true })
  }

  t.section('R2. reconcile: an owner that appears after the look keeps its record and its lock')
  {
    const o = await orphan('Reconciled across a new owner')
    const state = {}
    hook = newOwner(o, state)
    const warn = console.warn
    const warnings = []
    console.warn = (...args) => { warnings.push(args.join(' ')) }
    let recovered
    try { recovered = await supervisor.reconcile() } finally { console.warn = warn }
    t.ok('the new owner took the lock at the seam', Boolean(state.lock?.token))
    const after = await settle(o, state)
    t.eq('the record is the new owner\'s', [after.run.status, after.run.marker ?? null, after.run.blockedReason ?? null], ['running', 'B', null])
    t.ok('the new owner\'s lock is untouched', after.same)
    t.ok('the run is not reported recovered', !recovered.some((r) => r.runId === o.runId))
    await state.lock?.release()
    await fs.rm(path.join(o.issue.path, 'runs'), { recursive: true, force: true })
  }

  t.section('R2b. regression guard: a dead owner with no successor is marked recovery-required and its lock goes')
  {
    const o = await orphan('Dead owner, nobody else')
    const stopped = await supervisor.stop({ project: P, issueId: o.issue.id, runId: o.runId }).catch((error) => error)
    const run = await store.readRun(o.issue.path, o.runId)
    t.eq('recovery-required', [run.status, run.blockedReason], ['blocked', 'recovery-required'])
    t.eq('the stop says so', stopped?.recoveryRequired ?? null, true)
    t.ok('no lock is left', !await fs.stat(o.lock).then(() => true, () => false))
  }

  await cleanupFixtures()
}
