import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startRun, resumeRun, releaseWorkspace, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { readRun, readEvents, runDir, writeRun } from '../server/runtime/store.mjs'
import { captureIntegrity, integrityChanges, readIntegrity } from '../server/runtime/integrity.mjs'
import { FENCE_STUBS, fingerprint, workspaceProjection } from '../server/runtime/fingerprint.mjs'
import { removeFenceStubs } from '../server/runtime/tooling-mounts.mjs'
import { candidateDiff } from '../server/runtime/diff.mjs'
import { integrateRun } from '../server/runtime/integrate.mjs'
import { getRun } from '../server/runs-api.mjs'
import { renderResult } from '../server/run-result-step.mjs'
import { workspaceDisposition, supportedActions } from '../server/supervisor.mjs'
import { engineFixture, leaveFenceStubs, scriptFor, simulateProcessDeath } from './fakes/fixture.mjs'

export const name = 'engine — per-turn source permissions and integrity quarantine'
const exec = promisify(execFile)
const git = (cwd, args) => exec('git', ['-C', cwd, ...args])
const start = (f) => startRun({ ...f, issue: { project: 'devpanel-project', id: f.issue.id }, deliveryProvider: f.delivery })
const rejected = async (fn) => { try { await fn(); return null } catch (e) { return e } }

export default async function (t) {
  // An auditor turn before any candidate exists is plan-and-implement's plan
  // audit; everything else runs under implementation.
  async function changedTurn ({ role = 'auditor-1', fail = false, abort = false, change, stepId = role === 'implementer' ? 'implement' : 'audit-plan-1', message = 'simulated failed turn', payload = undefined, availability = undefined }) {
    const f = await engineFixture({ playbook: stepId.startsWith('audit-plan') ? 'plan-and-implement' : 'implementation' })
    if (availability) f.availability = availability
    const original = f.fake.invoke
    let current = null
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === stepId) {
        await change(args.cwd, args, current)
        if (fail || abort) throw Object.assign(new Error(message), { name: abort ? 'AbortError' : 'Error', payload })
      }
      return original(args)
    }
    const engine = await start(f)
    current = engine
    // A terminal runtime failure is rethrown for the supervisor to record; a
    // quarantined one returns. Either way the run record is what is asserted.
    let thrown = null
    try { await engine.drive() } catch (error) { if (!fail) throw error; thrown = error }
    return { f, engine, thrown }
  }

  t.section('a coordination-only seat cannot reach the worktree by construction')
  {
    const seen = []
    const { engine } = await changedTurn({ role: 'coordinator', stepId: 'triage', change: (cwd, args, e) => { seen.push({ cwd, toolFree: args.supervisorOnly === true, workspace: e.run.workspace.path }) } })
    t.ok('its working directory is the scratch directory, not the worktree', seen[0] && seen[0].cwd !== seen[0].workspace, JSON.stringify(seen[0]))
    t.ok('and it runs tool-free', seen[0]?.toolFree === true)
    t.eq('so no whole-tree capture is taken for its turn', engine.run.steps.filter((x) => x.role === 'coordinator').length > 0 && !(await readEvents(engine.issuePath, engine.runId)).events.some((e) => e.type === 'turn-integrity' && e.role === 'coordinator'), true)
    await releaseWorkspace(engine)
  }

  t.section('a coordinator that escaped its fence is still caught at the next capture')
  {
    const { f, engine } = await changedTurn({ role: 'coordinator', stepId: 'triage',
      change: (_cwd, _args, e) => fs.writeFile(path.join(e.run.workspace.path, 'source.txt'), 'unauthorized') })
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('quarantined', run.integrity.status, 'quarantined')
    t.eq('no revision accepted', run.revisions.length, 0)
    t.eq('changed path attributed', run.integrity.latest.changes.paths, [{ path: 'source.txt', change: 'modified' }])
    t.eq('attributed to the uncaptured coordinator turn', run.integrity.latest.role, 'coordinator')
    t.eq('and the attribution says it is inferred', run.integrity.latest.attribution, 'inferred-from-uncaptured-turns')
    t.eq('partial work retained', await fs.readFile(path.join(run.workspace.path, 'source.txt'), 'utf8'), 'unauthorized')
    t.eq('delivery never attempted', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)
  }
  {
    const { f, engine } = await changedTurn({ role: 'coordinator', stepId: 'triage', fail: true,
      change: (_cwd, _args, e) => fs.writeFile(path.join(e.run.workspace.path, 'source.txt'), 'unauthorized') })
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('a failed escaping coordinator turn ends the run as a recorded failure, without a revision', [run.failure?.message, run.revisions.length], ['simulated failed turn', 0])
    t.eq('delivery never attempted', f.delivery.calls.length, 0)
    const resumed = await rejected(() => engine.resumeExecution())
    t.ok('continuing it is refused', Boolean(resumed), resumed?.message)
    await releaseWorkspace(engine)
  }

  t.section('non-writers cannot modify source before the first candidate, on success or failure')
  for (const role of ['auditor-1']) {
    for (const fail of [false, true]) {
      const { f, engine } = await changedTurn({ role, fail, stepId: role === 'coordinator' ? 'triage' : 'audit-plan-1',
        change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'unauthorized') })
      const run = await readRun(f.issuePath, engine.runId)
      t.eq(`${role}/${fail}: quarantined`, run.integrity.status, 'quarantined')
      t.eq('no first revision accepted', run.revisions.length, 0)
      t.eq('run blocked', run.blockedReason, 'recovery-required')
      t.eq('changed path attributed', run.integrity.latest.changes.paths, [{ path: 'source.txt', change: 'modified' }])
      t.eq('role attributed', run.integrity.latest.role, role)
      t.eq('partial work retained', await fs.readFile(path.join(run.workspace.path, 'source.txt'), 'utf8'), 'unauthorized')
      const count = await f.fake.ledger.invocationCount()
      await engine.drive()
      await engine.recover()
      await engine.evaluateClosure()
      t.eq('drive and recovery cannot repeat work', await f.fake.ledger.invocationCount(), count)
      t.eq('delivery never attempted', f.delivery.calls.length, 0)
      t.eq('no normal actions offered: only an integrity disposition or abandonment', supportedActions(run), ['resolve-integrity', 'abandon'])
      t.eq('even apparently unchanged quarantine is retained', workspaceDisposition(run, { unchanged: true, proven: true }).discard, false)
      const denied = await rejected(() => integrateRun({ issuePath: f.issuePath, runId: engine.runId }))
      t.ok('integration refuses quarantine', /integrity/.test(denied?.message))
      await releaseWorkspace(engine)
    }
  }

  t.section('unexpected files, deletions, executable modes and Git-only changes')
  for (const [label, change, field] of [
    ['untracked', (cwd) => fs.writeFile(path.join(cwd, 'surprise.js'), 'new source'), 'paths'],
    ['ignored', async (cwd) => { await fs.writeFile(path.join(cwd, '.gitignore'), 'hidden.js\n'); await fs.writeFile(path.join(cwd, 'hidden.js'), 'source') }, 'paths'],
    ['deleted', (cwd) => fs.rm(path.join(cwd, 'source.txt')), 'paths'],
    ['mode', (cwd) => fs.chmod(path.join(cwd, 'source.txt'), 0o755), 'paths'],
    ['index', (cwd) => git(cwd, ['update-index', '--assume-unchanged', 'source.txt']), 'index'],
    ['HEAD', (cwd) => git(cwd, ['commit', '--allow-empty', '-qm', 'unauthorized history']), 'head']
  ]) {
    const { engine } = await changedTurn({ change })
    // Private repositories (0d): the work tree's Git directory is the worker's
    // own — read-only to this seat inside the fence, never read by the host —
    // and the engine's index and HEAD are out of every seat's reach. A
    // Git-only change there is not a change to the source.
    if (engine.run.workspace.repository?.kind === 'private' && field !== 'paths') {
      t.eq(`${label}: the worker's own Git state is not the source`, engine.run.integrity.status, 'clear')
      const { stdout } = await exec('git', ['--git-dir', engine.run.workspace.gitDir, 'rev-parse', 'HEAD'])
      t.eq(`${label}: the engine's HEAD is still the base`, stdout.trim(), engine.run.workspace.baseCommit)
      await releaseWorkspace(engine)
      continue
    }
    t.eq(`${label}: quarantined`, engine.run.integrity.status, 'quarantined')
    t.ok(`${label}: change identified`, Boolean(engine.run.integrity.latest.changes[field]))
    await releaseWorkspace(engine)
  }

  t.section('the same role fence applies after a candidate exists')
  {
    const { engine, f } = await changedTurn({ stepId: 'audit-implement-1', change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'auditor patch') })
    t.eq('candidate existed before the audit', engine.run.revisions.length, 1)
    t.eq('auditor edit quarantined', engine.run.integrity.status, 'quarantined')
    t.eq('audit response not accepted', engine.run.steps.some((s) => s.stepId === 'audit-implement-1'), false)
    t.eq('checks invalidated', engine.run.checkResults, [])
    t.eq('no delivery', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)
  }

  t.section('persisted pre-turn state catches edits across process death')
  {
    const f = await engineFixture()
    const engine = await start(f)
    engine.hooks.beforeInvoke = () => { throw new Error('simulated process death') }
    await rejected(() => engine.drive())
    // The first turn is the coordinator's triage: tool-free, so its baseline is
    // the run's persisted checkpoint rather than a capture of its own.
    t.ok('first turn has a persisted baseline', Object.values(engine.run.participants).some((p) => p.pendingInvocation?.integrityBefore || (p.pendingInvocation?.integrity === 'not-applicable' && engine.run.integrity?.checkpoint)))
    // Model the process dying after a write, before any engine-side post-check.
    await fs.writeFile(path.join(engine.run.workspace.path, 'source.txt'), 'interrupted source edit')
    await simulateProcessDeath(f.issuePath)
    const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock })
    await resumed.recover()
    await rejected(() => resumed.drive())
    t.eq('the edit is caught before any working seat runs on it', resumed.run.integrity.status, 'quarantined')
    t.eq('no revision adopted', resumed.run.revisions.length, 0)
    t.eq('no working seat invoked', (await f.fake.ledger.entries()).filter((e) => e.phase === 'started' && e.role !== 'coordinator').length, 0)
    await releaseWorkspace(resumed)
  }

  t.section('tracked files under exclusions and unreadable Git state cannot disappear from coverage')
  {
    const f = await engineFixture()
    await fs.mkdir(path.join(f.projectPath, 'node_modules'))
    await fs.writeFile(path.join(f.projectPath, 'node_modules', 'tracked.js'), 'tracked dependency')
    await git(f.projectPath, ['add', '-f', 'node_modules/tracked.js'])
    await git(f.projectPath, ['commit', '-qm', 'tracked dependency'])
    const engine = await start(f)
    const before = await readIntegrity(engine.integrityDir(), 'initial')
    t.ok('tracked excluded file included', before.entries.some((e) => e.path === 'node_modules/tracked.js'))
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      // Into the worktree whatever the seat's cwd: a coordination-only seat's is
      // its scratch directory.
      await fs.writeFile(path.join(engine.run.workspace.path, 'node_modules/tracked.js'), 'changed')
      return original(args)
    }
    await engine.drive()
    t.eq('tracked excluded source change quarantined', engine.run.integrity.status, 'quarantined')
    await releaseWorkspace(engine)
  }
  t.section('submodule pointers (gitlinks) are tracked by commit, not required as files')
  {
    const f = await engineFixture()
    const pointer = '53e476982c7cfd0d051572f07d29d4650199b569'
    await git(f.projectPath, ['update-index', '--add', '--cacheinfo', `160000,${pointer},modules/vendored`])
    await git(f.projectPath, ['commit', '-qm', 'vendored module pointer'])
    await fs.mkdir(path.join(f.projectPath, 'modules/vendored'), { recursive: true })   // what a checkout leaves behind
    const engine = await start(f)
    const before = await readIntegrity(engine.integrityDir(), 'initial')
    const link = before.entries.find((e) => e.path === 'modules/vendored')
    t.eq('gitlink recorded by pointer', link?.mode, 'gitlink')
    t.ok('empty placeholder directory tolerated', (await fs.stat(path.join(engine.run.workspace.path, 'modules/vendored'))).isDirectory())
    t.ok('gitlink is not a tracked file path', !before.trackedPaths.includes('modules/vendored'))
    const again = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
    t.eq('repeat capture is stable', again.hash, before.hash)
    await engine.drive()
    t.eq('run proceeds past the pointer', engine.run.integrity.status, 'clear')
    const moved6 = pointer.replace(/^5/, '6')
    if (engine.run.workspace.repository?.kind === 'private') {
      // The seat's index cannot move a pointer: gitlinks are carried from the
      // snapshot (the engine's index), which no seat can write.
      await git(engine.run.workspace.path, ['update-index', '--cacheinfo', `160000,${moved6},modules/vendored`])
      const unmoved = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
      t.eq('a pointer moved in the worker index is not taken from it', unmoved.entries.find((e) => e.path === 'modules/vendored').contentHash, link.contentHash)
      await exec('git', ['--git-dir', engine.run.workspace.gitDir, '--work-tree', engine.run.workspace.path, 'update-index', '--cacheinfo', `160000,${moved6},modules/vendored`])
    } else await git(engine.run.workspace.path, ['update-index', '--cacheinfo', `160000,${moved6},modules/vendored`])
    const moved = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
    t.ok('pointer change is a path change', moved.entries.find((e) => e.path === 'modules/vendored').contentHash !== link.contentHash)
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await changedTurn({ change: (cwd) => fs.writeFile(path.join(cwd, '.git'), 'invalid metadata') })
    t.eq('unverifiable Git state quarantined', engine.run.integrity.status, 'quarantined')
    // With the git directory recorded at provisioning (engine-git.mjs) the
    // capture no longer fails on the invalid entry; it names the replacement.
    t.ok('explicit integrity failure', /\.git entry was replaced|cannot verify source integrity/.test(engine.run.integrity.latest.reason), engine.run.integrity.latest.reason)
    // Restore the worktree pointer solely so the fixture can be removed by Git.
    const before = await readIntegrity(engine.integrityDir(), engine.run.integrity.latest.before)
    await fs.writeFile(path.join(engine.run.workspace.path, '.git'), `gitdir: ${before.repository.gitDir}\n`)
    await releaseWorkspace(engine)
  }

  t.section('read-only Git inspection and scratch output remain permitted')
  {
    const f = await engineFixture()
    const original = f.fake.invoke
    const policies = []
    f.fake.invoke = async (args) => {
      policies.push({ role: args.meta.role, writesCode: args.tooling?.writesCode ?? false, toolFree: args.supervisorOnly === true })
      await fs.writeFile(path.join(args.scratchDir, `${args.meta.invocationId}.txt`), 'notes')
      // Git inspection is a working seat's; a tool-free coordinator has neither shell nor worktree.
      if (!args.supervisorOnly) await git(args.cwd, ['status', '--porcelain'])
      return original(args)
    }
    const engine = await start(f)
    t.ok('baseline exists before any invocation', Boolean(await readIntegrity(engine.integrityDir(), 'initial')))
    t.eq('no candidate is invented for the baseline', engine.run.revisions.length, 0)
    await engine.drive()
    t.eq('run completes', engine.run.outcome, 'resolved')
    t.ok('implementer receives write permission', policies.some((p) => p.role === 'implementer' && p.writesCode))
    t.ok('all other roles are read-only', policies.filter((p) => p.role !== 'implementer').every((p) => !p.writesCode))
    const { events } = await readEvents(f.issuePath, engine.runId)
    // Tool-free coordinator turns take no capture of their own; every turn that
    // could reach the worktree does.
    const working = engine.run.steps.filter((x) => !policies.find((p) => p.role === x.role)?.toolFree)
    t.eq('every completed working invocation has an integrity event', events.filter((e) => e.type === 'turn-integrity').length, working.length)
    t.ok('and the tool-free ones are the coordinator\'s', engine.run.steps.filter((x) => !working.includes(x)).every((x) => x.role === 'coordinator'))
    await releaseWorkspace(engine)
  }

  t.section('a quota exhaustion that integrity quarantines still reaches the availability store')
  {
    const calls = []
    const availability = { recordExhausted: async (x) => { calls.push(x); return { modelId: x.modelId, until: 'later' } } }
    const { engine } = await changedTurn({ role: 'implementer', fail: true, availability,
      message: 'claude exited 1', payload: { is_error: true, result: "You've hit your monthly spend limit. Switch to another model to continue.", total_cost_usd: 6.01 },
      change: async (cwd) => { await fs.writeFile(path.join(cwd, 'source.txt'), 'partial') } })
    t.eq('quarantined', engine.run.integrity.status, 'quarantined')
    t.eq('classified from the runtime payload', engine.run.failures.at(-1)?.class, 'quota')
    t.eq('the model is recorded exhausted host-wide', calls.map((c) => c.modelId), [engine.snapshot.participants.implementer.model.id])
    t.eq('the availability record is on the failure', engine.run.failures.at(-1)?.availability?.until, 'later')
    t.eq('the turn\'s cost is on the record', engine.run.failures.at(-1)?.costUsd, 6.01)
    t.eq('persisted', (await readRun(engine.issuePath, engine.runId)).failures.length, 1)
  }

  t.section('successful authors may edit and stage; failed and cancelled authors require disposition')
  for (const mode of ['completed', 'failed', 'cancelled']) {
    const { f, engine } = await changedTurn({ role: 'implementer', fail: mode === 'failed', abort: mode === 'cancelled',
      change: async (cwd) => { await fs.writeFile(path.join(cwd, 'source.txt'), 'useful partial work'); await git(cwd, ['add', 'source.txt']) } })
    if (mode === 'completed') {
      t.eq('successful author accepted', engine.run.outcome, 'resolved')
      t.ok('candidate recorded', engine.run.revisions.length > 0)
    } else {
      t.eq(`${mode}: quarantine`, engine.run.integrity.status, 'quarantined')
      t.eq('failed work did not become a candidate', engine.run.revisions.length, 0)
      t.eq('outcome recorded', engine.run.integrity.latest.outcome, mode)
      if (mode === 'failed') {
        t.eq('the quarantined attempt is on the failure record', engine.run.failures.map((x) => `${x.class}:${x.quarantined}:${x.retried}`), ['runtime:true:false'])
        t.eq('and names the cause of the recovery', engine.run.recovery?.cause?.message, 'simulated failed turn')
      } else t.eq('a cancellation is not a failure', engine.run.failures.length, 0)
      await simulateProcessDeath(f.issuePath)
      const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, projectPath: f.projectPath, deliveryProvider: f.delivery })
      await resumed.recover()
      t.eq('quarantine survives restart', resumed.run.integrity.status, 'quarantined')
      const current = await captureIntegrity(resumed.run.workspace, { clock: f.clock })
      t.ok('stale disposition rejected', await rejected(() => resumed.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: 'stale', actor: 'operator', reason: 'inspected' })))
      t.ok('false restoration rejected', await rejected(() => resumed.resolveIntegrity({ disposition: 'restored', expectedStateHash: current.hash, actor: 'operator', reason: 'inspected' })))
      await resumed.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: current.hash, actor: 'operator', reason: 'retain partial work for author retry' })
      t.eq('explicit acceptance clears quarantine', resumed.run.integrity.status, 'clear')
      t.eq('decision persisted', (await readRun(f.issuePath, engine.runId)).integrity.dispositions.at(-1).actor, 'operator')
      // The retry is a fresh invocation and must still produce a reviewed candidate.
      // Restore the unmodified fake adapter for the retry.
      const script = scriptFor()
      f.fake.invoke = async (args) => ({ response: script({ ...args.meta, prompt: args.prompt }), session: { id: 'recovered-session' }, outcome: 'completed' })
      await resumed.drive()
      t.eq('recovered partial work can complete through normal review', resumed.run.outcome, 'resolved')
      await releaseWorkspace(resumed)
      continue
    }
    await releaseWorkspace(engine)
  }

  t.section('an author whose turn failed on a rotated credential keeps its partial edits and is retried once')
  for (const failures of [1, 2, 'retry-used']) {
    const f = await engineFixture({ playbook: 'implementation' })
    const original = f.fake.invoke
    let failed = 0
    // What the claude adapter throws when another process replaced the shared
    // credential file during the turn (harness/claude.mjs credentialChange).
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement' && failed < (failures === 'retry-used' ? 2 : failures)) {
        failed++
        // 'retry-used': the first rotation leaves nothing and spends the one retry.
        if (failures !== 'retry-used' || failed === 2) await fs.writeFile(path.join(args.cwd, 'source.txt'), `partial ${failed}`)
        throw Object.assign(new Error('claude exited 1\nauthentication_failed: Failed to authenticate: OAuth session expired and could not be refreshed'), { credentials: { changed: true, how: 'replaced' } })
      }
      return original(args)
    }
    const engine = await start(f)
    let thrown = null
    try { await engine.drive() } catch (error) { thrown = error }
    const first = engine.run.failures[0]
    t.eq(`${failures}: the first failure is a retried transient`, `${first?.class}:${first?.retried}`, 'transient:true')
    if (failures === 'retry-used') {
      t.eq('edits after the one retry was spent are not accepted', engine.run.failures[1]?.partialAccepted ?? null, null)
      t.eq('they quarantine instead', `${engine.run.integrity.status}:${engine.run.blockedReason}`, 'quarantined:recovery-required')
      await releaseWorkspace(engine)
      continue
    }
    t.eq('its partial edits are kept for the retry, not quarantined', first?.partialAccepted?.reason, 'credential-rotated')
    t.eq('naming the kept paths', first?.partialAccepted?.paths, ['source.txt'])
    if (failures === 1) {
      t.eq('the run went on without a person', `${engine.run.integrity.status}:${engine.run.outcome}:${thrown?.message ?? null}`, 'clear:resolved:null')
      t.eq('and the retry started from the partial edits', await fs.readFile(path.join(engine.run.workspace.path, 'source.txt'), 'utf8'), 'partial 1')
      t.ok('the acceptance is on the turn\'s integrity record', (await readEvents(engine.issuePath, engine.runId)).events.some((e) => e.type === 'turn-integrity' && e.partialAccepted?.reason === 'credential-rotated'))
    } else {
      t.eq('a second failure quarantines as any other', `${engine.run.integrity.status}:${engine.run.blockedReason}`, 'quarantined:recovery-required')
      t.eq('and is not retried again', engine.run.failures.at(-1)?.retried, false)
    }
    await releaseWorkspace(engine)
  }

  t.section('unauthorized work must be restored or abandoned, never accepted as partial author work')
  {
    const { engine } = await changedTurn({ change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'bad') })
    let state = await captureIntegrity(engine.run.workspace, { clock: engine.clock })
    t.ok('cannot adopt an auditor edit', await rejected(() => engine.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: state.hash, actor: 'operator', reason: 'keep' })))
    await fs.writeFile(path.join(engine.run.workspace.path, 'source.txt'), 'original\n')
    state = await captureIntegrity(engine.run.workspace, { clock: engine.clock })
    await engine.resolveIntegrity({ disposition: 'restored', expectedStateHash: state.hash, actor: 'operator', reason: 'restored original source' })
    t.eq('verified restoration clears quarantine', engine.run.integrity.status, 'clear')
    await releaseWorkspace(engine)
  }

  const onDisk = async (root, paths = [...FENCE_STUBS, '.claude']) => (await Promise.all(paths.map((rel) => fs.lstat(path.join(root, rel)).then(() => rel, () => null)))).filter(Boolean)
  const REAL = '{"mcpServers":{}}\n'
  // The candidate's patch, recomputed by delivery from what is on disk now.
  const patchOf = async (engine) => {
    const ws = engine.run.workspace
    const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: engine.run.revisions.at(-1).fingerprint, fingerprint: null, baseCommit: ws.baseCommit, baseline: engine.baseline, workspacePath: ws.path, workspace: ws, runDir: runDir(engine.issuePath, engine.runId) })
    return { receipt, text: await fs.readFile(path.join(runDir(engine.issuePath, engine.runId), receipt.artifactRef), 'utf8') }
  }

  t.section('fence stubs: a killed or failed turn that left only stubs is not quarantined, and they are removed')
  for (const mode of ['cancelled', 'failed']) {
    const { engine } = await changedTurn({ role: 'implementer', abort: mode === 'cancelled', fail: mode === 'failed', change: (cwd) => leaveFenceStubs(cwd) })
    t.eq(`${mode}: not quarantined`, engine.run.integrity.status, 'clear')
    t.eq(`${mode}: no change counted`, engine.run.integrity.latest.changes.paths, [])
    t.eq(`${mode}: nothing is left, the directory they needed included`, await onDisk(engine.run.workspace.path), [])
    t.eq(`${mode}: the report names what went`, [...engine.run.integrity.latest.fenceStubsRemoved].sort(), [...FENCE_STUBS.map((rel) => rel.replace(/\/$/, '')), '.claude'].sort())
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: a turn killed before any cleanup could run, the owner lost with it')
  {
    const f = await engineFixture()
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'the real change\n')
      return original(args)
    }
    const first = await start(f)
    first.hooks.beforeInvoke = async (e) => {
      if (!e.run.participants.implementer?.pendingInvocation) return
      delete e.hooks.beforeInvoke
      throw new Error('simulated process death')
    }
    t.ok('the owner dies in the turn', await rejected(() => first.drive()))
    await leaveFenceStubs(first.run.workspace.path)
    await simulateProcessDeath(f.issuePath)
    const stored = await readRun(f.issuePath, first.runId)
    Object.assign(stored, { status: 'blocked', outcome: 'unresolved', blockedReason: 'recovery-required', recovery: { required: true, ownerLost: true, reason: 'the run was live when its owner disappeared', detectedAt: f.clock.iso(), lastActivityAt: f.clock.iso() } })
    if (stored.workspace?.state === 'active') stored.workspace.state = 'retained'
    await writeRun(f.issuePath, first.runId, stored)
    const engine = await resumeRun({ issuePath: f.issuePath, runId: first.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
    const outcome = await engine.recoverOwnerLoss()
    t.ok('recovery resumes it: stubs alone do not quarantine', outcome.resumed, outcome.reason)
    t.eq('not quarantined', engine.run.integrity.status, 'clear')
    t.eq('recovery removed them', await onDisk(engine.run.workspace.path), [])
    await engine.drive()
    t.eq('the run completes', engine.run.outcome, 'resolved')
    // Worse than the sweep ever leaves it: they stand again as the revision is read.
    const ws = engine.run.workspace
    const revision = engine.run.revisions.at(-1).fingerprint
    await leaveFenceStubs(ws.path)
    const projected = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(ws) })
    t.eq('the fingerprint does not count them', projected.fingerprint, revision)
    const checkpoint = await readIntegrity(engine.integrityDir(), engine.run.integrity.checkpoint)
    t.eq('nor does the integrity capture', integrityChanges(checkpoint, await captureIntegrity(ws, { clock: engine.clock, trackedPaths: checkpoint.trackedPaths })).paths, [])
    const diff = await candidateDiff(ws.path, { baseCommit: ws.baseCommit, gitDir: ws.gitDir, fenceStubs: ws.fenceStubs })
    t.ok('the auditor\'s diff holds the change', diff.text.includes('the real change'))
    t.eq('and none of them', FENCE_STUBS.filter((rel) => diff.text.includes(rel)), [])
    const { receipt, text } = await patchOf(engine)
    t.eq('the patch reconstructs the revision', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    t.ok('the patch holds the change', text.includes('the real change'))
    t.eq('and none of them', FENCE_STUBS.filter((rel) => text.includes(rel)), [])
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: what was there before the turn stays as it was')
  for (const mode of ['completed', 'cancelled']) {
    const f = await engineFixture()
    await fs.mkdir(path.join(f.projectPath, '.claude'))
    await fs.writeFile(path.join(f.projectPath, '.mcp.json'), REAL)
    await fs.writeFile(path.join(f.projectPath, '.claude', 'settings.json'), '{}\n')
    await fs.writeFile(path.join(f.projectPath, '.profile'), '')
    await fs.writeFile(path.join(f.projectPath, '.idea'), '')
    await git(f.projectPath, ['add', '-f', '.mcp.json', '.claude/settings.json', '.profile', '.idea'])
    await git(f.projectPath, ['commit', '-qm', 'config the project owns'])
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement') {
        await leaveFenceStubs(args.cwd)
        if (mode === 'cancelled') throw Object.assign(new Error('stopped'), { name: 'AbortError' })
      }
      return original(args)
    }
    const engine = await start(f)
    const root = engine.run.workspace.path
    await engine.drive()
    t.eq(`${mode}: not quarantined`, engine.run.integrity.status, 'clear')
    t.eq(`${mode}: a file with content keeps it`, await fs.readFile(path.join(root, '.mcp.json'), 'utf8'), REAL)
    t.eq(`${mode}: and so does its neighbour`, await fs.readFile(path.join(root, '.claude', 'settings.json'), 'utf8'), '{}\n')
    t.eq(`${mode}: a tracked empty file stays`, (await fs.stat(path.join(root, '.profile'))).size, 0)
    t.eq(`${mode}: only what the turn left is gone`, await onDisk(root), ['.idea', '.mcp.json', '.profile', '.claude/settings.json', '.claude'])
    const fp = await fingerprint(root, { baseCommit: engine.run.workspace.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(engine.run.workspace) })
    t.eq(`${mode}: a tracked empty file is still the base's`, fp.entries.find((e) => e.path === '.profile')?.status, 'unchanged')
    await fs.rm(path.join(root, '.profile'))
    const removed = await fingerprint(root, { baseCommit: engine.run.workspace.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(engine.run.workspace) })
    t.eq(`${mode}: and deleting it is a deletion`, removed.entries.find((e) => e.path === '.profile')?.status, 'deleted')
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: a real file at one of those paths is still a change')
  {
    const { engine } = await changedTurn({ role: 'implementer', change: async (cwd) => { await leaveFenceStubs(cwd); await fs.chmod(path.join(cwd, '.mcp.json'), 0o644); await fs.writeFile(path.join(cwd, '.mcp.json'), REAL) } })
    const report = (await readEvents(engine.issuePath, engine.runId)).events.find((e) => e.type === 'turn-integrity' && e.role === 'implementer')
    t.eq('the integrity check counts it, and only it', report.changes.paths, [{ path: '.mcp.json', change: 'added' }])
    t.eq('the rest of the stubs are gone and it is not', await onDisk(engine.run.workspace.path), ['.mcp.json'])
    const ws = engine.run.workspace
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(ws) })
    t.eq('the fingerprint holds it', fp.entries.filter((e) => e.status !== 'unchanged').map((e) => [e.path, e.status]), [['.mcp.json', 'added']])
    t.eq('that is the revision', fp.fingerprint, engine.run.revisions.at(-1).fingerprint)
    t.ok('the auditor\'s diff shows it', (await candidateDiff(ws.path, { baseCommit: ws.baseCommit, gitDir: ws.gitDir, fenceStubs: ws.fenceStubs })).text.includes('mcpServers'))
    const { receipt, text } = await patchOf(engine)
    t.eq('the patch reconstructs it', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    t.ok('the patch holds it', text.includes('mcpServers') && text.includes('b/.mcp.json'))
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await changedTurn({ stepId: 'audit-implement-1', change: (cwd) => fs.writeFile(path.join(cwd, '.mcp.json'), REAL) })
    t.eq('from an auditor it quarantines', engine.run.integrity.status, 'quarantined')
    t.eq('naming the path', engine.run.integrity.latest.changes.paths, [{ path: '.mcp.json', change: 'added' }])
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await changedTurn({ role: 'implementer', abort: true, change: async (cwd) => { await fs.writeFile(path.join(cwd, '.mcp.json'), REAL); await leaveFenceStubs(cwd) } })
    t.eq('from a killed author it is partial work to dispose of', engine.run.integrity.status, 'quarantined')
    t.eq('the report names only it', engine.run.integrity.latest.changes.paths, [{ path: '.mcp.json', change: 'added' }])
    t.eq('it is retained, the stubs are not', await onDisk(engine.run.workspace.path), ['.mcp.json'])
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: an empty file the author made is real, on every route a stub is left out of')
  {
    const { engine } = await changedTurn({ role: 'implementer', change: async (cwd) => { await fs.writeFile(path.join(cwd, '.mcp.json'), ''); await leaveFenceStubs(cwd) } })
    const ws = engine.run.workspace
    const report = (await readEvents(engine.issuePath, engine.runId)).events.find((e) => e.type === 'turn-integrity' && e.role === 'implementer')
    t.eq('the integrity check counts it, and only it', report.changes.paths, [{ path: '.mcp.json', change: 'added' }])
    t.eq('the sweep takes the stubs and leaves it', await onDisk(ws.path), ['.mcp.json'])
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(ws) })
    t.eq('the fingerprint holds it', fp.entries.filter((e) => e.status !== 'unchanged').map((e) => [e.path, e.status]), [['.mcp.json', 'added']])
    t.eq('that is the revision', fp.fingerprint, engine.run.revisions.at(-1).fingerprint)
    t.ok('the auditor\'s diff names it', (await candidateDiff(ws.path, { baseCommit: ws.baseCommit, gitDir: ws.gitDir, fenceStubs: ws.fenceStubs })).text.includes('.mcp.json'))
    const { receipt, text } = await patchOf(engine)
    t.eq('the patch reconstructs it', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    t.ok('the patch holds it', text.includes('b/.mcp.json'))
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await changedTurn({ stepId: 'audit-implement-1', change: (cwd) => fs.writeFile(path.join(cwd, '.mcp.json'), '') })
    t.eq('from an auditor it quarantines', engine.run.integrity.latest.changes?.paths, [{ path: '.mcp.json', change: 'added' }])
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: an incomplete set, a kill inside the sandbox\'s setup or cleanup, still counts for nothing')
  const leaveIncomplete = async (root, keep) => {
    await leaveFenceStubs(root)
    for (const rel of FENCE_STUBS) if (!rel.endsWith('/') && !keep(rel)) await fs.rm(path.join(root, rel))
  }
  for (const [kill, keep] of [['setup', (rel) => ['.mcp.json', '.claude/agents'].includes(rel)], ['cleanup', (rel) => rel !== '.zshrc']]) {
    for (const mode of ['completed', 'cancelled', 'failed']) {
      const { engine } = await changedTurn({ role: 'implementer', abort: mode === 'cancelled', fail: mode === 'failed', change: (cwd) => leaveIncomplete(cwd, keep) })
      const ws = engine.run.workspace
      t.eq(`${kill}/${mode}: not quarantined`, engine.run.integrity.status, 'clear')
      t.eq(`${kill}/${mode}: the sweep leaves nothing`, await onDisk(ws.path), [])
      const fingerprintNow = () => fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(ws) })
      const clean = (await fingerprintNow()).fingerprint
      // They stand again for the readings a sweep does not get ahead of.
      await leaveIncomplete(ws.path, keep)
      const checkpoint = await readIntegrity(engine.integrityDir(), engine.run.integrity.checkpoint)
      t.eq(`${kill}/${mode}: the integrity capture does not count them`, integrityChanges(checkpoint, await captureIntegrity(ws, { clock: engine.clock, trackedPaths: checkpoint.trackedPaths })).paths, [])
      t.eq(`${kill}/${mode}: nor the fingerprint`, (await fingerprintNow()).fingerprint, clean)
      await fs.writeFile(path.join(ws.path, 'source.txt'), 'a real change\n')
      const diff = await candidateDiff(ws.path, { baseCommit: ws.baseCommit, gitDir: ws.gitDir, fenceStubs: ws.fenceStubs })
      t.eq(`${kill}/${mode}: nor the auditor's diff`, FENCE_STUBS.filter((rel) => diff.text.includes(rel)), [])
      const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: (await fingerprintNow()).fingerprint, fingerprint: null, baseCommit: ws.baseCommit, baseline: engine.baseline, workspacePath: ws.path, workspace: ws, runDir: runDir(engine.issuePath, engine.runId) })
      const patch = await fs.readFile(path.join(runDir(engine.issuePath, engine.runId), receipt.artifactRef), 'utf8')
      t.eq(`${kill}/${mode}: the patch reconstructs`, receipt.reconstruction.verified, true, receipt.reconstruction.detail)
      t.ok(`${kill}/${mode}: holding the change`, patch.includes('a real change'))
      t.eq(`${kill}/${mode}: and none of them`, FENCE_STUBS.filter((rel) => patch.includes(rel)), [])
      await removeFenceStubs(ws.path, ws.fenceStubs, [])
      t.eq(`${kill}/${mode}: and a sweep takes them`, await onDisk(ws.path), [])
      await releaseWorkspace(engine)
    }
  }

  t.section('fence stubs: the accepted limit, a read-only empty file an author made reads as a stub')
  for (const mode of ['completed', 'cancelled', 'failed']) {
    const { engine } = await changedTurn({ role: 'implementer', abort: mode === 'cancelled', fail: mode === 'failed', change: (cwd) => fs.writeFile(path.join(cwd, '.gitmodules'), '', { mode: 0o444 }) })
    t.eq(`${mode}: it is not counted`, engine.run.integrity.status, 'clear')
    t.eq(`${mode}: and is removed`, await onDisk(engine.run.workspace.path), [])
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: a writable empty file alone, content, and a path the base holds stay changes or stay put')
  {
    const { engine } = await changedTurn({ role: 'implementer', abort: true, change: (cwd) => fs.writeFile(path.join(cwd, '.gitmodules'), '') })
    t.eq('a writable empty file from a killed author is partial work', engine.run.integrity.latest.changes.paths, [{ path: '.gitmodules', change: 'added' }])
    t.eq('and it stays', await onDisk(engine.run.workspace.path), ['.gitmodules'])
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await changedTurn({ role: 'implementer', abort: true, change: (cwd) => fs.writeFile(path.join(cwd, '.gitmodules'), '[real]\n', { mode: 0o444 }) })
    t.eq('a read-only file with content is a change', engine.run.integrity.latest.changes.paths, [{ path: '.gitmodules', change: 'added' }])
    t.eq('and it stays', await onDisk(engine.run.workspace.path), ['.gitmodules'])
    await releaseWorkspace(engine)
  }
  {
    const f = await engineFixture()
    await fs.writeFile(path.join(f.projectPath, '.profile'), '')
    await git(f.projectPath, ['add', '-f', '.profile'])
    await git(f.projectPath, ['commit', '-qm', 'an empty file the base holds'])
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement') await fs.chmod(path.join(args.cwd, '.profile'), 0o444)
      return original(args)
    }
    const engine = await start(f)
    await engine.drive()
    const ws = engine.run.workspace
    t.eq('a path the base holds is left, read-only and empty', [engine.run.integrity.status, await onDisk(ws.path)], ['clear', ['.profile']])
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(ws) })
    t.eq('and is still the base\'s', fp.entries.find((e) => e.path === '.profile')?.status, 'unchanged')
    await fs.rm(path.join(ws.path, '.profile'))
    const removed = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline: engine.baseline, clock: engine.clock, projection: workspaceProjection(ws) })
    t.eq('deleting it is a deletion', removed.entries.find((e) => e.path === '.profile')?.status, 'deleted')
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: overlapping seats, the stub of the first seen by the second')
  {
    const f = await engineFixture()
    await fs.writeFile(path.join(f.projectPath, '.idea'), '')
    await git(f.projectPath, ['add', '-f', '.idea'])
    await git(f.projectPath, ['commit', '-qm', 'an empty file the project owns'])
    const engine = await start(f)
    await engine.drive()
    const root = engine.run.workspace.path
    const first = { invocationId: 'first' }
    t.ok('the first seat begins', await engine.beginIntegrity('auditor-1', first))
    engine.run.participants['auditor-1'].pendingInvocation = first
    await leaveFenceStubs(root)
    const second = { invocationId: 'second' }
    t.ok('the second begins, its seat fenced beside the stubs', await engine.beginIntegrity('implementer', second))
    engine.run.participants.implementer.pendingInvocation = second
    t.eq('it does not take them for what it received', second.fenceStubsPresent, ['.idea'])
    t.eq('the first to end leaves them to the other', await engine.sweepFenceStubs(first), [])
    t.ok('the last to end removes them', (await engine.sweepFenceStubs(second)).includes('.gitmodules'))
    t.eq('only what was there before either began stays', await onDisk(root), ['.idea'])
    engine.run.participants['auditor-1'].pendingInvocation = null
    engine.run.participants.implementer.pendingInvocation = null
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: removal stops at a link, at content, and while another seat is still running')
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-stubs-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-stubs-outside-'))
    await fs.symlink(outside, path.join(root, '.claude'))
    await fs.mkdir(path.join(root, '.vscode'))
    await fs.writeFile(path.join(root, '.vscode', 'settings.json'), '{}\n')
    await fs.mkdir(path.join(root, '.idea'))
    await fs.writeFile(path.join(root, '.profile'), '')
    await leaveFenceStubs(root)
    t.eq('only the stubs go: not a directory the list names as a file, nor a writable empty file', await removeFenceStubs(root, FENCE_STUBS, []), ['.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.mcp.json', '.ripgreprc', '.zprofile', '.zshrc'])
    t.ok('nothing is removed through the link', await fs.lstat(path.join(outside, 'agents')).then(() => true, () => false))
    t.eq('a directory with content stays', await fs.readFile(path.join(root, '.vscode', 'settings.json'), 'utf8'), '{}\n')
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })

    const { engine } = await changedTurn({ role: 'implementer', change: () => {} })
    const running = { invocationId: 'still-running', fenceStubsPresent: [] }
    engine.run.participants['auditor-1'].pendingInvocation = running
    await leaveFenceStubs(engine.run.workspace.path)
    t.eq('a seat ending beside a running one leaves them', await engine.sweepFenceStubs({ invocationId: 'ended-first', fenceStubsPresent: [] }), [])
    t.eq('still there', (await onDisk(engine.run.workspace.path)).length, FENCE_STUBS.length + 1)
    t.ok('the last to end removes them', (await engine.sweepFenceStubs(running)).includes('.mcp.json'))
    t.eq('gone', await onDisk(engine.run.workspace.path), [])
    engine.run.participants['auditor-1'].pendingInvocation = null
    await releaseWorkspace(engine)
  }

  t.section('fence stubs: the report names what stands after the sweep, and the run keeps the account across turns')
  {
    const f = await engineFixture()
    await fs.writeFile(path.join(f.projectPath, '.profile'), '')
    await git(f.projectPath, ['add', '-f', '.profile'])
    await git(f.projectPath, ['commit', '-qm', 'an empty file the base holds'])
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement') await fs.chmod(path.join(args.cwd, '.profile'), 0o444)
      return original(args)
    }
    const engine = await start(f)
    await engine.drive()
    const root = engine.run.workspace.path
    const stub = (rel) => fs.writeFile(path.join(root, rel), '', { mode: 0o444 })
    const turn = async (role, invocationId, before, during) => {
      const pending = { invocationId }
      await before?.()
      t.ok(`${invocationId} begins`, await engine.beginIntegrity(role, pending))
      await during?.()
      t.ok(`${invocationId} ends clear`, await engine.endIntegrity(role, pending, 'completed'))
      return readIntegrity(engine.integrityDir(), `${invocationId}-after-report`)
    }
    const clean = await turn('implementer', 'clean')
    t.eq('nothing to name: both fields absent, a read-only empty file the base holds included', [Object.hasOwn(clean, 'fenceStubsLeft'), Object.hasOwn(clean, 'fenceStubsRemoved')], [false, false])

    const kept = await turn('implementer', 'kept', () => stub('.gitmodules'), () => stub('.mcp.json'))
    t.eq('a path found before the turn is named as left', kept.fenceStubsLeft, ['.gitmodules'])
    t.eq('and the one the turn made as removed', kept.fenceStubsRemoved, ['.mcp.json'])
    t.ok('it is still on disk', await fs.lstat(path.join(root, '.gitmodules')).then(() => true, () => false))
    await fs.rm(path.join(root, '.gitmodules'))

    const unlink = fs.unlink
    fs.unlink = async (file) => {
      if (file.endsWith('.idea')) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      return unlink(file)
    }
    let failed
    try {
      failed = await turn('implementer', 'failed', null, () => Promise.all(['.idea', '.bashrc'].map(stub)))
    } finally { fs.unlink = unlink }
    t.eq('a failed removal is named as left', failed.fenceStubsLeft, ['.idea'])
    t.eq('and not as removed', failed.fenceStubsRemoved, ['.bashrc'])
    await fs.rm(path.join(root, '.idea'))

    const running = { invocationId: 'running', fenceStubsPresent: ['.profile'] }
    engine.run.participants['auditor-1'].pendingInvocation = running
    const deferred = await turn('implementer', 'deferred', null, () => stub('.zshrc'))
    t.eq('a sweep left to a running seat says so', [deferred.fenceStubsLeft, deferred.fenceSweepDeferred, Object.hasOwn(deferred, 'fenceStubsRemoved')], [['.zshrc'], true, false])
    running.integrityBefore = 'deferred-after'
    t.ok('the running seat ends clear', await engine.endIntegrity('auditor-1', running, 'completed'))
    engine.run.participants['auditor-1'].pendingInvocation = null
    const last = await readIntegrity(engine.integrityDir(), 'running-after-report')
    t.eq('its report says what went', [last.fenceStubsRemoved, Object.hasOwn(last, 'fenceStubsLeft')], [['.zshrc'], false])

    const endings = async (id) => (await readEvents(f.issuePath, engine.runId)).events.filter((e) => e.type === 'turn-integrity' && e.invocationId === id)
    const late = { invocationId: 'late' }
    const silent = { invocationId: 'silent' }
    const partial = { invocationId: 'partial', cursor: { recordsRevision: true } }
    for (const pending of [late, silent, partial]) t.ok(`${pending.invocationId} begins`, await engine.beginIntegrity('implementer', pending))
    await stub('.ripgreprc')
    const { latest, checkpoint } = engine.run.integrity
    engine.run.integrity.status = 'quarantined'
    t.eq('a turn ending in a quarantined run is not accepted', await engine.endIntegrity('implementer', late, 'completed'), false)
    const [ended] = await endings('late')
    const lateReport = await readIntegrity(engine.integrityDir(), `${ended.after}-report`)
    t.eq('it writes its report, naming its paths', [lateReport.fenceStubsRemoved, Object.hasOwn(lateReport, 'fenceStubsLeft')], [['.ripgreprc'], false])
    t.eq('which reads as quarantined', [lateReport.status, lateReport.reason], ['quarantined', 'the run was already quarantined when this turn ended; nothing from it is accepted'])
    t.eq('and lifts nothing', [engine.run.integrity.status, engine.run.integrity.latest, engine.run.integrity.checkpoint], ['quarantined', latest, checkpoint])
    t.eq('ending again with nothing new adds no report', [await engine.endIntegrity('implementer', late, 'completed'), (await endings('late')).length], [false, 1])
    t.eq('with nothing to name the turn is still not accepted', await engine.endIntegrity('implementer', silent, 'completed'), false)
    const [silentEnd] = await endings('silent')
    t.eq('and still has a report, both fields absent', [silentEnd.status, Object.hasOwn(silentEnd, 'fenceStubsLeft'), Object.hasOwn(silentEnd, 'fenceStubsRemoved')], ['quarantined', false, false])
    await fs.writeFile(path.join(root, 'partial.txt'), 'partial\n')
    t.eq('a killed author\'s partial work is not accepted either', await engine.endIntegrity('implementer', partial, 'failed', 'stopped', { acceptPartial: 'output-limit' }), false)
    const [partialEnd] = await endings('partial')
    t.eq('its report accepts nothing', [partialEnd.status, Object.hasOwn(partialEnd, 'partialAccepted')], ['quarantined', false])
    engine.run.integrity.latest = { ...latest, invocationId: 'own' }
    t.eq('the quarantine\'s own turn, ended again with nothing new, adds no report', [await engine.endIntegrity('implementer', { invocationId: 'own' }, 'completed'), (await endings('own')).length], [false, 0])
    engine.run.integrity.latest = latest
    await fs.rm(path.join(root, 'partial.txt'))
    const storedQuarantine = (await readRun(f.issuePath, engine.runId)).integrity
    t.eq('the stored run is still quarantined', storedQuarantine.status, 'quarantined')
    engine.run.integrity.status = 'clear'

    const stored = await readRun(f.issuePath, engine.runId)
    const account = stored.integrity.fenceStubs.filter((e) => ['kept', 'failed', 'deferred', 'running', 'late'].includes(e.invocationId))
    t.eq('the stored account holds every such turn, not only the latest', account.map((e) => e.invocationId), ['kept', 'failed', 'deferred', 'running', 'late'])
    t.eq('the turn in the quarantined run included', account.at(-1).fenceStubsRemoved, ['.ripgreprc'])
    t.eq('a turn with nothing to name adds nothing', stored.integrity.fenceStubs.some((e) => e.invocationId === 'clean'), false)
    const detail = await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id })
    t.eq('the run detail carries it', detail.integrity.fenceStubs, stored.integrity.fenceStubs)
    const md = renderResult(stored, {})
    for (const rel of ['.gitmodules', '.mcp.json', '.idea', '.bashrc', '.zshrc', '.ripgreprc']) t.ok(`result.md names ${rel}`, md.split('## Fence stubs')[1]?.includes(`\`${rel}\``))
    t.ok('as it last stood', md.includes('`.idea`: still there at the end of implementer\'s turn') && md.includes('`.zshrc`: removed at the end of auditor-1\'s turn'))
    t.ok('a run with nothing to name has no such section', !renderResult({ ...stored, integrity: { status: 'clear' } }, {}).includes('Fence stubs'))
    await releaseWorkspace(engine)
  }

  t.section('offline inspection and explicit abandonment are reviewable and retain work')
  {
    const { f, engine } = await changedTurn({ role: 'implementer', fail: true, change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'partial') })
    const cli = fileURLToPath(new URL('../server/runtime/integrity-cli.mjs', import.meta.url))
    const inspected = JSON.parse((await exec(process.execPath, [cli, f.issuePath, engine.runId])).stdout)
    t.eq('CLI names changed source', inspected.changes.paths[0].path, 'source.txt')
    await simulateProcessDeath(f.issuePath)
    await exec(process.execPath, [cli, f.issuePath, engine.runId, '--disposition', 'abandon', '--state', inspected.stateHash, '--actor', 'test operator', '--reason', 'preserve for manual investigation'])
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('abandonment recorded', run.integrity.status, 'abandoned')
    t.eq('run cannot continue', run.status, 'failed')
    t.eq('work still on disk', await fs.readFile(path.join(run.workspace.path, 'source.txt'), 'utf8'), 'partial')
    engine.run = run
    await releaseWorkspace(engine)
  }
}
