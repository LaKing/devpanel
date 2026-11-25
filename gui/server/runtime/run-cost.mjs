/*
 * One reading of what a run cost, from its `budgets.used`, for the export, its
 * totals and the overview: reported USD, estimated USD (roster pricing, engine
 * commitTurn) and unknown steps, each apart, and whether the run is priced.
 *
 *   priced    some money is known and no step is unknown
 *   partial   some money is known and at least one step is unknown
 *   unpriced  no money is known
 *
 * "Some money" is a positive reported or estimated sum, or an estimated step. A
 * reported 0 with no estimated step (model-fallback.mjs adds a probe's spend, 0
 * when it reported none) proves no step was priced, so it does not count. A
 * non-finite value reads as absent. Records from before estimates have no
 * estimate fields and read as before, except that reported money beside unknown
 * steps is now partial.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

export function runCost (used = {}) {
  const reportedUsd = finite(used?.costUsd) ? used.costUsd : null
  const estimatedUsd = finite(used?.estimatedCostUsd) ? used.estimatedCostUsd : 0
  const unknownSteps = finite(used?.costUnknownSteps) ? used.costUnknownSteps : 0
  const estimatedSteps = finite(used?.costEstimatedSteps) ? used.costEstimatedSteps : 0
  const known = (reportedUsd ?? 0) > 0 || estimatedUsd > 0 || estimatedSteps > 0
  const pricing = !known ? 'unpriced' : unknownSteps > 0 ? 'partial' : 'priced'
  return { reportedUsd, estimatedUsd, unknownSteps, estimatedSteps, pricing }
}
