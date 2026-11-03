import fs from 'node:fs/promises'
import path from 'node:path'

import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { cleanupSandboxes, sandbox } from './helpers.mjs'

export const name = 'roster pricing — a price reaches the model, and moves no configuration hash'

const price = (id, input = 2) => [`id: ${id}`, `inputUsdPerMillionTokens: ${input}`, 'outputUsdPerMillionTokens: 10', 'cachedInputUsdPerMillionTokens: 1', 'source: test fixture', 'asOf: 2026-01-01', ''].join('\n')
const MODEL = 'gpt-6.1-sol'

async function write (dir, id, text) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${id}.yaml`), text)
}

export default async function (t) {
  try {
    t.section('the tracked tree ships no price')
    const root = await sandbox()
    const hostDir = path.join(root, 'no-host-config')
    const before = await loadConfig({ root, hostDir })
    t.eq('no roster entry has one', [...before.roster.values()].filter((m) => m.pricing).map((m) => m.id), [])
    t.eq('and the catalogue loads without the directory', before.errors, [])
    const first = await resolvePlaybook('implementation', { root })

    t.section('a price reaches its entry and moves no hash')
    await write(path.join(root, 'roster-pricing'), MODEL, price(MODEL))
    const after = await loadConfig({ root, hostDir })
    t.eq('the rates are on the entry', [after.roster.get(MODEL).pricing.inputUsdPerMillionTokens, after.roster.get(MODEL).pricing.source], [2, 'test fixture'])
    t.eq('the entry\'s hash is its bytes, unchanged', after.roster.get(MODEL).hash, before.roster.get(MODEL).hash)
    const second = await resolvePlaybook('implementation', { root })
    t.ok('the playbook resolves', first.ok && second.ok, JSON.stringify(second.errors ?? null))
    t.eq('with the same configHash', second.resolved?.configHash, first.resolved?.configHash)
    t.ok('and the snapshot does not carry it', !JSON.stringify(second.resolved ?? {}).includes('inputUsdPerMillionTokens'))

    t.section('a host file wins, as in every category')
    await write(path.join(hostDir, 'roster-pricing'), MODEL, price(MODEL, 3))
    const shadowed = await loadConfig({ root, hostDir })
    t.eq('its rate is used', shadowed.roster.get(MODEL).pricing.inputUsdPerMillionTokens, 3)
    t.ok('reported as shadowing the tree', shadowed.shadowed.some((s) => s.category === 'roster-pricing'))

    t.section('a wrong file says so')
    const invalid = await sandbox()
    await write(path.join(invalid, 'roster-pricing'), MODEL, `id: ${MODEL}\ninputUsdPerMillionTokens: 2\noutputUsdPerMillionTokens: 10\n`)
    const refused = await loadConfig({ root: invalid, hostDir: path.join(invalid, 'none') })
    t.eq('a price without its cached rate and source blocks nothing', refused.errors, [])
    t.ok('it is reported', refused.invalidPricing.some((p) => p.file.endsWith(`${MODEL}.yaml`) && p.message), JSON.stringify(refused.invalidPricing))
    t.eq('and reaches no entry', refused.roster.get(MODEL).pricing, undefined)
    const resolving = await resolvePlaybook('implementation', { root: invalid })
    t.ok('the playbook still resolves', resolving.ok, JSON.stringify(resolving.errors ?? null))
    t.eq('with the same configHash', resolving.resolved?.configHash, first.resolved?.configHash)
    await write(path.join(invalid, 'roster-pricing'), MODEL, 'id: [unclosed\n')
    const unreadable = await loadConfig({ root: invalid, hostDir: path.join(invalid, 'none') })
    t.eq('a file that is not YAML is reported the same way', [unreadable.errors, unreadable.invalidPricing.length, unreadable.roster.get(MODEL).pricing], [[], 1, undefined])
    const orphan = await sandbox()
    await write(path.join(orphan, 'roster-pricing'), 'no-such-model', price('no-such-model'))
    const unmatched = await loadConfig({ root: orphan, hostDir: path.join(orphan, 'none') })
    t.eq('a price for no roster id is reported, not an error', [unmatched.unmatchedPricing.map((p) => p.id), unmatched.errors], [['no-such-model'], []])
  } finally {
    await cleanupSandboxes()
  }
}
