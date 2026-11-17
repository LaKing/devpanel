import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { constants } from 'node:fs'
import { writeAtomic } from './persistence.mjs'
import { packedSummary } from '../issue-bundle.mjs'

/*
 * The full verification evidence of a window (execution-contract.md "Full verification evidence").
 *
 * When the issue was opened by a full verification (`openedBy.from.via: 'full-verification'` with its `cycle`), or is
 * an inquiry whose `inquiry.relatedIssue` is such an issue, the window freezes a copy of that cycle's evidence beside
 * its other inputs, under `<window>/cycle-evidence/`, where every seat fence binds it read-only:
 *   - `cycle.json`: the cycle's record, filtered to the exposed projects (the issue's own, the instance entries its entry is
 *     derived from, plus the members of a pool the record itself names with it under `outcome.bump`); every other
 *     project's entry, and every nested mention of one, is left out and counted in `windowFilter`;
 *   - `<project>/checks/…`: each exposed entry's check evidence (selftest report, logs, browser report, flaky reruns),
 *     read from the directory the cycle's layout computes (never from a path the record holds), regular files only.
 * No other cycle's record or directory is read. Caps (files, total bytes, bytes per file) are separate from the
 * human-input budget; a file over the per-file cap keeps its tail and says so, one beyond the others is omitted and
 * listed. A record that is gone is stated (`state: 'pruned'`), never silently missing.
 */

export const CYCLE_EVIDENCE_LIMITS = { maxCycleEvidenceFiles: 200, maxCycleEvidenceBytes: 16 * 1024 * 1024, maxCycleEvidenceFileBytes: 1024 * 1024 }
const CYCLE_ID = /^(\d{4}-\d{2}-\d{2})\.\d+$/
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ISSUE_ID = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9._-]+$/
const RECORD_FIELDS = ['id', 'date', 'trigger', 'by', 'state', 'verdict', 'frozenAt', 'startedAt', 'endedAt', 'error']
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Whether every component of `target` below `root` is a real directory, no link among them (the root itself included). */
async function realDirectories (root, target) {
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  let at = root
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    at = path.join(at, part)
    const st = await fs.lstat(at).catch(() => null)
    if (!st?.isDirectory()) return false
  }
  return true
}

async function readNoFollow (file, maxBytes = Infinity) {
  let handle
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const st = await handle.stat()
    if (!st.isFile()) return null
    const length = Math.min(st.size, maxBytes)
    const bytes = Buffer.alloc(length)
    const { bytesRead } = await handle.read(bytes, 0, length, Math.max(0, st.size - length))
    return { bytes: bytes.subarray(0, bytesRead), size: st.size }
  } catch (e) {
    if (['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes(e.code)) return null
    throw e
  } finally { await handle?.close() }
}

const readJson = async (file) => { const r = await readNoFollow(file); if (!r) return null; try { return JSON.parse(r.bytes.toString('utf8')) } catch { return undefined } }
const fromVerification = (issue) => issue?.openedBy?.from?.via === 'full-verification' && typeof issue.openedBy.from.cycle === 'string' ? issue.openedBy.from : null

/** The issue whose cycle this window concerns: the issue itself, or an inquiry's related issue; null when none. */
async function subjectOf (issuePath, issuesRoot, project) {
  const issue = await readJson(path.join(issuePath, 'issue.json'))
  const own = fromVerification(issue)
  if (own) return { from: own, via: 'openedBy' }
  const related = issue?.inquiry?.relatedIssue
  if (typeof related !== 'string' || !ISSUE_ID.test(related)) return null
  const relatedIssue = await readJson(path.join(path.dirname(issuePath), related, 'issue.json')) ?? (await packedSummary(issuesRoot, project, related).catch(() => null))?.issue
  const from = fromVerification(relatedIssue)
  return from ? { from, via: 'relatedIssue', relatedIssue: related } : null
}

/** The projects the record names in one pool with `project` (outcome.bump), the project itself first. */
export function exposedProjects (record, project) {
  const out = new Set([project])
  // A framework entry derived from instance entries: their evidence is its evidence.
  const own = (Array.isArray(record?.projects) ? record.projects : []).find((e) => e?.project === project)
  for (const f of Array.isArray(own?.derived?.from) ? own.derived.from : []) if (typeof f?.project === 'string') out.add(f.project)
  const bump = record?.outcome?.bump
  for (const w of bump?.withheld ?? []) if (Array.isArray(w.members) && w.members.includes(project)) for (const m of w.members) if (typeof m === 'string') out.add(m)
  const steps = [...(bump?.chain ?? []), ...(bump?.notRun ?? [])]
  const frameworks = new Set(steps.filter((s) => s.project === project && s.framework).map((s) => s.framework))
  for (const s of steps) if (frameworks.has(s.framework) && typeof s.project === 'string') out.add(s.project)
  return [...out]
}

/** The record with every other project left out, nested mentions included; `omittedEntries` counts the entries dropped. */
export function filterRecord (record, projects) {
  const keep = (p) => projects.includes(p)
  const out = {}
  for (const k of RECORD_FIELDS) if (k in record) out[k] = record[k]
  const entries = Array.isArray(record.projects) ? record.projects : []
  out.projects = entries.filter((e) => keep(e?.project))
  if (record.outcome && typeof record.outcome === 'object') {
    const o = record.outcome
    const byProject = (list) => (Array.isArray(list) ? list.filter((x) => keep(x?.project)) : [])
    const outcome = {}
    for (const k of ['verdict', 'committed', 'commitWithheld', 'reason', 'startedAt', 'endedAt']) if (k in o) outcome[k] = o[k]
    if ('issues' in o) outcome.issues = byProject(o.issues)
    if ('flaky' in o) outcome.flaky = byProject(o.flaky)
    if (o.bump && typeof o.bump === 'object') {
      const b = o.bump
      outcome.bump = {
        chain: byProject(b.chain),
        failed: b.failed && keep(b.failed.project) ? b.failed : null,
        notRun: byProject(b.notRun),
        versions: Object.fromEntries(Object.entries(b.versions ?? {}).filter(([p]) => keep(p))),
        withheld: (Array.isArray(b.withheld) ? b.withheld : []).filter((w) => Array.isArray(w.members) && w.members.some(keep))
          .map((w) => ({ framework: w.framework, members: w.members.filter(keep), moved: byProject(w.moved) })),
        untestedCommitted: byProject(b.untestedCommitted),
        ...(typeof b.reason === 'string' ? { reason: b.reason } : {})
      }
    }
    out.outcome = outcome
  }
  return { record: out, omittedEntries: entries.length - out.projects.length }
}

/**
 * Every regular file under root, relative, in lexical order; links and special files are counted, never followed;
 * a directory that cannot be listed is reported in `unreadable` and the walk goes on.
 */
async function walk (root) {
  const files = [], unreadable = []; let skipped = 0
  const visit = async (rel) => {
    let listed
    try { listed = await fs.readdir(path.join(root, rel), { withFileTypes: true }) } catch (e) { unreadable.push({ source: path.join(root, rel), reason: `unreadable: ${e.code ?? e.message}` }); return }
    for (const d of listed.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = path.join(rel, d.name)
      if (d.isDirectory()) await visit(r)
      else if (d.isFile()) files.push(r)
      else skipped++
    }
  }
  await visit('')
  return { files, skipped, unreadable }
}

/**
 * Capture the cycle evidence into `<dir>/cycle-evidence/`. Returns null when the window concerns no full
 * verification issue, else the record kept as `window.cycleEvidence`.
 */
export async function captureCycleEvidence ({ issuePath, dir, limits = {} }) {
  const projectDir = path.dirname(issuePath)
  const issuesRoot = path.dirname(projectDir)
  const project = path.basename(projectDir)
  const verificationDir = path.join(issuesRoot, '.verification')
  const subject = await subjectOf(issuePath, issuesRoot, project)
  if (!subject) return null
  const cycle = subject.from.cycle
  const base = { cycle, via: subject.via, ...(subject.relatedIssue ? { relatedIssue: subject.relatedIssue } : {}) }
  const m = CYCLE_ID.exec(cycle)
  if (!m) return { ...base, state: 'unreadable', files: [], note: `The issue names full verification "${cycle}", which is not a cycle id; this window holds none of its evidence.` }
  const date = m[1]
  const dateDir = path.join(verificationDir, date)
  // No link anywhere between the issues root and the cycle's directories: a link could name another cycle or project.
  if (await fs.lstat(dateDir).catch(() => null) && !await realDirectories(issuesRoot, dateDir)) {
    return { ...base, date, state: 'unreadable', files: [], note: `issues/.verification/${date}/ is reached through a link, which is never followed; this window holds none of the cycle's evidence.` }
  }
  let record = null, recordFile = null, recordBytes = null, unreadable = false
  for (const name of (await fs.readdir(dateDir).catch(() => [])).filter((n) => /^cycle(\.\d+)?\.json$/.test(n)).sort()) {
    const r = await readNoFollow(path.join(dateDir, name))
    if (!r) continue
    let parsed
    try { parsed = JSON.parse(r.bytes.toString('utf8')) } catch { unreadable = true; continue }
    if (parsed?.id === cycle) { record = parsed; recordFile = path.join(dateDir, name); recordBytes = r.bytes; break }
  }
  if (!record) {
    return unreadable
      ? { ...base, date, state: 'unreadable', files: [], note: `No readable record of full verification ${cycle} in issues/.verification/${date}/ (a record file there could not be parsed); this window holds none of its evidence.` }
      : { ...base, date, state: 'pruned', files: [], note: `The record of full verification ${cycle} is no longer in issues/.verification/${date}/ (pruned or removed); this window holds none of its evidence.` }
  }
  const caps = Object.fromEntries(Object.entries(CYCLE_EVIDENCE_LIMITS).map(([k, v]) => [k, Number.isInteger(limits[k]) && limits[k] > 0 ? limits[k] : v]))
  const projects = exposedProjects(record, project)
  const out = path.join(dir, 'cycle-evidence')
  const files = [], omitted = []
  let bytes = 0, skipped = 0
  const take = async ({ target, source, project: owner, content }) => {
    if (files.length >= caps.maxCycleEvidenceFiles) { omitted.push({ source, totalBytes: content.size, reason: 'maxCycleEvidenceFiles' }); return }
    let data = content.bytes
    if (data.length > caps.maxCycleEvidenceBytes - bytes) { omitted.push({ source, totalBytes: content.size, reason: 'maxCycleEvidenceBytes' }); return }
    const truncated = content.size > data.length
    await writeAtomic(target, data)
    bytes += data.length
    files.push({ file: target, source, project: owner, sha256: hash(data), bytes: data.length, totalBytes: content.size, truncated,
      ...(truncated ? { note: `cut to the last ${data.length} of ${content.size} bytes (maxCycleEvidenceFileBytes)` } : {}) })
  }
  const filtered = filterRecord(record, projects)
  const recordSha256 = hash(recordBytes)
  filtered.record.windowFilter = { projects, omittedEntries: filtered.omittedEntries,
    note: `Filtered for this window: entries of other projects in this cycle are left out. The original is ${recordFile}, sha256 ${recordSha256}.` }
  const recordText = Buffer.from(JSON.stringify(filtered.record, null, 2) + '\n')
  await take({ target: path.join(out, 'cycle.json'), source: recordFile, project: null, content: { bytes: recordText.subarray(Math.max(0, recordText.length - caps.maxCycleEvidenceFileBytes)), size: recordText.length } })
  const entries = []
  for (const p of projects) {
    const entry = (record.projects ?? []).find((e) => e?.project === p)
    if (!entry) { entries.push({ project: p, state: 'no-entry' }); continue }
    if (!SEGMENT.test(p)) { entries.push({ project: p, state: 'unreadable', note: 'the project name is not one path segment' }); continue }
    if (entry.mode === 'derived') { entries.push({ project: p, mode: 'derived', state: 'derived', note: `no drive of its own: derived from ${(entry.derived?.from ?? []).map((f) => f?.project).filter((x) => typeof x === 'string').join(', ') || 'no entry'}, whose evidence is listed under their names` }); continue }
    // The evidence directory is computed from the cycle's layout, never taken from entry.runDir.
    const instance = path.join(verificationDir, date, cycle, p)
    const run = typeof entry.runId === 'string' && SEGMENT.test(entry.runId) ? path.join(issuesRoot, p, `.verification-${date}`, 'runs', entry.runId) : null
    let home = null, mode = null
    let linked = null
    for (const [candidate, kind] of [[instance, 'instance'], [run, 'run']]) {
      if (!candidate) continue
      const checks = path.join(candidate, 'checks')
      // Judged against the issues root, never a link's destination: every directory down to checks/ must be real.
      if (await realDirectories(issuesRoot, checks)) { home = candidate; mode = kind; break }
      if (await fs.stat(checks).catch(() => null)) linked ??= { kind, checks }
    }
    if (!home && linked) { entries.push({ project: p, mode: linked.kind, source: linked.checks, state: 'refused', note: `${linked.checks} is reached through a link, which is never followed; nothing of ${p} was copied` }); continue }
    if (!home) { entries.push({ project: p, state: 'evidence-missing', note: `no checks/ directory of ${p} for cycle ${cycle}` }); continue }
    const checks = path.join(home, 'checks')
    const listed = await walk(checks)
    skipped += listed.skipped
    omitted.push(...listed.unreadable)
    let count = 0
    for (const rel of listed.files) {
      const source = path.join(checks, rel)
      let content
      try { content = await readNoFollow(source, caps.maxCycleEvidenceFileBytes) } catch (e) { omitted.push({ source, reason: `unreadable: ${e.code ?? e.message}` }); continue }
      if (!content) { skipped++; continue }
      const before = files.length
      await take({ target: path.join(out, p, 'checks', rel), source, project: p, content })
      if (files.length > before) count++
    }
    entries.push({ project: p, mode, source: checks, state: 'captured', files: count })
  }
  const truncated = files.filter((f) => f.truncated).length
  const notes = []
  if (truncated) notes.push(`${truncated} file${truncated === 1 ? ' was' : 's were'} cut to the last ${caps.maxCycleEvidenceFileBytes} bytes`)
  if (omitted.length) notes.push(`${omitted.length} file${omitted.length === 1 ? ' was' : 's were'} omitted, by the caps or unreadable (listed under omitted with the reason)`)
  if (skipped) notes.push(`${skipped} link${skipped === 1 ? '' : 's'} or special file${skipped === 1 ? '' : 's'} skipped`)
  const refused = entries.filter((e) => e.state === 'refused').length
  if (refused) notes.push(`${refused} evidence director${refused === 1 ? 'y was' : 'ies were'} refused (reached through a link)`)
  return { ...base, date, state: 'captured', dir: out, recordFile, recordSha256, projects, entries, files, omitted, skipped, limits: caps, ...(notes.length ? { note: `${notes.join('; ')}.` } : {}) }
}
