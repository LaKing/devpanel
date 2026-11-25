import fs from 'node:fs/promises'
import path from 'node:path'
import { readRegularFile } from './persistence.mjs'

/*
 * Did the issue's latest run record a provider refusal, and would this start put
 * the same model on that seat again? Information for readiness and preview only:
 * nothing that admits or refuses a start reads it.
 *
 * Strictly read-only: plain directory and JSON reads of runs/<id>/run.json, never
 * store.readRun, whose journal inspection may write a recovery finding.
 */

// A refusal counts once the run has stopped: failed, blocked (a source-integrity
// quarantine or an unproved cleanup), or abandoned from either. No seat-state check:
// a sibling of a quarantined run can stay 'invoking' after it stopped, and a blocked
// run refuses new starts anyway (launch.mjs), so an early notice is harmless.
const STOPPED = ['failed', 'blocked']

/** The latest run's recorded refusal, { runId, role, model, stepId }, or null. */
export async function latestRefusal (issuePath) {
  const runsDir = path.join(issuePath, 'runs')
  let names
  try {
    names = (await fs.readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
      .map((e) => e.name)
  } catch { return null }
  // A run id starts with its time, so string order is start order (issues.js).
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const name of names) {
    let text
    // Non-blocking and regular files only: a FIFO in run.json's place is unreadable (ENOTREG), never waited on.
    try { text = await readRegularFile(path.join(runsDir, name, 'run.json'), 'utf8') } catch (error) {
      if (error.code === 'ENOENT') continue   // a half-written directory is not a run
      return null                             // the newest run cannot be read: say nothing
    }
    let run
    try { run = JSON.parse(text) } catch { return null }
    return refusalOf(run, name)
  }
  return null
}

function refusalOf (run, name) {
  const failure = run?.failure
  if (failure?.class !== 'refusal' || !failure.role) return null
  const stopped = STOPPED.includes(run.status) ||
    (run.status === 'cancelled' && STOPPED.includes(run.abandonment?.previousStatus))
  if (!stopped) return null
  const attempt = (run.failures ?? []).find((f) => f?.invocationId && f.invocationId === failure.invocationId)
  const model = attempt?.model ?? run.participants?.[failure.role]?.model ?? null
  if (!model) return null
  return { runId: run.runId ?? name, role: failure.role, model, stepId: failure.stepId ?? null }
}

/** The information prerequisite when the resolved seat holds the refused model, else null. */
export function refusedSeatPrerequisite (refusal, participants) {
  if (!refusal || participants?.[refusal.role]?.model?.id !== refusal.model) return null
  const { runId, role: seat, model } = refusal
  return {
    kind: 'refused-seat',
    category: 'information',
    status: 'warning',
    runId,
    seat,
    model,
    detail: `Run ${runId} recorded a provider refusal of the content of ${seat}'s turn on ${model}. This start puts ${model} on ${seat} again. This notice is information only; runOptions.participants can seat a different model.`
  }
}
