<script setup>
import { computed, inject, onUnmounted, ref, watch } from 'vue'

import { api } from '@/api'
import { childReporter, createSeq } from '@/freshness'

/*
 * Whether a run's patch would apply to the checkout NOW, asked every time the issue page shows
 * the run (server/runtime/patch-check.mjs). A moment's textual reading: it says git can place the
 * hunks, not that the code works. For a run whose patch was already delivered, a conflict only
 * means the checkout moved on since, so it is shown as information, not as a fault.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  run: { type: Object, required: true }
})

const result = ref(null)
const error = ref('')
const loading = ref(false)

const delivered = computed(() => props.run.delivery?.application?.state === 'complete' || props.run.artifactApplication?.verified === true || Boolean(props.run.integration?.mergeCommit))

/* On the issue page: only the newest check for the run still shown applies, and it reports into the page indicator. */
const freshness = inject('issueFreshness', null)
const seq = createSeq()
const reporter = childReporter(freshness?.registry, 'Patch check')
onUnmounted(() => reporter.dispose())

async function check () {
  const runId = props.run.runId
  const ticket = seq.next(runId)
  loading.value = true
  const settle = reporter.start()
  try {
    const next = await api.patchCheck(props.project, props.issueId, runId)
    if (!seq.isLatest(ticket, props.run.runId)) return
    result.value = next
    error.value = ''
    settle('ok')
  } catch (e) {
    if (!seq.isLatest(ticket, props.run.runId)) return
    // The last result stays, with its time, beside the error.
    error.value = e.message
    settle('failed', e)
  } finally { if (seq.isLatest(ticket, props.run.runId)) loading.value = false }
}

watch(() => props.run.runId, () => { result.value = null; error.value = '' })
// Again when the run changes, when its patch was just applied from this page, after each page refresh and on Retry:
// "applies now" is never older than the page.
watch(() => [props.run.runId, props.run.artifactApplication?.verified, props.run.delivery?.application?.state, freshness?.synced.value, freshness?.retry.value], check, { immediate: true })

const conflicts = computed(() => (result.value?.owners ?? []).filter((o) => o.state === 'conflicts'))
const files = computed(() => conflicts.value.flatMap((o) => o.conflicts ?? []))
const applied = computed(() => (result.value?.owners ?? []).filter((o) => o.state === 'applied').map((o) => o.path))

const view = computed(() => {
  const r = result.value
  if (loading.value && !r) return { icon: '$circleOutline', text: 'Checking whether the patch applies to the checkout…' }
  if (error.value && !r) return { icon: '$alertCircle', text: `The patch could not be checked: ${error.value}` }
  if (!r) return null
  if (r.state === 'applies') return { icon: '$checkCircle', color: 'success', text: delivered.value ? 'The patch would apply again: the checkout no longer contains it.' : 'The patch applies cleanly to the checkout now.' }
  if (r.state === 'applied') return { icon: '$checkCircle', color: 'success', text: 'The patch is already in the checkout.' }
  if (r.state === 'unavailable') return { icon: '$circleOutline', text: `Not checked: ${r.detail}.` }
  if (delivered.value) return { icon: '$circleOutline', text: `Delivered; the checkout has moved on since in ${files.value.length} file(s).` }
  return { icon: '$alertCircle', color: 'warning', text: `The patch would not apply now: ${files.value.length} file(s) conflict.` }
})

const at = computed(() => (result.value?.checkedAt ? new Date(result.value.checkedAt).toLocaleTimeString() : ''))
</script>

<template>
  <div v-if="view" class="pcheck">
    <div class="pcheck__line">
      <v-icon :icon="view.icon" size="16" :color="view.color" />
      <span>{{ view.text }}</span>
      <span v-if="at" class="pcheck__at" title="A textual git check at this moment; it does not test the code">checked {{ at }}</span>
      <span v-if="error && result" class="pcheck__at">· checking again failed: {{ error }}</span>
      <v-btn icon="$refresh" size="x-small" variant="text" :loading="loading" aria-label="Check again" title="Check again" @click="check" />
    </div>
    <ul v-if="files.length && result?.state === 'conflicts'" class="pcheck__files">
      <li v-for="file in files.slice(0, 8)" :key="file"><code>{{ file }}</code></li>
      <li v-if="files.length > 8" class="pcheck__more">and {{ files.length - 8 }} more</li>
    </ul>
    <p v-if="applied.length && result?.state === 'conflicts'" class="pcheck__note">Already in: <code v-for="p in applied" :key="p">{{ p }}</code></p>
  </div>
</template>

<style scoped>
.pcheck { font-size: 0.8125rem; line-height: 1.5; padding: 2px 0; }
.pcheck__line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; overflow-wrap: anywhere; }
.pcheck__at { opacity: 0.6; font-size: 0.75rem; }
.pcheck__files { margin: 2px 0 0 1.6rem; overflow-wrap: anywhere; }
.pcheck__more, .pcheck__note { opacity: 0.7; }
.pcheck__note { margin: 2px 0 0 1.6rem; }
.pcheck__note code { margin-right: 6px; }
</style>
