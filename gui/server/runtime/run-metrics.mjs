/*
 * Convergence measurements for one run, read off the record.
 *
 * A retrospective of a long run needed four
 * numbers that the record held but nothing reported: how many review rounds
 * were executed and how often the cycle was restarted instead, how much of the
 * elapsed time was agents working versus a person being waited for, and how
 * many reviewer findings were distinct versus another seat naming the same
 * one. These are measurements, not verdicts: a run with many rounds may have
 * needed them. They exist so that the next change to a strategy, a seat or a
 * model can be compared against the runs before it instead of argued.
 *
 * Everything here is derived from `run.json` (and, when supplied, the recorded
 * outputs); nothing is accumulated by the engine, so an older run measures
 * exactly as a new one does. Where the record does not carry the evidence a
 * measurement needs, the reading says it was inferred rather than pretending.
 */

import { gatingResult } from './baseline-failures.mjs'

const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null }
const interval = (from, to) => (from != null && to != null && to > from ? { from, to } : null)

/** Total length of a union of intervals: overlapping records count once. */
function unionMs (intervals) {
  const sorted = intervals.filter(Boolean).sort((a, b) => a.from - b.from)
  let total = 0, cur = null
  for (const i of sorted) {
    if (cur && i.from <= cur.to) cur.to = Math.max(cur.to, i.to)
    else { if (cur) total += cur.to - cur.from; cur = { ...i } }
  }
  if (cur) total += cur.to - cur.from
  return total
}

/** Length of `a` that lies inside the union of `b`. */
function overlapMs (a, b) {
  return unionMs(a) + unionMs(b) - unionMs([...a, ...b])
}

/*
 * A pause is waiting on a person when it asks a question (a coordinator's
 * operator request, a phase's await-input, exhausted rounds); a manual pause
 * is a person stopping the run, which is suspension.
 */
const asksAQuestion = (pause) => Boolean(pause) && pause.kind !== 'manual'

/*
 * Every check run the record still holds, as its own interval (a check's `at`
 * is when it began): the current revision's results and their failed
 * attempts, results an amendment set aside, the base commit's checks, and the
 * runs the history keeps for earlier revisions. One check can appear in
 * several of these; the union counts it once. The time between check runs —
 * the engine comparing results, persisting, waiting — is not check time.
 */
function checkIntervals (run) {
  const span = (c) => { const a = ms(c?.at); return a != null && typeof c.durationMs === 'number' ? interval(a, a + c.durationMs) : null }
  const results = [...(run.checkResults ?? []), ...(run.priorCheckResults ?? [])]
  return [
    ...results.flatMap((c) => [span(c), ...(c.attempts ?? []).map(span)]),
    ...(run.baselineChecks ?? []).map(span),
    ...(run.diagnosticDrives ?? []).map(span),
    ...(run.checkHistory ?? []).flatMap((h) => (h.runs ?? []).map(span))
  ].filter(Boolean)
}

/**
 * How long this run's drives waited for a slot on their staging host, as a union:
 * concurrent base and candidate waits count once. `open` is what is still waiting
 * ({ from: ms }), which only the running engine knows; it counts until `now`.
 */
export function driveSlotWaitMs (run, { open = [], now = null } = {}) {
  const closed = (run.driveSlotWaits ?? []).map((w) => interval(ms(w.from), ms(w.to)))
  return unionMs([...closed, ...open.map((w) => interval(w.from, now))])
}

/**
 * Time, five ways that add up to the elapsed time:
 *  - agentMs        turns of every non-operator seat, asked → answered, as a union: concurrent
 *                   reviewers of one round count once (`seatMs` is their sum, the seats' own time)
 *  - operatorWaitMs the run stood paused on a question for a person (decision steps, an open question)
 *  - suspendedMs    the run stood stopped (budget block, manual pause, failure) until resumed or retried
 *  - waitingForChecksMs  checks ran and no seat turn did: the run waited on its checks
 *  - otherMs        the remainder: engine work, delivery, retry waits
 *
 * `checksMs` is all check time, beside the split rather than in it: checks run
 * beside reviews, so most of it may lie inside agent time already.
 * `driveSlotWaitMs` is the part of it spent waiting for a slot on a staging host,
 * not driving: a drive's interval runs from before that wait.
 *
 * Waits and suspensions are built as INTERVALS and unioned, because the record
 * writes the same wait in two places: a decision step spans ask → answer, and
 * the engine also adds that span to `controlSuspendedMs` so the wall-clock
 * budget excuses it. Summing the two fields would count it twice. What was
 * recorded twice is reported, not hidden.
 */
function timeSplit (run, now) {
  const started = ms(run.startedAt)
  const ended = ms(run.endedAt) ?? now
  const elapsedMs = started != null && ended >= started ? ended - started : null
  let seatMs = 0, unknownSteps = 0, unplacedMs = 0
  const waits = []
  const turns = []
  for (const s of run.steps ?? []) {
    if (s.role === 'operator') {
      const w = interval(ms(s.startedAt), ms(s.endedAt))
      if (w) waits.push(w); else unknownSteps++
      continue
    }
    const turn = interval(ms(s.startedAt), ms(s.endedAt))
    turns.push(turn)
    if (typeof s.durationMs === 'number') { seatMs += s.durationMs; if (!turn) unplacedMs += s.durationMs }
    else if (turn) seatMs += turn.to - turn.from
    else unknownSteps++
  }
  // A turn with a duration but no interval cannot be overlapped with anything; it counts whole.
  const agentMs = unionMs(turns.filter(Boolean)) + unplacedMs
  const suspensions = []
  // Completed waits are on decision steps; an open question is not answered
  // yet, so the engine has not folded it into any total.
  const completedWaits = [...waits]
  if (run.status === 'paused' && run.pause?.at) {
    const open = interval(ms(run.pause.at), ended)
    if (open) (asksAQuestion(run.pause) ? waits : suspensions).push(open)
  }
  // Each resume records when it happened and how long the run had stood.
  let basis = 'recorded'
  const resumes = (run.resumeHistory ?? []).filter((r) => typeof r.suspendedMs === 'number' && ms(r.at) != null)
  for (const r of resumes) suspensions.push(interval(ms(r.at) - r.suspendedMs, ms(r.at)))
  const recordedSuspensionMs = unionMs(suspensions)
  const overlappingSuspensionMs = overlapMs(suspensions, waits)
  let suspendedMs = recordedSuspensionMs - overlappingSuspensionMs
  // The engine folds every ANSWERED wait into controlSuspendedMs so the wall
  // clock excuses it; that part of the total is a wait already counted above.
  const control = typeof run.controlSuspendedMs === 'number' ? run.controlSuspendedMs : 0
  const waitsInControlTotalMs = Math.min(unionMs(completedWaits), Math.max(0, control - recordedSuspensionMs))
  if (!resumes.length && control > 0) {
    // An older record: one total, which may include answered questions but
    // never the question still open.
    basis = 'inferred'
    suspendedMs += Math.max(0, control - unionMs(completedWaits))
  }
  // Failure retries and check refreshes are recorded as totals only; a run is
  // never paused on a question while failed, so these cannot overlap a wait.
  suspendedMs += (run.inputRetrySuspendedMs ?? 0) + (run.checkRefreshSuspendedMs ?? 0)
  const operatorWaitMs = unionMs(waits)
  // Check time outside every seat turn is the run waiting on its checks. The
  // part of that which also lay inside a wait or a suspension is already
  // counted there, so only the rest leaves otherMs.
  const checks = checkIntervals(run)
  const checksMs = unionMs(checks)
  // A turn still in flight is a seat turn too, running until now.
  for (const p of Object.values(run.participants ?? {})) if (p?.pendingInvocation) turns.push(interval(ms(p.pendingInvocation.startedAt), ended))
  const seatTurns = turns.filter(Boolean)
  const waitingForChecksMs = checksMs - overlapMs(checks, seatTurns)
  const checksAloneMs = checksMs - overlapMs(checks, [...seatTurns, ...waits, ...suspensions.filter(Boolean)])
  const remainder = elapsedMs == null ? null : elapsedMs - agentMs - operatorWaitMs - suspendedMs - checksAloneMs
  return {
    elapsedMs, agentMs, seatMs, operatorWaitMs, suspendedMs, checksMs, waitingForChecksMs, driveSlotWaitMs: driveSlotWaitMs(run),
    otherMs: remainder == null ? null : Math.max(0, remainder),
    // A negative remainder means the parts exceed the whole: the record is
    // inconsistent and the split must not be trusted for this run.
    inconsistentMs: remainder != null && remainder < 0 ? -remainder : 0,
    overlappingSuspensionMs,
    waitsInControlTotalMs,
    unknownSteps,
    basis,
    means: 'agent turns, waits on a question and suspensions are disjoint intervals unioned from the record (seatMs is the seats\' own time summed: concurrent reviewers each count); checksMs is the union of every recorded check run (overlap with seat turns counted once), waitingForChecksMs the part of it during which no seat turn ran, and otherMs excludes that part; driveSlotWaitMs is the check time spent waiting for a slot on a staging host, inside checksMs and, where no seat turn ran, inside waitingForChecksMs; a turn still in flight counts as a seat turn until now, and the engine\'s work between check runs stays in otherMs; overlappingSuspensionMs is recorded suspension that lay inside a wait and was counted as the wait; waitsInControlTotalMs is answered waiting the engine also folded into controlSuspendedMs, counted here once as waiting; suspendedMs "inferred" means an older record carried only a total; inconsistentMs > 0 means the parts exceed the elapsed time'
  }
}

/*
 * Where the cycle started over. A recorded reset is a coordinator effect the
 * engine marked (`reset: 'plan' | 'evidence'`). A record made before the marks
 * existed — or resumed across that upgrade — has restarts nothing marked, so a
 * fresh rerun of the run's first step (attempt 1; a protocol repair of that
 * step is attempt 2 of the same turn, not a restart) that no recorded reset
 * accounts for is inferred to be one. The two are reconciled boundary by
 * boundary: a mark never erases an unmarked restart before it, and a rerun a
 * mark explains is not counted twice.
 */
function cycleBoundaries (run) {
  const steps = run.steps ?? []
  const effects = run.coordinatorEffects ?? {}
  const recorded = Object.entries(effects).filter(([, e]) => e?.reset).map(([n]) => Number(n)).sort((a, b) => a - b)
  const first = steps[0]?.stepId
  const reruns = steps.filter((s, i) => i > 0 && s.stepId === first && (s.attempt ?? 1) === 1).map((s) => Number(s.number) - 1)
  const after = [...recorded]
  let inferred = 0
  let previous = -1
  for (const rerun of reruns) {
    const explained = recorded.some((n) => n > previous && n <= rerun)
    if (!explained) { after.push(rerun); inferred++ }
    previous = rerun
  }
  after.sort((a, b) => a - b)
  return { after, inferred, recorded: recorded.length, basis: inferred === 0 ? 'recorded' : recorded.length ? 'mixed' : 'inferred' }
}

const cycleOf = (boundaries, stepNumber) => boundaries.after.filter((n) => Number(stepNumber) > n).length

/**
 * Round executions per phase, beside cycle restarts. A round execution is one
 * (cycle, round) in which a seat other than the coordinator ran; thirteen
 * cycles that each ran round 0 are thirteen executions at depth 1, which is
 * what the wildcard run did and what a bare "rounds: 1" would have hidden. A
 * brief that only opened a round before a restart is not an execution.
 */
function roundsAndRestarts (run) {
  const steps = run.steps ?? []
  const bounds = cycleBoundaries(run)
  const byPhase = {}
  for (const s of steps) {
    if (!s.phase) continue
    const p = (byPhase[s.phase] ??= { turns: 0, agentMs: 0, repairs: 0, executions: new Set(), cycles: new Set(), maxDepth: 0, byRole: {} })
    p.turns++
    const worker = s.role !== 'operator'
    if (typeof s.durationMs === 'number' && worker) p.agentMs += s.durationMs
    if ((s.attempt ?? 1) > 1) p.repairs++
    const r = (p.byRole[s.role] ??= { turns: 0, agentMs: 0 })
    r.turns++
    if (typeof s.durationMs === 'number' && worker) r.agentMs += s.durationMs
    if (typeof s.round === 'number' && worker && s.role !== 'coordinator') {
      const c = cycleOf(bounds, s.number)
      p.executions.add(`${c}:${s.round}`); p.cycles.add(c); p.maxDepth = Math.max(p.maxDepth, s.round + 1)
    }
  }
  for (const p of Object.values(byPhase)) {
    p.roundExecutions = p.executions.size; p.cycles = p.cycles.size
    delete p.executions
  }
  const ignoredRestartRequests = Object.values(run.coordinatorEffects ?? {}).filter((e) => (e?.ignored ?? []).includes('restartPlan')).length
  return {
    byPhase,
    cycleRestarts: bounds.after.length,
    restartsBasis: bounds.basis,
    restartsInferred: bounds.inferred,
    ignoredRestartRequests,
    means: 'roundExecutions counts (cycle, round) pairs a non-coordinator seat ran in; maxDepth is the deepest round reached in any cycle; cycleRestarts counts evidence refreshes and plan restarts, which rerun the first step and reset the round counter; restartsBasis "inferred" or "mixed" says restartsInferred of them come from a fresh first step no recorded reset explains (a record older than the reset marks, or resumed across that upgrade)'
  }
}

/**
 * Finding ids carry the auditor's seat as a prefix; the remainder is that
 * auditor's own slug for the defect. Within one review (same cycle, phase and
 * round) a slug named by more than one seat is a match across seats; the same
 * seat naming it again is a restatement; a slug named again in a later review
 * is repeated. Only a seat's last valid report in a review counts — an earlier
 * attempt it repaired is superseded. Slugs are the auditors' words: equal
 * slugs are evidence of agreement, not proof of the same defect, and different
 * slugs may be one defect. The reading therefore counts slugs, and says so.
 */
function findingStats (run, outputs) {
  if (!outputs) return null
  const steps = run.steps ?? []
  const bounds = cycleBoundaries(run)
  // Last valid review per (review, seat): a repaired attempt supersedes.
  const reviews = new Map()
  const blockingByRound = new Map()   // review → its row, in the order the reviews ran
  for (const s of steps) {
    const out = outputs[s.number]
    if (!out?.valid || out.contract !== 'reviewResult') continue
    const cycle = cycleOf(bounds, s.number)
    const key = `${cycle}:${s.phase}:${s.round}`
    if (!reviews.has(key)) {
      reviews.set(key, new Map())
      blockingByRound.set(key, { phase: s.phase, cycle, round: s.round, blocking: 0, blockingSlugs: 0 })
    }
    reviews.get(key).set(s.role, out.output?.findings ?? [])
  }
  const stats = { reported: 0, distinctSlugs: 0, matchedAcrossSeats: 0, restatedBySameSeat: 0, repeatedLater: 0, blocking: 0, reviews: reviews.size, supersededReports: 0 }
  const seenEver = new Set()
  for (const [key, seats] of reviews) {
    const namedBy = new Map()   // slug → Set(seat)
    const row = blockingByRound.get(key)
    const blockingSlugs = new Set()
    for (const [seat, findings] of seats) {
      for (const f of findings) {
        if (!f?.id) continue
        const slug = String(f.id).replace(new RegExp(`^${seat}-`, 'i'), '').toLowerCase()
        stats.reported++
        if (f.blocking) { stats.blocking++; row.blocking++; blockingSlugs.add(slug) }
        const by = namedBy.get(slug)
        if (!by) { namedBy.set(slug, new Set([seat])); if (seenEver.has(slug)) stats.repeatedLater++; else { stats.distinctSlugs++; seenEver.add(slug) } }
        else if (by.has(seat)) stats.restatedBySameSeat++
        else { by.add(seat); stats.matchedAcrossSeats++ }
      }
    }
    row.blockingSlugs = blockingSlugs.size
  }
  // Reports that a later valid attempt of the same turn replaced.
  const counted = new Set([...reviews.values()].flatMap((m) => [...m.values()]))
  for (const s of steps) {
    const out = outputs[s.number]
    if (out?.valid && out.contract === 'reviewResult' && !counted.has(out.output?.findings ?? [])) stats.supersededReports++
  }
  return {
    ...stats,
    blockingByRound: [...blockingByRound.values()],
    basis: bounds.basis,
    means: 'counts finding SLUGS (the id after the seat prefix), not defects: distinctSlugs = first named in a review, matchedAcrossSeats = a different seat named the same slug in the same review, restatedBySameSeat = one seat twice, repeatedLater = named again in a later review; equal slugs are evidence of agreement, not proof, and differently worded slugs may be one defect; blockingByRound has one row per review (cycle, phase, round) in the order they ran, from each seat\'s last valid report: blocking = blocking findings reported across its seats, blockingSlugs = the distinct slugs among them, so a clean round reads 0; rounds per loop are rounds.byPhase[phase].roundExecutions and maxDepth'
  }
}

/*
 * Checks that failed on a revision the reviewers had already approved: the
 * failure arrived after agreement, so the round it cost was the checks' and
 * not the review's. A check counts when it failed as run (a failure the
 * unchanged project shares included) or when its baseline comparison named new
 * failures (a gating failure, such as new selftest failures on a pass). The
 * engine records on each history entry whether its revision was approved when
 * the check started (`afterApproval`). A record from before that holds only the
 * current revision's checks and approvals, so for those revisions the count is
 * inferred from an approving step that ended before the check began, and
 * earlier revisions are out of sight.
 */
function regressionsAfterApproval (run) {
  // Failed as run, inherited failures included, or failed at the gate (a
  // selftest whose baseline comparison named new failures).
  const failed = (result, gating) => result === 'failed' || gating === 'failed'
  const flagged = (run.checkHistory ?? []).filter((h) => typeof h.afterApproval === 'boolean')
  let count = flagged.filter((h) => h.afterApproval && failed(h.result, h.gating)).length
  const covered = new Set(flagged.map((h) => h.revision))
  const endOf = (number) => ms((run.steps ?? []).find((s) => s.number === number)?.endedAt)
  // A carried result (reconcile of inert drift) is no drive: its own revision counted it already.
  const older = (run.checkResults ?? []).filter((c) => !covered.has(c.revision) && !c.carriedFrom)
  for (const c of older) {
    const approved = (run.approvals ?? []).filter((a) => a.revision === c.revision).map((a) => endOf(a.step)).filter((t) => t != null)
    if (approved.length && ms(c.at) != null && ms(c.at) >= Math.min(...approved) && failed(c.result, gatingResult(c, run))) count++
  }
  const unflagged = (run.checkHistory ?? []).some((h) => typeof h.afterApproval !== 'boolean' && h.result !== 'not-run')
  return { count, basis: !older.length && !unflagged ? 'recorded' : flagged.length ? 'mixed' : 'inferred' }
}

/**
 * @param run      a run record as `run.json` holds it
 * @param outputs  optional: `store.readOutputs()` for the run; without it `findings` is null
 * @param now      for a run still going
 */
export function runMetrics (run, { outputs = null, now = Date.now() } = {}) {
  if (!run || typeof run !== 'object') return null
  const steps = run.steps ?? []
  const turns = {
    total: steps.length,
    agent: steps.filter((s) => s.role !== 'operator').length,
    // Decision steps a person answered; `automatic` ones the engine recorded
    // itself (its returns to review after an unmet closure confirmation).
    operator: steps.filter((s) => s.role === 'operator' && !s.decision?.automatic).length,
    automatic: steps.filter((s) => s.role === 'operator' && s.decision?.automatic).length,
    repairs: steps.filter((s) => (s.attempt ?? 1) > 1).length
  }
  const regressions = regressionsAfterApproval(run)
  return {
    turns,
    time: timeSplit(run, now),
    rounds: roundsAndRestarts(run),
    findings: findingStats(run, outputs),
    closureReturns: (run.closureReturns ?? []).length,
    regressionsAfterApproval: regressions.count,
    regressionsBasis: regressions.basis,
    means: 'measurements read off the run record, not stored by the engine; compare runs of the same configHash before changing seats, models or strategy; closureReturns counts the engine\'s automatic returns to the author after an unmet closure confirmation; regressionsAfterApproval counts checks that failed (inherited failures included) or whose baseline comparison named new failures, on a revision already approved when they started, and regressionsBasis "inferred" or "mixed" says part of the count comes from an older record that keeps only the current revision\'s checks'
  }
}

/** One seat's own share of a run: its turns and its agent time, nothing else's. */
export function seatMetrics (run, role) {
  const own = (run.steps ?? []).filter((s) => s.role === role)
  return {
    turns: own.length,
    repairs: own.filter((s) => (s.attempt ?? 1) > 1).length,
    agentMs: own.reduce((a, s) => a + (typeof s.durationMs === 'number' ? s.durationMs : 0), 0)
  }
}

/**
 * Fold one run's measurements into a group total (per seat·model or per
 * configHash in the overview). Only the record-level measurements: findings
 * need outputs, which a light history read does not open. The whole-run
 * figures describe the runs the group PARTICIPATED in; a seat's own effort is
 * `seat`, and only that may be read as what the seat cost.
 */
export function emptyMetricsTotals () {
  return {
    measured: 0, agentMs: 0, seatMs: 0, operatorWaitMs: 0, suspendedMs: 0, checksMs: 0, waitingForChecksMs: 0, driveSlotWaitMs: 0, inconsistent: 0,
    cycleRestarts: 0, inferredRestarts: 0, ignoredRestartRequests: 0, closureReturns: 0, regressionsAfterApproval: 0,
    planReviewRoundExecutions: { total: 0, counted: 0 },
    seat: null
  }
}

export function absorbMetrics (into, run, { role = null } = {}) {
  const m = runMetrics(run)
  if (!m) return into
  into.measured++
  into.agentMs += m.time.agentMs
  into.seatMs += m.time.seatMs
  into.operatorWaitMs += m.time.operatorWaitMs
  into.suspendedMs += m.time.suspendedMs
  into.checksMs += m.time.checksMs
  into.waitingForChecksMs += m.time.waitingForChecksMs
  into.driveSlotWaitMs += m.time.driveSlotWaitMs
  if (m.time.inconsistentMs > 0) into.inconsistent++
  into.cycleRestarts += m.rounds.cycleRestarts
  if (m.rounds.restartsInferred > 0) into.inferredRestarts++
  into.ignoredRestartRequests += m.rounds.ignoredRestartRequests
  into.closureReturns += m.closureReturns
  into.regressionsAfterApproval += m.regressionsAfterApproval
  const plan = m.rounds.byPhase['plan-review']
  if (plan) { into.planReviewRoundExecutions.total += plan.roundExecutions; into.planReviewRoundExecutions.counted++ }
  if (role) {
    into.seat ??= { role, turns: 0, repairs: 0, agentMs: 0 }
    const own = seatMetrics(run, role)
    into.seat.turns += own.turns; into.seat.repairs += own.repairs; into.seat.agentMs += own.agentMs
  }
  return into
}

export function reportMetrics (totals) {
  const mean = (sum, n) => (n ? Math.round(sum / n) : null)
  const exec = totals.planReviewRoundExecutions
  return {
    ...totals,
    meanAgentMs: mean(totals.agentMs, totals.measured),
    meanSeatMs: mean(totals.seatMs, totals.measured),
    meanOperatorWaitMs: mean(totals.operatorWaitMs, totals.measured),
    meanChecksMs: mean(totals.checksMs, totals.measured),
    meanWaitingForChecksMs: mean(totals.waitingForChecksMs, totals.measured),
    meanDriveSlotWaitMs: mean(totals.driveSlotWaitMs, totals.measured),
    planReviewRoundExecutions: { ...exec, mean: exec.counted ? Math.round((exec.total / exec.counted) * 10) / 10 : null },
    seat: totals.seat ? { ...totals.seat, meanAgentMs: mean(totals.seat.agentMs, totals.measured) } : null,
    means: totals.seat
      ? 'whole-run figures (agentMs, operatorWaitMs, checksMs, restarts…) describe the runs this seat·model took part in — a participation cohort, not the seat\'s effort; `seat` is the seat\'s own turns and agent time'
      : 'agent time (agentMs, concurrent turns once; seatMs, each seat\'s own), operator wait and suspended time are separate; checksMs is all check time and waitingForChecksMs the part no seat turn overlapped; cycle restarts and ignored restart requests count beside round executions, never inside them; inferredRestarts says how many runs\' restart counts came from an older record without reset marks; regressionsAfterApproval totals checks that failed on an already approved revision'
  }
}
