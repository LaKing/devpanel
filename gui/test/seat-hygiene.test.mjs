import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as claude from '../../harness/claude.mjs'
import * as codex from '../../harness/codex.mjs'
import { resolveConnection as geminiConnection } from '../../harness/gemini.mjs'
import { childEnvironment } from '../../harness/shared.mjs'
import { resolvePlaybook, FENCE_POLICY, CONFIG_ROOT } from '../server/config/load.mjs'
import { sandbox, cleanupSandboxes } from './helpers.mjs'

export const name = 'seat hygiene (fence.hygiene: 1) — allow-listed environment and stated CLI settings'

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakes', 'cli', 'env-recorder.mjs')
const temps = []

/*
 * Values the panel's own environment may hold and no seat should receive. Seeded
 * before each call: asserting an absence without first planting the value passes
 * whether or not anything filters it.
 */
const FOREIGN = {
  DEVPANEL_TOKEN: 'panel-token-must-not-leak',
  DEVPANEL_TOKEN_FILE: '/must/not/leak',
  SSH_AUTH_SOCK: '/tmp/ssh-agent-must-not-leak',
  APP_DB_URI: 'mongodb://must-not-leak',
  NODE_OPTIONS: '--require /must/not/leak.js'
}

async function spawned (binEnvVar, call, seed = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-hygiene-'))
  temps.push(dir)
  const log = path.join(dir, 'env.jsonl')
  const saved = new Map()
  const set = { [binEnvVar]: RECORDER, DEVPANEL_ENV_RECORDER: log, DEVPANEL_CHILD_ENV_PASS: 'DEVPANEL_ENV_RECORDER', ...FOREIGN, ...seed }
  for (const [key, value] of Object.entries(set)) { saved.set(key, process.env[key]); process.env[key] = value }
  try {
    await call(dir).catch((error) => ({ error }))
    const lines = await fs.readFile(log, 'utf8').catch(() => '')
    return lines.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A run-shaped workspace: worktree, scratch outside it, an evidence root. */
async function workspace (dir) {
  const cwd = path.join(dir, 'worktree'), scratchDir = path.join(dir, 'scratch'), evidence = path.join(dir, 'evidence'), ledgerDir = path.join(dir, 'ledger')
  for (const d of [cwd, scratchDir, evidence, ledgerDir]) await fs.mkdir(d, { recursive: true })
  return { cwd, scratchDir, evidence, ledgerDir }
}

const argAfter = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

export default async function (t) {
  t.section('1. the child environment is an allow-list')
  {
    const source = {
      PATH: '/usr/bin', HOME: '/home/x', LANG: 'C.UTF-8', LC_ALL: 'C', XDG_CACHE_HOME: '/c', TZ: 'UTC',
      ...FOREIGN,
      ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1', OPENAI_API_KEY: 'o', CODEX_HOME: '/codex', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'gg',
      DEVPANEL_CLAUDE_PROFILE_ROOT: '/p', FOO: 'f', BAR_ONE: 'b1', DEVPANEL_CHILD_ENV_PASS: 'FOO,BAR_*'
    }
    const keys = (provider) => Object.keys(childEnvironment(provider, source)).sort()
    const base = ['BAR_ONE', 'FOO', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TZ', 'XDG_CACHE_HOME']
    t.eq('claude keeps ordinary settings, its own provider, and what the pass-list names', keys('claude'), [...base, 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'].sort())
    t.eq('codex keeps its own provider only', keys('codex'), [...base, 'CODEX_HOME', 'OPENAI_API_KEY'].sort())
    t.eq('gemini keeps its own provider only', keys('gemini'), [...base, 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].sort())
    t.ok('no DEVPANEL_* is inherited unless named', !keys('claude').some((k) => k.startsWith('DEVPANEL_')))
    t.ok('the pass-list itself is not handed on', !('DEVPANEL_CHILD_ENV_PASS' in childEnvironment('claude', source)))
  }

  t.section('2. a hygiene Claude worker: stated settings, no inherited environment')
  {
    const records = await spawned('DEVPANEL_CLAUDE_BIN', async (dir) => {
      const w = await workspace(dir)
      return claude.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi', hygiene: true,
        tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence, w.scratchDir] } })
    }, { ANTHROPIC_API_KEY: 'own-provider-kept' })
    const r = records[0]
    t.ok('the CLI was spawned', Boolean(r))
    const argv = r?.argv ?? []
    t.eq('project settings only (CLAUDE.md still loads; the operator\'s user settings do not)', argAfter(argv, '--setting-sources'), 'project')
    t.ok('no connectors or project MCP servers', argv.includes('--strict-mcp-config') && argAfter(argv, '--mcp-config') === '{"mcpServers":{}}')
    t.eq('the tool set is named', argAfter(argv, '--tools'), claude.WORKER_TOOLS.join(','))
    t.eq('the permission mode is stated, not inherited', argAfter(argv, '--permission-mode'), 'acceptEdits')
    const settings = JSON.parse(argAfter(argv, '--settings') ?? '{}')
    t.ok('reads and web access keep today\'s reach under explicit rules', ['Read', 'WebFetch', 'WebSearch'].every((x) => settings.permissions?.allow?.includes(x)), JSON.stringify(settings.permissions?.allow))
    t.eq('the shell runs inside the sandbox without a prompt', settings.sandbox?.autoAllowBashIfSandboxed, true)
    t.ok('the sandbox is still required', settings.sandbox?.failIfUnavailable === true && settings.sandbox?.allowUnsandboxedCommands === false)
    for (const key of Object.keys(FOREIGN)) t.ok(`${key} does not reach the child`, !r.envKeys.includes(key))
    t.eq('the seat\'s own provider credential is the accepted exception', r.ANTHROPIC_API_KEY, 'own-provider-kept')
    t.ok('PATH and HOME are kept', r.envKeys.includes('PATH') && r.envKeys.includes('HOME'))
  }

  t.section('3. a hygiene Claude reviewer keeps its read-only fence')
  {
    const records = await spawned('DEVPANEL_CLAUDE_BIN', async (dir) => {
      const w = await workspace(dir)
      return claude.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi', hygiene: true,
        tooling: { writesCode: false, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence, w.scratchDir] } })
    })
    const settings = JSON.parse(argAfter(records[0]?.argv ?? [], '--settings') ?? '{}')
    t.ok('edits to the worktree are still denied', (settings.permissions?.deny ?? []).some((d) => d.startsWith('Edit(') && d.includes('worktree')), JSON.stringify(settings.permissions?.deny?.slice(0, 3)))
    t.ok('only scratch is writable for its shell', (settings.sandbox?.filesystem?.allowWrite ?? []).length === 1 && settings.sandbox.filesystem.allowWrite[0].endsWith('scratch'))
  }

  t.section('4. without hygiene nothing changes (runs resolved before the policy step)')
  {
    const records = await spawned('DEVPANEL_CLAUDE_BIN', async (dir) => {
      const w = await workspace(dir)
      return claude.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi',
        tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence, w.scratchDir] } })
    })
    const argv = records[0]?.argv ?? []
    t.ok('no stated setting sources', !argv.includes('--setting-sources'))
    t.ok('no tool list', !argv.includes('--tools'))
    t.ok('the environment is inherited as before', records[0]?.envKeys.includes('DEVPANEL_TOKEN'))
  }

  t.section('5. tool-free turns keep their own flags and get the allow-listed environment')
  {
    const records = await spawned('DEVPANEL_CLAUDE_BIN', async (dir) => {
      const w = await workspace(dir)
      return claude.invoke({ model: 'm', cwd: w.cwd, ledgerDir: w.ledgerDir, prompt: 'hi', supervisorOnly: true, hygiene: true })
    })
    const argv = records[0]?.argv ?? []
    t.eq('still tool-free', argAfter(argv, '--tools'), '')
    t.eq('still no setting sources at all', argAfter(argv, '--setting-sources'), '')
    t.ok('no worker permission mode', !argv.includes('--permission-mode'))
    for (const key of Object.keys(FOREIGN)) t.ok(`${key} does not reach the child`, !records[0]?.envKeys.includes(key))
  }

  t.section('6. a hygiene Codex worker ignores the operator\'s config and rules')
  {
    const records = await spawned('DEVPANEL_CODEX_BIN', async (dir) => {
      const w = await workspace(dir)
      return codex.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi', hygiene: true,
        tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence], networkAccess: true } })
    }, { OPENAI_API_KEY: 'own-provider-kept', ANTHROPIC_API_KEY: 'other-provider-must-not-leak' })
    const r = records[0]
    const argv = r?.argv ?? []
    t.ok('user config and rules ignored', argv.includes('--ignore-user-config') && argv.includes('--ignore-rules'))
    const settings = argv.filter((a, i) => argv[i - 1] === '-c')
    t.ok('the worker settings are stated', codex.WORKER_SETTINGS.every((s) => settings.includes(s)), settings.join(' '))
    t.ok('the write fence is unchanged', settings.includes('sandbox_mode="workspace-write"'))
    t.ok('network for infrastructure projects is unchanged (decision 5)', settings.includes('sandbox_workspace_write.network_access=true'))
    for (const key of Object.keys(FOREIGN)) t.ok(`${key} does not reach the child`, !r?.envKeys.includes(key))
    t.eq('another provider\'s key does not reach it', r?.ANTHROPIC_API_KEY, null)
    t.eq('its own provider credential does', r?.OPENAI_API_KEY, 'own-provider-kept')
  }

  t.section('6b. a turn carrying the broker gets exactly the devpanel MCP server, and its tools allowed (Phase 3)')
  {
    // The token lives only in a 0600 file; the adapters are handed its path (AC3).
    const tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-hygiene-token-'))
    temps.push(tokenDir)
    const SENTINEL = 'tok-sentinel-4f1c9e'
    const tokenFile = path.join(tokenDir, 't')
    await fs.writeFile(tokenFile, SENTINEL, { mode: 0o600 })
    const broker = { socket: '/tmp/dpb-x/s', tokenFile, shim: '/opt/devpanel/harness/mcp-devpanel.mjs', node: process.execPath }
    const cRecords = await spawned('DEVPANEL_CLAUDE_BIN', async (dir) => {
      const w = await workspace(dir)
      return claude.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi', hygiene: true, broker,
        tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence, w.scratchDir] } })
    })
    const argv = cRecords[0]?.argv ?? []
    const mcp = JSON.parse(argAfter(argv, '--mcp-config') ?? '{}')
    t.eq('Claude: one strict server, the devpanel shim with the turn\'s socket and token', [argv.includes('--strict-mcp-config'), Object.keys(mcp.mcpServers ?? {}), mcp.mcpServers?.devpanel?.args, mcp.mcpServers?.devpanel?.env],
      [true, ['devpanel'], [broker.shim], { DEVPANEL_BROKER_SOCKET: broker.socket, DEVPANEL_BROKER_TOKEN_FILE: tokenFile }])
    t.ok('Claude: the token itself is nowhere in the argv, only the file that holds it', argv.length > 0 && !argv.join('\0').includes(SENTINEL) && !argv.join('\0').includes('DEVPANEL_BROKER_TOKEN"'), argv.join(' ').slice(0, 300))
    const allow = JSON.parse(argAfter(argv, '--settings') ?? '{}').permissions?.allow ?? []
    t.ok('and its two tools allowed', claude.BROKER_TOOLS.every((x) => allow.includes(x)), JSON.stringify(allow))
    const xRecords = await spawned('DEVPANEL_CODEX_BIN', async (dir) => {
      const w = await workspace(dir)
      return codex.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi', hygiene: true, broker,
        tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence], networkAccess: true } })
    })
    const xs = (xRecords[0]?.argv ?? []).filter((a, i, all) => all[i - 1] === '-c')
    t.ok('Codex: the devpanel server after the emptied table', xs.indexOf('mcp_servers={}') < xs.findIndex((x) => x.startsWith('mcp_servers.devpanel.command=')) && xs.some((x) => x === `mcp_servers.devpanel.args=${JSON.stringify([broker.shim])}`), xs.join(' '))
    t.ok('with its calls approved (approval_policy is never; the broker is the gate)', xs.includes('mcp_servers.devpanel.default_tools_approval_mode="approve"'))
    const xargv = xRecords[0]?.argv ?? []
    t.ok('Codex: the token itself is nowhere in the argv, only the file that holds it', xargv.length > 0 && !xargv.join('\0').includes(SENTINEL) && !xargv.join('\0').includes('DEVPANEL_BROKER_TOKEN=') && xs.some((x) => x.includes(`DEVPANEL_BROKER_TOKEN_FILE=${JSON.stringify(tokenFile)}`)), xs.join(' '))
    for (const [name, adapter, bin] of [['Claude', claude, 'DEVPANEL_CLAUDE_BIN'], ['Codex', codex, 'DEVPANEL_CODEX_BIN']]) {
      let refused = null
      const records = await spawned(bin, async (dir) => {
        const w = await workspace(dir)
        try {
          await adapter.invoke({ model: 'm', cwd: w.cwd, scratchDir: w.scratchDir, ledgerDir: w.ledgerDir, prompt: 'hi', hygiene: true, broker: { socket: broker.socket, token: SENTINEL, shim: broker.shim, node: broker.node },
            tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [w.evidence, w.scratchDir], networkAccess: true } })
        } catch (error) { refused = error }
      })
      t.ok(`${name}: a broker carrying the token instead of a token file is refused before anything is spawned`, refused?.kind === 'configuration-error' && records.length === 0, `${refused?.kind} ${refused?.message} records=${records.length}`)
    }
  }

  t.section('7. Gemini resolves its connection from the allow-list as well')
  {
    const saved = { ...process.env }
    Object.assign(process.env, FOREIGN, { OPENAI_API_KEY: 'other', GEMINI_API_KEY: 'own' })
    try {
      const { env } = geminiConnection({ hygiene: true })
      t.ok('no panel or foreign values', Object.keys(FOREIGN).every((k) => !(k in env)) && !('OPENAI_API_KEY' in env))
      t.eq('its own provider credential is kept', env.GEMINI_API_KEY, 'own')
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  }

  t.section('8. new runs resolve under the policy step, and it is part of their identity')
  {
    const { resolved } = await resolvePlaybook('implementation', { root: CONFIG_ROOT })
    t.eq('the resolved playbook carries the fence policy', resolved.fence, { ...FENCE_POLICY })
    t.eq('hygiene is on for new runs', resolved.fence.hygiene, 1)
  }

  t.section('9. a fenced, isolated run cannot name the live checkout or a forbidden root (R2-5, R3-4; audit I12)')
  {
    const live = await sandbox(async (dir) => { await fs.appendFile(path.join(dir, 'playbooks', 'implementation.yaml'), 'workspace:\n  tooling:\n    allowLiveCheckout: true\n') })
    const r1 = await resolvePlaybook('implementation', { root: live })
    t.eq('allowLiveCheckout is refused at resolution', r1.ok, false)
    t.ok('saying why', r1.errors?.some((e) => /allowLiveCheckout is not available to a fenced, isolated run/.test(e.message)), JSON.stringify(r1.errors))
    const home = await sandbox(async (dir) => { await fs.appendFile(path.join(dir, 'playbooks', 'implementation.yaml'), `workspace:\n  tooling:\n    allowedRoots: ["${os.homedir()}"]\n`) })
    const r2 = await resolvePlaybook('implementation', { root: home })
    t.eq('the home as an allowed root is refused', r2.ok, false)
    t.ok('naming it', r2.errors?.some((e) => /allowedRoots: .* which no run may read/.test(e.message)), JSON.stringify(r2.errors))
    const tools = await sandbox(async (dir) => { await fs.appendFile(path.join(dir, 'playbooks', 'implementation.yaml'), `workspace:\n  tooling:\n    allowedRoots: ["${path.join(CONFIG_ROOT, 'tools', 'releases')}"]\n`) })
    t.eq('the release tooling subtree passes', (await resolvePlaybook('implementation', { root: tools })).ok, true)
    const panel = await sandbox(async (dir) => { await fs.appendFile(path.join(dir, 'playbooks', 'implementation.yaml'), `workspace:\n  tooling:\n    allowedRoots: ["${path.join(CONFIG_ROOT, 'gui')}"]\n`) })
    t.eq('the rest of the panel checkout does not', (await resolvePlaybook('implementation', { root: panel })).ok, false)
    const inPlace = await sandbox(async (dir) => { await fs.appendFile(path.join(dir, 'playbooks', 'implementation.yaml'), 'workspace:\n  isolation: in-place\n  tooling:\n    allowLiveCheckout: true\nchecks:\n  requirement: none\n') })
    const r5 = await resolvePlaybook('implementation', { root: inPlace })
    t.ok('an in-place run may still name the live checkout (namespace partial)', r5.ok || !r5.errors.some((e) => /allowLiveCheckout/.test(e.message)), JSON.stringify(r5.errors))
    await cleanupSandboxes()
  }

  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}
