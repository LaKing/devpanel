import { createDecisions, loadDecisionProvider } from './index.mjs'
import { createJevOracle, readCredential } from './jev.mjs'
import { createOpenAIOracle } from './openai.mjs'
import { createModelOracle, createRosterModelOracle } from './model-oracle.mjs'

/** What one assessment by a roster model may cost at most, reserved before it is asked. */
export const MODEL_ASK_CEILING_USD = 1

/*
 * The one door every caller goes through to ask the decision provider.
 *
 * It binds the active provider configuration (decisions/<id>.yaml as
 * decisions/active.yaml selects, Jev by default; re-read at every ask so
 * enabling, switching or retuning it needs no restart) to the spending
 * ledger the top-level supervisor owns. There is one writer of that ledger per
 * process, so the ledger is borrowed per ask rather than opened here.
 *
 * It also honours the host's availability store, the one the Model
 * availability page shows, under the id `decision:<provider>`. An operator's
 * hold stops every ask until it ends. A rejected key holds the provider
 * (assumed hold) and a rate limit holds it for the provider's retry-after, so
 * callers stop asking something that is refusing them.
 *
 * `ask()` resolves `{ skipped }` when nothing was asked — the provider is not
 * configured, no ledger is there to account for it, or it is held — and the
 * recorded decision otherwise. Every caller treats a skip exactly like an
 * unavailable provider: it does what it did before decisions existed.
 */

export const decisionAvailabilityId = (providerId) => `decision:${providerId}`

/** The client a provider declares with `kind` (decisions/<id>.yaml); Jev when it declares none. */
const ORACLES = { jev: createJevOracle, openai: createOpenAIOracle, model: createRosterModelOracle }
export function oracleFor (config, options = {}) {
  const create = ORACLES[config.kind ?? 'jev']
  if (!create) throw new Error(`decision provider "${config.id}" declares an unknown kind "${config.kind}"`)
  return create({ ...options, config })
}

export function createAdvisor ({
  spending,
  availability = () => null,
  loadProvider = () => loadDecisionProvider(),
  createOracle = (config) => oracleFor(config),
  createModelAsker = (model, effort) => createModelOracle({ model, effort }),
  clock = { iso: () => new Date().toISOString() }
}) {
  let cached = null
  /** The last ask this advisor made, for the availability page. Not persisted. */
  let lastOutcome = null

  async function decisionsFor () {
    const config = await loadProvider()
    if (!config) return { skipped: 'not-configured' }
    const hold = await availability()?.check(decisionAvailabilityId(config.id))
    if (hold) return { skipped: 'held', hold }
    const gate = spending?.()
    if (!gate?.ledger) return { skipped: 'no-ledger' }
    // One recorder per configuration and ledger, so concurrent asks of the same
    // question in this process share one call.
    if (!cached || cached.hash !== config.hash || cached.ledger !== gate.ledger) {
      cached = {
        hash: config.hash,
        ledger: gate.ledger,
        config,
        decisions: createDecisions({ oracle: createOracle(config), config, ledger: gate.ledger, admit: (a) => (gate.admit ? gate.admit(a) : { ok: true }) })
      }
    }
    return cached
  }

  /** What a refusal means for every other caller on this host. */
  async function holdFor (config, record) {
    const store = availability()
    const failure = record.failure
    if (!store || !failure || record.replayed) return null
    if (failure.class === 'auth') {
      return store.recordExhausted({ modelId: decisionAvailabilityId(config.id), harness: 'decision-provider', reason: `key refused: ${failure.message}` })
    }
    if (failure.class === 'rate-limit' && failure.retryAfterMs != null) {
      return store.recordExhausted({ modelId: decisionAvailabilityId(config.id), harness: 'decision-provider', reason: `rate limited: ${failure.message}`, retryAfterMs: failure.retryAfterMs })
    }
    return null
  }

  return {
    /** The provider configuration in force now, or null. */
    config: async () => (await loadProvider()) ?? null,
    lastOutcome: () => lastOutcome,

    /**
     * The same question put to a roster model instead (decisions/model-oracle.mjs),
     * under the same ledger, admission and availability as the provider. The
     * provider's threshold is the bar, so "confident" means one thing.
     */
    async askModel ({ dir, purpose, subject = null, state, questions, signal = null, model, effort = null, retryUnavailable = false }) {
      const hold = await availability()?.check(model.id)
      if (hold) return { skipped: 'held', hold }
      const gate = spending?.()
      if (!gate?.ledger) return { skipped: 'no-ledger' }
      const base = await loadProvider().catch(() => null)
      const config = { id: `model:${model.id}`, model: `${model.id}${effort ? `@${effort}` : ''}`, threshold: base?.threshold ?? 0.9, pricing: null, maxCallCostUsd: MODEL_ASK_CEILING_USD, hash: null }
      const decisions = createDecisions({ oracle: createModelAsker(model, effort), config, ledger: gate.ledger, admit: (a) => (gate.admit ? gate.admit(a) : { ok: true }) })
      return decisions.ask({ dir, purpose, subject, state, questions, signal, retryUnavailable })
    },

    async ask ({ dir, purpose, subject = null, state, questions, signal = null, retryUnavailable = false }) {
      const bound = await decisionsFor()
      if (bound.skipped) return bound
      const record = await bound.decisions.ask({ dir, purpose, subject, state, questions, signal, retryUnavailable })
      if (!record.replayed) {
        lastOutcome = {
          at: record.recordedAt ?? clock.iso(), purpose, status: record.status, model: record.model ?? null,
          latencyMs: record.latencyMs ?? null, costUsd: record.costUsd ?? null, failure: record.failure ?? null,
          tokens: record.usage ? (Number.isFinite(record.usage.tokens) ? record.usage.tokens : (Number(record.usage.input_tokens) || 0) + (Number(record.usage.output_tokens) || 0)) : null
        }
        try { await holdFor(bound.config, record) } catch (error) { console.warn(`decision provider hold could not be recorded: ${error.message}`) }
      }
      return record
    }
  }
}

/**
 * The decision provider as the Model availability page shows it. Reads the key
 * to say whether it is usable, never what it is.
 */
export async function decisionProviderStatus ({ loadProvider, store, advisors = [], usage = null }) {
  let config
  try { config = await loadProvider() } catch (error) {
    // A broken or missing selection is shown under the provider it names, never as Jev.
    const provider = error.provider ?? 'decisions/active.yaml'
    return [{ id: decisionAvailabilityId(provider), provider, title: provider, configured: false, error: error.message, state: 'unconfigured' }]
  }
  if (!config) return []
  const id = decisionAvailabilityId(config.id)
  const record = (await store.all()).find((r) => r.modelId === id) ?? null
  let credential
  // A roster model is reached through its CLI's own login, not a key the provider names.
  if (config.kind === 'model') credential = { ref: null, ok: true }
  else {
    try { await readCredential(config.credentialRef); credential = { ref: config.credentialRef, ok: true } } catch (error) {
      credential = { ref: config.credentialRef, ok: false, error: error.message }
    }
  }
  const outcomes = advisors.map((a) => a?.lastOutcome?.()).filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1))
  return [{
    id,
    provider: config.id,
    title: config.title ?? config.id,
    kind: config.kind ?? 'jev',
    endpoint: config.endpoint ?? null,
    model: config.model,
    threshold: config.threshold,
    configured: true,
    credential,
    state: record?.active ? 'exhausted' : credential.ok ? 'available' : 'unconfigured',
    record,
    lastOutcome: outcomes[0] ?? null,
    usage: usage ? { today: usage.day?.decisions ?? 0, month: usage.month?.decisions ?? 0 } : null
  }]
}
