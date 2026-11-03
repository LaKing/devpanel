import fs from 'node:fs/promises'
import path from 'node:path'

import { acquire, LockHeld } from './lock.mjs'
import { authorizer, forbiddenRootsReport, homeExemption, knownProjectRoots, walkSelection } from './selection.mjs'
import { GIT_OUTPUT_LIMIT, gitRead, nestedFiles, nestedRepositories } from './working-tree.mjs'

/*
 * The lock on a repository's working files, in its Git common directory. A
 * delivery holds it while it writes; a base snapshot holds it while it reads, so
 * neither sees the other half done (execution-contract.md "Locking").
 *
 * Several are always taken in sorted order, by everyone: the order is what makes
 * a deadlock impossible. Both sides wait, because with several live runs in one
 * project a held lock is ordinary. A dead owner's lock is taken over (lock.mjs).
 */
export const SOURCE_LOCK_FILE = 'devpanel-source-delivery.lock'
export const SOURCE_LOCK_WAIT_MS = 15 * 60_000
const POLL_MS = 200

export async function acquireSourceLocks (repositories, { purpose, runId = null, clock, signal = null, waitMs = SOURCE_LOCK_WAIT_MS }) {
  const locks = []
  try {
    for (const repository of [...new Set(repositories)].sort()) {
      locks.push(await acquire(path.join(repository, SOURCE_LOCK_FILE), { purpose, runId, clock, signal, waitMs, pollMs: POLL_MS }))
    }
    return locks
  } catch (error) {
    await releaseSourceLocks(locks)
    throw error
  }
}

export async function releaseSourceLocks (locks) {
  for (const lock of [...locks].reverse()) await lock.release()
}

const NUL = String.fromCharCode(0)
const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const readGit = (args) => gitRead('git', args, { maxBuffer: GIT_OUTPUT_LIMIT }).then((r) => r.stdout)

/** The Git common directory of the repository `dir` belongs to, as delivery names it; null when git names none. */
async function commonDirectory (dir) {
  try {
    return await fs.realpath((await readGit(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim())
  } catch { return null }
}

/** Of a directory that itself carries a `.git` entry: null when git does not take it for the root of a repository. */
export async function repositoryRootedAt (dir) {
  try {
    const [top] = (await readGit(['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel'])).trim().split('\n')
    if (await fs.realpath(top) !== await fs.realpath(dir)) return null
  } catch { return null }
  return commonDirectory(dir)
}

/** The links `git add -A` would carry into a snapshot: tracked, and untracked but not ignored. */
async function checkoutLinks (projectPath, excluded) {
  const root = await fs.realpath(projectPath)
  const tracked = (await readGit(['-C', projectPath, 'ls-files', '--stage', '-z'])).split(NUL).filter((l) => l.startsWith('120000 ')).map((l) => l.slice(l.indexOf('\t') + 1))
  const others = (await readGit(['-C', projectPath, 'ls-files', '--others', '--exclude-standard', '-z'])).split(NUL).filter(Boolean)
  const out = []
  for (const rel of [...tracked, ...others]) {
    if (excluded(rel)) continue
    const full = path.join(root, rel)
    if (!(await fs.lstat(full).then((s) => s.isSymbolicLink(), () => false))) continue
    const resolved = await fs.realpath(full).catch(() => null)   // dangling: nothing to read through it
    if (resolved && !inside(root, resolved)) out.push({ path: rel, resolved })
  }
  return out
}

/**
 * What a snapshot of `projectPath` under `policy` will read that a delivery could
 * write, found before it reads anything: the checkout's repository, the owners
 * behind its materialized links (through links inside them too), repositories
 * inside a granted tree that has no owner, and the nested repositories
 * `nestedRepositories: include` reads directly.
 *
 * { repositories, unidentified, noRepository }. `unidentified` is a `.git` entry
 * git does not take for a repository: the lock a delivery there would use cannot
 * be named. `noRepository` is what stays unlocked: a delivery writes only into a
 * repository (sourceTarget; owner-delivery refuses a target with no owner).
 * Read-only: throws what the walk's authorizer throws.
 */
export async function snapshotRepositories (projectPath, policy = {}) {
  const repositories = new Set(), unidentified = [], noRepository = []
  const source = await commonDirectory(projectPath)
  if (source) repositories.add(source)
  else unidentified.push(projectPath)
  const add = async (dir) => {
    const repository = await repositoryRootedAt(dir)
    if (repository) repositories.add(repository)
    else unidentified.push(dir)
  }

  const kind = typeof policy.base === 'object' && policy.base ? 'commit' : policy.base ?? 'head'
  const excludes = kind === 'working-tree' || policy.selection === 1 ? (policy.excludes ?? []) : []
  const mounts = (policy.tooling?.mounts ?? []).map((m) => m.target)
  const leftOut = [...excludes, ...mounts]
  const excluded = (rel) => leftOut.some((pattern) => path.matchesGlob(rel, pattern) || path.matchesGlob(rel, `${pattern}/**`))

  const links = []
  if (kind === 'working-tree' && policy.nested === 'include') {
    const tracked = await nestedRepositories({ projectPath, git: (args) => readGit(['-C', projectPath, ...args]) })
    const others = (await readGit(['-C', projectPath, 'ls-files', '--others', '--exclude-standard', '-z'])).split(NUL).filter((name) => name.endsWith('/')).map((name) => name.slice(0, -1))
    const untracked = []
    for (const name of others) if (await fs.lstat(path.join(projectPath, name, '.git')).then(() => true, () => false)) untracked.push(name)
    for (const root of [...new Set([...tracked, ...untracked])].filter((r) => !excluded(r))) {
      await add(path.join(projectPath, root))
      const files = await nestedFiles({ projectPath, root, excludes: leftOut, run: readGit, onRepository: (rel) => add(path.join(projectPath, rel)) })
      const real = await fs.realpath(projectPath)
      for (const f of files.filter((f) => f.link)) {
        const resolved = await fs.realpath(f.full).catch(() => null)
        if (resolved && !inside(real, resolved)) links.push({ path: f.rel, resolved })
      }
    }
  }
  if (policy.symlinks === 'materialize') {
    links.push(...await checkoutLinks(projectPath, excluded))
    if (policy.selection === 1) {
      const { roots: forbidden } = await forbiddenRootsReport()
      const authorize = authorizer({ known: await knownProjectRoots(), grants: policy.materializeGrants ?? [], forbidden, exempt: await homeExemption() })
      for (const link of links) {
        const owners = await walkSelection({ linkPath: link.path, resolved: link.resolved, consumerExcludes: leftOut, authorize, onFile: () => {}, onRepository: add })
        for (const { owner, path: rel } of owners) {
          if (owner) await add(owner)
          else noRepository.push(rel)
        }
      }
    } else {
      // Selection 0, not reachable by a new run: a plain copy of each target.
      for (const link of links) {
        const directory = await fs.stat(link.resolved).then((s) => s.isDirectory(), () => false)
        const repository = await commonDirectory(directory ? link.resolved : path.dirname(link.resolved))
        if (repository) repositories.add(repository)
        else noRepository.push(link.path)
      }
    }
  }
  return { repositories: [...repositories].sort(), unidentified: [...new Set(unidentified)], noRepository: [...new Set(noRepository)].sort() }
}

const REMEDY = 'A snapshot holds the delivery lock of every repository it reads, so it never captures a half-applied delivery. Give this account write access to that repository\'s Git directory, leave the path out of the snapshot (workspace excludes), or use a base that reads no live tree ("head" or a commit, without materialize).'

export const snapshotLockError = (detail, cause = null) => Object.assign(new Error(`The base snapshot cannot be proved consistent: ${detail} ${REMEDY}`), { code: 'SNAPSHOT_LOCK_UNAVAILABLE', ...(cause ? { cause } : {}) })
export const unidentifiedMessage = (paths) => `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ', …' : ''} ha${paths.length === 1 ? 's' : 've'} a .git entry git does not take for a repository, so the lock a delivery there would use cannot be named.`

/**
 * Hold the locks for one snapshot. `confirm(dir)` is asked of each repository as
 * it is about to be read: one discovery missed (created since) refuses, rather
 * than being read unlocked. Refusals carry the code and the remedy.
 */
export async function holdSnapshotLocks ({ projectPath, policy, runId, clock, signal, discover = snapshotRepositories, waitMs = SOURCE_LOCK_WAIT_MS }) {
  const found = await discover(projectPath, policy)
  if (found.unidentified.length) throw snapshotLockError(unidentifiedMessage(found.unidentified))
  const started = clock.now()
  let locks
  try {
    locks = await acquireSourceLocks(found.repositories, { purpose: 'base-snapshot', runId, clock, signal, waitMs })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw snapshotLockError(error instanceof LockHeld ? `the delivery lock at ${error.file} stayed held for ${Math.round(waitMs / 60_000)} minutes (${error.message}).` : `the delivery lock could not be taken: ${error.message}.`, error)
  }
  const locked = new Set(found.repositories)
  const record = { repositories: found.repositories, waitMs: clock.now() - started, ...(found.noRepository.length ? { noRepository: found.noRepository } : {}) }
  let released = false
  return {
    record,
    async confirm (dir) {
      const repository = await repositoryRootedAt(dir)
      if (!repository) throw snapshotLockError(unidentifiedMessage([dir]))
      if (!locked.has(repository)) throw Object.assign(new Error(`The snapshot would read repository ${repository} (at ${dir}), which was not there when its locks were taken. Start again.`), { code: 'MOVING_WORKTREE' })
    },
    async release () {
      if (released) return
      released = true
      await releaseSourceLocks(locks)
    }
  }
}
