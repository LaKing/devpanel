import { inspectSourceRepository } from './runtime/source-repository.mjs'
import { locksModules } from './runtime/module-locks.mjs'

/*
 * Could a run start here, and if not, what exactly is in the way?
 *
 * Admission checks the budget first and stops there, which is right — doing
 * filesystem work for a start that is refused anyway is waste. But it means a
 * budget-blocked supervisor never re-reads the source, so the only fault it can
 * describe is the last one it happened to see. That is how a repository fault
 * fixed days ago got reported as a current blocker, with a remedy that would
 * have changed nothing.
 *
 * This answers the question without taking anything: it reserves no start,
 * spends no allowance, and touches no state. Each condition is reported on its
 * own terms, so "the budget is exhausted" and "the checkout has no commits" are
 * two facts rather than one story, and neither hides the other.
 */

/** Ownership as a fact about now, separate from whether the repository is usable. */
function ownershipOf (fault) {
  if (!fault) return { status: 'valid', detail: 'git reads this checkout as the panel\'s own user' }
  if (fault.code === 'UNSAFE_REPOSITORY') return { status: 'refused-by-git', detail: fault.message }
  if (fault.code === 'NOT_A_REPOSITORY') return { status: 'not-applicable', detail: 'there is no repository to own' }
  // git read the repository, so whatever else is wrong, ownership was not it.
  return { status: 'valid', detail: 'git read this checkout, so ownership is not what blocks it' }
}

/**
 * Two readings, deliberately distinct.
 *
 * Without a playbook this reports only what holds for ANY configuration, and
 * says so by calling its verdict `baselineReady` rather than runnable: whether a
 * particular playbook could run also depends on its own base policy, and that
 * has not been looked at. Name a playbook and its configuration is resolved and
 * its source policy evaluated too — `DIRTY_BASE` and the rest — reported
 * separately, under the configHash it belongs to.
 *
 * Neither reading is a launch guarantee. Both are observations of a checkout
 * that can change a second later, which is why `start_run` re-checks every
 * condition for itself and why an observation is not a substitute for a preview.
 *
 * @param projectPath  the checkout to read
 * @param budget       remainingBudget(state), or null when it does not apply
 * @param perIssueLeft starts left for this issue, when one was named
 * @param playbook     resolve and evaluate this configuration's source policy too
 * @param resolve      resolvePlaybook, injected so this module stays testable
 * @param inspectLaunch  inspectLaunchState, likewise
 * @param pathOverlap  ({ deliveryAction }) => the reading of runtime/path-overlap.mjs
 * @param moduleLocks  () => supervisor.moduleLockReading: the project's module pool and its locks
 */
export async function launchReadiness ({
  project, issueId = null, projectPath, budget = null, perIssueLeft = null,
  playbook = null, runOptions = {}, resolve = null, inspectLaunch = null, pathOverlap = null, moduleLocks = null,
  now = Date.now(), inspect = inspectSourceRepository
}) {
  const fault = await inspect({ projectPath })
  const prerequisites = []

  const starts = budget?.starts ?? null
  if (starts?.exhausted) {
    prerequisites.push({
      condition: 'budget',
      state: `${starts.used} start(s) used against this session's cap of ${starts.limit}`,
      needs: 'an operator raises maxRuns on Start or begins a New session',
      // Said plainly because the supervisor cannot do either itself: the
      // allowance is the operator's to renew.
      note: 'Start and a server restart resume this session\'s allowance; only an operator\'s New session opens a fresh one'
    })
  }
  if (perIssueLeft === 0) {
    prerequisites.push({ condition: 'per-issue retries', state: 'this issue has used its start allowance for this session', needs: 'an operator raises maxStartsPerIssue on Start or begins a New session' })
  }
  if (fault) {
    prerequisites.push({
      condition: 'repository',
      state: fault.message,
      needs: fault.remedy,
      resolvableBy: fault.resolvableBy
    })
  }

  // Only asked about when a playbook is named — and only reachable at all if git
  // could read the repository, since a base policy over an unreadable checkout
  // is not a question with an answer.
  let configuration = null
  if (playbook) {
    configuration = await inspectConfiguration({ playbook, runOptions, project, projectPath, fault, resolve, inspectLaunch, now })
  }

  // Not a prerequisite: nothing here refuses a start, so baselineReady does not hear of it.
  const overlap = pathOverlap ? await pathOverlap({ deliveryAction: configuration?.delivery?.action ?? null }) : null

  // The module pool's locks (module-locks.mjs). A module the issue's triage named that another
  // live run holds refuses a coding playbook's start, so with such a playbook named it is a
  // prerequisite of that configuration; otherwise it is reported beside the reading.
  const locks = moduleLocks ? await Promise.resolve().then(moduleLocks).catch((error) => ({ unavailable: error.message })) : null
  if (locks?.conflicts?.length && configuration?.locksModules) {
    configuration.prerequisites.push({ condition: 'module-lock', state: locks.conflicts.map((c) => `${c.module} is locked by run ${c.runId} of ${c.project}/${c.issueId}`).join('; '), needs: 'the holding run ends (the supervisor\'s ready queue waits for it: blockedBy module-lock)', holders: locks.conflicts })
    configuration.ready = false
  }

  return {
    project,
    issueId,
    checkedAt: new Date(now).toISOString(),
    // Read now, not remembered. This is the whole point of the action.
    repository: { ok: !fault, code: fault?.code ?? null, message: fault?.message ?? 'a run can be cut from this checkout', detail: fault?.detail ?? null },
    ownership: ownershipOf(fault),
    budget: starts ? { starts, ...(perIssueLeft == null ? {} : { startsRemainingForThisIssue: perIssueLeft }) } : null,
    // Not "runnable". These are the conditions that hold for any configuration;
    // a playbook's own base policy is a separate question, answered only when one
    // is named.
    baselineReady: prerequisites.length === 0,
    prerequisites,
    configuration,
    ...(overlap ? { pathOverlap: overlap } : {}),
    ...(locks ? { moduleLocks: locks } : {}),
    means: 'Each condition is current and independent: a repository fault does not imply a budget fault, and neither is evidence about the other. Anything not listed in prerequisites was checked and found in order. baselineReady covers only what holds for every configuration — it is not launchability, and a playbook whose base policy has not been evaluated may still be refused. pathOverlap, when present, is apart from all of this: files of this candidate another project\'s live run is touching, which refuses nothing.',
    detail: 'This reserves nothing and spends no allowance, and it is an observation, not a guarantee: the checkout can change a moment later, so start_run re-checks every condition for itself. It is also not a preview — a preview binds a configuration, and one taken before these conditions changed is not evidence that a run is launchable now.'
  }
}

/** The selected configuration's own source policy, under the hash it belongs to. */
async function inspectConfiguration ({ playbook, runOptions, project, projectPath, fault, resolve, inspectLaunch, now }) {
  const observedAt = new Date(now).toISOString()
  if (!resolve || !inspectLaunch) return { playbook, ready: false, prerequisites: [{ condition: 'configuration', state: 'this service cannot resolve a configuration', needs: 'ask for the baseline reading only' }], observedAt }

  const resolution = await resolve(playbook, { runOptions, projectId: project })
  if (!resolution?.ok) {
    return {
      playbook, configHash: null, ready: false, observedAt,
      prerequisites: [{ condition: 'configuration', state: (resolution?.errors ?? []).map((e) => e.message).join('; ') || 'the playbook does not resolve', needs: 'fix the configuration, or choose another playbook' }]
    }
  }
  const resolved = resolution.resolved
  const action = resolved.workspace?.isolation === 'in-place' ? 'in-place' : resolved.completion?.delivery?.action
  const writesSource = ['apply-to-source', 'in-place'].includes(action)
  const identity = { playbook, intent: resolved.intent?.id ?? null, configHash: resolved.configHash, base: resolved.workspace?.base ?? 'head', locksModules: locksModules(resolved),
    delivery: { action: action ?? null, destination: writesSource ? projectPath : null, writesSource,
      authority: writesSource ? 'Starting this playbook authorizes engine-owned source writes at this destination and the bound Git-owner checkouts behind its materialized symlinks.' : 'This delivery does not update the project checkout.' } }

  // A base policy over a checkout git cannot read is not a question with an
  // answer; saying "unevaluated" is honest, inventing a verdict is not.
  if (fault) {
    return { ...identity, ready: false, observedAt, prerequisites: [{ condition: 'base policy', state: 'not evaluated: the repository fault above must be cleared first', needs: 'clear the repository fault, then read again' }] }
  }

  const condition = await inspectLaunch({ projectPath, workspace: resolved.workspace, configHash: resolved.configHash })
  const prerequisites = condition?.blockedReason
    ? [{ condition: 'base policy', state: condition.blockedReason, needs: condition.code === 'DIRTY_BASE' ? 'clean the checkout, commit it, or select another base policy for the run' : 'clear the condition named above', code: condition.code ?? null, resolvableBy: condition.resolvableBy ?? null }]
    : []
  return {
    ...identity,
    observed: {
      // What the source was when it was read. The fingerprint is the engine's own
      // launch-condition key: if it differs at start time, the source moved.
      head: condition?.head ?? null,
      sourceFingerprint: condition?.key ?? null,
      at: observedAt
    },
    observedAt,
    ready: prerequisites.length === 0,
    prerequisites
  }
}
