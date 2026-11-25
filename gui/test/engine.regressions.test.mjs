import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { fingerprint } from '../server/runtime/fingerprint.mjs'
import { LockHeld } from '../server/runtime/lock.mjs'
import { engineFixture, scriptFor, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

export const name = 'engine — regressions for the milestone-3 boundary findings'

const start = (f, extra = {}) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath,
  projectPath: f.projectPath,
  harnesses: f.harnesses,
  stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot,
  probe: f.probe,
  clock: f.clock,
  deliveryProvider: f.delivery,
  ...extra
})

async function reopen (f, runId, extra = {}) {
  await simulateProcessDeath(f.issuePath)
  return resumeRun({
    issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore,
    clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery,
    workspaceProvider: f.workspaceProvider, projectPath: f.projectPath, ...extra
  })
}

const folders = async (f) => (await fs.readdir(f.issuePath, { withFileTypes: true }))
  .filter((e) => e.isDirectory() && /^\d{3}-/.test(e.name)).map((e) => e.name).sort()

export default async function (t) {
  // ------------------------------------------------------- 1. partial persist
  t.section('1. a crash INSIDE persistence must not duplicate the step')
  {
    const f = await engineFixture()
    const engine = await start(f)
    const real = f.stepStore.create
    // Fail immediately after the folder exists but before anything records it.
    f.stepStore.create = async (args) => { const r = await real(args); throw Object.assign(new Error('crash'), { created: r }) }
    await engine.drive().catch(() => {})
    f.stepStore.create = real

    const orphaned = await folders(f)
    t.eq('a folder was left on disk', orphaned.length, 1, orphaned.join(','))
    t.eq('and run.json does not know about it', engine.run.steps.length, 0)

    const resumed = await reopen(f, engine.runId)
    await resumed.recover()
    const run = await resumed.drive()

    const after = await folders(f)
    const triage = after.filter((x) => x.endsWith('-triage'))
    t.eq('recovery reused the reserved folder', triage.length, 1, after.slice(0, 3).join(','))
    t.eq('every folder is recorded', after.length, run.steps.length)
    t.eq('numbers still start at 000', after[0], '000-triage')
    t.eq('and the run completes', run.outcome, 'resolved')
    await releaseWorkspace(resumed)
  }

  t.section('1b. adopted work still records its revision')
  {
    const f = await engineFixture()
    const engine = await start(f)
    // Crash right after the implement turn's agent finished.
    engine.hooks.afterInvokeBeforePersist = async (e) => {
      if (e.run.participants.implementer.pendingInvocation?.cursor.stepId === 'implement') {
        delete e.hooks.afterInvokeBeforePersist
        throw new Error('crash')
      }
    }
    await engine.drive().catch(() => {})
    const resumed = await reopen(f, engine.runId)
    await resumed.recover()
    const adopted = resumed.run.steps.find((s) => s.stepId === 'implement')
    t.ok('the implement step was adopted', Boolean(adopted))
    t.ok('and it carries a revision', Boolean(adopted?.revision), adopted?.revision?.slice(0, 20))
    t.eq('a revision was recorded for the run', resumed.run.revisions.length, 1)
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------- 2. cancellation
  t.section('2. a cancelled run must not restart')
  {
    const f = await engineFixture()
    const engine = await start(f)
    engine.hooks.beforeInvoke = async (e) => { if (e.run.steps.length === 2) e.cancel() }
    await engine.drive()
    t.eq('cancelled', engine.run.status, 'cancelled')
    const stepsAtCancel = engine.run.steps.length
    const invocationsAtCancel = await f.fake.ledger.invocationCount()

    const resumed = await reopen(f, engine.runId)
    t.eq('the cancellation survived the restart', resumed.run.status, 'cancelled')
    const run = await resumed.drive()
    t.eq('drive() left the status alone', run.status, 'cancelled')
    t.eq('no further steps', run.steps.length, stepsAtCancel)
    t.eq('no further invocations', await f.fake.ledger.invocationCount(), invocationsAtCancel)

    const events = JSON.parse(JSON.stringify(await import('../server/runtime/store.mjs')
      .then((m) => m.readEvents(f.issuePath, engine.runId).then(r => r.events))))
    t.ok('and the refusal is on the record', events.some((e) => e.type === 'drive-refused'),
      events.filter((e) => e.type === 'drive-refused')[0]?.reason)
    await releaseWorkspace(resumed)
  }

  t.section('2b. a blocked or recovery-required run also refuses to drive')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    engine.run.status = 'blocked'
    engine.run.blockedReason = 'recovery-required'
    const before = engine.run.steps.length
    await engine.drive()
    t.eq('blocked run does not resume', engine.run.steps.length, before)
    t.eq('status untouched', engine.run.status, 'blocked')
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------- 3. closure
  t.section('3. closure re-derives the fingerprint and performs real delivery')
  {
    const f = await engineFixture()
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('a clean run closes', run.outcome, 'resolved')
    t.eq('delivery was actually performed', f.delivery.calls.length, 1)
    t.eq('for the closing revision', f.delivery.calls[0].revision, run.closure.revision)
    const artifact = path.join(f.issuePath, 'runs', engine.runId, run.delivery.artifactRef)
    t.ok('and produced an artifact', await fs.stat(artifact).then(() => true, () => false), run.delivery.artifactRef)
    t.eq('revalidated after delivery', run.delivery.revalidated, true)
    await releaseWorkspace(engine)
  }

  t.section('3b. content changed after approval cannot close')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive()
    const approved = engine.run.approvals[0].revision
    const deliveries = f.delivery.calls.length

    // Something touches the candidate after everyone agreed.
    await fs.writeFile(path.join(engine.run.workspace.path, 'sneaky.txt'), 'never reviewed')
    await engine.evaluateClosure()

    t.ok('the drift was noticed', engine.run.closure.drifted === true)
    t.ok('closure names the NEW content', engine.run.closure.revision !== approved,
      `${approved.slice(0, 16)} -> ${engine.run.closure.revision.slice(0, 16)}`)
    t.eq('the approval no longer applies', engine.run.closure.conditions.sameRevisionApproval, false)
    t.eq('it does not close', engine.run.outcome, 'unresolved')
    t.eq('and says why', engine.run.blockedReason, 'candidate-changed-since-approval')
    t.eq('nothing further was delivered', f.delivery.calls.length, deliveries)
    await releaseWorkspace(engine)
  }

  t.section('3c. with no delivery provider, delivery is incomplete rather than assumed')
  {
    const f = await engineFixture()
    const engine = await start(f, { deliveryProvider: null })
    const run = await engine.drive()
    t.eq('every other condition holds', run.closure.conditions.coordinatorConfirmation, true)
    t.eq('but delivery did not happen', run.closure.conditions.deliveryCompleted, false)
    t.eq('so the run does not close', run.outcome, 'unresolved')
    t.eq('and it says delivery is unavailable', run.blockedReason, 'delivery-unavailable')
    t.eq('no delivery record was invented', run.delivery, null)
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------- 4. evidence
  t.section('4. a harness that cannot reconcile blocks rather than assuming no work')
  {
    const f = await engineFixture()
    const engine = await start(f)
    engine.hooks.afterInvokeBeforePersist = async (e) => { delete e.hooks.afterInvokeBeforePersist; throw new Error('crash') }
    await engine.drive().catch(() => {})

    // A harness with no reconcile at all — an adapter that cannot answer.
    const mute = { ...f.fake, reconcile: undefined }
    delete mute.reconcile
    const resumed = await reopen(f, engine.runId, { harnesses: { fake: mute } })
    await resumed.recover()

    t.eq('the run is blocked', resumed.run.status, 'blocked')
    t.eq('for recovery', resumed.run.blockedReason, 'recovery-required')
    t.ok('and the reason says the harness could not answer', /cannot reconcile/.test(resumed.run.recovery.reason ?? ''),
      resumed.run.recovery.reason)
    t.ok('the pending invocation was NOT cleared',
      Object.values(resumed.run.participants).some((p) => p.pendingInvocation))
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------- 5. baseline
  t.section('5. the fingerprint baseline survives a restart unchanged')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive({ maxTurns: 1 })
    const original = new Map(engine.baseline)
    t.ok('the base file is in the baseline', original.has('source.txt'))

    // The author changes a tracked file, as it would.
    await fs.writeFile(path.join(engine.run.workspace.path, 'source.txt'), 'modified by the author')

    const resumed = await reopen(f, engine.runId)
    t.eq('the restored baseline matches the original', [...resumed.baseline.keys()].sort(), [...original.keys()].sort())
    t.eq('and holds the ORIGINAL content hash', resumed.baseline.get('source.txt'), original.get('source.txt'))

    const fp = await fingerprint(resumed.run.workspace.path, { baseline: resumed.baseline, clock: f.clock })
    t.eq('so the change reads as modified', fp.entries.find((e) => e.path === 'source.txt').status, 'modified')
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------- 6. output schemas
  t.section('6. agent output is validated against its contract, not just field presence')
  {
    const base = scriptFor()
    const f = await engineFixture({
      script: (args) => args.stepId === 'audit-implement-1' && args.attempt === 1
        // Every required field present, but the verdict is not a verdict and the
        // findings are strings. A presence check would wave this through.
        ? ['Reviewed.', '```json', '{"verdict":"maybe","artifactRevision":"x","findings":["it is bad"]}', '```'].join(String.fromCharCode(10))
        : base(args)
    })
    const engine = await start(f)
    const run = await engine.drive()
    const attempts = run.steps.filter((s) => s.stepId === 'audit-implement-1')
    t.ok('it was rejected and repaired', attempts.length > 1, `${attempts.length} attempts`)

    const outputs = await import('../server/runtime/store.mjs').then((m) => m.readOutputs(f.issuePath, engine.runId))
    const first = outputs[attempts[0].number]
    t.eq('marked invalid', first.valid, false)
    t.ok('with a contract error, not a missing-field error', /does not satisfy the reviewResult contract/.test(first.error ?? ''), first.error)
    t.eq('and the run recovers', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------- 7. ownership
  t.section('7. one run per issue, and budgets beyond step count')
  {
    const f = await engineFixture()
    const engine = await start(f)
    let second = null
    try { await start(f) } catch (error) { second = error }
    t.ok('a second run on the same issue is refused', Boolean(second), second?.message)
    // IssueBusy (issue-locks.mjs) is the LockHeld an issue's run lock refuses with.
    t.ok('the refusal names the lock', second instanceof LockHeld, second?.constructor?.name)
    await releaseWorkspace(engine)
    const third = await start(f)
    t.ok('and the lock is available again once released', Boolean(third))
    await releaseWorkspace(third)
  }

  t.section('7b. the wall-clock budget stops a run that step count would not')
  {
    const f = await engineFixture()
    const engine = await start(f)
    // implementation allows 240 minutes and 120 steps; burn the clock, not the steps.
    engine.hooks.beforeInvoke = async (e) => { e.clock.advance(61 * 60_000) }
    const run = await engine.drive()
    t.eq('blocked', run.status, 'blocked')
    t.eq('on budget', run.blockedReason, 'budget-exhausted')
    t.ok('well under the step limit', run.steps.length < run.budgets.limits.maxSteps,
      `${run.steps.length} of ${run.budgets.limits.maxSteps} steps`)
    t.eq('unresolved', run.outcome, 'unresolved')
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------- 8. reservations
  t.section('8. a reservation claims the number against every other writer')
  {
    const f = await engineFixture()
    const engine = await start(f)
    const real = f.stepStore.create
    // Crash INSIDE the real allocator: the reservation is written and the
    // caller's intent recorded, then the process dies before mkdir.
    f.stepStore.create = (args) => real({
      ...args,
      onReserve: async (entry) => {
        await args.onReserve?.(entry)
        throw new Error('crash after reserve')
      }
    })
    await engine.drive().catch(() => {})
    f.stepStore.create = real

    t.eq('no folder exists yet', (await folders(f)).length, 0)

    // A manual step arrives while that reservation is outstanding.
    const manual = await f.stepStore.create({ name: 'fix', response: '# manual' })
    t.ok('the manual step did NOT take the reserved number', manual.number !== '000', `manual took ${manual.number}`)

    const resumed = await reopen(f, engine.runId)
    await resumed.recover()
    const after = await folders(f)
    const numbers = after.map((x) => x.slice(0, 3))
    t.eq('no two folders share a number', new Set(numbers).size, numbers.length, after.join(','))
    t.ok('the reservation still owns 000', after.some((x) => x === '000-triage'), after.join(','))
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------- 9. revision durability
  t.section('9. a crash before the revision is written is repaired, not lost')
  {
    const f = await engineFixture()
    const engine = await start(f)
    const original = engine.recordRevision.bind(engine)
    let broken = true
    engine.recordRevision = async (...a) => { if (broken) throw new Error('crash before revision'); return original(...a) }
    await engine.drive().catch(() => {})

    const persisted = await reopen(f, engine.runId)
    const impl = persisted.run.steps.find((s) => s.stepId === 'implement')
    t.ok('the step is recorded', Boolean(impl))
    t.eq('but has no revision yet', impl.revision, null)
    t.ok('and the turn is still marked pending', Boolean(persisted.run.participants.implementer.pendingInvocation))

    broken = false
    await persisted.recover()
    const repaired = persisted.run.steps.find((s) => s.stepId === 'implement')
    t.ok('recovery filled the revision in', Boolean(repaired.revision), repaired.revision?.slice(0, 20))
    t.eq('and recorded it on the run', persisted.run.revisions.length, 1)
    t.eq('the pending invocation is now cleared', persisted.run.participants.implementer.pendingInvocation, null)
    t.eq('without duplicating the step', persisted.run.steps.filter((s) => s.stepId === 'implement').length, 1)
    await releaseWorkspace(persisted)
  }

  // ------------------------------------------------------- 10. lock takeover
  t.section('10. dead-lock takeover is serialized and release verifies ownership')
  {
    const { acquire } = await import('../server/runtime/lock.mjs')
    const os = await import('node:os')
    const f = await engineFixture()
    const file = path.join(f.issuePath, 'takeover.lock')
    const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await fs.writeFile(file, JSON.stringify({
      purpose: 'run', token: 'stale',
      owner: { pid: process.pid, bootId, processStartedAt: '1', host: os.hostname() }, acquiredAt: 'x'
    }))

    const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquire(file, { purpose: 'run' })))
    const winners = results.filter((r) => r.status === 'fulfilled').map((r) => r.value)
    t.eq('exactly one contender acquires', winners.length, 1)
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    t.eq('and the file holds that winner', onDisk.token, winners[0].token)

    const live = await acquire(file, { purpose: 'run' }).catch(() => null)
    t.eq('a live lock is not taken over', live, null)

    // Someone else legitimately took the lock over. The previous holder's
    // release must not delete it — that is how two owners end up believing
    // they hold the same lock.
    await fs.writeFile(file, JSON.stringify({ purpose: 'run', token: 'a-different-owner', owner: onDisk.owner, acquiredAt: 'y' }))
    t.eq('a stale holder cannot release it', await winners[0].release(), false)
    t.eq('and the new owner\'s lock survives', JSON.parse(await fs.readFile(file, 'utf8')).token, 'a-different-owner')

    // Restore ownership and confirm a genuine release works exactly once.
    await fs.writeFile(file, JSON.stringify({ purpose: 'run', token: winners[0].token, owner: onDisk.owner, acquiredAt: 'z' }))
    t.eq('the owner can release it', await winners[0].release(), true)
    t.eq('and releasing twice is a no-op', await winners[0].release(), false)
  }

  // ------------------------------------------------------- 11. hung invocation
  t.section('11. the wall-clock deadline stops a hung invocation mid-turn')
  {
    const base = scriptFor()
    let hung = false
    const f = await engineFixture({
      script: (args) => {
        if (args.stepId === 'implement' && !hung) {
          hung = true
          // Burn past the 240-minute deadline, then never return — a wedged agent.
          return new Promise(() => { args.clock ? args.clock.advance(241 * 60_000) : null })
        }
        return base(args)
      }
    })
    // The script needs the clock to move time while it hangs.
    const withClock = f.harnesses.fake
    const originalInvoke = withClock.invoke
    withClock.invoke = (opts) => originalInvoke({ ...opts, meta: { ...opts.meta, clock: f.clock } })

    const engine = await start(f)
    const run = await engine.drive()

    t.eq('the run stopped', run.status, 'blocked')
    t.eq('on the wall-clock budget', run.blockedReason, 'budget-exhausted')
    t.ok('the hung invocation actually stopped', engine.invocationStoppedAt !== null)
    t.ok('nothing is left mid-invocation', Object.values(run.participants).every((p) => !p.pendingInvocation))
    t.ok('and it stopped well under the step budget', run.steps.length < run.budgets.limits.maxSteps,
      `${run.steps.length} of ${run.budgets.limits.maxSteps}`)
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
