<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'

import { api } from '@/api'
import { formatStep } from '@/format'
import { socket } from '@/socket'
import { contiguous, mergeEntries } from '@/live-log'
import { createRenderer } from '@/terminal-format'

/*
 * One invocation, as a terminal. Read-only: the runtime runs headless and is
 * never typed into; this redraws its event stream as the CLI would have shown
 * it (terminal-format.js), opening with the exact command line.
 *
 * The bytes come the same way as everywhere else: the persisted backlog from
 * the API, then socket chunks that the server emits only after persisting
 * them. A gap is caught up from the server; an entry that lands before what is
 * already drawn redraws the terminal from the start, so the screen is always
 * a function of the stored log.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  runId: { type: String, required: true },
  invocationId: { type: String, required: true },
  live: { type: Boolean, default: false },
  role: { type: String, default: null },
  stepId: { type: String, default: null },
  model: { type: String, default: null }
})

const host = ref(null)
// xterm draws with a canvas. The jsdom browser the test suite renders pages in
// has none (asking for one logs an error), so there the same formatted text is
// shown as plain text instead.
const canDraw = typeof navigator === 'undefined' || !/jsdom/i.test(navigator.userAgent)
const plainText = ref('')
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n')
const raw = ref(false)
const error = ref('')
const loading = ref(true)
let term = null
let fit = null
let observer = null
let entries = []
let next = 0
let drawnSeq = 0
let renderer = createRenderer()
let inflight = null

function redraw () {
  if (!canDraw) { renderer = createRenderer({ raw: raw.value }); drawnSeq = 0; plainText.value = ''; draw(); return }
  if (!term) return
  term.reset()
  term.write('\x1b[?25l')              // no cursor: nobody types here
  renderer = createRenderer({ raw: raw.value, cols: term.cols })
  drawnSeq = 0
  draw()
}

/** Write whatever follows the last drawn entry, in order. */
function draw () {
  if (!term && canDraw) return
  let out = ''
  for (const e of entries) {
    if (e.seq <= drawnSeq) continue
    out += renderer.write(e)
    drawnSeq = e.seq
  }
  if (!out) return
  if (canDraw) term.write(out)
  else plainText.value += stripAnsi(out)
}

function absorb (incoming) {
  const before = entries.at(-1)?.seq ?? 0
  const merged = mergeEntries(entries, incoming)
  entries = merged.entries
  next = merged.next
  // Something landed behind what is already on screen: draw it all again.
  if (incoming.some((e) => e.seq <= drawnSeq && e.seq <= before)) redraw()
  else draw()
}

let inflightTarget = null
let loadSeq = 0
function load ({ reset = false } = {}) {
  const target = props.invocationId
  if (reset) { entries = []; next = 0; redraw() }
  if (inflight && inflightTarget === target) return inflight
  const seq = ++loadSeq
  inflightTarget = target
  const promise = (async () => {
    try {
      const page = await api.liveOutput(props.project, props.issueId, props.runId, target, next)
      if (seq !== loadSeq || target !== props.invocationId) return
      absorb(page.entries)
      error.value = ''
    } catch (e) {
      if (seq === loadSeq && target === props.invocationId) error.value = e.message
    } finally {
      if (inflight === promise) { inflight = null; inflightTarget = null }
      if (seq === loadSeq && target === props.invocationId) loading.value = false
    }
  })()
  inflight = promise
  return promise
}

function onRunEvent (event) {
  if (event?.type !== 'live' || event.invocationId !== props.invocationId || event.runId !== props.runId) return
  const entry = event.entry
  if (!entry || entry.seq <= next) return
  absorb([entry])
  if (!contiguous(entries)) load()
}
const onReconnect = () => load()

/* xterm is loaded when a terminal is first drawn: it is large, and it touches a
   canvas the moment its module loads. */
const loadXterm = () => Promise.all([
  import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-unicode11'), import('@xterm/xterm/css/xterm.css')
])

let disposed = false
onMounted(async () => {
  if (!canDraw) {
    load({ reset: true })
    socket.on('run:event', onRunEvent)
    socket.on('connect', onReconnect)
    return
  }
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }] = await loadXterm()
  if (disposed) return
  term = new Terminal({
    disableStdin: true,
    convertEol: true,
    cursorBlink: false,
    scrollback: 20000,
    fontSize: 12.5,
    lineHeight: 1.25,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
    allowProposedApi: true,
    theme: {
      background: '#16181d', foreground: '#d7dae0', cursor: '#16181d', selectionBackground: '#3a4150',
      black: '#16181d', brightBlack: '#6b7280', red: '#f07178', green: '#8bd49c', yellow: '#e6c07b',
      blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#d7dae0'
    }
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  // The CLIs measure with modern widths; xterm's default is Unicode 6.
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  term.open(host.value)
  // Opened inside a tab that is still animating in, xterm measures its cell at
  // zero size and spaces every character wide. Setting the font again makes it
  // measure afresh; done the first time the card has a real size.
  // The same goes for a font that finishes loading after the first measure.
  const remeasure = () => {
    if (!term) return
    const family = term.options.fontFamily
    term.options.fontFamily = `${family}, monospace`
    term.options.fontFamily = family
    try { fit.fit() } catch { /* not laid out yet */ }
  }
  let measured = false
  observer = new ResizeObserver(([entry]) => {
    if (!entry || entry.contentRect.width < 20 || entry.contentRect.height < 20) return
    if (!measured) { measured = true; remeasure(); return }
    try { fit.fit() } catch { /* not laid out yet */ }
  })
  // Prose is wrapped to the width; a new width redraws it, once resizing settles.
  let redrawTimer = null
  let drawnCols = 0
  term.onResize(({ cols }) => {
    if (cols === drawnCols) return
    clearTimeout(redrawTimer)
    redrawTimer = setTimeout(() => { drawnCols = cols; redraw() }, 150)
  })
  document.fonts?.ready.then(remeasure).catch(() => {})
  observer.observe(host.value)
  load({ reset: true })
  socket.on('run:event', onRunEvent)
  socket.on('connect', onReconnect)
})

onUnmounted(() => {
  disposed = true
  socket.off('run:event', onRunEvent)
  socket.off('connect', onReconnect)
  observer?.disconnect()
  term?.dispose()
  term = null
})

watch(() => props.invocationId, () => { loading.value = true; load({ reset: true }) })
watch(raw, redraw)
</script>

<template>
  <div class="term">
    <header class="term__bar">
      <span class="term__dots" aria-hidden="true"><i /><i /><i /></span>
      <span class="term__title">
        <strong>{{ role ?? 'runtime' }}</strong>
        <span v-if="stepId"> · {{ formatStep(stepId, role) }}</span>
        <span v-if="model" class="term__dim"> · {{ model }}</span>
      </span>
      <span v-if="live" class="term__live"><i />live</span>
      <span v-else class="term__dim">finished</span>
      <button type="button" class="term__toggle" :aria-pressed="raw" @click="raw = !raw">{{ raw ? 'Formatted' : 'Raw' }}</button>
    </header>
    <div v-if="error" class="term__error">{{ error }}</div>
    <div v-if="canDraw" ref="host" class="term__screen" />
    <pre v-else class="term__screen term__plain">{{ plainText }}</pre>
  </div>
</template>

<style scoped>
/* A terminal is dark in either theme, as an editor's terminal is. */
.term {
  display: flex; flex-direction: column; min-height: 0; height: 100%;
  background: #16181d; color: #d7dae0; border-radius: 10px; overflow: hidden;
  border: 1px solid #2a2f3a;
}
.term__bar {
  display: flex; align-items: center; gap: 10px; flex: none;
  padding: 7px 12px; background: #1d2027; border-bottom: 1px solid #2a2f3a;
  font-size: 0.75rem;
}
.term__dots { display: inline-flex; gap: 6px; }
.term__dots i { width: 10px; height: 10px; border-radius: 50%; background: #3a3f4b; }
.term__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.term__dim { opacity: 0.55; }
.term__live { display: inline-flex; align-items: center; gap: 5px; color: #8bd49c; font-weight: 600; }
.term__live i { width: 7px; height: 7px; border-radius: 50%; background: #8bd49c; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
@media (prefers-reduced-motion: reduce) { .term__live i { animation: none; } }
.term__toggle {
  font: inherit; color: inherit; background: #2a2f3a; border: 0; border-radius: 5px; padding: 2px 8px; cursor: pointer;
}
.term__toggle:hover { background: #353b48; }
.term__error { padding: 6px 12px; color: #f07178; font-size: 0.75rem; }
.term__screen { flex: 1; min-height: 0; padding: 6px 4px 4px 10px; }
.term__screen :deep(.xterm) { height: 100%; }
.term__plain { margin: 0; overflow: auto; white-space: pre-wrap; font: 12px/1.4 monospace; }
.term__screen :deep(.xterm-viewport) { background: #16181d !important; }
</style>
