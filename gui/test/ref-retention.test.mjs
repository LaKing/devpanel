import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRun, worktreeDiffDelivery, releaseOwnership } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { supportedActions, createSupervisor } from '../server/supervisor.mjs'
import { currentOwner } from '../server/runtime/lock.mjs'
import { applyRetirement, listRefs, parseRef, planDeletedRun, RefRetirementAborted, retireRefs, scanRetirement, strictGit } from '../server/runtime/ref-retention.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
const gitIn = async (repo, ...args) => (await exec('git', ['--git-dir', repo, ...args])).stdout
export const name = 'ref-retention — which refs/devpanel/* of a run may go, and how they go (execution-contract.md "Retiring refs/devpanel/*")'

const P = 'devpanel-project'
const sha = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')

/*
 * One real run of the implementation playbook delivered by apply-to-source: the
 * author changes server.mjs and adds an executable tool.sh, nothing drifts, the
 * patch is applied to the checkout. Its refs (base, candidates, reviewed) are in
 * the project's repository. Every case below starts from this record, edited.
 */
async function delivered () {
  let engine
  const script = scriptFor()
  const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async (turn) => {
    if (turn.stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), 'console.log("delivered")\n')
      await fs.writeFile(path.join(engine.run.workspace.path, 'tool.sh'), '#!/bin/sh\necho tool\n', { mode: 0o755 })
    }
    return script(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
  } })
  await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("original")\n')
  await git(f.projectPath, 'add', '-A')
  await git(f.projectPath, 'commit', '-qm', 'source')
  const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'opus-5' } } }
  const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: P, runOptions: options })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({ ...f, issue: { ...f.issue, project: P }, deliveryProvider: worktreeDiffDelivery, expectConfigHash: resolved.resolved.configHash, runOptions: options })
  await engine.drive()
  await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  const runId = engine.runId
  const runDir = path.join(f.issuePath, 'runs', runId)
  const file = path.join(runDir, 'run.json')
  // The retained worktree is what gc-runs would remove; the record then says so.
  const record = JSON.parse(await fs.readFile(file, 'utf8'))
  record.workspace.state = 'removed'
  await fs.writeFile(file, JSON.stringify(record, null, 2))
  const repository = await fs.realpath(path.join(f.projectPath, '.git'))
  return { f, runId, runDir, file, repository, original: await fs.readFile(file) }
}

export default async function (t) {
  const temps = []
  const temp = async (prefix) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir }
  try {
    const d = await delivered()
    const { f, runId, runDir, file, repository } = d
    const repositories = [{ repository, projects: [P] }]
    const scan = async () => (await scanRetirement({ issuesRoot: f.issuesDir, repositories, actionsOf: supportedActions })).reports[0]
    const aborted = async (fn) => { try { await fn(); return null } catch (error) { return error } }
    const record = async () => JSON.parse(await fs.readFile(file, 'utf8'))
    const restore = () => fs.writeFile(file, d.original)
    // Edit the record, scan, put it back: the one reason every ref of the run was kept for.
    const keptFor = async (mutate) => {
      const run = await record()
      await mutate(run)
      await fs.writeFile(file, JSON.stringify(run, null, 2))
      try {
        const report = await scan()
        return { reasons: Object.keys(report.kept), retire: report.retire.length }
      } finally { await restore() }
    }
    const refsNow = async (repo = repository) => (await listRefs(repo)).map((r) => r.ref).sort()
    const runRefs = (await refsNow()).filter((r) => parseRef(r)?.runId === runId)

    t.section('the fixture: a real apply-to-source delivery, its refs written for its run')
    {
      const run = await record()
      t.eq('delivered, verified, exact', [run.status, run.delivery.action, run.delivery.application.state, run.delivery.application.verified], ['completed', 'apply-to-source', 'complete', true])
      t.eq('its refs: base, candidates, reviewed', runRefs.map((r) => r.split('/')[2]).sort(), ['base', 'candidates', 'reviewed'])
      t.eq('the delivery offers nothing but a new run', supportedActions(run), ['start-new'])
    }

    t.section('delivered but not committed: kept; committed with the delivered mode: listed (AC4 read-only)')
    {
      const before = await scan()
      t.eq('uncommitted delivery is not proof', [before.retire.length, Object.keys(before.kept)], [0, ['not-committed']])
      // The source commits server.mjs and tool.sh, but tool.sh without its executable bit.
      await fs.chmod(path.join(f.projectPath, 'tool.sh'), 0o644)
      await git(f.projectPath, 'add', '-A')
      await git(f.projectPath, 'commit', '-qm', 'committed without the mode')
      t.eq('the blob is committed but the delivered mode is not: kept', Object.keys((await scan()).kept), ['not-committed'])
      await fs.chmod(path.join(f.projectPath, 'tool.sh'), 0o755)
      await git(f.projectPath, 'add', '-A')
      await git(f.projectPath, 'commit', '-qm', 'committed as delivered')
      const tree = async () => (await exec('find', [f.issuesDir, '-printf', '%p %s %T@\n'])).stdout
      const issuesBefore = await tree()
      const refsBefore = await refsNow()
      const listed = await scan()
      t.eq('committed as delivered: every ref of the run is listed', listed.retire.map((r) => r.ref).sort(), runRefs)
      t.eq('with its oid and run', listed.retire.every((r) => r.runId === runId && /^[0-9a-f]{40}$/.test(r.oid)), true)
      t.eq('the listing removed nothing', await refsNow(), refsBefore)
      t.eq('and wrote nothing under issues/', await tree(), issuesBefore)
    }

    t.section('AC5: each case that still needs its refs keeps them')
    {
      const cases = [
        ['live (status)', (r) => { r.status = 'running' }, 'live'],
        ['paused', (r) => { r.status = 'paused'; r.pause = { kind: 'manual', id: 'p1' } }, 'paused'],
        ['in recovery', (r) => { r.status = 'blocked'; r.blockedReason = 'recovery-required'; r.recovery = { required: true, reason: 'owner lost' } }, 'recovery'],
        ['a pending invocation', (r) => { Object.values(r.participants)[0].pendingInvocation = { id: 'x' } }, 'recovery'],
        ['resumable', (r) => { r.status = 'failed'; r.preflight = { ...(r.preflight ?? {}), state: 'passed' }; r.workspace.state = 'retained' }, 'resumable'],
        ['finalize-able', (r) => { r.status = 'blocked'; r.blockedReason = 'delivery-unverifiable'; r.workspace.state = 'retained' }, 'finalize-able'],
        ['reconcile-pending', (r) => { r.status = 'blocked'; r.blockedReason = 'source-delivery-blocked'; r.autoReconcile = { state: 'pending', at: 'now' } }, 'reconcile-pending'],
        ['integration-pending (publishing)', (r) => { r.integration = { phase: 'publishing' } }, 'integration-pending'],
        ['integration-pending (integrate offered)', (r) => { r.delivery = { ...r.delivery, action: 'commit', commit: 'b'.repeat(40) }; delete r.delivery.application }, 'integration-pending'],
        ['a delivery return in flight', (r) => { r.pendingDeliveryReturn = { from: {} } }, 'delivery-return-pending'],
        ['a retained worktree', (r) => { r.workspace.state = 'retained' }, 'worktree-retained'],
        ['no candidate ever delivered', (r) => { delete r.delivery }, 'not-delivered'],
        ['worktree-diff delivery', (r) => { r.delivery.action = 'worktree-diff' }, 'not-delivered'],
        ['applied later as an artifact', (r) => { r.artifactApplication = { verified: true } }, 'not-delivered'],
        ['landed by hand', (r) => { r.landed = { by: 'x' } }, 'not-delivered'],
        ['a merged delivery', (r) => { r.delivery.application.merged = [{ path: 'server.mjs' }] }, 'not-exact-delivery'],
        ['an owner-routed delivery', (r) => { r.delivery.application.owners = [] }, 'not-exact-delivery'],
        ['the record names another run', (r) => { r.runId = '2026-01-01T00-00-00-000Z-0000beef' }, 'ambiguous-record'],
        ['the record names another issue', (r) => { r.issue.id = 'another-issue' }, 'ambiguous-record'],
        ['the record names another project', (r) => { r.issue.project = 'another-project' }, 'ambiguous-record'],
        ['the record has no run id', (r) => { delete r.runId }, 'ambiguous-record'],
        ['its refs were written in another repository', async (r) => { const other = await temp('rr-other-'); await exec('git', ['init', '-q', other]); r.workspace.source.repository = await fs.realpath(path.join(other, '.git')); if (r.workspace.repository) r.workspace.repository.source = r.workspace.source.repository }, 'repository-mismatch']
      ]
      for (const [label, mutate, reason] of cases) {
        const got = await keptFor(mutate)
        t.eq(`${label}: kept as ${reason}`, got, { reasons: [reason], retire: 0 })
      }
      t.eq('after every case the record is restored and listed again', (await scan()).retire.length, runRefs.length)
    }

    t.section('AC5: live lock, carry-forward seed, unreadable records, publication journal')
    {
      const lock = path.join(f.issuePath, '.run.lock')
      await fs.writeFile(lock, JSON.stringify({ purpose: 'run', owner: await currentOwner(runId) }))
      t.eq('a live owner of the run lock: kept as live', Object.keys((await scan()).kept), ['live'])
      await fs.rm(lock)

      const pub = path.join(runDir, 'publication.json')
      const hadPub = await fs.readFile(pub).catch(() => null)
      await fs.writeFile(pub, JSON.stringify({ phase: 'publishing' }))
      t.eq('a publication still publishing: kept as integration-pending', Object.keys((await scan()).kept), ['integration-pending'])
      if (hadPub) await fs.writeFile(pub, hadPub); else await fs.rm(pub)

      // An approved candidate whose delivery did not complete seeds the next run.
      t.eq('the carry-forward seed: kept', (await keptFor((r) => { r.closure.conditions = { ...r.closure.conditions, deliveryCompleted: false } })).reasons, ['carry-forward-seed'])

      await fs.writeFile(file, '{ not json')
      t.eq('an unreadable run.json: kept', Object.keys((await scan()).kept), ['unreadable-record'])
      await restore()

      const sibling = path.join(f.issuePath, 'runs', '2026-01-01T00-00-00-000Z-0000aaaa')
      await fs.mkdir(sibling)
      await fs.writeFile(path.join(sibling, 'run.json'), 'garbage')
      t.eq('a sibling run unreadable: the seed cannot be judged, kept', Object.keys((await scan()).kept), ['issue-has-unreadable-record'])
      await fs.rm(sibling, { recursive: true })

      const events = path.join(runDir, 'events.jsonl')
      const journal = await fs.readFile(events)
      await fs.appendFile(events, '{"broken')
      t.eq('a damaged journal: kept as unreadable', Object.keys((await scan()).kept), ['unreadable-record'])
      t.eq('and the read wrote no recovery finding', await fs.access(path.join(runDir, 'journal-recovery.json')).then(() => true, () => false), false)
      await fs.writeFile(events, journal)
    }

    t.section('AC5: packed and archived issues keep their refs')
    {
      const marker = path.join(f.issuePath, '.archive.json')
      await fs.writeFile(marker, JSON.stringify({ archivedAt: new Date().toISOString() }))
      t.eq('an archived folder: kept', Object.keys((await scan()).kept), ['archived-issue'])
      await fs.rm(marker)
      // Packed: the folder is gone from the project, a bundle stands in .archive/. Nothing is read from it.
      const away = await temp('rr-packed-')
      const bundleDir = path.join(f.issuesDir, '.archive', P)
      await fs.mkdir(bundleDir, { recursive: true })
      await fs.writeFile(path.join(bundleDir, `${f.issue.id}.tar.gz`), 'not read')
      await fs.rename(f.issuePath, path.join(away, 'issue'))
      t.eq('a packed issue: its run is unattributed, kept', [(await scan()).retire.length, Object.keys((await scan()).kept)], [0, ['unattributed']])
      await fs.rename(path.join(away, 'issue'), f.issuePath)
      await fs.rm(path.join(f.issuesDir, '.archive'), { recursive: true })
    }

    t.section('patch binding: the patch must be the delivered one, and the whole of it')
    {
      const patchFile = path.join(runDir, (await record()).delivery.artifactRef)
      const patch = await fs.readFile(patchFile)
      const withPatch = async (bytes, mutate = () => {}) => {
        await fs.writeFile(patchFile, bytes)
        try { return (await keptFor(mutate)).reasons } finally { await fs.writeFile(patchFile, patch) }
      }
      t.eq('one byte changed: hash mismatch', await withPatch(Buffer.concat([patch, Buffer.from(' ')])), ['patch-unverified'])
      const first = patch.toString('utf8').split(/(?=^diff --git )/m)[0]
      t.eq('truncated to one file, its hash recomputed: the paths are not changedPaths', await withPatch(Buffer.from(first), (r) => { r.delivery.application.patchHash = sha(Buffer.from(first)) }), ['patch-unverified'])
      t.eq('empty, its hash recomputed', await withPatch(Buffer.alloc(0), (r) => { r.delivery.application.patchHash = sha(Buffer.alloc(0)) }), ['patch-unverified'])
      t.eq('changedPaths naming one more path', (await keptFor((r) => { r.delivery.changedPaths.push('extra.txt') })).reasons, ['patch-unverified'])
      t.eq('no recorded patch hash', (await keptFor((r) => { delete r.delivery.application.patchHash })).reasons, ['patch-unverified'])
    }

    t.section('destination binding: the recorded checkout and repository, nothing else')
    {
      // Another checkout holding exactly the delivered bytes at HEAD stands where the destination was.
      const impostor = await temp('rr-impostor-')
      await exec('git', ['init', '-q', '-b', 'main', impostor])
      await git(impostor, 'config', 'user.email', 't@e.invalid')
      await git(impostor, 'config', 'user.name', 'T')
      await fs.copyFile(path.join(f.projectPath, 'server.mjs'), path.join(impostor, 'server.mjs'))
      await fs.copyFile(path.join(f.projectPath, 'tool.sh'), path.join(impostor, 'tool.sh'))
      await git(impostor, 'add', '-A')
      await git(impostor, 'commit', '-qm', 'same bytes')
      const real = await fs.realpath(impostor)
      t.eq('a checkout path that now names another repository: destination-mismatch', (await keptFor((r) => { r.workspace.source.path = real; r.delivery.application.path = real })).reasons, ['destination-mismatch'])
      t.eq('a recorded checkout that is gone: destination-mismatch', (await keptFor((r) => { r.workspace.source.path = path.join(real, 'gone'); r.delivery.application.path = r.workspace.source.path })).reasons, ['destination-mismatch'])
    }

    t.section('a deleted path must be absent, tree or leaf (auditor-1-deletion-proof-hides-tree)')
    {
      // The delivery deleted gone.txt; HEAD later holds a directory at that exact path.
      const headBefore = (await git(f.projectPath, 'rev-parse', 'HEAD')).trim()
      const patchFile = path.join(runDir, (await record()).delivery.artifactRef)
      const patch = await fs.readFile(patchFile)
      const blob = (await exec('sh', ['-c', `printf 'x\\n' | git -C '${f.projectPath}' hash-object --stdin`])).stdout.trim()
      const deletion = Buffer.from(`diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex ${blob}..${'0'.repeat(40)}\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n`)
      await fs.writeFile(patchFile, deletion)
      const run = await record()
      run.delivery.changedPaths = ['gone.txt']
      run.delivery.application.patchHash = sha(deletion)
      await fs.writeFile(file, JSON.stringify(run, null, 2))
      await fs.mkdir(path.join(f.projectPath, 'gone.txt'))
      await fs.writeFile(path.join(f.projectPath, 'gone.txt', 'child'), 'later\n')
      await git(f.projectPath, 'add', '-A')
      await git(f.projectPath, 'commit', '-qm', 'a directory where the deleted file was')
      t.eq('a directory at the deleted path: kept, not-committed', Object.keys((await scan()).kept), ['not-committed'])
      await git(f.projectPath, 'rm', '-rq', 'gone.txt')
      await git(f.projectPath, 'commit', '-qm', 'gone for real')
      t.eq('the path absent at HEAD: the deletion proves', (await scan()).retire.length, runRefs.length)
      await fs.writeFile(patchFile, patch)
      await restore()
      await git(f.projectPath, 'reset', '-q', '--hard', headBefore)
      t.eq('the delivered patch back: listed as before', (await scan()).retire.length, runRefs.length)
    }

    t.section('no read lazily fetches into a partial clone (auditor-1-preview-lazy-fetch)')
    {
      const origin = await temp('rr-origin-')
      await exec('git', ['init', '-q', '-b', 'main', origin])
      await fs.writeFile(path.join(origin, 'a.txt'), 'a\n')
      await git(origin, 'add', '-A')
      await git(origin, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'a')
      await git(origin, 'config', 'uploadpack.allowFilter', 'true')
      const clone = path.join(await temp('rr-partial-'), 'clone')
      await exec('git', ['clone', '-q', '--no-checkout', '--filter=tree:0', `file://${origin}`, clone])
      const packs = async () => (await fs.readdir(path.join(clone, '.git', 'objects', 'pack'))).filter((n) => n.endsWith('.pack')).length
      const before = await packs()
      const head = (await git(clone, 'rev-parse', 'HEAD')).trim()
      const missing = await aborted(() => strictGit(['--git-dir', path.join(clone, '.git'), 'ls-tree', '-r', '-t', '-z', '--full-tree', head]))
      t.ok('the tree read on a missing tree aborts instead of fetching', missing instanceof RefRetirementAborted && missing.kind === 'git-failed', missing?.message)
      t.eq('and nothing was written into the clone', await packs(), before)
      await git(clone, 'ls-tree', head)
      t.ok('(the fixture is real: an ordinary read does fetch)', await packs() > before)
    }

    t.section('replacement objects are never read (auditor-1-replacement-tree-proof)')
    {
      // HEAD's tree is replaced by one whose server.mjs is something else: the original tree still proves.
      const head = (await git(f.projectPath, 'rev-parse', 'HEAD')).trim()
      const original = (await git(f.projectPath, 'rev-parse', 'HEAD^{tree}')).trim()
      const blob = (await exec('sh', ['-c', `printf 'other' | git -C '${f.projectPath}' hash-object -w --stdin`])).stdout.trim()
      const forged = (await exec('sh', ['-c', `git -C '${f.projectPath}' ls-tree ${head} | sed 's/[0-9a-f]\\{40\\}\\tserver.mjs$/${blob}\\tserver.mjs/' | git -C '${f.projectPath}' mktree`])).stdout.trim()
      await git(f.projectPath, 'replace', original, forged)
      t.eq('with a forged replacement in place, the committed original still proves', (await scan()).retire.length, runRefs.length)
      await git(f.projectPath, 'replace', '-d', original)
      // The auditor's direction: the commit holds the old bytes, the replacement the delivered ones.
      await git(f.projectPath, 'reset', '-q', '--hard', 'HEAD~2')
      const oldTree = (await git(f.projectPath, 'rev-parse', 'HEAD^{tree}')).trim()
      await fs.writeFile(path.join(f.projectPath, 'server.mjs'), 'console.log("delivered")\n')
      await fs.writeFile(path.join(f.projectPath, 'tool.sh'), '#!/bin/sh\necho tool\n', { mode: 0o755 })
      await git(f.projectPath, 'add', '-A')
      const deliveredTree = (await git(f.projectPath, 'write-tree')).trim()
      await git(f.projectPath, 'reset', '-q')
      await git(f.projectPath, 'replace', oldTree, deliveredTree)
      t.eq('an uncommitted tree registered as HEAD\'s replacement: kept, not-committed', Object.keys((await scan()).kept), ['not-committed'])
      await git(f.projectPath, 'replace', '-d', oldTree)
      await git(f.projectPath, 'add', '-A')
      await git(f.projectPath, 'commit', '-qm', 'committed as delivered, again')
      t.eq('committed for real: listed again', (await scan()).retire.length, runRefs.length)
    }

    t.section('AC3: an enumeration error or a Git warning aborts, never a zero')
    {
      const tag = path.join(f.projectPath, '.git', 'refs', 'tags', 'HEAD')
      await git(f.projectPath, 'update-ref', 'refs/tags/HEAD', 'HEAD')
      const ambiguous = await aborted(scan)
      t.ok('an ambiguous HEAD aborts as a warning naming rev-parse', ambiguous instanceof RefRetirementAborted && ambiguous.kind === 'git-warning' && /rev-parse/.test(ambiguous.command) && /refname 'HEAD' is ambiguous/.test(ambiguous.stderr), ambiguous?.message)
      const applied = await aborted(() => applyRetirement({ issuesRoot: f.issuesDir, repositories, actionsOf: supportedActions }))
      t.ok('apply aborts the same way', applied?.kind === 'git-warning', applied?.message)
      t.eq('and nothing was retired', (await refsNow()).filter((r) => parseRef(r)?.runId === runId), runRefs)
      await fs.rm(tag)

      const grafts = path.join(f.projectPath, '.git', 'info', 'grafts')
      await fs.mkdir(path.dirname(grafts), { recursive: true })
      await fs.writeFile(grafts, (await git(f.projectPath, 'rev-parse', 'HEAD')).trim() + '\n')
      const grafted = await aborted(scan)
      t.ok('a grafts file aborts as a warning', grafted?.kind === 'git-warning', grafted?.message)
      await fs.rm(grafts)

      const broken = path.join(f.projectPath, '.git', 'refs', 'devpanel', 'base', 'BROKEN')
      await fs.writeFile(broken, 'garbage\n')
      const brokenRef = await aborted(scan)
      t.ok('a broken ref (exit 0, a warning) aborts the listing', brokenRef?.kind === 'git-warning' && /ignoring broken ref/.test(brokenRef.stderr), brokenRef?.message)
      await fs.rm(broken)

      const extra = path.join(f.issuesDir, P, '2026-11-24-another-issue')
      await fs.mkdir(path.join(extra, 'runs'), { recursive: true })
      await fs.chmod(path.join(extra, 'runs'), 0o000)
      const runsUnreadable = await aborted(scan)
      t.ok('a runs directory that cannot be listed aborts (the seed is never guessed)', runsUnreadable?.kind === 'enumeration' && runsUnreadable.at?.issue === '2026-11-24-another-issue', runsUnreadable?.message)
      await fs.chmod(path.join(extra, 'runs'), 0o755)
      await fs.chmod(path.join(f.issuesDir, P), 0o000)
      const projectUnreadable = await aborted(scan)
      t.ok('a project directory that cannot be listed aborts', projectUnreadable?.kind === 'enumeration', projectUnreadable?.message)
      await fs.chmod(path.join(f.issuesDir, P), 0o755)
      await fs.rm(extra, { recursive: true })

      const missing = await aborted(() => scanRetirement({ issuesRoot: path.join(f.issuesDir, 'nope'), repositories, actionsOf: supportedActions }))
      t.ok('an issues root that cannot be listed aborts', missing?.kind === 'enumeration', missing?.message)
      t.eq('after the faults are gone, the listing is whole again', (await scan()).retire.length, runRefs.length)
    }

    t.section('other refs: symbolic, other shapes, other runs are kept')
    {
      const other = '2026-01-02T00-00-00-000Z-0000cccc'
      await git(f.projectPath, 'symbolic-ref', `refs/devpanel/base/${other}`, 'refs/heads/main')
      await git(f.projectPath, 'update-ref', 'refs/devpanel/tmp/x', 'HEAD')
      await git(f.projectPath, 'update-ref', `refs/devpanel/reviewed/2026-01-03T00-00-00-000Z-0000dddd`, 'HEAD')
      const report = await scan()
      t.eq('kept: symbolic, other shape, unattributed', [report.kept.symbolic, report.kept['other-shape'], report.kept.unattributed], [1, 1, 1])
      t.eq('the run\'s own refs are still listed', report.retire.length, runRefs.length)
      await git(f.projectPath, 'symbolic-ref', '-d', `refs/devpanel/base/${other}`)
      await git(f.projectPath, 'update-ref', '-d', 'refs/devpanel/tmp/x')
    }

    t.section('the reftable preview (auditor-1-preview-unsupported-format)')
    {
      const rt = await temp('rr-reftable-')
      await exec('git', ['init', '-q', '--ref-format=reftable', rt])
      await git(rt, '-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-q', '--allow-empty', '-m', 'x')
      await git(rt, 'update-ref', `refs/devpanel/base/${runId}`, 'HEAD')
      const report = (await scanRetirement({ issuesRoot: f.issuesDir, repositories: [{ repository: path.join(rt, '.git'), projects: [P] }], actionsOf: supportedActions })).reports[0]
      t.eq('nothing listed, and why', [report.refFormat, report.blocked, report.retire, report.kept], ['reftable', 'unsupported-ref-format', [], { 'unsupported-ref-format': 1 }])
      const result = await retireRefs({ repository: await fs.realpath(path.join(rt, '.git')), selected: [{ ref: `refs/devpanel/base/${runId}`, oid: (await git(rt, 'rev-parse', 'HEAD')).trim() }] })
      t.eq('and retireRefs deletes nothing there', [result.retired, result.blocked, (await git(rt, 'for-each-ref', 'refs/devpanel/')).trim().split('\n').length], [[], 'unsupported-ref-format', 1])
    }

    t.section('AC2: the transaction keeps what changed concurrently')
    {
      const selected = (await listRefs(repository)).filter((r) => parseRef(r.ref)?.runId === runId).map(({ ref, oid }) => ({ ref, oid }))
      const base = selected.find((s) => s.ref.includes('/base/'))
      const head = (await git(f.projectPath, 'rev-parse', 'HEAD')).trim()

      // A captured oid that no longer matches (the ref moved before the lock): that ref stays, the rest go.
      const stale = await retireRefs({ repository, selected: selected.map((s) => s === base ? { ...s, oid: head } : s) })
      t.eq('a moved ref is reported changed and kept', [stale.changed, stale.retired.length], [[base.ref], selected.length - 1])
      t.eq('only that ref remains', (await refsNow()).filter((r) => parseRef(r)?.runId === runId), [base.ref])
      // Put the others back for what follows.
      for (const s of selected) await gitIn(repository, 'update-ref', s.ref, s.oid)

      // Moved after the under-lock listing, before prepare: the expected-oid delete refuses and nothing goes.
      const moved = await retireRefs({ repository, selected, hooks: { beforePrepare: () => gitIn(repository, 'update-ref', base.ref, head) } })
      t.eq('moved before prepare: changed, nothing deleted', [moved.retired, moved.changed.length], [[], selected.length])
      t.eq('every ref is still there', (await refsNow()).filter((r) => parseRef(r)?.runId === runId).length, selected.length)
      await gitIn(repository, 'update-ref', base.ref, base.oid)

      // Replaced after the final listing by a same-oid symref to a branch: the prepared re-check aborts.
      await gitIn(repository, 'update-ref', 'refs/heads/same', base.oid)
      const swapped = await retireRefs({ repository, selected, hooks: { beforePrepare: async () => { await gitIn(repository, 'update-ref', '-d', base.ref); await gitIn(repository, 'symbolic-ref', base.ref, 'refs/heads/same') } } })
      t.eq('a symref swapped in after the listing: aborted as changed', [swapped.retired, swapped.changed], [[], [base.ref]])
      const after = await listRefs(repository, [base.ref])
      t.eq('the symref stays, and the branch behind it', [after[0]?.symref, (await gitIn(repository, 'rev-parse', 'refs/heads/same')).trim()], ['refs/heads/same', base.oid])
      t.eq('no other selected ref was deleted', (await refsNow()).filter((r) => parseRef(r)?.runId === runId).length, selected.length)
      await gitIn(repository, 'symbolic-ref', '-d', base.ref)
      await gitIn(repository, 'update-ref', base.ref, base.oid)
      await gitIn(repository, 'update-ref', '-d', 'refs/heads/same')

      // A Git warning while prepared is an error, not drift: the transaction is aborted.
      const looseBase = path.join(repository, base.ref)
      const warned = await aborted(() => retireRefs({ repository, selected, hooks: { afterPrepare: () => fs.writeFile(looseBase, 'garbage\n') } }))
      t.ok('a warning in the prepared re-check aborts as git-warning', warned?.kind === 'git-warning', warned?.message)
      await fs.writeFile(looseBase, base.oid + '\n')
      t.eq('and nothing was deleted', (await refsNow()).filter((r) => parseRef(r)?.runId === runId).length, selected.length)

      // The update-ref child itself says something on stderr: no commit after a warning (auditor-1-retirement-git-warnings).
      const realGit = (await exec('sh', ['-c', 'command -v git'])).stdout.trim()
      const wrapperDir = await temp('rr-wrapper-')
      await fs.writeFile(path.join(wrapperDir, 'git'), `#!/bin/sh\ncase " $* " in *" update-ref "*) echo "warning: injected diagnostic" >&2;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 })
      const savedPath = process.env.PATH
      process.env.PATH = `${wrapperDir}:${savedPath}`
      let childWarned
      try { childWarned = await aborted(() => retireRefs({ repository, selected })) } finally { process.env.PATH = savedPath }
      t.ok('a diagnostic from the update-ref child aborts as git-warning', childWarned?.kind === 'git-warning' && /injected diagnostic/.test(childWarned.stderr ?? ''), childWarned?.message)
      t.eq('and no selected ref was deleted', (await refsNow()).filter((r) => parseRef(r)?.runId === runId).length, selected.length)

      // While prepared, Git holds the locks: a writer fails, the commit then retires.
      let writer
      const done = await retireRefs({ repository, selected, hooks: { afterPrepare: async () => { writer = await exec('git', ['--git-dir', repository, 'symbolic-ref', base.ref, 'refs/heads/main']).then(() => 'wrote', (e) => e.stderr) } } })
      t.ok('a writer during prepare is refused on the ref lock', /cannot lock ref|File exists/.test(writer), writer)
      t.eq('and the commit retires every selected ref', [done.retired.sort(), done.changed], [selected.map((s) => s.ref).sort(), []])
      for (const s of selected) await gitIn(repository, 'update-ref', s.ref, s.oid)
    }

    t.section('only a folder the panel takes for an issue authorizes anything (auditor-1-non-issue-retirement)')
    {
      // The settled, verified run, its patch beside it, in a project folder named local-backup, its identity matching.
      const backup = path.join(f.issuesDir, P, 'local-backup')
      const away = path.join(await temp('rr-away-'), runId)
      await fs.mkdir(path.join(backup, 'runs'), { recursive: true })
      await fs.cp(runDir, path.join(backup, 'runs', runId), { recursive: true })
      const moved = JSON.parse(await fs.readFile(path.join(backup, 'runs', runId, 'run.json'), 'utf8'))
      moved.issue = { ...moved.issue, id: 'local-backup' }
      await fs.writeFile(path.join(backup, 'runs', runId, 'run.json'), JSON.stringify(moved))
      await fs.rename(runDir, away)
      const before = await refsNow()
      try {
        const report = await scan()
        t.eq('the listing offers nothing from it, and says why', [report.retire.length, report.kept['not-an-issue']], [0, runRefs.length])
        const projectsDir = await temp('rr-backup-projects-')
        await fs.symlink(f.projectPath, path.join(projectsDir, P))
        const code = await exec(process.execPath, ['tools/retire-refs.mjs', '--project', P, '--apply'], { cwd: path.resolve(import.meta.dirname, '..'),
          env: { ...process.env, DEVPANEL_ISSUES_DIR: f.issuesDir, DEVPANEL_PROJECTS_DIR: projectsDir } }).then(() => 0, (e) => e.code)
        t.eq('--project … --apply runs (exit 0)', code, 0)
        t.eq('and leaves every ref in place', await refsNow(), before)
        // A run id held by such a folder still counts as a holder: beside the real issue's run it is ambiguous.
        await fs.cp(away, runDir, { recursive: true })
        t.eq('beside the real issue\'s run, the same id there makes it ambiguous', (await scan()).kept.ambiguous, runRefs.length)
      } finally {
        await fs.rm(backup, { recursive: true, force: true })
        await fs.rm(runDir, { recursive: true, force: true })
        await fs.rename(away, runDir)
      }
      t.eq('the backup gone, the run is listed again', (await scan()).retire.length, runRefs.length)
    }

    t.section('the tool refuses a malformed scope before reading anything (auditor-1-apply-scope-missing)')
    {
      const projectsDir = await temp('rr-tool-projects-')
      await fs.symlink(f.projectPath, path.join(projectsDir, P))
      const tool = (...args) => exec(process.execPath, ['tools/retire-refs.mjs', ...args], { cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, DEVPANEL_ISSUES_DIR: f.issuesDir, DEVPANEL_PROJECTS_DIR: projectsDir } }).then(() => 0, (e) => e.code)
      const before = await refsNow()
      t.ok('the run\'s refs are eligible here, so a widened --apply would delete them', (await scan()).retire.length === runRefs.length)
      t.eq('--apply --project with no name: exit 1', await tool('--apply', '--project'), 1)
      t.eq('--apply --project --apply: exit 1', await tool('--apply', '--project', '--apply'), 1)
      t.eq('an unknown argument: exit 1', await tool('--apply', '--everything'), 1)
      t.eq('nothing was retired', await refsNow(), before)
      t.eq('a well-formed listing exits 0', await tool('--project', P), 0)
      t.eq('and, read-only, removes nothing', await refsNow(), before)
    }

    t.section('apply: proofs again under the lock; a destination that moved meanwhile keeps its refs')
    {
      const outsider = await refsNow()
      const moved = await applyRetirement({ issuesRoot: f.issuesDir, repositories, actionsOf: supportedActions, hooks: { beforeLock: async () => {
        await fs.writeFile(path.join(f.projectPath, 'unrelated.txt'), 'x')
        await git(f.projectPath, 'add', 'unrelated.txt')
        await git(f.projectPath, 'commit', '-qm', 'HEAD moves between the listing and the lock')
      } } })
      t.eq('HEAD moved between listing and lock: dropped as destination-mismatch, nothing retired', [moved[0].retired, [...new Set(moved[0].dropped.map((x) => x.reason))]], [[], ['destination-mismatch']])
      t.eq('the refs are all still there', await refsNow(), outsider)
      const applied = await applyRetirement({ issuesRoot: f.issuesDir, repositories, actionsOf: supportedActions })
      t.eq('a quiet apply retires the run\'s refs', applied[0].retired.sort(), runRefs)
      t.eq('and only those', await refsNow(), outsider.filter((r) => !runRefs.includes(r)))
      const relisted = await scan()
      t.eq('the listing after: nothing to retire, the rest counted', relisted.retire.length, 0)
    }

    t.section('deleteRun: the gates before removal, the captured refs after (auditor-1-delete-eligibility)')
    {
      // The same run id held by a live run in another open issue: deleting this one keeps the refs.
      for (const r of runRefs) await gitIn(repository, 'update-ref', r, 'HEAD')
      const dupIssue = path.join(f.issuesDir, P, '2026-11-24-duplicate-holder')
      await fs.mkdir(path.join(dupIssue, 'runs', runId), { recursive: true })
      const live = { ...(await record()), status: 'running' }
      live.issue = { ...live.issue, id: '2026-11-24-duplicate-holder' }
      await fs.writeFile(path.join(dupIssue, 'runs', runId, 'run.json'), JSON.stringify(live))
      const plan = await planDeletedRun({ issuesRoot: f.issuesDir, issuePath: f.issuePath, runId, actionsOf: supportedActions })
      t.eq('a run id held by two open issues: not eligible, ambiguous', [plan.eligible, plan.reason], [false, 'ambiguous'])
      const dupReport = await scan()
      t.eq('the listing says the same', [dupReport.kept.ambiguous, dupReport.retire.length], [runRefs.length, 0])
      await fs.rm(dupIssue, { recursive: true })

      const projectsDir = await temp('rr-projects-')
      await fs.symlink(f.projectPath, path.join(projectsDir, P))
      const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
      // A copy of the run, finalize-able: deleted, its refs kept.
      const keptId = '2026-01-04T00-00-00-000Z-0000eeee'
      await fs.cp(runDir, path.join(f.issuePath, 'runs', keptId), { recursive: true })
      const kept = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', keptId, 'run.json'), 'utf8'))
      Object.assign(kept, { runId: keptId, status: 'blocked', blockedReason: 'delivery-unverifiable' })
      kept.workspace.state = 'retained'
      kept.steps = []
      await fs.writeFile(path.join(f.issuePath, 'runs', keptId, 'run.json'), JSON.stringify(kept))
      const head = (await git(f.projectPath, 'rev-parse', 'HEAD')).trim()
      await git(f.projectPath, 'update-ref', `refs/devpanel/base/${keptId}`, head)
      const refused = await supervisor.deleteRun({ project: P, issueId: f.issue.id, runId: keptId }).then((r) => r, (e) => e)
      t.eq('a finalize-able run is deleted all the same', refused?.deleted, true, refused?.message)
      t.eq('but its refs are kept, and why', [refused?.refs?.kept, refused?.refs?.retired], ['finalize-able', []])
      t.ok('its base ref is still there', (await refsNow()).includes(`refs/devpanel/base/${keptId}`))

      // The delivered run itself (its refs back in place): every gate holds, its refs go with it.
      for (const r of runRefs) await gitIn(repository, 'update-ref', r, head)
      const before = await refsNow()
      const deleted = await supervisor.deleteRun({ project: P, issueId: f.issue.id, runId }).then((r) => r, (e) => e)
      t.eq('the delivered run is deleted', deleted?.deleted, true, deleted?.message)
      t.eq('and its refs retired in the same call', [deleted?.refs?.retired?.sort(), deleted?.refs?.error], [runRefs, null])
      t.eq('the other run\'s ref is untouched', await refsNow(), before.filter((r) => !runRefs.includes(r)))
      await supervisor.shutdown?.()
    }
  } finally {
    for (const dir of temps) await fs.chmod(dir, 0o755).catch(() => {})
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await cleanupFixtures()
  }
}
