import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { committedBeyond, followedViews, motionOf, ownerOf, readCheckouts, readGit, snapshotDiff, snapshotRecord, testedViews, viewReader } from '../server/runtime/full-verification-snapshot.mjs'
import { manualClock } from '../server/runtime/clock.mjs'

export const name = 'full verification snapshot — the recheck of a checkout, a commit compared with the tested bytes across independent repositories, the version rule, and the readings around a snapshot (real git)'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' }).trim()
const MATERIALIZE = { base: 'working-tree', requireCleanBase: false, symlinks: 'materialize', selection: 0, repository: 0 }
const PLAIN = { base: 'working-tree', requireCleanBase: false, selection: 0, repository: 0 }

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fvs-'))
  const clock = manualClock(Date.parse('2026-11-15T09:00:00.000Z'))
  const repo = async (name, files) => {
    const dir = path.join(root, name)
    await fs.mkdir(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    for (const [rel, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await fs.writeFile(path.join(dir, rel), text) }
    git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init')
    return fs.realpath(dir)
  }
  const snapshot = async (projectDir, runId, policy) => {
    const workspace = await gitWorktreeProvider.create({ projectPath: projectDir, runId, root: path.join(root, 'runs'), policy, clock })
    await gitWorktreeProvider.release({ ...workspace, projectPath: projectDir })
    return workspace
  }
  /** A framework F with lib/ and a root version, and an instance I that links F/lib as fw (independent repositories). */
  const pair = async (tag) => {
    const framework = await repo(`framework-${tag}`, { 'lib/a.js': 'a\n', 'lib/b.js': 'b\n', version: '1.0.0\n' })
    const instance = await repo(`instance-${tag}`, { 'README.md': 'instance\n' })
    await fs.symlink(path.join(framework, 'lib'), path.join(instance, 'fw'))
    git(instance, 'add', '-A'); git(instance, 'commit', '-q', '-m', 'link the framework')
    const workspace = await snapshot(instance, `snap-${tag}`, MATERIALIZE)
    const entry = { project: 'instance-project', snapshot: { baseCommit: workspace.baseCommit, ...await snapshotRecord({ workspace, policy: MATERIALIZE, projectDir: instance }) } }
    return { framework, instance, workspace, entry }
  }
  try {
    t.section('1. an instance snapshot records the framework link: its owning checkout and the owner-relative path it copied')
    const one = await pair('one')
    {
      t.eq('the snapshot lives in the instance repository; the link names the framework checkout and lib', [one.entry.snapshot.repository, one.entry.snapshot.links.map((l) => [l.path, l.owner, l.prefix])], [path.join(one.instance, '.git'), [['fw', one.framework, 'lib']]])
      t.ok('the own tree is the working-tree commit under the materialized one', one.entry.snapshot.ownCommit !== one.entry.snapshot.baseCommit && git(one.instance, 'rev-parse', `${one.entry.snapshot.baseCommit}^1`) === one.entry.snapshot.ownCommit)
      t.eq('a path under the link belongs to the framework checkout', ownerOf('fw/a.js', one.instance, one.entry.snapshot.links), { checkout: one.framework, path: 'lib/a.js' })
    }

    t.section('2. the recheck: an unchanged checkout repeats its snapshot; a framework edit after it is named with its checkout')
    {
      const again = await snapshot(one.instance, 'recheck-one', MATERIALIZE)
      t.eq('nothing changed: the same commit', again.baseCommit, one.workspace.baseCommit)
      await fs.writeFile(path.join(one.framework, 'lib/a.js'), 'a, edited after the snapshot\n')
      const moved = await snapshot(one.instance, 'recheck-one-b', MATERIALIZE)
      const diff = await snapshotDiff({ repository: one.entry.snapshot.repository, from: one.workspace.baseCommit, to: moved.baseCommit, projectDir: one.instance, links: one.entry.snapshot.links })
      t.eq('a framework edit: the framework checkout moved, lib/a.js named', [diff.sameTree, diff.moved], [false, [{ checkout: one.framework, paths: ['lib/a.js'], total: 1 }]])
    }

    t.section('3. independent repositories: the framework commit is compared with the instance snapshot, each side read where it lives')
    {
      const headBefore = git(one.framework, 'rev-parse', 'HEAD')
      await fs.writeFile(path.join(one.framework, 'version'), '1.1.0\n')
      git(one.framework, 'add', '-A'); git(one.framework, 'commit', '-q', '-m', 'checkpoint')
      const commit = git(one.framework, 'rev-parse', 'HEAD')
      let resolvable = true
      try { execFileSync('git', ['--git-dir', path.join(one.instance, '.git'), 'cat-file', '-e', commit], { stdio: 'ignore' }) } catch { resolvable = false }
      t.eq('the instance repository cannot resolve the framework commit', resolvable, false)
      const views = testedViews(one.framework, 'framework-project', [one.entry])
      t.eq('one tested view of the framework: the instance\'s copy of lib', views.map((v) => [v.at, v.prefix]), [['fw', 'lib']])
      const result = await committedBeyond({ checkout: one.framework, commit, headBefore, views, versionBefore: '1.0.0', versionAfter: '1.1.0' })
      t.eq('the edit slipped in under the linked prefix is untested, with its path; the root version no view holds is untested too; lib/b.js is not named',
        [result.state, result.untested.paths, result.bumped], ['compared', [{ path: 'lib/a.js', reason: 'differs-from-tested' }, { path: 'version', reason: 'outside-every-snapshot' }], []])
      const two = await pair('two')
      const before2 = git(two.framework, 'rev-parse', 'HEAD')
      await fs.writeFile(path.join(two.framework, 'version'), '1.1.0\n')
      git(two.framework, 'add', '-A'); git(two.framework, 'commit', '-q', '-m', 'checkpoint')
      const clean = await committedBeyond({ checkout: two.framework, commit: git(two.framework, 'rev-parse', 'HEAD'), headBefore: before2, views: testedViews(two.framework, 'framework-project', [two.entry]), versionBefore: '1.0.0', versionAfter: '1.1.0' })
      t.eq('nothing slipped: lib is as tested; only the root version, which no view holds, is named', clean.untested.paths, [{ path: 'version', reason: 'outside-every-snapshot' }])
      const sha256 = (args) => args.includes('--show-object-format') && args.includes('--git-dir') ? Promise.resolve('sha256\n') : readGit(args)
      const odd = await committedBeyond({ checkout: two.framework, commit: git(two.framework, 'rev-parse', 'HEAD'), headBefore: before2, views: testedViews(two.framework, 'framework-project', [two.entry]), git: sha256 })
      t.eq('different object formats: incomparable, every committed path untested, never clean', [odd.state, odd.untested.total > 0, odd.untested.paths.every((p) => p.reason === 'incomparable')], ['incomparable', true, true])
    }

    t.section('3b. a framework read through an instance snapshot\'s copy of it (a derived entry\'s coverage): what the copy held, what it never held, and copies that disagree')
    {
      const three = await pair('three')
      const views = testedViews(three.framework, 'framework-project', [three.entry])
      const reader = viewReader(views)
      const blob = git(three.framework, 'rev-parse', 'HEAD:lib/a.js')
      t.eq('a path under the link is materialized and reads as the framework\'s own blob', [reader.materialized('lib/a.js'), await reader.read('lib/a.js')], [true, { mode: '100644', sha1: blob }])
      t.eq('the root version no copy held is not materialized and reads as nothing', [reader.materialized('version'), await reader.read('version')], [false, null])
      t.eq('a path under the link the copy lacks reads as absent', await reader.read('lib/gone.js'), null)
      await fs.writeFile(path.join(three.framework, 'lib/a.js'), 'a, edited between two instances\' snapshots\n')
      const later = await snapshot(three.instance, 'snap-three-b', MATERIALIZE)
      const second = { project: 'other-instance-project', snapshot: { baseCommit: later.baseCommit, ...await snapshotRecord({ workspace: later, policy: MATERIALIZE, projectDir: three.instance }) } }
      const both = viewReader(testedViews(three.framework, 'framework-project', [three.entry, second]))
      t.eq('two copies that disagree read as other (it matches no delivered state); where they agree, the blob', [await both.read('lib/a.js'), (await both.read('lib/b.js')).sha1], [{ other: true }, git(three.framework, 'rev-parse', 'HEAD:lib/b.js')])
    }

    t.section('3c. an instance whose checkpoint commits what its link points at: the linked files are compared with the copy the instance was tested with')
    {
      const four = await pair('four')
      const viewsOf = () => [...testedViews(four.instance, 'instance-project', [four.entry]), ...followedViews(four.instance, 'instance-project', [four.entry])]
      t.eq('the instance\'s own checkout: its own tree, and its link as a followed view at the same path', viewsOf().map((v) => [v.at, v.prefix, Boolean(v.followed)]), [['', '', false], ['fw', 'fw', true]])
      t.eq('the framework\'s checkout gets no followed view from the instance\'s entry', followedViews(four.framework, 'framework-project', [four.entry]), [])
      const linked = git(four.instance, 'rev-parse', 'HEAD')
      await fs.writeFile(path.join(four.instance, 'README.md'), 'instance, an empty commit would not do\n')
      git(four.instance, 'add', '-A'); git(four.instance, 'commit', '-q', '-m', 'a checkpoint that keeps the link a link')
      const asLink = await committedBeyond({ checkout: four.instance, commit: git(four.instance, 'rev-parse', 'HEAD'), headBefore: linked, views: viewsOf() })
      t.eq('a commit that holds the link as a link is not compared with the copy: one view, only the edit named', [asLink.views, asLink.untested.paths], [1, [{ path: 'README.md', reason: 'differs-from-tested' }]])
      // The checkpoint follows the link: the commit holds the framework's files below fw/.
      const follow = async (edit) => {
        const headBefore = git(four.instance, 'rev-parse', 'HEAD')
        await fs.rm(path.join(four.instance, 'fw'), { recursive: true, force: true })
        await fs.cp(path.join(four.framework, 'lib'), path.join(four.instance, 'fw'), { recursive: true })
        if (edit) await fs.writeFile(path.join(four.instance, 'fw/a.js'), edit)
        git(four.instance, 'add', '-A'); git(four.instance, 'commit', '-q', '-m', 'a checkpoint that follows the link')
        return { headBefore, commit: git(four.instance, 'rev-parse', 'HEAD') }
      }
      await fs.writeFile(path.join(four.instance, 'README.md'), 'instance\n')
      const followed = await follow(null)
      const without = await committedBeyond({ checkout: four.instance, ...followed, views: testedViews(four.instance, 'instance-project', [four.entry]) })
      t.eq('without the followed view the link that became a directory and every file below it read as outside every snapshot', without.untested.paths, [{ path: 'fw', reason: 'outside-every-snapshot' }, { path: 'fw/a.js', reason: 'outside-every-snapshot' }, { path: 'fw/b.js', reason: 'outside-every-snapshot' }])
      const withIt = await committedBeyond({ checkout: four.instance, ...followed, views: viewsOf() })
      t.eq('with it the linked files are what was tested: two views, nothing untested', [withIt.state, withIt.views, withIt.untested.total], ['compared', 2, 0])
      const slipped = await follow('a, edited after the snapshot\n')
      const caught = await committedBeyond({ checkout: four.instance, ...slipped, views: viewsOf() })
      t.eq('a linked file committed differently from the tested copy is named', caught.untested.paths, [{ path: 'fw/a.js', reason: 'differs-from-tested' }])
    }

    t.section('4. the project\'s own snapshot: only the version itself may change in its version files; an excluded path it never held is not read')
    {
      const pkg = (version, deps = '{}') => `{\n  "name": "app",\n  "version": "${version}",\n  "dependencies": ${deps}\n}\n`
      const app = await repo('app', { version: '2.0.0\n', 'package.json': pkg('2.0.0'), 'src/x.js': 'x\n', 'secret.txt': 'tracked secret\n' })
      const policy = { ...PLAIN, excludes: ['secret.txt'] }
      const workspace = await snapshot(app, 'snap-app', policy)
      const entry = { project: 'app-project', snapshot: { baseCommit: workspace.baseCommit, ...await snapshotRecord({ workspace, policy, projectDir: app }) } }
      const headBefore = git(app, 'rev-parse', 'HEAD')
      await fs.writeFile(path.join(app, 'version'), '2.1.0\n')
      await fs.writeFile(path.join(app, 'package.json'), pkg('2.1.0'))
      git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'checkpoint')
      const views = testedViews(app, 'app-project', [entry])
      const bumpOnly = await committedBeyond({ checkout: app, commit: git(app, 'rev-parse', 'HEAD'), headBefore, views, versionBefore: '2.0.0', versionAfter: '2.1.0' })
      t.eq('a version-only bump: both files bumped, nothing untested, the excluded secret not read', [bumpOnly.bumped.sort(), bumpOnly.untested.total], [['package.json', 'version'], 0])
      const head2 = git(app, 'rev-parse', 'HEAD')
      await fs.writeFile(path.join(app, 'package.json'), pkg('2.2.0', '{ "left-pad": "1.3.0" }'))
      await fs.writeFile(path.join(app, 'version'), '2.2.0\n')
      git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'checkpoint with a dependency slipped in')
      const slipped = await committedBeyond({ checkout: app, commit: git(app, 'rev-parse', 'HEAD'), headBefore: head2, views, versionBefore: '2.1.0', versionAfter: '2.2.0' })
      t.eq('package.json with a dependency beside the version: untested, beyond the version change', slipped.untested.paths.filter((p) => p.path === 'package.json'), [{ path: 'package.json', reason: 'beyond-version-change' }])
    }

    t.section('4b. the version fields are located in the document, not by the first version string; a tested file the commit lacks is untested, untracked or not')
    {
      const pkg = (top, nested) => `{\n  "metadata": { "version": "${nested}" },\n  "name": "app",\n  "version": "${top}"\n}\n`
      const lock = (top, root, dep) => `{\n  "name": "app",\n  "version": "${top}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "app", "version": "${root}" },\n    "node_modules/x": { "version": "${dep}" }\n  }\n}\n`
      const app = await repo('app-structural', { version: '1.0.0\n', 'package.json': pkg('1.0.0', '1.0.0'), 'package-lock.json': lock('1.0.0', '1.0.0', '1.0.0') })
      // An untracked source file the working-tree snapshot takes in.
      await fs.writeFile(path.join(app, 'new-module.js'), 'export const x = 1\n')
      const workspace = await snapshot(app, 'snap-structural', PLAIN)
      const entry = { project: 'app-project', snapshot: { baseCommit: workspace.baseCommit, ...await snapshotRecord({ workspace, policy: PLAIN, projectDir: app }) } }
      t.ok('the snapshot holds the untracked file', git(app, 'ls-tree', '-r', '--name-only', workspace.baseCommit).split('\n').includes('new-module.js'))
      const headBefore = git(app, 'rev-parse', 'HEAD')
      // After the recheck: the untracked file goes away, a nested version moves, and the checkpoint bumps the version.
      await fs.rm(path.join(app, 'new-module.js'))
      await fs.writeFile(path.join(app, 'version'), '1.1.0\n')
      await fs.writeFile(path.join(app, 'package.json'), pkg('1.0.0', '1.1.0'))
      await fs.writeFile(path.join(app, 'package-lock.json'), lock('1.1.0', '1.1.0', '1.0.0'))
      git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'checkpoint')
      const result = await committedBeyond({ checkout: app, commit: git(app, 'rev-parse', 'HEAD'), headBefore, views: testedViews(app, 'app-project', [entry]), versionBefore: '1.0.0', versionAfter: '1.1.0' })
      t.eq('package.json whose nested metadata.version moved is untested; the tested file the commit lacks is untested', result.untested.paths, [{ path: 'new-module.js', reason: 'absent-from-commit' }, { path: 'package.json', reason: 'beyond-version-change' }])
      t.eq('the version file and the lockfile\'s top-level and packages[""] versions are the bump', result.bumped.sort(), ['package-lock.json', 'version'])
      const head2 = git(app, 'rev-parse', 'HEAD')
      await fs.writeFile(path.join(app, 'version'), '1.2.0\n')
      await fs.writeFile(path.join(app, 'package-lock.json'), lock('1.2.0', '1.2.0', '1.2.0'))
      git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'checkpoint, a dependency version moved too')
      const views2 = testedViews(app, 'app-project', [{ project: 'app-project', snapshot: { ...entry.snapshot, baseCommit: head2, ownCommit: head2, repository: path.join(app, '.git') } }])
      const nested = await committedBeyond({ checkout: app, commit: git(app, 'rev-parse', 'HEAD'), headBefore: head2, views: views2, versionBefore: '1.1.0', versionAfter: '1.2.0' })
      t.eq('a lockfile whose dependency version moved with the bump is untested', nested.untested.paths, [{ path: 'package-lock.json', reason: 'beyond-version-change' }])
    }

    t.section('5. the readings around a snapshot: changed paths with their times; recent, during, still')
    {
      const dir = await repo('moving', { 'a.txt': 'a\n' })
      await fs.writeFile(path.join(dir, 'a.txt'), 'edited\n')
      const old = new Date('2026-11-15T07:00:00.000Z')
      await fs.utimes(path.join(dir, 'a.txt'), old, old)
      const reading = await readCheckouts([dir], { now: () => Date.parse('2026-11-15T09:00:00.000Z') })
      t.eq('a reading lists the changed path with its modification time', reading.checkouts[0].paths['a.txt'].mtimeMs, old.getTime())
      const still = motionOf({ before: reading, after: { ...reading, at: reading.at + 1000 } })
      t.eq('changed two hours before, unchanged between the readings: not moving, newest change named', [still.moving, still.newest.path, still.recent.total, still.during.total], [false, 'a.txt', 0, 0])
      const at = Date.parse('2026-11-15T09:00:00.000Z')
      const before = { at, checkouts: [{ checkout: dir, paths: { 'a.txt': { mtimeMs: at - 60000, size: 7 } } }] }
      const after = { at: at + 5000, checkouts: [{ checkout: dir, paths: { 'a.txt': { mtimeMs: at + 2000, size: 9 }, 'b.txt': { mtimeMs: at + 3000, size: 1 } } }] }
      const moving = motionOf({ before, after })
      t.eq('changed within the window and between the readings: moving, with the paths', [moving.moving, moving.recent.paths.map((p) => p.path), moving.during.paths.map((p) => p.path)], [true, ['b.txt', 'a.txt'], ['a.txt', 'b.txt']])
      const unread = motionOf({ before, after: { at: at + 5000, checkouts: [{ checkout: dir, paths: {} }, { checkout: '/elsewhere', error: 'not a git repository' }] } })
      t.eq('a checkout whose reading failed: unknown (null), never still, with the failure named', [unread.moving, unread.unread], [null, [{ checkout: '/elsewhere', error: 'not a git repository' }]])
      const failed = await readCheckouts([path.join(root, 'no-such-checkout')])
      t.eq('a checkout git cannot read is recorded as unread, not as clean', [Boolean(failed.checkouts[0].error), failed.checkouts[0].paths], [true, undefined])
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
