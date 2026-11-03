<script setup>
import { ref, watch } from 'vue'
// The campaign's declared scope (top-supervisor.mjs setCampaign). Unlike focus it
// decides wakes: an issue change it places outside waits for the next wake.
const props = defineProps({ campaign: { type: Object, default: null }, projects: { type: Array, default: () => [] }, busy: { type: Boolean, default: false } })
const emit = defineEmits(['save'])
const scoped = ref([]), reporters = ref([])
// By value: the page refreshes the state every few seconds, and that must not undo an edit in progress.
watch(() => JSON.stringify([props.campaign?.projects ?? [], props.campaign?.leaveReporters ?? []]), (saved) => { [scoped.value, reporters.value] = JSON.parse(saved) }, { immediate: true })
</script>
<template>
 <section class="campaign" aria-label="Campaign scope">
  <v-select v-model="scoped" :items="projects" item-title="label" item-value="id" label="Campaign projects (optional)" variant="outlined" density="comfortable"
            hint="Issue changes in other projects do not wake the supervisor; it sees them at its next wake." persistent-hint multiple chips clearable />
  <v-combobox v-model="reporters" label="Reporters left to others (optional)" variant="outlined" density="comfortable"
              hint="Issues from these reporters do not wake the supervisor; it sees them at its next wake." persistent-hint multiple chips clearable />
  <v-btn size="small" variant="tonal" :disabled="busy" @click="emit('save', { projects: scoped, leaveReporters: reporters })">Save campaign</v-btn>
 </section>
</template>
<style scoped>
.campaign{display:grid;gap:10px;justify-items:stretch;margin:8px 0 16px}.campaign .v-btn{justify-self:start}
</style>
