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
const isDir = (p) => { try { return fsSync.statSync(p).isDirectory() } catch { return false } }

/**
 * The discovered projects under `root`, as a Map of identity → directory (unresolved),
 * sorted by identity; null without projectDiscovery. A `*` segment skips dot entries,
 * and of two relative paths that join to the same identity only the first is kept.
 */
export function discoveredProjects (root = projectsRoot(), discovery = projectDiscovery()) {
  if (!discovery) return null
  let dirs = ['']
  for (const glob of discovery.pattern.split('/').filter(Boolean)) {
    const match = segmentPattern(glob)
    const next = []
    for (const rel of dirs) {
      let names = []
      try { names = fsSync.readdirSync(path.join(root, rel)) } catch { continue }
      for (const name of names.sort()) {
        if ((name.startsWith('.') && !glob.startsWith('.')) || !match.test(name)) continue
        if (isDir(path.join(root, rel, name))) next.push(path.join(rel, name))
      }
    }
    dirs = next
  }
  const found = new Map()
  for (const rel of dirs) {
    const dir = path.join(root, rel)
    if (!discovery.markers.some((marker) => fsSync.existsSync(path.join(dir, marker)))) continue
    const id = rel.split(path.sep).join('-') + PROJECT_SUFFIX
    if (!found.has(id)) found.set(id, dir)
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)))
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
