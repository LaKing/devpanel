import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { getRun } from '../server/runs-api.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { remainingBudget, summariseIssue, summarisePreview, summariseRun, summariseStep } from '../server/supervisor-summary.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'supervisor summaries — shape, not bytes; detail on demand; budgets stated, not inferred'

const start = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})
const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

export default async function (t) {
  t.section('1. a completed run summarises to a fraction of its full view, with every step listed')
  {
    const f = await engineFixture({ script: scriptFor() })
    const engine = await start(f)
    await engine.drive()
    const full = await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id })
    const summary = summariseRun(full)
    const fullBytes = JSON.stringify(full).length
    const summaryBytes = JSON.stringify(summary).length
    t.ok('much smaller', summaryBytes < fullBytes / 3, `${summaryBytes} of ${fullBytes} bytes`)
    t.eq('every step is listed', summary.steps.length, full.timeline.length)
    t.ok('with verdicts where reviews happened', summary.steps.some((s) => s.verdict === 'approved'))
    t.ok('no prompt bodies', !JSON.stringify(summary).includes('## Context supplied by the engine'))
    t.eq('closure conditions carried', summary.closure.conditions.deliveryCompleted, true)
    t.ok('delivery reduced to its verdict', 'verified' in summary.delivery && !('reconstruction' in summary.delivery))
    t.ok('and it says where the detail is', summary.detail.includes('get_step'))
    const withIntegration = summariseRun({ ...full, integration: { phase: 'complete', targetBranch: 'main', mergeCommit: 'abc', approvedBy: 'operator', warning: 'published to main, but 1 checkout(s) still show the previous content and need attention: /w', worktrees: { stale: [{ worktree: '/w', error: 'local changes', remedy: 'git read-tree …' }] } } })
    t.eq('integration is summarised', withIntegration.integration.targetBranch, 'main')
    t.ok('with its warning and the stale checkouts', /need attention/.test(withIntegration.integration.warning) && withIntegration.integration.staleCheckouts[0].worktree === '/w')

    const last = full.timeline.at(-1)
    const step = summariseStep(full, last.number, 'Checked the criteria.\nfull response here')
    t.eq('a step carries its rendered prompt', typeof step.prompt.rendered, 'string')
    t.ok('and the response', step.response.includes('full response here'))
    t.eq('and the structured output', step.output.contract, 'closureConfirmation')
    t.eq('an unknown step is null', summariseStep(full, '999', ''), null)
    await releaseWorkspace(engine)
  }

  t.section('2. a preview loses its rendered prompt bodies, keeps what a decision needs')
  {
    const f = await engineFixture()
    const preview = await previewRun({ playbookId: 'plan-and-implement', configRoot: f.configRoot, runOptions: { intent: 'refactoring' } })
    const s = summarisePreview(preview)
    t.ok('prompt bodies gone', !('prompts' in s))
    t.eq('config hash kept', s.configHash, preview.configHash)
    t.eq('intent kept', s.intent.id, 'refactoring')
    t.ok('participants reduced to role, model, effort', s.participants.every((p) => 'role' in p && 'model' in p && !('liveAuthentication' in p)))
    t.ok('phases reduced to a line each', s.phases.every((p) => Array.isArray(p.steps)))
    t.eq('a failed preview passes through', summarisePreview({ ok: false, errors: [1] }).ok, false)
  }

  t.section('3. an issue clips its reports and points at get_file')
  {
    const long = 'x'.repeat(10000)
    const s = summariseIssue({ issue: { id: 'i', name: 'n', project: 'p', status: 'open', archived: false, openedOn: 'd', path: '/p', steps: [{ number: '000', slug: 'report', files: [{ name: 'note.md' }] }] }, reports: [{ step: '000', name: 'note.md', text: long }], runs: [] })
    t.eq('clipped', s.reports[0].truncated, true)
    t.ok('to a bounded size', s.reports[0].text.length < 6200)
    t.ok('with the way to the rest', s.detail.includes('get_file'))
  }

  t.section('4. remaining budgets are authoritative and per session')
  {
    const r = remainingBudget({ limits: { maxCalls: 10, maxRuns: 3, maxStartsPerIssue: 2 }, calls: 4, starts: 1, startsByIssue: { 'p/a': 1 } })
    // Each allowance says used AND limit AND remaining. A bare number under a key
    // called "remaining" was read backwards by a live supervisor — it took
    // `starts: 0` for "none used", reported room that did not exist, and built a
    // risk tradeoff on the wrong figure. A triple cannot be read backwards.
    t.eq('calls state all three', [r.calls.used, r.calls.limit, r.calls.remaining], [4, 10, 6])
    t.eq('and so do starts', [r.starts.used, r.starts.limit, r.starts.remaining], [1, 3, 2])
    t.eq('an allowance with room left does not claim to be spent', r.starts.exhausted ?? null, null)
    t.ok('and the reading is stated outright', /remaining 0 means/.test(r.reading), r.reading)
    t.eq('per issue used', r.startsRemainingByIssue['p/a'], 1)
    t.ok('scope stated', /this session/.test(r.scope), r.scope)

    const spent = remainingBudget({ limits: { maxCalls: 10, maxRuns: 2 }, calls: 1, starts: 8, startsByIssue: {} })
    t.eq('a spent allowance reports what was actually used, over the lower cap', [spent.starts.used, spent.starts.limit, spent.starts.remaining], [8, 2, 0])
    t.eq('and says so in a word', spent.starts.exhausted, true)
    t.ok('with the consequence in prose, not arithmetic', /every run start is refused/.test(spent.starts.consequence ?? ''), spent.starts.consequence)
    t.ok('and names New session as the operator\'s way out', /New session/.test(spent.starts.consequence), spent.starts.consequence)
    t.eq('while no policy is active, only the session limits decide', spent.policy.decides, false)
    t.ok('and it says so', /session limits/.test(spent.policy.note), spent.policy.note)

    // A spending policy adds calendar windows; it does not demote the session
    // limits. The same 8-against-2 is still exhausted, and both are reported.
    const policy = { active: true, policy: { enforceAllowances: true, daily: { starts: 3, usd: 15, unpricedRuns: 2, unpricedCalls: 30 }, monthly: { starts: 30, usd: 150, unpricedRuns: 20, unpricedCalls: 300 }, perWakeCalls: 8 } }
    const usage = { day: { starts: 1, unpricedRuns: 1, unpricedCalls: 12, committedUsd: 3, committedUsdMicros: 3_000_000 }, month: { starts: 1, unpricedRuns: 1, unpricedCalls: 12, committedUsd: 3, committedUsdMicros: 3_000_000 } }
    const active = remainingBudget({ limits: { maxCalls: 10, maxRuns: 2 }, calls: 1, starts: 8, startsByIssue: {} }, { policy, usage, wakeCalls: 2 })
    t.eq('the session allowance still decides beside the windows', [active.starts.used, active.starts.limit, active.starts.exhausted], [8, 2, true])
    t.eq('and the windows decide as well', active.policy.decides, true)
    const remembered = remainingBudget({ limits: { maxCalls: 10, maxRuns: 2 }, calls: 1, starts: 0, startsByIssue: {}, history: { sessions: 2, starts: 8, startsByIssue: { 'p/a': 8 }, calls: 40 } })
    t.eq('earlier sessions are reported as accounting that decides nothing', [remembered.history.sessions, remembered.history.starts, remembered.history.role, remembered.history.decides], [2, 8, 'accounting', false])
    t.eq('while the fresh session has its whole allowance', [remembered.starts.used, remembered.starts.remaining], [0, 2])
    t.eq('the windows are reported with their own fractions', [active.policy.windows.day.starts.used, active.policy.windows.day.starts.limit, active.policy.windows.day.starts.remaining], [1, 3, 2])
    t.eq('money too', [active.policy.windows.day.usd.committed, active.policy.windows.day.usd.limit, active.policy.windows.day.usd.remaining], [3, 15, 12])
    t.eq('and the calls that nothing else bounds', [active.policy.windows.day.unpricedCalls.used, active.policy.windows.day.unpricedCalls.limit], [12, 30])
    t.eq('the wake has its own allowance', [active.policy.perWakeCalls.used, active.policy.perWakeCalls.remaining], [2, 6])
    t.ok('each window says when it rolls', /next UTC day/.test(active.policy.windows.day.rollsOver))

    const broke = remainingBudget({ limits: { maxCalls: 10, maxRuns: 2 }, calls: 1, starts: 8, startsByIssue: {} },
      { policy, usage: { day: { ...usage.day, committedUsdMicros: 15_000_000, committedUsd: 15 }, month: usage.month }, wakeCalls: 0 })
    t.eq('a spent window says so', broke.policy.windows.day.usd.exhausted, true)
    t.ok('with the consequence that binds every subject', /priced or not/.test(broke.policy.windows.day.usd.consequence ?? ''), broke.policy.windows.day.usd.consequence)
  }

  t.section('5. the prompt carries remaining budgets, and a change the supervisor made does not wake it')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-summary-'))
    const invocations = []
    let script = []
    const issues = [{ id: 'issue', status: 'open', name: 'one' }]
    const adapter = { invoke: async (args) => {
      invocations.push(args)
      const event = JSON.parse(args.prompt).event
      const action = script.shift()?.(event) ?? null
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
    } }
    const tools = {
      projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => issues,
      getIssue: async () => ({}), preview: async () => ({ ok: true, configHash: 'h' }), start: async () => ({ runId: 'r', status: 'running' }),
      getRun: async () => ({ status: 'running' }), stop: async () => {},
      // The note changes the issue list, as a real one does.
      addNote: async () => { issues.push({ id: 'issue-2', status: 'open', name: 'made by the supervisor' }); return { number: '001' } },
      createIssue: async () => ({}), archive: async () => ({})
    }
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    script = [() => ({ type: 'add_note', project: 'one-project', issueId: 'issue', text: 'hello' })]
    await agent.start({ model: 'm', projects: ['one-project'], message: 'go', limits: { maxCalls: 10, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 1 } })
    await wait(() => invocations.length === 2 && agent.get().status === 'active')
    const first = JSON.parse(invocations[0].prompt)
    t.eq('every prompt states the call allowance in full', [first.remaining.calls.used, first.remaining.calls.limit, first.remaining.calls.remaining], [0, 10, 10])
    t.eq('and the start allowance in full', [first.remaining.starts.used, first.remaining.starts.limit, first.remaining.starts.remaining], [0, 2, 2])
    t.ok('reply format stated', /exactly one JSON object/.test(first.replyFormat))
    await new Promise((r) => setTimeout(r, 200))
    t.eq('the note did not wake the supervisor as an issues-changed event', invocations.length, 2)
    t.eq('and nothing is queued', agent.get().queue.length, 0)
    // A change made by someone else still does.
    issues.push({ id: 'issue-3', status: 'open', name: 'made elsewhere' })
    await wait(() => invocations.length === 3)
    t.eq('an external change wakes it', JSON.parse(invocations[2].prompt).event.type, 'issues-changed')
    await agent.stop(); await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('a split suggestion reaches the supervisor as the run explanation says it, on every reading of the run')
  {
    const f = await engineFixture({ script: scriptFor() })
    const engine = await start(f)
    await engine.drive()
    const dir = path.join(f.issuePath, 'runs', engine.runId)
    const file = path.join(dir, 'run.json')
    const run = JSON.parse(await fs.readFile(file, 'utf8'))
    const review = (number, round, minutes, id) => {
      const finding = { id: `auditor-1-${id}`, severity: 'major', blocking: true, description: `${id} is wrong.`, criterion: 'restart-safe', location: 'gui/migrate.mjs:1' }
      return { step: { ...run.steps.at(-1), number, stepId: 'audit', role: 'auditor-1', phase: 'implement-review', round, startedAt: new Date(Date.UTC(2026, 10, 1, 8, minutes)).toISOString() }, finding, output: { valid: true, contract: 'reviewResult', output: { verdict: 'changes-needed', findings: [finding] } } }
    }
    const reviews = [review('901', 0, 10, 'crash-a'), review('902', 1, 40, 'crash-b')]
    for (const r of reviews) await fs.writeFile(path.join(dir, 'outputs', `${r.step.number}.json`), JSON.stringify(r.output))
    const closingStep = { ...run.steps.at(-1), number: '903', stepId: 'note', role: 'coordinator', startedAt: new Date(Date.UTC(2026, 10, 1, 9)).toISOString() }
    const blocked = { ...run, status: 'blocked', outcome: null, blockedReason: 'rounds-exhausted', closure: null, delivery: null, integrity: { status: 'clear' },
      workspace: { ...run.workspace, path: run.workspace?.path ?? '/w', state: 'retained' }, participants: Object.fromEntries(Object.entries(run.participants ?? {}).map(([k, p]) => [k, { ...p, pendingInvocation: null, state: 'idle' }])),
      steps: [...run.steps, ...reviews.map((r) => r.step), closingStep],
      outstandingFindings: [reviews[1].finding],
      resumeHistory: [{ at: new Date(Date.UTC(2026, 10, 1, 8, 30)).toISOString(), previousLimits: { maxSteps: 10 }, limits: { maxSteps: 20 } }] }
    await fs.writeFile(file, JSON.stringify(blocked))

    const full = await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id })
    const summary = summariseRun(full)
    t.ok('the explanation suggests it', /Consider splitting/.test(full.explanation.next), full.explanation.next)
    t.eq('the summary carries the same suggestion', summary.splitSuggestion, full.explanation.splitSuggestion)
    t.ok('in the very words of next', full.explanation.next.includes(summary.splitSuggestion.text))
    t.eq('with the candidate parts', summary.splitSuggestion.parts.map((p) => p.id), ['auditor-1-crash-b'])
    t.ok('and the parts are in the words', summary.splitSuggestion.text.includes('auditor-1-crash-b: crash-b is wrong.'), summary.splitSuggestion.text)

    // The issue's run list reads only the last output for everything else; the suggestion must not depend on that.
    const listed = (await f.issues.getIssue('devpanel-project', f.issue.id)).latestRun
    t.eq('the issue list reading says the same', listed.explanation.splitSuggestion, full.explanation.splitSuggestion)

    await fs.writeFile(file, JSON.stringify({ ...blocked, resumeHistory: [] }))
    const without = await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id })
    t.ok('without a raise neither says it', !without.explanation.splitSuggestion && !/split/i.test(without.explanation.next ?? ''), without.explanation.next)
    t.ok('and the summary has no such field', !('splitSuggestion' in summariseRun(without)))
    await fs.writeFile(file, JSON.stringify(run))
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
