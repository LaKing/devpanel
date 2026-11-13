import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

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
  t.section('1. an owner hold both consultants answer the same way never reaches the owner')
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

  await cleanupFixtures()
}
