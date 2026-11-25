<script setup>
import { computed, inject, onUnmounted, ref, watch } from 'vue'

import { api } from '@/api'
import { childReporter, createSeq } from '@/freshness'
import { formatHms, formatMTokens } from '@/format'

/*
 * Where an archived issue's time went (server/issue-stats.mjs): each seat on
 * its model with its own working time, the coordinator's share, and how long
 * the issue stood — inside runs (waiting on a person, stopped, engine work)
 * and with no run going at all.
 */
const props = defineProps({ project: { type: String, required: true }, issueId: { type: String, required: true }, version: { type: Number, default: 0 } })
const stats = ref(null)
const error = ref('')

/* On the issue page its reads report into the page indicator; only the newest applies. */
const freshness = inject('issueFreshness', null)
const seq = createSeq()
const reporter = childReporter(freshness?.registry, 'Time spent')
onUnmounted(() => reporter.dispose())
async function load () {
  const key = `${props.project}/${props.issueId}`
  const ticket = seq.next(key)
  const settle = reporter.start()
  try {
    const next = await api.issueStats(props.project, props.issueId)
    if (!seq.isLatest(ticket, key)) return
    stats.value = next
    error.value = ''
    settle('ok')
  } catch (e) {
    if (!seq.isLatest(ticket, key)) return
    // The last statistics stay on screen beside the error.
    error.value = e.message
    settle('failed', e)
  }
}
watch(() => [props.project, props.issueId, props.version, freshness?.retry.value], load, { immediate: true })
// Another issue's statistics never stand under this one's heading.
watch(() => [props.project, props.issueId], () => { stats.value = null; error.value = '' })

const hms = (x) => (x == null ? '—' : formatHms(x))
const money = (usd, unpriced) => (usd ? `$${usd.toFixed(usd < 1 ? 3 : 2)}${unpriced ? ' +' : ''}` : unpriced ? 'unpriced' : '—')
const t = computed(() => stats.value?.time ?? null)
</script>

<template>
  <section class="istats" aria-label="Time spent on this issue">
    <h3 class="istats__title">Time spent</h3>
    <p v-if="error" class="istats__error">{{ error }} <v-btn size="x-small" variant="text" @click="load">Retry</v-btn></p>
    <p v-if="stats && !stats.runs" class="muted">No run worked on this issue.</p>
    <template v-if="stats && stats.runs">
      <div class="istats__tiles">
        <div class="istats__tile"><span>Agents working</span><strong>{{ hms(t.agentMs) }}</strong><small>{{ stats.runs }} run{{ stats.runs === 1 ? '' : 's' }}</small></div>
        <div class="istats__tile"><span>Coordinator</span><strong>{{ hms(stats.coordinator.agentMs) }}</strong><small>{{ stats.coordinator.turns }} turn{{ stats.coordinator.turns === 1 ? '' : 's' }}</small></div>
        <div class="istats__tile" :title="`waiting on a person ${hms(t.operatorWaitMs)} · stopped ${hms(t.suspendedMs)} · engine work (checks, delivery, retries) ${hms(t.otherMs)}`">
          <span>Standing inside runs</span><strong>{{ hms(t.standingMs) }}</strong>
          <small>person {{ hms(t.operatorWaitMs) }} · stopped {{ hms(t.suspendedMs) }} · engine {{ hms(t.otherMs) }}</small>
        </div>
        <div v-if="stats.lifetime" class="istats__tile"><span>No run going</span><strong>{{ hms(stats.lifetime.noRunMs) }}</strong><small>of {{ hms(stats.lifetime.totalMs) }} open</small></div>
        <div class="istats__tile"><span>Used</span><strong>{{ formatMTokens(stats.usage.tokens) }}</strong><small>{{ money(stats.usage.costUsd, stats.usage.unpricedTurns) }}</small></div>
      </div>
      <table class="istats__table">
        <thead><tr><th>Seat</th><th>Model</th><th>Runs</th><th>Turns</th><th>Agent time</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>
          <tr v-for="s in stats.seats" :key="`${s.role}/${s.model}`">
            <td>{{ s.role }}</td>
            <td>{{ s.model ?? 'unknown' }}<span v-if="s.effort" class="muted"> · {{ s.effort }}</span><span v-if="s.substituted" class="muted" title="a quota substitution replaced the configured model"> · substituted</span></td>
            <td>{{ s.runs }}</td>
            <td>{{ s.turns }}<span v-if="s.repairs" class="muted" title="restated after a protocol failure"> ({{ s.repairs }} repair{{ s.repairs === 1 ? '' : 's' }})</span></td>
            <td>{{ hms(s.agentMs) }}<span v-if="s.untimedTurns" class="muted" title="turns adopted after a restart have no recorded duration"> +{{ s.untimedTurns }} untimed</span></td>
            <td>{{ formatMTokens(s.tokens) }}</td>
            <td>{{ money(s.costUsd, s.unpricedTurns) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="istats__note muted">Agent time is each turn from asked to answered; reviewers working at once each count their own. Standing is run time with no agent working. Read from the run records; nothing is estimated.</p>
    </template>
  </section>
</template>

<style scoped>
.istats { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.istats__title { font-size: 0.95rem; font-weight: 650; margin: 0; }
.istats__tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.istats__tile { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; background: rgba(var(--v-theme-on-surface), 0.04); }
.istats__tile span { font-size: 0.72rem; opacity: 0.65; }
.istats__tile strong { font-size: 1.05rem; font-variant-numeric: tabular-nums; }
.istats__tile small { font-size: 0.7rem; opacity: 0.6; overflow-wrap: anywhere; }
.istats__table { width: 100%; border-collapse: collapse; font-size: 0.8rem; display: block; overflow-x: auto; }
.istats__table th, .istats__table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08); white-space: nowrap; font-variant-numeric: tabular-nums; }
.istats__table th { font-weight: 600; opacity: 0.7; }
.istats__note { font-size: 0.72rem; margin: 0; }
.istats__error { color: rgb(var(--v-theme-error)); font-size: 0.8rem; }
</style>
