import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery, startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { integrateRun, reconcileIntegration, runLocked, sweepPendingIntegration } from '../server/runtime/integrate.mjs'
import { acquire, currentOwner } from '../server/runtime/lock.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import * as store from '../server/runtime/store.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'commit delivery and approved integration — into the right repository, bound to the revision, never half-merged'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

async function project () {
  const dir = await temp('int-proj-')
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'a.txt'), 'one' + NL)
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-qm', 'base'])
  return dir
}

/** A committed candidate on a devpanel/ branch, with its run record on disk. */
async function committedCandidate ({ projectPath, issueId = '2026-09-12-int-issue', edit = 'two' } = {}) {
  projectPath ??= await project()
  const issuePath = path.join(await temp('int-issue-'), issueId)
  const runId = '2026-09-12T00-00-00-000Z-abcdef12'
  const runDir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  const ws = await gitWorktreeProvider.create({ projectPath, runId, root: path.join(issuePath, 'runs'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'a.txt'), edit + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  const receipt = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir, label: 'test candidate' })
  const record = {
    runId, issue: { project: 'p', id: issueId }, playbook: { id: 'x', version: 1 }, status: 'completed', outcome: 'resolved', participants: {}, steps: [],
    revisions: [{ fingerprint: fp.fingerprint }], approvals: [], checkResults: [], outstandingFindings: [],
    workspace: { ...ws, state: 'active' },
    delivery: { action: 'commit', revision: fp.fingerprint, completedAt: 't', artifactRef: receipt.artifactRef, reconstruction: receipt.reconstruction, repository: receipt.repository, branch: receipt.branch, commit: receipt.commit },
    closure: { revision: fp.fingerprint }
  }
  await store.writeRun(issuePath, runId, record)
  await fs.writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ type: 'delivered', at: 't' }) + NL)
  return { projectPath, issuePath, runId, ws, fp, receipt, record }
}

export default async function (t) {
  t.section('1. commit delivery: a verified commit on a devpanel/ branch, parented on the base')
  {
    const c = await committedCandidate()
    t.ok('a commit exists', /^[0-9a-f]{40}$/.test(c.receipt.commit ?? ''))
    t.ok('on a devpanel branch named for the issue and run', c.receipt.branch.startsWith('devpanel/2026-09-12-int-issue/'), c.receipt.branch)
    t.eq('parented on the base', (await run('git', ['-C', c.projectPath, 'rev-parse', `${c.receipt.commit}^`])).stdout.trim(), c.ws.baseCommit)
    t.eq('the branch points at it', (await run('git', ['-C', c.projectPath, 'rev-parse', c.receipt.branch])).stdout.trim(), c.receipt.commit)
    t.eq('the patch was still written', typeof c.receipt.artifactRef, 'string')
    t.eq('and the commit itself was verified against the revision', c.receipt.reconstruction.commit.verified, true)
    t.eq('the repository is recorded', c.receipt.repository, await fs.realpath(path.join(c.projectPath, '.git')))
    t.eq('main is untouched', (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim(), c.ws.baseCommit)
    t.ok('the run offers integrate', supportedActions(c.record).includes('integrate'))
  }

  t.section('2. integrate into a branch that is not checked out merges in a temporary worktree')
  {
    const c = await committedCandidate()
    await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: integration${NL}`)
    })
    const { integrationTarget } = await import('../server/runtime/integrate.mjs')
    const target = await integrationTarget({ project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, runId: c.runId, issuePath: c.issuePath })
    t.eq('the target names the declared branch and its head', `${target.branch}:${target.head}`, `integration:${c.ws.baseCommit}`)
    t.eq('and confirms the repositories match', target.sameRepository, true)
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: target.branch, expectedTargetHead: target.head })
    t.eq('no error', result.error, null, result.error)
    t.eq('method', result.integration.method, 'built-on-approved-head, published-by-compare-and-swap')
    t.eq('target head before recorded', result.integration.targetHeadBefore, c.ws.baseCommit)
    const head = (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim()
    t.eq('integration moved to the merge commit', head, result.integration.mergeCommit)
    const parents = (await run('git', ['-C', c.projectPath, 'rev-list', '--parents', '-n', '1', head])).stdout.trim().split(' ')
    t.ok('a real merge with the candidate as second parent', parents.length === 3 && parents[2] === c.receipt.commit)
    t.eq('the checkout was not touched', (await run('git', ['-C', c.projectPath, 'branch', '--show-current'])).stdout.trim(), 'main')
    t.eq('no worktree left behind', (await run('git', ['-C', c.projectPath, 'worktree', 'list'])).stdout.trim().split(NL).length, 2)
    t.ok('the run no longer offers integrate', !supportedActions(await store.readRun(c.issuePath, c.runId)).includes('integrate'))
    const again = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: head }).catch((e) => ({ error: e.message }))
    t.ok('a second approval is refused', /already integrated/.test(again.error ?? ''), again.error)
  }

  t.section('3. a clean checkout of the target merges in place; a dirty one is refused')
  {
    const c = await committedCandidate()
    const declare = (projectPath) => sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${projectPath}${NL}integrationBranch: main${NL}`)
    })
    const undeclared = await sandbox(async () => {})
    const guess = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: undeclared, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('an undeclared project is refused, never guessed', /no complete declaration of its source repository/.test(guess.error ?? ''), guess.error)

    const cfgRoot = await declare(c.projectPath)
    const missingHead = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main' }).catch((e) => ({ error: e.message }))
    t.ok('an approval without the target head is refused', /expectedTargetHead/.test(missingHead.error ?? ''), missingHead.error)
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit })
    t.eq('published by compare-and-swap with the checkout brought along', `${result.integration.method}:${result.integration.worktrees.updated.length}`, 'built-on-approved-head, published-by-compare-and-swap:1', result.error)
    t.eq('and the working tree followed', await fs.readFile(path.join(c.projectPath, 'a.txt'), 'utf8'), 'two' + NL)

    const d = await committedCandidate({ edit: 'three' })
    const cfgD = await declare(d.projectPath)
    await fs.writeFile(path.join(d.projectPath, 'a.txt'), 'local edit' + NL)
    const refused = await integrateRun({ issuePath: d.issuePath, runId: d.runId, project: 'p', projectPath: d.projectPath, configRoot: cfgD, expectedRevision: d.fp.fingerprint, targetBranch: 'main', expectedTargetHead: d.ws.baseCommit })
    t.ok('refused', /modified tracked path/.test(refused.error ?? ''), refused.error)
    t.eq('recorded on the run', (await store.readRun(d.issuePath, d.runId)).integration.error, refused.error)
    t.eq('the checkout is untouched', await fs.readFile(path.join(d.projectPath, 'a.txt'), 'utf8'), 'local edit' + NL)
  }

  t.section('4. the wrong revision, a moved target, the wrong repository, and a conflict are all refused cleanly')
  {
    const c = await committedCandidate()
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: main${NL}`)
    })
    const wrong = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: 'sha256:' + '0'.repeat(64), targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('an approval for another revision is refused', /approval names revision/.test(wrong.error ?? ''), wrong.error)

    // The target moves after the operator looked.
    await fs.writeFile(path.join(c.projectPath, 'b.txt'), 'unrelated' + NL)
    await run('git', ['-C', c.projectPath, 'add', 'b.txt'])
    await run('git', ['-C', c.projectPath, 'commit', '-qm', 'someone else'])
    const moved = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('a target that moved since approval is refused', /moved since the approval/.test(moved.error ?? ''), moved.error)
    const wrongBranch = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'other', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('a branch other than the declared one is refused', /integration branch is main/.test(wrongBranch.error ?? ''), wrongBranch.error)

    const other = await project()
    const elsewhere = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${other}${NL}integrationBranch: main${NL}`)
    })
    const misplaced = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: elsewhere, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: (await run('git', ['-C', other, 'rev-parse', 'main'])).stdout.trim() }).catch((e) => ({ error: e.message }))
    t.ok('a different source repository is refused with the reason', /declared source repository/.test(misplaced.error ?? ''), misplaced.error)

    // A conflicting change lands on main; the operator reads the new head and approves onto it.
    await fs.writeFile(path.join(c.projectPath, 'a.txt'), 'conflicting' + NL)
    await run('git', ['-C', c.projectPath, 'commit', '-qam', 'conflict'])
    const nowHead = (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim()
    const conflict = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: nowHead })
    t.ok('the merge is aborted and reported', /failed and was aborted/.test(conflict.error ?? ''), conflict.error)
    t.eq('nothing half-merged', (await run('git', ['-C', c.projectPath, 'status', '--porcelain'])).stdout.trim(), '')
  }

  t.section('4b. a branch that moves between building and publishing is never published onto')
  {
    const { integrateRun: integrate } = await import('../server/runtime/integrate.mjs')
    for (const checkedOut of [false, true]) {
      const c = await committedCandidate()
      const branch = checkedOut ? 'main' : 'integration'
      if (!checkedOut) await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
      const cfgRoot = await sandbox(async (dir) => {
        await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
        await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: ${branch}${NL}`)
      })
      const advance = async () => {
        // Someone lands a commit on the target after validation, before publication.
        const tmp = path.join(await temp('race-'), 'wt')
        await run('git', ['-C', c.projectPath, 'worktree', 'add', '--quiet', tmp, branch]).catch(async () => {
          // the branch is checked out: commit in the checkout itself
          await fs.writeFile(path.join(c.projectPath, 'race.txt'), 'raced' + NL)
          await run('git', ['-C', c.projectPath, 'add', 'race.txt'])
          await run('git', ['-C', c.projectPath, 'commit', '-qm', 'raced'])
        })
        if (await fs.stat(tmp).then(() => true, () => false)) {
          await fs.writeFile(path.join(tmp, 'race.txt'), 'raced' + NL)
          await run('git', ['-C', tmp, 'add', 'race.txt'])
          await run('git', ['-C', tmp, 'commit', '-qm', 'raced'])
          await run('git', ['-C', c.projectPath, 'worktree', 'remove', '--force', tmp])
        }
      }
      const result = await integrate({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: branch, expectedTargetHead: c.ws.baseCommit, hooks: { beforePublish: advance } })
      t.ok(`${checkedOut ? 'checked-out' : 'not checked out'}: refused`, /moved|fast-forwarded/.test(result.error ?? ''), result.error)
      const head = (await run('git', ['-C', c.projectPath, 'rev-parse', branch])).stdout.trim()
      const parents = (await run('git', ['-C', c.projectPath, 'rev-list', '--parents', '-n', '1', head])).stdout.trim().split(' ')
      t.eq(`${checkedOut ? 'checked-out' : 'not checked out'}: the branch holds the racing commit, not a merge`, parents.length, 2)
      t.eq(`${checkedOut ? 'checked-out' : 'not checked out'}: no integration recorded as done`, (await store.readRun(c.issuePath, c.runId)).integration.mergeCommit, null)
    }
  }

  t.section('4b2. publication is bound to the named branch, not to whatever HEAD names')
  {
    const c = await committedCandidate()
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: main${NL}`)
    })
    // Between build and publish the checkout switches to another branch at the same commit.
    const swap = async () => { await run('git', ['-C', c.projectPath, 'checkout', '-q', '-b', 'other']) }
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit, hooks: { beforePublish: swap } })
    t.eq('published', result.error, null, result.error)
    t.eq('main received the merge', (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim(), result.integration.mergeCommit)
    t.eq('other is untouched', (await run('git', ['-C', c.projectPath, 'rev-parse', 'other'])).stdout.trim(), c.ws.baseCommit)
    t.eq('the receipt names main', result.integration.targetBranch, 'main')
    t.eq('and no worktree needed updating', result.integration.worktrees.updated.length, 0)
  }

  t.section('4b3. a target checked out in another worktree is inspected and brought along')
  {
    const c = await committedCandidate()
    await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
    const elsewhere = path.join(await temp('other-wt-'), 'wt')
    await run('git', ['-C', c.projectPath, 'worktree', 'add', '--quiet', elsewhere, 'integration'])
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: integration${NL}`)
    })
    // Dirty over there: refused before anything is published.
    await fs.writeFile(path.join(elsewhere, 'a.txt'), 'local edit elsewhere' + NL)
    const refused = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit })
    t.ok('refused because of the other worktree', new RegExp(`checked out in ${elsewhere}`).test(refused.error ?? ''), refused.error)
    t.eq('nothing published', (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim(), c.ws.baseCommit)
    // Clean over there: published, and that worktree's files follow.
    await run('git', ['-C', elsewhere, 'checkout', '--', 'a.txt'])
    const ok = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit })
    t.eq('published', ok.error, null, ok.error)
    t.eq('the other worktree HEAD is the merge', (await run('git', ['-C', elsewhere, 'rev-parse', 'HEAD'])).stdout.trim(), ok.integration.mergeCommit)
    t.eq('and its files match', await fs.readFile(path.join(elsewhere, 'a.txt'), 'utf8'), 'two' + NL)
    t.eq('recorded as updated', ok.integration.worktrees.updated.length, 1)
    t.eq('the source checkout stayed on main', (await run('git', ['-C', c.projectPath, 'branch', '--show-current'])).stdout.trim(), 'main')
    await run('git', ['-C', c.projectPath, 'worktree', 'remove', '--force', elsewhere])
  }

  t.section('4b4. a crash after the swap is reconciled from the record; a crash before it aborts cleanly')
  {
    const { reconcileIntegration } = await import('../server/runtime/integrate.mjs')
    const crash = () => { throw Object.assign(new Error('simulated process death'), { simulatedCrash: true }) }
    for (const when of ['afterPublish', 'beforePublish']) {
      const c = await committedCandidate()
      await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
      const elsewhere = path.join(await temp('crash-wt-'), 'wt')
      await run('git', ['-C', c.projectPath, 'worktree', 'add', '--quiet', elsewhere, 'integration'])
      const cfgRoot = await sandbox(async (dir) => {
        await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
        await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: integration${NL}`)
      })
      let died = null
      try { await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit, hooks: { [when]: crash } }) } catch (e) { died = e }
      t.ok(`${when}: the process died`, died?.simulatedCrash === true)
      const interrupted = (await store.readRun(c.issuePath, c.runId)).integration
      if (when === 'afterPublish') {
        t.eq('the intent was persisted as published', interrupted.phase, 'published')
        t.eq('the branch holds the merge', (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim(), interrupted.mergeCommit)
        t.eq('but the checkout still shows the old content', await fs.readFile(path.join(elsewhere, 'a.txt'), 'utf8'), 'one' + NL)
        t.ok('a second approval is refused while unfinished', /previous publication is unfinished/.test((await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))).error ?? ''))
        const settled = await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })
        t.eq('reconciliation completes it', settled.phase, 'complete')
        t.eq('and the checkout now matches', await fs.readFile(path.join(elsewhere, 'a.txt'), 'utf8'), 'two' + NL)
        t.eq('recorded as updated', settled.integration.worktrees.updated.length, 1)
      } else {
        t.eq('nothing was published', (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim(), c.ws.baseCommit)
        t.eq('no record claims otherwise', interrupted ?? null, null)
      }
      t.eq('reconciling again changes nothing', (await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })).reconciled, false)
      await run('git', ['-C', c.projectPath, 'worktree', 'remove', '--force', elsewhere])
    }

    // A crash between persisting the intent and the swap: the record says
    // publishing, the branch did not move; reconciliation aborts and re-offers.
    const c = await committedCandidate()
    const runRecord = await store.readRun(c.issuePath, c.runId)
    runRecord.integration = { approvedBy: 'operator', revision: c.fp.fingerprint, repository: c.receipt.repository, targetBranch: 'main', targetHeadBefore: c.ws.baseCommit, mergeCommit: 'deadbeef', method: 'x', at: 't', error: null, phase: 'publishing', worktrees: { pending: [], updated: [], stale: [] } }
    await store.writeRun(c.issuePath, c.runId, runRecord)
    const settled = await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })
    t.eq('an unswapped publishing record is aborted', settled.phase, 'aborted')
    t.ok('with the reason', /interrupted before the branch moved/.test(settled.integration.error ?? ''), settled.integration.error)
    t.ok('and integrate is offered again', supportedActions(await store.readRun(c.issuePath, c.runId)).includes('integrate'))
  }

  t.section('4c. a declaration that names only an id is not a declaration')
  {
    const c = await committedCandidate()
    const partial = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}`)
    })
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: partial, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('refused as incomplete', /no complete declaration/.test(result.error ?? ''), result.error)
    t.ok('with the schema\'s words', /invalid.*sourceRepository|integrationBranch/.test(result.error ?? ''), result.error)
    t.eq('main untouched', (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim(), c.ws.baseCommit)
  }

  t.section('5. through the engine: an implementation run set to commit delivery commits its candidate')
  {
    const f = await engineFixture({ delivery: 'commit', script: scriptFor() })
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: worktreeDiffDelivery
    })
    const run_ = await engine.drive()
    t.eq('resolved', run_.outcome, 'resolved', run_.blockedReason)
    t.eq('delivered by commit', run_.delivery.action, 'commit')
    t.ok('with a commit and branch', Boolean(run_.delivery.commit) && run_.delivery.branch.startsWith('devpanel/'))
    t.eq('verified', run_.delivery.reconstruction.verified, true)
    await releaseWorkspace(engine)
  }

  // A declaration naming main as the integration branch of the candidate's repository.
  const declared = (c) => sandbox(async (dir) => {
    await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
    await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: main${NL}`)
  })
  // Every file under a run directory with its content hash: "nothing was written".
  const snapshot = async (dir) => {
    const out = {}
    for (const e of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue
      const file = path.join(e.parentPath ?? e.path, e.name)
      out[path.relative(dir, file)] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
    }
    return out
  }
  const runDirOf = (c) => store.runDir(c.issuePath, c.runId)
  const lockFile = (c) => path.join(c.issuePath, '.run.lock')
  const mainHead = async (c) => (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim()
  // A publication interrupted before the branch moved (as in 4b4).
  const publishing = async (c) => {
    const record = await store.readRun(c.issuePath, c.runId)
    record.integration = { approvedBy: 'operator', revision: c.fp.fingerprint, repository: c.receipt.repository, targetBranch: 'main', targetHeadBefore: c.ws.baseCommit, mergeCommit: 'deadbeef', method: 'x', at: 't', error: null, phase: 'publishing', worktrees: { pending: [], updated: [], stale: [] } }
    delete record.journal
    await store.writeRun(c.issuePath, c.runId, record)
  }
  // A lock another owner holds: alive (this process, another run), unknown (another host), dead (pid reused).
  const foreignLock = async (c, kind) => {
    const owner = { ...await currentOwner('other-run'), ...(kind === 'unknown' ? { host: 'elsewhere' } : {}), ...(kind === 'dead' ? { processStartedAt: '1' } : {}) }
    await fs.writeFile(lockFile(c), JSON.stringify({ purpose: 'run', token: `held-${kind}`, owner }))
  }
  const tornTail = (c) => fs.appendFile(path.join(runDirOf(c), 'events.jsonl'), '{"type":')
  const trimTail = async (c) => {
    const file = path.join(runDirOf(c), 'events.jsonl')
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.slice(0, text.lastIndexOf(NL) + 1))
  }

  t.section('6. both operations take the run lock first: a held lock refuses, retryable, before anything is read or written')
  {
    for (const kind of ['alive', 'unknown']) {
      const c = await committedCandidate()
      const cfg = await declared(c)
      if (kind === 'alive') c.held = await acquire(lockFile(c), { purpose: 'run', runId: 'other-run' })
      else await foreignLock(c, 'unknown')
      const before = await snapshot(runDirOf(c))
      const lockBefore = await fs.readFile(lockFile(c), 'utf8')
      const refused = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfg, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => e)
      t.eq(`${kind} owner: integrateRun refuses RUN_LOCKED`, [refused?.code, refused?.retryable, refused?.status, refused?.liveness], ['RUN_LOCKED', true, 409, kind])
      t.eq(`${kind} owner: run.json and events.jsonl unchanged`, await snapshot(runDirOf(c)), before)
      t.eq(`${kind} owner: the integration branch unchanged`, await mainHead(c), c.ws.baseCommit)
      t.eq(`${kind} owner: the lock is left as it was`, await fs.readFile(lockFile(c), 'utf8'), lockBefore)

      await publishing(c)
      const beforeReconcile = await snapshot(runDirOf(c))
      const refusedReconcile = await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId }).catch((e) => e)
      t.eq(`${kind} owner: reconcileIntegration refuses RUN_LOCKED`, [refusedReconcile?.code, refusedReconcile?.retryable, refusedReconcile?.status], ['RUN_LOCKED', true, 409])
      t.eq(`${kind} owner: nothing under the run changed`, await snapshot(runDirOf(c)), beforeReconcile)
      t.eq(`${kind} owner: the lock is still there`, await fs.readFile(lockFile(c), 'utf8'), lockBefore)
      if (c.held) await c.held.release(); else await fs.rm(lockFile(c))
    }

    // A dead owner's lock is taken over: both operations complete, and leave no lock.
    {
      const c = await committedCandidate()
      const cfg = await declared(c)
      await foreignLock(c, 'dead')
      const done = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfg, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit })
      t.eq('dead owner: integrateRun takes the lock over and completes', [done.error, done.integration.phase], [null, 'complete'])
      t.eq('and leaves no lock', await fs.access(lockFile(c)).then(() => true, () => false), false)
      const d = await committedCandidate()
      await publishing(d)
      await foreignLock(d, 'dead')
      const settled = await reconcileIntegration({ issuePath: d.issuePath, runId: d.runId })
      t.eq('dead owner: reconcileIntegration takes the lock over and settles', [settled.reconciled, settled.phase], [true, 'aborted'])
      t.eq('and leaves no lock', await fs.access(lockFile(d)).then(() => true, () => false), false)
    }

    // The normal path holds the run lock while it works.
    {
      const c = await committedCandidate()
      const cfg = await declared(c)
      let seen = null
      const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfg, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit,
        hooks: { beforePublish: async () => { seen = JSON.parse(await fs.readFile(lockFile(c), 'utf8')) } } })
      t.eq('integrated', [result.error, result.integration.phase], [null, 'complete'])
      t.eq('the run lock was held for this run while publishing', [seen?.purpose, seen?.owner?.runId], ['integrate', c.runId])
      t.eq('and released afterwards', await fs.access(lockFile(c)).then(() => true, () => false), false)
      await publishing(c)
      t.eq('reconcileIntegration with the lock free settles', (await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })).reconciled, true)
      t.eq('and leaves no lock', await fs.access(lockFile(c)).then(() => true, () => false), false)
    }

    const refusal = runLocked('busy', { liveness: 'alive' })
    t.eq('runLocked is the retryable refusal', [refusal.status, refusal.code, refusal.retryable], [409, 'RUN_LOCKED', true])
    // The route's own guard: still first, before the issue is read and outside the serialiser, and classified.
    const index = await fs.readFile(path.join(path.dirname(new URL(import.meta.url).pathname), '../server/index.js'), 'utf8')
    const start = index.indexOf("app.post('/api/projects/:project/issues/:id/runs/:runId/integrate'")
    const route = index.slice(start, index.indexOf('app.', start + 10))
    const guard = route.indexOf('if (supervisor.isActive(project, id)) throw runLocked(')
    t.ok('the integrate route refuses an active run with runLocked', guard > 0)
    t.ok('before it reads the issue or queues the integration', guard < route.indexOf('unpackedIssue(') && guard < route.indexOf('integrateRun('))
  }

  t.section('7. journal damage observed under the lock is kept; a sweep that finds the lock held observes none')
  {
    // (a) A publication with a torn tail while another owner holds the lock.
    const c = await committedCandidate()
    await publishing(c)
    await tornTail(c)
    await foreignLock(c, 'unknown')
    const before = await snapshot(runDirOf(c))
    const swept = await sweepPendingIntegration({ issuePath: c.issuePath, runId: c.runId })
    t.eq('(a) the sweep leaves the run alone', [swept.held, swept.settled?.refused?.code], [true, 'RUN_LOCKED'])
    t.eq('(a) the journal was not inspected: no recovery finding', await fs.access(path.join(runDirOf(c), 'journal-recovery.json')).then(() => true, () => false), false)
    t.eq('(a) nothing under the run changed', await snapshot(runDirOf(c)), before)
    t.eq('(a) the branch is unchanged', await mainHead(c), c.ws.baseCommit)
    await trimTail(c)
    await fs.rm(lockFile(c))
    // Damage is first observed later, under the lock; this tail was never observed, so nothing records it.
    t.eq('(a) a tail trimmed before anyone observed it is not seen later either', (await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })).phase, 'aborted')

    // (b) The same with the lock free: damage observed under the lock is kept.
    const d = await committedCandidate()
    const cfg = await declared(d)
    await publishing(d)
    await tornTail(d)
    const sweptFree = await sweepPendingIntegration({ issuePath: d.issuePath, runId: d.runId }).catch((e) => e)
    t.eq('(b) reconciliation under the lock meets the damage', sweptFree?.code ?? sweptFree?.settled?.refused?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.ok('(b) and records it', await fs.access(path.join(runDirOf(d), 'journal-recovery.json')).then(() => true, () => false))
    await trimTail(d)
    t.eq('(b) after the trim reconciliation is still refused', (await reconcileIntegration({ issuePath: d.issuePath, runId: d.runId }).catch((e) => e))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    const raw = JSON.parse(await fs.readFile(path.join(runDirOf(d), 'run.json'), 'utf8'))
    t.eq('(b) the publication is still pending', raw.integration.phase, 'publishing')
    const again = await integrateRun({ issuePath: d.issuePath, runId: d.runId, project: 'p', projectPath: d.projectPath, configRoot: cfg, expectedRevision: d.fp.fingerprint, targetBranch: 'main', expectedTargetHead: d.ws.baseCommit }).catch((e) => e)
    t.eq('(b) integration is refused', again?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('(b) the branch is unchanged', await mainHead(d), d.ws.baseCommit)
    t.ok('(b) integrate is not offered', !supportedActions(await store.readRun(d.issuePath, d.runId)).includes('integrate'))

    // (c) A delivered run with nothing pending: the sweep records damage as before.
    const e = await committedCandidate()
    const cfgE = await declared(e)
    await tornTail(e)
    const plain = await sweepPendingIntegration({ issuePath: e.issuePath, runId: e.runId })
    t.eq('(c) no publication pending: read as every reader reads it', [plain.held, plain.settled, plain.run.recovery.required], [false, null, true])
    t.ok('(c) the finding is recorded', await fs.access(path.join(runDirOf(e), 'journal-recovery.json')).then(() => true, () => false))
    await trimTail(e)
    t.eq('(c) after the trim integration stays refused', (await integrateRun({ issuePath: e.issuePath, runId: e.runId, project: 'p', projectPath: e.projectPath, configRoot: cfgE, expectedRevision: e.fp.fingerprint, targetBranch: 'main', expectedTargetHead: e.ws.baseCommit }).catch((x) => x))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('(c) and recovery is still required', (await store.readRun(e.issuePath, e.runId)).recovery.required, true)
  }

  await cleanupFixtures()
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}
