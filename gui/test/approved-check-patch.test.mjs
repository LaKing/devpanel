import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { approvedCheckPatch, applyRunArtifact, retainedPatch } from '../server/runtime/apply-artifact.mjs'
import { baselineOf, fingerprint, FINGERPRINT_RULE, LEGACY_FINGERPRINT_RULE } from '../server/runtime/fingerprint.mjs'
import { worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { writeBaseline } from '../server/runtime/store.mjs'
import { writeRunResultStep } from '../server/run-result-step.mjs'
import { startStage } from './browser/stage.mjs'

export const name = 'approved check patch — a run that never reached delivery still hands over its approved patch'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' })
const rejection = (promise) => promise.then(() => null, (error) => error)
const LIMIT = 10 * 1024 * 1024

/**
 * A real base, candidate and check artifact, as a check leaves them; then the
 * candidate worktree is removed, as it may be by the time anyone asks.
 */
async function candidate (projectPath, { rule = FINGERPRINT_RULE, large = false } = {}) {
  const baseCommit = git(projectPath, 'rev-parse', 'HEAD').trim()
  const baseline = await baselineOf(projectPath)
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'approved-candidate-'))
  git(projectPath, 'worktree', 'add', '--detach', '--quiet', workspacePath, baseCommit)
  await fs.writeFile(path.join(workspacePath, 'source.txt'), 'changed\n')
  await fs.writeFile(path.join(workspacePath, 'added.txt'), 'added\n')
  if (large) await fs.writeFile(path.join(workspacePath, 'large.txt'), 'a line of the large file\n'.repeat(500000))
  const fp = await fingerprint(workspacePath, { baseCommit, baseline, rule })
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'approved-check-'))
  await fs.mkdir(path.join(scratch, 'artifacts'))
  const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: fp.fingerprint, fingerprint: fp, baseCommit, baseline, workspacePath, runDir: scratch })
  const patch = await fs.readFile(path.join(scratch, receipt.artifactRef))
  git(projectPath, 'worktree', 'remove', '--force', workspacePath)
  await fs.rm(scratch, { recursive: true, force: true })
  return { baseCommit, baseline, revision: fp.fingerprint, patch, patchName: `${fp.fingerprint.replace('sha256:', '').slice(0, 16)}.patch` }
}

/** The record of a run blocked by its checks, delivery never attempted, as d250's run was. */
async function writeRun (issuePath, runId, c, overrides = {}, { checkDirs = ['004'] } = {}) {
  const runDir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  for (const n of checkDirs) {
    await fs.mkdir(path.join(runDir, 'checks', n, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'checks', n, 'artifacts', c.patchName), c.patch)
  }
  const run = {
    runId, status: 'blocked', outcome: 'unresolved', blockedReason: 'refreshed-checks-failed', playbook: { id: 'implementation' }, steps: [],
    startedAt: '2026-11-01T10:00:00.000Z', endedAt: '2026-11-01T11:00:00.000Z', budgets: { used: {} },
    participants: { coordinator: {}, implementer: {}, 'auditor-1': {} },
    workspace: { baseCommit: c.baseCommit, state: 'removed', gitDir: '/nonexistent/engine' },
    revisions: [{ fingerprint: c.revision, rule: FINGERPRINT_RULE }],
    approvals: [{ role: 'auditor-1', revision: c.revision, step: '005' }],
    checkResults: [],
    checkHistory: checkDirs.map((n) => ({ revision: c.revision, result: 'failed', dir: `checks/${n}` })),
    ...overrides
  }
  await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(run))
  await fs.writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ at: run.startedAt, type: 'started' }) + '\n')
  await writeBaseline(issuePath, runId, c.baseline)
  return runDir
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'approved-check-patch-'))
  const projectPath = path.join(root, 'project')
  await fs.mkdir(projectPath)
  git(root, 'init', '-q', projectPath)
  await fs.writeFile(path.join(projectPath, 'source.txt'), 'original\n')
  git(projectPath, 'add', '.')
  git(projectPath, 'commit', '-qm', 'base')
  const issuePath = path.join(root, 'issue')
  await fs.mkdir(issuePath)
  const c = await candidate(projectPath)
  const ask = (runId, extra = {}) => approvedCheckPatch({ issuePath, runId, projectPath, ...extra })

  try {
    t.section('a checks-blocked run with an approved revision and no delivery')
    let runDir = await writeRun(issuePath, 'blocked', c)
    const served = await ask('blocked')
    t.eq('its check artifact is the patch', await fs.readFile(served.file), c.patch)
    t.eq('from the check directory', path.relative(await fs.realpath(runDir), served.file), path.join('checks', '004', 'artifacts', c.patchName))
    t.eq('labelled as the approved revision\'s check artifact', [served.kind, served.revision], ['approved-revision-check-artifact', c.revision])
    t.ok('and named so', served.filename.endsWith('.approved-check-artifact.patch'), served.filename)
    t.eq('the project keeps no registration of the rebuild', git(projectPath, 'worktree', 'list').trim().split('\n').length, 1)
    for (const status of ['completed', 'failed', 'cancelled']) {
      await writeRun(issuePath, `settled-${status}`, c, { status })
      t.ok(`a ${status} run is settled too`, Boolean(await ask(`settled-${status}`)))
    }

    t.section('the shared readers are not widened')
    t.eq('retainedPatch still has none', (await rejection(retainedPatch(issuePath, 'blocked')))?.message, 'This run has no retained patch')
    t.eq('and application is refused', (await rejection(applyRunArtifact({ issuePath, runId: 'blocked', projectPath, expectedRevision: c.revision })))?.message, 'This run has no retained patch')

    t.section('which artifact: the current approved revision, newest check first')
    await writeRun(issuePath, 'refreshed', c, {}, { checkDirs: ['002', '004', '007'] })
    t.ok('a later refresh answers first', (await ask('refreshed')).file.includes(path.join('checks', '007')))
    await writeRun(issuePath, 'moved-on', c, { revisions: [{ fingerprint: 'sha256:0000000000000000' }, { fingerprint: c.revision, rule: FINGERPRINT_RULE }],
      checkHistory: [{ revision: c.revision, result: 'failed', dir: 'checks/004' }, { revision: 'sha256:0000000000000000', result: 'failed', dir: 'checks/005' }] })
    t.ok('an older revision\'s later entry is not read', (await ask('moved-on')).file.includes(path.join('checks', '004')))
    await writeRun(issuePath, 'only-in-results', c, { checkHistory: undefined, checkResults: [{ revision: c.revision, result: 'failed', dir: 'checks/004' }] })
    t.ok('a record with only checkResults is found', Boolean(await ask('only-in-results')))
    await writeRun(issuePath, 'migrated', { ...c, patchName: `${'sha256:aaaaaaaaaaaaaaaa'.slice(7)}.patch` }, { revisions: [{ fingerprint: 'sha256:aaaaaaaaaaaaaaaa' }, { fingerprint: c.revision, rule: FINGERPRINT_RULE, migratedFrom: 'sha256:aaaaaaaaaaaaaaaa' }],
      checkHistory: [{ revision: 'sha256:aaaaaaaaaaaaaaaa', result: 'failed', dir: 'checks/004' }] })
    t.ok('a migrated revision\'s check is found under the name it had', (await ask('migrated'))?.filename.startsWith('aaaaaaaaaaaaaaaa'))

    t.section('fingerprint checked: what cannot be shown to be the revision is not served')
    const refused = 'The approved revision\'s check artifact could not be verified against its fingerprint'
    runDir = await writeRun(issuePath, 'tampered', c)
    const tamperedFile = path.join(runDir, 'checks', '004', 'artifacts', c.patchName)
    await fs.writeFile(tamperedFile, c.patch.toString().replace('+changed', '+tampered'))
    const error = await rejection(ask('tampered'))
    t.eq('different bytes are refused', [error?.message, error?.status], [refused, 409])
    runDir = await writeRun(issuePath, 'excluded-path', c)
    const smuggled = 'diff --git a/node_modules/x.js b/node_modules/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/node_modules/x.js\n@@ -0,0 +1 @@\n+hidden\n'
    await fs.writeFile(path.join(runDir, 'checks', '004', 'artifacts', c.patchName), c.patch.toString() + smuggled)
    t.eq('a path the fingerprint excludes is refused', (await rejection(ask('excluded-path')))?.message, refused)
    runDir = await writeRun(issuePath, 'newest-tampered', c, {}, { checkDirs: ['002', '004'] })
    await fs.writeFile(path.join(runDir, 'checks', '004', 'artifacts', c.patchName), 'garbage\n')
    t.ok('an older check of the same revision still verifies', (await ask('newest-tampered')).file.includes(path.join('checks', '002')))
    await writeRun(issuePath, 'other-fingerprint', { ...c, patchName: 'ffff.patch' }, { revisions: [{ fingerprint: 'sha256:ffff', rule: FINGERPRINT_RULE }], approvals: [{ role: 'auditor-1', revision: 'sha256:ffff' }],
      checkHistory: [{ revision: 'sha256:ffff', result: 'failed', dir: 'checks/004' }] })
    t.eq('an artifact that rebuilds something else is refused', (await rejection(ask('other-fingerprint')))?.message, refused)
    runDir = await writeRun(issuePath, 'no-baseline', c)
    await fs.rm(path.join(runDir, 'baseline.json'))
    t.eq('no recorded baseline, nothing to compare with', (await rejection(ask('no-baseline')))?.message, refused)
    await writeRun(issuePath, 'no-base', c, { workspace: {} })
    t.eq('no recorded base, nothing to rebuild from', (await rejection(ask('no-base')))?.message, refused)
    await writeRun(issuePath, 'no-check', c, { checkHistory: [] })
    t.eq('no check artifact at all', (await rejection(ask('no-check')))?.message, refused)
    runDir = await writeRun(issuePath, 'escaping', c, { checkHistory: [{ revision: c.revision, result: 'failed', dir: 'artifacts' }] })
    await fs.mkdir(path.join(runDir, 'artifacts', 'artifacts'))
    await fs.writeFile(path.join(runDir, 'artifacts', 'artifacts', c.patchName), c.patch)
    t.eq('a record naming a directory outside checks/ is not followed', (await rejection(ask('escaping')))?.message, refused)
    await writeRun(issuePath, 'no-repository', c)
    t.eq('no repository to rebuild in', (await rejection(ask('no-repository', { projectPath: null })))?.message, refused)

    t.section('where it rebuilds, the worktree gone')
    await writeRun(issuePath, 'pinned-source', c, { workspace: { baseCommit: c.baseCommit, state: 'removed', gitDir: '/nonexistent/engine', repository: { kind: 'private', source: path.join(projectPath, '.git') } } })
    t.ok('the recorded source repository holds the snapshot, no project path needed', Boolean(await ask('pinned-source', { projectPath: null })))
    await writeRun(issuePath, 'own-git-dir', c, { workspace: { baseCommit: c.baseCommit, gitDir: path.join(projectPath, '.git') } })
    t.ok('the run\'s own Git directory while it stands', Boolean(await ask('own-git-dir', { projectPath: null })))
    const legacy = await candidate(projectPath, { rule: LEGACY_FINGERPRINT_RULE })
    await writeRun(issuePath, 'legacy-rule', legacy, { revisions: [{ fingerprint: legacy.revision }] })
    t.eq('a revision recorded without a rule reads under the legacy one', (await ask('legacy-rule')).revision, legacy.revision)

    t.section('outside that case nothing changes')
    runDir = await writeRun(issuePath, 'delivered', c, { status: 'completed', delivery: { action: 'worktree-diff', completedAt: 'x', artifactRef: 'artifacts/c.patch' } })
    await fs.writeFile(path.join(runDir, 'artifacts', 'c.patch'), 'the delivered patch\n')
    t.eq('a delivered run is not this case', await ask('delivered'), null)
    t.eq('retainedPatch answers with the delivered artifact', path.basename((await retainedPatch(issuePath, 'delivered')).file), 'c.patch')
    await writeRun(issuePath, 'attempted', c, { delivery: { action: 'apply-to-source', error: 'failed', artifactRef: null } })
    t.eq('nor is a run whose delivery was attempted', await ask('attempted'), null)
    const notThisCase = {
      'no-approval': { approvals: [] },
      'stale-approval': { approvals: [{ role: 'auditor-1', revision: 'sha256:older' }] },
      'one-of-two-auditors': { participants: { 'auditor-1': {}, 'auditor-2': {} } },
      'no-revision': { revisions: [], approvals: [] },
      'still-running': { status: 'running' },
      paused: { status: 'paused' },
      quarantined: { integrity: { status: 'quarantined' } },
      abandoned: { integrity: { status: 'abandoned' } }
    }
    for (const [id, overrides] of Object.entries(notThisCase)) {
      await writeRun(issuePath, id, c, overrides)
      t.eq(`${id}: no check artifact`, await ask(id), null)
      t.eq(`${id}: and no retained patch`, (await rejection(retainedPatch(issuePath, id)))?.message, 'This run has no retained patch')
    }
    t.eq('an invalid run id is refused as before', (await rejection(ask('../x')))?.message, 'Invalid run id')

    t.section('the result step carries the same artifact')
    let folder = await writeRunResultStep({ issuePath, runId: 'blocked', projectPath })
    t.eq('as changes.patch', await fs.readFile(path.join(folder, 'changes.patch')), c.patch)
    let text = await fs.readFile(path.join(folder, 'result.md'), 'utf8')
    t.ok('the account still says nothing was delivered', text.includes('Nothing was delivered.'), text)
    t.ok('and says what the file is', text.includes('The approved revision\'s patch is in `changes.patch`') && text.includes('It reached no project.'), text)
    t.ok('without the delivered wording', !text.includes('The change is in `changes.patch`'), text)

    runDir = path.join(issuePath, 'runs', 'blocked')
    const record = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'))
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ ...record, revisions: [...record.revisions, { fingerprint: 'sha256:newer' }] }))
    folder = await writeRunResultStep({ issuePath, runId: 'blocked', projectPath })
    t.eq('a later end with no approved revision removes it', await fs.stat(path.join(folder, 'changes.patch')).catch(() => null), null)
    text = await fs.readFile(path.join(folder, 'result.md'), 'utf8')
    t.ok('and no longer mentions it', !text.includes('changes.patch'), text)

    folder = await writeRunResultStep({ issuePath, runId: 'tampered', projectPath })
    t.eq('an unverifiable artifact is not carried', await fs.stat(path.join(folder, 'changes.patch')).catch(() => null), null)
    t.ok('and not mentioned', !(await fs.readFile(path.join(folder, 'result.md'), 'utf8')).includes('changes.patch'))
    folder = await writeRunResultStep({ issuePath, runId: 'delivered', projectPath })
    t.eq('a delivered run keeps its delivered artifact', await fs.readFile(path.join(folder, 'changes.patch'), 'utf8'), 'the delivered patch\n')
    t.ok('in the delivered wording', (await fs.readFile(path.join(folder, 'result.md'), 'utf8')).includes('The change is in `changes.patch`'))
    folder = await writeRunResultStep({ issuePath, runId: 'no-approval', projectPath })
    t.eq('a run with no approved revision has none', await fs.stat(path.join(folder, 'changes.patch')).catch(() => null), null)

    t.section('the result step limit is the delivered copy\'s, not the approved artifact\'s')
    const large = await candidate(projectPath, { large: true })
    t.ok('the artifact is over the 10 MiB limit', large.patch.length > LIMIT, String(large.patch.length))
    await writeRun(issuePath, 'over-limit', large)
    const servedLarge = await ask('over-limit')
    folder = await writeRunResultStep({ issuePath, runId: 'over-limit', projectPath })
    t.ok('the over-limit artifact is carried, byte for byte what /patch serves', (await fs.readFile(path.join(folder, 'changes.patch'))).equals(await fs.readFile(servedLarge.file)))
    t.ok('and the account says so', (await fs.readFile(path.join(folder, 'result.md'), 'utf8')).includes('The approved revision\'s patch is in `changes.patch`'))
    runDir = await writeRun(issuePath, 'over-limit-delivered', c, { status: 'completed', delivery: { action: 'worktree-diff', completedAt: 'x', artifactRef: 'artifacts/c.patch' } })
    await fs.writeFile(path.join(runDir, 'artifacts', 'c.patch'), Buffer.alloc(LIMIT + 1, 'x'))
    folder = await writeRunResultStep({ issuePath, runId: 'over-limit-delivered', projectPath })
    t.eq('a delivered artifact over the limit is still not copied', await fs.stat(path.join(folder, 'changes.patch')).catch(() => null), null)

    t.section('over HTTP')
    const stage = await startStage()
    try {
      const issue = await stage.createIssue('Approved patch')
      const stagePath = path.join(stage.issuesDir, stage.project, issue.id)
      const project = path.join(stage.projectsDir, stage.project)
      const s = await candidate(project)
      await writeRun(stagePath, 'blocked', s)
      const tampered = await writeRun(stagePath, 'tampered', s)
      await fs.writeFile(path.join(tampered, 'checks', '004', 'artifacts', s.patchName), 'garbage\n')
      await writeRun(stagePath, 'no-approval', s, { approvals: [] })
      const delivered = await writeRun(stagePath, 'delivered', s, { status: 'completed', delivery: { action: 'worktree-diff', completedAt: 'x', artifactRef: 'artifacts/c.patch' } })
      await fs.writeFile(path.join(delivered, 'artifacts', 'c.patch'), 'the delivered patch\n')
      const route = (runId, leaf = 'patch') => fetch(`${stage.origin}/api/projects/${stage.project}/issues/${issue.id}/runs/${runId}/${leaf}`, { headers: { Authorization: `Bearer ${stage.token}` } })

      const ok = await route('blocked')
      t.eq('the approved patch is served', [ok.status, Buffer.from(await ok.arrayBuffer()).equals(s.patch)], [200, true])
      t.eq('its kind is in the response', ok.headers.get('x-devpanel-patch-kind'), 'approved-revision-check-artifact')
      t.eq('and its revision', ok.headers.get('x-devpanel-patch-revision'), s.revision)
      t.ok('and its file name', ok.headers.get('content-disposition')?.includes('.approved-check-artifact.patch'), ok.headers.get('content-disposition'))
      const bad = await route('tampered')
      t.eq('an unverifiable artifact is refused', [bad.status, (await bad.json()).error], [409, refused])
      const none = await route('no-approval')
      t.eq('no approved revision: the old refusal', [none.status, (await none.json()).error], [409, 'This run has no retained patch'])
      const plain = await route('delivered')
      t.eq('a delivered patch as before', [plain.status, await plain.text()], [200, 'the delivered patch\n'])
      t.eq('with no label', [plain.headers.get('x-devpanel-patch-kind'), plain.headers.get('content-disposition')], [null, 'attachment; filename="c.patch"'])
      t.eq('patch-check is not widened', (await route('blocked', 'patch-check')).status, 409)
      const big = await candidate(project, { large: true })
      await writeRun(stagePath, 'over-limit', big)
      const carried = await writeRunResultStep({ issuePath: stagePath, runId: 'over-limit', projectPath: project })
      const download = await route('over-limit')
      t.ok('over the limit, changes.patch holds the bytes the route serves', download.status === 200 && Buffer.from(await download.arrayBuffer()).equals(await fs.readFile(path.join(carried, 'changes.patch'))))
    } finally { await stage.stop() }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
