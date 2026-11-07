import { gatingResult, identifyCheckFailures } from './baseline-failures.mjs'
import { countsForClosure } from './modules-tier.mjs'

/*
 * An automatic reconcile applies and is undecided (auto-reconcile.mjs): the marker
 * is written with the block itself and cleared by whatever decides it. The status
 * is read too, so a run that failed, was abandoned or moved on never reads pending
 * from a leftover field. While this holds, no one is told the run settled.
 */
export const reconcilePending = (run) => run?.autoReconcile?.state === 'pending' && run.status === 'blocked' && run.blockedReason === 'source-delivery-blocked'

export const RECONCILABLE_BLOCKS = Object.freeze(['source-delivery-blocked', 'delivery-unverifiable'])

/** The approved patch's own paths a refused source application found changed. */
export function ownPathDrift (run) {
  const a = run.delivery?.application
  if (a?.state !== 'source-drift') return []
  if (a.drifted?.length) return a.drifted
  // Refused before `drifted` was recorded: the message names them.
  const m = /The approved patch's own paths changed: (.+?)\. /.exec(a.error ?? '')
  return m ? m[1].split(', ').filter((p) => p !== '…') : []
}

/** Why `reconcile-delivery` cannot run on this record, or null. */
export function reconcileUnavailable (run) {
  if (run.status !== 'blocked' || !RECONCILABLE_BLOCKS.includes(run.blockedReason)) return `this run is not blocked at source delivery (status ${run.status}, ${run.blockedReason ?? 'no block'})`
  if (run.delivery?.action !== 'apply-to-source') return 'only an apply-to-source delivery is reconciled with its source'
  if (!run.workspace?.path || run.workspace.state === 'removed') return 'the worktree is gone; nothing is left to reconcile'
  if (['quarantined', 'abandoned'].includes(run.integrity?.status) || run.recovery?.required) return 'the run needs its integrity or recovery resolved first'
  if (!ownPathDrift(run).length) return "delivery was not refused for drift on the approved patch's own paths; finalize once the cause is fixed"
  return null
}

/** `run.stoppedBy` of a run a service shutdown cancelled, and the reason its engine is cancelled with. */
export const SERVICE_SHUTDOWN = 'service-shutdown'

/** A cancellation the service caused and the next start has not yet tried to undo (supervisor.resumeInterrupted). */
export const awaitsAutoResume = (run) => run?.status === 'cancelled' && run.stoppedBy === SERVICE_SHUTDOWN && !run.abandonment && !run.autoResumeRefused

/**
 * A shutdown stopped this run before it had a workspace (preflight): there is no
 * work to keep and nothing to verify, so resuming it is doing its setup, from its
 * snapshot (supervisor.answer). A workspace path is set once provisioning began.
 */
/** A pause resumed by a plain resume: an operator's, or the daily full verification's freeze. */
export const RESUMABLE_PAUSES = ['manual', 'full-verification']
const resumablePause = (run) => run?.status === 'paused' && RESUMABLE_PAUSES.includes(run.pause?.kind)

export const awaitsSetup = (run) => !run?.workspace?.path &&
  (resumablePause(run) || (run?.status === 'cancelled' && run.stoppedBy === SERVICE_SHUTDOWN))

/** Resume is an explicit operator action; uncertain mutations still need recovery. */
export function resumeUnavailable (run) {
  if (run.abandonment || run.integrity?.status === 'abandoned') return 'This run was abandoned.'
  if (awaitsSetup(run) && !run.journal?.recoveryRequired && !run.recovery?.required) return null
  if (run.journal?.recoveryRequired || run.recovery?.required || run.integrity?.status !== 'clear') return 'Resolve the run’s recovery or integrity condition first.'
  if (Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return 'An invocation still needs recovery.'
  if (!run.workspace?.path || run.workspace.state === 'removed') return 'The saved workspace is no longer available.'
  if (run.release && !(resumablePause(run) && run.release.status === 'completed')) return 'Use the release recovery or finalization controls for this run.'
  if (run.status === 'paused') return resumablePause(run) ? null : 'Answer the pending question to continue this run.'
  // cleanup-unproved resumes only past a proof or an acknowledgement (engine.resumeExecution).
  if (run.status === 'blocked' && ['budget-exhausted', 'rounds-exhausted', 'protocol-repair-exhausted', 'owner-lost', 'cleanup-unproved'].includes(run.blockedReason)) return null
  if (run.status === 'failed' && /input_too_large|Input exceeds the maximum length/i.test(run.failures?.at(-1)?.evidence ?? '')) return 'Use Retry input to replace the rejected session and continue.'
  if (['failed', 'cancelled'].includes(run.status) && run.preflight?.state === 'passed') return null
  return 'Use the run’s decision, verification or finalization controls to resolve this condition.'
}

/*
 * Continue (engine.continueRun) reopens the review loop of a code run that
 * stopped at closure, with its candidate, sessions and reviews still on disk.
 * Resume does not fit there: replaying an unchanged record reaches the same
 * closure again. A run that never recorded a revision has nothing to continue.
 */
export const CONTINUABLE_BLOCKS = ['closure-conditions-unmet', 'refreshed-checks-failed', 'checks-failed-unchanged', 'checks-inconclusive']
export function continueUnavailable (run) {
  if (run.status !== 'blocked' || !CONTINUABLE_BLOCKS.includes(run.blockedReason)) return 'Only a run stopped at closure can be continued.'
  if (run.abandonment || run.integrity?.status === 'abandoned') return 'This run was abandoned.'
  if (run.journal?.recoveryRequired || run.recovery?.required || run.integrity?.status !== 'clear') return 'Resolve the run’s recovery or integrity condition first.'
  if (Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return 'An invocation still needs recovery.'
  if (run.release) return 'Use the release recovery or finalization controls for this run.'
  if (!run.workspace?.path || run.workspace.state === 'removed') return 'The saved workspace is no longer available.'
  if (!run.revisions?.length) return 'The run recorded no candidate to continue from.'
  return null
}

/*
 * A loop that ended only because the installed checks failed: every occupied
 * auditor approved the latest revision and its latest check did not pass —
 * as the gates count it: failures that are all baseline-known pass.
 * Rerunning the checks (refresh-checks) is what such a run needs; a flaky or
 * environmental failure cannot be fixed by another author round.
 */
export function checksOnlyBlock (run) {
  if (run.status !== 'blocked' || !['rounds-exhausted', 'checks-failed-unchanged', 'checks-inconclusive'].includes(run.blockedReason)) return false
  const revision = run.revisions?.at(-1)?.fingerprint
  const auditors = Object.keys(run.participants ?? {}).filter((role) => role.startsWith('auditor-'))
  const check = (run.checkResults ?? []).filter((c) => c.revision === revision).at(-1)
  return Boolean(revision) && auditors.length > 0 && auditors.every((role) => (run.approvals ?? []).some((a) => a.role === role && a.revision === revision)) &&
    Boolean(check) && gatingResult(check, run) !== 'passed'
}

/*
 * Refresh checks (engine.refreshClosureChecks) and the list of a run's actions
 * both ask this. Whether the strategy is tactical and whether a check target
 * exists are not on the run record: the engine passes what it holds, a view
 * passes refreshFacts(snapshot), and a caller that does not consult refresh-checks
 * passes nothing.
 */
export function refreshChecksUnavailable (run, { tactic = true, target = true } = {}) {
  if (run.status !== 'blocked' || !(['closure-conditions-unmet', 'refreshed-checks-failed'].includes(run.blockedReason) || checksOnlyBlock(run)) || !tactic || run.release) return 'Only a retained code run blocked at closure, or stopped only by failed checks on an approved revision, can refresh checks'
  if (!target || run.integrity?.status !== 'clear' || run.recovery?.required || Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return 'Check refresh needs a configured target and clear integrity'
  if (!run.workspace?.path || run.workspace.state === 'removed') return 'The saved workspace is no longer available.'
  if (!run.revisions?.at(-1)?.fingerprint) return 'No candidate revision exists'
  return null
}

/** What refreshChecksUnavailable needs from a run's frozen snapshot; none readable means no refresh. */
export const refreshFacts = (snapshot) => ({ tactic: Boolean(snapshot?.tactic), target: Boolean(snapshot?.checks?.target) })

/*
 * Accept check result and deliver (engine.acceptCheckResult): an operator's or
 * supervisor's decision that named failures of the check on an approved revision
 * do not stop its delivery. Closure counts only the full drive, so a smoke result
 * alone identifies nothing. This is the sync gate the action list and the engine
 * share; what a stop's coordinator confirmation says is the engine's to read.
 */
const ACCEPTABLE_BLOCKS = ['closure-conditions-unmet', 'refreshed-checks-failed', 'rounds-exhausted', 'checks-failed-unchanged', 'checks-inconclusive']

/** The revision, and what accepting its latest full check would have to name. */
export function acceptableCheck (run) {
  const revision = run.revisions?.at(-1)?.fingerprint ?? null
  const check = (run.checkResults ?? []).filter((c) => c.revision === revision && countsForClosure(c)).at(-1) ?? null
  return { revision, check, ...identifyCheckFailures(check, run) }
}

export function acceptCheckUnavailable (run, { tactic = true } = {}) {
  if (run.status !== 'blocked' || !ACCEPTABLE_BLOCKS.includes(run.blockedReason) || !tactic) return 'Only an approved code run stopped by its checks can have a check result accepted.'
  if (run.release) return 'Use the release recovery or finalization controls for this run.'
  if (run.landed) return 'This run was already landed by hand.'
  if (run.abandonment || run.integrity?.status === 'abandoned') return 'This run was abandoned.'
  if (run.journal?.recoveryRequired || run.recovery?.required || run.integrity?.status !== 'clear') return 'Resolve the run’s recovery or integrity condition first.'
  if (Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return 'An invocation still needs recovery.'
  if (!run.workspace?.path || run.workspace.state === 'removed') return 'The saved workspace is no longer available.'
  const { revision, unidentified } = acceptableCheck(run)
  if (!revision) return 'No candidate revision exists.'
  const auditors = Object.keys(run.participants ?? {}).filter((role) => role.startsWith('auditor-'))
  const missing = auditors.filter((role) => !(run.approvals ?? []).some((a) => a.role === role && a.revision === revision))
  if (!auditors.length || missing.length) return `The reviewers did not approve this revision${missing.length ? ` (${missing.join(', ')})` : ''}.`
  const findings = (run.outstandingFindings ?? []).filter((f) => f.blocking).map((f) => f.id)
  if (findings.length) return `Blocking findings are outstanding: ${findings.join(', ')}.`
  if (run.blockedReason === 'closure-conditions-unmet') {
    const closure = run.closure
    if (closure?.revision !== revision || closure.drifted) return 'The closure record does not describe this revision.'
    if (closure.conditions?.checksSatisfied !== false) return 'The checks are not what stopped this run at closure.'
    const others = Object.entries(closure.conditions).filter(([name, met]) => !met && !['checksSatisfied', 'deliveryCompleted'].includes(name)).map(([name]) => name)
    if (others.length) return `Other closure conditions are unmet: ${others.join(', ')}.`
  }
  if (unidentified.length) return `The check failure is not identified: ${unidentified.join('; ')}.`
  return null
}

/** Whether a check's failures are all ones this acceptance named: a failure nobody named was never accepted. */
export function acceptanceCovers (acceptance, check, run) {
  const { failures, notRun, unidentified } = identifyCheckFailures(check, run)
  const named = new Set((acceptance.failures ?? []).map((f) => f.key))
  return !unidentified.length && failures.every((f) => named.has(f.key)) && notRun.every((id) => (acceptance.notRun ?? []).includes(id))
}

/*
 * What the top-level supervisor may accept (docs/top-level-supervisor.md "Accepting a
 * check result"). Named test failures, each new against a compared base, on a playbook
 * that already closes on review-only evidence; anything broader changes the agreed
 * rules and goes to the operator. The limit is a chosen number, not a derived one.
 */
export const SUPERVISOR_ACCEPT_LIMIT = 3
export function supervisorAcceptRefusal ({ failures = [], notRun = [] }, { minimumVerification } = {}) {
  if (minimumVerification !== 'review-only') return 'This playbook closes only on passed checks; waiving that is the operator\'s decision.'
  const wide = failures.filter((f) => f.level !== 'test').map((f) => f.key)
  if (wide.length) return `The supervisor accepts only named test failures, not a whole command, timeout, crash or suite: ${wide.join(', ')}.`
  const unjudged = failures.filter((f) => f.basis !== 'new').map((f) => f.key)
  if (unjudged.length) return `The supervisor accepts only failures compared with the base; these were not judged: ${unjudged.join(', ')}.`
  if (notRun.length) return `Required commands did not run: ${notRun.join(', ')}. Accepting that is the operator's decision.`
  if (failures.length > SUPERVISOR_ACCEPT_LIMIT) return `The supervisor accepts at most ${SUPERVISOR_ACCEPT_LIMIT} failures; this check has ${failures.length}.`
  return null
}

/** Retry input (engine.retryInputFailure): a confirmed input-size rejection on a run with nothing else to settle. */
export function retryInputUnavailable (run) {
  const failure = run.failures?.at(-1)
  if (run.status !== 'failed' || !/input_too_large|Input exceeds the maximum length/i.test(failure?.evidence ?? '')) return 'Only a confirmed input-size rejection can use this retry'
  if (run.release || run.recovery?.required || run.integrity?.status !== 'clear' || Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return 'Run requires recovery before retry'
  if (run.workspace?.state === 'removed') return 'The saved workspace is no longer available.'
  if (!Number.isFinite(Date.parse(run.endedAt ?? failure.at))) return 'The failed run has no recorded stop time'
  return null
}

/** Integration (integrate.mjs) of a committed, verified, not-yet-integrated candidate; what it reads off the record. */
export function integrateUnavailable (run) {
  if (['quarantined', 'abandoned'].includes(run.integrity?.status) || run.recovery?.required) return 'source integrity requires an explicit recovery disposition before integration'
  if (['publishing', 'published'].includes(run.integration?.phase)) return 'a previous publication is unfinished; it is reconciled at startup, or reconcile it explicitly before approving again'
  if (run.integration?.mergeCommit) return `already integrated as ${run.integration.mergeCommit.slice(0, 12)} into ${run.integration.targetBranch}`
  const delivery = run.delivery
  if (!delivery?.completedAt || delivery.action !== 'commit' || !delivery.commit) return 'this run has no committed, verified candidate to integrate'
  if (delivery.reconstruction?.verified !== true) return 'the delivered commit was not verified against the revision'
  return null
}

/*
 * The run was live when the process driving it disappeared — a restart, not a
 * failure of the run. Records written before `ownerLost` existed carry only the
 * reason text markUnowned wrote.
 */
export function ownerLost (run) {
  return run?.status === 'blocked' && run.blockedReason === 'recovery-required' && run.recovery?.required === true &&
    (run.recovery.ownerLost === true || /when its owner disappeared/.test(run.recovery.reason ?? ''))
}

/** Owner loss that `recover` may continue: nothing else about the run needs a person. */
export function ownerLossRecoverable (run) {
  return ownerLost(run) && !run.abandonment && !run.release && !run.journal?.recoveryRequired &&
    run.integrity?.status === 'clear' && Boolean(run.workspace?.path) && run.workspace.state !== 'removed'
}
