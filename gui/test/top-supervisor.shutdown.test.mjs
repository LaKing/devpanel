import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'top-level supervisor — a service shutdown leaves its runs to the service, and a recovered run frees it'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const LIMITS = { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 }
const MODELS = async () => [{ id: 'm', title: 'M', model: 'wire', defaultEffort: 'high', verification: { status: 'verified' } }]

/** A supervisor that owns one live run `r1`; `stops` counts what it asked the run supervisor to stop. */
async function owning (dir) {
  const h = { dir, stops: 0, run: { runId: 'r1', status: 'running', outcome: null }, script: [{ type: 'preview', project: 'p', issueId: 'a', playbook: 'x' }] }
  const adapter = { invoke: async (args) => {
    const event = JSON.parse(args.prompt).event
    const action = event.type === 'user' ? h.script.shift() ?? null : event.result?.previewId ? { type: 'start_run', project: 'p', issueId: 'a', previewId: event.result.previewId } : null
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
  } }
  h.tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
    listIssues: async () => [{ id: 'a' }], getIssue: async () => ({ name: 'x' }), preview: async () => ({ ok: true, configHash: 'h' }),
    start: async () => ({ runId: 'r1', status: h.run.status }), getRun: async () => structuredClone(h.run),
    // What an operator's Stop does to a writing turn: the run is quarantined with its partial edit.
    stop: async () => { h.stops++; Object.assign(h.run, { status: 'blocked', blockedReason: 'recovery-required', recovery: { required: true } }) },
    archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
  h.open = async () => { h.agent = await createTopSupervisor({ dir, models: MODELS, adapter, tools: h.tools, pollMs: 20 }); return h.agent }
  await h.open()
  await h.agent.start({ model: 'm', projects: ['p'], message: 'go', limits: LIMITS })
  await wait(() => h.agent.get().ownedRuns.some((r) => r.runId === 'r1') && h.agent.get().status === 'active')
  return h
}

export default async function (t) {
  t.section('a service shutdown stops the activation and none of its runs')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-shutdown-'))
    const h = await owning(dir)
    await h.agent.shutdown()
    t.eq('the run supervisor was asked to stop nothing', h.stops, 0)
    t.eq('the owned run is as it was', h.run.status, 'running')
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'))
    t.eq('the session is kept, stopped', [saved.status, saved.session?.id], ['stopped', 's'])
    t.ok('and still owns the run', saved.ownedRuns.some((r) => r.runId === 'r1'))
    t.ok('the chat says why nothing was stopped', saved.messages.some((m) => m.role === 'system' && /service is shutting down/.test(m.text)))

    const again = await h.open()
    t.eq('the next service start finds it stopped', again.get().status, 'stopped')
    await again.start({ model: 'm', projects: ['p'], message: 'continue', limits: LIMITS })
    await wait(() => again.get().status === 'active')
    t.eq('and Start continues the same session', again.get().session?.id, 's')
    await again.shutdown()
    t.eq('a second shutdown stops nothing either', h.stops, 0)
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('an operator Stop still stops the runs; a run it left to recover holds Start only until it is recovered')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-shutdown-'))
    const h = await owning(dir)
    await h.agent.stop()
    t.eq('Stop stopped the owned run', h.stops, 1)
    t.eq('which needs recovery, so the supervisor does too', h.agent.get().status, 'recovery-required')
    const refused = await h.agent.start({ model: 'm', projects: ['p'], message: 'go on', limits: LIMITS }).then(() => null, (e) => e)
    t.eq('Start is refused while the run needs recovery', refused?.status, 409)
    t.ok('naming the run', /r1/.test(refused?.message ?? ''))
    t.eq('and nothing changed', h.agent.get().status, 'recovery-required')

    // A person recovered the run (accept-partial, restored or abandon): its record no longer asks for recovery.
    Object.assign(h.run, { status: 'running', blockedReason: null, recovery: null })
    await h.agent.start({ model: 'm', projects: ['p'], message: 'go on', limits: LIMITS })
    await wait(() => h.agent.get().status === 'active')
    t.eq('Start continues the same session once it is recovered', h.agent.get().session?.id, 's')
    t.ok('with the run still owned', h.agent.get().ownedRuns.some((r) => r.runId === 'r1'))
    await h.agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
