import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const name = 'archived issues are packed out of the project folder, and restored intact'

const exec = promisify(execFile)
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())
const exists = (p) => fs.access(p).then(() => true, () => false)

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-bundle-'))
  const projects = path.join(root, 'projects')
  const issuesDir = path.join(root, 'issues')
  const project = 'bundle-project'
  const repo = path.join(projects, project)
  await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(issuesDir)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.email', 't@example.invalid')
  await git(repo, 'config', 'user.name', 'test')
  await fs.writeFile(path.join(repo, 'app.txt'), 'one\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'base')
  const base = await git(repo, 'rev-parse', 'HEAD')

  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  process.env.DEVPANEL_PROJECTS_DIR = projects
  const issues = await import(`../server/issues.js?bundle=${Date.now()}`)
  try {
    const opened = await issues.createIssue(project, { name: 'Packed fixture' })
    const dir = path.join(issuesDir, project, opened.id)
    const runId = '2026-09-28T10-00-00-000Z-abcdef12'
    const runDir = path.join(dir, 'runs', runId)
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ at: 'x', type: 'started' }) + '\n')
    // A seat may write a file named with git's C-quoting taken literally (backslashes,
    // a stray quote); tar escapes those in its listing by default.
    await fs.mkdir(path.join(runDir, 'scratch', '"@mod'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'scratch', '"@mod', '\\303\\237.file.mjs"'), '')
    // A run that stopped with work only in its worktree.
    const wt = path.join(dir, 'runs', `worktree-${runId}`)
    await git(repo, 'worktree', 'add', '-q', '--detach', wt, base)
    await fs.writeFile(path.join(wt, 'app.txt'), 'one\ntwo\n')
    await fs.writeFile(path.join(wt, 'new.txt'), 'untracked work\n')
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({
      runId, status: 'blocked', outcome: 'unresolved', blockedReason: 'rounds-exhausted', playbook: { id: 'implementation', configHash: 'sha256:abc' },
      steps: [], startedAt: '2026-09-28T10:00:00.000Z', endedAt: '2026-09-28T10:05:00.000Z', participants: {},
      workspace: { path: wt, baseCommit: base, state: 'retained' }
    }))
    const before = (await exec('find', [dir, '-type', 'f', '-not', '-path', `${wt}/*`])).stdout.split('\n').filter(Boolean).length

    t.section('archiving packs the issue')
    const archived = await issues.setIssueArchived(project, opened.id, true, { overrideReason: 'test fixture' })
    t.eq('it reads as archived and packed', [archived.archived, archived.packed], [true, true])
    t.eq('the folder is gone from the project', await exists(dir), false)
    const bundle = path.join(issuesDir, '.archive', project, `${opened.id}.tar.gz`)
    t.ok('the bundle is there', await exists(bundle))
    t.eq('its copyable location is the bundle, not the folder it had', archived.location, bundle)
    const listed = (await exec('tar', ['-tzf', bundle])).stdout
    t.ok('it holds the issue', listed.includes(`${opened.id}/issue.json`))
    t.ok('and a file whose name carries backslashes and a quote', listed.includes('scratch/"@mod/\\\\303\\\\237.file.mjs"') || listed.includes('scratch/"@mod/\\303\\237.file.mjs"'))
    t.ok('but no worktree', !listed.includes(`${opened.id}/runs/worktree-`))
    t.ok('the worktree\'s own changes were saved as a patch', listed.includes(`runs/${runId}/artifacts/worktree-at-archive.patch`))
    t.ok('the worktree was handed back to git', !(await git(repo, 'worktree', 'list')).includes(wt))
    t.eq('its summary names the run and what it came to', archived.archive.results.map((r) => [r.runId, r.text.split('\n')[0]]),
      [[runId, "# Stopped: the author and reviewers didn't agree in time"]])

    t.section('a packed issue is still an issue')
    const list = await issues.listIssues(project, { archived: true })
    t.eq('the archived list names it', list.map((i) => [i.id, i.packed]), [[opened.id, true]])
    t.eq('the list gives the bundle as its location too', list[0]?.location, bundle)
    t.eq('it is not in the open list', (await issues.listIssues(project)).some((i) => i.id === opened.id), false)
    const { packedRuns } = await import('../server/issue-bundle.mjs')
    t.eq('its run records are kept for history', (await packedRuns(issuesDir, project, opened.id)).map((r) => [r.runId, r.playbook.configHash]), [[runId, 'sha256:abc']])
    let refused = null
    try { await issues.createStep(project, opened.id, { name: 'note', text: 'late' }) } catch (error) { refused = error.status }
    t.eq('it takes no new steps', refused, 409)

    t.section('restore brings it back as it was')
    const restored = await issues.setIssueArchived(project, opened.id, false)
    t.eq('it is open again', [restored.archived, Boolean(restored.packed)], [false, false])
    const after = (await exec('find', [dir, '-type', 'f'])).stdout.split('\n').filter(Boolean)
    t.eq('every file is back, plus the saved patch', after.length, before + 1)
    t.eq('the saved patch holds the tracked change', (await fs.readFile(path.join(runDir, 'artifacts', 'worktree-at-archive.patch'), 'utf8')).includes('+two'), true)
    t.ok('and the untracked file', (await fs.readFile(path.join(runDir, 'artifacts', 'worktree-at-archive.patch'), 'utf8')).includes('untracked work'))
    t.eq('the run knows its worktree is gone', JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8')).workspace.state, 'removed')
    t.eq('the bundle files are gone', await exists(bundle), false)

    t.section('delete removes a packed issue for good')
    await issues.setIssueArchived(project, opened.id, true, { overrideReason: 'again' })
    const gone = await issues.deleteIssue(project, opened.id)
    t.eq('deleted', gone.deleted, true)
    t.eq('no bundle, no summary', [await exists(bundle), await exists(bundle.replace(/\.tar\.gz$/, '.json'))], [false, false])
    let missing = null
    try { await issues.getIssue(project, opened.id) } catch (error) { missing = error.status }
    t.eq('and it is no longer found', missing, 404)

    t.section('a request reading the run does not undo the archive')
    const store = await import('../server/runtime/store.mjs')
    const withRun = async (name) => {
      const issue = await issues.createIssue(project, { name })
      const folder = path.join(issuesDir, project, issue.id)
      const id = '2026-09-28T11-00-00-000Z-abcdef12'
      await fs.mkdir(path.join(folder, 'runs', id, 'outputs'), { recursive: true })
      await fs.writeFile(path.join(folder, 'runs', id, 'events.jsonl'), JSON.stringify({ at: 'x', type: 'started' }) + '\n')
      await fs.writeFile(path.join(folder, 'runs', id, 'run.json'), JSON.stringify({ runId: id, status: 'cancelled', outcome: 'unresolved', playbook: { id: 'implementation' }, steps: [], participants: {} }))
      return { issue, folder, id }
    }
    // A read that took the issue's path before the pack, and looks at the journal after it.
    const late = await withRun('Late reader')
    await issues.setIssueArchived(project, late.issue.id, true, { overrideReason: 'test fixture' })
    const journal = await store.inspectRunJournal(late.folder, late.id)
    t.eq('the journal it finds gone still requires recovery', journal.recoveryRequired, true)
    t.eq('but the folder stays gone', await exists(late.folder), false)
    const packed = await issues.getIssue(project, late.issue.id)
    t.eq('and the issue still reads as archived and packed', [packed.archived, packed.packed], [true, true])
    t.eq('with its run', packed.archive.runs.map((r) => r.runId), [late.id])
    // Close does this: abandoning a run makes the open page reload while the archive request runs.
    const outcomes = []
    for (let round = 0; round < 15; round++) {
      const beside = await withRun(`Reader beside the pack ${round}`)
      let packing = true
      const readers = Array.from({ length: 4 }, async () => { while (packing) await store.readRun(beside.folder, beside.id).catch(() => {}) })
      const refused = await issues.setIssueArchived(project, beside.issue.id, true, { overrideReason: 'test fixture' }).then(() => null, (error) => error.message)
      packing = false
      await Promise.all(readers)
      const read = await issues.getIssue(project, beside.issue.id)
      outcomes.push([refused, read.archived, read.packed === true, await exists(beside.folder)])
    }
    t.eq('reads beside the pack: every archive succeeds, reads as packed and leaves no folder', outcomes.filter(([refused, archived, isPacked, folder]) => refused || !archived || !isPacked || folder), [])
    t.eq('nothing of the removal stays in the project folder', (await fs.readdir(path.join(issuesDir, project))).filter((n) => n.startsWith('.removing-')), [])
  } finally {
    for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fs.rm(root, { recursive: true, force: true })
  }
}
