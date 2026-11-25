/*
 * Operator alerts in the browser (docs/operator-alerts.md): the service worker, the push subscription, and the
 * opt-out confirmation's wording. Imports nothing from the app so the wording can be tested on its own.
 */

export const pushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

const keyBytes = (b64u) => {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4)
  const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

const sameKey = (a, b) => {
  if (!a || !b) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

/**
 * Ask the browser for a push subscription for this panel's VAPID key; the caller sends it to the server. A
 * subscription the browser holds for another key (the panel's key was replaced) is dropped and made again.
 */
export async function browserSubscription (publicKey) {
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('The browser did not allow notifications for this site')
  const key = keyBytes(publicKey)
  let existing = await registration.pushManager.getSubscription()
  if (existing && !sameKey(existing.options?.applicationServerKey, key)) { await existing.unsubscribe(); existing = null }
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  return subscription.toJSON()
}

/** Whether this browser's subscription was made for the panel's current VAPID key (false after the key was replaced). */
export async function subscriptionKeyMatches (publicKey) {
  if (!pushSupported() || !publicKey) return true
  const registration = await navigator.serviceWorker.getRegistration('/')
  const existing = await registration?.pushManager.getSubscription()
  return !existing || sameKey(existing.options?.applicationServerKey, keyBytes(publicKey))
}

/** This browser's push endpoint, when it has a subscription; the server finds this device's registration by it. */
export async function currentEndpoint () {
  if (!pushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration('/')
  return (await registration?.pushManager.getSubscription())?.endpoint ?? null
}

/*
 * Where an alert's link lands, decided from the run as the page reads it now (docs/operator-alerts.md):
 * `waiting` with the action to scroll to, `recovery` when the run needs recovery instead (answering is refused
 * then), or `handled` with the run's current state. Null when the page was not opened from an alert link.
 */
// The control a recovery is acted on, in the order the server offers them (supervisor.mjs supportedActions):
// Recover run for an owner loss, Inspect changes for an integrity quarantine, Abandon run for an inactive one, and
// Stop for a run still active with a damaged journal (it is stopped first, then abandoned).
const recoveryAction = (run) => ['recover', 'resolve-integrity', 'abandon', 'stop'].find((a) => (run.supportedActions ?? []).includes(a)) ?? null

// The issue page sections (its Sections bar ids, IssueView.vue pageSections) that hold an alert target, shown for the
// visit even when this browser hid them: the answer and triage forms sit in Status, the run controls in the run
// picker bar, an archived run's entry in the run card.
const SECTIONS = { answer: ['run', 'status'], 'owner-input': ['run', 'status'], packed: ['run'] }
// With no action to take (handled, or a recovery the server offers no action for), the run card and its Status show
// the alert's note and the run as it is now.
export const alertSections = (target) => (target ? SECTIONS[target] ?? ['run', 'runbar'] : ['run', 'status'])

export function alertDestination (run, query = {}) {
  if (!run || query.run !== run.runId || !(query.pause || query.recovery || query.wait)) return null
  // An abandoned run's journal finding stays readable as evidence, but it is no longer a recovery to act on.
  const recoveryNow = !run.abandonment && (run.recovery?.required === true || run.blockedReason === 'recovery-required' || run.journal?.recoveryRequired === true)
  const occurrence = (run.recovery?.required ? (run.recovery.continuesFrom ?? run.recovery.detectedAt) : null) ?? 'undated'
  const what = query.pause ? 'question' : query.recovery ? 'recovery' : 'question to the owner'
  const base = { what, status: run.status ?? null, blockedReason: run.blockedReason ?? null }
  if (query.recovery) {
    return recoveryNow && occurrence === query.recovery ? { ...base, state: 'waiting', target: recoveryAction(run) }
      : recoveryNow ? { ...base, state: 'recovery', target: recoveryAction(run) } : { ...base, state: 'handled', target: null }
  }
  const open = query.pause ? (run.status === 'paused' && run.pause?.id === query.pause) : (Boolean(run.ownerInput) && !run.ownerInput.answer)
  if (open && recoveryNow) return { ...base, state: 'recovery', target: recoveryAction(run) }
  if (open) return { ...base, state: 'waiting', target: query.pause ? 'answer' : 'owner-input' }
  return { ...base, state: recoveryNow ? 'recovery' : 'handled', target: recoveryNow ? recoveryAction(run) : null }
}

/** The supervisor page's counterpart: the named question still open, answered (by whom, when), or gone with its session. */
export function questionDestination (questions = [], id) {
  if (!id) return null
  const q = questions.find((x) => x.id === id)
  if (!q) return { state: 'retired' }
  return q.answer ? { state: 'answered', by: q.answer.actor ?? null, at: q.answer.at ?? null } : { state: 'waiting' }
}

/** A short name for this device, so an operator can tell their devices apart. */
export const deviceLabel = () => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device'
  const browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'
  return `${browser} on ${os}`
}

const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
const latest = (list, field) => list.reduce((max, e) => (e[field] > max ? e[field] : max), list[0][field])

/**
 * The opt-out confirmation (owner decision): nothing new is sent; sends the push service accepted may still appear
 * until their 1-hour TTL ends; sends that got no answer are uncertain, with no time the panel could know; older
 * unanswered sends are always counted.
 */
// "Turn off all of mine" whenever the operator has an active subscription, even just one: it is the opt-out whose
// reply also covers the operator's earlier endpoints (docs/operator-alerts.md).
export const offersTurnOffAll = (status) => Boolean(status?.operator) && (status?.subscriptions?.length ?? 0) >= 1

export function optOutSentences ({ accepted = [], uncertain = [], uncertainOlder = { count: 0 }, historyUnavailable = null } = {}) {
  const lines = ['Alerts are off; nothing new will be sent.']
  if (accepted.length) lines.push(`${accepted.length} alert${accepted.length === 1 ? ' was' : 's were'} accepted by the push service and may still appear until ${hhmm(latest(accepted, 'latestArrival'))}.`)
  if (uncertain.length) lines.push(`${uncertain.length} send${uncertain.length === 1 ? '' : 's'} got no answer, so it is uncertain whether the push service received ${uncertain.length === 1 ? 'it' : 'them'}. If it did, each may appear up to one hour after the service received it, a time the panel cannot see.`)
  if (uncertainOlder?.count) lines.push(`${uncertainOlder.count} older send${uncertainOlder.count === 1 ? '' : 's'}, the oldest from ${when(uncertainOlder.oldestStartedAt)}, also got no answer; the panel cannot rule out that ${uncertainOlder.count === 1 ? 'it' : 'they'} may still appear.`)
  if (historyUnavailable) lines.push(`The panel could not read its whole record of earlier sends (${historyUnavailable}), so it cannot say which sends from before this may still appear within their hour.`)
  return lines
}
