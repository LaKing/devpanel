import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { issuesRoot } from '../project-path.mjs'
import { systemClock } from './clock.mjs'
import { acquire, LockHeld, ownerLiveness } from './lock.mjs'
import { hostPlatform } from './platform.mjs'

/*
 * Module locks (execution-contract.md "Module locks"): one lock file per module of a
 * pool (module-pool.mjs), under <issues>/.module-locks/<pool>/ (DEVPANEL_MODULE_LOCKS_DIR
 * elsewhere: the test runner). A lock carries runtime/lock.mjs owner identity, so a dead
 * owner's lock is taken over and an unknown owner's never; one whose run has ended
 * (its run.json no longer live) is stale and taken over too. A paused run holds none:
 * it gives its set up when the pause is recorded and owes it (`yieldForPause`).
 *
 * A set is taken all or nothing and never waited for while holding part of it. A run
 * that needs more while it holds some waits with a wait record beside the locks; a
 * cycle in the waits-for graph is broken by its youngest run, which gives up what it
 * holds and takes its whole set again (`yieldsIn`).
 */

const LIVE = ['preflighting', 'pending', 'running', 'stopping', 'paused']
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)

export const locksRoot = (dir = null) => dir ?? process.env.DEVPANEL_MODULE_LOCKS_DIR ?? path.join(issuesRoot(), '.module-locks')
export const poolDirectory = (pool, dir = null) => path.join(locksRoot(dir), sha(pool))
const lockFile = (pool, module, dir) => path.join(poolDirectory(pool, dir), `${sha(module)}.lock`)
const waitFile = (pool, runId, dir) => path.join(poolDirectory(pool, dir), 'waits', `${runId}.json`)

const normalize = (modules) => [...new Set((modules ?? []).filter((m) => typeof m === 'string' && m.length).map((m) => m.replace(/\/+$/, '')))].sort()

/** Whether the run a lock names has ended: only a run.json read and found not live says so. */
async function runEnded (held) {
  if (!held?.issuePath || !held?.owner?.runId) return false
  try {
    const run = JSON.parse(await fs.readFile(path.join(held.issuePath, 'runs', held.owner.runId, 'run.json'), 'utf8'))
    if (LIVE.includes(run.status)) return false
    // A continuation re-taking an ended run's locks (supervisor.answer, before continue, refresh or an
    // integrity restore moves the status back to pending) first writes its marker on the run record, and
    // each lock carries it: a lock matching the record's marker is that continuation's, held while its
    // owner lives. The marker goes when the continuation proceeds or gives its locks back.
    if (held.continuation && run.moduleLocks?.continuation === held.continuation) return false
    return true
  } catch (error) {
    return false   // absent: a run still being reserved; unreadable: not known to have ended
  }
}

const readJson = (file) => fs.readFile(file, 'utf8').then((t) => JSON.parse(t), () => null)

/**
 * Take every module of `modules` for the run, or none: `{ held: [{module, token}], conflicts }`.
 * A conflict names the holder (`{module, runId, project, issueId, liveness}`); what was taken
 * before it is released. Modules this run already holds are skipped.
 */
export async function takeModules ({ pool, modules, runId, project, issueId, issuePath, startedAt = null, already = [], continuation = null, dir = null, clock = systemClock, platform = hostPlatform() }) {
  const mine = new Set(already.map((h) => h.module))
  const wanted = normalize(modules).filter((m) => !mine.has(m))
  const held = []
  for (const module of wanted) {
    try {
      const lock = await acquire(lockFile(pool, module, dir), {
        purpose: 'module-lock', runId, clock, platform, stale: runEnded,
        detail: { pool, module, project, issueId, issuePath, startedAt, ...(continuation ? { continuation } : {}) }
      })
      held.push({ module, token: lock.token })
    } catch (error) {
      await releaseModules({ pool, held, dir })
      if (!(error instanceof LockHeld)) throw error
      const record = await readJson(error.file)
      return { held: [], conflicts: [{ module, runId: record?.owner?.runId ?? error.owner?.runId ?? null, project: record?.project ?? null, issueId: record?.issueId ?? null, liveness: error.liveness }] }
    }
  }
  return { held, conflicts: [] }
}

/** Remove the run's locks by their tokens: a lock taken over since is someone else's and stays. */
export async function releaseModules ({ pool, held, dir = null }) {
  let released = 0
  for (const { module, token } of held ?? []) {
    const file = lockFile(pool, module, dir)
    const record = await readJson(file)
    if (record?.token !== token) continue
    await fs.rm(file, { force: true })
    released++
  }
  return released
}

/** Every lock of a pool as it reads now, with `state` held | dead | stale | unknown. */
export async function readPoolLocks (pool, { dir = null, platform = hostPlatform() } = {}) {
  const directory = poolDirectory(pool, dir)
  const names = await fs.readdir(directory).catch(() => [])
  const waits = await readWaits(pool, { dir })
  const out = []
  for (const name of names.filter((n) => n.endsWith('.lock'))) {
    const record = await readJson(path.join(directory, name))
    if (!record?.module) continue
    let state = await ownerLiveness(record.owner, { platform })
    if (state === 'alive') state = await runEnded(record) ? 'stale' : 'held'
    const runId = record.owner?.runId ?? null
    out.push({ module: record.module, project: record.project ?? null, issueId: record.issueId ?? null, runId, since: record.acquiredAt ?? null, state,
      ...(waits.some((w) => w.runId === runId) ? { waiting: true } : {}) })
  }
  return out.sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0)
}

/** Locks that stand in the way of `modules`: held or unknown, and not the caller's own issue or run. */
export function conflictsWith (locks, modules, { runId = null, project = null, issueId = null } = {}) {
  const wanted = new Set(normalize(modules))
  return locks.filter((l) => wanted.has(l.module) && ['held', 'unknown'].includes(l.state) && l.runId !== runId && !(project && l.project === project && l.issueId === issueId))
}

export async function writeWait (pool, { runId, project = null, issueId = null, startedAt, wants, holders }, { dir = null, clock = systemClock } = {}) {
  const file = waitFile(pool, runId, dir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify({ runId, project, issueId, startedAt, wants: normalize(wants), holders, since: clock.iso() }))
  await fs.rename(temp, file)
}

export const clearWait = (pool, runId, { dir = null } = {}) => fs.rm(waitFile(pool, runId, dir), { force: true })

/** The runs of a pool waiting for a module now: `[{runId, project, issueId, wants, holders, since}]`. */
export async function readWaits (pool, { dir = null } = {}) {
  const directory = path.join(poolDirectory(pool, dir), 'waits')
  const names = await fs.readdir(directory).catch(() => [])
  return (await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(directory, n))))).filter(Boolean)
}

const older = (a, b) => (a.startedAt ?? '') < (b.startedAt ?? '') || ((a.startedAt ?? '') === (b.startedAt ?? '') && a.runId < b.runId)

/**
 * Whether `runId`, waiting for `wants`, must yield: true when the waits-for graph (a wanted
 * module's holder, that holder's own wait record, its wants…) leads back to `runId` and
 * `runId` is the youngest run on that cycle. Every run on the cycle reads the same records,
 * so all agree on the one that yields; the others keep waiting.
 */
export async function yieldsIn (pool, { runId, startedAt, wants }, { dir = null, platform = hostPlatform() } = {}) {
  const locks = await readPoolLocks(pool, { dir, platform })
  const waits = new Map((await readWaits(pool, { dir })).map((w) => [w.runId, w]))
  waits.set(runId, { runId, startedAt, wants: normalize(wants) })
  const holderOf = new Map(locks.filter((l) => l.state === 'held').map((l) => [l.module, l.runId]))
  const path_ = []
  const seen = new Set()
  const walk = (current) => {
    if (current === runId && path_.length) return true
    if (seen.has(current)) return false
    seen.add(current)
    const wait = waits.get(current)
    if (!wait) return false
    for (const module of wait.wants ?? []) {
      const holder = holderOf.get(module)
      if (!holder || holder === current) continue
      path_.push(holder)
      if (walk(holder)) return true
      path_.pop()
    }
    return false
  }
  if (!walk(runId)) return false
  const members = path_.map((id) => waits.get(id)).filter(Boolean)
  return members.every((m) => m.runId === runId || older(m, { runId, startedAt }))
}

const stepsOf = (phase) => (phase.loop ? phase.loop.steps : [phase.step])

/** Whether runs of this resolved playbook lock modules: those that record revisions (coding playbooks). */
export const locksModules = (resolved) => (resolved?.phases ?? []).some((phase) => stepsOf(phase).some((step) => step?.recordsRevision === true))

/** In words, who holds what a start or resume wanted. */
export const lockedMessage = (conflicts) => conflicts.map((c) => `module ${c.module} is locked by run ${c.runId ?? '(unknown)'}${c.project ? ` of ${c.project}/${c.issueId}` : ''}${c.liveness === 'unknown' || c.state === 'unknown' ? ' (its owner is unknown, so it is not taken over)' : ''}`).join('; ') + ': this start shares a module with that run, so it waits until the run ends'

/** Give up every lock of an ended run and its wait record; true when anything was held. */
export async function releaseRunLocks (run, { dir = null, clock = systemClock } = {}) {
  const locks = run?.moduleLocks
  if (!locks?.pool) return false
  const modules = (locks.held ?? []).map((h) => h.module)
  await releaseModules({ pool: locks.pool, held: locks.held, dir })
  await clearWait(locks.pool, run.runId, { dir }).catch(() => {})
  if (!modules.length && !locks.waiting) return false
  locks.released = { modules, at: clock.iso() }
  locks.held = []
  locks.waiting = null
  delete locks.continuation
  return true
}

/**
 * A paused run gives up every lock it holds: it waits for a person and does nothing meanwhile, so
 * its modules must not stand in other runs' way. What it gave up is owed (`run.moduleLocks.owed`,
 * and `released` with `reason: paused`): the engine takes the set again before anything goes on
 * after the pause, waiting while another run holds part of it (engine.takePendingModules), so
 * whoever answers the run is never refused for a lock. True when the record changed; a run that
 * already holds nothing is left as it is, so a second call rewrites no date.
 */
export async function yieldForPause (run, { dir = null, clock = systemClock } = {}) {
  const locks = run?.moduleLocks
  if (!locks?.pool) return false
  const given = (locks.held ?? []).map((h) => h.module)
  if (!given.length && !locks.waiting) return false
  await releaseModules({ pool: locks.pool, held: locks.held, dir })
  await clearWait(locks.pool, run.runId, { dir }).catch(() => {})
  locks.held = []
  locks.waiting = null
  delete locks.continuation
  const owed = normalize([...given, ...(locks.owed ?? [])])
  if (owed.length) {
    locks.owed = owed
    locks.released = { modules: owed, at: clock.iso(), reason: 'paused' }
  }
  return true
}

/** The continuation went on: its locks now stand for a live run, and the marker is no longer needed. */
export const endContinuation = (run) => { if (run?.moduleLocks) delete run.moduleLocks.continuation }

/**
 * A resumed run takes its recorded locks again under this process's identity (a restart
 * made the earlier owner dead): its own are given back and the set taken as one. A conflict
 * means another run took a module meanwhile; the resume is refused naming it.
 */
export async function reclaimRunLocks (run, { issueId, project, issuePath, persist, dir = null, clock = systemClock, platform = hostPlatform() }) {
  const locks = run?.moduleLocks
  if (!locks?.pool) return { conflicts: [] }
  const modules = [...new Set([...(locks.held ?? []).map((h) => h.module), ...(locks.released?.modules ?? [])])]
  if (!modules.length) return { conflicts: [] }
  // The marker is on the record before any lock is taken, so no reader can see one of this
  // continuation's locks beside a record that does not name it (runEnded).
  locks.continuation = crypto.randomUUID()
  await persist(run)
  await releaseModules({ pool: locks.pool, held: locks.held, dir })
  locks.held = []
  const got = await takeModules({ pool: locks.pool, modules, runId: run.runId, project, issueId, issuePath, startedAt: run.startedAt, continuation: locks.continuation, dir, clock, platform })
  if (got.conflicts.length) {
    // Refused: the set stays required on the record, so the next resume must take it again.
    locks.released = { modules: modules.sort(), at: clock.iso(), reason: 'reclaim-refused', holders: got.conflicts }
    delete locks.continuation
    await persist(run)
    return { conflicts: got.conflicts }
  }
  locks.held = got.held
  delete locks.released
  return { conflicts: [] }
}
