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
 * Never filtered, whatever the provider would say: the operator's messages, the
 * results of the supervisor's own actions and its format repairs, runs that
 * failed, blocked, paused (an operator request or question) or were cancelled,
 * a run that ended unresolved (budgets, disagreement), a run whose delivery was
 * decided (`changed` names more than its status), and model substitutions after
 * a quota failure.
 */

export const WAKE_PURPOSE = 'wake-filter'
export const DEFAULT_MAX_DEFER_MS = 15 * 60_000
const MAX_MISSION_CHARS = 2000
const MAX_ISSUES = 40

const ALWAYS = ['user', 'tool-result', 'protocol-repair', 'model-substituted', 'deferred-events']
const ATTENTION_STATUSES = ['failed', 'blocked', 'paused', 'cancelled']

export function alwaysWakes (event) {
  if (ALWAYS.includes(event?.type)) return true
  if (event?.type === 'run-changed') {
    const run = event.run ?? {}
    if (event.changed?.some((c) => c !== 'status')) return true
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
      issues: issues.slice(0, MAX_ISSUES).map((i) => ({ id: i.id, name: i.name, status: i.status, priority: i.priority?.value ?? null, latestRun: i.latestRun ? { playbook: i.latestRun.playbook, status: i.latestRun.status } : null }))
    }
  }
  return { type: event.type }
}

export const WAKE_QUESTIONS = {
  wake: {
    type: 'choice',
    instructions: 'A supervisor manages software work items and the automated runs that work on them, following the mission it was given. A monitoring event has arrived. Should the supervisor be woken to consider it now?',
    criteria: {
      wake: 'Yes: the event finishes or unblocks work the mission is waiting on, adds or changes work the mission covers, or otherwise changes what the supervisor should do next.',
      defer: 'No: routine progress that changes nothing the supervisor must decide now; it can be read later together with the next important event.'
    }
  }
}

/**
 * @param advisor     decisions/advisor.mjs
 * @param dir         where the supervisor's decisions are recorded
 * @returns route(event, { mission }) => { wake, key?, reason }
 */
export function createWakeFilter ({ advisor, dir, deadlineMs = 10000 }) {
  return {
    async route (event, { mission = null } = {}) {
      if (alwaysWakes(event)) return { wake: true, reason: 'always-wakes' }
      const summary = summariseEvent(event)
      const record = await advisor.ask({
        dir,
        purpose: WAKE_PURPOSE,
        subject: summary.type === 'run-changed' ? { runId: summary.run.runId } : { project: summary.project ?? null },
        state: { mission: mission ? String(mission).slice(0, MAX_MISSION_CHARS) : null, event: summary },
        questions: WAKE_QUESTIONS,
        signal: AbortSignal.timeout(deadlineMs)
      })
      if (record.skipped) return { wake: true, reason: `provider ${record.skipped}` }
      const answer = confidentAnswer(record, 'wake')
      if (answer?.value === 'defer') return { wake: false, key: record.key, summary, reason: `deferred at confidence ${answer.confidence.toFixed(2)}` }
      return { wake: true, key: record.key, reason: record.status === 'answered' ? 'not confidently routine' : `provider ${record.failure?.class ?? 'unavailable'}` }
    }
  }
}
