import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { retainedWork, checksOutlook } from '../server/runtime/retained-work.mjs'
import { undeliveredApproval, carryForward } from '../server/runtime/carry-forward.mjs'
import { captureWindow } from '../server/runtime/current-window.mjs'
import { renderSteps } from '../server/runtime/prior-runs.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import * as store from '../server/runtime/store.mjs'
import { retainedPatchDownload } from '../server/runtime/apply-artifact.mjs'
import { createPathOverlap } from '../server/runtime/path-overlap.mjs'
import { coverageInput } from '../server/runtime/modules-coverage.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'retained-work — the start preview says what a follow-up run would build on, read-only'

const exec = promisify(execFile)
const sha = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const R = (n) => 'sha256:' + String(n).repeat(64).slice(0, 64)
const fp16 = (r) => r.replace('sha256:', '').slice(0, 16)
const APPROVED = { sameRevisionApproval: true, checksSatisfied: true, noOutstandingBlockingFindings: true, deliveryCompleted: false }

async function issueDir () {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-retained-'))
  await fs.mkdir(path.join(dir, '000-report'), { recursive: true })
  await fs.writeFile(path.join(dir, '000-report', 'response.md'), '# Report\n\nPlease fix it.\n')
  await fs.writeFile(path.join(dir, 'issue.json'), JSON.stringify({ name: 'Retained', status: 'open' }))
  return dir
}

/** A hand-written ended run: run.json, an empty (complete) journal, and any files under its directory. */
async function writeRun (issuePath, runId, record, { files = {}, outputs = {}, snapshot = null } = {}) {
  const dir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId, status: 'blocked', steps: [], ...record }))
  await fs.writeFile(path.join(dir, 'events.jsonl'), '')
  for (const [rel, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), bytes)
  }
  for (const [n, out] of Object.entries(outputs)) await store.writeOutput(issuePath, runId, n, out)
  if (snapshot) await fs.writeFile(path.join(dir, 'resolved-playbook.json'), JSON.stringify(snapshot))
  return dir
}

const PATCH = Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')

/** An approved run whose delivery was refused: what carry-forward selects. */
const approvedRun = (revision, extra = {}) => ({
  startedAt: '2026-11-20T10:00:00.000Z', revisions: [{ fingerprint: revision }], outstandingFindings: [],
  closure: { revision, conditions: { ...APPROVED } },
  delivery: { action: 'apply-to-source', revision, artifactRef: `artifacts/${fp16(revision)}.patch`, patchHash: sha(PATCH), reconstruction: { verified: true, fingerprint: revision }, application: { state: 'source-drift' } },
  ...extra
})
/** An unapproved run whose last revision's check wrote a candidate. */
const candidateRun = (revision, { history = false, hash = sha(PATCH), startedAt = '2026-11-19T10:00:00.000Z' } = {}) => {
  const record = { revision, dir: 'checks/001', artifact: { ref: `checks/001/artifacts/${fp16(revision)}.patch`, patchHash: hash } }
  return { startedAt, revisions: [{ fingerprint: revision }], outstandingFindings: [], checkResults: history ? [] : [record], checkHistory: [record] }
}

async function treeState (root) {
  const out = {}
  const walk = async (rel) => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const p = path.join(rel, e.name)
      if (e.isDirectory()) await walk(p)
      else { const st = await fs.lstat(path.join(root, p)); out[p] = `${st.size}:${st.mtimeMs}` }
    }
  }
  await walk('')
  return out
}

const mkfifo = async (file) => exec('mkfifo', [file]).then(() => true, () => false)
const withinMs = (ms, promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))])

export default async function (t) {
  const configRoot = await sandbox()
  const base = (await resolvePlaybook('implementation', { root: configRoot, projectId: 'devpanel-project' })).resolved
  const resolved = (over = {}) => ({ ...base, ...over, runOptions: { ...base.runOptions, ...(over.runOptions ?? {}) } })

  t.section('an approved, undelivered patch: the automatic seed, the selector\'s own choice, linked when its digest matches')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-a', approvedRun(R(1)), { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    const before = await treeState(issuePath)
    const w = await retainedWork({ issuePath, resolved: resolved() })
    const chosen = await undeliveredApproval(issuePath, null)
    t.eq('the case is the seed', w.labels, ['seed'])
    t.eq('it names the run and revision the launch selects (AC5)', [w.seed.runId, w.seed.revision], [chosen.runId, chosen.revision])
    t.eq('its patch is available', w.seed.state, 'available')
    t.eq('the link is the delivery artifact at that revision', [w.seed.link.artifact, w.seed.link.revision], ['delivery', R(1)])
    t.ok('the note promises no clean apply (AC7)', /does not say the patch applies cleanly/.test(w.note))
    t.eq('nothing in the issue changed (AC10)', await treeState(issuePath), before)
  }

  t.section('an older engine delivery: delivery.application.patchHash proves the bytes; a mismatch gets no link')
  {
    const issuePath = await issueDir()
    const old = approvedRun(R(1))
    delete old.delivery.patchHash
    old.delivery.application = { state: 'source-drift', patchHash: sha(PATCH) }
    await writeRun(issuePath, 'run-a', old, { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    t.eq('linked through the application digest', (await retainedWork({ issuePath, resolved: resolved() })).seed.link.artifact, 'delivery')
    await fs.writeFile(path.join(issuePath, 'runs', 'run-a', 'artifacts', `${fp16(R(1))}.patch`), Buffer.from('other bytes\n'))
    const w = await retainedWork({ issuePath, resolved: resolved() })
    t.eq('changed bytes: no link', w.seed.link.artifact, null)
    t.ok('and the reason says so', /changed since/.test(w.seed.link.reason), w.seed.link.reason)
    t.eq('the seed itself is still the launch\'s (its file is readable)', w.labels, ['seed'])
  }

  t.section('a seed over the download limit is still the seed, with the reason and no link')
  {
    const issuePath = await issueDir()
    const dir = await writeRun(issuePath, 'run-a', approvedRun(R(1)))
    await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true })
    const handle = await fs.open(path.join(dir, 'artifacts', `${fp16(R(1))}.patch`), 'w')
    await handle.truncate(26 * 1024 * 1024 + 1)
    await handle.close()
    const w = await retainedWork({ issuePath, resolved: resolved() })
    t.eq('the case is the seed', w.labels, ['seed'])
    t.eq('no link', w.seed.link.artifact, null)
    t.ok('the reason is the limit', /over the download limit/.test(w.seed.link.reason), w.seed.link.reason)
  }

  t.section('an unapproved retained candidate: available through Accumulate and as a verified download')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-b', candidateRun(R(2)), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    const off = await retainedWork({ issuePath, resolved: resolved() })
    t.eq('the case is a retained candidate', off.labels, ['retained-candidate'])
    t.eq('Accumulate off: available if turned on, and to download', off.candidates[0].access, ['accumulate-if-enabled', 'download'])
    t.eq('the link is the check artifact of the last revision', [off.candidates[0].link.artifact, off.candidates[0].link.revision], ['check', R(2)])
    const on = await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.eq('Accumulate on: included', on.candidates[0].access, ['accumulate', 'download'])
    const none = await retainedWork({ issuePath, resolved: resolved({ tactic: null }) })
    t.eq('a playbook that captures no window: download only, the reason named', [none.candidates[0].access, none.candidates[0].accumulate.reason], [['download'], 'no-window'])
  }

  t.section('the check artifact survives a delivery return: an original reachable only through checkHistory is linked')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-b', candidateRun(R(2), { history: true }), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    const w = await retainedWork({ issuePath, resolved: resolved() })
    t.eq('linked from history', w.candidates[0]?.link.artifact, 'check')
  }

  t.section('no reusable patch: none, with the run\'s recorded findings tied to their evidence (AC3)')
  {
    const issuePath = await issueDir()
    const snapshot = { tactic: 'implementation', reviewPolicy: base.reviewPolicy, phases: base.phases, participants: base.participants }
    const review = { verdict: 'changes-needed', artifactRevision: R(3), findings: [{ id: 'auditor-1-gap', severity: 'major', blocking: true, criterion: 'AC1', location: 'a.mjs:1', description: 'The gap.' }], priorFindings: [] }
    const auditStep = base.phases.find((p) => p.loop?.steps?.some((s) => s.output === 'reviewResult' && s.id.startsWith('audit-impl')))
    const stepId = auditStep.loop.steps.find((s) => s.output === 'reviewResult').id
    await writeRun(issuePath, 'run-c', {
      startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }],
      steps: [{ number: '004', role: 'implementer', stepId: 'implement', phase: auditStep.id, round: 1, revision: R(3) }, { number: '005', role: 'auditor-1', stepId, phase: auditStep.id, round: 1 }],
      outstandingFindings: [{ ...review.findings[0] }, { id: 'auditor-1-plan', severity: 'major', blocking: true, description: 'Deferred.', source: 'plan-review', raisedInStep: '002' }, { id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }],
      checkHistory: [{ revision: R(3), result: 'failed', gating: 'failed', at: '2026-11-21T11:00:00.000Z' }],
      // The confirmation (007) examined revision 7; the engine's return decision is 009; the run moved on to revision 3 after.
      closureReturns: [{ step: '009', confirmationStep: '007', criteria: [{ id: 'AC2', unmet: 'missing-work' }] }]
    }, { outputs: { '005': { contract: 'reviewResult', valid: true, output: review }, '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } }, snapshot })
    await writeRun(issuePath, 'run-d', { startedAt: '2026-11-18T10:00:00.000Z' })
    const w = await retainedWork({ issuePath, resolved: resolved() })
    t.eq('no reusable artifact', w.labels, ['none'])
    const ev = w.evidence.find((e) => e.runId === 'run-c')
    t.eq('the evidence run is the latest with findings', ev?.runId, 'run-c')
    const byId = Object.fromEntries((ev?.findings.items ?? []).map((f) => [f.id, f]))
    t.eq('blocking status is shown', byId['auditor-1-gap']?.blocking, true)
    t.eq('a review finding is tied to the revision its review examined', byId['auditor-1-gap']?.provenance.revision, R(3))
    t.eq('a deferred plan finding is against the plan', byId['auditor-1-plan']?.provenance.against, 'plan')
    t.eq('a closure finding names its confirmation step and the revision that confirmation examined, not the run\'s last', [byId['closure-ac2']?.provenance.raisedInStep, byId['closure-ac2']?.provenance.confirmationStep, byId['closure-ac2']?.provenance.revision], ['009', '007', R(7)])
    t.eq('the prior check belongs to that revision only', [ev?.priorCheck.revision, ev?.priorCheck.result], [R(3), 'failed'])
    const unknownIssue = await issueDir()
    await writeRun(unknownIssue, 'run-e', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(4) }], outstandingFindings: undefined })
    const u = await retainedWork({ issuePath: unknownIssue, resolved: resolved() })
    t.eq('a run with no findings field: findings unknown, stated', u.evidence[0]?.findings.state, 'unknown')
  }

  t.section('a missing or unreadable artifact is reported as such; a FIFO never blocks the preview')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-a', approvedRun(R(1)))
    const w = await retainedWork({ issuePath, resolved: resolved() })
    t.eq('deleted seed: missing, context only', [w.seed.state, w.seed.outcome.startsWith('context-only')], ['missing', true])
    t.eq('no reusable artifact', w.labels, ['none'])
    t.ok('a diagnostic says so', w.diagnostics.some((d) => /missing/.test(d.reason)), JSON.stringify(w.diagnostics))
    const fifo = path.join(issuePath, 'runs', 'run-a', 'artifacts', `${fp16(R(1))}.patch`)
    await fs.mkdir(path.dirname(fifo), { recursive: true })
    if (!await mkfifo(fifo)) t.skip('FIFO seed', 'mkfifo could not run here')
    else {
      const read = await withinMs(5000, retainedWork({ issuePath, resolved: resolved() }))
      t.ok('the preview finished', read !== 'timeout')
      t.eq('the seed is unreadable, not a regular file', [read.seed?.state, read.seed?.code], ['unreadable', 'not-regular'])
      t.eq('and has no link', read.seed?.link.artifact, null)
    }
    const cand = await issueDir()
    const dir = await writeRun(cand, 'run-b', candidateRun(R(2)))
    await fs.mkdir(path.join(dir, 'checks', '001', 'artifacts'), { recursive: true })
    if (!await mkfifo(path.join(dir, 'checks', '001', 'artifacts', `${fp16(R(2))}.patch`))) t.skip('FIFO candidate', 'mkfifo could not run here')
    else {
      const read = await withinMs(5000, retainedWork({ issuePath: cand, resolved: resolved() }))
      t.ok('the preview finished', read !== 'timeout')
      t.eq('a FIFO candidate is no reusable artifact', read.labels, ['none'])
      const d = read.diagnostics.find((x) => x.runId === 'run-b' && x.name === 'candidate.patch')
      t.ok('and it is reported, with its state, not dropped', /not a regular file/.test(d?.reason ?? ''), JSON.stringify(read.diagnostics))
    }
    const gone = await issueDir()
    await writeRun(gone, 'run-b', candidateRun(R(2)))
    {
      const read = await retainedWork({ issuePath: gone, resolved: resolved() })
      const d = read.diagnostics.find((x) => x.runId === 'run-b' && x.name === 'candidate.patch')
      t.eq('a recorded candidate whose original is gone: no reusable artifact', read.labels, ['none'])
      t.ok('reported as missing', /missing/.test(d?.reason ?? ''), JSON.stringify(read.diagnostics))
    }
  }

  t.section('a seed that cannot be read never hides an older candidate; launch does the same in the same order')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-b', candidateRun(R(2)), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    await writeRun(issuePath, 'run-a', approvedRun(R(1)))      // its seed file is missing
    const w = await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.eq('the label is the candidate', w.labels, ['retained-candidate'])
    t.eq('the seed is shown beside it, missing', [w.seed?.runId, w.seed?.state], ['run-a', 'missing'])
    const window = await captureWindow({ issuePath, runId: 'run-new', workspace: { path: issuePath }, limits: base.windowLimits, accumulate: true })
    t.ok('capture freezes the older candidate', window.inputs.some((i) => i.runId === 'run-b' && i.file.endsWith('candidate.patch')), JSON.stringify(window.inputs.map((i) => i.file)))
    const seed = await carryForward({ issuePath, runId: 'run-new', workspace: { path: issuePath, scratchPath: issuePath } })
    t.eq('and provisioning hands the seed over as context only', [seed?.state, seed?.error], ['context-only', 'the approved patch could not be read'])
  }

  t.section('stale eligibility: a landing, an applied artifact or a completed delivery after the preview removes the seed everywhere')
  {
    for (const [what, change] of [['a landing', (r) => { r.landed = { applied: 'commit', by: 'op' } }], ['an applied artifact', (r) => { r.artifactApplication = { verified: true } }], ['a completed delivery', (r) => { r.closure.conditions.deliveryCompleted = true }]]) {
      const issuePath = await issueDir()
      const record = approvedRun(R(1))
      await writeRun(issuePath, 'run-a', record, { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
      t.eq(`${what}: the preview said seed`, (await retainedWork({ issuePath, resolved: resolved() })).labels, ['seed'])
      change(record)
      await fs.writeFile(path.join(issuePath, 'runs', 'run-a', 'run.json'), JSON.stringify({ runId: 'run-a', status: 'blocked', steps: [], ...record }))
      const again = await retainedWork({ issuePath, resolved: resolved() })
      t.eq(`${what}: the preview now says no seed`, again.seed, null)
      t.eq(`${what}: the selector agrees`, await undeliveredApproval(issuePath, null), null)
      t.eq(`${what}: launch seeds nothing`, await carryForward({ issuePath, runId: 'run-new', workspace: { path: issuePath, scratchPath: issuePath } }), null)
    }
  }

  t.section('inclusion is predicted from the bytes capture charges, the rendered steps.md included (AC2, AC9)')
  {
    const issuePath = await issueDir()
    await fs.mkdir(path.join(issuePath, '010-implement'), { recursive: true })
    await fs.writeFile(path.join(issuePath, '010-implement', 'response.md'), 'I implemented it, at some length.\n'.repeat(20))
    const record = { ...candidateRun(R(2)), status: 'blocked', steps: [{ number: '010', slug: 'implement', role: 'implementer', stepId: 'implement' }] }
    await writeRun(issuePath, 'run-b', record, { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    const human = (await fs.stat(path.join(issuePath, '000-report', 'response.md'))).size
    const transcript = Buffer.byteLength(await renderSteps(issuePath, { ...record, runId: 'run-b' }))
    const frozen = async (limits) => (await captureWindow({ issuePath, runId: 'run-new', workspace: { path: issuePath }, limits, accumulate: true })).inputs.some((i) => i.file.endsWith('candidate.patch'))
    const tight = { ...base.windowLimits, maxInputBytes: human + transcript + PATCH.length - 1 }
    const w = await retainedWork({ issuePath, resolved: resolved({ windowLimits: tight, runOptions: { accumulate: true } }) })
    t.eq('room for the patch alone, not after the transcript: omitted, bytes budget spent', w.candidates[0]?.accumulate.reason, 'bytes-budget-spent')
    t.eq('capture agrees', await frozen(tight), false)
    const room = { ...tight, maxInputBytes: tight.maxInputBytes + 1 }
    t.eq('one byte more: included', (await retainedWork({ issuePath, resolved: resolved({ windowLimits: room, runOptions: { accumulate: true } }) })).candidates[0]?.accumulate.reason, 'included')
    t.eq('capture agrees', await frozen(room), true)

    await fs.mkdir(path.join(issuePath, '011-note'), { recursive: true })
    await fs.writeFile(path.join(issuePath, '011-note', 'note.md'), 'A note.\n')
    const files = { ...base.windowLimits, maxInputFiles: 2 }
    t.eq('human input spends maxInputFiles: files budget spent', (await retainedWork({ issuePath, resolved: resolved({ windowLimits: files }) })).candidates[0]?.accumulate.reason, 'files-budget-spent')
    t.eq('capture agrees', await frozen(files), false)

    const perFile = { ...base.windowLimits, maxInputFileBytes: PATCH.length - 1 }
    const small = await retainedWork({ issuePath, resolved: resolved({ windowLimits: perFile }) })
    t.eq('one resolved per-file limit: over it in the preview (AC9)', small.candidates[0]?.accumulate.reason, 'skipped-too-large')
    t.eq('and in capture', await frozen(perFile), false)
  }

  t.section('a candidate with no way to reach it is a diagnostic, never a reusable candidate')
  {
    const issuePath = await issueDir()
    await fs.mkdir(path.join(issuePath, '011-note'), { recursive: true })
    await fs.writeFile(path.join(issuePath, '011-note', 'note.md'), 'A note.\n')
    await writeRun(issuePath, 'run-b', candidateRun(R(2), { hash: sha(Buffer.from('what the check wrote')) }), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    const w = await retainedWork({ issuePath, resolved: resolved({ windowLimits: { ...base.windowLimits, maxInputFiles: 2 } }) })
    t.eq('no reusable artifact', w.labels, ['none'])
    t.eq('no candidate listed', w.candidates, [])
    const d = w.diagnostics.find((x) => x.runId === 'run-b')
    t.ok('the diagnostic gives both reasons', /files-budget-spent/.test(d?.reason) && /changed since/.test(d?.reason), d?.reason)
  }

  t.section('the checks the new candidate gets: timing only when they will run (AC4)')
  {
    const inPlace = checksOutlook({ ...base, workspace: { ...base.workspace, isolation: 'in-place' }, checks: { requirement: 'optional', target: { tier: 'modules', timing: 'every-revision', modules: { test: {} } } } })
    t.eq('in place with an optional modules target: not run, no schedule', [inPlace.state, inPlace.schedule], ['not-run', null])
    const undeclared = checksOutlook({ ...base, checks: { requirement: 'required', target: { tier: 'modules', timing: 'every-revision', commands: [] } } }, null, 'p')
    t.eq('an undeclared modules tier: unavailable, no schedule', [undeclared.state, undeclared.schedule], ['unavailable', null])
    t.ok('with the engine\'s reason', /declares no testDrive\.modules/.test(undeclared.detail), undeclared.detail)
    const none = checksOutlook({ ...base, checks: { requirement: 'optional', target: null } })
    t.eq('no target under an optional requirement: unavailable', none.state, 'unavailable')
    const approved = checksOutlook({ ...base, checks: { requirement: 'required', target: { kind: 'local', timing: 'approved', commands: [] } } })
    const phase = approved.schedule.find((p) => p.default === 'after-approval')
    t.ok('a target that waits for approval: after approval by default', Boolean(phase), JSON.stringify(approved.schedule))
    t.eq('with the engine\'s exceptions', phase?.exceptions.map((e) => e.id), ['awaits-check-early', 'last-round-drive', 'retry-failed'])
    const prompt = (await resolvePlaybook('prompt', { root: configRoot, projectId: 'devpanel-project' })).resolved
    const single = checksOutlook({ ...prompt, checks: { requirement: 'required', target: { kind: 'local', timing: 'approved', commands: [] } } })
    t.eq('a phase with no occupied reviewer is checked when recorded, with no deferred exception', single.schedule.map((p) => [p.default, p.exceptions.map((e) => e.id)]), single.schedule.map(() => ['when-recorded', ['retry-failed']]))
  }

  t.section('a damaged journal: the preview reports it and writes nothing (AC10)')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-a', approvedRun(R(1)), { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await writeRun(issuePath, 'run-b', candidateRun(R(2)), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    for (const id of ['run-a', 'run-b']) await fs.writeFile(path.join(issuePath, 'runs', id, 'events.jsonl'), 'not json\n')
    const before = await treeState(issuePath)
    await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.eq('no journal-recovery.json, nothing else written', await treeState(issuePath), before)
  }

  t.section('the dry walk stops where capture would throw: nothing after it is offered through Accumulate (AC2)')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-a', { ...candidateRun(R(1), { startedAt: '2026-11-18T10:00:00.000Z' }) }, { files: { [`checks/001/artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await writeRun(issuePath, 'run-b', candidateRun(R(2)), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    // run-a's result step holds a result.md capture cannot read: capture throws there, before run-b's candidate.
    await fs.writeFile(path.join(issuePath, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-a', folder: '017-result' }]))
    await fs.mkdir(path.join(issuePath, '017-result'), { recursive: true })
    const blocked = path.join(issuePath, '017-result', 'result.md')
    await fs.writeFile(blocked, 'result\n')
    await fs.chmod(blocked, 0o000)
    if (await fs.readFile(blocked).then(() => true, () => false)) t.skip('unreadable result.md', 'this user can read a mode-000 file (root), so no EACCES can be produced')
    else {
      const thrown = await captureWindow({ issuePath, runId: 'run-new', workspace: { path: issuePath }, limits: base.windowLimits, accumulate: true }).then(() => null, (e) => e.code)
      t.eq('capture itself stops on it', thrown, 'EACCES')
      const w = await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
      const later = w.candidates.find((c) => c.runId === 'run-b')
      t.ok('the later candidate is not offered through Accumulate', !later?.access.includes('accumulate'), JSON.stringify(later))
      t.ok('its reason names the failing capture', /capture-fails:EACCES/.test(later?.accumulate.reason ?? ''), later?.accumulate.reason)
      t.ok('and the preview says capture would fail', w.diagnostics.some((d) => /capture would fail/.test(d.reason)), JSON.stringify(w.diagnostics))
    }
    await fs.chmod(blocked, 0o644)
  }

  t.section('findings are stated even when no run qualifies as evidence (AC3)')
  {
    const empty = await issueDir()
    const none = await retainedWork({ issuePath: empty, resolved: resolved() })
    t.eq('no ended run: findings none, said', [none.evidence.length, none.findings?.state], [0, 'none'])
    const bare = await issueDir()
    await writeRun(bare, 'run-x', { startedAt: '2026-11-21T10:00:00.000Z' })
    const unknown = await retainedWork({ issuePath: bare, resolved: resolved() })
    t.eq('an ended run with nothing recorded: its findings are unknown, said', [unknown.evidence[0]?.runId, unknown.evidence[0]?.findings.state], ['run-x', 'unknown'])
  }

  t.section('the schedule follows the engine: concurrency, the resolved retry count and when a retry is skipped (AC4)')
  {
    const local = { ...base, checks: { requirement: 'required', target: { kind: 'local', commands: [] } } }
    const beside = checksOutlook(local).schedule.map((p) => p.default)
    t.ok('concurrent by default: beside the reviews', beside.includes('beside-reviews'), JSON.stringify(beside))
    const serial = checksOutlook({ ...local, checks: { ...local.checks, concurrent: false } }).schedule.map((p) => p.default)
    t.ok('checks.concurrent false: before the reviews go on', serial.includes('before-reviews') && !serial.includes('beside-reviews'), JSON.stringify(serial))
    const serialPolicy = checksOutlook({ ...local, reviewPolicy: { ...base.reviewPolicy, concurrentReviews: false } }).schedule.map((p) => p.default)
    t.ok('reviewPolicy.concurrentReviews false: before the reviews go on', serialPolicy.includes('before-reviews'), JSON.stringify(serialPolicy))
    const sentence = (target) => checksOutlook({ ...base, checks: { requirement: 'required', target } }).schedule[0].exceptions.map((e) => e.sentence).join(' ')
    t.ok('retryFailed 2: up to 2 times', /retried up to 2 times/.test(sentence({ kind: 'local', commands: [], retryFailed: 2 })))
    t.ok('retryFailed 0: not retried', /is not retried \(retryFailed: 0\)/.test(sentence({ kind: 'local', commands: [], retryFailed: 0 })))
    const modules = sentence({ tier: 'modules', modules: { test: {} }, commands: [] })
    t.ok('a modules drive: only the first drive skips its retries (tests ran and failed, or the stage reported its dependency install failed)', /Only the first drive can skip the retries: when its tests ran and failed, or the stage reported its dependency install failed/.test(modules), modules)
    t.ok('and a retry that fails is retried again within the limit, whatever failed', /once a retry has started, a failing retry is retried again within the limit, whatever failed/.test(modules), modules)
    t.ok('and no earlier-revision comparison is claimed for it (the modules branch passes none)', !/earlier revision/.test(modules), modules)
    const early = sentence({ kind: 'local', commands: [], timing: 'approved' })
    t.ok('the early drive is qualified: not once a check of that revision failed', /unless a check of that revision already failed/.test(early), early)
    const tieredEarly = sentence({ kind: 'local', commands: [], tiers: { smoke: ['a'] } })
    t.ok('a tiered target: a failed smoke gets no full drive outside the last round', /a failed smoke gets no full drive here; only the last allowed round drives it/.test(tieredEarly), tieredEarly)
    const prompt = (await resolvePlaybook('prompt', { root: configRoot, projectId: 'devpanel-project' })).resolved
    const promptTiered = checksOutlook({ ...prompt, checks: { requirement: 'required', target: { kind: 'local', commands: [], tiers: { smoke: ['a'] } } } })
    t.ok('Prompt with a tiered target: the full tier when recorded, no smoke-first schedule', promptTiered.schedule.length > 0 && promptTiered.schedule.every((p) => p.default === 'when-recorded'), JSON.stringify(promptTiered.schedule))
    const analysis = (await resolvePlaybook('analysis', { root: configRoot, projectId: 'devpanel-project' })).resolved
    const noRevision = checksOutlook({ ...analysis, checks: { requirement: 'none', concurrent: false, target: { kind: 'local', commands: [] } } })
    t.eq('a playbook recording no candidate: not run, no schedule', [noRevision.state, noRevision.schedule], ['not-run', null])
    t.ok('and no claim that checks run beside the reviews', !/beside the reviews/.test(noRevision.detail), noRevision.detail)
    const none = checksOutlook({ ...base, checks: { requirement: 'none', concurrent: false, target: { kind: 'local', commands: [] } } })
    t.ok('requirement none with serial checks: the detail claims no concurrency', !/beside the reviews/.test(none.detail) && none.schedule.every((p) => p.default !== 'beside-reviews'), JSON.stringify(none))
    const lastRound = sentence({ kind: 'local', commands: [], timing: 'approved' })
    t.ok('the last-round drive keeps the same-round re-review when every finding awaits it', /review again in the same round/.test(lastRound) && /with other blocking findings beside them there is no re-review/.test(lastRound), lastRound)
  }

  t.section('an original Accumulate does not list is still linked when verified (AC1), and reported when it cannot be (AC7)')
  {
    // A migrated revision: the check record names the new fingerprint, the file keeps the old one.
    const migrated = await issueDir()
    const record = { revision: R(2), migratedFrom: R(9), dir: 'checks/001', artifact: { ref: `checks/001/artifacts/${fp16(R(9))}.patch`, patchHash: sha(PATCH) } }
    await writeRun(migrated, 'run-b', { startedAt: '2026-11-19T10:00:00.000Z', revisions: [{ fingerprint: R(2), migratedFrom: R(9) }], outstandingFindings: [], checkResults: [record], checkHistory: [record] }, { files: { [`checks/001/artifacts/${fp16(R(9))}.patch`]: PATCH } })
    const w = await retainedWork({ issuePath: migrated, resolved: resolved() })
    t.eq('a migrated original the resolver serves is linked', [w.labels, w.candidates[0]?.link.artifact, w.candidates[0]?.access], [['retained-candidate'], 'check', ['download']])

    // A reserved result folder without changes.patch, and a directory in place of the recorded original.
    const reserved = await issueDir()
    const dir = await writeRun(reserved, 'run-b', candidateRun(R(2)))
    await fs.mkdir(path.join(dir, 'checks', '001', 'artifacts', `${fp16(R(2))}.patch`), { recursive: true })
    await fs.writeFile(path.join(reserved, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-b', folder: '017-result' }]))
    await fs.mkdir(path.join(reserved, '017-result'), { recursive: true })
    await fs.writeFile(path.join(reserved, '017-result', 'result.md'), 'result\n')
    const r = await retainedWork({ issuePath: reserved, resolved: resolved() })
    const d = r.diagnostics.find((x) => x.runId === 'run-b' && x.name === 'candidate.patch')
    t.ok('the recorded original is checked anyway: not a regular file', /not a regular file/.test(d?.reason ?? ''), JSON.stringify(r.diagnostics))

    // An original inside the run behind a mode-000 directory: unreadable, not an escape.
    const locked = await issueDir()
    const ldir = await writeRun(locked, 'run-b', candidateRun(R(2)), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    const artifacts = path.join(ldir, 'checks', '001', 'artifacts')
    await fs.chmod(artifacts, 0o000)
    if (await fs.readdir(artifacts).then(() => true, () => false)) t.skip('mode-000 directory', 'this user can read a mode-000 directory (root)')
    else {
      const l = await retainedWork({ issuePath: locked, resolved: resolved() })
      const ld = l.diagnostics.find((x) => x.runId === 'run-b' && x.name === 'candidate.patch')
      t.ok('reported as unreadable', /could not be read/.test(ld?.reason ?? '') && !/leaves the run/.test(ld?.reason ?? ''), JSON.stringify(l.diagnostics))
    }
    await fs.chmod(artifacts, 0o755)
  }

  t.section('a zero-byte patch never makes the label retained-candidate (AC2)')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-b', candidateRun(R(2), { hash: sha(Buffer.alloc(0)) }), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: Buffer.alloc(0) } })
    const w = await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.eq('no reusable artifact, even with a matching digest', [w.labels, w.candidates], [['none'], []])
    t.ok('a diagnostic says it is empty', w.diagnostics.some((d) => d.runId === 'run-b' && /empty/.test(d.reason)), JSON.stringify(w.diagnostics))
  }

  t.section('a capture that would fail on a later input gives no candidate Accumulate access, earlier ones included (AC2)')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-a', candidateRun(R(1), { hash: null, startedAt: '2026-11-18T10:00:00.000Z' }), { files: { [`checks/001/artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await writeRun(issuePath, 'run-b', candidateRun(R(2), { startedAt: '2026-11-19T10:00:00.000Z' }))
    await fs.writeFile(path.join(issuePath, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-b', folder: '017-result' }]))
    await fs.mkdir(path.join(issuePath, '017-result'), { recursive: true })
    const blocked = path.join(issuePath, '017-result', 'result.md')
    await fs.writeFile(blocked, 'result\n')
    await fs.chmod(blocked, 0o000)
    if (await fs.readFile(blocked).then(() => true, () => false)) t.skip('unreadable result.md', 'this user can read a mode-000 file (root)')
    else {
      t.eq('capture throws', await captureWindow({ issuePath, runId: 'run-new', workspace: { path: issuePath }, limits: base.windowLimits, accumulate: true }).then(() => null, (e) => e.code), 'EACCES')
      const w = await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
      t.eq('the earlier candidate (no digest, so no download) is not reusable', [w.labels, w.candidates.length], [['none'], 0])
      t.ok('its diagnostic names the failing capture', w.diagnostics.some((d) => d.runId === 'run-a' && /capture-fails:EACCES/.test(d.reason)), JSON.stringify(w.diagnostics))
    }
    await fs.chmod(blocked, 0o644)
  }

  t.section('a closure finding keeps its revision without the snapshot; a malformed unrelated run.json keeps findings visible (AC3)')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-c', {
      startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }],
      outstandingFindings: [{ id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }],
      closureReturns: [{ step: '009', confirmationStep: '007' }]
    }, { outputs: { '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } } })
    const w = await retainedWork({ issuePath, resolved: resolved() })
    const f = w.evidence[0]?.findings.items.find((x) => x.id === 'closure-ac2')
    t.eq('no resolved-playbook.json, yet the confirmation\'s revision is named', [f?.provenance.confirmationStep, f?.provenance.revision], ['007', R(7)])
    await fs.mkdir(path.join(issuePath, 'runs', 'run-broken'), { recursive: true })
    await fs.writeFile(path.join(issuePath, 'runs', 'run-broken', 'run.json'), '{ not json')
    const again = await retainedWork({ issuePath, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.eq('the intact run\'s blocking finding is still shown', again.evidence.find((e) => e.runId === 'run-c')?.findings.items[0]?.blocking, true)
    t.ok('the Accumulate prediction says capture would fail', again.diagnostics.some((d) => /capture would fail/.test(d.reason)), JSON.stringify(again.diagnostics))
  }

  t.section('round 4: originals found by the resolver\'s own rules, each access path judged alone, readings isolated')
  {
    // A migrated original reachable only through checkHistory (a delivery return cleared checkResults; history keeps the old revision).
    const hist = await issueDir()
    const old = { revision: R(9), dir: 'checks/001', artifact: { ref: `checks/001/artifacts/${fp16(R(9))}.patch`, patchHash: sha(PATCH) } }
    await writeRun(hist, 'run-b', { startedAt: '2026-11-19T10:00:00.000Z', revisions: [{ fingerprint: R(2), migratedFrom: R(9) }], outstandingFindings: [], checkResults: [], checkHistory: [old] }, { files: { [`checks/001/artifacts/${fp16(R(9))}.patch`]: PATCH } })
    const h = await retainedWork({ issuePath: hist, resolved: resolved() })
    t.eq('a migrated original found only through checkHistory is linked', [h.labels, h.candidates[0]?.link.artifact, h.candidates[0]?.revision], [['retained-candidate'], 'check', R(2)])

    // A capture-fails placeholder does not cover the run: its original is examined anyway.
    const masked = await issueDir()
    const mdir = await writeRun(masked, 'run-b', candidateRun(R(2)))
    await fs.mkdir(path.join(mdir, 'checks', '001', 'artifacts', `${fp16(R(2))}.patch`), { recursive: true })
    await fs.writeFile(path.join(masked, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-b', folder: '017-result' }]))
    await fs.mkdir(path.join(masked, 'runs', 'run-broken'), { recursive: true })
    await fs.writeFile(path.join(masked, 'runs', 'run-broken', 'run.json'), '{ not json')
    const m = await retainedWork({ issuePath: masked, resolved: resolved() })
    t.ok('the original is reported as not a regular file despite the stopped walk', m.diagnostics.some((d) => d.runId === 'run-b' && d.name === 'candidate.patch' && /not a regular file/.test(d.reason)), JSON.stringify(m.diagnostics))

    // An empty changes.patch copy beside a non-empty verified delivery original: the original is downloadable.
    const copy = await issueDir()
    const rec = approvedRun(R(1))
    rec.closure.conditions = { ...rec.closure.conditions, deliveryCompleted: true }
    await writeRun(copy, 'run-a', rec, { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await fs.writeFile(path.join(copy, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-a', folder: '017-result' }]))
    await fs.mkdir(path.join(copy, '017-result'), { recursive: true })
    await fs.writeFile(path.join(copy, '017-result', 'changes.patch'), '')
    const c = await retainedWork({ issuePath: copy, resolved: resolved({ runOptions: { accumulate: true } }) })
    const entry = c.candidates.find((x) => x.runId === 'run-a' && x.name === 'changes.patch')
    t.eq('the empty copy gives no Accumulate access, the original still a download', [c.labels, entry?.access], [['retained-candidate'], ['download']])

    // A legacy check record (no digest) with a directory in place of its original: not regular, said first.
    const legacy = await issueDir()
    const ldir = await writeRun(legacy, 'run-b', candidateRun(R(2), { hash: null }))
    await fs.mkdir(path.join(ldir, 'checks', '001', 'artifacts', `${fp16(R(2))}.patch`), { recursive: true })
    const l = await retainedWork({ issuePath: legacy, resolved: resolved() })
    const ld = l.diagnostics.find((d) => d.runId === 'run-b' && d.name === 'candidate.patch')
    t.ok('reported as not a regular file, not only as lacking a digest', /not a regular file/.test(ld?.reason ?? '') && !/no runtime-recorded digest/.test(ld?.reason ?? ''), JSON.stringify(l.diagnostics))

    // A malformed .step-reservations.json: the Accumulate prediction fails alone, the readable finding stays.
    const resv = await issueDir()
    await writeRun(resv, 'run-c', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }], outstandingFindings: [{ id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }], closureReturns: [{ step: '009', confirmationStep: '007' }] },
      { outputs: { '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } } })
    await fs.writeFile(path.join(resv, '.step-reservations.json'), '{ not json')
    const p = await previewRun({ playbookId: 'implementation', configRoot, issue: { name: 'Retained', openedOn: '2026-11-21', path: resv, project: 'devpanel-project' }, project: { id: 'devpanel-project', path: resv } })
    t.eq('the preview keeps the blocking finding', [p.retainedWork?.state, p.retainedWork?.evidence?.[0]?.findings.items[0]?.blocking], ['read', true])
    t.ok('and says what Accumulate would carry could not be read', p.retainedWork?.diagnostics?.some((d) => /could not be read/.test(d.reason)), JSON.stringify(p.retainedWork?.diagnostics))

    // A malformed unrelated output: the confirmation's own output still names its revision.
    await fs.writeFile(path.join(resv, 'runs', 'run-c', 'outputs', '003.json'), '{ not json')
    await fs.writeFile(path.join(resv, '.step-reservations.json'), '[]')
    const o = await retainedWork({ issuePath: resv, resolved: resolved() })
    t.eq('one damaged output drops itself only', o.evidence[0]?.findings.items[0]?.provenance.revision, R(7))

    // Unreadable run records: findings unknown, not none.
    const broken = await issueDir()
    await fs.mkdir(path.join(broken, 'runs', 'run-x'), { recursive: true })
    await fs.writeFile(path.join(broken, 'runs', 'run-x', 'run.json'), '{ not json')
    const b = await retainedWork({ issuePath: broken, resolved: resolved() })
    t.eq('a single malformed run record: findings unknown', [b.evidence.length, b.findings?.state], [0, 'unknown'])
  }

  t.section('round 5: every original discovered per run, every preview read non-blocking and isolated per run')
  {
    // auditor-1-delivery-original-depends-on-capture-list (AC1): malformed reservations stop the walk, not the delivery link.
    const resv = await issueDir()
    const delivered = approvedRun(R(1))
    delivered.closure.conditions = { ...delivered.closure.conditions, deliveryCompleted: true }
    await writeRun(resv, 'run-a', delivered, { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await fs.writeFile(path.join(resv, '.step-reservations.json'), '{ not json')
    const r = await retainedWork({ issuePath: resv, resolved: resolved() })
    const d = r.candidates.find((x) => x.runId === 'run-a' && x.link.artifact === 'delivery')
    t.eq('malformed reservations: the verified delivery original is still a download', [r.labels, d?.revision, d?.access], [['retained-candidate'], R(1), ['download']])

    // auditor-1-candidate-file-loss-silent (AC7): a result copy reached for the delivered revision does not skip the final revision's check original.
    const lossy = await issueDir()
    const rec = approvedRun(R(1), { revisions: [{ fingerprint: R(1) }, { fingerprint: R(2), migratedFrom: R(8) }], checkResults: [{ revision: R(8), dir: 'checks/002', artifact: { ref: `checks/002/artifacts/${fp16(R(8))}.patch`, patchHash: sha(PATCH) } }] })
    rec.closure.conditions = { ...rec.closure.conditions, deliveryCompleted: true }
    const ldir = await writeRun(lossy, 'run-a', rec, { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await fs.mkdir(path.join(ldir, 'checks', '002', 'artifacts', `${fp16(R(8))}.patch`), { recursive: true })
    await fs.writeFile(path.join(lossy, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-a', folder: '017-result' }]))
    await fs.mkdir(path.join(lossy, '017-result'), { recursive: true })
    await fs.writeFile(path.join(lossy, '017-result', 'changes.patch'), PATCH)
    const l = await retainedWork({ issuePath: lossy, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.ok('the copy of revision 1 is reachable', l.candidates.some((x) => x.runId === 'run-a' && x.name === 'changes.patch' && x.access.includes('accumulate')), JSON.stringify(l.candidates))
    t.ok('the migrated check original of the final revision, a directory, is reported', l.diagnostics.some((x) => x.runId === 'run-a' && x.name === 'candidate.patch' && x.revision === R(2) && /not a regular file/.test(x.reason)), JSON.stringify(l.diagnostics))
    await fs.rm(path.join(ldir, 'checks', '002', 'artifacts', `${fp16(R(8))}.patch`), { recursive: true })
    await fs.writeFile(path.join(ldir, 'checks', '002', 'artifacts', `${fp16(R(8))}.patch`), PATCH)
    const l2 = await retainedWork({ issuePath: lossy, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.ok('and, once a verified file, it is linked beside the copy', l2.candidates.some((x) => x.runId === 'run-a' && x.name === 'candidate.patch' && x.revision === R(2) && x.link.artifact === 'check'), JSON.stringify(l2.candidates))

    // auditor-1-unreadable-run-reported-as-no-findings (AC3): an inaccessible run directory makes findings unknown and stays listed.
    const denied = await issueDir()
    await writeRun(denied, 'run-c', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }], outstandingFindings: [] })
    const xdir = await writeRun(denied, 'run-x', { startedAt: '2026-11-22T10:00:00.000Z' })
    await fs.chmod(xdir, 0o000)
    if (await fs.readdir(xdir).then(() => true, () => false)) t.skip('inaccessible run directory', 'this user can read a mode-000 directory (root)')
    else {
      const e = await retainedWork({ issuePath: denied, resolved: resolved() })
      t.eq('EACCES: findings unknown, the run named as unreadable', [e.findings?.state, e.findings?.unreadableRuns], ['unknown', ['run-x']])
      t.ok('and listed among the diagnostics with its code', e.diagnostics.some((x) => x.runId === 'run-x' && x.unreadable === 'EACCES'), JSON.stringify(e.diagnostics))
    }
    await fs.chmod(xdir, 0o755)

    // auditor-1-malformed-check-history-discards-findings (AC3): malformed fields of one run fail that part only.
    const odd = await issueDir()
    await writeRun(odd, 'run-c', {
      startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }], checkHistory: { broken: true }, checkResults: { broken: true }, reconciliations: { broken: true },
      outstandingFindings: [{ id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }], closureReturns: [{ step: '009', confirmationStep: '007' }]
    }, { outputs: { '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } } })
    const o = await retainedWork({ issuePath: odd, resolved: resolved({ runOptions: { accumulate: true } }) })
    t.eq('checkHistory as an object: the readable blocking finding is shown', [o.state, o.evidence[0]?.findings.items[0]?.blocking, o.evidence[0]?.findings.items[0]?.provenance.revision], ['read', true, R(7)])
    const op = await previewRun({ playbookId: 'implementation', configRoot, issue: { name: 'Retained', openedOn: '2026-11-21', path: odd, project: 'devpanel-project' }, project: { id: 'devpanel-project', path: odd } })
    t.eq('and the whole preview answers', op.retainedWork?.evidence?.[0]?.findings.items[0]?.id, 'closure-ac2')

    // auditor-1-output-fifo-stalls-findings (AC3): a FIFO output is refused without blocking, in the preview and in the dry walk.
    const fifo = await issueDir()
    const fdir = await writeRun(fifo, 'run-c', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }], outstandingFindings: [{ id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }], closureReturns: [{ step: '009', confirmationStep: '007' }] },
      { outputs: { '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } } })
    if (!(await mkfifo(path.join(fdir, 'outputs', '003.json')))) t.skip('FIFO output', 'mkfifo is not available')
    else {
      const f = await withinMs(5000, retainedWork({ issuePath: fifo, resolved: resolved({ runOptions: { accumulate: true } }) }))
      t.ok('the preview finishes', f !== 'timeout')
      t.eq('with the finding, its confirmation revision and the run revision', [f?.evidence?.[0]?.findings.items[0]?.provenance.revision, f?.evidence?.[0]?.revision], [R(7), R(3)])
      const rendered = await withinMs(5000, renderSteps(fifo, { runId: 'run-c', steps: [] }))
      t.ok('the dry walk\'s steps.md rendering does not block either', rendered !== 'timeout')
    }

    // auditor-1-dialog-omits-required-check-identities (AC4): the configured command ids, a tier only when it runs.
    const tiered = checksOutlook({ ...base, checks: { requirement: 'required', target: { kind: 'local', commands: [{ id: 'lint' }, { id: 'unit' }], finallyCommands: [{ id: 'stop' }] } } })
    t.eq('the full tier\'s configured ids, finalizers included', tiered.commands, [{ tier: 'full', ids: ['lint', 'unit', 'stop'] }])
    const modules = checksOutlook({ ...base, checks: { requirement: 'required', target: { tier: 'modules', timing: 'every-revision', modules: { test: { id: 'selftest' } }, commands: [{ id: 'load' }, { id: 'selftest' }] } } }, null, 'p')
    t.eq('a modules target names its slots', modules.commands, [{ tier: 'modules', ids: ['load', 'selftest'] }])
    t.eq('no ids when the checks will not run', checksOutlook({ ...base, workspace: { ...base.workspace, isolation: 'in-place' }, checks: tiered.checks ?? { requirement: 'required', target: { kind: 'local', commands: [{ id: 'lint' }] } } }).commands, undefined)
  }

  t.section('round 6: preview and route agree, sources deduplicated by artifact, every preview callback read-only and isolated')
  {
    const seedOf = (issuePath) => () => undeliveredApproval(issuePath, null, { readRun: store.readRunReadOnly })
    const closure = { outstandingFindings: [{ id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }], closureReturns: [{ step: '009', confirmationStep: '007' }] }
    const confirmation = { '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } }

    // auditor-1-returned-candidate-download-refused (AC2): a verified returned patch of a run that is not the seed is not offered.
    const returned = await issueDir()
    await writeRun(returned, 'run-a', { startedAt: '2026-11-19T10:00:00.000Z', revisions: [{ fingerprint: R(1) }], outstandingFindings: [],
      deliveryReturns: [{ from: { artifactRef: `artifacts/${fp16(R(1))}.patch`, revision: R(1), patchHash: sha(PATCH) } }] }, { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await writeRun(returned, 'run-b', { startedAt: '2026-11-20T10:00:00.000Z', revisions: [{ fingerprint: R(2) }], outstandingFindings: [] })
    const rt = await retainedWork({ issuePath: returned, resolved: resolved() })
    const served = await retainedPatchDownload({ issuePath: returned, runId: 'run-a', artifact: 'returned', revision: R(1), selectSeed: seedOf(returned) }).then(() => 'served', (e) => e.code)
    t.eq('the route refuses the returned patch as stale (no seed selected)', [rt.seed, served], [null, 'stale'])
    t.ok('and the preview offers no returned candidate, saying why', !rt.candidates.some((c) => c.link?.artifact === 'returned') && rt.diagnostics.some((d) => d.runId === 'run-a' && d.name === 'returned.patch' && /only while it is the selected seed/.test(d.reason)), JSON.stringify(rt))
    // Every link the preview offers, the route serves with the same selector.
    let agree = true
    for (const c of rt.candidates.filter((x) => x.link?.artifact)) {
      agree &&= await retainedPatchDownload({ issuePath: returned, runId: c.runId, artifact: c.link.artifact, revision: c.link.revision, selectSeed: seedOf(returned) }).then(() => true, () => false)
    }
    t.ok('preview and route agree on every offered link', agree)

    // auditor-1-seed-revision-masks-check-original (AC1): a missing delivery seed leaves the verified check original of its revision linked.
    const masked = await issueDir()
    const check = { revision: R(1), dir: 'checks/001', artifact: { ref: `checks/001/artifacts/${fp16(R(1))}.patch`, patchHash: sha(PATCH) } }
    await writeRun(masked, 'run-a', approvedRun(R(1), { checkResults: [check], checkHistory: [check] }), { files: { [`checks/001/artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await fs.writeFile(path.join(masked, '.step-reservations.json'), JSON.stringify([{ number: 17, invocationId: 'run-result:run-a', folder: '017-result' }]))
    await fs.mkdir(path.join(masked, '017-result'), { recursive: true })
    await fs.writeFile(path.join(masked, '017-result', 'changes.patch'), PATCH)
    const ms = await retainedWork({ issuePath: masked, resolved: resolved({ runOptions: { accumulate: true } }) })
    const checkLink = ms.candidates.find((c) => c.runId === 'run-a' && c.link?.artifact === 'check' && c.revision === R(1))
    t.eq('the seed is reported missing', [ms.seed?.runId, ms.seed?.state], ['run-a', 'missing'])
    t.ok('and the check original of the same revision is linked', Boolean(checkLink) && checkLink.access.includes('download'), JSON.stringify(ms.candidates))
    t.eq('which the route serves', await retainedPatchDownload({ issuePath: masked, runId: 'run-a', artifact: 'check', revision: R(1), selectSeed: seedOf(masked) }).then((r) => r.bytes.length, (e) => e.code), PATCH.length)

    // auditor-1-refusal-read-fifo-stalls-start-preview (AC3): a FIFO in the newest run's run.json never stalls previewRun.
    const fifo = await issueDir()
    await writeRun(fifo, 'run-c', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }], ...closure }, { outputs: confirmation })
    await fs.mkdir(path.join(fifo, 'runs', 'run-z'), { recursive: true })
    if (!(await mkfifo(path.join(fifo, 'runs', 'run-z', 'run.json')))) t.skip('FIFO run.json', 'mkfifo is not available')
    else {
      const p = await withinMs(5000, previewRun({ playbookId: 'implementation', configRoot, issue: { name: 'Retained', openedOn: '2026-11-21', path: fifo, project: 'devpanel-project' }, project: { id: 'devpanel-project', path: fifo } }))
      t.ok('previewRun finishes', p !== 'timeout')
      const item = p?.retainedWork?.evidence?.find((e) => e.runId === 'run-c')?.findings.items[0]
      t.eq('with the readable finding and its revision; the FIFO run listed unreadable', [item?.blocking, item?.provenance.revision, p?.retainedWork?.findings?.unreadableRuns], [true, R(7), ['run-z']])
    }

    // auditor-1-malformed-return-pointer-drops-preview (AC3): an object artifactRef on an older return costs nothing else.
    const pointer = await issueDir()
    await writeRun(pointer, 'run-a', approvedRun(R(1), { ...closure, deliveryReturns: [{ from: { artifactRef: { bad: true }, revision: R(0) } }] }), { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH }, outputs: confirmation })
    const pt = await retainedWork({ issuePath: pointer, resolved: resolved() })
    t.eq('the seed and its link survive', [pt.state, pt.seed?.runId, pt.seed?.link.artifact], ['read', 'run-a', 'delivery'])
    t.eq('and the blocking finding with its revision', [pt.evidence[0]?.findings.items[0]?.blocking, pt.evidence[0]?.findings.items[0]?.provenance.revision], [true, R(7)])

    // auditor-1-reconciliation-item-erases-open-findings (AC3): a [null] reconciliation entry erases nothing.
    const recon = await issueDir()
    await writeRun(recon, 'run-c', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }], ...closure, reconciliations: [{ n: 1, auditorFindings: [null] }] }, { outputs: confirmation })
    const rc = await retainedWork({ issuePath: recon, resolved: resolved() })
    t.eq('the closure finding keeps its state, blocking and revision', [rc.evidence[0]?.findings.state, rc.evidence[0]?.findings.items[0]?.blocking, rc.evidence[0]?.findings.items[0]?.provenance.revision], ['recorded', true, R(7)])

    // auditor-1-preview-overlap-persists-recovery-record (AC10): previewRun with the real overlap callback writes nothing.
    const damaged = await issueDir()
    await writeRun(damaged, 'run-a', approvedRun(R(1)), { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    await writeRun(damaged, 'run-b', candidateRun(R(2)), { files: { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH } })
    for (const id of ['run-a', 'run-b']) await fs.writeFile(path.join(damaged, 'runs', id, 'events.jsonl'), 'not json\n')
    const before = await treeState(damaged)
    const overlap = createPathOverlap({ listProjects: async () => [], listIssues: async () => [] })
    const op = await previewRun({ playbookId: 'implementation', configRoot, issue: { name: 'Retained', openedOn: '2026-11-21', path: damaged, project: 'devpanel-project' }, project: { id: 'devpanel-project', path: damaged },
      pathOverlap: (args) => overlap({ project: 'devpanel-project', projectPath: damaged, issuePath: damaged, ...args }) })
    t.ok('the overlap reading ran', op.retainedWork?.state === 'read')
    await coverageInput({ issuePath: damaged, target: { tier: 'modules', modules: {} }, projectPath: damaged })
    t.eq('no journal-recovery.json or anything else written, the coverage reading included', await treeState(damaged), before)
  }

  t.section('round 7: the route-level sequence (getIssue, then previewRun) never hangs and writes nothing')
  {
    // issues.js fixes its directory when it loads: a fresh module over a directory of its own (as test/fakes/fixture.mjs does).
    const issuesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-route-issues-'))
    const prior = process.env.DEVPANEL_ISSUES_DIR
    process.env.DEVPANEL_ISSUES_DIR = issuesDir
    const issues = await import(`../server/issues.js?route=${Date.now()}`)
    if (prior === undefined) delete process.env.DEVPANEL_ISSUES_DIR
    else process.env.DEVPANEL_ISSUES_DIR = prior
    const P = 'devpanel-project'
    // What GET /api/playbooks/:id/preview does (index.js): the issue read without settling, then previewRun.
    const route = async (id) => {
      const found = await issues.getIssue(P, id, { settle: false })
      return previewRun({ playbookId: 'implementation', configRoot, issue: { name: found.name, openedOn: found.openedOn, path: found.path, project: found.project }, project: { id: P, path: found.path } })
    }
    const indexSource = await fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8')
    t.ok('the preview route reads the issue with settle: false', indexSource.includes('await getIssue(project, issueId, { settle: false })'))

    // auditor-1-issue-step-reader-stalls-preview: a FIFO run.json beside a readable finding.
    const stalled = await issues.createIssue(P, { name: 'Route FIFO' })
    await writeRun(stalled.path, 'run-c', { startedAt: '2026-11-21T10:00:00.000Z', revisions: [{ fingerprint: R(3) }],
      outstandingFindings: [{ id: 'closure-ac2', severity: 'major', blocking: true, description: 'Unmet.', source: 'closure-confirmation', raisedInStep: '009' }], closureReturns: [{ step: '009', confirmationStep: '007' }] },
    { outputs: { '007': { contract: 'closureConfirmation', valid: true, output: { revision: R(7), criteria: [] } } } })
    await fs.mkdir(path.join(stalled.path, 'runs', 'run-z'), { recursive: true })
    if (!(await mkfifo(path.join(stalled.path, 'runs', 'run-z', 'run.json')))) t.skip('FIFO run.json through the route', 'mkfifo is not available')
    else {
      const p = await withinMs(5000, route(stalled.id))
      t.ok('getIssue then previewRun finishes within the bound', p !== 'timeout')
      const item = p?.retainedWork?.evidence?.find((e) => e.runId === 'run-c')?.findings.items[0]
      t.eq('with the readable blocking finding and its revision', [item?.blocking, item?.provenance.revision], [true, R(7)])
      await fs.rm(path.join(stalled.path, 'runs', 'run-z'), { recursive: true })
    }

    // auditor-1-preview-writes-repeat-lookup: a pending repeat lookup is not settled by the preview.
    const pending = await issues.createIssue(P, { name: 'Route repeat lookup' })
    const meta = JSON.parse(await fs.readFile(path.join(pending.path, 'issue.json'), 'utf8'))
    await fs.writeFile(path.join(pending.path, 'issue.json'), JSON.stringify({ ...meta, report: { fingerprint: 'fp' }, repeats: null, repeatLookup: { unread: ['x'] } }))
    const before = await treeState(issuesDir)
    const rp = await route(pending.id)
    t.ok('the preview answers', Boolean(rp?.retainedWork))
    t.eq('the issue tree is byte-identical after getIssue then previewRun', await treeState(issuesDir), before)
    await issues.getIssue(P, pending.id)
    t.ok('the fixture is a pending lookup: the issue page\'s settling read writes', JSON.stringify(await treeState(issuesDir)) !== JSON.stringify(before))
  }

  t.section('the preview carries it, reads only, and invokes nothing (AC10)')
  {
    const issuePath = await issueDir()
    await writeRun(issuePath, 'run-a', approvedRun(R(1)), { files: { [`artifacts/${fp16(R(1))}.patch`]: PATCH } })
    const before = await treeState(issuePath)
    const p = await previewRun({ playbookId: 'implementation', configRoot, issue: { name: 'Retained', openedOn: '2026-11-21', path: issuePath, project: 'devpanel-project' }, project: { id: 'devpanel-project', path: issuePath } })
    t.eq('retained work is in the preview', p.retainedWork?.labels, ['seed'])
    t.ok('the checks outlook too', Boolean(p.checksOutlook?.state))
    t.eq('the issue tree is unchanged', await treeState(issuePath), before)
  }
}
