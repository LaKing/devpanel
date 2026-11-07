import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { renderResult, writeRunResultStep } from '../server/run-result-step.mjs'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { startStage } from './browser/stage.mjs'

export const name = 'run result entries — what a run left behind, in the issue folder'

async function issueWithRun (run, { patch = null } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-result-'))
  await fs.mkdir(path.join(dir, '000-report'))
  await fs.writeFile(path.join(dir, '000-report', 'response.md'), 'The report.\n')
  await fs.mkdir(path.join(dir, '001-implement'))
  await fs.writeFile(path.join(dir, '001-implement', 'response.md'), 'Agent turn.\n')
  await fs.writeFile(path.join(dir, '.step-reservations.json'), JSON.stringify([{ number: '001', folder: '001-implement', invocationId: 'inv-1', origin: 'agent-turn', at: 'x' }]))
  const runDir = path.join(dir, 'runs', run.runId)
  await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  if (patch) await fs.writeFile(path.join(runDir, 'artifacts', 'c.patch'), patch)
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(run))
  // A run without its event journal reads as needing recovery; give it one.
  await fs.writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ at: run.startedAt, type: 'started' }) + '\n')
  return dir
}

const base = {
  runId: 'r1', status: 'completed', outcome: 'resolved', playbook: { id: 'implementation' }, steps: [{ number: '001', role: 'implementer' }],
  startedAt: '2026-09-27T10:00:00.000Z', endedAt: '2026-09-27T10:12:30.000Z', budgets: { used: { costUsd: 1.5, tokens: 4283702 } },
  revisions: [{}], delivery: { action: 'worktree-diff', completedAt: 'x', artifactRef: 'artifacts/c.patch' },
  closure: { residualRisks: [{ description: 'Live check on staging.', accepted: false }] }
}

export default async function (t) {
  t.section('a finished run writes one result entry')
  const dir = await issueWithRun(base, { patch: 'diff --git a/x b/x\n' })
  const folder = await writeRunResultStep({ issuePath: dir, runId: 'r1' })
  t.eq('it is the next step, named result', path.basename(folder), '002-result')
  const text = await fs.readFile(path.join(folder, 'result.md'), 'utf8')
  t.ok('it leads with the plain explanation', text.startsWith('# Done: a patch is ready'), text.split('\n')[0])
  t.ok('it says what reached the project', text.includes('Saved as a patch; the project itself was not changed.'))
  t.ok('it names what was left open', text.includes('**needs follow-up**: Live check on staging.'))
  t.ok('it names the run and its steps', text.includes('`r1`') && text.includes('001–001 (1)'))
  t.ok('its cost is time and tokens, never money', text.includes('- Time: 00:12:30') && text.includes('- Tokens: 4.28 M tokens') && !text.includes('$'), text.split('## Record')[1])
  t.eq('the patch is copied beside it', await fs.readFile(path.join(folder, 'changes.patch'), 'utf8'), 'diff --git a/x b/x\n')

  t.section('result.md says what a delivery merged and where it conflicted')
  {
    const merged = renderResult({ ...base, status: 'completed', outcome: 'resolved',
      delivery: { action: 'apply-to-source', completedAt: 'x', application: { path: '/p' }, merged: [{ path: 'server.mjs', hunks: 1 }], mergedFrom: 'sha256:m', mergeCheck: { ran: false } } })
    t.ok('the merged path and the unchecked merge are named', merged.includes('Merged three-way with edits in the project: server.mjs (1 hunk). No check ran on the merged bytes (merged tree sha256:m).'), merged)
    const conflicted = renderResult({ ...base, status: 'blocked', outcome: 'unresolved', blockedReason: 'source-delivery-blocked',
      delivery: { action: 'apply-to-source', completedAt: null, error: 'conflict', conflicts: [{ path: 'server.mjs', kind: 'text', lines: [{ start: 9, end: 9, side: 'source' }] },
        { path: 'logo.png', kind: 'binary', lines: [{ start: 1, end: 2, side: 'source' }] }, { path: 'gone.txt', kind: 'deleted', lines: [{ start: 1, end: 3, side: 'candidate' }] }] } })
    for (const text of ['server.mjs line 9 (source)', 'logo.png lines 1–2 (source, binary)', "gone.txt lines 1–3 of the candidate's file (deleted in the source)"]) {
      t.ok(`the conflict is named in What reached the project: ${text}`, conflicted.split('## What reached the project')[1]?.includes(text), conflicted)
    }
  }

  t.section('a turn that could not observe a Node child\'s output says so in the result')
  {
    const heading = '## Output a command could not observe'
    t.ok('nothing is said when no turn saw it', !renderResult(base).includes(heading))
    const seen = renderResult({ ...base, steps: [{ number: '001', role: 'auditor-1', childOutput: { unobservable: 2, unchecked: 1, line: 'the line' } }, { number: '002', role: 'implementer' }] })
    t.ok('the section names the step, the seat and the counts', seen.includes(heading) && seen.includes('step 001 (auditor-1)') && seen.includes('2 unobservable, 1 unchecked'), seen)
    t.ok('and only that step', !seen.includes('step 002'))
  }

  t.section('a later end rewrites the same entry')
  await fs.writeFile(path.join(dir, 'runs', 'r1', 'run.json'), JSON.stringify({ ...base, status: 'blocked', outcome: 'unresolved', blockedReason: 'budget-exhausted', budgets: { limits: { maxSteps: 1 }, used: { steps: 1 } } }))
  const again = await writeRunResultStep({ issuePath: dir, runId: 'r1' })
  t.eq('the same folder, not a new one', path.basename(again), '002-result')
  t.ok('with the new account', (await fs.readFile(path.join(again, 'result.md'), 'utf8')).startsWith('# Stopped: it used up its turn limit'))
  t.eq('and no second result step', (await fs.readdir(dir)).filter((n) => /-result$/.test(n)), ['002-result'])

  t.section('a run that has not ended writes nothing')
  const live = await issueWithRun({ ...base, runId: 'r2', status: 'running' })
  t.eq('no entry for a live run', await writeRunResultStep({ issuePath: live, runId: 'r2' }), null)
  t.eq('no entry for a run that does not exist', await writeRunResultStep({ issuePath: live, runId: 'nope' }), null)

  t.section('the next run does not read it as input')
  const window = await captureWindow({ issuePath: dir, runId: 'r1', workspace: { path: dir, baseCommit: null, base: null } })
  const sources = window.inputs.map((i) => path.relative(dir, i.source))
  t.ok('the report is input', sources.includes(path.join('000-report', 'response.md')), sources.join(', '))
  t.ok('the result entry is not', !sources.some((s) => s.startsWith('002-result')), sources.join(', '))

  t.section('the rendering keeps the coordinator\'s whole reasoning')
  const long = 'x'.repeat(900)
  const md = renderResult({ ...base, status: 'blocked', outcome: 'unresolved', blockedReason: 'closure-conditions-unmet',
    closure: { conditions: { coordinatorConfirmation: false } } }, { '009': { valid: true, contract: 'closureConfirmation', output: { satisfied: false, criteria: [], reasoning: long } } })
  t.ok('not shortened as on the page', md.includes(long))

  t.section('end to end: a run ends, the folder says so, steps know their run')
  const stage = await startStage()
  try {
    const issue = await stage.createIssue('Result entry')
    const started = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    const end = Date.now() + 20000
    while (!['completed', 'blocked', 'failed'].includes((await stage.run(issue.id, started.body.runId)).status)) {
      if (Date.now() > end) throw new Error('the run did not end')
      await new Promise((r) => setTimeout(r, 100))
    }
    let steps = []
    const seen = Date.now() + 5000
    do { steps = (await stage.request(`/api/projects/${stage.project}/issues/${issue.id}`)).body.steps; await new Promise((r) => setTimeout(r, 100)) }
    while (!steps.some((s) => s.run?.kind === 'result') && Date.now() < seen)
    const result = steps.find((s) => s.run?.kind === 'result')
    t.ok('the run wrote its result entry', Boolean(result), steps.map((s) => s.id).join(', '))
    t.eq('it holds the account', result?.files.some((f) => f.name === 'result.md'), true)
    const turns = steps.filter((s) => s.run?.kind === 'turn')
    t.ok('every agent turn names its run', turns.length > 0 && turns.every((s) => s.run.runId === started.body.runId))
    const note = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/steps`, { method: 'POST', body: JSON.stringify({ name: 'operator note', text: 'Checked by hand.' }) })
    const after = (await stage.request(`/api/projects/${stage.project}/issues/${issue.id}`)).body.steps
    const added = after.find((s) => s.id === note.body.id)
    t.ok('the note is listed', Boolean(added))
    t.eq('a note a person adds belongs to no run', added?.run, null)
  } finally { await stage.stop() }
}
