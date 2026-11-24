import fs from 'node:fs/promises'
import path from 'node:path'

import { certDir, issuesRoot, listProjectDirs, logDir, projectsRoot, tokenFile } from '../project-path.mjs'
import { hostSettings } from '../config/host-settings.mjs'

/*
 * What no host setting may open to a seat, in one place: the host settings that
 * reach into the home (fence.readOnly, selection.allowedHomePaths) and the ones
 * that grant host directories to every seat (fence.readOnly) are checked here, so
 * their guards cannot drift apart. A grant that overlaps one of these is refused,
 * never narrowed: the canaries cannot catch it afterwards, because defaultCanaries
 * (harness/fence.mjs) treats whatever lies inside a granted path as covered.
 */

/** The home entries that hold logins, keys and credentials. */
export const PRIVATE_HOME = ['.ssh', '.gnupg', '.claude', '.claude.json', '.codex', '.gemini', '.config', '.netrc', '.git-credentials', '.npmrc', '.aws', '.docker', '.kube']

const PANEL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')
const isRoot = (p) => p === path.sep
const overlaps = (a, b) => a === b || isRoot(a) || isRoot(b) || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
const real = (p) => fs.realpath(p).catch(() => path.resolve(p))

/** The private home entry `dir` (a real path) is, contains or lies in; null when none. */
export function privateHomeHit (realHome, dir) {
  return PRIVATE_HOME.map((name) => path.join(realHome, name)).find((p) => overlaps(dir, p)) ?? null
}

/**
 * The panel's own data or a project that `dir` (a real path) is, contains or lies
 * in; null when none: the panel's checkout, the data root, the issue root, token,
 * certificate and logs, the projects root (contained) and every project.
 */
export async function panelDataHit (dir, { projectsDir = projectsRoot() } = {}) {
  const own = [PANEL_ROOT, hostSettings().dataRoot, issuesRoot(), tokenFile(), certDir(), logDir()].filter(Boolean)
  for (const p of own) {
    const r = await real(p)
    if (overlaps(dir, r)) return r
  }
  const root = await real(projectsDir)
  if (root === dir || isRoot(dir) || root.startsWith(dir + path.sep)) return root
  for (const { dir: project } of await listProjectDirs(projectsDir)) {
    const r = await real(project)
    if (overlaps(dir, r)) return r
  }
  return null
}
