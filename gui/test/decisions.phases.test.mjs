import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAdvisor } from '../server/decisions/advisor.mjs'
import { createPregate, proposalsOf } from '../server/decisions/pregate.mjs'
import { createFailureAdvisor } from '../server/decisions/failure-advisor.mjs'
import { alwaysWakes } from '../server/decisions/wake-filter.mjs'
import { triageRequest, triageAgreement, GATE_OF_DISPOSITION, HOLD_STEP } from '../server/decisions/triage-shadow.mjs'
import { createLedger } from '../server/runtime/ledger.mjs'
import { ProcessError } from '../server/runtime/process.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { fakeOracle } from './fakes/decision-oracle.mjs'

/*
 * Every rollout phase of docs/decisions.md, wired as the server wires it, with
 * the provider replaced by the scripted oracle: `npm test` may not reach the
 * network or spend money. The real provider is exercised by
 * `DEVPANEL_LIVE=1 npm run live -- --jev-integration`, which sends each phase's
 * real questions.
 */

export const name = 'advisory decisions — pre-gate, agreement, wake filter and failure second opinion'

const NL = String.fromCharCode(10)
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')
const temps = []
const temp = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(d); return d }
const wait = async (test, ms = 4000) => { const end = Date.now() + ms; while (!(await test())) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const refusal = async (fn) => { try { await fn(); return null } catch (error) { return error } }

const CONFIG = {
  id: 'jev', model: 'jev-latest', threshold: 0.9, hash: 'test',
  pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 }, maxCallCostUsd: 0.01
}

async function ledgerIn () {
  const ledger = createLedger({ file: path.join(await temp('decisions-ledger-'), 'ledger.jsonl') })
  await ledger.load()
  return ledger
}

/** An advisor over a scripted oracle and a real ledger, as index.js builds one over the real provider. */
async function advisorWith (script, { config = CONFIG } = {}) {
  const ledger = await ledgerIn()
  const oracle = fakeOracle(script)
  return { ledger, oracle, advisor: createAdvisor({ spending: () => ({ ledger }), loadProvider: async () => config, createOracle: () => oracle }) }
}

/** A supervisor over the fixture's project, with the fake runtime answering every seat. */
async function supervisorFor (f, options) {
  const projectsDir = path.join(f.issuesDir, 'projects')
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project')).catch(() => {})
  const state = await temp('decisions-state-')
  const control = path.join(state, 'control.json')
  await fs.writeFile(control, JSON.stringify({ ledger: path.join(state, 'ledger.jsonl'), delayMs: 0 }))
  process.env.DEVPANEL_FAKE_CONTROL = control
  await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(HARNESS_MODULE)}` + NL)
  process.env.DEVPANEL_PROJECTS_DIR = projectsDir
  const { createSupervisor } = await import('../server/supervisor.mjs')
  return createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot, ...options })
}

const runsOf = async (issuePath) => (await fs.readdir(path.join(issuePath, 'runs')).catch(() => [])).filter((n) => !/^(worktree|workspace)-/.test(n) && !n.startsWith('.'))

export default async function (t) {
  const projectsDirBefore = process.env.DEVPANEL_PROJECTS_DIR
  const controlBefore = process.env.DEVPANEL_FAKE_CONTROL
  const P = 'devpanel-project'

  const f = await engineFixture({ playbook: 'triage' })
  await f.issues.createStep(P, f.issue.id, { name: 'report', text: 'The login page returns 500 after the upgrade.', format: 'md' })

  t.section('1. what the pre-gate sends: the issue and its reports, never its priority or a hold note')
  {
    await f.issues.setIssuePriority(P, f.issue.id, { value: 'urgent', reason: 'operator says so' })
    const { state, questions } = await triageRequest({ issues: f.issues, project: P, issueId: f.issue.id })
    t.eq('the title', state.issue.title, 'Engine fixture')
    t.ok('the filed report', state.reports.some((r) => r.text.includes('returns 500')), JSON.stringify(state.reports))
    t.ok('no priority anywhere in the state', !JSON.stringify(state).includes('urgent'))
    t.eq('gate, playbook, priority and work time are asked', Object.keys(questions).sort(), ['gate', 'playbook', 'priority', 'workTime'])
    t.eq('work time is an ordered rubric of the seven bands', [questions.workTime.type, questions.workTime.criteria.length], ['score', 7])
    t.eq('the gate options are the agreed three', Object.keys(questions.gate.criteria), ['continue', 'close-issue', 'needs-input'])
    t.ok('without another issue there is no duplicate question (a choice needs two options)', !questions.duplicateOf)
    await f.issues.createStep(P, f.issue.id, { name: HOLD_STEP, text: 'Held before Triage.', format: 'md' })
    const after = await triageRequest({ issues: f.issues, project: P, issueId: f.issue.id })
    t.ok('a hold note is never sent back as part of the report', !after.state.reports.some((r) => r.text.includes('Held before')))
    t.eq('so adding one does not change the question', after.state, state)
  }

  t.section('2. the advisor: nothing is asked without a provider or without the ledger')
  {
    const oracle = fakeOracle([])
    const ledger = await ledgerIn()
    const q = { gate: { type: 'noul', instructions: 'x' } }
    const dir = await temp('decisions-dir-')
    t.eq('no provider configured', await createAdvisor({ spending: () => ({ ledger }), loadProvider: async () => null, createOracle: () => oracle }).ask({ dir, purpose: 'x', state: 's', questions: q }), { skipped: 'not-configured' })
    t.eq('no ledger', await createAdvisor({ spending: () => null, loadProvider: async () => CONFIG, createOracle: () => oracle }).ask({ dir, purpose: 'x', state: 's', questions: q }), { skipped: 'no-ledger' })
    t.eq('neither called the provider', oracle.calls.length, 0)
    const { advisor, ledger: l2 } = await advisorWith([{}])
    const record = await advisor.ask({ dir, purpose: 'x', state: 's', questions: q })
    t.eq('with both, it asks and records', record.status, 'answered')
    t.eq('on the ledger', l2.usage().day.decisions, 1)
  }

  t.section('3. a confident close holds the Triage start, before anything is reserved')
  {
    const other = await f.issues.createIssue(P, { name: 'Login broken since upgrade' })
    const { advisor, oracle } = await advisorWith([{ pick: { gate: 'close-issue', duplicateOf: other.id, priority: 'high', playbook: 'implementation' } }])
    const pregate = createPregate({ issues: f.issues, advisor })
    const supervisor = await supervisorFor(f, { pregate })
    const held = await refusal(() => supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot }))
    t.eq('refused with the hold', [held?.status, held?.code, held?.started, held?.resolvableBy], [409, 'PREGATE_HOLD', false, 'operator'])
    t.eq('naming what the provider judged', held?.pregate.gate, 'close-issue')
    t.eq('no run was reserved', await runsOf(f.issue.path), [])
    t.eq('the proposals name the duplicate', held?.pregate.proposals.map((p) => p.id), ['close-duplicate', 'playbook'])
    t.ok('a priority is not proposed over one a person set', !held?.pregate.proposals.some((p) => p.id === 'priority'))

    const again = await refusal(() => supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot }))
    t.eq('the same report is held again from its record, without asking', [again?.code, oracle.calls.length], ['PREGATE_HOLD', 1])

    const noReason = await refusal(() => supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot, pregateOverride: { by: 'operator', reason: ' ' } }))
    t.eq('starting past it needs a reason', noReason?.status, 400)
    const notOperator = await refusal(() => supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot, pregateOverride: { by: 'supervisor', reason: 'because' } }))
    t.eq('and an operator', notOperator?.status, 403)

    // What Start anyway is checked against before it is sent (pregate.current), and the server's own check of the key.
    const now = await pregate.current({ project: P, issueId: f.issue.id })
    t.eq('current: the hold a start would meet now, asking nobody', [now.configured, now.recorded, now.holds, now.gate, now.key === held?.pregate.key, oracle.calls.length], [true, true, true, 'close-issue', true, 1])
    const recorded = (await fs.readdir(path.join(f.issue.path, 'decisions'))).filter((n) => /^triage-pregate-[^.]+\.json$/.test(n))
    t.eq('its key is the one the ask recorded under', recorded, [`triage-pregate-${now.key.slice(0, 16)}.json`])
    const wrongKey = await refusal(() => supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot, pregateOverride: { by: 'operator', reason: 'because', expectKey: 'another-hold' } }))
    t.eq('an override naming another hold is refused, with the hold in force', [wrongKey?.status, wrongKey?.code, wrongKey?.pregate?.key === now.key], [409, 'PREGATE_CHANGED', true])
    t.eq('and nothing was reserved', await runsOf(f.issue.path), [])
    const unconfigured = createPregate({ issues: f.issues, advisor: createAdvisor({ spending: () => null, loadProvider: async () => null, createOracle: () => oracle }) })
    t.eq('without a provider nothing holds', await unconfigured.current({ project: P, issueId: f.issue.id }), { configured: false, holds: false, reason: 'not-configured' })

    const started = await supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot, pregateOverride: { by: 'operator', reason: 'the other issue is a different page', expectKey: now.key } })
    await supervisor.settle()
    const dir = path.join(f.issue.path, 'runs', started.runId, 'decisions')
    const override = JSON.parse(await fs.readFile(path.join(dir, 'pregate-override.json'), 'utf8'))
    t.eq('an operator override starts the run and is kept with it', [override.by, override.reason, override.held.gate], ['operator', 'the other issue is a different page', 'close-issue'])
    t.ok('beside the record it overrode', (await fs.readdir(dir)).some((n) => n.startsWith('triage-pregate-')))
    t.eq('still one call', oracle.calls.length, 1)
    t.ok('an override naming the hold in force starts', Boolean(started.runId))

    // A note changes what the pre-gate would be asked: the shown hold no longer applies.
    await f.issues.createStep(P, f.issue.id, { name: 'note', text: 'It is a different page after all.', format: 'md' })
    const afterNote = await pregate.current({ project: P, issueId: f.issue.id })
    t.eq('after a note the key moves and nothing is recorded under it', [afterNote.key !== now.key, afterNote.recorded, afterNote.holds, afterNote.reason], [true, false, null, 'not-asked'])
    t.eq('current asked nobody', oracle.calls.length, 1)
    const runsBefore = (await runsOf(f.issue.path)).length
    const noHold = await refusal(() => supervisor.start({ project: P, issueId: f.issue.id, playbookId: 'triage', configRoot: f.configRoot, pregateOverride: { by: 'operator', reason: 'because', expectKey: now.key } }))
    t.eq('Start anyway when no hold applies any more is refused, nothing reserved', [noHold?.status, noHold?.code, (await runsOf(f.issue.path)).length], [409, 'PREGATE_CHANGED', runsBefore])

    const report = await triageAgreement({ issues: f.issues, threshold: 0.9 })
    const row = report.rows.find((r) => r.runId === started.runId)
    t.eq('the agreement report reads the overridden start', row?.override?.reason, 'the other issue is a different page')
    t.eq('scored against what Triage found', [row?.triage.disposition, row?.questions.gate.expected, row?.questions.gate.agree], ['no-findings', GATE_OF_DISPOSITION['no-findings'], true])
    t.eq('the duplicate against the disposition', [row?.questions.duplicateOf.expected, row?.questions.duplicateOf.agree], ['none', false])
    t.eq('priority against the one in force', [row?.questions.priority.expected, row?.questions.priority.agree], ['urgent', false])
    t.eq('rates carry of and total', Object.keys(report.summary.gate.confident), ['of', 'total'])
    await f.issues.setIssueArchived(P, other.id, true, { overrideReason: 'test' }).catch(() => {})
  }

  t.section('4. below the threshold, or without the provider, a Triage start goes ahead as before')
  {
    const g = await engineFixture({ playbook: 'triage' })
    await g.issues.createStep(P, g.issue.id, { name: 'report', text: 'Something about the admin page.', format: 'md' })
    const { advisor } = await advisorWith([{ pick: { gate: 'close-issue' }, confidence: 0.6 }])
    const supervisor = await supervisorFor(g, { pregate: createPregate({ issues: g.issues, advisor }) })
    const started = await supervisor.start({ project: P, issueId: g.issue.id, playbookId: 'triage', configRoot: g.configRoot })
    await supervisor.settle()
    const run = JSON.parse(await fs.readFile(path.join(g.issue.path, 'runs', started.runId, 'run.json'), 'utf8'))
    t.eq('a close at 0.6 does not hold', run.status, 'completed', run.blockedReason)
    t.ok('and its record is kept beside the run', (await fs.readdir(path.join(g.issue.path, 'runs', started.runId, 'decisions'))).some((n) => n.startsWith('triage-pregate-')))

    const down = await advisorWith([{ fail: { class: 'transient', charged: 'unknown' } }])
    await g.issues.createStep(P, g.issue.id, { name: 'more', text: 'It happens on every page load.', format: 'md' })
    const supervisor2 = await supervisorFor(g, { pregate: createPregate({ issues: g.issues, advisor: down.advisor }) })
    const second = await supervisor2.start({ project: P, issueId: g.issue.id, playbookId: 'triage', configRoot: g.configRoot })
    await supervisor2.settle()
    t.ok('a provider that is down does not hold either', Boolean(second.runId))

    const review = await g.issues.createIssue(P, { name: 'Not a triage' })
    const spy = { check: async () => { throw new Error('asked for a non-triage run') }, attach: async () => null }
    const supervisor3 = await supervisorFor(g, { pregate: spy })
    const other = await supervisor3.start({ project: P, issueId: review.id, playbookId: 'implementation', configRoot: g.configRoot })
    await supervisor3.settle()
    t.ok('a non-triage start never asks', Boolean(other.runId))
  }

  t.section('5. an operator confirms a proposal; the proposal is re-derived from the record, never taken from the request')
  {
    const h = await engineFixture({ playbook: 'triage' })
    await h.issues.createStep(P, h.issue.id, { name: 'report', text: 'Please make the logo bigger.', format: 'md' })
    const dup = await h.issues.createIssue(P, { name: 'Bigger logo' })
    const { advisor } = await advisorWith([{ pick: { gate: 'close-issue', duplicateOf: dup.id, priority: 'low', playbook: 'implementation' } }])
    const pregate = createPregate({ issues: h.issues, advisor })
    const record = await pregate.assess({ project: P, issueId: h.issue.id })
    const latest = await pregate.latest({ project: P, issueId: h.issue.id })
    t.eq('the newest assessment is read back with its proposals', latest.proposals.map((p) => p.id), ['close-duplicate', 'priority', 'playbook'])

    const forged = await refusal(() => pregate.confirm({ project: P, issueId: h.issue.id, key: record.key, proposalId: 'needs-input' }))
    t.eq('a proposal the record does not support is refused', forged?.status, 409)
    const advisory = await refusal(() => pregate.confirm({ project: P, issueId: h.issue.id, key: record.key, proposalId: 'playbook' }))
    t.eq('the playbook suggestion is not confirmable here', advisory?.status, 409)
    const badKey = await refusal(() => pregate.confirm({ project: P, issueId: h.issue.id, key: '0'.repeat(64), proposalId: 'priority' }))
    t.eq('an unknown record is not found', badKey?.status, 404)

    const priority = await pregate.confirm({ project: P, issueId: h.issue.id, key: record.key, proposalId: 'priority' })
    t.eq('confirming the priority sets it, as the operator', [priority.issue.priority.value, priority.issue.priority.by], ['low', 'operator'])
    t.ok('citing the decision it rests on', priority.issue.priority.reason.includes(record.key.slice(0, 16)))
    const twice = await pregate.confirm({ project: P, issueId: h.issue.id, key: record.key, proposalId: 'priority' })
    t.eq('a second confirmation applies nothing', [twice.applied, twice.issue.priorityHistory.length], [false, 1])

    const closed = await pregate.confirm({ project: P, issueId: h.issue.id, key: record.key, proposalId: 'close-duplicate' })
    t.eq('confirming the duplicate records the disposition', closed.issue.disposition.value, 'duplicate')
    t.ok('naming the issue it duplicates', closed.issue.disposition.evidence.includes(dup.id))
    t.eq('and linking it', closed.issue.disposition.related, [{ project: P, id: dup.id }])
    t.eq('both confirmations are on record', (await pregate.latest({ project: P, issueId: h.issue.id })).confirmations.map((c) => c.proposalId).sort(), ['close-duplicate', 'priority'])

    const n = await engineFixture({ playbook: 'triage' })
    await n.issues.createStep(P, n.issue.id, { name: 'report', text: 'It is broken.', format: 'md' })
    const vague = await advisorWith([{ pick: { gate: 'needs-input' } }, { pick: { gate: 'continue' } }])
    const pg = createPregate({ issues: n.issues, advisor: vague.advisor })
    const asked = await pg.assess({ project: P, issueId: n.issue.id })
    t.eq('needs-input is proposed as a hold, beside the rest', proposalsOf(asked, n.issue).map((p) => p.id), ['needs-input', 'priority', 'playbook'])
    await pg.confirm({ project: P, issueId: n.issue.id, key: asked.key, proposalId: 'needs-input' })
    const steps = (await n.issues.getIssue(P, n.issue.id)).steps.map((s) => s.slug)
    t.ok('confirming it adds the hold note to the issue', steps.includes(HOLD_STEP), steps.join())
    await n.issues.createStep(P, n.issue.id, { name: 'details', text: 'The export button on /reports gives a blank CSV since Monday.', format: 'md' })
    const reassessed = await pg.assess({ project: P, issueId: n.issue.id })
    t.ok('new material is a new question, asked again', reassessed.key !== asked.key && vague.oracle.calls.length === 2)
  }

  t.section('6. the wake filter: routine events are held and ride with the next wake; nothing that matters is held')
  {
    t.eq('user messages always wake', alwaysWakes({ type: 'user' }), true)
    t.eq('a failed run always wakes', alwaysWakes({ type: 'run-changed', run: { status: 'failed' } }), true)
    t.eq('a paused run (operator request or question) always wakes', alwaysWakes({ type: 'run-changed', run: { status: 'paused' } }), true)
    t.eq('an unresolved ending (budgets, disagreement) always wakes', alwaysWakes({ type: 'run-changed', run: { status: 'completed', outcome: 'unresolved' } }), true)
    t.eq('a model substitution after a quota failure always wakes', alwaysWakes({ type: 'model-substituted' }), true)
    t.eq('an event type the filter does not know always wakes', alwaysWakes({ type: 'something-new' }), true)
    t.eq('a run moving to running may be held', alwaysWakes({ type: 'run-changed', run: { status: 'running' } }), false)
    t.eq('so may an issue list change', alwaysWakes({ type: 'issues-changed' }), false)

    const dir = await temp('decisions-sup-')
    const invocations = []
    const issues = [{ id: 'issue', status: 'open', name: 'one' }]
    const adapter = { invoke: async (args) => { invocations.push(args); return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } } } }
    const tools = {
      projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => issues,
      getIssue: async () => ({}), preview: async () => ({ ok: true, configHash: 'h' }), start: async () => ({ runId: 'r', status: 'running' }),
      getRun: async () => ({ status: 'running' }), stop: async () => {}, addNote: async () => ({}), createIssue: async () => ({}), archive: async () => ({})
    }
    const oracle = fakeOracle([{ pick: { wake: 'defer' } }, { pick: { wake: 'wake' } }])
    const agent = await createTopSupervisor({
      dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20,
      decisions: ({ spending }) => createAdvisor({ spending, loadProvider: async () => CONFIG, createOracle: () => oracle })
    })
    await agent.start({ model: 'm', projects: ['one-project'], message: 'Work through the backlog.', limits: { maxCalls: 10, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 1 } })
    await wait(() => invocations.length === 1 && agent.get().status === 'active')

    issues.push({ id: 'issue-2', status: 'open', name: 'routine' })
    await wait(() => (agent.get().deferred?.length ?? 0) === 1)
    await new Promise((r) => setTimeout(r, 150))
    t.eq('a confidently routine change is held, not sent', invocations.length, 1)
    t.ok('recorded before it was acted on', (await fs.readdir(path.join(dir, 'decisions'))).some((n) => n.startsWith('wake-filter-')))
    t.eq('the provider saw the mission', oracle.calls[0].state.mission, 'Work through the backlog.')
    t.eq('and the decision is on the supervisor\'s own ledger', agent.get().spending.ledger.entries >= 2, true)

    issues.push({ id: 'issue-3', status: 'open', name: 'important' })
    await wait(() => invocations.length === 2)
    const event = JSON.parse(invocations[1].prompt).event
    t.eq('the next waking event is delivered', event.type, 'issues-changed')
    t.eq('carrying what was held', event.deferred?.map((d) => d.event.type), ['issues-changed'])
    t.eq('and nothing stays held', agent.get().deferred.length, 0)
    await agent.stop(); await agent.shutdown()

    const dir2 = await temp('decisions-sup-')
    const inv2 = []
    const issues2 = [{ id: 'issue', status: 'open', name: 'one' }]
    const agent2 = await createTopSupervisor({
      dir: dir2, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }],
      adapter: { invoke: async (args) => { inv2.push(args); return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } } } },
      tools: { ...tools, listIssues: async () => issues2 }, pollMs: 20, maxDeferMs: 100,
      decisions: ({ spending }) => createAdvisor({ spending, loadProvider: async () => CONFIG, createOracle: () => fakeOracle([{ pick: { wake: 'defer' } }]) })
    })
    await agent2.start({ model: 'm', projects: ['one-project'], message: 'go', limits: { maxCalls: 10, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 1 } })
    await wait(() => inv2.length === 1 && agent2.get().status === 'active')
    issues2.push({ id: 'issue-2', status: 'open', name: 'routine' })
    await wait(() => inv2.length === 2)
    const late = JSON.parse(inv2[1].prompt).event
    t.eq('nothing is held for ever: past the limit it wakes on its own', [late.type, late.deferred?.length], ['deferred-events', 1])
    await agent2.stop(); await agent2.shutdown()
  }

  t.section('7. a failure no rule recognises gets a second opinion, which may only call it temporary')
  {
    const run = async (script, stderr) => {
      const e = await engineFixture()
      let calls = 0
      const invoke = async (args) => {
        if (args.meta.stepId === 'implement' && calls++ < 1) throw new ProcessError('claude exited 1', { kind: 'runtime-error', code: 1, stderr, invocationId: args.meta.invocationId })
        return e.fake.invoke(args)
      }
      const engine = await startRun({
        playbookId: e.playbookId, issue: { project: P, id: e.issue.id },
        issuePath: e.issuePath, projectPath: e.projectPath, harnesses: { fake: { ...e.fake, invoke } }, stepStore: e.stepStore,
        workspaceProvider: e.workspaceProvider, configRoot: e.configRoot, probe: e.probe, clock: e.clock, deliveryProvider: e.delivery
      })
      const { advisor, oracle } = await advisorWith(script)
      engine.failureAdvisor = createFailureAdvisor({ advisor })
      let thrown = null
      try { await engine.drive() } catch (error) { thrown = error }
      await releaseWorkspace(engine)
      return { engine, oracle, thrown, e }
    }

    const temporary = await run([{ pick: { class: 'transient' } }], 'stream disconnected before completion')
    const first = temporary.engine.run.failures[0]
    t.eq('a confident "transient" retries the turn', [first.class, first.retried], ['transient', true])
    t.eq('with the second opinion on the record', [first.reclassification.from, first.reclassification.to, first.reclassification.answer], ['runtime', 'transient', 'transient'])
    t.eq('and the run went on', temporary.engine.run.status, 'completed', temporary.engine.run.blockedReason)
    t.ok('the decision is recorded under the run', (await fs.readdir(path.join(temporary.e.issuePath, 'runs', temporary.engine.runId, 'decisions'))).some((n) => n.startsWith('failure-reclass-')))
    t.eq('quota and auth are never offered', Object.keys(temporary.oracle.calls[0].questions.class.criteria), ['runtime', 'transient', 'rate-limit'])

    const unsure = await run([{ pick: { class: 'transient' }, confidence: 0.7 }], 'something odd happened')
    t.eq('below the threshold the failure stands', [unsure.engine.run.failure?.class, unsure.engine.run.failures[0].retried], ['runtime', false])
    t.eq('and says why', [unsure.engine.run.failures[0].reclassification.to, unsure.engine.run.failures[0].reclassification.confidence], [null, 0.7])

    const defect = await run([{ pick: { class: 'runtime' } }], 'TypeError: x is not a function')
    t.eq('a confident "runtime" fails the run as before', defect.engine.run.failure?.class, 'runtime')

    const known = await run([], 'API Error: 429 Too Many Requests')
    t.eq('a failure a rule recognised is never asked about', known.oracle.calls.length, 0)
  }

  t.section('8. the availability page: the provider is held and cleared like a model, and holds itself when refused')
  {
    const { createAvailabilityStore } = await import('../server/runtime/failure.mjs')
    const { createAdvisor: advisorFor, decisionProviderStatus, decisionAvailabilityId } = await import('../server/decisions/advisor.mjs')
    const { availabilityReport } = await import('../server/availability-api.mjs')
    const store = createAvailabilityStore(path.join(await temp('decisions-avail-'), 'a.json'))
    const ledger = await ledgerIn()
    const dir = await temp('decisions-dir-')
    const q = { ok: { type: 'noul', instructions: 'x' } }
    const id = decisionAvailabilityId('jev')

    const held = fakeOracle([{}])
    await store.recordExhausted({ modelId: id, reason: 'operator hold', until: new Date(Date.now() + 3_600_000).toISOString(), actor: 'tester' })
    const heldAdvisor = advisorFor({ spending: () => ({ ledger }), availability: () => store, loadProvider: async () => CONFIG, createOracle: () => held })
    const skipped = await heldAdvisor.ask({ dir, purpose: 'x', state: 'a', questions: q })
    t.eq('an operator hold stops every ask', [skipped.skipped, held.calls.length], ['held', 0])
    await store.clear(id)
    t.eq('clearing it lets the next ask through', (await heldAdvisor.ask({ dir, purpose: 'x', state: 'b', questions: q })).status, 'answered')
    t.eq('which the page reports as the last call', heldAdvisor.lastOutcome().status, 'answered')

    const refused = advisorFor({ spending: () => ({ ledger }), availability: () => store, loadProvider: async () => CONFIG, createOracle: () => fakeOracle([{ fail: { class: 'auth', charged: 'no', message: 'HTTP 401: bad key' } }]) })
    await refused.ask({ dir, purpose: 'x', state: 'c', questions: q })
    const hold = await store.check(id)
    t.ok('a rejected key holds the provider for every caller', /key refused/.test(hold?.reason ?? ''), hold?.reason)
    t.eq('as an assumed hold, since nobody said for how long', hold?.assumed, true)
    await store.clear(id)

    const limited = advisorFor({ spending: () => ({ ledger }), availability: () => store, loadProvider: async () => CONFIG, createOracle: () => ({ id: 'jev', model: 'jev-latest', ask: async () => { const { DecisionError } = await import('../server/decisions/jev.mjs'); throw new DecisionError('rate-limit', 'HTTP 429', { charged: 'no', retryAfterMs: 120_000 }) } }) })
    await limited.ask({ dir, purpose: 'x', state: 'd', questions: q })
    const rate = await store.check(id)
    t.eq('a rate limit holds it for the provider\'s retry-after', [Boolean(rate), rate?.assumed], [true, false])
    await store.clear(id)
    const transient = advisorFor({ spending: () => ({ ledger }), availability: () => store, loadProvider: async () => CONFIG, createOracle: () => fakeOracle([{ fail: { class: 'transient', charged: 'unknown' } }]) })
    await transient.ask({ dir, purpose: 'x', state: 'e', questions: q })
    t.eq('a transient fault holds nothing', await store.check(id), null)

    const home = await temp('decisions-home-')
    await fs.mkdir(path.join(home, '.config', 'typesafe'), { recursive: true })
    const keyFile = path.join(home, '.config', 'typesafe', 'key')
    await fs.writeFile(keyFile, 'apik_secret_value_1234567890\n', { mode: 0o600 })
    const status = await decisionProviderStatus({ loadProvider: async () => ({ ...CONFIG, credentialRef: `file:${keyFile}`, endpoint: 'https://example.invalid' }), store, advisors: [heldAdvisor], usage: ledger.usage() })
    t.eq('the page row says the key is usable', [status[0].id, status[0].credential.ok, status[0].state], [id, true, 'available'])
    t.ok('and never what it is', !JSON.stringify(status).includes('apik_secret_value'))
    t.eq('with the calls counted from the ledger', status[0].usage.today >= 2, true)
    const missing = await decisionProviderStatus({ loadProvider: async () => ({ ...CONFIG, credentialRef: `file:${path.join(home, 'none')}` }), store })
    t.eq('an unreadable key is shown as unusable', [missing[0].credential.ok, missing[0].state], [false, 'unconfigured'])

    await store.recordExhausted({ modelId: id, reason: 'operator hold', until: new Date(Date.now() + 3_600_000).toISOString(), actor: 'tester' })
    const report = await availabilityReport({ store, configRoot: f.configRoot, decisionProviders: async () => ['row'] })
    t.ok('the provider\'s hold is not listed as a stray model', !report.models.some((m) => m.id === id))
    t.eq('it has its own section', report.decisionProviders, ['row'])
  }

  process.env.DEVPANEL_PROJECTS_DIR = projectsDirBefore ?? ''
  if (projectsDirBefore == null) delete process.env.DEVPANEL_PROJECTS_DIR
  if (controlBefore == null) delete process.env.DEVPANEL_FAKE_CONTROL
  else process.env.DEVPANEL_FAKE_CONTROL = controlBefore
  await cleanupFixtures()
  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}
