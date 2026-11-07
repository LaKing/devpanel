<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import DialogHeader from '@/components/DialogHeader.vue'
import ProjectActions from '@/components/ProjectActions.vue'
import ProjectInfrastructure from '@/components/ProjectInfrastructure.vue'
import { api } from '@/api'
import { actorName, proxyUser, rememberedActor } from '@/identity'
import { loadProjects } from '@/projects'
import { reportTags } from '@/report-tags'
import { familyTags, treeRows } from '@/issue-tree'
import { connection, socket } from '@/socket'

const route = useRoute()
const router = useRouter()
const archived = computed(() => route.query.archived === 'true')

const issues = ref([])
const loading = ref(true)
const loadError = ref('')

const dialog = ref(false)
const saving = ref(false)
const formError = ref('')
const name = ref('')
// Recorded on the issue as who opened it (name@the machine this browser is on).
const actor = ref(rememberedActor())

/* Deleting is permanent. Archiving is the deliberate step that makes it
   reachable at all, so this one acts on the click. */
const deletingId = ref(null)
const deleteError = ref('')

async function remove (issue) {
  if (deletingId.value) return          // one at a time, so a double-click is one delete
  deletingId.value = issue.id
  deleteError.value = ''
  try {
    await api.deleteIssue(project.value, issue.id)
    await load()
  } catch (err) {
    deleteError.value = `${issue.name}: ${err.message}`
  } finally {
    deletingId.value = null
  }
}

const project = computed(() => route.params.project)
// The install's configured directories (home as ~); the issues directory is its own setting.
const issuesPath = computed(() => `${connection.host?.directories?.issues ?? 'issues'}/${project.value}`)
const projectPath = computed(() => connection.host?.directories?.projects ? `${connection.host.directories.projects}/${project.value}` : '/path/to/project')
const projectLabel = computed(() => String(project.value).replace(/-project$/, ''))

const BASE_HEADERS = [
  { title: 'Opened', key: 'openedOn', width: 130 },
  { title: 'Name', key: 'name' },
  { title: 'Opened by', key: 'openedBy', width: 200, sort: (a, b) => opener(a).localeCompare(opener(b)) },
  { title: 'Steps', key: 'stepCount', width: 90, align: 'end' }
]

// Delete belongs to the archived list alone — an active issue has no way to
// reach it, which is what "gated behind archive" means in the interface too.
const HEADERS = computed(() => archived.value
  ? [...BASE_HEADERS, { title: '', key: 'actions', width: 60, align: 'end', sortable: false }]
  : BASE_HEADERS)

/* Unsorted, the list is the provenance tree (issue-tree.js); a column sort shows it flat, sorted, and
   clearing the sort brings the tree back. Collapsed parents are this view's state, not the issue's. */
const sortBy = ref([])
const collapsed = ref(new Set())
// Each row is the issue itself plus `row` (its place in the tree), so column sorts read the issue's fields.
const rows = computed(() => sortBy.value.length
  ? issues.value.map((item) => ({ ...item, row: { depth: 0, childCount: 0, ghost: false, key: `${project.value}/${item.id}` } }))
  : treeRows(issues.value, project.value, collapsed.value).map(({ item, ...row }) => ({ ...item, row })))
function toggle (row) {
  const next = new Set(collapsed.value)
  if (next.has(row.key)) next.delete(row.key)
  else next.add(row.key)
  collapsed.value = next
}

const countLabel = computed(() => {
  const n = issues.value.length
  return n === 1 ? '1 issue' : `${n} issues`
})

/*
 * Only the newest load may write to the table.
 *
 * Archiving emits a change event, which triggers a load, while switching tabs
 * triggers another — and the two ask different questions. Without this the
 * slower answer wins and the archived tab can end up showing the active list.
 */
let loadSeq = 0
// Uncommitted changes in the checkout that a live run is also touching (path-overlap.mjs): a warning, never a block.
const checkoutOverlap = ref(null)
// The project's module pool and the locks live runs hold in it (module-locks.mjs); null without a pool.
const moduleLocks = ref(null)

async function load () {
  const seq = ++loadSeq
  const wanted = archived.value
  loadError.value = ''
  try {
    // Re-scan the projects directory as well, so the drawer picks up new projects and counts.
    const [next] = await Promise.all([api.listIssues(project.value, { archived: wanted }), loadProjects()])
    if (seq !== loadSeq) return                    // superseded while in flight
    issues.value = next
    // Only a warning: a failed reading shows nothing and blocks nothing.
    api.checkoutOverlap(project.value).then((reading) => { if (seq === loadSeq) checkoutOverlap.value = reading }, () => { if (seq === loadSeq) checkoutOverlap.value = null })
    api.moduleLocks(project.value).then((reading) => { if (seq === loadSeq) moduleLocks.value = reading }, () => { if (seq === loadSeq) moduleLocks.value = null })
  } catch (err) {
    if (seq !== loadSeq) return
    loadError.value = err.message
    issues.value = []
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

function openDialog () {
  name.value = ''
  formError.value = ''
  dialog.value = true
}

async function submit () {
  if (saving.value || !name.value.trim()) return
  saving.value = true
  formError.value = ''
  try {
    // The project is already known here, so it is not asked for again.
    const issue = await api.createIssue(project.value, { input: name.value, actor: actorName(actor.value) || undefined })
    dialog.value = false
    router.push(`/projects/${issue.project}/${issue.id}`)
  } catch (err) {
    formError.value = err.message
  } finally {
    saving.value = false
  }
}

/*
 * Tags, from the issue and its newest run. Each says one thing, in words the
 * rest of the panel uses; none is a spinner next to something that will never
 * move (a run needing recovery is tagged as such, not as running).
 */
const BLOCKED_TEXT = {
  'protocol-repair-exhausted': 'protocol failure',
  'rounds-exhausted': 'rounds exhausted',
  'budget-exhausted': 'budget exhausted',
  'closure-not-authorised': 'needs human close',
  'candidate-changed-since-approval': 'candidate drifted',
  'delivery-unverifiable': 'delivery unverifiable',
  'delivery-unavailable': 'delivery unavailable',
  'delivery-failed': 'delivery failed',
  'preflight-refused': 'preflight refused',
  'closure-conditions-unmet': 'not closeable',
  'checks-inconclusive': 'base unfinished',
  'task-incomplete': 'task incomplete'
}
// What the newest closed run achieved, in its playbook's words. Never
// "resolved": only the issue's disposition says that.
const RESULT_TEXT = { 'artifact-ready': 'patch ready', accepted: 'triaged', duplicate: 'triaged: duplicate', 'needs-information': 'needs information', 'no-findings': 'no findings' }
// Who opened it, as opened-by.mjs records it: user@host, or a panel process at the panel host.
// A reported issue names its reporter, or `report` when it came without a key (server/report.mjs).
const VIA_TEXT = { 'follow-up': 'follow-up of', split: 'split from', inquiry: 'from inquiry', finding: 'finding of' }
function opener (o) {
  if (!o) return ''
  return o.host ? `${o.user}@${o.host}` : o.user
}
function openerTitle (o) {
  if (!o) return 'Not recorded (opened before this was kept)'
  const from = o.from ? ` · ${VIA_TEXT[o.from.via] ?? o.from.via} ${o.from.issueId}` : ''
  return `${opener(o)}${from}${o.derived ? ' · derived from the issue\'s own record' : ''}`
}

function tagsFor (item) {
  if (item.ghost) return [{ key: 'ghost', text: 'not in this list', title: 'The issue these came out of: archived, an inquiry, or in another project' }]
  const tags = []
  tags.push(...reportTags(item.report, opener(item.openedBy)))
  tags.push(...familyTags(item.family))
  if (item.disposition) {
    const d = item.disposition
    tags.push({ key: 'disposition', text: d.value.replace(/-/g, ' '), color: d.value === 'resolved' ? 'success' : ['not-resolved', 'declined'].includes(d.value) ? 'error' : ['split', 'duplicate'].includes(d.value) ? 'info' : 'warning', title: `Disposition by ${d.by}: ${d.evidence}${d.openRisks?.length ? ` · ${d.openRisks.length} open risk(s)` : ''}` })
  }
  if (item.status && item.status !== 'open') tags.push({ key: 'status', text: item.status, color: item.status === 'resolved' ? 'success' : undefined, title: 'Issue status' })
  const run = item.latestRun
  if (!run) {
    if (item.hasMetadata) tags.push({ key: 'noruns', text: 'no runs', title: 'No playbook has been run on this issue' })
    return tags
  }
  if (run.recoveryRequired) tags.push({ key: 'recovery', text: 'recovery required', color: 'error', title: 'The last run was interrupted and cannot be attributed; it needs a decision' })
  else if (run.status === 'paused') tags.push({ key: 'paused', text: 'paused', color: 'info', icon: '$pause', title: 'The run is paused, waiting for a person' })
  else if (run.live) tags.push({ key: 'live', text: run.status, color: 'primary', live: true, title: 'A run is in progress' })
  else if (run.status === 'completed' && run.outcome === 'resolved') tags.push({ key: 'result', text: RESULT_TEXT[run.result] ?? run.result ?? 'completed', color: 'success', title: `${run.resultLabel ?? 'The last run reached closure'}. The issue itself is decided by its disposition.` })
  else if (run.status === 'blocked') tags.push({ key: 'blocked', text: BLOCKED_TEXT[run.blockedReason] ?? 'blocked', color: 'warning', title: `Blocked: ${run.blockedReason ?? 'no reason recorded'}` })
  else if (run.status === 'cancelled') tags.push({ key: 'cancelled', text: 'cancelled', title: 'The last run was stopped' })
  else if (run.status === 'failed') tags.push({ key: 'failed', text: 'failed', color: 'warning', title: `Failed: ${run.blockedReason ?? 'no reason recorded'}` })
  else if (run.result === 'rejected') tags.push({ key: 'rejected', text: 'rejected', title: 'Triage judged the playbook unfit for this issue' })
  else if (run.status === 'completed') tags.push({ key: 'incomplete', text: 'incomplete', title: 'The last run finished without reaching closure' })
  if (run.workspaceRetained && !run.live) tags.push({ key: 'retained', text: 'work retained', color: 'info', title: 'Undelivered work is kept in a retained worktree' })
  if (run.playbook) tags.push({ key: 'playbook', text: run.playbook, title: 'Playbook of the newest run' })
  if (run.intent) tags.push({ key: 'intent', text: run.intent, title: 'Intent of the newest run' })
  if (item.runCount > 1) tags.push({ key: 'runs', text: `${item.runCount} runs`, title: 'Runs recorded on this issue' })
  return tags
}

function rowProps ({ item }) {
  return {
    onClick: () => router.push(`/projects/${item.project ?? project.value}/${item.id}`),
    style: 'cursor: pointer',
    class: item.row.ghost ? 'issues__row--ghost' : undefined
  }
}

function onChanged (payload) {
  if (!payload?.project || payload.project === project.value) load()
}

/* Run transitions change the tags. Output chunks and liveness ticks do not, and
   arrive far too often to reload a list for; everything else is debounced into
   one reload. */
let runPending = null
function onRunEvent (payload) {
  if (payload?.project !== project.value) return
  if (payload.type === 'live' || payload.type === 'activity') return
  clearTimeout(runPending)
  runPending = setTimeout(load, 200)
}
const onReconnect = () => load()

onMounted(() => {
  load()
  socket.on('issues:changed', onChanged)
  socket.on('run:event', onRunEvent)
  socket.on('connect', onReconnect)
})

onUnmounted(() => {
  clearTimeout(runPending)
  socket.off('issues:changed', onChanged)
  socket.off('run:event', onRunEvent)
  socket.off('connect', onReconnect)
})

watch([project, archived], () => {
  loading.value = true
  load()
})
</script>

<template>
  <div class="issues">
    <header class="issues__head">
      <v-icon icon="$projects" size="17" class="issues__head-icon" />
      <h1 class="issues__project">{{ projectLabel }}</h1>
      <ProjectInfrastructure :project="String(project)" />
    </header>

    <div class="issues__navigation">
    <v-tabs :model-value="archived ? 'archived' : 'active'" density="compact" class="issues__tabs"
            @update:model-value="router.replace({ query: $event === 'archived' ? { archived: 'true' } : {} })">
      <v-tab value="active">Active issues</v-tab>
      <v-tab value="archived">Archived issues</v-tab>
    </v-tabs>
      <div class="issues__tools" role="group" aria-label="Issue list actions">
        <ProjectActions :project="String(project)" />
        <v-btn variant="text" size="small" icon="$refresh" aria-label="Reload issues"
               title="Reload issues" :loading="loading" @click="load" />
        <v-btn color="primary" size="small" variant="flat" prepend-icon="$plus" @click="openDialog">
          New issue
        </v-btn>
      </div>
    </div>

    <v-alert v-if="checkoutOverlap?.state === 'overlap'" type="warning" variant="tonal" density="compact" class="mb-3"
             data-test="checkout-overlap">
      Uncommitted changes in this checkout are also being changed by a live run:
      <span v-for="(o, i) in checkoutOverlap.overlaps" :key="`${o.runId}-${o.ownerProject}`">{{ i ? '; ' : ' ' }}run {{ o.runId }} of {{ o.issueId }} touches {{ o.files.map((f) => f.path).join(', ') }}{{ o.more ? ` and ${o.more} more` : '' }}</span>.
      Nothing is blocked: its delivery merges with these edits and stops only on lines both changed.
    </v-alert>

    <v-alert v-if="moduleLocks?.held?.length" type="info" variant="tonal" density="compact" class="mb-3"
             data-test="module-locks">
      Module locks in the pool of {{ moduleLocks.pool }} ({{ moduleLocks.members.join(', ') }}): a start that needs one of these modules waits until its run ends.
      <div v-for="l in moduleLocks.held" :key="l.module" class="mt-1">
        <code>{{ l.module }}</code>
        <span v-if="l.owner"> ({{ l.owner }})</span>
        — run {{ l.runId }} of {{ l.project }}/{{ l.issueId }}<span v-if="l.state !== 'held'">, {{ l.state }}</span><span v-if="l.waiting">, waiting for another module</span>
      </div>
    </v-alert>

    <v-alert v-if="deleteError" type="error" variant="tonal" density="compact" closable
             class="mb-3" @click:close="deleteError = ''">
      {{ deleteError }}
    </v-alert>

    <v-card elevation="0" border class="issues__card">
      <v-alert v-if="loadError" type="error" variant="tonal" density="compact" class="ma-3">
        {{ loadError }}
      </v-alert>
      <!-- Below Vuetify's sm (600px) a row stacks its cells, so a phone reads
           the list without scrolling it sideways. -->
      <v-data-table
        v-if="!loadError && (issues.length || loading)"
        :headers="HEADERS"
        v-model:sort-by="sortBy"
        :items="rows"
        :loading="loading"
        :item-value="(item) => item.row.key"
        density="comfortable"
        hover
        fixed-header
        hide-default-footer
        :items-per-page="-1"
        mobile-breakpoint="sm"
        class="issues__table"
        :row-props="rowProps"
      >
        <template #item.openedOn="{ item }">
          <span class="issues__date">{{ item.openedOn }}</span>
        </template>

        <template #item.name="{ item }">
          <div class="issues__node" :style="{ '--depth': item.row.depth }">
          <v-btn v-if="item.row.childCount" variant="text" size="x-small" density="compact" icon="$chevronRight"
                 class="issues__toggle" :class="{ 'issues__toggle--open': !collapsed.has(item.row.key) }"
                 :aria-label="collapsed.has(item.row.key) ? `Show the ${item.row.childCount} issues that came out of this one` : 'Hide the issues that came out of this one'"
                 :aria-expanded="!collapsed.has(item.row.key)" @click.stop="toggle(item.row)" />
          <span v-else class="issues__toggle-space" />
          <div class="issues__node-body">
          <span class="issues__name">{{ item.name }}</span>
          <v-chip
            v-if="!item.hasMetadata && !item.row.ghost"
            size="x-small"
            variant="tonal"
            color="warning"
            class="ml-2"
            title="No issue.json — this folder was created by hand"
          >folder only</v-chip>
          <!-- What the issue's newest run says about it. Derived from persisted
               state on the server, so a run driven elsewhere is tagged too. -->
          <span class="issues__tags">
            <v-chip v-for="tag in tagsFor(item)" :key="tag.key" size="x-small" variant="tonal"
                    :color="tag.color" :title="tag.title" :class="{ 'issues__tag--live': tag.live }">
              <v-progress-circular v-if="tag.live" indeterminate size="9" width="1.5" class="mr-1" /><v-icon v-else-if="tag.icon" :icon="tag.icon" size="12" class="mr-1" />{{ tag.text }}
            </v-chip>
          </span>
          </div>
          </div>
        </template>

        <template #item.openedBy="{ item }">
          <span class="issues__opener" :title="openerTitle(item.openedBy)">{{ opener(item.openedBy) || '—' }}</span>
        </template>

        <template #item.stepCount="{ item }">
          <span class="issues__steps">{{ item.stepCount }}</span>
        </template>

        <template #item.actions="{ item }">
          <v-btn
            v-if="!item.row.ghost"
            icon="$delete"
            variant="text"
            size="x-small"
            :aria-label="`Delete ${item.name}`"
            title="Delete permanently — this cannot be undone"
            :loading="deletingId === item.id"
            :disabled="Boolean(deletingId)"
            @click.stop="remove(item)"
          />
        </template>
      </v-data-table>

      <div v-else-if="!loadError" class="empty">
        <div class="empty__mark">
          <v-icon icon="$issues" size="26" />
        </div>
        <h2 class="empty__title">No {{ archived ? 'archived ' : '' }}issues in {{ projectLabel }}</h2>
        <p v-if="archived" class="empty__body">Archived issues keep all their files and can be restored.</p>
        <p v-else class="empty__body">
          Opening one creates a dated folder under this project, which you then
          work through in numbered steps.
        </p>
      </div>

      <v-divider />

      <footer v-if="!loadError" class="issues__foot">
        <span>{{ countLabel }}</span>
        <code class="issues__path">{{ issuesPath }}</code>
      </footer>
    </v-card>

    <v-dialog v-model="dialog" max-width="720" :persistent="saving">
      <v-card elevation="0">
        <DialogHeader :title="`New issue in ${projectLabel}`" :busy="saving" @close="dialog = false" />

        <v-divider />

        <v-card-text class="dialog__body">
          <v-textarea
            v-model="name"
            label="Title, report, or local Markdown path"
            :placeholder="`Describe the issue, paste a report, or enter ${projectPath}/audit.md`"
            persistent-placeholder
            hint="One line is a title. A report uses its heading or first line as the title. Paths refer to this server; relative paths start in the project folder."
            persistent-hint
            rows="8"
            auto-grow
            autofocus
            @keydown.ctrl.enter.prevent="submit"
          />
          <v-text-field v-if="!proxyUser" v-model="actor" label="Your name" density="compact" variant="outlined" class="mt-4"
                        hint="Recorded as who opened the issue, with the machine you are connecting from." persistent-hint />

          <v-alert v-if="formError" type="error" variant="tonal" density="compact" class="mt-4">
            {{ formError }}
          </v-alert>
        </v-card-text>

        <v-divider />

        <v-card-actions class="dialog__actions">
          <v-spacer />
          <v-btn variant="text" size="small" :disabled="saving" @click="dialog = false">Cancel</v-btn>
          <v-btn
            color="primary"
            variant="flat"
            size="small"
            :loading="saving"
            :disabled="!name.trim()"
            @click="submit"
          >Open issue</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
/* Tags sit on their own wrapping line under the name, so a row never grows
   wider than the table: on a phone they stack, they do not push sideways. */
.issues__tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.issues__tags .v-chip { font-size: 0.6875rem; }
.issues__table :deep(td) { white-space: normal; }
/* Provenance depth as indentation; the toggle column keeps names aligned whether or not a row has children. */
.issues__node { display: flex; align-items: flex-start; gap: 2px; padding-left: calc(var(--depth, 0) * 22px); }
.issues__node-body { min-width: 0; }
.issues__toggle { margin-top: -1px; transition: transform 0.12s; }
.issues__toggle--open { transform: rotate(90deg); }
.issues__toggle-space { flex: none; width: 24px; }
.issues__table :deep(.issues__row--ghost) { opacity: 0.55; font-style: italic; }
.issues {
  height: calc(100dvh - var(--v-layout-top, 60px) - var(--v-layout-bottom, 0px));
  padding: 10px 20px 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.issues__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 2px 10px;
  flex: none;
}

.issues__head-icon {
  opacity: 0.45;
}

.issues__project {
  font-weight: 650;
  font-size: 1.0625rem;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.issues__card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.issues__navigation { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; margin-bottom: 12px; flex: none; }
.issues__tabs { min-width: 0; flex: 0 1 auto; }
.issues__tools { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: none; }

.issues__table {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.issues__table :deep(.v-table__wrapper) {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.issues__date {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.issues__name {
  font-weight: 550;
}

.issues__opener {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  opacity: 0.75;
}

.issues__steps {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.issues__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 16px;
  font-size: 0.75rem;
  opacity: 0.6;
  flex: none;
}

.issues__path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 32px;
  text-align: center;
}

.empty__mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: 18px;
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
  max-width: 30rem;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.dialog__body { padding: 20px; }
.dialog__actions { padding: 12px 16px; }

</style>
