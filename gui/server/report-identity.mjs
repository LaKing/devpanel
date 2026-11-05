import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { archiveRoot, bundleFiles, withMoves } from './issue-bundle.mjs'
import { writeJson } from './runtime/persistence.mjs'

/*
 * Which earlier issue a new report repeats. A fingerprint match is the evidence; a shared title is not.
 *
 * The panel has no format for a fingerprint: it is read from a report's own text by a label
 * (reportFingerprint), or given in the route's optional `fingerprint` field. A format this reader does not
 * know means no fingerprint and no claim. A report is never refused for anything here.
 *
 * findRepeat lists folders and bundles together under the moves lock, so an issue moving between the two is
 * seen exactly once, and reads contents outside it, so a long decompress blocks nobody. An issue that moved
 * since is looked for again where it now is. What cannot be read or listed makes the lookup pending,
 * `repeatLookup` on the record: never "no repeat". A later getIssue reruns a pending lookup in whatever state
 * the issue is, and its outcome lives beside the bundle (`<id>.repeat-lookup.json`), so it never writes
 * issue.json, the folder or a verified bundle.
 */

const exec = promisify(execFile)
const ISSUE_DIR = /^\d{4}-\d{2}-\d{2}-.+$/
const TOKEN = '[A-Za-z0-9][A-Za-z0-9._:+/=-]{5,127}'
const NO_VALUE = /^(?:unknown|undefined|unavailable|missing|n\/a)$/i
const WHOLE = new RegExp(`^${TOKEN}$`)
// A label at the start of a line, then what closes its own decoration. Prose does not match: nothing after the
// label reads as a value unless the rest of the line has one of the shapes below.
const LABEL = /^[\s>#*_|"'`{,-]*(?:[a-z0-9]+[ _-]){0,2}fingerprint(?:\s*\([^)]*\))?[*_"']*/i
// Closed by its own quote or backtick, and what follows is not part of it.
const CLOSED = new RegExp(`^(\`|"|')(${TOKEN})\\1(?=[\\s,}|]|$)`)
// Otherwise the value is all that is left on the line: bare, or in emphasis that opens and closes around it.
const WHOLE_LINE = new RegExp(`^(?:(\\*\\*|__|\\*|_)(${TOKEN})\\1|(${TOKEN}))\\s*$`)
const IN_JSON = new RegExp(`"fingerprint"\\s*:\\s*"(${TOKEN})"`, 'gi')

export const validFingerprint = (value) => typeof value === 'string' && WHOLE.test(value) && !NO_VALUE.test(value)

/*
 * One line's value, or null. Every character of the value is in TOKEN and every way out is listed here, so nothing
 * is stripped from a value and nothing is cut from one: an emphasis marker counts only as a balanced pair around
 * the whole value (a lone one is no shape at all), a table's closing pipe only after a pipe separator, and at most
 * 128 characters can stand before the closer or the end of the line. A longer value, one with words or another
 * character in it, has no shape and yields nothing, so two different values never read as one.
 */
function labelledValue (line) {
  const label = LABEL.exec(line)
  if (!label) return null
  const rest = line.slice(label[0].length)
  const separated = /^\s*([:=|])(?:(?:\*\*?|__?)\s+|\s*)/.exec(rest)
  // Without a separator only a backticked value says what it is: "Fingerprint `abc123`".
  if (!separated) return /^\s*`/.test(rest) ? CLOSED.exec(rest.trimStart())?.[2] ?? null : null
  const value = rest.slice(separated[0].length)
  const closed = CLOSED.exec(value)
  if (closed) return closed[2]
  const whole = WHOLE_LINE.exec(separated[1] === '|' ? value.replace(/\|\s*$/, '') : value)
  return whole ? whole[2] ?? whole[3] : null
}

/** The fingerprint a report states, or null: none, or several different ones, is no evidence. */
export function reportFingerprint (text) {
  if (typeof text !== 'string') return null
  const found = new Set()
  for (const line of text.split(/\r?\n/)) {
    for (const value of [labelledValue(line), ...[...line.matchAll(IN_JSON)].map((m) => m[1])]) {
      if (value && !NO_VALUE.test(value)) found.add(value)
    }
  }
  return found.size === 1 ? [...found][0] : null
}

const readText = (file) => fs.readFile(file, 'utf8')

const statedByFolder = async (dir, meta, seams) => {
  if (!meta.report) return null
  if (meta.report.fingerprint) return meta.report.fingerprint
  await seams.betweenFolderReads?.(dir)
  return reportFingerprint(await readText(path.join(dir, '000-report', 'response.md')))
}

/*
 * A folder's fingerprint: what its record holds, else what its report states; null when it is no report.
 * A missing file proves nothing while the issue may be moving, and neither does looking at the folder again
 * afterwards: it may have gone and come back. So the read that may conclude "no report here" is made holding
 * the moves lock, under which no issue moves. ENOENT from here means the folder has gone; a lock that cannot be
 * had throws, which the lookup records as pending. Neither is a conclusion.
 */
export async function folderFingerprint (issuesDir, project, id, { seams = {}, waitMs = 10000 } = {}) {
  const dir = path.join(issuesDir, project, id)
  try {
    return await statedByFolder(dir, JSON.parse(await readText(path.join(dir, 'issue.json'))), seams)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await seams.afterMissingRead?.(dir)
  return withMoves(issuesDir, project, async () => {
    const meta = JSON.parse(await readText(path.join(dir, 'issue.json')))
    try {
      return await statedByFolder(dir, meta, {})
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }, { waitMs })
}

// Complete reads of a bundle only, so a failure is never remembered; a bundle read once stays read until it changes.
const bundleReads = new Map()
const BUNDLE_READS_LIMIT = 5000
const MOVED = Symbol('moved')
const RELOCATIONS = 5

class Unread extends Error {}

async function bundleFingerprint (issuesDir, project, id, seams = {}) {
  const { bundle } = bundleFiles(issuesDir, project, id)
  const stat = await fs.stat(bundle).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
  if (!stat) return MOVED
  const seen = bundleReads.get(bundle)
  if (seen?.mtimeMs === stat.mtimeMs && seen.size === stat.size) return seen.fingerprint
  const member = `${id}/000-report/response.md`
  let fingerprint = null
  try {
    await seams.beforeBundleRead?.(bundle)
    // 2 MiB: a report is at most 1 MiB (issues.js createIssue).
    fingerprint = reportFingerprint((await exec('tar', ['-xzOf', bundle, member], { maxBuffer: 2 * 1024 * 1024 })).stdout)
  } catch (error) {
    await seams.afterBundleMiss?.(bundle)
    // "No report in this bundle" is concluded only from a listing of the bundle that shows none. That the bundle
    // lists, or exists, says nothing: it may have moved and come back since the read failed.
    const listed = await exec('tar', ['-tzf', bundle], { maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout.split('\n'), () => null)
    if (listed === null) {
      if (!await fs.stat(bundle).then(() => true, () => false)) return MOVED
      throw new Unread(error.message.split('\n')[0])
    }
    // It holds a report that read did not get: read it again, a bounded number of times, then pending.
    if (listed.includes(member)) return MOVED
  }
  if (bundleReads.size >= BUNDLE_READS_LIMIT) bundleReads.delete(bundleReads.keys().next().value)
  bundleReads.set(bundle, { mtimeMs: stat.mtimeMs, size: stat.size, fingerprint })
  return fingerprint
}

/** What is cheap to know of one entry: when it was opened, a stored fingerprint, or that it is no report. */
async function describeEntry (issuesDir, project, id, place, seams = {}, waitMs = 10000) {
  if (place === 'folder') {
    const dir = path.join(issuesDir, project, id)
    let meta
    try { meta = JSON.parse(await readText(path.join(dir, 'issue.json'))) } catch (error) {
      if (error.code !== 'ENOENT') throw new Unread(error.message)
      await seams.afterMissingRead?.(dir)
      // Held for the conclusion, as in folderFingerprint. A folder with no record while nothing moves is being
      // created: only a report is looked for, and those take turns. No folder at all has moved.
      try {
        const settled = await withMoves(issuesDir, project, async () => {
          const text = await readText(path.join(dir, 'issue.json')).catch((missing) => {
            if (missing.code !== 'ENOENT') throw missing
            return null
          })
          if (text !== null) return JSON.parse(text)
          return await fs.stat(dir).then(() => ({ noRecord: true }), () => MOVED)
        }, { waitMs })
        if (settled === MOVED) return MOVED
        if (settled.noRecord) return { skip: true }
        meta = settled
      } catch (locked) {
        throw new Unread(locked.message)
      }
    }
    if (!meta.report) return { skip: true }
    return { openedAt: meta.openedAt ?? null, fingerprint: meta.report.fingerprint ?? null }
  }
  const files = bundleFiles(issuesDir, project, id)
  let summary = null
  try { summary = JSON.parse(await readText(files.summary)) } catch { /* unreadable: the bundle still answers */ }
  if (!summary && !await fs.stat(files.bundle).then(() => true, () => false)) return MOVED
  if (summary?.issue && !summary.issue.report) return { skip: true }
  return { openedAt: summary?.issue?.openedAt ?? null, fingerprint: summary?.issue?.report?.fingerprint ?? null }
}

async function textFingerprint (issuesDir, project, id, place, seams, waitMs) {
  if (place === 'bundle') return bundleFingerprint(issuesDir, project, id, seams)
  try {
    return await folderFingerprint(issuesDir, project, id, { seams, waitMs })
  } catch (error) {
    if (error.code === 'ENOENT') return MOVED
    throw new Unread(error.message)
  }
}

/** One folder listing and one archive listing, with no issue mid-move between them. */
function snapshot (issuesDir, project, seams, waitMs) {
  const listing = (dir, options) => fs.readdir(dir, options).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return withMoves(issuesDir, project, async () => {
    const folders = (await listing(path.join(issuesDir, project), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && ISSUE_DIR.test(e.name)).map((e) => ({ id: e.name, place: 'folder' }))
    await seams.betweenListings?.()
    const bundles = (await listing(path.join(archiveRoot(issuesDir), project)))
      .filter((n) => n.endsWith('.tar.gz')).map((n) => ({ id: n.slice(0, -'.tar.gz'.length), place: 'bundle' }))
    return [...folders, ...bundles]
  }, { waitMs })
}

/** Where an id is now: its folder, its bundle, or nowhere, which means deleted. */
function locate (issuesDir, project, id, waitMs) {
  const there = (p) => fs.stat(p).then(() => true, () => false)
  return withMoves(issuesDir, project, async () => {
    if (await there(path.join(issuesDir, project, id))) return 'folder'
    return await there(bundleFiles(issuesDir, project, id).bundle) ? 'bundle' : null
  }, { waitMs })
}

/**
 * The newest earlier issue with this fingerprint, as `{repeats, repeatLookup}`; never throws. `excludeId` and
 * `before` keep a rerun to what was earlier than the issue asking. `seams` exist only so a test can land
 * between the steps.
 */
export async function findRepeat ({ issuesDir, project, fingerprint, excludeId = null, before = null, seams = {}, movesWaitMs = 10000 }) {
  const at = new Date().toISOString()
  const pending = (lookup) => ({ repeats: null, repeatLookup: { ...lookup, at } })
  let entries
  try { entries = await snapshot(issuesDir, project, seams, movesWaitMs) } catch (error) {
    console.info(`repeat lookup for ${project}: the archive could not be listed (${error.message})`)
    return pending({ listing: true })
  }
  await seams.afterSnapshot?.()

  const unread = new Set()
  // A read that finds the entry gone looks for it again where it now is, a bounded number of times.
  const follow = async (entry, read) => {
    for (let attempt = 0; attempt <= RELOCATIONS; attempt++) {
      const out = seams.failRead?.(entry) ? MOVED : await read(entry)
      if (out !== MOVED) return out
      if (attempt === RELOCATIONS) break
      const place = await locate(issuesDir, project, entry.id, movesWaitMs).catch(() => undefined)
      if (place === null) return { skip: true }
      if (place === undefined) break
      entry.place = place
    }
    throw new Unread('it kept moving')
  }

  const known = []
  for (const entry of entries) {
    if (entry.id === excludeId) continue
    try {
      const described = await follow(entry, (e) => describeEntry(issuesDir, project, e.id, e.place, seams, movesWaitMs))
      if (described.skip) continue
      // Without a readable record the id's date stands in, which sorts before any time of that day.
      const openedAt = described.openedAt ?? entry.id.slice(0, 10)
      if (before && openedAt >= before) continue
      known.push({ entry, openedAt, fingerprint: described.fingerprint })
    } catch (error) {
      if (!(error instanceof Unread)) throw error
      unread.add(entry.id)
    }
  }
  known.sort((a, b) => (b.openedAt.localeCompare(a.openedAt)) || b.entry.id.localeCompare(a.entry.id))

  for (const { entry, fingerprint: stored } of known) {
    try {
      await seams.beforeRead?.(entry)
      let value = stored
      if (!value) {
        const read = await follow(entry, (e) => textFingerprint(issuesDir, project, e.id, e.place, seams, movesWaitMs))
        if (read?.skip) continue
        value = read
      }
      if (value === fingerprint) return { repeats: { project, id: entry.id, evidence: 'fingerprint', fingerprint }, repeatLookup: null }
    } catch (error) {
      if (!(error instanceof Unread)) throw error
      unread.add(entry.id)
    }
  }
  return unread.size ? pending({ unread: [...unread] }) : { repeats: null, repeatLookup: null }
}

/** `record` (issue.json, or a packed summary's issue) with the outcome of its lookup, when one was pending. */
export async function repeatOutcome (issuesDir, project, id, record) {
  if (!record.repeatLookup) return { repeats: record.repeats ?? null, repeatLookup: null }
  // Unreadable or corrupt is no outcome: still pending, and the next rerun writes it whole.
  const kept = await readText(bundleFiles(issuesDir, project, id).repeatLookup).then(JSON.parse).catch(() => null)
  // An outcome is the issue's it was written for: an id can come free when an issue is deleted.
  if (kept?.openedAt === record.openedAt && record.openedAt) return { repeats: kept.repeats ?? null, repeatLookup: kept.repeatLookup ?? null }
  return { repeats: record.repeats ?? null, repeatLookup: record.repeatLookup }
}

const RETRY_MS = 60 * 1000
const inFlight = new Map()
const lastTried = new Map()
// Only so a test can move the clock and land inside a rerun.
export const lookupRetry = { now: Date.now, seams: {} }

/** Reruns a pending lookup, at most once a minute per issue and once at a time, without waiting on a lock. */
export function completePendingLookup ({ issuesDir, project, id, record }) {
  const key = `${issuesDir}\0${project}/${id}`
  if (inFlight.has(key)) return inFlight.get(key)
  const last = lastTried.get(key)
  if (last !== undefined && lookupRetry.now() - last < RETRY_MS) return Promise.resolve()
  if (!record.report?.fingerprint) return Promise.resolve()
  lastTried.set(key, lookupRetry.now())
  const running = (async () => {
    const out = await findRepeat({ issuesDir, project, fingerprint: record.report.fingerprint, excludeId: id, before: record.openedAt, seams: lookupRetry.seams, movesWaitMs: 0 })
    await writeJson(bundleFiles(issuesDir, project, id).repeatLookup, { openedAt: record.openedAt, repeats: out.repeats, repeatLookup: out.repeatLookup, at: new Date().toISOString() })
  })().catch((error) => { console.warn(`repeat lookup of ${project}/${id} could not be completed: ${error.message}`) })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, running)
  return running
}
