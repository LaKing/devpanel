import { acceptCheckUnavailable, checksOnlyBlock, continueUnavailable, CONTINUABLE_BLOCKS, reconcilePending, reconcileUnavailable, resumeUnavailable, SERVICE_SHUTDOWN } from './run-control.mjs'
import { acceptedRiskWords, refusedAcceptance, runResult } from './run-result.mjs'
import { openCleanup, STRUCTURAL } from './cleanup-barrier.mjs'
import { riskStatement } from './residual-risks.mjs'
import { ignoredSelftests, ignoredWords } from './selftest-history.mjs'
import { describeConflict } from './source-merge.mjs'
import { countsForClosure } from './modules-tier.mjs'
import { gateReason, unreadableReportOnly } from './baseline-failures.mjs'
import { instanceWords } from './instance-drive.mjs'

// Where a run stands, in words a person reads once and acts on.
//
// Every other field on a run is a record: a status, a reason code, closure
// conditions keyed by name. Those stay the source of truth and stay on screen
// under "technical details". This module only translates them:
//
//   headline  what happened, in one short line
//   detail    why, in a sentence or two, using the run's own evidence where it
//             has any (the coordinator's reasoning)
//   cause     the recorded error text, verbatim, when there is one: evidence
//             for whoever fixes it, shown apart from the explanation
//   kept      what survives, so nobody fears that pressing a button loses work
//   next      what a person can do about it
//   unmet     the specific things that were not satisfied, each with evidence
//   tone      progress | waiting | success | warning | error | neutral
//   unacceptedRisks  what a `resolved` disposition would refuse on, each risk with
//             what names it in acceptRisks, and the choices; absent when nothing is
//   splitSuggestion  the suggestion `next` carries when the run looks larger than one
//             run, with its candidate parts; absent otherwise
//
// It never decides anything. Actions a page may offer come from the run's
// supportedActions; `next` names them in prose and a page shows the buttons.

/** Whether the full drive reached the last revision of a run that ran out of rounds, from the record. */
function driveWords (run) {
  const revision = run.revisions?.at(-1)?.fingerprint
  const entries = (run.checkHistory ?? []).filter((h) => h.revision === revision)
  const full = entries.filter((h) => countsForClosure(h)).at(-1)
  const smoke = entries.filter((h) => h.tier === 'smoke' || h.tier === 'targeted').at(-1)
  const smokeFailed = (smoke?.gating ?? smoke?.result) === 'failed'
  const earlier = smoke?.tier === 'targeted' ? 'targeted tier' : 'smoke'
  if (run.driveNotRun || full?.result === 'not-run') {
    if (run.workspace?.isolation === 'in-place') return ' No drive could run on the last revision: in-place work has no base plus patch to rebuild.'
    return run.driveNotRun?.reason === 'no-drive-configured' ? ' No drive could run on the last revision: this run has none configured.' : ' No drive could run on the last revision.'
  }
  if (full) {
    const outcome = full.gating ?? full.result
    return ` The full drive ran on the last revision${smokeFailed ? ` after its ${earlier} failed` : ''} and ${outcome === 'unavailable' ? 'was unavailable' : outcome}; the next round's brief carries its result.`
  }
  if (smokeFailed) return ` The full drive never ran on the last revision: its ${earlier} failed.`
  return smoke ? ' The full drive never ran on the last revision: its audit held blocking findings that do not wait for it.' : ''
}

/**
 * A run whose last audit held nothing but findings awaiting the drive, and that
 * drive did not pass: the reviewers were waiting on it, not disagreeing.
 */
function awaitedDriveFailed (run) {
  const findings = run.outstandingFindings ?? []
  if (!findings.length || !findings.every((f) => f.awaitsCheck === true)) return null
  const revision = run.revisions?.at(-1)?.fingerprint
  const full = (run.checkHistory ?? []).filter((h) => h.revision === revision && countsForClosure(h)).at(-1)
  const outcome = full?.gating ?? full?.result
  if (!['failed', 'unavailable'].includes(outcome)) return null
  const check = (run.checkResults ?? []).filter((c) => c.revision === revision && countsForClosure(c)).at(-1)
  return { outcome, findings: findings.map((f) => f.id), timedOut: (check?.commands ?? []).filter((c) => c.timedOut).map((c) => c.id) }
}

const ROLE = (role) => {
  if (!role) return 'an agent'
  if (role === 'coordinator') return 'the coordinator'
  if (role === 'operator') return 'the operator'
  const numbered = /^(auditor|verifier|analyser)-(\d+)$/.exec(role)
  if (numbered) return `${{ auditor: 'reviewer', verifier: 'verifier', analyser: 'analyst' }[numbered[1]]} ${numbered[2]}`
  return {
    author: 'the author', implementer: 'the implementer', worker: 'the worker', planner: 'the planner',
    auditor: 'the reviewer', investigator: 'the investigator', analyser: 'the analyst', 'release-operator': 'the release operator'
  }[role] ?? `the ${role.replace(/-/g, ' ')}`
}
const Cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** A turn's escaped descendants were not proved gone (cleanup-barrier.mjs). */
function cleanupUnproved (run, open, kept) {
  const structural = open.some((e) => e.structural)
  const inPlace = run.workspace?.isolation === 'in-place'
  return { tone: 'warning', headline: 'Stopped: processes a turn started may still be running', kept,
    detail: `${structural ? `${Cap(STRUCTURAL)}.` : 'The scan for processes the turn left behind could not be completed, so nothing proves they are gone.'} Until that is settled the run's workspace goes to no one${inPlace ? ', and no in-place run of this project starts on its checkout' : ''}.`,
    cause: open.map((e) => `${ROLE(e.role)}: DEVPANEL_REAP_TAG=${e.tag}`).join('; '),
    next: structural
      ? 'Look for processes whose environment carries that tag (ps -E -ww -A -o pid=,command=), stop any you find, then Acknowledge cleanup, saying what you checked.'
      : 'Resume proves the cleanup first and stops what it finds. If it cannot, look for processes whose environment carries that tag, stop them, then Acknowledge cleanup, saying what you checked.' }
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What a source delivery's three-way merge did (source-merge.mjs), for people:
 * `merged` names the paths merged with edits in the project and says that no
 * check ran on the merged bytes; `conflicts` names each conflicting path with
 * its lines. Either is null when there is nothing to say. result.md uses it too.
 */
export function mergeSummary (delivery) {
  const merged = (delivery?.merged ?? []).filter((m) => m.applied !== false && !m.identical)
  const notWritten = (delivery?.merged ?? []).filter((m) => m.applied === false).length
  const unchecked = delivery?.mergeCheck?.ran === false ? ` No check ran on the merged bytes (merged tree ${delivery.mergedFrom}).` : ''
  return {
    merged: merged.length ? `Merged three-way with edits in the project: ${merged.map((m) => `${m.path} (${plural(m.hunks, 'hunk')})`).join(', ')}.${unchecked}` : null,
    conflicts: delivery?.conflicts?.length
      ? `Conflicts with edits in the project: ${delivery.conflicts.map(describeConflict).join('; ')}.${notWritten ? ` ${plural(notWritten, 'other path')} would merge cleanly, but nothing was written.` : ' Nothing was written.'}`
      : null
  }
}
const firstLine = (text, max = 300) => {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const BUDGET = { maxSteps: 'turn limit', maxTokens: 'token limit', wallClockMinutes: 'time limit', maxCostUsd: 'cost limit' }

/** The budget that ran out, judged from the record; null when none plainly did. */
function spentBudget (run) {
  const limits = run.budgets?.limits ?? {}
  const used = run.budgets?.used ?? {}
  if (limits.maxSteps && (used.steps ?? 0) >= limits.maxSteps) return 'maxSteps'
  if (limits.maxTokens && (used.tokens ?? 0) >= limits.maxTokens) return 'maxTokens'
  if (limits.maxCostUsd && (used.costUsd ?? 0) >= limits.maxCostUsd) return 'maxCostUsd'
  if (limits.wallClockMinutes) return 'wallClockMinutes'
  return null
}

/** The latest valid closure confirmation among the outputs we were given. */
function latestConfirmation (outputs) {
  const entries = Object.entries(outputs ?? {})
    .filter(([, o]) => o?.valid && o.contract === 'closureConfirmation')
    .sort(([a], [b]) => Number(a) - Number(b))
  return entries.at(-1)?.[1]?.output ?? null
}

/**
 * A launch refusal is recorded as the refusal text itself. The common ones are
 * about the project checkout, and each has a known remedy.
 */
function launchFailure (text) {
  const raw = String(text ?? '')
  let m
  if ((m = /requires a clean checkout, but (\d+) tracked path/.exec(raw))) {
    return {
      headline: "Couldn't start: the project has uncommitted changes",
      detail: `${plural(Number(m[1]), 'file')} in the project differ from its last commit, and this project is set to start runs from the last commit only.`,
      next: 'Commit the changes (the Push action on the project page), or set the project to start runs from the working tree as it is.'
    }
  }
  if (/symlink\(s\) in the checkout point outside it/.test(raw)) {
    const link = /\(([^()]*->[^()]*)\)/.exec(raw)?.[1]
    return {
      headline: "Couldn't start: a link in the project points outside it",
      detail: `${link ? `${link}: a` : 'A'}n agent writing through such a link would change files outside the project.`,
      next: "Set the project's symlink policy to copy the link targets (materialize) or to allow them."
    }
  }
  if ((m = /unsupported (?:tracked )?source entry: (.+)$/m.exec(raw))) {
    return {
      headline: "Couldn't start: the project holds something a run can't copy",
      detail: `${m[1].trim()} is a socket, device or nested repository, and a run's private copy of the project cannot contain it.`,
      next: 'Exclude it in the project settings (workspace excludes), or remove it from the project.'
    }
  }
  if (/dubious ownership/.test(raw)) {
    return {
      headline: "Couldn't start: Git refuses to read the project folder",
      detail: 'The folder belongs to a different user than the panel, and Git treats that as unsafe.',
      next: 'Fix the folder ownership, or mark it as safe for Git (git config --global --add safe.directory …).'
    }
  }
  if (/rev-parse HEAD|not a git repository|EMPTY_REPOSITORY|does not have any commits/i.test(raw)) {
    return {
      headline: "Couldn't start: the project is not a usable Git repository",
      detail: 'A run needs a project with at least one commit to start from.',
      next: 'Initialise the repository and make a first commit, then start again.'
    }
  }
  return null
}

function failed (run) {
  const f = run.failure
  if (f) {
    const who = f.role ? ROLE(f.role) : 'an agent'
    const model = f.availability?.modelId ?? run.participants?.[f.role]?.model ?? null
    const said = firstLine(f.message)
    switch (f.class) {
      case 'auth':
        return { headline: `Stopped: ${who}'s AI tool is not signed in`, detail: `The login${model ? ` for ${model}` : ''} is missing or expired.`, cause: said || null, next: 'Sign that account in again, then start a new run.' }
      case 'quota':
        return { headline: `Stopped: ${model ?? 'a model'} reached its usage limit`,
          detail: f.availability?.exhaustedUntil ? `It is unavailable until ${f.availability.exhaustedUntil}; runs naming it are refused until then.` : null,
          cause: said || null,
          next: 'Wait for the limit to reset, or start a new run with a different model for that seat.' }
      case 'rate-limit':
      case 'transient':
        return { headline: 'Stopped: the AI provider kept refusing requests', detail: f.retries ? `Retried ${plural(f.retries, 'time')} first.` : null, cause: said || null, next: 'Start a new run later; the provider was busy or limiting requests.' }
      case 'output-limit':
        return { headline: `Stopped: ${who} ran out of output on the model's output token limit`, detail: f.retries ? `Retried ${plural(f.retries, 'time')} first.` : null, cause: said || null, next: run.integrity?.status === 'quarantined'
          ? "Its last attempt's source edits were not accepted. Inspect the retained workspace, then keep them, restore them, or abandon the run; a narrower task or a lower effort for that seat leaves more room for the answer."
          : 'Resume the run or start a new one; a narrower task or a lower effort for that seat leaves more room for the answer.' }
      case 'refusal':
        return { headline: `Stopped: the provider refused the content of ${who}'s turn`,
          detail: "It was not retried and the model stays available. What happens next is your decision: nothing rewrites the prompt or switches the seat's model on its own.",
          // Whole: the provider's words run past firstLine's limit, and they are the evidence.
          cause: f.message || null,
          next: resumeUnavailable(run)
            ? 'Resume is not available for this run; start a new run with a different model for that seat.'
            : 'Resume once to send the turn again, or start a new run with a different model for that seat.' }
      case 'environment':
        return { headline: `Stopped: ${who}'s AI tool could not run on this host`, cause: said || null, next: 'Fix the host problem named above, then start a new run.' }
      default:
        return { headline: `Stopped: ${who}'s AI tool crashed`, cause: said || null, next: 'Start a new run; if it happens again, try another model for that seat.' }
    }
  }
  if (run.blockedReason === 'preflight-refused') {
    // The first line of the refusal only says that it refused; the lines after
    // it name the tool and model that failed.
    const lines = String(run.preflight?.detail ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^refusing to launch/.test(l))
    if (run.preflight?.counts?.failures === 0 && run.preflight.counts.unproven > 0) {
      return { headline: "Couldn't start: a pre-start check got no answer", detail: 'Nothing failed and no agent was run; a probe timed out or was cancelled.', cause: lines.join('\n') || null, next: 'Start again; the same start is allowed.' }
    }
    return { headline: "Couldn't start: the AI tools failed their pre-start check", detail: 'No agent was run.', cause: lines.join('\n') || null, next: 'Fix what the check reported (a login, an install, a model name), then start again.' }
  }
  const launch = launchFailure(run.blockedReason)
  if (launch) return launch
  return { headline: 'Stopped with an error', detail: run.blockedReason ? null : 'No reason was recorded.', cause: firstLine(run.blockedReason, 600) || null, next: 'Start a new run once the cause is fixed.' }
}

/**
 * Which check failures stopped a run: the new ones by name, beside how many
 * the unchanged base has too; or why the base comparison could not be made.
 * Without a comparison (older records), the failing required commands.
 */
function checkFailureWords (failures, commands = []) {
  const name = (x) => x.test === '(command)' ? x.command : `${x.command}: ${x.test}`
  if (failures?.verdict === 'new-failures') {
    const known = failures.baselineKnown?.length ?? 0
    return `New failures: ${failures.newFailures.map(name).join(', ')}.${known ? ` ${plural(known, 'other failure')} also ${known === 1 ? 'occurs' : 'occur'} on the unchanged project and did not count.` : ''} `
  }
  if (failures?.verdict === 'not-made') return `The failures could not be compared with the unchanged project, so none counts as inherited: ${failures.reason}. `
  const failed = commands.filter((c) => c.required !== false && !c.passed).map((c) => c.id)
  return failed.length ? `Failing: ${failed.join(', ')}. ` : ''
}

/** Which selftests stopped a run: the new ones by name, or why they could not be compared. */
/** What gated a modules drive, in the gate's own words: it has no base comparison for the other helpers to read. */
function modulesWords (check, run) {
  const why = check?.tier === 'modules' ? gateReason(check, run) : null
  const instance = instanceWords(check)
  return `${why ? `${why[0].toUpperCase()}${why.slice(1)}. ` : ''}${why && instance ? `${instance} ` : ''}`
}

function selftestWords (selftest) {
  if (selftest?.verdict === 'new-failures') {
    const known = selftest.baselineKnown?.length ?? 0
    return `New selftest failures: ${selftest.newFailures.map((x) => x.test).join(', ')}.${known ? ` ${plural(known, 'other selftest failure')} also ${known === 1 ? 'occurs' : 'occur'} on the unchanged project and did not count.` : ''} `
  }
  // Not a regression: the unchanged project's own selftest run stopped early, so there was nothing to compare with.
  if (selftest?.verdict === 'not-made' && selftest.baseUnfinished) return `Inconclusive, not a regression: the unchanged project's selftest run did not finish, so the candidate's selftest failures could not be judged new or inherited (${selftest.reason}). `
  if (selftest?.verdict === 'not-made') return `The selftest failures could not be compared with the unchanged project, so none counts as inherited: ${selftest.reason}. `
  return ''
}

/** What the engine's automatic returns to the author did, in one sentence, or ''. */
function returnWords (run) {
  const returns = run.closureReturns ?? []
  if (!returns.length) return ''
  return `The engine returned it to the author ${returns.length === 1 ? 'once' : `${returns.length} times`} after closure (${[...new Set(returns.flatMap((r) => r.criteria.map((c) => c.id)))].join(', ')}).`
}

/** Why an unmet confirmation stayed with the operator instead of going back to the author. */
function notReturnedWords (reason) {
  if (!reason) return ''
  if (reason === 'bound-reached') return 'It was not returned to the author again: the engine returns a run at most twice.'
  const [id, kind] = reason.split(': ')
  if (kind === 'unclassified') return `It was not returned to the author: ${id} is unmet without a classification.`
  if (['live-checkout', 'owner-gate', 'authorization', 'requirement-conflict'].includes(kind)) return `It was not returned to the author: ${id} is a matter for you (${kind.replace('-', ' ')}).`
  return `It was not returned to the author: ${reason}.`
}

/** Why a single seat got no further turn for a failed check or an unfinished task (engine.workerReturn), and how many it had. */
function workerNotReturnedWords (run) {
  const had = run.workerReturns?.length ?? 0
  const reason = run.closure?.workerNotReturned
  const before = had ? `The engine had returned it to the agent ${had === 1 ? 'once' : `${had} times`}. ` : ''
  if (!reason) return before.trim()
  return `${before}${reason === 'bound-reached' ? 'It was not returned again: the engine returns a single seat\'s work at most twice.' : `It was not returned to the agent: ${reason}.`}`
}

/** How often a delivery conflict went back to the author, and why this one did not (engine.returnFromDelivery). */
function deliveryNotReturnedWords (run) {
  const had = run.deliveryReturns?.length ?? 0
  const reason = run.closure?.deliveryNotReturned
  const before = had ? ` The engine had returned a delivery conflict to the author ${had === 1 ? 'once' : `${had} times`} in this run.` : ''
  if (!reason) return before
  return `${before} ${reason === 'bound-reached' ? 'It was not returned again: the engine returns a delivery conflict at most twice.' : `It was not returned to the author: ${String(reason).replace(/\.$/, '')}.`}`
}

/** Why closure did not happen, from the first condition that failed. */
function closureUnmet (run, confirmation) {
  const c = run.closure?.conditions ?? {}
  const findings = (run.outstandingFindings ?? []).filter((f) => f.blocking)
  if (c.reportDispositionRecorded === false) {
    return { headline: 'Not finished: no report outcome was recorded', detail: 'The coordinator never recorded what the report concluded.', unmet: [] }
  }
  if (c.sameRevisionApproval === false) {
    return { headline: 'Not finished: the final version was never approved', detail: 'Every reviewer has to approve the same, final version of the change; that did not happen.', unmet: [] }
  }
  if (c.checksSatisfied === false) {
    const checks = run.closure?.checks
    const words = (checks?.comparison ? checkFailureWords({ verdict: checks.comparison, reason: checks.reason, newFailures: checks.newFailures, baselineKnown: checks.baselineKnown }) : '') + selftestWords(checks?.selftest)
    const gate = checks?.gate ? `${checks.gate[0].toUpperCase()}${checks.gate.slice(1)}.` : ''
    return { headline: 'Not finished: the automated checks did not pass', detail: [words.trim() || gate || 'The final version failed the project\'s checks, or they could not be run.', workerNotReturnedWords(run)].filter(Boolean).join(' '), unmet: [] }
  }
  if (c.noOutstandingBlockingFindings === false) {
    return {
      headline: `Not finished: reviewers left ${plural(findings.length, 'blocking problem')} open`,
      detail: 'A reviewer found problems that must be fixed before the change can be accepted.',
      unmet: findings.map((f) => ({ id: f.id ?? null, text: f.description }))
    }
  }
  if (c.coordinatorConfirmation === false) {
    const criteria = confirmation?.criteria ?? []
    const missed = criteria.filter((x) => x.met === false)
    return {
      headline: missed.length
        ? `Not finished: ${plural(missed.length, 'goal')} of ${criteria.length} not met`
        : 'Not finished: the coordinator did not sign off',
      detail: firstLine(confirmation?.reasoning, 600) || 'The coordinator judged the result as not meeting the issue\'s goals.',
      unmet: missed.map((x) => ({ id: x.id, text: x.evidence ?? null }))
    }
  }
  return { headline: 'Not finished', detail: 'A condition for finishing was not met; the technical details list which.', unmet: [] }
}

const DELIVERY = {
  'delivery-unavailable': {
    headline: 'Approved, but there was nowhere to deliver it',
    detail: 'No way of delivering the change is configured for this playbook.',
    next: 'Fix the configuration, then Finalize.'
  },
  'delivery-unverifiable': {
    headline: 'Approved, but the saved patch does not reproduce the change',
    detail: 'Rebuilding the change from the patch gave a different result, so the patch is not a faithful copy.',
    next: 'The workspace is kept. Fix the cause, then Finalize.'
  },
  'delivery-failed': {
    headline: 'Approved, but delivering it failed',
    next: 'The workspace is kept. Fix the cause, then Finalize.'
  },
  'candidate-changed-during-delivery': {
    headline: 'Approved, but the change moved while it was being delivered',
    detail: 'Something modified the workspace during delivery.',
    next: 'Finalize to check again; the workspace is kept.'
  },
  'source-delivery-blocked': {
    headline: 'Approved, but it could not be applied to your project',
    detail: 'The project changed while the run was working, so the approved change no longer applies cleanly.',
    next: 'Download the patch and apply it by hand, or start a new run against the current project.'
  },
  'source-delivery-interrupted': {
    headline: 'Approved, but applying it to your project was interrupted',
    next: 'Finalize checks the project and completes or reports what is left.'
  }
}

/** The resumes and Continues that raised a limit. Only those two write limits, and only when told to (engine.continuationLimits). */
export function limitRaises (run) {
  const raised = ({ previousLimits: before, limits }) => Object.entries(limits ?? {}).some(([key, value]) => Number.isFinite(before?.[key]) && value > before[key])
  return [...(run.resumeHistory ?? []), ...(run.continueHistory ?? [])].filter(raised)
}

/** What a finding cites, as comparable names: its criterion, and the file of its location. A finding citing neither names nothing. */
function findingNames (f) {
  const names = []
  const criterion = typeof f.criterion === 'string' ? f.criterion.trim().replace(/\s+/g, ' ') : ''
  if (criterion) names.push({ key: `criterion:${criterion.toLowerCase()}`, label: criterion })
  const location = typeof f.location === 'string' ? f.location.trim() : ''
  if (location) {
    const first = location.split(/[\s,;]+/)[0]
    const area = /[/.]/.test(first) ? first.replace(/^\.\//, '').replace(/(:\d.*|#L\d.*)$/, '') : location.replace(/\s+/g, ' ')
    names.push({ key: `area:${area.toLowerCase()}`, label: area })
  }
  return names
}

/*
 * What the findings new since the first raise keep naming. A review pass is
 * the (phase, round) its review steps ran in, consecutively, so a restart that
 * reuses a round number is another pass; a seat's last valid report in a pass
 * counts, as in run-metrics. A finding is new where its slug (the id after the
 * seat prefix) first appears in the run. A name is kept when new findings of at
 * least two passes cite it, and at least half of the citing new findings since
 * the first raise are among them. Findings citing nothing count neither way.
 */
function keptNames (run, outputs, since) {
  const passes = []
  let previous = null
  for (const s of run.steps ?? []) {
    const out = outputs[s.number]
    if (!out?.valid || out.contract !== 'reviewResult') continue
    const key = `${s.phase}:${s.round}`
    if (key !== previous) passes.push({ after: Date.parse(s.startedAt) >= since, seats: new Map() })
    previous = key
    passes.at(-1).seats.set(s.role, out.output?.findings ?? [])
  }
  const seen = new Set()
  const named = new Map()
  let citing = 0
  passes.forEach(({ after, seats }, pass) => {
    for (const [seat, findings] of seats) {
      for (const f of findings) {
        if (!f?.id) continue
        const slug = String(f.id).replace(new RegExp(`^${seat}-`, 'i'), '').toLowerCase()
        if (seen.has(slug)) continue
        seen.add(slug)
        const names = findingNames(f)
        if (after && names.length) citing++
        for (const { key, label } of names) {
          if (!named.has(key)) named.set(key, { key, label, passes: new Set(), since: 0 })
          named.get(key).passes.add(pass)
          if (after) named.get(key).since++
        }
      }
    }
  })
  return [...named.values()].filter((n) => n.passes.size >= 2 && n.since > 0 && n.since * 2 >= citing)
    .sort((a, b) => b.since - a.since || (a.key < b.key ? -1 : 1)).map((n) => n.label)
}

/*
 * A run that is larger than one run, read off its own record: stopped where
 * another round is on offer, limits raised by hand at least once (a Resume's own
 * extra round raises none), open findings to offer as parts, and new findings that
 * keep naming the same things. It suggests and acts on nothing, and no button
 * splits a run after triage, so the words send a person to what does exist.
 */
function splitSuggestion (run, outputs) {
  if (run.status !== 'blocked' || run.landed || reconcilePending(run) || openCleanup(run).length) return null
  if (!['budget-exhausted', 'rounds-exhausted', ...CONTINUABLE_BLOCKS].includes(run.blockedReason)) return null
  if (resumeUnavailable(run) && continueUnavailable(run)) return null
  const open = run.outstandingFindings ?? []
  const raises = limitRaises(run)
  if (!open.length || !raises.length) return null
  const theme = keptNames(run, outputs, Math.min(...raises.map((r) => Date.parse(r.at))))
  if (!theme.length) return null
  const parts = open.map((f) => ({ id: f.id ?? null, description: firstLine(f.description, 160) || null, criterion: f.criterion ?? null, location: f.location ?? null }))
  const listed = parts.map((p) => [p.id, p.description].filter(Boolean).join(': ')).join('; ')
  const text = `Limits were raised by hand ${plural(raises.length, 'time')} and new findings keep naming ${theme.map((name) => firstLine(name, 80)).join(', ')}, so this may be larger than one run. Consider splitting the issue rather than one more round: no button does that here, so open each part as a new issue and record the split disposition on this one. Candidate parts, from the open findings: ${listed.replace(/\.$/, '')}.`
  return { text, parts, theme, limitRaises: raises.length }
}

/** Where a run stands, for a person. See the header for the fields. */
export function explainRun (run, { outputs = {}, active = [], ownership = null, acceptedRisks = [] } = {}) {
  if (!run) return null
  const standing = withReleaseCoverage(run, withSplitSuggestion(run, explainStanding(run, { outputs, active, ownership }), outputs, ownership))
  const unaccepted = riskStatement(run, acceptedRisks)
  if (!unaccepted) return standing
  const n = unaccepted.risks.length
  const choice = `${plural(n, 'residual risk')} ${n === 1 ? 'is' : 'are'} unaccepted: to record resolved, accept ${n === 1 ? 'it' : 'each'} with a reason; otherwise record partially-resolved.`
  return { ...standing, next: [standing.next, choice].filter(Boolean).join(' '), unacceptedRisks: unaccepted }
}

/*
 * What a Staging run's release carried of the delivered runs (staging-coverage.mjs),
 * however it ended: a red release's failure belongs to the same runs. The field holds
 * all of them; the sentence the first few.
 */
function withReleaseCoverage (run, standing) {
  const coverage = run.release?.coverage
  if (!coverage) return standing
  const add = (words) => [standing.detail, words].filter(Boolean).join(' ')
  if (coverage.error) return { ...standing, detail: add(`What this release carried could not be recorded: ${coverage.error}.`) }
  const covered = coverage.covered ?? []
  const indeterminate = coverage.indeterminate ?? []
  const names = (list) => `${list.slice(0, 20).map((e) => `${e.runId} (${e.issueId})`).join(', ')}${list.length > 20 ? ` and ${list.length - 20} more` : ''}`
  const words = [
    covered.length ? `This release carried ${names(covered)}.` : 'This release carried no delivered run that was waiting.',
    indeterminate.length ? `Indeterminate, so not covered: ${names(indeterminate)}.` : null
  ].filter(Boolean).join(' ')
  return { ...standing, detail: add(words), releaseCoverage: {
    covered: covered.map((e) => ({ issueId: e.issueId, runId: e.runId })),
    indeterminate: indeterminate.map((e) => ({ issueId: e.issueId, runId: e.runId, reason: e.reason }))
  } }
}

function withSplitSuggestion (run, standing, outputs, ownership) {
  const split = ownership?.state === 'owner-unknown' ? null : splitSuggestion(run, outputs)
  return split ? { ...standing, next: [standing.next, split.text].filter(Boolean).join(' '), splitSuggestion: split } : standing
}

/*
 * The record of an accepted check risk, or of an acceptance asked for and not
 * (yet) given, whatever else stopped the run. Only closure.acceptedCheckRisk
 * reads as accepted: a request or a refusal says the opposite.
 */
function withAcceptance (run, standing) {
  const add = (words) => [standing.detail, words].filter(Boolean).join(' ')
  const accepted = run.closure?.acceptedCheckRisk
  if (accepted) {
    const headline = run.status === 'completed' ? `${standing.headline}, with accepted check failures` : standing.headline
    return { ...standing, headline, detail: add(`${acceptedRiskWords(accepted)} The checks did not pass, so this is not verified.`) }
  }
  const asked = run.checkAcceptanceRequest
  if (asked) {
    return { ...standing, detail: add(`${asked.by} asked to accept the failed checks ${asked.failures.map((f) => f.key).join(', ')}. Nothing is accepted yet: that waits for the coordinator to confirm this version.`) }
  }
  const refused = refusedAcceptance(run)
  if (refused) {
    const criteria = refused.criteria?.length ? ` Not confirmed: ${refused.criteria.map((c) => `${c.id}${c.evidence ? ` (${firstLine(c.evidence)})` : ''}`).join(', ')}.` : ''
    return { ...standing, headline: 'Check result not accepted: the coordinator did not confirm', detail: add(`${refused.by} asked to accept ${refused.failures.map((f) => f.key).join(', ')}; nothing was accepted or delivered, because ${refused.because}.${criteria}`) }
  }
  return standing
}

function explainStanding (run, options) {
  return withIgnoredSelftests(run, withAcceptance(run, standingOf(run, options)))
}

/** A selftest failure the gate passed over is named however the run stands: it may be a real regression. */
function withIgnoredSelftests (run, standing) {
  const ignored = ignoredSelftests(run)
  if (!ignored.length) return standing
  return { ...standing, detail: [standing.detail, ...ignored.map(ignoredWords)].filter(Boolean).join(' ') }
}

/**
 * The answers a paused run already holds (operator decision steps), so whoever
 * reads the pause sees what was decided before: the same question asked again
 * says so, and earlier answers are named, the last three, newest last.
 */
function answeredWords (run) {
  const answers = (run.steps ?? []).filter((s) => s.role === 'operator' && s.decision)
  if (!answers.length) return null
  const say = (s) => `step ${s.number} — "${firstLine(s.decision.answer, 200)}"${s.decision.actor ? ` (by ${s.decision.actor}${s.decision.at ? `, ${s.decision.at}` : ''})` : ''}`
  const same = run.pause?.key ? answers.filter((s) => s.decision.key === run.pause.key).at(-1) : null
  if (same) return `This question was already answered: ${say(same)}.`
  return `Answered earlier in this run: ${answers.slice(-3).map(say).join('; ')}.`
}

function standingOf (run, { outputs, active, ownership }) {
  if (run.landed) return landed(run, standingOf({ ...run, landed: undefined }, { outputs, active }))
  const kept = run.workspace?.state === 'retained' ? 'Its workspace and logs are kept.' : 'Its logs are kept.'

  // The run lock names an owner whose liveness cannot be proved (lock.mjs):
  // devpanel neither takes the run over nor stops it.
  if (ownership?.state === 'owner-unknown') {
    return { tone: 'warning', headline: 'Its owner cannot be established', kept,
      detail: `The run lock names process ${ownership.pid} on ${ownership.host}, and whether it is still running cannot be proved, so this server neither takes the run over nor stops it.`,
      next: `If that process is gone, delete ${ownership.file}, then Recover the run. devpanel never removes a lock it cannot prove dead.` }
  }
  const open = openCleanup(run)
  if (open.length && !['pending', 'preflighting', 'running', 'stopping'].includes(run.status)) return cleanupUnproved(run, open, kept)

  // A step still marked in flight on a run that is no longer live: whatever it
  // did is unknown. A panel restart has its own wording (recover), below.
  const interrupted = !['pending', 'preflighting', 'running', 'stopping', 'paused'].includes(run.status) &&
    !['recovery-required', 'owner-lost'].includes(run.blockedReason) &&
    (run.journal?.recoveryRequired || Object.values(run.participants ?? {}).some((p) => p?.pendingInvocation || p?.state === 'recovery-required'))
  if (interrupted) {
    return { tone: 'warning', headline: 'Interrupted — needs recovery', kept,
      detail: 'A step was still in progress when the run stopped, so its result is unknown.',
      cause: firstLine(run.failure?.message ?? run.blockedReason) || null,
      next: 'Abandon keeps the work and logs and lets you start a fresh run.' }
  }

  switch (run.status) {
    case 'pending':
    case 'preflighting':
      return { tone: 'progress', headline: 'Starting', detail: 'Checking that the AI tools are installed and signed in before the first turn.' }
    case 'running': {
      const working = active.map((a) => ROLE(a.role))
      const doing = working.length ? `${Cap(working.join(' and '))} ${working.length === 1 ? 'is' : 'are'} working.` : 'Between turns.'
      // After a delivery return the author is reconciling a conflict with the project; the later of the two returns is what the run is doing.
      const conflict = (run.deliveryReturns ?? []).at(-1)
      const back = (run.closureReturns ?? []).at(-1)
      if (conflict && !(back && Number(back.step) > Number(conflict.step))) {
        return { tone: 'progress', headline: 'Running: reconciling a conflict with the project',
          detail: `The approved version conflicted with changes made in the project meanwhile (${conflict.conflicts.map((c) => c.path).join(', ')}), so the engine moved the work onto the current project and gave the author another round to reconcile those lines (return ${run.deliveryReturns.length} of 2). The result is checked and reviewed again. ${doing}` }
      }
      if (back) {
        return { tone: 'progress', headline: 'Running: returned to the author after closure',
          detail: `The coordinator found ${back.criteria.map((c) => `${c.id} (${c.unmet})`).join(', ')} not yet met on an approved, checked version, so the engine gave the author another round (return ${run.closureReturns.length} of 2). ${doing}` }
      }
      return { tone: 'progress', headline: 'Running', detail: doing }
    }
    case 'stopping':
      return { tone: 'progress', headline: 'Stopping', detail: 'Waiting for the AI tools to confirm they have stopped.' }
    case 'paused': {
      const p = run.pause ?? {}
      if (p.kind === 'manual') return { tone: 'waiting', headline: 'Paused', detail: 'Everything done so far is saved.', next: 'Resume continues from the next unfinished step.' }
      if (p.kind === 'full-verification') return { tone: 'waiting', headline: 'Paused for the daily full verification',
        detail: `Admission closed for cycle ${p.cycleId ?? 'unknown'}; everything done so far is saved.`,
        next: p.manualPending ? 'An operator pause was pending as well, so the cycle leaves this run paused: Resume continues it.' : 'It resumes when the cycle ends; Resume continues it after that.' }
      const answered = answeredWords(run)
      if (p.request) {
        // The question is what to answer; the reason is why the run cannot do it.
        const heading = { 'owner-gate': 'Waiting for you: this decision is yours', authorization: 'Waiting for you: this needs your authorization', 'requirement-conflict': "Waiting for you: the requirements can't all be met" }[p.request.category] ?? 'Waiting for you: work the run may not do itself'
        return { tone: 'waiting', headline: heading,
          detail: [p.question, p.request.reason, p.request.recommendation ? `Recommended: ${p.request.recommendation}` : null, answered].filter(Boolean).join('\n\n') || null,
          next: p.request.projectAction ? `Run the project's "${p.request.projectAction}" action, then answer with what happened.` : p.request.category === 'owner-gate' ? 'Answer below; the run continues from your answer.' : 'Do the work, then answer with what happened.' }
      }
      return { tone: 'waiting', headline: 'Waiting for your answer', detail: [p.question, answered].filter(Boolean).join('\n\n') || null, next: 'Answer below; the run continues from your answer.' }
    }
    case 'cancelled':
      return run.abandonment
        ? { tone: 'neutral', headline: 'Abandoned', detail: `An operator abandoned this run. ${kept}`, next: 'Start a new run to continue.' }
        : run.stoppedBy === SERVICE_SHUTDOWN
          ? { tone: run.autoResumeRefused ? 'warning' : 'neutral', headline: 'Stopped by a service shutdown',
              detail: [`Nothing was delivered. ${kept}`, run.autoResumeRefused ? `It was not resumed automatically: ${run.autoResumeRefused.reason}` : null].filter(Boolean).join(' '),
              next: resumeUnavailable(run) ? 'Start a new run to continue.' : 'Resume it to continue where it stopped, or start a new run.' }
          : { tone: 'neutral', headline: 'Stopped by an operator', detail: `Nothing was delivered. ${kept}`, next: 'Start a new run to continue.' }
    case 'failed':
      return { tone: 'error', kept, ...failed(run) }
    case 'completed': {
      const done = completed(run, outputs)
      const known = run.closure?.checks?.baselineKnown ?? []
      const inherited = run.closure?.checks?.comparison === 'baseline-known' && known.length
        ? `The checks failed only on ${plural(known.length, 'failure')} the unchanged project has too; ${known.length === 1 ? 'it was' : 'they were'} recorded as baseline-known and did not block.` : ''
      const detail = [done.detail, inherited, returnWords(run)].filter(Boolean).join(' ')
      return detail === (done.detail ?? '') ? done : { ...done, detail }
    }
    case 'blocked':
      return blocked(run, outputs, kept)
    default:
      return { tone: 'neutral', headline: Cap(String(run.status ?? 'unknown')) }
  }
}

/**
 * A person recorded that they landed the run's work by hand. That claim is
 * what the run achieved; how the run itself ended is kept beside it, because
 * the landing changes nothing on the record.
 */
function landed (run, before) {
  const l = run.landed
  const where = l.commit ? `commit ${l.commit}` : l.checkout
  return {
    tone: 'success',
    headline: `Landed by hand by ${l.by}`,
    detail: [`${l.by} recorded that ${l.applied} reached ${where}${l.landedAt ? ` on ${l.landedAt}` : ''}.`,
      l.handChanges ? `Changed by hand beyond the patch: ${l.handChanges}` : null,
      `The run itself ended as: ${before.headline}.`].filter(Boolean).join(' '),
    ...(before.kept ? { kept: before.kept } : {}),
    next: 'Check the result, then record what it means for the issue.'
  }
}

function completed (run, outputs) {
  // A triage decision already has its own words in run-result.
  const result = runResult(run, outputs)
  if (result.resultReason === 'triage-disposition') {
    return { tone: 'success', headline: result.resultLabel, detail: firstLine(result.resultSummary, 600) || null, next: 'Record what it means for the issue, or start the next playbook.' }
  }
  if (run.outcome !== 'resolved' && run.ownerInput) {
    const o = run.ownerInput
    const n = o.questions?.length ?? 0
    if (o.answer?.startError) {
      return { tone: 'warning', headline: "Answered, but the next run didn't start", cause: o.answer.startError,
        next: 'Your answers are on the issue as a note; start the playbook again from this page.' }
    }
    if (o.answer) {
      return { tone: 'neutral', headline: o.answer.split === 'accept' ? 'Split into new issues' : 'Answered — the work continues in a new run',
        detail: o.answer.split === 'accept' ? `${plural(o.answer.createdIssues?.length ?? 0, 'issue')} created from the proposed split.` : null }
    }
    if (o.verdict === 'too-large') {
      return { tone: 'waiting', headline: 'Too large for one run: triage proposes a split',
        detail: o.reason ?? null,
        next: 'Accept the split to create the parts as new issues, or decline it to run the whole issue anyway. No work was started.' }
    }
    return { tone: 'waiting', headline: n === 1 ? 'Waiting for your answer before any work starts' : `Waiting for your ${n} answers before any work starts`,
      detail: o.reason ?? null,
      next: 'Answer below; the answers start a fresh run. Nothing was started and no slot is held.' }
  }
  if (run.outcome !== 'resolved') {
    return { tone: 'neutral', headline: 'Triage judged this playbook a poor fit', detail: 'Nothing was changed.', next: 'Start a different playbook, or close the issue.' }
  }
  const delivered = run.delivery?.completedAt
  const action = run.delivery?.action
  const next = 'Check the result, then record what it means for the issue.'
  if (run.artifactApplication?.verified) return { tone: 'success', headline: 'Done: the change is in your project', detail: 'The saved patch was applied and verified.', next }
  if (action === 'worktree-diff' && delivered) return { tone: 'success', headline: 'Done: a patch is ready', detail: 'Your project was not changed. Download or apply the patch below.', next }
  if (action === 'apply-to-source' && delivered) {
    const merge = mergeSummary(run.delivery).merged
    return { tone: 'success', headline: 'Done: the change is in your project', detail: `Applied to the project folder and verified; not committed.${merge ? ` ${merge}` : ''}`, next }
  }
  if (action === 'commit' && delivered) return { tone: 'success', headline: 'Done: the change is committed on a branch', detail: run.integration?.mergeCommit ? 'It has also been merged.' : 'It is not merged yet.', next }
  if (action === 'in-place' && delivered) return { tone: 'success', headline: 'Done: changed directly in the project', next }
  const strategy = run.playbook?.strategy
  if (strategy === 'staging') return { tone: 'success', headline: 'Done: installed and tested on staging', next }
  if (strategy === 'deployment' && run.release?.tactic === 'staging' && !run.productionRelease) return { tone: 'success', headline: 'Done: installed and tested on staging', next }
  if (strategy === 'deployment') return { tone: 'success', headline: run.productionRelease ? 'Done: staged, then deployed to production and verified' : 'Done: deployed and verified', next }
  if (run.reportDisposition) {
    const n = run.reportDisposition.issues?.length ?? 0
    const said = firstLine(run.reportDisposition.response, 600)
    return { tone: 'success', headline: n ? `Done: report with ${plural(n, 'finding')}` : 'Done: report finished', detail: said || null, next }
  }
  return { tone: 'success', headline: 'Done', next }
}

function blocked (run, outputs, kept) {
  const reason = run.blockedReason
  const base = { tone: 'warning', kept }
  if (reconcilePending(run)) {
    return { ...base, tone: 'progress', headline: 'Approved; automatic reconcile running; do not land by hand',
      detail: 'The panel is merging the approved change onto the project, rechecking it unless only declared inert paths drifted, and delivering it.',
      next: 'Wait: it delivers the change or says why not.' }
  }
  switch (reason) {
    case 'recovery-required':
    case 'owner-lost':
      if (run.failure?.class === 'refusal' && run.integrity?.status === 'quarantined' && !run.journal?.recoveryRequired) {
        const latest = run.integrity.latest
        const keepable = latest?.writesCode && latest.outcome !== 'completed' && latest.changes && !latest.changes.head
        return { ...base, headline: `Stopped: the provider refused the content of ${ROLE(run.failure.role)}'s turn, and the turn left changes that need a recovery decision`,
          detail: "It was not retried and the model stays available. What happens next is your decision: nothing rewrites the prompt or switches the seat's model on its own.",
          cause: run.failure.message || null,
          next: `Inspect the retained workspace, then ${keepable ? 'keep the partial edits, restore them,' : 'restore the changes'} or abandon the run. Resume is refused until you record that decision; ${keepable ? 'keeping or restoring' : 'restoring'} sends the turn again once, on a fresh session. To change the seat, abandon the run and start a new one with a different model for that seat.` }
      }
      // A source-integrity quarantine is a turn that ended with changes nobody
      // vouched for, not a restart; its cause is the turn's own failure.
      if (run.integrity?.status === 'quarantined' && !run.journal?.recoveryRequired && run.integrity.latest?.changes?.changed) {
        const failed = run.recovery?.cause ? `${run.recovery.cause.class}: ${run.recovery.cause.message}` : null
        return { ...base, headline: 'Stopped: a turn left source changes that need a recovery decision', detail: failed ? `The turn failed (${failed}).` : null,
          cause: run.recovery?.reason ? firstLine(run.recovery.reason) : null,
          next: 'Inspect the retained workspace, then keep the partial edits, restore them, or abandon the run.' }
      }
      return { ...base, headline: 'Interrupted: the panel restarted while this run was working', cause: run.recovery?.reason ? firstLine(run.recovery.reason) : null,
        next: 'Recover picks up where it stopped. Abandon keeps the work and lets you start fresh.' }
    case 'checks-inconclusive': {
      const check = (run.checkResults ?? []).filter((c) => c.revision === run.revisions?.at(-1)?.fingerprint).at(-1)
      if (unreadableReportOnly(check)) {
        return { ...base, headline: 'Stopped: the reviewers approved and every check command passed, but a selftest report could not be read',
          detail: `${modulesWords(check, run)}No test is known to have failed. No author round was spent on it, since no source change answers a report the drive did not show.`,
          next: 'Look at the staging drive first: the selftest command must print its report (a "== …/selftest.report" line and the JSON array). Then Refresh checks reruns the checks on this candidate. Continue gives the author a round anyway.' }
      }
      return { ...base, headline: 'Stopped: the reviewers approved, but the comparison base did not finish its tests',
        detail: `${selftestWords(check?.baselineComparison?.selftest)}The base was driven twice. No author round was spent on it, since no source change can answer it.`,
        next: 'Refresh checks drives a fresh base and reruns the checks on this candidate. If the base keeps stopping early, look at the staging drive (timeouts, load) first. Continue gives the author a round anyway.' }
    }
    case 'checks-failed-unchanged':
    case 'rounds-exhausted': {
      // The reviewers agreed; what stopped the loop was the installed checks on the approved revision.
      if (checksOnlyBlock(run)) {
        const check = (run.checkResults ?? []).filter((c) => c.revision === run.revisions?.at(-1)?.fingerprint).at(-1)
        return { ...base, headline: 'Stopped: the reviewers approved, but the automated checks failed',
          detail: `${check?.tier === 'modules' ? modulesWords(check, run) : checkFailureWords(check?.baselineComparison?.failures, check?.commands)}${selftestWords(check?.baselineComparison?.selftest)}${reason === 'checks-failed-unchanged' ? 'The author answered the failure with an unchanged candidate, so another round could only repeat it.' : 'The review loop reached its round limit.'}`,
          next: `Refresh checks reruns them on this candidate (after a flaky or environmental failure is fixed). ${reason === 'checks-failed-unchanged' ? 'Continue gives the author another round with your instruction.' : 'Resume gives the author one more round.'}${acceptCheckUnavailable(run) ? '' : ' If these failures are unrelated to this change, Accept check result names them with your reason; once the coordinator confirms this version, it goes through normal delivery.'}` }
      }
      const awaited = reason === 'rounds-exhausted' ? awaitedDriveFailed(run) : null
      if (awaited) {
        const how = awaited.timedOut.length ? 'hung' : awaited.outcome === 'unavailable' ? 'was unavailable' : 'failed'
        return { ...base, headline: `Stopped: the last audit only awaited the drive, and the drive ${how}`,
          detail: `The last audit's only blocking findings (${awaited.findings.join(', ')}) awaited the drive of the last revision.${awaited.timedOut.length ? ` Timed out: ${awaited.timedOut.join(', ')}.` : ''}${driveWords(run)}`,
          next: "Resume for one more round; its brief carries the drive's result. If the drive itself is at fault (staging, timeouts), fix that first." }
      }
      const denied = run.extensionDenied
      return { ...base, headline: "Stopped: the author and reviewers didn't agree in time",
        detail: `The review loop reached its round limit.${denied ? ` Round ${denied.round + 1} reopened ${denied.reopened.join(', ')}, which an earlier round had closed, so the loop was not converging and got no extra round.` : ''}${driveWords(run)}`,
        next: 'Resume for one more round, or start a new run with clearer guidance.' }
    }
    case 'protocol-repair-exhausted': {
      const last = (run.steps ?? []).at(-1)
      return { ...base, headline: `Stopped: ${ROLE(last?.role)} kept answering in the wrong format`, detail: 'Its replies could not be read even after repair attempts.',
        next: 'Resume for another attempt; if it repeats, use a different model for that seat.' }
    }
    case 'budget-exhausted': {
      const which = spentBudget(run)
      return { ...base, headline: `Stopped: it used up its ${BUDGET[which] ?? 'allowance'}`, detail: 'Nothing done so far is lost.',
        next: 'Resume with a larger allowance.' }
    }
    case 'closure-not-authorised':
      return { ...base, headline: 'Finished, but not verified by automated checks', detail: 'Reviewers approved it, but this playbook only finishes on its own when checks have passed.',
        next: 'Decide yourself: record the outcome, or configure checks and run again.' }
    case 'task-incomplete':
      return { ...base, headline: 'Not finished: the agent says the task is not done',
        detail: [firstLine(((b) => typeof b === 'string' ? b : b?.description)((run.closure?.blockers ?? [])[0])), workerNotReturnedWords(run)].filter(Boolean).join(' ') || null,
        unmet: (run.closure?.blockers ?? []).map((b) => ({ id: null, text: typeof b === 'string' ? b : (b.description ?? JSON.stringify(b)) })),
        next: 'Start a new run once the blockers are addressed.' }
    case 'candidate-changed-since-approval':
      return { ...base, headline: 'Stopped: the change was edited after it was approved', detail: 'The approval no longer describes what would be delivered.', next: 'Start a new run.' }
    case 'closure-conditions-unmet': {
      // An older triage workflow demanded implementation criteria of a
      // triage; run-result already recognises that record and says so.
      const result = runResult(run, outputs)
      if (result.resultReason === 'triage-completion-mismatch') {
        return { ...base, tone: 'neutral', headline: result.resultLabel, detail: result.resultSummary, next: 'Start an implementation run, or record the outcome yourself.' }
      }
      const closed = closureUnmet(run, latestConfirmation(outputs))
      const why = { ...closed, detail: [closed.detail, returnWords(run), notReturnedWords(run.closure?.notReturned)].filter(Boolean).join(' ') || null }
      return { ...base, ...why, next: why.unmet?.length ? 'Start a new run that addresses these points, or record the outcome yourself.' : 'Start a new run, or record the outcome yourself.' }
    }
    case 'full-verification-checks-failed': {
      const c = run.fullVerification?.check
      const fresh = [...(c?.selftest?.newFailures ?? []), ...(c?.failures?.newFailures ?? [])].map((f) => `${f.command}: ${f.test}`)
      return { ...base, headline: 'Stopped: the full verification found failures',
        detail: [`The full check of the released snapshot ${c?.result?.result === 'passed' ? 'passed but its selftest report' : 'did not pass and'} could not be judged inherited from the previous green cycle${c?.baseline?.cycleId ? ` (${c.baseline.cycleId})` : ' (there is none)'}.`, fresh.length ? `New: ${fresh.slice(0, 10).join('; ')}` : null].filter(Boolean).join(' '),
        next: 'The stage keeps what was released. The next cycle verifies again.' }
    }
    case 'refreshed-checks-failed':
      return { ...base, headline: 'Stopped: checks failed after the evidence was refreshed', next: 'Start a new run against the current project.' }
    case 'coordinator-requested-source-refresh':
      return { ...base, headline: 'Stopped: the coordinator needs a fresh copy of the project', detail: 'The project changed in ways this run cannot account for.', next: 'Start a new run to work against the current project.' }
    case 'integrity-abandoned':
      return { ...base, headline: 'Abandoned after an unexpected change to its files', next: 'Start a new run.' }
    default:
      break
  }
  if (run.integrity?.status === 'quarantined') {
    return { ...base, tone: 'error', headline: 'On hold: an agent changed files it should not have', cause: firstLine(run.integrity.latest?.reason) || null, next: 'Inspect the changes and decide whether to keep them.' }
  }
  if (DELIVERY[reason]) {
    const d = DELIVERY[reason]
    // Refused for drift on the patch's own paths: say what reconciling did or can do.
    const attempt = run.reconciliations?.at(-1)
    const refused = attempt && attempt.state !== 'accepted' ? ` Reconciling with the project was refused (${attempt.state})${attempt.conflicts?.length ? ` at ${attempt.conflicts.slice(0, 5).join(', ')}` : ''}.` : ''
    const notRun = run.autoReconcile?.state === 'not-run' ? ` The automatic reconcile did not run: ${String(run.autoReconcile.reason).replace(/\.$/, '')}.` : ''
    const next = !reconcileUnavailable(run) ? `Reconcile delivery (the Reconcile with source button) merges it onto the project and rechecks it, unless only declared inert paths drifted; otherwise: ${d.next.charAt(0).toLowerCase()}${d.next.slice(1)}` : d.next
    const conflicts = reason === 'source-delivery-blocked' ? mergeSummary(run.delivery).conflicts : null
    const returned = reason === 'source-delivery-blocked' ? deliveryNotReturnedWords(run) : ''
    return { ...base, headline: d.headline, detail: (d.detail ?? '') + (conflicts ? ` ${conflicts}` : '') + returned + refused + notRun || null, cause: firstLine(run.delivery?.error, 400) || null, next }
  }
  if (reason === 'delivery-return-interrupted') {
    return { ...base, tone: 'error', headline: 'Stopped while moving the work onto the current project',
      detail: 'The approved version conflicted with the project, and the engine was carrying it onto the current project for the author to reconcile when that step failed. The work folder may hold part of that merge; the approved patch is kept untouched.',
      cause: firstLine(run.pendingDeliveryReturn?.error, 400) || null, next: 'Apply the approved patch by hand, or start a new run: it starts from that patch.' }
  }
  if (reason === 'release-staging-not-passed') {
    return { ...base, headline: 'Stopped: staging did not pass, so production was not touched', detail: 'The staging release or one of its assessments did not pass; staging was recovered under its configured policy.', next: 'Read the staging assessments and release commands in the technical details.' }
  }
  if (typeof reason === 'string' && reason.startsWith('release-')) {
    return { ...base, headline: `Stopped: the release ${reason.slice(8).replace(/-/g, ' ')}`, next: 'Check the release commands in the technical details.' }
  }
  return { ...base, headline: 'Stopped and needs a person', detail: reason ? `Reason recorded: ${reason}.` : null }
}
