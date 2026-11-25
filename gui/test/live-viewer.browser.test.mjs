import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export const name = 'live viewer — a hidden output viewer holds no subscription, from its first moment'

/*
 * The issue page restores hidden sections from this browser (issue-sections.js)
 * and keeps the live turn's terminal mounted under v-show. A viewer mounted
 * hidden must never join the invocation's room; shown, it joins; hidden again,
 * it leaves. Read from the frames the page actually sends.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export default async function (t) {
  const stage = await startStage({ control: { delayMs: 0, noise: { implement: { chunks: 3000, bytes: 256, intervalMs: 10 } } } })
  let browser = null
  try {
    const issue = await stage.createIssue('Hidden viewer')
    const started = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('the run started', started.status, 201)
    const deadline = Date.now() + 30000
    let active = null
    while (!active && Date.now() < deadline) {
      active = (await stage.run(issue.id, started.body.runId))?.active?.find((a) => a.stepId === 'implement') ?? null
      if (!active) await sleep(50)
    }
    t.ok('the implement turn is in flight', Boolean(active))

    browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, {
      token: stage.token,
      local: { 'devpanel.issue.hidden': JSON.stringify(['detail']) }
    })
    const subscribes = () => browser.traffic.sent.filter((f) => f.includes('"live:subscribe"') && f.includes(active.invocationId))
    const unsubscribes = () => browser.traffic.sent.filter((f) => f.includes('"live:unsubscribe"') && f.includes(active.invocationId))
    const tailRead = () => browser.traffic.httpBodies.some((b) => b.url.includes(`/live/${active.invocationId}`) && b.url.includes('tail='))

    await browser.until(() => browser.find('button', 'Step detail'), { timeout: 15000, label: 'the Sections bar' })
    await browser.until(tailRead, { timeout: 15000, label: 'the hidden viewer reading its tail' })
    await sleep(1500)
    t.eq('mounted hidden: the viewer read its tail over HTTP but sent no subscription', subscribes().length, 0)
    t.ok('and no output frame reached the page', !browser.traffic.frames.some((f) => f.includes('DPNOISE:')) &&
      !browser.traffic.httpBodies.some((b) => b.url.includes('/socket.io/') && b.text.includes('DPNOISE:')))

    await browser.clickWhen(() => browser.find('button', 'Step detail'))
    await browser.until(() => subscribes().length > 0, { timeout: 8000, label: 'a subscription once shown' })
    t.ok('shown: it subscribes', subscribes().length >= 1)
    const received = () => [...browser.traffic.frames, ...browser.traffic.httpBodies.map((b) => b.text)]
    await browser.until(() => received().some((f) => f.includes('DPNOISE:implement:')), { timeout: 8000, label: 'output once subscribed' })
    t.ok('and output arrives', true)

    await browser.clickWhen(() => browser.find('button', 'Step detail'))
    await browser.until(() => unsubscribes().length > 0, { timeout: 8000, label: 'an unsubscribe once hidden' })
    t.ok('hidden again: it unsubscribes', unsubscribes().length >= 1)
  } finally {
    browser?.window?.close?.()
    await stage.stop()
  }
}
