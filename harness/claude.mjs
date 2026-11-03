import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCommand } from '../gui/server/runtime/command.mjs'
import { runProcess, ProcessError } from '../gui/server/runtime/process.mjs'
import { NL, installationProbe, probeModels, createLedger, lineObserver, assertScratchOutsideWorktree, cancelledError, runtimeError, versionAtLeast, cumulativeDelta, childEnvironment, withReap } from './shared.mjs'
import { hostPlatform } from '../gui/server/runtime/platform.mjs'
import { applyFence, assertFenced } from './fence.mjs'

/**
 * Since 2.1.277 a headless resume keeps the session's cost total ("headless
 * sessions now save their totals at exit"), so `total_cost_usd` on a resumed
 * session is the SESSION's running total, not this invocation's. Earlier CLIs
 * started at zero on every resume, i.e. reported this invocation's cost. The
 * token counts in `usage` stayed per invocation either way (observed: the
 * cache-read count of a turn equals the previous turn's context, not a sum).
 */
export const CUMULATIVE_COST_SINCE = '2.1.277'

/*
 * Claude Code adapter.
 *
 * Sessions are PRE-ASSIGNED: `--session-id <uuid>` lets the engine choose the id
 * before the turn starts, so a crash mid-invocation is always reconcilable by id.
 *
 * The `glm` and `deepseek` profiles use this adapter with endpoint and credential
 * substituted from the roster's references — not a separate runtime.
 */

export const id = 'claude'

export const capabilities = {
  sessionAssignment: 'preassign',
  resume: true,
  effort: true,
  structuredOutput: false,   // no schema constraint on the CLI; fenced JSON + repair
  cancellation: true,
  instructions: true
}

const COMMAND = () => resolveCommand('claude', process.env.DEVPANEL_CLAUDE_BIN)

/*
 * A hygiene worker's built-in tools, named rather than inherited: file work,
 * the shell, web access (decision 5) and subagents. Left out: scheduling,
 * remote triggers, workflows, notifications, messaging and worktree switching,
 * which act outside the turn or outside the run. Names as the runtime reports
 * them in its init record (2.1.283).
 */
export const WORKER_TOOLS = Object.freeze(['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'TaskStop', 'ToolSearch'])
export const WORKER_ALLOW = Object.freeze(['Read', 'WebFetch', 'WebSearch', 'Task', 'TaskStop', 'ToolSearch'])
// The broker's two tools, allowed when the turn carries a broker (Phase 3).
export const BROKER_TOOLS = Object.freeze(['mcp__devpanel__inspect_environment', 'mcp__devpanel__db_query'])
/** The one MCP server a worker seat may have: the devpanel broker, when attached. */
export const brokerServers = (broker) => broker
  ? { devpanel: { command: broker.node, args: [broker.shim], env: { DEVPANEL_BROKER_SOCKET: broker.socket, DEVPANEL_BROKER_TOKEN: broker.token } } }
  : {}
/** A read-only coordinator turn (Phase 1): reading and a sandboxed, offline shell. */
export const READ_TOOLS = Object.freeze(['Read', 'Bash', 'ToolSearch'])
export const READ_ALLOW = Object.freeze(['Read', 'ToolSearch'])

/**
 * What the Claude CLI needs inside the seat fence: its installed binary (the
 * launcher link and the versions directory it points into, read-only), the
 * connection's config directory (read-write: its login and sessions; the
 * default connection also keeps `~/.claude.json`, which the CLI rewrites in
 * place when a rename onto a bind mount is refused), git's identity, and the
 * adapter's runtime temp directory for the sandbox bridge.
 */
export async function fenceManifest ({ binary, env, runtimeTemp = null, runHome = null }) {
  const home = os.homedir()
  const real = await fs.realpath(binary)
  const homeBinds = [{ path: path.dirname(real), writable: false }, { path: binary, writable: false }]
  const binds = []
  const source = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude')
  if (runHome) {
    // A per-run home (Phase 0a): the seat's sessions live in the run, and the
    // connection's credential file is bound in; nothing else of the shared
    // config directory (other runs' and the operator's transcripts) is visible.
    //
    // The bind holds the file's inode at launch. Another process's refresh
    // replaces the file (write, then rename), so the seat keeps reading its
    // old copy for the rest of the turn; the directory is not bound instead
    // because it holds those transcripts. A turn that fails on the rotated
    // token is retried once (failure.mjs, credentialChange below), and the
    // retry's fence binds the current file. The seat's own refresh IS written
    // back: a rename onto the mount is refused (EBUSY), so the CLI rewrites
    // the bound inode in place, which is the shared file unless another
    // process replaced it during the turn. Then the write lands in the
    // replaced, unlinked inode and is lost rather than clobbering the newer
    // token. Two writers cannot clobber each other as long as every other
    // writer replaces the file atomically and re-reads it before refreshing.
    binds.push({ source: path.join(source, '.credentials.json'), target: path.join(runHome, '.credentials.json'), writable: true })
  } else if (env.CLAUDE_CONFIG_DIR) homeBinds.push({ path: env.CLAUDE_CONFIG_DIR, writable: true })
  else homeBinds.push({ path: path.join(home, '.claude'), writable: true }, { path: path.join(home, '.claude.json'), writable: true })
  homeBinds.push({ path: path.join(home, '.gitconfig'), writable: false })
  return { home, homeBinds, binds, writable: [...(runtimeTemp ? [runtimeTemp] : []), ...(runHome ? [runHome] : [])] }
}

/** The credential file's identity: inode, size, mtime and a content hash, or null when absent. */
export async function credentialState (file) {
  try {
    const [stat, bytes] = await Promise.all([fs.stat(file), fs.readFile(file)])
    return { ino: stat.ino, size: stat.size, mtime: stat.mtime.toISOString(), hash: crypto.createHash('sha256').update(bytes).digest('hex') }
  } catch {
    return null
  }
}

/**
 * Whether, and how, the credential file changed between two states: `replaced`
 * (another inode at the path), `rewritten` (same inode, other bytes), `created`
 * or `removed`. The hash decides but is never recorded.
 */
export function credentialChange (file, before, after) {
  const how = !before && !after ? null
    : !before ? 'created'
      : !after ? 'removed'
        : before.ino !== after.ino ? 'replaced'
          : before.hash !== after.hash ? 'rewritten' : null
  const shown = (s) => s && { ino: s.ino, size: s.size, mtime: s.mtime }
  return { file, changed: how !== null, how, atStart: shown(before), atFailure: shown(after) }
}
const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Turn a connection into the environment a process will actually run with.
 *
 * Shared by probe() and invoke() on purpose: a probe that echoes a profile but
 * launches with the default provider proves nothing about that profile, and a
 * default-provider success would be reported under a GLM label.
 */
export function resolveConnection ({ profile = 'default', endpointRef = null, credentialRef = null, account = null, hygiene = false } = {}) {
  // Under hygiene the child starts from an allow-list, not the panel's whole
  // environment (see childEnvironment in shared.mjs).
  const env = hygiene ? childEnvironment('claude') : { ...process.env }
  const applied = { profile, endpointRef, credentialRef, account, endpoint: false, credential: false }

  /*
   * A second person's login, not a second provider.
   *
   * Several people collaborate through one panel, each with their own
   * subscription. That is not an endpoint-and-token connection — there is
   * nothing to substitute, because the auth lives in a logged-in config
   * directory. So an `account` names a directory of its own and changes nothing
   * else: same provider, same models, a different person's session.
   *
   * Everything inheritable is cleared first. A config directory that has not been
   * logged in must fail as unauthenticated, not quietly succeed by picking up the
   * ambient account and reporting its work under someone else's name.
   */
  if (account) {
    if (endpointRef || credentialRef) {
      return { env, applied, error: `connection names both an account ("${account}") and an endpoint/credential: it is either another person's login or another provider, never both` }
    }
    delete env.ANTHROPIC_BASE_URL
    delete env.ANTHROPIC_AUTH_TOKEN
    delete env.CLAUDE_CODE_OAUTH_TOKEN
    env.ANTHROPIC_API_KEY = ''
    env.CLAUDE_CONFIG_DIR = accountDir(account)
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    return { env, applied, error: null }
  }

  if (profile === 'default') return { env, applied, error: null }

  let endpoint, credential
  try {
    endpoint = deref(endpointRef)
    credential = deref(credentialRef)
  } catch {
    return { env, applied, error: `profile "${profile}" has an unreadable or unsupported endpoint/credential reference` }
  }

  // An unresolvable reference must NOT fall through to the default provider.
  const missing = []
  if (!endpoint) missing.push(endpointRef ?? 'endpointRef')
  if (!credential) missing.push(credentialRef ?? 'credentialRef')
  if (missing.length) {
    return { env, applied, error: `profile "${profile}" cannot be resolved: ${missing.join(', ')} not set` }
  }

  if (endpoint) { env.ANTHROPIC_BASE_URL = endpoint; applied.endpoint = true }
  if (credential) { env.ANTHROPIC_AUTH_TOKEN = credential; applied.credential = true }
  // Provider credentials and sessions must not mix with the default Claude
  // account or workflows' own profile directories.
  env.ANTHROPIC_API_KEY = ''
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  const namespace = crypto.createHash('sha256').update(`${profile}\n${endpoint}`).digest('hex').slice(0, 16)
  env.CLAUDE_CONFIG_DIR = path.join(process.env.DEVPANEL_CLAUDE_PROFILE_ROOT ?? path.join(os.homedir(), '.config/devpanel/claude-profiles'), namespace)
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  if (profile === 'glm') env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.GLM_CONTEXT_WINDOW ?? '1000000'
  if (profile === 'deepseek') env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.DEEPSEEK_CONTEXT_WINDOW ?? '1000000'
  return { env, applied, error: null }
}

/**
 * Where one account's login lives. Named by the account, not hashed, because a
 * person has to run `claude login` against this directory by hand and needs to
 * be able to type it.
 */
export function accountDir (account) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(account)) throw new Error(`account "${account}" must be lowercase letters, digits and hyphens`)
  return path.join(process.env.DEVPANEL_CLAUDE_PROFILE_ROOT ?? path.join(os.homedir(), '.config/devpanel/claude-profiles'), `account-${account}`)
}

/** Resolve a roster reference. Only references are stored; values live here. */
function deref (ref) {
  if (!ref) return null
  const [kind, ...rest] = ref.split(':')
  const name = rest.join(':')
  if (kind === 'env') return process.env[name] ?? null
  if (kind === 'file') {
    const file = name.startsWith('~/') ? path.join(os.homedir(), name.slice(2)) : path.resolve(CONFIG_ROOT, name)
    return readFileSync(file, 'utf8').trim()
  }
  if (kind === 'agent') return null
  throw new Error('unsupported reference type')
}

export async function probe ({ depth = 'installation', models = [], profile = 'default', endpointRef = null, credentialRef = null, account = null, signal = null, timeoutMs = 120000, hygiene = false } = {}) {
  const result = await installationProbe(COMMAND(), { id, depth, models, profile, endpointRef, credentialRef, account, capabilities })
  if (result.installation.status !== 'installed' || depth === 'installation') return result

  // Resolve the connection FIRST. Probing with an unresolvable profile would
  // exercise the default provider and report the result under this profile.
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) {
    result.usage = { tokens: 0, costUsd: 0, costUnknownCalls: 0 }
    result.invocations = 0
    result.authentication = { status: 'error', detail: connection.error }
    for (const model of models) result.modelAccess[model] = { status: 'unknown', detail: connection.error }
    return result
  }
  result.connection = { ...result.connection, applied: connection.applied }

  // Claude's USD estimate is real only for the default account.
  // A named account is a real Claude subscription, so its cost estimate is as
  // real as the ambient one's.
  // A probe vouches for the connection a turn will use, so it runs with the same
  // environment policy as that turn.
  const probeInvoke = hygiene ? (options) => invoke({ ...options, hygiene }) : invoke
  return probeModels(result, { invoke: probeInvoke, models, profile, endpointRef, credentialRef, account, signal, timeoutMs, costKnown: profile === 'default' })
}

const { record, reconcile } = createLedger('claude-ledger.jsonl')
export { reconcile }

/**
 * One turn. An error raised after the runtime ran carries its descendant scan
 * (shared.mjs withReap), so the engine never retries on unproved cleanup.
 */
export async function invoke (options) {
  const ran = {}
  try { return await invokeOnce(options, ran) } catch (error) { throw withReap(error, ran.run) }
}

async function invokeOnce ({
  // The devpanel broker for this turn (Phase 3): { socket, token, shim, node }.
  broker = null,
  session,
  model,
  effort,
  cwd,
  instructions,
  prompt,
  marker,
  signal,
  meta = {},
  ledgerDir = null,
  profile = 'default',
  endpointRef = null,
  credentialRef = null,
  account = null,
  graceMs = 5000,
  supervisorOnly = false,
  scratchDir = null,
  observe = null,
  maxBuffer = undefined,
  tooling = null,
  hygiene = false,
  // The run's paths for the seat fence (fence.namespace: 1, harness/fence.mjs);
  // null runs the turn as before.
  fence = null,
  // Where this seat's per-run CLI home goes (runs/<id>/cli-homes/<seat>), used
  // only inside a proved fence; null keeps the connection's shared home.
  cliHome = null,
  // A coordinator turn that may read (Phase 1): read tools inside a proved
  // fence, tool-free otherwise. Passed together with supervisorOnly.
  readOnlyTools = false,
  // Continue a COPY of `session` (--fork-session under a new pre-assigned id):
  // the side conversation with a run's coordinator, which must never add a
  // turn to the session the run resumes.
  fork = false
} = {}, ran = {}) {
  const invocationId = meta.invocationId ?? crypto.randomUUID()
  if (fork && !session?.id) throw new ProcessError('a fork needs the session it copies', { kind: 'configuration-error', started: false, invocationId })

  // Pre-assign on the first turn; resume by the same id afterwards. A fork
  // gets an id of its own.
  const sessionId = !fork && session?.id ? session.id : crypto.randomUUID()

  // The seat fence is decided before the CLI's own settings are built: inside a
  // proved fence the live checkout is not mounted at all, so its Read denial is
  // both redundant and harmful (the CLI's sandbox would try to mount over a
  // path that does not exist there). The connection is resolved here for the
  // manifest; it is resolved again below exactly as before.
  const runtimeTemp = scratchDir && hostPlatform().runtimeTempPrefix
    ? await fs.mkdtemp(hostPlatform().runtimeTempPrefix) : null
  let fenced = null
  // The per-run home is chosen when a session starts and recorded on its
  // descriptor; a session begun in the shared home stays there.
  let runHome = null
  if (fence && cliHome) runHome = session?.id ? (session.home ?? null) : cliHome
  if (fence) {
    const early = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
    if (runHome && !early.error) {
      await fs.mkdir(runHome, { recursive: true })
      const placeholder = path.join(runHome, '.credentials.json')
      if (!await fs.lstat(placeholder).then(() => true, () => false)) await fs.writeFile(placeholder, '', { mode: 0o600 })
    }
    fenced = early.error ? { applied: false, reason: early.error } : await applyFence({ spec: { ...fence, cwd }, manifest: await fenceManifest({ binary: COMMAND(), env: early.env, runtimeTemp, runHome }), command: COMMAND(), signal })
    if (!fenced.applied && !session?.home) assertFenced(fenced, { turn: 'a fenced Claude turn', mounts: fence.mounts ?? [] })
    if (!fenced.applied && runHome) {
      if (session?.home) {
        if (runtimeTemp) await fs.rm(runtimeTemp, { recursive: true, force: true })
        throw new ProcessError(`this session lives in its per-run home (${session.home}), which is usable only inside the seat fence, and the fence could not be proved: ${fenced.reason}`, { kind: 'environment-error', started: false, invocationId })
      }
      runHome = null
    }
  }
  // A read-only coordinator turn (Phase 1, step `access: read`) gets its read
  // tools only inside a proved fence; otherwise it stays tool-free, exactly as
  // before, so nothing is exposed that was not.
  const readSeat = readOnlyTools && fenced?.applied === true
  if (readSeat) supervisorOnly = false
  // stream-json rather than json: the same final `result` record arrives as the
  // last line, and every assistant message and tool call before it is visible as
  // it happens. That stream is the only honest source of "is it doing anything"
  // during a seventeen-minute turn.
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  // Hygiene (fence.hygiene: 1): a worker seat no longer inherits the operator's
  // user settings (their permission mode, allow rules such as `git push`,
  // plugins) or their claude.ai connectors. Project settings still load, so the
  // repository's CLAUDE.md keeps orienting the seat. The permission mode is then
  // stated rather than inherited, for every profile.
  const workerHygiene = hygiene && !supervisorOnly
  if ((profile !== 'default' || workerHygiene) && !supervisorOnly) args.push('--permission-mode', readSeat ? 'default' : 'acceptEdits')
  if (workerHygiene) {
    args.push('--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: brokerServers(broker) }),
      '--tools', (readSeat ? READ_TOOLS : WORKER_TOOLS).join(','))
  }
  if (supervisorOnly) args.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands')
  if (fork) args.push('--resume', session.id, '--fork-session', '--session-id', sessionId)
  else if (session?.id) args.push('--resume', session.id)
  else args.push('--session-id', sessionId)
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (instructions) args.push('--append-system-prompt', instructions)

  // Bubblewrap mount targets must be canonical directories. File-tool rules
  // match spelling instead, so deny both the configured alias and its target.
  // Read is the exception: the runtime folds Read(...) denials into read-deny
  // mounts and mounts a directory spelling verbatim, so a symlink spelling there
  // breaks bubblewrap ("Can't mount on symlink destination"). The runtime resolves
  // tool paths before matching, so the canonical Read denial still covers the alias.
  const enforcement = { readEdit: null, bash: 'not-fenceable', addedRoots: [] }
  let flagSettings = null
  if (tooling) {
    const resolved = new Map()
    const canonical = root => {
      const absolute = path.resolve(root)
      if (!resolved.has(absolute)) resolved.set(absolute, fs.realpath(absolute).catch(error => {
        throw new ProcessError(`Cannot resolve sandbox path ${absolute}: ${error.message}`, {
          kind: 'configuration-error', started: false, invocationId
        })
      }))
      return resolved.get(absolute)
    }
    const canonicalRoots = async roots => [...new Set(await Promise.all(roots.map(canonical)))]
    const deny = []
    const denyTools = async (roots, tools) => {
      const spellings = await Promise.all(roots.map(async root => [path.resolve(root), await canonical(root)]))
      for (const [spelled, real] of spellings) {
        for (const root of new Set([spelled, real])) {
          deny.push(...tools.filter(tool => tool !== 'Read' || root === real).map(tool => `${tool}(/${root}/**)`))
        }
      }
    }
    for (const root of tooling.allowedRoots ?? []) { args.push('--add-dir', root); enforcement.addedRoots.push(root) }
    if (!tooling.allowLiveCheckout && tooling.liveCheckout && !fenced?.applied) {
      await denyTools([tooling.liveCheckout, ...(tooling.liveCheckoutAliases ?? [])], ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])
      enforcement.readEdit = { denied: tooling.liveCheckout }
    }
    const scratchRoot = scratchDir ? await canonical(scratchDir) : null
    const addedRoots = await Promise.all((tooling.allowedRoots ?? []).map(async root => ({ root, real: await canonical(root) })))
    const readOnlyRoots = addedRoots.filter(entry => entry.real !== scratchRoot).map(entry => entry.root)
    const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
    await denyTools(readOnlyRoots, editTools)
    // Tooling mounts (workspace.tooling.mounts) sit inside the worktree and are
    // read-only there: the mount refuses a write, these rules say why.
    const mountTargets = tooling.mountTargets ?? []
    // A masked mount (tooling.nodeModules) links its caches to empty writable
    // directories outside the worktree (harness/fence.mjs maskedMountArgs). The
    // CLI's sandbox mounts read-only, last, whatever it does not let the seat
    // write, including every path an Edit-tool denial names: it allows each cache
    // directory, and a masked mount is named neither in its denyWrite nor in an
    // edit denial (the fence's read-only binds of the packages, proved before
    // launch, refuse those writes). The caches exist only inside the fence, so
    // they are passed as spelled, never resolved on the host.
    const mountMasks = tooling.mountMasks ?? []
    const masked = tooling.maskedMountTargets ?? []
    const sandboxDenied = mountTargets.filter((target) => !masked.includes(target))
    await denyTools(sandboxDenied, editTools)
    // Hygiene replaces the operator's inherited `auto` mode: what it used to let
    // through without a per-call classifier is allowed explicitly here. Reads and
    // web access keep today's reach (decision 5); denials above still win, and
    // Bash is bounded by the sandbox below.
    const settings = { permissions: { deny, ...(workerHygiene ? { allow: [...(readSeat ? READ_ALLOW : WORKER_ALLOW), ...(broker && !readSeat ? BROKER_TOOLS : [])] } : {}) } }
    if (readOnlyRoots.length && !supervisorOnly) {
      settings.sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
        filesystem: { disabled: false, allowWrite: [cwd, ...(scratchDir ? [scratchDir] : []), ...(tooling.writesCode === true && tooling.gitWorker ? [tooling.gitWorker] : [])], denyWrite: [...readOnlyRoots, ...sandboxDenied] } }
      enforcement.bash = 'sandbox-required'
    }
    if (tooling.writesCode === false && !supervisorOnly) {
      const { sourceRoot, scratchRoot } = await assertScratchOutsideWorktree(cwd, scratchDir)
      scratchDir = scratchRoot
      const protectedRoots = [...new Set([cwd, sourceRoot, ...(tooling.gitDirectories ?? []), ...readOnlyRoots])]
      await denyTools(protectedRoots, editTools)
      settings.sandbox = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
        filesystem: { disabled: false, allowWrite: [scratchDir], denyWrite: protectedRoots } }
      enforcement.source = 'read-only'
      enforcement.bash = 'sandbox-required'
    }
    if (settings.sandbox && workerHygiene) settings.sandbox.autoAllowBashIfSandboxed = true
    // Without a sandbox (no read-only roots and a writing seat) the shell keeps
    // today's reach under an explicit rule instead of the operator's `auto` mode.
    if (!settings.sandbox && workerHygiene) settings.permissions.allow.push('Bash')
    if (settings.sandbox) {
      const filesystem = settings.sandbox.filesystem
      ;[filesystem.allowWrite, filesystem.denyWrite] = await Promise.all([
        canonicalRoots(filesystem.allowWrite), canonicalRoots(filesystem.denyWrite)
      ])
      filesystem.allowWrite.push(...mountMasks)
    }
    settings.permissions.deny = [...new Set(deny)]
    if (deny.length || settings.sandbox || workerHygiene) flagSettings = settings
  }
  // Thinking is requested as summaries: without this the stream carries only
  // signatures, and the panel shows a turn's reasoning as "Thinking…". Flag
  // settings apply under every --setting-sources choice made above.
  args.push('--settings', JSON.stringify({ ...(flagSettings ?? {}), showThinkingSummaries: true }))

  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) {
    throw new ProcessError(connection.error, { kind: 'configuration-error', profile, account, invocationId })
  }
  const env = connection.env
  // The login's shared credential file, as the turn starts: a failed turn
  // reports whether another process replaced it meanwhile (credentialChange).
  const credentialFile = profile === 'default' ? path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '.credentials.json') : null
  if (runHome) env.CLAUDE_CONFIG_DIR = runHome
  if (profile !== 'default' && model) {
    // Prevent internal/subagent calls from silently selecting a Claude alias
    // that a compatible provider might map to a different model.
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) env[key] = model
  }
  if (supervisorOnly) { delete env.DEVPANEL_TOKEN; delete env.DEVPANEL_TOKEN_FILE }
  // Durable artifacts belong in scratch. Linux sandbox bridge sockets need a
  // short path: an issue/run scratch path can exceed AF_UNIX's 108-byte limit.
  if (scratchDir) env.DEVPANEL_SCRATCH_DIR = scratchDir

  await record(ledgerDir, { invocationId, marker, phase: 'started', sessionId, at: new Date().toISOString() })

  const body = marker ? `${prompt}${NL}${NL}[${marker}]` : prompt
  const environmentAbort = new AbortController()
  let sandboxFailure = null
  const events = streamObserver(observe, failure => {
    if (sandboxFailure || signal?.aborted) return
    sandboxFailure = failure
    environmentAbort.abort()
  })
  const invocationSignal = signal ? AbortSignal.any([signal, environmentAbort.signal]) : environmentAbort.signal
  if (runtimeTemp || scratchDir) env.TMPDIR = runtimeTemp ?? scratchDir
  // The CLI must not replace itself from inside a read-only install.
  if (fenced?.applied) env.DISABLE_AUTOUPDATER = '1'
  const credentialsAtStart = credentialFile ? await credentialState(credentialFile) : null
  let run
  try {
    const launch = fenced?.applied ? fenced.wrap(COMMAND(), args) : { command: COMMAND(), args }
    run = await runProcess({ command: launch.command, args: launch.args, cwd, env, stdin: body, signal: invocationSignal, graceMs, maxBuffer, observe: events.hooks, reap: true, reapTag: meta.reapTag ?? null })
    ran.run = run
  } catch (error) {
    if (error.kind === 'spawn-error' && error.started === false) {
      await record(ledgerDir, { invocationId, marker, phase: 'not-started', error: error.message, code: error.code, at: new Date().toISOString() })
    }
    throw error
  } finally {
    if (runtimeTemp) await fs.rm(runtimeTemp, { recursive: true, force: true })
  }

  if (sandboxFailure) {
    await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, classification: 'environment', error: sandboxFailure, at: new Date().toISOString() })
    throw new ProcessError(`Claude Bash sandbox failed: ${sandboxFailure}`, {
      kind: 'environment-error', invocationId, termination: run.termination
    })
  }

  if (run.cancelled) {
    await record(ledgerDir, { invocationId, marker, phase: 'cancelled', sessionId, at: new Date().toISOString() })
    throw cancelledError(run.termination)
  }

  // A failed RUN is not a bad answer. Conflating them sends an author to correct
  // something the agent never said.
  if (run.code !== 0) {
    await record(ledgerDir, { invocationId, marker, phase: 'failed', sessionId, at: new Date().toISOString() })
    // Classified on what the RUNTIME said went wrong — API error messages, a
    // result flagged as an error, stderr — never on the model's own text: an
    // agent working on a rate-limit bug writes "429" in its answer, and taking
    // that for a provider error would hold a healthy model host-wide.
    const result = events.result ?? finalResult(run.stdout)
    throw runtimeError(`claude exited ${run.code}`, { code: run.code, stderr: run.stderr.trim().slice(-2000), stdout: runtimeErrors(run.stdout), payload: result ? runtimeResult(result) : null, invocationId,
      credentials: credentialFile ? credentialChange(credentialFile, credentialsAtStart, await credentialState(credentialFile)) : null })
  }

  // The final record is the last `result` event, captured by the line observer
  // as it streamed — independent of how much of stdout the process buffer kept.
  // The retained buffer is only a fallback, for a runtime that ignored
  // --output-format and printed one JSON document.
  const payload = events.result ?? finalResult(run.stdout)
  if (!payload) {
    throw runtimeError('claude produced no result record', { stdout: run.stdout.slice(0, 500), invocationId })
  }

  if (payload.is_error) {
    throw runtimeError(`claude reported an error: ${payload.subtype ?? 'unknown'}`, { payload, invocationId,
      credentials: credentialFile ? credentialChange(credentialFile, credentialsAtStart, await credentialState(credentialFile)) : null })
  }

  const response = payload.result ?? ''
  // Anthropic semantics: cached input is still input the model read. Each
  // category is kept; `tokens` is the provider's total, not input + output.
  const u = payload.usage ?? {}
  const cliVersion = events.cliVersion ?? session?.cliVersion ?? null
  // Claude's USD estimate uses Anthropic prices, not the provider's bill.
  const reportedCost = profile === 'default' && typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : null
  let costUsd = reportedCost
  let costBasis = reportedCost === null ? 'unknown' : 'reported'
  const costTotals = {}
  if (reportedCost !== null && versionAtLeast(cliVersion, CUMULATIVE_COST_SINCE)) {
    const { delta, totals, basis } = cumulativeDelta(session?.costTotals ?? null, { costUsd: reportedCost })
    costUsd = delta.costUsd
    costBasis = basis
    Object.assign(costTotals, totals)
  }
  const usage = {
    provider: profile === 'default' ? 'anthropic' : profile === 'glm' ? 'zai' : profile,
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheCreationTokens: u.cache_creation_input_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
    costUsd,
    // What the runtime printed and how costUsd was derived from it, so a
    // ledger can be re-read under a different interpretation later.
    costReportedUsd: reportedCost,
    costBasis
  }

  // The descriptor carries the running totals the next invocation subtracts —
  // recorded in the ledger too, so a turn adopted by crash recovery keeps them.
  const descriptor = { id: payload.session_id ?? sessionId, cliVersion, ...(fork ? { forkedFrom: session.id } : {}), costTotals: Object.keys(costTotals).length ? costTotals : (session?.costTotals ?? null),
    ...(runHome ? { home: runHome } : {}) }
  await record(ledgerDir, {
    invocationId, marker, phase: 'completed',
    sessionId: payload.session_id ?? sessionId, session: descriptor, cliVersion, response, usage, at: new Date().toISOString()
  })

  return {
    session: descriptor,
    response,
    usage,
    outcome: 'completed',
    diagnostics: { durationMs: run.durationMs, reap: run.leftovers?.scan ?? null, cliVersion, events: events.count, tooling: tooling ? enforcement : null, hygiene: Boolean(hygiene),
      fence: fence ? { namespace: fenced?.applied ? 1 : 0, reason: fenced?.reason ?? null, proof: fenced?.proof ?? null, mounts: fenced?.mounts ?? null, home: runHome ? 'per-run' : 'shared' } : null,
      ...(readOnlyTools ? { access: readSeat ? 'read' : 'none (fence not proved)' } : {}) }
  }
}

// --- the event stream ---------------------------------------------------------

/** Every JSON line in stdout, in order; non-JSON lines are progress noise. */
function jsonLines (text) {
  const out = []
  for (const line of text.split(NL)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* not an event */ }
  }
  return out
}

/** The last `result` record, or the whole output when it is one JSON document. */
/** The runtime's own error reports in a stream-json transcript, as text. */
export function runtimeErrors (stdout) {
  const found = []
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.includes('error')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.is_api_error_message || event?.type === 'error' || (event?.type === 'result' && event.is_error)) {
      const text = event.message?.content?.map?.((c) => c?.text).filter(Boolean).join(' ') ?? event.result ?? event.message ?? ''
      found.push([event.error, event.subtype, event.api_error_status, typeof text === 'string' ? text : JSON.stringify(text)].filter(Boolean).join(': '))
    }
  }
  return found.slice(-5).join('\n').slice(-2000)
}

/** A result record without the model's answer, unless the runtime marked it an error. */
export function runtimeResult (result) {
  const { result: text, ...rest } = result ?? {}
  return result?.is_error ? { ...rest, result: typeof text === 'string' ? text.slice(0, 1000) : text } : rest
}

function finalResult (stdout) {
  const lines = jsonLines(stdout)
  const result = [...lines].reverse().find((e) => e.type === 'result')
  if (result) return result
  try {
    const whole = JSON.parse(stdout)
    return whole && typeof whole === 'object' && 'result' in whole ? whole : null
  } catch { return null }
}

/**
 * What one stream event says the runtime is doing. Liveness only: a tool call
 * proves the process is working, not that the answer is close.
 */
export function describeEvent (e) {
  if (!e || typeof e !== 'object') return null
  if (e.type === 'system') return { kind: 'system', detail: e.subtype ?? null }
  if (e.type === 'assistant') {
    const content = e.message?.content ?? []
    const tool = content.find((c) => c.type === 'tool_use')
    if (tool) return { kind: 'tool-use', detail: tool.name ?? null }
    if (content.some((c) => c.type === 'text')) return { kind: 'text', detail: null }
    return { kind: 'assistant', detail: null }
  }
  if (e.type === 'user') return { kind: 'tool-result', detail: null }
  if (e.type === 'result') return { kind: 'result', detail: e.subtype ?? null }
  return { kind: e.type ?? 'event', detail: null }
}

/** The shared observer, remembering the last `result` record seen on the stream and the CLI version from `init`. */
function streamObserver (observe, onSandboxFailure = () => {}) {
  let result = null
  let cliVersion = null
  const bashCalls = new Set()
  const observer = lineObserver({ observe, describeEvent, onEvent: e => {
    if (e?.type === 'result') result = e
    if (e?.type === 'system' && e.subtype === 'init' && typeof e.claude_code_version === 'string') cliVersion = e.claude_code_version
    for (const block of e?.message?.content ?? []) {
      if (e.type === 'assistant' && block.type === 'tool_use' && block.name === 'Bash') bashCalls.add(block.id)
      if (e.type !== 'user' || block.type !== 'tool_result' || !bashCalls.delete(block.tool_use_id)) continue
      const text = typeof block.content === 'string' ? block.content : (block.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')
      const failure = /^(?:Exit code [1-9]\d*\s*)?(bwrap:[^\n]*)/i.exec(text.trim())
      if (failure && block.is_error !== false) onSandboxFailure(failure[1].slice(0, 2000))
    }
  } })
  return {
    get count () { return observer.count },
    /** The last `result` record seen on the stream, whatever the buffer retained. */
    get result () { return result },
    /** `claude_code_version` from the init record, when the stream carried one. */
    get cliVersion () { return cliVersion },
    hooks: observer.hooks
  }
}
