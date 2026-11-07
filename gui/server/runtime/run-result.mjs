// Run disposition is distinct from whether the issue was resolved. Deriving it
// from the final validated turn also supports runs recorded before this view.
//
// `run.outcome` stays the engine's closure record (resolved = the completion
// checklist passed). The result names what a closed run ACHIEVED, in the words
// of its playbook, so a finished analysis reads "reported", never "resolved":
// only an issue's disposition says whether the problem is gone.
//
//   reported     an analysis report was accepted by its coordinator
//   triaged      the triage decision itself (accepted, duplicate, ...)
//   delivered    an approved revision reached the source checkout; `manual-landing`
//                when a person recorded that they landed it by hand (run.landed)
//   artifact-ready  an approved patch is retained, the source is not updated
//   staged       the candidate was installed and test-driven on staging
//   deployed     the release was applied and verified
//   completed    closure reached with nothing more specific to say
//   needs-input  triage asked the owner first (run.ownerInput); no work started
//   incomplete   closure not reached; blockedReason says why
/** Whether a Staging run's release passed: its operations completed, and its coordinator and verifiers accepted it. */
export const stagedReleasePassed = (receipt, run) => receipt?.tactic === 'staging' && receipt.status === 'completed' && run?.status === 'completed' && run.outcome === 'resolved'

export const SUCCESS_RESULTS = ['reported', 'delivered', 'artifact-ready', 'staged', 'deployed', 'completed']

const REPORT_LABELS = {
  accepted: (n) => `Report accepted — ${n} finding${n === 1 ? '' : 's'}`,
  duplicate: () => 'Report accepted — duplicate of an existing issue',
  'needs-information': () => 'Report needs information',
  rejected: () => 'Report rejected',
  'no-findings': () => 'Report accepted — no findings'
}

const failureNames = (a) => (a.failures ?? []).map((f) => f.key).join(', ')

/** The accepted check risk in words: which failures, who, and why (engine.acceptCheckResult). */
export function acceptedRiskWords (a) {
  const n = a.failures?.length ?? 0
  return `${a.by} accepted ${n === 1 ? 'a failed check' : `${n} failed checks`} (${failureNames(a)}). Reason: ${a.reason}${a.notRun?.length ? ` Required commands that did not run because of ${n === 1 ? 'it' : 'them'}: ${a.notRun.join(', ')}.` : ''}`
}

/** An acceptance that was asked for and refused, while that still describes the run; otherwise null. */
export function refusedAcceptance (run) {
  const last = run.checkAcceptanceRefusals?.at(-1)
  return last && !last.closedAt && run.status === 'blocked' && last.revision === run.revisions?.at(-1)?.fingerprint ? last : null
}

export function runResult (run, outputs) {
  const result = judgedResult(run, outputs)
  const accepted = run.closure?.acceptedCheckRisk
  if (accepted) {
    const lead = result.result === 'delivered' || result.result === 'artifact-ready' ? result.resultLabel : 'Not delivered'
    return { ...result, resultLabel: `${lead} — ${accepted.by} accepted check failures ${failureNames(accepted)}. Reason: ${accepted.reason}`, acceptedCheckRisk: accepted }
  }
  if (refusedAcceptance(run)) return { ...result, resultLabel: 'Check result not accepted: the coordinator did not confirm' }
  return result
}

function judgedResult (run, outputs) {
  if (run.journal?.recoveryRequired) return { result: null, resultReason: 'event-journal-recovery-required' }
  // A person's explicit claim (supervisor.markLanded), never inferred from the
  // source repository; outcome, closure and approvals stay as the engine left them.
  if (run.landed) return { result: 'delivered', resultReason: 'manual-landing', resultLabel: `Landed by hand by ${run.landed.by}` }
  if (run.artifactApplication?.verified === true) return { result: 'delivered', resultReason: 'artifact-applied', resultLabel: 'Source updated — retained patch applied' }
  if (run.status === 'completed' && run.delivery?.action === 'worktree-diff' && run.delivery.completedAt) {
    return { result: 'artifact-ready', resultReason: 'patch-only-delivery', resultLabel: 'Patch ready — source not updated' }
  }
  const triage = ['triage', 'coordinated-triage'].includes(run.playbook?.strategy)
  const disposition = run.reportDisposition
  const recorded = disposition && outputs?.[disposition.byStep]
  if (triage && recorded?.valid === true &&
      ['reportDisposition', 'triageDisposition'].includes(recorded.contract) &&
      recorded.output?.disposition === disposition.disposition) {
    const labels = {
      accepted: 'Confirmed — ready for implementation',
      duplicate: 'Duplicate — existing issue linked',
      'needs-information': 'Needs information',
      rejected: 'Report rejected',
      'no-findings': 'No findings'
    }
    if (run.status === 'completed' && run.outcome === 'resolved') {
      return { result: disposition.disposition, resultReason: 'triage-disposition', resultLabel: labels[disposition.disposition], resultSummary: disposition.response }
    }
    // Explain historical runs without rewriting their recorded outcome or
    // treating unrelated runtime/integrity failures as successful triage.
    if (run.status === 'blocked' && run.blockedReason === 'closure-conditions-unmet' &&
        !run.revisions?.length && run.closure?.conditions?.coordinatorConfirmation === false) {
      return { result: 'incomplete', resultReason: 'triage-completion-mismatch',
        resultLabel: `${disposition.disposition === 'accepted' ? 'Confirmed' : 'Disposition recorded'} — triage completion blocked`,
        resultSummary: 'The report was assessed, but this older workflow required implementation criteria to pass. The issue remains open; no fix was produced.' }
    }
  }
  if (run.status === 'completed' && run.outcome === 'resolved') return achieved(run, triage, outputs)
  // A partial or hand-written record has no steps; that is "unknown", not a crash.
  const last = Array.isArray(run.steps) ? run.steps.at(-1) : null
  const output = last && outputs?.[last.number]
  const rejected = run.status === 'completed' && run.outcome === 'unresolved' &&
    output?.valid === true && output.contract === 'triageResult' && output.output?.fit === false
  if (rejected) return { result: 'rejected', resultReason: 'triage-rejected' }
  // Triage judged that one run could not finish this without the owner.
  if (run.status === 'completed' && run.outcome === 'unresolved' && run.ownerInput) {
    const split = run.ownerInput.verdict === 'too-large'
    return { result: 'needs-input', resultReason: split ? 'owner-split' : 'owner-questions',
      resultLabel: run.ownerInput.answer?.startError ? 'Answered — next run not started' : run.ownerInput.answer?.split === 'accept' ? 'Split into new issues' : run.ownerInput.answer ? 'Answered — continued in a new run' : split ? 'Too large for one run — split proposed' : 'Waiting for your answers — no work started' }
  }
  return { result: run.outcome === 'unresolved' ? 'incomplete' : (run.outcome ?? null), resultReason: null }
}

// What a closed run achieved. Read off the record, so runs written before
// this vocabulary existed get the same words.
function achieved (run, triage, outputs) {
  const report = run.reportDisposition
  if (report && !triage) {
    const count = Array.isArray(report.issues) ? report.issues.length : 0
    // Receipts written before titles were kept on them: the title is in the
    // coordinator's recorded output, matched by the finding's key.
    const written = outputs?.[report.byStep]?.output?.issues ?? []
    const titleOf = (i) => i.title ?? written.find((w) => w.key === i.key)?.title ?? null
    return { result: 'reported', resultReason: `report-${report.disposition}`,
      resultLabel: (REPORT_LABELS[report.disposition] ?? (() => 'Report recorded'))(count),
      resultSummary: report.response ?? null,
      findings: (report.issues ?? []).map((i) => ({ key: i.key ?? null, title: titleOf(i), kind: i.kind ?? null, issueId: i.issueId ?? null }))
    }
  }
  const strategy = run.playbook?.strategy
  if (strategy === 'staging') return { result: 'staged', resultReason: null, resultLabel: 'Staged — candidate installed and test-driven' }
  // A deployment run released to staging only (its default environment) staged; production, or both, deployed.
  if (strategy === 'deployment' && run.release?.tactic === 'staging' && !run.productionRelease) return { result: 'staged', resultReason: 'staging-environment', resultLabel: 'Staged — candidate installed and test-driven' }
  if (strategy === 'deployment') return { result: 'deployed', resultReason: run.productionRelease ? 'staging-then-production' : null, resultLabel: run.productionRelease ? 'Deployed — staged, then promoted to production' : 'Deployed — release applied and verified' }
  if (run.delivery?.completedAt && run.revisions?.length) {
    if (run.delivery.action === 'in-place') return { result: 'delivered', resultReason: 'in-place', resultLabel: 'Changed in place — project checkout' }
    return { result: 'delivered', resultReason: run.delivery.action ?? null, resultLabel: 'Source updated — approved patch applied' }
  }
  return { result: 'completed', resultReason: null, resultLabel: 'Closure reached' }
}
