import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — what a participant is actually given, and what a review owes the plan'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)

const start = (f, extra = {}) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath,
  projectPath: f.projectPath,
  harnesses: f.harnesses,
  stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot,
  probe: f.probe,
  clock: f.clock,
  deliveryProvider: f.delivery,
  ...extra
})

/** Wrap a script so every prompt is captured by step id and attempt. */
const recording = (script) => {
  const seen = []
  return { seen, script: (turn) => { seen.push({ ...turn }); return script(turn) } }
}

const countOf = (run, stepId) => run.steps.filter((s) => s.stepId === stepId).length

/**
 * plan-and-implement has no separate revise step: the plan step runs again in
 * the next round. A later round's plan says so, so a test can tell drafts apart.
 */
const revisingPlans = (base) => (turn) => turn.stepId === 'plan' && turn.round > 0
  ? `A revised plan (round ${turn.round}).${NL}${fence({ summary: 'the revised plan', basedOnRevision: null, resolves: [] })}`
  : base(turn)

export default async function (t) {
  // ------------------------------------------------------------ materialized context
  t.section('1. an authored prompt arrives with the named context, verbatim')
  {
    const { seen, script } = recording(scriptFor())
    const f = await engineFixture({ script, playbook: 'plan-and-implement' })
    const engine = await start(f)
    await engine.drive()

    // The planner's plan turn: everything its context names arrives as the
    // recorded value, appended by the engine.
    const planTurn = seen.find((s) => s.stepId === 'plan')
    t.ok('the planner got the engine context block', planTurn.prompt.includes('## Context supplied by the engine'))
    t.ok('including the acceptance criteria', planTurn.prompt.includes('### acceptanceCriteria') && planTurn.prompt.includes('"id": "AC1"'))
    t.ok('and the issue', planTurn.prompt.includes('### issue') && planTurn.prompt.includes(f.issue.id))
    t.ok('and the coordinator\'s brief', planTurn.prompt.includes('### steps.brief-plan.output.prompt') && planTurn.prompt.includes('Work on brief-plan (round 0)'))
    // The audit is a strategy-owned template with the plan and the criteria
    // rendered into it as recorded values.
    const audit = seen.find((s) => s.stepId === 'audit-plan-1')
    t.ok('the auditor got the plan itself, not a pointer to it', audit.prompt.includes('### plan.current' + NL + 'A plan.'))
    t.ok('and the acceptance criteria', audit.prompt.includes('"id": "AC1"'))
    t.ok('and the strategy\'s own audit instructions', audit.prompt.includes('Independently audit the current artifact'))

    const implement = seen.find((s) => s.stepId === 'implement')
    t.ok('the planner implementing got the approved plan', implement.prompt.includes('### plan.approved' + NL + 'A plan.'))
    const implAudit = seen.find((s) => s.stepId === 'audit-implement-1')
    t.ok('and the implementation auditor got the plan-review findings section', implAudit.prompt.includes('### findings.plan'))

    // The tactical orient template names no issue placeholders; the issue
    // arrives once, as appended context.
    const triage = seen.find((s) => s.stepId === 'triage')
    t.ok('the triage turn gets the issue as context', triage.prompt.includes('### issue') && triage.prompt.includes(f.issue.id))
    t.ok('exactly once', (triage.prompt.match(/### issue\n/g) ?? []).length === 1)

    const record = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
    t.eq('the run record carries the issue folder', record.issue.path, f.issuePath)
    await releaseWorkspace(engine)
  }

  t.section('2. the contract is stated as a definition, and the scratch directory is offered')
  {
    const { seen, script } = recording(scriptFor())
    const f = await engineFixture({ script })
    const engine = await start(f)
    await engine.drive({ maxTurns: 3 })

    const implement = seen.find((s) => s.stepId === 'implement')
    t.ok('the implementer is told which contract', implement.prompt.includes('`authorArtifact` contract'))
    t.ok('and what it requires', implement.prompt.includes('summary (required)') && implement.prompt.includes('basedOnRevision (optional)'))
    t.ok('with the description of the tricky field', implement.prompt.includes('computed by the engine from the worktree after the turn'))

    const scratch = engine.run.workspace.scratchPath
    t.ok('a scratch directory exists under the run', scratch && scratch.startsWith(path.join(f.issuePath, 'runs')) && !scratch.startsWith(engine.run.workspace.path))
    t.ok('it is on disk', await fs.stat(scratch).then((s) => s.isDirectory(), () => false))
    t.ok('every worker prompt names it', seen.filter(s => s.role !== 'coordinator').every((s) => s.prompt.includes(scratch)))
    t.ok('coordinators receive the delegation policy instead of scratch work instructions', seen.filter(s => s.role === 'coordinator').every(s => s.prompt.includes('Tools are disabled.') && !s.prompt.includes('Scratch directory for temporary files')))

    const snapshot = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'resolved-playbook.json'), 'utf8'))
    t.ok('the snapshot embeds the contract definitions', typeof snapshot.contracts?.defs?.authorArtifact === 'object')
    t.ok('with their hash', /^sha256:/.test(snapshot.contracts?.hash ?? ''))
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ repair diagnostics
  t.section('3. a repair prompt says exactly what was wrong')
  {
    const base = scriptFor()
    const { seen, script } = recording((turn) =>
      turn.stepId === 'implement' && turn.attempt === 1
        ? `A change with the wrong shape.${NL}${fence({ notes: 'no summary here' })}`
        : base(turn))
    const f = await engineFixture({ script })
    const engine = await start(f)
    const run = await engine.drive()

    const repair = seen.find((s) => s.stepId === 'implement' && s.attempt === 2)
    t.ok('a repair turn happened', Boolean(repair))
    t.ok('it names the missing field', repair.prompt.includes('missing summary'), repair.prompt.split(NL).find((l) => l.includes('not accepted')))
    t.ok('and restates the contract definition', repair.prompt.includes('summary (required)'))
    t.eq('the run then completes', run.outcome, 'resolved')

    const outputs = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'outputs', run.steps.find((s) => s.stepId === 'implement' && s.attempt === 1).number + '.json'), 'utf8'))
    t.eq('the rejected output is classified', outputs.classification, 'contract-violation')
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ plan findings
  t.section('4. a plan finding the implementation dropped keeps the loop open')
  {
    // P1 raised against the plan, resolved in the revised plan; the first
    // implementation audit says it was deferred, the second says addressed.
    const f = await engineFixture({
      playbook: 'plan-and-implement',
      script: scriptFor({
        planReviews: [[blocking('P1')], []],
        planDispositions: (round) => (round === 0 ? { P1: 'deferred' } : { P1: 'addressed' })
      })
    })
    const engine = await start(f)
    const seenOutstanding = []
    engine.hooks.beforeInvoke = async (e) => {
      const p = Object.values(e.run.participants).find((x) => x.pendingInvocation)
      const cursor = p?.pendingInvocation.cursor
      if (cursor?.stepId === 'implement' && cursor.round > 0) seenOutstanding.push(structuredClone(e.run.outstandingFindings))
    }
    const run = await engine.drive()
    t.eq('the plan was drafted twice', countOf(run, 'plan'), 2)
    t.eq('the planner was sent back to implement', countOf(run, 'implement'), 2)
    t.ok('and was owed the deferred plan finding', seenOutstanding[0]?.some((x) => x.id === 'P1' && x.source === 'plan-review' && x.disposition === 'deferred'),
      JSON.stringify(seenOutstanding[0]))
    t.eq('the auditor looked at the code twice', countOf(run, 'audit-implement-1'), 2)
    t.eq('and once addressed, the run closes', run.outcome, 'resolved')
    t.eq('with nothing outstanding', run.outstandingFindings.length, 0)
    await releaseWorkspace(engine)
  }

  t.section('5. approving while deferring a blocking plan finding is a contradiction')
  {
    const base = scriptFor({ planReviews: [[blocking('P1')], []] })
    const { seen, script } = recording((turn) =>
      turn.stepId === 'audit-implement-1'
        ? `Looks fine to me.${NL}${fence({ verdict: 'approved', artifactRevision: (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], findings: [], priorFindings: [{ id: 'P1', disposition: 'deferred', reason: 'later' }] })}`
        : base(turn))
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const engine = await start(f)
    const run = await engine.drive()
    const repair = seen.find((s) => s.stepId === 'audit-implement-1' && s.attempt === 2)
    t.ok('the auditor was asked to restate', Boolean(repair))
    t.ok('and told why', repair.prompt.includes('contradicts priorFindings') && repair.prompt.includes('P1'), repair.prompt.split(NL).find((l) => l.includes('not accepted')))
    t.eq('the planner was never sent to fix a contradiction', countOf(run, 'implement'), 1)
    t.eq('exhausted repair blocks', run.blockedReason, 'protocol-repair-exhausted')
    t.ok('the run did not close', run.outcome !== 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('6. an implementation review that ignores the plan findings is repaired')
  {
    const base = scriptFor({ planReviews: [[blocking('P1')], []] })
    let restated = false
    const { seen, script } = recording((turn) => {
      if (turn.stepId === 'audit-implement-1' && turn.attempt === 1) {
        return `Reviewed.${NL}${fence({ verdict: 'approved', artifactRevision: (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], findings: [] })}`
      }
      if (turn.stepId === 'audit-implement-1') restated = true
      return base(turn)
    })
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const engine = await start(f)
    const run = await engine.drive()
    const repair = seen.find((s) => s.stepId === 'audit-implement-1' && s.attempt === 2)
    t.ok('a repair was requested', Boolean(repair))
    t.ok('naming the finding without a disposition', repair.prompt.includes('priorFindings must state a disposition') && repair.prompt.includes('P1'))
    t.ok('the same participant restated', restated)
    t.eq('and with dispositions supplied the run closes', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('4b. after a revision, later phases receive the revised plan, tied to its audit')
  {
    const { seen, script } = recording(revisingPlans(scriptFor({ planReviews: [[blocking('P1')], []] })))
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('the run closed', run.outcome, 'resolved')
    const secondAudit = seen.filter((s) => s.stepId === 'audit-plan-1').at(-1)
    t.ok('the second plan review saw the revision as the current plan',
      secondAudit.prompt.includes('### plan.current' + NL + 'A revised plan (round 1).'))
    t.ok('not the first draft', !secondAudit.prompt.includes('### plan.current' + NL + 'A plan.'))
    const implement = seen.find((s) => s.stepId === 'implement')
    t.ok('the implementation received the approved (revised) plan', implement.prompt.includes('### plan.approved' + NL + 'A revised plan (round 1).'))
    t.ok('and not the superseded draft', !implement.prompt.includes('### plan.approved' + NL + 'A plan.'))
    const { planOf } = await import('../server/runtime/engine.mjs')
    const snapshot = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'resolved-playbook.json'), 'utf8'))
    const outputs = JSON.parse(JSON.stringify(await (await import('../server/runtime/store.mjs')).readOutputs(f.issuePath, engine.runId)))
    const plan = planOf(run.steps, outputs, snapshot.reviewPolicy)
    const revise = run.steps.filter((s) => s.stepId === 'plan').at(-1)
    const approving = run.steps.filter((s) => s.stepId === 'audit-plan-1').at(-1)
    t.eq('plan.approved names the revised plan step', plan.approvedStep, revise.number)
    t.eq('and the audit that approved it', plan.approvedByStep, approving.number)
    await releaseWorkspace(engine)
  }

  t.section('6b. two dispositions for one finding id are a protocol failure')
  {
    const base = scriptFor({ planReviews: [[blocking('P1')], []] })
    const { seen, script } = recording((turn) => {
      if (turn.stepId === 'audit-implement-1' && turn.attempt === 1) {
        return `Reviewed.${NL}${fence({ verdict: 'approved', artifactRevision: (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0], findings: [], priorFindings: [{ id: 'P1', disposition: 'deferred', reason: 'later' }, { id: 'P1', disposition: 'addressed', reason: 'done' }] })}`
      }
      return base(turn)
    })
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const engine = await start(f)
    const run = await engine.drive()
    const repair = seen.find((s) => s.stepId === 'audit-implement-1' && s.attempt === 2)
    t.ok('the auditor was asked to restate', Boolean(repair))
    t.ok('naming the duplicated id', repair.prompt.includes('more than once') && repair.prompt.includes('P1'), repair.prompt.split(NL).find((l) => l.includes('not accepted')))
    t.eq('the contradictory review did not approve anything', run.approvals.filter((a) => a.step === run.steps.find((s) => s.stepId === 'audit-implement-1' && s.attempt === 1).number).length, 0)
    t.eq('with a clean restatement the run closes', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('9. output is judged by the snapshot\'s contracts, not the schema file on disk')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive({ maxTurns: 1 })
    // Tighten the live schema after the run started: triageResult now demands a field nobody sends.
    const file = path.join(f.configRoot, 'schemas', 'agent-outputs.schema.json')
    const schema = JSON.parse(await fs.readFile(file, 'utf8'))
    schema.$defs.authorArtifact.required.push('impossibleField')
    await fs.writeFile(file, JSON.stringify(schema))
    const run = await engine.drive()
    t.eq('the run still completes under its original contracts', run.outcome, 'resolved')
    const implement = run.steps.find((s) => s.stepId === 'implement')
    t.eq('the implementation was accepted', JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'outputs', `${implement.number}.json`), 'utf8')).valid, true)
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ revision and usage contracts
  t.section('7a. the engine owns the resulting revision; the author echoes what it started from')
  {
    const { seen, script } = recording(scriptFor({ implReviews: [[blocking('F1')], []] }))
    const f = await engineFixture({ script })
    const engine = await start(f)
    const run = await engine.drive()
    // The implementation loop's correction is the next round's implement turn.
    const [implement, fix] = seen.filter((s) => s.stepId === 'implement')
    t.ok('the first implementation is told no candidate exists', implement.prompt.includes('No candidate exists yet'))
    t.ok('a correcting turn is told the revision it starts from', fix?.prompt.includes('echo it as basedOnRevision'))
    const [implStep, fixStep] = run.steps.filter((s) => s.stepId === 'implement')
    t.eq('the first implementation recorded null as its base', implStep.basedOnRevision, null)
    t.eq('the correction recorded the implementation\'s revision as its base', fixStep.basedOnRevision, implStep.revision)
    // The fake author changes nothing, so the resulting revision equals the base: same content, same identity.
    t.ok('and its own resulting revision, computed by the engine', typeof fixStep.revision === 'string' && fixStep.revision.startsWith('sha256:'))
    t.eq('the run closed', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('7b. an author that claims a different starting revision is repaired')
  {
    const base = scriptFor({ implReviews: [[blocking('F1')], []] })
    const { seen, script } = recording((turn) =>
      turn.stepId === 'implement' && turn.round > 0 && turn.attempt === 1
        ? `Fixed.${NL}${fence({ summary: 'the fix', basedOnRevision: 'sha256:' + 'f'.repeat(64), resolves: ['F1'] })}`
        : base(turn))
    const f = await engineFixture({ script })
    const engine = await start(f)
    const run = await engine.drive()
    const repair = seen.find((s) => s.stepId === 'implement' && s.round > 0 && s.attempt === 2)
    t.ok('the same participant was asked to restate', Boolean(repair))
    t.ok('and told the revision it was given', repair.prompt.includes('is not the revision this turn started from'), repair.prompt.split(NL).find((l) => l.includes('not accepted')))
    t.eq('the run still closes after the restatement', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('7c. what each turn cost is on the step and in the budget')
  {
    const f = await engineFixture()
    // The fake harness reports usage per turn; give it cost and provider categories.
    const original = f.fake.invoke
    f.fake.invoke = async (args) => ({ ...(await original(args)), usage: { provider: 'anthropic', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 100, cacheReadTokens: 1000, tokens: 1115, costUsd: 0.01 } })
    const engine = await start(f)
    const run = await engine.drive()
    t.ok('every step carries usage', run.steps.every((s) => s.usage?.tokens === 1115), JSON.stringify(run.steps[0].usage))
    t.eq('the budget counts provider totals, cache included', run.budgets.used.tokens, 1115 * run.steps.length)
    t.ok('and cost', Math.abs(run.budgets.used.costUsd - 0.01 * run.steps.length) < 1e-9, `${run.budgets.used.costUsd}`)
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ activity
  t.section('7. what the runtime is seen doing is recorded on the pending invocation')
  {
    const f = await engineFixture()
    const engine = await start(f)
    let observed = null
    engine.hooks.afterInvokeBeforePersist = async (e) => {
      const p = Object.values(e.run.participants).find((x) => x.pendingInvocation)
      observed ??= structuredClone(p.pendingInvocation.activity)
    }
    await engine.drive({ maxTurns: 1 })
    t.ok('activity was recorded', observed && observed.events > 0, JSON.stringify(observed))
    t.eq('with what it was doing', observed?.lastKind, 'tool-use')
    t.ok('and when', typeof observed?.lastAt === 'string')
    t.ok('and by which process', Number.isInteger(observed?.pid))
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ closure record
  t.section('8. residual risks named at closure are kept on the run')
  {
    const base = scriptFor()
    const f = await engineFixture({ script: (turn) => {
      if (turn.stepId !== 'confirm') return base(turn)
      const rev = (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0]
      return `Report.${NL}${fence({ satisfied: true, revision: rev, criteria: [{ id: 'AC1', met: true, evidence: 'read' }], residualRisks: [{ description: 'default stays permissive unless configured', relatesTo: 'F2', accepted: true }], reasoning: 'ok' })}`
    } })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('closed', run.outcome, 'resolved')
    t.eq('one residual risk recorded', run.closure.residualRisks.length, 1)
    t.eq('with its text', run.closure.residualRisks[0].description, 'default stays permissive unless configured')
    t.eq('delivery was verified by reconstruction or by the fake', run.delivery.completedAt !== null, true)
    await releaseWorkspace(engine)
  }

  t.section('9. a handoff repair that converges on the prompt limit does not block the run')
  {
    const attempts = (run) => run.steps.filter((s) => s.stepId === 'brief-implement').map((s) => s.attempt)
    const briefing = (sizes, extra = {}) => {
      const base = scriptFor()
      return (turn) => turn.stepId === 'brief-implement'
        ? `Briefing.${NL}${fence({ targetRole: 'implementer', prompt: 'x'.repeat(sizes[turn.attempt - 1]), ...extra })}`
        : base(turn)
    }

    const f = await engineFixture({ script: briefing([2700, 2450, 2402]) })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('the recorded case: three attempts, the last at 2402', attempts(run), [1, 2, 3])
    t.eq('the run went on and closed', `${run.outcome}/${run.blockedReason ?? null}`, 'resolved/null')
    const last = run.steps.find((s) => s.stepId === 'brief-implement' && s.attempt === 3)
    t.eq('the output says what was tolerated', engine.outputs[last.number].tolerated, { path: '/prompt', limit: 2400, length: 2402, lengths: [2700, 2450, 2402] })
    await releaseWorkspace(engine)

    // Counted in characters, as the schema counts: one emoji is two UTF-16 units.
    const texts = (prompts) => {
      const base = scriptFor()
      return (turn) => turn.stepId === 'brief-implement'
        ? `Briefing.${NL}${fence({ targetRole: 'implementer', prompt: prompts[turn.attempt - 1] })}`
        : base(turn)
    }
    const mixed = (emojis, plain) => '😀'.repeat(emojis) + 'x'.repeat(plain)

    const fm = await engineFixture({ script: texts(['x'.repeat(2700), 'x'.repeat(2450), mixed(121, 2281)]) })
    const em = await start(fm)
    const rm = await em.drive()
    t.eq('2402 characters in 2523 UTF-16 units: the run went on and closed', `${rm.outcome}/${rm.blockedReason ?? null}`, 'resolved/null')
    await releaseWorkspace(em)

    const fn = await engineFixture({ script: texts([mixed(150, 2300), mixed(50, 2400), 'x'.repeat(2460)]) })
    const en = await start(fn)
    const rn = await en.drive()
    t.eq('[2450, 2450, 2460] characters: the same attempts', attempts(rn), [1, 2, 3])
    t.eq('[2450, 2450, 2460] characters: the same block, though UTF-16 lengths shrink', `${rn.status}/${rn.blockedReason}`, 'blocked/protocol-repair-exhausted')
    await releaseWorkspace(en)

    const blocked = [
      ['far over the limit', briefing([4000, 3500, 3000])],
      ['not converging', briefing([2402, 2402, 2402])],
      ['a short miss with another violation', briefing([2700, 2450, 2402], { extra: true })]
    ]
    for (const [label, script] of blocked) {
      const g = await engineFixture({ script })
      const e = await start(g)
      const r = await e.drive()
      t.eq(`${label}: the same attempts`, attempts(r), [1, 2, 3])
      t.eq(`${label}: the same block`, `${r.status}/${r.blockedReason}`, 'blocked/protocol-repair-exhausted')
      await releaseWorkspace(e)
    }
  }

  await cleanupFixtures()
}
