import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { runProcess } from './process.mjs'
import { sshConnection, shellQuote } from './ssh.mjs'

/*
 * Check tiers and the baseline cache.
 *
 * A target that declares `tiers.smoke` is driven in two tiers: the smoke tier
 * (those commands only) on every recorded revision, the full tier (the whole
 * target) once on the approved revision. Each tier is a target of its own, so
 * its definition hash, its base drive and its comparison are its own.
 *
 * The base drive of a tier is reused across runs from
 * issues/<project>/.baselines/<key>/ when, and only when, every component of
 * the key is exactly equal: the base commit, the tier target's definition
 * hash, the content hash of each `baselineCache.files` path on the target and
 * the hash of the `baselineCache.environment` command's output there. A
 * component that cannot be computed means no lookup and no store. A hit is
 * copied into the run (checks/base-*), verified file by file against the
 * entry's manifest, so every reader of a run's checks — comparisons, logs,
 * the closure confirmation's read-only checks root, archives — reads it where
 * it always has, and pruning the cache never takes a run's evidence with it.
 */

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
/** A file's sha256, streamed; a directory or an unreadable file rejects. */
const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
})
const NL = String.fromCharCode(10)

/** The target one tier drives: the smoke commands only, or the whole target. */
export function tierTarget (target, tier) {
  if (!target?.tiers || !tier) return target
  const { tiers, ...rest } = target
  if (tier !== 'smoke') return { ...rest, tier: 'full' }
  const keep = (list) => (list ?? []).filter((c) => tiers.smoke.includes(c.id))
  return { ...rest, tier: 'smoke', commands: keep(rest.commands), ...(rest.finallyCommands ? { finallyCommands: keep(rest.finallyCommands) } : {}) }
}

/*
 * What a full drive does on its smoke drive's running instance: the target's
 * commands the smoke did not run, in declared order, then every finalizer. A
 * command declared before a smoke command runs out of position, and one declared
 * before a smoke service runs after that service started, so the service never
 * saw its effect: recorded and warned about, never refused (the limitation is in
 * docs/project-infrastructure.md "Tiers"; `tiers.continueSmoke: false` opts out).
 */
export function continuationPlan (target) {
  const smoke = target?.tiers?.smoke
  if (!smoke) return null
  const commands = target.commands ?? []
  const inSmoke = (c) => smoke.includes(c.id)
  const isService = (c) => c.kind === 'candidate' && c.service === true
  const outOfPosition = []
  const declaredBeforeServices = []
  commands.forEach((c, i) => {
    if (inSmoke(c)) return
    const after = commands.slice(i + 1).filter(inSmoke)
    if (!after.length) return
    outOfPosition.push({ id: c.id, declaredBefore: after.map((a) => a.id) })
    if (after.some(isService)) declaredBeforeServices.push(c.id)
  })
  const services = commands.filter((c) => inSmoke(c) && isService(c)).map((c) => c.id)
  const refusal = target.tiers.continueSmoke === false ? 'opted-out' : target.kind !== 'ssh' ? 'local-target' : !services.length ? 'no-service' : null
  return { smokeRun: commands.filter(inSmoke).map((c) => c.id), run: commands.filter((c) => !inSmoke(c)).map((c) => c.id), outOfPosition, declaredBeforeServices, services, refusal, keepSeconds: target.tiers.keepSeconds ?? 1800 }
}

/** issues/<project>/.baselines: beside the project's issues, never inside a run. */
export const baselinesDir = (issuePath) => path.join(path.dirname(issuePath), '.baselines')

/**
 * The exact key of a base drive, read now. `{ key, record }`, or `{ error }`
 * naming the component that could not be computed.
 */
export async function baselineIdentity ({ target, targetKey, baseCommit, signal = null }) {
  const cache = target?.baselineCache
  if (!cache?.environment) return { error: 'no baselineCache.environment is configured' }
  const files = cache.files ?? []
  const remote = target.kind === 'ssh'
  const connection = remote ? await sshConnection(target.ssh) : null
  const exec = (script) => remote
    ? runProcess({ command: connection.command, args: [...connection.args, `sh -c ${shellQuote(script)}`], signal })
    : runProcess({ command: '/bin/sh', args: ['-c', script], signal })
  const fileHashes = []
  if (files.length && !remote) {
    // Hashed here rather than by sha256sum, which macOS lacks: the same digest
    // of the same bytes, for the same path strings in the same order (relative
    // ones from this process's directory, where sh ran), so the key is unchanged.
    for (const file of files) {
      try {
        fileHashes.push([file, await sha256File(path.resolve(file))])
      } catch (error) {
        return { error: `local file ${file} could not be read (${error.code ?? error.message}); the baseline cache is not used`, code: 'BASELINE_FILE_UNREADABLE', file }
      }
    }
  } else if (files.length) {
    const out = await exec(`sha256sum -- ${files.map(shellQuote).join(' ')}`)
    if (out.code !== 0) return { error: `staging files could not be hashed: ${(out.stderr || out.stdout).trim().slice(0, 300)}` }
    const hashes = new Map(out.stdout.split(NL).filter(Boolean).map((l) => /^([0-9a-f]{64})\s+\*?(.+)$/.exec(l)).filter(Boolean).map((m) => [m[2], m[1]]))
    for (const file of files) {
      if (!hashes.has(file)) return { error: `staging file ${file} was not hashed` }
      fileHashes.push([file, hashes.get(file)])
    }
  }
  const environment = await exec(cache.environment)
  if (environment.code !== 0) return { error: `the environment command failed (exit ${environment.code}): ${environment.stderr.trim().slice(0, 300)}` }
  const record = {
    version: 1,
    baseCommit,
    targetHash: targetKey,
    files: fileHashes,
    environment: { host: remote ? { hostRef: target.ssh.hostRef, workdir: target.ssh.workdir } : 'local', sha256: sha256(environment.stdout) }
  }
  return { key: sha256(JSON.stringify(record)), record }
}

async function manifestOf (dir) {
  const manifest = {}
  for (const name of (await fs.readdir(dir)).sort()) {
    const stat = await fs.lstat(path.join(dir, name))
    if (stat.isFile()) manifest[name] = sha256(await fs.readFile(path.join(dir, name)))
  }
  return manifest
}

/**
 * The cached base drive for exactly this identity, copied into the run as
 * `checks/<dirName>`, or null. A partial or mismatching copy is a miss.
 */
export async function adoptBaseline ({ dir, identity, runDir, dirName }) {
  const entry = path.join(dir, identity.key)
  let stored
  try {
    if (await fs.readFile(path.join(entry, 'key.json'), 'utf8') !== JSON.stringify(identity.record)) return null
    stored = JSON.parse(await fs.readFile(path.join(entry, 'record.json'), 'utf8'))
  } catch { return null }
  const dest = path.join(runDir, 'checks', dirName)
  try {
    await fs.rm(dest, { recursive: true, force: true })
    await fs.cp(path.join(entry, 'files'), dest, { recursive: true })
    if (JSON.stringify(await manifestOf(dest)) !== JSON.stringify(stored.manifest)) throw new Error('copy differs from the entry')
  } catch {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => {})
    return null
  }
  return { ...stored.check, dir: path.relative(runDir, dest),
    reused: { key: identity.key, entry: path.join('.baselines', identity.key), fromRun: stored.fromRun, fromDir: stored.check.dir, capturedAt: stored.check.capturedAt ?? stored.check.at, storedAt: stored.storedAt } }
}

/** Keep a base drive for later runs; the first entry under a key wins. Then prune. */
export async function storeBaseline ({ dir, identity, base, runDir, runId, clock, maxEntries = 12, maxAgeDays = 14 }) {
  await fs.mkdir(dir, { recursive: true })
  const tmp = await fs.mkdtemp(path.join(dir, '.tmp-'))
  try {
    await fs.cp(path.join(runDir, base.dir), path.join(tmp, 'files'), { recursive: true })
    const manifest = await manifestOf(path.join(tmp, 'files'))
    await fs.writeFile(path.join(tmp, 'key.json'), JSON.stringify(identity.record))
    await fs.writeFile(path.join(tmp, 'record.json'), JSON.stringify({ check: base, manifest, fromRun: runId, storedAt: clock.iso(), storedAtMs: clock.now() }))
    await fs.rename(tmp, path.join(dir, identity.key))
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true })
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    return { stored: false, reason: 'an entry under this key exists' }
  }
  await pruneBaselines({ dir, clock, maxEntries, maxAgeDays })
  return { stored: true }
}

/** Entries older than maxAgeDays, then the oldest beyond maxEntries, are removed. */
export async function pruneBaselines ({ dir, clock, maxEntries = 12, maxAgeDays = 14 }) {
  const now = clock.now()
  const entries = []
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const at = await fs.readFile(path.join(dir, name, 'record.json'), 'utf8').then((t) => JSON.parse(t).storedAtMs, () => null)
    if (name.startsWith('.tmp-')) {
      // A store that died part-way; one still writing is minutes old.
      const { mtimeMs } = await fs.stat(path.join(dir, name)).catch(() => ({ mtimeMs: now }))
      if (now - mtimeMs > 86400000) await fs.rm(path.join(dir, name), { recursive: true, force: true })
      continue
    }
    entries.push({ name, at: Number.isFinite(at) ? at : 0 })
  }
  entries.sort((a, b) => b.at - a.at)
  const removed = entries.filter((e, i) => i >= maxEntries || now - e.at > maxAgeDays * 86400000)
  for (const e of removed) await fs.rm(path.join(dir, e.name), { recursive: true, force: true })
  return removed.map((e) => e.name)
}

/**
 * The cache as one check sees it: `identity()` (read once per check),
 * `lookup(dirName)` (the entry adopted as checks/<dirName>, or null) and `store(base)` (identity read again after the
 * drive; kept only when both reads agree). Every outcome is recorded on
 * `status` for the base record.
 */
export function baselineCacheFor ({ target, targetKey, baseCommit, issuePath, runDir, runId, clock, signal }) {
  if (!target?.baselineCache) return null
  const dir = baselinesDir(issuePath)
  const read = () => baselineIdentity({ target, targetKey, baseCommit, signal }).catch((error) => ({ error: error.message }))
  let before = null
  const cache = {
    status: null,
    // The key this check's base is known to stand for: set on a hit, or after a
    // drive whose identity read the same before and after. Null otherwise.
    verified: null,
    /** The identity as read for this check, once: `{ key, record }` or `{ error }`. */
    identity () {
      before ??= read()
      return before
    },
    async lookup (dirName) {
      const identity = await cache.identity()
      if (identity.error) { cache.status = { state: 'unavailable', reason: identity.error, ...(identity.code ? { code: identity.code } : {}) }; return null }
      const hit = await adoptBaseline({ dir, identity, runDir, dirName })
      cache.status = hit ? { state: 'hit', key: identity.key } : { state: 'miss', key: identity.key }
      if (hit) cache.verified = identity.key
      return hit
    },
    /**
     * Drop the entry this check hit, when it proved unusable (a base whose selftest run did not finish, stored
     * before such bases were refused). Left in place, every later run would hit it, drive again, and still
     * be unable to store the complete base under the same key. A reader copying it at that moment fails its
     * manifest check and misses: a lookup is never trusted without it.
     */
    async discard () {
      const key = cache.verified
      if (!key) return
      await fs.rm(path.join(dir, key), { recursive: true, force: true }).catch(() => {})
      cache.verified = null
      cache.status = { state: 'discarded', key, reason: 'the cached base did not finish its selftest run' }
    },
    async store (base) {
      const [first, after] = [await cache.identity(), await read()]
      if (first.error || after.error) { cache.status = { state: 'unavailable', reason: first.error ?? after.error }; return }
      if (first.key !== after.key) { cache.status = { state: 'unstable', reason: 'the identity changed while the base drive ran; not stored' }; return }
      cache.verified = first.key
      const { maxEntries, maxAgeDays } = target.baselineCache
      const outcome = await storeBaseline({ dir, identity: first, base, runDir, runId, clock, maxEntries, maxAgeDays }).catch((error) => ({ stored: false, reason: error.message }))
      cache.status = { state: outcome.stored ? 'stored' : 'not-stored', key: first.key, ...(outcome.reason ? { reason: outcome.reason } : {}) }
    }
  }
  return cache
}
