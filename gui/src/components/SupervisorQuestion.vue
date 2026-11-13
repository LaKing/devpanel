<script setup>
import { ref } from 'vue'

import { api } from '@/api'
import { actorName, proxyUser, rememberedActor } from '@/identity'
import QuestionBrief from '@/components/QuestionBrief.vue'

/*
 * One question the top-level supervisor put to the operator (ask_operator).
 * The answer is recorded in the supervisor's state and reaches it as an
 * operator-answer event; a closed question takes exactly one of its options.
 */
const props = defineProps({ question: { type: Object, required: true }, compact: { type: Boolean, default: false } })
const emit = defineEmits(['answered'])
const text = ref('')
const actor = ref(rememberedActor())
const sending = ref(false)
const error = ref('')

async function send (choice = null) {
  const answer = (choice ?? text.value).trim()
  if (!answer || !actorName(actor.value)) { error.value = 'An answer and your name are both required.'; return }
  sending.value = true
  try {
    await api.answerSupervisorQuestion(props.question.id ?? props.question.questionId, answer, actorName(actor.value))
    text.value = ''; error.value = ''
    emit('answered')
  } catch (e) { error.value = e.message } finally { sending.value = false }
}
</script>

<template>
  <div class="squestion">
    <div class="squestion__head">
      <strong>The supervisor asks</strong>
      <RouterLink v-if="question.project && question.issueId" :to="`/projects/${question.project}/${question.issueId}`">{{ question.issueId }}</RouterLink>
      <span v-else-if="question.project" class="muted">{{ question.project }}</span>
      <time class="muted">{{ new Date(question.at ?? question.since).toLocaleString() }}</time>
    </div>
    <!-- The consult panel's wording for a person first; the supervisor's own stays below it. -->
    <QuestionBrief v-if="question.brief" :brief="question.brief" :consult="question.consult" @choose="question.options ? null : (text = $event)" />
    <p v-if="question.brief" class="muted squestion__own">In the supervisor's words:</p>
    <p class="squestion__text">{{ question.question ?? question.headline }}</p>
    <div class="squestion__row">
      <v-text-field v-if="!proxyUser" v-model="actor" label="Your name" density="compact" variant="outlined" hide-details class="squestion__actor" />
      <template v-if="question.options">
        <v-btn v-for="option in question.options" :key="option" size="small" variant="tonal" color="primary" :loading="sending" @click="send(option)">{{ option }}</v-btn>
      </template>
    </div>
    <div v-if="!question.options" class="squestion__row">
      <v-textarea v-model="text" label="Answer" rows="1" auto-grow density="compact" variant="outlined" hide-details />
      <v-btn size="small" variant="flat" color="primary" :loading="sending" @click="send()">Answer</v-btn>
    </div>
    <p v-if="error" class="squestion__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.squestion { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(var(--v-theme-primary), 0.5); background: rgba(var(--v-theme-primary), 0.06); }
.squestion__head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 13px; }
.squestion__own { margin: 0; font-size: 12px; }
.squestion__text { white-space: pre-wrap; margin: 0; overflow-wrap: anywhere; }
.squestion__row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.squestion__actor { max-width: 200px; }
.squestion__error { color: rgb(var(--v-theme-error)); font-size: 13px; margin: 0; }
</style>
