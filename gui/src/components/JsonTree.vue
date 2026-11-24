<script setup>
import { computed, ref } from 'vue'

import StructuredBody from './StructuredBody.vue'
import { embeddedJson } from '@/structured-text'

/*
 * A JSON value as a tree a person can read: keys, typed values, item counts,
 * folding. Strings are shown as text — unescaped, with their line breaks —
 * and a string that is itself JSON, or carries Markdown or a fenced result,
 * is unfolded and rendered for what it is. That is what makes the engine's
 * context (reports whose "response" is a model answer holding JSON) readable.
 *
 * Everything is Vue text nodes; nothing is inserted as HTML.
 */

const props = defineProps({
  value: { required: true },
  name: { type: [String, Number], default: null },
  depth: { type: Number, default: 0 },
  last: { type: Boolean, default: true }
})

const kind = computed(() => {
  const v = props.value
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'object') return 'object'
  if (typeof v === 'string') {
    if (embeddedJson(v) !== undefined) return 'json-string'
    if (v.includes('\n') || v.length > 400) return 'text'
    return 'string'
  }
  return typeof v
})

const inner = computed(() => kind.value === 'json-string' ? embeddedJson(props.value) : props.value)
const entries = computed(() => {
  const v = inner.value
  if (Array.isArray(v)) return v.map((item, i) => [i, item])
  if (v && typeof v === 'object') return Object.entries(v)
  return []
})
// An empty object or list is a value, not something to open.
const container = computed(() => ['object', 'array', 'json-string'].includes(kind.value) && entries.value.length > 0)
const isArray = computed(() => Array.isArray(inner.value))

const MAX_RENDER_DEPTH = 16
// Open near the top and when small; a large or deep branch starts folded.
const open = ref(props.depth < 2 || (props.depth < 6 && entries.value.length <= 6))
const textOpen = ref(true)

const summary = computed(() => {
  const n = entries.value.length
  return isArray.value ? `${n} item${n === 1 ? '' : 's'}` : `${n} key${n === 1 ? '' : 's'}`
})
const lines = computed(() => (typeof props.value === 'string' ? props.value.split('\n').length : 0))
</script>

<template>
  <div class="jt" :class="{ 'jt--root': depth === 0 }">
    <!-- An object, an array, or a string that holds one. -->
    <template v-if="container">
      <button type="button" class="jt__row jt__toggle" :aria-expanded="open" @click="open = !open">
        <span class="jt__caret" :class="{ 'jt__caret--open': open }">▸</span>
        <span v-if="name !== null" class="jt__key" :class="{ 'jt__key--index': typeof name === 'number' }">{{ name }}</span>
        <span v-if="kind === 'json-string'" class="jt__badge">JSON text</span>
        <span class="jt__brace">{{ isArray ? '[' : '{' }}</span>
        <span v-if="!open" class="jt__summary">{{ summary }} <span class="jt__brace">{{ isArray ? ']' : '}' }}</span></span>
      </button>
      <div v-if="open" class="jt__children">
        <template v-if="depth < MAX_RENDER_DEPTH">
          <JsonTree v-for="([k, v], i) in entries" :key="k" :name="k" :value="v" :depth="depth + 1" :last="i === entries.length - 1" />
        </template>
        <p v-else class="jt__empty">max nesting depth ({{ MAX_RENDER_DEPTH }}) reached</p>
        <p v-if="!entries.length" class="jt__empty">empty</p>
      </div>
      <div v-if="open" class="jt__row jt__close"><span class="jt__brace">{{ isArray ? ']' : '}' }}</span></div>
    </template>

    <!-- Prose inside a string: shown as the text it is, line breaks and all. -->
    <template v-else-if="kind === 'text'">
      <button type="button" class="jt__row jt__toggle" :aria-expanded="textOpen" @click="textOpen = !textOpen">
        <span class="jt__caret" :class="{ 'jt__caret--open': textOpen }">▸</span>
        <span v-if="name !== null" class="jt__key">{{ name }}</span>
        <span class="jt__summary">text · {{ lines }} line{{ lines === 1 ? '' : 's' }}</span>
      </button>
      <div v-if="textOpen" class="jt__text">
        <StructuredBody :text="value" nested />
      </div>
    </template>

    <div v-else class="jt__row">
      <span class="jt__spacer" />
      <span v-if="name !== null" class="jt__key" :class="{ 'jt__key--index': typeof name === 'number' }">{{ name }}</span>
      <span v-if="kind === 'object' || kind === 'array'" class="jt__brace">{{ kind === 'array' ? '[ ]' : '{ }' }}</span>
      <span v-else :class="`jt__v jt__v--${kind}`">{{ kind === 'string' ? value : String(value) }}</span>
    </div>
  </div>
</template>

<style scoped>
.jt { font: 0.8125rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 0; }
.jt__row { display: flex; align-items: baseline; gap: 6px; min-width: 0; padding: 1px 0; }
.jt__toggle { width: 100%; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 4px; }
.jt__toggle:hover { background: rgba(var(--v-theme-on-surface), 0.05); }
.jt__toggle:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 1px; }
.jt__caret { flex: none; width: 12px; display: inline-block; opacity: 0.5; transition: transform 0.12s; }
.jt__caret--open { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .jt__caret { transition: none; } }
.jt__spacer { flex: none; width: 12px; }
.jt__key { flex: none; color: rgb(var(--v-theme-primary)); font-weight: 600; }
.jt__key::after { content: ':'; color: rgb(var(--v-theme-on-surface)); opacity: 0.45; font-weight: 400; }
.jt__key--index { opacity: 0.55; font-weight: 400; }
.jt__brace, .jt__summary { opacity: 0.5; }
.jt__badge { font: 600 0.625rem/1.6 system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 6px; border-radius: 6px; background: rgba(var(--v-theme-primary), 0.12); color: rgb(var(--v-theme-primary)); }
.jt__children { margin-left: 5px; padding-left: 13px; border-left: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.jt__close { padding-left: 18px; }
.jt__empty { margin: 0; opacity: 0.45; font-style: italic; }
.jt__v { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.jt__v--string { color: rgb(var(--v-theme-success)); }
.jt__v--number, .jt__v--boolean { color: rgb(var(--v-theme-secondary, var(--v-theme-primary))); }
.jt__v--null { opacity: 0.5; font-style: italic; }
/* A prose string reads as prose, in the page's type, not as a code value. */
.jt__text {
  margin: 2px 0 6px 18px; padding: 2px 0 2px 12px; max-height: 28rem; overflow: auto;
  font: 0.8125rem/1.6 system-ui, sans-serif; border-left: 3px solid rgba(var(--v-theme-success), 0.45);
}
</style>
