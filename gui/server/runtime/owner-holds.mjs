/**
 * Owner holds: a decision a seat left to the owner in `ownerHolds`.
 *
 * Derived from every recorded step, never from `activeSteps()`: a coordinator's
 * refresh-evidence or restartPlan moves the window past the step that stated a
 * hold, and that must not lift it. Only worker contracts carry the field, so
 * nothing a coordinator writes reaches this reading. An operator step answering
 * the hold's question closes it, so replay needs no cursor.
 */
const HOLD_CONTRACTS = new Set(['authorArtifact', 'reviewResult'])

export const ownerHoldKey = (hold) => `owner-hold:${hold.identity}`

/** Every hold stated so far, in first-stated order; the latest statement of each wins. */
export function ownerHoldsOf (steps, outputs) {
  const holds = new Map()
  for (const s of steps) {
    const out = outputs[s.number]
    if (!out?.valid || !HOLD_CONTRACTS.has(out.contract)) continue
    for (const { id, question, category, reason, recommendation } of out.output.ownerHolds ?? []) {
      const identity = `${s.role}:${id}`
      holds.set(identity, { identity, role: s.role, id, question, category, reason, recommendation, stepId: s.stepId, statedByStep: holds.get(identity)?.statedByStep ?? s.number, latestStep: s.number, answeredByStep: null })
    }
  }
  const answers = steps.filter((s) => s.role === 'operator' && s.decision)
  for (const hold of holds.values()) {
    // By the question too: a different one under the same id has not been answered.
    const answer = answers.find((s) => s.decision.key === ownerHoldKey(hold) && s.decision.question === hold.question)
    hold.answeredByStep = answer?.number ?? null
  }
  return [...holds.values()]
}

export const openOwnerHolds = (steps, outputs) => ownerHoldsOf(steps, outputs).filter((hold) => !hold.answeredByStep)

const stepsOf = (phase) => (phase.loop ? phase.loop.steps : [phase.step])
const recordsRevision = (phase) => stepsOf(phase).some((step) => step?.recordsRevision === true)

const readsDecisions = (phase) => stepsOf(phase).every((step) => (step?.context ?? []).includes('decisions'))

/**
 * Plan review: the review loops before any revision whose every seat reads
 * `decisions`, in a run that implements something (plan-and-implement's
 * `plan-review`). A loop whose seats would not see the answer is not one.
 */
export function planReviewPhases (snapshot) {
  const phases = snapshot?.phases ?? []
  if (!phases.some(recordsRevision)) return new Set()
  return new Set(phases.filter((p) => p.loop && !recordsRevision(p) && readsDecisions(p)).map((p) => p.id))
}

/**
 * The first open hold whose latest statement was made in plan review, with that
 * phase: the engine puts it to the consult panel before anything else happens
 * in the run (engine.settlePlanReviewHolds). Null when there is none.
 */
export function openPlanReviewHold (snapshot, steps, outputs) {
  const phases = planReviewPhases(snapshot)
  if (!phases.size) return null
  const phaseOf = new Map(steps.map((s) => [s.number, s.phase]))
  const hold = openOwnerHolds(steps, outputs).find((h) => phases.has(phaseOf.get(h.latestStep)))
  return hold ? { ...hold, phase: phaseOf.get(hold.latestStep) } : null
}

/**
 * Does an open hold stop this turn? Only in a run that implements something, and
 * only at what would start or continue that work or carry it to delivery. A hold
 * stated in plan review never gets this far: the engine settles it before the
 * loop's next turn, ending or budget block (openPlanReviewHold).
 */
export function holdGatesTurn (snapshot, next) {
  if (!(snapshot.phases ?? []).some(recordsRevision)) return false
  const { step, phase } = next
  return step.recordsRevision === true || step.output === 'closureConfirmation' || (step.role === 'coordinator' && recordsRevision(phase))
}
