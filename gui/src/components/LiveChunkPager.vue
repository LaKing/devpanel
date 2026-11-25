<script setup>
import { shallowRef, triggerRef, watch } from 'vue'

import { createSlicer } from '@/live-follow'

/*
 * Chunks too large to deliver whole arrive clipped (`sliced`). This reads such
 * a chunk one bounded slice at a time, holding a single slice, so every part of
 * it can be seen without the browser ever holding the whole chunk. Answers are
 * bound to the invocation, chunk and request that asked (live-follow.js createSlicer).
 */

const props = defineProps({
  entries: { type: Array, required: true },   // the clipped entries in the viewer's window
  fetchSlice: { type: Function, required: true },
  invocationId: { type: String, required: true }
})

const view = shallowRef(null)
const slicer = createSlicer({ fetchSlice: (seq, offset) => props.fetchSlice(seq, offset), onChange: (s) => { view.value = s; triggerRef(view) } })
view.value = slicer.state

// Another invocation: nothing of the old one may be shown or navigated from.
watch(() => props.invocationId, () => slicer.reset())

const kib = (n) => `${Math.ceil(n / 1024)} KiB`
</script>

<template>
  <div v-if="entries.length" class="pager">
    <div v-for="e in entries" :key="e.seq" class="pager__item">
      <button type="button" class="pager__toggle" @click="slicer.toggle(invocationId, e.seq)">
        {{ view.seq === e.seq ? 'Close' : 'Read' }} chunk {{ e.seq }} ({{ kib(e.sliced.total) }}, too large to show at once)
      </button>
      <template v-if="view.seq === e.seq && view.slice">
        <div class="pager__nav">
          <button type="button" :disabled="view.loading || !slicer.hasPrevious()" @click="slicer.previous()">Previous part</button>
          <span>characters {{ view.slice.offset + 1 }}–{{ view.slice.offset + view.slice.text.length }} of {{ view.slice.total }}</span>
          <button type="button" :disabled="view.loading || view.slice.done" @click="slicer.next()">Next part</button>
        </div>
        <pre class="pager__text">{{ view.slice.text }}</pre>
      </template>
    </div>
    <div v-if="view.error" class="pager__error">{{ view.error }}</div>
  </div>
</template>

<style scoped>
.pager { margin-top: 6px; font-size: 0.75rem; }
.pager__toggle, .pager__nav button { font: inherit; color: inherit; background: none; border: 1px solid currentColor; border-radius: 4px; padding: 1px 6px; cursor: pointer; opacity: 0.8; }
.pager__nav { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
.pager__text { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 12px/1.4 monospace; }
.pager__error { color: rgb(var(--v-theme-warning, 255 160 0)); }
</style>
