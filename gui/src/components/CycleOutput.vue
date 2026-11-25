<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'

/*
 * The terminal of one entry of a full verification: the commands of its drive as chips, and what the chosen one
 * printed, followed while it runs (server/verification-output.mjs).
 * Mechanism: the page polls. The listing says which command is running; its text is read from a byte offset, so
 * each poll fetches only what was printed since the last one. While "follow" is on the view moves to the command
 * that is running, and the window scrolls with the output unless the reader scrolled up.
 * Decision: the text kept in the page is bounded (the tail): a whole-suite log is megabytes, and the file on the
 * host is the full record.
 */
// `cycleId`: the cycle whose drive is shown (a Full verification run's own); none, the latest cycle's.
const props = defineProps({ project: { type: String, required: true }, active: { type: Boolean, default: false }, cycleId: { type: String, default: null } })

const KEEP = 400000
const commands = ref([])
const chosen = ref(null)
const follow = ref(true)
const text = ref('')
const clipped = ref(false)
const error = ref('')
const pane = ref(null)
let next = 0
let timer = null
let busy = false

const current = computed(() => commands.value.find((c) => c.key === chosen.value) ?? null)
const running = computed(() => commands.value.find((c) => c.running) ?? null)

function choose (key, byHand = false) {
  if (byHand) follow.value = false
  if (key === chosen.value) return
  chosen.value = key
  text.value = ''
  clipped.value = false
  next = 0
}

async function poll () {
  if (busy) return
  busy = true
  try {
    const listing = await api.verificationOutput(props.project, null, 0, props.cycleId)
    commands.value = listing.commands
    if (follow.value || !chosen.value) choose((running.value ?? commands.value.at(-1))?.key ?? null)
    // Several readings in one poll while a long log is being caught up with, a bounded number of them.
    for (let reads = 0; chosen.value && reads < 8; reads++) {
      const { output } = await api.verificationOutput(props.project, chosen.value, next, props.cycleId)
      if (!output || output.key !== chosen.value) break
      if (output.restarted) text.value = ''
      const stick = !pane.value || pane.value.scrollHeight - pane.value.scrollTop - pane.value.clientHeight < 40
      text.value += output.text
      if (text.value.length > KEEP) { text.value = text.value.slice(-KEEP); clipped.value = true }
      next = output.next
      if (stick) await nextTick(() => { if (pane.value) pane.value.scrollTop = pane.value.scrollHeight })
      if (!output.truncated) break
    }
    error.value = ''
  } catch (err) { error.value = err.message } finally { busy = false }
}

function schedule () {
  clearInterval(timer)
  // A cycle that has ended is read once more and then left alone.
  timer = props.active ? setInterval(poll, 2500) : null
}
onMounted(() => { poll(); schedule() })
onUnmounted(() => clearInterval(timer))
watch(() => props.active, () => { poll(); schedule() })
watch(follow, (on) => { if (on) poll() })
</script>

<template>
  <div class="cycle-output" data-test="cycle-output">
    <div class="cycle-output__bar">
      <v-chip v-for="c in commands" :key="c.key" size="small" :variant="c.key === chosen ? 'flat' : 'tonal'" :color="c.running ? 'primary' : undefined"
              :title="`${c.key} · ${c.bytes} bytes · ${c.changedAt}`" @click="choose(c.key, true)">
        {{ c.rerun ? `${c.key.split('/')[0].replace('full-verification-', '')}: ` : '' }}{{ c.id }}<span v-if="c.running"> · running</span>
      </v-chip>
      <span v-if="!commands.length" class="cycle-output__muted">No command of this drive has printed anything yet.</span>
      <v-spacer />
      <v-switch v-model="follow" label="Follow" density="compact" hide-details color="primary" class="cycle-output__follow" />
    </div>
    <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="mb-2">{{ error }}</v-alert>
    <div v-if="clipped" class="cycle-output__muted">Showing the last {{ Math.round(KEEP / 1000) }} kB; the whole log is in the entry's directory on the host.</div>
    <pre v-if="chosen" ref="pane" class="cycle-output__pane" tabindex="0" :aria-label="`Output of ${current?.id ?? 'the command'} in the drive of ${project}`">{{ text || (current?.running ? 'Waiting for the first output…' : '') }}</pre>
  </div>
</template>

<style scoped>
.cycle-output__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 8px; }
.cycle-output__follow { flex: none; }
.cycle-output__muted { font-size: 0.8rem; opacity: 0.65; }
.cycle-output__pane {
  height: 420px;
  overflow: auto;
  margin: 0;
  padding: 10px 12px;
  border-radius: 6px;
  background: #101418;
  color: #d7dde4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
