<script setup>
/*
 * How current the page's data is (freshness.js describe): when it was read and
 * whether it still is. Separate from the connection badge, which only says the
 * socket is up. Retry appears after any failed refresh, online or not.
 */
defineProps({ view: { type: Object, required: true } })
defineEmits(['retry'])
const COLOUR = { current: 'success', offline: 'error', failed: 'error', 'child-failed': 'warning', connecting: 'warning' }
</script>

<template>
  <span class="fresh" data-test="freshness" :data-state="view.kind" role="status" aria-live="polite">
    <v-icon :icon="view.current ? '$checkCircle' : view.retry ? '$alertCircle' : '$circleOutline'" size="14" :color="COLOUR[view.kind]" />
    <span class="fresh__label">{{ view.label }}</span>
    <v-btn v-if="view.retry" size="x-small" variant="text" data-test="freshness-retry" @click="$emit('retry')">Retry</v-btn>
  </span>
</template>

<style scoped>
.fresh { display: inline-flex; align-items: center; gap: 6px; min-width: 16rem; font-size: 0.8125rem; }
.fresh__label { overflow-wrap: anywhere; }
</style>
