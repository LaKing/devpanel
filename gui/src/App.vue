<script setup>
import { computed, ref, watch } from 'vue'
import StatusChips from '@/components/StatusChips.vue'
import { useRoute } from 'vue-router'
import { useDisplay, useTheme } from 'vuetify'

import ConnectionBadge from '@/components/ConnectionBadge.vue'
import SignInView from '@/views/SignInView.vue'
import { hasProxyLogin, isAuthenticated, signOut } from '@/auth'
import { connection } from '@/socket'
import { useProjects } from '@/projects'
import { loadIdentity, proxyUser } from '@/identity'

const display = useDisplay()
const theme = useTheme()
const route = useRoute()

// Open by default on a wide screen, closed on a phone.
const drawer = ref(!display.mobile.value)

// The navigation lists every <projects-root>/*-project. Reloading re-scans that directory.
const { projects: navProjects, loading: projectsLoading, reload: rescanProjects } = useProjects()

function issueLabel (count) {
  if (!count) return undefined
  return count === 1 ? '1 issue' : `${count} issues`
}

// /projects/:project and /projects/:project/:id are sibling routes, not nested,
// so RouterLink would not mark the project active while an issue of it is open.
// The route param is the honest test of "am I inside this project".
const activeProject = computed(() => route.params.project ?? null)

const isDark = computed(() => theme.current.value.dark)

const themeToggle = computed(() => ({
  icon: isDark.value ? '$themeDark' : '$themeLight',
  label: isDark.value ? 'Switch to light theme' : 'Switch to dark theme'
}))

function toggleTheme (event) {
  theme.setTransitionOrigin(event)
  theme.toggle()
}

const hostname = computed(() => connection.host?.hostname ?? '—')
// The install's own projects directory (home as ~), from /api/info's hello.
const rescanLabel = computed(() => `Re-scan ${connection.host?.directories?.projects ?? 'the projects directory'} for projects`)
// Seats on a host without the fence (macOS): unfenced under the install's
// opt-in, refused without it. Shown on every page while it holds.
const unfenced = computed(() => ['unfenced', 'refused'].includes(connection.host?.fence?.mode) ? connection.host.fence : null)

// /api/whoami sits behind the token, so it is asked once a token is accepted.
watch(isAuthenticated, (ok) => { if (ok) loadIdentity() }, { immediate: true })
</script>

<template>
  <v-app>
    <!-- Nothing behind this renders, and no request is made, without a token. -->
    <v-main v-if="!isAuthenticated" class="app-main">
      <SignInView />
    </v-main>

    <template v-else>
    <v-navigation-drawer
      v-model="drawer"
      :temporary="display.mobile.value"
      width="248"
      border="e"
      color="surface"
    >
      <div class="brand">
        <div class="brand__mark">
          <v-icon icon="$brand" size="20" />
        </div>
        <div class="brand__text">
          <div class="brand__name">devpanel<template v-if="proxyUser"> - {{ proxyUser }}</template></div>
          <div class="brand__sub">control panel</div>
        </div>
      </div>

      <v-divider />

      <v-list nav class="pa-2 pb-0">
        <v-list-item
          to="/"
          exact
          prepend-icon="$dashboard"
          title="Dashboard"
          rounded="md"
          color="primary"
        />
        <v-list-item to="/supervisor" title="Supervisor" prepend-icon="$play" rounded="md" color="primary" />
        <v-list-item to="/models" title="Model availability" prepend-icon="$availability" rounded="md" color="primary" />
      </v-list>

      <div class="nav-heading">
        <span class="nav-heading__label">Projects</span>
        <v-btn
          icon="$refresh"
          size="x-small"
          variant="text"
          density="comfortable"
          :loading="projectsLoading"
          :aria-label="rescanLabel"
          :title="rescanLabel"
          @click="rescanProjects"
        />
      </div>

      <v-list nav class="px-2 pb-2">
        <v-list-item
          v-for="project in navProjects"
          :key="project.id"
          :to="`/projects/${project.id}`"
          :active="activeProject === project.id"
          :title="project.label"
          :subtitle="issueLabel(project.issueCount)"
          prepend-icon="$projects"
          rounded="md"
          color="primary"
          :class="{ 'nav-quiet': !project.issueCount && activeProject !== project.id }"
        />

        <v-list-item
          v-if="!navProjects.length && !projectsLoading"
          title="No projects found"
          prepend-icon="$issues"
          rounded="md"
          class="nav-quiet"
        />
      </v-list>

      <template #append>
        <v-divider />
        <div class="drawer-foot">
          <div class="drawer-foot__row">
            <v-icon icon="$server" size="14" />
            <span class="text-truncate">{{ hostname }}</span>
          </div>
          <div class="drawer-foot__row drawer-foot__row--muted">
            <span>{{ connection.version ? 'v' + connection.version : 'version unknown' }}</span>
          </div>
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar flat border="b" height="60" color="surface">
      <v-app-bar-nav-icon
        :aria-label="drawer ? 'Hide navigation' : 'Show navigation'"
        @click="drawer = !drawer"
      />

      <v-app-bar-title class="app-title">{{ $route.meta.title ?? 'devpanel' }}</v-app-bar-title>

      <!-- The supervisor and the agents, at a glance; each chip opens the detail. -->
      <StatusChips v-if="isAuthenticated" class="app-status" />

      <div class="app-spacer" />

      <!-- Pages teleport their own actions in here, so the bar stays theirs to
           fill without App.vue knowing what any given page needs. -->
      <div id="appbar-actions" class="appbar-actions" />

      <ConnectionBadge class="ml-2 mr-2" />

      <v-btn
        :icon="themeToggle.icon"
        :aria-label="themeToggle.label"
        :title="themeToggle.label"
        variant="text"
        size="small"
        @click="toggleTheme"
      />

      <!-- A verified proxy login holds no token here to forget. -->
      <v-btn
        v-if="!hasProxyLogin"
        icon="$signOut"
        aria-label="Forget the token"
        title="Forget the token"
        variant="text"
        size="small"
        @click="signOut"
      />
    </v-app-bar>

    <v-main class="app-main">
      <!-- The page is loaded from disk on every visit; the server is loaded once.
           When they diverge, a current page calls routes an older process has
           never heard of — so say so instead of letting it surface as a 404. -->
      <v-alert
        v-if="connection.source && connection.source.stale"
        type="warning"
        variant="tonal"
        density="compact"
        class="stale-server"
      >
        This panel's server is running code from before the last change, so newer
        actions will fail. Restart it to pick them up — the page itself is current.
      </v-alert>
      <v-alert
        v-if="unfenced"
        :type="unfenced.mode === 'unfenced' ? 'warning' : 'error'"
        variant="tonal"
        density="compact"
        class="stale-server unfenced-host"
      >
        <strong>{{ unfenced.mode === 'unfenced' ? 'Unfenced:' : 'Seats refused:' }}</strong> {{ unfenced.reason }}.
        <template v-if="unfenced.mode === 'unfenced'">Seats run as namespace 0, local checks and tooling commands unconfined; every run records it.</template>
      </v-alert>
      <router-view v-slot="{ Component }">
        <v-fade-transition mode="out-in">
          <component :is="Component" />
        </v-fade-transition>
      </router-view>
    </v-main>
    </template>
  </v-app>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  height: 60px;
}

.brand__mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  flex: none;
}

.brand__name {
  font-size: 0.9375rem;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.brand__sub {
  font-size: 0.75rem;
  opacity: 0.6;
  line-height: 1.3;
}

.app-title {
  font-size: 0.9375rem;
  font-weight: 600;
  margin-inline-start: 8px;
}

.drawer-foot {
  padding: 12px 16px;
  font-size: 0.75rem;
  opacity: 0.7;
  display: grid;
  gap: 4px;
}

.drawer-foot__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.drawer-foot__row--muted {
  opacity: 0.75;
}

.app-main {
  background: rgb(var(--v-theme-background));
}

.nav-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 2px 20px;
}

.nav-heading__label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  opacity: 0.5;
}

/* Projects with nothing open recede, so the working set reads first. */
.nav-quiet {
  opacity: 0.55;
}

.appbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Title and spacer share the free space equally, which puts the status chips
   in the middle of the bar. The title still shortens before anything else. */
.app-title { flex: 1 1 0; min-width: 0; }
.app-status { flex: none; margin-inline: 12px; }
.app-spacer { flex: 1 1 0; }

/* On a narrow bar the title loses to the actions and ends up an ellipsis. The
   labels go instead — every one of these buttons still has its icon and title.
   Hiding the text is not enough on its own: a text button keeps its text
   padding, so it stays as wide as a word that is no longer there. */
@media (max-width: 640px) {
  :deep(.appbar-label) { display: none; }
  :deep(.appbar-actions .v-btn) { min-width: 40px; padding-inline: 8px; }
  :deep(.appbar-actions .v-btn .v-icon--start) { margin-inline-end: 0; }
}

/* Narrower still, the page name goes rather than being cut in half. Every route
   carries its own heading, so the bar is repeating something the page already
   says — and half a word is worse than not saying it twice. */
@media (max-width: 600px) {
  .app-title { display: none; }
  /* Room for 44px touch targets beside the chips on the narrowest phones. */
  .app-status { margin-inline: 4px; }
}

.stale-server { margin: 12px 16px 0; }
</style>
