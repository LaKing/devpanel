import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startRun, resumeRun, worktreeDiffDelivery, releaseOwnership } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { conflictRegions } from '../server/runtime/delivery-return.mjs'
import { undeliveredApproval } from '../server/runtime/carry-forward.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { runMetrics } from '../server/runtime/run-metrics.mjs'
import { engineFixture, scriptFor, simulateProcessDeath, cleanupFixtures } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
export const name = 'delivery return — an approved patch that conflicts with the source goes back to the author on the current source, at most twice'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
const crash = () => { throw Object.assign(new Error('simulated process death'), { simulatedCrash: true }) }

const CANDIDATE = lines(10, { 5: 'line 5 by the candidate', 9: 'line 9 fixed' })
const SOURCE = lines(10, { 1: 'line 1 elsewhere', 5: 'line 5 by someone else' })
const RECONCILED = lines(10, { 1: 'line 1 elsewhere', 5: 'line 5 by both', 9: 'line 9 fixed' })
const NO_MARKERS = '      - id: no-markers\n        run: "! grep -q \'<<<<<<<\' server.mjs"\n'

/*
 * The source has server.mjs (ten lines). In its first round the author changes
 * lines 5 and 9; meanwhile the live checkout changes lines 1 and 5 and gains
 * other.txt, so delivery conflicts on line 5. `author(round, file, engine)`
 * answers the later rounds; `beforeDelivery(n)` runs in each confirmation turn,
 * after the reviews and before delivery. `policy`: what the host's reconcile
 * policy reads as (null: no host, as in an engine nothing supervises).
 */
async function scenario ({ author = null, beforeDelivery = null, policy = {}, playbook = 'implementation', first = { worktree: { 'server.mjs': CANDIDATE }, source: { 'server.mjs': SOURCE, 'other.txt': 'landed meanwhile\n' } }, hooks = null } = {}) {
  let engine = null
  let confirms = 0
  const prompts = []
  const base = scriptFor()
  const script = async (turn) => {
    const { stepId, round, prompt } = turn
    prompts.push({ stepId, round, attempt: turn.attempt, prompt })
    const ws = engine.run.workspace.path
    if (stepId === 'implement' || stepId === 'execute') {
      if (round === 0) {
        for (const [file, text] of Object.entries(first.worktree)) await fs.writeFile(path.join(ws, file), text)
        for (const [file, text] of Object.entries(first.source)) await fs.writeFile(path.join(f.projectPath, file), text)
      } else await author?.(round, path.join(ws, 'server.mjs'), engine)
      if (stepId === 'execute') return fence({ summary: `round ${round}`, completed: true, basedOnRevision: revision(prompt) })
      return fence({ summary: `Implemented round ${round}`, basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') {
      await beforeDelivery?.(++confirms, f)
      return fence({ revision: revision(prompt), satisfied: true, criteria: [{ id: 'AC1', met: true, evidence: 'audit and diff' }] })
    }
    return base(turn)
  }
  const f = await engineFixture({ playbook, delivery: 'apply-to-source', script })
  await fs.writeFile(path.join(f.projectPath, 'server.mjs'), lines(10))
  await fs.writeFile(path.join(f.projectPath, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
  await git(f.projectPath, 'add', '-A')
  await git(f.projectPath, 'commit', '-qm', 'source')
  await fs.appendFile(path.join(f.configRoot, `playbooks/${playbook}.yaml`), `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: 0\n    commands:\n${NO_MARKERS}`)
  const options = { base: 'working-tree', ...(playbook === 'implementation' ? { participants: { 'auditor-1': { model: 'opus-5' } } } : {}) }
  const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider: worktreeDiffDelivery, expectConfigHash: resolved.resolved.configHash, runOptions: options })
  if (policy !== null) engine.reconcilePolicy = () => policy
  Object.assign(engine.hooks, hooks ?? {})
  let died = null
  await engine.drive().catch((error) => { if (!error.simulatedCrash) throw error; died = error })
  const reopen = async () => {
    await simulateProcessDeath(f.issuePath)
    engine = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: worktreeDiffDelivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
    engine.reconcilePolicy = () => policy
    return engine
  }
  return { f, engine, prompts, died, reopen }
}

const resolve = (text = RECONCILED) => async (round, file) => { await fs.writeFile(file, text) }
const source = (f, file = 'server.mjs') => fs.readFile(path.join(f.projectPath, file), 'utf8')
const rounds = (prompts, stepId) => prompts.filter((p) => p.stepId === stepId && p.attempt === 1).map((p) => p.round)
const done = async (engine) => releaseOwnership(engine, { reason: 'test' }).catch(() => {})

export default async function (t) {
  try {
    t.section('conflict regions are read off the markers')
    {
      const regions = conflictRegions('a\n<<<<<<< ours\nmine\n=======\ntheirs 1\ntheirs 2\n>>>>>>> theirs\nb\n')
      t.eq('one region, its marker lines and both sides', regions, [{ start: 2, end: 7, source: ['mine'], approved: ['theirs 1', 'theirs 2'] }])
    }

    t.section('1. conflict → return → reconciled revision → checked, reviewed, confirmed, delivered')
    {
      let seen = null
      const { f, engine, prompts } = await scenario({ author: async (round, file) => { seen = await fs.readFile(file, 'utf8'); await fs.writeFile(file, RECONCILED) } })
      const run = engine.run
      t.eq('the run completes and delivers', `${run.status} ${run.outcome} ${Boolean(run.delivery?.completedAt)}`, 'completed resolved true', `${run.blockedReason} ${run.delivery?.error} ${JSON.stringify(run.closure?.deliveryNotReturned ?? run.closure?.conditions)}`)
      t.eq('the source holds the reconciliation', await source(f), RECONCILED)
      t.eq('and what landed there meanwhile', await source(f, 'other.txt'), 'landed meanwhile\n')
      const back = run.steps.find((s) => s.decision?.key === 'implement-review:return')
      t.eq('one decision step by the engine, automatic', [back?.role, back?.decision?.actor, back?.decision?.automatic, back?.decision?.deliveryReturn], ['operator', 'engine', true, 1])
      const entry = run.deliveryReturns?.[0]
      t.eq('the return is on the record with the conflict', [run.deliveryReturns?.length, entry?.step, entry?.conflicts.map((c) => [c.path, c.regions.length])], [1, back?.number, [['server.mjs', 1]]])
      t.ok('the author found the approved change on the current source, the conflict as markers', seen?.includes('line 1 elsewhere') && seen.includes('line 9 fixed') && seen.includes('<<<<<<<') && seen.includes('line 5 by someone else') && seen.includes('line 5 by the candidate'))
      t.eq('the author got exactly one more round', rounds(prompts, 'implement'), [0, 1])
      const implement1 = prompts.find((p) => p.stepId === 'implement' && p.round === 1)?.prompt ?? ''
      t.ok('its prompt quotes the path, the lines and both sides, and bounds the task', /server\.mjs lines \d+–\d+/.test(implement1) && implement1.includes('line 5 by someone else') && implement1.includes('line 5 by the candidate') && implement1.includes('change nothing else'))
      const audit1 = prompts.find((p) => p.stepId.startsWith('audit-implement') && p.round === 1)?.prompt ?? ''
      t.ok('the auditor is told it reviews a conflict reconciliation', audit1.includes('conflict reconciliation') && audit1.includes('no conflict marker remains'))
      t.ok('and gets the reconciliation alone as a diff', /What the author changed since the engine's merge[\s\S]*-<<<<<<< [\s\S]*\+line 5 by both/.test(audit1))
      t.ok('that diff does not repeat the approved change', !/What the author changed since the engine's merge[\s\S]*\+line 9 fixed/.test(audit1))
      const final = run.revisions.at(-1)
      t.ok('the reconciled revision is a new one over the moved base', final.fingerprint !== entry.from.revision && final.baseCommit === entry.sourceBase && run.workspace.baseCommit === entry.sourceBase && entry.sourceBase !== entry.from.baseCommit)
      t.ok('approved by a review recorded after the return, nothing carried', run.approvals.length > 0 && run.approvals.every((a) => a.revision === final.fingerprint && Number(a.step) > Number(back.number)), JSON.stringify(run.approvals))
      const check = run.checkResults.at(-1)
      t.eq('checked as its own revision', [check?.revision, check?.result], [final.fingerprint, 'passed'])
      t.eq('confirmed again; the first confirmation is superseded', [prompts.filter((p) => p.stepId === 'confirm').length, run.supersededSteps?.length], [2, 1])
      t.eq('delivered as that revision', run.delivery.revision, final.fingerprint)
      t.eq('integrity stayed clear across the engine\'s own writes', run.integrity?.status, 'clear')
      const worker = run.workspace.repository?.worker ?? null
      const heads = [(await exec('git', ['--git-dir', run.workspace.gitDir, 'rev-parse', 'HEAD'])).stdout.trim(), worker ? (await fs.readFile(path.join(worker, 'HEAD'), 'utf8')).trim() : entry.sourceBase]
      t.eq(`the worktree's HEAD names the moved base (engine directory${worker ? ' and the seat\'s' : ''})`, heads, [entry.sourceBase, entry.sourceBase])
      t.eq('metrics count the return', runMetrics(run).deliveryReturns, 1)
      await done(engine)
    }

    t.section('2. the bound: a third conflict blocks as before, saying why')
    {
      const { f, engine, prompts } = await scenario({ author: resolve(),
        beforeDelivery: async (n, fx) => { if (n > 1) await fs.writeFile(path.join(fx.projectPath, 'server.mjs'), lines(10, { 1: 'line 1 elsewhere', 5: `line 5 moved again ${n}` })) } })
      const run = engine.run
      t.eq('blocked at delivery', `${run.status} ${run.blockedReason}`, 'blocked source-delivery-blocked', run.delivery?.error)
      t.eq('after two returns', [run.deliveryReturns?.length, rounds(prompts, 'implement')], [2, [0, 1, 2]])
      t.eq('the reason is on the closure', run.closure?.deliveryNotReturned, 'bound-reached')
      t.ok('and in the explanation', JSON.stringify(explainRun(run)).includes('returns a delivery conflict at most twice'), JSON.stringify(explainRun(run)))
      t.eq('the source keeps the other change', await source(f), lines(10, { 1: 'line 1 elsewhere', 5: 'line 5 moved again 3' }))
      await done(engine)
    }

    t.section('3. a conflict the author cannot resolve blocks, with the reason')
    {
      const binary = { worktree: { 'blob.bin': Buffer.from([0, 9, 9, 9]) }, source: { 'blob.bin': Buffer.from([0, 7, 7, 7]) } }
      const { engine, prompts } = await scenario({ first: binary })
      const run = engine.run
      t.eq('blocked at delivery, no return', [`${run.status} ${run.blockedReason}`, run.deliveryReturns ?? null, rounds(prompts, 'implement')], ['blocked source-delivery-blocked', null, [0]])
      t.ok('the closure names the binary file', /blob\.bin is not a text conflict .*binary/.test(run.closure?.deliveryNotReturned ?? ''), run.closure?.deliveryNotReturned)
      t.ok('so does the explanation', JSON.stringify(explainRun(run)).includes('blob.bin is not a text conflict'))
      await done(engine)

      const bare = await scenario({ policy: null })
      t.eq('an engine that cannot read the reconcile policy blocks as before', [`${bare.engine.run.status} ${bare.engine.run.blockedReason}`, bare.engine.run.deliveryReturns ?? null], ['blocked source-delivery-blocked', null])
      t.ok('and says so', /reconcile policy could not be read/.test(bare.engine.run.closure?.deliveryNotReturned ?? ''))
      await done(bare.engine)

      const declared = await scenario({ policy: { 'server.mjs': 'append' } })
      t.eq('a conflict only on declared append paths is left to reconcile', [`${declared.engine.run.status} ${declared.engine.run.blockedReason}`, declared.engine.run.deliveryReturns ?? null, declared.engine.run.closure?.deliveryNotReturned ?? null, declared.engine.run.autoReconcile?.state], ['blocked source-delivery-blocked', null, null, 'pending'])
      await done(declared.engine)
    }

    t.section('4. a crash between the decision step and the author turn: replay gives the same round')
    {
      const s = await scenario({ author: resolve(), hooks: { beforeInvoke: (e) => { if (e.run.deliveryReturns?.length) { delete e.hooks.beforeInvoke; crash() } } } })
      t.ok('the process died after the return was recorded', s.died?.simulatedCrash === true && s.engine.run.deliveryReturns?.length === 1)
      const again = await s.reopen()
      t.eq('the reopened run reads the moved base and its baseline', [again.run.workspace.baseCommit, again.baseline.get('other.txt') != null], [again.run.deliveryReturns[0].sourceBase, true])
      await again.drive()
      t.eq('it completes and delivers', `${again.run.status} ${again.run.outcome}`, 'completed resolved', `${again.run.blockedReason} ${again.run.delivery?.error} ${again.run.failure?.message}`)
      t.eq('one return, one decision step, one more author round', [again.run.deliveryReturns.length, again.run.steps.filter((x) => x.decision?.deliveryReturn).length, rounds(s.prompts, 'implement')], [1, 1, [0, 1]])
      t.eq('the source holds the reconciliation', await source(s.f), RECONCILED)
      await done(again)
    }

    t.section('5. a crash while the worktree is being moved: the move is done again from what was kept')
    {
      const s = await scenario({ author: resolve(), hooks: { afterDeliveryRebase: (e) => { delete e.hooks.afterDeliveryRebase; crash() } } })
      t.eq('the process died inside the move, journaled', [s.died?.simulatedCrash, s.engine.run.pendingDeliveryReturn?.state, s.engine.run.deliveryReturns ?? null], [true, 'writing', null])
      t.eq('a new run would start from the approved patch', (await undeliveredApproval(s.f.issuePath, 'another-run'))?.revision ?? null, null, 'the run is still live')
      const again = await s.reopen()
      await again.drive()
      t.eq('it completes and delivers', `${again.run.status} ${again.run.outcome}`, 'completed resolved', `${again.run.blockedReason} ${again.run.pendingDeliveryReturn?.error} ${again.run.delivery?.error}`)
      t.eq('one return, marked resumed, no journal left', [again.run.deliveryReturns.length, again.run.deliveryReturns[0].resumed, again.run.pendingDeliveryReturn ?? null], [1, true, null])
      t.eq('the source holds the reconciliation', await source(s.f), RECONCILED)
      await done(again)
    }

    t.section('6. a single seat (Prompt): the conflict goes back to that seat')
    {
      const { f, engine, prompts } = await scenario({ playbook: 'prompt', author: resolve() })
      const run = engine.run
      t.eq('the run completes and delivers', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${run.delivery?.error} ${JSON.stringify(run.closure?.deliveryNotReturned ?? run.closure?.conditions)}`)
      t.eq('one return on the seat\'s own step', [run.deliveryReturns?.length, run.steps.find((x) => x.decision?.deliveryReturn)?.decision.key, rounds(prompts, 'execute')], [1, 'execute:return', [0, 1]])
      t.ok('its prompt quotes the conflict', (prompts.find((p) => p.stepId === 'execute' && p.round === 1)?.prompt ?? '').includes('line 5 by someone else'))
      t.eq('the source holds the reconciliation', await source(f), RECONCILED)
      await done(engine)
    }

    t.section('7. a return whose reconciliation is not approved: the next run starts from the approved patch')
    {
      const { f, engine } = await scenario({ author: async () => {} })
      const run = engine.run
      t.ok('the run ended without delivering', run.status !== 'completed' && run.deliveryReturns?.length === 1, `${run.status} ${run.blockedReason}`)
      const carried = await undeliveredApproval(f.issuePath, 'another-run')
      t.eq('the approved revision is what a next run carries', carried?.revision, run.deliveryReturns[0].from.revision)
      t.eq('the source was not written', await source(f), SOURCE)
      await done(engine)
    }
  } finally {
    await cleanupFixtures()
  }
}
