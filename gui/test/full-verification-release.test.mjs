import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { greenStagingReleases } from '../server/release-selection.mjs'
import { executeRelease, releaseLockPaths, stagedRelease } from '../server/runtime/release.mjs'

export const name = 'full verification releases — a green cycle release is promotable; locks stay per project'

const run = promisify(execFile)
const sha = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
const HOME = '.verification-2026-11-07'

/** A staging release run in a folder of a project's issue directory (an issue, or a run home). */
async function stagingRun (projectDir, folder, runId, { green = true } = {}) {
  const tree = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fv-tree-'))
  await fs.writeFile(path.join(tree, 'app.txt'), `${runId}\n`)
  const artifacts = path.join(projectDir, folder, 'runs', runId, 'artifacts')
  await fs.mkdir(artifacts, { recursive: true })
  const archive = path.join(artifacts, 'release.tar')
  await run('tar', ['-cf', archive, '-C', tree, '.'])
  await fs.rm(tree, { recursive: true, force: true })
  const receipt = { runId, tactic: 'staging', stage: 'staging', status: 'completed', startedAt: '2026-11-07T05:10:00.000Z', sha256: await sha(archive), archive }
  const record = green ? { runId, status: 'completed', outcome: 'resolved', release: receipt } : { runId, status: 'blocked', outcome: 'unresolved', blockedReason: 'full-verification-checks-failed', release: receipt }
  await fs.writeFile(path.join(projectDir, folder, 'runs', runId, 'release.json'), JSON.stringify(receipt))
  await fs.writeFile(path.join(projectDir, folder, 'runs', runId, 'run.json'), JSON.stringify(record))
  return { receipt, record, home: path.join(projectDir, folder) }
}

const target = (root) => ({ workdir: root, ownership: 'fixture', rollback: 'manual', commands: Object.fromEntries(['inspect', 'checkpoint', 'verifyCheckpoint', 'apply', 'verifyRelease', 'restart', 'observe', 'test', 'restore', 'verifyRestore'].map((id) => [id, { run: id, timeoutSeconds: 10 }])) })
const production = (root, releaseId) => ({ tactic: 'deployment', runOptions: { environment: 'production' }, infrastructure: { staging: { id: 'stage' }, deployments: [{ id: 'prod' }], release: { targets: { stage: target(root), prod: target(root) } } },
  release: { mode: 'production', environment: 'production', staging: null, production: 'prod', releaseId, releaseIdSource: 'operator' } })

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fv-release-'))
  try {
    const appDir = path.join(root, 'app-project')
    const shopDir = path.join(root, 'shop-project')
    const green = await stagingRun(appDir, HOME, 'cycle-run')
    await stagingRun(appDir, HOME, 'red-cycle-run', { green: false })
    await stagingRun(shopDir, HOME, 'shop-cycle-run')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace)

    t.section('1. a green cycle release in a run home is found, selected and promoted byte for byte')
    {
      const found = await stagedRelease(appDir, 'cycle-run', { findPacked: null })
      t.eq('stagedRelease finds it in the run home', [found.runId, found.archive], ['cycle-run', green.receipt.archive])
      let refused = null
      try { await stagedRelease(appDir, 'red-cycle-run', { findPacked: null }) } catch (error) { refused = error.message }
      t.eq('a red cycle run is never promoted', refused, 'staged release has not passed its coordinator and all verifiers')
      const releases = await greenStagingReleases({ project: 'app-project', listIssues: async () => [], listHomes: async () => [{ id: 'verification-2026-11-07', path: green.home, project: 'app-project' }] })
      t.eq('release selection offers it, and not the red one', releases.map((r) => r.run.runId), ['cycle-run'])
      const deployIssue = path.join(appDir, '2026-11-08-deploy')
      await fs.mkdir(deployIssue, { recursive: true })
      const promoted = await executeRelease({ issuePath: deployIssue, runId: 'deploy-run', workspace: { path: workspace }, snapshot: production(root, 'cycle-run'), findPacked: null, execute: async () => ({ code: 0, stdout: 'ok', stderr: '' }) })
      t.eq('a production release promotes exactly those bytes', [promoted.status, promoted.sha256, promoted.sourceRelease], ['completed', green.receipt.sha256, 'cycle-run'])
    }

    t.section('2. release locks: one pair per project, shared by its issues and its run home')
    {
      const home = (dir) => path.join(dir, HOME)
      t.ok('two projects\' run homes take different locks', releaseLockPaths(home(appDir)).release !== releaseLockPaths(home(shopDir)).release && releaseLockPaths(home(appDir)).actions !== releaseLockPaths(home(shopDir)).actions)
      t.eq('a run home and an issue of one project take the same locks', releaseLockPaths(home(appDir)), releaseLockPaths(path.join(appDir, '2026-11-08-deploy')))

      // Releases from both projects' run homes at once: each lock refuses a second holder outright
      // (waitMs 0), so a shared lock would refuse one of them.
      let release = null
      const held = new Promise((resolve) => { release = resolve })
      const slow = async () => { await held; return { code: 0, stdout: 'ok', stderr: '' } }
      const app = executeRelease({ issuePath: home(appDir), runId: 'promote-app', workspace: { path: workspace }, snapshot: production(root, 'cycle-run'), findPacked: null, execute: slow })
      const shop = executeRelease({ issuePath: home(shopDir), runId: 'promote-shop', workspace: { path: workspace }, snapshot: production(root, 'shop-cycle-run'), findPacked: null, execute: slow })
      // While the app project's release holds its lock, an issue of the same project is refused.
      await new Promise((resolve) => setTimeout(resolve, 50))
      let sameProject = null
      try { await executeRelease({ issuePath: path.join(appDir, '2026-11-08-deploy'), runId: 'deploy-again', workspace: { path: workspace }, snapshot: production(root, 'cycle-run'), findPacked: null, execute: async () => ({ code: 0, stdout: 'ok', stderr: '' }) }) } catch (error) { sameProject = error }
      release()
      const [a, s] = await Promise.all([app, shop])
      t.eq('both projects\' releases completed side by side', [a.status, s.status], ['completed', 'completed'])
      t.ok('the same project\'s other release was refused while the lock was held', sameProject !== null)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
