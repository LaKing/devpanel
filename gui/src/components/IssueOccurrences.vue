<script setup>
import { ref } from 'vue'

import MarkdownText from '@/components/MarkdownText.vue'

/*
 * Later occurrences of the fault a report opened (server/report-occurrences.mjs): each one a deployment reported
 * again while this issue was open, recorded here instead of a new issue. The counters count every one; only the
 * newest few are kept with their report text, which says when, which versions, the release and the threads.
 */

const props = defineProps({
  occurrences: { type: Object, required: true },
  packed: { type: Boolean, default: false }
})

const open = ref(new Set())
const toggle = (seq) => { const next = new Set(open.value); next.has(seq) ? next.delete(seq) : next.add(seq); open.value = next }
const who = (e) => [e.reporter, e.host].filter(Boolean).join('@') || 'report'
const newestFirst = () => [...(props.occurrences.recent ?? [])].reverse()
</script>

<template>
  <section class="occurrences" aria-label="Later occurrences of this fault">
    <p class="occurrences__head">
      <span class="occurrences__label">Reported again {{ occurrences.count }} {{ occurrences.count === 1 ? 'time' : 'times' }}</span>
      <span v-if="occurrences.firstAt"> · first {{ occurrences.firstAt }}</span>
      <span v-if="occurrences.lastAt"> · last {{ occurrences.lastAt }}</span>
    </p>
    <ul class="occurrences__list">
      <li v-for="e in newestFirst()" :key="e.seq">
        <button type="button" class="occurrences__toggle" :aria-expanded="open.has(e.seq)" @click="toggle(e.seq)">
          #{{ e.seq }} · {{ e.at }} · {{ who(e) }}<template v-if="e.category"> · {{ e.category }}</template>
          <template v-if="e.truncated"> · text cut at 256 KiB of {{ e.bytes }} bytes</template>
        </button>
        <template v-if="open.has(e.seq)">
          <MarkdownText v-if="typeof e.text === 'string'" :text="e.text" compact />
          <p v-else class="occurrences__note">{{ packed ? 'The text is kept in the archive bundle.' : 'The text of this occurrence could not be read.' }}</p>
        </template>
      </li>
    </ul>
    <p v-if="occurrences.count > (occurrences.recent?.length ?? 0)" class="occurrences__note">Only the newest {{ occurrences.recent?.length ?? 0 }} are kept with their text.</p>
  </section>
</template>

<style scoped>
.occurrences { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; font-size: 0.8125rem; }
.occurrences__head { margin: 0; }
.occurrences__label { font-weight: 600; opacity: 0.7; }
.occurrences__list { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; gap: 2px; }
.occurrences__toggle { background: none; border: 0; padding: 0; color: inherit; cursor: pointer; text-align: left; overflow-wrap: anywhere; }
.occurrences__note { margin: 0; padding-left: 4px; opacity: 0.65; font-style: italic; }
</style>
