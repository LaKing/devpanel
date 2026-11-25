<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import { api } from '@/api'
import { createTracker, guardPass, judgeAction, pageCurrent, runGuard } from '@/freshness'
import { connection } from '@/socket'

/*
 * The full verification on the dashboard (server/full-verification.mjs):
 * the latest cycle, one line per project, and "Full verification now", which starts a Full
 * verification playbook run (POST /api/verification/start, server/full-verification-run.mjs), as the
 * delivery count and the top-level supervisor do: every cycle is such a run. Admission closes for the
 * projects it verifies, their live writing runs pause at their next step boundary, runs of other
 * projects go on, and each stage is verified.
 */

const props = defineProps({
  /** On the Full verification page: the page's snapshot. The card then reads nothing itself. */
  latest: { type: Object, default: undefined },
  /** The page's guard, so "Full verification now" is checked against the page's own refresh. */
  guard: { type: Function, default: null },
  /** Refresh the page after a start. */
  reload: { type: Function, default: null }
})

const own = ref(null)
const state = computed(() => (props.latest !== undefined ? props.latest : own.value))
const error = ref('')
const starting = ref(false)
const confirming = ref(false)
/** The run the last start began ({project, issueId, runId}): linked until its cycle is the one shown. */
const startedRun = ref(null)
const runLink = (r) => `/projects/${encodeURIComponent(r.project)}/${encodeURIComponent(r.issueId)}?run=${encodeURIComponent(r.runId)}`
/** Earlier records may carry `schedule` (the daily time, removed); `supervisor` is the top-level supervisor's start. */
const TRIGGERS = { hand: 'started by hand', schedule: 'scheduled', deliveries: 'after deliveries', playbook: 'started as a playbook run', supervisor: 'started by the top-level supervisor' }

/*
 * On the dashboard the card reads for itself: only its newest read applies, and a
 * verification event, a reconnect or a tab return invalidates a read in flight.
 */
const freshState = reactive({})
const tracker = createTracker(freshState)
async function readLatest () {
  const ticket = tracker.begin()
  try {
    const next = await api.verificationLatest()
    if (!tracker.isLatest(ticket)) return 'superseded'
    own.value = next
    error.value = ''
    tracker.succeed(ticket, { epoch: connection.epoch })
    return 'ok'
  } catch (err) {
    if (tracker.fail(ticket, err)) error.value = err.message
    return 'failed'
  }
}
const load = () => (props.latest === undefined ? readLatest() : null)
const invalidate = () => { if (props.latest === undefined) { tracker.invalidate(); load() } }

/** The dashboard's own guard: the same rule as the page's, over its own read. */
async function ownGuard (spec, send) {
  const result = await runGuard(() => guardPass({
    refresh: 'always',
    // The dashboard left: nothing more is checked or sent.
    alive: () => !disposed,
    current: () => pageCurrent(freshState, connection),
    load: readLatest,
    seq: () => freshState.seq,
    check () {
      const verdict = judgeAction({ offered: spec.offered(), before: spec.before, after: spec.identity() })
      return verdict.send ? null : { reason: verdict.reason }
    },
    send: () => send()
  }))
  if (result.kind === 'send') return { sent: true, value: await result.value }
  return { sent: false, notice: result.reason === 'unconfirmed' ? `Could not confirm the current state (${freshState.error ?? 'no answer'}); nothing was sent.` : NOT_SENT }
}
const NOT_SENT = 'A cycle is already running (or the cycle changed); nothing was sent.'

/* What the confirmation was opened on: a cycle that started or changed since refuses the start. */
const identityOf = (s) => ({ cycleId: s?.cycle?.id ?? null, active: Boolean(s?.active) })
let shown = null
watch(confirming, (open) => { if (open) shown = identityOf(state.value) })

async function startNow () {
  starting.value = true
  try {
    const spec = { label: 'Full verification now', before: shown, identity: () => identityOf(state.value), offered: () => !state.value?.active }
    const r = await (props.guard ?? ownGuard)(spec, () => api.startVerification())
    confirming.value = false
    if (!r.sent) { error.value = r.notice; return }
    startedRun.value = r.value?.run ?? null
    await (props.reload ?? load)()
  } catch (err) { error.value = err.message } finally { starting.value = false }
}

let disposed = false
onUnmounted(() => { disposed = true; tracker.reset() })
onMounted(load)
watch(() => connection.verification?.seq, invalidate)
watch(() => connection.epoch, invalidate)
watch(() => connection.resumes, invalidate)

const cycle = computed(() => state.value?.cycle ?? null)
const verdictColor = (v) => (v === 'green' ? 'success' : v === 'red' ? 'error' : undefined)
const rows = computed(() => (cycle.value?.projects ?? []).map((p) => ({
  key: p.project,
  project: p.project,
  stage: p.stage,
  text: p.verifiedThrough ? 'verified through its instances'
    : p.derived ? `derived from ${p.derived.from.map((f) => f.project).join(', ')}${p.derived.red.length ? ` (not green: ${p.derived.red.map((r) => r.project).join(', ')})` : ''}`
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
          <span>· {{ TRIGGERS[cycle.trigger] ?? cycle.trigger }}</span>
          <!-- A cycle a Full verification playbook run wraps (server/full-verification-run.mjs): its run. -->
          <router-link v-if="cycle.run" data-test="cycle-run-link" :to="runLink(cycle.run)">· its run</router-link>
          <span>· {{ cycle.state }}</span>
          <v-chip v-if="cycle.verdict" size="x-small" :color="verdictColor(cycle.verdict)" variant="tonal" class="ml-1">{{ cycle.verdict }}</v-chip>
        </template>
        <span v-else>No cycle has run yet.</span>
        <!-- A run just started previews before its cycle begins: linked until its cycle is shown. -->
        <div v-if="startedRun && cycle?.run?.runId !== startedRun.runId" class="fv__started">
          Started a Full verification run <router-link data-test="started-run-link" :to="runLink(startedRun)">{{ startedRun.runId }}</router-link>; its cycle begins after its preview.
        </div>
        <div class="fv__schedule">
          <template v-if="state?.afterDeliveries">Starts by itself after {{ state.afterDeliveries }} deliveries per stage; by hand or by the top-level supervisor any time</template>
          <template v-else-if="state">Never starts by itself (afterDeliveries 0): started by hand or by the top-level supervisor</template>
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
          Starts a Full verification playbook run. Its cycle closes admission for the projects it verifies: their writing
          runs do not start, live ones pause at their next step boundary, and once nothing is in flight every configured
          stage is verified. Paused runs resume when the cycle ends.
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
.fv__started { margin-top: 2px; font-size: 0.8125rem; }
.fv__outcome { margin-top: 2px; font-size: 0.8125rem; overflow-wrap: anywhere; }
.fv__actions { display: flex; gap: 6px; }
.fv__rows { list-style: none; margin: 10px 0 0; padding: 0; }
.fv__row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 0.8125rem; min-width: 0; }
.fv__project { font-weight: 600; }
.fv__stage { opacity: 0.7; }
.fv__text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fv__duration { opacity: 0.7; }
</style>
