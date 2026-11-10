import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { candidateDiff } from './diff.mjs'
import { HARDENED, engineGitEnv, repositoryGitArgs, worktreeGitArgs } from './engine-git.mjs'
import { runEpoch } from './launch.mjs'
import { additionRule, mergeOntoSource } from './source-reconcile.mjs'

/*
 * A delivery conflict goes back to the author, in the same run
 * (engine.returnFromDelivery; execution-contract.md "The engine returns a
 * delivery conflict to the author").
 *
 * Source delivery merges drift on the approved patch's own paths three-way
 * (source-merge.mjs) and refuses only a real conflict. That refusal used to end
 * the run blocked, every other closure condition met, and a person merged the
 * patch by hand. Here the run's base is moved instead: the destination as
 * delivery reads it becomes a commit over the snapshot (B′, built by
 * mergeOntoSource exactly as for reconcile-delivery), the approved patch is
 * applied three-way onto it, and the live worktree is made that tree, the
 * conflicting hunks left as markers. The author resolves them in one more
 * round; what it produces is an ordinary revision over B′: fingerprinted
 * against B′'s baseline, checked, reviewed, confirmed and delivered like any
 * other. No approval is carried.
 *
 * The move itself is a recorded fact, not something replay derives: the run
 * record names the new base (`workspace.baseCommit`), the baseline file is B′'s,
 * and `run.deliveryReturns` keeps the old base, the approved patch and the
 * conflicts. Replay only sees the decision step and gives the loop its round.
 *
 * Only a text conflict is returned. A binary file, a symlink, a mode change, an
 * addition or deletion on one side, or a path under a materialized link stays a
 * blocked run: nothing an author can settle by editing lines.
 */

export const MAX_DELIVERY_RETURNS = 2
/** Not a refusal to record: the automatic reconcile is what answers such a conflict (auto-reconcile.mjs). */
export const LEFT_TO_RECONCILE = 'every conflicting path is declared append or prepend: reconcile adds the lines by rule'

const NL = String.fromCharCode(10)
const NUL = String.fromCharCode(0)
/** Lines quoted per side of one region, and regions quoted per return: the rest is read in the file. */
const QUOTED_LINES = 40
const QUOTED_REGIONS = 12

const git = (args, { env = {} } = {}) => new Promise((resolve) => {
  execFile('git', args, { env: engineGitEnv(env), maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout, stderr: String(stderr) }))
})
const must = async (pending) => {
  const r = await pending
  if (r.code !== 0) throw new Error(r.stderr.trim().split(NL)[0] || `git exited ${r.code}`)
  return r
}

/**
 * The conflict regions `git apply --3way` left in a file: 1-based inclusive
 * marker-to-marker lines, with the source's side and the approved change's.
 */
export function conflictRegions (text) {
  const regions = []
  let open = null
  text.split(NL).forEach((line, i) => {
    if (line.startsWith('<<<<<<< ')) open = { start: i + 1, side: 'source', source: [], approved: [] }
    else if (open && line.startsWith('||||||| ')) open.side = 'base'
    else if (open && line === '=======') open.side = 'approved'
    else if (open && line.startsWith('>>>>>>> ')) { regions.push({ start: open.start, end: i + 1, source: open.source, approved: open.approved }); open = null } else if (open && open.side !== 'base') open[open.side].push(line)
  })
  return regions
}

/**
 * Why a refused source application is not returned to the author, or null. Read
 * off the delivery receipt alone; whether the merge really leaves only text
 * conflicts is decided again on the merge itself (rebaseOntoSource).
 */
export function deliveryReturnRefusal ({ run, application, policy, reconciled = false }) {
  if (application?.state !== 'source-drift' || !application.conflicts?.length) return `delivery did not end in a conflict with the source (${application?.state ?? 'no application'})`
  if (reconciled) return 'the candidate is a reconciled merge, which has no author round'
  if (policy == null) return "the project's reconcile policy could not be read, so the engine cannot tell a declared append path from the author's work"
  if (run.workspace?.isolation === 'in-place') return 'the run works in place'
  if (!run.workspace?.gitDir) return 'the run records no Git directory for its worktree (provisioned before they were recorded)'
  const materialized = run.workspace.symlinks?.materialized ?? []
  const other = application.conflicts.find((c) => c.kind !== 'text' || materialized.some((root) => c.path === root || c.path.startsWith(root + '/')))
  if (other) return `${other.path} is not a text conflict the author can resolve (${other.kind === 'text' ? 'under a materialized link' : other.kind})`
  if (application.conflicts.every((c) => additionRule(policy, c.path)) && !run.reconciliations?.length) return LEFT_TO_RECONCILE
  if ((run.deliveryReturns?.length ?? 0) >= MAX_DELIVERY_RETURNS) return 'bound-reached'
  return null
}

/**
 * Carry the approved patch onto the destination as it is now. Returns
 * `{ state: 'refused', reason }`, having written only objects and refs into the
 * run's Git directory, or `{ state: 'rebased', sourceBase, publicationBase,
 * mergeCommit, baseline, paths, conflicts, appended, write(), release() }`.
 * `write()` makes the live worktree the merged tree on `paths` and moves the
 * HEAD and index the worktree is read through to B′; nothing is written before
 * it is called, so the caller journals first. `extraPaths`: what an interrupted
 * earlier attempt may already have written.
 */
export async function rebaseOntoSource ({ workspace, baseline, revision, patchFile, policy = {}, runDir, runId, n, clock, extraPaths = [] }) {
  const ref = `refs/devpanel/delivery-return/${runId}-${n}`
  const merge = await mergeOntoSource({ workspace, baseline, revision, patchFile, policy, ref, runDir, clock, keepConflicts: true })
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-return-'))
  const release = async () => {
    await merge.release?.()
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
  const refuse = async (reason) => { await release(); return { state: 'refused', reason } }
  if (merge.state === 'merged') return refuse('the approved change now merges onto the source without a conflict: reconcile or finalize delivers it')
  if (merge.state !== 'conflicts' || !merge.candidate) return refuse(`the approved change could not be carried onto the current source (${merge.state}): ${merge.error ?? 'no reason given'}`)
  try {
    const dir = merge.candidate.path
    const sourceBase = merge.candidate.baseCommit
    const inTree = (args, options) => must(git(['-C', dir, ...HARDENED, ...args], options))
    const stages = new Map()
    for (const line of (await inTree(['ls-files', '-u', '-z'])).stdout.split(NUL).filter(Boolean)) {
      const p = line.slice(line.indexOf('\t') + 1)
      stages.set(p, [...(stages.get(p) ?? []), line.split(' ')[0]])
    }
    const materialized = workspace.symlinks?.materialized ?? []
    const conflicts = []
    for (const p of merge.conflicts) {
      if (materialized.some((root) => p === root || p.startsWith(root + '/'))) return await refuse(`${p} lies under a materialized link: its owner's checkout is not the author's to merge`)
      const modes = stages.get(p) ?? []
      if (modes.length !== 3 || new Set(modes).size !== 1 || !['100644', '100755'].includes(modes[0])) return await refuse(`${p} is not a text conflict (an addition, a deletion, a mode change or a symlink on one side)`)
      const bytes = await fs.readFile(path.join(dir, p))
      if (bytes.subarray(0, 8000).includes(0)) return await refuse(`${p} is binary`)
      const regions = conflictRegions(bytes.toString('utf8'))
      if (!regions.length) return await refuse(`${p} conflicts but the merge left no conflict marker in it`)
      conflicts.push({ path: p, regions })
    }

    // The merged tree as a commit over B′: what the author starts from, kept so
    // a reviewer can be shown the reconciliation alone (reconciliationDiff).
    const date = `${runEpoch(runDir)} +0000`
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_AUTHOR_NAME: 'devpanel', GIT_AUTHOR_EMAIL: 'devpanel@localhost', GIT_COMMITTER_NAME: 'devpanel', GIT_COMMITTER_EMAIL: 'devpanel@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    await inTree(['read-tree', sourceBase], { env })
    await inTree(['add', '--force', '-A', '.'], { env })
    const tree = (await inTree(['write-tree'], { env })).stdout.trim()
    const mergeCommit = (await inTree(['commit-tree', tree, '-p', sourceBase, '-m', `devpanel delivery return ${n}: the approved change on the current source, conflicts unresolved`], { env })).stdout.trim()
    await must(git([...repositoryGitArgs(workspace.path, workspace.gitDir), 'update-ref', `${ref}-merged`, mergeCommit]))
    const changed = (await inTree(['diff', '--name-only', '--no-renames', '-z', sourceBase, mergeCommit])).stdout.split(NUL).filter(Boolean)
    const paths = [...new Set([...merge.drift, ...changed, ...extraPaths])].sort()

    const write = async () => {
      const root = await fs.realpath(workspace.path)
      for (const p of paths) {
        const [from, to] = [path.join(dir, p), path.join(root, p)]
        await fs.mkdir(path.dirname(to), { recursive: true })
        // Never through a link that leaves the worktree: the path is the worktree's own or it is not written.
        const parent = await fs.realpath(path.dirname(to))
        if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error(`${p} resolves outside the worktree`)
        const stat = await fs.lstat(from).catch(() => null)
        await fs.rm(to, { recursive: true, force: true })
        if (!stat) continue
        if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(from), to)
        else {
          await fs.copyFile(from, to)
          await fs.chmod(to, stat.mode & 0o777)
        }
      }
      // The directory the engine reads the worktree through: HEAD and index name B′, as they named the snapshot.
      const own = (args) => must(git([...worktreeGitArgs(workspace.path, workspace.gitDir), ...args]))
      await own(['update-ref', '--no-deref', 'HEAD', sourceBase])
      await own(['read-tree', sourceBase])
      await git([...worktreeGitArgs(workspace.path, workspace.gitDir), 'update-index', '-q', '--refresh'])
      // The seat's own directory (private repositories) is never run by the host
      // (engine-git.mjs): its HEAD and index are written as files. Objects it
      // borrows from the engine's, so B′ is there.
      const worker = workspace.repository?.kind === 'private' ? workspace.repository.worker : null
      if (worker) {
        await fs.writeFile(path.join(worker, 'HEAD'), sourceBase + NL)
        await fs.copyFile(path.join(workspace.gitDir, 'index'), path.join(worker, 'index'))
      }
    }
    return { state: 'rebased', sourceBase, publicationBase: merge.publicationBase ?? null, mergeCommit, baseline: merge.candidate.baseline, paths, conflicts, appended: merge.appended, write, release }
  } catch (error) {
    return refuse(`the approved change could not be carried onto the current source: ${error.message}`)
  }
}

/** The conflicts as kept on the run record: every region's lines, each side's text bounded. */
export function recordedConflicts (conflicts) {
  const bounded = (lines) => lines.length > QUOTED_LINES ? { lines: lines.slice(0, QUOTED_LINES), omitted: lines.length - QUOTED_LINES } : { lines }
  let quoted = 0
  return conflicts.map((c) => ({ path: c.path, regions: c.regions.map((r) => quoted++ < QUOTED_REGIONS
    ? { start: r.start, end: r.end, source: bounded(r.source), approved: bounded(r.approved) }
    : { start: r.start, end: r.end }) }))
}

const side = (s) => !s ? ['  (not quoted: read it in the file)'] : [...(s.lines.length ? s.lines.map((l) => `    ${l}`) : ['    (no lines)']), ...(s.omitted ? [`    … ${s.omitted} more lines, in the file`] : [])]

/** Each conflicting path with its marker lines in the worktree file and both sides. */
export const quoteConflicts = (conflicts) => conflicts.flatMap((c) => c.regions.map((r) => [
  `${c.path} lines ${r.start}–${r.end} (the conflict markers, in the worktree file now):`,
  '  the source now:', ...side(r.source),
  '  the approved change:', ...side(r.approved)
].join(NL))).join(NL + NL)

/** The decision step's text: what happened, and the conflicts. Every later turn that reads `decisions` gets it. */
export function returnAnswer (entry) {
  return [
    `Delivery of the approved revision ${entry.from.revision} was refused: the source checkout changed lines this change also changes. The engine returns the candidate to the author for one more round (automatic delivery return ${entry.n} of ${MAX_DELIVERY_RETURNS}).`,
    `The worktree now stands on the source as it is (base ${entry.sourceBase}), with the approved change carried over. ${entry.conflicts.length === 1 ? 'One file holds' : `${entry.conflicts.length} files hold`} conflict markers where both changed the same lines; everything else of the approved change is applied.${entry.appended?.length ? ` ${entry.appended.join(', ')} was merged by the project's append rule.` : ''}`,
    quoteConflicts(entry.conflicts),
    'The author reconciles exactly these, keeping the approved behaviour and the source\'s change, and changes nothing else. The result is a new revision: it is checked, reviewed and confirmed before it is delivered.'
  ].join(NL + NL)
}

/**
 * What a turn after a delivery return is told beside its prompt. `kind`:
 * `author` (a step that records a revision), `review`, else the coordinator.
 */
export function returnBrief (entry, { kind, resolved = false, diff = null } = {}) {
  const head = `Delivery return ${entry.n}: the revision every reviewer approved (${entry.from.revision}) conflicted with the source checkout at delivery, so the engine moved this worktree onto the current source (base ${entry.sourceBase}) and carried the approved change over.`
  const where = entry.conflicts.map((c) => `${c.path} (lines ${c.regions.map((r) => `${r.start}–${r.end}`).join(', ')})`).join('; ')
  if (kind === 'author') {
    return resolved
      ? `${head} This revision already holds your reconciliation of ${where}. Change only what a finding on that reconciliation requires; the approved behaviour stays as approved.`
      : [`${head} The conflicting hunks are left as conflict markers for you:`, quoteConflicts(entry.conflicts),
          'Reconcile these: keep the approved behaviour and keep what the source changed, remove every conflict marker, and change nothing else. The base moved, so the diff against the base is the approved change on the current source; do not redo or redesign it.'].join(NL + NL)
  }
  if (kind === 'review') {
    return [`${head} The author then reconciled the conflicts in ${where}. This review is of that conflict reconciliation: the rest of the change is what was approved, carried over unchanged. Check that each conflict keeps the approved behaviour and the source's change, that no conflict marker remains, and that nothing else changed. The revision's full diff is against the new base.`,
      diff ? `What the author changed since the engine's merge (the reconciliation alone; the merge's conflict markers are the removed lines):${NL}${diff}` : null].filter(Boolean).join(NL + NL)
  }
  return `${head} The conflicts were in ${where}. Only their reconciliation is new work: delegate and judge that, and do not reopen what was approved.`
}

/** The author's reconciliation alone: the worktree against the engine's merge commit, read through a throwaway index of that commit. */
export async function reconciliationDiff ({ workspace, mergeCommit, maxBytes = 64 * 1024 }) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-return-diff-'))
  try {
    const index = path.join(scratch, 'index')
    await must(git([...worktreeGitArgs(workspace.path, workspace.gitDir), 'read-tree', mergeCommit], { env: { GIT_INDEX_FILE: index } }))
    return (await candidateDiff(workspace.path, { baseCommit: mergeCommit, gitDir: workspace.gitDir, fenceStubs: workspace.fenceStubs, index, maxBytes })).text
  } catch (error) {
    return `(the reconciliation diff could not be computed: ${error.message})`
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}
