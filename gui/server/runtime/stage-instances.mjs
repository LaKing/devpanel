import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { hostSettings } from '../config/host-settings.mjs'
import { systemClock } from './clock.mjs'
import { slotDirectory } from './drive-slots.mjs'
import { acquire, LockHeld } from './lock.mjs'
import { runProcess } from './process.mjs'
import { pinConnection, sshConnection, shellQuote } from './ssh.mjs'

/*
 * The stage instances this panel has on its staging hosts (docs/project-infrastructure.md
 * "A stage instance per run"). An instance lives from a run's first modules drive to the
 * run's end or pause, so what bounds a host is how many exist, not how many drives run:
 * `testDrive.maxInstances` slots per host, beside the drive slots and in their directory
 * (`instance-<n>.lock`, with `instance-<n>.json` saying what the slot holds and how to
 * remove it).
 *
 * The lock carries runtime/lock.mjs owner identity and is held by this process for as long
 * as the instance exists. That is the whole liveness rule: an instance whose lock a live
 * owner holds is never touched; one whose owner is dead is destroyed by whoever takes the
 * lock next (a drive looking for a slot, a run's end, the sweep at start); an unknown owner
 * is left alone. A run that comes back in another process finds its own name on record,
 * removes that instance and creates a new one: what an instance holds after its owner died
 * is not known.
 *
 * A record whose instance could not be removed stays, with its lock released: the slot
 * counts as taken until a later attempt removes it, so a host never runs more than its cap.
 */

export const LOCAL_HOST = 'local'
const DESTROY_TIMEOUT_SECONDS = 300
const RETRY_LEFTOVER_MS = 60_000
const OWN_LEFTOVER_ATTEMPTS = 3
const POLL_MS = 1_000

// name -> { lock, file, record, connection }: what this process holds.
const held = new Map()
// record file -> when a leftover that could not be removed is tried again.
const retryAt = new Map()

const recordFile = (dir, slot) => path.join(dir, `instance-${slot}.json`)
const lockFile = (dir, slot) => path.join(dir, `instance-${slot}.lock`)
const readRecord = (file) => fs.readFile(file, 'utf8').then((text) => JSON.parse(text), () => null)
const aborted = () => Object.assign(new Error('cancelled while waiting for a stage instance'), { name: 'AbortError' })

/** How many instances this panel keeps on one host: the host settings' cap, lowered by the project's. */
export const instanceCap = (instance) => Math.max(1, Math.min(hostSettings().testDrive.maxInstances, Number.isInteger(instance?.max) ? instance.max : Infinity))

/** Whether this process holds that instance: the next drive loads into it instead of creating one. */
export const holdsInstance = (name) => held.has(name)

async function take (dir, slot, runId, clock) {
  try {
    return await acquire(lockFile(dir, slot), { purpose: 'stage-instance', runId, clock })
  } catch (error) {
    if (!(error instanceof LockHeld)) throw error
    return null
  }
}

async function slotsOf (dir) {
  const names = await fs.readdir(dir).catch(() => [])
  return names.map((n) => /^instance-(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
}

/**
 * Remove an instance on its host with the declared command, only when its root is still
 * there: a slot taken for an instance that was never created has nothing to remove.
 */
async function destroyOnHost (record, { connection = null } = {}) {
  const started = Date.now()
  const script = `if [ -e ${shellQuote(record.root)} ]; then\n${record.destroy.run}\nfi`
  try {
    const signal = AbortSignal.timeout((record.destroy.timeoutSeconds ?? DESTROY_TIMEOUT_SECONDS) * 1000)
    let out
    if (record.kind === 'local') out = await runProcess({ command: '/bin/sh', args: ['-c', script], signal })
    else {
      // To the host the instance was created on, whatever the reference says now.
      const reached = connection ?? pinConnection(await sshConnection(record.ssh), record.host)
      out = await runProcess({ command: reached.command, args: [...reached.args, `bash -c ${shellQuote(script)}`], signal })
    }
    const passed = out.code === 0 && !out.cancelled
    return { passed, durationMs: Date.now() - started, ...(passed ? {} : { error: (out.stderr || out.stdout || `exit ${out.code}`).trim().slice(-600) }) }
  } catch (error) {
    return { passed: false, durationMs: Date.now() - started, error: error.message }
  }
}

/** Remove what a slot's record names. The caller holds the slot's lock. */
async function clearSlot (file, record, { connection = null, reason, clock }) {
  const outcome = await destroyOnHost(record, { connection })
  if (outcome.passed) { await fs.rm(file, { force: true }); retryAt.delete(file) } else {
    retryAt.set(file, Date.now() + RETRY_LEFTOVER_MS)
    await fs.writeFile(file, JSON.stringify({ ...record, destroyFailed: { at: clock.iso(), reason, error: outcome.error } }, null, 2)).catch(() => {})
  }
  return { name: record.name, root: record.root, host: record.host, runId: record.runId ?? null, reason, at: clock.iso(), ...outcome }
}

/**
 * A slot for this instance on its host, waiting while none is free. `fresh: false` when this
 * process holds the instance already. `onWait` hears a wait begin and end, as for a drive
 * slot, so the engine excuses it from the run's wall clock.
 *
 * Throws when stopped, or when an earlier instance of the same name cannot be removed (the
 * stage would refuse to create over it): the drive is then unavailable, holding nothing.
 */
export async function holdInstance ({ instance, host, kind, ssh = null, connection = null, runId = null, runDir = null, clock = systemClock, signal = null, onWait = null, dir: resultDir = null, pollMs = POLL_MS, slotsDir = null }) {
  const cap = instanceCap(instance)
  const mine = held.get(instance.name)
  if (mine) return { fresh: false, slot: mine.record.slot, cap, waitMs: 0 }
  const dir = slotDirectory(host, slotsDir)
  await fs.mkdir(dir, { recursive: true })
  let wait = null
  const beginWait = async (reason) => {
    if (wait) return
    wait = { id: crypto.randomUUID(), startedAt: clock.now(), from: clock.iso() }
    await onWait?.({ phase: 'start', id: wait.id, host, reason, from: wait.from, dir: resultDir })
  }
  const endWait = async () => {
    if (!wait) return 0
    const { id, from, startedAt } = wait
    wait = null
    await onWait?.({ phase: 'end', id, host, from, to: clock.iso(), dir: resultDir })
    return Math.max(0, clock.now() - startedAt)
  }
  let ownFailures = 0
  try {
    for (;;) {
      if (signal?.aborted) throw aborted()
      const recorded = await slotsOf(dir)
      const records = new Map(await Promise.all(recorded.map(async (slot) => [slot, await readRecord(recordFile(dir, slot))])))
      // An earlier instance of this name goes first: nothing may be created while it stands.
      const own = recorded.filter((slot) => records.get(slot)?.name === instance.name)
      let blocked = null
      for (const slot of [...own, ...Array.from({ length: cap }, (_, i) => i).filter((i) => !own.includes(i))]) {
        if (blocked && !own.includes(slot)) break
        const file = recordFile(dir, slot)
        const isOwn = own.includes(slot)
        if (!isOwn && records.get(slot) && (retryAt.get(file) ?? 0) > Date.now()) continue
        const lock = await take(dir, slot, runId, clock)
        if (!lock) { if (isOwn) blocked = 'another owner holds this run\'s earlier instance'; continue }
        try {
          const left = await readRecord(file)
          if (left) {
            const cleared = await clearSlot(file, left, { connection: left.host === host ? connection : null, reason: 'leftover', clock })
            if (!cleared.passed) {
              if (isOwn && ++ownFailures >= OWN_LEFTOVER_ATTEMPTS) throw new Error(`an earlier stage instance of this run (${left.root}) could not be removed, so none can be created: ${cleared.error}`)
              if (isOwn) blocked = 'this run\'s earlier instance could not be removed yet'
              await lock.release()
              continue
            }
          }
          if (slot >= cap || blocked) { await lock.release(); continue }
          const record = { name: instance.name, root: instance.root, runId, runDir, kind, ssh, host, slot, destroy: { run: instance.destroy.run, ...(instance.destroy.timeoutSeconds ? { timeoutSeconds: instance.destroy.timeoutSeconds } : {}) }, heldAt: clock.iso() }
          await fs.writeFile(file, JSON.stringify(record, null, 2))
          held.set(instance.name, { lock, file, record, connection })
          return { fresh: true, slot, cap, waitMs: await endWait() }
        } catch (error) {
          await lock.release()
          throw error
        }
      }
      await beginWait(blocked ? 'instance-leftover' : 'instances-full')
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(aborted()) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, pollMs)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  } catch (error) {
    await endWait().catch(() => {})
    throw error
  }
}

/** The instance came up: its record says since when, for whoever reads the slots. */
export async function markLive (name, { revision = null, clock = systemClock } = {}) {
  const mine = held.get(name)
  if (!mine) return
  mine.record = { ...mine.record, liveSince: mine.record.liveSince ?? clock.iso(), revision }
  await fs.writeFile(mine.file, JSON.stringify(mine.record, null, 2)).catch(() => {})
}

/** Give a slot back for an instance that was never created: nothing is on the host. */
export async function releaseInstance (name) {
  const mine = held.get(name)
  if (!mine) return
  held.delete(name)
  await fs.rm(mine.file, { force: true })
  await mine.lock.release()
}

/** Destroy an instance this process holds, and give its slot back. Null when it holds none of that name. */
export async function destroyInstance (name, { reason, clock = systemClock } = {}) {
  const mine = held.get(name)
  if (!mine) return null
  held.delete(name)
  try {
    return await clearSlot(mine.file, mine.record, { connection: mine.connection, reason, clock })
  } finally { await mine.lock.release() }
}

/** Every record under the slots root whose lock nobody live holds, removed; `runId` narrows it to one run. */
async function clearUnheld ({ runId = null, reason, clock, slotsDir = null }) {
  const root = path.dirname(slotDirectory(LOCAL_HOST, slotsDir))
  const cleared = []
  for (const host of await fs.readdir(root).catch(() => [])) {
    const dir = path.join(root, host)
    for (const slot of await slotsOf(dir)) {
      const file = recordFile(dir, slot)
      if (runId && (await readRecord(file))?.runId !== runId) continue
      const lock = await take(dir, slot, runId, clock)
      if (!lock) continue
      try {
        const record = await readRecord(file)
        if (record && (!runId || record.runId === runId)) cleared.push(await clearSlot(file, record, { reason, clock }))
      } finally { await lock.release() }
    }
  }
  return cleared
}

/**
 * Every instance of a run, destroyed: what this process holds for it, and what an earlier
 * process of it left. Called at each end of a run and when it pauses; a run with none costs
 * a directory listing.
 */
export async function destroyRunInstances (runId, { reason, clock = systemClock, slotsDir = null } = {}) {
  const mine = [...held.values()].filter((h) => h.record.runId === runId).map((h) => h.record.name)
  const destroyed = []
  for (const name of mine) destroyed.push(await destroyInstance(name, { reason, clock }))
  return [...destroyed, ...await clearUnheld({ runId, reason, clock, slotsDir })]
}

/**
 * At the panel's start: no run of this process holds an instance yet, so every record whose
 * owner is proved dead names an instance nobody drives. An owner that cannot be proved dead
 * keeps its lock, and its instance.
 */
export const sweepInstances = ({ clock = systemClock, slotsDir = null } = {}) => clearUnheld({ reason: 'owner-gone', clock, slotsDir })

/**
 * The panel's start, in the background: the sweep above, then each staging host's own
 * collector once (`modules.instance.gc`), which removes what the stage itself finds
 * abandoned. In that order, so a collector never meets an instance this panel still counts.
 */
export async function sweepAtStart ({ infrastructures = [], clock = systemClock } = {}) {
  const cleared = await sweepInstances({ clock })
  const collectors = new Map()
  for (const infra of infrastructures) {
    const gc = infra?.testDrive?.modules?.instance?.gc
    if (gc && infra.staging?.ssh) collectors.set(`${infra.staging.ssh.hostRef}\0${gc.run}`, { ssh: infra.staging.ssh, gc })
  }
  const collected = []
  for (const { ssh, gc } of collectors.values()) {
    try {
      const reached = await sshConnection(ssh)
      const out = await runProcess({ command: reached.command, args: [...reached.args, `bash -c ${shellQuote(gc.run)}`], signal: AbortSignal.timeout((gc.timeoutSeconds ?? 600) * 1000) })
      collected.push({ host: ssh.hostRef, passed: out.code === 0 && !out.cancelled, output: (out.stdout + out.stderr).trim().slice(-600) })
    } catch (error) { collected.push({ host: ssh.hostRef, passed: false, output: error.message }) }
  }
  return { cleared, collected }
}
