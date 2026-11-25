import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import * as store from './store.mjs'
import { readRegularFile } from './persistence.mjs'

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
 *
 * Decision: a run that ended without an approved or delivered patch (rounds
 * exhausted, budget, a failure) still leaves code: its last recorded revision.
 * That is carried as `candidate.patch`, under another name than `changes.patch`
 * so no reader takes it for approved. Without it the next run gets five rounds
 * of review as prose and writes the code again.
 * Pitfall: `candidate.patch` is the bytes of that revision's check artifact,
 * not verified here against the fingerprint: it is a starting point the next
 * run's own revision, checks and reviews judge, never evidence of anything.
 */

const ENDED = ['completed', 'blocked', 'failed', 'cancelled']

/** Earlier ended runs of the issue, oldest first. */
export async function priorRuns (issuePath, runId, { readRun = store.readRun } = {}) {
  const entries = await fs.readdir(path.join(issuePath, 'runs'), { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e })
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === runId || entry.name.startsWith('worktree-') || entry.name.startsWith('workspace-')) continue
    const run = await readRun(issuePath, entry.name).catch(() => null)
    if (run && ENDED.includes(run.status) && (run.startedAt ?? '') !== '') runs.push(run)
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

// The step folder holds the full response; the run record may hold a shortened copy.
export async function stepText (issuePath, step) {
  const file = path.join(issuePath, `${step.number}-${step.slug}`, 'response.md')
  return readRegularFile(file, 'utf8').catch(() => step.response ?? '')
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

/** The per-file limit of a window capture, from the resolved windowLimits: Accumulate and the start preview read it here. */
export const inputFileLimit = (limits) => limits?.maxInputFileBytes ?? 26214400

/**
 * Open one earlier-run file the way Accumulate does (current-window.mjs): O_NONBLOCK and
 * O_NOFOLLOW, the type checked on the handle before anything is read, a link or a non-regular
 * file skipped, a file over `maxFileBytes` skipped. `read: false` stops after the check (the
 * start preview). { state: accepted|missing|skipped-symlink|skipped-not-regular|skipped-too-large|error, size, bytes?, error? }
 */
export async function openAccumulateInput (file, { maxFileBytes, read = true }) {
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const st = await handle.stat()
    if (!st.isFile()) return { state: 'skipped-not-regular', size: null }
    if (st.size > maxFileBytes) return { state: 'skipped-too-large', size: st.size }
    return read ? { state: 'accepted', size: st.size, bytes: await handle.readFile() } : { state: 'accepted', size: st.size }
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing', size: null }
    if (error.code === 'ELOOP') return { state: 'skipped-symlink', size: null }
    if (error.code === 'EISDIR') return { state: 'skipped-not-regular', size: null }
    return { state: 'error', size: null, error }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * The check artifact of a run's last recorded revision (`checks/<n>/artifacts/<fingerprint16>.patch`,
 * written by the check runner for every revision it drove), newest check first, or null: no revision,
 * no check of it, or the file is gone.
 */
export async function lastCandidatePatch (issuePath, run) {
  const fingerprint = run.revisions?.at(-1)?.fingerprint
  if (!fingerprint) return null
  const dir = store.runDir(issuePath, run.runId)
  const named = `${fingerprint.replace('sha256:', '').slice(0, 16)}.patch`
  for (const record of [...(run.checkResults ?? []), ...(run.checkHistory ?? [])].reverse()) {
    if (!record.dir || record.revision !== fingerprint) continue
    const file = path.resolve(dir, record.dir, 'artifacts', named)
    if (!file.startsWith(path.join(dir, 'checks') + path.sep)) continue
    if (await fs.stat(file).then((st) => st.isFile(), () => false)) return file
  }
  return null
}

/**
 * Sources for each prior run: its turns as text, the result step's files and,
 * for a run whose result step holds no patch, its last candidate. Returned as
 * `{ runId, name, bytes | source }` for the caller to freeze under its own budget.
 */
export async function priorRunSources (issuePath, runId, reservations, { readRun } = {}) {
  const sources = []
  for (const run of await priorRuns(issuePath, runId, { readRun })) {
    const text = await renderSteps(issuePath, run)
    if (text) sources.push({ runId: run.runId, name: 'steps.md', bytes: Buffer.from(text) })
    const folder = resultFolder(reservations, run.runId)
    for (const name of ['result.md', 'changes.patch']) if (folder) sources.push({ runId: run.runId, name, source: path.join(issuePath, folder, name) })
    const hasPatch = folder ? await fs.stat(path.join(issuePath, folder, 'changes.patch')).then((st) => st.isFile(), () => false) : false
    const candidate = hasPatch ? null : await lastCandidatePatch(issuePath, run)
    if (candidate) sources.push({ runId: run.runId, name: 'candidate.patch', source: candidate })
  }
  return sources
}
