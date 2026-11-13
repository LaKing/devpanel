<script setup>
import { ref } from 'vue'

/*
 * A question as the consult panel wrote it for a person (docs/consult.md):
 * what is asked, why it matters, the options with their consequences and a
 * recommendation, in the operator's language. The asker's own technical wording
 * stays with the caller; this is what a person reads first. Choosing an option
 * emits its label, which the caller puts into its answer field.
 */
defineProps({
  brief: { type: Object, required: true },
  // What the panel did before a person was asked: { outcome, reason, positions }.
  consult: { type: Object, default: null }
})
defineEmits(['choose'])
const open = ref(false)
</script>

<template>
  <div class="brief">
    <p class="brief__question">{{ brief.question }}</p>
    <p v-if="brief.why" class="brief__why">{{ brief.why }}</p>
    <ul v-if="brief.options?.length" class="brief__options">
      <li v-for="option in brief.options" :key="option.label">
        <v-btn size="x-small" variant="tonal" color="primary" @click="$emit('choose', option.label)">{{ option.label }}</v-btn>
        <span>{{ option.consequence }}</span>
      </li>
    </ul>
    <p v-if="brief.recommendation" class="brief__rec"><strong>Recommended:</strong> {{ brief.recommendation }}</p>
    <template v-if="brief.positions?.length || consult">
      <button type="button" class="brief__toggle" :aria-expanded="open" @click="open = !open">
        {{ open ? 'Hide' : 'Show' }} what the two consulted models said
      </button>
      <div v-if="open" class="brief__positions">
        <p v-if="brief.undecidedBecause || consult?.reason" class="muted">Not settled: {{ brief.undecidedBecause ?? consult.reason }}</p>
        <p v-for="p in brief.positions ?? consult?.positions ?? []" :key="p.seat">
          <strong>{{ p.seat }}</strong>
          <span v-if="p.verdict === 'owner'"> left it to a person.</span>
          <span v-else-if="p.answer"> ({{ p.confidence }} confidence): {{ p.answer }}</span>
          <span v-if="p.recommendation"> Recommends: {{ p.recommendation }}</span>
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.brief { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(var(--v-theme-primary), 0.5); background: rgba(var(--v-theme-primary), 0.06); }
.brief__question { margin: 0; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.brief__why, .brief__rec { margin: 0; overflow-wrap: anywhere; }
.brief__options { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.brief__options li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.brief__toggle { align-self: flex-start; font-size: 0.75rem; opacity: 0.7; text-decoration: underline; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; }
.brief__positions p { margin: 2px 0; font-size: 13px; overflow-wrap: anywhere; }
</style>
