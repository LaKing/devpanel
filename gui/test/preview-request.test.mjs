import { createPreviewTracker } from '../src/preview-request.js'

export const name = 'preview-request — a late start-preview response for superseded options is never shown as current'

/** Fake timers: nothing fires until the test advances them. */
function fakeTimers () {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: now + ms }); return id },
    clearTimer: (id) => { timers.delete(id) },
    advance (ms) {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn() }
    },
    pending: () => timers.size
  }
}

/** The dialog's use of the tracker (StartRunDialog.vue loadPreview / optionsKey watcher), with the shown preview. */
function dialog () {
  const clock = fakeTimers()
  const tracker = createPreviewTracker({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, delayMs: 500 })
  const state = { key: 'A', shown: null, requests: [] }
  const load = () => {
    const key = state.key
    const token = tracker.begin(key)
    const request = { key, respond: () => { if (tracker.isCurrent(token)) { state.shown = key; tracker.settle(token) } } }
    state.requests.push(request)
    return request
  }
  const change = (key) => {
    state.key = key
    if (state.shown !== key) state.shown = null
    tracker.optionsChanged(key, () => { if (state.shown !== state.key) load() })
  }
  return { clock, tracker, state, load, change, matches: () => state.shown === state.key }
}

export default async function (t) {
  t.section('A in flight, B selected, A answers before the debounce, back to A: a fresh load, never A\'s old answer')
  {
    const d = dialog()
    const a = d.load()
    d.change('B')
    a.respond()                       // A's late answer, while B is selected
    t.eq('A\'s answer is not shown', d.state.shown, null)
    d.change('A')                     // back to A before the debounce fires
    t.eq('nothing matches yet', d.matches(), false)
    d.clock.advance(500)
    t.eq('the debounce loads A afresh', d.state.requests.length, 2)
    d.state.requests[1].respond()
    t.eq('only the fresh answer is shown', [d.state.shown, d.matches()], ['A', true])
  }

  t.section('a superseded response lands after the newer one: the newer stays')
  {
    const d = dialog()
    const a = d.load()
    d.change('B')
    d.clock.advance(500)
    const b = d.state.requests[1]
    b.respond()
    a.respond()
    t.eq('B is shown', d.state.shown, 'B')
  }

  t.section('a reload of the same options keeps its own request; closing drops it')
  {
    const d = dialog()
    const a = d.load()
    d.change('A')                     // the dialog's own reset writes the same key
    a.respond()
    t.eq('the answer for the same key lands', d.state.shown, 'A')
    const again = d.load()
    d.tracker.invalidate()            // dialog closed or playbook changed
    d.state.shown = null
    again.respond()
    t.eq('nothing lands after invalidate', d.state.shown, null)
    d.tracker.dispose()
    t.eq('dispose clears the timer', d.clock.pending(), 0)
  }
}
