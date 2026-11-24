<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import { api } from '@/api'
import { formatStep } from '@/format'
import { socket } from '@/socket'
import { contiguous, mergeEntries, parseRows } from '@/live-log'

/*
 * The runtime's own output for one invocation, as it is written.
 *
 * The backlog comes from the API — it is what the server persisted — and new
 * chunks arrive over the socket only after the server has persisted them, so a
 * browser that opens mid-turn and one that watched from the start see the same
 * bytes. Reconnecting re-reads from the last sequence number rather than
 * trusting a buffer.
 *
 * Every entry carries a sequence number, and the list is keyed by it: a chunk
 * that arrives both as a socket event and inside a backlog page lands once, and
 * a gap is filled by one catch-up request at a time.
 *
 * Two views of the same bytes: the parsed view turns the runtime's JSON event
 * lines into readable rows (assistant text, tool calls, results); raw shows the
 * exact stdout and stderr. Neither is the step's result — that is the response
 * the engine stored — and nothing here claims to be.
 */

const props = defineProps({
  // Required for a run's invocation; omitted for the top-level supervisor's
  // own calls (`supervisor`), which are read from /api/supervisor/live.
  project: { type: String, default: null },
  issueId: { type: String, default: null },
  runId: { type: String, default: null },
  supervisor: { type: Boolean, default: false },
  invocationId: { type: String, required: true },
  live: { type: Boolean, default: false },
  role: { type: String, default: null },
  stepId: { type: String, default: null }
})

const entries = ref([])
const loading = ref(true)
const error = ref('')
const raw = ref(false)
const follow = ref(true)
const box = ref(null)
let next = 0
let loadedFor = null
let inflight = null
let inflightTarget = null
let loadSeq = 0

function absorb (incoming) {
  const merged = mergeEntries(entries.value, incoming)
  entries.value = merged.entries
  next = merged.next
}

/** One catch-up at a time per invocation: a target switch starts a fresh request. */
function load ({ reset = false } = {}) {
  const target = props.invocationId
  if (reset) { entries.value = []; next = 0 }
  if (inflight && inflightTarget === target) return inflight
  const seq = ++loadSeq
  inflightTarget = target
  const promise = (async () => {
    try {
      const page = props.supervisor ? await api.supervisorLive(target, next) : await api.liveOutput(props.project, props.issueId, props.runId, target, next)
      if (seq !== loadSeq || target !== props.invocationId) return
      absorb(page.entries)
      error.value = ''
    } catch (e) {
      if (seq === loadSeq && target === props.invocationId) error.value = e.message
    } finally {
      if (inflight === promise) { inflight = null; inflightTarget = null }
      if (seq === loadSeq && target === props.invocationId) {
        loading.value = false
        scrollToEnd()
      }
    }
  })()
  inflight = promise
  return promise
}

function onRunEvent (event) {
  if (event?.type !== 'live' || event.invocationId !== props.invocationId || (!props.supervisor && event.runId !== props.runId)) return
  const entry = event.entry
  if (!entry || entry.seq <= next) return
  absorb([entry])
  // A gap means a missed event: catch up from the server rather than guessing.
  if (!contiguous(entries.value)) load()
  scrollToEnd()
}

const onReconnect = () => load()

function scrollToEnd () {
  if (!follow.value) return
  nextTick(() => { const el = box.value; if (el) el.scrollTop = el.scrollHeight })
}

function onScroll () {
  const el = box.value
  if (!el) return
  // Reading history pauses following; returning to the bottom resumes it.
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

onMounted(() => {
  loadedFor = props.invocationId
  load({ reset: true })
  socket.on(props.supervisor ? 'supervisor:live' : 'run:event', onRunEvent)
  socket.on('connect', onReconnect)
})
onUnmounted(() => {
  socket.off(props.supervisor ? 'supervisor:live' : 'run:event', onRunEvent)
  socket.off('connect', onReconnect)
})
watch(() => props.invocationId, (id) => { if (id !== loadedFor) { loadedFor = id; loading.value = true; load({ reset: true }) } })

const rows = computed(() => parseRows(entries.value))
const clockTime = (iso) => (iso ? iso.slice(11, 19) : '')
const LABEL = { text: 'says', tool: 'tool', result: 'result', error: 'error', thinking: 'thinks', system: 'sys', done: 'done', stdout: 'out', stderr: 'err', spawn: 'spawn', exit: 'exit', truncated: 'cap' }
</script>

<template>
  <div class="live">
    <header class="live__head">
      <span class="live__title">
        <v-progress-circular v-if="live" indeterminate size="12" width="2" class="mr-2" />
        Runtime output
        <span class="live__seat">Seat: {{ role ?? 'unknown' }}</span>
        <span v-if="stepId" class="live__dim">Step: {{ formatStep(stepId, role) }}</span>
      </span>
      <span class="live__controls">
        <span class="live__dim">{{ entries.length }} chunks<template v-if="!follow && live"> · paused (scroll to bottom to follow)</template></span>
        <v-btn-toggle v-model="raw" density="compact" variant="outlined" divided mandatory class="live__toggle">
          <v-btn :value="false" size="x-small">parsed</v-btn>
          <v-btn :value="true" size="x-small">raw</v-btn>
        </v-btn-toggle>
      </span>
    </header>
    <p class="live__note">
      Output from this seat's invocation, including its tool calls and results. Other seats have separate logs. The stored response is the step's result; recent output only indicates activity.
    </p>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="my-2">{{ error }}</v-alert>
    <div v-if="loading" class="live__dim">Loading…</div>
    <div v-else-if="!entries.length" class="live__dim">{{ live ? 'Nothing written yet.' : 'No output was recorded for this turn.' }}</div>

    <div v-else ref="box" class="live__box" @scroll="onScroll">
      <template v-if="raw">
        <div v-for="e in entries" :key="e.seq" class="row" :class="`row--${e.kind}`">
          <span class="row__at">{{ clockTime(e.at) }}</span>
          <span class="row__seat" :title="`Seat: ${role ?? 'unknown'}`">{{ role ?? 'unknown' }}</span>
          <span class="row__kind">{{ LABEL[e.kind] ?? e.kind }}</span>
          <span class="row__text">{{ e.text }}</span>
        </div>
      </template>
      <template v-else>
        <div v-for="(r, i) in rows" :key="i" class="row" :class="`row--${r.kind}`">
          <span class="row__at">{{ clockTime(r.at) }}</span>
          <span class="row__seat" :title="`Seat: ${role ?? 'unknown'}`">{{ role ?? 'unknown' }}</span>
          <span class="row__kind">{{ LABEL[r.kind] ?? r.kind }}</span>
          <span class="row__text">{{ r.text }}<span v-if="r.partial" class="live__dim"> …</span></span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.live { display: flex; flex-direction: column; min-height: 0; }
.live__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.live__title { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 0.8125rem; font-weight: 600; }
.live__seat { padding: 2px 6px; border: 1px solid currentColor; border-radius: 4px; }
.live__controls { display: inline-flex; align-items: center; gap: 10px; }
.live__toggle { height: 24px; }
.live__dim { font-size: 0.75rem; opacity: 0.55; margin-left: 6px; }
.live__note { font-size: 0.75rem; opacity: 0.55; margin: 4px 0 8px; }

.live__box {
  max-height: 420px; overflow: auto; padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 5%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; line-height: 1.5;
}
.row { display: grid; grid-template-columns: 4.5rem 7.5rem 3.2rem minmax(0, 1fr); gap: 8px; padding: 1px 0; }
.row__at { opacity: 0.4; font-variant-numeric: tabular-nums; }
.row__seat { font-weight: 600; overflow-wrap: anywhere; }
.row__kind { opacity: 0.55; text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.04em; }
.row__text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.row--text .row__text { opacity: 0.95; }
.row--tool .row__kind { color: rgb(var(--v-theme-primary)); opacity: 0.9; }
.row--result .row__text { opacity: 0.7; }
.row--thinking .row__text { opacity: 0.55; font-style: italic; }
.row--stderr .row__text, .row--error .row__text { color: rgb(var(--v-theme-warning)); }
.row--exit .row__text, .row--done .row__text, .row--spawn .row__text { opacity: 0.6; }
.row--truncated .row__text { color: rgb(var(--v-theme-warning)); }
@media (max-width: 600px) { .row { grid-template-columns: 5.5rem 3.2rem minmax(0, 1fr); } .row__at { display: none; } }
</style>
