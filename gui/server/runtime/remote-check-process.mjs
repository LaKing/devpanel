import crypto from 'node:crypto'
import path from 'node:path'
import { hostSettings } from '../config/host-settings.mjs'
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const bash = script => `bash -c ${quote(script)}`
const manager = 'manager=(); if [[ $(id -u) != 0 ]]; then manager=(--user); fi'

/** The engine's name for a remote command's transient unit. */
export const unitName = (remoteDir, id) => 'devpanel-check-' + crypto.createHash('sha256').update(remoteDir + '\0' + id).digest('hex').slice(0, 24)

/** Where the engine's bookkeeping lives: beside the candidate, never inside it (R8-4). */
export const controlDir = (remoteDir) => `${remoteDir}.control`

/** `DEVPANEL_UNIT_<ID>` for every candidate command, so other commands can name its unit. */
export const unitVariable = (id) => 'DEVPANEL_UNIT_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')

/*
 * Remote confinement (the seat-access fence's "Candidate code execution", step
 * 0e; docs/project-infrastructure.md "Confined test drives"). A structured
 * command declares one kind:
 *
 *   kind: candidate   — the WHOLE run text executes in a transient unit as the
 *                       target's unit user (confinement.user), inside a bubblewrap
 *                       allow-list: /usr and /etc read-only, a private /tmp, an
 *                       empty home with only declared toolchain paths, and the
 *                       candidate directory. `network` keeps the host network
 *                       (otherwise PrivateNetwork), `service` leaves the unit
 *                       running (`startedMarker`: startedRule), `join` enters a running candidate service's
 *                       user, mount and network namespaces (its exact fenced
 *                       view; joinPrelude), `unprivilegedPorts` sets
 *                       the port floor inside a private network with a fixed
 *                       engine command.
 *   kind: privileged  — runs as the SSH account with the candidate and control
 *                       directories masked by empty read-only mounts, so it can
 *                       manage units by name and read host logs but cannot read
 *                       or execute any candidate file.
 *
 * Commands without a kind keep today's behaviour (unconfined, labelled so).
 *
 * The unit user and its home come from the project's testDrive.confinement,
 * else from the host settings' testDrive.confinement (withConfinementDefaults).
 * There is no built-in account: a candidate command with neither is refused.
 */
export function withConfinementDefaults (confinement = {}, defaults = hostSettings().testDrive.confinement) {
  return { ...confinement, user: confinement.user ?? defaults.user ?? undefined, home: confinement.home ?? defaults.home ?? undefined }
}

function requireAccount (confinement) {
  if (!confinement.user || !confinement.home) throw new Error('a kind: candidate command needs testDrive.confinement.user and .home, in the project or in the host settings (testDrive.confinement)')
}

export function candidateFence (remoteDir, confinement = {}) {
  requireAccount(confinement)
  const home = confinement.home
  // The private pid namespace (audit I6) is NOT in this list: the launcher
  // adds `--unshare-pid` where the unit user can mount /proc in one (see
  // pidNamespacePrelude). With the host's, candidate code could signal every
  // process of the unit user on staging (the shared instance, the operator's
  // shells, a concurrent check) and read their /proc entries.
  return ['--die-with-parent', '--tmpfs', '/', '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/sbin', '/sbin',
    '--ro-bind', '/etc', '/etc', '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
    // /sys read-only: runtimes size themselves from it (mongod's tcmalloc
    // aborts without /sys/devices/system/cpu); it holds no host secrets.
    '--proc', '/proc', '--dev', '/dev', '--ro-bind', '/sys', '/sys', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', home,
    ...(confinement.readOnly ?? []).flatMap((p) => ['--ro-bind-try', p, p]),
    ...(confinement.writable ?? []).flatMap((p) => ['--bind-try', p, p]),
    '--bind', remoteDir, remoteDir, '--chdir', remoteDir]
}

// After nsenter the working directory is set by path, inside the sandbox's
// root: a directory opened before entering would name the host's mount.
const JOINED = 'cd "$DEVPANEL_CANDIDATE_DIR" && exec /bin/sh -c "$1"'
const MASK = 'set -e; for d in "$DEVPANEL_CANDIDATE_DIR" "$DEVPANEL_CANDIDATE_DIR.control"; do mount -t tmpfs -o ro,size=4k,mode=0555 devpanel-mask "$d"; done; cd /; exec /bin/sh -c "$1"'

// systemd expands `$VAR`, `${VAR}` and `$$` in a unit's command line; the
// shell text must reach /bin/sh as written.
const literal = (value) => quote(String(value).replaceAll('$', '$$$$'))

/*
 * A joining command enters the running service's own user and mount
 * namespaces with nsenter (and its network through JoinsNamespaceOf), so it sees exactly the service's fenced view: the
 * same candidate bind, the same private network, and processes it may inspect
 * (a readiness check proves which pid holds a socket through /proc). The
 * target pid is derived by the launcher, as the SSH account, from systemd —
 * the service unit's main process (bubblewrap) and its sandboxed child —
 * never from anything the candidate wrote. Entering a user namespace grants
 * capabilities in it only until the exec of the unprivileged shell.
 */
const joinPrelude = (unit, user) => `svc=${quote(unit)}
main=$(systemctl "\${manager[@]}" show "$svc" -p MainPID --value)
[[ "$main" =~ ^[1-9][0-9]*$ ]] || { echo "the service to join ($svc) is not running" >&2; exit 1; }
join_pid=$( (cat /proc/"$main"/task/"$main"/children 2>/dev/null || true) | awk '{print $1}')
[[ -n "$join_pid" ]] || join_pid=$( (pgrep -P "$main" || true) | head -n1)
[[ "$join_pid" =~ ^[1-9][0-9]*$ ]] || { echo "the service to join ($svc) has no sandboxed process" >&2; exit 1; }
[[ "$(readlink /proc/"$join_pid"/ns/mnt)" != "$(readlink /proc/self/ns/mnt)" ]] || { echo "the service to join ($svc) is not in a fence" >&2; exit 1; }
# A fence without its own pid namespace (pidNamespacePrelude) shares ours.
pid_ns=--pid
[[ "$(readlink /proc/"$join_pid"/ns/pid)" != "$(readlink /proc/self/ns/pid)" ]] || pid_ns=
# The service's pid namespace may be the manager's (PrivatePIDs=), owned by the
# initial user namespace, which the unit user cannot enter. As root the unit
# enters the mount and pid namespaces directly and becomes the unit user inside
# (capabilities are dropped by the setuid); as the unit user it enters through
# the service's own user namespace as before.
if [[ "$(id -u)" == 0 ]]; then
  join_props=
  join_enter="--mount $pid_ns --setuid $(id -u ${quote(user)}) --setgid $(id -g ${quote(user)})"
else
  join_props=--property=User=${quote(user)}
  join_enter="--user --mount $pid_ns --preserve-credentials"
fi`

/*
 * How the candidate gets a private pid namespace with its own /proc, decided
 * per launch as the SSH account, never by the candidate:
 *   1. bubblewrap's own `--unshare-pid`, where the unit user can mount /proc
 *      in a new pid namespace (a plain host).
 *   2. `PrivatePIDs=` on the unit (systemd >= 257), where the SSH account is
 *      root. Inside systemd-nspawn the container's /proc is overmounted
 *      (kmsg, boot_id, read-only sys), so the kernel refuses an unprivileged
 *      fresh proc mount in a new pid namespace ("mount too revealing") and
 *      bubblewrap fails before the command runs; the service manager, as
 *      container root, can still create the namespace and its /proc, and
 *      bubblewrap then runs inside it without `--unshare-pid`. In an nspawn
 *      container (systemd 259, bubblewrap 0.12) pid 1 inside is then
 *      bubblewrap, exactly as in case 1, so the probe needs no special case.
 *   3. Neither: the fence runs without a pid namespace rather than not at
 *      all; the probe finds the host's pids visible and the check is labelled
 *      remote-unconfined with that reason (P6: label, don't refuse).
 * `$pid_props` goes before the command on the systemd-run line, `$pid_args`
 * to bubblewrap.
 */
export const FENCE_NOTICES = Object.freeze({
  managerPidNamespace: 'fence: private pid namespace created by the service manager (PrivatePIDs=); the unit user cannot mount /proc in one',
  noPidNamespace: 'fence: no private pid namespace here (neither the unit user nor the service manager can provide one); running without it'
})

const pidNamespacePrelude = (user) => `pid_args=--unshare-pid
pid_props=
pid_test=(/usr/bin/bwrap --die-with-parent --unshare-pid --tmpfs / --ro-bind /usr /usr --symlink usr/lib64 /lib64 --symlink usr/bin /bin --proc /proc -- /bin/true)
if [[ "$(id -u)" == 0 ]]; then pid_test=(runuser -u ${quote(user)} -- "\${pid_test[@]}"); fi
if ! "\${pid_test[@]}" 2>/dev/null; then
  pid_args=
  if [[ "$(id -u)" == 0 ]] && systemd-run --quiet --wait --pipe --collect --property=PrivatePIDs=yes --property=User=${quote(user)} -- /bin/true 2>/dev/null; then
    pid_props=--property=PrivatePIDs=yes
    echo ${quote(FENCE_NOTICES.managerPidNamespace)} >&2
  else
    echo ${quote(FENCE_NOTICES.noPidNamespace)} >&2
  fi
fi`

function execution (remoteDir, command, { units = {}, confinement = {}, runId = null } = {}) {
  const env = [`--setenv=DEVPANEL_CANDIDATE_DIR=${remoteDir}`, ...(runId ? [`--setenv=DEVPANEL_RUN_ID=${runId}`] : []), ...Object.entries(units).map(([id, unit]) => `--setenv=${unitVariable(id)}=${unit}`)]
  if (command.kind === 'candidate') {
    requireAccount(confinement)
    const { user, home } = confinement
    const base = ['--property=NoNewPrivileges=yes', `--property=WorkingDirectory=${remoteDir}`,
      `--setenv=HOME=${home}`, '--setenv=PATH=/usr/local/bin:/usr/bin:/bin', ...env]
    if (command.join) {
      // The network comes from systemd (the unit is placed in the service's
      // private network before it starts); the fence view from nsenter. A
      // network namespace owned by the host cannot be entered from inside
      // the sandbox's user namespace. Who runs the unit ($join_props) and how
      // it enters ($join_enter) are decided in the prelude.
      return { prelude: joinPrelude(units[command.join], user), properties: [...base, '--property=PrivateNetwork=yes', `--property=JoinsNamespaceOf=${units[command.join]}.service`],
        argv: `$join_props /usr/bin/nsenter --target "$join_pid" $join_enter --root -- /bin/sh -c ${literal(JOINED)} devpanel-join ${literal(command.run)}` }
    }
    const privateNet = !command.network
    const properties = [`--property=User=${user}`, ...base, ...(privateNet ? ['--property=PrivateNetwork=yes'] : []),
      ...(command.unprivilegedPorts && privateNet ? ['--property=ExecStartPre=+/usr/sbin/sysctl -q -w net.ipv4.ip_unprivileged_port_start=0'] : [])]
    return { prelude: pidNamespacePrelude(user), properties, argv: `$pid_props /usr/bin/bwrap $pid_args ${candidateFence(remoteDir, confinement).map(literal).join(' ')} -- /bin/sh -c ${literal(command.run)}` }
  }
  if (command.kind === 'privileged') {
    return { properties: ['--property=WorkingDirectory=/', ...env], argv: `/usr/bin/unshare --mount --propagation private -- /bin/sh -c ${literal(MASK)} devpanel-privileged ${literal(command.run)}` }
  }
  return { properties: [`--property=WorkingDirectory=${remoteDir}`, ...env], argv: `/bin/sh -c ${literal(command.run)}` }
}

/*
 * The started rule (docs/project-infrastructure.md "When a service counts as
 * started"): systemd-run returns once the unit is up, which says nothing about
 * what the service has written. A service declaring `startedMarker` counts as
 * started only when its unit is active and that file, relative to the candidate
 * directory, exists; the start command fails, naming the marker and the bound,
 * when the unit ends first or the bound passes. Read by the launcher as the SSH
 * account: the fence binds the candidate directory at the same path. A link is
 * not a marker, and one the candidate already holds would prove nothing.
 */
export const DEFAULT_STARTED_TIMEOUT_SECONDS = 120
const declaresStarted = (command) => command.kind === 'candidate' && command.service === true && Boolean(command.startedMarker)

// What the launcher's own waits can take before the unit is up: the launch lock
// and the registration loop, 30 s each.
const LAUNCH_ALLOWANCE_SECONDS = 60

/**
 * How long the engine lets a command's launcher run. `timeoutSeconds` covers the
 * launch; the marker's bound comes on top, so the launcher always gets to say why
 * a service did not start instead of being killed in silence.
 */
export function commandTimeoutSeconds (command) {
  const timeout = command.timeoutSeconds ?? 900
  return declaresStarted(command) ? timeout + Number(command.startedTimeoutSeconds ?? DEFAULT_STARTED_TIMEOUT_SECONDS) + LAUNCH_ALLOWANCE_SECONDS : timeout
}

function startedRule (remoteDir, command, unit) {
  const file = quote(`${remoteDir}/${command.startedMarker}`)
  const bound = Number(command.startedTimeoutSeconds ?? DEFAULT_STARTED_TIMEOUT_SECONDS)
  const notStarted = `devpanel-started: service ${command.id} did not start: `
  const marker = `marker ${command.startedMarker}`
  return {
    before: `if [[ -e ${file} || -L ${file} ]]; then
  echo ${quote(`${notStarted}${marker} already exists before the start, so it cannot show the service wrote it (bound ${bound} s not waited)`)} >&2
  exit 1
fi`,
    // From the moment the unit is up. Nanoseconds: bash's SECONDS is whole seconds.
    after: `deadline=$(($(date +%s%N)+${bound}000000000))
while :; do
  state=$(systemctl "\${manager[@]}" show ${quote(unit)} -p ActiveState --value) || state=unreadable
  seen=missing
  if [[ -f ${file} && ! -L ${file} ]]; then seen=present; fi
  if [[ "$state" == active && "$seen" == present ]]; then break; fi
  if [[ "$state" == inactive || "$state" == failed ]]; then
    echo ${quote(`${notStarted}its unit is `)}"$state"${quote(` and ${marker} is `)}"$seen"${quote(` (bound ${bound} s)`)} >&2
    exit 1
  fi
  if (($(date +%s%N) >= deadline)); then
    echo ${quote(`${notStarted}${marker} is `)}"$seen"${quote(` after the bound of ${bound} s and its unit is `)}"$state" >&2
    exit 1
  fi
  sleep 0.2
done`
  }
}

// A cgroup, not the SSH connection, owns each remote command. A launch lock
// closes the cancel-before-registration race. A retained cancel marker prevents
// a delayed original shell from starting work after cancellation was confirmed.
export function managedRemoteCommand (remoteDir, command, finalizer = false, options = {}) {
  const unit = unitName(remoteDir, command.id)
  const control = options.control ?? remoteDir
  const service = command.kind === 'candidate' && command.service === true
  const { properties, argv, prelude = ':' } = execution(remoteDir, command, options)
  const started = declaresStarted(command) ? startedRule(remoteDir, command, unit) : { before: ':', after: ':' }
  // A smoke that may be continued (`keepSeconds`) outlives its keep window, so a
  // claim within it leaves the service at least what a fresh drive has after the
  // same commands; a running unit's limit is not extended.
  const lifetime = service ? Number(command.lifetimeSeconds ?? 1800) + Number(options.keepSeconds ?? 0) : Number(command.timeoutSeconds ?? 900)
  return bash(`set -euo pipefail
${manager}
exec 9>${quote(control + '/.launch.lock')}
flock -w 30 9
${finalizer ? ':' : `test ! -e ${quote(control + '/.cancelled')}`}
test ! -e ${quote(control + '/.registration-uncertain')}
${prelude}
${started.before}
printf '%s\\n' ${quote(unit)} >> ${quote(control + (service ? '/.services' : '/.units'))}
# Durable uncertainty precedes submission: an SSH disconnect may kill this
# launcher while the manager is still registering its request.
: > ${quote(control + '/.registration-uncertain')}
systemd-run "\${manager[@]}" --no-ask-password ${service ? '' : '--wait --pipe '}--collect --unit=${quote(unit)} --property=KillMode=control-group --property=TimeoutStopSec=5s --property=RuntimeMaxSec=${lifetime}s ${properties.map(quote).join(' ')} ${argv} 9>&- &
client=$!
# The manager must register the unit before a canceller can acquire our lock.
for ((tries=0;tries<300;tries++)); do
  state=$(systemctl "\${manager[@]}" show ${quote(unit)} -p LoadState --value)
  [[ "$state" != not-found ]] && break
  kill -0 "$client" 2>/dev/null || break
  sleep 0.1
done
if [[ "$state" == not-found ]] && kill -0 "$client" 2>/dev/null; then
  # Leave the lock held until this launcher exits; cancellation cannot claim
  # success while a request of uncertain registration could still start work.
  : > ${quote(control + '/.registration-uncertain')}
  kill "$client" 2>/dev/null || true
  wait "$client" || true
  exit 75
fi
if [[ "$state" != not-found ]]; then
  rm ${quote(control + '/.registration-uncertain')}
else
  # A fast successful command may already have been collected. Only successful
  # completion is enough to clear uncertainty without observing registration.
  if wait "$client"; then
    rm ${quote(control + '/.registration-uncertain')}
    flock -u 9
    ${started.after}
    exit 0
  else
    exit $?
  fi
fi
flock -u 9
wait "$client"
${started.after}`)
}

const STOP_UNIT = `  [[ "$unit" =~ ^devpanel-check-[a-f0-9]{24}$ ]] || exit 1
  if [[ $(systemctl "\${manager[@]}" show "$unit" -p LoadState --value) != not-found ]]; then
    systemctl "\${manager[@]}" --no-ask-password stop "$unit"
    state=$(systemctl "\${manager[@]}" show "$unit" -p ActiveState --value)
    [[ "$state" == inactive || "$state" == failed ]] || exit 1
    [[ $(systemctl "\${manager[@]}" show "$unit" -p MainPID --value) == 0 ]] || exit 1
  fi`

/**
 * Stop the run's command units. Service units (a started application) are
 * stopped only when `services` is set: the first stop precedes the finalizers,
 * which may still need the application running (a report collector).
 */
export function stopRemoteCommands (remoteDir, { control = remoteDir, services = true } = {}) {
  const lists = [quote(control + '/.units'), ...(services ? [quote(control + '/.services')] : [])]
  return bash(`set -euo pipefail
${manager}
exec 9>${quote(control + '/.launch.lock')}
flock -w 35 9
: > ${quote(control + '/.cancelled')}
for list in ${lists.join(' ')}; do if [[ ! -e "$list" ]]; then : > "$list"; fi; done
cat ${lists.join(' ')} | while IFS= read -r unit; do
${STOP_UNIT}
done
test ! -e ${quote(control + '/.registration-uncertain')}
printf 'Remote command cgroups stopped and registration fenced.\\n'`)
}

/*
 * A kept instance: a smoke drive's services and candidate left running for the
 * full drive of the same revision (execution-contract.md, tiers). An expiry timer
 * armed before the instance counts as kept removes it without the panel, so a
 * panel that never returns leaves nothing behind.
 */
export const expiryUnit = (remoteDir) => unitName(remoteDir, 'devpanel-instance-expiry')

/** Stop these units by name, under the launch lock: smoke services a fresh drive would not have started. */
export function stopNamedUnits (remoteDir, { control = remoteDir, units = [] } = {}) {
  return bash(`set -euo pipefail
${manager}
exec 9>${quote(control + '/.launch.lock')}
flock -w 35 9
for unit in ${units.map(quote).join(' ')}; do
${STOP_UNIT}
done`)
}

/** `<unit>\t<ActiveState>\t<InvocationID>` per unit: systemd's identity of one start of a unit. */
export function readServiceIdentity (units) {
  return bash(`set -euo pipefail
${manager}
for unit in ${units.map(quote).join(' ')}; do
  [[ "$unit" =~ ^devpanel-check-[a-f0-9]{24}$ ]] || exit 1
  printf '%s\\t%s\\t%s\\n' "$unit" "$(systemctl "\${manager[@]}" show "$unit" -p ActiveState --value)" "$(systemctl "\${manager[@]}" show "$unit" -p InvocationID --value)"
done`)
}

// Termination first, as a drive's own cleanup: a candidate is never removed from
// under a process that could not be stopped. A control directory already gone
// means there is nothing left to stop.
const removeInstance = (remoteDir, control) => `if [[ -d ${quote(control)} ]]; then ${stopRemoteCommands(remoteDir, { control })} || exit 1; fi
rm -rf ${quote(remoteDir)} ${quote(control)} ${quote(remoteDir + '.tar')}`

export function armInstanceExpiry (remoteDir, { control = remoteDir, seconds }) {
  const removal = `set -uo pipefail\n${manager}\n${removeInstance(remoteDir, control)}`
  return bash(`set -euo pipefail
${manager}
systemd-run "\${manager[@]}" --no-ask-password --quiet --collect --on-active=${Number(seconds)}s --unit=${quote(expiryUnit(remoteDir))} --property=WorkingDirectory=/ /bin/bash -c ${literal(removal)}`)
}

const disarm = (remoteDir) => `systemctl "\${manager[@]}" --no-ask-password stop ${quote(expiryUnit(remoteDir) + '.timer')} 2>/dev/null || true
systemctl "\${manager[@]}" --no-ask-password stop ${quote(expiryUnit(remoteDir) + '.service')} 2>/dev/null || true`

/** Remove a kept instance, disarming its timer only once it is gone: a failure leaves the timer to do it. */
export function discardInstanceCommand (remoteDir, { control = remoteDir } = {}) {
  return bash(`set -uo pipefail
${manager}
${removeInstance(remoteDir, control)} || exit 1
${disarm(remoteDir)}`)
}

/**
 * Disarm the expiry and prove the instance is the one that was kept: prints
 * `devpanel-claim: ok`, or `devpanel-claim: <reason> <detail>` for an instance
 * that cannot be continued. A timer no longer waiting has fired, so its removal
 * may be under way: that instance has expired, whatever else still stands.
 */
export function claimInstance (remoteDir, { control = remoteDir, services = [] } = {}) {
  const timer = quote(expiryUnit(remoteDir) + '.timer')
  const proofs = services.map(({ unit, invocationId }) => `state=$(systemctl "\${manager[@]}" show ${quote(unit)} -p ActiveState --value)
[[ "$state" == active ]] || refuse service-not-active ${quote(unit + ' is')} "$state"
[[ "$(systemctl "\${manager[@]}" show ${quote(unit)} -p InvocationID --value)" == ${quote(invocationId)} ]] || refuse unit-identity-changed ${quote(unit + ' was started again')}`).join('\n')
  return bash(`set -uo pipefail
${manager}
refuse () { printf 'devpanel-claim: %s\\n' "$*"; exit 0; }
[[ "$(systemctl "\${manager[@]}" show ${timer} -p SubState --value)" == waiting ]] || refuse expired 'its keep window ended'
${disarm(remoteDir)}
[[ "$(systemctl "\${manager[@]}" show ${timer} -p SubState --value)" != waiting ]] || refuse unreadable 'the expiry timer could not be disarmed'
[[ -d ${quote(remoteDir)} && -d ${quote(control)} ]] || refuse instance-gone 'the candidate or control directory is gone'
exec 9>${quote(control + '/.launch.lock')}
flock -w 35 9 || refuse unreadable 'the launch lock could not be taken'
test ! -e ${quote(control + '/.registration-uncertain')} || refuse unreadable 'a command registration is uncertain'
${proofs}
printf 'devpanel-claim: ok\\n'`)
}

/** Open a proved instance to commands again: the smoke's last stop left its cancel marker. */
export function reopenInstance (remoteDir, { control = remoteDir } = {}) {
  return bash(`set -euo pipefail
exec 9>${quote(control + '/.launch.lock')}
flock -w 35 9
test ! -e ${quote(control + '/.registration-uncertain')}
rm -f ${quote(control + '/.cancelled')}`)
}

/**
 * The confinement probe (0e): an engine-owned candidate command and an
 * engine-owned privileged command, run before the target's own commands. The
 * candidate one must find nothing of the host outside its allow-list; the
 * privileged one must find the candidate directory empty.
 *
 * `binds` are the confinement's declared readOnly/writable paths. One that
 * lies INSIDE a canary (e.g. a cache under the project root) is expected: the
 * canary may then hold only that bind and the empty directories bubblewrap
 * made to reach it, and anything else visible in it still fails. A bind that
 * IS a canary or contains one exposes it whole and fails, as does a bind that
 * is not spelled canonically (its prefixes would not mean what they say).
 */
export function probeCommands (projectRoot, home, binds = []) {
  const canaries = ['/root', '/srv', '/home', '/opt', '/var/lib', '/var/log', `${home}/.ssh`, ...(projectRoot ? [projectRoot] : [])]
  const canonical = (p) => p.startsWith('/') && p.length > 1 && p.slice(1).split('/').every((s) => s && s !== '.' && s !== '..')
  const under = (p, dir) => p.startsWith(dir + '/')
  const checks = canaries.map((c) => {
    if (binds.some((b) => b === c || under(c, b))) return `echo ${quote(`VISIBLE ${c} (bound whole by the confinement)`)}; status=1`
    const inside = binds.filter((b) => under(b, c))
    if (!inside.length) {
      return c === '/srv'
        ? 'n=$(ls -A /srv | grep -v "^$(basename "$DEVPANEL_CANDIDATE_DIR")$" | wc -l); [ "$n" -eq 0 ] || { echo "VISIBLE /srv entries: $n"; status=1; }'
        : `if [ -e ${quote(c)} ]; then echo ${quote(`VISIBLE ${c}`)}; status=1; fi`
    }
    // The canary itself and every directory on the way to a bind are allowed.
    const allowed = new Set([c])
    for (const b of inside) for (let p = path.posix.dirname(b); under(p, c); p = path.posix.dirname(p)) allowed.add(p)
    const prune = [...inside.map((b) => `-path ${quote(b)}`), ...(c === '/srv' ? ['-path "$DEVPANEL_CANDIDATE_DIR"'] : [])].join(' -o ')
    return `if [ -e ${quote(c)} ]; then v=$(find ${quote(c)} \\( ${prune} \\) -prune -o -print 2>&1 | while IFS= read -r p; do case "$p" in ${[...allowed].map(quote).join('|')}) ;; *) echo "$p" ;; esac; done); [ -z "$v" ] || { echo "$v" | sed 's/^/VISIBLE /'; status=1; }; fi`
  })
  return [
    { id: 'devpanel-probe-candidate', kind: 'candidate', timeoutSeconds: 60, run: [
      'status=0',
      ...binds.filter((b) => !canonical(b)).map((b) => `echo ${quote(`NONCANONICAL-BIND ${b}`)}; status=1`),
      ...checks,
      'if [ -e "$DEVPANEL_CANDIDATE_DIR.control" ]; then echo "VISIBLE control"; status=1; fi',
      '( : > "$DEVPANEL_CANDIDATE_DIR/.devpanel-probe" ) 2>/dev/null && rm -f "$DEVPANEL_CANDIDATE_DIR/.devpanel-probe" || { echo "CANDIDATE-NOT-WRITABLE"; status=1; }',
      '( : > /usr/.devpanel-probe ) 2>/dev/null && { echo "USR-WRITABLE"; status=1; }',
      '[ "$(id -u)" != 0 ] || { echo "RUNS-AS-ROOT"; status=1; }',
      // Pid 1 inside a private pid namespace is bubblewrap itself; the host's
      // init would mean every process of the unit user is in reach.
      '[ "$(cat /proc/1/comm 2>/dev/null)" = bwrap ] || { echo "HOST-PIDS-VISIBLE ($(cat /proc/1/comm 2>/dev/null))"; status=1; }',
      'exit $status'].join('\n') },
    { id: 'devpanel-probe-privileged', kind: 'privileged', timeoutSeconds: 60, run: [
      'n=$(ls -A "$DEVPANEL_CANDIDATE_DIR" | wc -l); [ "$n" -eq 0 ] || { echo "CANDIDATE-VISIBLE ($n entries)"; exit 1; }',
      '( : > "$DEVPANEL_CANDIDATE_DIR/x" ) 2>/dev/null && { echo "MASK-WRITABLE"; exit 1; }',
      'exit 0'].join('\n') }
  ]
}

/** The level a target's command list can claim, before its probe result. */
export function confinementLevel (target) {
  const all = [...(target.commands ?? []), ...(target.finallyCommands ?? [])]
  if (all.length && all.every((c) => c.kind === 'candidate' || c.kind === 'privileged')) return 'structured'
  if (all.length && all.every((c) => c.kind === 'candidate' || c.kind === 'privileged' || c.candidate === 'attested')) return 'remote-attested'
  return 'remote-unconfined'
}
