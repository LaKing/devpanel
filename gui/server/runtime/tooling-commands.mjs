import path from 'node:path'

/*
 * The project's declared tooling commands (`workspace.tooling.commands`), in
 * the one form a seat is given them: run from their directory, through the
 * offline wrapper the fence binds at /run/devpanel/tooling (harness/tooling/
 * offline), so a declared command never has network. The wrapper takes the
 * program directly; it adds bubblewrap's own `--` (auditor-1-004). Prompts and
 * tests both use renderToolingCommand, so they cannot drift apart.
 *
 * A turn without the fence (macOS under its opt-in, or Linux with
 * DEVPANEL_FENCE=off; confinement-policy.mjs) has neither the wrapper nor the
 * mounts: its commands are rendered as they run, labelled unconfined, and its
 * mounts as not bound. On macOS without the opt-in they are refused.
 */

export const OFFLINE = '/run/devpanel/tooling/offline'
export const ISOLATION_UNAVAILABLE = 'devpanel-offline: network isolation could not start in this seat'
/** The wrapper ran the command under the runtime's own, proved network denial (Codex's sandbox), not a namespace of its own. */
export const ISOLATION_INHERITED = 'devpanel-offline: isolation inherited'

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`

/** The exact command line a seat runs for one declared command. */
export function renderToolingCommand (command, worktree, { offline = true } = {}) {
  const dir = command.cwd ? path.join(worktree, command.cwd) : worktree
  return `cd ${quote(dir)} && ${offline ? `${OFFLINE} ` : ''}sh -c ${quote(command.run)}`
}

const heading = (auto) => auto
  ? 'Project tooling (found in the project checkout: host settings tooling.nodeModules).'
  : 'Project tooling (projects/<id>.yaml workspace.tooling).'

const NO_SHELL = 'Your runtime has no shell in this turn, so you cannot run these: record each one you would need under not run, saying so.'

/**
 * The prompt text for a run's declared tooling, or null when it declares none.
 * `shell: false` is a seat whose runtime has no shell this turn (gemini).
 * `confinement` is null inside the fence; otherwise `{ mode: 'unconfined' |
 * 'refused', reason }` for a turn the fence does not hold.
 */
export function toolingBrief ({ tooling, worktree, shell = true, confinement = null }) {
  const mounts = tooling?.mounts ?? []
  const commands = tooling?.commands ?? []
  if (!mounts.length && !commands.length) return null
  if (confinement) return unfencedBrief({ mounts, commands, worktree, shell, confinement, auto: tooling.auto })
  const lines = [heading(tooling.auto)]
  if (mounts.length) lines.push(`Mounted read-only in the worktree: ${mounts.map((m) => `${m.target} (from ${m.source}${m.provisional ? ', provisional' : ''}${m.masks?.length ? `; ${m.masks.join(', ')} inside it empty and writable` : ''})`).join('; ')}. Never install anything: these are read-only, and the commands below have no network.`)
  if (commands.length) {
    lines.push('Declared commands, each to be run exactly in the form shown (fill in <placeholders>):')
    for (const c of commands) lines.push(`- ${c.id}${c.provisional ? ' (provisional)' : ''}${c.description ? `: ${c.description}` : ''}${'\n'}  ${renderToolingCommand(c, worktree)}`)
    lines.push(shell
      ? `A listed command is not "could not run" unless you quote the command line you ran and its output. Exit 125 with "${ISOLATION_UNAVAILABLE}" means isolation is unavailable here and the command was NOT run: record it as not run, quoting the command line and that output, and do not run it any other way (not without the wrapper, not with network). "${ISOLATION_INHERITED}" means the command ran under your runtime's own proved network denial, which refuses loopback too: a failure to listen on or reach 127.0.0.1 is that, not a defect of the candidate.`
      : NO_SHELL)
  }
  return lines.join('\n')
}

/** The same declarations for a turn without the fence: nothing is called mounted, isolated or offline. */
function unfencedBrief ({ mounts, commands, worktree, shell, confinement, auto }) {
  const lines = [heading(auto)]
  if (mounts.length) lines.push(`Declared mounts NOT bound in this turn (${confinement.reason}): ${mounts.map((m) => `${m.target} (from ${m.source})`).join('; ')}. Nothing is mounted at these paths for you; never install anything there.`)
  if (!commands.length) return lines.join('\n')
  if (confinement.mode === 'refused') {
    lines.push(`Declared commands REFUSED in this turn, not to be run (${confinement.reason}): ${commands.map((c) => c.id).join(', ')}. Record each one you would need under not run, quoting this reason.`)
    return lines.join('\n')
  }
  lines.push(`Declared commands, each to be run exactly in the form shown (fill in <placeholders>). They run UNCONFINED: this seat has no fence (${confinement.reason}), so nothing but your runtime's own sandbox stands between them and the network or this host:`)
  for (const c of commands) lines.push(`- ${c.id}${c.provisional ? ' (provisional)' : ''}${c.description ? `: ${c.description}` : ''} [unconfined]${'\n'}  ${renderToolingCommand(c, worktree, { offline: false })}`)
  lines.push(shell ? 'A listed command is not "could not run" unless you quote the command line you ran and its output.' : NO_SHELL)
  return lines.join('\n')
}
