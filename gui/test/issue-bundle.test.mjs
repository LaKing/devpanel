import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'

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

    const { bundleFiles, packIssue, unpackIssue } = await import('../server/issue-bundle.mjs')
    const { buildOverview } = await import('../server/supervisor-overview.mjs')
    const sha = (file) => fs.readFile(file).then((bytes) => crypto.createHash('sha256').update(bytes).digest('hex'))
    const sums = async (files, names) => Object.fromEntries(await Promise.all(names.map(async (n) => [n, await sha(files[n])])))
    const folderOf = (id) => path.join(issuesDir, project, id)
    const packedIssue = async (title) => {
      const issue = await issues.createIssue(project, { name: title })
      await issues.createStep(project, issue.id, { name: 'older-note', text: 'only in the older issue' })
      await issues.setIssueArchived(project, issue.id, true, { overrideReason: 'test fixture' })
      return { id: issue.id, dir: folderOf(issue.id), files: bundleFiles(issuesDir, project, issue.id) }
    }
    // What an id that once named two left behind: a folder beside a bundle of its id, built by hand.
    const collided = async (title) => {
      const older = await packedIssue(title)
      await issues.createEngineNote(project, older.id, { name: 'owed', text: 'owed to the older issue', invocationId: `owed-${older.id}` })
      await fs.mkdir(older.dir)
      await fs.writeFile(path.join(older.dir, 'issue.json'), JSON.stringify({ name: `${title} (newer)`, project, status: 'open' }))
      return older
    }
    const named = (error, { dir, files }) => error?.status === 409 && error.message.includes(dir) && error.message.includes(files.bundle)
    const refusalOf = (promise) => promise.then(() => null, (error) => error)

    t.section('archiving never lands on a bundle of its id')
    {
      const c = await collided('Collision archive')
      const before = await sums(c.files, ['bundle', 'summary', 'runs', 'notes'])
      const error = await refusalOf(issues.setIssueArchived(project, c.id, true, { overrideReason: 'test fixture' }))
      t.ok('refused, naming both', named(error, c), error?.message)
      t.eq('the folder stays open and unmarked', await exists(path.join(c.dir, '.archive.json')), false)
      t.eq('the bundle and every file beside it are byte for byte what they were', await sums(c.files, ['bundle', 'summary', 'runs', 'notes']), before)
      t.ok('the older issue is still in the bundle', (await exec('tar', ['-tzf', c.files.bundle])).stdout.includes('older-note'))
      const direct = await refusalOf(packIssue({ issuesDir, project, id: c.id, issue: { id: c.id }, releaseWorktrees: null }))
      t.ok('packIssue itself refuses too', named(direct, c), direct?.message)
      t.eq('still as they were', await sums(c.files, ['bundle', 'summary', 'runs', 'notes']), before)
    }

    t.section('a folder and a bundle of one id both stay readable, each as itself')
    {
      const c = await collided('Collision reads')
      const before = await sums(c.files, ['bundle', 'summary', 'runs', 'notes'])
      t.eq('the open list has the folder', (await issues.listIssues(project)).filter((i) => i.id === c.id).map((i) => [i.name, Boolean(i.packed)]), [['Collision reads (newer)', false]])
      t.eq('the archived list has the bundle', (await issues.listIssues(project, { archived: true })).filter((i) => i.id === c.id).map((i) => [i.name, i.packed]), [['Collision reads', true]])
      const read = await issues.getIssue(project, c.id)
      t.eq('the id reads as the folder', [read.name, Boolean(read.packed)], ['Collision reads (newer)', false])
      t.eq('with the older issue beside it', [read.archivedTwin?.name, read.archivedTwin?.location], ['Collision reads', c.files.bundle])
      t.eq('the family reads the folder too', (await issues.issueFamily(project, c.id)).parent, null)
      t.eq('a folder with no runs has none, whatever the bundle holds', await issues.readRunRecords(project, c.id), [])
      const note = await issues.createEngineNote(project, c.id, { name: 'for-the-folder', text: 'owed to the newer issue', invocationId: `new-${c.id}` })
      t.eq('a note for the open folder becomes its step', note.where, 'step')
      await issues.drainArchivedNotes(project)
      t.eq('and the older issue keeps its own', (JSON.parse(await fs.readFile(c.files.notes, 'utf8'))).map((n) => n.text), ['owed to the older issue'])
      const folderReads = []
      const packedReads = []
      await buildOverview({ projects: [project], listIssues: (p, o) => issues.listIssues(p, o), readRuns: async (p) => { folderReads.push(p); return [] }, readPackedRuns: async (p, id) => { packedReads.push(id); return [] } })
      t.ok('the overview counts both, each from its own place', folderReads.includes(c.dir) && packedReads.includes(c.id))
      const error = await refusalOf(issues.setIssueArchived(project, c.id, false))
      t.ok('restore is refused, naming both', named(error, c), error?.message)
      t.eq('nothing on disk of the bundle changed', await sums(c.files, ['bundle', 'summary', 'runs', 'notes']), before)
      t.eq('no outcome file was written for them', await exists(c.files.repeatLookup), false)
    }

    t.section('a new issue walks past an archived id')
    {
      const older = await packedIssue('Walked past')
      const before = await sha(older.files.bundle)
      const next = await issues.createIssue(project, { name: 'Walked past' })
      t.eq('its own id, naming the older only as a shared title', [next.id, next.sameTitleAs, next.repeats], [`${older.id}-2`, { project, id: older.id }, null])
      await issues.setIssueArchived(project, next.id, true, { overrideReason: 'test fixture' })
      t.eq('archiving it leaves the older bundle as it was', await sha(older.files.bundle), before)
      const live = await issues.createIssue(project, { name: 'Live title' })
      t.eq('a live id still answers as it did', await refusalOf(issues.createIssue(project, { name: 'Live title' })).then((e) => [e.status, e.existingId]), [409, live.id])
    }

    t.section('concurrent packers: a published bundle does not change')
    for (let round = 0; round < 5; round++) {
      const issue = await issues.createIssue(project, { name: `Packed twice ${round}` })
      const files = bundleFiles(issuesDir, project, issue.id)
      await fs.writeFile(path.join(folderOf(issue.id), '.archive.json'), JSON.stringify({ archivedAt: new Date().toISOString() }))
      await fs.mkdir(files.dir, { recursive: true })
      await fs.writeFile(`${files.bundle}.tmp`, 'another attempt\'s file')
      const results = await Promise.allSettled([issues.packArchived(project, issue.id), issues.packArchived(project, issue.id)])
      t.eq(`round ${round}: exactly one packs`, results.filter((r) => r.status === 'fulfilled').length, 1)
      const published = await sums(files, ['bundle', 'summary', 'runs'])
      t.eq('the old shared temporary name is not used', await fs.readFile(`${files.bundle}.tmp`, 'utf8'), 'another attempt\'s file')
      await fs.rm(`${files.bundle}.tmp`)
      t.eq('the bundle has one name', (await fs.stat(files.bundle)).nlink, 1)
      await refusalOf(issues.packArchived(project, issue.id))
      t.eq('a later attempt changes nothing', await sums(files, ['bundle', 'summary', 'runs']), published)
      t.eq('nothing of an attempt stays', (await fs.readdir(files.dir)).filter((n) => n.startsWith('.pack-')), [])
    }
    {
      const issue = await issues.createIssue(project, { name: 'Raced by another writer' })
      const files = bundleFiles(issuesDir, project, issue.id)
      const error = await refusalOf(packIssue({ issuesDir, project, id: issue.id, issue: await issues.getIssue(project, issue.id), releaseWorktrees: async () => { await fs.writeFile(files.bundle, 'another writer\'s bundle') } }))
      t.ok('a bundle appearing during packing is not replaced: refused, naming both', named(error, { dir: folderOf(issue.id), files }), error?.message)
      t.eq('its bytes are as they were', await fs.readFile(files.bundle, 'utf8'), 'another writer\'s bundle')
      t.eq('and the folder stays', await exists(folderOf(issue.id)), true)
      await fs.rm(files.bundle)
    }

    t.section('restore replaces nothing: an empty target, a full one, and a new issue beside it')
    {
      const a = await packedIssue('Restore over empty')
      const before = await sha(a.files.bundle)
      let inode = null
      const empty = await refusalOf(unpackIssue({ issuesDir, project, id: a.id, beforePublish: async () => { await fs.mkdir(a.dir); inode = (await fs.stat(a.dir)).ino } }))
      t.ok('an empty folder at the target is refused, naming both', named(empty, a), empty?.message)
      t.eq('it is the same folder afterwards', (await fs.stat(a.dir)).ino, inode)
      t.eq('still empty', await fs.readdir(a.dir), [])
      t.eq('the bundle is as it was', await sha(a.files.bundle), before)
      t.eq('nothing of the attempt stays', (await fs.readdir(path.join(issuesDir, project))).filter((n) => n.startsWith('.restoring-')), [])
      await fs.rmdir(a.dir)

      const b = await packedIssue('Restore over full')
      const beforeB = await sha(b.files.bundle)
      const full = await refusalOf(unpackIssue({ issuesDir, project, id: b.id, beforePublish: async () => { await fs.mkdir(b.dir); await fs.writeFile(path.join(b.dir, 'theirs'), 'kept') } }))
      t.ok('a full folder at the target is refused, naming both', named(full, b), full?.message)
      t.eq('its content stays', await fs.readFile(path.join(b.dir, 'theirs'), 'utf8'), 'kept')
      t.eq('the bundle is as it was', await sha(b.files.bundle), beforeB)
      await fs.rm(b.dir, { recursive: true })

      const w = await packedIssue('Written into the reservation')
      const written = await refusalOf(unpackIssue({ issuesDir, project, id: w.id, afterClaim: () => fs.writeFile(path.join(w.dir, 'theirs'), 'kept') }))
      t.ok('content written into the reservation refuses it, naming both', named(written, w), written?.message)
      t.eq('that content stays', await fs.readFile(path.join(w.dir, 'theirs'), 'utf8'), 'kept')
      await fs.rm(w.dir, { recursive: true })

      // createIssue made its folder just as this id came to a bundle, and a restore arrives before it looks again.
      let restoreError = null
      let older = null
      const created = await issues.createIssue(project, { name: 'Interleaved' }, { afterMkdir: async (id) => {
        if (older) return
        // Packed from a folder that stands aside: the id is free again only for the moment it takes to hold it.
        const aside = `${folderOf(id)}.aside`
        await fs.rename(folderOf(id), aside)
        const made = await issues.createIssue(project, { name: 'Interleaved' }, { afterMkdir: async () => {} })
        await issues.setIssueArchived(project, made.id, true, { overrideReason: 'test fixture' })
        older = { id: made.id, dir: folderOf(made.id), files: bundleFiles(issuesDir, project, made.id) }
        await fs.rename(aside, folderOf(id))
        restoreError = await refusalOf(unpackIssue({ issuesDir, project, id }))
      } })
      t.ok('a restore arriving after createIssue\'s mkdir is refused, naming both', named(restoreError, older), restoreError?.message)
      t.eq('createIssue takes the empty folder back and moves on', [created.id, created.sameTitleAs?.id], [`${older.id}-2`, older.id])
      t.eq('the older one is still whole in its bundle, and restores now', await unpackIssue({ issuesDir, project, id: older.id }), older.dir)
      t.eq('each has its own record', [(await issues.getIssue(project, older.id)).name, (await issues.getIssue(project, created.id)).id], ['Interleaved', created.id])
      await issues.setIssueArchived(project, older.id, true, { overrideReason: 'test fixture' }).catch(() => {})

      const r = await packedIssue('Reservation held')
      let during = null
      await unpackIssue({ issuesDir, project, id: r.id, afterClaim: async () => { during = await issues.createIssue(project, { name: 'Reservation held' }) } })
      t.eq('a new issue during a held reservation takes another id', during.id, `${r.id}-2`)
      t.ok('and the restore completes, with its content', (await fs.readdir(r.dir)).includes('issue.json'))

      const twice = await packedIssue('Restored twice')
      const results = await Promise.allSettled([unpackIssue({ issuesDir, project, id: twice.id }), unpackIssue({ issuesDir, project, id: twice.id })])
      t.ok('of two restores at once one succeeds', results.some((x) => x.status === 'fulfilled'))
      t.ok('with every file there', (await fs.readdir(twice.dir)).includes('issue.json'))
      await fs.writeFile(path.join(twice.dir, 'issue.json'), JSON.stringify({ name: 'edited since' }))
      await unpackIssue({ issuesDir, project, id: twice.id })
      t.eq('a late restore extracts nothing over an edit', JSON.parse(await fs.readFile(path.join(twice.dir, 'issue.json'), 'utf8')).name, 'edited since')
    }
  } finally {
    for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fs.rm(root, { recursive: true, force: true })
  }
}
