/*
 * Supervisor inquiries (phase 4 of the seat-access fence; docs/top-level-supervisor.md "Inquiries").
 *
 * An inquiry is a question answered by an analysis run that publishes nothing.
 * Its displayed state is computed from its LATEST run with exact engine values,
 * first matching row wins; the run record is never rewritten to reach a row.
 * Everything here is pure: callers read the record, the lock liveness and the
 * pending launches, and hold the project's admission lock when they act on it.
 */

const LIVE = ['pending', 'preflighting', 'running', 'stopping']
const ANSWERED = ['accepted', 'no-findings', 'duplicate', 'rejected']
const RECOVERY = ['recovery-required', 'owner-lost']

const row = (n, state, closable, extra = {}) => ({ row: n, state, closable, ...extra })

/**
 * @param run      the latest run record (run.json), or null when the inquiry has none
 * @param pending  a reservation or launch for the inquiry is in flight
 * @param unreadable the latest run exists but its record could not be read
 */
export function inquiryState ({ run = null, pending = false, unreadable = false } = {}) {
  if (unreadable) return row(0, 'unclassified', null, { reason: 'the latest run record is unreadable' })
  if (!run) return pending ? row(1, 'running', null) : { row: null, state: 'draft', closable: null }
  if (pending || LIVE.includes(run.status)) return row(1, 'running', null)
  if (run.status === 'paused') return row(2, 'waiting for an answer', null)
  if (run.recovery?.required || RECOVERY.includes(run.blockedReason) || run.status === 'recovery-required' || run.integrity?.status === 'quarantined') {
    return row(3, 'needs recovery', null)
  }
  const disposition = run.reportDisposition?.disposition ?? null
  if (run.status === 'completed') {
    if (ANSWERED.includes(disposition)) return row(4, 'answered', null, { disposition })
    if (disposition === 'needs-information') return row(5, 'answered, needs information', 'acknowledge', { disposition })
    if (!disposition && run.outcome === 'unresolved') return row(6, 'unanswered', 'close', { cause: run.explanation?.cause ?? run.blockedReason ?? null })
    return row(0, 'unclassified', null, { reason: 'completed without a validated disposition' })
  }
  if (run.status === 'blocked') return row(7, 'blocked', 'close', { reason: run.blockedReason ?? null })
  if (run.status === 'cancelled') return row(8, 'stopped', 'close')
  if (run.status === 'failed') {
    const failureClass = run.failure?.class ?? null
    const next = ['transient', 'rate-limit', 'output-limit'].includes(failureClass) ? 'already retried in-run'
      : failureClass === 'quota' ? 'may be started again once the model is available'
        : 'needs a person'
    return row(9, 'failed', 'close', { failureClass, next })
  }
  return row(0, 'unclassified', null, { reason: `unknown run status ${JSON.stringify(run.status)}` })
}

/**
 * May an inquiry be packed now? One predicate for automatic packing (row 4)
 * and packing after a close or acknowledgement (rows 5–9). Evaluated while
 * holding the project's admission lock.
 *
 * @param inquiry   the inquiry as issues.js reads it (kind, inquiry.closure)
 * @param run       the latest run record, or null
 * @param latestRunId its id
 * @param liveness  the run lock owner's liveness: 'none' | 'alive' | 'dead' | 'unknown'
 * @param settled   the supervisor has settled the workspace and released ownership
 * @param pending   a reservation, launch or preview-bound start is in flight
 */
export function inquiryPackable ({ inquiry, run = null, latestRunId = null, liveness = 'none', settled = false, pending = false, unreadable = false }) {
  const no = (reason) => ({ packable: false, reason })
  if (inquiry?.kind !== 'inquiry') return no('not an inquiry')
  if (!run && !unreadable) return no('a draft (no run) is never packed automatically')
  if (!['none', 'dead'].includes(liveness)) return no(`the latest run's lock owner is ${liveness}`)
  if (!settled) return no('the latest run is not settled')
  if (pending) return no('a start is pending for this inquiry')
  const state = inquiryState({ run, pending, unreadable })
  if (state.row === 0 || state.row === 3 || state.row === 1 || state.row === 2) return no(`row ${state.row} (${state.state}) is never packed`)
  if (run.recovery?.required || run.integrity?.status === 'quarantined') return no('recovery is required')
  if (state.row === 4) return { packable: true, reason: null, state }
  const closure = inquiry.inquiry?.closure ?? null
  if (!closure || closure.runId !== latestRunId) return no(`row ${state.row} needs a ${state.closable} for run ${latestRunId}`)
  if (closure.action !== state.closable) return no(`row ${state.row} needs ${state.closable}, not ${closure.action}`)
  return { packable: true, reason: null, state }
}

/** Is an inquiry terminal (a recorded closure)? Start, resume, recover, retry, refresh and finalize are refused. */
export const inquiryClosed = (issue) => issue?.kind === 'inquiry' && Boolean(issue.inquiry?.closure)
