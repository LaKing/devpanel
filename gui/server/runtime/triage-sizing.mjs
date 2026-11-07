import fs from 'node:fs/promises'
import path from 'node:path'
import { writeJson } from './persistence.mjs'

/*
 * Two-seat triage sizing (docs/tactical-playbooks.md "Triage").
 *
 * Every occupied investigator seat of a triage returns a triageDisposition with
 * an order-of-magnitude size, one sentence of reason, the affected modules and an
 * autonomy verdict. The run records one decision folded from all of them:
 * `minor` only when every seat said minor (any disagreement reads as `major`),
 * the modules as the union in order of first appearance (primary seat first),
 * and the most restrictive autonomy verdict. The decision names the playbook
 * the issue goes to next. Pure apart from recordIssueSizing.
 */

export const RECOMMENDED_PLAYBOOK = { minor: 'prompt', major: 'plan-and-implement' }
const RESTRICTION = ['autonomous', 'needs-owner-input', 'too-large']

/** The disposition steps of every occupied seat, in phase order (the primary investigator first). */
export function sizingSteps (snapshot) {
  return (snapshot?.phases ?? [])
    .filter((p) => p.step?.output === 'triageDisposition' && snapshot.participants?.[p.step.role])
    .map((p) => ({ phase: p.id, stepId: p.step.id, role: p.step.role }))
}

/**
 * Why a triage investigator's disposition contradicts its own autonomy verdict,
 * or null. The same verdict rules as the engine's triageProblem, and one more:
 * only an accepted report leaves work a run can do without the owner, so
 * `autonomous` on any other disposition contradicts itself. This is how a
 * duplicate or a rejected report is kept from starting work (autoStart reads
 * only the verdict). A disposition under an older contract has no verdict to check.
 */
export function triageDispositionProblem (output) {
  const a = output?.autonomy
  if (!a) return null
  const questions = a.questions?.length ?? 0
  const parts = a.split?.length ?? 0
  if (a.verdict === 'autonomous' && (questions || parts)) return 'autonomy.verdict "autonomous" carries questions or a split; change the verdict or drop them'
  if (a.verdict === 'needs-owner-input' && (!questions || parts)) return 'autonomy.verdict "needs-owner-input" needs autonomy.questions (what only the owner can decide) and no split'
  if (a.verdict === 'too-large' && (parts < 2 || questions)) return 'autonomy.verdict "too-large" needs autonomy.split with at least two parts and no questions'
  if (a.verdict === 'autonomous' && output.disposition !== 'accepted') return `autonomy.verdict "autonomous" contradicts disposition "${output.disposition}": only an accepted report leaves work a run can do without the owner; use needs-owner-input with the one question the owner must answer`
  const ids = (a.questions ?? []).map((q) => q.id)
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (repeated.length) return `autonomy.questions repeats ${repeated.join(', ')}; give each question its own id`
  return null
}

/**
 * Each seat's disposition as it stands: its LATEST attempt, and only once that
 * attempt passed both the schema and the semantic check above. A seat whose
 * latest attempt is missing, invalid or contradicts itself is pending (output
 * null): the engine asks it to repair, and a repaired attempt replaces the
 * earlier one, so nothing folded can ever rest on a superseded answer.
 */
export function seatDispositions (snapshot, steps, outputs) {
  return sizingSteps(snapshot).map((seat) => {
    const latest = [...steps].reverse().find((s) => s.phase === seat.phase && s.stepId === seat.stepId)
    const out = latest ? outputs[latest.number] : null
    const accepted = out?.valid === true && out.contract === 'triageDisposition' && !triageDispositionProblem(out.output)
    return { ...seat, step: accepted ? latest.number : null, output: accepted ? out.output : null }
  })
}

/** The folded decision, or null while any occupied seat has no valid disposition. */
export function foldSizing (snapshot, steps, outputs) {
  const seats = seatDispositions(snapshot, steps, outputs)
  if (!seats.length || seats.some((s) => !s.output)) return null
  // A seat recorded under the older contract carries no size: nothing to fold.
  if (seats.some((s) => !['minor', 'major'].includes(s.output.size))) return null
  const size = seats.every((s) => s.output.size === 'minor') ? 'minor' : 'major'
  const affectedModules = [...new Set(seats.flatMap((s) => s.output.affectedModules ?? []))]
  const verdicts = seats.map((s) => s.output.autonomy?.verdict ?? 'needs-owner-input')
  const verdict = RESTRICTION[Math.max(...verdicts.map((v) => Math.max(0, RESTRICTION.indexOf(v))))]
  const restricting = seats.find((s) => (s.output.autonomy?.verdict ?? 'needs-owner-input') === verdict)
  return {
    size,
    affectedModules,
    recommendedPlaybook: RECOMMENDED_PLAYBOOK[size],
    autonomy: { verdict, reason: restricting?.output.autonomy?.reason ?? null, by: restricting?.role ?? null },
    seats: seats.map((s) => ({
      role: s.role,
      step: s.step,
      model: snapshot.participants[s.role]?.model?.id ?? null,
      size: s.output.size,
      reason: s.output.sizeReason,
      modules: s.output.affectedModules ?? [],
      disposition: s.output.disposition,
      autonomy: s.output.autonomy ?? null
    }))
  }
}

/**
 * The decision on the issue itself (`issue.json` `sizing`), keyed by the run that
 * produced it, because later work on the issue reads it whatever run it is in.
 * A later triage replaces it; each run keeps its own on its record. Writing the
 * same run's decision again changes nothing, so a replay after a crash is harmless.
 */
export async function recordIssueSizing (issuePath, sizing, { runId, byStep, at = new Date().toISOString() }) {
  const file = path.join(issuePath, 'issue.json')
  let meta = {}
  try { meta = JSON.parse(await fs.readFile(file, 'utf8')) } catch { meta = {} }
  if (meta.sizing?.runId === runId && meta.sizing?.byStep === byStep) return false
  meta.sizing = {
    runId, byStep, at,
    size: sizing.size,
    affectedModules: sizing.affectedModules,
    recommendedPlaybook: sizing.recommendedPlaybook,
    autonomy: sizing.autonomy,
    seats: sizing.seats.map(({ role, model, size, reason, modules }) => ({ role, model, size, reason, modules }))
  }
  await writeJson(file, meta)
  return true
}

/** The parts of an issue's sizing a participant reads: what was decided, by which run, and each seat's sentence. */
export const sizingSummary = (sizing) => sizing ? {
  size: sizing.size, affectedModules: sizing.affectedModules ?? [], recommendedPlaybook: sizing.recommendedPlaybook ?? null,
  runId: sizing.runId ?? null, seats: (sizing.seats ?? []).map(({ role, model, size, reason }) => ({ role, model, size, reason }))
} : null

/** What a later run's window carries, read from the issue: null when the issue was never sized. */
export async function readIssueSizing (issuePath) {
  try {
    const sizing = JSON.parse(await fs.readFile(path.join(issuePath, 'issue.json'), 'utf8')).sizing
    return sizing && typeof sizing === 'object' ? sizing : null
  } catch { return null }
}
