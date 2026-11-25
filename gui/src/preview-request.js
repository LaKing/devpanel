/*
 * Which start-preview response may still land (StartRunDialog.vue). Only the newest request may
 * write to the page, and an options change supersedes a request in flight for other options at
 * once, not when the debounced reload begins: otherwise a response for A that arrives while B is
 * selected would be accepted, and a return to A would show it with no fresh load.
 *
 * begin(key) → token; isCurrent(token); optionsChanged(key, reload) supersedes an in-flight request
 * whose key differs and (re)schedules `reload` after the debounce; invalidate() drops whatever is in
 * flight (dialog closed, playbook changed); dispose() clears the timer.
 */
export function createPreviewTracker ({ setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 500 } = {}) {
  let generation = 0
  let inFlightKey = null
  let timer = null
  return {
    begin (key) { generation++; inFlightKey = key; return generation },
    isCurrent (token) { return token === generation },
    settle (token) { if (token === generation) inFlightKey = null },
    optionsChanged (key, reload = null) {
      if (inFlightKey !== null && key !== inFlightKey) { generation++; inFlightKey = null }
      if (timer !== null) clearTimer(timer)
      timer = reload ? setTimer(() => { timer = null; reload() }, delayMs) : null
    },
    invalidate () { generation++; inFlightKey = null },
    dispose () { if (timer !== null) clearTimer(timer); timer = null }
  }
}
