import fs from 'node:fs/promises'
import path from 'node:path'

import { engineGitEnv } from './engine-git.mjs'
import { snapshotRepositories } from './source-lock.mjs'
import { GIT_OUTPUT_LIMIT, gitRead } from './working-tree.mjs'

/*
 * What a full verification cycle knows about the bytes it tested (execution-contract.md
 * "Full verification freeze", "A green cycle commits only what it tested" and "A snapshot
 * taken during edits"):
 *
 * - snapshotRecord: where an entry's snapshot lives and what it held, persisted on the entry
 *   so a later comparison (and recover()) needs nothing from memory;
 * - readCheckouts / motionOf: whether the checkouts were being edited around the snapshot
 *   (information only, no verdict reads it);
 * - snapshotDiff: an entry's snapshot against the same checkout snapshotted again, before
 *   the checkpoint chain;
 * - committedBeyond: a checkpoint's commit against every tested view of that checkout
 *   (approach (a)): each side is listed in the repository that holds it and compared by blob
 *   id, so an instance's snapshot can vouch for a framework commit it cannot resolve.
 *
 * Every git command here only reads (rev-parse, ls-tree, cat-file, diff-tree, status).
 * Nothing is reverted, stashed or committed.
 */

/** Paths shown in a record, an issue or an event; every list also carries its total. */
export const SHOWN_PATHS = 20
/** The window before a snapshot in which a changed path means the checkout was moving. */
export const MOTION_WINDOW_MS = 5 * 60 * 1000

const NUL = String.fromCharCode(0)

/** One read-only git call; stdout. */
export async function readGit (args) {
  const { stdout } = await gitRead('git', args, { maxBuffer: GIT_OUTPUT_LIMIT, env: engineGitEnv({ GIT_OPTIONAL_LOCKS: '0' }) })
  return stdout
}

const bounded = (items) => ({ paths: items.slice(0, SHOWN_PATHS), total: items.length })
const inside = (rel, prefix) => !prefix || rel === prefix || rel.startsWith(`${prefix}/`)
const below = (rel, prefix) => (!prefix ? rel : rel === prefix ? '' : rel.slice(prefix.length + 1))
const matches = (rel, patterns) => patterns.some((p) => path.matchesGlob(rel, p) || path.matchesGlob(rel, `${p}/**`))

async function commonDir (checkout, git) {
  return fs.realpath((await git(['-C', checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
}

/**
 * What an entry's snapshot was, kept on the entry: the repository holding its commit (the
 * project's Git store, else the checkout's common dir), the commit of the project's own tree
 * (the working-tree commit under a materialized one), the paths it never held, and each
 * materialized link with the owning checkout and the owner-relative path it copied.
 */
export async function snapshotRecord ({ workspace, policy = {}, projectDir, git = readGit }) {
  const repository = policy.repository === 1 && policy.store ? await fs.realpath(policy.store) : await commonDir(projectDir, git)
  const symlinks = workspace.symlinks ?? {}
  const materialized = symlinks.materialized ?? []
  const ownCommit = materialized.length ? (await git(['--git-dir', repository, 'rev-parse', `${workspace.baseCommit}^1`])).trim() : workspace.baseCommit
  const toolingMounts = workspace.toolingMounts ?? []
  const consumerExcludes = symlinks.selection?.consumerExcludes ?? [...(policy.excludes ?? []), ...toolingMounts]
  const skipped = (symlinks.selection?.skipped ?? []).map((s) => s.path)
  return {
    repository,
    ownCommit,
    excludes: [...(policy.excludes ?? []), ...toolingMounts, ...(workspace.base?.nested ?? []).map((n) => n.path)],
    links: (symlinks.owners ?? []).filter((o) => o.owner?.path && o.resolved && materialized.includes(o.path)).map((o) => ({
      path: o.path, owner: o.owner.path, prefix: path.relative(o.owner.path, o.resolved),
      consumerExcludes, skipped: skipped.filter((s) => inside(s, o.path)).map((s) => below(s, o.path))
    }))
  }
}

/** The checkouts an entry's snapshot read: the project's and each link's owner. */
export const checkoutsOf = (projectDir, snapshot) => [...new Set([projectDir, ...(snapshot?.links ?? []).map((l) => l.owner)].filter(Boolean))]

/** The checkout a path of a (materialized) snapshot belongs to, and the path in it. */
export function ownerOf (rel, projectDir, links = []) {
  const link = links.find((l) => inside(rel, l.path))
  return link ? { checkout: link.owner, path: [link.prefix, below(rel, link.path)].filter(Boolean).join('/') } : { checkout: projectDir, path: rel }
}

// ------------------------------------------------------------- readings

/** The work trees of the repositories a snapshot of the checkout would read (source-lock.mjs). */
export async function snapshotCheckouts (projectDir, policy = {}) {
  const found = await snapshotRepositories(projectDir, policy).catch(() => ({ repositories: [] }))
  return found.repositories.filter((r) => path.basename(r) === '.git').map((r) => path.dirname(r))
}

/**
 * One reading of checkouts: per checkout, every path git status lists (modified, added,
 * deleted, untracked) with its modification time and size, or `deleted`.
 */
export async function readCheckouts (checkouts, { git = readGit, now = Date.now } = {}) {
  const out = { at: now(), checkouts: [] }
  for (const checkout of [...new Set(checkouts)]) {
    try {
      const listed = (await git(['-C', checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])).split(NUL).filter(Boolean).map((l) => l.slice(3))
      const paths = {}
      for (const rel of listed) {
        const st = await fs.lstat(path.join(checkout, rel)).catch(() => null)
        paths[rel] = st ? { mtimeMs: st.mtimeMs, size: st.size } : { deleted: true }
      }
      out.checkouts.push({ checkout, paths })
    } catch (error) {
      out.checkouts.push({ checkout, error: error.message })
    }
  }
  return out
}

/**
 * Whether checkouts were moving around a snapshot, from a reading before it and one after:
 * the newest modification among the changed paths, the paths changed within `windowMs` before
 * the snapshot began (or since), and those that differ between the two readings.
 */
export function motionOf ({ before, after, windowMs = MOTION_WINDOW_MS }) {
  const changed = []
  for (const c of after.checkouts) for (const [rel, s] of Object.entries(c.paths ?? {})) changed.push({ checkout: c.checkout, path: rel, ...s })
  const newest = changed.filter((c) => !c.deleted).sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null
  const recent = changed.filter((c) => !c.deleted && c.mtimeMs >= before.at - windowMs).sort((a, b) => b.mtimeMs - a.mtimeMs).map((c) => ({ checkout: c.checkout, path: c.path, at: new Date(c.mtimeMs).toISOString() }))
  const during = []
  for (const c of after.checkouts) {
    const prior = before.checkouts.find((b) => b.checkout === c.checkout)
    if (!prior?.paths || !c.paths) continue
    for (const rel of new Set([...Object.keys(prior.paths), ...Object.keys(c.paths)])) {
      if (JSON.stringify(prior.paths[rel] ?? null) !== JSON.stringify(c.paths[rel] ?? null)) during.push({ checkout: c.checkout, path: rel })
    }
  }
  const unread = [...before.checkouts, ...after.checkouts].filter((c) => c.error).map((c) => ({ checkout: c.checkout, error: c.error }))
  return {
    readAt: { before: new Date(before.at).toISOString(), after: new Date(after.at).toISOString() },
    windowMs,
    newest: newest ? { checkout: newest.checkout, path: newest.path, at: new Date(newest.mtimeMs).toISOString() } : null,
    changed: changed.length,
    recent: bounded(recent),
    during: bounded(during),
    ...(unread.length ? { unread } : {}),
    // A checkout whose reading failed leaves it unknown: never read as still.
    moving: unread.length ? null : recent.length > 0 || during.length > 0
  }
}

/** The paths a moving snapshot's record names first: changed between the readings, then recently. */
export const movingPaths = (motion) => {
  const seen = new Set()
  return [...(motion?.during?.paths ?? []), ...(motion?.recent?.paths ?? [])].filter((p) => { const k = `${p.checkout}\0${p.path}`; return !seen.has(k) && seen.add(k) }).slice(0, SHOWN_PATHS)
}

// -------------------------------------------------- the recheck before the chain

/**
 * An entry's snapshot commit against the same checkout snapshotted again (both cut in the
 * entry's repository): equal trees, or the changed paths grouped by the checkout owning them.
 */
export async function snapshotDiff ({ repository, from, to, projectDir, links = [], git = readGit }) {
  const tree = async (c) => (await git(['--git-dir', repository, 'rev-parse', `${c}^{tree}`])).trim()
  if (await tree(from) === await tree(to)) return { sameTree: true, moved: [] }
  const names = (await git(['--git-dir', repository, 'diff-tree', '-r', '--no-renames', '--name-only', '-z', from, to])).split(NUL).filter(Boolean)
  const byCheckout = new Map()
  for (const rel of names) {
    const { checkout, path: p } = ownerOf(rel, projectDir, links)
    byCheckout.set(checkout, [...(byCheckout.get(checkout) ?? []), p])
  }
  return { sameTree: false, moved: [...byCheckout].map(([checkout, paths]) => ({ checkout, ...bounded(paths) })) }
}

/** Remove a ref the recheck's own snapshot left (it never names anything a run uses). */
export async function forgetRef (repository, ref, git = readGit) {
  await git(['--git-dir', repository, 'update-ref', '-d', ref]).catch(() => {})
}

// ---------------------------------------------- the commit against the tested bytes

/** `<mode> <type> <oid>\t<path>` entries of a tree under a path, keyed by the path below it. */
async function listTree (where, commit, at, git) {
  const out = (await git([...where, 'ls-tree', '-r', '-z', '--full-tree', commit, ...(at ? ['--', at] : [])])).split(NUL).filter(Boolean)
  const map = new Map()
  for (const line of out) {
    const tab = line.indexOf('\t')
    const [mode, , oid] = line.slice(0, tab).split(' ')
    const rel = line.slice(tab + 1)
    if (inside(rel, at)) map.set(below(rel, at), { mode, oid })
  }
  return map
}

const objectFormat = async (where, git) => (await git([...where, 'rev-parse', '--show-object-format']).catch(() => 'sha1\n')).trim()

/**
 * The version files a checkpoint is expected to change, and how: only the version itself, each
 * rule answering whether the committed bytes are the tested bytes with exactly that change.
 * Anything else in them makes the file untested.
 */
const VERSION_RULES = {
  version: (tested, committed, before, after) => {
    const lines = tested.split('\n')
    return lines[0].trim() === before && committed === [after, ...lines.slice(1)].join('\n')
  },
  // The top-level "version" only.
  'package.json': (tested, committed, before, after) => jsonVersionsOnly(tested, committed, before, after, (doc) => [doc]),
  // The top-level "version" and packages[""].version only.
  'package-lock.json': (tested, committed, before, after) => jsonVersionsOnly(tested, committed, before, after, (doc) => [doc, doc.packages?.['']].filter(Boolean))
}

const sameJson = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v

/**
 * Located structurally: the tested document with its named objects' `version` set from `before` to `after` must
 * equal the committed one, the top-level version must read `after`, and the bytes may differ only where the
 * version string was written (the committed text with every `"<after>"` turned back into `"<before>"` is the
 * tested text). A nested version, any other key, or reformatting makes it false.
 */
function jsonVersionsOnly (tested, committed, before, after, holders) {
  let t, c
  try { t = JSON.parse(tested); c = JSON.parse(committed) } catch { return false }
  if (!t || typeof t !== 'object' || t.version !== before || c?.version !== after) return false
  for (const holder of holders(t)) if (holder.version === before) holder.version = after
  if (!sameJson(t, c)) return false
  return committed.split(JSON.stringify(after)).join(JSON.stringify(before)) === tested
}

/**
 * The checkpoint's commit `commit` in `checkout` against every tested view of that checkout
 * (approach (a)). A view is the project's own snapshot (`at` and `prefix` empty) or an
 * instance's materialized copy of a part of it (`at` the link in the instance snapshot,
 * `prefix` the owner-relative path). The tested side is listed in the view's repository and
 * the committed side in the checkout; they are compared by mode and blob id. A path a view
 * holds that the commit holds differently (`differs-from-tested`) or not at all
 * (`absent-from-commit`), or that the commit holds and the view does not, is untested, unless
 * it is a root version file whose committed bytes are the tested bytes with only the version
 * changed (`bumped`). A path the commit changed since `headBefore` that no view holds is
 * untested as `outside-every-snapshot`. Different object formats make the comparison `incomparable`.
 */
export async function committedBeyond ({ checkout, commit, headBefore = null, views = [], versionBefore = null, versionAfter = null, git = readGit }) {
  const here = ['-C', checkout]
  const dropOf = (view) => (rel) => matches(view.at ? `${view.at}/${rel}`.replace(/\/$/, '') : rel, view.consumerExcludes ?? []) || matches(rel, view.excludes ?? []) || (view.skipped ?? []).some((s) => inside(rel, s)) || (view.links ?? []).some((l) => inside(rel, l))
  const covered = (p) => views.some((v) => inside(p, v.prefix) && !dropOf(v)(below(p, v.prefix)))
  const format = await objectFormat(here, git)
  for (const view of views) {
    if (await objectFormat(['--git-dir', view.repository], git) !== format) {
      const all = [...(await listTree(here, commit, '', git)).keys()]
      return { state: 'incomparable', reason: 'object-format', commit, untested: bounded(all.map((p) => ({ path: p, reason: 'incomparable' }))), bumped: [], views: views.length }
    }
  }
  const differing = new Map()
  for (const view of views) {
    const drop = dropOf(view)
    const tested = await listTree(['--git-dir', view.repository], view.commit, view.at, git)
    const committed = await listTree(here, commit, view.prefix, git)
    // Both sides in full: a tested path the commit lacks (deleted, or an untracked file the snapshot held that
    // went away) is a difference as much as a committed path the view never held.
    for (const rel of new Set([...tested.keys(), ...committed.keys()])) {
      if (drop(rel)) continue
      const t = tested.get(rel)
      const c = committed.get(rel)
      if (t && c && t.mode === c.mode && t.oid === c.oid) continue
      const p = [view.prefix, rel].filter(Boolean).join('/')
      if (!differing.has(p)) differing.set(p, { view, tested: t, committed: c })
    }
  }
  const untested = []
  const bumped = []
  for (const [p, d] of differing) {
    const rule = VERSION_RULES[p]
    if (rule && d.tested && d.committed && versionBefore && versionAfter && versionBefore !== versionAfter) {
      const testedText = await git(['--git-dir', d.view.repository, 'cat-file', 'blob', d.tested.oid]).catch(() => null)
      const committedText = await git([...here, 'cat-file', 'blob', d.committed.oid]).catch(() => null)
      if (testedText !== null && committedText !== null && d.tested.mode === d.committed.mode && rule(testedText, committedText, versionBefore, versionAfter)) { bumped.push(p); continue }
      untested.push({ path: p, reason: 'beyond-version-change' })
      continue
    }
    untested.push({ path: p, reason: d.committed ? 'differs-from-tested' : 'absent-from-commit' })
  }
  const changed = headBefore
    ? (await git([...here, 'diff-tree', '-r', '--no-renames', '--name-only', '-z', headBefore, commit])).split(NUL).filter(Boolean)
    : [...(await listTree(here, commit, '', git)).keys()]
  for (const p of changed) if (!covered(p) && !differing.has(p)) untested.push({ path: p, reason: 'outside-every-snapshot' })
  return { state: 'compared', commit, untested: bounded(untested), bumped, views: views.length }
}

/**
 * The tested views of a checkout among a cycle's entries: the entry of the project itself
 * (its own tree) and every link an entry materialized from that checkout.
 */
export function testedViews (checkout, project, entries) {
  const views = []
  for (const e of entries) {
    const s = e.snapshot
    if (!s?.repository || !s.baseCommit) continue
    if (e.project === project && s.ownCommit) views.push({ repository: s.repository, commit: s.ownCommit, at: '', prefix: '', excludes: s.excludes ?? [], links: (s.links ?? []).map((l) => l.path) })
    for (const l of s.links ?? []) if (l.owner === checkout) views.push({ repository: s.repository, commit: s.baseCommit, at: l.path, prefix: l.prefix, consumerExcludes: l.consumerExcludes ?? [], skipped: l.skipped ?? [] })
  }
  return views
}
