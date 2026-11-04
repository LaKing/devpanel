import fs from 'node:fs/promises'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — an owner hold a seat stated stops implementation until the owner answers it'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)
const revisionIn = (prompt) => (prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0]

const launch = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

const hold = (over = {}) => ({
  id: 'H1',
  question: 'Remove loopback from every seat\'s shell?',
  category: 'security',
  reason: 'It takes away what the documentation promises each seat, so it is the owner\'s trade-off.',
  recommendation: 'Keep loopback.',
  ...over
})
const plan = (holds = null) => `A plan.${NL}${fence({ summary: 'the plan', basedOnRevision: null, resolves: [], ...(holds ? { ownerHolds: holds } : {}) })}`
const stepIds = (run) => run.steps.map((s) => s.stepId)
const ran = (run, stepId) => stepIds(run).filter((id) => id === stepId).length
const answers = (run) => run.steps.filter((s) => s.role === 'operator').length
const brief = (over) => fence({ targetRole: 'planner', prompt: 'Carry on.', rationale: 'because', ...over })

/** A plan-and-implement run in which `turns` replaces the scripted answer of the turns it names. */
const planRun = async (turns, options = {}) => {
  const fallback = scriptFor(options)
  const f = await engineFixture({
    playbook: options.playbook ?? 'plan-and-implement',
    script: (turn) => turns[turn.stepId]?.(turn) ?? fallback(turn)
  })
  return launch(f)
}

export default async (t) => {
  t.section('1. a hold in the plan stops the handoff that would start implementation')
  {
    const prompts = {}
    const engine = await planRun({
      plan: () => plan([hold()]),
      'brief-implement': ({ prompt }) => { prompts.brief = prompt; return null },
      implement: ({ prompt }) => { prompts.implement = prompt; return null }
    })
    const run = await engine.drive()
    t.eq('the run is paused, not blocked', `${run.status}/${run.blockedReason}`, 'paused/null')
    t.eq('no coordinator handoff toward implementation ran', ran(run, 'brief-implement'), 0)
    t.eq('and no implementation turn', ran(run, 'implement'), 0)
    t.eq('the plan was audited first', ran(run, 'audit-plan-1'), 1)
    t.eq('it asks the seat\'s own question', run.pause?.question, hold().question)
    t.eq('as a hold, in the owner-gate category', [run.pause?.kind, run.pause?.request?.category, run.pause?.request?.holdCategory], ['owner-hold', 'owner-gate', 'security'])
    t.eq('with who stated it', [run.pause?.askedBy?.role, run.pause?.askedBy?.stepId], ['planner', 'plan'])
    t.eq('the reason and recommendation go with it', [run.pause?.request?.reason, run.pause?.request?.recommendation], [hold().reason, hold().recommendation])
    t.eq('it is open on the run\'s record', run.ownerHolds?.['planner:H1']?.answeredByStep, null)
    t.eq('and the record names the question', run.ownerHolds?.['planner:H1']?.category, 'security')

    t.section('   …a second drive waits rather than asking again')
    const pauseId = run.pause.id
    const again = await engine.drive()
    t.eq('the same question, not a new one', again.pause?.id, pauseId)

    t.section('   …the owner\'s answer releases it, and the run goes on from that answer')
    await engine.answer({ pauseId, text: 'Keep loopback for now.', actor: 'owner' })
    const done = await engine.drive()
    t.eq('implementation started after the answer', ran(done, 'implement'), 1)
    t.ok('the coordinator was given the answer', prompts.brief?.includes('Keep loopback for now.'))
    t.ok('and so was the implementer', prompts.implement?.includes('Keep loopback for now.'))
    t.eq('the question was asked once', answers(done), 1)
    t.eq('the run closed', `${done.status}/${done.outcome}`, 'completed/resolved')
    t.ok('the record names the answering step', Boolean(done.ownerHolds?.['planner:H1']?.answeredByStep), JSON.stringify(done.ownerHolds))
    await releaseWorkspace(engine)
  }

  t.section('2. an ordinary technical choice recorded as an assumption stops nothing')
  {
    const assumptions = [{ decision: 'Use a plain file, not a new library.', reason: 'Nothing else needs one.' }]
    const engine = await planRun({ 'brief-implement': () => brief({ assumptions }) })
    const run = await engine.drive()
    t.eq('the run closed', `${run.status}/${run.outcome}`, 'completed/resolved')
    t.eq('implementation ran', ran(run, 'implement'), 1)
    t.eq('the owner was asked nothing', answers(run), 0)
    t.eq('no hold is on the record', run.ownerHolds ?? null, null)
    await releaseWorkspace(engine)
  }

  t.section('3. the coordinator cannot lift a hold, nor a later plan drop it')
  {
    let plans = 0
    const lifted = [{ decision: 'H1 is lifted: keep loopback removed.', reason: 'No criterion conflicts, so no category applies.' }]
    const engine = await planRun({
      plan: () => (plans++ === 0 ? plan([hold()]) : plan()),
      'brief-plan': ({ round }) => (round > 0 ? brief({ assumptions: lifted }) : null)
    }, { planReviews: [[blocking('P1')], []] })
    const run = await engine.drive()
    t.ok('a second plan was written, without the hold', plans >= 2, String(plans))
    t.eq('still paused on the owner\'s question', [run.status, run.pause?.question], ['paused', hold().question])
    t.eq('no handoff toward implementation', ran(run, 'brief-implement'), 0)
    t.eq('and no implementation turn', ran(run, 'implement'), 0)
    await releaseWorkspace(engine)
  }
  {
    let plans = 0
    let refreshed = false
    const engine = await planRun({
      plan: () => (plans++ === 0 ? plan([hold()]) : plan()),
      'brief-plan': ({ round }) => {
        if (round === 0 || refreshed) return null
        refreshed = true
        return brief({ windowDecision: 'refresh-evidence' })
      }
    }, { planReviews: [[blocking('P1')], []] })
    const run = await engine.drive()
    t.ok('the window was reset past the step that stated it', refreshed && Boolean(run.windowResetAfter), `${refreshed}/${run.windowResetAfter}`)
    t.eq('the hold survives a window reset', [run.status, run.pause?.question], ['paused', hold().question])
    t.eq('and no implementation turn', ran(run, 'implement'), 0)
    await releaseWorkspace(engine)
  }

  t.section('4. an answered hold does not block again; a new question under its id does')
  for (const [label, second] of [['restated', [hold()]], ['omitted', null]]) {
    let plans = 0
    let restart = true
    const engine = await planRun({
      plan: () => (plans++ === 0 ? plan([hold()]) : plan(second)),
      'brief-implement': () => {
        if (!restart) return null
        restart = false
        return brief({ restartPlan: true })
      }
    })
    const run = await engine.drive()
    await engine.answer({ pauseId: run.pause.id, text: 'Keep it.', actor: 'owner' })
    const done = await engine.drive()
    t.ok(`the plan cycle repeated (${label})`, plans >= 2, String(plans))
    t.eq(`${label} in the later plan, it is not asked again`, answers(done), 1)
    t.eq('and implementation ran', ran(done, 'implement'), 1)
    await releaseWorkspace(engine)
  }
  {
    let plans = 0
    let restart = true
    const changed = 'Remove proxy reach from every seat\'s shell?'
    const engine = await planRun({
      plan: () => (plans++ === 0 ? plan([hold()]) : plan([hold({ question: changed })])),
      'brief-implement': () => {
        if (!restart) return null
        restart = false
        return brief({ restartPlan: true })
      }
    })
    const run = await engine.drive()
    await engine.answer({ pauseId: run.pause.id, text: 'Keep it.', actor: 'owner' })
    const second = await engine.drive()
    t.eq('a different question under the same id is asked', [second.status, second.pause?.question], ['paused', changed])
    await engine.answer({ pauseId: second.pause.id, text: 'Keep that too.', actor: 'owner' })
    const done = await engine.drive()
    t.eq('and its answer releases it', [answers(done), ran(done, 'implement')], [2, 1])
    await releaseWorkspace(engine)
  }

  t.section('5. a hold needs a reason in a category, or it is not a hold')
  for (const [label, bad] of [
    ['no category', (() => { const { category, ...rest } = hold(); return rest })()],
    ['a technical category', hold({ category: 'technical-choice' })],
    ['no reason', (() => { const { reason, ...rest } = hold(); return rest })()],
    ['an empty reason', hold({ reason: '   ' })]
  ]) {
    const engine = await planRun({ plan: ({ attempt }) => (attempt === 1 ? plan([bad]) : plan()) })
    const run = await engine.drive()
    const first = run.steps.find((s) => s.stepId === 'plan')
    t.eq(`${label}: a contract violation, sent to repair`, [engine.outputs[first.number]?.valid, engine.outputs[first.number]?.classification], [false, 'contract-violation'])
    t.eq('repaired without a hold, nothing asks', [answers(run), run.pause ?? null, run.ownerHolds ?? null], [0, null, null])
    t.eq('and implementation ran', ran(run, 'implement'), 1)
    await releaseWorkspace(engine)
  }
  {
    const { reason, ...bad } = hold()
    const engine = await planRun({ plan: () => plan([bad]) })
    const run = await engine.drive()
    t.eq('never repaired, it blocks and asks nobody', `${run.status}/${run.blockedReason}/${run.pause?.id ?? null}`, 'blocked/protocol-repair-exhausted/null')
    await releaseWorkspace(engine)
  }

  t.section('6. an audit can state a hold, and a late one does not reach delivery')
  {
    const engine = await planRun({
      'audit-plan-1': () => `Reviewed.${NL}${fence({ verdict: 'approved', artifactRevision: 'plan', findings: [], ownerHolds: [hold()] })}`
    })
    const run = await engine.drive()
    t.eq('an approving audit\'s hold pauses the run', [run.status, run.pause?.askedBy?.role], ['paused', 'auditor-1'])
    t.eq('no implementation turn', ran(run, 'implement'), 0)
    t.eq('recorded under the seat that stated it', run.ownerHolds?.['auditor-1:H1']?.question, hold().question)
    await releaseWorkspace(engine)
  }
  {
    const engine = await planRun({
      implement: ({ prompt }) => `Implemented.${NL}${fence({ summary: 'the change', basedOnRevision: revisionIn(prompt), resolves: [], ownerHolds: [hold()] })}`
    }, { playbook: 'implementation' })
    const run = await engine.drive()
    t.eq('a hold from the implementation pauses before confirmation', [run.status, ran(run, 'confirm')], ['paused', 0])
    await engine.answer({ pauseId: run.pause.id, text: 'Agreed.', actor: 'owner' })
    const done = await engine.drive()
    t.eq('and the answer lets it close', [done.status, ran(done, 'confirm')], ['completed', 1])
    await releaseWorkspace(engine)
  }

  t.section('7. what the coordinator is told, and what the owner reads')
  {
    const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
    const rule = /a question a plan or an audit addresses to the owner on access, security or a documented promise/
    for (const strategy of ['plan-and-implement', 'implementation']) {
      const text = await read(`strategy-templates/${strategy}/prompts/brief.md`)
      t.ok(`${strategy}: the brief makes it an owner-gate request`, rule.test(text))
      t.ok(`${strategy}: not an assumption`, /never answer it yourself or record it as an assumption/.test(text))
      t.ok(`${strategy}: technical choices still go to assumptions`, /record each in assumptions/.test(text))
    }
    const { $defs: contracts } = JSON.parse(await read('schemas/agent-outputs.schema.json'))
    const definition = contracts.handoff.properties.operatorRequest.properties.category.description
    t.ok('the owner-gate definition carries the rule', rule.test(definition), definition)
    t.ok('and is not limited to stops the issue asks for', !/owner-gate: the issue itself asks/.test(definition), definition)
    t.eq('both contracts state a hold the same way', contracts.authorArtifact.properties.ownerHolds, contracts.reviewResult.properties.ownerHolds)
    t.eq('with the three categories', contracts.authorArtifact.properties.ownerHolds.items.properties.category.enum, ['access', 'security', 'documented-promise'])

    const e = explainRun({ status: 'paused', pause: { kind: 'owner-hold', question: hold().question, request: { reason: hold().reason, category: 'owner-gate', recommendation: hold().recommendation } } })
    t.eq('the owner is told it is theirs', e.headline, 'Waiting for you: this decision is yours')
    t.eq('and to answer, not to do work', e.next, 'Answer below; the run continues from your answer.')
  }

  await cleanupFixtures()
}
