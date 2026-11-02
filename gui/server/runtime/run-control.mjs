import { gatingResult } from './baseline-failures.mjs'

/** Resume is an explicit operator action; uncertain mutations still need recovery. */
export function resumeUnavailable (run) {
  if (run.abandonment || run.integrity?.status === 'abandoned') return 'This run was abandoned.'
  if (run.journal?.recoveryRequired || run.recovery?.required || run.integrity?.status !== 'clear') return 'Resolve the run’s recovery or integrity condition first.'
  if (Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return 'An invocation still needs recovery.'
  if (!run.workspace?.path || run.workspace.state === 'removed') return 'The saved workspace is no longer available.'
  if (run.release && !(run.status === 'paused' && run.pause?.kind === 'manual' && run.release.status === 'completed')) return 'Use the release recovery or finalization controls for this run.'
  if (run.status === 'paused') return run.pause?.kind === 'manual' ? null : 'Answer the pending question to continue this run.'
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
