/*
 * The reconnect fixture of the live-transport test, as functions of their
 * inputs, so the same steps are proved offline (live-unit) and used against the
 * real server (live-transport.http).
 *
 *   trackReads(fetchPage)  wraps a follower's reader: counts reads in flight and
 *                          records each page with the phase it was SENT in
 *   disconnectGap(...)     disconnects only once the follower holds a committed
 *                          cursor and no read is in flight, then waits until the
 *                          log has grown at least `minMissed` entries past both
 *                          that cursor and the log's last seq at disconnect;
 *                          fails explicitly rather than accept earlier output
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function trackReads (fetchPage) {
  const pages = []
  let inflight = 0
  let phase = 'before'
  return {
    pages,
    inflight: () => inflight,
    setPhase: (next) => { phase = next },
    fetchPage: async (q) => {
      const sent = phase // classified when the request leaves, not when it answers
      inflight += 1
      try {
        const page = await fetchPage(q)
        pages.push({ q, sent, entries: page.entries?.length ?? 0, more: Boolean(page.more), bytes: page.bytes ?? null })
        return page
      } finally {
        inflight -= 1
      }
    }
  }
}

async function until (predicate, { timeout, step = 20, error }) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(error)
    await sleep(step)
  }
}

/**
 * follower: the live-follow core (its state.cursor); reads: trackReads(); disconnect(): cuts the socket;
 * lastSeq(): the persisted log's last seq now (a probe, not a viewer read).
 */
export async function disconnectGap ({ follower, reads, disconnect, lastSeq, minMissed = 60, settleTimeout = 15000, gapTimeout = 20000, settleFor = 100 }) {
  // A settled viewer: the cursor is committed and no read has been in flight for `settleFor` ms.
  let quietSince = null
  await until(() => {
    if (follower.state.cursor == null || reads.inflight() > 0) { quietSince = null; return false }
    quietSince ??= Date.now()
    return Date.now() - quietSince >= settleFor
  }, { timeout: settleTimeout, error: 'the viewer never held a committed cursor with its initial replay settled before disconnect' })
  const awayFrom = follower.state.cursor
  disconnect()
  const lastAtDisconnect = await lastSeq()
  const floor = Math.max(awayFrom, lastAtDisconnect)
  const reached = await until(async () => { const last = await lastSeq(); return last >= floor + minMissed ? last : null },
    { timeout: gapTimeout, error: `fixture produced fewer than ${minMissed} entries during disconnect` })
  return { awayFrom, lastAtDisconnect, reached }
}
