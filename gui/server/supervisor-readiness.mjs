import { inspectSourceRepository } from './runtime/source-repository.mjs'
import { locksModules } from './runtime/module-locks.mjs'
import { modulesTiming } from './runtime/modules-tier.mjs'
import { refusedSeatPrerequisite } from './runtime/refused-seat.mjs'

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
 * @param modulesCoverage  (target) => supervisor.modulesCoverage: what the named playbook's modules tier would test
 * @param stagingSyncs  () => sync-records.mjs standingSyncs: dependency syncs standing on staging hosts
 * @param refusedSeat  () => refused-seat.mjs latestRefusal: the issue's latest recorded provider refusal
 */
export async function launchReadiness ({
  project, issueId = null, projectPath, budget = null, perIssueLeft = null,
  playbook = null, runOptions = {}, resolve = null, inspectLaunch = null, pathOverlap = null, moduleLocks = null, modulesCoverage = null, stagingSyncs = null, refusedSeat = null,
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
    configuration = await inspectConfiguration({ playbook, runOptions, project, projectPath, fault, resolve, inspectLaunch, modulesCoverage, refusedSeat, now })
  }

  // Not a prerequisite: nothing here refuses a start, so baselineReady does not hear of it.
  const overlap = pathOverlap ? await pathOverlap({ deliveryAction: configuration?.delivery?.action ?? null }) : null

  // The module pool's locks (module-locks.mjs). A module the issue's triage named that another
  // live run holds refuses a coding playbook's start, so with such a playbook named it is a
  // prerequisite of that configuration; otherwise it is reported beside the reading.
  const locks = moduleLocks ? await Promise.resolve().then(moduleLocks).catch((error) => ({ unavailable: error.message })) : null
  if (locks?.conflicts?.length && configuration?.locksModules) {
    configuration.prerequisites.push({ condition: 'module-lock', state: locks.conflicts.map((c) => c.reserved ? `${c.module} is reserved by run ${c.runId} of ${c.project}/${c.issueId}, ${c.state === 'interrupted' ? 'interrupted by a service shutdown' : `waiting since ${c.since}`}${c.behind?.length ? ` behind run ${c.behind.join(', ')}` : ''}` : `${c.module} is locked by run ${c.runId} of ${c.project}/${c.issueId}`).join('; '), needs: 'the holding run ends (the supervisor\'s ready queue waits for it: blockedBy module-lock)', holders: locks.conflicts })
    configuration.ready = false
  }

  // Dependencies a run installed on a staging host's whole stage, standing now (sync-records.mjs):
  // the stage deviates from its deployed set, and other runs' instance creates wait or are refused.
  const syncs = stagingSyncs ? await Promise.resolve().then(stagingSyncs).catch((error) => ({ unavailable: error.message })) : null

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
    ...(Array.isArray(syncs) ? (syncs.length ? { stagingSyncs: syncs } : {}) : syncs ? { stagingSyncs: syncs } : {}),
    means: 'Each condition is current and independent: a repository fault does not imply a budget fault, and neither is evidence about the other. Anything not listed in prerequisites was checked and found in order. baselineReady covers only what holds for every configuration — it is not launchability, and a playbook whose base policy has not been evaluated may still be refused. pathOverlap, when present, is apart from all of this: files of this candidate another project\'s live run is touching, which refuses nothing. stagingSyncs, when present, is information too: dependency syncs standing on a staging host now, each naming the run that installed them, the manifests the stage deviates by, its state and whether a live process answers for it (held: its drive reverts it as it ends). configuration.modulesTiming, when present, says when the playbook\'s modules tier drives: every-revision (each revision, beside its reviews) or approved (only a revision its round approved, or whose every substantial finding awaits the check). A configuration prerequisite with category information (refused-seat: the issue\'s latest run recorded a provider refusal on a seat this start fills with the same model) is reported and never makes the configuration unready. configuration.modulesCoverage, likewise information: what the playbook\'s modules tier would test for the issue\'s newest recorded change set or expected paths (nothing: the gate will be inconclusive; unknown: no evidence, never a claim of nothing).',
    detail: 'This reserves nothing and spends no allowance, and it is an observation, not a guarantee: the checkout can change a moment later, so start_run re-checks every condition for itself. It is also not a preview — a preview binds a configuration, and one taken before these conditions changed is not evidence that a run is launchable now.'
  }
}

/** The selected configuration's own source policy, under the hash it belongs to. */
async function inspectConfiguration ({ playbook, runOptions, project, projectPath, fault, resolve, inspectLaunch, modulesCoverage = null, refusedSeat = null, now }) {
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
  // An engine-only playbook (config/load.mjs) has no workspace, delivery or seats to read. One naming an engine program
  // (the full verification) is started by an operator from the panel, never by the supervisor; any other cannot start.
  if (resolved.kind === 'engine-only') {
    return { playbook, kind: resolved.kind, configHash: resolved.configHash, ready: false, observedAt,
      prerequisites: resolved.engineProgram
        ? [{ condition: 'entrance', state: `engine program ${resolved.engineProgram}: started by an operator from the panel`, needs: 'an operator starts it; the supervisor does not start engine-only playbooks' }]
        : resolved.liveExecution.blockers.map((b) => ({ condition: 'configuration', state: b.reason, needs: b.remedy })) }
  }
  const action = resolved.workspace?.isolation === 'in-place' ? 'in-place' : resolved.completion?.delivery?.action
  const writesSource = ['apply-to-source', 'in-place'].includes(action)
  const identity = { playbook, intent: resolved.intent?.id ?? null, configHash: resolved.configHash, base: resolved.workspace?.base ?? 'head', locksModules: locksModules(resolved),
    delivery: { action: action ?? null, destination: writesSource ? projectPath : null, writesSource,
      authority: writesSource ? 'Starting this playbook authorizes engine-owned source writes at this destination and the bound Git-owner checkouts behind its materialized symlinks.' : 'This delivery does not update the project checkout.' } }
  // What its modules tier would test (modules-coverage.mjs): information only, never a prerequisite.
  const coverage = modulesCoverage ? await Promise.resolve().then(() => modulesCoverage(resolved.checks?.target)).catch((error) => ({ state: 'unavailable', detail: error.message })) : null
  if (coverage) identity.modulesCoverage = coverage
  // When its modules tier drives: every-revision (beside the reviews) or approved (after the round approves).
  const timing = modulesTiming(resolved.checks?.target)
  if (timing) identity.modulesTiming = timing
  // The issue's latest run recorded a provider refusal on a seat this configuration fills with the
  // same model (refused-seat.mjs): an information prerequisite, never a reason to be unready.
  const refusal = refusedSeat ? await Promise.resolve().then(refusedSeat).catch(() => null) : null
  const refused = refusedSeatPrerequisite(refusal, resolved.participants)
  const information = refused ? [{ ...refused, condition: 'refused-seat', state: refused.detail, needs: 'nothing; information only' }] : []

  // A base policy over a checkout git cannot read is not a question with an
  // answer; saying "unevaluated" is honest, inventing a verdict is not.
  if (fault) {
    return { ...identity, ready: false, observedAt, prerequisites: [{ condition: 'base policy', state: 'not evaluated: the repository fault above must be cleared first', needs: 'clear the repository fault, then read again' }, ...information] }
  }

  const condition = await inspectLaunch({ projectPath, workspace: resolved.workspace, configHash: resolved.configHash })
  const prerequisites = condition?.blockedReason
    ? [{ condition: 'base policy', state: condition.blockedReason, needs: condition.code === 'DIRTY_BASE' ? 'clean the checkout, commit it, or select another base policy for the run' : 'clear the condition named above', code: condition.code ?? null, resolvableBy: condition.resolvableBy ?? null }]
    : []
  prerequisites.push(...information)
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
    // An information prerequisite (refused-seat) is reported, never a reason to be unready.
    ready: prerequisites.every((p) => p.category === 'information'),
    prerequisites
  }
}
