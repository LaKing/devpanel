import { resolvePlaybook } from '../config/load.mjs'
import { sizingSummary } from './triage-sizing.mjs'

/*
 * Dry-run preview.
 *
 * Reads configuration and renders what a run WOULD do. It performs no side
 * effects at all: no invocation, no authentication probe, no workspace, no run
 * directory, no lock, no step allocation.
 *
 * Values that only exist at runtime are rendered as visible symbolic slots
 * rather than blanked out. An empty string reads as "this template has nothing
 * there", which is a different and misleading claim.
 */

const OPEN = '«'   // «
const CLOSE = '»'  // »

export const symbolic = (ref, note) => `${OPEN}${ref}${note ? ` · ${note}` : ''}${CLOSE}`

/** Which context references can be resolved before anything has run. */
function knownContext (issue, project, playbook) {
  return {
    issue: {
      name: issue?.name ?? null,
      openedOn: issue?.openedOn ?? null,
      path: issue?.path ?? null,
      project: issue?.project ?? project?.id ?? null
    },
    project: { id: project?.id ?? null, path: project?.path ?? null },
    playbook: { id: playbook.id, title: playbook.title, description: playbook.description ?? null },
    // A sized issue's triage decision (issue.json `sizing`); unsized, the slot says where it comes from.
    ...(issue?.sizing ? { sizing: sizingSummary(issue.sizing) } : {})
  }
}

const resolvePath = (ctx, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), ctx)

/** Describe where a runtime-only value will come from, so the slot is informative. */
function describeRef (ref, stepsById) {
  const step = /^steps\.([a-z0-9-]+)\./.exec(ref)
  if (step) {
    const producer = stepsById.get(step[1])
    return producer ? `produced at runtime by the ${producer.role} in step "${step[1]}"` : 'produced at runtime'
  }
  if (ref.startsWith('acceptanceCriteria')) return 'recorded by the coordinator during triage'
  if (ref.startsWith('findings.outstanding')) return 'from the latest review'
  if (ref.startsWith('findings.plan')) return 'substantial findings raised while the plan was under review'
  if (ref === 'plan.current') return 'the latest plan the author produced, revisions included'
  if (ref === 'plan.approved') return 'the plan the auditor approved, tied to that audit'
  if (ref.startsWith('revision.current')) return 'fingerprint of the candidate, once one exists'
  if (ref.startsWith('checks.latest')) return 'result of the most recent check run'
  if (ref === 'sizing') return "the issue's triage sizing (issue.json sizing: size, each seat's sentence, affected modules), frozen into the run's window"
  return 'not known until the run starts'
}

function renderTemplate (body, ctx, stepsById) {
  const slots = []
  const text = body.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, ref) => {
    const value = resolvePath(ctx, ref)
    if (value === undefined || value === null) {
      const note = describeRef(ref, stepsById)
      slots.push({ ref, note })
      return symbolic(ref, note)
    }
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  })
  return { text, slots }
}

function indexSteps (phases) {
  const map = new Map()
  for (const phase of phases) {
    for (const step of phase.loop ? phase.loop.steps : [phase.step]) map.set(step.id, { ...step, phase: phase.id })
  }
  return map
}

/**
 * @param issue    optional issue descriptor, so issue-scoped placeholders resolve
 * @param project  optional { id, path }
 * @param pathOverlap  optional ({ deliveryAction }) => the reading of runtime/path-overlap.mjs; read-only, and without it a preview reads configuration alone
 */
export async function previewRun ({ playbookId, configRoot, issue = null, project = null, deliveryActions = null, runOptions = {}, platform = undefined, pathOverlap = null } = {}) {
  const resolution = await resolvePlaybook(playbookId, { root: configRoot, runOptions, projectId: project?.id ?? issue?.project, platform })
  if (!resolution.ok) return { ok: false, errors: resolution.errors }

  const r = resolution.resolved
  const stepsById = indexSteps(r.phases)
  const ctx = knownContext(issue, project, r.playbook)

  // --- participants -------------------------------------------------------
  const participants = Object.entries(r.participants).map(([role, p]) => ({
    role,
    writesCode: p.writesCode,
    model: p.model.id,
    wireModel: p.model.wire,
    connection: {
      harness: p.model.harness,
      profile: p.model.profile,
      account: p.model.account ?? null,
      endpointRef: p.model.endpointRef,
      credentialRef: p.model.credentialRef,
      label: p.model.profile && p.model.profile !== 'default' ? `${p.model.harness}[${p.model.profile}]` : p.model.harness
    },
    effort: p.effort,
    // Declared, not probed — a preview never authenticates.
    verification: p.model.verification?.status ?? 'unverified',
    liveAuthentication: symbolic('authentication', 'not probed by a preview')
  }))

  // --- phases -------------------------------------------------------------
  const describeStep = (step) => {
    const promptSource = step.promptFrom
      ? {
          kind: 'authored-at-runtime',
          by: stepsById.get(/^steps\.([a-z0-9-]+)\./.exec(step.promptFrom)?.[1])?.role ?? 'another participant',
          from: step.promptFrom,
          // The prompt for this turn is written by the coordinator during the run,
          // so it cannot be previewed — only its origin can.
          slot: symbolic(step.promptFrom, 'prompt authored at runtime; not previewable'),
          // What the engine appends regardless of what the author wrote.
          engineAppends: ['every context item below, verbatim', step.output ? `the ${step.output} contract definition` : null, 'the current revision, once one exists', 'the run-owned scratch directory'].filter(Boolean)
        }
      : { kind: 'template', template: step.prompt }

    return {
      id: step.id,
      role: step.role,
      participant: r.participants[step.role]?.model?.id ?? null,
      when: step.when ?? null,
      output: step.output ?? null,
      outputSlot: step.output ? symbolic(`${step.id}.output`, `${step.output} produced at runtime`) : null,
      recordsRevision: Boolean(step.recordsRevision),
      concurrent: step.concurrent === true,
      promptSource,
      context: (step.context ?? []).map((ref) => {
        const value = resolvePath(ctx, ref)
        return value === undefined || value === null
          ? { ref, availability: 'runtime', slot: symbolic(ref, describeRef(ref, stepsById)) }
          : { ref, availability: 'now' }
      })
    }
  }

  const phases = r.phases.map((phase, index) => ({
    order: index + 1,
    id: phase.id,
    title: phase.title ?? null,
    kind: phase.loop ? 'loop' : 'step',
    loop: phase.loop
      ? { maxRounds: phase.loop.maxRounds, until: phase.loop.until, onExhausted: phase.loop.onExhausted }
      : null,
    steps: (phase.loop ? phase.loop.steps : [phase.step]).map(describeStep),
    // await-input pauses for an operator answer; it is not an outcome.
    branches: (phase.transitions ?? []).map((t) => ({ when: t.when, to: t.to, outcome: t.to === 'await-input' ? 'pauses for a decision' : t.to === 'ask-owner' ? 'ends and asks the issue owner before any work starts' : (t.outcome ?? 'unresolved'), question: t.question ?? null }))
  }))

  // --- strategy-owned prompts --------------------------------------------
  const prompts = {}
  for (const [name, ref] of Object.entries(r.prompts)) {
    const { text, slots } = renderTemplate(ref.body ?? await readBody(ref.file), ctx, stepsById)
    prompts[name] = { file: ref.file, hash: ref.hash, rendered: text, symbolicSlots: slots }
  }

  // --- prerequisites ------------------------------------------------------
  const prerequisites = []
  for (const b of r.liveExecution.blockers) {
    prerequisites.push({ category: 'blocking', kind: b.kind ?? (b.model ? 'unverified-model' : 'release-configuration'), detail: b.kind ? `${b.role}: ${b.model} — ${b.reason}. ${b.remedy ?? ''}`.trim() : b.model ? `${b.role}: ${b.model} ${b.reason}. Verify the roster entry before starting.` : b.reason, file: b.file })
  }
  if (r.checks.requirement === 'required' && !r.checks.target) {
    prerequisites.push({ category: 'blocking', kind: 'checks-unsatisfiable', detail: 'Checks are required, but no check target is configured. Configure a target before starting.' })
  }
  if (r.autoClose.minimumVerification === 'verified' && (!r.checks.target || r.workspace.isolation === 'in-place')) {
    prerequisites.push({
      kind: 'closure-unreachable',
      category: 'outcome',
      detail: r.workspace.isolation === 'in-place'
        ? 'Automatic closure requires passed checks, but checks are not run for in-place work (they rebuild base plus patch, which in-place work has neither of). Agents can work and incur costs, but agreement alone will leave the issue unresolved. Use an isolated worktree, or a policy allowing review-only closure.'
        : 'Automatic closure requires passed checks, but no check target is configured. Once startup blockers are resolved, agents can work and incur costs, but agreement alone will leave the issue unresolved. Configure checks or explicitly choose a policy allowing review-only closure.'
    })
  }
  if (r.workspace.isolation === 'in-place') {
    prerequisites.push({
      kind: 'in-place-workspace',
      category: 'information',
      status: 'chosen',
      detail: 'Work happens directly in the project checkout: no isolated worktree and no patch. Edits land in the live tree as they are made, a failed or cancelled turn can leave partial edits there, and the panel never removes the checkout. Delivery is recorded as "in-place"; the base and symlink settings do not apply.'
    })
  }
  if (r.completion.delivery.action !== 'none' && r.workspace.isolation !== 'in-place') {
    const action = r.completion.delivery.action
    const available = deliveryActions === null ? null : deliveryActions.includes(action)
    if (action === 'apply-to-source') prerequisites.push({
      kind: 'source-delivery', category: 'information', status: 'chosen',
      detail: `Starting this run authorizes the engine to apply the approved patch to ${project?.path ?? 'the selected project checkout'} and the bound Git-owner checkouts behind materialized symlinks, then verify the combined source before resolving. Source drift blocks application; the patch remains available to apply manually or rerun. Changed files under materialized symlinks are dispatched to their bound Git-owner checkouts, with repository locks and composition verification; source indexes and history are preserved.`
    })
    prerequisites.push({
      kind: 'delivery-provider',
      category: available === false ? 'blocking' : 'information',
      status: available === true ? 'available' : available === false ? 'unavailable' : 'unknown',
      detail: available === true
        ? `Delivery is configured: ${action === 'worktree-diff' ? 'the panel saves a patch in the run artifacts' : action === 'commit' ? 'the candidate is committed on a devpanel/ branch; integration is a separate, approved step' : action}.`
        : available === false
          ? `The panel has no delivery provider for "${action}". Choose a supported delivery action before starting.`
          : `Delivery action "${action}" requires a provider supplied by the run launcher; this standalone preview cannot check it.`
    })
  }
  // Information, whatever it says: it never makes the configuration unready.
  const overlap = pathOverlap ? await pathOverlap({ deliveryAction: r.workspace.isolation === 'in-place' ? 'in-place' : r.completion.delivery.action }) : null
  if (overlap?.state === 'overlap' || overlap?.state === 'unknown') {
    prerequisites.push({ kind: 'path-overlap', category: 'information', status: overlap.state === 'overlap' || overlap.possible.length ? 'warning' : 'unknown', detail: overlap.detail })
  }
  prerequisites.push({
    kind: 'not-probed',
    category: 'information',
    status: 'pending',
    detail: 'Starting runs paid preflight checks for installation, authentication and model access. This preview invokes nothing.'
  })

  return {
    ok: true,
    runOptions: r.runOptions,
    parameterDefinitions: r.parameterDefinitions,
    playbook: r.playbook,
    strategy: r.strategy,
    tactic: r.tactic ?? null,
    intent: r.intent && { id: r.intent.id, title: r.intent.title, description: r.intent.description, source: r.intent.source, steps: Object.keys(r.intent.guidance) },
    participants,
    phases,
    prompts,
    checks: r.checks,
    infrastructure: r.infrastructure,
    autoClose: r.autoClose,
    delivery: { ...r.completion.delivery, destination: r.completion.delivery.action === 'apply-to-source' ? project?.path ?? null : null },
    completion: { requires: r.completion.requires, onFailure: r.completion.onFailure },
    limits: { budgets: r.budgets, rounds: phases.filter((p) => p.loop).map((p) => ({ phase: p.id, maxRounds: p.loop.maxRounds })) },
    workspace: r.workspace,
    reviewPolicy: r.reviewPolicy,
    configHash: r.configHash,
    prerequisites,
    ...(overlap ? { pathOverlap: overlap } : {}),
    configurationReady: !prerequisites.some((p) => p.category === 'blocking'),
    liveEligible: r.liveExecution.eligible
  }
}

async function readBody (file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}
