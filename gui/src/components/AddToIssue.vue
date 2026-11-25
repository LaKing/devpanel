<script setup>
import { computed, inject, ref } from 'vue'

import { api } from '@/api'
import { offers } from '@/action-offers'
import { connection } from '@/socket'

/*
 * Put something into an issue: a note, some links, some files.
 *
 * It all lands in one numbered step, which is what the rest of the issue is made
 * of — so it sorts with everything else and is dated. It also reaches the agents:
 * the coordinator's prompt tells it to read the issue folder, so an attached log
 * or a linked ticket is material for the work rather than decoration beside it.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  disabled: { type: Boolean, default: false }
})
const freshness = inject('issueFreshness', null)
const emit = defineEmits(['added'])

const name = ref('')
const text = ref('')
const linkText = ref('')
const files = ref([])
const format = ref('md')

const FORMATS = [
  { value: 'md', title: 'Markdown (.md)' },
  { value: 'txt', title: 'Plain text (.txt)' },
  { value: 'html', title: 'HTML (.html)' }
]
const saving = ref(false)
const error = ref('')
const progress = ref('')

const links = computed(() => linkText.value
  .split(String.fromCharCode(10))
  .map((line) => line.trim())
  .filter(Boolean))

const chosen = computed(() => (Array.isArray(files.value) ? files.value : files.value ? [files.value] : []))

const hasContent = computed(() =>
  Boolean(text.value.trim()) || links.value.length > 0 || chosen.value.length > 0)

/* A name is optional — having to title a note before writing one is work for no
   one's benefit. Without one the step is simply called "note". */
const canSubmit = computed(() => hasContent.value && !saving.value && !props.disabled)

function reset () {
  name.value = ''
  text.value = ''
  linkText.value = ''
  files.value = []
  format.value = 'md'
  progress.value = ''
}

async function submit () {
  if (!canSubmit.value) return
  saving.value = true
  error.value = ''
  progress.value = ''
  try {
    // The step is created first, with whatever text and links were given, so
    // there is somewhere for the files to go — and so a failed upload leaves a
    // step holding the note rather than nothing at all.
    const body = {
      name: name.value.trim() || null,
      text: text.value.trim() || null,
      format: format.value,
      links: links.value.length ? links.value : null
    }
    // On the issue page: added only to the issue this was written on, and only while it takes additions.
    // Every write goes to this captured location, and each one (the step, then every file) passes the guard.
    const location = { project: props.project, issueId: props.issueId }
    const write = async (label, send) => {
      if (!freshness) return { sent: true, value: await send() }
      return freshness.guard({
        label, runId: null, before: location,
        identity: () => ({ project: freshness.issue()?.project ?? location.project, issueId: freshness.issue()?.id ?? location.issueId }),
        offered: freshness.offerOn(offers.addToIssue)
      }, () => send())
    }
    const created = await write('Add to issue', () => api.createStep(location.project, location.issueId, body))
    if (!created.sent) { error.value = created.notice; return }
    let step = created.value

    const queue = chosen.value
    for (const [index, file] of queue.entries()) {
      progress.value = `uploading ${index + 1} of ${queue.length} — ${file.name}`
      const uploaded = await write(`Attach ${file.name}`, () => api.addStepFile(location.project, location.issueId, step.number, file))
      if (!uploaded.sent) {
        error.value = `${uploaded.notice} The note was added as step ${step.number}; ${queue.length - index} file(s) were not.`
        emit('added', step)
        return
      }
      step = uploaded.value
    }

    reset()
    emit('added', step)
  } catch (err) {
    error.value = err.message
  } finally {
    saving.value = false
    progress.value = ''
  }
}
</script>

<template>
  <v-card elevation="0" border class="add">
    <v-card-item class="add__head">
      <v-card-title class="add__title">Add to this issue</v-card-title>
      <v-card-subtitle class="add__hint">a note, links and files — kept as a numbered step</v-card-subtitle>
    </v-card-item>
    <v-divider />

    <v-card-text class="add__body">
      <div class="add__row">
        <v-text-field
          v-model="name"
          label="What is this? (optional)"
          placeholder="report, screenshots, server log…"
          variant="outlined"
          density="comfortable"
          hide-details
          :disabled="saving || disabled"
        />
        <!-- Only the extension changes. Every format is stored as bytes, served
             as a download and shown here as text — .html included. -->
        <v-select
          v-model="format"
          :items="FORMATS"
          label="Text format"
          variant="outlined"
          density="comfortable"
          hide-details
          class="add__format"
          :disabled="saving || disabled"
        />
      </div>

      <v-textarea
        v-model="text"
        label="Text"
        placeholder="What you know about the problem."
        variant="outlined"
        density="comfortable"
        rows="5"
        auto-grow
        hide-details
        class="mt-3"
        :disabled="saving || disabled"
      />

      <v-textarea
        v-model="linkText"
        label="Links and paths"
        :placeholder="`One per line — https://… or ${connection.host?.directories?.projects ?? '/path/to'}/${project}/logs/today.log`"
        variant="outlined"
        density="comfortable"
        rows="2"
        auto-grow
        hide-details
        class="mt-3"
        :disabled="saving || disabled"
      />

      <v-file-input
        v-model="files"
        label="Files"
        variant="outlined"
        density="comfortable"
        multiple
        show-size
        counter
        hide-details
        prepend-icon=""
        prepend-inner-icon="$file"
        class="mt-3"
        :disabled="saving || disabled"
      />

      <p v-if="progress" class="add__progress">{{ progress }}</p>

      <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-3">
        {{ error }}
      </v-alert>
    </v-card-text>

    <v-divider />
    <v-card-actions class="add__actions">
      <span class="add__note">
        Anything added here is inside the issue folder, which the coordinator is
        told to read.
      </span>
      <v-spacer />
      <v-btn variant="text" size="small" :disabled="saving" @click="reset">Clear</v-btn>
      <v-btn color="primary" variant="flat" size="small" :loading="saving"
             :disabled="!canSubmit" @click="submit">
        Add
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped>
.add__head { padding: 14px 20px; }
/* Title and hint stack rather than compete: side by side, a narrow card cuts the
   title in half to make room for the explanation of it. */
.add__title { font-size: 0.9375rem; font-weight: 600; padding: 0; white-space: normal; }
.add__hint { font-size: 0.75rem; opacity: 0.55; padding: 2px 0 0; white-space: normal; }
.add__body { padding: 18px 20px; }
.add__row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.add__row > :first-child { flex: 1 1 14rem; min-width: 0; }
.add__format { flex: 0 1 13rem; min-width: 0; }
.add__progress { margin-top: 10px; font-size: 0.8125rem; opacity: 0.65; }
.add__actions { padding: 12px 16px; gap: 8px; }
.add__note { font-size: 0.75rem; opacity: 0.6; max-width: 28rem; line-height: 1.4; }
</style>
