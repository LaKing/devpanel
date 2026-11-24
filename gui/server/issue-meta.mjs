import fs from 'node:fs/promises'
import path from 'node:path'
import { LockHeld, withLock } from './runtime/lock.mjs'
import { writeJson } from './runtime/persistence.mjs'

/**
 * Read-modify-write of an issue's issue.json under the issue's step-allocation
 * lock, the lock archiving and report occurrences already take for it. Two
 * writers of the file (a disposition and a priority, say) can then never both
 * read the old record and have the later rename drop the other's change.
 *
 * `mutate(meta)` changes the record in place; when it throws, nothing is
 * written. A holder that keeps the lock past the wait is answered 409.
 * Never call this while holding the issue's .step-alloc.lock (it is not reentrant).
 */
export async function updateIssueMeta (dir, mutate, { purpose = 'issue-meta', waitMs = 10000 } = {}) {
  try {
    return await withLock(path.join(dir, '.step-alloc.lock'), { purpose, waitMs, mkdir: false }, async () => {
      const file = path.join(dir, 'issue.json')
      let meta = {}
      try { meta = JSON.parse(await fs.readFile(file, 'utf8')) } catch { meta = {} }
      const result = await mutate(meta)
      if (result === false) return false
      await writeJson(file, meta)
      return true
    })
  } catch (error) {
    if (error instanceof LockHeld) throw Object.assign(new Error('the issue is being changed by another request; try again'), { status: 409 })
    throw error
  }
}
