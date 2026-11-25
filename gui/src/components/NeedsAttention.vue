<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { api } from '@/api'
import { socket } from '@/socket'
import { formatDuration } from '@/format'
import SupervisorQuestion from './SupervisorQuestion.vue'
import AlertSettings from './AlertSettings.vue'

/*
 * Runs that only a person can move on, newest run of each open issue.
 *
 * The slowest part of resolving an issue was not agents working but runs parked
 * — blocked on a budget, stranded by a restart, waiting on a question — with
 * nothing pointing at them. Each row says why it is waiting and for how long;
 * the issue page holds the actions.
 */

const items = ref([])
const loading = ref(true)
const error = ref('')
const now = ref(Date.now())
let ticker = null
let poller = null
let pending = null

async function load () {
  try {
    items.value = await api.listAttention()
    error.value = ''
  } catch (err) { error.value = err.message } finally { loading.value = false }
}

/* Live output and activity chunks change nothing listed here. */
function onRunEvent (payload) {
  if (payload?.type === 'live' || payload?.type === 'activity') return
  clearTimeout(pending)
  pending = setTimeout(load, 500)
}

onMounted(() => {
  load()
  ticker = setInterval(() => { now.value = Date.now() }, 30_000)
  poller = setInterval(load, 60_000)
  socket.on('run:event', onRunEvent)
  socket.on('issues:changed', onRunEvent)
  socket.on('connect', load)
  socket.on('supervisor:changed', onRunEvent)
})
onUnmounted(() => {
  clearInterval(ticker); clearInterval(poller); clearTimeout(pending)
  socket.off('run:event', onRunEvent); socket.off('issues:changed', onRunEvent); socket.off('connect', load)
  socket.off('supervisor:changed', onRunEvent)
})

const LABEL = {
  question: 'waiting for an answer',
  recovery: 'needs recovery',
  blocked: 'blocked',
  paused: 'paused',
  failed: 'failed',
  disposition: 'resolved run — record a disposition',
  'supervisor-question': 'the supervisor asks'
}
const COLOUR = { 'supervisor-question': 'primary', question: 'primary', recovery: 'warning', blocked: 'warning', paused: undefined, failed: 'error', disposition: 'success' }

const projectName = (project) => (project ? project.replace(/-project$/, '') : 'Supervisor')

/* One block per project, in the order the server ranked their first item. */
const groups = computed(() => {
  const byProject = new Map()
  for (const item of items.value) {
    if (!byProject.has(item.project)) byProject.set(item.project, [])
    byProject.get(item.project).push(item)
  }
  return [...byProject].map(([project, list]) => ({ project, items: list }))
})

const waited = (item) => {
  now.value // re-evaluate on tick
  return item.since ? formatDuration(Math.max(0, Math.round((now.value - Date.parse(item.since)) / 1000))) : '—'
}
const reason = (item) => (item.blockedReason && item.kind === 'blocked' ? item.blockedReason.replace(/-/g, ' ') : null)

defineExpose({ load })
</script>

<template>
  <div class="attention">
    <AlertSettings />
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="attention__notice">{{ error }}</v-alert>
    <div v-if="loading && !items.length" class="attention__muted">Looking…</div>
    <p v-else-if="!items.length" class="attention__muted">Nothing is waiting on a person.</p>

    <section v-for="group in groups" :key="group.project" class="group">
      <h3 class="group__head">
        <v-icon icon="$folder" size="18" class="group__icon" />
        <RouterLink class="group__name" :to="group.project ? `/projects/${group.project}` : '/supervisor'">{{ projectName(group.project) }}</RouterLink>
        <span class="group__count">{{ group.items.length }}</span>
      </h3>
      <article v-for="item in group.items" :key="item.questionId ?? `${item.project}/${item.issueId}/${item.runId}`" class="item">
        <!-- The supervisor's own question: answered here, it reaches the supervisor as an event. -->
        <SupervisorQuestion v-if="item.kind === 'supervisor-question'" :question="item" @answered="load" />
        <header v-else class="item__head">
          <RouterLink class="item__issue" :to="{ path: `/projects/${item.project}/${item.issueId}`, query: { run: item.runId } }">{{ item.issueName }}</RouterLink>
          <v-chip size="x-small" variant="tonal" :color="COLOUR[item.kind]">{{ LABEL[item.kind] }}</v-chip>
          <span v-if="item.headline" class="item__headline">{{ item.headline }}</span>
          <span v-else-if="reason(item)" class="item__meta">{{ reason(item) }}</span>
          <span v-if="item.playbook" class="item__meta">{{ item.playbook }}</span>
          <span class="item__meta item__meta--right" :title="item.since">for {{ waited(item) }}</span>
        </header>
        <p v-if="item.detail && item.kind !== 'supervisor-question'" class="item__detail">{{ item.detail }}</p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.attention { padding: 6px 0 10px; }
.attention__notice { margin: 10px 16px; }
.attention__muted { padding: 14px 20px; font-size: 0.8125rem; opacity: 0.6; }
.group + .group { margin-top: 10px; }
.group__head {
  display: flex; align-items: center; gap: 8px;
  margin: 6px 12px 2px; padding: 8px 10px; border-radius: 8px;
  font-size: 1rem; font-weight: 650; letter-spacing: -0.01em;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 5%, transparent);
}
.group__icon { opacity: 0.55; }
.group__name { color: inherit; text-decoration: none; }
.group__name:hover { text-decoration: underline; }
.group__count {
  font-size: 0.6875rem; font-weight: 600; min-width: 20px; padding: 1px 7px; border-radius: 10px; text-align: center;
  background: color-mix(in srgb, rgb(var(--v-theme-on-surface)) 10%, transparent);
}
.item { margin-left: 28px; padding: 9px 20px 11px; border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent); }
.item:last-child { border-bottom: none; }
.item__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.item__issue { font-size: 0.875rem; font-weight: 500; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.item__issue:hover { text-decoration: underline; }
.item__meta { font-size: 0.75rem; opacity: 0.55; }
.item__headline { font-size: 0.8125rem; opacity: 0.85; }
.item__meta--right { margin-left: auto; font-variant-numeric: tabular-nums; }
.item__detail {
  margin-top: 4px; font-size: 0.75rem; opacity: 0.7; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
</style>
