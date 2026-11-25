import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as store from './store.mjs'
import { acquireIssueLock } from '../issue-locks.mjs'
import { fingerprint, LEGACY_FINGERPRINT_RULE } from './fingerprint.mjs'
import { reconstructInto, discardReconstruction, verifyReconstruction } from './launch.mjs'
import { applyToSource, sourceTarget } from './source-delivery.mjs'

const refuse = message => Object.assign(new Error(message), { status: 409 })

export async function retainedPatch (issuePath, runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw refuse('Invalid run id')
  const run = await store.readRun(issuePath, runId)
  const dir = store.runDir(issuePath, runId)
  const artifacts = await fs.realpath(path.join(dir, 'artifacts'))
  if (!run.delivery?.artifactRef) throw refuse('This run has no retained patch')
  const file = await fs.realpath(path.resolve(dir, run.delivery.artifactRef))
  if (!file.startsWith(artifacts + path.sep) || !file.endsWith('.patch')) throw refuse('Invalid patch location')
  return { run, dir, file }
}

/** The revision every auditor approved on a settled run that never attempted delivery; null for any other run. */
export function undeliveredApprovedRevision (run) {
  if (run.delivery || !['completed', 'blocked', 'failed', 'cancelled'].includes(run.status)) return null
  if (run.recovery?.required || ['quarantined', 'abandoned'].includes(run.integrity?.status)) return null
  const revision = run.revisions?.at(-1)
  const approvals = (run.approvals ?? []).filter((a) => a.revision === revision?.fingerprint)
  const auditors = Object.keys(run.participants ?? {}).filter((role) => role.startsWith('auditor-'))
  return revision && approvals.length && auditors.every((role) => approvals.some((a) => a.role === role)) ? revision : null
}

/*
 * A retained original patch, bound to a revision by a digest the runtime recorded from the bytes it
 * wrote and verified: what the start preview links (retained-work.mjs) and GET …/retained-patch
 * serves. Nothing here runs git or rebuilds anything; the proof is the digest. Never the result
 * step's copy (out of scope), never run.artifactApplication.patchHash (computed from a second read
 * of the file after its reconstruction was verified, so it may describe other bytes).
 *   delivery: run.delivery.artifactRef, verified reconstruction of `revision`; digests
 *             delivery.patchHash, else delivery.application.patchHash (source-delivery.mjs checks
 *             those bytes against the receipt's hash before recording it)
 *   returned: a delivery return's approved artifact (the seed carry-forward.mjs selects); digest from.patchHash
 *   check:    every check record of `revision` in checkResults and checkHistory (a delivery return
 *             clears checkResults), newest first, as lastCandidatePatch walks them; digest artifact.patchHash
 */
export const DOWNLOAD_CAP = Number(process.env.DEVPANEL_MAX_FILE_BYTES ?? 25 * 1024 * 1024)
const sha256Of = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const ARTIFACTS = ['delivery', 'returned', 'check']

async function confined (root, file, runDirectory) {
  const base = await fs.realpath(root).catch(() => path.resolve(root))
  // The root itself must stay inside the selected run: a linked artifacts/ or checks/ never reaches out.
  const run = await fs.realpath(runDirectory).catch(() => path.resolve(runDirectory))
  if (!base.startsWith(run + path.sep)) return { file: null, outside: true }
  let real
  try { real = await fs.realpath(file) } catch (error) {
    if (error.code === 'ENOENT') return { file: null, missing: true }
    // A permission or other error resolving a path inside the run is unreadable, not an escape.
    return { file: null, unreadable: error.code ?? 'error' }
  }
  if (!real.startsWith(base + path.sep) || !real.endsWith('.patch')) return { file: null, outside: true }
  return { file: real }
}

/** The candidate files for one retained artifact, each with the digests recorded for it; or { refused }. */
export async function retainedArtifactCandidates ({ issuePath, run, artifact, revision }) {
  if (!ARTIFACTS.includes(artifact)) return { refused: 'unknown-artifact' }
  if (typeof revision !== 'string' || !revision) return { refused: 'revision-not-recorded' }
  const dir = store.runDir(issuePath, run.runId)
  const one = async (root, ref, digests) => {
    const where = await confined(root, path.resolve(dir, String(ref)), dir)
    return { candidates: [{ ref, file: where.file, missing: where.missing === true, outside: where.outside === true, unreadable: where.unreadable ?? null, digests: digests.filter(Boolean) }] }
  }
  if (artifact === 'delivery') {
    const d = run.delivery
    if (typeof d?.artifactRef !== 'string' || d.reconstruction?.verified !== true || d.reconstruction.fingerprint !== revision) return { refused: 'revision-not-recorded' }
    return one(path.join(dir, 'artifacts'), d.artifactRef, [d.patchHash, d.application?.patchHash])
  }
  if (artifact === 'returned') {
    const from = run.deliveryReturns?.[0]?.from ?? run.pendingDeliveryReturn?.from
    if (typeof from?.artifactRef !== 'string' || from.revision !== revision) return { refused: 'revision-not-recorded' }
    const same = run.delivery?.artifactRef === from.artifactRef && run.delivery?.revision === from.revision
    return one(path.join(dir, 'artifacts'), from.artifactRef, [from.patchHash, ...(same ? [run.delivery.patchHash, run.delivery.application?.patchHash] : [])])
  }
  // A malformed field (an object where a list belongs) holds no record; it does not fail the run's reading.
  const list = (value) => Array.isArray(value) ? value.filter((c) => c && typeof c === 'object') : []
  const migrated = list(run.revisions).find((r) => r.fingerprint === revision)?.migratedFrom ?? null
  const records = [...list(run.checkResults), ...list(run.checkHistory)].reverse()
    .filter((c) => typeof c.dir === 'string' && typeof c.revision === 'string' && [revision, migrated].includes(c.revision))
  if (!records.length) return { refused: 'revision-not-recorded' }
  const byFile = new Map()
  for (const record of records) {
    const named = (record.migratedFrom ?? record.revision).replace('sha256:', '').slice(0, 16)
    const ref = path.join(record.dir, 'artifacts', `${named}.patch`)
    const where = await confined(path.join(dir, 'checks'), path.resolve(dir, ref), dir)
    const key = where.file ?? `${ref}:${where.missing ? 'missing' : where.unreadable ? 'unreadable' : 'outside'}`
    const entry = byFile.get(key) ?? { ref, file: where.file, missing: where.missing === true, outside: where.outside === true, unreadable: where.unreadable ?? null, digests: [] }
    if (record.artifact?.patchHash && !entry.digests.includes(record.artifact.patchHash)) entry.digests.push(record.artifact.patchHash)
    byFile.set(key, entry)
  }
  // Two records naming different digests for one file: neither proves it.
  return { candidates: [...byFile.values()].map((c) => c.digests.length > 1 ? { ...c, digests: [], conflicting: true } : c) }
}

const REASONS = {
  'revision-not-recorded': 'the run records no verified artifact for this revision',
  'unknown-artifact': 'unknown artifact',
  missing: 'the original patch is missing',
  outside: 'the recorded path leaves the run directory',
  'no-recorded-digest': 'no runtime-recorded digest proves these bytes for this revision',
  conflicting: 'the run records conflicting digests for this file',
  'not-regular': 'the original patch is not a regular file',
  'too-large': 'over the download limit',
  changed: 'changed since the runtime recorded its digest',
  unreadable: 'the original patch could not be read'
}
export const retainedReason = (code) => REASONS[code] ?? code

/**
 * The first candidate whose bytes, read once through one non-blocking handle checked to be a
 * regular file within the cap, hash to a recorded digest: { file, ref, size, sha256, bytes } or
 * { skipped: [{ ref, reason }] }. The route sends exactly those bytes; the preview drops them.
 */
export async function firstVerified (candidates, { cap = DOWNLOAD_CAP } = {}) {
  const skipped = []
  for (const c of candidates) {
    if (c.missing) { skipped.push({ ref: c.ref, reason: 'missing' }); continue }
    if (c.unreadable) { skipped.push({ ref: c.ref, reason: 'unreadable', code: c.unreadable }); continue }
    if (c.outside || !c.file) { skipped.push({ ref: c.ref, reason: 'outside' }); continue }
    let handle
    try {
      // The file's own state first (missing, unreadable, not a regular file): it is the reason an operator
      // can act on, whatever the record proves. Only then the digest record, and only then the bytes.
      handle = await fs.open(c.file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      const st = await handle.stat()
      if (!st.isFile()) { skipped.push({ ref: c.ref, reason: 'not-regular' }); continue }
      if (c.conflicting) { skipped.push({ ref: c.ref, reason: 'conflicting' }); continue }
      if (!c.digests.length) { skipped.push({ ref: c.ref, reason: 'no-recorded-digest' }); continue }
      if (st.size > cap) { skipped.push({ ref: c.ref, reason: 'too-large', size: st.size }); continue }
      const bytes = await handle.readFile()
      if (bytes.length !== st.size || (await handle.stat()).size !== st.size) { skipped.push({ ref: c.ref, reason: 'changed' }); continue }
      const sha256 = sha256Of(bytes)
      if (!c.digests.includes(sha256)) { skipped.push({ ref: c.ref, reason: 'changed' }); continue }
      return { file: c.file, ref: c.ref, size: bytes.length, sha256, bytes }
    } catch (error) {
      skipped.push({ ref: c.ref, reason: error.code === 'ENOENT' ? 'missing' : 'unreadable' })
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  return { skipped }
}

/**
 * GET …/runs/:runId/retained-patch?artifact=&revision=: the verified bytes, or a 409 naming why
 * not (stale: the revision no longer names that artifact; unprovable: no recorded digest; changed;
 * missing; unreadable; tooLarge). A returned seed must still be what carry-forward selects.
 */
/**
 * The route's own eligibility for a returned patch: served only while that run and revision are the
 * selected seed. The preview offers a returned original under this same decision, never another.
 */
export const returnedServable = (seed, runId, revision) => seed?.runId === runId && seed.revision === revision

export async function retainedPatchDownload ({ issuePath, runId, artifact, revision, cap = DOWNLOAD_CAP, selectSeed = null }) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw refuse('Invalid run id')
  // Read-only: a download writes nothing, not even a journal recovery finding.
  const run = await store.readRunReadOnly(issuePath, runId)
  if (artifact === 'returned' && selectSeed) {
    const seed = await selectSeed()
    if (!returnedServable(seed, runId, revision)) throw Object.assign(refuse('The preview is stale: this run and revision are no longer the selected seed; preview again'), { code: 'stale' })
  }
  const resolved = await retainedArtifactCandidates({ issuePath, run, artifact, revision })
  if (resolved.refused) throw Object.assign(refuse(`The preview is stale: ${retainedReason(resolved.refused)}; preview again`), { code: 'stale' })
  const found = await firstVerified(resolved.candidates, { cap })
  if (found.bytes) return { ...found, revision, filename: `${runId}-${revision.replace('sha256:', '').slice(0, 16)}.${artifact}.patch` }
  const last = found.skipped.at(-1)?.reason
  const code = { 'no-recorded-digest': 'unprovable', conflicting: 'unprovable', 'too-large': 'tooLarge', 'not-regular': 'unreadable', outside: 'unreadable' }[last] ?? last ?? 'missing'
  throw Object.assign(refuse(`The patch cannot be served: ${found.skipped.map((s) => `${s.ref}: ${retainedReason(s.reason)}`).join('; ')}`), { code })
}

/** Whether base + patch rebuilds exactly the revision, under the rule it was recorded with, touching only its changed paths. */
async function reproducesRevision ({ file, revision, baseCommit, baseline, workspacePath, gitDir }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-artifact-'))
  const rule = revision.rule ?? LEGACY_FINGERPRINT_RULE
  try {
    await reconstructInto({ dir: temporary, workspacePath, baseCommit, patchFile: file, gitDir })
    const candidate = await fingerprint(temporary, { baseCommit, baseline, rule })
    if (candidate.fingerprint !== revision.fingerprint) return false
    const reconstruction = await verifyReconstruction({ workspacePath, baseCommit, baseline, patchFile: file, expected: revision.fingerprint, rule, gitDir,
      expectedPaths: new Set(candidate.entries.filter(e => e.status !== 'unchanged').map(e => e.path)) })
    return reconstruction.verified === true
  } catch {
    return false
  } finally {
    await discardReconstruction({ dir: temporary, workspacePath, gitDir })
  }
}

/**
 * The approved revision's patch for a run that never reached delivery: the one
 * its check wrote under checks/<n>/artifacts/, served only when it rebuilds the
 * fingerprint now, since the worktree may be gone. Null when the run is not such
 * a run. Deliberately apart from retainedPatch: patch-check and apply-artifact
 * speak of a delivered patch, and this one was never delivered.
 */
export async function approvedCheckPatch ({ issuePath, runId, projectPath = null }) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw refuse('Invalid run id')
  const run = await store.readRun(issuePath, runId)
  const revision = undeliveredApprovedRevision(run)
  if (!revision) return null
  const unverified = refuse('The approved revision\'s check artifact could not be verified against its fingerprint')
  const baseline = await store.readBaseline(issuePath, runId)
  const baseCommit = run.workspace?.baseCommit
  // The run's own Git directory while retained, then what outlives it: the
  // source that pins the snapshot (the store, when the host keeps one), the project.
  const present = async (p) => Boolean(p) && await fs.access(p).then(() => true, () => false)
  const gitDir = await present(run.workspace?.gitDir) ? run.workspace.gitDir : await present(run.workspace?.repository?.source) ? run.workspace.repository.source : null
  if (!baseline || !baseCommit || (!gitDir && !projectPath)) throw unverified
  const dir = store.runDir(issuePath, runId)
  const checks = await fs.realpath(path.join(dir, 'checks')).catch(() => null)
  if (!checks) throw unverified
  // Newest first. A migrated revision's check wrote its patch under the name it had then.
  const records = [...(run.checkResults ?? []), ...(run.checkHistory ?? [])].reverse()
    .filter((c) => c.dir && c.revision && [revision.fingerprint, revision.migratedFrom].includes(c.revision))
  const tried = new Set()
  for (const record of records) {
    const named = (record.migratedFrom ?? record.revision).replace('sha256:', '').slice(0, 16)
    const file = await fs.realpath(path.resolve(dir, record.dir, 'artifacts', `${named}.patch`)).catch(() => null)
    if (!file || tried.has(file) || !file.startsWith(checks + path.sep) || !file.endsWith('.patch')) continue
    tried.add(file)
    if (await reproducesRevision({ file, revision, baseCommit, baseline, workspacePath: projectPath, gitDir })) {
      return { file, revision: revision.fingerprint, filename: `${named}.approved-check-artifact.patch`, kind: 'approved-revision-check-artifact' }
    }
  }
  throw unverified
}

/** Explicit operator action for completed patch-only runs, including removed worktrees. */
export async function applyRunArtifact ({ issuePath, runId, projectPath, expectedRevision }) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw refuse('Invalid run id')
  // ISSUE_BUSY or ISSUE_MOVED (409, retryable): never brings back a folder packed or deleted meanwhile.
  const lock = await acquireIssueLock(path.join(issuePath, '.run.lock'), { purpose: 'apply-artifact', runId, doing: 'Applying the patch' })
  let temporary
  try {
    await store.requireCompleteEvents(issuePath, runId)
    const { run, dir, file } = await retainedPatch(issuePath, runId)
    const delivery = run.delivery
    if (run.status !== 'completed' || run.recovery?.required || ['quarantined', 'abandoned'].includes(run.integrity?.status)) throw refuse('The run must be completed with no outstanding recovery or integrity block')
    if (!['worktree-diff', 'commit'].includes(delivery.action) || !delivery.completedAt || delivery.reconstruction?.verified !== true ||
      !expectedRevision || expectedRevision !== delivery.revision || run.closure?.revision !== expectedRevision ||
      !run.closure?.authorised || !Object.values(run.closure.conditions ?? {}).every(value => value === true)) throw refuse('Application requires the exact revision of a completed, approved delivery')
    const baseline = await store.readBaseline(issuePath, runId)
    if (!baseline || !run.workspace?.baseCommit) throw refuse('The recorded base and baseline are required; apply manually or rerun')
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-artifact-'))
    await reconstructInto({ dir: temporary, workspacePath: projectPath, baseCommit: run.workspace.baseCommit, patchFile: file })
    const workspace = { ...run.workspace, path: temporary, source: await sourceTarget(projectPath) }
    const candidate = await fingerprint(temporary, { baseline, baseCommit: workspace.baseCommit })
    if (candidate.fingerprint !== expectedRevision) throw refuse('The retained patch does not reproduce the approved revision')
    const reconstruction = await verifyReconstruction({ workspacePath: temporary, baseCommit: workspace.baseCommit, baseline, patchFile: file, expected: expectedRevision,
      expectedPaths: new Set(candidate.entries.filter(e => e.status !== 'unchanged').map(e => e.path)) })
    const patchHash = 'sha256:' + crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
    const receipt = await applyToSource({ workspace, baseline, revision: expectedRevision, fingerprint: candidate,
      receipt: { ...delivery, reconstruction, patchHash }, runDir: dir })
    // Preserve the historical delivery and snapshot. This is a separately
    // authorized application of that artifact, not a rewritten old run.
    run.artifactApplication = receipt.application
    await store.writeRun(issuePath, runId, run)
    await store.appendEvent(issuePath, runId, { type: 'artifact-applied', revision: expectedRevision, application: receipt.application })
    return { runId, application: receipt.application, error: receipt.application.verified ? null : receipt.application.error }
  } finally {
    if (temporary) await discardReconstruction({ dir: temporary, workspacePath: projectPath })
    await lock.release()
  }
}
