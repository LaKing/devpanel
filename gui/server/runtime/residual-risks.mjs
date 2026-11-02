import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Which of a run's residual risks are still unaccepted: the one set the
 * disposition refuses on, the run explanation and the issue summary list, and
 * follow-ups are opened for.
 *
 * The closure record (run.json) keeps what the coordinator said. A later
 * acceptance is `acceptedRisks` in issue.json, the file the disposition is in,
 * so the one atomic write that records a disposition records its acceptances
 * too, and a later disposition does not lose them.
 *
 * A closure risk has no id of its own. Its id here is derived from its text, not
 * its position: an id copied from one run's list, or from before a closure was
 * rewritten, then matches nothing rather than some other risk. An acceptance
 * binds to the run and the text, so a reworded risk is unaccepted again.
 */

export const riskId = (text) => `risk-${createHash('sha256').update(String(text)).digest('hex').slice(0, 12)}`

/** The acceptances on an issue's record, read from its folder. */
export async function readAcceptedRisks (issuePath) {
  try {
    const { acceptedRisks } = JSON.parse(await fs.readFile(path.join(issuePath, 'issue.json'), 'utf8'))
    return Array.isArray(acceptedRisks) ? acceptedRisks : []
  } catch { return [] }
}

const acceptanceOf = (risk, runId, accepted) => accepted.find((a) => a.runId === runId && a.text === risk.description) ?? null

/** The closure's risks that a `resolved` disposition resting on this run refuses on. */
export function unacceptedRisks (run, accepted = []) {
  return (run?.closure?.residualRisks ?? []).filter((r) => r.accepted === false && !acceptanceOf(r, run.runId, accepted))
}

/** The closure as a reader should see it: a risk accepted later reads as accepted, and says by whom and why. */
export function closureWithAcceptances (run, accepted = []) {
  const closure = run?.closure
  if (!closure?.residualRisks?.length) return closure
  return {
    ...closure,
    residualRisks: closure.residualRisks.map((r) => {
      const acceptance = r.accepted === false ? acceptanceOf(r, run.runId, accepted) : null
      return acceptance ? { ...r, accepted: true, acceptance: { reason: acceptance.reason, by: acceptance.by, at: acceptance.at } } : r
    })
  }
}

export const RISK_CHOICES = [
  { choice: 'accept', how: 'record resolved in one call, naming each risk with a reason: acceptRisks [{id or text, reason}] on the disposition' },
  { choice: 'partially-resolved', how: 'record partially-resolved; the risks stay open on the disposition as openRisks' }
]

/** What is unaccepted on this run and what can be done about it, or null when nothing is. */
export function riskStatement (run, accepted = []) {
  const open = unacceptedRisks(run, accepted)
  if (!open.length) return null
  return {
    runId: run.runId,
    risks: open.map((r) => ({ id: riskId(r.description), text: r.description, relatesTo: r.relatesTo ?? null })),
    choices: RISK_CHOICES
  }
}

const ENTRY_FIELDS = ['id', 'text', 'relatesTo', 'reason']
const filled = (value) => typeof value === 'string' && value.trim() !== ''

/** Why a value cannot be `acceptRisks`, or null. A listed risk copied whole, plus a reason, is a valid entry. */
export function acceptRisksError (value) {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value)) return 'acceptRisks must be a list of {id or text, reason}'
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some((k) => !ENTRY_FIELDS.includes(k))) return 'each acceptRisks entry must be {id or text, reason}'
    if (!filled(entry.id) && !filled(entry.text)) return 'each acceptRisks entry names its risk by id or text'
    for (const key of ['id', 'text']) if (entry[key] !== undefined && !filled(entry[key])) return `acceptRisks ${key} must be a non-empty string`
    if (!filled(entry.reason)) return 'each accepted risk needs a reason: say why it is acceptable'
  }
  return null
}
