<script setup>
import { onMounted, ref } from 'vue'

import { api } from '@/api'
import { actorName, rememberedActor } from '@/identity'
import { browserSubscription, currentEndpoint, deviceLabel, offersTurnOffAll, optOutSentences, pushSupported, subscriptionKeyMatches } from '@/notifications'

/*
 * Opt in and out of operator alerts (docs/operator-alerts.md): a pushed alert reaches this device with the panel
 * closed, for new owner questions and runs that newly need recovery. This device is found by its own push
 * endpoint, whatever name it was registered under, so turning it off never depends on the name typed now. Opting
 * out confirms at once and says what may still appear.
 */

const status = ref(null)
const busy = ref(false)
const error = ref('')
const confirmation = ref([])
const supported = pushSupported()
const endpoint = ref(null)
// The browser's subscription was made for a key the panel no longer has (vapid.json was replaced): alerts cannot reach it.
const staleKey = ref(false)
const actor = () => actorName(rememberedActor()) || undefined

async function load () {
  try {
    endpoint.value = await currentEndpoint().catch(() => null)
    status.value = await api.notifications(actor(), endpoint.value)
    staleKey.value = Boolean(status.value.thisDevice) && !(await subscriptionKeyMatches(status.value.publicKey).catch(() => true))
    error.value = ''
  } catch (e) { error.value = e.message }
}

const others = () => (status.value?.subscriptions ?? []).filter((s) => s.id !== status.value?.thisDevice?.id)

async function turnOn () {
  busy.value = true; error.value = ''; confirmation.value = []
  try {
    const subscription = await browserSubscription(status.value.publicKey)
    await api.subscribeAlerts(subscription, deviceLabel(), actor())
    await load()
  } catch (e) { error.value = e.message } finally { busy.value = false }
}

async function run (call) {
  busy.value = true; error.value = ''
  try { confirmation.value = optOutSentences(await call()); await load() } catch (e) { error.value = e.message } finally { busy.value = false }
}
const turnOffThisDevice = () => run(() => api.deviceAlertsOff(endpoint.value))
const turnOff = (id) => run(() => api.unsubscribeAlerts(id, actor()))
const turnOffAll = () => run(() => api.unsubscribeAlerts(null, actor()))

onMounted(load)
</script>

<template>
  <div class="alerts" data-testid="alert-settings">
    <template v-if="status">
      <span class="alerts__state">Alerts on this device: {{ status.thisDevice ? 'on' : 'off' }}</span>
      <template v-if="status.thisDevice && staleKey">
        <span class="alerts__muted">The panel's push key changed, so alerts no longer reach this device.</span>
        <v-btn size="x-small" variant="tonal" :loading="busy" @click="turnOn">Turn on for this device</v-btn>
      </template>
      <v-btn v-if="status.thisDevice" size="x-small" variant="tonal" :disabled="busy" @click="turnOffThisDevice">Turn off for this device</v-btn>
      <v-btn v-else-if="supported" size="x-small" variant="tonal" :loading="busy" @click="turnOn">Turn on for this device</v-btn>
      <span v-else class="alerts__muted">This browser cannot receive pushed alerts here (it needs HTTPS with a trusted certificate).</span>
      <v-btn v-for="s in others()" :key="s.id" size="x-small" variant="text" :disabled="busy" :title="`Stop alerts to ${s.label}`" @click="turnOff(s.id)">Turn off {{ s.label }}</v-btn>
      <v-btn v-if="offersTurnOffAll(status)" size="x-small" variant="text" :disabled="busy" @click="turnOffAll">Turn off all of mine</v-btn>
    </template>
    <p v-for="line in confirmation" :key="line" class="alerts__confirm" role="status">{{ line }}</p>
    <p v-if="error" class="alerts__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.alerts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 20px; font-size: 0.75rem; }
.alerts__state { opacity: 0.75; }
.alerts__muted { opacity: 0.55; }
.alerts__confirm { flex-basis: 100%; margin: 2px 0 0; }
.alerts__error { flex-basis: 100%; margin: 2px 0 0; color: rgb(var(--v-theme-error)); }
</style>
