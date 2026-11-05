import fs from 'node:fs/promises'
import path from 'node:path'

import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { inquiryState, inquiryPackable } from '../server/inquiry.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { buildOverview } from '../server/supervisor-overview.mjs'
import { attentionList } from '../server/attention.mjs'
import { acquire } from '../server/runtime/lock.mjs'

export const name = 'Phase 4 — supervisor inquiries: a question answered without an issue ticket'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const finding = { key: 'missing-check', kind: 'bug', title: 'Missing check', description: 'A check is missing.', evidence: ['source.txt:1'], acceptanceCriteria: ['Reject invalid input'] }

function script (disposition) {
  return (turn) => {
    const { stepId } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Investigate.', windowDecision: 'keep' })
    if (stepId.startsWith('investigate')) return fence({ summary: 'Read source', findings: disposition === 'accepted' ? [finding] : [], openQuestions: [] })
    if (stepId === 'disposition') return fence({ disposition, reasoning: 'Read the reports', response: 'The answer is 42.', issues: disposition === 'accepted' ? [finding] : [] })
    return scriptFor()(turn)
  }
}

export default async function (t) {
  t.section('1. the state table, driven by engine-shaped records')
  {
    const s = (run, extra = {}) => inquiryState({ run, ...extra })
    t.eq('no run: a draft, no row', [s(null).row, s(null).state], [null, 'draft'])
    t.eq('unreadable: row 0', s(null, { unreadable: true }).row, 0)
    for (const status of ['pending', 'preflighting', 'running', 'stopping']) t.eq(`${status}: running (1)`, s({ status }).row, 1)
    t.eq('a pending launch is running', s({ status: 'completed', reportDisposition: { disposition: 'accepted' } }, { pending: true }).row, 1)
    t.eq('paused: 2', s({ status: 'paused' }).row, 2)
    t.eq('recovery-required: 3', s({ status: 'blocked', blockedReason: 'recovery-required' }).row, 3)
    t.eq('owner-lost: 3', s({ status: 'blocked', blockedReason: 'owner-lost' }).row, 3)
    t.eq('quarantined: 3', s({ status: 'completed', integrity: { status: 'quarantined' }, reportDisposition: { disposition: 'accepted' } }).row, 3)
    for (const d of ['accepted', 'no-findings', 'duplicate', 'rejected']) t.eq(`completed ${d}: answered (4)`, s({ status: 'completed', reportDisposition: { disposition: d } }).row, 4)
    t.eq('needs-information: 5, acknowledge', [s({ status: 'completed', reportDisposition: { disposition: 'needs-information' } }).row, s({ status: 'completed', reportDisposition: { disposition: 'needs-information' } }).closable], [5, 'acknowledge'])
    t.eq('completed, unresolved, no disposition (abort): 6, close', [s({ status: 'completed', outcome: 'unresolved' }).row, s({ status: 'completed', outcome: 'unresolved' }).closable], [6, 'close'])
    t.eq('completed without disposition and not unresolved: 0', s({ status: 'completed', outcome: 'resolved' }).row, 0)
    for (const reason of ['budget-exhausted', 'rounds-exhausted', 'disagreement', 'protocol-repair-exhausted']) t.eq(`blocked ${reason}: 7`, s({ status: 'blocked', blockedReason: reason }).row, 7)
    t.eq('cancelled: 8', s({ status: 'cancelled' }).row, 8)
    for (const [c, next] of [['transient', 'already retried in-run'], ['quota', 'may be started again once the model is available'], ['auth', 'needs a person']]) {
      const st = s({ status: 'failed', failure: { class: c } })
      t.eq(`failed ${c}: 9, ${next}`, [st.row, st.next], [9, next])
    }
    t.eq('unknown status: 0', s({ status: 'weird' }).row, 0)
  }

  t.section('2. the packing predicate, apart from the state')
  {
    const inquiry = { kind: 'inquiry', inquiry: { closure: null } }
    const answered = { status: 'completed', reportDisposition: { disposition: 'no-findings' } }
    const base = { inquiry, run: answered, latestRunId: 'r1', liveness: 'none', settled: true, pending: false }
    t.eq('answered and settled packs', inquiryPackable(base).packable, true)
    t.eq('an alive owner does not', inquiryPackable({ ...base, liveness: 'alive' }).packable, false)
    t.eq('unknown liveness does not', inquiryPackable({ ...base, liveness: 'unknown' }).packable, false)
    t.eq('unsettled does not', inquiryPackable({ ...base, settled: false }).packable, false)
    t.eq('a pending start does not', inquiryPackable({ ...base, pending: true }).packable, false)
    t.eq('a draft never packs', inquiryPackable({ ...base, run: null }).packable, false)
    const blocked = { status: 'blocked', blockedReason: 'budget-exhausted' }
    t.eq('blocked without a close does not', inquiryPackable({ ...base, run: blocked }).packable, false)
    t.eq('blocked with a close for this run does', inquiryPackable({ ...base, run: blocked, inquiry: { kind: 'inquiry', inquiry: { closure: { action: 'close', runId: 'r1' } } } }).packable, true)
    t.eq('a close for an older run does not', inquiryPackable({ ...base, run: blocked, inquiry: { kind: 'inquiry', inquiry: { closure: { action: 'close', runId: 'r0' } } } }).packable, false)
    t.eq('needs-information needs acknowledge, not close', inquiryPackable({ ...base, run: { status: 'completed', reportDisposition: { disposition: 'needs-information' } }, inquiry: { kind: 'inquiry', inquiry: { closure: { action: 'close', runId: 'r1' } } } }).packable, false)
    t.eq('recovery never packs', inquiryPackable({ ...base, run: { status: 'blocked', blockedReason: 'recovery-required' }, inquiry: { kind: 'inquiry', inquiry: { closure: { action: 'close', runId: 'r1' } } } }).packable, false)
  }

  t.section('3. the action vocabulary')
  {
    const ok = (action) => parseSupervisorResponse(JSON.stringify({ message: 'm', action }))
    t.ok('inquire parses with relatedIssue and runOptions', Boolean(ok({ type: 'inquire', project: 'p', question: 'why?', relatedIssue: '2026-09-30-x', runOptions: { participants: {} } })))
    t.ok('close_inquiry needs a reason', (() => { try { ok({ type: 'close_inquiry', project: 'p', inquiryId: 'i', runId: 'r' }); return false } catch { return true } })())
    t.ok('acknowledge_inquiry parses', Boolean(ok({ type: 'acknowledge_inquiry', project: 'p', inquiryId: 'i', runId: 'r' })))
    t.ok('create_issue with fromInquiry parses', Boolean(ok({ type: 'create_issue', project: 'p', input: 'x', fromInquiry: { inquiryId: 'i', runId: 'r', key: 'k' } })))
    t.ok('a malformed fromInquiry is refused', (() => { try { ok({ type: 'create_issue', project: 'p', input: 'x', fromInquiry: { inquiryId: 'i' } }); return false } catch { return true } })())
  }

  // One fixture: an ordinary issue (the fixture's) and inquiries beside it.
  let current = script('accepted')
  const f = await engineFixture({ playbook: 'analysis', script: (turn) => current(turn) })
  const project = 'devpanel-project'
  const projectDir = path.dirname(f.issuePath)
  const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot })
  const runInquiry = async (inquiry, disposition, runOptions = { inquiry: true }) => {
    current = script(disposition)
    const resolved = await resolvePlaybook('analysis', { root: f.configRoot, runOptions, projectId: project })
    const engine = await startRun({ expectConfigHash: resolved.resolved.configHash, playbookId: 'analysis', issue: { ...inquiry, project }, issuePath: inquiry.path,
      projectPath: f.projectPath, harnesses: f.harnesses, stepStore: { create: (o) => f.issues.createStep(project, inquiry.id, o) }, workspaceProvider: f.workspaceProvider,
      configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions })
    await engine.drive()
    await releaseWorkspace(engine)
    return engine
  }
  const issueDirs = async () => (await fs.readdir(projectDir, { withFileTypes: true })).filter((e) => e.isDirectory() && /^\d{4}-/.test(e.name)).map((e) => e.name).sort()

  t.section('4. an inquiry is stored as an issue of kind inquiry, and kept out of issue views')
  let answered
  {
    answered = await f.issues.createInquiry(project, { question: 'Why does the checkout fail?\nDetails follow.', relatedIssue: f.issue.id })
    t.eq('kind inquiry', answered.kind, 'inquiry')
    t.eq('the question and related issue are recorded', [answered.inquiry.question.split('\n')[0], answered.inquiry.relatedIssue], ['Why does the checkout fail?', f.issue.id])
    t.ok('the report is the question', (await fs.readFile(path.join(answered.path, '000-report', 'response.md'), 'utf8')).includes('Why does the checkout fail?'))
    t.ok('internal enumeration sees it (admission)', (await f.issues.listIssues(project)).some((i) => i.id === answered.id))
    const overview = await buildOverview({ projects: [project], listIssues: (p, o) => f.issues.listIssues(p, o) })
    const line = overview.projects?.find?.((p) => p.project === project) ?? overview.find?.((p) => p.project === project) ?? null
    t.ok('the overview lists it as an inquiry, not an open issue', line && !line.openIssues.some((i) => i.id === answered.id) && line.inquiries?.some((i) => i.id === answered.id), JSON.stringify(line).slice(0, 300))
    t.ok('Needs attention skips it', !(await attentionList({ listProjects: async () => [project], listIssues: (p) => f.issues.listIssues(p) })).some((e) => e.issueId === answered.id || e.id === answered.id))
    t.ok('it takes no priority', await f.issues.setIssuePriority(project, answered.id, { value: 'high', reason: 'x' }).then(() => false, (e) => /no priority/.test(e.message)))
    t.ok('and no disposition', await f.issues.setIssueDisposition(project, answered.id, { value: 'resolved', evidence: 'x' }).then(() => false, (e) => /no disposition/.test(e.message)))
    t.ok('a related issue must exist', await f.issues.createInquiry(project, { question: 'q', relatedIssue: '2026-01-01-nope' }).then(() => false, (e) => e.status === 404))
  }

  t.section('5. the flag is frozen in the snapshot and only an inquiry runs as one')
  {
    const bad = await resolvePlaybook('implementation', { root: f.configRoot, runOptions: { inquiry: true }, projectId: project })
    t.ok('another tactic refuses the flag', !bad.ok && bad.errors.some((e) => /analysis tactic only/.test(e.message)))
    const good = await resolvePlaybook('analysis', { root: f.configRoot, runOptions: { inquiry: true }, projectId: project })
    const plain = await resolvePlaybook('analysis', { root: f.configRoot, runOptions: {}, projectId: project })
    t.ok('it is part of the configuration hash', good.ok && good.resolved.configHash !== plain.resolved.configHash)
    t.ok('an ordinary issue refuses an inquiry start', await supervisor.start({ project, issueId: f.issue.id, playbookId: 'analysis', runOptions: { inquiry: true } }).then(() => false, (e) => /only an inquiry/.test(e.message)))
    t.ok('an inquiry refuses another playbook', await supervisor.start({ project, issueId: answered.id, playbookId: 'implementation', runOptions: {} }).then(() => false, (e) => /only the analysis playbook/.test(e.message)))
  }

  t.section('6. the effect policy: findings are proposals, nothing is published')
  {
    const before = await issueDirs()
    const engine = await runInquiry(answered, 'accepted')
    t.eq('the run completed', engine.run.status, 'completed')
    t.eq('no issue was published', engine.run.reportDisposition.issues, [])
    t.eq('the finding is kept as a proposal', engine.run.reportDisposition.proposals.map((p) => p.key), ['missing-check'])
    t.eq('no issue directory appeared', await issueDirs(), before)
    t.ok('the related issue got nothing appended', !(await fs.readdir(f.issuePath)).some((n) => /tactical|finding/.test(n)))
    const status = await supervisor.inquiryStatus({ project, inquiryId: answered.id })
    t.eq('answered (row 4)', [status.row, status.state], [4, 'answered'])
    t.eq('the answer is the disposition', [status.answer.disposition, status.answer.response], ['accepted', 'The answer is 42.'])

    t.section('7. a proposal becomes one issue, once')
    const made = await f.issues.createIssue(project, { input: 'Missing check', fromInquiry: { inquiryId: answered.id, runId: engine.runId, key: 'missing-check' } })
    t.eq('it records where it came from', made.fromInquiry, { inquiryId: answered.id, runId: engine.runId, key: 'missing-check' })
    t.ok('a second creation is refused', await f.issues.createIssue(project, { input: 'Missing check again', fromInquiry: { inquiryId: answered.id, runId: engine.runId, key: 'missing-check' } }).then(() => false, (e) => e.status === 409))
    t.ok('an unknown key is refused', await f.issues.createIssue(project, { input: 'Other', fromInquiry: { inquiryId: answered.id, runId: engine.runId, key: 'nope' } }).then(() => false, (e) => e.status === 404))

    t.section('8. an answered inquiry packs once settled, keeping its answer')
    const packed = await supervisor.packInquiry({ project, inquiryId: answered.id })
    t.eq('packed', packed.packed, true, packed.reason)
    const after = await f.issues.getIssue(project, answered.id)
    t.eq('it reads as packed', after.packed, true)
    const status2 = await supervisor.inquiryStatus({ project, inquiryId: answered.id })
    t.eq('its state says so', status2.packed, true)
    // Audit I4: packing must not take the answer away from the supervisor.
    t.eq('the answer is still readable', status2.answer?.disposition, 'accepted', JSON.stringify(status2))
    t.eq('with its proposals', status2.answer?.proposals?.map((p) => p.key), ['missing-check'])
    t.eq('and its row', status2.row, 4)
    t.ok('a second proposal issue is still refused after packing', await f.issues.createIssue(project, { input: 'Missing check again', fromInquiry: { inquiryId: answered.id, runId: engine.runId, key: 'missing-check' } }).then(() => false, (e) => e.status === 409))
    await f.issues.setIssueArchived(project, made.id, true)
    t.ok('also when the derived issue is itself packed', await f.issues.createIssue(project, { input: 'Missing check again', fromInquiry: { inquiryId: answered.id, runId: engine.runId, key: 'missing-check' } }).then(() => false, (e) => e.status === 409))
    const plain = await f.issues.createIssue(project, { input: 'An ordinary issue' })
    await f.issues.setIssueArchived(project, plain.id, true)
    t.ok('reopen_inquiry refuses an ordinary packed issue', await supervisor.reopenInquiry({ project, inquiryId: plain.id, reason: 'x' }).then(() => false, (e) => e.status === 409))
    t.eq('and leaves it packed', (await f.issues.getIssue(project, plain.id)).packed, true)
    t.ok('an unknown key is still 404, not "no run"', await f.issues.createIssue(project, { input: 'x', fromInquiry: { inquiryId: answered.id, runId: engine.runId, key: 'nope' } }).then(() => false, (e) => e.status === 404 && /proposed no finding/.test(e.message)))
  }

  t.section('9. needs-information takes an acknowledgement bound to the latest run')
  {
    const q = await f.issues.createInquiry(project, { question: 'What is the timeout?' })
    const engine = await runInquiry(q, 'needs-information')
    const st = await supervisor.inquiryStatus({ project, inquiryId: q.id })
    t.eq('row 5', [st.row, st.closable], [5, 'acknowledge'])
    t.eq('not packed by itself', (await supervisor.packInquiry({ project, inquiryId: q.id })).packed, false)
    t.ok('close is the wrong action', await supervisor.closeInquiry({ project, inquiryId: q.id, runId: engine.runId, action: 'close', reason: 'x' }).then(() => false, (e) => /takes acknowledge/.test(e.message)))
    t.ok('a stale run id is refused', await supervisor.closeInquiry({ project, inquiryId: q.id, runId: 'run-older', action: 'acknowledge' }).then(() => false, (e) => /stale/.test(e.message)))
    // The admission lock is durable: held elsewhere, the acknowledgement waits for it.
    const held = await acquire(path.join(f.issues.ISSUES_DIR, project, '.admission.lock'), { purpose: 'test' })
    let done = false
    const pending = supervisor.closeInquiry({ project, inquiryId: q.id, runId: engine.runId, action: 'acknowledge', by: 'supervisor' }).then((r) => { done = true; return r })
    await new Promise((r) => setTimeout(r, 300))
    t.eq('it waits while the admission lock is held', done, false)
    await held.release()
    const r = await pending
    t.eq('then acknowledges and packs', [r.closed, r.packed], ['acknowledge', true], r.notPacked)
  }

  t.section('10. a closed inquiry is terminal until reopened')
  {
    const q = await f.issues.createInquiry(project, { question: 'Is the cache warm?' })
    const engine = await runInquiry(q, 'needs-information')
    // Recorded closure, not yet packed (as if packing had failed): nothing may continue it.
    await f.issues.setInquiryClosure(project, q.id, { action: 'acknowledge', by: 'operator', at: new Date().toISOString(), runId: engine.runId, reason: null, row: 5 })
    t.ok('start is refused', await supervisor.start({ project, issueId: q.id, playbookId: 'analysis', runOptions: { inquiry: true } }).then(() => false, (e) => /is closed/.test(e.message)))
    t.ok('resume is refused', await supervisor.answer({ project, issueId: q.id, runId: engine.runId, resume: true }).then(() => false, (e) => /is closed/.test(e.message)))
    const reopened = await supervisor.reopenInquiry({ project, inquiryId: q.id, reason: 'more to ask', by: 'operator' })
    t.eq('reopen removes it', reopened.reopened, true)
    const after = await f.issues.getIssue(project, q.id)
    t.ok('the old closure is kept in history with who reopened it', after.inquiry.closure === null && after.inquiry.history.at(-1)?.reopened?.reason === 'more to ask')
    t.eq('the ordinary rows apply again', (await supervisor.inquiryStatus({ project, inquiryId: q.id })).row, 5)
    t.ok('reopening needs a reason', await supervisor.reopenInquiry({ project, inquiryId: q.id, reason: ' ' }).then(() => false, (e) => e.status === 400))
  }
  t.section('an inquiry over an archived id gets its own')
  {
    const first = await f.issues.createInquiry(project, { question: 'Asked twice, archived between?' })
    await f.issues.setIssueArchived(project, first.id, true, { overrideReason: 'test' })
    const again = await f.issues.createInquiry(project, { question: 'Asked twice, archived between?' })
    t.eq('another id, still an inquiry', [again.id, again.kind], [`${first.id}-2`, 'inquiry'])
  }
  await supervisor.shutdown?.().catch?.(() => {})
}
