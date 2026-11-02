import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as store from './store.mjs'
import { acquire } from './lock.mjs'
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
function undeliveredApprovedRevision (run) {
  if (run.delivery || !['completed', 'blocked', 'failed', 'cancelled'].includes(run.status)) return null
  if (run.recovery?.required || ['quarantined', 'abandoned'].includes(run.integrity?.status)) return null
  const revision = run.revisions?.at(-1)
  const approvals = (run.approvals ?? []).filter((a) => a.revision === revision?.fingerprint)
  const auditors = Object.keys(run.participants ?? {}).filter((role) => role.startsWith('auditor-'))
  return revision && approvals.length && auditors.every((role) => approvals.some((a) => a.role === role)) ? revision : null
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
  const lock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'apply-artifact', runId }).catch(error => { throw Object.assign(error, { status: 409 }) })
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
