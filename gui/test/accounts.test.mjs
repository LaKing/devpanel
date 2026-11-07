import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as claude from '../../harness/claude.mjs'
import * as codex from '../../harness/codex.mjs'
import * as gemini from '../../harness/gemini.mjs'
import { resolveConnection as claudeConnection, accountDir } from '../../harness/claude.mjs'
import { resolveConnection as codexConnection } from '../../harness/codex.mjs'
import { resolveConnection as geminiConnection, accountDir as geminiAccountDir } from '../../harness/gemini.mjs'
import { connectionKey } from '../server/config/preflight.mjs'

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakes', 'cli', 'env-recorder.mjs')
const temps = []

/**
 * Run a real adapter entry point against a CLI that records the environment it
 * was actually spawned with. This is the only thing that proves the account
 * reached the child process: resolveConnection() returning the right env proves
 * only that the function works, not that anybody passed its result on.
 */
async function spawned (adapter, binEnvVar, call, { seed = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-envrec-'))
  temps.push(dir)
  const log = path.join(dir, 'env.jsonl')
  // Seed the ambient credentials the adapter is supposed to clear. Asserting
  // their absence without first putting them there passes whether or not the
  // adapter clears anything — the test would stay green if the deletion were
  // removed, which is exactly the regression it exists to catch.
  const saved = new Map()
  for (const [key, value] of Object.entries({ [binEnvVar]: RECORDER, DEVPANEL_ENV_RECORDER: log, ...seed })) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    await call(adapter, dir).catch((error) => ({ error }))
    const lines = await fs.readFile(log, 'utf8').catch(() => '')
    return lines.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Distinct values, so a leak is identifiable rather than merely present. */
const CLAUDE_AMBIENT = {
  ANTHROPIC_API_KEY: 'sk-ambient-key-must-not-leak',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-ambient-must-not-leak',
  ANTHROPIC_BASE_URL: 'https://ambient.invalid',
  ANTHROPIC_AUTH_TOKEN: 'ambient-auth-must-not-leak'
}
const CODEX_AMBIENT = { OPENAI_API_KEY: 'sk-ambient-openai-must-not-leak' }
const GEMINI_AMBIENT = {
  GEMINI_API_KEY: 'gm-ambient-key-must-not-leak',
  GOOGLE_API_KEY: 'goog-ambient-key-must-not-leak',
  GOOGLE_APPLICATION_CREDENTIALS: '/ambient/service-account-must-not-leak.json',
  GOOGLE_GENAI_USE_VERTEXAI: 'true',
  GOOGLE_CLOUD_PROJECT: 'ambient-project-must-not-leak'
}

export const name = 'accounts — several people, one panel, one login each'

export default async function (t) {
  t.section('1. an account is another person\'s login, not another provider')
  {
    const ana = claudeConnection({ profile: 'default', account: 'ana' })
    t.eq('it resolves without an endpoint or a credential', ana.error, null)
    t.eq('into a config directory of its own', ana.env.CLAUDE_CONFIG_DIR, accountDir('ana'))
    t.ok('named after the person, so they can log into it by hand', /account-ana$/.test(ana.env.CLAUDE_CONFIG_DIR), ana.env.CLAUDE_CONFIG_DIR)
    t.ok('two people never share a directory', accountDir('ana') !== accountDir('bea'))

    // Nothing inheritable survives: an un-logged-in directory must fail as
    // unauthenticated, never quietly succeed as whoever is logged in ambiently
    // and file the work under someone else's name.
    t.eq('no ambient API key leaks in', ana.env.ANTHROPIC_API_KEY, '')
    t.eq('no ambient OAuth token leaks in', ana.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    t.eq('and no provider redirect either', [ana.env.ANTHROPIC_BASE_URL, ana.env.ANTHROPIC_AUTH_TOKEN], [undefined, undefined])
    t.eq('the account is echoed as part of what was applied', ana.applied.account, 'ana')
  }

  t.section('2. an account and a provider are different things and cannot be both')
  {
    for (const [label, conn] of [
      ['a credential', { account: 'ana', credentialRef: 'file:~/key' }],
      ['an endpoint', { account: 'ana', endpointRef: 'file:providers/deepseek.endpoint' }]
    ]) {
      const refused = claudeConnection({ profile: 'deepseek', ...conn })
      t.ok(`naming an account and ${label} is refused`, Boolean(refused.error), refused.error)
      t.ok('saying why the two are different', /never both/.test(refused.error ?? ''), refused.error)
    }
    for (const bad of ['Ana', 'ana/../..', 'a'.repeat(64), '', '-ana']) {
      let refused = null
      try { accountDir(bad) } catch (e) { refused = e.message }
      t.ok(`a name like ${JSON.stringify(bad)} cannot become a path`, Boolean(refused), refused ?? 'accepted')
    }
  }

  t.section('3. the default connection is untouched')
  {
    const before = process.env.CLAUDE_CONFIG_DIR
    const plain = claudeConnection({ profile: 'default' })
    t.eq('no account means the ambient login, exactly as before', plain.env.CLAUDE_CONFIG_DIR, before)
    t.eq('with nothing cleared', plain.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY)
  }

  t.section('4. codex isolates the same way, through its own home')
  {
    const bea = codexConnection({ account: 'bea' })
    t.eq('an account resolves', bea.error, null)
    t.ok('into its own CODEX_HOME', /account-bea$/.test(bea.env.CODEX_HOME ?? ''), bea.env.CODEX_HOME)
    t.eq('with no ambient key inherited', bea.env.OPENAI_API_KEY, undefined)
    t.eq('no account leaves the ambient home alone', codexConnection({}).env.CODEX_HOME, process.env.CODEX_HOME)
    t.ok('and the same clash is refused', Boolean(codexConnection({ account: 'bea', endpointRef: 'x' }).error))
  }

  t.section('5. one person\'s probe cannot vouch for another\'s')
  {
    const base = { harness: 'claude', profile: 'default' }
    t.ok('two accounts are two connections', connectionKey({ ...base, account: 'ana' }) !== connectionKey({ ...base, account: 'bea' }),
      connectionKey({ ...base, account: 'ana' }))
    t.ok('and an account differs from the ambient login', connectionKey({ ...base, account: 'ana' }) !== connectionKey(base))
    t.eq('while the same account is the same connection', connectionKey({ ...base, account: 'ana' }), connectionKey({ ...base, account: 'ana' }))
  }

  t.section('6. the account reaches the process that is actually spawned')
  {
    // The gap this closes: claude's invoke() resolved a connection without ever
    // passing it the account, so a run assigned to one person's login went out
    // under whoever was logged in ambiently — with the requested label intact.
    const runs = await spawned(claude, 'DEVPANEL_CLAUDE_BIN', (a, cwd) =>
      a.invoke({ model: 'claude-opus-5', prompt: 'hi', cwd, account: 'ana', marker: 'm', meta: { invocationId: 'i' } }),
    { seed: CLAUDE_AMBIENT })
    t.ok('invoke spawned something', runs.length > 0, JSON.stringify(runs))
    t.eq('with the account\'s config directory', runs[0]?.CLAUDE_CONFIG_DIR, accountDir('ana'))
    // Each of these was present in the parent environment a moment ago. An
    // un-logged-in directory has to fail as unauthenticated, and it cannot if any
    // of them survives into the child.
    t.eq('the ambient API key is blanked, not inherited', runs[0]?.ANTHROPIC_API_KEY, '')
    t.eq('the ambient OAuth token is gone', runs[0]?.CLAUDE_CODE_OAUTH_TOKEN, null)
    t.eq('and so is any provider redirect', [runs[0]?.ANTHROPIC_BASE_URL, runs[0]?.ANTHROPIC_AUTH_TOKEN], [null, null])

    // The other direction, which is what makes the four assertions above mean
    // something: without an account those same values pass straight through.
    const ambient = await spawned(claude, 'DEVPANEL_CLAUDE_BIN', (a, cwd) =>
      a.invoke({ model: 'claude-opus-5', prompt: 'hi', cwd, marker: 'm', meta: { invocationId: 'i' } }),
    { seed: CLAUDE_AMBIENT })
    t.eq('no account still means the ambient login', ambient[0]?.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR ?? null)
    t.eq('with the ambient credentials untouched', ambient[0]?.ANTHROPIC_API_KEY, CLAUDE_AMBIENT.ANTHROPIC_API_KEY)
    t.eq('including the OAuth token the account path removes', ambient[0]?.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_AMBIENT.CLAUDE_CODE_OAUTH_TOKEN)

    // And the paid probe, which is the path that produces the evidence preflight
    // later approves. It ran under the ambient login while keeping the requested
    // account on its own result.
    const probed = await spawned(claude, 'DEVPANEL_CLAUDE_BIN', (a) =>
      a.probe({ depth: 'model', models: ['claude-opus-5'], account: 'ana' }), { seed: CLAUDE_AMBIENT })
    const calls = probed.filter((r) => !r.argv.includes('--version'))
    t.ok('the probe made a real call', calls.length > 0, JSON.stringify(probed.map((r) => r.argv.slice(0, 2))))
    t.eq('under the account it claims to be proving', calls[0]?.CLAUDE_CONFIG_DIR, accountDir('ana'))
    t.eq('with the ambient credentials cleared there too', [calls[0]?.ANTHROPIC_API_KEY, calls[0]?.CLAUDE_CODE_OAUTH_TOKEN], ['', null])
  }

  t.section('7. codex spawns under its own home too')
  {
    const runs = await spawned(codex, 'DEVPANEL_CODEX_BIN', (a, cwd) =>
      a.invoke({ model: 'gpt-5.6', prompt: 'hi', cwd, account: 'bea', marker: 'm', meta: { invocationId: 'i' } }),
    { seed: CODEX_AMBIENT })
    t.ok('invoke spawned something', runs.length > 0, JSON.stringify(runs))
    t.ok('with the account\'s CODEX_HOME', /account-bea$/.test(runs[0]?.CODEX_HOME ?? ''), runs[0]?.CODEX_HOME)
    t.eq('and the seeded ambient key removed', runs[0]?.OPENAI_API_KEY, null)

    const plain = await spawned(codex, 'DEVPANEL_CODEX_BIN', (a, cwd) =>
      a.invoke({ model: 'gpt-5.6', prompt: 'hi', cwd, marker: 'm', meta: { invocationId: 'i' } }),
    { seed: CODEX_AMBIENT })
    t.eq('while without an account it passes through', plain[0]?.OPENAI_API_KEY, CODEX_AMBIENT.OPENAI_API_KEY)

    const probed = await spawned(codex, 'DEVPANEL_CODEX_BIN', (a) =>
      a.probe({ depth: 'model', models: ['gpt-5.6'], account: 'bea' }), { seed: CODEX_AMBIENT })
    const calls = probed.filter((r) => !r.argv.includes('--version'))
    t.ok('the probe made a real call', calls.length > 0, JSON.stringify(probed.map((r) => r.argv.slice(0, 2))))
    t.ok('under the account it claims to be proving', /account-bea$/.test(calls[0]?.CODEX_HOME ?? ''), calls[0]?.CODEX_HOME)
  }

  t.section('8b. gemini isolates through GEMINI_CLI_HOME, and names the auth method')
  {
    const cyd = geminiConnection({ account: 'cyd' })
    t.eq('an account resolves', cyd.error, null)
    t.ok('into its own gemini home', /account-cyd$/.test(cyd.env.GEMINI_CLI_HOME ?? ''), cyd.env.GEMINI_CLI_HOME)
    // The whole of gemini's state — settings, login, session transcripts — lives
    // under that one directory, so it is the account fence. HOME is not touched:
    // overriding it would move git, npm and ssh configuration as well.
    t.eq('leaving the process HOME alone', cyd.env.HOME, process.env.HOME)
    // An un-logged-in directory has to fail as UNAUTHENTICATED. Clearing the
    // inherited credentials is half of that; naming the method is the other half,
    // or the runtime could still fall back to whatever the host has configured.
    t.eq('the login method is stated, not inferred', cyd.env.GOOGLE_GENAI_USE_GCA, 'true')
    t.eq('and it is a login, not a provider connection', cyd.applied.auth, 'login')
    t.eq('no account leaves the ambient home alone', geminiConnection({}).env.GEMINI_CLI_HOME, process.env.GEMINI_CLI_HOME)
    t.ok('the same account/provider clash is refused', /never both/.test(geminiConnection({ account: 'cyd', credentialRef: 'env:K' }).error ?? ''))
    t.ok('two people never share a directory', geminiAccountDir('cyd') !== geminiAccountDir('dee'))
    t.ok('and one person\'s login is a different connection from another\'s',
      connectionKey({ harness: 'gemini', profile: 'default', account: 'cyd' }) !== connectionKey({ harness: 'gemini', profile: 'default', account: 'dee' }))
  }

  t.section('9. gemini spawns under that home, with nothing inheritable left')
  {
    const runs = await spawned(gemini, 'DEVPANEL_GEMINI_BIN', (a, cwd) =>
      a.invoke({ model: 'gemini-3-pro', prompt: 'hi', cwd, account: 'cyd', marker: 'm', meta: { invocationId: 'i' } }),
    { seed: GEMINI_AMBIENT })
    t.ok('invoke spawned something', runs.length > 0, JSON.stringify(runs))
    t.ok('with the account\'s home', /account-cyd$/.test(runs[0]?.GEMINI_CLI_HOME ?? ''), runs[0]?.GEMINI_CLI_HOME)
    // Each of these was in the parent environment a moment ago. Any survivor
    // would let an un-logged-in directory succeed as somebody else.
    t.eq('the ambient API keys are gone', [runs[0]?.GEMINI_API_KEY, runs[0]?.GOOGLE_API_KEY], [null, null])
    t.eq('the service-account credentials too', runs[0]?.GOOGLE_APPLICATION_CREDENTIALS, null)
    t.eq('and the Vertex routing that would pick another account entirely', [runs[0]?.GOOGLE_GENAI_USE_VERTEXAI, runs[0]?.GOOGLE_CLOUD_PROJECT], [null, null])

    // The contrast that makes those four mean something.
    const ambient = await spawned(gemini, 'DEVPANEL_GEMINI_BIN', (a, cwd) =>
      a.invoke({ model: 'gemini-3-pro', prompt: 'hi', cwd, marker: 'm', meta: { invocationId: 'i' } }),
    { seed: GEMINI_AMBIENT })
    t.eq('without an account they pass straight through', ambient[0]?.GEMINI_API_KEY, GEMINI_AMBIENT.GEMINI_API_KEY)
    t.eq('and the ambient home is untouched', ambient[0]?.GEMINI_CLI_HOME, process.env.GEMINI_CLI_HOME ?? null)

    // The PROBE path, which invoke coverage does not imply: it is the path that
    // produces the evidence preflight later approves, and it was the one both
    // other adapters got wrong — the scaffold kept the requested account label
    // while the call itself went out under the ambient login.
    const probed = await spawned(gemini, 'DEVPANEL_GEMINI_BIN', (a) =>
      a.probe({ depth: 'model', models: ['gemini-3-pro'], account: 'cyd' }), { seed: GEMINI_AMBIENT })
    const calls = probed.filter((r) => !r.argv.includes('--version'))
    t.ok('the probe made a real call', calls.length > 0, JSON.stringify(probed.map((r) => r.argv.slice(0, 2))))
    t.ok('under the account it claims to be proving', /account-cyd$/.test(calls[0]?.GEMINI_CLI_HOME ?? ''), calls[0]?.GEMINI_CLI_HOME)
    t.eq('with the seeded ambient credentials cleared there too', calls[0]?.GEMINI_API_KEY, null)

    // A key-based entry is the other connection kind: the key is named by
    // reference, and the ambient login must not be what answers instead.
    const keyed = await spawned(gemini, 'DEVPANEL_GEMINI_BIN', (a, cwd) =>
      a.invoke({ model: 'gemini-3-pro', prompt: 'hi', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_KEY', marker: 'm', meta: { invocationId: 'i' } }),
    { seed: { ...GEMINI_AMBIENT, DEVPANEL_TEST_GEMINI_KEY: 'sk-the-roster-key' } })
    t.eq('the referenced key is the one used', keyed[0]?.GEMINI_API_KEY, 'sk-the-roster-key')
    t.eq('with the ambient login method cleared', [keyed[0]?.GOOGLE_GENAI_USE_VERTEXAI, keyed[0]?.GOOGLE_API_KEY], [null, null])

    // And an unresolvable reference is an error, never a quiet fallback.
    const unresolvable = await spawned(gemini, 'DEVPANEL_GEMINI_BIN', (a, cwd) =>
      a.invoke({ model: 'gemini-3-pro', prompt: 'hi', cwd, credentialRef: 'env:DEVPANEL_TEST_GEMINI_MISSING', marker: 'm', meta: { invocationId: 'i' } }),
    { seed: GEMINI_AMBIENT })
    t.eq('an unset credential spawns nothing at all', unresolvable.length, 0)
  }

  t.section('10. a conflicting connection never reaches a process at all')
  {
    const runs = await spawned(claude, 'DEVPANEL_CLAUDE_BIN', (a, cwd) =>
      a.invoke({ model: 'claude-opus-5', prompt: 'hi', cwd, account: 'ana', credentialRef: 'file:~/k', profile: 'deepseek', marker: 'm', meta: { invocationId: 'i' } }))
    t.eq('nothing was spawned', runs.length, 0)
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
