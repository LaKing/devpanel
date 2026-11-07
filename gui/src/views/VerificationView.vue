<script setup>
import { computed, onMounted, ref, watch } from 'vue'

import { api } from '@/api'
import { connection } from '@/socket'
import FullVerificationCard from '@/components/FullVerificationCard.vue'
import RunTimeline from '@/components/RunTimeline.vue'
import LiveOutput from '@/components/LiveOutput.vue'

/*
 * The latest daily full verification in detail: the record (issues/.verification/<date>/cycle.json)
 * and each stage's Deployment run, read through the run routes from its run home
 * (issues/<project>/.verification-<date>/, which is not an issue).
 */

const state = ref(null)
const runs = ref({})
const selected = ref({})
const error = ref('')

const cycle = computed(() => state.value?.cycle ?? null)
const started = computed(() => (cycle.value?.projects ?? []).filter((p) => p.runId))

async function load () {
  try {
    state.value = await api.verificationLatest()
    const loaded = {}
    for (const p of started.value) loaded[p.project] = await api.getRun(p.project, p.issueId, p.runId).catch((err) => ({ error: err.message }))
    runs.value = loaded
    error.value = ''
  } catch (err) { error.value = err.message }
}

onMounted(load)
watch(() => connection.verification?.at, load)

/** The invocation a selected timeline entry names: a live one, or a recorded turn's. */
function invocationOf (project) {
  const run = runs.value[project]
  const pick = selected.value[project]
  if (!run || pick == null) return null
  if (typeof pick === 'string' && pick.startsWith('live:')) return { id: pick.slice(5), live: true }
  const turn = (run.timeline ?? []).find((t) => t.number === pick)
  return turn?.invocationId ? { id: turn.invocationId, live: false } : null
}
</script>

<template>
  <v-container fluid class="verify">
    <h1 class="verify__title">Full verification</h1>
    <v-card elevation="0" border class="mb-4"><FullVerificationCard /></v-card>
    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>

    <v-card v-if="cycle" elevation="0" border class="mb-4">
      <v-card-text class="verify__facts">
        <div>Record: <code>issues/.verification/{{ cycle.date }}/cycle.json</code></div>
        <div>Frozen {{ cycle.frozenAt ?? '—' }} · seats idle {{ cycle.seatsIdleAt ?? '—' }} · ended {{ cycle.endedAt ?? '—' }}</div>
        <div v-if="cycle.waitingOn?.length">Waiting for: {{ cycle.waitingOn.map((w) => `${w.project}/${w.issueId}`).join(', ') }}</div>
        <div v-if="cycle.resumed?.length">Resumed: {{ cycle.resumed.map((r) => `${r.project}/${r.issueId}`).join(', ') }}</div>
        <div v-if="cycle.heldForOperator?.length">Left paused for an operator: {{ cycle.heldForOperator.map((r) => `${r.project}/${r.issueId}`).join(', ') }}</div>
        <div v-if="cycle.refused?.length">Not resumed: {{ cycle.refused.map((r) => `${r.project}/${r.issueId}: ${r.reason}`).join('; ') }}</div>
        <div v-if="cycle.error">Error: {{ cycle.error }}</div>
      </v-card-text>
    </v-card>

    <v-card v-for="p in started" :key="p.project" elevation="0" border class="mb-4">
      <v-card-item>
        <v-card-title>{{ p.project }} · {{ p.stage }}</v-card-title>
        <v-card-subtitle>
          {{ runs[p.project]?.explanation?.headline ?? runs[p.project]?.status ?? p.state }}
          <template v-if="p.check"> · full check {{ p.check.result ?? '—' }}, gate {{ p.check.gating }}<template v-if="p.check.baseline?.cycleId">, compared with {{ p.check.baseline.cycleId }}</template></template>
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <p v-if="runs[p.project]?.error">{{ runs[p.project].error }}</p>
        <p v-if="runs[p.project]?.explanation?.detail" class="verify__detail">{{ runs[p.project].explanation.detail }}</p>
        <p v-if="p.check?.newFailures?.length">New failures: {{ p.check.newFailures.map((f) => `${f.command}: ${f.test}`).join('; ') }}</p>
        <RunTimeline v-if="runs[p.project]?.timeline" :timeline="runs[p.project].timeline" :active="runs[p.project].active ?? []"
                     :selected="selected[p.project] == null ? null : String(selected[p.project])" @select="selected = { ...selected, [p.project]: $event }" />
        <LiveOutput v-if="invocationOf(p.project)" :key="invocationOf(p.project).id" :project="p.project" :issue-id="p.issueId" :run-id="p.runId"
                    :invocation-id="invocationOf(p.project).id" :live="invocationOf(p.project).live" />
      </v-card-text>
    </v-card>
  </v-container>
</template>

<style scoped>
.verify { padding: 28px 24px 40px; }
.verify__title { font-size: 1.5rem; font-weight: 650; margin-bottom: 16px; }
.verify__facts { display: grid; gap: 4px; font-size: 0.875rem; }
.verify__detail { white-space: pre-wrap; }
</style>
