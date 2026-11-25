import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { hostSettings } from '../config/host-settings.mjs'
import { issuesRoot } from '../project-path.mjs'
import { acquire, LockHeld } from './lock.mjs'
import { runProcess } from './process.mjs'
import { pinConnection, resolvedHostname, sshConnection } from './ssh.mjs'
import { awaitCycle } from '../cycle-gates.mjs'

/*
 * The staging host's CPU and memory are the shared resource: each drive boots a
 * full instance, and projects may share a host. A drive makes no connection until
 * it holds one of `testDrive.maxConcurrentDrives` slots of its host, and every
 * connection after that goes to that host.
 *
 * Slots are lock files under <issues>/.drive-slots/<host>/ (DEVPANEL_DRIVE_SLOTS_DIR
 * elsewhere: the test runner, whose suites must not write into the checkout's
 * issues/), so the count holds across projects and processes and a dead owner's slot is taken over. A slot is
 * held for one drive and no drive waits on another while holding one, so they
 * cannot deadlock. docs/project-infrastructure.md "How many drives a host runs".
 *
 * A modules drive on a stage instance of its own takes none of them: its host is
 * bounded by the instance slots beside these (stage-instances.mjs).
 */

const RESOLVE_ATTEMPT_MS = 30_000
const RESOLVE_RETRY_MS = 5_000
const RESOLVE_WINDOW_MS = 5 * 60_000
const SLOT_POLL_MS = 1_000
const ADMISSION_POLL_MS = 10
// The purpose a modules-tier drive's admission lock carries (an ordinary drive's is 'test-drive-admission').
const EXCLUSIVE = 'test-drive-exclusive'

/** Where a host's slots are. */
export const slotDirectory = (host, slotsDir = null) => path.join(slotsDir ?? process.env.DEVPANEL_DRIVE_SLOTS_DIR ?? path.join(issuesRoot(), '.drive-slots'), crypto.createHash('sha256').update(host).digest('hex').slice(0, 24))

const aborted = () => Object.assign(new Error('cancelled while waiting for a drive slot'), { name: 'AbortError' })

function pause (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    const onAbort = () => { clearTimeout(timer); reject(aborted()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `ssh -G`: what SSH would do with this connection, read from its config with no network. */
async function readConfig ({ command, args }, { signal, attemptMs }) {
  const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(attemptMs)]) : AbortSignal.timeout(attemptMs)
  const read = await runProcess({ command, args: ['-G', ...args], signal: bound })
  if (signal?.aborted) throw aborted()
  if (read.cancelled) return { error: `ssh -G did not answer within ${Math.round(attemptMs / 1000)}s` }
  if (read.code !== 0) return { error: read.stderr?.trim().slice(0, 300) || `ssh -G exited ${read.code}` }
  return { output: read.stdout }
}

const settingsDiffer = (a, b) => {
  const lines = (text) => new Set(text.split('\n').filter(Boolean))
  const left = lines(a), right = lines(b)
  const differing = [...left].filter((l) => !right.has(l)).concat([...right].filter((l) => !left.has(l)))
  return [...new Set(differing.map((l) => l.split(' ')[0]))].sort()
}

/**
 * Resolve the target's host, wait for a slot on it, and return the connection
 * every SSH invocation of this drive must use. `result.driveSlot` records the
 * outcome however it ends; `onWait` hears a wait begin and end as they happen, so
 * a wait still in progress can be excused from the run's budget.
 *
 * Throws when no connection can be made (a host that stays unresolved, a pin that
 * would change what connects) or when stopped: the drive is then `unavailable` or
 * cancelled, having connected to nothing and holding no slot.
 */
export async function holdDriveSlot ({ target, result, clock, runId = null, signal = null, onWait = null, exclusive = target?.tier === 'modules' && !target?.stageInstance,
  attemptMs = RESOLVE_ATTEMPT_MS, retryMs = RESOLVE_RETRY_MS, windowMs = RESOLVE_WINDOW_MS, pollMs = SLOT_POLL_MS, slotsDir = null,
  // The full verification (cycle-gates.mjs): `gate` admits the drive on its resolved host or answers a wait
  // token; `beforeCycleWait` must confirm nothing is held before a cycle wait; `resolved` is a connection the
  // cycle pinned at its freeze ({host, pinned}), used instead of resolving the reference again.
  gate = null, beforeCycleWait = null, resolved = null }) {
  const cap = hostSettings().testDrive.maxConcurrentDrives
  const record = { host: null, cap, waitMs: 0, waitedFrom: null, resolveAttempts: 0 }
  result.driveSlot = record
  let waitId = null, startedAt = null
  let waitReason = null
  let waitCycle = null
  const beginWait = async (reason, { from = null, cycleId = null } = {}) => {
    if (waitId) return
    waitId = crypto.randomUUID()
    startedAt = clock.now()
    waitReason = reason
    waitCycle = cycleId
    record.waitedFrom = from ?? clock.iso()
    await onWait?.({ phase: 'start', id: waitId, host: record.host, reason, from: record.waitedFrom, dir: result.dir, ...(cycleId ? { cycleId } : {}) })
  }
  const endWait = async ({ to = null, endSeq = null } = {}) => {
    if (!waitId) return
    const id = waitId
    const reason = waitReason
    const cycleId = waitCycle
    waitId = null
    record.waitMs = Math.max(0, clock.now() - startedAt)
    await onWait?.({ phase: 'end', id, host: record.host, reason, from: record.waitedFrom, to: to ?? clock.iso(), dir: result.dir, ...(cycleId ? { cycleId } : {}), ...(endSeq ? { endSeq } : {}) })
  }
  let ticket = null
  // Waits for the cycle that refused the admission; throws when something held could not be removed first.
  const cycleWait = async (token) => {
    const entry = { cycleId: token.cycleId, from: token.from }
    record.cycleWaits = [...(record.cycleWaits ?? []), entry]
    const waited = await awaitCycle(token, { gates: gate, signal, beginWait, endWait, beforeWait: beforeCycleWait })
    if (!waited) throw Object.assign(new Error('a held stage instance could not be removed before waiting for the full verification, so this drive did not wait and holds nothing'), { code: 'HELD_INSTANCE_NOT_REMOVED' })
    Object.assign(entry, { to: token.ended?.to ?? null, endSeq: token.ended?.endSeq ?? null })
  }
  // A ticket for this attempt (true), or a wait for the refusing cycle (false: the caller loops).
  const admit = async (host) => {
    if (!gate || ticket) return true
    const answer = gate.tryDrive(host)
    if (answer.wait) { await cycleWait(answer.wait); return false }
    ticket = answer.ticket
    return true
  }
  const dropTicket = () => { ticket?.release(); ticket = null }

  try {
    let host, pinned
    if (resolved?.host && resolved?.pinned) {
      ({ host, pinned } = resolved)
      record.pinnedByCycle = true
    } else {
      ({ host, pinned } = await resolveDriveHost(target.ssh, { signal, attemptMs, retryMs, windowMs, onAttempt: () => { record.resolveAttempts++ }, onRetry: () => beginWait('resolving') }))
    }
    record.host = host
    const dir = slotDirectory(host, slotsDir)
    const take = async (name, purpose = 'test-drive') => {
      try {
        return await acquire(path.join(dir, name), { purpose, runId, clock })
      } catch (error) {
        if (!(error instanceof LockHeld)) throw error
        return null
      }
    }
    // Held from here on: a failure before the caller has the handle must not keep them.
    const handOver = async (locks) => {
      const held = ticket
      ticket = null
      try {
        await endWait()
      } catch (error) {
        for (const l of locks) await l.release()
        held?.release()
        throw error
      }
      return { connection: pinned, host, release: async () => { try { for (const l of [...locks].reverse()) await l.release() } finally { held?.release() } } }
    }
    if (target?.stageInstance) {
      // A drive on its run's own stage instance loads nothing into the shared one and boots
      // nothing per drive: the host is bounded by how many instances exist, which the
      // instance's slot counts for the run's whole life (stage-instances.mjs). It takes no
      // drive slot and no admission, only the pinned connection.
      record.instance = true
      return await handOver([])
    }
    if (exclusive) {
      // The modules tier in base-instance mode loads its candidate into the host's one stage instance: it holds
      // the admission lock (so no other drive is admitted meanwhile, and modules drives
      // queue on it), then every slot, taking none while any is held, so it never waits
      // while holding a slot. docs/project-infrastructure.md "How many drives a host runs".
      record.exclusive = true
      record.slots = cap
      let admission = null
      try {
        for (;;) {
          if (signal?.aborted) throw aborted()
          if (gate && !ticket) {
            const answer = gate.tryDrive(host)
            if (answer.wait) {
              // No admission lock is held through a cycle wait.
              await admission?.release()
              admission = null
              await cycleWait(answer.wait)
              continue
            }
            ticket = answer.ticket
          }
          admission ??= await take('exclusive.lock', EXCLUSIVE)
          if (admission) {
            const slots = []
            for (let slot = 0; slot < cap; slot++) {
              const lock = await take(`slot-${slot}.lock`)
              if (!lock) break
              slots.push(lock)
            }
            if (slots.length === cap) return await handOver([admission, ...slots])
            for (const l of slots) await l.release()
          }
          dropTicket()
          await beginWait(admission ? 'host-busy' : 'exclusive')
          await pause(pollMs, signal)
        }
      } catch (error) {
        await admission?.release()
        throw error
      }
    }
    for (;;) {
      if (signal?.aborted) throw aborted()
      // The full verification's gate, checked at every attempt: a drive queued here when a cycle
      // begins takes no slot before the thaw (cycle-gates.mjs).
      if (!(await admit(host))) continue
      // Admission: a slot is taken only while holding the admission lock, so once a
      // modules drive holds it no other drive is admitted; it is never held while waiting.
      const admission = await take('exclusive.lock', 'test-drive-admission')
      if (!admission) {
        // Queued behind the admission lock: its ticket goes back, so the next attempt asks the gate again and a freeze that
        // began meanwhile holds it (queued-drive).
        dropTicket()
        // Another drive's admission lasts milliseconds and is no wait; a modules drive's is.
        const holder = await fs.readFile(path.join(dir, 'exclusive.lock'), 'utf8').then((text) => JSON.parse(text).purpose, () => null)
        if (holder !== EXCLUSIVE) { await pause(ADMISSION_POLL_MS, signal); continue }
        await beginWait('exclusive')
        await pause(pollMs, signal)
        continue
      }
      let lock = null
      try {
        for (let slot = 0; slot < cap && !lock; slot++) lock = await take(`slot-${slot}.lock`)
      } finally {
        await admission.release()
      }
      if (lock) return await handOver([lock])
      dropTicket()
      await beginWait('host-full')
      await pause(pollMs, signal)
    }
  } catch (error) {
    dropTicket()
    await endWait().catch(() => {})   // what stopped the drive is the error it reports
    throw error
  }
}

/**
 * Resolve an SSH reference to its HostName with `ssh -G`, and the connection pinned to it, retrying
 * within a window. The full verification pins its stages with this once, at its freeze, and its own
 * drives use that pinned connection (holdDriveSlot `resolved`).
 */
export async function resolveDriveHost (ssh, { signal = null, attemptMs = RESOLVE_ATTEMPT_MS, retryMs = RESOLVE_RETRY_MS, windowMs = RESOLVE_WINDOW_MS, onAttempt = null, onRetry = null } = {}) {
  // The only read of the host, user and identity references this drive makes.
  const connection = await sshConnection(ssh)
  const until = Date.now() + windowMs
  let last = null
  for (;;) {
    onAttempt?.()
    const plain = await readConfig(connection, { signal, attemptMs })
    if (plain.error) last = plain.error
    else {
      const host = resolvedHostname(plain.output)
      if (!host) last = 'its output names no usable hostname'
      else {
        const pinned = pinConnection(connection, host)
        const fixed = await readConfig(pinned, { signal, attemptMs })
        if (fixed.error) last = fixed.error
        else {
          const differing = settingsDiffer(plain.output, fixed.output)
          if (differing.length) throw new Error(`pinning the SSH host of this drive to ${host} would change its connection (${differing.join(', ')}), so no connection was made. A \`Match host\` rule that reads the alias stops matching once the hostname is fixed: use \`Match originalhost\`, or move the rule below the \`Host\` block that sets HostName.`)
          return { host, pinned }
        }
      }
    }
    if (Date.now() + retryMs > until) throw new Error(`the SSH host of ${ssh.hostRef} could not be resolved with ssh -G for ${Math.round(windowMs / 1000)}s, so no connection was made: ${last}`)
    await onRetry?.()
    await pause(retryMs, signal)
  }
}
