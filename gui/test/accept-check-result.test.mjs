import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { startRun, releaseOwnership } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { acceptableCheck, acceptCheckUnavailable, supervisorAcceptRefusal, SUPERVISOR_ACCEPT_LIMIT } from '../server/runtime/run-control.mjs'
import { identifyCheckFailures } from '../server/runtime/baseline-failures.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { renderResult } from '../server/run-result-step.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'accept check result and deliver — a recorded decision on an approved revision only its check stops'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revisionIn = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const REASON = 'the timeout is in a suite this change does not touch'
const FLAKY = '      - id: flaky\n        run: test ! -f work.txt\n'

/*
 * The reviewers approve, the check fails on the candidate only, the author has
 * nothing to change: the run stops checks-failed-unchanged with no confirmation
 * on record (test/checks-only-block.test.mjs).
 */
async function stopped ({ confirm = true, deliveryProvider = null, minimumVerification = null, audit = null } = {}) {
  const prompts = []
  const evidence = []
  let engine = null
  const script = async (turn) => {
    const { stepId, round, prompt } = turn
    prompts.push(stepId)
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      if (round === 0) await fs.writeFile(path.join(engine.run.workspace.path, 'work.txt'), 'work\n')
      return fence({ summary: 'Implemented', basedOnRevision: revisionIn(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence(audit?.(round, revisionIn(prompt)) ?? { verdict: 'approved', artifactRevision: revisionIn(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') {
      evidence.push(prompt)
      return fence(confirm
        ? { satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revisionIn(prompt) }
        : { satisfied: false, criteria: [{ id: 'AC1', met: false, unmet: 'missing-work', evidence: 'the suite does not cover it' }], revision: revisionIn(prompt) })
    }
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  const file = path.join(f.configRoot, 'playbooks/implementation.yaml')
  if (minimumVerification) await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('minimumVerification: review-only', `minimumVerification: ${minimumVerification}`))
  await fs.appendFile(file, `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: 0\n    commands:\n${FLAKY}`)
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: deliveryProvider ?? f.delivery, runOptions
  })
  await engine.drive()
  const asking = { failures: ['flaky'], reason: REASON, revision: engine.run.revisions.at(-1).fingerprint, actor: 'alice' }
  const count = (id) => prompts.filter((p) => p === id).length
  return { engine, f, prompts, evidence, asking, count, done: () => releaseOwnership(engine, { reason: 'test' }).catch(() => {}) }
}

const refusedWith = (engine, args) => engine.acceptCheckResult(args).then(() => null, (e) => ({ status: e.status, message: e.message }))
const down = { deliver: async () => { throw new Error('the provider fell over') } }

/**
 * A closure record whose only unmet condition is the checks, with a met confirmation:
 * the record the action commits on at once. A failed check does not normally reach
 * the confirmation, so this one is shaped from a real run that got it.
 */
async function confirmedAtClosure () {
  const s = await stopped({ deliveryProvider: down })
  const { engine, f, asking } = s
  await engine.acceptCheckResult(asking)
  await engine.drive()
  delete engine.run.closure.acceptedCheckRisk
  engine.run.closure.conditions = { ...engine.run.closure.conditions, checksSatisfied: false }
  engine.run.blockedReason = 'closure-conditions-unmet'
  engine.run.delivery = null
  engine.deliveryProvider = f.delivery
  return s
}

const held = { status: 'blocked', blockedReason: 'rounds-exhausted', integrity: { status: 'clear' }, workspace: { path: '/w', state: 'retained', baseCommit: 'b' },
  participants: { 'auditor-1': {} }, approvals: [{ role: 'auditor-1', revision: 'r1' }], revisions: [{ fingerprint: 'r1' }] }
const failedCommand = { id: 'c', required: true, passed: false, exitCode: 1 }
const withCheck = (check, extra = {}) => ({ ...held, checkResults: [{ revision: 'r1', ...check }], ...extra })
const identify = (check) => identifyCheckFailures(check, { workspace: { baseCommit: 'b' } })
const compared = (extra) => ({ result: 'failed', commands: [failedCommand], baselineComparison: { failures: { verdict: 'new-failures', newFailures: [], notRun: [], ...extra } } })

export default async function (t) {
  t.section('accepting on a stop with no confirmation: asked first, committed only once it is met, then delivered')
  {
    const { engine, f, asking, count, evidence, done } = await stopped()
    t.eq('stopped by the check alone', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked checks-failed-unchanged')
    t.eq('no confirmation was asked for yet', count('confirm'), 0)
    t.eq('the action is listed', supportedActions(engine.run), ['continue', 'refresh-checks', 'accept-check-result', 'start-new'])
    t.eq('the view names what it must name', acceptableCheck(engine.run).failures.map((x) => x.key), ['flaky'])
    const implementTurns = count('implement')
    const revisions = engine.run.revisions.length

    const decision = await engine.acceptCheckResult(asking)
    t.eq('the first answer accepts nothing', [decision.kind, decision.accepted, decision.awaiting], ['check-acceptance-requested', false, 'coordinator-confirmation'])
    t.ok('no record on the closure while it is only asked', !engine.run.closure?.acceptedCheckRisk)
    t.eq('the decision is a step', engine.run.steps.at(-1).decision.key, 'implement-review:accept-check')
    t.ok('the words say nothing is accepted yet', /Nothing is accepted yet/.test(explainRun(engine.run).detail ?? ''), explainRun(engine.run).detail)

    await engine.drive()
    t.eq('completed', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('exactly one confirmation turn', count('confirm'), 1)
    t.eq('no author round', count('implement'), implementTurns)
    t.eq('no new revision', engine.run.revisions.length, revisions)
    t.ok('the confirmation was told what is asked', /acceptanceRequest/.test(evidence[0]) && /Nothing is accepted unless this confirmation is met/.test(evidence[0]))

    const risk = engine.run.closure.acceptedCheckRisk
    t.eq('the closure records the failures', risk.failures.map((x) => x.key), ['flaky'])
    t.eq('and the reason and who', [risk.reason, risk.by, risk.authority], [REASON, 'alice', 'operator'])
    t.eq('bound to the revision', risk.revision, asking.revision)
    t.eq('the request is gone', engine.run.checkAcceptanceRequest, undefined)
    t.eq('an accepted run does not read as verified', engine.run.closure.verificationLevel, 'review-only')
    t.eq('the check stays what ran', engine.run.closure.checks.gating, 'failed')
    t.eq('delivered through the provider, once', f.delivery.calls.length, 1)
    t.eq('with the fingerprint revalidated', engine.run.delivery.revalidated, true)

    const result = runResult(engine.run, {})
    t.eq('the result is the delivery', result.result, 'artifact-ready')
    t.ok('the result names the failure, who and why', /flaky/.test(result.resultLabel) && /alice/.test(result.resultLabel) && result.resultLabel.includes(REASON), result.resultLabel)
    const said = explainRun(engine.run)
    t.ok('the explanation names the failure, who and why', /flaky/.test(said.detail) && /alice/.test(said.detail) && said.detail.includes(REASON), said.detail)
    t.ok('the explanation says it is accepted and unverified', /with accepted check failures/.test(said.headline) && /not verified/.test(said.detail), JSON.stringify(said))
    const md = renderResult(engine.run, {})
    t.ok('result.md has the section', /## Accepted check failures/.test(md) && /`flaky`/.test(md) && md.includes(REASON), md)
    await done()
  }

  t.section('an earlier round of the accepted revision awaited the check: the acceptance still reaches the confirmation')
  {
    // The shape of a run of 2026-11-07: the audit of the last revision's first round held only a finding awaiting the
    // drive, the drive failed, two unchanged answers were approved, and the loop stopped. Reading the accepted
    // revision's check as passed must not make replay ask that first round for the re-review a passing drive gets.
    const awaiting = (round, revision) => round === 0
      ? { verdict: 'changes-needed', artifactRevision: revision, priorFindings: [], findings: [{ id: 'f-await', severity: 'minor', blocking: true, awaitsCheck: true, description: 'only the drive can show it', criterion: 'AC1', location: 'work.txt:1' }] }
      : null
    const { engine, f, asking, count, done } = await stopped({ audit: awaiting })
    t.eq('stopped by the check alone, after the awaiting round', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked checks-failed-unchanged')
    t.eq('three audit rounds on one revision', [count('audit-implement-1'), engine.run.revisions.every((r) => r.fingerprint === asking.revision)], [3, true])
    const audits = count('audit-implement-1')
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('not refused', (engine.run.checkAcceptanceRefusals ?? []).map((r) => r.because), [])
    t.eq('no audit turn was planned', count('audit-implement-1'), audits)
    t.eq('one confirmation', count('confirm'), 1)
    t.eq('completed', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('the acceptance is on the closure', engine.run.closure?.acceptedCheckRisk?.failures.map((x) => x.key), ['flaky'])
    t.eq('delivered once', f.delivery.calls.length, 1)
    await done()
  }

  t.section('declined: no acceptance, no delivery, no author round; a repeat is refused')
  {
    const { engine, f, asking, count, done } = await stopped({ confirm: false })
    const implementTurns = count('implement')
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('blocked at closure', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked closure-conditions-unmet')
    t.eq('nothing on the closure', engine.run.closure.acceptedCheckRisk, undefined)
    t.eq('both conditions are unmet', [engine.run.closure.conditions.checksSatisfied, engine.run.closure.conditions.coordinatorConfirmation], [false, false])
    t.eq('the refusal is on the record', engine.run.checkAcceptanceRefusals.map((r) => r.criteria.map((c) => c.id)), [['AC1']])
    t.eq('nothing was delivered', f.delivery.calls.length, 0)
    t.eq('the author got no round', count('implement'), implementTurns)
    t.eq('no automatic return', engine.run.closureReturns, undefined)
    const result = runResult(engine.run, {})
    t.eq('the result is incomplete', result.result, 'incomplete')
    t.ok('and says it was not accepted', /not accepted/.test(result.resultLabel), result.resultLabel)
    t.eq('with no accepted risk', result.acceptedCheckRisk, undefined)
    const said = explainRun(engine.run)
    t.ok('the explanation names the criterion, not an acceptance', /not accepted/.test(said.headline) && /AC1/.test(said.detail) && /nothing was accepted or delivered/.test(said.detail), JSON.stringify(said))
    t.ok('the action is no longer listed', !supportedActions(engine.run).includes('accept-check-result'))
    const steps = engine.run.steps.length
    const again = await refusedWith(engine, asking)
    t.eq('a repeat is a 409', again?.status, 409)
    t.ok('naming the other condition', /coordinatorConfirmation/.test(again?.message ?? ''), again?.message)
    t.eq('and records nothing', engine.run.steps.length, steps)
    await done()
  }

  t.section('refusals: what must be named, and what must hold (nothing is recorded)')
  {
    const { engine, asking, done } = await stopped()
    const steps = engine.run.steps.length
    t.eq('no failures named', (await refusedWith(engine, { ...asking, failures: undefined }))?.status, 400)
    t.eq('an empty list', (await refusedWith(engine, { ...asking, failures: [] }))?.status, 400)
    t.eq('a blank name', (await refusedWith(engine, { ...asking, failures: [' '] }))?.status, 400)
    t.eq('no reason', (await refusedWith(engine, { ...asking, reason: undefined }))?.status, 400)
    t.eq('a blank reason', (await refusedWith(engine, { ...asking, reason: '  ' }))?.status, 400)
    t.eq('no revision', (await refusedWith(engine, { ...asking, revision: undefined }))?.status, 400)
    t.eq('another revision', (await refusedWith(engine, { ...asking, revision: 'sha256:other' }))?.status, 409)
    const extra = await refusedWith(engine, { ...asking, failures: ['flaky', 'not-a-failure'] })
    t.eq('a name that is not a failure of this check', extra?.status, 409)
    t.ok('and the refusal says which', /not-a-failure/.test(extra?.message ?? ''), extra?.message)

    const check = engine.run.checkResults.at(-1)
    const commands = check.commands
    check.commands = [...commands, { id: 'other', required: true, passed: false, exitCode: 1 }]
    const partial = await refusedWith(engine, asking)
    t.eq('a failure left out', partial?.status, 409)
    t.ok('and the refusal says which', /Not named: other/.test(partial?.message ?? ''), partial?.message)
    check.commands = commands

    const approvals = engine.run.approvals
    engine.run.approvals = []
    const unapproved = await refusedWith(engine, asking)
    t.eq('reviewers did not approve (AC5)', unapproved?.status, 409)
    t.ok('and says so', /reviewers did not approve/.test(unapproved?.message ?? ''), unapproved?.message)
    t.ok('and it is not listed', !supportedActions(engine.run).includes('accept-check-result'))
    engine.run.approvals = approvals

    engine.run.outstandingFindings = [{ id: 'f1', blocking: true }]
    t.ok('a blocking finding refuses (AC1)', /f1/.test((await refusedWith(engine, asking))?.message ?? ''))
    engine.run.outstandingFindings = []

    engine.run.landed = { by: 'someone' }
    t.ok('a landed run refuses', /landed/.test((await refusedWith(engine, asking))?.message ?? ''))
    delete engine.run.landed

    const results = engine.run.checkResults
    engine.run.checkResults = [{ ...check, result: 'unavailable', error: 'no route', baselineComparison: null }]
    const unavailable = await refusedWith(engine, asking)
    t.eq('an unavailable check is not identified (AC6)', unavailable?.status, 409)
    t.ok('and says so', /not identified/.test(unavailable?.message ?? ''), unavailable?.message)
    engine.run.checkResults = [{ ...check, tier: 'smoke' }]
    t.ok('a smoke result alone is not identified', /not identified/.test((await refusedWith(engine, asking))?.message ?? ''))
    engine.run.checkResults = results

    t.eq('none of that recorded a step', engine.run.steps.length, steps)
    t.eq('or a request', engine.run.checkAcceptanceRequest, undefined)
    await done()
  }

  t.section('the gate on a closure record: only the checks may be unmet')
  {
    const closureRun = (conditions, extra = {}) => withCheck({ result: 'failed', commands: [failedCommand] }, { blockedReason: 'closure-conditions-unmet',
      closure: { revision: 'r1', drifted: false, conditions: { sameRevisionApproval: true, checksSatisfied: false, noOutstandingBlockingFindings: true, coordinatorConfirmation: true, deliveryCompleted: false, ...conditions } }, ...extra })
    t.eq('checks only: admitted', acceptCheckUnavailable(closureRun({})), null)
    t.ok('a false confirmation refuses', /coordinatorConfirmation/.test(acceptCheckUnavailable(closureRun({ coordinatorConfirmation: false })) ?? ''))
    t.ok('checks satisfied: not what stopped it', /not what stopped/.test(acceptCheckUnavailable(closureRun({ checksSatisfied: true })) ?? ''))
    t.ok('a record of another revision refuses', /does not describe/.test(acceptCheckUnavailable(closureRun({}, { revisions: [{ fingerprint: 'r2' }], approvals: [{ role: 'auditor-1', revision: 'r2' }], checkResults: [{ revision: 'r2', result: 'failed', commands: [failedCommand] }] })) ?? ''))
    t.ok('a release run refuses', Boolean(acceptCheckUnavailable(closureRun({}, { release: {} }))))
    t.ok('another stop refuses', Boolean(acceptCheckUnavailable(withCheck({ result: 'failed', commands: [failedCommand] }, { blockedReason: 'budget-exhausted' }))))
    t.ok('no auditor refuses', /reviewers did not approve/.test(acceptCheckUnavailable(withCheck({ result: 'failed', commands: [failedCommand] }, { participants: {} })) ?? ''))
  }

  t.section('what "identified" means (AC6)')
  {
    const keys = (r) => r.failures.map((f) => f.key)
    t.ok('no full result', identify(null).unidentified.length === 1)
    t.ok('unavailable', /did not complete/.test(identify({ result: 'unavailable' }).unidentified[0]))
    t.ok('a pass has nothing to accept', /passes the gate/.test(identify({ result: 'passed', commands: [] }).unidentified[0]))
    t.ok('failed with no command', identify({ result: 'failed', commands: [] }).unidentified.length === 1)
    const test = identify(compared({ newFailures: [{ command: 'c', test: 't', message: 'm' }] }))
    t.eq('a new test failure', [keys(test), test.failures[0].level, test.failures[0].basis, test.unidentified], [['c: t'], 'test', 'new', []])
    const whole = identify(compared({ newFailures: [{ command: 'c', test: '(command)', message: 'passes on the base' }] }))
    t.eq('a whole command', [keys(whole), whole.failures[0].level], [['c'], 'command'])
    const suite = identify(compared({ newFailures: [{ command: 'c', test: 'worker/(suite)' }] }))
    t.eq('a suite-level entry counts as command level', [keys(suite), suite.failures[0].level], [['c: worker/(suite)'], 'command'])
    t.eq('comparison not made: the command', keys(identify({ result: 'failed', commands: [failedCommand], baselineComparison: { failures: { verdict: 'not-made', reason: 'x', newFailures: [], notRun: [] } } })), ['c'])
    t.eq('no comparison: the command', keys(identify({ result: 'failed', commands: [{ ...failedCommand, timedOut: true }] })), ['c'])
    t.eq('known only on another source revision: the command', keys(identify({ result: 'failed', commands: [failedCommand], baselineComparison: { failures: { verdict: 'baseline-known', sourceRevision: 'older' } } })), ['c'])
    const selftest = (s, base = { result: 'passed', commands: [] }) => identify({ ...base, baselineComparison: { selftest: s } })
    t.eq('a new selftest failure', keys(selftest({ verdict: 'new-failures', newFailures: [{ command: 'r', test: 'a/b' }] })), ['r: a/b'])
    const unjudged = selftest({ verdict: 'not-made', reason: 'base unfinished', baseUnfinished: true, unjudged: [{ command: 'r', test: 'a/b' }] })
    t.eq('not judged, report readable', [keys(unjudged), unjudged.failures[0].basis, unjudged.unidentified], [['r: a/b'], 'unjudged', []])
    t.ok('report unreadable', /could not be read/.test(selftest({ verdict: 'not-made', reason: 'x', unread: [{ command: 'r', reason: 'its output could not be read' }] }).unidentified[0]))
    t.ok('a not-made record written before unjudged existed', /comparison not made/.test(selftest({ verdict: 'not-made', reason: 'x' }).unidentified[0]))
    t.ok('unread hidden behind a new failure still refuses', selftest({ verdict: 'new-failures', newFailures: [{ command: 'r', test: 'a' }], unread: [{ command: 's', reason: 'no JSON report' }] }).unidentified.length === 1)
    const skippedReport = identify({ result: 'failed', commands: [failedCommand], skipped: [{ id: 'r', required: true, reason: 'an earlier required command failed' }], baselineComparison: { selftest: { verdict: 'not-made', reason: 'x', unread: [{ command: 'r', reason: 'did not run', notRun: true }] } } })
    t.eq('a report skipped after a named failure', [keys(skippedReport), skippedReport.notRun, skippedReport.unidentified], [['c'], ['r'], []])
    const skipped = identify({ ...compared({ newFailures: [{ command: 'c', test: 't' }], notRun: ['later'] }), skipped: [{ id: 'later', required: true, reason: 'an earlier required command failed' }] })
    t.eq('a command a named failure kept from running', [skipped.notRun, skipped.unidentified], [['later'], []])
    t.ok('a required command nothing explains', /did not run/.test(identify(compared({ newFailures: [{ command: 'c', test: 't' }], notRun: ['later'] })).unidentified[0]))
  }

  t.section('the supervisor: what it may accept is the action\'s, not its own judgement (AC2)')
  {
    const test = (key) => ({ key, level: 'test', basis: 'new' })
    const review = { minimumVerification: 'review-only' }
    t.eq('named new test failures on a review-only playbook', supervisorAcceptRefusal({ failures: [test('a'), test('b'), test('c')] }, review), null)
    t.ok('the limit', SUPERVISOR_ACCEPT_LIMIT === 3 && /at most 3/.test(supervisorAcceptRefusal({ failures: ['a', 'b', 'c', 'd'].map(test) }, review) ?? ''))
    t.ok('a whole command', /not a whole command/.test(supervisorAcceptRefusal({ failures: [{ key: 'c', level: 'command', basis: 'new' }] }, review) ?? ''))
    t.ok('a failure no comparison judged', /not judged/.test(supervisorAcceptRefusal({ failures: [{ key: 'a', level: 'test', basis: 'unjudged' }] }, review) ?? ''))
    t.ok('something not run', /did not run/.test(supervisorAcceptRefusal({ failures: [test('a')], notRun: ['later'] }, review) ?? ''))
    t.ok('a playbook that closes only on passed checks', /operator/.test(supervisorAcceptRefusal({ failures: [test('a')] }, { minimumVerification: 'verified' }) ?? ''))

    // The real run's failure is a whole command: the engine refuses the supervisor and admits an operator.
    const { engine, asking, done } = await stopped()
    const steps = engine.run.steps.length
    const beyond = await refusedWith(engine, { ...asking, actor: 'supervisor', authority: 'supervisor' })
    t.eq('the engine enforces it', beyond?.status, 403)
    t.eq('recording nothing', engine.run.steps.length, steps)
    await done()

    const action = { type: 'accept_check_result_run', project: 'p', issueId: 'a', runId: 'r', revision: 'sha256:x', failures: ['c: t'], reason: 'unrelated' }
    const parse = (a) => parseSupervisorResponse(JSON.stringify({ message: 'ok', action: a }))
    t.eq('the vocabulary parses it', parse(action).action.failures, ['c: t'])
    for (const [label, bad] of [['no failures', { ...action, failures: undefined }], ['empty failures', { ...action, failures: [] }], ['no reason', { ...action, reason: undefined }], ['no revision', { ...action, revision: undefined }], ['an extra field', { ...action, authority: 'operator' }]]) {
      let threw = false
      try { parse(bad) } catch { threw = true }
      t.ok(`the vocabulary refuses ${label}`, threw)
    }
    const source = await fs.readFile(new URL('../server/top-supervisor.mjs', import.meta.url), 'utf8')
    const described = source.slice(source.indexOf('accept_check_result_run {'), source.indexOf('reconcile_delivery_run {project'))
    t.ok('its description states what it may accept', /only named test failures/.test(described) && /at most 3/.test(described) && /review-only/.test(described))
    t.ok('and what it may not', /never accept a whole command/.test(described) && /ask_operator/.test(described))

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-accept-check-'))
    const events = []
    const called = []
    let step = 0
    const plan = [
      { ...action, runId: 'r1' },
      { type: 'preview', project: 'p', issueId: 'a', playbook: 'x' },
      (e) => ({ type: 'start_run', project: 'p', issueId: 'a', previewId: e.result.previewId }),
      { ...action, runId: 'r1' }
    ]
    const models = async () => [{ id: 'test-model', title: 'Test model', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
    const adapter = { invoke: async (args) => {
      const event = JSON.parse(args.prompt).event
      events.push(event)
      const next = event.type === 'user' || event.result !== undefined || event.error !== undefined ? plan[step++] : null
      const a = typeof next === 'function' ? next(event) : next ?? null
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: a }), usage: { costUsd: 0 } }
    } }
    const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
      listIssues: async () => [{ id: 'a' }], getIssue: async () => ({ name: 'x' }),
      preview: async () => ({ ok: true, configHash: 'h' }),
      start: async () => ({ runId: 'r1', status: 'blocked' }),
      getRun: async () => ({ runId: 'r1', status: 'blocked' }),
      acceptCheckResult: async (a) => { called.push(a); return { runId: 'r1', status: 'pending', decision: { accepted: false } } },
      stop: async () => {}, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
    const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
    await agent.start({ model: 'test-model', projects: ['p'], message: 'go', limits: { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    const end = Date.now() + 8000
    while (!(step >= plan.length && events.length > plan.length) && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    await agent.stop()
    t.ok('it cannot accept on a run it does not own', events.some((e) => /only on runs it owns/.test(e.result?.error ?? '')), JSON.stringify(events.map((e) => e.result)))
    t.eq('on one it owns, the tool is called once', called.length, 1)
    t.eq('under its own name and authority', [called[0]?.actor, called[0]?.authority], ['supervisor', 'supervisor'])
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('delivery is the normal one: refused or unverifiable leaves the run blocked and not delivered (AC4)')
  {
    const { engine, f, asking, done } = await stopped({ deliveryProvider: down })
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('a failed delivery blocks as it would', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked delivery-failed')
    t.eq('the record is on the closure', engine.run.closure.acceptedCheckRisk?.failures.map((x) => x.key), ['flaky'])
    t.eq('delivery did not complete', engine.run.closure.conditions.deliveryCompleted, false)
    const result = runResult(engine.run, {})
    t.eq('it does not read as delivered', result.result, 'incomplete')
    t.ok('and says so, with the risk', /Not delivered/.test(result.resultLabel) && /flaky/.test(result.resultLabel), result.resultLabel)
    t.ok('the explanation keeps the risk', explainRun(engine.run).detail.includes(REASON) && !/with accepted check failures/.test(explainRun(engine.run).headline))
    engine.deliveryProvider = f.delivery
    await engine.finalize()
    t.eq('finalize delivers once the cause is gone', engine.run.status, 'completed')
    t.eq('and the record survives it', engine.run.closure.acceptedCheckRisk?.reason, REASON)
    await done()
  }
  {
    const unverified = { deliver: async () => ({ artifactRef: 'artifacts/x.patch', reconstruction: { verified: false, detail: 'does not rebuild' } }) }
    const { engine, asking, done } = await stopped({ deliveryProvider: unverified })
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('an unverifiable delivery blocks as it would', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked delivery-unverifiable')
    t.eq('and is not delivered', runResult(engine.run, {}).result, 'incomplete')
    t.ok('the record stays', Boolean(engine.run.closure.acceptedCheckRisk))
    await done()
  }

  t.section('committed at the action: on the closure at once, through a budget stop')
  {
    const { engine, f, asking, count, done } = await confirmedAtClosure()
    t.eq('the record is listed as acceptable', supportedActions(engine.run).includes('accept-check-result'), true)
    const turns = count('confirm')
    const decision = await engine.acceptCheckResult(asking)
    t.eq('accepted', [decision.kind, decision.accepted], ['check-accepted', true])
    t.eq('on the closure from that moment', engine.run.closure.acceptedCheckRisk?.by, 'alice')
    const spent = engine.run.steps.filter((s) => s.role !== 'operator').length
    engine.run.budgets.limits = { ...engine.run.budgets.limits, maxSteps: spent }
    await engine.drive()
    t.eq('a budget stop', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked budget-exhausted')
    t.eq('the record is still on the closure', engine.run.closure.acceptedCheckRisk?.failures.map((x) => x.key), ['flaky'])
    t.ok('the explanation reads it there', explainRun(engine.run).detail.includes(REASON), explainRun(engine.run).detail)
    await engine.resumeExecution({ budgets: { maxSteps: spent + 20 }, actor: 'alice', origin: 'test' })
    await engine.drive()
    t.eq('resume delivers', engine.run.status, 'completed', engine.run.blockedReason)
    t.eq('with no second confirmation', count('confirm'), turns)
    t.eq('delivered', f.delivery.calls.length, 1)
    t.eq('the record survives', engine.run.closure.acceptedCheckRisk?.reason, REASON)
    await done()
  }

  t.section('asked, then a budget stop: nothing accepted, and resume carries on')
  {
    const { engine, f, asking, done } = await stopped()
    const spent = engine.run.steps.filter((s) => s.role !== 'operator').length
    engine.run.budgets.limits = { ...engine.run.budgets.limits, maxSteps: spent }
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('a budget stop', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked budget-exhausted')
    t.ok('no accepted record', !engine.run.closure?.acceptedCheckRisk)
    t.eq('the request stands', engine.run.checkAcceptanceRequest?.by, 'alice')
    t.ok('the words say not accepted', /Nothing is accepted yet/.test(explainRun(engine.run).detail ?? ''), explainRun(engine.run).detail)
    t.eq('the result has no accepted risk', runResult(engine.run, {}).acceptedCheckRisk, undefined)
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    await engine.resumeExecution({ budgets: { maxSteps: spent + 20 }, actor: 'alice', origin: 'test' })
    await engine.drive()
    t.eq('resume completes it', engine.run.status, 'completed', engine.run.blockedReason)
    t.eq('committed then', engine.run.closure.acceptedCheckRisk?.by, 'alice')
    await done()
  }

  t.section('the guard: a replay that wants anything but the confirmation refuses the request')
  {
    const { engine, f, asking, count, done } = await stopped()
    const implementTurns = count('implement')
    const audits = count('audit-implement-1')
    // As if the audits of this revision no longer stood: replay would ask for one.
    engine.run.supersededSteps = [...(engine.run.supersededSteps ?? []), ...engine.run.steps.filter((s) => s.stepId.startsWith('audit-implement')).map((s) => s.number)]
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('back where it stopped', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked checks-failed-unchanged')
    t.ok('the refusal says why', /replay needs/.test(engine.run.checkAcceptanceRefusals?.at(-1)?.because ?? ''), JSON.stringify(engine.run.checkAcceptanceRefusals))
    t.eq('no request left', engine.run.checkAcceptanceRequest, undefined)
    t.eq('no turn ran', [count('implement'), count('audit-implement-1'), count('confirm')], [implementTurns, audits, 0])
    t.eq('nothing accepted or delivered', [engine.run.closure?.acceptedCheckRisk, f.delivery.calls.length], [undefined, 0])
    await done()
  }

  t.section('withdrawn: Continue, Refresh checks, a check that now passes')
  {
    const { engine, asking, done } = await confirmedAtClosure()
    await engine.acceptCheckResult(asking)
    engine.run.status = 'blocked'
    engine.run.blockedReason = 'closure-conditions-unmet'
    engine.run.endedAt = engine.clock.iso()
    await engine.continueRun({ text: 'once more', actor: 'alice' })
    t.eq('Continue clears the closure', engine.run.closure, null)
    t.eq('and keeps it in the history', engine.run.checkAcceptanceHistory?.map((a) => [a.by, a.withdrawnBecause]), [['alice', 'continue']])
    await done()
  }
  {
    const { engine, asking, done } = await confirmedAtClosure()
    await engine.acceptCheckResult(asking)
    engine.run.status = 'blocked'
    engine.run.blockedReason = 'closure-conditions-unmet'
    engine.run.endedAt = engine.clock.iso()
    await engine.refreshClosureChecks({ kind: 'local', commands: [{ id: 'flaky', run: 'true' }] })
    t.eq('Refresh checks clears the closure', engine.run.closure, null)
    t.eq('and keeps it in the history', engine.run.checkAcceptanceHistory?.map((a) => a.withdrawnBecause), ['refresh-checks'])
    await done()
  }
  {
    const { engine, asking, done } = await confirmedAtClosure()
    await engine.acceptCheckResult(asking)
    const check = engine.run.checkResults.at(-1)
    check.result = 'passed'
    check.commands = check.commands.map((c) => ({ ...c, passed: true, exitCode: 0 }))
    check.baselineComparison = null
    await engine.drive()
    t.eq('the run closes on the pass', engine.run.status, 'completed', engine.run.blockedReason)
    t.eq('claiming no risk it did not take', engine.run.closure.acceptedCheckRisk, undefined)
    t.eq('verified', engine.run.closure.verificationLevel, 'verified')
    t.ok('the history says why', /now passes/.test(engine.run.checkAcceptanceHistory?.at(-1)?.withdrawnBecause ?? ''))
    t.eq('the result states no risk', runResult(engine.run, {}).acceptedCheckRisk, undefined)
    await done()
  }

  t.section('a playbook that closes only on passed checks: an operator\'s acceptance is the authority, and it stays unverified')
  {
    const { engine, asking, done } = await stopped({ minimumVerification: 'verified' })
    t.eq('stopped by the check', engine.run.blockedReason, 'checks-failed-unchanged')
    await engine.acceptCheckResult(asking)
    await engine.drive()
    t.eq('completed', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('authorised, review-only', [engine.run.closure.authorised, engine.run.closure.verificationLevel], [true, 'review-only'])
    await done()
  }

  await cleanupFixtures()
}
