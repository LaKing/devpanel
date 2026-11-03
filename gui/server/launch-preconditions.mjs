import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { hostSettings } from './config/host-settings.mjs'
import { snapshotLockError, snapshotRepositories, unidentifiedMessage } from './runtime/source-lock.mjs'
import { inspectLaunchState } from './supervisor-launch-state.mjs'
import { streamGit } from './runtime/working-tree.mjs'

/*
 * Launch conditions that are deterministic and free to read, checked before a
 * start reserves anything or probes a model. Provisioning checks them again
 * against the tree as it is then; this only moves the refusal ahead of the
 * money. Returns null when nothing refuses, or { code, message } in the same
 * words provisioning would use.
 */
export async function launchPreconditions ({ projectPath, workspace = {}, configHash = null, listLimit, selection = 0 }) {
  if (workspace.isolation === 'in-place') return null   // the checkout is the workspace; no base is cut
  const state = await inspectLaunchState({ projectPath, workspace, configHash, listLimit })
  if (state.code === 'DIRTY_BASE' || state.code === 'UNREADABLE_WORKTREE' || state.code === 'GIT_OUTPUT_LIMIT') {
    return {
      code: state.code,
      message: state.code === 'DIRTY_BASE'
        ? `base policy "head" requires a clean checkout, but ${state.dirtyPaths} tracked path(s) are modified in ${projectPath}. Choose base "working-tree" to cut from the checkout as it is, name a commit, or clean the checkout. (Checked before preflight: nothing was spent.)`
        : `${state.blockedReason} (Checked before preflight: nothing was spent.)`
    }
  }
  if ((workspace.symlinks ?? 'reject') === 'reject') {
    // A listing that fails proves nothing about the links: a refusal, never "none".
    let escaping
    try { escaping = await escapingTrackedLinks(projectPath) } catch (error) {
      return { code: 'UNREADABLE_REPOSITORY', message: `the tracked symlinks of ${projectPath} could not be listed: ${error.stderr?.trim() || error.message} (Checked before preflight: nothing was spent.)` }
    }
    if (escaping.length) {
      return {
        code: 'ESCAPING_SYMLINKS',
        message: `${escaping.length} symlink(s) in the checkout point outside it (${escaping.slice(0, 3).map((l) => `${l.path} -> ${l.target}`).join(', ')}${escaping.length > 3 ? ', …' : ''}). A write through such a link changes a live file the candidate does not record. Choose symlinks "materialize" to copy their targets into the worktree, or "allow" to accept that. (Checked before preflight: nothing was spent.)`
      }
    }
  }
  return snapshotLockRefusal({ projectPath, workspace, selection })
}

/**
 * A snapshot that could not hold the delivery lock of a repository it reads.
 * The walk is the one provisioning makes; if it cannot be made here, provisioning
 * decides and says why.
 */
async function snapshotLockRefusal ({ projectPath, workspace, selection }) {
  if (workspace.base !== 'working-tree' && workspace.symlinks !== 'materialize') return null
  let found
  try { found = await snapshotRepositories(projectPath, { ...workspace, selection, nested: hostSettings().nestedRepositories }) } catch { return null }
  const nothingSpent = (detail) => {
    const { code, message } = snapshotLockError(detail)
    return { code, message: `${message} (Checked before preflight: nothing was spent.)` }
  }
  if (found.unidentified.length) return nothingSpent(unidentifiedMessage(found.unidentified))
  for (const repository of found.repositories) {
    try { await fs.access(repository, fsConstants.W_OK) } catch { return nothingSpent(`this account cannot write to ${repository}, so it cannot hold the lock a delivery there uses.`) }
  }
  return null
}

/** Tracked symlinks (index mode 120000) whose target resolves outside the checkout. */
export async function escapingTrackedLinks (projectPath) {
  // Streamed: only the links are kept, however many paths are tracked.
  const links = []
  let rest = Buffer.alloc(0)
  await streamGit(['-C', projectPath, 'ls-files', '--stage', '-z'], (chunk) => {
    const bytes = rest.length ? Buffer.concat([rest, chunk]) : chunk
    let start = 0
    for (let end = bytes.indexOf(0, start); end !== -1; end = bytes.indexOf(0, start)) {
      const line = bytes.toString('utf8', start, end)
      if (line.startsWith('120000 ')) links.push(line.slice(line.indexOf('\t') + 1))
      start = end + 1
    }
    rest = bytes.subarray(start)
  })
  const root = path.resolve(projectPath)
  const out = []
  for (const rel of links) {
    let target
    try { target = await fs.readlink(path.join(root, rel)) } catch { continue }
    const resolved = path.resolve(path.dirname(path.join(root, rel)), target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) out.push({ path: rel, target })
  }
  return out
}
