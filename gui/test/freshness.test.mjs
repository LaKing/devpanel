import {
  canonical, checkTarget, childReporter, createChildRegistry, createSeq, createTracker, describe, displayedOrInflight,
  guardPass, judgeAction, pageCurrent, pickRun, readOwn, runGuard, startedEntries, stopsForClose
} from '../src/freshness.js'

export const name = 'freshness — when a page\'s data is current, and when an action may still be sent'

/*
 * The decision logic of src/freshness.js, which the issue page and the Full verification page
 * (and the AC7 browser scenarios in freshness.browser / verification-freshness.browser) rest on.
 */

const fmt = (at) => `T${at}`
const online = (epoch = 1) => ({ status: 'online', epoch })
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

/**
 * A page as IssueView builds it: a tracker, a refresh that resolves 'ok' | 'superseded' | 'failed'
 * the way IssueView.load does, and the shipped guardPass with the page's check and send.
 * `between` runs after the action's own read and before the final check (an event arriving then).
 */
function page ({ offered = () => true, identity = () => null } = {}) {
  const state = {}
  const tracker = createTracker(state)
  const connection = online()
  const sent = []
  let reads = 0
  let duringRead = null
  let failRead = false
  async function load () {
    const t = tracker.begin()
    reads++
    const during = duringRead
    duringRead = null
    if (during) during()
    await Promise.resolve()
    if (!tracker.isLatest(t)) return 'superseded'
    if (failRead) { tracker.fail(t, 'HTTP 500'); return 'failed' }
    tracker.succeed(t, { at: 1, epoch: connection.epoch })
    return 'ok'
  }
  const pass = (before, { source = null, between = null } = {}) => () => guardPass({
    current: () => pageCurrent(state, connection),
    load,
    seq: () => state.seq,
    source: source || between ? async () => { const r = source ? await source() : { value: null, latest: () => true }; if (between) between(); return r } : null,
    check (fresh) {
      const verdict = judgeAction({ offered: offered(fresh), before, after: identity(fresh) })
      return verdict.send ? null : { reason: verdict.reason }
    },
    send (fresh) { sent.push(fresh); return 'sent' }
  })
  return {
    state, tracker, connection, sent, load, pass, reads: () => reads,
    /** The next refresh is overtaken while it reads (an event arrives). */
    overtakeNextRead: () => { duringRead = () => tracker.invalidate() },
    failReads: (v) => { failRead = v }
  }
}

export default async (t) => {
  t.section('connected and synchronized are separate (AC1, AC2)')
  {
    const s = {}
    const tr = createTracker(s)
    t.eq('nothing read yet: loading, not current', [describe(s, online(), {}, fmt).kind, describe(s, online(), {}, fmt).current], ['loading', false])
    const t1 = tr.begin()
    tr.succeed(t1, { at: 5, epoch: 1 })
    t.eq('read on this connection: current, with its time', describe(s, online(1), {}, fmt), { kind: 'current', current: true, label: 'Up to date · read T5', retry: false, readAt: 5 })
    t.eq('offline: the last read stays, marked lost', describe(s, { status: 'offline', epoch: 1 }, {}, fmt).label, 'Connection lost — showing what was read at T5')
    const connecting = describe(s, { status: 'connecting', epoch: 1 }, {}, fmt)
    t.eq('reconnecting with a current phase and the same epoch is not "Up to date"', [connecting.kind, connecting.current, connecting.label], ['connecting', false, 'Reconnecting — showing what was read at T5'])
    t.eq('online on a newer connection: behind until refreshed', [describe(s, online(2), {}, fmt).kind, describe(s, online(2), {}, fmt).current], ['behind', false])
    tr.begin()
    t.eq('a refresh outstanding on a connected socket is not current', [describe(s, online(1), {}, fmt).kind, describe(s, online(1), {}, fmt).current, describe(s, online(1), {}, fmt).label], ['refreshing', false, 'Refreshing… (last read T5)'])
  }

  t.section('a failed refresh offers Retry; only a success clears it (AC6)')
  {
    const s = {}
    const tr = createTracker(s)
    tr.succeed(tr.begin(), { at: 5, epoch: 1 })
    tr.fail(tr.begin(), new Error('HTTP 500'))
    const failed = describe(s, online(1), {}, fmt)
    t.eq('failed online: not current, Retry, last read time kept', [failed.kind, failed.current, failed.retry, failed.label], ['failed', false, true, 'Refresh failed: HTTP 500 — showing what was read at T5'])
    const off = describe(s, { status: 'offline', epoch: 1 }, {}, fmt)
    t.eq('failed then offline: Retry still offered', [off.kind, off.retry], ['offline', true])
    tr.begin()
    t.eq('Retry in flight: still not current', describe(s, online(1), {}, fmt).current, false)
    tr.succeed(s.seq, { at: 9, epoch: 1 })
    t.eq('a successful refresh clears the failure', [describe(s, online(1), {}, fmt).kind, s.error], ['current', null])
  }

  t.section('only the latest refresh publishes; an event invalidates one in flight (AC4)')
  {
    const s = {}
    const tr = createTracker(s)
    const older = tr.begin()
    const newer = tr.begin()
    t.eq('an older ticket cannot settle', [tr.succeed(older, { at: 1, epoch: 1 }), tr.isLatest(older)], [false, false])
    t.ok('the newer one can', tr.succeed(newer, { at: 2, epoch: 1 }))
    const inFlight = tr.begin()
    tr.invalidate()
    t.eq('a refresh begun before an event neither publishes nor settles', [tr.isLatest(inFlight), tr.succeed(inFlight, { at: 3, epoch: 1 }), s.phase], [false, false, 'refreshing'])
    t.eq('the read time of the last success is kept', s.syncedAt, 2)
    tr.succeed(tr.begin(), { at: 4, epoch: 1 })
    tr.invalidate()
    t.eq('invalidating a current page makes it refreshing', describe(s, online(1), {}, fmt).kind, 'refreshing')
    tr.reset()
    t.eq('navigation resets: nothing of the old issue reads current', [s.phase, s.syncedAt], ['loading', null])
  }

  t.section('a late response after navigation goes nowhere (AC4)')
  {
    const s = {}
    const tr = createTracker(s)
    const onA = tr.begin()
    tr.reset() // navigated to B
    const onB = tr.begin()
    t.eq('A\'s reply is not the latest', tr.isLatest(onA), false)
    t.ok('B\'s is', tr.succeed(onB, { at: 1, epoch: 1 }))
    const seq = createSeq()
    const a = seq.next('p/A')
    const b = seq.next('p/B')
    t.eq('a panel read for A after the key moved to B is dropped', [seq.isLatest(a, 'p/A'), seq.isLatest(b, 'p/B')], [false, true])
    const runA = seq.next('run-A')
    t.eq('a ticket for run A does not apply under run B', seq.isLatest(runA, 'run-B'), false)
  }

  t.section('panels: a pending or failed panel keeps the page from reading current (AC2)')
  {
    const s = {}
    const tr = createTracker(s)
    tr.succeed(tr.begin(), { at: 5, epoch: 1 })
    const reg = createChildRegistry({})
    reg.setKey('p/A')
    const assess = reg.register('Assessment')
    const chat = reg.register('Coordinator chat')
    assess.report('pending')
    let view = describe(s, online(1), reg.summary(), fmt)
    t.eq('a panel still loading: child-pending, not current', [view.kind, view.current, view.label], ['child-pending', false, 'Refreshing assessment… (last read T5)'])
    t.ok('the page\'s own refresh is still current for the guard', pageCurrent(s, online(1)))
    assess.report('ok', null, 7)
    chat.report('failed', new Error('HTTP 502'))
    view = describe(s, online(1), reg.summary(), fmt)
    t.eq('a failed panel under a current page: child-failed, Retry, with its read time', [view.kind, view.current, view.retry, view.label], ['child-failed', false, true, 'Coordinator chat could not be refreshed: HTTP 502 — shown as read at never'])
    chat.report('ok', null, 8)
    t.eq('every panel read: current', describe(s, online(1), reg.summary(), fmt).current, true)
    reg.setKey('p/B')
    t.eq('after navigation an old panel\'s report is ignored', [assess.report('failed', 'late'), reg.summary().childFailure], [false, null])
    const late = reg.register('Patch check')
    late.dispose()
    t.eq('a disposed panel no longer counts', late.report('pending'), false)
    const reporter = childReporter(reg, 'Time spent')
    reporter.start()
    t.eq('a reporter registers under the current key', reg.summary().childPending?.label, 'Time spent')
    reporter.dispose()
    t.eq('and leaves nothing pending when disposed', reg.summary().childPending, null)
  }

  t.section('a late report stays with the pane and issue that started the read (AC4)')
  {
    const reg = createChildRegistry({})
    reg.setKey('p/A')
    const pane = childReporter(reg, 'Assessment')
    const settleA = pane.start() // a read on issue A
    reg.setKey('p/B') // navigated to B
    t.eq('A\'s late failure after navigating to B is dropped', [settleA('failed', 'late A failure'), reg.summary().childFailure], [false, null])
    const settleB = pane.start()
    pane.dispose() // the pane left the page
    t.eq('a settle after the pane was disposed is dropped', [settleB('failed', 'late'), reg.summary().childFailure, reg.summary().childPending], [false, null, null])
    t.eq('a disposed pane starts nothing', [pane.start()('failed', 'x'), Object.keys(reg.state.entries).length], [false, 0])
  }

  t.section('a read that supersedes another settles the panel (no pending left behind)')
  {
    const reg = createChildRegistry({})
    reg.setKey('p/A')
    const pane = childReporter(reg, 'Assessment')
    const seq = createSeq()
    // A display read is held; the action's re-read takes over and succeeds.
    const display = seq.next('p/A'); pane.start()
    const reread = seq.next('p/A'); const settleReread = pane.start()
    t.eq('the held display read is no longer the latest', seq.isLatest(display, 'p/A'), false)
    settleReread('ok')
    t.eq('the re-read settled the panel: nothing pending, nothing failed', [reg.summary().childPending, reg.summary().childFailure], [null, null])
    const failed = seq.next('p/A'); const settleFailed = pane.start()
    settleFailed('failed', 'HTTP 502')
    t.eq('a failed re-read leaves a failure with Retry, not a pending forever', [reg.summary().childPending, reg.summary().childFailure?.error, seq.isLatest(failed, 'p/A')], [null, 'HTTP 502', true])
  }

  t.section('Close stops only the runs it was confirmed for (AC5)')
  {
    t.eq('the confirmed live run is stopped', stopsForClose(['r1'], ['r1']), { stop: ['r1'], unexpected: [] })
    t.eq('a run that ended meanwhile is simply not stopped', stopsForClose(['r1'], []), { stop: [], unexpected: [] })
    t.eq('a run that started after the confirmation: nothing is stopped', stopsForClose(['r1'], ['r2']), { stop: [], unexpected: ['r2'] })
    t.eq('…even beside a confirmed one', stopsForClose(['r1'], ['r1', 'r2']), { stop: [], unexpected: ['r2'] })
  }

  t.section('which run to show (AC4, AC6)')
  {
    const list = [{ runId: 'r2' }, { runId: 'r1' }]
    t.eq('a chosen run that exists', pickRun({ list, explicit: 'r1', current: 'r2' }), { runId: 'r1', missing: null })
    t.eq('a chosen run that is gone falls back to the current one and is named', pickRun({ list, explicit: 'r9', current: 'r1' }), { runId: 'r1', missing: 'r9' })
    t.eq('…or to the newest', pickRun({ list, explicit: 'r9' }), { runId: 'r2', missing: 'r9' })
    t.eq('the URL decides only a first load', [pickRun({ list, query: 'r1' }).runId, pickRun({ list, query: 'r1', current: 'r2' }).runId], ['r1', 'r2'])
    t.eq('a stale URL is passed over silently', pickRun({ list, query: 'r9' }), { runId: 'r2', missing: null })
    t.eq('no runs', pickRun({ list: [] }), { runId: null, missing: null })
  }

  t.section('an action is sent only when still offered and unchanged (AC5)')
  {
    t.eq('offered and unchanged: send', judgeAction({ offered: true, before: { a: 1, b: [2] }, after: { b: [2], a: 1 } }), { send: true })
    t.eq('no longer offered: gone', judgeAction({ offered: false, before: 1, after: 1 }), { send: false, reason: 'gone' })
    t.eq('what it acts on changed: changed', judgeAction({ offered: true, before: { pauseId: 'p1' }, after: { pauseId: 'p2' } }), { send: false, reason: 'changed' })
    t.eq('the state could not be confirmed', judgeAction({ synced: false, offered: true }), { send: false, reason: 'unconfirmed' })
    t.eq('canonical ignores key order', canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), canonical({ a: [1, { c: 3, d: 2 }], b: 1 }))
    t.eq('Close: a disposition recorded meanwhile changes what it closes', judgeAction({ offered: true, before: { variant: 'no-disposition', hasDisposition: false }, after: { variant: 'plain', hasDisposition: true } }).reason, 'changed')
    const current = { project: 'p', issueId: 'A', selectedRunId: 'r2', listedRunIds: ['r2', 'r1'] }
    t.eq('the same issue and run: ok', checkTarget({ target: { project: 'p', issueId: 'A', runId: 'r2' }, current }), { ok: true })
    t.eq('the run was replaced by a fallback: changed', checkTarget({ target: { project: 'p', issueId: 'A', runId: 'r1' }, current }), { ok: false, reason: 'changed' })
    t.eq('the run is gone: gone', checkTarget({ target: { project: 'p', issueId: 'A', runId: 'r9' }, current }), { ok: false, reason: 'gone' })
    t.eq('another issue is open: changed', checkTarget({ target: { project: 'p', issueId: 'B', runId: null }, current }), { ok: false, reason: 'changed' })
    // A page bound to issue A whose route now names B reads no current issue (IssueView currentIssue): a draft
    // entered on A, with no run, is refused rather than sent to either issue.
    t.eq('the page left the issue it opened on: a no-run write is refused', checkTarget({ target: { project: 'p', issueId: 'B', runId: null }, current: null }), { ok: false, reason: 'changed' })
    t.eq('an action that retires its run needs it listed, not selected', checkTarget({ target: { project: 'p', issueId: 'A', runId: 'r1' }, current, retires: true }), { ok: true })
    t.eq('an issue-level action has no run to match', checkTarget({ target: { project: 'p', issueId: 'A', runId: null }, current }), { ok: true })
  }

  t.section('the guard: one more check when overtaken, then a refusal (AC5)')
  {
    // A stale page: the guard refreshes first, then sends with no event in between.
    const p = page()
    p.tracker.succeed(p.tracker.begin(), { at: 1, epoch: 0 }) // read on an earlier connection
    let passes = 0
    const counted = (fn) => async () => { passes++; return fn() }
    let r = await runGuard(counted(p.pass(null)))
    t.eq('a stale page is refreshed, then the action is sent', [r.kind, passes, p.reads()], ['send', 1, 1])

    // Panels the guard's own refresh started play no part: a still-offered one-click action sends at once.
    const reg = createChildRegistry({})
    reg.setKey('k')
    const panel = reg.register('Assessment')
    panel.report('pending')
    passes = 0
    r = await runGuard(counted(p.pass(null)))
    t.eq('a panel still loading neither supersedes nor refuses an action it does not supply', [r.kind, passes], ['send', 1])

    // An event between the check and the send: one more pass, which sends.
    let once = true
    passes = 0
    r = await runGuard(counted(p.pass(null, { between: () => { if (once) { once = false; p.tracker.invalidate() } } })))
    t.eq('invalidated once: checked again, then sent', [r.kind, passes], ['send', 2])

    // Invalidated every time: refused, nothing sent.
    const before = p.sent.length
    r = await runGuard(p.pass(null, { between: () => p.tracker.invalidate() }))
    t.eq('invalidated twice: refused as superseded, nothing sent', [r, p.sent.length], [{ kind: 'refused', reason: 'superseded' }, before])

    // The refresh the guard itself runs is overtaken by an event: one more check, not a refusal.
    const q = page()
    q.tracker.succeed(q.tracker.begin(), { at: 1, epoch: 0 })
    q.overtakeNextRead()
    passes = 0
    r = await runGuard(counted(q.pass(null)))
    t.eq('a superseded refresh inside the guard is checked again, then sent', [r.kind, passes, q.reads()], ['send', 2, 2])
    q.connection.epoch = 5
    q.failReads(true)
    r = await runGuard(q.pass(null))
    t.eq('a failed refresh refuses as unconfirmed', r, { kind: 'refused', reason: 'unconfirmed' })
    q.failReads(false)
    const gone = page({ offered: () => false })
    gone.tracker.succeed(gone.tracker.begin(), { at: 1, epoch: 0 })
    gone.overtakeNextRead()
    r = await runGuard(gone.pass(null))
    t.eq('…so an action that disappeared is refused as gone, not as unconfirmed', r, { kind: 'refused', reason: 'gone' })

    // An own source overtaken by a newer read of that source.
    const seq = createSeq()
    let overtake = true
    const source = async () => {
      const ticket = seq.next('src')
      if (overtake) { overtake = false; seq.next('src') }
      return { value: { holds: true, key: 'k1' }, latest: () => seq.isLatest(ticket, 'src') }
    }
    passes = 0
    r = await runGuard(counted(p.pass(null, { source })))
    t.eq('an own-source read overtaken by a newer one: checked again', [r.kind, passes], ['send', 2])
  }

  t.section('AC7 scenarios, as decisions')
  {
    // A run moves from checking to waiting for the owner while the connection is down.
    const s = {}
    const tr = createTracker(s)
    tr.succeed(tr.begin(), { at: 5, epoch: 1 })
    let conn = { status: 'offline', epoch: 1 }
    t.eq('disconnected: the checking view stays, marked stale', [describe(s, conn, {}, fmt).kind, describe(s, conn, {}, fmt).current], ['offline', false])
    conn = online(2)
    tr.invalidate()
    const held = tr.begin()
    t.eq('reconnected with the refresh held: refreshing, never current', [describe(s, conn, {}, fmt).kind, describe(s, conn, {}, fmt).current], ['refreshing', false])
    tr.succeed(held, { at: 9, epoch: 2 })
    t.eq('after the refresh: current on the new connection', describe(s, conn, {}, fmt).kind, 'current')

    // An action that became unavailable while disconnected: the answer form of a pause already answered.
    const shown = { pauseId: 'p1', question: 'Q?' }
    const fresh = { status: 'running', pause: null }
    t.eq('the pause was answered elsewhere: the answer is not sent', judgeAction({ offered: fresh.status === 'paused' && Boolean(fresh.pause), before: shown, after: { pauseId: null, question: null } }).reason, 'gone')

    // A failed refresh, then Retry.
    const f = {}
    const ft = createTracker(f)
    ft.succeed(ft.begin(), { at: 1, epoch: 1 })
    ft.fail(ft.begin(), 'HTTP 500')
    t.eq('failed: Retry, not current', [describe(f, online(1)).retry, describe(f, online(1)).current], [true, false])

    // A late response after navigation: covered by the tracker and seq sections above.
    const late = createTracker({})
    const a = late.begin(); late.reset(); late.begin()
    t.eq('A\'s late reply after navigating to B cannot publish', late.succeed(a, { at: 1, epoch: 1 }), false)
  }

  t.section('an action\'s own read that failed after a newer one took over is superseded, not an error (AC5)')
  {
    const seq = createSeq()
    const reg = createChildRegistry({})
    reg.setKey('k')
    const pane = childReporter(reg, 'Supervisor questions')
    const gate = deferred()
    const held = readOwn(seq, 'q', async () => { await gate.promise; throw new Error('HTTP 502') }, pane)
    seq.next('q') // a newer read of the same source
    gate.resolve()
    const r = await held
    t.eq('the obsolete failure resolves as not latest, without throwing', [r.latest(), r.value], [false, undefined])
    t.eq('and marks nothing failed', reg.summary().childFailure, null)
    let thrown = null
    try { await readOwn(seq, 'q', async () => { throw new Error('HTTP 503') }, pane) } catch (e) { thrown = e.message }
    t.eq('a failure of the latest read still throws and marks the panel failed', [thrown, reg.summary().childFailure?.error], ['HTTP 503', 'HTTP 503'])

    // Through the shipped guard: the overtaken failure means one more check, which then sends.
    const p = page()
    p.tracker.succeed(p.tracker.begin(), { at: 1, epoch: 1 })
    const src = createSeq()
    let first = true
    const source = () => readOwn(src, 'q', async () => {
      if (first) { first = false; p.tracker.invalidate(); src.next('q'); throw new Error('HTTP 502') }
      return ['open question']
    })
    const sent = await runGuard(p.pass(null, { source }))
    t.eq('the guard re-checks after an overtaken source failure, then sends', [sent.kind, p.sent.at(-1)], ['send', ['open question']])

    // Only the page refreshed (its own ticket moved); the source's ticket did not: still superseded, not an error.
    const q = page()
    q.tracker.succeed(q.tracker.begin(), { at: 1, epoch: 1 })
    const qsrc = createSeq()
    let once = true
    const pageOnly = () => readOwn(qsrc, 'q', async () => {
      if (once) { once = false; q.tracker.invalidate(); throw new Error('HTTP 502') }
      return ['still open']
    })
    const again = await runGuard(q.pass(null, { source: pageOnly }))
    t.eq('a source failure while the page moved is checked again, not shown', [again.kind, q.sent.at(-1)], ['send', ['still open']])
    let surfaced = null
    const steady = page()
    steady.tracker.succeed(steady.tracker.begin(), { at: 1, epoch: 1 })
    try { await runGuard(steady.pass(null, { source: () => readOwn(createSeq(), 'q', async () => { throw new Error('HTTP 503') }) })) } catch (e) { surfaced = e.message }
    t.eq('a failure with nothing moved is still reported', surfaced, 'HTTP 503')
  }

  t.section('a guard ends with its view: a disposed view never sends (AC4)')
  {
    let alive = true
    let sends = 0
    let loads = 0
    const state = {}
    const tracker = createTracker(state)
    const pass = () => guardPass({
      refresh: 'always',
      alive: () => alive,
      current: () => pageCurrent(state, online()),
      load: async () => { loads++; const t = tracker.begin(); await Promise.resolve(); alive = false; tracker.reset(); return tracker.isLatest(t) ? 'ok' : 'superseded' },
      seq: () => state.seq,
      check: () => null,
      send: () => { sends++ }
    })
    const r = await runGuard(pass)
    t.eq('left during the pre-send read: no second read, nothing sent', [r.kind, loads, sends], ['disposed', 1, 0])
  }

  t.section('an inspection read in flight is invalidated by leaving its run, even after a return (AC4)')
  {
    const seq = createSeq()
    const before = seq.next('p/A/r1')
    seq.next(null) // the run (or issue) changed
    seq.next(null) // and came back: the next read takes a new ticket
    t.eq('the read begun before leaving is no longer latest for the same key', seq.isLatest(before, 'p/A/r1'), false)
  }

  t.section('Full verification: run requests come from the payload read; events of runs shown or loading invalidate (AC4)')
  {
    const latest = { cycle: { id: 'c2', projects: [{ project: 'p', issueId: '.verification-x', runId: 'r2' }, { project: 'q', mode: 'instance' }] } }
    t.eq('started entries are those of the payload just read', startedEntries(latest).map((e) => e.runId), ['r2'])
    t.eq('no cycle: none', startedEntries({ cycle: null }), [])
    const cycle = { projects: [{ project: 'p', issueId: 'h', runId: 'r1' }] }
    const inflight = { runs: new Set(['p/h2/r2']) }
    t.ok('a run on screen matches', displayedOrInflight({ type: 'step', project: 'p', issueId: 'h', runId: 'r1' }, { cycle, inflight }))
    t.ok('a run the refresh in flight is loading matches', displayedOrInflight({ type: 'step', project: 'p', issueId: 'h2', runId: 'r2' }, { cycle, inflight }))
    t.eq('another run does not', displayedOrInflight({ type: 'step', project: 'p', issueId: 'x', runId: 'r3' }, { cycle, inflight }), false)
    t.eq('live output never does', displayedOrInflight({ type: 'live', project: 'p', issueId: 'h', runId: 'r1' }, { cycle, inflight }), false)

    // A held run read whose refresh an event invalidated never settles.
    const s = {}
    const tr = createTracker(s)
    const ticket = tr.begin()
    const gate = deferred()
    const settled = (async () => { await gate.promise; return tr.succeed(ticket, { at: 1, epoch: 1 }) })()
    tr.invalidate() // the run took a turn while its read was held
    gate.resolve()
    t.eq('the held read cannot settle as current', await settled, false)

    // Full verification now: idle when read, but a cycle started meanwhile → checked again, then refused.
    const st = {}
    const vt = createTracker(st)
    let server = { cycle: { id: 'c1' }, active: false }
    let shownState = null
    let firstRead = true
    const sends = []
    const before = { cycleId: 'c1', active: false }
    const pass = async () => {
      const t1 = vt.begin()
      const read = server
      if (firstRead) { firstRead = false; server = { cycle: { id: 'c2' }, active: true }; vt.invalidate() } // another client started a cycle
      if (!vt.isLatest(t1)) return { kind: 'superseded' }
      shownState = read
      vt.succeed(t1, { at: 1, epoch: 1 })
      const verdict = judgeAction({ offered: !shownState.active, before, after: { cycleId: shownState.cycle.id, active: shownState.active } })
      if (!verdict.send) return { kind: 'refused', reason: verdict.reason }
      sends.push(1)
      return { kind: 'send' }
    }
    const r = await runGuard(pass)
    t.eq('Full verification now is not sent once a cycle became active', [r.kind, r.reason, sends.length], ['refused', 'gone', 0])
  }
}
