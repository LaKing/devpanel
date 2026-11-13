import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { certDir, issuesRoot, projectPath, projectsRoot, resolveProjectPath, tokenFile } from '../project-path.mjs'
import { hostSettings } from '../config/host-settings.mjs'
import { privateHomeHit } from '../runtime/private-paths.mjs'

/*
 * What a consult seat may read (docs/consult.md "Access"): the project's live
 * checkout with what it links to, the projects it declares related, the issue's
 * whole folder and the asking run's worktree, read-only. A seat of a run sees a
 * snapshot of tracked files; this seat is asked precisely because it can see
 * the rest (logs, runtime state, every earlier run), so the checkout is bound
 * as it stands and only credentials are masked.
 *
 * Every root is checked before it is granted, because the fence's canaries
 * treat whatever lies inside a granted path as covered (harness/fence.mjs
 * defaultCanaries): a link in a checkout must not be able to open the home, a
 * credential directory, the whole projects root or a container filesystem.
 */

const real = (p) => fs.realpath(p).catch(() => null)
const inside = (p, root) => p === root || p.startsWith(root + path.sep)

/** Top-level links of a checkout that lead out of it (a framework's collections linked into an application). */
async function linkedOut (checkout) {
  const out = []
  let entries = []
  try { entries = await fs.readdir(checkout, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue
    const target = await real(path.join(checkout, entry.name))
    if (!target || inside(target, checkout)) continue
    if ((await fs.stat(target).catch(() => null))?.isDirectory()) out.push(target)
  }
  return out
}

/** The top-level entries of the projects root no seat reads (host settings selection.forbiddenPrefixes). */
async function forbiddenDirs (projectsDir) {
  const prefixes = hostSettings().selection.forbiddenPrefixes
  const names = await fs.readdir(projectsDir).catch(() => [])
  const out = []
  for (const name of names) {
    if (!prefixes.some((prefix) => name === prefix || name.startsWith(prefix + '.'))) continue
    const r = await real(path.join(projectsDir, name))
    if (r) out.push(r)
  }
  return out
}

/**
 * @param project        the project id
 * @param issueDir       the issue's folder, or null
 * @param worktree       the asking run's worktree, or null
 * @param related        further project ids (the project file's `framework` and `workspace.related`)
 * @param panel          the loaded panel (readOnly, deny)
 * @returns { cwd, roots: [{ path, what, alias? }], masks: [path], refused: [{ path, why }] }; throws when the project has no checkout
 */
export async function consultRoots ({ project, issueDir = null, worktree = null, related = [], panel = {}, projectsDir = projectsRoot(), home = os.homedir() }) {
  const checkout = await real(await resolveProjectPath(project, { projectsDir }).catch(() => path.join(projectsDir, project)))
  if (!checkout) throw new Error(`project ${project} has no checkout to read`)
  const projectsReal = await real(projectsDir) ?? path.resolve(projectsDir)
  const homeReal = await real(home) ?? path.resolve(home)
  const forbidden = await forbiddenDirs(projectsReal)
  // What stays unreadable wherever it lies: the panel's credentials and the installation's own list.
  const protectedPaths = []
  for (const p of [tokenFile(), certDir(), path.join(issuesRoot(), '.reporters.json'), ...(panel.deny ?? [])]) {
    const r = await real(p)
    if (r) protectedPaths.push(r)
  }
  /** Why a canonical path may not be granted, or null. A root may hold a protected path (it is masked), never be or lie in one. */
  const refusal = (r) => {
    if (r === path.parse(r).root) return 'it is the filesystem root'
    if (inside(homeReal, r)) return 'it is or contains the home directory'
    if (privateHomeHit(homeReal, r)) return 'it reaches a login or key directory of the home'
    if (inside(projectsReal, r)) return 'it is or contains the projects root'
    const hit = forbidden.find((f) => inside(r, f) || inside(f, r))
    if (hit) return `it reaches ${hit}, which no seat reads`
    const secret = protectedPaths.find((p) => inside(r, p))
    if (secret) return `it is or lies in ${secret}, which is never readable`
    return null
  }
  const roots = []
  const refused = []
  // `alias`: the spelling people and records use when the path is a link
  // (<root>/<id>-project onto its directory); the fence recreates it inside.
  const add = async (p, what, { only = null } = {}) => {
    const r = await real(p)
    if (!r) return
    const why = refusal(r) ?? (only && !only(r) ? 'a link out of a checkout is followed only to a directory under the projects root' : null)
    if (why) { refused.push({ path: r, why }); return }
    if (roots.some((x) => inside(r, x.path))) return
    roots.push({ path: r, what, ...(path.resolve(p) !== r ? { alias: path.resolve(p) } : {}) })
  }
  await add(projectPath(project, projectsDir), `the live checkout of ${project}, as it stands now, uncommitted work and logs included`)
  if (!roots.length) throw new Error(`the checkout of ${project} cannot be read by a consult: ${refused[0]?.why ?? 'it does not exist'}`)
  for (const id of related) {
    if (await resolveProjectPath(id, { projectsDir }).catch(() => null)) await add(projectPath(id, projectsDir), `the live checkout of ${id}, a project this one is tied to`)
  }
  const underProjects = (r) => r !== projectsReal && inside(r, projectsReal)
  for (const root of [...roots]) for (const target of await linkedOut(root.path)) await add(target, `linked from ${path.basename(root.path)}`, { only: underProjects })
  if (issueDir) await add(issueDir, 'the issue: its report, notes and every run\'s steps, prompts, responses, checks and evidence')
  if (worktree) await add(worktree, 'the asking run\'s worktree: the candidate as its author left it')
  for (const dir of panel.readOnly ?? []) await add(dir, 'named by the installation')
  const masks = protectedPaths.filter((p) => roots.some((x) => inside(p, x.path)))
  return { cwd: checkout, roots, masks, refused }
}
