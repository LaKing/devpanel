<script setup>
import { computed, onMounted, ref, watch } from 'vue'

import { api } from '@/api'
import { connection } from '@/socket'

/*
 * The daily full verification on the dashboard (server/full-verification.mjs):
 * the latest cycle, one line per project, and "Full verification now", which
 * starts the same cycle the schedule does: admission closes, live runs pause at
 * their next step boundary, and one staging Deployment runs per stage.
 */

const state = ref(null)
const error = ref('')
const starting = ref(false)
const confirming = ref(false)

async function load () {
  try { state.value = await api.verificationLatest(); error.value = '' } catch (err) { error.value = err.message }
}

async function startNow () {
  starting.value = true
  try { await api.startVerification(); confirming.value = false; await load() } catch (err) { error.value = err.message } finally { starting.value = false }
}

onMounted(load)
watch(() => connection.verification?.at, load)

const cycle = computed(() => state.value?.cycle ?? null)
const verdictColor = (v) => (v === 'green' ? 'success' : v === 'red' ? 'error' : undefined)
const rows = computed(() => (cycle.value?.projects ?? []).map((p) => ({
  key: p.project,
  project: p.project,
  stage: p.stage,
  text: p.verifiedThrough ? 'verified through its instances'
    : p.refusal ? `not started: ${p.refusal.message}`
      : p.state === 'settled' ? `${p.status}${p.blockedReason ? ` (${p.blockedReason})` : ''}`
        : p.state ?? 'pending',
  verdict: p.verifiedThrough ? null : p.verdict ?? null,
  duration: p.durationMs != null ? `${Math.round(p.durationMs / 60000)} min` : null
})))

/** What the cycle did about its verdict: the versions it bumped, where the bump stopped, or the issues it opened. */
const outcome = computed(() => {
  const o = cycle.value?.outcome
  if (!o) return null
  if (o.error) return `Outcome failed: ${o.error}`
  if (o.bump?.failed) return `Bump stopped at ${o.bump.failed.project}: ${o.bump.failed.reason}`
  if (o.bump?.chain?.length) return `Bumped: ${o.bump.chain.map((s) => `${s.project} ${s.versionBefore ?? '?'} → ${s.versionAfter ?? '?'}`).join(', ')}`
  if (o.bump) return o.bump.reason ?? 'Nothing to bump'
  if (o.issues) return `Opened ${o.issues.filter((i) => i.issueId).length} ${o.issues.length === 1 ? 'issue' : 'issues'}: ${o.issues.map((i) => i.issueId ?? `${i.project} (not opened)`).join(', ')}`
  return o.reason ?? null
})
</script>

<template>
  <div class="fv">
    <div class="fv__head">
      <div class="fv__summary">
        <template v-if="cycle">
          <strong>{{ cycle.id }}</strong>
          <span>· {{ cycle.trigger === 'hand' ? 'started by hand' : 'scheduled' }}</span>
          <span>· {{ cycle.state }}</span>
          <v-chip v-if="cycle.verdict" size="x-small" :color="verdictColor(cycle.verdict)" variant="tonal" class="ml-1">{{ cycle.verdict }}</v-chip>
        </template>
        <span v-else>No cycle has run yet.</span>
        <div class="fv__schedule">
          <template v-if="state?.schedule">Daily at {{ state.schedule.at }} ({{ state.schedule.timeZone }}), next {{ new Date(state.schedule.next).toLocaleString() }}</template>
          <template v-else>No schedule: host settings have no fullVerification block.</template>
          <template v-if="state?.frozen"> · admission closed since {{ new Date(state.frozen.at).toLocaleTimeString() }}</template>
        </div>
        <div v-if="outcome" class="fv__outcome">{{ outcome }}</div>
      </div>
      <div class="fv__actions">
        <v-btn variant="text" size="small" to="/verification">Details</v-btn>
        <v-btn variant="tonal" size="small" prepend-icon="$play" :disabled="state?.active" :loading="starting" @click="confirming = true">Full verification now</v-btn>
      </div>
    </div>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-2">{{ error }}</v-alert>

    <ul v-if="rows.length" class="fv__rows">
      <li v-for="row in rows" :key="row.key" class="fv__row">
        <v-icon :icon="row.verdict === 'green' ? '$checkCircle' : row.verdict === 'red' ? '$alertCircle' : '$circleOutline'" size="16" :color="verdictColor(row.verdict)" />
        <span class="fv__project">{{ row.project }}</span>
        <span v-if="row.stage" class="fv__stage">{{ row.stage }}</span>
        <span class="fv__text">{{ row.text }}</span>
        <span v-if="row.duration" class="fv__duration">{{ row.duration }}</span>
      </li>
    </ul>

    <v-dialog v-model="confirming" max-width="460">
      <v-card>
        <v-card-title>Full verification now</v-card-title>
        <v-card-text>
          Admission closes: no run starts, live runs pause at their next step boundary, and once no seat turn is running
          one staging Deployment run starts for every configured stage. Paused runs resume when the cycle ends.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirming = false">Cancel</v-btn>
          <v-btn color="primary" variant="flat" :loading="starting" @click="startNow">Start the cycle</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.fv { padding: 8px 16px 16px; }
.fv__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.fv__summary { font-size: 0.875rem; }
.fv__schedule { margin-top: 2px; opacity: 0.7; font-size: 0.8125rem; }
.fv__outcome { margin-top: 2px; font-size: 0.8125rem; overflow-wrap: anywhere; }
.fv__actions { display: flex; gap: 6px; }
.fv__rows { list-style: none; margin: 10px 0 0; padding: 0; }
.fv__row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 0.8125rem; min-width: 0; }
.fv__project { font-weight: 600; }
.fv__stage { opacity: 0.7; }
.fv__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fv__duration { opacity: 0.7; }
</style>
