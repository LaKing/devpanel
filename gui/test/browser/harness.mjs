import fs from 'node:fs/promises'
import { JSDOM, VirtualConsole } from 'jsdom'

import { buildApp } from './build.mjs'

/*
 * A browser, scripted.
 *
 * The page is the real built application talking to a real server process over
 * a real socket. Nothing about the client is stubbed: what these tests assert is
 * what a person would see. Only the window itself is synthetic.
 */

/*
 * `local`: localStorage entries set before the page's script runs (a view that
 * restores a preference at mount, such as hidden issue-page sections).
 *
 * `traffic` on the returned browser counts what the page received and sent:
 * WebSocket frames (texts kept), fetch and XHR response bodies (texts kept with
 * their URL), as UTF-8 bytes. Headers are not counted.
 */
export async function openBrowser (origin, { token = null, storage = null, local = null } = {}) {
  const { file } = await buildApp()
  const bundle = await fs.readFile(file, 'utf8')

  const problems = []
  const console_ = new VirtualConsole()
  console_.on('jsdomError', (e) => problems.push(`jsdomError: ${e.message ?? e}`))
  console_.on('error', (...a) => problems.push(`console.error: ${a.join(' ')}`))

  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: origin,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: console_
  })
  const { window } = dom

  class Observer { observe () {} unobserve () {} disconnect () {} takeRecords () { return [] } }
  window.ResizeObserver ??= Observer
  window.IntersectionObserver ??= Observer
  window.scrollTo = () => {}
  window.Headers = Headers
  window.Request = Request
  window.Response = Response
  window.fetch = (input, init) =>
    fetch(typeof input === 'string' ? new URL(input, origin).href : input, init)
  window.visualViewport = {
    width: 1280, height: 800, scale: 1, offsetLeft: 0, offsetTop: 0,
    addEventListener () {}, removeEventListener () {}, dispatchEvent () { return false }
  }
  window.matchMedia ??= (query) => ({
    matches: false, media: query,
    addEventListener () {}, removeEventListener () {},
    addListener () {}, removeListener () {}, dispatchEvent () { return false }
  })

  /*
   * A cut cable, not a paused page.
   *
   * Both transports have to go: socket.io falls back from websocket to polling,
   * so closing only the websocket leaves the page connected by XHR. While
   * offline, everything the page tries to send fails the way it would if the
   * network were gone.
   */
  let offline = false
  const sockets = new Set()
  const traffic = { socketIn: 0, socketOut: 0, httpIn: 0, frames: [], sent: [], httpBodies: [] }
  const textOf = (data) => (typeof data === 'string' ? data : data?.byteLength != null ? Buffer.from(data).toString('utf8') : String(data ?? ''))

  const RealWebSocket = window.WebSocket
  function TrackedWebSocket (...args) {
    if (offline) throw new window.DOMException('network is down', 'NetworkError')
    const socket = new RealWebSocket(...args)
    sockets.add(socket)
    socket.addEventListener('close', () => sockets.delete(socket))
    socket.addEventListener('message', (event) => {
      const text = textOf(event.data)
      traffic.socketIn += Buffer.byteLength(text)
      traffic.frames.push(text)
    })
    const send = socket.send.bind(socket)
    socket.send = (data) => {
      const text = textOf(data)
      traffic.socketOut += Buffer.byteLength(text)
      traffic.sent.push(text)
      return send(data)
    }
    return socket
  }
  TrackedWebSocket.prototype = RealWebSocket.prototype
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) TrackedWebSocket[key] = RealWebSocket[key]
  window.WebSocket = TrackedWebSocket

  const RealXhr = window.XMLHttpRequest
  class OfflineAwareXhr extends RealXhr {
    open (...args) {
      this._url = String(args[1] ?? '')
      return super.open(...args)
    }

    send (...args) {
      // socket.io's polling transport sends its frames as request bodies.
      if (typeof args[0] === 'string') { traffic.socketOut += Buffer.byteLength(args[0]); traffic.sent.push(args[0]) }
      this.addEventListener('loadend', () => {
        const text = typeof this.responseText === 'string' ? this.responseText : ''
        traffic.httpIn += Buffer.byteLength(text)
        traffic.httpBodies.push({ url: this._url, text, at: Date.now() })
      })
      if (!offline) return super.send(...args)
      setTimeout(() => {
        this.dispatchEvent(new window.ProgressEvent('error'))
        this.dispatchEvent(new window.ProgressEvent('loadend'))
      }, 0)
    }
  }
  window.XMLHttpRequest = OfflineAwareXhr

  /*
   * Held responses.
   *
   * Two requests the page makes in order do not necessarily answer in order. The
   * only way to test what the page does about that is to decide the order here.
   */
  const stalls = []
  const stallFor = (url) => stalls.find((s) => s.match.test(String(url)))

  const realFetch = window.fetch
  window.fetch = async (...args) => {
    if (offline) throw new TypeError('Failed to fetch')
    const held = stallFor(args[0])
    if (held) await new Promise((resolve) => setTimeout(resolve, held.ms))
    if (offline) throw new TypeError('Failed to fetch')
    const response = await realFetch(...args)
    response.clone().text().then((text) => {
      traffic.httpIn += Buffer.byteLength(text)
      traffic.httpBodies.push({ url: String(args[0]?.url ?? args[0]), text, at: Date.now() })
    }).catch(() => {})
    return response
  }

  const setOffline = (value) => {
    offline = value
    if (!value) return
    for (const socket of [...sockets]) { try { socket.close() } catch { /* already gone */ } }
    sockets.clear()
  }

  // A signed-in browser, without typing the token in every scenario.
  if (token) window.sessionStorage.setItem(storage ?? 'devpanel.token', token)
  for (const [key, value] of Object.entries(local ?? {})) window.localStorage.setItem(key, value)

  const script = window.document.createElement('script')
  script.textContent = bundle
  window.document.body.appendChild(script)
  // It has already run. Removing the node keeps its source out of
  // body.textContent, where it would satisfy almost any text assertion.
  script.remove()

  const text = () => window.document.body.textContent ?? ''

  const until = (predicate, { timeout = 8000, label = 'condition' } = {}) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout
      const attempt = () => {
        let met = false
        try { met = predicate() } catch { /* not yet rendered */ }
        if (met) return resolve()
        if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${label}`))
        setTimeout(attempt, 60)
      }
      attempt()
    })

  const all = (selector) => [...window.document.querySelectorAll(selector)]

  /** The first element whose visible text contains `needle`. */
  const find = (selector, needle) =>
    all(selector).find((el) => (el.textContent ?? '').includes(needle)) ?? null

  const click = (el) => {
    if (!el) throw new Error('nothing to click')
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    return new Promise((resolve) => setTimeout(resolve, 30))
  }

  /**
   * Wait for something to click, then click it.
   *
   * The trap this closes: waiting on a URL, a heading or any other proxy, then
   * reaching for a node that renders a tick later. That passes about half the
   * time and fails as `nothing to click`, which reads like a missing feature
   * rather than a race. `finder` is re-run until it returns an element, so the
   * node clicked is the one on screen now, never a stale reference.
   */
  const clickWhen = async (finder, { timeout = 8000, label = 'something to click' } = {}) => {
    let target = null
    await until(() => (target = finder()) != null, { timeout, label })
    return click(target)
  }

  return {
    window,
    problems,
    traffic,
    text,
    has: (needle) => text().includes(needle),
    until,
    all,
    find,
    click,
    clickWhen,
    /** Cut, or restore, this page's link to the server. */
    setOffline,
    isOffline: () => offline,
    /** Hold every response whose URL matches, so replies can land out of order. */
    stall: (match, ms) => { stalls.push({ match, ms }); },
    clearStalls: () => { stalls.length = 0 },
    async goto (path) {
      window.history.pushState({}, '', path)
      window.dispatchEvent(new window.PopStateEvent('popstate', { state: {} }))
      await new Promise((resolve) => setTimeout(resolve, 60))
    },
    close () { window.close() }
  }
}
