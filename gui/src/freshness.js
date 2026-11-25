/*
 * How current a page's data is, apart from whether the socket is connected.
 *
 * Vue-free like live-follow.js: the page hands in a reactive object and these
 * functions only mutate it, so the rules are unit-tested (test/freshness.test.mjs)
 * without a browser. Being connected and being synchronized are separate facts:
 * a page reads as current only when the socket is online, its last refresh
 * succeeded on this connection, nothing has invalidated it since, and no panel
 * it shows is still loading or failed.
 */

/** HH:MM:SS of a timestamp, local time. */
export const clockTime = (at) => (at == null ? null : new Date(at).toTimeString().slice(0, 8))

/**
 * One refresh at a time per page. begin() hands out a ticket; only the latest
 * ticket may publish or settle. invalidate() is called the moment an event says
 * the server changed, so a refresh already in flight can no longer settle as current.
 */
export function createTracker (state = {}) {
  Object.assign(state, { seq: 0, phase: 'loading', syncedAt: null, syncedEpoch: null, error: null })
  return {
    state,
    begin () {
      state.seq++
      state.phase = state.syncedAt == null && state.phase !== 'failed' ? 'loading' : 'refreshing'
      return state.seq
    },
    isLatest: (ticket) => ticket === state.seq,
    succeed (ticket, { at = Date.now(), epoch = null } = {}) {
      if (ticket !== state.seq) return false
      Object.assign(state, { phase: 'current', syncedAt: at, syncedEpoch: epoch, error: null })
      return true
    },
    fail (ticket, error) {
      if (ticket !== state.seq) return false
      state.phase = 'failed'
      state.error = String(error?.message ?? error ?? 'unknown error')
      return true
    },
    invalidate () {
      state.seq++
      if (state.phase === 'current') state.phase = 'refreshing'
    },
    reset () {
      state.seq++
      Object.assign(state, { phase: 'loading', syncedAt: null, syncedEpoch: null, error: null })
    }
  }
}

/** The page's own refresh is current on this connection; child panels play no part. */
export const pageCurrent = (state, connection) =>
  connection?.status === 'online' && state.phase === 'current' && state.syncedEpoch === connection.epoch

/**
 * What the indicator says. `current` is true only when the page and every panel
 * it reports are synchronized on an online socket; Retry is offered after any
 * failed refresh, whatever the socket is doing.
 */
export function describe (state, connection, { childPending = null, childFailure = null } = {}, fmt = clockTime) {
  const read = state.syncedAt != null ? fmt(state.syncedAt) : null
  const shown = read ? `showing what was read at ${read}` : 'nothing read yet'
  const retry = state.phase === 'failed' || Boolean(childFailure)
  const failed = state.phase === 'failed' ? ` · refresh failed: ${state.error}` : ''
  const out = (kind, label) => ({ kind, current: kind === 'current', label, retry, readAt: state.syncedAt })
  if (connection?.status === 'offline') return out('offline', `Connection lost — ${shown}${failed}`)
  if (connection?.status !== 'online') return out('connecting', `Reconnecting — ${shown}${failed}`)
  if (state.phase === 'failed') return out('failed', `Refresh failed: ${state.error} — ${shown}`)
  if (state.phase === 'loading') return out('loading', 'Loading…')
  if (state.phase === 'refreshing') return out('refreshing', `Refreshing…${read ? ` (last read ${read})` : ''}`)
  if (state.syncedEpoch !== connection.epoch) return out('behind', 'Reconnected — refreshing')
  if (childFailure) {
    const at = childFailure.okAt != null ? fmt(childFailure.okAt) : null
    return out('child-failed', `${childFailure.label} could not be refreshed: ${childFailure.error} — shown as read at ${at ?? 'never'}`)
  }
  if (childPending) return out('child-pending', `Refreshing ${childPending.label.toLowerCase()}… (last read ${read})`)
  return out('current', `Up to date · read ${read}`)
}

/** A stable string for comparing what a person was shown with what is true now. */
export function canonical (value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

/** Whether an action may still be sent: offered, and what it acts on unchanged. */
export function judgeAction ({ synced = true, offered, before, after }) {
  if (!synced) return { send: false, reason: 'unconfirmed' }
  if (!offered) return { send: false, reason: 'gone' }
  if (canonical(before) !== canonical(after)) return { send: false, reason: 'changed' }
  return { send: true }
}

/**
 * The issue and run an action was taken on are still the ones on screen. An action
 * that retires its run (delete, abandon) needs the run listed, not selected.
 */
export function checkTarget ({ target, current, retires = false }) {
  if (!current || current.project !== target.project || current.issueId !== target.issueId) return { ok: false, reason: 'changed' }
  if (target.runId == null) return { ok: true }
  if (!(current.listedRunIds ?? []).includes(target.runId)) return { ok: false, reason: 'gone' }
  if (!retires && current.selectedRunId !== target.runId) return { ok: false, reason: 'changed' }
  return { ok: true }
}

/**
 * Which run to show: one chosen in the picker (explicit) if it still exists, else the current
 * selection, else the one the URL names (a first load), else the newest. `missing` names a chosen
 * run that is gone, so the page can say so; a stale URL is passed over silently.
 */
export function pickRun ({ list, explicit = null, query = null, current = null }) {
  const ids = list.map((r) => r.runId)
  const missing = explicit != null && !ids.includes(explicit) ? explicit : null
  for (const wanted of [explicit, current, query]) if (wanted != null && ids.includes(wanted)) return { runId: wanted, missing }
  return { runId: ids[0] ?? null, missing }
}

/** Latest-only reads for a panel: a reply applies only to the newest ticket for the same key. */
export function createSeq () {
  let latest = 0
  let latestKey
  return {
    next (key) { latest++; latestKey = key; return { n: latest, key } },
    isLatest: (ticket, key) => ticket.n === latest && ticket.key === key && latestKey === key
  }
}

/**
 * Panels that read their own endpoints report here, so the page indicator does not
 * say "Up to date" over a panel still loading or failed. Reports count only for the
 * issue (or cycle) still shown; setKey drops every other entry.
 */
export function createChildRegistry (state = {}) {
  Object.assign(state, { key: null, entries: {} })
  let next = 0
  return {
    state,
    setKey (key) {
      state.key = key
      for (const token of Object.keys(state.entries)) if (state.entries[token].key !== key) delete state.entries[token]
    },
    register (label) {
      const token = ++next
      const key = state.key
      state.entries[token] = { key, label, state: 'idle', error: null, okAt: null }
      return {
        key,
        report (status, error = null, at = Date.now()) {
          const entry = state.entries[token]
          if (!entry || entry.key !== state.key) return false
          entry.state = status
          entry.error = status === 'failed' ? String(error?.message ?? error ?? 'unknown error') : null
          if (status === 'ok') entry.okAt = at
          return true
        },
        dispose () { delete state.entries[token] }
      }
    },
    summary () {
      const live = Object.values(state.entries).filter((e) => e.key === state.key)
      return {
        childPending: live.find((e) => e.state === 'pending') ?? null,
        childFailure: live.find((e) => e.state === 'failed') ?? null
      }
    }
  }
}

/**
 * A panel's reporter. start() is called when a read begins: it reports pending under the
 * page's key of that moment and returns that read's settle(status, error). A settle after
 * the page moved to another key, or after the panel was disposed, is dropped: a late reply
 * never marks another issue. Every read that supersedes another must start() too, so the
 * pending it replaced is settled by it.
 */
export function childReporter (registry, label) {
  let handle = null
  let disposed = false
  return {
    start () {
      if (disposed || !registry) return () => false
      if (!handle || handle.key !== registry.state.key) { handle?.dispose(); handle = registry.register(label) }
      const bound = handle
      bound.report('pending')
      return (status, error = null) => (!disposed && handle === bound ? bound.report(status, error) : false)
    },
    dispose () { disposed = true; handle?.dispose(); handle = null }
  }
}

/**
 * Which runs a confirmed Close may stop: only those the confirmation named. A live run it
 * did not name means the close changed under the operator, so nothing is stopped.
 */
export function stopsForClose (confirmedIds, liveIds) {
  const unexpected = liveIds.filter((id) => !confirmedIds.includes(id))
  return unexpected.length ? { stop: [], unexpected } : { stop: liveIds, unexpected: [] }
}

/**
 * One pass of the guard, shared by the pages so the rule tested is the rule shipped.
 * refresh 'if-stale' reads the page only when it is not current; 'always' reads it every pass.
 * load() resolves 'ok' | 'superseded' | 'failed': an overtaken refresh is one more check,
 * a failed one refuses. Then the action's own source is read, and with nothing awaited
 * before the send: the page must not have moved, check(fresh) must find nothing wrong,
 * and send(fresh) is called in the same synchronous block.
 */
export async function guardPass ({ refresh = 'if-stale', alive = () => true, current, load, seq, source = null, check, send }) {
  // A view that is gone checks nothing more and never sends.
  const gone = { kind: 'disposed', reason: 'disposed' }
  if (!alive()) return gone
  if (refresh === 'always' || !current()) {
    const read = await load()
    if (!alive()) return gone
    if (read === 'superseded') return { kind: 'superseded' }
    if (read !== 'ok') return { kind: 'refused', reason: 'unconfirmed' }
  }
  const snap = seq()
  let fresh = null
  if (source) {
    let read
    try {
      read = await source()
    } catch (error) {
      // A failure that a newer page refresh overtook is not the answer: check again rather than show it.
      if (!alive()) return gone
      if (seq() !== snap) return { kind: 'superseded' }
      throw error
    }
    if (!alive()) return gone
    if (!read.latest()) return { kind: 'superseded' }
    fresh = read.value
  }
  if (seq() !== snap || !current()) return { kind: 'superseded' }
  const refusal = check(fresh)
  if (refusal) return { kind: 'refused', ...refusal }
  return { kind: 'send', value: send(fresh) }
}

/**
 * A read of an action's own source under its panel's latest-only sequence. With the panel's
 * reporter it settles the panel too, since it supersedes the panel's display read. A read a
 * newer one overtook is 'superseded' whether it succeeded or failed: its error is never shown.
 * problemOf(value), when given, names a failure an HTTP success can carry (an availability read that
 * failed inside the answer): the panel then settles failed, never current.
 */
export async function readOwn (seq, key, read, reporter = null, problemOf = null) {
  const ticket = seq.next(key)
  const settle = reporter?.start() ?? (() => false)
  const latest = () => seq.isLatest(ticket, key)
  try {
    const value = await read()
    if (latest()) {
      const problem = problemOf?.(value) ?? null
      settle(problem ? 'failed' : 'ok', problem ?? undefined)
    }
    return { value, latest }
  } catch (error) {
    if (!latest()) return { value: undefined, latest }
    settle('failed', error)
    throw error
  }
}

/**
 * The guard's driver. pass() resolves {kind: 'send'|'refused'|'superseded'}; a pass
 * overtaken by a newer refresh or event runs once more, and a second one refuses.
 */
export async function runGuard (pass) {
  let result = await pass()
  if (result.kind === 'superseded') result = await pass()
  if (result.kind === 'superseded') return { kind: 'refused', reason: 'superseded' }
  return result
}

/** The started (Deployment-run) entries of a verification payload: from that payload, never the one on screen. */
export const startedEntries = (latest) => (latest?.cycle?.projects ?? []).filter((p) => p.runId)

const runKey = (p) => `${p.project}/${p.issueId}/${p.runId}`

/** A run event about a run the verification page shows, or one its refresh in flight is loading. */
export function displayedOrInflight (event, { cycle = null, inflight = null } = {}) {
  if (!event?.runId || event.type === 'live') return false
  const key = runKey(event)
  if ((cycle?.projects ?? []).some((p) => p.runId && runKey(p) === key)) return true
  return Boolean(inflight?.runs?.has(key))
}
export { runKey }
