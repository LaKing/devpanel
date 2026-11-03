import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { installRemoteManager } from './fakes/remote-manager.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { holdDriveSlot, slotDirectory } from '../server/runtime/drive-slots.mjs'
import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { systemClock } from '../server/runtime/clock.mjs'
import { sshConnection } from '../server/runtime/ssh.mjs'

export const name = 'drive slots — remote drives per staging host, pinned to the host whose slot they hold'

const run = promisify(execFile)
const NL = String.fromCharCode(10)

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }

  const projectPath = await temp('ds-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'value.txt'), '1' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'ds', root: await temp('ds-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })

  // The SSH shim: `-G` answers from map-<destination> (else the destination), fail-<destination>
  // makes it fail, slow-<destination> makes the next one outlast its attempt. Every other call is
  // a connection: it logs "<pinned hostname>|<destination>" and runs the remote command.
  const shimDir = await temp('ds-shim-')
  const managerEnv = await installRemoteManager(shimDir)
  await fs.mkdir(path.join(shimDir, 'units'))
  await fs.writeFile(path.join(shimDir, 'units', 'no-fence'), '')
  const shim = path.join(shimDir, 'ssh')
  const state = await temp('ds-state-')
  await fs.writeFile(shim, [
    '#!/bin/sh',
    `D='${state}'`,
    'for last; do :; done',
    'if [ "$1" = -G ]; then',
    '  name=${last#*@}',
    '  if [ -e "$D/slow-$name" ]; then rm -f "$D/slow-$name"; sleep 20; fi',
    '  if [ -e "$D/fail-$name" ]; then echo "no config for $name" >&2; exit 255; fi',
    '  h=$(cat "$D/map-$name" 2>/dev/null || echo "$name")',
    '  echo "host $name"; echo "hostname $h"; echo "user u"',
    '  case " $* " in *" HostName="*) if [ -e "$D/differ-$name" ]; then echo "port 22"; else echo "port 4444"; fi;; *) echo "port 4444";; esac',
    '  exit 0',
    'fi',
    managerEnv,
    'pin=""; prev=""; dest=""',
    'for a; do case "$a" in HostName=*) pin="${a#HostName=}";; esac; dest="$prev"; prev="$a"; done',
    'echo "$pin|$dest" >> "$D/connections"',
    'if [ -e "$D/down-$dest" ]; then echo "ssh: connect: refused" >&2; exit 255; fi',
    'exec /bin/sh -c "$last"'
  ].join(NL) + NL, { mode: 0o755 })

  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.DEVPANEL_HOST_CONFIG_DIR }
  process.env.DEVPANEL_SSH_BIN = shim

  let slotsDir = await temp('ds-slots-')
  const timing = () => ({ slotsDir, pollMs: 20, retryMs: 20, attemptMs: 2000, windowMs: 4000 })
  const gate = (name) => path.join(state, `go-${name}`)
  const started = (name) => path.join(state, `started-${name}`)
  const exists = (p) => fs.lstat(p).then(() => true, () => false)
  const until = async (label, check, ms = 20000) => {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 400))
  const held = (name) => [{ id: 'hold', run: `touch '${started(name)}'; while [ ! -e '${gate(name)}' ]; do sleep 0.05; done` }]
  const drive = async (hostRef, name, extra = {}) => runChecks({ baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, revision: fp.fingerprint, fingerprint: fp,
    target: { kind: 'ssh', ssh: { hostRef, workdir: await temp('ds-remote-') }, commands: held(name) }, runDir: await temp('ds-run-'), driveTiming: timing(), ...extra })
  const go = (...names) => Promise.all(names.map((name) => fs.writeFile(gate(name), '')))
  const log = async () => (await fs.readFile(path.join(state, 'connections'), 'utf8').catch(() => '')).split(NL).filter(Boolean)
  const reset = async () => { slotsDir = await temp('ds-slots-'); await fs.rm(path.join(state, 'connections'), { force: true }) }

  try {
    t.section('at the default cap a third drive on one host waits; a drive on another host does not')
    {
      t.eq('the default is 2', hostSettings().testDrive.maxConcurrentDrives, 2)
      const a = drive('ssh-config:host-a', 'a1'), b = drive('ssh-config:host-a', 'a2')
      await until('both drives', async () => await exists(started('a1')) && await exists(started('a2')))
      const c = drive('ssh-config:host-a', 'a3')
      const other = drive('ssh-config:host-b', 'b1')
      await until('the drive on the other host', () => exists(started('b1')))
      await settle()
      t.eq('the third has not started', await exists(started('a3')), false)
      await go('a1')
      t.eq('the first passes', (await a).result, 'passed', (await a).error)
      await until('the third, once a slot frees', () => exists(started('a3')))
      await go('a2', 'a3', 'b1')
      const [second, third, beside] = await Promise.all([b, c, other])
      t.eq('none failed', [second.result, third.result, beside.result], ['passed', 'passed', 'passed'], third.error)
      t.ok('the third\'s wait is on its result', third.driveSlot.waitMs > 0 && Boolean(third.driveSlot.waitedFrom), JSON.stringify(third.driveSlot))
      t.eq('naming its host and the cap', [third.driveSlot.host, third.driveSlot.cap], ['host-a', 2])
      t.eq('the others waited for nothing', [(await a).driveSlot.waitMs, beside.driveSlot.waitMs], [0, 0])
      t.ok('the drive time includes the wait', third.durationMs >= third.driveSlot.waitMs)
    }

    t.section('two aliases resolving to one hostname share slots')
    {
      await reset()
      await fs.writeFile(path.join(state, 'map-alias-1'), 'Shared.Example.Test')
      await fs.writeFile(path.join(state, 'map-alias-2'), 'shared.example.test')
      const a = drive('ssh-config:root@alias-1', 'al1'), b = drive('ssh-config:alias-2', 'al2')
      await until('both', async () => await exists(started('al1')) && await exists(started('al2')))
      const c = drive('ssh-config:alias-1', 'al3')
      await settle()
      t.eq('the third waits, whichever spelling reached it', await exists(started('al3')), false)
      await go('al1', 'al2', 'al3')
      const results = await Promise.all([a, b, c])
      t.eq('counted as one host, its name as ssh gives it', results.map((r) => r.driveSlot.host), ['shared.example.test', 'shared.example.test', 'shared.example.test'])
      t.ok('every connection names it', (await log()).every((line) => line.startsWith('shared.example.test|')), (await log()).join(' '))
    }

    t.section('two projects share the count: nothing of a project is in the key')
    {
      await reset()
      const a = drive('ssh-config:host-p', 'p1', { runId: 'run-of-project-one' })
      const b = drive('ssh-config:host-p', 'p2', { runId: 'run-of-project-two' })
      await until('both', async () => await exists(started('p1')) && await exists(started('p2')))
      const c = drive('ssh-config:host-p', 'p3', { runId: 'run-of-project-three' })
      await settle()
      t.eq('a third run elsewhere waits', await exists(started('p3')), false)
      await go('p1', 'p2', 'p3')
      await Promise.all([a, b, c])
    }

    t.section('the setting is honoured, and the schema refuses a cap of 0')
    {
      await reset()
      const dir = await temp('ds-host-config-')
      await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ testDrive: { maxConcurrentDrives: 1 } }))
      process.env.DEVPANEL_HOST_CONFIG_DIR = dir
      t.eq('it is read', hostSettings().testDrive.maxConcurrentDrives, 1)
      const a = drive('ssh-config:host-s', 's1')
      await until('the first', () => exists(started('s1')))
      const b = drive('ssh-config:host-s', 's2')
      await settle()
      t.eq('at a cap of one the second waits', await exists(started('s2')), false)
      await go('s1', 's2')
      t.eq('and then runs', (await Promise.all([a, b])).map((r) => r.result), ['passed', 'passed'])

      await new Promise((resolve) => setTimeout(resolve, 20))
      await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ testDrive: { maxConcurrentDrives: 0 } }))
      t.ok('a cap of 0 is refused', (() => { try { hostSettings(); return false } catch (error) { return /maxConcurrentDrives|>= 1/.test(error.message) } })())
      process.env.DEVPANEL_HOST_CONFIG_DIR = saved.host
    }

    t.section('resolved and unresolved drives for one host keep the cap')
    {
      await reset()
      await fs.writeFile(path.join(state, 'map-alias-flaky'), 'host-m')
      await fs.writeFile(path.join(state, 'fail-alias-flaky'), '')
      const a = drive('ssh-config:host-m', 'm1'), b = drive('ssh-config:host-m', 'm2')
      await until('both resolved drives', async () => await exists(started('m1')) && await exists(started('m2')))
      const flaky = drive('ssh-config:alias-flaky', 'm3', { driveTiming: { ...timing(), windowMs: 30000 } })
      await settle()
      const flakyLines = async () => (await log()).filter((line) => line.endsWith('|alias-flaky'))
      t.eq('while its -G fails it connects to nothing', await flakyLines(), [])
      await fs.rm(path.join(state, 'fail-alias-flaky'))
      await settle()
      t.eq('resolved to the same host, it still connects to nothing while the slots are held', await flakyLines(), [])
      await go('m1')
      await until('the drive, once a slot frees', () => exists(started('m3')))
      t.ok('only then does it connect, pinned', (await flakyLines()).length > 0 && (await flakyLines()).every((line) => line === 'host-m|alias-flaky'), (await flakyLines()).join(' '))
      await go('m2', 'm3')
      const [, , last] = await Promise.all([a, b, flaky])
      t.eq('it passes', last.result, 'passed', last.error)
      t.ok('having waited, its failed reads counted', last.driveSlot.waitMs > 0 && last.driveSlot.resolveAttempts > 1, JSON.stringify(last.driveSlot))
    }

    t.section('a transient timeout: the next read answers and the drive passes')
    {
      await reset()
      await fs.writeFile(path.join(state, 'slow-host-t'), '')
      await go('t1')
      const result = await drive('ssh-config:host-t', 't1', { driveTiming: { ...timing(), attemptMs: 300, windowMs: 30000 } })
      t.eq('it passes', result.result, 'passed', result.error)
      t.ok('after a second attempt', result.driveSlot.resolveAttempts >= 2, JSON.stringify(result.driveSlot))
    }

    t.section('stays unresolved: unavailable, no connection, no slot')
    {
      await reset()
      await fs.writeFile(path.join(state, 'fail-host-u'), '')
      const result = await drive('ssh-config:host-u', 'u1', { driveTiming: { ...timing(), windowMs: 150 } })
      t.eq('the drive is unavailable, not failed', result.result, 'unavailable')
      t.ok('naming the reference and what ssh said', /ssh-config:host-u/.test(result.error) && /no config for host-u/.test(result.error), result.error)
      t.eq('no host, and no connection', [result.driveSlot.host, await log()], [null, []])
      await fs.rm(path.join(state, 'fail-host-u'))
    }

    t.section('a shim without -G ends the same way')
    {
      await reset()
      const plain = path.join(await temp('ds-plain-'), 'ssh')
      await fs.writeFile(plain, ['#!/bin/sh', 'for last; do :; done', `echo "$1" >> '${state}/connections'`, 'exec /bin/sh -c "$last"'].join(NL) + NL, { mode: 0o755 })
      process.env.DEVPANEL_SSH_BIN = plain
      const result = await drive('ssh-config:not-a-command-here', 'n1', { driveTiming: { ...timing(), windowMs: 150 } })
      process.env.DEVPANEL_SSH_BIN = shim
      t.eq('unavailable', result.result, 'unavailable')
      const calls = await log()
      t.ok('it only ever asked -G, and connected to nothing', calls.length > 0 && calls.every((first) => first === '-G'), calls.join(' '))
    }

    t.section('a changed reference keeps the drive on its slot\'s host')
    {
      await reset()
      const ref = path.join(await temp('ds-ref-'), 'host')
      await fs.writeFile(ref, 'host-c\n')
      const first = drive(`file:${ref}`, 'c1')
      await until('the drive', () => exists(started('c1')))
      await fs.writeFile(ref, 'host-d\n')
      // host-d's count is unaffected: two run at once, a third waits.
      const d1 = drive('ssh-config:host-d', 'd1'), d2 = drive('ssh-config:host-d', 'd2')
      await until('two drives on the other host', async () => await exists(started('d1')) && await exists(started('d2')))
      const d3 = drive('ssh-config:host-d', 'd3')
      await settle()
      t.eq('a third there waits, so the first drive is not counted there', await exists(started('d3')), false)
      await go('d1', 'd2', 'd3')
      await Promise.all([d1, d2, d3])
      const before = (await log()).filter((line) => line.startsWith('host-d|')).length
      await go('c1')
      const result = await first
      t.eq('the drive passes', result.result, 'passed', result.error)
      t.eq('on its slot\'s host', result.driveSlot.host, 'host-c')
      const lines = await log()
      t.eq('its later connections (listing, cleanup) did not reach the other host', lines.filter((line) => line.startsWith('host-d|')).length, before)
      t.ok('every one of its connections shows the pin', lines.filter((line) => line.startsWith('host-c|')).length >= 3 && lines.filter((line) => line.includes('host-c')).every((line) => line === 'host-c|host-c'), lines.join(' '))
    }

    t.section('a changed alias keeps the drive on its slot\'s host')
    {
      await reset()
      await fs.writeFile(path.join(state, 'map-alias-x'), 'host-e')
      const first = drive('ssh-config:alias-x', 'e1')
      await until('the drive', () => exists(started('e1')))
      await fs.writeFile(path.join(state, 'map-alias-x'), 'host-f')
      const f1 = drive('ssh-config:host-f', 'f1'), f2 = drive('ssh-config:host-f', 'f2')
      await until('two drives on the other host', async () => await exists(started('f1')) && await exists(started('f2')))
      const e2 = drive('ssh-config:host-e', 'e2'), e3 = drive('ssh-config:host-e', 'e3')
      await until('one beside it on its own host', async () => await exists(started('e2')) || await exists(started('e3')))
      await settle()
      t.eq('its own host is full with it', (await exists(started('e2'))) && (await exists(started('e3'))), false)
      await go('e1', 'e2', 'e3', 'f1', 'f2')
      const [result] = await Promise.all([first, f1, f2, e2, e3])
      t.eq('counted on the host it read', result.driveSlot.host, 'host-e')
      const lines = (await log()).filter((line) => line.endsWith('|alias-x'))
      t.ok('every connection of it stays pinned', lines.length >= 3 && lines.every((line) => line === 'host-e|alias-x'), lines.join(' '))
    }

    t.section('a kept instance on another host: the claim refuses, and the discard goes to its host')
    {
      await reset()
      const instance = { remoteDir: path.join(await temp('ds-kept-'), 'devpanel-check-kept'), host: 'host-kept', services: [], revision: fp.fingerprint }
      await go('k1')
      const result = await drive('ssh-config:host-new', 'k1', { continueFrom: { instance, smoke: { dir: 'checks/none', commands: [] }, plan: { smokeRun: [], continuation: [] } } })
      t.eq('from scratch, saying why', [result.continuation?.continued, result.continuation?.reason], [false, 'host-changed'], JSON.stringify(result.continuation))
      t.eq('the drive still ran, on its own host', [result.result, result.driveSlot.host], ['passed', 'host-new'], result.error)
      const lines = await log()
      t.ok('the discard went to the kept host', lines.includes('host-kept|host-new'), lines.join(' '))
      t.ok('the drive to its own', lines.includes('host-new|host-new'), lines.join(' '))
    }

    t.section('the real ssh: alias settings survive the pin, a repointed alias does not move it, a Match on the alias refuses')
    {
      const ssh = await run('sh', ['-c', 'command -v ssh']).then((r) => r.stdout.trim(), () => '')
      if (!ssh) t.skip('no ssh on this host')
      else {
        await reset()
        const dir = await temp('ds-real-')
        const config = path.join(dir, 'config')
        const writeConfig = (hostName) => fs.writeFile(config, [
          'Host alias-a', `  HostName ${hostName}`, '  User alice', '  Port 2222', '  IdentityFile /nonexistent/key-a', '  ProxyJump jump.example.test',
          'Match host alias-only', '  Port 4444', 'Host alias-only', '  HostName host-o.example.test',
          'Match originalhost alias-kept', '  Port 5555', 'Host alias-kept', '  HostName host-k.example.test'
        ].join(NL) + NL, { mode: 0o600 })
        await writeConfig('host-a.example.test')
        const wrapper = path.join(dir, 'ssh')
        await fs.writeFile(wrapper, ['#!/bin/sh', `exec '${ssh}' -F '${config}' "$@"`].join(NL) + NL, { mode: 0o755 })
        process.env.DEVPANEL_SSH_BIN = wrapper
        try {
          const target = { ssh: { hostRef: 'ssh-config:root@alias-a', workdir: '/tmp' } }
          const plainArgs = (await sshConnection(target.ssh)).args
          t.ok('the panel\'s own -o arguments are in play', plainArgs.includes('BatchMode=yes') && plainArgs.includes('ConnectTimeout=20'), plainArgs.join(' '))
          const slot = await holdDriveSlot({ target, result: {}, clock: systemClock, ...timing() })
          t.eq('resolved to the alias\'s HostName', slot.host, 'host-a.example.test')
          const read = async () => (await run(slot.connection.command, ['-G', ...slot.connection.args])).stdout
          const pinned = await read()
          t.ok('the pin is on the connection', slot.connection.args.includes('HostName=host-a.example.test'), slot.connection.args.join(' '))
          t.ok('user, port, identity and proxy survive', /^user root$/m.test(pinned) && /^port 2222$/m.test(pinned) && /^identityfile \/nonexistent\/key-a$/m.test(pinned) && /^proxyjump jump\.example\.test$/m.test(pinned), pinned.split(NL).slice(0, 6).join(' / '))
          await writeConfig('host-moved.example.test')
          t.ok('repointing the alias does not move the pinned hostname', /^hostname host-a\.example\.test$/m.test(await read()))
          await slot.release()

          const kept = await holdDriveSlot({ target: { ssh: { hostRef: 'ssh-config:alias-kept', workdir: '/tmp' } }, result: {}, clock: systemClock, ...timing() })
          t.eq('Match originalhost is the remedy: it survives', kept.host, 'host-k.example.test')
          await kept.release()

          const refused = await runChecks({ baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, revision: fp.fingerprint, fingerprint: fp, runDir: await temp('ds-run-'), driveTiming: timing(),
            target: { kind: 'ssh', ssh: { hostRef: 'ssh-config:alias-only', workdir: '/tmp' }, commands: [{ id: 'never', run: 'true' }] } })
          t.eq('a Match host on the alias: unavailable', refused.result, 'unavailable')
          t.ok('naming the setting and the remedy', /\bport\b/.test(refused.error) && /Match originalhost/.test(refused.error), refused.error)
          t.eq('having run nothing', refused.commands, [])
        } finally { process.env.DEVPANEL_SSH_BIN = shim }
      }
    }

    t.section('the pin that would change the connection, from a shim: no connection, no slot')
    {
      await reset()
      await fs.writeFile(path.join(state, 'differ-host-z'), '')
      const result = await drive('ssh-config:host-z', 'z1')
      t.eq('unavailable', result.result, 'unavailable')
      t.ok('naming the setting', /\bport\b/.test(result.error), result.error)
      t.eq('no connection', await log(), [])
      const free = await acquire(path.join(slotDirectory('host-z', slotsDir), 'slot-0.lock'), { purpose: 'test' })
      t.ok('and no slot is held', Boolean(free))
      await free.release()
    }

    t.section('where the slots live: never the checkout under the test runner, the issue root otherwise')
    {
      const savedSlots = process.env.DEVPANEL_DRIVE_SLOTS_DIR, savedIssues = process.env.DEVPANEL_ISSUES_DIR
      try {
        t.ok('the runner keeps them out of the checkout', Boolean(savedSlots) && slotDirectory('h').startsWith(savedSlots + path.sep), slotDirectory('h'))
        delete process.env.DEVPANEL_DRIVE_SLOTS_DIR
        process.env.DEVPANEL_ISSUES_DIR = path.join(os.tmpdir(), 'issue-root')
        t.ok('a server keeps them in its issue root, shared by every project', slotDirectory('h').startsWith(path.join(os.tmpdir(), 'issue-root', '.drive-slots') + path.sep), slotDirectory('h'))
      } finally {
        process.env.DEVPANEL_DRIVE_SLOTS_DIR = savedSlots
        if (savedIssues === undefined) delete process.env.DEVPANEL_ISSUES_DIR; else process.env.DEVPANEL_ISSUES_DIR = savedIssues
      }
    }

    t.section('a failure as the wait ends leaves no slot held')
    {
      await reset()
      const dir = slotDirectory('host-leak', slotsDir)
      const holders = await Promise.all([0, 1].map((n) => acquire(path.join(dir, `slot-${n}.lock`), { purpose: 'test' })))
      let waited = false
      const running = drive('ssh-config:host-leak', 'leak1', { onDriveWait: async ({ phase }) => {
        if (phase === 'start') waited = true
        else throw new Error('the run record could not be written')
      } })
      await until('the drive to wait', () => waited)
      await Promise.all(holders.map((lock) => lock.release()))
      const result = await running
      t.eq('the drive is unavailable, saying why', [result.result, result.error], ['unavailable', 'the run record could not be written'])
      t.eq('and connected to nothing', await log(), [])
      t.eq('its wait is still on the result', result.driveSlot.host, 'host-leak')
      const next = await Promise.all([0, 1].map((n) => acquire(path.join(dir, `slot-${n}.lock`), { purpose: 'test' })))
      t.eq('the next acquisition of every slot succeeds', next.length, 2)
      await Promise.all(next.map((lock) => lock.release()))
    }

    t.section('local checks are not capped')
    {
      const running = Array.from({ length: 4 }, (_, i) => `local-${i}`)
      const all = running.map(async (name) => runChecks({ baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, revision: fp.fingerprint, fingerprint: fp, runDir: await temp('ds-run-'),
        target: { kind: 'local', commands: held(name) } }))
      await until('all four at once', async () => (await Promise.all(running.map((name) => exists(started(name))))).every(Boolean))
      t.ok('over the cap, all running', true)
      await go(...running)
      const results = await Promise.all(all)
      t.eq('all pass', results.map((r) => r.result), results.map(() => 'passed'), results.map((r) => r.error).join(' '))
      t.eq('with no slot on record', results.map((r) => r.driveSlot), results.map(() => undefined))
    }
  } finally {
    if (saved.bin === undefined) delete process.env.DEVPANEL_SSH_BIN; else process.env.DEVPANEL_SSH_BIN = saved.bin
    process.env.DEVPANEL_HOST_CONFIG_DIR = saved.host
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
