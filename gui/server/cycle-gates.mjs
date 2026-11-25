import crypto from 'node:crypto'
import path from 'node:path'

/*
 * The full verification's gates (execution-contract.md "Full verification freeze"): inside a cycle a
 * contained writing run of a verified project goes on taking seat turns; only its check drive on a
 * staging host the cycle drives on and its writes into a repository the cycle snapshots wait, until
 * the cycle thaws. Owned by the supervisor (one per process).
 *
 * - A gate is asked synchronously (`tryDrive`, `tryWrite`): it answers a ticket (go on; the ticket is
 *   in `pending()` until released, so a freeze that begins meanwhile waits for it) or a wait token,
 *   created in the same block as the refusal and bound to the refusing cycle's thaw. A thaw that comes
 *   while the caller still persists or cleans up is not missed, and a later cycle never adopts it.
 * - `thaw` ends the cycle's tokens in the order they began, stamping each (`to`, `endSeq`) in one
 *   synchronous loop; each waiter records its own stamps, and none waits for another's persistence.
 * - A record the cycle waits for whole (in place, release, unreadable, reaching the snapshot outside
 *   delivery; or one that does not say: `whole !== false`), a read-only one, the cycle's own runs and
 *   a caller that already holds a ticket always get a ticket: the cycle waits for them, so they must
 *   not wait for the cycle.
 */

export const FULL_VERIFICATION_WAIT = 'full-verification'

const normal = (p) => path.resolve(String(p))

export function createCycleGates ({ clock = { iso: () => new Date().toISOString() } } = {}) {
  let freeze = null
  const thawed = new Set()
  const tickets = new Map()
  let queue = []
  let seq = 0

  /**
   * `projects`: the scope (null: every project); `hosts`: [{hostRef, host, pinned}] the cycle drives
   * (resolved HostNames, pinned at freeze); `snapshotted`: {repositories, unknown}.
   */
  function setFreeze ({ cycleId, projects = null, hosts = [], snapshotted = null } = {}) {
    if (thawed.has(cycleId)) return false
    const list = [...(hosts ?? [])]
    freeze = {
      cycleId,
      projects: Array.isArray(projects) ? new Set(projects) : null,
      hosts: list,
      hostNames: new Set(list.map((h) => h.host).filter(Boolean)),
      repositories: new Set((snapshotted?.repositories ?? []).map(normal)),
      worktrees: (snapshotted?.worktrees ?? []).map(normal),
      unknown: Boolean(snapshotted?.unknown)
    }
    queue = []
    seq = 0
    return true
  }

  /** Final for its cycle: a later setFreeze of it is ignored; every token it refused ends now, in begin order. */
  function thaw (cycleId) {
    if (!cycleId) cycleId = freeze?.cycleId
    if (!cycleId) return false
    thawed.add(cycleId)
    if (freeze?.cycleId !== cycleId) return false
    const ending = queue
    queue = []
    freeze = null
    let endSeq = 0
    for (const token of ending) {
      token.ended = { to: clock.iso(), endSeq: ++endSeq }
      token.resolve(token.ended)
    }
    return true
  }

  const isActive = (cycleId) => Boolean(freeze && cycleId && freeze.cycleId === cycleId)
  const inScope = (project) => Boolean(freeze) && (!freeze.projects || freeze.projects.has(project))
  const isCycleHost = (host) => Boolean(freeze && host && freeze.hostNames.has(host))
  // A repository named by its common directory, or (a caller holding only a checkout) by a path inside a snapshotted work tree.
  const insideWorktree = (r) => freeze.worktrees.some((w) => { const rel = path.relative(w, normal(r)); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) })
  const touchesSnapshot = (repositories = []) => Boolean(freeze) && (freeze.unknown || repositories.some((r) => freeze.repositories.has(normal(r)) || insideWorktree(r)))

  function take (record, kind, fields) {
    const id = crypto.randomUUID()
    const ticket = { id, kind, project: record?.project ?? null, issueId: record?.issueId ?? null, runId: record?.runId ?? null, since: clock.iso(), ...fields }
    tickets.set(id, ticket)
    ticket.release = () => { tickets.delete(id) }
    return ticket
  }

  function enqueue (record, kind, fields) {
    let resolve
    const promise = new Promise((r) => { resolve = r })
    const token = { cycleId: freeze.cycleId, seq: ++seq, from: clock.iso(), kind, project: record?.project ?? null, runId: record?.runId ?? null, ...fields, promise, resolve, ended: null }
    queue.push(token)
    return token
  }

  /**
   * Whether the cycle waits for this record whole, or it is not the cycle's to gate. A record the freeze is still
   * classifying (`classifying` set by the supervisor before its first await) does not pass: it waits until it is
   * classified (released at once when found whole, `release`) or the cycle thaws.
   */
  const passes = (record) => !record || record.writes === false || (record.whole !== false && !record.classifying) || (freeze && record.cycleId && record.cycleId === freeze.cycleId)
  /** A held ticket lets a nested admission pass only when the cycle drains its holder (deadlock rule): a live drive ticket on a cycle host, or a live write ticket into the snapshot. */
  const drains = (held) => Boolean(held && tickets.has(held.id) && ((held.kind === 'drive' && isCycleHost(held.host)) || (held.kind === 'write' && inScope(held.project) && touchesSnapshot(held.repositories ?? []))))

  function gateFor (record) {
    return {
      record,
      tryDrive (host, { held = null } = {}) {
        if (!freeze || drains(held) || passes(record) || !inScope(record.project) || !isCycleHost(host)) return { ticket: take(record, 'drive', { host }) }
        return { wait: enqueue(record, 'drive', { host }) }
      },
      tryWrite (repositories = [], { held = null, action = null } = {}) {
        const repos = [...new Set((repositories ?? []).filter(Boolean).map(normal))]
        if (!freeze || drains(held) || passes(record) || !inScope(record.project) || !touchesSnapshot(repos)) return { ticket: take(record, 'write', { repositories: repos, action }) }
        return { wait: enqueue(record, 'write', { repositories: repos, action }) }
      },
      isActive,
      waitFor,
      cancel,
      // The whole pinned record ({hostRef, host, pinned}), so a drive connects to the host the gate protects.
      pinned: (hostRef) => { const h = freeze?.hosts.find((x) => x.hostRef === hostRef); return h?.host && h?.pinned ? { host: h.host, pinned: h.pinned } : null },
      cycleId: () => freeze?.cycleId ?? null,
      // The resolved HostNames the cycle drives on (a write's wait has no host of its own).
      hosts: () => [...(freeze?.hostNames ?? [])]
    }
  }

  /**
   * A record the freeze classified whole after its admissions were refused: its waits end now (the cycle waits for it, so
   * it must not wait for the cycle); the waiters ask again and pass. Stamped `released`, without an endSeq.
   */
  function release (runId) {
    const mine = queue.filter((t) => t.runId === runId)
    queue = queue.filter((t) => t.runId !== runId)
    for (const token of mine) {
      token.ended = { to: clock.iso(), endSeq: null, released: true }
      token.resolve(token.ended)
    }
    return mine.length
  }

  /** A wait its caller gave up before waiting (it waits for nothing): out of the queue, stamped `cancelled`, no endSeq. */
  function cancel (token) {
    if (!token || token.ended) return false
    queue = queue.filter((t) => t !== token)
    token.ended = { to: clock.iso(), endSeq: null, cancelled: true }
    token.resolve(token.ended)
    return true
  }

  /** Await a wait token, or the signal; resolves the token's stamps. */
  function waitFor (token, signal = null) {
    if (token.ended) return Promise.resolve(token.ended)
    if (!signal) return token.promise
    if (signal.aborted) return Promise.reject(Object.assign(new Error('stopped while waiting for the full verification'), { name: 'AbortError' }))
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('stopped while waiting for the full verification'), { name: 'AbortError' }))
      signal.addEventListener('abort', onAbort, { once: true })
      token.promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v) })
    })
  }

  return {
    setFreeze,
    thaw,
    release,
    cancel,
    thawed,
    isActive,
    inScope,
    isCycleHost,
    touchesSnapshot,
    gateFor,
    waitFor,
    current: () => freeze,
    pending: () => [...tickets.values()].map(({ release, ...t }) => t),
    waiters: () => queue.map(({ promise, resolve, ...t }) => t)
  }
}

/**
 * The wait of one admission against a refusing cycle, recorded through the caller's own wait callbacks:
 * an ordinary wait in progress is closed first (with its reason), the cycle wait is opened with the
 * token's begin stamp and closed with its end stamps. `beforeWait` must confirm that nothing is held
 * (false: nothing waits; the caller settles).
 */
export async function awaitCycle (token, { gates, signal = null, beginWait, endWait, beforeWait = null }) {
  await endWait?.()
  if (beforeWait && !(await beforeWait(token))) return false
  await beginWait?.(FULL_VERIFICATION_WAIT, { from: token.from, cycleId: token.cycleId })
  let stamps = null
  try {
    stamps = await (gates?.waitFor ? gates.waitFor(token, signal) : token.promise)
  } finally {
    await endWait?.({ to: (stamps ?? token.ended)?.to ?? null, endSeq: (stamps ?? token.ended)?.endSeq ?? null, cycleId: token.cycleId })
  }
  return true
}
