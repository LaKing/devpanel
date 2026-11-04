import fs from 'node:fs/promises'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { continueUnavailable } from '../server/runtime/run-control.mjs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

/*
 * A run whose coordinator refuses closure the first time (a test drive that
 * crashed, say), then is continued by the operator: the author gets one more
 * round in the same run, and the run closes on the next confirmation.
 */
async function scenario () {
  const prompts = []
  let engine = null
  let confirms = 0
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    prompts.push({ stepId, role, round, prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, `round-${round}.txt`), 'work\n')
      return fence({ summary: `Implemented round ${round}`, basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') {
      confirms++
      // A matter for the operator (owner-gate), so the engine does not return
      // it to the author itself: the run stops and Continue reopens it.
      return confirms === 1
        ? fence({ satisfied: false, criteria: [{ id: 'AC1', met: false, unmet: 'owner-gate', evidence: 'the test drive did not boot' }], revision: revision(prompt) })
        : fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    }
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  return { engine, f, prompts }
}

export default async function (t) {
  t.section('a run stopped at closure is continued: one more author round, then closure')
  {
    const { engine, f, prompts } = await scenario()
    t.eq('the first confirmation stops the run at closure', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked closure-conditions-unmet', JSON.stringify(engine.run.closure?.conditions))
    t.eq('an operator matter is not returned to the author', [engine.run.closureReturns ?? [], engine.run.closure?.notReturned], [[], 'AC1: owner-gate'])
    t.ok('continue is offered beside refresh-checks', supportedActions(engine.run).includes('continue'), JSON.stringify(supportedActions(engine.run)))
    t.eq('resume is not: replaying the record would reach the same closure', supportedActions(engine.run).includes('resume'), false)

    const first = Number(engine.run.steps[0].number)
    const note = `${String(first + 40).padStart(3, '0')}-note`
    await fs.mkdir(path.join(f.issuePath, note))
    await fs.writeFile(path.join(f.issuePath, note, 'note.md'), '# Diagnosis\n\nThe boot fails in module.mjs:11.\n')

    t.eq('an unnamed actor is refused', await engine.continueRun({ text: 'x', actor: '' }).then(() => null, (e) => e.status), 400)
    const entry = await engine.continueRun({ text: 'Fix the boot crash first.', actor: 'tester' })
    t.eq('the note written since the run began is carried', entry.notes, [note])
    t.eq('the run is pending again', engine.run.status, 'pending')
    const decision = engine.run.steps.at(-1)
    t.eq('recorded as an operator decision step', `${decision.role} ${decision.decision?.key}`, 'operator implement-review:continue')
    t.ok('the decision carries the instruction, the closure record and the note', ['Fix the boot crash first.', 'closure-conditions-unmet', 'coordinatorConfirmation', 'module.mjs:11'].every((s) => decision.decision.answer.includes(s)), decision.decision.answer)

    await engine.drive()
    t.eq('the continued run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('the author got exactly one more round', prompts.filter((p) => p.stepId === 'implement').map((p) => p.round), [0, 1])
    const brief1 = prompts.find((p) => p.stepId === 'brief-implement' && p.round === 1)
    t.ok('the next brief read the operator decision', brief1?.prompt.includes('Fix the boot crash first.') && brief1.prompt.includes('module.mjs:11'))
    t.eq('the first confirmation is superseded, a new one ran', prompts.filter((p) => p.stepId === 'confirm').length, 2)
    t.ok('the earlier confirmation is out of the active record', engine.run.supersededSteps?.length === 1)
    t.ok('a completed run cannot be continued', Boolean(continueUnavailable(engine.run)))
    t.eq('a second Continue would not carry the same note again', (await engine.notesSinceStart()).length, 0)
    await releaseWorkspace(engine)
  }

  t.section('Continue refuses when the wall clock left is below the mean round, naming both')
  {
    const hour = 60 * 60_000
    // Every completed round but one is cleared: one round of an hour, on the stopped run's record.
    const aRound = (engine) => {
      const audit = engine.run.steps.find((s) => engine.outputs[s.number]?.contract === 'reviewResult')
      for (const s of engine.run.steps) if (s !== audit && s.phase === audit.phase) Object.assign(s, { endedAt: s.startedAt, durationMs: 0 })
      audit.endedAt = new Date(Date.parse(audit.startedAt) + hour).toISOString()
    }
    {
      const { engine } = await scenario()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      const steps = engine.run.steps.length
      const refused = await engine.continueRun({ text: 'x', actor: 'supervisor' }).then(() => null, (e) => e)
      t.eq('refused, with the code and the mean in detail', [refused?.status, refused?.code, refused?.detail?.meanRoundMs, refused?.detail?.rounds], [422, 'WALL_CLOCK_SHORT', hour, 1])
      t.ok('and both numbers in the message any caller reads', refused?.message.includes('30 min') && refused.message.includes('60 min'), refused?.message)
      t.eq('no decision step, and still stopped', [engine.run.steps.length, engine.run.status, engine.run.continueHistory ?? []], [steps, 'blocked', []])
      const entry = await engine.continueRun({ text: 'x', actor: 'tester', acceptShortWallClock: true })
      t.eq('an explicit override passes and is recorded', [entry.wallClock.overridden, engine.run.continueHistory.at(-1).wallClock.meanRoundMs], [true, hour])
      await releaseWorkspace(engine)
    }
    {
      const { engine } = await scenario()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      const entry = await engine.continueRun({ text: 'x', actor: 'tester', budgets: { wallClockMinutes: 90 } })
      t.eq('a raise that holds a round passes', [entry.wallClock.overridden, entry.limits.wallClockMinutes], [false, 90])
      await releaseWorkspace(engine)
    }
    {
      const { engine } = await scenario()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.startedAt = new Date(Date.parse(engine.run.endedAt) - 40 * 60_000).toISOString()
      const steps = engine.run.steps.length
      const spent = await engine.continueRun({ text: 'x', actor: 'tester', acceptShortWallClock: true }).then(() => null, (e) => e)
      t.eq('exhausted: the override does not get past it', [spent?.status, spent?.code, spent?.detail?.remainingMs, spent?.detail?.meanRoundMs, engine.run.steps.length], [422, 'WALL_CLOCK_EXHAUSTED', 0, hour, steps])
      t.ok('and the message names both', spent?.message.includes('0 min remaining of 30') && spent.message.includes('60 min'), spent?.message)
      await releaseWorkspace(engine)
    }
    {
      const { engine } = await scenario()
      aRound(engine)
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.budgets.limits.maxSteps = 1
      const steps = engine.run.steps.length
      const other = await engine.continueRun({ text: 'x', actor: 'tester', acceptShortWallClock: true }).then(() => null, (e) => e)
      t.ok('another budget exhausted: its refusal names both numbers too', other?.status === 422 && /exhausted budget/.test(other.message) && other.message.includes('30 min') && other.message.includes('60 min'), other?.message)
      t.eq('with both in detail, and the override does not get past it', [other?.detail?.remainingMs, other?.detail?.meanRoundMs, engine.run.steps.length], [30 * 60_000, hour, steps])
      await releaseWorkspace(engine)
    }
    {
      const { engine } = await scenario()
      for (const output of Object.values(engine.outputs)) if (output.contract === 'reviewResult') output.contract = 'cleared'
      engine.run.budgets.limits.wallClockMinutes = 30
      engine.run.startedAt = new Date(Date.parse(engine.run.endedAt) - 40 * 60_000).toISOString()
      const spent = await engine.continueRun({ text: 'x', actor: 'tester' }).then(() => null, (e) => e)
      t.ok('exhausted with no completed round says so', spent?.code === 'WALL_CLOCK_EXHAUSTED' && /no mean round time/.test(spent.message), spent?.message)
      await releaseWorkspace(engine)
    }
  }
}
