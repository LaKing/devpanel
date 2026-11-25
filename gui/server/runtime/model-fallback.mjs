import { connectionKey, preflight } from '../config/preflight.mjs'
import { classifyFailure } from './failure.mjs'

/** Verified alternatives with comparable context, preferring another quota pool. */
export async function fallbackCandidates ({ models, current, excluded = [], allowedModels = null, availability, harnesses = null, coordinator = false }) {
  const original = models.find(m => m.id === current.id)
  const minimumContext = original?.contextWindow ?? 0
  const candidates = []
  for (const model of models) {
    if (allowedModels !== null && !allowedModels.includes(model.id)) continue
    if (model.id === current.id || excluded.includes(model.id) || model.verification?.status !== 'verified') continue
    if (harnesses && !harnesses[model.harness]?.invoke) continue
    if (coordinator && !['claude', 'codex'].includes(model.harness)) continue
    if (minimumContext && (!model.contextWindow || model.contextWindow < minimumContext)) continue
    if (await availability?.check(model.id)) continue
    candidates.push(model)
  }
  return candidates.sort((a, b) => Number(connectionKey(a) === connectionKey(current)) - Number(connectionKey(b) === connectionKey(current)) ||
    Number(b.harness === current.harness) - Number(a.harness === current.harness) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || a.id.localeCompare(b.id))
}

export function createQuotaFallback ({ loadModels, availability, probeFor, root }) {
  return async ({ engine, role, spec }) => {
    // Do not reuse another seat's model: author/auditor independence survives substitution.
    const excluded = [...Object.keys(engine.run.participants).filter(r => r !== role).map(r => engine.participantSpec(r).model.id),
      ...Object.entries(engine.snapshot.participants).filter(([r]) => r !== role).map(([, p]) => p.model.id),
      ...(engine.run.modelSubstitutions ?? []).filter(s => s.role !== role).flatMap(s => [s.from, s.to]),
      ...(engine.run.failures ?? []).filter(f => f.class === 'quota').map(f => f.model)]
    const candidates = await fallbackCandidates({ models: await loadModels(), current: spec.model, excluded, allowedModels: engine.snapshot.fallbackModels ?? null, availability,
      harnesses: engine.harnesses, coordinator: spec.coordinationOnly === true })
    for (const model of candidates) {
      if (engine.controller.signal.aborted) return null
      const replacement = { model: { id: model.id, wire: model.model, harness: model.harness, profile: model.profile ?? 'default',
        endpointRef: model.endpointRef ?? null, credentialRef: model.credentialRef ?? null, account: model.account ?? null,
        verification: model.verification, file: model.file, hash: model.hash, pricing: model.pricing ?? null },
      effort: (model.efforts ?? []).includes(spec.effort) ? spec.effort : model.defaultEffort ?? null }
      const probe = probeFor(engine.harnesses)
      let result
      try {
        result = await preflight({ ...engine.snapshot, participants: { [role]: { ...spec, ...replacement } }, liveExecution: { eligible: true, blockers: [] } },
          { probe, root, projectPath: engine.projectPath, signal: engine.controller.signal })
      } catch (error) { result = { launchReady: false, error: error.message } }
      engine.run.modelFallbackChecks ??= []
      const check = { at: engine.clock.iso(), role, model: model.id, result, usage: probe.spent ?? null }
      engine.run.modelFallbackChecks.push(check)
      if (probe.spent) {
        engine.run.budgets.used.costUsd = (engine.run.budgets.used.costUsd ?? 0) + (probe.spent.costUsd ?? 0)
        engine.run.budgets.used.tokens = (engine.run.budgets.used.tokens ?? 0) + (probe.spent.tokens ?? 0)
      }
      await engine.persist({ type: 'model-fallback-check', ...check })
      if (result.launchReady === true) return { ...replacement, preflight: check }
      const failure = classifyFailure({ message: JSON.stringify(result) })
      if (failure.class === 'quota') await availability?.recordExhausted({ modelId: model.id, harness: model.harness,
        reason: failure.evidence, retryAfterMs: failure.retryAfterMs, runId: engine.runId, role })
    }
    return null
  }
}
