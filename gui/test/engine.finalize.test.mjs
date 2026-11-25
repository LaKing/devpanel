import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun } from '../server/runtime/launch.mjs'
import { readRun, readEvents, runDir } from '../server/runtime/store.mjs'
import { fingerprint, LEGACY_FINGERPRINT_RULE, FINGERPRINT_RULE } from '../server/runtime/fingerprint.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { engineFixture, simulateProcessDeath, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — a run that stopped at delivery can be finalized from its retained worktree'

const NL = String.fromCharCode(10)

/** A delivery whose reconstruction never verifies: what a fingerprint the patch cannot rebuild looks like. */
function unverifiableDelivery () {
  const calls = []
  return {
    calls,
    async deliver (args) {
      calls.push(args)
      const file = path.join(args.runDir, 'artifacts', 'delivered.patch')
      await fs.writeFile(file, `delivered ${args.revision}${NL}`, 'utf8')
      return { artifactRef: 'artifacts/delivered.patch', bytes: 1, reconstruction: { verified: false, fingerprint: 'sha256:0', expected: args.revision, detail: 'simulated: permission bits the patch cannot carry' } }
    }
  }
}

const start = (f, deliveryProvider) => startRun({ ...f, issue: { project: 'devpanel-project', id: f.issue.id }, deliveryProvider })
const resume = (f, runId, deliveryProvider) => resumeRun({ issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, projectPath: f.projectPath, deliveryProvider })
const rejected = async (fn) => { try { await fn(); return null } catch (e) { return e } }

/** Rewrite the recorded revision (and everything that names it) as if it had been taken under an older rule. */
async function ageRevision (f, runId, from, to) {
  const run = await readRun(f.issuePath, runId)
  for (const r of run.revisions) if (r.fingerprint === from) { r.fingerprint = to; delete r.rule }
  for (const a of run.approvals) if (a.revision === from) a.revision = to
  for (const s of run.steps) if (s.revision === from) s.revision = to
  await fs.writeFile(path.join(runDir(f.issuePath, runId), 'run.json'), JSON.stringify(run, null, 2))
  const outputs = path.join(runDir(f.issuePath, runId), 'outputs')
  for (const file of await fs.readdir(outputs)) {
    const record = JSON.parse(await fs.readFile(path.join(outputs, file), 'utf8'))
    if (record.contract === 'closureConfirmation' && record.output?.revision === from) {
      record.output.revision = to
      await fs.writeFile(path.join(outputs, file), JSON.stringify(record, null, 2))
    }
  }
}

export default async function (t) {
  try {
    t.section('1. a delivery that cannot be verified blocks, and offers finalize while the worktree is retained')
    let f = await engineFixture()
    let engine = await start(f, unverifiableDelivery())
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('at delivery', engine.run.blockedReason, 'delivery-unverifiable')
    t.eq('the approval stands', engine.run.approvals.length > 0, true)
    t.eq('finalize is offered, with a fresh start', supportedActions(engine.run), ['finalize', 'start-new'])
    t.eq('the revision records its rule', engine.run.revisions.at(-1).rule, FINGERPRINT_RULE)
    const approved = engine.run.closure.revision

    t.section('2. finalize evaluates closure again from the disk and completes only what was already earned')
    await simulateProcessDeath(f.issuePath)
    let resumed = await resume(f, engine.runId, f.delivery)
    await resumed.finalize()
    t.eq('completed', resumed.run.status, 'completed')
    t.eq('resolved', resumed.run.outcome, 'resolved')
    t.eq('the same revision was delivered', resumed.run.delivery.revision, approved)
    t.ok('delivery completed', Boolean(resumed.run.delivery.completedAt))
    t.eq('the attempt is on record', resumed.run.finalizations.map((x) => x.previousBlock), ['delivery-unverifiable'])
    t.eq('the earlier receipt is kept', resumed.run.finalizations[0].previousDelivery?.reconstruction?.verified, false)
    const events = (await readEvents(f.issuePath, engine.runId)).events.map((e) => e.type)
    t.ok('finalizing and finished are journaled', events.includes('finalizing') && events.at(-1) === 'finished')
    t.eq('only a fresh start is offered afterwards', supportedActions(resumed.run), ['start-new'])
    t.ok('finalizing a completed run is refused', /not waiting at delivery/.test((await rejected(() => resumed.finalize()))?.message ?? ''))
    t.eq('the record persisted', (await readRun(f.issuePath, engine.runId)).status, 'completed')

    t.section('2b. finalize checks the step budget as a continuation does, before it changes anything')
    f = await engineFixture()
    engine = await start(f, unverifiableDelivery())
    await engine.drive()
    {
      const count = engine.run.steps.filter((s) => s.role !== 'operator').length
      engine.run.budgets.limits.maxSteps = count
      const before = JSON.stringify([engine.run.status, engine.run.blockedReason, engine.run.finalizations ?? null, engine.run.budgets.limits])
      const spent = await rejected(() => engine.finalize())
      t.eq('a spent step budget refuses with the existing error', [spent?.status, spent?.message], [422, 'Increase the exhausted budget before resuming. Recorded usage is preserved.'])
      const lowered = await rejected(() => engine.finalize({ budgets: { maxSteps: count - 1 } }))
      t.eq('a lower limit is refused', [lowered?.status, lowered?.message], [400, 'Resume budgets must be positive integer limits and cannot reduce existing allowances.'])
      t.eq('nothing on the run changed', JSON.stringify([engine.run.status, engine.run.blockedReason, engine.run.finalizations ?? null, engine.run.budgets.limits]), before)
    }

    t.section('3. a candidate that moved after approval is still refused: finalize is not a bypass')
    f = await engineFixture()
    engine = await start(f, unverifiableDelivery())
    await engine.drive()
    await fs.appendFile(path.join(engine.run.workspace.path, 'source.txt'), 'edited after approval' + NL)
    await simulateProcessDeath(f.issuePath)
    resumed = await resume(f, engine.runId, f.delivery)
    await resumed.finalize()
    t.eq('still blocked', resumed.run.status, 'blocked')
    t.eq('for the real reason', resumed.run.blockedReason, 'candidate-changed-since-approval')
    t.eq('nothing was delivered', f.delivery.calls.length, 0)

    t.section('4. a revision recorded under the legacy permission-bits rule is re-expressed, not treated as drift')
    f = await engineFixture()
    engine = await start(f, unverifiableDelivery())
    await engine.drive()
    const ws = engine.run.workspace.path
    // The content the auditor examined is unchanged; only a permission bit Git
    // cannot carry differs, which the legacy rule recorded and the current one does not.
    await fs.chmod(path.join(ws, 'source.txt'), 0o600)
    const current = engine.run.closure.revision
    const legacy = (await fingerprint(ws, { baseCommit: engine.run.workspace.baseCommit, baseline: engine.baseline, rule: LEGACY_FINGERPRINT_RULE })).fingerprint
    t.ok('the two rules name the same content differently', legacy !== current)
    await ageRevision(f, engine.runId, current, legacy)
    await simulateProcessDeath(f.issuePath)
    resumed = await resume(f, engine.runId, f.delivery)
    await resumed.finalize()
    t.eq('completed', resumed.run.status, 'completed')
    t.eq('delivered under the current name', resumed.run.delivery.revision, current)
    t.eq('the migration is a recorded revision', resumed.run.revisions.at(-1).migratedFrom, legacy)
    t.eq('under the legacy rule', resumed.run.revisions.at(-1).migratedRule, LEGACY_FINGERPRINT_RULE)
    t.eq('approvals were carried by name', resumed.run.approvals.map((a) => `${a.revision === current}:${a.migratedFrom === legacy}`), ['true:true'])
    t.ok('journaled', (await readEvents(f.issuePath, engine.runId)).events.some((e) => e.type === 'revision-migrated' && e.from === legacy && e.to === current))

    t.section('5. the legacy rule proves content, so real drift under it is still drift')
    f = await engineFixture()
    engine = await start(f, unverifiableDelivery())
    await engine.drive()
    const stale = 'sha256:' + 'a'.repeat(64)
    await ageRevision(f, engine.runId, engine.run.closure.revision, stale)
    await simulateProcessDeath(f.issuePath)
    resumed = await resume(f, engine.runId, f.delivery)
    await resumed.finalize()
    t.eq('blocked as drift', resumed.run.blockedReason, 'candidate-changed-since-approval')
    t.ok('no migration recorded', !resumed.run.revisions.some((r) => r.migratedFrom))

    t.section('6. what the panel offers')
    const blocked = (blockedReason, extra = {}) => ({ status: 'blocked', blockedReason, participants: {}, workspace: { path: '/w', state: 'retained' }, integrity: { status: 'clear' }, ...extra })
    t.eq('delivery-failed', supportedActions(blocked('delivery-failed')), ['finalize', 'start-new'])
    t.eq('delivery-unavailable', supportedActions(blocked('delivery-unavailable')), ['finalize', 'start-new'])
    t.eq('a removed worktree has nothing to deliver', supportedActions(blocked('delivery-failed', { workspace: { path: '/w', state: 'removed' } })), ['start-new'])
    t.eq('a quarantined run is not finalizable', supportedActions(blocked('delivery-failed', { integrity: { status: 'quarantined' } })), ['resolve-integrity', 'abandon'])
    t.eq('drift needs a new run', supportedActions(blocked('candidate-changed-since-approval')), ['start-new'])
    t.eq('recovery comes first', supportedActions(blocked('recovery-required')), ['abandon'])
  } finally {
    await cleanupFixtures()
  }
}
