import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './clock.mjs'
import { slotDirectory } from './drive-slots.mjs'
import { acquire, LockHeld, ownerLiveness } from './lock.mjs'
import { LOCAL_HOST, runOnHost } from './stage-instances.mjs'

/*
 * The dependency syncs this panel's runs have standing on staging hosts
 * (dependency-sync.mjs): one record per owner, `sync-<owner>.json` beside the instance
 * slots of its host, saying which run it belongs to, which manifests make the stage
 * deviate from its deployed set (`files`), what it is doing (`state`: syncing,
 * installed, revert-failed), which other instances stood on the host when it began
 * (`stopped`) and how to revert it. The record stays from before the sync command runs
 * until the revert succeeded. Every other run, and the supervisor (readiness
 * `stagingSyncs`), reads it through `standingSyncs`.
 *
 * A stage holds one dependency set, and a sync or a revert stops every instance on it.
 * So the sync is the drive's alone: the drive that synced reverts it as it ends
 * (checks.mjs, `revertOwnSync`), and the base is back on its deployed set before
 * another run creates an instance. Each sync and revert is also a line of the host's
 * journal (`syncs.jsonl`, `stageEvents`): a drive compares the journal's length at its
 * start with what came after, and so learns that another run's sync stopped or
 * invalidated its instance (`foreignEvents`).
 *
 * What becomes of a sync still standing outside a drive (its revert failed, or its
 * process died) is read off its run (`syncDisposition`):
 *   revert  every end, a pause, and a run that is gone
 *   live    the run is still driving; only its owner's death makes that a revert
 *
 * The lock beside the record (lock.mjs identity) is held by the process that synced,
 * until it settles the record. It keeps another process's sweep from reverting under a
 * live run, and it is what another run waits on (`awaitForeignSyncs`); a record nobody
 * holds is judged by its run alone.
 */

const REVERT_TIMEOUT_SECONDS = 1800
const FOREIGN_WAIT_MS = 3_600_000
const POLL_MS = 1_000
const LIVE = ['preflighting', 'pending', 'running', 'stopping']
// The journal's events that stop every instance on the stage.
const STOPPING = ['sync', 'revert']

// owner -> lock: what this process holds.
const held = new Map()

const recordFile = (dir, owner) => path.join(dir, `sync-${owner}.json`)
const lockFile = (dir, owner) => path.join(dir, `sync-${owner}.lock`)
const journalFile = (dir) => path.join(dir, 'syncs.jsonl')
// The instance slots' records beside these are rewritten in place (stage-instances.mjs): one caught mid-write reads as absent.
const readJson = (file) => fs.readFile(file, 'utf8').then((text) => JSON.parse(text)).catch(() => null)

/** A record is published whole: written beside, then renamed over, so a reader sees the previous or the new one, never a part. */
async function writeRecord (file, record) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(record, null, 2))
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
const aborted = () => Object.assign(new Error('cancelled while waiting for another run\'s dependency sync'), { name: 'AbortError' })

async function take (dir, owner, runId, clock) {
  if (held.has(owner)) return held.get(owner)
  try {
    return await acquire(lockFile(dir, owner), { purpose: 'dependency-sync', runId, clock })
  } catch (error) {
    if (!(error instanceof LockHeld)) throw error
    return null
  }
}

async function letGo (owner, lock) {
  held.delete(owner)
  await lock.release().catch(() => {})
}

/** Whether a live process holds the owner's record: this one, or another whose lock stands. Taking a free lock to find out releases it at once. */
async function isHeld (dir, owner) {
  if (held.has(owner)) return true
  try {
    const lock = await acquire(lockFile(dir, owner), { purpose: 'dependency-sync-probe' })
    await lock.release().catch(() => {})
    return false
  } catch (error) {
    if (error instanceof LockHeld) return true
    throw error
  }
}

async function journal (dir, entry) {
  await fs.appendFile(journalFile(dir), JSON.stringify(entry) + '\n').catch(() => {})
}

async function journalLines (dir) {
  const text = await fs.readFile(journalFile(dir), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean)
}

/** The host journal's length now: a drive's mark, compared with what comes after it. */
export async function stageMark (host, slotsDir = null) {
  return (await journalLines(slotDirectory(host, slotsDir))).length
}

/** The host journal's events from position `from` on, each with its `seq`. */
export async function stageEvents (host, { from = 0, slotsDir = null } = {}) {
  return (await journalLines(slotDirectory(host, slotsDir))).slice(from).map((line, i) => {
    try { return { seq: from + i, ...JSON.parse(line) } } catch { return null }
  }).filter(Boolean)
}

/** Of a journal's events, the ones by another owner that stop every instance on the stage, as a run is told of them. */
export const foreignEvents = (events, owner) => events.filter((e) => e.owner !== owner && STOPPING.includes(e.event))
  .map((e) => ({ event: e.event, owner: e.owner, runId: e.runId ?? null, files: e.files ?? [], at: e.at }))

/** Whether this process holds a sync record of that owner: the drive that synced owes its revert. */
export const holdsSync = (owner) => held.has(owner)

/**
 * A sync is about to run: its record is written first. Returns whether a record of this
 * owner stood already (an earlier revision's sync, which a refused one leaves standing).
 * Throws when another live process holds the owner's record.
 */
export async function noteSync ({ owner, host, kind, ssh = null, runId = null, runDir = null, revert, files, clock = systemClock, slotsDir = null }) {
  const dir = slotDirectory(host, slotsDir)
  await fs.mkdir(dir, { recursive: true })
  const lock = await take(dir, owner, runId, clock)
  if (!lock) throw new Error(`another process holds the dependency sync record of ${owner} on ${host}; nothing was installed`)
  held.set(owner, lock)
  const file = recordFile(dir, owner)
  const before = await readJson(file)
  // The instances on record on this host: the stage stops every one of them for the sync.
  const stopped = []
  for (const name of (await fs.readdir(dir).catch(() => [])).filter((n) => /^instance-\d+\.json$/.test(n)).sort()) {
    const slot = await readJson(path.join(dir, name))
    if (slot?.name && slot.name !== owner) stopped.push({ name: slot.name, runId: slot.runId ?? null })
  }
  const record = { owner, runId, runDir, kind, ssh, host, state: 'syncing', revert: { run: revert.run, ...(revert.timeoutSeconds ? { timeoutSeconds: revert.timeoutSeconds } : {}) }, files: [...new Set([...(before?.files ?? []), ...files])].sort(), stopped, notedAt: before?.notedAt ?? clock.iso(), ...(before?.syncedAt ? { syncedAt: before.syncedAt } : {}) }
  await writeRecord(file, record)
  await journal(dir, { at: clock.iso(), event: 'sync', owner, runId, files, stopped })
  return Boolean(before)
}

/** The sync command answered. A record made for a sync that installed nothing goes; one that stood before stays. */
export async function settleSync (owner, { host, installed, prior, clock = systemClock, slotsDir = null }) {
  const lock = held.get(owner)
  if (!lock) return
  const dir = slotDirectory(host, slotsDir)
  const file = recordFile(dir, owner)
  const record = await readJson(file)
  await journal(dir, { at: clock.iso(), event: installed ? 'synced' : 'sync-not-installed', owner, runId: record?.runId ?? null, files: record?.files ?? [] })
  if (installed) {
    if (record) await writeRecord(file, { ...record, state: 'installed', syncedAt: clock.iso() }).catch(() => {})
    return
  }
  if (prior) {
    if (record) await writeRecord(file, { ...record, state: record.syncedAt ? 'installed' : 'syncing' }).catch(() => {})
    return
  }
  await fs.rm(file, { force: true })
  await letGo(owner, lock)
}

/** What becomes of a run's standing syncs, from its record (null: the run is gone). */
export function syncDisposition (run) {
  return run && LIVE.includes(run.status) ? 'live' : 'revert'
}

/** A record at the panel's start: as its run reads now, and a live status counts only while the run's lock has an owner that is not dead. */
async function atStart (record) {
  const run = record.runDir ? await readJson(path.join(record.runDir, 'run.json')) : null
  const how = syncDisposition(run)
  if (how !== 'live') return how
  const lock = await readJson(path.join(path.dirname(path.dirname(record.runDir)), '.run.lock'))
  if (lock?.owner?.runId !== record.runId) return 'revert'
  return await ownerLiveness(lock.owner) === 'dead' ? 'revert' : 'keep'
}

async function settle (dir, owner, { how, reason, clock, runId = null }) {
  const lock = await take(dir, owner, runId, clock)
  if (!lock) return null
  const file = recordFile(dir, owner)
  try {
    const record = await readJson(file)
    if (!record) return null
    const verdict = typeof how === 'function' ? await how(record) : how
    const said = { owner, host: record.host, runId: record.runId ?? null, files: record.files, reason, at: clock.iso() }
    if (verdict !== 'revert') return null
    await journal(dir, { at: clock.iso(), event: 'revert', owner, runId: record.runId ?? null, files: record.files, reason })
    const outcome = await runOnHost(record, record.revert.run, { timeoutSeconds: record.revert.timeoutSeconds ?? REVERT_TIMEOUT_SECONDS })
    await journal(dir, { at: clock.iso(), event: outcome.passed ? 'reverted' : 'revert-failed', owner, runId: record.runId ?? null, files: record.files, reason })
    if (outcome.passed) await fs.rm(file, { force: true })
    else await writeRecord(file, { ...record, state: 'revert-failed', revertFailed: { at: clock.iso(), reason, error: outcome.error } }).catch(() => {})
    return { ...said, ...outcome }
  } finally { await letGo(owner, lock) }
}

async function each ({ runId = null, slotsDir = null }, fn) {
  const root = path.dirname(slotDirectory(LOCAL_HOST, slotsDir))
  const out = []
  for (const host of await fs.readdir(root).catch(() => [])) {
    const dir = path.join(root, host)
    for (const name of (await fs.readdir(dir).catch(() => [])).filter((n) => /^sync-.+\.json$/.test(n)).sort()) {
      const record = await readJson(path.join(dir, name))
      if (!record?.owner || (runId && record.runId !== runId)) continue
      const done = await fn(dir, record.owner, record)
      if (done) out.push(done)
    }
  }
  return out
}

/** The drive that synced ends: its sync is reverted now, so the stage is back on its deployed set. Null when this process holds none of that owner. */
export async function revertOwnSync (owner, { host, reason = 'drive-ended', clock = systemClock, slotsDir = null }) {
  if (!held.has(owner)) return null
  return settle(slotDirectory(host, slotsDir), owner, { how: 'revert', reason, clock })
}

/**
 * A run stopped driving: whatever sync of it still stands (a revert that failed, a drive
 * cut short by the process) is reverted. A revert that fails leaves the record, and the
 * next call for the run (its deletion, the panel's start) tries again. A run with none
 * costs a directory listing.
 */
export const settleRunSyncs = (runId, { how = 'revert', reason, clock = systemClock, slotsDir = null }) => each({ runId, slotsDir }, (dir, owner) => settle(dir, owner, { how, reason, clock, runId }))

/** At the panel's start: every record nobody live holds, judged by its run (atStart). */
export const sweepSyncs = ({ clock = systemClock, slotsDir = null } = {}) => each({ slotsDir }, (dir, owner) => held.has(owner) ? null : settle(dir, owner, { how: atStart, reason: 'owner-gone', clock }))

/**
 * Every sync standing on a staging host, as other runs and the supervisor read it:
 * the record (owner, run, host, deviating manifests, state, when, the instances it
 * stopped) and `held`, whether a live process still answers for it. Read-only.
 */
export const standingSyncs = ({ host = null, slotsDir = null } = {}) => each({ slotsDir }, async (dir, owner, record) => {
  if (host && record.host !== host) return null
  const { revert, ssh, ...rest } = record
  return { ...rest, held: await isHeld(dir, owner) }
})

/** What a run is told about another run's sync, in one line. */
export const syncWords = (s) => `run ${s.runId ?? 'unknown'} (${s.owner}) ${s.state === 'revert-failed' ? `could not revert the dependencies it installed (${s.revertFailed?.error ?? 'no reason recorded'})` : s.state === 'syncing' ? 'is installing its dependencies' : 'has its dependencies installed'} on ${s.host}: ${(s.files ?? []).join(', ') || 'no manifest named'}`

/**
 * A drive whose create the stage refused while another run's sync stands on the host:
 * it waits while a live process answers for such a sync (the drive that synced reverts
 * it as it ends), told to `onWait` as a wait the wall clock excuses. Returns the
 * syncs it saw (`by`), how long it waited and whether the bound ran out; a sync nobody
 * answers for is not waited on, only named (`unanswered`).
 */
export async function awaitForeignSyncs ({ host, owner, clock = systemClock, signal = null, onWait = null, dir: resultDir = null, slotsDir = null, timeoutMs = FOREIGN_WAIT_MS, pollMs = POLL_MS }) {
  let wait = null
  let seen = []
  const startedAt = clock.now()
  const startedReal = Date.now()
  try {
    for (;;) {
      if (signal?.aborted) throw aborted()
      const standing = (await standingSyncs({ host, slotsDir })).filter((s) => s.owner !== owner)
      if (standing.length) seen = standing
      const waitOn = standing.filter((s) => s.held && s.state !== 'revert-failed')
      if (!waitOn.length) return { by: seen, waited: Boolean(wait), waitedMs: wait ? Math.max(0, clock.now() - startedAt) : 0, timedOut: false, unanswered: standing }
      if (Date.now() - startedReal >= timeoutMs) return { by: seen, waited: Boolean(wait), waitedMs: Math.max(0, clock.now() - startedAt), timedOut: true, unanswered: standing }
      if (!wait) {
        wait = { id: crypto.randomUUID(), from: clock.iso() }
        await onWait?.({ phase: 'start', id: wait.id, host, reason: 'foreign-dependency-sync', from: wait.from, dir: resultDir })
      }
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(aborted()) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, pollMs)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  } finally {
    if (wait) await onWait?.({ phase: 'end', id: wait.id, host, from: wait.from, to: clock.iso(), dir: resultDir })
  }
}
