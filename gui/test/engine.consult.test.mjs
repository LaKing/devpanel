import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, cleanupFixtures, blocking, simulateProcessDeath } from './fakes/fixture.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import * as store from '../server/runtime/store.mjs'
import { ownerLossRecoverable } from '../server/runtime/run-control.mjs'
import { supportedActions, LIVE_STATUSES } from '../server/supervisor.mjs'

export const name = 'engine — a question goes to the consult panel before a person is asked'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)

const launch = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

const hold = (over = {}) => ({ id: 'H1', question: 'May the checker open a second frozen list?', category: 'documented-promise', reason: 'A rule says the list never grows.', recommendation: 'Open a separate shrink-only list.', ...over })
const plan = (holds = null) => `A plan.${NL}${fence({ summary: 'the plan', basedOnRevision: null, resolves: [], ...(holds ? { ownerHolds: holds } : {}) })}`
const ran = (run, stepId) => run.steps.filter((s) => s.stepId === stepId).length
const decisions = (run) => run.steps.filter((s) => s.role === 'operator' && s.decision).map((s) => s.decision)
const request = (category, over = {}) => ({ question: 'Which layer takes the fix?', reason: 'Both would work and the evidence here cannot tell.', category, recommendation: 'Fix it in the framework.', ...over })

const PANEL = { enabled: true, maxPerRun: 6, maxTechnicalPerRun: 3, alwaysHuman: ['authorization'] }
const opinions = [
  { seat: 'consultant-1', model: 'fable-5-2', effort: 'medium', round: 1, verdict: 'answer', choice: 'recommended', answer: 'As recommended.', conditions: ['keep the old list'], confidence: 'high', reasoning: 'Read it.', evidence: [{ location: 'a.mjs:1', observation: 'says so' }] },
  { seat: 'consultant-2', model: 'gpt-6-astra', effort: 'medium', round: 1, verdict: 'answer', choice: 'recommended', answer: 'As recommended.', conditions: [], confidence: 'high', reasoning: 'Read it too.', evidence: [{ location: 'b.mjs:2', observation: 'agrees' }] }
]
const brief = { question: 'Bővülhet a lista?', why: 'Ettől függ, élesedik-e az ellenőrzés.', options: [{ label: 'Igen', consequence: 'A régiek listára kerülnek.' }, { label: 'Nem', consequence: 'Most kell javítani őket.' }], recommendation: 'Igen.', by: 'consultant-1', positions: [{ seat: 'consultant-1', choice: 'recommended' }, { seat: 'consultant-2', choice: 'b' }] }

/** A panel that answers every request with `outcome(request)`, and keeps what it was asked and what it recorded. */
function fakePanel (outcome, { panel = PANEL } = {}) {
  const asked = []
  const records = new Map()
  const key = (r) => `${r.key}|${r.question}|${r.mode}`
  return {
    asked,
    panel: async () => panel,
    recorded: async (r) => records.get(key(r)) ?? null,
    consult: async (r, { signal } = {}) => {
      asked.push(r)
      const made = await outcome(r, { signal })
      const result = { id: `c${asked.length}`, rounds: 1, costUsd: 1, costUnknown: false, durationMs: 1000, opinions, ...made }
      records.set(key(r), result)
      return result
    }
  }
}
const resolved = () => ({ outcome: 'resolved', choice: 'recommended', answer: 'Open a separate shrink-only list.', conditions: ['keep the old list'], answerText: `Open a separate shrink-only list.${NL}${NL}Conditions:${NL}- keep the old list` })
const escalated = () => ({ outcome: 'escalated', reason: 'the seats chose differently', brief })

const planRun = async (turns, { consult = null, ...options } = {}) => {
  const fallback = scriptFor(options)
  const f = await engineFixture({ playbook: 'plan-and-implement', script: (turn) => turns[turn.stepId]?.(turn) ?? fallback(turn) })
  const engine = await launch(f)
  if (consult) engine.consult = consult
  return { engine, f }
}

export default async (t) => {
  t.section('1. an owner hold every seat answers the same way never reaches the owner')
  {
    const prompts = {}
    const panel = fakePanel(resolved)
    const { engine, f } = await planRun({ plan: () => plan([hold()]), implement: ({ prompt }) => { prompts.implement = prompt; return null } }, { consult: panel })
    const run = await engine.drive()
    t.eq('the run closed without a pause', `${run.status}/${run.outcome}`, 'completed/resolved')
    t.eq('the panel was asked once, to decide', panel.asked.map((r) => [r.key, r.mode, r.category, r.recommendation]), [['owner-hold:planner:H1', 'decide', 'documented-promise', hold().recommendation]])
    t.ok('it was told where the issue and the worktree are', path.isAbsolute(panel.asked[0].issueDir) && path.isAbsolute(panel.asked[0].worktree))
    const [d] = decisions(run)
    t.eq('its answer is the decision, with the conditions', [d.key, d.question, d.answer.includes('keep the old list')], ['owner-hold:planner:H1', hold().question, true])
    t.eq('attributed to the panel, with the consult on it', [d.actor, d.consult.id, d.consult.outcome, d.consult.opinions.length], ['consult panel (fable-5-2@medium + gpt-6-astra@medium)', 'c1', 'resolved', 2])
    t.ok('the hold reads answered', Boolean(run.ownerHolds['planner:H1'].answeredByStep))
    t.eq('the consult is on the run', [run.consults.c1.outcome, run.consults.c1.category, run.consulting ?? null], ['resolved', 'documented-promise', null])
    t.ok('the implementer is given the answer', prompts.implement?.includes('Open a separate shrink-only list.'))
    const step = run.steps.find((s) => s.decision)
    t.ok('the decision step shows both opinions with their evidence', step.response.includes('Decision by the consult panel') && step.response.includes('a.mjs:1') && step.response.includes('gpt-6-astra'))

    t.section('   …and it is all on disk')
    const stored = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
    t.eq('the stored run holds the decision step and the answered hold', [stored.status, stored.steps.filter((s) => s.decision?.consult).length, Boolean(stored.ownerHolds['planner:H1'].answeredByStep)], ['completed', 1, true])
    await releaseWorkspace(engine)
  }

  t.section('2. consultants who differ: the owner is asked, with the panel\'s question for a person')
  {
    const panel = fakePanel(escalated)
    const { engine, f } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    const run = await engine.drive()
    t.eq('paused on the same hold as before', [run.status, run.pause.kind, run.pause.key, run.pause.question], ['paused', 'owner-hold', 'owner-hold:planner:H1', hold().question])
    t.eq('with the plain question and what the panel said', [run.pause.brief.question, run.pause.consult.outcome, run.pause.consult.positions.length], [brief.question, 'escalated', 2])
    t.eq('no implementation ran', ran(run, 'implement'), 0)
    const again = await engine.drive()
    t.eq('a second drive neither asks the panel nor the owner again', [panel.asked.length, again.pause.id], [1, run.pause.id])
    const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath, takeLock: false })
    resumed.consult = panel
    t.eq('nor does an engine loaded from disk', [(await resumed.drive()).pause.id, panel.asked.length], [run.pause.id, 1])
    await engine.answer({ pauseId: run.pause.id, text: 'Yes.', actor: 'owner' })
    const done = await engine.drive()
    t.eq('the owner\'s answer releases it as before', [`${done.status}/${done.outcome}`, decisions(done)[0].actor, decisions(done)[0].consult ?? null], ['completed/resolved', 'owner', null])
    await releaseWorkspace(engine)
  }

  t.section('3. a panel that cannot be asked changes nothing')
  {
    const panel = fakePanel(() => ({ outcome: 'unavailable', reason: 'consultant-2: gpt-6-astra is unavailable', opinions: [] }))
    const { engine } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    const run = await engine.drive()
    t.eq('paused, saying the panel was unavailable', [run.status, run.pause.consult.outcome, run.pause.brief ?? null], ['paused', 'unavailable', null])
    await releaseWorkspace(engine)
  }
  {
    const panel = fakePanel(() => { throw new Error('boom') })
    const { engine } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    const run = await engine.drive()
    t.eq('a fault in the panel pauses for the owner, it never fails the run', [run.status, run.pause.kind], ['paused', 'owner-hold'])
    await releaseWorkspace(engine)
  }
  {
    const panel = fakePanel(resolved, { panel: { ...PANEL, enabled: false } })
    const { engine } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    const run = await engine.drive()
    t.eq('a panel switched off is not asked', [run.status, panel.asked.length], ['paused', 0])
    await releaseWorkspace(engine)
  }
  {
    const panel = fakePanel(resolved, { panel: { ...PANEL, maxPerRun: 1 } })
    const { engine } = await planRun({ plan: () => plan([hold(), hold({ id: 'H2', question: 'A second one?' })]) }, { consult: panel })
    const run = await engine.drive()
    t.eq('past the run\'s bound the next question goes to the owner', [run.status, panel.asked.length, run.pause.key], ['paused', 1, 'owner-hold:planner:H2'])
    await releaseWorkspace(engine)
  }

  t.section('3b. a consult with a seat whose interrupted guarded turn cannot be checked yet decides nothing (consult.mjs pendingRecovery; config-guard.mjs)')
  {
    let pending = true
    const asked = []
    const panel = {
      asked,
      panel: async () => PANEL,
      recorded: async () => null,   // the service caches nothing while a seat is pending
      consult: async (r) => {
        asked.push(r)
        if (pending) return { id: 'c1', outcome: 'unavailable', reason: 'consultant-1: an interrupted turn ran on fake-old, which cannot be loaded', pendingRecovery: true, unsettled: ['round-1/consultant-1'], rounds: 1, costUsd: null, costUnknown: false, durationMs: 10, opinions: [] }
        return { id: 'c1', rounds: 1, costUsd: 1, costUnknown: false, durationMs: 1000, opinions, ...resolved() }
      }
    }
    const { engine, f } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    let run = await engine.drive()
    const stored = async () => JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
    run = await stored()
    t.eq('no decision is recorded and no consult is finished on the run', [decisions(run).length, Object.keys(run.consults ?? {}).length], [0, 0])
    t.eq('the consult marker stays, and nothing went on', [run.consulting?.key, ran(run, 'implement')], ['owner-hold:planner:H1', 0])
    t.ok('the run waits on the public recovery action', ownerLossRecoverable(run) && run.recovery?.consultPending === true, JSON.stringify({ status: run.status, recovery: run.recovery }))
    t.eq('the supervisor offers recover', supportedActions(run), ['recover', 'abandon'])
    pending = false
    const out = await engine.recoverOwnerLoss()
    t.ok('recover resumes it', out.resumed, out.reason)
    run = await engine.drive()
    t.eq('it consults again, and the settled answer is the decision', [asked.length, `${run.status}/${run.outcome}`, decisions(run)[0]?.consult?.id], [2, 'completed/resolved', 'c1'])
    await releaseWorkspace(engine)
  }

  t.section('3d. a panel preflight refusal never drops a consult with an unsettled seat (audit 088)')
  for (const [label, panelConfig, unsettled] of [
    ['disabled panel', { ...PANEL, enabled: false }, async () => ['round-1/consultant-1']],
    ['lowered cap', { ...PANEL, maxPerRun: 0, maxTechnicalPerRun: 0 }, async () => ['round-1/consultant-1']],
    ['unreadable pending check', { ...PANEL, enabled: false }, async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) }]
  ]) {
    let consulted = 0
    const panel = { panel: async () => panelConfig, recorded: async () => null, unsettled, consult: async () => { consulted++; throw new Error('not asked') } }
    const { engine, f } = await planRun({}, { consult: panel, operatorRequest: { stepId: 'brief-implement', request: request('technical') } })
    await engine.drive()
    const run = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
    t.eq(`${label}: no fallback decision, no consult call, the run waits on recover`, [decisions(run).length, consulted, run.recovery?.consultPending, supportedActions(run)], [0, 0, true, ['recover', 'abandon']])
    await releaseWorkspace(engine)
  }
  {
    // A marker from a consult cut short is kept, not dropped, when the refusal meets an unsettled seat.
    const panel = { panel: async () => ({ ...PANEL, enabled: false }), recorded: async () => null, unsettled: async () => ['round-1/consultant-1'], consult: async () => { throw new Error('not asked') } }
    const { engine, f } = await planRun({}, { consult: panel })
    const ask = { key: 'operator-request:k', question: 'Which layer?', askedBy: { role: 'coordinator' }, request: { reason: 'r', recommendation: 'x', category: 'technical' }, at: f.clock.iso() }
    engine.run.consulting = { key: ask.key, mode: 'decide', startedAt: ask.at }
    t.eq('cut marker: the outcome is stopped and the marker stays', [await engine.consultFirst(ask, { category: 'technical' }), engine.run.consulting?.key], ['stopped', 'operator-request:k'])
    await releaseWorkspace(engine)
  }

  t.section('3c. a technical request whose consult has an unsettled seat commits no fallback decision (audit 085)')
  for (const path_ of ['replay throws', 'unacknowledged verdict']) {
    // The engine sees what the service gives it on these paths: a fault while the
    // seat is open (a replay that throws past the seat turn), or a pendingRecovery result.
    let open = ['round-1/consultant-1']
    const asked = []
    const panel = {
      asked,
      panel: async () => PANEL,
      recorded: async () => null,
      unsettled: async () => open,
      consult: async (r) => {
        asked.push(r)
        if (open.length && path_ === 'replay throws') throw new Error('config-checked could not be persisted')
        if (open.length) return { id: 'c1', outcome: 'unavailable', reason: 'consultant-1: not acknowledged', pendingRecovery: true, unsettled: open, rounds: 1, costUsd: null, costUnknown: false, durationMs: 10, opinions: [] }
        return { id: 'c1', rounds: 1, costUsd: 1, costUnknown: false, durationMs: 1000, opinions, ...resolved() }
      }
    }
    const { engine, f } = await planRun({}, { consult: panel, operatorRequest: { stepId: 'brief-implement', request: request('technical') } })
    await engine.drive()
    let run = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
    t.eq(`${path_}: no decision of any kind is committed, the marker stays`, [decisions(run).length, Boolean(run.consulting), run.recovery?.consultPending], [0, true, true])
    t.eq(`${path_}: the run waits on recover`, supportedActions(run), ['recover', 'abandon'])
    open = []
    const out = await engine.recoverOwnerLoss()
    run = await engine.drive()
    t.eq(`${path_}: once settled, recover consults again and the panel\'s answer is the decision`, [out.resumed, asked.length, decisions(run)[0]?.consult?.id], [true, 2, 'c1'])
    await releaseWorkspace(engine)
  }

  t.section('4. the coordinator\'s requests')
  for (const [category, expect] of [['owner-gate', 'answered'], ['requirement-conflict', 'answered']]) {
    const panel = fakePanel(resolved)
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: request(category) } }) })
    const engine = await launch(f)
    engine.consult = panel
    const run = await engine.drive()
    t.eq(`${category}: the panel's answer is the decision, nobody is asked`, [`${run.status}/${run.outcome}`, panel.asked[0]?.mode, decisions(run)[0]?.key.startsWith('operator-request:'), expect], ['completed/resolved', 'decide', true, 'answered'])
    await releaseWorkspace(engine)
  }
  {
    const panel = fakePanel(resolved)
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: request('live-checkout', { question: 'Commit the checkout.' }) } }) })
    const engine = await launch(f)
    engine.consult = panel
    const run = await engine.drive()
    t.eq('live-checkout is a work order: the panel is not asked', [run.status, run.pause.kind, panel.asked.length], ['paused', 'operator-request', 0])
    await releaseWorkspace(engine)
  }
  {
    const panel = fakePanel(escalated)
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: request('authorization', { question: 'May the run publish the package?' }) } }) })
    const engine = await launch(f)
    engine.consult = panel
    const run = await engine.drive()
    t.eq('authorization: the panel only writes the question, a person decides', [run.status, panel.asked[0].mode, run.pause.brief.question], ['paused', 'brief', brief.question])
    await releaseWorkspace(engine)
  }

  t.section('5. a technical question never waits for a person')
  {
    const panel = fakePanel(resolved)
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: request('technical') } }) })
    const engine = await launch(f)
    engine.consult = panel
    const run = await engine.drive()
    t.eq('agreed: the answer is the decision', [`${run.status}/${run.outcome}`, decisions(run)[0].consult.outcome, run.consults.c1.category], ['completed/resolved', 'resolved', 'technical'])
    await releaseWorkspace(engine)
  }
  {
    const panel = fakePanel(escalated)
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: request('technical') } }) })
    const engine = await launch(f)
    engine.consult = panel
    const run = await engine.drive()
    const [d] = decisions(run)
    t.eq('not agreed: no pause, the decision carries what each said', [`${run.status}/${run.outcome}`, d.consult.outcome, /did not settle/.test(d.answer), /consultant-2/.test(d.answer)], ['completed/resolved', 'escalated', true, true])
    await releaseWorkspace(engine)
  }
  {
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request: request('technical') } }) })
    const engine = await launch(f)
    const run = await engine.drive()
    const [d] = decisions(run)
    t.eq('no panel: the coordinator is told to decide, and the run goes on', [`${run.status}/${run.outcome}`, d.actor, /was not asked/.test(d.answer)], ['completed/resolved', 'engine', true])
    await releaseWorkspace(engine)
  }

  t.section('5b. a recorded answer is used whatever the panel is today')
  {
    // The process died after the panel's result was recorded and before the decision step: on replay the
    // panel is switched off, and the marker of the cut-short consult is still on the run.
    const panel = fakePanel(resolved)
    const { engine } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    await panel.consult({ key: 'owner-hold:planner:H1', question: hold().question, mode: 'decide' })
    panel.asked.length = 0
    panel.panel = async () => ({ ...PANEL, enabled: false })
    engine.run.consulting = { key: 'owner-hold:planner:H1', mode: 'decide', startedAt: '2026-01-01T00:00:00.000Z' }
    const run = await engine.drive()
    const [d] = decisions(run)
    t.eq('the recorded answer is the decision, and nobody is asked again', [`${run.status}/${run.outcome}`, d.consult.outcome, panel.asked.length], ['completed/resolved', 'resolved', 0])
    t.eq('the marker is cleared and the step spans the question from when it was raised', [run.consulting ?? null, run.steps.find((s) => s.decision).startedAt], [null, '2026-01-01T00:00:00.000Z'])
    t.ok('the decision step has a stable identity', run.steps.find((s) => s.decision).invocationId === 'decision-consult-c1')
    await releaseWorkspace(engine)
  }

  t.section('6. stopping the run while the panel works')
  {
    let engineRef = null
    const panel = fakePanel(async () => { engineRef.controller.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e })
    const { engine } = await planRun({ plan: () => plan([hold()]) }, { consult: panel })
    engineRef = engine
    const run = await engine.drive()
    t.eq('the run is cancelled, with no question left open and no decision', [run.status, run.pause ?? null, decisions(run).length], ['cancelled', null, 0])
    t.eq('the cut-short consult stays named, so a resume goes on with it', [run.consulting?.key, run.consulting?.mode], ['owner-hold:planner:H1', 'decide'])
    await releaseWorkspace(engine)
  }

  // ---------------------------------------------------------------------------
  // 7. A hold raised in plan review is consulted before the loop's next turn
  // (execution-contract.md "Owner holds"; owner-holds.mjs openPlanReviewHold).
  // ---------------------------------------------------------------------------
  const ANSWER = 'PANEL-ANSWER: keep the list shrink-only.'
  const answered = () => ({ ...resolved(), answerText: ANSWER })
  const review = (verdict, holds = [], findings = []) => `Reviewed.${NL}${fence({ verdict, artifactRevision: 'plan', findings, ownerHolds: holds })}`
  const agents = (run) => run.steps.filter((s) => s.role !== 'operator').length
  const roundOf = (run, n) => run.steps.filter((s) => s.phase === 'plan-review' && s.role !== 'operator' && s.round >= n)
  const P1 = [[blocking('P1')], []]
  const open = (run, id) => run.ownerHolds?.[id]?.answeredByStep ?? null
  const reopen = (f, runId) => resumeRun({ issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
  /** What a restarted server's reconcile writes for a run whose owner died (engine.owner-loss.test.mjs lostOwner). */
  const lostOwner = async (f, runId) => {
    await simulateProcessDeath(f.issuePath)
    const run = await store.readRun(f.issuePath, runId)
    const live = LIVE_STATUSES.includes(run.status)
    Object.assign(run, { status: 'blocked', outcome: 'unresolved', blockedReason: 'recovery-required', recovery: { required: true, ownerLost: true, reason: 'test', detectedAt: f.clock.iso(), lastActivityAt: f.clock.iso() } })
    if (run.workspace?.state === 'active') run.workspace.state = 'retained'
    await store.writeRun(f.issuePath, runId, run)
    return live
  }
  const crashOnce = (panel) => {
    const recorded = panel.recorded
    let crashed = false
    panel.recorded = async (r, o) => { if (!crashed) { crashed = true; throw Object.assign(new Error('crashed'), { injected: true }) } return recorded(r, o) }
    return panel
  }
  /** Two plan auditors, so a review round runs as a concurrent batch (engine.runConcurrently). */
  const SEATS = { participants: { 'auditor-2': { model: 'gpt-6-astra' } } }
  const batchRun = async (turns, { consult, ...options } = {}) => {
    const fallback = scriptFor(options)
    const f = await engineFixture({ playbook: 'plan-and-implement', script: (turn) => turns[turn.stepId]?.(turn) ?? fallback(turn) })
    const expectConfigHash = (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: SEATS, projectId: 'devpanel-project' })).resolved.configHash
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions: SEATS, expectConfigHash
    })
    if (consult) engine.consult = consult
    engine.run.budgets.limits.wallClockMinutes = 600
    return { engine, f }
  }
  /**
   * auditor-1 states H1 and commits; then auditor-2's turn is cut at the wall-clock deadline
   * (the clock is moved past the limit once auditor-1's answer is on the record).
   */
  const deadlineTurns = (ref, { reap = null } = {}) => ({
    'audit-plan-1': ({ round }) => (round === 0 ? review('approved', [hold()]) : null),
    'audit-plan-2': async ({ round }) => {
      if (round !== 0) return null
      while (!ref.engine.run.steps.some((s) => s.stepId === 'audit-plan-1' && ref.engine.outputs[s.number]?.valid)) await new Promise((resolve) => setTimeout(resolve, 5))
      if (!reap) { ref.f.clock.advance(601 * 60_000); return new Promise(() => {}) }
      // A seat whose escaped processes were not proved gone: its own rejection carries the scan, and
      // the deadline fires just after it, so the engine reads the turn as cut at the deadline.
      queueMicrotask(() => ref.f.clock.advance(601 * 60_000))
      throw Object.assign(new Error('cut at the deadline'), { name: 'AbortError', reap })
    }
  })

  t.section('7. a hold raised in plan review is consulted before the loop\'s next turn')
  {
    // (a) resolved, repeated in round 1 with exactly the same question
    const prompts = {}
    const panel = fakePanel(answered)
    const capture = (id) => ({ round, prompt }) => { if (round === 1) prompts[id] = prompt; return null }
    const { engine } = await planRun({
      'brief-plan': capture('brief-plan'),
      plan: capture('plan'),
      'audit-plan-1': ({ round, prompt }) => { if (round === 1) prompts['audit-plan-1'] = prompt; return round === 0 ? review('changes-needed', [hold()], [blocking('P1')]) : review('approved', [hold()]) }
    }, { consult: panel, planReviews: P1 })
    const run = await engine.drive()
    t.eq('(a) asked once, for the auditor\'s hold', panel.asked.map((r) => r.key), ['owner-hold:auditor-1:H1'])
    const decision = run.steps.find((s) => s.decision?.consult)
    t.ok('(a) recorded as decision.consult before round 1', decision?.decision.consult.id === 'c1' && roundOf(run, 1).every((s) => Number(s.number) > Number(decision.number)))
    t.eq('(a) in plan review', decision?.phase, 'plan-review')
    t.eq('(a) the planner\'s and the auditor\'s next turns carry it', ['brief-plan', 'plan', 'audit-plan-1'].map((id) => Boolean(prompts[id]?.includes(ANSWER))), [true, true, true])
    t.eq('(a) the exact repeat stays answered, and the run closes', [`${run.status}/${run.outcome}`, panel.asked.length, Boolean(open(run, 'auditor-1:H1'))], ['completed/resolved', 1, true])
    await releaseWorkspace(engine)
  }
  {
    // (p) a planner's hold is asked before its audit
    let auditsAtConsult = null
    const ref = {}
    const panel = fakePanel(() => { auditsAtConsult = ran(ref.engine.run, 'audit-plan-1'); return answered() })
    const { engine } = await planRun({ plan: ({ round }) => (round === 0 ? plan([hold()]) : null) }, { consult: panel })
    ref.engine = engine
    const run = await engine.drive()
    t.eq('(p) a planner\'s hold is consulted before the plan is audited', [auditsAtConsult, panel.asked.length, run.status], [0, 1, 'completed'])
    await releaseWorkspace(engine)
  }
  {
    // (b) an evidence refresh does not ask again
    let refreshed = false
    const panel = fakePanel(answered)
    const { engine } = await planRun({
      'brief-plan': ({ round }) => { if (round === 0 || refreshed) return null; refreshed = true; return fence({ targetRole: 'planner', prompt: 'Carry on.', rationale: 'because', windowDecision: 'refresh-evidence' }) },
      'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold()], [blocking('P1')]) : review('approved'))
    }, { consult: panel, planReviews: P1 })
    const run = await engine.drive()
    t.eq('(b) after a refresh the hold is not asked again', [refreshed && Boolean(run.windowResetAfter), panel.asked.length, run.status], [true, 1, 'completed'])
    await releaseWorkspace(engine)
  }
  {
    // (r) a rephrased question under the same id is a new question (orchestrator decision)
    const rephrased = hold().question.replace('?', ', or keep one list?')
    const panel = fakePanel(answered)
    const { engine } = await planRun({
      'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold()], [blocking('P1')]) : review('approved', [hold({ question: rephrased })]))
    }, { consult: panel, planReviews: P1 })
    const run = await engine.drive()
    t.eq('(r) a rephrased repeat is consulted again, with its own wording', [panel.asked.length, panel.asked[1]?.question, run.status], [2, rephrased, 'completed'])
    await releaseWorkspace(engine)
  }
  {
    // (c) not resolved: paused with the panel's brief, before round 1
    const panel = fakePanel(escalated)
    const { engine } = await planRun({ 'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold()], [blocking('P1')]) : null) }, { consult: panel, planReviews: P1 })
    const run = await engine.drive()
    t.eq('(c) paused as an owner hold, with the panel\'s brief, from plan review', [run.status, run.pause?.kind, run.pause?.brief?.question, run.pause?.askedBy?.phase], ['paused', 'owner-hold', brief.question, 'plan-review'])
    t.eq('(c) no turn of round 1', roundOf(run, 1).length, 0)
    const again = await engine.drive()
    t.eq('(c) a second drive asks nobody again', [again.pause?.id, panel.asked.length], [run.pause.id, 1])
    await releaseWorkspace(engine)
  }
  {
    // (d1) a crash after the hold was recorded and before the consult
    const panel = crashOnce(fakePanel(answered))
    const { engine, f } = await planRun({ 'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold()], [blocking('P1')]) : review('approved')) }, { consult: panel, planReviews: P1 })
    const crash = await engine.drive().catch((e) => e)
    t.ok('(d1) the drive died at the consult', crash?.injected === true, String(crash))
    t.ok('(d1) the run was live on disk', await lostOwner(f, engine.runId))
    const resumed = await reopen(f, engine.runId)
    resumed.consult = panel
    t.ok('(d1) recovered', (await resumed.recoverOwnerLoss()).resumed)
    const run = await resumed.drive()
    t.eq('(d1) replay asks the panel once, and round 1 runs', [panel.asked.length, roundOf(run, 1).length > 0, run.status], [1, true, 'completed'])
    await releaseWorkspace(resumed)
  }
  {
    // (d2) a crash after the panel's answer was recorded and before the decision step
    const panel = fakePanel(answered)
    const { engine } = await planRun({ 'audit-plan-1': ({ round }) => (round === 0 ? review('approved', [hold()]) : null) }, { consult: panel })
    await panel.consult({ key: 'owner-hold:auditor-1:H1', question: hold().question, mode: 'decide' })
    panel.asked.length = 0
    engine.run.consulting = { key: 'owner-hold:auditor-1:H1', mode: 'decide', startedAt: '2026-01-01T00:00:00.000Z' }
    const run = await engine.drive()
    t.eq('(d2) the recorded answer is used, nobody is asked', [panel.asked.length, run.steps.filter((s) => s.decision).map((s) => s.invocationId), run.status], [0, ['decision-consult-c1'], 'completed'])
    await releaseWorkspace(engine)
  }
  for (const outcome of ['resolved', 'escalated']) {
    // (e) the loop's last round (extend-if-converging cannot extend at round 0)
    const panel = fakePanel(outcome === 'resolved' ? answered : escalated)
    const { engine } = await planRun({ 'audit-plan-1': () => review('changes-needed', [hold()], [blocking('P1')]) }, { consult: panel, planReviews: P1 })
    engine.snapshot.phases.find((p) => p.id === 'plan-review').loop.maxRounds = 1
    let run = await engine.drive()
    if (outcome === 'escalated') {
      t.eq('(e) last round, not resolved: the hold pauses first', [run.status, run.pause?.kind], ['paused', 'owner-hold'])
      await engine.answer({ pauseId: run.pause.id, text: 'Keep it.', actor: 'owner' })
      run = await engine.drive()
    }
    t.eq(`(e) last round, ${outcome}: one consult, then the loop ends as before`, [panel.asked.length, `${run.status}/${run.blockedReason}/${run.outcome}`, Boolean(open(run, 'auditor-1:H1'))], [1, 'blocked/rounds-exhausted/unresolved', true])
    await releaseWorkspace(engine)
  }
  for (const outcome of ['resolved', 'escalated']) {
    // (f) the last round of a loop that asks whether to go on
    const panel = fakePanel(outcome === 'resolved' ? answered : escalated)
    const { engine } = await planRun({ 'audit-plan-1': () => review('changes-needed', [hold()], [blocking('P1')]) }, { consult: panel, planReviews: P1 })
    const loop = engine.snapshot.phases.find((p) => p.id === 'plan-review').loop
    Object.assign(loop, { maxRounds: 1, onExhausted: 'await-input' })
    let run = await engine.drive()
    if (outcome === 'escalated') {
      t.eq('(f) await-input, not resolved: the owner-hold pause comes first', run.pause?.kind, 'owner-hold')
      await engine.answer({ pauseId: run.pause.id, text: 'Keep it.', actor: 'owner' })
      run = await engine.drive()
    }
    t.eq(`(f) await-input, ${outcome}: then the continue-or-stop question, with the hold already decided`, [run.pause?.kind, decisions(run).some((d) => d.key === 'owner-hold:auditor-1:H1'), panel.asked.length], ['rounds-exhausted', true, 1])
    await releaseWorkspace(engine)
  }
  for (const outcome of ['resolved', 'escalated']) {
    // (g) the audit that states the hold spends the last step
    const ref = {}
    const panel = fakePanel(outcome === 'resolved' ? answered : escalated)
    const { engine } = await planRun({
      'audit-plan-1': ({ round }) => {
        if (round !== 0) return null
        ref.engine.run.budgets.limits.maxSteps = agents(ref.engine.run) + 1
        return review('changes-needed', [hold()], [blocking('P1')])
      }
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    let run = await engine.drive()
    const spent = agents(run)
    if (outcome === 'escalated') {
      t.eq('(g) budget, not resolved: paused with the brief', [run.status, Boolean(run.pause?.brief)], ['paused', true])
      await engine.answer({ pauseId: run.pause.id, text: 'Keep it.', actor: 'owner' })
      run = await engine.drive()
    }
    t.eq(`(g) budget, ${outcome}: consulted, then blocked on the budget with no further turn`, [panel.asked.length, `${run.status}/${run.blockedReason}`, agents(run), Boolean(open(run, 'auditor-1:H1'))], [1, 'blocked/budget-exhausted', spent, true])
    await releaseWorkspace(engine)
  }
  {
    // (j) a crash after that audit and before its consult: recovery at the spent budget consults once
    const ref = {}
    const panel = crashOnce(fakePanel(answered))
    const { engine, f } = await planRun({
      'audit-plan-1': ({ round }) => {
        if (round !== 0) return null
        ref.engine.run.budgets.limits.maxSteps = agents(ref.engine.run) + 1
        return review('changes-needed', [hold()], [blocking('P1')])
      }
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    await engine.drive().catch(() => {})
    const spent = agents(engine.run)
    await lostOwner(f, engine.runId)
    const resumed = await reopen(f, engine.runId)
    resumed.consult = panel
    const recovered = await resumed.recoverOwnerLoss()
    t.eq('(j) recovery is let past the spent budget only to consult', [recovered.resumed, recovered.entry?.consultOnly], [true, true])
    const run = await resumed.drive()
    t.eq('(j) one consult, then blocked on the budget with no further turn', [panel.asked.length, `${run.status}/${run.blockedReason}`, agents(run)], [1, 'blocked/budget-exhausted', spent])
    await releaseWorkspace(resumed)
  }
  {
    // (h) an implementation hold at implement-review exhaustion is not consulted early (AC6)
    const panel = fakePanel(answered)
    const fallback = scriptFor({ implReviews: [[blocking('I1')]] })
    const f = await engineFixture({
      playbook: 'implementation',
      script: (turn) => (turn.stepId === 'implement' ? `Implemented.${NL}${fence({ summary: 'the change', basedOnRevision: (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], resolves: [], ownerHolds: [hold()] })}` : fallback(turn))
    })
    const engine = await launch(f)
    engine.consult = panel
    engine.snapshot.phases.find((p) => p.id === 'implement-review').loop.maxRounds = 1
    const run = await engine.drive()
    t.eq('(h) implement-review ends as before, asking nobody', [panel.asked.length, `${run.status}/${run.blockedReason}`], [0, 'blocked/rounds-exhausted'])
    await releaseWorkspace(engine)
  }
  for (const outcome of ['resolved', 'escalated']) {
    // (k) two holds in the audit that is the drive's last pass
    const panel = fakePanel(outcome === 'resolved' ? answered : escalated)
    const { engine } = await planRun({
      'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold(), hold({ id: 'H2', question: 'May the list name its owner?' })], [blocking('P1')]) : review('approved'))
    }, { consult: panel, planReviews: P1 })
    let run
    do { run = await engine.drive({ maxTurns: 1 }) } while (!ran(run, 'audit-plan-1') && run.status === 'running')
    if (outcome === 'resolved') {
      t.eq('(k) both holds are consulted before the drive ends', [panel.asked.map((r) => r.key), Boolean(open(run, 'auditor-1:H1') && open(run, 'auditor-1:H2')), roundOf(run, 1).length], [['owner-hold:auditor-1:H1', 'owner-hold:auditor-1:H2'], true, 0])
      const done = await engine.drive()
      t.eq('(k) and nothing is asked again', [panel.asked.length, done.status], [2, 'completed'])
    } else {
      t.eq('(k) not resolved: paused on the first, the second not yet asked', [run.status, run.pause?.key, panel.asked.length], ['paused', 'owner-hold:auditor-1:H1', 1])
    }
    await releaseWorkspace(engine)
  }
  for (const [label, outcome, capped] of [['(n) passes left, resolved', 'resolved', false], ['(n) passes left, not resolved', 'escalated', false], ['(n2) on the final pass', 'resolved', true]]) {
    // (n)/(n2) one auditor commits H1, the other is cut at the wall-clock deadline
    const ref = {}
    const panel = fakePanel(outcome === 'resolved' ? answered : escalated)
    const { engine, f } = await batchRun(deadlineTurns(ref), { consult: panel })
    Object.assign(ref, { engine, f })
    let run
    if (capped) { do { run = await engine.drive({ maxTurns: 1 }) } while (!ran(run, 'audit-plan-2') && run.status === 'running') } else run = await engine.drive()
    const spent = agents(run)
    const events = (await store.readEvents(f.issuePath, engine.runId)).events
    t.ok(`${label}: a concurrent batch, the second seat cut at the deadline`, events.some((e) => e.type === 'concurrent-reviews') && events.some((e) => e.type === 'turn-cut-at-deadline' && e.role === 'auditor-2'))
    if (outcome === 'escalated') {
      t.eq(`${label}: paused with the brief`, [run.status, run.pause?.kind, Boolean(run.pause?.brief), panel.asked.length], ['paused', 'owner-hold', true, 1])
      await engine.answer({ pauseId: run.pause.id, text: 'Keep it.', actor: 'owner' })
      run = await engine.drive()
    }
    t.eq(`${label}: one consult, then blocked on the budget, no further turn`, [panel.asked.length, `${run.status}/${run.blockedReason}`, agents(run), Boolean(open(run, 'auditor-1:H1'))], [1, 'blocked/budget-exhausted', spent, true])
    if (outcome === 'resolved') t.eq(`${label}: the block names the cut seat`, (await store.readEvents(f.issuePath, engine.runId)).events.filter((e) => e.type === 'budget-exhausted').at(-1)?.cuts?.[0]?.role, 'auditor-2')
    await releaseWorkspace(engine)
  }
  {
    // (o) a crash between the cut and the consult: the run is live on disk, recovery consults once
    const ref = {}
    const panel = crashOnce(fakePanel(answered))
    const { engine, f } = await batchRun(deadlineTurns(ref), { consult: panel })
    Object.assign(ref, { engine, f })
    const crash = await engine.drive().catch((e) => e)
    const spent = agents(engine.run)
    const stored = await store.readRun(f.issuePath, engine.runId)
    t.eq('(o) the drive died at the consult with the run still live on disk', [crash?.injected, stored.status, LIVE_STATUSES.includes(stored.status)], [true, 'running', true])
    await lostOwner(f, engine.runId)
    const resumed = await reopen(f, engine.runId)
    resumed.consult = panel
    const recovered = await resumed.recoverOwnerLoss()
    t.eq('(o) recovery is let past the spent clock only to consult', [recovered.resumed, recovered.entry?.consultOnly], [true, true])
    const run = await resumed.drive()
    t.eq('(o) one consult, then blocked on the budget, no further turn', [panel.asked.length, `${run.status}/${run.blockedReason}`, agents(run)], [1, 'blocked/budget-exhausted', spent])
    await releaseWorkspace(resumed)
  }
  {
    // (u) the cut seat left its cleanup unproved: the run blocks on it, nothing is asked
    const ref = {}
    const panel = fakePanel(answered)
    const reap = { status: 'unavailable', method: 'proc-environ', tag: 'tag-u', escaped: 0, reason: 'unavailable for the test' }
    const { engine, f } = await batchRun(deadlineTurns(ref, { reap }), { consult: panel })
    Object.assign(ref, { engine, f })
    let run = await engine.drive()
    const spent = agents(run)
    t.eq('(u) blocked on the cleanup, no consult, no question', [`${run.status}/${run.blockedReason}`, panel.asked.length, run.pause ?? null], ['blocked/cleanup-unproved', 0, null])
    t.eq('(u) the hold is on the record, open', [Boolean(run.ownerHolds?.['auditor-1:H1']), open(run, 'auditor-1:H1')], [true, null])
    for (const entry of run.cleanup.entries) Object.assign(entry, { acknowledgedAt: f.clock.iso(), acknowledgement: { by: 'tester', at: f.clock.iso(), reason: 'checked' } })
    await engine.persist()
    const entry = await engine.resumeExecution({})
    t.eq('(u) the Resume is let past the spent clock only to consult', entry.consultOnly, true)
    run = await engine.drive()
    t.eq('(u) then one consult, and blocked on the budget with no further turn', [panel.asked.length, `${run.status}/${run.blockedReason}`, agents(run)], [1, 'blocked/budget-exhausted', spent])
    await releaseWorkspace(engine)
  }
  {
    // (s) a Stop between two holds: the second is never asked, the run is cancelled
    const ref = {}
    const panel = fakePanel(() => { ref.engine.cancel('requested'); return answered() })
    const { engine } = await planRun({
      'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold(), hold({ id: 'H2', question: 'May the list name its owner?' })], [blocking('P1')]) : null)
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    const run = await engine.drive()
    t.eq('(s) Stop after H1\'s decision: H2 is not asked, the run is cancelled', [panel.asked.length, Boolean(open(run, 'auditor-1:H1')), open(run, 'auditor-1:H2'), run.status, run.pause ?? null], [1, true, null, 'cancelled', null])
    await releaseWorkspace(engine)
  }
  {
    // (s) …and when the panel cannot be asked for H2 (its limit), the Stop still wins over the question
    const ref = {}
    let reads = 0
    const panel = fakePanel(answered)
    panel.panel = async () => { if (++reads === 2) ref.engine.cancel('requested'); return { ...PANEL, maxPerRun: 1 } }
    const { engine } = await planRun({
      'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold(), hold({ id: 'H2', question: 'May the list name its owner?' })], [blocking('P1')]) : null)
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    const run = await engine.drive()
    t.eq('(s) panel at its limit for H2 and a Stop: cancelled, not paused', [panel.asked.length, run.status, run.pause ?? null], [1, 'cancelled', null])
    await releaseWorkspace(engine)
  }
  {
    // (v) Stop signalled while the hold record is refreshed before a budget block: cancelled, not blocked
    const ref = {}
    const panel = fakePanel(escalated)
    const { engine } = await planRun({
      'audit-plan-1': ({ round }) => {
        if (round !== 0) return null
        ref.engine.run.budgets.limits.maxSteps = agents(ref.engine.run) + 1
        return review('changes-needed', [hold()], [blocking('P1')])
      }
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    const paused = await engine.drive()
    await engine.answer({ pauseId: paused.pause.id, text: 'Keep it.', actor: 'owner' })
    const record = engine.recordOwnerHolds.bind(engine)
    engine.recordOwnerHolds = async () => { await record(); engine.run.status = 'stopping'; engine.cancel('requested') }
    const run = await engine.drive()
    t.eq('(v) a Stop during the record refresh before the budget block settles as cancelled', [run.status, run.blockedReason ?? null, panel.asked.length], ['cancelled', null, 1])
    await releaseWorkspace(engine)
  }
  {
    // (w) a pending operator pause at the drive's ending comes before the consult; the next drive asks
    const ref = {}
    const panel = fakePanel(answered)
    const { engine } = await planRun({
      'audit-plan-1': async ({ round }) => {
        if (round !== 0) return review('approved')
        await ref.engine.requestPause()
        return review('changes-needed', [hold()], [blocking('P1')])
      }
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    let run
    do { run = await engine.drive({ maxTurns: 1 }) } while (!ran(run, 'audit-plan-1') && run.status === 'running')
    t.eq('(w) the operator pause stands, nothing was asked, the hold is open', [run.status, run.pause?.kind, panel.asked.length, open(run, 'auditor-1:H1')], ['paused', 'manual', 0, null])
    await engine.resumeExecution({})
    const done = await engine.drive()
    t.eq('(w) after the resume the hold is consulted once, before round 1', [panel.asked.length, done.status], [1, 'completed'])
    await releaseWorkspace(engine)
  }
  /** The next hold-record write signals a Stop as the supervisor's does (supervisor.mjs beginStop: stopping, then cancel). */
  const stopInNextRecord = (engine) => {
    const record = engine.recordOwnerHolds.bind(engine)
    engine.recordOwnerHolds = async () => { engine.recordOwnerHolds = record; await record(); engine.run.status = 'stopping'; engine.cancel('requested') }
  }
  {
    // (x) cleanup path: the cut seat left unproved cleanup, and a Stop is signalled during the ending's hold-record write
    const ref = {}
    const panel = fakePanel(answered)
    const reap = { status: 'unavailable', method: 'proc-environ', tag: 'tag-x', escaped: 0, reason: 'unavailable for the test' }
    const turns = deadlineTurns(ref, { reap })
    const first = turns['audit-plan-1']
    turns['audit-plan-1'] = (turn) => { if (turn.round === 0) stopInNextRecord(ref.engine); return first(turn) }
    const { engine, f } = await batchRun(turns, { consult: panel })
    Object.assign(ref, { engine, f })
    const run = await engine.drive()
    t.eq('(x) cleanup path: a signalled Stop settles as cancelled, not stopping or cleanup-unproved', [run.status, run.blockedReason ?? null, panel.asked.length, run.pause ?? null], ['cancelled', null, 0, null])
    await releaseWorkspace(engine)
  }
  for (const [label, request] of [
    ['manual pause path', (engine) => engine.requestPause()],
    ['freeze path', async (engine) => { engine.run.freezeRequested = { cycleId: 'cycle-x', at: engine.clock.iso() } }]
  ]) {
    // (x) a pending pause or freeze at the drive's ending, and a Stop signalled during the hold-record write
    const ref = {}
    const panel = fakePanel(answered)
    const { engine } = await planRun({
      'audit-plan-1': async ({ round }) => {
        if (round !== 0) return review('approved')
        await request(ref.engine)
        stopInNextRecord(ref.engine)
        return review('changes-needed', [hold()], [blocking('P1')])
      }
    }, { consult: panel, planReviews: P1 })
    ref.engine = engine
    let run
    do { run = await engine.drive({ maxTurns: 1 }) } while (!ran(run, 'audit-plan-1') && run.status === 'running')
    t.eq(`(x) ${label}: a signalled Stop settles as cancelled, not stopping or paused`, [run.status, run.pause ?? null, panel.asked.length], ['cancelled', null, 0])
    await releaseWorkspace(engine)
  }
  for (const capped of [false, true]) {
    // (s2) Stop while the last consult's decision is written, no hold left: the two statements the
    // supervisor's Stop runs on the engine (supervisor.mjs beginStop: status stopping, engine.cancel).
    const panel = fakePanel(answered)
    const { engine, f } = await planRun({ 'audit-plan-1': ({ round }) => (round === 0 ? review('changes-needed', [hold()], [blocking('P1')]) : null) }, { consult: panel, planReviews: P1 })
    const persist = engine.persist.bind(engine)
    engine.persist = async (event) => {
      await persist(event)
      if (event?.type === 'decision') { engine.run.status = 'stopping'; engine.cancel('requested') }
    }
    let run
    if (capped) { do { run = await engine.drive({ maxTurns: 1 }) } while (!ran(run, 'audit-plan-1') && run.status === 'running') } else run = await engine.drive()
    const stored = await store.readRun(f.issuePath, engine.runId)
    t.eq(`(s2) Stop at the decision, ${capped ? 'at the drive\'s ending' : 'at the top gate'}: cancelled on disk, not stopping`, [stored.status, Boolean(stored.ownerHolds?.['auditor-1:H1']?.answeredByStep), panel.asked.length, roundOf(stored, 1).length, stored.pause ?? null], ['cancelled', true, 1, 0, null])
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
