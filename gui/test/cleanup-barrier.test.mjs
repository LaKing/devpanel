import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseOwnership, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readBarrier } from '../server/runtime/cleanup-barrier.mjs'
import { alive } from '../server/runtime/process.mjs'
import { hostPlatform, platformFor, REAP_TAG } from '../server/runtime/platform.mjs'
import { createSupervisor, supportedActions } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

/*
 * The cleanup barrier on a shared in-place checkout (P3-3): an in-place run
 * whose cleanup was not proved bars every new or resumed in-place writer of the
 * project, from any issue, whatever becomes of the run; only a proof (here) or
 * an acknowledgement (cleanup-ack.test) lifts it. After an owner is lost, a tag
 * that scans clean on Linux bars nothing; a survivor bars, and is never killed.
 */
const P = 'devpanel-project'
const IN_PLACE = { isolation: 'in-place' }
const scan = (status) => ({ status, method: 'proc-environ', tag: crypto.randomUUID(), escaped: 0, reason: `${status} for the test` })
const proving = (answers = []) => ({ ...hostPlatform(), descendantScan: { proved: true }, taggedProcesses: async () => answers.shift() ?? { status: 'complete', method: 'test', pids: [] } })

export default async function (t) {
  const reaps = {}
  const script = (turn) => {
    const base = scriptFor()(turn)
    const reap = turn.stepId === 'implement' ? reaps.next : null
    return reap ? { text: base, diagnostics: { reap } } : base
  }
  const f = await engineFixture({ script })
  const projectDir = path.dirname(f.issuePath)
  const hash = async (runOptions) => (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions, projectId: P })).resolved.configHash
  const start = async (issue, runOptions = {}) => startRun({ ...f, issue: { ...issue, project: P }, issuePath: issue.path,
    stepStore: { create: (o) => f.issues.createStep(P, issue.id, o) }, deliveryProvider: f.delivery, runOptions,
    ...(Object.keys(runOptions).length ? { expectConfigHash: await hash(runOptions) } : {}) })
  /** An in-place run on `issue` that ends blocked with an unproved scan. */
  const unproved = async (issue) => {
    reaps.next = scan('unavailable')
    const engine = await start(issue, IN_PLACE)
    await engine.drive()
    reaps.next = null
    await releaseOwnership(engine)
    return engine
  }
  const refusal = (promise) => promise.then((engine) => { releaseWorkspace(engine).catch(() => {}); return null }, (e) => e)

  const a = { ...f.issue }
  const b = await f.issues.createIssue(P, { name: 'Second issue' })
  const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform: proving() })

  t.section('B1. an in-place start from another issue is refused while the barrier holds')
  const first = await unproved(a)
  {
    t.eq('the run blocked cleanup-unproved', `${first.run.status}/${first.run.blockedReason}`, 'blocked/cleanup-unproved')
    const barrier = await readBarrier(projectDir)
    t.eq('the barrier names the run and its tag', barrier.entries.map((e) => [e.runId, e.tag]), [[first.runId, first.run.cleanup.entries[0].tag]])
    const refused = await refusal(start(b, IN_PLACE))
    t.eq('another issue\'s in-place start is refused', [refused?.status, refused?.code], [409, 'CLEANUP_BARRIER'])
    t.ok('naming the run that holds it', refused?.message.includes(first.runId), refused?.message)
    const worktree = await start(b)
    t.ok('a worktree start on the project is admitted (the barrier bars in-place starts only)', Boolean(worktree.runId))
    await releaseWorkspace(worktree)
  }

  t.section('B2. abandoning the run does not lift the barrier')
  {
    await supervisor.abandon({ project: P, issueId: a.id, runId: first.runId })
    t.eq('the barrier is unchanged', (await readBarrier(projectDir)).entries.length, 1)
    for (const issue of [a, b]) {
      const refused = await refusal(start(issue, IN_PLACE))
      t.eq(`an in-place start on ${issue === a ? 'the same' : 'another'} issue is still refused`, refused?.code, 'CLEANUP_BARRIER')
    }
    const abandoned = JSON.parse(await fs.readFile(path.join(a.path, 'runs', first.runId, 'run.json'), 'utf8'))
    t.eq('the abandoned run offers the proof and the acknowledgement before start-new', supportedActions(abandoned), ['prove-cleanup', 'acknowledge-cleanup', 'start-new'])
  }

  t.section('B3. a successful proof lifts it, and the start is admitted')
  {
    const proved = await supervisor.proveCleanup({ project: P, issueId: a.id, runId: first.runId, actor: 'tester' })
    t.eq('proved', proved.proved, true)
    const barrier = await readBarrier(projectDir)
    t.eq('no entry is left', barrier.entries, [])
    t.eq('the lift is on record', [barrier.history.at(-1)?.type, barrier.history.at(-1)?.runId, barrier.history.at(-1)?.by], ['proved', first.runId, 'tester'])
    const run = JSON.parse(await fs.readFile(path.join(a.path, 'runs', first.runId, 'run.json'), 'utf8'))
    t.ok('the run\'s entry is proved', Boolean(run.cleanup.entries[0].provedAt))
    const admitted = await start(b, IN_PLACE)
    t.ok('an in-place start is admitted', Boolean(admitted.runId))
    await admitted.drive()
    await releaseOwnership(admitted)
  }

  t.section('B4. a proof that fails keeps the barrier')
  const c = await f.issues.createIssue(P, { name: 'Third issue' })
  const third = await unproved(c)
  {
    const failing = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform: proving([{ status: 'unavailable', method: 'test', pids: [], reason: 'nope' }]) })
    const refused = await failing.proveCleanup({ project: P, issueId: c.id, runId: third.runId, actor: 'tester' }).catch((e) => e)
    t.eq('refused', [refused?.status, refused?.code], [409, 'CLEANUP_UNPROVED'])
    t.eq('the entry stays', (await readBarrier(projectDir)).entries.map((e) => e.runId), [third.runId])
    t.eq('starts stay refused', (await refusal(start(b, IN_PLACE)))?.code, 'CLEANUP_BARRIER')
  }

  t.section('B5. a resumed in-place writer is refused while another run\'s entry remains')
  const d = await f.issues.createIssue(P, { name: 'Fourth issue' })
  {
    // Another run's entry is written as the engine would write it.
    const fourth = await unproved(d).catch((e) => e)
    t.eq('the fourth run could not even start: the barrier holds', fourth?.code, 'CLEANUP_BARRIER')
    const resumed = await resumeRun({ issuePath: c.path, runId: third.runId, harnesses: f.harnesses, stepStore: { create: (o) => f.issues.createStep(P, c.id, o) }, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
    resumed.platform = proving()
    // The third run's own entry proves; a foreign entry would still bar it.
    const { addBarrierEntries } = await import('../server/runtime/cleanup-barrier.mjs')
    await addBarrierEntries(projectDir, { issueId: d.id, runId: 'foreign-run', checkout: f.projectPath }, [{ tag: 'foreign-tag', role: 'implementer', invocationId: 'x', reason: 'scan-unavailable', structural: false, at: new Date().toISOString() }])
    const refused = await resumed.resumeExecution().catch((e) => e)
    t.eq('the resume is refused', [refused?.status, refused?.code], [409, 'CLEANUP_BARRIER'])
    t.ok('its own entry was proved meanwhile', Boolean(resumed.run.cleanup.entries[0].provedAt))
    t.ok('naming the other run', refused?.message.includes('foreign-run'), refused?.message)
    await releaseOwnership(resumed)
  }

  t.section('B7. the proof works for a run whose record is gone (the barrier keeps its tag)')
  {
    const proved = await supervisor.proveCleanup({ project: P, issueId: d.id, runId: 'foreign-run', actor: 'tester' })
    t.eq('proved from the barrier entry alone', proved.proved, true)
    t.eq('no entry is left', (await readBarrier(projectDir)).entries.map((e) => e.runId), [])
  }

  t.section('B6. after an owner is lost, a tag that scans clean bars nothing (Linux, confined)')
  if (process.platform !== 'linux') t.skip('owner loss with the real linux scan', 'not linux')
  else {
    for (const survives of [false, true]) {
      const g = await engineFixture()
      const gDir = path.dirname(g.issuePath)
      const gSupervisor = createSupervisor({ issues: g.issues, harnessDir: path.join(g.configRoot, 'harness'), projectsDir: path.dirname(g.projectPath), configRoot: g.configRoot, platform: platformFor('linux') })
      const engine = await startRun({ ...g, deliveryProvider: g.delivery, runOptions: IN_PLACE, expectConfigHash: (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: IN_PLACE, projectId: P })).resolved.configHash })
      let survivor = null
      engine.hooks.beforeInvoke = async (e) => {
        const pending = Object.values(e.run.participants).find((p) => p.pendingInvocation?.cursor?.stepId === 'implement')?.pendingInvocation
        if (!pending) return
        delete e.hooks.beforeInvoke
        if (survives) {
          survivor = spawn('sleep', ['30'], { env: { ...process.env, [REAP_TAG]: pending.reapTag }, stdio: 'ignore' })
          await new Promise((resolve) => survivor.once('spawn', resolve))
        }
        throw Object.assign(new Error('owner crashed'), { injected: true })
      }
      await engine.drive().catch(() => {})
      await simulateProcessDeath(g.issuePath)
      await gSupervisor.reconcile()
      const run = JSON.parse(await fs.readFile(path.join(g.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
      const entry = run.cleanup?.entries?.[0]
      const label = survives ? 'B6b, a survivor' : 'B6a, no survivor'
      t.eq(`${label}: the lost tag is recorded as owner-lost`, entry?.reason, 'owner-lost')
      t.eq(`${label}: proved at detection only when nothing carries it`, Boolean(entry?.provedAt), !survives)
      t.eq(`${label}: the barrier holds only for a survivor`, (await readBarrier(gDir)).entries.length, survives ? 1 : 0)
      const other = await g.issues.createIssue(P, { name: 'Another' })
      const next = await startRun({ ...g, issue: { ...other, project: P }, issuePath: other.path, stepStore: { create: (o) => g.issues.createStep(P, other.id, o) }, deliveryProvider: g.delivery, runOptions: IN_PLACE,
        expectConfigHash: (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: IN_PLACE, projectId: P })).resolved.configHash }).then((e) => e, (e) => e)
      t.eq(`${label}: another in-place start is ${survives ? 'refused' : 'admitted, as before'}`, next?.code ?? 'admitted', survives ? 'CLEANUP_BARRIER' : 'admitted')
      if (next?.runId) await releaseOwnership(next)
      if (survives) {
        const resumed = await resumeRun({ issuePath: g.issuePath, runId: engine.runId, harnesses: g.harnesses, stepStore: g.stepStore, clock: g.clock, configRoot: g.configRoot, deliveryProvider: g.delivery, workspaceProvider: g.workspaceProvider, projectPath: g.projectPath })
        resumed.platform = platformFor('linux')
        const refused = await resumed.recoverOwnerLoss().catch((e) => e)
        t.ok(`${label}: recover is refused, naming the pid`, refused?.status === 409 && refused.message.includes(String(survivor.pid)), refused?.message)
        t.eq(`${label}: and nothing was killed`, alive(survivor.pid), true)
        survivor.kill('SIGKILL')
        await releaseOwnership(resumed)
      }
    }
  }

  await cleanupFixtures()
}
