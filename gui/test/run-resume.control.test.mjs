import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { launchChromium, browserRequired } from './browser/chromium.mjs'

async function until (fn) {
  const end = Date.now() + 30000
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)) }
  throw new Error('Timed out waiting for run state')
}

export default async t => {
  const stage = await startStage({ control: { delayMs: 600 } })
  const issue = await stage.createIssue('Pause and resume without repeating triage')
  const route = `/api/projects/${stage.project}/issues/${issue.id}/runs`
  const started = await stage.request(route, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
  const runId = started.body.runId
  const settled = async () => !await fs.access(path.join(stage.issuesDir, stage.project, issue.id, '.run.lock')).then(() => true, () => false)
  t.section('HTTP pause preserves the turn and survives a server restart')
  await until(async () => (await stage.run(issue.id, runId)).active.length)
  t.eq('pause is accepted', (await stage.request(`${route}/${runId}/pause`, { method: 'POST' })).status, 202)
  t.eq('a repeated pause is harmless', (await stage.request(`${route}/${runId}/pause`, { method: 'POST' })).status, 202)
  const paused = await until(async () => { const r = await stage.run(issue.id, runId); return r.status === 'paused' && await settled() ? r : null })
  t.eq('only the in-flight step completed', paused.timeline.length, 1)
  t.eq('manual pause is visible', paused.pause.kind, 'manual')
  await stage.restart()
  t.ok('resume remains available after restart', (await stage.run(issue.id, runId)).supportedActions.includes('resume'))
  const chrome = await launchChromium()
  if (chrome.ok) {
    const context = await chrome.browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(stage.origin)
    await page.evaluate(token => sessionStorage.setItem('devpanel.token', token), stage.token)
    await page.goto(`${stage.origin}/projects/${stage.project}/${issue.id}`)
    await page.getByRole('button', { name: 'Resume run', exact: true }).waitFor()
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      t.ok(`run page fits at ${width}px`, await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
      t.ok(`summary text has readable width at ${width}px`, await page.locator('.summary__cell').evaluateAll(cells => cells.every(c => c.getBoundingClientRect().width >= 180)))
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'devpanel-resume-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(os.tmpdir(), 'devpanel-resume-mobile.png'), fullPage: true })
    await page.getByRole('button', { name: 'Resume run', exact: true }).click()
    t.eq('resume dialog starts from the run\'s own limit', await page.locator('.v-dialog input[type=number]').first().inputValue(), String(paused.budgets.limits.wallClockMinutes))
    await stage.setControl({ delayMs: 0 })
    await page.getByRole('button', { name: 'Resume saved run', exact: true }).click()
    await page.locator('.v-dialog').waitFor({ state: 'hidden' })
    t.eq('no browser exceptions', errors, [])
    await context.close()
  } else {
    if (browserRequired) t.ok('browser launches', false, chrome.reason)
    else t.skip('responsive layout and resume dialog', chrome.reason)
    await stage.setControl({ delayMs: 0 })
    t.eq('resume endpoint accepts the saved run', (await stage.request(`${route}/${runId}/resume`, { method: 'POST', body: JSON.stringify({ budgets: { wallClockMinutes: 10080 } }) })).status, 202)
  }
  const finished = await until(async () => { const r = await stage.run(issue.id, runId); return r.status === 'completed' && await settled() ? r : null })
  t.eq('there is still only one run', (await stage.runs(issue.id)).length, 1)
  t.eq('the first step retains its invocation id', finished.timeline[0].invocationId, paused.timeline[0].invocationId)
  t.eq('the coordinator session was reused', finished.participants.coordinator.session, paused.participants.coordinator.session)
  t.eq('completed run cannot be resumed', (await stage.request(`${route}/${runId}/resume`, { method: 'POST' })).status, 409)
  t.eq('the panel resume names its origin; no name was known', [finished.resumeHistory.at(-1).actor, finished.resumeHistory.at(-1).origin], ['operator', 'panel'])
  t.eq('the run lists what applies', finished.actions, finished.supportedActions)

  t.section('a refused action is a warning without a stack')
  const refusal = await stage.request(`${route}/${runId}/refresh-checks`, { method: 'POST' })
  t.eq('refresh-checks that does not apply is a 409', [refusal.status, finished.actions.includes('refresh-checks')], [409, false])
  const notApplicable = await stage.request(`${route}/${runId}/accept-check-result`, { method: 'POST', body: JSON.stringify({ failures: ['x'], reason: 'unrelated', revision: 'sha256:x' }) })
  t.eq('accepting a check result that does not apply is a 409', [notApplicable.status, finished.actions.includes('accept-check-result')], [409, false])
  const unreasoned = await stage.request(`${route}/${runId}/accept-check-result`, { method: 'POST', body: JSON.stringify({ failures: ['x'], revision: 'sha256:x' }) })
  t.eq('and with no reason, a 400', unreasoned.status, 400)
  t.eq('retry-input that does not apply is a 409', (await stage.request(`${route}/${runId}/retry-input`, { method: 'POST' })).status, 409)
  const rows = (await fs.readFile(path.join(stage.logDir, 'devpanel.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const about = rows.filter((r) => r.message.includes(`${runId}/refresh-checks`) || r.message.includes(`${runId}/retry-input`))
  t.eq('each is one row, at warn', about.map((r) => r.level), ['warn', 'warn'])
  t.ok('with no stack', about.every((r) => !/\n\s+at /.test(r.message)))
  t.eq('and nothing logged the refusals as a failed request', rows.filter((r) => r.level === 'error' && /Only a retained code run|Only a confirmed input-size/.test(r.message)).length, 0)

  t.section('budget-blocked run resumes after a larger allowance')
  const other = await stage.createIssue('Resume a spent budget')
  const otherRoute = `/api/projects/${stage.project}/issues/${other.id}/runs`
  const runOptions = { budgets: { maxSteps: 1 } }
  const preview = await stage.request(`/api/playbooks/implementation/preview?options=${encodeURIComponent(JSON.stringify(runOptions))}`)
  const launch = await stage.request(otherRoute, { method: 'POST', body: JSON.stringify({ playbook: 'implementation', configHash: preview.body.configHash, runOptions }) })
  t.eq('second run starts', launch.status, 201)
  if (launch.status !== 201) throw new Error(JSON.stringify(launch.body))
  const id = launch.body.runId
  await until(async () => { const r = await stage.run(other.id, id); if (['failed', 'completed', 'cancelled'].includes(r.status)) throw new Error(JSON.stringify({ status: r.status, reason: r.blockedReason, failure: r.failure, preflight: r.preflight, budgets: r.budgets })); return r.status === 'blocked' })
  await until(async () => !await fs.access(path.join(stage.issuesDir, stage.project, other.id, '.run.lock')).then(() => true, () => false))
  t.eq('exhausted allowance is not silently reset', (await stage.request(`${otherRoute}/${id}/resume`, { method: 'POST' })).status, 422)
  t.eq('larger allowance resumes existing run', (await stage.request(`${otherRoute}/${id}/resume`, { method: 'POST', body: JSON.stringify({ budgets: { maxSteps: 40, wallClockMinutes: 10080 }, actor: 'ada' }) })).status, 202)
  await until(async () => (await stage.run(other.id, id)).status === 'completed')
  const named = (await stage.run(other.id, id)).resumeHistory.at(-1)
  t.eq('a name given to the panel is recorded', [named.actor, named.origin], ['ada', 'panel'])
  await until(async () => !await fs.access(path.join(stage.issuesDir, stage.project, other.id, '.run.lock')).then(() => true, () => false))
  t.section('pause during setup waits without invoking an agent')
  await stage.setControl({ probeDelayMs: 250, delayMs: 0 })
  const early = await stage.createIssue('Pause during setup')
  const earlyRoute = `/api/projects/${stage.project}/issues/${early.id}/runs`
  const earlyStart = await stage.request(earlyRoute, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
  const earlyId = earlyStart.body.runId
  t.eq('pause works before the engine exists', (await stage.request(`${earlyRoute}/${earlyId}/pause`, { method: 'POST' })).status, 202)
  const ready = await until(async () => { const r = await stage.run(early.id, earlyId); return r.status === 'paused' && !await fs.access(path.join(stage.issuesDir, stage.project, early.id, '.run.lock')).then(() => true, () => false) ? r : null })
  t.eq('setup finished', ready.preflight.state, 'passed')
  t.eq('no agent turn was spent', ready.timeline.length, 0)
  const attempts = ready.preflight.attempts
  const results = await Promise.all([1, 2].map(() => stage.request(`${earlyRoute}/${earlyId}/resume`, { method: 'POST' })))
  t.eq('double resume admits only one caller', results.map(r => r.status).sort(), [202, 409])
  const done = await until(async () => { const r = await stage.run(early.id, earlyId); return r.status === 'completed' ? r : null })
  t.eq('resume never repeats paid setup', done.preflight.attempts, attempts)

}
