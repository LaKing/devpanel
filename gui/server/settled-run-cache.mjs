import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * The top-level supervisor's monitoring reads every run it owns every few
 * seconds (top-supervisor.mjs `poll`), and a session owns its settled runs
 * until New session: read whole each time, some thirty settled runs kept the
 * panel's process busy with nothing to learn.
 *
 * A settled run's summary is the same until its record or its issue's is
 * written again, so it is kept and read again only then. The signature is the
 * two files' time and size, taken BEFORE the read: a write that lands during
 * the read shows as a difference at the next call. What a summary derives from
 * elsewhere (the clock, the availability store) is refreshed every `keepMs` at
 * the latest.
 *
 * Never kept: a live or paused run, one under an automatic reconcile, one the
 * run supervisor holds active, and a packed issue (its bundle is read as
 * before). A file that cannot be read drops the entry, so a deleted run or a
 * packed issue answers through `read` exactly as it did.
 */

export const SETTLED_KEEP_MS = 5 * 60_000
const UNSETTLED = ['preflighting', 'pending', 'running', 'stopping', 'paused']

async function signature (issuePath, runId) {
  const [run, issue] = await Promise.all([fs.stat(path.join(issuePath, 'runs', runId, 'run.json')), fs.stat(path.join(issuePath, 'issue.json'))])
  return `${run.mtimeMs}:${run.size}:${issue.mtimeMs}:${issue.size}`
}

/**
 * @param locate   (project, issueId) => the issue ({ path, packed })
 * @param read     (issue, project, issueId, runId) => the run's summary
 * @param isActive (project, issueId) => does the run supervisor hold a run of this issue active
 * @returns (project, issueId, runId) => the summary; a kept one is returned as a copy
 */
export function settledRunCache ({ locate, read, isActive = () => false, keepMs = SETTLED_KEEP_MS, now = () => Date.now() }) {
  const kept = new Map()
  return async function detail (project, issueId, runId) {
    const key = JSON.stringify([project, issueId, runId])
    const entry = kept.get(key)
    if (entry && now() - entry.at < keepMs && !isActive(project, issueId) && await signature(entry.issuePath, runId).catch(() => null) === entry.signature) return structuredClone(entry.value)
    kept.delete(key)
    const issue = await locate(project, issueId)
    const before = issue.packed ? null : await signature(issue.path, runId).catch(() => null)
    const value = await read(issue, project, issueId, runId)
    if (before && !UNSETTLED.includes(value.status) && !value.reconcilePending && !isActive(project, issueId)) kept.set(key, { at: now(), issuePath: issue.path, signature: before, value: structuredClone(value) })
    return value
  }
}
