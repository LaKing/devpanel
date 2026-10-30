import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fingerprint } from './fingerprint.mjs'
import { acquire } from './lock.mjs'
import { writeJson } from './persistence.mjs'

const exec = promisify(execFile)
const git = async (cwd, args, options = {}) => (await exec('git', ['-C', cwd, ...args], { maxBuffer: 256 * 1024 * 1024, ...options })).stdout
const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const safe = rel => typeof rel === 'string' && rel.length && !path.isAbsolute(rel) && rel.split('/').every(p => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git')
const reconstructionRepository = (workspace) => workspace.repository?.kind === 'private' && workspace.gitDir ? ['--git-dir', workspace.gitDir] : ['-C', workspace.source.path]
const same = (a, b) => (a?.contentHash ?? null) === (b?.contentHash ?? null) && (a?.mode ?? null) === (b?.mode ?? null)

export async function bindSourceOwners (projectPath, symlinks, sourceTarget) {
  const owners = []
  for (const root of symlinks.materialized ?? []) {
    const link = symlinks.escaping.find(l => l.path === root)
    try {
      if (!safe(root) || !link || await fs.readlink(path.join(projectPath, root)) !== link.target) throw Error('The source link differs from the captured link')
      const resolved = await fs.realpath(path.join(projectPath, root))
      const stat = await fs.stat(resolved)
      const directory = stat.isDirectory()
      if (!directory && !stat.isFile()) throw Error('The target is not a regular file or directory')
      const ownerPath = await fs.realpath((await git(directory ? resolved : path.dirname(resolved), ['rev-parse', '--show-toplevel'])).trim())
      if (!inside(ownerPath, resolved)) throw Error('Target is outside its owning checkout')
      owners.push({ path: root, target: link.target, resolved, directory, owner: await sourceTarget(ownerPath) })
    } catch (error) { owners.push({ path: root, target: link?.target, owner: null, error: error.message }) }
  }
  return owners
}

async function applyPatch (cwd, patch, check = false) {
  const child = execFile('git', ['-C', cwd, 'apply', '--binary', '--whitespace=nowarn', ...(check ? ['--check'] : []), '-'], { maxBuffer: 16 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(Error(stderr.trim() || `git apply exited ${code}`)))
    child.stdin.on('error', e => { if (e.code !== 'EPIPE') reject(e) })
    child.stdin.end(patch)
  })
}

// Never follow an unrecorded link inside an owner. Git apply is also used without
// --unsafe-paths; both layers must agree that every write stays in this checkout.
async function checkParents (root, rel) {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i++) {
    const full = path.join(root, ...parts.slice(0, i))
    const stat = await fs.lstat(full).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (stat && !stat.isDirectory()) throw Error(`Destination parent is not a directory: ${full}`)
    if (stat && await fs.lstat(path.join(full, '.git')).then(() => true, () => false)) throw Error(`Nested repository requires a separate owner binding: ${full}`)
  }
}
async function put (root, rel, bytes, mode) {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  if (mode === 'link') await fs.symlink(bytes.toString(), full)
  else { await fs.writeFile(full, bytes); await fs.chmod(full, mode === '000755' ? 0o755 : 0o644) }
}

/** Dispatch a reconstructed, approved composition to its bound source owners. */
export async function applyToOwners ({ workspace, baseline, revision, candidate, receipt, runDir, clock, hooks, sourceTarget, readDestination }) {
  let application = { path: workspace.source.path, revision, verified: false, fingerprint: null, state: 'not-applied', error: null, owners: [] }
  const finish = () => ({ ...receipt, application })
  const refuse = (state, message) => { application = { ...application, state, error: message }; return finish() }
  const locks = []
  let temporary, rebuilt
  const journal = path.join(runDir, 'source-application.json')
  try {
    const changed = candidate.entries.filter(e => e.status !== 'unchanged')
    const source = await sourceTarget(workspace.source.path)
    if (source.path !== workspace.source.path || source.repository !== workspace.source.repository) return refuse('source-drift', 'The application repository changed.')
    const bindingsFile = path.join(runDir, 'source-owners.json')
    const persisted = await fs.readFile(bindingsFile, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    const owners = workspace.symlinks.owners ?? persisted ?? await bindSourceOwners(source.path, workspace.symlinks, sourceTarget)
    const routes = new Map(), destinations = new Set()
    for (const entry of changed) {
      if (!safe(entry.path)) return refuse('unsupported-path', `Invalid candidate path: ${entry.path}`)
      const root = workspace.symlinks.materialized.find(p => entry.path === p || entry.path.startsWith(p + '/'))
      if (workspace.symlinks.materialized.some(p => p.startsWith(entry.path + '/'))) return refuse('unsupported-path', `Cannot replace a parent of a materialized link: ${entry.path}`)
      const binding = root ? owners.find(o => o.path === root) : null
      if (root && !binding?.owner) return refuse('unsupported-path', `Cannot determine the Git owner of ${entry.path}: ${binding?.error ?? 'missing binding'}`)
      if (binding?.directory && entry.path === root) return refuse('unsupported-path', `Cannot replace the materialized directory link ${root}`)
      if (binding && !binding.directory && entry.status === 'deleted') return refuse('unsupported-path', `Cannot delete the target of file link ${root}; that would leave a dangling source link`)
      const owner = binding?.owner ?? source
      const destination = binding ? path.join(binding.resolved, ...(binding.directory ? [entry.path.slice(root.length + 1)] : [])) : path.join(source.path, entry.path)
      const rel = path.relative(owner.path, destination).split(path.sep).join('/')
      if (!safe(rel) || !inside(owner.path, destination)) return refuse('unsupported-path', `Invalid owner destination for ${entry.path}`)
      if (destinations.has(destination)) return refuse('unsupported-path', `Multiple candidate paths map to ${destination}; reconcile the aliases before delivery`)
      if (owners.some(other => other !== binding && other.resolved && (other.directory ? inside(other.resolved, destination) : other.resolved === destination))) return refuse('unsupported-path', `Multiple source links expose ${destination}; reconcile the aliases before delivery`)
      destinations.add(destination)
      const route = routes.get(owner.path) ?? { path: owner.path, repository: owner.repository, entries: [] }
      route.entries.push({ ...entry, destination: rel, binding })
      routes.set(owner.path, route)
    }
    const routeList = [...routes.values()].sort((a, b) => a.path.localeCompare(b.path))
    const repositories = [...new Set([source.repository, ...routeList.map(r => r.repository)])].sort()
    for (const repository of repositories) locks.push(await acquire(path.join(repository, 'devpanel-source-delivery.lock'), { purpose: 'source-delivery', runId: path.basename(runDir), clock }))
    const snapshots = new Map()
    for (const route of [{ path: source.path, repository: source.repository }, ...routeList]) {
      const current = await sourceTarget(route.path)
      if (current.path !== route.path || current.repository !== route.repository) return refuse('source-drift', `Repository identity changed: ${route.path}`)
      snapshots.set(route.path, current)
    }
    const checkBindings = async () => {
      for (const root of workspace.symlinks.materialized) {
        const link = workspace.symlinks.escaping.find(l => l.path === root)
        if (!link || await fs.readlink(path.join(source.path, root)) !== link.target) throw Error(`Source symlink changed: ${root}`)
        const bound = owners.find(o => o.path === root)
        if (bound?.resolved && await fs.realpath(path.join(source.path, root)) !== bound.resolved) throw Error(`Source symlink resolution changed: ${root}`)
      }
      for (const route of routeList) for (const entry of route.entries) await checkParents(route.path, entry.destination)
      for (const [dir, snapshot] of snapshots) if (JSON.stringify(await sourceTarget(dir)) !== JSON.stringify(snapshot)) throw Error(`Git state changed during delivery: ${dir}`)
    }
    await checkBindings()
    if (!workspace.symlinks.owners && !persisted) await writeJson(bindingsFile, owners)
    const prior = await fs.readFile(journal, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e })
    if (prior && (prior.path !== source.path || prior.revision !== revision)) return refuse('recovery-required', 'Earlier delivery names a different destination or revision.')
    let observed = await readDestination()
    if (observed.fingerprint === revision) {
      application = { ...application, fingerprint: revision, state: 'complete', verified: true, completedAt: clock.iso(), owners: prior?.owners ?? routeList.map(r => ({ path: r.path, repository: r.repository })) }
      await writeJson(journal, application); return finish()
    }
    const changedPaths = new Set(changed.map(e => e.path))
    // Drift outside the patch is applied beside, as in source-delivery.mjs: it
    // must stay exactly as found, and the application records it as `composed`.
    const drift = current => JSON.stringify(current.entries.filter(e => !changedPaths.has(e.path) && e.status !== 'unchanged'))
    const foreign = drift(observed)
    const composed = foreign === '[]' ? null : { paths: JSON.parse(foreign).map(e => e.path), entries: JSON.parse(foreign) }
    if (prior && foreign !== JSON.stringify(prior.composed?.entries ?? [])) return refuse('recovery-required', 'Source composition outside the approved patch changed since the earlier delivery attempt.')
    const states = current => routeList.map(route => {
      const got = new Map(current.entries.map(e => [e.path, e]))
      const baseMatches = route.entries.every(e => same(got.get(e.path), { contentHash: baseline.get(e.path), mode: baseline.modes?.get(e.path) }))
      const approvedMatches = route.entries.every(e => same(got.get(e.path), e))
      return approvedMatches ? 'complete' : baseMatches ? 'pending' : 'drift'
    })
    let progress = states(observed)
    if (composed && progress.every(p => p === 'complete') && prior?.composed) {
      // Re-verified now: the record states what was just observed, not what an
      // interrupted attempt had written before it finished.
      const owners = (prior.owners?.length ? prior.owners : routeList.map(r => ({ path: r.path, repository: r.repository }))).map(o => ({ ...o, state: 'complete' }))
      application = { ...application, ...prior, owners, error: null, fingerprint: observed.fingerprint, state: 'complete', verified: true, completedAt: clock.iso() }
      await writeJson(journal, application); return finish()
    }
    if (progress.includes('drift') || (!prior && progress.includes('complete'))) {
      // The paths are kept, as source-delivery.mjs keeps them: `reconcile-delivery` merges them.
      const got = new Map(observed.entries.map(e => [e.path, e]))
      const drifted = changed.filter(e => !same(got.get(e.path), { contentHash: baseline.get(e.path), mode: baseline.modes?.get(e.path) }) && !same(got.get(e.path), e)).map(e => e.path)
      if (!prior && drifted.length) application = { ...application, drifted }
      return refuse(prior ? 'recovery-required' : 'source-drift', `An owner matches neither the captured base nor a recorded delivery of the approved candidate.${drifted.length ? ` The approved patch's own paths changed: ${drifted.slice(0, 5).join(', ')}${drifted.length > 5 ? ', …' : ''}.` : ''}`)
    }
    const patch = await fs.readFile(path.join(runDir, receipt.artifactRef))
    if (hash(patch) !== receipt.patchHash) return refuse('unverifiable', 'The verified patch changed; no source was written.')
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-owner-delivery-'))
    rebuilt = path.join(temporary, 'candidate')
    // Cut from the run's own repository: a private run's base lives in its
    // engine directory (and in the panel's Git store, never in the source).
    await exec('git', [...reconstructionRepository(workspace), 'worktree', 'add', '--detach', '--quiet', rebuilt, workspace.baseCommit], { maxBuffer: 256 * 1024 * 1024 })
    await applyPatch(rebuilt, patch)
    if ((await fingerprint(rebuilt, { baseline, baseCommit: workspace.baseCommit, clock })).fingerprint !== revision) return refuse('unverifiable', 'The captured patch no longer reconstructs the approved candidate.')
    // Build one normal Git patch per OWNER, from immutable reconstructed bytes.
    // A private repository supplies path remapping without parsing diff headers.
    for (let i = 0; i < routeList.length; i++) {
      const route = routeList[i], staging = path.join(temporary, `owner-${i}`)
      await fs.mkdir(staging)
      await git(staging, ['init', '--quiet'])
      for (const entry of route.entries) if (baseline.has(entry.path)) {
        const bytes = await git(rebuilt, ['show', `${workspace.baseCommit}:${entry.path}`], { encoding: 'buffer' })
        await put(staging, entry.destination, bytes, baseline.modes?.get(entry.path) ?? '000644')
      }
      await git(staging, ['add', '--force', '--all'])
      const tree = (await git(staging, ['write-tree'])).trim()
      for (const entry of route.entries) {
        await fs.rm(path.join(staging, entry.destination), { force: true })
        if (entry.status !== 'deleted') {
          const full = path.join(rebuilt, entry.path)
          const bytes = entry.mode === 'link' ? Buffer.from(await fs.readlink(full)) : await fs.readFile(full)
          await put(staging, entry.destination, bytes, entry.mode)
        }
      }
      await git(staging, ['add', '--force', '--all'])
      route.patch = Buffer.from(await git(staging, ['diff', '--cached', '--binary', '--full-index', '--no-renames', tree]))
      const artifact = `artifacts/owners/${hash(route.path).slice(7, 23)}.patch`
      await fs.mkdir(path.join(runDir, 'artifacts/owners'), { recursive: true })
      await fs.writeFile(path.join(runDir, artifact), route.patch)
      route.record = { path: route.path, repository: route.repository, artifactRef: artifact, patchHash: hash(route.patch),
        paths: route.entries.map(e => ({ candidate: e.path, destination: e.destination })), state: progress[i] }
      if (progress[i] === 'pending') await applyPatch(route.path, route.patch, true)
    }
    if (hooks.beforeApply) await hooks.beforeApply()
    await checkBindings()
    observed = await readDestination()
    if (drift(observed) !== foreign || JSON.stringify(states(observed)) !== JSON.stringify(progress)) return refuse('source-drift', 'Source composition changed before owner delivery.')
    application = { ...application, state: 'applying', startedAt: clock.iso(), owners: routeList.map(r => r.record), ...(composed ? { composed } : {}) }
    await writeJson(journal, application)
    for (let i = 0; i < routeList.length; i++) {
      if (progress[i] === 'complete') continue
      await checkBindings()
      const beforeOwner = await readDestination()
      if (drift(beforeOwner) !== foreign || JSON.stringify(states(beforeOwner)) !== JSON.stringify(progress)) throw Error('Source changed between owner applications; inspect delivery progress before retrying')
      await applyPatch(routeList[i].path, routeList[i].patch)
      if (hooks.afterOwnerApply) await hooks.afterOwnerApply(routeList[i].record)
      progress[i] = 'complete'
      routeList[i].record.state = 'complete'
      await writeJson(journal, application)
    }
    if (hooks.afterApply) await hooks.afterApply()
    await checkBindings()
    observed = await readDestination()
    application.fingerprint = observed.fingerprint
    const exact = composed ? states(observed).every(p => p === 'complete') && drift(observed) === foreign : observed.fingerprint === revision
    if (!exact) throw Error('Delivered source composition does not match the approved revision')
    application = { ...application, state: 'complete', verified: true, completedAt: clock.iso() }
    await writeJson(journal, application)
    return finish()
  } catch (error) {
    if (error.simulatedCrash) throw error
    return refuse(application.state === 'applying' ? 'recovery-required' : 'failed', error.message)
  } finally {
    if (rebuilt) await exec('git', [...reconstructionRepository(workspace), 'worktree', 'remove', '--force', rebuilt]).catch(() => {})
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {})
    for (const lock of locks.reverse()) await lock.release()
  }
}
