import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fingerprint } from './fingerprint.mjs'
import { destinationFingerprint } from './source-delivery.mjs'
import { reconstructInto, discardReconstruction, runEpoch, worktreeDiffDelivery } from './launch.mjs'
import { writeJson } from './persistence.mjs'
import { repositoryGitArgs, engineGitEnv, HARDENED, LOCAL_TRANSPORT } from './engine-git.mjs'
import { ownPathDrift, reconcileUnavailable, RECONCILABLE_BLOCKS } from './run-control.mjs'

export { ownPathDrift, reconcileUnavailable, RECONCILABLE_BLOCKS }

/*
 * Reconcile an approved patch onto drifted source (`reconcile-delivery`).
 *
 * Source delivery refuses a destination whose drift reaches the approved
 * patch's own paths (source-delivery.mjs). Where every patch touches the
 * changelog, two runs conflict whenever the first lands between the second's
 * snapshot and its delivery, and the second was redone by hand or by a new
 * run. Here the approved patch is merged three-way onto
 * the destination as delivery reads it, in a temporary worktree of the run's
 * recorded Git directory, whose objects hold the snapshot the patch was cut
 * from (the source repository, or the run's private fetch of it).
 *
 * The current source becomes a commit over the snapshot (B′: the snapshot with
 * the destination's drift written in), so the merged candidate is an ordinary
 * revision — fingerprinted against B′'s baseline, rebuilt from B′ plus its
 * patch by the check runner, delivered by applyToSource — and no rule is new.
 *
 * Nothing unreviewed passes: a conflict is resolved only on a path the project
 * declares `append` or `prepend` (workspace.reconcile), only when the
 * candidate's change there is pure addition, by keeping the source's bytes and
 * adding the candidate's lines after them (`append`) or before them (`prepend`,
 * a newest-first changelog); every other path must carry exactly the reviewed
 * delta (the same removed and added lines, the same mode change), or nothing
 * is delivered. A path may also be declared `inert`: when all the drift is on
 * such paths and every other path is byte-identical to the approved revision
 * (`inertProof`), the engine keeps the approved check result instead of driving
 * the merged candidate again.
 */

const NL = String.fromCharCode(10)
const NUL = String.fromCharCode(0)

const sha = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')

const git = (args, { input = null, env = {}, encoding = 'utf8' } = {}) => new Promise((resolve) => {
  const child = execFile('git', args, { env: engineGitEnv(env), encoding, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) =>
    resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout, stderr: String(stderr) }))
  child.stdin.on('error', () => {})
  child.stdin.end(input ?? '')
})
/*
 * Take a path out of an index without a work tree. `update-index --force-remove -- <path>` makes git set one
 * up first and die ("this operation must be run in a work tree") in a bare directory, which a run's engine
 * Git directory is; an `--index-info` record with mode 0 removes the entry and needs none.
 */
const dropFromIndex = (run, entryPath, env) => run(['update-index', '-z', '--index-info'], { env, input: `0 ${'0'.repeat(40)}\t${entryPath}\0` })
const must = async (pending) => {
  const r = await pending
  if (r.code !== 0) throw new Error(r.stderr.trim().split(NL)[0] || `git exited ${r.code}`)
  return r
}

/** The first policy entry naming this path, as `{ rule, inert? }`: one entry decides both, so no second glob adds inertness to another's rule. */
const reconcileEntry = (policy, p) => Object.entries(policy ?? {})
  .map(([pattern, value]) => [pattern, typeof value === 'string' ? { rule: value } : value])
  .find(([pattern, entry]) => (entry?.rule === 'append' || entry?.rule === 'prepend') && (pattern === p || path.matchesGlob(p, pattern)))?.[1] ?? null

/** The project's reconcile rule for this path (`append` | `prepend`), or null. */
export const additionRule = (policy, p) => reconcileEntry(policy, p)?.rule ?? null

/** Whether the project declares this path `inert: true`: no check depends on it, by the project's word. */
export const isInert = (policy, p) => reconcileEntry(policy, p)?.inert === true

/** The paths whose content or mode differ between two fingerprints of whole trees (a deleted path is absent). */
export function differingPaths (a, b) {
  const read = (fp) => new Map(fp.entries.filter((e) => e.status !== 'deleted').map((e) => [e.path, `${e.contentHash} ${e.mode}`]))
  const [left, right] = [read(a), read(b)]
  return [...new Set([...left.keys(), ...right.keys()])].filter((p) => left.get(p) !== right.get(p)).sort()
}

/**
 * Whether this merge may keep the approved revision's check result: every path
 * the destination drifted on is declared inert (all of the drift, since all of
 * it is in B′, not only the patch's own paths), and every other path of the
 * merged tree is byte-identical to the approved one. Null when no drifted path
 * is inert: the policy did not come into it.
 */
export function inertProof (policy, drift, approved, merged) {
  const paths = drift.map((e) => e.path).filter((p) => isInert(policy, p))
  if (!paths.length) return null
  const nonInertDrift = drift.map((e) => e.path).filter((p) => !isInert(policy, p))
  const differing = differingPaths(approved, merged).filter((p) => !isInert(policy, p))
  const compared = new Set([...approved.entries, ...merged.entries].filter((e) => e.status !== 'deleted' && !isInert(policy, e.path)).map((e) => e.path)).size
  return { proved: !nonInertDrift.length && !differing.length, paths, nonInertDrift: nonInertDrift.slice(0, 20), nonInertDriftCount: nonInertDrift.length, differing: differing.slice(0, 20), compared }
}

/** The lines a change adds, or null when it also removes or rewrites some (not an append). */
async function additions (scratch, before, afterFile) {
  const file = path.join(scratch, 'append-base')
  await fs.writeFile(file, before)
  const d = await git(['diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', file, afterFile], { encoding: 'latin1' })
  if (d.code > 1 || /^(Binary files |GIT binary patch)/m.test(d.stdout)) return null
  const added = []
  let hunk = false
  for (const line of d.stdout.split(NL)) {
    if (line.startsWith('@@')) { hunk = true; continue }
    if (!hunk) continue
    if (line.startsWith('-')) return null
    if (line.startsWith('+')) added.push(line.slice(1))
  }
  return added
}

/**
 * A change to one path, positions left out: the removed and added lines in
 * order, and the mode change. Equal for the reviewed and the merged change
 * exactly when the merge carried the reviewed delta unaltered.
 */
async function delta (scratch, before, after, modes) {
  // A baseline recorded before modes were (older runs) cannot show a mode change on either side.
  const mode = modes[0] == null || modes[0] === modes[1] ? '' : ` mode ${modes[0]} -> ${modes[1]}`
  if (after === null) return `deleted${mode}`
  if (before === null) return `added ${sha(after)}${mode}`
  if (before.includes(0) || after.includes(0)) return `binary ${sha(before)} ${sha(after)}${mode}`
  const [a, b] = [path.join(scratch, 'delta-a'), path.join(scratch, 'delta-b')]
  await fs.writeFile(a, before)
  await fs.writeFile(b, after)
  const d = await git(['diff', '--no-index', '-U0', '--no-color', '--no-ext-diff', a, b], { encoding: 'latin1' })
  if (d.code > 1) throw new Error(d.stderr.trim() || 'diff failed')
  const lines = d.stdout.split(NL)
  const first = lines.findIndex((l) => l.startsWith('@@'))
  return (first < 0 ? [] : lines.slice(first)).map((l) => l.startsWith('@@') ? '@@' : l).join(NL) + mode
}

/**
 * Merge `patchFile` (the approved revision over workspace.baseCommit) onto the
 * destination. Returns `{ state: 'merged', candidate, … }` with the merged
 * candidate in a temporary worktree (call `release()` when done), or a refusal
 * `{ state, error, conflicts, changedDelta }` that has written nothing but
 * objects and the B′ ref into the run's Git directory. With `keepConflicts` a
 * `conflicts` refusal also carries the conflicted tree (`candidate`, `drift`,
 * `release()`), for a delivery return.
 */
export async function mergeOntoSource ({ workspace, baseline, revision, patchFile, policy = {}, ref, runDir, clock, keepConflicts = false }) {
  const gitDir = workspace.gitDir ?? null
  const repo = (args, options) => git([...repositoryGitArgs(workspace.path, gitDir), ...args], options)
  const inTree = (dir, args, options) => git(['-C', dir, ...HARDENED, ...args], options)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-reconcile-'))
  const approvedDir = path.join(scratch, 'approved')
  const mergedDir = path.join(scratch, 'merged')
  const result = { mergeBase: workspace.baseCommit, sourceBase: null, publicationBase: null, merged: [], appended: [], conflicts: [], changedDelta: [], error: null }
  const refuse = (state, error, extra = {}) => ({ ...result, ...extra, state, error })
  let keep = false
  const release = async () => {
    for (const dir of [approvedDir, mergedDir]) await discardReconstruction({ dir, workspacePath: workspace.path, gitDir })
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
  try {
    // 1. The patch must still rebuild the approved revision on its own base.
    await reconstructInto({ dir: approvedDir, workspacePath: workspace.path, baseCommit: workspace.baseCommit, patchFile, gitDir })
    const approved = await fingerprint(approvedDir, { baseCommit: workspace.baseCommit, baseline, clock })
    if (approved.fingerprint !== revision) return refuse('unverifiable', 'The retained patch no longer rebuilds the approved revision.')
    const want = new Map(approved.entries.filter((e) => e.status !== 'unchanged').map((e) => [e.path, e]))
    // Paths under materialized links merge like any other: the snapshot holds
    // their materialized copies, the destination is read through the links,
    // and delivery dispatches the merged candidate to their owners.
    const materialized = workspace.symlinks?.materialized ?? []
    const underLink = (p) => materialized.some((root) => p === root || p.startsWith(root + '/'))

    // 2. The destination exactly as delivery reads it.
    const destination = await destinationFingerprint(workspace, baseline, clock, [...want.keys()])
    const drift = destination.entries.filter((e) => e.status !== 'unchanged')
    const own = drift.filter((e) => want.has(e.path)).map((e) => e.path)
    if (!own.length) return refuse('not-needed', "None of the approved patch's own paths differ from its base at the destination: finalize delivers it as it is.")

    // 3. B′: the snapshot with the destination's drift written in, built in a
    // throwaway index; its baseline is the snapshot's with the same entries.
    const date = `${runEpoch(runDir)} +0000`
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_AUTHOR_NAME: 'devpanel', GIT_AUTHOR_EMAIL: 'devpanel@localhost', GIT_COMMITTER_NAME: 'devpanel', GIT_COMMITTER_EMAIL: 'devpanel@localhost', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
    await must(repo(['read-tree', workspace.baseCommit], { env }))
    const next = new Map(baseline)
    next.modes = new Map(baseline.modes ?? [])
    for (const e of drift.filter((e) => e.status === 'deleted')) {
      await must(dropFromIndex(repo, e.path, env))
      next.delete(e.path)
      next.modes.delete(e.path)
    }
    for (const e of drift.filter((e) => e.status !== 'deleted')) {
      const full = path.join(workspace.source.path, e.path)
      const bytes = e.mode === 'link' ? Buffer.from(await fs.readlink(full)) : await fs.readFile(full)
      // The bytes written must be the bytes the destination was read with.
      if (sha(e.mode === 'link' ? `link:${bytes}` : bytes) !== e.contentHash) return refuse('source-moving', `The source changed while it was read (${e.path}); retry when it is quiet.`)
      const blob = (await must(repo(['hash-object', '-w', '--stdin'], { input: bytes }))).stdout.trim()
      await must(repo(['update-index', '--add', '--replace', '--cacheinfo', `${e.mode === 'link' ? '120000' : e.mode === '000755' ? '100755' : '100644'},${blob},${e.path}`], { env }))
      next.set(e.path, e.contentHash)
      next.modes.set(e.path, e.mode)
    }
    const tree = (await must(repo(['write-tree'], { env }))).stdout.trim()
    result.sourceBase = (await must(repo(['commit-tree', tree, '-p', workspace.baseCommit, '-m', `devpanel reconcile base for ${ref}`], { env }))).stdout.trim()
    await must(repo(['update-ref', ref, result.sourceBase]))

    // A private run's B′ lives in its engine directory. The source repository
    // gets it too (owner delivery rebuilds from it there), and a translation
    // base A′ = the source base A with the same drift, so publication carries
    // the merged delta onto the real source and never the snapshot's own
    // exclusions or materialized copies (publication.mjs translate). Drift
    // under a materialized link belongs to its owner, never to A.
    const source = workspace.repository?.kind === 'private' ? workspace.repository.source : null
    if (source) {
      const src = (args, options) => git([...HARDENED, '--git-dir', source, ...args], options)
      await must(src([...LOCAL_TRANSPORT, 'fetch', '-q', '--no-tags', `file://${gitDir}`, `+${ref}:${ref}`]))
      if (workspace.sourceBase && workspace.sourceBase !== workspace.baseCommit) {
        const srcEnv = { ...env, GIT_INDEX_FILE: path.join(scratch, 'source-index') }
        await must(src(['read-tree', workspace.sourceBase], { env: srcEnv }))
        for (const e of drift.filter((e) => !underLink(e.path))) {
          if (e.status === 'deleted') { await must(dropFromIndex(src, e.path, srcEnv)); continue }
          const blob = (await must(repo(['rev-parse', `${result.sourceBase}:${e.path}`]))).stdout.trim()
          const bytes = (await must(repo(['cat-file', 'blob', blob], { encoding: 'buffer' }))).stdout
          await must(src(['hash-object', '-w', '--stdin'], { input: bytes }))
          await must(src(['update-index', '--add', '--replace', '--cacheinfo', `${e.mode === 'link' ? '120000' : e.mode === '000755' ? '100755' : '100644'},${blob},${e.path}`], { env: srcEnv }))
        }
        const sourceTree = (await must(src(['write-tree'], { env: srcEnv }))).stdout.trim()
        result.publicationBase = (await must(src(['commit-tree', sourceTree, '-p', workspace.sourceBase, '-m', `devpanel reconcile source base for ${ref}`], { env: srcEnv }))).stdout.trim()
        await must(src(['update-ref', `${ref}-source`, result.publicationBase]))
      }
    }

    // 4. The approved patch merged three-way onto B′.
    await must(repo(['worktree', 'add', '--detach', '--quiet', mergedDir, result.sourceBase]))
    const patch = await fs.readFile(patchFile)
    const applied = patch.length ? await inTree(mergedDir, ['apply', '--3way', '--binary', '--whitespace=nowarn', '-'], { input: patch }) : { code: 0, stderr: '' }
    const unmerged = [...new Set((await must(inTree(mergedDir, ['ls-files', '-u', '-z']))).stdout.split(NUL).filter(Boolean).map((l) => l.slice(l.indexOf('\t') + 1)))]
    if (applied.code !== 0 && !unmerged.length) return refuse('failed', `The approved patch does not merge onto the current source: ${applied.stderr.trim().split(NL)[0]}`)

    // 5. A conflict on a declared append/prepend path keeps the source and adds
    // the candidate's lines after or before it; any other conflict refuses.
    const conflicts = []
    for (const p of unmerged) {
      const rule = additionRule(policy, p)
      const ours = rule ? await inTree(mergedDir, ['show', `:2:${p}`], { encoding: 'buffer' }) : null
      const base = ours?.code === 0 ? await inTree(mergedDir, ['show', `:1:${p}`], { encoding: 'buffer' }) : null
      const added = base ? await additions(scratch, base.code === 0 ? base.stdout : Buffer.alloc(0), path.join(approvedDir, p)) : null
      if (!added) { conflicts.push(p); continue }
      const lines = Buffer.from(added.map((l) => l + NL).join(''), 'latin1')
      const separator = ours.stdout.length && ours.stdout.at(-1) !== 10 ? Buffer.from(NL) : Buffer.alloc(0)
      await fs.writeFile(path.join(mergedDir, p), rule === 'prepend' ? Buffer.concat([lines, ours.stdout]) : Buffer.concat([ours.stdout, separator, lines]))
      await must(inTree(mergedDir, ['add', '--', p]))
      result.appended.push(p)
    }
    if (conflicts.length) {
      const refusal = refuse('conflicts', `The merge conflicts outside the declared append paths: ${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ', …' : ''}.`, { conflicts })
      if (!keepConflicts) return refusal
      // A delivery return (delivery-return.mjs) takes the conflicted tree as it stands: B′ plus the
      // approved patch, the conflicting hunks left as markers for the author. The caller releases it.
      keep = true
      return { ...refusal, drift: drift.map((e) => e.path), candidate: { path: mergedDir, baseCommit: result.sourceBase, baseline: next }, release }
    }

    // 6. Outside the append paths the merged change must be the reviewed one.
    const merged = await fingerprint(mergedDir, { baseCommit: result.sourceBase, baseline: next, clock })
    const got = new Map(merged.entries.filter((e) => e.status !== 'unchanged').map((e) => [e.path, e]))
    const identity = (e) => e ? `${e.status} ${e.contentHash ?? ''} ${e.mode ?? ''}` : 'unchanged'
    const read = async (dir, p) => {
      const stat = await fs.lstat(path.join(dir, p)).catch(() => null)
      return !stat ? null : stat.isSymbolicLink() ? Buffer.from(`link:${await fs.readlink(path.join(dir, p))}`) : fs.readFile(path.join(dir, p))
    }
    const at = async (commit, p, map) => !map.has(p) ? null : map.modes?.get(p) === 'link' ? Buffer.from(`link:${(await must(repo(['cat-file', 'blob', `${commit}:${p}`]))).stdout}`) : (await must(repo(['cat-file', 'blob', `${commit}:${p}`], { encoding: 'buffer' }))).stdout
    // The mode after a change: the entry's, or the base's where the path did not change.
    const modeAfter = (e, map, p) => e ? e.mode ?? null : map.modes?.get(p) ?? null
    for (const p of [...new Set([...want.keys(), ...got.keys()])].sort()) {
      if (additionRule(policy, p)) continue
      if (!own.includes(p)) {
        if (identity(want.get(p)) !== identity(got.get(p))) result.changedDelta.push(p)
        continue
      }
      const reviewed = await delta(scratch, await at(workspace.baseCommit, p, baseline), await read(approvedDir, p), [baseline.modes?.get(p) ?? null, modeAfter(want.get(p), baseline, p)])
      const carried = await delta(scratch, await at(result.sourceBase, p, next), await read(mergedDir, p), [baseline.modes?.get(p) == null ? null : next.modes?.get(p) ?? null, modeAfter(got.get(p), next, p)])
      if (reviewed !== carried) result.changedDelta.push(p)
    }
    if (result.changedDelta.length) return refuse('delta-changed', `The merge changes the reviewed delta at: ${result.changedDelta.slice(0, 5).join(', ')}${result.changedDelta.length > 5 ? ', …' : ''}.`, { conflicts: result.changedDelta })

    result.merged = own.filter((p) => !result.appended.includes(p))
    keep = true
    return { ...result, state: 'merged', inert: inertProof(policy, drift, approved, merged), candidate: { path: mergedDir, baseCommit: result.sourceBase, baseline: next, fingerprint: merged }, release }
  } catch (error) {
    return refuse('failed', error.message)
  } finally {
    if (!keep) await release()
  }
}

/**
 * Keep a merged candidate as base B′ + patch + baseline under `<runDir>/<dir>`,
 * the patch proved to rebuild the revision exactly as a delivery's is.
 */
export async function keepCandidate ({ candidate, workspace, revision, runDir, dir, clock }) {
  const out = path.join(runDir, dir)
  await fs.mkdir(path.join(out, 'artifacts'), { recursive: true })
  await writeJson(path.join(out, 'baseline.json'), Object.fromEntries(candidate.baseline))
  await writeJson(path.join(out, 'baseline-modes.json'), Object.fromEntries(candidate.baseline.modes))
  const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision, fingerprint: candidate.fingerprint, baseCommit: candidate.baseCommit,
    baseline: candidate.baseline, workspacePath: candidate.path, runDir: out, clock, gitDir: workspace.gitDir ?? null })
  return { patch: path.join(dir, receipt.artifactRef), reconstruction: receipt.reconstruction }
}

/** An accepted reconciliation's candidate, rebuilt into a temporary worktree for closure. */
export async function rebuildReconciled ({ workspace, reconciliation, runDir }) {
  const gitDir = workspace.gitDir ?? null
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-reconciled-'))
  const release = () => discardReconstruction({ dir, workspacePath: workspace.path, gitDir })
  try {
    await reconstructInto({ dir, workspacePath: workspace.path, baseCommit: reconciliation.sourceBase, patchFile: path.join(runDir, reconciliation.patch), gitDir })
    const read = async (name) => new Map(Object.entries(JSON.parse(await fs.readFile(path.join(runDir, path.dirname(path.dirname(reconciliation.patch)), name), 'utf8'))))
    const baseline = await read('baseline.json')
    baseline.modes = await read('baseline-modes.json')
    return { path: dir, baseCommit: reconciliation.sourceBase, baseline, release }
  } catch (error) {
    await release()
    throw error
  }
}
