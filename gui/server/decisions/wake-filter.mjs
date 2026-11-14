import { confidentAnswer } from './index.mjs'

/*
 * Which monitoring events wake the top-level supervisor (rollout step 4 of
 * docs/decisions.md).
 *
 * Every event the monitor queues costs one supervisor model call. Most are
 * routine: a run moved from preflighting to running, an issue list changed. The
 * decision provider is asked whether such an event needs the supervisor now;
 * a confident "defer" holds it, and held events are handed to the supervisor
 * with the next event that does wake it, or once the oldest has waited
 * `maxDeferMs`. Nothing is dropped.
 *
 * An issue-list change outside the supervisor's campaign has no such limit, since
 * waking it only to pass the change on is the call this filter exists to save. Only
 * two things establish that it is outside: the scope an operator declared
 * (`state.campaign`, `splitByCampaign`), or a confident `outside` from the provider.
 * Focus is an ordering and holds nothing, and the mission's text is never parsed. A
 * filter that cannot establish membership wakes. Such events are merged per project
 * (`holdOutside`), so what is held stays bounded, and arrive with the next wake.
 *
 * Never filtered, whatever the provider would say: the operator's messages, the
 * results of the supervisor's own actions and its format repairs, runs that
 * failed, blocked, paused (an operator request or question) or were cancelled,
 * a run that ended unresolved (budgets, disagreement), a run whose delivery was
 * decided (`changed` names a delivery key), model substitutions after a quota
 * failure, capacity freeing for an issue that waited (`capacity-freed`), and the end of a
 * full verification cycle (`verification-ended`).
 *
 * A live run's progress (phase, checks verdict, a status between live statuses) is
 * never put to the provider and does not wake: monitoring merges it per run
 * (`holdProgress`) and it rides with the next wake, with no timer of its own.
 */

export const WAKE_PURPOSE = 'wake-filter'
export const DEFAULT_MAX_DEFER_MS = 15 * 60_000
const MAX_MISSION_CHARS = 8000
const MAX_ISSUES = 40

// verification-ended: a full verification cycle ended (full-verification.mjs), with its outcome and evidence.
const ALWAYS = ['user', 'tool-result', 'protocol-repair', 'model-substituted', 'deferred-events', 'capacity-freed', 'verification-ended']
// What a run-changed may name without being about its delivery.
const PROGRESS_KEYS = ['status', 'phase', 'checks', 'blockedReason']
const ATTENTION_STATUSES = ['failed', 'blocked', 'paused', 'cancelled']
const MAX_CAMPAIGN_ENTRIES = 50
const MAX_CAMPAIGN_ENTRY_CHARS = 120

export function alwaysWakes (event) {
  if (ALWAYS.includes(event?.type)) return true
  if (event?.type === 'run-changed') {
    const run = event.run ?? {}
    if (event.changed?.some((c) => !PROGRESS_KEYS.includes(c))) return true
    if (ATTENTION_STATUSES.includes(run.status)) return true
    if (run.pause || run.failure || run.pauseRequested) return true
    if (run.status === 'completed' && run.outcome !== 'resolved') return true
    return false
  }
  if (event?.type === 'issues-changed') return false
  // An event type this filter does not know is not one it may hold.
  return true
}

/** What is said about an event: small, and enough for the supervisor to find the detail later. */
export function summariseEvent (event) {
  if (event.type === 'run-changed') {
    const r = event.run ?? {}
    return {
      type: 'run-changed',
      changed: event.changed ?? ['status'],
      run: {
        runId: r.runId ?? null,
        project: r.issue?.project ?? null,
        issueId: r.issue?.id ?? null,
        playbook: r.playbook?.id ?? null,
        status: r.status ?? null,
        outcome: r.outcome ?? null
      }
    }
  }
  if (event.type === 'issues-changed') {
    const issues = Array.isArray(event.issues) ? event.issues : []
    return {
      type: 'issues-changed',
      project: event.project ?? null,
      openIssues: event.total ?? issues.length,
      ...(event.removed ? { removed: event.removed } : {}),
      ...(issues.length > MAX_ISSUES ? { omitted: issues.length - MAX_ISSUES } : {}),
      issues: issues.slice(0, MAX_ISSUES).map((i) => ({ id: i.id, name: i.name, status: i.status, priority: i.priority?.value ?? null, latestRun: i.latestRun ? { playbook: i.latestRun.playbook, status: i.latestRun.status } : null, ...(i.change ? { change: i.change } : {}), ...(i.report ? { report: i.report } : {}) }))
    }
  }
  return { type: event.type }
}

/** An operator's declared scope, checked: null when it declares nothing. Throws with status 400. */
export function normaliseCampaign (input) {
  if (input === null || input === undefined) return null
  const refuse = (message) => { throw Object.assign(new Error(message), { status: 400 }) }
  if (typeof input !== 'object' || Array.isArray(input)) refuse('A campaign is {projects, leaveReporters}, or null to clear it')
  const unknown = Object.keys(input).filter((k) => !['projects', 'leaveReporters'].includes(k))
  if (unknown.length) refuse(`Unknown campaign field: ${unknown.join(', ')}`)
  const list = (key) => {
    const value = input[key] ?? []
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim() || v.length > MAX_CAMPAIGN_ENTRY_CHARS)) refuse(`Campaign ${key} must be a list of names of up to ${MAX_CAMPAIGN_ENTRY_CHARS} characters`)
    if (value.length > MAX_CAMPAIGN_ENTRIES) refuse(`Campaign ${key} holds at most ${MAX_CAMPAIGN_ENTRIES} names`)
    return [...new Set(value.map((v) => v.trim()))]
  }
  const projects = list('projects'), leaveReporters = list('leaveReporters')
  return projects.length || leaveReporters.length ? { projects, leaveReporters } : null
}

/**
 * The part of an issue-list change the declared campaign establishes is outside,
 * and the rest. A row is outside when its project is not among a non-empty
 * `projects`, or its reporter is among `leaveReporters`; a row with an open run the
 * supervisor owns is its own business and never is. A removed id has no report to
 * read, so only the project test can place it. Anything else, every other event
 * type and no campaign at all, is `rest`: not established as outside.
 */
export function splitByCampaign (event, { campaign = null, ownedIssues = [] } = {}) {
  if (event?.type !== 'issues-changed' || !campaign) return { outside: null, rest: event }
  const projectOut = campaign.projects?.length > 0 && !campaign.projects.includes(event.project)
  const reporters = campaign.leaveReporters ?? []
  const owned = (i) => ownedIssues.includes(`${event.project}/${i.id}`)
  const rows = Array.isArray(event.issues) ? event.issues : []
  const isOut = (i) => !owned(i) && (projectOut || reporters.includes(i.report?.reporter))
  const outRows = rows.filter(isOut), restRows = rows.filter((i) => !isOut(i))
  const removed = event.removed ?? []
  const part = (issues, gone) => {
    if (!issues.length && !gone.length) return null
    const { removed: _removed, ...base } = event
    return { ...base, issues, ...(gone.length ? { removed: gone } : {}) }
  }
  return { outside: part(outRows, projectOut ? removed : []), rest: part(restRows, projectOut ? [] : removed) }
}

/** Hold an outside change, merged into its project's entry: the newest row per issue wins, and past the caps rows are counted, not kept. */
export function holdOutside (deferred, { at, summary, decision = null, reason }) {
  const held = deferred.find((d) => d.outside && d.event?.project === summary.project)
  const gone = new Set(summary.removed ?? [])
  const rows = new Map()
  for (const row of held?.event.issues ?? []) if (!gone.has(row.id)) rows.set(row.id, row)
  for (const row of summary.issues ?? []) { rows.delete(row.id); rows.set(row.id, row) }
  const removed = [...new Set([...(held?.event.removed ?? []), ...gone])].filter((id) => !rows.has(id))
  const kept = [...rows.values()].slice(-MAX_ISSUES), keptRemoved = removed.slice(-MAX_ISSUES)
  const omitted = (held?.event.omitted ?? 0) + (summary.omitted ?? 0) + (rows.size - kept.length) + (removed.length - keptRemoved.length)
  const { removed: _removed, omitted: _omitted, ...rest } = summary
  const event = { ...rest, issues: kept, ...(keptRemoved.length ? { removed: keptRemoved } : {}), ...(omitted ? { omitted, detail: `More changed than is kept here; list_issues {project:"${summary.project}"} lists them all.` } : {}) }
  const entry = { at: held?.at ?? at, lastAt: at, outside: true, changes: (held?.changes ?? 0) + 1, event, decision, reason }
  if (held) deferred[deferred.indexOf(held)] = entry
  else deferred.push(entry)
}

/** Hold a live run's progress, merged into that run's entry: the newest delta wins, keeping the earliest `from` of each field. */
export function holdProgress (deferred, { at, run, changed }) {
  const held = deferred.find((d) => d.progress && d.event?.run?.runId === run.runId)
  const from = { ...(run.from ?? {}), ...(held?.event.run.from ?? {}) }
  const { from: _from, ...rest } = run
  const entry = { at: held?.at ?? at, lastAt: at, progress: true, changes: (held?.changes ?? 0) + 1,
    event: { type: 'run-changed', changed: [...new Set([...(held?.event.changed ?? []), ...changed])], run: { ...rest, ...(Object.keys(from).length ? { from } : {}) } } }
  if (held) deferred[deferred.indexOf(held)] = entry
  else deferred.push(entry)
}

export const WAKE_QUESTIONS = {
  wake: {
    type: 'choice',
    instructions: 'A supervisor manages software work items and the automated runs that work on them, following the mission it was given. A monitoring event has arrived. Should the supervisor be woken to consider it now?',
    criteria: {
      wake: 'Yes: the event finishes or unblocks work the mission is waiting on, adds or changes work the mission covers, or otherwise changes what the supervisor should do next.',
      defer: 'No: routine progress that changes nothing the supervisor must decide now; it can be read later together with the next important event.',
      outside: 'No: the changed issues are outside the focus and the mission, or the mission leaves them to someone else. Only for an issue-list change, and only when the mission makes this clear.'
    }
  }
}

/**
 * @param advisor     decisions/advisor.mjs
 * @param dir         where the supervisor's decisions are recorded
 * @returns route(event, { mission, focus }) => { wake, outside?, key?, reason }
 */
export function createWakeFilter ({ advisor, dir, deadlineMs = 10000 }) {
  return {
    async route (event, { mission = null, focus = [] } = {}) {
      if (alwaysWakes(event)) return { wake: true, reason: 'always-wakes' }
      const summary = summariseEvent(event)
      const record = await advisor.ask({
        dir,
        purpose: WAKE_PURPOSE,
        subject: summary.type === 'run-changed' ? { runId: summary.run.runId } : { project: summary.project ?? null },
        state: { mission: mission ? String(mission).slice(0, MAX_MISSION_CHARS) : null, focus, event: summary },
        questions: WAKE_QUESTIONS,
        signal: AbortSignal.timeout(deadlineMs)
      })
      if (record.skipped) return { wake: true, reason: `provider ${record.skipped}` }
      const answer = confidentAnswer(record, 'wake')
      if (answer?.value === 'outside' && event.type === 'issues-changed') return { wake: false, outside: true, key: record.key, summary, reason: `outside the campaign at confidence ${answer.confidence.toFixed(2)}` }
      if (answer?.value === 'defer' || answer?.value === 'outside') return { wake: false, key: record.key, summary, reason: `deferred at confidence ${answer.confidence.toFixed(2)}` }
      return { wake: true, key: record.key, reason: record.status === 'answered' ? 'not confidently routine' : `provider ${record.failure?.class ?? 'unavailable'}` }
    }
  }
}
