/*
 * Following one invocation's live output: the persisted log read in bounded
 * pages over HTTP, and the chunks the socket delivers to a subscribed viewer.
 * Free of Vue, so the ordering rules can be tested as functions of their
 * inputs and the transport test can drive the real thing.
 *
 * The rules, in short:
 *  - The cursor is the seq of the last committed entry. It is null until the
 *    initial tail sets it, exactly once (a failed tail read is retried); later
 *    resumes read `after=cursor`, so it never moves back.
 *  - The server writes a chunk before it emits it, and each socket chunk names
 *    `prev`, the seq of the entry before it in the file (seqs can skip: a capped
 *    log keeps its exit marker). A socket chunk commits only when prev === cursor;
 *    anything else waits in `pending` and starts a catch-up.
 *  - One catch-up at a time, `after=cursor` pages committed in file order. While
 *    it runs only it commits; socket chunks wait. It ends only on a page that was
 *    asked for after the latest subscribe ack (join generation), says no more,
 *    and has brought the cursor up to the highest seq the socket ever delivered.
 *    A failed read is retried; it never drops what is owed.
 *  - A hidden viewer reads nothing more: a catch-up in flight stops before
 *    committing or asking again, and resumes from the cursor when shown.
 *  - `pending` past its cap is cleared, never trimmed: those entries are on
 *    disk, and `highestSeen` keeps the catch-up going until it has read them.
 *  - The window is bounded in entries and in serialized UTF-8 bytes; only the
 *    oldest committed entries are dropped, and what was dropped can be loaded
 *    again (earlier). Loading earlier detaches first, one request at a time.
 */

export const PAGE_LIMIT = 500
export const TAIL = 1000
export const MAX_ENTRIES = 5000
export const MAX_BYTES = 4 * 1024 * 1024
const PENDING_ENTRIES = 2000
const PENDING_BYTES = 4 * 1024 * 1024
const POLL_MS = 2000
const RETRY_MS = 1000

/** UTF-8 length of a string, without allocating its encoding. */
export function utf8Length (text) {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

/* The whole entry as it travels: serialized, metadata and escaping included. */
const sizes = new WeakMap()
export function entryBytes (entry) {
  if (!entry || typeof entry !== 'object') return 0
  let n = sizes.get(entry)
  if (n === undefined) { n = utf8Length(JSON.stringify(entry)); sizes.set(entry, n) }
  return n
}

/**
 * channel: liveChannel() (subscribe / unsubscribe / onEntry / onConnect / close).
 * fetchPage(query): resolves a bounded page `{ entries, more, earlier, live, ... }`.
 * active: the viewer is visible; live: the invocation is (or was) in flight.
 */
export function createLiveFollow ({
  channel, fetchPage, pageLimit = PAGE_LIMIT, tail = TAIL,
  maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES, pendingEntries = PENDING_ENTRIES, pendingBytes = PENDING_BYTES,
  active = true, live = false, onChange = () => {}, onPage = () => {}, pollMs = POLL_MS, retryMs = RETRY_MS,
  checkGeneration = true // test-only: false drops the join generation and the owed re-read, to show what they prevent
} = {}) {
  const state = { entries: [], earlier: false, detached: false, polling: false, error: '', live: Boolean(live), loading: true, cursor: null, base: 0 }
  let bytes = 0
  let pending = new Map() // prev -> entry
  let pendingSize = 0
  let highestSeen = 0
  let joinGen = 0
  let subscribed = false
  let joined = false
  let catching = false
  let owed = false // a catch-up was asked for while one ran (a rejoin, a gap, a show)
  let tailApplied = false
  let tailLoading = false
  let earlierLoading = null
  let epoch = 0
  let pollTimer = null
  let retryTimer = null
  let closed = false

  const cursor = () => (tailApplied ? (state.entries.at(-1)?.seq ?? state.base) : null)
  const changed = () => { state.cursor = cursor(); onChange(state) }
  const halted = (mine) => mine !== epoch || closed || state.detached

  function trimFront () {
    while (state.entries.length > maxEntries || (bytes > maxBytes && state.entries.length > 1)) {
      const dropped = state.entries.shift()
      bytes -= entryBytes(dropped)
      state.base = dropped.seq
      state.earlier = true
    }
  }

  function commit (entry) {
    state.entries.push(entry)
    bytes += entryBytes(entry)
    trimFront()
  }

  function drain () {
    const c = cursor()
    for (const [prev, e] of pending) if (e.seq <= c) { pending.delete(prev); pendingSize -= entryBytes(e) }
    while (pending.has(cursor())) {
      const e = pending.get(cursor())
      pending.delete(cursor())
      pendingSize -= entryBytes(e)
      commit(e)
    }
  }

  function buffer (entry, prev) {
    if (pending.has(prev)) return
    pending.set(prev, entry)
    pendingSize += entryBytes(entry)
    if (pending.size > pendingEntries || pendingSize > pendingBytes) { pending = new Map(); pendingSize = 0 }
  }

  function onEntry (event) {
    if (!subscribed || !active || state.detached || closed) return
    const entry = event?.entry
    if (!entry || !Number.isInteger(entry.seq)) return
    if (entry.seq > highestSeen) highestSeen = entry.seq
    const c = cursor()
    if (c !== null && entry.seq <= c) return
    if (c !== null && !catching && Number.isInteger(event.prev) && event.prev === c) {
      commit(entry)
      drain()
      changed()
      return
    }
    buffer(entry, Number.isInteger(event.prev) ? event.prev : -1)
    // Not owed: a running catch-up drains it, and a real gap keeps it going (cursor < highestSeen).
    catchUp()
  }

  function scheduleRetry (fn) {
    if (retryTimer || closed) return
    retryTimer = setTimeout(() => { retryTimer = null; fn() }, retryMs)
  }

  /** `owe`: this call must be followed by a read sent after it (a new join), even if one is running. */
  async function catchUp (owe = false) {
    if (!tailApplied || state.detached || closed || !active) return
    if (catching) { if (owe && checkGeneration) owed = true; return }
    catching = true
    owed = false
    const mine = epoch
    let emptyRetries = 0
    try {
      for (;;) {
        const gen = joinGen
        const from = cursor()
        const page = await fetchPage({ after: from, limit: pageLimit })
        // Hidden, detached or replaced meanwhile: commit nothing and ask for nothing more.
        if (halted(mine) || !active) return
        onPage(page, { kind: 'after', after: from, gen })
        if (page.live) state.live = true
        for (const e of page.entries ?? []) if (e.seq > cursor()) commit(e)
        drain()
        state.error = ''
        changed()
        if (!(page.entries ?? []).length && !page.more && cursor() < highestSeen) {
          if (++emptyRetries > 1) { state.error = 'the live log did not reach the output already delivered'; changed(); return }
          continue
        }
        const current = !checkGeneration || gen === joinGen
        if (current && !page.more && cursor() >= highestSeen && !owed) return
        owed = false
      }
    } catch (error) {
      if (mine !== epoch) return
      state.error = error?.message ?? String(error)
      changed()
      // What was owed stays owed: read again from the cursor.
      owed = true
    } finally {
      if (mine === epoch) {
        catching = false
        if (owed && !closed && !state.detached && active) scheduleRetry(() => catchUp(true))
      }
    }
  }

  function startPolling () {
    if (pollTimer) return
    state.polling = true
    pollTimer = setInterval(() => { if (state.live && active) catchUp() }, pollMs)
  }
  function stopPolling () {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    state.polling = false
  }

  function join () {
    if (subscribed || closed || state.detached) return
    subscribed = true
    resubscribe()
  }
  function resubscribe () {
    const mine = epoch
    channel.subscribe().then((ack) => {
      if (!subscribed || closed || mine !== epoch) return
      if (ack?.ok) {
        stopPolling()
        joinGen += 1
        joined = true
        if (tailApplied) catchUp(true)
        else if (!tailLoading) loadTail()
      } else {
        // HTTP never waits on the socket: without a room the viewer reads by polling.
        startPolling()
        changed()
      }
    })
  }
  function leave () {
    if (!subscribed) return
    subscribed = false
    joined = false
    channel.unsubscribe()
    stopPolling()
  }

  const wantsRoom = () => active && state.live && !state.detached && !closed

  async function loadTail () {
    const mine = epoch
    tailLoading = true
    try {
      const page = await fetchPage({ tail })
      if (mine !== epoch || closed || tailApplied) return
      onPage(page, { kind: 'tail', gen: joinGen })
      tailApplied = true
      state.entries = []
      bytes = 0
      for (const e of page.entries ?? []) commit(e)
      if (!state.entries.length) state.base = page.next ?? 0
      state.earlier = Boolean(page.earlier) || state.earlier
      if (page.live) state.live = true
      state.loading = false
      state.error = ''
      drain()
      changed()
      if (wantsRoom()) join()
      if (joined) catchUp()
    } catch (error) {
      if (mine !== epoch) return
      state.loading = false
      state.error = error?.message ?? String(error)
      changed()
      // No cursor yet: read the tail again, but only while the viewer is shown; showing it resumes this.
      scheduleRetry(() => { if (mine === epoch && !tailApplied && active) loadTail() })
    } finally {
      if (mine === epoch) tailLoading = false
    }
  }

  channel.onEntry(onEntry)
  channel.onConnect(() => { if (subscribed && !closed) resubscribe() })

  function start () {
    if (wantsRoom()) join()
    loadTail()
  }

  return {
    state,
    start,
    /** The viewer was shown (true) or hidden (false). Hidden, it holds no room and reads nothing. */
    setActive (value) {
      active = Boolean(value)
      if (!active) {
        leave()
        // No automatic read fires while hidden; what it owed resumes when shown.
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
        return
      }
      if (!tailApplied && !tailLoading && !closed && !state.detached) loadTail()
      if (wantsRoom()) join()
    },
    /** The invocation is in flight: a visible viewer subscribes. */
    setLive (value) {
      if (value) state.live = true
      if (wantsRoom()) join()
    },
    /**
     * Older retained output, before the first entry held. Detaches from the live
     * stream before asking, so the window cannot move under the request; one
     * request at a time, and an answer that no longer meets the window is dropped.
     */
    loadEarlier () {
      if (earlierLoading) return earlierLoading
      const first = state.entries[0]?.seq
      if (first == null) return Promise.resolve()
      state.detached = true
      leave()
      pending = new Map()
      pendingSize = 0
      changed()
      const mine = epoch
      earlierLoading = (async () => {
        try {
          const page = await fetchPage({ before: first, limit: pageLimit })
          if (mine !== epoch || closed || state.entries[0]?.seq !== first) return
          onPage(page, { kind: 'before', before: first, gen: joinGen })
          const older = (page.entries ?? []).filter((e) => e.seq < first)
          state.entries = [...older, ...state.entries]
          bytes = state.entries.reduce((n, e) => n + entryBytes(e), 0)
          while (state.entries.length > maxEntries || (bytes > maxBytes && state.entries.length > 1)) bytes -= entryBytes(state.entries.pop())
          state.earlier = Boolean(page.earlier)
          state.error = ''
          changed()
        } catch (error) {
          if (mine === epoch) { state.error = error?.message ?? String(error); changed() }
        } finally {
          if (mine === epoch) earlierLoading = null
        }
      })()
      return earlierLoading
    },
    /** Back to the newest output and following it. */
    jumpToLatest () {
      epoch += 1
      leave()
      catching = false
      owed = false
      tailApplied = false
      tailLoading = false
      earlierLoading = null
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      pending = new Map()
      pendingSize = 0
      highestSeen = 0
      Object.assign(state, { entries: [], earlier: false, detached: false, error: '', loading: true, base: 0 })
      bytes = 0
      changed()
      start()
    },
    close () {
      closed = true
      epoch += 1
      leave()
      stopPolling()
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      channel.close()
    }
  }
}

/**
 * Reading one clipped entry a part at a time, holding one part. Every answer
 * is bound to the request that asked for it (invocation, seq, offset and a
 * request number): a slower or overlapping answer is never shown and never
 * used to work out the next offset.
 */
export function createSlicer ({ fetchSlice, onChange = () => {} }) {
  const state = { invocationId: null, seq: null, slice: null, loading: false, error: '' }
  let request = 0
  let starts = []

  async function show (offset) {
    const mine = ++request
    const { invocationId, seq } = state
    state.loading = true
    onChange(state)
    try {
      const slice = await fetchSlice(seq, offset)
      if (mine !== request || invocationId !== state.invocationId || seq !== state.seq) return
      if (slice?.seq !== seq || slice.offset !== offset || (slice.invocationId != null && slice.invocationId !== invocationId)) return
      state.slice = slice
      state.error = ''
    } catch (error) {
      if (mine === request) state.error = error?.message ?? String(error)
    } finally {
      if (mine === request) { state.loading = false; onChange(state) }
    }
  }

  return {
    state,
    /** Open entry `seq` of `invocationId` at its first part, or close it when it is already open. */
    toggle (invocationId, seq) {
      if (state.seq === seq && state.invocationId === invocationId) { this.reset(); return }
      request += 1
      Object.assign(state, { invocationId, seq, slice: null, error: '' })
      starts = []
      return show(0)
    },
    next () {
      const s = state.slice
      if (state.loading || !s || s.done) return
      starts.push(s.offset)
      return show(s.offset + s.text.length)
    },
    previous () {
      if (state.loading || !starts.length) return
      return show(starts.pop())
    },
    hasPrevious: () => starts.length > 0,
    reset () {
      request += 1
      starts = []
      Object.assign(state, { invocationId: null, seq: null, slice: null, loading: false, error: '' })
      onChange(state)
    }
  }
}
