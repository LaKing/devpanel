import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { forbiddenRoots, homeExemption } from '../server/runtime/selection.mjs'
import { certDir, issuesRoot, logDir, tokenFile } from '../server/project-path.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'
import { hostConfigDir } from '../server/config/host-config.mjs'
import { applyFence, defaultCanaries, hostReadOnly } from '../../harness/fence.mjs'

export const name = 'host overrides: playbooks in host-config, disabled harnesses, home exceptions, fence read-only grants, data root'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_ROOT = path.resolve(HERE, '..', '..')

export default async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-host-overrides-'))
  const saved = process.env.DEVPANEL_HOST_CONFIG_DIR
  try {
    const hostDir = path.join(fixture, 'host-config')
    await fs.mkdir(path.join(hostDir, 'playbooks'), { recursive: true })
    const tree = await fs.readFile(path.join(CONFIG_ROOT, 'playbooks', 'implementation.yaml'), 'utf8')
    const seats = async (cfg) => {
      const r = await resolvePlaybook('implementation', { config: cfg })
      return r.ok ? Object.fromEntries(Object.entries(r.resolved.participants).map(([role, p]) => [role, p.model.id])) : r.errors.map((e) => e.message)
    }

    t.section('1. a playbook in host-config/playbooks shadows the in-tree one, which stays the default')
    const inTree = await loadConfig({ root: CONFIG_ROOT, hostDir })
    t.eq('without a host copy the tree\'s auditor is used', (await seats(inTree))['auditor-1'], 'gpt-6.1-sol')
    await fs.writeFile(path.join(hostDir, 'playbooks', 'implementation.yaml'), tree.replace(/model: gpt-6\.1-sol/, 'model: fable-5-1'))
    const shadowed = await loadConfig({ root: CONFIG_ROOT, hostDir })
    t.eq('the host copy is read', (await seats(shadowed))['auditor-1'], 'fable-5-1')
    t.ok('and reported as shadowing the tree', shadowed.shadowed.some((s) => s.category === 'playbooks' && s.name === 'implementation.yaml'))
    t.eq('counted by source', shadowed.sources.playbooks.host, 1)
    t.eq('the tree file is untouched', await fs.readFile(path.join(CONFIG_ROOT, 'playbooks', 'implementation.yaml'), 'utf8'), tree)

    t.section('2. a disabled harness leaves its roster entries out')
    await fs.rm(path.join(hostDir, 'playbooks', 'implementation.yaml'))
    await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ harnesses: { disabled: ['codex'] } }))
    const off = await loadConfig({ root: CONFIG_ROOT, hostDir })
    t.ok('no codex model remains', ![...off.roster.values()].some((m) => m.harness === 'codex'))
    t.ok('claude models do', off.roster.has('opus-5-5'))
    t.eq('the left-out ones are recorded with their harness', off.disabledModels.get('gpt-6.1-sol'), 'codex')
    const refused = await seats(off)
    t.ok('the default playbook naming one fails, saying why and what to do',
      Array.isArray(refused) && refused.some((m) => /gpt-6\.1-sol.*harness, codex, is disabled.*host-config\/playbooks/.test(m)), JSON.stringify(refused))
    await fs.writeFile(path.join(hostDir, 'playbooks', 'implementation.yaml'), tree.replace(/model: gpt-6\.1-sol/, 'model: fable-5-1'))
    t.eq('with a host override it resolves again', (await seats(await loadConfig({ root: CONFIG_ROOT, hostDir })))['auditor-1'], 'fable-5-1')
    let invalid = null
    await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ harnesses: { disabled: ['other'] } }))
    try { hostSettings({ hostDir }) } catch (e) { invalid = e }
    t.ok('an unknown harness is a settings error', invalid)

    t.section('3. the home rule: forbidden by default, exempted only inside allowedHomePaths')
    const home = path.join(fixture, 'home')
    await fs.mkdir(path.join(home, 'work', 'tools'), { recursive: true })
    await fs.mkdir(path.join(home, 'other'))
    const none = await homeExemption({ home, allowed: [] })
    t.ok('by default nothing in the home is exempt', !none(home, path.join(home, 'work', 'tools')))
    const some = await homeExemption({ home, allowed: [path.join(home, 'work')] })
    t.ok('a path inside an allowed directory is exempt from the home', some(home, path.join(home, 'work', 'tools')))
    t.ok('the allowed directory itself too', some(home, path.join(home, 'work')))
    t.ok('another path in the home is not', !some(home, path.join(home, 'other')))
    t.ok('the home itself is not', !some(home, home))
    t.ok('another forbidden root is never exempted', !some(path.join(fixture, 'elsewhere'), path.join(home, 'work', 'tools')))
    t.ok('an allowed entry naming the home exempts nothing', !(await homeExemption({ home, allowed: [home] }))(home, path.join(home, 'work')))
    await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ selection: { allowedHomePaths: ['~/work'] } }))
    t.eq('`~/` is the panel account\'s home', hostSettings({ hostDir }).selection.allowedHomePaths, [path.join(os.homedir(), 'work')])

    t.section('4. fence.readOnly: a toolchain under the home, never the home or its logins')
    await fs.mkdir(path.join(home, '.nvm', 'bin'), { recursive: true })
    await fs.mkdir(path.join(home, '.config', 'x'), { recursive: true })
    await fs.mkdir(path.join(home, '.ssh'))
    t.eq('a toolchain directory is granted', await hostReadOnly({ home, dirs: [path.join(home, '.nvm')] }), [await fs.realpath(path.join(home, '.nvm'))])
    t.eq('a missing one is skipped', await hostReadOnly({ home, dirs: [path.join(home, 'absent')] }), [])
    for (const [label, dir] of [['the home', home], ['a directory containing it', fixture], ['a login directory', path.join(home, '.ssh')], ['a path inside one', path.join(home, '.config', 'x')]]) {
      let error = null
      try { await hostReadOnly({ home, dirs: [dir] }) } catch (e) { error = e }
      t.ok(`${label} is refused`, error && /fence\.readOnly/.test(error.message), error?.message)
    }

    // Through applyFence, with the panel account's real home: the granted
    // directory is readable inside a proved fence.
    const tool = path.join(os.homedir(), `.devpanel-test-toolchain-${process.pid}`)
    const work = path.join(fixture, 'work')
    await fs.mkdir(work)
    await fs.mkdir(tool)
    try {
      await fs.writeFile(path.join(tool, 'marker'), 'visible')
      process.env.DEVPANEL_HOST_CONFIG_DIR = hostDir
      await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ fence: { readOnly: [tool] } }))
      const fenced = await applyFence({ spec: { cwd: work, writable: [work] }, manifest: {} })
      if (!fenced.applied) t.skip('applyFence binds the granted toolchain read-only', fenced.reason)
      else {
        t.eq('it is counted among the read-only grants', fenced.mounts.readOnly, 1)
        const { execFile } = await import('node:child_process')
        const run = (cmd) => new Promise((resolve) => { const { command, args } = fenced.wrap('/bin/sh', ['-c', cmd]); execFile(command, args, (error, stdout) => resolve({ code: error?.code ?? 0, stdout })) })
        t.eq('readable inside the fence', (await run(`cat '${path.join(tool, 'marker')}'`)).stdout, 'visible')
        t.ok('and not writable', (await run(`echo x > '${path.join(tool, 'new')}'`)).code !== 0)
      }
    } finally {
      await fs.rm(tool, { recursive: true, force: true })
    }

    t.section('5. dataRoot: the issue root moves, and every guard of it follows')
    const savedIssues = process.env.DEVPANEL_ISSUES_DIR
    try {
      delete process.env.DEVPANEL_ISSUES_DIR
      await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({}))
      t.eq('by default it is the panel checkout\'s issues/', issuesRoot(), path.join(CONFIG_ROOT, 'issues'))
      t.ok('covered by the panel, so not a forbidden root of its own', !(await forbiddenRoots({ home, mountinfo: '/nonexistent' })).has(path.join(CONFIG_ROOT, 'issues')))
      const data = path.join(fixture, 'data')
      await fs.mkdir(path.join(data, 'issues', 'other-project'), { recursive: true })
      await fs.mkdir(path.join(data, 'issues', '.supervisor'))
      await fs.mkdir(path.join(data, 'repos', 'x-project.git'), { recursive: true })
      await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ dataRoot: data }))
      t.eq('with dataRoot it is <dataRoot>/issues', issuesRoot(), path.join(data, 'issues'))
      const savedVars = Object.fromEntries(['DEVPANEL_TOKEN_FILE', 'DEVPANEL_LOG_DIR', 'DEVPANEL_CERT_DIR'].map((k) => [k, process.env[k]]))
      for (const k of Object.keys(savedVars)) delete process.env[k]
      t.eq('the token beside it', tokenFile(), path.join(data, '.devpanel-token'))
      t.eq('the server log', logDir(), path.join(data, 'logs'))
      t.eq('the certificate', certDir(), path.join(data, 'cert'))
      process.env.DEVPANEL_CERT_DIR = path.join(fixture, 'certs')
      t.eq('each variable still wins', certDir(), path.join(fixture, 'certs'))
      for (const [k, v] of Object.entries(savedVars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      t.ok('a forbidden root then', (await forbiddenRoots({ home, mountinfo: '/nonexistent' })).has(await fs.realpath(path.join(data, 'issues'))))
      const canaries = await defaultCanaries({ home, granted: [work], panelRoot: CONFIG_ROOT })
      t.ok('another project\'s issues there are a fence canary', canaries.includes(path.join(data, 'issues', 'other-project')), canaries.join(','))
      t.ok('the supervisor state too', canaries.includes(path.join(data, 'issues', '.supervisor')))
      t.ok('a turn outside the data root sees none of it', canaries.includes(data))
      // As a run does: its own directories inside the data root's issues.
      const own = path.join(data, 'issues', 'own-project', '2026-01-01-x', 'runs', 'r1')
      await fs.mkdir(own, { recursive: true })
      await fs.mkdir(path.join(data, 'host-config'))
      const inside = await defaultCanaries({ home, granted: [own], panelRoot: CONFIG_ROOT })
      t.ok('a run inside it does not see the Git stores', inside.includes(path.join(data, 'repos')), inside.join(','))
      t.ok('nor the host configuration', inside.includes(path.join(data, 'host-config')))
      t.ok('nor another project\'s issues', inside.includes(path.join(data, 'issues', 'other-project')))
      t.ok('and its own directory is not hidden', !inside.some((p) => own === p || own.startsWith(p + '/')))
      t.ok('the data root as a whole is a forbidden root', (await forbiddenRoots({ home, mountinfo: '/nonexistent' })).has(await fs.realpath(data)))
      process.env.DEVPANEL_ISSUES_DIR = path.join(fixture, 'explicit')
      t.eq('DEVPANEL_ISSUES_DIR still wins', issuesRoot(), path.join(fixture, 'explicit'))
    } finally {
      if (savedIssues === undefined) delete process.env.DEVPANEL_ISSUES_DIR; else process.env.DEVPANEL_ISSUES_DIR = savedIssues
    }

    t.section('6. host-config in the data root: found when the checkout has none')
    const checkout = path.join(fixture, 'checkout')
    const boot = path.join(fixture, 'boot')
    await fs.mkdir(checkout)
    t.eq('neither exists: the checkout\'s', hostConfigDir({ root: checkout, env: { DEVPANEL_DATA_ROOT: boot } }), path.join(checkout, 'host-config'))
    await fs.mkdir(path.join(boot, 'host-config'), { recursive: true })
    t.eq('only the data root\'s exists: that one', hostConfigDir({ root: checkout, env: { DEVPANEL_DATA_ROOT: boot } }), path.join(boot, 'host-config'))
    await fs.mkdir(path.join(fixture, 'devpanel', 'host-config'), { recursive: true })
    t.eq('without DEVPANEL_DATA_ROOT nothing outside the checkout is looked for, not even ~/devpanel', hostConfigDir({ root: checkout, env: { HOME: fixture } }), path.join(checkout, 'host-config'))
    t.eq('and nothing is implied', hostSettings({ root: checkout, env: { HOME: fixture } }).dataRoot, null)
    t.eq('the setting still wins', hostConfigDir({ root: checkout, env: { DEVPANEL_DATA_ROOT: boot, DEVPANEL_HOST_CONFIG_DIR: '/etc/x' } }), '/etc/x')
    const bootEnv = { DEVPANEL_DATA_ROOT: boot }
    t.eq('found there, it makes that the data root', hostSettings({ root: checkout, env: bootEnv }).dataRoot, boot)
    await fs.writeFile(path.join(boot, 'host-config', 'settings.json'), JSON.stringify({ dataRoot: path.join(fixture, 'elsewhere') }))
    t.eq('unless the settings name another', hostSettings({ root: checkout, env: bootEnv }).dataRoot, path.join(fixture, 'elsewhere'))
    await fs.mkdir(path.join(checkout, 'host-config'))
    t.eq('the checkout\'s, once it exists, comes first (as before)', hostConfigDir({ root: checkout, env: bootEnv }), path.join(checkout, 'host-config'))
    t.eq('and implies nothing', hostSettings({ root: checkout, env: bootEnv }).dataRoot, null)
  } finally {
    if (saved === undefined) delete process.env.DEVPANEL_HOST_CONFIG_DIR; else process.env.DEVPANEL_HOST_CONFIG_DIR = saved
    await fs.rm(fixture, { recursive: true, force: true })
  }
}
