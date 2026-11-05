<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { api } from '@/api'
import { socket } from '@/socket'

/*
 * The issue's family (server/issue-family.mjs): where it came from, what came out of it, what it waits for
 * and what waits for it. Provenance and order are separate relations and are shown as separate lines; a
 * parent is not a prerequisite. Reloaded on any issue change in the project, because a sibling's
 * disposition changes what this page should say.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true }
})

const family = ref(null)
const error = ref('')

async function load () {
  try {
    family.value = await api.issueFamily(props.project, props.issueId)
    error.value = ''
  } catch (e) { error.value = e.message }
}

const VIA = { 'follow-up': 'Follow-up of', split: 'Split from', inquiry: 'Proposed by inquiry', finding: 'Finding of' }

function state (m) {
  if (m.missing) return { text: 'not found', color: undefined }
  if (m.disposition) return { text: m.disposition.replace(/-/g, ' '), color: m.disposition === 'resolved' ? 'success' : undefined }
  if (m.packed || m.archived) return { text: 'archived', color: undefined }
  if (m.run?.live) return { text: m.run.status, color: 'primary' }
  if (m.run) return { text: `open · last run ${m.run.status}`, color: 'warning' }
  return { text: 'open', color: 'warning' }
}

const link = (m) => `/projects/${m.project}/${m.id}`
const open = (list) => list.filter((m) => !m.settled && !m.missing).length
const shown = computed(() => {
  const f = family.value
  return Boolean(f && (f.repeats || f.sameTitleAs || f.repeatLookup || f.parent || f.children.length || f.dependsOn.length || f.blocks.length))
})

const onChanged = (payload) => { if (!payload?.project || payload.project === props.project) load() }
onMounted(() => socket.on('issues:changed', onChanged))
onUnmounted(() => socket.off('issues:changed', onChanged))
watch(() => [props.project, props.issueId], load, { immediate: true })
</script>

<template>
  <div v-if="error" class="family family--error">Family links could not be read: {{ error }}</div>
  <section v-else-if="shown" class="family" aria-label="Related issues">
    <div v-if="family.repeats" class="family__line family__repeats">
      <span class="family__label" :title="`The report states the same fingerprint as this earlier issue: ${family.repeats.fingerprint}`">Repeats (same fingerprint <code>{{ family.repeats.fingerprint }}</code>)</span>
      <router-link :to="link(family.repeats)">{{ family.repeats.name ?? family.repeats.id }}</router-link>
      <v-chip size="x-small" variant="tonal" :color="state(family.repeats).color">{{ state(family.repeats).text }}</v-chip>
    </div>

    <div v-if="family.sameTitleAs" class="family__line family__same-title">
      <span class="family__label">Same title as (not shown to be the same fault)</span>
      <router-link :to="link(family.sameTitleAs)">{{ family.sameTitleAs.name ?? family.sameTitleAs.id }}</router-link>
      <v-chip size="x-small" variant="tonal" :color="state(family.sameTitleAs).color">{{ state(family.sameTitleAs).text }}</v-chip>
    </div>

    <div v-if="family.repeatLookup?.listing" class="family__line family__lookup">
      <span class="family__label">The archive could not be listed for this check, so whether this report repeats an earlier issue is not known yet</span>
    </div>
    <div v-else-if="family.repeatLookup?.unread?.length" class="family__line family__line--list family__lookup">
      <span class="family__label">Could not check {{ family.repeatLookup.unread.length }} archived {{ family.repeatLookup.unread.length === 1 ? 'issue' : 'issues' }} for this fingerprint</span>
      <ul class="family__members">
        <li v-for="id in family.repeatLookup.unread" :key="id"><router-link :to="link({ project, id })">{{ id }}</router-link></li>
      </ul>
    </div>

    <div v-if="family.parent" class="family__line">
      <span class="family__label">{{ VIA[family.parent.via] ?? 'Came from' }}</span>
      <router-link :to="{ path: link(family.parent), query: family.parent.runId ? { run: family.parent.runId } : {} }">{{ family.parent.name ?? family.parent.id }}</router-link>
      <v-chip size="x-small" variant="tonal" :color="state(family.parent).color">{{ state(family.parent).text }}</v-chip>
    </div>

    <div v-if="family.children.length" class="family__line family__line--list">
      <span class="family__label">Came out of this · {{ open(family.children) }} of {{ family.children.length }} open</span>
      <ul class="family__members">
        <li v-for="m in family.children" :key="m.id">
          <router-link :to="link(m)">{{ m.name ?? m.id }}</router-link>
          <v-chip size="x-small" variant="tonal" :color="state(m).color">{{ state(m).text }}</v-chip>
        </li>
      </ul>
    </div>

    <div v-if="family.dependsOn.length" class="family__line family__line--list">
      <span class="family__label" :title="family.dependsOnReason ?? ''">Waits for · {{ open(family.dependsOn) }} of {{ family.dependsOn.length }} unsettled</span>
      <ul class="family__members">
        <li v-for="m in family.dependsOn" :key="`${m.project}/${m.id}`">
          <v-icon :icon="m.settled ? '$checkCircle' : '$clock'" size="14" :color="m.settled ? 'success' : 'warning'" />
          <router-link :to="link(m)">{{ m.name ?? m.id }}</router-link>
          <v-chip size="x-small" variant="tonal" :color="state(m).color">{{ state(m).text }}</v-chip>
        </li>
      </ul>
      <p v-if="family.dependsOnReason" class="family__reason">{{ family.dependsOnReason }}</p>
    </div>

    <div v-if="family.blocks.length" class="family__line family__line--list">
      <span class="family__label">Waiting for this</span>
      <ul class="family__members">
        <li v-for="m in family.blocks" :key="m.id">
          <router-link :to="link(m)">{{ m.name ?? m.id }}</router-link>
          <v-chip size="x-small" variant="tonal" :color="state(m).color">{{ state(m).text }}</v-chip>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.family { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; font-size: 0.8125rem; }
.family--error { opacity: 0.7; }
.family__line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.family__line--list { flex-direction: column; align-items: flex-start; gap: 2px; }
.family__label { font-weight: 600; opacity: 0.7; }
.family__members { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; gap: 2px; }
.family__members li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.family__members a { overflow-wrap: anywhere; }
.family__reason { margin: 0; padding-left: 4px; opacity: 0.65; font-style: italic; }
</style>
