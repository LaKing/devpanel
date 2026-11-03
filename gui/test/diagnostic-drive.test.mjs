import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { engineFixture, scriptFor, simulateProcessDeath } from './fakes/fixture.mjs'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import { startRun, resumeRun, releaseWorkspace, worktreeDiffDelivery, gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { readCheckLog } from '../server/runtime/check-log.mjs'
import { baselineOf, fingerprint, workspaceProjection } from '../server/runtime/fingerprint.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readPrompts, runDir } from '../server/runtime/store.mjs'
import { MAX_DIAGNOSTIC_DRIVES, diagnosticRequestProblem, offersDiagnosticDrive } from '../server/runtime/diagnostic-drive.mjs'

export const name = 'diagnostic drive — a variant runs on the check target and never reaches the revision, a gate or the patch'

const exec = promisify(execFile)
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const scratchOf = (p) => p.match(/must not become part of the candidate: (.+)/)[1].trim()

// What only the diagnostic holds. Any of these outside the drive is a leak.
const MARKER = 'diag-marker.txt'
const LINE = 'DIAGNOSTIC-LINE'
const FILE_TEXT = 'DIAGNOSTIC-FILE'
const VARIANT = `--- a/source.txt\n+++ b/source.txt\n@@ -1 +1,2 @@\n original\n+${LINE}\n--- /dev/null\n+++ b/${MARKER}\n@@ -0,0 +1 @@\n+${FILE_TEXT}\n`

const writeVariant = async (scratch, name = 'diag.patch', text = VARIANT) => {
  await fs.writeFile(path.join(scratch, name), text)
  return { reason: 'why does it fail on staging', patch: name }
}

/*
 * One run of the implementation playbook. `ask(turn, scratch)` is called on each
 * author turn and returns the request, or null. The author's candidate is always
 * the one file, so an unchanged answer is the same revision.
 */
async function scenario ({ target = null, requirement = 'required', ask = null, f = null, audit = null, runOptions = {}, delivery = null, hooks = null }) {
  const state = f?.state ?? {}
  Object.assign(state, { ask, audit, turns: 0, prompts: [] })
  const script = async (turn) => {
    const { stepId, round, attempt, prompt } = turn
    state.prompts.push({ stepId, round, attempt, prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      state.turns += 1
      await fs.writeFile(path.join(state.engine.run.workspace.path, 'candidate.txt'), 'work\n')
      const request = await state.ask?.(state.turns, scratchOf(prompt))
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt), ...(request ? { diagnosticDrive: request } : {}) })
    }
    if (stepId.startsWith('audit-')) {
      return fence({ verdict: 'approved', artifactRevision: state.audit?.(turn, state) ?? revision(prompt), findings: [], priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  if (!f) {
    f = await engineFixture({ playbook: 'implementation', script, ...(delivery ? { delivery } : {}) })
    f.state = state
    if (target) await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement, target })}\n`)
  }
  const options = { participants: { 'auditor-1': { model: 'gpt-6-astra' } }, ...runOptions }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: delivery ? worktreeDiffDelivery : f.delivery, runOptions: options
  })
  if (hooks) Object.assign(engine.hooks, hooks)
  await (hooks ? engine.drive().catch((error) => { if (!error.injected) throw error }) : engine.drive())
  return { engine, f, state }
}

const once = (scratchRequest) => (turn, scratch) => turn === 1 ? scratchRequest(scratch) : null
const local = (run) => ({ kind: 'local', retryFailed: 0, commands: [{ id: 'probe', run }] })
const freshPrint = (engine) => fingerprint(engine.run.workspace.path, { baseCommit: engine.run.workspace.baseCommit, baseline: engine.baseline ?? new Map(), clock: engine.clock, projection: workspaceProjection(engine.run.workspace) })
const release = (engine) => releaseWorkspace(engine).catch(() => {})
const authorPrompts = (state) => state.prompts.filter((p) => p.stepId === 'implement').map((p) => p.prompt)
const auditPrompts = (state) => state.prompts.filter((p) => p.stepId.startsWith('audit-')).map((p) => p.prompt)
const onRecord = (engine) => JSON.stringify({ revisions: engine.run.revisions, approvals: engine.run.approvals, checkResults: engine.run.checkResults, checkHistory: engine.run.checkHistory, baselineChecks: engine.run.baselineChecks })

/** What every isolation section asks of a finished run: the diagnostic's bytes are nowhere but its own record. */
async function notInCandidate (t, engine) {
  const print = await freshPrint(engine)
  t.eq('the current revision is the worktree as it stands', engine.run.revisions.at(-1).fingerprint, print.fingerprint)
  t.ok('the marker is not in the worktree', !(await fs.access(path.join(engine.run.workspace.path, MARKER)).then(() => true, () => false)))
  t.ok('the marker is not in the fingerprint', !print.entries.some((e) => e.path === MARKER))
  t.eq('the changed line is not in the worktree', await fs.readFile(path.join(engine.run.workspace.path, 'source.txt'), 'utf8'), 'original\n')
  const variantPrint = engine.run.diagnosticDrives.find((d) => d.variant?.fingerprint)?.variant.fingerprint
  if (variantPrint) t.ok('the variant\'s fingerprint is on no revision, approval or check', !onRecord(engine).includes(variantPrint))
  // By the fields a drive's record carries: a whole-record search would match any host path holding the word.
  const checks = [...engine.run.checkResults, ...engine.run.checkResults.flatMap((c) => c.attempts ?? []), ...(engine.run.checkHistory ?? []), ...(engine.run.baselineChecks ?? [])]
  t.ok('the revision has check records to look through', checks.length > 0)
  t.eq('no check or baseline record is a diagnostic one', checks.filter((c) => c.diagnostic || c.ofRevision || c.variant || /(^|\/)diagnostic-/.test(c.dir ?? '')).map((c) => c.dir), [])
}

export default async function (t) {
  t.section('a request is judged before anything runs')
  {
    const free = { recordsRevision: true, inLoop: true, used: 0 }
    const ok = { reason: 'r', patch: 'diag.patch' }
    t.eq('a relative path on an author turn is accepted', diagnosticRequestProblem(ok, free), null)
    t.ok('a turn that records no revision may not ask', diagnosticRequestProblem(ok, { ...free, recordsRevision: false }))
    t.ok('a step outside a review loop may not ask', diagnosticRequestProblem(ok, { ...free, inLoop: false }))
    t.ok('an absolute path is refused', diagnosticRequestProblem({ ...ok, patch: '/etc/hostname' }, free))
    t.ok('a path climbing out is refused', diagnosticRequestProblem({ ...ok, patch: 'a/../../x' }, free))
    t.ok('the run\'s limit is refused', diagnosticRequestProblem(ok, { ...free, used: MAX_DIAGNOSTIC_DRIVES }))
    const contract = { contracts: { defs: { authorArtifact: { properties: { diagnosticDrive: {} } } } } }
    const author = { recordsRevision: true, output: 'authorArtifact' }
    t.eq('an author in a loop is offered it', offersDiagnosticDrive(contract, { loop: {} }, author), true)
    t.eq('a run whose frozen contract lacks the field is not', offersDiagnosticDrive({ contracts: { defs: { authorArtifact: { properties: {} } } } }, { loop: {} }, author), false)
    t.eq('nor is a plan turn', offersDiagnosticDrive(contract, { loop: {} }, { output: 'authorArtifact' }), false)
  }

  t.section('the runner drives the variant in its temporary copy, and names no revision')
  {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-proj-'))
    const roots = [projectPath]
    const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); roots.push(d); return d }
    try {
      await exec('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
      await exec('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
      await exec('git', ['-C', projectPath, 'config', 'user.name', 'T'])
      await fs.writeFile(path.join(projectPath, 'source.txt'), 'original\n')
      await exec('git', ['-C', projectPath, 'add', '-A'])
      await exec('git', ['-C', projectPath, 'commit', '-qm', 'base'])
      const ws = await gitWorktreeProvider.create({ projectPath, runId: 'diag', root: await temp('diag-ws-'), policy: { base: 'head' } })
      const baseline = await baselineOf(ws.path)
      await fs.writeFile(path.join(ws.path, 'candidate.txt'), 'work\n')
      const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
      const drive = async (text) => {
        const scratch = await temp('diag-scratch-')
        const patchFile = path.join(scratch, 'variant.patch')
        await fs.writeFile(patchFile, text)
        return runChecks({ target: local(`cat ${MARKER}; grep ${LINE} source.txt; cat candidate.txt`), revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir: await temp('diag-run-'), dirName: 'diagnostic-001', variant: { patchFile } })
      }
      const driven = await drive(VARIANT)
      t.eq('the drive passed', driven.result, 'passed', driven.error)
      t.eq('its command read the variant and the candidate', driven.commands[0].stdout.trim().split('\n'), [FILE_TEXT, LINE, 'work'])
      t.eq('the result names no revision', driven.revision, null)
      t.eq('it says what it is a variant of', driven.ofRevision, fp.fingerprint)
      t.eq('it is marked diagnostic', driven.diagnostic, true)
      t.ok('the variant has its own fingerprint', driven.variant.fingerprint && driven.variant.fingerprint !== fp.fingerprint)
      t.eq('the record lists the files it changed', [...driven.variant.files].sort(), [MARKER, 'source.txt'].sort())
      t.eq('the worktree still fingerprints to the revision', (await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })).fingerprint, fp.fingerprint)
      t.eq('no leftover in the worktree', (await fs.readdir(ws.path)).includes(MARKER), false)

      const again = await drive('--- /dev/null\n+++ b/candidate.txt\n@@ -0,0 +1 @@\n+work\n')
      t.eq('a patch adding what the revision holds is refused', again.refused?.code, 'patch-does-not-apply')
      t.eq('and no command ran', again.commands, [])
      const garbage = await drive('this is not a patch\n')
      t.eq('a file that is no patch is refused', garbage.refused?.code, 'patch-does-not-apply')
      const noop = await drive('--- /dev/null\n+++ b/node_modules/x.js\n@@ -0,0 +1 @@\n+x\n')
      t.eq('a patch the fingerprint cannot see is refused as changing nothing', noop.refused?.code, 'no-op')
    } finally {
      for (const root of roots) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  }

  // The whole engine on an SSH target, through the fake service manager (check-tiers.test.mjs).
  const sshDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-diag-ssh-')))
  const managerEnv = await installRemoteManager(sshDir)
  await fs.mkdir(path.join(sshDir, 'units'))
  await fs.writeFile(path.join(sshDir, 'units', 'no-fence'), '')
  await fs.writeFile(path.join(sshDir, 'ssh'), ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join('\n') + '\n', { mode: 0o755 })
  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.CHECK_TEST_HOST }
  process.env.DEVPANEL_SSH_BIN = path.join(sshDir, 'ssh')
  process.env.CHECK_TEST_HOST = 'shim'

  try {
    t.section('over SSH: the variant runs on the target, the revision does not hold it, and the seats are told what it was')
    {
      const workdir = await fs.realpath(await fs.mkdtemp(path.join(sshDir, 'remote-')))
      const target = { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, retryFailed: 0, confinement: { user: os.userInfo().username, home: os.homedir() },
        commands: [{ id: 'probe', kind: 'candidate', run: `cd "$DEVPANEL_CANDIDATE_DIR"; if [ -f ${MARKER} ]; then echo saw-marker; else echo no-marker; fi` }] }
      const { engine, state, f } = await scenario({ target, ask: once((scratch) => writeVariant(scratch)) })
      const d = engine.run.diagnosticDrives?.[0]
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(d?.error)}`)
      t.eq('one diagnostic drive is on the record', engine.run.diagnosticDrives?.length, 1)
      t.eq('the record marks it diagnostic', d?.diagnostic, true)
      t.eq('it finished and passed', [d?.status, d?.result], ['finished', 'passed'], d?.error)
      t.eq('it ran on the SSH target', d?.target, 'ssh')
      t.eq('the variant reached the target', d?.commands?.[0]?.stdout?.trim(), 'saw-marker')
      t.eq('the revision\'s own check did not hold it', engine.run.checkResults.at(-1)?.commands?.[0]?.stdout?.trim(), 'no-marker')
      t.eq('the record has no revision', Object.hasOwn(d ?? {}, 'revision'), false)
      t.eq('it says what it is a variant of', d?.ofRevision, engine.run.revisions[0].fingerprint)
      t.eq('nothing is left on the host', (await fs.readdir(workdir)).length, 0)
      await notInCandidate(t, engine)

      t.section('the author reads the result on a later turn, before any audit')
      const [first, followUp] = authorPrompts(state)
      t.ok('the requesting turn was offered the drive', first.includes('Diagnostic drive:'))
      t.ok('the next turn holds the result', followUp?.includes('Diagnostic drive 1 finished: passed'))
      t.ok('and what the command said', followUp?.includes('saw-marker'))
      const implementSteps = engine.run.steps.filter((s) => s.stepId === 'implement')
      t.eq('that turn is the same round, marked as following the drive', implementSteps.map((s) => [s.round, s.attempt, s.diagnosticOf ?? null]), [[0, 1, null], [0, 1, 1]])
      const firstAudit = engine.run.steps.find((s) => s.stepId.startsWith('audit-') && s.phase === implementSteps[0].phase)
      t.ok('no audit ran before it', Number(firstAudit.number) > Number(implementSteps[1].number))
      t.eq('the turn before the drive started no check', engine.run.checkHistory.length, 1)
      const log = await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: 'diagnostic-001', command: 'probe' })
      t.ok('its log is served and says it is diagnostic', log.text.includes('saw-marker') && log.diagnostic === true && log.revision === null)
      t.ok('the frozen patch is kept with it', (await fs.readFile(path.join(runDir(f.issuePath, engine.runId), d.dir, 'variant.patch'), 'utf8')).includes(LINE))

      t.section('the auditor\'s prompt says it is diagnostic, not a check of the revision under audit')
      const audited = auditPrompts(state)
      t.ok('an audit ran', audited.length > 0)
      t.ok('every audit prompt says so', audited.every((p) => p.includes('diagnostic and NOT a check of the revision under audit')))
      const records = Object.values(await readPrompts(f.issuePath, engine.runId))
      const auditRecord = records.find((r) => r.stepId?.startsWith('audit-'))
      t.ok('the prompt record names the passage', auditRecord?.appended?.some((a) => a.reason === 'diagnostic-drives' && a.text.includes('"diagnostic":true')))
      const history = await fs.readdir(path.join(path.dirname(f.issuePath), '.selftest-history')).catch(() => [])
      const texts = await Promise.all(history.map((n) => fs.readFile(path.join(path.dirname(f.issuePath), '.selftest-history', n), 'utf8').catch(() => '')))
      t.ok('selftest history holds no line of it', !texts.join('').includes(d.treeIdentity ?? 'no tree identity recorded'))
      await release(engine)

      t.section('the revision is the one the candidate has without the drive')
      const control = await scenario({ f, ask: null })
      t.eq('the control run completes', control.engine.run.status, 'completed', `${control.engine.run.blockedReason}`)
      t.eq('it asked for no drive', control.engine.run.diagnosticDrives ?? [], [])
      t.eq('the two runs have the same revision', engine.run.revisions.at(-1).fingerprint, control.engine.run.revisions.at(-1).fingerprint)
      await release(control.engine)
    }

    t.section('a diagnostic pass does not satisfy the revision\'s failing check')
    {
      // Passes on the base (no candidate) and on the variant; fails on the revision alone.
      const { engine } = await scenario({ target: local(`test ! -f candidate.txt || test -f ${MARKER}`), ask: once((scratch) => writeVariant(scratch)) })
      t.eq('the drive passed', engine.run.diagnosticDrives[0].result, 'passed', engine.run.diagnosticDrives[0].error)
      t.ok('the revision\'s checks all failed', engine.run.checkHistory.length > 0 && engine.run.checkHistory.every((h) => h.result === 'failed'), JSON.stringify(engine.run.checkHistory.map((h) => h.result)))
      t.ok('the run did not complete', engine.run.outcome !== 'resolved', `${engine.run.status}/${engine.run.outcome}`)
      t.ok('closure did not count it', engine.run.closure?.conditions?.checksSatisfied !== true)
      await release(engine)
    }

    t.section('a diagnostic failure does not fail the revision, and no approval can bind to the variant')
    {
      // Passes on the revision, fails on the variant. The first audit echoes the variant's fingerprint.
      const echo = ({ attempt }, state) => attempt === 1 ? state.engine.run.diagnosticDrives[0].variant.fingerprint : null
      const { engine } = await scenario({ target: local(`test ! -f ${MARKER}`), ask: once((scratch) => writeVariant(scratch)), audit: echo })
      const d = engine.run.diagnosticDrives[0]
      t.eq('the drive failed', d.result, 'failed', d.error)
      t.eq('the run completes on the revision\'s own check', `${engine.run.status}/${engine.run.outcome}`, 'completed/resolved', engine.run.blockedReason)
      t.eq('closure counted that check', engine.run.closure?.conditions?.checksSatisfied, true)
      t.ok('the review naming the variant went to protocol repair', engine.run.steps.some((s) => s.stepId.startsWith('audit-') && s.attempt === 2))
      t.ok('every approval names the revision', engine.run.approvals.length > 0 && engine.run.approvals.every((a) => a.revision === engine.run.revisions.at(-1).fingerprint))
      await notInCandidate(t, engine)
      await release(engine)
    }

    t.section('the delivered patch and the delivered source hold none of it')
    {
      const { engine, f } = await scenario({ target: local('true'), ask: once((scratch) => writeVariant(scratch)), delivery: 'apply-to-source', runOptions: { base: 'working-tree' } })
      t.eq('the run delivered', `${engine.run.status}/${engine.run.outcome}`, 'completed/resolved', `${engine.run.blockedReason} ${engine.run.delivery?.error}`)
      t.eq('the drive ran', engine.run.diagnosticDrives[0].result, 'passed', engine.run.diagnosticDrives[0].error)
      const patch = await fs.readFile(path.join(runDir(f.issuePath, engine.runId), engine.run.delivery.artifactRef), 'utf8')
      t.ok('the patch holds the candidate', patch.includes('candidate.txt'))
      t.ok('the patch does not hold the diagnostic file', !patch.includes(MARKER) && !patch.includes(FILE_TEXT))
      t.ok('the patch does not hold the diagnostic change', !patch.includes(LINE) && !patch.includes('source.txt'))
      t.eq('the delivery is of the approved revision', engine.run.delivery.application?.fingerprint, engine.run.closure.revision)
      t.eq('the destination has the candidate', await fs.readFile(path.join(f.projectPath, 'candidate.txt'), 'utf8'), 'work\n')
      t.ok('the destination does not have the marker', !(await fs.access(path.join(f.projectPath, MARKER)).then(() => true, () => false)))
      t.eq('the destination\'s source is unchanged', await fs.readFile(path.join(f.projectPath, 'source.txt'), 'utf8'), 'original\n')
      await release(engine)
    }

    t.section('a request that cannot be driven is refused on the record, and the author is told')
    {
      const cases = [
        ['a missing patch', 'patch-unreadable', async () => ({ reason: 'r', patch: 'absent.patch' })],
        ['a link out of scratch', 'patch-unreadable', async (scratch) => { await fs.symlink('/etc/hostname', path.join(scratch, 'link.patch')); return { reason: 'r', patch: 'link.patch' } }],
        ['an empty patch', 'patch-unreadable', async (scratch) => writeVariant(scratch, 'empty.patch', '')],
        ['diagnostic code already in the candidate', 'patch-does-not-apply', async (scratch) => writeVariant(scratch, 'twice.patch', '--- /dev/null\n+++ b/candidate.txt\n@@ -0,0 +1 @@\n+work\n')],
        ['a smoke tier the target does not have', 'no-smoke-tier', async (scratch) => ({ ...(await writeVariant(scratch)), tier: 'smoke' })]
      ]
      for (const [label, code, request] of cases) {
        const { engine, state } = await scenario({ target: local('true'), ask: once(request) })
        const d = engine.run.diagnosticDrives?.[0]
        t.eq(`${label}: refused`, [d?.status, d?.refused?.code], ['refused', code], JSON.stringify(d))
        t.eq(`${label}: no command ran`, d?.commands ?? [], [])
        t.ok(`${label}: the author's next turn says so`, authorPrompts(state)[1]?.includes(code))
        t.eq(`${label}: the run goes on`, engine.run.status, 'completed', engine.run.blockedReason)
        await release(engine)
      }
      const none = await scenario({ ask: once((scratch) => writeVariant(scratch)) })
      t.eq('a project without a target: refused', none.engine.run.diagnosticDrives?.[0]?.refused?.code, 'no-target')
      t.ok('and it is not offered', !authorPrompts(none.state)[0].includes('Diagnostic drive:'))
      await release(none.engine)
      // Optional checks: resolution refuses required ones in place, before any engine runs.
      const inPlace = await scenario({ target: local('true'), requirement: 'optional', ask: once((scratch) => writeVariant(scratch)), runOptions: { isolation: 'in-place' } })
      t.eq('an in-place run: refused by the engine', inPlace.engine.run.diagnosticDrives?.[0]?.refused?.code, 'in-place')
      t.ok('and not offered', !authorPrompts(inPlace.state)[0].includes('Diagnostic drive:'))
      t.ok('the author\'s next turn says so', authorPrompts(inPlace.state)[1]?.includes('in-place'))
      t.ok('the marker did not reach the checkout', !(await fs.access(path.join(inPlace.f.projectPath, MARKER)).then(() => true, () => false)))
    }

    t.section('a bad path goes to protocol repair, and the run\'s limit holds')
    {
      const climbing = await scenario({ target: local('true'), ask: once(async () => ({ reason: 'r', patch: '../other/diag.patch' })) })
      t.eq('nothing was recorded', climbing.engine.run.diagnosticDrives ?? [], [])
      t.eq('the author restated', climbing.engine.run.steps.filter((s) => s.stepId === 'implement').map((s) => s.attempt), [1, 2])
      await release(climbing.engine)

      const counter = path.join(sshDir, 'limit-drives')
      const greedy = await scenario({ target: local(`if [ -f ${MARKER} ]; then echo ran >> ${counter}; fi`), ask: (turn, scratch) => turn <= MAX_DIAGNOSTIC_DRIVES + 1 ? writeVariant(scratch) : null })
      t.eq('the limit is on the record', greedy.engine.run.diagnosticDrives.length, MAX_DIAGNOSTIC_DRIVES)
      t.eq('and on the target', (await fs.readFile(counter, 'utf8')).trim().split('\n').length, MAX_DIAGNOSTIC_DRIVES)
      const implement = greedy.engine.run.steps.filter((s) => s.stepId === 'implement')
      t.eq('each drive had its own turn, and the extra request a repair', implement.map((s) => [s.attempt, s.diagnosticOf ?? null]), [[1, null], [1, 1], [1, 2], [1, 3], [2, 3]])
      t.eq('the run goes on', greedy.engine.run.status, 'completed', greedy.engine.run.blockedReason)
      await release(greedy.engine)
    }

    t.section('a crash: a drive is not run twice, and a lost one reads as lost')
    {
      const crashThenResume = async (hookName, counter) => {
        const hooks = { [hookName]: async (x) => { delete x.hooks[hookName]; throw Object.assign(new Error('owner crashed'), { injected: true }) } }
        const { engine, f, state } = await scenario({ target: local(`if [ -f ${MARKER} ]; then echo ran >> ${counter}; fi`), ask: once((scratch) => writeVariant(scratch)), hooks })
        await simulateProcessDeath(f.issuePath)
        const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
        state.engine = resumed
        await resumed.recover()
        await resumed.drive()
        return { resumed, state }
      }
      const ranIn = async (counter) => (await fs.readFile(counter, 'utf8').catch(() => '')).split('\n').filter(Boolean).length

      const during = path.join(sshDir, 'crash-during')
      const lost = await crashThenResume('beforeDiagnosticDrive', during)
      const d = lost.resumed.run.diagnosticDrives
      t.eq('a drive that lost its owner reads as interrupted', [d.length, d[0].status, d[0].result], [1, 'interrupted', 'unavailable'])
      t.eq('it was not run again', await ranIn(during), 0)
      t.ok('the author is told', authorPrompts(lost.state).at(-1).includes('interrupted'))
      t.eq('the run goes on', lost.resumed.run.status, 'completed', lost.resumed.run.blockedReason)
      await release(lost.resumed)

      const after = path.join(sshDir, 'crash-after')
      const done = await crashThenResume('afterDiagnosticDrive', after)
      t.eq('a finished drive answers on replay', [done.resumed.run.diagnosticDrives.length, done.resumed.run.diagnosticDrives[0].status], [1, 'finished'])
      t.eq('it ran once', await ranIn(after), 1)
      t.eq('the run goes on', done.resumed.run.status, 'completed', done.resumed.run.blockedReason)
      await release(done.resumed)
    }
  } finally {
    if (saved.bin === undefined) delete process.env.DEVPANEL_SSH_BIN; else process.env.DEVPANEL_SSH_BIN = saved.bin
    if (saved.host === undefined) delete process.env.CHECK_TEST_HOST; else process.env.CHECK_TEST_HOST = saved.host
    await fs.rm(sshDir, { recursive: true, force: true }).catch(() => {})
  }
}
