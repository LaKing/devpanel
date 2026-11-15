import fs from 'node:fs/promises'
import path from 'node:path'

import { ARCHIVE_FILE, issueStatus } from './issue-archive.mjs'
import { withMoves } from './issue-bundle.mjs'
import { reportFingerprint } from './report-identity.mjs'
import { LockHeld, withLock } from './runtime/lock.mjs'
import { writeAtomic, writeJson } from './runtime/persistence.mjs'

/*
 * A fault report whose fingerprint matches an OPEN issue of its project opens nothing: the occurrence is recorded
 * on that issue (report.mjs answers 409 naming it, as for a resubmission). Open is an issue folder with no archive
 * marker, no disposition and a status that reads as open (issueStatus, missing = open). A match with an archived or
 * decided issue is news, and opens a new issue with `repeats` as before (report-identity.mjs).
 *
 * Closure is concluded only from positive evidence: the archive marker is there, the record parses and holds a
 * disposition or a closed status, or the folder is gone while the moves lock is held (packed or deleted). A record
 * that cannot be read, a folder without its record, or a lock that stays held is `unknown`: answered 503 with
 * Retry-After, nothing opened, because a second open issue for one fault is what this exists to prevent. Whether the
 * framework's reporter sends a record again after a 503 is NOT confirmed (its code is not part of this tree); if it
 * drops it, one occurrence entry is lost and the open issue still stands.
 *
 * Storage, in the issue folder (packed with it when it is archived):
 *   occurrences.json      {version, count, firstAt, lastAt, recent: [{seq, at, name, reporter, trust, category, host,
 *                         bytes, truncated}]}, the newest MAX_RECENT entries; count/firstAt/lastAt count every one.
 *   occurrences/<seq>.md  each kept entry's report text, whole.
 * The bound: metadata strings are capped (name NAME_CHARS, reporter REPORTER_CHARS, host HOST_CHARS; category and
 * trust from fixed lists), so occurrences.json stays well under MAX_JSON_BYTES (64 KiB), which a write refuses to
 * pass; a text is at most MAX_TEXT_BYTES (256 KiB, the route's body limit, so a reported text is never cut). At most
 * 64 KiB + 10 x 256 KiB = 2.5625 MiB per issue, however long the fault recurs. Lists read only the JSON.
 *
 * Both locks are taken in this order: the project's moves lock (so the folder cannot be packed away under us, and
 * lock.mjs's mkdir cannot bring a packed folder back), then the issue's .step-alloc.lock, under which archiving
 * writes its marker. Packing never takes the step lock, so the order cannot deadlock.
 */

export const MAX_RECENT = 10
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_JSON_BYTES = 64 * 1024
const NAME_CHARS = 200
const REPORTER_CHARS = 64
const HOST_CHARS = 255
const CATEGORIES = ['bug', 'feature', 'error', 'warning', 'crash']
const TRUSTS = ['fault', 'request', 'anonymous']
const ISSUE_DIR = /^\d{4}-\d{2}-\d{2}-.+$/
const JSON_FILE = 'occurrences.json'
const TEXT_DIR = 'occurrences'

const cap = (value, chars) => typeof value === 'string' ? (value.length > chars ? `${value.slice(0, chars - 1)}…` : value) : null
const oneOf = (value, list) => list.includes(value) ? value : null
const readText = (file) => fs.readFile(file, 'utf8')

/** open | closed | unknown, from what can be read now. `underMoves`: the caller holds the project's moves lock. */
export async function classify (dir, { underMoves = false } = {}) {
  try { await fs.stat(dir) } catch (error) { return error.code === 'ENOENT' && underMoves ? 'closed' : 'unknown' }
  try {
    await fs.stat(path.join(dir, ARCHIVE_FILE))
    return 'closed'
  } catch (error) {
    if (error.code !== 'ENOENT') return 'unknown'
  }
  let meta
  try { meta = JSON.parse(await readText(path.join(dir, 'issue.json'))) } catch { return 'unknown' }
  if (!meta || typeof meta !== 'object') return 'unknown'
  if (meta.disposition) return 'closed'
  return issueStatus(meta) === 'open' ? 'open' : 'closed'
}

/** The newest open issue of the project reporting this fault, else the newest whose state cannot be read, else null. */
export async function findOpenMatch ({ issuesDir, project, fingerprint, exclude = new Set() }) {
  const projectDir = path.join(issuesDir, project)
  const entries = await fs.readdir(projectDir, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ISSUE_DIR.test(entry.name) || exclude.has(entry.name)) continue
    const dir = path.join(projectDir, entry.name)
    const text = () => readText(path.join(dir, '000-report', 'response.md')).then(reportFingerprint, () => null)
    let meta
    try { meta = JSON.parse(await readText(path.join(dir, 'issue.json'))) } catch {
      // A record that is missing or unreadable beside a report of this fault proves nothing either way: the shared
      // classifier decides (an archive marker closes it; otherwise it is unknown, never skipped).
      if (await text() !== fingerprint) continue
      const state = await classify(dir)
      if (state !== 'closed') found.push({ id: entry.name, state, openedAt: entry.name.slice(0, 10) })
      continue
    }
    if (!meta?.report || meta.kind === 'inquiry' || (meta.report.kind ?? 'fault') !== 'fault') continue
    if ((meta.report.fingerprint ?? await text()) !== fingerprint) continue
    const state = await classify(dir)
    if (state !== 'closed') found.push({ id: entry.name, state, openedAt: meta.openedAt ?? entry.name.slice(0, 10) })
  }
  found.sort((a, b) => (a.state === b.state ? 0 : a.state === 'open' ? -1 : 1) || b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id))
  return found[0] ?? null
}

/** The record, or null when there is none or it cannot be read (then the next write starts it again). */
export async function readOccurrences (dir) {
  try { return JSON.parse(await readText(path.join(dir, JSON_FILE))) } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`${path.join(dir, JSON_FILE)} cannot be read (${error.message}); the next occurrence starts it again`)
    return null
  }
}

export const occurrenceSummary = (o) => o ? { count: o.count ?? 0, firstAt: o.firstAt ?? null, lastAt: o.lastAt ?? null } : null

/** The record with each kept entry's text (null when its file cannot be read). */
export async function occurrenceTexts (dir, record) {
  if (!record?.recent) return record ?? null
  const recent = await Promise.all(record.recent.map(async (e) => ({ ...e, text: await readText(path.join(dir, TEXT_DIR, `${e.seq}.md`)).catch(() => null) })))
  return { ...record, recent }
}

function boundedText (text) {
  const bytes = Buffer.byteLength(text)
  if (bytes <= MAX_TEXT_BYTES) return { text, bytes, truncated: false }
  let cut = Buffer.from(text).subarray(0, MAX_TEXT_BYTES)
  const newline = cut.lastIndexOf(0x0a)
  if (newline > 0) cut = cut.subarray(0, newline + 1)
  return { text: cut.toString('utf8').replace(/�+$/, ''), bytes, truncated: true }
}

async function append (dir, entry, text) {
  const previous = await readOccurrences(dir)
  const seq = (previous?.count ?? 0) + 1
  const body = boundedText(text)
  const at = entry.at
  const kept = {
    seq, at, name: cap(entry.name, NAME_CHARS), reporter: cap(entry.reporter, REPORTER_CHARS), trust: oneOf(entry.trust, TRUSTS),
    category: oneOf(entry.category, CATEGORIES), host: cap(entry.host, HOST_CHARS), bytes: body.bytes, truncated: body.truncated
  }
  const record = { version: 1, count: seq, firstAt: previous?.firstAt ?? at, lastAt: at, recent: [...(previous?.recent ?? []), kept].slice(-MAX_RECENT) }
  if (Buffer.byteLength(JSON.stringify(record, null, 2) + '\n') > MAX_JSON_BYTES) throw new Error(`the occurrence record of ${dir} would pass ${MAX_JSON_BYTES} bytes; nothing was recorded`)
  await writeAtomic(path.join(dir, TEXT_DIR, `${seq}.md`), body.text)
  await writeJson(path.join(dir, JSON_FILE), record)
  const names = new Set(record.recent.map((e) => `${e.seq}.md`))
  for (const name of await fs.readdir(path.join(dir, TEXT_DIR)).catch(() => [])) {
    if (!names.has(name)) await fs.rm(path.join(dir, TEXT_DIR, name), { force: true })
  }
  return seq
}

/**
 * Record one occurrence on an issue `findOpenMatch` called open. `{state: 'recorded', count}`, `{state: 'closed'}`
 * (proved closed since: open a new issue as before), or `{state: 'unknown'}` (unreadable, or busy after one retry).
 * `seams` exist only so a test can land between the steps.
 */
export async function recordOccurrence ({ issuesDir, project, id, entry, text, seams = {} }) {
  const dir = path.join(issuesDir, project, id)
  const waitMs = seams.occurrenceWaitMs ?? 5000
  await seams.beforeOccurrence?.(id)
  const attempt = () => withMoves(issuesDir, project, async () => {
    const before = await classify(dir, { underMoves: true })
    if (before !== 'open') return { state: before }
    return withLock(path.join(dir, '.step-alloc.lock'), { purpose: 'report-occurrence', waitMs }, async () => {
      await seams.insideOccurrence?.(id)
      const now = await classify(dir, { underMoves: true })
      if (now !== 'open') return { state: now }
      return { state: 'recorded', count: await append(dir, entry, text) }
    })
  }, { waitMs })
  for (let tries = 0; tries < 2; tries++) {
    try { return await attempt() } catch (error) {
      if (!(error instanceof LockHeld)) throw error
      if (await classify(dir) === 'closed') return { state: 'closed' }
      if (tries === 0) await new Promise((resolve) => setTimeout(resolve, seams.occurrenceRetryMs ?? 1000))
    }
  }
  return { state: 'unknown' }
}
