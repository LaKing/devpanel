import fs from 'node:fs/promises'
import path from 'node:path'
import * as store from './runtime/store.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { startAdmission } from './start-admission.mjs'

/*
 * autoStart routing (docs/tactical-playbooks.md "Triage"; execution-contract.md
 * "Triage sizing and autoStart").
 *
 * A triage started with `runOptions.autoStart` that closes with the autonomy
 * verdict `autonomous` starts the playbook its sizing recommends, on the same
 * issue: Prompt for a Minor issue, Plan and implement for a Major one. The
 * decision reads only that: no disposition, no other gate. A duplicate or a
 * rejected report is held back by its seats' own verdict (needs-owner-input),
 * which the engine requires of every disposition but accepted.
 *
 * A start that follows passes, in order: the shared start admission (open
 * dependencies, report trust: start-admission.mjs); for a triage the top-level
 * supervisor started, its start gate (session limits, spending windows,
 * concurrency, ledger reservation, ownership); and in every case the run
 * supervisor's own admission in start(). What happened is written once to
 * runs/<triage run>/auto-start.json and never attempted again; a refusal leaves
 * the recommendation on offer.
 */

export const AUTO_START_FILE = 'auto-start.json'

/** Whether a finished triage starts its recommendation: exactly AC9's conditions. */
export function decideAutoStart (snapshot, run) {
  if (snapshot?.runOptions?.autoStart !== true) return { start: false, reason: 'auto-start-off' }
  if (snapshot.tactic !== 'triage') return { start: false, reason: 'not-a-triage' }
  if (run?.status !== 'completed') return { start: false, reason: 'not-closed' }
  const sizing = run.reportDisposition?.sizing
  if (!sizing?.recommendedPlaybook) return { start: false, reason: 'no-sizing' }
  const verdict = sizing.autonomy?.verdict ?? null
  if (verdict !== 'autonomous') return { start: false, reason: `verdict:${verdict ?? 'none'}`, playbook: sizing.recommendedPlaybook }
  return { start: true, playbook: sizing.recommendedPlaybook }
}

const fileOf = (issuePath, runId) => path.join(store.runDir(issuePath, runId), AUTO_START_FILE)

/** The recorded outcome of a triage run's autoStart, or null when nothing was recorded. */
export async function readAutoStart (issuePath, runId) {
  try { return JSON.parse(await fs.readFile(fileOf(issuePath, runId), 'utf8')) } catch { return null }
}

/**
 * After a run has ended and released its issue. Only a run started with
 * autoStart writes anything. `startOperator` is the run supervisor's start();
 * `supervisorGate` the top-level supervisor's autoStart, when one is attached.
 */
export async function routeAutoStart ({ project, issueId, issuePath, runId }, { getIssue, startOperator, supervisorGate = null, shuttingDown = () => false, read = undefined, reporters = null, emit = null, clock = () => new Date().toISOString() }) {
  const snapshot = await store.readSnapshot(issuePath, runId).catch(() => null)
  if (snapshot?.runOptions?.autoStart !== true) return null
  if (await readAutoStart(issuePath, runId)) return null
  const run = await store.readRun(issuePath, runId)
  const decision = decideAutoStart(snapshot, run)
  const record = { triageRunId: runId, at: clock(), decision: decision.start ? 'start' : 'none', reason: decision.reason ?? null, playbook: decision.playbook ?? null, launchedBy: run.supervisorLaunchId ? 'supervisor' : 'operator' }
  if (decision.start) {
    try {
      if (shuttingDown()) throw Object.assign(new Error('the server is shutting down'), { code: 'shutdown' })
      const issue = await getIssue(project, issueId)
      const refused = await startAdmission({ issue, playbook: decision.playbook }, { ...(read ? { read } : {}), reporters })
      if (refused) {
        record.refusal = { by: 'start-admission', code: refused.code, message: refused.message }
      } else if (run.supervisorLaunchId) {
        if (!supervisorGate) throw Object.assign(new Error('no top-level supervisor is attached to start it'), { code: 'no-supervisor' })
        const started = await supervisorGate({ project, issueId, playbook: decision.playbook, triageRunId: runId })
        record.startedRunId = started.runId
      } else {
        const started = await startOperator({ project, issueId, playbookId: decision.playbook })
        record.startedRunId = started.runId
      }
    } catch (error) {
      record.refusal = { by: run.supervisorLaunchId ? 'supervisor' : 'run-supervisor', code: error.code ?? null, message: error.message }
    }
  }
  await writeJson(fileOf(issuePath, runId), record)
  emit?.({ type: 'auto-start', project, issueId, runId, ...(record.startedRunId ? { startedRunId: record.startedRunId } : {}), decision: record.decision, refused: Boolean(record.refusal) })
  return record
}
