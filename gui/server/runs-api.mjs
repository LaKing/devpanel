import { acceptableCheck, reconcilePending, refreshFacts, resumeUnavailable } from './runtime/run-control.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { loadConfig, resolvePlaybook } from './config/load.mjs'
import { previewRun } from './runtime/preview.mjs'
import * as store from './runtime/store.mjs'
import { runMetrics } from './runtime/run-metrics.mjs'
import { supportedActions, LIVE_STATUSES } from './supervisor.mjs'
import { triageSuggestion } from './runtime/triage-suggestion.mjs'
import { refusedAcceptance, runResult } from './runtime/run-result.mjs'
import { explainRun } from './runtime/run-explanation.mjs'
import { closureWithAcceptances, readAcceptedRisks } from './runtime/residual-risks.mjs'
import { ownerLiveness } from './runtime/lock.mjs'
import { hostPlatform } from './runtime/platform.mjs'

/*
 * Read-only views of runs.
 *
 * Everything here reads from persisted state, never from an in-memory engine, so
 * a reconnecting browser reconstructs exactly what a fresh one would see. Nothing
 * in this module starts, stops or mutates a run.
 */

const err = (status, message) => Object.assign(new Error(message), { status })

async function issueDir (issues, project, id) {
  const issue = await issues.getIssue(project, id)   // throws IssueError(404) if absent
  return issue
}

/** Every run recorded against an issue, newest first. */
export async function listRuns (issuePath) {
  let names = []
  try {
    names = (await fs.readdir(store.runsDir(issuePath), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
      .map((e) => e.name)
  } catch {
    return []
  }

  const runs = []
  const acceptedRisks = await readAcceptedRisks(issuePath)
  for (const runId of names) {
    try {
      const run = await store.readRun(issuePath, runId)
      const outputs = await store.readOutputs(issuePath, runId)
      runs.push({
        runId: run.runId,
        supervisorLaunchId: run.supervisorLaunchId ?? null,
        playbook: run.playbook,
        status: run.status,
        outcome: run.outcome,
        ...runResult(run, outputs),
        blockedReason: run.blockedReason,
        explanation: explainRun(run, { outputs, acceptedRisks }),
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        steps: run.steps.length,
        budgets: run.budgets,
        timing: run.timing ?? null,
        preflight: run.preflight ? { state: run.preflight.state, attempts: run.preflight.attempts } : null,
        workspaceState: run.workspace?.state ?? null,
        // Only a blocked run can offer refresh-checks, which needs its snapshot.
        supportedActions: supportedActions(run, run.status === 'blocked' ? { refresh: refreshFacts(await store.readSnapshot(issuePath, run.runId).catch(() => null)) } : {})
      })
    } catch { /* a half-written run directory is not a run */ }
  }
  return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

/**
 * One run, assembled into the shape a timeline needs: every turn with its role,
 * model, prompt, response, structured output and revision.
 */
export async function getRun (issuePath, runId, { issues, project, issueId, isActive = false, platform = hostPlatform() }) {
  let run
  try {
    run = await store.readRun(issuePath, runId)
  } catch (error) {
    // Only a missing record is gone: monitoring stops following a run on a 404, and one that cannot be read today may read tomorrow.
    if (error.code === 'ENOENT') throw err(404, 'no such run')
    throw err(503, `this run's record cannot be read: ${error.message}`)
  }
  // A live-looking run this process is not driving, whose lock owner cannot be
  // proved alive or dead: the explanation says so and names the lock.
  let ownership = null
  if (!isActive && LIVE_STATUSES.includes(run.status)) {
    const file = path.join(issuePath, '.run.lock')
    const lock = await fs.readFile(file, 'utf8').then(JSON.parse, () => null)
    if (lock?.owner?.runId === runId && await ownerLiveness(lock.owner, { platform }) === 'unknown') {
      ownership = { state: 'owner-unknown', pid: lock.owner.pid ?? null, host: lock.owner.host ?? null, file }
    }
  }

  const [snapshot, outputs, prompts, events] = await Promise.all([
    store.readSnapshot(issuePath, runId).catch(() => null),
    store.readOutputs(issuePath, runId),
    store.readPrompts(issuePath, runId),
    store.inspectRunJournal(issuePath, runId)
  ])

  const issue = await issues.getIssue(project, issueId)
  const stepsOnDisk = new Map(issue.steps.map((s) => [s.number, s]))

  const currentRevision = run.revisions.at(-1)?.fingerprint ?? null

  const timeline = run.steps.map((step) => {
    const output = outputs[step.number] ?? null
    const prompt = prompts[step.invocationId] ?? null
    const participant = snapshot?.participants?.[step.role] ?? null
    const review = output?.contract === 'reviewResult' && output.valid ? output.output : null

    return {
      number: step.number,
      slug: step.slug,
      stepId: step.stepId,
      role: step.role,
      phase: step.phase,
      round: step.round,
      attempt: step.attempt,
      invocationId: step.invocationId,
      // A repair is a restatement of the same turn, not a new one.
      isRepair: step.attempt > 1,
      // Agent time: asked → answered. Deliberately excludes the persistence that
      // follows, which is devpanel's work rather than the model's.
      timing: {
        startedAt: step.startedAt ?? null,
        endedAt: step.endedAt ?? null,
        durationMs: step.durationMs ?? null,
        unknownReason: step.durationUnknown ?? null
      },
      participant: participant && {
        model: participant.model?.id ?? null,
        wireModel: participant.model?.wire ?? null,
        harness: participant.model?.harness ?? null,
        profile: participant.model?.profile ?? null,
        effort: participant.effort ?? null
      },
      session: run.participants[step.role]?.session?.id ?? null,
      prompt: prompt && {
        source: prompt.source,
        appended: prompt.appended ?? [],
        rendered: prompt.rendered,
        at: prompt.at
      },
      hasResponse: stepsOnDisk.has(step.number),
      output: output && { contract: output.contract, valid: output.valid, error: output.error ?? null, value: output.output ?? null, adopted: Boolean(output.adopted) },
      verdict: review?.verdict ?? null,
      findings: review?.findings ?? [],
      revision: step.revision ?? null,
      // Evidence is only evidence for the revision it names.
      appliesToCurrentRevision: step.revision ? step.revision === currentRevision : null,
      usage: step.usage ?? null,
      // Operator instructions this turn's prompt carried (coordinator chat).
      instructions: step.instructions ?? []
    }
  })

  // An in-flight invocation is not streamed text — it is simply a turn that has
  // been asked and has not answered.
  const active = Object.entries(run.participants)
    .filter(([, p]) => LIVE_STATUSES.includes(run.status) && p.pendingInvocation)
    .map(([role, p]) => ({
      role,
      stepId: p.pendingInvocation.cursor?.stepId ?? null,
      round: p.pendingInvocation.cursor?.round ?? null,
      attempt: p.pendingInvocation.cursor?.attempt ?? null,
      invocationId: p.pendingInvocation.invocationId,
      startedAt: p.pendingInvocation.startedAt,
      state: p.state,
      // Liveness, as last persisted. Never a claim of progress.
      activity: p.pendingInvocation.activity ?? null
    }))

  const acceptedRisks = await readAcceptedRisks(issuePath)
  const approvals = run.approvals.map((a) => ({ ...a, appliesToCurrentRevision: a.revision === currentRevision }))
  const actions = supportedActions(run, { active: isActive, refresh: refreshFacts(snapshot) })
  const checkResults = run.checkResults.map((c) => ({ ...c, appliesToCurrentRevision: c.revision === currentRevision }))

  return {
    runId: run.runId,
    supervisorLaunchId: run.supervisorLaunchId ?? null,
    issue: run.issue,
    playbook: run.playbook,
    status: run.status,
    outcome: run.outcome,
    ...runResult(run, outputs),
    blockedReason: run.blockedReason,
    reconcilePending: reconcilePending(run),
    explanation: explainRun(run, { outputs, active, ownership, acceptedRisks }),
    // Only what the backend will actually accept. A button for anything else
    // would promise something the server refuses.
    actions,
    // The same list under its older name, for the panel and supervisor sessions that read it.
    supportedActions: actions,
    // What Accept check result has to name, while it is offered.
    ...(actions.includes('accept-check-result') ? { acceptCheck: (({ revision, failures, notRun }) => ({ revision, failures, notRun }))(acceptableCheck(run)) } : {}),
    ...(run.checkAcceptanceRequest ? { checkAcceptanceRequest: run.checkAcceptanceRequest } : {}),
    ...(refusedAcceptance(run) ? { checkAcceptanceRefusal: refusedAcceptance(run) } : {}),
    recovery: run.recovery,
    abandonment: run.abandonment ? { at: run.abandonment.at, by: run.abandonment.by } : null,
    pause: run.pause ?? null,
    pauseRequested: run.pauseRequested ?? null,
    stoppedBy: run.stoppedBy ?? null,
    autoResumeRefused: run.autoResumeRefused ?? null,
    resumeUnavailable: resumeUnavailable(run),
    resumeHistory: run.resumeHistory ?? [],
    suspendedMs: (run.controlSuspendedMs ?? 0) + (run.inputRetrySuspendedMs ?? 0) + (run.checkRefreshSuspendedMs ?? 0),
    failure: run.failure ?? null,
    failures: run.failures ?? [],
    // Ran without the seat fence, under the install's opt-in (confinement-policy.mjs).
    unfenced: run.unfenced ?? null,
    modelSubstitutions: run.modelSubstitutions ?? [],
    modelFallbackChecks: run.modelFallbackChecks ?? [],
    integrity: run.integrity ?? null,
    currentWindow: run.currentWindow ?? null,
    reportDisposition: run.reportDisposition ?? null,
    release: run.release ?? null,
    // What the paid probes cost, kept even when they refused the launch.
    preflight: run.preflight ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    // Convergence measurements read off the record: rounds and restarts, the
    // time split, and distinct findings versus confirmations.
    metrics: runMetrics(run, { outputs }),
    phase: run.phase,
    active,
    participants: Object.fromEntries(Object.entries(run.participants).map(([role, p]) => [role, {
      role,
      model: p.model,
      harness: p.harness,
      profile: p.profile,
      effort: p.effort,
      sessionAssignment: p.sessionAssignment,
      session: p.session?.id ?? null,
      state: p.state,
      turns: p.turns
    }])),
    runOptions: snapshot?.runOptions ?? {},
    budgets: run.budgets,
    timing: run.timing ?? null,
    workspace: run.workspace && {
      path: run.workspace.path,
      isolation: run.workspace.isolation,
      baseCommit: run.workspace.baseCommit,
      base: run.workspace.base ?? null,
      state: run.workspace.state,
      // A retained workspace still holds work nothing else captured.
      retainedReason: run.workspace.retainedReason ?? null
    },
    revisions: run.revisions,
    currentRevision,
    approvals,
    checkResults,
    outstandingFindings: run.outstandingFindings ?? [],
    delivery: run.delivery,
    artifactApplication: run.artifactApplication ?? null,
    // A person's record that they landed the work by hand (supervisor.markLanded).
    landed: run.landed ?? null,
    reconciliations: run.reconciliations ?? [],
    integration: run.integration ?? null,
    ownerInput: run.ownerInput ?? null,
    closure: closureWithAcceptances(run, acceptedRisks),
    checks: snapshot?.checks ?? null,
    autoClose: snapshot?.autoClose ?? null,
    completion: snapshot?.completion ?? null,
    triageSuggestion: triageSuggestion(snapshot, run, outputs, await fs.readFile(path.join(store.runDir(issuePath, runId), 'triage-suggestion.json'), 'utf8').then(JSON.parse).catch(() => null)),
    // Why the protocol failed, attempt by attempt, so a reader — human or
    // supervisor — can tell an agent that broke the contract from an engine
    // that could not read what the agent wrote, before paying for a retry.
    diagnostics: { protocol: protocolDiagnostics(run, outputs) },
    timeline,
    journal: { ...events, events: undefined },
    events: events.events.slice(-200)
  }
}

/** Every attempt whose structured output was rejected, with the validator's words. */
export function protocolDiagnostics (run, outputs) {
  return run.steps
    .map((step) => ({ step, output: outputs[step.number] }))
    .filter(({ output }) => output && output.contract && output.valid !== true)
    .map(({ step, output }) => ({
      step: step.number,
      stepId: step.stepId,
      role: step.role,
      round: step.round,
      attempt: step.attempt,
      contract: output.contract,
      classification: output.classification ?? null,
      error: output.error ?? null,
      candidates: output.diagnostics?.candidates ?? null
    }))
}

/** The runtime's output for one invocation, after a sequence number. */
export async function readLiveOutput (issuePath, runId, invocationId, { after = 0 } = {}) {
  const run = await store.readRun(issuePath, runId).catch(() => null)
  if (!run) throw err(404, 'no such run')
  const entries = await store.readLive(issuePath, runId, invocationId, { after })
  const pending = Object.values(run.participants).some((p) => p.pendingInvocation?.invocationId === invocationId)
  return { invocationId, entries, next: entries.at(-1)?.seq ?? after, live: pending }
}

/** A step's response, as text. Kept separate: it can be large. */
export async function readStepResponse (issues, project, issueId, number) {
  const issue = await issues.getIssue(project, issueId)
  const step = issue.steps.find((s) => s.number === number)
  if (!step) throw err(404, 'no such step')
  try {
    return await fs.readFile(path.join(step.path, 'response.md'), 'utf8')
  } catch {
    throw err(404, 'that step has no response yet')
  }
}

/** Playbooks available to start, with their resolution state. */
export async function listPlaybooks ({ root, includeDeprecated = false } = {}) {
  const config = await loadConfig({ root })
  const out = []
  for (const id of config.playbooks.keys()) {
    if (config.playbooks.get(id).deprecated && !includeDeprecated) continue
    const resolution = await resolvePlaybook(id, { config, root: config.root })
    out.push(resolution.ok
      ? {
          id,
          title: resolution.resolved.playbook.title,
          description: resolution.resolved.playbook.description,
          strategy: resolution.resolved.strategy.id,
          intent: resolution.resolved.intent?.id ?? null,
          intents: resolution.resolved.parameterDefinitions.intents,
          participants: Object.fromEntries(Object.entries(resolution.resolved.participants)
            .map(([role, p]) => [role, { model: p.model.id, harness: p.model.harness, effort: p.effort }])),
          liveEligible: resolution.resolved.liveExecution.eligible,
          blockers: resolution.resolved.liveExecution.blockers,
          configHash: resolution.resolved.configHash,
          ok: true
        }
      : { id, ok: false, errors: resolution.errors })
  }
  return out
}

export const preview = (playbookId, options) => previewRun({ playbookId, ...options })
