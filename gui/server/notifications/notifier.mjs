import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { appendDurable, writeJson } from '../runtime/persistence.mjs'
import { allowedEndpoint, TIMEOUT_MS, TTL_SECONDS } from './webpush.mjs'
import { questionWait, runWaits } from './waits.mjs'

/*
 * Operator alerts (docs/operator-alerts.md): a server-owned notifier that reads the Needs attention inbox's own
 * classification (attention.mjs attentionItems), and when an item newly starts waiting (an owner question, a
 * supervisor question, a run that newly needs recovery) sends one grouped Web Push alert to every opted-in device.
 *
 * Files under <issues>/.notifications/:
 *   subscriptions.json  devices, each with its operator; revocations and per-operator opt-outs
 *   state.json          installedAt, seen (permanent: a key alerts once), the open group, pending alerts and deliveries
 *   alerts.jsonl        every alert, permanent (an alert link keeps resolving)
 *   deliveries.jsonl    one line per finished send attempt, keyed {deliveryId, n}
 *   vapid.json          the panel's VAPID key pair (webpush.mjs), 0600
 *
 * Delivery is at least once (owner decision): a send cut off by a restart is sent again; a duplicate is accepted.
 */

const ALERT_KINDS = new Set(['question', 'recovery', 'supervisor-question'])
const FINAL = new Set(['accepted', 'gone', 'failed', 'unanswered', 'connect-error', 'skipped-revoked'])
const MAX_CONNECT_RETRIES = 3
const LIST_HORIZON_MS = 2 * TTL_SECONDS * 1000

/** A delivery is over when the push service answered, it was never to be sent, a real timeout ended it, or connecting kept failing. */
export function isTerminal (d) {
  if (d.ending) return true
  if (d.attempts.some((a) => ['accepted', 'gone', 'failed'].includes(a.outcome))) return true
  const last = d.attempts.at(-1)
  if (last?.outcome === 'unanswered' && last.cause !== 'restart') return true
  return last?.outcome === 'connect-error' && (d.connectRetries ?? 0) >= MAX_CONNECT_RETRIES
}

/** What the push service carries: counts and the alert's own page, nothing from an issue and no credential. */
export function alertPayload ({ alertId, createdAt, items }) {
  const kinds = {}
  for (const item of items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1
  const parts = []
  const questions = (kinds.question ?? 0) + (kinds['supervisor-question'] ?? 0)
  if (questions) parts.push(`${questions} question${questions === 1 ? '' : 's'}`)
  if (kinds.recovery) parts.push(`${kinds.recovery} run${kinds.recovery === 1 ? '' : 's'} to recover`)
  return { v: 1, alertId, createdAt, title: 'devpanel needs attention', body: parts.join(', '), count: items.length, kinds, url: `/alerts/${alertId}`, tag: `devpanel-alert-${alertId}` }
}

/** Where an item's action is: the issue page at the exact run and waiting event, or the supervisor's question. */
export function itemLink (item) {
  if (item.kind === 'supervisor-question') return `/supervisor?question=${encodeURIComponent(item.questionId)}`
  const base = `/projects/${encodeURIComponent(item.project)}/${encodeURIComponent(item.issueId)}?run=${encodeURIComponent(item.runId)}`
  if (item.key.startsWith('pause:')) return `${base}&pause=${encodeURIComponent(item.key.split('/').at(-1))}`
  if (item.key.startsWith('recovery:')) return `${base}&recovery=${encodeURIComponent(item.key.split('/').at(-1))}`
  return `${base}&wait=owner-input`
}

/**
 * Lines of an append-only JSONL file. A final line with no newline delimiter, or one that does not parse, is a
 * torn append: it is dropped and the file truncated to its last complete line (unlike the spending ledger, which
 * keeps a valid unterminated entry: here every line can be rewritten from state.json). Damage before the last line
 * is reported and never cut.
 */
async function readJson (file, absent) {
  let text
  try { text = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return absent; throw error }
  return JSON.parse(text)
}

async function readLines (file, { repair = false } = {}) {
  let text
  try { text = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return { lines: [], missing: true }; throw error }
  const parts = text.split('\n')
  const tail = parts.pop()
  const lines = []
  let damaged = null
  let truncated = false
  for (let i = 0; i < parts.length; i++) {
    try { lines.push(JSON.parse(parts[i])) } catch {
      if (i === parts.length - 1 && !tail) { truncated = true; parts.length = i; break }
      damaged = `${path.basename(file)} line ${i + 1} does not parse`
      break
    }
  }
  // Only start() repairs: a reader later on may meet an append still being written, which is not damage.
  if (repair && (tail || truncated) && !damaged) await fs.truncate(file, parts.length ? Buffer.byteLength(parts.join('\n') + '\n') : 0)
  return { lines, damaged, torn: tail || truncated ? `${path.basename(file)} last line does not parse` : null }
}

/** A subscription's keys as Web Push needs them: a P-256 point the browser holds the private key of, and a 16-byte secret. */
export function validKeys (p256dh, auth) {
  const point = Buffer.from(String(p256dh ?? ''), 'base64url')
  if (point.length !== 65 || point[0] !== 4 || Buffer.from(String(auth ?? ''), 'base64url').length !== 16) return false
  try { const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); ecdh.computeSecret(point); return true } catch { return false }
}

// Every project listed, every newer run record read, the supervisor answered (attention.mjs attentionItems).
const completeReading = (read) => !read.unreadProjects?.length && !read.unreadRuns?.length && read.questionsRead === true

const deviceOperator = (endpoint) => `device:${crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16)}`

export function createNotifier ({ dir, readItems, transport, readRun = async () => null /* → { run, packed } */, getQuestion = () => null,
  clock = { now: () => Date.now() }, setTimer = setInterval, clearTimer = clearInterval, groupMs = 10000, maxGroupWaitMs = 60000, scanMs = 15000, tickMs = 1000, log = () => {} }) {
  const files = { subs: path.join(dir, 'subscriptions.json'), state: path.join(dir, 'state.json'), alerts: path.join(dir, 'alerts.jsonl'), deliveries: path.join(dir, 'deliveries.jsonl') }
  const iso = () => new Date(clock.now()).toISOString()
  // optedOut has no prototype and is read only through own keys: an operator named like an Object property
  // (constructor, __proto__) is an operator, never an inherited opt-out.
  const operatorMap = (from) => Object.assign(Object.create(null), from ?? {})
  const optedOutAt = (operator) => (operator != null && Object.hasOwn(subs.optedOut, operator) ? subs.optedOut[operator] : null)
  let subs = { subscriptions: [], optedOut: operatorMap() }
  let state = null
  let timer = null
  let ticking = null
  let lastScanAt = 0
  let lastCompleteScanAt = 0  // when the last scan that read every source began
  let nudged = true
  let lastRead = null
  let damaged = null
  const revoked = new Set()
  const lineKeys = new Set()
  const alertIds = new Set()
  const running = new Set()

  let queue = Promise.resolve()
  const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next }
  const saveState = () => serial(() => writeJson(files.state, state))
  const saveSubs = () => serial(() => writeJson(files.subs, subs))
  const lineKey = (deliveryId, n) => `${deliveryId}:${n}`

  // Inside the write queue: state.json is written directly (saveState would wait on this very queue).
  const markHistoryLost = async () => {
    if (state.historyLostAt) return
    state.historyLostAt = iso()
    log(`notifications: deliveries.jsonl went missing after sends were recorded in it; opt-out replies will say so`)
    await writeJson(files.state, state)
  }
  const appendAttemptLine = (d, a) => serial(async () => {
    const key = lineKey(d.deliveryId, a.n)
    if (lineKeys.has(key)) return
    // Lines were written and the file is gone: recreating it below must not make the lost sends look like none.
    if (lineKeys.size && await fs.access(files.deliveries).then(() => false, (error) => error.code === 'ENOENT')) await markHistoryLost()
    await appendDurable(files.deliveries, JSON.stringify({ deliveryId: d.deliveryId, alertId: d.alertId, subscriptionId: d.subscriptionId, operator: d.operator, keys: d.keys, ...a }) + '\n')
    lineKeys.add(key)
    // Evidence that lines exist, kept in state.json: a log missing at a later start is then a lost history.
    if (!state.sendsRecorded) { state.sendsRecorded = true; await writeJson(files.state, state) }
  })
  const appendAlertLine = (alert) => serial(async () => {
    if (alertIds.has(alert.alertId)) return
    await appendDurable(files.alerts, JSON.stringify(alert) + '\n')
    alertIds.add(alert.alertId)
  })

  /** A delivery leaves state only once it is over and every finished attempt has its line in deliveries.jsonl. */
  async function pruneIfDone (d) {
    if (!isTerminal(d) || !d.attempts.filter((a) => FINAL.has(a.outcome)).every((a) => lineKeys.has(lineKey(d.deliveryId, a.n)))) return
    state.pending.deliveries = state.pending.deliveries.filter((x) => x !== d)
    await saveState()
  }

  async function start () {
    await fs.mkdir(dir, { recursive: true })
    // Only a file that does not exist reads as empty: any other failure stops the notifier here, before anything
    // is written, so a read error can never replace the devices, the seen keys or the pending sends.
    subs = await readJson(files.subs, subs)
    subs.optedOut = operatorMap(subs.optedOut)
    for (const s of subs.subscriptions) if (s.revokedAt) revoked.add(s.id)
    state = await readJson(files.state, null)
    if (!state) { state = { installedAt: iso(), seen: {}, group: null, pending: { alerts: [], deliveries: [] } }; await saveState() }
    const deliveries = await readLines(files.deliveries, { repair: true })
    const alerts = await readLines(files.alerts, { repair: true })
    damaged = deliveries.damaged ?? alerts.damaged ?? null
    if (damaged) log(`notifications: ${damaged}; sends are stopped until it is repaired`)
    for (const l of deliveries.lines) lineKeys.add(lineKey(l.deliveryId, l.n))
    for (const a of alerts.lines) alertIds.add(a.alertId)
    // Evidence that sends were made survives the log itself: a missing deliveries.jsonl is then never an empty history.
    if (lineKeys.size && !state.sendsRecorded) state.sendsRecorded = true
    // Lines were written once and the file is gone: that stays known (historyLostAt) after the repair below
    // recreates the file with other attempts' lines.
    if (deliveries.missing && state.sendsRecorded && !state.historyLostAt) {
      state.historyLostAt = iso()
      log('notifications: deliveries.jsonl is missing although sends were recorded in it; opt-out replies will say so')
    }
    // An alert whose line a crash cut short is written now (it was in state.json first).
    for (const alert of state.pending.alerts) await appendAlertLine(alert)
    state.pending.alerts = []
    for (const d of state.pending.deliveries) {
      for (const a of d.attempts) {
        // Cut off before or during its request: whether the push service got it cannot be known.
        if (a.outcome === 'sending') Object.assign(a, { outcome: 'unanswered', cause: 'restart', endedAt: null })
      }
    }
    await saveState()
    // Every finished attempt in state gets its line, at most once by key; then whatever is over leaves state.
    for (const d of [...state.pending.deliveries]) {
      for (const a of d.attempts) if (FINAL.has(a.outcome)) await appendAttemptLine(d, a)
      await pruneIfDone(d)
    }
    timer = setTimer(() => { tick().catch((error) => log(`notifications: ${error.message}`)) }, tickMs)
  }

  function stop () { if (timer) clearTimer(timer); timer = null }

  function nudge () { nudged = true }

  async function scan () {
    const startedAt = clock.now()
    lastScanAt = startedAt
    nudged = false
    const read = await readItems()
    lastRead = { at: iso(), complete: completeReading(read), keys: new Set(read.items.map((i) => i.key).filter(Boolean)) }
    if (lastRead.complete) lastCompleteScanAt = startedAt
    const fresh = []
    const seenBefore = Object.keys(state.seen).length
    for (const item of read.items) {
      if (!item.key || !ALERT_KINDS.has(item.kind) || state.seen[item.key]) continue
      state.seen[item.key] = iso()
      // Only a wait that began, by its own record, after alerts were installed is new; the rest is the baseline.
      if (item.enteredBasis === 'recorded' && item.enteredAt >= state.installedAt) {
        fresh.push({ key: item.key, kind: item.kind, project: item.project ?? null, issueId: item.issueId ?? null, runId: item.runId ?? null, questionId: item.questionId ?? null, enteredAt: item.enteredAt })
      }
    }
    if (fresh.length) {
      state.group ??= { openedAt: iso(), deadline: clock.now() + groupMs, items: [] }
      state.group.items.push(...fresh)
    }
    if (Object.keys(state.seen).length !== seenBefore) await saveState()
  }

  async function flushGroup () {
    // Closed on a reading that began once the window had ended and read every source: an item that started waiting
    // inside the window is then in it, whatever a nudge, a slow scan or an unreadable project or run did. But never
    // later than maxGroupWaitMs past the window: then the items read so far go out, and an item found later goes in
    // an alert of its own (a split the at-least-once decision accepts), so one unreadable source stalls nobody.
    if (!state.group || state.group.deadline > clock.now()) return
    const overdue = clock.now() >= state.group.deadline + maxGroupWaitMs
    if (!overdue && lastCompleteScanAt < state.group.deadline) return
    if (overdue && lastCompleteScanAt < state.group.deadline) log(`notifications: an alert of ${state.group.items.length} item(s) goes out after waiting ${maxGroupWaitMs / 1000} s for a complete reading`)
    const alert = { alertId: crypto.randomUUID(), createdAt: iso(), items: state.group.items }
    const payload = alertPayload(alert)
    state.pending.alerts.push(alert)
    for (const s of subs.subscriptions) {
      if (s.revokedAt || optedOutAt(s.operator)) continue
      state.pending.deliveries.push({ deliveryId: crypto.randomUUID(), alertId: alert.alertId, subscriptionId: s.id, operator: s.operator, keys: alert.items.map((i) => i.key), payload, attempts: [], connectRetries: 0, nextAt: 0 })
    }
    state.group = null
    await saveState()
    await appendAlertLine(alert)
    state.pending.alerts = state.pending.alerts.filter((a) => a.alertId !== alert.alertId)
    await saveState()
  }

  async function attempt (d) {
    running.add(d.deliveryId)
    try {
      const sub = subs.subscriptions.find((s) => s.id === d.subscriptionId)
      const a = { n: d.attempts.length + 1, persistedAt: iso(), outcome: 'sending' }
      d.attempts.push(a)
      await saveState()
      // The revocation check and the request start run in this one tick: an opt-out either came first and nothing
      // is sent, or the request had already started and the opt-out reply names it.
      let pending = null
      if (!sub || revoked.has(d.subscriptionId)) {
        Object.assign(a, { outcome: 'skipped-revoked', endedAt: iso() })
        d.ending = 'skipped-revoked'
      } else {
        a.fetchStartedAt = iso()
        try { pending = transport.send(sub, d.payload, { timeoutMs: TIMEOUT_MS }) } catch (error) {
          // Thrown before any request was made (the payload could not be encrypted for this subscription).
          pending = Promise.resolve({ outcome: 'failed', status: null, error: error.message, endedAt: iso() })
        }
      }
      if (pending) {
        const result = await pending
        Object.assign(a, { outcome: result.outcome, endedAt: result.endedAt ?? iso(), ...(result.status != null ? { status: result.status } : {}), ...(result.cause ? { cause: result.cause } : {}), ...(result.error ? { error: result.error } : {}) })
        if (result.outcome === 'connect-error') {
          d.connectRetries = (d.connectRetries ?? 0) + 1
          d.nextAt = clock.now() + 5000 * 2 ** (d.connectRetries - 1)
        }
        if (result.outcome === 'gone' && sub && !sub.revokedAt) {
          // The push service says this subscription no longer exists.
          sub.revokedAt = iso(); sub.revokedReason = 'gone'; revoked.add(sub.id)
          await saveSubs()
        }
      }
      await saveState()
      await appendAttemptLine(d, a)
      await pruneIfDone(d)
    } finally { running.delete(d.deliveryId) }
  }

  function dispatch () {
    if (damaged) return []
    const started = []
    for (const d of state.pending.deliveries) {
      if (running.has(d.deliveryId) || isTerminal(d) || (d.nextAt ?? 0) > clock.now()) continue
      // A resend (after a restart) only while someone can still use it: not for an alert whose items were all handled.
      if (d.attempts.length && lastRead?.complete && d.keys.every((k) => !lastRead.keys.has(k))) {
        d.ending = 'superseded'
        started.push(saveState().then(() => pruneIfDone(d)).catch((error) => log(`notifications: delivery ${d.deliveryId}: ${error.message}`)))
        continue
      }
      // A failed worker (a state write, a malformed subscription) is logged, never left to escape the server's timer.
      started.push(attempt(d).catch((error) => log(`notifications: delivery ${d.deliveryId}: ${error.message}`)))
    }
    return started
  }

  // Ticks never overlap: a call while one runs gets that one (its sends too, when it was asked to wait for them).
  function tick ({ wait = false } = {}) {
    if (ticking) return ticking
    ticking = (async () => {
      // A group never closes on a reading older than its window: items that began inside it are read first.
      const closing = state.group && state.group.deadline <= clock.now() && lastCompleteScanAt < state.group.deadline
      if (nudged || closing || clock.now() - lastScanAt >= scanMs) await scan()
      await flushGroup()
      const sends = dispatch()
      if (wait) await Promise.all(sends)
    })().finally(() => { ticking = null })
    return ticking
  }

  // ---- subscriptions -------------------------------------------------------

  const view = (s) => ({ id: s.id, label: s.label, createdAt: s.createdAt, revokedAt: s.revokedAt ?? null })

  async function subscribe ({ operator, subscription, label = null }) {
    const endpoint = subscription?.endpoint
    if (!allowedEndpoint(endpoint)) throw Object.assign(new Error('That push endpoint is not on the allow-list (docs/operator-alerts.md)'), { status: 400 })
    const p256dh = subscription?.keys?.p256dh
    const auth = subscription?.keys?.auth
    if (!validKeys(p256dh, auth)) throw Object.assign(new Error('The subscription keys are malformed'), { status: 400 })
    // A browser with no name and no login is registered on its own, never in a registry shared with other devices.
    operator ??= deviceOperator(endpoint)
    // Only this explicit request opts in; a device revoked before gets a new subscription record.
    const existing = subs.subscriptions.find((s) => s.endpoint === endpoint && !s.revokedAt)
    const record = existing ?? { id: crypto.randomUUID(), operator, endpoint, keys: { p256dh, auth }, label: String(label ?? 'browser').slice(0, 80), createdAt: iso() }
    if (existing) Object.assign(existing, { operator, keys: { p256dh, auth } })
    else subs.subscriptions.push(record)
    delete subs.optedOut[operator]
    await saveSubs()
    return view(record)
  }

  /** The operator's devices, and this browser's own subscription found by its endpoint, whoever it was registered to. */
  function list (operator, { endpoint = null } = {}) {
    const mine = operator ? subs.subscriptions.filter((s) => s.operator === operator && !s.revokedAt) : []
    const device = endpoint ? subs.subscriptions.find((s) => s.endpoint === endpoint && !s.revokedAt) ?? null : null
    return { optedOut: optedOutAt(operator), subscriptions: mine.map(view), thisDevice: device ? view(device) : null, damaged }
  }

  /**
   * Opt-out: the devices are marked revoked in memory as the first statement (no request starts after this), then
   * on disk, then the reply names what may still arrive (owner decision): sends the push service accepted, with the
   * time their 1-hour TTL ends; sends that got no answer, uncertain, with no time (the panel cannot see when the
   * push service received one); those of the last 2 hours are listed, older ones counted.
   */
  async function unsubscribe ({ operator = null, id = null, endpoint = null }) {
    const pick = (s) => endpoint ? s.endpoint === endpoint : id ? s.id === id && s.operator === operator : Boolean(operator) && s.operator === operator
    const targets = subs.subscriptions.filter((s) => pick(s) && !s.revokedAt)
    for (const s of targets) revoked.add(s.id)
    // A repeated opt-out is answered again in full (its earlier reply may have been lost), never refused.
    const known = subs.subscriptions.filter(pick)
    if (!known.length && (id || endpoint)) throw Object.assign(new Error('No such subscription'), { status: 404 })
    const at = iso()
    for (const s of targets) { s.revokedAt = at; s.revokedReason = 'opt-out' }
    if (!id && !endpoint && operator) subs.optedOut[operator] = at
    // Written on every opt-out, a repeated one included: the first may have failed to write what memory already holds.
    await saveSubs()
    const completedAt = iso()
    const endpoints = new Set(known.map((s) => s.endpoint))
    const history = new Set(subs.subscriptions.filter((s) => endpoints.has(s.endpoint)).map((s) => s.id))
    return { completedAt, revoked: targets.map(view), ...await mayStillArrive(history, completedAt) }
  }

  async function mayStillArrive (ids, completedAt) {
    const label = new Map(subs.subscriptions.map((s) => [s.id, s.label]))
    const seen = new Set()
    const all = []
    for (const d of state.pending.deliveries) {
      if (!ids.has(d.subscriptionId)) continue
      for (const a of d.attempts) { seen.add(lineKey(d.deliveryId, a.n)); all.push({ ...a, subscriptionId: d.subscriptionId, alertId: d.alertId }) }
    }
    // History the panel cannot read in full is said to be so, never taken for empty.
    let historyUnavailable = null
    let logged = []
    try {
      // Read in the write queue, so an append in progress is never taken for damage.
      const read = await serial(() => readLines(files.deliveries))
      logged = read.lines
      if (read.damaged || read.torn) historyUnavailable = read.damaged ?? read.torn
      // Lost once, it stays lost: the lines it held are not in a file recreated since (no age resolves an uncertain send).
      else if (state.historyLostAt) historyUnavailable = `deliveries.jsonl went missing (noticed ${state.historyLostAt}) after sends were recorded in it`
      // Sends were recorded in it (known now, or by state.json across a restart), yet the file is gone: not an empty history.
      else if (read.missing && (lineKeys.size || state.sendsRecorded)) historyUnavailable = 'deliveries.jsonl is missing although sends were recorded in it'
    } catch (error) { historyUnavailable = `deliveries.jsonl could not be read (${error.code ?? error.message})` }
    for (const l of logged) {
      if (ids.has(l.subscriptionId) && !seen.has(lineKey(l.deliveryId, l.n))) all.push(l)
    }
    const now = Date.parse(completedAt)
    const accepted = []
    const uncertain = []
    const older = { count: 0, oldestStartedAt: null }
    for (const a of all) {
      const entry = { device: label.get(a.subscriptionId) ?? 'device', alertId: a.alertId, attempt: a.n }
      if (a.outcome === 'accepted') {
        const latestArrival = new Date(Date.parse(a.endedAt) + TTL_SECONDS * 1000).toISOString()
        if (Date.parse(latestArrival) > now) accepted.push({ ...entry, endedAt: a.endedAt, latestArrival })
      } else if ((a.outcome === 'sending' && a.fetchStartedAt) || a.outcome === 'unanswered') {
        const startedAt = a.fetchStartedAt ?? a.persistedAt
        if (now - Date.parse(startedAt) <= LIST_HORIZON_MS) uncertain.push({ ...entry, startedAt, cause: a.outcome === 'sending' ? 'in-flight' : a.cause })
        else {
          older.count++
          if (!older.oldestStartedAt || startedAt < older.oldestStartedAt) older.oldestStartedAt = startedAt
        }
      }
    }
    return { accepted, uncertain, uncertainOlder: older, historyUnavailable }
  }

  // ---- reading alerts --------------------------------------------------------

  async function findAlert (alertId) {
    const pendingAlert = state.pending.alerts.find((a) => a.alertId === alertId)
    if (pendingAlert) return pendingAlert
    return (await readLines(files.alerts)).lines.find((a) => a.alertId === alertId) ?? null
  }

  /**
   * Each item of an alert, with where it is now. The inbox reading says what waits; an item it does not list is
   * read from its own record: the exact run (journal finding included; a packed issue's run from its bundle) or the
   * supervisor's question. Only a record that says so makes an item handled: a wait the record still holds open is
   * waiting, and one nothing can be read for while the inbox reading was incomplete is unknown, never handled.
   */
  async function alert (alertId) {
    const found = await findAlert(alertId)
    if (!found) return null
    const read = await readItems()
    const complete = completeReading(read)
    const waiting = new Set(read.items.map((i) => i.key).filter(Boolean))
    const items = []
    for (const item of found.items) {
      const out = { key: item.key, kind: item.kind, project: item.project, issueId: item.issueId, runId: item.runId, questionId: item.questionId, enteredAt: item.enteredAt, link: itemLink(item) }
      if (waiting.has(item.key)) { items.push({ ...out, state: 'waiting' }); continue }
      let row = null
      if (item.kind === 'supervisor-question') {
        const q = getQuestion(item.questionId)
        if (!q) { items.push({ ...out, state: complete ? 'retired' : 'unknown' }); continue }
        row = questionWait(q)
      } else {
        const got = await readRun(item.project, item.issueId, item.runId).catch(() => null)
        const run = got?.run ?? null
        if (run) {
          // A record of the wrong shape is this item's problem alone: it reads "unreadable", keeping its link, and
          // the other items of the alert are resolved as usual.
          try {
            row = runWaits(run, { project: item.project, issueId: item.issueId }).find((r) => r.key === item.key) ?? null
          } catch (error) {
            items.push({ ...out, state: 'unreadable', reason: `the run record cannot be read (${error.message})` })
            continue
          }
          out.current = { status: run.status ?? null, blockedReason: run.blockedReason ?? null, recoveryRequired: run.recovery?.required === true || run.blockedReason === 'recovery-required', packed: Boolean(got.packed) }
        }
      }
      if (row?.handledBasis === 'pending') items.push({ ...out, state: 'waiting' })
      else if (row) items.push({ ...out, state: 'handled', handled: { at: row.handledAt, by: row.by, how: row.how, basis: row.handledBasis } })
      // The run was read and holds no such wait any more: handled, though no record says when.
      else if (out.current) items.push({ ...out, state: 'handled', handled: { at: null, by: null, how: null, basis: 'not-recorded' } })
      // Its record could not be read: what became of it is not known, whatever the inbox listed.
      else items.push({ ...out, state: 'unknown' })
    }
    return { alertId: found.alertId, createdAt: found.createdAt, items }
  }

  /** Accepted alerts per waiting key, for time-to-response (read after start's repair, so a cut-off line is counted). */
  async function alertedKeys () {
    const keys = new Map()
    for (const l of (await readLines(files.deliveries)).lines) {
      if (l.outcome !== 'accepted') continue
      for (const k of l.keys ?? []) if (!keys.has(k) || l.endedAt < keys.get(k)) keys.set(k, l.endedAt)
    }
    return keys
  }

  return {
    start, stop, nudge, tick, subscribe, unsubscribe, list, alert, alertedKeys,
    installedAt: () => state?.installedAt ?? null,
    publicKey: () => transport.publicKey?.() ?? null,
    // For tests: the in-memory revocation set and state, as the dispatch reads them.
    _state: () => state
  }
}
