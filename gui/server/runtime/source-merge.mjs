import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineGitEnv } from './engine-git.mjs'

/*
 * Three-way merge of a delivery's drifted own paths (source-delivery.mjs,
 * owner-delivery.mjs). When the source checkout changed a path the approved
 * patch also changes, the path is merged: base = the run's captured base
 * commit, ours = the source file now, theirs = the candidate's file. A clean
 * merge is applied; a conflict is recorded with its lines and nothing at all is
 * written. Binary files, mode changes, symlinks, and a deletion or addition on
 * one side never merge: they conflict unless both sides are identical.
 *
 * Every conflict carries `lines: [{start, end, side}]`, 1-based and inclusive.
 * `side` names the file they count in: `source` (the checkout's file now), or
 * `candidate` when the source no longer has the file. An empty file is {0, 0}.
 */

const sha = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const run = (args, { cwd } = {}) => new Promise((resolve) => {
  execFile('git', args, { cwd, env: engineGitEnv(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0, stdout, stderr: String(stderr) }))
})

/** What no check ran on, stated on the delivery record (AC5: no per-module check tier exists). */
export const MERGE_CHECK = Object.freeze({ ran: false, reason: 'the project has no per-module check tier; no check ran on the merged bytes' })

/** `git apply --exclude` takes a wildmatch pattern: a path is excluded only as itself. */
export const excludeArg = (p) => `--exclude=${p.replace(/[\\*?[]/g, (c) => '\\' + c)}`

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0)
const lineCount = (bytes) => !bytes.length ? 0 : bytes.toString('latin1').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0)
const whole = (bytes, side) => {
  const n = lineCount(bytes)
  return [{ start: n ? 1 : 0, end: n, side }]
}
const splitLines = (bytes) => {
  const lines = bytes.toString('latin1').split('\n')
  if (bytes.at(-1) === 10) lines.pop()
  return lines
}

/** -U0 hunks of a → b as base half-open intervals [s, e) and the replacing side's [os, oe). */
async function hunks (dir, a, b) {
  const d = await run(['diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', a, b], { cwd: dir })
  if (d.code > 1) throw new Error(d.stderr.trim() || 'git diff failed')
  const out = []
  for (const m of d.stdout.toString('latin1').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [bs, bc, os, oc] = [Number(m[1]), m[2] == null ? 1 : Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])]
    const s = bc ? bs - 1 : bs
    const o = oc ? os - 1 : os
    out.push({ s, e: s + bc, os: o, oe: o + oc })
  }
  return out
}

/** Where base position `x` lands on a side, given that side's hunks entirely before it. */
const mapped = (x, sideHunks) => x + sideHunks.filter((h) => h.e <= x).reduce((n, h) => n + (h.oe - h.os) - (h.e - h.s), 0)

/**
 * The conflicting regions of a text merge, in the source file's lines: base
 * hunks of the two sides that overlap or touch are one region (xdiff's rule),
 * and a region where both sides made the same change is no conflict.
 */
async function conflictLines (dir, files, oursBytes, theirsBytes) {
  const ours = await hunks(dir, files.base, files.ours)
  const theirs = await hunks(dir, files.base, files.theirs)
  const touch = (a, b) => !(a.e < b.s || b.e < a.s)
  const groups = []
  for (const t of theirs) {
    const hit = ours.filter((o) => touch(o, t))
    if (!hit.length) continue
    const members = { ours: new Set(hit), theirs: new Set([t]) }
    const into = groups.find((g) => hit.some((o) => g.ours.has(o)))
    if (into) { hit.forEach((o) => into.ours.add(o)); into.theirs.add(t) } else groups.push(members)
  }
  const [oursLines, theirsLines] = [splitLines(oursBytes), splitLines(theirsBytes)]
  const ranges = []
  for (const g of groups) {
    const all = [...g.ours, ...g.theirs]
    const s = Math.min(...all.map((h) => h.s))
    const e = Math.max(...all.map((h) => h.e))
    const span = (sideHunks, inGroup) => {
      const start = mapped(s, sideHunks.filter((h) => !inGroup.has(h)))
      const length = (e - s) + [...inGroup].reduce((n, h) => n + (h.oe - h.os) - (h.e - h.s), 0)
      return [start, start + length]
    }
    const [os, oe] = span(ours, g.ours)
    const [ts, te] = span(theirs, g.theirs)
    if (oursLines.slice(os, oe).join('\n') === theirsLines.slice(ts, te).join('\n')) continue
    ranges.push(oe > os ? { start: os + 1, end: oe, side: 'source' } : { start: Math.max(1, os), end: Math.max(1, os), side: 'source' })
  }
  return ranges
}

/**
 * A side as the destination fingerprint projected it: a symlink only where the
 * entry records one; otherwise the file's bytes, read through any link (a
 * materialized file link reads as its owner's file, as delivery fingerprints it).
 */
async function read (file, link) {
  const missing = (error) => { if (error.code === 'ENOENT') return null; throw error }
  if (link) {
    const target = await fs.readlink(file).catch(missing)
    return target === null ? null : { bytes: Buffer.from(target), hash: sha(`link:${target}`), link: true }
  }
  const bytes = await fs.readFile(file).catch(missing)
  return bytes === null ? null : { bytes, hash: sha(bytes), link: false }
}

/**
 * Merge each drifted own path. `entries`: [{ path, want, got, baseHash, baseMode }]
 * (want: the candidate's fingerprint entry; got: the destination's). `readBase(p)`
 * returns the base bytes from the run's repository. Ours is read under `sourceRoot`
 * (through links, as the destination is fingerprinted), theirs under `candidateRoot`.
 * Writes nothing outside a temporary directory. Returns { merged, conflicts } or
 * { refusal: { state, error } } when a side does not hash as it was read.
 */
export async function mergeDrifted ({ entries, readBase, sourceRoot, candidateRoot }) {
  const merged = []
  const conflicts = []
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-merge-'))
  try {
    for (const { path: p, want, got, baseHash, baseMode } of entries) {
      const same = want.status === 'deleted' ? got?.status === 'deleted' : got?.contentHash === want.contentHash && got?.mode === want.mode
      if (same) { merged.push({ path: p, hunks: 0, identical: true }); continue }
      const ours = got?.status === 'deleted' ? null : await read(path.join(sourceRoot, p), got?.mode === 'link')
      const theirs = want.status === 'deleted' ? null : await read(path.join(candidateRoot, p), want.mode === 'link')
      if ((ours?.hash ?? null) !== (got?.status === 'deleted' ? null : got?.contentHash ?? null)) return { refusal: { state: 'source-drift', error: `The source changed while it was read (${p}).` } }
      if ((theirs?.hash ?? null) !== (want.status === 'deleted' ? null : want.contentHash)) return { refusal: { state: 'unverifiable', error: `The candidate's ${p} does not match the approved revision.` } }
      const conflict = (kind) => conflicts.push({ path: p, kind, lines: ours ? whole(ours.bytes, 'source') : whole(theirs?.bytes ?? Buffer.alloc(0), 'candidate') })
      if (!ours || !theirs) { conflict('deleted'); continue }
      if (baseHash == null) { conflict('added'); continue }
      const base = await readBase(p)
      if (baseMode === 'link' || ours.link || theirs.link) { conflict('symlink'); continue }
      if (sha(base) !== baseHash) return { refusal: { state: 'unverifiable', error: `The base of ${p} does not match the run's baseline.` } }
      if ((baseMode != null && (baseMode !== got.mode || baseMode !== want.mode)) || got.mode !== want.mode) { conflict('mode'); continue }
      if (isBinary(base) || isBinary(ours.bytes) || isBinary(theirs.bytes)) { conflict('binary'); continue }
      const files = { ours: path.join(scratch, 'ours'), base: path.join(scratch, 'base'), theirs: path.join(scratch, 'theirs') }
      await fs.writeFile(files.ours, ours.bytes)
      await fs.writeFile(files.base, base)
      await fs.writeFile(files.theirs, theirs.bytes)
      const result = await run(['merge-file', '-p', files.ours, files.base, files.theirs], { cwd: scratch })
      if (result.code < 0 || result.code >= 255) { conflict('binary'); continue }
      if (result.code > 0) {
        const lines = await conflictLines(scratch, files, ours.bytes, theirs.bytes)
        conflicts.push({ path: p, kind: 'text', lines: lines.length ? lines : whole(ours.bytes, 'source').map((r) => ({ ...r, approximate: true })) })
        continue
      }
      const count = (await hunks(scratch, files.base, files.theirs)).length
      merged.push({ path: p, hunks: count, from: ours.hash, to: sha(result.stdout), mode: want.mode, bytes: result.stdout })
    }
    return { merged, conflicts }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** The record of a merge, without the bytes. */
export const mergeRecord = (merged, applied = true) => merged.map(({ path: p, hunks: n, identical }) => ({ path: p, hunks: n, ...(identical ? { identical: true } : {}), ...(applied ? {} : { applied: false }) }))

/** "a.txt lines 5–7 (source)" for one conflict. */
export function describeConflict (c) {
  const kinds = { binary: 'binary', mode: 'mode change', symlink: 'symlink', added: 'added on both sides', deleted: c.lines?.[0]?.side === 'candidate' ? 'deleted in the source' : 'deleted in the candidate' }
  const ranges = (c.lines ?? []).map((r) => r.end === 0 ? '(empty)' : r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`)
  const side = c.lines?.[0]?.side === 'candidate' ? " of the candidate's file" : ''
  const one = (c.lines ?? []).length === 1 && c.lines[0].start === c.lines[0].end && c.lines[0].end !== 0
  const what = [side ? null : c.lines?.[0]?.side ?? 'source', kinds[c.kind] ?? null, c.lines?.some((r) => r.approximate) ? 'approximate' : null].filter(Boolean).join(', ')
  return `${c.path} ${one ? 'line' : 'lines'} ${ranges.join(', ') || '(none)'}${side} (${what})`
}

/** The refusal message for conflicts. */
export const conflictMessage = (conflicts) =>
  `The approved patch conflicts with changes in the source at ${conflicts.slice(0, 5).map(describeConflict).join('; ')}${conflicts.length > 5 ? '; …' : ''}.`

/** Write merged bytes in place: same directory, same mode, then rename. */
export async function writeMerged (root, entry) {
  const full = path.join(root, entry.path)
  const stat = await fs.stat(full)
  const temp = path.join(path.dirname(full), `.${path.basename(full)}.devpanel-merge-${process.pid}`)
  await fs.writeFile(temp, entry.bytes)
  await fs.chmod(temp, stat.mode & 0o7777)
  await fs.rename(temp, full)
}
