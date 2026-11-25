import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'

import { engineFixture, cleanupFixtures, scriptFor } from './fakes/fixture.mjs'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import { createCycleGates } from '../server/cycle-gates.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { wholeFreeze } from '../server/run-exclusivity.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { slotDirectory, resolveDriveHost } from '../server/runtime/drive-slots.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { gitWorktreeProvider, releaseWorkspace, startRun, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import { destroyInstance, holdInstance, holdsInstance } from '../server/runtime/stage-instances.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { checkIntervals } from '../server/runtime/run-metrics.mjs'
import * as store from '../server/runtime/store.mjs'
import { startProjectAction } from '../server/project-actions.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'full verification gates — a contained run goes on taking seat turns; only its drives on the cycle\'s hosts and its writes into what the cycle snapshots wait'

const exec = promisify(execFile)
const NL = String.fromCharCode(10)
const BUDGET = 240 * 60_000
const HOST = 'host-gates'
const CONTAINED = { mode: 'fence' }

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  const until = async (label, check, ms = 20000) => {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
  const eventsOf = async (engine) => (await store.readEvents(engine.issuePath, engine.runId)).events
  const contained = (record = {}) => ({ project: 'devpanel-project', issueId: 'i', runId: 'r', writes: true, whole: false, ...record })

  const shimDir = await temp('fg-shim-')
  const managerEnv = await installRemoteManager(shimDir)
  await fs.mkdir(path.join(shimDir, 'units'))
  await fs.writeFile(path.join(shimDir, 'units', 'no-fence'), '')
  const shim = path.join(shimDir, 'ssh')
  await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL, { mode: 0o755 })
  const savedBin = process.env.DEVPANEL_SSH_BIN
  process.env.DEVPANEL_SSH_BIN = shim

  try {
    t.section('wait-limit-timer-overflow: a bound beyond the timer ceiling does not fire early; a short one still fires')
    {
      const { systemClock, TIMER_MAX } = await import('../server/runtime/clock.mjs')
      let long = false
      let short = false
      // 36000 minutes, valid in the schema: setTimeout alone would turn it into 1 ms.
      const cancelLong = systemClock.after(36000 * 60_000, () => { long = true })
      systemClock.after(5, () => { short = true })
      await new Promise((resolve) => setTimeout(resolve, 60))
      t.eq('the 36000-minute bound has not fired; the 5 ms one has', [long, short, 36000 * 60_000 > TIMER_MAX], [false, true, true])
      cancelLong()
    }

    t.section('late-cycle-work: a cut stopped before it reaches the Git store creates and rewrites nothing there')
    {
      const { ensureGitStore } = await import('../server/runtime/git-store.mjs')
      const source = await temp('fg-store-src-')
      await exec('git', ['init', '-q', source])
      const storeDir = path.join(await temp('fg-store-'), 'p.git')
      const stopped = await ensureGitStore({ dir: storeDir, sourceRepository: path.join(source, '.git'), stop: () => { throw Object.assign(new Error('stopped'), { code: 'SNAPSHOT_STOPPED' }) } }).catch((error) => error)
      t.eq('refused with the stop, and no store was created', [stopped?.code, await fs.stat(storeDir).then(() => true, () => false)], ['SNAPSHOT_STOPPED', false])
      const made = await ensureGitStore({ dir: storeDir, sourceRepository: path.join(source, '.git') })
      t.ok('not stopped, it is created as before', Boolean(made?.objects) && await fs.stat(path.join(storeDir, 'objects')).then(() => true, () => false))
    }

    t.section('G5r/G16/G3 the gates: who waits, who passes (cycle-gates.mjs)')
    {
      const gates = createCycleGates()
      const repo = '/work/source/.git'
      t.ok('not frozen: a drive and a write pass', gates.gateFor(contained()).tryDrive('stage').ticket && gates.gateFor(contained()).tryWrite([repo]).ticket)
      gates.setFreeze({ cycleId: 'c1', projects: ['devpanel-project'], hosts: [{ hostRef: 'ssh-config:stage', host: 'stage', pinned: null }], snapshotted: { repositories: [repo], worktrees: ['/work/source'] } })
      t.ok('a contained run of the scope: its drive on a cycle host waits', gates.gateFor(contained()).tryDrive('stage').wait)
      t.ok('on another host it passes', gates.gateFor(contained()).tryDrive('other').ticket)
      t.ok('its write into a snapshotted repository waits', gates.gateFor(contained()).tryWrite([repo]).wait)
      t.ok('a write elsewhere passes', gates.gateFor(contained()).tryWrite(['/work/elsewhere/.git']).ticket)
      t.ok('G16 a run outside the scope passes on the cycle host', gates.gateFor(contained({ project: 'other-project' })).tryDrive('stage').ticket)
      t.ok('a whole run (or one that does not say) passes: the cycle waits for it instead', gates.gateFor({ project: 'devpanel-project', writes: true }).tryDrive('stage').ticket)
      t.ok('G3 a read-only run passes', gates.gateFor(contained({ writes: false })).tryDrive('stage').ticket)
      t.ok('the cycle\'s own run passes', gates.gateFor(contained({ cycleId: 'c1' })).tryDrive('stage').ticket)
      const unrelated = gates.gateFor(contained()).tryWrite(['/work/elsewhere/.git']).ticket
      t.ok('G5r a ticket the cycle does not drain (a write outside the snapshot) lets no drive past the gate', gates.gateFor(contained()).tryDrive('stage', { held: unrelated }).wait)
      unrelated.release()
      // Taken before this freeze: a drive on the cycle host and a write into the snapshot, both drained by the cycle.
      const before = createCycleGates()
      const drive = before.gateFor(contained()).tryDrive('stage').ticket
      const write = before.gateFor(contained()).tryWrite([repo]).ticket
      before.setFreeze({ cycleId: 'c1', projects: ['devpanel-project'], hosts: [{ hostRef: 'ssh-config:stage', host: 'stage', pinned: null }], snapshotted: { repositories: [repo], worktrees: ['/work/source'] } })
      t.ok('G5r the replacement inside a drive admitted before the freeze passes on its drive ticket', before.gateFor(contained()).tryDrive('stage', { held: drive }).ticket)
      t.ok('G5r a reconcile\'s drive passes on its write ticket into the snapshot', before.gateFor(contained()).tryDrive('stage', { held: write }).ticket)
      const count = before.pending().length
      drive.release()
      t.eq('a released ticket leaves pending()', before.pending().length, count - 1)
      t.ok('and no longer lets anything past', before.gateFor(contained()).tryDrive('stage', { held: drive }).wait)
      t.ok('a write named by its checkout inside a snapshotted work tree waits as one named by its common directory', gates.gateFor(contained()).tryWrite(['/work/source']).wait)
      t.eq('the pinned host is handed over whole', [before.gateFor(contained()).pinned('ssh-config:stage'), createCycleGates().gateFor(contained()).pinned('ssh-config:stage')], [null, null])
      const pinning = createCycleGates()
      pinning.setFreeze({ cycleId: 'p', hosts: [{ hostRef: 'ssh-config:stage', host: 'stage.example', pinned: { command: 'ssh', args: ['-o', 'HostName=10.0.0.9'] } }] })
      t.eq('G4 a drive of the cycle\'s own stage gets host and connection together', pinning.gateFor(contained()).pinned('ssh-config:stage'), { host: 'stage.example', pinned: { command: 'ssh', args: ['-o', 'HostName=10.0.0.9'] } })

      t.section('partially-installed-freeze: a record still being classified waits; one found whole is released at once')
      const g = createCycleGates()
      g.setFreeze({ cycleId: 'k', projects: ['devpanel-project'], hosts: [{ host: 'stage' }], snapshotted: { repositories: [repo], worktrees: ['/work/source'] } })
      const pending = { project: 'devpanel-project', runId: 'rk', writes: true, classifying: 'k' }
      const token = g.gateFor(pending).tryDrive('stage').wait
      t.ok('a record without a classification yet does not pass as if whole', Boolean(token))
      pending.whole = true
      delete pending.classifying
      t.eq('found whole: its waits end now, released, not thawed', [g.release('rk'), token.ended?.released, token.ended?.endSeq, g.isActive('k')], [1, true, null, true])
      t.ok('asked again it passes: the cycle waits for it instead', g.gateFor(pending).tryDrive('stage').ticket)
      gates.setFreeze({ cycleId: 'c2', projects: null, snapshotted: { unknown: true } })
      t.ok('a snapshot that cannot be read: every write of the scope waits', gates.gateFor(contained()).tryWrite(['/anything/.git']).wait)
    }

    t.section('G12/G6m thaw order by stamps; a thawed cycle is final and its tokens are never adopted')
    {
      let n = 0
      const gates = createCycleGates({ clock: { iso: () => `2026-11-25T00:00:${String(n++).padStart(2, '0')}.000Z` } })
      gates.setFreeze({ cycleId: 'c1', projects: null, hosts: [{ host: 'stage' }] })
      const [a, b, c] = ['a', 'b', 'c'].map((runId) => gates.gateFor(contained({ runId })).tryDrive('stage').wait)
      const persisted = []
      // A stalls its persistence; B and C do not wait for it.
      let releaseA
      const stallA = new Promise((resolve) => { releaseA = resolve })
      const ends = [gates.waitFor(a).then(async (s) => { await stallA; persisted.push(['a', s.endSeq]) }), gates.waitFor(b).then((s) => persisted.push(['b', s.endSeq])), gates.waitFor(c).then((s) => persisted.push(['c', s.endSeq]))]
      gates.thaw('c1')
      t.eq('every token is stamped in begin order in the thaw itself', [a, b, c].map((x) => x.ended?.endSeq), [1, 2, 3])
      await tick()
      t.eq('B and C persist while A is stalled', persisted, [['b', 2], ['c', 3]])
      releaseA()
      await Promise.all(ends)
      t.eq('ordered by endSeq the ends read A, B, C', [...persisted].sort((x, y) => x[1] - y[1]).map((x) => x[0]), ['a', 'b', 'c'])
      t.eq('a late freeze of the thawed cycle is ignored', [gates.setFreeze({ cycleId: 'c1' }), gates.isActive('c1'), gates.current()], [false, false, null])
      gates.setFreeze({ cycleId: 'c2', projects: null, hosts: [{ host: 'stage' }] })
      t.eq('G6m the newer cycle adopts no old token', [gates.waiters().length, a.ended.endSeq, a.cycleId], [0, 1, 'c1'])
      gates.thaw('c2')
    }

    t.section('G2/AC7 whole or contained (run-exclusivity.mjs wholeFreeze)')
    {
      const src = await temp('fg-src-')
      await exec('git', ['init', '-q', src])
      await fs.writeFile(path.join(src, '.gitignore'), 'runs/' + NL)
      const frozen = { worktrees: [src], repositories: [path.join(src, '.git')], unknown: false }
      const snapshot = { tactic: 'implementation', workspace: { isolation: 'worktree', symlinks: 'reject' }, fence: { namespace: 1 } }
      const elsewhere = { path: await temp('fg-wt-') }
      const reason = async (o) => (await wholeFreeze({ snapshot, workspace: elsewhere, frozen, fence: CONTAINED, platform: {}, env: {}, ...o })).reason
      t.eq('confined, its own worktree: contained', await reason({}), 'contained')
      t.eq('(a) namespace 0: unconfined, whole', await reason({ snapshot: { ...snapshot, fence: { namespace: 0 } } }), 'unconfined')
      t.eq('no proved fence on this host: unconfined, whole', await reason({ fence: { mode: 'off' } }), 'unconfined')
      t.eq('(d) an unproved fence may fall back to running unfenced: whole', await reason({ platform: { bubblewrap: true }, env: { DEVPANEL_FENCE_UNPROVED: 'run' } }), 'unconfined')
      t.eq('(d) the fallback not allowed: contained', await reason({ platform: { bubblewrap: true }, env: {} }), 'contained')
      t.eq('(g) in place: whole', await reason({ snapshot: { ...snapshot, workspace: { isolation: 'in-place' } } }), 'in-place')
      t.eq('(g) a release (staging, deployment): whole', await reason({ snapshot: { ...snapshot, tactic: 'deployment' } }), 'release')
      t.eq('an unreadable snapshot: whole', await reason({ snapshot: null }), 'unreadable')
      t.eq('S unreadable: whole', await reason({ frozen: { ...frozen, unknown: true } }), 'snapshot-unknown')
      t.eq('(f) links allowed, not provisioned yet: whole', await reason({ snapshot: { ...snapshot, workspace: { symlinks: 'allow' } }, workspace: null }), 'links-unknown')
      t.eq('(f) an escaping link into S: whole', await reason({ workspace: { path: elsewhere.path, symlinks: { policy: 'allow', escaping: [{ path: 'lib', target: path.relative(elsewhere.path, path.join(src, 'lib')) }] } } }), 'link-into-snapshot')
      t.eq('(f) an escaping link elsewhere: contained', await reason({ workspace: { path: elsewhere.path, symlinks: { policy: 'allow', escaping: [{ path: 'lib', target: '/usr/lib' }] } } }), 'contained')
      t.eq('(e) a writable mount inside S, not ignored there: whole', await reason({ workspace: { path: path.join(src, 'work') } }), 'mount-in-snapshot')
      t.eq('(e) a writable mount inside S that S ignores: contained', await reason({ workspace: { path: path.join(src, 'runs', 'wt') } }), 'contained')
      t.eq('(e) a directory whose name begins with two dots is inside S (live-link-write)', await reason({ workspace: { path: elsewhere.path, scratchPath: path.join(src, '..scratch') } }), 'mount-in-snapshot')
      const linkVia = path.join(await temp('fg-via-'), 'via')
      await fs.symlink(src, linkVia)
      t.eq('(f) an escaping link through another link into S: whole', await reason({ workspace: { path: elsewhere.path, symlinks: { policy: 'allow', escaping: [{ path: 'lib', target: path.join(linkVia, 'lib') }] } } }), 'link-into-snapshot')
      const g2 = createCycleGates()
      g2.setFreeze({ cycleId: 'dots', projects: null, snapshotted: { repositories: [], worktrees: ['/work/source'] } })
      t.ok('the gate counts a checkout path beginning with two dots inside a snapshotted work tree', g2.gateFor(contained()).tryWrite(['/work/source/..vendor']).wait)
    }

    t.section('AC1/AC7/AC8 the supervisor\'s freeze: a contained run takes every turn; a whole one pauses; one outside the scope is untouched')
    {
      const dir = await temp('fg-sup-')
      const issues = { getRunHolder: async () => { throw new Error('none') }, getIssue: async () => { throw new Error('none') }, listIssues: async () => [], listProjects: async () => [] }
      const make = (extra = {}) => createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir, ...extra })
      const begin = async (project = 'devpanel-project') => {
        const seen = []
        const base = scriptFor()
        const f = await engineFixture({ script: (turn) => { seen.push(turn.stepId); return base(turn) } })
        const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath,
          harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
        engine.snapshot = { ...engine.snapshot, fence: { ...(engine.snapshot.fence ?? {}), namespace: 1 } }
        return { seen, engine, record: { runId: engine.runId, project, issueId: f.issue.id, issuePath: f.issuePath, phase: 'run', writes: true, engine } }
      }
      const snapshotted = { repositories: [path.join(dir, 'source', '.git')], worktrees: [path.join(dir, 'source')], unknown: false }

      const sup = make({ seatFencePolicy: () => CONTAINED })
      const one = await begin()
      sup.active.set(`devpanel-project/${one.record.issueId}`, one.record)
      const asked = await sup.freeze('c1', { projects: ['devpanel-project'], snapshotted })
      one.engine.cycleGate = sup.cycleGateFor(one.record)
      t.eq('AC1 classified contained, not asked to pause, not waited for', [one.record.whole, asked, sup.busy()], [false, [], []])
      await one.engine.drive()
      t.eq('AC1 every seat turn ran during the freeze and the run completed', [one.engine.run.status, one.engine.run.blockedReason ?? null, one.engine.run.pause ?? null, one.engine.run.freezeRequested ?? null, one.seen.includes('implement') && one.seen.includes('confirm')], ['completed', null, null, null, true])
      t.eq('no turn was withheld', (await eventsOf(one.engine)).filter((e) => e.type === 'turn-withheld').length, 0)
      sup.thaw('c1')
      sup.active.clear()
      await releaseWorkspace(one.engine)

      const whole = make()   // the test runner's fence is off: every turn would run unconfined
      const two = await begin()
      const out = await begin('other-project')
      whole.active.set(`devpanel-project/${two.record.issueId}`, two.record)
      whole.active.set(`other-project/${out.record.issueId}`, out.record)
      const asked2 = await whole.freeze('c2', { projects: ['devpanel-project'], snapshotted })
      two.engine.cycleGate = whole.cycleGateFor(two.record)
      out.engine.cycleGate = whole.cycleGateFor(out.record)
      t.eq('AC7 an unconfined writing run is whole: asked and waited for', [two.record.whole, asked2.map((a) => a.runId), whole.busy().map((b) => b.runId)], [true, [two.engine.runId], [two.engine.runId]])
      await two.engine.drive()
      t.eq('AC7 it pauses as full-verification, as today', [two.engine.run.status, two.engine.run.pause?.kind, two.seen.length], ['paused', 'full-verification', 0])
      await out.engine.drive()
      t.eq('AC8 a run outside the scope is never asked and completes', [out.engine.run.status, out.engine.run.blockedReason ?? null, out.engine.run.pause ?? null, out.record.whole ?? 'unclassified'], ['completed', null, null, 'unclassified'])
      whole.thaw('c2')
      t.eq('the thaw takes back the request: nothing is left requested', two.engine.run.freezeRequested ?? null, null)
      whole.active.clear()
      await releaseWorkspace(two.engine)
      await releaseWorkspace(out.engine)

      t.section('G17(i) a request of a thawed cycle is dropped, never applied')
      const three = await begin()
      const late = make({ seatFencePolicy: () => CONTAINED })
      three.engine.cycleGate = late.cycleGateFor({ ...three.record, whole: true })
      three.engine.run.freezeRequested = { cycleId: 'c-old', at: '2026-11-25T00:00:00.000Z' }
      await three.engine.drive()
      t.eq('the run does not pause and completes', [three.engine.run.status, three.engine.run.pause ?? null, three.engine.run.freezeRequested ?? null], ['completed', null, null])
      t.ok('its journal names the dropped request', (await eventsOf(three.engine)).some((e) => e.type === 'freeze-request-dropped' && e.cycleId === 'c-old'))
      await releaseWorkspace(three.engine)
    }

    /** A real engine (manual clock) and a drive of a candidate through its own wait accounting, gated by `gates`. */
    const driveSetup = async () => {
      const f = await engineFixture()
      // One clock for the gates and the engine, as in the service.
      const gates = createCycleGates({ clock: f.clock })
      const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath,
        harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.deliveryProvider })
      engine.cycleGate = gates.gateFor(contained({ runId: engine.runId, issueId: f.issue.id }))
      const ws = await gitWorktreeProvider.create({ projectPath: f.projectPath, runId: 'gates', root: await temp('fg-ws-'), policy: { base: 'head' } })
      const baseline = await baselineOf(ws.path)
      await fs.writeFile(path.join(ws.path, 'value.txt'), 'changed' + NL)
      const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
      const slotsDir = await temp('fg-slots-')
      const ssh = (host) => ({ hostRef: `ssh-config:${host}`, workdir: '/tmp' })
      const drive = async (host = HOST, extra = {}, options = {}) => runChecks({ baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, revision: fp.fingerprint, fingerprint: fp,
        runDir: await temp('fg-run-'), clock: f.clock, signal: engine.controller.signal, onDriveWait: (wait) => engine.noteDriveWait(wait),
        driveGate: engine.gateForDrives(), beforeCycleWait: (token) => engine.releaseHeld('full-verification-wait', { hosts: engine.cycleWaitHosts(token) }), onRemovalPending: (entry) => engine.keepPendingRemoval(entry),
        target: { kind: 'ssh', ssh: { ...ssh(host), workdir: await temp('fg-remote-') }, commands: [{ id: 'run', run: 'true' }], ...extra },
        driveTiming: { slotsDir, pollMs: 10, retryMs: 10, attemptMs: 5000, windowMs: 30000 }, ...options })
      const slots = (host = HOST) => Promise.all([0, 1].map((n) => acquire(path.join(slotDirectory(host, slotsDir), `slot-${n}.lock`), { purpose: 'test' })))
      return { f, engine, drive, slots, ssh, gates, slotsDir, ws }
    }

    t.section('G5/G13 AC2/AC5/AC6 a contained run\'s drive on a cycle host waits for the thaw, holds no slot, and the wait does not count against its time')
    {
      const { f, engine, drive, slots, ssh, gates } = await driveSetup()
      const resolved = await resolveDriveHost(ssh(HOST))
      gates.setFreeze({ cycleId: 'c5', projects: ['devpanel-project'], hosts: [{ hostRef: `ssh-config:${HOST}`, host: resolved.host, pinned: resolved.pinned }] })
      const disarm = engine.armDeadline()
      const running = drive()
      await until('the drive to wait for the cycle', () => engine.run.cycleWait?.kind === 'drive')
      t.eq('AC2 it waits for this cycle, on the record', [engine.run.cycleWait.cycleId, gates.waiters().map((w) => w.runId)], ['c5', [engine.runId]])
      const locks = await slots()
      t.ok('AC6 while it waits it holds no drive slot: every slot of the host can be taken', locks.length === 2)
      await Promise.all(locks.map((l) => l.release()))
      t.eq('AC6 and no drive ticket the cycle would wait for', gates.pending().filter((p) => p.kind === 'drive' && p.runId === engine.runId).length, 0)
      const explanation = explainRun({ ...engine.run, status: 'running' })
      t.ok('the explanation names the wait', /Waiting for full verification c5 before its drive/.test(explanation.headline), explanation.headline)
      f.clock.advance(BUDGET + 60_000)
      t.eq('AC5 the wall clock does not count it live', [engine.controller.signal.aborted, engine.budgetExceeded()], [false, null])
      gates.thaw('c5')
      const result = await running
      t.eq('AC2 at the thaw it proceeds and passes', result.result, 'passed', result.error)
      t.eq('the wait is persisted with the gate\'s stamps', engine.run.cycleWaits.map((w) => [w.kind, w.cycleId, w.endSeq, w.outcome]), [['drive', 'c5', 1, 'thawed']])
      t.eq('closed: nothing open, nothing on the explanation', [engine.openDriveWaits.size, engine.run.cycleWait ?? null], [0, null])
      t.eq('AC5 nor once persisted', engine.budgetExceeded(), null)
      disarm()

      t.section('a drive on another host, during the same kind of freeze, proceeds')
      gates.setFreeze({ cycleId: 'c6', projects: ['devpanel-project'], hosts: [{ hostRef: 'ssh-config:somewhere', host: 'somewhere-else', pinned: null }] })
      const other = await drive('host-other')
      t.eq('not gated: passes with no cycle wait', [other.result, engine.run.cycleWaits.length], ['passed', 1])
      gates.thaw('c6')

      t.section('a stop during the cycle wait cancels the drive and closes the wait')
      gates.setFreeze({ cycleId: 'c7', projects: ['devpanel-project'], hosts: [{ hostRef: `ssh-config:${HOST}`, host: resolved.host, pinned: resolved.pinned }] })
      const stopping = drive()
      await until('the drive to wait again', () => engine.run.cycleWait?.cycleId === 'c7')
      engine.cancel('requested')
      const stopped = await stopping
      t.eq('unavailable, nothing left open', [stopped.result, engine.openDriveWaits.size, engine.run.cycleWaits.at(-1)?.outcome], ['unavailable', 0, 'stopped'])
      gates.thaw('c7')
      await releaseWorkspace(engine)
    }

    t.section('G8/G13 AC3 a contained run\'s apply-to-source delivery into a snapshotted repository waits for the thaw; its seat turns went on')
    {
      const scenario = async (inS) => {
        const gates = createCycleGates()
        const seen = []
        const base = scriptFor()
        let engine
        const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async (turn) => {
          seen.push(turn.stepId)
          if (turn.stepId === 'implement') await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), 'export default 1' + NL)
          return base(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
        } })
        const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'opus-5' } } }
        const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
        engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider: worktreeDiffDelivery, expectConfigHash: resolved.resolved.configHash, runOptions: options })
        engine.cycleGate = gates.gateFor(contained({ runId: engine.runId }))
        const common = (await exec('git', ['-C', f.projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
        gates.setFreeze({ cycleId: 'c8', projects: ['devpanel-project'], snapshotted: { repositories: [inS ? common : '/work/elsewhere/.git'], worktrees: [] } })
        return { gates, seen, f, engine, common }
      }
      {
        const { gates, seen, f, engine, common } = await scenario(true)
        const driving = engine.drive()
        await until('the delivery to wait for the cycle', () => engine.run.cycleWait?.kind === 'write' || ['completed', 'blocked', 'failed'].includes(engine.run.status), 60000)
        t.eq('AC3 the delivery waits for this cycle, before it writes the source', [engine.run.cycleWait?.kind, engine.run.cycleWait?.action, engine.run.cycleWait?.cycleId, gates.waiters()[0]?.repositories], ['write', 'delivery', 'c8', [common]])
        t.eq('AC1 every seat turn before it ran (no turn withheld)', [seen.includes('implement'), seen.includes('confirm')], [true, true])
        t.eq('nothing reached the source checkout yet', await fs.readFile(path.join(f.projectPath, 'server.mjs'), 'utf8').catch(() => null), null)
        const explanation = explainRun(engine.run)
        t.ok('the explanation names the wait before its delivery', /Waiting for full verification c8 before its delivery/.test(explanation.headline), explanation.headline)
        gates.thaw('c8')
        await driving
        t.eq('after the thaw it delivers and completes', [engine.run.status, await fs.readFile(path.join(f.projectPath, 'server.mjs'), 'utf8').catch(() => null)], ['completed', 'export default 1' + NL])
        t.eq('the write wait is on the record with its stamps', engine.run.cycleWaits.map((w) => [w.kind, w.action, w.endSeq, w.outcome]), [['write', 'delivery', 1, 'thawed']])
        t.eq('AC5 and counted among the excused intervals', checkIntervals(engine.run).length, checkIntervals({ ...engine.run, cycleWaits: [] }).length + 1)
        await releaseWorkspace(engine).catch(() => {})
      }
      {
        const { engine, f } = await scenario(false)
        await engine.drive()
        t.eq('a delivery into a repository the cycle does not snapshot proceeds during the freeze', [engine.run.status, engine.run.cycleWaits ?? [], await fs.readFile(path.join(f.projectPath, 'server.mjs'), 'utf8').catch(() => null)], ['completed', [], 'export default 1' + NL])
        await releaseWorkspace(engine).catch(() => {})
      }
    }

    t.section('G5 the exclusive path (a modules drive that holds its host whole) waits holding neither its admission lock nor a slot')
    {
      const { engine, drive, slots, ssh, gates, slotsDir } = await driveSetup()
      const resolved = await resolveDriveHost(ssh(HOST))
      gates.setFreeze({ cycleId: 'x1', projects: ['devpanel-project'], hosts: [{ hostRef: `ssh-config:${HOST}`, host: resolved.host, pinned: resolved.pinned }] })
      const running = drive(HOST, { tier: 'modules' })
      await until('the exclusive drive to wait for the cycle', () => engine.run.cycleWait?.kind === 'drive')
      const admission = await acquire(path.join(slotDirectory(resolved.host, slotsDir), 'exclusive.lock'), { purpose: 'test' })
      const locks = await slots(resolved.host)
      t.ok('its admission lock and every slot of the host are free while it waits', Boolean(admission) && locks.length === 2)
      await admission.release()
      await Promise.all(locks.map((l) => l.release()))
      gates.thaw('x1')
      const result = await running
      t.eq('after the thaw it takes them and passes', [result.result, engine.run.cycleWaits.at(-1)?.endSeq], ['passed', 1], result.error)
      await releaseWorkspace(engine)
    }

    t.section('queued-drive: a drive queued behind the admission lock when the freeze begins gives back its ticket and waits for the thaw')
    {
      const { engine, drive, slots, ssh, gates, slotsDir } = await driveSetup()
      const resolved = await resolveDriveHost(ssh(HOST))
      // Another drive's admission holds the lock: this drive is admitted by the gate (no freeze yet) and queues behind it.
      const admission = await acquire(path.join(slotDirectory(resolved.host, slotsDir), 'exclusive.lock'), { purpose: 'test-drive-admission' })
      const running = drive()
      await tick()
      gates.setFreeze({ cycleId: 'q1', projects: ['devpanel-project'], hosts: [{ hostRef: `ssh-config:${HOST}`, host: resolved.host, pinned: resolved.pinned }] })
      t.eq('while queued it holds no ticket the cycle would wait for', gates.pending().filter((p) => p.runId === engine.runId).length, 0)
      await admission.release()
      await until('the queued drive to wait for the cycle', () => engine.run.cycleWait?.cycleId === 'q1')
      const locks = await slots(resolved.host)
      t.ok('it took no slot before the thaw', locks.length === 2)
      await Promise.all(locks.map((l) => l.release()))
      gates.thaw('q1')
      t.eq('after the thaw it passes', (await running).result, 'passed')
      await releaseWorkspace(engine)
    }

    t.section('G5 a fresh stage-instance drive asks the gate before every slot: it waits holding no instance slot, then takes one')
    {
      const gates = createCycleGates()
      const slotsDir = await temp('fg-inst-slots-')
      const root = await temp('fg-inst-')
      gates.setFreeze({ cycleId: 'i1', projects: ['devpanel-project'], hosts: [{ host: 'inst-host' }] })
      const waits = []
      const holding = holdInstance({ instance: { name: 'fg-inst-1', root: path.join(root, 'fg-inst-1'), max: 1, destroy: { run: 'true' } }, host: 'inst-host', kind: 'local', runId: 'fg-inst-run', slotsDir, pollMs: 10,
        gate: gates.gateFor(contained({ runId: 'fg-inst-run' })), onWait: (w) => waits.push([w.phase, w.reason]) })
      await until('the instance drive to wait for the cycle', () => gates.waiters().length === 1)
      const held = (await fs.readdir(slotDirectory('inst-host', slotsDir)).catch(() => [])).filter((n) => n.startsWith('instance-'))
      t.eq('it holds no instance slot while it waits', held, [])
      gates.thaw('i1')
      const slot = await holding
      t.eq('after the thaw it takes a fresh slot, with its ticket', [slot.fresh, Boolean(slot.ticket)], [true, true])
      t.ok('the wait was told as a full-verification wait', waits.some(([phase, reason]) => phase === 'start' && reason === 'full-verification'), JSON.stringify(waits))
      slot.ticket?.release()
      await destroyInstance('fg-inst-1', { reason: 'test' })
    }

    t.section('G7 a held instance whose removal fails stays pending, the drive settles unavailable without waiting; the removal is retried and confirmed before the next wait')
    {
      const { engine, drive, ssh, gates } = await driveSetup()
      const resolved = await resolveDriveHost(ssh(HOST))
      const flag = path.join(await temp('fg-flag-'), 'removable')
      const root = await temp('fg-held-')
      await holdInstance({ instance: { name: `fg-held-${engine.runId.slice(-8)}`, root, max: 4, destroy: { run: `test -e '${flag}'` } }, host: resolved.host, kind: 'local', runId: engine.runId })
      // An instance the same run holds on a host the cycle does not drive on (excess-idle-cleanup): never touched by its cleanup.
      const elsewhere = `fg-elsewhere-${engine.runId.slice(-8)}`
      await holdInstance({ instance: { name: elsewhere, root: await temp('fg-elsewhere-'), max: 4, destroy: { run: 'true' } }, host: 'fg-other-host', kind: 'local', runId: engine.runId })
      gates.setFreeze({ cycleId: 'h1', projects: ['devpanel-project'], hosts: [{ hostRef: `ssh-config:${HOST}`, host: resolved.host, pinned: resolved.pinned }] })
      const first = await drive()
      t.eq('the removal failed: unavailable, no retry, nothing waited', [first.result, first.retrySkipped?.reason, (engine.run.cycleWaits ?? []).length], ['unavailable', 'held-instance-not-removed', 0], first.error)
      t.eq('the failed removal stays on the record', (engine.run.pendingRemovals ?? []).map((e) => [e.kind, e.host]), [['stage-instance', resolved.host]])
      await fs.writeFile(flag, '')
      const second = drive()
      await until('the next drive to wait, its removal confirmed first', () => engine.run.cycleWait?.cycleId === 'h1')
      t.eq('retried and confirmed: nothing pending', engine.run.pendingRemovals ?? [], [])
      gates.thaw('h1')
      t.eq('and after the thaw it passes', (await second).result, 'passed')
      t.ok('the instance on the other host was kept throughout', holdsInstance(elsewhere))
      await destroyInstance(elsewhere, { reason: 'test' })
      await releaseWorkspace(engine)
    }

    t.section('reconstruction-wait-keeps-smoke-instance: a drive whose reconstruction write waits for the cycle first removes what the run holds on the cycle\'s hosts, confirmed; a removal that fails means no wait')
    {
      const { engine, drive, ssh, gates, ws } = await driveSetup()
      const resolved = await resolveDriveHost(ssh(HOST))
      // The repository the reconstruction registers its worktree in is one the cycle snapshots: the write waits.
      const common = (await exec('git', ['-C', ws.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()
      const flag = path.join(await temp('fg-rflag-'), 'removable')
      const held = `fg-rheld-${engine.runId.slice(-8)}`
      await holdInstance({ instance: { name: held, root: await temp('fg-rheld-'), max: 4, destroy: { run: `test -e '${flag}'` } }, host: resolved.host, kind: 'local', runId: engine.runId })
      const elsewhere = `fg-relsewhere-${engine.runId.slice(-8)}`
      await holdInstance({ instance: { name: elsewhere, root: await temp('fg-relsewhere-'), max: 4, destroy: { run: 'true' } }, host: 'fg-other-host', kind: 'local', runId: engine.runId })
      gates.setFreeze({ cycleId: 'w1', projects: ['devpanel-project'], hosts: [{ hostRef: `ssh-config:${HOST}`, host: resolved.host, pinned: resolved.pinned }], snapshotted: { repositories: [common], worktrees: [] } })
      const writeGate = engine.writeGate('check-reconstruction')
      // The drive's answer, or that it began waiting for the cycle (what it must not do while its removal fails).
      const answerOrWait = async (running) => {
        let done = false
        const settled = running.finally(() => { done = true })
        for (;;) {
          if (done) return settled
          if (engine.run.cycleWait?.cycleId === 'w1') return { result: 'waited', running: settled }
          await tick()
        }
      }
      const first = await answerOrWait(drive(HOST, {}, { writeGate }))
      if (first.running) { gates.thaw('w1'); await first.running }
      t.eq('the removal failed: unavailable, no retry, nothing waited', [first.result, first.retrySkipped?.reason, (engine.run.cycleWaits ?? []).length], ['unavailable', 'held-instance-not-removed', 0], first.error)
      t.eq('the failed removal stays on the record', (engine.run.pendingRemovals ?? []).map((e) => [e.kind, e.host]), [['stage-instance', resolved.host]])
      await fs.writeFile(flag, '')
      const second = drive(HOST, {}, { writeGate })
      await until('the reconstruction write to wait for the cycle', () => engine.run.cycleWait?.cycleId === 'w1')
      t.eq('it waits at the reconstruction write, for this cycle', [engine.run.cycleWait.kind, engine.run.cycleWait.action], ['write', 'check-reconstruction'])
      t.eq('the removal was retried and confirmed before the wait began: nothing pending, the instance no longer held', [engine.run.pendingRemovals ?? [], holdsInstance(held)], [[], false])
      t.ok('the instance on a host the cycle does not drive on is kept', holdsInstance(elsewhere))
      gates.thaw('w1')
      const result = await second
      t.eq('after the thaw it passes, the write wait on the record', [result.result, engine.run.cycleWaits.map((w) => [w.kind, w.action, w.outcome])], ['passed', [['write', 'check-reconstruction', 'thawed']]], result.error)
      await destroyInstance(elsewhere, { reason: 'test' })
      await releaseWorkspace(engine)
    }

    t.section('G15/AC7 a writing run started through the real supervisor during a cycle: a contained one is admitted and takes every turn; a whole one is refused')
    {
      const harnessModule = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')
      const f = await engineFixture()
      const projectsDir = path.join(f.issuesDir, 'projects')
      await fs.mkdir(projectsDir, { recursive: true })
      await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project'))
      const state = await temp('fg-start-')
      const control = path.join(state, 'control.json')
      await fs.writeFile(control, JSON.stringify({ ledger: path.join(state, 'ledger.jsonl'), delayMs: 0 }))
      await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(harnessModule)}` + NL)
      const saved = { control: process.env.DEVPANEL_FAKE_CONTROL, projects: process.env.DEVPANEL_PROJECTS_DIR }
      process.env.DEVPANEL_FAKE_CONTROL = control
      process.env.DEVPANEL_PROJECTS_DIR = projectsDir
      try {
        const common = await fs.realpath((await exec('git', ['-C', f.projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
        const snapshotted = { repositories: [common], worktrees: [f.projectPath] }
        // `store`: whether the host keeps a Git store, where a start's base snapshot is written instead of the project's own
        // repository (original AC7: only a start that needs no write before its delivery may start during a cycle).
        const make = (policy, store = '/fixture/store.git') => createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot, gitStoreOf: () => store, ...(policy ? { seatFencePolicy: policy } : {}) })
        const start = (sup) => sup.start({ project: 'devpanel-project', issueId: f.issue.id, playbookId: 'implementation', configRoot: f.configRoot })
        const unfenced = make(null)
        await unfenced.freeze('c15w', { projects: ['devpanel-project'], snapshotted })
        const refused = await start(unfenced).catch((error) => error)
        t.eq('turns that cannot be fenced here: the start would be whole and is refused', [refused?.code, refused?.status, refused?.started], ['FULL_VERIFICATION_FREEZE', 409, false])
        unfenced.thaw('c15w')
        const storeless = make(() => CONTAINED, null)
        await storeless.freeze('c15s', { projects: ['devpanel-project'], snapshotted })
        const writesBase = await start(storeless).catch((error) => error)
        t.eq('with no Git store its base snapshot would write into the snapshotted project repository, so it is refused', [writesBase?.code, writesBase?.status], ['FULL_VERIFICATION_FREEZE', 409])
        storeless.thaw('c15s')
        // The decision of report 041: the destination decides, not whether a store exists. A store the cycle snapshots too
        // (the cycle adds each scope project's store to S) refuses the start just the same.
        const storeInS = make(() => CONTAINED, '/fixture/store.git')
        await storeInS.freeze('c15g', { projects: ['devpanel-project'], snapshotted: { ...snapshotted, repositories: [...snapshotted.repositories, '/fixture/store.git'] } })
        const writesStore = await start(storeInS).catch((error) => error)
        t.eq('a store in the snapshotted set: its base snapshot would write there, so it is refused', [writesStore?.code, writesStore?.status], ['FULL_VERIFICATION_FREEZE', 409])
        storeInS.thaw('c15g')
        const sup = make(() => CONTAINED)
        await sup.freeze('c15', { projects: ['devpanel-project'], snapshotted })
        const started = await start(sup)
        t.ok('a contained writing run is admitted during the cycle when its base snapshot goes to a Git store the cycle does not snapshot (the admission path; this fixture provisions as before)', Boolean(started?.runId), JSON.stringify(started))
        await sup.settle()
        const run = await store.readRun(f.issuePath, started.runId)
        t.eq('it ran to its end while the cycle stayed frozen: no pause, no withheld turn, nothing requested', [run.status, run.pause?.kind ?? null, run.freezeRequested ?? null, sup.frozen()?.cycleId], ['completed', null, null, 'c15'], run.blockedReason)
        t.eq('no turn was withheld', (await store.readEvents(f.issuePath, started.runId)).events.filter((e) => e.type === 'turn-withheld').length, 0)
        sup.thaw('c15')

        // handoff-requests-new-cycle-before-classification: while the handoff reads the run against the real workspace for
        // cycle hA, hA thaws and hB freezes (staged inside that reading). The run, contained, is never asked for hB.
        let storeCalls = 0
        let armed = false
        let swapped = null
        let hand = null
        const swapping = () => {
          if (!armed) return CONTAINED
          armed = false
          hand.thaw('hA')
          swapped = hand.freeze('hB', { projects: ['devpanel-project'], snapshotted })
          return CONTAINED
        }
        // gitStoreOf is asked at admission and again by the provisioning ticket, right before provisionRun: the next policy
        // reading is the handoff's.
        hand = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot, gitStoreOf: () => { if (++storeCalls === 2) armed = true; return '/fixture/store.git' }, seatFencePolicy: swapping })
        await hand.freeze('hA', { projects: ['devpanel-project'], snapshotted })
        const handed = await start(hand)
        await hand.settle()
        await swapped
        const handedRun = await store.readRun(f.issuePath, handed.runId)
        t.eq('the cycle changed during the handoff\'s reading, and the contained run was not asked for the newer cycle: it ran to its end', [Boolean(swapped), hand.frozen()?.cycleId, handedRun.status, handedRun.freezeRequested ?? null, handedRun.pause?.kind ?? null], [true, 'hB', 'completed', null, null], handedRun.blockedReason)
        t.eq('no turn of it was withheld', (await store.readEvents(f.issuePath, handed.runId)).events.filter((e) => e.type === 'turn-withheld').length, 0)
        hand.thaw('hB')

        // snapshot-preflight-writes: a run admitted before the cycle, whose provisioning would write into a store the cycle
        // snapshots, waits at the gate before provisionRun (the freeze is staged right as its destination is read) and
        // provisions after the thaw.
        const storeInSnapshot = '/fixture/store-in-s.git'
        let pre = null
        pre = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot, seatFencePolicy: () => CONTAINED, gitStoreOf: () => {
          if (!pre.frozen()) pre.freeze('pv', { projects: ['devpanel-project'], snapshotted: { ...snapshotted, repositories: [...snapshotted.repositories, storeInSnapshot] } })
          return storeInSnapshot
        } })
        const provisioned = await start(pre)
        await until('the provisioning wait', async () => (await store.readRun(f.issuePath, provisioned.runId).catch(() => null))?.cycleWait?.action === 'provisioning')
        await tick()
        const waitingRun = await store.readRun(f.issuePath, provisioned.runId)
        t.eq('it waits for the cycle before provisioning: the wait on its record, no workspace yet', [waitingRun.cycleWait?.cycleId, waitingRun.workspace?.path ?? null, pre.frozen()?.cycleId], ['pv', null, 'pv'])
        pre.thaw('pv')
        await pre.settle()
        const provisionedRun = await store.readRun(f.issuePath, provisioned.runId)
        t.eq('after the thaw it provisions and runs to its end; the wait is kept, closed by the thaw', [provisionedRun.status, provisionedRun.cycleWait ?? null, (provisionedRun.cycleWaits ?? []).map((w) => [w.action, w.cycleId, w.outcome])], ['completed', null, [['provisioning', 'pv', 'thawed']]], provisionedRun.blockedReason)
      } finally {
        if (saved.control === undefined) delete process.env.DEVPANEL_FAKE_CONTROL; else process.env.DEVPANEL_FAKE_CONTROL = saved.control
        if (saved.projects === undefined) delete process.env.DEVPANEL_PROJECTS_DIR; else process.env.DEVPANEL_PROJECTS_DIR = saved.projects
      }
    }

    t.section('whole-freeze-installation: a run identifiable as whole without any reading is asked to stop before the freeze awaits anything')
    {
      const dir = await temp('fg-quick-')
      const sup = createSupervisor({ issues: { getRunHolder: async () => { throw new Error('none') }, getIssue: async () => { throw new Error('none') }, listIssues: async () => [], listProjects: async () => [] }, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir, seatFencePolicy: () => CONTAINED })
      const asked = []
      const engineOf = (runId, snapshot) => ({ snapshot, run: { status: 'running', workspace: { path: path.join(dir, runId) } }, requestFreeze (cycleId) { asked.push([runId, cycleId]); return null } })
      sup.active.set('devpanel-project/in-place', { runId: 'r-in-place', project: 'devpanel-project', issueId: 'in-place', phase: 'run', writes: true, engine: engineOf('r-in-place', { tactic: 'implementation', workspace: { isolation: 'in-place' }, fence: { namespace: 1 } }) })
      sup.active.set('devpanel-project/contained', { runId: 'r-contained', project: 'devpanel-project', issueId: 'contained', phase: 'run', writes: true, engine: engineOf('r-contained', { tactic: 'implementation', workspace: { isolation: 'worktree', symlinks: 'reject' }, fence: { namespace: 1 } }) })
      const freezing = sup.freeze('q2', { projects: ['devpanel-project'], snapshotted: { repositories: [], worktrees: [] } })
      t.eq('asked synchronously, as the freeze began', asked, [['r-in-place', 'q2']])
      t.eq('the contained run waits at the gates while it is read', sup.active.get('devpanel-project/contained').classifying, 'q2')
      await freezing
      t.eq('read, the contained run is not asked', [asked.length, sup.active.get('devpanel-project/contained').whole, sup.active.get('devpanel-project/contained').classifiedFor], [1, false, 'q2'])
      sup.thaw('q2')
      sup.active.clear()
    }

    t.section('G17(i) a preflight reservation the freeze asked: its run.json is cleared at the thaw, the writes in order; read back after a restart nothing is applied')
    {
      const dir = await temp('fg-preflight-')
      const issuePath = path.join(dir, 'issue')
      const runId = '2026-11-25T00-00-00-000Z-0000beef'
      await fs.mkdir(path.join(issuePath, 'runs', runId), { recursive: true })
      const reservation = { run: { runId, status: 'preflighting', steps: [] } }
      await store.writeRun(issuePath, runId, reservation.run)
      const sup = createSupervisor({ issues: { getRunHolder: async () => ({ path: issuePath }), getIssue: async () => ({ path: issuePath }), listIssues: async () => [], listProjects: async () => [] }, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir })
      // A reservation whose snapshot cannot be read is whole: the freeze asks it.
      const record = { runId, project: 'devpanel-project', issueId: 'issue', issuePath, phase: 'preflight', writes: true, reservation }
      sup.active.set('devpanel-project/issue', record)
      const asked = await sup.freeze('p1', { projects: ['devpanel-project'], snapshotted: { repositories: [], worktrees: [] } })
      t.eq('asked, and the request persisted on the reservation', [asked.map((a) => a.runId), (await store.readRun(issuePath, runId)).freezeRequested?.cycleId], [[runId], 'p1'])
      sup.thaw('p1')
      await record.reservationWrites
      const after = await store.readRun(issuePath, runId)
      t.eq('the thaw cleared it everywhere: record, reservation, run.json', [record.freezeRequested ?? null, reservation.run.freezeRequested ?? null, after.freezeRequested ?? null], [null, null, null])
      sup.active.clear()
    }

    t.section('G11 project actions: the panel refuses a committing action during the freeze; the CLI path is unchanged; a holder is drained through its lock')
    {
      const root = await sandbox()
      temps.push(root)
      const projectsDir = await temp('fg-actions-projects-')
      const issuesDir = await temp('fg-actions-issues-')
      const project = 'fixture-project'
      await fs.mkdir(path.join(projectsDir, project), { recursive: true })
      await fs.mkdir(path.join(root, 'projects'), { recursive: true })
      await fs.writeFile(path.join(root, 'projects', `${project}.yaml`), YAML.stringify({ id: project, actionEnvironment: ['ACTION_SLEEP'], actions: [{ id: 'notes', run: 'echo notes', timeoutSeconds: 10 }] }))
      await fs.writeFile(path.join(projectsDir, project, 'checkpoint.sh'), ['#!/bin/bash', '# DEVPANEL effect: commit-checkout', 'test -z "$ACTION_SLEEP" || sleep "$ACTION_SLEEP"', 'echo committed'].join(NL) + NL, { mode: 0o755 })
      const opts = { root, projectsDir, issuesDir }
      const sup = createSupervisor({ issues: { ISSUES_DIR: issuesDir, getRunHolder: async () => { throw new Error('none') }, getIssue: async () => { throw new Error('none') }, listIssues: async () => [], listProjects: async () => [{ id: project }] }, availabilityFile: path.join(issuesDir, 'availability.json'), harnessDir: path.join(issuesDir, 'harness'), projectsDir, configRoot: root })
      await sup.freeze('c11', { projects: [project], snapshotted: { repositories: [], worktrees: [] } })
      let refused = null
      try { await startProjectAction({ project, actionId: 'checkpoint', frozenFor: sup.frozenFor, ...opts }) } catch (error) { refused = [error.status, error.code] }
      t.eq('(f) panel: a commit-checkout action is refused 409 FULL_VERIFICATION_FREEZE', refused, [409, 'FULL_VERIFICATION_FREEZE'])
      t.eq('(f) and its lock is released', await fs.readFile(path.join(issuesDir, project, '.actions', '.lock'), 'utf8').catch(() => null), null)
      const plain = await startProjectAction({ project, actionId: 'notes', frozenFor: sup.frozenFor, ...opts })
      t.eq('(b) an action declaring no commit effect is admitted', (await plain.done).status, 'completed')
      process.env.ACTION_SLEEP = '1'
      let cli
      try { cli = await startProjectAction({ project, actionId: 'checkpoint', ...opts }) } finally { delete process.env.ACTION_SLEEP }
      t.eq('(g) CLI path (no frozenFor): admitted unchanged during the freeze', cli.operation.status, 'running')
      const listed = await sup.busyActions()
      t.eq('(c) while it holds its lock the cycle lists it from the lock detail', listed.map((a) => [a.project, a.kind, a.action]), [[project, 'project-action', 'checkpoint']])
      t.eq('(g) it completes as today', (await cli.done).status, 'completed')
      t.eq('and is no longer listed once it ended', await sup.busyActions(), [])
      t.eq('(g) no file beside the cycle\'s own records', await fs.readdir(path.join(issuesDir, '.verification')).catch(() => []), [])
      sup.thaw('c11')
    }
  } finally {
    if (savedBin === undefined) delete process.env.DEVPANEL_SSH_BIN; else process.env.DEVPANEL_SSH_BIN = savedBin
    await cleanupFixtures()
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
