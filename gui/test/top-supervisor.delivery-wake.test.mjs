import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAdvisor } from '../server/decisions/advisor.mjs'
import { alwaysWakes, summariseEvent } from '../server/decisions/wake-filter.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { deliveryReading, summarisePackedRun, summariseRun } from '../server/supervisor-summary.mjs'
import { fakeOracle } from './fakes/decision-oracle.mjs'

export const name = 'top-level supervisor — a run\'s delivery changing wakes it, once'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const polls = () => new Promise((r) => setTimeout(r, 150)) // several polls at pollMs 20
const LIMITS = { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 }
const CONFIG = { id: 'jev', model: 'jev-latest', threshold: 0.9, hash: 'test', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 }, maxCallCostUsd: 0.01 }

/**
 * A supervisor that owns one run, read through the real summaries: `record` is the run as persisted,
 * and `packed` switches the reading to the bundle's, as top-supervisor-service.mjs does.
 */
async function owning ({ decisions = null, dir = null, adopt = false, record: given = null } = {}) {
  dir ??= await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-delivery-wake-'))
  const invocations = [], script = [], calls = []
  const h = { dir, invocations, script, calls, packed: false, record: given ?? { runId: 'r1', status: 'running', outcome: null, issue: { project: 'p', id: 'a' } } }
  const adapter = { invoke: async (args) => {
    invocations.push(args)
    const event = JSON.parse(args.prompt).event
    const action = event.type === 'user' ? script.shift() ?? null : event.result?.previewId ? { type: 'start_run', project: 'p', issueId: 'a', previewId: event.result.previewId } : null
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
  } }
  const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
    listIssues: async () => [{ id: 'a' }], getIssue: async () => ({ name: 'x' }), preview: async () => ({ ok: true, configHash: 'h' }),
    start: async () => ({ runId: 'r1', status: h.record.status }),
    getRun: async () => {
      if (h.readFault) throw h.readFault
      return h.packed ? summarisePackedRun({ runId: 'r1', project: 'p', issueId: 'a', record: structuredClone(h.record) }) : summariseRun(structuredClone(h.record))
    },
    stop: async () => { h.record.status = 'cancelled' }, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }),
    reconcileDelivery: async (a) => { calls.push(a); return h.onReconcile?.() ?? {} }, markLanded: async (a) => { calls.push(a); return h.onLand?.() ?? {} } }
  h.agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'wire', defaultEffort: 'high', verification: { status: 'verified' } }], adapter, tools, pollMs: 20, decisions })
  if (!adopt) script.push({ type: 'preview', project: 'p', issueId: 'a', playbook: 'x' })
  await h.agent.start({ model: 'm', projects: ['p'], message: 'go', limits: LIMITS })
  h.owned = () => h.agent.get().ownedRuns.find((r) => r.runId === 'r1')
  h.idle = () => h.agent.get().status === 'active'
  h.wakes = () => invocations.map((i) => JSON.parse(i.prompt).event).filter((e) => e.type === 'run-changed')
  h.close = async () => { await h.agent.stop(); await h.agent.shutdown?.() }
  await wait(() => h.owned()?.observedDelivery && h.idle())
  return h
}

export default async function (t) {
  t.section('no change, no wake: repeated polls of an unchanged run enqueue nothing')
  {
    const h = await owning()
    await polls()
    t.eq('nothing woke the supervisor about the run', h.wakes().length, 0)
    await h.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('an undecided automatic reconcile: the block wakes nobody, the decision wakes once')
  {
    const h = await owning()
    h.record.status = 'blocked'; h.record.outcome = 'unresolved'; h.record.blockedReason = 'source-delivery-blocked'
    h.record.reconcilePending = true
    await polls()
    t.eq('the block does not wake the supervisor while it is undecided', h.wakes().length, 0)
    h.record.reconciliations = [{ n: 1, by: 'engine', state: 'merging' }]
    await polls()
    t.eq('nor does the attempt starting', h.wakes().length, 0)
    h.readFault = Object.assign(new Error("this run's record cannot be read"), { status: 503 })
    await polls()
    t.ok('a record that cannot be read stays monitored', Boolean(h.owned()))
    t.eq('and wakes nobody', h.wakes().length, 0)
    h.readFault = null
    h.record.reconcilePending = false
    h.record.status = 'completed'; h.record.outcome = 'resolved'; h.record.blockedReason = null
    h.record.reconciliations = [{ n: 1, by: 'engine', state: 'accepted', endedAt: '2026-11-02T10:00:00.000Z' }]
    await wait(() => h.wakes().length === 1 && h.idle())
    t.eq('the decision wakes it, saying what moved', h.wakes()[0].changed, ['status', 'reconcile'])
    await polls()
    t.eq('once', h.wakes().length, 1)
    await h.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('a refused reconcile on a blocked run wakes once, also when a poll saw it merging')
  {
    const h = await owning()
    h.record.status = 'blocked'; h.record.outcome = 'unresolved'
    await wait(() => h.wakes().length === 1 && h.idle())
    t.eq('the block itself says status', h.wakes()[0].changed, ['status'])
    h.record.reconciliations = [{ n: 1, by: 'operator', state: 'merging' }]
    await polls()
    t.eq('a reconcile still merging decided nothing', h.wakes().length, 1)
    h.record.reconciliations = [{ n: 1, by: 'operator', state: 'conflicts', endedAt: '2026-11-02T10:00:00.000Z', conflicts: ['x.js'], error: 'conflicts in x.js' }]
    await wait(() => h.wakes().length === 2 && h.idle())
    const event = h.wakes()[1]
    t.eq('the refusal wakes, saying what moved', event.changed, ['reconcile'])
    t.eq('with the refusal on the run it carries', [event.run.status, event.run.reconciliation.state, event.run.reconciliation.conflicts], ['blocked', 'conflicts', ['x.js']])
    await polls()
    t.eq('once', h.wakes().length, 2)
    h.record.reconciliations.push({ n: 2, by: 'operator', state: 'merging' })
    await polls()
    t.eq('a second attempt in progress is not news: the last decided one still reads the same', h.wakes().length, 2)
    await h.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('an accepted reconcile the filter would otherwise hold wakes, naming both changes')
  {
    t.eq('a run gone back to running because of a reconcile is not routine', alwaysWakes({ type: 'run-changed', changed: ['status', 'reconcile'], run: { status: 'running' } }), true)
    t.eq('a status change alone still may be held', alwaysWakes({ type: 'run-changed', changed: ['status'], run: { status: 'running' } }), false)
    t.eq('and an event without `changed` reads as one', alwaysWakes({ type: 'run-changed', run: { status: 'running' } }), false)
    const h = await owning()
    h.record.status = 'blocked'
    await wait(() => h.wakes().length === 1 && h.idle())
    h.record.status = 'running'
    h.record.reconciliations = [{ n: 1, state: 'accepted', endedAt: '2026-11-02T10:00:00.000Z', revision: 'sha256:r' }]
    await wait(() => h.wakes().length === 2 && h.idle())
    t.eq('status and reconcile', h.wakes()[1].changed, ['status', 'reconcile'])
    await h.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('a landing wakes once on a run the wake filter treats as routine; what was held keeps what changed')
  {
    const oracle = fakeOracle([{ pick: { wake: 'defer' } }])
    const h = await owning({ decisions: ({ spending }) => createAdvisor({ spending, loadProvider: async () => CONFIG, createOracle: () => oracle }) })
    const asked = oracle.calls.length
    h.record.status = 'completed'; h.record.outcome = 'resolved'
    await wait(() => (h.agent.get().deferred?.length ?? 0) === 1)
    t.eq('a resolved ending may be held', h.wakes().length, 0)
    t.eq('the provider is shown what changed', oracle.calls[asked].state.event.changed, ['status'])
    h.record.landed = { by: 'someone', commit: 'c1', recordedAt: '2026-11-02T10:00:00.000Z' }
    await wait(() => h.wakes().length === 1 && h.idle())
    const event = h.wakes()[0]
    t.eq('the landing wakes, saying so', event.changed, ['landing'])
    t.eq('the run it carries names who landed it', event.run.landed.by, 'someone')
    t.eq('without asking the provider', oracle.calls.length, asked + 1)
    t.eq('the held event rides along, still saying what changed', event.deferred?.map((d) => d.event.changed), [['status']])
    await polls()
    t.eq('once', h.wakes().length, 1)
    await h.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('the supervisor\'s own reconcile and landing are told by the action result, not again by the poll')
  {
    const h = await owning()
    h.record.status = 'blocked'
    await wait(() => h.wakes().length === 1 && h.idle())
    h.onReconcile = () => { h.record.reconciliations = [{ n: 1, state: 'conflicts', endedAt: '2026-11-02T10:00:00.000Z' }]; return { status: 'blocked' } }
    h.script.push({ type: 'reconcile_delivery_run', project: 'p', issueId: 'a', runId: 'r1' })
    await h.agent.chat('reconcile it')
    await wait(() => h.calls.length === 1 && h.idle())
    await polls()
    t.eq('its reconcile adds no run-changed', h.wakes().length, 1)
    h.onLand = () => { h.record.landed = { by: 'supervisor', recordedAt: '2026-11-02T10:01:00.000Z' }; return { landed: true } }
    h.script.push({ type: 'mark_landed', project: 'p', issueId: 'a', runId: 'r1', applied: 'the patch', handChanges: 'none', commit: 'c1' })
    await h.agent.chat('it was landed')
    await wait(() => h.calls.length === 2 && h.idle())
    await polls()
    t.eq('nor does its landing', h.wakes().length, 1)
    h.record.reconciliations.push({ n: 2, state: 'failed', endedAt: '2026-11-02T10:02:00.000Z' })
    await wait(() => h.wakes().length === 2 && h.idle())
    t.eq('a decision by anyone else still wakes it', h.wakes()[1].changed, ['reconcile'])
    await h.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('how a reading is obtained is not a change: an older owned run, and packing')
  {
    const decided = { reconciliations: [{ n: 1, state: 'conflicts', endedAt: '2026-11-02T10:00:00.000Z' }, { n: 2, state: 'merging' }],
      landed: { by: 'someone', recordedAt: '2026-11-02T10:01:00.000Z' }, artifactApplication: { state: 'failed' },
      delivery: { action: 'apply-to-source', completedAt: null, application: { state: 'source-drift' }, artifactRef: 'a.patch' }, integration: { mergeCommit: 'm1', targetBranch: 'main' } }
    const record = { runId: 'r1', status: 'blocked', outcome: 'unresolved', issue: { project: 'p', id: 'a' }, ...decided }
    t.eq('the bundle\'s reading equals the live one', deliveryReading(summarisePackedRun({ runId: 'r1', project: 'p', issueId: 'a', record })), deliveryReading(summariseRun(record)))

    const h = await owning({ record })
    t.eq('first observation of a run already decided is its baseline', h.wakes().length, 0)
    h.packed = true
    await polls()
    t.eq('its issue being packed wakes nothing', h.wakes().length, 0)
    t.eq('and the packed reading is still the one in force', h.owned().observedDelivery, deliveryReading(summariseRun(record)))
    h.packed = false
    h.record.status = 'completed'; h.record.outcome = 'unresolved'
    await wait(() => h.wakes().length === 1 && h.idle())
    await h.agent.stop()
    await h.agent.shutdown?.()

    // A run owned before the reading was recorded, its landing among what happened meanwhile.
    const file = path.join(h.dir, 'state.json')
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    delete saved.ownedRuns[0].observedDelivery
    await fs.writeFile(file, JSON.stringify(saved))
    const before = record.landed
    const upgraded = await owning({ dir: h.dir, adopt: true, record: { ...record, landed: { ...before, recordedAt: '2026-11-02T11:00:00.000Z' } } })
    const prior = upgraded.wakes().length
    await polls()
    t.eq('an entry with no stored reading does not wake on upgrade', upgraded.wakes().length, prior)
    t.eq('nor did the first poll say run-changed', prior, 0)
    t.ok('and now has one', upgraded.owned().observedDelivery?.landing === '2026-11-02T11:00:00.000Z')
    upgraded.record.landed.recordedAt = '2026-11-02T12:00:00.000Z'
    await wait(() => upgraded.wakes().length === 1 && upgraded.idle())
    t.eq('from then on a change wakes', upgraded.wakes()[0].changed, ['landing'])
    await upgraded.close()
    await fs.rm(h.dir, { recursive: true, force: true })
  }

  t.section('the summary a held event keeps')
  {
    t.eq('names what changed', summariseEvent({ type: 'run-changed', changed: ['status'], run: { runId: 'r1', status: 'running' } }).changed, ['status'])
  }
}
