import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createNotifier, itemLink, validKeys } from '../server/notifications/notifier.mjs'
import { offersTurnOffAll, optOutSentences } from '../src/notifications.js'

/*
 * Operator alerts with a fake push transport (docs/operator-alerts.md): opt-in and opt-out, both transitions,
 * grouping, retries, deduplication across a restart, crash repair, and alert pages for handled items.
 */

const T0 = Date.parse('2026-11-25T10:00:00Z')
const iso = (ms) => new Date(ms).toISOString()
const keys = () => {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys()
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
}
const endpoint = (n) => `https://fcm.googleapis.com/fcm/send/device-${n}`
const until = async (cond) => { for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setImmediate(r)) }

function harness (dir, { items = [], clockAt = T0, respond = null, readRun, getQuestion, scanMs = 0, maxGroupWaitMs, log = () => {} } = {}) {
  const clock = { ms: clockAt, now: () => clock.ms }
  respond ??= () => Promise.resolve({ outcome: 'accepted', status: 201, endedAt: iso(clock.ms) })
  const world = { items, calls: [], unread: [], unreadRuns: [] }
  const transport = { publicKey: () => 'test-key', send: (sub, payload) => { world.calls.push({ sub, payload, at: clock.ms }); return respond(sub, payload, world.calls.length) } }
  let timerFn = null
  const n = createNotifier({ dir, transport, clock, groupMs: 10_000, scanMs, readRun, getQuestion, log, ...(maxGroupWaitMs ? { maxGroupWaitMs } : {}),
    readItems: async () => { await world.onRead?.(); return { items: world.items, unreadProjects: world.unread, unreadRuns: world.unreadRuns, questionsRead: true } },
    setTimer: (fn, ms) => { timerFn = { fn, ms }; return 1 }, clearTimer: () => { timerFn = null } })
  return { n, clock, world, timer: () => timerFn }
}

const pause = (runId, pauseId, enteredAt) => ({ kind: 'question', key: `pause:proj/issue-a/${runId}/${pauseId}`, project: 'proj', issueId: 'issue-a', runId, enteredAt, enteredBasis: 'recorded', issueName: 'Private issue name' })
const recovery = (runId, at) => ({ kind: 'recovery', key: `recovery:proj/issue-b/${runId}/${at}`, project: 'proj', issueId: 'issue-b', runId, enteredAt: at, enteredBasis: 'recorded' })

async function lines (dir) {
  const text = await fs.readFile(path.join(dir, 'deliveries.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notifications-'))
  const fresh = async (name) => { const d = path.join(root, name); await fs.mkdir(d, { recursive: true }); return d }
  try {
    t.section('lifecycle, baseline, both transitions and grouping')
    {
      const dir = await fresh('main')
      // Waiting before alerts were installed: the baseline, never alerted.
      const h = harness(dir, { items: [pause('r0', 'p0', iso(T0 - 60_000)), { ...recovery('r9', 'undated'), enteredAt: null, enteredBasis: 'not-recorded' }] })
      await h.n.start()
      t.eq('the notifier runs its own timer, not a socket or the supervisor', h.timer()?.ms, 1000)
      const sub = await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() }, label: 'Phone' })
      let refused = null
      try { await h.n.subscribe({ operator: 'ana', subscription: { endpoint: 'https://attacker.example/x', keys: keys() } }) } catch (e) { refused = e.status }
      t.eq('an endpoint off the allow-list cannot be subscribed', refused, 400)
      await h.n.tick({ wait: true })
      h.clock.ms += 60_000; await h.n.tick({ wait: true })
      t.eq('items waiting before installation and undated ones do not alert', h.world.calls.length, 0)
      // A new owner question and a run that newly needs recovery, a moment apart.
      h.clock.ms = T0 + 120_000
      h.world.items = [...h.world.items, pause('r1', 'p1', iso(h.clock.ms))]
      // The server's own timer drives it: no dashboard socket and no supervisor are involved.
      h.timer().fn()
      await until(() => h.n._state().group?.items?.length === 1)
      t.eq('the timer tick found the new question', h.n._state().group?.items?.[0]?.key, 'pause:proj/issue-a/r1/p1')
      h.clock.ms += 4000
      h.world.items = [...h.world.items, recovery('r2', iso(h.clock.ms))]
      await h.n.tick({ wait: true })
      t.eq('nothing is sent before the grouping window closes', h.world.calls.length, 0)
      h.clock.ms += 10_000
      await h.n.tick({ wait: true })
      t.eq('the two arrivals go out as one alert', h.world.calls.length, 1)
      const payload = h.world.calls[0].payload
      t.eq('the alert counts both items', payload.count, 2)
      t.eq('a question and a recovery', JSON.stringify(payload.kinds), JSON.stringify({ question: 1, recovery: 1 }))
      t.ok('the payload holds no issue name', !JSON.stringify(payload).includes('Private issue name') && !JSON.stringify(payload).includes('issue-a'))
      t.ok('it links to the alert page', /^\/alerts\/[0-9a-f-]{36}$/.test(payload.url))
      // Polls and reconnects read the same items again: nothing repeats.
      for (let i = 0; i < 3; i++) { h.clock.ms += 20_000; await h.n.tick({ wait: true }) }
      t.eq('later polls do not repeat it', h.world.calls.length, 1)
      t.eq('exactly one delivery line', (await lines(dir)).length, 1)
      h.n.stop()

      t.section('deduplication across a restart')
      const h2 = harness(dir, { items: h.world.items, clockAt: h.clock.ms + 5000 })
      await h2.n.start()
      await h2.n.tick({ wait: true }); h2.clock.ms += 30_000; await h2.n.tick({ wait: true })
      t.eq('a restarted notifier sends nothing for the same waiting events', h2.world.calls.length, 0)

      t.section('alert page: each item reachable, handled items show their state')
      const alertId = payload.alertId
      const handledRun = { runId: 'r1', status: 'running', steps: [{ role: 'operator', decision: { pauseId: 'p1', askedAt: iso(T0 + 120_000), at: iso(T0 + 200_000), actor: 'bea', answer: 'yes' } }] }
      const h3 = harness(dir, { items: [recovery('r2', iso(T0 + 124_000))], readRun: async (p, i, r) => (r === 'r1' ? { run: handledRun, packed: false } : null) })
      await h3.n.start()
      const view = await h3.n.alert(alertId)
      t.eq('both items are listed', view.items.length, 2)
      const q = view.items.find((i) => i.kind === 'question')
      const r = view.items.find((i) => i.kind === 'recovery')
      t.eq('the answered question reads handled', q.state, 'handled')
      t.eq('by whom it was answered', q.handled.by, 'bea')
      t.eq('when', q.handled.at, iso(T0 + 200_000))
      t.eq('the recovery still waits', r.state, 'waiting')
      t.eq('the question links to its exact run and pause', q.link, '/projects/proj/issue-a?run=r1&pause=p1')
      t.eq('the recovery links to its occurrence', r.link, `/projects/proj/issue-b?run=r2&recovery=${encodeURIComponent(iso(T0 + 124_000))}`)
      t.eq('a supervisor question links to the supervisor page', itemLink({ kind: 'supervisor-question', questionId: 'sq-1', key: 'supervisor-question:sq-1' }), '/supervisor?question=sq-1')
      const h4 = harness(dir, { getQuestion: () => null })
      await h4.n.start()
      // An alert naming a supervisor question its session no longer holds.
      const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
      t.ok('alerts are kept in alerts.jsonl', (await fs.readFile(path.join(dir, 'alerts.jsonl'), 'utf8')).includes(alertId))
      t.ok('seen keys are kept', Object.keys(state.seen).length >= 3)
      t.eq('an unknown alert is null', await h4.n.alert(crypto.randomUUID()), null)
      void sub
    }

    t.section('a retired supervisor question')
    {
      const dir = await fresh('retired')
      const h = harness(dir, { items: [] })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000
      h.world.items = [{ kind: 'supervisor-question', key: 'supervisor-question:sq-9', questionId: 'sq-9', enteredAt: iso(h.clock.ms), enteredBasis: 'recorded' }]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('a supervisor question alerts', h.world.calls.length, 1)
      const id = h.world.calls[0].payload.alertId
      const h2 = harness(dir, { items: [], getQuestion: () => null })
      await h2.n.start()
      t.eq('its page says retired once the session no longer holds it', (await h2.n.alert(id)).items[0].state, 'retired')
      const h3 = harness(dir, { items: [], getQuestion: () => ({ id: 'sq-9', at: iso(T0), answer: { actor: 'cy', at: iso(T0 + 5000) } }) })
      await h3.n.start()
      t.eq('or handled by whoever answered it', (await h3.n.alert(id)).items[0].handled.by, 'cy')
    }

    t.section('retries')
    {
      const dir = await fresh('retries')
      let n = 0
      const h = harness(dir, { respond: () => (++n <= 2 ? Promise.resolve({ outcome: 'connect-error', error: 'ECONNREFUSED', endedAt: iso(h.clock.ms) }) : Promise.resolve({ outcome: 'accepted', status: 201, endedAt: iso(h.clock.ms) })) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('a refused connection is retried, after a wait', h.world.calls.length, 1)
      await h.n.tick({ wait: true })
      t.eq('not before the backoff', h.world.calls.length, 1)
      h.clock.ms += 6000; await h.n.tick({ wait: true })
      h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('until the push service accepts it', h.world.calls.length, 3)
      t.eq('three attempt lines, the last accepted', (await lines(dir)).map((l) => l.outcome).join(','), 'connect-error,connect-error,accepted')
      h.clock.ms += 60_000; await h.n.tick({ wait: true })
      t.eq('nothing after acceptance', h.world.calls.length, 3)

      const dir2 = await fresh('status-final')
      const h2 = harness(dir2, { respond: () => Promise.resolve({ outcome: 'failed', status: 503, endedAt: iso(h2.clock.ms) }) })
      await h2.n.start()
      await h2.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h2.clock.ms += 1000; h2.world.items = [pause('r1', 'p1', iso(h2.clock.ms))]
      await h2.n.tick({ wait: true }); h2.clock.ms += 11_000; await h2.n.tick({ wait: true })
      for (let i = 0; i < 3; i++) { h2.clock.ms += 60_000; await h2.n.tick({ wait: true }) }
      t.eq('an HTTP status is final: a 503 is not resent', h2.world.calls.length, 1)
    }

    t.section('opt-out: nothing new is sent')
    {
      const dir = await fresh('optout')
      const h = harness(dir)
      await h.n.start()
      const a = await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() }, label: 'Phone' })
      await h.n.subscribe({ operator: 'bea', subscription: { endpoint: endpoint(2), keys: keys() }, label: 'Laptop' })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('both operators get the first alert', h.world.calls.length, 2)
      h.clock.ms += 60_000
      const reply = await h.n.unsubscribe({ operator: 'ana', id: a.id })
      t.eq('the opt-out names the accepted alert', reply.accepted.length, 1)
      t.eq('with the time its TTL ends', reply.accepted[0].latestArrival, iso(Date.parse(reply.accepted[0].endedAt) + 3600_000))
      t.eq('ana has no devices left', h.n.list('ana').subscriptions.length, 0)
      h.clock.ms += 1000; h.world.items = [...h.world.items, pause('r2', 'p2', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      const after = h.world.calls.slice(2)
      t.eq('after the opt-out only bea is sent the next alert', after.map((c) => c.sub.endpoint).join(','), endpoint(2))
      // An explicit opt-in again is the only way back.
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      t.eq('an explicit opt-in turns alerts back on', h.n.list('ana').subscriptions.length, 1)
    }

    t.section('opt-out while the send record is being written: no request starts')
    {
      const dir = await fresh('optout-race')
      const h = harness(dir)
      await h.n.start()
      const a = await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 10_500
      const ticking = h.n.tick({ wait: true })
      await until(() => h.n._state().pending.deliveries[0]?.attempts?.[0]?.outcome === 'sending')
      const reply = await h.n.unsubscribe({ operator: 'ana', id: a.id })
      await ticking
      t.eq('the transport is never called', h.world.calls.length, 0)
      t.eq('the attempt ends skipped', (await lines(dir)).at(-1)?.outcome, 'skipped-revoked')
      t.eq('and the reply lists nothing that may arrive', reply.accepted.length + reply.uncertain.length + reply.uncertainOlder.count, 0)
    }

    t.section('opt-out with a send in flight, accepted afterwards')
    {
      const dir = await fresh('inflight')
      let release
      const h = harness(dir, { respond: () => new Promise((resolve) => { release = () => resolve({ outcome: 'accepted', status: 201, endedAt: iso(h.clock.ms) }) }) })
      await h.n.start()
      const a = await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000
      h.n.tick()
      await until(() => h.world.calls.length === 1)
      h.clock.ms += 1000
      const reply = await h.n.unsubscribe({ operator: 'ana', id: a.id })
      t.eq('the reply comes at once and names the send as uncertain', reply.uncertain.length, 1)
      t.eq('in flight', reply.uncertain[0].cause, 'in-flight')
      t.ok('with no deadline the panel could not know', !('latestArrival' in reply.uncertain[0]))
      t.ok('the confirmation says it is uncertain', optOutSentences(reply).some((l) => /uncertain/.test(l)))
      release(); await until(() => h.n._state().pending.deliveries.length === 0)
      t.eq('accepted after the opt-out, it is still one request', h.world.calls.length, 1)
    }

    t.section('opt-out after a timeout, and the accepted-send boundary')
    {
      const dir = await fresh('timeout')
      const h = harness(dir, { respond: () => Promise.resolve({ outcome: 'unanswered', cause: 'timeout', endedAt: iso(h.clock.ms + 15_000) }) })
      await h.n.start()
      const a = await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      h.clock.ms += 30_000
      const reply = await h.n.unsubscribe({ operator: 'ana', id: a.id })
      t.eq('a timed-out send is listed as uncertain', reply.uncertain.map((u) => u.cause).join(), 'timeout')
      t.eq('a timeout is not resent', h.world.calls.length, 1)

      const dir2 = await fresh('boundary')
      const at = (hhmmss) => Date.parse(`2026-11-25T${hhmmss}Z`)
      const devices = ['dev-a', 'dev-b']
      await fs.writeFile(path.join(dir2, 'subscriptions.json'), JSON.stringify({ subscriptions: devices.map((id, i) => ({ id, operator: id, endpoint: endpoint(10 + i), keys: keys(), label: id, createdAt: iso(at('11:00:00')) })), optedOut: {} }))
      await fs.writeFile(path.join(dir2, 'deliveries.jsonl'), devices.map((id) => JSON.stringify({ deliveryId: `d-${id}`, alertId: 'x', subscriptionId: id, n: 1, persistedAt: iso(at('12:00:00')), fetchStartedAt: iso(at('12:00:00')), outcome: 'accepted', status: 201, endedAt: iso(at('12:00:10')) })).join('\n') + '\n')
      const hb = harness(dir2, { clockAt: at('13:00:01') })
      await hb.n.start()
      const early = await hb.n.unsubscribe({ operator: 'dev-a' })
      t.eq('accepted at 12:00:10, opted out at 13:00:01: listed until 13:00:10', early.accepted.map((x) => x.latestArrival).join(), iso(at('13:00:10')))
      hb.clock.ms = at('13:00:11')
      const late = await hb.n.unsubscribe({ operator: 'dev-b' })
      t.eq('opted out at 13:00:11: its TTL is over, not listed', late.accepted.length, 0)
    }

    t.section('older uncertain sends are always disclosed')
    {
      const dir = await fresh('older')
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0 - 10 * 3600_000) }], optedOut: {} }))
      const line = (n, startedMs) => JSON.stringify({ deliveryId: `d${n}`, alertId: 'x', subscriptionId: 's1', n: 1, persistedAt: iso(startedMs), fetchStartedAt: iso(startedMs), outcome: 'unanswered', cause: 'timeout', endedAt: iso(startedMs + 15_000) })
      await fs.writeFile(path.join(dir, 'deliveries.jsonl'), line(1, T0 - 3 * 3600_000) + '\n')
      const h = harness(dir)
      await h.n.start()
      const only = await h.n.unsubscribe({ operator: 'ana' })
      t.eq('a single unanswered send 3 hours old is not itemised', only.uncertain.length, 0)
      t.eq('but it is counted', only.uncertainOlder.count, 1)
      t.eq('with when it started', only.uncertainOlder.oldestStartedAt, iso(T0 - 3 * 3600_000))
      t.ok('and the confirmation says so', optOutSentences(only).some((l) => /older send.*also got no answer/.test(l)))

      const dir2 = await fresh('older-mixed')
      await fs.writeFile(path.join(dir2, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0 - 10 * 3600_000) }], optedOut: {} }))
      await fs.writeFile(path.join(dir2, 'deliveries.jsonl'), [line(1, T0 - 30 * 60_000), line(2, T0 - 5 * 3600_000), line(3, T0 - 6 * 3600_000)].join('\n') + '\n')
      const h2 = harness(dir2)
      await h2.n.start()
      const mixed = await h2.n.unsubscribe({ operator: 'ana' })
      t.eq('one recent row and two older counted', `${mixed.uncertain.length}/${mixed.uncertainOlder.count}`, '1/2')
      t.eq('a plain confirmation when nothing may arrive', optOutSentences({}).length, 1)
    }

    t.section('a crash before the request: the alert is sent after restart (at least once)')
    {
      const dir = await fresh('pre-request')
      const h = harness(dir)
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true })
      h.n.stop()
      // The state an exit leaves right after `sending` was saved and before the transport was called, three times over.
      const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
      const subs = JSON.parse(await fs.readFile(path.join(dir, 'subscriptions.json'), 'utf8'))
      state.group = null
      state.pending.deliveries = [{ deliveryId: 'd1', alertId: 'al1', subscriptionId: subs.subscriptions[0].id, operator: 'ana', keys: [h.world.items[0].key], payload: { v: 1, alertId: 'al1', count: 1, kinds: { question: 1 }, url: '/alerts/al1' }, attempts: [{ n: 1, persistedAt: iso(h.clock.ms), outcome: 'sending' }], connectRetries: 0, nextAt: 0 }]
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state))
      for (let exit = 2; exit <= 3; exit++) {
        // Each start converts the cut-off attempt and writes its line; then the process exits before resending.
        const hx = harness(dir, { items: h.world.items, clockAt: h.clock.ms })
        await hx.n.start(); hx.n.stop()
        const s = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
        s.pending.deliveries[0].attempts.push({ n: exit, persistedAt: iso(h.clock.ms), outcome: 'sending' })
        await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(s))
      }
      // And an exit between writing the restart line and queueing the resend.
      const hy = harness(dir, { items: h.world.items, clockAt: h.clock.ms })
      await hy.n.start(); hy.n.stop()
      const hz = harness(dir, { items: h.world.items, clockAt: h.clock.ms })
      await hz.n.start()
      await hz.n.tick({ wait: true })
      t.eq('three cut-off attempts and an interrupted repair: the transport is called exactly once', hz.world.calls.length, 1)
      const written = await lines(dir)
      t.eq('attempts recorded: three restart-unanswered, then accepted', written.map((l) => `${l.outcome}${l.cause ? `:${l.cause}` : ''}`).join(','), 'unanswered:restart,unanswered:restart,unanswered:restart,accepted')
      t.eq('each attempt has exactly one line', new Set(written.map((l) => `${l.deliveryId}:${l.n}`)).size, written.length)

      const dir2 = await fresh('superseded')
      await fs.cp(dir, dir2, { recursive: true })
      const s2 = JSON.parse(await fs.readFile(path.join(dir2, 'state.json'), 'utf8'))
      s2.pending.deliveries = [{ ...state.pending.deliveries[0], attempts: [{ n: 1, persistedAt: iso(h.clock.ms), outcome: 'sending' }] }]
      await fs.writeFile(path.join(dir2, 'state.json'), JSON.stringify(s2))
      await fs.writeFile(path.join(dir2, 'deliveries.jsonl'), '')
      const hs = harness(dir2, { items: [], clockAt: h.clock.ms })
      await hs.n.start(); await hs.n.tick({ wait: true })
      t.eq('a resend for an alert whose items were all handled is not made', hs.world.calls.length, 0)
      t.eq('it ends superseded', hs.n._state().pending.deliveries.length, 0)
    }

    t.section('a crash after an accepted send: the log is repaired once')
    {
      const dir = await fresh('log-repair')
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0) }], optedOut: {} }))
      const accepted = { n: 1, persistedAt: iso(T0 + 1000), fetchStartedAt: iso(T0 + 1000), outcome: 'accepted', status: 201, endedAt: iso(T0 + 2000) }
      const key = 'pause:proj/issue-a/r1/p1'
      const state = { installedAt: iso(T0 - 1000), seen: { [key]: iso(T0) }, group: null, pending: { alerts: [], deliveries: [{ deliveryId: 'd1', alertId: 'al1', subscriptionId: 's1', operator: 'ana', keys: [key], payload: {}, attempts: [accepted], connectRetries: 0, nextAt: 0 }] } }
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state))
      const h = harness(dir, { items: [], clockAt: T0 + 5000 })
      await h.n.start()
      t.eq('the accepted attempt gets its line', (await lines(dir)).length, 1)
      t.eq('the delivery leaves state once its line exists', h.n._state().pending.deliveries.length, 0)
      t.eq('the wait counts as alerted', (await h.n.alertedKeys()).get(key), iso(T0 + 2000))
      t.eq('nothing is resent', h.world.calls.length, 0)
      const h2 = harness(dir, { items: [], clockAt: T0 + 9000 })
      await h2.n.start()
      t.eq('a second restart appends nothing more', (await lines(dir)).length, 1)

      const dir2 = await fresh('torn-line')
      await fs.cp(path.join(dir, 'subscriptions.json'), path.join(dir2, 'subscriptions.json'))
      await fs.writeFile(path.join(dir2, 'state.json'), JSON.stringify(state))
      const full = JSON.stringify({ deliveryId: 'd1', alertId: 'al1', subscriptionId: 's1', operator: 'ana', keys: [key], ...accepted })
      await fs.writeFile(path.join(dir2, 'deliveries.jsonl'), full.slice(0, 40))
      const h3 = harness(dir2, { items: [], clockAt: T0 + 5000 })
      await h3.n.start()
      const repaired = await lines(dir2)
      t.eq('a torn final line is dropped and rewritten from state: one line', repaired.length, 1)
      t.eq('the line is the accepted attempt', repaired[0].outcome, 'accepted')

      const dir3 = await fresh('before-prune')
      await fs.cp(path.join(dir, 'subscriptions.json'), path.join(dir3, 'subscriptions.json'))
      await fs.writeFile(path.join(dir3, 'state.json'), JSON.stringify(state))
      await fs.writeFile(path.join(dir3, 'deliveries.jsonl'), full + '\n')
      const h4 = harness(dir3, { items: [], clockAt: T0 + 5000 })
      await h4.n.start()
      t.eq('an exit after the line and before pruning: pruned without a second line', `${(await lines(dir3)).length}/${h4.n._state().pending.deliveries.length}`, '1/0')
    }

    t.section('crash after a request, a 503 on resend, then opt-out')
    {
      const dir = await fresh('crash-503')
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0) }], optedOut: {} }))
      const key = 'pause:proj/issue-a/r1/p1'
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ installedAt: iso(T0 - 1000), seen: { [key]: iso(T0) }, group: null, pending: { alerts: [], deliveries: [{ deliveryId: 'd1', alertId: 'al1', subscriptionId: 's1', operator: 'ana', keys: [key], payload: {}, attempts: [{ n: 1, persistedAt: iso(T0 + 1000), outcome: 'sending' }], connectRetries: 0, nextAt: 0 }] } }))
      const h = harness(dir, { items: [pause('r1', 'p1', iso(T0))], clockAt: T0 + 60_000, respond: () => Promise.resolve({ outcome: 'failed', status: 503, endedAt: iso(T0 + 61_000) }) })
      await h.n.start(); await h.n.tick({ wait: true })
      t.eq('the resend got a 503', (await lines(dir)).at(-1).status, 503)
      const reply = await h.n.unsubscribe({ operator: 'ana' })
      t.eq('the opt-out still names the first, cut-off attempt as uncertain', reply.uncertain.map((u) => `${u.attempt}:${u.cause}`).join(), '1:restart')
    }

    t.section('a group closes only after a reading that covers its window')
    {
      const dir = await fresh('group-scan')
      const h = harness(dir, { scanMs: 15_000 })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      await h.n.tick({ wait: true })
      h.clock.ms += 15_000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true })
      t.ok('the first item opened a group', Boolean(h.n._state().group))
      // A second item starts waiting a second later; nothing nudges the notifier (a journal finding published by a read).
      h.clock.ms += 1000; h.world.items = [...h.world.items, recovery('r2', iso(h.clock.ms))]
      h.clock.ms += 9000
      await h.n.tick({ wait: true })
      t.eq('the group closes with both items: it was read again before closing', h.world.calls.map((c) => c.payload.count).join(), '2')
    }

    t.section('a failed delivery worker is contained; malformed keys are refused at opt-in')
    {
      const dir = await fresh('worker')
      const logged = []
      const h = harness(dir, { respond: () => { throw new Error('cannot encrypt for this subscription') }, log: (line) => logged.push(line) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000
      await h.n.tick({ wait: true })
      t.eq('a transport that throws before any request ends that delivery failed', (await lines(dir)).at(-1)?.outcome, 'failed')
      const point = Buffer.alloc(65); point[0] = 4
      t.ok('a 65-byte key that is not a P-256 point is not valid', !validKeys(point.toString('base64url'), Buffer.alloc(16).toString('base64url')))
      let refused = null
      try { await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(2), keys: { p256dh: point.toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } } }) } catch (e) { refused = e.status }
      t.eq('and is refused at opt-in', refused, 400)
      // A worker whose state write fails: logged, never an unhandled rejection that ends the server.
      const unhandled = []
      const onUnhandled = (e) => unhandled.push(e)
      process.on('unhandledRejection', onUnhandled)
      const dir2 = await fresh('worker-write')
      let release
      const h2 = harness(dir2, { log: (line) => logged.push(line), respond: () => new Promise((resolve) => { release = () => resolve({ outcome: 'accepted', status: 201, endedAt: iso(T0) }) }) })
      await h2.n.start()
      await h2.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h2.clock.ms += 1000; h2.world.items = [pause('r1', 'p1', iso(h2.clock.ms))]
      await h2.n.tick({ wait: true }); h2.clock.ms += 11_000
      // As the production timer does: no waiting for the sends; the worker's own write then fails.
      await h2.n.tick()
      await until(() => typeof release === 'function')
      await fs.rm(path.join(dir2, 'state.json'))
      await fs.mkdir(path.join(dir2, 'state.json'))
      release()
      await until(() => logged.some((l) => /delivery .*:/.test(l)))
      await new Promise((r) => setTimeout(r, 20))
      process.off('unhandledRejection', onUnhandled)
      t.eq('a failed state write rejects no promise the timer cannot see', unhandled.length, 0)
      t.ok('and is logged', logged.some((l) => /delivery .*:/.test(l)), logged.join(' | '))
    }

    t.section('a read error at start stops the notifier and overwrites nothing')
    {
      const dir = await fresh('read-error')
      const h = harness(dir)
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.n.stop()
      const subsBefore = await fs.readFile(path.join(dir, 'subscriptions.json'), 'utf8')
      await fs.rm(path.join(dir, 'state.json'))
      await fs.mkdir(path.join(dir, 'state.json'))
      let failed = null
      try { await harness(dir).n.start() } catch (e) { failed = e.code }
      t.eq('an unreadable state.json (not missing) stops the start', failed, 'EISDIR')
      t.ok('state.json is not replaced', (await fs.stat(path.join(dir, 'state.json'))).isDirectory())
      t.eq('the devices are untouched', await fs.readFile(path.join(dir, 'subscriptions.json'), 'utf8'), subsBefore)
      await fs.rmdir(path.join(dir, 'state.json'))
      await fs.rm(path.join(dir, 'subscriptions.json'))
      await fs.mkdir(path.join(dir, 'subscriptions.json'))
      failed = null
      try { await harness(dir).n.start() } catch (e) { failed = e.code }
      t.eq('an unreadable subscriptions.json stops the start too', failed, 'EISDIR')
    }

    t.section('opt-out by this device, repeated, and after a re-opt-in')
    {
      const dir = await fresh('device-optout')
      const ep = endpoint(7)
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 'old', operator: 'ana', endpoint: ep, keys: keys(), label: 'Phone', createdAt: iso(T0 - 3600_000) }], optedOut: {} }))
      const unanswered = { deliveryId: 'd1', alertId: 'x', subscriptionId: 'old', n: 1, persistedAt: iso(T0 - 600_000), fetchStartedAt: iso(T0 - 600_000), outcome: 'unanswered', cause: 'timeout', endedAt: iso(T0 - 585_000) }
      await fs.writeFile(path.join(dir, 'deliveries.jsonl'), JSON.stringify(unanswered) + '\n')
      const h = harness(dir)
      await h.n.start()
      const first = await h.n.unsubscribe({ operator: 'ana' })
      t.eq('the first opt-out names the uncertain send', first.uncertain.length, 1)
      const again = await h.n.unsubscribe({ operator: 'ana' })
      t.eq('a repeated opt-out (its reply was lost) names it again', again.uncertain.length, 1)
      const byId = await h.n.unsubscribe({ operator: 'ana', id: 'old' })
      t.eq('so does a repeated per-device opt-out, instead of a 404', byId.uncertain.length, 1)
      // Opted in again on the same browser endpoint, under a new name: the earlier send still counts for this device.
      await h.n.subscribe({ operator: 'later-name', subscription: { endpoint: ep, keys: keys() } })
      t.eq('this device is found by its endpoint, whatever name', h.n.list('someone-else', { endpoint: ep }).thisDevice?.label, 'browser')
      const off = await h.n.unsubscribe({ endpoint: ep })
      t.eq('turning off this device reaches it by endpoint', off.revoked.length, 1)
      t.eq('and names the uncertain send of its earlier subscription', off.uncertain.map((u) => u.cause).join(), 'timeout')
      // A browser with no name gets a registry of its own, not one shared with other nameless browsers.
      const a = await h.n.subscribe({ operator: null, subscription: { endpoint: endpoint(8), keys: keys() } })
      const b = await h.n.subscribe({ operator: null, subscription: { endpoint: endpoint(9), keys: keys() } })
      const state = JSON.parse(await fs.readFile(path.join(dir, 'subscriptions.json'), 'utf8'))
      const owners = state.subscriptions.filter((s) => [a.id, b.id].includes(s.id)).map((s) => s.operator)
      t.ok('two nameless browsers are registered apart', owners.length === 2 && owners[0] !== owners[1] && owners.every((o) => o.startsWith('device:')), owners.join())
    }

    t.section('an unreadable delivery history is said to be so')
    {
      const dir = await fresh('history-damaged')
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0) }], optedOut: {} }))
      const h = harness(dir)
      await h.n.start()
      await fs.writeFile(path.join(dir, 'deliveries.jsonl'), 'not json\n')
      const reply = await h.n.unsubscribe({ operator: 'ana' })
      t.ok('the reply says the history could not be read', /does not parse/.test(reply.historyUnavailable ?? ''), reply.historyUnavailable)
      t.ok('and the confirmation says which sends may still appear is not known', optOutSentences(reply).some((l) => /could not read its whole record/.test(l)))
      await fs.rm(path.join(dir, 'deliveries.jsonl'))
      await fs.mkdir(path.join(dir, 'deliveries.jsonl'))
      t.ok('an unreadable file too', /could not be read/.test((await h.n.unsubscribe({ operator: 'ana' })).historyUnavailable ?? ''))
    }

    t.section('an item missing from the inbox is read from its own record')
    {
      const dir = await fresh('missing-item')
      const h = harness(dir)
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      const id = h.world.calls[0].payload.alertId
      const stillPaused = { runId: 'r1', status: 'paused', pause: { id: 'p1', kind: 'policy', at: iso(T0 + 1000) }, steps: [] }
      // The inbox could not list the project this time; the exact run is still readable and paused.
      const h2 = harness(dir, { items: [], readRun: async () => ({ run: stillPaused, packed: false }) })
      h2.world.unread = ['proj']
      await h2.n.start()
      const open = (await h2.n.alert(id)).items[0]
      t.eq('a run still paused on that question reads waiting, not handled', open.state, 'waiting')
      const h3 = harness(dir, { items: [], readRun: async () => null })
      h3.world.unread = ['proj']
      await h3.n.start()
      t.eq('nothing readable while the inbox was incomplete: unknown, never handled', (await h3.n.alert(id)).items[0].state, 'unknown')
      const packedRun = { runId: 'r1', status: 'cancelled', pause: { id: 'p1', kind: 'policy', at: iso(T0 + 1000) }, abandonment: { at: iso(T0 + 50_000), by: 'bea' }, steps: [] }
      const h4 = harness(dir, { items: [], readRun: async () => ({ run: packedRun, packed: true }) })
      await h4.n.start()
      const packed = (await h4.n.alert(id)).items[0]
      t.eq('a packed run: handled by its abandonment, by whom', `${packed.state}/${packed.handled.by}/${packed.handled.how}`, 'handled/bea/abandoned')
      t.eq('with how its run ended', `${packed.current.status}/${packed.current.packed}`, 'cancelled/true')
      t.eq('and its exact run on the archived issue page', packed.link, '/projects/proj/issue-a?run=r1&pause=p1')
      // The inbox read every project, yet the exact run cannot be read: not known, never handled.
      const h5 = harness(dir, { items: [], readRun: async () => { throw new Error('EIO') } })
      await h5.n.start()
      t.eq('an unreadable run in a complete inbox reading is unknown, not handled', (await h5.n.alert(id)).items[0].state, 'unknown')
    }

    t.section('round 3: a group closes only on a complete reading begun after its window')
    {
      const dir = await fresh('group-straddle')
      const h = harness(dir, { scanMs: 15_000 })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      await h.n.tick({ wait: true })
      h.clock.ms += 15_000
      const opened = h.clock.ms
      h.world.items = [pause('r1', 'p1', iso(opened))]
      await h.n.tick({ wait: true })
      // A nudged scan starts a second before the deadline and finishes after it, missing an item that began in the window.
      h.clock.ms = opened + 9_000
      h.world.onRead = async () => { h.world.onRead = null; h.clock.ms = opened + 11_000 }
      h.n.nudge()
      await h.n.tick({ wait: true })
      t.eq('a scan that straddled the deadline does not close the group', h.world.calls.length, 0)
      h.world.items = [...h.world.items, recovery('r2', iso(opened + 9_500))]
      await h.n.tick({ wait: true })
      t.eq('the next, complete reading closes it with both items', h.world.calls.map((c) => c.payload.count).join(), '2')

      const dir2 = await fresh('group-incomplete')
      const h2 = harness(dir2)
      await h2.n.start()
      await h2.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h2.clock.ms += 1000; h2.world.items = [pause('r1', 'p1', iso(h2.clock.ms))]
      await h2.n.tick({ wait: true })
      h2.clock.ms += 11_000; h2.world.unread = ['proj']
      await h2.n.tick({ wait: true })
      t.eq('a reading with an unread project does not close the group', h2.world.calls.length, 0)
      h2.world.unread = []
      await h2.n.tick({ wait: true })
      t.eq('a complete one does', h2.world.calls.length, 1)
    }

    t.section('round 3: a superseded delivery whose write fails is contained')
    {
      const dir = await fresh('superseded-write')
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0) }], optedOut: {} }))
      const key = 'pause:proj/issue-a/r1/p1'
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ installedAt: iso(T0 - 1000), seen: { [key]: iso(T0) }, group: null, pending: { alerts: [], deliveries: [{ deliveryId: 'd1', alertId: 'al1', subscriptionId: 's1', operator: 'ana', keys: [key], payload: {}, attempts: [{ n: 1, persistedAt: iso(T0), outcome: 'sending' }], connectRetries: 0, nextAt: 0 }] } }))
      const logged = []
      const h = harness(dir, { items: [], log: (line) => logged.push(line) })
      await h.n.start()
      await fs.rm(path.join(dir, 'state.json'))
      await fs.mkdir(path.join(dir, 'state.json'))
      const unhandled = []
      const onUnhandled = (e) => unhandled.push(e)
      process.on('unhandledRejection', onUnhandled)
      await h.n.tick()
      await until(() => logged.some((l) => /delivery d1:/.test(l)))
      await new Promise((r) => setTimeout(r, 20))
      process.off('unhandledRejection', onUnhandled)
      t.eq('the superseded branch rejects no promise the timer cannot see', unhandled.length, 0)
      t.ok('and logs the failed write', logged.some((l) => /delivery d1:/.test(l)), logged.join(' | '))
      t.eq('no resend was made', h.world.calls.length, 0)
    }

    t.section('round 3: a repeated opt-out persists what a failed first write did not')
    {
      const dir = await fresh('optout-durable')
      const ep = endpoint(3)
      const h = harness(dir)
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: ep, keys: keys() } })
      await fs.rm(path.join(dir, 'subscriptions.json'))
      await fs.mkdir(path.join(dir, 'subscriptions.json'))
      let failed = null
      try { await h.n.unsubscribe({ endpoint: ep }) } catch (e) { failed = e.code }
      t.eq('the first opt-out cannot write the registry', failed, 'EISDIR')
      await fs.rmdir(path.join(dir, 'subscriptions.json'))
      await h.n.unsubscribe({ endpoint: ep })
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'subscriptions.json'), 'utf8'))
      t.ok('the retry writes the revocation', onDisk.subscriptions.every((s) => s.revokedAt))
      h.n.stop()
      const h2 = harness(dir, { items: [] })
      await h2.n.start()
      h2.clock.ms += 1000; h2.world.items = [pause('r1', 'p1', iso(h2.clock.ms))]
      await h2.n.tick({ wait: true }); h2.clock.ms += 11_000; await h2.n.tick({ wait: true })
      t.eq('after a restart nothing is sent to the opted-out device', h2.world.calls.length, 0)
    }

    t.section('round 3: a missing delivery log after recorded sends is said to be so')
    {
      const dir = await fresh('history-missing')
      const h = harness(dir, { respond: () => Promise.resolve({ outcome: 'unanswered', cause: 'timeout', endedAt: iso(h.clock.ms) }) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('the unanswered send was logged and left state', `${(await lines(dir)).length}/${h.n._state().pending.deliveries.length}`, '1/0')
      await fs.rm(path.join(dir, 'deliveries.jsonl'))
      const reply = await h.n.unsubscribe({ operator: 'ana' })
      t.ok('the reply says the record of sends is missing', /missing although sends were recorded/.test(reply.historyUnavailable ?? ''), reply.historyUnavailable)
    }

    t.section('round 4: an unreadable newer run makes a reading incomplete, for grouping and for a resend')
    {
      const dir = await fresh('unread-run')
      const h = harness(dir)
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true })
      h.clock.ms += 11_000; h.world.unreadRuns = ['proj/issue-b/r2']
      await h.n.tick({ wait: true })
      t.eq('a reading that could not read a newer run record does not close the group', h.world.calls.length, 0)
      h.world.unreadRuns = []; h.world.items = [...h.world.items, recovery('r2', iso(h.clock.ms - 10_500))]
      await h.n.tick({ wait: true })
      t.eq('once it reads, both simultaneous waits go out together', h.world.calls.map((c) => c.payload.count).join(), '2')

      const dir2 = await fresh('unread-run-resend')
      await fs.writeFile(path.join(dir2, 'subscriptions.json'), JSON.stringify({ subscriptions: [{ id: 's1', operator: 'ana', endpoint: endpoint(1), keys: keys(), label: 'Phone', createdAt: iso(T0) }], optedOut: {} }))
      const key = 'pause:proj/issue-a/r1/p1'
      await fs.writeFile(path.join(dir2, 'state.json'), JSON.stringify({ installedAt: iso(T0 - 1000), seen: { [key]: iso(T0) }, group: null, pending: { alerts: [], deliveries: [{ deliveryId: 'd1', alertId: 'al1', subscriptionId: 's1', operator: 'ana', keys: [key], payload: {}, attempts: [{ n: 1, persistedAt: iso(T0), outcome: 'sending' }], connectRetries: 0, nextAt: 0 }] } }))
      const h2 = harness(dir2, { items: [] })
      h2.world.unreadRuns = ['proj/issue-a/r1']
      await h2.n.start(); await h2.n.tick({ wait: true })
      t.eq('a restart-cut send whose run could not be read is sent again, not dropped as superseded', h2.world.calls.length, 1)
    }

    t.section('round 4: a persistently unreadable project delays a group by at most maxGroupWaitMs')
    {
      const dir = await fresh('unread-bounded')
      const logged = []
      const h = harness(dir, { scanMs: 15_000, log: (l) => logged.push(l) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      await h.n.tick({ wait: true })
      h.world.unread = ['broken-project']
      h.clock.ms += 1000; const opened = h.clock.ms
      h.world.items = [pause('r1', 'p1', iso(opened))]
      h.n.nudge(); await h.n.tick({ wait: true })
      t.ok('a healthy project’s question opened a group beside the unreadable project', Boolean(h.n._state().group))
      for (let s2 = 1; s2 < 70; s2++) { h.clock.ms = opened + s2 * 1000; await h.n.tick({ wait: true }) }
      t.eq('while the window plus 60 s has not passed, nothing goes out', h.world.calls.length, 0)
      h.clock.ms = opened + 70_000; await h.n.tick({ wait: true })
      t.eq('then the readable items go out, whatever stays unreadable', h.world.calls.map((c) => c.payload.count).join(), '1')
      t.ok('and the late flush is logged', logged.some((l) => /waiting 60 s for a complete reading/.test(l)), logged.join(' | '))
      // A wait found after that flush goes in an alert of its own (the split note 023 D2 accepts).
      h.clock.ms += 5000; h.world.items = [...h.world.items, recovery('r2', iso(h.clock.ms))]
      h.n.nudge(); await h.n.tick({ wait: true })
      t.eq('a later wait does not join the sent alert', h.world.calls.length, 1)
      h.clock.ms += 71_000; await h.n.tick({ wait: true })
      t.eq('it goes in a second alert of its own, bounded the same way', h.world.calls.map((c) => c.payload.count).join(), '1,1')
    }

    t.section('round 4: a missing delivery log after a restart is still said to be so')
    {
      const dir = await fresh('history-missing-restart')
      const h = harness(dir, { respond: () => Promise.resolve({ outcome: 'unanswered', cause: 'timeout', endedAt: iso(h.clock.ms) }) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('the unanswered send was logged and pruned from state', `${(await lines(dir)).length}/${h.n._state().pending.deliveries.length}`, '1/0')
      h.n.stop()
      await fs.rm(path.join(dir, 'deliveries.jsonl'))
      const h2 = harness(dir, { items: h.world.items, clockAt: h.clock.ms + 1000 })
      await h2.n.start()
      t.eq('state.json keeps the evidence that sends were made', h2.n._state().sendsRecorded, true)
      const reply = await h2.n.unsubscribe({ operator: 'ana' })
      t.ok('after the restart the opt-out reply still says the record of sends is missing', /went missing .* after sends were recorded/.test(reply.historyUnavailable ?? ''), reply.historyUnavailable)
      t.ok('and the confirmation says it', optOutSentences(reply).some((line) => /record of sends|cannot/i.test(line)), optOutSentences(reply).join(' | '))
      const dir2 = await fresh('history-none')
      const h3 = harness(dir2)
      await h3.n.start()
      await h3.n.subscribe({ operator: 'bo', subscription: { endpoint: endpoint(2), keys: keys() } })
      t.eq('a panel that never sent anything has no missing history to report', (await h3.n.unsubscribe({ operator: 'bo' })).historyUnavailable, null)
    }

    t.section('round 5: a lost delivery log stays lost when it is recreated')
    {
      // The auditor's sequence: Ana's unanswered send, the log removed, a restart with Bea's finished attempt pending.
      const dir = await fresh('history-recreated-start')
      const h = harness(dir, { respond: () => Promise.resolve({ outcome: 'unanswered', cause: 'timeout', endedAt: iso(h.clock.ms) }) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() }, label: 'Ana phone' })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq("Ana's unanswered send was logged and left state", `${(await lines(dir)).length}/${h.n._state().pending.deliveries.length}`, '1/0')
      h.n.stop()
      await fs.rm(path.join(dir, 'deliveries.jsonl'))
      const subs = JSON.parse(await fs.readFile(path.join(dir, 'subscriptions.json'), 'utf8'))
      subs.subscriptions.push({ id: 'bea-1', operator: 'bea', endpoint: endpoint(2), keys: keys(), label: 'Bea phone', createdAt: iso(h.clock.ms) })
      await fs.writeFile(path.join(dir, 'subscriptions.json'), JSON.stringify(subs))
      const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
      state.pending.deliveries.push({ deliveryId: 'bea-d', alertId: 'al-b', subscriptionId: 'bea-1', operator: 'bea', keys: ['pause:proj/issue-a/r2/p2'], payload: {}, attempts: [{ n: 1, persistedAt: iso(h.clock.ms), fetchStartedAt: iso(h.clock.ms), outcome: 'accepted', status: 201, endedAt: iso(h.clock.ms) }], connectRetries: 0, nextAt: 0 })
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state))
      const h2 = harness(dir, { items: h.world.items, clockAt: h.clock.ms + 1000 })
      await h2.n.start()
      const relogged = await lines(dir)
      t.eq("the start recreated the log with Bea's attempt only", relogged.map((l) => l.deliveryId).join(), 'bea-d')
      const reply = await h2.n.unsubscribe({ operator: 'ana' })
      t.ok("Ana's opt-out still says the record of sends went missing", /went missing/.test(reply.historyUnavailable ?? ''), reply.historyUnavailable)
      t.ok('and the confirmation says it cannot tell', optOutSentences(reply).some((line) => /could not read its whole record/.test(line)))
      h2.n.stop()
      const h3 = harness(dir, { items: h.world.items, clockAt: h.clock.ms + 5000 })
      await h3.n.start()
      t.ok('a later restart keeps it', /went missing/.test((await h3.n.unsubscribe({ operator: 'ana' })).historyUnavailable ?? ''))

      // While running: the log is removed and the next send recreates it.
      const dir2 = await fresh('history-recreated-running')
      const r = harness(dir2, { respond: () => Promise.resolve({ outcome: 'unanswered', cause: 'timeout', endedAt: iso(r.clock.ms) }) })
      await r.n.start()
      await r.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      r.clock.ms += 1000; r.world.items = [pause('r1', 'p1', iso(r.clock.ms))]
      await r.n.tick({ wait: true }); r.clock.ms += 11_000; await r.n.tick({ wait: true })
      await fs.rm(path.join(dir2, 'deliveries.jsonl'))
      r.clock.ms += 1000; r.world.items = [...r.world.items, pause('r2', 'p2', iso(r.clock.ms))]
      await r.n.tick({ wait: true }); r.clock.ms += 11_000; await r.n.tick({ wait: true })
      t.eq('the second send recreated the log with its own line', (await lines(dir2)).length, 1)
      t.ok('the opt-out still says the earlier record went missing', /went missing/.test((await r.n.unsubscribe({ operator: 'ana' })).historyUnavailable ?? ''))
      t.ok('and state.json holds when that was noticed', Boolean(JSON.parse(await fs.readFile(path.join(dir2, 'state.json'), 'utf8')).historyLostAt))
    }

    t.section('round 7: Turn off all of mine is offered with one active subscription, and covers an earlier endpoint')
    {
      const dir = await fresh('turn-off-all-one')
      const h = harness(dir, { respond: () => Promise.resolve({ outcome: 'unanswered', cause: 'timeout', endedAt: iso(h.clock.ms) }) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() }, label: 'Old phone subscription' })
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('an unanswered send went to the earlier endpoint', h.world.calls.map((c) => c.sub.endpoint).join(), endpoint(1))
      await h.n.unsubscribe({ endpoint: endpoint(1) })
      // The browser subscribes again under a new endpoint (as after a push key change).
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(2), keys: keys() }, label: 'New phone subscription' })
      const status = h.n.list('ana', { endpoint: endpoint(2) })
      t.eq('one active subscription, the earlier one revoked', status.subscriptions.length, 1)
      t.ok('the control is offered', offersTurnOffAll({ operator: 'ana', ...status }))
      t.ok('the settings component shows it by that same rule', (await fs.readFile(new URL('../src/components/AlertSettings.vue', import.meta.url), 'utf8')).includes('v-if="offersTurnOffAll(status)"'))
      t.ok('but not without a name to turn off',!offersTurnOffAll({ operator: null, ...status }) && !offersTurnOffAll({ operator: 'ana', subscriptions: [] }))
      const device = await h.n.unsubscribe({ endpoint: endpoint(2) })
      t.eq("this device's opt-out does not reach the earlier endpoint", device.uncertain.length, 0)
      const all = await h.n.unsubscribe({ operator: 'ana' })
      t.eq('Turn off all of mine names the uncertain send to the earlier endpoint', all.uncertain.map((u) => u.device).join(), 'Old phone subscription')
    }

    t.section('round 8: one unreadable run in a grouped alert leaves the other items reachable')
    {
      const dir = await fresh('grouped-unreadable')
      const runs = {}
      const h = harness(dir, { readRun: async (project, issueId, runId) => (runs[runId] ? { run: runs[runId], packed: false } : null) })
      await h.n.start()
      await h.n.subscribe({ operator: 'ana', subscription: { endpoint: endpoint(1), keys: keys() } })
      h.clock.ms += 1000
      const askedAt = iso(h.clock.ms)
      h.world.items = [pause('r1', 'p1', askedAt), pause('r2', 'p2', askedAt)]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      const alertId = h.world.calls[0]?.payload.alertId
      t.eq('the two items went out as one alert', h.world.calls[0]?.payload.count, 2)
      // Both left the inbox: r1 was answered; r2's record parses but holds recoveries={}.
      h.world.items = []
      runs.r1 = { runId: 'r1', status: 'running', pause: null, steps: [{ role: 'operator', decision: { pauseId: 'p1', askedAt, at: iso(h.clock.ms), actor: 'bea', answer: 'yes' } }] }
      runs.r2 = { runId: 'r2', status: 'failed', steps: [], recoveries: {} }
      const view = await h.n.alert(alertId)
      const [first, second] = view.items
      t.eq('the first item keeps its link and its recorded handler', `${first.link}|${first.state}|${first.handled?.by}`, '/projects/proj/issue-a?run=r1&pause=p1|handled|bea')
      t.eq('the second reads unreadable, with its own link', `${second.state}|${second.link}`, 'unreadable|/projects/proj/issue-a?run=r2&pause=p2')
      t.ok('saying why', /cannot be read/.test(second.reason ?? ''), second.reason)
    }

    t.section('round 4: an operator named like an Object property is an operator')
    {
      const dir = await fresh('inherited-name')
      const h = harness(dir)
      await h.n.start()
      await h.n.subscribe({ operator: 'constructor', subscription: { endpoint: endpoint(1), keys: keys() } })
      await h.n.subscribe({ operator: '__proto__', subscription: { endpoint: endpoint(2), keys: keys() } })
      t.eq('constructor is not opted out by an inherited property', h.n.list('constructor').optedOut, null)
      h.clock.ms += 1000; h.world.items = [pause('r1', 'p1', iso(h.clock.ms))]
      await h.n.tick({ wait: true }); h.clock.ms += 11_000; await h.n.tick({ wait: true })
      t.eq('both devices get the alert', h.world.calls.length, 2)
      await h.n.unsubscribe({ operator: '__proto__' })
      t.ok('opting out __proto__ records it as its own key', Boolean(h.n.list('__proto__').optedOut) && h.n.list('constructor').optedOut === null)
      h.n.stop()
      const h2 = harness(dir, { items: h.world.items, clockAt: h.clock.ms + 1000 })
      await h2.n.start()
      t.eq('after a restart the names read the same', `${h2.n.list('constructor').optedOut}/${Boolean(h2.n.list('__proto__').optedOut)}`, 'null/true')
      h2.clock.ms += 1000; h2.world.items = [...h2.world.items, pause('r2', 'p2', iso(h2.clock.ms))]
      await h2.n.tick({ wait: true }); h2.clock.ms += 11_000; await h2.n.tick({ wait: true })
      t.eq('only constructor’s device gets the next alert', h2.world.calls.map((c) => c.sub.operator).join(), 'constructor')
    }

    t.section('a damaged delivery log stops sends')
    {
      const dir = await fresh('damaged')
      await fs.writeFile(path.join(dir, 'deliveries.jsonl'), 'not json\n{"deliveryId":"d","n":1}\n')
      const h = harness(dir)
      await h.n.start()
      t.ok('the damage is reported', /does not parse/.test(h.n.list('ana').damaged))
      t.eq('and never cut away', (await fs.readFile(path.join(dir, 'deliveries.jsonl'), 'utf8')).startsWith('not json'), true)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
