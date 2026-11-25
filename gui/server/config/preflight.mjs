import { probeProjectSandbox } from '../runtime/sandbox-probe.mjs'
import { fencePolicy, harnessRefusal } from '../runtime/confinement-policy.mjs'
import { hostPlatform } from '../runtime/platform.mjs'
/*
 * Live-run preflight. Deliberately separate from loading: a preview resolves a
 * playbook without touching a harness, while a live run must establish that the
 * runtimes are there, authenticated, and able to reach the models.
 *
 * Model probes and the project sandbox smoke test are injectable for offline
 * tests. Live project sandbox checks are local and precede paid model probes.
 *
 * There is no `ok` field, on purpose — but removing it does NOT make callers fail
 * closed on its own: `!undefined` is truthy, so any caller branching on a negation
 * would sail straight through. Launching requires POSITIVE evidence and an
 * explicit `launchReady === true`. Use assertLaunchable() rather than testing a
 * field by hand.
 */

import { CONFIG_ROOT, getValidator, schemaId } from './load.mjs'

const LEVELS = ['config', 'fence', 'sandbox', 'probe', 'installation', 'authentication', 'modelAccess', 'capabilities', 'checks']

const finding = (level, status, message, detail = {}) => ({ level, status, message, ...detail })

/**
 * A probe result is only valid for the exact connection it was taken against.
 * Two participants share a probe only if harness, profile, endpoint reference and
 * credential reference all match — otherwise one provider's authentication would
 * vouch for another's.
 */
export function connectionKey (model) {
  // The account is part of the connection's identity: two seats on one provider
  // under different people's logins are two connections, and one probe must not
  // vouch for the other.
  return [model.harness, model.profile ?? 'default', model.endpointRef ?? '', model.credentialRef ?? '', model.account ?? ''].join(' | ')
}

const connectionLabel = (c) =>
  c.profile && c.profile !== 'default' ? `${c.harness}[${c.profile}]` : c.harness

function summarise (findings, extra = {}) {
  const failures = findings.filter((f) => f.status === 'fail')
  const unknowns = findings.filter((f) => f.status === 'unknown')
  return {
    launchReady: failures.length === 0 && unknowns.length === 0,
    findings: findings.slice().sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level)),
    failures,
    unknowns,
    ...extra
  }
}

/**
 * The only sanctioned launch gate. Requires launchReady === true explicitly:
 * removing a field does not by itself make callers fail closed, since `!undefined`
 * is truthy and any caller branching on a negation would sail straight through.
 */
export function assertLaunchable (result) {
  if (result?.launchReady !== true) {
    const why = [
      ...(result?.failures ?? []).map((f) => `fail: ${f.message}`),
      ...(result?.unknowns ?? []).map((f) => `unproven: ${f.message}`)
    ]
    throw new Error(`refusing to launch: preflight is not launch-ready${why.length ? `\n  ${why.join('\n  ')}` : ''}`)
  }
  return result
}

/**
 * @param resolved  output of resolvePlaybook
 * @param probe     async (harnessId, { depth, models, profile, endpointRef, credentialRef, signal }) => capabilities
 * @param depth     installation | authentication | model. Anything shallower than
 *                  'model' cannot be launch-ready: the deeper levels stay unknown.
 * @param signal    aborts the remaining probes. Deep probing costs a call per
 *                  model, so a caller that has given up must be able to stop
 *                  paying for evidence it will not use.
 */
export async function preflight (resolved, { probe, depth = 'model', root = CONFIG_ROOT, signal = null, projectPath = null, sandboxProbe = probeProjectSandbox, platform = hostPlatform(), env = process.env } = {}) {
  const findings = []
  const cancelled = () => signal?.aborted === true

  // 1. Configuration eligibility. An unverified roster entry loads for preview
  //    but must not run live — and there is no reason to probe anything once we
  //    already know the run cannot start.
  if (!resolved.liveExecution.eligible) {
    for (const b of resolved.liveExecution.blockers) {
      findings.push(finding('config', 'fail', b.model ? `${b.role}: model "${b.model}" ${b.reason}` : b.reason,
        { file: b.file, remedy: b.remedy ?? (b.model ? 'verify the roster entry and set verification.status to verified' : 'configure the release target and select a successfully staged release for production') }))
    }
    return summarise(findings, { depth, probed: false })
  }
  // A runnable engine-only playbook (an engine program, config/engine-operations.mjs) has no seat to probe.
  if (resolved.kind === 'engine-only') return summarise([finding('config', 'pass', `engine program ${resolved.engineProgram}: no seat, nothing to probe`)], { depth, probed: false })
  findings.push(finding('config', 'pass', 'every participant model is verified'))

  // What this host may run (confinement-policy.mjs), before anything is
  // probed or spent. Read from the participants themselves, so a caller that
  // bypasses the resolved blockers (a quota fallback) is held to it too.
  const fence = fencePolicy({ platform, env })
  let refusedHere = false
  for (const p of Object.values(resolved.participants)) {
    const reason = harnessRefusal(p.model.harness, { platform })
    if (reason) { findings.push(finding('fence', 'fail', `${p.role}: ${reason}`, { remedy: 'put this seat on a claude or codex model' })); refusedHere = true }
  }
  if (fence.mode === 'refused') { findings.push(finding('fence', 'fail', fence.reason, { remedy: 'opt in: DEVPANEL_UNFENCED=acknowledged bash install-on-osx.sh' })); refusedHere = true }
  if (refusedHere) return summarise(findings, { depth, probed: false })
  if (fence.mode === 'unfenced') findings.push(finding('fence', 'warn', `unfenced: ${fence.reason}; seats run as namespace 0, local checks local-unconfined, tooling commands unconfined`))
  const fenceRecord = fence.mode === 'unfenced' ? { fence: { mode: fence.mode, reason: fence.reason } } : {}

  // Check local sandbox prerequisites before spending any model probes.
  if (projectPath && Object.values(resolved.participants).some(p => p.model.harness === 'claude')) {
    let result
    try { result = await sandboxProbe({ projectPath, allowedRoots: resolved.workspace?.tooling?.allowedRoots ?? [], signal }) }
    catch (error) { result = { status: cancelled() ? 'unknown' : 'fail', message: error.message } }
    if (!['pass','skip','fail','unknown'].includes(result?.status)) result = { status: 'fail', message: 'Sandbox probe returned no valid evidence' }
    findings.push(finding('sandbox', result.status, result.message))
    if (!['pass','skip'].includes(result.status)) return summarise(findings, { depth, probed: false, cancelled: cancelled(), ...fenceRecord })
  }

  // Group by effective connection, never by harness alone.
  const connections = new Map()
  for (const p of Object.values(resolved.participants)) {
    const key = connectionKey(p.model)
    if (!connections.has(key)) {
      connections.set(key, {
        harness: p.model.harness,
        profile: p.model.profile ?? 'default',
        endpointRef: p.model.endpointRef ?? null,
        credentialRef: p.model.credentialRef ?? null,
        account: p.model.account ?? null,
        participants: []
      })
    }
    connections.get(key).participants.push(p)
  }

  for (const conn of connections.values()) {
    const label = connectionLabel(conn)
    // Checked between connections as well as inside the call: the cheapest place
    // to stop paying is before the next call is made.
    if (cancelled()) {
      findings.push(finding('probe', 'unknown', `${label}: not probed — preflight was cancelled`, { connection: label }))
      continue
    }
    const models = [...new Set(conn.participants.map((p) => p.model.wire))]
    let probed
    try {
      probed = await probe(conn.harness, {
        depth,
        models,
        profile: conn.profile,
        endpointRef: conn.endpointRef,
        credentialRef: conn.credentialRef,
        account: conn.account ?? null,
        hygiene: resolved.fence?.hygiene === 1,
        signal
      })
    } catch (error) {
      // A cancelled probe proves nothing; it did not fail to authenticate.
      const status = cancelled() || error.name === 'AbortError' ? 'unknown' : 'fail'
      findings.push(finding('probe', status,
        `${label}: probe ${status === 'unknown' ? 'was cancelled' : 'threw'} — ${error.message}`,
        { connection: label }))
      continue
    }

    // 2a. A probe result is untrusted input until it validates. Without this a
    //     truthy non-boolean (resume: "unknown") reads as a capability.
    const validateProbe = (await getValidator(root)).getSchema(schemaId('harness-capabilities'))
    if (!validateProbe(probed)) {
      const detail = validateProbe.errors.slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
      findings.push(finding('probe', 'fail', `${label}: probe result is malformed — ${detail}`, { connection: label }))
      continue
    }

    // 2b. The result must be for the connection we asked about. A probe that
    //     answers for a different profile, endpoint or credential cannot vouch
    //     for this one.
    const mismatches = []
    if (probed.id !== conn.harness) mismatches.push(`harness "${probed.id}" != "${conn.harness}"`)
    if (probed.connection.profile !== conn.profile) mismatches.push(`profile "${probed.connection.profile}" != "${conn.profile}"`)
    if ((probed.connection.endpointRef ?? null) !== conn.endpointRef) {
      mismatches.push(`endpointRef "${probed.connection.endpointRef ?? null}" != "${conn.endpointRef}"`)
    }
    if ((probed.connection.account ?? null) !== (conn.account ?? null)) {
      // One person's login must never vouch for another's.
      mismatches.push(`account "${probed.connection.account ?? null}" != "${conn.account ?? null}"`)
    }
    if ((probed.connection.credentialRef ?? null) !== conn.credentialRef) {
      mismatches.push(`credentialRef "${probed.connection.credentialRef ?? null}" != "${conn.credentialRef}"`)
    }
    if (mismatches.length) {
      findings.push(finding('probe', 'fail',
        `${label}: probe answered for a different connection — ${mismatches.join(', ')}`, { connection: label }))
      continue
    }
    findings.push(finding('probe', 'pass', `${label}: probe result validates and matches the requested connection`, { connection: label }))

    // 3. Installation. Proves a binary exists and nothing more.
    const install = probed.installation ?? { status: 'error' }
    findings.push(finding('installation', install.status === 'installed' ? 'pass' : 'fail',
      `${label}: ${install.status}${install.version ? ` (${install.version})` : ''}`, { connection: label }))
    if (install.status !== 'installed') continue

    // 4. Authentication, per connection. Unknown is not a pass.
    if (depth === 'installation') {
      findings.push(finding('authentication', 'unknown',
        `${label}: not probed at depth "installation"`, { connection: label }))
    } else {
      const auth = probed.authentication ?? { status: 'unknown' }
      findings.push(finding('authentication',
        auth.status === 'ok' ? 'pass' : auth.status === 'unknown' ? 'unknown' : 'fail',
        `${label}: authentication ${auth.status}${auth.detail ? ` — ${auth.detail}` : ''}`, { connection: label }))
    }

    // 5. Model access, per connection. Authenticating says nothing about a model.
    if (depth !== 'model') {
      findings.push(finding('modelAccess', 'unknown',
        `${label}: not probed at depth "${depth}"`, { connection: label }))
    } else {
      for (const wire of models) {
        const access = probed.modelAccess?.[wire] ?? { status: 'unknown' }
        findings.push(finding('modelAccess',
          access.status === 'ok' ? 'pass' : access.status === 'unknown' ? 'unknown' : 'fail',
          `${label}/${wire}: ${access.status}${access.detail ? ` — ${access.detail}` : ''}`,
          { connection: label, model: wire }))
      }
    }

    // 6. Capabilities this resolved playbook actually depends on.
    const caps = probed.capabilities ?? {}
    if (!caps.resume) {
      findings.push(finding('capabilities', 'fail',
        `${label}: cannot resume a session across invocations, which the run contract requires`, { connection: label }))
    }
    for (const p of conn.participants) {
      if (p.effort != null && !caps.effort) {
        findings.push(finding('capabilities', 'fail',
          `${p.role}: effort "${p.effort}" requested but ${label} does not support effort`, { connection: label }))
      }
    }
    if (!caps.structuredOutput) {
      findings.push(finding('capabilities', 'warn',
        `${label}: no structured output; agent contracts fall back to fenced-JSON extraction and protocol repair`, { connection: label }))
    }
    if (!caps.cancellation) {
      findings.push(finding('capabilities', 'warn', `${label}: invocations cannot be cancelled mid-turn`, { connection: label }))
    }
  }

  // 7. Checks: a 'required' requirement with no mechanism can never be satisfied.
  const req = resolved.checks.requirement
  if (req === 'required' && !resolved.checks.target) {
    findings.push(finding('checks', 'fail',
      'checks are required but no target is configured; this can never be satisfied',
      { remedy: 'add checks.target, or use a strategy whose requirement is optional' }))
  } else if (req !== 'none' && !resolved.checks.target) {
    findings.push(finding('checks', 'warn',
      `checks are "${req}" with no target: results will be "unavailable" and closure evidence will be review-only`))
  } else {
    findings.push(finding('checks', 'pass', `checks requirement "${req}"`))
  }

  // Authority is separate from evidence: say plainly when agreement will not close.
  if (resolved.autoClose.minimumVerification === 'verified' && !resolved.checks.target) {
    findings.push(finding('checks', 'warn',
      'autoClose requires verified evidence but nothing can produce it; this run will reach agreement and stop, unresolved, for a human'))
  }

  return summarise(findings, {
    ...fenceRecord,
    depth,
    probed: true,
    cancelled: cancelled(),
    connections: [...connections.values()].map(connectionLabel)
  })
}
