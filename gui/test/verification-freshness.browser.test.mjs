import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'Full verification freshness — one indicator, refreshed on reconnect and tab return, latest reply only, "Full verification now" revalidated'

/*
 * The Full verification page in a real server: its one indicator, a failed refresh with Retry, a refresh on
 * reconnect and on a tab coming back, an older reply that arrives after a newer one (held after it was read,
 * so it really is the older state), and "Full verification now" refused when a cycle started meanwhile.
 * The decision logic is unit-tested in freshness.test.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const LATEST = /\/api\/verification\/latest$/

/** Wrap the page's fetch: log every request and let a test hold or fail chosen replies. */
function instrument (browser) {
  const sent = []
  const rules = []
  const fetch = browser.window.fetch
  browser.window.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0])
    const method = (args[1]?.method ?? 'GET').toUpperCase()
    sent.push({ method, url })
    const rule = rules.find((r) => r.match.test(url) && method === 'GET')
    if (rule) {
      rules.splice(rules.indexOf(rule), 1)
      return rule.handle(() => fetch(...args))
    }
    return fetch(...args)
  }
  return { sent, once: (match, handle) => rules.push({ match, handle }) }
}

const indicators = (browser) => browser.all('[data-test="freshness"]')
const freshState = (browser) => indicators(browser)[0]?.getAttribute('data-state') ?? null
const cycleShown = (browser) => browser.window.document.querySelector('.fv__summary strong')?.textContent ?? null

export default async function (t) {
  const stage = await startStage()
  let browser = null
  try {
    browser = await openBrowser(`${stage.origin}/verification`, { token: stage.token })
    const net = instrument(browser)
    await browser.until(() => freshState(browser) === 'current', { label: 'the page read' })

    t.section('one indicator, separate from the connection')
    t.eq('exactly one freshness indicator on the page', indicators(browser).length, 1)
    t.ok('it says when it was read', /read \d\d:\d\d:\d\d/.test(indicators(browser)[0].textContent))

    t.section('a failed refresh: Retry, not current, cleared only by a success')
    net.once(LATEST, async () => new Response(JSON.stringify({ error: 'broken on purpose' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    browser.setOffline(true)
    await browser.until(() => ['offline', 'connecting'].includes(freshState(browser)), { label: 'offline' })
    browser.setOffline(false)
    await browser.until(() => freshState(browser) === 'failed', { label: 'the failed refresh' })
    t.ok('Retry is offered', Boolean(browser.window.document.querySelector('[data-test="freshness-retry"]')))
    await browser.clickWhen(() => browser.window.document.querySelector('[data-test="freshness-retry"]'))
    await browser.until(() => freshState(browser) === 'current', { label: 'current after Retry' })
    t.ok('reconnecting read the record again', net.sent.filter((r) => LATEST.test(r.url)).length >= 3)

    t.section('a tab coming back refreshes')
    const reads = net.sent.filter((r) => LATEST.test(r.url)).length
    Object.defineProperty(browser.window.document, 'visibilityState', { configurable: true, get: () => 'visible' })
    browser.window.document.dispatchEvent(new browser.window.Event('visibilitychange'))
    await browser.until(() => net.sent.filter((r) => LATEST.test(r.url)).length > reads, { label: 'a read on tab return' })
    await browser.until(() => freshState(browser) === 'current', { label: 'current after the tab returned' })

    t.section('an older reply arriving after a newer one does not replace it')
    let releaseOld
    const oldHeld = new Promise((resolve) => { releaseOld = resolve })
    // The reply is read now (the state before any cycle) and handed over only later.
    net.once(LATEST, async (go) => { const response = await go(); await oldHeld; return response })
    browser.window.document.dispatchEvent(new browser.window.Event('visibilitychange'))
    await sleep(200)
    const { body: startedCycle } = await stage.request('/api/verification/start', { method: 'POST', body: '{}' })
    await browser.until(() => cycleShown(browser) === startedCycle.cycleId && freshState(browser) === 'current', { label: 'the newer cycle shown' })
    releaseOld()
    await sleep(500)
    t.eq('the newer cycle stays after the older reply landed', cycleShown(browser), startedCycle.cycleId)

    t.section('"Full verification now" is not sent once a cycle started meanwhile')
    for (const end = Date.now() + 30000; (await stage.request('/api/verification/latest')).body?.active;) {
      if (Date.now() > end) throw new Error('timed out waiting for the cycle to end')
      await sleep(200)
    }
    await browser.until(() => freshState(browser) === 'current' && !browser.find('button', 'Full verification now')?.disabled, { label: 'the start offered again' })
    await browser.clickWhen(() => browser.find('button', 'Full verification now'))
    await browser.until(() => browser.has('Start the cycle'), { label: 'the confirmation' })
    // While the pre-send read is in flight another client starts a cycle: the event invalidates it.
    net.once(LATEST, async (go) => { await stage.request('/api/verification/start', { method: 'POST', body: '{}' }); await sleep(300); return go() })
    const before = net.sent.length
    await browser.clickWhen(() => browser.find('button', 'Start the cycle'))
    await browser.until(() => browser.has('nothing was sent'), { timeout: 15000, label: 'the refusal' })
    t.eq('no start was sent from the page', net.sent.slice(before).filter((r) => r.method === 'POST' && /\/api\/verification\/start$/.test(r.url)), [])
  } finally {
    browser?.close()
    await stage.stop()
  }
}
