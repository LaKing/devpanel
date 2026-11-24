import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * The top-level supervisor's monitoring reads every run it owns every few
 * seconds (top-supervisor.mjs `poll`, and the start gate's refresh), and a
 * session owns its settled runs until New session: read whole each time, some
 * thirty settled runs kept the panel's process busy with nothing to learn.
 *
 * A settled run's summary is the same until its record or its issue's is
 * written again, so it is kept and read again only then. The signature is each
 * file's modification time, change time, size and inode, taken BEFORE the read:
 * a write that lands during the read shows as a difference at the next call, and
 * an edit that puts the modification time back still moves the change time,
 * which no user process can set. Which files are signed is `filesOf`: by default
 * the run's `run.json` and its issue's `issue.json`; it may name others (the
 * service names a packed issue's bundle files), or none, and then nothing is kept.
 *
 * What a summary derives from elsewhere (the clock: `metrics.time`) is refreshed
 * every `keepMs` at the latest, for a plain read (get_run). A monitoring read
 * (`{ monitoring: true }`) uses a kept summary whatever its age: everything
 * monitoring compares (status, delivery, phase, checks verdict, blocked reason,
 * substitutions, reconcile, preflight counts, cost) is read off `run.json`
 * alone, which is signed. A reading monitoring adds from anywhere else must be
 * signed too, or monitoring must stop skipping `keepMs`.
 *
 * Never kept: a live or paused run, one under an automatic reconcile, one the
 * run supervisor holds active. A file that cannot be stat'ed drops the entry, so
 * a deleted run, or an issue packed or restored, answers through `read` exactly
 * as it did.
 */

export const SETTLED_KEEP_MS = 5 * 60_000
const UNSETTLED = ['preflighting', 'pending', 'running', 'stopping', 'paused']

async function signature (files) {
  const stats = await Promise.all(files.map((file) => fs.stat(file)))
  return stats.map((s) => `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`).join('|')
}

const ownFiles = (issue, project, issueId, runId) => issue.packed ? null : [path.join(issue.path, 'runs', runId, 'run.json'), path.join(issue.path, 'issue.json')]

/**
 * @param locate   (project, issueId) => the issue ({ path, packed })
 * @param read     (issue, project, issueId, runId) => the run's summary
 * @param isActive (project, issueId) => does the run supervisor hold a run of this issue active
 * @param filesOf  (issue, project, issueId, runId) => the files whose signature keeps the summary, or null to keep nothing
 * @returns (project, issueId, runId, { monitoring }) => the summary; a kept one is returned as a copy
 */
export function settledRunCache ({ locate, read, isActive = () => false, filesOf = ownFiles, keepMs = SETTLED_KEEP_MS, maxEntries = 500, now = () => Date.now() }) {
  const kept = new Map()
  return async function detail (project, issueId, runId, { monitoring = false } = {}) {
    const key = JSON.stringify([project, issueId, runId])
    const entry = kept.get(key)
    if (entry && (monitoring || now() - entry.at < keepMs) && !isActive(project, issueId) && await signature(entry.files).catch(() => null) === entry.signature) {
      kept.delete(key); kept.set(key, entry)
      return structuredClone(entry.value)
    }
    kept.delete(key)
    const issue = await locate(project, issueId)
    const files = filesOf(issue, project, issueId, runId)
    const before = files ? await signature(files).catch(() => null) : null
    const value = await read(issue, project, issueId, runId)
    if (before && !UNSETTLED.includes(value.status) && !value.reconcilePending && !isActive(project, issueId)) {
      while (kept.size >= maxEntries) kept.delete(kept.keys().next().value)
      kept.set(key, { at: now(), files, signature: before, value: structuredClone(value) })
    }
    return value
  }
}
