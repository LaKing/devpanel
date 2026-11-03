import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createPathOverlap, pathsInText } from '../server/runtime/path-overlap.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { getRun } from '../server/runs-api.mjs'
import { summarisePreview, summariseRun } from '../server/supervisor-summary.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'path overlap — a candidate\'s expected files against other live runs'

const P = 'devpanel-project'
const NL = String.fromCharCode(10)
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')
const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args])).stdout
const head = async (cwd) => (await git(cwd, 'rev-parse', 'HEAD')).trim()
const section = (file) => `diff --git a/${file} b/${file}${NL}--- a/${file}${NL}+++ b/${file}${NL}`
const FINGERPRINT = `sha256:${'a'.repeat(64)}`
const pathsOf = (entry) => entry.files.map((f) => f.path).sort()

// framework-project owns the shared files; app-project and other-project link to them, the way an
// application's @…-modules collections link into its framework.
async function projects () {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'path-overlap-')))
  const dir = (id) => path.join(root, id)
  const framework = dir('framework-project')
  await fs.mkdir(path.join(framework, '@shared', 'mod'), { recursive: true })
  await fs.writeFile(path.join(framework, '@shared', 'mod', 'a.mjs'), 'export const a = 1\n')
  await fs.writeFile(path.join(framework, '@shared', 'mod', 'b.mjs'), 'export const b = 1\n')
  await fs.writeFile(path.join(framework, 'changelog.txt'), 'one\n')
  await fs.writeFile(path.join(framework, 'own.mjs'), 'export const own = 1\n')
  await git(root, 'init', '-q', framework)
  await git(framework, 'add', '.')
  await git(framework, 'commit', '-qm', 'init')
  for (const id of ['app-project', 'other-project']) {
    await fs.mkdir(dir(id))
    await fs.writeFile(path.join(dir(id), 'app.mjs'), 'export const app = 1\n')
    await fs.symlink('../framework-project/@shared', path.join(dir(id), '@shared'))
    await fs.symlink('../framework-project/changelog.txt', path.join(dir(id), 'changelog.txt'))
    await git(root, 'init', '-q', dir(id))
    await git(dir(id), 'add', '.')
    await git(dir(id), 'commit', '-qm', 'init')
  }
  return { root, framework, app: dir('app-project'), other: dir('other-project') }
}

/** A run on disk, as the store reads it. */
async function writeRun (issuePath, runId, record, { plan = null } = {}) {
  const dir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(path.join(dir, 'outputs'), { recursive: true })
  const steps = plan ? [{ number: '004', slug: 'plan', stepId: 'plan', role: 'planner', phase: 'plan-review', round: 0 }] : []
  if (plan) {
    await fs.mkdir(path.join(issuePath, '004-plan'), { recursive: true })
    await fs.writeFile(path.join(issuePath, '004-plan', 'response.md'), plan)
    await fs.writeFile(path.join(dir, 'outputs', '004.json'), JSON.stringify({ valid: true, contract: 'authorArtifact', output: { summary: 'the plan' } }))
  }
  await fs.writeFile(path.join(dir, 'resolved-playbook.json'), JSON.stringify({ reviewPolicy: {}, completion: { delivery: { action: record.deliveryAction ?? 'apply-to-source' } }, workspace: {} }))
  const { deliveryAction, ...run } = record
  // Every run has a journal from its first moment (store.initRun), empty until its first event;
  // without one a reading records a recovery finding and admission refuses the issue's next run.
  await fs.writeFile(path.join(dir, 'events.jsonl'), '')
  await fs.writeFile(path.join(dir, 'run.json'),JSON.stringify({ runId, issue: {}, playbook: { id: 'plan-and-implement', strategy: 'plan-and-implement' }, participants: {}, budgets: { limits: {}, used: {} }, status: 'completed', startedAt: '2026-11-01T00:00:00.000Z', steps, revisions: [], approvals: [], checkResults: [], ...run }))
  return dir
}

const RUN = (n) => `2026-11-01T00-00-00-000Z-0000000${n}`
let issueCount = 0
const issueDir = async (root, project) => {
  const dir = path.join(root, 'issues', project, `issue-${++issueCount}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// An earlier run of the candidate's issue that delivered this patch.
async function deliveredIssue (root, project, files) {
  const issuePath = await issueDir(root, project)
  const dir = await writeRun(issuePath, RUN(1), { revisions: [{ fingerprint: FINGERPRINT }], delivery: { artifactRef: 'artifacts/delivered.patch' }, workspace: { state: 'removed' } })
  await fs.mkdir(path.join(dir, 'artifacts'))
  await fs.writeFile(path.join(dir, 'artifacts', 'delivered.patch'), files.map(section).join(''))
  return issuePath
}

/** A live row of `project`, its run in a real worktree of `checkout`, after `change` edits that worktree. */
async function liveRow (root, project, checkout, change, { plan = null, workspace = {}, deliveryAction, status = 'running' } = {}) {
  const issuePath = await issueDir(root, project)
  const worktree = path.join(root, `wt-${++issueCount}`)
  await git(checkout, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
  await change?.(worktree)
  await writeRun(issuePath, RUN(2), { status, workspace: { path: worktree, baseCommit: await head(checkout), gitDir: null, state: 'active', ...workspace }, deliveryAction }, { plan })
  return { id: path.basename(issuePath), path: issuePath, latestRun: { runId: RUN(2), live: true, status } }
}

const editOwnerFiles = async (worktree) => {
  await fs.writeFile(path.join(worktree, '@shared', 'mod', 'a.mjs'), 'export const a = 2\n')
  await fs.writeFile(path.join(worktree, 'changelog.txt'), 'two\n')
  await fs.writeFile(path.join(worktree, '@shared', 'new.mjs'), 'export const fresh = 1\n')
}

/** Every file under a tree, with size and mtime. Git's own directories are left out. */
async function tree (root, prefix = '') {
  const out = {}
  for (const e of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (e.name === '.git') continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) Object.assign(out, await tree(root, rel))
    else { const st = await fs.lstat(path.join(root, rel)); out[rel] = `${st.size}:${st.mtimeMs}` }
  }
  return out
}

export default async function (t) {
  const s = await projects()
  const { root, framework, app, other } = s
  const LIST = [{ id: 'app-project', path: app }, { id: 'framework-project', path: framework }, { id: 'other-project', path: other }]
  const inspector = (rows) => createPathOverlap({ listProjects: async () => LIST, listIssues: async (id) => rows[id] ?? [] })
  const projectsBefore = process.env.DEVPANEL_PROJECTS_DIR
  const controlBefore = process.env.DEVPANEL_FAKE_CONTROL

  try {
    const ownerLive = await liveRow(root, 'framework-project', framework, editOwnerFiles)
    const withOwner = inspector({ 'framework-project': [ownerLive] })
    const candidate = await deliveredIssue(root, 'app-project', ['app.mjs', '@shared/mod/a.mjs', 'changelog.txt'])
    const readApp = (reader, issuePath = candidate) => (args = {}) => reader({ project: 'app-project', projectPath: app, issuePath, ...args })

    t.section('readiness: two related projects, the owner has a live run touching the same files')
    {
      const reading = await launchReadiness({ project: 'app-project', issueId: 'i', projectPath: app, inspect: async () => null, pathOverlap: readApp(withOwner) })
      const report = reading.pathOverlap
      t.eq('it reports the overlap', report.state, 'overlap', report.detail)
      t.eq('from the previous revision', [report.expected.known, report.expected.source, report.expected.fromRun], [true, 'previous-revision', RUN(1)])
      t.eq('one entry, naming the project', [report.overlaps.length, report.overlaps[0].project, report.overlaps[0].ownerProject, report.overlaps[0].relation], [1, 'framework-project', 'framework-project', 'owner-live'])
      t.eq('and those files, through a directory link and a file link; the unshared one is not among them', pathsOf(report.overlaps[0]), ['@shared/mod/a.mjs', 'changelog.txt'])
      t.eq('each at its real destination', report.overlaps[0].files.map((f) => f.destination).sort(), [path.join(framework, '@shared/mod/a.mjs'), path.join(framework, 'changelog.txt')])
      t.eq('read from the worktree', report.overlaps[0].files[0].via, ['worktree'])
      t.ok('the words name them too', /framework-project/.test(report.detail) && /changelog\.txt/.test(report.detail), report.detail)
      t.eq('it is not a prerequisite', [reading.baselineReady, reading.prerequisites], [true, []])
      const without = await launchReadiness({ project: 'app-project', projectPath: app, inspect: async () => null })
      t.ok('without a reader the field is absent', !('pathOverlap' in without))
    }

    t.section('preview: the same report, as information; nothing is written')
    {
      const f = await engineFixture()
      const issue = { name: 'x', openedOn: '2026-11-01', path: candidate, project: 'app-project' }
      const ref = { id: P, path: f.projectPath }
      const before = await tree(root)
      const shown = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, issue, project: ref, pathOverlap: readApp(withOwner) })
      t.eq('nothing was written', await tree(root), before)
      const plain = await previewRun({ playbookId: 'implementation', configRoot: f.configRoot, issue, project: ref })
      t.ok('without a reader it reads configuration alone', !('pathOverlap' in plain) && !plain.prerequisites.some((x) => x.kind === 'path-overlap'))
      t.eq('it names the project and the files', [shown.pathOverlap.state, shown.pathOverlap.overlaps[0].project, pathsOf(shown.pathOverlap.overlaps[0])], ['overlap', 'framework-project', ['@shared/mod/a.mjs', 'changelog.txt']])
      const notice = shown.prerequisites.find((x) => x.kind === 'path-overlap')
      t.eq('as an information prerequisite that warns', [notice?.category, notice?.status], ['information', 'warning'])
      t.ok('in words', /changelog\.txt/.test(notice?.detail ?? ''), notice?.detail)
      t.eq('it leaves readiness to start as it was', shown.configurationReady, plain.configurationReady)
      t.eq('the supervisor\'s summary keeps it', summarisePreview(shown).pathOverlap.overlaps[0].project, 'framework-project')
      t.ok('a configuration that delivers nothing has nothing to report', (await previewRun({ playbookId: 'analysis', configRoot: f.configRoot, issue, project: ref, pathOverlap: readApp(withOwner) })).pathOverlap?.state === 'not-applicable')
    }

    t.section('expected paths: from each source, and unknown without one')
    {
      // A retained worktree of the earlier run: its copy of the linked file is a real file there.
      const retained = await issueDir(root, 'app-project')
      const worktree = path.join(root, 'wt-retained')
      await git(app, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
      await fs.rm(path.join(worktree, 'changelog.txt'))
      await fs.writeFile(path.join(worktree, 'changelog.txt'), 'candidate\n')
      await writeRun(retained, RUN(1), { status: 'blocked', revisions: [{ fingerprint: FINGERPRINT }], workspace: { path: worktree, baseCommit: await head(app), gitDir: null, state: 'retained' } })
      const fromWorktree = await readApp(withOwner, retained)()
      t.eq('a retained worktree', [fromWorktree.expected.source, pathsOf(fromWorktree.overlaps[0])], ['previous-revision', ['changelog.txt']])

      // Only a check's patch is left.
      const checked = await issueDir(root, 'app-project')
      const dir = await writeRun(checked, RUN(1), { status: 'blocked', revisions: [{ fingerprint: FINGERPRINT }], checkResults: [{ dir: 'checks/1', revision: FINGERPRINT }], workspace: { state: 'removed' } })
      await fs.mkdir(path.join(dir, 'checks', '1', 'artifacts'), { recursive: true })
      await fs.writeFile(path.join(dir, 'checks', '1', 'artifacts', `${'a'.repeat(16)}.patch`), section('@shared/mod/a.mjs'))
      const fromCheck = await readApp(withOwner, checked)()
      t.eq('a check\'s patch', [fromCheck.expected.source, pathsOf(fromCheck.overlaps[0])], ['previous-revision', ['@shared/mod/a.mjs']])

      // Only a plan: the full text of its step folder, in prose.
      const planned = await issueDir(root, 'app-project')
      await writeRun(planned, RUN(1), { workspace: { state: 'removed' } }, { plan: 'Change `@shared/mod/a.mjs:12` then note it in changelog.txt. See https://example.test/x.mjs and ../secret.txt.' })
      const fromPlan = await readApp(withOwner, planned)()
      t.eq('a plan', [fromPlan.state, fromPlan.expected.source, pathsOf(fromPlan.overlaps[0])], ['overlap', 'plan', ['@shared/mod/a.mjs', 'changelog.txt']])
      // An absolute path through the candidate's own link is the same file (auditor-1-001).
      const absolute = await issueDir(root, 'app-project')
      await writeRun(absolute, RUN(1), { workspace: { state: 'removed' } }, { plan: `Change ${path.join(app, 'changelog.txt')}.` })
      const fromAbsolute = await readApp(withOwner, absolute)()
      t.eq('an absolute plan path through a link', [fromAbsolute.state, fromAbsolute.overlaps[0]?.project, fromAbsolute.overlaps[0]?.files[0].destination], ['overlap', 'framework-project', path.join(framework, 'changelog.txt')])
      const outside = await issueDir(root, 'app-project')
      const stranger = path.join(root, 'unlisted', 'changelog.txt')
      await fs.mkdir(path.dirname(stranger))
      await fs.symlink(path.join(framework, 'changelog.txt'), stranger)
      await writeRun(outside, RUN(1), { workspace: { state: 'removed' } }, { plan: `Change ${stranger}.` })
      t.eq('one outside every listed project is not followed', (await readApp(withOwner, outside)()).state, 'none')

      // A match past where the reading used to stop (auditor-1-002).
      const filler = Array.from({ length: 5000 }, (_, i) => `x/f${i}.mjs`).join(' ')
      const long = await issueDir(root, 'app-project')
      await writeRun(long, RUN(1), { workspace: { state: 'removed' } }, { plan: `${filler} changelog.txt` })
      const fromLong = await readApp(withOwner, long)()
      t.eq('a match after 5000 other paths is found', [fromLong.state, fromLong.expected.count, pathsOf(fromLong.overlaps[0] ?? { files: [] })], ['overlap', 5001, ['changelog.txt']])
      const liveLong = await liveRow(root, 'framework-project', framework, null, { plan: `${filler} @shared/mod/a.mjs` })
      const onLive = await inspector({ 'framework-project': [liveLong] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('and on the live run\'s side', [onLive.state, pathsOf(onLive.overlaps[0] ?? { files: [] })], ['overlap', ['@shared/mod/a.mjs']])

      // A bound that remains is named, and is not an all-clear.
      const tooLarge = await issueDir(root, 'app-project')
      const bigDir = await writeRun(tooLarge, RUN(1), { revisions: [{ fingerprint: FINGERPRINT }], delivery: { artifactRef: 'artifacts/delivered.patch' }, workspace: { state: 'removed' } }, { plan: 'Change app.mjs only.' })
      await fs.mkdir(path.join(bigDir, 'artifacts'))
      await fs.writeFile(path.join(bigDir, 'artifacts', 'delivered.patch'), '')
      await fs.truncate(path.join(bigDir, 'artifacts', 'delivered.patch'), 65 * 1024 * 1024)
      const incomplete = await readApp(withOwner, tooLarge)()
      t.eq('a patch too large to read leaves the reading unknown, though the plan matched nothing', [incomplete.state, incomplete.expected.source, incomplete.overlaps], ['unknown', 'plan', []])
      t.ok('and says so', /too large/.test(incomplete.expected.incomplete[0] ?? '') && /too large/.test(incomplete.detail), incomplete.detail)

      t.eq('tokens drop line numbers, URLs and climbing paths', pathsInText('`a/b.mjs:12` c.txt. https://x.test/y.mjs ../z.txt word'), ['a/b.mjs', 'c.txt'])

      // Nothing recorded: never read as no overlap.
      const first = await issueDir(root, 'app-project')
      const unknown = await readApp(withOwner, first)()
      t.eq('a first run is unknown', [unknown.state, unknown.expected.known, unknown.overlaps], ['unknown', false, []])
      t.ok('and says it is not an all-clear', /not an all-clear/.test(unknown.detail), unknown.detail)
      t.eq('naming what its links reach', [unknown.possible[0].project, unknown.possible[0].relation], ['framework-project', 'owner-live'])
      t.ok('those files', ['@shared/mod/a.mjs', 'changelog.txt', '@shared/new.mjs'].every((p) => pathsOf(unknown.possible[0]).includes(p)), JSON.stringify(unknown.possible[0].files))
      const unnamed = await withOwner({ project: 'app-project', projectPath: app })
      t.eq('so is a reading with no issue', unnamed.state, 'unknown')
      const quiet = await inspector({})({ project: 'app-project', projectPath: app, issuePath: first })
      t.eq('with no live run elsewhere there is nothing to overlap', [quiet.state, quiet.expected.known], ['none', false])
    }

    t.section('a live run: what it reads, and what it does not count')
    {
      const clean = await liveRow(root, 'framework-project', framework, null, { plan: 'Next I change @shared/mod/a.mjs.' })
      const planOnly = await inspector({ 'framework-project': [clean] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('its plan counts while its worktree is empty', [planOnly.state, pathsOf(planOnly.overlaps[0]), planOnly.overlaps[0].files[0].via], ['overlap', ['@shared/mod/a.mjs'], ['plan']])

      const pendingPath = await issueDir(root, 'framework-project')
      await writeRun(pendingPath, RUN(3), { status: 'preflighting', workspace: { isolation: null, path: null, state: 'pending' } })
      const pending = { id: path.basename(pendingPath), path: pendingPath, latestRun: { runId: RUN(3), live: true, status: 'preflighting' } }
      const notYet = await inspector({ 'framework-project': [pending] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('one with no workspace is not compared, and that is not none', [notYet.state, notYet.uncompared[0].project, notYet.uncompared[0].runId], ['unknown', 'framework-project', RUN(3)])

      const idle = await liveRow(root, 'framework-project', framework, null)
      const blank = await inspector({ 'framework-project': [idle] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('nor is one that has neither changed nor planned anything', [blank.state, blank.uncompared.length], ['unknown', 1])

      const elsewhere = await liveRow(root, 'framework-project', framework, (w) => fs.writeFile(path.join(w, '@shared', 'mod', 'b.mjs'), 'export const b = 2\n'))
      const apart = await inspector({ 'framework-project': [elsewhere] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('different files are no overlap', [apart.state, apart.overlaps, apart.uncompared], ['none', [], []])

      const ended = { ...ownerLive, latestRun: { ...ownerLive.latestRun, live: false, status: 'completed' } }
      t.eq('an ended run does not count', (await inspector({ 'framework-project': [ended] })({ project: 'app-project', projectPath: app, issuePath: candidate })).state, 'none')

      const analysis = await liveRow(root, 'framework-project', framework, editOwnerFiles, { deliveryAction: 'none' })
      t.eq('nor one that delivers nothing', (await inspector({ 'framework-project': [analysis] })({ project: 'app-project', projectPath: app, issuePath: candidate })).state, 'none')

      const own = await liveRow(root, 'app-project', app, (w) => fs.writeFile(path.join(w, 'app.mjs'), 'export const app = 2\n'))
      t.eq('another issue of the candidate\'s own project does: it may run beside it', (await inspector({ 'app-project': [own] })({ project: 'app-project', projectPath: app, issuePath: candidate })).state, 'overlap')

      t.eq('a configuration that delivers nothing is not applicable', (await withOwner({ project: 'app-project', projectPath: app, issuePath: candidate, deliveryAction: 'none' })).state, 'not-applicable')
      const broken = createPathOverlap({ listProjects: async () => { throw new Error('no listing') }, listIssues: async () => [] })
      const failed = await broken({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('a failure is unavailable, never thrown', [failed.state, /no listing/.test(failed.detail)], ['unavailable', true])
    }

    t.section('another issue of the same project: its live run counts, its own issue does not')
    {
      const sameProject = await liveRow(root, 'app-project', app, async (worktree) => { await fs.writeFile(path.join(worktree, 'app.mjs'), 'changed by another issue') })
      const reading = await inspector({ 'app-project': [sameProject] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('it overlaps', reading.state, 'overlap', reading.detail)
      t.eq('named as the same project', [reading.overlaps[0].project, reading.overlaps[0].relation], ['app-project', 'same-project'])
      t.eq('on the file they share', pathsOf(reading.overlaps[0]), ['app.mjs'])
      const own = await inspector({ 'app-project': [sameProject] })({ project: 'app-project', projectPath: app, issuePath: sameProject.path })
      t.eq('a candidate is not compared with its own issue\'s run', own.overlaps.length, 0, own.detail)
    }

    t.section('a third project writing into the same owner, and the owner as the candidate')
    {
      // A materialized worktree: the link replaced by a copy, delivered through its recorded binding.
      const materialize = async (worktree) => {
        await fs.rm(path.join(worktree, '@shared'))
        await fs.mkdir(path.join(worktree, '@shared', 'mod'), { recursive: true })
        await fs.writeFile(path.join(worktree, '@shared', 'mod', 'a.mjs'), 'export const a = 3\n')
      }
      const binding = { symlinks: { materialized: ['@shared'], owners: [{ path: '@shared', resolved: path.join(framework, '@shared'), directory: true }] } }
      const third = await liveRow(root, 'other-project', other, materialize, { workspace: binding })
      const coWriter = await inspector({ 'other-project': [third] })({ project: 'app-project', projectPath: app, issuePath: candidate })
      t.eq('it counts, named as a co-writer of the owner', [coWriter.state, coWriter.overlaps[0].project, coWriter.overlaps[0].ownerProject, coWriter.overlaps[0].relation, pathsOf(coWriter.overlaps[0])], ['overlap', 'other-project', 'framework-project', 'co-writer', ['@shared/mod/a.mjs']])

      const ownerIssue = await deliveredIssue(root, 'framework-project', ['@shared/mod/a.mjs', 'own.mjs'])
      const owner = await inspector({ 'other-project': [third] })({ project: 'framework-project', projectPath: framework, issuePath: ownerIssue })
      t.eq('the owner\'s candidate is told who writes into it', [owner.state, owner.overlaps[0].project, owner.overlaps[0].ownerProject, owner.overlaps[0].relation], ['overlap', 'other-project', 'framework-project', 'candidate-owns'])
    }

    t.section('a start goes ahead, with the warning on its record, for an operator and for the supervisor')
    {
      const f = await engineFixture()
      const projectsDir = path.join(f.issuesDir, 'projects')
      await fs.mkdir(projectsDir, { recursive: true })
      await fs.symlink(f.projectPath, path.join(projectsDir, P)).catch(() => {})
      const stateDir = await fs.mkdtemp(path.join(root, 'control-'))
      const control = path.join(stateDir, 'control.json')
      await fs.writeFile(control, JSON.stringify({ ledger: path.join(stateDir, 'ledger.jsonl'), delayMs: 0 }))
      process.env.DEVPANEL_FAKE_CONTROL = control
      await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(HARNESS_MODULE)}` + NL)
      process.env.DEVPANEL_PROJECTS_DIR = projectsDir
      const issues = {
        ...f.issues,
        listProjects: async () => [{ id: P, path: f.projectPath }, { id: 'framework-project', path: framework }],
        listIssues: async (id, options) => id === 'framework-project' ? [ownerLive] : f.issues.listIssues(id, options)
      }
      const supervisor = createSupervisor({ issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
      const FILE = path.join(framework, '@shared/mod/a.mjs')
      const planned = async (name) => {
        const issue = await f.issues.createIssue(P, { name })
        await writeRun(issue.path, RUN(1), { workspace: { state: 'removed' } }, { plan: `Change ${FILE}.` })
        return issue
      }
      const readRecord = async (issue, runId) => JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))

      const byOperator = await planned('Operator start')
      const started = await supervisor.start({ project: P, issueId: byOperator.id, playbookId: f.playbookId, configRoot: f.configRoot })
      t.ok('an operator start is not refused', Boolean(started.runId))
      t.eq('its response names the overlap', [started.startOverlap?.state, started.startOverlap?.by, started.startOverlap?.overlaps[0].project, started.startOverlap?.overlaps[0].files[0].destination], ['overlap', 'operator', 'framework-project', FILE])
      await supervisor.settle()
      const operatorRun = await readRecord(byOperator, started.runId)
      t.eq('and its run keeps it to the end', [operatorRun.startOverlap?.state, operatorRun.startOverlap?.by], ['overlap', 'operator'], operatorRun.status)

      const bySupervisor = await planned('Supervisor start')
      const launched = await supervisor.start({ project: P, issueId: bySupervisor.id, playbookId: f.playbookId, configRoot: f.configRoot, supervisorLaunchId: 'launch-1' })
      t.ok('a supervisor start goes ahead', Boolean(launched.runId))
      await supervisor.settle()
      const supervisorRun = await readRecord(bySupervisor, launched.runId)
      t.eq('with the warning recorded on the run', [supervisorRun.startOverlap?.state, supervisorRun.startOverlap?.by, supervisorRun.startOverlap?.overlaps[0].project], ['overlap', 'supervisor', 'framework-project'])
      const detail = await getRun(bySupervisor.path, launched.runId, { issues: f.issues, project: P, issueId: bySupervisor.id, isActive: false })
      t.eq('and its summary shows it', summariseRun(detail).startOverlap?.overlaps[0].project, 'framework-project')

      const plain = await f.issues.createIssue(P, { name: 'No warning to carry' })
      const quiet = createSupervisor({ issues: { ...issues, listIssues: async (id, options) => id === 'framework-project' ? [] : f.issues.listIssues(id, options) }, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
      const nothing = await quiet.start({ project: P, issueId: plain.id, playbookId: f.playbookId, configRoot: f.configRoot })
      await quiet.settle()
      t.ok('with no live run elsewhere nothing is recorded', !('startOverlap' in nothing) && !('startOverlap' in await readRecord(plain, nothing.runId)))
    }

    t.section('the supervisor is shown it at preview, and start_run returns it through the start gate')
    {
      const report = { state: 'overlap', overlaps: [{ project: 'framework-project', files: [{ path: 'changelog.txt' }] }], by: 'supervisor' }
      const runs = new Map()
      const tools = {
        projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [],
        preview: async () => ({ ok: true, configHash: 'config', pathOverlap: report }),
        start: async () => { const run = { runId: 'r1', status: 'completed', startOverlap: report }; runs.set(run.runId, run); return run },
        getRun: async (_p, _i, id) => runs.get(id), stop: async () => {}
      }
      const actions = [() => ({ type: 'preview', project: 'p', issueId: 'issue', playbook: 'test' }), (e) => ({ type: 'start_run', project: 'p', issueId: 'issue', previewId: e.result.previewId })]
      const events = []
      const adapter = { invoke: async (a) => { const { event } = JSON.parse(a.prompt); events.push(event); return { session: a.session ?? { id: 'session' }, response: JSON.stringify({ message: 'action', action: actions.shift()?.(event) ?? null }), usage: { costUsd: 0 } } } }
      const service = await createTopSupervisor({ dir: path.join(root, 'top'), models: async () => [{ id: 'm', model: 'wire', verification: { status: 'verified' } }], tools, adapter, pollMs: 10000 })
      await service.start({ model: 'm', projects: ['p'], message: 'one launch', limits: { maxRuns: 4, maxStartsPerIssue: 2, maxCalls: 20, maxConcurrent: 2 } })
      const until = Date.now() + 5000
      while (!(service.get().calls >= 3 && !service.get().pending)) {
        if (Date.now() > until) throw new Error('Timed out waiting for the supervisor')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await service.shutdown()
      t.eq('preview carries it', events[1]?.result?.pathOverlap?.state, 'overlap')
      t.eq('start_run returns it', events[2]?.result?.startOverlap?.overlaps[0].project, 'framework-project', JSON.stringify(events[2]?.result))
    }
  } finally {
    if (projectsBefore == null) delete process.env.DEVPANEL_PROJECTS_DIR
    else process.env.DEVPANEL_PROJECTS_DIR = projectsBefore
    if (controlBefore == null) delete process.env.DEVPANEL_FAKE_CONTROL
    else process.env.DEVPANEL_FAKE_CONTROL = controlBefore
    await cleanupFixtures()
    await fs.rm(root, { recursive: true, force: true })
  }
}
