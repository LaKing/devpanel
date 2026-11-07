import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { hostSettings, pendingCarry, DEFAULT_DIGEST_FILES, DEFAULT_FORBIDDEN_PREFIXES } from '../server/config/host-settings.mjs'
import { HOST_CONFIG_ENV } from '../server/config/host-config.mjs'
import { forbiddenRoots } from '../server/runtime/selection.mjs'
import { withConfinementDefaults, managedRemoteCommand, controlDir } from '../server/runtime/remote-check-process.mjs'

export const name = 'host settings — an installation\'s own defaults, neutral without them, never a silent fallback'

const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  try {
    t.section('1. without a file: the neutral defaults, naming no installation')
    {
      const root = await temp('devpanel-settings-root-')
      const s = hostSettings({ root, hostDir: path.join(root, 'host-config'), env: {} })
      t.eq('a shutdown\'s runs are resumed unless switched off', s.resumeAfterShutdown, true)
      t.eq('defaults', [s.file, s.pending, s.projectsRoot, s.proxyLogin, s.projectActions.headerMarkers, s.testDrive.confinement, s.selection.forbiddenPrefixes, s.skill.linkBaseVariable, s.reporter.panelUrl, s.seatGuidance.projects],
        [null, false, path.dirname(root), { usersDir: null, digestFiles: DEFAULT_DIGEST_FILES }, ['DEVPANEL'], { user: null, home: null }, DEFAULT_FORBIDDEN_PREFIXES, null, null, []])
    }

    t.section('2. a file: its values, defaults for what it leaves out')
    {
      const hostDir = await temp('devpanel-settings-host-')
      await write(path.join(hostDir, 'settings.json'), JSON.stringify({
        projectsRoot: '/opt/projects',
        proxyLogin: { usersDir: '/var/lib/proxy/{hostname}/users', digestFiles: ['.proxy.hash', '.hash'] },
        projectActions: { headerMarkers: ['EDITOR', 'DEVPANEL'] },
        testDrive: { confinement: { user: 'app', home: '/var/app' } },
        selection: { forbiddenPrefixes: ['production', 'stage'] }
      }))
      const s = hostSettings({ hostDir })
      t.eq('read as written, {hostname} replaced, DEVPANEL first and once', [s.file, s.projectsRoot, s.proxyLogin.usersDir, s.proxyLogin.digestFiles, s.projectActions.headerMarkers, s.testDrive.confinement, s.selection.forbiddenPrefixes, s.seatGuidance.projects],
        [path.join(hostDir, 'settings.json'), '/opt/projects', `/var/lib/proxy/${os.hostname()}/users`, ['.proxy.hash', '.hash'], ['DEVPANEL', 'EDITOR'], { user: 'app', home: '/var/app' }, ['production', 'stage'], []])
      await write(path.join(hostDir, 'settings.json'), JSON.stringify({ projectsRoot: '/opt/other' }))
      t.eq('an edit is seen without a restart', hostSettings({ hostDir }).projectsRoot, '/opt/other')
      await write(path.join(hostDir, 'settings.json'), JSON.stringify({ resumeAfterShutdown: false }))
      t.eq('the automatic resume can be switched off', hostSettings({ hostDir }).resumeAfterShutdown, false)

      const projects = await temp('devpanel-settings-projects-')
      for (const name of ['production.app.example', 'stage.app.example', 'staging.app.example', 'app-project']) await fs.mkdir(path.join(projects, name))
      const roots = await forbiddenRoots({ projectsDir: projects, prefixes: ['production', 'stage'], mountinfo: '/nonexistent' })
      t.eq('the configured prefixes decide which projects-root entries are container filesystems', ['production.app.example', 'stage.app.example', 'staging.app.example', 'app-project'].map((n) => roots.has(path.join(projects, n))), [true, true, false, false])
      const neutral = await forbiddenRoots({ projectsDir: projects, mountinfo: '/nonexistent' })
      t.eq('by default production.* and staging.*', ['production.app.example', 'stage.app.example', 'staging.app.example'].map((n) => neutral.has(path.join(projects, n))), [true, false, true])
    }

    t.section('3. an invalid file is an error naming it, never a fallback to the defaults')
    {
      const hostDir = await temp('devpanel-settings-bad-')
      await write(path.join(hostDir, 'settings.json'), JSON.stringify({ selection: { forbiddenPrefixes: [] }, unknown: 1 }))
      let error = null
      try { hostSettings({ hostDir }) } catch (e) { error = e.message }
      t.ok('refused, naming the file and what is wrong', Boolean(error) && error.includes(path.join(hostDir, 'settings.json')) && /forbiddenPrefixes/.test(error) && /additional/.test(error), error)
      await write(path.join(hostDir, 'settings.json'), '{ not json')
      let syntax = null
      try { hostSettings({ hostDir }) } catch (e) { syntax = e.message }
      t.ok('so is a file that does not parse', Boolean(syntax) && syntax.includes(path.join(hostDir, 'settings.json')), syntax)
    }

    t.section('4. a pending host move: its carried settings, only under the default host directory')
    {
      const root = await temp('devpanel-settings-pending-')
      await write(path.join(root, 'tools/host-move/files/settings.json'), JSON.stringify({ projectsRoot: '/opt/carried', testDrive: { confinement: { user: 'app', home: '/var/app' } } }))
      await write(path.join(root, 'tools/host-move/manifest.json'), JSON.stringify({ entries: [{ from: 'tools/host-move/files/settings.json', to: 'host:settings.json' }] }))
      const pending = hostSettings({ root, env: {} })
      t.eq('the carried file is in force, and says so', [pending.pending, pending.file, pending.projectsRoot], [true, path.join(root, 'tools/host-move/files/settings.json'), '/opt/carried'])
      t.eq('an explicit host directory never reads the checkout\'s carried files', [hostSettings({ root, env: { [HOST_CONFIG_ENV]: '/nonexistent/host' } }).pending, pendingCarry('host:settings.json', { root, env: { [HOST_CONFIG_ENV]: 'x' } })], [false, null])
      await write(path.join(root, 'host-config/settings.json'), JSON.stringify({ projectsRoot: '/opt/installed' }))
      t.eq('once installed, the host-config file wins', [hostSettings({ root, env: {} }).pending, hostSettings({ root, env: {} }).projectsRoot], [false, '/opt/installed'])
    }

    t.section('5. the test-drive unit user: the project\'s, else the host settings\', else refused')
    {
      t.eq('the project\'s wins', withConfinementDefaults({ user: 'svc', home: '/var/svc', readOnly: ['/x'] }, { user: 'app', home: '/var/app' }), { user: 'svc', home: '/var/svc', readOnly: ['/x'] })
      t.eq('the host settings fill what it omits', withConfinementDefaults({ readOnly: ['/x'] }, { user: 'app', home: '/var/app' }), { readOnly: ['/x'], user: 'app', home: '/var/app' })
      const none = withConfinementDefaults({}, { user: null, home: null })
      let refused = null
      try { managedRemoteCommand('/opt/c', { id: 'x', kind: 'candidate', run: 'true' }, false, { control: controlDir('/opt/c'), units: {}, confinement: none }) } catch (e) { refused = e.message }
      t.ok('with neither, a candidate command is refused rather than run as some built-in account', /confinement\.user and \.home/.test(refused ?? ''), refused)
      t.ok('a privileged command needs no unit user', managedRemoteCommand('/opt/c', { id: 'p', kind: 'privileged', run: 'true' }, false, { control: controlDir('/opt/c'), units: {}, confinement: none }).includes('unshare'))
    }

    t.section('6. the daily full verification: the block schedules it, without it the cycle is off')
    {
      const root = await temp('devpanel-settings-fv-root-')
      t.eq('absent: off', hostSettings({ root, hostDir: path.join(root, 'host-config'), env: {} }).fullVerification, null)
      const hostDir = await temp('devpanel-settings-fv-')
      await write(path.join(hostDir, 'settings.json'), JSON.stringify({ fullVerification: { at: '06:00', timeZone: 'Europe/Berlin' } }))
      t.eq('the block is read as written', hostSettings({ hostDir }).fullVerification, { at: '06:00', timeZone: 'Europe/Berlin' })
      const refusal = async (block) => {
        await write(path.join(hostDir, 'settings.json'), JSON.stringify({ fullVerification: block }))
        try { hostSettings({ hostDir }); return null } catch (e) { return e.message }
      }
      t.ok('a time that is not HH:MM is refused', /fullVerification/.test(await refusal({ at: '6:00', timeZone: 'Europe/Berlin' }) ?? ''))
      t.ok('a zone the runtime does not know is refused', /fullVerification\/timeZone/.test(await refusal({ at: '06:00', timeZone: 'Nowhere/Elsewhere' }) ?? ''))
      t.ok('both keys are required', /fullVerification/.test(await refusal({ at: '06:00' }) ?? ''))
    }
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
