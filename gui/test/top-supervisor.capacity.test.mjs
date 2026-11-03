import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAdvisor } from '../server/decisions/advisor.mjs'
import { alwaysWakes } from '../server/decisions/wake-filter.mjs'
import { runDelta, summariseRun } from '../server/supervisor-summary.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { fakeOracle } from './fakes/decision-oracle.mjs'

export const name = 'top-level supervisor — the ready queue in its prompt, woken when capacity frees, runs as deltas'

const P = 'p'
const CONFIG = { id: 'jev', model: 'jev-latest', threshold: 0.9, hash: 'test', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 }, maxCallCostUsd: 0.01 }
const LIMITS = { maxCalls: 60, maxRuns: 5, maxConcurrent: 2, maxStartsPerIssue: 2 }
const temps = []
const wait = async (test, ms = 4000) => { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const polls = () => new Promise((r) => setTimeout(r, 150)) // several polls at pollMs 20
const issue = (id, over = {}) => ({ id, name: id, status: 'open', openedOn: '2026-01-01', ...over })
const record = (runId, issueId) => ({ runId, status: 'running', outcome: null, issue: { project: P, id: issueId }, playbook: { id: 'x' } })

/** A running supervisor over project p. `h.onCall` runs during a model call; `h.starting` names the issue a preview goes on to start. */
async function setup ({ rows = [], holders = {}, oracle = null, limits = LIMITS, maxDeferMs } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-capacity-'))
  temps.push(dir)
  const h = { dir, rows, holders, levels: {}, runs: {}, prompts: [], script: [], failures: [], onCall: null, starting: null, startRefusal: null, nextRun: 1 }
  const adapter = { invoke: async (args) => {
    if (h.failures.length) throw h.failures.shift()
    const prompt = JSON.parse(args.prompt)
    h.prompts.push(prompt)
    const during = h.onCall; h.onCall = null
    during?.(prompt)
    const action = prompt.event.result?.previewId ? { type: 'start_run', project: P, issueId: h.starting, previewId: prompt.event.result.previewId } : h.script.shift() ?? null
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
  } }
  const tools = {
    projects: async () => [{ id: P }], playbooks: async () => [], listIssues: async () => h.rows,
    readyQueueFacts: async () => ({ holders: h.holders, reportLevels: h.levels }),
    preview: async () => ({ ok: true, configHash: 'h' }),
    start: async (p) => {
      if (h.startRefusal) throw h.startRefusal
      const runId = `r${h.nextRun++}`
      h.runs[runId] = record(runId, p.issueId)
      h.holders[P] = { issueId: p.issueId, runId }
      h.rows.find((i) => i.id === p.issueId).latestRun = { runId, status: 'running', live: true }
      return { runId, status: 'running' }
    },
    getRun: async (_p, _i, runId) => {
      const read = summariseRun(structuredClone(h.runs[runId]))
      const after = h.afterRead; h.afterRead = null
      after?.()
      return read
    },
    stop: async (r) => { h.runs[r.runId].status = 'cancelled' }
  }
  h.agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'wire', defaultEffort: 'high', verification: { status: 'verified' } }], adapter, tools, pollMs: 20, emit: (e) => h.onSave?.(e),
    ...(maxDeferMs ? { maxDeferMs } : {}),
    ...(oracle ? { decisions: ({ spending }) => createAdvisor({ spending, loadProvider: async () => CONFIG, createOracle: () => oracle }) } : {}) })
  h.idle = () => { const s = h.agent.get(); return s.status === 'active' && !s.pending && !s.queue.length && !s.wake }
  h.begin = async (calls = 1) => { const n = h.prompts.length; await h.agent.start({ model: 'm', projects: [P], message: 'go', limits }); await wait(() => h.prompts.length >= n + calls && h.idle()) }
  // Start's chain: user -> preview -> start_run -> its result, ending with the run owned and watched.
  h.own = async (issueId) => {
    h.starting = issueId
    h.script.push({ type: 'preview', project: P, issueId, playbook: 'x' })
    await h.begin(3)
    await wait(() => h.agent.get().ownedRuns[0]?.observedProgress)
    return h.agent.get().ownedRuns[0].runId
  }
  h.settle = (runId, fields, issueId) => {
    Object.assign(h.runs[runId], fields)
    h.rows.find((i) => i.id === issueId).latestRun = { runId, status: fields.status, outcome: fields.outcome ?? null, live: false }
    delete h.holders[P]
  }
  h.capacityEvents = () => h.prompts.map((p) => p.event).filter((e) => e.type === 'capacity-freed' || e.capacityFreed)
  h.close = async () => { await h.agent.stop(); await h.agent.shutdown() }
  return h
}

export default async function (t) {
  t.section('ready-queue: the prompt carries the engine\'s reading, again only when it says something new')
  {
    const h = await setup({ rows: [issue('a'), issue('b', { dependsOn: { issues: [{ project: P, id: 'a' }] } })] })
    h.script.push({ type: 'list_issues', project: P }, { type: 'list_issues', project: P })
    await h.begin(3)
    const [first, second] = h.prompts
    t.eq('the first prompt has it whole, in dependency order', first.readyQueue.rows.map((r) => [r.id, r.state]), [['a', 'ready'], ['b', 'blocked']])
    t.eq('blocked by what, until what', first.readyQueue.rows[1].blockedBy[0].on, ['a'])
    t.eq('with no invented time', first.readyQueue.rows[1].blockedBy[0].until.at, null)
    t.eq('the next one has the same reading as unchanged', [second.readyQueue.unchanged, second.readyQueue.since], [true, first.readyQueue.generatedAt])
    t.eq('no baseline reaches the model', Object.keys(first.ownedRuns[0] ?? {}).filter((k) => k.startsWith('observed')), [])
    h.rows.push(issue('c'))
    await wait(() => h.prompts.length === 4 && h.idle())
    t.ok('a change is sent whole', h.prompts[3].readyQueue.rows?.some((r) => r.id === 'c'))
    await h.agent.stop()
    await h.begin(1)
    t.ok('a new activation is given it whole', Array.isArray(h.prompts[4].readyQueue.rows))
    await h.close()
  }

  t.section('ready-queue: a call that failed has not been told; an unreadable queue costs the reading, not the call')
  {
    const h = await setup({ rows: [issue('a')] })
    h.failures.push(Object.assign(new Error('no such binary'), { kind: 'spawn-error', started: false }))
    await h.agent.start({ model: 'm', projects: [P], message: 'go', limits: LIMITS })
    await wait(() => h.agent.get().status === 'stopped')
    t.eq('nothing is marked shown or observed', [h.agent.get().readyQueueShown, h.agent.get().queueObserved], [undefined, undefined])
    await h.close()

    const broken = await setup({ rows: [issue('a')] })
    Object.defineProperty(broken, 'holders', { get () { throw new Error('facts unreadable') } })
    await broken.begin(1)
    t.eq('the call is made, saying so', broken.prompts[0].readyQueue.unavailable, 'facts unreadable')
    await broken.close()
  }

  t.section('capacity-wake: an unowned run\'s lock releasing wakes it once, with the next issue')
  {
    const h = await setup({ rows: [issue('a', { openedOn: '2026-02-01' }), issue('b', { openedOn: '2026-01-01' })], holders: { [P]: { issueId: 'other', runId: 'rx' } } })
    await h.begin(1)
    t.eq('both wait for the project', h.prompts[0].readyQueue.rows.map((r) => r.blockedBy[0].kind), ['project-busy', 'project-busy'])
    await polls()
    t.eq('still held: no wake', h.prompts.length, 1)
    delete h.holders[P]
    await wait(() => h.prompts.length === 2 && h.idle())
    const event = h.prompts[1].event
    t.eq('it is woken', event.type, 'capacity-freed')
    t.eq('with the next ready issue', event.next.id, 'b')
    t.eq('saying what freed', event.freed, [{ project: P, reason: 'project-released', holder: { issueId: 'other', runId: 'rx' } }])
    t.eq('and the queue beside it', h.prompts[1].readyQueue.rows.map((r) => r.state), ['ready', 'ready'])
    await polls()
    t.eq('once per release', h.prompts.length, 2)
    h.holders[P] = { issueId: 'other', runId: 'ry' }
    await polls()
    delete h.holders[P]
    await wait(() => h.prompts.length === 3 && h.idle())
    t.eq('and again for the next release', h.prompts[2].event.type, 'capacity-freed')
    await h.close()
  }

  t.section('capacity-wake: a resolved ending the filter holds still frees capacity at once, unasked')
  {
    const oracle = fakeOracle([{ pick: { wake: 'defer' } }])
    const h = await setup({ rows: [issue('a'), issue('b', { openedOn: '2026-02-01' })], oracle })
    const runId = await h.own('a')
    const asked = oracle.calls.length
    h.settle(runId, { status: 'completed', outcome: 'resolved', phase: { id: 'closure', round: 0 }, checkHistory: [{ revision: 'sha256:c', result: 'passed', gating: 'passed', at: 'then' }] }, 'a')
    await wait(() => h.capacityEvents().length === 1 && h.idle())
    const event = h.prompts.at(-1).event
    t.eq('woken by capacity, with the next issue', [event.type, event.next.id], ['capacity-freed', 'b'])
    t.eq('the held ending rides along', event.deferred?.map((d) => [d.event.changed, d.event.run.status]), [[['status', 'phase', 'checks'], 'completed']])
    const carried = event.deferred?.[0].event.run
    t.eq('as the delta a wake would have carried', [carried?.phase, carried?.checks?.gating, 'blockedReason' in (carried ?? {}), carried?.from?.status], [{ id: 'closure', round: 0 }, 'passed', true, 'running'])
    t.eq('the provider was asked about the ending only', oracle.calls.slice(asked).map((c) => c.state.event.type), ['run-changed'])
    t.eq('the filter never holds this event', alwaysWakes({ type: 'capacity-freed' }), true)
    await h.close()
  }

  t.section('capacity-wake: an ending that wakes anyway carries it, for one call')
  {
    const h = await setup({ rows: [issue('a'), issue('b', { openedOn: '2026-02-01' })] })
    const runId = await h.own('a')
    const before = h.prompts.length
    h.settle(runId, { status: 'blocked', outcome: 'unresolved', blockedReason: 'closure-conditions-unmet' }, 'a')
    await wait(() => h.prompts.length > before && h.idle())
    await polls()
    t.eq('one call', h.prompts.length, before + 1)
    const event = h.prompts.at(-1).event
    t.eq('the ending, carrying the offer', [event.type, event.changed, event.capacityFreed?.next.id], ['run-changed', ['status', 'blockedReason'], 'b'])
    await h.close()
  }

  t.section('capacity-wake: a release seen before the ending waits one poll, so both arrive in one call; never longer')
  {
    const h = await setup({ rows: [issue('a'), issue('b', { openedOn: '2026-02-01' })] })
    const runId = await h.own('a')
    const before = h.prompts.length
    delete h.holders[P]
    await polls()
    t.eq('a run that stays live with its lock gone cannot hold the news for ever', h.capacityEvents().length, 1)
    t.eq('one call', h.prompts.length, before + 1)
    await wait(() => h.idle())

    // The run settles the moment a read of it has returned, so that read is stale, whichever poll or step made it. Only that
    // read: forcing an extra stale read after the settle could land after the one-poll hold-back was spent, which no poll does.
    const raced = await setup({ rows: [issue('a'), issue('b', { openedOn: '2026-02-01' })] })
    const racedRun = await raced.own('a')
    const racedBefore = raced.prompts.length
    raced.afterRead = () => raced.settle(racedRun, { status: 'blocked', outcome: 'unresolved' }, 'a')
    await wait(() => raced.prompts.length > racedBefore && raced.idle())
    await polls()
    t.eq('one call for the ending and the capacity', raced.prompts.length, racedBefore + 1)
    t.eq('the ending carries the offer', [raced.prompts.at(-1).event.type, raced.prompts.at(-1).event.capacityFreed?.next.id], ['run-changed', 'b'])
    await h.close()
    await raced.close()
  }

  t.section('measurement: a call Stop keeps from the adapter is released, so it is no call on the ledger')
  {
    const h = await setup({ rows: [issue('a')] })
    let stopping = null
    h.onSave = (e) => { if (e.operation === 'model' && !stopping) stopping = h.agent.stop() }
    await h.agent.start({ model: 'm', projects: [P], message: 'go', limits: LIMITS })
    await wait(() => stopping)
    await stopping
    const lines = (await fs.readFile(path.join(h.dir, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const reserved = lines.find((l) => l.kind === 'reserve' && l.subject === 'model-call')
    t.eq('the adapter was not reached', h.prompts.length, 0)
    t.eq('nor is it counted in the session', h.agent.get().calls, 0)
    t.eq('its reservation was released, not settled', lines.filter((l) => l.id === reserved?.id).map((l) => l.kind), ['reserve', 'release'])
    await h.close()
  }

  t.section('capacity-wake: no wake with nothing to offer, or what the model already saw')
  {
    const alone = await setup({ rows: [issue('a')] })
    const runId = await alone.own('a')
    alone.settle(runId, { status: 'completed', outcome: 'resolved' }, 'a')
    await wait(() => alone.prompts.at(-1).event.type === 'run-changed' && alone.idle())
    await polls()
    t.eq('an issue with an ended run is not next', alone.capacityEvents().length, 0)
    await alone.close()

    const spent = await setup({ rows: [issue('a'), issue('b', { openedOn: '2026-02-01' })], limits: { ...LIMITS, maxRuns: 1 } })
    const spentRun = await spent.own('a')
    spent.settle(spentRun, { status: 'completed', outcome: 'resolved' }, 'a')
    await wait(() => spent.prompts.at(-1).event.type === 'run-changed' && spent.idle())
    await polls()
    t.eq('no start left: nothing is offered', spent.capacityEvents().length, 0)
    t.eq('and the queue says why', spent.prompts.at(-1).readyQueue.because?.[0].kind, 'session-starts')
    await spent.close()

    const saw = await setup({ rows: [issue('a')], holders: { [P]: { issueId: 'other', runId: 'rx' } } })
    saw.script.push({ type: 'list_issues', project: P })
    saw.onCall = () => { delete saw.holders[P] }
    await saw.begin(2)
    t.eq('its next prompt told it', saw.prompts[1].readyQueue.rows[0].state, 'ready')
    await polls()
    t.eq('so nothing wakes it to say so again', saw.capacityEvents().length, 0)
    await saw.close()
  }

  t.section('capacity-wake: an eligible issue beyond the display limit still wakes it')
  {
    const rows = Array.from({ length: 31 }, (_, n) => issue(`trust-${n}`, { report: { trust: 'anonymous' } }))
    rows.push(issue('z', { openedOn: '2026-06-01' }))
    const h = await setup({ rows, holders: { [P]: { issueId: 'other', runId: 'rx' } } })
    for (const row of rows) if (row.report) h.levels[`${P}/${row.id}`] = 'none'
    await h.begin(1)
    t.ok('it is not among the rows shown', !h.prompts[0].readyQueue.rows.some((r) => r.id === 'z'))
    t.eq('the rest are counted', h.prompts[0].readyQueue.omitted, { blocked: 2 })
    delete h.holders[P]
    await wait(() => h.capacityEvents().length === 1 && h.idle())
    t.eq('it is the one offered', h.prompts.at(-1).event.next.id, 'z')
    await h.close()
  }

  t.section('capacity-wake: admission stays authoritative, and a refused re-run is offered when capacity frees')
  {
    const h = await setup({ rows: [issue('d', { latestRun: { runId: 'old', status: 'blocked', live: false } })] })
    h.startRefusal = Object.assign(new Error('a run is already active on this project (issue x); wait for it to finish'), { status: 409, started: false, retryable: true })
    h.starting = 'd'
    h.script.push({ type: 'preview', project: P, issueId: 'd', playbook: 'x' })
    await h.begin(3)
    t.ok('the queue said nothing was in the way; the start is refused all the same', /already active on this project/.test(h.prompts.at(-1).event.result?.error ?? ''), JSON.stringify(h.prompts.at(-1).event))
    h.holders[P] = { issueId: 'x', runId: 'rx' }
    await polls()
    delete h.holders[P]
    await wait(() => h.capacityEvents().length === 1 && h.idle())
    t.eq('the re-run it wanted is offered', h.prompts.at(-1).event.next.id, 'd')
    t.eq('once', h.agent.get().capacityRefused, {})
    await h.close()
  }

  t.section('run-deltas: small, and enough to act on')
  {
    const revision = `sha256:${'a'.repeat(64)}`
    const detail = {
      runId: 'r1', issue: { project: P, id: 'a' }, playbook: { id: 'x', title: 'y'.repeat(2000) }, status: 'paused', outcome: null, actions: ['answer', 'abandon'],
      phase: { id: 'implement-review', round: 1, stepId: 'audit' },
      timeline: Array.from({ length: 200 }, (_, n) => ({ number: String(n).padStart(3, '0'), stepId: 'audit', role: 'auditor-1', round: 1, findings: [{ id: `f${n}`, severity: 'minor', blocking: false }], usage: { tokens: 1000 } })),
      checkHistory: [{ revision, result: 'failed', gating: 'passed', tier: 'smoke', at: '2026-11-03T10:00:00.000Z', runs: [{ at: 'x', durationMs: 1 }] }],
      checkResults: [{ revision, result: 'failed', tier: 'smoke', commands: Array.from({ length: 30 }, (_, n) => ({ id: `c${n}`, stdout: 'x'.repeat(2000) })) }],
      pause: { id: 'pause-1', question: 'Grant one more round?', options: ['continue', 'stop'], kind: 'rounds-exhausted', askedBy: { phase: 'p' } },
      reconciliations: [{ n: 1, state: 'conflicts', by: 'engine', endedAt: '2026-11-03T10:00:00.000Z', conflicts: ['x.js'], error: 'conflicts in x.js', checks: { result: 'failed', dir: '004', gating: 'failed', reason: 'a gate', commands: Array.from({ length: 30 }, (_, n) => ({ id: `c${n}`, stdout: 'x'.repeat(2000) })) } }],
      failure: { class: 'runtime', message: 'm'.repeat(5000) }, budgets: { used: { tokens: 1 } }, metrics: { rounds: 'r'.repeat(3000) }, workspace: { path: 'w'.repeat(2000) },
      modelSubstitutions: [{ role: 'implementer', from: 'a', to: 'b' }]
    }
    const full = summariseRun(detail)
    const delta = runDelta(full, { from: { status: 'running' } })
    t.ok('far smaller than the run', JSON.stringify(delta).length < 4096, String(JSON.stringify(delta).length))
    t.ok('the whole run was not small', JSON.stringify(full).length > 40000, String(JSON.stringify(full).length))
    t.eq('none of the detail', [delta.steps, delta.metrics, delta.budgets, delta.workspace, delta.diagnostics], [undefined, undefined, undefined, undefined, undefined])
    t.eq('status, phase and from', [delta.status, delta.phase, delta.from], ['paused', { id: 'implement-review', round: 1 }, { status: 'running' }])
    t.eq('the checks verdict is the gate\'s', delta.checks, { revision: revision.slice(0, 23), result: 'failed', gating: 'passed', tier: 'smoke', at: '2026-11-03T10:00:00.000Z' })
    t.eq('what answer_run copies', [delta.pause.id, delta.pause.options], ['pause-1', ['continue', 'stop']])
    t.eq('the reconcile and where its log is', [delta.reconciliation.state, delta.reconciliation.conflicts, delta.reconciliation.checks.dir], ['conflicts', ['x.js'], '004'])
    t.eq('and what it may do next', delta.actions, ['answer', 'abandon'])
    const bare = runDelta(summariseRun({ runId: 'r2', issue: { project: P, id: 'b' }, status: 'running', checkResults: [{ revision, result: 'passed', at: 'then' }] }))
    t.eq('a record with no drive history gives its bare result', [bare.checks.result, bare.checks.gating], ['passed', null])
    t.eq('a quiet run carries none of the optional fields', [bare.pause, bare.failure, bare.reconciliation, bare.landed, bare.from], [undefined, undefined, undefined, undefined, undefined])
    t.ok('and blockedReason is always said', 'blockedReason' in bare)
  }

  t.section('run-deltas: a live run\'s progress makes no call, asks no provider, starts no timer, and rides with the next wake')
  {
    const oracle = fakeOracle([])
    const h = await setup({ rows: [issue('a')], oracle, maxDeferMs: 50 })
    const runId = await h.own('a')
    const calls = h.prompts.length, asked = oracle.calls.length
    const held = () => (h.agent.get().deferred ?? []).filter((d) => d.progress)
    h.runs[runId].phase = { id: 'plan-review', round: 0 }
    await wait(() => held().length === 1)
    h.runs[runId].phase = { id: 'plan-review', round: 1 }
    await wait(() => held()[0]?.changes === 2)
    h.runs[runId].checkHistory = [{ revision: 'sha256:b', result: 'failed', gating: 'failed', at: 'then' }]
    await wait(() => held()[0]?.changes === 3)
    h.runs[runId].status = 'stopping'
    await wait(() => held()[0]?.changes === 4)
    await polls()
    t.eq('no call, past the deferred limit', h.prompts.length, calls)
    t.eq('no provider asked', oracle.calls.length, asked)
    t.eq('one entry for the run', held().length, 1)
    h.runs[runId].status = 'running'
    await wait(() => held()[0]?.changes === 5)
    await h.agent.chat('anything new?')
    await wait(() => h.prompts.length === calls + 1 && h.idle())
    const [entry] = h.prompts.at(-1).event.deferred.filter((d) => d.progress)
    t.eq('it names all that moved', entry.event.changed.sort(), ['checks', 'phase', 'status'])
    t.eq('the newest reading', [entry.event.run.phase, entry.event.run.checks.gating, entry.event.run.status], [{ id: 'plan-review', round: 1 }, 'failed', 'running'])
    t.eq('with what each first was', entry.event.run.from, { status: 'running', checks: null, phase: null })
    t.eq('delivered, it is no longer held', held().length, 0)

    h.runs[runId].phase = { id: 'implement-review', round: 0 }
    await wait(() => held().length === 1)
    h.runs[runId].status = 'failed'; h.runs[runId].failure = { class: 'runtime', message: 'boom' }; delete h.holders[P]
    await wait(() => h.prompts.at(-1).event.type === 'run-changed' && h.idle())
    const ended = h.prompts.at(-1).event
    t.eq('an ending wakes, as a delta', [ended.changed, ended.run.status, ended.run.failure.class, ended.run.steps], [['status'], 'failed', 'runtime', undefined])
    t.eq('its progress entry is outdated, not carried', ended.deferred, undefined)
    await h.close()
  }

  t.section('run-deltas: only delivery keys always wake')
  {
    t.eq('phase and checks alone do not', alwaysWakes({ type: 'run-changed', changed: ['phase', 'checks'], run: { status: 'running' } }), false)
    t.eq('nor a blocked reason on a live run', alwaysWakes({ type: 'run-changed', changed: ['blockedReason'], run: { status: 'running' } }), false)
    t.eq('a delivery key does', alwaysWakes({ type: 'run-changed', changed: ['phase', 'delivery'], run: { status: 'running' } }), true)
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
}
