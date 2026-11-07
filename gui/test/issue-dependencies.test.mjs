import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture } from './fakes/fixture.mjs'
import { setIssueDependencies, openDependencies } from '../server/issue-dependencies.mjs'
import { buildOverview } from '../server/supervisor-overview.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { startAdmission } from '../server/start-admission.mjs'

export const name = 'issue dependencies — prerequisites order the backlog and hold supervisor starts'

const wait = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const refusal = async (fn) => { try { await fn() } catch (e) { return e } return null }

export default async function (t) {
  const f = await engineFixture({})
  const P = 'devpanel-project'
  const read = (p, i) => f.issues.getIssue(p, i)
  const rule = await f.issues.createIssue(P, { name: 'Settle the rule' })
  const uses = f.issue

  t.section('recording, validation and settling')
  {
    let threw = await refusal(() => setIssueDependencies(P, uses.id, { dependsOn: [rule.id] }, { getIssue: read }))
    t.ok('a reason is required', /reason/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => setIssueDependencies(P, uses.id, { dependsOn: [uses.id], reason: 'x' }, { getIssue: read }))
    t.ok('an issue cannot wait for itself', /itself/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => setIssueDependencies(P, uses.id, { dependsOn: ['2026-01-01-nope'], reason: 'x' }, { getIssue: read }))
    t.eq('an unknown prerequisite is refused', threw?.status, 404)
    const issue = await setIssueDependencies(P, uses.id, { dependsOn: [rule.id], reason: 'needs the include/ rule', by: 'supervisor' }, { getIssue: read })
    t.eq('recorded', issue.dependsOn?.issues, [{ project: P, id: rule.id }])
    t.eq('by whom', issue.dependsOn?.by, 'supervisor')
    threw = await refusal(() => setIssueDependencies(P, rule.id, { dependsOn: [uses.id], reason: 'x' }, { getIssue: read }))
    t.ok('a direct cycle is refused', /already depends/.test(threw?.message ?? ''), threw?.message)
    t.eq('open while the prerequisite is undecided', (await openDependencies(issue, { getIssue: read })).map((d) => d.id), [rule.id])

    const overview = await buildOverview({ projects: [P], listIssues: (p, o) => f.issues.listIssues(p, o), openDependencies: (i) => openDependencies(i, { getIssue: read }) })
    const lines = overview.projects[0].openIssues
    t.eq('overview names what it waits for', lines.find((l) => l.id === uses.id)?.waitingOn, [rule.id])
    t.eq('the waiting issue sorts after the ready one', lines.map((l) => l.id), [rule.id, uses.id])
    t.eq('flow counts both openings', overview.projects[0].flow7d.opened, 2)

    await f.issues.setIssueDisposition(P, rule.id, { value: 'resolved', evidence: 'rule written' })
    t.eq('settled by a disposition', (await openDependencies(await read(P, uses.id), { getIssue: read })).length, 0)
    const after = await buildOverview({ projects: [P], listIssues: (p, o) => f.issues.listIssues(p, o) })
    t.eq('flow counts the settlement by value', after.projects[0].flow7d.settled, { resolved: 1 })
    const now = new Date().toISOString()
    const fakeRuns = async (dir) => dir.endsWith(rule.id)
      ? [{ runId: 'a', status: 'completed', delivery: { action: 'none', completedAt: now }, revisions: [] }]
      : [{ runId: 'b', status: 'completed', delivery: { action: 'apply-to-source', completedAt: now }, revisions: [{}] },
          { runId: 'c', status: 'completed', delivery: { action: 'worktree-diff', completedAt: now }, revisions: [{}] }]
    const counted = await buildOverview({ projects: [P], listIssues: (p, o) => f.issues.listIssues(p, o), readRuns: fakeRuns })
    t.eq('delivered counts issues with a real delivery, once each', counted.projects[0].flow7d.deliveredIssues, 1)
    const cleared = await setIssueDependencies(P, uses.id, { dependsOn: [] }, { getIssue: read })
    t.eq('an empty list clears', cleared.dependsOn, null)
  }

  t.section('a cycle of any length is refused')
  {
    const g = await engineFixture({})
    const get = (p, i) => g.issues.getIssue(p, i)
    const [a, b, c] = [g.issue, await g.issues.createIssue(P, { name: 'B' }), await g.issues.createIssue(P, { name: 'C' })]
    await setIssueDependencies(P, a.id, { dependsOn: [b.id], reason: 'x' }, { getIssue: get })
    await setIssueDependencies(P, b.id, { dependsOn: [c.id], reason: 'x' }, { getIssue: get })
    const threw = await refusal(() => setIssueDependencies(P, c.id, { dependsOn: [a.id], reason: 'x' }, { getIssue: get }))
    t.ok('naming the way round', threw?.message?.includes(`through ${b.id}`), threw?.message)
  }

  t.section('the supervisor records a dependency and is refused a start while it is open')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-deps-'))
    let open = [{ project: 'p', id: 'first', name: 'First' }]
    const recorded = []
    let started = 0
    let script = []
    const adapter = { invoke: async (args) => {
      const event = JSON.parse(args.prompt).event
      const action = script.shift()?.(event) ?? null
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
    } }
    const tools = {
      projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [],
      getIssue: async () => ({ issue: { id: 'second' }, reports: [], runs: [] }),
      preview: async () => ({ ok: true, configHash: 'h' }),
      start: async () => { started++; return { runId: 'r1', status: 'running' } },
      getRun: async () => ({ status: 'completed' }),
      setDependencies: async (a) => { recorded.push(a); return { dependsOn: a.dependsOn } },
      // The same admission start_run and an automatic start pass (start-admission.mjs).
      startAdmission: async (a) => startAdmission({ issue: { id: 'second', project: 'p', dependsOn: { issues: open.map((d) => ({ project: d.project, id: d.id })) } }, playbook: a.playbook }, { read: async () => ({ id: 'first', name: 'First' }) })
    }
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    script = [
      () => ({ type: 'set_dependencies', project: 'p', issueId: 'second', dependsOn: ['first'], reason: 'needs the rule' }),
      () => ({ type: 'preview', project: 'p', issueId: 'second', playbook: 'x' }),
      (e) => ({ type: 'start_run', project: 'p', issueId: 'second', previewId: e.result.previewId }),
      () => { open = []; return { type: 'preview', project: 'p', issueId: 'second', playbook: 'x' } },
      (e) => ({ type: 'start_run', project: 'p', issueId: 'second', previewId: e.result.previewId }),
      () => ({ type: 'finish' })
    ]
    await agent.start({ model: 'm', projects: ['p'], message: 'go', limits: { maxCalls: 20, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => agent.get().finishing === true)
    const tool = (i) => agent.get().messages.filter((m) => m.role === 'tool')[i]?.text ?? ''
    t.eq('the dependency went to the tool', recorded[0]?.dependsOn, ['first'])
    t.ok('the start was refused while the prerequisite was open', tool(2).includes('waits for first'), tool(2))
    t.eq('then allowed once it settled', started, 1)
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
