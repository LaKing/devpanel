import fs from 'node:fs/promises'
import path from 'node:path'
import { withIssueLock } from './issue-locks.mjs'
import { writeJson } from './runtime/persistence.mjs'

/**
 * Read-modify-write of an issue's issue.json under the issue's step-allocation
 * lock, the lock archiving and report occurrences already take for it. Two
 * writers of the file (a disposition and a priority, say) can then never both
 * read the old record and have the later rename drop the other's change.
 *
 * `mutate(meta)` changes the record in place; when it throws, nothing is
 * written. A holder that keeps the lock past the wait (another writer, or pack,
 * restore or delete) is answered 409 ISSUE_BUSY, retryable; a folder gone meanwhile
 * 409 ISSUE_MOVED (issue-locks.mjs).
 * Never call this while holding the issue's .step-alloc.lock (it is not reentrant).
 */
export async function updateIssueMeta (dir, mutate, { purpose = 'issue-meta', waitMs = 10000 } = {}) {
  return withIssueLock(path.join(dir, '.step-alloc.lock'), { purpose, waitMs, doing: 'changing the issue' }, async () => {
    const file = path.join(dir, 'issue.json')
    let meta = {}
    try { meta = JSON.parse(await fs.readFile(file, 'utf8')) } catch { meta = {} }
    const result = await mutate(meta)
    if (result === false) return false
    await writeJson(file, meta)
    return true
  })
}
