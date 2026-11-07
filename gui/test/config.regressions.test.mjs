import fs from 'node:fs/promises'
import path from 'node:path'
import { loadConfig, resolvePlaybook, getValidator, schemaId } from '../server/config/load.mjs'
import { preflight, assertLaunchable } from '../server/config/preflight.mjs'
import { CONFIG_ROOT, sandbox, patch, occupySeat, errorMatching, fakeProbe, asVerified } from './helpers.mjs'

export const name = 'regressions — milestone-2 execution-gating findings'

export default async function (t) {
  t.section('1. unknown access must not pass preflight')
  const { resolved } = await resolvePlaybook('implementation', { root: CONFIG_ROOT })
  const verified = asVerified(resolved)
  const allUnknown = fakeProbe({ authentication: { status: 'unknown' }, modelAccess: { status: 'unknown' } })
  let r = await preflight(verified, { probe: allUnknown })
  t.ok('not launch-ready on unknown evidence', r.launchReady === false)
  t.ok('unknowns are surfaced, not hidden', r.unknowns.length > 0, `${r.unknowns.length} unknown`)
  t.eq('no legacy ok field to misread', r.ok, undefined)
  r = await preflight(verified, { probe: fakeProbe(), depth: 'installation' })
  t.ok('a shallow probe is diagnostic, never launch-ready', r.launchReady === false)
  t.ok('and still reports what it did learn', r.findings.some((f) => f.level === 'installation' && f.status === 'pass'))

  t.section('2. an ineligible configuration must not probe at all')
  let calls = 0
  const counting = async (...a) => { calls++; return fakeProbe()(...a) }
  const { resolved: ineligible } = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, 'roster/opus-5-5.yaml'), 'status: verified', 'status: unverified')) })
  t.eq('fixture really is ineligible', ineligible.liveExecution.eligible, false)
  r = await preflight(ineligible, { probe: counting })
  t.eq('probe never called', calls, 0)
  t.eq('reported as unprobed', r.probed, false)
  t.ok('and not launch-ready', r.launchReady === false)

  t.section('3. probes must not merge distinct provider connections')
  const root = await sandbox((d) =>
    occupySeat(path.join(d, 'playbooks/implementation.yaml'), '  auditor-1:\n    model: deepseek-flash'))
  // Both roster entries are verified; eligibility must not stop the probe.
  const { resolved: mixed } = await resolvePlaybook('implementation', { root })
  t.ok('fixture mixes default and deepseek on one harness',
    Object.values(mixed.participants).some((p) => p.model.profile === 'deepseek') &&
    Object.values(mixed.participants).some((p) => (p.model.profile ?? 'default') === 'default'))

  const seen = []
  const recording = async (harness, opts) => { seen.push({ harness, profile: opts.profile, endpointRef: opts.endpointRef }); return fakeProbe()(harness, opts) }
  await preflight(mixed, { probe: recording })
  t.eq('one probe per connection, not per harness', seen.length, 2)
  t.ok('probe receives the profile', seen.every((s) => typeof s.profile === 'string'), JSON.stringify(seen.map((s) => s.profile)))
  t.ok('the deepseek connection is probed separately', seen.some((s) => s.profile === 'deepseek'))
  t.ok('endpoint reference is passed through', seen.some((s) => s.endpointRef === 'file:providers/deepseek.endpoint'))

  t.section('4. invalid workflow references must be rejected')
  const strategyFile = 'strategy-templates/implementation/strategy.yaml'
  let res = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, strategyFile), '        to: abort\n        outcome: unresolved', '        to: does-not-exist\n        outcome: unresolved')) })
  t.ok('transition to an unknown phase rejected', Boolean(errorMatching(res, /transitions to "does-not-exist"/)),
    errorMatching(res, /transitions/)?.message)

  res = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, strategyFile), '          prompt: implement.md\n', '          promptFrom: steps.triage.output.prompt\n')) })
  t.ok('promptFrom naming a non-handoff step rejected', Boolean(errorMatching(res, /produces "triageResult", not a handoff/)),
    errorMatching(res, /promptFrom|handoff/)?.message)

  res = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, strategyFile), '        - id: implement\n          role: implementer', '        - id: triage\n          role: implementer')) })
  t.ok('duplicate step id rejected', Boolean(errorMatching(res, /duplicate step id/)), errorMatching(res, /duplicate/)?.message)

  res = await resolvePlaybook('implementation', { root: await sandbox((d) =>
    patch(path.join(d, strategyFile), '            - steps.brief-implement.output.prompt', '            - steps.triage.output.noSuchField')) })
  t.ok('context ref to a non-existent output field rejected', Boolean(errorMatching(res, /not a field of the triageResult contract/)),
    errorMatching(res, /field/)?.message)

  t.section('5. schema cache must be keyed by root')
  const strictRoot = await sandbox(async (d) => {
    const file = path.join(d, 'schemas/roster-model.schema.json')
    const schema = JSON.parse(await fs.readFile(file, 'utf8'))
    schema.required = [...schema.required, 'aFieldNoEntryHas']
    await fs.writeFile(file, JSON.stringify(schema, null, 2))
  })
  await loadConfig({ root: CONFIG_ROOT })            // prime the cache with the real root
  const strict = await loadConfig({ root: strictRoot })
  t.ok("the sandbox's own schema is applied", strict.errors.length > 0, `${strict.errors.length} errors`)
  t.ok('error names the sandbox file', strict.errors.every((e) => e.file.startsWith(strictRoot)))
  const real = await loadConfig({ root: CONFIG_ROOT })
  t.eq('the real root is unaffected by the sandbox', real.errors.length, 0)

  t.section('6. a probe answering for a different connection must not vouch for this one')
  // The fixture mixes a default and a deepseek connection on the same harness.
  const swapped = async (harness, opts) => {
    const base = await fakeProbe()(harness, opts)
    return { ...base, connection: { profile: 'someone-else', endpointRef: 'env:OTHER', credentialRef: 'env:OTHER_KEY' } }
  }
  r = await preflight(verified, { probe: swapped })
  t.ok('mismatched profile rejected', r.launchReady === false && r.failures.some((f) => /different connection/.test(f.message)),
    r.failures[0]?.message)
  t.ok('the mismatch is named', r.failures.some((f) => /profile "someone-else"/.test(f.message)))

  const wrongHarness = async (harness, opts) => ({ ...await fakeProbe()(harness, opts), id: 'not-this-harness' })
  r = await preflight(verified, { probe: wrongHarness })
  t.ok('mismatched harness id rejected', r.launchReady === false && r.failures.some((f) => /harness "not-this-harness"/.test(f.message)))

  const noIdentity = async (harness, opts) => {
    const { connection, ...rest } = await fakeProbe()(harness, opts)
    return rest
  }
  r = await preflight(verified, { probe: noIdentity })
  t.ok('missing connection identity rejected', r.launchReady === false && r.failures.some((f) => /malformed/.test(f.message)),
    r.failures[0]?.message)

  const wrongEndpoint = async (harness, opts) => {
    const base = await fakeProbe()(harness, opts)
    return { ...base, connection: { ...base.connection, endpointRef: 'env:SOMETHING_ELSE' } }
  }
  r = await preflight(verified, { probe: wrongEndpoint })
  t.ok('mismatched endpoint reference rejected', r.launchReady === false && r.failures.some((f) => /endpointRef/.test(f.message)))

  t.section('7. probe results are validated before they are interpreted')
  const truthyString = async (harness, opts) => {
    const base = await fakeProbe()(harness, opts)
    return { ...base, capabilities: { ...base.capabilities, resume: 'unknown' } }
  }
  r = await preflight(verified, { probe: truthyString })
  t.ok('a truthy non-boolean capability is rejected, not believed',
    r.launchReady === false && r.failures.some((f) => /malformed/.test(f.message)), r.failures[0]?.message)
  t.ok('it fails at the probe level, before capability interpretation',
    !r.findings.some((f) => f.level === 'capabilities'))

  const bogusKey = async (harness, opts) => {
    const base = await fakeProbe()(harness, opts)
    return { ...base, capabilities: { ...base.capabilities, madeUpCapability: true } }
  }
  r = await preflight(verified, { probe: bogusKey })
  t.ok('an unknown capability key is rejected', r.launchReady === false && r.failures.some((f) => /malformed/.test(f.message)))

  const missingInstallation = async (harness, opts) => {
    const { installation, ...rest } = await fakeProbe()(harness, opts)
    return rest
  }
  r = await preflight(verified, { probe: missingInstallation })
  t.ok('a probe missing a required field is rejected', r.launchReady === false && r.failures.some((f) => /malformed/.test(f.message)))

  const throwing = async () => { throw new Error('cli exploded') }
  r = await preflight(verified, { probe: throwing })
  t.ok('a throwing probe is a probe-level failure', r.launchReady === false && r.failures.some((f) => /probe threw/.test(f.message)))

  t.section('the real adapters satisfy the probe contract')
  for (const h of ['claude', 'codex']) {
    const { probe } = await import(`${CONFIG_ROOT}/harness/${h}.mjs`)
    const result = await probe({ depth: 'installation', models: ['m'], profile: 'default', endpointRef: null, credentialRef: null })
    const validate = (await getValidator(CONFIG_ROOT)).getSchema(schemaId('harness-capabilities'))
    const valid = validate(result)
    t.ok(`${h}: probe output validates against the schema`, valid,
      valid ? '' : validate.errors.map((e) => `${e.instancePath} ${e.message}`).join('; '))
    t.eq(`${h}: echoes the requested profile`, result.connection.profile, 'default')
  }

  t.section('assertLaunchable is the only sanctioned gate')
  const notReady = await preflight(verified, { probe: fakeProbe(), depth: 'installation' })
  let threw = null
  try { assertLaunchable(notReady) } catch (e) { threw = e }
  t.ok('throws when not launch-ready', Boolean(threw))
  t.ok('the reason is in the message', /unproven/.test(threw?.message ?? ''), threw?.message?.split('\n')[1]?.trim())
  threw = null
  try { assertLaunchable(undefined) } catch (e) { threw = e }
  t.ok('throws on a missing result rather than passing it through', Boolean(threw))
  threw = null
  try { assertLaunchable({ launchReady: 'yes' }) } catch (e) { threw = e }
  t.ok('a truthy non-true launchReady is refused', Boolean(threw))
  const ready = await preflight(verified, { probe: fakeProbe() })
  t.eq('returns the result when genuinely ready', assertLaunchable(ready), ready)
}
