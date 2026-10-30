import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { projectConfig } from '../config/load.mjs'
import * as store from './store.mjs'
import { fetchFromStore, isStoreOf } from './git-store.mjs'

/*
 * Integration: an operator's approval, bound to a revision and a target,
 * turned into a merge.
 *
 * A committed candidate lives on a devpanel/ branch in the repository that
 * owns its worktree. Integrating it is a separate act, because it changes a
 * branch people work on:
 *
 *  - the approval names the revision the operator reviewed; a run whose
 *    delivery names another is refused;
 *  - the target is the project's declared integration branch (or the one
 *    given); its head at approval is recorded;
 *  - the candidate's repository must BE the project's declared source
 *    repository. Where they differ — an application repository holding a
 *    flattened image of modules whose source lives elsewhere — committing to
 *    the wrong one is not delivery, and the mapping between them is a project
 *    decision this code refuses to guess;
 *  - if the target branch is checked out in the source repository, the merge
 *    runs in that checkout only when it is clean, so its working tree follows
 *    the branch; a dirty checkout is refused rather than left inconsistent.
 *    A branch that is not checked out is merged in a temporary worktree.
 *
 * A conflict aborts the merge and is recorded as the refusal; nothing is left
 * half-merged.
 */

const run = promisify(execFile)
const NL = String.fromCharCode(10)

const refuse = (message, status = 409) => Object.assign(new Error(message), { status })

/** Every registered worktree of `source` that currently has `branch` checked out. */
async function worktreesOn (source, branch) {
  const { stdout } = await run('git', ['-C', source, 'worktree', 'list', '--porcelain'])
  const out = []
  let current = null
  for (const line of stdout.split(NL)) {
    if (line.startsWith('worktree ')) current = line.slice(9)
    else if (line === `branch refs/heads/${branch}` && current) out.push(current)
  }
  return out
}

/** What an approval must name: read this first, then approve exactly it. */
export async function integrationTarget ({ project, projectPath, configRoot, runId = null, issuePath = null }) {
  const cfg = await projectConfig(project, { root: configRoot, projectPath })
  const source = cfg.sourceRepository
  const branch = cfg.integrationBranch || (await run('git', ['-C', source, 'branch', '--show-current']).then((r) => r.stdout.trim()).catch(() => null))
  const head = branch ? await run('git', ['-C', source, 'rev-parse', '--verify', `refs/heads/${branch}`]).then((r) => r.stdout.trim()).catch(() => null) : null
  const repository = await run('git', ['-C', source, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then((r) => fs.realpath(r.stdout.trim())).catch(() => null)
  let candidateRepository = null
  if (runId && issuePath) {
    const r = await store.readRun(issuePath, runId).catch(() => null)
    candidateRepository = r?.delivery?.repository ? await fs.realpath(r.delivery.repository).catch(() => r.delivery.repository) : null
  }
  return { declared: cfg.declared, file: cfg.file, sourceRepository: source, repository, branch, head, candidateRepository, sameRepository: repository && candidateRepository ? repository === candidateRepository || await isStoreOf(candidateRepository, repository) : null }
}

/** One integration at a time per repository, in this process. */
const chains = new Map()
function serialised (key, fn) {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(key, next.catch(() => {}))
  return next
}

export async function integrateRun (options) {
  const key = await fs.realpath(options.projectPath).catch(() => options.projectPath)
  return serialised(key, () => integrateRunUnserialised(options))
}

async function integrateRunUnserialised ({ issuePath, runId, project, projectPath, configRoot, expectedRevision, targetBranch = null, expectedTargetHead = null, approvedBy = 'operator', clock = { iso: () => new Date().toISOString() }, hooks = {} }) {
  await store.requireCompleteEvents(issuePath, runId)
  const runRecord = await store.readRun(issuePath, runId).catch(() => null)
  if (!runRecord) throw refuse('no such run', 404)
  if (['quarantined', 'abandoned'].includes(runRecord.integrity?.status) || runRecord.recovery?.required) throw refuse('source integrity requires an explicit recovery disposition before integration')
  const delivery = runRecord.delivery
  if (['publishing', 'published'].includes(runRecord.integration?.phase)) throw refuse('a previous publication is unfinished; it is reconciled at startup, or reconcile it explicitly before approving again')
  if (runRecord.integration?.mergeCommit) throw refuse(`already integrated as ${runRecord.integration.mergeCommit.slice(0, 12)} into ${runRecord.integration.targetBranch}`)
  if (!delivery?.completedAt || delivery.action !== 'commit' || !delivery.commit) throw refuse('this run has no committed, verified candidate to integrate')
  if (delivery.reconstruction?.verified !== true) throw refuse('the delivered commit was not verified against the revision')
  if (expectedRevision !== delivery.revision) throw refuse(`approval names revision ${String(expectedRevision).slice(0, 23)}…, but the delivered revision is ${delivery.revision.slice(0, 23)}…; review the run again before approving`)

  const cfg = await projectConfig(project, { root: configRoot, projectPath })
  // Integration goes where the project SAYS its source is. Without a
  // declaration there is only a guess (the application checkout), and a
  // guess is how a fix lands in the wrong repository.
  if (!cfg.declared) throw refuse(`project "${project}" has no complete declaration of its source repository and integration branch; ${cfg.errors?.length ? `projects/${project}.yaml is invalid: ${cfg.errors.join('; ')}` : `add projects/${project}.yaml naming both`} before approving integration`)
  if (!targetBranch) throw refuse('approval must name the target branch')
  if (!expectedTargetHead) throw refuse('approval must name the target branch head it was given (expectedTargetHead); read the integration target first')
  const source = cfg.sourceRepository
  const candidateRepo = await fs.realpath(delivery.repository).catch(() => delivery.repository)
  const sourceCommon = await run('git', ['-C', source, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then((r) => fs.realpath(r.stdout.trim())).catch(() => null)
  if (!sourceCommon) throw refuse(`the project's source repository ${source} is not a git repository`)
  // A candidate in the panel's Git store (git-store.mjs) is the project's own:
  // the store reads exactly this repository's objects. Its commit is brought
  // over, objects only, so the merge below builds on it as on any other.
  const fromStore = sourceCommon !== candidateRepo && await isStoreOf(candidateRepo, sourceCommon)
  if (sourceCommon !== candidateRepo && !fromStore) {
    throw refuse(`the candidate is committed in ${candidateRepo}, but the project's declared source repository is ${sourceCommon}. Integrating would put the change in the wrong place; the mapping between the two is a project decision${cfg.file ? ` (see ${cfg.file})` : ' (declare it in projects/<project>.yaml)'}`)
  }

  const branch = targetBranch
  if (cfg.integrationBranch && branch !== cfg.integrationBranch) throw refuse(`the project's integration branch is ${cfg.integrationBranch}, not ${branch}`)
  const targetHeadBefore = (await run('git', ['-C', source, 'rev-parse', '--verify', `refs/heads/${branch}`]).then((r) => r.stdout.trim()).catch(() => null))
  if (!targetHeadBefore) throw refuse(`branch ${branch} does not exist in ${source}`)
  // Drift: the branch moved since the operator looked. Approval was for a
  // merge onto what they saw, not onto whatever is there now.
  if (targetHeadBefore !== expectedTargetHead) throw refuse(`${branch} is at ${targetHeadBefore.slice(0, 12)}, not ${String(expectedTargetHead).slice(0, 12)} as approved; it moved since the approval was given. Read the target again and re-approve`)

  if (fromStore) {
    try { await fetchFromStore({ source, store: candidateRepo, branch: delivery.branch, commit: delivery.commit }) } catch (error) { throw refuse(`the candidate could not be brought from the panel's Git store ${candidateRepo}: ${error.message}`) }
  }

  const record = { approvedBy, revision: delivery.revision, repository: sourceCommon, ...(fromStore ? { store: candidateRepo } : {}), targetBranch: branch, targetHeadBefore, mergeCommit: null, method: null, at: clock.iso(), error: null }
  const env = { ...process.env, GIT_AUTHOR_NAME: 'devpanel', GIT_AUTHOR_EMAIL: 'devpanel@localhost', GIT_COMMITTER_NAME: 'devpanel', GIT_COMMITTER_EMAIL: 'devpanel@localhost' }
  const message = `Integrate ${delivery.branch} (${delivery.revision.slice(0, 23)}) approved by ${approvedBy}`

  // The merge is BUILT against the approved head, detached, in a temporary
  // worktree — so its first parent is what was approved whatever the branch
  // does meanwhile — and then PUBLISHED with a compare-and-swap on the NAMED
  // branch ref, never through whatever HEAD happens to point at. Every
  // registered worktree that has the branch checked out is inspected first
  // (a dirty one refuses the whole operation) and brought up to the merge
  // afterwards, so no checkout is left with a HEAD its files do not match.
  const occupants = (await worktreesOn(source, branch))
  let temporary = null
  try {
    for (const wt of occupants) {
      const dirty = (await run('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=no'])).stdout.split(NL).filter(Boolean).length
      if (dirty > 0) throw refuse(`${branch} is checked out in ${wt} with ${dirty} modified tracked path(s); publishing would leave that working tree inconsistent. Commit or stash them first`)
    }
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-integrate-'))
    await run('git', ['-C', source, 'worktree', 'add', '--detach', '--quiet', temporary, expectedTargetHead])
    try {
      await run('git', ['-C', temporary, 'merge', '--no-ff', '--no-edit', '-m', message, delivery.commit], { env })
    } catch (error) {
      await run('git', ['-C', temporary, 'merge', '--abort']).catch(() => {})
      throw refuse(`merge of ${delivery.branch} into ${branch} failed and was aborted: ${(error.stderr || error.message).toString().trim().slice(0, 300)}`)
    }
    const mergeCommit = (await run('git', ['-C', temporary, 'rev-parse', 'HEAD'])).stdout.trim()
    const firstParent = (await run('git', ['-C', temporary, 'rev-parse', 'HEAD^1'])).stdout.trim()
    if (firstParent !== expectedTargetHead) throw refuse('internal: the merge was not built on the approved head')
    // A translated candidate (0d): what the merge brings onto the approved
    // head must be exactly the reviewed change — the paths of source base ..
    // integration commit — so independent target changes are never
    // attributed to it and nothing excluded or materialized rides along.
    if (delivery.sourceBase) {
      const names = async (a, b) => new Set((await run('git', ['-C', source, 'diff', '--name-only', '-z', '--no-renames', a, b], { maxBuffer: 256 * 1024 * 1024 })).stdout.split(String.fromCharCode(0)).filter(Boolean))
      const brought = await names(expectedTargetHead, mergeCommit)
      const reviewed = await names(delivery.sourceBase, delivery.commit)
      const extra = [...brought].filter((p) => !reviewed.has(p))
      const missing = [...reviewed].filter((p) => !brought.has(p))
      if (extra.length || missing.length) throw refuse(`the merge would change ${extra.length ? `paths the reviewed change does not (${extra.slice(0, 3).join(', ')})` : ''}${extra.length && missing.length ? ' and ' : ''}${missing.length ? `not change reviewed paths (${missing.slice(0, 3).join(', ')})` : ''}; nothing was published`)
    }

    // Test seam: something moves the branch between building and publishing.
    if (hooks.beforePublish) await hooks.beforePublish()

    // The intent is persisted BEFORE the ref moves: what will be published,
    // where, from which head, and which checkouts must follow. A crash after
    // this point is reconcilable from the record alone.
    record.mergeCommit = mergeCommit
    record.method = 'built-on-approved-head, published-by-compare-and-swap'
    record.phase = 'publishing'
    record.worktrees = { pending: occupants, updated: [], stale: [] }
    runRecord.integration = record
    await store.writeRun(issuePath, runId, runRecord)

    // Publish: compare-and-swap on the named ref. This is the only write to
    // the branch, and it is bound to the branch by name and to the approved
    // head by value.
    try {
      await run('git', ['-C', source, 'update-ref', '-m', message, `refs/heads/${branch}`, mergeCommit, expectedTargetHead])
    } catch (error) {
      record.phase = 'aborted'
      record.mergeCommit = null
      throw refuse(`${branch} moved before the merge could be published (compare-and-swap on ${expectedTargetHead.slice(0, 12)} failed); nothing was published. Read the target again and re-approve`)
    }
    record.phase = 'published'
    runRecord.integration = record
    await store.writeRun(issuePath, runId, runRecord)

    // Test seam: the process dies right after the swap.
    if (hooks.afterPublish) await hooks.afterPublish()

    await followCheckouts(record, source)
  } catch (error) {
    if (error.simulatedCrash) throw error   // a test's process death: persist nothing further
    record.error = error.message
    if (!record.phase || record.phase === 'publishing') record.phase = 'aborted'
    runRecord.integration = record
    await store.writeRun(issuePath, runId, runRecord)
    await store.appendEvent(issuePath, runId, { type: 'integration-refused', reason: error.message })
    return { runId, integration: record, error: error.message }
  } finally {
    if (temporary) {
      await run('git', ['-C', source, 'worktree', 'remove', '--force', temporary]).catch(() => {})
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }

  record.phase = 'complete'
  runRecord.integration = record
  await store.writeRun(issuePath, runId, runRecord)
  await store.appendEvent(issuePath, runId, { type: 'integrated', branch, mergeCommit: record.mergeCommit, method: record.method, stale: record.worktrees?.stale?.length ?? 0 })
  return { runId, integration: record, error: null }
}

/**
 * Every checkout of the branch follows the published ref. Its HEAD already
 * names the merge (HEAD is the branch), so the index and working tree are
 * moved explicitly from the approved head to the merge with a two-tree
 * read-tree, which refuses rather than discarding local changes that appeared
 * since the inspection; such a worktree is reported as stale, the
 * publication stands. Idempotent: a worktree already at the merge is done.
 */
async function followCheckouts (record, source) {
  const updated = new Set(record.worktrees?.updated ?? [])
  const stale = []
  for (const wt of await worktreesOn(source, record.targetBranch)) {
    if (updated.has(wt)) continue
    const indexTree = await run('git', ['-C', wt, 'write-tree']).then((r) => r.stdout.trim()).catch(() => null)
    const mergeTree = await run('git', ['-C', wt, 'rev-parse', `${record.mergeCommit}^{tree}`]).then((r) => r.stdout.trim()).catch(() => null)
    if (indexTree && indexTree === mergeTree) { updated.add(wt); continue }
    try {
      await run('git', ['-C', wt, 'read-tree', '-m', '-u', record.targetHeadBefore, record.mergeCommit])
      updated.add(wt)
    } catch (error) {
      stale.push({ worktree: wt, error: (error.stderr || error.message).toString().trim().slice(0, 200), remedy: `in that checkout, commit or stash the local changes, then run: git read-tree -m -u ${record.targetHeadBefore.slice(0, 12)} ${record.mergeCommit.slice(0, 12)}` })
    }
  }
  record.worktrees = { pending: [], updated: [...updated], stale }
  record.warning = stale.length
    ? `published to ${record.targetBranch}, but ${stale.length} checkout(s) still show the previous content and need attention: ${stale.map((x) => x.worktree).join(', ')}`
    : null
}

/**
 * Finish an integration that a crash interrupted. From the record alone:
 * a `publishing` phase is settled by looking at the branch (swapped, or not);
 * a `published` phase still owes the checkouts their update. Safe to call
 * repeatedly; a complete or aborted record is left alone.
 */
export async function reconcileIntegration ({ issuePath, runId, clock = { iso: () => new Date().toISOString() } }) {
  await store.requireCompleteEvents(issuePath, runId)
  const runRecord = await store.readRun(issuePath, runId).catch(() => null)
  const record = runRecord?.integration
  if (!record || !['publishing', 'published'].includes(record.phase)) return { reconciled: false, phase: record?.phase ?? null }
  const source = record.repository
  if (record.phase === 'publishing') {
    const refNow = await run('git', ['-C', source, 'rev-parse', '--verify', `refs/heads/${record.targetBranch}`]).then((r) => r.stdout.trim()).catch(() => null)
    if (refNow === record.mergeCommit) record.phase = 'published'
    else if (refNow === record.targetHeadBefore) {
      record.phase = 'aborted'
      record.error = 'publication was interrupted before the branch moved; nothing was published. Approve again'
      record.mergeCommit = null
    } else {
      record.phase = 'aborted'
      record.error = `publication was interrupted and ${record.targetBranch} is now at ${String(refNow).slice(0, 12)}, neither the approved head nor the built merge; inspect the repository`
      record.mergeCommit = null
    }
  }
  if (record.phase === 'published') {
    await followCheckouts(record, source)
    record.phase = 'complete'
  }
  record.reconciledAt = clock.iso()
  runRecord.integration = record
  await store.writeRun(issuePath, runId, runRecord)
  await store.appendEvent(issuePath, runId, { type: 'integration-reconciled', phase: record.phase, error: record.error ?? null })
  return { reconciled: true, phase: record.phase, integration: record }
}
