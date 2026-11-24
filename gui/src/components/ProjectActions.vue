<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import DialogHeader from '@/components/DialogHeader.vue'
import { api } from '@/api'
import { socket } from '@/socket'
import { contiguous, mergeEntries } from '@/live-log'

/*
 * Project actions: checkpoint.sh and whatever else projects/<id>.yaml declares, as
 * buttons on the project page. Clicking one starts the script on the live
 * checkout and opens a popup that shows its output as it is written.
 *
 * The backlog comes from the API and new chunks arrive over the socket only
 * after the server persisted them, so a popup opened mid-way and one that
 * watched from the start show the same bytes. A gap in sequence numbers is
 * filled by a catch-up request rather than trusted.
 */

const props = defineProps({ project: { type: String, required: true } })

const listing = ref(null)
const listError = ref('')
const dialog = ref(false)
const operation = ref(null)
const entries = ref([])
const error = ref('')
const starting = ref('')
const stopping = ref(false)
const follow = ref(true)
const box = ref(null)
let next = 0
let inflight = null
let sequence = 0

async function loadActions () {
  const request = ++sequence
  listError.value = ''
  try {
    const result = await api.projectActions(props.project)
    if (request === sequence) listing.value = result
  } catch (e) {
    if (request === sequence) { listing.value = null; listError.value = e.message }
  }
}

const actions = computed(() => listing.value?.actions ?? [])
const running = computed(() => operation.value?.status === 'running')

function absorb (incoming) {
  const merged = mergeEntries(entries.value, incoming)
  entries.value = merged.entries
  next = merged.next
}

let inflightTarget = null
let loadSeq = 0
/** One catch-up at a time per operation; switching operations starts a fresh request. */
function load () {
  const target = operation.value?.id
  if (!target) return Promise.resolve()
  if (inflight && inflightTarget === target) return inflight
  const seq = ++loadSeq
  inflightTarget = target
  const promise = (async () => {
    try {
      const page = await api.actionOperation(props.project, target, next)
      if (seq !== loadSeq || operation.value?.id !== target) return
      absorb(page.entries)
      operation.value = page.operation
      error.value = ''
    } catch (e) {
      if (seq === loadSeq && operation.value?.id === target) error.value = e.message
    } finally {
      if (inflight === promise) { inflight = null; inflightTarget = null }
      if (seq === loadSeq && operation.value?.id === target) scrollToEnd()
    }
  })()
  inflight = promise
  return promise
}

function open (op) {
  operation.value = op
  entries.value = []
  next = 0
  follow.value = true
  error.value = ''
  dialog.value = true
  load()
}

async function run (action) {
  if (starting.value) return
  starting.value = action.id
  error.value = ''
  try {
    const { operation: op } = await api.runProjectAction(props.project, action.id)
    open(op)
  } catch (e) {
    // Already running: show the operation that is, rather than a bare refusal.
    const current = listing.value?.running
    if (current) open(current)
    error.value = e.message
    dialog.value = true
  } finally {
    starting.value = ''
  }
}

async function stop () {
  if (!operation.value || stopping.value) return
  stopping.value = true
  try {
    const { operation: op } = await api.stopProjectAction(props.project, operation.value.id)
    operation.value = op
  } catch (e) {
    error.value = e.message
  } finally {
    stopping.value = false
  }
}

function onActionEvent (event) {
  if (event?.project !== props.project) return
  if (event.type === 'started' || event.type === 'ended') loadActions()
  if (!operation.value || event.operationId !== operation.value.id) return
  if (event.type === 'output' && event.entry) {
    if (event.entry.seq <= next) return
    absorb([event.entry])
    if (!contiguous(entries.value)) load()
    scrollToEnd()
  } else if (event.type === 'ended' && event.operation) {
    operation.value = event.operation
    load()
  }
}

const onReconnect = () => { loadActions(); if (dialog.value) load() }

function scrollToEnd () {
  if (!follow.value) return
  nextTick(() => { const el = box.value; if (el) el.scrollTop = el.scrollHeight })
}

function onScroll () {
  const el = box.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

onMounted(() => {
  socket.on('project:action', onActionEvent)
  socket.on('connect', onReconnect)
})
onUnmounted(() => {
  socket.off('project:action', onActionEvent)
  socket.off('connect', onReconnect)
})
watch(() => props.project, () => { listing.value = null; dialog.value = false; operation.value = null; loadActions() }, { immediate: true })

const STATUS_COLOR = { running: 'primary', completed: 'success', failed: 'error', interrupted: 'warning' }
const clockTime = (iso) => (iso ? iso.slice(11, 19) : '')
const LABEL = { stdout: 'out', stderr: 'err', spawn: 'spawn', exit: 'exit', truncated: 'cap' }
const summary = computed(() => {
  const op = operation.value
  if (!op) return ''
  if (op.status === 'running') return 'running'
  if (op.status === 'completed') return `completed · exit 0 · ${Math.round((op.durationMs ?? 0) / 1000)}s`
  if (op.status === 'interrupted') return op.timedOut ? 'interrupted · deadline reached' : 'interrupted · stopped'
  return `failed${op.exitCode !== null && op.exitCode !== undefined ? ` · exit ${op.exitCode}` : ''}${op.error ? ` · ${op.error}` : ''}`
})
function lastLabel (action) {
  const last = action.last
  if (!last) return ''
  return `Last: ${last.status}${last.exitCode !== null && last.exitCode !== undefined ? ` (exit ${last.exitCode})` : ''} at ${last.startedAt?.replace('T', ' ').slice(0, 19) ?? ''}`
}
</script>

<template>
  <span class="actions" role="group" aria-label="Project actions">
    <v-btn v-for="action in actions" :key="action.id" size="small" variant="tonal" prepend-icon="$play"
           :title="`${action.hint || action.label} · ${action.run}${action.last ? ` · ${lastLabel(action)}` : ''}`"
           :loading="starting === action.id" :disabled="Boolean(starting) || Boolean(listing?.running)"
           :data-action="action.id" @click="run(action)">
      {{ action.label }}
    </v-btn>
    <v-btn v-if="listing?.running" size="small" variant="text" color="primary" :title="`${listing.running.action} is running`" @click="open(listing.running)">
      <v-progress-circular indeterminate size="12" width="2" class="mr-2" />{{ listing.running.label || listing.running.action }} running…
    </v-btn>
    <span v-if="listError" class="actions__error" :title="listError">actions unavailable</span>

    <v-dialog v-model="dialog" max-width="880" scrollable :persistent="running">
      <v-card class="actions__card">
        <DialogHeader :title="operation ? `${operation.label || operation.action} · ${project.replace(/-project$/, '')}` : 'Project action'" :busy="false" @close="dialog = false" />
        <v-card-text class="actions__body">
          <p v-if="operation" class="actions__meta">
            <v-chip size="x-small" :color="STATUS_COLOR[operation.status]" variant="tonal" label>{{ summary }}</v-chip>
            <span class="actions__dim"><code>{{ operation.run }}</code> in <code>{{ operation.cwd }}</code> · started {{ operation.startedAt?.replace('T', ' ').slice(0, 19) }} by {{ operation.actor }}</span>
          </p>
          <p class="actions__note">
            This is the script's output on the live checkout, as recorded. Read it before treating the action as done: the exit code says whether the script finished, the output says what it did.
          </p>
          <v-alert v-if="error" type="error" variant="tonal" density="compact" class="my-2">{{ error }}</v-alert>
          <div v-if="operation && !entries.length" class="actions__dim">{{ running ? 'Nothing written yet.' : 'No output was recorded.' }}</div>
          <div v-else-if="operation" ref="box" class="actions__box" @scroll="onScroll">
            <div v-for="e in entries" :key="e.seq" class="row" :class="`row--${e.kind}`">
              <span class="row__at">{{ clockTime(e.at) }}</span>
              <span class="row__kind">{{ LABEL[e.kind] ?? e.kind }}</span>
              <span class="row__text">{{ e.text }}</span>
            </div>
          </div>
          <p v-if="operation?.truncated" class="actions__dim">Output was capped; the record keeps the tail of each stream.</p>
        </v-card-text>
        <v-card-actions class="actions__foot">
          <span v-if="running && !follow" class="actions__dim">paused · scroll to the bottom to follow</span>
          <v-spacer />
          <v-btn v-if="running" color="warning" variant="text" prepend-icon="$stop" :loading="stopping" @click="stop">Stop</v-btn>
          <v-btn variant="text" :disabled="running" @click="dialog = false">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </span>
</template>

<style scoped>
.actions { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.actions__error { font-size: 0.75rem; color: rgb(var(--v-theme-warning)); }
.actions__card { display: flex; flex-direction: column; max-height: 85vh; }
.actions__body { display: flex; flex-direction: column; min-height: 0; padding: 0 20px 8px; }
.actions__meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 6px; font-size: 0.8125rem; }
.actions__dim { font-size: 0.75rem; opacity: 0.6; overflow-wrap: anywhere; }
.actions__note { font-size: 0.75rem; opacity: 0.55; margin: 0 0 8px; }
.actions__foot { padding: 4px 12px 8px; }
.actions__box {
  min-height: 160px; max-height: 60vh; overflow: auto; padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 5%, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; line-height: 1.5;
}
.row { display: grid; grid-template-columns: 4.5rem 3.2rem 1fr; gap: 8px; padding: 1px 0; }
.row__at { opacity: 0.4; font-variant-numeric: tabular-nums; }
.row__kind { opacity: 0.55; text-transform: uppercase; font-size: 0.6875rem; letter-spacing: 0.04em; }
.row__text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.row--stderr .row__text { color: rgb(var(--v-theme-warning)); }
.row--exit .row__text, .row--spawn .row__text { opacity: 0.6; }
.row--truncated .row__text { color: rgb(var(--v-theme-warning)); }
@media (max-width: 600px) { .row { grid-template-columns: 3.2rem 1fr; } .row__at { display: none; } }
</style>
