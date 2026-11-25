/*
 * What the issue page says about a delivery-like action's answer (Finalize, Reconcile, Apply patch, Merge).
 * During a full verification such an action is accepted and waits for the cycle to end (server cycle-gates.mjs):
 * `{ status: 'waiting', cycleId }` is work in progress, never an error.
 */

/** A notice for an accepted action that waits for a full verification, else null. */
export function waitingNotice (result) {
  if (result?.status !== 'waiting') return null
  const before = result.waitingFor === 'reconcile' ? 'reconciling' : ['integrate', 'integration-reconcile'].includes(result.waitingFor) ? 'merging' : 'delivering'
  return `Accepted: waiting for full verification ${result.cycleId ?? ''} before ${before}. It goes on by itself when the cycle ends.`.replace('  ', ' ')
}
