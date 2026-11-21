import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { coordinationInput } from '../server/runtime/coordination.mjs'
import { runOptionErrors } from '../server/config/run-options.mjs'

export const name = 'accumulate — a run built on everything earlier runs of the issue did'

// An issue with one ended analysis run (two investigations, a disposition, its
// result step) and the run now starting.
async function issueWithAnalysis () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prior-runs-'))
  const write = async (file, text) => { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text) }
  await write('000-report/response.md', 'Analyse the slow page.\n')
  await write('002-investigate/response.md', 'First draft: maybe the cache.\n')
  await write('003-investigate/response.md', 'Finding F1: the list re-renders on every keystroke.\n')
  await write('004-disposition/response.md', 'Accepted.\n')
  await write('005-result/result.md', '# Analysed\n')
  await write('005-result/changes.patch', 'diff --git a/x b/x\n')
  await write('006-note/note.md', 'Implement F1.\n')
  await write('.step-reservations.json', JSON.stringify([
    { number: '002', folder: '002-investigate', invocationId: 'i2', origin: 'agent-turn' },
    { number: '003', folder: '003-investigate', invocationId: 'i3', origin: 'agent-turn' },
    { number: '004', folder: '004-disposition', invocationId: 'i4', origin: 'agent-turn' },
    { number: '005', folder: '005-result', invocationId: 'run-result:a1' }
  ]))
  const step = (number, slug, role) => ({ number, slug, role, stepId: slug })
  await write('runs/a1/run.json', JSON.stringify({ runId: 'a1', status: 'completed', startedAt: '2026-10-01T00:00:00.000Z', playbook: { id: 'analysis' },
    steps: [step('002', 'investigate', 'analyser-1'), step('003', 'investigate', 'analyser-1'), step('004', 'disposition', 'coordinator')] }))
  await write('runs/a1/events.jsonl', '{}\n')
  await write('runs/a1/outputs/002.json', JSON.stringify({ valid: true, contract: 'investigationResult', output: {} }))
  await write('runs/a1/outputs/003.json', JSON.stringify({ valid: true, contract: 'investigationResult', output: {} }))
  await write('runs/a1/outputs/004.json', JSON.stringify({ valid: true, contract: 'reportDisposition', output: { disposition: 'accepted', issues: [{ title: 'F1' }] } }))
  await write('runs/b2/run.json', JSON.stringify({ runId: 'b2', status: 'running', startedAt: '2026-10-02T00:00:00.000Z', steps: [] }))
  return dir
}

const capture = (dir, accumulate) => captureWindow({ issuePath: dir, runId: 'b2', workspace: { path: dir, baseCommit: null, base: null }, accumulate })
const rel = (dir, window) => window.inputs.map((i) => path.relative(path.join(path.dirname(window.manifest), 'input'), i.file))

export default async function (t) {
  const dir = await issueWithAnalysis()

  t.section('off by default: only human input')
  const plain = await capture(dir, false)
  t.ok('report and note are input', rel(dir, plain).includes(path.join('000-report', 'response.md')) && rel(dir, plain).includes(path.join('006-note', 'note.md')), rel(dir, plain).join(', '))
  t.ok('nothing of the earlier run', !rel(dir, plain).some((f) => f.startsWith('prior-runs') || f.startsWith('005-result') || f.startsWith('003-')), rel(dir, plain).join(', '))
  t.eq('no accumulation recorded', plain.accumulated, null)

  t.section('accumulate: each earlier run\'s product is frozen into the window')
  const window = await capture(dir, true)
  const files = rel(dir, window)
  for (const name of ['steps.md', 'result.md', 'changes.patch']) t.ok(`${name} of a1`, files.includes(path.join('prior-runs', 'a1', name)), files.join(', '))
  t.ok('the running run itself is not a prior run', !files.some((f) => f.includes('b2')))
  t.eq('recorded on the window', window.accumulated, { runs: ['a1'], omitted: 0 })
  t.ok('inputs carry their origin', window.inputs.filter((i) => i.origin === 'prior-run').length === 3)
  const steps = await fs.readFile(path.join(path.dirname(window.manifest), 'input', 'prior-runs', 'a1', 'steps.md'), 'utf8')
  t.ok('every turn, the intermediate one too', steps.includes('First draft') && steps.includes('Finding F1') && steps.includes('Accepted.'), steps)
  t.ok('in order', steps.indexOf('First draft') < steps.indexOf('Finding F1') && steps.indexOf('Finding F1') < steps.indexOf('Accepted.'))
  t.ok('each headed with seat and contract', steps.includes('## 002 analyser-1: investigate') && steps.includes('— reportDisposition'), steps)

  t.section('the coordinator is told why they are there')
  const input = await coordinationInput(window)
  t.ok('instruction names the prior runs', input.instruction.includes('build on earlier runs of this issue (a1)'), input.instruction)
  t.eq('report first, then the note, then the earlier outcome', input.excerpts.map((e) => path.basename(path.dirname(e.source)) + '/' + path.basename(e.source)).slice(0, 2), ['000-report/response.md', '006-note/note.md'])
  t.ok('without accumulate the instruction stays as it was', !(await coordinationInput(plain)).instruction.includes('earlier runs'))

  t.section('a run that ended without an approved patch leaves its last candidate')
  const blocked = await issueWithAnalysis()
  const put = async (file, text) => { await fs.mkdir(path.dirname(path.join(blocked, file)), { recursive: true }); await fs.writeFile(path.join(blocked, file), text) }
  await fs.rm(path.join(blocked, '005-result', 'changes.patch'))
  const fp = (c) => 'sha256:' + c.repeat(64)
  const record = JSON.parse(await fs.readFile(path.join(blocked, 'runs/a1/run.json'), 'utf8'))
  Object.assign(record, { status: 'blocked', blockedReason: 'rounds-exhausted', revisions: [{ fingerprint: fp('a') }, { fingerprint: fp('b') }],
    checkResults: [{ dir: 'checks/002', revision: fp('b'), result: 'failed' }], checkHistory: [{ dir: 'checks/001', revision: fp('a'), result: 'passed' }, { dir: 'checks/002', revision: fp('b'), result: 'failed' }] })
  await put('runs/a1/run.json', JSON.stringify(record))
  await put(`runs/a1/checks/001/artifacts/${'a'.repeat(16)}.patch`, 'diff --git a/old b/old\n')
  await put(`runs/a1/checks/002/artifacts/${'b'.repeat(16)}.patch`, 'diff --git a/last b/last\n')
  const carried = await capture(blocked, true)
  const carriedFiles = rel(blocked, carried)
  t.ok('candidate.patch of the blocked run', carriedFiles.includes(path.join('prior-runs', 'a1', 'candidate.patch')), carriedFiles.join(', '))
  t.ok('never under the approved name', !carriedFiles.includes(path.join('prior-runs', 'a1', 'changes.patch')), carriedFiles.join(', '))
  t.eq('it is the last revision, not an earlier one', await fs.readFile(path.join(path.dirname(carried.manifest), 'input', 'prior-runs', 'a1', 'candidate.patch'), 'utf8'), 'diff --git a/last b/last\n')
  t.ok('the coordinator is told what it is', (await coordinationInput(carried)).instruction.includes('candidate.patch instead: its last revision, unapproved'))
  t.ok('a run with a patch of its own carries no candidate', !files.some((f) => f.endsWith('candidate.patch')), files.join(', '))
  await fs.rm(path.join(blocked, 'runs/a1/checks/002'), { recursive: true })
  await fs.rm(path.join(blocked, 'runs/b2'), { recursive: true }); await put('runs/b3/run.json', JSON.stringify({ runId: 'b3', status: 'running', startedAt: '2026-10-03T00:00:00.000Z', steps: [] }))
  const gone = await captureWindow({ issuePath: blocked, runId: 'b3', workspace: { path: blocked, baseCommit: null, base: null }, accumulate: true })
  t.ok('no check artifact of the last revision: nothing is carried, an older revision never stands in', !rel(blocked, gone).some((f) => f.endsWith('.patch')), rel(blocked, gone).join(', '))
  await fs.rm(blocked, { recursive: true, force: true })

  t.section('run option')
  t.eq('accumulate: true is accepted', runOptionErrors({ accumulate: true }), [])
  t.ok('a non-boolean is refused', runOptionErrors({ accumulate: 'yes' }).length > 0)
  await fs.rm(dir, { recursive: true, force: true })
}
