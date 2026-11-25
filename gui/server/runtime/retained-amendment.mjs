// Explicit operator corrections to stopped candidates. The caller holds the run lock.
// Preserve the launch snapshot and sessions; fingerprint edits and invalidate approvals.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { enterRecovery, resumeUnavailable } from './run-control.mjs'
import { captureIntegrity, readIntegrity, writeIntegrity, integrityChanges } from './integrity.mjs'

export async function amendRetained (engine, { edits = [], target = null, actor, reason }) {
  await engine.assertJournal()
  const refusal = resumeUnavailable(engine.run)
  if (refusal) throw new Error(refusal)
  if (!actor?.trim() || !reason?.trim()) throw new Error('An operator actor and reason are required')
  if (!engine.runLock) throw new Error('An exclusive run lock is required')
  const before = await readIntegrity(engine.integrityDir(), engine.run.integrity.checkpoint)
  const current = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
  if (current.hash !== before.hash) throw new Error('Retained workspace changed before amendment')
  const root = await fs.realpath(engine.run.workspace.path)
  const paths = new Set()
  // Canonical workspace-relative spellings, the form integrity reports changes
  // in: './x' and 'x' are the same edit.
  const relative = new Set()
  for (const edit of edits) {
    if (edit.path.split(/[\\/]/).includes('.git')) throw new Error('Git metadata cannot be amended')
    if (typeof edit.before !== 'string' || typeof edit.after !== 'string') throw new Error('Edits require exact before and after text')
    const file = path.resolve(root, edit.path)
    if (!file.startsWith(root + path.sep) || await fs.realpath(file) !== file || !(await fs.lstat(file)).isFile()) throw new Error('Edit must name a regular file inside the retained workspace')
    if (paths.has(file)) throw new Error('Duplicate amendment path')
    paths.add(file)
    relative.add(path.relative(root, file).split(path.sep).join('/'))
    if (await fs.readFile(file, 'utf8') !== edit.before) throw new Error(`Amendment preimage differs: ${edit.path}`)
  }
  // Only check commands may change. The approved destination remains fixed.
  const priorTarget = engine.run.checkRefresh?.target ?? engine.snapshot.checks?.target
  if (target && (target.kind !== priorTarget?.kind || target.materialize !== priorTarget?.materialize || JSON.stringify(target.ssh) !== JSON.stringify(priorTarget?.ssh))) throw new Error('Check amendment cannot change its destination')
  const id = `operator-${crypto.randomUUID()}`
  const record = { id, actor, reason, at: engine.clock.iso(), paths: edits.map(e => e.path), previousRevision: engine.run.revisions.at(-1)?.fingerprint, status: 'pending' }
  engine.run.operatorAmendments ??= []
  engine.run.operatorAmendments.push(record)
  // A crash or failure during the write cannot silently resume as a clean run.
  engine.run.integrity.status = 'operator-amendment-pending'
  await engine.persist({ type: 'operator-amendment-started', ...record })
  for (const edit of edits) await fs.writeFile(path.resolve(root, edit.path), edit.after)
  const after = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
  const changes = integrityChanges(before, after)
  await writeIntegrity(engine.integrityDir(), id, after)
  if (changes.head || changes.index || changes.paths.some(p => !relative.has(typeof p === 'string' ? p : p.path))) {
    // Not left "amendment pending" forever: quarantined like any turn that made
    // changes it was not allowed to, so the integrity disposition applies.
    const reason = 'unexpected changes during operator amendment'
    record.status = 'failed'
    engine.run.integrity = { ...engine.run.integrity, status: 'quarantined', latest: { role: 'operator', invocationId: id, outcome: 'failed', writesCode: false, reason, changes, before: engine.run.integrity.checkpoint, after: id, stateHash: after.hash, at: engine.clock.iso() } }
    enterRecovery(engine.run, { reason: `Source integrity: ${reason}. Inspect the changes and record a disposition.` }, engine.run.integrity.latest.at)
    await engine.persist({ type: 'operator-amendment-failed', ...record, reason })
    throw new Error('Unexpected changes during operator amendment')
  }
  engine.run.priorCheckResults ??= []
  engine.run.priorCheckResults.push(...engine.run.checkResults)
  if (edits.length) record.revision = (await engine.recordRevision(id)).fingerprint
  if (target) {
    engine.run.checkRefreshHistory ??= []
    if (engine.run.checkRefresh) engine.run.checkRefreshHistory.push(engine.run.checkRefresh)
    engine.run.checkRefresh = { target, revision: engine.run.revisions.at(-1)?.fingerprint, requestedAt: engine.clock.iso(), pending: false, amendment: id }
    // Retain old receipts as history, but never let an old pass skip the new gate.
    engine.run.checkResults = []
  }
  engine.run.approvals = []
  engine.run.integrity = { ...engine.run.integrity, status: 'clear', checkpoint: id }
  record.status = 'completed'
  record.completedAt = engine.clock.iso()
  await engine.persist({ type: 'operator-amendment-completed', ...record })
  return record
}
