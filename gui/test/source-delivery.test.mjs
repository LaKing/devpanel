import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRun, resumeRun, worktreeDiffDelivery, gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { applyToSource, destinationFingerprint } from '../server/runtime/source-delivery.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { renderResult } from '../server/run-result-step.mjs'
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
const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join('')

async function fixture ({ drift = false, deliveryProvider = worktreeDiffDelivery, prepare = null, runOptions = {} } = {}) {
  let engine
  const script = scriptFor()
  const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async turn => {
    if (turn.stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), 'console.log("Hello Beautiful world")')
      if (drift === 'unrelated') await fs.writeFile(path.join(f.projectPath, 'source.txt'), 'newer unrelated work\n')
      if (drift === 'overlap') await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello Other world")')
      if (drift === 'stubs') await leaveFenceStubs(engine.run.workspace.path)
      // A manual edit on another line (merge) or the same line (conflict) of a file the candidate also changes.
      if (drift === 'merge' || drift === 'conflict') {
        await fs.writeFile(path.join(engine.run.workspace.path, 'lines.txt'), TEN.replace('line 9\n', 'line 9 fixed\n'))
        await fs.writeFile(path.join(f.projectPath, 'lines.txt'), drift === 'merge' ? TEN.replace('line 1\n', 'line 1 by hand\n') : TEN.replace('line 9\n', 'line 9 by hand\n'))
      }
    }
    return script(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
  } })
  await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("Hello World")')
  await fs.writeFile(path.join(f.projectPath, 'lines.txt'), TEN)
  await git(f.projectPath, 'add', 'server.mjs', 'lines.txt')
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

  t.section('a run delivered over a manual edit: the record, the explanation and result.md')
  {
    const m = await fixture({ drift: 'merge' })
    await m.engine.drive()
    const d = m.engine.run.delivery
    t.eq('the run completes on the merged delivery', `${m.engine.run.status}/${m.engine.run.outcome}`, 'completed/resolved', `${m.engine.run.blockedReason} ${d?.error}`)
    t.eq('the checkout holds both edits', await fs.readFile(path.join(m.f.projectPath, 'lines.txt'), 'utf8'), TEN.replace('line 1\n', 'line 1 by hand\n').replace('line 9\n', 'line 9 fixed\n'))
    t.eq('delivery.merged names the path and its hunks', d.merged, [{ path: 'lines.txt', hunks: 1 }])
    t.ok('delivery.mergedFrom is the merged tree, and the delivered revision stays the approved one', d.mergedFrom === d.application.fingerprint && d.mergedFrom !== m.engine.run.closure.revision && d.revision === m.engine.run.closure.revision, JSON.stringify([d.mergedFrom, d.revision]))
    t.eq('delivery.mergeCheck says no check ran on the merged bytes', d.mergeCheck?.ran, false)
    const explained = explainRun(m.engine.run)
    t.ok('the explanation names the merged path', explained.detail.includes('Merged three-way with edits in the project: lines.txt (1 hunk)'), explained.detail)
    t.ok('result.md names it too', renderResult(m.engine.run).includes('Merged three-way with edits in the project: lines.txt (1 hunk)'))

    const c = await fixture({ drift: 'conflict' })
    await c.engine.drive()
    const blocked = c.engine.run.delivery
    t.eq('a same-line edit blocks the run', `${c.engine.run.status}/${c.engine.run.blockedReason}`, 'blocked/source-delivery-blocked')
    t.eq('delivery.conflicts names the file and its lines', blocked.conflicts, [{ path: 'lines.txt', kind: 'text', lines: [{ start: 9, end: 9, side: 'source' }] }])
    t.eq('nothing else of the patch was written either', [blocked.merged ?? [], await fs.readFile(path.join(c.f.projectPath, 'server.mjs'), 'utf8')], [[], 'console.log("Hello World")'])
    t.eq('the manual edit is untouched', await fs.readFile(path.join(c.f.projectPath, 'lines.txt'), 'utf8'), TEN.replace('line 9\n', 'line 9 by hand\n'))
    t.ok('the patch stays available', await fs.readFile(path.join(runDir(c.f.issuePath, c.engine.runId), blocked.artifactRef), 'utf8').then(x => x.includes('line 9 fixed')))
    t.ok('reconcile is offered for the conflicting path', supportedActions(c.engine.run).includes('reconcile-delivery'), JSON.stringify(supportedActions(c.engine.run)))
    const why = explainRun(c.engine.run)
    t.ok('the explanation names the conflict and its line', why.detail.includes('Conflicts with edits in the project: lines.txt line 9 (source).'), why.detail)
    t.ok('result.md names it too', renderResult(c.engine.run).includes('lines.txt line 9 (source)'))
  }

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

  t.section('a manual edit on the patch\'s own path: merged three-way, refused only on a real conflict')
  {
    const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
    const read = (m, file) => fs.readFile(path.join(m.f.projectPath, file), 'utf8')
    // The request's scenario on a scratch repository: the candidate fixes line 9 of a ten-line file; someone edits it by hand.
    const scenario = async (manual, { file = 'lines.txt', candidate = { 9: 'line 9 fixed' }, also = null } = {}) => {
      const m = await primitive({ setup: f => fs.writeFile(path.join(f.projectPath, file), lines(10)), edit: async dir => {
        await fs.writeFile(path.join(dir, file), lines(10, candidate))
        if (also) await fs.writeFile(path.join(dir, also), 'also approved\n')
      } })
      if (manual) await fs.writeFile(path.join(m.f.projectPath, file), lines(10, manual))
      return m
    }

    const clean = await scenario({ 1: 'line 1 by hand' })
    const done = (await clean.deliver()).application
    t.eq('an edit elsewhere in the same file is merged and delivered', done.state, 'complete', done.error)
    t.eq('the checkout holds both edits', await read(clean, 'lines.txt'), lines(10, { 1: 'line 1 by hand', 9: 'line 9 fixed' }))
    t.eq('the merge is recorded with its hunks', done.merged, [{ path: 'lines.txt', hunks: 1 }])
    t.eq('no conflict, nothing drifted', [done.conflicts ?? null, done.drifted ?? null], [null, null])
    t.ok('mergedFrom is the merged tree, not the approved revision', done.mergedFrom && done.mergedFrom !== clean.args.revision, done.mergedFrom)
    t.eq('mergedFrom is the destination as delivered', done.mergedFrom, done.fingerprint)
    t.eq('and re-fingerprints the same now', (await destinationFingerprint(clean.workspace, clean.args.baseline, undefined, ['lines.txt'])).fingerprint, done.mergedFrom)
    t.eq('the record says no check ran on the merged bytes', done.mergeCheck, { ran: false, reason: 'the project has no per-module check tier; no check ran on the merged bytes' })
    t.eq('the revision stays the approved one', done.revision, clean.args.revision)
    const repeat = (await clean.deliver()).application
    t.eq('a retry recognises the merged delivery', [repeat.state, repeat.mergedFrom], ['complete', done.mergedFrom])

    const same = await scenario({ 9: 'line 9 by hand' })
    const refused = (await same.deliver()).application
    t.eq('an edit on the same line refuses', refused.state, 'source-drift')
    t.eq('the conflict names the file and the line', refused.conflicts, [{ path: 'lines.txt', kind: 'text', lines: [{ start: 9, end: 9, side: 'source' }] }])
    t.ok('the message names them too', refused.error.includes('lines.txt line 9 (source)') && refused.error.includes('apply manually or rerun'), refused.error)
    t.eq('only the conflicting path is drifted', refused.drifted, ['lines.txt'])
    t.eq('the manual edit is untouched, with no conflict markers', await read(same, 'lines.txt'), lines(10, { 9: 'line 9 by hand' }))

    const adjacent = (await (await scenario({ 8: 'line 8 by hand' })).deliver()).application
    t.eq('an edit on the adjacent line conflicts over both lines', adjacent.conflicts?.[0]?.lines, [{ start: 8, end: 9, side: 'source' }])

    const identical = await scenario({ 9: 'line 9 fixed' })
    const twin = (await identical.deliver()).application
    t.eq('an identical edit is merged, nothing to write', [twin.state, twin.merged], ['complete', [{ path: 'lines.txt', hunks: 0, identical: true }]])
    t.eq('the destination is exactly the approved revision', [twin.fingerprint, twin.mergedFrom ?? null], [identical.args.revision, null])

    const mixed = await primitive({ setup: async f => {
      await fs.writeFile(path.join(f.projectPath, 'a.txt'), lines(10))
      await fs.writeFile(path.join(f.projectPath, 'b.txt'), lines(10))
    }, edit: async dir => {
      await fs.writeFile(path.join(dir, 'a.txt'), lines(10, { 9: 'a fixed' }))
      await fs.writeFile(path.join(dir, 'b.txt'), lines(10, { 5: 'b fixed' }))
    } })
    await fs.writeFile(path.join(mixed.f.projectPath, 'a.txt'), lines(10, { 1: 'a by hand' }))
    await fs.writeFile(path.join(mixed.f.projectPath, 'b.txt'), lines(10, { 5: 'b by hand' }))
    const half = (await mixed.deliver()).application
    t.eq('one conflict refuses the whole delivery', [half.state, half.conflicts.map(c => c.path)], ['source-drift', ['b.txt']])
    t.eq('the clean path is recorded as not applied', half.merged, [{ path: 'a.txt', hunks: 1, applied: false }])
    t.eq('and is not written either', await read(mixed, 'a.txt'), lines(10, { 1: 'a by hand' }))

    const moving = await scenario({ 1: 'line 1 by hand' })
    const moved = (await moving.deliver({ beforeApply: () => fs.writeFile(path.join(moving.f.projectPath, 'lines.txt'), lines(10, { 1: 'line 1 again' })) })).application
    t.eq('a merged path that moves before the write refuses', moved.state, 'source-drift')
    t.eq('and nothing is written over it', await read(moving, 'lines.txt'), lines(10, { 1: 'line 1 again' }))

    const crash = await scenario({ 1: 'line 1 by hand' }, { also: 'source.txt' })
    await crash.deliver({ afterApply: () => { throw Object.assign(new Error('process died'), { simulatedCrash: true }) } }).catch(() => {})
    const journal = JSON.parse(await fs.readFile(path.join(crash.args.runDir, 'source-application.json'), 'utf8'))
    t.eq('the merge is journaled before the write', [journal.state, journal.merge?.paths], ['applying', ['lines.txt']])
    const resumed = (await crash.deliver()).application
    t.eq('the interrupted merge completes on retry', [resumed.state, Boolean(resumed.mergedFrom)], ['complete', true], resumed.error)
    t.eq('with both edits, once', await read(crash, 'lines.txt'), lines(10, { 1: 'line 1 by hand', 9: 'line 9 fixed' }))

    const globbed = await scenario({ 1: 'line 1 by hand' }, { file: 'b[1].txt', also: 'source.txt' })
    const g = (await globbed.deliver()).application
    t.eq('a path with glob characters merges', g.state, 'complete', g.error)
    t.eq('it holds both edits', await read(globbed, 'b[1].txt'), lines(10, { 1: 'line 1 by hand', 9: 'line 9 fixed' }))
    t.eq('and the rest of the patch landed', await read(globbed, 'source.txt'), 'also approved\n')

    // Binary files, mode changes and symlinks never merge: they conflict unless identical.
    const binary = await primitive({ setup: f => fs.writeFile(path.join(f.projectPath, 'logo.bin'), Buffer.from([1, 0, 2])),
      edit: dir => fs.writeFile(path.join(dir, 'logo.bin'), Buffer.from([1, 0, 3])) })
    await fs.writeFile(path.join(binary.f.projectPath, 'logo.bin'), Buffer.from([1, 0, 4]))
    const bin = (await binary.deliver()).application
    t.eq('a binary file conflicts, with a range in the source', [bin.state, bin.conflicts], ['source-drift', [{ path: 'logo.bin', kind: 'binary', lines: [{ start: 1, end: 1, side: 'source' }] }]])
    t.eq('its bytes are untouched', [...await fs.readFile(path.join(binary.f.projectPath, 'logo.bin'))], [1, 0, 4])

    const mode = await scenario({ 1: 'line 1 by hand' })
    await fs.chmod(path.join(mode.workspace.path, 'lines.txt'), 0o755)
    const modeArgs = { ...mode.args, fingerprint: await fingerprint(mode.workspace.path, { baseline: mode.args.baseline, baseCommit: mode.workspace.baseCommit }) }
    modeArgs.revision = modeArgs.fingerprint.fingerprint
    const modeReceipt = await worktreeDiffDelivery.deliver({ ...modeArgs, action: 'worktree-diff' })
    const changedMode = (await applyToSource({ ...modeArgs, receipt: modeReceipt })).application
    t.eq('a mode change conflicts over the whole file', [changedMode.state, changedMode.conflicts], ['source-drift', [{ path: 'lines.txt', kind: 'mode', lines: [{ start: 1, end: 10, side: 'source' }] }]])

    const linked = await primitive({ setup: async f => {
      for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(path.join(f.projectPath, name), `${name}\n`)
      await fs.symlink('a.txt', path.join(f.projectPath, 'current'))
    }, edit: async dir => { await fs.rm(path.join(dir, 'current')); await fs.symlink('b.txt', path.join(dir, 'current')) } })
    await fs.rm(path.join(linked.f.projectPath, 'current'))
    await fs.symlink('c.txt', path.join(linked.f.projectPath, 'current'))
    const link = (await linked.deliver()).application
    t.eq('a symlink conflicts, its target counted as line 1', [link.state, link.conflicts], ['source-drift', [{ path: 'current', kind: 'symlink', lines: [{ start: 1, end: 1, side: 'source' }] }]])
    t.eq('and still points where it was put by hand', await fs.readlink(path.join(linked.f.projectPath, 'current')), 'c.txt')

    const goneHere = await scenario(null)
    await fs.rm(path.join(goneHere.f.projectPath, 'lines.txt'))
    const deletedHere = (await goneHere.deliver()).application
    t.eq('deleted in the source: lines counted in the candidate\'s file', deletedHere.conflicts, [{ path: 'lines.txt', kind: 'deleted', lines: [{ start: 1, end: 10, side: 'candidate' }] }])
    const goneThere = await primitive({ setup: f => fs.writeFile(path.join(f.projectPath, 'lines.txt'), lines(10)), edit: dir => fs.rm(path.join(dir, 'lines.txt')) })
    await fs.writeFile(path.join(goneThere.f.projectPath, 'lines.txt'), lines(10, { 1: 'line 1 by hand' }))
    const deletedThere = (await goneThere.deliver()).application
    t.eq('deleted in the candidate: lines counted in the source', deletedThere.conflicts, [{ path: 'lines.txt', kind: 'deleted', lines: [{ start: 1, end: 10, side: 'source' }] }])
    t.eq('and the source file is kept', await read(goneThere, 'lines.txt'), lines(10, { 1: 'line 1 by hand' }))
  }

  t.section('owner-routed delivery merges the same way')
  {
    const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
    const routed = () => primitive({ policy: { symlinks: 'materialize' }, setup: async f => {
      const owner = path.join(f.issuePath, 'framework')
      await fs.mkdir(path.join(owner, 'modules'), { recursive: true })
      await git(owner, 'init', '-q')
      await git(owner, 'config', 'user.email', 'test@example.com')
      await git(owner, 'config', 'user.name', 'Test')
      await fs.writeFile(path.join(owner, 'modules/lines.txt'), lines(10))
      await git(owner, 'add', '.')
      await git(owner, 'commit', '-qm', 'base')
      await fs.symlink(path.join(owner, 'modules'), path.join(f.projectPath, 'shared'))
    }, edit: async dir => {
      await fs.writeFile(path.join(dir, 'source.txt'), 'app approved')
      await fs.writeFile(path.join(dir, 'shared/lines.txt'), lines(10, { 9: 'line 9 fixed' }))
    } })
    const ownerFile = m => path.join(m.f.issuePath, 'framework/modules/lines.txt')

    const clean = await routed()
    await fs.writeFile(ownerFile(clean), lines(10, { 1: 'line 1 by hand' }))
    const done = (await clean.deliver()).application
    t.eq('an edit elsewhere in an owner\'s file is merged', done.state, 'complete', done.error)
    t.eq('the owner holds both edits', await fs.readFile(ownerFile(clean), 'utf8'), lines(10, { 1: 'line 1 by hand', 9: 'line 9 fixed' }))
    t.eq('the ordinary path in the same patch landed', await fs.readFile(path.join(clean.f.projectPath, 'source.txt'), 'utf8'), 'app approved')
    t.eq('the merge is recorded', done.merged, [{ path: 'shared/lines.txt', hunks: 1 }])
    t.ok('mergedFrom is the merged tree', done.mergedFrom === done.fingerprint && done.mergedFrom !== clean.args.revision, done.mergedFrom)
    t.eq('a retry stays complete', (await clean.deliver()).application.state, 'complete')

    const conflict = await routed()
    await fs.writeFile(ownerFile(conflict), lines(10, { 9: 'line 9 by hand' }))
    const refused = (await conflict.deliver()).application
    t.eq('an edit on the same line of an owner\'s file refuses', [refused.state, refused.conflicts], ['source-drift', [{ path: 'shared/lines.txt', kind: 'text', lines: [{ start: 9, end: 9, side: 'source' }] }]])
    t.eq('no owner is written', [await fs.readFile(ownerFile(conflict), 'utf8'), await fs.readFile(path.join(conflict.f.projectPath, 'source.txt'), 'utf8')], [lines(10, { 9: 'line 9 by hand' }), 'original\n'])
    t.eq('the conflicting path is drifted, for reconcile', refused.drifted, ['shared/lines.txt'])

    const cut = await routed()
    await fs.writeFile(ownerFile(cut), lines(10, { 1: 'line 1 by hand' }))
    await cut.deliver({ afterOwnerApply: () => { throw Object.assign(Error('crash'), { simulatedCrash: true }) } }).catch(() => {})
    const journal = JSON.parse(await fs.readFile(path.join(cut.args.runDir, 'source-application.json'), 'utf8'))
    t.eq('the merge is journaled before the first owner write', [journal.state, Object.keys(journal.merge?.expected ?? {})], ['applying', ['shared/lines.txt']])
    const resumed = (await cut.deliver()).application
    t.eq('an interrupted owner merge completes on retry', [resumed.state, Boolean(resumed.mergedFrom)], ['complete', true], resumed.error)
    t.eq('with both edits in the owner', await fs.readFile(ownerFile(cut), 'utf8'), lines(10, { 1: 'line 1 by hand', 9: 'line 9 fixed' }))
    t.eq('and the ordinary path', await fs.readFile(path.join(cut.f.projectPath, 'source.txt'), 'utf8'), 'app approved')

    // A materialized FILE link: the destination reads it as its owner's file, so the merge reads it that way too.
    const fileLink = await primitive({ policy: { symlinks: 'materialize' }, setup: async f => {
      const owner = path.join(f.issuePath, 'framework')
      await fs.mkdir(owner, { recursive: true })
      await git(owner, 'init', '-q')
      await git(owner, 'config', 'user.email', 'test@example.com')
      await git(owner, 'config', 'user.name', 'Test')
      await fs.writeFile(path.join(owner, 'notes.txt'), lines(10))
      await git(owner, 'add', '.')
      await git(owner, 'commit', '-qm', 'base')
      await fs.symlink(path.join(owner, 'notes.txt'), path.join(f.projectPath, 'shared'))
    }, edit: dir => fs.writeFile(path.join(dir, 'shared'), lines(10, { 9: 'line 9 fixed' })) })
    const linkedFile = path.join(fileLink.f.issuePath, 'framework/notes.txt')
    await fs.writeFile(linkedFile, lines(10, { 1: 'line 1 by hand' }))
    const viaLink = (await fileLink.deliver()).application
    t.eq('a clean edit through a materialized file link is merged and applied', [viaLink.state, viaLink.merged], ['complete', [{ path: 'shared', hunks: 1 }]], viaLink.error)
    t.eq('the owner\'s file holds both edits', await fs.readFile(linkedFile, 'utf8'), lines(10, { 1: 'line 1 by hand', 9: 'line 9 fixed' }))
    t.ok('and the source link is kept', (await fs.lstat(path.join(fileLink.f.projectPath, 'shared'))).isSymbolicLink())

    // An identical path writes nothing but stays verified: moved before the write, the delivery never completes.
    const twins = await primitive({ policy: { symlinks: 'materialize' }, setup: async f => {
      const owner = path.join(f.issuePath, 'framework')
      await fs.mkdir(path.join(owner, 'modules'), { recursive: true })
      await git(owner, 'init', '-q')
      await git(owner, 'config', 'user.email', 'test@example.com')
      await git(owner, 'config', 'user.name', 'Test')
      await fs.writeFile(path.join(owner, 'modules/a.txt'), lines(10))
      await fs.writeFile(path.join(owner, 'modules/b.txt'), lines(10))
      await git(owner, 'add', '.')
      await git(owner, 'commit', '-qm', 'base')
      await fs.symlink(path.join(owner, 'modules'), path.join(f.projectPath, 'shared'))
    }, edit: async dir => {
      await fs.writeFile(path.join(dir, 'shared/a.txt'), lines(10, { 9: 'identical nine' }))
      await fs.writeFile(path.join(dir, 'shared/b.txt'), lines(10, { 9: 'b fixed' }))
    } })
    const twinFile = name => path.join(twins.f.issuePath, 'framework/modules', name)
    await fs.writeFile(twinFile('a.txt'), lines(10, { 9: 'identical nine' }))
    await fs.writeFile(twinFile('b.txt'), lines(10, { 1: 'b by hand' }))
    const movedTwin = (await twins.deliver({ beforeApply: () => fs.writeFile(twinFile('a.txt'), 'moved after merge\n') })).application
    t.ok('an identical path moved before the write never reads as delivered', movedTwin.state !== 'complete' && movedTwin.verified !== true, JSON.stringify([movedTwin.state, movedTwin.error]))
    t.eq('the move is kept and nothing was written to the merged path', [await fs.readFile(twinFile('a.txt'), 'utf8'), await fs.readFile(twinFile('b.txt'), 'utf8')], ['moved after merge\n', lines(10, { 1: 'b by hand' })])
    const steady = await twins.deliver()
    t.eq('left alone, the next delivery is not claimed complete either', steady.application.state !== 'complete', true, JSON.stringify(steady.application.state))
  }

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
