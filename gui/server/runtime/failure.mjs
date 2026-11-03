import { writeJson } from './persistence.mjs'
import { withLock } from './lock.mjs'
import fs from 'node:fs/promises'

/*
 * Runtime failure classification and model availability.
 *
 * A non-zero exit from a runtime is not one kind of event. A provider that is
 * rate-limiting deserves a bounded wait and another attempt; an exhausted quota
 * deserves a recorded cooldown so no other run on this host spends a start on
 * the same model until it resets; a bad credential or a broken sandbox is an
 * environment fault that no retry will fix. Everything here is a heuristic over
 * the runtime's own words, so every classification is recorded WITH the text it
 * was read from and never hidden behind a retry.
 */

export const FAILURE_CLASSES = ['rate-limit', 'quota', 'auth', 'environment', 'transient', 'output-limit', 'runtime']

/*
 * A turn that ended on the model's output token limit, in each runtime's own
 * words (docs/execution-contract.md "The output limit" says where each was read):
 * Codex's turn.failed message; Claude's synthetic API error, as runtimeErrors
 * renders it or on its own; Gemini's result error and the error behind it.
 * A whole line, because the rules below read stdout: in a stream a model's text
 * is inside a JSON line, so it cannot match, however it mentions the limit.
 */
const OUTPUT_LIMIT = /^(?:Incomplete response returned, reason: max_output_tokens|max_output_tokens(?:: .*)?|(?:\w+: )?(?:API Error: )?Claude's response exceeded the \d+ output token maximum\b.*|Model response was truncated because it exceeded the token limit\b.*|Model stream ended due to token limit exhaustion \(MAX_TOKENS\).*)$/m

function endedOnOutputLimit (error) {
  const said = [error?.message, error?.stderr, error?.stdout]
  // A result record keeps the model's answer unless the runtime marked it an error.
  if (error?.payload?.is_error === true && typeof error.payload.result === 'string') said.push(error.payload.result)
  return said.some((text) => text && OUTPUT_LIMIT.test(text))
}

const RULES = [
  // Order matters: the most specific words first. A quota message often also
  // says "limit", so quota is judged before rate-limit.
  { cls: 'quota', re: /insufficient[_ ]quota|quota (?:exceeded|exhausted)|usage limit|weekly limit|monthly limit|spend(?:ing)? limit|billing (?:hard )?limit|out of credits|credit balance|exceeded your current quota|plan limit|hit your limit/i },
  { cls: 'auth', re: /(?:http(?: status)?|status(?: code)?|error|code)[: =]+(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api[_ ]?key|token|credential)|authentication[_ ](?:failed|error|required)|failed to authenticate|oauth (?:session|token) (?:has )?expired|not logged in|login required|permission denied by provider|enforced authentication type|please re-authenticate/i },
  { cls: 'rate-limit', re: /(?:http(?: status)?|status(?: code)?|error|code)[: =]+429\b|rate[_ -]?limit|too many requests|(?:http(?: status)?|status(?: code)?|error|code)[: =]+529\b|overloaded|capacity|please (?:retry|try again) (?:later|in)|retry[_ -]after|slow down/i },
  { cls: 'transient', re: /(?:http(?: status)?|status(?: code)?|error|code)[: =]+5(?:00|02|03|04)\b|internal server error|bad gateway|service unavailable|gateway time-?out|econnreset|econnrefused|etimedout|eai_again|enotfound|socket hang up|network (?:error|failure)|connection (?:reset|closed|refused|error)|stream (?:ended|closed) unexpectedly|fetch failed/i },
  { cls: 'environment', re: /sandbox (?:required but unavailable|is enabled but)|unexpected argument|unknown (?:option|flag|argument)|\benoent\b|command not found|no such file or directory|bubblewrap|bwrap|not installed|cannot find module|unsupported reference type|cannot be resolved|has an unreadable|failIfUnavailable/i }
]

/** Milliseconds until a provider says it may be retried, parsed from its words, or null. */
export function parseRetryAfter (text, now = Date.now()) {
  if (!text) return null
  let m = /retry[- ]after[:=]?\s*(\d+)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)?\b/i.exec(text)
  if (!m) m = /(?:try again|retry|resets?|available again) (?:in|after)\s*(\d+)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(text)
  if (m) {
    const n = Number(m[1])
    const unit = (m[2] ?? 's').toLowerCase()
    const factor = unit.startsWith('ms') ? 1 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000
    return n * factor
  }
  // An absolute instant: "resets at 2026-09-13T12:00:00Z" or "reset_at: <iso>".
  m = /(?:resets?(?:_at)?|available)\s*(?:at|:)?\s*(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text)
  if (m) {
    const at = Date.parse(m[1])
    if (Number.isFinite(at)) return Math.max(0, at - now)
  }
  return null
}

/**
 * Classify a runtime failure. Cancellation is never classified here; callers
 * handle AbortError before asking.
 */
export function classifyFailure (error, { now = Date.now() } = {}) {
  const parts = [error?.message, error?.stderr, error?.stdout, error?.code != null ? `code ${error.code}` : null]
  if (error?.payload) parts.push(JSON.stringify(error.payload).slice(0, 2000))
  for (const status of [error?.status, error?.statusCode, error?.payload?.status, error?.payload?.status_code, error?.payload?.error?.status]) {
    if (/^[45]\d\d$/.test(String(status))) parts.push(`HTTP status ${status}`)
  }
  const text = parts.filter(Boolean).join('\n')
  let cls = 'runtime'
  if (error?.kind === 'environment-error' || error?.kind === 'configuration-error' || error?.kind === 'spawn-error') cls = 'environment'
  else if (endedOnOutputLimit(error)) cls = 'output-limit'
  else for (const rule of RULES) if (rule.re.test(text)) { cls = rule.cls; break }
  let retryAfterMs = parseRetryAfter(text, now)
  // A login rejected while the shared credential file changed under the turn
  // (error.credentials, recorded by the adapter) is another process's refresh
  // rotating the token the turn held, not a bad login. The seat's fence binds
  // the file afresh per turn, so one more attempt, at once, reads the new one.
  // Unchanged, it stays `auth`: the same call fails the same way.
  const credentials = error?.credentials ?? null
  let maxRetries = null
  if (cls === 'auth' && credentials?.changed === true) {
    cls = 'transient'
    maxRetries = 1
    retryAfterMs = 0
  }
  return {
    class: cls,
    // A rate limit or a transient fault is worth another attempt, and so is a turn
    // that ran out of output, told so (engine.mjs). A quota, a credential or a
    // broken environment is not: the same call fails the same way.
    retryable: cls === 'rate-limit' || cls === 'transient' || cls === 'output-limit',
    retryAfterMs,
    ...(maxRetries != null ? { maxRetries } : {}),
    ...(credentials ? { credentials } : {}),
    message: error?.message ?? String(error),
    evidence: text.slice(0, 1000)
  }
}

/**
 * Backoff for attempt n (1-based) of a retryable failure: the provider's own
 * retry-after when it gave one, else base·2^(n-1), capped. Never zero.
 */
export function backoffMs (attempt, { baseMs = 30_000, maxMs = 600_000, retryAfterMs = null } = {}) {
  if (retryAfterMs != null) return Math.min(Math.max(retryAfterMs, 1000), maxMs)
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs)
}

// --- model availability -------------------------------------------------------

/**
 * A durable, host-wide memory of exhausted models.
 *
 * One JSON file, keyed by roster model id. A quota failure in one run records a
 * cooldown here; every later start on this host consults it before spending a
 * launch on a model known to be exhausted. The store never invents a reset
 * time: when the provider named one it is used, otherwise a default hold is
 * recorded and MARKED as assumed, so the record is honest about what it knows.
 */
export const DEFAULT_HOLD_MS = 30 * 60_000

export function createAvailabilityStore (file, { clock = { now: () => Date.now(), iso: () => new Date().toISOString() }, defaultHoldMs = DEFAULT_HOLD_MS } = {}) {
  const read = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.models || typeof parsed.models !== 'object' || Array.isArray(parsed.models)) throw new Error('invalid availability schema')
      for (const [id, record] of Object.entries(parsed.models)) {
        if (!record || record.modelId !== id || typeof record.exhaustedUntil !== 'string' || !Number.isFinite(Date.parse(record.exhaustedUntil))) throw new Error(`invalid availability record: ${id}`)
      }
      return parsed
    } catch (error) {
      if (error.code === 'ENOENT') return { models: {} }
      // A corrupt store must not silently mean "everything is available".
      throw Object.assign(new Error(`model availability store is unreadable: ${error.message}`), { status: 503 })
    }
  }
  const write = state => writeJson(file, state)
  const update = fn => withLock(`${file}.lock`, { purpose: 'model-availability', waitMs: 30000 }, fn)
  return {
    file,
    /** Record that `modelId` is exhausted. Returns the record written. */
    async recordExhausted ({ modelId, harness = null, reason, retryAfterMs = null, until: untilAt = null, runId = null, role = null, actor = null }) {
      return update(async () => {
        const state = await read()
        const now = clock.now()
        // An explicit instant (an operator's hold) is exact; a provider's
        // retry-after is exact; nothing at all is an assumed default hold.
        if (untilAt != null) {
          const at = Date.parse(untilAt)
          if (!Number.isFinite(at) || at <= now) throw Object.assign(new Error('the hold must end at a future instant'), { status: 422 })
          retryAfterMs = at - now
        }
        const assumed = retryAfterMs == null
        const until = new Date(now + (assumed ? defaultHoldMs : Math.max(retryAfterMs, 60_000))).toISOString()
        const existing = state.models[modelId]
        // A later deadline supersedes an earlier one; an exact one supersedes an
        // assumed one for the same period.
        const keep = existing && Date.parse(existing.exhaustedUntil) > Date.parse(until) && !(assumed === false && existing.assumed)
        const record = keep ? existing : { modelId, harness, exhaustedUntil: until, assumed, observedAt: clock.iso(), reason: String(reason ?? '').slice(0, 500), runId, role, actor }
        state.models[modelId] = record
        await write(state)
        return record
      })
    },
    /** The active cooldown for a model, or null when it is (as far as known) available. */
    async check (modelId) {
      const state = await read()
      const record = state.models[modelId]
      if (!record) return null
      if (Date.parse(record.exhaustedUntil) <= clock.now()) return null
      return record
    },
    /** Every record, expired ones included, so a page can show the last exhaustion. */
    async all () {
      const state = await read()
      return Object.values(state.models).map((r) => ({ ...r, active: Date.parse(r.exhaustedUntil) > clock.now() }))
    },
    /** Every active cooldown. */
    async active () {
      const state = await read()
      return Object.values(state.models).filter((r) => Date.parse(r.exhaustedUntil) > clock.now())
    },
    /** Operator override: the model is available again. */
    async clear (modelId) {
      return update(async () => {
        const state = await read()
        const had = Boolean(state.models[modelId])
        delete state.models[modelId]
        await write(state)
        return had
      })
    }
  }
}
