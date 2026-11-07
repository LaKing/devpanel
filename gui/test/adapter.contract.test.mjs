import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runProcess, terminateGroup, alive } from '../server/runtime/process.mjs'

export const name = 'adapters — contract against controlled subprocesses'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUBBORN = path.join(HERE, 'fakes/cli/stubborn.mjs')
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const NL = String.fromCharCode(10)

const temps = []
async function temp () {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-'))
  temps.push(d)
  return d
}

/**
 * Point a real adapter at a controlled subprocess. The adapter code under test is
 * exactly the code that will drive the installed CLI; only the binary differs.
 */
async function adapterUnderTest (which, { mode = 'ok', shape = which, record = null, version = null } = {}) {
  const mod = await import(`../../harness/${which}.mjs`)
  const shim = path.join(await temp(), 'cli')
  await fs.writeFile(shim, [
    '#!/bin/sh',
    `export AGENT_MODE='${mode}'`,
    `export AGENT_SHAPE='${shape}'`,
    record ? `export AGENT_RECORD='${record}'` : '',
    version ? `export AGENT_VERSION='${version}'` : '',
    `exec "${process.execPath}" "${AGENT}" "$@"`
  ].join(NL) + NL)
  await fs.chmod(shim, 0o755)
  process.env[which === 'claude' ? 'DEVPANEL_CLAUDE_BIN' : 'DEVPANEL_CODEX_BIN'] = shim
  return mod
}

const ledgerPath = (dir, which) => path.join(dir, `${which}-ledger.jsonl`)

const readRecord = async (file) =>
  (await fs.readFile(file, 'utf8')).split(NL).filter(Boolean).map((l) => JSON.parse(l))

/** Abort only once the process tree actually exists, so the test is deterministic. */
async function abortOnceSpawned (controller, pidFile, expected = 2, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const seen = await readRecord(pidFile).catch(() => [])
    if (seen.length >= expected) { controller.abort(); return seen }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`process tree never appeared in ${pidFile}`)
}

export default async function (t) {
  // ============================================================ 1. termination
  t.section('1. cancellation terminates the parent AND descendants')
  {
    const dir = await temp()
    const pidFile = path.join(dir, 'pids')
    const controller = new AbortController()
    const spawnedTree = abortOnceSpawned(controller, pidFile)

    const started = Date.now()
    const run = await runProcess({
      command: process.execPath,
      args: [STUBBORN, 'parent'],
      env: { ...process.env, PID_FILE: pidFile },
      signal: controller.signal,
      graceMs: 300
    })
    const returned = Date.now()
    const pids = await spawnedTree

    t.eq('the runtime spawned a child', pids.length, 2, pids.map((p) => p.role).join(','))
    t.ok('the invocation reports cancellation', run.cancelled)
    t.ok('SIGTERM was ignored, so it escalated', run.termination.escalated, run.termination.method)
    t.ok('the parent is gone', !alive(pids.find((p) => p.role === 'parent').pid))
    t.ok('the CHILD is gone too', !alive(pids.find((p) => p.role === 'child').pid))
    t.ok('termination was confirmed before returning', run.termination.confirmedAt <= returned)
    t.ok('and returning waited out the grace period before escalating', returned - started >= 300,
      `${returned - started}ms`)
  }

  t.section('1b. a deadline abort terminates the same way')
  {
    const dir = await temp()
    const pidFile = path.join(dir, 'pids')
    const controller = new AbortController()
    // A deadline is the same signal, so it carries the same obligation.
    const spawnedTree = abortOnceSpawned(controller, pidFile)
    const run = await runProcess({
      command: process.execPath, args: [STUBBORN, 'parent'],
      env: { ...process.env, PID_FILE: pidFile }, signal: controller.signal, graceMs: 200
    })
    const pids = await spawnedTree
    t.ok('cancelled', run.cancelled)
    t.ok('every pid gone', pids.every((p) => !alive(p.pid)), pids.map((p) => `${p.role}:${alive(p.pid) ? 'ALIVE' : 'gone'}`).join(' '))
  }

  t.section('1c. terminating an already-dead group is not an error')
  {
    const result = await terminateGroup(999999, { graceMs: 50 })
    t.eq('reported as already gone', result.method, 'already-gone')
    t.ok('and confirmed', result.confirmedAt !== null)
  }

  t.section('1d. the adapter surfaces termination proof on cancellation')
  {
    const claude = await adapterUnderTest('claude', { mode: 'slow' })
    const cwd = await temp()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    let thrown = null
    try {
      await claude.invoke({ prompt: 'hello', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:1', signal: controller.signal, graceMs: 250, meta: { invocationId: 'inv-cancel' } })
    } catch (error) { thrown = error }
    t.eq('it aborts', thrown?.name, 'AbortError')
    t.ok('carrying proof the group was terminated', Boolean(thrown?.termination?.confirmedAt))
    const ledger = await readRecord(ledgerPath(cwd + '-ledger', 'claude'))
    t.eq('and the cancellation is on the adapter ledger', ledger.at(-1).phase, 'cancelled')
  }

  // ============================================================ 2. sessions
  t.section('2. Claude PRE-ASSIGNS its session; resume reuses it')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await adapterUnderTest('claude', { record })
    const cwd = await temp()

    const first = await claude.invoke({ prompt: 'first turn', model: 'claude-opus-5', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:a', meta: { invocationId: 'inv-1' } })
    t.ok('a session id came back', Boolean(first.session.id))

    const calls = await readRecord(record)
    t.ok('the id was chosen BEFORE the turn', Boolean(calls[0].received.preassigned), JSON.stringify(calls[0].received.preassigned))
    t.eq('and is the one returned', calls[0].received.preassigned, first.session.id)

    // A restart: a brand-new adapter call carrying only the persisted descriptor.
    const second = await claude.invoke({ session: first.session, prompt: 'second turn', model: 'claude-opus-5', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:b', meta: { invocationId: 'inv-2' } })
    const after = await readRecord(record)
    t.eq('the second turn resumed rather than starting fresh', after[1].received.resumed, first.session.id)
    t.eq('no new session was assigned', after[1].received.preassigned, null)
    t.eq('and the same session comes back', second.session.id, first.session.id)
  }

  t.section('supervisor runtime has only the mediated action interface')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await adapterUnderTest('claude', { record })
    await claude.invoke({ prompt: 'Coordinate', model: 'test', cwd: await temp(), supervisorOnly: true })
    const argv = (await readRecord(record))[0].received.argv
    t.eq('built-in tools disabled', argv[argv.indexOf('--tools') + 1], '')
    t.ok('inherited MCP servers disabled', argv.includes('--strict-mcp-config'))
    t.eq('explicit empty MCP config', argv[argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
    t.ok('skills disabled', argv.includes('--disable-slash-commands'))
  }

  t.section('2b. Codex DISCOVERS its session on the first turn')
  {
    const record = path.join(await temp(), 'calls')
    const codex = await adapterUnderTest('codex', { record, shape: 'codex' })
    const cwd = await temp()

    const first = await codex.invoke({ prompt: 'first turn', model: 'gpt-6-astra', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:c', meta: { invocationId: 'inv-3' } })
    const calls = await readRecord(record)
    t.eq('nothing was pre-assigned', calls[0].received.preassigned, null)
    t.ok('yet a session id arrived with the output', Boolean(first.session.id))
    t.eq('matching what the runtime reported', first.session.id, calls[0].sessionId)

    const second = await codex.invoke({ session: first.session, prompt: 'again', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:d', meta: { invocationId: 'inv-4' } })
    const after = await readRecord(record)
    t.ok('the resume subcommand carried the id', after[1].received.argv.includes('resume'), after[1].received.argv.slice(0, 4).join(' '))
    t.eq('and the session persists', second.session.id, first.session.id)
  }

  t.section('Codex supervisor restrictions also apply on resume')
  {
    const record = path.join(await temp(), 'calls')
    const codex = await adapterUnderTest('codex', { record })
    const cwd = await temp()
    const first = await codex.invoke({prompt:'Coordinate',model:'gpt-6-astra',cwd,supervisorOnly:true})
    await codex.invoke({prompt:'Continue',session:first.session,model:'gpt-6-astra',cwd,supervisorOnly:true})
    const calls = await readRecord(record)
    for (const [i, call] of calls.entries()) {
      const argv=call.received.argv
      t.ok(`turn ${i+1}: user config ignored`,argv.includes('--ignore-user-config'))
      t.ok(`turn ${i+1}: shell disabled`,argv.includes('features.shell_tool=false') && argv.includes('features.unified_exec=false'))
      t.ok(`turn ${i+1}: writes and approval escalation denied`,argv.includes('sandbox_mode="read-only"') && argv.includes('approval_policy="never"'))
      t.ok(`turn ${i+1}: inherited connectors disabled`,argv.includes('features.apps=false') && argv.includes('features.plugins=false') && argv.includes('mcp_servers={}'))
    }
    t.eq('Codex supervisor resumes discovered session',calls[1].sessionId,first.session.id)
  }

  t.section('2c. the two runtimes really do differ in session assignment')
  {
    const claude = await import('../../harness/claude.mjs')
    const codex = await import('../../harness/codex.mjs')
    t.eq('claude pre-assigns', claude.capabilities.sessionAssignment, 'preassign')
    t.eq('codex discovers', codex.capabilities.sessionAssignment, 'discover')
  }

  // ============================================================ 3. reconcile
  t.section('3. interrupted invocations reconcile only with attributable evidence')
  {
    const claude = await adapterUnderTest('claude')
    const cwd = await temp()

    t.eq('an untouched workspace has no ledger, which is UNCERTAIN not "not started"',
      (await claude.reconcile('inv-x', { ledgerDir: cwd + '-ledger' })).phase, 'uncertain')

    await claude.invoke({ prompt: 'done work', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:e', meta: { invocationId: 'inv-done' } })

    const completed = await claude.reconcile('inv-done', { ledgerDir: cwd + '-ledger' })
    t.eq('a completed invocation is attributable', completed.phase, 'completed')
    t.ok('with its response', completed.response.includes('Here is the work'))
    t.ok('and its session', Boolean(completed.sessionId))

    t.eq('the WORKSPACE is untouched by the ledger', await fs.readdir(cwd), [])

    const other = await claude.reconcile('inv-never-ran', { ledgerDir: cwd + '-ledger' })
    t.eq('an unknown id against a populated ledger is uncertain', other.phase, 'uncertain')
    t.ok('and says why', /cannot be tied/.test(other.reason), other.reason)
  }

  t.section('3b. an interrupted turn is uncertain, never adopted')
  {
    const claude = await adapterUnderTest('claude', { mode: 'slow' })
    const cwd = await temp()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    await claude.invoke({ prompt: 'x', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:f', signal: controller.signal, graceMs: 200, meta: { invocationId: 'inv-cut' } }).catch(() => {})
    const verdict = await claude.reconcile('inv-cut', { ledgerDir: cwd + '-ledger' })
    t.eq('uncertain', verdict.phase, 'uncertain')
    t.ok('naming the recorded phase', /cancelled/.test(verdict.reason), verdict.reason)
  }

  // ============================================================ 4. wire values
  t.section('4. model, effort, instructions and connection reach the runtime')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await adapterUnderTest('claude', { record })
    const cwd = await temp()

    await claude.invoke({
      prompt: 'the turn prompt',
      model: 'claude-fable-5-1',
      effort: 'xhigh',
      instructions: 'You are the auditor.',
      cwd,
      ledgerDir: cwd + '-ledger',
      marker: 'devpanel:run7:inv9',
      meta: { invocationId: 'inv-wire' }
    })

    const got = (await readRecord(record))[0].received
    t.eq('the exact wire model', got.model, 'claude-fable-5-1')
    t.eq('the effort level', got.effort, 'xhigh')
    t.eq('the role instructions', got.instructions, 'You are the auditor.')
    t.eq('the workspace as cwd', got.cwd, await fs.realpath(cwd))
    t.ok('the prompt itself', got.promptHead.includes('the turn prompt'))
    t.ok('and the marker, so a discovered session can be attributed later',
      (await readRecord(record))[0].marker === 'devpanel:run7:inv9')
  }

  t.section('4d. Codex forwards the effort as a config override, fresh and on resume')
  {
    const record = path.join(await temp(), 'calls')
    const codex = await adapterUnderTest('codex', { record })
    const cwd = await temp()

    const first = await codex.invoke({
      prompt: 'x', model: 'gpt-6-astra', effort: 'xhigh', cwd, ledgerDir: cwd + '-ledger',
      marker: 'devpanel:t:e1', meta: { invocationId: 'inv-e1' }
    })
    await codex.invoke({
      session: first.session, prompt: 'y', model: 'gpt-6-astra', effort: 'xhigh', cwd, ledgerDir: cwd + '-ledger',
      marker: 'devpanel:t:e2', meta: { invocationId: 'inv-e2' }
    })
    await codex.invoke({
      prompt: 'z', model: 'gpt-6-astra', effort: null, cwd, ledgerDir: cwd + '-ledger',
      marker: 'devpanel:t:e3', meta: { invocationId: 'inv-e3' }
    })
    // A supervisor turn carries many overrides; the effort must still be found among them.
    await codex.invoke({
      prompt: 'w', model: 'gpt-6-astra', effort: 'low', supervisorOnly: true, cwd, ledgerDir: cwd + '-ledger',
      marker: 'devpanel:t:e4', meta: { invocationId: 'inv-e4' }
    })

    const calls = await readRecord(record)
    const override = (call) => call.received.argv.filter((a, i) => call.received.argv[i - 1] === '-c' && /^model_reasoning_effort=/.test(a))
    t.eq('fresh turn: exactly one override, the requested level', override(calls[0]), ['model_reasoning_effort=xhigh'])
    t.eq('and the shim read it as the effort', calls[0].received.effort, 'xhigh')
    t.eq('resumed turn: the same override again — resume does not inherit it', override(calls[1]), ['model_reasoning_effort=xhigh'])
    t.eq('on the resumed session', calls[1].received.resumed, first.session.id)
    t.eq('no effort: no override at all', override(calls[2]), [])
    t.eq('among the supervisor overrides it is still forwarded', override(calls[3]), ['model_reasoning_effort=low'])
    t.eq('and still read back', calls[3].received.effort, 'low')
  }

  t.section('4b. a provider profile substitutes endpoint and credential')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await adapterUnderTest('claude', { record })
    const cwd = await temp()
    process.env.DEEPSEEK_BASE_URL = 'https://deepseek.example.invalid/v1'
    process.env.DEEPSEEK_AUTH_TOKEN = 'deepseek-secret'

    const viaProfile = await claude.invoke({
      prompt: 'x', model: 'deepseek-flash', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:g',
      profile: 'deepseek', endpointRef: 'env:DEEPSEEK_BASE_URL', credentialRef: 'env:DEEPSEEK_AUTH_TOKEN',
      meta: { invocationId: 'inv-deepseek' }
    })

    const got = (await readRecord(record))[0].received
    t.eq('the endpoint reached the runtime', got.baseUrl, 'https://deepseek.example.invalid/v1')
    t.eq('the credential was supplied', got.authToken, 'present')
    t.eq('and the wire model is the profile\'s', got.model, 'deepseek-flash')
    t.eq('provider usage is attributed to the profile', viaProfile.usage.provider, 'deepseek')
    t.eq('Anthropic price estimates are not recorded as provider billing', viaProfile.usage.costUsd, null)

    // The default profile must NOT inherit it.
    const plain = await temp()
    await claude.invoke({ prompt: 'x', model: 'claude-opus-5', cwd: plain, ledgerDir: plain + '-ledger', marker: 'devpanel:t:h', meta: { invocationId: 'inv-plain' } })
    const second = (await readRecord(record))[1].received
    t.eq('a default-profile turn does not carry the override', second.baseUrl, process.env.ANTHROPIC_BASE_URL ?? null)
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.DEEPSEEK_AUTH_TOKEN
  }

  t.section('4b2. provider files, isolated sessions and fail-closed credentials')
  {
    const cwd = await temp()
    const record = path.join(cwd, 'calls')
    const claude = await adapterUnderTest('claude', { record })
    const endpoint = path.join(cwd, 'endpoint')
    const credential = path.join(cwd, 'credential')
    await fs.writeFile(endpoint, 'https://deepseek.example.invalid/anthropic\n')
    await fs.writeFile(credential, 'fixture-token\n', { mode: 0o600 })
    const connection = { profile: 'deepseek', endpointRef: `file:${endpoint}`, credentialRef: `file:${credential}` }
    const previous = { api: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    process.env.ANTHROPIC_API_KEY = 'fixture-default-account'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-default-oauth'
    try {
      const options = { ...connection, cwd, model: 'deepseek-v4-pro', prompt: 'x' }
      const first = await claude.invoke(options)
      await claude.invoke({ ...options, session: first.session, supervisorOnly: true })
      const calls = await readRecord(record)
      const got = calls[0].received
      t.eq('file endpoint is trimmed and applied', got.baseUrl, 'https://deepseek.example.invalid/anthropic')
      t.eq('file credential is applied', got.authToken, 'present')
      t.eq('default API credential is cleared', got.apiKeyPresent, false)
      t.eq('default OAuth credential is cleared', got.oauthPresent, false)
      t.eq('internal calls are pinned to the selected model', got.subagentModel, 'deepseek-v4-pro')
      t.eq('provider billing remains unknown', first.usage.costUsd, null)
      t.eq('provider usage is attributed to DeepSeek', first.usage.provider, 'deepseek')
      t.eq('resume uses the same provider session directory', calls[1].received.configDir, got.configDir)
      t.eq('resume retains the session', calls[1].received.resumed, first.session.id)
      t.ok('supervisor tools remain disabled', calls[1].received.argv.includes('--tools') && calls[1].received.argv[calls[1].received.argv.indexOf('--tools') + 1] === '')
      t.ok('another profile\'s sessions are separate', claude.resolveConnection({ ...connection, profile: 'other' }).env.CLAUDE_CONFIG_DIR !== got.configDir)
      await fs.writeFile(endpoint, 'https://another.example.invalid/anthropic')
      t.ok('changing endpoint isolates sessions too', claude.resolveConnection(connection).env.CLAUDE_CONFIG_DIR !== got.configDir)
      await fs.rm(credential)
      let failed = false
      try { await claude.invoke(options) } catch (error) { failed = error.kind === 'configuration-error' }
      t.ok('missing credential fails before spawning', failed && (await readRecord(record)).length === 2)
      t.ok('omitted references cannot use the default account', Boolean(claude.resolveConnection({ profile: 'deepseek' }).error))
    } finally {
      for (const [key, value] of [['ANTHROPIC_API_KEY', previous.api], ['CLAUDE_CODE_OAUTH_TOKEN', previous.oauth]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  t.section('4c. usage is captured')
  {
    const claude = await adapterUnderTest('claude')
    const cwd = await temp()
    const result = await claude.invoke({ prompt: 'x', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:i', meta: { invocationId: 'inv-usage' } })
    t.eq('input tokens', result.usage.inputTokens, 11)
    t.eq('output tokens', result.usage.outputTokens, 22)
    t.eq('cache creation tokens kept', result.usage.cacheCreationTokens, 300)
    t.eq('cache read tokens kept', result.usage.cacheReadTokens, 4000)
    t.eq('total for the budget is the provider total, cache included', result.usage.tokens, 4333)
    t.eq('and cost when the runtime reports it', result.usage.costUsd, 0.0042)

    const codex = await adapterUnderTest('codex', { shape: 'codex' })
    const c = await codex.invoke({ prompt: 'x', cwd: await temp(), ledgerDir: await temp(), marker: 'devpanel:t:j', meta: { invocationId: 'inv-usage-2' } })
    t.eq('codex usage too', c.usage.tokens, 33)
  }

  t.section('4c2. running totals on a resumed session are turned into per-invocation usage')
  {
    // Claude 2.1.277+: total_cost_usd is the session's running total.
    const claude = await adapterUnderTest('claude')
    const codex = await adapterUnderTest('codex', { shape: 'codex' })
    const cwd = await temp()
    const withEnv = async (vars, fn) => {
      const saved = {}
      for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v }
      try { return await fn() } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
    }
    const first = await withEnv({ AGENT_CLI_VERSION: '2.1.277', AGENT_TOTAL_COST: '0.50' }, () =>
      claude.invoke({ prompt: 'x', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:c1', meta: { invocationId: 'inv-cum-1' } }))
    t.eq('first invocation: the total is this invocation', [first.usage.costUsd, first.usage.costBasis], [0.5, 'first'])
    t.eq('the descriptor carries the total and the CLI version', [first.session.costTotals, first.session.cliVersion], [{ costUsd: 0.5 }, '2.1.277'])
    const second = await withEnv({ AGENT_CLI_VERSION: '2.1.277', AGENT_TOTAL_COST: '0.80' }, () =>
      claude.invoke({ session: first.session, prompt: 'y', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:c2', meta: { invocationId: 'inv-cum-2' } }))
    t.ok('resumed: only the increase is this invocation', Math.abs(second.usage.costUsd - 0.3) < 1e-9 && second.usage.costBasis === 'delta', JSON.stringify(second.usage))
    t.eq('what the runtime printed is kept alongside', second.usage.costReportedUsd, 0.8)
    t.eq('tokens stay per invocation', second.usage.tokens, 4333)
    const reset = await withEnv({ AGENT_CLI_VERSION: '2.1.277', AGENT_TOTAL_COST: '0.10' }, () =>
      claude.invoke({ session: second.session, prompt: 'z', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:c3', meta: { invocationId: 'inv-cum-3' } }))
    t.eq('a total that went backwards is a fresh total, never a negative cost', [reset.usage.costUsd, reset.usage.costBasis], [0.1, 'reset'])
    // Before 2.1.277 the CLI reported this invocation's cost on every resume.
    const old = await withEnv({ AGENT_CLI_VERSION: '2.1.276', AGENT_TOTAL_COST: '0.80' }, () =>
      claude.invoke({ session: { id: first.session.id, costTotals: { costUsd: 0.5 } }, prompt: 'y', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:c4', meta: { invocationId: 'inv-cum-4' } }))
    t.eq('an older CLI: the reported cost is this invocation\'s', [old.usage.costUsd, old.usage.costBasis], [0.8, 'reported'])
    const unknown = await withEnv({ AGENT_TOTAL_COST: '0.80' }, () =>
      claude.invoke({ session: { id: first.session.id, costTotals: { costUsd: 0.5 } }, prompt: 'y', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:c5', meta: { invocationId: 'inv-cum-5' } }))
    t.eq('no version on the stream: nothing is subtracted', [unknown.usage.costUsd, unknown.usage.costBasis], [0.8, 'reported'])

    // Codex: turn.completed.usage is the thread's running total.
    const codexDirs = [await temp(), await temp(), await temp(), await temp()]
    const c1 = await withEnv({ AGENT_CODEX_USAGE: '{"input_tokens":100,"output_tokens":20,"cached_input_tokens":60}' }, () =>
      codex.invoke({ prompt: 'x', cwd: codexDirs[0], ledgerDir: codexDirs[1], marker: 'devpanel:t:c6', meta: { invocationId: 'inv-cum-6' } }))
    t.eq('first turn: the total is the turn', [c1.usage.tokens, c1.usage.cacheReadTokens, c1.usage.tokensBasis], [120, 60, 'first'])
    const c2 = await withEnv({ AGENT_CODEX_USAGE: '{"input_tokens":250,"output_tokens":45,"cached_input_tokens":200}' }, () =>
      codex.invoke({ session: c1.session, prompt: 'y', cwd: codexDirs[2], ledgerDir: codexDirs[3], marker: 'devpanel:t:c7', meta: { invocationId: 'inv-cum-7' } }))
    t.eq('resumed: the difference is this turn', [c2.usage.inputTokens, c2.usage.outputTokens, c2.usage.cacheReadTokens, c2.usage.tokens, c2.usage.tokensBasis], [150, 25, 140, 175, 'delta'])
    t.eq('and the descriptor now holds the new totals', c2.session.tokenTotals, { inputTokens: 250, outputTokens: 45, cacheReadTokens: 200 })
  }

  t.section('4d. a runtime error is distinguished from malformed agent output')
  {
    const cwd = await temp()
    const failing = await adapterUnderTest('claude', { mode: 'runtime-error' })
    let thrown = null
    try {
      await failing.invoke({ prompt: 'x', cwd, ledgerDir: cwd + '-ledger', marker: 'devpanel:t:k', meta: { invocationId: 'inv-err' } })
    } catch (error) { thrown = error }
    t.eq('the run failure throws', thrown?.name, 'ProcessError')
    t.eq('classified as a runtime error', thrown?.kind, 'runtime-error')
    t.eq('with the exit code', thrown?.code, 3)
    t.ok('and the runtime\'s own message', /credential rejected/.test(thrown?.stderr ?? ''), thrown?.stderr)

    // Malformed AGENT output is a successful run that produced an unusable answer.
    const sloppy = await adapterUnderTest('claude', { mode: 'malformed' })
    const cwd2 = await temp()
    const result = await sloppy.invoke({ prompt: 'x', cwd: cwd2, ledgerDir: cwd2 + '-ledger', marker: 'devpanel:t:l', meta: { invocationId: 'inv-sloppy' } })
    t.eq('it does NOT throw', result.outcome, 'completed')
    t.ok('the response comes back for the engine to judge', result.response.includes('no structured output'))
    t.eq('and the ledger records it as completed', (await readRecord(ledgerPath(cwd2 + '-ledger', 'claude'))).at(-1).phase, 'completed')
  }

  t.section('4e. probe reports the observed CLI version')
  {
    const claude = await adapterUnderTest('claude', { version: 'fake-agent 1.2.3' })
    const p = await claude.probe({ depth: 'installation', models: ['m'] })
    t.eq('installed', p.installation.status, 'installed')
    t.eq('with the version it observed', p.installation.version, 'fake-agent 1.2.3')
    t.eq('authentication is still unproven', p.authentication.status, 'unknown')
  }

  t.section('4f. a missing binary is reported, not thrown')
  {
    process.env.DEVPANEL_CLAUDE_BIN = '/nonexistent/definitely-not-here'
    const claude = await import('../../harness/claude.mjs')
    const p = await claude.probe({ depth: 'installation' })
    t.eq('missing', p.installation.status, 'missing')
    t.ok('with a detail', Boolean(p.installation.detail))
    delete process.env.DEVPANEL_CLAUDE_BIN
  }

  // Adapters mkdir their ledger directory, which is a sibling of the workspace
  // and therefore not itself a tracked temp — remove both.
  await Promise.all(temps.splice(0).flatMap((d) => [
    fs.rm(d, { recursive: true, force: true }).catch(() => {}),
    fs.rm(`${d}-ledger`, { recursive: true, force: true }).catch(() => {})
  ]))
  delete process.env.DEVPANEL_CLAUDE_BIN
  delete process.env.DEVPANEL_CODEX_BIN
}
