import fs from 'node:fs/promises'
import path from 'node:path'

import { LockHeld, acquire } from './runtime/lock.mjs'

/*
 * The locks an issue's lifecycle (pack, restore, delete) and its writers share.
 *
 * One order for everyone: the project's admission lock, the id's bundle lock
 * (`<id>.tar.gz.lock` beside the archive), the issue's `.run.lock`, its
 * `.step-alloc.lock`, then the project's `.moves.lock`. Nobody takes an earlier
 * one while holding a later one. A lock inside an issue folder is never taken
 * with mkdir: a folder that has gone (packed, restored away, deleted) stays gone,
 * and the writer is told so (ISSUE_MOVED) instead of bringing it back.
 *
 * A held lock is refused as IssueBusy (409, ISSUE_BUSY, retryable). It extends
 * LockHeld, so every existing `instanceof LockHeld` handler still matches.
 */

export const admissionLockFile = (issuesDir, project) => path.join(issuesDir, project, '.admission.lock')

const lockName = (file) => {
  const name = path.basename(file)
  if (name === '.admission.lock') return 'admission'
  if (name === '.run.lock') return 'run'
  if (name === '.step-alloc.lock') return 'step'
  if (name === '.moves.lock') return 'moves'
  if (name.endsWith('.tar.gz.lock')) return 'bundle'
  return name
}

export class IssueBusy extends LockHeld {
  constructor (held, doing = null) {
    super(held.file, held.owner, held.liveness)
    this.lock = lockName(held.file)
    this.status = 409
    this.code = 'ISSUE_BUSY'
    this.retryable = true
    this.message = `${doing ? `${doing} was refused: ` : ''}the issue's ${this.lock} lock is held by another operation (${held.liveness}); try again shortly`
  }
}

export function issueMoved (file) {
  return Object.assign(new Error('the issue folder was packed, restored or deleted meanwhile; read it again'), { status: 409, code: 'ISSUE_MOVED', retryable: true, file })
}

/** A LockHeld or an ENOENT of a lock as the refusal a caller can act on; anything else unchanged. */
export function issueLockRefusal (error, file, doing = null) {
  if (error instanceof IssueBusy) return error
  if (error instanceof LockHeld) return new IssueBusy(error, doing)
  if (error?.code === 'ENOENT') return issueMoved(file)
  return error
}

/**
 * acquire() with the issue rules: no mkdir unless asked (only the admission and
 * bundle locks, which live outside any issue folder, ask), and the refusals above.
 */
export async function acquireIssueLock (file, { doing = null, mkdir = false, ...options } = {}) {
  try {
    return await acquire(file, { ...options, mkdir })
  } catch (error) {
    throw issueLockRefusal(error, file, doing)
  }
}

/** Run `fn` holding the lock, releasing it however `fn` ends. */
export async function withIssueLock (file, options, fn) {
  const lock = await acquireIssueLock(file, options)
  try {
    return await fn(lock)
  } finally {
    await lock.release()
  }
}

/**
 * Remove every file and answer only once every removal has settled, then throw
 * the first failure: a lock released after the first rejection could let a
 * writer in while a sibling removal is still running.
 */
export async function removeAllSettled (files, remove = null) {
  const rm = remove ?? ((file) => fs.rm(file, { force: true }))
  const results = await Promise.allSettled(files.map((file) => rm(file)))
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
}
