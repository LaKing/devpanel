import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { systemClock } from './clock.mjs'
import { hostPlatform } from './platform.mjs'

/*
 * Atomic lock carrying owner identity.
 *
 * Liveness is established POSITIVELY — the pid must exist, and its boot id and
 * process start time must match what the lock recorded. Lock age is never
 * evidence: a long invocation is indistinguishable from a dead one by age.
 * The boot and process probes are the host's (platform.mjs), injectable as
 * `{ platform }`; a probe that cannot answer makes the owner 'unknown'.
 */

/** Recorded when the owner's own boot identity could not be read (darwin). */
const UNPROVED_BOOT = 'unproved:'

export async function currentOwner (runId = null, { platform = hostPlatform() } = {}) {
  const boot = await platform.bootId()
  const start = await platform.processStart(process.pid)
  return {
    pid: process.pid,
    bootId: boot ?? `${UNPROVED_BOOT}${os.hostname()}`,
    processStartedAt: start.state === 'present' ? start.startedAt : null,
    host: os.hostname(),
    runId
  }
}

/**
 * Is the recorded owner still running? Only 'alive' permits waiting; only 'dead'
 * permits taking over. 'unknown' means we could not establish either — a probe
 * failed or answered something unreadable — and the caller must treat the lock
 * as held.
 */
export async function ownerLiveness (owner, { platform = hostPlatform() } = {}) {
  if (!owner?.pid) return 'unknown'
  const boot = await platform.bootId()
  if (boot === null || String(owner.bootId ?? '').startsWith(UNPROVED_BOOT)) return 'unknown'
  if (owner.bootId !== boot) return 'dead'                // machine rebooted since
  if (owner.host !== os.hostname()) return 'unknown'      // another machine; cannot tell

  const start = await platform.processStart(owner.pid)
  if (start.state === 'absent') return 'dead'             // no such process
  if (start.state !== 'present') return 'unknown'         // the probe could not tell
  if (owner.processStartedAt && start.startedAt !== owner.processStartedAt) return 'dead' // pid reused
  return 'alive'
}

export class LockHeld extends Error {
  constructor (file, owner, liveness) {
    super(`lock held by pid ${owner?.pid} (${liveness})`)
    this.file = file
    this.owner = owner
    this.liveness = liveness
  }
}

/**
 * Acquire an exclusive lock. Every step-creating path shares the step-allocation
 * lock: retry-on-EEXIST is not sufficient there, because two concurrent creates
 * with different slugs both succeed and both take the same number.
 */
export async function acquire (file, {
  purpose,
  runId = null,
  clock = systemClock,
  takeOverDead = true,
  platform = hostPlatform(),
  // How long to queue behind a LIVE owner. Step allocation is contended by design
  // — the engine and an API request can both want a number — so callers queue
  // rather than fail. Zero means fail immediately, which is what a run lock wants.
  waitMs = 0,
  pollMs = 10,
  // Stops a wait behind a live owner: a stopped run must not sit in the queue.
  signal = null,
  // Extra fields published with the record (module-locks.mjs: what is locked, by which issue).
  detail = null,
  // async (held) => true when a LIVE owner's lock no longer stands for anything (the run it
  // names has ended): taken over like a dead one. Never consulted for 'unknown' or 'dead'.
  stale = null
} = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const owner = await currentOwner(runId, { platform })
  const token = crypto.randomUUID()
  const record = { ...(detail ?? {}), purpose, token, owner, acquiredAt: clock.iso(), heartbeatAt: clock.iso() }
  const deadline = Date.now() + waitMs

  const handle = {
    file,
    owner,
    token,
    /**
     * Release only what we still hold. Unlinking blindly would delete a lock a
     * different owner acquired after ours was taken over.
     */
    async release () {
      try {
        const held = JSON.parse(await fs.readFile(file, 'utf8'))
        if (held.token !== token) return false
      } catch {
        return false
      }
      await fs.rm(file, { force: true })
      return true
    }
  }

  // Losing a takeover race to another contender is worth a short re-look even
  // for a fail-fast caller: the winner either holds the lock by then or is gone.
  const contendedUntil = Date.now() + Math.max(waitMs, TAKEOVER_CONTENTION_MS)
  for (;;) {
    if (signal?.aborted) throw abortedWait(file)
    if (await createWith(file, record)) return handle

    const examined = await examine(file, platform)
    const { held } = examined
    let { liveness } = examined
    if (liveness === 'alive' && stale && held && await stale(held)) liveness = 'stale'
    if (['dead', 'stale'].includes(liveness) && takeOverDead) {
      if (await takeOver(file, held, platform, stale)) continue
      if (Date.now() < contendedUntil) { await new Promise((r) => setTimeout(r, pollMs)); continue }
    } else if (Date.now() < deadline) {
      // Queue behind a live owner until the deadline, then give up.
      await new Promise((r) => setTimeout(r, pollMs))
      continue
    }
    throw new LockHeld(file, held?.owner, liveness)
  }
}

const TAKEOVER_CONTENTION_MS = 1000
const abortedWait = (file) => Object.assign(new Error(`cancelled while waiting for ${path.basename(file)}`), { name: 'AbortError' })
/*
 * A lock file that does not parse. Locks are now published complete (link of a
 * written temp file), so this is only ever one left by the earlier open-then-
 * write, which a crash could leave empty. That window is milliseconds wide: an
 * unreadable lock older than this cannot be a write still in progress.
 */
const UNREADABLE_LOCK_DEAD_AFTER_MS = 60_000

/**
 * Publish `record` at `file` only if nothing is there, and never partially:
 * the record is written to a private temp file and hard-linked into place, so
 * a reader sees either no lock or a complete one.
 */
async function createWith (file, record) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { flag: 'wx' })
  try {
    await fs.link(temp, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    await fs.rm(temp, { force: true })
  }
}

async function examine (file, platform = hostPlatform()) {
  let text
  try { text = await fs.readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return { held: null, liveness: 'dead' }   // released meanwhile
    throw error
  }
  try {
    const held = JSON.parse(text)
    return { held, liveness: await ownerLiveness(held.owner, { platform }) }
  } catch {
    const stat = await fs.stat(file).catch(() => null)
    const old = stat && Date.now() - stat.mtimeMs > UNREADABLE_LOCK_DEAD_AFTER_MS
    return { held: null, liveness: old ? 'dead' : 'unknown', unreadable: true }
  }
}

/**
 * Remove a dead owner's lock, serialized so two contenders cannot both observe
 * the dead owner and both unlink — which would let one delete the other's newly
 * acquired lock and leave two holders believing they own it.
 */
async function takeOver (file, held, platform = hostPlatform(), stale = null) {
  const gate = `${file}.takeover`
  const token = crypto.randomUUID()
  if (!await createWith(gate, { purpose: 'takeover', token, owner: await currentOwner(null, { platform }), at: new Date().toISOString() })) {
    // Another contender is taking over — unless that contender died inside the
    // gate, which would otherwise block this lock forever.
    const { held: gateHolder, liveness } = await examine(gate, platform)
    if (liveness === 'dead') {
      const now = await fs.readFile(gate, 'utf8').catch(() => null)
      if (now !== null && (gateHolder === null || JSON.parse(now).token === gateHolder.token)) await fs.rm(gate, { force: true })
    }
    return false
  }

  try {
    // Re-read under the gate: the lock may already have been replaced.
    let current = null
    try { current = JSON.parse(await fs.readFile(file, 'utf8')) } catch {
      // Unreadable: only an old one left by the earlier writer may be removed.
      const { liveness } = await examine(file, platform)
      if (held !== null || liveness !== 'dead') return false
      await fs.rm(file, { force: true })
      return true
    }
    if (!held || current.token !== held.token) return false          // replaced since we looked
    const now = await ownerLiveness(current.owner, { platform })
    if (now !== 'dead' && !(now === 'alive' && stale && await stale(current))) return false  // no longer dead
    await fs.rm(file, { force: true })
    return true
  } finally {
    await fs.rm(gate, { force: true })
  }
}

/** Run `fn` while holding the lock, releasing it however `fn` ends. */
export async function withLock (file, options, fn) {
  const lock = await acquire(file, options)
  try {
    return await fn(lock)
  } finally {
    await lock.release()
  }
}
