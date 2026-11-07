<script setup>
import { computed, onUnmounted, ref } from 'vue'

import ActiveAgents from '@/components/ActiveAgents.vue'
import FullVerificationCard from '@/components/FullVerificationCard.vue'
import NeedsAttention from '@/components/NeedsAttention.vue'
import SupervisorOverview from '@/components/SupervisorOverview.vue'
import StatTile from '@/components/StatTile.vue'
import { connection } from '@/socket'
import { formatBytes, formatDuration, formatRelative } from '@/format'

// Ticks once a second purely so the "updated Ns ago" line stays honest.
const now = ref(Date.now())
const clock = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(clock))

const agents = ref(null)
const supervisor = ref(null)
const attention = ref(null)
const refreshOverview = () => Promise.all([agents.value?.load(), supervisor.value?.load(), attention.value?.load()])

const metrics = computed(() => connection.metrics)
const host = computed(() => connection.host)
const waiting = computed(() => metrics.value === null)

const freshness = computed(() => {
  now.value // re-evaluate on every tick
  return formatRelative(connection.updatedAt)
})

const tiles = computed(() => {
  const m = metrics.value
  return [
    {
      key: 'cpu',
      label: 'CPU',
      icon: '$chip',
      value: m ? m.cpu.usage.toFixed(1) : '—',
      unit: m ? '%' : '',
      percent: m ? m.cpu.usage : null,
      caption: m ? `Load ${m.cpu.load.join('  ·  ')}` : ''
    },
    {
      key: 'memory',
      label: 'Memory',
      icon: '$memory',
      value: m ? m.memory.usedPercent.toFixed(1) : '—',
      unit: m ? '%' : '',
      percent: m ? m.memory.usedPercent : null,
      caption: m ? `${formatBytes(m.memory.used)} of ${formatBytes(m.memory.total)}` : ''
    },
    {
      key: 'disk',
      label: 'Disk',
      icon: '$disk',
      value: m?.disk ? m.disk.usedPercent.toFixed(1) : '—',
      unit: m?.disk ? '%' : '',
      percent: m?.disk ? m.disk.usedPercent : null,
      caption: m?.disk ? `${formatBytes(m.disk.free)} free of ${formatBytes(m.disk.total)}` : ''
    },
    {
      key: 'uptime',
      label: 'Uptime',
      icon: '$clock',
      value: m ? formatDuration(m.uptime.system) : '—',
      caption: m ? `Panel up ${formatDuration(m.uptime.process)}` : ''
    },
    {
      key: 'clients',
      label: 'Connected',
      icon: '$lan',
      value: m?.clients ?? '—',
      caption: m ? (m.clients === 1 ? 'this browser' : 'live sessions') : ''
    }
  ]
})

const facts = computed(() => {
  const h = host.value
  const m = metrics.value
  return [
    { label: 'Host', value: h?.hostname ?? '—' },
    { label: 'Platform', value: h?.platform ?? '—' },
    { label: 'Architecture', value: h?.arch ?? '—' },
    { label: 'Node', value: h?.node ?? '—' },
    { label: 'CPU cores', value: h?.cpus ?? '—' },
    { label: 'Total memory', value: h ? formatBytes(h.totalMemory) : '—' },
    { label: 'Panel RSS', value: m ? formatBytes(m.memory.rss) : '—' }
  ]
})
</script>

<template>
  <v-container fluid class="dash">
    <header class="dash__head">
      <div>
        <h1 class="dash__title">Dashboard</h1>
        <p class="dash__subtitle">
          <template v-if="waiting">Waiting for the first reading…</template>
          <template v-else>Updated {{ freshness }}</template>
        </p>
      </div>

      <!-- Static host facts: available on demand, not worth permanent space. -->
      <v-menu location="bottom end" :close-on-content-click="false">
        <template #activator="{ props: menu }">
          <v-btn v-bind="menu" variant="text" size="small" prepend-icon="$info">System</v-btn>
        </template>
        <v-card elevation="4" border min-width="280" class="facts">
          <dl class="facts__grid">
            <template v-for="fact in facts" :key="fact.label">
              <dt class="facts__label">{{ fact.label }}</dt>
              <dd class="facts__value">{{ fact.value }}</dd>
            </template>
          </dl>
        </v-card>
      </v-menu>
    </header>

    <v-row class="dash__tiles" dense>
      <v-col v-for="tile in tiles" :key="tile.key" cols="12" sm="6" md="4" lg>
        <StatTile
          :label="tile.label"
          :value="tile.value"
          :unit="tile.unit"
          :caption="tile.caption"
          :icon="tile.icon"
          :percent="tile.percent ?? null"
          :loading="waiting"
        />
      </v-col>
    </v-row>

    <v-row dense>
      <v-col cols="12">
        <v-card elevation="0" border class="panel">
          <v-card-item class="panel__head">
            <v-card-title class="panel__title">Overview</v-card-title>
            <template #append>
              <v-btn
                variant="text"
                size="small"
                prepend-icon="$refresh"
                aria-label="Reload overview"
                title="Reload supervisor and agents"
                @click="refreshOverview"
              >Refresh</v-btn>
            </template>
          </v-card-item>

          <v-divider />

          <h2 class="panel__section">Needs attention</h2>
          <NeedsAttention ref="attention" />
          <v-divider />
          <h2 class="panel__section">Supervisor</h2>
          <SupervisorOverview ref="supervisor" />
          <v-divider />
          <h2 class="panel__section">Running agents</h2>
          <ActiveAgents ref="agents" />
          <v-divider />
          <h2 class="panel__section">Full verification</h2>
          <FullVerificationCard />
        </v-card>
      </v-col>

    </v-row>
  </v-container>
</template>

<style scoped>
.dash {
  padding: 28px 24px 40px;
}

.dash__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}

.dash__title {
  font-size: 1.5rem;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.dash__subtitle {
  margin-top: 5px;
  font-size: 0.875rem;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.dash__tiles {
  margin-bottom: 10px;
}

.panel {
  height: 100%;
}

.panel__head {
  padding: 14px 20px;
}

.panel__title {
  font-size: 0.9375rem;
  font-weight: 600;
  padding: 0;
}

.panel__section {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.5;
  padding: 14px 20px 0;
}

.empty {
  padding: 56px 32px 64px;
  text-align: center;
  max-width: 30rem;
  margin: 0 auto;
}

.empty__mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin: 0 auto 18px;
  border-radius: 14px;
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface-variant));
}

.empty__title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 8px;
}

.empty__body {
  font-size: 0.875rem;
  line-height: 1.65;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.facts {
  padding: 14px 18px;
}

.facts__grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 24px;
  row-gap: 8px;
  margin: 0;
}

.facts__label {
  font-size: 0.8125rem;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.facts__value {
  font-size: 0.8125rem;
  font-weight: 500;
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
}
</style>
