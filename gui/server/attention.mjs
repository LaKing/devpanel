/*
 * What is waiting on a person, across every project.
 *
 * Most of the time an issue spent "being resolved" was a run parked in a state
 * only a person could move — blocked on a budget, stranded by a restart, paused
 * on a question — with nothing pointing at it. This is that pointer: the newest
 * run of each open issue, when it is in such a state, with how long it has been
 * waiting. Read from the list summaries (cached by file version), so it costs
 * no more than the issue lists already do.
 */

// A pause a person or a full verification made is not a question (supportedActions resumes it directly).
const NOT_A_QUESTION = ['manual', 'full-verification']

const KIND = (issue, run) => {
  if (!run) return null
  // Recovery first, as supportedActions orders it: a paused run whose journal needs recovery cannot be answered.
  if (run.recoveryRequired) return 'recovery'
  if (run.status === 'paused') return run.pauseQuestion && !NOT_A_QUESTION.includes(run.pauseKind) ? 'question' : 'paused'
  if (run.ownerInput && !run.ownerInput.answered) return 'question'
  if (run.status === 'blocked') return 'blocked'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'completed' && run.outcome === 'resolved' && !issue.disposition) return 'disposition'
  return null
}

// A question or a stranded run holds work in progress; a missing disposition does not.
const ORDER = { question: 0, recovery: 1, blocked: 2, paused: 3, failed: 4, disposition: 5 }

/*
 * Which waiting event an item is, and when it began, from the run's own records (docs/operator-alerts.md):
 * a pause by its id, a triage's owner question by its run, a recovery by its occurrence. Only these and the
 * supervisor's questions alert; `enteredBasis: 'not-recorded'` means no stored time says when it began.
 */
function waitingEvent (kind, projectId, issueId, run) {
  const at = `${projectId}/${issueId}/${run.runId}`
  if (kind === 'recovery') return { key: `recovery:${at}/${run.recoveryDetectedAt ?? 'undated'}`, enteredAt: run.recoveryDetectedAt ?? null }
  if (kind === 'question' && run.status === 'paused') return { key: `pause:${at}/${run.pauseId ?? 'unknown'}`, enteredAt: run.pauseAt ?? null }
  if (kind === 'question') return { key: `owner-input:${at}`, enteredAt: run.ownerInputAt ?? null }
  return {}
}

export async function attentionList ({ listProjects, listIssues, now = Date.now(), unread = null, unreadRuns = null }) {
  const out = []
  for (const project of await listProjects()) {
    const projectId = project.id ?? project.name ?? project
    let issues = []
    try { issues = await listIssues(projectId) } catch { unread?.push(projectId); continue }
    for (const issue of issues) {
      // A run record that exists, started after the newest one read, and cannot be read: this issue's newest run may
      // be waiting on a person, so the reading is not complete (issues.js unreadableNewerRuns).
      for (const runId of issue.unreadableNewerRuns ?? []) unreadRuns?.push(`${projectId}/${issue.id}/${runId}`)
      // An inquiry's endings are the supervisor's to close (Phase 4), not a person's to-do.
      if (issue.kind === 'inquiry') continue
      if (issue.disposition) {
        // Decided; only an unfinished newest run still needs a person.
        if (!['paused', 'blocked'].includes(issue.latestRun?.status)) continue
      }
      const run = issue.latestRun
      const kind = KIND(issue, run)
      if (!kind) continue
      const since = run.updatedAt ?? run.endedAt ?? run.startedAt
      const event = waitingEvent(kind, projectId, issue.id, run)
      out.push({
        kind,
        ...(event.key ? { key: event.key, enteredAt: event.enteredAt, enteredBasis: event.enteredAt ? 'recorded' : 'not-recorded' } : {}),
        project: projectId,
        issueId: issue.id,
        issueName: issue.name,
        priority: issue.priority?.value ?? null,
        runId: run.runId,
        playbook: run.playbook,
        status: run.status,
        blockedReason: run.blockedReason,
        headline: run.explanation?.headline ?? null,
        detail: run.pauseQuestion ?? (run.ownerInput && !run.ownerInput.answered ? (run.ownerInput.verdict === 'too-large' ? `Too large for one run: ${run.ownerInput.parts} parts proposed` : run.ownerInput.questions.join(' · ')) : null) ?? run.explanation?.detail ?? run.recoveryReason ?? run.resultReason ?? null,
        since,
        waitingMs: since ? Math.max(0, now - Date.parse(since)) : null
      })
    }
  }
  return out.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || ((b.waitingMs ?? 0) - (a.waitingMs ?? 0)))
}

/**
 * Everything the Needs attention inbox lists: the top-level supervisor's open questions first (nothing else can
 * answer them), then attentionList. One reading for the inbox (/api/attention) and the notifier, so an alert is
 * derived from the same classification. `getTopSupervisor` is read at every call: the service is created after
 * the routes and the notifier. `unreadProjects` names projects whose issues could not be listed, `unreadRuns`
 * run records newer than an issue's latest that could not be read, and `questionsRead` whether the supervisor
 * answered: an item missing from an unread source is not handled, and the reading is not `complete`.
 */
export async function attentionItems ({ listProjects, listIssues, getTopSupervisor = () => null, now = Date.now() }) {
  let questions = []
  let questionsRead = true
  try {
    questions = (getTopSupervisor()?.questions() ?? []).map((q) => ({
      kind: 'supervisor-question', questionId: q.id, project: q.project ?? null, issueId: q.issueId ?? null,
      issueName: q.issueId ?? 'Supervisor', since: q.at, headline: q.question, options: q.options ?? null,
      key: `supervisor-question:${q.id}`, enteredAt: q.at ?? null, enteredBasis: q.at ? 'recorded' : 'not-recorded',
      // The consult panel's wording for a person and what it said, when the question went through it.
      ...(q.brief ? { brief: q.brief } : {}), ...(q.consult ? { consult: q.consult } : {})
    }))
  } catch { questionsRead = false }
  const unreadProjects = []
  const unreadRuns = []
  const listed = await attentionList({ listProjects, listIssues, now, unread: unreadProjects, unreadRuns })
  return { items: [...questions, ...listed], unreadProjects, unreadRuns, questionsRead, complete: !unreadProjects.length && !unreadRuns.length && questionsRead }
}
