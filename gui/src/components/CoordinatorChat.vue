<script setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'

import { api } from '@/api'
import { childReporter, createSeq } from '@/freshness'
import { actorName, proxyUser, rememberedActor } from '@/identity'
import { formatHms, formatStep } from '@/format'
import { socket } from '@/socket'
import LiveOutput from './LiveOutput.vue'
import MarkdownText from './MarkdownText.vue'

/*
 * The operator's conversation with a run's coordinator
 * (server/runtime/coordinator-chat.mjs), beside what the coordinator did.
 *
 * Three things on one line of time: the coordinator's own turns (with their
 * reasoning as the runtime streamed it), questions and their answers, and
 * instructions with whether a turn has carried them yet.
 *
 * A question is answered by a COPY of the coordinator's session; it changes
 * nothing about the run. An instruction is given to every seat (coordinator,
 * author, each auditor) in its next turn, and each turn that carries it records
 * it. The two buttons say which is which, because
 * the difference is authority, not wording.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  run: { type: Object, required: true }
})
const emit = defineEmits(['open-turn'])

const chat = ref(null)
const error = ref('')
const text = ref('')
const sending = ref(false)
const actor = ref(rememberedActor())
const askInvocation = ref(null)
const openReasoning = ref(new Set())

/* On the issue page: only the newest read for the run still shown applies, and it reports into the page indicator. */
const freshness = inject('issueFreshness', null)
const seq = createSeq()
const reporter = childReporter(freshness?.registry, 'Coordinator chat')
function apply (next) {
  chat.value = next
  // A question still being answered names its fork's invocation (after a reload too).
  const asking = next?.entries?.find((e) => e.kind === 'question' && e.state === 'asking' && e.invocationId)
  if (asking && !askInvocation.value) askInvocation.value = asking.invocationId
  error.value = ''
}
async function load () {
  const runId = props.run.runId
  const ticket = seq.next(runId)
  const settle = reporter.start()
  try {
    const next = await api.coordinatorChat(props.project, props.issueId, runId)
    if (!seq.isLatest(ticket, props.run.runId)) return
    apply(next)
    settle('ok')
  } catch (e) {
    if (!seq.isLatest(ticket, props.run.runId)) return
    error.value = e.message
    settle('failed', e)
  }
}
/** The chat read again before sending, under the same sequence; it shows what it read. */
async function reread () {
  const runId = props.run.runId
  // It supersedes any display read in flight, so it settles the panel's state itself (ownRead with the reporter).
  const read = await freshness.ownRead(seq, runId, () => api.coordinatorChat(props.project, props.issueId, runId), reporter)
  if (read.latest() && runId === props.run.runId) apply(read.value)
  return read
}

/* Output chunks reach only subscribed viewers, so the fork's invocation comes with the question itself. */
function onRunEvent (event) {
  if (event?.runId !== props.run.runId || event.type !== 'chat') return
  if (event.entry?.kind === 'answer') askInvocation.value = null
  else if (event.entry?.kind === 'question' && event.entry.state === 'asking' && event.entry.invocationId) askInvocation.value = event.entry.invocationId
  load()
}

onMounted(() => { load(); socket.on('run:event', onRunEvent) })
onUnmounted(() => { socket.off('run:event', onRunEvent); reporter.dispose() })
// A chat-only change missed while away is read again after the page synchronizes, and on Retry.
watch(() => [freshness?.synced.value, freshness?.retry.value], () => { if (freshness) load() })
watch(() => props.run.runId, () => { chat.value = null; askInvocation.value = null; load() })
// A turn that carried an instruction changes its delivery state.
watch(() => props.run.timeline?.length, () => load())

const role = computed(() => chat.value?.role ?? 'coordinator')
const asking = computed(() => (chat.value?.asking?.length ?? 0) > 0)

const clip = (s, n = 700) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? '')
function summary (turn) {
  const v = turn.output?.value
  if (!v) return turn.output?.error ? `Output problem: ${turn.output.error}` : ''
  if (v.targetRole && v.prompt) return `→ ${v.targetRole}: ${v.prompt}`
  return v.reasoning ?? v.summary ?? v.rationale ?? v.decision ?? ''
}

/** Everything, in the order it happened. A question and its answer are one item. */
const items = computed(() => {
  const out = []
  for (const t of props.run.timeline ?? []) {
    if (t.role === role.value) out.push({ key: `turn-${t.number}`, kind: 'turn', at: t.timing?.startedAt ?? '', turn: t })
  }
  for (const a of props.run.active ?? []) {
    if (a.role === role.value) out.push({ key: `live-${a.invocationId}`, kind: 'live', at: a.startedAt ?? '', active: a })
  }
  const entries = chat.value?.entries ?? []
  const answers = new Map(entries.filter((e) => e.kind === 'answer').map((e) => [e.replyTo, e]))
  for (const e of entries) {
    if (e.kind === 'question') out.push({ key: e.id, kind: 'question', at: e.at, entry: e, answer: answers.get(e.id) ?? null })
    if (e.kind === 'instruction') out.push({ key: e.id, kind: 'instruction', at: e.at, entry: e })
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
})

function toggleReasoning (invocationId) {
  const next = new Set(openReasoning.value)
  if (next.has(invocationId)) next.delete(invocationId); else next.add(invocationId)
  openReasoning.value = next
}

async function send (kind) {
  if (!text.value.trim()) { error.value = 'Write a message first.'; return }
  if (!actorName(actor.value)) { error.value = 'Your name is required.'; return }
  sending.value = true
  const runId = props.run.runId
  const body = { kind, text: text.value, actor: actorName(actor.value) }
  const send = (t) => api.sendCoordinatorChat(t.project, t.issueId, t.runId, body)
  try {
    if (freshness) {
      // Ask needs a session and no question outstanding; Instruct needs the run to take instructions.
      const offered = (fresh) => kind === 'question' ? Boolean(fresh?.canAsk) && !(fresh?.asking?.length > 0) : !fresh?.instructionRefusal
      const r = await freshness.guard({ label: kind === 'question' ? 'Ask' : 'Instruct', runId, source: reread, offered }, send)
      if (!r.sent) { error.value = r.notice; return }
    } else await send({ project: props.project, issueId: props.issueId, runId })
    text.value = ''
    error.value = ''
    await load()
  } catch (e) { error.value = e.message } finally { sending.value = false }
}

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
const cost = (usd) => (typeof usd === 'number' ? ` · $${usd.toFixed(usd < 0.01 ? 4 : 2)}` : '')
</script>

<template>
  <section class="cchat" aria-label="Coordinator chat">
    <header class="cchat__head">
      <strong>Coordinator</strong>
      <span class="muted">{{ chat?.model ?? '' }}</span>
    </header>

    <div class="cchat__log">
      <p v-if="!items.length" class="muted">The coordinator has not taken a turn yet.</p>

      <article v-for="item in items" :key="item.key" :class="['cchat__item', `cchat__item--${item.kind}`]">
        <!-- The coordinator's own turn. -->
        <template v-if="item.kind === 'turn'">
          <div class="cchat__meta">
            <span>{{ time(item.at) }} · step {{ item.turn.number }} · {{ formatStep(item.turn.stepId, item.turn.role) }}</span>
            <span v-if="item.turn.timing?.durationMs != null"> · {{ formatHms(item.turn.timing.durationMs) }}</span>
            <span v-if="item.turn.instructions?.length" class="cchat__carried"> · carried {{ item.turn.instructions.length }} instruction{{ item.turn.instructions.length === 1 ? '' : 's' }}</span>
          </div>
          <p class="cchat__text">{{ clip(summary(item.turn)) }}</p>
          <div class="cchat__actions">
            <v-btn size="x-small" variant="text" @click="toggleReasoning(item.turn.invocationId)">
              {{ openReasoning.has(item.turn.invocationId) ? 'Hide reasoning' : 'Reasoning' }}
            </v-btn>
            <v-btn size="x-small" variant="text" @click="emit('open-turn', item.turn.number)">Open turn</v-btn>
          </div>
          <LiveOutput v-if="openReasoning.has(item.turn.invocationId)" :project="project" :issue-id="issueId"
                      :run-id="run.runId" :invocation-id="item.turn.invocationId" :role="item.turn.role" :step-id="item.turn.stepId" />
        </template>

        <!-- The coordinator is working now: its reasoning as it streams. -->
        <template v-else-if="item.kind === 'live'">
          <div class="cchat__meta"><v-progress-circular indeterminate size="12" width="2" color="primary" /> {{ time(item.at) }} · working on {{ formatStep(item.active.stepId, item.active.role) }}</div>
          <LiveOutput :project="project" :issue-id="issueId" :run-id="run.runId" :invocation-id="item.active.invocationId"
                      :role="item.active.role" :step-id="item.active.stepId" :live="true" />
        </template>

        <!-- A question, answered by a copy of the session. -->
        <template v-else-if="item.kind === 'question'">
          <div class="cchat__bubble cchat__bubble--mine">
            <div class="cchat__meta">{{ time(item.at) }} · {{ item.entry.actor }} asked</div>
            <p class="cchat__text">{{ item.entry.text }}</p>
          </div>
          <div v-if="item.answer?.status === 'answered'" class="cchat__bubble">
            <div class="cchat__meta">{{ time(item.answer.at) }} · answered from a copy of its session{{ item.answer.durationMs != null ? ` · ${formatHms(item.answer.durationMs)}` : '' }}{{ cost(item.answer.costUsd) }}</div>
            <MarkdownText :text="item.answer.text || '(empty answer)'" compact />
            <v-btn v-if="item.answer.invocationId" size="x-small" variant="text" @click="toggleReasoning(item.answer.invocationId)">
              {{ openReasoning.has(item.answer.invocationId) ? 'Hide reasoning' : 'Reasoning' }}
            </v-btn>
            <LiveOutput v-if="openReasoning.has(item.answer.invocationId)" :project="project" :issue-id="issueId"
                        :run-id="run.runId" :invocation-id="item.answer.invocationId" :role="role" step-id="ask" />
          </div>
          <div v-else-if="item.answer?.status === 'failed'" class="cchat__bubble cchat__bubble--error">
            <div class="cchat__meta">{{ time(item.answer.at) }} · no answer</div>
            <p class="cchat__text">{{ item.answer.error }}</p>
          </div>
          <div v-else-if="item.entry.state === 'asking'" class="cchat__bubble">
            <div class="cchat__meta"><v-progress-circular indeterminate size="12" width="2" color="primary" /> answering…</div>
            <LiveOutput v-if="askInvocation" :key="askInvocation" :project="project" :issue-id="issueId" :run-id="run.runId"
                        :invocation-id="askInvocation" :role="role" step-id="ask" :live="true" />
          </div>
          <div v-else class="cchat__bubble cchat__bubble--error"><div class="cchat__meta">No answer was recorded (interrupted).</div></div>
        </template>

        <!-- An instruction: steers the run at each seat's next turn. -->
        <div v-else-if="item.kind === 'instruction'" class="cchat__bubble cchat__bubble--mine cchat__bubble--instruction">
          <div class="cchat__meta">
            {{ time(item.at) }} · {{ item.entry.actor }} instructed ·
            <template v-if="item.entry.delivery === 'delivered'">
              delivered in step <a v-for="(c, i) in item.entry.carriedBy" :key="c.step" href="#" @click.prevent="emit('open-turn', c.step)">{{ i ? ', ' : '' }}{{ c.step }}{{ c.role ? ` · ${c.role}` : '' }}</a>
            </template>
            <template v-else>waiting for each seat's next turn</template>
          </div>
          <p class="cchat__text">{{ item.entry.text }}</p>
        </div>
      </article>
    </div>

    <footer class="cchat__compose">
      <v-textarea v-model="text" rows="2" auto-grow max-rows="8" density="compact" variant="outlined" hide-details
                  :label="`Message the ${role}`" @keydown.ctrl.enter="send('question')" />
      <div class="cchat__row">
        <v-text-field v-if="!proxyUser" v-model="actor" label="Your name" density="compact" variant="outlined" hide-details class="cchat__actor" />
        <v-btn size="small" variant="tonal" color="primary" :loading="sending && !asking" :disabled="!chat?.canAsk || asking"
               :title="chat?.canAsk ? 'Answered by a copy of the coordinator\'s session; the run is not affected' : 'The coordinator has no session yet'"
               @click="send('question')">Ask</v-btn>
        <v-btn size="small" variant="flat" color="primary" :loading="sending" :disabled="Boolean(chat?.instructionRefusal)"
               :title="chat?.instructionRefusal ?? 'Given to every seat in its next turn; it steers the run'"
               @click="send('instruction')">Instruct</v-btn>
      </div>
      <p class="cchat__hint muted">
        <strong>Ask</strong> is answered by a copy of the coordinator's session and changes nothing.
        <strong>Instruct</strong> is delivered in every seat's next turn and is recorded on each step that carried it.
      </p>
      <p v-if="chat?.instructionRefusal" class="cchat__hint muted">{{ chat.instructionRefusal }}</p>
      <p v-if="error" class="cchat__error" role="alert">{{ error }}</p>
    </footer>
  </section>
</template>

<style scoped>
.cchat { display: flex; flex-direction: column; gap: 8px; min-height: 0; height: 100%; }
.cchat__head { display: flex; gap: 8px; align-items: baseline; }
.cchat__log { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; overflow-wrap: anywhere; }
.cchat__item--turn, .cchat__item--live { border-left: 3px solid rgba(var(--v-theme-primary), 0.5); padding-left: 10px; }
.cchat__meta { font-size: 12px; opacity: 0.7; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.cchat__text { white-space: pre-wrap; margin: 4px 0 0; font-size: 14px; }
.cchat__actions { display: flex; gap: 4px; }
.cchat__carried { font-weight: 600; }
.cchat__bubble { padding: 8px 10px; border-radius: 8px; background: rgba(var(--v-theme-on-surface), 0.05); max-width: 92%; }
.cchat__bubble--mine { align-self: flex-end; background: rgba(var(--v-theme-primary), 0.10); }
.cchat__bubble--instruction { border: 1px solid rgba(var(--v-theme-primary), 0.5); }
.cchat__bubble--error { background: rgba(var(--v-theme-error), 0.10); }
.cchat__item--question { display: flex; flex-direction: column; gap: 6px; }
.cchat__compose { display: flex; flex-direction: column; gap: 6px; }
.cchat__row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cchat__actor { max-width: 220px; }
.cchat__hint { font-size: 12px; margin: 0; }
.cchat__error { color: rgb(var(--v-theme-error)); font-size: 13px; margin: 0; }
</style>
