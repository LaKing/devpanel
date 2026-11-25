import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAdvisor } from '../server/decisions/advisor.mjs'
import { alwaysWakes } from '../server/decisions/wake-filter.mjs'
import { summariseRun } from '../server/supervisor-summary.mjs'
import { emptyHistory } from '../server/supervisor-starts.mjs'
import { writeAtomic } from '../server/runtime/persistence.mjs'
import { fakeOracle } from './fakes/decision-oracle.mjs'

export const name = 'top-level supervisor — a review loop that does not converge wakes it, once per run, loop and threshold'

const wait = async (test, ms = 4000) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const polls = () => new Promise((r) => setTimeout(r, 150)) // several polls at pollMs 20
const LIMITS = { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 }
const CONFIG = { id: 'jev', model: 'jev-latest', threshold: 0.9, hash: 'test', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 }, maxCallCostUsd: 0.01 }
const POLICY = (perWakeCalls) => ({ version: 1, daily: { usd: 100, starts: 10, unpricedRuns: 10, unpricedCalls: 100 }, monthly: { usd: 1000, starts: 100, unpricedRuns: 100, unpricedCalls: 1000 }, concurrent: 3, perWakeCalls })

/** Recorded rounds as the engine keeps them (engine.mjs appendReviewRounds): `verdicts` true = approved. */
function rounds (verdicts, { phase = 'plan-review', blocking = (i) => [{ id: `auditor-1-f${i}`, seat: 'auditor-1', severity: 'major', location: `gui/server/x${i}.mjs:${i}` }] } = {}) {
  let rejected = 0
  return verdicts.map((approved, i) => ({
    key: `-1:${phase}:${i}`, window: -1, phase, round: i, reviewed: null, approved, verdict: approved ? 'approved' : 'changes-needed',
    seats: [{ role: 'auditor-1', verdict: approved ? 'approved' : 'changes-needed' }], blocking: approved ? [] : blocking(i),
    ordinal: i + 1, ...(approved ? {} : { nonApproving: ++rejected }), decidedAt: '2026-11-25T00:00:00.000Z'
  }))
}
const rejected = (n, options) => rounds(Array(n).fill(false), options)

/**
 * A supervisor that owns run r1 of p/a from the start (as start_run leaves it), reading it through the real summary.
 * `gate`: a promise the adapter awaits before answering a review-rounds call; `mismatch`: answer the next one from another session.
 */
async function owning ({ dir = null, status = 'running', decisions = null, wakes = [3], policy = null, maxDeferMs, holdWrites = false, keepDir = false } = {}) {
  const created = !dir
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-review-rounds-'))
  if (policy) await fs.writeFile(path.join(dir, 'spending-policy.json'), JSON.stringify(policy))
  if (created) {
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ status: 'stopped', session: null, model: null, queue: [], previews: {}, calls: 0, starts: 0, costUsd: 0, unknownCostCalls: 0, history: emptyHistory(),
      ownedRuns: [{ project: 'p', issueId: 'a', runId: 'r1', status, observedStatus: status, reviewWakes: {} }] }))
  }
  const h = { dir, invocations: [], warnings: [], record: { runId: 'r1', status, outcome: null, issue: { project: 'p', id: 'a' }, reviewRounds: [] }, gate: null, mismatch: false, readFault: null, wakes, held: null }
  const adapter = { invoke: async (args) => {
    const event = JSON.parse(args.prompt).event
    h.invocations.push({ args, event })
    if (event.type === 'review-rounds' && h.gate) await h.gate
    const other = event.type === 'review-rounds' && h.mismatch
    if (other) h.mismatch = false
    return { session: other ? { id: 'other' } : args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } }
  } }
  const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
    listIssues: async () => { if (h.listGate) { h.listBlocked = true; await h.listGate; h.listBlocked = false } return [{ id: 'a' }] }, getIssue: async () => ({ name: 'x' }),
    // `gateNext`: the next read only waits for it and answers with `gatedRounds` (a lookup held in flight).
    getRun: async (_project, _issueId, runId) => {
      if (h.readFault) throw h.readFault
      // `gateSkip`: that many reads pass before the gated one.
      if (h.gateNext && h.gateSkip > 0) h.gateSkip--
      else if (h.gateNext) { const gate = h.gateNext; h.gateNext = null; await gate; return summariseRun({ ...structuredClone(h.record), reviewRounds: h.gatedRounds }) }
      // `records`: one record per run id, for a supervisor owning more than r1.
      return summariseRun(structuredClone(h.records?.[runId] ?? h.record))
    },
    stop: async (r) => { (h.records?.[r?.runId] ?? h.record).status = 'cancelled' }, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
  // Held: the first write that holds a review-rounds event, as long as `h.held` is set.
  const writeState = async (file, bytes) => { if (holdWrites && h.held && bytes.includes('review-rounds:r1')) await h.held; await writeAtomic(file, bytes) }
  // Failed-call retries in milliseconds, as top-supervisor.context.test.mjs does: the module reads it at load.
  process.env.DEVPANEL_SUPERVISOR_RETRY_MS = '5'
  const { createTopSupervisor } = await import(`../server/top-supervisor.mjs?review-rounds=${Date.now()}-${Math.random()}`)
  delete process.env.DEVPANEL_SUPERVISOR_RETRY_MS
  h.agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'wire', defaultEffort: 'high', verification: { status: 'verified' } }], adapter, tools, pollMs: 20, decisions,
    reviewRoundWakes: () => h.wakes, writeState, ...(maxDeferMs ? { maxDeferMs } : {}) })
  h.start = () => h.agent.start({ model: 'm', projects: ['p'], message: 'go', limits: LIMITS })
  h.owned = () => h.agent.get().ownedRuns.find((r) => r.runId === 'r1')
  h.idle = () => { const s = h.agent.get(); return s.status === 'active' && !s.pending && !s.queue.length }
  h.sent = (filter = () => true) => h.invocations.map((i) => i.event).filter((e) => e.type === 'review-rounds' && filter(e))
  h.carrying = (eventId) => h.invocations.filter((i) => i.event.eventId === eventId || (i.event.deferred ?? []).some((d) => d.event?.eventId === eventId))
  h.close = async () => { await h.agent.stop().catch(() => {}); await h.agent.shutdown?.(); if (!keepDir) await fs.rm(dir, { recursive: true, force: true }) }
  return h
}

export default async function (t) {
  const realWarn = console.warn
  const warnings = []
  console.warn = (...args) => { if (String(args[0]).startsWith('review-rounds') || String(args[0]).startsWith('deferred-events')) warnings.push(args); else realWarn(...args) }
  try {
    t.section('the default threshold: nothing before the third non-approving round, one event at it while the run is live, never again')
    {
      const h = await owning()
      await h.start()
      await wait(h.idle)
      h.record.reviewRounds = rejected(2)
      await polls()
      t.eq('two non-approving rounds wake nobody', h.sent().length, 0)
      h.record.reviewRounds = rejected(3)
      await wait(() => h.sent().length === 1 && h.idle())
      const event = h.sent()[0]
      t.eq('the third does, while the run is still running', [event.threshold, event.run.status], [3, 'running'])
      t.eq('naming the run, issue, loop and round', [event.runId, event.project, event.issueId, event.phase, event.round, event.nonApproving], ['r1', 'p', 'a', 'plan-review', 2, 3])
      t.eq('its record says delivered', h.owned().reviewWakes['plan-review'][3].state, 'delivered')
      await polls()
      h.record.reviewRounds = rejected(4)
      await polls()
      t.eq('more polls and a fourth round: still one', h.sent().length, 1)
      await h.close()
    }

    t.section('the event carries every round so far with each blocking finding\'s id and full location')
    {
      const long = `gui/test/fixtures/${'deep/'.repeat(55)}fixture.mjs:7`
      const many = (i) => i === 1
        ? Array.from({ length: 40 }, (_, k) => ({ id: `auditor-1-many-${k}`, seat: 'auditor-1', severity: 'major', location: `gui/server/m${k}.mjs:${k}` }))
        : [{ id: `auditor-1-f${i}`, seat: 'auditor-1', severity: 'major', location: i === 2 ? long : 'plan: step 3', ...(i === 0 ? { deferred: true, source: 'plan-review' } : {}) }]
      const h = await owning()
      await h.start()
      await wait(h.idle)
      h.record.reviewRounds = rejected(3, { blocking: many })
      await wait(() => h.sent().length === 1 && h.idle())
      const event = h.sent()[0]
      t.eq('three rounds, in order', event.rounds.map((r) => r.round), [0, 1, 2])
      t.eq('all forty blocking findings of round 2, ids and locations whole', event.rounds[1].blocking.map((b) => `${b.id}@${b.location}`), many(1).map((b) => `${b.id}@${b.location}`))
      t.eq('a 300-character location unclipped', event.rounds[2].blocking[0].location, long)
      t.ok('long enough to matter', long.length > 290)
      t.eq('plan text, and a deferred plan finding marked as such', [event.rounds[0].blocking[0].location, event.rounds[0].blocking[0].deferred, event.rounds[0].blocking[0].source], ['plan: step 3', true, 'plan-review'])
      t.eq('each round says how its seats judged it', event.rounds[0].seats, [{ role: 'auditor-1', verdict: 'changes-needed' }])
      await h.close()
    }

    t.section('further thresholds: each fires once, naming the round that crossed it, even when found in one poll')
    {
      const h = await owning({ wakes: [3, 6] })
      await h.start()
      await wait(h.idle)
      h.record.reviewRounds = rejected(2)
      await polls()
      h.record.reviewRounds = rejected(6)
      await wait(() => h.sent().length === 2 && h.idle())
      t.eq('two events, thresholds 3 and 6', h.sent().map((e) => [e.threshold, e.round, e.rounds.length]), [[3, 2, 3], [6, 5, 6]])
      await polls()
      t.eq('and no more', h.sent().length, 2)
      await h.close()
    }

    t.section('past the wake filter: a provider that would hold everything is not asked')
    {
      t.eq('review-rounds always wakes', alwaysWakes({ type: 'review-rounds' }), true)
      const oracle = fakeOracle(Array(20).fill({ pick: { wake: 'defer' } }))
      const h = await owning({ decisions: ({ spending }) => createAdvisor({ spending, loadProvider: async () => CONFIG, createOracle: () => oracle }) })
      await h.start()
      await wait(h.idle)
      h.record.reviewRounds = rejected(3)
      await wait(() => h.sent().length === 1 && h.idle())
      t.eq('it woke the supervisor', h.sent().length, 1)
      t.eq('the provider was never asked about it', oracle.calls.filter((c) => c.state?.event?.type === 'review-rounds').length, 0)
      await h.close()
    }

    t.section('its wake counts in perWakeCalls like any other, and the event makes no call of its own')
    {
      const h = await owning({ policy: POLICY(2) })
      await h.start()
      await wait(h.idle)
      const before = h.invocations.length
      h.record.reviewRounds = rejected(3)
      await wait(() => h.sent().length === 1 && h.idle())
      t.eq('exactly one model call followed the event', h.invocations.length - before, 1)
      const lines = (await fs.readFile(path.join(h.dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
      const wake = lines.findLast((l) => l.kind === 'wake')
      t.eq('a wake opened for it', wake.reason, 'review-rounds')
      t.eq('and that wake counted its one call', lines.filter((l) => l.kind === 'reserve' && l.meta?.wake === wake.id).length, 1)
      await h.close()
    }

    t.section('admission: answered only once the state write holding the event is durable, whichever path inserted it')
    {
      const h = await owning({ holdWrites: true })
      await h.start()
      await wait(h.idle)
      t.eq('a run not owned is not admitted', (await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'other' })).state, 'not-owned')
      let release
      h.held = new Promise((r) => { release = r })
      h.record.reviewRounds = rejected(3)
      // The poll finds the crossing first and inserts it; its write is held.
      await wait(() => h.owned()?.reviewWakes?.['plan-review']?.[3])
      let answered = null
      const admission = h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1', rows: [h.record.reviewRounds[2]] }).then((a) => { answered = a })
      await new Promise((r) => setTimeout(r, 100))
      t.eq('admission waits for the poll\'s write', answered, null)
      release(); h.held = null
      await admission
      t.eq('then answers admitted, naming the threshold', [answered.state, answered.thresholds], ['admitted', [3]])
      const onDisk = JSON.parse(await fs.readFile(path.join(h.dir, 'state.json'), 'utf8'))
      const record = onDisk.ownedRuns[0].reviewWakes['plan-review'][3]
      t.ok('state.json holds it, queued or claimed', ['queued', 'sent', 'delivered'].includes(record.state) && (record.state !== 'queued' || onDisk.queue.some((e) => e.eventId === record.eventId)))
      await wait(() => h.sent().length === 1 && h.idle())
      t.eq('delivered once', h.sent().length, 1)
      await h.agent.stop()
      t.eq('a stopped supervisor admits nothing', (await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })).state, 'inactive')
      await h.close()
    }

    t.section('an event admitted while Start is still reading waits for the activation, then goes once')
    {
      const h = await owning()
      let release
      h.listGate = new Promise((r) => { release = r })
      h.record.reviewRounds = rejected(3)
      const starting = h.start()
      await wait(() => h.agent.get().status === 'active')
      const answered = await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })
      t.eq('admitted during Start', answered.state, 'admitted')
      t.eq('no call yet: the activation is not ready', h.invocations.length, 0)
      release(); h.listGate = null
      await starting
      await wait(() => h.sent().length === 1 && h.idle())
      await polls()
      t.eq('then exactly one review-rounds call', h.sent().length, 1)
      await h.close()
    }

    t.section('a panel restart sends nothing again; a claim no reply answers is sent once more (at-least-once)')
    {
      const h = await owning({ keepDir: true })
      await h.start()
      await wait(h.idle)
      h.record.reviewRounds = rejected(3)
      await wait(() => h.sent().length === 1 && h.idle())
      const first = h.sent()[0]
      await h.close()
      const file = path.join(h.dir, 'state.json')

      const again = await owning({ dir: h.dir, keepDir: true })
      again.record.reviewRounds = rejected(3)
      await again.start()
      await wait(again.idle)
      await polls()
      t.eq('after a restart the delivered threshold is not sent again', again.sent().length, 0)
      await again.close()

      // A crash after the claim whose reply did reach the chat: delivered, nothing resent.
      const saved = JSON.parse(await fs.readFile(file, 'utf8'))
      const rec = saved.ownedRuns[0].reviewWakes['plan-review'][3]
      Object.assign(rec, { state: 'sent' })
      await fs.writeFile(file, JSON.stringify({ ...saved, status: 'active' }))
      const replied = await owning({ dir: h.dir, keepDir: true })
      replied.record.reviewRounds = rejected(3)
      t.eq('a claim whose reply is in the chat reads as delivered', replied.owned().reviewWakes['plan-review'][3].state, 'delivered')
      await replied.start()
      await wait(replied.idle)
      await polls()
      t.eq('and is not sent again', replied.sent().length, 0)
      await replied.close()

      // A crash after the claim, before its reply reached the chat: sent once more, the same event.
      const lost = JSON.parse(await fs.readFile(file, 'utf8'))
      Object.assign(lost.ownedRuns[0].reviewWakes['plan-review'][3], { state: 'sent', invocationId: 'a-call-whose-reply-never-arrived' })
      await fs.writeFile(file, JSON.stringify({ ...lost, status: 'active' }))
      const resent = await owning({ dir: h.dir })
      resent.record.reviewRounds = rejected(3)
      await resent.start()
      await wait(() => resent.sent().length === 1 && resent.idle())
      await polls()
      t.eq('sent exactly once more', resent.sent().length, 1)
      t.eq('as the same event, admitted once', [resent.sent()[0].eventId, resent.sent()[0].admittedAt], [first.eventId, first.admittedAt])
      await resent.close()
    }

    t.section('a reply discarded for a session mismatch: the event is sent once more, and delivered once')
    {
      const h = await owning()
      await h.start()
      await wait(h.idle)
      h.mismatch = true
      h.record.reviewRounds = rejected(3)
      await wait(() => h.owned()?.reviewWakes?.['plan-review']?.[3]?.state === 'delivered' && h.idle())
      await polls()
      const eventId = 'review-rounds:r1:plan-review:3'
      t.eq('two calls carried it: the discarded one and its retry', h.carrying(eventId).length, 2)
      t.eq('one reply was discarded', h.agent.get().messages.filter((m) => m.discarded === 'session-mismatch').length, 1)
      await h.close()
    }

    t.section('an event whose run record is gone is dropped, queued or deferred, with no call for it')
    {
      warnings.length = 0
      const h = await owning({ wakes: [3, 6] })
      await h.start()
      await wait(h.idle)
      let release
      h.gate = new Promise((r) => { release = r })
      h.record.reviewRounds = rejected(3)
      await wait(() => h.sent().length === 1)
      // While threshold 3 is in flight, threshold 6 is admitted and waits; then the run is deleted.
      h.record.reviewRounds = rejected(6)
      t.eq('threshold 6 admitted behind it', (await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })).state, 'admitted')
      h.readFault = Object.assign(new Error('no such run'), { status: 404 })
      release(); h.gate = null
      await wait(() => !h.agent.get().queue.length && h.agent.get().status === 'active' && h.idle())
      t.eq('no call carried threshold 6', h.carrying('review-rounds:r1:plan-review:6').length, 0)
      t.eq('one warning named it', warnings.filter((w) => w[1]?.dropped?.some((d) => d.threshold === 6)).length, 1)
      await h.close()

      // Deferred by a perWakeCalls refusal, its run then gone: the timed wake that would carry only it is skipped.
      warnings.length = 0
      const d = await owning({ wakes: [3, 6], status: 'paused', policy: POLICY(1), maxDeferMs: 200 })
      await d.start()
      await wait(d.idle)
      const before = d.invocations.length
      d.record.reviewRounds = rejected(6)
      await wait(() => (d.agent.get().deferred ?? []).some((x) => x.event?.threshold === 6) && d.agent.get().wake === null && d.agent.get().status === 'active')
      t.eq('threshold 3 went, threshold 6 was refused into the deferred list', d.sent().map((e) => e.threshold), [3])
      d.readFault = Object.assign(new Error('no such run'), { status: 404 })
      await wait(() => !d.owned())
      await wait(() => !(d.agent.get().deferred ?? []).length, 3000)
      await polls()
      t.eq('no call at all for the skipped wake', d.invocations.length - before, 1)
      t.eq('exactly one warning', warnings.length, 1)
      await d.close()
    }

    t.section('an admission still reading its run when the supervisor shuts down changes nothing, before or after a replacement starts')
    {
      const h = await owning({ keepDir: true })
      await h.start()
      await wait(h.idle)
      let release
      h.gateNext = new Promise((r) => { release = r })
      h.gatedRounds = rejected(3)
      const admission = h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })
      const shutdown = h.agent.shutdown()
      await new Promise((r) => setTimeout(r, 100))
      let shutDown = false
      shutdown.then(() => { shutDown = true })
      await new Promise((r) => setTimeout(r, 50))
      t.eq('shutdown waits for the admission in flight before it lets the owner go', shutDown, false)
      release()
      t.eq('the admission, its read answered after shutdown began, admits nothing', (await admission).state, 'inactive')
      await shutdown
      const file = path.join(h.dir, 'state.json')
      const old = JSON.parse(await fs.readFile(file, 'utf8'))
      t.eq('nothing was recorded or queued for it', [old.ownedRuns[0].reviewWakes, old.queue.filter((e) => e.type === 'review-rounds').length], [{}, 0])
      const replacement = await owning({ dir: h.dir })
      await replacement.agent.start({ model: 'm', projects: ['p'], message: 'replacement', limits: LIMITS })
      await wait(replacement.idle)
      await polls()
      const after = JSON.parse(await fs.readFile(file, 'utf8'))
      t.eq('the replacement\'s state stays its own', [after.mission, after.ownedRuns[0].reviewWakes], ['replacement', {}])
      await replacement.close()
    }

    t.section('an admission whose write lands after shutdown began starts no model call; the event stays queued for the next Start')
    {
      const h = await owning({ holdWrites: true, keepDir: true })
      await h.start()
      await wait(h.idle)
      const before = h.invocations.length
      // A poll held in its issue listing keeps shutdown waiting behind the serial chain.
      let releaseList, releaseWrite
      h.listGate = new Promise((r) => { releaseList = r })
      await wait(() => h.listBlocked)
      // The admission reads its run before shutdown and inserts the event; the write holding it is held.
      h.held = new Promise((r) => { releaseWrite = r })
      h.record.reviewRounds = rejected(3)
      const admission = h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })
      await wait(() => h.owned()?.reviewWakes?.['plan-review']?.[3])
      const shutdown = h.agent.shutdown()
      releaseWrite(); h.held = null
      t.eq('the admission, its write durable, answers admitted', (await admission).state, 'admitted')
      await new Promise((r) => setTimeout(r, 100))
      const file = path.join(h.dir, 'state.json')
      const during = JSON.parse(await fs.readFile(file, 'utf8'))
      t.eq('no model call while shutdown is pending', h.invocations.length - before, 0)
      t.eq('and no pending-call write', during.pending ?? null, null)
      releaseList(); h.listGate = null
      await shutdown
      const after = JSON.parse(await fs.readFile(file, 'utf8'))
      t.eq('none after shutdown either', h.invocations.length - before, 0)
      t.eq('the event is still queued on disk, for the next Start', [after.ownedRuns[0].reviewWakes['plan-review'][3].state, after.queue.filter((e) => e.type === 'review-rounds').length], ['queued', 1])
      await fs.rm(h.dir, { recursive: true, force: true })
    }

    t.section('a drive that claimed the event before shutdown makes no call once shutdown began; the event stays redeliverable')
    {
      const h = await owning({ keepDir: true })
      await h.start()
      await wait(h.idle)
      const before = h.invocations.length
      // A poll held in its issue listing keeps shutdown waiting behind the serial chain.
      let releaseList, releaseRead
      h.listGate = new Promise((r) => { releaseList = r })
      await wait(() => h.listBlocked)
      h.record.reviewRounds = rejected(3)
      // The admission's own read passes; the drive's run lookup after its claim is held.
      h.gateNext = new Promise((r) => { releaseRead = r }); h.gateSkip = 1; h.gatedRounds = rejected(3)
      t.eq('admitted', (await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })).state, 'admitted')
      await wait(() => h.owned()?.reviewWakes?.['plan-review']?.[3]?.state === 'sent' && !h.gateNext)
      const shutdown = h.agent.shutdown()
      releaseRead()
      await new Promise((r) => setTimeout(r, 100))
      t.eq('no model call while shutdown is pending', h.invocations.length - before, 0)
      releaseList(); h.listGate = null
      await shutdown
      const after = JSON.parse(await fs.readFile(path.join(h.dir, 'state.json'), 'utf8'))
      t.eq('none after shutdown either', h.invocations.length - before, 0)
      t.eq('the record is queued again and its event back in the queue', [after.ownedRuns[0].reviewWakes['plan-review'][3].state, after.queue.filter((e) => e.type === 'review-rounds').length, after.pending ?? null], ['queued', 1, null])
      const next = await owning({ dir: h.dir, keepDir: true })
      await next.start()
      await wait(() => next.sent().length === 1 && next.idle())
      t.eq('the next Start sends it once', next.sent().map((e) => e.threshold), [3])
      await next.close()
      await fs.rm(h.dir, { recursive: true, force: true })
    }

    t.section('a phase id that names an inherited member (constructor, __proto__, toString) keys each run\'s own record')
    for (const phase of ['constructor', '__proto__', 'toString']) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-review-rounds-'))
      const owned = (runId, issueId) => ({ project: 'p', issueId, runId, status: 'running', observedStatus: 'running', reviewWakes: {} })
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ status: 'stopped', session: null, model: null, queue: [], previews: {}, calls: 0, starts: 0, costUsd: 0, unknownCostCalls: 0, history: emptyHistory(),
        ownedRuns: [owned('r1', 'a'), owned('r2', 'b')] }))
      const h = await owning({ dir, wakes: [1], keepDir: true })
      const record = (runId, issueId) => ({ runId, status: 'running', outcome: null, issue: { project: 'p', id: issueId }, reviewRounds: rejected(1, { phase }) })
      h.records = { r1: record('r1', 'a'), r2: record('r2', 'b') }
      await h.start()
      await wait(h.idle)
      const answers = [await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' }), await h.agent.admitReviewRounds({ project: 'p', issueId: 'b', runId: 'r2' })]
      t.ok(`${phase}: both admissions answer admitted or find their event already admitted`, answers.every((a) => ['admitted', 'nothing-due'].includes(a.state)))
      await wait(() => h.sent().length >= 2 && h.idle())
      await polls()
      t.eq(`${phase}: each run's event reached the adapter once`, h.sent().map((e) => e.runId).sort(), ['r1', 'r2'])
      t.eq(`${phase}: naming its phase`, [...new Set(h.sent().map((e) => e.phase))], [phase])
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
      t.eq(`${phase}: each run persists its own record`, onDisk.ownedRuns.map((r) => [r.runId, Object.hasOwn(r.reviewWakes, phase) && Object.hasOwn(r.reviewWakes[phase], '1') ? r.reviewWakes[phase]['1'].state : null]), [['r1', 'delivered'], ['r2', 'delivered']])
      t.eq(`${phase}: nothing was written onto Object.prototype or Object`, [Object.hasOwn(Object.prototype, 1), Object.hasOwn(Object, 1), Object.getPrototypeOf({}) === Object.prototype], [false, false, true])
      await h.close()
      await fs.rm(dir, { recursive: true, force: true })
    }

    t.section('a timed deferred wake whose entries a call already carried makes no call of its own (perWakeCalls 2)')
    {
      const h = await owning({ wakes: [2, 3, 4, 5], policy: POLICY(2), maxDeferMs: 600 })
      await h.start()
      await wait(h.idle)
      h.record.reviewRounds = rejected(4)
      // Thresholds 2 and 3 use the wake's two calls; 4 is refused into the deferred list.
      await wait(() => h.sent().length === 2 && (h.agent.get().deferred ?? []).some((d) => d.event?.threshold === 4) && h.agent.get().wake === null && h.agent.get().status === 'active')
      // A poll is held in its issue listing; meanwhile a direct admission starts a call that carries threshold 4.
      let releaseList, releaseCall
      h.listGate = new Promise((r) => { releaseList = r })
      await wait(() => h.listBlocked)
      h.gate = new Promise((r) => { releaseCall = r })
      h.record.reviewRounds = rejected(5)
      t.eq('threshold 5 admitted', (await h.agent.admitReviewRounds({ project: 'p', issueId: 'a', runId: 'r1' })).state, 'admitted')
      // Claimed by its call (whose prompt preparation also waits on the listing), threshold 4 riding with it.
      await wait(() => h.owned()?.reviewWakes?.['plan-review']?.[5]?.state === 'sent')
      // Long enough for the held entry to be due when the poll reaches its timer.
      await new Promise((r) => setTimeout(r, 700))
      // The held poll goes on while that call is in flight, and queues a timed wake for the entry it carries.
      releaseList(); h.listGate = null
      await wait(() => h.agent.get().queue.some((e) => e.type === 'deferred-events'))
      releaseCall(); h.gate = null
      await wait(() => h.idle() && !(h.agent.get().deferred ?? []).length)
      await polls()
      t.ok('threshold 4 rode with the call for threshold 5', h.invocations.some((i) => i.event.threshold === 5 && (i.event.deferred ?? []).some((d) => d.event?.threshold === 4)))
      t.eq('and no deferred-events call followed with nothing to carry', h.invocations.filter((i) => i.event.type === 'deferred-events').length, 0)
      await h.close()
    }
  } finally {
    console.warn = realWarn
  }
}
