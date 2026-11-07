import fs from 'node:fs/promises'
import path from 'node:path'

import { startStage } from './browser/stage.mjs'

/*
 * The daily full verification against a real server: "Full verification now"
 * closes admission, a run with a turn in flight finishes that turn and pauses as
 * full-verification, a new start is refused, the cycle runs once no seat turn is
 * running (the stage's project has no infrastructure: verified through its
 * instances), writes its record and resumes the paused run.
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

export default async (t) => {
  const stage = await startStage({ control: { delayMs: 0 } })
  const route = (issueId, runId = '') => `/api/projects/${stage.project}/issues/${issueId}/runs${runId ? `/${runId}` : ''}`
  try {
    t.section('the panel shows no cycle before the first')
    const empty = await stage.request('/api/verification/latest')
    t.eq('no record, no schedule, admission open', [empty.status, empty.body.cycle, empty.body.schedule, empty.body.frozen], [200, null, null, null])

    t.section('a hand start freezes admission; the run in flight finishes its turn and pauses')
    await stage.setControl({ delayMs: 4000 })
    const issue = await stage.createIssue('Frozen by the cycle')
    const started = await stage.request(route(issue.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    await until(async () => (await stage.run(issue.id, started.body.runId)).active?.length > 0, 'a turn to be in flight')
    const hand = await stage.request('/api/verification/start', { method: 'POST', body: '{}' })
    t.eq('"Full verification now" is accepted with the cycle frozen', [hand.status, hand.body.state], [202, 'frozen'])
    const again = await stage.request('/api/verification/start', { method: 'POST', body: '{}' })
    t.eq('a second cycle is refused while one runs', [again.status, again.body?.code ?? null], [409, 'FULL_VERIFICATION_RUNNING'])
    const other = await stage.createIssue('Started during the freeze')
    const refused = await stage.request(route(other.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('no new run starts while admission is closed', [refused.status, refused.body?.code ?? null], [409, 'FULL_VERIFICATION_FREEZE'])
    await stage.setControl({ delayMs: 0 })

    t.section('the cycle runs once no seat turn is running, records itself and resumes the paused run')
    const ended = await until(async () => { const r = (await stage.request('/api/verification/latest')).body; return r.cycle?.state === 'ended' ? r.cycle : null }, 'the cycle to end')
    t.eq('the record is the hand start\'s', [ended.id, ended.trigger], [hand.body.cycleId, 'hand'])
    t.eq('the project without infrastructure is verified through its instances, with no run', ended.projects.map((p) => [p.project, p.verifiedThrough, p.runId ?? null]), [[stage.project, 'instances', null]])
    t.eq('the paused run was resumed by the cycle', ended.resumed.map((r) => r.runId), [started.body.runId])
    const record = JSON.parse(await fs.readFile(path.join(stage.issuesDir, '.verification', ended.date, 'cycle.json'), 'utf8'))
    t.eq('issues/.verification/<date>/cycle.json is the record the panel shows', record.id, ended.id)
    const finished = await until(async () => { const run = await stage.run(issue.id, started.body.runId); return run.status === 'completed' ? run : null }, 'the resumed run to complete')
    const events = (await fs.readFile(path.join(stage.issuesDir, stage.project, issue.id, 'runs', started.body.runId, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    t.ok('it paused as full-verification before it resumed', events.some((e) => e.type === 'freeze-requested') && events.some((e) => e.type === 'paused' && /full-verification/.test(e.key ?? '')))
    t.eq('and completed', finished.status, 'completed')
    const after = await stage.request(route(other.id), { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('admission is open again', after.status, 201)
  } finally {
    await stage.stop()
  }
}
