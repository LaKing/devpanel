import { stagedRelease } from './release.mjs'
import { captureWindow } from './current-window.mjs'
import { freezeHostGuidance } from './host-guidance.mjs'
import { DEFAULT_CONFIG_ROOT } from '../config/host-config.mjs'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promisify } from 'node:util'

import { resolvePlaybook } from '../config/load.mjs'
import { preflight, assertLaunchable } from '../config/preflight.mjs'
import { systemClock } from './clock.mjs'
import { baselineOf, escapingLinks, fingerprint, workspaceProjection } from './fingerprint.mjs'
import { walkSelection, authorizer, knownProjectRoots, forbiddenRootsReport, homeExemption, copySelected, exportProject, SELECTION_RULE } from './selection.mjs'
import { resolveProjectPath } from '../project-path.mjs'
import { worktreeGitArgs, repositoryGitArgs, engineGitEnv, HARDENED, LOCAL_TRANSPORT } from './engine-git.mjs'
import { ensureGitStore, gitStoreDir } from './git-store.mjs'
import { hostSettings } from '../config/host-settings.mjs'
import { Engine } from './engine.mjs'
import { requireUnarchived } from '../issue-archive.mjs'
import { acquire } from './lock.mjs'
import { hostPlatform } from './platform.mjs'
import { fencePolicy, unfencedRecord } from './confinement-policy.mjs'
import { readBarrier, barrierRefusal } from './cleanup-barrier.mjs'
import * as store from './store.mjs'
import { classifyUntracked, describeBlocking, includeNested, nestedRepositories, snapshotPathspec } from './working-tree.mjs'
import { runProcess } from './process.mjs'
import { applyToSource, sourceTarget, bindSourceOwners } from './source-delivery.mjs'
import { carryForward } from './carry-forward.mjs'
import { publishCandidate } from './publication.mjs'

const run = promisify(execFile)
const BIG = { maxBuffer: 256 * 1024 * 1024 }

/**
 * Writes a patch of the candidate into the run's artifacts, and proves it.
 *
 * Three things the first version got wrong, each of which let an artifact be
 * recorded as a complete capture when it was not:
 *
 *  - It diffed the index against HEAD. An author that commits inside the
 *    worktree moves HEAD, and everything committed vanished from the patch. The
 *    diff is now taken against the PERSISTED base commit the run started from.
 *  - It omitted binary payloads. "Binary files differ" cannot rebuild a file, so
 *    the patch is now generated with full binary content.
 *  - It never checked its own output. The patch is now applied to a throwaway
 *    checkout of the base commit, and that checkout is fingerprinted with the
 *    same baseline as the candidate. Only an identical fingerprint is a
 *    verified capture; anything else is reported and the engine refuses to call
 *    delivery complete, which is what protects the worktree from being deleted.
 *
 * Scope follows the fingerprint, not .gitignore: the fingerprint is the identity
 * of the candidate, so exactly the paths it records as changed are staged,
 * ignored or not.
 */
export const worktreeDiffDelivery = {
  actions: Object.freeze(['worktree-diff', 'commit', 'apply-to-source']),
  async deliver ({ action, revision, fingerprint: fp = null, baseCommit, baseline = new Map(), workspacePath, workspace, runDir, clock = systemClock, label = null, gitDir = workspace?.gitDir ?? null }) {
    if (action === 'apply-to-source') {
      fp ??= await fingerprint(workspacePath, { baseCommit, baseline, clock, projection: workspaceProjection(workspace) })
      // The applied change is also a verified commit on devpanel/<issue>/<run>
      // in the repository that owns the worktree: what lands in the checkout
      // is never only a working-tree state. The checkout's HEAD and index are
      // still untouched; the operator commits or merges as they see fit.
      const receipt = await commitDelivery({ revision, fingerprint: fp, baseCommit, baseline, workspacePath, runDir, clock, label, gitDir, workspace })
      return applyToSource({ workspace, baseline, revision, fingerprint: fp, receipt, runDir, clock })
    }
    if (action === 'commit') {
      const receipt = await commitDelivery({ revision, fingerprint: fp, baseCommit, baseline, workspacePath, runDir, clock, label, gitDir, workspace })
      // Integration merges the translation onto the source base; a candidate
      // that has none cannot be integrated, and says why (0d).
      if (receipt.publication?.translation === 'refused' && receipt.reconstruction?.verified) {
        return { ...receipt, reconstruction: { ...receipt.reconstruction, verified: false, detail: `integration-translation-failed: ${receipt.publication.reason}` } }
      }
      return receipt
    }
    if (action !== 'worktree-diff') throw new Error(`delivery action "${action}" is not supported`)
    if (!baseCommit) throw new Error('delivery needs the base commit the workspace was created from')

    // Projected like the engine's own revisions: tooling mount targets never ship.
    const entries = fp?.entries ?? (await fingerprint(workspacePath, { baseCommit, baseline, clock, projection: workspaceProjection(workspace) })).entries
    const changed = entries.filter((e) => e.status === 'added' || e.status === 'modified').map((e) => e.path)
    const deleted = entries.filter((e) => e.status === 'deleted').map((e) => e.path)
    const expectedPaths = new Set([...changed, ...deleted])

    // A THROWAWAY index seeded from the base commit. The worktree's own index is
    // never consulted: anything an author (or a tool) staged there — including
    // paths the fingerprint excludes and the reconstruction check therefore
    // cannot see — would otherwise ride into the patch unreviewed.
    const indexFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-index-')), 'index')
    const env = engineGitEnv({ GIT_INDEX_FILE: indexFile })
    const git = (args) => run('git', [...worktreeGitArgs(workspacePath, gitDir), ...args], { ...BIG, env })
    let patch
    try {
      await git(['read-tree', baseCommit])
      // Stage exactly the candidate. --force so a changed ignored file is not
      // silently dropped from a patch whose fingerprint counted it.
      if (changed.length) await git(['add', '--force', '--', ...changed])
      if (deleted.length) await git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...deleted])
      // --no-renames: a rename is recorded as a deletion and an addition, so the
      // patch names both paths and the touched-path check below can match them
      // against the fingerprint, which knows nothing of renames either.
      patch = (await git(['diff', '--cached', '--binary', '--full-index', '--no-renames', baseCommit])).stdout
    } finally {
      await fs.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {})
    }

    const file = path.join(runDir, 'artifacts', `${revision.replace('sha256:', '').slice(0, 16)}.patch`)
    await fs.writeFile(file, patch, 'utf8')

    const reconstruction = await verifyReconstruction({ workspacePath, baseCommit, baseline, patchFile: file, expected: revision, expectedPaths, clock, gitDir })
    return { artifactRef: path.relative(runDir, file), bytes: Buffer.byteLength(patch), reconstruction,
      patchHash: 'sha256:' + crypto.createHash('sha256').update(patch).digest('hex') }
  }
}

/** The run's start, in epoch seconds, read from its id (`2026-09-26T15-02-24-449Z-…`); a fixed date when the id has none. */
export function runEpoch (runDir) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(path.basename(runDir))
  if (!m) return 1000000000
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000)
}

/**
 * Commit delivery: the candidate becomes a commit on a devpanel/ branch in the
 * repository that owns the worktree, parented on the base commit, built from
 * a throwaway index exactly as the patch is. The patch is still written (it
 * is the portable form), and the commit is verified the same way: checked out
 * into a temporary worktree and fingerprinted against the revision. Nothing
 * here touches any branch anyone has checked out; integration is a separate,
 * approved step.
 */
async function commitDelivery ({ revision, fingerprint: fp, baseCommit, baseline, workspacePath, runDir, clock, label, gitDir = null, workspace = null }) {
  const patchReceipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision, fingerprint: fp, baseCommit, baseline, workspacePath, runDir, clock, gitDir })
  if (patchReceipt.reconstruction?.verified !== true) return { ...patchReceipt, commit: null, branch: null, repository: null }

  const entries = fp?.entries ?? (await fingerprint(workspacePath, { baseCommit, baseline, clock, projection: workspaceProjection(workspace) })).entries
  const changed = entries.filter((e) => e.status === 'added' || e.status === 'modified').map((e) => e.path)
  const deleted = entries.filter((e) => e.status === 'deleted').map((e) => e.path)
  const indexFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-commit-')), 'index')
  // The commit's dates come from the run, not the clock: a replay (finalize,
  // a repeated delivery) of the same revision must rebuild the same commit
  // id, or publication could not tell its own earlier work from a stranger's.
  const date = `${runEpoch(runDir)} +0000`
  const env = engineGitEnv({
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: 'devpanel', GIT_AUTHOR_EMAIL: 'devpanel@localhost', GIT_COMMITTER_NAME: 'devpanel', GIT_COMMITTER_EMAIL: 'devpanel@localhost',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date
  })
  const git = (args) => run('git', [...worktreeGitArgs(workspacePath, gitDir), ...args], { ...BIG, env })
  let commit
  try {
    await git(['read-tree', baseCommit])
    if (changed.length) await git(['add', '--force', '--', ...changed])
    if (deleted.length) await git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...deleted])
    const tree = (await git(['write-tree'])).stdout.trim()
    const message = `${label ?? 'devpanel candidate'}${String.fromCharCode(10)}${String.fromCharCode(10)}Revision: ${revision}${String.fromCharCode(10)}Base: ${baseCommit}`
    commit = (await git(['commit-tree', tree, '-p', baseCommit, '-m', message])).stdout.trim()
  } finally {
    await fs.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {})
  }
  const branch = `devpanel/${path.basename(path.dirname(runDir)) === 'runs' ? path.basename(path.dirname(path.dirname(runDir))) : 'candidate'}/${path.basename(runDir).slice(-8)}`
  await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'update-ref', `refs/heads/${branch}`, commit])
  const repository = (await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim()

  // Verify the COMMIT, not just the patch: check it out and fingerprint it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-commit-verify-'))
  let committed = { verified: false, fingerprint: null }
  try {
    await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'worktree', 'add', '--detach', '--quiet', dir, commit])
    const rebuilt = await fingerprint(dir, { baseCommit, baseline, clock })
    committed = { verified: rebuilt.fingerprint === revision, fingerprint: rebuilt.fingerprint }
  } finally {
    await discardReconstruction({ dir, workspacePath, gitDir })
  }
  const reconstruction = { ...patchReceipt.reconstruction, commit: committed, verified: patchReceipt.reconstruction.verified && committed.verified }
  const privateRepository = workspace?.repository?.kind === 'private' ? workspace.repository : null
  if (!privateRepository) return { ...patchReceipt, reconstruction, commit, branch, repository }
  // Private repositories (0d): the verified commit is published into the
  // source repository, translated onto the source base, before any receipt
  // names it. The receipt names the source repository and the commit
  // integration would merge; the reviewed commit is kept beside it.
  if (!reconstruction.verified) return { ...patchReceipt, reconstruction, commit, branch, repository: null }
  const publication = await publishCandidate({ repository: privateRepository, runId: path.basename(runDir), runDir, reviewed: commit, filteredBase: baseCommit,
    sourceBase: workspace.sourceBase ?? baseCommit, branch, materialized: [...(workspace.symlinks?.materialized ?? []), ...(workspace.base?.nested ?? []).map((n) => n.path)] })
  if (!publication.published) {
    return { ...patchReceipt, reconstruction: { ...reconstruction, verified: false, detail: publication.reason }, commit, branch, repository: null, publication }
  }
  return { ...patchReceipt, reconstruction, commit: publication.integration, reviewed: commit, sourceBase: workspace.sourceBase ?? baseCommit, filteredBase: baseCommit,
    branch: publication.integration ? branch : null, repository: publication.repository, publication: { translation: publication.translation, refs: publication.refs, ...(publication.reason ? { reason: publication.reason } : {}) } }
}

/**
 * Rebuild the candidate from the base commit plus the patch, in a temporary
 * worktree, and fingerprint what comes out. The verdict is a comparison of
 * fingerprints, not a "git apply succeeded" — apply can succeed and still leave
 * a file whose mode or content the fingerprint records differently.
 */
export async function verifyReconstruction ({ workspacePath, baseCommit, baseline, patchFile, expected, expectedPaths = null, clock, gitDir = null }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-reconstruct-'))
  const result = { verified: false, fingerprint: null, expected, detail: null, paths: null }
  try {
    const size = (await fs.stat(patchFile)).size

    // The patch may touch only what the fingerprint recorded as changed. A path
    // outside that set is content nobody reviewed, and a path the fingerprint
    // excludes would not even show up in the comparison below — so the set is
    // checked by name, before any bytes are compared.
    if (expectedPaths) {
      const touched = new Set()
      if (size > 0) {
        const { stdout } = await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'apply', '--numstat', '-z', patchFile], BIG)
        for (const line of stdout.split(String.fromCharCode(0))) {
          const m = /^\S+\t\S+\t(.+)$/.exec(line)
          if (m) touched.add(m[1])
        }
      }
      const extra = [...touched].filter((p) => !expectedPaths.has(p))
      const missing = [...expectedPaths].filter((p) => !touched.has(p))
      result.paths = { touched: touched.size, extra, missing }
      if (extra.length) {
        result.detail = `patch touches ${extra.length} path(s) outside the fingerprinted candidate: ${extra.slice(0, 5).join(', ')}`
        return result
      }
      if (missing.length) {
        result.detail = `patch omits ${missing.length} changed path(s): ${missing.slice(0, 5).join(', ')}`
        return result
      }
    }

    await reconstructInto({ dir, workspacePath, baseCommit, patchFile, gitDir })
    const rebuilt = await fingerprint(dir, { baseCommit, baseline, clock })
    result.fingerprint = rebuilt.fingerprint
    result.verified = rebuilt.fingerprint === expected
    if (!result.verified) {
      // Name what differs, so the failure is actionable rather than a hash pair.
      const want = new Map((await fingerprint(workspacePath, { baseCommit, baseline, clock })).entries.map((e) => [e.path, e]))
      const got = new Map(rebuilt.entries.map((e) => [e.path, e]))
      const paths = new Set([...want.keys(), ...got.keys()])
      const diffs = [...paths].filter((p) => JSON.stringify(want.get(p) ?? null) !== JSON.stringify(got.get(p) ?? null))
      result.detail = `reconstruction differs at ${diffs.length} path(s): ${diffs.slice(0, 5).join(', ')}`
    }
  } catch (error) {
    result.detail = `reconstruction failed: ${error.stderr?.toString().trim() || error.message}`
  } finally {
    await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'worktree', 'remove', '--force', dir]).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return result
}


/**
 * One git worktree per run, from an explicit base commit chosen by policy.
 *
 * The base is a decision, recorded on the run, never an accident of what HEAD
 * happened to be:
 *
 *   head           the checked-out commit. With requireCleanBase (the default)
 *                  a checkout with tracked modifications is REFUSED — a
 *                  candidate cut from HEAD while the live tree has moved is a
 *                  patch against something that is not deployed.
 *   working-tree   a snapshot commit of the checkout exactly as it is —
 *                  tracked modifications, untracked files, symlinks — kept
 *                  reachable under refs/devpanel/base/<runId>. For projects
 *                  whose live state is not committed.
 *   { commit }     an explicit ref.
 */
/**
 * Rebuild a candidate into `dir`: a detached worktree of the base commit with
 * the patch applied. Shared by delivery verification and the check runner, so
 * what is checked is exactly what was delivered.
 */
export async function reconstructInto ({ dir, workspacePath, baseCommit, patchFile, gitDir = null }) {
  await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'worktree', 'add', '--detach', '--quiet', dir, baseCommit])
  const size = (await fs.stat(patchFile)).size
  if (size > 0) await run('git', ['-C', dir, 'apply', '--binary', '--whitespace=nowarn', patchFile], BIG)
}

/** Remove a reconstruction worktree, whichever repository registered it. */
export async function discardReconstruction ({ dir, workspacePath, gitDir = null }) {
  await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'worktree', 'remove', '--force', dir]).catch(() => {})
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  // A removal that failed (for example because the entry was tampered with) must
  // not leave the reconstruction registered in the source repository.
  await run('git', [...repositoryGitArgs(workspacePath, gitDir), 'worktree', 'prune']).catch(() => {})
}

/**
 * The exclusions whose literal directory prefix stays inside the checkout, i.e.
 * does not pass through a symlink (the link itself may be named). The others
 * apply inside materialized links (selection v1) and would make git refuse the
 * whole pathspec.
 */
async function withinCheckout (projectPath, patterns) {
  const out = []
  for (const pattern of patterns) {
    const parts = pattern.split('/')
    const literal = []
    for (const part of parts.slice(0, -1)) { if (/[*?[]/.test(part)) break; literal.push(part) }
    let through = false
    for (let i = 1; i <= literal.length && !through; i++) {
      through = await fs.lstat(path.join(projectPath, ...literal.slice(0, i))).then((st) => st.isSymbolicLink(), () => false)
    }
    if (!through) out.push(pattern)
  }
  return out
}

export const gitWorktreeProvider = {
  isolation: 'git-worktree',
  async create ({ projectPath, runId, root, policy = {} }) {
    const git = (args, opts = {}) => run('git', ['-C', projectPath, ...args], { ...BIG, ...opts })
    // The panel's own Git store (git-store.mjs), when the host keeps one: the
    // snapshot's objects and refs and the worktree's registration go there, and
    // the project repository is only read. Private repositories only (0d): a
    // legacy run's worktree stays registered in the project.
    const gitStore = policy.repository === 1 && policy.store
      ? await ensureGitStore({ dir: policy.store, sourceRepository: (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim() })
      : null
    const objectEnv = gitStore ? { GIT_OBJECT_DIRECTORY: gitStore.objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: gitStore.sourceObjects } : {}
    const repo = gitStore ? (args, opts = {}) => run('git', ['--git-dir', gitStore.dir, ...args], { ...BIG, ...opts }) : git
    const headCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
    const status = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout.split(String.fromCharCode(10)).filter(Boolean)
    const dirtyPaths = status.filter((l) => !l.startsWith('??')).length
    const untrackedPaths = status.filter((l) => l.startsWith('??')).length

    const base = policy.base ?? 'head'
    const kind = typeof base === 'object' ? 'commit' : base
    // What a working-tree snapshot leaves out: runtime state, secrets and
    // dependency trees the project keeps beside its source. Pathspec globs, so
    // `**/node_modules` reaches a symlinked one that .gitignore's `node_modules/`
    // (directories only) does not. Under snapshot selection v1
    // (fence.selection: 1) an exclusion is a confidentiality rule and holds for
    // every base policy, not only working-tree.
    const selection = policy.selection === 1
    const excludes = kind === 'working-tree' || selection ? (policy.excludes ?? []) : []
    // The project's tooling mount targets (workspace.tooling.mounts) are never
    // read into the snapshot: the seat fence binds tooling there read-only. An
    // untracked file there is not added; tracked content there leaves the
    // target occupied, and the engine refuses to mount over it.
    const toolingMounts = (policy.tooling?.mounts ?? []).map((m) => m.target)
    // Git refuses a pathspec that reaches through a symlink ("beyond a symbolic
    // link"). Under selection v1 an exclusion inside a materialized link is
    // applied while materializing, so the checkout-level snapshot only gets the
    // ones that stay inside the checkout.
    const checkoutExcludes = selection ? await withinCheckout(projectPath, excludes) : excludes
    const checkoutMounts = await withinCheckout(projectPath, toolingMounts)
    let baseCommit
    let snapshotRef = null
    // Nested repositories whose content the snapshot carries (working-tree only).
    let nestedRoots = []
    let nested = []
    let ref = null
    // A: the commit the snapshot was cut from, before exclusions and
    // materialization. Only what the reviewed delta changes may reach it.
    let sourceBase = null
    // Snapshot commits are a function of their content: no run id in the
    // message, HEAD's committer time as the date. Two runs cut from the same
    // checkout on the same HEAD get the same base commit, as two runs on a
    // `head` base always did, so a baseline keyed on it can be reused across
    // runs (baseline-cache.mjs). Run identity lives in the refs named for it.
    const snapshotDate = `${(await git(['log', '-1', '--format=%ct', headCommit])).stdout.trim()} +0000`
    const snapshotIdentity = { GIT_AUTHOR_NAME: 'devpanel', GIT_AUTHOR_EMAIL: 'devpanel@localhost', GIT_COMMITTER_NAME: 'devpanel', GIT_COMMITTER_EMAIL: 'devpanel@localhost', GIT_AUTHOR_DATE: snapshotDate, GIT_COMMITTER_DATE: snapshotDate }

    if (kind === 'head') {
      if ((policy.requireCleanBase ?? true) && dirtyPaths > 0) {
        const error = new Error(`base policy "head" requires a clean checkout, but ${dirtyPaths} tracked path(s) are modified in ${projectPath}. Choose base "working-tree" to cut from the checkout as it is, name a commit, or clean the checkout.`)
        error.code = 'DIRTY_BASE'
        throw error
      }
      baseCommit = headCommit
      sourceBase = headCommit
    } else if (kind === 'working-tree') {
      // A commit object of the checkout as it is, built through a throwaway
      // index so the project's own index is never touched. Parent HEAD, so
      // history shows what it was cut from.
      const indexFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-base-')), 'index')
      const env = engineGitEnv({ GIT_INDEX_FILE: indexFile, ...snapshotIdentity, ...objectEnv })
      // The same classification the launch condition read with. If it says the
      // tree cannot be snapshotted, say so here rather than letting `git add -A`
      // fail halfway through with its own words: a reading and a build that
      // disagree is how a run gets approved and then dies holding the money.
      const scan = await classifyUntracked({ projectPath, excludes: [...checkoutExcludes, ...checkoutMounts], run: (args) => run('git', args, BIG).then((r) => r.stdout) })
      if (scan.blocking.length) {
        const error = new Error(`${describeBlocking(scan.blocking)}. Base policy "working-tree" snapshots the checkout as it is, and this path is not something git can record.`)
        error.code = 'UNREADABLE_WORKTREE'
        throw error
      }
      try {
        await git(['read-tree', headCommit], { env })
        // `git add` without --force fails ("The following paths are ignored…")
        // when an exclude pathspec names a path .gitignore already ignores, as a
        // mount target such as gui/node_modules usually is. An ignored target is
        // never added anyway, so only the unignored ones are excluded here.
        const ignoredMounts = new Set()
        for (const target of checkoutMounts) {
          // check-ignore exits 0 when the path is ignored, 1 when it is not.
          try { await run('git', ['-C', projectPath, 'check-ignore', '-q', '--', target], BIG); ignoredMounts.add(target) } catch { /* not ignored */ }
        }
        await git(['add', '-A', '--', ...snapshotPathspec([...checkoutExcludes, ...checkoutMounts.filter((t) => !ignoredMounts.has(t))])], { env })
        // Nested repositories (host settings nestedRepositories: include) are
        // gitlinks in that index; their content replaces them below.
        if (policy.nested === 'include') nestedRoots = await nestedRepositories({ projectPath, git: (args) => git(args, { env }).then((r) => r.stdout) })
        // Private repositories (0d) integrate through the source base A: the
        // checkout as it is, except that an excluded path keeps HEAD's content
        // (tracked) or is left out (untracked), so no excluded secret reaches
        // any commit. S, the snapshot, is A without the excluded tracked paths
        // and with the nested repositories' content in place of their gitlinks.
        if (policy.repository === 1 && (checkoutExcludes.length || nestedRoots.length)) {
          const unfiltered = (await git(['write-tree'], { env })).stdout.trim()
          sourceBase = (await git(['commit-tree', unfiltered, '-p', headCommit, '-m', 'devpanel source base'], { env })).stdout.trim()
        }
        if (nestedRoots.length) {
          nested = await includeNested({ projectPath, nested: nestedRoots, excludes: [...checkoutExcludes, ...checkoutMounts], env, exec: runProcess,
            git: (args, opts) => git(args, opts) })
        }
        // A path excluded from the snapshot but present in HEAD would otherwise
        // survive through read-tree; the base must not carry what it excludes.
        if (checkoutExcludes.length) await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...checkoutExcludes.map((p) => `:(glob)${p}`)], { env })
        const tree = (await git(['write-tree'], { env })).stdout.trim()
        baseCommit = (await git(['commit-tree', tree, '-p', sourceBase ?? headCommit, '-m', 'devpanel base snapshot'], { env })).stdout.trim()
        sourceBase ??= baseCommit
      } finally {
        await fs.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {})
      }
      snapshotRef = `refs/devpanel/base/${runId}`
      await repo(['update-ref', snapshotRef, baseCommit])
    } else {
      ref = base.commit
      baseCommit = (await git(['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim()
      sourceBase = baseCommit
    }

    // Selection v1: a head or commit base with exclusions gets a filtered child
    // commit, so an excluded tracked file is absent from the snapshot's tree and
    // objects, as it already is for working-tree. Nothing changes when the
    // exclusions match nothing.
    let sourceRevision = null
    if (selection && kind !== 'working-tree' && checkoutExcludes.length) {
      const indexFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-filter-')), 'index')
      const env = engineGitEnv({ GIT_INDEX_FILE: indexFile, ...snapshotIdentity, ...objectEnv })
      try {
        await git(['read-tree', baseCommit], { env })
        await git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...checkoutExcludes.map((p) => `:(glob)${p}`)], { env })
        const tree = (await git(['write-tree'], { env })).stdout.trim()
        if (tree !== (await git(['rev-parse', `${baseCommit}^{tree}`])).stdout.trim()) {
          sourceRevision = baseCommit
          baseCommit = (await git(['commit-tree', tree, '-p', baseCommit, '-m', 'devpanel filtered base'], { env })).stdout.trim()
          snapshotRef = `refs/devpanel/base/${runId}`
          await repo(['update-ref', snapshotRef, baseCommit])
        }
      } finally {
        await fs.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {})
      }
    }

    const dir = path.join(root, `worktree-${runId}`)
    await repo(['worktree', 'add', '--detach', dir, baseCommit])

    // Symlinks that leave the worktree are the one way a candidate reaches live
    // files. The policy decides; nothing is silently kept.
    const found = await escapingLinks(dir)
    const symlinks = { policy: policy.symlinks ?? 'reject', escaping: found.map((l) => ({ path: l.path, target: l.target })), materialized: [] }
    // A link whose target does not exist has nothing to materialize: it stays
    // the link it is in the checkout (so snapshot, source and destination
    // agree) and is recorded. Inside the fence its target is not mounted.
    let escaping = found
    if (symlinks.policy === 'materialize') {
      const live = []
      const dangling = []
      for (const l of found) (await fs.stat(path.join(projectPath, l.path)).then(() => true, () => false) ? live : dangling).push(l)
      escaping = live
      if (dangling.length) symlinks.dangling = dangling.map((l) => ({ path: l.path, target: l.target }))
    }
    if (escaping.length && symlinks.policy === 'reject') {
      await repo(['worktree', 'remove', '--force', dir]).catch(() => {})
      const error = new Error(`${escaping.length} symlink(s) in the checkout point outside it (${escaping.slice(0, 3).map((l) => `${l.path} -> ${l.target}`).join(', ')}${escaping.length > 3 ? ', …' : ''}). A write through such a link changes a live file the candidate does not record. Choose symlinks "materialize" to copy their targets into the worktree, or "allow" to accept that.`)
      error.code = 'ESCAPING_SYMLINKS'
      throw error
    }
    if (escaping.length && symlinks.policy === 'materialize') {
      symlinks.owners = await bindSourceOwners(projectPath, { ...symlinks, materialized: escaping.map(l => l.path) }, sourceTarget)
      if (selection) {
        // Selection v1: every target is authorized BEFORE anything is copied,
        // and each carries only what its owning repository would carry.
        const { roots: forbidden, mounts } = await forbiddenRootsReport()
        const authorize = authorizer({ known: await knownProjectRoots(), grants: policy.materializeGrants ?? [], forbidden, exempt: await homeExemption() })
        // How the container mounts were found (read, unreadable, not applicable on darwin).
        const record = { rule: SELECTION_RULE, consumerExcludes: [...excludes, ...toolingMounts], owners: [], skipped: [], mounts }
        const plans = []
        try {
          for (const l of escaping) {
            const files = []
            const resolved = await fs.realpath(path.join(projectPath, l.path))
            const owners = await walkSelection({ linkPath: l.path, resolved, consumerExcludes: [...excludes, ...toolingMounts], authorize,
              onFile: (rel, full) => { files.push([rel, full]) }, onSkip: (rel, why) => { record.skipped.push({ path: rel, reason: why }) } })
            plans.push({ link: l, files, directory: (await fs.stat(resolved)).isDirectory() })
            record.owners.push(...owners)
          }
        } catch (error) {
          await repo(['worktree', 'remove', '--force', dir]).catch(() => {})
          if (snapshotRef && kind !== 'working-tree') await repo(['update-ref', '-d', snapshotRef]).catch(() => {})
          throw error
        }
        for (const { link, files, directory } of plans) {
          await fs.rm(path.join(dir, link.path), { force: true })
          // A link to a directory becomes a directory (even if nothing in it is
          // selected); a link to a file becomes that file, or nothing when the
          // owner would not carry it.
          if (directory) await fs.mkdir(path.join(dir, link.path), { recursive: true })
          for (const [rel, full] of files) await copySelected(dir, rel, full)
          symlinks.materialized.push(link.path)
        }
        record.files = plans.reduce((n, p) => n + p.files.length, 0)
        symlinks.selection = record
      } else {
        for (const l of escaping) {
          const full = path.join(dir, l.path)
          await fs.rm(full, { force: true })
          await fs.cp(l.resolved, full, { recursive: true, dereference: true, errorOnExist: false })
          symlinks.materialized.push(l.path)
        }
      }
      // The copies are the base now, not a change: re-snapshot the worktree
      // into a commit and cut from that, so fingerprint, patch and commit all
      // agree on what "unchanged" means.
      const indexFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-materialize-')), 'index')
      const env = engineGitEnv({ GIT_INDEX_FILE: indexFile, ...snapshotIdentity })
      const wt = (args) => run('git', ['-C', dir, ...args], { ...BIG, env })
      try {
        await wt(['read-tree', baseCommit])
        // The copied targets stay on disk in full (a dependency tree a test drive
        // needs), but the excluded paths are not committed into the base: they
        // are not source, and every run's base ref would otherwise keep them
        // reachable in the project's repository.
        await wt(['add', '-A', '--force', '--', ...symlinks.materialized, ...[...excludes, ...toolingMounts].map((p) => `:(glob,exclude)${p}`)])
        const tree = (await wt(['write-tree'])).stdout.trim()
        const materializedCommit = (await wt(['commit-tree', tree, '-p', baseCommit, '-m', `devpanel materialized ${symlinks.materialized.length} escaping symlink(s)`])).stdout.trim()
        snapshotRef = `refs/devpanel/base/${runId}`
        await repo(['update-ref', snapshotRef, materializedCommit])
        await run('git', ['-C', dir, 'update-ref', 'HEAD', materializedCommit])
        // The temporary index built the new commit; the candidate's real index
        // still names the original symlinks. Align it with the materialized
        // tree so tracked-path integrity checks see the copied files too.
        // read-tree changes only this detached worktree's index, not its files
        // or the source checkout's index.
        await run('git', ['-C', dir, 'read-tree', materializedCommit])
        baseCommit = materializedCommit
      } finally {
        await fs.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {})
      }
    }

    // Recorded now, before any seat has run: later host Git calls name this
    // directory instead of discovering it through the worktree's `.git` entry,
    // and integrity compares that entry against what was written here.
    let gitDir = await fs.realpath((await run('git', ['-C', dir, 'rev-parse', '--absolute-git-dir'])).stdout.trim())
    let gitEntry = await fs.readFile(path.join(dir, '.git'), 'utf8')
    let repository = null
    if (policy.repository === 1) {
      try {
        ;({ gitDir, gitEntry, repository } = await privateRepositories({ projectPath, dir, runDir: path.join(root, runId), runId, baseCommit, snapshotRef, linkedGitDir: gitDir, store: gitStore?.dir ?? null }))
        snapshotRef = repository.snapshotRef
      } catch (error) {
        // Nothing has run in it: take the fresh checkout down with whatever of
        // the repositories was built, and refuse the start with the reason.
        await repo(['worktree', 'remove', '--force', dir]).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
        await fs.rm(path.join(root, runId, 'git'), { recursive: true, force: true }).catch(() => {})
        throw Object.assign(new Error(`the run's private repository could not be built: ${error.message.split(String.fromCharCode(10))[0]}`), { code: 'PRIVATE_REPOSITORY' })
      }
    }
    return {
      path: dir,
      baseCommit,
      gitDir,
      gitEntry,
      ...(repository ? { repository, sourceBase } : {}),
      isolation: 'git-worktree',
      base: { policy: kind, ref, headCommit, snapshotRef, dirtyPaths, untrackedPaths, excludes, ...(selection ? { selection: SELECTION_RULE } : {}), ...(sourceRevision ? { sourceRevision } : {}), ...(nested.length ? { nested } : {}) },
      // Left out of every fingerprint of this worktree (workspaceProjection).
      ...(toolingMounts.length ? { toolingMounts } : {}),
      symlinks,
      source: await sourceTarget(projectPath)
    }
  },
  async release ({ projectPath, path: dir, repository = null }) {
    // A private repository's work tree is registered nowhere: it and both Git
    // directories go (fs.rm never follows a link out of the tree).
    if (repository?.kind === 'private') {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rm(repository.root, { recursive: true, force: true })
      return
    }
    await run('git', ['-C', projectPath, 'worktree', 'remove', '--force', dir]).catch(() => {})
  }
}

/**
 * Build the run's engine and worker Git directories (0d; engine-git.mjs) and
 * move the fresh work tree onto them. The snapshot ref is always pinned in the
 * source (the project repository, or the panel's Git store when the host keeps
 * one: base pinning), so the depth-1 fetch and the candidate's parent stay
 * reachable after the run's directories are gone.
 */
async function privateRepositories ({ projectPath, dir, runDir, runId, baseCommit, snapshotRef, linkedGitDir, store = null }) {
  const env = engineGitEnv()
  const g = (args) => run('git', [...HARDENED, ...args], { ...BIG, env })
  // With the panel's Git store, the store is the run's source repository: the
  // snapshot is pinned and fetched there, and publication writes there.
  const source = store ?? await fs.realpath((await g(['-C', projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim())
  if (!linkedGitDir.startsWith(path.join(source, 'worktrees') + path.sep)) throw new Error(`the fresh worktree's git directory ${linkedGitDir} is not a registration of ${source}`)
  const ref = snapshotRef ?? `refs/devpanel/base/${runId}`
  if (!snapshotRef) await g(['--git-dir', source, 'update-ref', ref, baseCommit])
  const root = path.join(runDir, 'git')
  const engine = path.join(root, 'engine')
  const worker = path.join(root, 'worker')
  await fs.mkdir(root, { recursive: true })
  await g(['-c', 'init.defaultBranch=devpanel', 'init', '-q', '--bare', engine])
  await g([...LOCAL_TRANSPORT, '--git-dir', engine, 'fetch', '-q', '--no-tags', '--depth=1', `file://${source}`, `+${ref}:refs/devpanel/base`])
  const fetched = (await g(['--git-dir', engine, 'rev-parse', '--verify', 'refs/devpanel/base^{commit}'])).stdout.trim()
  if (fetched !== baseCommit) throw new Error(`the fetched snapshot is ${fetched}, not the base ${baseCommit}`)
  await g(['--git-dir', engine, 'update-ref', '--no-deref', 'HEAD', baseCommit])
  // The empty tree, for diffs against nothing, without writing into the source.
  await g(['--git-dir', engine, 'hash-object', '-w', '-t', 'tree', '/dev/null'])

  await g(['-c', 'init.defaultBranch=devpanel', 'init', '-q', '--bare', worker])
  await g(['--git-dir', worker, 'config', 'core.bare', 'false'])
  await g(['--git-dir', worker, 'config', 'user.name', 'devpanel seat'])
  await g(['--git-dir', worker, 'config', 'user.email', 'seat@devpanel.invalid'])
  await fs.writeFile(path.join(worker, 'objects', 'info', 'alternates'), path.join(engine, 'objects') + String.fromCharCode(10))
  // The base's parent is not in the engine's objects; the worker must know
  // where its history ends, as the engine does.
  await fs.copyFile(path.join(engine, 'shallow'), path.join(worker, 'shallow')).catch(() => {})
  await g(['--git-dir', worker, 'update-ref', '--no-deref', 'HEAD', baseCommit])

  // The work tree now names the worker directory; its registration in the
  // source repository goes, so nothing there refers to the run any more.
  const gitEntry = `gitdir: ${worker}${String.fromCharCode(10)}`
  await fs.writeFile(path.join(dir, '.git'), gitEntry)
  await fs.rm(linkedGitDir, { recursive: true, force: true })
  // Both indexes describe the base, so status and diff start clean.
  for (const gitDir of [engine, worker]) {
    await g(['--git-dir', gitDir, '--work-tree', dir, 'read-tree', baseCommit])
    await g(['--git-dir', gitDir, '--work-tree', dir, 'update-index', '-q', '--refresh']).catch(() => {})
  }
  return { gitDir: engine, gitEntry, repository: { kind: 'private', root, engine, worker, source, snapshotRef: ref } }
}

/**
 * Reserve a run: resolve the playbook, take ownership, write durable state.
 *
 * Nothing here spends anything. It exists so that everything which follows —
 * probing at model depth, which costs a call per model — happens inside a run
 * that can be inspected, attributed and stopped. A reservation whose preflight
 * is refused stays on disk as a failed run carrying what it spent; deleting it
 * would erase the only record that money went out.
 */
export async function reserveRun ({
  playbookId,
  supervisorLaunchId = null,
  issue,
  issuePath,
  configRoot,
  clock = systemClock,
  status = 'preflighting',
  expectConfigHash = null,
  runOptions = {},
  platform = hostPlatform(),
  // Open cleanup entries the barrier file could not be written with (the
  // supervisor holds them): they bar an in-place start like the file's own.
  unrecordedBarrier = []
}) {
  const resolution = await resolvePlaybook(playbookId, { root: configRoot, runOptions, projectId: issue?.project })
  if (!resolution.ok) {
    const error = new Error(resolution.errors.map((e) => `${e.field}: ${e.message}`).join('; '))
    error.status = 422
    error.errors = resolution.errors
    throw error
  }

  if (Object.keys(runOptions).length && !expectConfigHash) {
    throw Object.assign(new Error('preview the run settings before starting'), { status: 400 })
  }

  // The caller may pin the configuration it was shown. A playbook edited between
  // the preview and the start would otherwise run as something nobody read.
  if (expectConfigHash && resolution.resolved.configHash !== expectConfigHash) {
    throw Object.assign(
      new Error('the playbook changed since it was previewed — review it again before starting'),
      { status: 409, expected: expectConfigHash, actual: resolution.resolved.configHash }
    )
  }

  const runId = store.newRunId(clock)

  // One active run per issue. Taken before any durable state exists, so a refused
  // acquisition cannot leave a stray run directory behind.
  const runLock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'run', runId, clock })

  try {
    await requireUnarchived(issuePath)
    // A new run must not sidestep an unresolved integrity quarantine on this
    // issue. Check under the issue lock, before creating any new run state.
    const prior = await fs.readdir(store.runsDir(issuePath), { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const entry of prior.filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))) {
      const previous = await store.readRun(issuePath, entry.name).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (previous?.abandonment && previous.status === 'cancelled') continue
      if (previous?.journal?.recoveryRequired) throw Object.assign(new Error(`run ${previous.runId} requires event journal recovery before starting another run`), { status: 409 })
      if (previous?.integrity?.status === 'quarantined') throw Object.assign(new Error(`run ${previous.runId} requires a source integrity recovery disposition before starting another run`), { status: 409 })
    }
    // An in-place workspace is the project checkout, which every issue shares:
    // no new writer while a run's escaped descendants are unproved (cleanup-barrier.mjs).
    if (resolution.resolved.workspace?.isolation === 'in-place') {
      const refusal = barrierRefusal(await readBarrier(path.dirname(issuePath)), { unrecorded: unrecordedBarrier })
      if (refusal) throw refusal
    }
    const run = await store.initRun(issuePath, { runId, issue, resolved: resolution.resolved, clock, supervisorLaunchId })
    run.status = status
    // The host it runs on, and what that host cannot do (platform.mjs).
    run.host = platform.describe()
    // A run on a host without the fence, under the install's opt-in, says so
    // from its first record (confinement-policy.mjs; result.md, the run page).
    const fence = fencePolicy({ platform })
    if (fence.mode === 'unfenced') run.unfenced = unfencedRecord(fence, clock.iso())
    run.preflight = {
      state: 'pending',
      depth: null,
      startedAt: clock.iso(),
      endedAt: null,
      attempts: 0,
      usage: null,
      summary: null,
      detail: null
    }
    await store.writeRun(issuePath, runId, run)
    return { runId, runLock, resolution, run, issuePath, clock }
  } catch (error) {
    await runLock.release()
    throw error
  }
}

/**
 * Record what preflight cost and what it concluded, whatever it concluded.
 *
 * Attempts and usage are written on refusal and cancellation too: the calls were
 * made, so the run has to say so.
 */
export async function recordPreflight (reservation, { state, result = null, usage = null, detail = null, depth = null }) {
  const { run, issuePath, runId, clock } = reservation
  run.preflight = {
    ...run.preflight,
    state,
    depth,
    endedAt: clock.iso(),
    attempts: usage?.invocations ?? run.preflight?.attempts ?? 0,
    usage: usage
      ? { tokens: usage.tokens ?? 0, costUsd: usage.costUsd ?? 0, costUnknownCalls: usage.costUnknownCalls ?? 0 }
      : run.preflight?.usage ?? null,
    summary: result
      ? `${result.failures?.length ?? 0} failure(s), ${result.unknowns?.length ?? 0} unproven`
      : run.preflight?.summary ?? null,
    detail,
    // Unfenced operation, as preflight found it (macOS under its opt-in).
    ...(result?.fence ? { fence: result.fence } : {})
  }
  await store.writeRun(issuePath, runId, run)
  return run
}

/**
 * Settle a reservation that will never run, keeping the record and releasing the
 * issue. The workspace does not exist yet at this point, so there is nothing to
 * preserve but the reason.
 */
export async function abandonReservation (reservation, { status = 'failed', blockedReason = null, outcome = 'unresolved' } = {}) {
  const { run, issuePath, runId, runLock, clock } = reservation
  run.status = status
  run.outcome = outcome
  run.blockedReason = blockedReason
  run.endedAt = clock.iso()
  await store.writeRun(issuePath, runId, run)
  await runLock.release()
  return run
}

/**
 * Turn a proven reservation into a driveable engine: workspace, baseline, engine.
 * Called only after preflight gave positive evidence.
 */
export async function provisionRun (reservation, {
  projectPath,
  projectAlias = projectPath,
  harnesses,
  stepStore,
  workspaceProvider = gitWorktreeProvider,
  hooks = {},
  emit = null,
  deliveryProvider = null,
  configRoot,
  availability = null,
  platform = hostPlatform()
}) {
  const { runId, runLock, run, issuePath, clock } = reservation
  projectPath = await fs.realpath(projectPath)

  const staged = reservation.resolution.resolved.tactic === 'deployment'
    ? await stagedRelease(path.dirname(issuePath),reservation.resolution.resolved.runOptions.releaseId) : null
  if (staged) workspaceProvider = {
    async create ({root,runId}) {
      const dir=path.join(root,`workspace-${runId}`)
      await fs.mkdir(dir)
      await promisify(execFile)('tar',['-xpf',staged.archive,'-C',dir])
      return {path:dir,baseCommit:null,isolation:'none',base:{policy:'staged-release',releaseId:staged.runId,sha256:staged.sha256}}
    },
    async release ({path:dir}) { await fs.rm(dir,{recursive:true,force:true}) }
  }
  if (!staged && reservation.resolution.resolved.workspace.isolation === 'in-place') workspaceProvider = inPlaceProvider
  const workspace = await workspaceProvider.create({
    projectPath, runId, root: path.join(issuePath, 'runs'),
    policy: { ...reservation.resolution.resolved.workspace, selection: reservation.resolution.resolved.fence?.selection ?? 0, repository: reservation.resolution.resolved.fence?.repository ?? 0,
      // The issue lives at <issue root>/<project>/<issue>: the project names its store.
      store: gitStoreDir(path.basename(path.dirname(issuePath))), nested: hostSettings().nestedRepositories }
  })

  // Run-owned scratch space, outside the worktree so nothing written there can
  // enter the candidate, and inside the run directory so it is kept with the
  // run rather than left under the live project's tree.
  const scratchPath = path.join(store.runDir(issuePath, runId), 'scratch')
  await fs.mkdir(scratchPath, { recursive: true })

  // Related projects (Phase 2): read-only run-start snapshots, never part of
  // the candidate. Only under selection v1, where the export rule is defined.
  const relatedPolicy = reservation.resolution.resolved.workspace.related ?? []
  const related = []
  if (relatedPolicy.length && (reservation.resolution.resolved.fence?.selection ?? 0) === 1 && workspace.isolation !== 'in-place') {
    for (const entry of relatedPolicy) {
      const target = path.join(store.runDir(issuePath, runId), 'related', entry.project)
      try {
        const source = await resolveProjectPath(entry.project)
        related.push({ project: entry.project, reason: entry.reason, ...await exportProject({ projectPath: source, target }) })
      } catch (error) {
        // A related project that cannot be read is reported, not fatal: it is
        // reference material, and the run's own work does not depend on it.
        related.push({ project: entry.project, reason: entry.reason, snapshot: null, error: error.message })
      }
    }
  }

  run.workspace = { ...workspace, ...(reservation.resolution.resolved.workspace.retention ? {retention:reservation.resolution.resolved.workspace.retention} : {}), scratchPath, ...(related.length ? { related } : {}), state: 'active' }
  try {
    if (reservation.resolution.resolved.tactic) run.currentWindow = await captureWindow({ issuePath, runId, workspace, evidence: reservation.resolution.resolved.evidence, limits: reservation.resolution.resolved.windowLimits, accumulate: reservation.resolution.resolved.runOptions?.accumulate === true })
    // The installation's own notes, when the host settings give them to this project (host-guidance.mjs).
    const guidance = await freezeHostGuidance({ issuePath, runId, project: run.issue?.project, root: configRoot ?? DEFAULT_CONFIG_ROOT })
    if (guidance) run.hostGuidance = guidance
    run.status = 'pending'
    await store.writeRun(issuePath, runId, run)

    // The baseline is persisted, not recomputed: rebuilding it on restart would
    // measure the modified workspace against itself.
    const baseline = await baselineOf(workspace.path, { projection: workspaceProjection(workspace) })
    await store.writeBaseline(issuePath, runId, baseline)
    // After the baseline, so a carried-forward patch is part of this candidate.
    const writes = Object.values(reservation.resolution.resolved.participants ?? {}).some((p) => p.writesCode)
    if (writes && !staged && workspace.isolation !== 'in-place') {
      // The earlier run's base snapshot is in the run's source repository: the
      // panel's Git store when the host keeps one, else the project's.
      const sourceRepository = workspace.repository?.source ?? workspace.source?.repository ?? await promisify(execFile)('git', ['-C', projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then((r) => r.stdout.trim(), () => null)
      const seed = await carryForward({ issuePath, runId, workspace: run.workspace, sourceRepository })
      if (seed) {
        run.workspace.seed = seed
        await store.writeRun(issuePath, runId, run)
      }
    }

    const engine = new Engine({ issuePath, runId, harnesses, steps: stepStore, clock, hooks, emit, deliveryProvider, configRoot, availability, platform })
    await engine.load()
    engine.baseline = baseline
    engine.workspaceProvider = engine.run.workspace?.isolation === 'in-place' ? inPlaceProvider : engine.run.workspace?.base?.policy === 'staged-release' ? directoryProvider : workspaceProvider
    engine.projectPath = projectPath
    engine.projectAlias = projectAlias
    engine.runLock = runLock
    await engine.initialiseIntegrity()
    return engine
  } catch (error) {
    // No engine will own this workspace, so nothing else would ever settle it:
    // it stayed "active" and its worktree registered forever. No agent has run
    // in it, so the fresh checkout holds nothing that is not in its base.
    let state = 'removed'
    let detail = null
    if (run.workspace.isolation === 'in-place') state = 'released'
    else {
      try {
        await workspaceProvider.release({ ...workspace, projectPath })
        // The git provider swallows its own failure; the directory is the proof.
        if (await fs.access(workspace.path).then(() => true, () => false)) throw new Error('the worktree is still on disk')
      } catch (releaseError) { state = 'retained'; detail = releaseError.message }
    }
    run.workspace = { ...run.workspace, state, retainedReason: state === 'retained' ? `provisioning failed (${error.message}) and the fresh worktree could not be removed: ${detail}` : null }
    await store.writeRun(issuePath, runId, run).catch(() => {})
    throw error
  }
}

/**
 * Start a run, all phases in one call.
 *
 * The gate is explicit: assertLaunchable throws unless preflight returned
 * launchReady === true, and it throws BEFORE a workspace exists — so a rejected
 * preflight cannot produce an invocation. What it does leave behind is the run
 * record, marked failed, holding what the probes cost.
 */
export async function startRun ({
  playbookId,
  issue,
  issuePath,
  projectPath,
  harnesses,
  stepStore,
  workspaceProvider = gitWorktreeProvider,
  configRoot,
  probe,
  depth = 'model',
  clock = systemClock,
  hooks = {},
  emit = null,
  deliveryProvider = null,
  signal = null,
  runOptions = {},
  expectConfigHash = null,
  availability = null,
  // The host's OS (platform.mjs); injectable so a test can be darwin.
  platform = hostPlatform()
}) {
  const reservation = await reserveRun({ playbookId, issue, issuePath, configRoot, clock, runOptions, expectConfigHash, platform })

  let result = null
  let failure = null
  try {
    result = await preflight(reservation.resolution.resolved, { probe, depth, root: configRoot, signal, projectPath, platform })
  } catch (error) {
    failure = error
  }

  // Recorded before the decision, and whatever the decision is: the probes were
  // made, so what they cost is part of the run's history either way.
  const state = failure
    ? 'errored'
    : result.launchReady === true ? 'passed' : result.cancelled ? 'cancelled' : 'refused'
  const refusal = failure ?? (state === 'passed' ? null : tryAssert(result))
  await recordPreflight(reservation, {
    state, result, usage: probe?.spent ?? null, detail: refusal?.message ?? null, depth
  })

  if (state !== 'passed') {
    await abandonReservation(reservation, {
      status: state === 'cancelled' ? 'cancelled' : 'failed',
      blockedReason: state === 'cancelled' ? null : 'preflight-refused'
    })
    throw refusal
  }

  try {
    return await provisionRun(reservation, {
      projectPath, harnesses, stepStore, workspaceProvider, hooks, emit, deliveryProvider, configRoot, availability, platform
    })
  } catch (error) {
    await abandonReservation(reservation, { blockedReason: `workspace-unavailable: ${error.message}` })
    throw error
  }
}

/** The refusal assertLaunchable would raise, as a value. */
function tryAssert (result) {
  try {
    assertLaunchable(result)
    return new Error('refusing to launch: preflight did not pass')
  } catch (error) {
    return error
  }
}

/** Reopen an existing run — the restart path. */
export async function resumeRun ({ issuePath, runId, harnesses, stepStore, clock = systemClock, hooks = {}, emit = null, deliveryProvider = null, configRoot = undefined, workspaceProvider = gitWorktreeProvider, projectPath = null, projectAlias = projectPath, takeLock = true, availability = null }) {
  const engine = new Engine({ issuePath, runId, harnesses, steps: stepStore, clock, hooks, emit, deliveryProvider, configRoot, availability })
  await engine.load()

  // The ORIGINAL baseline, or the run's notion of "changed" silently shifts.
  const stored = await store.readBaseline(issuePath, runId)
  if (stored) {
    engine.baseline = stored
  } else {
    engine.baseline = new Map()
    engine.baselineMissing = true
  }

  engine.workspaceProvider = engine.run.workspace?.isolation === 'in-place' ? inPlaceProvider : engine.run.workspace?.base?.policy === 'staged-release' ? directoryProvider : workspaceProvider
  const originalProjectPath = projectPath ?? engine.run.issue?.projectPath ?? null
  engine.projectPath = originalProjectPath ? await fs.realpath(originalProjectPath) : null
  engine.projectAlias = projectAlias ?? originalProjectPath
  if (takeLock) {
    engine.runLock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'run', runId, clock })
  }
  try { await requireUnarchived(issuePath) } catch (error) {
    await engine.runLock?.release()
    throw error
  }
  return engine
}

/*
 * Releasing the issue and destroying the candidate are different acts.
 *
 * The git provider's release() is `worktree remove --force`, which deletes
 * uncommitted work. A run that stopped without delivering still holds the only
 * copy of what was written, so the two must be callable apart: ownership always
 * goes back, the candidate goes only when it is genuinely redundant.
 */

/**
 * Is this workspace provably identical to the baseline it started from?
 *
 * The question matters because the alternative test — "did the run record a
 * revision" — answers a different one. A revision is fingerprinted from a
 * response, so an author that edited files and was then cancelled, killed or
 * failed before it ever answered has produced no revision and plenty of work.
 *
 * Three outcomes, and only the first permits deleting anything:
 *   proven-unchanged  the content hashes match the persisted baseline exactly
 *   changed           they do not
 *   unprovable        the baseline or the workspace could not be read
 *
 * Unprovable is treated as changed. Being wrong in that direction wastes disk;
 * being wrong in the other direction destroys work nobody kept a copy of.
 */
export async function workspaceUnchanged (engine) {
  const dir = engine.run.workspace?.path
  if (!dir) return { unchanged: true, proven: true, reason: 'there is no workspace' }

  try {
    await fs.access(dir)
  } catch {
    return { unchanged: true, proven: true, reason: 'the workspace is not on disk' }
  }

  const baseline = engine.baseline?.size ? engine.baseline : await store.readBaseline(engine.issuePath, engine.runId)
  if (!baseline) {
    return { unchanged: false, proven: false, reason: 'no baseline was recorded, so nothing can be compared' }
  }
  if (baseline.modesError) {
    return { unchanged: false, proven: false, reason: `the recorded modes could not be read, so a mode change cannot be ruled out — ${baseline.modesError}` }
  }

  let current
  try {
    current = await baselineOf(dir)
  } catch (error) {
    return { unchanged: false, proven: false, reason: `the workspace could not be read: ${error.message}` }
  }

  if (current.size !== baseline.size) {
    return { unchanged: false, proven: true, reason: 'the workspace has files the baseline does not, or is missing some' }
  }
  for (const [rel, hash] of current) {
    if (baseline.get(rel) !== hash) {
      return { unchanged: false, proven: true, reason: `${rel} differs from the baseline` }
    }
    const mode = baseline.modes?.get(rel)
    if (mode !== undefined && current.modes?.get(rel) !== mode) {
      return { unchanged: false, proven: true, reason: `${rel} changed mode since the baseline` }
    }
  }
  return { unchanged: true, proven: true, reason: 'every file matches the baseline' }
}

/** Hand the issue back. The workspace, if any, stays exactly where it is. */
export async function releaseOwnership (engine, { reason = null } = {}) {
  if (engine.run.workspace?.path && engine.run.workspace.state === 'active') {
    engine.run.workspace.state = 'retained'
    engine.run.workspace.retainedReason = reason
    await store.writeRun(engine.issuePath, engine.runId, engine.run)
  }
  await engine.runLock?.release()
}

/** Destroy the candidate. Irreversible: only for work that is captured or absent. */
export async function discardWorkspace (engine) {
  if (!engine.run.workspace?.path || engine.run.workspace.state === 'removed') return
  if (engine.run.workspace.isolation === 'in-place') {
    // The workspace IS the project. Nothing here may delete it.
    engine.run.workspace.state = 'retained'
    engine.run.workspace.retainedReason = 'in-place: the project checkout is never removed'
    await store.writeRun(engine.issuePath, engine.runId, engine.run)
    return
  }
  await engine.workspaceProvider?.release({ projectPath: engine.projectPath, path: engine.run.workspace.path, repository: engine.run.workspace.repository ?? null })
  if (engine.run.workspace.retention && engine.run.workspace.scratchPath) await fs.rm(engine.run.workspace.scratchPath,{recursive:true,force:true})
  // Related-project snapshots are copies of other projects: they go with the
  // worktree, and never into an archive bundle.
  for (const r of engine.run.workspace.related ?? []) if (r.snapshot) await fs.rm(r.snapshot, { recursive: true, force: true }).catch(() => {})
  engine.run.workspace.state = 'removed'
  engine.run.workspace.retainedReason = null
  engine.workspaceReleasedAt = engine.clock.now()
  await store.writeRun(engine.issuePath, engine.runId, engine.run)
}

/**
 * Remove a settled run's workspace without loading its engine (run deletion,
 * supervisor.deleteRun). The provider is chosen as resumeRun chooses it; an
 * in-place workspace is the project checkout and is never touched.
 */
export async function removeRunWorkspace (run, projectPath) {
  const ws = run.workspace
  if (!ws?.path || ws.state === 'removed' || ws.isolation === 'in-place') return
  const provider = ws.base?.policy === 'staged-release' || ws.isolation === 'none' ? directoryProvider : gitWorktreeProvider
  await provider.release({ projectPath, path: ws.path, repository: ws.repository ?? null })
  if (ws.scratchPath) await fs.rm(ws.scratchPath, { recursive: true, force: true })
  for (const r of ws.related ?? []) if (r.snapshot) await fs.rm(r.snapshot, { recursive: true, force: true }).catch(() => {})
}

/** Discard the candidate and hand the issue back. The teardown path. */
export async function releaseWorkspace (engine) {
  await discardWorkspace(engine)
  await engine.runLock?.release()
}

/**
 * No isolation at all: the run works directly in the project checkout. Chosen
 * per run (runOptions.isolation = 'in-place') when the operator wants edits to
 * land live rather than arrive as a patch. There is no base commit and nothing
 * to hand off; the fingerprint, the reviews and integrity quarantine still
 * apply to the directory exactly as they would to a worktree. The checkout is
 * never removed, whatever the retention policy says.
 */
export const inPlaceProvider = {
  isolation: 'in-place',
  async create ({ projectPath, policy = {} }) {
    const git = (args) => run('git', ['-C', projectPath, ...args], BIG)
    // The project's snapshot excludes are what fingerprints of the live checkout
    // skip (see workspaceProjection): runtime state and sockets are not source.
    const excludes = policy.excludes ?? []
    let headCommit = null, dirtyPaths = null, untrackedPaths = null
    try {
      headCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
      const status = (await git(['status', '--porcelain', '--untracked-files=all'])).stdout.split(String.fromCharCode(10)).filter(Boolean)
      dirtyPaths = status.filter((l) => !l.startsWith('??')).length
      untrackedPaths = status.length - dirtyPaths
    } catch { /* not a git repository: still workable in place */ }
    const escaping = await escapingLinks(projectPath)
    return {
      path: projectPath,
      baseCommit: null,
      isolation: 'in-place',
      base: { policy: 'in-place', ref: null, headCommit, snapshotRef: null, dirtyPaths, untrackedPaths, excludes },
      symlinks: { policy: 'allow', escaping: escaping.map((l) => ({ path: l.path, target: l.target })), materialized: [] }
    }
  },
  async release () { /* the live checkout is never removed */ }
}

/** A plain directory workspace, for projects that are not git repositories. */
export const directoryProvider = {
  isolation: 'none',
  async create ({ projectPath, runId, root }) {
    const dir = path.join(root, `workspace-${runId}`)
    await fs.cp(projectPath, dir, { recursive: true })
    return { path: dir, baseCommit: null, isolation: 'none' }
  },
  async release ({ path: dir }) { await fs.rm(dir, { recursive: true, force: true }) }
}
