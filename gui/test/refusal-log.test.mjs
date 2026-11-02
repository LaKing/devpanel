import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { installLogging } from '../server/logging.mjs'
import { startRun, releaseOwnership } from '../server/runtime/launch.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'supervisor tool refusals are warnings without a stack; faults stay errors'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const STACK = /\n\s+at /

export default async function (t) {
  // A real engine stopped at the round limit: refresh-checks does not apply to it.
  const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('needs-fix')], [blocking('needs-fix')], []] }) })
  const playbookFile = path.join(f.configRoot, 'playbooks', 'implementation.yaml')
  await fs.writeFile(playbookFile, (await fs.readFile(playbookFile, 'utf8')).replace('budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n'))
  const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
  engine.run.budgets.limits.maxSteps = 100
  await engine.drive()
  t.eq('refresh-checks is not listed for this run', supportedActions(engine.run), ['resume', 'start-new'])

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-refusal-log-'))
  const logDir = path.join(dir, 'logs')
  const runId = engine.runId
  const events = []
  let step = 0
  const plan = [
    { type: 'preview', project: 'p', issueId: 'a', playbook: 'x' },
    (e) => ({ type: 'start_run', project: 'p', issueId: 'a', previewId: e.result.previewId }),
    { type: 'refresh_checks_run', project: 'p', issueId: 'a', runId },
    { type: 'retry_input_run', project: 'p', issueId: 'a', runId },
    { type: 'recover_run', project: 'p', issueId: 'a', runId }
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
    start: async () => ({ runId, status: 'blocked' }),
    getRun: async () => ({ runId, status: 'blocked' }),
    refreshChecks: () => engine.refreshClosureChecks(null),
    retryInput: async () => { throw new Error('the disk fell over') },
    recover: async () => { throw Object.assign(new Error('the service is shutting down'), { status: 503 }) },
    stop: async () => {}, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }

  // Replaces console for the suite's own span; the runner awaits suites one at a time.
  const logging = installLogging({ dir: logDir })
  let rows
  try {
    const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
    await agent.start({ model: 'test-model', projects: ['p'], message: 'go', limits: { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => step >= plan.length && events.length > plan.length && agent.get().status === 'active')
    await agent.stop()
  } finally {
    logging.restore()
    rows = (await fs.readFile(logging.file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  }
  const about = (type) => rows.filter((r) => r.message.includes(`supervisor action ${type}`))
  const failed = rows.filter((r) => r.message.startsWith('supervisor action failed:'))

  t.section('a tool refusal: refresh-checks on a run where it does not apply')
  t.ok('the model still reads the refusal', events.some((e) => /Only a retained code run/.test(e.result?.error ?? '')), JSON.stringify(events.map((e) => e.result)))
  const warned = about('refresh_checks_run')
  t.eq('one row, at warn', warned.map((r) => r.level), ['warn'])
  t.ok('it names the refusal and its status', /refused \(409\): Only a retained code run/.test(warned[0]?.message ?? ''), warned[0]?.message)
  t.ok('with no stack', !STACK.test(warned[0]?.message ?? ''))
  t.eq('no error row mentions it', rows.filter((r) => r.level === 'error' && /Only a retained code run/.test(r.message)).length, 0)

  t.section('a fault on the same path is not downgraded')
  const fault = failed.filter((r) => r.message.includes('the disk fell over'))
  t.eq('an error with no status is one row, at error', fault.map((r) => r.level), ['error'])
  t.ok('with its stack', STACK.test(fault[0]?.message ?? ''), fault[0]?.message)
  t.eq('and no warn row', rows.filter((r) => r.level === 'warn' && r.message.includes('the disk fell over')).length, 0)
  t.eq('a 5xx is at error too', failed.filter((r) => r.message.includes('shutting down')).map((r) => r.level), ['error'])

  await fs.rm(dir, { recursive: true, force: true })
  await releaseOwnership(engine)
  await cleanupFixtures()
}
