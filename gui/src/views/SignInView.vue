<script setup>
import { onMounted, ref } from 'vue'

import { setToken, wasRejected } from '@/auth'

const value = ref('')
const submitted = ref(false)
// The token's place differs per install (the checkout on a Linux host, ~/devpanel on a Mac); the public health check names it.
const tokenFile = ref('<devpanel directory>/.devpanel-token')

onMounted(async () => {
  try {
    tokenFile.value = (await (await fetch('/api/health')).json()).tokenFile ?? tokenFile.value
  } catch { /* the hint falls back to the file name alone */ }
})

function submit () {
  if (!value.value.trim()) return
  submitted.value = true
  setToken(value.value)
  value.value = ''
}
</script>

<template>
  <div class="signin">
    <v-card elevation="0" border class="signin__card">
      <div class="signin__body">
        <div class="signin__mark">
          <v-icon icon="$brand" size="24" />
        </div>
        <h1 class="signin__title">devpanel</h1>
        <p class="signin__lead">
          This panel serves agent responses, prompts and patches — the project's own
          code. It needs the operator token before showing any of it.
        </p>

        <v-alert v-if="wasRejected" type="error" variant="tonal" density="compact" class="mb-4">
          That token was refused.
        </v-alert>

        <v-text-field
          v-model="value"
          label="Operator token"
          type="password"
          variant="outlined"
          density="comfortable"
          autofocus
          autocomplete="off"
          @keyup.enter="submit"
        />

        <v-btn color="primary" variant="flat" block :disabled="!value.trim()" @click="submit">
          Unlock
        </v-btn>

        <p class="signin__hint">
          On the server: <code>cat {{ tokenFile }}</code>
        </p>
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.signin {
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgb(var(--v-theme-background));
}

.signin__card { width: 100%; max-width: 26rem; }
.signin__body { padding: 36px 32px 28px; }

.signin__mark {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  margin-bottom: 18px;
}

.signin__title { font-size: 1.25rem; font-weight: 650; letter-spacing: -0.02em; }

.signin__lead {
  margin: 8px 0 22px;
  font-size: 0.875rem;
  line-height: 1.6;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.signin__hint {
  margin-top: 18px;
  font-size: 0.75rem;
  opacity: 0.5;
}

.signin__hint code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: rgb(var(--v-theme-surface-variant));
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
</style>
