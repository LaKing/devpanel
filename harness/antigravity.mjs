import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveCommand } from '../gui/server/runtime/command.mjs'
import { harnessRefusal } from '../gui/server/runtime/confinement-policy.mjs'
import { runProcess, ProcessError } from '../gui/server/runtime/process.mjs'
import { NL, installationProbe, probeModels, createLedger, lineObserver, cancelledError, runtimeError, cumulativeDelta, childEnvironment, withReap } from './shared.mjs'
import { applyFence, assertFenced } from './fence.mjs'

/*
 * Antigravity adapter: the `agy` CLI, signed in with the service user's own Antigravity login. It reaches the Gemini
 * models through that login's plan, with effort levels, where the `gemini` adapter needs an API key.
 *
 * What this adapter relies on, each seen on agy 1.5.16 (docs/model-providers.md "Antigravity" names the probes):
 *  - `--print= --input-format stream-json --output-format stream-json` reads one NDJSON prompt from stdin and
 *    prints `init`, `step_update` and `result` events; the conversation id arrives with `init` (sessions are
 *    DISCOVERED, as with codex) and `--conversation <id>` resumes it.
 *  - `--settings <json>` replaces the login's own settings for the session, and `init.permission_mode` says which
 *    took effect. The operator's settings here allow everything, so a turn whose `init` does not echo the mode this
 *    adapter set is refused, its answer unused.
 *  - The CLI keeps its whole state, the login token included, under `$HOME/.gemini/antigravity-cli`. No documented
 *    variable moves it, so every turn runs with HOME set to a home of its own: the run's (`cliHome`) inside the
 *    fence, where only the token file is bound in, read-only.
 *
 * Decisions:
 *  - The seat fence is the boundary, the CLI's permission rules are the second line. With `read_file` allowed only
 *    for its roots the CLI still read /etc/hostname in a probe: its own rules do not confine reads.
 *  - The tools are an allow-list by NAME, in two places the seat's own home carries (`prepareHome`): the agent the
 *    session runs as declares them, and a PreToolUse hook denies every call to anything else. The permission rules
 *    have no action for web search, subagents, scheduled tasks or messages: with the rules alone a read seat
 *    searched the web, started a subagent and scheduled a task in a live probe.
 *  - A turn gets tools only inside a PROVED fence. Without one (the suite, a preflight probe) it is tool-free, in a
 *    home that links the token instead of binding it; a fence that was asked for and could not be proved refuses
 *    the turn.
 *  - No seat writes source or runs commands yet: a read seat (consult, auditor, a coordinator's `access: read`) has
 *    the read tools, every other turn none. Writing needs the CLI's command tool measured inside the fence first.
 *  - The token is bound read-only. A refresh the seat makes is kept in memory and lost with the turn; the login's
 *    own file is never written by a seat.
 * Pitfalls:
 *  - A workspace's `.agents/` (also `.agent`, `_agents`, `_agent`) can carry hooks, MCP servers and plugins the CLI
 *    runs by itself, outside its permission rules and with no trust gate. They are masked in the fence.
 *  - `result.usage` is the conversation's running total; what a turn used is the difference (cumulativeDelta).
 *  - A permission the CLI cannot ask for in a headless run is soft-denied: the turn goes on and exits 0.
 */

export const id = 'antigravity'

export const capabilities = {
  sessionAssignment: 'discover',
  resume: true,
  effort: true,             // the effort is part of the model id the CLI lists (gemini-4-neon-high)
  structuredOutput: false,
  cancellation: true,
  instructions: true
}

const COMMAND = () => resolveCommand('agy', process.env.DEVPANEL_ANTIGRAVITY_BIN)
const STATE_DIR = path.join('.gemini', 'antigravity-cli')
const TOKEN_FILE = 'antigravity-oauth-token'
const LEDGER_FILE = 'antigravity-ledger.jsonl'
/** Directories of a workspace whose content the CLI executes or connects to on its own. */
export const AGENT_DIRS = Object.freeze(['.agents', '.agent', '_agents', '_agent'])
/** The level a turn runs at when none is named (a probe): every listed model has it. */
export const DEFAULT_EFFORT = 'medium'
/** The id the CLI knows a model by: the roster's wire model with the effort level. */
export const wireModel = (model, effort) => `${model}-${effort ?? DEFAULT_EFFORT}`
/** The service user's login token; DEVPANEL_ANTIGRAVITY_TOKEN lets the suite name a stand-in. */
export const loginToken = () => process.env.DEVPANEL_ANTIGRAVITY_TOKEN ?? path.join(os.homedir(), STATE_DIR, TOKEN_FILE)
const exists = (file) => fs.lstat(file).then(() => true, () => false)

/** Only the service user's own login exists here: no API key, no endpoint, no second person's account yet. */
export function resolveConnection ({ profile = 'default', endpointRef = null, credentialRef = null, account = null, hygiene = false } = {}) {
  const env = hygiene ? childEnvironment('antigravity') : { ...process.env }
  const applied = { profile, endpointRef, credentialRef, account, auth: 'login' }
  if (account || endpointRef || credentialRef || profile !== 'default') {
    return { env, applied, error: 'the antigravity adapter runs only as the service user\'s own Antigravity login: it takes no account, endpoint, credential or profile' }
  }
  // The updater would rewrite the binary the fence binds read-only, and has no business in a seat's home.
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  return { env, applied, error: null }
}

/**
 * What the CLI needs inside the seat fence: its binary (read-only), the run's home (read-write: conversations,
 * logs, caches), over the placeholder in that home the login's token file, read-only, and the seat's own
 * customizations (prepareHome) read-only.
 */
export function fenceManifest ({ binary, runHome, customizations = [] }) {
  return {
    home: os.homedir(),
    homeBinds: [{ path: binary, writable: false }],
    binds: [{ source: loginToken(), target: path.join(runHome, STATE_DIR, TOKEN_FILE), writable: false }],
    writable: [runHome],
    // The agent, the hook and its gate decide what the seat may call: bound read-only over themselves, last.
    entries: customizations
  }
}

/** What a read seat's agent declares, by the names the CLI's documentation gives its tools. */
export const READ_TOOLS = Object.freeze(['view_file', 'list_dir', 'find_by_name', 'grep_search'])
/**
 * What the gate lets through. Pitfall: the hook is handed the file reader as `read_file`, not as the `view_file` an
 * agent declares it by (agy 1.5.16: a gate allowing only the documented names denied every read).
 */
export const GATE_TOOLS = Object.freeze([...READ_TOOLS, 'read_file'])
/** The agent every seat's session runs as: its declared tools are all the model is offered. */
export const SEAT_AGENT = 'devpanel-seat'
const NODE = () => process.env.DEVPANEL_ANTIGRAVITY_NODE ?? '/usr/bin/node'

/*
 * The gate the CLI runs before every tool call (a PreToolUse hook, matcher "*"), invoked as `gate <seat home>
 * <tool>...`: the call goes on to the permission rules only when its tool is named, anything else is denied. It
 * parses the event, because a search for the name in the raw text would let a call's own arguments spell an allowed
 * one. Whatever it cannot read is a denial.
 * It also denies an allowed tool any argument that points into the seat's own home or names the token file: the
 * token has to be readable by the CLI's process, so no mount can hide it from the model's reader, and the permission
 * rule that denies it is the CLI's to keep. This is the second, independent refusal.
 */
const TOOL_GATE = `import path from 'node:path'
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const [home, ...tools] = process.argv.slice(2)
  let call = null
  try { call = JSON.parse(input)?.toolCall ?? null } catch { call = null }
  const name = typeof call?.name === 'string' ? call.name : null
  const strings = []
  const walk = (value) => { if (typeof value === 'string') strings.push(value); else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v) }
  walk(call?.args)
  const inHome = (value) => value.includes('${TOKEN_FILE}') || path.resolve(value) === home || path.resolve(value).startsWith(home + path.sep)
  const reason = !name || !tools.includes(name) ? 'devpanel: this seat may not use ' + (name ?? 'this tool')
    : strings.some(inHome) ? 'devpanel: the seat\\'s own home is not readable' : null
  process.stdout.write(JSON.stringify(reason ? { decision: 'deny', reason } : { decision: 'allow' }))
})
`

/**
 * The customizations in the seat's own home (`$HOME/.gemini/config`, the CLI's global scope): the agent with its
 * tool list and the hook with its gate. Written before every turn; the fence binds the three files read-only.
 * @returns the files, for the fence to bind
 */
export async function prepareHome ({ home, access }) {
  const config = path.join(home, '.gemini', 'config')
  const tools = access === 'read' ? READ_TOOLS : []
  const passed = access === 'read' ? GATE_TOOLS : []
  const gate = path.join(config, 'devpanel-tool-gate.mjs')
  const files = {
    [gate]: TOOL_GATE,
    [path.join(config, 'hooks.json')]: JSON.stringify({ 'devpanel-tool-gate': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: [NODE(), gate, home, ...passed].join(' '), timeout: 10 }] }] } }, null, 2),
    [path.join(config, 'agents', `${SEAT_AGENT}.md`)]: ['---', `name: ${SEAT_AGENT}`, 'description: A seat of an automated panel. It reads what it was given and answers; it changes nothing.',
      `tools: [${tools.join(', ')}]`, 'mainAgent: true', 'subagent: false', 'commandExecutionPolicy: off', '---', '',
      'You are a seat of an automated panel. Do exactly what the prompt you are given asks, and answer in the form it asks for.', ''].join(NL)
  }
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
  }
  return Object.keys(files)
}

/**
 * The session's settings. `access: 'read'` allows `read_file` on the given roots and nothing else; `'none'` asks
 * before every tool action, which a headless run answers with a denial.
 */
export function seatSettings ({ access, roots = [], home }) {
  const deny = ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)']
  if (access !== 'read') return { toolPermission: 'strict', allowNonWorkspaceAccess: false, permissions: { allow: [], deny: [...deny, 'read_file(*)'] } }
  // The seat's own home holds the token: never readable by the model, whatever a root contains.
  return { toolPermission: 'request-review', allowNonWorkspaceAccess: false, permissions: { allow: roots.map((root) => `read_file(${root})`), deny: [...deny, `read_file(${home})`] } }
}

export async function probe ({ depth = 'installation', models = [], profile = 'default', endpointRef = null, credentialRef = null, account = null, signal = null, timeoutMs = 120000, hygiene = false } = {}) {
  const result = await installationProbe(COMMAND(), { id, depth, models, profile, endpointRef, credentialRef, account, capabilities })
  if (result.installation.status !== 'installed' || depth === 'installation') return result
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) {
    result.usage = { tokens: 0, costUsd: 0, costUnknownCalls: 0 }
    result.invocations = 0
    result.authentication = { status: 'error', detail: connection.error }
    for (const model of models) result.modelAccess[model] = { status: 'unknown', detail: connection.error }
    return result
  }
  result.connection = { ...result.connection, applied: connection.applied }
  // The CLI reports tokens, never money: every call counts as unknown.
  return probeModels(result, { invoke: hygiene ? (options) => invoke({ ...options, hygiene }) : invoke, models, profile, endpointRef, credentialRef, account, signal, timeoutMs, costKnown: false })
}

const { record, reconcile: reconcileLedger } = createLedger(LEDGER_FILE)
/** A discovered session is tied to an invocation by the ledger and the marker in the turn, never by recency. */
export const reconcile = (invocationId, options = {}) => reconcileLedger(invocationId, options)

/** One turn. An error raised after the runtime ran carries its descendant scan (shared.mjs withReap). */
export async function invoke (options) {
  const ran = {}
  try { return await invokeOnce(options, ran) } catch (error) { throw withReap(error, ran.run) }
}

async function invokeOnce ({
  session, model, effort, cwd, instructions, prompt, marker, signal, meta = {}, ledgerDir = null, graceMs = 5000, supervisorOnly = false,
  scratchDir = null, observe = null, maxBuffer = undefined, tooling = null, profile = 'default', endpointRef = null, credentialRef = null,
  account = null, hygiene = false, fence = null, readOnlyTools = false, fork = false, cliHome = null
} = {}, ran = {}) {
  const invocationId = meta.invocationId ?? crypto.randomUUID()
  const refuse = (message, kind = 'configuration-error') => new ProcessError(message, { kind, started: false, invocationId })
  const refusal = harnessRefusal(id)
  if (refusal) throw refuse(refusal, 'environment-error')
  if (fork) throw refuse('antigravity cannot continue a copy of a conversation: its CLI has no fork')
  if (tooling?.writesCode === true && !supervisorOnly) throw refuse('an antigravity seat cannot write source yet: this adapter gives a seat read tools at most; seat the writer on claude or codex')
  const connection = resolveConnection({ profile, endpointRef, credentialRef, account, hygiene })
  if (connection.error) throw refuse(connection.error)
  const token = loginToken()
  if (!await exists(token)) throw refuse(`antigravity is not signed in: ${token} is missing (sign in once with \`agy\` as the service user)`, 'environment-error')

  // The home this turn's CLI lives in. The CLI keeps a conversation there, so a turn that may be resumed needs one
  // that stays: the seat's home in the run (`cliHome`), else one beside the ledger. Only a turn nobody can resume (a
  // preflight probe: neither is given) gets a throwaway home.
  const runHome = session?.home ?? cliHome ?? (ledgerDir ? path.join(ledgerDir, 'antigravity-home') : null)
  if (fence && !runHome) throw refuse('a fenced antigravity turn needs the run\'s home for the seat (cliHome): the CLI keeps its conversations there')
  const home = runHome ?? await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-agy-'))
  const seatToken = path.join(home, STATE_DIR, TOKEN_FILE)
  try {
    await fs.mkdir(path.dirname(seatToken), { recursive: true })
    await fs.rm(seatToken, { force: true })
    // Inside the fence the token is bound over an empty placeholder; outside it a link, never a copy of the secret.
    if (fence) await fs.writeFile(seatToken, '', { mode: 0o600 })
    else await fs.symlink(token, seatToken)

    const roots = [...new Set([cwd, ...(tooling?.allowedRoots ?? [])].filter(Boolean))]
    // Decided before the fence is tried, because the fence binds what it writes; a turn whose fence then cannot be
    // proved never runs with them (refused below).
    const wanted = fence && (readOnlyTools || (tooling && !supervisorOnly)) ? 'read' : 'none'
    const customizations = await prepareHome({ home, access: wanted })
    let fenced = null
    if (fence) {
      const masks = []
      for (const root of roots) for (const name of AGENT_DIRS) if (await exists(path.join(root, name))) masks.push(path.join(root, name))
      fenced = await applyFence({ spec: { ...fence, cwd, masks: [...(fence.masks ?? []), ...masks] }, manifest: fenceManifest({ binary: COMMAND(), runHome, customizations }), command: COMMAND(), signal })
      assertFenced(fenced, { turn: 'a fenced Antigravity turn', mounts: fence.mounts ?? [] })
      if (!fenced.applied) throw refuse(`an antigravity turn that was to be fenced runs only inside a proved fence, and it could not be proved: ${fenced.reason}`, 'environment-error')
    }
    const access = fenced?.applied ? wanted : 'none'
    const settings = seatSettings({ access, roots, home })
    const wire = wireModel(model, effort)
    const args = ['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', wire, '--settings', JSON.stringify(settings), '--agent', SEAT_AGENT, '--disable-slash-commands']
    if (access === 'read') for (const root of roots.slice(1)) if (await fs.stat(root).then((s) => s.isDirectory(), () => false)) args.push('--add-dir', root)
    if (session?.id) args.push('--conversation', session.id)

    const body = [instructions ? `${instructions}${NL}${NL}` : '', prompt, marker ? `${NL}${NL}[${marker}]` : ''].join('')
    await record(ledgerDir, { invocationId, marker, phase: 'started', at: new Date().toISOString() })
    const env = { ...connection.env, HOME: home }
    if (supervisorOnly) { delete env.DEVPANEL_TOKEN; delete env.DEVPANEL_TOKEN_FILE }
    if (scratchDir) { env.DEVPANEL_SCRATCH_DIR = scratchDir; env.TMPDIR = scratchDir }
    const events = streamObserver(observe)
    const launch = fenced?.applied ? fenced.wrap(COMMAND(), args) : { command: COMMAND(), args }
    let run
    try {
      // The prompt goes in on stdin as one event: an argument is capped by the kernel and readable in /proc.
      run = await runProcess({ command: launch.command, args: launch.args, cwd, env, stdin: JSON.stringify({ event: 'user', message: { content: body } }) + NL, signal, graceMs, maxBuffer, observe: events.hooks, reap: true, reapTag: meta.reapTag ?? null })
    } catch (error) {
      if (error.kind === 'spawn-error' && error.started === false) await record(ledgerDir, { invocationId, marker, phase: 'not-started', error: error.message, code: error.code, at: new Date().toISOString() })
      throw error
    }
    ran.run = run
    const failed = async (error) => { await record(ledgerDir, { invocationId, marker, phase: 'failed', error: error.message, at: new Date().toISOString() }); return error }
    if (run.cancelled) {
      await record(ledgerDir, { invocationId, marker, phase: 'cancelled', at: new Date().toISOString() })
      throw cancelledError(run.termination)
    }
    const { init, result } = events.seen
    const said = [result?.error, run.stderr.trim().slice(-2000)].filter(Boolean).join(NL)
    if (run.code !== 0) throw await failed(runtimeError(`agy exited ${run.code}`, { code: run.code, stderr: said, invocationId }))
    if (!result) throw await failed(runtimeError('agy ended without a result event', { stderr: said, stdout: run.stdout.slice(0, 500), invocationId }))
    if (result.status !== 'SUCCESS') throw await failed(runtimeError(`agy ended ${result.status}${result.error ? `: ${String(result.error).slice(0, 300)}` : ''}`, { stderr: said, invocationId }))
    // Whatever the turn did, it did under other settings than these: nothing of it is used.
    if (init?.permission_mode !== settings.toolPermission) {
      throw await failed(new ProcessError(`agy ran this turn with permission mode "${init?.permission_mode ?? 'unreported'}" instead of "${settings.toolPermission}": the session settings did not take effect and its answer is not used`, { kind: 'environment-error', invocationId, stderr: said }))
    }
    if (init?.model && init.model !== wire) throw await failed(new ProcessError(`agy served this turn with ${init.model} instead of ${wire}; its answer is not used`, { kind: 'environment-error', invocationId, stderr: said }))
    const sessionId = result.conversation_id ?? events.seen.conversationId
    if (!sessionId) throw await failed(runtimeError('agy did not report a conversation id', { stdout: run.stdout.slice(0, 500), invocationId }))

    // input_tokens leaves the cached share out (a resumed turn reported 2 319 input beside 9 399 cache reads).
    const u = result.usage ?? {}
    const number = (v) => (typeof v === 'number' ? v : null)
    const reported = { inputTokens: number(u.input_tokens), outputTokens: number(u.output_tokens), cacheReadTokens: number(u.cache_read_tokens) }
    const { delta, totals, basis } = cumulativeDelta(session?.tokenTotals ?? null, reported)
    const usage = {
      provider: 'google', inputTokens: delta.inputTokens, outputTokens: delta.outputTokens, cacheCreationTokens: null, cacheReadTokens: delta.cacheReadTokens,
      tokens: (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0) + (delta.cacheReadTokens ?? 0), costUsd: null, tokensReported: reported, tokensBasis: basis
    }
    const descriptor = { id: sessionId, home: runHome, tokenTotals: Object.keys(totals).length ? totals : (session?.tokenTotals ?? null) }
    const response = String(result.response ?? '')
    await record(ledgerDir, { invocationId, marker, phase: 'completed', sessionId, session: descriptor, response, usage, at: new Date().toISOString() })
    return {
      session: descriptor, response, usage, outcome: 'completed',
      diagnostics: {
        durationMs: run.durationMs, reap: run.leftovers?.scan ?? null, events: events.count, hygiene: Boolean(hygiene),
        tooling: { reads: access === 'read' ? 'the fence\'s roots' : 'denied', writes: 'denied', shell: 'denied', mcp: 'denied', web: 'denied', tools: access === 'read' ? READ_TOOLS : [], agent: SEAT_AGENT, settings, model: wire },
        // Every tool the runtime reported running, with how it ended: an ERROR on a denied tool is the rule holding.
        toolCalls: events.seen.toolCalls,
        fence: fence ? { namespace: fenced?.applied ? 1 : 0, reason: fenced?.reason ?? null, proof: fenced?.proof ?? null, mounts: fenced?.mounts ?? null } : null,
        ...(readOnlyTools ? { access: access === 'read' ? 'read' : 'none (fence not proved)' } : {})
      }
    }
  } finally {
    if (!runHome) await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

// --- the event stream ---------------------------------------------------------

/** What one stream-json event says the runtime is doing. Liveness only. */
export function describeEvent (e) {
  if (!e || typeof e !== 'object' || !e.event) return null
  if (e.event === 'step_update') {
    const s = e.step_update ?? {}
    if (s.step_type === 'tool') return { kind: 'tool-use', detail: s.tool_name ?? null }
    return { kind: s.step_type === 'agent_response' ? 'text' : (s.step_type ?? 'step'), detail: null }
  }
  return { kind: e.event === 'init' ? 'system' : e.event, detail: null }
}

/** The shared observer, keeping `init`, the last `result` and every finished tool step. */
function streamObserver (observe) {
  const seen = { init: null, result: null, conversationId: null, toolCalls: [] }
  const observer = lineObserver({
    observe,
    describeEvent,
    onEvent: (e) => {
      seen.conversationId = e.conversation_id ?? e.step_update?.conversation_id ?? seen.conversationId
      if (e.event === 'init') seen.init = e.init ?? {}
      if (e.event === 'result') seen.result = e.result ?? null
      const s = e.event === 'step_update' ? e.step_update : null
      if (s?.step_type === 'tool' && ['DONE', 'ERROR'].includes(s.state)) seen.toolCalls.push({ name: s.tool_name ?? s.tool_info?.name ?? null, state: s.state })
    }
  })
  return { get count () { return observer.count }, seen, hooks: observer.hooks }
}
