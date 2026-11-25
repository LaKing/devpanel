<script setup>
import { computed, ref } from 'vue'

import CycleOutput from '@/components/CycleOutput.vue'

/*
 * A Full verification run (server/full-verification-run.mjs): the timeline of the cycle's phases as the run mirrored
 * it (run.cycleRun.phases), what each holds, the projects it verifies, and per stage where its output is. Output comes
 * through the verification output feed for this run's own cycle (CycleOutput with its cycle id), the same terminal as
 * the Full verification page; an entry with nothing driven says why and shows no terminal.
 */
const props = defineProps({ run: { type: Object, required: true } })

const c = computed(() => props.run.cycleRun ?? {})
const live = computed(() => ['pending', 'preflighting', 'running', 'stopping'].includes(props.run.status))
const open = ref({})
const shownOutput = ref(null)
const time = (iso) => (iso ? `${iso.slice(11, 19)}Z` : '')
const STATE_COLOUR = { done: 'success', running: 'primary', interrupted: 'warning', failed: 'error', skipped: undefined, pending: undefined }
const SECTION_TITLES = { delivered: 'Issues delivered', 'by-hand': 'Commits by hand', uncommitted: 'Uncommitted changes' }
const projectLink = (p) => `/projects/${encodeURIComponent(p)}`
const toggle = (id) => { open.value = { ...open.value, [id]: !open.value[id] } }
</script>

<template>
  <div class="cycle-run" data-test="cycle-run">
    <div class="cycle-run__head">
      <span class="cycle-run__title">Full verification{{ c.cycleId ? ` · cycle ${c.cycleId}` : '' }}</span>
      <span v-if="c.verdict" class="cycle-run__muted">verdict {{ c.verdict }}</span>
    </div>
    <div v-if="c.scope?.length" class="cycle-run__scope">
      <span class="cycle-run__muted">Verifies</span>
      <router-link v-for="p in c.scope" :key="p" :to="projectLink(p)" class="cycle-run__link">{{ p }}</router-link>
    </div>

    <section v-for="phase in c.phases ?? []" :key="phase.id" class="phase" :data-phase="phase.id">
      <button type="button" class="phase__head" :aria-expanded="Boolean(open[phase.id])" @click="toggle(phase.id)">
        <v-chip size="x-small" variant="tonal" :color="STATE_COLOUR[phase.state]">{{ phase.state }}</v-chip>
        <span class="phase__title">{{ phase.title ?? phase.id }}</span>
        <span class="cycle-run__muted">{{ time(phase.startedAt) }}{{ phase.endedAt ? ` – ${time(phase.endedAt)}` : '' }}</span>
      </button>
      <div v-if="open[phase.id] || phase.state === 'running'" class="phase__body">
        <template v-if="!phase.detail"><span class="cycle-run__muted">Nothing recorded yet.</span></template>

        <!-- The first entry: what the cycle would verify and pause, read before the freeze, then what it asked. -->
        <template v-else-if="phase.id === 'freeze'">
          <template v-if="phase.detail.preview">
            <div v-if="phase.detail.preview.error" class="cycle-run__muted">The preview could not be read: {{ phase.detail.preview.error }}</div>
            <div class="cycle-run__muted">Read {{ time(phase.detail.preview.readAt) }}, before the freeze ({{ phase.detail.preview.basis }}).</div>
            <div><strong>Would pause:</strong> {{ (phase.detail.preview.wouldPause ?? []).map((r) => `${r.project}/${r.issueId} (${r.reason})`).join(', ') || 'none' }}</div>
            <div v-if="phase.detail.preview.mayContinue?.length"><strong>Decided at the freeze:</strong> {{ phase.detail.preview.mayContinue.map((r) => `${r.project}/${r.issueId}`).join(', ') }}</div>
            <template v-if="phase.detail.preview.changes?.state === 'computed'">
              <div v-for="repo in phase.detail.preview.changes.repositories" :key="repo.checkout" class="phase__repo">
                <code>{{ repo.project ?? repo.checkout }}</code>
                <span v-if="repo.error" class="cycle-run__muted"> {{ repo.error }}</span>
                <div v-for="sec in repo.sections ?? []" :key="sec.kind" class="cycle-run__muted">
                  {{ SECTION_TITLES[sec.kind] }}: {{ sec.kind === 'uncommitted' ? sec.total : sec.items.length }}
                </div>
              </div>
            </template>
            <div v-else-if="phase.detail.preview.changes" class="cycle-run__muted">Changes: {{ phase.detail.preview.changes.error ?? phase.detail.preview.changes.state }}</div>
          </template>
          <div v-if="phase.detail.asked"><strong>Asked to pause at the freeze:</strong> {{ phase.detail.asked.map((r) => `${r.project}/${r.issueId}`).join(', ') || 'none' }}</div>
        </template>

        <template v-else-if="phase.id === 'wait'">
          <div v-if="phase.detail.waitingOn?.length">Waiting for: {{ phase.detail.waitingOn.map((w) => `${w.project}/${w.issueId ?? ''} ${w.kind ?? ''}`).join(', ') }}</div>
          <div v-else-if="phase.detail.waited">Waited {{ Math.round((phase.detail.waited.ms ?? 0) / 1000) }} s.</div>
        </template>

        <template v-else-if="phase.id === 'stages'">
          <div v-for="e in phase.detail.entries" :key="e.project" class="stage" :data-stage="e.project">
            <div>
              <code>{{ e.project }}</code>
              <span class="cycle-run__muted"> {{ [e.stage, e.mode, e.state, e.verdict, e.refusal, e.instance].filter(Boolean).join(' · ') }}</span>
            </div>
            <div class="cycle-run__muted" data-test="output-where">
              <template v-if="e.output?.where === 'feed'">
                Output: this drive's terminal
                <button type="button" class="cycle-run__link" @click="shownOutput = shownOutput === e.project ? null : e.project">{{ shownOutput === e.project ? 'hide' : 'show' }}</button>
                <template v-if="e.output.run"> · its Deployment run on the <router-link to="/verification" class="cycle-run__link">Full verification page</router-link></template>
              </template>
              <template v-else>No output: {{ e.output?.reason ?? 'nothing was driven' }}</template>
            </div>
            <CycleOutput v-if="shownOutput === e.project && e.output?.where === 'feed' && c.cycleId" :project="e.project" :cycle-id="c.cycleId" :active="live" />
          </div>
        </template>

        <template v-else-if="phase.id === 'outcome'">
          <div>Verdict: {{ phase.detail.verdict ?? '—' }}{{ phase.detail.committed ? ' · checkpoint committed' : '' }}{{ phase.detail.withheld?.length ? ` · withheld for ${phase.detail.withheld.join(', ')}` : '' }}</div>
          <div v-if="phase.detail.issues?.length">Issues opened: {{ phase.detail.issues.map((i) => `${i.project}/${i.issueId}`).join(', ') }}</div>
          <template v-if="phase.detail.changes?.state === 'computed'">
            <div v-for="repo in phase.detail.changes.repositories" :key="repo.checkout" class="cycle-run__muted">
              <code>{{ repo.project ?? repo.checkout }}</code>:
              {{ (repo.sections ?? []).map((sec) => `${SECTION_TITLES[sec.kind]} ${sec.kind === 'uncommitted' ? sec.total : sec.items.length}`).join(' · ') || repo.error }}
            </div>
          </template>
        </template>

        <template v-else-if="phase.id === 'thaw'">
          <div>Resumed {{ phase.detail.resumed.length }}, held for an operator {{ phase.detail.heldForOperator.length }}, left paused {{ phase.detail.leftPaused.length }}, refused {{ phase.detail.refused.length }}.</div>
          <div v-if="phase.detail.interruption" class="cycle-run__muted">Interrupted: {{ phase.detail.interruption.reason }}{{ phase.detail.interruption.by ? ` by ${phase.detail.interruption.by}` : '' }}</div>
        </template>
      </div>
    </section>
    <div v-if="run.cycleRun?.ownerLost" class="cycle-run__muted">{{ run.cycleRun.ownerLost.detail }}</div>
    <router-link v-if="c.cycleId" to="/verification" class="cycle-run__link">Full verification page</router-link>
  </div>
</template>

<style scoped>
.cycle-run { display: flex; flex-direction: column; gap: 6px; }
.cycle-run__head { display: flex; gap: 8px; align-items: baseline; }
.cycle-run__title { font-weight: 600; }
.cycle-run__scope { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.cycle-run__muted { font-size: 0.8rem; opacity: 0.7; }
.cycle-run__link { font-size: 0.8rem; background: none; border: 0; padding: 0; color: rgb(var(--v-theme-primary)); cursor: pointer; text-decoration: underline; }
.phase { border-top: 1px solid rgba(127, 127, 127, 0.2); padding-top: 4px; }
.phase__head { display: flex; gap: 8px; align-items: center; width: 100%; background: none; border: 0; padding: 2px 0; text-align: left; cursor: pointer; color: inherit; }
.phase__title { flex: 1; }
.phase__body { padding: 4px 0 6px 8px; display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; }
.stage { display: flex; flex-direction: column; gap: 2px; }
</style>
