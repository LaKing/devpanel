import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startStage } from './browser/stage.mjs'

/*
 * A service shutdown, for real: SIGTERM to a server in its own process, and the
 * next start against the same directories. A pending pause is honoured, a run
 * cancelled by it is marked and resumed with its limits, and a run stopped any
 * other way is left to the path it already had.
 */

async function until (fn, label) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export default async (t) => {
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-shutdown-host-'))
  const setAutoResume = (value) => fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ resumeAfterShutdown: value }))
  await setAutoResume(true)
  // A grace longer than a normal stop and shorter than the hung one below.
  const stage = await startStage({ control: { delayMs: 0 }, env: { DEVPANEL_HOST_CONFIG_DIR: hostDir, DEVPANEL_SHUTDOWN_GRACE_MS: '1500' } })
  const route = (issueId, runId = '') => `/api/projects/${stage.project}/issues/${issueId}/runs${runId ? `/${runId}` : ''}`
  const dir = (issueId, runId) => path.join(stage.issuesDir, stage.project, issueId, 'runs', runId)
  const record = async (issueId, runId) => JSON.parse(await fs.readFile(path.join(dir(issueId, runId), 'run.json'), 'utf8'))
  const events = async (issueId, runId) => (await fs.readFile(path.join(dir(issueId, runId), 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const settled = (issueId) => fs.access(path.join(stage.issuesDir, stage.project, issueId, '.run.lock')).then(() => false, () => true)
  const ended = (issueId, runId, status) => until(async () => {
    const run = await stage.run(issueId, runId)
    return run.status === status && await settled(issueId) ? run : null
  }, `${runId} to be ${status}`)
  // A run whose turn is in flight, with the runtime holding it there.
  const inFlight = async (name, control = {}) => {
    await stage.setControl({ delayMs: 6000, ...control })
    const issue = await stage.createIssue(name)
    const started = await stage.request(route(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    await until(async () => (await stage.run(issue.id, started.body.runId)).active?.length > 0, 'a turn to be in flight')
    return { issueId: issue.id, runId: started.body.runId }
  }

  try {
    t.section('a shutdown cancels a run, marks it, and the next start resumes it with its limits')
    {
      const { issueId, runId } = await inFlight('Interrupted')
      const before = (await record(issueId, runId)).budgets.limits
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      const finished = await ended(issueId, runId, 'completed')
      const log = await events(issueId, runId)
      t.eq('the shutdown recorded a marked cancellation', log.find((e) => e.type === 'cancelled')?.stoppedBy, 'service-shutdown')
      const entry = finished.resumeHistory.at(-1)
      t.eq('the resume names the service, not an operator', [finished.resumeHistory.length, entry.actor, entry.origin], [1, 'service', 'service-restart'])
      t.eq('it came back from the cancellation', entry.previousStatus, 'cancelled')
      t.eq('the limits before the shutdown are the limits it resumed with', [entry.previousLimits, entry.limits], [before, before])
      t.eq('and the limits are the same after it', (await record(issueId, runId)).budgets.limits, before)
      t.eq('the mark is answered, so it no longer stands', finished.stoppedBy, null)
      t.eq('it is one run, not a second', (await stage.runs(issueId)).length, 1)
    }

    t.section('a writing turn interrupted by a shutdown is kept, not quarantined')
    {
      const { issueId, runId } = await inFlight('Interrupted writer', { delayMs: 0, delayFor: { implement: 6000 }, writes: { implement: { file: 'wip.txt', text: 'half done\n' } } })
      await until(() => fs.access(path.join(path.dirname(dir(issueId, runId)), `worktree-${runId}`, 'wip.txt')).then(() => true, () => false), 'the partial edit')
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      await ended(issueId, runId, 'completed')
      const log = await events(issueId, runId)
      const integrity = log.find((e) => e.type === 'turn-integrity' && e.outcome === 'cancelled')
      t.eq('the partial edit was accepted for that reason', [integrity?.status, integrity?.partialAccepted?.reason], ['clear', 'service-shutdown'])
      t.ok('and the run was resumed by the service', log.some((e) => e.type === 'operator-resumed' && e.actor === 'service'))
    }

    t.section('a pending pause is honoured: paused, resumable, and not resumed by a start')
    {
      const { issueId, runId } = await inFlight('Pause pending')
      t.eq('the pause is accepted', (await stage.request(`${route(issueId, runId)}/pause`, { method: 'POST' })).status, 202)
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      const paused = await stage.run(issueId, runId)
      t.eq('recorded as paused, not cancelled', [paused.status, paused.pause?.kind, paused.pauseRequested], ['paused', 'manual', null])
      t.eq('it carries no shutdown mark, and nothing resumed it', [paused.stoppedBy, paused.resumeHistory.length], [null, 0])
      t.ok('the ordinary resume is offered', paused.supportedActions.includes('resume'))
      t.ok('the journal says the shutdown stopped it', (await events(issueId, runId)).some((e) => e.type === 'stopped-for-pause' && e.stoppedBy === 'service-shutdown'))
      await stage.restart({ signal: 'SIGTERM' })
      t.eq('another start leaves it paused', (await stage.run(issueId, runId)).status, 'paused')
      t.eq('the ordinary resume accepts it', (await stage.request(`${route(issueId, runId)}/resume`, { method: 'POST' })).status, 202)
      const finished = await ended(issueId, runId, 'completed')
      t.eq('and an operator is who it names', finished.resumeHistory.at(-1).origin, 'panel')
    }

    t.section('a run an operator stopped carries no mark and stays stopped')
    {
      const { issueId, runId } = await inFlight('Operator stop')
      await stage.request(`${route(issueId, runId)}/stop`, { method: 'POST' })
      await ended(issueId, runId, 'cancelled')
      await stage.setControl({ delayMs: 0 })
      t.eq('not marked', (await stage.run(issueId, runId)).stoppedBy, null)
      await stage.restart({ signal: 'SIGTERM' })
      const after = await stage.run(issueId, runId)
      t.eq('the next start leaves it alone', [after.status, after.resumeHistory.length], ['cancelled', 0])
      t.eq('and it reads as an operator\'s stop', after.explanation.headline, 'Stopped by an operator')
    }

    t.section('a run that does not settle in the grace period takes the recovery path')
    {
      const { issueId, runId } = await inFlight('Missed grace', { hangOnAbortMs: 20000 })
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      const after = await stage.run(issueId, runId)
      t.eq('recovery-required, as before', [after.status, after.blockedReason], ['blocked', 'recovery-required'])
      t.eq('not marked and not resumed', [after.stoppedBy, after.resumeHistory.length], [null, 0])
    }

    t.section('switched off: cancelled and marked at the next start, and a person can resume it')
    await setAutoResume(false)
    {
      const { issueId, runId } = await inFlight('Switched off')
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      const after = await stage.run(issueId, runId)
      t.eq('stays cancelled and marked', [after.status, after.stoppedBy, after.resumeHistory.length], ['cancelled', 'service-shutdown', 0])
      t.eq('and says who stopped it', after.explanation.headline, 'Stopped by a service shutdown')
      t.ok('the ordinary resume is offered', after.supportedActions.includes('resume'))
      t.eq('a person resumes it', (await stage.request(`${route(issueId, runId)}/resume`, { method: 'POST' })).status, 202)
      const finished = await ended(issueId, runId, 'completed')
      t.eq('which answers the mark', [finished.stoppedBy, finished.resumeHistory.at(-1).origin], [null, 'panel'])
    }

    t.section('less wall clock than a mean round: not started, no override, both numbers on record')
    {
      const { issueId, runId } = await inFlight('Short')
      await until(async () => (await record(issueId, runId)).steps.length > 0, 'a step to be recorded')
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      await stage.kill()
      const stopped = await record(issueId, runId)
      // One completed round of an hour; thirty minutes allowed, and well under that used.
      const step = stopped.steps[0]
      Object.assign(step, { phase: 'implement-review', round: 0, startedAt: new Date(Date.parse(step.endedAt) - 60 * 60_000).toISOString() })
      await fs.writeFile(path.join(dir(issueId, runId), 'outputs', `${step.number}.json`), JSON.stringify({ valid: true, contract: 'reviewResult', output: { findings: [] } }))
      stopped.budgets.limits.wallClockMinutes = 30
      await fs.writeFile(path.join(dir(issueId, runId), 'run.json'), JSON.stringify(stopped))
      await setAutoResume(true)
      await stage.restart()
      const after = await stage.run(issueId, runId)
      t.eq('not started, still marked', [after.status, after.stoppedBy, after.resumeHistory.length], ['cancelled', 'service-shutdown', 0])
      t.ok('both numbers are on record', /min of wall clock remaining of 30/.test(after.autoResumeRefused?.reason ?? '') && /60 min/.test(after.autoResumeRefused.reason), after.autoResumeRefused?.reason)
      t.ok('and in what a person reads', after.explanation.detail.includes(after.autoResumeRefused.reason), after.explanation.detail)
      t.eq('the limit was not touched', (await record(issueId, runId)).budgets.limits.wallClockMinutes, 30)
      await setAutoResume(false)
    }

    t.section('a limit already exhausted: not started, left stopped with the reason on record')
    {
      const { issueId, runId } = await inFlight('Exhausted')
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      await stage.kill()
      const stopped = await record(issueId, runId)
      stopped.budgets.limits.maxTokens = 1
      stopped.budgets.used.tokens = 5
      await fs.writeFile(path.join(dir(issueId, runId), 'run.json'), JSON.stringify(stopped))
      await setAutoResume(true)
      await stage.restart()
      const after = await stage.run(issueId, runId)
      t.eq('not started, still marked', [after.status, after.stoppedBy, after.resumeHistory.length], ['cancelled', 'service-shutdown', 0])
      t.ok('the reason is on record', /exhausted budget/i.test(after.autoResumeRefused?.reason ?? ''), after.autoResumeRefused?.reason)
      t.ok('and in what a person reads', after.explanation.detail.includes(after.autoResumeRefused.reason), after.explanation.detail)
      t.eq('the limit was not touched', (await record(issueId, runId)).budgets.limits.maxTokens, 1)
      const refusedAt = after.autoResumeRefused.at
      await stage.restart({ signal: 'SIGTERM' })
      t.eq('one attempt per mark: the next start does not ask again', (await stage.run(issueId, runId)).autoResumeRefused.at, refusedAt)
      const raised = await stage.request(`${route(issueId, runId)}/resume`, { method: 'POST', body: JSON.stringify({ budgets: { maxTokens: 100000000 } }) })
      t.eq('a person who raises it can resume', raised.status, 202)
      const finished = await ended(issueId, runId, 'completed')
      t.eq('which clears the refusal', [finished.stoppedBy, finished.autoResumeRefused], [null, null])
    }

    t.section('a newer run of the issue: the older mark is refused, not revived')
    await setAutoResume(false)
    {
      const { issueId, runId } = await inFlight('Went on without it')
      await stage.setControl({ delayMs: 0 })
      await stage.restart({ signal: 'SIGTERM' })
      await until(() => settled(issueId), 'the stopped run to hand the issue back')
      const next = await stage.request(route(issueId), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
      t.eq('a person started another', next.status, 201)
      await ended(issueId, next.body.runId, 'completed')
      await setAutoResume(true)
      await stage.restart({ signal: 'SIGTERM' })
      const after = await stage.run(issueId, runId)
      t.eq('the older one stays stopped', [after.status, after.resumeHistory.length], ['cancelled', 0])
      t.ok('and says why', /newer run/.test(after.autoResumeRefused?.reason ?? ''), after.autoResumeRefused?.reason)
    }
  } finally {
    await stage.stop()
    await fs.rm(hostDir, { recursive: true, force: true })
  }
}
