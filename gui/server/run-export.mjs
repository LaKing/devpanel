import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { isIssueId } from './issues.js'
import { runMetrics, checkIntervals } from './runtime/run-metrics.mjs'

/*
 * One row per run of a project, for cohort analysis (tools/runs.mjs).
 *
 * The overview (supervisor-overview.mjs) totals runs; this lists them, with the
 * per-run measurements it sums (run-metrics.mjs) and why each run stopped. It
 * does its own discovery rather than going through listIssues, because what it
 * promises is that nothing it cannot read goes unmentioned: every directory
 * listing, run record, sidecar member or bundle that does not read becomes one
 * `{unreadable, error}` line, and the reading goes on.
 *
 * It writes nothing. A packed issue's bundle is only listed (`tar -t`), never
 * extracted, to find run records its sidecar does not hold.
 *
 * Runs follow each other by run id, lexicographically, within one location (an
 * issue folder or a bundle); nothing else orders them.
 */

const TERMINAL = ['completed', 'blocked', 'failed', 'cancelled']

/** A project id is one path component (project-actions.mjs's rule, plus backslash and NUL). */
export const isProjectId = (p) => typeof p === 'string' && p.length > 0 && !p.includes('/') && !p.includes('\\') &&
  !p.includes('\0') && !p.includes('..') && !p.startsWith('.')

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isString = (v) => typeof v === 'string'
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const absentOr = (v, test) => v === undefined || v === null || test(v)
const knownId = (m) => plain(m) && typeof m.runId === 'string' && m.runId.length > 0 ? m.runId : null
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * A timestamp that names a real instant: it parses, and its calendar date and time are the ones written
 * (Date.parse reads 2026-02-31 as March 3; that is not a start anyone recorded).
 */
// Seconds optional; a fraction of at most 3 digits, since anything finer would be dropped by Date.parse unseen.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/
export function validTimestamp (value) {
  const m = typeof value === 'string' ? STAMP.exec(value) : null
  if (!m || !Number.isFinite(Date.parse(value))) return false
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number)
  const sec = Number(m[6] ?? 0)
  const msec = Number((m[7] ?? '').padEnd(3, '0'))
  // setUTCFullYear, not Date.UTC: Date.UTC reads years 0–99 as 1900–1999.
  const local = new Date(0)
  local.setUTCFullYear(y, mo - 1, d)
  local.setUTCHours(h, mi, sec, msec)
  return local.getUTCFullYear() === y && local.getUTCMonth() === mo - 1 && local.getUTCDate() === d &&
    local.getUTCHours() === h && local.getUTCMinutes() === mi && local.getUTCSeconds() === sec && local.getUTCMilliseconds() === msec
}

/*
 * The check evidence checkIntervals reads, field by field: a wrong type there is a malformed record, not
 * "no check ran" (checkIntervals itself drops an interval it cannot place, silently).
 */
function checkEvidenceProblem (record) {
  const timed = (c) => !absentOr(c.at, validTimestamp) ? 'at is not a timestamp' : !absentOr(c.durationMs, isNumber) ? 'durationMs is not a number' : null
  const waited = (w) => !absentOr(w.from, validTimestamp) ? 'from is not a timestamp' : !absentOr(w.to, validTimestamp) ? 'to is not a timestamp' : null
  // checkIntervals drops a baseline whose `reused` is truthy: only a reuse record (an object) or false/null may say so.
  const baseline = (b) => timed(b) ?? (!(b.reused === undefined || b.reused === null || b.reused === false || plain(b.reused)) ? 'reused is neither false nor a reuse record' : null)
  const lists = [['checkResults', timed], ['priorCheckResults', timed], ['baselineChecks', baseline], ['diagnosticDrives', timed],
    ['driveSlotWaits', waited], ['moduleLockWaits', waited], ['checkHistory', () => null]]
  for (const [key, check] of lists) {
    const list = record[key]
    if (!absentOr(list, Array.isArray)) return `${key} is not an array`
    for (const [i, item] of (list ?? []).entries()) {
      if (!plain(item)) return `${key}[${i}] is not an object`
      const problem = check(item)
      if (problem) return `${key}[${i}].${problem}`
      const nested = key === 'checkHistory' ? ['runs', item.runs] : ['attempts', item.attempts]
      if (key === 'checkHistory' || key === 'checkResults' || key === 'priorCheckResults') {
        if (!absentOr(nested[1], Array.isArray)) return `${key}[${i}].${nested[0]} is not an array`
        for (const [j, sub] of (nested[1] ?? []).entries()) {
          if (!plain(sub)) return `${key}[${i}].${nested[0]}[${j}] is not an object`
          const subProblem = timed(sub)
          if (subProblem) return `${key}[${i}].${nested[0]}[${j}].${subProblem}`
        }
      }
    }
  }
  return null
}

const errorText = (error) => typeof error === 'string' ? error
  : typeof error?.code === 'string' ? `${error.code}: ${error.message}` : String(error?.message ?? error).split('\n')[0]

/** The first reason this record cannot be a row, or null. Every field read is absent, null or of its type. */
export function recordProblem (record, now = Date.now()) {
  if (!plain(record)) return 'not a run record (expected an object)'
  for (const k of ['runId', 'status', 'outcome', 'blockedReason', 'startedAt', 'endedAt']) if (!absentOr(record[k], isString)) return `${k} is not a string`
  for (const k of ['playbook', 'failure', 'preflight', 'budgets']) if (!absentOr(record[k], plain)) return `${k} is not an object`
  if (!absentOr(record.budgets?.used, plain)) return 'budgets.used is not an object'
  for (const [obj, k] of [['playbook', 'id'], ['playbook', 'configHash'], ['failure', 'class'], ['failure', 'message'], ['preflight', 'state'], ['preflight', 'detail']]) {
    if (!absentOr(record[obj]?.[k], isString)) return `${obj}.${k} is not a string`
  }
  for (const k of ['costUsd', 'tokens', 'costUnknownSteps']) if (!absentOr(record.budgets?.used?.[k], isNumber)) return `budgets.used.${k} is not a number`
  if (!absentOr(record.steps, Array.isArray)) return 'steps is not an array'
  if ((record.steps ?? []).some((s) => !plain(s))) return 'a member of steps is not an object'
  const evidence = checkEvidenceProblem(record)
  if (evidence) return evidence
  try { runMetrics(record, { now }); checkIntervals(record) } catch (error) { return `cannot be measured: ${error.message}` }
  return null
}

/** Why a run stopped, as recorded: failure.class, else blockedReason, else a preflight detail, else unknown. */
export function causeOf (run) {
  if (run.failure?.class) return { value: run.failure.class, source: 'failure.class', detail: run.failure.message ?? null }
  if (run.blockedReason) return { value: run.blockedReason, source: 'blockedReason', detail: run.blockedReason === 'preflight-refused' ? run.preflight?.detail ?? null : null }
  const p = run.preflight
  if (p?.state && !['passed', 'pending'].includes(p.state) && typeof p.detail === 'string' && p.detail) return { value: `preflight-${p.state}`, source: 'preflight', detail: p.detail }
  return { value: 'unknown', source: 'unknown', detail: run.failure?.message ?? null }
}

/** A bundle's member names, listed read-only: no TAR_OPTIONS reaches tar, nothing is extracted. */
function listBundle (file) {
  return new Promise((resolve, reject) => execFile('tar', ['-tzf', file],
    { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 60_000, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout.split('\n').filter(Boolean))))
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @param issuesDir  the issue store (ISSUES_DIR)
 * @param project    one project id
 * @param from, to   the UTC window in epoch ms, inclusive; null for open
 * @returns { missing: true } when the project has neither an issue directory nor an archive,
 *          else { missing: false, lines } (unreadable and skipped lines, rows by run id, totals last)
 */
export async function exportRuns ({ issuesDir, project, from = null, to = null, now = Date.now() }) {
  if (!isProjectId(project)) throw Object.assign(new Error(`not a project id: ${JSON.stringify(project)}`), { code: 'BAD_PROJECT' })
  const projDir = path.join(issuesDir, project)
  const archDir = path.join(issuesDir, '.archive', project)
  const exists = (p) => fs.lstat(p).then(() => true, (e) => e.code !== 'ENOENT')
  if (!await exists(projDir) && !await exists(archDir)) return { missing: true, lines: [] }

  const notes = []
  const reported = new Set()
  // One line per input, however often it is read (the archive is listed twice).
  const report = (where, error) => {
    if (reported.has(where)) return
    reported.add(where)
    notes.push({ unreadable: where, error: errorText(error) })
  }

  // Archive, project, archive again: a pack shows the sidecar before the folder goes, a restore the
  // folder before the sidecar goes, so an id moving between the listings is still seen.
  let archiveReadable = true
  const archiveIds = async () => {
    let names = []
    try { names = await fs.readdir(archDir) } catch (e) { if (e.code !== 'ENOENT') { report(archDir, e); archiveReadable = false } }
    return names.flatMap((n) => { const m = /^(.+)\.(runs\.json|tar\.gz)$/.exec(n); return m && isIssueId(m[1]) ? [m[1]] : [] })
  }
  const ids = new Set(await archiveIds())
  let foldersReadable = true
  try {
    for (const e of await fs.readdir(projDir, { withFileTypes: true })) if (e.isDirectory() && isIssueId(e.name)) ids.add(e.name)
  } catch (e) { if (e.code !== 'ENOENT') { report(projDir, e); foldersReadable = false } }
  for (const id of await archiveIds()) ids.add(id)

  const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

  async function configHashOf (record, runDir) {
    if (typeof record.playbook?.configHash === 'string') return record.playbook.configHash
    const file = path.join(runDir, 'resolved-playbook.json')
    let snapshot
    try { snapshot = await readJson(file) } catch (e) { if (e.code !== 'ENOENT') report(file, e); return null }
    if (!plain(snapshot)) { report(file, 'not a snapshot (expected an object)'); return null }
    for (const k of ['configHash', 'snapshotOf']) if (!absentOr(snapshot[k], isString)) { report(file, `${k} is not a string`); return null }
    return snapshot.configHash ?? snapshot.snapshotOf ?? null
  }

  /** The runs of an issue folder, or null when there is no folder. Entries with record null are unreadable. */
  async function readFolder (id) {
    const issueDir = path.join(projDir, id)
    const runsDir = path.join(issueDir, 'runs')
    let names
    try {
      names = (await fs.readdir(runsDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-')).map((e) => e.name).sort(byCodeUnit)
    } catch (e) {
      if (e.code === 'ENOENT') return await exists(issueDir) ? [] : null
      report(runsDir, e)
      return []
    }
    const entries = []
    for (const name of names) {
      const file = path.join(runsDir, name, 'run.json')
      let record
      try { record = await readJson(file) } catch (e) { report(file, e); entries.push({ runId: name, record: null, where: file }); continue }
      const problem = recordProblem(record, now)
      if (problem) { report(file, problem); entries.push({ runId: knownId(record) ?? name, record: null, where: file }); continue }
      entries.push({ runId: knownId(record) ?? name, record, where: file, configHash: await configHashOf(record, path.join(runsDir, name)) })
    }
    return entries
  }

  async function readSidecar (file) {
    let data
    try { data = await readJson(file) } catch (e) {
      if (e.code === 'ENOENT') return { state: 'absent' }
      report(file, e)
      return { state: 'unreadable' }
    }
    if (!Array.isArray(data)) { report(file, 'not an array of run records'); return { state: 'unreadable' } }
    return { state: 'ok', members: data }
  }

  /** The runs of a packed issue, or null when it has neither sidecar nor bundle. */
  async function readPacked (id, sidecar) {
    const runsFile = path.join(archDir, `${id}.runs.json`)
    const bundle = path.join(archDir, `${id}.tar.gz`)
    const hasBundle = await exists(bundle)
    if (sidecar.state === 'absent' && !hasBundle) return null
    const entries = []
    const sidecarIds = new Set()
    if (sidecar.state === 'ok') {
      sidecar.members.forEach((m, i) => {
        const runId = knownId(m)
        // Identifiable, valid or not: the bundle's copy of this run is accounted for.
        if (runId) sidecarIds.add(runId)
        const where = `${runsFile}#${i}`
        const problem = !plain(m) ? 'not a run record (expected an object)' : !runId ? 'no runId' : recordProblem(m, now)
        if (problem) { report(where, problem); if (runId) entries.push({ runId, record: null, where }); return }
        entries.push({ runId, record: m, where, configHash: m.playbook?.configHash ?? null })
      })
    } else if (sidecar.state === 'absent') report(runsFile, 'missing beside its bundle')
    if (hasBundle) {
      let names = null
      try { names = await listBundle(bundle) } catch (e) { report(bundle, e.killed ? 'listing timed out' : e) }
      if (names && sidecar.state === 'ok') {
        const member = new RegExp(`^(?:\\./)?${escapeRegExp(id)}/runs/([^/]+)/run\\.json$`)
        for (const n of names) {
          const name = member.exec(n)?.[1]
          if (!name || name.startsWith('worktree-') || name.startsWith('workspace-') || sidecarIds.has(name)) continue
          const where = `${bundle}#runs/${name}/run.json`
          report(where, 'in the bundle but not in its run records')
          entries.push({ runId: name, record: null, where })
          sidecarIds.add(name)
        }
      }
    }
    return entries
  }

  const locations = []
  const skipped = []
  for (const id of [...ids].sort(byCodeUnit)) {
    // A directory that did not list is already one line; nothing under it is read again.
    const sidecarFile = path.join(archDir, `${id}.runs.json`)
    let sidecar = archiveReadable ? await readSidecar(sidecarFile) : { state: 'absent' }
    const folder = foldersReadable ? await readFolder(id) : null
    if (archiveReadable && sidecar.state === 'absent') sidecar = await readSidecar(sidecarFile)
    let packed = archiveReadable ? await readPacked(id, sidecar) : null
    if (folder) locations.push({ issue: id, packed: false, entries: folder })
    if (packed) {
      // The folder copy wins; a packed copy of the same run (an archive move in progress) is named, not counted.
      // It stays a member of the bundle's order (rowless), so the run before it still has its successor.
      const kept = new Map((folder ?? []).filter((e) => e.record).map((e) => [e.runId, e.where]))
      for (const e of packed) {
        if (!e.record || !kept.has(e.runId)) continue
        skipped.push({ skipped: e.where, keptFrom: kept.get(e.runId), reason: 'same issue and run id as the folder copy (an archive move in progress)' })
        e.rowless = true
      }
      locations.push({ issue: id, packed: true, entries: packed })
    }
  }

  // One record per run id in a history: the first read is kept, a later one with the same id is named, not counted.
  for (const loc of locations) {
    const first = new Map()
    for (const e of loc.entries) {
      if (!e.record || e.rowless) continue
      if (!first.has(e.runId)) { first.set(e.runId, e.where); continue }
      skipped.push({ skipped: e.where, keptFrom: first.get(e.runId), reason: 'same run id earlier in the same history' })
      e.rowless = true
    }
  }
  // A run read in one place of this export answers for itself where another place could not read it
  // (a pack or restore moved it between the readings).
  const readable = new Map()
  for (const loc of locations) for (const e of loc.entries) if (e.record && !e.rowless) readable.set(`${loc.issue}\0${e.runId}`, e.record)

  const rows = []
  for (const loc of locations) {
    // One place per run id in the order; a readable copy stands for an unreadable one of the same id.
    const byId = new Map()
    // Rows are dropped by dedup, chain members never are.
    for (const e of loc.entries) if (!byId.has(e.runId) || (e.record && !byId.get(e.runId).record)) byId.set(e.runId, e)
    const ordered = [...byId.values()].sort((a, b) => byCodeUnit(a.runId, b.runId))
    ordered.forEach((e, i) => {
      if (!e.record || e.rowless) return
      const after = ordered[i + 1]
      // The successor as this export retains it: its counted copy, wherever that was read.
      const afterRecord = after && (readable.get(`${loc.issue}\0${after.runId}`) ?? after.record)
      const next = !after ? null : afterRecord
        ? { runId: after.runId, status: afterRecord.status ?? null, outcome: afterRecord.outcome ?? null }
        : { runId: after.runId, unreadable: true }
      const started = validTimestamp(e.record.startedAt) ? Date.parse(e.record.startedAt) : NaN
      if (from != null || to != null) {
        if (!Number.isFinite(started)) { report(e.where, 'startedAt is not a timestamp; cannot place it in the window'); return }
        if ((from != null && started < from) || (to != null && started > to)) return
      }
      rows.push(row(loc, e, next, now))
    })
  }
  rows.sort((a, b) => byCodeUnit(a.runId, b.runId) || byCodeUnit(a.issue, b.issue))

  return {
    missing: false,
    lines: [...notes, ...skipped, ...rows, { totals: totalsOf(rows, { unreadable: notes.length, skipped: skipped.length, now, project, from, to, issuesDir }) }]
  }
}

function row (loc, { runId, record, configHash }, next, now) {
  const m = runMetrics(record, { now })
  const used = record.budgets?.used ?? {}
  const intervals = checkIntervals(record).length
  return {
    issue: loc.issue,
    packed: loc.packed,
    runId,
    playbook: record.playbook?.id ?? null,
    configHash: configHash ?? null,
    status: record.status ?? null,
    outcome: record.outcome ?? null,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    agentMs: m.time.agentMs,
    operatorWaitMs: m.time.operatorWaitMs,
    checksMs: m.time.checksMs,
    checks: { coverage: intervals > 0 ? 'recorded' : 'none', intervals },
    turns: m.turns,
    cost: { usd: used.costUsd ?? null, unpricedSteps: used.costUnknownSteps ?? 0 },
    tokens: used.tokens ?? null,
    cause: causeOf(record),
    next
  }
}

/** Counted as the overview's absorb counts: every row by status, time and cost over terminal rows. */
function totalsOf (rows, { unreadable, skipped, now, project, from, to, issuesDir }) {
  const t = { rows: rows.length, byStatus: {}, terminal: 0, agentMs: 0, operatorWaitMs: 0, checksMs: 0, cost: { usd: 0, priced: 0, unpriced: 0, tokens: 0 } }
  for (const r of rows) {
    if (r.status != null) t.byStatus[r.status] = (t.byStatus[r.status] ?? 0) + 1
    if (!TERMINAL.includes(r.status)) continue
    t.terminal++
    t.agentMs += r.agentMs
    t.operatorWaitMs += r.operatorWaitMs
    t.checksMs += r.checksMs
    if (r.cost.usd != null) { t.cost.usd += r.cost.usd; t.cost.priced++ } else t.cost.unpriced++
    if (r.tokens != null) t.cost.tokens += r.tokens
  }
  t.cost.usd = Math.round(t.cost.usd * 10000) / 10000
  return {
    ...t,
    unreadable,
    skipped,
    generatedAt: new Date(now).toISOString(),
    project,
    from: from == null ? null : new Date(from).toISOString(),
    to: to == null ? null : new Date(to).toISOString(),
    issuesDir,
    means: 'rows are runs whose startedAt is in [from, to] (every run without a window), open and packed issues, ordered by run id; next is the following run id of the same issue folder or bundle, computed before the window; agentMs, operatorWaitMs and checksMs are run-metrics.mjs\'s, totalled here over terminal rows as the overview totals them; checks.coverage "none" means the record holds no check interval, which cannot tell "no check ran" from "an older record kept none"; cause is failure.class, else blockedReason, else a preflight detail, and "unknown" means nothing was recorded; an unreadable line is an input that did not read, a skipped line a packed copy of a run whose folder copy was counted'
  }
}
