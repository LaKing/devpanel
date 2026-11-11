import crypto from 'node:crypto'

import { CHANGED, CREATE_ID, DESTROY_ID, START_ID, SYNC_ID } from './instance-drive.mjs'
import { shellQuote } from './ssh.mjs'
import { noteSync, settleSync } from './sync-records.mjs'

/*
 * A run that changes dependencies (docs/project-infrastructure.md "A run that changes
 * dependencies"): an instance runs on the stage's installed dependencies and cannot
 * install, so `create` refuses a candidate whose manifests differ. When the revision
 * itself changed a manifest, `modules.instance.syncDependencies` installs them on the
 * whole stage and `create` runs again; the stage keeps them until the run delivers (the
 * next release carries them) or ends otherwise (sync-records.mjs reverts them).
 *
 * This file is the part inside a drive: the two instance commands whose answer the
 * engine acts on instead of recording it. Both run through `step`, the drive's own way
 * of running a command (same candidate directory, same host, logs beside the others).
 */

export const DEFAULT_MANIFESTS = ['package.json', 'package-lock.json', 'npm.sh', 'dnf.sh', 'node-version']

/** The dependency manifests among a revision's changed paths (its fingerprint's entries), deletions included. */
export function changedManifests (entries, names = DEFAULT_MANIFESTS) {
  const manifest = new Set(names)
  return (entries ?? []).filter((e) => e.status && e.status !== 'unchanged' && manifest.has(e.path.slice(e.path.lastIndexOf('/') + 1))).map((e) => e.path).sort()
}

/**
 * What a revision's changed manifests are, as one string; null when the tier declares no sync. An instance was
 * created against one such state, and a later revision with another cannot be loaded into it: only `create`
 * compares manifests with the stage, so the check runner replaces the instance and that drive is a first drive.
 */
export function manifestsKey (instance, entries) {
  const declared = instance?.syncDependencies
  if (!declared) return null
  const files = new Set(changedManifests(entries, declared.manifests))
  return (entries ?? []).filter((e) => files.has(e.path)).map((e) => [e.path, e.status, e.contentHash ?? ''].join(' ')).sort().join('\n')
}

/** The sync of one drive: the declared command with the revision's manifests in place, or null when the tier declares none. */
export function syncOf (instance, entries) {
  const declared = instance?.syncDependencies
  if (!declared) return null
  const { revert, manifests, ...command } = declared
  const files = changedManifests(entries, manifests)
  return { files, revert, command: { ...command, run: command.run.replace(CHANGED, () => files.map(shellQuote).join(' ')) } }
}

// An exit the stage's script chose (not a timeout, a signal, a launch failure or ssh's own 255): its word on what it did holds.
const chose = (record) => !record.timedOut && !record.signal && Number.isInteger(record.exitCode) && record.exitCode >= 1 && record.exitCode < 124
const said = (record) => (record.stderr || record.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join(' ').slice(-600)

/**
 * `create`, and what follows when it says the candidate's manifests are not the stage's.
 * The record returned stands for the step: the second create's after a sync, or the
 * sync's own when the stage refused it or it failed, so the check reads the stage's
 * reason rather than create's. The refused first create is kept only as
 * `dependencySync.createSaid`; its log is overwritten by the second.
 */
async function createStep (command, step, { instance, used, clock, onWait, host, holder }) {
  const first = await step(command)
  const sync = instance.sync
  if (!sync || !first.unavailable || !command.unavailableExitCodes?.includes(first.exitCode)) return first
  if (!sync.files.length) {
    const reason = 'This revision changed no dependency manifest, so nothing was installed on the stage: its base instance moved ahead of the run\'s base commit, or another run\'s dependencies are installed there. Start the run again from the current base.'
    used.dependencySync = { files: [], durationMs: 0, outcome: 'not-changed', reason }
    first.unavailable = `${first.unavailable}. ${reason}`
    return first
  }
  // On record before the stage is touched: a process that dies in the middle still owes the revert.
  const prior = await noteSync({ ...holder, owner: instance.name, host, revert: sync.revert, files: sync.files, clock })
  // The stage's guard waits for deployments and for commands inside other instances, then installs and
  // boots the base. One command, so the engine cannot tell the wait from the work: all of it is a wait.
  const wait = { id: crypto.randomUUID(), from: clock.iso(), startedAt: clock.now() }
  await onWait?.({ phase: 'start', id: wait.id, host, reason: 'dependency-sync', from: wait.from, dir: holder.dir })
  let synced
  try { synced = await step(sync.command) } finally {
    await onWait?.({ phase: 'end', id: wait.id, host, from: wait.from, to: clock.iso(), dir: holder.dir })
  }
  const outcome = synced.passed ? 'synced' : synced.unavailable ? 'unavailable' : 'failed'
  used.dependencySync = { files: sync.files, durationMs: clock.now() - wait.startedAt, outcome, exitCode: synced.exitCode, reason: synced.unavailable ?? (synced.passed ? (synced.stdout ?? '').trim().split('\n').at(-1).slice(-600) : said(synced)), createSaid: first.unavailable }
  // An exit the stage chose says nothing new stands there; anything else (a timeout, a lost connection) may have installed.
  await settleSync(instance.name, { host, installed: synced.passed || !chose(synced), prior, slotsDir: holder.slotsDir })
  if (!synced.passed) return synced
  return { again: await step(command), before: [synced] }
}

/**
 * Whether a failed drive failed in its dependency sync by the stage's own exit: the install of these bytes
 * failed and the stage put its previous dependencies back. A second drive would stop, reinstall and restart
 * the base instance once more for the same answer, so the engine returns to the author without one.
 */
export const syncFailedForGood = (check) => check?.result === 'failed' && check.stageInstance?.dependencySync?.outcome === 'failed' && chose(check.commands.find((c) => c.id === SYNC_ID) ?? {})

/**
 * `start`, and an instance that went stale between its creation and its start
 * (`staleExitCodes`: the stage's dependencies were replaced meanwhile). It is destroyed
 * and created again from the same candidate, sync included, once: a second stale answer
 * is the drive's failure.
 */
async function startStep (command, step, ctx) {
  const { instance, used, result } = ctx
  const first = await step(command)
  if (!command.staleExitCodes?.includes(first.exitCode)) return first
  const destroyed = await step({ ...instance.destroy, id: DESTROY_ID })
  result.commands.push(destroyed)
  if (!destroyed.passed) return first
  const created = await createStep(instance.create, step, ctx)
  const again = created.again ?? created
  const at = result.commands.findIndex((c) => c.id === CREATE_ID)
  result.commands.splice(at, 1, ...(created.before ?? []), again)
  used.recreated = { reason: 'stale', said: said(first), destroyMs: destroyed.durationMs }
  if (!again.passed) {
    if (again.unavailable) first.unavailable = `the instance went stale and could not be created again: ${again.unavailable}`
    return first
  }
  return step(command)
}

/**
 * One command of a drive on a stage instance. `step(command)` runs a command and
 * returns its record; `ctx.result.commands` receives the records of what the engine ran
 * besides (the sync, the destroy of a stale instance), in the order they ran.
 */
export async function instanceStep (command, step, { target, result, clock, onWait = null, host = null }) {
  const instance = target.stageInstance
  if (!instance || ![CREATE_ID, START_ID].includes(command.id)) return step(command)
  const ctx = { instance, used: result.stageInstance, result, clock, onWait, host, holder: instance.holder }
  if (command.id === START_ID) return startStep(command, step, ctx)
  const created = await createStep(command, step, ctx)
  result.commands.push(...(created.before ?? []))
  return created.again ?? created
}
