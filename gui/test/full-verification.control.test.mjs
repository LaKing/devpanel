import fs from 'node:fs/promises'
import path from 'node:path'

import { startStage } from './browser/stage.mjs'

/*
 * The full verification against a real server: "Full verification now" decides its scope
 * from the configuration and freezes only the projects it verifies. The stage's project has
 * no infrastructure, so the scope is empty: the run with a turn in flight goes on untouched,
 * a new writing start is admitted, the cycle records itself (verified through its instances)
 * and resumes nothing, because it paused nothing.
 */

async function until (fn, label, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const eventsOf = async (stage, issueId, runId) => (await fs.readFile(path.join(stage.issuesDir, stage.project, issueId, 'runs', runId, 'events.jsonl'), 'utf8'))
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const touchedByCycle = (events) => events.some((e) => e.type === 'freeze-requested' || e.type === 'turn-withheld' || (e.type === 'paused' && /full-verification/.test(e.key ?? '')))

export default async (t) => {
  const stage = await startStage({ control: { delayMs: 0 } })
  const route = (issueId, runId = '') => `/api/projects/${stage.project}/issues/${issueId}/runs${runId ? `/${runId}` : ''}`
  try {
    t.section('the panel shows no cycle before the first')
    const empty = await stage.request('/api/verification/latest')
    t.eq('no record, no schedule, admission open', [empty.status, empty.body.cycle, empty.body.schedule ?? null, empty.body.frozen], [200, null, null, null])

    t.section('a hand start with an empty scope: the run in flight goes on')
    await stage.setControl({ delayMs: 4000 })
    const issue = await stage.createIssue('Beside the cycle')
    const started = await stage.request(route(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    await until(async () => (await stage.run(issue.id, started.body.runId)).active?.length > 0, 'a turn to be in flight')
    const hand = await stage.request('/api/verification/start', { method: 'POST', body: '{}' })
    t.eq('AC1: "Full verification now" is accepted and names the Full verification run it started, held in the day\'s cycle home', [hand.status, typeof hand.body.run?.runId, /^verification-\d{4}-\d{2}-\d{2}-cycle$/.test(hand.body.run?.issueId ?? ''), hand.body.run?.project], [202, 'string', true, stage.project])
    const begun = await until(async () => { const r = (await stage.request('/api/verification/latest')).body; return r.cycle?.run?.runId === hand.body.run.runId ? r.cycle : null }, 'the run to start its cycle')
    t.eq('its cycle names the run; its scope is empty and it asked no run to pause: the project has no infrastructure', [begun.trigger, begun.scope?.projects, begun.asked], ['hand', [], []])
    const other = await stage.createIssue('Started beside the cycle')
    // The cycle has nothing to wait for and may already have ended: the start is admitted either way.
    const beside = await stage.request(route(other.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('a new writing run of a project outside the scope is admitted', [beside.status, typeof beside.body?.runId], [201, 'string'])
    await stage.setControl({ delayMs: 0 })

    t.section('the cycle records itself and resumes nothing')
    const ended = await until(async () => { const r = (await stage.request('/api/verification/latest')).body; return r.cycle?.state === 'ended' ? r.cycle : null }, 'the cycle to end')
    t.eq('the record is the hand start\'s', [ended.id, ended.trigger, ended.run?.runId], [begun.id, 'hand', hand.body.run.runId])
    t.eq('the project without infrastructure is verified through its instances, with no run', ended.projects.map((p) => [p.project, p.verifiedThrough, p.runId ?? null]), [[stage.project, 'instances', null]])
    t.eq('nothing was paused, so nothing is resumed, held or left paused', [ended.resumed, ended.heldForOperator, ended.leftPaused], [[], [], []])
    t.eq('no stage was verified: the outcome bumps nothing and opens nothing', [ended.verdict, ended.outcome?.bump ?? null, ended.outcome?.issues ?? null, typeof ended.outcome?.reason], ['no-stages', null, null, 'string'])
    const record = JSON.parse(await fs.readFile(path.join(stage.issuesDir, '.verification', ended.date, 'cycle.json'), 'utf8'))
    t.eq('issues/.verification/<date>/cycle.json is the record the panel shows', record.id, ended.id)
    const finished = await until(async () => { const run = await stage.run(issue.id, started.body.runId); return run.status === 'completed' ? run : null }, 'the run in flight to complete')
    t.eq('the run in flight completed', finished.status, 'completed')
    t.ok('it was never asked to freeze, withheld or paused for the cycle', !touchedByCycle(await eventsOf(stage, issue.id, started.body.runId)))
    t.ok('nor was the run started beside the cycle', !touchedByCycle(await eventsOf(stage, other.id, beside.body.runId)) && (await stage.run(other.id, beside.body.runId)).status !== 'paused')
    const fresh = await stage.createIssue('Started after the cycle')
    const after = await stage.request(route(fresh.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('admission is open after the cycle', after.status, 201)
  } finally {
    await stage.stop()
  }
}
