import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { fetchFromStore, gitStoreDir, isStoreOf } from '../server/runtime/git-store.mjs'

export const name = 'the panel\'s own Git store (host settings gitStore): snapshots, refs and candidate branches outside the project repository'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout.trim()
const NL = String.fromCharCode(10)

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  try {
    // A project with uncommitted work: a modified tracked file and an untracked one.
    const src = await temp('gs-proj-')
    await git(src, 'init', '-q', '-b', 'main'); await git(src, 'config', 'user.email', 't@t'); await git(src, 'config', 'user.name', 'T')
    await fs.writeFile(path.join(src, 'app.txt'), 'v1' + NL)
    await git(src, 'add', '-A'); await git(src, 'commit', '-qm', 'first')
    await fs.writeFile(path.join(src, 'app.txt'), 'v1 dirty' + NL)
    await fs.writeFile(path.join(src, 'new.txt'), 'untracked' + NL)
    const sourceGit = path.join(src, '.git')
    const state = async () => ({
      refs: await git(src, 'for-each-ref', '--format=%(refname) %(objectname)'),
      objects: (await fs.readdir(path.join(sourceGit, 'objects'), { recursive: true })).filter((f) => !f.startsWith('info')).sort().join(','),
      worktrees: await git(src, 'worktree', 'list', '--porcelain'),
      index: await fs.readFile(path.join(sourceGit, 'index')).then((b) => b.toString('base64')),
      status: await git(src, 'status', '--porcelain')
    })
    const before = await state()

    t.section('1. the setting: off by default, under dataRoot when on')
    t.eq('off without gitStore', gitStoreDir('x-project', { gitStore: false, dataRoot: '/d' }), null)
    t.eq('off without dataRoot', gitStoreDir('x-project', { gitStore: true, dataRoot: null }), null)
    t.eq('<dataRoot>/repos/<project>.git', gitStoreDir('x-project', { gitStore: true, dataRoot: '/d' }), '/d/repos/x-project.git')
    let invalid = null
    try { gitStoreDir('../x', { gitStore: true, dataRoot: '/d' }) } catch (e) { invalid = e }
    t.ok('a project identity that is not one path component is refused', invalid)

    t.section('2. a working-tree snapshot is built in the store, and the project repository is only read')
    const data = await temp('gs-data-')
    const storeDir = path.join(data, 'repos', 'x-project.git')
    const runs = await temp('gs-runs-')
    const runId = 'run-a1b2c3d4'
    await fs.mkdir(path.join(runs, runId))
    const ws = await gitWorktreeProvider.create({ projectPath: src, runId, root: runs, policy: { repository: 1, base: 'working-tree', store: storeDir } })
    const store = await fs.realpath(storeDir)
    t.eq('the worktree holds the uncommitted change', await fs.readFile(path.join(ws.path, 'app.txt'), 'utf8'), 'v1 dirty' + NL)
    t.eq('and the untracked file', await fs.readFile(path.join(ws.path, 'new.txt'), 'utf8'), 'untracked' + NL)
    t.eq('its parent is the project\'s HEAD', await git(store, 'rev-parse', `${ws.baseCommit}^`), await git(src, 'rev-parse', 'HEAD'))
    t.eq('the snapshot ref is in the store', await git(store, 'rev-parse', `refs/devpanel/base/${runId}`), ws.baseCommit)
    t.eq('the run\'s source repository is the store', ws.repository.source, store)
    t.eq('the destination checkout is still the project', ws.source.path, src)
    t.eq('the store reads the project\'s objects', (await fs.readFile(path.join(store, 'objects', 'info', 'alternates'), 'utf8')).trim(), await fs.realpath(path.join(sourceGit, 'objects')))
    t.eq('the store keeps no worktree registration either', (await fs.readdir(path.join(store, 'worktrees')).catch(() => [])).length, 0)
    const afterSnapshot = await state()
    t.eq('no ref was written in the project', afterSnapshot.refs, before.refs)
    t.eq('no object was written in the project', afterSnapshot.objects, before.objects)
    t.eq('no worktree is registered there', afterSnapshot.worktrees, before.worktrees)
    t.eq('its index is untouched', afterSnapshot.index, before.index)
    t.eq('its working tree too', afterSnapshot.status, before.status)
    t.ok('the snapshot object is absent from the project', !(await exec('git', ['-C', src, 'cat-file', '-e', ws.baseCommit]).then(() => true, () => false)))

    t.section('3. the delivered commit and its branch are published in the store')
    const baseline = await baselineOf(ws.path)
    await fs.writeFile(path.join(ws.path, 'app.txt'), 'v2' + NL)
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    const runDir = path.join(runs, runId)
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    const receipt = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir, label: 'test' })
    t.eq('verified', receipt.reconstruction?.verified, true, JSON.stringify(receipt.reconstruction))
    t.eq('the receipt names the store', receipt.repository, store)
    t.eq('the candidate branch is in the store', await git(store, 'rev-parse', `refs/heads/${receipt.branch}`), receipt.commit)
    t.eq('the reviewed ref too', await git(store, 'rev-parse', `refs/devpanel/reviewed/${runId}`), receipt.reviewed)
    const afterDelivery = await state()
    t.eq('still no ref in the project', afterDelivery.refs, before.refs)
    t.eq('nor any object', afterDelivery.objects, before.objects)

    t.section('4. an operator-approved merge brings the candidate over, objects only')
    t.ok('the store is recognised as the project\'s', await isStoreOf(store, sourceGit))
    const other = await temp('gs-other-')
    await git(other, 'init', '-q')
    t.ok('and as no other repository\'s', !(await isStoreOf(store, path.join(other, '.git'))))
    t.ok('the project itself is not a store', !(await isStoreOf(sourceGit, sourceGit)))
    await fetchFromStore({ source: src, store, branch: receipt.branch, commit: receipt.commit })
    t.eq('the candidate commit is now readable in the project', await git(src, 'cat-file', '-t', receipt.commit), 'commit')
    t.eq('with no ref written', (await state()).refs, before.refs)
    t.ok('and no FETCH_HEAD', !(await fs.stat(path.join(sourceGit, 'FETCH_HEAD')).then(() => true, () => false)))

    t.section('5. a later run reads the earlier snapshot through the store, as carry-forward does')
    const runId2 = 'run-e5f6a7b8'
    await fs.mkdir(path.join(runs, runId2))
    await fs.writeFile(path.join(src, 'app.txt'), 'v1 moved on' + NL)
    const ws2 = await gitWorktreeProvider.create({ projectPath: src, runId: runId2, root: runs, policy: { repository: 1, base: 'working-tree', store: storeDir } })
    t.eq('the second snapshot is in the same store', await git(store, 'rev-parse', `refs/devpanel/base/${runId2}`), ws2.baseCommit)
    // carry-forward.mjs reads the earlier run's base into a throwaway index
    // with GIT_DIR set to the run's source repository, which is the store here.
    const index = path.join(await temp('gs-index-'), 'index')
    const read = await exec('git', ['read-tree', ws.baseCommit], { cwd: ws2.path, env: { ...process.env, GIT_DIR: ws2.repository.source, GIT_WORK_TREE: ws2.path, GIT_INDEX_FILE: index } }).then(() => true, () => false)
    t.ok('the earlier base is readable through the store', read)
    t.eq('the second run\'s source repository is the store', ws2.repository.source, store)
    t.section('6. without the setting the project repository is the store, as before')
    const runId3 = 'run-c9d0e1f2'
    await fs.mkdir(path.join(runs, runId3))
    const ws3 = await gitWorktreeProvider.create({ projectPath: src, runId: runId3, root: runs, policy: { repository: 1, base: 'working-tree' } })
    t.eq('the snapshot ref is in the project', await git(src, 'rev-parse', `refs/devpanel/base/${runId3}`), ws3.baseCommit)
    t.eq('the run\'s source repository is the project\'s', ws3.repository.source, await fs.realpath(sourceGit))
  } finally {
    for (const d of temps) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}
