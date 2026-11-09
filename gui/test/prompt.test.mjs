import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { simulateProcessDeath } from './fakes/fixture.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'prompt — one seat, one model, every input, no coordination'

const NL = String.fromCharCode(10)
const start = (f, extra = {}) => startRun({ ...f, issue: { project: 'devpanel-project', id: f.issue.id }, deliveryProvider: f.delivery, ...extra })

export default async function (t) {
  try {
    t.section('1. the playbook resolves to a single occupied seat and previews without a coordinator')
    let f = await engineFixture({ playbook: 'prompt' })
    const r = await resolvePlaybook('prompt', { root: f.configRoot })
    t.ok('resolves', r.ok, JSON.stringify(r.errors))
    // The absence of a coordinator is the design, not an omission: the
    // company-wide invariant is that a coordinator seat is coordination-only,
    // never that every playbook has one. Stated here so a future reading of
    // coordination.test.mjs cannot mistake this shape for a gap.
    t.eq('one seat', Object.keys(r.resolved.participants), ['worker'])
    t.eq('and deliberately no coordinator to disable', r.resolved.participants.coordinator ?? null, null)
    t.ok('so nothing in it is coordination-only', Object.values(r.resolved.participants).every((p) => !p.coordinationOnly))
    t.eq('it writes code', r.resolved.participants.worker.writesCode, true)
    t.eq('the tactic is prompt', r.resolved.tactic, 'prompt')
    t.eq('one phase, one step', r.resolved.phases.map((p) => p.step?.id ?? p.loop?.steps.map((s) => s.id)), ['execute'])
    t.eq('closure asks what one seat can give, and the seat\'s own word', r.resolved.completion.requires, ['checksSatisfied', 'noOutstandingBlockingFindings', 'workerCompletion', 'deliveryCompleted'])
    t.eq('delivery is a patch', r.resolved.completion.delivery.action, 'worktree-diff')
    t.eq('review-only, with the justification on record', r.resolved.autoClose.minimumVerification, 'review-only')
    const preview = await previewRun({ playbookId: 'prompt', configRoot: f.configRoot, deliveryActions: ['worktree-diff'] })
    t.ok('previews', preview.ok, JSON.stringify(preview.errors))
    t.ok('in place is accepted too', (await resolvePlaybook('prompt', { root: f.configRoot, runOptions: { isolation: 'in-place' } })).ok)

    t.section('2. the worker gets the issue and every input file, does the work, and the run closes on delivery')
    const task = await f.stepStore.create({ name: 'task', text: 'Change the greeting in source.txt to "hello from the prompt playbook".' })
    const issueDirs = await fs.readdir(f.issuePath)
    const taskFolder = path.join(f.issuePath, issueDirs.find((d) => /^\d{3}-task$/.test(d)))
    await fs.writeFile(path.join(taskFolder, 'spec.txt'), 'Exact wording: hello from the prompt playbook' + NL)
    const prompts = []
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      prompts.push(args)
      if (args.meta.stepId === 'execute') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'hello from the prompt playbook' + NL)
      return original(args)
    }
    let engine = await start(f)
    await engine.drive()
    t.eq('completed', engine.run.status, 'completed')
    t.eq('resolved', engine.run.outcome, 'resolved')
    t.eq('exactly one agent turn', prompts.map((p) => `${p.meta.role}/${p.meta.stepId}`), ['worker/execute'])
    t.eq('one recorded step', engine.run.steps.filter((s) => s.role !== 'operator').length, 1)
    const prompt = prompts[0].prompt
    t.ok('the tactic is named', /Tactic: prompt/.test(prompt))
    t.ok('the issue text is in the prompt as a captured-input excerpt', /"excerpts"/.test(prompt) && /hello from the prompt playbook/.test(prompt))
    t.ok('and the attachment excerpt too', /Exact wording/.test(prompt))
    t.ok('the window manifest is named, so every attached file is reachable', /window\.json/.test(prompt))
    t.ok('the seat writes code', prompts[0].tooling?.writesCode === true)
    const manifest = JSON.parse(await fs.readFile(engine.run.currentWindow.manifest, 'utf8'))
    const inputFiles = (manifest.inputs ?? []).map((i) => path.basename(i.file))
    t.ok('the note and the attachment were captured as inputs', inputFiles.includes('spec.txt') && inputFiles.some((n) => /^note\./.test(n)), inputFiles.join(','))
    t.eq('the candidate is fingerprinted', engine.run.revisions.length, 1)
    t.eq('and delivered as a patch', engine.run.delivery.action, 'worktree-diff')
    t.ok('with delivery completed', Boolean(engine.run.delivery.completedAt))
    t.ok('the required closure conditions hold', ['checksSatisfied', 'noOutstandingBlockingFindings', 'workerCompletion', 'deliveryCompleted'].every((c) => engine.run.closure.conditions[c] === true), JSON.stringify(engine.run.closure.conditions))
    t.eq('the seat\'s completion is on the closure record', engine.run.closure.workerCompleted, true)
    t.ok('and a confirmation nobody could give was not required', engine.run.closure.conditions.coordinatorConfirmation === false && engine.run.status === 'completed')
    t.eq('review-only, no independent audit', `${engine.run.closure.verificationLevel}/${engine.run.closure.independentAudit}`, 'review-only/false')
    t.eq('only a fresh start is offered afterwards', supportedActions(engine.run), ['start-new'])
    void task
    await releaseWorkspace(engine)

    t.section('3. a worker that cannot produce the contract is repaired once, then the run blocks rather than pretends')
    f = await engineFixture({ playbook: 'prompt' })
    const orig = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'execute') {
        await fs.writeFile(path.join(args.cwd, 'source.txt'), 'changed anyway' + NL)
        return { ...(await orig(args)), response: 'I did things but forgot the contract.' }
      }
      return orig(args)
    }
    engine = await start(f)
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('by protocol repair', engine.run.blockedReason, 'protocol-repair-exhausted')
    t.eq('after one repair', engine.run.steps.filter((s) => s.stepId === 'execute').length, 2)
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)

    t.section('4. a seat that says the task is not done blocks the run; nothing is delivered or resolved')
    f = await engineFixture({ playbook: 'prompt' })
    const base = f.fake.invoke
    f.fake.invoke = async (args) => {
      const turn = await base(args)
      if (args.meta.stepId !== 'execute') return turn
      return { ...turn, response: `Stopped.${NL}\`\`\`json${NL}${JSON.stringify({ summary: 'The task is not completed: the operator must provide the missing requirements.', completed: false, blockers: [{ description: 'the note names a file that does not exist', needs: 'missing-information' }], basedOnRevision: null })}${NL}\`\`\`` }
    }
    engine = await start(f)
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('as incomplete', engine.run.blockedReason, 'task-incomplete')
    t.eq('unresolved', engine.run.outcome, 'unresolved')
    t.eq('the blocker is on the closure record', engine.run.closure.blockers?.map((b) => b.needs), ['missing-information'])
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    t.eq('the empty patch was never even written', engine.run.delivery, null)
    await releaseWorkspace(engine)

    t.section('5. completed: false without blockers is a contract violation, repaired once')
    f = await engineFixture({ playbook: 'prompt' })
    const plain = f.fake.invoke
    f.fake.invoke = async (args) => {
      const turn = await plain(args)
      if (args.meta.stepId !== 'execute' || args.meta.attempt > 1) return turn
      return { ...turn, response: `\`\`\`json${NL}${JSON.stringify({ summary: 'gave up', completed: false, basedOnRevision: null })}${NL}\`\`\`` }
    }
    engine = await start(f)
    await engine.drive()
    const attempts = engine.run.steps.filter((s) => s.stepId === 'execute')
    t.eq('two attempts', attempts.length, 2)
    t.eq('the first answer was a contract violation', engine.outputs[attempts[0].number]?.classification, 'contract-violation')
    t.ok('for the missing blockers', /blockers/.test(engine.outputs[attempts[0].number]?.error ?? ''), engine.outputs[attempts[0].number]?.error)
    t.eq('the repaired answer completed the run', engine.run.status, 'completed')
    await releaseWorkspace(engine)

    t.section('6. a failed check blocks closure even though nobody reviews the work')
    f = await engineFixture({ playbook: 'prompt' })
    engine = await start(f)
    engine.maybeRunChecks = async function () {
      const revision = this.run.revisions.at(-1)?.fingerprint
      if (revision && !this.run.checkResults.some((c) => c.revision === revision)) this.run.checkResults.push({ revision, result: 'failed', requirement: 'optional', at: this.clock.iso() })
    }
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('because the check failed', engine.run.closure?.conditions?.checksSatisfied, false)
    t.eq('with the generic reason', engine.run.blockedReason, 'closure-conditions-unmet')
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)

    t.section('7. the seat\'s completion describes the revision its turn produced, not whatever the worktree holds later')
    const unverifiable = { calls: [], async deliver (args) { unverifiable.calls.push(args); await fs.writeFile(path.join(args.runDir, 'artifacts', 'delivered.patch'), 'x'); return { artifactRef: 'artifacts/delivered.patch', bytes: 1, reconstruction: { verified: false, fingerprint: 'sha256:0', expected: args.revision, detail: 'simulated' } } } }
    const resume = (g, runId) => resumeRun({ issuePath: g.issuePath, runId, harnesses: g.harnesses, stepStore: g.stepStore, clock: g.clock, configRoot: g.configRoot, projectPath: g.projectPath, deliveryProvider: g.delivery })
    for (const moved of [false, true]) {
      const g = await engineFixture({ playbook: 'prompt' })
      const ok = g.fake.invoke
      g.fake.invoke = async (args) => { if (args.meta.stepId === 'execute') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'done' + NL); return ok(args) }
      const run = await start(g, { deliveryProvider: unverifiable })
      await run.drive()
      t.eq(`${moved}: blocked at delivery first`, run.run.blockedReason, 'delivery-unverifiable')
      if (moved) await fs.writeFile(path.join(run.run.workspace.path, 'source.txt'), 'changed after the seat reported' + NL)
      await simulateProcessDeath(g.issuePath)
      const again = await resume(g, run.runId)
      await again.finalize()
      if (moved) {
        t.eq('a moved candidate is not what the seat completed', again.run.blockedReason, 'candidate-changed-since-approval')
        t.eq('the completion no longer holds', again.run.closure.conditions.workerCompletion, false)
        t.eq('drift recorded', again.run.closure.drifted, true)
        t.eq('nothing delivered', g.delivery.calls.length, 0)
      } else {
        t.eq('an unchanged candidate finalizes', again.run.status, 'completed')
        t.eq('on the seat\'s completion', again.run.closure.conditions.workerCompletion, true)
      }
      await releaseWorkspace(again)
    }

    // 8–11: the engine's own return of a single seat's work (engine.workerReturn). A local check stands in for the modules tier.
    const answer = (o) => `\`\`\`json${NL}${JSON.stringify(o)}${NL}\`\`\``
    const revisionIn = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
    // Passes on the base, so a failure is the candidate's own and nothing inherits it.
    const GUARD = 'echo "source.txt must not say broken"; ! grep -q broken source.txt'
    const checked = async (run, seat) => {
      const g = await engineFixture({ playbook: 'prompt' })
      await fs.appendFile(path.join(g.configRoot, 'playbooks/prompt.yaml'), `${NL}checks: ${JSON.stringify({ requirement: 'optional', target: { kind: 'local', retryFailed: 0, commands: [{ id: 'unit', run }] } })}${NL}`)
      const turns = []
      const scripted = g.fake.invoke
      g.fake.invoke = async (args) => {
        turns.push(args.prompt)
        const out = await seat({ n: turns.length, cwd: args.cwd, prompt: args.prompt })
        return { ...await scripted(args), response: answer({ summary: 'did it', basedOnRevision: revisionIn(args.prompt), ...out }) }
      }
      const run_ = await start(g)
      await run_.drive()
      return { g, engine: run_, turns }
    }

    t.section('8. a failed check returns to the seat once with the failure quoted; the fixed candidate is checked and delivered')
    {
      const { g, engine: e, turns } = await checked(GUARD, async ({ n, cwd }) => {
        await fs.writeFile(path.join(cwd, 'source.txt'), (n === 1 ? 'broken' : 'mended') + NL)
        return { completed: true }
      })
      t.eq('completed', e.run.status, 'completed', `${e.run.blockedReason} ${JSON.stringify(e.run.closure)}`)
      t.eq('two seat turns, the second in round 1', e.run.steps.filter((s) => s.stepId === 'execute').map((s) => s.round), [0, 1])
      t.eq('one engine decision between them', e.run.steps.filter((s) => s.decision).map((s) => [s.decision.key, s.decision.actor, s.decision.automatic]), [['execute:return', 'engine', true]])
      t.eq('recorded on the run', e.run.workerReturns.map((r) => r.reasons), [['check-failed']])
      t.ok('the second turn is told which command failed, its output and where the logs are', /Command unit \(exit 1\)/.test(turns[1]) && /must not say broken/.test(turns[1]) && /checks\/001/.test(turns[1]), turns[1].slice(-1500))
      t.eq('the second revision passed its own check', [e.run.checkHistory.map((h) => h.result), e.run.closure.conditions.checksSatisfied], [['failed', 'passed'], true])
      t.eq('delivered once', g.delivery.calls.length, 1)
      await releaseWorkspace(e)
    }

    t.section('9. unfinished only for want of the engine\'s check, and the check passed: one more turn, then closed')
    {
      const { g, engine: e, turns } = await checked('true', async ({ n, cwd }) => {
        if (n === 1) await fs.writeFile(path.join(cwd, 'source.txt'), 'work' + NL)
        return n === 1 ? { completed: false, blockers: [{ description: 'the browser scenario has not run; this seat cannot start the drive', needs: 'environment' }] } : { completed: true }
      })
      t.eq('completed', e.run.status, 'completed', `${e.run.blockedReason} ${JSON.stringify(e.run.closure)}`)
      t.eq('two turns on one revision', [turns.length, e.run.revisions.every((r) => r.fingerprint === e.run.revisions[0].fingerprint)], [2, true])
      t.eq('returned as task-incomplete', e.run.workerReturns.map((r) => r.reasons), [['task-incomplete']])
      t.ok('the seat is told the check has run and passed', /it passed/.test(turns[1]) && /no longer a blocker/.test(turns[1]), turns[1].slice(-1200))
      t.eq('one check drive, not two', e.run.checkHistory.length, 1)
      t.eq('delivered', g.delivery.calls.length, 1)
      await releaseWorkspace(e)
    }

    t.section('10. a blocker that needs a person is not returned, whatever the check says')
    {
      const { g, engine: e, turns } = await checked('true', async ({ cwd }) => {
        await fs.writeFile(path.join(cwd, 'source.txt'), 'work' + NL)
        return { completed: false, blockers: [{ description: 'which of two wordings is wanted', needs: 'operator-decision' }] }
      })
      t.eq('blocked as unfinished after one turn', [e.run.blockedReason, turns.length], ['task-incomplete', 1])
      t.eq('the closure says why it was not returned', e.run.closure.workerNotReturned, 'a blocker needs a person (operator-decision)')
      t.ok('and so does the explanation', /not returned to the agent: a blocker needs a person/.test(explainRun(e.run).detail ?? ''), explainRun(e.run).detail)
      t.eq('nothing delivered', g.delivery.calls.length, 0)
      await releaseWorkspace(e)
    }

    t.section('11. bounded: two returns, then the run stops; an unchanged answer stops it at once')
    {
      const always = await checked(GUARD, async ({ n, cwd }) => { await fs.writeFile(path.join(cwd, 'source.txt'), `broken, attempt ${n}` + NL); return { completed: true } })
      t.eq('three turns, then blocked at closure', [always.turns.length, always.engine.run.status, always.engine.run.blockedReason], [3, 'blocked', 'closure-conditions-unmet'])
      t.eq('the bound is the reason', always.engine.run.closure.workerNotReturned, 'bound-reached')
      t.ok('the explanation names the failing command and the bound', /unit/.test(explainRun(always.engine.run).detail) && /at most twice/.test(explainRun(always.engine.run).detail), explainRun(always.engine.run).detail)
      t.eq('nothing delivered', always.g.delivery.calls.length, 0)
      await releaseWorkspace(always.engine)

      const same = await checked(GUARD, async ({ n, cwd }) => { if (n === 1) await fs.writeFile(path.join(cwd, 'source.txt'), 'broken once' + NL); return { completed: true } })
      t.eq('two turns only', [same.turns.length, same.engine.run.blockedReason], [2, 'closure-conditions-unmet'])
      t.ok('refused as unchanged', /^unchanged/.test(same.engine.run.closure.workerNotReturned ?? ''), same.engine.run.closure.workerNotReturned)
      await releaseWorkspace(same.engine)
    }

    t.section('12. the shipped playbook delivers to the project checkout')
    {
      const shipped = await fs.readFile(path.join(CONFIG_ROOT, 'playbooks/prompt.yaml'), 'utf8')
      t.ok('prompt.yaml chooses apply-to-source', /^delivery:\n  action: apply-to-source$/m.test(shipped))
      const g = await engineFixture({ playbook: 'prompt', delivery: 'apply-to-source' })
      const r2 = await resolvePlaybook('prompt', { root: g.configRoot })
      t.eq('and the loader accepts it for this tactic', [r2.ok, r2.resolved?.completion.delivery.action], [true, 'apply-to-source'], JSON.stringify(r2.errors))
    }
  } finally {
    await cleanupFixtures()
  }
}
