import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { launchPreconditions } from '../server/launch-preconditions.mjs'
import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import { SOURCE_LOCK_FILE, snapshotRepositories } from '../server/runtime/source-lock.mjs'

export const name = 'snapshot locks — a base snapshot holds the delivery lock of every repository it reads'

const exec = promisify(execFile)
const NL = String.fromCharCode(10)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=T', ...args])).stdout.trim()

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
  const repo = async (dir = null, file = 'file.txt') => {
    const root = dir ?? await temp('sl-repo-')
    await fs.mkdir(root, { recursive: true })
    await git(root, 'init', '-q', '-b', 'main')
    await write(path.join(root, file), 'committed' + NL)
    await git(root, 'add', '-A')
    await git(root, 'commit', '-qm', 'base')
    return root
  }
  const lockOf = async (root) => acquire(path.join(await fs.realpath(path.join(root, '.git')), SOURCE_LOCK_FILE), { purpose: 'test' })
  const projects = async (...roots) => {
    const dir = await temp('sl-projects-')
    for (const [i, root] of roots.entries()) await fs.symlink(root, path.join(dir, `p${i}-project`))
    return dir
  }
  const withProjects = async (dir, fn) => {
    const saved = process.env.DEVPANEL_PROJECTS_DIR
    process.env.DEVPANEL_PROJECTS_DIR = dir
    try { return await fn() } finally { if (saved === undefined) delete process.env.DEVPANEL_PROJECTS_DIR; else process.env.DEVPANEL_PROJECTS_DIR = saved }
  }
  const create = async (projectPath, policy, extra = {}) => gitWorktreeProvider.create({ projectPath, runId: `sl-${Math.random().toString(16).slice(2, 10)}`, root: await temp('sl-runs-'), policy: { base: 'working-tree', ...policy }, ...extra })
  /** The snapshot waits behind `lock`, and finishes once it is released. */
  const waitsBehind = async (label, lock, snapshot) => {
    let settled = false
    const cut = snapshot().finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 400))
    t.eq(`${label}: the snapshot waits`, settled, false)
    await lock.release()
    return cut
  }

  try {
    t.section('waits on the checkout\'s own repository')
    {
      const project = await repo()
      const cut = await waitsBehind('the checkout', await lockOf(project), () => create(project, {}))
      t.eq('and finishes, naming the lock it held', cut.base.snapshotLock.repositories, [await fs.realpath(path.join(project, '.git'))])
    }

    t.section('a head or commit base without materialize reads no live tree, and takes no lock')
    {
      const project = await repo()
      const held = await lockOf(project)
      try {
        const cut = await create(project, { base: 'head' })
        t.eq('it does not wait', cut.base.policy, 'head')
        t.eq('and records no lock', cut.base.snapshotLock, undefined)
      } finally { await held.release() }
    }

    t.section('waits on an owner behind a link')
    {
      const owner = await repo()
      await write(path.join(owner, 'modules/a.txt'), 'owned' + NL)
      await git(owner, 'add', '-A'); await git(owner, 'commit', '-qm', 'modules')
      const project = await repo()
      await fs.symlink(path.join(owner, 'modules'), path.join(project, 'shared'))
      const known = await projects(project, owner)
      const lock = await lockOf(owner)
      const cut = await withProjects(known, () => waitsBehind('the owner', lock, () => create(project, { symlinks: 'materialize', selection: 1 })))
      t.ok('it holds both repositories', cut.base.snapshotLock.repositories.includes(await fs.realpath(path.join(owner, '.git'))) && cut.base.snapshotLock.repositories.includes(await fs.realpath(path.join(project, '.git'))), JSON.stringify(cut.base.snapshotLock))
    }

    t.section('waits on a repository nested in a non-Git grant')
    {
      const grant = await temp('sl-grant-')
      await write(path.join(grant, 'plain.txt'), 'plain' + NL)
      const nested = await repo(path.join(grant, 'nested'), 'value.txt')
      const project = await repo()
      await fs.symlink(grant, path.join(project, 'data'))
      const known = await projects(project)
      const policy = { symlinks: 'materialize', selection: 1, materializeGrants: [{ path: grant, reason: 'test fixture' }] }
      const lock = await lockOf(nested)
      const cut = await withProjects(known, () => waitsBehind('the nested repository', lock, () => create(project, policy)))
      t.ok('it is among the locks it held', cut.base.snapshotLock.repositories.includes(await fs.realpath(path.join(nested, '.git'))), JSON.stringify(cut.base.snapshotLock))
      t.eq('and the grant itself lies in no repository', cut.base.snapshotLock.noRepository, ['data'])
    }

    t.section('waits on an include root, and on a repository nested in that root')
    {
      const project = await repo()
      const sub = await repo(path.join(project, 'src/sub'), 'a.txt')
      const deep = await repo(path.join(sub, 'deep'), 'd.txt')
      const policy = { nested: 'include' }
      const found = await snapshotRepositories(project, { base: 'working-tree', ...policy })
      t.eq('discovery names all three', found.repositories, [project, sub, deep].map((r) => path.join(r, '.git')).sort())
      const cut = await waitsBehind('the include root', await lockOf(sub), () => create(project, policy))
      t.eq('and it carries the part', await git(cut.path, 'show', 'HEAD:src/sub/a.txt'), 'committed')
      const again = await waitsBehind('the repository nested in it', await lockOf(deep), () => create(project, policy))
      t.eq('and the deeper part', await git(again.path, 'show', 'HEAD:src/sub/deep/d.txt'), 'committed')
    }

    t.section('a default gitlink takes no nested lock: delivery never moves a HEAD')
    {
      const project = await repo()
      const sub = await repo(path.join(project, 'sub'), 'a.txt')
      const held = await lockOf(sub)
      try {
        const cut = await create(project, {})
        t.eq('it does not wait for the nested repository', cut.base.snapshotLock.repositories, [path.join(project, '.git')])
      } finally { await held.release() }
    }

    t.section('the post-walk check refuses a repository discovery missed')
    {
      const grant = await temp('sl-grant-missed-')
      const nested = await repo(path.join(grant, 'nested'), 'value.txt')
      const project = await repo()
      await fs.symlink(grant, path.join(project, 'data'))
      const known = await projects(project)
      const policy = { symlinks: 'materialize', selection: 1, materializeGrants: [{ path: grant, reason: 'test fixture' }] }
      const discover = async () => ({ repositories: [path.join(project, '.git')], unidentified: [], noRepository: [] })
      const refused = await withProjects(known, () => create(project, policy, { discover })).then(() => null, (error) => error)
      t.eq('a grant', refused?.code, 'MOVING_WORKTREE', refused?.message)
      t.ok('naming the repository', (refused?.message ?? '').includes(path.join(nested, '.git')), refused?.message)
      const free = await lockOf(project)
      t.ok('no lock is left held', Boolean(free))
      await free.release()

      const mono = await repo()
      await repo(path.join(mono, 'sub'), 'a.txt')
      const missed = await create(mono, { nested: 'include' }, { discover: async () => ({ repositories: [path.join(mono, '.git')], unidentified: [], noRepository: [] }) }).then(() => null, (error) => error)
      t.eq('an include root', missed?.code, 'MOVING_WORKTREE', missed?.message)
    }

    t.section('an unidentifiable nested .git refuses')
    {
      const grant = await temp('sl-grant-bad-')
      await write(path.join(grant, 'part/a.txt'), 'a' + NL)
      await fs.writeFile(path.join(grant, 'part/.git'), 'gitdir: /nonexistent/nowhere' + NL)
      const linked = await repo()
      await fs.symlink(grant, path.join(linked, 'data'))
      const known = await projects(linked)
      const refused = await withProjects(known, () => create(linked, { symlinks: 'materialize', selection: 1, materializeGrants: [{ path: grant, reason: 'test fixture' }] })).then(() => null, (error) => error)
      t.eq('one inside a grant', refused?.code, 'SNAPSHOT_LOCK_UNAVAILABLE', refused?.message)
      t.ok('naming it and the remedy', /\.git entry/.test(refused?.message ?? '') && /write access/.test(refused?.message ?? ''), refused?.message)
    }

    t.section('a grant with no repository snapshots; nothing there is locked')
    {
      const grant = await temp('sl-grant-plain-')
      await write(path.join(grant, 'plain.txt'), 'plain' + NL)
      const project = await repo()
      await fs.symlink(grant, path.join(project, 'data'))
      const known = await projects(project)
      const cut = await withProjects(known, () => create(project, { symlinks: 'materialize', selection: 1, materializeGrants: [{ path: grant, reason: 'test fixture' }] }))
      t.eq('it is read, and recorded as lying in no repository', [cut.base.snapshotLock.noRepository, await fs.readFile(path.join(cut.path, 'data/plain.txt'), 'utf8')], [['data'], 'plain' + NL])
    }

    t.section('a link in an ignored tree is never materialized, so it causes no lock and no refusal')
    {
      const outside = await repo()
      const project = await repo()
      await fs.writeFile(path.join(project, '.gitignore'), 'node_modules/' + NL)
      await git(project, 'add', '-A'); await git(project, 'commit', '-qm', 'ignore')
      await fs.mkdir(path.join(project, 'node_modules'))
      await fs.symlink(outside, path.join(project, 'node_modules/dep'))
      const found = await withProjects(await projects(project), () => snapshotRepositories(project, { base: 'working-tree', symlinks: 'materialize', selection: 1 }))
      t.eq('only the checkout', found.repositories, [path.join(project, '.git')])
    }

    t.section('a repository this account cannot write is refused before preflight')
    if (process.getuid?.() === 0) t.skip('as root chmod does not bind')
    else {
      const workspace = { base: 'working-tree' }
      const source = await repo()
      await fs.chmod(path.join(source, '.git'), 0o555)
      try {
        const refused = await launchPreconditions({ projectPath: source, workspace })
        t.eq('the source', refused?.code, 'SNAPSHOT_LOCK_UNAVAILABLE', JSON.stringify(refused))
        t.ok('saying nothing was spent, and the remedy', /nothing was spent/.test(refused?.message ?? '') && /write access/.test(refused?.message ?? ''), refused?.message)
      } finally { await fs.chmod(path.join(source, '.git'), 0o755) }
      t.eq('writable again, nothing refuses', await launchPreconditions({ projectPath: source, workspace }), null)

      const owner = await repo()
      const linked = await repo()
      await fs.symlink(path.join(owner, 'file.txt'), path.join(linked, 'shared.txt'))
      await fs.chmod(path.join(owner, '.git'), 0o555)
      try {
        const refused = await withProjects(await projects(linked, owner), () => launchPreconditions({ projectPath: linked, workspace: { base: 'working-tree', symlinks: 'materialize' }, selection: 1 }))
        t.eq('an owner behind a link', refused?.code, 'SNAPSHOT_LOCK_UNAVAILABLE', JSON.stringify(refused))
      } finally { await fs.chmod(path.join(owner, '.git'), 0o755) }

      const grant = await temp('sl-grant-denied-')
      const nested = await repo(path.join(grant, 'nested'), 'value.txt')
      const granted = await repo()
      await fs.symlink(grant, path.join(granted, 'data'))
      await fs.chmod(path.join(nested, '.git'), 0o555)
      try {
        const refused = await withProjects(await projects(granted), () => launchPreconditions({ projectPath: granted, workspace: { base: 'working-tree', symlinks: 'materialize', materializeGrants: [{ path: grant, reason: 'test fixture' }] }, selection: 1 }))
        t.eq('a repository nested in a grant', refused?.code, 'SNAPSHOT_LOCK_UNAVAILABLE', JSON.stringify(refused))
      } finally { await fs.chmod(path.join(nested, '.git'), 0o755) }
    }

    t.section('a stop ends the wait')
    {
      const project = await repo()
      const held = await lockOf(project)
      const controller = new AbortController()
      const waiting = create(project, {}, { signal: controller.signal }).then(() => null, (error) => error)
      await new Promise((resolve) => setTimeout(resolve, 200))
      controller.abort()
      const stopped = await waiting
      t.eq('as an abort', stopped?.name, 'AbortError', stopped?.message)
      await held.release()
    }
  } finally {
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
