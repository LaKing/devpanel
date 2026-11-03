import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

import { adoptBaseline, baselineCacheFor, baselineIdentity, baselinesDir, pruneBaselines, storeBaseline, tierTarget } from '../server/runtime/baseline-cache.mjs'
import { compareFailures } from '../server/runtime/baseline-failures.mjs'
import { tierErrors, stagingTarget, infrastructureErrors } from '../server/infrastructure.mjs'

export const name = 'baseline cache — a base drive reused across runs only on an exact key; tiers'

const NL = String.fromCharCode(10)
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex')
const clockAt = (ms) => ({ now: () => ms, iso: () => new Date(ms).toISOString() })

/*
 * A base drive as the check runner leaves it (checks.mjs runOne): one failing
 * command with its log and stdout under runs/<id>/checks/<dir>/.
 */
async function baseDrive (runDir, dirName, baseCommit, output = 'FAIL inherited case') {
  const dir = path.join(runDir, 'checks', dirName)
  await fs.mkdir(dir, { recursive: true })
  const run = `echo '${output}'; exit 1`
  await fs.writeFile(path.join(dir, 'probe.log'), `$ ${run}${NL}${NL}${output}${NL}${NL}--- exit 1 in 5 ms ---${NL}`)
  await fs.writeFile(path.join(dir, 'probe.stdout'), `${output}${NL}`)
  return { revision: null, result: 'failed', target: 'local', at: '2026-10-07T10:00:00.000Z', durationMs: 5, baseCommit, sourceRevision: baseCommit, capturedAt: '2026-10-07T10:00:00.000Z',
    commands: [{ id: 'probe', run, required: true, exitCode: 1, signal: null, timedOut: false, passed: false, log: 'probe.log' }], dir: `checks/${dirName}`, failures: [] }
}

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  const env = await temp('devpanel-bc-env-')
  const scope = path.join(env, 'deployment-scope.json')
  const version = path.join(env, 'version')
  const environmentFile = path.join(env, 'node-versions')
  await fs.writeFile(scope, '{"applicationCollections":["APP-modules"]}\n')
  await fs.writeFile(version, '4.1.0\n')
  await fs.writeFile(environmentFile, 'v22.11.0\n')
  const target = { kind: 'local', commands: [{ id: 'probe', run: 'true' }], compareBaseline: true,
    baselineCache: { files: [scope, version], environment: `cat ${environmentFile}` } }
  const targetKey = sha(JSON.stringify(target))
  const commit = 'a'.repeat(40)
  const issues = await temp('devpanel-bc-issues-')
  const issuePath = path.join(issues, 'devpanel-project', '2026-10-07-issue')
  const dir = baselinesDir(issuePath)

  t.section('the cache is beside the project\'s issues, never inside a run')
  t.eq('issues/<project>/.baselines', dir, path.join(issues, 'devpanel-project', '.baselines'))

  t.section('a stored base drive is a hit for exactly the same key, copied into the run')
  const runA = path.join(issuePath, 'runs', 'run-a')
  const base = await baseDrive(runA, 'base-x', commit)
  const identity = await baselineIdentity({ target, targetKey, baseCommit: commit })
  t.ok('every component is computed', Boolean(identity.key) && !identity.error, identity.error)
  t.eq('the key names the base commit, target hash, both files and the environment', [identity.record.baseCommit, identity.record.targetHash, identity.record.files.map(([f]) => f), typeof identity.record.environment.sha256],
    [commit, targetKey, [scope, version], 'string'])
  const stored = await storeBaseline({ dir, identity, base, runDir: runA, runId: 'run-a', clock: clockAt(Date.now()) })
  t.eq('stored', stored.stored, true)
  const runB = path.join(issuePath, 'runs', 'run-b')
  const hit = await adoptBaseline({ dir, identity: await baselineIdentity({ target, targetKey, baseCommit: commit }), runDir: runB, dirName: 'base-x' })
  t.ok('a second run with the same key hits', Boolean(hit))
  t.eq('the run says so: reused names the entry and the run it came from', [hit?.reused?.key, hit?.reused?.fromRun, hit?.reused?.entry], [identity.key, 'run-a', path.join('.baselines', identity.key)])
  t.eq('the copy is the run\'s own checks directory', hit?.dir, 'checks/base-x')
  t.eq('the logs are there byte for byte', await fs.readFile(path.join(runB, 'checks', 'base-x', 'probe.log'), 'utf8'), await fs.readFile(path.join(runA, 'checks', 'base-x', 'probe.log'), 'utf8'))
  {
    // The comparison reads the copy where it reads any base: a failure the base has is inherited.
    const candDir = path.join(runB, 'checks', '001')
    await fs.mkdir(candDir, { recursive: true })
    await fs.copyFile(path.join(runB, 'checks', 'base-x', 'probe.log'), path.join(candDir, 'probe.log'))
    await fs.copyFile(path.join(runB, 'checks', 'base-x', 'probe.stdout'), path.join(candDir, 'probe.stdout'))
    const candidate = { ...base, revision: 'sha256:x', dir: 'checks/001' }
    const comparison = await compareFailures({ runDir: runB, target, base: hit, candidate, sourceRevision: commit })
    t.eq('compareFailures reads the reused base', comparison.verdict, 'baseline-known', comparison.reason)
  }

  t.section('a miss on each key component')
  const missFor = async (label, args) => {
    const id = await baselineIdentity({ target, targetKey, baseCommit: commit, ...args })
    t.ok(`${label}: the key differs`, id.key && id.key !== identity.key, id.error)
    t.eq(`${label}: no hit`, await adoptBaseline({ dir, identity: id, runDir: path.join(issuePath, 'runs', `miss-${label.replace(/\W+/g, '-')}`), dirName: 'base-x' }), null)
  }
  await missFor('another base commit', { baseCommit: 'b'.repeat(40) })
  {
    const edited = { ...target, commands: [{ id: 'probe', run: 'true # edited' }] }
    await missFor('another target definition', { target: edited, targetKey: sha(JSON.stringify(edited)) })
  }
  await fs.writeFile(scope, '{"applicationCollections":["APP-modules","APP-database-modules"]}\n')
  await missFor('another deployment-scope.json', {})
  await fs.writeFile(scope, '{"applicationCollections":["APP-modules"]}\n')
  await fs.writeFile(version, '4.1.1\n')
  await missFor('another framework version', {})
  await fs.writeFile(version, '4.1.0\n')
  await fs.writeFile(environmentFile, 'v22.12.0\n')
  await missFor('another environment (node)', {})
  await fs.writeFile(environmentFile, 'v22.11.0\n')
  t.eq('restored, the original key comes back', (await baselineIdentity({ target, targetKey, baseCommit: commit })).key, identity.key)

  t.section('a stored entry whose key record differs is never adopted')
  {
    const forged = { key: identity.key, record: { ...identity.record, baseCommit: 'c'.repeat(40) } }
    t.eq('same directory name, different key record: miss', await adoptBaseline({ dir, identity: forged, runDir: path.join(issuePath, 'runs', 'forged'), dirName: 'base-x' }), null)
  }

  t.section('a damaged entry is a miss, never a partial copy')
  {
    await fs.appendFile(path.join(dir, identity.key, 'files', 'probe.log'), 'tampered\n')
    const runC = path.join(issuePath, 'runs', 'run-c')
    t.eq('the manifest does not match: miss', await adoptBaseline({ dir, identity, runDir: runC, dirName: 'base-x' }), null)
    t.eq('and nothing is left in the run', await fs.access(path.join(runC, 'checks', 'base-x')).then(() => true, () => false), false)
  }

  t.section('a component that cannot be computed: no lookup and no store')
  {
    const missing = { ...target, baselineCache: { ...target.baselineCache, files: [path.join(env, 'absent.json')] } }
    const id = await baselineIdentity({ target: missing, targetKey, baseCommit: commit })
    t.ok('a missing staging file is an error', Boolean(id.error) && !id.key, JSON.stringify(id))
    const failing = { ...target, baselineCache: { ...target.baselineCache, environment: 'exit 3' } }
    t.ok('a failing environment command is an error', Boolean((await baselineIdentity({ target: failing, targetKey, baseCommit: commit })).error))
    const runD = path.join(issuePath, 'runs', 'run-d')
    const cache = baselineCacheFor({ target: missing, targetKey, baseCommit: commit, issuePath, runDir: runD, runId: 'run-d', clock: clockAt(Date.now()) })
    t.eq('lookup returns nothing', await cache.lookup('base-y'), null)
    t.eq('and says why', cache.status?.state, 'unavailable')
    await cache.store(await baseDrive(runD, 'base-y', commit))
    t.eq('store keeps nothing', cache.status?.state, 'unavailable')
    t.eq('and vouches for no identity, so the run cannot reuse that base either', cache.verified, null)
    t.eq('only the first entry exists', (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).length, 1)
  }

  t.section('an identity that changes while the base drive runs is not stored')
  {
    const runE = path.join(issuePath, 'runs', 'run-e')
    const other = 'e'.repeat(40)
    const cache = baselineCacheFor({ target, targetKey, baseCommit: other, issuePath, runDir: runE, runId: 'run-e', clock: clockAt(Date.now()) })
    t.eq('a miss before the drive', await cache.lookup('base-z'), null)
    t.eq('recorded as a miss', cache.status?.state, 'miss')
    await fs.writeFile(environmentFile, 'v22.13.0\n')   // the host changed during the drive
    await cache.store(await baseDrive(runE, 'base-z', other))
    t.eq('not stored: unstable', cache.status?.state, 'unstable')
    t.eq('an unstable base vouches for no identity', cache.verified, null)
    await fs.writeFile(environmentFile, 'v22.11.0\n')
    const again = baselineCacheFor({ target, targetKey, baseCommit: other, issuePath, runDir: runE, runId: 'run-e', clock: clockAt(Date.now()) })
    await again.store(await baseDrive(runE, 'base-z', other))
    t.eq('a stable identity is stored', again.status?.state, 'stored')
    t.eq('and vouches for exactly that identity', again.verified, again.status?.key)
  }

  t.section('pruned by count and by age')
  {
    const pdir = await temp('devpanel-bc-prune-')
    const day = 86400000
    const now = Date.UTC(2026, 9, 7)
    for (const [i, age] of [[1, 0], [2, 1], [3, 2], [4, 20]]) {
      await fs.mkdir(path.join(pdir, `k${i}`), { recursive: true })
      await fs.writeFile(path.join(pdir, `k${i}`, 'record.json'), JSON.stringify({ storedAtMs: now - age * day }))
    }
    const removed = await pruneBaselines({ dir: pdir, clock: clockAt(now), maxEntries: 2, maxAgeDays: 14 })
    t.eq('the 20-day-old entry and the oldest beyond two are removed', removed.sort(), ['k3', 'k4'])
    t.eq('the two newest stay', (await fs.readdir(pdir)).sort(), ['k1', 'k2'])
  }

  t.section('tiers: the smoke target is a subset; the full one is the whole target')
  {
    const tiered = { kind: 'ssh', commands: [{ id: 'prepare', run: 'a' }, { id: 'start', run: 'b', service: true }, { id: 'readiness', run: 'c', join: 'start' }, { id: 'browser-check', run: 'd', join: 'start', needs: ['readiness'] }],
      finallyCommands: [{ id: 'collect-selftest-report', run: 'e' }, { id: 'collect-journal', run: 'f' }], tiers: { smoke: ['prepare', 'start', 'readiness', 'collect-journal'] }, timing: 'approved' }
    const smoke = tierTarget(tiered, 'smoke')
    t.eq('smoke commands', smoke.commands.map((c) => c.id), ['prepare', 'start', 'readiness'])
    t.eq('smoke finalizers', smoke.finallyCommands.map((c) => c.id), ['collect-journal'])
    t.eq('the full tier keeps every command', tierTarget(tiered, 'full').commands.length + tierTarget(tiered, 'full').finallyCommands.length, 6)
    // A target's hash and a baseline's key are taken from these: setting the new options moves neither.
    const withOptions = { ...tiered, tiers: { ...tiered.tiers, continueSmoke: false, keepSeconds: 60 } }
    t.eq('continueSmoke and keepSeconds are not in the smoke tier\'s definition', JSON.stringify(tierTarget(withOptions, 'smoke')), JSON.stringify(tierTarget(tiered, 'smoke')))
    t.eq('nor in the full tier\'s', JSON.stringify(tierTarget(withOptions, 'full')), JSON.stringify(tierTarget(tiered, 'full')))
    t.ok('each tier is a different target definition', JSON.stringify(smoke) !== JSON.stringify(tierTarget(tiered, 'full')) && smoke.tier === 'smoke')
    t.eq('an untiered target is unchanged', tierTarget(target, 'full'), target)
    t.eq('a valid smoke tier has no errors', tierErrors(tiered), [])
    t.ok('an unknown id is refused', tierErrors({ ...tiered, tiers: { smoke: ['nope'] } }).some((e) => /nope is not a command/.test(e)))
    t.ok('a smoke command whose join is not smoke is refused', tierErrors({ ...tiered, tiers: { smoke: ['readiness'] } }).some((e) => /needs start/.test(e)))
    t.ok('every-revision timing is refused', tierErrors({ ...tiered, timing: 'every-revision' }).some((e) => /every-revision/.test(e)))
    const infra = { staging: { id: 'stage', ssh: { hostRef: 'ssh-config:x', workdir: '/srv' }, projectRoot: '/opt/app', files: { 'deployment-scope': '/opt/app/deployment-scope.json' } },
      deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:y', workdir: '/srv' }, projectRoot: '/opt/prod', files: {} }],
      testDrive: { commands: tiered.commands, finallyCommands: tiered.finallyCommands, tiers: tiered.tiers, baselineCache: { stagingFiles: ['deployment-scope'], environment: 'hostname' } } }
    const resolved = stagingTarget(infra)
    t.eq('the staging target carries the tiers and approved timing', [resolved.tiers?.smoke?.length, resolved.timing], [4, 'approved'])
    t.eq('staging file names become paths', resolved.baselineCache?.files, ['/opt/app/deployment-scope.json'])
    t.ok('an unknown staging file name is refused', infrastructureErrors({ ...infra, testDrive: { ...infra.testDrive, baselineCache: { stagingFiles: ['nope'], environment: 'hostname' } } }).some((e) => /nope is not in infrastructure.staging.files/.test(e)))
  }

  t.section('an environment identity over the application: one it cannot read is no identity at all')
  {
    // The shape docs/project-infrastructure.md "Baseline cache" asks for: the scope
    // lists the application's paths, and listing and hashing are separate steps,
    // so an unreadable file or directory exits non-zero instead of hiding in a pipeline.
    const src = await temp('devpanel-bc-app-')
    await fs.mkdir(path.join(src, 'APP-modules', 'sub'), { recursive: true })
    await fs.writeFile(path.join(src, 'deployment-scope.json'), JSON.stringify({ applicationCollections: ['APP-modules'], applicationFiles: ['version'] }))
    await fs.writeFile(path.join(src, 'APP-modules', 'a.mjs'), 'export const a = 1\n')
    await fs.writeFile(path.join(src, 'APP-modules', 'sub', 'b.mjs'), 'export const b = 1\n')
    await fs.writeFile(path.join(src, 'version'), '1.0.0\n')
    const environment = [
      `src=${src}`,
      'set -eu',
      'cd "$src"',
      `paths=$(${process.execPath} -e 'const s = require(process.cwd() + "/deployment-scope.json"); console.log([...s.applicationCollections, ...s.applicationFiles].join("\\n"))')`,
      'found=$(find $paths -type f)',
      'files=$(printf "%s\\n" "$found" | sort)',
      'sums=$(sha256sum $files)',
      'printf "%s\\n" "$sums" | sha256sum'
    ].join('\n')
    const app = { kind: 'local', commands: [{ id: 'probe', run: 'true' }], baselineCache: { environment } }
    const identityOf = () => baselineIdentity({ target: app, targetKey: 'k', baseCommit: commit })
    const readable = await identityOf()
    if (process.getuid?.() === 0) t.skip('unreadable application files', 'root reads a mode-000 file anyway')
    else if (!readable.key) t.skip('unreadable application files', `the command cannot run on this host: ${readable.error}`)
    else {
      await fs.writeFile(path.join(src, 'APP-modules', 'a.mjs'), 'export const a = 2\n')
      t.ok('the application bytes are part of the identity', (await identityOf()).key !== readable.key)
      await fs.chmod(path.join(src, 'APP-modules', 'a.mjs'), 0o000)
      const file = await identityOf()
      t.ok('an unreadable application file is rejected, not hashed around', Boolean(file.error) && !file.key, JSON.stringify(file))
      await fs.chmod(path.join(src, 'APP-modules', 'a.mjs'), 0o644)
      await fs.chmod(path.join(src, 'APP-modules', 'sub'), 0o000)
      const dir = await identityOf()
      t.ok('an unreadable application directory is rejected', Boolean(dir.error) && !dir.key, JSON.stringify(dir))
      await fs.chmod(path.join(src, 'APP-modules', 'sub'), 0o755)
      const runF = path.join(issuePath, 'runs', 'run-f')
      await fs.chmod(path.join(src, 'APP-modules', 'a.mjs'), 0o000)
      const cache = baselineCacheFor({ target: app, targetKey: 'k', baseCommit: commit, issuePath, runDir: runF, runId: 'run-f', clock: clockAt(Date.now()) })
      t.eq('so there is no lookup', [await cache.lookup('base-f'), cache.status?.state], [null, 'unavailable'])
      await cache.store(await baseDrive(runF, 'base-f', commit))
      t.eq('and no store', cache.status?.state, 'unavailable')
      await fs.chmod(path.join(src, 'APP-modules', 'a.mjs'), 0o644)
    }
  }

  t.section('local files are hashed without sha256sum, under the same key as before (P4-1)')
  {
    // The key exactly as the sha256sum version built it: [path, hex] in `files` order.
    const hexOf = async (file) => sha(await fs.readFile(file))
    const expected = (files, env) => sha(JSON.stringify({ version: 1, baseCommit: commit, targetHash: targetKey, files, environment: { host: 'local', sha256: sha(env) } }))
    const env = await fs.readFile(environmentFile, 'utf8')
    const id = await baselineIdentity({ target, targetKey, baseCommit: commit })
    t.eq('same bytes, paths and environment: the same key', id.key, expected([[scope, await hexOf(scope)], [version, await hexOf(version)]], env))
    const sums = await new Promise((resolve) => execFile('sha256sum', ['--', scope, version], (error, out) => resolve(error ? null : out)))
    if (sums === null) t.skip('agrees with sha256sum', 'no sha256sum on this host')
    else t.eq('each digest is the one sha256sum prints', id.record.files.map(([, hex]) => hex), sums.trim().split('\n').map((l) => l.split(/\s+/)[0]))
    const reordered = await baselineIdentity({ target: { ...target, baselineCache: { ...target.baselineCache, files: [version, scope, version] } }, targetKey, baseCommit: commit })
    t.eq('order and repeats are kept', reordered.record.files.map(([f]) => f), [version, scope, version])
    t.ok('and a different order is a different key', reordered.key !== id.key)
    const relative = path.relative(process.cwd(), scope)
    const rel = await baselineIdentity({ target: { ...target, baselineCache: { ...target.baselineCache, files: [relative] } }, targetKey, baseCommit: commit })
    t.eq('a relative path is read from this process\'s directory and recorded as given', rel.record.files, [[relative, await hexOf(scope)]])
  }

  t.section('a missing or unreadable local file prevents cache use with a specific error (P4-2)')
  {
    const failing = async (file) => baselineIdentity({ target: { ...target, baselineCache: { ...target.baselineCache, files: [file] } }, targetKey, baseCommit: commit })
    const missing = await failing(path.join(env, 'absent.json'))
    t.eq('a missing file', [missing.code, Boolean(missing.key)], ['BASELINE_FILE_UNREADABLE', false])
    t.ok('naming it', missing.error.includes('absent.json') && missing.error.includes('ENOENT'), missing.error)
    t.eq('a directory', (await failing(env)).code, 'BASELINE_FILE_UNREADABLE')
    if (process.getuid?.() === 0) t.skip('an unreadable file', 'root reads a mode-000 file anyway')
    else {
      const locked = path.join(env, 'locked')
      await fs.writeFile(locked, 'secret\n')
      await fs.chmod(locked, 0o000)
      t.eq('an unreadable file', (await failing(locked)).code, 'BASELINE_FILE_UNREADABLE')
      await fs.chmod(locked, 0o644)
    }
    const cache = baselineCacheFor({ target: { ...target, baselineCache: { ...target.baselineCache, files: [path.join(env, 'absent.json')] } }, targetKey, baseCommit: commit, issuePath, runDir: path.join(issuePath, 'runs', 'run-g'), runId: 'run-g', clock: clockAt(Date.now()) })
    t.eq('the cache is not used, and says why', [await cache.lookup('base-g'), cache.status?.state, cache.status?.code], [null, 'unavailable', 'BASELINE_FILE_UNREADABLE'])
  }

  t.section('remote (SSH) hashing is unchanged (P4-3)')
  {
    const source = await fs.readFile(new URL('../server/runtime/baseline-cache.mjs', import.meta.url), 'utf8')
    t.ok('the SSH branch still hashes with sha256sum on the target', source.includes('} else if (files.length) {\n    const out = await exec(`sha256sum -- ${files.map(shellQuote).join(\' \')}`)'))
  }

  for (const d of temps) await fs.rm(d, { recursive: true, force: true })
}
