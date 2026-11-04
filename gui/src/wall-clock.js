/*
 * What the Resume and Continue dialogs say about the time left, from the run's
 * `wallClock` standing (server/runtime/wall-clock.mjs). The server decides; this
 * only shows it before the click.
 */

const minutes = (ms) => Math.round(Math.max(0, ms) / 6000) / 10

/**
 * The minutes the budget has used, as the run page shows them. It ticks with `now`
 * from the run's start, except while only a check runs: the clock stands still
 * then, so the server's reading is held instead of ticking on.
 */
export function wallClockUsedMinutes (run, now) {
  if (!run?.startedAt) return 0
  const clock = run.wallClock
  if (clock?.waitingOnCheckAlone) return Math.max(0, Math.round(clock.elapsedMs / 60000))
  const until = run.status === 'paused' ? Date.parse(run.pause?.at) : run.endedAt ? Date.parse(run.endedAt) : now
  return Math.max(0, Math.round((until - Date.parse(run.startedAt) - (run.suspendedMs ?? 0) - (clock?.excludedChecksMs ?? 0)) / 60000))
}

/** The wall clock against a limit the operator may have raised; null without a standing. */
export function wallClockAt (standing, limitMinutes) {
  if (!standing) return null
  const limit = limitMinutes || standing.limitMinutes
  const remainingMs = limit * 60_000 - standing.elapsedMs
  const { meanRoundMs, rounds } = standing
  return {
    exhausted: remainingMs <= 0,
    short: remainingMs > 0 && meanRoundMs != null && remainingMs < meanRoundMs,
    text: `${minutes(remainingMs)} min left of ${limit}; ${meanRoundMs == null ? 'no round has completed yet, so this run has no mean round time' : `this run's mean round is ${minutes(meanRoundMs)} min (${rounds} round${rounds === 1 ? '' : 's'})`}.`
  }
}

/**
 * The limit a dialog starts from: the run's own, never less; more only when that
 * could not go on, by what going on takes. A run that started before this default
 * replaced the seven-day one keeps that one on Resume (`startedUnderRule` absent).
 */
export function wallClockPrefill (standing, { resume = false } = {}) {
  if (!standing) return 0
  const { limitMinutes: limit, elapsedMs, meanRoundMs } = standing
  const remainingMs = limit * 60_000 - elapsedMs
  const needed = remainingMs <= 0
    ? Math.ceil(elapsedMs / 60_000) + limit
    : meanRoundMs != null && remainingMs < meanRoundMs ? Math.ceil((elapsedMs + meanRoundMs) / 60_000) : limit
  return resume && !standing.startedUnderRule ? Math.max(10080, needed) : needed
}
