import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './clock.mjs'

/*
 * Revision fingerprint: the identity of a candidate.
 *
 * Deliberately NOT a git diff (which omits untracked files) and NOT a commit hash
 * (which misses uncommitted work). It is a canonical hash over the complete
 * deliverable content set, with deletions recorded explicitly so removing a file
 * changes the fingerprint.
 */

const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.devpanel-lock']

/*
 * How a file's mode enters the fingerprint. `exec-bit` (current) records the
 * executable bit only, the one thing Git carries and a patch can rebuild.
 * `posix` (legacy) recorded every permission bit, which made a candidate with a
 * 0600 file unrebuildable; it is kept only to prove that a revision recorded
 * under it is still byte-for-byte the same content, so it can be re-expressed.
 */
export const FINGERPRINT_RULE = 'exec-bit'
export const LEGACY_FINGERPRINT_RULE = 'posix'

const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex')

async function walk (root, excludes, prefix = '', strict = false, projection = {}, seen = null) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true })
  } catch (error) {
    if (strict) throw error
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // A `.git` entry below the root is a repository the host would resolve
    // (git records it as a gitlink to that repository's HEAD). It is skipped
    // like the root one, but its place is reported (R9-3).
    if (entry.name === '.git' && prefix && seen) seen.nestedGit.push(`${prefix}/.git`)
    if (excludes.includes(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (projection.exclude?.(rel)) continue
    // Delivery reads the same materialized source composition as the candidate.
    // This traversal is read-only; delivery routes changes to bound Git owners.
    if (entry.isSymbolicLink() && projection.materialize?.some(p => rel === p || rel.startsWith(p + '/'))) {
      const stat = await fs.stat(path.join(root, rel))
      if (stat.isDirectory()) out.push(...await walk(root, excludes, rel, strict, projection, seen))
      else if (stat.isFile()) out.push({ rel, link: false })
      else throw new Error(`unsupported materialized source entry: ${rel}`)
      continue
    }
    if (entry.isSymbolicLink()) out.push({ rel, link: true })   // never followed: its identity is its target
    else if (entry.isDirectory()) out.push(...await walk(root, excludes, rel, strict, projection, seen))
    else if (entry.isFile()) out.push({ rel, link: false })
    else if (strict) throw new Error(`unsupported source entry: ${rel}`)
  }
  return out
}

/**
 * A symlink's identity is where it points, not what is there. Following it
 * would fingerprint content outside the candidate — and let a write through
 * the link change something outside while the fingerprint stayed the same.
 */
async function hashEntry (full, link, rule = FINGERPRINT_RULE) {
  if (link) return { contentHash: sha256(`link:${await fs.readlink(full)}`), mode: 'link' }
  const [content, stat] = await Promise.all([fs.readFile(full), fs.stat(full)])
  // Only the executable bit is recorded: it is all Git carries, and the
  // delivered patch is Git's. Recording the other permission bits made a
  // candidate unrebuildable whenever a file was not 0644/0755 (a materialized
  // 0600 copy checks out as 0644), so delivery blocked as unverifiable.
  const mode = rule === LEGACY_FINGERPRINT_RULE
    ? (stat.mode & 0o777).toString(8).padStart(6, '0')
    : (stat.mode & 0o100) ? '000755' : '000644'
  return { contentHash: sha256(content), mode }
}

/**
 * @param dir       the workspace to fingerprint
 * @param baseline  map of path -> contentHash at the base commit, so deletions
 *                  can be recorded rather than silently vanishing
 */
export async function fingerprint (dir, {
  baseCommit = null,
  baseline = new Map(),
  excludes = DEFAULT_EXCLUDES,
  strict = false,
  includePaths = [],
  projection = {},
  clock = systemClock,
  rule = FINGERPRINT_RULE,
  /*
   * Stat-validated reuse, for repeated captures of one tree (integrity checks
   * before and after every turn). `reuse.entries` maps a path to what an earlier
   * capture saw — inode, size, mtime, ctime, permission bits and the resulting
   * hash — and a file whose stat is identical, and was last modified comfortably
   * before that capture began, keeps its hash without being read. ctime cannot
   * be set from user space and changes on every write, rename or chmod, so an
   * identical stat is an unchanged file; a file touched close to the earlier
   * capture (git's "racy" case) is always re-read. `record` receives this
   * capture's stats for the next one.
   */
  reuse = null,
  record = null,
  concurrency = 1
} = {}) {
  if (![FINGERPRINT_RULE, LEGACY_FINGERPRINT_RULE].includes(rule)) throw new Error(`unknown fingerprint rule: ${rule}`)
  // Recorded modes that cannot be read are not "no modes": a fingerprint taken
  // without them would call a mode-only change unchanged. Refuse instead.
  if (baseline.modesError) throw new Error(`cannot fingerprint against a baseline whose recorded modes are unreadable: ${baseline.modesError}`)
  const seenGit = { nestedGit: [] }
  const present = await walk(dir, excludes, '', strict, projection, seenGit)
  const found = new Set(present.map((p) => p.rel))
  // Tracked paths under exclusions (a committed node_modules can be tens of
  // thousands): stat them in parallel, keep their order.
  const extra = includePaths.filter((rel) => !found.has(rel))
  const stats = new Array(extra.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(32, extra.length)) }, async () => {
    for (let i = cursor++; i < extra.length; i = cursor++) {
      stats[i] = await fs.lstat(path.join(dir, extra[i])).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    }
  }))
  for (const [i, rel] of extra.entries()) {
    const stat = stats[i]
    if (!stat) continue
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported tracked source entry: ${rel}`)
    present.push({ rel, link: stat.isSymbolicLink() })
  }
  const entries = []

  const hashed = new Array(present.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < present.length; i = next++) {
      const { rel, link } = present[i]
      const full = path.join(dir, rel)
      if (link || (!reuse && !record)) { hashed[i] = await hashEntry(full, link, rule); continue }
      const stat = await fs.lstat(full)
      const key = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, perm: stat.mode & 0o7777 }
      const seen = reuse?.entries?.get(rel)
      const same = seen && seen.rule === rule && seen.ino === key.ino && seen.size === key.size && seen.mtimeMs === key.mtimeMs &&
        seen.ctimeMs === key.ctimeMs && seen.perm === key.perm && Math.max(key.mtimeMs, key.ctimeMs) < reuse.cutoffMs
      hashed[i] = same ? { contentHash: seen.contentHash, mode: seen.mode } : await hashEntry(full, false, rule)
      record?.set(rel, { ...key, rule, contentHash: hashed[i].contentHash, mode: hashed[i].mode })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, present.length)) }, worker))

  for (const [i, { rel }] of present.entries()) {
    const { contentHash, mode } = hashed[i]
    const was = baseline.get(rel)
    // A baseline that carries modes (recorded under the current rule) lets a
    // mode-only change count: content equal, executable bit flipped.
    const wasMode = rule === FINGERPRINT_RULE ? baseline.modes?.get(rel) : undefined
    const sameMode = wasMode === undefined || wasMode === mode
    entries.push({
      path: rel,
      status: was === undefined ? 'added' : (was === contentHash && sameMode) ? 'unchanged' : 'modified',
      mode,
      contentHash
    })
  }

  // Deletions are explicit: a file present at the base and absent now is part of
  // the candidate, and must change the fingerprint.
  const seen = new Set(present.map((p) => p.rel))
  for (const [rel] of baseline) {
    if (!seen.has(rel)) entries.push({ path: rel, status: 'deleted', contentHash: null })
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))

  const canonical = entries
    .map((e) => [e.path, e.status, e.mode ?? '', e.contentHash ?? ''].join(' '))
    .join(String.fromCharCode(10))

  return {
    algorithm: 'sha256',
    rule,
    baseCommit,
    scope: { includeUntracked: true, excludes },
    entries,
    fingerprint: sha256(canonical),
    computedAt: clock.iso(),
    // Not part of the fingerprint (a `.git` entry is never content); integrity
    // compares it against the provisioned tree.
    nestedGit: seenGit.nestedGit.sort()
  }
}

/**
 * The identity of a tree's bytes, whatever base it was fingerprinted against:
 * each present file's path, mode and content. A revision fingerprint holds each
 * path's status against its baseline and the deletions, so the same bytes on
 * another base have another fingerprint; this stays the same, for a candidate
 * and for a base drive of the same tree (selftest-history.mjs).
 */
export function treeIdentity (entries) {
  const present = (entries ?? []).filter((e) => e.status !== 'deleted' && e.contentHash)
  return sha256(present.map((e) => [e.path, e.mode ?? '', e.contentHash].join('\0')).sort().join('\n'))
}

/**
 * Content hashes of everything in `dir`, for use as a later fingerprint's
 * baseline. The map carries a `modes` map beside it (path -> mode under the
 * current rule), so a change to nothing but the executable bit still counts.
 */
export async function baselineOf (dir, { excludes = DEFAULT_EXCLUDES, projection = {} } = {}) {
  const map = new Map()
  map.modes = new Map()
  for (const { rel, link } of await walk(dir, excludes, '', false, projection)) {
    const { contentHash, mode } = await hashEntry(path.join(dir, rel), link)
    map.set(rel, contentHash)
    map.modes.set(rel, mode)
  }
  return map
}

/**
 * What a workspace's fingerprints leave out beyond the defaults. A worktree
 * never contains the project's snapshot excludes (they are cut from its base),
 * but an in-place run works in the live checkout, where they sit beside the
 * source: runtime state, sockets, secrets and dependency trees a running
 * application keeps changing. Every fingerprint of that checkout skips them.
 * The project's tooling mount targets (`workspace.toolingMounts`) are never
 * the candidate's either: tooling bound read-only into the seat fence.
 */
export function workspaceProjection (workspace) {
  const patterns = workspace?.isolation === 'in-place' ? (workspace.base?.excludes ?? []) : []
  const mounts = workspace?.toolingMounts ?? []
  if (!patterns.length && !mounts.length) return {}
  return { exclude: (rel) => mounts.some((t) => rel === t || rel.startsWith(t + '/')) || patterns.some((pattern) => path.matchesGlob(rel, pattern)) }
}

/**
 * Symlinks under `dir` whose target resolves outside `dir`. These are the
 * links through which a candidate could reach — and change — live files.
 */
export async function escapingLinks (dir, { excludes = ['.git'] } = {}) {
  // Isolation has its own traversal: a link under node_modules or any other
  // path the FINGERPRINT ignores still reaches outside the worktree, so the
  // fingerprint's exclusions must not hide it here.
  const root = await fs.realpath(dir)
  const out = []
  for (const { rel, link } of await walk(dir, excludes)) {
    if (!link) continue
    const full = path.join(dir, rel)
    const target = await fs.readlink(full)
    let resolved
    try { resolved = await fs.realpath(full) } catch { resolved = path.resolve(path.dirname(full), target) }
    if (resolved !== root && !resolved.startsWith(root + path.sep)) out.push({ path: rel, target, resolved })
  }
  return out
}
