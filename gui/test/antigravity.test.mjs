import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as agy from '../../harness/antigravity.mjs'
import { classifyFailure } from '../server/runtime/failure.mjs'
import { harnessRefusal } from '../server/runtime/confinement-policy.mjs'
import { loadConfig, CONFIG_ROOT } from '../server/config/load.mjs'

export const name = 'antigravity adapter — the agy CLI under the login\'s own plan: sessions, settings, what it refuses'

const NL = String.fromCharCode(10)
const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakes', 'cli', 'agy.mjs')

export default async function (t) {
  const saved = Object.fromEntries(['DEVPANEL_ANTIGRAVITY_BIN', 'DEVPANEL_ANTIGRAVITY_TOKEN', 'DEVPANEL_TOKEN', 'GOOGLE_API_KEY'].map((k) => [k, process.env[k]]))
  const temps = []
  const temp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-')); temps.push(d); return d }
  /** Point the adapter at the fake, in a mode, recording what it was invoked with. */
  async function underTest ({ mode = 'ok', record = null, extra = [] } = {}) {
    const shim = path.join(await temp(), 'agy')
    await fs.writeFile(shim, ['#!/bin/sh', `export AGENT_MODE='${mode}'`, record ? `export AGENT_RECORD='${record}'` : '', ...extra, `exec "${process.execPath}" "${AGENT}" "$@"`].join(NL) + NL)
    await fs.chmod(shim, 0o755)
    process.env.DEVPANEL_ANTIGRAVITY_BIN = shim
  }
  const readRecord = async (file) => (await fs.readFile(file, 'utf8')).split(NL).filter(Boolean).map((l) => JSON.parse(l))
  const thrown = async (work) => { try { await work(); return null } catch (error) { return error } }
  const token = path.join(await temp(), 'antigravity-oauth-token')
  await fs.writeFile(token, 'the-login-token')
  process.env.DEVPANEL_ANTIGRAVITY_TOKEN = token

  t.section('1. what the adapter says of itself')
  t.eq('a session is discovered, resumable, with efforts', [agy.id, agy.capabilities.sessionAssignment, agy.capabilities.resume, agy.capabilities.effort], ['antigravity', 'discover', true, true])
  t.eq('the effort is part of the model id the CLI knows', [agy.wireModel('gemini-4-neon', 'high'), agy.wireModel('gemini-4-neon', null)], ['gemini-4-neon-high', 'gemini-4-neon-medium'])
  const config = await loadConfig({ root: CONFIG_ROOT })
  t.ok('the configuration loads it as a harness', config.harnesses.includes('antigravity'), config.harnesses.join(','))
  t.ok('its roster entries name it, with their efforts', ['gemini-4-neon-antigravity', 'gemini-4-argon-antigravity'].every((id) => config.roster.get(id)?.harness === 'antigravity' && config.roster.get(id).efforts.includes('high')), [...config.roster.keys()].filter((k) => /antigravity/.test(k)).join(','))
  t.ok('a host without the seat fence refuses it for every seat', /antigravity seats are refused/.test(harnessRefusal('antigravity', { platform: { id: 'darwin', bubblewrap: false } }) ?? '') && harnessRefusal('antigravity', { platform: { id: 'linux', bubblewrap: true } }) === null)

  t.section('2. a turn outside a fence: no tools, a home of its own')
  {
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    process.env.DEVPANEL_TOKEN = 'panel-token'
    process.env.GOOGLE_API_KEY = 'ambient-key'
    const cwd = await temp()
    const ledgerDir = await temp()
    const turn = await agy.invoke({ prompt: 'Say ok.', instructions: 'You are a careful seat.', marker: 'devpanel:m1', model: 'gemini-4-neon', effort: 'high', cwd, ledgerDir, supervisorOnly: true, readOnlyTools: true, hygiene: true, tooling: { writesCode: false, allowedRoots: [cwd] }, meta: { invocationId: 'inv-1' } })
    const seen = (await readRecord(record))[0]
    t.eq('print mode on standard streams, the model with its effort, slash commands off', [seen.argv.slice(0, 5), seen.model, seen.argv.includes('--disable-slash-commands')], [['--print=', '--input-format', 'stream-json', '--output-format', 'stream-json'], 'gemini-4-neon-high', true])
    t.eq('the prompt arrives as one event on stdin: instructions, prompt, marker', [seen.stdinLines, seen.prompt], [1, `You are a careful seat.${NL}${NL}Say ok.${NL}${NL}[devpanel:m1]`])
    t.ok('never as an argument', !seen.argv.some((a) => a.includes('Say ok.')))
    t.eq('the session runs as the seat\'s own agent', seen.argv[seen.argv.indexOf('--agent') + 1], 'devpanel-seat')
    const config = path.join(seen.home, '.gemini', 'config')
    const agent = await fs.readFile(path.join(config, 'agents', 'devpanel-seat.md'), 'utf8')
    const hooks = JSON.parse(await fs.readFile(path.join(config, 'hooks.json'), 'utf8'))
    t.ok('which, for a turn without tools, declares none and is no subagent', /^tools: \[\]$/m.test(agent) && /^subagent: false$/m.test(agent) && /^commandExecutionPolicy: off$/m.test(agent), agent.slice(0, 300))
    const hook = hooks['devpanel-tool-gate'].PreToolUse[0]
    t.eq('and a gate before every tool call that is told the home and names nothing it would let through', [hook.matcher, hook.hooks[0].command.endsWith(`devpanel-tool-gate.mjs ${seen.home}`)], ['*', true])
    t.eq('the session settings ask before every tool and deny them all', [seen.settings.toolPermission, seen.settings.allowNonWorkspaceAccess, seen.settings.permissions.allow, seen.settings.permissions.deny.includes('read_file(*)') && seen.settings.permissions.deny.includes('command(*)')], ['strict', false, [], true])
    t.eq('no directory is added to a turn without tools, and no access is claimed', [seen.addDirs, turn.diagnostics.access], [[], 'none (fence not proved)'])
    t.eq('the CLI lives in a home of its own beside the ledger, not the service user\'s', seen.home, path.join(ledgerDir, 'antigravity-home'))
    t.eq('where the login\'s token is a link, not a copy', [seen.tokenKind, seen.tokenText], ['link', 'the-login-token'])
    t.eq('that home stays, and the session names it: a later turn resumes the conversation kept there', [await fs.stat(seen.home).then(() => true, () => false), turn.session.home], [true, seen.home])
    await agy.invoke({ prompt: 'probe', model: 'gemini-4-neon', cwd })
    const probe = (await readRecord(record)).at(-1)
    t.ok('a turn nobody can resume (no ledger, no run home) gets a throwaway home, gone with the turn', probe.home.startsWith(os.tmpdir()) && probe.home !== seen.home && !await fs.stat(probe.home).then(() => true, () => false), probe.home)
    t.eq('the updater is off and nothing of the panel or another Google credential reaches it', [seen.autoUpdateOff, seen.devpanelToken, seen.googleKey], ['true', null, null])
    t.eq('the answer, and a session that carries its running totals', [turn.response, turn.outcome, typeof turn.session.id, turn.session.tokenTotals], ['ok' + NL, 'completed', 'string', { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0 }])
    t.eq('usage is tokens only, cached input beside fresh', [turn.usage.provider, turn.usage.tokens, turn.usage.costUsd, turn.usage.tokensBasis], ['google', 1050, null, 'first'])
    t.eq('the ledger ties the finished turn to its invocation', [(await agy.reconcile('inv-1', { ledgerDir })).phase, (await agy.reconcile('inv-1', { ledgerDir })).sessionId], ['completed', turn.session.id])
    delete process.env.DEVPANEL_TOKEN; delete process.env.GOOGLE_API_KEY
  }

  t.section('3. what each kind of seat may do, stated as settings')
  {
    const read = agy.seatSettings({ access: 'read', roots: ['/work/tree', '/work/evidence'], home: '/run/home' })
    t.eq('a read seat may read its roots', [read.toolPermission, read.permissions.allow], ['request-review', ['read_file(/work/tree)', 'read_file(/work/evidence)']])
    t.ok('and nothing else: no command, write, web or MCP, and not its own home, where the token is', ['command(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)', 'read_file(/run/home)'].every((rule) => read.permissions.deny.includes(rule)), read.permissions.deny.join(' '))
    t.eq('reading outside the workspace is never switched on', [read.allowNonWorkspaceAccess, agy.seatSettings({ access: 'none', home: '/h' }).allowNonWorkspaceAccess], [false, false])
    process.env.DEVPANEL_ANTIGRAVITY_BIN = '/opt/agy/bin/agy'
    const manifest = agy.fenceManifest({ binary: '/opt/agy/bin/agy', runHome: '/runs/r1/cli-homes/consultant-3' })
    t.eq('inside the fence: the binary read-only, the run\'s home writable', [manifest.homeBinds, manifest.writable], [[{ path: '/opt/agy/bin/agy', writable: false }], ['/runs/r1/cli-homes/consultant-3']])
    t.eq('and the login\'s token bound read-only into that home', manifest.binds, [{ source: token, target: '/runs/r1/cli-homes/consultant-3/.gemini/antigravity-cli/antigravity-oauth-token', writable: false }])
    t.ok('the workspace directories the CLI would execute from are named for masking', agy.AGENT_DIRS.includes('.agents') && agy.AGENT_DIRS.length === 4)
    t.eq('the seat\'s customizations are bound read-only over themselves', agy.fenceManifest({ binary: '/opt/agy/bin/agy', runHome: '/r', customizations: ['/r/.gemini/config/hooks.json'] }).entries, ['/r/.gemini/config/hooks.json'])

    // The tool allow-list in the seat's own home: the agent's declared tools and the gate before every call.
    const seatHome = await temp()
    const written = await agy.prepareHome({ home: seatHome, access: 'read' })
    const gate = path.join(seatHome, '.gemini', 'config', 'devpanel-tool-gate.mjs')
    t.eq('a read seat\'s home carries the agent, the hook and its gate', written.map((f) => path.relative(seatHome, f)).sort(), ['.gemini/config/agents/devpanel-seat.md', '.gemini/config/devpanel-tool-gate.mjs', '.gemini/config/hooks.json'])
    t.ok('the agent declares the read tools only', /^tools: \[view_file, list_dir, find_by_name, grep_search\]$/m.test(await fs.readFile(path.join(seatHome, '.gemini/config/agents/devpanel-seat.md'), 'utf8')))
    const command = JSON.parse(await fs.readFile(path.join(seatHome, '.gemini/config/hooks.json'), 'utf8'))['devpanel-tool-gate'].PreToolUse[0].hooks[0].command
    t.ok('the gate is told the seat\'s home and lets the reader through under the name the CLI hands a hook, read_file', command.endsWith(`${gate} ${seatHome} view_file list_dir find_by_name grep_search read_file`), command)
    const { spawnSync } = await import('node:child_process')
    const ask = (event, allowed = ['read_file', 'grep_search']) => { const r = spawnSync(process.execPath, [gate, seatHome, ...allowed], { input: event, encoding: 'utf8' }); try { return JSON.parse(r.stdout).decision } catch { return `unparsable: ${r.stdout}` } }
    t.eq('the gate passes an allowed tool on to the permission rules', ask(JSON.stringify({ toolCall: { name: 'read_file', args: { Path: 'a' } } })), 'allow')
    t.eq('and denies any other: web search, a subagent, a scheduled task', ['search_web', 'invoke_subagent', 'schedule', 'run_command'].map((name) => ask(JSON.stringify({ toolCall: { name, args: {} } }))), ['deny', 'deny', 'deny', 'deny'])
    t.eq('a call whose arguments spell an allowed name is still judged by its own', ask(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: '"name":"read_file"' } } })), 'deny')
    t.eq('an allowed reader is still refused the seat\'s own home and the token file, however the path is spelled',
      [path.join(seatHome, '.gemini/antigravity-cli/antigravity-oauth-token'), `${seatHome}/x/../.gemini`, 'somewhere/antigravity-oauth-token'].map((Path) => ask(JSON.stringify({ toolCall: { name: 'read_file', args: { Path } } }))), ['deny', 'deny', 'deny'])
    t.eq('and a search may not be pointed there either', ask(JSON.stringify({ toolCall: { name: 'grep_search', args: { Query: 'token', SearchPath: seatHome } } })), 'deny')
    t.eq('what it cannot read is a denial, and so is every call of a seat without tools', [ask('not json'), ask(JSON.stringify({ toolCall: {} })), ask(JSON.stringify({ toolCall: { name: 'read_file' } }), [])], ['deny', 'deny', 'deny'])
  }

  t.section('4. what it refuses before anything is launched')
  {
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()
    const refusals = [
      ['a seat that writes source', { tooling: { writesCode: true } }, /cannot write source yet/],
      ['a fork of a conversation', { fork: true, session: { id: 'x' } }, /no fork/],
      ['another account, key or endpoint', { credentialRef: 'env:SOME_KEY' }, /only as the service user's own Antigravity login/],
      ['a fenced turn without the run\'s home', { fence: { cwd, writable: [], readOnly: [cwd] } }, /needs the run's home/]
    ]
    for (const [what, options, pattern] of refusals) {
      const error = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd, ...options }))
      t.ok(`${what} is refused, not started`, error?.started === false && pattern.test(error.message), error?.message)
    }
    process.env.DEVPANEL_ANTIGRAVITY_TOKEN = path.join(await temp(), 'absent')
    const signedOut = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd }))
    t.ok('a service user that never signed in is an environment fault naming the file', signedOut?.kind === 'environment-error' && /not signed in/.test(signedOut.message) && signedOut.message.includes('absent'), signedOut?.message)
    process.env.DEVPANEL_ANTIGRAVITY_TOKEN = token
    t.eq('and none of these launched the CLI', await fs.stat(record).then(() => true, () => false), false)
  }

  t.section('5. a resumed conversation: its id goes back in, its usage is the difference')
  {
    const record = path.join(await temp(), 'calls')
    await underTest({ record })
    const cwd = await temp()
    const cliHome = path.join(await temp(), 'cli-homes', 'auditor-2')
    const first = await agy.invoke({ prompt: 'one', model: 'gemini-4-neon', effort: 'low', cwd, cliHome })
    // The stand-in keeps a conversation under its HOME, as the CLI does: the second turn finds it only in the same home.
    const second = await agy.invoke({ prompt: 'two', model: 'gemini-4-neon', effort: 'low', cwd, session: first.session, cliHome: path.join(await temp(), 'another-home') })
    const calls = await readRecord(record)
    t.eq('the seat\'s home in the run is the CLI\'s home, and a resumed turn goes back to the session\'s own', [calls[0].home, calls[1].home, first.session.home], [cliHome, cliHome, cliHome])
    t.eq('the first turn names no conversation, the second the one it was given', [calls[0].conversation, calls[1].conversation], [null, first.session.id])
    t.eq('the second turn is charged what it added, not the conversation', [second.usage.inputTokens, second.usage.outputTokens, second.usage.cacheReadTokens, second.usage.tokensBasis, second.session.tokenTotals.inputTokens], [1000, 50, 300, 'delta', 2000])
  }

  t.section('6. a run that failed is never an answer')
  {
    const cwd = await temp()
    await underTest({ mode: 'runtime-error' })
    const exited = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd }))
    t.ok('a non-zero exit carries the runtime\'s own words', exited?.kind === 'runtime-error' && /agy exited 1/.test(exited.message) && /keyring is locked/.test(exited.stderr), exited?.message)
    await underTest({ mode: 'status-error' })
    const quota = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd }))
    // What the CLI says when the plan's quota runs out has not been seen yet, so nothing here asserts a class for it:
    // the runtime's words are carried on the error, and failure.mjs judges them when they are known.
    t.ok('a result that says ERROR is a failed run, with its error', /agy (ended ERROR|exited 1)/.test(quota?.message ?? '') && /the model refused the request/.test(quota?.stderr ?? ''), `${quota?.message} / ${quota?.stderr}`)
    t.eq('and without telling words it is a runtime failure, never a guess', classifyFailure(quota).class, 'runtime')
    await underTest({ mode: 'no-result' })
    t.ok('a stream that ended without a result is a failed run', /without a result event/.test((await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd })))?.message ?? ''))
    await underTest({ mode: 'settings-ignored' })
    const ignored = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd }))
    t.ok('a turn the runtime ran under other settings than the adapter\'s is refused, its answer unused', ignored?.kind === 'environment-error' && /permission mode "always-proceed" instead of "strict"/.test(ignored.message), ignored?.message)
    await underTest({ mode: 'model-substituted' })
    const other = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', effort: 'high', cwd }))
    t.ok('so is a turn served by another model', other?.kind === 'environment-error' && /gemini-3.8-flash-low instead of gemini-4-neon-high/.test(other.message), other?.message)
    await underTest({ mode: 'slow', extra: ["export AGENT_SLEEP_MS='20000'"] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const cancelled = await thrown(() => agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd, signal: controller.signal, graceMs: 500 }))
    t.eq('cancelling ends the process and is reported as an abort', cancelled?.name, 'AbortError')
    await underTest({ mode: 'tools' })
    const tools = await agy.invoke({ prompt: 'x', model: 'gemini-4-neon', cwd })
    t.eq('every tool the runtime reported is on the turn, with how it ended', tools.diagnostics.toolCalls, [{ name: 'read_file', state: 'DONE' }, { name: 'run_command', state: 'ERROR' }])
  }

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
