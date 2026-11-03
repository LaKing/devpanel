import { installRemoteManager } from './fakes/remote-manager.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { runChecks } from '../server/runtime/checks.mjs'
import { continuationPlan, tierTarget } from '../server/runtime/baseline-cache.mjs'
import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { confinedCommandErrors, stagingTarget } from '../server/infrastructure.mjs'
import { managedRemoteCommand, commandTimeoutSeconds, unitName, controlDir, confinementLevel, probeCommands, candidateFence } from '../server/runtime/remote-check-process.mjs'

export const name = '0e — remote check commands: candidate code in an allow-list unit, privileged commands blind to it'

const run = promisify(execFile)
const unquote = (text) => text.replaceAll("'\\''", "'")
const NL = String.fromCharCode(10)

async function available () {
  try {
    await run('setpriv', ['--ambient-caps', '-all', '--inh-caps', '-all', 'bwrap', '--ro-bind', '/', '/', 'true'])
    await run('unshare', ['--user', '--map-root-user', '--mount', 'true'])
    return true
  } catch { return false }
}

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }

  t.section('1. what the schema cannot say is refused at configuration')
  {
    const c = (id, extra = {}) => ({ id, run: 'true', ...extra })
    t.eq('a wholly structured list is accepted', confinedCommandErrors({ commands: [c('start', { kind: 'candidate', service: true }), c('ready', { kind: 'candidate', join: 'start' })], finallyCommands: [c('logs', { kind: 'privileged' })] }), [])
    t.ok('a mixed list is refused, naming the unkinded command', confinedCommandErrors({ commands: [c('a', { kind: 'candidate' }), c('b')] }).some((e) => /mixes.*\bb\b/.test(e)))
    t.ok('candidate options on a privileged command are refused', confinedCommandErrors({ commands: [c('a', { kind: 'privileged', network: true })] }).some((e) => /network apply to kind: candidate only/.test(e)))
    t.ok('a join must name an earlier private service', confinedCommandErrors({ commands: [c('r', { kind: 'candidate', join: 's' }), c('s', { kind: 'candidate', service: true })] }).some((e) => /join must name an earlier/.test(e)))
    t.ok('joining a networked service is refused', confinedCommandErrors({ commands: [c('s', { kind: 'candidate', service: true, network: true }), c('r', { kind: 'candidate', join: 's' })] }).some((e) => /join must name/.test(e)))
    t.ok('low ports need a private network', confinedCommandErrors({ commands: [c('s', { kind: 'candidate', network: true, unprivilegedPorts: true })] }).some((e) => /private network/.test(e)))
    t.eq('a service with a started marker and a bound is accepted', confinedCommandErrors({ commands: [c('s', { kind: 'candidate', service: true, startedMarker: '.pid', startedTimeoutSeconds: 30, timeoutSeconds: 60 })] }), [])
    t.ok('a started marker on anything but a service is refused', confinedCommandErrors({ commands: [c('s', { kind: 'candidate', startedMarker: '.pid' })] }).some((e) => /startedMarker applies to a service/.test(e)))
    t.ok('a bound without a marker is refused', confinedCommandErrors({ commands: [c('s', { kind: 'candidate', service: true, startedTimeoutSeconds: 30 })] }).some((e) => /none is declared/.test(e)))
    t.eq('a bound above the command timeout is accepted: the engine adds it to the timeout', [confinedCommandErrors({ commands: [c('s', { kind: 'candidate', service: true, startedMarker: '.pid', timeoutSeconds: 60 })] }), commandTimeoutSeconds({ id: 's', kind: 'candidate', service: true, startedMarker: '.pid', timeoutSeconds: 60, startedTimeoutSeconds: 200 }) > 260], [[], true])
    t.eq('any other command keeps its timeout', [commandTimeoutSeconds({ id: 's', kind: 'candidate', service: true, timeoutSeconds: 60 }), commandTimeoutSeconds({ id: 'r', kind: 'candidate' })], [60, 900])
    const markerPattern = new RegExp(JSON.parse(await fs.readFile(new URL('../../schemas/playbook.schema.json', import.meta.url), 'utf8')).$defs.checkTarget.properties.commands.items.properties.startedMarker.pattern)
    t.ok('a marker is a plain relative path', ['.devpanel-service-pid', 'run/pid', 'a/.b'].every((m) => markerPattern.test(m)))
    t.ok('never absolute, never out of the candidate, never quoted shell', ['/etc/passwd', '../x', 'a/../b', '.', 'a/./b', 'a//b', 'a/', "a'b", '$(x)'].every((m) => !markerPattern.test(m)))
    t.ok('confinement without kinds is refused', confinedCommandErrors({ commands: [c('a')], confinement: { user: 'svc' } }).some((e) => /no command declares a kind/.test(e)))
    const target = stagingTarget({ staging: { ssh: { hostRef: 'ssh-config:x', workdir: '/opt' }, projectRoot: '/opt/app' }, testDrive: { commands: [c('a', { kind: 'candidate' })], confinement: { user: 'svc', home: '/var/svc', readOnly: ['/var/svc/.nvm'] } } })
    t.ok('the staging target carries the confinement and the project root', target.confinement?.readOnly?.[0] === '/var/svc/.nvm' && target.projectRoot === '/opt/app')
    t.eq('its level is structured', confinementLevel(target), 'structured')
    t.eq('an unkinded target is unconfined', confinementLevel({ commands: [c('a')] }), 'remote-unconfined')
  }

  t.section('2. the unit a candidate command gets')
  {
    const dir = '/opt/devpanel-check-x'
    const units = { start: unitName(dir, 'start') }
    const text = (command) => unquote(managedRemoteCommand(dir, command, false, { control: controlDir(dir), units, confinement: { user: 'svc', home: '/var/svc', readOnly: ['/var/svc/.nvm'], writable: ['/var/svc/.npm'] } }))
    // The launcher is itself one quoted bash argument; read it as bash will.
    const start = text({ id: 'start', kind: 'candidate', service: true, unprivilegedPorts: true, run: 'exec app' })
    t.ok('runs as the unit user with no new privileges', start.includes('--property=User=svc') && start.includes('--property=NoNewPrivileges=yes'))
    t.ok('inside bubblewrap on an empty root', /\/usr\/bin\/bwrap .*'--tmpfs' '\/'/.test(start))
    t.ok('with the home a tmpfs and only the declared toolchain bound', start.includes("'--tmpfs' '/var/svc'") && start.includes("'--ro-bind-try' '/var/svc/.nvm'") && start.includes("'--bind-try' '/var/svc/.npm'"))
    t.ok('in a private network with the fixed low-port command', start.includes('PrivateNetwork=yes') && start.includes('ip_unprivileged_port_start=0'))
    t.ok('a service is not waited for and is listed apart', !start.includes('--no-ask-password --wait') && start.includes(controlDir(dir) + '/.services'))
    t.ok('the bookkeeping is in the control directory, not the candidate', start.includes(controlDir(dir) + '/.launch.lock') && !start.includes(dir + '/.launch.lock'))
    const ready = text({ id: 'ready', kind: 'candidate', join: 'start', run: 'curl' })
    t.ok('a joining command enters the service\'s own namespaces, found through systemd', ready.includes('$join_props /usr/bin/nsenter --target "$join_pid" $join_enter --root') && ready.includes('pid_ns=--pid') && ready.includes(`JoinsNamespaceOf=${units.start}.service`) && ready.includes(`svc='${units.start}'`) && ready.includes('--no-ask-password --wait'))
    t.ok('as the unit user through the service\'s user namespace', ready.includes("join_props=--property=User='svc'") && ready.includes('join_enter="--user --mount $pid_ns --preserve-credentials"') && !ready.includes('--property=User=svc'))
    t.ok('or, when the launcher is root, as root into the mount and pid namespaces, becoming the unit user inside (a PrivatePIDs= namespace is owned by the initial user namespace)', ready.includes('if [[ "$(id -u)" == 0 ]]; then\n  join_props=\n  join_enter="--mount $pid_ns --setuid $(id -u \'svc\') --setgid $(id -g \'svc\')"'))
    t.ok('never through a pid the candidate wrote', !/cat [^|]*\.pid/.test(ready))
    t.ok('shell text reaches the unit with systemd expansion escaped', start.includes('$$') === false || /'exec app'/.test(start))
    const dollars = unquote(managedRemoteCommand(dir, { id: 'x', kind: 'candidate', run: 'echo $$ ${HOME} $PWD' }, false, { control: controlDir(dir), units, confinement: { user: 'svc', home: '/var/svc' } }))
    t.ok('every $ is doubled for systemd', dollars.includes("'echo $$$$ $${HOME} $$PWD'"))
    t.ok('and every command can name the service unit', ready.includes(`DEVPANEL_UNIT_START=${units.start}`))
    t.ok('a private pid namespace is requested where the unit user can mount /proc in one', start.includes('$pid_props /usr/bin/bwrap $pid_args ') && start.includes('pid_args=--unshare-pid') && start.includes("runuser -u 'svc' --"))
    t.ok('else, as root, the service manager creates it (PrivatePIDs=, proved once per launch)', /if ! "\$\{pid_test\[@\]\}" 2>\/dev\/null; then\n  pid_args=\n  if \[\[ "\$\(id -u\)" == 0 \]\] && systemd-run --quiet --wait --pipe --collect --property=PrivatePIDs=yes --property=User='svc' -- \/bin\/true 2>\/dev\/null; then\n    pid_props=--property=PrivatePIDs=yes/.test(start))
    t.ok('and dropped, saying so, where neither can (the probe then labels the check unconfined)', start.includes("echo 'fence: no private pid namespace here (neither the unit user nor the service manager can provide one); running without it' >&2"))
    t.ok('a join shares the pid namespace when the service has none of its own', ready.includes('/ns/pid)" != "$(readlink /proc/self/ns/pid)" ]] || pid_ns='))
    const install = text({ id: 'prepare', kind: 'candidate', network: true, run: 'npm ci' })
    t.ok('a networked command keeps the host network', !install.includes('PrivateNetwork'))
    const logs = text({ id: 'logs', kind: 'privileged', run: 'journalctl -u "$DEVPANEL_UNIT_START"' })
    t.ok('a privileged command masks the candidate and control directories first', logs.includes('/usr/bin/unshare') && logs.includes('mount -t tmpfs -o ro') && !logs.includes('User=svc'))
    t.ok('and starts from /, never from the candidate', logs.includes('WorkingDirectory=/'))
  }

  t.section('2b. a declared bind inside a canary is expected; anything else in that canary is not')
  {
    // The script logic alone, on the host (no fence): the host's other canaries
    // fail too, so only the lines naming the project root are read.
    const root = await temp('rc-probe-root-')
    const bind = path.join(root, 'runtime', 'cache', 'app')
    await fs.mkdir(bind, { recursive: true })
    await fs.writeFile(path.join(bind, 'inside'), 'x')
    await fs.writeFile(path.join(root, 'secret'), 'SECRET')
    await fs.writeFile(path.join(root, 'runtime', 'state'), 'x')
    const script = probeCommands(root, '/var/svc', [bind])[0].run
    const out = await run('sh', ['-c', script], { env: { ...process.env, DEVPANEL_CANDIDATE_DIR: '/nonexistent/c' } }).then((r) => r.stdout, (e) => e.stdout)
    const lines = out.split(NL).filter((l) => l.includes(root))
    t.ok('a sibling of the bind is reported', lines.includes(`VISIBLE ${path.join(root, 'secret')}`) && lines.includes(`VISIBLE ${path.join(root, 'runtime', 'state')}`), lines.join(' | '))
    t.ok('the bind, its contents and the directories leading to it are not', !lines.some((l) => l === `VISIBLE ${root}` || l.includes('/cache') || l.includes('inside')), lines.join(' | '))
    const whole = probeCommands(root, '/var/svc', [root])[0].run
    t.ok('a bind of the canary itself fails statically', whole.includes(`VISIBLE ${root} (bound whole by the confinement)`))
    t.ok('a bind containing a canary fails statically', probeCommands(null, '/var/svc', ['/var'])[0].run.includes('VISIBLE /var/lib (bound whole'))
    t.ok('a non-canonical bind fails', probeCommands(root, '/var/svc', [`${root}/runtime/../secret`])[0].run.includes('NONCANONICAL-BIND'))
    t.ok('a bind unrelated to every canary changes nothing', probeCommands(root, '/var/svc', ['/var/svc/.nvm'])[0].run === probeCommands(root, '/var/svc')[0].run)
  }

  // The npm seed as docs/project-infrastructure.md "The npm seed" describes it, on
  // a fixture project: filled by a privileged command (the candidate masked),
  // bound read-only into candidates, never writable, and copied by prepare into
  // its private home only when the version is complete.
  const SEED = '/var/cache/devpanel/npm-seed'
  const seedCopy = [
    `seed=${SEED}`,
    'version=$(readlink "$seed/current" 2>/dev/null || true)',
    'if [ -n "$version" ] && [ -e "$seed/$version/.complete" ]; then mkdir -p "$HOME/.npm" && cp -a "$seed/$version/." "$HOME/.npm/" && export npm_config_prefer_offline=true; else echo "no npm seed; downloading"; fi',
    ''].join(NL)
  t.section('2c. the npm seed is read-only to candidate commands and filled only by a privileged one')
  {
    const infra = {
      staging: { id: 'stage', ssh: { hostRef: 'ssh-config:x', workdir: '/opt' }, projectRoot: '/opt/app' },
      testDrive: {
        commands: [
          { id: 'refresh-npm-seed', kind: 'privileged', required: false, run: `src=/opt/app; flock ${SEED}.lock npm ci --ignore-scripts --prefix "$src"` },
          { id: 'prepare', kind: 'candidate', network: true, needs: ['refresh-npm-seed'], run: `set -eu\n${seedCopy}npm ci` },
          { id: 'start', kind: 'candidate', service: true, run: 'exec node app.mjs' }
        ],
        tiers: { smoke: ['refresh-npm-seed', 'prepare', 'start'] },
        confinement: { user: 'svc', home: '/var/svc', readOnly: ['/var/svc/.nvm', SEED] }
      }
    }
    t.eq('a seed refreshed by a privileged command and read by candidates is a valid structured drive', confinedCommandErrors(infra.testDrive), [])
    const target = stagingTarget(infra)
    t.eq('its level is structured', confinementLevel(target), 'structured')
    const fence = candidateFence('/opt/devpanel-check-x', target.confinement)
    t.ok('the seed is bound --ro-bind-try in every candidate unit, never --bind-try', fence.join(' ').includes(`--ro-bind-try ${SEED} ${SEED}`) && !fence.join(' ').includes(`--bind-try ${SEED}`))
    const writable = candidateFence('/opt/devpanel-check-x', { ...target.confinement, readOnly: [], writable: [SEED] })
    t.ok('declared writable instead, it would be a shared write channel (--bind-try): the read-only declaration is what keeps it out', writable.join(' ').includes(`--bind-try ${SEED} ${SEED}`))
  }

  if (!(await available())) {
    t.skip('3-5. confinement against a real bubblewrap', 'bubblewrap or unprivileged user namespaces unavailable')
    return
  }

  const projectPath = await temp('rc-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'app.sh'), 'echo up > run/state; echo $$ > run/pid; exec sleep 60' + NL)
  await fs.mkdir(path.join(projectPath, 'run')); await fs.writeFile(path.join(projectPath, 'run', '.keep'), '')
  await run('git', ['-C', projectPath, 'add', '-A']); await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'rc1', root: await temp('rc-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })

  const shimDir = await temp('rc-shim-')
  const managerEnv = await installRemoteManager(shimDir)
  const shim = path.join(shimDir, 'ssh')
  await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL, { mode: 0o755 })
  const canaryDir = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), '.devpanel-rc-canary-')))
  temps.push(canaryDir)
  await fs.writeFile(path.join(canaryDir, 'secret'), 'SECRET')
  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.CHECK_TEST_HOST }
  process.env.DEVPANEL_SSH_BIN = shim; process.env.CHECK_TEST_HOST = 'shim'
  const home = os.homedir()
  // The unit user is the account running the suite: the fake service manager runs every unit as it.
  const user = os.userInfo().username
  const check = async (target, runDir, extra = {}) => runChecks({ target, revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir, ...extra })
  const invocations = async () => (await fs.readFile(path.join(shimDir, 'units', 'invocations.jsonl'), 'utf8')).trim().split(NL).map((l) => JSON.parse(l))
  try {
    t.section('3. a structured test drive runs, fenced, and the probe proves it')
    {
      const workdir = await temp('rc-remote-')
      const runDir = await temp('rc-run-')
      const commands = [
        { id: 'prepare', kind: 'candidate', network: true, run: `set -e; test "$(cat value.txt)" = 2; mkdir -p build; echo built > build/out; test ! -e ${canaryDir}/secret; test "$HOME" = ${home}; test -z "$(ls -A "$HOME")"` },
        { id: 'start', kind: 'candidate', service: true, run: 'exec /bin/sh app.sh' },
        { id: 'ready', kind: 'candidate', join: 'start', run: 'for i in $(seq 50); do test -s run/state && break; sleep 0.1; done; test "$(cat run/state)" = up; test -n "$DEVPANEL_UNIT_START"; test "$DEVPANEL_RUN_ID" = rc-run' },
        { id: 'host-view', kind: 'privileged', run: 'test -z "$(ls -A "$DEVPANEL_CANDIDATE_DIR")"; test "$(pwd)" = /; echo "unit $DEVPANEL_UNIT_START"' }
      ]
      const finallyCommands = [
        // The service's pid is meaningful only inside its own pid namespace (audit I6).
        { id: 'service-still-up', kind: 'candidate', join: 'start', run: 'kill -0 "$(cat run/pid)"' },
        { id: 'own-pids', kind: 'candidate', run: `test "$(cat /proc/1/comm)" = bwrap; ! kill -0 ${process.pid} 2>/dev/null` },
        { id: 'logs', kind: 'privileged', required: false, run: 'echo "would read journal of $DEVPANEL_UNIT_START"' }
      ]
      const result = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands, finallyCommands, confinement: { user, home } }, runDir, { runId: 'rc-run' })
      t.eq('the checks pass', result.result, 'passed', result.error ?? JSON.stringify(result.commands.filter((c) => !c.passed)))
      if (result.result !== 'passed') for (const f of await fs.readdir(path.join(runDir, result.dir))) if (f.endsWith('.log')) console.log(f, await fs.readFile(path.join(runDir, result.dir, f), 'utf8'))
      t.eq('labelled remote-enforced', result.confinement?.level, 'remote-enforced', JSON.stringify(result.confinement))
      t.ok('both probes passed', result.confinement?.probe?.length === 2 && result.confinement.probe.every((p) => p.passed))
      t.ok('the probes are not counted as the target\'s commands', !result.commands.some((c) => c.id.startsWith('devpanel-probe')))
      t.ok('commands carry their kind', result.commands.find((c) => c.id === 'host-view')?.kind === 'privileged')
      t.eq('build output was tolerated; the candidate is unchanged', result.materialization.afterCommands?.modified, 0)
      t.ok('the service outlived the first stop (a finalizer still saw it)', result.commands.find((c) => c.id === 'service-still-up')?.passed === true)
      const inv = await invocations()
      t.ok('no command ran in the candidate as the SSH account', inv.filter((i) => !i.args.includes(`--property=User=${user}`)).every((i) => i.args.includes('--property=WorkingDirectory=/')), JSON.stringify(inv.map((i) => i.args.find((a) => a.startsWith('--property=WorkingDirectory')))))
      t.eq('exactly the service unit was not waited for', inv.filter((i) => !i.args.includes('--wait')).length, 1)
      t.eq('the remote directory and its control directory are gone', (await fs.readdir(workdir)).length, 0)
      const units = await fs.readdir(path.join(shimDir, 'units'))
      const states = await Promise.all(units.filter((u) => u.endsWith('.json')).map(async (u) => JSON.parse(await fs.readFile(path.join(shimDir, 'units', u), 'utf8'))))
      const alive = (p) => fs.readFile(`/proc/${p}/stat`, 'utf8').then((s) => !s.slice(s.lastIndexOf(')') + 2).startsWith('Z'), () => false)
      t.ok('every unit, the service included, is stopped', (await Promise.all(states.map((s) => s.pid ? alive(s.pid) : false))).every((a) => !a))
    }

    t.section('3b. a full drive continues the smoke\'s instance inside the real fence: a later command joins the service still running')
    {
      const workdir = await temp('rc-remote-')
      const runDir = await temp('rc-run-')
      const target = { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, confinement: { user, home }, tiers: { smoke: ['start', 'ready'] }, finallyCommands: [],
        commands: [
          { id: 'start', kind: 'candidate', service: true, run: 'exec /bin/sh app.sh' },
          { id: 'ready', kind: 'candidate', join: 'start', run: 'for i in $(seq 50); do test -s run/state && break; sleep 0.1; done; test "$(cat run/state)" = up' },
          { id: 'deep', kind: 'candidate', join: 'start', run: 'kill -0 "$(cat run/pid)"; test "$(cat run/state)" = up' }
        ] }
      const plan = continuationPlan(target)
      const smoke = await check({ ...tierTarget(target, 'smoke') }, runDir, { keep: { seconds: plan.keepSeconds } })
      t.ok('the smoke kept its instance', Boolean(smoke.kept), smoke.instanceNotKept ?? smoke.error)
      t.eq('and records the host it runs on', smoke.kept.host, 'shim')
      const instance = { ...smoke.kept, revision: fp.fingerprint }
      const full = await check(tierTarget(target, 'full'), runDir, { continueFrom: { instance, smoke, plan } })
      t.eq('the full drive passed', full.result, 'passed', full.error ?? JSON.stringify(full.commands.filter((c) => !c.passed)))
      t.eq('on the smoke\'s directory', full.continuedFrom?.remoteDir, instance.remoteDir)
      t.eq('executing the later command only', full.continuedFrom?.ran, ['deep'])
      t.eq('labelled remote-enforced', full.confinement?.level, 'remote-enforced', JSON.stringify(full.confinement))
      t.eq('the normal end took the instance', (await fs.readdir(workdir)).length, 0)
    }

    t.section('3c. a marker written late inside the real fence is seen by the launcher outside it, before a joining readiness runs')
    {
      const workdir = await temp('rc-remote-')
      const runDir = await temp('rc-run-')
      const commands = [
        { id: 'start', kind: 'candidate', service: true, startedMarker: 'run/pid', startedTimeoutSeconds: 30, run: 'sleep 2; exec /bin/sh app.sh' },
        { id: 'ready', kind: 'candidate', join: 'start', run: 'kill -0 "$(cat run/pid)"' }
      ]
      const result = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands, confinement: { user, home } }, runDir)
      t.eq('the drive passed', result.result, 'passed', result.error ?? JSON.stringify(result.commands.filter((c) => !c.passed)))
      t.ok('the start waited for the marker', result.commands[0].durationMs >= 1900, String(result.commands[0].durationMs))
    }

    t.section('4. candidate code cannot reach the control directory, the home or the tree above')
    {
      const workdir = await temp('rc-remote2-')
      const runDir = await temp('rc-run2-')
      const commands = [{ id: 'escape', kind: 'candidate', run: `n=0; if (: > "$DEVPANEL_CANDIDATE_DIR.control/.cancelled"); then echo CONTROL-WRITTEN; n=1; fi; if cat ${canaryDir}/secret; then echo HOME-READ; n=1; fi; if test -e ${JSON.stringify(projectPath)}; then echo PROJECT-VISIBLE; n=1; fi; exit $n` }]
      const result = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands, confinement: { user, home } }, runDir)
      const log = await fs.readFile(path.join(runDir, result.dir, 'escape.log'), 'utf8')
      const escaped = log.split(NL).filter((l) => /^[A-Z-]+$/.test(l))
      t.eq('every escape attempt failed', result.result, 'passed', escaped.join(' ') || result.error)
      t.ok('the real control directory is untouched', !escaped.includes('CONTROL-WRITTEN'))
    }

    t.section('5. a probe that fails labels the run; the checks still run (P6)')
    {
      const workdir = await temp('rc-remote3-')
      const runDir = await temp('rc-run3-')
      const result = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, projectRoot: '/usr', commands: [{ id: 'ok', kind: 'candidate', run: 'true' }], confinement: { user, home } }, runDir)
      t.eq('the checks ran and passed', result.result, 'passed', result.error)
      t.eq('labelled remote-unconfined', result.confinement?.level, 'remote-unconfined')
      t.ok('naming the failed probe', /devpanel-probe-candidate/.test(result.confinement?.reason ?? ''), result.confinement?.reason)
      const log = await fs.readFile(path.join(runDir, result.dir, 'devpanel-probe-candidate.log'), 'utf8')
      t.ok('whose log names what was visible', log.includes('VISIBLE /usr'))
      const legacy = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands: [{ id: 'ok', run: 'test ! -e .launch.lock' }] }, await temp('rc-run4-'))
      t.eq('an unkinded target is labelled unconfined, and its bookkeeping left the candidate too', [legacy.result, legacy.confinement?.level], ['passed', 'remote-unconfined'], legacy.error)
    }

    t.section('5b. an application cache under the project root, bound read-only, keeps the run enforced')
    {
      const root = await temp('rc-approot-')
      const cache = path.join(root, 'runtime', 'cache', 'app')
      await fs.mkdir(cache, { recursive: true })
      await fs.writeFile(path.join(cache, 'staged'), 'STAGED')
      await fs.writeFile(path.join(root, 'secret'), 'SECRET')
      const commands = [{ id: 'read-cache', kind: 'candidate', run: `set -e; test "$(cat ${cache}/staged)" = STAGED; test ! -e ${root}/secret; ! ( : > ${cache}/written ) 2>/dev/null` }]
      const result = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir: await temp('rc-remote5-') }, projectRoot: root, commands, confinement: { user, home, readOnly: [cache] } }, await temp('rc-run5-'))
      t.eq('the candidate reads the cache, not the rest of the project root, and cannot write it', result.result, 'passed', result.error ?? JSON.stringify(result.commands))
      t.eq('labelled remote-enforced', result.confinement?.level, 'remote-enforced', JSON.stringify(result.confinement?.probe))
      const whole = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir: await temp('rc-remote6-') }, projectRoot: root, commands: [{ id: 'ok', kind: 'candidate', run: 'true' }], confinement: { user, home, readOnly: [root] } }, await temp('rc-run6-'))
      t.eq('binding the project root itself is labelled remote-unconfined', whole.confinement?.level, 'remote-unconfined')
    }

    t.section('5c. the npm seed: a candidate reads and copies it, cannot write it, and never uses a partial version')
    {
      const seed = await temp('rc-seed-')
      await fs.mkdir(path.join(seed, 'v-1', '_cacache'), { recursive: true })
      await fs.writeFile(path.join(seed, 'v-1', '_cacache', 'tarball'), 'TGZ')
      await fs.writeFile(path.join(seed, 'v-1', '.complete'), '1' + NL)
      await fs.mkdir(path.join(seed, 'v-2', '_cacache'), { recursive: true })   // being built: no .complete
      await fs.symlink('v-1', path.join(seed, 'current'))
      // prepare's own copy step, with the seed path of this test.
      const copy = seedCopy.replaceAll('/var/cache/devpanel/npm-seed', seed)
      const commands = [{ id: 'prepare', kind: 'candidate', run: `set -eu\n${copy}set -e; test "$(cat "$HOME/.npm/_cacache/tarball")" = TGZ; test "$npm_config_prefer_offline" = true; ! ( : > ${seed}/v-1/_cacache/written ) 2>/dev/null; ! ( : > ${seed}/planted ) 2>/dev/null; echo private > "$HOME/.npm/_cacache/own"` }]
      const result = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir: await temp('rc-remote7-') }, commands, confinement: { user, home, readOnly: [seed] } }, await temp('rc-run7-'))
      t.eq('the candidate copied the seed and could not write it', result.result, 'passed', result.error ?? JSON.stringify(result.commands))
      t.eq('labelled remote-enforced', result.confinement?.level, 'remote-enforced', JSON.stringify(result.confinement?.probe))
      t.eq('nothing reached the seed', [await fs.access(path.join(seed, 'planted')).then(() => true, () => false), await fs.access(path.join(seed, 'v-1', '_cacache', 'own')).then(() => true, () => false)], [false, false])
      await fs.rm(path.join(seed, 'current'))
      await fs.symlink('v-2', path.join(seed, 'current'))
      const partial = await check({ kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir: await temp('rc-remote8-') }, commands: [{ id: 'prepare', kind: 'candidate', run: `set -eu\n${copy}test ! -e "$HOME/.npm"; test -z "\${npm_config_prefer_offline:-}"` }], confinement: { user, home, readOnly: [seed] } }, await temp('rc-run8-'))
      t.eq('a version without its completion mark is not used', partial.result, 'passed', partial.error ?? JSON.stringify(partial.commands))
    }

    t.section('6. local checks run inside the seat fence')
    {
      const savedFence = process.env.DEVPANEL_FENCE
      delete process.env.DEVPANEL_FENCE
      try {
        const runDir = await temp('rc-local-')
        const probe = `n=0; if cat ${canaryDir}/secret; then echo HOME-READ; n=1; fi; if test -e ${JSON.stringify(projectPath)}; then echo PROJECT-VISIBLE; n=1; fi; if test -n "$DEVPANEL_SSH_BIN"; then echo PANEL-ENV; n=1; fi; mkdir -p build && echo ok > build/out || { echo NOT-WRITABLE; n=1; }; test "$(cat value.txt)" = 2 || n=1; exit $n`
        const result = await check({ kind: 'local', commands: [{ id: 'local-escape', run: probe }] }, runDir)
        const log = await fs.readFile(path.join(runDir, result.dir, 'local-escape.log'), 'utf8')
        t.eq('labelled local-enforced', result.confinement?.level, 'local-enforced', result.confinement?.reason)
        t.eq('the candidate is usable and nothing else is', result.result, 'passed', log.split(NL).filter((l) => /^[A-Z-]+$/.test(l)).join(' ') || result.error)
        // A fence that cannot be proved (here: a toolchain path that is a
        // canary) runs no candidate code (audit I5), unless the operator says so.
        const savedBwrap = process.env.DEVPANEL_BWRAP_BIN
        process.env.DEVPANEL_BWRAP_BIN = '/nonexistent/bwrap'
        let unproved, switched
        try {
          unproved = await check({ kind: 'local', commands: [{ id: 'plain', run: 'echo RAN' }] }, await temp('rc-local3-'))
          process.env.DEVPANEL_FENCE_UNPROVED = 'run'
          switched = await check({ kind: 'local', commands: [{ id: 'plain', run: 'echo RAN' }] }, await temp('rc-local4-'))
        } finally {
          delete process.env.DEVPANEL_FENCE_UNPROVED
          if (savedBwrap === undefined) delete process.env.DEVPANEL_BWRAP_BIN; else process.env.DEVPANEL_BWRAP_BIN = savedBwrap
        }
        t.eq('an unproved fence makes the check unavailable', [unproved.result, unproved.confinement?.level], ['unavailable', 'local-refused'], unproved.error)
        t.ok('with the reason, and no command ran', /could not be proved/.test(unproved.error ?? '') && unproved.commands.length === 0, unproved.error)
        t.eq('with the operator switch it runs, labelled unconfined', [switched.result, switched.confinement?.level], ['passed', 'local-unconfined'], switched.error)
        process.env.DEVPANEL_FENCE = 'off'
        const off = await check({ kind: 'local', commands: [{ id: 'plain', run: 'true' }] }, await temp('rc-local2-'))
        t.eq('switched off, it is labelled unconfined and still runs', [off.result, off.confinement?.level], ['passed', 'local-unconfined'])
      } finally { if (savedFence === undefined) delete process.env.DEVPANEL_FENCE; else process.env.DEVPANEL_FENCE = savedFence }
    }
  } finally {
    for (const [k, v] of [['DEVPANEL_SSH_BIN', saved.bin], ['CHECK_TEST_HOST', saved.host]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await run('git', ['-C', projectPath, 'worktree', 'remove', '--force', ws.path]).catch(() => {})
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
