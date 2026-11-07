import fs from 'node:fs/promises'
import { bundleFiles, packedRuns } from './issue-bundle.mjs'
import path from 'node:path'

import * as store from './runtime/store.mjs'
import { emptyMetricsTotals, absorbMetrics, reportMetrics } from './runtime/run-metrics.mjs'

/*
 * The panel, as one bounded reading.
 *
 * The management plane's job is oversight: which projects have open work, how
 * old it is, what order it is meant to be done in, and what past runs actually
 * did. Every one of those facts was already on disk and reachable only one issue
 * at a time, which is no way to see a portfolio — a supervisor that has to ask
 * per project ends up reasoning about whichever project it looked at first.
 *
 * What this is careful about, because each one is a way to be confidently wrong:
 *
 *  - A run's outcome is NOT the issue's state. `resolved` on a run means that
 *    run finished its closure checklist; whether the ISSUE is resolved is a
 *    separate, explicit disposition with evidence. Both are reported, never
 *    merged, and each rate is named for exactly what it counts.
 *  - A run still in flight has no outcome yet. Live and paused runs are counted,
 *    but they are kept out of every denominator: a rate that drops while work is
 *    healthy measures nothing but timing.
 *  - History includes archived issues. A "history of past runs" that skips the
 *    work already put away is not history, and archiving is exactly what happens
 *    to finished work.
 *  - Every rate carries its numerator and denominator. "100%" over one run is
 *    not a measurement, and a reader given only the percentage cannot tell.
 *  - Unknown stays unknown. Unpriced runs are counted as unpriced rather than
 *    folded into a total as zero.
 */

const LIVE = ['preflighting', 'pending', 'running', 'stopping']
const TERMINAL = ['completed', 'blocked', 'failed', 'cancelled']
const DAY = 86_400_000
const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 }

/** A run succeeded only on its own terms: it reached the end AND resolved. */
const succeeded = (run) => run.status === 'completed' && run.outcome === 'resolved'

/** A run whose true state is unknown — stopped without a verdict anyone can read. */
const interrupted = (run) => Boolean(run.recovery?.required) || run.blockedReason === 'recovery-required'

const rate = (of, total, means) => ({ of, total, percent: total ? Math.round((of / total) * 100) : null, means })

const tally = (into, key) => { if (key != null) into[key] = (into[key] ?? 0) + 1 }

/*
 * How a run's candidate reached its destination, if it did: `engine` when the
 * engine delivered it (a patch, a source application or a commit; an analysis
 * or an inquiry completes "delivery: none" with no revision and changes
 * nothing), `manual` when a person recorded landing it by hand (run.landed).
 * A run is one or the other: a patch the engine produced and a person then
 * landed counts as the landing, since that is what reached the source.
 */
function deliveryOf (run) {
  if (run.landed) return { kind: 'manual', at: run.landed.landedAt ?? run.landed.recordedAt ?? null }
  if (run.delivery?.completedAt && run.delivery.action && run.delivery.action !== 'none' && run.revisions?.length > 0) return { kind: 'engine', at: run.delivery.completedAt }
  return null
}

function emptyRuns () {
  return {
    total: 0, live: 0, paused: 0, terminal: 0, succeeded: 0,
    completedUnresolved: 0, failed: 0, blocked: 0, cancelled: 0, interrupted: 0,
    byStatus: {}, byOutcome: {},
    delivered: { engine: 0, manual: 0 },
    durationMs: { total: 0, counted: 0, unknown: 0 },
    cost: { usd: 0, priced: 0, unpriced: 0, tokens: 0 },
    metrics: emptyMetricsTotals()
  }
}

function absorb (into, run, { role = null } = {}) {
  into.total++
  tally(into.byStatus, run.status)
  tally(into.byOutcome, run.outcome)
  if (LIVE.includes(run.status)) { into.live++; return }
  if (run.status === 'paused') { into.paused++; return }
  if (!TERMINAL.includes(run.status)) return           // an unknown status is not quietly a failure
  into.terminal++
  if (succeeded(run)) into.succeeded++
  else if (run.status === 'completed') into.completedUnresolved++
  if (run.status === 'failed') into.failed++
  if (run.status === 'blocked') into.blocked++
  if (run.status === 'cancelled') into.cancelled++
  if (interrupted(run)) into.interrupted++
  const delivered = deliveryOf(run)
  if (delivered) into.delivered[delivered.kind]++

  const started = Date.parse(run.startedAt ?? '')
  const ended = Date.parse(run.endedAt ?? '')
  if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
    into.durationMs.total += ended - started
    into.durationMs.counted++
  } else into.durationMs.unknown++

  // How the run converged, measured the same way for every run of the group.
  // A seat group also gets that seat's own turns and time, kept apart from the
  // whole-run figures, which only say what runs the seat took part in.
  absorbMetrics(into.metrics, run, { role })

  const used = run.budgets?.used ?? {}
  if (typeof used.costUsd === 'number' && Number.isFinite(used.costUsd)) { into.cost.usd += used.costUsd; into.cost.priced++ }
  else into.cost.unpriced++
  if (typeof used.tokens === 'number' && Number.isFinite(used.tokens)) into.cost.tokens += used.tokens
}

/** The shape a reader gets: totals, and rates that always show their fraction. */
function report (runs) {
  return {
    ...runs,
    durationMs: { ...runs.durationMs, mean: runs.durationMs.counted ? Math.round(runs.durationMs.total / runs.durationMs.counted) : null },
    cost: { ...runs.cost, usd: Math.round(runs.cost.usd * 10000) / 10000 },
    metrics: reportMetrics(runs.metrics),
    successRate: rate(runs.succeeded, runs.terminal, 'runs that completed AND resolved, over runs that reached a terminal state; live and paused runs are excluded'),
    deliveryRate: { ...rate(runs.delivered.engine + runs.delivered.manual, runs.terminal, 'terminal runs whose candidate reached its destination, delivered by the engine or landed by hand (counted apart in engine and manual), over runs that reached a terminal state'), ...runs.delivered }
  }
}

/*
 * The configuration a run was actually cut from.
 *
 * `playbook.id` and its `version` are a name and a number a person has to
 * remember to raise; the snapshot's configHash changes whenever the YAML does.
 * Grouping statistics by the name alone lets an edit rewrite what the older runs
 * were runs OF. New runs carry the hash on the record; for older ones it is read
 * back from the snapshot, and a run whose configuration cannot be established is
 * grouped as unrecorded rather than merged into a group it may not belong to.
 */
async function configOf (issuePath, run) {
  if (run.playbook?.configHash) return run.playbook.configHash
  try {
    const snapshot = JSON.parse(await fs.readFile(path.join(store.runDir(issuePath, run.runId), 'resolved-playbook.json'), 'utf8'))
    return snapshot.configHash ?? snapshot.snapshotOf ?? null
  } catch { return null }
}

const shortHash = (hash) => hash ? `config ${String(hash).replace(/^sha256:/, '').slice(0, 12)}` : 'config unrecorded'

const parsedRuns = new Map()
// Shared between requests, so nothing downstream may change them.
function deepFreeze (value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** The run records a packed archived issue kept (issue-bundle.mjs), frozen like the others. */
export async function packedRunsOf (project, id) {
  const { ISSUES_DIR } = await import('./issues.js')
  // Parsed once per version of the file, as below: the overview and the staging report both read them.
  const file = bundleFiles(ISSUES_DIR, project, id).runs
  const stat = await fs.stat(file).catch(() => null)
  const cached = stat && parsedRuns.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.run
  const run = deepFreeze(await packedRuns(ISSUES_DIR, project, id))
  if (stat) {
    if (parsedRuns.size >= 2000) parsedRuns.delete(parsedRuns.keys().next().value)
    parsedRuns.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, run })
  }
  return run
}

/** Every run.json under an issue, read light: no outputs, no journal. */
export async function runsOf (issuePath) {
  let names = []
  try {
    names = (await fs.readdir(store.runsDir(issuePath), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
      .map((e) => e.name)
  } catch { return [] }
  const runs = []
  for (const runId of names) {
    const file = path.join(store.runDir(issuePath, runId), 'run.json')
    try {
      // Parsed once per version of the file: the overview reads every run on
      // the panel, and most of them have not changed since the last request.
      const stat = await fs.stat(file)
      const cached = parsedRuns.get(file)
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) { runs.push(cached.run); continue }
      const run = deepFreeze(JSON.parse(await fs.readFile(file, 'utf8')))
      if (parsedRuns.size >= 2000) parsedRuns.delete(parsedRuns.keys().next().value)
      parsedRuns.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, run })
      runs.push(run)
    } catch { /* a half-written or removed run is not evidence of anything */ }
  }
  return runs.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')))
}

/** The project's staging-pending list, as many of each kind as the open issues get, and how many more. */
async function pendingLine (read, project, limit, lists) {
  try {
    const report = await read(project, lists)
    return { ...report, pending: report.pending.slice(0, limit), indeterminate: report.indeterminate.slice(0, limit),
      truncated: { pending: Math.max(0, report.pending.length - limit), indeterminate: Math.max(0, report.indeterminate.length - limit) } }
  } catch (error) { return { error: error.message } }
}

/**
 * @param projects    every project on the panel — a management reading has no scope
 * @param focus       what the operator asked to be attended to first; ordering only
 * @param listIssues  (project, {archived}) => issues, as issues.js returns them
 */
export async function buildOverview ({ projects, focus = [], listIssues, openDependencies = null, readRuns = runsOf, readPackedRuns = packedRunsOf, now = Date.now(), openIssueLimit = 40, stagingPending = null }) {
  const out = []
  const totals = { projects: 0, openIssues: 0, archivedIssues: 0, unprioritised: 0 }
  const all = emptyRuns()
  const byPlaybook = {}
  const bySeat = {}
  const dispositions = {}
  const priorities = {}
  let decided = 0
  let resolvedIssues = 0

  for (const project of projects) {
    let open = []
    let archived = []
    try {
      ;[open, archived] = await Promise.all([listIssues(project), listIssues(project, { archived: true })])
    } catch { continue }
    totals.projects++
    const runs = emptyRuns()
    const lines = []
    const inquiries = []
    // The last seven days: what arrived, how what was settled was settled, and
    // what reached the source. A "resolved" run is not a fixed issue; this keeps
    // a guard, a partial resolution and an archived leftover apart.
    const since = now - 7 * DAY
    const within = (at) => Number.isFinite(Date.parse(at ?? '')) && Date.parse(at) >= since
    // deliveredIssues counts an issue once whichever way it was delivered;
    // `delivered` says how, so one issue may count under both.
    const flow = { opened: 0, settled: {}, deliveredIssues: 0, delivered: { engine: 0, manual: 0 } }
    const deliveredWithin = (history, kind) => history.some((run) => { const d = deliveryOf(run); return d && (!kind || d.kind === kind) && within(d.at) })

    for (const issue of [...open, ...archived]) {
      // A packed archived issue keeps its run records beside its bundle.
      const history = issue.packed ? await readPackedRuns(issue.project, issue.id) : await readRuns(issue.path)
      for (const run of history) {
        absorb(runs, run)
        absorb(all, run)
        // Grouped by what actually varies between runs of "the same" playbook:
        // its version and the intent it was briefed for. Two runs of one id with
        // different intents are not one population.
        const key = [run.playbook?.id ?? 'unknown', `v${run.playbook?.version ?? '?'}`, run.playbook?.intent ?? 'default', shortHash(await configOf(issue.path, run))].join(' · ')
        byPlaybook[key] ??= emptyRuns()
        absorb(byPlaybook[key], run)
        for (const [role, p] of Object.entries(run.participants ?? {})) {
          const seat = `${role} · ${p?.model ?? 'unknown'}`
          bySeat[seat] ??= emptyRuns()
          absorb(bySeat[seat], run, { role })
        }
      }

      // Inquiries (Phase 4) count in run accounting above and nowhere else:
      // they are questions, with no priority or disposition of their own.
      if (issue.kind === 'inquiry') {
        if (!issue.archived) {
          const latest = history.at(-1) ?? null
          inquiries.push({ id: issue.id, question: issue.inquiry?.question ?? issue.name ?? null, closure: issue.inquiry?.closure?.action ?? null,
            latestRun: latest ? { runId: latest.runId, status: latest.status, outcome: latest.outcome ?? null, blockedReason: latest.blockedReason ?? null } : null })
        }
        continue
      }
      const value = issue.disposition?.value ?? null
      tally(dispositions, value ?? 'undecided')
      if (within(issue.openedAt)) flow.opened++
      if (deliveredWithin(history)) flow.deliveredIssues++
      for (const kind of ['engine', 'manual']) if (deliveredWithin(history, kind)) flow.delivered[kind]++
      if (value && within(issue.disposition.at)) tally(flow.settled, value)
      if (value) decided++
      if (value === 'resolved') resolvedIssues++

      if (issue.archived) continue
      const priority = issue.priority?.value ?? null
      tally(priorities, priority ?? 'unset')
      if (!priority) totals.unprioritised++
      const openedAt = Date.parse(issue.openedAt ?? issue.openedOn ?? '')
      const latest = history.at(-1) ?? null
      lines.push({
        id: issue.id,
        name: issue.name ?? null,
        priority,
        priorityReason: issue.priority?.reason ?? null,
        priorityBy: issue.priority?.by ?? null,
        openedOn: issue.openedOn ?? null,
        // Age is what an overview is read for; a date is arithmetic the reader
        // then has to do, and does wrong.
        ageDays: Number.isFinite(openedAt) ? Math.floor((now - openedAt) / DAY) : null,
        status: issue.status ?? null,
        disposition: value,
        // Open prerequisites: start_run refuses this issue until they settle.
        waitingOn: issue.dependsOn && openDependencies ? (await openDependencies(issue)).map((d) => d.project === project ? d.id : `${d.project}/${d.id}`) : [],
        runs: history.length,
        live: history.some((r) => LIVE.includes(r.status) || r.status === 'paused'),
        latestRun: latest
          ? { runId: latest.runId, playbook: latest.playbook?.id ?? null, status: latest.status, outcome: latest.outcome ?? null, blockedReason: latest.blockedReason ?? null, endedAt: latest.endedAt ?? null }
          : null,
        // Every run of the issue that reached the source, so an umbrella issue
        // worked in batches shows each batch, however it was landed.
        delivered: history.flatMap((run) => {
          const d = deliveryOf(run)
          if (!d) return []
          return [d.kind === 'manual'
            ? { runId: run.runId, kind: 'manual', at: d.at, by: run.landed.by, commit: run.landed.commit ?? null, checkout: run.landed.checkout ?? null }
            : { runId: run.runId, kind: 'engine', at: d.at, action: run.delivery.action }]
        })
      })
    }

    // Decided order first, then the oldest of what nobody has ordered: an
    // unprioritised backlog is a management gap, and burying it under the
    // prioritised work is how it stays one.
    lines.sort((a, b) =>
      (a.waitingOn.length ? 1 : 0) - (b.waitingOn.length ? 1 : 0) ||
      (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9) ||
      (b.ageDays ?? -1) - (a.ageDays ?? -1))
    const openCount = open.filter((i) => i.kind !== 'inquiry').length
    const archivedCount = archived.filter((i) => i.kind !== 'inquiry').length
    totals.openIssues += openCount
    totals.archivedIssues += archivedCount

    out.push({
      project,
      focused: focus.includes(project),
      issues: { open: openCount, archived: archivedCount },
      runs: report(runs),
      flow7d: flow,
      openIssues: lines.slice(0, openIssueLimit),
      truncated: lines.length > openIssueLimit ? lines.length - openIssueLimit : 0,
      ...(inquiries.length ? { inquiries } : {}),
      ...(stagingPending ? { stagingPending: await pendingLine(stagingPending, project, openIssueLimit, { open, archived }) } : {})
    })
  }

  // Focused projects first, then the ones with the most open work: a focus
  // orders the reading, it never removes anything from it.
  out.sort((a, b) => (b.focused ? 1 : 0) - (a.focused ? 1 : 0) || b.issues.open - a.issues.open)

  const group = (map) => Object.fromEntries(Object.entries(map)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, value]) => [key, report(value)]))

  return {
    generatedAt: new Date(now).toISOString(),
    focus,
    totals: { ...totals, runs: report(all) },
    issues: {
      dispositions,
      priorities,
      resolutionRate: rate(resolvedIssues, decided, 'issues explicitly dispositioned "resolved", over issues given any disposition; issues nobody has decided are not counted either way')
    },
    byPlaybook: group(byPlaybook),
    bySeat: group(bySeat),
    projects: out,
    means: {
      counts: 'live and paused runs are counted but excluded from every rate; interrupted counts runs whose true state is unknown, and overlaps blocked',
      history: 'includes runs under archived issues, so this is the whole record and not only current work',
      byPlaybook: 'keyed by the exact configuration each run was cut from, so editing a playbook starts a new group rather than changing what older runs counted as',
      ageDays: 'whole days since the issue was opened',
      delivered: 'per open issue, every run whose candidate reached its destination: kind engine (the engine delivered it) or manual (a person recorded landing it by hand, with who and the commit or checkout); runs carry delivered.engine / delivered.manual and deliveryRate, counting each run once, as the landing when there is one',
      waitingOn: 'open prerequisites (set_dependencies); such an issue sorts after every ready one and start_run refuses it until they have a disposition or are archived',
      flow7d: 'last 7 days per project, counted in issues: opened, given each disposition, and with a candidate delivered (deliveredIssues; a patch, a source application or a commit, or a landing by hand a person recorded; analyses and inquiries deliver nothing), split in delivered.engine and delivered.manual (an issue with both kinds counts in each) — compare opened with settled before calling the backlog shrinking, and resolved with partially-resolved before calling it fixed',
      stagingPending: 'per project, runs delivered into the development checkout that no successful staging release (a Deployment run in the staging environment) has covered: pending (a new release would carry them) and indeterminate (their bytes are unknown, a release could not find them, or the checkout no longer holds them; a person reads these, and they prompt no batch). history counts deliveries from before the coverage baseline, which are neither listed nor noted. batch.ready is pending non-empty, nothing live, and a staging release target configured; whether to cut one is yours. A shared deployment (deploy_staging) clears nothing: only a staging release does',
      priority: 'execution order decided by a person or by you; "unset" means nobody has decided, which is not the same as low'
      ,metrics: 'per group of terminal runs: agent time, operator wait and suspended time kept apart; plan-review round executions beside cycle restarts and ignored restart requests; in bySeat the whole-run figures are a participation cohort and only `seat` is that seat\'s own effort; compare groups of the same configuration before changing seats or models'
    },
    detail: 'This is a summary. list_issues, get_issue and get_run return the detail behind any line of it.'
  }
}
