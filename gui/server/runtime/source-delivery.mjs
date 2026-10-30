import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fingerprint } from './fingerprint.mjs'
import { acquire } from './lock.mjs'
import { writeJson } from './persistence.mjs'
import { systemClock } from './clock.mjs'
import { compositionPaths, nestedFiles } from './working-tree.mjs'
import { applyToOwners } from './owner-delivery.mjs'
import { selectionState } from './selection.mjs'
export { bindSourceOwners } from './owner-delivery.mjs'

const exec = promisify(execFile)
const git = async (dir, args, options = {}) => (await exec('git', ['-C', dir, ...args], {
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 256 * 1024 * 1024, ...options
})).stdout
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex')
const remedy = 'The verified patch remains available: apply manually or rerun against the current source.'

// Bind only an engine-supplied checkout. No model or delivery response chooses it.
export async function sourceTarget (projectPath) {
  const dir = await fs.realpath(projectPath)
  return {
    path: dir,
    repository: await fs.realpath((await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()),
    head: (await git(dir, ['rev-parse', 'HEAD'])).trim(),
    branch: (await git(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim(),
    index: digest(await git(dir, ['ls-files', '--stage', '-v', '-z']))
  }
}

export async function destinationFingerprint (workspace, baseline, clock = systemClock, candidatePaths = []) {
  const materialize = workspace.symlinks?.materialized ?? []
  const excludes = workspace.base?.excludes ?? []
  const baselinePaths = [...baseline.keys()]
  // Selection v1: the live checkout's materialized links are read through the
  // same owner selection launch copied, so an owner-ignored build file under a
  // link is neither source nor drift (R3-1). Newly added, selected owner files
  // still appear, and count as drift.
  const owned = await selectionState({ sourcePath: workspace.source.path, symlinks: workspace.symlinks })
  // Under selection v1 a path beneath a materialized link belongs to its OWNER's
  // selection alone: the consumer's index may still track files there from
  // before the path became a link (a lock file ignored by its owner, say), and counting them made an unchanged checkout read as
  // drift. The candidate's own paths and the baseline still count.
  const underLink = (rel) => materialize.some((root) => rel === root || rel.startsWith(root + '/'))
  const composition = (await compositionPaths({ projectPath: workspace.source.path,
    run: (args, options) => git(args[1], args.slice(2), options), tracked: true, excludes })).filter((rel) => !owned || !underLink(rel))
  // A nested repository the snapshot included (working-tree.mjs includeNested)
  // is a directory entry to the outer checkout: what it carries now is read
  // the way launch read it, so a file added there since is drift too.
  const nested = []
  for (const { path: root } of workspace.base?.nested ?? []) {
    nested.push(...(await nestedFiles({ projectPath: workspace.source.path, root, excludes, run: (args) => git(args[1], args.slice(2)) })).map((f) => f.rel))
  }
  const nestedRoots = new Set((workspace.base?.nested ?? []).map((n) => n.path))
  const selected = new Set([...composition.filter((rel) => !nestedRoots.has(rel.replace(/\/$/, ''))), ...nested, ...baselinePaths, ...candidatePaths, ...(owned?.paths ?? [])])
  const ancestors = new Set()
  for (const rel of selected) {
    for (let parent = path.posix.dirname(rel); parent !== '.'; parent = path.posix.dirname(parent)) ancestors.add(parent)
  }
  return fingerprint(workspace.source.path, {
    baseline, baseCommit: workspace.baseCommit, clock, strict: true,
    projection: {
      materialize,
      exclude: rel => {
        if (selected.has(rel) || ancestors.has(rel)) return false
        // Before v1, materialization force-added the whole external tree at
        // launch; under v1 only the owner selection (already in `selected`).
        if (materialize.some(root => rel.startsWith(root + '/'))) return owned ? true : excludes.some(pattern => path.matchesGlob(rel, pattern))
        return true
      }
    }
  })
}

/** Apply the verified patch; destination/base fingerprints are the recovery oracle. */
export async function applyToSource ({ workspace, baseline, revision, fingerprint: candidate, receipt, runDir, clock = systemClock, hooks = {} }) {
  let application = { path: workspace?.source?.path ?? null, revision, verified: false, fingerprint: null, state: 'not-applied', error: null }
  const result = () => ({ ...receipt, application })
  const refuse = (state, error) => { application = { ...application, state, error }; return result() }
  if (receipt?.reconstruction?.verified !== true || receipt.reconstruction.fingerprint !== revision) return refuse('unverifiable', 'The patch does not reproduce the approved candidate.')
  if (!workspace?.source) return refuse('unavailable', 'This run has no bound source destination; use its patch manually or rerun.')

  const changed = candidate.entries.filter(e => e.status !== 'unchanged').map(e => e.path)
  // The owner rules the snapshot was selected under must still hold; otherwise
  // the destination cannot be compared with what was reviewed (selection v1).
  const rules = await selectionState({ sourcePath: workspace.source.path, symlinks: workspace.symlinks }).catch(error => ({ error }))
  if (rules?.error) return refuse('selection-rules-changed', `The materialized source cannot be read as it was at launch: ${rules.error.message}. ${remedy}`)
  if (rules?.changed.length) return refuse('selection-rules-changed', `The owner ignore rules changed since the snapshot (${rules.changed.slice(0, 3).join('; ')}${rules.changed.length > 3 ? '; …' : ''}). Restore them and retry, or rerun. ${remedy}`)
  const readDestination = () => destinationFingerprint(workspace, baseline, clock, changed)
  const materialized = workspace.symlinks?.materialized ?? []
  const unsupported = changed.find(p => materialized.some(root => p === root || p.startsWith(root + '/') || root.startsWith(p + '/')))
  if (unsupported) return applyToOwners({ workspace, baseline, revision, candidate, receipt, runDir, clock, hooks, sourceTarget, readDestination })

  let lock
  const file = path.join(runDir, 'source-application.json')
  try {
    const target = await sourceTarget(workspace.source.path)
    if (target.path !== workspace.source.path || target.repository !== workspace.source.repository) return refuse('source-drift', `The destination repository changed. ${remedy}`)
    lock = await acquire(path.join(target.repository, 'devpanel-source-delivery.lock'), { purpose: 'source-delivery', runId: path.basename(runDir), clock })
    if (JSON.stringify(await sourceTarget(target.path)) !== JSON.stringify(target)) return refuse('source-drift', `The source changed while acquiring its lock. ${remedy}`)
    for (const link of workspace.symlinks?.escaping ?? []) {
      if (!materialized.includes(link.path)) continue
      if (await fs.readlink(path.join(target.path, link.path)).catch(() => null) !== link.target) return refuse('source-drift', `Materialized symlink ${link.path} changed target. ${remedy}`)
    }
    const prior = await fs.readFile(file, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (prior && (prior.revision !== revision || prior.path !== target.path)) return refuse('recovery-required', 'An earlier application names a different revision or destination; inspect the source before proceeding.')
    let observed = await readDestination()
    application.fingerprint = observed.fingerprint
    if (observed.fingerprint === revision) {
      application = { ...application, verified: true, state: 'complete', completedAt: clock.iso() }
      await writeJson(file, application)
      return result()
    }
    // Drift on paths the candidate does not touch is someone else's work in the
    // same checkout (a regenerated file, another delivery). The patch is applied
    // beside it: the reviewed paths get exactly the reviewed bytes and the
    // drifted paths are left as found. Refusing it threw away approved runs for
    // edits that never met the change. The combination itself was not tested,
    // so it is recorded as `composed`. Drift on a reviewed path still refuses.
    const wanted = new Map(changed.map(p => [p, candidate.entries.find(e => e.path === p)]))
    const drift = obs => obs.entries.filter(e => e.status !== 'unchanged' && !wanted.has(e.path))
    const delivered = obs => [...wanted].every(([p, want]) => {
      const got = obs.entries.find(e => e.path === p)
      return want.status === 'deleted' ? got?.status === 'deleted' : got?.contentHash === want.contentHash && got?.mode === want.mode
    })
    const foreign = drift(observed)
    if (prior?.composed && delivered(observed) && JSON.stringify(foreign) === JSON.stringify(prior.composed.entries)) {
      application = { ...application, composed: prior.composed, verified: true, state: 'complete', completedAt: clock.iso() }
      await writeJson(file, application)
      return result()
    }
    const overlap = observed.entries.filter(e => e.status !== 'unchanged' && wanted.has(e.path)).map(e => e.path)
    // An interrupted earlier application may resume only over the drift it recorded.
    const priorDrift = prior?.composed?.entries ?? []
    if (overlap.length || (prior && JSON.stringify(foreign) !== JSON.stringify(priorDrift))) {
      const where = overlap.length ? ` The approved patch's own paths changed: ${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? ', …' : ''}.` : ''
      // The paths are kept: they are what `reconcile-delivery` merges (source-reconcile.mjs).
      if (overlap.length && !prior) application = { ...application, drifted: overlap }
      return refuse(prior ? 'recovery-required' : 'source-drift', `The destination matches neither the base snapshot nor the approved revision.${where} ${remedy}`)
    }
    const composed = foreign.length ? { paths: foreign.map(e => e.path), entries: foreign } : null

    const patch = await fs.readFile(path.join(runDir, receipt.artifactRef))
    if (digest(patch) !== receipt.patchHash) return refuse('unverifiable', 'The patch changed after reconstruction verification; no source was written.')
    // Use the captured bytes on stdin for both commands: the artifact cannot be
    // swapped between --check and apply. No index, HEAD or commit is changed.
    const apply = async check => {
      const child = execFile('git', ['-C', target.path, 'apply', '--binary', '--whitespace=nowarn', ...(check ? ['--check'] : []), '-'], {
        maxBuffer: 16 * 1024 * 1024
      })
      await new Promise((resolve, reject) => {
        let stderr = ''
        child.stderr.on('data', data => { stderr += data })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `git apply exited ${code}`)))
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
        child.stdin.end(patch)
      })
    }
    if (patch.length) await apply(true)
    if (hooks.beforeApply) await hooks.beforeApply()
    observed = await readDestination()
    if (observed.entries.some(e => e.status !== 'unchanged' && wanted.has(e.path)) || JSON.stringify(drift(observed)) !== JSON.stringify(foreign) ||
      JSON.stringify(await sourceTarget(target.path)) !== JSON.stringify(target)) return refuse('source-drift', `The source changed before patch application. ${remedy}`)
    application = { ...application, state: 'applying', patchHash: digest(patch), startedAt: clock.iso(), ...(composed ? { composed } : {}) }
    await writeJson(file, application)
    if (patch.length) await apply(false)
    if (hooks.afterApply) await hooks.afterApply()
    observed = await readDestination()
    application.fingerprint = observed.fingerprint
    const exact = composed ? delivered(observed) && JSON.stringify(drift(observed)) === JSON.stringify(foreign) : observed.fingerprint === revision
    if (!exact || JSON.stringify(await sourceTarget(target.path)) !== JSON.stringify(target)) {
      application = { ...application, state: 'recovery-required', error: `Source verification failed after application. ${remedy}` }
    } else application = { ...application, state: 'complete', verified: true, completedAt: clock.iso() }
    await writeJson(file, application)
    return result()
  } catch (error) {
    if (error.simulatedCrash) throw error
    return refuse(application.state === 'applying' ? 'recovery-required' : 'failed', `${error.message}. ${remedy}`)
  } finally {
    await lock?.release()
  }
}
