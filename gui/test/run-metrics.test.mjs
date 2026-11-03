import { runMetrics, seatMetrics, emptyMetricsTotals, absorbMetrics, reportMetrics } from '../server/runtime/run-metrics.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'

export const name = 'run metrics — rounds beside restarts, agent time beside waiting, distinct slugs beside matches'

const T0 = Date.parse('2026-09-18T04:00:00.000Z')
const at = (min) => new Date(T0 + min * 60_000).toISOString()
let n = 0
const step = ({ stepId, role, phase, round = 0, attempt = 1, from, minutes, durationUnknown = false }) => ({
  number: String(++n).padStart(3, '0'), stepId, role, phase, round, attempt,
  startedAt: at(from), endedAt: at(from + minutes),
  durationMs: durationUnknown ? null : minutes * 60_000, durationUnknown: durationUnknown ? 'process-died' : null
})
const review = (findings) => ({ valid: true, contract: 'reviewResult', output: { verdict: findings.length ? 'changes-needed' : 'approved', findings } })
const finding = (id, blocking = true) => ({ id, severity: 'major', blocking, description: id })

/*
 * A run shaped like the wildcard-certificates one in miniature: two planning
 * cycles restarted from triage, then a legitimate plan round, an operator
 * decision waited on for an hour (recorded twice, as the engine does: on the
 * decision step and in controlSuspendedMs), a budget stop of half an hour, and
 * two implementation rounds with three auditors who mostly agree.
 */
function fixture ({ marked = true } = {}) {
  n = 0
  const steps = []
  const outputs = {}
  const effects = {}
  let clock = 0
  const turn = (o) => { const s = step({ ...o, from: clock }); clock += o.minutes; steps.push(s); return s }
  // cycle 1: triage, brief, plan, three audits, brief (restart)
  turn({ stepId: 'triage', role: 'coordinator', phase: 'triage', minutes: 1 })
  turn({ stepId: 'brief-plan', role: 'coordinator', phase: 'plan-review', minutes: 1 })
  turn({ stepId: 'plan', role: 'planner', phase: 'plan-review', minutes: 10 })
  outputs[turn({ stepId: 'audit-plan-1', role: 'auditor-1', phase: 'plan-review', minutes: 5 }).number] = review([finding('auditor-1-hostname-http01'), finding('auditor-1-acme-conflict')])
  outputs[turn({ stepId: 'audit-plan-2', role: 'auditor-2', phase: 'plan-review', minutes: 5 }).number] = review([finding('auditor-2-hostname-http01')])
  // auditor-3 first returned a wrong revision and repaired: only the repair counts
  outputs[turn({ stepId: 'audit-plan-3', role: 'auditor-3', phase: 'plan-review', minutes: 2 }).number] = review([finding('auditor-3-superseded-claim')])
  outputs[turn({ stepId: 'audit-plan-3', role: 'auditor-3', phase: 'plan-review', minutes: 3, attempt: 2 }).number] = review([finding('auditor-3-Hostname-HTTP01'), finding('auditor-3-axfr-unauthorised'), finding('auditor-3-axfr-unauthorised')])
  const restart1 = turn({ stepId: 'brief-plan', role: 'coordinator', phase: 'plan-review', round: 1, minutes: 1 })
  effects[restart1.number] = { at: at(0), ...(marked ? { reset: 'plan' } : {}) }
  // cycle 2 (restarted): a repaired triage first — a repair, not another restart
  turn({ stepId: 'triage', role: 'coordinator', phase: 'triage', minutes: 1 })
  turn({ stepId: 'triage', role: 'coordinator', phase: 'triage', minutes: 1, attempt: 2 })
  turn({ stepId: 'brief-plan', role: 'coordinator', phase: 'plan-review', minutes: 1 })
  turn({ stepId: 'plan', role: 'planner', phase: 'plan-review', minutes: 10 })
  outputs[turn({ stepId: 'audit-plan-1', role: 'auditor-1', phase: 'plan-review', minutes: 5 }).number] = review([finding('auditor-1-acme-conflict')])
  outputs[turn({ stepId: 'audit-plan-2', role: 'auditor-2', phase: 'plan-review', minutes: 5 }).number] = review([finding('auditor-2-long-outage-lapse')])
  outputs[turn({ stepId: 'audit-plan-3', role: 'auditor-3', phase: 'plan-review', minutes: 5 }).number] = review([])
  // the coordinator asks the operator; the answer comes an hour later
  const asked = turn({ stepId: 'brief-plan', role: 'coordinator', phase: 'plan-review', round: 1, minutes: 1 })
  effects[asked.number] = { at: at(0), ...(marked ? { ignored: ['restartPlan'] } : {}) }
  turn({ stepId: 'decision', role: 'operator', phase: 'plan-review', round: 1, minutes: 60 })
  // …and this time the loop advances: round 1 within the same cycle
  turn({ stepId: 'plan', role: 'planner', phase: 'plan-review', round: 1, minutes: 8 })
  outputs[turn({ stepId: 'audit-plan-1', role: 'auditor-1', phase: 'plan-review', round: 1, minutes: 4 }).number] = review([])
  outputs[turn({ stepId: 'audit-plan-2', role: 'auditor-2', phase: 'plan-review', round: 1, minutes: 4 }).number] = review([])
  outputs[turn({ stepId: 'audit-plan-3', role: 'auditor-3', phase: 'plan-review', round: 1, minutes: 4 }).number] = review([])
  // a budget stop: half an hour suspended before an operator resumed it
  const stoppedAt = clock
  clock += 30
  const resumedAt = clock
  turn({ stepId: 'brief-implement', role: 'coordinator', phase: 'implement-review', minutes: 1 })
  turn({ stepId: 'implement', role: 'planner', phase: 'implement-review', minutes: 20 })
  outputs[turn({ stepId: 'audit-implement-1', role: 'auditor-1', phase: 'implement-review', minutes: 6 }).number] = review([finding('auditor-1-reload-recorded-ok')])
  outputs[turn({ stepId: 'audit-implement-2', role: 'auditor-2', phase: 'implement-review', minutes: 6 }).number] = review([finding('auditor-2-reload-recorded-ok')])
  outputs[turn({ stepId: 'audit-implement-3', role: 'auditor-3', phase: 'implement-review', minutes: 6 }).number] = review([finding('auditor-3-reload-recorded-ok')])
  turn({ stepId: 'brief-implement', role: 'coordinator', phase: 'implement-review', round: 1, minutes: 1 })
  turn({ stepId: 'implement', role: 'planner', phase: 'implement-review', round: 1, minutes: 10 })
  outputs[turn({ stepId: 'audit-implement-1', role: 'auditor-1', phase: 'implement-review', round: 1, minutes: 5 }).number] = review([])
  outputs[turn({ stepId: 'audit-implement-2', role: 'auditor-2', phase: 'implement-review', round: 1, minutes: 5 }).number] = review([])
  outputs[turn({ stepId: 'audit-implement-3', role: 'auditor-3', phase: 'implement-review', round: 1, minutes: 5 }).number] = review([])
  turn({ stepId: 'confirm', role: 'coordinator', phase: 'confirm', minutes: 1 })
  clock += 2 // delivery
  const run = {
    runId: 'r', status: 'completed', outcome: 'resolved', startedAt: at(0), endedAt: at(clock), steps,
    // As the engine writes it: the answered hour AND the budget stop, in one total.
    controlSuspendedMs: 90 * 60_000,
    resumeHistory: [{ at: at(resumedAt), suspendedMs: (resumedAt - stoppedAt) * 60_000 }],
    coordinatorEffects: effects
  }
  return { run, outputs, clock }
}

const launch = (f, extra = {}) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, ...extra
})

export default async (t) => {
  const { run, outputs, clock } = fixture()
  const m = runMetrics(run, { outputs })

  t.section('1. the elapsed time is split four ways, the four add up, and a wait recorded twice counts once')
  {
    const agent = run.steps.filter((s) => s.role !== 'operator').reduce((a, s) => a + s.durationMs, 0)
    t.eq('elapsed is the whole run', m.time.elapsedMs, clock * 60_000)
    t.eq('agent time is the agents\' turns only', m.time.agentMs, agent)
    t.eq('an operator decision is waiting, not agent time', m.time.operatorWaitMs, 60 * 60_000)
    t.eq('the budget stop until resume is suspended time — and the answered hour in controlSuspendedMs is not counted again', m.time.suspendedMs, 30 * 60_000)
    t.eq('the remainder is engine work: here, delivery', m.time.otherMs, 2 * 60_000)
    t.eq('and the parts add up to the whole', m.time.agentMs + m.time.operatorWaitMs + m.time.suspendedMs + m.time.otherMs, m.time.elapsedMs)
    t.eq('nothing is inconsistent', m.time.inconsistentMs, 0)
    t.eq('the split is from recorded intervals', m.time.basis, 'recorded')
    t.eq('turns are counted by who took them', [m.turns.total, m.turns.agent, m.turns.operator, m.turns.repairs], [run.steps.length, run.steps.length - 1, 1, 2])
  }

  t.section('   …two reviewers of one round side by side count once in agentMs, each in seatMs')
  {
    n = 0
    const steps = [step({ stepId: 'implement', role: 'implementer', phase: 'implement-review', from: 0, minutes: 10 }),
      step({ stepId: 'audit-implement-1', role: 'auditor-1', phase: 'implement-review', from: 10, minutes: 5 }),
      step({ stepId: 'audit-implement-2', role: 'auditor-2', phase: 'implement-review', from: 10, minutes: 4 })]
    const side = runMetrics({ startedAt: at(0), endedAt: at(15), status: 'completed', steps }, { now: Date.parse(at(15)) })
    t.eq('agentMs is the wall time seats worked', side.time.agentMs, 15 * 60_000)
    t.eq('seatMs is what the seats spent', side.time.seatMs, 19 * 60_000)
    t.eq('and the split still adds up, consistently', [side.time.otherMs, side.time.inconsistentMs], [0, 0])
  }

  t.section('   …an older record with only the total infers the suspension, and says so')
  {
    const old = runMetrics({ ...run, resumeHistory: [] })
    t.eq('the answered hour is taken out of the total', old.time.suspendedMs, 30 * 60_000)
    t.eq('and the reading is marked inferred', old.time.basis, 'inferred')
    // A resume whose interval covers the answered wait: the same hour on record twice.
    const twice = runMetrics({ ...run, resumeHistory: [...run.resumeHistory, { at: run.steps.find((s) => s.role === 'operator').endedAt, suspendedMs: 60 * 60_000 }] })
    t.eq('an overlap is removed from suspension, not from the wait', [twice.time.operatorWaitMs, twice.time.suspendedMs], [60 * 60_000, 30 * 60_000])
    t.eq('and reported as suspension that overlapped a wait', twice.time.overlappingSuspensionMs, 60 * 60_000)
    t.eq('the answered hour the engine folded into controlSuspendedMs is named, and counted once as waiting', m.time.waitsInControlTotalMs, 60 * 60_000)
    // An older record: 30 min of suspension in the total, then a question still
    // open for an hour. The engine has not folded the open hour into the total,
    // so the total must not be reduced by it.
    const openOld = runMetrics({ ...run, resumeHistory: [], controlSuspendedMs: 90 * 60_000, status: 'paused', endedAt: null, pause: { at: at(clock), kind: 'operator-request' } }, { now: T0 + (clock + 60) * 60_000 })
    t.eq('an open question does not consume the recorded suspension', [openOld.time.suspendedMs, openOld.time.operatorWaitMs], [30 * 60_000, 120 * 60_000])
    // Parts that exceed the whole are not clamped into silence.
    const broken = runMetrics({ ...run, endedAt: at(clock - 10) })
    t.ok('an inconsistent record is flagged with the excess', broken.time.inconsistentMs === 8 * 60_000 && broken.time.otherMs === 0, JSON.stringify(broken.time))
  }

  t.section('2. round executions are counted per cycle, beside restarts; a repair is not a restart')
  {
    const plan = m.rounds.byPhase['plan-review']
    t.eq('plan review executed three rounds: round 0 in each of two cycles, round 1 in the second', [plan.roundExecutions, plan.cycles, plan.maxDepth], [3, 2, 2])
    t.eq('the cycle restarted once — the repaired triage is attempt 2 of a turn, not another restart', m.rounds.cycleRestarts, 1)
    t.eq('from the engine\'s reset marks', m.rounds.restartsBasis, 'recorded')
    t.eq('an ignored restart request is counted on its own', m.rounds.ignoredRestartRequests, 1)
    t.eq('implementation took two rounds in one cycle, no repair', [m.rounds.byPhase['implement-review'].roundExecutions, m.rounds.byPhase['implement-review'].cycles, m.rounds.byPhase['implement-review'].repairs], [2, 1, 0])
    t.eq('agent time is attributed per phase and seat', m.rounds.byPhase['implement-review'].byRole.planner.agentMs, 30 * 60_000)
    t.eq('a repaired audit counts as a repair in its phase', m.rounds.byPhase['plan-review'].repairs, 1)
    t.ok('and the reading says what a restart does to the counter', /reset the round counter/.test(m.rounds.means))
  }

  t.section('   …an older record without reset marks infers restarts from a fresh first step, and says so')
  {
    const old = fixture({ marked: false })
    const om = runMetrics(old.run, { outputs: old.outputs })
    t.eq('the second triage at attempt 1 is a restart; its repair at attempt 2 is not', om.rounds.cycleRestarts, 1)
    t.eq('marked inferred', om.rounds.restartsBasis, 'inferred')
    t.eq('the round executions come out the same', om.rounds.byPhase['plan-review'].roundExecutions, 3)
    t.eq('and no ignored requests are claimed where none were recorded', om.rounds.ignoredRestartRequests, 0)
    // The same record resumed after the upgrade: one later effect is marked.
    // The mark must not erase the restart nothing marked before it.
    const lastBrief = old.run.steps.filter((s) => s.stepId === 'brief-implement').at(-1)
    const resumed = runMetrics({ ...old.run, coordinatorEffects: { ...old.run.coordinatorEffects, [lastBrief.number]: { at: at(0), ignored: ['restartPlan'] } } }, { outputs: old.outputs })
    t.eq('a later marker keeps the inferred restart', [resumed.rounds.cycleRestarts, resumed.rounds.restartsInferred], [1, 1])
    t.eq('and the plan rounds are still grouped by the inferred cycle', resumed.rounds.byPhase['plan-review'].cycles, 2)
    // A recorded reset that explains the rerun is not counted twice; a rerun it
    // does not explain still is.
    const both = fixture()
    const extraTriage = { ...both.run.steps[0], number: '999', startedAt: at(500), endedAt: at(501) }
    const mixed = runMetrics({ ...both.run, steps: [...both.run.steps, extraTriage] })
    t.eq('one recorded and one inferred restart: two boundaries, basis mixed', [mixed.rounds.cycleRestarts, mixed.rounds.restartsInferred, mixed.rounds.restartsBasis], [2, 1, 'mixed'])
  }

  t.section('3. finding slugs: distinct, matched by another seat, restated by the same seat, repeated later')
  {
    const f = m.findings
    // cycle 1: hostname-http01 (auditor-1, matched by 2 and 3), acme-conflict, axfr-unauthorised (named twice by auditor-3)
    // cycle 2: acme-conflict again → repeated later; long-outage → distinct
    // implementation: reload-recorded-ok ×3 seats → distinct + 2 matches
    t.eq('every report in a counted review is counted', f.reported, 11)
    t.eq('distinct slugs', f.distinctSlugs, 5)
    t.eq('a different seat naming the same slug in the same review is a match', f.matchedAcrossSeats, 4)
    t.eq('the same seat naming it twice is a restatement, never a match', f.restatedBySameSeat, 1)
    t.eq('a slug raised again in a later review is repeated, not rediscovered', f.repeatedLater, 1)
    t.eq('a report replaced by the seat\'s repaired attempt is superseded and not counted', f.supersededReports, 1)
    t.eq('reviews are (cycle, phase, round) groups', f.reviews, 5)
    t.ok('and the reading says it counts slugs, not defects', /not proof/.test(f.means) && /SLUGS/.test(f.means))
    t.eq('without outputs there is no findings reading rather than a zero one', runMetrics(run).findings, null)
  }

  t.section('   …blocking findings per round, beside the rounds per loop')
  {
    const rows = m.findings.blockingByRound.map((r) => [r.phase, r.cycle, r.round, r.blocking, r.blockingSlugs])
    t.eq('one row per review in the order they ran: reports and distinct slugs, a repaired attempt left out, a clean round 0', rows, [
      ['plan-review', 0, 0, 6, 3],
      ['plan-review', 1, 0, 2, 2],
      ['plan-review', 1, 1, 0, 0],
      ['implement-review', 1, 0, 3, 1],
      ['implement-review', 1, 1, 0, 0]
    ])
    t.eq('the rows add up to the whole-run count', m.findings.blockingByRound.reduce((a, r) => a + r.blocking, 0), m.findings.blocking)
    t.eq('the loops\' rounds are the rounds reading', [m.rounds.byPhase['plan-review'].roundExecutions, m.rounds.byPhase['implement-review'].roundExecutions], [3, 2])
    t.ok('and the reading says where rounds per loop are', /blockingByRound/.test(m.findings.means) && /roundExecutions/.test(m.findings.means))
    n = 0
    const one = step({ stepId: 'audit-plan-1', role: 'auditor-1', phase: 'plan-review', from: 0, minutes: 1 })
    const mixed = runMetrics({ startedAt: at(0), endedAt: at(1), status: 'completed', steps: [one] }, { outputs: { [one.number]: review([finding('auditor-1-a'), finding('auditor-1-b', false)]) } })
    t.eq('a non-blocking finding is not counted as blocking', [mixed.findings.blockingByRound[0].blocking, mixed.findings.reported], [1, 2])
  }

  t.section('4. a run still waiting counts an open question as waiting and a manual pause as suspension')
  {
    const later = T0 + (clock + 15) * 60_000
    const asked = runMetrics({ ...run, status: 'paused', endedAt: null, pause: { at: at(clock), kind: 'operator-request' } }, { now: later })
    t.eq('the quarter hour since the question is operator wait', asked.time.operatorWaitMs, 75 * 60_000)
    const stopped = runMetrics({ ...run, status: 'paused', endedAt: null, pause: { at: at(clock), kind: 'manual' } }, { now: later })
    t.eq('a person stopping the run is suspension, not a question waited on', [stopped.time.operatorWaitMs, stopped.time.suspendedMs], [60 * 60_000, 45 * 60_000])
    t.eq('unmeasured turns are reported, not silently zero', runMetrics({ ...run, steps: [{ ...run.steps[2], startedAt: null, endedAt: null, durationMs: null }] }).time.unknownSteps, 1)
  }

  t.section('5. a seat\'s own effort is its steps; a group total keeps the separations')
  {
    t.eq('the planner\'s own time is the planner\'s turns', seatMetrics(run, 'planner').agentMs, (10 + 10 + 8 + 20 + 10) * 60_000)
    t.eq('an auditor\'s own time is much smaller than the run', seatMetrics(run, 'auditor-2').agentMs, (5 + 5 + 4 + 6 + 5) * 60_000)
    const totals = emptyMetricsTotals()
    absorbMetrics(totals, run, { role: 'auditor-2' })
    absorbMetrics(totals, { ...run, steps: run.steps.slice(0, 8), controlSuspendedMs: 0, resumeHistory: [], coordinatorEffects: {} }, { role: 'auditor-2' })
    const r = reportMetrics(totals)
    t.eq('runs measured', r.measured, 2)
    t.eq('operator wait is summed apart from agent time', [r.operatorWaitMs, r.suspendedMs], [60 * 60_000, 30 * 60_000])
    t.eq('plan round executions are averaged over runs that had a plan phase', [r.planReviewRoundExecutions.counted, r.planReviewRoundExecutions.mean], [2, 2])
    t.eq('restarts and ignored requests are totals', [r.cycleRestarts, r.ignoredRestartRequests], [1, 1])
    t.eq('the seat\'s own effort is kept apart from the cohort figures', r.seat.agentMs, (25 + 5) * 60_000)
    t.ok('and the reading says the whole-run figures are a participation cohort', /participation cohort/.test(r.means))
    t.eq('a group with no seat has none', reportMetrics(absorbMetrics(emptyMetricsTotals(), run)).seat, null)
    const returned = { ...run, closureReturns: [{ step: '090' }, { step: '095' }], steps: [...run.steps, { number: '090', role: 'operator', decision: { automatic: true } }] }
    t.eq('the engine\'s returns to review are counted, and not as operator turns', [runMetrics(returned).closureReturns, runMetrics(returned).turns.automatic, runMetrics(returned).turns.operator], [2, 1, runMetrics(run).turns.operator])
    t.eq('and totalled per group', reportMetrics(absorbMetrics(absorbMetrics(emptyMetricsTotals(), returned), run)).closureReturns, 2)
  }

  t.section('5b. check time beside agent time, and checks that failed after approval')
  {
    // An author turn 0–10, a check 8–20 (two minutes beside the author, ten
    // alone), an audit 20–25, then a check 25–31 that failed after the audit
    // approved; a retry attempt 31–33. The history keeps each check run's own
    // interval, so the first revision's check is still measurable.
    const run = {
      status: 'completed', startedAt: at(0), endedAt: at(40),
      steps: [
        { number: '001', role: 'implementer', startedAt: at(0), endedAt: at(10), durationMs: 10 * 60_000 },
        { number: '002', role: 'auditor-1', startedAt: at(20), endedAt: at(25), durationMs: 5 * 60_000 }
      ],
      approvals: [{ role: 'auditor-1', revision: 'r2', step: '002' }],
      checkResults: [{ revision: 'r2', result: 'failed', at: at(25), durationMs: 6 * 60_000, attempts: [{ result: 'failed', at: at(31), durationMs: 2 * 60_000 }] }],
      checkHistory: [
        { revision: 'r1', result: 'passed', gating: 'passed', at: at(20), afterApproval: false, runs: [{ at: at(8), durationMs: 12 * 60_000 }] },
        { revision: 'r2', result: 'failed', gating: 'failed', at: at(33), afterApproval: true, runs: [{ at: at(25), durationMs: 6 * 60_000 }, { at: at(31), durationMs: 2 * 60_000 }] }
      ]
    }
    const time = runMetrics(run).time
    t.eq('checksMs is the union of every check interval, a retry and a history copy counted once', time.checksMs, (12 + 8) * 60_000)
    t.eq('waitingForChecksMs leaves out the two minutes an author turn ran beside the check', time.waitingForChecksMs, (10 + 8) * 60_000)
    t.eq('and otherMs no longer holds that check time', time.otherMs, 40 * 60_000 - 15 * 60_000 - 18 * 60_000)
    t.eq('the parts still fit the whole', time.inconsistentMs, 0)

    const waited = runMetrics({ status: 'completed', startedAt: at(0), endedAt: at(30), steps: [],
      checkResults: [{ revision: 'r', result: 'passed', at: at(0), durationMs: 20 * 60_000, driveSlot: { host: 'h', cap: 2, waitMs: 6 * 60_000, waitedFrom: at(1) } }],
      baselineChecks: [{ result: 'passed', at: at(0), durationMs: 20 * 60_000 }],
      driveSlotWaits: [{ host: 'h', from: at(1), to: at(7), dir: 'checks/001' }, { host: 'h', from: at(3), to: at(9), dir: 'checks/base' }] }).time
    t.eq('a drive\'s wait for a slot is reported, concurrent waits once', waited.driveSlotWaitMs, 8 * 60_000)
    t.eq('and is check waiting, inside the check\'s own interval', [waited.checksMs, waited.waitingForChecksMs], [20 * 60_000, 20 * 60_000])
    t.eq('not suspension', waited.suspendedMs, 0)
    const m = runMetrics(run)
    t.eq('one check failed on a revision approved when it started, recorded by the engine', [m.regressionsAfterApproval, m.regressionsBasis], [1, 'recorded'])
    const baselineOnly = { ...run, checkHistory: [run.checkHistory[0], { ...run.checkHistory[1], gating: 'passed' }] }
    t.eq('a failed check counts even when the unchanged project shares its failures', runMetrics(baselineOnly).regressionsAfterApproval, 1)
    const passedAfter = { ...run, checkHistory: [run.checkHistory[0], { ...run.checkHistory[1], result: 'passed', gating: 'passed' }] }
    t.eq('a check that passed after approval is not a regression', runMetrics(passedAfter).regressionsAfterApproval, 0)
    const selftest = { ...run, checkHistory: [run.checkHistory[0], { ...run.checkHistory[1], result: 'passed', gating: 'failed' }] }
    t.eq('a passing check whose baseline comparison named new selftest failures is', runMetrics(selftest).regressionsAfterApproval, 1)
    const older = { ...run, checkHistory: undefined }
    t.eq('an older record without flags infers it from the approving step and the current check', [runMetrics(older).regressionsAfterApproval, runMetrics(older).regressionsBasis], [1, 'inferred'])
    const beside = { ...older, checkResults: [{ ...run.checkResults[0], at: at(22) }] }
    t.eq('a check that started before the approving review ended is not after approval', runMetrics(beside).regressionsAfterApproval, 0)
    // The auditor's cases: a reviewer still working from minute 0 while a check
    // ran 5–10 means nobody waited on that check; and the engine's work between
    // two check runs (1–2 and 4–5, inside a 0–6 history entry) is not check time.
    const live = { status: 'running', startedAt: at(0), steps: [],
      participants: { 'auditor-1': { pendingInvocation: { startedAt: at(0) } } },
      checkResults: [{ revision: 'r1', result: 'passed', at: at(5), durationMs: 5 * 60_000 }] }
    t.eq('check time beside a turn still in flight is not waiting for checks', runMetrics(live, { now: Date.parse(at(15)) }).time.waitingForChecksMs, 0)
    const envelope = { status: 'completed', startedAt: at(0), endedAt: at(6), steps: [],
      checkResults: [{ revision: 'r1', result: 'passed', at: at(1), durationMs: 60_000 }],
      baselineChecks: [{ result: 'passed', at: at(4), durationMs: 60_000 }],
      checkHistory: [{ revision: 'r1', result: 'passed', gating: 'passed', at: at(6), afterApproval: false, runs: [{ at: at(1), durationMs: 60_000 }] }] }
    t.eq('checksMs is the union of the check runs only, not the span around them', runMetrics(envelope).time.checksMs, 120000)
    t.eq('and the gaps between them stay in otherMs', runMetrics(envelope).time.otherMs, 4 * 60_000)
    const totals = reportMetrics(absorbMetrics(absorbMetrics(emptyMetricsTotals(), run), run))
    t.eq('check time and regressions are totalled per group', [totals.checksMs, totals.waitingForChecksMs, totals.meanChecksMs, totals.regressionsAfterApproval], [40 * 60_000, 36 * 60_000, 20 * 60_000, 2])
  }

  t.section('6. through the engine: a question answered an hour later is one hour of waiting, not two')
  {
    const request = { question: 'Commit the checkout?', reason: 'uncommitted work', projectAction: 'push', category: 'live-checkout', recommendation: 'Run push.' }
    const f = await engineFixture({ script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request } }) })
    const engine = await launch(f)
    const paused = await engine.drive()
    t.eq('the run waits', paused.status, 'paused')
    f.clock.advance(60 * 60_000)
    const waiting = runMetrics(engine.run, { now: f.clock.now() })
    t.eq('while it waits, the open question is operator wait', waiting.time.operatorWaitMs, 60 * 60_000)
    await engine.answer({ pauseId: paused.pause.id, text: 'Committed it.', actor: 'op' })
    const done = await engine.drive()
    const after = runMetrics(done, { now: f.clock.now() })
    t.ok('the engine recorded the wait in controlSuspendedMs as well as on the decision step', done.controlSuspendedMs >= 60 * 60_000 && done.steps.some((s) => s.role === 'operator'))
    t.eq('but it is measured once, as waiting', after.time.operatorWaitMs, 60 * 60_000)
    t.eq('and not again as suspension', after.time.suspendedMs, 0)
    t.eq('so the parts do not exceed the whole', after.time.inconsistentMs, 0)
    t.eq('and the coordinator effects carry no reset for a run that never restarted', after.rounds.cycleRestarts, 0)
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
