import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { applyFence, fenceArgs, fencedCommand } from '../../harness/fence.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { Engine } from '../server/runtime/engine.mjs'
import { CACHE_DIRS, nodeModulesTooling } from '../server/runtime/node-modules-tooling.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { toolingBrief } from '../server/runtime/tooling-commands.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'tooling.nodeModules — a checkout\'s node_modules as read-only seat tooling, never through a link, caches masked'

const run = promisify(execFile)
const NL = '\n'

/** A git checkout with a package.json, an ignored node_modules (with caches) and the given extra setup. */
async function checkout (dir, { scripts = { test: 'vitest run', lint: 'eslint .', build: 'vite build' } } = {}) {
  await fs.mkdir(dir, { recursive: true })
  await run('git', ['-C', dir, 'init', '-q'])
  await fs.writeFile(path.join(dir, '.gitignore'), `node_modules/${NL}`)
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }))
  await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true })
  await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n')
  for (const cache of ['.cache', '.vite-temp']) {
    await fs.mkdir(path.join(dir, 'node_modules', cache))
    await fs.writeFile(path.join(dir, 'node_modules', cache, 'derived.js'), 'export const key = "from-gitignored-config"\n')
  }
  return dir
}

async function sandboxMissing () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-nm-avail-'))
  try {
    const wrapped = fencedCommand({ command: '/bin/true', args: [], fence: await fenceArgs({ cwd: dir, writable: [dir] }) })
    const r = await runProcess({ command: wrapped.command, args: wrapped.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
    return r.code === 0 ? null : `bubblewrap failed: ${r.stderr.trim().slice(0, 120)}`
  } catch (error) {
    return error.code === 'ENOENT' ? 'bubblewrap or setpriv absent' : error.message
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

export default async function (t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-nm-')))
  const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, host: process.env.DEVPANEL_HOST_CONFIG_DIR }
  try {
    t.section('1. every node_modules beside a package.json, as a real directory inside the checkout')
    {
      const dir = await checkout(path.join(root, 'p1'))
      await checkout(path.join(dir, 'packages', 'a'), { scripts: { test: 'vitest run' } })
      await checkout(path.join(dir, '.hidden'))
      await checkout(path.join(dir, 'a', 'b', 'c', 'd'))
      const found = await nodeModulesTooling(dir)
      t.eq('the root and a package below it are mounted (dot directories and deeper than three levels are not walked)', found.mounts.map((m) => m.target), ['node_modules', 'packages/a/node_modules'])
      t.eq('each at its own real path', found.mounts.map((m) => m.sourceReal), [path.join(dir, 'node_modules'), path.join(dir, 'packages', 'a', 'node_modules')])
      t.ok('marked automatic', found.mounts.every((m) => m.auto === true))
      t.eq('every known build cache is masked, whether the checkout has it or not', found.mounts[0].masks, CACHE_DIRS)
      t.eq('the test and lint scripts become commands, build does not', found.commands.map((c) => [c.id, c.cwd ?? null, c.run]), [['test', null, 'npm run test -- <args>'], ['lint', null, 'npm run lint -- <args>'], ['packages-a-test', 'packages/a', 'npm run test -- <args>']])
      t.eq('nothing is skipped', found.skipped, [])
      t.ok('every cache directory the masks name is one tools write', ['.cache', '.vite', '.vite-temp'].every((d) => CACHE_DIRS.includes(d)))
    }

    t.section('2. a link is never followed: the project tree does not decide what a seat reads')
    {
      const secret = path.join(root, 'secret')
      await fs.mkdir(secret); await fs.writeFile(path.join(secret, 'id_ed25519'), 'key')
      const dir = await checkout(path.join(root, 'p2'))
      await fs.rm(path.join(dir, 'node_modules'), { recursive: true })
      await fs.symlink(secret, path.join(dir, 'node_modules'))
      const linked = await nodeModulesTooling(dir)
      t.eq('a node_modules that is a symlink is not mounted', linked.mounts, [])
      t.eq('and is reported, naming it', linked.skipped.map((s) => s.target), ['node_modules'])

      const dir3 = await checkout(path.join(root, 'p3'))
      const elsewhere = await checkout(path.join(root, 'elsewhere'))
      await fs.symlink(elsewhere, path.join(dir3, 'linked'))
      t.eq('a package reached through a linked directory is not walked', (await nodeModulesTooling(dir3)).mounts.map((m) => m.target), ['node_modules'])

      const dir4 = await checkout(path.join(root, 'p4'))
      await fs.rm(path.join(dir4, '.gitignore'))
      const selected = await nodeModulesTooling(dir4)
      t.eq('a node_modules the snapshot would select (not ignored) is source, not tooling', [selected.mounts, selected.skipped.map((s) => /snapshot selects/.test(s.reason))], [[], [true]])
    }

    t.section('3. resolution: opt-in, a project\'s own tooling wins, recorded in the snapshot and its identity')
    {
      const projects = path.join(root, 'projects')
      const dir = await checkout(path.join(projects, 'nm-project'))
      process.env.DEVPANEL_PROJECTS_DIR = projects
      const cfg = await sandbox()
      const off = await resolvePlaybook('implementation', { root: cfg, projectId: 'nm-project' })
      t.ok('off by default: it resolves', off.ok, JSON.stringify(off.errors))
      t.eq('and nothing is mounted', [off.resolved.workspace.tooling.mounts, off.resolved.workspace.tooling.commands, off.resolved.workspace.tooling.auto], [undefined, undefined, undefined])

      const host = path.join(root, 'host-config')
      await fs.mkdir(host)
      await fs.writeFile(path.join(host, 'settings.json'), JSON.stringify({ tooling: { nodeModules: true } }))
      process.env.DEVPANEL_HOST_CONFIG_DIR = host
      const on = await resolvePlaybook('implementation', { root: cfg, projectId: 'nm-project' })
      t.ok('on: it resolves', on.ok, JSON.stringify(on.errors))
      const tooling = on.resolved.workspace.tooling
      t.eq('the snapshot carries the mount with its masks', tooling.mounts, [{ target: 'node_modules', source: path.join(dir, 'node_modules'), sourceReal: path.join(dir, 'node_modules'), auto: true, masks: CACHE_DIRS }])
      t.eq('and the commands', tooling.commands.map((c) => c.id), ['test', 'lint'])
      t.eq('and says where they came from', tooling.auto, 'nodeModules')
      t.ok('the configuration identity changes with it', on.resolved.configHash !== off.resolved.configHash)

      await fs.mkdir(path.join(cfg, 'projects'), { recursive: true })
      await fs.writeFile(path.join(cfg, 'projects', 'nm-project.yaml'), `id: nm-project${NL}workspace:${NL}  tooling:${NL}    commands:${NL}      - id: unit${NL}        run: node test.mjs${NL}`)
      const own = await resolvePlaybook('implementation', { root: cfg, projectId: 'nm-project' })
      t.eq('a project that declares its own tooling keeps exactly that', [own.resolved.workspace.tooling.mounts, own.resolved.workspace.tooling.commands.map((c) => c.id), own.resolved.workspace.tooling.auto], [undefined, ['unit'], undefined])
    }

    t.section('3b. before each turn an automatic mount must still be the real directory resolved')
    {
      const dir = await checkout(path.join(root, 'p3b'))
      const worktree = path.join(root, 'wt-3b')
      await fs.mkdir(worktree)
      const [mount] = (await nodeModulesTooling(dir)).mounts
      const engine = { snapshot: { workspace: { tooling: { auto: 'nodeModules', mounts: [mount] } } }, run: { workspace: { path: worktree }, issue: { project: 'p' } } }
      const turn = () => Engine.prototype.toolingMounts.call(engine)
      const ok = await turn()
      t.eq('unchanged, it is bound with its masks', ok.mounts.map((m) => [m.source, m.masks]), [[mount.sourceReal, CACHE_DIRS]])
      const secret = path.join(root, 'secret-3b')
      await fs.mkdir(secret)
      await fs.rename(path.join(dir, 'node_modules'), path.join(root, 'moved-3b'))
      await fs.symlink(secret, path.join(dir, 'node_modules'))
      const refused = await turn().then(() => null, (e) => e)
      t.ok('replaced by a link since resolution, the turn is refused', /no longer the real directory/.test(refused?.message ?? ''), refused?.message)
      t.eq('before anything starts, as an environment error', [refused?.kind, refused?.started], ['environment-error', false])
    }

    t.section('4. the brief names where the tooling came from')
    {
      const brief = toolingBrief({ tooling: { auto: 'nodeModules', mounts: [{ target: 'node_modules', source: '/p/node_modules', masks: ['.vite-temp'] }], commands: [{ id: 'test', run: 'npm run test -- <args>' }] }, worktree: '/w' })
      t.ok('found in the checkout, not declared', brief.startsWith('Project tooling (found in the project checkout: host settings tooling.nodeModules).'))
      t.ok('the masked caches are named as empty and writable', brief.includes('.vite-temp inside it empty and writable'))
    }

    t.section('5. in the fence each cache is an empty writable directory outside the worktree, linked from the mount; the packages stay read-only')
    {
      const missing = await sandboxMissing()
      if (missing) { t.skip('the masks are not proved here', missing); return }
      const dir = await checkout(path.join(root, 'p5'))
      const worktree = path.join(root, 'wt-5'), scratch = path.join(root, 'scratch-5')
      await fs.mkdir(path.join(worktree, 'node_modules'), { recursive: true }); await fs.mkdir(scratch)
      const outside = path.join(root, 'outside-5')
      await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'key')
      await fs.symlink(outside, path.join(dir, 'node_modules', 'linked'))
      const [mount] = (await nodeModulesTooling(dir)).mounts
      const spec = { cwd: worktree, writable: [scratch], readOnly: [worktree], mounts: [{ source: mount.sourceReal, target: path.join(worktree, 'node_modules'), masks: mount.masks }] }
      const fenced = await applyFence({ spec })
      t.ok('the fence, masks included, is proved', fenced.applied, fenced.reason)
      if (!fenced.applied) return
      t.eq('the proof checked each mask', fenced.proof.masks, CACHE_DIRS.length)
      const script = 'cd node_modules && ls .bin && ls -A .cache | wc -l && : > .vite-temp/written && : > .vite/written && echo wrote && ( : > .bin/x ) 2>/dev/null || echo read-only'
      const w = fenced.wrap('/bin/sh', ['-c', script])
      const r = await runProcess({ command: w.command, args: w.args, env: { PATH: '/usr/bin:/bin' }, stdin: '' })
      t.eq('the tools are there, the cache is empty, caches take writes (one the checkout lacks too), the packages refuse one', r.stdout.trim().split(NL), ['tool', '0', 'wrote', 'read-only'])
      const c = fenced.wrap('/bin/sh', ['-c', 'readlink node_modules/.vite-temp; : > node_modules/.vite-temp/written && cat /run/devpanel/caches/0/.vite-temp/written && echo found'])
      const cr = await runProcess({ command: c.command, args: c.args, env: { PATH: '/usr/bin:/bin' }, cwd: worktree, stdin: '' })
      t.eq('each cache is a link to a directory outside the worktree, where the write landed', cr.stdout.trim().split(NL), ['/run/devpanel/caches/0/.vite-temp', 'found'])
      const l = fenced.wrap('/bin/sh', ['-c', 'readlink node_modules/linked; cat node_modules/linked/secret 2>/dev/null || echo unreachable'])
      const lr = await runProcess({ command: l.command, args: l.args, env: { PATH: '/usr/bin:/bin' }, cwd: worktree, stdin: '' })
      t.eq('a link among the packages is the same link, its target not granted', lr.stdout.trim().split(NL), [outside, 'unreachable'])
      t.eq('and nothing reached the host\'s cache', (await fs.readdir(path.join(dir, 'node_modules', '.vite-temp'))).sort(), ['derived.js'])
    }
  } finally {
    for (const [key, value] of [['DEVPANEL_PROJECTS_DIR', saved.projects], ['DEVPANEL_HOST_CONFIG_DIR', saved.host]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}
