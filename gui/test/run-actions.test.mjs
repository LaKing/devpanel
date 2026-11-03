import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseOwnership } from '../server/runtime/launch.mjs'
import { acceptCheckUnavailable, continueUnavailable, integrateUnavailable, refreshChecksUnavailable, refreshFacts, resumeUnavailable, retryInputUnavailable } from '../server/runtime/run-control.mjs'
import { reconcileUnavailable } from '../server/runtime/source-reconcile.mjs'
import { getRun } from '../server/runs-api.mjs'
import { summarisePackedRun, summariseRun } from '../server/supervisor-summary.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'run actions: the list comes from the functions that admit them'

const REFRESH = { tactic: true, target: true }
const held = { integrity: { status: 'clear' }, workspace: { path: '/w', state: 'retained' }, participants: {}, revisions: [{ fingerprint: 'r1' }] }
const blockedAt = (blockedReason, extra = {}) => ({ ...held, status: 'blocked', blockedReason, ...extra })
const approvedFailedCheck = { participants: { 'auditor-1': {} }, approvals: [{ role: 'auditor-1', revision: 'r1' }], checkResults: [{ revision: 'r1', result: 'failed' }] }
const namedFailure = { revision: 'r1', result: 'failed', commands: [{ id: 'c', required: true, passed: false, exitCode: 1 }] }
const tooLarge = { status: 'failed', failures: [{ evidence: 'input_too_large', at: '2026-11-01T00:00:00.000Z' }] }
const committed = { action: 'commit', completedAt: 't', commit: 'c', reconstruction: { verified: true } }

const RECORDS = [
  // The issue's run: only resume applies here (Continue admits closure stops, not exhausted rounds).
  ['rounds exhausted, reviewers not agreed', blockedAt('rounds-exhausted'), REFRESH, ['resume', 'start-new']],
  ['rounds exhausted, checks the only stop', blockedAt('rounds-exhausted', approvedFailedCheck), REFRESH, ['refresh-checks', 'resume', 'start-new']],
  ['rounds exhausted, a named check failure', blockedAt('rounds-exhausted', { ...approvedFailedCheck, checkResults: [namedFailure] }), REFRESH, ['refresh-checks', 'accept-check-result', 'resume', 'start-new']],
  ['an unchanged answer to a named check failure', blockedAt('checks-failed-unchanged', { ...approvedFailedCheck, checkResults: [namedFailure] }), REFRESH, ['continue', 'refresh-checks', 'accept-check-result', 'start-new']],
  ['closure unmet', blockedAt('closure-conditions-unmet'), REFRESH, ['continue', 'refresh-checks', 'start-new']],
  ['closure unmet with no revision to check', blockedAt('closure-conditions-unmet', { revisions: [] }), REFRESH, ['start-new']],
  ['closure unmet, a turn still in question', blockedAt('closure-conditions-unmet', { participants: { author: { pendingInvocation: {} } } }), REFRESH, ['abandon']],
  ['closure unmet, recovery required', blockedAt('closure-conditions-unmet', { recovery: { required: true } }), REFRESH, ['abandon']],
  ['closure unmet, no check target', blockedAt('closure-conditions-unmet'), { tactic: true, target: false }, ['continue', 'start-new']],
  ['closure unmet, no tactic', blockedAt('closure-conditions-unmet'), { tactic: false, target: true }, ['continue', 'start-new']],
  ['closure unmet, snapshot unreadable', blockedAt('closure-conditions-unmet'), refreshFacts(null), ['continue', 'start-new']],
  ['closure unmet, workspace removed', blockedAt('closure-conditions-unmet', { workspace: { path: '/w', state: 'removed' } }), REFRESH, ['start-new']],
  ['inconclusive, not approved', blockedAt('checks-inconclusive'), REFRESH, ['continue', 'start-new']],
  ['unchanged answer, not approved', blockedAt('checks-failed-unchanged'), REFRESH, ['continue', 'start-new']],
  ['delivery drifted on its own paths', blockedAt('source-delivery-blocked', { delivery: { action: 'apply-to-source', application: { state: 'source-drift', drifted: ['a'] } } }), REFRESH, ['reconcile-delivery', 'finalize', 'start-new']],
  ['input rejected as too large', { ...held, ...tooLarge }, REFRESH, ['retry-input', 'start-new']],
  ['input rejected, workspace removed', { ...held, ...tooLarge, workspace: { path: '/w', state: 'removed' } }, REFRESH, ['start-new']],
  ['input rejected, no stop time', { ...held, ...tooLarge, failures: [{ evidence: 'input_too_large' }] }, REFRESH, ['start-new']],
  ['committed and verified', { ...held, status: 'completed', delivery: committed }, REFRESH, ['start-new', 'integrate']],
  ['committed, not verified', { ...held, status: 'completed', delivery: { ...committed, reconstruction: { verified: false } } }, REFRESH, ['start-new']],
  ['committed, recovery required', { ...held, status: 'completed', recovery: { required: true }, delivery: committed }, REFRESH, ['start-new']],
  ['already integrated', { ...held, status: 'completed', delivery: committed, integration: { mergeCommit: 'abcdef', targetBranch: 'main' } }, REFRESH, ['start-new']]
]

const roundsExhausted = async () => {
  const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('needs-fix')], [blocking('needs-fix')], []] }) })
  const playbookFile = path.join(f.configRoot, 'playbooks', 'implementation.yaml')
  await fs.writeFile(playbookFile, (await fs.readFile(playbookFile, 'utf8')).replace('budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n'))
  const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
  engine.run.budgets.limits.maxSteps = 100
  await engine.drive()
  return { f, engine }
}

export default async function (t) {
  t.section('a listed action is one its admission function accepts')
  for (const [label, run, refresh, expected] of RECORDS) {
    const listed = supportedActions(run, { refresh })
    t.eq(label, listed, expected)
    const admits = {
      resume: resumeUnavailable(run),
      continue: continueUnavailable(run),
      'refresh-checks': refreshChecksUnavailable(run, refresh),
      'accept-check-result': acceptCheckUnavailable(run, refresh),
      'retry-input': retryInputUnavailable(run),
      'reconcile-delivery': reconcileUnavailable(run),
      integrate: integrateUnavailable(run)
    }
    const refusedButListed = Object.entries(admits).filter(([action, refusal]) => refusal && listed.includes(action)).map(([action]) => action)
    t.eq(`${label}: nothing listed is refused`, refusedButListed, [])
  }

  t.section('a real rounds-exhausted run: the run detail and the supervisor summary say the same, and it is what is admitted')
  {
    const { f, engine } = await roundsExhausted()
    t.eq('the run stopped at the round limit', engine.run.blockedReason, 'rounds-exhausted')
    const detail = await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id })
    t.eq('GET run lists the actions', detail.actions, ['resume', 'start-new'])
    t.eq('its older name is the same list', detail.supportedActions, detail.actions)
    const summary = summariseRun(detail)
    t.eq('the supervisor summary lists them', summary.actions, detail.actions)
    t.eq('under both names', summary.supportedActions, detail.actions)
    const refused = await engine.refreshClosureChecks(null).then(() => null, (error) => error)
    t.eq('refresh-checks, not listed, is refused as a refusal', refused?.status, 409)
    t.ok('the run is untouched', engine.run.status === 'blocked' && engine.run.blockedReason === 'rounds-exhausted')

    // The same engine at a closure stop, with no target anywhere: refused for that reason, not a TypeError.
    engine.run.blockedReason = 'closure-conditions-unmet'
    engine.snapshot.checks = { ...engine.snapshot.checks, target: null }
    const noTarget = await engine.refreshClosureChecks(null).then(() => null, (error) => error)
    t.eq('no check target anywhere: a 409', [noTarget?.status, /configured target/.test(noTarget?.message ?? '')], [409, true])
    engine.run.blockedReason = 'rounds-exhausted'
    await releaseOwnership(engine)
  }

  t.section('a packed issue changes nothing')
  t.eq('its summary lists no action', summarisePackedRun({ runId: 'r', project: 'p', issueId: 'i', record: { status: 'blocked', blockedReason: 'rounds-exhausted' } }).actions, [])
  await cleanupFixtures()
}
