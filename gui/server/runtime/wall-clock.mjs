/*
 * What `wallClockMinutes` counts, and whether what is left can hold a round.
 * Read off the run record, by the running deadline, the Resume and Continue
 * checks and the API alike (execution-contract.md "What the wall clock counts").
 *
 * The rule is the owner's: time spent waiting for checks with no seat turn
 * running is free, and any other time counts, except stops and waits for an
 * operator. A check beside a seat turn is not free. Where the record cannot show
 * when a turn stopped, or a check was never recorded, the time counts, so an
 * error runs the budget out sooner and never later.
 */

import { cycleBoundaries, cycleOf, timeSplit, unionMs } from './run-metrics.mjs'

export const WALL_CLOCK_RULE = 'waiting-excluded'

const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null }
const minutes = (value) => Math.round(Math.max(0, value) / 6000) / 10

/** Check time the budget excuses: no seat turn, wait or stop beside it. */
export function excludedChecksMs (run, now, { liveCheckSince = null, stoppedAt = null } = {}) {
  const { checksAloneMs, unplacedStopsMs } = timeSplit(run, now, { liveCheckSince, checksUntil: stoppedAt })
  // An abort the record gives no interval for may have run beside any of it.
  const explained = (run.interruptedTurns ?? []).reduce((sum, t) => sum + (t.abandonedMs ?? (t.reason === 'aborted' ? Math.max(0, (ms(t.endedAt) ?? 0) - (ms(t.startedAt) ?? 0)) : 0)), 0)
  // So may a stop only a total records: elapsed time already leaves that out, and a
  // check inside it must not leave it out again.
  return Math.max(0, checksAloneMs - Math.max(0, (run.timing?.abandonedMs ?? 0) - explained) - unplacedStopsMs)
}

/** The elapsed time compared with `wallClockMinutes`, measured to the stop when the run stands stopped. */
export function wallClockElapsedMs (run, now, { liveCheckSince = null, stoppedAt = null } = {}) {
  const suspended = (run.controlSuspendedMs ?? 0) + (run.inputRetrySuspendedMs ?? 0) + (run.checkRefreshSuspendedMs ?? 0)
  return (stoppedAt ?? now) - Date.parse(run.startedAt) - suspended - excludedChecksMs(run, now, { liveCheckSince, stoppedAt })
}

/**
 * The mean over the run's completed rounds, in the budget's own units. A round is
 * one (cycle, phase, round) of a review loop, complete once it holds a valid
 * review; its time is the union of its answered turns, which leaves out pauses
 * inside it and, under this rule, check time alone. No completed round, no mean.
 */
export function meanRound (run, outputs) {
  const bounds = cycleBoundaries(run)
  const rounds = new Map()
  for (const s of run.steps ?? []) {
    if (s.role === 'operator' || !s.phase || typeof s.round !== 'number') continue
    const key = `${cycleOf(bounds, s.number)}:${s.phase}:${s.round}`
    if (!rounds.has(key)) rounds.set(key, { turns: [], complete: false })
    const round = rounds.get(key)
    const from = ms(s.startedAt)
    const to = ms(s.endedAt)
    if (from != null && to != null && to > from) round.turns.push({ from, to })
    const out = outputs?.[s.number]
    if (out?.valid && out.contract === 'reviewResult') round.complete = true
  }
  const completed = [...rounds.values()].filter((r) => r.complete)
  if (!completed.length) return { meanRoundMs: null, rounds: 0 }
  return { meanRoundMs: Math.round(completed.reduce((sum, r) => sum + unionMs(r.turns), 0) / completed.length), rounds: completed.length }
}

export function wallClockStanding (run, outputs, now, { limitMinutes = run.budgets?.limits?.wallClockMinutes, liveCheckSince = null, stoppedAt = null } = {}) {
  const elapsedMs = wallClockElapsedMs(run, now, { liveCheckSince, stoppedAt })
  return {
    rule: WALL_CLOCK_RULE,
    limitMinutes,
    elapsedMs,
    remainingMs: limitMinutes * 60_000 - elapsedMs,
    excludedChecksMs: excludedChecksMs(run, now, { liveCheckSince, stoppedAt }),
    ...meanRound(run, outputs)
  }
}

/** Why this standing cannot go on as it is, naming both numbers; null when it can. */
export function wallClockRefusal ({ limitMinutes, remainingMs, meanRoundMs, rounds }) {
  const detail = { remainingMs: Math.max(0, remainingMs), meanRoundMs, rounds, limitMinutes }
  const left = `Only ${minutes(remainingMs)} min of wall clock remaining of ${limitMinutes}`
  const mean = meanRoundMs == null
    ? 'no round has completed, so this run has no mean round time'
    : `this run's mean round is ${minutes(meanRoundMs)} min (${rounds} round${rounds === 1 ? '' : 's'})`
  if (remainingMs <= 0) {
    return { code: 'WALL_CLOCK_EXHAUSTED', detail, message: `No wall clock left: 0 min remaining of ${limitMinutes}; ${mean}. Increase the exhausted budget before resuming. Recorded usage is preserved.` }
  }
  if (meanRoundMs != null && remainingMs < meanRoundMs) {
    return { code: 'WALL_CLOCK_SHORT', detail, numbers: `${left}; ${mean}.`, message: `${left}; ${mean}. Raise the time limit, or accept that a turn may be cut at the deadline (acceptShortWallClock).` }
  }
  return null
}

const ENDS_A_TURN = new Set(['invocation-failed', 'invocation-retry', 'budget-exhausted', 'cancelled', 'stopped-for-pause', 'recovery'])
const REASON = { 'invocation-failed': 'failed', 'invocation-retry': 'failed', recovery: 'lost' }

/**
 * The interrupted turns of a record from before they were kept, off its journal:
 * every `invoking` that no step answered and nothing still holds. It ended at the
 * event that says so, else when its seat started again, else at the journal's end.
 * An ending with no `invoking` (or a failure with no event) starts with the run.
 * Every fallback is longer than the turn was: its check time counts.
 */
export function interruptedFromEvents (events, run) {
  const answered = new Set((run.steps ?? []).map((s) => s.invocationId))
  const held = new Set(Object.values(run.participants ?? {}).map((p) => p?.pendingInvocation?.invocationId))
  const seen = new Set()
  const turns = []
  events.forEach((event, index) => {
    if (event.type !== 'invoking' || !event.invocationId) return
    seen.add(event.invocationId)
    if (answered.has(event.invocationId) || held.has(event.invocationId)) return
    const later = events.slice(index + 1)
    const end = later.find((e) => e.invocationId === event.invocationId && ENDS_A_TURN.has(e.type)) ??
      later.find((e) => e.type === 'invoking' && e.role === event.role) ?? events.at(-1)
    turns.push({ invocationId: event.invocationId, role: event.role ?? null, stepId: event.stepId ?? null, startedAt: event.at, endedAt: end.at, reason: end.invocationId === event.invocationId ? (REASON[end.type] ?? 'aborted') : 'lost' })
  })
  const endings = [...events.filter((e) => e.invocationId && ENDS_A_TURN.has(e.type)), ...(run.failures ?? []).filter((f) => f.invocationId).map((f) => ({ ...f, type: 'invocation-failed' }))]
  for (const end of endings) {
    if (seen.has(end.invocationId) || answered.has(end.invocationId) || held.has(end.invocationId)) continue
    seen.add(end.invocationId)
    turns.push({ invocationId: end.invocationId, role: end.role ?? null, stepId: end.stepId ?? null, startedAt: run.startedAt, endedAt: end.at, reason: REASON[end.type] ?? 'aborted' })
  }
  return turns
}
