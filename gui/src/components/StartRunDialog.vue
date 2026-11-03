<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'

import DialogHeader from './DialogHeader.vue'
import { api } from '@/api'

/*
 * Two steps: pick a playbook with one click, then settle the settings for this
 * run, read what it would do, and start it.
 *
 * The preview invokes nothing — it is the same offline resolution the CLI
 * performs. Starting is the first thing here that costs anything, and says so.
 */

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  /** Ended runs of the issue: what "Accumulate results" would carry. */
  priorRuns: { type: Number, default: 0 }
})
const emit = defineEmits(['update:modelValue', 'started'])

const playbooks = ref([])
const chosen = ref(null)
/** 'pick' lists the playbooks; 'settings' is the chosen one's run page. */
const step = ref('pick')
const previewData = ref(null)
/** The playbook the shown preview actually describes. */
const previewedId = ref(null)
const previewedOptions = ref(null)
const runOptions = ref({})
const parameterData = ref(null)
const optionsKey = computed(() => JSON.stringify(runOptions.value))
const loading = ref(false)
const previewing = ref(false)
const starting = ref(false)
const error = ref('')
/** A Triage start the pre-gate held: its proposals, and the operator's reason if they start anyway. */
const hold = ref(null)
const overrideReason = ref('')

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const selected = computed(() => playbooks.value.find((p) => p.id === chosen.value) ?? null)

/**
 * The preview on screen has to be the preview of the thing about to start.
 *
 * Two ways it can drift: a slow response for an earlier selection landing after
 * a later one, and a failed or in-flight preview leaving the last good one on
 * screen. Both would put a person's finger on a button whose consequences the
 * page is describing incorrectly, so Start waits for a preview that matches.
 */
const previewMatches = computed(() =>
  Boolean(previewData.value?.ok) && previewedId.value === chosen.value && previewedOptions.value === optionsKey.value)

const startable = computed(() =>
  Boolean(selected.value?.ok) && previewMatches.value && previewData.value.configurationReady === true && !previewing.value && !starting.value)

const blockers = computed(() => (previewData.value?.prerequisites ?? []).filter((p) => p.category === 'blocking'))
// Catalogue resolution has no project or run settings. Only the matching
// project preview can say whether this particular run needs attention.
const awaitingStagedRelease = computed(() => previewMatches.value &&
  previewData.value.parameterDefinitions?.release?.tactic === 'deployment' &&
  !runOptions.value.releaseId && blockers.value.length === 1 &&
  blockers.value[0].kind === 'release-configuration')
const outcomes = computed(() => (previewData.value?.prerequisites ?? []).filter((p) => p.category === 'outcome'))
const notices = computed(() => (previewData.value?.prerequisites ?? []).filter((p) => p.category === 'information' && !(p.kind === 'path-overlap' && p.status === 'warning')))
const overlapWarning = computed(() => (previewData.value?.prerequisites ?? []).find((p) => p.kind === 'path-overlap' && p.status === 'warning') ?? null)

/* Only the newest preview request may write to the page. An older response is
   an answer to a question nobody is asking any more. */
let previewSeq = 0

async function loadPreview (id, reset = true) {
  const seq = ++previewSeq
  if (reset) { runOptions.value = {}; parameterData.value = null }
  const options = JSON.parse(optionsKey.value)
  const key = optionsKey.value
  error.value = ''
  previewData.value = null
  previewedId.value = null
  if (!id) return
  previewing.value = true
  try {
    const result = await api.previewPlaybook(id, { project: props.project, issue: props.issueId, runOptions: options })
    if (seq !== previewSeq) return          // superseded while in flight
    previewData.value = result
    previewedId.value = id
    previewedOptions.value = key
    if (!parameterData.value) parameterData.value = result
  } catch (e) {
    if (seq !== previewSeq) return
    error.value = e.message
  } finally {
    if (seq === previewSeq) previewing.value = false
  }
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    // Nothing in flight may land on the next opening.
    previewSeq++
    return
  }
  // Every opening starts at the choice, with nothing previewed: the first step
  // is the operator's, not a default the page made for them.
  step.value = 'pick'
  chosen.value = null
  hold.value = null
  overrideReason.value = ''
  previewData.value = null
  previewedId.value = null
  runOptions.value = {}
  parameterData.value = null
  error.value = ''
  loading.value = true
  try {
    playbooks.value = await api.listPlaybooks()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
})

/** One click: the playbook is chosen and the dialog moves on to its settings. */
function pick (id) {
  if (starting.value) return
  chosen.value = id
  step.value = 'settings'
  loadPreview(id)
}

/** Back to the list. The choice stays marked; picking again previews afresh. */
function changePlaybook () {
  if (starting.value) return
  previewSeq++                 // an in-flight preview has nowhere to land
  previewing.value = false
  step.value = 'pick'
}

/*
 * Edited settings are previewed on their own, after a short pause in typing.
 * Start stays disabled until the preview on screen matches the settings, which
 * is still the rule; what changed is that nobody has to remember the button to
 * get there. The button remains for an explicit re-check.
 */
let previewTimer = null
// A hold answers one start of one playbook; choosing another clears it.
watch(chosen, () => { hold.value = null })

watch(optionsKey, () => {
  clearTimeout(previewTimer)
  if (!chosen.value || !parameterData.value) return
  previewTimer = setTimeout(() => {
    if (open.value && !previewMatches.value) loadPreview(chosen.value, false)
  }, 500)
})
onUnmounted(() => clearTimeout(previewTimer))

const budgetFields = [
  { key: 'maxSteps', label: 'Maximum turns' },
  { key: 'wallClockMinutes', label: 'Time limit (min)' },
  { key: 'maxTokens', label: 'Token limit' }
]
const seats = computed(() => (parameterData.value?.parameterDefinitions?.seats ?? parameterData.value?.participants ?? []).map(s => ({...s, ...parameterData.value?.participants?.find(p => p.role === s.role)})))
const models = computed(() => parameterData.value?.parameterDefinitions?.models ?? [])
/* The playbook's own default, as first previewed — parameterData is the
   untouched preview, so it reports the default even after an override. */
const playbookIntent = computed(() => parameterData.value?.intent ?? null)
const NONE = '__none__'
/* What the selector shows: '' when the option is omitted, NONE when it is
   explicitly null, else the chosen id. */
const intentChoice = computed(() => {
  if (!Object.hasOwn(runOptions.value, 'intent')) return ''
  return runOptions.value.intent === null ? NONE : runOptions.value.intent
})
function setIntent (value) {
  const next = { ...runOptions.value }
  if (value === '') delete next.intent            // omitted: the playbook default applies
  else next.intent = value === NONE ? null : value  // null: no overlay; id: that overlay
  runOptions.value = next
}
const baseChoice = computed(() => {
  const b = runOptions.value.base
  if (b === undefined) return ''
  return typeof b === 'object' ? 'commit' : b
})
/* The box shows the mode that will actually run: the per-run choice when one
   was made, else the configured default. A choice equal to the default is
   omitted from the wire; one that differs is sent explicitly either way, so
   unchecking a playbook that defaults to in-place really does isolate. */
const configuredIsolation = computed(() => parameterData.value?.workspace?.isolation ?? 'git-worktree')
const inPlace = computed(() => (runOptions.value.isolation ?? configuredIsolation.value) === 'in-place')
function setIsolation (checked) {
  const next = { ...runOptions.value }
  const mode = checked ? 'in-place' : 'git-worktree'
  if (mode === configuredIsolation.value) delete next.isolation
  else next.isolation = mode
  runOptions.value = next
}
/* The escaping-symlink refusal names this choice; without a control here the
   only way to take its advice was a project file. Omitted: the configured policy. */
function setAccumulate (on) {
  const next = { ...runOptions.value }
  if (on) next.accumulate = true
  else delete next.accumulate
  runOptions.value = next
}
const limitsChanged = computed(() => Boolean(Object.keys(runOptions.value.budgets ?? {}).length || Object.keys(runOptions.value.rounds ?? {}).length || runOptions.value.repairAttempts != null))
const symlinksChoice = computed(() => runOptions.value.symlinks ?? '')
function setSymlinks (value) {
  const next = { ...runOptions.value }
  if (value === '') delete next.symlinks
  else next.symlinks = value
  runOptions.value = next
}
function setBase (value) {
  const next = { ...runOptions.value }
  if (value === '') delete next.base
  else next.base = value
  runOptions.value = next
}
const chosenIntent = computed(() => {
  const id = Object.hasOwn(runOptions.value, 'intent') ? runOptions.value.intent : playbookIntent.value?.id ?? null
  return id === null ? null : parameterData.value?.parameterDefinitions?.intents?.find((i) => i.id === id) ?? null
})
function argument (group, key, fallback) { return runOptions.value[group]?.[key] ?? fallback }
function setNumber (group, key, value) {
  const values = { ...runOptions.value[group] }
  if (value === '') delete values[key]
  else values[key] = Number(value)
  runOptions.value = { ...runOptions.value, [group]: values }
}
function chosenModel (participant) {
  const id = runOptions.value.participants?.[participant.role]?.model ?? participant.model
  return models.value.find((m) => m.id === id)
}
function participantEffort (participant) {
  const edited = runOptions.value.participants?.[participant.role]
  if (edited && Object.hasOwn(edited, 'effort')) return edited.effort ?? ''
  return participant.effort ?? ''
}
function setParticipant (role, values) {
  runOptions.value = { ...runOptions.value, participants: {
    ...runOptions.value.participants,
    [role]: { ...runOptions.value.participants?.[role], ...values }
  } }
}

async function start (override = false) {
  if (!startable.value) return
  if (override && !overrideReason.value.trim()) return
  starting.value = true
  error.value = ''
  try {
    // The hash binds the start to the configuration this page described. If the
    // playbook changed on disk in between, the server refuses rather than
    // running something the operator never saw.
    const run = await api.startRun(props.project, props.issueId, chosen.value, previewData.value.configHash, previewData.value.runOptions,
      override ? { override: true, reason: overrideReason.value.trim() } : null)
    hold.value = null
    overrideReason.value = ''
    open.value = false
    emit('started', run)
  } catch (e) {
    if (e.body?.code === 'PREGATE_HOLD') hold.value = { message: e.message, ...e.body.pregate }
    else error.value = e.message
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <v-dialog v-model="open" max-width="1880" :persistent="starting" scrollable>
    <v-card elevation="0">
      <DialogHeader title="Run a playbook" :busy="starting" @close="open = false" />
      <v-divider />

      <v-card-text class="body">
        <p class="stepline">
          <span class="stepline__n">Step {{ step === 'pick' ? 1 : 2 }} of 2</span>
          <span>{{ step === 'pick' ? 'Choose a playbook' : 'Settings for this run' }}</span>
        </p>

        <!-- Step 1: a list rather than a dropdown — each option carries a title,
             a strategy and a resolution state, and one click on it is the
             choice. -->
        <template v-if="step === 'pick'">
          <div v-if="loading" class="muted">Loading playbooks…</div>
          <div v-else class="picker" aria-label="Playbook">
            <button
              v-for="p in playbooks"
              :key="p.id"
              type="button"
              class="pick"
              :class="{ 'pick--on': chosen === p.id, 'pick--broken': !p.ok }"
              :aria-current="chosen === p.id ? 'true' : undefined"
              @click="pick(p.id)"
            >
              <span class="pick__body">
                <span class="pick__id">{{ p.id }}</span>
                <span class="pick__sub">{{ p.ok ? (p.title || p.strategy) : 'does not resolve' }}</span>
              </span>
              <v-icon icon="$chevronRight" size="16" class="pick__go" />
            </button>
            <p v-if="!playbooks.length" class="muted">No playbooks are configured.</p>
          </div>
        </template>

        <!-- Step 2: the chosen playbook, its settings, and the preview. -->
        <template v-else>
          <div class="chosen">
            <span class="chosen__body">
              <span class="chosen__id">{{ chosen }}</span>
              <span class="chosen__sub">{{ selected?.ok ? (selected.title || selected.strategy) : 'does not resolve' }}</span>
            </span>
            <v-chip v-if="previewMatches && blockers.length" size="x-small" variant="tonal"
                    :color="awaitingStagedRelease ? undefined : 'warning'">
              {{ awaitingStagedRelease ? 'select staged release' : 'cannot start' }}
            </v-chip>
            <v-btn size="small" variant="text" prepend-icon="$chevronLeft" :disabled="starting" @click="changePlaybook">Change playbook</v-btn>
          </div>

          <v-alert v-if="selected && !selected.ok" type="error" variant="tonal" density="compact" class="mt-4">
            This playbook does not resolve and cannot be started.
            <ul class="errs">
              <li v-for="(e, i) in selected.errors" :key="i"><code>{{ e.field || '/' }}</code> {{ e.message }}</li>
            </ul>
          </v-alert>

        <!-- Desktop: three columns — who does the work, how the run is bounded,
             and what that resolves to — so the whole step is in view at once.
             Narrow screens stack them. -->
        <div class="stage mt-3">
        <div v-if="parameterData?.parameterDefinitions" class="run-settings stage__settings">
          <fieldset :disabled="starting" class="settings-fields">
            <!-- Who does the work comes first: it is the choice most runs are
                 about. One block per seat, model and effort side by side. -->
            <h3 class="section">Models and effort</h3>
            <div class="seats">
              <div v-for="p in seats" :key="p.role" class="seat">
                <span class="seat__role">{{ p.role }}</span>
                <div class="seat__fields">
                  <label class="setting">
                    <span>Model</span>
                    <select :aria-label="`${p.role} model`" :value="runOptions.participants?.[p.role] === null ? '' : chosenModel(p)?.id ?? ''"
                      @change="$event.target.value ? setParticipant(p.role, { model: $event.target.value, effort: null }) : (runOptions = { ...runOptions, participants: { ...runOptions.participants, [p.role]: null } })">
                      <option v-if="p.optional" value="">Unoccupied (optional seat)</option>
                      <option v-for="m in models" :key="m.id" :value="m.id">{{ m.title || m.id }} · {{ m.harness }}{{ m.verification === 'verified' ? '' : ' · unverified' }}</option>
                    </select>
                  </label>
                  <label class="setting">
                    <span>Effort</span>
                    <select :aria-label="`${p.role} effort`" :value="participantEffort(p)"
                      :disabled="!chosenModel(p)?.efforts?.length"
                      @change="setParticipant(p.role, { effort: $event.target.value || null })">
                      <option value="">Model default</option>
                      <option v-for="effort in chosenModel(p)?.efforts ?? []" :key="effort" :value="effort">{{ effort }}</option>
                    </select>
                  </label>
                </div>
                <small v-if="chosenModel(p)?.efforts === null" class="seat__note">Effort levels have not been verified.</small>
                <small v-else-if="chosenModel(p) && !chosenModel(p).efforts?.length" class="seat__note">This model has no effort setting.</small>
              </div>
            </div>
            <div class="settings-actions">
              <v-btn size="small" variant="tonal" :disabled="previewing" @click="loadPreview(chosen, false)">Preview settings</v-btn>
              <v-btn size="small" variant="text" :disabled="previewing" @click="loadPreview(chosen)">Reset to defaults</v-btn>
              <span class="dim">Changes apply to this run only. Saved playbook defaults stay unchanged.</span>
            </div>
          </fieldset>
          <p v-if="!previewMatches && !previewing" class="muted">These settings are previewed before Start is enabled.</p>
        </div>

        <div v-if="parameterData?.parameterDefinitions" class="run-settings stage__limits">
          <label v-if="parameterData.parameterDefinitions.delivery?.length && !inPlace" class="setting setting--wide">
            <span>Delivery</span>
            <select aria-label="Delivery" :value="runOptions.delivery ?? parameterData.delivery.action" @change="runOptions = { ...runOptions, delivery: $event.target.value }">
              <option value="apply-to-source">Apply approved changes to project source</option>
              <option value="worktree-diff">Save patch for manual review and application</option>
            </select>
            <small>Applying updates the development checkout after review. A saved patch leaves source unchanged.</small>
          </label>
          <fieldset :disabled="starting" class="settings-fields">
            <h3 class="section">Work, base and limits</h3>
            <div class="settings-grid settings-grid--options">
              <label v-if="parameterData.parameterDefinitions.intents?.length" class="setting setting--wide">
                <span>Intent</span>
                <!-- Three distinct choices, kept distinct on the wire: omitted
                     (the playbook's default applies), null (no overlay at all),
                     or a specific id. -->
                <select aria-label="Intent" data-setting="intent" :value="intentChoice" @change="setIntent($event.target.value)">
                  <option value="">Playbook default{{ playbookIntent ? ` (${playbookIntent.id})` : ' (none)' }}</option>
                  <option value="__none__">No intent</option>
                  <option v-for="i in parameterData.parameterDefinitions.intents" :key="i.id" :value="i.id">{{ i.title }} · {{ i.id }}</option>
                </select>
                <small>{{ chosenIntent ? chosenIntent.description : (intentChoice === NONE ? 'No overlay: participants get the strategy prompts alone.' : 'What kind of work this is. Briefs every participant for it; the phase shape and review rules stay the playbook\'s.') }}</small>
              </label>
              <label v-if="parameterData.parameterDefinitions.release" class="setting"><span>Release environment</span>
                <select aria-label="Release environment" :value="runOptions.environment ?? (parameterData.parameterDefinitions.release.environments.length === 1 ? parameterData.parameterDefinitions.release.environments[0]?.id : '')" @change="runOptions = { ...runOptions, environment: $event.target.value }">
                  <option v-if="parameterData.parameterDefinitions.release.environments.length > 1" value="" disabled>Select deployment environment</option>
                  <option v-for="e in parameterData.parameterDefinitions.release.environments" :key="e.id" :value="e.id">{{ e.id }} · {{ e.description }}</option>
                </select>
              </label>
              <label v-if="parameterData.parameterDefinitions.release?.tactic === 'deployment'" class="setting"><span>Successfully staged release ID</span>
                <input aria-label="Successfully staged release ID" :value="runOptions.releaseId ?? ''" @input="runOptions = { ...runOptions, releaseId: $event.target.value }" />
                <small>Use the run ID from a completed staging playbook. Production promotes that exact archive.</small>
              </label>
              <label class="setting setting--wide">
                <span>Workspace</span>
                <span class="check-row">
                  <input type="checkbox" aria-label="Work directly in the project checkout" data-setting="isolation" :checked="inPlace" @change="setIsolation($event.target.checked)" />
                  Work directly in the project checkout
                </span>
                <small>{{ inPlace ? 'No isolated worktree and no patch: edits land in the live tree as they are made, and a failed turn can leave partial edits there. The base setting below does not apply. A project that declares tooling mounts is refused in place (nothing binds them there): run it isolated.' : 'An isolated git worktree cut from the base below. The result is a verified patch; the repository changes only when you integrate it.' }}{{ configuredIsolation === 'in-place' ? ' This playbook defaults to working in place.' : '' }}</small>
              </label>
              <label class="setting setting--wide" :class="{ 'setting--inactive': !priorRuns }">
                <span>Earlier runs</span>
                <span class="check-row">
                  <input type="checkbox" aria-label="Accumulate results from previous runs" data-setting="accumulate" :disabled="!priorRuns" :checked="runOptions.accumulate === true" @change="setAccumulate($event.target.checked)" />
                  Accumulate results from previous runs
                </span>
                <small>{{ !priorRuns ? 'This issue has no earlier run to build on.' : runOptions.accumulate ? `This run is given everything the ${priorRuns} earlier run(s) of this issue did: every turn in order, the result account and the patch. Use it to build on substantial earlier work, e.g. implement an analysis\'s findings.` : `This run sees only the report and the notes; the ${priorRuns} earlier run(s)\' turns and results are left out.` }}</small>
              </label>
              <label class="setting setting--wide" :class="{ 'setting--inactive': inPlace }">
                <span>Base</span>
                <!-- Omitted uses the resolved project/playbook policy. -->
                <select aria-label="Base" data-setting="base" :value="baseChoice" @change="setBase($event.target.value)">
                  <option value="">Configured default ({{ parameterData.workspace?.base && typeof parameterData.workspace.base === 'object' ? 'commit ' + parameterData.workspace.base.commit : parameterData.workspace?.base ?? 'head' }})</option>
                  <option value="head">HEAD — refuses a checkout with tracked modifications</option>
                  <option value="working-tree">Working tree — snapshot the checkout as it is</option>
                </select>
                <small>{{ baseChoice === 'working-tree' || (baseChoice === '' && parameterData.workspace?.base === 'working-tree') ? 'The candidate and its patch are relative to the checkout\'s current state, symlinks and uncommitted files included.' : 'The candidate is relative to the checked-out commit; a checkout that has moved away from it is refused at start.' }}</small>
              </label>
              <label class="setting setting--wide" :class="{ 'setting--inactive': inPlace }">
                <span>Symlinks leaving the checkout</span>
                <select aria-label="Symlinks" data-setting="symlinks" :value="symlinksChoice" @change="setSymlinks($event.target.value)">
                  <option value="">Configured default ({{ parameterData.workspace?.symlinks ?? 'reject' }})</option>
                  <option value="reject">Reject — refuse to start</option>
                  <option value="materialize">Materialize — copy their targets into the worktree</option>
                  <option value="allow">Allow — keep the links (writes through them reach live files)</option>
                </select>
              </label>
            </div>
            <!-- Per-run limits: the playbook's defaults suit most starts, so they
                 stay folded unless one has been changed. -->
            <details class="advanced" :open="limitsChanged">
            <summary class="advanced__summary">Limits: budgets, review rounds, repair attempts{{ limitsChanged ? ' (changed)' : '' }}</summary>
            <div class="settings-grid settings-grid--numbers">
              <label v-for="field in budgetFields" :key="field.key" class="setting">
                <span>{{ field.label }}</span>
                <input type="number" :aria-label="field.label" :data-setting="field.key" min="1" step="1"
                  :max="parameterData.parameterDefinitions.budgetCaps[field.key]"
                  :value="argument('budgets', field.key, parameterData.limits.budgets[field.key] ?? '')"
                  :placeholder="field.key === 'maxTokens' ? 'No token limit' : 'Playbook default'"
                  @input="setNumber('budgets', field.key, $event.target.value)" />
                <small v-if="field.key === 'maxTokens'">Checked between turns; a turn may exceed this limit.</small>
                <small v-if="parameterData.parameterDefinitions.budgetCaps[field.key]">Strategy maximum: {{ parameterData.parameterDefinitions.budgetCaps[field.key] }}</small>
              </label>
              <label v-for="round in parameterData.limits.rounds" :key="round.phase" class="setting">
                <span>{{ round.phase }} rounds</span>
                <input type="number" :aria-label="`${round.phase} rounds`" :data-setting="round.phase" min="1" step="1"
                  :value="argument('rounds', round.phase, round.maxRounds)"
                  @input="setNumber('rounds', round.phase, $event.target.value)" />
              </label>
              <label class="setting">
                <span>Protocol repair attempts</span>
                <input type="number" aria-label="Protocol repair attempts" data-setting="repairAttempts" min="0" step="1"
                  :max="parameterData.parameterDefinitions.repairCap"
                  :value="runOptions.repairAttempts ?? parameterData.reviewPolicy.protocolRepair.maxAttempts"
                  @input="runOptions = { ...runOptions, repairAttempts: $event.target.value === '' ? null : Number($event.target.value) }" />
                <small>Strategy maximum: {{ parameterData.parameterDefinitions.repairCap }}</small>
              </label>
            </div>
            </details>
          </fieldset>
        </div>

        <aside class="stage__preview">
        <div v-if="previewing" class="muted">Resolving…</div>

        <template v-else-if="previewMatches">
          <h3 class="section">Participants</h3>
          <div v-for="p in previewData.participants" :key="p.role" class="row">
            <span class="row__role">{{ p.role }}</span>
            <span>{{ p.model }}</span>
            <span class="dim">{{ p.wireModel }}</span>
            <span class="dim">via {{ p.connection.label }}</span>
            <span class="dim">{{ p.effort || 'no effort' }}</span>
            <v-chip size="x-small" variant="tonal" :color="p.verification === 'verified' ? 'success' : 'warning'">
              {{ p.verification }}
            </v-chip>
          </div>

          <h3 class="section">Limits</h3>
          <div class="row">
            <span v-for="(v, k) in previewData.limits.budgets" :key="k" class="dim">{{ k }}={{ v }}</span>
            <span v-for="r in previewData.limits.rounds" :key="r.phase" class="dim">{{ r.phase }}≤{{ r.maxRounds }}</span>
          </div>

          <h3 class="section">Completion policy</h3>
          <div class="row">
            <span class="dim">checks {{ previewData.checks.requirement }}</span>
            <span class="dim">target {{ previewData.checks.target ? previewData.checks.target.kind : 'none' }}</span>
            <span class="dim">delivery {{ previewData.delivery.action }}</span>
            <span class="dim">autoClose {{ previewData.autoClose.minimumVerification }}</span>
          </div>
          <p class="dim mt-1">requires {{ previewData.completion.requires.join(', ') }}</p>

          <v-alert v-if="blockers.length" :type="awaitingStagedRelease ? 'info' : 'error'" variant="tonal" density="compact" class="mt-4"
                   :title="awaitingStagedRelease ? 'Select a successfully staged release' : 'Cannot start'">
            <p v-for="pre in blockers" :key="pre.kind + pre.detail" class="readiness-note">{{ pre.detail }}</p>
            <p v-if="!awaitingStagedRelease && blockers.some(pre => pre.kind === 'release-configuration')" class="readiness-note">Release procedures belong in the project's infrastructure configuration. The runtime executes checkpoint, restore and health checks; the coordinator assesses the results. No manual playbook verification is required.</p>
          </v-alert>
          <v-alert v-if="outcomes.length" type="warning" variant="tonal" density="compact" class="mt-3" title="Will not close automatically">
            <p v-for="pre in outcomes" :key="pre.kind" class="readiness-note">{{ pre.detail }}</p>
          </v-alert>
          <!-- Informs, never disables Start: the operator decides. -->
          <v-alert v-if="overlapWarning" type="warning" variant="tonal" density="compact" class="mt-3" title="Another run touches these files">
            <p class="readiness-note">{{ overlapWarning.detail }}</p>
          </v-alert>
          <!-- Open by default: the third column is the place to read what the
               run will actually do, and the notices are part of that. -->
          <details v-if="notices.length" class="execution-details mt-4" open>
            <summary>Execution details</summary>
            <div v-for="pre in notices" :key="pre.kind" class="row">
              <v-icon :icon="pre.status === 'available' ? '$checkCircle' : '$clock'" size="14"
                      :color="pre.status === 'available' ? 'success' : undefined" />
              <span class="row__text">{{ pre.detail }}</span>
            </div>
          </details>
        </template>
        </aside>
        </div>
        </template>

        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mt-4">{{ error }}</v-alert>
        <v-alert v-if="hold" type="warning" variant="tonal" density="compact" class="mt-4" title="Held by the pre-gate">
          <p>{{ hold.message }}</p>
          <ul v-if="hold.proposals?.length" class="mt-2">
            <li v-for="p in hold.proposals" :key="p.id">{{ p.title }}</li>
          </ul>
          <p class="mt-2">Confirm a proposal in the issue's pre-gate panel, or start anyway and say why.</p>
          <div class="hold-override mt-2">
            <v-text-field v-model="overrideReason" density="compact" hide-details variant="outlined" maxlength="500"
              label="Reason for starting Triage anyway" />
            <v-btn color="warning" variant="flat" size="small" :loading="starting" :disabled="!overrideReason.trim() || !startable" @click="start(true)">
              Start anyway
            </v-btn>
          </div>
        </v-alert>
      </v-card-text>

      <v-divider />
      <v-card-actions class="actions">
        <span v-if="step === 'settings'" class="warn">
          <v-icon icon="$alertCircle" size="14" />
          Starting invokes real agents and spends money. The preview above invoked nothing.
        </span>
        <span v-else class="warn">Pick a playbook to see what it would do. Nothing starts yet.</span>
        <v-spacer />
        <v-btn variant="text" size="small" :disabled="starting" @click="open = false">Cancel</v-btn>
        <v-btn v-if="step === 'settings'" color="primary" variant="flat" size="small" :loading="starting" :disabled="!startable" @click="start()">
          Start run
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.hold-override { display: flex; gap: 8px; align-items: center; }
.setting--wide { grid-column: 1 / -1; }
.settings-fields { border: 0; min-width: 0; padding: 8px 0 0; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
.settings-grid--numbers { gap: 12px 10px; margin-top: 12px; }
.settings-grid--numbers .setting > span { overflow-wrap: break-word; }
/* Labels wrap to different line counts, which would stagger the inputs. Each
   field spans the same three tracks (label, input, note) so a row's inputs
   share a baseline whatever the labels do. */
@supports (grid-template-rows: subgrid) {
  .settings-grid--numbers { grid-auto-rows: auto; }
  .settings-grid--numbers .setting { display: grid; grid-row: span 3; grid-template-rows: subgrid; align-items: end; }
  .settings-grid--numbers .setting > input { align-self: start; }
  .settings-grid--numbers .setting > small { align-self: start; }
}
@supports not (grid-template-rows: subgrid) {
  .settings-grid--numbers .setting > span { min-height: 2.6em; display: flex; align-items: flex-end; }
}
.seats { display: grid; gap: 10px 16px; }
.seat { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.seat__role { font-size: 0.8125rem; font-weight: 550; }
.seat__fields { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 8px; }
.seat__note { opacity: 0.6; font-size: 0.6875rem; }
.stage { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 6fr) minmax(0, 7fr); gap: 0 24px; align-items: start; }
.stage__limits, .stage__preview { padding-left: 24px; border-left: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 12%, transparent); }
.stage__preview .section:first-child { margin-top: 0; }
.stage__preview .execution-details { margin-top: 8px; }
/* Inside a column: seats stack, intent and base stack, limits go three across. */
.seats { grid-template-columns: minmax(0, 1fr); }
.settings-grid--options { grid-template-columns: minmax(0, 1fr); }
.settings-grid--options .setting--wide { grid-column: auto; }
.settings-grid--numbers { grid-template-columns: repeat(3, minmax(0, 1fr)); }
/* On a mid-size desktop the limits column needs the room more than the seats. */
@media (max-width: 1500px) { .stage { grid-template-columns: minmax(0, 4fr) minmax(0, 7fr) minmax(0, 7fr); } }
@media (max-width: 1100px) {
  .stage { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .stage__preview { grid-column: 1 / -1; padding-left: 0; border-left: 0; margin-top: 16px; }
}
@media (max-width: 720px) {
  .stage { grid-template-columns: minmax(0, 1fr); }
  .stage__limits { padding-left: 0; border-left: 0; margin-top: 16px; }
}
.setting { display: flex; flex-direction: column; gap: 4px; min-width: 0; font-size: 0.8125rem; }
.setting input, .setting select { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid rgba(var(--v-theme-on-surface), 0.25); border-radius: 6px; color: rgb(var(--v-theme-on-surface)); background: rgb(var(--v-theme-surface)); }
.setting small { opacity: 0.6; font-size: 0.6875rem; }
.check-row { display: flex; align-items: center; gap: 8px; font-size: 0.95rem; }
.check-row input { width: 16px; height: 16px; margin: 0; }
/* A finger needs the box itself at 44px; flex: none keeps a long label from squeezing it. */
@media (pointer: coarse) { .check-row input { flex: none; width: 44px; height: 44px; } }
.setting--inactive { opacity: 0.55; }

.settings-actions { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin: 16px 0 0; }
.settings-actions .dim { flex-basis: 100%; }
@media (max-width: 480px) { .settings-grid { grid-template-columns: minmax(0, 1fr); } .settings-grid--numbers { grid-template-columns: repeat(2, minmax(0, 1fr)); } .seat__fields { grid-template-columns: minmax(0, 1fr); } }
.body { padding: 16px 20px; }
.stepline { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; font-size: 0.8125rem; }
.stepline__n { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.55; }
.picker { display: grid; gap: 4px; }
.chosen { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 12px; border: 1px solid rgb(var(--v-theme-primary)); border-radius: 9px; background: rgb(var(--v-theme-surface-variant)); }
.chosen__body { flex: 1; min-width: 0; }
.chosen__id { display: block; font-size: 0.875rem; font-weight: 550; }
.chosen__sub { display: block; font-size: 0.75rem; opacity: 0.58; }

.pick {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 14%, transparent);
  border-radius: 9px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.pick:hover { background: rgb(var(--v-theme-surface-variant)); }
.pick--on { border-color: rgb(var(--v-theme-primary)); background: rgb(var(--v-theme-surface-variant)); }
.pick--broken { opacity: 0.72; }
.pick__go { opacity: 0.5; flex: none; }
.pick:hover .pick__go { opacity: 1; }
.pick__body { flex: 1; min-width: 0; }
.pick__id { display: block; font-size: 0.875rem; font-weight: 550; }
.pick__sub { display: block; font-size: 0.75rem; opacity: 0.58; }

.section { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.55; margin: 10px 0 4px; }
.settings-fields > .section:first-child { margin-top: 0; }
.row { display: flex; align-items: baseline; gap: 6px 8px; flex-wrap: wrap; font-size: 0.8125rem; padding: 2px 0; }
.execution-details .row { font-size: 0.75rem; }
.row__role { min-width: 5.5rem; font-weight: 550; }
.row__text { flex: 1; min-width: 12rem; }
.dim { opacity: 0.6; font-size: 0.75rem; }
.muted { font-size: 0.8125rem; opacity: 0.6; }
.readiness-note { font-size: 0.8125rem; line-height: 1.5; margin: 4px 0; }
.execution-details { font-size: 0.8125rem; }
.execution-details summary { cursor: pointer; padding: 4px 0; }
.errs { margin: 6px 0 0 1rem; font-size: 0.75rem; }
.actions { padding: 12px 16px; gap: 8px; }
.warn { display: flex; align-items: center; gap: 6px; font-size: 0.75rem; opacity: 0.7; max-width: 26rem; }
.advanced { margin-top: 10px; }
.advanced__summary { cursor: pointer; font-size: 0.8125rem; opacity: 0.8; padding: 4px 0; }
</style>
