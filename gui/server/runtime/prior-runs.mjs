import fs from 'node:fs/promises'
import path from 'node:path'
import * as store from './store.mjs'

/*
 * What earlier runs of the same issue did, for a run started with
 * `runOptions.accumulate` (current-window.mjs freezes the files into the window).
 *
 * Decision: by default a run sees only human input (report, notes); earlier agent
 * turns are excluded by provenance. Accumulating is the operator's explicit choice
 * to build on substantial earlier work — e.g. implement an analysis's findings —
 * so it carries each earlier run whole: every turn in order (intermediate
 * investigations, plans, reviews and operator answers matter, not only the last
 * word), the run's `result.md` account and its patch.
 */

const ENDED = ['completed', 'blocked', 'failed', 'cancelled']

/** Earlier ended runs of the issue, oldest first. */
export async function priorRuns (issuePath, runId) {
  const entries = await fs.readdir(path.join(issuePath, 'runs'), { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e })
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === runId || entry.name.startsWith('worktree-') || entry.name.startsWith('workspace-')) continue
    const run = await store.readRun(issuePath, entry.name).catch(() => null)
    if (run && ENDED.includes(run.status) && (run.startedAt ?? '') !== '') runs.push(run)
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

// The step folder holds the full response; the run record may hold a shortened copy.
export async function stepText (issuePath, step) {
  const file = path.join(issuePath, `${step.number}-${step.slug}`, 'response.md')
  return fs.readFile(file, 'utf8').catch(() => step.response ?? '')
}

/** Every turn of one run as Markdown, in order, or null when it has none. */
export async function renderSteps (issuePath, run) {
  const outputs = await store.readOutputs(issuePath, run.runId).catch(() => ({}))
  const steps = run.steps ?? []
  if (!steps.length) return null
  const lines = [`# Run ${run.runId}`, '', `${run.playbook?.title ?? run.playbook?.id ?? 'playbook'} · ${run.status}${run.blockedReason ? ` (${run.blockedReason})` : ''} · started ${run.startedAt}`, '']
  for (const step of steps) {
    const out = outputs[step.number]
    // An invalid output is kept: a turn that failed its contract can still hold the work.
    const contract = out ? `${out.contract}${out.valid ? '' : ', invalid'}` : null
    const where = [step.phase && step.phase !== step.stepId ? step.phase : null, step.round != null ? `round ${step.round}` : null, step.revision ? `revision ${String(step.revision).slice(0, 8)}` : null].filter(Boolean).join(', ')
    lines.push(`## ${step.number} ${step.role ?? 'step'}: ${step.stepId ?? step.slug}${where ? ` (${where})` : ''}${contract ? ` — ${contract}` : ''}`, '', (await stepText(issuePath, step)).trim() || '(no response recorded)', '')
  }
  return lines.join('\n')
}

/** The result step's folder for a run (`run-result:<runId>`), or null. */
function resultFolder (reservations, runId) {
  return reservations.find((r) => r.invocationId === `run-result:${runId}`)?.folder ?? null
}

/**
 * Sources for each prior run: its turns as text and the result step's
 * files. Returned as `{ runId, name, bytes | source }` for the caller to freeze
 * under its own budget.
 */
export async function priorRunSources (issuePath, runId, reservations) {
  const sources = []
  for (const run of await priorRuns(issuePath, runId)) {
    const text = await renderSteps(issuePath, run)
    if (text) sources.push({ runId: run.runId, name: 'steps.md', bytes: Buffer.from(text) })
    const folder = resultFolder(reservations, run.runId)
    for (const name of ['result.md', 'changes.patch']) if (folder) sources.push({ runId: run.runId, name, source: path.join(issuePath, folder, name) })
  }
  return sources
}
