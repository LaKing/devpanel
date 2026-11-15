<script setup>
import { formatHms, formatMTokens, supervisorUsage } from '@/format'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/api'
import { connection, socket } from '@/socket'
import MarkdownText from '@/components/MarkdownText.vue'

const state = ref(null)
const error = ref('')
let poller, sequence = 0

async function load () {
  const request = ++sequence
  try {
    const next = await api.supervisor()
    if (request !== sequence) return
    state.value = next
    error.value = ''
  } catch (err) {
    if (request === sequence) error.value = err.message
  }
}

const latest = computed(() => state.value?.messages?.findLast(m => m.role === 'assistant' && m.protocol?.valid === true))
const statusColour = computed(() => ({
  active: 'primary', working: 'primary', stopping: 'warning', 'recovery-required': 'warning'
})[state.value?.status])

onMounted(() => {
  load()
  poller = setInterval(load, 5000)
  socket.on('supervisor:changed', load)
  socket.on('connect', load)
})
onUnmounted(() => {
  sequence++
  clearInterval(poller)
  socket.off('supervisor:changed', load)
  socket.off('connect', load)
})
defineExpose({ load })
/* The supervisor's model calls, as cost is reported: time and tokens. */
const callUsage = computed(() => state.value?.chat?.usage ?? supervisorUsage(state.value?.messages ?? []))
</script>

<template>
  <section class="supervisor-overview" aria-label="Supervisor overview">
    <div class="supervisor-overview__head">
      <RouterLink to="/supervisor">Open supervisor</RouterLink>
      <v-chip v-if="state" size="x-small" variant="tonal" :color="statusColour" role="status">{{ state.status }}</v-chip>
      <v-chip v-if="state?.finishing" size="x-small" variant="tonal">finishing</v-chip>
    </div>
    <v-alert v-if="connection.status !== 'online' && state" type="warning" variant="tonal" density="compact" class="mt-3">
      Connection lost — showing the last supervisor state. It refreshes on reconnect.
    </v-alert>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">{{ error }}</v-alert>
    <p v-if="!state && !error" class="supervisor-overview__meta">Loading supervisor…</p>
    <template v-if="state">
      <p v-if="!state.model" class="supervisor-overview__meta">No supervisor session yet. Open the supervisor to give it an objective.</p>
      <p v-else class="supervisor-overview__meta">
        {{ state.model.id }} · {{ state.calls }} model-call attempts this activation · {{ state.starts }} lifetime run-start attempts · {{ formatHms(callUsage.durationMs) }} · {{ formatMTokens(callUsage.tokens) }}
        <template v-if="callUsage.untimed"> · {{ callUsage.untimed }} earlier calls untimed</template>
      </p>
      <p v-if="state.focus?.length" class="supervisor-overview__meta">Focus: {{ state.focus.join(', ') }} <span class="muted">(every project stays visible)</span></p>
      <p v-if="state.mission" class="supervisor-overview__mission">{{ state.mission }}</p>
      <p v-if="state.status === 'working'">Supervisor is thinking — awaiting a reply.</p>
      <p v-if="state.reason">{{ state.reason }}</p>
      <div v-if="latest" class="supervisor-overview__update">
        <span class="supervisor-overview__meta">Latest update</span>
        <MarkdownText :text="latest.text" compact />
      </div>
    </template>
  </section>
</template>

<style scoped>
.supervisor-overview { padding: 12px 20px 18px; font-size: 0.8125rem; overflow-wrap: anywhere; }
.supervisor-overview__head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.supervisor-overview__head a { color: inherit; font-weight: 600; }
.supervisor-overview p { margin-top: 7px; }
.supervisor-overview__meta { font-size: 0.75rem; opacity: 0.65; }
.supervisor-overview__mission { white-space: pre-wrap; }
.supervisor-overview__update { margin-top: 12px; max-height: 240px; overflow: auto; }
</style>
