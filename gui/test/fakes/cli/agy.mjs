#!/usr/bin/env node
/*
 * A controlled stand-in for the Antigravity CLI (`agy`) in print mode, shaped as agy 1.5.16 was seen to behave:
 * one NDJSON prompt on stdin, `init` / `step_update` / `result` events on stdout, the conversation kept under
 * $HOME/.gemini/antigravity-cli, `result.usage` a running total of the conversation.
 *
 * It echoes what it was invoked with into AGENT_RECORD (argv, the session settings, the home and how the token got
 * there, the prompt), so a test can prove those reached the runtime.
 *
 * AGENT_MODE: ok | runtime-error (exit 1, error on stderr) | status-error (a result with status ERROR) |
 *   settings-ignored (init echoes the login's own always-proceed) | model-substituted | no-result | slow | tools
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const NL = String.fromCharCode(10)
const argv = process.argv.slice(2)
const mode = process.env.AGENT_MODE ?? 'ok'
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const emit = (event, payload, extra = {}) => process.stdout.write(JSON.stringify({ event, ...extra, [event]: payload }) + NL)

if (argv.includes('--version')) { process.stdout.write((process.env.AGENT_VERSION ?? '9.9.9') + NL); process.exit(0) }

let stdin = ''
try { stdin = fs.readFileSync(0, 'utf8') } catch { stdin = '' }
const lines = stdin.split(NL).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
const prompt = lines.find((l) => l?.event === 'user')?.message?.content ?? null
let settings = null
try { settings = JSON.parse(flag('--settings') ?? 'null') } catch { settings = 'unparsable' }
const home = process.env.HOME ?? ''
const state = path.join(home, '.gemini', 'antigravity-cli')
const token = path.join(state, 'antigravity-oauth-token')
const tokenKind = (() => { try { return fs.lstatSync(token).isSymbolicLink() ? 'link' : 'file' } catch { return 'missing' } })()
const resumed = flag('--conversation')
const conversation = resumed ?? process.env.AGENT_SESSION_ID ?? crypto.randomUUID()
const turnsFile = path.join(state, 'conversations', `${conversation}.json`)
let turns = 0
try { turns = JSON.parse(fs.readFileSync(turnsFile, 'utf8')).turns } catch { turns = 0 }

if (process.env.AGENT_RECORD) {
  fs.appendFileSync(process.env.AGENT_RECORD, JSON.stringify({
    argv, cwd: process.cwd(), prompt, stdinLines: lines.length, settings, home, tokenKind,
    tokenText: tokenKind === 'missing' ? null : (() => { try { return fs.readFileSync(token, 'utf8') } catch { return null } })(),
    model: flag('--model'), conversation: resumed, addDirs: all('--add-dir'),
    autoUpdateOff: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null, scratch: process.env.DEVPANEL_SCRATCH_DIR ?? null,
    devpanelToken: process.env.DEVPANEL_TOKEN ?? null, googleKey: process.env.GOOGLE_API_KEY ?? null
  }) + NL)
}

if (mode === 'runtime-error') { process.stderr.write('error: failed to retrieve token: secret keyring is locked' + NL); process.exit(1) }
if (mode === 'slow') await sleep(Number(process.env.AGENT_SLEEP_MS ?? 60000))

const model = mode === 'model-substituted' ? 'gemini-3.8-flash-low' : flag('--model')
emit('init', { model, cwd: process.cwd(), tools: ['read_file', 'write_to_file', 'run_command'], permission_mode: mode === 'settings-ignored' ? 'always-proceed' : (settings?.toolPermission ?? 'request-review') }, { conversation_id: conversation })
if (mode === 'tools') {
  emit('step_update', { conversation_id: conversation, step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'note.txt' }, output: '1 lines' } })
  emit('step_update', { conversation_id: conversation, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'id' } } })
}
if (mode === 'no-result') process.exit(0)
turns += 1
fs.mkdirSync(path.dirname(turnsFile), { recursive: true })
fs.writeFileSync(turnsFile, JSON.stringify({ turns }))
const usage = { input_tokens: 1000 * turns, output_tokens: 50 * turns, thinking_tokens: 40 * turns, cache_read_tokens: 300 * (turns - 1), total_tokens: 1050 * turns }
const response = process.env.AGENT_RECALL && resumed ? process.env.AGENT_RECALL : (process.env.AGENT_REPLY ?? 'ok')
emit('step_update', { conversation_id: conversation, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: response })
if (mode === 'status-error') {
  emit('result', { conversation_id: conversation, status: 'ERROR', response: '', error: 'the model refused the request', duration_seconds: 1, num_turns: turns, usage })
  process.exit(1)
}
emit('result', { conversation_id: conversation, status: 'SUCCESS', response: response + NL, duration_seconds: 1.5, num_turns: turns, usage })
