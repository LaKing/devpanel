import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { acquire, currentOwner } from '../server/runtime/lock.mjs'
import { acquireIssueLock, admissionLockFile } from '../server/issue-locks.mjs'
import { bundleFiles, archivedIdHolders } from '../server/issue-bundle.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'pack, restore and delete hold the issue\'s locks; writers and lifecycle refuse each other retryably'

/*
 * Every interleaving is forced by a seam or by a lock the test holds, never by
 * timing: the operation under test pauses inside its locks, the writer is tried
 * there, then the operation goes on.
 */
const P = 'devpanel-project'
const exists = (p) => fs.access(p).then(() => true, () => false)
const refusal = (promise) => promise.then(() => null, (error) => error)
const gate = () => { let open; const p = new Promise((resolve) => { open = resolve }); return { p, open } }
const busy = (e) => [e?.status, e?.code, e?.retryable]
// A pid that is certainly not running: a child that has already exited.
const deadPid = () => spawnSync('true').pid

export default async function (t) {
  const f = await engineFixture()
  const issues = f.issues
  const ISSUES = issues.ISSUES_DIR
  const supervisor = createSupervisor({ issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, admissionWaitMs: 50, seams: { stepLockWaitMs: 0 } })
  const fresh = async (title) => issues.createIssue(P, { name: title })
  const markArchived = (issue) => fs.writeFile(path.join(issue.path, '.archive.json'), JSON.stringify({ archivedAt: new Date().toISOString() }))
  const lockRecord = async (file, owner) => fs.writeFile(file, JSON.stringify({ purpose: 'run', token: `test-${Math.random()}`, owner }))

  try {
    t.section('pack × run start')
    {
      const a = await fresh('Pack and start')
      const held = gate(); const inside = gate()
      const packing = issues.setIssueArchived(P, a.id, true, { overrideReason: 'test', seams: { whileLocked: async () => { inside.open(); await held.p } } })
      await inside.p
      const started = await refusal(supervisor.start({ project: P, issueId: a.id, playbookId: 'analysis' }))
      t.eq('a start while pack holds the issue is refused, retryably', busy(started), [409, 'ISSUE_BUSY', true])
      t.eq('and no run folder appears', await fs.readdir(path.join(a.path, 'runs')).catch(() => []), [])
      const runLock = await refusal(acquireIssueLock(path.join(a.path, '.run.lock'), { purpose: 'run' }).then((l) => l.release()))
      t.eq('the run lock a start takes (launch.mjs reserveRun) is held by pack', busy(runLock), [409, 'ISSUE_BUSY', true])
      held.open()
      t.eq('the pack completes', (await packing).packed, true)
      const stale = await refusal(acquireIssueLock(path.join(a.path, '.run.lock'), { purpose: 'run' }).then((l) => l.release()))
      t.eq('a start on the old path afterwards finds it gone, and does not bring the folder back', [stale?.code, stale?.retryable, await exists(a.path)], ['ISSUE_MOVED', true, false])

      const b = await fresh('Run holds the issue')
      const live = await acquire(path.join(b.path, '.run.lock'), { purpose: 'run', mkdir: false })
      const packed = await refusal(issues.setIssueArchived(P, b.id, true, { overrideReason: 'test' }))
      t.eq('pack refused by a live run lock, retryably', busy(packed), [409, 'ISSUE_BUSY', true])
      t.eq('and nothing changed: no marker, no bundle', [await exists(path.join(b.path, '.archive.json')), await exists(bundleFiles(ISSUES, P, b.id).bundle)], [false, false])
      await live.release()
    }

    t.section('pack × note write')
    {
      const c = await fresh('Pack and note')
      const held = gate(); const inside = gate()
      const packing = issues.setIssueArchived(P, c.id, true, { overrideReason: 'test', seams: { whileLocked: async () => { inside.open(); await held.p } } })
      await inside.p
      const note = await refusal(issues.createStep(P, c.id, { name: 'during', text: 'x', lockWaitMs: 0 }))
      t.eq('a note write while pack holds the step lock is refused, retryably', busy(note), [409, 'ISSUE_BUSY', true])
      let engineDone = false
      const engineNote = issues.createEngineNote(P, c.id, { name: 'engine-note', text: 'kept', invocationId: 'test:pack-note' })
      engineNote.then(() => { engineDone = true }, () => { engineDone = true })
      await new Promise((resolve) => setImmediate(resolve))
      t.eq('an engine note does not land while pack holds the issue', engineDone, false)
      held.open()
      await packing
      t.eq('the engine note waited, and is kept beside the bundle', (await engineNote).where, 'archive')
      t.ok('with its text', (await fs.readFile(bundleFiles(ISSUES, P, c.id).notes, 'utf8')).includes('test:pack-note'))
      const after = await refusal(issues.createStep(P, c.id, { name: 'after', text: 'x' }))
      t.eq('a note after the pack is refused, and the folder is not recreated', [after?.status, await exists(c.path)], [409, false])

      const d = await fresh('Note holds the issue')
      const step = await acquire(path.join(d.path, '.step-alloc.lock'), { purpose: 'test', mkdir: false })
      const packed = await refusal(issues.setIssueArchived(P, d.id, true, { overrideReason: 'test', seams: { lockWaitMs: 0 } }))
      t.eq('pack refused by a held step lock, retryably', busy(packed), [409, 'ISSUE_BUSY', true])
      t.eq('and nothing changed', [await exists(path.join(d.path, '.archive.json')), await exists(bundleFiles(ISSUES, P, d.id).bundle)], [false, false])
      await step.release()
    }

    t.section('restore × step write')
    {
      const r = await fresh('Restore and step')
      await issues.setIssueArchived(P, r.id, true, { overrideReason: 'test' })
      await issues.createEngineNote(P, r.id, { name: 'kept-note', text: 'from the archive', invocationId: 'test:restore-note' })
      let before = null; let during = null
      await issues.setIssueArchived(P, r.id, false, {
        seams: {
          beforePublish: async () => { before = [await exists(r.path), (await refusal(issues.createStep(P, r.id, { name: 'early', text: 'x', lockWaitMs: 0 })))?.status] },
          whileLocked: async () => { during = [await exists(path.join(r.path, '.run.lock')), busy(await refusal(issues.createStep(P, r.id, { name: 'during', text: 'x', lockWaitMs: 0 })))] }
        }
      })
      t.eq('before publish nothing is at the target, and a step write is refused', before, [false, 409])
      t.eq('published already locked: a step write is refused, retryably', during, [true, [409, 'ISSUE_BUSY', true]])
      const steps = (await issues.getIssue(P, r.id)).steps.map((s) => s.id)
      t.ok('afterwards the kept note is a step', steps.some((s) => s.endsWith('-kept-note')), steps.join(', '))
      t.eq('no early or refused step was written', steps.filter((s) => s.endsWith('-early') || s.endsWith('-during')), [])
      t.eq('the locks are released and the kept notes gone', [await exists(path.join(r.path, '.run.lock')), await exists(path.join(r.path, '.step-alloc.lock')), await exists(bundleFiles(ISSUES, P, r.id).notes)], [false, false, false])
    }

    t.section('delete × run lock')
    {
      const e = await fresh('Delete and run lock')
      await markArchived(e)
      const live = await acquire(path.join(e.path, '.run.lock'), { purpose: 'run', mkdir: false })
      t.eq('a live run lock refuses the delete, retryably', busy(await refusal(issues.deleteIssue(P, e.id))), [409, 'ISSUE_BUSY', true])
      t.eq('and the folder stays', await exists(e.path), true)
      await live.release()

      const lock = path.join(e.path, '.run.lock')
      await lockRecord(lock, { ...(await currentOwner()), pid: 424242, host: 'somewhere-else' })
      t.eq('an owner whose liveness is unknown is never taken over', busy(await refusal(issues.deleteIssue(P, e.id))), [409, 'ISSUE_BUSY', true])
      t.eq('and the folder stays', await exists(e.path), true)
      await lockRecord(lock, { ...(await currentOwner()), pid: deadPid(), processStartedAt: null })
      let unpublished = null
      const deleted = await issues.deleteIssue(P, e.id, {
        seams: {
          afterUnpublish: async () => {
            const relock = await refusal(acquireIssueLock(lock, { purpose: 'run' }).then((l) => l.release()))
            unpublished = [await exists(e.path), relock?.code, await exists(e.path), (await refusal(issues.createStep(P, e.id, { name: 'late', text: 'x' })))?.status]
          }
        }
      })
      t.eq('a dead owner\'s lock is taken over and the delete completes', [deleted.deleted, await exists(e.path)], [true, false])
      t.eq('during removal the public path is gone, its lock cannot be taken or recreated, and writers are refused', unpublished, [false, 'ISSUE_MOVED', false, 404])
    }

    t.section('a delete that fails after moving the folder aside')
    {
      const s = await fresh('Delete stranded')
      await markArchived(s)
      const files = bundleFiles(ISSUES, P, s.id)
      await fs.mkdir(files.dir, { recursive: true })
      await fs.writeFile(files.notes, '[]')
      await fs.writeFile(files.repeatLookup, '{}')
      const rejected = gate()
      let inside = null; let note = null
      const error = await refusal(issues.deleteIssue(P, s.id, {
        seams: {
          removeFile: async (file) => {
            if (file === files.repeatLookup) { rejected.open(); throw new Error('injected removal failure') }
            if (file === files.notes) {
              await rejected.p
              const bundleLock = await refusal(acquire(files.lock, { purpose: 'test' }).then((l) => l.release()))
              const admission = await refusal(acquire(admissionLockFile(ISSUES, P), { purpose: 'test' }).then((l) => l.release()))
              note = issues.createEngineNote(P, s.id, { name: 'too-late', text: 'x', invocationId: 'test:stranded' }).then(() => 'written', (e) => e.status)
              inside = [bundleLock?.constructor?.name, admission?.constructor?.name, await exists(s.path)]
            }
            await fs.rm(file, { force: true })
          }
        }
      }))
      t.eq('while a sibling removal is pending after one failed, the bundle and admission locks are still held', inside, ['LockHeld', 'LockHeld', false])
      t.ok('the error names where the folder was left', typeof error?.strandedPath === 'string' && error.strandedPath.includes(`${path.sep}.removing-`) && error.strandedPath.endsWith(`${path.sep}${s.id}`) && error.message.includes(error.strandedPath), error?.message)
      t.eq('that folder is still there, whole', await exists(path.join(error.strandedPath, 'issue.json')), true)
      t.eq('the public path is gone and no deletion is recorded', [await exists(s.path), await exists(path.join(ISSUES, P, '.deleted-issues', `${s.id}.json`))], [false, false])
      t.eq('a note waiting meanwhile finds no issue and writes nothing', [await note, await exists(files.notes)], [404, false])
      t.eq('a second delete finds nothing to delete', (await refusal(issues.deleteIssue(P, s.id)))?.status, 404)
      t.eq('and nothing recovers the moved-aside folder', await exists(path.join(error.strandedPath, 'issue.json')), true)
      await fs.rm(path.dirname(error.strandedPath), { recursive: true, force: true })
    }

    t.section('a packed delete keeps its locks until every removal settles')
    {
      const k = await fresh('Packed delete')
      await issues.setIssueArchived(P, k.id, true, { overrideReason: 'test' })
      await issues.createEngineNote(P, k.id, { name: 'kept', text: 'x', invocationId: 'test:packed-kept' })
      const files = bundleFiles(ISSUES, P, k.id)
      await fs.writeFile(files.receipts, '{}')
      const rejected = gate()
      let inside = null; let note = null
      const error = await refusal(issues.deleteIssue(P, k.id, {
        seams: {
          removeFile: async (file) => {
            if (file === files.notes) { rejected.open(); throw new Error('injected notes failure') }
            if (file === files.receipts) {
              await rejected.p
              const bundleLock = await refusal(acquire(files.lock, { purpose: 'test' }).then((l) => l.release()))
              const admission = await refusal(acquire(admissionLockFile(ISSUES, P), { purpose: 'test' }).then((l) => l.release()))
              note = issues.createEngineNote(P, k.id, { name: 'late', text: 'x', invocationId: 'test:packed-late' }).then(() => 'written', (e) => e.status)
              inside = [bundleLock?.constructor?.name, admission?.constructor?.name]
            }
            await fs.rm(file, { force: true })
          }
        }
      }))
      t.eq('while a removal is pending after another failed, the bundle and admission locks are still held', inside, ['LockHeld', 'LockHeld'])
      t.eq('the delete reports the failure', error?.message, 'injected notes failure')
      t.eq('no archived id holder is left', await archivedIdHolders(ISSUES, P, k.id), [])
      t.eq('the waiting note finds no issue and adds nothing', [await note, (await fs.readFile(files.notes, 'utf8')).includes('test:packed-late')], [404, false])
      t.eq('no deletion is recorded', await exists(path.join(ISSUES, P, '.deleted-issues', `${k.id}.json`)), false)
      await fs.rm(files.notes, { force: true })
    }

    t.section('deleteRun takes the step lock before it changes anything')
    {
      const dr = await fresh('Delete a run')
      const runId = '2026-01-01T00-00-00-000Z-0dead0ff'
      const runDir = path.join(dr.path, 'runs', runId)
      await fs.mkdir(runDir, { recursive: true })
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId, issue: { project: P, id: dr.id }, status: 'completed', startedAt: new Date().toISOString(), participants: {}, steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} } }))
      const bytes = await fs.readFile(path.join(runDir, 'run.json'), 'utf8')
      const step = await acquire(path.join(dr.path, '.step-alloc.lock'), { purpose: 'test', mkdir: false })
      t.eq('a held step lock refuses it, retryably', busy(await refusal(supervisor.deleteRun({ project: P, issueId: dr.id, runId }))), [409, 'ISSUE_BUSY', true])
      t.eq('and the run record is untouched', await fs.readFile(path.join(runDir, 'run.json'), 'utf8'), bytes)
      await step.release()
    }

    t.section('existing behaviour: a live run still refuses packing; a packed repeat')
    {
      const ac = await fresh('Pack a live run')
      await markArchived(ac)
      const runId = '2026-01-01T00-00-00-000Z-0a11ve00'
      await fs.mkdir(path.join(ac.path, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(ac.path, 'runs', runId, 'run.json'), JSON.stringify({ runId, status: 'running', participants: {} }))
      await lockRecord(path.join(ac.path, '.run.lock'), { ...(await currentOwner()), pid: deadPid(), processStartedAt: null })
      const refused = await refusal(issues.packArchived(P, ac.id))
      t.ok('a run recorded as running refuses packing, its dead lock taken over notwithstanding', refused?.status === 409 && /Stop the active run/.test(refused.message), refused?.message)
      t.eq('the folder stays and no bundle is made', [await exists(ac.path), await exists(bundleFiles(ISSUES, P, ac.id).bundle)], [true, false])

      const pr = await fresh('Packed repeat')
      await issues.setIssueArchived(P, pr.id, true, { overrideReason: 'test' })
      t.eq('archiving a packed issue again is a harmless repeat', (await issues.setIssueArchived(P, pr.id, true)).packed, true)
      t.eq('the pack tool still refuses it', (await refusal(issues.packArchived(P, pr.id)))?.status, 409)
    }

    t.section('a lifecycle id names a direct child of the project folder')
    {
      const outside = path.join(ISSUES, 'other-project', '2026-01-01-outside')
      await fs.mkdir(outside, { recursive: true })
      await fs.writeFile(path.join(outside, 'issue.json'), '{}')
      await fs.writeFile(path.join(outside, '.archive.json'), '{}')
      const id = '2026-01-01-a/../../other-project/2026-01-01-outside'
      t.eq('delete, restore and pack of a multi-component id are refused', [
        (await refusal(issues.deleteIssue(P, id)))?.status,
        (await refusal(issues.setIssueArchived(P, id, false)))?.status,
        (await refusal(issues.packArchived(P, id)))?.status
      ], [404, 404, 404])
      t.eq('and the folder outside the project is untouched, still archived', [await exists(path.join(outside, 'issue.json')), await exists(path.join(outside, '.archive.json'))], [true, true])
    }

    t.section('a packed restore refused by a held moves lock is retryable and changes nothing')
    {
      const pm = await fresh('Restore behind moves')
      await issues.setIssueArchived(P, pm.id, true, { overrideReason: 'test' })
      const files = bundleFiles(ISSUES, P, pm.id)
      const before = await fs.readFile(files.bundle)
      const moves = await acquire(path.join(ISSUES, '.archive', P, '.moves.lock'), { purpose: 'test' })
      const refused = await refusal(issues.setIssueArchived(P, pm.id, false, { seams: { lockWaitMs: 0 } }))
      await moves.release()
      t.eq('refused ISSUE_BUSY, retryable', busy(refused), [409, 'ISSUE_BUSY', true])
      t.eq('no folder, the bundle as it was, nothing of the attempt left', [await exists(pm.path), (await fs.readFile(files.bundle)).equals(before), (await fs.readdir(path.join(ISSUES, P))).filter((n) => n.startsWith('.restoring-'))], [false, true, []])
    }

    t.section('a new issue moves past an id a delete is still cleaning up')
    {
      const x = await fresh('Busy id')
      await markArchived(x)
      const held = gate(); const inside = gate()
      const deleting = issues.deleteIssue(P, x.id, { seams: { afterUnpublish: async () => { inside.open(); await held.p } } })
      await inside.p
      const created = await issues.createIssue(P, { name: 'Busy id' }, { createLockWaitMs: 0 })
      t.eq('it takes the next suffix instead of retrying the held id', created.id, `${x.id}-2`)
      held.open()
      t.eq('and the delete completes', (await deleting).deleted, true)
    }

    t.section('a new issue whose every free id is held by a lifecycle operation is refused retryably')
    {
      const x = await fresh('Every id busy')
      await markArchived(x)
      // Every other suffix (2..100) is an archived folder, so the id the delete holds is the only one left.
      const taken = []
      for (let n = 2; n <= 100; n++) {
        const dir = path.join(ISSUES, P, `${x.id}-${n}`)
        await fs.mkdir(dir)
        await fs.writeFile(path.join(dir, '.archive.json'), JSON.stringify({ archivedAt: new Date().toISOString() }))
        taken.push(dir)
      }
      const held = gate(); const inside = gate()
      const deleting = issues.deleteIssue(P, x.id, { seams: { afterUnpublish: async () => { inside.open(); await held.p } } })
      await inside.p
      const refused = await refusal(issues.createIssue(P, { name: 'Every id busy' }, { createLockWaitMs: 0 }))
      t.eq('ISSUE_BUSY, retryable, not a plain 409', busy(refused), [409, 'ISSUE_BUSY', true])
      t.eq('nothing was opened', (await fs.readdir(path.join(ISSUES, P))).filter((n) => n.startsWith(x.id)).length, 99)
      held.open()
      t.eq('and the delete completes', (await deleting).deleted, true)
      for (const dir of taken) await fs.rm(dir, { recursive: true, force: true })
    }

    t.section('a receipt that waited through a restore is written into the restored folder')
    {
      const rr = await fresh('Receipt through restore')
      const runId = '2026-01-01-0000000000-receipt'
      await fs.mkdir(path.join(rr.path, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(rr.path, 'runs', runId, 'run.json'), JSON.stringify({ runId, status: 'completed' }))
      await issues.setIssueArchived(P, rr.id, true, { overrideReason: 'test' })
      const rel = `runs/${runId}/staging-coverage-notes.json`
      let writing = null
      await issues.setIssueArchived(P, rr.id, false, {
        seams: { beforePublish: async () => { writing = issues.writeCoverageReceipt(P, rr.id, { source: { kind: 'run', runId }, rel, ref: runId, receipt: { x: 'written' } }) } }
      })
      t.eq('it lands beside the restored run', [await writing, JSON.parse(await fs.readFile(path.join(rr.path, rel), 'utf8')).x], ['folder', 'written'])
    }

    t.section('a receipt writer that saw no folder, then no bundle because a restore removed it, reads the folder again')
    {
      const rg = await fresh('Receipt between readings')
      const runId = '2026-01-01-0000000000-between'
      await fs.mkdir(path.join(rg.path, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(rg.path, 'runs', runId, 'run.json'), JSON.stringify({ runId, status: 'completed' }))
      await issues.setIssueArchived(P, rg.id, true, { overrideReason: 'test' })
      const rel = `runs/${runId}/staging-coverage-notes.json`
      const held = gate(); const inside = gate()
      const reads = []
      // The first folder reading (no folder: packed) pauses; the whole restore runs; the bundle reading follows.
      const writing = issues.writeCoverageReceipt(P, rg.id, { source: { kind: 'run', runId }, rel, ref: runId, receipt: { x: 'between' } }, {
        afterFolderRead: async (inFolder) => { reads.push(inFolder); if (reads.length === 1) { inside.open(); await held.p } }
      })
      await inside.p
      await issues.setIssueArchived(P, rg.id, false)
      t.eq('the restore removed every bundle holder before the writer read them', (await archivedIdHolders(ISSUES, P, rg.id)).length, 0)
      held.open()
      t.eq('written into the restored folder, not reported gone', [await writing, JSON.parse(await fs.readFile(path.join(rg.path, rel), 'utf8')).x], ['folder', 'between'])
      t.eq('the folder was read again after the empty bundle reading', reads, [false, true])
    }

    t.section('a full verification staging release keeps its receipt in its dot-prefixed run home')
    {
      const home = await issues.ensureRunHome(P, '2026-01-02', 'report')
      const homeDir = path.join(ISSUES, P, '.verification-2026-01-02')
      const runId = '2026-01-02-0000000000-verify'
      await fs.mkdir(path.join(homeDir, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(homeDir, 'runs', runId, 'run.json'), JSON.stringify({ runId, status: 'completed' }))
      const rel = `runs/${runId}/staging-coverage-notes.json`
      const where = await issues.writeCoverageReceipt(P, home.id, { source: { kind: 'run', runId }, rel, ref: runId, receipt: { x: 'home' } })
      t.eq('persisted in the run home', [home.id, where, JSON.parse(await fs.readFile(path.join(homeDir, rel), 'utf8')).x], ['verification-2026-01-02', 'folder', 'home'])
      t.eq('nothing under the bare id', await exists(path.join(ISSUES, P, home.id)), false)
    }

    t.section('restore releases every lock and its work even when one release fails')
    {
      const rl = await fresh('Release fails')
      await issues.setIssueArchived(P, rl.id, true, { overrideReason: 'test' })
      const refused = await refusal(issues.setIssueArchived(P, rl.id, false, {
        seams: { releaseLock: async (lock) => { if (lock.file.endsWith('.step-alloc.lock')) throw new Error('injected release failure'); return lock.release() } }
      }))
      t.eq('the failure is reported', refused?.message, 'injected release failure')
      t.eq('the run lock is released all the same, and nothing of the work is left', [await exists(path.join(rl.path, '.run.lock')), (await fs.readdir(path.join(ISSUES, P))).filter((n) => n.startsWith('.restoring-'))], [false, []])
      await fs.rm(path.join(rl.path, '.step-alloc.lock'), { force: true })
    }

    t.section('a pending repeat lookup writes nothing for an issue deleted meanwhile, nor over a newer one')
    {
      const { completePendingLookup, lookupRetry } = await import('../server/report-identity.mjs')
      const gone = await fresh('Lookup outlived')
      // The lookup belongs to this very issue: only its deletion can keep the sidecar from being written.
      const openedAt = (await issues.getIssue(P, gone.id, { settle: false })).openedAt
      t.ok('the lookup carries the issue\'s own openedAt', typeof openedAt === 'string' && openedAt.length > 0)
      const record = { openedAt, report: { fingerprint: 'fp-lookup-test' } }
      lookupRetry.seams.beforeOutcomeWrite = async (id) => { if (id === gone.id) { await markArchived(gone); await issues.deleteIssue(P, gone.id) } }
      await completePendingLookup({ issuesDir: ISSUES, project: P, id: gone.id, record })
      t.eq('deleted while it ran: no sidecar is recreated', await exists(bundleFiles(ISSUES, P, gone.id).repeatLookup), false)
      delete lookupRetry.seams.beforeOutcomeWrite
      const newer = await fresh('Lookup newer')
      const sidecar = bundleFiles(ISSUES, P, newer.id).repeatLookup
      await fs.mkdir(path.dirname(sidecar), { recursive: true })
      await fs.writeFile(sidecar, JSON.stringify({ openedAt: 'newer', repeats: null }))
      await completePendingLookup({ issuesDir: ISSUES, project: P, id: newer.id, record: { ...record, openedAt: new Date(Date.now() - 60000).toISOString() } })
      t.eq('the id now another issue\'s: its outcome is not overwritten', JSON.parse(await fs.readFile(sidecar, 'utf8')).openedAt, 'newer')
    }

    t.section('issue metadata writes refused by a lifecycle lock are retryable')
    {
      const m = await fresh('Metadata busy')
      const step = await acquire(path.join(m.path, '.step-alloc.lock'), { purpose: 'test', mkdir: false })
      t.eq('a priority write', busy(await refusal(issues.setIssuePriority(P, m.id, { value: 'high', reason: 'test', lockWaitMs: 0 }))), [409, 'ISSUE_BUSY', true])
      t.eq('a disposition write', busy(await refusal(issues.setIssueDisposition(P, m.id, { value: 'declined', evidence: 'test', lockWaitMs: 0 }))), [409, 'ISSUE_BUSY', true])
      await step.release()
    }
  } finally {
    await cleanupFixtures()
  }
}
