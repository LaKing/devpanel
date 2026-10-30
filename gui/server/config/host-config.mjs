import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Installation-specific configuration (docs/host-config.md): this host's
 * projects, host-only roster entries, playbook overrides, release targets and
 * live-check reports.
 * They live in one git-ignored directory beside the publishable tree, and the
 * in-tree files keep working beside them: each category is the union of both by
 * file name, and on the same name the host-config file wins (the in-tree one is
 * reported as shadowed, never an error).
 *
 * One rule for every consumer, JS, tools/releases/host_targets.py and the
 * devpanel skill client alike: DEVPANEL_HOST_CONFIG_DIR, relative to the config
 * root when relative; when unset, <config root>/host-config if it exists, else
 * DEVPANEL_DATA_ROOT/host-config if that variable is set and the directory
 * exists (an installation that keeps its data outside the checkout keeps its
 * configuration there too), else <config root>/host-config. Nothing is looked
 * for outside the checkout unless the variable says where. An empty value is unset, for this and
 * for DEVPANEL_CONFIG_ROOT. Imports nothing of the loader's, so the migration
 * script runs without gui/node_modules.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const HOST_CONFIG_ENV = 'DEVPANEL_HOST_CONFIG_DIR'
export const DEFAULT_CONFIG_ROOT = process.env.DEVPANEL_CONFIG_ROOT || path.resolve(HERE, '..', '..', '..')

export const DATA_ROOT_ENV = 'DEVPANEL_DATA_ROOT'
const isDir = (dir) => { try { return fsSync.statSync(dir).isDirectory() } catch { return false } }

/** The data root a host-config directory may live in before any settings are read: DEVPANEL_DATA_ROOT from `env`, else none. */
export function bootDataRoot (env = process.env) {
  return env[DATA_ROOT_ENV] ? path.resolve(env[DATA_ROOT_ENV]) : null
}

/** Where host configuration lives for this config root; read at call time. */
export function hostConfigDir ({ root = DEFAULT_CONFIG_ROOT, env = process.env } = {}) {
  if (env[HOST_CONFIG_ENV]) return path.resolve(root, env[HOST_CONFIG_ENV])
  const inTree = path.resolve(root, 'host-config')
  if (isDir(inTree)) return inTree
  const data = bootDataRoot(env)
  return data && isDir(path.join(data, 'host-config')) ? path.join(data, 'host-config') : inTree
}

/*
 * The categories. `tree` is relative to the config root, `host` to the host
 * directory; `match` selects what the loader and discovery read, `moves` what
 * the migration moves (a roster entry is host-specific only when it names a
 * person's login: the rest of the roster is the public catalogue; a playbook is
 * the shared default, and a host copy of it is an override, so none moves).
 */
export const CATEGORIES = [
  { id: 'projects', tree: 'projects', host: 'projects', match: (name) => name.endsWith('.yaml'), moves: () => true },
  { id: 'roster', tree: 'roster', host: 'roster', match: (name) => name.endsWith('.yaml'), moves: (name, text) => /^account\s*:/m.test(text) },
  { id: 'playbooks', tree: 'playbooks', host: 'playbooks', match: (name) => name.endsWith('.yaml'), moves: () => false },
  { id: 'releases', tree: 'tools/releases', host: 'releases', match: (name) => name.endsWith('-targets.json'), moves: () => true },
  { id: 'live-reports', tree: 'gui/live/reports', host: 'live-reports', match: () => true, moves: () => true }
]
export const category = (id) => CATEGORIES.find((c) => c.id === id)

async function names (dir, match) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.isDirectory() && match(e.name)).map((e) => e.name)
  } catch {
    return []
  }
}

/** The union of two directories by file name, sorted; the host file wins and records the one it shadows. */
export async function overlay ({ tree, host, match }) {
  const fromTree = new Set(await names(tree, match))
  const fromHost = new Set(await names(host, match))
  return [...new Set([...fromTree, ...fromHost])].sort().map((name) => fromHost.has(name)
    ? { name, file: path.join(host, name), source: 'host', shadows: fromTree.has(name) ? path.join(tree, name) : null }
    : { name, file: path.join(tree, name), source: 'tree', shadows: null })
}

/** One category's effective files for a config root and host directory. */
export function discover (id, { root = DEFAULT_CONFIG_ROOT, hostDir = hostConfigDir({ root }) } = {}) {
  const c = category(id)
  return overlay({ tree: path.join(root, c.tree), host: path.join(hostDir, c.host), match: c.match })
}

const isDirectory = (dir) => fs.stat(dir).then((s) => s.isDirectory(), () => false)

/** Where a live check writes its report: host-config once it exists, else the in-tree directory beside the checks. */
export async function liveReportsDir ({ hostDir = hostConfigDir(), tree }) {
  return await isDirectory(hostDir) ? path.join(hostDir, category('live-reports').host) : tree
}
