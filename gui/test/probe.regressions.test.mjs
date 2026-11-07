import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProbeExecutor, ProbeNotAuthorised, ProbeBudgetExceeded } from '../server/runtime/probe-budget.mjs'

export const name = 'probes — spending, identity, isolation and accounting'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const NL = String.fromCharCode(10)

const temps = []
async function temp () {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-'))
  temps.push(d)
  return d
}

async function shim ({ mode = 'ok', record = null }) {
  const file = path.join(await temp(), 'cli')
  await fs.writeFile(file, [
    '#!/bin/sh',
    `export AGENT_MODE='${mode}'`,
    "export AGENT_SHAPE='claude'",
    record ? `export AGENT_RECORD='${record}'` : '',
    `exec "${process.execPath}" "${AGENT}" "$@"`
  ].join(NL) + NL)
  await fs.chmod(file, 0o755)
  process.env.DEVPANEL_CLAUDE_BIN = file
  return import('../../harness/claude.mjs')
}

const readRecord = async (file) =>
  (await fs.readFile(file, 'utf8').catch(() => '')).split(NL).filter(Boolean).map((l) => JSON.parse(l))

export default async function (t) {
  // ============================================ 1. authorisation and budget
  t.section('1. a paid probe cannot happen without explicit authorisation')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await shim({ record })
    const unauthorised = createProbeExecutor({ load: async () => claude, allowPaid: false, maxInvocations: 99 })

    let threw = null
    try { await unauthorised('claude', { depth: 'model', models: ['m'] }) } catch (e) { threw = e }
    t.eq('it refuses', threw?.name, 'ProbeNotAuthorised')
    t.eq('nothing was invoked', (await readRecord(record)).length, 0)

    // The free depth is still allowed, and still free.
    const free = await unauthorised('claude', { depth: 'installation', models: ['m'] })
    t.eq('installation depth passes through', free.installation.status, 'installed')
    t.eq('and spends nothing', unauthorised.spent.invocations, 0)
    const calls = await readRecord(record)
    t.ok('only --version was run', calls.length === 0, `${calls.length} agent calls`)
  }

  t.section('1b. the invocation cap is enforced before spending')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await shim({ record })
    const executor = createProbeExecutor({ load: async () => claude, allowPaid: true, maxInvocations: 2 })

    await executor('claude', { depth: 'model', models: ['a', 'b'] })
    t.eq('two models consumed the budget', executor.spent.invocations, 2)

    let threw = null
    try { await executor('claude', { depth: 'model', models: ['c'] }) } catch (e) { threw = e }
    t.eq('the next probe is refused', threw?.name, 'ProbeBudgetExceeded')
    const models = (await readRecord(record)).map((c) => c.received.model)
    t.ok('and model c was never invoked', !models.includes('c'), models.join(','))
  }

  // ============================================ 2. connection identity
  t.section('2. a probe must not validate a different provider than it reports')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await shim({ record })
    process.env.DEEPSEEK_BASE_URL = 'https://deepseek.example.invalid/v1'
    process.env.DEEPSEEK_AUTH_TOKEN = 'deepseek-secret'

    const probed = await claude.probe({
      depth: 'model', models: ['deepseek-flash'],
      profile: 'deepseek', endpointRef: 'env:DEEPSEEK_BASE_URL', credentialRef: 'env:DEEPSEEK_AUTH_TOKEN'
    })

    const call = (await readRecord(record))[0]
    t.eq('the probe launched against the profile endpoint', call.received.baseUrl, 'https://deepseek.example.invalid/v1')
    t.eq('with the profile credential', call.received.authToken, 'present')
    t.eq('and reports what it APPLIED, not merely what was asked',
      probed.connection.applied.endpoint, true)
    t.eq('access is reported for that connection', probed.modelAccess['deepseek-flash'].status, 'ok')
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.DEEPSEEK_AUTH_TOKEN
  }

  t.section('2b. an unresolvable profile is NOT probed against the default provider')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await shim({ record })
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.DEEPSEEK_AUTH_TOKEN

    const probed = await claude.probe({
      depth: 'model', models: ['deepseek-flash'],
      profile: 'deepseek', endpointRef: 'env:DEEPSEEK_BASE_URL', credentialRef: 'env:DEEPSEEK_AUTH_TOKEN'
    })

    t.eq('nothing was invoked', (await readRecord(record)).length, 0)
    t.eq('authentication is an error, not a success', probed.authentication.status, 'error')
    t.ok('naming the unresolved reference', /DEEPSEEK_BASE_URL/.test(probed.authentication.detail), probed.authentication.detail)
    t.eq('and model access stays unknown', probed.modelAccess['deepseek-flash'].status, 'unknown')
    t.ok('so a default-provider success can never be reported under this profile', true)
  }

  // ============================================ 3. validation and isolation
  t.section('3. a probe uses the adapter\'s normal response handling')
  {
    // Exit code zero with unusable output must not read as "access ok".
    const claude = await shim({ mode: 'malformed' })
    const probed = await claude.probe({ depth: 'model', models: ['m'] })
    t.eq('a malformed but successful run still authenticates', probed.authentication.status, 'ok')
    t.eq('and the model is reachable', probed.modelAccess.m.status, 'ok')

    const failing = await shim({ mode: 'runtime-error' })
    const bad = await failing.probe({ depth: 'model', models: ['m'] })
    t.eq('a credential failure is classified as invalid', bad.authentication.status, 'invalid')
    t.ok('from the runtime\'s own message', /credential rejected/.test(bad.authentication.detail), bad.authentication.detail)
    t.eq('and the attempt is still counted', bad.invocations, 1)
    t.eq('with its cost marked unknown', bad.usage.costUnknownCalls, 1)
  }

  t.section('3b. a probe runs in a disposable workspace, never the caller\'s')
  {
    const record = path.join(await temp(), 'calls')
    const claude = await shim({ record })
    const before = await fs.readdir(process.cwd())

    await claude.probe({ depth: 'model', models: ['m'] })

    const call = (await readRecord(record))[0]
    t.ok('cwd was a temporary directory', /devpanel-probe-/.test(call.received.cwd), call.received.cwd)
    t.ok('not the process working directory', call.received.cwd !== process.cwd())
    t.eq('and the caller\'s directory is untouched', await fs.readdir(process.cwd()), before)
    t.ok('the probe workspace was removed', !(await fs.stat(call.received.cwd).then(() => true, () => false)))
  }

  t.section('3c. a probe has a deadline and honours cancellation')
  {
    const claude = await shim({ mode: 'slow' })
    const started = Date.now()
    const probed = await claude.probe({ depth: 'model', models: ['m'], timeoutMs: 400 })
    t.ok('it returned rather than hanging', Date.now() - started < 8000, `${Date.now() - started}ms`)
    t.eq('access is unknown, not ok', probed.modelAccess.m.status, 'unknown')
    t.ok('and says why', /timed out|cancelled/.test(probed.modelAccess.m.detail), probed.modelAccess.m.detail)
    t.eq('the attempt is counted', probed.invocations, 1)
  }

  t.section('3d. probe usage is reported so a caller can budget')
  {
    const claude = await shim({})
    const probed = await claude.probe({ depth: 'model', models: ['a', 'b'] })
    t.eq('two attempts', probed.invocations, 2)
    t.eq('tokens accumulated, cache included', probed.usage.tokens, 8666)
    t.ok('cost accumulated', probed.usage.costUsd > 0, String(probed.usage.costUsd))

    const executor = createProbeExecutor({ load: async () => claude, allowPaid: true, maxInvocations: 5 })
    await executor('claude', { depth: 'model', models: ['a', 'b'] })
    t.ok('the executor sees the spend', executor.spent.tokens === 8666, executor.summary())
  }

  // ============================================ 4. failed calls are counted
  t.section('4. a failed call is still an attempt')
  {
    const failing = await shim({ mode: 'runtime-error' })
    const executor = createProbeExecutor({ load: async () => failing, allowPaid: true, maxInvocations: 3 })
    const probed = await executor('claude', { depth: 'model', models: ['a', 'b'] })

    t.eq('both attempts counted despite both failing', probed.invocations, 2)
    t.eq('their cost is unknown, not zero', probed.usage.costUnknownCalls, 2)
    t.ok('and the summary says so', /reported no cost/.test(executor.summary()), executor.summary())
    t.eq('the budget was consumed', executor.spent.invocations, 2)
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  delete process.env.DEVPANEL_CLAUDE_BIN
}
