import YAML from 'yaml'
import fs from 'node:fs/promises'
import path from 'node:path'

import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import * as store from '../server/runtime/store.mjs'
import { supportedActions } from '../server/supervisor.mjs'

export const name = 'full verification freeze — no seat turn begins after the freeze, the run pauses as full-verification and resumes'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const start = async (f, options = {}) => startRun({ expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })).resolved.configHash, playbookId: f.playbookId, issue: { ...f.issue, project: 'devpanel-project' }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions: options })

/** The tactical playbooks' answers (as tactics.test.mjs), recording every turn the runtime was given. */
function script (seen) {
  return (turn) => {
    seen.push(turn)
    const { stepId, prompt } = turn
    if (stepId === 'authorize-release') return fence({ targetRole: 'release-operator', prompt: 'Proceed with installed operation', releaseApproved: true })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Investigate every criterion.', windowDecision: 'keep' })
    if (stepId.startsWith('investigate')) return fence({ ...(prompt.includes('`releaseAssessment`') ? { verdict: 'approved' } : {}), summary: 'Read source and logs', findings: [], openQuestions: [] })
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: stepId.includes('implement') ? revision(prompt) : null, findings: [], priorFindings: [] })
    if (stepId === 'implement') return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], ...(revision(prompt) ? { revision: revision(prompt) } : {}) })
    return scriptFor()(turn)
  }
}

const eventsOf = async (engine) => (await store.readEvents(engine.issuePath, engine.runId)).events
const resume = async (engine) => { delete engine.hooks.beforeInvoke; await engine.resumeExecution({ actor: 'service', origin: 'full-verification' }); await engine.drive() }

export default async function (t) {
  t.section('1. a freeze during turn preparation: the prepared turn is withheld, no adapter call follows')
  {
    const seen = []
    const f = await engineFixture({ script: script(seen) })
    const engine = await start(f)
    let prepared = 0
    engine.hooks.beforeInvoke = async (e) => { if (++prepared === 2) await e.requestFreeze('2026-11-07.1') }
    await engine.drive()
    t.eq('one turn ran; the second was prepared and not started', seen.length, 1)
    t.eq('paused at the boundary as full-verification', [engine.run.status, engine.run.pause?.kind, engine.run.pause?.cycleId, engine.run.pause?.manualPending], ['paused', 'full-verification', '2026-11-07.1', false])
    t.eq('nothing is left in flight or requested', [Object.values(engine.run.participants).some((p) => p.pendingInvocation), engine.run.freezeRequested ?? null], [false, null])
    const withheld = (await eventsOf(engine)).find((e) => e.type === 'turn-withheld')
    t.eq('the withheld turn is on the record', [withheld?.reason, withheld?.cycleId], ['full-verification', '2026-11-07.1'])
    t.ok('a plain resume continues it', supportedActions(engine.run).includes('resume'))
    await resume(engine)
    t.eq('resumed, the withheld step runs and the run completes', [seen[1]?.stepId, engine.run.status], [withheld.stepId, 'completed'])
    await releaseWorkspace(engine)
  }

  t.section('2. a freeze while a turn is in flight: that turn finishes, none after it begins')
  {
    const seen = []
    let engine = null
    const base = script(seen)
    // A coding playbook: the Staging playbook was removed on 2026-11-07, a staging release is a Deployment run (section 3).
    const f = await engineFixture({ playbook: 'plan-and-implement', script: (turn) => { if (seen.length === 1) engine.requestFreeze('2026-11-07.1'); return base(turn) } })
    engine = await start(f)
    await engine.drive()
    t.eq('the turn in flight answered, the next did not begin', seen.length, 2)
    t.ok('the answered turn is recorded', engine.run.steps.some((step) => step.stepId === seen[1].stepId))
    t.eq('paused as full-verification', [engine.run.status, engine.run.pause?.kind], ['paused', 'full-verification'])
    await resume(engine)
    t.eq('and completes after resume', engine.run.status, 'completed')
    await releaseWorkspace(engine)
  }

  t.section('3. a freeze while a release runs: the release completes, no assessment turn begins')
  {
    const seen = []
    const f = await engineFixture({ playbook: 'deployment', script: script(seen) })
    const environment = (id) => ({ id, ssh: { hostRef: `ssh-config:${id}.invalid`, workdir: '/tmp' }, projectRoot: '/tmp/fixture', files: {} })
    const infrastructure = { kind: 'boilerplate', orientation: 'Isolated fixture; no real hosts', staging: environment('stage'), deployments: [environment('production')], testDrive: { requirement: 'optional', commands: [{ id: 'noop', run: 'true', required: true }], notes: 'Fixture only' } }
    infrastructure.release = { targets: { stage: { workdir: f.projectPath, ownership: 'Fixture source only', rollback: 'automatic', commands: Object.fromEntries(['inspect', 'checkpoint', 'verifyCheckpoint', 'apply', 'verifyRelease', 'restart', 'observe', 'test', 'restore', 'verifyRestore'].map((id) => [id, { run: 'printf verified', timeoutSeconds: 10 }])) } } }
    await fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true })
    await fs.writeFile(path.join(f.configRoot, 'projects/devpanel-project.yaml'), YAML.stringify({ id: 'devpanel-project', evidence: [], infrastructure }))
    const engine = await start(f, { environment: 'staging', participants: { 'verifier-1': { model: 'gpt-6-astra' } } })
    // Read inside the release, while it holds the lock: the freeze lands mid-operation.
    engine.releaseCoverage = async () => { await engine.requestFreeze('2026-11-07.1'); return { basis: 'release-snapshot', covered: [], indeterminate: [], notShipped: [] } }
    await engine.drive()
    t.eq('the release in flight completed', engine.run.release?.status, 'completed')
    t.eq('no assessment of it began', seen.filter((x) => x.stepId === 'investigate-release-operator').length, 0)
    t.eq('paused as full-verification', [engine.run.status, engine.run.pause?.kind], ['paused', 'full-verification'])
    t.ok('a completed release does not stand in the way of resuming', supportedActions(engine.run).includes('resume'))
    await resume(engine)
    t.eq('resumed: the release is not repeated and its assessment runs', [engine.run.release.commands.filter((c) => c.id === 'apply').length, seen.filter((x) => x.stepId === 'investigate-release-operator').length, engine.run.status], [1, 1, 'completed'])
    await releaseWorkspace(engine)

    t.section('4. the full verification run option resolves only as a staging Deployment, with the full tier')
    const deployment = await resolvePlaybook('deployment', { root: f.configRoot, runOptions: { environment: 'staging', fullVerification: true }, projectId: 'devpanel-project' })
    t.eq('resolved with the project\'s full tier and no cache', [deployment.ok, deployment.resolved?.fullVerification?.target?.tier, 'baselineCache' in (deployment.resolved?.fullVerification?.target ?? {})], [true, 'full', false])
    const production = await resolvePlaybook('deployment', { root: f.configRoot, runOptions: { environment: 'production', fullVerification: true }, projectId: 'devpanel-project' })
    t.ok('refused for production', !production.ok && production.errors.some((e) => /fullVerification/.test(`${e.field} ${e.message}`)))
    const implementation = await resolvePlaybook('implementation', { root: f.configRoot, runOptions: { fullVerification: true }, projectId: 'devpanel-project' })
    t.ok('refused for another playbook', !implementation.ok)
  }

  t.section('5. a concurrent round: a reviewer prepared after the freeze is withheld')
  {
    const seen = []
    const f = await engineFixture({ playbook: 'plan-and-implement', script: script(seen) })
    const engine = await start(f, { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } })
    let frozen = false
    engine.hooks.beforeInvoke = async (e) => { const p = e.run.participants['auditor-2']; if (!frozen && p?.pendingInvocation) { frozen = true; await e.requestFreeze('2026-11-07.1') } }
    await engine.drive()
    t.ok('the freeze was set while auditor-2 prepared its turn', frozen)
    t.eq('auditor-2 never began that review', seen.filter((x) => x.role === 'auditor-2').length, 0)
    t.eq('paused as full-verification', [engine.run.status, engine.run.pause?.kind], ['paused', 'full-verification'])
    await resume(engine)
    t.eq('resumed, the round finishes and the run completes', [seen.some((x) => x.role === 'auditor-2'), engine.run.status], [true, 'completed'])
    await releaseWorkspace(engine)
  }

  t.section('6. a manual pause pending beside the freeze, in either order: the freeze still withholds and the pause is kept')
  for (const order of [['pause', 'freeze'], ['freeze', 'pause']]) {
    const seen = []
    const f = await engineFixture({ script: script(seen) })
    const engine = await start(f)
    let prepared = 0
    engine.hooks.beforeInvoke = async (e) => {
      if (++prepared !== 2) return
      for (const step of order) await (step === 'pause' ? e.requestPause() : e.requestFreeze('2026-11-07.1'))
    }
    await engine.drive()
    t.eq(`${order.join(' then ')}: no adapter call after it`, seen.length, 1)
    t.eq(`${order.join(' then ')}: paused as full-verification with the operator's pause kept`, [engine.run.status, engine.run.pause?.kind, engine.run.pause?.manualPending, engine.run.pauseRequested ?? null, engine.run.freezeRequested ?? null], ['paused', 'full-verification', true, null, null])
    await releaseWorkspace(engine)
  }
}
