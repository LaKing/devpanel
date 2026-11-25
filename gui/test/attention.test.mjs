import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { attentionItems, attentionList } from '../server/attention.mjs'
import * as store from '../server/runtime/store.mjs'
import { retireLegacyJournal } from '../server/runtime/legacy-journal.mjs'
import { bundleFiles, packIssue } from '../server/issue-bundle.mjs'
import { collectWaits, runWaits } from '../server/notifications/waits.mjs'

/*
 * The Needs attention classification the inbox and the operator alerts share (docs/operator-alerts.md):
 * recovery before a pause, the waiting event's key and entry time, the supervisor's questions through a getter,
 * and run summaries that read the journal finding without ever writing it.
 */

const list = (summary, extra = {}) => attentionList({ listProjects: async () => ['p'], listIssues: async () => [{ id: 'i', name: 'I', latestRun: { runId: 'r', ...summary }, ...extra }] })

export default async function (t) {
  t.section('classification and waiting events')
  {
    const [paused] = await list({ status: 'paused', pauseQuestion: 'Go on?', pauseId: 'p1', pauseAt: '2026-11-25T10:00:00.000Z', pauseKind: 'policy' })
    t.eq('a policy pause is a question', paused.kind, 'question')
    t.eq('keyed by its pause id', paused.key, 'pause:p/i/r/p1')
    t.eq('entered when it was asked', paused.enteredAt, '2026-11-25T10:00:00.000Z')
    const [manual] = await list({ status: 'paused', pauseQuestion: 'Paused by an operator', pauseId: 'p2', pauseAt: '2026-11-25T10:00:00.000Z', pauseKind: 'manual' })
    t.eq('a manual pause is not a question', manual.kind, 'paused')
    t.eq('and carries no alerting key', manual.key, undefined)
    const [damaged] = await list({ status: 'paused', pauseQuestion: 'Go on?', pauseId: 'p1', recoveryRequired: true, recoveryDetectedAt: '2026-11-25T11:00:00.000Z' })
    t.eq('a paused run that needs recovery is a recovery (as supportedActions orders it)', damaged.kind, 'recovery')
    t.eq('keyed by its occurrence', damaged.key, 'recovery:p/i/r/2026-11-25T11:00:00.000Z')
    const [undated] = await list({ status: 'blocked', recoveryRequired: true, recoveryDetectedAt: null })
    t.eq('an undated recovery is keyed undated', undated.key, 'recovery:p/i/r/undated')
    t.eq('and its entry is not recorded', undated.enteredBasis, 'not-recorded')
    const [owner] = await list({ status: 'completed', ownerInput: { answered: false, questions: ['Which?'] }, ownerInputAt: '2026-11-25T09:00:00.000Z' })
    t.eq("a triage's question to the owner is keyed by its run", owner.key, 'owner-input:p/i/r')
  }

  t.section('one reading for the inbox and the notifier')
  {
    const base = { listProjects: async () => ['p', 'q'], listIssues: async (p) => { if (p === 'q') throw new Error('unreadable'); return [] } }
    let read = await attentionItems({ ...base, getTopSupervisor: () => null })
    t.eq('no supervisor yet: no questions, and that is a complete reading of it', `${read.items.length}/${read.questionsRead}`, '0/true')
    t.eq('a project whose issues could not be listed is named', read.unreadProjects.join(), 'q')
    let service = null
    const getter = () => service
    read = await attentionItems({ ...base, getTopSupervisor: getter })
    t.eq('before the supervisor exists', read.items.length, 0)
    service = { questions: () => [{ id: 'sq-1', at: '2026-11-25T10:00:00.000Z', question: 'Authorize?', project: 'p', issueId: 'i' }] }
    read = await attentionItems({ ...base, getTopSupervisor: getter })
    t.eq('once it exists, the same getter reads its questions', read.items[0]?.key, 'supervisor-question:sq-1')
    t.eq('dated by when it was asked', read.items[0]?.enteredAt, '2026-11-25T10:00:00.000Z')
    read = await attentionItems({ ...base, getTopSupervisor: () => ({ questions: () => { throw new Error('busy') } }) })
    t.eq('an unreadable supervisor is not a complete reading', read.questionsRead, false)
    t.eq('and complete says so', read.complete, false)
    // A run record newer than the issue's latest that could not be read (issues.js unreadableNewerRuns).
    const healthy = { listProjects: async () => ['p'], getTopSupervisor: () => null }
    read = await attentionItems({ ...healthy, listIssues: async () => [{ id: 'i', name: 'I', latestRun: { runId: 'r1', status: 'completed' }, unreadableNewerRuns: ['r2'] }] })
    t.eq('an unreadable newer run is named', read.unreadRuns.join(), 'p/i/r2')
    t.eq('and the reading is not complete', read.complete, false)
    read = await attentionItems({ ...healthy, listIssues: async () => [{ id: 'i', name: 'I', latestRun: { runId: 'r1', status: 'completed' }, unreadableNewerRuns: [] }] })
    t.eq('with every record read it is', `${read.unreadRuns.length}/${read.complete}`, '0/true')
  }

  t.section('run summaries read the journal finding, never write it')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attention-issues-'))
  const previous = process.env.DEVPANEL_ISSUES_DIR
  try {
    process.env.DEVPANEL_ISSUES_DIR = root
    const issues = await import(`../server/issues.js?attention=${Date.now()}`)
    const issue = await issues.createIssue('devpanel-project', { name: 'Journal' })
    const runDir = (id) => path.join(issue.path, 'runs', id)
    const latest = async () => (await issues.listIssues('devpanel-project')).find((i) => i.id === issue.id).latestRun

    // A healthy paused run whose journal is caught mid-append by a list read.
    await fs.mkdir(runDir('2026-11-25T10-00-00-000Z-aaaaaaaa'), { recursive: true })
    const id = '2026-11-25T10-00-00-000Z-aaaaaaaa'
    await fs.writeFile(path.join(runDir(id), 'run.json'), JSON.stringify({ runId: id, status: 'paused', startedAt: '2026-11-25T10:00:00.000Z', pause: { id: 'p1', question: 'Go on?', kind: 'policy', at: '2026-11-25T10:01:00.000Z' }, steps: [] }))
    const prefix = '{"type":"paused","at":"2026-11-25T10:01:00.000Z"}\n'
    await fs.writeFile(path.join(runDir(id), 'events.jsonl'), prefix + '{"type":"resum')
    let run = await latest()
    t.eq('a half-written append read by a list is not a recovery', run.recoveryRequired, false)
    t.eq('the pause id and time are on the summary', `${run.pauseId}/${run.pauseAt}`, 'p1/2026-11-25T10:01:00.000Z')
    t.ok('and no finding was published', !(await fs.stat(path.join(runDir(id), 'journal-recovery.json')).then(() => true, () => false)))
    await fs.writeFile(path.join(runDir(id), 'events.jsonl'), prefix + '{"type":"resumed","at":"2026-11-25T10:02:00.000Z"}\n')
    t.eq('the completed append leaves the run healthy', (await store.requireCompleteEvents(issue.path, id)).complete, true)

    // Genuine damage, published by a detail read: the list shows the same occurrence.
    await fs.writeFile(path.join(runDir(id), 'events.jsonl'), prefix + 'garbage')
    const detail = await store.readRun(issue.path, id)
    run = await latest()
    t.eq('a published finding makes the summary a recovery', run.recoveryRequired, true)
    t.eq('with the occurrence the detail names', run.recoveryDetectedAt, detail.recovery.detectedAt)
    const [item] = await attentionList({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues })
    t.eq('the paused run with a damaged journal is listed as a recovery', item?.kind, 'recovery')
    t.eq('keyed by that occurrence', item?.key, `recovery:devpanel-project/${issue.id}/${id}/${detail.recovery.detectedAt}`)

    t.section('concurrent first reads agree on one finding')
    const other = '2026-11-25T11-00-00-000Z-bbbbbbbb'
    await fs.mkdir(runDir(other), { recursive: true })
    await fs.writeFile(path.join(runDir(other), 'events.jsonl'), prefix + 'garbage')
    const both = await Promise.all([store.inspectRunJournal(issue.path, other), store.inspectRunJournal(issue.path, other), store.inspectRunJournal(issue.path, other)])
    const onDisk = JSON.parse(await fs.readFile(path.join(runDir(other), 'journal-recovery.json'), 'utf8'))
    t.ok('every reader returns the finding on disk', both.every((j) => j.finding?.detectedAt === onDisk.detectedAt))

    t.section('a legacy retirement refreshes the cached summary')
    const legacy = '2026-09-01T10-00-00-000Z-cccccccc'
    await fs.mkdir(runDir(legacy), { recursive: true })
    await fs.writeFile(path.join(runDir(legacy), 'run.json'), JSON.stringify({ runId: legacy, status: 'failed', startedAt: '2026-11-25T12:00:00.000Z', endedAt: '2026-11-25T12:00:01.000Z',
      blockedReason: 'base policy "head" requires a clean checkout, and it was dirty', phase: null, workspace: null, recovery: { required: false },
      steps: [], revisions: [], approvals: [], checkResults: [], participants: { coordinator: { turns: 0, session: null, pendingInvocation: null, state: 'uninitialised' } } }))
    await store.inspectRunJournal(issue.path, legacy)
    const finding = JSON.parse(await fs.readFile(path.join(runDir(legacy), 'journal-recovery.json'), 'utf8'))
    t.eq('the missing journal of the legacy run is a finding', finding.status, 'missing')
    run = await latest()
    t.eq('the newest run lists as needing recovery (cached now)', run.recoveryRequired, true)
    await retireLegacyJournal(issue.path, legacy, 'pre-execution failure, nothing ran')
    run = await latest()
    t.eq('after retirement both caches read it again: no longer a recovery', run.recoveryRequired, false)
    t.ok('the inbox no longer lists a recovery for it', !(await attentionList({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues })).some((i) => i.runId === legacy && i.kind === 'recovery'))
    const retiredRecord = (await issues.readRunRecords('devpanel-project', issue.id, { journal: true })).find((r) => r.runId === legacy)
    t.eq('the timing reader keeps the retired finding beside the retirement', `${retiredRecord?.journal?.retired}/${retiredRecord?.journal?.finding?.detectedAt === finding.detectedAt}`, 'true/true')

    t.section('one pause id and one recovery for the summary, the detail and the timing reader')
    const old = '2026-11-25T13-00-00-000Z-dddddddd'
    await fs.mkdir(runDir(old), { recursive: true })
    await fs.writeFile(path.join(runDir(old), 'run.json'), JSON.stringify({ runId: old, status: 'paused', startedAt: '2026-11-25T13:00:00.000Z', pause: { question: 'Older question?', kind: 'policy', at: '2026-11-25T13:01:00.000Z' }, steps: [] }))
    await fs.writeFile(path.join(runDir(old), 'events.jsonl'), '')
    run = await latest()
    const detailOld = await store.readRun(issue.path, old)
    t.eq('an older pause without an id: the summary and the detail derive the same id', run.pauseId, detailOld.pause.id)
    const [legacyItem] = await attentionList({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues })
    t.eq('and the inbox keys the alert by it, so its link matches the destination', legacyItem?.key, `pause:devpanel-project/${issue.id}/${old}/${detailOld.pause.id}`)
    const records = await issues.readRunRecords('devpanel-project', issue.id, { journal: true })
    const damagedRecord = records.find((r) => r.runId === id)
    t.eq('the timing reader sees the journal recovery the inbox sees', damagedRecord?.recovery?.detectedAt, detail.recovery.detectedAt)
    const forAlert = await issues.readRunForWaits('devpanel-project', issue.id, id)
    t.eq('so does the alert page reader', `${forAlert?.packed}/${forAlert?.run?.recovery?.required}`, 'false/true')

    t.section('a malformed run record does not hide its readable siblings from time to response')
    {
      const pair = await issues.createIssue('devpanel-project', { name: 'Timing siblings' })
      const answered = '2026-11-25T15-00-00-000Z-ffffffff'
      const broken = '2026-11-25T16-00-00-000Z-abababab'
      await fs.mkdir(path.join(pair.path, 'runs', answered), { recursive: true })
      await fs.mkdir(path.join(pair.path, 'runs', broken), { recursive: true })
      await fs.writeFile(path.join(pair.path, 'runs', answered, 'run.json'), JSON.stringify({ runId: answered, status: 'running', startedAt: '2026-11-25T15:00:00.000Z', pause: null,
        steps: [{ role: 'operator', decision: { pauseId: 'p1', askedAt: '2026-11-25T15:01:00.000Z', at: '2026-11-25T15:04:00.000Z', actor: 'ana', answer: 'yes' } }] }))
      await fs.writeFile(path.join(pair.path, 'runs', answered, 'events.jsonl'), '')
      await fs.writeFile(path.join(pair.path, 'runs', broken, 'run.json'), '{"runId": "half')
      const report = await collectWaits({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues,
        readRunRecords: (p, i, options) => issues.readRunRecords(p, i, { ...options, journal: true }) })
      const mine = report.rows.filter((r) => r.key.includes(`/${pair.id}/`))
      t.eq("the answered run's question keeps its row", mine.map((r) => `${r.key}:${r.by}`).join(), `pause:devpanel-project/${pair.id}/${answered}/p1:ana`)
      const marked = report.unreadableRuns.filter((u) => u.issueId === pair.id)
      t.eq('the malformed sibling is one unreadable marker', `${marked.length}/${marked[0]?.runId}`, `1/${broken}`)
      t.ok('saying why', /does not parse/.test(marked[0]?.reason ?? ''), marked[0]?.reason)
      let rejected = null
      try { await issues.readRunRecords('devpanel-project', pair.id) } catch (error) { rejected = error.name }
      t.eq('a caller that asks for no unreadable list reads it as before (the whole reading fails)', rejected, 'SyntaxError')

      // Valid JSON with a field of the wrong shape: the API's and attention-times' collector contains it per run.
      await fs.writeFile(path.join(pair.path, 'runs', broken, 'run.json'), JSON.stringify({ runId: broken, status: 'failed', steps: [], recoveries: {} }))
      const shaped = await collectWaits({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues,
        readRunRecords: (p, i, options) => issues.readRunRecords(p, i, { ...options, journal: true }) })
      t.eq('a sibling with recoveries={} leaves the answered row', shaped.rows.filter((r) => r.key.includes(`/${pair.id}/`)).map((r) => `${r.key}:${r.by}`).join(), `pause:devpanel-project/${pair.id}/${answered}/p1:ana`)
      const shapedMarks = shaped.unreadableRuns.filter((u) => u.issueId === pair.id)
      t.eq('and is one unreadable marker naming the sibling', `${shapedMarks.length}/${shapedMarks[0]?.runId}`, `1/${broken}`)

      // A shape the issue listing's own summary cannot read (ownerInput.questions={}): caught where the listing reads it.
      await fs.writeFile(path.join(pair.path, 'runs', broken, 'run.json'), JSON.stringify({ runId: broken, status: 'completed', steps: [], ownerInput: { at: '2026-11-25T16:01:00.000Z', questions: {} } }))
      const listedPair = (await issues.listIssues('devpanel-project')).find((i) => i.id === pair.id)
      t.eq('the project listing still lists the issue, naming the run unreadable', `${Boolean(listedPair)}/${listedPair?.unreadableRuns?.join()}`, `true/${broken}`)
      const listedReport = await collectWaits({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues,
        readRunRecords: (p, i, options) => issues.readRunRecords(p, i, { ...options, journal: true }) })
      t.eq('the answered row stays', listedReport.rows.filter((r) => r.key.includes(`/${pair.id}/`)).map((r) => `${r.key}:${r.by}`).join(), `pause:devpanel-project/${pair.id}/${answered}/p1:ana`)
      const listedMarks = listedReport.unreadableRuns.filter((u) => u.issueId === pair.id)
      t.eq('beside one marker for the sibling', `${listedMarks.length}/${listedMarks[0]?.runId}`, `1/${broken}`)
      t.ok("and every other issue of the project keeps its rows (the journal issue's runs are still read)", listedReport.rows.some((r) => r.key.includes(`/${issue.id}/`)))

      // A shape that breaks the reader's own enrichment (withJournal sets pause.id): contained per record too.
      await fs.writeFile(path.join(pair.path, 'runs', broken, 'run.json'), JSON.stringify({ runId: broken, status: 'paused', steps: [], pause: 'bad pause' }))
      const enriched = await collectWaits({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues,
        readRunRecords: (p, i, options) => issues.readRunRecords(p, i, { ...options, journal: true }) })
      t.eq("pause='bad pause' leaves the answered row", enriched.rows.filter((r) => r.key.includes(`/${pair.id}/`)).map((r) => `${r.key}:${r.by}`).join(), `pause:devpanel-project/${pair.id}/${answered}/p1:ana`)
      const enrichedMarks = enriched.unreadableRuns.filter((u) => u.issueId === pair.id)
      t.eq('and gives one marker naming the sibling', `${enrichedMarks.length}/${enrichedMarks[0]?.runId}`, `1/${broken}`)
      await fs.rm(pair.path, { recursive: true, force: true })
    }

    t.section('a runs directory that cannot be listed makes the reading incomplete')
    if (process.getuid?.() === 0) t.skip('root reads a directory whatever its mode')
    else {
      const blocked = await issues.createIssue('devpanel-project', { name: 'Blocked runs' })
      await fs.mkdir(path.join(blocked.path, 'runs', '2026-11-25T14-00-00-000Z-eeeeeeee'), { recursive: true })
      await fs.chmod(path.join(blocked.path, 'runs'), 0o000)
      try {
        const listed = (await issues.listIssues('devpanel-project')).find((i) => i.id === blocked.id)
        t.eq('the issue names its runs directory as unreadable', listed?.unreadableNewerRuns?.join(), 'runs/')
        const read = await attentionItems({ listProjects: async () => ['devpanel-project'], listIssues: issues.listIssues, getTopSupervisor: () => null })
        t.eq('and the shared reading is not complete', `${read.unreadRuns.includes(`devpanel-project/${blocked.id}/runs/`)}/${read.complete}`, 'true/false')
      } finally { await fs.chmod(path.join(blocked.path, 'runs'), 0o755) }
      const readable = (await issues.listIssues('devpanel-project')).find((i) => i.id === blocked.id)
      t.eq('readable again: nothing is named', readable?.unreadableNewerRuns?.length, 0)
      await fs.rm(blocked.path, { recursive: true, force: true })
    }

    t.section('a packed issue keeps the retired journal interval')
    {
      const before = runWaits((await issues.readRunRecords('devpanel-project', issue.id, { journal: true })).find((r) => r.runId === legacy), { project: 'devpanel-project', issueId: issue.id }).filter((r) => r.kind === 'recovery')
      await packIssue({ issuesDir: root, project: 'devpanel-project', id: issue.id, issue: { id: issue.id } })
      t.ok('the issue folder is packed', !(await fs.stat(issue.path).then(() => true, () => false)))
      const packedRecord = (await issues.readRunRecords('devpanel-project', issue.id, { journal: true })).find((r) => r.runId === legacy)
      t.eq('the packed record carries the finding and its retirement', `${packedRecord?.journal?.retired}/${packedRecord?.journal?.finding?.detectedAt === finding.detectedAt}`, 'true/true')
      const after = runWaits(packedRecord, { project: 'devpanel-project', issueId: issue.id }).filter((r) => r.kind === 'recovery')
      t.eq('time to response reads the same retired interval after packing', JSON.stringify(after.map((r) => [r.key, r.enteredAt, r.handledAt, r.how])), JSON.stringify(before.map((r) => [r.key, r.enteredAt, r.handledAt, r.how])))
      t.eq('one retired row, entered at its finding', `${after.length}/${after[0]?.enteredAt === finding.detectedAt}/${after[0]?.how}`, '1/true/retired')
      const forAlertPacked = await issues.readRunForWaits('devpanel-project', issue.id, legacy)
      t.eq('the alert page reader sees it too', `${forAlertPacked?.packed}/${forAlertPacked?.run?.journal?.retired}`, 'true/true')

      t.section('an issue packed before rollout: the retired interval is read from the bundle')
      // The packer before this change wrote the runs index without journalTiming; the bundle itself is the same.
      const index = bundleFiles(root, 'devpanel-project', issue.id).runs
      const records = JSON.parse(await fs.readFile(index, 'utf8'))
      t.ok('the new packer always writes the field', records.every((r) => Object.hasOwn(r, 'journalTiming')))
      await fs.writeFile(index, JSON.stringify(records.map(({ journalTiming, ...r }) => r)))
      const oldRecord = (await issues.readRunRecords('devpanel-project', issue.id, { journal: true })).find((r) => r.runId === legacy)
      t.eq('the old-format record gets the finding and its retirement from the sidecars in the bundle', `${oldRecord?.journal?.retired}/${oldRecord?.journal?.finding?.detectedAt === finding.detectedAt}`, 'true/true')
      const oldRows = runWaits(oldRecord, { project: 'devpanel-project', issueId: issue.id }).filter((r) => r.kind === 'recovery')
      t.eq('time to response reads the same retired interval', JSON.stringify(oldRows.map((r) => [r.key, r.enteredAt, r.handledAt, r.how])), JSON.stringify(before.map((r) => [r.key, r.enteredAt, r.handledAt, r.how])))
      const damagedOld = (await issues.readRunRecords('devpanel-project', issue.id, { journal: true })).find((r) => r.runId === id)
      t.eq('a published (not retired) finding is read from the bundle too', damagedOld?.recovery?.detectedAt, detail.recovery.detectedAt)
      t.eq('and the alert page reader agrees', (await issues.readRunForWaits('devpanel-project', issue.id, legacy))?.run?.journal?.retired, true)
    }
  } finally {
    if (previous === undefined) delete process.env.DEVPANEL_ISSUES_DIR
    else process.env.DEVPANEL_ISSUES_DIR = previous
    await fs.rm(root, { recursive: true, force: true })
  }
}
