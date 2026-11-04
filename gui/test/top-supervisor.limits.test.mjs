import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { wallClockRefusal } from '../server/runtime/wall-clock.mjs'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

// Supervisor continues and follow-ups were the two loops that kept issues
// open for days: a continue buys a round that repeats the last one, and every
// closure's residual risks became new issues. Both are the operator's now.
export default async function (t) {
  t.section('the supervisor continues a run once and opens no follow-ups')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-limits-'))
  const events = []
  let continues = 0, followUps = 0, step = 0
  const continueArgs = []
  const recoveries = []
  const plan = [
    { type: 'preview', project: 'p', issueId: 'a', playbook: 'x' },
    (e) => ({ type: 'start_run', project: 'p', issueId: 'a', previewId: e.result.previewId }),
    { type: 'recover_run', project: 'p', issueId: 'a', runId: 'r1' },
    // A model naming who it is: the protocol refuses the reply, and the repair event brings the next step.
    { type: 'recover_run', project: 'p', issueId: 'a', runId: 'r1', actor: 'someone-else' },
    // The repair's own reply must be valid: a second invalid one in a row ends the activation.
    { type: 'get_run', project: 'p', issueId: 'a', runId: 'r1' },
    // Nor can it accept a short wall clock: that override is an operator's.
    { type: 'continue_run', project: 'p', issueId: 'a', runId: 'r1', instruction: 'anyway', acceptShortWallClock: true },
    { type: 'continue_run', project: 'p', issueId: 'a', runId: 'r1', instruction: 'once more' },
    { type: 'recover_run', project: 'p', issueId: 'a', runId: 'r1', origin: 'panel' },
    { type: 'continue_run', project: 'p', issueId: 'a', runId: 'r1', instruction: 'and again' },
    { type: 'create_followups', project: 'p', issueId: 'a', runId: 'r1' }
  ]
  const models = async () => [{ id: 'test-model', title: 'Test model', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
  const adapter = { invoke: async (args) => {
    const event = JSON.parse(args.prompt).event
    events.push(event)
    const next = event.type === 'user' || event.result !== undefined || event.error !== undefined ? plan[step++] : null
    const action = typeof next === 'function' ? next(event) : next ?? null
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
  } }
  const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
    listIssues: async () => [{ id: 'a' }], getIssue: async () => ({ name: 'x' }),
    preview: async () => ({ ok: true, configHash: 'h' }),
    start: async () => ({ runId: 'r1', status: 'blocked' }),
    getRun: async () => ({ runId: 'r1', status: 'blocked' }),
    continueRun: async (a) => { continues++; continueArgs.push(a); return { ok: true } },
    recover: async (a) => { recoveries.push(a); return { ok: true } },
    createFollowUps: async () => { followUps++; return { created: [] } },
    stop: async () => {}, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
  const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
  try {
    await agent.start({ model: 'test-model', projects: ['p'], message: 'go', limits: { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => step >= plan.length && events.length > plan.length && agent.get().status === 'active')
    const seen = JSON.stringify(events)
    t.eq('a recovery is attributed to the supervisor', recoveries.map((a) => [a.actor, a.origin]), [['supervisor', 'supervisor']])
    t.eq('a reply naming its own actor or origin is refused and never reaches the tool', [recoveries.length, events.filter((e) => /Unexpected action argument/.test(e.error ?? '')).length], [1, 3])
    t.eq('the reply accepting a short wall clock never reached the tool: the first continue is the one without it', [continues, continueArgs[0]?.text, 'acceptShortWallClock' in (continueArgs[0] ?? {})], [1, 'once more', false])
    t.ok('the second was refused, pointing at the operator', /already continued this run 1 time/.test(seen) && /ask_operator/.test(seen))
    t.eq('no follow-up was created', followUps, 0)
    t.ok('and the refusal says who opens them', /opened by the operator/.test(seen))
    await agent.stop()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('a short wall clock refused by the tool reaches the model with both numbers and spends no continue')
  {
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-limits-'))
    const seen = []
    const args = []
    let at = 0
    const steps = [
      { type: 'preview', project: 'p', issueId: 'a', playbook: 'x' },
      (e) => ({ type: 'start_run', project: 'p', issueId: 'a', previewId: e.result.previewId }),
      { type: 'continue_run', project: 'p', issueId: 'a', runId: 'r1', instruction: 'short' },
      { type: 'continue_run', project: 'p', issueId: 'a', runId: 'r1', instruction: 'raised' }
    ]
    // What the engine throws for this standing: its own words, not the test's.
    const refusal = wallClockRefusal({ limitMinutes: 30, remainingMs: 30 * 60_000, meanRoundMs: 60 * 60_000, rounds: 1 })
    const invoke = async (a) => {
      const event = JSON.parse(a.prompt).event
      seen.push(event)
      const next = event.type === 'user' || event.result !== undefined || event.error !== undefined ? steps[at++] : null
      const action = typeof next === 'function' ? next(event) : next ?? null
      return { session: a.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
    }
    const throwing = { ...tools, continueRun: async (a) => {
      args.push(a)
      if (args.length === 1) throw Object.assign(new Error(refusal.message), { status: 422, code: refusal.code, detail: refusal.detail })
      return { ok: true }
    } }
    const agent2 = await createTopSupervisor({ dir: dir2, models, adapter: { invoke }, tools: throwing, pollMs: 20 })
    try {
      await agent2.start({ model: 'test-model', projects: ['p'], message: 'go', limits: { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 } })
      await wait(() => at >= steps.length && args.length === 2 && seen.filter((e) => e.type === 'tool-result').length >= steps.length && agent2.get().status === 'active')
      const refused = seen.find((e) => e.type === 'tool-result' && e.result?.code === 'WALL_CLOCK_SHORT')
      t.ok('the model reads the code and both numbers', refused?.result.error.includes('30 min') && refused.result.error.includes('60 min'), JSON.stringify(seen))
      t.eq('the tool was never offered the override', args.map((a) => 'acceptShortWallClock' in a), [false, false])
      t.eq('a refused continue is not counted: the next one reaches the tool', args.map((a) => a.text), ['short', 'raised'])
      await agent2.stop()
    } finally {
      await fs.rm(dir2, { recursive: true, force: true })
    }
  }
}
