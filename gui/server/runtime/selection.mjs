import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { issuesRoot, listProjectDirs, projectsRoot } from '../project-path.mjs'
import { hostSettings } from '../config/host-settings.mjs'
import { hostPlatform } from './platform.mjs'

/*
 * Snapshot selection, v1 (fence.selection: 1; the seat-access fence's
 * "Snapshot selection", harness/README.md "Seat hygiene").
 *
 * A symlink that leaves the checkout (an application's `@` collections linking
 * into a shared framework checkout) used to be materialized by copying its target
 * recursively, dependency trees and build output included: every run of such an
 * application copied, committed and then fingerprinted ~40,000 files it never delivers.
 * Under v1 a materialized target carries what its OWNING repository would carry
 * at that path — `git ls-files --cached --others --exclude-standard` in the
 * owner — minus the consumer's exclusions.
 *
 * The same traversal serves two callers, so they cannot disagree:
 *   - launch copies the selected files into the worktree;
 *   - delivery lists the selected paths of the live checkout, so an ignored
 *     build file under a materialized link is not mistaken for source drift.
 * The owner's ignore rules are recorded as content hashes at launch; if they
 * differ at delivery, delivery refuses (`selection-rules-changed`) instead of
 * guessing which selection the candidate was reviewed under.
 *
 * Authorization: a target must be owned by a known project repository (the
 * projects the panel itself resolves) or be named by an explicit grant. An
 * unowned directory is refused before anything is copied: recording that it has
 * no owner does not authorize its contents.
 */

export const SELECTION_RULE = 'owner-ls-files/v1'

const exec = promisify(execFile)
const git = async (dir, args) => (await exec('git', ['-C', dir, ...args], {
  maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
})).stdout
const sha = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const posix = (p) => p.split(path.sep).join('/')

export class SelectionError extends Error {
  constructor (message, code, detail = {}) { super(message); this.code = code; Object.assign(this, detail) }
}

/**
 * The repositories of the projects the panel resolves (project-path.mjs
 * listProjectDirs: the `*-project` entries or the discovered ones), reduced to
 * its canonical repository root, so an alias and its target are one project and
 * a directory that merely looks like a project is not one.
 */
export async function knownProjectRoots (projectsDir = projectsRoot()) {
  const roots = new Set()
  const panel = await fs.realpath(PANEL_ROOT).catch(() => PANEL_ROOT)
  for (const { dir } of await listProjectDirs(projectsDir)) {
    try {
      const real = await fs.realpath(dir)
      const root = await fs.realpath((await git(real, ['rev-parse', '--show-toplevel'])).trim())
      // The panel's own checkout is a project too, but never a source of
      // materialized content: it holds the token, every issue and every run.
      if (root !== panel) roots.add(root)
    } catch { /* not a repository: not a known project */ }
  }
  return roots
}

/** The panel's own checkout (this file lives in gui/server/runtime). */
export const PANEL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')

/**
 * Roots no materialization may be, contain or lie inside, whoever owns them
 * (design rule (b)): the real home (keys, CLI homes, credentials), the panel
 * checkout (token, issues, supervisor state, every run's worktree and scratch),
 * and the container filesystems mounted on this host (production and staging
 * data; found as idmapped mounts, plus the conventional names under the
 * projects directory: `<prefix>.<anything>` for each of the host settings'
 * selection.forbiddenPrefixes, default production and staging). Ownership by a
 * known project never lifts this.
 *
 * The mount table is the host's (platform.mjs): read on Linux, not applicable
 * on darwin, which has no container mounts to find. `mounts` says which, so a
 * table that was not read is never mistaken for one without mounts. A test
 * names its own `mountinfo` file.
 */
export async function forbiddenRootsReport ({ home = os.homedir(), projectsDir = projectsRoot(), panelRoot = PANEL_ROOT, issuesDir = issuesRoot(), dataRoot = hostSettings().dataRoot, mountinfo = null, prefixes = hostSettings().selection.forbiddenPrefixes, platform = hostPlatform() } = {}) {
  const roots = new Set()
  const add = async (p) => { roots.add(await fs.realpath(p).catch(() => path.resolve(p))) }
  await add(home)
  await add(panelRoot)
  // Every run's worktree, scratch and evidence, and the panel's Git stores:
  // covered by the panel's checkout by default, roots of their own when the
  // host moved them (host settings dataRoot).
  const panel = await fs.realpath(PANEL_ROOT).catch(() => PANEL_ROOT)
  for (const dir of [issuesDir, dataRoot]) {
    if (!dir) continue
    const real = await fs.realpath(dir).catch(() => path.resolve(dir))
    if (!inside(panel, real)) roots.add(real)
  }
  let entries = []
  try { entries = await fs.readdir(projectsDir) } catch { /* none */ }
  const conventional = new RegExp(`^(?:${prefixes.join('|')})\\.`)
  for (const name of entries) if (conventional.test(name)) await add(path.join(projectsDir, name))
  const table = mountinfo
    ? await fs.readFile(mountinfo, 'utf8').then((text) => ({ status: 'read', source: mountinfo, text }), () => ({ status: 'unreadable', source: mountinfo, text: '' }))
    : await platform.mountTable()
  for (const line of table.text.split(NL)) {
    const fields = line.split(' ')
    if (fields.length > 5 && /(^|,)idmapped(,|$)/.test(fields[5])) await add(fields[4].replace(/\\040/g, ' '))
  }
  return { roots, mounts: { status: table.status, source: table.source, ...(table.reason ? { reason: table.reason } : {}) } }
}

export const forbiddenRoots = async (options) => (await forbiddenRootsReport(options)).roots

/**
 * The home rule's one exception (host settings selection.allowedHomePaths):
 * `exempt(root, p)` is true when the forbidden `root` is the home and `p` lies
 * inside one of the allowed directories, each strictly inside the home. Every
 * other forbidden root still applies, and a path containing the home never passes.
 */
export async function homeExemption ({ home = os.homedir(), allowed = hostSettings().selection.allowedHomePaths } = {}) {
  const realHome = await fs.realpath(home).catch(() => path.resolve(home))
  const dirs = []
  for (const dir of allowed) {
    const real = await fs.realpath(dir).catch(() => path.resolve(dir))
    if (real.startsWith(realHome + path.sep)) dirs.push(real)
  }
  return (root, p) => root === realHome && dirs.some((dir) => inside(dir, p))
}
const NL = String.fromCharCode(10)

async function ownerRoot (resolved, directory) {
  try {
    return await fs.realpath((await git(directory ? resolved : path.dirname(resolved), ['rev-parse', '--show-toplevel'])).trim())
  } catch { return null }
}

/**
 * The files that decide what the owner ignores at `relTarget`: every
 * `.gitignore` from the owner root down to and below the target, the
 * repository's `info/exclude` and the user-level excludes file, each by content
 * hash (absent is recorded as absent). The SET is part of the record, so a new,
 * removed or moved rule file is a change like an edited one.
 */
export async function ruleSources (owner, relTarget) {
  const files = new Set()
  const parts = relTarget === '.' ? [] : relTarget.split('/')
  for (let i = 0; i <= parts.length; i++) files.add(posix(path.join(...parts.slice(0, i), '.gitignore')))
  const below = relTarget === '.' ? ':(glob)**/.gitignore' : `:(glob)${relTarget}/**/.gitignore`
  for (const p of (await git(owner, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', below])).split('\0').filter(Boolean)) files.add(p)
  const out = {}
  for (const rel of [...files].sort()) {
    out[rel] = await fs.readFile(path.join(owner, rel)).then(sha, () => 'absent')
  }
  const exclude = path.resolve(owner, (await git(owner, ['rev-parse', '--git-path', 'info/exclude'])).trim())
  out[':info/exclude'] = await fs.readFile(exclude).then(sha, () => 'absent')
  const configured = (await git(owner, ['config', '--path', '--get', 'core.excludesFile']).catch(() => '')).trim()
  const user = configured || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore')
  out[`:core.excludesFile:${user}`] = await fs.readFile(user).then(sha, () => 'absent')
  return out
}

/**
 * Walk what one materialized link carries under v1. Calls `onFile(consumerRel,
 * sourceFull)` for every selected regular file (links inside the target are
 * followed to their file, or recursed into as a target of their own), and
 * returns the owners and rule records it relied on. `authorize(owner, resolved)`
 * throws to refuse; delivery passes none, since launch already authorized.
 */
export async function walkSelection ({ linkPath, resolved, consumerExcludes = [], authorize = null, onFile, onSkip = () => {} }) {
  const owners = []
  const excluded = (rel) => consumerExcludes.some((pattern) => path.matchesGlob(rel, pattern) || path.matchesGlob(rel, `${pattern}/**`))

  // `chain` holds the directories being walked above this one: a link back into
  // one of them is a cycle. Two links to the same file, or to sibling
  // directories, are two copies, as the recursive copy made them.
  async function target (consumerRel, real, chain = new Set()) {
    const stat = await fs.stat(real)
    const directory = stat.isDirectory()
    if (directory && [...chain].some((up) => inside(up, real) || inside(real, up))) { onSkip(consumerRel, 'link cycle'); return }
    if (!directory && !stat.isFile()) throw new SelectionError(`materialized target ${consumerRel} is neither a file nor a directory`, 'MATERIALIZE_UNSUPPORTED', { path: consumerRel })
    // Forbidden roots are checked on the path alone, before Git is run in the
    // target: a repository planted there must not get to describe itself.
    if (authorize) await authorize({ owner: undefined, resolved: real, path: consumerRel })
    const owner = await ownerRoot(real, directory)
    if (authorize) await authorize({ owner, resolved: real, path: consumerRel })
    if (!directory) {
      if (excluded(consumerRel)) return
      if (owner) {
        // A file target carries the file only if its owner would: an ignored
        // `.env` or `secrets/token` behind a link is not source (audit I1).
        const relFile = posix(path.relative(owner, real))
        owners.push({ path: consumerRel, owner, target: relFile, rules: await ruleSources(owner, posix(path.dirname(relFile)) || '.') })
        const listed = (await git(owner, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relFile])).split('\0').filter(Boolean)
        if (!listed.includes(relFile)) { onSkip(consumerRel, 'owner-ignored file'); return }
      } else owners.push({ path: consumerRel, owner: null, target: real, rules: {} })
      await onFile(consumerRel, real)
      return
    }
    if (!owner) {
      // Only reachable through an explicit grant (authorize refused otherwise
      // at launch): no owner has rules, so every regular file is carried, and
      // links inside are not followed.
      owners.push({ path: consumerRel, owner: null, target: real, rules: {} })
      const walk = async (dir, rel) => {
        for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const dest = `${rel}/${entry.name}`
          if (entry.name === '.git' || excluded(dest)) continue
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), dest)
          else if (entry.isFile()) await onFile(dest, path.join(dir, entry.name))
          else onSkip(dest, entry.isSymbolicLink() ? 'link inside an unowned grant' : 'special file')
        }
      }
      await walk(real, consumerRel)
      return
    }
    const relTarget = posix(path.relative(owner, real)) || '.'
    owners.push({ path: consumerRel, owner, target: relTarget, rules: await ruleSources(owner, relTarget) })
    const listed = (await git(owner, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relTarget])).split('\0').filter(Boolean)
    for (const ownerRel of [...new Set(listed)].sort()) {
      const full = path.join(owner, ownerRel)
      const within = posix(path.relative(real, full))
      if (within.startsWith('..')) continue
      const dest = `${consumerRel}/${within}`
      if (excluded(dest)) continue
      const lstat = await fs.lstat(full).catch(() => null)
      if (!lstat) continue // tracked but deleted in the owner's working tree
      if (lstat.isSymbolicLink()) {
        const next = await fs.realpath(full).catch(() => null)
        if (!next) { onSkip(dest, 'dangling link'); continue }
        await target(dest, next, new Set([...chain, real]))
      } else if (lstat.isFile()) {
        await onFile(dest, full)
      } else if (lstat.isDirectory()) {
        // A nested repository listed as one entry. Its contents are another
        // repository's selection and its `.git` must never be copied.
        onSkip(dest, 'nested repository')
      } else onSkip(dest, 'special file')
    }
  }

  await target(linkPath, resolved)
  return owners
}

/**
 * The authorization launch applies to every target, nested ones included.
 */
export function authorizer ({ known, grants = [], forbidden = new Set(), exempt = () => false }) {
  return async ({ owner, resolved, path: rel }) => {
    for (const root of forbidden) {
      if (exempt(root, resolved)) continue
      if (inside(root, resolved) || inside(resolved, root)) {
        throw new SelectionError(`materialized target ${rel} (${resolved}) reaches ${root}, which no run may read`, 'MATERIALIZE_FORBIDDEN', { path: rel, root })
      }
    }
    // The first call carries no owner yet (the path check above is the point);
    // the second decides by ownership or grant.
    if (owner === undefined) return
    if (owner && known.has(owner)) return
    for (const grant of grants) {
      const root = await fs.realpath(grant.path).catch(() => null)
      if (root && inside(root, resolved)) return
    }
    throw new SelectionError(owner
      ? `materialized target ${rel} belongs to ${owner}, which is not a project this panel resolves; name it in workspace.materializeGrants to copy it`
      : `materialized target ${rel} (${resolved}) is not owned by a Git repository; name it in workspace.materializeGrants to copy it`, 'MATERIALIZE_UNAUTHORIZED', { path: rel, owner })
  }
}

/** Copy one selected file into the worktree, keeping only the executable bit. */
export async function copySelected (worktree, consumerRel, sourceFull) {
  const dest = path.join(worktree, consumerRel)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(sourceFull, dest)
  const mode = (await fs.stat(sourceFull)).mode
  await fs.chmod(dest, (mode & 0o100) ? 0o755 : 0o644)
}

/**
 * At delivery: the consumer paths the live checkout's materialized links carry
 * under the recorded rule, and which owner rule files changed since launch.
 */
export async function selectionState ({ sourcePath, symlinks }) {
  const selection = symlinks?.selection
  if (!selection) return null
  const paths = new Set()
  const changed = []
  for (const root of symlinks.materialized ?? []) {
    const real = await fs.realpath(path.join(sourcePath, root))
    const owners = await walkSelection({ linkPath: root, resolved: real, consumerExcludes: selection.consumerExcludes ?? [],
      onFile: (rel) => { paths.add(rel) } })
    for (const now of owners) {
      const then = (selection.owners ?? []).find((o) => o.path === now.path && o.owner === now.owner && o.target === now.target)
      if (!then) { changed.push(`${now.path}: owner or target differs from launch`); continue }
      const keys = new Set([...Object.keys(then.rules), ...Object.keys(now.rules)])
      for (const key of keys) if (then.rules[key] !== now.rules[key]) changed.push(`${now.path}: ${key}`)
    }
  }
  return { paths, changed }
}

/**
 * A related project's run-start snapshot (Phase 2, P3): what the project's
 * repository would carry (tracked plus untracked-not-ignored), minus the given
 * exclusions, exported as plain files without `.git`, so no history travels
 * with it (P1). Links inside are kept as links (they dangle in the fence when
 * they leave it); nested repositories and special files are skipped. Copies
 * use a copy-on-write clone where the filesystem supports one.
 */
export async function exportProject ({ projectPath, target, excludes = [] }) {
  const root = await fs.realpath(projectPath)
  const head = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null
  const excluded = (rel) => excludes.some((pattern) => path.matchesGlob(rel, pattern) || path.matchesGlob(rel, `${pattern}/**`))
  const listed = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean)
  await fs.mkdir(target, { recursive: true })
  let files = 0, links = 0, bytes = 0
  const skipped = []
  let beyondLinks = 0
  // The index can name paths beyond a link: a repository that tracks copies of a
  // directory the working tree replaces with a symlink. Exporting the link first
  // and then its tracked children wrote through the new link into the live link
  // target, and the chmod below made that target read-only. Only paths whose
  // parent is a real directory inside the project are exported.
  const realParents = new Map()
  const realParent = (rel) => {
    const dir = path.dirname(rel)
    if (!realParents.has(dir)) realParents.set(dir, fs.realpath(path.join(root, dir)).then((real) => real === path.join(root, dir), () => false))
    return realParents.get(dir)
  }
  for (const rel of [...new Set(listed)].sort()) {
    if (excluded(rel)) continue
    if (!(await realParent(rel))) { beyondLinks++; continue }
    const source = path.join(root, rel)
    const stat = await fs.lstat(source).catch(() => null)
    if (!stat) continue
    const dest = path.join(target, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    if (stat.isSymbolicLink()) { await fs.symlink(await fs.readlink(source), dest); links++ }
    else if (stat.isFile()) {
      await fs.copyFile(source, dest, (await import('node:fs')).constants.COPYFILE_FICLONE)
      await fs.chmod(dest, (stat.mode & 0o100) ? 0o555 : 0o444)
      files++; bytes += stat.size
    } else skipped.push({ path: rel, reason: stat.isDirectory() ? 'nested repository' : 'special file' })
  }
  return { path: root, head, snapshot: target, files, links, bytes, skipped, beyondLinks, rule: SELECTION_RULE }
}
