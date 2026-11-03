import fs from 'node:fs/promises'
import path from 'node:path'

import { io as connect } from 'socket.io-client'

import { patch, occupySeat } from './helpers.mjs'

import { LIVE_STATUSES } from '../server/supervisor.mjs'
import { startStage } from './browser/stage.mjs'

export const name = 'run control — start, stop and the states in between'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll rather than guess: the run advances on its own schedule. */
async function until (predicate, { timeout = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(80)
  }
}

export default async function (t) {
  const stage = await startStage({ control: { delayMs: 0 } })
  const { project } = stage
  // An audited implementation run, delivered as a patch: the stage copies the
  // live playbook, whose auditor seats are optional and whose default delivery
  // writes to the project checkout.
  await occupySeat(path.join(stage.configRoot, 'playbooks/implementation.yaml'), '  auditor-1:\n    model: gpt-6-sol')
  await patch(path.join(stage.configRoot, 'playbooks/implementation.yaml'), 'action: apply-to-source', 'action: worktree-diff')
  const runsRoute = (id) => `/api/projects/${project}/issues/${id}/runs`

  /** Settled means the run is no longer claimed by any process. */
  const settledRun = (issueId) => until(async () => {
    const [run] = await stage.runs(issueId)
    const owned = await fs.access(path.join(stage.issuesDir, project, issueId, '.run.lock')).then(() => true, () => false)
    return run && !LIVE_STATUSES.includes(run.status) && !owned ? run : null
  }, { label: 'the run to settle' })

  // ------------------------------------------------- 0. one live run per issue
  t.section('0. two issues of one project run at once; one issue holds one live run')
  {
    await stage.setControl({ delayMs: 1500 })
    const first = await stage.createIssue('First on the project')
    const second = await stage.createIssue('Second on the project')
    const a = await stage.request(runsRoute(first.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('the first starts', a.status, 201)
    const b = await stage.request(runsRoute(second.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('a second issue on the same project starts beside it', b.status, 201, b.body.error)
    const c = await stage.request(runsRoute(first.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('a second start on the same issue is refused', c.status, 409)
    await settledRun(first.id)
    await settledRun(second.id)
    await stage.setControl({ delayMs: 0 })
  }

  // ---------------------------------------------------------------- 1. start
  t.section('1. starting a run returns an id promptly and keeps going without the caller')
  {
    const issue = await stage.createIssue('Start returns promptly')
    const began = Date.now()
    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const elapsed = Date.now() - began

    t.eq('the response is 201', started.status, 201)
    t.ok('with a run id', typeof started.body.runId === 'string' && started.body.runId.length > 0, started.body.runId)
    // The paid probes have not happened yet — that is the point. The run exists,
    // and can be inspected and stopped, before anything is spent on it.
    t.eq('the run starts in preflight', started.body.status, 'preflighting')
    t.ok('the caller does not wait for the probes', elapsed < 3000, `${elapsed}ms`)

    const reserved = await stage.run(issue.id, started.body.runId)
    t.eq('it is durable immediately', reserved.runId, started.body.runId)
    t.eq('and stoppable immediately', reserved.supportedActions, ['pause', 'stop'])

    // Nothing in this test process is driving it: the run lives in the server.
    const settled = await settledRun(issue.id)

    t.eq('it ran to completion on its own', settled.status, 'completed')
    t.ok('and produced steps', settled.steps > 0, `${settled.steps} steps`)
    t.eq('preflight is recorded as passed', settled.preflight.state, 'passed')
    t.ok('with the probes it made', settled.preflight.attempts > 0, `${settled.preflight.attempts} probes`)

    // A person applied the retained patch by hand and says so: an explicit
    // claim on the run, which changes nothing the engine recorded.
    const landedRoute = `${runsRoute(issue.id)}/${started.body.runId}/landed`
    const before = await stage.run(issue.id, started.body.runId)
    t.ok('the run left a patch to land', before.revisions.length > 0 && before.delivery?.action === 'worktree-diff', before.delivery?.action)
    const vague = await stage.request(landedRoute, { method: 'POST', body: JSON.stringify({ applied: 'the patch' }) })
    t.eq('a landing without where it went or what was changed by hand is refused', vague.status, 400)
    const marked = await stage.request(landedRoute, { method: 'POST', body: JSON.stringify({ applied: 'the retained patch', commit: 'abc1234', handChanges: 'none', actor: 'tester' }) })
    t.eq('a landing with its evidence is recorded', marked.status, 200)
    const after = await stage.run(issue.id, started.body.runId)
    t.eq('on the run, with who and where', [after.landed?.by, after.landed?.commit, after.landed?.handChanges], ['tester', 'abc1234', 'none'])
    t.eq('which now reads as delivered by hand', [after.result, after.resultReason], ['delivered', 'manual-landing'])
    t.eq('while outcome, closure and approvals stay as they were', [after.outcome, after.closure, after.approvals], [before.outcome, before.closure, before.approvals])
    t.eq('the explanation says who landed it', after.explanation.headline, 'Landed by hand by tester')
    t.eq('and a second claim is refused', (await stage.request(landedRoute, { method: 'POST', body: JSON.stringify({ applied: 'again', checkout: '/opt/x', handChanges: 'none' }) })).status, 409)
  }

  // ------------------------------------------------------------ 2. duplicates
  t.section('2. one run per issue')
  {
    const issue = await stage.createIssue('No duplicate runs')
    // Set before the run begins: a turn already in flight is running under the
    // control it read when it started, so a later edit would not reach it.
    await stage.setControl({ delayMs: 1200, hangOnAbortMs: 900 })

    // Sent together, as a double-click would: the guard has to hold when there
    // is no gap between the two requests at all.
    const [first, second] = await Promise.all([
      stage.request(runsRoute(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) }),
      stage.request(runsRoute(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    ])
    const codes = [first.status, second.status].sort()

    t.eq('exactly one is accepted', codes, [201, 409])
    const refused = first.status === 409 ? first : second
    t.ok('and the refusal says why', /already/i.test(refused.body.error), refused.body.error)

    // A third attempt while it is still running is refused the same way.
    const third = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('a later attempt is refused too', third.status, 409)

    const neighbour = await stage.createIssue('Another issue in the same project')
    const overlapping = await stage.request(runsRoute(neighbour.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('a different issue in the same project starts beside it', overlapping.status, 201, overlapping.body.error)
    t.eq('with a run of its own', (await stage.runs(neighbour.id)).length, 1)

    const accepted = first.status === 201 ? first : second
    const runId = accepted.body.runId

    // ------------------------------------------------------------- 3. stopping
    t.section('3. stopping is a state, not an instant')

    // Stop only means anything while a turn is genuinely in flight.
    await until(async () => {
      const run = await stage.run(issue.id, runId)
      return run.active?.length > 0
    }, { label: 'a turn to be in flight' })

    const stopped = await stage.request(`${runsRoute(issue.id)}/${runId}/stop`, { method: 'POST' })
    t.eq('the stop request is accepted', stopped.status, 200)
    t.eq('and answers "stopping", not "stopped"', stopped.body.status, 'stopping')

    const during = await stage.run(issue.id, runId)
    t.eq('the run reports stopping', during.status, 'stopping')
    t.eq('and offers no action while it settles', during.supportedActions, [])

    // Repeated requests are the normal case — an impatient operator clicks again.
    const again = await stage.request(`${runsRoute(issue.id)}/${runId}/stop`, { method: 'POST' })
    t.eq('a repeated stop is harmless', again.status, 200)
    t.eq('and reports the same state', again.body.status, 'stopping')

    const finished = await until(async () => {
      const run = await stage.run(issue.id, runId)
      return run.status !== 'stopping' ? run : null
    }, { label: 'termination to be confirmed' })

    t.eq('it settles as cancelled', finished.status, 'cancelled')
    t.eq('with an unresolved outcome', finished.outcome, 'unresolved')
    t.ok('and an end time', Boolean(finished.endedAt), finished.endedAt)
    t.eq('a cleanly cancelled run can resume or start anew', finished.supportedActions, ['resume', 'start-new'])

    // Stopping something already stopped is not an error either.
    const afterwards = await stage.request(`${runsRoute(issue.id)}/${runId}/stop`, { method: 'POST' })
    t.eq('stopping a finished run is accepted', afterwards.status, 200)
    t.ok('and says it was already stopped', afterwards.body.alreadyStopped === true)
    t.eq('reporting the persisted state', afterwards.body.status, 'cancelled')

    // The lock has to be gone, or the issue is stuck forever.
    await stage.setControl({ delayMs: 0 })
    const restart = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('and the issue can be started again', restart.status, 201)
    await settledRun(issue.id)
  }

  // ------------------------------------------------------------ 4. bad starts
  t.section('4. a start that cannot happen says so, and keeps the receipt')
  {
    const issue = await stage.createIssue('Failed start')

    const missing = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'no-such-playbook' })
    })
    t.eq('an unknown playbook is rejected outright', missing.status, 422)
    t.ok('naming the playbook', /no-such-playbook/.test(missing.body.error), missing.body.error)
    t.eq('and nothing is recorded for it', (await stage.runs(issue.id)).length, 0)

    const empty = await stage.request(runsRoute(issue.id), { method: 'POST', body: JSON.stringify({}) })
    t.eq('a request with no playbook is rejected', empty.status, 400)

    // The ordinary failure: the runtime is there, but the model is not reachable.
    // It is only discoverable by probing, which costs — so it happens inside a run.
    await stage.setControl({ delayMs: 0, modelAccess: 'unreachable', modelDetail: 'no route to the provider' })
    const accepted = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('a start that will fail preflight is still accepted', accepted.status, 201)
    t.eq('because the refusal is not known yet', accepted.body.status, 'preflighting')

    const refused = await settledRun(issue.id)
    t.eq('and the run settles as failed', refused.status, 'failed')
    t.eq('with the reason', refused.blockedReason, 'preflight-refused')

    const detail = await stage.run(issue.id, refused.runId)
    t.eq('preflight is recorded as refused', detail.preflight.state, 'refused')
    t.ok('the probes it made are kept', detail.preflight.attempts > 0, `${detail.preflight.attempts} probes`)
    t.ok('and so is what they cost', detail.preflight.usage !== null,
      JSON.stringify(detail.preflight.usage))
    t.ok('the refusal names what was not proven',
      /unreachable|model/i.test(detail.preflight.detail ?? detail.preflight.summary ?? ''),
      (detail.preflight.detail ?? '').split('\n')[1] ?? detail.preflight.summary)
    t.ok('and counts its failures as a number, so a real failure stays guarded', detail.preflight.counts?.failures > 0, JSON.stringify(detail.preflight.counts))
    t.eq('no workspace was created for it', detail.workspace.state, 'pending')

    // A failed start must not leave the issue locked.
    await stage.setControl({ delayMs: 0 })
    const retry = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('a retry after the fault is cleared succeeds', retry.status, 201)
    await settledRun(issue.id)
  }

  // ------------------------------------------------- 4b. stopping in preflight
  t.section('4b. a run can be stopped while it is still paying for evidence')
  {
    const issue = await stage.createIssue('Stop during preflight')
    // Slow probes: the window where money is going out and no turn has run yet.
    await stage.setControl({ delayMs: 0, probeDelayMs: 3000 })

    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('it is preflighting', started.body.status, 'preflighting')

    const during = await stage.run(issue.id, started.body.runId)
    t.eq('and Stop is offered during it', during.supportedActions, ['pause', 'stop'])
    t.eq('no turn has run', during.timeline.length, 0)

    const stopped = await stage.request(`${runsRoute(issue.id)}/${started.body.runId}/stop`, { method: 'POST' })
    t.eq('the stop is accepted mid-preflight', stopped.status, 200)
    t.eq('and answers stopping', stopped.body.status, 'stopping')

    const settled = await settledRun(issue.id)
    t.eq('the run settles as cancelled', settled.status, 'cancelled')

    const detail = await stage.run(issue.id, settled.runId)
    t.eq('preflight records that it was cancelled', detail.preflight.state, 'cancelled')
    t.eq('no workspace was ever created', detail.workspace.state, 'pending')
    t.eq('and no agent was invoked', detail.timeline.length, 0)

    // The ledger is shared by the whole stage, so this asks only about this run:
    // every entry carries the run id in its marker.
    const ledger = await fs.readFile(stage.ledger, 'utf8').catch(() => '')
    const mine = ledger.split(String.fromCharCode(10)).filter((l) => l.includes(settled.runId))
    t.eq('the runtime was never asked to work', mine.length, 0)

    await stage.setControl({ delayMs: 0 })
    const again = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('and the issue is free again', again.status, 201)
    await settledRun(issue.id)
  }

  // ------------------------------------------------ 4c. a blocked candidate
  t.section('4c. a blocked run keeps the work it never delivered')
  {
    const strictPlaybook = path.join(stage.configRoot, 'playbooks/implementation.yaml')
    await patch(strictPlaybook, 'minimumVerification: review-only', 'minimumVerification: verified')
    const issue = await stage.createIssue('Blocked candidate')
    // The author actually changes the workspace, as one producing a candidate
    // must: a revision fingerprinted over an untouched tree is not work.
    await stage.setControl({
      delayMs: 0,
      writes: { implement: { file: 'src/candidate.txt', text: 'the implementation' } }
    })

    // This playbook requires verified evidence with no check target that can
    // produce it, so it reaches agreement and then blocks, undelivered.
    await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const settled = await settledRun(issue.id)
    t.eq('the run blocks', settled.status, 'blocked')
    t.eq('short of closing', settled.blockedReason, 'closure-not-authorised')
    await patch(strictPlaybook, 'minimumVerification: verified', 'minimumVerification: review-only')

    const detail = await stage.run(issue.id, settled.runId)
    t.ok('a candidate was produced', detail.revisions.length > 0, `${detail.revisions.length} revision(s)`)
    t.eq('and nothing was delivered', detail.delivery, null)

    t.eq('so the workspace is retained, not removed', detail.workspace.state, 'retained')
    t.ok('and says why', /unsuccessful tactical run retained for recovery/.test(detail.workspace.retainedReason ?? ''),
      detail.workspace.retainedReason)

    // The point of retaining it is that it is still there to look at.
    const worktree = path.join(stage.issuesDir, project, issue.id, 'runs', `worktree-${settled.runId}`)
    const present = await fs.access(worktree).then(() => true, () => false)
    t.ok('the candidate is still on disk', present, worktree)

    // Ownership went back even though the work did not.
    const lockGone = await fs.access(path.join(stage.issuesDir, project, issue.id, '.run.lock'))
      .then(() => false, () => true)
    t.ok('but the issue is not held hostage by it', lockGone)

    const next = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('another run can start', next.status, 201)
    await settledRun(issue.id)
  }

  // ---------------------------------- 4c2. work that exists before any response
  t.section('4c2. an interrupted author keeps what it had already written')
  {
    const issue = await stage.createIssue('Interrupted author')

    // The author writes into the workspace and then hangs. It is stopped before
    // it ever answers, so no response is recorded and no revision is fingerprinted
    // — the work exists only on disk.
    await stage.setControl({
      delayMs: 0,
      delayFor: { implement: 20000 },
      hangOnAbortMs: 300,
      writes: { implement: { file: 'src/half-done.txt', text: 'the author got this far' } }
    })

    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const runId = started.body.runId

    await until(async () => {
      const run = await stage.run(issue.id, runId)
      return run.active?.some((a) => a.stepId === 'implement')
    }, { label: 'the author to be working', timeout: 30000 })

    const worktree = path.join(stage.issuesDir, project, issue.id, 'runs', `worktree-${runId}`)
    const written = path.join(worktree, 'src', 'half-done.txt')
    t.ok('the author has written into the workspace',
      await fs.access(written).then(() => true, () => false), written)

    await stage.request(`${runsRoute(issue.id)}/${runId}/stop`, { method: 'POST' })
    const settled = await settledRun(issue.id)
    t.eq('the interrupted work is blocked for recovery', settled.status, 'blocked')

    const detail = await stage.run(issue.id, settled.runId)
    t.eq('source integrity is explicitly quarantined', detail.integrity.status, 'quarantined')
    t.eq('the failed attempt is attributed to the implementer', detail.integrity.latest.role, 'implementer')
    // This is the whole point: nothing was fingerprinted, because nothing was
    // answered. Reading "no revisions" as "no work" is what loses the file.
    t.eq('no revision was ever recorded', detail.revisions.length, 0)

    t.ok('the file the author wrote is still there',
      await fs.access(written).then(() => true, () => false), written)
    t.eq('and the workspace is retained', detail.workspace.state, 'retained')
    t.ok('for a stated reason', Boolean(detail.workspace.retainedReason), detail.workspace.retainedReason)

    const contents = await fs.readFile(written, 'utf8').catch(() => '')
    t.ok('with its contents intact', contents.includes('the author got this far'), contents.trim())

    await stage.setControl({ delayMs: 0 })
    const next = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('a new run cannot bypass the required disposition', next.status, 409)
  }

  // ---------------------------------- 4c3. a run that changed nothing
  t.section('4c3. an unchanged cancelled workspace is retained for resume')
  {
    const issue = await stage.createIssue('Nothing written')
    // Cancelled during the very first turn: nothing has touched the workspace.
    await stage.setControl({ delayMs: 0, delayFor: { triage: 20000 }, hangOnAbortMs: 200 })

    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const runId = started.body.runId
    await until(async () => (await stage.run(issue.id, runId)).active?.length > 0,
      { label: 'the first turn to be in flight', timeout: 30000 })

    await stage.request(`${runsRoute(issue.id)}/${runId}/stop`, { method: 'POST' })
    const settled = await settledRun(issue.id)

    await until(async () => (await stage.run(issue.id, settled.runId)).workspace.state !== 'active',
      { label: 'workspace cleanup to be recorded' })
    const detail = await stage.run(issue.id, settled.runId)
    t.eq('the workspace is retained for continuation', detail.workspace.state, 'retained')

    const worktree = path.join(stage.issuesDir, project, issue.id, 'runs', `worktree-${runId}`)
    t.ok('and remains on disk', await fs.access(worktree).then(() => true, () => false), worktree)
  }

  // -------------------------------------------- 4d. restart during a turn
  t.section('4d. a server restart during an invocation reports recovery, not silence')
  {
    const issue = await stage.createIssue('Restart mid turn')
    await stage.setControl({ delayMs: 8000, hangOnAbortMs: 0 })

    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const runId = started.body.runId

    // Wait until a turn is genuinely in flight, then take the server away.
    await until(async () => (await stage.run(issue.id, runId)).active?.length > 0,
      { label: 'a turn to be in flight' })

    await stage.restart({ signal: 'SIGKILL' })

    const after = await stage.run(issue.id, runId)
    t.eq('the run is no longer advertised as live', after.status, 'blocked')
    t.eq('it needs recovery', after.blockedReason, 'recovery-required')
    t.ok('and says what happened', /owner|disappear/i.test(after.recovery?.reason ?? ''), after.recovery?.reason)

    // The dangerous outcome is a Stop button on a run nothing can stop. What it
    // offers is reconciliation (recover) or giving it up — never Stop.
    t.eq('interrupted work offers recovery or explicit abandonment', after.supportedActions, ['recover', 'abandon'])
    t.eq('and records that the owner was lost', after.recovery?.ownerLost, true)

    const stopped = await stage.request(`${runsRoute(issue.id)}/${runId}/stop`, { method: 'POST' })
    t.ok('stopping it does not claim it was already stopped',
      stopped.body.alreadyStopped !== true, JSON.stringify(stopped.body).slice(0, 120))
    t.eq('it reports the recovery state instead', stopped.body.status, 'blocked')
    t.ok('and says recovery is what is needed', stopped.body.recoveryRequired === true)

    // Whatever the interrupted turn wrote is left where it was.
    t.ok('the workspace is not deleted behind it',
      ['retained', 'active'].includes(after.workspace.state), after.workspace.state)

    t.eq('interrupted run can be explicitly abandoned', (await stage.request(`${runsRoute(issue.id)}/${runId}/abandon`, { method: 'POST' })).status, 200)
    const abandoned = await stage.run(issue.id, runId)
    t.eq('abandoned run is cancelled', abandoned.status, 'cancelled')
    t.eq('abandoned run allows a fresh start', abandoned.supportedActions, ['start-new'])
    t.eq('recovery has an explicit resolution', abandoned.recovery.resolution, 'abandoned')
    t.eq('candidate remains retained', abandoned.workspace.state, 'retained')

    // And the issue is usable again.
    await stage.setControl({ delayMs: 0 })
    const next = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('a new run can be started', next.status, 201)
    await settledRun(issue.id)
  }

  // ------------------------------------------- 4e. a graceful shutdown
  t.section('4e. a graceful shutdown stops what it was supervising')
  {
    const issue = await stage.createIssue('Graceful shutdown')
    await stage.setControl({ delayMs: 4000, hangOnAbortMs: 200 })

    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const runId = started.body.runId
    await until(async () => (await stage.run(issue.id, runId)).active?.length > 0,
      { label: 'a turn to be in flight' })

    await stage.setControl({ delayMs: 0 })
    await stage.restart({ signal: 'SIGTERM' })

    // shutdown-resume.control.test.mjs covers what the next start does with it.
    const journal = await fs.readFile(path.join(stage.issuesDir, project, issue.id, 'runs', runId, 'events.jsonl'), 'utf8')
    t.ok('the run settled as a stop rather than a mystery', journal.includes('"type":"cancelled"'))
    await settledRun(issue.id)
    t.eq('the next start resumed it', (await stage.run(issue.id, runId)).resumeHistory.at(-1).actor, 'service')

    const next = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('and the issue is free', next.status, 201)
    await settledRun(issue.id)
  }

  // ------------------------------------------------------- 4f. the agent list
  t.section('4f. every agent currently invoked, across every project')
  {
    t.eq('nothing is running to begin with', (await stage.request('/api/agents')).body.length, 0)

    const unauth = await fetch(`${stage.origin}/api/agents`)
    t.eq('the list needs the token', unauth.status, 401)

    const issue = await stage.createIssue('Visible while working')
    await stage.setControl({ delayMs: 4000 })
    const started = await stage.request(runsRoute(issue.id), {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })

    // Preflight is part of the run's life, so it is listed — but with nothing
    // invoked, because nothing has been.
    const duringPreflight = (await stage.request('/api/agents')).body
    if (duringPreflight[0]?.status === 'preflighting') {
      t.eq('a preflighting run is listed', duringPreflight.length, 1)
      t.eq('with no agent invoked yet', duringPreflight[0].agents.length, 0)
    }

    const live = await until(async () => {
      const { body } = await stage.request('/api/agents')
      return body[0]?.agents?.length ? body : null
    }, { label: 'an agent to be invoked', timeout: 30000 })

    const run = live[0]
    t.eq('the run is listed once', live.length, 1)
    t.eq('against its issue', run.issueName, 'Visible while working')
    t.eq('and its project', run.project, project)
    t.eq('with the run id, so it can be opened', run.runId, started.body.runId)
    t.eq('and the playbook driving it', run.playbook.id, 'implementation')

    const agent = run.agents[0]
    t.eq('the agent names its role', agent.role, 'coordinator')
    t.ok('the roster model', Boolean(agent.model), agent.model)
    t.ok('and the model actually sent to the runtime', Boolean(agent.wireModel), agent.wireModel)
    t.ok('the runtime it went through', Boolean(agent.harness), agent.harness)
    t.ok('what it is working on', Boolean(agent.stepId), agent.stepId)
    t.ok('when the turn was asked', Boolean(agent.startedAt), agent.startedAt)
    t.ok('and the invocation it belongs to', Boolean(agent.invocationId))
    t.eq('this server says it is the one driving it', run.ownership, 'this-process')

    await stage.request(`${runsRoute(issue.id)}/${started.body.runId}/stop`, { method: 'POST' })
    await settledRun(issue.id)
    t.eq('a settled run leaves the list', (await stage.request('/api/agents')).body.length, 0)
  }

  // ------------------------------- 4g. a run nobody is driving is not running
  t.section('4g. a run whose owner is gone is not reported as working')
  {
    const issue = await stage.createIssue('Owner vanished')
    const dir = path.join(stage.issuesDir, project, issue.id)
    const runId = '2026-01-01T00-00-00-000Z-deadbeef'

    // A run left behind by a process that died while this server was up: the
    // state says running, the lock names an owner from a previous boot.
    await fs.mkdir(path.join(dir, 'runs', runId), { recursive: true })
    await fs.writeFile(path.join(dir, 'runs', runId, 'run.json'), JSON.stringify({
      runId,
      issue: { project, id: issue.id },
      playbook: { id: 'implementation', strategy: 'implementation' },
      status: 'running',
      startedAt: new Date().toISOString(),
      phase: { id: 'implement-review', round: 0 },
      participants: {
        implementer: {
          role: 'implementer', model: 'opus-5-5', harness: 'fake', state: 'invoking',
          pendingInvocation: { invocationId: 'abc', startedAt: new Date().toISOString(), cursor: { stepId: 'implement', round: 0, attempt: 1 } }
        }
      },
      steps: [], revisions: [], budgets: { limits: {}, used: {} }
    }))
    await fs.writeFile(path.join(dir, '.run.lock'), JSON.stringify({
      purpose: 'run',
      token: 'stale',
      owner: { pid: 999999, bootId: 'a-previous-boot', processStartedAt: '1', host: 'somewhere-else', runId }
    }))

    const listed = (await stage.request('/api/agents')).body.find((r) => r.runId === runId)
    t.ok('the run is still shown', Boolean(listed))
    t.eq('but not as something this server drives', listed.ownership, 'unowned')
    t.ok('and its agent is still named', listed.agents[0]?.role === 'implementer', listed.agents[0]?.role)

    await fs.rm(path.join(dir, '.run.lock'), { force: true })
    await fs.rm(path.join(dir, 'runs', runId), { recursive: true, force: true })
  }

  // ------------------------------------- 4h. a server older than the page it serves
  t.section('4h. a stale server says so rather than answering with a bare 404')
  {
    // The page is reloaded from disk on every visit; the server is loaded once at
    // startup. When they diverge, a current page calls routes the running process
    // has never heard of, and Express's default answer explains none of that.
    const missing = await stage.request('/api/no-such-endpoint')
    t.eq('an unmatched /api path is a 404', missing.status, 404)
    t.ok('answered as JSON, not an HTML error page', missing.body !== null, JSON.stringify(missing.body))
    t.ok('naming the method and path', /GET \/api\/no-such-endpoint/.test(missing.body.error), missing.body.error)
    t.eq('and a freshly started server is not stale', missing.body.stale, false)

    // Authentication still comes first: a bogus path must not reveal anything.
    const anonymous = await fetch(`${stage.origin}/api/no-such-endpoint`)
    t.eq('an unauthenticated probe is refused before that', anonymous.status, 401)

    // Now make the code on disk newer than the process serving it.
    const source = path.join(process.cwd(), 'server', 'metrics.js')
    const before = await fs.stat(source)
    await fs.utimes(source, new Date(), new Date())
    try {
      const stale = await stage.request('/api/no-such-endpoint')
      t.eq('the server notices it is behind the code on disk', stale.body.stale, true)
      t.ok('and says what to do about it', /restart/i.test(stale.body.error), stale.body.error)

      const agents = (await stage.request('/api/agents')).status
      t.eq('routes it does have keep working', agents, 200)
    } finally {
      // Leave the tree as it was found, or every later run looks stale.
      await fs.utimes(source, before.atime, before.mtime)
    }

    t.eq('and restoring the file clears it', (await stage.request('/api/no-such-endpoint')).body.stale, false)
  }

  // ------------------------------------------------------------------ 5. auth
  t.section('5. controls and run streams require the token')
  {
    const issue = await stage.createIssue('Auth on controls')
    const url = `${stage.origin}${runsRoute(issue.id)}`

    const start = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbook: 'implementation' })
    })
    t.eq('starting a run without a token is refused', start.status, 401)

    const stop = await fetch(`${url}/whatever/stop`, { method: 'POST' })
    t.eq('stopping without a token is refused', stop.status, 401)

    const list = await fetch(url)
    t.eq('reading runs without a token is refused', list.status, 401)

    const wrong = await fetch(url, { headers: { Authorization: 'Bearer not-the-token' } })
    t.eq('a wrong token is refused', wrong.status, 401)

    // The browser's header: Authorization is left to a basic-auth proxy in front.
    const own = await fetch(url, { headers: { 'X-Devpanel-Token': stage.token, Authorization: 'Basic eDp4' } })
    t.eq('the token in X-Devpanel-Token is accepted beside proxy Basic credentials', own.status, 200)

    const ownWrong = await fetch(url, { headers: { 'X-Devpanel-Token': 'not-the-token' } })
    t.eq('a wrong X-Devpanel-Token is refused', ownWrong.status, 401)

    // A token in the query string would be logged by every proxy in the path.
    const inQuery = await fetch(`${url}?token=${stage.token}`)
    t.eq('a token in the URL is not accepted', inQuery.status, 401)

    const anonymous = connect(stage.origin, { transports: ['websocket'], reconnection: false })
    const refusal = await new Promise((resolve) => {
      anonymous.on('connect', () => resolve('connected'))
      anonymous.on('connect_error', (error) => resolve(error.message))
      setTimeout(() => resolve('no answer'), 4000)
    })
    anonymous.close()
    t.ok('an unauthenticated socket subscription is refused', refusal !== 'connected', refusal)
  }

  // --------------------------------------------- 9. accumulate, then delete
  t.section('9. a run may build on earlier runs, and a settled run can be deleted')
  {
    await stage.setControl({ delayMs: 0 })
    const issue = await stage.createIssue('Accumulate and delete')
    const dir = path.join(stage.issuesDir, project, issue.id)
    const first = await stage.request(runsRoute(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('the first run starts', first.status, 201, first.body.error)
    await settledRun(issue.id)
    const firstRun = await stage.run(issue.id, first.body.runId)
    t.ok('and settles', !LIVE_STATUSES.includes(firstRun.status), firstRun.status)
    t.eq('a run without the option is not given earlier runs', firstRun.currentWindow?.accumulated ?? null, null)

    // Right after the start the run is preflighting: live, so not deletable.
    const runOptions = { accumulate: true }
    const preview = await stage.request(`/api/playbooks/implementation/preview?project=${project}&issue=${issue.id}&options=${encodeURIComponent(JSON.stringify(runOptions))}`)
    const second = await stage.request(runsRoute(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation', configHash: preview.body.configHash, runOptions: preview.body.runOptions }) })
    t.ok('a run with accumulate starts', second.status === 201, JSON.stringify(second.body).slice(0, 600))
    const live = await stage.request(`${runsRoute(issue.id)}/${second.body.runId}`, { method: 'DELETE' })
    t.eq('a live run cannot be deleted', live.status, 409)
    await settledRun(issue.id)
    const secondRun = await stage.run(issue.id, second.body.runId)
    t.eq('it was given the first run', secondRun.currentWindow?.accumulated?.runs, [first.body.runId])
    const frozen = path.join(path.dirname(secondRun.currentWindow.manifest), 'input', 'prior-runs', first.body.runId)
    t.ok('with every turn of it frozen', (await fs.readFile(path.join(frozen, 'steps.md'), 'utf8')).includes('## 0'))

    const worktree = firstRun.workspace?.path
    const deleted = await stage.request(`${runsRoute(issue.id)}/${first.body.runId}`, { method: 'DELETE' })
    t.eq('a settled run is deleted', deleted.status, 200, deleted.body.error)
    t.ok('its record is gone', !(await fs.access(path.join(dir, 'runs', first.body.runId)).then(() => true, () => false)))
    t.ok('its worktree is gone', !worktree || !(await fs.access(worktree).then(() => true, () => false)), worktree)
    const after = await fs.readdir(dir)
    t.ok('its step folders are gone', deleted.body.steps.length > 0 && deleted.body.steps.every((f) => !after.includes(f)), deleted.body.steps.join(', '))
    t.ok('the other run\'s steps stay', after.some((f) => /^\d{3}-/.test(f) && !deleted.body.steps.includes(f) && f !== '000-report'))
    t.eq('the run list no longer has it', (await stage.runs(issue.id)).map((r) => r.runId), [second.body.runId])
    const reservations = JSON.parse(await fs.readFile(path.join(dir, '.step-reservations.json'), 'utf8'))
    t.ok('reservations stay, so a step number is never reused', deleted.body.steps.every((f) => reservations.some((r) => r.folder === f)))
    t.eq('deleting it again is a 404', (await stage.request(`${runsRoute(issue.id)}/${first.body.runId}`, { method: 'DELETE' })).status, 404)
  }

  await stage.stop()
}
