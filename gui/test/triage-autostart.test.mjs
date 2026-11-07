import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decideAutoStart, readAutoStart, routeAutoStart } from '../server/auto-start.mjs'
import { startAdmission } from '../server/start-admission.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'triage autoStart — the recommended playbook starts after an autonomous triage, under the ordinary admission'

const wait = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) } }

const sizing = (size, verdict = 'autonomous') => ({ size, affectedModules: [], recommendedPlaybook: size === 'minor' ? 'prompt' : 'plan-and-implement', autonomy: { verdict, reason: 'r' }, seats: [] })
const snapshotOf = (autoStart) => ({ tactic: 'triage', runOptions: autoStart === undefined ? {} : { autoStart } })
const runOf = ({ size = 'minor', verdict = 'autonomous', status = 'completed', disposition = 'accepted', supervisorLaunchId = null } = {}) =>
  ({ status, outcome: 'resolved', ...(supervisorLaunchId ? { supervisorLaunchId } : {}), reportDisposition: { disposition, issues: [], sizing: sizing(size, verdict) } })

/** A finished triage run on disk: its snapshot and record, as routeAutoStart reads them. */
async function triageOnDisk ({ autoStart = true, ...run } = {}) {
  const issuePath = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-autostart-'))
  const runId = '2026-11-07T00-00-00-000Z-test'
  const dir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'resolved-playbook.json'), JSON.stringify(snapshotOf(autoStart)))
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(runOf(run)))
  return { issuePath, runId }
}

export default async function (t) {
  t.section('1. the decision is exactly: autoStart on, a closed triage, an autonomous verdict')
  t.eq('autonomous minor starts prompt', decideAutoStart(snapshotOf(true), runOf({ size: 'minor' })), { start: true, playbook: 'prompt' })
  t.eq('autonomous major starts plan-and-implement', decideAutoStart(snapshotOf(true), runOf({ size: 'major' })), { start: true, playbook: 'plan-and-implement' })
  t.eq('autoStart off starts nothing', decideAutoStart(snapshotOf(false), runOf()).start, false)
  t.eq('autoStart absent starts nothing', decideAutoStart(snapshotOf(undefined), runOf()).reason, 'auto-start-off')
  t.eq('needs-owner-input starts nothing', decideAutoStart(snapshotOf(true), runOf({ verdict: 'needs-owner-input' })).reason, 'verdict:needs-owner-input')
  t.eq('too-large starts nothing', decideAutoStart(snapshotOf(true), runOf({ verdict: 'too-large' })).reason, 'verdict:too-large')
  t.eq('a triage that did not close starts nothing', decideAutoStart(snapshotOf(true), runOf({ status: 'blocked' })).reason, 'not-closed')
  t.eq('no disposition gate: an autonomous no-findings record passes the decision', decideAutoStart(snapshotOf(true), runOf({ disposition: 'no-findings' })).start, true)

  t.section('2. the shared start admission: report trust and open dependencies')
  {
    const reporters = { relay: { project: 'p', policy: { fault: 'any', request: 'assess' } } }
    const reported = { id: 'feature', project: 'p', report: { kind: 'request', reporter: 'relay', trust: 'request' } }
    t.eq('an assess-only report is refused prompt', (await startAdmission({ issue: reported, playbook: 'prompt' }, { reporters }))?.code, 'report-trust')
    t.eq('and plan-and-implement', (await startAdmission({ issue: reported, playbook: 'plan-and-implement' }, { reporters }))?.code, 'report-trust')
    t.eq('but admitted for triage', await startAdmission({ issue: reported, playbook: 'triage' }, { reporters }), null)
    const waiting = { id: 'second', project: 'p', dependsOn: { issues: [{ project: 'p', id: 'first' }] } }
    const open = await startAdmission({ issue: waiting, playbook: 'prompt' }, { read: async () => ({ id: 'first', name: 'First' }) })
    t.eq('an unsettled prerequisite is refused', [open?.code, open?.waiting?.map((d) => d.id)], ['dependencies', ['first']])
    t.ok('with the message start_run gives', open.message.includes('second waits for first'))
    t.eq('a settled one is not', await startAdmission({ issue: waiting, playbook: 'prompt' }, { read: async () => ({ id: 'first', disposition: { value: 'resolved' } }) }), null)
  }

  t.section('3. routing: the recommended playbook starts on the same issue, once')
  {
    const plain = { id: 'plain', project: 'p' }
    for (const [size, playbook] of [['minor', 'prompt'], ['major', 'plan-and-implement']]) {
      const { issuePath, runId } = await triageOnDisk({ size })
      const started = []
      const deps = { getIssue: async () => plain, startOperator: async (a) => { started.push(a); return { runId: `next-${started.length}`, status: 'preflighting' } } }
      const record = await routeAutoStart({ project: 'p', issueId: 'plain', issuePath, runId }, deps)
      t.eq(`${size}: ${playbook} starts on the same issue`, started, [{ project: 'p', issueId: 'plain', playbookId: playbook }])
      t.eq(`${size}: recorded with the started run`, [record.decision, record.playbook, record.startedRunId], ['start', playbook, 'next-1'])
      t.eq(`${size}: on the triage run`, (await readAutoStart(issuePath, runId))?.startedRunId, 'next-1')
      await routeAutoStart({ project: 'p', issueId: 'plain', issuePath, runId }, deps)
      t.eq(`${size}: never twice`, started.length, 1)
    }

    const off = await triageOnDisk({ autoStart: false })
    let calls = 0
    const counting = { getIssue: async () => plain, startOperator: async () => { calls++; return { runId: 'x', status: 'running' } } }
    t.eq('autoStart off: nothing routed', await routeAutoStart({ project: 'p', issueId: 'plain', ...off }, counting), null)
    t.eq('and nothing recorded', await readAutoStart(off.issuePath, off.runId), null)
    for (const verdict of ['needs-owner-input', 'too-large']) {
      const held = await triageOnDisk({ verdict })
      const record = await routeAutoStart({ project: 'p', issueId: 'plain', ...held }, counting)
      t.eq(`${verdict}: recorded, nothing started`, [record.decision, record.reason], ['none', `verdict:${verdict}`])
    }
    t.eq('no start in any of them', calls, 0)
  }

  t.section('4. refused automatically: an assess-only report, an open dependency')
  {
    const reporters = { relay: { project: 'p', policy: { fault: 'any', request: 'assess' } } }
    const reported = { id: 'feature', project: 'p', report: { kind: 'request', reporter: 'relay', trust: 'request' }, sizing: sizing('minor') }
    const waiting = { id: 'second', project: 'p', dependsOn: { issues: [{ project: 'p', id: 'first' }] }, sizing: sizing('major') }
    for (const [label, issue, code] of [['an assess-only report', reported, 'report-trust'], ['an open dependency', waiting, 'dependencies']]) {
      const { issuePath, runId } = await triageOnDisk({ size: issue.sizing.size })
      let calls = 0
      const deps = { getIssue: async () => issue, reporters, read: async () => ({ id: 'first', name: 'First' }), startOperator: async () => { calls++; return { runId: 'x', status: 'running' } } }
      const record = await routeAutoStart({ project: 'p', issueId: issue.id, issuePath, runId }, deps)
      t.eq(`${label}: refused by the start admission`, [record.refusal?.by, record.refusal?.code, calls], ['start-admission', code, 0])
      await routeAutoStart({ project: 'p', issueId: issue.id, issuePath, runId }, deps)
      t.eq(`${label}: recorded once, never retried`, [calls, (await readAutoStart(issuePath, runId))?.refusal?.code], [0, code])
      t.eq(`${label}: the recommendation is still offered on the issue`, issue.sizing.recommendedPlaybook, issue.sizing.size === 'minor' ? 'prompt' : 'plan-and-implement')
    }
  }

  t.section('5. a triage the supervisor started goes through its start gate')
  {
    const plain = { id: 'plain', project: 'p' }
    const { issuePath, runId } = await triageOnDisk({ size: 'major', supervisorLaunchId: 'launch-1' })
    const gated = []
    const record = await routeAutoStart({ project: 'p', issueId: 'plain', issuePath, runId }, {
      getIssue: async () => plain,
      startOperator: async () => { throw new Error('the operator path was taken') },
      supervisorGate: async (a) => { gated.push(a); return { runId: 'next', status: 'preflighting' } }
    })
    t.eq('the gate starts it', [gated[0]?.playbook, record.startedRunId, record.launchedBy], ['plan-and-implement', 'next', 'supervisor'])
    const orphan = await triageOnDisk({ size: 'minor', supervisorLaunchId: 'launch-2' })
    const none = await routeAutoStart({ project: 'p', issueId: 'plain', ...orphan }, { getIssue: async () => plain, startOperator: async () => { throw new Error('operator path') } })
    t.eq('without a supervisor attached, nothing starts and it says so', [none.startedRunId ?? null, none.refusal?.code], [null, 'no-supervisor'])

    // The gate itself: refused outside an activation; inside one, start_run's own
    // gate (session limits, ledger reservation, ownership) launches it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-autostart-'))
    const started = []
    // The run the gate starts ends before shutdown, or a stop ends it: shutdown
    // waits for owned runs to leave a live status.
    let runStatus = 'running'
    const adapter = { invoke: async (args) => ({ session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } }) }
    const tools = {
      projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [],
      getIssue: async () => ({ issue: plain, reports: [], runs: [] }),
      preview: async (a) => ({ ok: true, configHash: `h-${a.playbook}`, tactic: 'implementation', limits: { budgets: { maxCostUsd: 2 } } }),
      start: async (a) => { started.push(a); return { runId: `r${started.length}`, status: 'running' } },
      getRun: async () => ({ status: runStatus, outcome: runStatus === 'running' ? null : 'resolved' }),
      stop: async () => { runStatus = 'cancelled'; return { stopped: true } }
    }
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    let refused = null
    try { await agent.autoStart({ project: 'p', issueId: 'plain', playbook: 'prompt', triageRunId: 't1' }) } catch (error) { refused = error }
    t.eq('refused while the supervisor is not running', [refused?.status, started.length], [409, 0])
    await agent.start({ model: 'm', projects: ['p'], message: 'go', limits: { maxCalls: 20, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => ['active'].includes(agent.get().status))
    const run = await agent.autoStart({ project: 'p', issueId: 'plain', playbook: 'prompt', triageRunId: 't1' })
    t.eq('started through the gate, with a launch id', [run.runId, started[0]?.playbook, Boolean(started[0]?.launchId)], ['r1', 'prompt', true])
    const ledger = (await fs.readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
    t.ok('the start holds a ledger reservation for its configured ceiling', ledger.some((l) => l.kind === 'reserve' && l.subject === 'run-start' && l.meta?.playbook === 'prompt' && l.reservedUsdMicros === 2000000), JSON.stringify(ledger))
    runStatus = 'completed'
    await agent.shutdown()
    t.ok('the supervisor shuts down', true)
    await fs.rm(dir, { recursive: true, force: true })
  }
}
