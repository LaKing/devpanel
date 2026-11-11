import fs from 'node:fs/promises'
import path from 'node:path'

import { hostSettings } from '../config/host-settings.mjs'
import { systemClock } from './clock.mjs'
import { slotDirectory } from './drive-slots.mjs'
import { acquire, LockHeld, ownerLiveness } from './lock.mjs'
import { awaitsAutoResume } from './run-control.mjs'
import { runResult } from './run-result.mjs'
import { LOCAL_HOST, runOnHost } from './stage-instances.mjs'

/*
 * The dependency syncs this panel's runs have standing on staging hosts
 * (dependency-sync.mjs): one record per owner, `sync-<owner>.json` beside the instance
 * slots of its host, saying which run it belongs to and how to revert it. A stage holds
 * one dependency set, so a sync outlives the instance that asked for it: the record
 * stays from before the sync command runs until the revert succeeded or the run
 * delivered.
 *
 * What becomes of a sync is read off its run (`syncDisposition`):
 *   keep    the run is paused, or stopped by a service shutdown and about to be resumed:
 *           it keeps its claim, and a revert followed by a second sync would cost the
 *           base instance two more restarts
 *   drop    the run delivered to the source: the stage keeps the dependencies until the
 *           next release carries them, and the record goes without a revert
 *   revert  every other end, and a run that is gone
 *   live    the run is still driving; only its owner's death makes that a revert
 *
 * The lock beside the record (lock.mjs identity) is held by the process that synced,
 * until it settles the record. It only keeps another process's sweep from reverting
 * under a live run; a record nobody holds is judged by its run alone.
 */

const REVERT_TIMEOUT_SECONDS = 1800
const LIVE = ['preflighting', 'pending', 'running', 'stopping']

// owner -> lock: what this process holds.
const held = new Map()

const recordFile = (dir, owner) => path.join(dir, `sync-${owner}.json`)
const lockFile = (dir, owner) => path.join(dir, `sync-${owner}.lock`)
const readJson = (file) => fs.readFile(file, 'utf8').then((text) => JSON.parse(text), () => null)

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
  const record = { owner, runId, runDir, kind, ssh, host, revert: { run: revert.run, ...(revert.timeoutSeconds ? { timeoutSeconds: revert.timeoutSeconds } : {}) }, files: [...new Set([...(before?.files ?? []), ...files])].sort(), notedAt: before?.notedAt ?? clock.iso() }
  await fs.writeFile(file, JSON.stringify(record, null, 2))
  return Boolean(before)
}

/** The sync command answered. A record made for a sync that installed nothing goes; one that stood before stays. */
export async function settleSync (owner, { host, installed, prior, slotsDir = null }) {
  const lock = held.get(owner)
  if (installed || prior || !lock) return
  await fs.rm(recordFile(slotDirectory(host, slotsDir), owner), { force: true })
  await letGo(owner, lock)
}

/** What becomes of a run's syncs, from its record (null: the run is gone). */
export function syncDisposition (run, { resume = hostSettings().resumeAfterShutdown } = {}) {
  if (!run) return 'revert'
  if (LIVE.includes(run.status)) return 'live'
  if (run.status === 'paused' || (resume && awaitsAutoResume(run))) return 'keep'
  let delivered = false
  try { delivered = runResult(run).result === 'delivered' } catch { /* a record that cannot be judged did not deliver */ }
  return delivered ? 'drop' : 'revert'
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
    if (verdict === 'keep' || verdict === 'live') return null
    if (verdict === 'drop') { await fs.rm(file, { force: true }); return { ...said, kept: 'delivered' } }
    const outcome = await runOnHost(record, record.revert.run, { timeoutSeconds: record.revert.timeoutSeconds ?? REVERT_TIMEOUT_SECONDS })
    if (outcome.passed) await fs.rm(file, { force: true })
    else await fs.writeFile(file, JSON.stringify({ ...record, revertFailed: { at: clock.iso(), reason, error: outcome.error } }, null, 2)).catch(() => {})
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
      const done = await fn(dir, record.owner)
      if (done) out.push(done)
    }
  }
  return out
}

/**
 * A run stopped driving: its syncs are reverted (`how: 'revert'`) or, for a run that
 * delivered, only forgotten (`'drop'`). A revert that fails leaves the record, and the
 * next call for the run (its deletion, the panel's start) tries again. A run with none
 * costs a directory listing.
 */
export const settleRunSyncs = (runId, { how, reason, clock = systemClock, slotsDir = null }) => each({ runId, slotsDir }, (dir, owner) => settle(dir, owner, { how, reason, clock, runId }))

/** At the panel's start: every record nobody live holds, judged by its run (atStart). */
export const sweepSyncs = ({ clock = systemClock, slotsDir = null } = {}) => each({ slotsDir }, (dir, owner) => held.has(owner) ? null : settle(dir, owner, { how: atStart, reason: 'owner-gone', clock }))
