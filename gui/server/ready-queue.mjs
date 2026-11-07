import { splitByCampaign } from './decisions/wake-filter.mjs'
import { openDependencies } from './issue-dependencies.mjs'
import { settled } from './issue-family.mjs'
import { ASSESS_PLAYBOOKS } from './reporters.mjs'
import { admits } from './runtime/spending-policy.mjs'
import { concurrentStarts } from './supervisor-starts.mjs'

/*
 * What the top-level supervisor could start next, read for it by the engine.
 *
 * Without this it assembled the answer from separate reads, or found out by trying: a held checkout, an open
 * prerequisite and a full concurrency limit were each learned from a refused start. The queue reads the same
 * facts admission reads, so it says what admission would say, and it is an observation: start_run re-checks
 * everything, and a start that loses a race is still refused.
 *
 * Membership is the declared campaign (`splitByCampaign`, so one definition of "outside"); no campaign means
 * the whole panel, ordered by focus. It narrows this reading only: overview, list_issues and start_run still
 * reach every issue, and `outside` counts what was left out.
 *
 * Every block says what ends it, and `until.at` is a time only when one is known. It is known only for a
 * spending window. A run's wall-clock budget is a limit and pauses suspend it, so it is not when a run ends.
 * A model's availability has its own time, but belongs to a model and no playbook is chosen yet: seatModels
 * says it.
 */

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 }
const DISPLAY_ROWS = 30
// Which rows the display cap keeps first; shown in queue order all the same.
const STATE_RANK = { running: 0, ready: 1, blocked: 2, decide: 3 }
// What a wake can announce the end of. Everything else is ended by a person, or by the model's own act.
const CAPACITY_BLOCKS = ['checkout-held', 'dependency', 'module-lock']
const CAPACITY_PANEL = ['concurrency', 'spending-window']

const until = (event, at = null) => ({ event, at })
const keyOf = (project, id) => `${project}/${id}`

/** Ages to compare, oldest first; an issue with no date sorts last. */
const openedAt = (issue) => {
  const at = Date.parse(issue.openedAt ?? issue.openedOn ?? '')
  return Number.isFinite(at) ? at : Infinity
}

function nextWindowStart (limit, now) {
  const d = new Date(now)
  return new Date(limit.startsWith('monthly') ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString()
}

/** What stops every start, whichever issue it is for. */
function panelBlocks ({ state, spending, usage, now }) {
  const out = []
  const used = concurrentStarts(state), limits = state.limits ?? {}
  if (state.finishing) out.push({ kind: 'finishing', until: until('a new activation') })
  if (limits.maxRuns != null && (state.starts ?? 0) >= limits.maxRuns) out.push({ kind: 'session-starts', used: state.starts, limit: limits.maxRuns, until: until('an operator raises maxRuns on Start or begins a New session') })
  if (limits.maxConcurrent != null && used >= limits.maxConcurrent) out.push({ kind: 'concurrency', used, limit: limits.maxConcurrent, until: until('a live run settles') })
  if (spending?.active && usage) {
    // The smallest priced start: what stops any start, and not what only an unpriced one would be refused for.
    const verdict = admits({ policy: spending.policy, usage, subject: 'run-start', maxCostUsd: 0.000001, concurrent: used })
    if (!verdict.ok) {
      if (verdict.limit === 'concurrent') {
        if (!out.some((b) => b.kind === 'concurrency')) out.push({ kind: 'concurrency', used, limit: spending.policy.concurrent, until: until('a live run settles') })
      } else out.push({ kind: 'spending-window', limit: verdict.limit, until: until(verdict.until, nextWindowStart(verdict.limit, now)) })
    }
  }
  return out
}

async function rowOf (project, issue, { state, holders, reportLevels, lookup, moduleConflicts = {}, moduleWaits = {} }) {
  const key = keyOf(project, issue.id), latest = issue.latestRun ?? null, blocks = []
  const level = reportLevels[key] ?? 'any'
  if (issue.unreadableNewerRuns?.length) blocks.push({ kind: 'unreadable-run', runs: issue.unreadableNewerRuns, until: until('a person establishes what the unreadable run record holds') })
  // start_run's own test, with the listings standing in for the reads: an issue absent from them is
  // archived or deleted, and neither holds anything up.
  const waiting = await openDependencies(issue, { getIssue: async (p, id) => lookup.get(keyOf(p, id)) ?? null })
  if (waiting.length) blocks.push({ kind: 'dependency', on: waiting.map((d) => d.project === project ? d.id : keyOf(d.project, d.id)), until: until('each prerequisite gets a disposition or is archived') })
  if (latest?.ownerInput && !latest.ownerInput.answered) blocks.push({ kind: 'owner-input', runId: latest.runId, until: until('the owner answers on the issue page') })
  if (level === 'none') blocks.push({ kind: 'report-trust', until: until('an operator starts it from the panel') })
  if ((state.launches ?? []).some((a) => ['reserved', 'uncertain'].includes(a.status) && keyOf(a.project, a.issueId) === key)) blocks.push({ kind: 'launch-unresolved', until: until('an operator reconciles the launch') })
  // Keyed on launch inputs this does not read, so it may be out of date: start_run decides.
  for (const [guard, failed] of Object.entries(state.failedLaunches ?? {})) {
    const [p, id] = JSON.parse(guard)
    if (keyOf(p, id) === key) { blocks.push({ kind: 'failed-launch', reason: failed.reason, advisory: true, until: until('the launch inputs change, or an operator authorizes a retry') }); break }
  }
  const startsUsed = state.startsByIssue?.[key] ?? 0
  if (state.limits?.maxStartsPerIssue != null && startsUsed >= state.limits.maxStartsPerIssue) blocks.push({ kind: 'start-limit', used: startsUsed, limit: state.limits.maxStartsPerIssue, until: until('an operator raises maxStartsPerIssue on Start or begins a New session') })
  const holder = holders[project] ?? null
  if (holder && holder.issueId !== issue.id) blocks.push({ kind: 'checkout-held', issueId: holder.issueId, runId: holder.runId ?? null, until: until('that run settles') })

  // Modules its triage named that another live run of the pool holds (module-locks.mjs): the start
  // would be refused as occupied, so it waits, and the release wakes the supervisor (capacity-freed).
  const locked = moduleConflicts[key] ?? []
  if (!latest?.live && locked.length) blocks.push({ kind: 'module-lock', modules: [...new Set(locked.map((c) => c.module))], holders: locked.map(({ module, runId, project: p, issueId }) => ({ module, runId, project: p, issueId })), until: until('module-lock') })

  let rowState
  if (latest?.live) {
    rowState = 'running'
    blocks.unshift({ kind: 'own-run', runId: latest.runId, status: latest.status, until: until(latest.status === 'paused' ? 'its question is answered' : 'the run settles') })
    // A started run waiting for a module its revision needs: it takes it itself when freed.
    const wait = moduleWaits[key]
    if (wait) blocks.push({ kind: 'module-lock', waiting: true, runId: wait.runId, modules: wait.wants ?? [], holders: wait.holders ?? [], until: until('module-lock') })
  } else rowState = latest ? 'decide' : blocks.length ? 'blocked' : 'ready'

  return {
    project, id: issue.id, name: issue.name ?? null, priority: issue.priority?.value ?? issue.priority ?? null, state: rowState,
    ...(blocks.length ? { blockedBy: blocks } : {}),
    ...(latest ? { latestRun: { runId: latest.runId, status: latest.status, outcome: latest.outcome ?? null, result: latest.result ?? null, blockedReason: latest.blockedReason ?? null } } : {}),
    ...(level === 'assess' ? { allowedPlaybooks: ASSESS_PLAYBOOKS } : {})
  }
}

/** Decided order (focus, priority, oldest first), with a prerequisite in the queue always before what waits for it. */
function inDependencyOrder (members, focus) {
  const sorted = [...members].sort((a, b) =>
    (focus.includes(a.project) ? 0 : 1) - (focus.includes(b.project) ? 0 : 1) ||
    (PRIORITY_ORDER[a.issue.priority?.value ?? a.issue.priority] ?? 9) - (PRIORITY_ORDER[b.issue.priority?.value ?? b.issue.priority] ?? 9) ||
    openedAt(a.issue) - openedAt(b.issue) ||
    keyOf(a.project, a.issue.id).localeCompare(keyOf(b.project, b.issue.id)))
  const byKey = new Map(sorted.map((m) => [keyOf(m.project, m.issue.id), m]))
  const seen = new Set(), ordered = []
  const visit = (m) => {
    const key = keyOf(m.project, m.issue.id)
    if (seen.has(key)) return
    seen.add(key)
    for (const dep of m.issue.dependsOn?.issues ?? []) {
      const prerequisite = byKey.get(keyOf(dep.project, dep.id))
      if (prerequisite) visit(prerequisite)
    }
    ordered.push(m)
  }
  for (const m of sorted) visit(m)
  return ordered
}

/**
 * The whole queue: `rows` holds every member. What the session is shown is `shownQueue`'s; detection and `next`
 * work on all of them, so a display limit never hides an issue from a wake.
 *
 * @param issuesByProject  {project: rows}, as issues.listIssues lists them, for every project on the panel
 * @param holders          {project: {issueId, runId} | null}, supervisor.checkoutHolder: a live in-place run. Another issue's ordinary run blocks nothing.
 * @param reportLevels     {project/id: any | assess | none}, for the issues with a report
 * @param ownedIssues      project/id of issues with an open owned run: always in the queue, as in splitByCampaign
 * @param refused          {project/id: at}: starts refused as occupied, so an issue with an ended run was asked for
 * @param moduleConflicts  {project/id: [{module, runId, project, issueId}]}: modules its triage named another live run holds
 * @param moduleWaits      {project/id: wait record}: a live run waiting for a module its revision needs (module-locks.mjs)
 */
export async function buildReadyQueue ({ issuesByProject, holders = {}, reportLevels = {}, moduleConflicts = {}, moduleWaits = {}, state, spending = null, usage = null, ownedIssues = [], refused = {}, now = Date.now() }) {
  const campaign = state.campaign ?? null, focus = state.focus ?? []
  const lookup = new Map(), members = []
  const outside = { issues: 0, projects: [] }
  for (const [project, rows] of Object.entries(issuesByProject)) {
    for (const issue of rows) lookup.set(keyOf(project, issue.id), { project, ...issue })
    const open = rows.filter((i) => i.kind !== 'inquiry' && !settled(i) && (i.status ?? 'open') === 'open')
    const { outside: left, rest } = splitByCampaign({ type: 'issues-changed', project, issues: open }, { campaign, ownedIssues })
    if (left?.issues.length) { outside.issues += left.issues.length; outside.projects.push(project) }
    for (const issue of rest?.issues ?? []) members.push({ project, issue })
  }
  const rows = []
  for (const { project, issue } of inDependencyOrder(members, focus)) rows.push(await rowOf(project, issue, { state, holders, reportLevels, lookup, moduleConflicts, moduleWaits }))
  const because = panelBlocks({ state, spending, usage, now })
  const canStartNow = because.length === 0
  return {
    generatedAt: new Date(now).toISOString(),
    scope: campaign ? { campaign: { projects: campaign.projects ?? [], leaveReporters: campaign.leaveReporters ?? [] } } : { campaign: null, reading: 'no campaign is declared: the whole panel, ordered by focus' },
    canStartNow, because, concurrent: { used: concurrentStarts(state), limit: state.limits?.maxConcurrent ?? null },
    next: canStartNow ? rows.find((row) => eligible(row, refused)) ?? null : null,
    rows, outside,
    holders: Object.fromEntries(Object.entries(holders).filter(([, h]) => h))
  }
}

/** Offered as next: nothing in the way, and either no run on record or a re-run a refused start already asked for. */
function eligible (row, refused) {
  if (row.blockedBy?.length) return false
  return row.state === 'ready' || (row.state === 'decide' && Boolean(refused[keyOf(row.project, row.id)]))
}

/** The queue as a session keeps it: bounded rows and counts for the rest. `next` and the counts cover every member. */
export function shownQueue (queue) {
  const { rows, holders: _holders, ...rest } = queue
  const kept = new Set([...rows].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]).slice(0, DISPLAY_ROWS))
  const omitted = {}
  for (const row of rows) if (!kept.has(row)) omitted[row.state] = (omitted[row.state] ?? 0) + 1
  return {
    ...rest,
    rows: rows.filter((row) => kept.has(row)),
    ...(Object.keys(omitted).length ? { omitted } : {}),
    detail: 'An observation, not a guarantee: start_run re-checks everything. overview and list_issues show every issue, those outside the campaign and those omitted here included.'
  }
}

/** What identifies a reading: the time it was taken changes nothing. */
export const queueFingerprint = (shown) => JSON.stringify({ ...shown, generatedAt: null })

/** What a later reading is compared with: only what a wake can announce the end of. */
export function queueObservation (queue) {
  const rows = {}
  for (const row of queue.rows) {
    const kinds = (row.blockedBy ?? []).map((b) => b.kind).filter((k) => CAPACITY_BLOCKS.includes(k))
    if (kinds.length) rows[keyOf(row.project, row.id)] = kinds
  }
  return { rows, panel: queue.because.map((b) => b.kind).filter((k) => CAPACITY_PANEL.includes(k)), holders: queue.holders }
}

/**
 * What freed since `previous`: every issue that waited for capacity or a prerequisite and could start now,
 * and the next issue to offer. Null when nothing did, including when no earlier reading exists: a baseline is
 * not news.
 */
export function freedSince (previous, queue, { refused = {} } = {}) {
  if (!previous || !queue.canStartNow || !queue.next) return null
  const freed = new Map()
  const add = (project, reason, holder = null) => freed.set(`${project}:${reason}`, { project, reason, ...(holder ? { holder } : {}) })
  for (const row of queue.rows) {
    if (!eligible(row, refused)) continue
    const kinds = previous.rows[keyOf(row.project, row.id)] ?? []
    if (kinds.includes('checkout-held')) add(row.project, 'checkout-released', previous.holders?.[row.project] ?? null)
    if (kinds.includes('dependency')) add(row.project, 'dependency-settled')
    if (kinds.includes('module-lock')) add(row.project, 'module-lock-released')
    if (previous.panel.includes('concurrency')) add(row.project, 'concurrency-freed')
    if (previous.panel.includes('spending-window')) add(row.project, 'spending-window-rolled')
  }
  if (!freed.size) return null
  return { freed: [...freed.values()], next: queue.next }
}
