const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes (bytes, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** power
  return `${value.toFixed(power === 0 ? 0 : digits)} ${BYTE_UNITS[power]}`
}

/** Compact uptime — the two largest units are enough to read at a glance. */
export function formatDuration (seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

/**
 * A measured span, in the units a person reading it would use.
 *
 * Sub-second precision matters here: turns are measured, and rounding a 313 ms
 * turn to "0s" throws away the measurement. Null is "not known", which is not
 * the same as zero and must not print as one.
 */
export function formatMillis (ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  return formatDuration(Math.round(ms / 1000))
}

export function formatRelative (timestamp) {
  if (!timestamp) return 'never'
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 2) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  return formatDuration(seconds) + ' ago'
}
/** The seat is displayed separately; omit its exact suffix from the step label. */
export function formatStep (stepId, role) {
  const id = stepId ?? ''
  const suffix = role ? `-${role}` : ''
  const label = suffix && id.endsWith(suffix) ? id.slice(0, -suffix.length) : id
  return label.replace(/-/g, ' ')
}

/*
 * Cost, as the panel reports it everywhere: the time it took and the tokens it
 * used — never money. Time as hh:mm:ss (hours run past 24), tokens in millions.
 */
export function formatHms (ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

export function formatMTokens (tokens) {
  if (tokens === null || tokens === undefined || !Number.isFinite(Number(tokens))) return '— M tokens'
  const m = Number(tokens) / 1e6
  if (m === 0) return '0 M tokens'
  const text = m >= 10 ? m.toFixed(1) : m >= 0.01 ? m.toFixed(2) : m >= 0.0001 ? m.toFixed(4) : '<0.0001'
  return `${text} M tokens`
}

/** A usage record's total tokens, whichever way its runtime or provider reports them. */
export function usageTokens (usage) {
  if (!usage) return null
  if (Number.isFinite(usage.tokens)) return usage.tokens
  const parts = [usage.input_tokens, usage.output_tokens, usage.inputTokens, usage.outputTokens, usage.cacheCreationTokens, usage.cacheReadTokens].filter(Number.isFinite)
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null
}

/** A supervisor conversation's model calls: tokens, time, and how many replies predate recorded times. */
export function supervisorUsage (messages = []) {
  return messages.filter((m) => m.role === 'assistant' && m.usage).reduce((u, m) => ({
    tokens: u.tokens + (usageTokens(m.usage) ?? 0),
    durationMs: u.durationMs + (Number(m.durationMs) || 0),
    untimed: u.untimed + (Number.isFinite(m.durationMs) ? 0 : 1)
  }), { tokens: 0, durationMs: 0, untimed: 0 })
}

/** A supervisor session's spending, each kind said apart: reported, estimated (~), and calls nobody can price. */
export function supervisorCost (cost) {
  if (!cost) return []
  const usd = (n) => `$${Number(n).toFixed(n > 0 && n < 0.01 ? 4 : 2)}`
  const calls = (n) => `${n} call${n === 1 ? '' : 's'}`
  return [
    ...(cost.reportedUsd > 0 ? [`${usd(cost.reportedUsd)} reported`] : []),
    ...(cost.estimatedCalls > 0 ? [`~${usd(cost.estimatedUsd)} estimated (${calls(cost.estimatedCalls)})`] : []),
    ...(cost.unknownCalls > 0 ? [`${calls(cost.unknownCalls)} unknown cost`] : [])
  ]
}
