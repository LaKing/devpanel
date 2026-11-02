import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

// Supervisor continues and follow-ups were the two loops that kept issues
// open for days: a continue buys a round that repeats the last one, and every
// closure's residual risks became new issues. Both are the operator's now.
export default async function (t) {
  t.section('the supervisor continues a run once and opens no follow-ups')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-limits-'))
  const events = []
  let continues = 0, followUps = 0, step = 0
  const recoveries = []
  const plan = [
    { type: 'preview', project: 'p', issueId: 'a', playbook: 'x' },
    (e) => ({ type: 'start_run', project: 'p', issueId: 'a', previewId: e.result.previewId }),
    { type: 'recover_run', project: 'p', issueId: 'a', runId: 'r1' },
    // A model naming who it is: the protocol refuses the reply, and the repair event brings the next step.
    { type: 'recover_run', project: 'p', issueId: 'a', runId: 'r1', actor: 'someone-else' },
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
    continueRun: async () => { continues++; return { ok: true } },
    recover: async (a) => { recoveries.push(a); return { ok: true } },
    createFollowUps: async () => { followUps++; return { created: [] } },
    stop: async () => {}, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
  const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
  try {
    await agent.start({ model: 'test-model', projects: ['p'], message: 'go', limits: { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => step >= plan.length && events.length > plan.length && agent.get().status === 'active')
    const seen = JSON.stringify(events)
    t.eq('a recovery is attributed to the supervisor', recoveries.map((a) => [a.actor, a.origin]), [['supervisor', 'supervisor']])
    t.eq('a reply naming its own actor or origin is refused and never reaches the tool', [recoveries.length, events.filter((e) => /Unexpected action argument/.test(e.error ?? '')).length], [1, 2])
    t.eq('the first continue went through', continues, 1)
    t.ok('the second was refused, pointing at the operator', /already continued this run 1 time/.test(seen) && /ask_operator/.test(seen))
    t.eq('no follow-up was created', followUps, 0)
    t.ok('and the refusal says who opens them', /opened by the operator/.test(seen))
    await agent.stop()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
