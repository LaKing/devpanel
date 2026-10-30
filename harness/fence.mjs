import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runProcess, ProcessError } from '../gui/server/runtime/process.mjs'
import { discoveredProjects, issuesRoot, projectsRoot, tokenFile } from '../gui/server/project-path.mjs'
import { hostSettings } from '../gui/server/config/host-settings.mjs'
import { fencePolicy } from '../gui/server/runtime/confinement-policy.mjs'
import { hostPlatform } from '../gui/server/runtime/platform.mjs'

/*
 * The seat fence (harness/README.md "Seat hygiene",
 * fence.namespace: 1): an allow-list mount namespace around the whole CLI
 * process, built with bubblewrap and proved before the CLI starts.
 *
 * What the seat's process tree can see:
 *   - `/usr` and `/etc` read-only, the /bin /lib /lib64 /sbin links, `/proc`,
 *     `/dev`, a private `/tmp` and `/var/tmp`, systemd-resolved's directory;
 *   - `$HOME` as an empty tmpfs with only the CLI's install (read-only) and the
 *     connection's own config directory (read-write: its login and sessions)
 *     bound back in;
 *   - the run's paths: writable ones (the worktree for the writer, scratch,
 *     the adapter's runtime temp) and read-only ones (the worktree for others,
 *     evidence, allowed roots, the source repository's `.git`);
 *   - the worktree's own `.git` entry bound read-only over itself, so it cannot
 *     be replaced (R9-1; the engine never follows it either, engine-git.mjs);
 *   - the project's tooling mounts (`workspace.tooling.mounts`): host
 *     directories bound read-only at worktree-relative targets, and the panel's
 *     own `harness/tooling` (the offline wrapper) at TOOLING_BIN.
 * Nothing else: other projects, container mounts under the projects root, `~/.ssh`, the
 * panel token, `issues/.supervisor`, other CLIs' homes are simply absent.
 * The network namespace is shared (decision 5); the CLI's own sandbox still
 * governs its shell.
 *
 * Every spawn goes through `setpriv --ambient-caps -all --inh-caps -all`:
 * bubblewrap refuses to start under ambient capabilities.
 */

/** The panel's own checkout: its token, supervisor state and source are canaries. */
export const PANEL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/**
 * The fence for a turn that has no run (top-level supervisor, model oracle,
 * performance probe): tool-free, so only its own working directory and scratch
 * are mounted. Null when the fence is switched off (DEVPANEL_FENCE=off) or
 * this install opted in to unfenced operation (confinement-policy.mjs); on a
 * host without bubblewrap and without the opt-in the spec is returned, so
 * applyFence and assertFenced refuse the turn.
 */
export function runlessFence ({ cwd, writable = [] }) {
  if (['off', 'unfenced'].includes(fencePolicy().mode)) return null
  return { cwd, writable: [...new Set([cwd, ...writable])], readOnly: [], entries: [], panelRoot: PANEL_ROOT }
}

/** Where the panel's harness/tooling (offline wrapper, launchers) appears inside the fence. */
export const TOOLING_BIN = '/run/devpanel/tooling'

const BWRAP = () => process.env.DEVPANEL_BWRAP_BIN ?? 'bwrap'
const SETPRIV = () => process.env.DEVPANEL_SETPRIV_BIN ?? 'setpriv'
const NL = String.fromCharCode(10)

const exists = (p) => fs.lstat(p).then(() => true, () => false)

async function canonical (p) {
  return fs.realpath(p)
}

/**
 * The bubblewrap arguments for one turn.
 *
 * @param spec.cwd        where the CLI starts (inside a granted path)
 * @param spec.writable   directories the process tree may write
 * @param spec.readOnly   directories (or files) it may only read
 * @param spec.entries    files to bind read-only over themselves last (a worktree's `.git`)
 * @param spec.home       the real home directory, replaced by a tmpfs
 * @param spec.homeBinds  [{ path, writable }] bound back into the home
 * @param spec.mounts     [{ source, target }] tooling directories bound read-only
 *                        at their target (an existing directory in the worktree)
 * @param spec.toolingBin the panel's harness/tooling, bound read-only at TOOLING_BIN
 */
export async function fenceArgs (spec) {
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--new-session',
    '--tmpfs', '/',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/sbin', '/sbin',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/var/tmp']
  if (await exists('/run/systemd/resolve')) args.push('--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve')
  const home = spec.home ?? os.homedir()
  args.push('--tmpfs', home)
  for (const bind of spec.homeBinds ?? []) {
    if (!await exists(bind.path)) continue
    const real = await canonical(bind.path)
    args.push(bind.writable ? '--bind' : '--ro-bind', real, real)
    // A spelling through a link (e.g. ~/.local/bin/claude -> versions/…) is
    // recreated as the same link inside, so the path the adapter execs works.
    if (real !== path.resolve(bind.path)) args.push('--symlink', await fs.readlink(bind.path).catch(() => real), path.resolve(bind.path))
  }
  for (const dir of spec.readOnly ?? []) {
    if (!await exists(dir)) continue
    const real = await canonical(dir)
    args.push('--ro-bind', real, real)
    if (real !== path.resolve(dir)) args.push('--symlink', real, path.resolve(dir))
  }
  for (const dir of spec.writable ?? []) {
    const real = await canonical(dir)
    args.push('--bind', real, real)
    if (real !== path.resolve(dir)) args.push('--symlink', real, path.resolve(dir))
  }
  // Tooling mounts, after the worktree they sit in. Never skipped: a seat told
  // it may run the project's tooling must not find an empty directory.
  for (const mount of spec.mounts ?? []) {
    if (!await exists(mount.source)) throw new Error(`tooling mount source ${mount.source} does not exist`)
    args.push('--ro-bind', await canonical(mount.source), mount.target)
  }
  if (spec.toolingBin) args.push('--ro-bind', await canonical(spec.toolingBin), TOOLING_BIN)
  for (const file of spec.entries ?? []) {
    if (!await exists(file)) continue
    const real = await canonical(file)
    args.push('--ro-bind', real, real)
  }
  // A file bound at another path (a CLI's credential file into a per-run
  // home): writes go to the real file, which the CLI rewrites in place when a
  // rename onto the mount is refused. The source is resolved per turn, so a
  // file replaced since the last turn is the one bound now (claude.mjs).
  for (const bind of spec.binds ?? []) {
    if (!await exists(bind.source)) continue
    args.push(bind.writable ? '--bind' : '--ro-bind', await canonical(bind.source), bind.target)
  }
  args.push('--chdir', await canonical(spec.cwd))
  return args
}

/** Wrap a command in the fence: `setpriv … -- bwrap <args> -- command …args`. */
export function fencedCommand ({ command, args, fence }) {
  return { command: SETPRIV(), args: ['--ambient-caps', '-all', '--inh-caps', '-all', '--', BWRAP(), ...fence, '--', command, ...args] }
}

/**
 * Prove the fence with the final arguments before the CLI starts: every
 * writable path takes a write, every read-only path refuses one, every canary
 * is absent. A fence that cannot be proved is not used; the caller decides
 * what that means (decision 8: the turn runs as `namespace: 0`, visibly).
 */
export async function proveFence ({ fence, spec, canaries = [], command = null, env = {}, signal = null }) {
  const writable = []
  for (const dir of spec.writable ?? []) writable.push(await canonical(dir))
  const readOnly = []
  for (const dir of spec.readOnly ?? []) {
    if (!await exists(dir)) continue
    const real = await canonical(dir)
    if ((await fs.stat(real)).isDirectory()) readOnly.push(real)
  }
  // Each mount must be a directory the seat cannot write, showing the source's
  // content (a sentinel entry), not the empty mount point beneath it.
  const mounts = []
  for (const mount of spec.mounts ?? []) {
    const names = (await fs.readdir(mount.source).catch(() => [])).sort()
    mounts.push(`${mount.target}|${names[0] ?? ''}`)
  }
  const script = [
    'status=0',
    'for d in $WRITABLE; do f="$d/.devpanel-fence-probe-$$"; if ( : > "$f" ) 2>/dev/null; then rm -f "$f"; else echo "NOT-WRITABLE $d"; status=1; fi; done',
    'for d in $READONLY; do f="$d/.devpanel-fence-probe-$$"; if ( : > "$f" ) 2>/dev/null; then rm -f "$f"; echo "WRITABLE $d"; status=1; fi; done',
    'for c in $CANARIES; do if [ -e "$c" ] || [ -L "$c" ]; then echo "VISIBLE $c"; status=1; fi; done',
    // The CLI itself must be runnable inside, or the turn would fail at launch.
    'if [ -n "$COMMAND" ] && ! [ -x "$COMMAND" ]; then echo "CLI-NOT-VISIBLE $COMMAND"; status=1; fi',
    'if [ -n "$MOUNTS" ] && ! printf "%s\\n" "$MOUNTS" | { fail=0; while IFS="|" read -r t s; do f="$t/.devpanel-fence-probe-$$"; if ! [ -d "$t" ]; then echo "MOUNT-MISSING $t"; fail=1; elif ( : > "$f" ) 2>/dev/null; then rm -f "$f"; echo "MOUNT-WRITABLE $t"; fail=1; elif [ -n "$s" ] && ! [ -e "$t/$s" ] && ! [ -L "$t/$s" ]; then echo "MOUNT-NOT-BOUND $t"; fail=1; fi; done; exit $fail; }; then status=1; fi',
    'if [ -n "$TOOLING" ] && ! [ -x "$TOOLING/offline" ]; then echo "TOOLING-NOT-VISIBLE $TOOLING"; status=1; fi',
    'exit $status'
  ].join(NL)
  const wrapped = fencedCommand({ command: '/bin/sh', args: ['-c', script], fence })
  const probeEnv = { PATH: '/usr/bin:/bin', WRITABLE: writable.join(' '), READONLY: readOnly.join(' '), CANARIES: canaries.join(' '), COMMAND: command ?? '', MOUNTS: mounts.join(NL), TOOLING: spec.toolingBin ? TOOLING_BIN : '', ...env }
  let result
  try {
    result = await runProcess({ command: wrapped.command, args: wrapped.args, env: probeEnv, signal, stdin: '', maxBuffer: 1024 * 1024 })
  } catch (error) {
    return { proved: false, reason: `the fence could not be started: ${error.message}` }
  }
  if (result.cancelled) return { proved: false, reason: 'the fence probe was cancelled' }
  if (result.code !== 0) {
    const findings = result.stdout.split(NL).filter(Boolean)
    return { proved: false, reason: (findings.length ? findings.slice(0, 5).join('; ') : result.stderr.trim().slice(0, 400)) || `probe exited ${result.code}` }
  }
  return { proved: true, reason: null, checked: { writable: writable.length, readOnly: readOnly.length, canaries: canaries.length, ...(mounts.length ? { mounts: mounts.length } : {}) } }
}

/**
 * Paths that must be invisible in every fence, whatever the turn grants: the
 * operator's keys, the panel's token and supervisor state, every CLI home not
 * bound for this turn, and each entry of the projects root (project-path.mjs
 * projectsRoot) and each discovered project outside the granted paths (other
 * projects, container mounts).
 */
export async function defaultCanaries ({ home = os.homedir(), granted = [], projectsDir = projectsRoot(), panelRoot = null, keep = [] } = {}) {
  const grantedReal = []
  for (const g of granted) grantedReal.push(await canonical(g).catch(() => path.resolve(g)))
  const keepReal = []
  for (const k of keep) keepReal.push(await canonical(k).catch(() => path.resolve(k)))
  const covered = (p) => [...grantedReal, ...keepReal].some((g) => g === p || g.startsWith(p + '/') || p.startsWith(g + '/'))
  const out = []
  for (const p of [path.join(home, '.ssh'), path.join(home, '.claude'), path.join(home, '.claude.json'), path.join(home, '.codex'), path.join(home, '.gemini'), path.join(home, '.config'), path.join(home, '.config', 'deepseek'), path.join(home, '.config', 'devpanel', 'auth')]) {
    if (!await exists(p)) continue
    const real = await canonical(p).catch(() => p)
    if (!covered(real)) out.push(p)
  }
  const inGrant = (p) => [...grantedReal, ...keepReal].some((g) => g === p || p.startsWith(g + '/'))
  // A protected path that CONTAINS a granted one (the supervisor's own
  // workspace inside issues/.supervisor) is necessarily visible as a mount
  // point; what must stay invisible is everything in it except the grant.
  const protect = async (p) => {
    if (!await exists(p)) return
    const real = await canonical(p).catch(() => path.resolve(p))
    if (inGrant(real)) return
    if (!covered(real)) { if (!out.includes(p)) out.push(p); return }
    let names = []
    try { names = await fs.readdir(p) } catch { /* not a directory */ }
    for (const name of names) await protect(path.join(p, name))
  }
  if (panelRoot) {
    const issues = issuesRoot()
    // The host's data root (host settings dataRoot) holds what the panel's
    // checkout holds by default: its configuration, token, logs, certificate,
    // Git stores and every other run. Everything in it but this turn's grants.
    const dataRoot = hostSettings().dataRoot
    for (const p of [path.join(panelRoot, '.devpanel-token'), tokenFile(), path.join(issues, '.supervisor'), ...(dataRoot ? [dataRoot] : [])]) await protect(p)
    // Other projects' issues and runs live beside this run's own directories,
    // under the issue root (the panel's issues/ unless the host moved it).
    for (const dir of [panelRoot, issues]) {
      let names = []
      try { names = await fs.readdir(dir) } catch { /* none */ }
      for (const name of names) {
        const p = path.join(dir, name)
        const real = await canonical(p).catch(() => null)
        if (real && !covered(real) && !out.includes(p)) out.push(p)
      }
    }
  }
  let entries = []
  try { entries = await fs.readdir(projectsDir, { withFileTypes: true }) } catch { /* none */ }
  for (const entry of entries) {
    const p = path.join(projectsDir, entry.name)
    const real = await canonical(p).catch(() => null)
    if (!real || covered(real)) continue
    out.push(p)
  }
  // Discovered projects sit below a root entry that may hold this run's own
  // project too, and so is covered: each of them is a canary of its own.
  for (const p of discoveredProjects(projectsDir)?.values() ?? []) {
    const real = await canonical(p).catch(() => null)
    if (real && !covered(real) && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * A turn that asked for a fence and did not get one is refused: the run's
 * policy says namespace: 1, and an unproved namespace is namespace 0 with the
 * seat's full host view (implementation audit I5). Decision 8's unfenced mode
 * is an operator switch, `DEVPANEL_FENCE_UNPROVED=run`, never a fallback the
 * adapter takes on its own; the turn then records `namespace: 0` and why.
 */
export function assertFenced (fenced, { turn = 'this turn', mounts = [], platform = hostPlatform() } = {}) {
  if (!fenced || fenced.applied) return
  // A declared tooling mount is bound only by the fence: unfenced, its target
  // would be an empty directory the prompt calls read-only (P3-1).
  if (mounts.length) {
    const m = mounts[0]
    throw new ProcessError(`tooling mount ${m.target} (from ${m.source}) cannot be bound read-only in ${turn}: the fence could not be proved (${fenced.reason}); only a proved seat fence binds a declared mount, so the turn is refused`,
      { kind: 'environment-error', started: false })
  }
  // Without bubblewrap there is no fence to fall back from: only the install's
  // opt-in (DEVPANEL_UNFENCED=acknowledged) runs a seat unfenced there.
  const bubblewrap = platform.bubblewrap
  if (bubblewrap && process.env.DEVPANEL_FENCE_UNPROVED === 'run') return
  throw new ProcessError(`${turn} runs only inside a proved seat fence, and the fence could not be proved: ${fenced.reason} (${bubblewrap ? 'DEVPANEL_FENCE_UNPROVED=run lets it run unfenced, recorded as namespace 0' : 'on this host only the install\'s opt-in, DEVPANEL_UNFENCED=acknowledged, runs it unfenced'})`,
    { kind: 'environment-error', started: false })
}

/** The CLI logins and keys under the home that no host grant may reach. */
const PRIVATE_HOME = ['.ssh', '.claude', '.claude.json', '.codex', '.gemini', '.config']

/**
 * The host settings' fence.readOnly (a toolchain under the home, `~/.nvm`),
 * resolved. Throws on the home itself, a directory containing it, or one that
 * reaches a private entry of it: such a grant would undo the fence.
 */
export async function hostReadOnly ({ home = os.homedir(), dirs = hostSettings().fence.readOnly } = {}) {
  const realHome = await canonical(home).catch(() => path.resolve(home))
  const out = []
  for (const dir of dirs) {
    if (!await exists(dir)) continue
    const real = await canonical(dir)
    if (real === realHome || realHome.startsWith(real + '/')) throw new Error(`fence.readOnly: ${dir} is or contains the home`)
    const hit = PRIVATE_HOME.map((n) => path.join(realHome, n)).find((p) => real === p || real.startsWith(p + '/') || p.startsWith(real + '/'))
    if (hit) throw new Error(`fence.readOnly: ${dir} reaches ${hit}, which no seat may read`)
    out.push(real)
  }
  return out
}

/**
 * Build, prove and return the wrapper for one invocation. The engine supplies
 * the run's paths (`spec`); the adapter supplies what its CLI needs
 * (`manifest`: home binds and its own temp directories). Never throws: a fence
 * that cannot be built or proved comes back `applied: false` with the reason,
 * and the caller runs the turn unfenced and says so (decision 8).
 */
export async function applyFence ({ spec, manifest = {}, command = null, signal = null, platform = hostPlatform() }) {
  if (!spec) return { applied: false, reason: 'no fence requested for this turn', wrap: null }
  if (!platform.bubblewrap) return { applied: false, reason: `${platform.id === 'darwin' ? 'macOS (darwin)' : platform.id} has no seat fence (bubblewrap is Linux-only)`, wrap: null }
  try {
    const full = {
      cwd: spec.cwd,
      home: manifest.home ?? os.homedir(),
      homeBinds: manifest.homeBinds ?? [],
      writable: [...(spec.writable ?? []), ...(manifest.writable ?? [])],
      readOnly: [...(spec.readOnly ?? []), ...(manifest.readOnly ?? []), ...await hostReadOnly()],
      entries: [...(spec.entries ?? []), ...(manifest.entries ?? [])],
      binds: manifest.binds ?? [],
      mounts: spec.mounts ?? [],
      toolingBin: spec.toolingBin ?? null
    }
    const fence = await fenceArgs(full)
    const granted = [...full.writable, ...full.readOnly, ...full.homeBinds.map((b) => b.path), ...full.entries, full.cwd]
    const canaries = [...await defaultCanaries({ home: full.home, granted, projectsDir: projectsRoot(), panelRoot: spec.panelRoot ?? null }), ...(spec.canaries ?? [])]
    const proof = await proveFence({ fence, spec: full, canaries, command, signal })
    if (!proof.proved) return { applied: false, reason: `the fence could not be proved: ${proof.reason}`, wrap: null }
    return {
      applied: true, reason: null, proof: proof.checked,
      mounts: { writable: full.writable.length, readOnly: full.readOnly.length, home: full.homeBinds.map((b) => `${b.writable ? 'rw' : 'ro'}:${b.path}`),
        ...(full.mounts.length ? { tooling: full.mounts.map((m) => ({ target: m.target, source: m.source })) } : {}) },
      wrap: (command, args) => fencedCommand({ command, args, fence })
    }
  } catch (error) {
    return { applied: false, reason: `the fence could not be built: ${error.message}`, wrap: null }
  }
}
