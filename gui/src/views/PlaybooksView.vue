<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '@/api'
import { actorName, proxyUser, rememberedActor } from '@/identity'

/*
 * Playbooks: the seats every playbook starts a run with, editable. A seat is a role of the playbook's strategy
 * bound to a roster model at an effort; the start dialog can still seat a run differently.
 * Mechanism: the server validates an edit with the resolver a run start uses and writes it as the installation's
 * own copy of the playbook (server/playbook-seats.mjs); this view only edits a draft and sends the seats that differ.
 * Decision: one Save per playbook, not per field: seats are judged together (one writer, every required role bound),
 * and each save starts a new configuration group in the run statistics.
 */
const report = ref(null)
const error = ref('')
const refusal = ref(null)
const notice = ref('')
const busy = ref('')
const actor = ref(rememberedActor())
const draft = ref({})

const models = computed(() => report.value?.models ?? [])
const model = (id) => models.value.find((m) => m.id === id) ?? null
const fresh = (playbooks) => Object.fromEntries(playbooks.map((p) => [p.id, Object.fromEntries(p.seats.map((s) => [s.role, { model: s.model, effort: s.effort }]))]))

function take (data) {
  report.value = data
  draft.value = fresh(data.playbooks)
}
async function load () {
  try { take(await api.playbookSeats()); error.value = '' } catch (err) { error.value = err.message }
}

const changedSeat = (playbook, seat) => {
  const d = draft.value[playbook.id]?.[seat.role]
  return Boolean(d) && (d.model !== seat.model || (d.effort ?? null) !== (seat.effort ?? null))
}
const dirty = (playbook) => playbook.seats.some((seat) => changedSeat(playbook, seat))

// What a seat can take: verified models, and whatever it holds now, so a seat on an entry that lost its
// verification still shows what it is.
function modelItems (seat) {
  const items = models.value.map((m) => ({
    value: m.id,
    title: `${m.title}${m.verified ? '' : ' (unverified)'}${m.heldUntil ? ` · on hold until ${m.heldUntil}` : ''}`,
    props: { subtitle: m.harness, disabled: !m.verified && m.id !== seat.model }
  }))
  return seat.optional ? [{ value: null, title: 'Empty seat' }, ...items] : items
}
function effortItems (id) {
  const m = model(id)
  if (!m || !m.efforts.length) return [{ value: null, title: m ? 'none (the model takes no effort)' : '—' }]
  return [{ value: null, title: m.defaultEffort ? `model default (${m.defaultEffort})` : 'model default' }, ...m.efforts.map((e) => ({ value: e, title: e }))]
}
// A model change keeps the effort when the new model takes it; otherwise the nearest sensible one, never an invalid pair.
function modelChanged (playbook, seat) {
  const d = draft.value[playbook.id][seat.role]
  const m = model(d.model)
  if (!m || !m.efforts.length) d.effort = null
  else if (!m.efforts.includes(d.effort)) d.effort = m.defaultEffort ?? (m.efforts.includes('medium') ? 'medium' : m.efforts[0])
}

function reset (playbook) {
  draft.value[playbook.id] = fresh([playbook])[playbook.id]
  refusal.value = null
}

const said = (seat) => seat ? `${seat.model}${seat.effort ? ` at ${seat.effort}` : ''}` : 'empty'
async function save (playbook) {
  if (!actorName(actor.value)) { error.value = 'Your name is required: the change is recorded with it.'; return }
  const seats = {}
  for (const seat of playbook.seats) {
    if (!changedSeat(playbook, seat)) continue
    const d = draft.value[playbook.id][seat.role]
    seats[seat.role] = d.model ? { model: d.model, ...(d.effort ? { effort: d.effort } : {}) } : null
  }
  busy.value = playbook.id
  refusal.value = null
  notice.value = ''
  try {
    const result = await api.savePlaybookSeats(playbook.id, seats, actorName(actor.value))
    take(result)
    error.value = ''
    notice.value = `${playbook.title}: ${(result.changes ?? []).map((c) => `${c.role} ${said(c.from)} → ${said(c.to)}`).join('; ')}. ` +
      (result.removed ? 'These are the tracked defaults again, so the host copy was removed.' : `Saved to ${result.written}. ${playbook.kind === 'consultation' ? 'Questions put to the panel from now on get these seats.' : 'Runs started from now on get these seats.'}`)
  } catch (err) {
    refusal.value = { id: playbook.id, message: err.message, detail: err.body?.detail ?? [] }
  } finally { busy.value = '' }
}

onMounted(load)
</script>

<template>
  <v-container fluid class="playbooks">
    <header class="playbooks__head">
      <div>
        <h1 class="playbooks__title">Playbooks</h1>
        <p class="playbooks__subtitle">The seats each playbook starts a run with: the model and effort of every role.</p>
      </div>
      <v-btn icon="$refresh" variant="text" density="comfortable" aria-label="Read the playbooks again" @click="load" />
    </header>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="notice" type="success" variant="tonal" density="compact" class="mb-4" closable @click:close="notice = ''">{{ notice }}</v-alert>
    <v-alert v-if="report?.errors?.length" type="warning" variant="tonal" density="compact" class="mb-4">
      The configuration has {{ report.errors.length }} problem{{ report.errors.length === 1 ? '' : 's' }}: {{ report.errors.slice(0, 3).join(' · ') }}
    </v-alert>

    <p class="playbooks__note">
      A change applies to runs started afterwards; a run in flight keeps the seats it was started with, and the start dialog can
      still seat a single run differently. Saving writes this installation's own copy of the playbook and leaves the tracked
      catalogue as it is. Each change starts a new configuration group in the run statistics.
    </p>
    <v-text-field v-if="!proxyUser" v-model="actor" label="Your name (recorded with a change)" density="compact" variant="outlined" class="playbooks__actor" hide-details />

    <v-card v-for="p in report?.playbooks ?? []" :key="p.id" variant="outlined" class="playbooks__card">
      <div class="playbooks__card-head">
        <div>
          <h2 class="playbooks__name">{{ p.title }} <span class="playbooks__muted">{{ p.id }}</span></h2>
          <p v-if="p.description" class="playbooks__muted">{{ p.description }}</p>
        </div>
        <div class="playbooks__chips">
          <v-chip v-if="p.deprecated" size="x-small" variant="tonal" color="warning">deprecated</v-chip>
          <v-chip size="x-small" variant="tonal" :color="p.source === 'host' ? 'primary' : undefined" :title="p.source === 'host' ? 'This installation\'s own copy shadows the tracked playbook' : 'The tracked catalogue entry'">
            {{ p.source === 'host' ? 'host copy' : 'tracked default' }}
          </v-chip>
          <v-chip v-if="p.drift" size="x-small" variant="tonal" color="warning" title="The host copy differs from the tracked playbook outside its seats: the tracked file changed since, or the copy was edited by hand">differs from tracked</v-chip>
          <v-chip v-if="!p.resolves" size="x-small" variant="tonal" color="error">does not resolve</v-chip>
        </div>
      </div>
      <v-alert v-if="p.errors.length" :type="p.resolves ? 'info' : 'error'" variant="tonal" density="compact" class="mx-4 mb-2">
        {{ p.kind === 'consultation' ? (p.resolves ? 'The panel' : 'As it stands the panel cannot be asked') : p.resolves ? 'As it stands a run of this playbook needs more than its seats' : 'This playbook does not resolve' }}: {{ p.errors.join(' · ') }}
      </v-alert>
      <v-alert v-if="refusal?.id === p.id" type="error" variant="tonal" density="compact" class="mx-4 mb-2">
        Not saved: {{ refusal.message }}<span v-if="refusal.detail.length">: {{ refusal.detail.join(' · ') }}</span>
      </v-alert>

      <v-table density="comfortable" class="playbooks__table">
        <thead>
          <tr><th>Seat</th><th>Model</th><th>Effort</th></tr>
        </thead>
        <tbody>
          <tr v-for="seat in p.seats" :key="seat.role" :class="{ 'playbooks__row--changed': changedSeat(p, seat) }">
            <td class="playbooks__seat">
              <div class="playbooks__role">
                {{ seat.role }}
                <v-chip v-if="seat.writesCode" size="x-small" variant="tonal" color="primary">writes code</v-chip>
                <v-chip v-if="seat.optional" size="x-small" variant="tonal">optional</v-chip>
              </div>
              <div class="playbooks__muted">{{ seat.description }}</div>
            </td>
            <td class="playbooks__field">
              <v-select v-model="draft[p.id][seat.role].model" :items="modelItems(seat)" :aria-label="`Model of ${seat.role} in ${p.title}`" density="compact" variant="outlined" hide-details @update:model-value="modelChanged(p, seat)" />
            </td>
            <td class="playbooks__field playbooks__field--effort">
              <v-select v-model="draft[p.id][seat.role].effort" :items="effortItems(draft[p.id][seat.role].model)" :aria-label="`Effort of ${seat.role} in ${p.title}`" :disabled="!model(draft[p.id][seat.role].model)?.efforts.length" density="compact" variant="outlined" hide-details />
            </td>
          </tr>
        </tbody>
      </v-table>

      <div class="playbooks__actions">
        <span class="playbooks__muted playbooks__hash" :title="p.configHash ?? ''">configuration {{ p.configHash ? p.configHash.replace('sha256:', '').slice(0, 12) : 'unresolved' }}</span>
        <v-btn size="small" variant="text" :disabled="!dirty(p) || busy === p.id" @click="reset(p)">Discard changes</v-btn>
        <v-btn size="small" color="primary" variant="flat" :disabled="!dirty(p)" :loading="busy === p.id" @click="save(p)">Save seats</v-btn>
      </div>
    </v-card>
    <p v-if="report && !report.playbooks.length" class="playbooks__muted">No playbooks in the catalogue.</p>
  </v-container>
</template>

<style scoped>
.playbooks { max-width: 1100px; padding: 28px 24px 40px; }
.playbooks__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.playbooks__title { font-size: 1.5rem; font-weight: 650; letter-spacing: -0.02em; line-height: 1.2; }
.playbooks__subtitle { margin-top: 5px; font-size: 0.875rem; color: rgb(var(--v-theme-on-surface)); opacity: 0.62; }
.playbooks__note { font-size: 0.875rem; opacity: 0.8; margin-bottom: 16px; max-width: 80ch; }
.playbooks__actor { max-width: 360px; margin-bottom: 16px; }
.playbooks__card { margin-bottom: 20px; }
.playbooks__card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 16px 8px; }
.playbooks__name { font-size: 1.125rem; font-weight: 600; }
.playbooks__chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.playbooks__muted { font-size: 0.8rem; font-weight: 400; opacity: 0.65; }
.playbooks__table { overflow-x: auto; }
.playbooks__seat { min-width: 220px; max-width: 46ch; padding-top: 8px !important; padding-bottom: 8px !important; }
.playbooks__role { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.playbooks__field { min-width: 260px; }
.playbooks__field--effort { min-width: 200px; width: 240px; }
.playbooks__row--changed td { background: rgba(var(--v-theme-primary), 0.07); }
.playbooks__actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 16px 14px; }
.playbooks__hash { margin-right: auto; font-variant-numeric: tabular-nums; }
@media (max-width: 700px) {
  .playbooks { padding: 16px; }
  .playbooks__card-head { flex-direction: column; }
}
</style>
