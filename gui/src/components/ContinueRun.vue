<script setup>
import { computed, ref } from 'vue'
import { api } from '@/api'
import { actorName, proxyUser, rememberedActor } from '@/identity'
import { wallClockAt, wallClockPrefill } from '@/wall-clock'

/*
 * Continue a run that stopped at closure (POST …/runs/:runId/continue,
 * engine.continueRun): the review loop that produced the candidate gets
 * another round, in the same worktree and sessions. The server adds the
 * closure record and the issue notes written since the run began, so the
 * instruction only needs what those do not say.
 */
const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  run: { type: Object, required: true }
})
const emit = defineEmits(['continued'])

const open = ref(false)
const instruction = ref('')
const actor = ref(rememberedActor())
const wallClockMinutes = ref(0)
const acceptShort = ref(false)
const clock = computed(() => wallClockAt(props.run.wallClock, wallClockMinutes.value))
const busy = ref(false)
const error = ref('')

function show () {
  instruction.value = ''
  wallClockMinutes.value = wallClockPrefill(props.run.wallClock) || (props.run.budgets?.limits?.wallClockMinutes ?? 0)
  acceptShort.value = false
  error.value = ''
  open.value = true
}

async function submit () {
  const name = actorName(actor.value)
  if (!name) { error.value = 'Your name is required.'; return }
  busy.value = true
  error.value = ''
  try {
    const limit = props.run.budgets?.limits?.wallClockMinutes
    const budgets = wallClockMinutes.value && wallClockMinutes.value !== limit ? { wallClockMinutes: wallClockMinutes.value } : {}
    await api.continueRun(props.project, props.issueId, props.run.runId, { instruction: instruction.value, actor: name, budgets, acceptShortWallClock: clock.value?.short === true && acceptShort.value })
    open.value = false
    emit('continued')
  } catch (e) { error.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <v-btn size="small" variant="flat" color="primary" prepend-icon="$play" @click="show">Continue playbook</v-btn>
  <v-dialog v-model="open" max-width="620">
    <v-card title="Continue this run">
      <v-card-text>
        <p class="mb-4">
          The author gets another round on the saved candidate, in the same worktree and sessions, then the reviews, checks and closure run again.
          Why the run stopped and the issue notes added since it began are passed along automatically.
        </p>
        <v-textarea v-model="instruction" label="Instruction for the coordinator (optional)" rows="4" auto-grow variant="outlined" density="compact"
                    placeholder="What to fix, or what the notes do not say" />
        <v-text-field v-if="run.budgets?.limits?.wallClockMinutes" v-model.number="wallClockMinutes" type="number" :min="run.budgets.limits.wallClockMinutes"
                      label="Total active time limit (minutes)" density="compact" variant="outlined" />
        <p v-if="clock" class="mb-2">{{ clock.text }}</p>
        <v-alert v-if="clock?.exhausted" type="warning" variant="tonal" class="mb-2">No time is left under this limit: raise it to continue.</v-alert>
        <v-checkbox v-if="clock?.short" v-model="acceptShort" density="compact" hide-details label="Less than a mean round is left: continue anyway. A turn may be cut at the deadline." />
        <v-text-field v-if="!proxyUser" v-model="actor" label="Your name" density="compact" variant="outlined" />
        <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn :disabled="busy" @click="open = false">Cancel</v-btn>
        <v-btn color="primary" :loading="busy" @click="submit">Continue</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
