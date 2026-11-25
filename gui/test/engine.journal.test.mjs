import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { integrateRun, reconcileIntegration } from '../server/runtime/integrate.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import { readEvents, readRun } from '../server/runtime/store.mjs'
import { supportedActions, workspaceDisposition } from '../server/supervisor.mjs'
import { getRun } from '../server/runs-api.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { engineFixture, simulateProcessDeath } from './fakes/fixture.mjs'

const rejected = async (fn) => { try { await fn(); return null } catch (error) { return error } }
export default async function (t) {
  for (const suffix of ['{"type":', 'corrupt\n{"type":"approved","at":"later"}\n']) {
    const f = await engineFixture()
    const options = { issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses,
      stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot,
      clock: f.clock, deliveryProvider: f.delivery }
    const engine = await startRun({ ...options, playbookId: f.playbookId,
      issue: { project: 'devpanel-project', id: f.issue.id }, probe: f.probe })
    const file = path.join(f.issuePath, 'runs', engine.runId, 'events.jsonl')
    const before = await readEvents(f.issuePath, engine.runId)
    await fs.appendFile(file, suffix)
    const damaged = await fs.readFile(file)
    const calls = await f.fake.ledger.invocationCount()
    t.eq('already-loaded engine refuses invocation', (await rejected(() => engine.drive()))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('no agent called', await f.fake.ledger.invocationCount(), calls)
    t.eq('valid event prefix remains available', (await readEvents(f.issuePath, engine.runId)).events, before.events)
    const detail = await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id })
    t.eq('API preserves readable history', detail.events, before.events)
    t.eq('API exposes journal recovery finding', detail.journal.recoveryRequired, true)
    t.eq('API exposes overall recovery requirement', detail.recovery.required, true)
    // One occurrence for the loaded engine, the detail and an alert link (docs/operator-alerts.md): the persisted finding's time, not the engine's clock.
    const finding = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'journal-recovery.json'), 'utf8'))
    t.eq('the loaded engine dates the recovery by the persisted finding', engine.run.recovery.detectedAt, finding.detectedAt)
    t.eq('and the detail names the same occurrence', detail.recovery.detectedAt, finding.detectedAt)
    t.eq('missing history cannot certify a resolved result', runResult({ ...engine.run, status: 'completed', outcome: 'resolved' }, {}).result, null)
    await simulateProcessDeath(f.issuePath)
    const resumed = await resumeRun({ ...options, runId: engine.runId })
    t.eq('restart exposes recovery requirement', resumed.run.recovery.required, true)
    t.eq('automatic turn recovery is refused', (await rejected(() => resumed.recover()))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('operator resume cannot bypass journal recovery', (await rejected(() => resumed.resumeExecution()))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('direct turn invocation is refused', (await rejected(() => resumed.runTurn({})))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('delivery evaluation is refused', (await rejected(() => resumed.evaluateClosure()))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('integration is refused while the resumed engine holds the run lock', (await rejected(() => integrateRun({ issuePath: f.issuePath, runId: engine.runId })))?.code, 'RUN_LOCKED')
    t.eq('so is its reconciliation', (await rejected(() => reconcileIntegration({ issuePath: f.issuePath, runId: engine.runId })))?.code, 'RUN_LOCKED')
    await resumed.runLock.release()
    t.eq('integration is refused before publishing', (await rejected(() => integrateRun({ issuePath: f.issuePath, runId: engine.runId })))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('integration reconciliation is refused', (await rejected(() => reconcileIntegration({ issuePath: f.issuePath, runId: engine.runId })))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    resumed.runLock = await acquire(path.join(f.issuePath, '.run.lock'), { purpose: 'run', runId: engine.runId, mkdir: false })
    t.eq('unsafe UI actions are absent', supportedActions(resumed.run), ['abandon'])
    t.eq('workspace is retained even if unchanged', workspaceDisposition(resumed.run, { unchanged: true, proven: true }).discard, false)
    t.eq('all refusals preserve journal bytes', await fs.readFile(file), damaged)
    await fs.writeFile(file, damaged.subarray(0, damaged.length - Buffer.byteLength(suffix)))
    t.eq('valid prefix alone cannot prove recovery', (await readRun(f.issuePath, engine.runId)).recovery.required, true)
    t.eq('removing damaged suffix cannot enable execution', (await rejected(() => resumed.drive()))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    await releaseWorkspace(resumed)
  }
}
