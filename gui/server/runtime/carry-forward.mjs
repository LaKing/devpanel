import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRun, runsDir, runDir } from './store.mjs'
import { gitOutputLimit } from './working-tree.mjs'

const NL = String.fromCharCode(10)

/*
 * Carry an approved but undelivered candidate into the next run of the same
 * issue. A run whose patch every reviewer approved, whose checks passed, but
 * which could not be applied (source drift on its own paths, a lost lock) used
 * to be followed by a run that started from scratch: the new author rewrote
 * the change and reintroduced defects the earlier audit had already closed.
 * The new worktree now starts with that
 * patch applied, after the baseline is recorded, so the patch is part of the
 * new candidate and goes through review, checks and delivery again.
 *
 * Called by provisionRun only. Never fatal: a patch that cannot be applied is
 * still handed to the agents as a file (`state: context-only`).
 */

const OUTPUT_LIMIT = 64 * 1024 * 1024

// `overflow` says so when git was stopped at the limit: its output is then cut
// short, so nothing (the conflicted paths above all) may be read from it.
const run = (args, { cwd, env = {}, input = null, limit = OUTPUT_LIMIT } = {}) => new Promise((resolve) => {
  const child = execFile('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }, maxBuffer: limit }, (error, stdout, stderr) =>
    resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? gitOutputLimit(args, limit).message : null }))
  child.stdin.on('error', () => {})
  child.stdin.end(input ?? '')
})

/** The latest earlier run of this issue that was approved and never delivered, with its patch. */
/** `readRun`: the start preview passes store.readRunReadOnly, so reading a damaged journal writes nothing. */
export async function undeliveredApproval (issuePath, runId, { readRun: read = readRun } = {}) {
  const ids = (await fs.readdir(runsDir(issuePath)).catch(() => [])).filter((id) => id !== runId && !id.startsWith('worktree-'))
  const runs = []
  for (const id of ids) {
    const prior = await read(issuePath, id).catch(() => null)
    if (!eligibleSeed(prior)) continue
    const written = (await fs.stat(path.join(runDir(issuePath, id), 'run.json')).catch(() => null))?.mtimeMs ?? 0
    runs.push({ id, prior, written })
  }
  return selectUndeliveredApproval(issuePath, runs)
}

// A run that produced no candidate (refused start, failed preflight) says
// nothing about the work; the latest one that did decides.
const eligibleSeed = (prior) => Boolean(prior) && !['running', 'pending', 'paused'].includes(prior.status) && Boolean(prior.revisions?.length)

/**
 * Whether a start carries an earlier approved patch forward at all: provisioning
 * (launch.mjs) and the start preview (retained-work.mjs) both ask this, with the
 * launch's own inputs, so the preview never states a seed the launch would skip.
 */
export function seedApplies ({ participants, isolation, stagedRelease }) {
  if (!Object.values(participants ?? {}).some((p) => p.writesCode)) return { applies: false, reason: 'writes-no-code' }
  if (stagedRelease) return { applies: false, reason: 'production-release' }
  if (isolation === 'in-place') return { applies: false, reason: 'in-place' }
  return { applies: true, reason: null }
}

/**
 * The selected seed patch, read the way provisioning reads it but without ever
 * blocking: opened O_NONBLOCK (a FIFO with no writer answers at once instead of
 * hanging the start), checked to be a regular file on the open handle, then read
 * from that same handle. Links are followed, as readFile did. `probe` stops after
 * the check (the preview). { state: available|missing|unreadable|empty, code?, size, bytes? }
 */
export async function readSeedPatch (file, { probe = false } = {}) {
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const st = await handle.stat()
    if (!st.isFile()) return { state: 'unreadable', code: 'not-regular', size: null }
    if (st.size === 0) return { state: 'empty', size: 0 }
    if (probe) return { state: 'available', size: st.size }
    const bytes = await handle.readFile()
    return bytes.length ? { state: 'available', size: bytes.length, bytes } : { state: 'empty', size: 0 }
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable', code: error.code ?? 'error', size: null }
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Of an issue's runs ({ id, prior: run record, written: run.json mtime }), the one
 * the next run would be seeded from, as undeliveredApproval says. Pure: the
 * retirement of refs (ref-retention.mjs) feeds it its own strict inventory.
 */
export function selectUndeliveredApproval (issuePath, runs) {
  // Start time first; the record's write time breaks ties (a manual clock, one second).
  const latest = runs.filter((r) => eligibleSeed(r.prior)).map((r) => ({ ...r, order: [r.prior.startedAt ?? '', r.written ?? 0] }))
    .sort((a, b) => a.order[0].localeCompare(b.order[0]) || a.order[1] - b.order[1]).at(-1)
  if (!latest) return null
  const { id, prior } = latest
  // Its patch a person landed (run.landed) or applied afterwards (a verified
  // artifactApplication): delivered, as run-result.mjs reads it. It still is the
  // latest work, so nothing older is seeded in its place, and nothing is applied twice.
  if (prior.landed || prior.artifactApplication?.verified === true) return null
  const c = prior.closure?.conditions
  const approved = c?.sameRevisionApproval && c.checksSatisfied && c.noOutstandingBlockingFindings && c.deliveryCompleted === false
  // A delivery return took the approved revision back to the author and the run
  // then ended some other way (delivery-return.mjs): its closure no longer says
  // approved, but the patch every reviewer approved is still that return's.
  const returned = approved || prior.outcome === 'resolved' ? null : prior.deliveryReturns?.[0]?.from ?? prior.pendingDeliveryReturn?.from
  if (returned?.artifactRef) return { runId: id, revision: returned.revision, patch: path.join(runDir(issuePath, id), returned.artifactRef), reason: 'its reconciliation after a delivery conflict did not finish' }
  const d = prior.delivery
  if (!approved || !d?.artifactRef || d.reconstruction?.verified !== true || d.reconstruction.fingerprint !== prior.closure.revision) return null
  return { runId: id, revision: prior.closure.revision, patch: path.join(runDir(issuePath, id), d.artifactRef), reason: d.application?.state ?? d.error ?? null }
}

const conflictedPaths = (stderr) => [...stderr.matchAll(/Applied patch to '([^']+)' with conflicts/g)].map((m) => m[1])

/**
 * Apply `source.patch` to the fresh worktree: cleanly if it still fits, else a
 * three-way merge through the source repository's objects (the earlier run's
 * base snapshot is there), with a throwaway index so neither repository's
 * index changes. Conflicts are left as markers for the author to resolve.
 */
export async function carryForward ({ issuePath, runId, workspace, sourceRepository, outputLimit: limit = OUTPUT_LIMIT }) {
  const source = await undeliveredApproval(issuePath, runId)
  if (!source) return null
  const patch = (await readSeedPatch(source.patch)).bytes ?? null
  const copy = path.join(workspace.scratchPath ?? runDir(issuePath, runId), 'carried-forward.patch')
  const seed = { fromRun: source.runId, revision: source.revision, reason: source.reason, patch: copy, state: 'context-only', conflicts: [], error: null }
  if (!patch?.length) return { ...seed, error: 'the approved patch could not be read' }
  await fs.writeFile(copy, patch)
  const clean = await run(['apply', '--binary', '--whitespace=nowarn', '-'], { cwd: workspace.path, input: patch, limit })
  if (clean.overflow) return { ...seed, error: clean.overflow }
  if (clean.ok) return { ...seed, state: 'applied' }
  if (!sourceRepository || !workspace.baseCommit) return { ...seed, error: clean.stderr.trim() }
  const index = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-carry-')), 'index')
  try {
    const env = { GIT_DIR: sourceRepository, GIT_WORK_TREE: workspace.path, GIT_INDEX_FILE: index }
    const read = await run(['read-tree', workspace.baseCommit], { cwd: workspace.path, env, limit })
    if (!read.ok) return { ...seed, error: read.overflow ?? read.stderr.trim() }
    // read-tree leaves no stat data, and apply --3way refuses any path whose
    // index entry it cannot match to the file; a refresh records them.
    const refreshed = await run(['update-index', '-q', '--refresh'], { cwd: workspace.path, env, limit })
    if (refreshed.overflow) return { ...seed, error: refreshed.overflow }
    const merged = await run(['apply', '--3way', '--binary', '--whitespace=nowarn', '-'], { cwd: workspace.path, env, input: patch, limit })
    if (merged.overflow) return { ...seed, error: merged.overflow }
    const conflicts = conflictedPaths(merged.stderr)
    if (merged.ok) return { ...seed, state: 'merged' }
    if (conflicts.length) return { ...seed, state: 'conflicts', conflicts }
    return { ...seed, error: merged.stderr.trim() || clean.stderr.trim() }
  } finally {
    await fs.rm(path.dirname(index), { recursive: true, force: true })
  }
}

/** What every agent turn is told about a carried-forward candidate. */
export function carryForwardBrief (seed) {
  if (!seed) return null
  const head = `This run continues run ${seed.fromRun}: its candidate (${seed.revision}) was approved by every reviewer and passed its checks, but was not delivered (${seed.reason ?? 'delivery did not complete'}). Its patch is at ${seed.patch}.`
  const body = {
    applied: 'The worktree already contains that patch, applied cleanly to the current source. Keep its corrections; change only what the current source or a new finding requires, and do not rewrite it from scratch.',
    merged: 'The worktree already contains that patch, merged three-way onto the current source because the source changed under it. Keep its corrections; check the merged paths against the current source, and do not rewrite it from scratch.',
    conflicts: `The patch was merged three-way onto the current source and conflicted in: ${seed.conflicts.join(', ')}. Those files contain conflict markers that the author must resolve first, keeping the approved corrections; the rest of the patch is applied.`,
    'context-only': `The patch could not be applied to the current source${seed.error ? ` (${seed.error.slice(0, 300)})` : ''}. Start from it: port its corrections rather than designing the change again.`
  }[seed.state]
  return `${head}${NL}${body} Defects that run's reviewers found and saw fixed must stay fixed; a reviewer re-checks them.`
}
