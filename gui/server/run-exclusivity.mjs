import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Several issues of one project may run at once: the resources they share have
 * their own guards (the delivery lock, the drive cap per staging host). Two kinds
 * of run share something no other guard covers, so they stay apart.
 *
 *  - An in-place run's workspace IS the project checkout. Nothing else may write
 *    there, deliver there or snapshot it while it runs.
 *  - A release-tactic run (staging, deployment) has its verifiers examine what it
 *    released, and can restore over it, after the release lock has gone
 *    (release.mjs). A second one would release under those verifiers.
 *
 * What a run is comes from its resolved snapshot. One that cannot be read conflicts
 * with everything: it is unknown, and a live owner is holding it.
 */

export const NOT_EXCLUSIVE = Object.freeze({ inPlace: false, release: false })

export const exclusivityOf = (resolved) => resolved
  ? { inPlace: resolved.workspace?.isolation === 'in-place', release: ['staging', 'deployment'].includes(resolved.tactic) }
  : { unknown: true }

/**
 * Whether a run can write the project's checkout, which is what the full verification's freeze
 * holds (execution-contract.md "Full verification freeze"): it works in place, it releases
 * (staging, deployment), or its playbook delivers anything. A run that cannot be read is
 * treated as writing. Analysis, Triage and inquiries (no delivery, own worktree) only read.
 */
export const writesCheckout = (resolved) => !resolved || resolved.workspace?.isolation === 'in-place' ||
  ['staging', 'deployment'].includes(resolved.tactic) || (resolved.completion?.delivery?.action ?? 'none') !== 'none'

export const conflicts = (mine, theirs) => Boolean(mine.unknown || theirs.unknown || mine.inPlace || theirs.inPlace || (mine.release && theirs.release))

export const conflictMessage = (holder) => `this run cannot share the project with the live run of issue ${holder.issueId} (an in-place run holds the checkout; release runs keep the staging or deployment target); wait for it to finish`

const within = (dir, p) => {
  const rel = path.relative(path.resolve(dir), path.resolve(p))
  // `..name` is inside: only `..` itself or a `../` prefix leaves the directory (live-link-write).
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}
/**
 * Where a path really leads: the nearest existing ancestor resolved through every link, the rest appended.
 * A link that points through another link into a protected checkout is caught (live-link-write).
 */
async function realOf (p) {
  const abs = path.resolve(p)
  const rest = []
  let cur = abs
  for (;;) {
    try { return path.join(await fs.realpath(cur), ...rest) } catch {}
    const up = path.dirname(cur)
    if (up === cur) return abs
    rest.unshift(path.basename(cur))
    cur = up
  }
}
const ignoredIn = (worktree, p) => new Promise((resolve) => {
  execFile('git', ['-C', worktree, 'check-ignore', '-q', '--', path.relative(worktree, p)], (error) => resolve(!error))
})

/**
 * Whether the full verification freezes a writing run of a project it verifies whole, as before, rather
 * than letting its seat turns go on (execution-contract.md "Full verification freeze"). Whole: it works in
 * place, it releases, its snapshot cannot be read, or one of its turns can write a path the cycle snapshots
 * outside its delivery, which cannot be made to wait:
 *  - an escaping link under `symlinks: allow` into a snapshotted work tree;
 *  - a turn not confined to the seat fence: confined means namespace 1, a host fence policy that fences, and
 *    no allowed fallback to running unfenced (harness/fence.mjs assertFenced). An unconfined run is whole
 *    whatever the permissions read: the service account owns the checkouts and may set any mode back;
 *  - a confined writable mount (worktree, worker git, scratch) inside a snapshotted work tree and not ignored.
 * Every other writing run is contained: only its drives and checkout writes wait (cycle-gates.mjs).
 * `frozen` is the gates' current freeze ({worktrees, unknown}); `fence` the host's fence policy.
 */
/**
 * What wholeFreeze decides without any I/O: unreadable, in place, release, unconfined, or a snapshot the cycle could not
 * read. Null when the answer needs a reading of links and mounts. The supervisor asks a run this synchronously, before
 * any classification awaits, so a run identifiable as whole is asked to stop at once (whole-freeze-installation).
 */
export function wholeFreezeQuick ({ snapshot, frozen = null, fence = null, platform = null, env = process.env } = {}) {
  if (!snapshot) return { whole: true, reason: 'unreadable' }
  const exclusive = exclusivityOf(snapshot)
  if (exclusive.inPlace) return { whole: true, reason: 'in-place' }
  if (exclusive.release) return { whole: true, reason: 'release' }
  const confined = snapshot.fence?.namespace === 1 && fence?.mode === 'fence' && !(platform?.bubblewrap && env?.DEVPANEL_FENCE_UNPROVED === 'run')
  if (!confined) return { whole: true, reason: 'unconfined' }
  if (frozen?.unknown) return { whole: true, reason: 'snapshot-unknown' }
  return null
}

export async function wholeFreeze ({ snapshot, workspace = null, frozen = null, fence = null, platform = null, env = process.env } = {}) {
  const quick = wholeFreezeQuick({ snapshot, frozen, fence, platform, env })
  if (quick) return quick
  const worktrees = await Promise.all([...(frozen?.worktrees ?? [])].map(realOf))
  const policy = workspace?.symlinks?.policy ?? snapshot.workspace?.symlinks ?? 'reject'
  if (policy === 'allow') {
    // Before provisioning its escaping links are not known yet: taken to reach the snapshot.
    if (!workspace?.symlinks) return { whole: true, reason: 'links-unknown' }
    for (const link of workspace.symlinks.escaping ?? []) {
      const target = await realOf(path.resolve(workspace.path ?? '', path.dirname(link.path), link.target))
      if (worktrees.some((w) => within(w, target))) return { whole: true, reason: 'link-into-snapshot', link: link.path }
    }
  }
  // The fence's writable mounts (engine.fenceSpec): the worktree, the worker Git directory and the scratch directory
  // (`scratchPath`; each seat writes a directory inside it), each read through its links.
  for (const raw of [workspace?.path, workspace?.repository?.worker, workspace?.scratchPath ?? workspace?.scratch].filter(Boolean)) {
    const mount = await realOf(raw)
    for (const w of worktrees) {
      if (within(w, mount) && !(await ignoredIn(w, mount))) return { whole: true, reason: 'mount-in-snapshot', mount }
    }
  }
  return { whole: false, reason: 'contained' }
}
