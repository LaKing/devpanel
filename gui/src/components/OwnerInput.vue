<script setup>
import QuestionBrief from '@/components/QuestionBrief.vue'
import { computed, reactive, ref, watch } from 'vue'

import { api } from '@/api'
import { actorName, proxyUser, rememberedActor } from '@/identity'

/*
 * What a triage asked before starting any work (run.ownerInput).
 *
 * The run already ended: nothing is held while this waits. Answering records
 * the answers on the run, writes them to the issue as a note the next run
 * reads, and starts the same configuration again. A proposed split is
 * accepted (the parts become new issues) or declined (the whole runs anyway).
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  run: { type: Object, required: true }
})
const emit = defineEmits(['answered'])

const CATEGORY = {
  'owner-gate': 'you asked to confirm',
  'requirement-conflict': 'requirements conflict',
  authorization: 'needs your authorization',
  'missing-information': 'only you know'
}

const asked = computed(() => props.run.ownerInput)
const split = computed(() => asked.value?.verdict === 'too-large')
const answers = reactive({})
const note = ref('')
const actor = ref(rememberedActor())
const sending = ref(false)
const error = ref('')
const startError = ref('')

watch(() => props.run.runId, () => { for (const k of Object.keys(answers)) delete answers[k]; note.value = ''; error.value = ''; startError.value = '' })

const complete = computed(() => (proxyUser.value || actor.value.trim()) && (split.value || (asked.value?.questions ?? []).every((q) => answers[q.id]?.trim())))

async function send (choice = null) {
  if (!actorName(actor.value)) { error.value = 'Your name is required.'; return }
  sending.value = true
  error.value = ''
  startError.value = ''
  try {
    const body = { actor: actorName(actor.value), note: note.value.trim() || null, ...(split.value ? { split: choice } : { answers: { ...answers } }) }
    const out = await api.answerOwnerInput(props.project, props.issueId, props.run.runId, body)
    if (out.startError) startError.value = `Answer recorded, but the next run did not start: ${out.startError.message}`
    emit('answered', out)
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <section class="owner">
    <template v-if="!split">
      <div v-for="q in asked.questions" :key="q.id" class="owner__q">
        <div class="owner__head">
          <strong>{{ q.id }}.</strong> {{ q.question }}
          <v-chip size="x-small" variant="tonal" class="ml-1">{{ CATEGORY[q.category] ?? q.category }}</v-chip>
        </div>
        <!-- Asked of the consult panel first, which did not settle it: its wording for a person. -->
        <QuestionBrief v-if="q.brief" :brief="q.brief" :consult="q.consult" @choose="answers[q.id] = $event" />
        <div v-if="q.recommendation" class="owner__rec">
          Recommended: {{ q.recommendation }}
          <v-btn size="x-small" variant="text" color="primary" @click="answers[q.id] = q.options?.length ? q.options[0] : `Agreed: ${q.recommendation}`">Use this</v-btn>
        </div>
        <div v-if="q.options?.length" class="owner__options">
          <v-btn v-for="o in q.options" :key="o" size="x-small" :variant="answers[q.id] === o ? 'flat' : 'tonal'" color="primary" @click="answers[q.id] = o">{{ o }}</v-btn>
        </div>
        <v-textarea v-model="answers[q.id]" :label="`Answer to ${q.id}`" rows="1" auto-grow density="compact" variant="outlined" hide-details />
      </div>
    </template>
    <ol v-else class="owner__parts">
      <li v-for="part in asked.split" :key="part.title"><strong>{{ part.title }}</strong> — {{ part.scope }}</li>
    </ol>

    <v-textarea v-model="note" label="Anything else for the next run (optional)" rows="1" auto-grow density="compact" variant="outlined" hide-details />
    <div class="owner__send">
      <v-text-field v-if="!proxyUser" v-model="actor" label="Your name" density="compact" variant="outlined" hide-details class="owner__actor" />
      <template v-if="split">
        <v-btn size="small" variant="flat" color="primary" :loading="sending" :disabled="!(proxyUser || actor.trim())" @click="send('accept')">Create these issues</v-btn>
        <v-btn size="small" variant="tonal" :loading="sending" :disabled="!(proxyUser || actor.trim())" @click="send('decline')">Run it as one anyway</v-btn>
      </template>
      <v-btn v-else size="small" variant="flat" color="primary" :loading="sending" :disabled="!complete" @click="send()">Answer and start</v-btn>
    </div>
    <p v-if="error" class="owner__error" role="alert">{{ error }}</p>
    <p v-if="startError" class="owner__error" role="status">{{ startError }}</p>
  </section>
</template>

<style scoped>
.owner { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.owner__q { display: flex; flex-direction: column; gap: 4px; }
.owner__rec { font-size: 0.875rem; opacity: 0.8; }
.owner__options { display: flex; flex-wrap: wrap; gap: 4px; }
.owner__parts { padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.owner__send { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.owner__actor { max-width: 220px; min-width: 160px; }
.owner__error { color: rgb(var(--v-theme-error)); font-size: 0.875rem; }
</style>
