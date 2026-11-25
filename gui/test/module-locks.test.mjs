import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { currentOwner } from '../server/runtime/lock.mjs'
import { conflictsWith, dropReservation, endContinuation, lockedMessage, oweEnded, poolDirectory, readPoolLocks, readReservations, readWaits, reclaimRunLocks, releaseModules, releaseRunLocks, reservedAgainst, reserveModules, takeModules, writeWait, yieldsIn } from '../server/runtime/module-locks.mjs'
import { buildReadyQueue, freedSince, queueObservation } from '../server/ready-queue.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'module locks — take and release, cross-project conflicts, dead/unknown/stale owners, wait cycles, the ready queue and readiness'

const POOL = 'framework-project'
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
const state = (over = {}) => ({ campaign: null, focus: [], starts: 0, startsByIssue: {}, launches: [], failedLaunches: {}, limits: { maxRuns: 10, maxConcurrent: 3, maxStartsPerIssue: 2 }, ...over })

export default async function (t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'module-locks-')))
  const dir = path.join(root, 'locks')
  // A run record on disk: a lock's holder is live while its run.json says so.
  const issue = async (id, runId, status = 'running') => {
    const issuePath = path.join(root, 'issues', id)
    await fs.mkdir(path.join(issuePath, 'runs', runId), { recursive: true })
    await fs.writeFile(path.join(issuePath, 'runs', runId, 'run.json'), JSON.stringify({ runId, status }))
    return issuePath
  }
  const take = async (runId, project, issueId, modules, extra = {}) => takeModules({ pool: POOL, modules, runId, project, issueId, issuePath: await issue(issueId, runId), dir, ...extra })
  try {
    t.section('take and release; a framework module locked by one instance\'s run is locked for every member of the pool')
    {
      const a = await take('run-a', 'instance-a-project', 'issue-a', ['@c/x', 'a-modules/m'])
      t.eq('the whole set is taken', a.held.map((h) => h.module), ['@c/x', 'a-modules/m'])
      const fromFramework = await take('run-f', 'framework-project', 'issue-f', ['@c/y', '@c/x'])
      t.eq('a framework run wanting @c/x is refused, naming the holder', fromFramework.conflicts.map((c) => [c.module, c.runId, c.project, c.issueId]), [['@c/x', 'run-a', 'instance-a-project', 'issue-a']])
      t.eq('and takes nothing: all or nothing, @c/y stays free', (await readPoolLocks(POOL, { dir })).map((l) => l.module), ['@c/x', 'a-modules/m'])
      const otherInstance = await take('run-b', 'instance-b-project', 'issue-b', ['@c/x'])
      t.eq('another instance\'s run is refused too', otherInstance.conflicts[0]?.runId, 'run-a')
      t.ok('the refusal names the holder in words', /@c\/x is locked by run run-a of instance-a-project\/issue-a/.test(lockedMessage(otherInstance.conflicts)))
      const disjoint = await take('run-d', 'instance-b-project', 'issue-d', ['b-modules/n', '@c/y'])
      t.eq('a disjoint set is taken beside it', disjoint.held.length, 2)
      const locks = await readPoolLocks(POOL, { dir })
      t.eq('the pool reads every lock, held, with its run and issue', locks.map((l) => [l.module, l.runId, l.state]), [['@c/x', 'run-a', 'held'], ['@c/y', 'run-d', 'held'], ['a-modules/m', 'run-a', 'held'], ['b-modules/n', 'run-d', 'held']])
      t.eq('conflicts for an issue: held by another run only', conflictsWith(locks, ['@c/x', 'b-modules/n', 'free/z'], { project: 'instance-b-project', issueId: 'issue-d' }).map((c) => c.module), ['@c/x'])
      t.eq('release removes what the run holds', await releaseModules({ pool: POOL, held: a.held, dir }), 2)
      t.eq('releasing again removes nothing', await releaseModules({ pool: POOL, held: a.held, dir }), 0)
      const now = await take('run-f', 'framework-project', 'issue-f', ['@c/x'])
      t.eq('after the release the framework run takes @c/x', now.held.map((h) => h.module), ['@c/x'])
      const run = { runId: 'run-f', moduleLocks: { pool: POOL, held: now.held } }
      t.eq('a run end releases its locks', [await releaseRunLocks(run, { dir }), run.moduleLocks.held, run.moduleLocks.released.modules], [true, [], ['@c/x']])
      await releaseModules({ pool: POOL, held: disjoint.held, dir })
    }

    t.section('recovery like drive slots: a dead owner is taken over, an unknown owner never, a lock whose run ended is stale')
    {
      const me = await currentOwner('ghost')
      const file = (module) => path.join(poolDirectory(POOL, dir), `${sha(module)}.lock`)
      await fs.mkdir(poolDirectory(POOL, dir), { recursive: true })
      await fs.writeFile(file('@c/dead'), JSON.stringify({ purpose: 'module-lock', token: 'dead', module: '@c/dead', project: 'instance-a-project', issueId: 'gone', owner: { ...me, pid: 999999, processStartedAt: '1' } }))
      await fs.writeFile(file('@c/unknown'), JSON.stringify({ purpose: 'module-lock', token: 'unknown', module: '@c/unknown', project: 'instance-b-project', issueId: 'elsewhere', owner: { ...me, host: 'another-host.invalid' } }))
      const endedPath = await issue('ended', 'run-ended', 'completed')
      await fs.writeFile(file('@c/stale'), JSON.stringify({ purpose: 'module-lock', token: 'stale', module: '@c/stale', project: 'instance-a-project', issueId: 'ended', issuePath: endedPath, owner: await currentOwner('run-ended') }))
      const states = Object.fromEntries((await readPoolLocks(POOL, { dir })).map((l) => [l.module, l.state]))
      t.eq('read as dead, unknown and stale', [states['@c/dead'], states['@c/unknown'], states['@c/stale']], ['dead', 'unknown', 'stale'])
      t.eq('only the unknown one stands in a start\'s way', conflictsWith(await readPoolLocks(POOL, { dir }), ['@c/dead', '@c/unknown', '@c/stale']).map((c) => c.module), ['@c/unknown'])
      const dead = await take('run-n', 'framework-project', 'issue-n', ['@c/dead', '@c/stale'])
      t.eq('the dead owner\'s and the ended run\'s locks are taken over', dead.held.map((h) => h.module), ['@c/dead', '@c/stale'])
      const unknown = await take('run-u', 'framework-project', 'issue-u', ['@c/unknown'])
      t.eq('an unknown owner is not taken over', [unknown.held.length, unknown.conflicts[0]?.liveness], [0, 'unknown'])
      t.ok('and the refusal says so', /owner is unknown/.test(lockedMessage(unknown.conflicts)))
      await releaseModules({ pool: POOL, held: dead.held, dir })
      await fs.rm(file('@c/unknown'))

      // A resumed run takes its recorded locks again under this process: the earlier owner died with the panel.
      const resumedPath = await issue('resumed', 'run-r')
      await fs.writeFile(file('@c/kept'), JSON.stringify({ purpose: 'module-lock', token: 'kept', module: '@c/kept', issuePath: resumedPath, owner: { ...me, pid: 999999, processStartedAt: '1', runId: 'run-r' } }))
      const resumed = { runId: 'run-r', startedAt: '2026-01-01T00:00:00Z', moduleLocks: { pool: POOL, held: [{ module: '@c/kept', token: 'kept' }] } }
      const reclaimed = await reclaimRunLocks(resumed, { project: 'framework-project', issueId: 'resumed', issuePath: resumedPath, dir, persist: async () => {} })
      const after = (await readPoolLocks(POOL, { dir })).find((l) => l.module === '@c/kept')
      t.eq('reclaimed under a live owner', [reclaimed.conflicts, after?.state, after?.runId], [[], 'held', 'run-r'])
      await releaseRunLocks(resumed, { dir })

      // auditor-1-005: a lock taken over after a restart refuses the reclaim, and a second attempt must still acquire. This is the
      // reclaim of an ended run's continuation; a paused run owes its set instead and waits for it in the engine (engine.pause-locks).
      const pausedPath = await issue('paused', 'run-p', 'paused')
      await fs.writeFile(file('@c/p'), JSON.stringify({ purpose: 'module-lock', token: 'p', module: '@c/p', issuePath: pausedPath, owner: { ...me, pid: 999999, processStartedAt: '1', runId: 'run-p' } }))
      const thief = await take('run-t', 'instance-b-project', 'issue-t', ['@c/p'])
      t.eq('another run took the dead owner\'s lock', thief.held.map((h) => h.module), ['@c/p'])
      const paused = { runId: 'run-p', startedAt: '2026-01-01T00:00:00Z', moduleLocks: { pool: POOL, held: [{ module: '@c/p', token: 'p' }] } }
      const firstTry = await reclaimRunLocks(paused, { project: 'framework-project', issueId: 'paused', issuePath: pausedPath, dir, persist: async () => {} })
      t.eq('the resume is refused, naming the holder', firstTry.conflicts.map((c) => c.runId), ['run-t'])
      t.eq('and the record keeps the set required', [paused.moduleLocks.held, paused.moduleLocks.released?.modules], [[], ['@c/p']])
      const secondTry = await reclaimRunLocks(paused, { project: 'framework-project', issueId: 'paused', issuePath: pausedPath, dir, persist: async () => {} })
      t.eq('a second resume still has to acquire it, and is refused again', secondTry.conflicts.map((c) => c.runId), ['run-t'])
      await releaseModules({ pool: POOL, held: thief.held, dir })
      const thirdTry = await reclaimRunLocks(paused, { project: 'framework-project', issueId: 'paused', issuePath: pausedPath, dir, persist: async () => {} })
      t.eq('once free, the resume takes it', [thirdTry.conflicts, paused.moduleLocks.held.map((h) => h.module)], [[], ['@c/p']])
      await releaseRunLocks(paused, { dir })

      // auditor-1-010: a continuation of an ENDED run re-takes its locks while run.json still reads blocked
      // (continue, refresh checks or an integrity restore set it to pending only afterwards).
      // The record is written through `persist` exactly as supervisor.answer writes it: the marker comes before the lock.
      const continuation = async ({ name, endedAt, clock }) => {
        const issuePath = path.join(root, 'issues', name)
        const file = path.join(issuePath, 'runs', `run-${name}`, 'run.json')
        await fs.mkdir(path.dirname(file), { recursive: true })
        const record = { runId: `run-${name}`, status: 'blocked', endedAt, startedAt: '2026-01-01T00:00:00Z', moduleLocks: { pool: POOL, held: [], released: { modules: [`@c/${name}`], at: endedAt } } }
        await fs.writeFile(file, JSON.stringify(record))
        const persist = (run) => fs.writeFile(file, JSON.stringify(run))
        const result = await reclaimRunLocks(record, { project: 'framework-project', issueId: name, issuePath, dir, persist, ...(clock ? { clock } : {}) })
        return { record, file, result, persist }
      }
      const stateOf = async (module) => (await readPoolLocks(POOL, { dir })).find((l) => l.module === module)?.state

      // Minute-separated: the run ended a minute before the continuation re-took its module.
      const apart = await continuation({ name: 'apart', endedAt: new Date(Date.now() - 60_000).toISOString() })
      t.eq('the continuation re-takes its module, the marker on the record and the lock', [apart.result.conflicts, apart.record.moduleLocks.held.map((h) => h.module), typeof apart.record.moduleLocks.continuation], [[], ['@c/apart'], 'string'])
      t.eq('while run.json still reads blocked, the fresh lock reads held, not stale', await stateOf('@c/apart'), 'held')
      const racer = await take('run-race', 'instance-b-project', 'issue-race', ['@c/apart'])
      t.eq('another live run cannot take it in that window', [racer.held.length, racer.conflicts[0]?.runId], [0, 'run-apart'])

      // Same tick (the auditor's reproducer): a fixed clock, so the end and the acquisition carry one timestamp.
      const T = Date.parse('2026-11-07T08:00:00.000Z')
      const fixed = { now: () => T, iso: () => new Date(T).toISOString() }
      const tick = await continuation({ name: 'tick', endedAt: fixed.iso(), clock: fixed })
      const lockFileOf = path.join(poolDirectory(POOL, dir), `${sha('@c/tick')}.lock`)
      t.eq('end and acquisition have the same timestamp', JSON.parse(await fs.readFile(lockFileOf, 'utf8')).acquiredAt, JSON.parse(await fs.readFile(tick.file, 'utf8')).endedAt)
      t.eq('the lock reads held', await stateOf('@c/tick'), 'held')
      const sameTick = await take('run-race', 'instance-b-project', 'issue-race', ['@c/tick'])
      t.eq('and another live run\'s take is refused', [sameTick.held.length, sameTick.conflicts[0]?.runId], [0, 'run-tick'])

      // The continuation goes on and the run later really ends: the marker is gone, so its lock is stale.
      endContinuation(tick.record)
      await tick.persist({ ...tick.record, status: 'completed', endedAt: fixed.iso() })
      t.eq('a run that has really ended leaves a stale lock', await stateOf('@c/tick'), 'stale')
      const takenOver = await take('run-race', 'instance-b-project', 'issue-race', ['@c/tick'])
      t.eq('which another run takes over', takenOver.held.map((h) => h.module), ['@c/tick'])
      await releaseModules({ pool: POOL, held: takenOver.held, dir })
      // A continuation that gives its locks back clears its marker, so nothing it held could read as protected.
      await releaseRunLocks(apart.record, { dir })
      t.eq('released, the marker is gone from the record', 'continuation' in apart.record.moduleLocks, false)

      // A dead owner is still taken over even with a matching marker (lock.mjs identity before staleness).
      const gone = await continuation({ name: 'gone', endedAt: new Date(Date.now() - 60_000).toISOString() })
      const deadFile = path.join(poolDirectory(POOL, dir), `${sha('@c/dead2')}.lock`)
      await fs.writeFile(deadFile, JSON.stringify({ purpose: 'module-lock', token: 'x', module: '@c/dead2', issuePath: path.dirname(path.dirname(path.dirname(gone.file))), continuation: gone.record.moduleLocks.continuation, owner: { ...me, pid: 999999, processStartedAt: '1', runId: 'run-gone' } }))
      const overDead = await take('run-race', 'instance-b-project', 'issue-race', ['@c/dead2'])
      t.eq('a dead owner\'s lock is taken over whatever marker it carries', overDead.held.map((h) => h.module), ['@c/dead2'])
      await releaseModules({ pool: POOL, held: overDead.held, dir })
      await releaseRunLocks(gone.record, { dir })
    }

    t.section('waits: a cycle in the waits-for graph is broken by its youngest run, which alone yields')
    {
      const older = await take('run-old', 'instance-a-project', 'issue-old', ['@c/one'])
      const younger = await take('run-young', 'instance-b-project', 'issue-young', ['@c/two'])
      await writeWait(POOL, { runId: 'run-old', project: 'instance-a-project', issueId: 'issue-old', startedAt: '2026-01-01T00:00:00Z', wants: ['@c/two'], holders: [] }, { dir })
      t.eq('one run waiting is no cycle', await yieldsIn(POOL, { runId: 'run-old', startedAt: '2026-01-01T00:00:00Z', wants: ['@c/two'] }, { dir }), false)
      await writeWait(POOL, { runId: 'run-young', project: 'instance-b-project', issueId: 'issue-young', startedAt: '2026-01-02T00:00:00Z', wants: ['@c/one'], holders: [] }, { dir })
      t.eq('the younger run on the cycle yields', await yieldsIn(POOL, { runId: 'run-young', startedAt: '2026-01-02T00:00:00Z', wants: ['@c/one'] }, { dir }), true)
      t.eq('the older run on the same cycle keeps waiting', await yieldsIn(POOL, { runId: 'run-old', startedAt: '2026-01-01T00:00:00Z', wants: ['@c/two'] }, { dir }), false)
      t.eq('wait records name their issue for the ready queue', (await readWaits(POOL, { dir })).map((w) => [w.runId, w.issueId]).sort(), [['run-old', 'issue-old'], ['run-young', 'issue-young']])
      await releaseModules({ pool: POOL, held: younger.held, dir })
      const got = await take('run-old', 'instance-a-project', 'issue-old', ['@c/two'], { already: older.held })
      t.eq('once yielded, the older run takes what it waited for', got.held.map((h) => h.module), ['@c/two'])
      await releaseModules({ pool: POOL, held: [...older.held, ...got.held], dir })
    }

    t.section('reservations: a recorded decision waiting for its set reserves it; it stands by the run lock\'s identity rules and is no wait')
    {
      const me = await currentOwner('ghost')
      // A waiter: an ended run's issue folder, its run.json, and the issue's run lock with the owner given.
      const waiter = async (id, runId, { status = 'blocked', owner, extra = {} } = {}) => {
        const issuePath = path.join(root, 'issues', id)
        await fs.mkdir(path.join(issuePath, 'runs', runId), { recursive: true })
        await fs.writeFile(path.join(issuePath, 'runs', runId, 'run.json'), JSON.stringify({ runId, status, ...extra }))
        if (owner !== null) await fs.writeFile(path.join(issuePath, '.run.lock'), JSON.stringify({ purpose: 'run', token: runId, owner: owner ?? await currentOwner(runId) }))
        const run = { runId, revisions: [], moduleLocks: { pool: POOL, project: 'instance-a-project', issueId: id, held: [], released: { modules: ['@c/r'], at: 'x' } } }
        t.ok(`${id}: the ended run owes what its end gave back`, await oweEnded(run) && run.moduleLocks.owed?.join() === '@c/r' && !run.moduleLocks.released)
        await reserveModules(run, { issuePath, decision: 'resume', dir })
        return { issuePath, run }
      }
      const standing = async (opts) => (await readReservations(POOL, { dir, ...opts })).map((r) => [r.runId, r.state])
      const alive = await waiter('res-alive', 'run-res-alive')
      t.eq('owner alive for this run: it stands, waiting', await standing(), [['run-res-alive', 'waiting']])
      const before = (await readReservations(POOL, { dir }))[0]
      await reserveModules(alive.run, { issuePath: alive.issuePath, decision: 'continue', dir })
      const after = (await readReservations(POOL, { dir }))[0]
      t.eq('written again it keeps its date and decision', [after.since, after.decision, after.modules], [before.since, 'resume', ['@c/r']])
      await dropReservation(POOL, 'run-res-alive', { dir })
      await waiter('res-unknown', 'run-res-unknown', { owner: { ...me, runId: 'run-res-unknown', host: 'another-host.invalid' } })
      t.eq('owner unknown: it stands, never dropped', await standing(), [['run-res-unknown', 'unknown']])
      await dropReservation(POOL, 'run-res-unknown', { dir })
      await waiter('res-dead', 'run-res-dead', { owner: { ...me, runId: 'run-res-dead', pid: 999999, processStartedAt: '1' } })
      t.eq('owner dead: dropped (ignored)', await standing(), [])
      await waiter('res-other', 'run-res-other', { owner: await currentOwner('a-newer-run') })
      t.eq('the run lock names another run: it does not stand', await standing(), [])
      const deleted = await waiter('res-deleted', 'run-res-deleted')
      await fs.rm(path.join(deleted.issuePath, 'runs'), { recursive: true, force: true })
      t.eq('the run is deleted: it does not stand', await standing(), [])
      for (const id of ['res-dead', 'res-other', 'res-deleted']) await dropReservation(POOL, `run-${id}`, { dir })
      await waiter('res-shutdown', 'run-res-shutdown', { status: 'cancelled', owner: null, extra: { stoppedBy: 'service-shutdown' } })
      t.eq('interrupted by a service shutdown: it stands until the next start carries it on', await standing(), [['run-res-shutdown', 'interrupted']])
      t.eq('not when automatic continuation is off', await standing({ resumeAfterShutdown: false }), [])
      const refusedPath = path.join(root, 'issues', 'res-shutdown', 'runs', 'run-res-shutdown', 'run.json')
      await fs.writeFile(refusedPath, JSON.stringify({ runId: 'run-res-shutdown', status: 'cancelled', stoppedBy: 'service-shutdown', autoResumeRefused: { reason: 'x' } }))
      t.eq('nor once that continuation was refused', await standing(), [])
      await fs.writeFile(refusedPath, JSON.stringify({ runId: 'run-res-shutdown', status: 'cancelled', stoppedBy: 'service-shutdown' }))
      const reservations = await readReservations(POOL, { dir })
      const holder = await take('run-holding', 'instance-b-project', 'issue-holding', ['@c/r'])
      const locks = await readPoolLocks(POOL, { dir })
      const reserved = reservedAgainst(reservations, locks, ['@c/r', 'b-modules/free'])
      t.eq('against a start: the waiter, behind the run holding the module now', reserved.map((r) => [r.module, r.runId, r.reserved, r.behind]), [['@c/r', 'run-res-shutdown', true, ['run-holding']]])
      t.ok('the refusal names the waiter in words', /@c\/r is reserved by run run-res-shutdown/.test(lockedMessage(reserved)), lockedMessage(reserved))
      t.eq('a module the reserver holds itself is a lock, not a reservation', reservedAgainst([{ ...reservations[0], runId: 'run-holding' }], locks, ['@c/r']), [])
      await writeWait(POOL, { runId: 'run-w1', project: 'p', issueId: 'w1', startedAt: '2026-01-01T00:00:00Z', wants: ['@c/r'], holders: [] }, { dir })
      t.eq('a reservation is no wait record: the waits-for graph never reads it', (await readWaits(POOL, { dir })).filter((w) => w.runId.startsWith('run-res') || w.runId === 'run-w1').map((w) => w.runId), ['run-w1'])
      t.eq('and closes no cycle', await yieldsIn(POOL, { runId: 'run-w1', startedAt: '2026-01-01T00:00:00Z', wants: ['@c/r'] }, { dir }), false)
      await fs.rm(path.join(poolDirectory(POOL, dir), 'waits', 'run-w1.json'), { force: true })
      await releaseModules({ pool: POOL, held: holder.held, dir })
      await dropReservation(POOL, 'run-res-shutdown', { dir })
      t.eq('dropped by its owner, nothing stands', await standing(), [])
      const stopped = { runId: 'run-stopped', moduleLocks: { pool: POOL, held: [], waiting: { modules: ['@c/r'] }, owed: ['@c/r'], released: { modules: ['@c/q'], at: 'x' } } }
      t.eq('a run stopped while it waited, holding nothing, keeps what it owes and what it released', [await releaseRunLocks(stopped, { dir }), stopped.moduleLocks.owed, stopped.moduleLocks.released.modules], [true, ['@c/r'], ['@c/q']])
    }

    t.section('the ready queue: a start sharing a module waits (blockedBy module-lock), a disjoint one is ready; the release wakes the supervisor')
    {
      const issueRow = (id, modules) => ({ id, name: id, status: 'open', openedAt: '2026-01-01T00:00:00Z', sizing: { affectedModules: modules } })
      const holder = { module: '@c/x', runId: 'run-a', project: 'instance-a-project', issueId: 'issue-a' }
      const issuesByProject = { 'instance-b-project': [issueRow('shared', ['@c/x']), issueRow('disjoint', ['b-modules/n'])] }
      const blocked = await buildReadyQueue({ issuesByProject, state: state(), moduleConflicts: { 'instance-b-project/shared': [holder] } })
      const row = (q, id) => q.rows.find((r) => r.id === id)
      t.eq('the shared issue is blocked by the module lock, until module-lock', [row(blocked, 'shared').state, row(blocked, 'shared').blockedBy?.[0]?.kind, row(blocked, 'shared').blockedBy?.[0]?.until], ['blocked', 'module-lock', { event: 'module-lock', at: null }])
      t.eq('naming the module and its holder', [row(blocked, 'shared').blockedBy[0].modules, row(blocked, 'shared').blockedBy[0].holders[0].runId], [['@c/x'], 'run-a'])
      t.eq('the disjoint issue is ready, offered next', [row(blocked, 'disjoint').state, blocked.next?.id], ['ready', 'disjoint'])
      const freed = await buildReadyQueue({ issuesByProject, state: state() })
      const wake = freedSince(queueObservation(blocked), freed)
      t.eq('the release frees it: capacity-freed with module-lock-released', wake?.freed.map((f) => f.reason), ['module-lock-released'])
      const live = { ...issueRow('waiting', ['@c/x']), latestRun: { runId: 'run-w', status: 'running', live: true } }
      const waiting = await buildReadyQueue({ issuesByProject: { 'instance-b-project': [live] }, state: state(), moduleWaits: { 'instance-b-project/waiting': { runId: 'run-w', wants: ['@c/x'], holders: [holder] } } })
      t.eq('a started run waiting for a module shows it on its running row', [row(waiting, 'waiting').state, row(waiting, 'waiting').blockedBy.map((b) => [b.kind, b.waiting ?? false])], ['running', [['own-run', false], ['module-lock', true]]])
    }

    t.section('the ready queue names a waiter: a reserved holder with since and behind, the waiter\'s own row, an interrupted waiter')
    {
      const issueRow = (id, modules, latestRun = null) => ({ id, name: id, status: 'open', openedAt: '2026-01-01T00:00:00Z', sizing: { affectedModules: modules }, ...(latestRun ? { latestRun } : {}) })
      const row = (q, id) => q.rows.find((r) => r.id === id)
      const waiterHolder = { module: '@c/x', runId: 'run-w', project: 'instance-a-project', issueId: 'waiter', reserved: true, since: '2026-01-02T00:00:00Z', behind: ['run-a'], state: 'waiting' }
      const q = await buildReadyQueue({ issuesByProject: { 'instance-b-project': [issueRow('later', ['@c/x'])] }, state: state(), moduleConflicts: { 'instance-b-project/later': [waiterHolder] } })
      const block = row(q, 'later').blockedBy?.[0]
      t.eq('a later issue sharing the waiter\'s module is blocked, naming the waiter, since when, behind whom', [row(q, 'later').state, block?.kind, block?.holders?.[0]], ['blocked', 'module-lock', waiterHolder])
      const own = await buildReadyQueue({ issuesByProject: { 'instance-a-project': [issueRow('waiter', ['@c/x'], { runId: 'run-w', status: 'running', live: true })] }, state: state(), moduleWaits: { 'instance-a-project/waiter': { runId: 'run-w', wants: ['@c/x'], holders: [{ module: '@c/x', runId: 'run-a' }], since: '2026-01-02T00:00:00Z', decision: 'resume', state: 'waiting' } } })
      const ownBlock = row(own, 'waiter').blockedBy.find((b) => b.kind === 'module-lock')
      t.eq('the waiter\'s own row carries since and its decision', [ownBlock?.waiting, ownBlock?.since, ownBlock?.decision, ownBlock?.holders?.[0]?.runId], [true, '2026-01-02T00:00:00Z', 'resume', 'run-a'])
      const interrupted = await buildReadyQueue({ issuesByProject: { 'instance-a-project': [issueRow('waiter', ['@c/x'], { runId: 'run-w', status: 'cancelled', live: false })] }, state: state(), moduleWaits: { 'instance-a-project/waiter': { runId: 'run-w', wants: ['@c/x'], reserved: ['@c/x'], holders: [], since: '2026-01-02T00:00:00Z', state: 'interrupted' } } })
      t.eq('a waiter a shutdown interrupted shows on its not-live row', [row(interrupted, 'waiter').state, row(interrupted, 'waiter').blockedBy?.map((b) => [b.kind, b.interrupted ?? false, b.since])], ['decide', [['module-lock', true, '2026-01-02T00:00:00Z']]])
    }

    t.section('readiness (and so a preview) shows the difference between a disjoint and a shared issue (AC11 on fixtures)')
    {
      const held = await take('run-a', 'instance-a-project', 'issue-a', ['@c/x'])
      const reading = async (expected) => {
        const locks = await readPoolLocks(POOL, { dir })
        return { pool: POOL, members: [POOL, 'instance-a-project', 'instance-b-project'], held: locks, expected: { modules: expected, source: 'sizing' }, conflicts: conflictsWith(locks, expected, { project: 'instance-b-project', issueId: 'b' }) }
      }
      const inspect = async () => ({ head: 'h', key: 'k' })
      const resolve = async () => ({ ok: true, resolved: { configHash: 'c', workspace: {}, completion: { delivery: { action: 'worktree-diff' } }, phases: [{ id: 'implement', step: { id: 'implement', recordsRevision: true } }] } })
      const read = (expected) => launchReadiness({ project: 'instance-b-project', issueId: 'b', projectPath: root, playbook: 'implementation', resolve, inspectLaunch: inspect, inspect: async () => null, moduleLocks: () => reading(expected) })
      const disjoint = await read(['b-modules/n'])
      const shared = await read(['@c/x', 'b-modules/n'])
      t.eq('disjoint: moduleLocks shows the pool\'s lock and no conflict; the configuration is ready', [disjoint.moduleLocks.held.map((l) => l.module), disjoint.moduleLocks.conflicts, disjoint.configuration.ready], [['@c/x'], [], true])
      t.eq('shared: the conflict names the holder, and the configuration has a module-lock prerequisite', [shared.moduleLocks.conflicts.map((c) => [c.module, c.runId]), shared.configuration.ready, shared.configuration.prerequisites.map((p) => p.condition)], [[['@c/x', 'run-a']], false, ['module-lock']])
      t.eq('a baseline reading (no playbook) is unaffected: occupancy is not a repository fault', shared.baselineReady, true)
      await releaseModules({ pool: POOL, held: held.held, dir })
    }

    t.section('the supervisor runs up to 3 issues at once by default')
    {
      const models = async () => [{ id: 'test-model', title: 'Test model', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
      const adapter = { invoke: async (args) => ({ session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } }) }
      const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [], listIssues: async () => [], stop: async () => {} }
      const agent = await createTopSupervisor({ dir: path.join(root, 'supervisor'), models, adapter, tools, pollMs: 20 })
      try {
        await agent.start({ model: 'test-model', projects: ['p'], message: 'go' })
        t.eq('maxConcurrent defaults to 3', agent.get().limits?.maxConcurrent, 3)
      } finally { await agent.stop().catch(() => {}) }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
