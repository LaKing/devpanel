import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { clearWait, poolDirectory, readPoolLocks, readWaits, releaseModules, releaseRunLocks, takeModules, writeWait } from '../server/runtime/module-locks.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

export const name = 'engine — a module-lock wait is recorded when it begins and when what it waits for changes, not at every poll'

const POOL = 'module-lock-wait-pool'
const until = async (test, label = 'condition') => { const end = Date.now() + 5000; while (!(await test())) { if (Date.now() > end) throw Error(`Timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 5)) } }
const waitFile = (runId) => path.join(poolDirectory(POOL), 'waits', `${runId}.json`)
const readWait = (runId) => fs.readFile(waitFile(runId), 'utf8').then((t) => JSON.parse(t), () => null)

/**
 * Let the waiting run poll at least `polls` more times. The manual clock is moved on between
 * samples, so every rewrite of the run's wait file (one per poll) carries a `since` of its own.
 */
async function letPoll (f, runId, polls) {
  const seen = new Set()
  await until(async () => {
    f.clock.advance(1000)
    const wait = await readWait(runId)
    if (wait?.since) seen.add(wait.since)
    return seen.size > polls
  }, `${polls} polls`)
  return seen.size
}

const ofType = (events, type) => events.filter((e) => e.type === type)

export default async function (t) {
  const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({}) })
  const engine = await startRun({
    playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses,
    stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
  })
  engine.moduleLockPollMs = 10
  const events = async () => (await readEvents(f.issuePath, engine.runId)).events
  const other = (runId, modules, startedAt = '2026-01-01T00:00:00Z') => takeModules({ pool: POOL, modules, runId, project: 'instance-project', issueId: `${runId}-issue`, issuePath: null, startedAt })

  t.section('a wait of many polls whose modules and holders stay the same is one event')
  const a = await other('run-a', ['@c/a'])
  const b = await other('run-b', ['@c/b'])
  // As the drive loop leaves it: the revision's modules not yet held.
  engine.run.moduleLocks = { pool: POOL, project: 'devpanel-project', issueId: f.issue.id, held: [], waiting: null }
  const record = { fingerprint: 'sha256:module-lock-wait', moduleLocks: { pending: ['@c/a'] } }
  engine.run.revisions = [record]
  const before = (await events()).length
  const holding = engine.holdRevisionModules()
  await until(() => engine.run.moduleLocks.waiting, 'the wait')
  const since = engine.run.moduleLocks.waiting.since
  t.eq('the wait is excused from the wall clock while it lasts', engine.openDriveWaits.size, 1)
  const polls = await letPoll(f, engine.runId, 5)
  t.ok('the run polled several times (its wait file rewritten each time)', polls > 5, String(polls))
  let wait = ofType((await events()).slice(before), 'module-lock-wait')
  t.eq('one module-lock-wait event, naming the modules and the holder', wait.map((e) => [e.modules, e.holders.map((h) => h.runId)]), [[['@c/a'], ['run-a']]])
  t.eq('the run record still says what it waits for, since its beginning', [engine.run.moduleLocks.waiting.modules, engine.run.moduleLocks.waiting.holders.map((h) => h.runId), engine.run.moduleLocks.waiting.since], [['@c/a'], ['run-a'], since])
  const onDisk = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
  t.eq('and so does run.json', [onDisk.moduleLocks.waiting.modules, onDisk.moduleLocks.waiting.since], [['@c/a'], since])
  t.eq('other runs read the wait record as before', (await readWaits(POOL)).map((w) => [w.runId, w.wants, w.holders.map((h) => h.runId)]), [[engine.runId, ['@c/a'], ['run-a']]])
  t.eq('the pool shows the holder and that this run waits', (await readPoolLocks(POOL)).map((l) => [l.module, l.runId, l.state]), [['@c/a', 'run-a', 'held'], ['@c/b', 'run-b', 'held']])

  t.section('a change of the modules wanted is recorded again, once')
  record.moduleLocks.pending = ['@c/a', '@c/b']
  await letPoll(f, engine.runId, 4)
  wait = ofType((await events()).slice(before), 'module-lock-wait')
  t.eq('a second event names the new set; the holder is the same', wait.map((e) => [e.modules, e.holders.map((h) => h.runId)]), [[['@c/a'], ['run-a']], [['@c/a', '@c/b'], ['run-a']]])

  t.section('a change of the holders is recorded again, once')
  await releaseModules({ pool: POOL, held: a.held })
  await letPoll(f, engine.runId, 4)
  wait = ofType((await events()).slice(before), 'module-lock-wait')
  t.eq('a third event names the new holder', wait.map((e) => [e.modules, e.holders.map((h) => [h.module, h.runId])]), [
    [['@c/a'], [['@c/a', 'run-a']]], [['@c/a', '@c/b'], [['@c/a', 'run-a']]], [['@c/a', '@c/b'], [['@c/b', 'run-b']]]])
  t.eq('the wait is still the one that began first', engine.run.moduleLocks.waiting.since, since)

  t.section('once free, the set is taken and the wait recorded as before')
  await releaseModules({ pool: POOL, held: b.held })
  t.eq('the wait ends with the modules', await holding, true)
  const all = (await events()).slice(before)
  t.eq('events of the whole wait: three waits, then the locks taken', all.filter((e) => e.type.startsWith('module-lock')).map((e) => e.type), ['module-lock-wait', 'module-lock-wait', 'module-lock-wait', 'module-locks-taken'])
  t.eq('the run holds its set and waits for nothing', [engine.run.moduleLocks.held.map((h) => h.module).sort(), engine.run.moduleLocks.waiting, engine.openDriveWaits.size], [['@c/a', '@c/b'], null, 0])
  t.eq('one wait on the record, from its beginning, excused from the wall clock', engine.run.moduleLockWaits?.map((w) => [w.from, w.modules]), [[since, ['@c/a', '@c/b']]])
  t.eq('the revision records what it added and when it began waiting', [record.moduleLocks.added, record.moduleLocks.waitedFrom], [['@c/a', '@c/b'], since])
  t.eq('the wait record is gone', await readWaits(POOL), [])

  t.section('a cycle that forms after the first poll still makes the youngest run yield')
  const c = await other('run-c', ['@c/c'])
  record.moduleLocks = { pending: ['@c/c'] }
  const mark = (await events()).length
  const yielding = engine.holdRevisionModules()
  await until(() => engine.run.moduleLocks.waiting, 'the second wait')
  await letPoll(f, engine.runId, 3)
  t.eq('no cycle yet: the run waits holding its set', [engine.run.moduleLocks.held.map((h) => h.module).sort(), ofType((await events()).slice(mark), 'module-lock-yield').length], [['@c/a', '@c/b'], 0])
  // The older run-c now wants a module this run holds: the waits-for graph closes.
  await writeWait(POOL, { runId: 'run-c', project: 'instance-project', issueId: 'run-c-issue', startedAt: '2026-01-01T00:00:00Z', wants: ['@c/a'], holders: [{ module: '@c/a', runId: engine.runId }] })
  await until(async () => ofType((await events()).slice(mark), 'module-lock-yield').length > 0, 'the yield')
  t.eq('this run, the younger, gave up what it held', [engine.run.moduleLocks.held, engine.run.moduleLocks.yielded?.at(-1)?.modules, engine.run.moduleLocks.yielded?.at(-1)?.to], [[], ['@c/a', '@c/b'], ['run-c']])
  t.eq('and waits for its whole set again, holding nothing', record.moduleLocks.pending, ['@c/a', '@c/b', '@c/c'])
  await letPoll(f, engine.runId, 3)
  // run-c stops waiting and ends.
  await clearWait(POOL, 'run-c')
  await releaseModules({ pool: POOL, held: c.held })
  t.eq('the run takes its whole set', await yielding, true)
  const cycle = (await events()).slice(mark).filter((e) => e.type.startsWith('module-lock'))
  t.eq('events: the wait, one yield, the wait for the whole set (once), the locks taken', cycle.map((e) => [e.type, e.modules]), [
    ['module-lock-wait', ['@c/c']], ['module-lock-yield', ['@c/a', '@c/b']], ['module-lock-wait', ['@c/a', '@c/b', '@c/c']], ['module-locks-taken', ['@c/a', '@c/b', '@c/c']]])
  t.eq('holding everything, the yield on the revision', [engine.run.moduleLocks.held.map((h) => h.module).sort(), record.moduleLocks.yielded], [['@c/a', '@c/b', '@c/c'], ['@c/a', '@c/b']])
  t.eq('two waits on the record', engine.run.moduleLockWaits.length, 2)

  t.section('a wait stopped by a cancel is recorded as before')
  const d = await other('run-d', ['@c/d'])
  record.moduleLocks = { pending: ['@c/d'] }
  const stopMark = (await events()).length
  const stopping = engine.holdRevisionModules()
  await until(() => engine.run.moduleLocks.waiting, 'the third wait')
  await letPoll(f, engine.runId, 3)
  engine.cancel('test')
  t.eq('false when stopped while waiting', await stopping, false)
  t.eq('one wait event, then the stop', (await events()).slice(stopMark).filter((e) => e.type.startsWith('module-lock')).map((e) => e.type), ['module-lock-wait', 'module-lock-wait-stopped'])
  t.eq('nothing left waiting', [engine.run.moduleLocks.waiting, engine.openDriveWaits.size, await readWaits(POOL)], [null, 0, []])

  await releaseModules({ pool: POOL, held: d.held })
  await releaseRunLocks(engine.run)
  t.eq('the pool is empty again', await readPoolLocks(POOL), [])
  await releaseWorkspace(engine).catch(() => {})
}
