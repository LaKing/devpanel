<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '@/api'

/*
 * An operator alert, opened from its notification (docs/operator-alerts.md): each item it grouped, with where it
 * stands now. A single item that still waits opens its action directly; anything handled meanwhile says by whom.
 */
const route = useRoute()
const router = useRouter()
const alert = ref(null)
const error = ref('')

const KIND = { question: 'question', 'supervisor-question': 'supervisor question', recovery: 'run to recover' }

async function load () {
  error.value = ''
  try {
    alert.value = await api.alert(route.params.alertId)
    const items = alert.value.items
    if (items.length === 1 && items[0].state === 'waiting') router.replace(items[0].link)
  } catch (e) { error.value = e.message }
}

const title = (item) => item.kind === 'supervisor-question' ? 'The supervisor' : `${(item.project ?? '').replace(/-project$/, '')} · ${item.issueId} · run ${item.runId}`
const stateText = (item) => {
  const now = item.current ? ` · the run is ${item.current.packed ? 'archived; it ended ' : 'now '}${item.current.status ?? 'unknown'}${item.current.recoveryRequired ? ' (needs recovery)' : ''}` : ''
  if (item.state === 'waiting') return `still waiting${now}`
  if (item.state === 'retired') return 'no longer open (its supervisor session ended)'
  if (item.state === 'unknown') return 'not known right now: the panel could not read where it stands'
  if (item.state === 'unreadable') return 'unreadable: its run record cannot be read; its link opens the run'
  return `${item.handled?.at ? `handled${item.handled.by ? ` by ${item.handled.by}` : ''} at ${item.handled.at.slice(0, 16).replace('T', ' ')}` : 'handled'}${now}`
}
const waitingCount = computed(() => (alert.value?.items ?? []).filter((i) => i.state === 'waiting').length)

onMounted(load)
watch(() => route.params.alertId, load)
</script>

<template>
  <div class="alert-view">
    <h2 class="alert-view__head">Alert</h2>
    <p v-if="error" class="alert-view__error">{{ error }}</p>
    <template v-else-if="alert">
      <p class="alert-view__muted">Sent {{ alert.createdAt.slice(0, 16).replace('T', ' ') }} · {{ alert.items.length }} item{{ alert.items.length === 1 ? '' : 's' }}, {{ waitingCount }} still waiting</p>
      <article v-for="item in alert.items" :key="item.key" class="alert-view__item" data-testid="alert-item">
        <RouterLink :to="item.link" class="alert-view__link">{{ title(item) }}</RouterLink>
        <v-chip size="x-small" variant="tonal">{{ KIND[item.kind] ?? item.kind }}</v-chip>
        <span :class="['alert-view__state', { 'alert-view__state--done': item.state !== 'waiting' }]">{{ stateText(item) }}</span>
      </article>
    </template>
    <p v-else class="alert-view__muted">Loading…</p>
  </div>
</template>

<style scoped>
.alert-view { padding: 16px 20px; max-width: 760px; }
.alert-view__head { font-size: 1.125rem; font-weight: 650; margin-bottom: 6px; }
.alert-view__muted { font-size: 0.8125rem; opacity: 0.6; margin-bottom: 10px; }
.alert-view__error { color: rgb(var(--v-theme-error)); }
.alert-view__item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent); }
.alert-view__link { font-weight: 500; color: inherit; overflow-wrap: anywhere; }
.alert-view__state { font-size: 0.8125rem; margin-left: auto; }
.alert-view__state--done { opacity: 0.6; }
</style>
