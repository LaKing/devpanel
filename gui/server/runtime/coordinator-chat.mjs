import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as store from './store.mjs'
import { classifyFailure } from './failure.mjs'
import { appendDurable } from './persistence.mjs'

/*
 * The operator's conversation with a run's coordinator.
 *
 * Two kinds of message, kept apart because they differ in authority:
 *
 * - A QUESTION is answered in a fork of the coordinator's native session: one
 *   tool-free turn on a copy, so the run's own session never gains a turn and
 *   nothing the answer says reaches the run. It may be asked at any time,
 *   including while the coordinator is mid-turn (the copy then knows the run up
 *   to its last completed turn, and the prompt says where the run is now).
 *
 * - An INSTRUCTION steers the run. It is delivered by the engine, verbatim, in
 *   the next turn of EVERY seat (coordinator, author, each auditor), and that
 *   step records which instructions it carried (`step.instructions`, beside the
 *   step's `role`). Delivery is per seat and session scope: a seat's turn is
 *   given what no recorded step of the same role and scope carried, and a fresh
 *   session (none yet, or one reset by the engine) receives every instruction
 *   so far, because it never saw the earlier ones. A re-invocation of a turn
 *   that may already have reached its session replays that turn's snapshot
 *   (selectInstructions).
 *
 * Everything is one append-only file, runs/<id>/chat.jsonl, written before the
 * socket event announces it. It is not run state: the engine reads it only to
 * build a seat's prompt, so replaying the recorded steps is unaffected.
 */

const NL = '\n'
export const MAX_TEXT = 8000
const ASK_TIMEOUT_MS = 10 * 60 * 1000

export const chatFile = (issuePath, runId) => path.join(store.runDir(issuePath, runId), 'chat.jsonl')

const queues = new Map()
/** Appends to one file never interleave within this process. */
function serial (file, fn) {
  const next = (queues.get(file) ?? Promise.resolve()).then(fn, fn)
  queues.set(file, next.catch(() => {}))
  return next
}

/** Every entry, oldest first. A torn final line (a crash mid-append) is skipped. */
export async function readChat (issuePath, runId) {
  let text
  try { text = await fs.readFile(chatFile(issuePath, runId), 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const out = []
  for (const line of text.split(NL)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* torn */ }
  }
  return out
}

/**
 * Run `fn` with this run's chat appends held: none starts and none is half
 * written while it runs. The engine reads the chat, attaches the instructions
 * and calls the runtime inside it, so an instruction recorded before the call
 * is in the prompt and one recorded after waits for the seat's next turn.
 */
export function underChatLock (issuePath, runId, fn) {
  return serial(chatFile(issuePath, runId), () => fn())
}

export async function appendChat (issuePath, runId, entry) {
  const file = chatFile(issuePath, runId)
  // Durable before anything acknowledges what it records (an integrity
  // failure, harness/config-guard.mjs resolveConfig).
  await serial(file, () => appendDurable(file, JSON.stringify(entry) + NL))
  return entry
}

/** The coordinator seat: the coordination-only participant, `coordinator` first. */
export function coordinatorRole (snapshot) {
  const roles = Object.entries(snapshot?.participants ?? {}).filter(([, p]) => p.coordinationOnly === true).map(([role]) => role)
  return roles.includes('coordinator') ? 'coordinator' : roles[0] ?? null
}

/**
 * Instructions a turn of `role` in `scope` ('main' or 'read') must still be
 * given. A fresh session gets all of them; otherwise those no earlier step of
 * the same role and scope carried. Without a role, any role's step counts.
 */
export function instructionsFor (entries, steps, { role = null, scope = 'main', freshSession = false } = {}) {
  const all = entries.filter((e) => e.kind === 'instruction')
  if (freshSession) return all
  const carried = new Set(steps.filter((s) => (role === null || s.role === role) && (s.instructionScope ?? 'main') === scope).flatMap((s) => s.instructions ?? []))
  return all.filter((e) => !carried.has(e.id))
}

/**
 * One scheduled turn's identity, from a pending invocation's cursor: what the
 * scheduler tells turns apart by (engine.mjs attemptsOf), so a re-review for a
 * new drive is a new turn, never a retry of an earlier one.
 */
export const turnIdentity = (c = {}) => JSON.stringify([c.phase ?? null, c.stepId ?? null, c.round ?? null, c.attempt ?? null,
  c.recheck ?? null, c.recheckDrive ?? null, c.diagnosticOf ?? null, c.reconcileNotice ?? null])

/**
 * What one launch of a seat's turn carries. `record` is the seat's
 * `turnInstructions` ({ key, snapshot: { ids, available }, reached: [{ invocationId, scope }] }):
 * the snapshot of a turn some attempt may already have delivered to a native
 * session. Returns the list (chat order), the ids to mark as given earlier,
 * the session scopes to reset before the call, and the snapshot to keep.
 *
 * - The same turn with a reached attempt is a REPLAY: it carries the turn's
 *   own snapshot, never what was recorded later. A session that may hold the
 *   earlier prompt is never resumed with instructions: the reached scopes are
 *   reset when the snapshot carried any, and the turn's own scope when it did
 *   or when no reached attempt used it. Fresh, it carries everything the
 *   snapshot's boundary held, all marked earlier; kept, the snapshot's ids ([]).
 * - Otherwise (a new turn, or one no attempt reached) the owed list is read
 *   from the chat; a stale record of another turn that sent instructions has
 *   its sessions reset. Earlier marks only on a fresh session: this seat's own
 *   carries and a reached stale attempt's ids.
 */
export function selectInstructions ({ entries, steps, role, scope = 'main', freshSession = false, record = null, key }) {
  const all = entries.filter((e) => e.kind === 'instruction')
  const reached = record?.reached ?? []
  const sent = record?.snapshot?.ids ?? []
  const replay = Boolean(record) && record.key === key && reached.length > 0
  const reset = new Set()
  if (reached.length && sent.length) for (const r of reached) reset.add(r.scope)
  if (replay && (sent.length || !reached.some((r) => r.scope === scope))) reset.add(scope)
  const fresh = freshSession || reset.has(scope)
  if (replay) {
    const keep = new Set(fresh ? record.snapshot.available ?? [] : sent)
    const list = all.filter((e) => keep.has(e.id))
    return { list, earlier: fresh ? new Set(list.map((e) => e.id)) : new Set(), reset: [...reset], replay: true, snapshot: record.snapshot }
  }
  const list = instructionsFor(entries, steps, { role, scope, freshSession: fresh })
  const earlier = fresh ? new Set([...steps.filter((s) => s.role === role).flatMap((s) => s.instructions ?? []), ...(reached.length ? sent : [])]) : new Set()
  return { list, earlier, reset: [...reset], replay: false, snapshot: { ids: list.map((e) => e.id), available: all.map((e) => e.id) } }
}

/**
 * The record a pending invocation from before per-seat delivery leaves for its
 * re-invocation: exactly the ids it was sent, and on a fresh session the ids
 * this seat's own steps carried. No timestamp is evidence of what a prompt held.
 */
export function legacyTurnRecord (pending, entries, steps, role) {
  const ids = pending.instructions ?? []
  const keep = new Set([...ids, ...steps.filter((s) => s.role === role).flatMap((s) => s.instructions ?? [])])
  const available = entries.filter((e) => e.kind === 'instruction' && keep.has(e.id)).map((e) => e.id)
  const scope = pending.instructionScope ?? (pending.sessionScope === 'read' ? 'read' : 'main')
  return { key: turnIdentity(pending.cursor), snapshot: { ids, available }, reached: [{ invocationId: pending.invocationId, scope }] }
}

const COORDINATOR_PREAMBLE = 'The person responsible for this run wrote the following while it was running. Follow them in this and later turns unless doing so would break the output contract or a rule stated above; when you do not follow one, say which and why in your response. They direct the run; they are not evidence about the project.'
const SEAT_PREAMBLE = 'The person responsible for this run wrote the following while it was running. Take them into account in this and later turns unless doing so would break the output contract or a rule of this prompt; when you do not follow one, say which and why in your response. An instruction is information for your turn, not evidence about the project: it approves nothing, waives no criterion, check or closure condition, and you cannot restart, reset or end the run on its account. Only the coordinator\'s decisions do that.'

/**
 * `seat`: 'coordinator' keeps the coordinator's wording; any other seat is told what an instruction is not.
 * Each instruction's text follows its header line exactly as recorded: nothing is added inside it.
 */
export function instructionsBlock (list, { earlier = new Set(), seat = 'coordinator' } = {}) {
  return [
    '## Operator instructions',
    seat === 'coordinator' ? COORDINATOR_PREAMBLE : SEAT_PREAMBLE,
    '',
    ...list.map((e) => `- ${earlier.has(e.id) ? '(given earlier) ' : ''}${e.at} — ${e.actor}:${NL}${String(e.text)}${NL}`)
  ].join(NL)
}

/** Each entry with what became of it, for the panel. */
export function chatView (entries, steps, { asking = new Map() } = {}) {
  const answered = new Set(entries.filter((e) => e.kind === 'answer').map((e) => e.replyTo))
  return entries.map((e) => {
    if (e.kind === 'instruction') {
      const carriedBy = steps.filter((s) => (s.instructions ?? []).includes(e.id)).map((s) => ({ step: s.number, stepId: s.stepId, role: s.role ?? null, scope: s.instructionScope ?? 'main', at: s.startedAt ?? null }))
      return { ...e, delivery: carriedBy.length ? 'delivered' : 'waiting', carriedBy }
    }
    if (e.kind === 'question') {
      if (answered.has(e.id)) return { ...e, state: 'answered' }
      if (!asking.has(e.id)) return { ...e, state: 'interrupted' }
      // asking: a Set of question ids, or a Map of question id -> the fork's invocation id
      const invocationId = asking instanceof Map ? asking.get(e.id) : null
      return { ...e, state: 'asking', ...(invocationId ? { invocationId } : {}) }
    }
    return e
  })
}

function validText (text) {
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('a message is required'), { status: 400 })
  if (text.length > MAX_TEXT) throw Object.assign(new Error(`a message is limited to ${MAX_TEXT} characters`), { status: 413 })
  return text.trim()
}
function validActor (actor) {
  if (typeof actor !== 'string' || !actor.trim()) throw Object.assign(new Error('name who is writing'), { status: 400 })
  return actor.trim().slice(0, 120)
}

/** Ended runs take no instructions: there is no later turn of any seat to give them to. */
export function instructionRefusal (run) {
  if (run.status === 'completed') return 'This run has completed; there is no later turn of any seat. Add a note to the issue or start a new run.'
  if (run.abandonment || run.integrity?.status === 'abandoned') return 'This run was abandoned.'
  return null
}

export async function recordInstruction ({ issuePath, runId, run, text, actor, clock = { iso: () => new Date().toISOString() } }) {
  const refusal = instructionRefusal(run)
  if (refusal) throw Object.assign(new Error(refusal), { status: 409 })
  return appendChat(issuePath, runId, { id: `ins-${crypto.randomUUID()}`, kind: 'instruction', at: clock.iso(), actor: validActor(actor), text: validText(text) })
}

/** Where the run stands now, for a fork that knows it only up to its last turn. */
function runStanding (run) {
  const working = Object.entries(run.participants ?? {}).filter(([, p]) => p.pendingInvocation).map(([role, p]) => `${role} (step ${p.pendingInvocation.cursor?.stepId ?? '?'}, round ${(p.pendingInvocation.cursor?.round ?? 0) + 1})`)
  const last = run.steps?.at(-1)
  return [
    `Run status now: ${run.status}${run.blockedReason ? ` (${run.blockedReason})` : ''}.`,
    working.length ? `Working at this moment: ${working.join(', ')}.` : 'No agent is working at this moment.',
    last ? `Last recorded step: ${last.number} ${last.stepId} by ${last.role}.` : 'No step is recorded yet.',
    run.revisions?.length ? `Current revision: ${run.revisions.at(-1).fingerprint}.` : 'No candidate revision exists yet.'
  ].join(' ')
}

export function askPrompt ({ question, actor, run }) {
  return [
    '[A side question from the operator. This is not a turn of the run.]',
    '',
    'An operator watching this run is asking you the question below. Answer it in plain prose from what you know of this run: your reasoning, what you have decided and why, what you expect next. You cannot act here, and no output contract applies. This reply is shown to the operator only; it never reaches the run, its participants or its record, and you will not remember it in your next turn. If the operator should change the run\'s course, say what instruction they could give it.',
    '',
    runStanding(run),
    '',
    `Question from ${actor}:`,
    question
  ].join(NL)
}

/**
 * Ask the coordinator, in a fork of its session. Reads the engine's state and
 * writes only the chat file, the fork's live output and its adapter ledger;
 * never run.json. `engine` may be the live one or a lock-free read of the run.
 */
export async function askCoordinator (engine, { text, actor, harnesses, emit = null, onAsking = null, signal = null }) {
  const question = validText(text)
  const who = validActor(actor)
  const { run, snapshot, issuePath, runId } = engine
  const role = coordinatorRole(snapshot)
  if (!role) throw Object.assign(new Error('this run has no coordinator seat'), { status: 409 })
  const p = run.participants?.[role]
  const session = p?.session?.id ? p.session : p?.readSession?.id ? p.readSession : null
  if (!session) throw Object.assign(new Error('the coordinator has not completed a turn yet; there is no session to ask'), { status: 409 })
  const readScope = session === p.readSession
  const spec = engine.participantSpec(role)
  const adapter = harnesses?.[spec.model.harness]
  const loadFailure = harnesses?.[Symbol.for('devpanel.harnessLoadFailures')]?.[spec.model.harness]   // engine.mjs harnessUnavailable
  if (!adapter) throw Object.assign(new Error(`the ${spec.model.harness} harness is not available${loadFailure ? `: it failed to load (${loadFailure.message}); restart the service` : ''}`), { status: 503 })

  const at = new Date().toISOString()
  const entry = await appendChat(issuePath, runId, { id: `q-${crypto.randomUUID()}`, kind: 'question', at, actor: who, text: question, role, model: spec.model.id ?? null })
  // The fork's invocation id travels with the question, so a viewer can follow its output
  // without waiting for (or receiving) any output chunk.
  const invocationId = `ask-${crypto.randomUUID()}`
  emit?.({ type: 'chat', entry: { ...entry, state: 'asking', invocationId } })
  onAsking?.(entry.id, invocationId)

  // The same working directory and home the coordinator's turns used: the CLI
  // finds a session by the directory it was started in.
  const runDirectory = store.runDir(issuePath, runId)
  const ws = run.workspace ?? {}
  const scratchDir = ws.scratchPath ? path.join(ws.scratchPath, role) : path.join(runDirectory, 'chat-scratch')
  const cwd = readScope ? ws.path : scratchDir
  await fs.mkdir(scratchDir, { recursive: true })
  const fenced = snapshot.fence?.namespace === 1 && process.env.DEVPANEL_FENCE !== 'off'
  const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const fence = fenced ? { cwd, writable: [scratchDir], readOnly: readScope && ws.path ? [ws.path] : [], entries: [], panelRoot } : null

  const chatLedger = path.join(runDirectory, 'chat-adapters')
  // An earlier ask was interrupted after its fork touched the operator's CLI
  // configuration (harness/config-guard.mjs): the failure is recorded on the
  // question it belonged to, never on this one. Run by the adapter only once
  // this ask's fence is proved (afterFence): an unfenced ask (namespace 0,
  // fence off, an unproved fence's fallback) keeps today's behaviour and
  // touches nothing in the CLI home.
  // Run by the adapter inside applyFence, after the first proof and before the
  // home is prepared; the binds the ask launches with are built after it. A
  // throw is not swallowed: applyFence treats it as possibly having moved files.
  const replayGuard = typeof adapter.recoverPending !== 'function' ? null : async () => {
    for (const r of await adapter.recoverPending({ ledgerDir: chatLedger })) {
      if (!r.integrity?.violations?.length) continue
      const failed = await appendChat(issuePath, runId, { id: `a-${crypto.randomUUID()}`, kind: 'answer', replyTo: r.context?.questionId ?? null, at: new Date().toISOString(), role, model: spec.model.id ?? null, invocationId: r.invocationId, status: 'failed', text: null,
        error: `environment: the interrupted fork touched the operator's CLI configuration (${r.integrity.violations.map((v) => `${v.change} ${v.path}`).join('; ')})`, integrity: r.integrity, usage: null, costUsd: null })
      emit?.({ type: 'chat', entry: failed })
      await adapter.resolveConfig?.(r.invocationId, { ledgerDir: chatLedger }).catch(() => {})
    }
  }
  let seq = 0
  let liveWrite = Promise.resolve()
  const sizes = new Map()
  const forward = (kind, chunk) => {
    const live = { seq: ++seq, at: new Date().toISOString(), kind, text: String(chunk) }
    liveWrite = liveWrite.then(() => store.appendLive(issuePath, runId, invocationId, live, sizes))
      .then((written) => { if (written.entry) emit?.({ type: 'live', role, stepId: 'ask', invocationId, entry: written.entry, prev: written.prev }) })
      .catch(() => {})
  }
  const started = Date.now()
  let answer
  try {
    const deadline = AbortSignal.timeout(ASK_TIMEOUT_MS)
    const result = await adapter.invoke({
      session, fork: true,
      model: spec.model.wire, effort: spec.effort,
      cwd, scratchDir, supervisorOnly: true, tooling: null,
      hygiene: snapshot.fence?.hygiene === 1, fence, afterFence: fence ? replayGuard : null,
      cliHome: path.join(runDirectory, 'cli-homes', readScope ? `${role}-read` : role),
      profile: spec.model.profile, endpointRef: spec.model.endpointRef, credentialRef: spec.model.credentialRef, account: spec.model.account ?? null,
      ledgerDir: chatLedger,
      prompt: askPrompt({ question, actor: who, run }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      observe: { onOutput: (stream, chunk) => forward(stream, chunk) },
      meta: { invocationId, role: `${role}-ask`, runId, questionId: entry.id }
    })
    answer = { status: 'answered', text: String(result.response ?? '').trim(), usage: result.usage ?? null, costUsd: typeof result.usage?.costUsd === 'number' ? result.usage.costUsd : null }
  } catch (error) {
    const failure = classifyFailure(error)
    answer = { status: 'failed', text: null, error: `${failure.class}: ${failure.message}`.slice(0, 2000), usage: null, costUsd: null, ...(failure.integrity ? { integrity: failure.integrity } : {}) }
  }
  await liveWrite
  const reply = await appendChat(issuePath, runId, { id: `a-${crypto.randomUUID()}`, kind: 'answer', replyTo: entry.id, at: new Date().toISOString(), role, model: spec.model.id ?? null, effort: spec.effort ?? null, invocationId, forkedFrom: session.id, durationMs: Date.now() - started, ...answer })
  emit?.({ type: 'chat', entry: reply })
  if (answer.integrity) await adapter.resolveConfig?.(invocationId, { ledgerDir: chatLedger }).catch(() => {})
  return { question: entry, answer: reply }
}
