import { onMounted, onUnmounted, shallowRef, triggerRef, watch } from 'vue'

import { api } from '@/api'
import { socket } from '@/socket'
import { createLiveFollow } from '@/live-follow'
import { liveChannel } from '@/live-subscription'

/*
 * The live-follow core for a component: one invocation at a time, subscribed
 * only while the viewer is shown. A viewer hidden by `display: none` anywhere
 * above it (v-show) holds no room from the start, and lets go when it is hidden
 * later; shown again, it re-joins and catches up from its cursor.
 */

/** False when the element or any ancestor is not displayed. */
export function isShown (el) {
  if (!el || !el.isConnected) return false
  const view = el.ownerDocument?.defaultView
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.style?.display === 'none') return false
    if (view?.getComputedStyle && view.getComputedStyle(node).display === 'none') return false
  }
  return true
}

/* One observer for every viewer on the page: v-show toggles inline style. */
const watchers = new Set()
let observer = null
let scheduled = false
function watchVisibility (fn) {
  watchers.add(fn)
  if (!observer && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => { scheduled = false; for (const w of watchers) w() })
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
  }
  return () => {
    watchers.delete(fn)
    if (!watchers.size && observer) { observer.disconnect(); observer = null }
  }
}

/**
 * target(): `{ supervisor, project, issueId, runId, invocationId }`; live(): the
 * turn is in flight; root: the component's element ref.
 */
export function useLiveStream ({ target, live, root, onUpdate = () => {} }) {
  const view = shallowRef({ entries: [], earlier: false, detached: false, polling: false, error: '', loading: true, live: false })
  let core = null
  let stopVisibility = null
  let resize = null
  let shown = false

  const fetchPageFor = (t) => (query) => (t.supervisor
    ? api.supervisorLive(t.invocationId, query)
    : api.liveOutput(t.project, t.issueId, t.runId, t.invocationId, query))

  function open () {
    const t = target()
    if (!t?.invocationId) return
    shown = isShown(root.value)
    core = createLiveFollow({
      channel: liveChannel(socket, t.supervisor ? { scope: 'supervisor', invocationId: t.invocationId } : { scope: 'run', ...t }),
      fetchPage: fetchPageFor(t),
      active: shown,
      live: live(),
      onChange: (state) => { view.value = state; triggerRef(view); onUpdate(state) }
    })
    core.start()
  }
  function close () { core?.close(); core = null }

  const recheck = () => {
    const now = isShown(root.value)
    if (now === shown) return
    shown = now
    core?.setActive(now)
  }

  onMounted(() => {
    open()
    stopVisibility = watchVisibility(recheck)
    if (typeof ResizeObserver !== 'undefined' && root.value) {
      resize = new ResizeObserver(recheck)
      resize.observe(root.value)
    }
  })
  onUnmounted(() => {
    close()
    stopVisibility?.()
    resize?.disconnect()
  })
  watch(() => target()?.invocationId, (id, old) => { if (id !== old) { close(); open() } })
  watch(live, (value) => core?.setLive(value))

  return {
    view,
    loadEarlier: () => core?.loadEarlier(),
    jumpToLatest: () => core?.jumpToLatest(),
    /** One bounded slice of a clipped entry's text. */
    fetchSlice: (seq, offset) => fetchPageFor(target())({ entry: seq, offset })
  }
}
