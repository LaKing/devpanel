/*
 * Several issues of one project may run at once: the resources they share have
 * their own guards (the delivery lock, the drive cap per staging host). Two kinds
 * of run share something no other guard covers, so they stay apart.
 *
 *  - An in-place run's workspace IS the project checkout. Nothing else may write
 *    there, deliver there or snapshot it while it runs.
 *  - A release-tactic run (staging, deployment) has its verifiers examine what it
 *    released, and can restore over it, after the release lock has gone
 *    (release.mjs). A second one would release under those verifiers.
 *
 * What a run is comes from its resolved snapshot. One that cannot be read conflicts
 * with everything: it is unknown, and a live owner is holding it.
 */

export const NOT_EXCLUSIVE = Object.freeze({ inPlace: false, release: false })

export const exclusivityOf = (resolved) => resolved
  ? { inPlace: resolved.workspace?.isolation === 'in-place', release: ['staging', 'deployment'].includes(resolved.tactic) }
  : { unknown: true }

/**
 * Whether a run can write the project's checkout, which is what the full verification's freeze
 * pauses (execution-contract.md "Full verification freeze"): it works in place, it releases
 * (staging, deployment), or its playbook delivers anything. A run that cannot be read is
 * treated as writing. Analysis, Triage and inquiries (no delivery, own worktree) only read.
 */
export const writesCheckout = (resolved) => !resolved || resolved.workspace?.isolation === 'in-place' ||
  ['staging', 'deployment'].includes(resolved.tactic) || (resolved.completion?.delivery?.action ?? 'none') !== 'none'

export const conflicts = (mine, theirs) => Boolean(mine.unknown || theirs.unknown || mine.inPlace || theirs.inPlace || (mine.release && theirs.release))

export const conflictMessage = (holder) => `this run cannot share the project with the live run of issue ${holder.issueId} (an in-place run holds the checkout; release runs keep the staging or deployment target); wait for it to finish`
