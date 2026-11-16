import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'top-level supervisor — an idle poll opens no record of a settled run or an unchanged issue, and still notices every change at the next poll'

/*
 * The real service (top-supervisor-service.mjs) over the real issues.js and settled-run cache, with a model
 * that never acts: an activation that owns settled runs and waits. Every fs.promises read and open is counted
 * by the file it names; an idle poll must open no run record, event journal, issue record, archive marker,
 * occurrence record, archived notes, repeat-lookup outcome or bundle file.
 */
const RECORD = /(\/run\.json|\/events\.jsonl|\/resolved-playbook\.json|\/outputs\/|\/issue\.json|\/\.archive\.json|\/occurrences\.json|\.notes\.json|\.repeat-lookup\.json|\.runs\.json|\/\.archive\/.+\.json)$/

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-idle-reads-'))
  const issuesDir = path.join(root, 'issues'), projectsDir = path.join(root, 'projects'), harnessDir = path.join(root, 'harness')
  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR, harness: process.env.DEVPANEL_HARNESS_DIR }
  const realNow = Date.now
  const patched = []
  let service = null
  try {
    // --- fixture: two projects × 15 issues, one settled run each ---
    const projects = ['p-project', 'q-project']
    const owned = []
    const runDir = (project, id, runId) => path.join(issuesDir, project, id, 'runs', runId)
    const record = (runId, status) => JSON.stringify({ runId, status, blockedReason: null, outcome: null, startedAt: '2026-11-01T00:00:00.000Z', endedAt: '2026-11-01T01:00:00.000Z',
      workspace: { isolation: 'worktree', path: null, baseCommit: null, state: 'removed' }, participants: { coordinator: { session: { id: 's' } } }, phase: { id: 'triage', round: 0, stepId: 'triage' },
      steps: [{ number: '001', slug: 'triage', stepId: 'triage', role: 'coordinator', phase: 'triage', round: 0, attempt: 1, invocationId: `inv-${runId}` }], revisions: [], approvals: [], checkResults: [],
      outstandingFindings: [], budgets: { limits: {}, used: { steps: 1, costUsd: 1 } }, failures: [], failure: null, pause: null, timing: { agentMs: 0, abandonedMs: 0, unknownSteps: 0 }, interruptedTurns: [],
      delivery: null, closure: null, recovery: { required: false, reason: null, detectedAt: null }, playbook: { id: 'analysis' } })
    for (const project of projects) {
      await fs.mkdir(path.join(projectsDir, project), { recursive: true })
      for (let i = 0; i < 15; i++) {
        const id = `2026-11-${String(1 + i).padStart(2, '0')}-issue-${project[0]}-${i}`
        const runId = `2026-11-01T00-00-${String(i).padStart(2, '0')}-000Z-${project[0]}${i}`
        await fs.mkdir(path.join(runDir(project, id, runId), 'outputs'), { recursive: true })
        await fs.mkdir(path.join(issuesDir, project, id, '000-report'), { recursive: true })
        await fs.writeFile(path.join(issuesDir, project, id, '000-report', 'response.md'), 'report')
        await fs.writeFile(path.join(issuesDir, project, id, 'issue.json'), JSON.stringify({ name: `Issue ${project} ${i}`, status: 'open', openedAt: '2026-11-01T00:00:00.000Z' }))
        await fs.writeFile(path.join(runDir(project, id, runId), 'run.json'), record(runId, 'completed'))
        await fs.writeFile(path.join(runDir(project, id, runId), 'outputs', '001.json'), JSON.stringify({ contract: 'x', valid: true, output: {} }))
        await fs.writeFile(path.join(runDir(project, id, runId), 'resolved-playbook.json'), JSON.stringify({ participants: {} }))
        await fs.writeFile(path.join(runDir(project, id, runId), 'events.jsonl'), JSON.stringify({ at: '2026-11-01T00:00:00.000Z', type: 'e' }) + '\n')
        if (i < 10) owned.push({ project, issueId: id, runId, status: 'completed' })
      }
    }
    const [pArchived, pRepeat, pEmptyRun] = ['2026-11-13-issue-p-12', '2026-11-14-issue-p-13', '2026-11-15-issue-p-14']
    const archiveRoot = path.join(issuesDir, '.archive', 'p-project')
    await fs.mkdir(archiveRoot, { recursive: true })
    // An archived folder that was never packed, with notes beside the bundles.
    await fs.writeFile(path.join(issuesDir, 'p-project', pArchived, '.archive.json'), JSON.stringify({ archivedAt: '2026-11-02T00:00:00.000Z' }))
    await fs.writeFile(path.join(archiveRoot, `${pArchived}.notes.json`), '[]')
    // A report whose repeat lookup is pending, with its kept outcome.
    await fs.writeFile(path.join(issuesDir, 'p-project', pRepeat, 'issue.json'), JSON.stringify({ name: 'Repeat pending', status: 'open', openedAt: '2026-11-01T00:00:00.000Z', report: { fingerprint: 'fp' }, repeats: null, repeatLookup: { unread: ['x'] } }))
    await fs.writeFile(path.join(archiveRoot, `${pRepeat}.repeat-lookup.json`), JSON.stringify({ openedAt: '2026-11-01T00:00:00.000Z', repeats: null, repeatLookup: { unread: ['x'] } }))
    // A run folder whose record is not written yet.
    const lateRun = '2026-11-02T00-00-00-000Z-late'
    await fs.mkdir(path.join(runDir('p-project', pEmptyRun, lateRun), 'outputs'), { recursive: true })

    // Suites run concurrently in one process: the variables are set only for as long as the modules that read them
    // at load (issues.js) or at creation (the service's harness directory) take to do so, as sandbox.preflight does.
    const restoreEnv = () => {
      for (const [key, name] of [['issues', 'DEVPANEL_ISSUES_DIR'], ['projects', 'DEVPANEL_PROJECTS_DIR'], ['harness', 'DEVPANEL_HARNESS_DIR']]) {
        if (saved[key] === undefined) delete process.env[name]
        else process.env[name] = saved[key]
      }
    }
    await fs.mkdir(harnessDir, { recursive: true })
    const invocations = []
    await fs.writeFile(path.join(harnessDir, 'claude.mjs'), `export async function invoke (args) {
  globalThis.__idleReadsInvocations?.push(JSON.parse(args.prompt).event)
  return { session: args.session ?? { id: 'idle-session' }, response: JSON.stringify({ message: 'waiting', action: null }), usage: { costUsd: 0 } }
}\n`)
    globalThis.__idleReadsInvocations = invocations
    Object.assign(saved, { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR, harness: process.env.DEVPANEL_HARNESS_DIR })
    process.env.DEVPANEL_ISSUES_DIR = issuesDir
    process.env.DEVPANEL_PROJECTS_DIR = projectsDir
    let issues
    try { issues = await import(`../server/issues.js?idle-reads=${Date.now()}`) } finally { restoreEnv() }
    // Three owned runs whose issues are packed (archived), as a session that archives after settling.
    for (const r of owned.slice(0, 3)) {
      await issues.setIssueDisposition(r.project, r.issueId, { value: 'resolved', evidence: 'test', by: 'supervisor' })
      await issues.setIssueArchived(r.project, r.issueId, true)
    }
    const supDir = path.join(issuesDir, '.supervisor')
    await fs.mkdir(supDir, { recursive: true })
    await fs.writeFile(path.join(supDir, 'state.json'), JSON.stringify({ version: 2, startBudgetVersion: 2, status: 'stopped', session: null, model: null, queue: [], previews: {}, calls: 0, starts: owned.length, costUsd: 0, unknownCostCalls: 0,
      ownedRuns: owned.map((r) => ({ ...r, observedStatus: r.status })),
      launches: owned.map((r, k) => ({ id: `l${k}`, status: 'finished', runStatus: r.status, project: r.project, issueId: r.issueId, runId: r.runId })),
      startsByIssue: {}, failedLaunches: {} }))

    // --- counting ---
    let counting = false, polls = 0
    const opened = []
    for (const op of ['readFile', 'open']) {
      const original = fs[op]
      patched.push([op, original])
      fs[op] = function (file, ...rest) {
        const name = String(file?.path ?? file)
        if (counting && name.startsWith(issuesDir) && RECORD.test(name)) opened.push(path.relative(issuesDir, name))
        return original.call(this, file, ...rest)
      }
    }
    // A poll lists each project's issue folders once; that readdir counts the polls.
    const originalReaddir = fs.readdir
    patched.push(['readdir', originalReaddir])
    fs.readdir = function (dir, ...rest) {
      if (counting && String(dir) === path.join(issuesDir, 'p-project') && rest[0]?.withFileTypes) polls++
      return originalReaddir.call(this, dir, ...rest)
    }
    let offset = 0
    Date.now = () => realNow() + offset
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const until = async (test, ms = 25_000) => { const end = realNow() + ms; while (!test()) { if (realNow() > end) return false; await sleep(20) } return true }
    // pollMs is a test seam only; the service's own poll keeps createTopSupervisor's default.
    const { topSupervisorService } = await import('../server/top-supervisor-service.mjs')
    const supervisor = { isActive: () => false, liveCheckSince: () => null, checkoutHolder: async () => null, availability: { recordExhausted: async () => {} }, deliveryActions: {} }
    Object.assign(saved, { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR, harness: process.env.DEVPANEL_HARNESS_DIR })
    process.env.DEVPANEL_HARNESS_DIR = harnessDir
    try { service = await topSupervisorService({ issues, supervisor, emit: () => {}, changed: () => {}, pollMs: 50 }) } finally { restoreEnv() }
    await service.start({ model: 'opus-5-5', message: 'wait', limits: { maxCalls: 50, maxRuns: 200, maxConcurrent: 3, maxStartsPerIssue: 20 } })
    const idle = () => service.get().status === 'active' && !service.get().pending
    await until(() => invocations.length >= 1 && idle())
    // Let a few polls warm the caches.
    counting = true; polls = 0
    await until(() => polls >= 3)
    const window = async (n) => { opened.length = 0; polls = 0; await until(() => polls >= n); return { polls, opened: [...opened] } }

    t.section('N consecutive idle polls open no record of a settled run or an unchanged issue')
    const first = await window(5)
    t.ok(`${first.polls} idle polls observed`, first.polls >= 5)
    t.eq('records opened', first.opened.length, 0, first.opened.slice(0, 12).join(', '))

    t.section('and none past the settled cache\'s five minutes either')
    offset += 6 * 60_000
    const later = await window(5)
    t.eq('records opened six minutes later', later.opened.length, 0, later.opened.slice(0, 12).join(', '))

    const events = () => invocations.map((e) => e?.type)
    const owner = (runId) => service.get().ownedRuns.find((r) => r.runId === runId)

    t.section('a settled run that moves is still seen at the next poll, and wakes the supervisor')
    const watched = owned[5]
    const watchedFile = path.join(runDir(watched.project, watched.issueId, watched.runId), 'run.json')
    let before = invocations.length
    await fs.writeFile(watchedFile, record(watched.runId, 'running'))
    t.ok('running observed', await until(() => owner(watched.runId)?.observedStatus === 'running'))
    await fs.writeFile(watchedFile, record(watched.runId, 'completed'))
    t.ok('completed observed again', await until(() => owner(watched.runId)?.observedStatus === 'completed'))
    t.ok('its ending woke the supervisor (run-changed)', await until(() => events().slice(before).includes('run-changed')), events().slice(before).join(', '))

    t.section('a same-size edit of a settled run\'s record that puts its modification time back is seen at the next poll')
    const stamp = new Date('2023-11-14T22:13:20Z')
    await fs.utimes(watchedFile, stamp, stamp)
    await until(() => idle())
    opened.length = 0; polls = 0
    await until(() => polls >= 2)
    before = invocations.length
    await fs.writeFile(watchedFile, record(watched.runId, 'cancelled'))
    await fs.utimes(watchedFile, stamp, stamp)
    t.ok('cancelled observed, the clock well within the cache limit of the last read', await until(() => owner(watched.runId)?.observedStatus === 'cancelled'))
    t.ok('and it woke the supervisor (run-changed)', await until(() => events().slice(before).includes('run-changed')), events().slice(before).join(', '))

    t.section('an operator\'s edit of an issue is seen at the next poll')
    before = invocations.length
    const edited = path.join(issuesDir, 'q-project', '2026-11-12-issue-q-11', 'issue.json')
    const meta = JSON.parse(await fs.readFile(edited, 'utf8'))
    await fs.writeFile(edited, JSON.stringify({ ...meta, name: 'Renamed by hand' }))
    t.ok('issues-changed woke the supervisor', await until(() => events().slice(before).includes('issues-changed')), events().slice(before).join(', '))

    t.section('an owned issue archived (packed) between two polls')
    before = invocations.length
    const archived = owned[6]
    const faults = () => service.get().messages?.filter((m) => /Monitoring:/.test(m.text ?? '')) ?? []
    const faultsBefore = faults().length
    await issues.setIssueDisposition(archived.project, archived.issueId, { value: 'resolved', evidence: 'test', by: 'operator' })
    await issues.setIssueArchived(archived.project, archived.issueId, true)
    t.ok('issues-changed woke the supervisor', await until(() => events().slice(before).includes('issues-changed')), events().slice(before).join(', '))
    t.ok('its run is still monitored, from the bundle', Boolean(owner(archived.runId)))
    t.eq('no monitoring fault and no run-unreadable', [faults().length - faultsBefore, events().slice(before).includes('run-unreadable')], [0, false])
    await until(() => idle())
    // The packed issue is read once, from its bundle (it changed); after that nothing is.
    const absorbed = await window(3)
    t.ok('the packed issue is read again once, from its bundle', absorbed.opened.every((f) => f.includes(archived.issueId)), absorbed.opened.join(', '))
    const afterPack = await window(3)
    t.eq('and idle again: nothing opened', afterPack.opened.slice(0, 12), [])

    t.section('each outside change reaches the next listing')
    counting = false
    const row = async (id, opts) => (await issues.listIssues('p-project', opts)).find((i) => i.id === id)
    const plain = '2026-11-11-issue-p-10'
    const stepsBefore = (await row(plain)).stepCount
    await fs.mkdir(path.join(issuesDir, 'p-project', plain, '001-note'))
    t.eq('a new step folder', (await row(plain)).stepCount, stepsBefore + 1)
    const runsBefore = (await row(plain)).runCount
    const newRun = '2026-11-03T00-00-00-000Z-new'
    await fs.mkdir(runDir('p-project', plain, newRun), { recursive: true })
    await fs.writeFile(path.join(runDir('p-project', plain, newRun), 'run.json'), record(newRun, 'completed'))
    t.eq('a new run folder', (await row(plain)).runCount, runsBefore + 1)
    t.eq('a run folder whose record is not written yet is no run', (await row(pEmptyRun)).runCount, 1)
    await fs.writeFile(path.join(runDir('p-project', pEmptyRun, lateRun), 'run.json'), record(lateRun, 'completed'))
    t.eq('its record written afterwards makes it one', (await row(pEmptyRun)).runCount, 2)
    await fs.writeFile(path.join(issuesDir, 'p-project', plain, 'occurrences.json'), JSON.stringify({ count: 1, firstAt: '2026-11-03T00:00:00.000Z', lastAt: '2026-11-03T00:00:00.000Z' }))
    t.eq('an occurrence record written', (await row(plain)).occurrences?.count, 1)
    await fs.writeFile(path.join(issuesDir, 'p-project', plain, 'occurrences.json'), JSON.stringify({ count: 2, firstAt: '2026-11-03T00:00:00.000Z', lastAt: '2026-11-04T00:00:00.000Z' }))
    t.eq('and edited in place', (await row(plain)).occurrences?.count, 2)
    t.eq('an archived folder is listed archived, with its notes', (await row(pArchived, { archived: true }))?.archivedNotes, [])
    await fs.writeFile(path.join(archiveRoot, `${pArchived}.notes.json`), JSON.stringify([{ name: 'note', text: 'later' }]))
    t.eq('its notes rewritten beside the bundles', (await row(pArchived, { archived: true }))?.archivedNotes?.length, 1)
    t.eq('a pending repeat lookup', (await row(pRepeat)).repeats, null)
    await fs.writeFile(path.join(archiveRoot, `${pRepeat}.repeat-lookup.json`), JSON.stringify({ openedAt: '2026-11-01T00:00:00.000Z', repeats: { project: 'p-project', id: plain, evidence: 'fingerprint' }, repeatLookup: null }))
    t.eq('its outcome written by a rerun', (await row(pRepeat)).repeats?.id, plain)
    await fs.writeFile(path.join(issuesDir, 'p-project', plain, '.archive.json'), JSON.stringify({ archivedAt: '2026-11-05T00:00:00.000Z' }))
    t.eq('an archive marker written takes it out of the open list', await row(plain), undefined)

    t.section('a run created while a folder\'s listing is being signed is not lost from it')
    {
      const raced = '2026-11-10-issue-p-9'
      const racedRuns = path.join(issuesDir, 'p-project', raced, 'runs')
      const lateId = '2026-11-09T00-00-00-000Z-raced'
      // Touch the folder so its next listing is read afresh, then create a run right after the listing enumerates runs/.
      await fs.mkdir(path.join(issuesDir, 'p-project', raced, '002-touch'))
      let injected = false
      const readdirBefore = fs.readdir
      fs.readdir = async function (dir, ...rest) {
        const out = await readdirBefore.call(this, dir, ...rest)
        if (!injected && String(dir) === racedRuns) {
          injected = true
          await fs.mkdir(path.join(racedRuns, lateId), { recursive: true })
          await fs.writeFile(path.join(racedRuns, lateId, 'run.json'), JSON.stringify({ ...JSON.parse(record(lateId, 'completed')), startedAt: '2026-11-09T00:00:00.000Z' }))
        }
        return out
      }
      patched.push(['readdir', readdirBefore])
      try {
        t.eq('the run created during the listing is listed', (await row(raced)).latestRun?.runId, lateId)
      } finally { fs.readdir = readdirBefore }
      await fs.writeFile(path.join(racedRuns, lateId, 'run.json'), JSON.stringify({ ...JSON.parse(record(lateId, 'running')), startedAt: '2026-11-09T00:00:00.000Z' }))
      t.eq('and its later status change reaches the next listing', [injected, (await row(raced)).latestRun?.status], [true, 'running'])
    }

    t.section('a malformed issue record is listed from its fallback and kept like any other')
    {
      const broken = '2026-11-09-issue-p-8'
      const brokenFile = path.join(issuesDir, 'p-project', broken, 'issue.json')
      await fs.writeFile(brokenFile, '{"name":')
      t.eq('listed by its slug', (await row(broken))?.name, 'issue-p-8')
      let opens = 0
      const readFileBefore = fs.readFile
      fs.readFile = function (file, ...rest) {
        if (String(file?.path ?? file) === brokenFile) opens++
        return readFileBefore.call(this, file, ...rest)
      }
      patched.push(['readFile', readFileBefore])
      try {
        for (let i = 0; i < 4; i++) await row(broken)
        t.eq('four more listings open it no more', opens, 0)
      } finally { fs.readFile = readFileBefore }
      await fs.writeFile(brokenFile, JSON.stringify({ name: 'Repaired', status: 'open', openedAt: '2026-11-01T00:00:00.000Z' }))
      t.eq('repairing it is seen at the next listing', (await row(broken))?.name, 'Repaired')
    }
  } finally {
    Date.now = realNow
    for (const [op, original] of patched.reverse()) fs[op] = original
    await service?.shutdown?.().catch(() => {})
    delete globalThis.__idleReadsInvocations
    await fs.rm(root, { recursive: true, force: true })
  }
}
