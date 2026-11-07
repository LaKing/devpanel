import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { selectStagedRelease } from '../server/release-selection.mjs'
import { contentIdentity, executeRelease, stagedRelease } from '../server/runtime/release.mjs'

export const name = 'release selection — the newest green staging release whose content is the checkout\'s, packed issues included'

const run = promisify(execFile)
const sha = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')

async function writeTree (dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), text)
  }
}

/** A project checkout: a git repository holding `files`, committed. */
async function checkout (root, files) {
  const dir = path.join(root, 'checkout')
  await fs.mkdir(dir, { recursive: true })
  await writeTree(dir, files)
  const git = (...args) => run('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args])
  await git('init', '-q')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'fixture')
  return dir
}

/**
 * A green staging release run of an open issue: its archive (the files given)
 * under runs/<runId>/artifacts/release.tar and a run record. `content: false`
 * leaves the receipt without an identity, as one written before identities were.
 */
async function greenRelease (issuesDir, { issueId, runId, startedAt, files, content = true, green = true, workspace = {} }) {
  const issuePath = path.join(issuesDir, issueId)
  const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-release-tree-'))
  await writeTree(tree, files)
  const artifacts = path.join(issuePath, 'runs', runId, 'artifacts')
  await fs.mkdir(artifacts, { recursive: true })
  const archive = path.join(artifacts, 'release.tar')
  await run('tar', ['-cf', archive, '-C', tree, '.'])
  const receipt = { runId, tactic: 'staging', stage: 'staging', status: 'completed', startedAt, sha256: await sha(archive), archive, ...(content ? { content: await contentIdentity(tree) } : {}) }
  await fs.rm(tree, { recursive: true, force: true })
  const record = { runId, status: 'completed', outcome: green ? 'resolved' : 'unresolved', startedAt, release: receipt, workspace: { symlinks: { materialized: [] }, base: { excludes: [] }, ...workspace } }
  await fs.writeFile(path.join(issuePath, 'runs', runId, 'release.json'), JSON.stringify(receipt))
  await fs.writeFile(path.join(issuePath, 'runs', runId, 'run.json'), JSON.stringify(record))
  return { issue: { id: issueId, path: issuePath, project: 'fixture-project' }, run: record }
}

/** The issue store a selection reads, from fixture releases. */
const store = (open, archived = []) => ({
  listIssues: async (_project, { archived: wantArchived = false } = {}) => (wantArchived ? archived : open).map((r) => r.issue),
  readRuns: async (issuePath) => open.filter((r) => r.issue.path === issuePath).map((r) => r.run),
  readPackedRuns: async (_project, id) => archived.filter((r) => r.issue.id === id).map((r) => r.run)
})

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-release-selection-'))
  try {
    const issuesDir = path.join(root, 'issues', 'fixture-project')
    const v1 = { 'app.txt': 'version one\n', 'lib/util.txt': 'shared\n' }
    const v2 = { 'app.txt': 'version two\n', 'lib/util.txt': 'shared\n' }
    const projectPath = await checkout(root, v1)

    t.section('M1: the newest green release differs, an older one matches the checkout: the older one is filled')
    const older = await greenRelease(issuesDir, { issueId: '2026-11-01-older', runId: 'older-run', startedAt: '2026-11-01T10:00:00.000Z', files: v1 })
    const newer = await greenRelease(issuesDir, { issueId: '2026-11-02-newer', runId: 'newer-run', startedAt: '2026-11-02T10:00:00.000Z', files: v2 })
    let chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([older, newer]) })
    t.eq('the matching older release is chosen', [chosen.releaseId, chosen.issueId, chosen.matched], ['older-run', '2026-11-01-older', 'content-identity'])
    await fs.writeFile(path.join(projectPath, 'app.txt'), 'version two\n')
    chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([older, newer]) })
    t.eq('when the checkout holds the newer content, the newer is chosen', chosen.releaseId, 'newer-run')

    t.section('M2: a hand edit outside any run: nothing matches, the start is refused')
    await fs.writeFile(path.join(projectPath, 'app.txt'), 'version two, edited by hand\n')
    chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([older, newer]) })
    t.eq('refused: content not staged', [chosen.releaseId, chosen.reason], [null, 'content-not-staged'])
    t.eq('naming the latest green release', chosen.latestGreen?.runId, 'newer-run')
    t.eq('both releases were compared', chosen.compared.map((c) => c.runId), ['newer-run', 'older-run'])
    await fs.writeFile(path.join(projectPath, 'app.txt'), 'version one\n')

    t.section('M3: no green release at all, or a red one only')
    chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([]) })
    t.eq('no green staging release', [chosen.releaseId, chosen.reason, chosen.latestGreen], [null, 'no-green-staging', null])
    const red = await greenRelease(issuesDir, { issueId: '2026-11-03-red', runId: 'red-run', startedAt: '2026-11-03T10:00:00.000Z', files: v1, green: false })
    chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([red]) })
    t.eq('a red release with the same content is never filled', [chosen.releaseId, chosen.reason], [null, 'no-green-staging'])

    t.section('M4: a receipt with no recorded identity is read from its verified archive; a changed archive never matches')
    // The changed archive first: identities read from archives are kept per recorded hash, and
    // two archives of the same files can have the same bytes.
    const tampered = await greenRelease(issuesDir, { issueId: '2026-11-05-tampered', runId: 'tampered-run', startedAt: '2026-11-05T10:00:00.000Z', files: v1, content: false })
    await fs.appendFile(path.join(tampered.issue.path, 'runs', 'tampered-run', 'artifacts', 'release.tar'), 'tamper')
    chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([tampered]) })
    t.eq('a changed archive is unverifiable and refused', [chosen.releaseId, chosen.unverifiable.map((u) => u.runId)], [null, ['tampered-run']])
    const legacy = await greenRelease(issuesDir, { issueId: '2026-11-04-legacy', runId: 'legacy-run', startedAt: '2026-11-04T10:00:00.000Z', files: v1, content: false })
    chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([legacy]) })
    t.eq('matched from its archive', chosen.releaseId, 'legacy-run')

    t.section('A1/A2: an archive deleted or changed after its identity was recorded or remembered is never matched')
    {
      // A2: legacy-run's identity is now remembered; its archive changes afterwards.
      const legacyArchive = path.join(legacy.issue.path, 'runs', 'legacy-run', 'artifacts', 'release.tar')
      const bytes = await fs.readFile(legacyArchive)
      await fs.appendFile(legacyArchive, 'changed later')
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([legacy]) })
      t.eq('A2: changed after its identity was remembered: unverifiable, refused', [chosen.releaseId, chosen.unverifiable.map((u) => u.runId)], [null, ['legacy-run']])
      await fs.writeFile(legacyArchive, bytes)
      // A1: a recorded identity, then the archive is deleted; an older usable release is chosen instead.
      const recorded = await greenRelease(issuesDir, { issueId: '2026-11-08-recorded', runId: 'recorded-run', startedAt: '2026-11-08T10:00:00.000Z', files: v1 })
      await fs.rm(path.join(recorded.issue.path, 'runs', 'recorded-run', 'artifacts', 'release.tar'))
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([recorded]) })
      t.eq('A1: deleted after its identity was recorded: unverifiable, refused', [chosen.releaseId, chosen.reason, chosen.unverifiable.map((u) => u.runId)], [null, 'content-not-staged', ['recorded-run']])
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([older, recorded]) })
      // A successful selection names the release it filled (its documented shape has no unverifiable list).
      t.eq('A1: the walk goes on to an older release whose archive is intact', [chosen.releaseId, chosen.issueId, chosen.matched], ['older-run', '2026-11-01-older', 'content-identity'])
    }

    t.section('N1: the identity covers what the archive carries, a tracked node_modules included')
    {
      const files = { 'app.txt': 'version one\n', 'node_modules/pkg/index.js': 'module.exports = 1\n' }
      const vendored = path.join(root, 'vendored')
      await fs.mkdir(vendored)
      await writeTree(vendored, files)
      const git = (...args) => run('git', ['-C', vendored, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args])
      await git('init', '-q'); await git('add', '-A'); await git('commit', '-q', '-m', 'fixture')
      const shipped = await greenRelease(issuesDir, { issueId: '2026-11-09-vendored', runId: 'vendored-run', startedAt: '2026-11-09T10:00:00.000Z', files })
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath: vendored, ...store([shipped]) })
      t.eq('the same files, node_modules included, match', chosen.releaseId, 'vendored-run')
      await fs.writeFile(path.join(vendored, 'node_modules/pkg/index.js'), 'module.exports = 2\n')
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath: vendored, ...store([shipped]) })
      t.eq('a change under node_modules changes the identity and refuses the match', [chosen.releaseId, chosen.reason], [null, 'content-not-staged'])
    }

    t.section('M5: a release whose run materialized a link matches a checkout that holds the link')
    {
      const shared = path.join(root, 'shared')
      await writeTree(shared, { 'helper.txt': 'helper\n' })
      const linked = path.join(root, 'linked')
      await fs.mkdir(linked)
      await fs.writeFile(path.join(linked, 'app.txt'), 'version one\n')
      await fs.symlink(shared, path.join(linked, 'vendor'))
      const git = (...args) => run('git', ['-C', linked, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args])
      await git('init', '-q'); await git('add', '-A'); await git('commit', '-q', '-m', 'fixture')
      const materialized = await greenRelease(issuesDir, { issueId: '2026-11-06-linked', runId: 'linked-run', startedAt: '2026-11-06T10:00:00.000Z', files: { 'app.txt': 'version one\n', 'vendor/helper.txt': 'helper\n' }, workspace: { symlinks: { materialized: ['vendor'] } } })
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath: linked, ...store([materialized]) })
      t.eq('the checkout is read through the release\'s own projection', chosen.releaseId, 'linked-run')
    }

    t.section('P1/P2: a matching green release in a packed issue is filled and promoted from its verified archive')
    {
      const base = path.join(root, 'bundle-base')
      const packedIssue = '2026-10-30-packed'
      const tree = path.join(root, 'packed-tree')
      await writeTree(tree, v1)
      const member = path.join(base, packedIssue, 'runs', 'packed-run', 'artifacts')
      await fs.mkdir(member, { recursive: true })
      await run('tar', ['-cf', path.join(member, 'release.tar'), '-C', tree, '.'])
      const sha256 = await sha(path.join(member, 'release.tar'))
      const bundle = path.join(root, `${packedIssue}.tar.gz`)
      await run('tar', ['-czf', bundle, '-C', base, packedIssue])
      const packedRun = { runId: 'packed-run', status: 'completed', outcome: 'resolved', startedAt: '2026-10-30T10:00:00.000Z', release: { runId: 'packed-run', tactic: 'staging', status: 'completed', startedAt: '2026-10-30T10:00:00.000Z', sha256 }, workspace: { symlinks: { materialized: [] }, base: { excludes: [] } } }
      const packed = { issue: { id: packedIssue, packed: true, archived: true, location: bundle, project: 'fixture-project' }, run: packedRun }
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([], [packed]) })
      t.eq('P1: the packed release is filled', [chosen.releaseId, chosen.packed], ['packed-run', true])
      const findPacked = async (_project, releaseId) => (releaseId === 'packed-run' ? packed : null)
      const extractTo = path.join(root, 'deploy-run', 'artifacts', 'staged-source.tar')
      const found = await stagedRelease(issuesDir, 'packed-run', { extractTo, findPacked })
      t.eq('P1: its archive is extracted and verified', [found.archive, await sha(found.archive)], [extractTo, sha256])
      const deployIssue = path.join(issuesDir, '2026-11-07-deploy')
      await fs.mkdir(deployIssue, { recursive: true })
      const target = { workdir: root, ownership: 'fixture', rollback: 'manual', commands: Object.fromEntries(['inspect', 'checkpoint', 'verifyCheckpoint', 'apply', 'verifyRelease', 'restart', 'observe', 'test', 'restore', 'verifyRestore'].map((id) => [id, { run: id, timeoutSeconds: 10 }])) }
      const snapshot = { tactic: 'deployment', runOptions: { environment: 'production' }, infrastructure: { staging: { id: 'stage' }, deployments: [{ id: 'prod' }], release: { targets: { stage: target, prod: target } } }, release: { mode: 'production', environment: 'production', staging: null, production: 'prod', releaseId: 'packed-run', releaseIdSource: 'filled' } }
      const workspace = path.join(root, 'deploy-workspace')
      await fs.mkdir(workspace)
      const promoted = await executeRelease({ issuePath: deployIssue, runId: 'deploy-run', workspace: { path: workspace }, snapshot, findPacked, execute: async () => ({ code: 0, stdout: 'ok', stderr: '' }) })
      t.eq('P1: production promotes the packed release\'s exact bytes', [promoted.status, promoted.sha256, promoted.sourceRelease, promoted.environment], ['completed', sha256, 'packed-run', 'prod'])

      // P2: the bundle's member no longer has the recorded bytes, though P1 remembered its identity.
      await fs.appendFile(path.join(member, 'release.tar'), 'tamper')
      await run('tar', ['-czf', bundle, '-C', base, packedIssue])
      chosen = await selectStagedRelease({ project: 'fixture-project', projectPath, ...store([], [packed]) })
      t.eq('P2: a packed archive that is not the recorded bytes never matches', [chosen.releaseId, chosen.unverifiable.length], [null, 1])
      let refused = null
      try { await stagedRelease(issuesDir, 'packed-run', { extractTo: path.join(root, 'again.tar'), findPacked }) } catch (error) { refused = error.message }
      t.eq('P2: and is refused for promotion', refused, 'staged release artifact changed')
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
