import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { CONFIG_ROOT, sandbox, patch, occupySeat, errorMatching } from './helpers.mjs'

export const name = 'loader — resolution and every rejection path'

export default async function (t) {
  t.section('the real configuration resolves')
  const cfg = await loadConfig({ root: CONFIG_ROOT })
  t.ok('no discovery errors', cfg.errors.length === 0, cfg.errors.map((e) => e.message).join('; '))
  t.eq('adapters discovered', cfg.harnesses, ['claude', 'codex', 'gemini'])
  const good = await resolvePlaybook('implementation', { root: CONFIG_ROOT })
  t.ok('implementation resolves', good.ok, errorMatching(good, /./)?.message)
  t.ok('resolved is deeply frozen', Object.isFrozen(good.resolved) && Object.isFrozen(good.resolved.participants.implementer))
  t.ok('carries a config hash', /^sha256:[0-9a-f]{64}$/.test(good.resolved.configHash ?? ''))
  t.eq('wire model resolved', good.resolved.participants.implementer.model.wire, 'claude-opus-5-5')
  t.eq('prompt references resolved', Object.keys(good.resolved.prompts).length, 5)
  t.eq('unoccupied optional seats are omitted', Object.keys(good.resolved.participants).sort(), ['auditor-1', 'coordinator', 'implementer'])
  t.eq('the default seats', Object.fromEntries(Object.entries(good.resolved.participants).sort(([a], [b]) => a.localeCompare(b)).map(([role, p]) => [role, `${p.model.id}/${p.effort}`])), { 'auditor-1': 'gpt-6.1-sol/medium', coordinator: 'opus-5-5/low', implementer: 'opus-5-5/medium' })

  // The implementation playbook occupies auditor-1 by default; tests that need a
  // particular auditor replace it in the sandbox copy, the way an operator would.
  const PLAYBOOK = 'playbooks/implementation.yaml'
  const IMPLEMENTER = '  implementer:\n    model: opus-5-5'
  const withAuditor = (d, seat = '  auditor-1:\n    model: gpt-6-astra') => occupySeat(path.join(d, PLAYBOOK), seat)

  t.section('unverified resolves for preview but is not live-eligible')
  const unverified = await resolvePlaybook('implementation', { root: await sandbox(async (d) => {
    await withAuditor(d)
    await patch(path.join(d, 'roster/gpt-6-astra.yaml'), 'status: verified', 'status: unverified')
  }) })
  t.ok('real verified configuration is live-eligible', good.resolved.liveExecution.eligible)
  t.ok('resolves', unverified.ok)
  t.eq('not live-eligible', unverified.resolved.liveExecution.eligible, false)
  t.ok('names the unverified model', unverified.resolved.liveExecution.blockers.some((b) => b.model === 'gpt-6-astra'))

  t.section('proven effort levels: listed ones resolve, others are refused, and the shape is unchanged')
  {
    // Whatever the real entry declares today (unknown, or the levels a live check
    // proved), this test states its own list, so it holds either way.
    const proven = await sandbox(async (d) => {
      const file = path.join(d, 'roster/gpt-6-astra.yaml')
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/^efforts:.*$/m, 'efforts: [low, high]').replace(/^defaultEffort:.*$/m, 'defaultEffort: ~'))
      await withAuditor(d)
    })
    const listed = await resolvePlaybook('implementation', { root: proven, participants: undefined })
    t.ok('the entry itself still resolves with no effort named', listed.ok, errorMatching(listed, /./)?.message)
    t.eq('and sends none by default (defaultEffort stays null)', listed.resolved.participants['auditor-1'].effort, null)

    await patch(path.join(proven, PLAYBOOK), 'model: gpt-6-astra', 'model: gpt-6-astra\n    effort: high')
    const inList = await resolvePlaybook('implementation', { root: proven })
    t.ok('a listed effort resolves', inList.ok, errorMatching(inList, /./)?.message)
    t.eq('and reaches the participant', inList.resolved.participants['auditor-1'].effort, 'high')

    await patch(path.join(proven, PLAYBOOK), 'effort: high\n  coordinator', 'effort: max\n  coordinator')
    const outside = await resolvePlaybook('implementation', { root: proven })
    t.ok('one outside the list is refused, naming the list', /not supported by gpt-6-astra on harness codex \(supported: low, high\)/.test(errorMatching(outside, /effort/)?.message ?? ''),
      errorMatching(outside, /effort/)?.message)
  }

  t.section('unknown capability vs unsupported capability')
  let r = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    withAuditor(d, '  auditor-1:\n    model: haiku-4-5\n    effort: high')) })
  t.ok('efforts: [] gives "supports no effort setting"', Boolean(errorMatching(r, /supports no effort setting/)),
    errorMatching(r, /effort/)?.message)
  // The premise is stated here rather than read off the real roster, which may
  // by now list the levels a live check proved.
  r = await resolvePlaybook('implementation', { root: await sandbox(async (d) => {
    const roster = path.join(d, 'roster/gpt-6-astra.yaml')
    await fs.writeFile(roster, (await fs.readFile(roster, 'utf8')).replace(/^efforts:.*$/m, 'efforts: ~').replace(/^defaultEffort:.*$/m, 'defaultEffort: ~'))
    await withAuditor(d, '  auditor-1:\n    model: gpt-6-astra\n    effort: high')
  }) })
  t.ok('efforts: null gives "unknown effort levels"', Boolean(errorMatching(r, /unknown effort levels/)),
    errorMatching(r, /effort/)?.message)

  t.section('checks requirement may strengthen, never weaken')
  t.eq('the strategy requirement applies when the playbook names none', good.resolved.checks.requirement, 'optional')
  const checks = (requirement) => sandbox((d) => patch(path.join(d, PLAYBOOK), 'autoClose:\n', `checks:\n  requirement: ${requirement}\nautoClose:\n`))
  r = await resolvePlaybook('implementation', { root: await checks('none') })
  t.ok('optional -> none rejected', Boolean(errorMatching(r, /weakens checks requirement/)))
  r = await resolvePlaybook('implementation', { root: await checks('required') })
  t.ok('optional -> required accepted', r.ok && r.resolved.checks.requirement === 'required')

  t.section('budgets may only tighten')
  r = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, PLAYBOOK), 'maxSteps: 120', 'maxSteps: 999')) })
  t.ok('widening rejected', Boolean(errorMatching(r, /widens maxSteps/)))

  t.section('errors name file and field')
  r = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, PLAYBOOK), IMPLEMENTER, '  implementer:\n    model: no-such-model')) })
  const e = errorMatching(r, /not in the roster/)
  t.ok('unknown model rejected', Boolean(e))
  t.ok('carries source file', Boolean(e?.file?.endsWith(PLAYBOOK)), e?.file)
  t.eq('carries field', e?.field, '/participants/implementer/model')

  t.section('role binding')
  r = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, PLAYBOOK), IMPLEMENTER, '  reviewer:\n    model: opus-5-5')) })
  t.ok('unbound required role rejected', Boolean(errorMatching(r, /role "implementer" is not bound/)))
  t.ok('extra participant rejected', Boolean(errorMatching(r, /"reviewer" is not a role/)))

  t.section('version pinning')
  r = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, PLAYBOOK), 'strategyVersion: 1', 'strategyVersion: 2')) })
  t.ok('stale pin rejected', Boolean(errorMatching(r, /pinned strategyVersion/)))

  t.section('overrides are allow-listed')
  const override = (line) => sandbox((d) => patch(path.join(d, PLAYBOOK), 'autoClose:\n', `overrides:\n  ${line}\nautoClose:\n`))
  r = await resolvePlaybook('implementation', { root: await override('completion.delivery.action: merge') })
  t.ok('non-allow-listed path rejected', Boolean(errorMatching(r, /is not an overridable path/)))
  r = await resolvePlaybook('implementation', { root: await override('no-such-phase.maxRounds: 1') })
  t.ok('unknown phase rejected', Boolean(errorMatching(r, /unknown phase/)))
  const tight = await resolvePlaybook('implementation', { root: await override('implement-review.maxRounds: 2') })
  t.ok('allowed override resolves', tight.ok, errorMatching(tight, /./)?.message)
  t.eq('allowed override applied', tight.resolved.phases.find((p) => p.id === 'implement-review').loop.maxRounds, 2)
  t.eq('source strategy unmutated', cfg.strategies.get('implementation').phases.find((p) => p.id === 'implement-review').loop.maxRounds, 5)

  t.section('missing prompt template')
  r = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    fs.rm(path.join(d, 'strategy-templates/implementation/prompts/confirm.md'))) })
  t.ok('missing prompt rejected', Boolean(errorMatching(r, /prompt "confirm\.md".*not found/)))

  t.section('autoClose authority')
  t.eq('reference playbook closes on review agreement', good.resolved.autoClose.minimumVerification, 'review-only')
  t.eq('explicitly authorised by the playbook', good.resolved.autoClose.source, 'playbook')
  t.ok('opt-in carries a justification', Boolean(good.resolved.autoClose.justification))
}
