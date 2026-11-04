#!/usr/bin/env node
/*
 * A controlled stand-in for an agent CLI.
 *
 * Emits the output shapes the real adapters parse, and echoes back everything it
 * was invoked with — model, effort, instructions, session handling, environment —
 * so a contract test can prove those values actually reached the runtime rather
 * than being dropped somewhere in the adapter.
 *
 * Behaviour is driven by AGENT_MODE:
 *   ok             a normal turn
 *   malformed      a well-formed RUN that produced unusable agent output
 *   runtime-error  a failed run: non-zero exit, error on stderr, no result
 *   slow           sleeps, for deadline and cancellation tests
 *   breach         (gemini) a runtime that ignored the fence and wrote anyway
 *   fence-denied   (gemini) a runtime that attempted every fenced tool and was refused
 *   policy-error   (gemini) a runtime that could not parse the admin policy, and carried on
 *   policy-ignored (gemini) a runtime that dropped --admin-policy for system policies, and carried on
 *   policy-silent  (gemini) a runtime that never acknowledged the policy at all
 *   effort-ignored (codex) a runtime that accepted the turn but sent its default effort
 *   resume-inherits (codex) a runtime that honours the override on a fresh turn but keeps
 *                  the session's earlier effort on resume
 *   model-substituted (codex) a runtime that served the turn with another model
 *   oauth-expired  (claude) a turn whose login was rejected: unless
 *                  the login's .credentials.json ($CLAUDE_CONFIG_DIR, else
 *                  ~/.claude, as the real CLI) says `fresh`, it fails
 *                  with the runtime's "OAuth session expired" result; with
 *                  AGENT_ROTATE_CREDENTIALS=1 it first replaces that file with
 *                  `fresh` (write, then rename), as another process's refresh does
 *
 * With AGENT_ROLLOUT=1 and CODEX_HOME set, the codex shape also writes the
 * rollout file the real CLI keeps under $CODEX_HOME/sessions — a session_meta
 * line, then one turn_context per turn naming the model and effort it sent —
 * so a check that reads effort evidence off the filesystem can be exercised.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const NL = String.fromCharCode(10)
const argv = process.argv.slice(2)
const mode = process.env.AGENT_MODE ?? 'ok'
const shape = process.env.AGENT_SHAPE ?? 'claude'

const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const has = (name) => argv.includes(name)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --version is probed before anything else.
if (has('--version')) {
  process.stdout.write((process.env.AGENT_VERSION ?? 'fake-agent 9.9.9') + NL)
  process.exit(0)
}

// Both adapters deliver the prompt on stdin; -p / --print is a boolean flag.
let prompt = ''
try { prompt = fs.readFileSync(0, 'utf8') } catch { prompt = '' }

// Session handling differs by runtime: one accepts an id, the other invents one.
const preassigned = flag('--session-id')
const resumed = flag('--resume') ?? (argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : null)
const sessionId = resumed ?? preassigned ?? crypto.randomUUID()

/*
 * Gemini's settings, resolved the way the runtime resolves them (v0.60.0):
 * system settings outrank the workspace's, which outrank the user's, and the
 * auth method is the merged `security.auth.selectedType` when one is set, else
 * whatever the environment implies. This is what lets a test prove the adapter
 * pinned the method, rather than merely set a variable the runtime may ignore.
 */
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
const geminiHome = process.env.GEMINI_CLI_HOME ?? process.env.HOME ?? ''
const geminiSettings = {
  user: readJson(path.join(geminiHome, '.gemini/settings.json')),
  workspace: readJson(path.join(process.cwd(), '.gemini/settings.json')),
  system: readJson(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? '/etc/gemini-cli/settings.json')
}
const authFrom = (settings) => settings?.security?.auth ?? {}
const mergedAuth = { ...authFrom(geminiSettings.user), ...authFrom(geminiSettings.workspace), ...authFrom(geminiSettings.system) }
const authFromEnv = process.env.GOOGLE_GENAI_USE_GCA === 'true' ? 'oauth-personal'
  : process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' ? 'vertex-ai'
    : process.env.GOOGLE_GEMINI_BASE_URL ? 'gateway'
      : process.env.GEMINI_API_KEY ? 'gemini-api-key' : null
const effectiveAuth = mergedAuth.selectedType || authFromEnv
const authError = mergedAuth.enforcedType && effectiveAuth !== mergedAuth.enforcedType
  ? `The enforced authentication type is '${mergedAuth.enforcedType}', but the current type is '${effectiveAuth}'. Please re-authenticate with the correct type.`
  : null

// Where the real CLI keeps its login: $CLAUDE_CONFIG_DIR, else ~/.claude.
const credentialFile = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? '', '.claude'), '.credentials.json')
const received = {
  model: flag('--model') ?? flag('-m'),
  // Claude takes a flag; Codex takes a config override that may sit among
  // other `-c` overrides, so it is found wherever it is rather than assumed first.
  effort: flag('--effort') ?? argv.reduce((found, arg, i) => found ?? (arg === '-c' && /^model_reasoning_effort=/.test(argv[i + 1] ?? '') ? argv[i + 1].split('=')[1] : null), null),
  instructions: flag('--append-system-prompt'),
  // A coordination-only turn is launched with every tool disabled.
  toolFree: argv.includes('--tools') && flag('--tools') === '',
  cwd: process.cwd(),
  promptBytes: prompt.length,
  promptHead: prompt.slice(0, 120),
  resumed,
  preassigned,
  baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN ? 'present' : null,
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  credentials: mode === 'oauth-expired' ? (() => { try { return fs.readFileSync(credentialFile, 'utf8') } catch { return null } })() : undefined,
  apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
  oauthPresent: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
  // Gemini keeps its whole state — login, settings, sessions — under this one
  // directory, so it is the account fence and has to be observable here.
  geminiHome: process.env.GEMINI_CLI_HOME ?? null,
  geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
  googleKeyPresent: Boolean(process.env.GOOGLE_API_KEY),
  googleCredentialsPresent: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
  useGca: process.env.GOOGLE_GENAI_USE_GCA ?? null,
  useVertex: process.env.GOOGLE_GENAI_USE_VERTEXAI ?? null,
  geminiBaseUrl: process.env.GOOGLE_GEMINI_BASE_URL ?? null,
  systemSettingsPath: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? null,
  systemDefaultsPath: process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? null,
  systemSettings: geminiSettings.system,
  effectiveAuth,
  authError,
  approvalMode: flag('--approval-mode'),
  // The permission fence is a FILE the runtime reads. Recording its contents is
  // the only way a test can assert what the runtime was actually told.
  adminPolicy: flag('--admin-policy') ? fs.readFileSync(flag('--admin-policy'), 'utf8') : null,
  adminPolicyFile: flag('--admin-policy') ? path.basename(flag('--admin-policy')) : null,
  userPolicy: flag('--policy'),
  includeDirectories: argv.reduce((dirs, arg, i) => arg === '--include-directories' ? [...dirs, argv[i + 1]] : dirs, []),
  scratchDir: process.env.DEVPANEL_SCRATCH_DIR ?? null,
  tempDir: process.env.AGENT_TMPDIR || process.env.TMPDIR || null,
  tempMode: (process.env.AGENT_TMPDIR || process.env.TMPDIR) ? (fs.statSync(process.env.AGENT_TMPDIR || process.env.TMPDIR).mode & 0o777) : null,
  argv
}

/*
 * The rollout the real Codex CLI writes (0.154.0–0.155.1): appended per turn,
 * named by the session id, under a date directory. `effort` is what the runtime
 * sent for the turn; a runtime that ignored the override records its default.
 */
function codexRollout () {
  if (shape !== 'codex' || process.env.AGENT_ROLLOUT !== '1' || !process.env.CODEX_HOME) return
  const day = new Date().toISOString().slice(0, 10).split('-')
  const dir = path.join(process.env.CODEX_HOME, 'sessions', ...day)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${new Date().toISOString().replace(/[:.]/g, '-')}-${sessionId}.jsonl`)
  const existing = fs.readdirSync(dir).find((name) => name.endsWith(`-${sessionId}.jsonl`))
  const target = existing ? path.join(dir, existing) : file
  const lines = []
  const previous = existing
    ? fs.readFileSync(target, 'utf8').split(NL).filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.type === 'turn_context').at(-1)?.payload?.effort ?? null
    : null
  const effort = mode === 'effort-ignored' ? 'medium'
    : mode === 'resume-inherits' && previous ? previous
      : (received.effort ?? 'medium')
  if (!existing) {
    lines.push({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sessionId, cli_version: process.env.AGENT_VERSION ?? 'fake-agent 9.9.9', model_provider: 'openai' } })
  }
  lines.push({
    timestamp: new Date().toISOString(),
    type: 'turn_context',
    payload: { turn_id: crypto.randomUUID(), model: mode === 'model-substituted' ? 'gpt-6-astra-mini' : (received.model ?? 'gpt-6-astra'), effort, summary: 'auto' }
  })
  fs.appendFileSync(target, lines.map((l) => JSON.stringify(l)).join(NL) + NL)
}

// A record the test inspects, and the ledger a reconcile() reads.
if (process.env.AGENT_RECORD) {
  fs.appendFileSync(process.env.AGENT_RECORD, JSON.stringify({
    at: new Date().toISOString(), sessionId, mode, received,
    marker: (prompt.match(/devpanel:[^\s\]]+/) ?? [null])[0]
  }) + NL)
}

/*
 * What the real Gemini CLI says about the admin policy it was handed, on stderr,
 * before it does anything else (v0.60.0):
 *
 *   - a rule naming a tool it does not recognise but nearly does earns
 *     "[WARNING] [ADMIN] Policy file warning in <file>:" — the acknowledgement
 *     the adapter requires, and the only positive sign the file was loaded;
 *   - a malformed file earns "[ADMIN] Policy file error", and the run goes on;
 *   - when system policies exist, --admin-policy is dropped with a security
 *     warning, and the run goes on — unfenced.
 *
 * The acknowledgement is followed by a pause before any stdout, as the real
 * runtime has a model round-trip between loading its policy and running a tool.
 */
const GEMINI_TOOLS = ['read_file', 'read_many_files', 'glob', 'grep_search', 'list_directory', 'write_todos', 'update_topic', 'complete_task',
  'web_fetch', 'google_web_search', 'write_file', 'replace', 'run_shell_command', 'list_background_processes', 'read_background_output',
  'enter_plan_mode', 'exit_plan_mode', 'invoke_agent', 'activate_skill', 'take_snapshot', 'ask_user', '*']
if (shape === 'gemini' && received.adminPolicy !== null) {
  if (mode === 'policy-ignored') {
    process.stderr.write('[WARNING] Security Warning: Ignoring --admin-policy because system policies are already defined in /etc/gemini-cli/policies' + NL)
  } else if (mode === 'policy-error') {
    process.stderr.write('[ADMIN] Policy file error in ' + received.adminPolicyFile + ':' + NL)
    process.stderr.write('  TOML parsing failed' + NL)
  } else if (mode !== 'policy-silent') {
    const names = [...received.adminPolicy.matchAll(/^toolName = (.+)$/gm)].flatMap(([, raw]) => JSON.parse(raw.replace(/,\s*\]$/, ']')))
    names.forEach((name, i) => {
      if (GEMINI_TOOLS.includes(name)) return
      process.stderr.write(`[WARNING] [ADMIN] Policy file warning in ${received.adminPolicyFile}:${NL}  Unrecognized tool name${NL}Rule #${i + 1}: Unrecognized tool name "${name}". Did you mean "${name.replace(/_$/, '')}"?${NL}`)
    })
  }
  await sleep(30)
}

if (shape === 'gemini' && authError) {
  // The runtime refuses to start under an enforced type it cannot satisfy.
  process.stderr.write(authError + NL)
  process.exit(1)
}

/*
 * A runtime that could not load the fence it was given, and says so on stderr —
 * then carries on as if nothing happened, with every tool allowed. That is what
 * the real Gemini CLI does with a malformed or missing admin policy, and the
 * adapter must never accept the answer that follows.
 */
if (mode === 'policy-error') {
  // Keep running: a turn that exited here would fail for the wrong reason.
  setInterval(() => {}, 1 << 30)
}

if (mode.startsWith('sandbox-')) {
  const tool = mode === 'sandbox-read' ? 'Read' : 'Bash'
  process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'sandbox-tool',name:tool,input:{command:mode === 'sandbox-own-bwrap' ? '/usr/bin/bwrap --unshare-net -- /bin/true' : 'true'}}]}})+NL)
  const text = mode === 'sandbox-error-array' ? 'Exit code 1\nbwrap: bind mount failed: symlink' : 'bwrap: bind mount failed: symlink'
  const content = mode === 'sandbox-error-array' ? [{type:'text',text}] : text
  const event=JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'sandbox-tool',is_error:mode!=='sandbox-success',content}]}})+NL
  // Exercise line buffering across chunks.
  process.stdout.write(event.slice(0,20))
  await new Promise(resolve=>setTimeout(resolve,10))
  process.stdout.write(event.slice(20))
}
if (mode === 'sandbox-error' || mode === 'sandbox-error-array') {
  setInterval(() => {}, 1 << 30)
} else if (mode === 'slow') {
  process.stdout.write('starting' + NL)
  setInterval(() => {}, 1 << 30)
} else if (mode === 'stdout-rate-limit' || mode === 'stdout-quota') {
  const detail = mode === 'stdout-quota' ? 'usage limit reached' : 'HTTP 429 rate limit; retry-after 30s'
  // Each runtime reports a provider fault in its own shape; the adapter is what
  // turns either into the same classified failure.
  process.stdout.write(shape === 'gemini'
    ? JSON.stringify({ type: 'result', status: 'error', error: { type: 'ApiError', message: detail }, stats: {} }) + NL
    : JSON.stringify({ type: 'result', is_error: true, result: detail }) + NL)
  process.exit(1)
} else if (mode === 'oauth-expired' && received.credentials !== 'fresh') {
  if (process.env.AGENT_ROTATE_CREDENTIALS === '1') {
    fs.mkdirSync(path.dirname(credentialFile), { recursive: true })
    fs.writeFileSync(credentialFile + '.tmp', 'fresh')
    fs.renameSync(credentialFile + '.tmp', credentialFile)
  }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'authentication_failed: Failed to authenticate: OAuth session expired and could not be refreshed' }) + NL)
  process.exit(1)
} else if (mode === 'runtime-error') {
  // A failed RUN, not a bad answer: the runtime itself could not proceed.
  process.stderr.write('fake-agent: credential rejected by provider' + NL)
  process.exit(3)
} else {
  // Real prompts name the contract they require; honour it so an engine-level
  // test exercises the workflow rather than protocol repair.
  const contract = (prompt.match(/`(triageResult|handoff|authorArtifact|reviewResult|closureConfirmation)`/) ?? [])[1]
  const payload = {
    triageResult: { fit: true, issuePresent: true, reasoning: 'reproduced', acceptanceCriteria: [{ id: 'AC1', statement: 'it works', verifiable: true }], autonomy: { verdict: 'autonomous', reason: 'one run can finish it' } },
    handoff: { targetRole: 'author', prompt: 'Do the work.', rationale: 'because' },
    authorArtifact: { summary: 'the change', basedOnRevision: (prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], resolves: [] },
    reviewResult: { verdict: 'approved', artifactRevision: (prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], findings: [] },
    closureConfirmation: { satisfied: true, revision: (prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], criteria: [{ id: 'AC1', met: true, evidence: 'read it' }], reasoning: 'ok' }
  }[contract] ?? { ok: true, echoed: received.model }

  /*
   * Gemini's stream (v0.60.0): an init event carrying the session it opened, the
   * prompt echoed back, tool calls as `tool_use` {tool_name, tool_id, parameters}
   * answered by `tool_result` {tool_id, status, error?}, then the answer as
   * DELTAS — one event per chunk — and a final result that holds the run's
   * status and token stats but not the text.
   */
  const geminiTool = (name, parameters, outcome) => {
    const id = `${name}-${crypto.randomUUID().slice(0, 8)}`
    process.stdout.write(JSON.stringify({ type: 'tool_use', timestamp: new Date().toISOString(), tool_name: name, tool_id: id, parameters }) + NL)
    process.stdout.write(JSON.stringify({ type: 'tool_result', timestamp: new Date().toISOString(), tool_id: id, ...outcome }) + NL)
  }
  const denyMessageFor = (tool) => {
    // The deny message the adapter's own policy carries for this tool, so a
    // refusal is attributable to the fence that was handed over.
    // MCP-scoped and argument-scoped rules never apply to a plain builtin call
    // made with no arguments, exactly as in the runtime; they are left out here.
    const blocks = (received.adminPolicy ?? '').split('[[rule]]').slice(1).filter((block) => !/^(mcpName|argsPattern) = /m.test(block))
    const rules = blocks.map((block) => ({
      tools: JSON.parse((/toolName = (.+)/.exec(block)?.[1] ?? '""').replace(/,\s*\]$/, ']')),
      decision: /decision = "(\w+)"/.exec(block)?.[1],
      priority: Number(/priority = (\d+)/.exec(block)?.[1] ?? 0),
      denyMessage: JSON.parse(/denyMessage = (".*")/.exec(block)?.[1] ?? 'null')
    })).filter((rule) => rule.tools === '*' || [].concat(rule.tools).includes(tool))
    const winner = rules.sort((a, b) => b.priority - a.priority)[0]
    return winner?.decision === 'deny' ? winner.denyMessage ?? '' : null
  }
  const denied = (tool) => {
    const message = denyMessageFor(tool)
    return message === null
      ? { status: 'success', output: 'ok' }
      : { status: 'error', error: { type: 'policy_violation', message: `Tool execution denied by policy.${message ? ` ${message}` : ''}` } }
  }
  const geminiTurn = (text) => {
    process.stdout.write(JSON.stringify({ type: 'init', session_id: process.env.AGENT_SESSION_ID ?? sessionId, model: received.model ?? 'auto' }) + NL)
    process.stdout.write(JSON.stringify({ type: 'message', role: 'user', content: prompt }) + NL)
    if (mode === 'breach') {
      // A runtime that ignored the fence: it writes where a read-only role must
      // not, and reports every tool as a success. The live fence check has to
      // be able to FAIL, or its passes mean nothing.
      fs.writeFileSync('protected.txt', 'BREACH')
      geminiTool('write_file', { file_path: path.resolve('protected.txt'), content: 'BREACH' }, { status: 'success', output: 'written' })
      fs.writeFileSync('fence-canary-write.txt', 'BREACH')
      geminiTool('write_file', { file_path: path.resolve('fence-canary-write.txt'), content: 'BREACH' }, { status: 'success', output: 'written' })
      fs.writeFileSync('fence-canary-shell.txt', '')
      geminiTool('run_shell_command', { command: 'touch fence-canary-shell.txt' }, { status: 'success', output: '' })
      geminiTool('exit_plan_mode', {}, { status: 'success', output: 'left plan mode' })
    } else if (mode === 'fence-denied') {
      // A runtime that honoured the fence: every attempt is refused with the
      // policy's own words, and nothing touches the disk.
      geminiTool('write_file', { file_path: path.resolve('protected.txt'), content: 'BREACH' }, denied('write_file'))
      geminiTool('replace', { file_path: path.resolve('fence-canary-write.txt'), old_string: '', new_string: 'BREACH' }, denied('replace'))
      geminiTool('run_shell_command', { command: 'touch fence-canary-shell.txt' }, denied('run_shell_command'))
      geminiTool('exit_plan_mode', {}, denied('exit_plan_mode'))
    } else {
      geminiTool('read_file', { file_path: path.resolve('README.md') }, { status: 'success', output: '' })
    }
    // Split, so an adapter that took only the last delta returns half an answer.
    const half = Math.ceil(text.length / 2)
    for (const chunk of [text.slice(0, half), text.slice(half)]) {
      process.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: chunk, delta: true }) + NL)
    }
    process.stdout.write(JSON.stringify({
      type: 'result',
      status: 'success',
      stats: { total_tokens: 4333, input_tokens: 4311, output_tokens: 22, cached: 4000, input: 311, duration_ms: 12, tool_calls: 1 }
    }) + NL)
  }

  // A runtime that genuinely remembered the earlier turn answers with the word.
  if (process.env.AGENT_RECALL && resumed) {
    const remembered = process.env.AGENT_RECALL
    if (shape === 'gemini') {
      geminiTurn(remembered)
    } else if (shape === 'codex') {
      codexRollout()
      process.stdout.write(JSON.stringify({ type: 'session.created', session_id: sessionId }) + NL)
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: remembered } }) + NL)
      process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: codexUsage() }) + NL)
      const out = flag('-o') ?? flag('--output-last-message')
      if (out) fs.writeFileSync(out, remembered)
    } else {
      if (flag('--output-format') === 'stream-json') process.stdout.write(JSON.stringify(initRecord()) + NL)
      process.stdout.write(JSON.stringify({
        type: 'result', subtype: 'success', is_error: false, result: remembered,
        session_id: sessionId, usage: { input_tokens: 11, output_tokens: 22 }, total_cost_usd: totalCost()
      }) + NL)
    }
    process.exit(0)
  }

  const text = mode === 'malformed'
    ? 'I have thoughts but no structured output.'
    : ['Here is the work.', '```json', JSON.stringify(payload), '```'].join(NL)

  if (shape === 'gemini') {
    geminiTurn(text)
  } else if (shape === 'codex') {
    // JSONL events, session id announced up front, last message to a file.
    codexRollout()
    process.stdout.write(JSON.stringify({ type: 'session.created', session_id: sessionId }) + NL)
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + NL)
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: codexUsage() }) + NL)
    const out = flag('-o') ?? flag('--output-last-message')
    if (out) fs.writeFileSync(out, text)
  } else {
    // stream-json: the events a real turn emits before its result, so an adapter
    // watching for activity has something to see; then the same result record.
    if (flag('--output-format') === 'stream-json') {
      process.stdout.write(JSON.stringify(initRecord()) + NL)
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }) + NL)
      process.stdout.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }) + NL)
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + NL)
    }
    process.stdout.write(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      session_id: sessionId,
      usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000 },
      total_cost_usd: totalCost()
    }) + NL)
  }
  process.exit(0)
}

// Accounting knobs: AGENT_CLI_VERSION puts a claude_code_version on the init
// record (2.1.277+ reports a session running total on resume), AGENT_TOTAL_COST
// overrides total_cost_usd, AGENT_CODEX_USAGE overrides turn.completed.usage.
function initRecord () {
  const init = { type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() }
  if (process.env.AGENT_CLI_VERSION) init.claude_code_version = process.env.AGENT_CLI_VERSION
  return init
}
function totalCost () { return process.env.AGENT_TOTAL_COST ? Number(process.env.AGENT_TOTAL_COST) : 0.0042 }
// Codex reports the THREAD's running total on turn.completed, so a resumed
// turn shows twice the first turn's numbers: each turn used 11 + 22.
function codexUsage () {
  if (process.env.AGENT_CODEX_USAGE) return JSON.parse(process.env.AGENT_CODEX_USAGE)
  return resumed ? { input_tokens: 22, output_tokens: 44 } : { input_tokens: 11, output_tokens: 22 }
}
