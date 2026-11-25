import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'

import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'issue page freshness — stale while disconnected, refreshed on reconnect, actions revalidated before sending'

/*
 * The AC7 scenarios on the issue page, in a real server with the scripted runtime:
 *  (a) a run moves from checking to waiting for the owner while the connection is down;
 *  (b) a failed refresh offers Retry and clears only on success;
 *  (c) a late response after navigation shows nothing of the issue left;
 *  (d) an action that became unavailable while disconnected is not sent.
 * Their decision logic is unit-tested in freshness.test.
 */

const HOLD = { id: 'H1', question: 'Ship the new login page to every customer?', category: 'documented-promise', reason: 'The docs promise the old flow until 2027.', recommendation: 'Ship it behind the flag.' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until (fn, label, ms = 30000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

/** Every request the page sends, with its method. */
function recordRequests (browser) {
  const sent = []
  const fetch = browser.window.fetch
  browser.window.fetch = (...args) => {
    sent.push({ method: (args[1]?.method ?? 'GET').toUpperCase(), url: String(args[0]?.url ?? args[0]) })
    return fetch(...args)
  }
  return sent
}

const freshness = (browser) => browser.window.document.querySelector('[data-test="freshness"]')
const freshState = (browser) => freshness(browser)?.getAttribute('data-state') ?? null
// Disconnected reads 'offline', or 'connecting' while socket.io retries: both are stale.
const disconnected = (browser) => ['offline', 'connecting'].includes(freshState(browser))
const setValue = (browser, el, value) => { el.value = value; el.dispatchEvent(new browser.window.Event('input', { bubbles: true })) }

export default async function (t) {
  const stage = await startStage()
  let browser = null
  try {
    // A local check that takes a while, and an implementation audit that states an owner hold: the run is
    // checked first and then waits for the owner (engine.owner-hold section 8 proves the order).
    await fs.mkdir(path.join(stage.configRoot, 'projects'), { recursive: true })
    await fs.writeFile(path.join(stage.configRoot, `projects/${stage.project}.yaml`), YAML.stringify({ id: stage.project, checks: { requirement: 'required', commands: [{ id: 'slow', run: 'sleep 6' }] } }))
    await stage.setControl({ delayMs: 300, script: { implHolds: [HOLD] } })

    const issue = await stage.createIssue('Freshness while a run is checked')
    const root = `/api/projects/${stage.project}/issues/${issue.id}`
    const { body: started } = await stage.request(`${root}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    const runId = started.runId

    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token, local: { 'devpanel.actor': 'tester' } })
    const sent = recordRequests(browser)

    t.section('(a) checking → waiting for the owner, while the connection is down')
    await until(async () => (await stage.run(issue.id, runId))?.explanation?.headline === 'Running: checking the candidate', 'the server to report the check running alone')
    await browser.until(() => browser.has('Running: checking the candidate') && freshState(browser) === 'current', { timeout: 15000, label: 'the checking headline, current' })
    t.ok('the page shows the run being checked, and reads current', browser.has('Running: checking the candidate'))
    browser.setOffline(true)
    await browser.until(() => disconnected(browser), { label: 'the offline indicator' })
    await until(async () => { const r = await stage.run(issue.id, runId); return r?.status === 'paused' && r.pause?.kind === 'owner-hold' }, 'the run to pause for the owner')
    t.ok('disconnected: the old result stays visible', browser.has('Running: checking the candidate'))
    t.eq('marked stale, with no answer form yet', [disconnected(browser), browser.has('Send answer and continue')], [true, false])
    t.ok('the indicator says when it was read', /read at \d\d:\d\d:\d\d/.test(freshness(browser).textContent))
    browser.stall(new RegExp(`/runs/${runId}$`), 2500)
    browser.setOffline(false)
    await browser.until(() => ['refreshing', 'behind'].includes(freshState(browser)), { label: 'refreshing after reconnect' })
    t.ok('connected but not synchronized: still the old result, not current', browser.has('Running: checking the candidate') && freshState(browser) !== 'current')
    await browser.until(() => browser.has('Waiting for you: this decision is yours') && freshState(browser) === 'current', { timeout: 15000, label: 'the owner question after the refresh' })
    browser.clearStalls()
    t.ok('after the refresh the correct action appears', Boolean(browser.find('button', 'Send answer and continue')))

    t.section('(d) an action that became unavailable while disconnected is not sent')
    const pauseId = (await stage.run(issue.id, runId)).pause.id
    browser.setOffline(true)
    await browser.until(() => disconnected(browser), { label: 'offline again' })
    await stage.request(`${root}/runs/${runId}/answer`, { method: 'POST', body: JSON.stringify({ answer: 'Agreed elsewhere.', actor: 'owner', pauseId }) })
    browser.stall(new RegExp(`/runs/${runId}$`), 2500)
    browser.setOffline(false)
    const answerBox = browser.window.document.querySelector('.answer textarea')
    if (answerBox) setValue(browser, answerBox, 'Agreed here.')
    const before = sent.length
    await browser.clickWhen(() => browser.find('button', 'Send answer and continue'))
    await browser.until(() => browser.has('is no longer offered'), { timeout: 15000, label: 'the refusal notice' })
    browser.clearStalls()
    t.eq('no answer was sent from the stale form', sent.slice(before).filter((r) => r.method === 'POST' && /\/answer$/.test(r.url)), [])
    t.ok('the page says what happened instead', browser.has('Nothing was sent.'))

    t.section('(b) a failed refresh offers Retry and clears only on success')
    await until(async () => !['running', 'pending', 'preflighting', 'paused'].includes((await stage.run(issue.id, runId))?.status), 'the run to settle', 60000)
    await browser.until(() => freshState(browser) === 'current', { label: 'current before the failure' })
    let failNext = true
    const fetch = browser.window.fetch
    browser.window.fetch = async (...args) => {
      if (failNext && new RegExp(`/runs/${runId}$`).test(String(args[0]))) { failNext = false; return new Response(JSON.stringify({ error: 'broken on purpose' }), { status: 500, headers: { 'Content-Type': 'application/json' } }) }
      return fetch(...args)
    }
    await browser.clickWhen(() => browser.all('button').find((el) => el.getAttribute('aria-label') === 'Reload'))
    await browser.until(() => freshState(browser) === 'failed', { label: 'the failed indicator' })
    t.ok('the last successful run stays on screen', browser.has(runId))
    t.ok('Retry is offered', Boolean(browser.window.document.querySelector('[data-test="freshness-retry"]')))
    await browser.clickWhen(() => browser.window.document.querySelector('[data-test="freshness-retry"]'))
    await browser.until(() => freshState(browser) === 'current', { label: 'current after Retry' })
    t.ok('the stale indicator cleared after a successful refresh', !browser.window.document.querySelector('[data-test="freshness-retry"]'))

    t.section('the indicator stays visible with the Issue card hidden')
    await browser.clickWhen(() => browser.all('button.section-toggle').find((el) => el.textContent.trim() === 'Issue'))
    const hiddenAncestor = (el) => { for (let n = el; n; n = n.parentElement) if (n.style?.display === 'none') return true; return false }
    t.ok('outside every card', freshness(browser) && !hiddenAncestor(freshness(browser)))
    await browser.clickWhen(() => browser.all('button.section-toggle').find((el) => el.textContent.trim() === 'Issue'))

    t.section('(c) a late response after navigation shows nothing of the issue left')
    const other = await stage.createIssue('The issue navigated to')
    browser.stall(new RegExp(`/issues/${issue.id}$`), 2500)
    await browser.clickWhen(() => browser.all('button').find((el) => el.getAttribute('aria-label') === 'Reload'))
    await browser.goto(`/projects/${stage.project}/${other.id}`)
    await browser.until(() => browser.has('The issue navigated to') && freshState(browser) === 'current', { label: 'the other issue' })
    await sleep(3000)
    browser.clearStalls()
    t.ok('the late reply for the first issue did not replace it', browser.has('The issue navigated to') && !browser.has('Freshness while a run is checked'))
    t.eq('and it reads current', freshState(browser), 'current')
  } finally {
    browser?.close()
    await stage.stop()
  }
}
