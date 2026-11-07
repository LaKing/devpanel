import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { buildContext, windowSummary } from '../server/runtime/engine.mjs'
import { foldSizing, readIssueSizing, recordIssueSizing } from '../server/runtime/triage-sizing.mjs'
import { summariseIssue } from '../server/supervisor-summary.mjs'
import { CONFIG_ROOT, sandbox, patch, errorMatching } from './helpers.mjs'

export const name = 'triage sizing — concurrent seats in config, the fold, and sizing in later windows, summaries and previews'

// needs-owner-input carries its one owner question, as triageDispositionProblem requires.
const autonomyOf = (verdict) => verdict === 'needs-owner-input'
  ? { verdict, reason: 'r', questions: [{ id: 'Q1', question: 'Which collection owns this?', category: 'missing-information', recommendation: 'c.' }] }
  : { verdict, reason: 'r' }
const disposition = (size, modules, verdict = 'autonomous') => ({ valid: true, contract: 'triageDisposition', output: { disposition: 'accepted', size, sizeReason: `${size} because`, affectedModules: modules, autonomy: autonomyOf(verdict) } })

export default async function (t) {
  t.section('1. the triage playbook occupies two investigator seats that run at once')
  {
    const r = await resolvePlaybook('triage', { root: CONFIG_ROOT })
    t.ok('the triage playbook resolves', r.ok, JSON.stringify(r.errors))
    t.eq('investigator is opus-5-5 at low', [r.resolved.participants.investigator.model.id, r.resolved.participants.investigator.effort], ['opus-5-5', 'low'])
    t.eq('investigator-2 is gpt-6.1-sol at low', [r.resolved.participants['investigator-2'].model.id, r.resolved.participants['investigator-2'].effort], ['gpt-6.1-sol', 'low'])
    t.eq('both investigate steps are concurrent', r.resolved.phases.filter((p) => p.step?.concurrent).map((p) => p.step.role), ['investigator', 'investigator-2'])
  }

  t.section('2. the loader refuses a concurrent step whose order could matter')
  {
    const reads = await sandbox((dir) => patch(path.join(dir, 'strategy-templates/triage/strategy.yaml'),
      'role: investigator-2\n      prompt: investigate.md\n      output: triageDisposition\n      concurrent: true\n      context:\n',
      'role: investigator-2\n      prompt: investigate.md\n      output: triageDisposition\n      concurrent: true\n      context:\n        - steps.investigate.output.size\n'))
    t.ok('reading another concurrent step is refused', errorMatching(await resolvePlaybook('triage', { root: reads }), /concurrent with step "investigate"/))
    const loop = await sandbox((dir) => patch(path.join(dir, 'strategy-templates/plan-and-implement/strategy.yaml'),
      '        - id: audit-plan-1\n          role: auditor-1\n', '        - id: audit-plan-1\n          concurrent: true\n          role: auditor-1\n'))
    t.ok('a concurrent step inside a loop is refused', errorMatching(await resolvePlaybook('plan-and-implement', { root: loop }), /concurrent inside a loop/))
  }

  t.section('3. autoStart is a triage run option left out of the configHash')
  {
    const plain = await resolvePlaybook('triage', { root: CONFIG_ROOT })
    const auto = await resolvePlaybook('triage', { root: CONFIG_ROOT, runOptions: { autoStart: true } })
    t.ok('accepted for a triage', auto.ok, JSON.stringify(auto.errors))
    t.eq('the same configuration group', auto.resolved.configHash, plain.resolved.configHash)
    t.eq('kept in the snapshot run options', auto.resolved.runOptions.autoStart, true)
    t.ok('refused for any other tactic', errorMatching(await resolvePlaybook('prompt', { root: CONFIG_ROOT, runOptions: { autoStart: true } }), /autoStart only applies to a triage/))
  }

  t.section('4. the fold: major on any disagreement, the union of modules, the most restrictive verdict')
  {
    const snapshot = { participants: { investigator: { model: { id: 'a' } }, 'investigator-2': { model: { id: 'b' } } }, phases: [
      { id: 'investigate', step: { id: 'investigate', role: 'investigator', output: 'triageDisposition' } },
      { id: 'investigate-2', step: { id: 'investigate-2', role: 'investigator-2', output: 'triageDisposition' } }] }
    const steps = [{ number: '002', phase: 'investigate', stepId: 'investigate' }, { number: '003', phase: 'investigate-2', stepId: 'investigate-2' }]
    const fold = (a, b) => foldSizing(snapshot, steps, { '002': a, '003': b })
    t.eq('minor + minor is minor', fold(disposition('minor', ['c/x']), disposition('minor', ['c/y'])).size, 'minor')
    t.eq('minor + major is major', fold(disposition('minor', []), disposition('major', [])).size, 'major')
    t.eq('major + minor is major', fold(disposition('major', []), disposition('minor', [])).recommendedPlaybook, 'plan-and-implement')
    t.eq('modules are the union', fold(disposition('minor', ['c/x', 'c/y']), disposition('minor', ['c/y', 'f/z'])).affectedModules, ['c/x', 'c/y', 'f/z'])
    t.eq('one seat not autonomous holds the run', fold(disposition('minor', []), disposition('minor', [], 'needs-owner-input')).autonomy.verdict, 'needs-owner-input')
    t.eq('nothing is folded while a seat is missing', foldSizing(snapshot, steps, { '002': disposition('minor', []) }), null)
  }

  t.section('5. the issue keeps it, and every later run reads it in its window')
  {
    const issuePath = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-sizing-'))
    await fs.writeFile(path.join(issuePath, 'issue.json'), JSON.stringify({ name: 'Sized', priority: { value: 'high' } }))
    const sizing = { size: 'minor', affectedModules: ['modules/login'], recommendedPlaybook: 'prompt', autonomy: { verdict: 'autonomous' }, seats: [{ role: 'investigator', model: 'a', size: 'minor', reason: 'one write', modules: ['modules/login'] }] }
    t.eq('written once per run and step', [await recordIssueSizing(issuePath, sizing, { runId: 'r1', byStep: '002' }), await recordIssueSizing(issuePath, sizing, { runId: 'r1', byStep: '002' })], [true, false])
    const meta = JSON.parse(await fs.readFile(path.join(issuePath, 'issue.json'), 'utf8'))
    t.eq('beside the issue\'s other fields, keyed by the run', [meta.priority.value, meta.sizing.runId, meta.sizing.size], ['high', 'r1', 'minor'])
    const read = await readIssueSizing(issuePath)
    const summary = windowSummary({ id: 'w', sizing: read, inputs: [], issues: [], files: [] })
    t.eq('the window carries the size and the modules', [summary.sizing.size, summary.affectedModules, summary.sizing.seats[0].reason], ['minor', ['modules/login'], 'one write'])
    const ctx = buildContext({ windowLimits: {}, reviewPolicy: { substantial: { anyOf: [] }, protocolRepair: { maxAttempts: 1 } } }, { issue: { project: 'p' }, workspace: { path: '/w' }, currentWindow: { sizing: read }, revisions: [], checkResults: [] }, [], {})
    t.eq('and the `sizing` context ref', ctx.sizing.recommendedPlaybook, 'prompt')
    t.eq('the supervisor\'s issue summary shows it', summariseIssue({ issue: { id: 'i', sizing: meta.sizing }, reports: [], runs: [] }).issue.sizing.seats[0].reason, 'one write')
    await fs.rm(issuePath, { recursive: true, force: true })
  }

  t.section('6. previews: both investigator seats, and the sizing in the prompt worker\'s context')
  {
    const triage = await previewRun({ playbookId: 'triage', configRoot: CONFIG_ROOT })
    t.eq('triage shows both investigator seats', triage.participants.filter((p) => p.role.startsWith('investigator')).map((p) => [p.role, p.model, p.effort]), [['investigator', 'opus-5-5', 'low'], ['investigator-2', 'gpt-6.1-sol', 'low']])
    t.ok('marked as running at once', triage.phases.flatMap((p) => p.steps).filter((s) => s.concurrent).length === 2)
    const prompt = await previewRun({ playbookId: 'prompt', configRoot: CONFIG_ROOT })
    const worker = prompt.phases.flatMap((p) => p.steps).find((s) => s.role === 'worker')
    t.ok('the worker\'s context names the sizing', worker.context.some((c) => c.ref === 'sizing' && /triage sizing/.test(c.slot ?? '')), JSON.stringify(worker.context))
    const sized = await previewRun({ playbookId: 'prompt', configRoot: CONFIG_ROOT, issue: { name: 'Sized', project: 'devpanel-project', sizing: { size: 'minor', affectedModules: ['modules/login'], seats: [] } } })
    t.eq('a sized issue resolves it now', sized.phases.flatMap((p) => p.steps).find((s) => s.role === 'worker').context.find((c) => c.ref === 'sizing').availability, 'now')
    t.ok('the worker prompt says a Minor issue is one write and one hand-over', Object.values(prompt.prompts).some((p) => p.rendered.includes('A Minor issue is one write and one hand-over')))
  }
}
