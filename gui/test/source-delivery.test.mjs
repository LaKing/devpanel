import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRun, resumeRun, worktreeDiffDelivery, gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { applyToSource } from '../server/runtime/source-delivery.mjs'
import { FENCE_STUBS, fingerprint, baselineOf } from '../server/runtime/fingerprint.mjs'
import { readRun, runDir, writeRun } from '../server/runtime/store.mjs'
import { workspaceDisposition, createSupervisor, supportedActions } from '../server/supervisor.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import { applyRunArtifact } from '../server/runtime/apply-artifact.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { engineFixture, leaveFenceStubs, scriptFor, simulateProcessDeath } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
export const name = 'source delivery — resolved means the original project runs the approved code'

async function fixture ({ drift = false, deliveryProvider = worktreeDiffDelivery, prepare = null, runOptions = {} } = {}) {
  let engine
  const script = scriptFor()
  const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async turn => {
    if (turn.stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), 'console.log("Hello Beautiful world")')
      if (drift === 'unrelated') await fs.writeFile(path.join(f.projectPath, 'source.txt'), 'newer unrelated work\n')
      if (drift === 'overlap') await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello Other world")')
      if (drift === 'stubs') await leaveFenceStubs(engine.run.workspace.path)
    }
    return script(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
  } })
  await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello World")')
  await git(f.projectPath, 'add', 'server.mjs')
  await git(f.projectPath, 'commit', '-qm', 'server')
  if (prepare) await prepare(f)
  const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'opus-5' } }, ...runOptions }
  const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
  engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider,
    expectConfigHash: resolved.resolved.configHash, runOptions: options })
  return { f, engine }
}

async function primitive ({ setup = async () => {}, edit = async () => {}, policy = {} } = {}) {
  const f = await engineFixture()
  await setup(f)
  const workspace = await gitWorktreeProvider.create({ projectPath: f.projectPath, runId: 'source-test', root: f.issuePath, policy: { base: 'working-tree', ...policy } })
  const baseline = await baselineOf(workspace.path)
  await edit(workspace.path, f)
  const fp = await fingerprint(workspace.path, { baseline, baseCommit: workspace.baseCommit })
  const dir = path.join(f.issuePath, 'delivery')
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true })
  const args = { workspace, workspacePath: workspace.path, baseCommit: workspace.baseCommit, baseline, fingerprint: fp, revision: fp.fingerprint, runDir: dir }
  const receipt = await worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' })
  return { f, workspace, args, receipt, deliver: hooks => applyToSource({ ...args, receipt, hooks }) }
}

export default async function (t) {
  t.section('normal closure updates the original project without changing its Git state')
  const { f, engine } = await fixture()
  const index = await git(f.projectPath, 'ls-files', '--stage', '-z')
  const head = await git(f.projectPath, 'rev-parse', 'HEAD')
  await engine.drive()
  t.eq('resolved', engine.run.outcome, 'resolved')
  t.eq('project prints the requested text', (await exec('node', [path.join(f.projectPath, 'server.mjs')])).stdout, 'Hello Beautiful world\n')
  t.eq('HEAD unchanged', await git(f.projectPath, 'rev-parse', 'HEAD'), head)
  t.eq('index unchanged', await git(f.projectPath, 'ls-files', '--stage', '-z'), index)
  t.eq('verified receipt persisted before completion', (await readRun(f.issuePath, engine.runId)).delivery.application.fingerprint, engine.run.closure.revision)
  t.ok('the applied change is also a verified commit on a devpanel branch', /^devpanel\//.test(engine.run.delivery.branch ?? '') && engine.run.delivery.reconstruction?.commit?.verified === true, JSON.stringify({ branch: engine.run.delivery.branch, commit: engine.run.delivery.commit }))
  t.eq('the branch points at that commit in the project repository', (await git(f.projectPath, 'rev-parse', '--verify', `refs/heads/${engine.run.delivery.branch}`)).trim(), engine.run.delivery.commit)
  t.eq('verified completion allows disposal', workspaceDisposition(engine.run, { unchanged: false, proven: true }).discard, true)

  t.section('drift on paths the patch does not touch: the patch is applied beside it')
  const u = await fixture({ drift: 'unrelated' })
  await u.engine.drive()
  t.eq('delivered', u.engine.run.delivery.application.state, 'complete', u.engine.run.delivery.application.error)
  t.eq('the reviewed bytes landed', (await exec('node', [path.join(u.f.projectPath, 'server.mjs')])).stdout, 'Hello Beautiful world\n')
  t.eq('the unrelated work is kept', await fs.readFile(path.join(u.f.projectPath, 'source.txt'), 'utf8'), 'newer unrelated work\n')
  t.eq('the untested combination is recorded', u.engine.run.delivery.application.composed?.paths, ['source.txt'])
  t.eq('the run completes on that delivery', `${u.engine.run.status}/${u.engine.run.outcome}`, 'completed/resolved', u.engine.run.blockedReason)
  t.eq('closure counts it delivered', u.engine.run.closure?.conditions?.deliveryCompleted, true)

  t.section('drift on a path the patch touches retains the candidate and explains manual application or rerun')
  const d = await fixture({ drift: 'overlap' })
  await d.engine.drive()
  t.eq('unresolved', d.engine.run.outcome, 'unresolved')
  t.eq('source drift recorded', d.engine.run.delivery.application.state, 'source-drift')
  t.ok('operator has a path out', d.engine.run.delivery.error.includes('apply manually or rerun'))
  t.ok('the overlapping path is named', d.engine.run.delivery.error.includes('server.mjs'), d.engine.run.delivery.error)
  t.eq('the newer source is untouched', (await exec('node', [path.join(d.f.projectPath, 'server.mjs')])).stdout, 'Hello Other world\n')
  t.eq('candidate retained', workspaceDisposition(d.engine.run, { unchanged: false, proven: true }).discard, false)
  t.eq('even an unchanged candidate needs source verification', workspaceDisposition({ workspace: {}, delivery: { action: 'apply-to-source', reconstruction: { verified: true } } }, { unchanged: true, proven: true }).discard, false)
  t.ok('patch retained', await fs.readFile(path.join(runDir(d.f.issuePath, d.engine.runId), d.engine.run.delivery.artifactRef), 'utf8').then(x => x.includes('Hello Beautiful world')))

  t.section('artifact-only provider cannot satisfy source delivery')
  const missing = await fixture({ deliveryProvider: { deliver: args => worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' }) } })
  await missing.engine.drive()
  t.eq('missing application receipt blocks', missing.engine.run.blockedReason, 'source-delivery-blocked')

  t.section('crash after applying: finalize recognizes the destination without applying twice')
  const crashing = { async deliver (args) {
    const receipt = await worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' })
    return applyToSource({ ...args, receipt, hooks: { afterApply: () => { throw Object.assign(new Error('process died'), { simulatedCrash: true }) } } })
  } }
  const c = await fixture({ deliveryProvider: crashing })
  await c.engine.drive()
  t.eq('not falsely resolved', c.engine.run.outcome, 'unresolved')
  t.eq('source was written', (await exec('node', [path.join(c.f.projectPath, 'server.mjs')])).stdout, 'Hello Beautiful world\n')
  c.engine.run.status = 'running'
  await writeRun(c.f.issuePath, c.engine.runId, c.engine.run)
  await simulateProcessDeath(c.f.issuePath)
  const supervisor = createSupervisor({ issues: { listProjects: async () => [{ id: 'devpanel-project' }], listIssues: async () => [c.f.issue] }, configRoot: c.f.configRoot })
  await supervisor.reconcile()
  const recovered = await readRun(c.f.issuePath, c.engine.runId)
  t.eq('startup offers source reconciliation', recovered.blockedReason, 'source-delivery-interrupted')
  t.ok('finalize is available without another agent turn', supportedActions(recovered).includes('finalize'))
  const resumed = await resumeRun({ ...c.f, runId: c.engine.runId, deliveryProvider: worktreeDiffDelivery })
  await resumed.finalize()
  t.eq('finalize resolved', resumed.run.outcome, 'resolved')
  t.eq('destination reproduces approved revision', resumed.run.delivery.application.fingerprint, (await fingerprint(resumed.run.workspace.path, { baseline: resumed.baseline })).fingerprint)

  t.section('fence stubs: never drift, and no empty file over a real one at the destination')
  {
    const real = '{"mcpServers":{}}\n'
    const s = await fixture({
      drift: 'stubs',
      // The issue's case: real at the destination, ignored there, so not in the snapshot.
      prepare: async (f) => {
        await fs.writeFile(path.join(f.projectPath, '.gitignore'), '.mcp.json\n')
        await fs.writeFile(path.join(f.projectPath, '.mcp.json'), real)
        await git(f.projectPath, 'add', '.gitignore')
        await git(f.projectPath, 'commit', '-qm', 'ignore local config')
      },
      // They stand in the worktree and in the checkout as delivery reads both.
      deliveryProvider: { ...worktreeDiffDelivery, deliver: async (args) => {
        await leaveFenceStubs(args.workspacePath)
        await leaveFenceStubs(args.workspace.source.path)
        return worktreeDiffDelivery.deliver(args)
      } }
    })
    await s.engine.drive()
    const { application, artifactRef } = s.engine.run.delivery
    t.eq('delivered: no drift reported', application.state, 'complete', application.error)
    t.eq('nothing was taken for someone else\'s work', [application.composed ?? null, application.drifted ?? null], [null, null])
    t.eq('the real file is untouched', await fs.readFile(path.join(s.f.projectPath, '.mcp.json'), 'utf8'), real)
    t.eq('the reviewed bytes landed', (await exec('node', [path.join(s.f.projectPath, 'server.mjs')])).stdout, 'Hello Beautiful world\n')
    const patch = await fs.readFile(path.join(runDir(s.f.issuePath, s.engine.runId), artifactRef), 'utf8')
    t.eq('the patch holds none of them', FENCE_STUBS.filter((rel) => patch.includes(rel)), [])
    t.eq('the run completes', `${s.engine.run.status}/${s.engine.run.outcome}`, 'completed/resolved', s.engine.run.blockedReason)
  }

  t.section('explicit patch-only choice leaves the checkout untouched')
  const patchOnly = await fixture({ runOptions: { delivery: 'worktree-diff' } })
  await patchOnly.engine.drive()
  t.eq('patch delivery completed', patchOnly.engine.run.delivery.action, 'worktree-diff')
  t.eq('project remains unchanged', (await exec('node', [path.join(patchOnly.f.projectPath, 'server.mjs')])).stdout, 'Hello World\n')
  t.eq('patch-only result is clearly labelled', runResult(patchOnly.engine.run, {}).resultLabel, 'Patch ready — source not updated')

  t.section('explicit retained-artifact application works after worktree deletion')
  await patchOnly.engine.runLock.release()
  const savedSnapshot = await fs.readFile(path.join(runDir(patchOnly.f.issuePath, patchOnly.engine.runId), 'resolved-playbook.json'), 'utf8')
  await gitWorktreeProvider.release({ projectPath: patchOnly.f.projectPath, path: patchOnly.engine.run.workspace.path })
  patchOnly.engine.run.workspace.state = 'removed'
  await writeRun(patchOnly.f.issuePath, patchOnly.engine.runId, patchOnly.engine.run)
  const applyArgs = { issuePath: patchOnly.f.issuePath, runId: patchOnly.engine.runId, projectPath: patchOnly.f.projectPath, expectedRevision: patchOnly.engine.run.delivery.revision }
  const wrong = await applyRunArtifact({ ...applyArgs, expectedRevision: 'wrong' }).catch(error => error)
  t.eq('stale approval refused', wrong.status, 409)
  const applied = await applyRunArtifact(applyArgs)
  t.eq('retained artifact applies', applied.application.verified, true)
  t.eq('original source executes new text', (await exec('node', [path.join(patchOnly.f.projectPath, 'server.mjs')])).stdout, 'Hello Beautiful world\n')
  t.eq('historical snapshot unchanged', await fs.readFile(path.join(runDir(patchOnly.f.issuePath, patchOnly.engine.runId), 'resolved-playbook.json'), 'utf8'), savedSnapshot)
  t.eq('historical delivery preserved', (await readRun(patchOnly.f.issuePath, patchOnly.engine.runId)).delivery.action, 'worktree-diff')
  t.eq('repeat is idempotent', (await applyRunArtifact(applyArgs)).application.verified, true)

  t.section('dirty and staged work, binary additions, deletions and executable modes')
  const dirty = await primitive({ setup: async f => {
    await fs.writeFile(path.join(f.projectPath, 'source.txt'), 'staged user work\n')
    await git(f.projectPath, 'add', 'source.txt')
    await fs.writeFile(path.join(f.projectPath, 'source.txt'), 'unstaged user work\n')
    await fs.writeFile(path.join(f.projectPath, 'local.txt'), 'untracked user work\n')
    await fs.writeFile(path.join(f.projectPath, 'doomed.txt'), 'delete me')
    await fs.writeFile(path.join(f.projectPath, '.gitignore'), 'generated.bin\n')
  }, edit: async dir => {
    await fs.appendFile(path.join(dir, 'source.txt'), 'approved change\n')
    await fs.chmod(path.join(dir, 'source.txt'), 0o755)
    await fs.rm(path.join(dir, 'doomed.txt'))
    await fs.writeFile(path.join(dir, 'generated.bin'), Buffer.from([0, 255, 7, 0]))
  } })
  const dirtyIndex = await git(dirty.f.projectPath, 'ls-files', '--stage', '-z')
  t.eq('dirty source delivered', (await dirty.deliver()).application.verified, true)
  t.eq('staged content preserved', await git(dirty.f.projectPath, 'ls-files', '--stage', '-z'), dirtyIndex)
  t.eq('untracked work preserved', await fs.readFile(path.join(dirty.f.projectPath, 'local.txt'), 'utf8'), 'untracked user work\n')
  t.eq('working-tree edit composed', await fs.readFile(path.join(dirty.f.projectPath, 'source.txt'), 'utf8'), 'unstaged user work\napproved change\n')
  t.eq('binary bytes delivered', [...await fs.readFile(path.join(dirty.f.projectPath, 'generated.bin'))], [0, 255, 7, 0])
  t.eq('mode delivered', (await fs.stat(path.join(dirty.f.projectPath, 'source.txt'))).mode & 0o100, 0o100)
  t.eq('deletion delivered', await fs.access(path.join(dirty.f.projectPath, 'doomed.txt')).then(() => true, () => false), false)

  t.section('excluded runtime state stays outside delivery; unchanged materialized source is read-only')
  const ignored = await primitive({ setup: async f => {
    await fs.writeFile(path.join(f.projectPath, '.gitignore'), 'secrets/\n*.log\n.env\ntracked.log\n')
    await fs.mkdir(path.join(f.projectPath, 'secrets'))
    await fs.writeFile(path.join(f.projectPath, 'secrets/token'), 'private')
    await fs.writeFile(path.join(f.projectPath, 'project.log'), 'live log')
    await fs.writeFile(path.join(f.projectPath, '.env'), 'private env')
    await fs.writeFile(path.join(f.projectPath, 'tracked.log'), 'tracked despite ignore')
    await git(f.projectPath, 'add', '-f', 'tracked.log')
    await git(f.projectPath, 'commit', '-qm', 'tracked ignored file')
    await fs.writeFile(path.join(f.projectPath, 'staged.log'), 'ignored staged addition')
    await git(f.projectPath, 'add', '-f', 'staged.log')
  }, edit: dir => fs.writeFile(path.join(dir, 'source.txt'), 'approved with ignored files') })
  const originalRead = fs.readFile
  const reads = []
  fs.readFile = async function (file, ...args) {
    const name = String(file)
    if (name.startsWith(ignored.f.projectPath + '/')) reads.push(path.relative(ignored.f.projectPath, name))
    return originalRead.call(this, file, ...args)
  }
  let ignoredResult
  try { ignoredResult = await ignored.deliver() } finally { fs.readFile = originalRead }
  t.eq('ignored checkout content does not block delivery', ignoredResult.application.verified, true)
  t.eq('ignored secrets and logs are never read', reads.filter(p => p.startsWith('secrets/') || p === '.env' || p === 'project.log' || p === 'staged.log'), [])
  t.ok('tracked ignored content is verified', reads.includes('tracked.log'))
  t.eq('ignored log untouched', await fs.readFile(path.join(ignored.f.projectPath, 'project.log'), 'utf8'), 'live log')
  t.eq('ignored checkout retry recognizes approved destination', (await ignored.deliver()).application.verified, true)
  await fs.writeFile(path.join(ignored.f.projectPath, 'new-untracked.txt'), 'new user work')
  t.eq('nonignored untracked content still blocks recovery', (await ignored.deliver()).application.state, 'recovery-required')

  const shared = await primitive({ policy: { symlinks: 'materialize', excludes: ['runtime'] }, setup: async f => {
    const external = path.join(f.issuePath, 'framework')
    await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'shared.txt'), 'framework')
    await fs.symlink(external, path.join(f.projectPath, 'shared'))
    await fs.mkdir(path.join(f.projectPath, 'runtime'))
    await fs.writeFile(path.join(f.projectPath, 'runtime', 'state'), 'live state')
  }, edit: async dir => fs.writeFile(path.join(dir, 'source.txt'), 'application edit') })
  t.eq('application file delivered', (await shared.deliver()).application.verified, true)
  t.eq('materialized root stays a symlink', (await fs.lstat(path.join(shared.f.projectPath, 'shared'))).isSymbolicLink(), true)
  t.eq('runtime retained', await fs.readFile(path.join(shared.f.projectPath, 'runtime', 'state'), 'utf8'), 'live state')
  const unsupported = await primitive({ policy: { symlinks: 'materialize' }, setup: async f => {
    const external = path.join(f.issuePath, 'framework')
    await fs.mkdir(external); await fs.writeFile(path.join(external, 'shared.txt'), 'framework')
    await fs.symlink(external, path.join(f.projectPath, 'shared'))
  }, edit: async dir => fs.writeFile(path.join(dir, 'shared/shared.txt'), 'changed framework') })
  const refused = await unsupported.deliver()
  t.eq('external write refused', refused.application.state, 'unsupported-path')
  t.ok('exact path named', refused.application.error.includes('shared/shared.txt'))
  t.eq('shared source untouched', await fs.readFile(path.join(unsupported.f.projectPath, 'shared/shared.txt'), 'utf8'), 'framework')

  t.section('materialized modules dispatch to their Git owners and recover partial delivery')
  const owned = async ({ app = true } = {}) => primitive({ policy: { symlinks: 'materialize' }, setup: async f => {
    const owner = path.join(f.issuePath, 'framework')
    await fs.mkdir(path.join(owner, 'modules'), { recursive: true })
    await git(owner, 'init', '-q')
    await git(owner, 'config', 'user.email', 'test@example.com')
    await git(owner, 'config', 'user.name', 'Test')
    await fs.writeFile(path.join(owner, 'modules/shared.txt'), 'original')
    await fs.writeFile(path.join(owner, 'modules/delete.txt'), 'delete')
    await fs.writeFile(path.join(owner, 'unrelated.txt'), 'unrelated')
    await git(owner, 'add', '.')
    await git(owner, 'commit', '-qm', 'base')
    await fs.writeFile(path.join(owner, 'modules/shared.txt'), 'staged')
    await git(owner, 'add', '.')
    await fs.writeFile(path.join(owner, 'modules/shared.txt'), 'dirty')
    await fs.symlink(path.join(owner, 'modules'), path.join(f.projectPath, 'shared'))
  }, edit: async dir => {
    if (app) await fs.writeFile(path.join(dir, 'source.txt'), 'app approved')
    await fs.writeFile(path.join(dir, 'shared/shared.txt'), 'module approved')
    await fs.chmod(path.join(dir, 'shared/shared.txt'), 0o755)
    await fs.rm(path.join(dir, 'shared/delete.txt'))
    await fs.writeFile(path.join(dir, 'shared/new.bin'), Buffer.from([0, 255, 1]))
  } })
  const o = await owned()
  const ownerPath = path.join(o.f.issuePath, 'framework')
  const ownerIndex = await git(ownerPath, 'ls-files', '--stage', '-z')
  const ownerHead = await git(ownerPath, 'rev-parse', 'HEAD')
  const appIndex = await git(o.f.projectPath, 'ls-files', '--stage', '-z')
  const ownerResult = await o.deliver()
  t.eq('owner delivery verified', ownerResult.application.verified, true)
  t.eq('owner composition exact', ownerResult.application.fingerprint, o.args.revision)
  t.eq('two destinations recorded', ownerResult.application.owners.length, 2)
  t.eq('owner index preserved', await git(ownerPath, 'ls-files', '--stage', '-z'), ownerIndex)
  t.eq('owner HEAD preserved', await git(ownerPath, 'rev-parse', 'HEAD'), ownerHead)
  t.eq('application index preserved', await git(o.f.projectPath, 'ls-files', '--stage', '-z'), appIndex)
  t.eq('source link preserved', (await fs.lstat(path.join(o.f.projectPath, 'shared'))).isSymbolicLink(), true)
  t.eq('remapped binary delivered', [...await fs.readFile(path.join(ownerPath, 'modules/new.bin'))], [0, 255, 1])
  t.eq('owner retry idempotent', (await o.deliver()).application.verified, true)
  const interrupted = await owned()
  delete interrupted.workspace.symlinks.owners // Runs created before owner binding was introduced.
  await interrupted.deliver({ afterOwnerApply: () => { throw Object.assign(Error('crash'), { simulatedCrash: true }) } }).catch(() => {})
  t.eq('partial delivery has intent', JSON.parse(await fs.readFile(path.join(interrupted.args.runDir, 'source-application.json'))).state, 'applying')
  t.eq('partial owner delivery resumes', (await interrupted.deliver()).application.verified, true)
  const drifted = await owned()
  await fs.writeFile(path.join(drifted.f.projectPath, 'shared/shared.txt'), 'new user edit')
  t.eq('owner drift refused', (await drifted.deliver()).application.state, 'source-drift')
  t.eq('owner drift prevents app write', await fs.readFile(path.join(drifted.f.projectPath, 'source.txt'), 'utf8'), 'original\n')
  const beside = await owned({ app: false })
  await fs.writeFile(path.join(beside.f.projectPath, 'source.txt'), 'someone else\'s edit\n')
  const besideResult = (await beside.deliver()).application
  t.eq('owner delivery beside application drift completes', besideResult.state, 'complete', besideResult.error)
  t.eq('the drifted application path is recorded', besideResult.composed?.paths, ['source.txt'])
  t.eq('the module change landed', await fs.readFile(path.join(beside.f.issuePath, 'framework/modules/shared.txt'), 'utf8'), 'module approved')
  t.eq('the application edit is kept', await fs.readFile(path.join(beside.f.projectPath, 'source.txt'), 'utf8'), 'someone else\'s edit\n')
  t.eq('owner retry beside drift stays complete', (await beside.deliver()).application.state, 'complete')
  const cut = await owned({ app: false })
  await fs.writeFile(path.join(cut.f.projectPath, 'source.txt'), 'someone else\'s edit\n')
  await cut.deliver({ afterOwnerApply: () => { throw Object.assign(Error('crash'), { simulatedCrash: true }) } }).catch(() => {})
  const again = (await cut.deliver()).application
  t.eq('an interrupted delivery beside drift completes on retry', again.state, 'complete', again.error)
  t.ok('its record carries the fingerprint it observed', typeof again.fingerprint === 'string' && again.fingerprint.startsWith('sha256:'), String(again.fingerprint))
  t.ok('and every owner as complete', again.owners.length > 0 && again.owners.every(o => o.state === 'complete'), JSON.stringify(again.owners.map(o => o.state)))
  const journal = JSON.parse(await fs.readFile(path.join(cut.args.runDir, 'source-application.json'), 'utf8'))
  t.eq('the durable journal says the same', [journal.state, journal.owners.every(o => o.state === 'complete'), journal.fingerprint], ['complete', true, again.fingerprint])
  const locked = await owned()
  const ownerLock = await acquire(path.join(locked.workspace.symlinks.owners[0].owner.repository, 'devpanel-source-delivery.lock'), { purpose: 'test' })
  try { t.eq('owner lock prevents delivery', (await locked.deliver({ sourceLockWaitMs: 0 })).application.verified, false) } finally { await ownerLock.release() }
  t.eq('delivery succeeds after owner unlock', (await locked.deliver()).application.verified, true)

  t.section('destination oracle and repository lock control retry')
  const pending = await primitive({ edit: dir => fs.writeFile(path.join(dir, 'source.txt'), 'approved') })
  const lock = await acquire(path.join(pending.workspace.source.repository, 'devpanel-source-delivery.lock'), { purpose: 'test' })
  try { t.eq('locked destination not written', (await pending.deliver({ sourceLockWaitMs: 0 })).application.verified, false) } finally { await lock.release() }
  await fs.writeFile(path.join(pending.args.runDir, 'source-application.json'), JSON.stringify({ path: pending.f.projectPath, revision: pending.args.revision, state: 'applying' }))
  t.eq('base means not applied: retry succeeds', (await pending.deliver()).application.verified, true)
  await fs.writeFile(path.join(pending.f.projectPath, 'source.txt'), 'intervening edit')
  t.eq('third state needs recovery', (await pending.deliver()).application.state, 'recovery-required')
  t.eq('intervening edit preserved', await fs.readFile(path.join(pending.f.projectPath, 'source.txt'), 'utf8'), 'intervening edit')

  t.section('a delivery waits for the lock, and two on one checkout both complete')
  {
    const waiting = await primitive({ edit: dir => fs.writeFile(path.join(dir, 'source.txt'), 'first approved') })
    const beside = await primitive({ edit: dir => fs.writeFile(path.join(dir, 'other.txt'), 'second approved') })
    const heldLock = await acquire(path.join(waiting.workspace.source.repository, 'devpanel-source-delivery.lock'), { purpose: 'test' })
    let settled = false
    const delivering = waiting.deliver().finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    t.eq('it waits behind a held lock', settled, false)
    await heldLock.release()
    t.eq('and delivers once it is free', (await delivering).application.verified, true)
    t.eq('the patch is applied', await fs.readFile(path.join(waiting.f.projectPath, 'source.txt'), 'utf8'), 'first approved')
    t.eq('another run on its own checkout is not held up', (await beside.deliver()).application.verified, true)

    const a = await primitive({ edit: dir => fs.writeFile(path.join(dir, 'a.txt'), 'a') })
    const second = await gitWorktreeProvider.create({ projectPath: a.f.projectPath, runId: 'source-test-2', root: a.f.issuePath, policy: { base: 'working-tree' } })
    const secondBaseline = await baselineOf(second.path)
    await fs.writeFile(path.join(second.path, 'b.txt'), 'b')
    const secondFp = await fingerprint(second.path, { baseline: secondBaseline, baseCommit: second.baseCommit })
    const secondDir = path.join(a.f.issuePath, 'delivery-2')
    await fs.mkdir(path.join(secondDir, 'artifacts'), { recursive: true })
    const secondArgs = { workspace: second, workspacePath: second.path, baseCommit: second.baseCommit, baseline: secondBaseline, fingerprint: secondFp, revision: secondFp.fingerprint, runDir: secondDir }
    const secondReceipt = await worktreeDiffDelivery.deliver({ ...secondArgs, action: 'worktree-diff' })
    const [one, two] = await Promise.all([a.deliver(), applyToSource({ ...secondArgs, receipt: secondReceipt })])
    t.eq('two deliveries into one checkout both complete', [one.application.state, two.application.state], ['complete', 'complete'], JSON.stringify([one.application.error, two.application.error]))
    t.eq('with both patches in place', [await fs.readFile(path.join(a.f.projectPath, 'a.txt'), 'utf8'), await fs.readFile(path.join(a.f.projectPath, 'b.txt'), 'utf8')], ['a', 'b'])
  }

  t.section('a snapshot waits for a delivery in progress, and holds the whole patch')
  {
    const delivery = await primitive({ edit: async (dir) => {
      await fs.writeFile(path.join(dir, 'source.txt'), 'whole patch, first file')
      await fs.writeFile(path.join(dir, 'later.txt'), 'whole patch, second file')
    } })
    let snapshot = null, snapshotSettled = false
    const finished = await delivery.deliver({ beforeApply: async () => {
      snapshot = gitWorktreeProvider.create({ projectPath: delivery.f.projectPath, runId: 'source-snapshot', root: delivery.f.issuePath, policy: { base: 'working-tree' } }).finally(() => { snapshotSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 400))
      t.eq('the snapshot does not finish while the delivery holds the lock', snapshotSettled, false)
    } })
    t.eq('the delivery completes', finished.application.state, 'complete', finished.application.error)
    const cut = await snapshot
    t.eq('the snapshot waited for all of it', [await git(cut.path, 'show', 'HEAD:source.txt'), await git(cut.path, 'show', 'HEAD:later.txt')], ['whole patch, first file', 'whole patch, second file'])
    t.eq('and says which lock it held', cut.base.snapshotLock.repositories, [delivery.workspace.source.repository])
  }

  t.section('a snapshot refuses when it cannot hold the lock of what it reads')
  {
    const denied = await engineFixture()
    if (process.getuid?.() === 0) t.skip('as root chmod does not bind')
    else {
      const gitDir = path.join(denied.projectPath, '.git')
      await fs.chmod(gitDir, 0o555)
      try {
        const refused = await gitWorktreeProvider.create({ projectPath: denied.projectPath, runId: 'denied', root: denied.issuePath, policy: { base: 'working-tree' } }).then(() => null, (error) => error)
        t.eq('it is refused, with no snapshot', refused?.code, 'SNAPSHOT_LOCK_UNAVAILABLE')
        t.ok('naming the remedy', /write access/.test(refused?.message ?? ''), refused?.message)
      } finally { await fs.chmod(gitDir, 0o755) }
    }
  }

  t.section('a mutation between apply and verification never resolves')
  const raced = await primitive({ edit: dir => fs.writeFile(path.join(dir, 'source.txt'), 'approved') })
  const racedResult = await raced.deliver({ afterApply: () => fs.writeFile(path.join(raced.f.projectPath, 'source.txt'), 'external edit') })
  t.eq('verification catches external edit', racedResult.application.state, 'recovery-required')
  t.eq('no verified claim', racedResult.application.verified, false)

  const derived = await primitive({ edit: dir => fs.writeFile(path.join(dir, 'source.txt'), 'derived candidate') })
  t.eq('provider derives an omitted fingerprint', (await worktreeDiffDelivery.deliver({ ...derived.args, action: 'apply-to-source', fingerprint: null })).application.verified, true)
  await git(derived.f.projectPath, 'add', 'source.txt')
  await git(derived.f.projectPath, 'commit', '-qm', 'operator committed the applied result')
  t.eq('approved destination remains done after an operator commit', (await derived.deliver()).application.verified, true)

  t.section('preview and readiness disclose source-write authority and destination')
  const preview = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, project: { id: 'devpanel-project', path: f.projectPath }, deliveryActions: worktreeDiffDelivery.actions })
  t.eq('default applies to source', preview.delivery.action, 'apply-to-source')
  t.eq('preview names the checkout', preview.delivery.destination, f.projectPath)
  t.ok('preview discloses authority', preview.prerequisites.some(p => p.kind === 'source-delivery' && p.detail.includes('authorizes')))
  const readiness = await launchReadiness({ project: 'devpanel-project', projectPath: f.projectPath, playbook: 'implementation',
    resolve: (id, opts) => resolvePlaybook(id, { ...opts, root: f.configRoot }), inspect: async () => null, inspectLaunch: async () => ({}) })
  t.eq('readiness names source destination', readiness.configuration.delivery.destination, f.projectPath)
  t.eq('readiness names write capability', readiness.configuration.delivery.writesSource, true)
  t.eq('read-only workflow cannot select source writes', (await resolvePlaybook('analysis', { root: f.configRoot, runOptions: { delivery: 'apply-to-source' } })).ok, false)
}
