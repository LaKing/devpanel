<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'

import { api } from '@/api'
import { connection, socket } from '@/socket'
import { createTracker, describe, displayedOrInflight, guardPass, judgeAction, pageCurrent, runGuard, runKey, startedEntries } from '@/freshness'
import FreshnessIndicator from '@/components/FreshnessIndicator.vue'
import FullVerificationCard from '@/components/FullVerificationCard.vue'
import RunTimeline from '@/components/RunTimeline.vue'
import LiveOutput from '@/components/LiveOutput.vue'
import CycleOutput from '@/components/CycleOutput.vue'

/*
 * The latest full verification in detail: the record (issues/.verification/<date>/cycle.json), and per stage
 * either its drive on a stage instance of the cycle's own, with a terminal that follows what the drive prints
 * (CycleOutput.vue), or its Deployment run, read through the run routes from its run home
 * (issues/<project>/.verification-<date>/, which is not an issue).
 *
 * How current it is (freshness.js): one refresh reads the record and every run it started, and shows them
 * together, only for the latest refresh. A verification event, a reconnect, a tab return or an event of a run
 * shown (or being loaded) invalidates a refresh in flight. The terminals keep their own polling.
 */

const state = ref(null)
/** The runs read with the record, tagged with the cycle they belong to. */
const runSet = ref({ cycleId: null, byProject: {} })
const selected = ref({})

const freshState = reactive({})
const tracker = createTracker(freshState)
const view = computed(() => describe(freshState, connection))
/** The runs the refresh in flight is loading: their events invalidate it before it shows them. */
let inflight = null

const cycle = computed(() => state.value?.cycle ?? null)
const started = computed(() => startedEntries(state.value))
/** A run shown only under the cycle it was read for. */
const runs = computed(() => (runSet.value.cycleId === (cycle.value?.id ?? null) ? runSet.value.byProject : {}))
// Entries the cycle drives itself (instance mode), derives from them (a framework) or holds back for them.
const driven = computed(() => (cycle.value?.projects ?? []).filter((p) => !p.runId && (p.mode === 'instance' || p.mode === 'derived' || p.state === 'deferred')))
const minutes = (ms) => typeof ms === 'number' ? `${(ms / 60000).toFixed(1)} min` : null
/** What changed since the last verification (full-verification.mjs changeList): its sections come in the order shown. */
const changes = computed(() => state.value?.changes ?? { state: 'not-computed' })
const SECTION_TITLES = { delivered: 'Issues delivered', 'by-hand': 'Commits by hand', uncommitted: 'Uncommitted changes' }
const short = (sha) => String(sha ?? '').slice(0, 10)
function rangeLine (repo) {
  const r = repo.range ?? {}
  const n = repo.commits?.total ?? 0
  const count = `${n} ${n === 1 ? 'commit' : 'commits'}${repo.commits?.shown < n ? `, newest ${repo.commits.shown} listed` : ''}`
  return r.from ? `${short(r.from.commit)}..${short(r.to?.commit)} since cycle ${r.from.cycleId} · ${count}` : `${short(r.to?.commit)}, since ${r.since} (no earlier verification) · ${count}`
}
function entryLine (p) {
  const parts = [p.verdict ?? p.state ?? '—']
  if (p.mode === 'derived') parts.push(`derived from ${(p.derived?.from ?? []).map((f) => f.project).join(', ') || 'its instances'}`)
  if (p.state === 'deferred') parts.push('waits for the instances that carry its modules')
  if (p.instance?.name) parts.push(`instance ${p.instance.name}`)
  if (p.startedAt) parts.push(`started ${p.startedAt.slice(11, 19)}Z`)
  if (minutes(p.instance?.readyMs)) parts.push(`ready after ${minutes(p.instance.readyMs)}`)
  return parts.join(' · ')
}

/**
 * Read the record, then every run it started (from that record, never the one on screen), and show them
 * together. 'ok' when it published, 'superseded' when something newer took over, 'failed' otherwise.
 */
async function load () {
  const ticket = tracker.begin()
  try {
    const latest = await api.verificationLatest()
    if (!tracker.isLatest(ticket)) return 'superseded'
    const entries = startedEntries(latest)
    inflight = { ticket, runs: new Set(entries.map(runKey)) }
    const read = await Promise.all(entries.map((p) => api.getRun(p.project, p.issueId, p.runId).then((r) => [p.project, r], (err) => { throw new Error(`${p.project}: ${err.message}`) })))
    if (!tracker.isLatest(ticket)) return 'superseded'
    if (state.value?.cycle?.id !== latest.cycle?.id) selected.value = {}
    state.value = latest
    runSet.value = { cycleId: latest.cycle?.id ?? null, byProject: Object.fromEntries(read) }
    tracker.succeed(ticket, { epoch: connection.epoch })
    return 'ok'
  } catch (err) {
    return tracker.fail(ticket, err) ? 'failed' : 'superseded'
  } finally {
    if (inflight?.ticket === ticket) inflight = null
  }
}
const invalidate = () => { tracker.invalidate(); load() }

/* Run events of a run shown or being loaded: the same rules as the issue page (output ignored, activity throttled). */
let pending = null
let activityAt = 0
function onRunEvent (event) {
  if (!displayedOrInflight(event, { cycle: cycle.value, inflight })) return
  if (event.type === 'activity') {
    if (Date.now() - activityAt < 15_000) return
    activityAt = Date.now()
  }
  tracker.invalidate()
  clearTimeout(pending)
  pending = setTimeout(load, 120)
}

/*
 * "Full verification now" is checked against this page's own refresh: the pre-send read is a full refresh,
 * and an event after it means one more check, then a refusal.
 */
async function guard (spec, send) {
  // The pre-send read is a full refresh of the page, every pass; nothing is awaited from it to the send.
  const result = await runGuard(() => guardPass({
    refresh: 'always',
    // Leaving the page ends the check: nothing is published to it and nothing is sent.
    alive: () => !disposed,
    current: () => pageCurrent(freshState, connection),
    load,
    seq: () => freshState.seq,
    check () {
      const verdict = judgeAction({ offered: spec.offered(), before: spec.before, after: spec.identity() })
      return verdict.send ? null : { reason: verdict.reason }
    },
    send: () => send()
  }))
  if (result.kind === 'send') return { sent: true, value: await result.value }
  return {
    sent: false,
    notice: result.reason === 'unconfirmed' ? `Could not confirm the current state (${freshState.error ?? 'the refresh did not finish'}); nothing was sent.`
      : result.reason === 'superseded' ? 'The cycle changed while this was being checked; nothing was sent.'
        : 'A cycle is already running (or the cycle changed); nothing was sent.'
  }
}

onMounted(() => { load(); socket.on('run:event', onRunEvent) })
let disposed = false
onUnmounted(() => { disposed = true; socket.off('run:event', onRunEvent); clearTimeout(pending); tracker.reset() })
watch(() => connection.verification?.seq, invalidate)
watch(() => connection.epoch, invalidate)
watch(() => connection.resumes, invalidate)

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
    <div class="verify__head">
      <h1 class="verify__title">Full verification</h1>
      <FreshnessIndicator :view="view" @retry="load" />
    </div>
    <v-card elevation="0" border class="mb-4"><FullVerificationCard :latest="state" :guard="guard" :reload="load" /></v-card>

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

    <v-card v-if="cycle" elevation="0" border class="mb-4" data-test="cycle-changes">
      <v-card-item>
        <v-card-title>Changes since the last verification</v-card-title>
        <v-card-subtitle v-if="changes.state === 'computed'">per repository: issues delivered, commits by hand, uncommitted changes</v-card-subtitle>
      </v-card-item>
      <v-card-text class="verify__facts">
        <div v-if="changes.state === 'not-computed'">Not computed yet: the list is computed when the cycle's stages are done.</div>
        <div v-else-if="changes.state === 'failed'">Not computed: {{ changes.error }}</div>
        <template v-else>
          <div v-if="!changes.repositories.length">No repository was read after a snapshot.</div>
          <div v-for="repo in changes.repositories" :key="repo.checkout" class="verify__repo">
            <div><strong>{{ repo.checkout }}</strong><template v-if="repo.project"> · {{ repo.project }}</template></div>
            <div v-if="repo.error">Not read: {{ repo.error }}</div>
            <template v-else>
              <div>{{ rangeLine(repo) }}</div>
              <div v-for="section in repo.sections" :key="section.kind">
                <div class="verify__section">{{ SECTION_TITLES[section.kind] }} ({{ section.kind === 'uncommitted' ? section.total : section.items.length }})</div>
                <template v-if="section.kind === 'delivered'">
                  <div v-for="d in section.items" :key="d.runId">
                    <router-link :to="`/projects/${d.project}/${d.issueId}`">{{ d.issueName ?? d.issueId }}</router-link>
                    · run <code>{{ d.runId }}</code> · {{ d.commits.length ? `committed in ${d.commits.map(short).join(', ')}` : 'uncommitted' }}
                  </div>
                </template>
                <template v-else-if="section.kind === 'by-hand'">
                  <div v-for="c in section.items" :key="c.sha">
                    <code>{{ short(c.sha) }}</code> · {{ c.author }} · {{ c.subject }}<template v-if="c.mixed"> (also carries {{ c.runs.length }} delivered {{ c.runs.length === 1 ? 'run' : 'runs' }})</template>
                  </div>
                </template>
                <template v-else>
                  <div v-for="p in section.paths" :key="p"><code>{{ p }}</code></div>
                  <div v-if="section.total > section.paths.length">and {{ section.total - section.paths.length }} more</div>
                </template>
                <div v-if="section.kind === 'uncommitted' ? !section.total : !section.items.length">None.</div>
              </div>
            </template>
          </div>
        </template>
      </v-card-text>
    </v-card>

    <v-card v-if="cycle?.outcome" elevation="0" border class="mb-4">
      <v-card-item>
        <v-card-title>Outcome</v-card-title>
        <v-card-subtitle>{{ cycle.outcome.bump ? 'every stage green: version bump' : cycle.outcome.issues ? 'red: issues opened, no bump' : 'nothing to do' }}</v-card-subtitle>
      </v-card-item>
      <v-card-text class="verify__facts">
        <div v-if="cycle.outcome.reason">{{ cycle.outcome.reason }}</div>
        <div v-if="cycle.outcome.bump?.reason">{{ cycle.outcome.bump.reason }}</div>
        <div v-for="step in cycle.outcome.bump?.chain ?? []" :key="step.project">
          {{ step.project }}: checkpoint{{ step.args?.length ? ` ${step.args.join(' ')}` : '' }} · {{ step.status }}
          <template v-if="step.status === 'completed'"> · {{ step.versionBefore ?? '?' }} → {{ step.versionAfter ?? '?' }}<template v-if="step.unchanged"> (unchanged)</template></template>
          <template v-if="step.reason"> · {{ step.reason }}</template>
          <template v-if="step.operationId"> · operation <code>{{ step.operationId }}</code></template>
        </div>
        <div v-if="cycle.outcome.bump?.failed">The chain stopped at {{ cycle.outcome.bump.failed.project }}<template v-if="cycle.outcome.bump.notRun?.length">; not run: {{ cycle.outcome.bump.notRun.map((n) => n.project).join(', ') }}</template></div>
        <div v-for="item in cycle.outcome.issues ?? []" :key="item.project">
          <router-link v-if="item.issueId" :to="`/projects/${item.project}/${item.issueId}`">{{ item.name }}</router-link>
          <span v-else>{{ item.name }} (not opened)</span>
          · {{ item.failingCount }} failing {{ item.failingCount === 1 ? 'test' : 'tests' }}<template v-if="item.attachments?.length"> · {{ item.attachments.join(', ') }}</template>
          <template v-if="item.error"> · {{ item.error }}</template>
        </div>
        <div v-if="cycle.outcome.error">Error: {{ cycle.outcome.error }}</div>
      </v-card-text>
    </v-card>

    <v-card v-for="p in driven" :key="`drive-${p.project}`" elevation="0" border class="mb-4" data-test="cycle-entry">
      <v-card-item>
        <v-card-title>{{ p.project }}<template v-if="p.stage"> · {{ p.stage }}</template></v-card-title>
        <v-card-subtitle>{{ entryLine(p) }}</v-card-subtitle>
      </v-card-item>
      <v-card-text v-if="p.mode === 'instance'">
        <p v-if="p.flaky?.length">Flaky (passed alone on the same instance): {{ p.flaky.map((f) => `${f.command}: ${f.test}`).join('; ') }}</p>
        <p v-else-if="p.rerun?.state === 'skipped'">No rerun of failed tests: {{ p.rerun.message }}</p>
        <CycleOutput :key="`${cycle.id}:${p.project}`" :project="p.project" :active="Boolean(state?.active)" />
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
        <p v-if="p.check?.failingTests?.length">Failing tests: {{ p.check.failingTests.map((f) => `${f.command}: ${f.test} (${f.basis})`).join('; ') }}</p>
        <p v-else-if="p.check?.newFailures?.length">New failures: {{ p.check.newFailures.map((f) => `${f.command}: ${f.test}`).join('; ') }}</p>
        <p v-if="p.flaky?.length">Flaky (passed alone on the same instance): {{ p.flaky.map((f) => `${f.command}: ${f.test}`).join('; ') }}</p>
        <p v-else-if="p.rerun?.state === 'skipped'">No rerun of failed tests: {{ p.rerun.message }}</p>
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
.verify__head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 16px; }
.verify__title { font-size: 1.5rem; font-weight: 650; margin: 0; }
.verify__facts { display: grid; gap: 4px; font-size: 0.875rem; }
.verify__detail { white-space: pre-wrap; }
.verify__repo { display: grid; gap: 2px; margin-bottom: 8px; }
.verify__section { font-weight: 600; margin-top: 4px; }
</style>
