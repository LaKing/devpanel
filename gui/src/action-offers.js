/*
 * Whether a guarded write is still allowed, judged on the page's fresh state the way the server
 * judges the request. Each rule names the server check it mirrors, so a stale page refuses before
 * sending what the server would refuse after (AC5). What the page cannot confirm counts as refused:
 * an unknown reconcile or recovery state, an unconfirmed repository, a failed availability read.
 *
 * Vue-free and unit-tested (test/action-offers.test.mjs). `run` is the run the action was taken
 * on (the selected run in full, another from the run list); `runs` is the issue's run list.
 */

/** supervisor.mjs LIVE_STATUSES: a run the server counts as active on the issue. */
export const LIVE = ['preflighting', 'pending', 'running', 'stopping']

const actionsOf = (run) => run?.supportedActions ?? []
/** A live run of the issue other than `runId` (supervisor.mjs `active` per issue). */
export const otherLive = (runs, runId = null) => (runs ?? []).some((r) => r.runId !== runId && LIVE.includes(r.status))
const anyLive = (runs) => otherLive(runs, null)
const open = (issue) => Boolean(issue) && !issue.archived && !issue.packed

/*
 * The full verification's freeze (issue read's admissionFrozen; undefined = not confirmed, refused).
 * supervisor.mjs:770: a run that writes the checkout continues only as the frozen cycle's own.
 * supervisor.mjs:1589: no finalize or reconcile delivery at all. supervisor.mjs:368: no writing start.
 */
const freezeKnown = (issue) => Boolean(issue) && issue.admissionFrozen !== undefined
const admitsContinuation = (issue, run) => {
  const a = run?.admission
  if (!freezeKnown(issue) || !a) return false
  const f = issue.admissionFrozen
  return !f || !a.writesCheckout || (a.cycleId != null && a.cycleId === f.cycleId)
}
const admitsDelivery = (issue) => freezeKnown(issue) && !issue.admissionFrozen
const admitsStartOf = (issue, run) => freezeKnown(issue) && (!issue.admissionFrozen || run?.admission?.writesCheckout === false)

/** run-exclusivity.mjs writesCheckout, read off a preview: in place, a release tactic, or a delivery. Unknown writes. */
export const previewWrites = (preview) => !preview || preview.workspace?.isolation === 'in-place' ||
  ['staging', 'deployment'].includes(preview.tactic) || (preview.delivery?.action ?? 'none') !== 'none'

/** supervisor.mjs:368: while frozen, a playbook that writes the checkout does not start. */
export const startAdmitted = (issue, preview) => freezeKnown(issue) && (!issue.admissionFrozen || !previewWrites(preview))

export const offers = {
  /** supervisor.mjs:1452-1454 pauseRun: only the run active here; :2372/:2374 offer pause. */
  pause: ({ issue, run }) => open(issue) && LIVE.includes(run?.status) && actionsOf(run).includes('pause'),

  /** supervisor.mjs:1538-1540 stop: a run no longer live is only "already stopped". */
  stop: ({ issue, run }) => open(issue) && LIVE.includes(run?.status) && actionsOf(run).includes('stop'),

  /** Close's own stop step: the run it stops must still be live (supervisor.mjs:1538-1540). */
  closeStop: ({ run }) => LIVE.includes(run?.status),

  /**
   * supervisor.mjs:755-772 answer, which carries resume, recover, integrity, continue, refresh-checks,
   * accept-check-result and the answer itself: no run active on the issue (:759), the issue not packed
   * (:772), not frozen out by a full verification (:770); the engine accepts only what the run offers
   * (supportedActions, :2360-2398). An archived issue refuses too: the page withdraws every run action there.
   */
  continuation: (action) => ({ issue, runs, run }) => open(issue) && !anyLive(runs) && admitsContinuation(issue, run) && actionsOf(run).includes(action),

  /** supervisor.mjs:1585-1597 finalize and reconcile-delivery: no active run, no freeze (:1589), issue open; offered by the run. */
  finalize: (action) => ({ issue, runs, run }) => open(issue) && !anyLive(runs) && admitsDelivery(issue) && actionsOf(run).includes(action),

  /**
   * supervisor.mjs:1677-1688 abandon: no active run, the run not live, and it needs abandonment (the page
   * offers it only where the run's supportedActions name it, which implies the server's own condition).
   */
  abandon: ({ issue, runs, run }) => open(issue) && Boolean(run) && !anyLive(runs) && !LIVE.includes(run.status) && actionsOf(run).includes('abandon'),

  /**
   * supervisor.mjs:1731-1742 deleteRun: issue not archived or packed (:1734), no active run (:1735), the run
   * neither live nor paused (:1739), no undecided automatic reconcile (:1740; unknown counts as undecided), no open
   * cleanup the project barrier does not record (:1742; unknown counts as unrecorded).
   */
  delete: ({ issue, runs, run }) => open(issue) && Boolean(run) && !anyLive(runs) &&
    ['completed', 'blocked', 'failed', 'cancelled'].includes(run.status) && run.reconcilePending === false && run.cleanupUnrecorded === false,

  /** supervisor.mjs:1281-1283 cleanupTarget: the run not active or live; :2356-2357 offer acknowledge-cleanup. */
  acknowledgeCleanup: ({ issue, run }) => open(issue) && Boolean(run) && !LIVE.includes(run.status) && actionsOf(run).includes('acknowledge-cleanup'),

  /**
   * index.js:382 integrate: no active run; integrate.mjs:88-91 integrateUnavailable (offered as 'integrate',
   * supervisor.mjs:2397) and the approved revision is the delivered one.
   */
  integrate: ({ issue, runs, run }) => open(issue) && !anyLive(runs) && actionsOf(run).includes('integrate') &&
    Boolean(run?.closure?.revision) && run.closure.revision === run?.delivery?.revision,

  /** integrate.mjs:97 (a declared source) and the integration-target read (integrate.mjs:67): a declared source that is positively the candidate's repository. */
  mergeTarget: (target) => target?.declared === true && target?.sameRepository === true && Boolean(target?.branch) && Boolean(target?.head),

  /**
   * index.js:413 apply-artifact: no active run; apply-artifact.mjs:100-103: completed, no recovery or integrity
   * block, a completed and verified worktree-diff or commit delivery of the approved, authorised revision.
   */
  applyArtifact: ({ issue, runs, run }) => {
    const d = run?.delivery
    const c = run?.closure
    return open(issue) && !anyLive(runs) && run?.status === 'completed' && !run.recovery?.required && !['quarantined', 'abandoned'].includes(run.integrity?.status) &&
      ['worktree-diff', 'commit'].includes(d?.action) && Boolean(d?.completedAt) && d?.reconstruction?.verified === true &&
      Boolean(d?.revision) && c?.revision === d.revision && c?.authorised === true && Object.values(c?.conditions ?? {}).every((v) => v === true) &&
      !run.artifactApplication?.verified && !run.integration?.mergeCommit
  },

  /** integrate.mjs:258 reconcileIntegration: only an interrupted publication is finished. */
  reconcileIntegration: ({ issue, run }) => open(issue) && ['publishing', 'published'].includes(run?.integration?.phase),

  /** issues.js:1159 createFollowUps: the run has a closure; the page offers it only for open risks without one. */
  followUps: ({ issue, run }, missing) => open(issue) && Boolean(run?.closure) && missing > 0,

  /**
   * issues.js:1280-1284 markArchived: no run live or paused, none with an undecided reconcile, none owing a
   * recovery; :1287 requireCleanupRecorded: none with open cleanup the barrier does not hold. Unknown counts as refused.
   */
  archive: ({ runs }) => (runs ?? []).every((r) => ![...LIVE, 'paused'].includes(r.status) && r.reconcilePending === false &&
    r.recoveryPending === false && r.cleanupUnrecorded === false),

  /**
   * owner-input.mjs:39,47-48: issue not packed; the run completed with questions for the owner, not yet answered.
   * The answer restarts the run's playbook (supervisor.mjs:368: refused while frozen when it writes the checkout).
   */
  ownerInput: ({ issue, run }) => open(issue) && admitsStartOf(issue, run) && run?.status === 'completed' && Boolean(run?.ownerInput) && !run.ownerInput.answer,

  /** issues.js:1557 addStepFile requires an unarchived issue; createStep needs the issue's folder (not packed). */
  addToIssue: ({ issue }) => open(issue)
}

/**
 * index.js:618-634 assess: a roster model must be verified, support the effort and not be held (advisor.mjs
 * askModel); the provider must be configured and not held (advisor.mjs decisionsFor). The provider's state is
 * read by pregate.current: an error there, or no reading at all, counts as not confirmed.
 */
export function assessable (view, choice, effort = null) {
  if (choice === 'provider') {
    const current = view?.current
    return Boolean(view?.assessors?.provider) && Boolean(current) && !current.error && current.configured !== false && current.reason !== 'provider-held'
  }
  // A failed availability lookup (availabilityError) is not "no hold": the model is unconfirmed.
  const m = (view?.assessors?.models ?? []).find((x) => x.id === choice)
  return Boolean(m?.verified && !m?.heldUntil && !m?.availabilityError && (effort == null || (m.efforts ?? []).includes(effort)))
}

/**
 * Why a pre-gate view cannot be shown as current, or null: a provider availability read that failed
 * (pregate.current.error) or a roster model whose availability lookup failed (availabilityError). The
 * panel reports such a read as failed, with this reason, never as ok.
 */
export function availabilityProblem (view) {
  if (view?.current?.error) return `unknown — could not read the decision provider's availability: ${view.current.error}`
  const m = (view?.assessors?.models ?? []).find((x) => x.availabilityError)
  return m ? `unknown — could not read the availability of ${m.title ?? m.id}: ${m.availabilityError}` : null
}

/** After a successful Delete: the page moves off the deleted run only if it is still the one selected. */
export const selectionAfterDelete = (selectedRunId, deletedRunId) => (selectedRunId === deletedRunId ? null : selectedRunId)
