import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { applyToSource } from '../server/runtime/source-delivery.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'

export const name = 'nested repositories (host settings nestedRepositories: include): a monorepo\'s parts in the snapshot, delivered in place'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout.trim()
const NL = String.fromCharCode(10)
const id = ['-c', 'user.email=t@t', '-c', 'user.name=T']

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  try {
    // A monorepo whose part src/sub is a repository of its own, untracked by
    // the outer one; the part has a committed file, an uncommitted change, a
    // new file, an ignored one and a repository nested in it in turn.
    async function monorepo () {
      const mono = await temp('nr-mono-')
      await git(mono, 'init', '-q', '-b', 'main')
      await fs.writeFile(path.join(mono, 'root.txt'), 'root' + NL)
      await git(mono, 'add', '-A'); await git(mono, ...id, 'commit', '-qm', 'mono')
      const sub = path.join(mono, 'src', 'sub')
      await fs.mkdir(sub, { recursive: true })
      await git(sub, 'init', '-q', '-b', 'main')
      await fs.writeFile(path.join(sub, 'a.txt'), 'v1' + NL)
      await fs.writeFile(path.join(sub, 'run.sh'), '#!/bin/sh' + NL, { mode: 0o755 })
      await fs.writeFile(path.join(sub, '.gitignore'), 'secret.env' + NL)
      await git(sub, 'add', '-A'); await git(sub, ...id, 'commit', '-qm', 'sub')
      await fs.writeFile(path.join(sub, 'a.txt'), 'v1 dirty' + NL)
      await fs.writeFile(path.join(sub, 'new.txt'), 'untracked' + NL)
      await fs.writeFile(path.join(sub, 'secret.env'), 'TOKEN=x' + NL)
      await fs.symlink('a.txt', path.join(sub, 'link'))
      const deep = path.join(sub, 'deep')
      await fs.mkdir(deep)
      await git(deep, 'init', '-q', '-b', 'main')
      await fs.writeFile(path.join(deep, 'd.txt'), 'deep' + NL)
      await git(deep, 'add', '-A'); await git(deep, ...id, 'commit', '-qm', 'deep')
      return { mono, sub }
    }
    async function provision (projectPath, policy) {
      const runs = await temp('nr-runs-')
      const runId = 'run-' + Math.random().toString(16).slice(2, 10)
      await fs.mkdir(path.join(runs, runId))
      const ws = await gitWorktreeProvider.create({ projectPath, runId, root: runs, policy: { repository: 1, base: 'working-tree', ...policy } })
      return { ws, runDir: path.join(runs, runId) }
    }

    t.section('1. by default a nested repository is a gitlink: an empty directory in the worktree')
    {
      const { mono } = await monorepo()
      const { ws } = await provision(mono, {})
      t.eq('nothing of it is in the worktree', (await fs.readdir(path.join(ws.path, 'src', 'sub')).catch(() => [])).length, 0)
      t.eq('and nothing is recorded', ws.base.nested, undefined)
    }

    for (const store of [false, true]) {
      t.section(`2${store ? 'b' : 'a'}. included${store ? ', with the panel\'s Git store' : ''}: the part is in the snapshot as the part would carry it`)
      const { mono, sub } = await monorepo()
      const partBefore = { status: await git(sub, 'status', '--porcelain'), index: await fs.readFile(path.join(sub, '.git', 'index')) }
      const data = store ? await temp('nr-data-') : null
      const { ws, runDir } = await provision(mono, { nested: 'include', ...(store ? { store: path.join(data, 'repos', 'm.git') } : {}) })
      const read = (rel) => fs.readFile(path.join(ws.path, rel), 'utf8')
      t.eq('its uncommitted change', await read('src/sub/a.txt'), 'v1 dirty' + NL)
      t.eq('its untracked file', await read('src/sub/new.txt'), 'untracked' + NL)
      t.ok('not what it ignores', !(await fs.stat(path.join(ws.path, 'src/sub/secret.env')).then(() => true, () => false)))
      t.ok('never its .git', !(await fs.stat(path.join(ws.path, 'src/sub/.git')).then(() => true, () => false)))
      t.eq('a link stays a link', await fs.readlink(path.join(ws.path, 'src/sub/link')), 'a.txt')
      t.ok('the executable bit is kept', ((await fs.stat(path.join(ws.path, 'src/sub/run.sh'))).mode & 0o100) !== 0)
      t.eq('a repository nested in it is read the same way', await read('src/sub/deep/d.txt'), 'deep' + NL)
      t.eq('the outer file is there as always', await read('root.txt'), 'root' + NL)
      t.eq('recorded on the base', ws.base.nested?.map((n) => n.path), ['src/sub'])
      t.eq('with the part\'s HEAD', ws.base.nested?.[0].head, await git(sub, 'rev-parse', 'HEAD'))
      const sourceRepo = ws.repository.source
      const mode = async (commit, rel) => (await exec('git', ['--git-dir', sourceRepo, 'ls-tree', commit, rel])).stdout.split(' ')[0]
      t.eq('the source base keeps the gitlink the outer repository records', await mode(ws.sourceBase, 'src/sub'), '160000')
      t.eq('the snapshot holds its content instead', await mode(ws.baseCommit, 'src/sub'), '040000')
      t.eq('the part\'s working tree is untouched by the snapshot', await git(sub, 'status', '--porcelain'), partBefore.status)
      t.ok('and so is its index', (await fs.readFile(path.join(sub, '.git', 'index'))).equals(partBefore.index))

      // An edit in the part and one outside it, delivered to the checkout.
      const baseline = await baselineOf(ws.path)
      await fs.writeFile(path.join(ws.path, 'src/sub/a.txt'), 'v2' + NL)
      await fs.writeFile(path.join(ws.path, 'src/sub/added.txt'), 'added' + NL)
      await fs.writeFile(path.join(ws.path, 'root.txt'), 'root 2' + NL)
      const fp = await fingerprint(ws.path, { baseline, baseCommit: ws.baseCommit })
      await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
      const args = { workspace: ws, workspacePath: ws.path, baseCommit: ws.baseCommit, baseline, fingerprint: fp, revision: fp.fingerprint, runDir }
      const subHead = await git(sub, 'rev-parse', 'HEAD')
      const monoHead = await git(mono, 'rev-parse', 'HEAD')
      const receipt = await worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' })
      t.eq('the patch reconstructs the candidate', receipt.reconstruction?.verified, true, JSON.stringify(receipt.reconstruction))
      const applied = await applyToSource({ ...args, receipt })
      t.eq('apply-to-source completes', applied.application?.state, 'complete', applied.application?.error)
      t.eq('verified against the approved revision', applied.application?.verified, true)
      t.eq('the part\'s file is changed in place', await fs.readFile(path.join(sub, 'a.txt'), 'utf8'), 'v2' + NL)
      t.eq('a new file lands in the part', await fs.readFile(path.join(sub, 'added.txt'), 'utf8'), 'added' + NL)
      t.eq('the outer file too', await fs.readFile(path.join(mono, 'root.txt'), 'utf8'), 'root 2' + NL)
      t.eq('the part sees them as its own uncommitted changes', (await git(sub, 'status', '--porcelain')).split(NL).map((l) => l.trim()).sort().join(','), '?? added.txt,?? deep/,?? link,?? new.txt,M a.txt')
      t.eq('its HEAD did not move', await git(sub, 'rev-parse', 'HEAD'), subHead)
      t.eq('nor the outer one', await git(mono, 'rev-parse', 'HEAD'), monoHead)
      t.eq('its ignored file is as it was', await fs.readFile(path.join(sub, 'secret.env'), 'utf8'), 'TOKEN=x' + NL)

      if (!store) {
        t.section('2c. a commit delivery that touches the part is refused, the reviewed commit kept')
        const { mono: m2 } = await monorepo()
        const { ws: w2, runDir: r2 } = await provision(m2, { nested: 'include' })
        const b2 = await baselineOf(w2.path)
        await fs.writeFile(path.join(w2.path, 'src/sub/a.txt'), 'v3' + NL)
        const f2 = await fingerprint(w2.path, { baseline: b2, baseCommit: w2.baseCommit })
        await fs.mkdir(path.join(r2, 'artifacts'), { recursive: true })
        const c2 = await worktreeDiffDelivery.deliver({ action: 'commit', revision: f2.fingerprint, fingerprint: f2, baseCommit: w2.baseCommit, baseline: b2, workspacePath: w2.path, workspace: w2, runDir: r2, label: 'test' })
        t.eq('the translation onto the outer history is refused', c2.publication?.translation, 'refused', JSON.stringify(c2.publication))
        t.eq('no branch is offered for a merge', c2.branch, null)
        t.ok('the reviewed commit is kept', Boolean(c2.reviewed))
      }
    }

    t.section('3. drift in the part since the snapshot is seen')
    {
      const { mono, sub } = await monorepo()
      const { ws, runDir } = await provision(mono, { nested: 'include' })
      const baseline = await baselineOf(ws.path)
      await fs.writeFile(path.join(ws.path, 'src/sub/a.txt'), 'v2' + NL)
      const fp = await fingerprint(ws.path, { baseline, baseCommit: ws.baseCommit })
      await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
      const args = { workspace: ws, workspacePath: ws.path, baseCommit: ws.baseCommit, baseline, fingerprint: fp, revision: fp.fingerprint, runDir }
      const receipt = await worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' })
      await fs.writeFile(path.join(sub, 'a.txt'), 'someone else' + NL)
      const refused = await applyToSource({ ...args, receipt })
      t.eq('a change to the patch\'s own path in the part blocks delivery', refused.application?.state, 'source-drift', refused.application?.error)
      t.eq('and nothing is written over it', await fs.readFile(path.join(sub, 'a.txt'), 'utf8'), 'someone else' + NL)
    }
  } finally {
    for (const d of temps) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}
