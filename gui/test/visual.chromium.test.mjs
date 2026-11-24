import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { browserRequired, closeChromium, launchChromium } from './browser/chromium.mjs'
import { startStage } from './browser/stage.mjs'

export const name = 'layout — clipping, overflow and focus, in a real browser'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Text that does not fit its box, in an element that will not scroll.
 *
 * Run ids, session ids and fingerprints are long monospace strings, and an
 * ellipsis where a person needs the whole value is a defect they cannot work
 * around.
 */
const CLIPPED = `() => {
  const bad = []
  for (const el of document.querySelectorAll('body *')) {
    if (!el.childElementCount && (el.textContent ?? '').trim().length > 3) {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      // A form field truncates its own value by design; what matters is that the
      // value is readable somewhere, which the page asserts separately.
      if (el.closest('.v-field')) continue
      const scrolls = ['auto', 'scroll'].includes(style.overflowX)
      const wraps = style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap'
      if (!scrolls && wraps && el.scrollWidth > el.clientWidth + 1) {
        bad.push((el.textContent ?? '').trim().slice(0, 40))
      }
    }
  }
  return bad
}`

const OVERFLOWS = `() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth
})`

const CONTROLS = 'button, a[href], [role="button"], [role="tab"], input:not([type="hidden"]), select, textarea, summary'
const IGNORED = '[aria-hidden="true"], [inert], .v-navigation-drawer:not(.v-navigation-drawer--active), .xterm'

/**
 * Controls past either edge of the window, under `scope`. A box that scrolls
 * sideways makes its controls reachable only while that box is itself on
 * screen; the root never counts, since html's overflow-y makes it auto too.
 */
const OFFSCREEN = `(scope) => {
  const width = document.documentElement.clientWidth
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 30)
  const bad = []
  for (const root of document.querySelectorAll(scope)) {
    for (const el of root.querySelectorAll(${JSON.stringify(CONTROLS)})) {
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden') continue
      if (el.closest(${JSON.stringify(IGNORED)}) || el.closest('.v-slide-group')) continue
      if (rect.left >= -1 && rect.right <= width + 1) continue
      let reachable = false
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (!['auto', 'scroll'].includes(getComputedStyle(a).overflowX)) continue
        const box = a.getBoundingClientRect()
        if (box.left >= -1 && box.right <= width + 1) { reachable = true; break }
      }
      if (!reachable) bad.push(name(el) + ' ' + Math.round(rect.left) + '…' + Math.round(rect.right))
    }
  }
  return bad
}`

/**
 * Tap targets under 44×44 under `scope`. A field or a checkbox is tapped as a
 * whole, so that is what is measured; a link inside running text is exempt
 * (WCAG 2.5.8), a link laid out as a control is not.
 */
const SMALL_TARGETS = `(scope) => {
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 30)
  const seen = new Set()
  const bad = []
  for (const root of document.querySelectorAll(scope)) {
    for (const el of root.querySelectorAll(${JSON.stringify(CONTROLS.replace(', textarea', ''))})) {
      if (el.closest(${JSON.stringify(IGNORED)})) continue
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue
      const target = el.closest('.v-field') ?? el.closest('.v-selection-control') ?? el
      if (seen.has(target)) continue
      seen.add(target)
      const rect = target.getBoundingClientRect()
      if (!rect.width || !rect.height || getComputedStyle(target).visibility === 'hidden') continue
      if (rect.width < 43.5 || rect.height < 43.5) bad.push(name(el) + ' ' + Math.round(rect.width) + '×' + Math.round(rect.height))
    }
  }
  return bad
}`

// Passed as source and invoked here: a bare arrow-function string evaluates to
// the function, not to what it returns.
const call = (page, fn, ...args) => page.evaluate(`(${fn})(${args.map((a) => JSON.stringify(a)).join(', ')})`)

export default async function (t) {
  const chrome = await launchChromium()
  if (!chrome.ok) {
    // Required mode is for CI, where "no browser" means the environment is
    // wrong, not that layout is exempt from checking.
    if (browserRequired) {
      t.section('a browser was required and could not be launched')
      t.ok('chromium launches', false, chrome.reason)
      return
    }
    t.section('no browser on this machine')
    t.skip('layout, clipping and focus are unchecked', chrome.reason)
    return
  }

  // Paced so that "running" and "Stopping" are states a person could actually
  // see: a turn that answers instantly never renders either.
  const stage = await startStage({ control: { delayMs: 1500, hangOnAbortMs: 2000 } })
  const context = await chrome.browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  const problems = []
  page.on('pageerror', (e) => problems.push(String(e.message)))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()) })
  // The first load below has no token yet, and src/main.js asks GET /api/whoami
  // before mounting to learn whether a verified proxy login admits this browser
  // (src/identity.js: a 401 there means "no login yet"). That probe is designed,
  // and Chromium logs its 401 as "Failed to load resource" without the URL, so
  // 401s are recorded by request: the token-less whoami is expected, any other fails.
  const unauthorised = []
  page.on('response', (r) => {
    if (r.status() !== 401) return
    const probe = new URL(r.url()).pathname === '/api/whoami' && !r.request().headers()['x-devpanel-token']
    unauthorised.push({ path: new URL(r.url()).pathname, probe })
  })

  const issue = await stage.createIssue('Layout under test')
  const url = `${stage.origin}/projects/${stage.project}/${issue.id}`

  // Signed in before the first paint, so the gate is not what we measure.
  await page.goto(stage.origin)
  await page.evaluate(([token]) => sessionStorage.setItem('devpanel.token', token), [stage.token])
  await page.goto(url)
  await page.waitForSelector('text=Layout under test', { timeout: 20000 })

  t.section(`1. the issue page at 1280×800 (${chrome.version})`)
  {
    const box = await call(page, OVERFLOWS)
    t.ok('the page does not scroll sideways', box.scrollWidth <= box.clientWidth + 1,
      `${box.scrollWidth} > ${box.clientWidth}`)
    t.eq('nothing is clipped', await call(page, CLIPPED), [])
    t.eq('issue controls are inside the issue header', await page.locator('.issue__head .issue__actions button').count(), 3)
    t.eq('application bar has no issue controls', await page.locator('#appbar-actions button').count(), 0)
    t.eq('only one playbook action on an issue without runs', await page.getByRole('button', { name: 'Run a playbook', exact: true }).count(), 1)
  }

  t.section('2. the start dialog')
  {
    await page.click('button:has-text("Run a playbook")')
    await page.waitForSelector('.pick', { timeout: 15000 })
    // Playbooks are listed alphabetically; the layout under test is implementation.
    await page.click('.pick:has-text("implementation")')
    await page.waitForSelector('text=Participants', { timeout: 15000 })
    await page.waitForSelector('text=maxSteps=120', { timeout: 15000 })

    const card = await page.locator('.v-dialog .v-card').first().boundingBox()
    const viewport = page.viewportSize()
    t.ok('the dialog fits the viewport width', card.width <= viewport.width, `${card.width}px`)
    t.ok('and starts on screen', card.y >= 0, `y=${card.y}`)
    const closeButton = page.getByRole('button', { name: 'Close dialog', exact: true })
    const closeBox = await closeButton.boundingBox()
    t.ok('playbook close X is at the top right', closeBox.x > card.x + card.width / 2 && closeBox.x + closeBox.width <= card.x + card.width && closeBox.y < card.y + 24)
    t.eq('close X has an actual icon', await closeButton.locator('svg').count(), 1)

    // A Start button below the fold with nothing to scroll is unreachable.
    const start = await page.locator('button:has-text("Start run")').first().boundingBox()
    t.ok('the Start button is on screen', start.y + start.height <= viewport.height + 1,
      `bottom=${Math.round(start.y + start.height)} of ${viewport.height}`)
    t.ok('and has a real hit area', start.width > 40 && start.height > 20,
      `${Math.round(start.width)}×${Math.round(start.height)}`)

    t.eq('nothing in the dialog is clipped', await call(page, CLIPPED), [])

    // Limits are folded under a disclosure until one is changed (the defaults
    // suit most starts), so a person opens it first, and so does this test.
    await page.locator('.advanced__summary').click()
    // Three budgets, one round cap per loop phase (implementation has one loop)
    // and the protocol repair attempts.
    t.eq('limits are editable numeric controls', await page.locator('.run-settings input[type="number"]').count(), 5)
    t.eq('including the round cap of its loop', await page.getByRole('spinbutton', { name: 'implement-review rounds', exact: true }).count(), 1)
    await page.getByRole('spinbutton', { name: 'Maximum turns', exact: true }).fill('2')
    t.ok('editing a limit disables Start in Chromium', await page.getByRole('button', { name: 'Start run', exact: true }).isDisabled())
    await page.getByRole('button', { name: 'Preview settings', exact: true }).click()
    await page.waitForSelector('text=maxSteps=2')
    t.ok('edited preview enables Start', await page.getByRole('button', { name: 'Start run', exact: true }).isEnabled())
    await page.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    await page.waitForSelector('text=maxSteps=120')

    // Back to the first step; the earlier choice is still marked there.
    await page.getByRole('button', { name: 'Change playbook', exact: true }).click()
    await page.waitForSelector('.pick--on:has-text("implementation")', { timeout: 5000 })
    t.ok('no start control on the choice step', await page.getByRole('button', { name: 'Start run', exact: true }).count() === 0)

    // The picker is a set of buttons, so it has to work from the keyboard.
    const reachable = await page.evaluate(() => {
      const first = document.querySelector('.pick')
      first.focus()
      return document.activeElement === first
    })
    t.ok('a playbook option can take focus', reachable)

    // Focus the last option and press Enter, as a keyboard user would. One
    // click (or Enter) is the choice: the dialog moves on to that playbook.
    const lastId = await page.evaluate(() => {
      const options = [...document.querySelectorAll('.pick')]
      options[options.length - 1].focus()
      return options[options.length - 1].querySelector('.pick__id').textContent
    })
    await page.keyboard.press('Enter')
    await page.waitForSelector('.chosen__id', { timeout: 5000 }).catch(() => {})
    const selectedByKeyboard = await page.evaluate(() => document.querySelector('.chosen__id')?.textContent ?? null)
    t.eq('and selecting it from the keyboard works', selectedByKeyboard, lastId)

    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await page.waitForSelector('text=Participants', { state: 'hidden', timeout: 10000 })
    const focusEscaped = await page.evaluate(() =>
      !document.activeElement || !document.activeElement.closest('.v-dialog'))
    t.ok('closing the dialog does not leave focus inside it', focusEscaped)
  }

  t.section('3. a live run, with long identifiers on screen')
  {
    await page.click('button:has-text("Run a playbook")')
    await page.waitForSelector('.pick', { timeout: 15000 })
    await page.click('.pick:has-text("implementation")')
    await page.waitForSelector('text=coordinator', { timeout: 15000 })
    await page.click('button:has-text("Start run")')

    await page.waitForSelector('text=running', { timeout: 30000 })
    const [live] = await stage.runs(issue.id)

    // Run ids are long. If the page cannot show one, it cannot be copied.
    const shown = await page.evaluate((id) => document.body.innerText.includes(id), live.runId)
    t.ok('the run id is fully readable', shown, live.runId)

    const box = await call(page, OVERFLOWS)
    t.ok('a live run does not make the page scroll sideways',
      box.scrollWidth <= box.clientWidth + 1, `${box.scrollWidth} > ${box.clientWidth}`)
    t.eq('and nothing is clipped', await call(page, CLIPPED), [])

    await page.waitForSelector('button:has-text("Stop run")', { timeout: 20000 })
    const stopBox = await page.locator('button:has-text("Stop run")').first().boundingBox()
    t.ok('the Stop control is visible and clickable',
      stopBox && stopBox.width > 40 && stopBox.height > 20,
      stopBox && `${Math.round(stopBox.width)}×${Math.round(stopBox.height)}`)

    await page.click('button:has-text("Stop run")')
    await page.waitForSelector('text=Stopping', { timeout: 20000 })
    const stopping = await page.locator('button:has-text("Stopping")').first()
    t.ok('the stopping control is disabled, not merely greyed', await stopping.isDisabled())
    await page.waitForSelector('text=cancelled', { timeout: 40000 })
  }

  t.section('3a. sections hide, stay hidden and give their height to the rest')
  {
    const sections = page.getByRole('group', { name: 'Sections', exact: true })
    const toggle = (name) => sections.getByRole('button', { name, exact: true })
    const pressed = (name) => toggle(name).getAttribute('aria-pressed')
    const box = (selector) => page.locator(selector).first().boundingBox()
    const hidden = (selector) => page.locator(selector).first().isHidden()
    const visible = (selector) => page.locator(selector).first().isVisible()
    const stored = (key) => page.evaluate((k) => localStorage.getItem(k), key)
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const lock = () => page.evaluate(() => {
      const el = document.querySelector('.issue')
      const style = getComputedStyle(el)
      return { height: parseFloat(style.height), expected: window.innerHeight - 60, overflow: style.overflowY }
    })
    const outcome = '.summary > section.block'

    // A fresh load: the folder, opened by itself while the issue had no run, is closed again.
    await page.goto(url)
    await page.locator('.summary').waitFor()
    t.eq('every section starts shown', await sections.locator('button[aria-pressed="false"]').count(), 0)
    await page.locator('.summary-entry', { hasText: 'Run summary' }).click()
    await page.locator(outcome).waitFor()
    const before = {
      detail: await box('.workspace__detail'), head: await box('.head'), runbar: await box('.runbar'),
      status: await box('.runcard > .status'), lock: await lock()
    }

    for (const name of ['Issue', 'Run picker', 'Status']) await toggle(name).click()
    await settle()
    t.ok('the issue card, run picker and status are hidden', await hidden('.head') && await hidden('.runbar') && await hidden('.runcard > .status'))
    t.eq('and their controls say so', [await pressed('Issue'), await pressed('Run picker'), await pressed('Status')], ['false', 'false', 'false'])
    const freed = await box('.workspace__detail')
    const gain = before.head.height + before.runbar.height + before.status.height
    t.ok('the step detail takes the height they freed', freed.height >= before.detail.height + gain - 2,
      `${Math.round(before.detail.height)} → ${Math.round(freed.height)}px, ${Math.round(gain)}px freed`)
    const locked = await lock()
    t.ok('the page is still locked to the window', locked.overflow === 'hidden' && locked.overflow === before.lock.overflow &&
      Math.abs(locked.height - before.lock.height) <= 1 && Math.abs(locked.height - locked.expected) <= 1, JSON.stringify(locked))

    await toggle('Steps').click()
    await settle()
    const wide = await box('.workspace__detail')
    const workspace = await box('.workspace')
    t.ok('hiding the steps gives their column to the detail', await hidden('.workspace__timeline') && wide.width >= workspace.width - 2,
      `${Math.round(wide.width)} of ${Math.round(workspace.width)}px`)

    // Measured inside the detail column, at the width it has now.
    const offset = async (selector) => (await box(selector)).y - (await box('.workspace__detail')).y
    const outcomeHeight = (await box(outcome)).height
    const techBefore = await offset('.tech')
    await toggle('Outcome').click()
    await settle()
    t.ok('Outcome hides on its own, the step detail stays', await hidden(outcome) && await visible('.workspace__detail') && await pressed('Step detail') === 'true')
    const techAfter = await offset('.tech')
    t.ok('and Technical details moves up into its room', techAfter <= techBefore - outcomeHeight + 2,
      `${Math.round(techBefore)} → ${Math.round(techAfter)}px, Outcome was ${Math.round(outcomeHeight)}px`)
    await toggle('Technical details').click()
    await settle()
    t.ok('Technical details hides', await hidden('.tech'))
    await toggle('Technical details').click()
    await settle()
    t.ok('and shows again without a reload', await visible('.tech'))

    t.eq('the choice is stored once, for every issue', await stored('devpanel.issue.hidden'), '["issue","runbar","status","timeline","outcome"]')
    await page.reload()
    await page.locator('.summary').waitFor()
    t.eq('a reload keeps them hidden', [await pressed('Issue'), await pressed('Run picker'), await pressed('Status'), await pressed('Steps'), await pressed('Outcome')],
      ['false', 'false', 'false', 'false', 'false'])
    t.ok('and the page shows that', await hidden('.head') && await hidden('.runbar') && await hidden('.runcard > .status') &&
      await hidden('.workspace__timeline') && await page.locator(outcome).count() === 1 && await hidden(outcome))

    const other = await stage.createIssue('Sections elsewhere')
    const otherUrl = `${stage.origin}/projects/${stage.project}/${other.id}`
    await page.goto(otherUrl)
    t.eq('another issue opens with the same choice', await pressed('Issue'), 'false')
    t.ok('its issue card hidden too', await hidden('.head'))

    await page.goto(url)
    await page.locator('.summary').waitFor()
    for (const name of ['Issue', 'Run picker', 'Status', 'Steps', 'Outcome']) await toggle(name).click()
    await settle()
    t.eq('every section shows again without a reload', await sections.locator('button[aria-pressed="false"]').count(), 0)
    t.ok('and is on the page', await visible('.head') && await visible('.runbar') && await visible('.runcard > .status') &&
      await visible('.workspace__timeline') && await visible(outcome))
    const back = await box('.workspace__detail')
    t.ok('the step detail is back to its height', Math.abs(back.height - before.detail.height) <= 2,
      `${Math.round(before.detail.height)} → ${Math.round(back.height)}px`)
    t.eq('and nothing is stored as hidden', await stored('devpanel.issue.hidden'), '[]')

    // The folder has its own control in the issue card; an explicit choice outlasts the page's default.
    const folder = page.locator('.head__folder-toggle')
    t.eq('the folder starts closed on an issue with runs', await folder.getAttribute('aria-expanded'), 'false')
    await folder.click()
    await page.locator('.head__folder').waitFor()
    t.eq('opening it is remembered', await stored('devpanel.issue.folder'), 'open')
    await page.reload()
    await page.locator('.head__folder').waitFor()
    t.eq('and survives a reload', await folder.getAttribute('aria-expanded'), 'true')
    await folder.click()
    await page.locator('.head__folder').waitFor({ state: 'hidden' })
    t.eq('closing it is remembered too', await stored('devpanel.issue.folder'), 'closed')
    await page.goto(otherUrl)
    await folder.waitFor()
    await sleep(400)
    t.eq('an issue without runs, which opens it by itself, keeps it closed', await folder.getAttribute('aria-expanded'), 'false')

    // Anything this page did not write is no choice: today's view.
    await page.evaluate(() => {
      localStorage.setItem('devpanel.issue.hidden', '["issue","bogus"]')
      localStorage.setItem('devpanel.issue.folder', 'garbage')
    })
    await page.reload()
    await page.locator('.head__folder').waitFor()
    t.eq('an unreadable record shows every section', await sections.locator('button[aria-pressed="false"]').count(), 0)
    t.ok('the issue card included', await visible('.head'))
    t.eq('and the folder opens by itself on an issue without runs, as before', await folder.getAttribute('aria-expanded'), 'true')

    // Without a run the run card holds only the status: hiding it leaves the
    // card nothing, and the issue card (with its folder) takes the height.
    // Folded first: open, the folder already overruns the page and the run card has no height to give.
    await folder.click()
    await page.locator('.head__folder').waitFor({ state: 'hidden' })
    const noRun = { head: await box('.head'), runcard: await box('.runcard') }
    await toggle('Status').click()
    await settle()
    t.ok('hiding the only thing in the run card takes the card away', await hidden('.runcard'))
    const grown = await box('.head')
    const floor = await page.evaluate(() => {
      const el = document.querySelector('.issue')
      return el.getBoundingClientRect().bottom - parseFloat(getComputedStyle(el).paddingBottom)
    })
    t.ok('and the issue card takes its height, down to the bottom of the page',
      grown.height >= noRun.head.height + noRun.runcard.height - 2 && Math.abs(grown.y + grown.height - floor) <= 2,
      `${Math.round(noRun.head.height)} → ${Math.round(grown.height)}px, run card was ${Math.round(noRun.runcard.height)}px`)
    await folder.click()
    await page.locator('.head__folder').waitFor()
    const folded = await box('.head')
    t.ok('the opened folder stays inside it', Math.abs(folded.y + folded.height - floor) <= 2 && await page.locator('.head').evaluate((el) => getComputedStyle(el).overflowY) === 'auto')
    await folder.click()
    await page.locator('.head__folder').waitFor({ state: 'hidden' })
    const stillLocked = await lock()
    t.ok('with the page still locked to the window', stillLocked.overflow === 'hidden' && Math.abs(stillLocked.height - stillLocked.expected) <= 1, JSON.stringify(stillLocked))
    await toggle('Status').click()
    await settle()
    const restored = { head: await box('.head'), runcard: await box('.runcard') }
    t.ok('showing the status again brings the layout back', await visible('.runcard') &&
      Math.abs(restored.head.height - noRun.head.height) <= 2 && Math.abs(restored.runcard.height - noRun.runcard.height) <= 2,
      `head ${Math.round(restored.head.height)}px, run card ${Math.round(restored.runcard.height)}px`)

    await page.evaluate(() => {
      localStorage.removeItem('devpanel.issue.hidden')
      localStorage.removeItem('devpanel.issue.folder')
    })
    await page.goto(url)
    await page.waitForSelector('text=Layout under test', { timeout: 20000 })
  }

  t.section('4. a phone-width viewport')
  {
    await page.setViewportSize({ width: 390, height: 844 })
    await sleep(400)

    const box = await call(page, OVERFLOWS)
    t.ok('the page still does not scroll sideways',
      box.scrollWidth <= box.clientWidth + 1, `${box.scrollWidth} > ${box.clientWidth}`)

    const gutter = await page.evaluate(() => {
      const el = document.querySelector('.issue')
      const rect = el.getBoundingClientRect()
      return { left: rect.left, right: window.innerWidth - rect.right }
    })
    t.ok('content keeps a side gutter', gutter.left >= 0 && gutter.right >= -1,
      `${Math.round(gutter.left)} / ${Math.round(gutter.right)}`)

    await page.click('button:has-text("Run a playbook")')
    await page.waitForSelector('.pick', { timeout: 15000 })
    const card = await page.locator('.v-dialog .v-card').first().boundingBox()
    t.ok('the dialog fits a phone', card.width <= 390, `${Math.round(card.width)}px`)
    await page.click('.pick:has-text("implementation")')
    await page.waitForSelector('text=Settings for this run', { timeout: 15000 })
    await page.locator('.advanced__summary').click()
    await page.getByRole('spinbutton', { name: 'Maximum turns', exact: true }).scrollIntoViewIfNeeded()
    const field = await page.getByRole('spinbutton', { name: 'Maximum turns', exact: true }).boundingBox()
    t.ok('run settings fit a phone', field.x >= 0 && field.x + field.width <= 390)
    const startButton = await page.getByRole('button', { name: 'Start run', exact: true }).boundingBox()
    t.ok('Start remains reachable while editing on a phone', startButton.y + startButton.height <= page.viewportSize().height)
    t.eq('and is not clipped', await call(page, CLIPPED), [])
    await page.keyboard.press('Escape')
  }

  t.section('5. both themes paint')
  {
    await page.setViewportSize({ width: 1280, height: 800 })
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme })
      await sleep(300)
      const painted = await page.evaluate(() => {
        const body = getComputedStyle(document.body)
        return { bg: body.backgroundColor, fg: body.color }
      })
      t.ok(`${scheme}: the body has an explicit background`,
        painted.bg !== 'rgba(0, 0, 0, 0)' && painted.bg !== 'transparent', painted.bg)
      t.ok(`${scheme}: and readable text on it`, painted.fg !== painted.bg, painted.fg)
    }
  }

  t.section('6. archive and restore at phone width')
  {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Close issue', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason for closing without a disposition').fill('layout test: no disposition')
    const box = await dialog.locator('.v-card').first().boundingBox()
    t.ok('the reason dialog fits a phone', box.width <= 390, `${box.width}px`)
    await dialog.getByRole('button', { name: 'Close issue', exact: true }).click()
    await page.waitForURL(`${stage.origin}/projects/${stage.project}`)
    t.eq('Close archives once a reason is given', (await stage.request(`/api/projects/${stage.project}/issues/${issue.id}`)).body.archived, true)
    await page.getByRole('tab', { name: 'Archived issues', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Layout under test' }).click()
    await page.getByText('Archived issue. All files have been preserved.').waitFor()
    t.eq('archived issue hides run-start controls', await page.getByRole('button', { name: 'Run a playbook', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Restore issue', exact: true }).click()
    await page.getByRole('button', { name: 'Close issue', exact: true }).waitFor()
    t.eq('restored issue is active again', (await stage.request(`/api/projects/${stage.project}/issues/${issue.id}`)).body.archived, false)
    t.eq('only one playbook action on an issue with runs', await page.getByRole('button', { name: 'Run a playbook', exact: true }).count(), 1)
    await page.goto(`${stage.origin}/projects/${stage.project}`)
    const before = (await stage.request(`/api/projects/${stage.project}/issues`)).body.length
    await page.getByRole('button', { name: 'New issue', exact: true }).waitFor()
    t.eq('New issue lives beside the list tabs', await page.locator('.issues__navigation .issues__tools').getByRole('button', { name: 'New issue', exact: true }).count(), 1)
    t.eq('there is only one New issue button', await page.getByRole('button', { name: 'New issue', exact: true }).count(), 1)
    t.eq('list reload lives beside the tabs', await page.locator('.issues__navigation .issues__tools').getByRole('button', { name: 'Reload issues', exact: true }).count(), 1)
    t.eq('list actions are absent from the application bar', await page.locator('#appbar-actions button').count(), 0)
    t.eq('New issue is outside the list frame', await page.locator('.issues__card').getByRole('button', { name: 'New issue', exact: true }).count(), 0)
    await page.setViewportSize({ width: 1280, height: 800 })
    const tabs = await page.locator('.issues__tabs').boundingBox()
    const tools = await page.locator('.issues__tools').boundingBox()
    t.ok('list actions align opposite the tabs', tools.x >= tabs.x + tabs.width && Math.abs((tools.y + tools.height / 2) - (tabs.y + tabs.height / 2)) < 2)
    await page.setViewportSize({ width: 390, height: 844 })
    // Layout settles a frame or two after the viewport change; measuring
    // before that reads the desktop layout at phone width.
    await page.waitForFunction(() => window.innerWidth === 390)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const listWidth = await call(page, OVERFLOWS)
    t.ok('list navigation fits on a phone', listWidth.scrollWidth <= listWidth.clientWidth + 1)
    await page.getByRole('button', { name: 'New issue', exact: true }).first().click()
    await dialog.waitFor({ state: 'visible' })
    t.eq('new issue dialog has a close X', await dialog.getByRole('button', { name: 'Close dialog', exact: true }).count(), 1)
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    t.eq('new issue X cancels without creating an issue', (await stage.request(`/api/projects/${stage.project}/issues`)).body.length, before)
  }

  t.section('7. the dashboard overview with an agent working')
  {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ colorScheme: 'light' })

    const watched = await stage.createIssue('Overview layout')
    await stage.setControl({ delayMs: 20000, hangOnAbortMs: 200 })
    await stage.request(`/api/projects/${stage.project}/issues/${watched.id}/runs`, {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })

    await page.goto(stage.origin)
    // Scoped to the page: the app bar's running-agents strip names the same run.
    await page.locator('main').getByText('Overview layout').waitFor({ timeout: 40000 })
    await page.locator('main').getByText('coordinator', { exact: true }).waitFor({ timeout: 40000 })

    const box = await call(page, OVERFLOWS)
    t.ok('the overview does not make the page scroll sideways',
      box.scrollWidth <= box.clientWidth + 1, `${box.scrollWidth} > ${box.clientWidth}`)
    t.eq('and nothing in it is clipped', await call(page, CLIPPED), [])

    // Model names and step ids are long; at phone width they have to wrap rather
    // than be cut, because there is nowhere else on this page to read them.
    await page.setViewportSize({ width: 390, height: 844 })
    await sleep(400)
    const narrow = await call(page, OVERFLOWS)
    t.ok('nor at phone width', narrow.scrollWidth <= narrow.clientWidth + 1,
      `${narrow.scrollWidth} > ${narrow.clientWidth}`)
    t.eq('with nothing clipped there either', await call(page, CLIPPED), [])

    await page.setViewportSize({ width: 1280, height: 800 })
    const [live] = await stage.runs(watched.id)
    await stage.request(
      `/api/projects/${stage.project}/issues/${watched.id}/runs/${live.runId}/stop`, { method: 'POST' })
  }

  t.section('8. formatted Markdown at desktop and phone widths')
  {
    const noteIssue = await stage.createIssue('Formatted Markdown')
    const text = '# Readable report\n\nA **clear result** with `inline code`.\n\n- First\n- Second\n\n| Criterion | Result |\n| --- | --- |\n| AC1 | Passed |\n\n```text\n' + 'long_code_'.repeat(40) + '\n```\n'
    await stage.request(`/api/projects/${stage.project}/issues/${noteIssue.id}/steps`, {
      method: 'POST', body: JSON.stringify({ name: 'markdown sample', text })
    })
    await page.goto(`${stage.origin}/projects/${stage.project}/${noteIssue.id}`)
    await page.locator('.material__row').filter({ hasText: 'markdown sample' }).click()
    await page.waitForSelector('.markdown-content h1')
    t.ok('Markdown headings use the formatted view', await page.locator('.markdown-content h1').count() > 0)
    t.eq('Markdown tables are real tables', await page.locator('.markdown-content table').count(), 1)
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 })
      await page.locator('.markdown-content').scrollIntoViewIfNeeded()
      const size = await call(page, OVERFLOWS)
      t.ok(`formatted Markdown stays within ${width}px`, size.scrollWidth <= size.clientWidth + 1)
      const code = await page.locator('.markdown-content pre').evaluate((el) => ({
        scroll: el.scrollWidth, width: el.clientWidth, overflow: getComputedStyle(el).overflowX
      }))
      t.ok(`long code scrolls inside its block at ${width}px`, code.scroll > code.width && code.overflow === 'auto')
    }
    await page.getByRole('button', { name: 'Raw text', exact: true }).click()
    await page.waitForSelector('.markdown-raw')
    t.ok('raw view is available on a phone', (await page.locator('.markdown-raw').textContent()).includes('# Readable report'))
    await page.getByRole('button', { name: 'Formatted', exact: true }).click()
    await page.waitForSelector('.markdown-content table')
    await page.screenshot({ path: path.join(os.tmpdir(), 'devpanel-markdown-phone.png'), fullPage: true })
  }

  t.section('8a. every route, issue state and dialog at phone and tablet widths')
  {
    const p = stage.project
    const LIVE = ['preflighting', 'pending', 'running', 'stopping']
    const until = async (what, fn, ms = 60000) => {
      const end = Date.now() + ms
      for (;;) {
        const value = await fn()
        if (value) return value
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await sleep(250)
      }
    }
    const settle = (pg) => pg.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const start = async (id) => {
      const { status, body } = await stage.request(`/api/projects/${p}/issues/${id}/runs`, {
        method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
      })
      if (status >= 300) throw new Error(`start refused (${status}): ${JSON.stringify(body)}`)
      return body.runId
    }
    const settled = (id, runId, test) => until(`a run of ${id}`, async () => {
      const r = await stage.run(id, runId)
      return r && test(r) ? r : null
    })

    // Section 7 stopped its run without waiting, and a project holds one live run at a time.
    await until('no live run in the project', async () =>
      (await stage.request(`/api/projects/${p}/issues`)).body.every((i) => !i.latestRun?.live))

    // One issue per state the issue page draws differently. Each run settles
    // (or pauses) before the next starts; the running one comes last.
    await stage.setControl({ delayMs: 0, script: { needsInput: 'Which of the two storage layouts should the import keep?' } })
    const owner = await stage.createIssue('Owner input on a phone')
    await settled(owner.id, await start(owner.id), (r) => !LIVE.includes(r.status) && r.ownerInput)

    await stage.setControl({
      delayMs: 0,
      script: {
        operatorRequest: {
          stepId: 'brief-implement',
          request: {
            question: 'Commit the live checkout so a run can be cut from a base commit?',
            reason: 'The checkout has uncommitted changes the candidate must be measured against.',
            projectAction: 'push',
            category: 'live-checkout',
            recommendation: 'Run the push action, then answer with the commit.'
          }
        }
      }
    })
    const asked = await stage.createIssue('A question on a phone')
    const question = await settled(asked.id, await start(asked.id), (r) => r.status === 'paused')
    t.eq('a run waits on a question for the operator', [question.pause?.kind, question.pause?.options ?? null], ['operator-request', null])

    await stage.setControl({ delayMs: 3000, hangOnAbortMs: 200, script: {} })
    const held = await stage.createIssue('Paused on a phone')
    const heldRun = await start(held.id)
    await settled(held.id, heldRun, (r) => r.status === 'running')
    await stage.request(`/api/projects/${p}/issues/${held.id}/runs/${heldRun}/pause`, { method: 'POST' })
    await settled(held.id, heldRun, (r) => r.status === 'paused')

    const noRun = await stage.createIssue('A phone-width issue whose long title has to wrap rather than push the page sideways')

    const packed = await stage.createIssue('Packed on a phone')
    await stage.request(`/api/projects/${p}/issues/${packed.id}/archive`, {
      method: 'POST', body: JSON.stringify({ overrideReason: 'layout test' })
    })
    t.eq('closing an issue packs it', (await stage.request(`/api/projects/${p}/issues/${packed.id}`)).body.packed, true)

    // Archived but still a folder (archived before packing existed): the marker
    // the server writes, and nothing packs it afterwards.
    await stage.setControl({ delayMs: 0, script: {} })
    const shelved = await stage.createIssue('Archived, not packed, on a phone')
    await settled(shelved.id, await start(shelved.id), (r) => !LIVE.includes(r.status) && r.status !== 'paused')
    await fs.writeFile(path.join(stage.issuesDir, p, shelved.id, '.archive.json'),
      JSON.stringify({ archivedAt: new Date().toISOString(), override: { reason: 'layout test' } }))
    const shelf = (await stage.request(`/api/projects/${p}/issues/${shelved.id}`)).body
    t.eq('an archived issue that is not packed', [shelf.archived, Boolean(shelf.packed)], [true, false])

    await stage.setControl({ delayMs: 600000, hangOnAbortMs: 200, script: {} })
    const live = await stage.createIssue('Running on a phone')
    const liveRun = await start(live.id)
    await settled(live.id, liveRun, (r) => r.status === 'running' && r.active?.length)

    const STATES = [
      ['no run', noRun.id, '.status--neutral'],
      ['running', live.id, '.live-detail'],
      ['paused', held.id, '.runbar'],
      ['asking', asked.id, '.answer'],
      ['owner input', owner.id, '.owner'],
      ['ended', issue.id, '.summary'],
      ['archived', shelved.id, '.istats'],
      ['packed', packed.id, '.packed__list']
    ]
    const ROUTES = [
      { name: 'dashboard', path: '/', ready: '.dash__title', root: '.dash' },
      { name: 'project', path: `/projects/${p}`, ready: '.issues__name', root: '.issues' },
      { name: 'archived list', path: `/projects/${p}?archived=true`, ready: '.issues__name', root: '.issues' },
      ...STATES.map(([state, id, ready]) => ({ name: `issue ${state}`, state, path: `/projects/${p}/${id}`, ready, root: '.issue' })),
      { name: 'supervisor', path: '/supervisor', ready: '.supervisor .status-label', root: '.supervisor' },
      { name: 'models', path: '/models', ready: '.models__title', root: '.models' },
      { name: 'not found', path: '/no/such/page', ready: '.notfound .empty__title', root: '.notfound' }
    ]
    const route = (state) => ROUTES.find((r) => r.state === state)

    const visit = async (pg, r) => {
      await pg.goto(stage.origin + r.path)
      await pg.locator(r.ready).first().waitFor({ timeout: 20000 })
      await settle(pg)
    }
    const fits = async (pg) => {
      const box = await call(pg, OVERFLOWS)
      return box.scrollWidth <= box.clientWidth + 1 ? null : `${box.scrollWidth} > ${box.clientWidth}`
    }
    const button = (pg, name) => pg.getByRole('button', { name, exact: true })
    // Scrolled to, then wholly inside the window.
    const onScreen = async (pg, locator) => {
      const target = locator.first()
      if (!await target.count()) return 'missing'
      await target.scrollIntoViewIfNeeded()
      const b = await target.boundingBox()
      const width = await pg.evaluate(() => document.documentElement.clientWidth)
      const height = pg.viewportSize().height
      return b && b.x >= -1 && b.x + b.width <= width + 1 && b.y >= -1 && b.y + b.height <= height + 1
        ? null : `off screen ${JSON.stringify(b)}`
    }

    // What each page is for, still there and reachable at this width.
    const purpose = async (pg, r, width) => {
      const bad = []
      const note = (what, problem) => { if (problem) bad.push(`${what}: ${problem}`) }
      if (r.state === 'running') {
        const [timeline, detail, workspace, terminal] = await Promise.all(
          ['.workspace__timeline', '.workspace__detail', '.workspace', '.live-detail'].map((s) => pg.locator(s).first().boundingBox()))
        if (width <= 800 && !(detail.y >= timeline.y + timeline.height - 1 &&
            timeline.width >= workspace.width - 2 && detail.width >= workspace.width - 2)) bad.push('steps and detail do not stack')
        const clientWidth = await pg.evaluate(() => document.documentElement.clientWidth)
        if (!terminal || terminal.x + terminal.width > clientWidth + 1) bad.push(`terminal ${JSON.stringify(terminal)}`)
        note('Stop run', await onScreen(pg, button(pg, 'Stop run')))
      }
      if (r.state === 'owner input') note('Answer and start', await onScreen(pg, button(pg, 'Answer and start')))
      if (r.state === 'asking') {
        if (!await pg.locator('.answer').isVisible() || !await pg.getByLabel('Answer', { exact: true }).count()) bad.push('no answer form')
        note('Send answer and continue', await onScreen(pg, button(pg, 'Send answer and continue')))
      }
      if (r.state === 'archived') {
        const sections = pg.getByRole('group', { name: 'Sections', exact: true })
        if (!await sections.getByRole('button', { name: 'Time spent', exact: true }).count()) bad.push('no Time spent section')
        if (!await pg.locator('.istats').isVisible()) bad.push('no time spent card')
        if (!await pg.locator('.runcard:not(.packed)').count() || await pg.locator('.packed').count()) bad.push('not the ordinary run card')
        note('Restore issue', await onScreen(pg, button(pg, 'Restore issue')))
      }
      if (r.state === 'packed' && !await pg.locator('.packed').isVisible()) bad.push('no packed results')
      if (r.name === 'project') {
        const rows = await pg.locator('.v-data-table__tr--mobile').count()
        if (width < 600) {
          const table = await pg.locator('.issues__table .v-table__wrapper').evaluate((el) => ({
            scroll: el.scrollWidth, width: el.clientWidth, box: el.getBoundingClientRect().toJSON(),
            row: el.querySelector('tbody tr')?.getBoundingClientRect().toJSON()
          }))
          if (!rows) bad.push('rows are not stacked')
          if (table.scroll > table.width + 1) bad.push(`the list scrolls sideways ${table.scroll} > ${table.width}`)
          if (!table.row || table.row.top < table.box.top - 1 || table.row.bottom > table.box.bottom + 1 ||
              table.row.bottom > pg.viewportSize().height + 1) bad.push('the first issue is not in view')
        } else if (rows) bad.push('stacked rows on a wide screen')
      }
      if (r.name === 'supervisor') note('Start supervisor', await onScreen(pg, button(pg, 'Start supervisor')))
      return bad
    }

    const sweep = async (pg, signin, width, height, coarse) => {
      const found = { overflow: [], offscreen: [], gutter: [], purpose: [], small: [] }
      const measure = async (target, name, root) => {
        const over = await fits(target)
        if (over) found.overflow.push(`${name}: ${over}`)
        for (const c of await call(target, OFFSCREEN, 'body')) found.offscreen.push(`${name}: ${c}`)
        const left = await target.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().left ?? -1, root)
        if (left < 0) found.gutter.push(`${name}: left ${Math.round(left)}`)
        if (coarse) for (const c of await call(target, SMALL_TARGETS, 'body')) found.small.push(`${name}: ${c}`)
      }
      await signin.setViewportSize({ width, height })
      await signin.goto(stage.origin)
      await signin.locator('.signin__card').waitFor({ timeout: 20000 })
      await settle(signin)
      await measure(signin, 'sign-in', '.signin')
      await pg.setViewportSize({ width, height })
      for (const r of ROUTES) {
        await visit(pg, r)
        await measure(pg, r.name, r.root)
        for (const c of await purpose(pg, r, width)) found.purpose.push(`${r.name}: ${c}`)
      }
      const label = `${coarse ? 'touch' : 'mouse'} ${width}×${height}`
      t.eq(`${label}: no page scrolls sideways`, found.overflow, [])
      t.eq(`${label}: every control is on screen, or in a box that scrolls on screen`, found.offscreen, [])
      t.eq(`${label}: content keeps its left edge`, found.gutter, [])
      t.eq(`${label}: each issue state and page still offers what it is for`, found.purpose, [])
      if (coarse) t.eq(`${label}: every tap target is at least 44px`, found.small, [])
    }

    // Dialogs and menus at the narrowest width: on screen, every control
    // inside, focus out on close. Nothing is submitted.
    const overlay = '.v-overlay--active'
    const dialogs = async (pg, coarse) => {
      await pg.setViewportSize({ width: 360, height: 800 })
      const bad = []
      const check = async (what, box) => {
        // Dialogs and menus scale in; measured mid-way, everything is smaller.
        await pg.waitForFunction(() => [...document.querySelectorAll('.v-overlay--active .v-overlay__content')]
          .every((el) => el.getAnimations({ subtree: true })
            .every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)))
        const width = await pg.evaluate(() => document.documentElement.clientWidth)
        const b = await pg.locator(`${overlay} ${box}`).first().boundingBox()
        if (!b || b.x < -1 || b.x + b.width > width + 1 || b.y < -1 || b.y + b.height > pg.viewportSize().height + 1) {
          bad.push(`${what}: ${JSON.stringify(b)}`)
        }
        for (const c of await call(pg, OFFSCREEN, overlay)) bad.push(`${what}: ${c}`)
        if (coarse) for (const c of await call(pg, SMALL_TARGETS, overlay)) bad.push(`${what}: ${c}`)
      }
      // The open one: a dialog Vuetify has shown once stays in the page, hidden.
      const dialog = pg.locator('.v-dialog.v-overlay--active')
      const close = async (what, name) => {
        const target = button(dialog, name).first()
        const problem = await onScreen(pg, target)
        if (problem) bad.push(`${what}: ${name} ${problem}`)
        await target.click({ timeout: 5000 }).catch(() => pg.keyboard.press('Escape'))
        await pg.waitForFunction(() => !document.querySelector('.v-dialog.v-overlay--active'))
        if (!await pg.evaluate(() => !document.activeElement || !document.activeElement.closest('.v-dialog'))) bad.push(`${what}: focus stayed in the dialog`)
      }

      await visit(pg, route('no run'))
      await button(pg, 'Run a playbook').click()
      await pg.locator('.pick').first().waitFor({ timeout: 15000 })
      await check('start a run', '.v-card')
      await pg.click('.pick:has-text("implementation")')
      await pg.waitForSelector('text=Settings for this run', { timeout: 15000 })
      const startProblem = await onScreen(pg, button(pg, 'Start run'))
      if (startProblem) bad.push(`Start run: ${startProblem}`)
      await check('start a run, settings', '.v-card')
      await close('start a run', 'Close dialog')

      await button(pg, 'Close issue').click()
      await dialog.waitFor()
      await check('close issue', '.v-card')
      await close('close issue', 'Cancel')

      await visit(pg, route('paused'))
      await button(pg, 'Resume run').click()
      await dialog.waitFor()
      await check('resume', '.v-card')
      await close('resume', 'Cancel')

      // The integrity and Continue dialogs open from the run's own record; it is
      // read here with those actions added, and the inspection is answered.
      const [ended] = await stage.runs(issue.id)
      const runUrl = new RegExp(`/api/projects/${p}/issues/${issue.id}/runs/${ended.runId}$`)
      const integrityUrl = new RegExp(`/api/projects/${p}/issues/${issue.id}/runs/${ended.runId}/integrity$`)
      const withActions = async (r) => {
        const response = await r.fetch()
        const json = await response.json()
        json.supportedActions = [...new Set([...(json.supportedActions ?? []), 'resolve-integrity', 'continue'])]
        await r.fulfill({ response, json })
      }
      const inspection = (r) => r.fulfill({
        json: {
          role: 'implementer', reason: 'workspace changed outside the turn',
          workspace: `${stage.issuesDir}/${p}/${issue.id}/runs/${ended.runId}/a-workspace-path-long-enough-to-wrap`,
          restored: false,
          changes: { pathCount: 40, head: true, index: true, paths: Array.from({ length: 30 }, (_, i) => `gui/src/components/a-rather-long-component-name-${i}.vue`) },
          dispositions: ['accept-partial', 'restored', 'abandon'],
          stateHash: 'layout-test'
        }
      })
      await pg.route(runUrl, withActions)
      await pg.route(integrityUrl, inspection)
      await visit(pg, route('ended'))
      await button(pg, 'Inspect changes').click()
      await pg.getByText('Changes the integrity check held back').waitFor()
      await pg.getByText('Keep partial work and continue').waitFor()
      await check('integrity', '.v-card')
      await close('integrity', 'Cancel')
      await button(pg, 'Continue playbook').click()
      await dialog.waitFor()
      await check('continue', '.v-card')
      await close('continue', 'Cancel')
      await pg.unroute(runUrl, withActions)
      await pg.unroute(integrityUrl, inspection)

      await visit(pg, ROUTES[1])
      await button(pg, 'New issue').click()
      await dialog.waitFor()
      await check('new issue', '.v-card')
      await close('new issue', 'Close dialog')

      for (const [i, what] of ['supervisor menu', 'agents menu'].entries()) {
        await pg.locator('.app-status .chip').nth(i).click()
        await pg.locator(`${overlay} .drop`).waitFor()
        await check(what, '.drop')
        await pg.keyboard.press('Escape')
        await pg.locator(`${overlay} .drop`).waitFor({ state: 'hidden' })
      }

      await button(pg, 'Show navigation').click()
      // Measured once it has slid in, not on the way.
      await pg.waitForFunction(() => document.querySelector('.v-navigation-drawer--active')?.getBoundingClientRect().left >= 0)
      await settle(pg)
      for (const c of await call(pg, OFFSCREEN, '.v-navigation-drawer--active')) bad.push(`navigation: ${c}`)
      if (coarse) for (const c of await call(pg, SMALL_TARGETS, '.v-navigation-drawer--active')) bad.push(`navigation: ${c}`)
      // Beside the drawer: its middle is under the drawer itself.
      await pg.locator('.v-navigation-drawer__scrim').click({ position: { x: 340, y: 400 } })
      await pg.locator('.v-navigation-drawer--active').waitFor({ state: 'hidden' })

      t.eq(`${coarse ? 'touch' : 'mouse'} 360: dialogs, menus and the navigation fit and keep their controls in reach`, bad, [])
    }

    // A pointer: phone and tablet widths, every route and state.
    const signinContext = await chrome.browser.newContext()
    const signin = await signinContext.newPage()
    signin.on('pageerror', (e) => problems.push(String(e.message)))
    for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1024, 768]]) {
      await sweep(page, signin, width, height, false)
    }

    // The 44px rule is for touch; a mouse keeps the compact controls.
    await page.setViewportSize({ width: 390, height: 844 })
    await visit(page, route('ended'))
    const mouse = await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches,
      toggle: Math.round(document.querySelector('.section-toggle').getBoundingClientRect().height)
    }))
    t.ok('a mouse keeps the compact section toggles', !mouse.coarse && mouse.toggle < 44, JSON.stringify(mouse))

    // Either side of the workspace stack (800), the height lock (1100) and the
    // drawer's own switch (1145).
    for (const state of ['running', 'ended']) {
      const seen = []
      for (const width of [800, 801, 1099, 1100, 1144, 1145]) {
        await page.setViewportSize({ width, height: 800 })
        await visit(page, route(state))
        const over = await fits(page)
        const shape = await page.evaluate(() => {
          const issue = getComputedStyle(document.querySelector('.issue'))
          return {
            columns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length,
            overflow: issue.overflowY, height: parseFloat(issue.height), expected: window.innerHeight - 60
          }
        })
        const locked = shape.overflow === 'hidden' && Math.abs(shape.height - shape.expected) <= 1
        if (over) seen.push(`${width}: ${over}`)
        if (shape.columns !== (width <= 800 ? 1 : 2)) seen.push(`${width}: ${shape.columns} columns`)
        if (locked !== (width >= 1100)) seen.push(`${width}: ${locked ? 'locked' : 'not locked'} ${JSON.stringify(shape)}`)
      }
      t.eq(`issue ${state}: stacks at 800, is locked from 1100, fits either side of 800, 1100 and 1145`, seen, [])
    }

    await dialogs(page, false)

    // A touch screen: phone and tablet, every route and state, and 44px targets.
    const touch = await chrome.browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true })
    const tap = await touch.newPage()
    tap.on('pageerror', (e) => problems.push(String(e.message)))
    const touchSignin = await (await chrome.browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true })).newPage()
    touchSignin.on('pageerror', (e) => problems.push(String(e.message)))
    await tap.goto(stage.origin)
    await tap.evaluate(([token]) => sessionStorage.setItem('devpanel.token', token), [stage.token])
    t.ok('a touch screen is emulated: the pointer is coarse', await tap.evaluate(() => matchMedia('(pointer: coarse)').matches) &&
      await touchSignin.evaluate(() => matchMedia('(pointer: coarse)').matches), 'hasTouch')
    for (const [width, height] of [[360, 800], [768, 1024]]) {
      await sweep(tap, touchSignin, width, height, true)
    }
    await dialogs(tap, true)

    await stage.request(`/api/projects/${p}/issues/${live.id}/runs/${liveRun}/stop`, { method: 'POST' })
    await settled(live.id, liveRun, (r) => !LIVE.includes(r.status))
    await stage.setControl({ delayMs: 0, script: {} })
    await touchSignin.context().close()
    await touch.close()
    await signinContext.close()
    await page.setViewportSize({ width: 1280, height: 800 })
  }

  t.section('8b. a notice on the project page is as tall as its text')
  {
    // Vuetify's alert carries flex: 1 1; in the page's column a one-line notice grew to half of the page's height.
    const lock = (module, suffix) => ({ module, owner: stage.project, runId: `2026-01-01T00-00-00-000Z-${suffix}`, project: stage.project, issueId: '2026-01-01-holder', state: 'held', waiting: false })
    const held = [...['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((name) => lock(`@pool-modules/${name}`, 'aaaaaaaa')), lock('@pool-modules/ten', 'bbbbbbbb')]
    const fulfil = (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ pool: stage.project, members: [stage.project], held }) })
    await page.route('**/module-locks*', fulfil)
    await page.goto(`${stage.origin}/projects/${stage.project}`)
    const notice = page.locator('[data-test="module-locks"]')
    await notice.waitFor()
    const closed = await notice.boundingBox()
    t.ok('ten held modules of two runs are one line', closed.height < 60 && /10 modules held by 2 runs/.test(await notice.innerText()), `${Math.round(closed.height)} px: ${(await notice.innerText()).slice(0, 120)}`)
    t.eq('the modules are not listed until it is opened', await page.locator('[data-test="module-locks-run"]').first().isVisible(), false)
    await notice.locator('summary').click()
    t.eq('opened, it lists the modules by run', [await page.locator('[data-test="module-locks-run"]').count(), await page.locator('[data-test="module-locks-run"]').first().isVisible()], [2, true])
    t.ok('and is as tall as that list, not as the page', (await notice.boundingBox()).height < 260, `${Math.round((await notice.boundingBox()).height)} px`)
    await page.unroute('**/module-locks*', fulfil)
  }

  t.section('8c. the Full verification page follows a running drive like a terminal')
  {
    const cycle = { id: '2026-01-01.1', date: '2026-01-01', trigger: 'hand', state: 'running', verdict: null, frozenAt: '2026-01-01T00:00:00.000Z', seatsIdleAt: '2026-01-01T00:01:00.000Z', endedAt: null, waitingOn: [], resumed: [], projects: [
      { project: 'app-project', stage: 'stage', mode: 'instance', state: 'running', startedAt: '2026-01-01T00:01:01.000Z', runDir: '/nowhere', instance: { name: 'dp-fv-app', readyMs: 120000 } },
      { project: 'framework-project', stage: 'stage', state: 'deferred' }] }
    const commands = [{ key: 'full-verification/ready', id: 'ready', rerun: false, running: false, bytes: 10, changedAt: '2026-01-01T00:03:00Z' }, { key: 'full-verification/full-suite', id: 'full-suite', rerun: false, running: true, bytes: 100, changedAt: '2026-01-01T00:04:00Z' }]
    let reads = 0
    const latest = (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ cycle, active: true }) })
    const output = (route) => {
      const url = new URL(route.request().url())
      const key = url.searchParams.get('command')
      if (!key) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ commands, output: null }) })
      const after = Number(url.searchParams.get('after') ?? 0)
      const text = key.endsWith('ready') ? '$ ready\n\n12/12 READY\n' : after === 0 ? '$ suite\n\nworker: PASS first\n' : `worker: PASS later-${++reads}\n`
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ commands, output: { key, text: key.endsWith('ready') && after > 0 ? '' : text, next: after + Buffer.byteLength(text), running: !key.endsWith('ready'), truncated: false, restarted: false } }) })
    }
    await page.route('**/api/verification/latest', latest)
    await page.route('**/api/verification/output*', output)
    await page.goto(`${stage.origin}/verification`)
    const terminal = page.locator('[data-test="cycle-output"] pre')
    await terminal.waitFor()
    t.ok('the drawer leads to the page', await page.locator('a[href="/verification"]').first().isVisible())
    t.eq('an entry the cycle drives has a terminal, one it holds back has none', [await page.locator('[data-test="cycle-entry"]').count(), await page.locator('[data-test="cycle-output"]').count()], [2, 1])
    await page.waitForFunction(() => /worker: PASS later-\d+/.test(document.querySelector('[data-test="cycle-output"] pre')?.textContent ?? ''), null, { timeout: 15000 })
    const shown = await terminal.innerText()
    t.ok('it shows the running command from its first line and what was printed since', shown.includes('$ suite') && shown.includes('worker: PASS first') && /later-\d+/.test(shown), shown.slice(0, 200))
    await page.locator('[data-test="cycle-output"] .v-chip', { hasText: 'ready' }).click()
    await page.waitForFunction(() => (document.querySelector('[data-test="cycle-output"] pre')?.textContent ?? '').includes('12/12 READY'), null, { timeout: 10000 })
    t.ok('a finished command can be read by choosing it, which stops following', (await terminal.innerText()).includes('12/12 READY') && !(await terminal.innerText()).includes('worker: PASS'))
    await page.unroute('**/api/verification/latest', latest)
    await page.unroute('**/api/verification/output*', output)
  }

  t.section('9. the console stayed quiet')
  t.eq('no request was refused but the token-less identity probe',
    unauthorised.filter((u) => !u.probe).map((u) => u.path), [])
  {
    // One "Failed to load resource … 401" line per expected probe, no more.
    let expected = unauthorised.filter((u) => u.probe).length
    const rest = problems.filter((p) => !/favicon/i.test(p))
      .filter((p) => !(/status of 401/.test(p) && expected-- > 0))
    t.eq('no page errors', rest, [])
  }

  await context.close()
  await closeChromium()
  await stage.stop()
}
