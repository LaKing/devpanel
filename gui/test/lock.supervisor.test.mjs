import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { currentOwner } from '../server/runtime/lock.mjs'
import { platformFor } from '../server/runtime/platform.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { getRun } from '../server/runs-api.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * The supervisor's own reading of a run lock (P2-3): an owner whose liveness
 * cannot be established is held, never released at startup, never stopped from
 * here, and shown to the operator as such with the way out (removing the lock
 * by hand). On Linux an owner reads 'unknown' only without a pid or from
 * another host on the same boot; darwin is injected with a failing ps.
 */
const P = 'devpanel-project'

export default async function (t) {
  const f = await engineFixture()
  // Every pid answers kill(0) (a live process); ps fails for all of them.
  const darwinFailing = platformFor('darwin', { kill: () => {}, exec: async (command) => command.endsWith('sysctl')
    ? { ok: true, code: 0, stdout: '0f2c1a3b-9d4e-4f5a-8b6c-7d8e9f0a1b2c\n' }
    : { ok: false, code: 1, stdout: '', error: 'ps failed' } })
  // Another process's lock (not this server's own pid, which it would read as its own).
  const foreign = 424242
  const cases = [
    ['linux: an owner on another host of the same boot', platformFor('linux'), async (runId) => ({ ...(await currentOwner(runId, { platform: platformFor('linux') })), pid: foreign, host: 'somewhere-else' })],
    ['darwin injected: ps fails for a live owner', darwinFailing, async (runId) => ({ ...(await currentOwner(runId, { platform: darwinFailing })), pid: foreign, processStartedAt: 'lstart:1' })]
  ]
  for (const [label, platform, ownerFor] of cases) {
    t.section(label)
    if (label.startsWith('linux') && process.platform !== 'linux') { t.skip(label, 'not linux'); continue }
    const issue = await f.issues.createIssue(P, { name: label })
    const runId = `2026-01-01T00-00-00-000Z-${Math.random().toString(16).slice(2, 10)}`
    await fs.mkdir(path.join(issue.path, 'runs', runId), { recursive: true })
    await fs.writeFile(path.join(issue.path, 'runs', runId, 'run.json'), JSON.stringify({
      runId, issue: { project: P, id: issue.id }, playbook: { id: 'implementation', strategy: 'implementation' },
      status: 'running', startedAt: new Date().toISOString(), phase: { id: 'implement-review', round: 0 },
      participants: { implementer: { role: 'implementer', model: 'opus-5-5', harness: 'fake', state: 'ready' } },
      steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} }
    }))
    const lock = path.join(issue.path, '.run.lock')
    await fs.writeFile(lock, JSON.stringify({ purpose: 'run', token: 'held', owner: await ownerFor(runId) }))
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform })

    await supervisor.reconcile()
    t.eq('startup leaves the lock where it is', JSON.parse(await fs.readFile(lock, 'utf8')).token, 'held')
    const run = JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
    t.eq('and the run is not marked recovery-required', [run.status, run.blockedReason ?? null], ['running', null])
    const listed = (await supervisor.liveAgents()).find((r) => r.runId === runId)
    t.eq('live agents say the owner cannot be established', listed?.ownership, 'owner-unknown')
    const stopped = await supervisor.stop({ project: P, issueId: issue.id, runId }).catch((e) => e)
    t.eq('stop is refused', stopped?.status, 409)
    const detail = await getRun(issue.path, runId, { issues: f.issues, project: P, issueId: issue.id, isActive: false, platform })
    t.ok('the explanation says so', /owner cannot be established/i.test(detail.explanation?.headline ?? ''), detail.explanation?.headline)
    t.ok('and names the lock an operator may remove', (detail.explanation?.next ?? '').includes('.run.lock'), detail.explanation?.next)
    await fs.rm(lock)
  }

  /*
   * An unfinished publication whose issue another owner holds (AC6): the sweeps
   * settle nothing, read no journal and write nothing under its run, announce
   * nothing, and do not throw. Runs without a pending publication are read as
   * before. The second reconcile() below stands for the next panel start: in
   * production reconcile() runs once, at startup, and a live-agents poll does
   * not resume startup work such as coverage notes.
   */
  t.section('an unfinished publication under a foreign lock: the sweeps write nothing and announce nothing')
  if (process.platform !== 'linux') t.skip('foreign lock', 'not linux')
  else {
    const platform = platformFor('linux')
    const issue = await f.issues.createIssue(P, { name: 'publication under a foreign lock' })
    const clean = JSON.stringify({ type: 'delivered', at: 't' }) + '\n'
    const pending = { approvedBy: 'operator', revision: 'sha256:x', repository: path.join(issue.path, 'no-such-repository'), targetBranch: 'main', targetHeadBefore: 'a'.repeat(40), mergeCommit: 'b'.repeat(40), method: 'x', at: 't', error: null, phase: 'publishing', worktrees: { pending: [], updated: [], stale: [] } }
    const release = { tactic: 'staging', status: 'completed', coverage: { covered: [{ issueId: 'covered-issue', runId: 'r1' }], indeterminate: [] } }
    const runs = {
      A: { integration: pending, journal: clean + '{"type":' },
      B: { integration: pending, journal: clean },
      C: { journal: clean + '{"type":' },
      D: { integration: pending, release, journal: clean }
    }
    const ids = {}
    for (const [name, spec] of Object.entries(runs)) {
      const runId = ids[name] = `2026-01-02T00-00-00-000Z-${name.toLowerCase()}${Math.random().toString(16).slice(2, 9)}`
      const dir = path.join(issue.path, 'runs', runId)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({
        runId, issue: { project: P, id: issue.id }, playbook: { id: 'deployment', strategy: 'staging' }, status: 'completed', outcome: 'resolved',
        participants: {}, steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} },
        ...(spec.integration ? { integration: spec.integration } : {}), ...(spec.release ? { release: spec.release } : {})
      }))
      await fs.writeFile(path.join(dir, 'events.jsonl'), spec.journal)
    }
    const runDir = (name) => path.join(issue.path, 'runs', ids[name])
    const exists = (file) => fs.access(file).then(() => true, () => false)
    const snapshot = async (name) => {
      const out = {}
      for (const entry of await fs.readdir(runDir(name))) out[entry] = crypto.createHash('sha256').update(await fs.readFile(path.join(runDir(name), entry))).digest('hex')
      return out
    }
    const lock = path.join(issue.path, '.run.lock')
    await fs.writeFile(lock, JSON.stringify({ purpose: 'run', token: 'foreign', owner: { ...(await currentOwner('elsewhere-run', { platform })), pid: foreign, host: 'somewhere-else' } }))
    const events = []
    const noted = []
    const issues = { ...f.issues, createEngineNote: async (project, issueId, note) => { noted.push({ issueId, ...note }); return { where: 'step' } } }
    const supervisor = createSupervisor({ issues, emit: (event) => events.push(event), harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform })
    const reconciled = (name) => events.filter((e) => e.type === 'integration-reconciled' && e.runId === ids[name]).length

    const before = { A: await snapshot('A'), B: await snapshot('B'), D: await snapshot('D') }
    const startup = await supervisor.reconcile().then(() => null, (error) => error)
    t.eq('startup does not throw', startup?.message ?? null, null)
    for (let poll = 0; poll < 3; poll++) await supervisor.liveAgents()
    for (const name of ['A', 'B', 'D']) t.eq(`run ${name} is byte-identical under the held lock`, await snapshot(name), before[name])
    t.eq('the torn journal was not inspected: no recovery finding', await exists(path.join(runDir('A'), 'journal-recovery.json')), false)
    t.eq('no coverage receipt was written', await exists(path.join(runDir('D'), 'staging-coverage-notes.json')), false)
    t.eq('and no note', noted, [])
    t.ok('a run with nothing pending is read as before: its finding is recorded', await exists(path.join(runDir('C'), 'journal-recovery.json')))
    t.eq('nothing is announced, so no dashboard polls itself', events.filter((e) => e.type === 'integration-reconciled'), [])
    t.eq('the foreign lock is untouched', JSON.parse(await fs.readFile(lock, 'utf8')).token, 'foreign')

    await fs.rm(lock)
    // Simulates the next panel start, not a production poll.
    await supervisor.reconcile()
    t.eq('at the next start B settles under the lock, announced once', [reconciled('B'), JSON.parse(await fs.readFile(path.join(runDir('B'), 'run.json'), 'utf8')).integration.phase], [1, 'aborted'])
    t.eq('D settles too, announced once', reconciled('D'), 1)
    t.ok('and its coverage receipt is resumed as before', await exists(path.join(runDir('D'), 'staging-coverage-notes.json')))
    t.eq('A meets its torn journal: refused, nothing announced', [reconciled('A'), JSON.parse(await fs.readFile(path.join(runDir('A'), 'run.json'), 'utf8')).integration.phase], [0, 'publishing'])
    t.ok('and the damage is now recorded', await exists(path.join(runDir('A'), 'journal-recovery.json')))
    const announced = events.filter((e) => e.type === 'integration-reconciled').length
    await supervisor.liveAgents()
    t.eq('a later poll announces nothing new', events.filter((e) => e.type === 'integration-reconciled').length, announced)
  }
  await cleanupFixtures()
}
