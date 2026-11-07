import { getIssue } from './issues.js'
import { openDependencies } from './issue-dependencies.mjs'
import { reportStartRefusal } from './reporters.mjs'

/*
 * What stops a start that no person chose, before any budget, ledger or run
 * admission is consulted: the supervisor's start_run (top-supervisor.mjs) and
 * an automatic start after a triage (auto-start.mjs) both ask here, so the two
 * checks exist once.
 *
 *   dependencies  — a prerequisite issue is unsettled (issue-dependencies.mjs).
 *   report-trust  — the issue came from a deployment's report whose trust does
 *                   not reach this playbook (reporters.mjs): an assess-only
 *                   report is never escalated to a writing playbook.
 *
 * An operator's own start from the panel is not asked: a person chose it.
 */
export async function startAdmission ({ issue, playbook }, { read = getIssue, reporters = null } = {}) {
  const waiting = await openDependencies(issue, { getIssue: read })
  if (waiting.length) {
    return {
      code: 'dependencies',
      waiting,
      message: `${issue.id} waits for ${waiting.map((d) => d.project === issue.project ? d.id : `${d.project}/${d.id}`).join(', ')}: start the prerequisite first, or clear the dependency with set_dependencies if it no longer holds`
    }
  }
  const refusal = await reportStartRefusal(issue, playbook, { reporters })
  if (refusal) return { code: 'report-trust', message: refusal }
  return null
}
