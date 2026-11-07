import fs from 'node:fs/promises'
import path from 'node:path'

import { collectionMatcher } from './modules-tier.mjs'

/*
 * The module pool (execution-contract.md "Module locks"): a framework project and
 * every instance whose projects/<id>.yaml names it (`framework: <id>`) share one
 * pool of modules. A module is `<collection>/<module>/`, with the collections each
 * member declares for its modules tier (`infrastructure.testDrive.modules.collections`).
 *
 * The pool is read from the members' checkouts. A module's owner is the member whose
 * real checkout holds the module's real directory, so a framework collection an
 * instance reaches through a symlink belongs to the framework, and the instance's own
 * collections to the instance. Its name is the lock key: the same framework module is
 * one lock for every member. A project with modules and no framework, named by no
 * instance, is a pool of its own; a project without a modules declaration has no pool.
 */

const collectionsOf = (project) => project?.infrastructure?.testDrive?.modules?.collections ?? null

/** The pool's id (its framework, or the project itself) for a project, or null when it has none. */
export function poolIdOf (projectId, projects) {
  const project = projects.get(projectId)
  if (!project) return null
  if (project.framework) return project.framework
  const named = [...projects.values()].some((p) => p.framework === projectId)
  return collectionsOf(project) || named ? projectId : null
}

/** The pool's members in order: the framework first, then the instances naming it, by id. */
export function poolMembers (poolId, projects) {
  if (!poolId || !projects.has(poolId)) return []
  const instances = [...projects.values()].filter((p) => p.framework === poolId).map((p) => p.id).sort()
  return [poolId, ...instances]
}

const realpath = (p) => fs.realpath(p).catch(() => null)
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep)

/**
 * The pool of `projectId`, read now: `{ id, framework, members: [{project, path, collections, frameworkCollections}],
 * hookReader, modules: Map(name -> {owner, collection}), ambiguous }`, or null when the project has none.
 * `resolvePath(project)` gives a member's checkout; a checkout that cannot be read contributes no modules
 * and is listed in `unreadable`.
 */
export async function poolOf (projectId, { projects, resolvePath }) {
  const id = poolIdOf(projectId, projects)
  if (!id) return null
  const ids = poolMembers(id, projects)
  const members = []
  for (const member of ids) {
    const collections = collectionsOf(projects.get(member)) ?? []
    let dir = null
    try { dir = await resolvePath(member) } catch { dir = null }
    members.push({ project: member, path: dir, real: dir ? await realpath(dir) : null, collections })
  }
  const modules = new Map()
  const ambiguous = []
  const unreadable = []
  for (const member of members) {
    if (!member.real) { unreadable.push(member.project); continue }
    const isCollection = collectionMatcher(member.collections)
    const top = await fs.readdir(member.path, { withFileTypes: true }).catch(() => null)
    if (!top) { unreadable.push(member.project); continue }
    for (const entry of top.filter((e) => isCollection(e.name))) {
      const collectionDir = path.join(member.path, entry.name)
      const inner = await fs.readdir(collectionDir, { withFileTypes: true }).catch(() => [])
      for (const m of inner) {
        const moduleDir = path.join(collectionDir, m.name)
        const stat = await fs.stat(moduleDir).catch(() => null)
        if (!stat?.isDirectory()) continue
        const real = await realpath(moduleDir)
        const owner = real ? members.find((o) => o.real && inside(real, o.real))?.project ?? null : null
        if (!owner) continue   // a module outside every member's checkout is no member's
        const name = `${entry.name}/${m.name}`
        const known = modules.get(name)
        if (known && known.owner !== owner) { if (!ambiguous.includes(name)) ambiguous.push(name); continue }
        modules.set(name, { owner, collection: entry.name })
      }
    }
  }
  const framework = projects.get(id)
  return {
    id,
    // Null for a project that is a pool of its own.
    framework: ids.length > 1 ? id : null,
    members: members.map(({ project, path: p, collections }) => ({ project, path: p, collections })),
    // The framework's collections: what a subscriber drive replaces with the candidate's (module-hooks.mjs).
    frameworkCollections: collectionsOf(framework) ?? [],
    hookReader: ids.map((m) => projects.get(m)?.modulePool?.hookReader).find(Boolean) ?? null,
    modules,
    ambiguous: ambiguous.sort(),
    unreadable
  }
}

/** The pool as JSON (run records, readiness): modules as a sorted {name: owner} object. */
export function poolRecord (pool) {
  if (!pool) return null
  const { modules, ...rest } = pool
  return { ...rest, owners: Object.fromEntries([...modules].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, m]) => [name, m.owner])) }
}
