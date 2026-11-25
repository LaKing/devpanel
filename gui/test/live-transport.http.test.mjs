import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { io } from 'socket.io-client'

import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
import { createLiveFollow } from '../src/live-follow.js'
import { liveChannel } from '../src/live-subscription.js'
import { readLive, LIVE_PAGE_BYTES } from '../server/runtime/store.mjs'
import { roomFor, runRoom } from '../server/live-rooms.mjs'
import { disconnectGap, trackReads } from './live-transport-steps.mjs'

export const name = 'live transport — output only to subscribed viewers, over the real socket and HTTP paths'

/*
 * Reproducible noisy runs on a real server process (startStage, fake runtime),
 * watched by two clients at once:
 *
 *   dashboard  the real panel page at / (jsdom): status over the socket and its
 *              own HTTP refreshes; it opens no output viewer
 *   viewer     a socket.io client driving the real live-follow core, with the
 *              real HTTP catch-up
 *
 * Two issues run at once, both emitting, so a switch and a close are made while
 * the invocation left behind is still writing. Every noise chunk carries
 * `DPNOISE:<step>:<i>`, so raw output is found wherever it lands. Bytes received
 * are recorded for both clients (AC8); the test's own probes are not counted.
 */

const NL = String.fromCharCode(10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (predicate, { timeout = 30000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(40)
  }
}
const seqs = (entries) => entries.map((e) => e.seq).join(',')

export default async function (t) {
  const noise = { implement: { chunks: 2500, bytes: 1024, intervalMs: 10 } }
  const stage = await startStage({ control: { delayMs: 0, noise } })
  const project = stage.project

  // ---- the viewer: socket bytes from Engine.IO packets, HTTP bytes from the core's own reads only
  const viewerTraffic = { socketIn: 0, httpIn: 0, liveEvents: [] }
  const viewer = io(stage.origin, { transports: ['websocket'], auth: { token: stage.token } })
  viewer.io.on('open', () => viewer.io.engine.on('packet', (p) => {
    viewerTraffic.socketIn += Buffer.byteLength(typeof p.data === 'string' ? p.data : JSON.stringify(p.data ?? ''))
  }))
  viewer.on('run:event', (e) => { if (e?.type === 'live') viewerTraffic.liveEvents.push(e) })
  viewer.on('supervisor:live', (e) => viewerTraffic.liveEvents.push({ ...e, supervisor: true }))
  await new Promise((resolve, reject) => { viewer.once('connect', resolve); viewer.once('connect_error', reject) })
  const get = async (route) => {
    const response = await fetch(`${stage.origin}${route}`, { headers: { Authorization: `Bearer ${stage.token}` } })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${text}`)
    return { body: JSON.parse(text), bytes: Buffer.byteLength(text) }
  }
  /** What the viewer reads: counted. */
  const viewerGet = async (route) => { const r = await get(route); viewerTraffic.httpIn += r.bytes; return r }
  /** The test's own probes and fixture reads: not counted. */
  const probe = async (route) => (await get(route)).body
  const query = (q) => '?' + Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const ackEmit = (event, payload) => new Promise((resolve) => viewer.emit(event, payload, resolve))
  /** A round trip after everything the viewer sent before it: socket.io keeps a socket's packets in order. */
  const barrier = () => ackEmit('live:subscribe', { scope: 'supervisor', invocationId: 'barrier' }).then(() => ackEmit('live:unsubscribe', { scope: 'supervisor', invocationId: 'barrier' }))

  let dashboard = null
  try {
    // ---- the idle dashboard, open before anything runs
    dashboard = await openBrowser(stage.origin + '/', { token: stage.token })
    await dashboard.until(() => dashboard.has('Running agents'), { timeout: 15000, label: 'the dashboard' })

    const startRun = async (title) => {
      const issue = await stage.createIssue(title)
      const started = await stage.request(`/api/projects/${project}/issues/${issue.id}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
      t.eq(`${title}: the run started`, started.status, 201)
      const runId = started.body.runId
      const turn = await until(async () => (await stage.run(issue.id, runId))?.active?.find((a) => a.stepId === 'implement') ?? null, { label: `${title}: the implement turn` })
      const issuePath = path.join(stage.issuesDir, project, issue.id)
      return { issue, runId, inv: turn.invocationId, file: () => readLive(issuePath, runId, turn.invocationId), live: `/api/projects/${project}/issues/${issue.id}/runs/${runId}/live/${turn.invocationId}` }
    }
    const A = await startRun('Noisy run A')
    const B = await startRun('Noisy run B')
    await until(async () => (await A.file()).length >= 50 && (await B.file()).length >= 50, { label: 'output under way in both' })
    const noiseStartedAt = Date.now()

    // Each follower's reads, counted in flight and classified by the phase they were sent in (live-transport-steps.mjs).
    const follow = (run) => (run.reads = trackReads(async (q) => { const { body, bytes } = await viewerGet(run.live + query(q)); return Object.assign(body, { bytes }) }), createLiveFollow({
      channel: liveChannel(viewer, { scope: 'run', project, issueId: run.issue.id, runId: run.runId, invocationId: run.inv }),
      fetchPage: run.reads.fetchPage,
      live: true,
      pageLimit: 20,
      // Where the initial bounded tail actually began: the window's true start.
      onPage: (page, info) => { if (info.kind === 'tail') run.tailFirst = page.first }
    }))
    const eventsOf = (run, from = 0) => viewerTraffic.liveEvents.slice(from).filter((e) => e.invocationId === run.inv)

    // ---- (b) a viewer opened mid-turn, in the order the panel uses (tail and subscribe at once)
    t.section('(b) a viewer opened mid-turn catches up and follows (AC5)')
    const f = follow(A)
    f.start()
    await until(() => eventsOf(A).length >= 20, { label: 'live chunks on the socket' })
    t.ok('the subscribed viewer receives the invocation\'s chunks', eventsOf(A).length >= 20)
    t.eq('and none of the other run\'s', eventsOf(B).length, 0)

    // ---- (e) disconnect mid-noise; at least 60 entries are written while away
    t.section('(e) reconnecting after missed chunks (AC2, AC5)')
    // Disconnect only with a committed cursor and the initial replay settled; the missed range starts past
    // both that cursor and the log's last seq at disconnect, or the fixture fails explicitly.
    let liveBefore = null
    const { awayFrom, lastAtDisconnect, reached } = await disconnectGap({
      follower: f,
      reads: A.reads,
      disconnect: () => { A.reads.setPhase('away'); viewer.disconnect(); liveBefore = viewerTraffic.liveEvents.length },
      lastSeq: async () => (await probe(A.live + query({ tail: 1 }))).last
    })
    t.ok('the viewer held a committed cursor before it disconnected', awayFrom != null && awayFrom >= A.tailFirst, `cursor ${awayFrom}, tail from ${A.tailFirst}`)
    t.ok('and the missed range lies wholly after disconnect', reached >= Math.max(awayFrom, lastAtDisconnect) + 60, `${awayFrom}/${lastAtDisconnect} -> ${reached}`)
    t.eq('nothing arrives while disconnected', viewerTraffic.liveEvents.length, liveBefore)
    A.reads.setPhase('reconnect')
    viewer.connect()
    await until(() => f.state.cursor >= reached, { label: 'the reconnect catch-up' })
    const pages = A.reads.pages
    const afterPages = pages.filter((p) => p.sent === 'reconnect' && p.q.after != null)
    t.ok('at least 3 pages were read after the reconnect', afterPages.length >= 3, `${afterPages.length}`)
    t.ok('at least 2 of them said there was more', afterPages.filter((p) => p.more).length >= 2, afterPages.map((p) => `${p.entries}${p.more ? '+' : ''}`).join(' '))
    t.ok('every page held at most 20 entries', pages.filter((p) => p.q.limit === 20).every((p) => p.entries <= 20))
    t.ok('every bounded page body fit the byte bound', pages.every((p) => p.bytes <= LIVE_PAGE_BYTES))
    // One point in the stream: the cursor and the window are taken together, before any await; the file
    // is append-only, so reading it afterwards and cutting it at that cursor describes the same point.
    const fixedCursor = f.state.cursor
    const held = f.state.entries.slice()
    const fileA = await A.file()
    const expected = fileA.filter((e) => e.seq >= A.tailFirst && e.seq <= fixedCursor)
    t.ok('the window starts where the initial bounded tail began', A.tailFirst != null && held[0]?.seq === A.tailFirst, `${held[0]?.seq} vs tail ${A.tailFirst}`)
    t.eq('(b)(e) from there to the fixed cursor the viewer holds the persisted log exactly: same seqs, in order, no duplicates', seqs(held), seqs(expected))
    t.ok('the reconnect really replayed missed entries', fixedCursor >= reached && held.some((e) => e.seq > awayFrom && e.seq <= reached), `${awayFrom} -> ${fixedCursor}`)

    // ---- (d) switch from A to B while A is still emitting, through the production path only
    t.section('(d) switching to another invocation (AC2)')
    t.ok('A is still running when the viewer switches', (await A.file()).at(-1)?.kind !== 'exit')
    f.close()
    const g = follow(B)
    g.start()
    await until(() => g.state.cursor != null && eventsOf(B).length > 0, { label: 'B chunks after the switch' })
    await barrier()
    const switchedAt = viewerTraffic.liveEvents.length
    const aBefore = (await A.file()).at(-1).seq
    await sleep(1000)
    const aAfter = (await A.file()).at(-1).seq
    t.ok('A kept writing during the observation', aAfter - aBefore >= 20, `${aBefore} -> ${aAfter}`)
    t.eq('none of it reached the viewer after it switched', eventsOf(A, switchedAt).length, 0)
    t.ok('while B\'s chunks keep arriving', eventsOf(B, switchedAt).length > 0)

    // ---- (c) close while B is still emitting, through the production path only
    t.section('(c) closing the viewer (AC2)')
    t.ok('B is still running when the viewer closes', (await B.file()).at(-1)?.kind !== 'exit')
    const gHeld = g.state.entries.slice()
    g.close()
    await barrier()
    const closedAt = viewerTraffic.liveEvents.length
    const bBefore = (await B.file()).at(-1).seq
    await sleep(1000)
    const bAfter = (await B.file()).at(-1).seq
    t.ok('B kept writing during the observation', bAfter - bBefore >= 20, `${bBefore} -> ${bAfter}`)
    t.eq('none of it reached the closed viewer', viewerTraffic.liveEvents.length - closedAt, 0)

    // ---- the runs settle; then the supervisor speaks
    for (const run of [A, B]) {
      await until(async () => { const [r] = await stage.runs(run.issue.id); return r && !['preflighting', 'pending', 'running', 'stopping'].includes(r.status) }, { timeout: 120000, label: 'the runs to settle' })
    }

    t.section('(f) supervisor output is viewer-scoped too (AC6)')
    const modelFile = path.join(stage.configRoot, 'roster/opus-5.yaml')
    const model = YAML.parse(await fs.readFile(modelFile, 'utf8'))
    model.harness = 'claude'
    model.verification.status = 'verified'
    await fs.writeFile(modelFile, YAML.stringify(model))
    await fs.writeFile(path.join(stage.harnessDir, 'claude.mjs'), [
      'export async function invoke (args) {',
      '  for (let i = 0; i < 200; i++) {',
      "    args.observe?.onOutput?.('stdout', `DPNOISE:supervisor:${i} ` + '.'.repeat(200) + String.fromCharCode(10))",
      '    await new Promise((resolve) => setTimeout(resolve, 20))',
      '  }',
      "  return { session: args.session ?? { id: 'transport-supervisor' }, response: JSON.stringify({ message: 'done', action: null }), usage: { costUsd: null } }",
      '}'
    ].join(NL) + NL)
    const start = await stage.request('/api/supervisor/start', { method: 'POST', body: JSON.stringify({ model: 'opus-5', projects: [project], message: 'Watch the queue', limits: { maxCalls: 2, maxRuns: 1, maxConcurrent: 1 } }) })
    t.eq('the supervisor started', [start.status, start.body?.error ?? null], [201, null])
    const supInv = await until(async () => (await probe('/api/supervisor'))?.pending?.invocationId ?? null, { label: 'the supervisor call' })
    const supBefore = viewerTraffic.liveEvents.length
    const s = createLiveFollow({
      channel: liveChannel(viewer, { scope: 'supervisor', invocationId: supInv }),
      fetchPage: async (q) => (await viewerGet(`/api/supervisor/live/${supInv}` + query(q))).body,
      live: true,
      pageLimit: 20
    })
    s.start()
    const full = await until(async () => {
      const page = await probe(`/api/supervisor/live/${supInv}`)
      return page.entries.filter((e) => e.text?.startsWith('DPNOISE:supervisor:')).length >= 200 ? page : null
    }, { label: 'the supervisor call to finish its output' })
    await until(() => s.state.cursor >= full.entries.at(-1).seq, { label: 'the supervisor viewer to catch up' })
    const noiseRows = s.state.entries.filter((e) => e.text?.startsWith('DPNOISE:supervisor:')).map((e) => parseInt(e.text.split(':')[2], 10))
    t.eq('the viewer holds exactly supervisor-noise 0..199, in order', noiseRows.join(','), Array.from({ length: 200 }, (_, i) => i).join(','))
    t.eq('and equals the full legacy read of the supervisor log', seqs(s.state.entries), seqs(full.entries))
    t.ok('the stub\'s output arrived on the socket too', viewerTraffic.liveEvents.slice(supBefore).some((e) => e.supervisor && e.entry?.text?.startsWith('DPNOISE:supervisor:')))
    const sHeld = s.state.entries.slice()
    s.close()

    t.section('(g) subscription identities and bounds')
    const odd = { scope: 'run', project: 'Example Team-project', issueId: '.verification-2026-11-25', runId: 'r1', invocationId: 'inv-1' }
    t.eq('a project name with spaces and a run-home issue id are accepted', (await ackEmit('live:subscribe', odd)).ok, true)
    t.eq('the room is the one the emitter builds from the event', roomFor(odd), runRoom(odd.project, odd.issueId, odd.runId, odd.invocationId))
    t.eq('a malformed subscription is refused', (await ackEmit('live:subscribe', { scope: 'run', project: 'p', issueId: 'i', runId: 'r', invocationId: 'a\0b' })).ok, false)
    t.eq('so is a non-string id', (await ackEmit('live:subscribe', { scope: 'supervisor', invocationId: 42 })).ok, false)
    await ackEmit('live:unsubscribe', odd)
    const answers = []
    for (let i = 0; i < 65; i++) answers.push((await ackEmit('live:subscribe', { scope: 'supervisor', invocationId: `room-${i}` })).ok)
    t.eq('64 live rooms per connection, the 65th refused', [answers.slice(0, 64).every(Boolean), answers[64]], [true, false])

    t.section('(a)(h) the idle dashboard: status, no output, bytes recorded (AC1, AC3, AC8, AC9)')
    // Socket frames arrive as WebSocket messages, or as polling response bodies before the upgrade.
    const bodies = dashboard.traffic.httpBodies
    const frames = [...dashboard.traffic.frames, ...bodies.filter((b) => b.url.includes('/socket.io/')).map((b) => b.text)]
    t.ok('the dashboard received non-live run events', frames.some((f) => f.includes('"run:event"') && !f.includes('"type":"live"')))
    t.ok('and issue and supervisor status changes', frames.some((f) => f.includes('"issues:changed"')) && frames.some((f) => f.includes('"supervisor:changed"')))
    t.ok('it refreshed its status over HTTP during the noisy run', ['/api/agents', '/api/attention'].every((u) => bodies.some((b) => b.url.includes(u) && b.at >= noiseStartedAt)) && bodies.some((b) => b.url.includes('/api/supervisor')))
    const liveFrames = frames.filter((f) => f.includes('"type":"live"') || f.includes('supervisor:live')).length
    const frameMarkers = frames.filter((f) => f.includes('DPNOISE:')).length
    const httpMarkers = bodies.filter((b) => b.text.includes('DPNOISE:')).length
    t.eq('no live frame reached the dashboard', liveFrames, 0)
    t.eq('no raw output in any frame it received', frameMarkers, 0)
    t.eq('no raw output in any HTTP body it received', httpMarkers, 0)
    const viewerText = viewerTraffic.liveEvents.map((e) => e.entry?.text ?? '').join('')
    t.ok('positive control: the viewer did receive the markers', viewerText.includes('DPNOISE:implement:') && viewerText.includes('DPNOISE:supervisor:'))

    // What the viewer watched: the entries its three follows committed.
    const watchedBytes = [...f.state.entries, ...gHeld, ...sHeld].reduce((n, e) => n + Buffer.byteLength(e.text ?? ''), 0)
    const report = {
      noiseBytesPerRun: noise.implement.chunks * noise.implement.bytes,
      watchedBytes,
      dashboard: { socketIn: dashboard.traffic.socketIn, httpIn: dashboard.traffic.httpIn, liveFrames, httpOutputMarkers: httpMarkers },
      viewer: { socketIn: viewerTraffic.socketIn, httpIn: viewerTraffic.httpIn, liveEvents: viewerTraffic.liveEvents.length },
      note: 'socketIn counts Engine.IO packet payloads (viewer) or WebSocket message data (dashboard); httpIn counts response bodies of the client\'s own reads, headers and the test\'s probes excluded'
    }
    await fs.mkdir(stage.logDir, { recursive: true })
    await fs.writeFile(path.join(stage.logDir, 'live-transport-bytes.json'), JSON.stringify(report, null, 2))
    t.ok('bytes recorded for both clients (live-transport-bytes.json)', true, JSON.stringify(report))
    t.ok('the viewer received at least the output it watched', viewerTraffic.socketIn + viewerTraffic.httpIn >= watchedBytes, `${viewerTraffic.socketIn + viewerTraffic.httpIn} >= ${watchedBytes}`)
    t.ok('the dashboard received less than the output the viewer watched', dashboard.traffic.socketIn + dashboard.traffic.httpIn < watchedBytes, `${dashboard.traffic.socketIn + dashboard.traffic.httpIn} < ${watchedBytes}`)
  } finally {
    viewer.close()
    dashboard?.window?.close?.()
    await stage.stop()
  }
}
