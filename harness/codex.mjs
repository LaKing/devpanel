import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveCommand } from '../gui/server/runtime/command.mjs'
import { runProcess, ProcessError } from '../gui/server/runtime/process.mjs'
import { NL, installationProbe, probeModels, createLedger, lineObserver, assertScratchOutsideWorktree, cancelledError, runtimeError, cumulativeDelta, childEnvironment, withReap } from './shared.mjs'
import { applyFence, assertFenced } from './fence.mjs'

/*
 * Codex adapter.
 *
 * Sessions are DISCOVERED: the id exists only once `codex exec` has begun, so it
 * arrives with the first turn's output. That asymmetry with Claude is the reason
 * the contract lets the native session arrive from `invoke()` rather than being
 * created up front, and the reason recovery here leans on the marker rather than
 * on a known id.
 */

export const id = 'codex'

export const capabilities = {
  sessionAssignment: 'discover',
  resume: true,
  effort: true,            // model_reasoning_effort verified on fresh/resumed turns; levels remain model-specific
  structuredOutput: false,
  cancellation: true,
  instructions: true
}

const COMMAND = () => resolveCommand('codex', process.env.DEVPANEL_CODEX_BIN)

/*
 * What a hygiene worker states instead of inheriting config.toml. The sandbox
 * mode itself is set per turn below (workspace-write, scratch-only for readers).
 */
/**
 * What the Codex CLI needs inside the seat fence: its home (read-write: login,
 * sessions), the installed packages it runs from (read-only, also when an
 * account home is used), the launcher link, git's identity, and the directory
 * of this turn's last-message file.
 */
export async function fenceManifest ({ binary, env, lastMessageDir = null }) {
  const home = os.homedir()
  const codexHome = env.CODEX_HOME ?? path.join(home, '.codex')
  const homeBinds = [{ path: codexHome, writable: true }, { path: path.join(home, '.codex', 'packages'), writable: false },
    { path: binary, writable: false }, { path: path.join(home, '.gitconfig'), writable: false }]
  // The shared home is writable for the login and the sessions, but what the
  // OPERATOR's own codex reads as configuration is bound read-only over itself:
  // a seat that could rewrite config.toml (notify program, MCP server commands),
  // the global AGENTS.md, hooks, rules or skills would have its text executed by
  // the operator's next interactive session, outside every fence (implementation
  // audit I3). Workers themselves ignore all of it (--ignore-user-config).
  const entries = [], readOnly = []
  for (const name of CONFIGURATION_FILES) if (await fs.lstat(path.join(codexHome, name)).then((st) => st.isFile(), () => false)) entries.push(path.join(codexHome, name))
  for (const name of CONFIGURATION_DIRS) if (await fs.lstat(path.join(codexHome, name)).then((st) => st.isDirectory(), () => false)) readOnly.push(path.join(codexHome, name))
  return { home, homeBinds, entries, readOnly, writable: lastMessageDir ? [lastMessageDir] : [] }
}

/** What the operator's own Codex executes or obeys from its home; never seat-writable. */
export const CONFIGURATION_FILES = Object.freeze(['config.toml', 'AGENTS.md', 'hooks.json', 'requirements.toml'])
export const CONFIGURATION_DIRS = Object.freeze(['rules', 'skills', 'hooks', 'plugins', 'prompts'])

export const WORKER_SETTINGS = Object.freeze([
  'approval_policy="never"', 'mcp_servers={}', 'features.apps=false', 'features.plugins=false',
  'features.memories=false', 'features.browser_use=false', 'features.computer_use=false'
])

/**
 * Another person's login, the same way the claude adapter does it.
 *
 * The Codex CLI reads `$CODEX_HOME` (default `~/.codex`), so an account is an
 * isolated home that person logs into once. Nothing else about the connection
 * changes: same provider, same models, a different session.
 */
export function resolveConnection ({ profile = 'default', endpointRef = null, credentialRef = null, account = null, hygiene = false } = {}) {
  // Under hygiene the child starts from an allow-list (shared.mjs childEnvironment).
  const env = hygiene ? childEnvironment('codex') : { ...process.env }
  const applied = { profile, endpointRef, credentialRef, account }
  if (!account) return { env, applied, error: null }
  if (endpointRef || credentialRef) {
    return { env, applied, error: `connection names both an account ("${account}") and an endpoint/credential: it is either another person's login or another provider, never both` }
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(account)) return { env, applied, error: `account "${account}" must be lowercase letters, digits and hyphens` }
  // Cleared first: an un-logged-in home must fail as unauthenticated rather than
  // fall through to whoever is logged in ambiently.
  delete env.OPENAI_API_KEY
  env.CODEX_HOME = path.join(process.env.DEVPANEL_CODEX_PROFILE_ROOT ?? path.join(os.homedir(), '.config/devpanel/codex-profiles'), `account-${account}`)
  return { env, applied, error: null }
}

/**
 * What the runtime itself recorded about a session — read off its rollout file,
 * never off the model's answer.
 *
 * The Codex CLI appends one `turn_context` line per turn to
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<stamp>-<session id>.jsonl`, carrying
 * the model and reasoning effort it sent for that turn (observed on codex-cli
 * 0.154.0 and 0.155.1). That is the only CLI-written evidence of an effort
 * having taken effect: the CLI does not validate the value (a nonsense effort
 * is forwarded to the wire as-is), so a recorded effort proves what was SENT,
 * and a completed turn proves the provider accepted it. Both are needed.
 *
 * Read-only, outside the adapter contract; the live checks use it. Returns null
 * when no rollout names the session.
 */
export async function inspectSession ({ session, profile = 'default', endpointRef = null, credentialRef = null, account = null } = {}) {
  const id = session?.id ?? session
  if (!id || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) return null
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account })
  if (connection.error) return null
  const home = connection.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
  const root = path.join(home, 'sessions')
  let file = null
  const walk = async (dir, depth) => {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (file) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) file = full
    }
  }
  await walk(root, 0)
  if (!file) return null

  let text
  try { text = await fs.readFile(file, 'utf8') } catch { return null }
  const record = { file, sessionId: id, cliVersion: null, turns: [] }
  for (const line of text.split(NL)) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'session_meta') record.cliVersion = e.payload?.cli_version ?? record.cliVersion
    if (e.type === 'turn_context') {
      record.turns.push({
        turnId: e.payload?.turn_id ?? null,
        at: e.timestamp ?? null,
        model: e.payload?.model ?? null,
        effort: e.payload?.effort ?? null
      })
    }
  }
  return record
}

export async function probe ({ depth = 'installation', models = [], profile = 'default', endpointRef = null, credentialRef = null, account = null, signal = null, timeoutMs = 120000, hygiene = false } = {}) {
  const result = await installationProbe(COMMAND(), { id, depth, models, profile, endpointRef, credentialRef, account, capabilities })
  if (result.installation.status !== 'installed' || depth === 'installation') return result

  // Resolve FIRST, as the claude adapter does: an unresolvable connection must be
  // one authentication error, not N model failures that each spent a call.
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) {
    result.usage = { tokens: 0, costUsd: 0, costUnknownCalls: 0 }
    result.invocations = 0
    result.authentication = { status: 'error', detail: connection.error }
    for (const model of models) result.modelAccess[model] = { status: 'unknown', detail: connection.error }
    return result
  }
  result.connection = { ...result.connection, applied: connection.applied }

  // codex reports no cost: every paid call counts as unknown.
  const probeInvoke = hygiene ? (options) => invoke({ ...options, hygiene }) : invoke
  return probeModels(result, { invoke: probeInvoke, models, profile, endpointRef, credentialRef, account, signal, timeoutMs, costKnown: false })
}

/**
 * A discovered session cannot be looked up by an id we chose, so attribution runs
 * through the marker the engine embedded in the turn. Anything we cannot tie to
 * this invocation is uncertain — "the most recent session" is not evidence.
 */
const { record, reconcile } = createLedger('codex-ledger.jsonl')
export { reconcile }

/** codex exec --json emits a JSONL event stream; the pieces we need are scattered. */
function parseEvents (stdout) {
  const events = []
  for (const line of stdout.split(NL)) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* non-JSON progress lines */ }
  }

  let sessionId = null
  let text = null
  let usage = null

  for (const e of events) {
    sessionId = e.session_id ?? e.conversation_id ?? e.thread_id ?? sessionId
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') text = e.item.text ?? text
    if (e.usage) usage = e.usage
  }

  return { events, sessionId, text, usage }
}

/** Codex's own input ceiling (observed: `max_chars: 1048576`). */
export const CODEX_MAX_INPUT_CHARS = 1_048_576

/** `error` and `turn.failed` events from `exec --json`, as text. */
export function codexErrors (stdout) {
  const found = []
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.includes('"type"')) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type === 'error') found.push(String(event.message ?? JSON.stringify(event)))
    else if (event?.type === 'turn.failed') found.push(String(event.error?.message ?? JSON.stringify(event.error ?? event)))
  }
  return found.slice(-5).join('\n').slice(-2000)
}

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
  graceMs = 5000,
  supervisorOnly = false,
  scratchDir = null,
  observe = null,
  maxBuffer = undefined,
  tooling = null,
  profile = 'default',
  endpointRef = null,
  credentialRef = null,
  account = null,
  hygiene = false,
  // The run's paths for the seat fence (fence.namespace: 1, harness/fence.mjs).
  fence = null,
  // A coordinator turn that may read (Phase 1): read-only shell inside a proved
  // fence, tool-free otherwise. Passed together with supervisorOnly.
  readOnlyTools = false,
  // Continue a COPY of `session` (`exec fork`): the side conversation with a
  // run's coordinator, which must never add a turn to the session it resumes.
  fork = false
} = {}, ran = {}) {
  const invocationId = meta.invocationId ?? crypto.randomUUID()
  if (fork && !session?.id) throw new ProcessError('a fork needs the session it copies', { kind: 'configuration-error', started: false, invocationId })

  const readOnlySource = tooling?.writesCode === false && !supervisorOnly
  if (readOnlySource) scratchDir = (await assertScratchOutsideWorktree(cwd, scratchDir)).scratchRoot

  // The last message is written to a file, which is more reliable than scraping
  // it back out of the event stream.
  const lastMessage = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-out-')), 'last.txt')

  // Decided before the arguments: a read-only coordinator turn gets its shell
  // only inside a proved fence.
  let fenced = null
  if (fence) {
    const early = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
    fenced = early.error ? { applied: false, reason: early.error }
      : await applyFence({ spec: { ...fence, cwd: readOnlySource ? scratchDir : cwd }, manifest: await fenceManifest({ binary: COMMAND(), env: early.env, lastMessageDir: path.dirname(lastMessage) }), command: COMMAND(), signal })
    if (!fenced.applied) { await fs.rm(path.dirname(lastMessage), { recursive: true, force: true }).catch(() => {}); assertFenced(fenced, { turn: 'a fenced Codex turn', mounts: fence.mounts ?? [] }) }
  }
  const readSeat = readOnlyTools && fenced?.applied === true
  if (readSeat) supervisorOnly = false

  try {
  const args = ['exec', '--json', '-o', lastMessage, '--skip-git-repo-check']
  if (session?.id) args.splice(1, 0, fork ? 'fork' : 'resume', session.id)
  // Reasoning summaries in the event stream (item.type reasoning), so the
  // panel can show what a turn is weighing; off unless asked for.
  args.push('-c', 'model_reasoning_summary="detailed"')
  if (supervisorOnly) {
    args.push('--ignore-user-config', '--ignore-rules')
    for (const setting of [
      'sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"',
      'mcp_servers={}', 'features.shell_tool=false', 'features.unified_exec=false',
      'features.apps=false', 'features.plugins=false', 'features.multi_agent=false',
      'features.multi_agent_v2=false', 'features.browser_use=false', 'features.computer_use=false',
      'features.code_mode=false', 'features.code_mode_host=false', 'features.image_generation=false',
      'features.view_image=false', 'features.js_repl=false', 'features.memories=false',
      'features.skill_mcp_dependency_install=false', 'features.skip_host_skill_discovery=true'
    ]) args.push('-c', setting)
  }
  // Hygiene (fence.hygiene: 1): a worker seat no longer reads the operator's
  // config.toml or execpolicy rules (their default sandbox, plugins, trusted
  // paths); what it needs is stated here. The shell, web search and the
  // repository's AGENTS.md are unaffected.
  if (readSeat) {
    // Read-only coordinator (Phase 1): a shell in Codex's read-only sandbox
    // (no writes, no network), no web search, MCP, apps or subagents.
    args.push('--ignore-user-config', '--ignore-rules')
    for (const setting of ['sandbox_mode="read-only"', 'approval_policy="never"', 'web_search="disabled"', 'mcp_servers={}',
      'features.apps=false', 'features.plugins=false', 'features.multi_agent=false', 'features.multi_agent_v2=false',
      'features.browser_use=false', 'features.computer_use=false', 'features.image_generation=false', 'features.memories=false']) args.push('-c', setting)
  } else if (hygiene && !supervisorOnly) {
    args.push('--ignore-user-config', '--ignore-rules')
    for (const setting of WORKER_SETTINGS) args.push('-c', setting)
    // The one MCP server a worker seat may have: the devpanel broker (Phase 3).
    if (broker) {
      args.push('-c', `mcp_servers.devpanel.command=${JSON.stringify(broker.node)}`, '-c', `mcp_servers.devpanel.args=${JSON.stringify([broker.shim])}`,
        '-c', `mcp_servers.devpanel.env={DEVPANEL_BROKER_SOCKET=${JSON.stringify(broker.socket)},DEVPANEL_BROKER_TOKEN=${JSON.stringify(broker.token)}}`,
        // approval_policy is never: without this Codex refuses every MCP call
        // ("requires approval"). The broker is the gate: it checks each call.
        '-c', 'mcp_servers.devpanel.default_tools_approval_mode="approve"')
    }
  }
  if (model) args.push('--model', model)
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`)
  // Codex's sandbox confines WRITES to the working directory; reads are not
  // fenceable. The policy is stated in the prompt and recorded; this is what
  // the runtime can enforce of it.
  const enforcement = tooling && !supervisorOnly && !readSeat ? { writes: 'workspace-write', reads: 'not-fenceable', bash: 'not-fenceable' } : null
  // Masked caches of a tooling mount (tooling.nodeModules): empty writable directories
  // outside the worktree in the fence, which the workspace-write sandbox must also let a tool write.
  const mountMasks = enforcement ? tooling.mountMasks ?? [] : []
  // `exec resume` has no --sandbox option; the config override is supported
  // by both fresh and resumed invocations and preserves the same write fence.
  if (enforcement) args.push('-c', 'sandbox_mode="workspace-write"')
  if (readOnlySource) {
    // workspace-write implicitly includes cwd. Make that root scratch, including
    // resumed sessions, and remove any extra writable roots from user config.
    args.push('-c', `cwd=${JSON.stringify(scratchDir)}`, '-c', 'approval_policy="never"',
      '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(mountMasks)}`, '-c', 'sandbox_workspace_write.exclude_slash_tmp=true')
    enforcement.writes = 'scratch-only'
    enforcement.source = 'read-only'
  }
  if (enforcement && tooling.networkAccess) args.push('-c', 'sandbox_workspace_write.network_access=true')
  // The writer's own Git directory (0d private repositories) lies outside its
  // working directory; `git add/commit` must be able to write there.
  const gitWorker = enforcement && !readOnlySource && tooling.writesCode === true && tooling.gitWorker ? tooling.gitWorker : null
  if (enforcement && !readOnlySource && (gitWorker || mountMasks.length)) {
    args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([...(gitWorker ? [gitWorker] : []), ...mountMasks])}`)
    if (gitWorker) enforcement.gitWorker = 'writable'
  }

  const body = [
    instructions ? `${instructions}${NL}${NL}` : '',
    prompt,
    marker ? `${NL}${NL}[${marker}]` : ''
  ].join('')

  // The runtime refuses more than this many input characters, after a session
  // and a preflight have been paid for. Refused here instead, before anything
  // starts, in the runtime's own words, so Retry input applies exactly as it
  // would to the runtime's rejection.
  if (body.length > CODEX_MAX_INPUT_CHARS) {
    await record(ledgerDir, { invocationId, marker, phase: 'not-started', error: 'input_too_large', at: new Date().toISOString() })
    throw runtimeError(`codex input_too_large: Input exceeds the maximum length of ${CODEX_MAX_INPUT_CHARS} characters (actual ${body.length}); not sent`, { started: false, invocationId, stderr: `input_too_large: Input exceeds the maximum length of ${CODEX_MAX_INPUT_CHARS} characters` })
  }

  await record(ledgerDir, { invocationId, marker, phase: 'started', at: new Date().toISOString() })

  // The same resolution the probe ran under: a probe that proves one account and
  // an invocation that runs as another proves nothing at all.
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) throw runtimeError(connection.error, { started: false })
  const env = connection.env
  if (supervisorOnly) { delete env.DEVPANEL_TOKEN; delete env.DEVPANEL_TOKEN_FILE }
  if (scratchDir) { env.DEVPANEL_SCRATCH_DIR = scratchDir; env.TMPDIR = scratchDir }
  const events = streamObserver(observe)
  const launch = fenced?.applied ? fenced.wrap(COMMAND(), args) : { command: COMMAND(), args }
  let run
  try {
    run = await runProcess({ command: launch.command, args: launch.args, cwd: readOnlySource ? scratchDir : cwd, env, stdin: body, signal, graceMs, maxBuffer, observe: events.hooks, reap: true, reapTag: meta.reapTag ?? null })
    ran.run = run
  } catch (error) {
    if (error.kind === 'spawn-error' && error.started === false) {
      await record(ledgerDir, { invocationId, marker, phase: 'not-started', error: error.message, code: error.code, at: new Date().toISOString() })
    }
    throw error
  }

  if (run.cancelled) {
    await record(ledgerDir, { invocationId, marker, phase: 'cancelled', at: new Date().toISOString() })
    throw cancelledError(run.termination)
  }

  if (run.code !== 0) {
    await record(ledgerDir, { invocationId, marker, phase: 'failed', at: new Date().toISOString() })
    // The runtime's error events from the JSON stream beside the TAIL of stderr
    // (the error is its last words, not its first); never the model's text.
    throw runtimeError(`codex exited ${run.code}`, { code: run.code, stderr: run.stderr.trim().slice(-2000), stdout: codexErrors(run.stdout), invocationId })
  }

  // Session id and usage come from the observer, which saw every line; the
  // retained buffer is a fallback for what it may have dropped.
  const seen = events.seen
  const parsed = { ...parseEvents(run.stdout) }
  parsed.sessionId = seen.sessionId ?? parsed.sessionId
  parsed.usage = seen.usage ?? parsed.usage
  parsed.text = seen.text ?? parsed.text
  let response = parsed.text
  // The file sits where the CLI (and so the model's shell) can write: a link or
  // a FIFO planted at its name must not make the host read another file into
  // the response, or block. Opened without following links and without
  // blocking, and only a regular file is read; anything else falls back to the
  // event stream (the seat-access fence's audit finding R8-1).
  try {
    const handle = await fs.open(lastMessage, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    try {
      if ((await handle.stat()).isFile()) response = await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch { /* fall back to the event stream */ }

  if (!parsed.sessionId) {
    throw runtimeError('codex did not report a session id', { stdout: run.stdout.slice(0, 500), invocationId })
  }

  // OpenAI semantics: input_tokens already includes cached input; the cached
  // share is reported separately and is not added again.
  // `turn.completed.usage` is the THREAD's running total: on `exec resume` it
  // includes every earlier invocation of the same session (observed: the
  // counters only ever grow across resumed turns). What this invocation used
  // is the difference from the totals recorded on the session descriptor.
  const u = parsed.usage ?? {}
  const reported = {
    inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
    cacheReadTokens: typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : null
  }
  const { delta, totals, basis } = cumulativeDelta(session?.tokenTotals ?? null, reported)
  const usage = {
    provider: 'openai',
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    cacheCreationTokens: null,
    cacheReadTokens: delta.cacheReadTokens,
    tokens: (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0),
    costUsd: null,
    tokensReported: reported,
    tokensBasis: basis
  }

  // The descriptor goes in the ledger too: a turn adopted by crash recovery
  // must carry the running totals the next resumed turn subtracts, or that turn
  // is charged the whole session again.
  const descriptor = { id: parsed.sessionId, tokenTotals: Object.keys(totals).length ? totals : (session?.tokenTotals ?? null) }
  await record(ledgerDir, {
    invocationId, marker, phase: 'completed',
    sessionId: parsed.sessionId, session: descriptor, response, usage, at: new Date().toISOString()
  })

  return {
    session: descriptor,
    response: response ?? '',
    usage,
    outcome: 'completed',
    diagnostics: { durationMs: run.durationMs, reap: run.leftovers?.scan ?? null, events: parsed.events.length, tooling: enforcement, hygiene: Boolean(hygiene),
      fence: fence ? { namespace: fenced?.applied ? 1 : 0, reason: fenced?.reason ?? null, proof: fenced?.proof ?? null, mounts: fenced?.mounts ?? null } : null,
      ...(readOnlyTools ? { access: readSeat ? 'read' : 'none (fence not proved)' } : {}) }
  }
  } finally { await fs.rm(path.dirname(lastMessage), { recursive: true, force: true }) }
}

// --- the event stream ---------------------------------------------------------

/** What one `codex exec --json` event says the runtime is doing. Liveness only. */
export function describeEvent (e) {
  if (!e || typeof e !== 'object' || !e.type) return null
  const item = e.item?.type ?? null
  if (e.type === 'item.started' || e.type === 'item.completed') {
    return { kind: item === 'command_execution' ? 'tool-use' : item === 'agent_message' ? 'text' : (item ?? 'item'), detail: e.item?.command ?? null }
  }
  if (e.type.startsWith('turn.')) return { kind: e.type, detail: null }
  if (e.type.startsWith('session.') || e.type.startsWith('thread.')) return { kind: 'system', detail: e.type }
  return { kind: e.type, detail: null }
}

/** The shared observer, capturing session id, usage and the last agent message. */
function streamObserver (observe) {
  const seen = { sessionId: null, usage: null, text: null }
  const observer = lineObserver({
    observe,
    describeEvent,
    onEvent: (e) => {
      seen.sessionId = e.session_id ?? e.conversation_id ?? e.thread_id ?? seen.sessionId
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') seen.text = e.item.text ?? seen.text
      if (e.usage) seen.usage = e.usage
    }
  })
  return { get count () { return observer.count }, seen, hooks: observer.hooks }
}
