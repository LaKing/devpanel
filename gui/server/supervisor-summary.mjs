import { riskId } from './runtime/residual-risks.mjs'
import crypto from 'node:crypto'
import { checkSummary } from './runtime/check-summary.mjs'
import { concurrentStarts } from './supervisor-starts.mjs'

/*
 * What the top-level supervisor is shown.
 *
 * A model deciding what to do next needs the shape of a run, not its bytes:
 * the first live sessions handed it 283 KB run views and 300–490 KB prompts.
 * Everything here is a summary with an explicit path to detail — `get_step`
 * for a turn's prompt, response and output; `get_file` for an issue file —
 * so nothing is hidden, only deferred.
 */

const clip = (text, n) => {
  if (typeof text !== 'string') return text ?? null
  return text.length > n ? `${text.slice(0, n)}… [${text.length - n} more chars; use get_step for the full text]` : text
}

/** First non-empty line of a response, as a one-line gist. */
const gist = (text, n = 200) => {
  if (typeof text !== 'string') return null
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('```'))
  return line ? clip(line, n) : null
}

/** The latest reconciliation that ended: an entry persisted as `merging` has decided nothing yet. */
function decidedReconciliation (entries) {
  const entry = (entries ?? []).findLast((e) => e.endedAt)
  if (!entry) return null
  // An earlier refused attempt's check stays readable too: get_check_log finds it by the directory named here.
  const earlier = entries.filter((e) => e.endedAt && e.checks && e !== entry).map(reconciliationSummary)
  return { ...reconciliationSummary(entry), ...(earlier.length ? { earlier } : {}) }
}

function reconciliationSummary (entry) {
  return { n: entry.n, state: entry.state, by: entry.by ?? null, endedAt: entry.endedAt, revision: entry.revision ?? null, conflicts: entry.conflicts ?? [], error: clip(entry.error, 500), ...(entry.noDrive ? { noDrive: entry.noDrive } : {}),
    ...(entry.checks ? { checks: { ...checkSummary(entry.checks), gating: entry.checks.gating ?? null, reason: entry.checks.reason ?? null } } : {}) }
}

/**
 * What monitoring compares, beside the status, to learn that a run's delivery was decided
 * (top-supervisor.mjs poll). Each key is a name `run-changed` reports in `changed`. It reads
 * only fields summariseRun and summarisePackedRun both carry, so packing changes nothing here.
 */
export function deliveryReading (run) {
  const { reconciliation: r, landed, delivery, artifactApplication, integration } = run
  return {
    reconcile: r ? `${r.n}:${r.state}:${r.endedAt}` : null,
    landing: landed?.recordedAt ?? null,
    delivery: JSON.stringify([delivery?.action ?? null, delivery?.completedAt ?? null, delivery?.application?.state ?? null, artifactApplication?.state ?? null, integration?.mergeCommit ?? null])
  }
}

/**
 * What get_run compares to say a run has nothing new (top-supervisor.mjs readRun): the whole summary, minus
 * the two things that move while a run is simply working. `active[].activity` is liveness, re-persisted every
 * few seconds, and `metrics.time` is derived from the clock at read time. Everything else counts, a field added
 * later included, so what this gets wrong costs one more full record and never hides a change.
 */
export function runReading (run) {
  const { metrics, active, ...rest } = run
  const { time: _time, ...measured } = metrics ?? {}
  const steady = { ...rest, metrics: measured, active: (active ?? []).map(({ activity: _activity, ...turn }) => turn) }
  return crypto.createHash('sha256').update(JSON.stringify(steady)).digest('hex')
}

/** The latest check's verdict: the gate's reading of the last drive when the record has one, else its bare result. */
function checksVerdict (run) {
  const drive = (run.checkHistory ?? []).at(-1)
  const check = drive ?? (run.checkResults ?? []).at(-1)
  if (!check) return null
  return { revision: check.revision ? check.revision.slice(0, 23) : null, result: check.result ?? null, gating: drive?.gating ?? null, tier: check.tier ?? null, at: check.at ?? null, ...(drive?.inconclusive ? { inconclusive: true } : {}) }
}

/**
 * What monitoring compares to learn that a run progressed: each key is a name `run-changed` reports in
 * `changed`. A packed run's record has no phase or check verdict to read, so those stay out of it and
 * packing is not read as a change (top-supervisor.mjs poll).
 */
export function progressReading (run) {
  return {
    ...(run.packed ? {} : {
      phase: run.phase?.id ? { id: run.phase.id, round: run.phase.round ?? 0 } : null,
      checks: run.checksVerdict ?? null
    }),
    blockedReason: run.blockedReason ?? null
  }
}

/**
 * A run change as the supervisor's session keeps it. Every event stays in the native session and is re-read
 * on every later call, so this is the run's standing and what the model acts on without another read: what it
 * must copy into an action (pause.id, acceptCheck) and what it must relay (ownerInput). The steps, metrics,
 * budgets and diagnostics are `get_run`'s.
 */
export function runDelta (run, { from = null } = {}) {
  const { reconciliation: r, failure, pause, delivery, integration, recovery } = run
  const latestSubstitution = (run.modelSubstitutions ?? []).at(-1)
  return {
    runId: run.runId ?? null,
    project: run.issue?.project ?? run.project ?? null,
    issueId: run.issue?.id ?? run.issueId ?? null,
    playbook: run.playbook?.id ?? null,
    status: run.status ?? null,
    outcome: run.outcome ?? null,
    result: run.result ?? null,
    resultReason: run.resultReason ?? null,
    phase: run.phase?.id ? { id: run.phase.id, round: run.phase.round ?? 0 } : null,
    checks: run.checksVerdict ?? null,
    blockedReason: run.blockedReason ?? null,
    actions: run.actions ?? [],
    ...(from && Object.keys(from).length ? { from } : {}),
    ...(pause ? { pause: { id: pause.id, question: clip(pause.question, 2000), options: pause.options ?? null, kind: pause.kind ?? null, ...(pause.request ? { request: pause.request } : {}) } } : {}),
    ...(failure ? { failure: { class: failure.class ?? null, message: clip(failure.message ?? failure.error ?? null, 500) } } : {}),
    ...(run.ownerInput ? { ownerInput: run.ownerInput } : {}),
    ...(run.splitSuggestion ? { splitSuggestion: run.splitSuggestion } : {}),
    ...(run.acceptCheck ? { acceptCheck: run.acceptCheck } : {}),
    ...(run.checkAcceptanceRequest ? { checkAcceptanceRequest: run.checkAcceptanceRequest } : {}),
    ...(run.checkAcceptanceRefusal ? { checkAcceptanceRefusal: run.checkAcceptanceRefusal } : {}),
    ...(r ? { reconciliation: { n: r.n, state: r.state, by: r.by ?? null, endedAt: r.endedAt ?? null, revision: r.revision ?? null, conflicts: r.conflicts ?? [], error: r.error ?? null, ...(r.noDrive ? { noDrive: r.noDrive } : {}), ...(r.checks ? { checks: { dir: r.checks.dir ?? null, result: r.checks.result ?? null, gating: r.checks.gating ?? null, reason: r.checks.reason ?? null } } : {}) } } : {}),
    ...(run.landed ? { landed: run.landed } : {}),
    ...(delivery ? { delivery: { action: delivery.action ?? null, completedAt: delivery.completedAt ?? null, verified: delivery.verified ?? null, state: delivery.application?.state ?? null, error: clip(delivery.error ?? null, 500) } } : {}),
    ...(run.artifactApplication ? { artifactApplication: { state: run.artifactApplication.state ?? null, verified: run.artifactApplication.verified ?? null } } : {}),
    ...(integration ? { integration: { phase: integration.phase ?? null, targetBranch: integration.targetBranch ?? null, mergeCommit: integration.mergeCommit ?? null, error: clip(integration.error ?? null, 500) } } : {}),
    ...(recovery?.required ? { recovery: { required: true } } : {}),
    ...(latestSubstitution ? { substitution: latestSubstitution } : {}),
    detail: 'A delta. Detail, only when a decision depends on it: get_run {project, issueId, runId}.'
  }
}

/** A run of a packed issue, read from its bundle's record (`record` is run.json): no steps, its ending and its delivery. */
export function summarisePackedRun ({ runId, project, issueId, record }) {
  return { runId, project, issueId, packed: true, actions: [], status: record.status, outcome: record.outcome ?? null, blockedReason: record.blockedReason ?? null,
    budgets: record.budgets ?? null, modelSubstitutions: record.modelSubstitutions ?? [],
    landed: record.landed ?? null, reconciliation: decidedReconciliation(record.reconciliations), artifactApplication: record.artifactApplication ?? null,
    delivery: record.delivery ? { action: record.delivery.action, completedAt: record.delivery.completedAt, application: record.delivery.application ?? null } : null,
    integration: record.integration ? { mergeCommit: record.integration.mergeCommit ?? null } : null,
    note: 'The issue is archived and packed; its steps are in the bundle (restore the issue to read them).' }
}

/** A run, as the supervisor needs it. `detail` is the panel's full run view. */
export function summariseRun (detail) {
  if (!detail || typeof detail !== 'object') return detail
  const steps = (detail.timeline ?? []).map((turn) => ({
    step: turn.number,
    stepId: turn.stepId,
    role: turn.role,
    round: turn.round,
    attempt: turn.attempt,
    isRepair: turn.isRepair || false,
    durationMs: turn.timing?.durationMs ?? null,
    outputValid: turn.output?.valid ?? null,
    outputError: turn.output?.error ?? null,
    verdict: turn.verdict ?? null,
    findings: (turn.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, blocking: f.blocking })),
    revision: turn.revision ? turn.revision.slice(0, 23) : null,
    usage: turn.usage ?? null
  }))
  const closure = detail.closure
    ? {
        revision: detail.closure.revision,
        verificationLevel: detail.closure.verificationLevel,
        authorised: detail.closure.authorised,
        conditions: detail.closure.conditions,
        residualRisks: (detail.closure.residualRisks ?? []).map((r) => ({ id: riskId(r.description), accepted: r.accepted ?? null, ...(r.acceptance ? { acceptance: r.acceptance } : {}), relatesTo: r.relatesTo ?? null, description: clip(r.description, 300) })),
        ...(detail.closure.acceptedCheckRisk ? { acceptedCheckRisk: detail.closure.acceptedCheckRisk } : {})
      }
    : null
  return {
    runId: detail.runId,
    supervisorLaunchId: detail.supervisorLaunchId ?? null,
    ...(detail.startOverlap ? { startOverlap: detail.startOverlap } : {}),
    issue: detail.issue,
    playbook: detail.playbook,
    status: detail.status,
    outcome: detail.outcome,
    result: detail.result ?? null,
    resultReason: detail.resultReason ?? null,
    artifactApplication: detail.artifactApplication ?? null,
    landed: detail.landed ?? null,
    reconciliation: decidedReconciliation(detail.reconciliations),
    reconcilePending: detail.reconcilePending === true,
    ...(detail.acceptCheck ? { acceptCheck: detail.acceptCheck } : {}),
    ...(detail.checkAcceptanceRequest ? { checkAcceptanceRequest: detail.checkAcceptanceRequest } : {}),
    ...(detail.checkAcceptanceRefusal ? { checkAcceptanceRefusal: detail.checkAcceptanceRefusal } : {}),
    blockedReason: detail.blockedReason ?? null,
    pause: detail.pause ?? null,
    ownerInput: detail.ownerInput ?? null,
    // Verbatim: the words and parts the run explanation's `next` gives a person.
    ...(detail.explanation?.splitSuggestion ? { splitSuggestion: detail.explanation.splitSuggestion } : {}),
    failure: detail.failure ?? null,
    modelSubstitutions: detail.modelSubstitutions ?? [],
    modelFallbackChecks: (detail.modelFallbackChecks ?? []).map(c => ({ at: c.at, role: c.role, model: c.model, launchReady: c.result?.launchReady })),
    recovery: detail.recovery?.required ? detail.recovery : null,
    phase: detail.phase ?? null,
    checksVerdict: checksVerdict(detail),
    currentWindow: detail.currentWindow ? {id:detail.currentWindow.id,capturedAt:detail.currentWindow.capturedAt,source:detail.currentWindow.source,coverage:detail.currentWindow.coverage} : null,
    reportDisposition: detail.reportDisposition ? {...detail.reportDisposition,response:clip(detail.reportDisposition.response,3000)} : null,
    autoStart: detail.autoStart ?? null,
    release: detail.release ? {runId:detail.release.runId,environment:detail.release.environment,status:detail.release.status,sha256:detail.release.sha256,checkpointVerified:detail.release.checkpointVerified,commands:detail.release.commands.map(c=>({id:c.id,status:c.status,error:c.error??null}))} : null,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt ?? null,
    budgets: detail.budgets ?? null,
    metrics: detail.metrics ?? null,
    currentRevision: detail.currentRevision ?? null,
    approvals: (detail.approvals ?? []).map((a) => ({ role: a.role, step: a.step, appliesToCurrentRevision: a.appliesToCurrentRevision })),
    outstandingFindings: (detail.outstandingFindings ?? []).map((f) => ({ id: f.id, severity: f.severity, blocking: f.blocking, source: f.source ?? null, description: clip(f.description, 200) })),
    checkResults: (detail.checkResults ?? []).map(c => checkSummary(c)),
    closure,
    delivery: detail.delivery
      ? { action: detail.delivery.action, completedAt: detail.delivery.completedAt, artifactRef: detail.delivery.artifactRef, bytes: detail.delivery.bytes ?? null, verified: detail.delivery.action === 'apply-to-source' ? detail.delivery.application?.verified === true : detail.delivery.reconstruction?.verified ?? null, application: detail.delivery.application ?? null, error: detail.delivery.error ?? null }
      : null,
    integration: detail.integration
      ? { phase: detail.integration.phase ?? null, targetBranch: detail.integration.targetBranch, mergeCommit: detail.integration.mergeCommit, approvedBy: detail.integration.approvedBy, error: detail.integration.error ?? null, warning: detail.integration.warning ?? null, staleCheckouts: (detail.integration.worktrees?.stale ?? []).map((x) => ({ worktree: x.worktree, error: x.error, remedy: x.remedy ?? null })) }
      : null,
    workspace: detail.workspace ?? null,
    diagnostics: detail.diagnostics ?? null,
    active: detail.active ?? [],
    actions: detail.actions ?? [],
    // The same list under its older name: a session already running was told to read it.
    supportedActions: detail.actions ?? [],
    steps,
    detail: 'Each step\'s prompt, response and structured output: get_step {project, issueId, runId, step}.'
  }
}

/** One turn in full: what was asked, what came back, what the engine made of it. */
export function summariseStep (detail, number, response) {
  const turn = (detail.timeline ?? []).find((t) => String(t.number).padStart(3, '0') === String(number).padStart(3, '0'))
  if (!turn) return null
  return {
    step: turn.number,
    stepId: turn.stepId,
    role: turn.role,
    round: turn.round,
    attempt: turn.attempt,
    participant: turn.participant ?? null,
    timing: turn.timing ?? null,
    prompt: turn.prompt ? { source: turn.prompt.source?.kind ?? null, by: turn.prompt.source?.by ?? null, appended: (turn.prompt.appended ?? []).map((a) => a.reason), rendered: clip(turn.prompt.rendered, 16000), originalChars: turn.prompt.rendered?.length ?? 0, truncated: (turn.prompt.rendered?.length ?? 0) > 16000 } : null,
    response: clip(response ?? '', 60000),
    output: turn.output ?? null,
    findings: turn.findings ?? [],
    revision: turn.revision ?? null,
    usage: turn.usage ?? null
  }
}

/** A preview, without the rendered prompt bodies. */
/*
 * A check target as a decision needs it: which commands, in which tier, gating
 * or not. Their shell text (11k for one project, repeated under testDrive) is
 * the projects/<id>.yaml configuration; the run's check record and
 * get_check_log hold what each command did.
 */
const compactCommand = (c) => ({ id: c.id, ...(c.required === false ? { required: false } : {}), ...(c.kind ? { kind: c.kind } : {}), ...(c.report ? { report: c.report } : {}) })
function compactTarget (target) {
  if (!target || typeof target !== 'object') return target ?? null
  const out = { ...target }
  for (const key of ['commands', 'finallyCommands']) if (Array.isArray(out[key])) out[key] = out[key].map(compactCommand)
  if (out.baselineCache?.environment) out.baselineCache = { ...out.baselineCache, environment: 'configured (a command)' }
  return out
}

export function summarisePreview (preview) {
  if (!preview?.ok) return preview
  return {
    ok: true,
    configHash: preview.configHash,
    playbook: preview.playbook ? { id: preview.playbook.id, title: preview.playbook.title, description: preview.playbook.description } : null,
    strategy: preview.strategy ? { id: preview.strategy.id, version: preview.strategy.version } : null,
    tactic: preview.tactic ?? null,
    intent: preview.intent ?? null,
    intents: (preview.parameterDefinitions?.intents ?? []).map((i) => ({ id: i.id, title: i.title })),
    runOptions: preview.runOptions ?? {},
    seats: preview.parameterDefinitions?.seats ?? [],
    release: preview.parameterDefinitions?.release ?? null,
    participants: (preview.participants ?? []).map((p) => ({ role: p.role, model: p.model, harness: p.connection?.harness ?? null, effort: p.effort, verification: p.verification })),
    phases: (preview.phases ?? []).map((p) => ({ id: p.id, kind: p.kind, maxRounds: p.loop?.maxRounds ?? null, steps: p.steps.map((s) => `${s.role}:${s.id}`) })),
    workspace: preview.workspace ?? null,
    checks: preview.checks ? { ...preview.checks, target: compactTarget(preview.checks.target) } : null,
    infrastructure: preview.infrastructure ? { ...preview.infrastructure, ...(preview.infrastructure.testDrive ? { testDrive: compactTarget(preview.infrastructure.testDrive) } : {}) } : null,
    autoClose: preview.autoClose ?? null,
    delivery: preview.delivery ?? null,
    limits: preview.limits ?? null,
    prerequisites: preview.prerequisites ?? [],
    ...(preview.pathOverlap ? { pathOverlap: preview.pathOverlap } : {}),
    configurationReady: preview.configurationReady,
    liveEligible: preview.liveEligible
  }
}

/** An issue with its material clipped, and its runs summarised to a line each. */
export function summariseIssue ({ issue, reports, runs }) {
  return {
    issue: {
      id: issue.id, name: issue.name, project: issue.project, status: issue.status, archived: issue.archived,
      openedOn: issue.openedOn, openedBy: issue.openedBy ?? null, report: issue.report ?? null, path: issue.path, disposition: issue.disposition ?? null,
      // The latest triage's sizing: size, each seat's sentence, the modules and the recommended playbook.
      sizing: issue.sizing ?? null,
      ...(issue.repeats ? { repeats: issue.repeats } : {}), ...(issue.repeatLookup ? { repeatLookup: issue.repeatLookup } : {}), ...(issue.sameTitleAs ? { sameTitleAs: issue.sameTitleAs } : {}),
      // Never clipped: a risk's text, like its id, names it in acceptRisks.
      unacceptedRisks: issue.unacceptedRisks ?? null, acceptedRisks: issue.acceptedRisks ?? [],
      steps: (issue.steps ?? []).map((s) => ({ number: s.number, slug: s.slug, files: (s.files ?? []).map((f) => f.name) })),
      ...(issue.archivedNotes?.length ? { archivedNotes: issue.archivedNotes.map((n) => ({ text: clip(n.text, 2000), at: n.at })) } : {})
    },
    reports: (reports ?? []).map((r) => ({ step: r.step, name: r.name, text: clip(r.text, 6000), truncated: typeof r.text === 'string' && r.text.length > 6000 })),
    runs: (runs ?? []).map((r) => ({ runId: r.runId, playbook: r.playbook, status: r.status, outcome: r.outcome, result: r.result ?? null, blockedReason: r.blockedReason, startedAt: r.startedAt, endedAt: r.endedAt, steps: r.steps, workspaceState: r.workspaceState ?? null })),
    detail: 'Full file text: get_file {project, issueId, step, name}. Full run: get_run; one turn: get_step.'
  }
}

/** One window's ceilings beside what it holds, each as used/limit/remaining. */
function windowAllowance (limits, held, rolls) {
  const spent = held.committedUsdMicros >= Math.round(limits.usd * 1e6)
  const allowance = (used, limit, consequence) => ({
    used, limit, remaining: Math.max(0, limit - used),
    ...(used >= limit ? { exhausted: true, consequence } : {})
  })
  return {
    rollsOver: rolls,
    starts: allowance(held.starts, limits.starts, `no further run start until ${rolls}`),
    usd: {
      committed: held.committedUsd, limit: limits.usd,
      remaining: Math.max(0, Math.round((limits.usd * 1e6 - held.committedUsdMicros)) / 1e6),
      // Part of `committed`: this share is tokens times a price, not a reported cost.
      ...(held.estimatedUsdMicros ? { estimated: held.estimatedUsd } : {}),
      ...(spent ? { exhausted: true, consequence: `nothing further is admitted until ${rolls}, priced or not` } : {})
    },
    unpricedRuns: allowance(held.unpricedRuns, limits.unpricedRuns, `no further run without a configured maxCostUsd until ${rolls}`),
    unpricedCalls: allowance(held.unpricedCalls, limits.unpricedCalls, `no further model call whose price the provider does not report, until ${rolls}`),
    ...(held.unknownCalls ? { unknownCalls: held.unknownCalls } : {})
  }
}

/** Authoritative remaining budget, with a scope for each independent limit. */
export function remainingBudget (state, { policy = { active: false }, usage = null, wakeCalls = null } = {}) {
  const startsByIssue = {}
  for (const [key, used] of Object.entries(state.startsByIssue ?? {})) startsByIssue[key] = Math.max(0, state.limits.maxStartsPerIssue - used)
  /*
   * Every allowance says used, limit AND remaining, in that shape.
   *
   * A bare number under a key called "remaining" is not unambiguous enough: a
   * supervisor read `remaining.starts: 0` as "none used, so two available", told
   * the operator there was room, and built a risk tradeoff on top of the wrong
   * number. The reading was wrong, but a payload that makes it possible is a
   * payload to fix. A triple cannot be read backwards, and `exhausted` states the
   * consequence in words rather than leaving it to arithmetic.
   */
  const allowance = (used, limit, consequence) => ({
    used, limit: limit ?? null,
    remaining: limit == null ? null : Math.max(0, limit - used),
    ...(limit != null && used >= limit ? { exhausted: true, consequence } : {})
  })
  return {
    scope: 'calls, starts and starts per issue: this session (Start and restart resume it; only an operator\'s New session begins a fresh one); concurrency: live runs plus unresolved reservations',
    scopes: { maxCalls: 'session', maxRuns: 'session', maxStartsPerIssue: 'project/issue, this session', maxConcurrent: 'live runs and launch reservations' },
    reading: 'Each allowance is {used, limit, remaining}. remaining 0 means no further attempt is possible, whatever used says.',
    calls: allowance(state.calls ?? 0, state.limits.maxCalls, 'no further model call this session; the activation stops until an operator raises maxCalls on Start or begins a New session'),
    // Session limits always decide. Where a spending policy is active the
    // windows below decide as well; they bound calendar spending, not sessions.
    starts: allowance(state.starts ?? 0, state.limits.maxRuns,
      'every run start is refused, on every project, until an operator raises maxRuns on Start or begins a New session'),
    ...(policy.active
      ? {
          policy: {
            decides: policy.policy.enforceAllowances === true,
            accountingOnly: policy.policy.enforceAllowances !== true,
            instruction: policy.policy.enforceAllowances === true ? 'Configured allowances gate admission.' : 'Cost and calendar totals are reporting only. Continue work regardless of these totals; only provider quota errors establish account exhaustion.',
            perWakeCalls: allowance(wakeCalls ?? 0, policy.policy.perWakeCalls, 'this event chain ends; the next event starts a new one with its own allowance'),
            windows: usage && policy.policy.enforceAllowances !== true ? { day: usage.day, month: usage.month } : usage
              ? {
                  day: windowAllowance(policy.policy.daily, usage.day, 'the next UTC day'),
                  month: windowAllowance(policy.policy.monthly, usage.month, 'the next UTC month')
                }
              : null
          }
        }
      : { policy: { decides: false, reason: policy.reason ?? 'no spending policy is configured', note: 'only the session limits gate admission' } }),
    startsPerIssue: state.limits.maxStartsPerIssue,
    startsUsedByIssue: state.startsByIssue ?? {},
    startsRemainingByIssue: startsByIssue,
    concurrent: { used: concurrentStarts(state), limit: state.limits.maxConcurrent ?? null },
    activationStarts: state.activationStarts ?? 0,
    history: state.history ? { ...state.history, role: 'accounting', decides: false } : null,
    note: 'An issue absent from startsUsedByIssue has all startsPerIssue remaining. history is what earlier sessions used; it decides nothing.'
  }
}
