import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'operator alerts — an alert opens its exact action, and says when someone already handled it'

/*
 * docs/operator-alerts.md "What an alert holds, and where it opens". The alert record is written by hand (a real
 * push needs a device); the server reads alerts.jsonl at every alert request.
 */
export default async function (t) {
  const stage = await startStage()
  const issue = await stage.createIssue('Alerted issue')
  const runId = '2026-11-25T10-00-00-000Z-aaaaaaaa'
  const runDir = path.join(stage.issuesDir, stage.project, issue.id, 'runs', runId)
  await fs.mkdir(runDir, { recursive: true })
  // A run record with every field the run detail reads (runs-api.mjs getRun).
  const writeRun = (run) => fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId, startedAt: '2026-11-25T10:00:00.000Z', steps: [], participants: {}, revisions: [], approvals: [], checkResults: [], closureReturns: [], deliveryReturns: [], ...run }))
  await writeRun({ status: 'paused', pause: { id: 'p1', question: 'Ship the change?', kind: 'policy', at: '2026-11-25T10:01:00.000Z' } })
  await fs.writeFile(path.join(runDir, 'events.jsonl'), '')

  const alertId = crypto.randomUUID()
  const key = `pause:${stage.project}/${issue.id}/${runId}/p1`
  const dir = path.join(stage.issuesDir, '.notifications')
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(path.join(dir, 'alerts.jsonl'), JSON.stringify({ alertId, createdAt: '2026-11-25T10:01:05.000Z', items: [{ key, kind: 'question', project: stage.project, issueId: issue.id, runId, questionId: null, enteredAt: '2026-11-25T10:01:00.000Z' }] }) + '\n')

  // This browser hid the Status and run picker sections earlier: the alert shows them for the visit anyway.
  let browser = await openBrowser(`${stage.origin}/alerts/${alertId}`, { token: stage.token, local: { 'devpanel.issue.hidden': JSON.stringify(['runbar', 'status']) } })
  try {
    // One item that still waits: the alert page opens its action directly.
    await browser.until(() => browser.window.location.pathname === `/projects/${stage.project}/${issue.id}`, { label: 'the issue page' })
    t.eq('it lands on the issue page of the exact run', new URL(browser.window.location.href).searchParams.get('run'), runId)
    await browser.until(() => browser.has('still waiting on the question the alert named'))
    t.ok('the page says the named question still waits', browser.has('still waiting on the question the alert named'))
    t.ok('and marks its answer form', browser.all('[data-alert-action="answer"]').some((el) => el.classList.contains('alert-focus')))
    t.ok('in a Status section shown although this browser hid it', browser.all('[data-alert-action="answer"]').some((el) => el.closest('.status')?.style.display !== 'none'))
    t.eq('without changing what this browser remembers', browser.window.localStorage.getItem('devpanel.issue.hidden'), JSON.stringify(['runbar', 'status']))
    browser.close()

    // Another operator answered it meanwhile.
    await writeRun({ status: 'running', pause: null, steps: [{ role: 'operator', decision: { pauseId: 'p1', askedAt: '2026-11-25T10:01:00.000Z', at: '2026-11-25T10:05:00.000Z', actor: 'bea', answer: 'yes' } }] })
    // This browser hid the whole run card earlier: the handled note and the run as it is now are shown anyway.
    browser = await openBrowser(`${stage.origin}/alerts/${alertId}`, { token: stage.token, local: { 'devpanel.issue.hidden': JSON.stringify(['run', 'runbar', 'status']) } })
    await browser.until(() => browser.has('handled by bea'))
    t.ok('the alert page says who handled it', browser.has('handled by bea'))
    t.eq('and does not jump away', browser.window.location.pathname, `/alerts/${alertId}`)

    // Follow the item's own rendered link, as an operator would.
    const href = browser.all('a.alert-view__link')[0]?.getAttribute('href')
    t.eq('the alert page links to the exact run and question', href, `/projects/${stage.project}/${issue.id}?run=${runId}&pause=p1`)
    await browser.goto(href)
    await browser.until(() => browser.has('was already handled'))
    t.ok('following its link shows the run as it is now', browser.has('was already handled') && browser.has('The run is now running'))
    t.ok('with no answer form for a question that is gone', !browser.all('[data-alert-action="answer"]').length)
    const note = browser.all('[data-testid="alert-target"]')[0]
    t.ok('in a run card shown although this browser hid it', Boolean(note) && note.closest('.runcard')?.style.display !== 'none')
    t.eq('without changing what this browser remembers', browser.window.localStorage.getItem('devpanel.issue.hidden'), JSON.stringify(['run', 'runbar', 'status']))
    browser.close()

    // A supervisor question its session no longer holds.
    const gone = crypto.randomUUID()
    await fs.appendFile(path.join(dir, 'alerts.jsonl'), JSON.stringify({ alertId: gone, createdAt: '2026-11-25T11:00:00.000Z', items: [{ key: 'supervisor-question:sq-gone', kind: 'supervisor-question', project: null, issueId: null, runId: null, questionId: 'sq-gone', enteredAt: '2026-11-25T10:59:00.000Z' }] }) + '\n')
    browser = await openBrowser(`${stage.origin}/alerts/${gone}`, { token: stage.token })
    await browser.until(() => browser.has('no longer open'))
    t.ok('a supervisor question whose session ended reads no longer open', browser.has('no longer open'))
  } finally {
    browser.close()
    await stage.stop?.()
  }
}
