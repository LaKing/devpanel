import { createLiveFollow, createSlicer } from '../src/live-follow.js'
import { createRenderer, keepTail, MAX_PARTIAL } from '../src/terminal-format.js'
import { pageLive } from '../server/runtime/store.mjs'
import { disconnectGap, trackReads } from './live-transport-steps.mjs'

export const name = 'live follow — one cursor for socket chunks and bounded HTTP pages'

/*
 * The core of every live viewer (src/live-follow.js), against a fake channel
 * and a fake HTTP reader whose answers the test releases one at a time, from a
 * "file" served by the real bounded reader (store.pageLive).
 */

const NL = String.fromCharCode(10)
const e = (seq) => ({ seq, at: null, kind: 'stdout', text: `${seq}${NL}` })
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => e(a + i))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const seqs = (entries) => entries.map((x) => x.seq).join(',')
const ascending = (entries) => entries.every((x, i) => i === 0 || x.seq > entries[i - 1].seq)

function fakeChannel () {
  const c = { subs: 0, unsubs: 0, acks: [], entry: null, connect: null }
  c.subscribe = () => { c.subs += 1; return new Promise((resolve) => c.acks.push(resolve)) }
  c.unsubscribe = () => { c.unsubs += 1 }
  c.onEntry = (fn) => { c.entry = fn }
  c.onConnect = (fn) => { c.connect = fn }
  c.close = () => {}
  c.ack = async (ok = true) => { c.acks.shift()({ ok }); await tick() }
  c.send = async (entry, prev) => { c.entry({ type: 'live', entry, prev }); await tick() }
  return c
}

/** Requests wait until the test serves them from `file` (or with a fixed page). */
function fakeReader (file) {
  const reqs = []
  const fetchPage = (q) => new Promise((resolve, reject) => reqs.push({ q, resolve, reject }))
  const serve = async (page) => {
    const r = reqs.shift()
    if (!r) throw new Error('no request waiting')
    r.resolve({ live: true, ...(page ?? pageLive(file, r.q)) })
    await tick()
    return r.q
  }
  const serveAll = async (max = 100) => { const asked = []; while (reqs.length && max--) asked.push(await serve()); return asked }
  return { reqs, fetchPage, serve, serveAll }
}

export default async function (t) {
  t.section('1. a hole the log left on purpose commits; a missed delivery is read back (catchup-order)')
  {
    const file = [e(1), e(2), e(3), e(5)]
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    t.eq('the tail holds the persisted entries, hole included', seqs(f.state.entries), '1,2,3,5')
    file.push(e(7))
    await ch.send(e(7), 5)
    t.eq('a chunk whose prev is the cursor commits with no request (5 -> 7, nothing between)', [seqs(f.state.entries), rd.reqs.length], ['1,2,3,5,7', 0])
    file.push(e(8), e(9))
    await ch.send(e(9), 8)
    t.eq('a chunk after a missed one waits', seqs(f.state.entries), '1,2,3,5,7')
    t.eq('and asks for what follows the cursor', rd.reqs[0]?.q?.after, 7)
    await rd.serveAll()
    t.eq('the page fills the gap and the waiting chunk is not doubled', seqs(f.state.entries), '1,2,3,5,7,8,9')

    // A page that starts at a hole commits and does not stall.
    const ch2 = fakeChannel()
    const file2 = [e(1), e(2), e(3)]
    const rd2 = fakeReader(file2)
    const g = createLiveFollow({ channel: ch2, fetchPage: rd2.fetchPage, live: true })
    g.start()
    await rd2.serve()
    await ch2.ack()
    await rd2.serveAll()
    file2.push(e(5), e(6))
    await ch2.send(e(6), 5)
    t.eq('after=3 answered with 5,6 commits both', [rd2.reqs[0]?.q?.after, (await rd2.serveAll()).length, seqs(g.state.entries)], [3, 1, '1,2,3,5,6'])
  }

  t.section('2. a reconnect replays from its cursor across any gap, in bounded pages (large-reconnect-gap)')
  {
    const file = range(1, 100)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, pageLimit: 500 })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    file.push(...range(101, 6100))
    await ch.connect()
    await ch.ack()
    const asked = await rd.serveAll()
    t.eq('pages followed the cursor from 100 to 6100', asked.map((q) => q.after).join(','), Array.from({ length: 12 }, (_, i) => 100 + i * 500).join(','))
    t.ok('no tail was read again', asked.every((q) => q.tail == null))
    t.eq('the window holds the newest 5000, in order', [f.state.entries.length, f.state.entries[0].seq, f.state.entries.at(-1).seq, ascending(f.state.entries)], [5000, 1101, 6100, true])
    t.eq('what was dropped can be loaded again', f.state.earlier, true)
  }

  t.section('3. clearing pending keeps the replay going past an older snapshot (pending-overflow)')
  {
    const file = range(1, 100)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, pendingEntries: 5 })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    file.push(...range(101, 120))
    await ch.send(e(121), 120)
    const held = rd.reqs[0]
    t.eq('a catch-up from 100 is asked for', held?.q?.after, 100)
    file.push(...range(121, 140))
    for (let s = 122; s <= 140; s++) await ch.send(e(s), s - 1)
    // The held answer is a snapshot through 120 that says nothing more is there.
    await rd.serve({ entries: range(101, 120), next: 120, last: 120, more: false })
    t.eq('the core asks again from 120 although that page said no more', rd.reqs[0]?.q?.after, 120)
    await rd.serveAll()
    t.eq('and commits through 140', [f.state.entries.at(-1).seq, f.state.entries.length, ascending(f.state.entries)], [140, 140, true])
  }

  t.section('4. the initial tail sets the cursor once, whichever answers first (initial-tail-race)')
  for (const order of ['ack, chunks, then tail', 'tail, then ack']) {
    const file = range(1, 120)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const cursors = []
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, onChange: (s) => cursors.push(s.cursor) })
    f.start()
    const tailReq = rd.reqs[0]
    const snapshot = pageLive(file, tailReq.q)
    file.push(...range(121, 150))
    if (order.startsWith('ack')) {
      await ch.ack()
      for (let s = 121; s <= 150; s++) await ch.send(e(s), s - 1)
      await rd.serve(snapshot)
    } else {
      await rd.serve(snapshot)
      for (let s = 121; s <= 150; s++) await ch.send(e(s), s - 1)
      await ch.ack()
    }
    await rd.serveAll()
    t.eq(`${order}: 1..150 once each, in order`, seqs(f.state.entries), seqs(range(1, 150)))
    t.ok(`${order}: the cursor never went back`, cursors.every((c, i) => i === 0 || c >= cursors[i - 1]), cursors.join(','))
  }

  t.section('5. a rejoin during a catch-up still reads again (reconnect-during-catchup)')
  for (const checkGeneration of [true, false]) {
    const file = range(1, 100)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, checkGeneration })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    file.push(...range(101, 120))
    await ch.send(e(121), 120) // starts a catch-up from 100 (gen 1)
    const before = rd.reqs.length
    t.eq('a gen-1 read after=100 is in flight', [before, rd.reqs[0].q.after], [1, 100])
    // Disconnected: 121–140 are written and never delivered on the socket.
    file.push(...range(121, 140))
    await ch.connect()
    await ch.ack() // rejoin while the gen-1 read is held: gen 2
    await rd.serve({ entries: range(101, 120), next: 120, last: 120, more: false })
    const followUps = await rd.serveAll()
    if (checkGeneration) {
      t.eq('exactly one follow-up, from the cursor the stale page left (120, then the held 121)', followUps.map((q) => q.after).join(','), '121')
      t.eq('the window is 1…140 in order, no duplicates', seqs(f.state.entries), seqs(range(1, 140)))
    } else {
      t.eq('control without the generation check: it stops at 121, the chunk it held', f.state.entries.at(-1).seq, 121)
      t.ok('control: 122–140 were never read', !f.state.entries.some((x) => x.seq === 130))
    }
  }

  t.section('6. a viewer that is hidden, or not live, holds no room (hidden-viewer)')
  {
    const ch = fakeChannel()
    const rd = fakeReader(range(1, 10))
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, active: false })
    f.start()
    t.eq('mounted hidden: the tail is read, nothing is subscribed', [rd.reqs.length, rd.reqs[0].q.tail, ch.subs], [1, 1000, 0])
    await rd.serve()
    t.eq('still nothing subscribed once the tail is in', ch.subs, 0)
    f.setActive(true)
    t.eq('shown: it subscribes', ch.subs, 1)
    await ch.ack()
    t.eq('and catches up from its cursor once acked', rd.reqs[0]?.q?.after, 10)
    await rd.serveAll()
    f.setActive(false)
    t.eq('hidden again: it leaves the room', ch.unsubs, 1)
    await ch.send(e(11), 10)
    t.eq('and a chunk that still arrives is not committed', f.state.entries.at(-1).seq, 10)

    const ch2 = fakeChannel()
    const rd2 = fakeReader(range(1, 3))
    const g = createLiveFollow({ channel: ch2, fetchPage: rd2.fetchPage, live: false })
    g.start()
    await rd2.serve({ entries: range(1, 3), next: 3, first: 1, last: 3, more: false, earlier: false, live: false })
    t.eq('a finished invocation never subscribes', ch2.subs, 0)
  }

  t.section('7. earlier output, detaching and back to the latest; polling without a room')
  {
    const file = range(1, 3000)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    t.eq('the tail is bounded and says there is more before it', [f.state.entries.length, f.state.earlier], [1000, true])
    const loading = f.loadEarlier()
    const q = await rd.serve()
    await loading
    t.eq('earlier is read before the first entry held', q.before, 2001)
    t.eq('prepended in order', [f.state.entries[0].seq, f.state.entries.at(-1).seq, ascending(f.state.entries)], [1501, 3000, true])
    t.eq('reading history detaches from the live stream', [f.state.detached, ch.unsubs], [true, 1])
    f.jumpToLatest()
    t.eq('back to the latest: subscribe and read the tail again', [ch.subs, rd.reqs[0]?.q?.tail], [2, 1000])

    const ch2 = fakeChannel()
    const rd2 = fakeReader(range(1, 5))
    const g = createLiveFollow({ channel: ch2, fetchPage: rd2.fetchPage, live: true, pollMs: 20 })
    g.start()
    await rd2.serve()
    await ch2.ack(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    t.ok('a refused subscription reads by polling', g.state.polling && rd2.reqs.length >= 1 && rd2.reqs[0].q.after === 5)
    g.close()
  }

  t.section('8. clipped chunks and the terminal stay bounded (oversized-entry-delivery, terminal-buffer)')
  {
    const ch = fakeChannel()
    const rd = fakeReader([e(1)])
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    await ch.send({ seq: 2, kind: 'stdout', text: 'x'.repeat(100), sliced: { total: 5_000_000, offset: 0, length: 100 } }, 1)
    t.eq('a clipped chunk is committed as delivered, marked for the pager', [f.state.entries.at(-1).seq, f.state.entries.at(-1).sliced.total], [2, 5_000_000])

    const r = createRenderer()
    let maxHeld = 0
    for (let i = 0; i < 200; i++) { r.write({ seq: i + 1, kind: 'stdout', text: 'y'.repeat(32 * 1024) }); maxHeld = Math.max(maxHeld, r.pendingBytes()) }
    t.ok('a newline-free stream never holds more than MAX_PARTIAL in the renderer', maxHeld <= MAX_PARTIAL + 32 * 1024 && r.pendingBytes() <= MAX_PARTIAL, `${maxHeld}`)
    t.eq('the plain-text terminal keeps at most its bound', keepTail('z'.repeat(3 * 1024 * 1024), 2 * 1024 * 1024).length <= 2 * 1024 * 1024, true)
  }

  // ---- regressions from the implementation review (report 017), each its probe scenario

  t.section('9. hidden mid-catch-up: nothing more is committed or asked for; shown, it resumes from the cursor (hidden-http-replay)')
  {
    const file = range(1, 4)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, pageLimit: 2 })
    f.start()
    await rd.serve({ entries: [], next: 0, first: null, last: 0, more: false, earlier: false })
    await ch.ack()
    t.eq('a catch-up after=0&limit=2 is in flight', [rd.reqs[0]?.q?.after, rd.reqs[0]?.q?.limit], [0, 2])
    f.setActive(false)
    await rd.serve() // 1–2, more: true — answered after the viewer was hidden
    t.eq('the answer is not committed', f.state.entries.length, 0)
    t.eq('and no further page is asked for', rd.reqs.length, 0)
    f.setActive(true)
    await ch.ack()
    t.eq('shown again: it reads from its committed cursor', rd.reqs[0]?.q?.after, 0)
    await rd.serveAll()
    t.eq('and catches up in order', seqs(f.state.entries), '1,2,3,4')
  }

  t.section('10. a failed read never drops what is owed; a failed tail is read again (reconnect-read-failure)')
  {
    const file = range(1, 4)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, retryMs: 10 })
    f.start()
    await rd.serve({ entries: range(1, 2), next: 2, first: 1, last: 2, more: false, earlier: false })
    await ch.ack()
    const held = rd.reqs.shift() // the gen-1 catch-up from 2
    await ch.connect()
    await ch.ack() // rejoin while it is outstanding
    held.reject(new Error('network'))
    await new Promise((resolve) => setTimeout(resolve, 40))
    t.eq('after the rejected read a new one asks from the cursor', rd.reqs[0]?.q?.after, 2)
    await rd.serveAll()
    t.eq('and the owed entries are committed', seqs(f.state.entries), '1,2,3,4')

    const ch2 = fakeChannel()
    const rd2 = fakeReader(range(1, 3))
    const g = createLiveFollow({ channel: ch2, fetchPage: rd2.fetchPage, live: true, retryMs: 10 })
    g.start()
    rd2.reqs.shift().reject(new Error('tail failed'))
    await tick()
    await ch2.ack()
    await ch2.send(e(4), 3)
    await new Promise((resolve) => setTimeout(resolve, 40))
    t.eq('the tail is asked for again', rd2.reqs[0]?.q?.tail, 1000)
    rd2.reqs.length && await rd2.serve({ entries: range(1, 3), next: 3, first: 1, last: 3, more: false, earlier: false })
    await rd2.serveAll()
    t.eq('the cursor is initialized and the waiting chunk lands', [g.state.cursor, seqs(g.state.entries)], [4, '1,2,3,4'])
    f.close(); g.close()
  }

  t.section('11. Load earlier: one request at a time, and the window cannot move under it (earlier-page-race)')
  {
    const file = range(1, 10)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, tail: 5, pageLimit: 2 })
    f.start()
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    t.eq('the tail holds 6..10', seqs(f.state.entries), '6,7,8,9,10')
    const a = f.loadEarlier()
    const b = f.loadEarlier()
    t.eq('a second Load earlier joins the first: one request', [a === b, rd.reqs.length, rd.reqs[0]?.q?.before], [true, 1, 6])
    file.push(e(11))
    await ch.send(e(11), 10) // live output while the history read is outstanding
    await rd.serve()
    await a
    t.eq('prepended once, the window unchanged at its end (no 5,6,5; no 5,6,10)', seqs(f.state.entries), '4,5,6,7,8,9,10')
    t.eq('history detached the viewer before it asked', [f.state.detached, ch.unsubs], [true, 1])
  }

  t.section('12. the window and pending caps count serialized UTF-8 bytes (browser-byte-budget)')
  {
    const { clipForDelivery } = await import('../server/runtime/store.mjs')
    const ch = fakeChannel()
    const rd = fakeReader([])
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true })
    f.start()
    await rd.serve({ entries: [], next: 0, first: null, last: 0, more: false, earlier: false })
    await ch.ack()
    await rd.serveAll()
    for (let s = 1; s <= 20; s++) await ch.send(clipForDelivery({ seq: s, at: 't', kind: 'stdout', text: '漢'.repeat(400 * 1024) }), s - 1)
    const held = f.state.entries.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x)), 0)
    t.ok('20 clipped CJK records: what the window holds stays within 4 MiB serialized', held <= 4 * 1024 * 1024, `${held} bytes in ${f.state.entries.length} entries`)
    t.ok('and it still holds the newest, in order', f.state.entries.at(-1).seq === 20 && ascending(f.state.entries))
  }

  t.section('13. a clipped chunk\'s parts are bound to their request (slice-navigation-race)')
  {
    const big = { A: 'a'.repeat(250), B: 'b'.repeat(250) }
    const calls = []
    const fetchSlice = (seq, offset) => new Promise((resolve) => calls.push({ seq, offset, resolve }))
    const answer = (c, inv = 'inv-1') => { const text = big[c.seq].slice(c.offset, c.offset + 100); c.resolve({ invocationId: inv, seq: c.seq, offset: c.offset, text, total: 250, done: c.offset + text.length >= 250 }) }
    const s = createSlicer({ fetchSlice })
    s.toggle('inv-1', 'A')
    s.toggle('inv-1', 'B')
    t.eq('opening another chunk clears the old part at once', s.state.slice, null)
    answer(calls[1]); await tick()
    answer(calls[0]); await tick()
    t.eq('a slower answer for chunk A never overwrites chunk B', s.state.slice?.text[0], 'b')
    s.next()
    s.next() // a second click while the first is loading
    t.eq('overlapping Next clicks issue one request', calls.length, 3)
    answer(calls[2]); await tick()
    t.eq('the next part follows the one shown', [s.state.slice.offset, s.hasPrevious()], [100, true])
    s.previous()
    answer(calls[3], 'inv-2'); await tick()
    t.eq('an answer for another invocation is dropped', s.state.slice.offset, 100)
  }

  // ---- regressions from the implementation review (report 020), each its probe scenario

  t.section('14. hidden: no automatic tail retry fires; shown, initialization resumes (hidden-http-replay)')
  {
    const ch = fakeChannel()
    const rd = fakeReader(range(1, 3))
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true, retryMs: 10 })
    f.start()
    f.setActive(false)
    rd.reqs.shift().reject(new Error('tail failed')) // the in-flight initial tail fails while hidden
    await new Promise((resolve) => setTimeout(resolve, 60))
    t.eq('while hidden no new tail request is made', rd.reqs.length, 0)
    f.setActive(true)
    t.eq('shown: the tail is read again', rd.reqs[0]?.q?.tail, 1000)
    await rd.serve()
    await ch.ack()
    await rd.serveAll()
    t.eq('and the viewer is initialized', [f.state.cursor, seqs(f.state.entries)], [3, '1,2,3'])

    // A failing catch-up retry is cancelled by hiding too.
    const ch2 = fakeChannel()
    const rd2 = fakeReader(range(1, 2))
    const g = createLiveFollow({ channel: ch2, fetchPage: rd2.fetchPage, live: true, retryMs: 10 })
    g.start()
    await rd2.serve()
    await ch2.ack()
    rd2.reqs.shift().reject(new Error('network'))
    g.setActive(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    t.eq('a pending catch-up retry does not fire while hidden', rd2.reqs.length, 0)
    f.close(); g.close()
  }

  t.section('15. chunks the current page drains do not force another read (unnecessary-replay-loop)')
  {
    const file = []
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const f = createLiveFollow({ channel: ch, fetchPage: rd.fetchPage, live: true })
    f.start()
    await rd.serve({ entries: [], next: 0, first: null, last: 0, more: false, earlier: false })
    let reads = 0
    for (let s = 1; s <= 8; s++) {
      // A new join asks for one read; while it is outstanding one gap-free chunk arrives.
      if (s > 1) await ch.connect()
      await ch.ack()
      t.ok(`cycle ${s}: one read is outstanding`, rd.reqs.length === 1, `${rd.reqs.length}`)
      file.push(e(s))
      await ch.send(e(s), s - 1)
      await rd.serve({ entries: [], next: s - 1, first: null, last: s - 1, more: false, earlier: false }) // its snapshot predates the chunk
      reads += 1
      t.eq(`cycle ${s}: the chunk is drained in order and no further read follows`, [f.state.cursor, rd.reqs.length], [s, 0])
    }
    t.eq('eight joins, eight reads, nothing outstanding', [reads, rd.reqs.length, seqs(f.state.entries)], [8, 0, '1,2,3,4,5,6,7,8'])
    f.close()
  }

  // ---- regression from the implementation review (report 023): the transport fixture's disconnect baseline

  t.section('16. the reconnect fixture disconnects only from a settled cursor and measures the gap after it (transport-disconnect-before-cursor)')
  {
    // The auditor's probe: 20 socket events arrive while the initial tail is held.
    const file = range(1, 100)
    const ch = fakeChannel()
    const rd = fakeReader(file)
    const reads = trackReads(rd.fetchPage)
    const f = createLiveFollow({ channel: ch, fetchPage: reads.fetchPage, live: true, pageLimit: 20 })
    f.start()
    await ch.ack()
    for (let s = 81; s <= 100; s++) await ch.send(e(s), s - 1)
    t.eq('20 socket events in, the tail still held: no cursor yet', f.state.cursor, null)
    let disconnected = false
    const lastSeq = async () => file.at(-1).seq
    const gap = disconnectGap({ follower: f, reads, disconnect: () => { disconnected = true; reads.setPhase('away') }, lastSeq, minMissed: 60, settleTimeout: 2000, gapTimeout: 2000, settleFor: 20 })
    await new Promise((resolve) => setTimeout(resolve, 80))
    t.eq('the fixture does not disconnect while the cursor is null', disconnected, false)
    await rd.serveAll() // the tail lands (and the catch-up after it)
    await new Promise((resolve) => setTimeout(resolve, 80))
    t.eq('it disconnects once the cursor is committed and no read is in flight', [disconnected, f.state.cursor], [true, 100])
    const early = await Promise.race([gap.then(() => 'resolved'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 60))])
    t.eq('pre-disconnect output (seq 100) is not accepted as the missed range', early, 'waiting')
    file.push(...range(101, 160))
    const { awayFrom, lastAtDisconnect, reached } = await gap
    t.eq('the gap is measured past both the cursor and the log at disconnect', [awayFrom, lastAtDisconnect, reached], [100, 100, 160])

    // A request sent before the reconnect but answered after it is not a reconnect read.
    reads.setPhase('away')
    const held = reads.fetchPage({ after: 100, limit: 20 })
    reads.setPhase('reconnect')
    await rd.serve()
    await held
    t.eq('reads are classified by when they were sent', reads.pages.at(-1).sent, 'away')

    // Never settles: the fixture fails explicitly instead of disconnecting.
    const ch2 = fakeChannel()
    const rd2 = fakeReader(range(1, 5))
    const reads2 = trackReads(rd2.fetchPage)
    const g = createLiveFollow({ channel: ch2, fetchPage: reads2.fetchPage, live: true })
    g.start()
    let cut = false
    const failed = await disconnectGap({ follower: g, reads: reads2, disconnect: () => { cut = true }, lastSeq: async () => 5, settleTimeout: 100, gapTimeout: 100 }).then(() => null, (error) => error.message)
    t.ok('with the tail never read it fails explicitly and never disconnects', /never held a committed cursor/.test(failed ?? '') && !cut, failed ?? 'resolved')
    f.close(); g.close()
  }
}
