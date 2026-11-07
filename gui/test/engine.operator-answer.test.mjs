import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — an answered operatorRequest stays in `decisions` for every later step, across window resets'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)

const start = (f) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

const recording = (script) => {
  const seen = []
  return { seen, script: (turn) => { seen.push({ ...turn }); return script(turn) } }
}

const ANSWER = 'A: keep deploy_staging, do not remove it'
const request = {
  question: 'A or B for deploy_staging?',
  reason: 'Removing it changes what the supervisor may do; that is the owner\'s call.',
  category: 'owner-gate',
  recommendation: 'A'
}
const EMPTY = '### decisions' + NL + '(nothing recorded yet)'

// The coordinator's plan brief asks; the owner answers; the run goes on.
async function pauseAndAnswer (t, f) {
  const engine = await start(f)
  const paused = await engine.drive()
  t.eq('the plan brief paused the run with its request', [paused.status, paused.pause?.kind, paused.pause?.askedBy?.stepId], ['paused', 'operator-request', 'brief-plan'])
  // drive() returns the live run record and answer() clears its pause: read what was asked first.
  const { id: pauseId, askedBy: { step: asked } } = paused.pause
  await engine.answer({ pauseId, text: ANSWER, actor: 'owner' })
  const run = await engine.drive()
  const decision = run.steps.find((s) => s.role === 'operator')
  return { engine, run, decision, asked }
}

const planPrompts = (seen) => seen.filter((s) => s.stepId === 'plan')

/*
 * Observed: an owner answered A to a plan brief's operatorRequest, a later
 * coordinator effect reset the window past the answer, and the next cycle's
 * planner was told that nothing had been decided — and planned B. A window
 * reset discards evidence, plans and findings; it never discards an answer.
 */
export default async (t) => {
  t.section('1. pause with operatorRequest → answer → brief-plan → plan: the planner is given the answer')
  {
    const { seen, script } = recording(scriptFor({ operatorRequest: { stepId: 'brief-plan', request } }))
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const { engine, run, decision, asked } = await pauseAndAnswer(t, f)
    t.eq('the answer is an operator decision step keyed to the asking step', decision?.decision?.key, `operator-request:${asked}`)
    t.eq('carrying the answer and what was asked', [decision?.decision?.answer, decision?.decision?.request?.category], [ANSWER, 'owner-gate'])
    const plans = planPrompts(seen)
    t.ok('the planner ran after the answer', plans.length >= 1)
    t.ok('and its prompt names the decision', plans.every((p) => p.prompt.includes('### decisions') && p.prompt.includes(ANSWER)))
    t.ok('the run carried on to the end', run.status !== 'paused', `${run.status}/${run.blockedReason}`)
    await releaseWorkspace(engine)
  }

  t.section('2. an evidence refresh after the answer does not drop it')
  {
    const base = scriptFor({ operatorRequest: { stepId: 'brief-plan', request }, planReviews: [[blocking('P1')], []] })
    let refreshed = false
    const { seen, script } = recording((turn) => {
      if (turn.stepId === 'brief-plan' && turn.round === 1 && !refreshed) {
        refreshed = true
        return `Briefing.${NL}${fence({ targetRole: 'planner', prompt: 'Work on brief-plan with fresh evidence', rationale: 'because', windowDecision: 'refresh-evidence' })}`
      }
      return base(turn)
    })
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const { engine, run, decision } = await pauseAndAnswer(t, f)
    t.ok('the window was reset past the answer (the observed condition)', Number(run.windowResetAfter) > Number(decision?.number), `windowResetAfter ${run.windowResetAfter}, decision ${decision?.number}`)
    t.eq('and the cycle restarted from triage', run.steps.filter((s) => s.stepId === 'triage').length, 2)
    // One plan before the reset (round 0, whose audit blocked), then the new cycle's.
    t.ok('the plan turns after the reset ran', planPrompts(seen).length >= 2, `${planPrompts(seen).length} plan turns`)
    t.ok('every plan prompt names the answer', planPrompts(seen).every((p) => p.prompt.includes(ANSWER)))
    t.ok('none says nothing was decided', planPrompts(seen).every((p) => !p.prompt.includes(EMPTY)))
    const confirm = seen.filter((s) => s.stepId === 'confirm').at(-1)
    t.ok('the coordinator\'s confirmation is given it too', !confirm || confirm.prompt.includes(ANSWER))
    await releaseWorkspace(engine)
  }

  t.section('3. a plan restart after the answer does not drop it')
  {
    const base = scriptFor({ operatorRequest: { stepId: 'brief-plan', request } })
    let restarted = false
    const { seen, script } = recording((turn) => {
      if (turn.stepId === 'brief-implement' && !restarted) {
        restarted = true
        return `Briefing.${NL}${fence({ targetRole: 'planner', prompt: 'The approved plan is wrong; plan again', rationale: 'because', restartPlan: true })}`
      }
      return base(turn)
    })
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const { engine, run, decision } = await pauseAndAnswer(t, f)
    const resets = Object.entries(run.coordinatorEffects ?? {}).filter(([, e]) => e.reset === 'plan')
    t.eq('the plan was restarted once, after the answer', resets.map(([n]) => Number(n) > Number(decision?.number)), [true])
    const plans = planPrompts(seen)
    t.ok('the planner planned again in the new cycle', plans.length >= 2)
    t.ok('and the new cycle\'s plan prompt names the answer', plans.at(-1).prompt.includes(ANSWER) && !plans.at(-1).prompt.includes(EMPTY))
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
