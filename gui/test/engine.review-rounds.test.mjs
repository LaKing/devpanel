import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { appendReviewRounds, plan, settledRounds } from '../server/runtime/engine.mjs'
import os from 'node:os'
import { resolvePlaybook } from '../server/config/load.mjs'
import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'

export const name = 'engine — review rounds are recorded once each, when decided, for the supervisor\'s review-rounds wake'

const start = (f) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})
const readRun = async (f, runId) => JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', runId, 'run.json'), 'utf8'))
const row = (phase, round, approved, extra = {}) => ({ phase, round, reviewed: null, approved, verdict: approved ? 'approved' : 'changes-needed', seats: [], blocking: [], ...extra })

export default async function (t) {
  t.section('a rejected plan loop: each decided round once, in order, with its blocking findings; admission before the run goes on')
  {
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ planReviews: [[blocking('P1')], [blocking('P2')], [blocking('P3')], []] }) })
    const engine = await start(f)
    const admissions = []
    engine.admitReviewRounds = async ({ rows }) => {
      const onDisk = await readRun(f, engine.runId)
      admissions.push({ keys: rows.map((r) => r.key), status: onDisk.status, recorded: onDisk.reviewRounds.map((r) => r.key) })
      return { state: 'admitted', thresholds: [] }
    }
    await engine.drive()
    const plan = engine.run.reviewRounds.filter((r) => r.phase === 'plan-review')
    t.eq('four plan-review rounds recorded, once each', plan.map((r) => r.key), ['-1:plan-review:0', '-1:plan-review:1', '-1:plan-review:2', '-1:plan-review:3'])
    t.eq('the three rejected ones are counted 1, 2, 3; the approving one is not', plan.map((r) => r.nonApproving ?? null), [1, 2, 3, null])
    t.eq('each carries its blocking finding id and location, whole', plan.slice(0, 3).map((r) => r.blocking.map((b) => `${b.id}@${b.location}`)), [['P1@source.txt:1'], ['P2@source.txt:1'], ['P3@source.txt:1']])
    t.eq('and each seat\'s verdict', plan[0].seats.map((s) => s.verdict), ['changes-needed'])
    t.eq('a plan review names no revision', plan[0].reviewed, 'plan')
    t.ok('the implementation round is recorded too, approved', engine.run.reviewRounds.some((r) => r.phase === 'implement-review' && r.approved))
    t.eq('admission was asked for each rejected round, one at a time', admissions.map((a) => a.keys), [['-1:plan-review:0'], ['-1:plan-review:1'], ['-1:plan-review:2']])
    t.ok('with the run still running and the round already on disk', admissions.every((a) => a.status === 'running' && a.recorded.includes(a.keys[0])))
    t.eq('the admission outcome is kept on the round', plan[0].admission?.state, 'admitted')
    // A replay (a resumed loop, a panel restart) decides the same rounds again and records nothing.
    const before = JSON.stringify(engine.run.reviewRounds)
    await engine.recordReviewRounds()
    t.eq('recording again adds nothing', JSON.stringify(engine.run.reviewRounds), before)
    await releaseWorkspace(engine)

    // A run first loaded by this code with rounds already decided: those are never counted.
    const runId = engine.runId
    const record = await readRun(f, runId)
    delete record.reviewRounds; delete record.reviewRoundsBaseline
    await fs.writeFile(path.join(f.issuePath, 'runs', runId, 'run.json'), JSON.stringify(record))
    const legacy = await resumeRun({ issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore, configRoot: f.configRoot, takeLock: false })
    t.ok('an older run without reviewRounds gets its decided rounds as a baseline at load', legacy.run.reviewRoundsBaseline.includes('-1:plan-review:2'))
    let asked = 0
    legacy.admitReviewRounds = async () => { asked++; return { state: 'admitted' } }
    await legacy.recordReviewRounds()
    t.eq('and records none of them, so no event fires until a new round is decided', [legacy.run.reviewRounds.length, asked], [0, 0])
  }

  t.section('a deferred plan finding blocks the implementation rounds with its location, though the auditor names no finding of its own')
  {
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ planReviews: [[blocking('P1')], []], implReviews: [[]], planDispositions: { P1: 'deferred' } }) })
    const engine = await start(f)
    await engine.drive()
    const impl = engine.run.reviewRounds.filter((r) => r.phase === 'implement-review')
    t.ok('implementation rounds were recorded as not passing', impl.length >= 2 && impl.every((r) => !r.approved))
    t.eq('the deferred plan finding is the round\'s blocking finding', impl[0].blocking.map((b) => [b.id, b.location, b.deferred]), [['P1', 'source.txt:1', true]])
    t.eq('counted per loop', impl.map((r) => r.nonApproving), impl.map((_, i) => i + 1))
    await releaseWorkspace(engine)
  }

  t.section('a round counts only once the engine has moved past it; the last turn before a stop is recorded')
  {
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ planReviews: [[blocking('P1')], [blocking('P2')], []] }) })
    const engine = await start(f)
    let missing = 0
    // One turn per drive: every drive ends right after its turn (the turn-limit exit), and whatever that turn
    // decided is on the record when the drive returns, before anything else could stop the run.
    for (let i = 0; i < 40 && ['pending', 'running'].includes(engine.run.status); i++) {
      await engine.drive({ maxTurns: 1 })
      const decided = []
      const next = plan(engine.snapshot, engine.activeSteps(), engine.outputs, { ...engine.planEvidence(), decided })
      for (const r of settledRounds(decided, next)) if (!engine.run.reviewRounds.some((x) => x.phase === r.phase && x.round === r.round)) missing++
    }
    t.eq('no settled round was ever missing from the record after a drive ended', missing, 0)
    t.eq('the rejected plan rounds were counted', engine.run.reviewRounds.filter((r) => r.phase === 'plan-review').map((r) => r.nonApproving ?? null), [1, 2, null])
    await releaseWorkspace(engine)
  }

  t.section('a cancel right after the rejecting turn: the round is admitted while the run is still live, then the run is cancelled')
  {
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ planReviews: [[blocking('P1')], []] }) })
    const engine = await start(f)
    const seen = []
    engine.admitReviewRounds = async ({ rows }) => { seen.push({ keys: rows.map((r) => r.key), status: (await readRun(f, engine.runId)).status }); return { state: 'admitted' } }
    engine.hooks = { afterPersistBeforeAdvance: (e) => { if (e.run.steps.at(-1)?.stepId === 'audit-plan-1') e.cancel() } }
    await engine.drive()
    t.eq('the rejected round was admitted', seen.map((a) => a.keys), [['-1:plan-review:0']])
    t.eq('while the run was still running', seen[0]?.status, 'running')
    t.eq('then the cancel took effect', engine.run.status, 'cancelled')
    await releaseWorkspace(engine)
  }

  t.section('a rejecting audit whose descendant cleanup is unproved: the round is admitted while the run is live, then it blocks')
  {
    const base = scriptFor({ planReviews: [[blocking('P1')], []] })
    const unproved = { status: 'unavailable', method: 'proc-environ', tag: 'review-rounds-cleanup-tag', escaped: 0, reason: 'unavailable for the test' }
    const script = (turn) => turn.stepId === 'audit-plan-1' ? { text: base(turn), diagnostics: { reap: unproved } } : base(turn)
    const f = await engineFixture({ playbook: 'plan-and-implement', script })
    const engine = await start(f)
    const seen = []
    engine.admitReviewRounds = async ({ rows }) => { seen.push({ keys: rows.map((r) => r.key), status: (await readRun(f, engine.runId)).status }); return { state: 'admitted' } }
    await engine.drive()
    t.eq('the rejected round was admitted', seen.map((a) => a.keys), [['-1:plan-review:0']])
    t.eq('while the run was still running on disk', seen[0]?.status, 'running')
    t.eq('then the run blocked on its unproved cleanup', [engine.run.status, engine.run.blockedReason], ['blocked', 'cleanup-unproved'])
    await releaseWorkspace(engine)
  }

  t.section('a rejecting implementation audit with its check still running and cleanup unproved: the check settles, the round is admitted live, then it blocks')
  {
    const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
    const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
    const gate = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-held-check-')), 'release')
    const unproved = { status: 'unavailable', method: 'proc-environ', tag: 'review-rounds-check-tag', escaped: 0, reason: 'unavailable for the test' }
    let engine = null
    const seen = { checkRunningAtAudit: null }
    const script = async (turn) => {
      const { stepId, role, prompt } = turn
      if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
      if (stepId === 'implement') {
        await fs.writeFile(path.join(engine.run.workspace.path, 'work.txt'), 'work\n')
        return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
      }
      if (stepId.startsWith('audit-')) {
        seen.checkRunningAtAudit = Boolean(engine.checksInFlight)
        // The held check is released only after this review has been committed and cleanup has begun to block.
        setTimeout(() => fs.writeFile(gate, 'go').catch(() => {}), 300)
        return { text: fence({ verdict: 'changes-needed', artifactRevision: revision(prompt), findings: [blocking(`${role}-1`)], priorFindings: [] }), diagnostics: { reap: unproved } }
      }
      return scriptFor()(turn)
    }
    const f = await engineFixture({ playbook: 'implementation', script })
    const playbookFile = path.join(f.configRoot, 'playbooks/implementation.yaml')
    await fs.appendFile(playbookFile, `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    commands:\n      - id: probe\n        run: ${JSON.stringify(`while [ ! -f ${gate} ]; do sleep 0.05; done`)}\n`)
    const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
    const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
    if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
    engine = await startRun({ expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
      configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions })
    const admissions = []
    engine.admitReviewRounds = async ({ rows }) => { admissions.push({ keys: rows.map((r) => r.key), status: (await readRun(f, engine.runId)).status }); return { state: 'admitted' } }
    await engine.drive()
    t.eq('the check was running while the auditor reviewed', seen.checkRunningAtAudit, true)
    t.eq('the rejected implementation round was admitted once', admissions.map((a) => a.keys), [['-1:implement-review:0']])
    t.eq('while the run was still running on disk', admissions[0]?.status, 'running')
    t.eq('then the run blocked on its unproved cleanup', [engine.run.status, engine.run.blockedReason], ['blocked', 'cleanup-unproved'])
    await releaseWorkspace(engine)
  }

  t.section('a failed Refresh checks: rounds are recorded and admitted before the run is blocked')
  {
    const f = await engineFixture({ playbook: 'plan-and-implement', script: scriptFor({ planReviews: [[]] }) })
    const engine = await start(f)
    // Refresh checks pending on a revision; the refreshed drive fails.
    engine.run.checkRefresh = { pending: true, revision: 'sha256:refreshed', target: {} }
    engine.maybeRunChecks = async () => { engine.run.checkResults.push({ revision: 'sha256:refreshed', result: 'failed', at: engine.clock.iso() }) }
    const statuses = []
    const record = engine.recordReviewRounds.bind(engine)
    engine.recordReviewRounds = async () => { statuses.push(engine.run.status); return record() }
    await engine.drive()
    t.eq('the run blocked on the failed refresh', engine.run.blockedReason, 'refreshed-checks-failed')
    t.eq('rounds were recorded first, with the run still running', statuses, ['running'])
    await releaseWorkspace(engine)
  }

  t.section('settledRounds: a round still owed a repair, re-review, check or running drive is not decided')
  {
    const decided = [row('plan-review', 0, false), row('implement-review', 1, true, { reviewed: 'sha256:x' })]
    const turn = (phase, round) => ({ kind: 'turn', phase: { id: phase }, round })
    t.eq('next is the next round: both settled', settledRounds(decided, turn('implement-review', 2)).length, 2)
    t.eq('next is a re-review of the same round: that round waits', settledRounds(decided, turn('implement-review', 1)).map((r) => r.phase), ['plan-review'])
    t.eq('next is the round\'s own check: it waits', settledRounds(decided, { kind: 'checks', phase: { id: 'implement-review' }, round: 1 }).map((r) => r.phase), ['plan-review'])
    t.eq('a check owed in a later phase holds no earlier round', settledRounds([row('plan-review', 2, false)], { kind: 'checks', phase: { id: 'implement-review' }, round: 0 }).length, 1)
    t.eq('a check running on the reviewed revision holds that round', settledRounds(decided, { kind: 'terminal' }, { checkingRevision: 'sha256:x' }).map((r) => r.phase), ['plan-review'])
    t.eq('a plan review (no revision) is never held by a running check', settledRounds([row('plan-review', 0, false)], { kind: 'terminal' }, { checkingRevision: 'sha256:y' }).length, 1)
  }

  t.section('appendReviewRounds: once per (window, loop, round), counted across restart windows, older decisions excluded')
  {
    let { list, added } = appendReviewRounds([], [row('plan-review', 0, false), row('plan-review', 1, false)], { windowResetAfter: null })
    t.eq('two rounds counted 1 and 2', added.map((r) => [r.key, r.nonApproving]), [['-1:plan-review:0', 1], ['-1:plan-review:1', 2]])
    ;({ list, added } = appendReviewRounds(list, [row('plan-review', 1, true)], { windowResetAfter: null }))
    t.eq('the same round decided again on a replay or Continue adds nothing', added.length, 0)
    ;({ list, added } = appendReviewRounds(list, [row('plan-review', 0, false)], { windowResetAfter: 12 }))
    t.eq('a plan restart is a new window, and the count goes on', added.map((r) => [r.key, r.nonApproving]), [['12:plan-review:0', 3]])
    // A round open at first load (waiting for its check) is not in the baseline; decided later by the check alone, it counts.
    const atLoad = settledRounds([row('implement-review', 0, false, { reviewed: 'sha256:r', checksFailed: true })], { kind: 'checks', phase: { id: 'implement-review' }, round: 0 })
    t.eq('a round waiting on its check at load is not part of the baseline', atLoad.length, 0)
    ;({ added } = appendReviewRounds([], [row('implement-review', 0, false, { checksFailed: true }), row('plan-review', 2, false)], { baseline: ['-1:plan-review:2'] }))
    t.eq('later decided only by a failed check, it is recorded and counted 1; a baseline round is not', added.map((r) => [r.key, r.nonApproving, r.checksFailed]), [['-1:implement-review:0', 1, true]])
  }
}
