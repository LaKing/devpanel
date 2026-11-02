import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { summariseRun } from '../server/supervisor-summary.mjs'

export const name = 'top-level supervisor — a repeated get_run of an unchanged run is answered short'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const LIMITS = { maxCalls: 100, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 }

const working = (runId) => ({
  runId, status: 'running', outcome: null, issue: { project: 'p', id: 'a' }, timeline: [],
  metrics: { turns: { total: 0 }, time: { totalMs: 1000 } },
  active: [{ role: 'implementer', invocationId: 'i1', startedAt: '2026-11-02T10:00:00.000Z', activity: { pid: 1, events: 1, lastAt: '2026-11-02T10:00:01.000Z', lastKind: 'tool' } }]
})
const read = (runId) => ({ type: 'get_run', project: 'p', issueId: 'a', runId })

/**
 * A supervisor owning r1, read through the real summary. A wake's script lists what the model does: an action,
 * or a function that changes the run first and returns the action. `results` holds what get_run answered.
 */
async function supervisor () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-get-run-guard-'))
  const h = { dir, records: { r1: working('r1'), r2: working('r2') }, script: [], results: [], invocations: [], session: 's', fullReads: 0 }
  const adapter = { invoke: async (args) => {
    h.invocations.push(args)
    const event = JSON.parse(args.prompt).event
    if (event.action?.type === 'get_run') h.results.push(event.result)
    if (event.result?.previewId) return { session: { id: h.session }, response: JSON.stringify({ message: 'ok', action: { type: 'start_run', project: 'p', issueId: 'a', previewId: event.result.previewId } }), usage: { costUsd: 0 } }
    const next = event.type === 'run-changed' ? null : h.script.shift() ?? null
    const action = typeof next === 'function' ? next() : next
    return { session: { id: h.session }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
  } }
  const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
    listIssues: async () => [{ id: 'a' }], getIssue: async () => ({ name: 'x' }), preview: async () => ({ ok: true, configHash: 'h' }),
    start: async () => ({ runId: 'r1', status: 'running' }),
    getRun: async (_p, _i, runId) => { h.fullReads++; return summariseRun(structuredClone(h.records[runId])) },
    stop: async (r) => { h.records[r.runId].status = 'cancelled' }, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
  h.agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'wire', defaultEffort: 'high', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
  h.script.push({ type: 'preview', project: 'p', issueId: 'a', playbook: 'x' })
  await h.agent.start({ model: 'm', projects: ['p'], message: 'go', limits: LIMITS })
  h.idle = () => h.agent.get().status === 'active' && !h.script.length && !h.agent.get().queue.length && !h.agent.get().wake
  await wait(() => h.agent.get().ownedRuns.some((r) => r.runId === 'r1') && h.idle())
  // One wake: the chat message opens it and the chain runs until the script's last action has been answered.
  h.wake = async (...script) => {
    const before = h.results.length
    h.script.push(...script)
    await h.agent.chat('look')
    await wait(() => h.idle() && h.results.length === before + script.filter((s) => typeof s === 'function' || s.type === 'get_run').length)
    return h.results.slice(before)
  }
  h.close = async () => { await h.agent.stop(); await h.agent.shutdown?.(); await fs.rm(dir, { recursive: true, force: true }) }
  return h
}

const isFull = (r) => r.unchanged === undefined && Array.isArray(r.steps)
const isShort = (r) => r.unchanged === true && r.steps === undefined

export default async function (t) {
  t.section('the charter says runs are watched and not to re-read them')
  {
    const h = await supervisor()
    const charter = h.invocations[0].instructions
    t.ok('owned runs are watched by the panel', /Runs you own are watched by the panel/.test(charter))
    t.ok('their changes arrive as events', /their changes arrive as events/.test(charter))
    t.ok('it ends its turn or finishes, and waits', /end your turn with action:null \(or finish, when your work is done\) and wait/.test(charter))
    t.ok('never re-reading a run', /Never re-read a run to see whether it has moved/.test(charter))
    t.ok('and it names the short answer', /unchanged since <time>; you will be woken on change/.test(charter))
    t.ok('with no backtick in the text', !charter.includes('`'))
    await h.close()
  }

  t.section('a run still working, with nothing new: the first read is full, the repeats are short')
  {
    const h = await supervisor()
    const [first, second, third] = await h.wake(read('r1'), () => {
      // What moves on a run that is simply working: liveness, and time derived at the read.
      h.records.r1.active[0].activity = { pid: 1, events: 90, lastAt: '2026-11-02T10:05:00.000Z', lastKind: 'text' }
      h.records.r1.metrics.time.totalMs = 300000
      return read('r1')
    }, read('r1'))
    t.ok('the first read of the run in the wake is the full record', isFull(first))
    t.ok('the second is short though its activity and clock moved', isShort(second))
    t.eq('it names the run and its status', [second.runId, second.status], ['r1', 'running'])
    t.ok('in the words of the criterion', second.detail === `unchanged since ${second.since}; you will be woken on change`)
    t.ok('with a real time', Number.isFinite(Date.parse(second.since)))
    t.ok('the third is short too', isShort(third))
    t.eq('since still names the same reading', third.since, second.since)
    await h.close()
  }

  t.section('a change in the run always returns the full record')
  {
    const h = await supervisor()
    const changes = {
      step: (r) => { r.timeline = [{ number: '001', stepId: 'implement', role: 'implementer', round: 1, attempt: 1, timing: {}, findings: [] }] },
      'the turn in flight': (r) => { r.active = [] },
      revision: (r) => { r.currentRevision = 'sha256:abc' },
      check: (r) => { r.checkResults = [{ revision: 'sha256:abc', result: 'failed', appliesToCurrentRevision: true }] },
      delivery: (r) => { r.delivery = { action: 'apply-to-source', completedAt: '2026-11-02T11:00:00.000Z' } },
      reconcile: (r) => { r.reconciliations = [{ n: 1, state: 'conflicts', endedAt: '2026-11-02T11:01:00.000Z' }] },
      pause: (r) => { r.pause = { id: 'p1', question: 'which?' } },
      status: (r) => { r.status = 'paused' }
    }
    for (const [name, change] of Object.entries(changes)) {
      const [changed, again] = await h.wake(read('r1'), () => { change(h.records.r1); return read('r1') }, read('r1')).then((all) => all.slice(1))
      t.ok(`${name}: the read after it is full`, isFull(changed))
      t.ok(`${name}: and the next one short again`, isShort(again))
    }
    await h.close()
  }

  t.section('a different run, an action between, a later wake, a new session')
  {
    const h = await supervisor()
    const [a1, b1, b2, a2] = await h.wake(read('r1'), read('r2'), read('r2'), read('r1'))
    t.ok('the first run is full', isFull(a1))
    t.ok('another run is full', isFull(b1) && b1.runId === 'r2')
    t.ok('repeating that one is short', isShort(b2) && b2.runId === 'r2')
    t.ok('back to the first run is full again', isFull(a2))
    t.ok('of a run it does not own, no wake is promised', /you do not own this run/.test(b2.detail) && !/you will be woken/.test(b2.detail))

    const between = await h.wake(read('r1'), { type: 'add_note', project: 'p', issueId: 'a', text: 'n' }, read('r1'))
    t.ok('the first read of the new wake is full, though the last one read this same run', isFull(between[0]))
    t.ok('an action in between does not reset it', isShort(between[1]))

    const [later] = await h.wake(read('r1'))
    t.ok('a later wake reads in full, the run unchanged', isFull(later))

    const session = await h.wake(read('r1'), () => { h.session = 's2'; return read('r1') }, read('r1'))
    t.ok('a new native session in the wake has not seen the record', isFull(session[1]))
    t.ok('and is short after that', isShort(session[2]))
    await h.close()
  }

  t.section('the guard is the action\'s alone: monitoring keeps reading the run')
  {
    const h = await supervisor()
    const [, short] = await h.wake(read('r1'), read('r1'))
    t.ok('short to the model', isShort(short))
    const before = h.fullReads
    await wait(() => h.fullReads > before + 2)
    t.eq('the idle poll goes on reading the run', h.invocations.filter((i) => JSON.parse(i.prompt).event.type === 'run-changed').length, 0)
    h.records.r1.status = 'blocked'
    await wait(() => h.invocations.some((i) => JSON.parse(i.prompt).event.type === 'run-changed') && h.idle())
    const event = JSON.parse(h.invocations.findLast((i) => JSON.parse(i.prompt).event.type === 'run-changed').prompt).event
    t.eq('and the change wakes it, with the run in the event', [event.changed, event.run.status, Array.isArray(event.run.steps)], [['status'], 'blocked', true])
    await h.close()
  }
}
