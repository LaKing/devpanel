<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { formatStep } from '@/format'
import { useLiveStream } from '@/live-stream'
import { createRenderer, keepTail } from '@/terminal-format'
import LiveChunkPager from './LiveChunkPager.vue'

/*
 * One invocation, as a terminal. Read-only: the runtime runs headless and is
 * never typed into; this redraws its event stream as the CLI would have shown
 * it (terminal-format.js), opening with the exact command line.
 *
 * The bytes come the same way as everywhere else (live-stream.js): bounded
 * pages of the persisted log, then socket chunks while this viewer is shown and
 * subscribed. Entries are committed in file order; when the window changes at
 * its start (earlier output loaded, or a jump back to the latest) the terminal
 * is drawn again from the window, so the screen is always a function of it.
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
const root = ref(null)
// xterm draws with a canvas. The jsdom browser the test suite renders pages in
// has none (asking for one logs an error), so there the same formatted text is
// shown as plain text instead.
const canDraw = typeof navigator === 'undefined' || !/jsdom/i.test(navigator.userAgent)
const plainText = ref('')
const PLAIN_MAX = 2 * 1024 * 1024
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n')
const raw = ref(false)
let term = null
let fit = null
let observer = null
let entries = []
let drawnSeq = 0
let drawnFirst = null
let renderer = createRenderer()

const { view, loadEarlier, jumpToLatest, fetchSlice } = useLiveStream({
  target: () => ({ supervisor: false, project: props.project, issueId: props.issueId, runId: props.runId, invocationId: props.invocationId }),
  live: () => props.live,
  root,
  onUpdate: (state) => absorb(state.entries)
})
const error = computed(() => view.value.error)
const sliced = computed(() => view.value.entries.filter((e) => e.sliced))

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
  else plainText.value = keepTail(plainText.value + stripAnsi(out), PLAIN_MAX)
}

/*
 * The window only grows at its end while following. When its start moved back
 * (earlier output) or the window was replaced (jump to latest), draw it again;
 * a start that moved forward (old entries trimmed) leaves the screen as it is.
 */
function absorb (window) {
  const first = window[0]?.seq ?? null
  const replaced = drawnFirst !== null && (first === null || first < drawnFirst || (window.at(-1)?.seq ?? 0) < drawnSeq)
  entries = window
  if (replaced) { drawnFirst = first; redraw(); return }
  if (drawnFirst === null) drawnFirst = first
  draw()
}

/* xterm is loaded when a terminal is first drawn: it is large, and it touches a
   canvas the moment its module loads. */
const loadXterm = () => Promise.all([
  import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-unicode11'), import('@xterm/xterm/css/xterm.css')
])

let disposed = false
onMounted(async () => {
  if (!canDraw) return
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
  // Whatever arrived while xterm was loading.
  redraw()
})

onUnmounted(() => {
  disposed = true
  observer?.disconnect()
  term?.dispose()
  term = null
})

// Another invocation: the stream reopens (live-stream.js); start from a clear screen.
watch(() => props.invocationId, () => { entries = []; drawnFirst = null; redraw() })
watch(raw, redraw)
</script>

<template>
  <div ref="root" class="term">
    <header class="term__bar">
      <span class="term__dots" aria-hidden="true"><i /><i /><i /></span>
      <span class="term__title">
        <strong>{{ role ?? 'runtime' }}</strong>
        <span v-if="stepId"> · {{ formatStep(stepId, role) }}</span>
        <span v-if="model" class="term__dim"> · {{ model }}</span>
      </span>
      <span v-if="live" class="term__live"><i />live</span>
      <span v-else class="term__dim">finished</span>
      <button v-if="view.earlier" type="button" class="term__toggle" @click="loadEarlier">Load earlier</button>
      <button v-if="view.detached" type="button" class="term__toggle" @click="jumpToLatest">Jump to latest</button>
      <button type="button" class="term__toggle" :aria-pressed="raw" @click="raw = !raw">{{ raw ? 'Formatted' : 'Raw' }}</button>
    </header>
    <div v-if="error" class="term__error">{{ error }}</div>
    <div v-if="canDraw" ref="host" class="term__screen" />
    <pre v-else class="term__screen term__plain">{{ plainText }}</pre>
    <LiveChunkPager class="term__pager" :entries="sliced" :fetch-slice="fetchSlice" :invocation-id="invocationId" />
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
