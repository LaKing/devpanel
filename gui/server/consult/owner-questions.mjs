import fs from 'node:fs/promises'
import path from 'node:path'

import * as store from '../runtime/store.mjs'
import { acquire } from '../runtime/lock.mjs'

/*
 * Triage questions go to the consult panel before the owner (docs/consult.md,
 * execution-contract.md "Asking the owner before any work starts").
 *
 * A run that ended `needs-owner-input` holds nothing, so this runs after its
 * end, from the run supervisor's end hook. When the panel answers every
 * question, the answers take the owner's own path (owner-input.mjs): recorded
 * on the run, written as a note on the issue, and the same configuration is
 * started again. Otherwise each question keeps what the panel said and its
 * plain wording for the owner, and the owner answers as before.
 *
 * Once per issue: a second `needs-owner-input` after a panel-answered one goes
 * to the owner, so a triage that keeps asking cannot loop on the panel. A
 * proposed split (`too-large`) is never consulted.
 *
 * Resumable: `ownerInput.consult.status` is `running` until the result is on
 * the run, and `resolved` is followed by the answer. A panel process that dies
 * in between leaves one of the two without an answer, and `resume()` (called at
 * the server's start) runs those again: the panel answers from its records, so
 * no question is put twice and the answer is given once (owner-input.mjs
 * refuses a second).
 */

export const PANEL_ACTOR = 'consult panel'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Change the run's ownerInput under the run lock; null when the owner answered meanwhile. The lock is busy only briefly (an owner's answer, a start), so it is waited for. */
async function update (issuePath, runId, change) {
  let lock = null
  for (let attempt = 0; !lock; attempt++) {
    try { lock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'owner-input-consult', runId }) } catch (error) {
      if (attempt >= 20) throw error
      await sleep(500)
    }
  }
  try {
    const run = await store.readRun(issuePath, runId)
    if (!run.ownerInput || run.ownerInput.answer) return null
    change(run)
    await store.writeRun(issuePath, runId, run)
    return run
  } finally { await lock.release() }
}

/** Has the panel already answered a triage of this issue? */
async function answeredBefore (issuePath, runId) {
  const ids = await fs.readdir(store.runsDir(issuePath)).catch(() => [])
  for (const id of ids) {
    if (id === runId) continue
    const run = await store.readRun(issuePath, id).catch(() => null)
    if (String(run?.ownerInput?.answer?.by ?? '').startsWith(PANEL_ACTOR)) return true
  }
  return false
}

/**
 * @param consult   the consult service (consult.mjs)
 * @param answer    owner-input's answer({ project, issueId, runId, actor, answers, note })
 * @param getIssue  (project, issueId) => issue
 */
export function createOwnerQuestionConsult ({ consult, answer, getIssue, emit = null, clock = { iso: () => new Date().toISOString() } }) {
  /** Runs this process is consulting now: a resume never doubles one. */
  const active = new Set()

  async function consultOwnerQuestions ({ project, issueId, runId }) {
    const id = `${project}/${issueId}/${runId}`
    if (active.has(id)) return null
    active.add(id)
    try { return await consultOnce({ project, issueId, runId }) } finally { active.delete(id) }
  }

  async function consultOnce ({ project, issueId, runId }) {
    const issue = await getIssue(project, issueId)
    if (issue.packed) return null
    const run = await store.readRun(issue.path, runId)
    const asked = run.ownerInput
    if (!asked || asked.answer || asked.verdict !== 'needs-owner-input' || !asked.questions?.length) return null
    // Settled without an answer for the panel to give: the owner's.
    if (asked.consult && !['running', 'resolved'].includes(asked.consult.status)) return null
    const panel = await consult.panel().catch(() => null)
    // A consult that was begun is finished from its records even if the panel was switched off since.
    if (!asked.consult && (!panel?.enabled || await answeredBefore(issue.path, runId))) return null

    if (!await update(issue.path, runId, (r) => { r.ownerInput.consult = { status: 'running', startedAt: r.ownerInput.consult?.startedAt ?? clock.iso() } })) return null
    emit?.({ type: 'owner-input-consulting', project, issueId, runId })
    const results = {}
    let failure = null
    try {
      // One question at a time: a triage asks at most five, and ten model turns at once is how a provider's rate limit is met.
      for (const q of asked.questions) {
        results[q.id] = await consult.consult({
          key: `owner-input:${q.id}`, mode: (panel?.alwaysHuman ?? ['authorization']).includes(q.category) ? 'brief' : 'decide',
          question: q.question, reason: asked.reason ?? null, recommendation: q.recommendation ?? null, category: q.category ?? null,
          askedBy: { role: 'triage', ...(asked.askedBy ?? {}) }, project, issueDir: issue.path, worktree: null
        }, { callerDir: store.runDir(issue.path, runId) })
      }
    } catch (error) { failure = String(error.message ?? error).slice(0, 400) }

    const all = asked.questions.every((q) => results[q.id]?.outcome === 'resolved')
    const summary = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { id: r.id, outcome: r.outcome, reason: r.reason ?? null }]))
    const written = await update(issue.path, runId, (r) => {
      r.ownerInput.consult = { status: failure ? 'failed' : all ? 'resolved' : 'escalated', startedAt: r.ownerInput.consult?.startedAt ?? null, endedAt: clock.iso(), questions: summary, ...(failure ? { error: failure } : {}) }
      // What the owner is shown beside each question the panel did not settle.
      r.ownerInput.questions = r.ownerInput.questions.map((q) => {
        const result = results[q.id]
        if (!result || result.outcome === 'resolved') return q
        return { ...q, consult: { id: result.id, outcome: result.outcome, reason: result.reason ?? null, positions: result.brief?.positions ?? [] }, ...(result.brief ? { brief: result.brief } : {}) }
      })
    })
    // Answered by the owner while the panel worked: theirs stands.
    if (!written) return null
    emit?.({ type: 'owner-input-consulted', project, issueId, runId, outcome: written.ownerInput.consult.status })
    if (!all || failure) return { outcome: written.ownerInput.consult.status, results }

    const seats = results[asked.questions[0].id].opinions.filter((o, i, list) => list.findLast((x) => x.seat === o.seat) === o)
    const actor = `${PANEL_ACTOR} (${seats.map((o) => `${o.model}${o.effort ? `@${o.effort}` : ''}`).join(' + ')})`
    const answered = await answer({
      project, issueId, runId, actor,
      answers: Object.fromEntries(asked.questions.map((q) => [q.id, results[q.id].answerText])),
      note: `Both consultants of the consult panel chose each of these answers independently, before the owner was asked (consults ${asked.questions.map((q) => results[q.id].id).join(', ')}, under runs/${runId}/consults/). The owner may overrule them with a note on the issue.`
    })
    return { outcome: 'resolved', results, answered }
  }

  /**
   * Consults a restart cut short, found among the runs that ended in the last
   * `days`: only the newest run of an issue can hold open owner questions.
   */
  consultOwnerQuestions.resume = async function resume ({ issuesDir, days = 3 } = {}) {
    const since = Date.now() - days * 86_400_000
    const resumed = []
    for (const project of await fs.readdir(issuesDir, { withFileTypes: true }).catch(() => [])) {
      if (!project.isDirectory() || project.name.startsWith('.')) continue
      for (const issue of await fs.readdir(path.join(issuesDir, project.name), { withFileTypes: true }).catch(() => [])) {
        if (!issue.isDirectory() || issue.name.startsWith('.')) continue
        const issuePath = path.join(issuesDir, project.name, issue.name)
        const runId = (await fs.readdir(store.runsDir(issuePath)).catch(() => [])).sort().at(-1)
        if (!runId) continue
        const file = path.join(store.runDir(issuePath, runId), 'run.json')
        if (((await fs.stat(file).catch(() => null))?.mtimeMs ?? 0) < since) continue
        const run = await store.readRun(issuePath, runId).catch(() => null)
        if (!run?.ownerInput || run.ownerInput.answer || !['running', 'resolved'].includes(run.ownerInput.consult?.status)) continue
        resumed.push({ project: project.name, issueId: issue.name, runId })
      }
    }
    for (const r of resumed) consultOwnerQuestions(r).catch((error) => console.warn(`[devpanel] consult of ${r.project}/${r.issueId} run ${r.runId} could not be resumed: ${error.message}`))
    return resumed
  }
  return consultOwnerQuestions
}
