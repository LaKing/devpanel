import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { hostSettings } from './config/host-settings.mjs'

/*
 * Where projects live and what makes a directory one, defined once for the
 * server and the harness: every `<name>-project` entry of the projects root
 * (DEVPANEL_PROJECTS_DIR, else the host settings' projectsRoot, else the
 * directory holding the panel's own checkout). The root is read on each call;
 * a module that keeps it in a constant (issues.js, supervisor.mjs) reads it at load.
 *
 * With the host settings' projectDiscovery, the projects are instead the
 * directories under the root that match its pattern (`*` per path segment) and
 * hold one of its marker files. Their identity stays one path component: the
 * relative path joined with `-`, plus the suffix (`2026/shop` → `2026-shop-project`),
 * so issue folders, URLs and projects/<id>.yaml work unchanged.
 */
export const projectsRoot = () => process.env.DEVPANEL_PROJECTS_DIR ?? hostSettings().projectsRoot

/*
 * The issue root, where issues, runs (their worktrees, private Git directories
 * and scratch) and supervisor state live: DEVPANEL_ISSUES_DIR, else the host
 * settings' <dataRoot>/issues, else issues/ in the panel's own checkout. Never
 * derived from the projects root. Read on each call; issues.js keeps it at load.
 */
const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const inData = (name) => hostSettings().dataRoot ? path.join(hostSettings().dataRoot, name) : path.join(PANEL_DIR, name)
export const issuesRoot = () => process.env.DEVPANEL_ISSUES_DIR ?? inData('issues')

/*
 * The rest of what the panel writes for itself, beside the issue root: the
 * operator token, the server log and the TLS certificate. Each keeps its own
 * variable, then <dataRoot>/<name>, then the panel's checkout.
 */
export const tokenFile = () => process.env.DEVPANEL_TOKEN_FILE ?? inData('.devpanel-token')
export const logDir = () => process.env.DEVPANEL_LOG_DIR ?? inData('logs')
export const certDir = () => process.env.DEVPANEL_CERT_DIR ?? inData('cert')
export const projectDiscovery = () => hostSettings().projectDiscovery
export const PROJECT_SUFFIX = '-project'
export const isProjectName = (name) => name.endsWith(PROJECT_SUFFIX)
export const projectLabel = (name) => name.slice(0, -PROJECT_SUFFIX.length)

const segmentPattern = (glob) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
/** The error code that means a path is simply not there; any other read error (ENOTDIR: a file where a directory belongs) means it could not be read. */
const ABSENT = new Set(['ENOENT'])

/*
 * Discovery walks the tree synchronously and projectPath() runs on most requests,
 * so a walk is reused for DISCOVERY_TTL_MS: a project created or removed shows
 * within that, the way an edit of the host settings is seen without a restart.
 */
const DISCOVERY_TTL_MS = 2000
const walks = new Map()

/**
 * The discovered projects under `root`, as a Map of identity → directory (unresolved),
 * sorted by identity; null without projectDiscovery. A `*` segment skips dot entries,
 * and of two relative paths that join to the same identity only the first is kept;
 * discoveryCollisions() names the others.
 */
export function discoveredProjects (root = projectsRoot(), discovery = projectDiscovery()) {
  return discoveryWalk(root, discovery)?.found ?? null
}

/** The relative paths discovery left out because an earlier one has their identity: [{ id, kept, dropped }]. */
export function discoveryCollisions (root = projectsRoot(), discovery = projectDiscovery()) {
  return discoveryWalk(root, discovery)?.collisions ?? []
}

function discoveryWalk (root, discovery) {
  if (!discovery) return null
  const key = `${root}\0${discovery.pattern}\0${discovery.markers.join('\0')}`
  const cached = walks.get(key)
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached
  const walk = { at: Date.now(), ...walkDiscovery(root, discovery) }
  walks.set(key, walk)
  return walk
}

/*
 * The walk also records every read that failed for another reason than absence
 * (`unreadable`: a directory it could not list or enter, a marker it could not
 * stat), so a caller that must not mistake an unreadable tree for an empty one
 * (the full verification's scope, readProjectDirs) can refuse instead.
 */
function walkDiscovery (root, discovery) {
  const unreadable = []
  const failed = (p, error) => { if (!ABSENT.has(error.code)) unreadable.push({ path: p, code: error.code ?? 'EIO' }) }
  const dirAt = (p) => { try { return fsSync.statSync(p).isDirectory() } catch (error) { failed(p, error); return false } }
  let dirs = ['']
  for (const glob of discovery.pattern.split('/').filter(Boolean)) {
    const match = segmentPattern(glob)
    const next = []
    for (const rel of dirs) {
      let names = []
      try { names = fsSync.readdirSync(path.join(root, rel)) } catch (error) { failed(path.join(root, rel), error); continue }
      for (const name of names.sort()) {
        if ((name.startsWith('.') && !glob.startsWith('.')) || !match.test(name)) continue
        if (dirAt(path.join(root, rel, name))) next.push(path.join(rel, name))
      }
    }
    dirs = next
  }
  const found = new Map()
  const collisions = []
  for (const rel of dirs) {
    const dir = path.join(root, rel)
    const marked = discovery.markers.some((marker) => {
      try { fsSync.statSync(path.join(dir, marker)); return true } catch (error) { failed(path.join(dir, marker), error); return false }
    })
    if (!marked) continue
    const id = rel.split(path.sep).join('-') + PROJECT_SUFFIX
    if (!found.has(id)) found.set(id, dir)
    else collisions.push({ id, kept: path.relative(root, found.get(id)), dropped: rel })
  }
  return { found: new Map([...found].sort(([a], [b]) => a.localeCompare(b))), collisions, unreadable }
}

/**
 * The projects under `root` as the listing reads them, read now (never the cached walk),
 * with every read that failed for another reason than absence: `{ projects: [{id, dir}],
 * unreadable: [{path, code}] }`. The full verification decides its scope from this, so a
 * directory it cannot read refuses the cycle rather than leaving a project out.
 */
export async function readProjectDirs (root = projectsRoot(), discovery = projectDiscovery()) {
  if (discovery) {
    const walk = walkDiscovery(root, discovery)
    return { projects: [...walk.found].map(([id, dir]) => ({ id, dir })), unreadable: walk.unreadable }
  }
  const unreadable = []
  let entries
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch (error) {
    if (!ABSENT.has(error.code)) unreadable.push({ path: root, code: error.code ?? 'EIO' })
    return { projects: [], unreadable }
  }
  const dirs = await Promise.all(entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && isProjectName(entry.name))
    .map(async (entry) => {
      const dir = path.join(root, entry.name)
      if (entry.isDirectory()) return { id: entry.name, dir }
      try { return (await fs.stat(dir)).isDirectory() ? { id: entry.name, dir } : null } catch (error) {
        if (!ABSENT.has(error.code)) unreadable.push({ path: dir, code: error.code ?? 'EIO' })
        return null
      }
    }))
  return { projects: dirs.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id)), unreadable }
}

/**
 * Every project's identity and directory (unresolved): the discovered ones, else
 * each `<name>-project` entry of the root that is (or links to) a directory.
 */
export async function listProjectDirs (root = projectsRoot()) {
  const discovered = discoveredProjects(root)
  if (discovered) return [...discovered].map(([id, dir]) => ({ id, dir }))
  let entries
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return [] }
  // A symlinked project counts only while it resolves to a directory: one dangling
  // link must not fail every listing that resolves project paths.
  const dirs = await Promise.all(entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && isProjectName(entry.name))
    .map(async (entry) => {
      const dir = path.join(root, entry.name)
      if (entry.isDirectory()) return { id: entry.name, dir }
      return (await fs.stat(dir).catch(() => null))?.isDirectory() ? { id: entry.name, dir } : null
    }))
  return dirs.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id))
}

/** Where a project lives, unresolved (no realpath). */
export const projectPath = (project, root = projectsRoot()) => discoveredProjects(root)?.get(project) ?? path.join(root, project)

export async function resolveProjectPath (project, { projectsDir = projectsRoot() } = {}) {
  if (!project || path.basename(project) !== project || ['.', '..'].includes(project)) throw new Error('Invalid project identity')
  const canonical = await fs.realpath(projectPath(project, projectsDir))
  if (!(await fs.stat(canonical)).isDirectory()) throw new Error(`Project is not a directory: ${canonical}`)
  return canonical
}
