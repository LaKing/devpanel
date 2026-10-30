import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { forbiddenRoots, homeExemption, PANEL_ROOT } from './selection.mjs'
import { certDir, issuesRoot, logDir, tokenFile } from '../project-path.mjs'

/*
 * Seat tooling mounts (`workspace.tooling.mounts` in projects/<id>.yaml): host
 * directories — a project's node_modules, a browser, a formatter install —
 * bind-mounted READ-ONLY into the seat fence at a worktree-relative path, so a
 * seat runs the project's own tooling without installing anything.
 *
 *   targetErrors     shape of the targets, host-independent (configuration load)
 *   resolveMounts    each source against the host, at resolution: a missing one
 *                    is recorded, never an error (the turn refuses it)
 *   ensureMountPoint the empty directory bubblewrap mounts onto, created inside
 *                    the worktree without ever following a link out of it
 */

const exec = promisify(execFile)
const within = (root, p) => p === root || p.startsWith(root + path.sep)

/** What is wrong with the declared targets, if anything (no filesystem access). */
export function targetErrors (mounts = []) {
  const out = []
  const targets = []
  for (const m of mounts) {
    const t = m.target
    const parts = t.split('/')
    if (path.posix.isAbsolute(t) || parts.some((p) => p === '' || p === '.' || p === '..') || t.includes('\0')) { out.push(`tooling.mounts: target "${t}" must be a normalised path relative to the worktree (no leading /, no empty, . or .. segments)`); continue }
    if (parts.includes('.git')) { out.push(`tooling.mounts: target "${t}" reaches a .git entry`); continue }
    const clash = targets.find((o) => o === t || o.startsWith(t + '/') || t.startsWith(o + '/'))
    if (clash) { out.push(`tooling.mounts: target "${t}" overlaps "${clash}"`); continue }
    targets.push(t)
  }
  return out
}

/**
 * The project's mounts resolved against this host, for the snapshot. A source
 * that does not exist is `missing: true` with no error, so the configuration
 * stays valid on a host without that tool; the engine refuses the project's
 * seat turns naming the path. One that exists must be a directory of tooling:
 * never a protected path, a repository root, or source the snapshot selects.
 */
export async function resolveMounts (mounts = [], { projectPath = null } = {}) {
  const out = []
  const errors = []
  for (const [index, m] of mounts.entries()) {
    const source = path.isAbsolute(m.source) ? m.source : projectPath ? path.join(projectPath, m.source) : m.source
    const real = path.isAbsolute(source) ? await fs.realpath(source).catch(() => null) : null
    const entry = { target: m.target, source, sourceReal: real, ...(m.provisional ? { provisional: true } : {}), ...(m.description ? { description: m.description } : {}) }
    if (!real) { out.push({ ...entry, missing: true }); continue }
    for (const message of await sourceErrors(real, source, { projectPath })) errors.push({ index, message })
    out.push(entry)
  }
  return { mounts: out, errors }
}

async function sourceErrors (real, source, { projectPath }) {
  if (!(await fs.stat(real)).isDirectory()) return [`tooling.mounts: ${source} is not a directory`]
  const panel = await fs.realpath(PANEL_ROOT).catch(() => PANEL_ROOT)
  const project = projectPath ? await fs.realpath(projectPath).catch(() => projectPath) : null
  // Inside the panel's or the project's own checkout is allowed (a dependency
  // tree beside the source); the checkout itself, or anything containing it, is not.
  const hosts = [panel, project].filter(Boolean)
  const exempt = await homeExemption()
  for (const f of await forbiddenRoots()) {
    if (exempt(f, real)) continue
    if (within(real, f) || (within(f, real) && !hosts.includes(f))) return [`tooling.mounts: ${source} reaches ${f}, which no seat may read`]
  }
  for (const [rel, p] of [['issues', issuesRoot()], ['cert', certDir()], ['logs', logDir()], ['.devpanel-token', tokenFile()]]) {
    if (within(p, real) || within(real, p)) return [`tooling.mounts: ${source} reaches the panel's ${rel}, which no seat may read`]
  }
  if (await fs.lstat(path.join(real, '.git')).then(() => true, () => false)) return [`tooling.mounts: ${source} is a Git repository; a mount is tooling, never source`]
  for (const host of hosts) {
    if (!within(host, real) || real === host) continue
    // A listing that fails proves nothing: it is a refusal, never an empty selection (auditor-1-008).
    let listed
    try {
      listed = (await exec('git', ['-C', host, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', path.relative(host, real)], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean)
    } catch (error) {
      return [`tooling.mounts: ${source} could not be checked against the snapshot selection of ${host} (git ls-files failed: ${(error.stderr || error.message).toString().trim().split('\n')[0]})`]
    }
    if (listed.length) return [`tooling.mounts: ${source} holds source the snapshot selects (${listed[0]}${listed.length > 1 ? `, and ${listed.length - 1} more` : ''}); a seat reads source through its worktree`]
  }
  return []
}

/**
 * Make `rel` an empty directory inside `worktree` to mount onto, and return its
 * absolute path. bubblewrap cannot create a mount point inside a read-only
 * bind, so the engine creates it on the host — and a seat-writable worktree may
 * hold links: every existing component is checked to be a real directory inside
 * the worktree BEFORE anything is created, each created one is checked again,
 * and nothing is ever created through a link (auditor-1-003).
 */
export async function ensureMountPoint (worktree, rel) {
  const root = await fs.realpath(worktree)
  const refuse = (why) => { throw Object.assign(new Error(`tooling mount target ${rel}: ${why}`), { code: 'TOOLING_MOUNT_TARGET' }) }
  const check = async (prefix) => {
    const p = path.join(root, prefix)
    const st = await fs.lstat(p).catch(() => null)
    if (!st) return false
    if (st.isSymbolicLink() || !st.isDirectory()) refuse(`${prefix} is a symlink or not a directory`)
    if (await fs.realpath(p) !== p) refuse(`${prefix} resolves outside the worktree`)
    return true
  }
  const parts = rel.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    if (await check(prefix)) continue
    await fs.mkdir(path.join(root, prefix)).catch((error) => { if (error.code !== 'EEXIST') throw error })
    if (!await check(prefix)) refuse(`${prefix} could not be created`)
  }
  const target = path.join(root, rel)
  if ((await fs.readdir(target)).length) refuse('is occupied in the worktree (it must be absent or an empty directory)')
  return target
}
