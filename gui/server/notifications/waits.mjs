/*
 * When each item waiting on a person entered that state and when it was handled, read from the timestamps the
 * run already records (docs/operator-alerts.md "Time to response"). Pure: no clock, no I/O. A row whose time
 * no record holds says so (`enteredBasis` / `handledBasis: 'not-recorded'`) and is counted, never guessed;
 * a wait still open is `handledBasis: 'pending'`.
 *
 * Keys are the notifier's (attention.mjs waitingEvent), so a row can be joined to the alerts that named it.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { pauseIdOf } from '../runtime/store.mjs'

const NOT_A_QUESTION = ['manual', 'full-verification']
const ENDED = ['completed', 'failed', 'cancelled']
const recorded = (at) => (at ? 'recorded' : 'not-recorded')

export function runWaits (run, { project, issueId }) {
  const at = `${project}/${issueId}/${run.runId}`
  const rows = []
  // Pauses: a person's answer is a decision step; the panel's own and the consult panel's answers are not a person's wait.
  const answered = new Set()
  for (const step of run.steps ?? []) {
    const d = step.decision
    if (!d?.pauseId || step.role !== 'operator') continue
    answered.add(d.pauseId)
    if (d.actor === 'engine' || d.consult) continue
    rows.push({ key: `pause:${at}/${d.pauseId}`, kind: 'question', enteredAt: d.askedAt ?? null, enteredBasis: recorded(d.askedAt), handledAt: d.at ?? null, handledBasis: recorded(d.at), by: d.actor ?? null, how: 'answered' })
  }
  // A question no decision answered: still open while the run is paused; ended by an abandonment, or by the run
  // ending, which the record dates. Its id is the one every reader derives for an older pause without one.
  const pauseId = pauseIdOf(run.runId, run.pause)
  if (pauseId && !answered.has(pauseId) && !NOT_A_QUESTION.includes(run.pause.kind)) {
    const row = { key: `pause:${at}/${pauseId}`, kind: 'question', enteredAt: run.pause.at ?? null, enteredBasis: recorded(run.pause.at) }
    if (run.status === 'paused') rows.push({ ...row, handledAt: null, handledBasis: 'pending', by: null, how: null })
    else if (run.abandonment) rows.push({ ...row, handledAt: run.abandonment.at ?? null, handledBasis: recorded(run.abandonment.at), by: run.abandonment.by ?? null, how: 'abandoned' })
    else if (ENDED.includes(run.status)) rows.push({ ...row, handledAt: run.endedAt ?? null, handledBasis: recorded(run.endedAt), by: null, how: 'run-ended' })
  }
  // A triage's questions to the owner before work started.
  if (run.ownerInput?.at) {
    const answer = run.ownerInput.answer
    rows.push({ key: `owner-input:${at}`, kind: 'question', enteredAt: run.ownerInput.at, enteredBasis: 'recorded', handledAt: answer?.at ?? null, handledBasis: answer ? recorded(answer.at) : 'pending', by: answer?.by ?? null, how: answer ? 'answered' : null })
  }
  // Recoveries: exact intervals since run.recoveries[] exists, then the open one, then what older records held.
  const ended = new Set()
  for (const r of run.recoveries ?? []) {
    ended.add(r.resolvedAt)
    rows.push({ key: `recovery:${at}/${r.occurrence ?? 'undated'}`, kind: 'recovery', enteredAt: r.occurrence ?? null, enteredBasis: recorded(r.occurrence), handledAt: r.resolvedAt ?? null, handledBasis: recorded(r.resolvedAt), by: r.by ?? null, how: r.how ?? null })
  }
  if (run.recovery?.required || run.blockedReason === 'recovery-required') {
    const occurrence = run.recovery?.continuesFrom ?? run.recovery?.detectedAt ?? null
    rows.push({ key: `recovery:${at}/${occurrence ?? 'undated'}`, kind: 'recovery', enteredAt: occurrence, enteredBasis: recorded(occurrence), handledAt: null, handledBasis: 'pending', by: null, how: null })
  }
  const legacy = (enteredAt, handledAt, how, by = null) => {
    if (!handledAt || ended.has(handledAt)) return
    ended.add(handledAt)
    rows.push({ key: `recovery:${at}/${enteredAt ?? 'undated'}`, kind: 'recovery', enteredAt: enteredAt ?? null, enteredBasis: recorded(enteredAt), handledAt, handledBasis: 'recorded', by, how, legacy: true })
  }
  for (const o of run.ownerRecoveries ?? []) legacy(o.detectedAt, o.recoveredAt, 'recovered')
  for (const d of run.integrity?.dispositions ?? []) {
    // A disposition recorded since run.recoveries exists carries recoveryDetectedAt: its end (or its continuation) is there.
    if ('recoveryDetectedAt' in d) continue
    // The quarantine began when its recovery was detected; an older record that excused the wait says how long.
    // An operator amendment's quarantine is dated by its own record (integrity.latest, written with the recovery).
    const latest = run.integrity?.latest
    const amendment = latest?.role === 'operator' && latest.invocationId === d.invocationId ? latest.at ?? null : null
    const entered = (Number.isFinite(d.suspendedMs) && d.at ? new Date(Date.parse(d.at) - d.suspendedMs).toISOString() : amendment)
    legacy(entered, d.at, `integrity-${d.disposition}`, d.actor ?? null)
  }
  if (run.abandonment?.recovery?.required) legacy(run.abandonment.recovery.detectedAt, run.abandonment.at, 'abandoned', run.abandonment.by ?? null)
  // A journal-only recovery that was abandoned: dated by its finding, kept on the abandonment record.
  else if (run.abandonment?.journal?.recoveryRequired) legacy(run.abandonment.journal.finding?.detectedAt, run.abandonment.at, 'abandoned', run.abandonment.by ?? null)
  // A journal-only recovery an operator retired (legacy-journal.mjs): from its finding to the retirement.
  if (run.journal?.retired && run.journal.disposition?.at) legacy(run.journal.finding?.detectedAt, run.journal.disposition.at, 'retired', null)
  return rows
}

/** A supervisor question as a wait row: answered, still open, or retired with a session that ended. */
export function questionWait (q, { retiredAt = null } = {}) {
  return { key: `supervisor-question:${q.id}`, kind: 'supervisor-question', enteredAt: q.at ?? null, enteredBasis: recorded(q.at),
    handledAt: q.answer?.at ?? retiredAt ?? null, handledBasis: q.answer ? recorded(q.answer.at) : retiredAt ? 'recorded' : 'pending',
    by: q.answer?.actor ?? null, how: q.answer ? 'answered' : retiredAt ? 'retired' : null }
}

/**
 * Every question the top-level supervisor asked, open, answered or left with a session that ended: its state and
 * each archived state (`state.<time>.json`, top-level-supervisor reset). An unanswered question found only in an
 * archive was retired when that archive was written. The one reader here that touches the disk.
 */
export async function supervisorQuestionHistory (dir) {
  const byId = new Map()
  let names = []
  try { names = await fs.readdir(dir) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const archives = names.filter((n) => /^state\..+\.json$/.test(n)).sort()
  for (const name of [...archives, 'state.json']) {
    let state
    try { state = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) } catch { continue }
    const stamp = name.match(/^state\.(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.json$/)
    const archivedAt = stamp ? `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z` : null
    for (const q of state.questions ?? []) {
      const known = byId.get(q.id)
      if (known?.q.answer) continue
      byId.set(q.id, { q, retiredAt: q.answer || !archivedAt ? null : archivedAt })
    }
  }
  return [...byId.values()]
}

const median = (values) => {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

/** Medians before and after installation and by whether an alert went out; open and unrecorded waits counted apart. */
export function summariseWaits (rows, { installedAt = null } = {}) {
  const measured = rows.filter((r) => r.enteredBasis === 'recorded' && r.handledBasis === 'recorded')
  const ms = (r) => Date.parse(r.handledAt) - Date.parse(r.enteredAt)
  const group = (list) => ({ count: list.length, medianMs: median(list.map(ms)) })
  const after = installedAt ? measured.filter((r) => r.enteredAt >= installedAt) : []
  return {
    installedAt,
    total: rows.length,
    measured: measured.length,
    pending: rows.filter((r) => r.handledBasis === 'pending').length,
    notRecorded: rows.filter((r) => r.enteredBasis === 'not-recorded' || r.handledBasis === 'not-recorded').length,
    before: group(installedAt ? measured.filter((r) => r.enteredAt < installedAt) : measured),
    after: group(after),
    alerted: group(after.filter((r) => r.alerted)),
    notAlerted: group(after.filter((r) => !r.alerted))
  }
}

/**
 * Every wait in the issue store that began within [from, to] (ISO), open and archived issues alike, the
 * supervisor's questions of the current session, joined to the alerts accepted for each key. Read-only.
 */
export async function collectWaits ({ listProjects, listIssues, readRunRecords, questions = [], alerted = new Map(), installedAt = null, from = null, to = null, project = null }) {
  const rows = []
  // A run record that cannot be read is named here, once, and its readable siblings keep their rows.
  const unreadableRuns = []
  for (const p of await listProjects()) {
    const projectId = p.id ?? p
    if (project && projectId !== project) continue
    // A listing that fails is named too, never an empty project.
    const listed = (options) => listIssues(projectId, options).catch((error) => {
      unreadableRuns.push({ project: projectId, issueId: null, runId: null, reason: `issues could not be listed (${error.code ?? error.message})` })
      return []
    })
    const issues = [...await listed(), ...await listed({ archived: true })]
    const ids = new Set()
    for (const issue of issues) {
      if (ids.has(issue.id) || issue.kind === 'inquiry') continue
      ids.add(issue.id)
      const unreadable = []
      const runs = await readRunRecords(projectId, issue.id, { unreadable }).catch((error) => {
        unreadable.push({ runId: null, reason: error.code ?? error.message })
        return []
      })
      for (const u of unreadable) unreadableRuns.push({ project: projectId, issueId: issue.id, runId: u.runId, reason: u.reason })
      // The listing already found these records unreadable (read or summarised, issues.js runSummaries): one marker
      // each, and no rows from them.
      const named = new Set(unreadable.map((u) => u.runId))
      const listedUnreadable = new Set(issue.unreadableRuns ?? [])
      for (const runId of listedUnreadable) {
        if (!named.has(runId)) unreadableRuns.push({ project: projectId, issueId: issue.id, runId, reason: 'run record cannot be summarised' })
      }
      for (const run of runs) {
        if (listedUnreadable.has(run?.runId)) continue
        // A record that parses but holds fields of the wrong shape is unreadable too: one marker, its siblings kept.
        try { rows.push(...runWaits(run, { project: projectId, issueId: issue.id })) } catch (error) {
          unreadableRuns.push({ project: projectId, issueId: issue.id, runId: run?.runId ?? null, reason: `run record cannot be read for timing (${error.message})` })
        }
      }
    }
  }
  if (!project) rows.push(...questions.map((entry) => (entry.q ? questionWait(entry.q, { retiredAt: entry.retiredAt }) : questionWait(entry))))
  const inRange = rows.filter((r) => (!from || (r.enteredAt ?? '') >= from) && (!to || (r.enteredAt ?? '') <= to) && (r.enteredAt || (!from && !to)))
  for (const r of inRange) { r.alerted = alerted.has(r.key); r.alertedAt = alerted.get(r.key) ?? null }
  return { from, to, project, rows: inRange, unreadableRuns, summary: summariseWaits(inRange, { installedAt }) }
}
