import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { resolvePlaybook, CONFIG_ROOT } from '../server/config/load.mjs'
import { captureIntegrity } from '../server/runtime/integrity.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { plan } from '../server/runtime/engine.mjs'
import { modulesErrors, modulesTarget } from '../server/infrastructure.mjs'
import { approvedModulesShapeErrors, modulesTiming } from '../server/runtime/modules-tier.mjs'
import { acceptableCheck } from '../server/runtime/run-control.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { summarisePreview } from '../server/supervisor-summary.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'
import { instanceName } from '../server/runtime/instance-drive.mjs'
import { destroyRunInstances, holdsInstance } from '../server/runtime/stage-instances.mjs'

export const name = 'modules timing — `testDrive.modules.timing: approved`: no drive on a rejected round, the drive on the approved or all-awaitsCheck revision, each round reads its own recording\'s drive, the shapes it refuses, and every surface that reports it'

const sh = promisify(execFile)
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const NL = String.fromCharCode(10)
const P = 'devpanel-project'
const REPORT = { id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[{"test":"@c/a: works"}]}\'', report: 'selftest' }
const INFRA = (modules) => ({
  kind: 'boilerplate', orientation: 'o',
  staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage', workdir: '/tmp' }, projectRoot: '/opt/stage', files: {} },
  deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:production', workdir: '/opt' }, projectRoot: '/opt/production', files: {} }],
  testDrive: { commands: [{ id: 'boot', run: 'true' }], ...(modules ? { modules } : {}) }
})
const DECLARED = (extra = {}) => ({
  collections: ['@*'],
  lint: { id: 'lint', run: 'lint-it {{files}}' }, load: { id: 'load', run: 'load-it' }, restart: { id: 'restart', run: 'restart-it' },
  ready: { id: 'ready', run: 'ready-it' }, test: { id: 'module-selftest', run: 'selftest-it {{filter}}', report: 'selftest' }, ...extra
})

/*
 * A modules tier of `kind: local` (the engine expands it as any). Its test
 * command reads the token the author wrote to @c/a/x.mjs and fails while
 * `<dir>/fail-<token>` exists, or once while `<dir>/fail-once-<token>` does;
 * every token it drove is appended to `<dir>/driven`.
 */
async function tier (dir, { timing = 'approved', retryFailed = 0, modules = {} } = {}) {
  const judge = path.join(dir, 'judge')
  await fs.writeFile(judge, `#!/bin/sh\ntok=$(cat @c/a/x.mjs 2>/dev/null | tr -cd 'A-Za-z0-9')\necho "$tok" >> '${dir}/driven'\nif [ -f '${dir}/fail-once-'"$tok" ]; then rm -f '${dir}/fail-once-'"$tok"; exit 1; fi\nif [ -f '${dir}/fail-'"$tok" ]; then exit 1; fi\nexit 0\n`, { mode: 0o755 })
  await fs.writeFile(path.join(dir, 'ok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { kind: 'local', ...(retryFailed == null ? {} : { retryFailed }), modules: {
    collections: ['@*'],
    lint: { id: 'lint', run: `${dir}/ok {{files}}` }, load: { id: 'load', run: 'true' }, restart: { id: 'restart', run: 'true' }, ready: { id: 'ready', run: 'true' },
    test: { id: 'module-selftest', run: `${judge} {{filter}}` }, finallyCommands: [REPORT], ...(timing ? { timing } : {}), ...modules
  } }
}
const driven = async (dir) => (await fs.readFile(path.join(dir, 'driven'), 'utf8').catch(() => '')).split(NL).filter(Boolean)

/*
 * An Implementation run on a playbook-declared modules target. `tokens[round]` is
 * what the author writes to @c/a/x.mjs (null: nothing changes); `audit(ctx)`
 * returns a review or nothing (approved). The log has every seat turn with the
 * number of drives recorded when it began.
 */
async function scenario ({ target, tokens = ['A'], audit = null, author = null, participants = { 'auditor-1': { model: 'gpt-6-astra' } }, requirement = 'required', isolation = null, cap = null, delivery = undefined, setup = null, beforeDrive = null, drive = true, sizing = null }) {
  const state = { engine: null, log: [], confirms: [], authors: [] }
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    const engine = state.engine
    const recheck = prompt.includes('Re-review of revision')
    state.log.push({ stepId, role, round, recheck, drives: (engine?.run.checkHistory ?? []).length, checksRunning: Boolean(engine?.checksInFlight), prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      state.authors.push({ round, prompt })
      const ws = engine.run.workspace.path
      if (author) await author(round, ws, state)
      else {
        const token = tokens[Math.min(round, tokens.length - 1)]
        if (token != null) {
          await fs.mkdir(path.join(ws, '@c/a'), { recursive: true })
          await fs.writeFile(path.join(ws, '@c/a/x.mjs'), `${token}\n`)
        }
      }
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      const review = await audit?.({ role, round, recheck, prompt, engine, state })
      return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [], ...(review ?? {}) })
    }
    if (stepId === 'confirm') {
      state.confirms.push(prompt)
      return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    }
    return scriptFor()(turn)
  }
  const f = state.f = await engineFixture({ playbook: 'implementation', script, ...(delivery ? { delivery } : {}) })
  await setup?.(f)
  const file = path.join(f.configRoot, 'playbooks/implementation.yaml')
  await fs.appendFile(file, `\nchecks: ${JSON.stringify({ requirement, target })}\n`)
  if (cap != null) await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('budgets:\n', `overrides:\n  implement-review.maxRounds: ${cap}\nbudgets:\n`))
  if (sizing) {
    const meta = path.join(f.issuePath, 'issue.json')
    await fs.writeFile(meta, JSON.stringify({ ...JSON.parse(await fs.readFile(meta, 'utf8')), sizing }, null, 2) + '\n')
  }
  const runOptions = { participants, ...(isolation ? { isolation } : {}), ...(delivery === 'apply-to-source' ? { base: 'working-tree' } : {}) }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: P })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: P },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: delivery === 'apply-to-source' ? worktreeDiffDelivery : f.delivery, runOptions
  })
  await beforeDrive?.(engine, f)
  if (drive) await engine.drive()
  const events = async () => (await readEvents(f.issuePath, engine.runId)).events
  return { engine, f, log: state.log, confirms: state.confirms, authors: state.authors, events: await events(), reread: events }
}

// A playbook on author-auditor-pingpong (no consensus, the reviewer before the fix) with a modules target.
const pingpongPlaybook = (timing) => YAML.stringify({
  id: 'pingpong', version: 1, title: 'Pingpong', description: 'A strategy approved modules timing cannot serve.', strategy: 'author-auditor-pingpong', strategyVersion: 1,
  participants: { coordinator: { model: 'opus-5-5' }, author: { model: 'opus-5-5' }, auditor: { model: 'gpt-6-astra' } },
  autoClose: { minimumVerification: 'review-only', justification: 'A fixture.' }, budgets: { maxSteps: 40, wallClockMinutes: 60 },
  checks: { requirement: 'required', target: { kind: 'local', modules: DECLARED(timing ? { timing } : {}) } }
})
const started = (events) => events.filter((e) => e.type === 'checks-started')
const replay = (engine) => plan(engine.snapshot, engine.activeSteps(), engine.outputs, { checkResults: engine.checkEvidence() })
const audits = (log) => log.filter((l) => l.stepId.startsWith('audit-'))
const reject = (role, round) => ({ verdict: 'changes-needed', findings: [blocking(`${role}-${round}`)] })
const awaiting = (role, round) => ({ verdict: 'changes-needed', findings: [{ ...blocking(`${role}-drive-${round}`), awaitsCheck: true }] })

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  const writeProject = (f, infra) => fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true }).then(() => fs.writeFile(path.join(f.configRoot, `projects/${P}.yaml`), YAML.stringify({ id: P, infrastructure: infra })))
  try {
    t.section('the setting: testDrive.modules.timing; undeclared, the target and its snapshot are today\'s (AC1, AC6)')
    {
      const f = await engineFixture({ playbook: 'implementation' })
      await writeProject(f, INFRA(DECLARED()))
      const plain = await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })
      t.eq('undeclared: every-revision, and no timing key is added to the declaration', [plain.resolved?.checks.target.timing, 'timing' in plain.resolved.checks.target.modules, modulesTiming(plain.resolved.checks.target)], ['every-revision', false, 'every-revision'])
      t.eq('the target is the one modulesTarget always built', plain.resolved.checks.target, modulesTarget(INFRA(DECLARED())))
      const again = await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })
      t.eq('the configHash depends only on the files, so an unchanged project keeps it', again.resolved.configHash, plain.resolved.configHash)
      await writeProject(f, INFRA(DECLARED({ timing: 'approved' })))
      for (const id of ['implementation', 'plan-and-implement', 'refactoring', 'prompt']) {
        const r = await resolvePlaybook(id, { root: f.configRoot, projectId: P })
        t.eq(`approved: ${id} resolves with the timing on the target`, [r.ok, r.resolved?.checks.target.timing, modulesTiming(r.resolved?.checks.target)], [true, 'approved', 'approved'], JSON.stringify(r.errors))
      }
      await writeProject(f, INFRA(DECLARED({ timing: 'sometimes' })))
      t.ok('any other value is refused by the schema', !(await resolvePlaybook('implementation', { root: f.configRoot, projectId: P })).ok)
      t.eq('validation replaces the refusal: approved is accepted, a disagreement is not', [modulesErrors({ modules: DECLARED(), timing: 'approved' }), modulesErrors({ modules: DECLARED({ timing: 'approved' }), timing: 'every-revision' }).some((e) => /disagree/.test(e))], [[], true])

      // A playbook-declared target: nested only, or on the target, never two different values.
      const g = await engineFixture({ playbook: 'implementation' })
      const file = path.join(g.configRoot, 'playbooks/implementation.yaml')
      const original = await fs.readFile(file, 'utf8')
      const withTarget = async (target, requirement = 'required') => { await fs.writeFile(file, `${original}\nchecks: ${JSON.stringify({ requirement, target })}\n`); return resolvePlaybook('implementation', { root: g.configRoot, projectId: P }) }
      const nested = await withTarget({ kind: 'local', modules: DECLARED({ timing: 'approved' }) })
      t.eq('a playbook target declaring it in modules carries it on the target too', [nested.ok, nested.resolved?.checks.target.timing], [true, 'approved'], JSON.stringify(nested.errors))
      const disagree = await withTarget({ kind: 'local', timing: 'every-revision', modules: DECLARED({ timing: 'approved' }) })
      t.ok('two different values are refused', !disagree.ok && disagree.errors.some((e) => /disagree/.test(e.message)), JSON.stringify(disagree.errors?.map((e) => e.message)))
      // A strategy the gate cannot serve (author-auditor-pingpong: no consensus, the reviewer first) is refused
      // at resolution under approved timing, and resolves under the default.
      await fs.writeFile(file, original)
      const pingpong = async (timing) => {
        await fs.writeFile(path.join(g.configRoot, 'playbooks/pingpong.yaml'), pingpongPlaybook(timing))
        return resolvePlaybook('pingpong', { root: g.configRoot, projectId: P })
      }
      const refusedShape = await pingpong('approved')
      t.ok('a pingpong strategy under approved timing is refused, naming R1 and R2', !refusedShape.ok && ['(R1)', '(R2)'].every((rule) => refusedShape.errors.some((e) => e.message.includes(rule))), JSON.stringify(refusedShape.errors?.map((e) => e.message)))
      const defaultShape = await pingpong(null)
      t.ok('and resolves under the default timing', defaultShape.ok, JSON.stringify(defaultShape.errors))
      await fs.rm(path.join(g.configRoot, 'playbooks/pingpong.yaml'))
    }

    t.section('the shapes approved timing can serve (R0–R7); the bundled strategies conform, others are refused naming the rule')
    {
      const target = { tier: 'modules', timing: 'approved', modules: {} }
      const audit = (id, extra = {}) => ({ id, role: id, output: 'reviewResult', ...extra })
      const author = { id: 'implement', role: 'author', output: 'authorArtifact', recordsRevision: true }
      const loop = (steps, extra = {}) => ({ id: 'review', loop: { consensus: true, until: 'review.verdict == approved && !review.substantial', maxRounds: 3, steps, ...extra } })
      const resolved = (phases, requirement = 'required', participants = { author: {}, a1: {}, a2: {}, confirmer: {} }) => ({ checks: { requirement, target }, participants, phases })
      const rules = (r) => approvedModulesShapeErrors(r).map((e) => /\((R\d)\)/.exec(e)?.[1])
      t.eq('a conforming loop and a confirmation after it', rules(resolved([loop([author, audit('a1')]), { id: 'confirm', step: { id: 'confirm', role: 'confirmer', output: 'closureConfirmation' } }])), [])
      t.eq('R0: requirement none', rules(resolved([loop([author, audit('a1')])], 'none')), ['R0'])
      t.eq('R1: no consensus', rules(resolved([loop([author, audit('a1')], { consensus: false })])), ['R1'])
      t.eq('R2: a reviewer before the recording step (pingpong)', rules(resolved([loop([audit('a1'), { ...author, when: 'review.substantial' }])])), ['R2'])
      t.eq('R2: a reviewer that also records a revision, after the author', rules(resolved([loop([author, audit('a1', { recordsRevision: true })])])), ['R2'])
      t.eq('R2: a standalone reviewer that records a revision', rules(resolved([{ id: 'review-and-record', step: audit('a1', { recordsRevision: true }) }])), ['R2'])
      t.eq('R2: the same, as the only recording step',rules(resolved([loop([{ ...author, recordsRevision: false }, audit('a1', { recordsRevision: true })])])), ['R2'])
      t.eq('R3: a guarded reviewer', rules(resolved([loop([author, audit('a1', { when: 'review.substantial' })])])), ['R3'])
      t.eq('R4: a confirmation inside the loop', rules(resolved([loop([author, audit('a1'), { id: 'confirm', role: 'confirmer', output: 'closureConfirmation' }])])), ['R4'])
      t.eq('R5: a reviewer phase after the recording loop', rules(resolved([loop([author, audit('a1')]), loop([audit('a2')])])), ['R5'])
      t.eq('R6: a standalone recorder with a reviewer after it', rules(resolved([{ id: 'execute', step: author }, loop([audit('a2')])])), ['R6', 'R5'])
      t.eq('R6: a standalone recorder alone (Prompt) is served', rules(resolved([{ id: 'execute', step: author }])), [])
      t.eq('R7: an until that does not need approval', rules(resolved([loop([author, audit('a1')], { until: '!review.substantial' })])), ['R7'])
      t.eq('an empty reviewer seat decides nothing, so it breaks no rule', rules(resolved([loop([audit('a1'), author])], 'required', { author: {} })), [])
      t.eq('under the default timing nothing is refused', approvedModulesShapeErrors({ ...resolved([loop([author, audit('a1')], { until: '!review.substantial' })]), checks: { requirement: 'none', target: { tier: 'modules', modules: {} } } }), [])
    }

    t.section('R2: a reviewer that records a revision in its own turn is refused at resolution, and no run of it starts')
    {
      const f = await engineFixture({ playbook: 'implementation' })
      const strategyFile = path.join(f.configRoot, 'strategy-templates/implementation/strategy.yaml')
      const strategy = await fs.readFile(strategyFile, 'utf8')
      const recording = strategy.replace(/(- id: audit-implement-1\n\s+role: auditor-1\n\s+prompt: audit\.md\n(\s+)output: reviewResult\n)/, '$1$2recordsRevision: true\n')
      t.ok('the fixture strategy makes auditor-1 record a revision', recording !== strategy)
      await fs.writeFile(strategyFile, recording)
      const file = path.join(f.configRoot, 'playbooks/implementation.yaml')
      const original = await fs.readFile(file, 'utf8')
      const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
      const withTiming = async (timing) => {
        await fs.writeFile(file, `${original}\nchecks: ${JSON.stringify({ requirement: 'required', target: { kind: 'local', modules: DECLARED(timing ? { timing } : {}) } })}\n`)
        return resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: P })
      }
      const refused = await withTiming('approved')
      t.ok('approved: refused, naming the reviewer and R2', !refused.ok && refused.errors.some((e) => e.message.includes('audit-implement-1') && e.message.includes('(R2)')), JSON.stringify(refused.errors?.map((e) => e.message)))
      const started = await startRun({ playbookId: 'implementation', issue: { ...f.issue, project: P }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
        workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions }).then(() => null, (e) => e)
      t.ok('the engine is not started on it', started instanceof Error && /R2/.test(started.message), started?.message)
      t.eq('and no run record was left', await fs.readdir(path.join(f.issuePath, 'runs')).catch(() => []), [])
      t.ok('the default timing still resolves it, as today', (await withTiming(null)).ok)
    }

    t.section('R2: a standalone reviewer that records a revision is refused too, and no run of it starts')
    {
      // The Prompt strategy's single recording step made a reviewer: standalone, no loop, nothing after it.
      const f = await engineFixture({ playbook: 'prompt' })
      const strategyFile = path.join(f.configRoot, 'strategy-templates/prompt/strategy.yaml')
      const strategy = await fs.readFile(strategyFile, 'utf8')
      const reviewing = strategy.replace(/(id: execute\n\s+role: worker\n\s+prompt: execute\.md\n\s+output: )singleSeatResult/, '$1reviewResult')
      t.ok('the fixture strategy makes the recording step a reviewer', reviewing !== strategy && /recordsRevision: true/.test(reviewing))
      await fs.writeFile(strategyFile, reviewing)
      const file = path.join(f.configRoot, 'playbooks/prompt.yaml')
      const original = await fs.readFile(file, 'utf8')
      const withTiming = async (timing) => {
        await fs.writeFile(file, `${original}\nchecks: ${JSON.stringify({ requirement: 'required', target: { kind: 'local', modules: DECLARED(timing ? { timing } : {}) } })}\n`)
        return resolvePlaybook('prompt', { root: f.configRoot, projectId: P })
      }
      const refused = await withTiming('approved')
      t.ok('approved: refused, naming the step and R2', !refused.ok && refused.errors.some((e) => e.message.includes('step "execute"') && e.message.includes('(R2)')), JSON.stringify(refused.errors?.map((e) => e.message)))
      const started = await startRun({ playbookId: 'prompt', issue: { ...f.issue, project: P }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
        workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery }).then(() => null, (e) => e)
      t.ok('the engine is not started on it', started instanceof Error && /R2/.test(started.message), started?.message)
      t.eq('and no run record was left', await fs.readdir(path.join(f.issuePath, 'runs')).catch(() => []), [])
      const plain = await withTiming(null)
      t.ok('the default timing still resolves it, as today', plain.ok, JSON.stringify(plain.errors?.map((e) => e.message)))
    }

    t.section('AC7: a rejected round — no drive starts, and the next author turn begins at once')
    {
      const dir = await temp('devpanel-mt-reject-')
      const { engine, log, events } = await scenario({ target: await tier(dir), tokens: ['A', 'B'], audit: ({ role, round }) => round === 0 ? reject(role, round) : null })
      const [a, b] = engine.run.revisions
      t.eq('the run completes on the second revision', [engine.run.status, engine.run.revisions.length], ['completed', 2], engine.run.blockedReason)
      t.eq('only the approved revision was driven', [await driven(dir), started(events).map((e) => [e.revision, e.tier])], [['B'], [[b.fingerprint, 'modules']]])
      const next = log.find((l) => l.stepId === 'implement' && l.round === 1)
      t.eq('the author\'s next turn began with no drive recorded or running', [next?.drives, next?.checksRunning], [0, false])
      t.ok('no record names the rejected revision', !engine.run.checkHistory.some((h) => h.revision === a.fingerprint))
      t.eq('closure counted the approved revision\'s drive', engine.run.closure?.conditions?.checksSatisfied, true)
      await releaseWorkspace(engine)
    }

    t.section('AC7: an approved round — the drive runs after the audit, and gates')
    {
      const dir = await temp('devpanel-mt-approve-')
      const { engine, log, events, confirms } = await scenario({ target: await tier(dir) })
      t.eq('the audit ran with no drive beside it', audits(log).map((a) => [a.round, a.drives, a.checksRunning]), [[0, 0, false]])
      t.eq('one drive, after it, on the approved revision', started(events).map((e) => e.revision), [engine.run.revisions[0].fingerprint])
      t.ok('the confirmation reads that drive', confirms.at(-1)?.includes(engine.run.checkHistory[0].dir))
      t.eq('and closure counts it', [engine.run.status, engine.run.closure?.conditions?.checksSatisfied], ['completed', true])
      await releaseWorkspace(engine)
    }

    t.section('AC7 and failedInTests: a drive that fails after approval returns the author; the next revision is audited and driven again')
    {
      const dir = await temp('devpanel-mt-fail-')
      await fs.writeFile(path.join(dir, 'fail-A'), '')
      const { engine, log, events } = await scenario({ target: await tier(dir, { retryFailed: null }), tokens: ['A', 'B'] })
      t.eq('A failed, B passed, each driven once after its approval', await driven(dir), ['A', 'B'])
      t.eq('two rounds: audit, drive, author, audit, drive', log.filter((l) => l.stepId === 'implement' || l.stepId.startsWith('audit-')).map((l) => [l.stepId.replace(/-\d$/, ''), l.round, l.drives]), [['implement', 0, 0], ['audit-implement', 0, 0], ['implement', 1, 1], ['audit-implement', 1, 1]])
      t.eq('tests that failed on their own exit are not driven again (failedInTests)', [events.filter((e) => e.type === 'checks-retry').length, events.filter((e) => e.type === 'checks-retry-skipped').map((e) => e.reason)], [0, ['tests-failed']])
      t.eq('the run completes', [engine.run.status, engine.run.closure?.conditions?.checksSatisfied], ['completed', true], engine.run.blockedReason)
      await releaseWorkspace(engine)
    }

    t.section('AC7: awaitsCheck — the drive runs on a revision whose every substantial finding awaits it, and the seat reviews again')
    {
      const dir = await temp('devpanel-mt-await-')
      const { engine, log, events } = await scenario({ target: await tier(dir), audit: ({ role, round, recheck }) => recheck ? null : awaiting(role, round) })
      t.eq('one drive on the one revision', [await driven(dir), started(events).length, engine.run.revisions.length], [['A'], 1, 1])
      t.eq('then a re-review in the same round, with the drive on record', audits(log).map((a) => [a.round, a.recheck, a.drives]), [[0, false, 0], [0, true, 1]])
      t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
      await releaseWorkspace(engine)
    }

    t.section('AC7: the default timing is unchanged — every revision is driven beside its reviews (modules-tier.test.mjs keeps passing untouched)')
    {
      const dir = await temp('devpanel-mt-default-')
      const { engine, events } = await scenario({ target: await tier(dir, { timing: null }), tokens: ['A', 'B'], audit: ({ role, round }) => round === 0 ? reject(role, round) : null })
      t.eq('both revisions driven, the rejected one too', [await driven(dir), started(events).length], [['A', 'B'], 2])
      t.eq('the tier\'s timing reads every-revision', modulesTiming(engine.snapshot.checks.target), 'every-revision')
      await releaseWorkspace(engine)
    }

    t.section('the last allowed round with findings of its own beside an awaitsCheck one: no drive, said as rejected-round')
    {
      const dir = await temp('devpanel-mt-last-')
      const { engine, events } = await scenario({ target: await tier(dir), cap: 1, audit: ({ role, round }) => ({ verdict: 'changes-needed', findings: [{ ...blocking(`${role}-drive-${round}`), awaitsCheck: true }, blocking(`${role}-${round}`)] }) })
      t.eq('rounds exhausted, nothing driven', [engine.run.blockedReason ?? engine.run.outcome, started(events).length, await driven(dir)], ['rounds-exhausted', 0, []])
      t.eq('driveNotRun names the round and the reason', [engine.run.driveNotRun?.reason, engine.run.driveNotRun?.revision, engine.run.driveNotRun?.round], ['rejected-round', engine.run.revisions[0].fingerprint, 0])
      const schema = JSON.parse(await fs.readFile(path.join(CONFIG_ROOT, 'schemas/run.schema.json'), 'utf8'))
      const validate = new Ajv2020({ strict: false }).compile(schema.properties.driveNotRun)
      t.ok('the record satisfies run.schema.json', validate(engine.run.driveNotRun), JSON.stringify(validate.errors))
      t.ok('the explanation says why', explainRun(engine.run).detail?.includes('timing: approved') || JSON.stringify(explainRun(engine.run)).includes('rejected it for findings of its own'), JSON.stringify(explainRun(engine.run)))
      await releaseWorkspace(engine)
    }

    t.section('A → B → A: a result counts only for its own recording, so the restored A is driven again and closure reads that drive')
    for (const [label, opening] of [
      ['A\'s first drive fails', { fail: 'fail-once-A', audit: ({ role, round }) => round === 1 ? reject(role, round) : null }],
      ['A\'s awaitsCheck drive passes, then the re-review rejects it', { fail: null, audit: ({ role, round, recheck }) => round === 0 ? (recheck ? reject(role, round) : awaiting(role, round)) : round === 1 ? reject(role, round) : null }]
    ]) {
      const dir = await temp('devpanel-mt-aba-')
      if (opening.fail) await fs.writeFile(path.join(dir, opening.fail), '')
      const { engine, log, events, confirms } = await scenario({ target: await tier(dir), tokens: ['A', 'B', 'A'], audit: opening.audit })
      const [a, b, a2] = engine.run.revisions
      t.eq(`${label}: the restored revision has A's fingerprint`, [a2?.fingerprint === a.fingerprint, b.fingerprint !== a.fingerprint], [true, true])
      t.eq(`${label}: A driven twice, B never`, [await driven(dir), started(events).map((e) => e.revision === a.fingerprint ? 'A' : 'B')], [['A', 'A'], ['A', 'A']])
      const round2 = audits(log).filter((l) => l.round === 2)
      t.eq(`${label}: the second drive came after the round-2 audit`, [round2.map((l) => l.drives), engine.run.checkHistory.length], [[1], 2])
      const second = engine.run.checkHistory.at(-1)
      t.eq(`${label}: it is bound to the restored recording`, second.step, a2.byStep)
      t.ok(`${label}: the confirmation names the second drive`, confirms.at(-1)?.includes(second.dir) && !confirms.at(-1)?.includes(engine.run.checkHistory[0].dir))
      t.eq(`${label}: closure reads it`, [engine.run.status, engine.run.closure?.conditions?.checksSatisfied], ['completed', true], engine.run.blockedReason)
      t.eq(`${label}: replay of the final record reaches the same terminal`, [replay(engine).kind, replay(engine).reason], ['terminal', 'complete'])
      await releaseWorkspace(engine)
    }

    t.section('same bytes: the author answers a failed drive unchanged — that recording\'s drive still counts, one drive, checks-failed-unchanged')
    {
      const dir = await temp('devpanel-mt-same-')
      await fs.writeFile(path.join(dir, 'fail-A'), '')
      const { engine, events } = await scenario({ target: await tier(dir), tokens: ['A', 'A'] })
      t.eq('stopped by the check alone', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked checks-failed-unchanged')
      t.eq('one drive', [started(events).length, await driven(dir)], [1, ['A']])
      await releaseWorkspace(engine)
    }

    t.section('scoped acceptance: accepting the latest failed drive of A leaves an earlier recording\'s failure as it was')
    {
      const dir = await temp('devpanel-mt-accept-')
      await fs.writeFile(path.join(dir, 'fail-A'), '')
      const { engine, events } = await scenario({ target: await tier(dir), tokens: ['A', 'B', 'A', 'A'], audit: ({ role, round }) => round === 1 ? reject(role, round) : null })
      t.eq('A failed twice, B never driven; the author answered the second failure unchanged', [await driven(dir), `${engine.run.status} ${engine.run.blockedReason}`], [['A', 'A'], 'blocked checks-failed-unchanged'])
      const offered = acceptableCheck(engine.run)
      await engine.acceptCheckResult({ failures: offered.failures.map((x) => x.key), reason: 'the failure is in a suite this change does not touch', revision: offered.revision, actor: 'alice' })
      await engine.drive()
      t.eq('the run completes on the acceptance', engine.run.status, 'completed', engine.run.blockedReason)
      const evidence = engine.checkEvidence().filter((c) => c.revision === offered.revision)
      const [first, latest] = engine.run.checkHistory
      const ofLatest = evidence.filter((c) => c.dir === latest.dir)
      t.eq('the first recording\'s drive still reads failed; every record of the accepted drive reads passed', [evidence.find((c) => c.dir === first.dir)?.result, ofLatest.length > 0 && ofLatest.every((c) => c.accepted && c.result === 'passed')], ['failed', true])
      t.eq('no further drive', started(await (await readEvents(engine.issuePath, engine.runId)).events).length, started(events).length)
      await releaseWorkspace(engine)
    }

    t.section('in place, checks optional: the drive cannot run, one not-run is recorded for the recording, and the run advances')
    {
      const dir = await temp('devpanel-mt-inplace-')
      const { engine, events, confirms } = await scenario({ target: await tier(dir), requirement: 'optional', isolation: 'in-place' })
      const notRun = engine.run.checkHistory.filter((h) => h.result === 'not-run')
      t.eq('exactly one not-run, carrying the recording step', [notRun.length, notRun[0]?.step, notRun[0]?.revision], [1, engine.run.revisions[0].byStep, engine.run.revisions[0].fingerprint])
      t.eq('no drive started', started(events).length, 0)
      t.eq('the run reached closure, not max-turns-reached', [confirms.length, Boolean(engine.run.closure), engine.run.blockedReason === 'max-turns-reached'], [1, true, false])
    }

    t.section('a delivery return: the reconciled revision is a recording of its own and gets a fresh drive, which confirm and closure read')
    {
      const dir = await temp('devpanel-mt-return-')
      const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join(NL) + NL
      const CANDIDATE = lines(10, { 5: 'line 5 by the candidate', 9: 'line 9 fixed' })
      const { engine, confirms, events } = await scenario({
        target: await tier(dir), delivery: 'apply-to-source',
        setup: async (f) => {
          await fs.writeFile(path.join(f.projectPath, 'server.mjs'), lines(10))
          await sh('git', ['-C', f.projectPath, 'add', '-A'])
          await sh('git', ['-C', f.projectPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'source'])
        },
        author: async (round, ws, state) => {
          await fs.mkdir(path.join(ws, '@c/a'), { recursive: true })
          await fs.writeFile(path.join(ws, '@c/a/x.mjs'), 'A\n')
          // The live source moves under the candidate's line 5, so delivery conflicts; the author keeps the candidate's bytes.
          await fs.writeFile(path.join(ws, 'server.mjs'), CANDIDATE)
          if (round === 0) await fs.writeFile(path.join(state.f.projectPath, 'server.mjs'), lines(10, { 1: 'line 1 elsewhere', 5: 'line 5 by someone else' }))
        },
        beforeDrive: (engine) => { engine.reconcilePolicy = () => ({}) }
      })
      const back = engine.run.steps.find((s) => s.decision?.deliveryReturn != null)
      t.ok('the delivery conflicted and went back to the author', Boolean(back), `${engine.run.status} ${engine.run.blockedReason} ${engine.run.delivery?.error ?? ''}`)
      const [approved, reconciled] = engine.run.revisions
      t.eq('the author kept the candidate\'s bytes: the reconciled revision has the approved one\'s fingerprint', reconciled?.fingerprint, approved.fingerprint)
      const drives = engine.run.checkHistory.filter((h) => h.result !== 'not-run')
      t.eq('two drives: the approved revision\'s, then the reconciled revision\'s after the return', [drives.length, started(events).length, drives.at(-1)?.step > back?.number], [2, 2, true])
      t.ok('the second confirmation names the fresh drive', confirms.at(-1)?.includes(drives.at(-1).dir))
      t.eq('closure reads it and the run delivers', [engine.run.closure?.conditions?.checksSatisfied, engine.run.status], [true, 'completed'], engine.run.blockedReason)
      await releaseWorkspace(engine)
    }

    t.section('recovery (10:48Z): a quarantine and restore in a round another seat rejected still leaves the round unapproved')
    {
      const dir = await temp('devpanel-mt-recover-')
      const participants = { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } }
      let tampered = false
      const { engine, log } = await scenario({ target: await tier(dir), participants, tokens: ['A', 'B'],
        audit: async ({ role, round, engine }) => {
          if (round !== 0) return null
          if (role === 'auditor-1') return reject(role, round)
          if (tampered) return null
          tampered = true
          // A reviewer that edits the candidate: the run is quarantined.
          await fs.writeFile(path.join(engine.run.workspace.path, '@c/a/x.mjs'), 'tampered\n')
          return null
        } })
      t.eq('quarantined by the reviewer\'s edit', `${engine.run.integrity?.status} ${engine.run.blockedReason}`, 'quarantined recovery-required')
      await fs.writeFile(path.join(engine.run.workspace.path, '@c/a/x.mjs'), 'A\n')
      const state = await captureIntegrity(engine.run.workspace, { clock: engine.clock })
      await engine.resolveIntegrity({ disposition: 'restored', expectedStateHash: state.hash, actor: 'operator', reason: 'restored the candidate' })
      await engine.drive()
      t.eq('the blocker kept round 0 from approval: the author got round 1', log.filter((l) => l.stepId === 'implement').map((l) => l.round), [0, 1], `${engine.run.status} ${engine.run.blockedReason} ${engine.run.integrity?.status} ${JSON.stringify(engine.run.failure ?? null)} ${log.map((l) => `${l.stepId}:${l.round}`).join(',')}`)
      t.ok('round 0\'s revision was never approved', !engine.run.approvals.some((a) => a.revision === engine.run.revisions[0].fingerprint))
      t.eq('the run completes on the next revision', engine.run.status, 'completed', engine.run.blockedReason)
      await releaseWorkspace(engine)
    }

    t.section('no occupied reviewer: closure reads a failed drive exactly as under the default timing')
    {
      const outcome = []
      for (const timing of ['approved', null]) {
        const dir = await temp('devpanel-mt-empty-')
        await fs.writeFile(path.join(dir, 'fail-A'), '')
        const { engine } = await scenario({ target: await tier(dir, { timing }), participants: { 'auditor-1': null } })
        outcome.push([engine.run.status, engine.run.blockedReason, engine.run.closure?.conditions?.checksSatisfied, engine.run.checkHistory.map((h) => h.gating ?? h.result)])
        await releaseWorkspace(engine)
      }
      t.eq('the same block, the same failed drive', outcome[0], outcome[1])
      t.eq('which is closure blocked on the check', outcome[0].slice(2), [false, ['failed']])
    }

    t.section('AC3: the audit prompt\'s check block says the drive has not run on the reviewed revision, with awaitsCheck as the way to ask')
    {
      const approved = await scenario({ target: await tier(await temp('devpanel-mt-prompt-')) })
      const block = audits(approved.log)[0].prompt
      t.ok('the timing block is there, for the modules drive', /"timing":\s*"approved"/.test(block) && /"tier":\s*"modules"/.test(block) && block.includes('have not run on the revision you review'), block.slice(block.indexOf('have not run') - 600, block.indexOf('have not run') + 100))
      t.ok('awaitsCheck is the way to ask for the result', block.includes('`awaitsCheck: true`'))
      t.ok('a rejected revision is not driven, so no last-round promise is made', block.includes('never on a revision the round rejected') && !block.includes('they run with no re-review'))
      const every = await scenario({ target: await tier(await temp('devpanel-mt-prompt-'), { timing: null }) })
      t.ok('the default timing has no such block', !audits(every.log)[0].prompt.includes('have not run on the revision you review') && !/"timing":\s*"approved"/.test(audits(every.log)[0].prompt))
      await releaseWorkspace(approved.engine)
      await releaseWorkspace(every.engine)

      // A same-round re-review follows the revision's own drive: the block says it has run, never that it has not.
      const rechecked = await scenario({ target: await tier(await temp('devpanel-mt-prompt-')), audit: ({ role, round, recheck }) => recheck ? null : awaiting(role, round) })
      const [first, again] = audits(rechecked.log)
      t.eq('the first audit had no drive, its re-review one', [first.recheck, first.drives, again?.recheck, again?.drives], [false, 0, true, 1])
      t.ok('the first audit is told the drive has not run', first.prompt.includes('have not run on the revision you review') && !first.prompt.includes('have run on the revision you review'))
      t.ok('the re-review is told it has run, with its result, and nothing says otherwise', again.prompt.includes('have run on the revision you review') && !again.prompt.includes('have not run on the revision you review') && /"result":\s*"passed"/.test(again.prompt), again.prompt.slice(again.prompt.indexOf('modules drive:') - 200, again.prompt.indexOf('modules drive:') + 400))
      await releaseWorkspace(rechecked.engine)
    }

    t.section('AC2: the run\'s own stage instance — not created for a rejected revision; the first drive creates it, a later one loads and restarts')
    {
      const dir = await temp('devpanel-mt-instance-')
      const log = path.join(dir, 'log')
      const say = (word) => `echo ${word} {{instanceName}} >> '${log}'`
      await fs.writeFile(path.join(dir, 'fail-once-B'), '')
      const target = await tier(dir, { modules: {
        lint: { id: 'lint', run: `${dir}/ok {{instance}} {{files}}` }, load: { id: 'load', run: say('load') }, restart: { id: 'restart', run: say('restart') }, ready: { id: 'ready', run: say('ready') },
        test: { id: 'module-selftest', run: `${dir}/judge {{instance}} {{filter}}` },
        instance: { root: path.join(dir, 'instances'), create: { run: `${say('create')} && mkdir -p {{instance}}` }, start: { run: say('start') }, destroy: { run: `${say('destroy')} && rm -rf {{instance}}` } }
      } })
      const { engine } = await scenario({ target, tokens: ['A', 'B', 'C'], audit: ({ role, round }) => round === 0 ? reject(role, round) : null })
      // What the supervisor does at every run end (supervisor.mjs): the instance goes, and its slot on the host.
      await destroyRunInstances(engine.runId, { reason: 'run-completed' })
      await releaseWorkspace(engine)
      const words = (await fs.readFile(log, 'utf8')).split(NL).filter(Boolean)
      t.eq('nothing for A; B\'s drive creates and starts it, C\'s loads and restarts it; destroyed at the run\'s end', words.map((w) => w.split(' ')[0]), ['create', 'start', 'ready', 'load', 'restart', 'ready', 'destroy'])
      t.ok('always the run\'s own instance', words.every((w) => w.endsWith(instanceName(engine.runId))))
      t.eq('and its slot on the host is free again', holdsInstance(instanceName(engine.runId)), false)
      t.eq('B, then C, driven', await driven(dir), ['B', 'C'])
    }

    t.section('AC2: the affected-module set and viaHooks subscribers reach the approved revision\'s drive')
    {
      const dir = await temp('devpanel-mt-hooks-')
      const reader = path.join(dir, 'read-hooks')
      await fs.writeFile(reader, `#!/bin/sh\nsig=$(tr -d '\\n' < @c/a/hook.sig)\nparams=$(tr -d '\\n' < @c/s/hooks/h.params)\nprintf '{"declarations":[{"module":"@c/a","hook":"h","signature":"%s"}],"subscribers":[{"module":"@c/s","hook":"h","parameters":"%s"}]}' "$sig" "$params"\n`, { mode: 0o755 })
      const { engine, events } = await scenario({
        target: await tier(dir), sizing: { affectedModules: ['@c/listed'] },
        setup: async (f) => {
          await fs.mkdir(path.join(f.projectPath, '@c/a'), { recursive: true })
          await fs.mkdir(path.join(f.projectPath, '@c/s/hooks'), { recursive: true })
          await fs.writeFile(path.join(f.projectPath, '@c/a/hook.sig'), '(a)\n')
          await fs.writeFile(path.join(f.projectPath, '@c/s/hooks/h.params'), '(a)\n')
          await sh('git', ['-C', f.projectPath, 'add', '-A'])
          await sh('git', ['-C', f.projectPath, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'modules'])
        },
        author: async (round, ws) => { await fs.writeFile(path.join(ws, '@c/a/hook.sig'), `(a, b) round ${round}\n`) },
        beforeDrive: (engine, f) => {
          engine.run.modulePool = { id: 'pool-' + engine.runId, framework: null, members: [{ project: P, path: f.projectPath, collections: ['@*'] }], frameworkCollections: ['@*'], hookReader: { run: reader }, owners: {}, targets: {} }
          engine.run.moduleLocks = { pool: engine.run.modulePool.id, project: P, issueId: f.issue.id, held: [], waiting: null }
          engine.moduleLockPollMs = 50
        }
      })
      const rev = engine.run.revisions[0]
      t.eq('the revision\'s affected set: the triage list ∪ its paths ∪ the hook\'s subscribers', [rev.affectedModules?.modules, rev.affectedModules?.viaHooks?.map((v) => v.module)], [['@c/a', '@c/listed'], ['@c/s']])
      const check = engine.run.checkResults.at(-1)
      t.eq('the drive after approval tests each of them', check?.modules?.tests?.map((x) => x.module).filter(Boolean), ['@c/a', '@c/listed', '@c/s'])
      t.eq('once, on the approved revision', [started(events).length, engine.run.status], [1, 'completed'], engine.run.blockedReason)
      await releaseWorkspace(engine)
    }

    t.section('AC2: a failed lint, load, restart or ready is retried on the same revision')
    {
      const dir = await temp('devpanel-mt-retry-')
      const target = await tier(dir, { retryFailed: null, modules: { ready: { id: 'ready', run: `if [ -f '${dir}/ready' ]; then exit 0; fi; touch '${dir}/ready'; exit 1` } } })
      const { engine, events } = await scenario({ target })
      t.eq('ready failed once, and the same revision was driven again', [events.filter((e) => e.type === 'checks-retry').length, engine.run.checkHistory.map((h) => [h.result, h.runs.length])], [1, [['passed', 2]]])
      t.eq('the run completes on its one revision', [engine.run.status, engine.run.revisions.length], ['completed', 1], engine.run.blockedReason)
      await releaseWorkspace(engine)
    }

    t.section('AC2: dependency sync — a revision that changes a manifest gets its install on the approved drive, reverted as it ends')
    {
      const dir = await temp('devpanel-mt-sync-')
      const log = path.join(dir, 'log')
      const say = (word) => `echo ${word} {{instanceName}} >> '${log}'`
      const target = await tier(dir, { modules: {
        lint: { id: 'lint', run: `${dir}/ok {{instance}} {{files}}` }, load: { id: 'load', run: say('load') }, restart: { id: 'restart', run: say('restart') }, ready: { id: 'ready', run: say('ready') },
        test: { id: 'module-selftest', run: `${dir}/judge {{instance}} {{filter}}` },
        instance: { root: path.join(dir, 'instances'),
          create: { run: `${say('create')}; if [ ! -f '${dir}/synced' ]; then exit 3; fi; mkdir -p {{instance}}`, unavailableExitCodes: [3], unavailableReason: 'the candidate\'s dependency manifests differ from the stage\'s' },
          start: { run: say('start') }, destroy: { run: `${say('destroy')} && rm -rf {{instance}}` },
          syncDependencies: { run: `${say('sync')}; printf '%s\\n' {{changed}} > '${dir}/changed'; touch '${dir}/synced'`, revert: { run: `echo revert {{instanceName}} >> '${log}'; rm -f '${dir}/synced'` } } }
      } })
      const { engine } = await scenario({ target, tokens: ['A', 'B'], audit: ({ role, round }) => round === 0 ? reject(role, round) : null,
        author: async (round, ws) => {
          await fs.mkdir(path.join(ws, '@c/a'), { recursive: true })
          await fs.writeFile(path.join(ws, '@c/a/x.mjs'), round === 0 ? 'A\n' : 'B\n')
          await fs.writeFile(path.join(ws, '@c/a/package.json'), `{"dependencies":{"is-number":"7.0.${round}"}}\n`)
        } })
      t.eq('nothing synced for the rejected revision; the approved one: create refused, sync, create, drive, destroy, revert', (await fs.readFile(log, 'utf8')).split(NL).filter(Boolean).map((l) => l.split(' ')[0]), ['create', 'sync', 'create', 'start', 'ready', 'destroy', 'revert'])
      t.eq('the sync is on the run and settled', engine.run.dependencySyncs?.map((d) => [d.outcome, d.settled?.passed]), [['synced', true]])
      t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
      await destroyRunInstances(engine.runId, { reason: 'run-completed' })
      await releaseWorkspace(engine)
    }

    t.section('AC2: the unstable-selftest rules do not reach a modules drive under either timing: no history line, no recheckDrive')
    {
      for (const timing of ['approved', null]) {
        const dir = await temp('devpanel-mt-unstable-')
        await fs.writeFile(path.join(dir, 'fail-once-A'), '')
        const { engine, f } = await scenario({ target: await tier(dir, { timing, retryFailed: 1 }), tokens: ['A'] })
        const history = await fs.readdir(path.join(path.dirname(f.issuePath), '.selftest-history')).catch(() => [])
        t.eq(`${timing ?? 'every-revision'}: no selftest history, no unstable re-review`, [history.length, engine.run.steps.filter((s) => s.recheckDrive).length], [0, 0])
        await releaseWorkspace(engine)
      }
    }

    t.section('AC2 and AC5: testedNothing — a drive that held no test command never closes the run, even with a readable empty report')
    {
      const empty = { id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[]}\'', report: 'selftest' }
      const outcome = {}
      for (const timing of ['approved', null]) {
        const dir = await temp('devpanel-mt-nothing-')
        const { engine } = await scenario({ target: await tier(dir, { timing, modules: { finallyCommands: [empty] } }), tokens: [null] })
        const check = engine.run.checkResults.at(-1)
        outcome[timing ?? 'default'] = { blocked: engine.run.blockedReason, testedNothing: Boolean(check?.modules?.reportUnreadable?.some((u) => u.testedNothing)) }
        await releaseWorkspace(engine)
      }
      t.eq('approved: the drive tested nothing and the run does not close on it', [outcome.approved.testedNothing, outcome.approved.blocked], [true, 'checks-inconclusive'])
      t.eq('the default timing reads that report as before', outcome.default.testedNothing, false)
    }

    t.section('AC2: module locks are taken with each revision before its review, driven or not')
    {
      const dir = await temp('devpanel-mt-locks-')
      const held = []
      const { engine, events } = await scenario({ target: await tier(dir), tokens: ['A', 'B'],
        author: async (round, ws) => {
          await fs.mkdir(path.join(ws, round === 0 ? '@c/a' : '@c/b'), { recursive: true })
          await fs.writeFile(path.join(ws, '@c/a/x.mjs'), 'A\n').catch(() => {})
          if (round === 1) await fs.writeFile(path.join(ws, '@c/b/y.mjs'), 'B\n')
        },
        audit: ({ role, round, engine }) => { held.push([round, [...engine.run.moduleLocks.held.map((h) => h.module ?? h)].sort()]); return round === 0 ? reject(role, round) : null },
        beforeDrive: (engine, f) => {
          engine.run.modulePool = { id: 'pool-' + engine.runId, framework: null, members: [{ project: P, path: f.projectPath, collections: ['@*'] }], frameworkCollections: ['@*'], owners: {}, targets: {} }
          engine.run.moduleLocks = { pool: engine.run.modulePool.id, project: P, issueId: f.issue.id, held: [], waiting: null }
          engine.moduleLockPollMs = 50
        } })
      const [a, b] = engine.run.revisions
      t.eq('each revision took its modules before its audit; the rejected one was never driven', [held, started(events).map((e) => e.revision === b.fingerprint)], [[[0, ['@c/a']], [1, ['@c/a', '@c/b']]], [true]])
      t.eq('a lock event per revision', events.filter((e) => e.type === 'module-locks-taken').map((e) => e.revision), [a.fingerprint, b.fingerprint])
      await releaseWorkspace(engine)
    }

    t.section('AC6: preview, the supervisor\'s preview and readiness say which timing the modules tier has')
    {
      const f = await engineFixture({ playbook: 'implementation' })
      await writeProject(f, INFRA(DECLARED({ timing: 'approved' })))
      const shown = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, project: { id: P } })
      t.eq('preview JSON', [shown.ok, shown.modulesTiming], [true, 'approved'], JSON.stringify(shown.errors))
      t.eq('the supervisor\'s preview', summarisePreview(shown).modulesTiming, 'approved')
      await writeProject(f, INFRA(DECLARED()))
      t.eq('neither key set: every-revision', (await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, project: { id: P } })).modulesTiming, 'every-revision')
      const g = await engineFixture({ playbook: 'implementation' })
      t.eq('no modules tier: none', (await previewRun({ playbookId: 'implementation', configRoot: g.configRoot, project: { id: P } })).modulesTiming, null)
      const resolve = async () => ({ ok: true, resolved: { configHash: 'h', workspace: {}, completion: { delivery: { action: 'worktree-diff' } }, checks: { target: { tier: 'modules', timing: 'approved', modules: {} } } } })
      const ready = await launchReadiness({ project: 'p', projectPath: f.projectPath, playbook: 'implementation', resolve, inspectLaunch: async () => ({}), inspect: async () => null })
      t.eq('readiness, under the configuration', ready.configuration?.modulesTiming, 'approved')
      const dialog = await fs.readFile(path.join(CONFIG_ROOT, 'gui/src/components/StartRunDialog.vue'), 'utf8')
      t.ok('the start dialog shows it from the preview', dialog.includes('previewData.modulesTiming'))
      const cli = await fs.readFile(path.join(CONFIG_ROOT, 'gui/server/runtime/preview-cli.mjs'), 'utf8')
      t.ok('the preview CLI prints it', cli.includes('p.modulesTiming'))
    }

    t.section('AC6, AC7: config:check reports the timing and resolves the catalogue with an approved project; a refused shape fails it')
    {
      const run = (args, env) => sh(process.execPath, [path.join(CONFIG_ROOT, 'gui/server/config/check.mjs'), ...args], { env: { ...process.env, ...env } }).then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code, out: `${e.stdout}${e.stderr}` }))
      const f = await engineFixture({ playbook: 'implementation' })
      await writeProject(f, INFRA(DECLARED({ timing: 'approved' })))
      const all = await run(['--project', P], { DEVPANEL_CONFIG_ROOT: f.configRoot })
      t.eq('every playbook resolves with the approved project', all.code, 0, all.out)
      t.ok('and each coding playbook says its modules timing', all.out.split(NL).filter((l) => l.includes('timing=approved')).length >= 4, all.out)
      await fs.rm(path.join(f.configRoot, `projects/${P}.yaml`))
      await fs.writeFile(path.join(f.configRoot, 'playbooks/pingpong.yaml'), pingpongPlaybook('approved'))
      const refused = await run(['pingpong'], { DEVPANEL_CONFIG_ROOT: f.configRoot })
      t.ok('a refused shape exits 1, naming the rule', refused.code === 1 && refused.out.includes('(R1)'), refused.out)
    }
  } finally {
    await cleanupFixtures()
    for (const d of temps) await fs.rm(d, { recursive: true, force: true })
  }
}
