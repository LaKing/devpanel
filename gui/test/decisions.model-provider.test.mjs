import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadDecisionProvider, activeDecisionProviderId } from '../server/decisions/index.mjs'
import { createRosterModelOracle } from '../server/decisions/model-oracle.mjs'
import { oracleFor, decisionProviderStatus } from '../server/decisions/advisor.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'decision provider of kind model (a roster model through its CLI) and decisions/ from the host config'

const questions = { gate: { type: 'choice', instructions: 'What next?', criteria: { continue: 'work on it', 'close-issue': 'close it' } } }
const state = { project: 'p', issue: { title: 'Broken export' } }
const reply = '{"answers":{"gate":{"type":"choice","choice":"continue","probabilities":{"continue":0.95,"close-issue":0.05},"confidence":0.95}}}'
const roster = (over = {}) => new Map([['haiku-4-5', { id: 'haiku-4-5', harness: 'fake', model: 'claude-haiku-4-5', efforts: [], verification: { status: 'verified' }, ...over }]])
const fakeAdapter = (calls) => async () => ({ invoke: async (args) => { calls.push(args); return { outcome: 'completed', response: reply, usage: { costUsd: 0.002 } } } })

const MODEL_PROVIDER = 'id: claude\nkind: model\nmodel: haiku-4-5\nthreshold: 0.9\nmaxCallCostUsd: 0.05\n'

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  const before = process.env.DEVPANEL_HOST_CONFIG_DIR
  try {
    // A config root with the tracked decisions/ and schemas/, and a host config beside it.
    const root = await temp('dmp-root-')
    await fs.cp(path.join(CONFIG_ROOT, 'decisions'), path.join(root, 'decisions'), { recursive: true })
    await fs.cp(path.join(CONFIG_ROOT, 'schemas'), path.join(root, 'schemas'), { recursive: true })
    const host = await temp('dmp-host-')
    process.env.DEVPANEL_HOST_CONFIG_DIR = host

    t.section('1. without a host decisions/ the tracked files decide, as before')
    t.eq('Jev by default', (await activeDecisionProviderId({ root })).id, 'jev')
    t.eq('read from the tree', (await loadDecisionProvider({ root }))?.endpoint, 'https://api.typesafe.ai/v1/systemone')

    t.section('2. host-config/decisions/ selects and defines a provider without touching the tree')
    await fs.mkdir(path.join(host, 'decisions'))
    await fs.writeFile(path.join(host, 'decisions', 'active.yaml'), 'provider: claude\n')
    await fs.writeFile(path.join(host, 'decisions', 'claude.yaml'), MODEL_PROVIDER)
    const active = await activeDecisionProviderId({ root })
    t.eq('the host\'s active.yaml is read', active, { id: 'claude', selected: true })
    const config = await loadDecisionProvider({ root })
    t.eq('a model provider needs no endpoint, key or prices', [config?.kind, config?.model], ['model', 'haiku-4-5'])
    t.ok('the tracked active.yaml was never written', !(await fs.stat(path.join(root, 'decisions', 'active.yaml')).then(() => true, () => false)))
    await fs.writeFile(path.join(host, 'decisions', 'jev.yaml'), (await fs.readFile(path.join(root, 'decisions', 'jev.yaml'), 'utf8')).replace('threshold: 0.9', 'threshold: 0.8'))
    t.eq('a host copy shadows the tracked file of the same name', (await loadDecisionProvider({ id: 'jev', root })).threshold, 0.8)

    t.section('3. the schema keeps each kind\'s own fields')
    const invalid = async (text) => { await fs.writeFile(path.join(host, 'decisions', 'claude.yaml'), text); return loadDecisionProvider({ root }).then(() => null, (e) => e.message) }
    t.ok('a model provider naming an endpoint is refused', /invalid/.test(await invalid(MODEL_PROVIDER + 'endpoint: https://x.invalid\n')))
    t.ok('a model provider naming a key is refused', /invalid/.test(await invalid(MODEL_PROVIDER + 'credentialRef: env:X\n')))
    t.ok('an http provider still needs its endpoint', /invalid/.test(await invalid('id: claude\nkind: openai\nmodel: m\nthreshold: 0.9\nmaxCallCostUsd: 0.01\ncredentialRef: env:X\npricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 }\n')))
    t.ok('and may not name an effort', /invalid/.test(await invalid((await fs.readFile(path.join(root, 'decisions', 'jev.yaml'), 'utf8')).replace('id: jev', 'id: claude') + 'effort: low\n')))
    await fs.writeFile(path.join(host, 'decisions', 'claude.yaml'), MODEL_PROVIDER)

    t.section('4. the model provider asks the roster model through its CLI, tool-free')
    const calls = []
    const oracle = createRosterModelOracle({ config, loadRoster: async () => roster(), loadAdapter: fakeAdapter(calls) })
    const answer = await oracle.ask({ state, questions })
    t.eq('the answer is the provider shape', answer.answers.gate.choice, 'continue')
    t.eq('the CLI reported cost is carried', answer.costUsd, 0.002)
    t.eq('the wire model was asked', calls[0]?.model, 'claude-haiku-4-5')
    t.eq('as a tool-free turn', calls[0]?.supervisorOnly, true)
    t.eq('the advisor knows the kind', typeof oracleFor(config).ask, 'function')

    t.section('5. an unknown or unverified roster model is a configuration failure, never charged')
    const fail = async (entries) => createRosterModelOracle({ config, loadRoster: async () => entries, loadAdapter: fakeAdapter([]) }).ask({ state, questions }).then(() => null, (e) => e)
    const missing = await fail(new Map())
    t.eq('missing', [missing?.class, missing?.charged], ['configuration', 'no'])
    const unverified = await fail(roster({ verification: { status: 'unverified' } }))
    t.eq('unverified', [unverified?.class, unverified?.charged], ['configuration', 'no'])

    t.section('6. the availability page shows it as available without a key')
    const store = { all: async () => [] }
    const [status] = await decisionProviderStatus({ loadProvider: () => loadDecisionProvider({ root }), store })
    t.eq('state', status?.state, 'available')
    t.eq('no endpoint is claimed', status?.endpoint, null)
  } finally {
    if (before === undefined) delete process.env.DEVPANEL_HOST_CONFIG_DIR
    else process.env.DEVPANEL_HOST_CONFIG_DIR = before
    for (const d of temps) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}
