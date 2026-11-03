/*
 * What one supervisor model call cost, when the runtime does not say.
 *
 * An estimate is this call's own tokens times the roster-pricing rates, or it is
 * nothing: unknown is not zero, and a number that may hold another invocation's
 * tokens is worse than none. Codex reports the THREAD's running total and the
 * adapter subtracts the totals on the session descriptor (harness/shared.mjs
 * cumulativeDelta), so a delta is one call's usage only when the previous turn on
 * that session left those totals current. That is proved, never assumed:
 * `leavesCleanBaseline` says whether a turn did, and top-supervisor.mjs keeps the
 * answer on `state.ownUsageSession`. A failed or cancelled call, one with missing
 * or partial counters, a counter reset, a changed session id and a fork all leave
 * the next call unknown.
 */

const CUMULATIVE_COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens']
const count = (value) => Number.isInteger(value) && value >= 0

const complete = (usage) => CUMULATIVE_COUNTERS.every((k) => typeof usage?.tokensReported?.[k] === 'number')

/** Whether this call left the session's totals current, so the next call's delta is that call's alone. */
export function leavesCleanBaseline (usage, { priorSessionId = null, sessionId = null } = {}) {
  if (!complete(usage) || usage.tokensBasis === 'reset') return false
  return priorSessionId == null || sessionId === priorSessionId
}

/**
 * @param usage     the adapter's per-invocation usage
 * @param pricing   the model's roster-pricing entry, if it has one
 * @param resumed   the call continued an existing session
 * @param ownUsage  the previous turn left a clean baseline on this same session
 * @param fork      the call ran in a copy of the session
 * @returns {usd, tokens, rates, source, asOf, tokensBasis} or null when it cannot be estimated
 */
export function estimateCallCost (usage, pricing, { resumed = false, ownUsage = false, fork = false } = {}) {
  if (!usage || !pricing || !count(usage.inputTokens) || !count(usage.outputTokens)) return null
  const tokensBasis = usage.tokensBasis ?? null
  if (tokensBasis !== null) {
    if (fork || !complete(usage)) return null
    if (tokensBasis === 'first' ? resumed : (tokensBasis !== 'delta' || !ownUsage)) return null
  }
  const input = usage.inputTokens, output = usage.outputTokens
  const cacheRead = count(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
  const cacheWrite = count(usage.cacheCreationTokens) ? usage.cacheCreationTokens : 0
  if (input + output + cacheRead + cacheWrite === 0) return null
  const rates = {
    input: pricing.inputUsdPerMillionTokens,
    output: pricing.outputUsdPerMillionTokens,
    cachedInput: pricing.cachedInputUsdPerMillionTokens,
    cacheWrite: pricing.cacheWriteUsdPerMillionTokens ?? pricing.inputUsdPerMillionTokens
  }
  // OpenAI counts cached input inside input; the others report each category apart.
  const freshInput = usage.provider === 'openai' ? Math.max(0, input - cacheRead) : input
  const usd = (freshInput * rates.input + cacheRead * rates.cachedInput + cacheWrite * rates.cacheWrite + output * rates.output) / 1e6
  return { usd, tokens: { input, output, cacheRead, cacheWrite }, rates, source: pricing.source, asOf: pricing.asOf, tokensBasis }
}
