import { additionRule, ownPathDrift, reconcileUnavailable } from './source-reconcile.mjs'

/*
 * Whether a run that just ended blocked at source delivery is reconciled
 * without being asked (supervisor.mjs announceEnd → finalize with reconcile).
 *
 * Every patch of a Boilerplate project touches its changelog, so a run whose
 * delivery met another landing's entry there was blocked although its work was
 * approved, and someone had to press Reconcile or land it by hand. The rule is
 * the project's own: only when EVERY drifted own path is one it declares
 * `append`/`prepend` (workspace.reconcile). A drift on any other path stays a
 * blocked run for a person, as before. One automatic attempt per run: a run
 * that already has a reconciliation (accepted or refused) is left alone, which
 * is also what stops announceEnd from re-entering after the attempt itself.
 * The attempt changes nothing it would not change when pressed: the merge must
 * carry the reviewed delta unaltered, and the configured checks run on the
 * merged candidate before it is delivered, unless all the drift is on paths
 * declared inert (engine.reconcileDelivery, which judges that on the whole
 * drift, not only these own paths).
 */
export function autoReconcileRefusal (run, policy) {
  const unavailable = reconcileUnavailable(run)
  if (unavailable) return unavailable
  if (run.reconciliations?.length) return 'a reconciliation was already attempted for this run'
  // reconcileDelivery refuses the same, but from inside finalize that refusal would be recorded as the run failing.
  const conditions = Object.entries(run.closure?.conditions ?? {})
  if (!run.closure?.authorised || !conditions.length || !conditions.every(([k, v]) => k === 'deliveryCompleted' || v === true)) return 'the candidate did not meet every closure condition but delivery'
  const drifted = ownPathDrift(run)
  const undeclared = drifted.filter((p) => !additionRule(policy, p))
  if (undeclared.length) return `drift on paths the project does not declare in workspace.reconcile: ${undeclared.join(', ')}`
  return null
}
