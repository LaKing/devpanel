import path from 'node:path'
import fs from 'node:fs/promises'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { triageProblem, plan } from '../server/runtime/engine.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { readRun, readOutputs } from '../server/runtime/store.mjs'
import { attentionList } from '../server/attention.mjs'
import { renderResult } from '../server/run-result-step.mjs'
import { createOwnerInput } from '../server/owner-input.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'
import { patch } from './helpers.mjs'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj, null, 2), '```'].join(NL)
const triage = (autonomy, extra = {}) => fence({ fit: true, reasoning: 'r', acceptanceCriteria: [{ id: 'AC1', statement: 'it works' }], autonomy, ...extra })

const launch = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

/** scriptFor, with the triage turn replaced by `answers[attempt - 1]` (the last one repeats). */
const withTriage = (answers, base = scriptFor()) => (turn) => turn.stepId === 'triage' ? answers[Math.min(turn.attempt, answers.length) - 1] : base(turn)

const QUESTIONS = [
  { id: 'Q1', question: 'Charge the first delegated round before admission?', category: 'authorization', recommendation: 'Yes, as a bounded overrun.' },
  { id: 'Q2', question: 'Confirm the plan before implementation?', category: 'owner-gate', recommendation: 'Approve.' }
]

export default async (t) => {
  t.section('1. the autonomy verdict must agree with itself')
  {
    const ok = { fit: true, autonomy: { verdict: 'autonomous', reason: 'r' } }
    t.eq('autonomous with nothing else is fine', triageProblem(ok), null)
    t.eq('an older triage without a verdict is not checked', triageProblem({ fit: true }), null)
    t.eq('an unfit triage is not checked', triageProblem({ fit: false, autonomy: { verdict: 'autonomous', reason: 'r', questions: QUESTIONS } }), null)
    t.ok('autonomous with questions is refused', /autonomous/.test(triageProblem({ fit: true, autonomy: { verdict: 'autonomous', reason: 'r', questions: QUESTIONS } }) ?? ''))
    t.ok('needs-owner-input without questions is refused', /needs autonomy.questions/.test(triageProblem({ fit: true, autonomy: { verdict: 'needs-owner-input', reason: 'r' } }) ?? ''))
    t.ok('too-large needs two parts', /at least two parts/.test(triageProblem({ fit: true, autonomy: { verdict: 'too-large', reason: 'r', split: [{ title: 'a', scope: 'a' }] } }) ?? ''))
    t.ok('a run that will not start writes no first assignment', /omit firstHandoff/.test(triageProblem({ fit: true, autonomy: { verdict: 'needs-owner-input', reason: 'r', questions: QUESTIONS }, firstHandoff: { targetRole: 'implementer', prompt: 'go' } }) ?? ''))
    t.ok('continue contradicts asking the owner', /needs-input/.test(triageProblem({ fit: true, suggestion: { action: 'continue', reason: 'go' }, autonomy: { verdict: 'needs-owner-input', reason: 'r', questions: QUESTIONS } }) ?? ''))
    t.ok('needs-input contradicts autonomous', /contradicts/.test(triageProblem({ fit: true, suggestion: { action: 'needs-input', reason: 'x' }, autonomy: { verdict: 'autonomous', reason: 'r' } }) ?? ''))
    t.ok('question ids are unique', /repeats Q1/.test(triageProblem({ fit: true, autonomy: { verdict: 'needs-owner-input', reason: 'r', questions: [QUESTIONS[0], QUESTIONS[0]] } }) ?? ''))
  }

  t.section('2. a triage that needs the owner ends the run after one turn instead of pausing')
  let asked
  {
    // The first answer contradicts itself and is repaired; the second is kept.
    const f = await engineFixture({ script: withTriage([
      triage({ verdict: 'autonomous', reason: 'r', questions: QUESTIONS }),
      triage({ verdict: 'needs-owner-input', reason: 'Two decisions belong to the owner.', questions: QUESTIONS }, { suggestion: { action: 'needs-input', reason: 'owner decisions' } })
    ]) })
    const engine = await launch(f)
    const run = await engine.drive()
    t.eq('the run ended, not paused', `${run.status}/${run.outcome}`, 'completed/unresolved', run.blockedReason)
    t.eq('with no pause held', run.pause ?? null, null)
    t.eq('after the triage turn and its repair only', run.steps.map((s) => `${s.stepId}@${s.attempt}`).join(','), 'triage@1,triage@2')
    t.eq('the questions are recorded for the owner', (run.ownerInput?.questions ?? []).map((q) => q.id).join(','), 'Q1,Q2')
    t.eq('attributed to the triage step', run.ownerInput?.askedBy?.stepId, 'triage')
    t.eq('unanswered', run.ownerInput?.answer, null)
    const outputs = await readOutputs(f.issuePath, engine.runId)
    const result = runResult(run, outputs)
    t.eq('its result is needs-input', `${result.result}/${result.resultReason}`, 'needs-input/owner-questions')
    const e = explainRun(run, { outputs })
    t.eq('explained as waiting for the owner', `${e.tone}:${e.headline}`, 'waiting:Waiting for your 2 answers before any work starts')
    t.eq("with triage's reason (the page lists the questions themselves)", e.detail, 'Two decisions belong to the owner.')
    const text = renderResult(run, outputs)
    t.ok('the result account lists what was asked, with the recommendation', text.includes('## Asked before starting') && text.includes('recommended: Yes, as a bounded overrun.'))
    await releaseWorkspace(engine)
    asked = { f, run, engine }
  }

  t.section('3. it is a question on Needs attention, and stops being one once answered')
  {
    const summary = (answered) => ({ runId: 'r1', status: 'completed', outcome: 'unresolved', ownerInput: { verdict: 'needs-owner-input', questions: ['Q one?', 'Q two?'], parts: 0, answered } })
    const list = (answered) => attentionList({ listProjects: async () => ['p'], listIssues: async () => [{ id: 'i', name: 'I', latestRun: summary(answered) }] })
    const open = await list(false)
    t.eq('an unanswered triage is a question', open.map((x) => x.kind).join(','), 'question')
    t.eq('its questions are the detail', open[0]?.detail, 'Q one? · Q two?')
    t.eq('an answered one needs nobody', (await list(true)).length, 0)
    const listed = (await asked.f.issues.listIssues('devpanel-project')).find((i) => i.id === asked.f.issue.id)
    t.eq('the issue list summary carries it', JSON.stringify(listed?.latestRun?.ownerInput), JSON.stringify({ verdict: 'needs-owner-input', questions: QUESTIONS.map((q) => q.question), parts: 0, answered: false }))
  }

  t.section('4. answering writes a note, records the answer once, and starts the same configuration again')
  {
    const { f, engine } = asked
    const starts = []
    const supervisor = { start: async (args) => { starts.push(args); return { runId: 'next-run' } } }
    const owner = createOwnerInput({ issues: f.issues, supervisor, configRoot: f.configRoot })
    let refused = null
    try { await owner.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId, actor: 'op', answers: { Q1: 'yes' } }) } catch (error) { refused = error }
    t.eq('every question needs an answer', refused?.status, 400)
    refused = null
    try { await owner.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId, actor: '', answers: { Q1: 'yes', Q2: 'approve' } }) } catch (error) { refused = error }
    t.eq('an anonymous answer is refused', refused?.status, 400)
    const out = await owner.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId, actor: 'Alice', answers: { Q1: 'Yes, bounded.', Q2: 'Approved.' } })
    t.eq('the start happened', out.started?.runId, 'next-run', JSON.stringify(out.startError))
    t.eq('with the same playbook, pinned to the configuration that asked', `${starts[0]?.playbookId}/${starts[0]?.expectConfigHash === asked.run.playbook.configHash}`, `${f.playbookId}/true`)
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('the answer is on the run', JSON.stringify(run.ownerInput.answer.answers), JSON.stringify({ Q1: 'Yes, bounded.', Q2: 'Approved.' }))
    t.ok('with the note that carries it', /owner-answers$/.test(run.ownerInput.answer.noteStep ?? ''), run.ownerInput.answer.noteStep)
    const note = await fs.readFile(path.join(f.issuePath, run.ownerInput.answer.noteStep, 'note.md'), 'utf8')
    t.ok('the note pairs each question with its answer', note.includes('**Q1. Charge the first delegated round before admission?**') && note.includes('Approved.'))
    t.eq('the result reads as answered', runResult(run, {}).resultLabel, 'Answered — continued in a new run')
    t.eq('naming the run it started', run.ownerInput.answer.startedRun, 'next-run')
    refused = null
    try { await owner.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId, actor: 'op', answers: { Q1: 'no', Q2: 'no' } }) } catch (error) { refused = error }
    t.eq('a second answer is refused', refused?.status, 409)
  }

  t.section('5. a changed playbook is not started on the answer; the answer is kept')
  {
    const f = await engineFixture({ script: withTriage([triage({ verdict: 'needs-owner-input', reason: 'r', questions: [QUESTIONS[0]] })]) })
    const engine = await launch(f)
    await engine.drive()
    await releaseWorkspace(engine)
    await patch(path.join(f.configRoot, 'playbooks', `${f.playbookId}.yaml`), 'budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n')
    const starts = []
    const out = await createOwnerInput({ issues: f.issues, supervisor: { start: async (a) => { starts.push(a); return {} } }, configRoot: f.configRoot })
      .answer({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId, actor: 'op', answers: { Q1: 'yes' } })
    t.eq('nothing was started', starts.length, 0)
    t.eq('the refusal says why', out.startError?.status, 409)
    const kept = await readRun(f.issuePath, engine.runId)
    t.ok('and the answer stands', Boolean(kept.ownerInput.answer))
    t.eq('with the refusal on record, explained', explainRun(kept).headline, "Answered, but the next run didn't start")
  }

  t.section('6. too large for one run: the split is proposed, and accepting it makes the issues')
  {
    const split = [{ title: 'Adapter for the Live endpoint', scope: 'The session adapter only.' }, { title: 'Catalog and defaults', scope: 'Lift the exclusion.' }]
    const f = await engineFixture({ script: withTriage([triage({ verdict: 'too-large', reason: 'Two runs of work.', split }, { suggestion: { action: 'needs-input', reason: 'split' } })]) })
    const engine = await launch(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    t.eq('ended after triage', `${run.status}/${run.steps.length}`, 'completed/1')
    t.eq('with the split recorded', run.ownerInput?.split?.length, 2)
    t.eq('its result names the split', runResult(run, {}).resultReason, 'owner-split')
    const starts = []
    const archivedPart = await f.issues.createIssue('devpanel-project', { name: split[0].title })
    await f.issues.setIssueArchived('devpanel-project', archivedPart.id, true, { overrideReason: 'test' })
    const out = await createOwnerInput({ issues: f.issues, supervisor: { start: async (a) => { starts.push(a); return {} } }, configRoot: f.configRoot })
      .answer({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId, actor: 'op', split: 'accept' })
    t.eq('a part whose id an archived issue holds gets its own', out.answer.createdIssues[0], `${archivedPart.id}-2`)
    t.eq('two issues were created', out.answer.createdIssues.length, 2)
    t.eq('and nothing started', starts.length, 0)
    const issue = await f.issues.getIssue('devpanel-project', f.issue.id)
    t.eq('the original is split, naming them', `${issue.disposition?.value}:${(issue.disposition?.related ?? []).length}`, 'split:2')
    const [first, second] = out.answer.createdIssues
    t.eq('the parts are chained in their order', (await f.issues.getIssue('devpanel-project', second)).dependsOn?.issues, [{ project: 'devpanel-project', id: first }])
    t.eq('the first part waits for nothing', (await f.issues.getIssue('devpanel-project', first)).dependsOn, null)
  }

  t.section('7. exhausted rounds: one more round when converging, none otherwise, and nobody is asked')
  {
    const capped = async (implReviews) => {
      const f = await engineFixture({ script: scriptFor({ implReviews }) })
      await patch(path.join(f.configRoot, 'playbooks', 'implementation.yaml'), 'budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n')
      const engine = await launch(f)
      const run = await engine.drive()
      await releaseWorkspace(engine)
      return run
    }
    const converging = await capped([[blocking('F1'), blocking('F2')], [blocking('F1')], []])
    t.eq('two findings then one: a third round, and it passed', `${converging.status}/${converging.outcome}`, 'completed/resolved', converging.blockedReason)
    t.eq('three audits ran', converging.steps.filter((s) => s.stepId === 'audit-implement-1').length, 3)
    const stuck = await capped([[blocking('F1')], [blocking('F1')], []])
    t.eq('no progress: ends unresolved at the cap', `${stuck.status}/${stuck.blockedReason}`, 'blocked/rounds-exhausted')
    t.eq('after two audits', stuck.steps.filter((s) => s.stepId === 'audit-implement-1').length, 2)
    t.eq('without a question', stuck.steps.filter((s) => s.role === 'operator').length, 0)
    const still = await capped([[blocking('F1'), blocking('F2')], [blocking('F1')], [blocking('F1')]])
    t.eq('the extra round is granted once', `${still.status}/${still.steps.filter((s) => s.stepId === 'audit-implement-1').length}`, 'blocked/3')

    // Resume after the automatic round still buys a round of its own.
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1'), blocking('F2')], [blocking('F1')], [blocking('F1')], []] }) })
    await patch(path.join(f.configRoot, 'playbooks', 'implementation.yaml'), 'budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n')
    const engine = await launch(f)
    await engine.drive()
    t.eq('blocked after the extra round', `${engine.run.blockedReason}/${engine.run.steps.filter((s) => s.stepId === 'audit-implement-1').length}`, 'rounds-exhausted/3')
    await engine.resumeExecution()
    const resumed = await engine.drive()
    t.eq('resume runs a fourth round, which passes', `${resumed.status}/${resumed.steps.filter((s) => s.stepId === 'audit-implement-1').length}`, 'completed/4', resumed.blockedReason)
    await releaseWorkspace(engine)
  }

  t.section('7b. a loop whose findings oscillate is not converging')
  {
    const capped = async (implReviews, cap) => {
      const f = await engineFixture({ script: scriptFor({ implReviews }) })
      await patch(path.join(f.configRoot, 'playbooks', 'implementation.yaml'), 'budgets:\n', `overrides:\n  implement-review.maxRounds: ${cap}\nbudgets:\n`)
      const engine = await launch(f)
      const run = await engine.drive()
      return { f, engine, run, audits: () => run.steps.filter((s) => s.stepId === 'audit-implement-1').length }
    }
    const minor = (id) => ({ ...blocking(id), severity: 'minor', blocking: false })

    // Fewer findings than the round before, so the count alone would grant it.
    {
      const { engine, run, audits } = await capped([[blocking('F1'), blocking('F2')], [blocking('F2'), blocking('F3')], [blocking('F1')], []], 3)
      t.eq('reported, closed, reopened with fewer findings: ends at the cap', `${run.status}/${run.blockedReason}/${audits()}`, 'blocked/rounds-exhausted/3')
      t.eq('nobody is asked', run.steps.filter((s) => s.role === 'operator').length, 0)
      t.eq('the record names the reopened id', run.extensionDenied, { phase: 'implement-review', round: 2, reopened: ['F1'] })
      const explained = explainRun(run)
      t.ok('the explanation names it', explained.detail.includes('Round 3 reopened F1'), explained.detail)
      await engine.resumeExecution()
      const resumed = await engine.drive()
      t.eq('resume still buys a round, which passes', `${resumed.status}/${resumed.extensionDenied ?? null}`, 'completed/null', resumed.blockedReason)
      await releaseWorkspace(engine)
    }

    // The reported pattern: one finding per round, each one returning.
    {
      const { engine, run, audits } = await capped([[blocking('auditor-1-004')], [blocking('auditor-1-005')], [blocking('auditor-1-004')], [blocking('auditor-1-005')], []], 4)
      t.eq('one finding per round, alternating: ends at the cap', `${run.blockedReason}/${audits()}`, 'rounds-exhausted/4')
      t.ok('and the explanation names the returning id', explainRun(run).detail.includes('reopened auditor-1-005'), explainRun(run).detail)
      await releaseWorkspace(engine)
    }

    // Reopened earlier and still open in the deciding round.
    {
      const { engine, run, audits } = await capped([[blocking('F1'), blocking('F2')], [blocking('F2')], [blocking('F1'), blocking('F2'), blocking('F3')], [blocking('F1')], []], 4)
      t.eq('reopened in an earlier round and still open: no extension', `${run.blockedReason}/${audits()}/${run.extensionDenied?.reopened}`, 'rounds-exhausted/4/F1')
      await releaseWorkspace(engine)
    }

    // Left the substantial findings as a minor note, then came back.
    {
      const { engine, run, audits } = await capped([[blocking('F1'), blocking('F2'), blocking('F3')], [minor('F1'), blocking('F2'), blocking('F3')], [blocking('F1')], []], 3)
      t.eq('downgraded below substantial, then back: reopened', `${run.blockedReason}/${audits()}/${run.extensionDenied?.reopened}`, 'rounds-exhausted/3/F1')
      await releaseWorkspace(engine)
    }

    // Genuine convergence.
    {
      const { engine, run, audits } = await capped([[blocking('F1'), blocking('F2')], [blocking('F1'), blocking('F2'), blocking('F3')], [blocking('F1')], []], 3)
      t.eq('a finding that stayed open is not reopened: extension granted', `${run.status}/${audits()}`, 'completed/4', run.blockedReason)
      t.eq('and no denial is recorded', run.extensionDenied ?? null, null)
      await releaseWorkspace(engine)
    }
    {
      const { engine, run, audits } = await capped([[blocking('F1'), blocking('F2')], [blocking('F2'), blocking('F3')], [blocking('F3')], []], 3)
      t.eq('a finding that closed and stayed closed: extension granted', `${run.status}/${audits()}`, 'completed/4', run.blockedReason)
      await releaseWorkspace(engine)
    }

    // A run extended before reopenings counted: its recorded round still replays.
    {
      const { f, engine, run, audits } = await capped([[blocking('F1'), blocking('F2')], [blocking('F2'), blocking('F3')], [blocking('F1')], []], 4)
      t.eq('the record: four audits, the last passing', `${run.status}/${audits()}`, 'completed/4', run.blockedReason)
      const outputs = await readOutputs(f.issuePath, engine.runId)
      const snapshot = structuredClone(engine.snapshot)
      snapshot.phases.find((p) => p.id === 'implement-review').loop.maxRounds = 3
      const options = { checkResults: engine.checkEvidence() }
      const replayed = plan(snapshot, engine.activeSteps(), outputs, options)
      t.eq('replayed at a cap of three, the recorded extra round stands', `${replayed.kind}/${replayed.reason}/${replayed.extensionDenied ?? null}`, 'terminal/complete/null')
      const cut = engine.activeSteps().filter((s) => !(s.phase === 'implement-review' && s.round === 3))
      const without = plan(snapshot, cut, outputs, options)
      t.eq('without that round on the record it is not granted', `${without.reason}/${without.extensionDenied?.reopened}`, 'rounds-exhausted/F1')
      await releaseWorkspace(engine)
    }
  }

  t.section('8. assumptions the coordinator made are listed in the result')
  {
    const run = { runId: 'r', status: 'completed', outcome: 'resolved', steps: [], playbook: { id: 'implementation' } }
    const outputs = { '003': { valid: true, contract: 'handoff', output: { targetRole: 'implementer', prompt: 'p', assumptions: [{ decision: 'Keep raw ws 8.18.3', reason: 'No new dependency without asking.' }] } } }
    const text = renderResult(run, outputs)
    t.ok('under their own heading, with the step', text.includes('## Assumptions made') && text.includes('- Keep raw ws 8.18.3 — No new dependency without asking. (step 003)'), text)
  }

  t.section('9. a mid-run request says what kind of decision it is, and what the agents recommend')
  {
    const e = explainRun({ status: 'paused', pause: { question: 'Approve the plan?', request: { reason: 'The issue asks to confirm the plan first.', category: 'owner-gate', recommendation: 'Approve: it meets AC1–AC4.' } } })
    t.eq('headed by its category', e.headline, 'Waiting for you: this decision is yours')
    t.ok('with the recommendation', e.detail.includes('Recommended: Approve: it meets AC1–AC4.'), e.detail)
  }

  t.section('10. triage records how it handled a criterion the checks cannot prove')
  {
    const autonomy = { verdict: 'autonomous', reason: 'r' }
    const measured = { id: 'AC2', statement: 'Faster over a week of production traffic', outsideChecks: { handling: 'operator-measurement', reason: 'a live host over time' } }
    const reworded = { id: 'AC1', statement: 'The candidate drive\'s selftest wallMs is below the baseline drive\'s', outsideChecks: { handling: 'reworded', reason: 'one drive per revision, not repeated runs' } }
    t.ok('reworded without the requested wording is refused', /AC1.*outsideChecks.original/.test(triageProblem({ fit: true, autonomy, acceptanceCriteria: [reworded] }) ?? ''))
    const f = await engineFixture({ script: withTriage([
      triage(autonomy, { acceptanceCriteria: [reworded, measured] }),
      triage(autonomy, { acceptanceCriteria: [{ ...reworded, outsideChecks: { ...reworded.outsideChecks, original: 'Selftests run 20% faster over ten runs' } }, measured] })
    ]) })
    const engine = await launch(f)
    const run = await engine.drive()
    t.eq('the first triage was repaired once', run.steps.filter((s) => s.stepId === 'triage').map((s) => s.attempt), [1, 2])
    const outputs = await readOutputs(f.issuePath, engine.runId)
    const recorded = Object.values(outputs).filter((o) => o.valid && o.contract === 'triageResult').at(-1)?.output?.acceptanceCriteria ?? []
    t.eq('the triage output records each handling', recorded.map((c) => [c.id, c.outsideChecks?.handling, c.outsideChecks?.original ?? null]),
      [['AC1', 'reworded', 'Selftests run 20% faster over ten runs'], ['AC2', 'operator-measurement', null]])
    await releaseWorkspace(engine).catch(() => {})
  }

  await cleanupFixtures()
}
