import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readRun } from '../server/runtime/store.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { closureWithAcceptances, riskId } from '../server/runtime/residual-risks.mjs'
import { listRuns } from '../server/runs-api.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { summariseIssue } from '../server/supervisor-summary.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'disposition, follow-ups and finishing — a completed run is not a resolved issue'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)
const start = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})
const refusal = async (fn) => { try { await fn() } catch (e) { return e } return null }
const wait = async (test) => { const end = Date.now() + 6000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

/** A run whose closing report leaves two risks open and accepts one. */
const withResiduals = () => {
  const base = scriptFor()
  return (turn) => {
    if (turn.stepId !== 'confirm') return base(turn)
    const rev = (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0]
    return `Report.${NL}${fence({ satisfied: true, revision: rev, criteria: [{ id: 'AC1', met: true, evidence: 'read' }], reasoning: 'ok', residualRisks: [
      { description: 'the reported exposure remains open by default', accepted: false, relatesTo: 'AC2' },
      { description: 'byte-cap loss is documented', accepted: true },
      { description: 'operator decision on the delivery uid is unanswered', accepted: false }
    ] })}`
  }
}

export default async function (t) {
  t.section('1. a disposition needs evidence, and "resolved" is refused while a run left risks open')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    t.eq('the run resolved by the playbook\'s bar', run.outcome, 'resolved')

    let threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'looked', runId: run.runId }) } catch (e) { threw = e }
    t.eq('resolved is refused', threw?.status, 409)
    t.ok('naming the open risks', /2 residual risk\(s\) unaccepted/.test(threw?.message ?? ''), threw?.message)

    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'partially-resolved', evidence: '  ', runId: run.runId }) } catch (e) { threw = e }
    t.ok('evidence is required', /evidence/.test(threw?.message ?? ''))

    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'fixed', evidence: 'x' }) } catch (e) { threw = e }
    t.ok('an unknown value is refused', /must be one of/.test(threw?.message ?? ''))

    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'looked' }) } catch (e) { threw = e }
    t.eq('omitting the run is not a way around its residuals', threw?.status, 409, threw?.message)
    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'looked', by: 'supervisor', override: 'I say so' }) } catch (e) { threw = e }
    t.eq('the supervisor cannot override', threw?.status, 409)
    const overridden = await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'the exposure was accepted by the operator out of band', by: 'operator', override: 'accepted in the weekly review' })
    t.eq('an operator may, with a stated reason on the record', overridden.disposition.override?.reason, 'accepted in the weekly review')
    t.eq('and the open risks are still recorded', overridden.disposition.openRisks.length, 2)

    const issue = await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'partially-resolved', evidence: 'resource exhaustion fixed; exposure open by ruling', runId: run.runId, by: 'supervisor' })
    t.eq('partially-resolved is recorded', issue.disposition.value, 'partially-resolved')
    t.eq('with its author', issue.disposition.by, 'supervisor')
    t.eq('and the open risks copied from the run', issue.disposition.openRisks.length, 2)
    const [listed] = await f.issues.listIssues('devpanel-project')
    t.eq('the list carries it', listed.disposition.value, 'partially-resolved')
    t.eq('the issue status is untouched', listed.status, 'open')

    // Archive without a disposition is always possible; it is recorded as an
    // override, with the reason when one was given.
    const g = await engineFixture()
    const bare = await g.issues.setIssueArchived('devpanel-project', g.issue.id, true)
    t.eq('archiving without a disposition or reason is accepted by storage', bare.archived, true)
    t.ok('and recorded as an override without a reason', bare.archiveOverride && bare.archiveOverride.reason === null)
    await g.issues.setIssueArchived('devpanel-project', g.issue.id, false)
    const archived = await g.issues.setIssueArchived('devpanel-project', g.issue.id, true, { overrideReason: 'duplicate of another issue' })
    t.eq('with a stated reason it is archived', archived.archived, true)
    t.eq('and the reason is on the record', archived.archiveOverride?.reason, 'duplicate of another issue')
  }

  t.section('2. follow-ups are created once per open risk, linked to the run')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    const first = await f.issues.createFollowUps('devpanel-project', f.issue.id, run.runId)
    t.eq('two follow-ups for two open risks', first.followUps.filter((x) => x.issueId).length, 2)
    const all = await f.issues.listIssues('devpanel-project')
    t.eq('the project now has three issues', all.length, 3)
    const followUp = all.find((i) => i.id === first.followUps[0].issueId)
    t.ok('named after the risk', followUp.name.startsWith('Follow-up: the reported exposure'), followUp.name)
    const report = await fs.readFile(path.join(followUp.path, '000-report', 'response.md'), 'utf8')
    t.ok('with provenance', report.includes(run.runId) && report.includes(f.issue.id))
    t.ok('and the rule that it does not absorb the defect', report.includes('keeps its own disposition'))
    const again = await f.issues.createFollowUps('devpanel-project', f.issue.id, run.runId)
    t.ok('a second call creates nothing new', again.followUps.every((x) => x.existing))
    t.eq('still three issues', (await f.issues.listIssues('devpanel-project')).length, 3)
    const { readRun } = await import('../server/runtime/store.mjs')
    const record = await readRun(f.issuePath, run.runId)
    t.eq('the run records the links by risk index', record.closure.followUps.map((x) => x.riskIndex).join(','), '0,2')
    const source = all.find((i) => i.id === f.issue.id)
    t.eq('the source issue has no disposition set by this', source.disposition, null)
  }

  t.section('3. the supervisor cannot archive without a disposition, and finish stops it after its runs')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-finish-'))
    const invocations = []
    let script = []
    const runs = new Map()
    const issueState = { disposition: null }
    const adapter = { invoke: async (args) => {
      invocations.push(args)
      const event = JSON.parse(args.prompt).event
      const action = script.shift()?.(event) ?? null
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
    } }
    const tools = {
      projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [{ id: 'i', status: 'open', name: 'n' }],
      getIssue: async () => ({ issue: { id: 'i', disposition: issueState.disposition }, reports: [], runs: [] }),
      preview: async () => ({ ok: true, configHash: 'h' }),
      start: async () => { const r = { runId: 'r1', status: 'running' }; runs.set('r1', r); return r },
      getRun: async (_p, _i, id) => runs.get(id) ?? { status: 'completed' }, stop: async (r) => { runs.get(r.runId).status = 'cancelled' },
      archive: async () => ({ archived: true }), createIssue: async () => ({}), addNote: async () => ({}),
      setDisposition: async (a) => { issueState.disposition = { value: a.value }; return { issue: { disposition: issueState.disposition } } },
      createFollowUps: async () => ({ followUps: [] })
    }
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    script = [
      () => ({ type: 'archive_issue', project: 'p', issueId: 'i' }),
      () => ({ type: 'set_disposition', project: 'p', issueId: 'i', value: 'partially-resolved', evidence: 'checked the closure' }),
      () => ({ type: 'archive_issue', project: 'p', issueId: 'i' }),
      () => ({ type: 'preview', project: 'p', issueId: 'i', playbook: 'x' }),
      (e) => ({ type: 'start_run', project: 'p', issueId: 'i', previewId: e.result.previewId }),
      () => ({ type: 'finish' })
    ]
    await agent.start({ model: 'm', projects: ['p'], message: 'go', allowArchive: true, limits: { maxCalls: 20, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => agent.get().finishing === true && agent.get().status === 'active')
    const tool = (i) => agent.get().messages.filter((m) => m.role === 'tool')[i]?.text ?? ''
    t.ok('archiving without a disposition is refused', tool(0).includes('Set a disposition'))
    t.ok('setting one works', tool(1).includes('partially-resolved'))
    t.ok('archiving then succeeds', tool(2).includes('archived'))
    t.eq('the run was started before finish', runs.get('r1')?.status, 'running')
    t.eq('finishing is on', agent.get().finishing, true)
    t.eq('the activation is still active while a run is live', agent.get().status, 'active')
    let refused = false
    try { await agent.chat('one more') ; await wait(() => invocations.length >= 8) } catch { refused = true }
    // A start during finishing is refused by the guard even if asked for.
    runs.get('r1').status = 'completed'
    await wait(() => agent.get().status === 'stopped')
    t.eq('once the run completes the activation stops on its own', agent.get().status, 'stopped')
    t.eq('with the reason', agent.get().reason, 'finished')
    t.eq('the owned run was not cancelled', runs.get('r1').status, 'completed')
    void refused
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('4. split and duplicate name the issues they point to, and each must exist')
  {
    const f = await engineFixture({})
    const P = 'devpanel-project'
    const partA = await f.issues.createIssue(P, { name: 'Part A' })
    const partB = await f.issues.createIssue(P, { name: 'Part B' })

    let threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'broken down' }))
    t.ok('split without its parts is refused', /split into/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'duplicate', evidence: 'same', related: [partA.id, partB.id] }))
    t.ok('a duplicate names exactly one original', /exactly one/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'x', related: ['2026-01-01-no-such-issue'] }))
    t.eq('a related issue must exist', threw?.status, 404)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'x', related: [f.issue.id] }))
    t.ok('an issue cannot be split into itself', /its own issue/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'x', related: 'Part A' }))
    t.ok('related is a list', /list of issue ids/.test(threw?.message ?? ''), threw?.message)

    const split = await f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'six findings became six issues', related: [partA.id, `${P}/${partB.id}`, partA.id] })
    t.eq('split records its parts once each, in either spelling', split.disposition.related, [{ project: P, id: partA.id }, { project: P, id: partB.id }])
    const declined = await f.issues.setIssueDisposition(P, partB.id, { value: 'declined', evidence: 'out of scope for this release' })
    t.eq('declined needs no related issues', [declined.disposition.value, declined.disposition.related], ['declined', []])
  }

  t.section('5. unaccepted risks are stated up front: explanation and issue summary list the same set')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    const P = 'devpanel-project'
    const issue = await f.issues.getIssue(P, f.issue.id)
    const stated = issue.unacceptedRisks
    t.eq('the issue names the run a disposition would rest on', stated?.runId, run.runId)
    t.eq('and only the risks left unaccepted', stated?.risks.map((r) => r.text), ['the reported exposure remains open by default', 'operator decision on the delivery uid is unanswered'])
    t.eq('each with an id and what it relates to', [stated?.risks[0].id, stated?.risks[0].relatesTo], [riskId('the reported exposure remains open by default'), 'AC2'])
    t.eq('and the two choices', stated?.choices.map((c) => c.choice), ['accept', 'partially-resolved'])

    const record = await readRun(f.issuePath, run.runId)
    const explained = explainRun(record)
    t.eq('the run explanation lists the same', explained.unacceptedRisks, stated)
    t.ok('and says the choices to a person', /accept each with a reason; otherwise record partially-resolved/.test(explained.next), explained.next)
    t.eq('a run whose risks are all accepted lists nothing', explainRun({ ...record, closure: { ...record.closure, residualRisks: [{ description: 'x', accepted: true }, { description: 'y' }] } }).unacceptedRisks, undefined)
    const summary = summariseIssue({ issue, reports: [], runs: [] })
    t.eq('the supervisor\'s issue summary carries it, unclipped', summary.issue.unacceptedRisks, stated)
    t.eq('the list is what a resolved refuses on', (await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'resolved', evidence: 'x' })))?.message.match(/(\d+) residual risk/)?.[1], String(stated.risks.length))
  }

  t.section('6. one call accepts every risk and records resolved; id and text both name a risk')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    const P = 'devpanel-project'
    const [first, second] = (await f.issues.getIssue(P, f.issue.id)).unacceptedRisks.risks
    const issue = await f.issues.setIssueDisposition(P, f.issue.id, { value: 'resolved', evidence: 'checked the closure', acceptRisks: [{ id: first.id, reason: ' behind the proxy on this host ' }, { text: second.text, reason: 'the uid is settled by the install' }] })
    t.eq('resolved is recorded without a prior refusal', issue.disposition.value, 'resolved')
    t.eq('resting on the run that left them', issue.disposition.runId, run.runId)
    t.eq('no risk is left open', issue.disposition.openRisks, [])
    t.eq('no override was needed', issue.disposition.override, null)
    t.eq('each reason is on the record', issue.acceptedRisks.map((a) => a.reason), ['behind the proxy on this host', 'the uid is settled by the install'])
    t.eq('with who accepted it', issue.acceptedRisks.map((a) => a.by), ['operator', 'operator'])
    t.eq('and the run and risk it binds to', [issue.acceptedRisks[1].runId, issue.acceptedRisks[1].text], [run.runId, second.text])
    t.eq('the issue no longer lists them', issue.unacceptedRisks, null)
    const record = await readRun(f.issuePath, run.runId)
    t.eq('the run record keeps what the coordinator said', record.closure.residualRisks.filter((r) => r.accepted === false).length, 2)
    t.eq('the explanation no longer lists them', explainRun(record, { acceptedRisks: issue.acceptedRisks }).unacceptedRisks, undefined)
    const [row] = await listRuns(f.issuePath)
    t.eq('nor does the run row', row.explanation.unacceptedRisks, undefined)
    const closure = closureWithAcceptances(record, issue.acceptedRisks)
    t.eq('the closure a reader sees has them accepted, with the reason', [closure.residualRisks[0].accepted, closure.residualRisks[0].acceptance.reason], [true, 'behind the proxy on this host'])
    const later = await f.issues.setIssueDisposition(P, f.issue.id, { value: 'partially-resolved', evidence: 'reconsidered' })
    t.eq('a later disposition keeps them accepted', [later.disposition.openRisks, later.acceptedRisks.length], [[], 2])
    const followUps = await f.issues.createFollowUps(P, f.issue.id, run.runId)
    t.eq('and no follow-up is opened for an accepted risk', followUps.followUps, [])

    // A summary cached before the acceptance must not go on listing the risk.
    const g = await engineFixture({ script: withResiduals() })
    const other = await start(g)
    await other.drive()
    await releaseWorkspace(other)
    const whole = (await g.issues.getIssue(P, g.issue.id)).unacceptedRisks.risks.map((r) => ({ ...r, reason: 'copied whole from the list' }))
    const copied = await g.issues.setIssueDisposition(P, g.issue.id, { value: 'resolved', evidence: 'x', acceptRisks: whole, by: 'supervisor' })
    t.eq('an entry copied whole from the list matches, by supervisor', [copied.disposition.value, copied.acceptedRisks.map((a) => a.by)], ['resolved', ['supervisor', 'supervisor']])
    t.eq('the cached run summary changed with the acceptance', copied.latestRun.explanation.unacceptedRisks, undefined)
  }

  t.section('7. a refused call records nothing; resolved without acceptRisks names the route')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    const P = 'devpanel-project'
    const before = await fs.readFile(path.join(f.issuePath, 'issue.json'), 'utf8').catch(() => null)
    const [first, second] = (await f.issues.getIssue(P, f.issue.id)).unacceptedRisks.risks
    const both = [{ id: first.id, reason: 'r' }, { id: second.id, reason: 'r' }]
    const refusals = {
      'an entry matching no risk': { value: 'resolved', evidence: 'x', acceptRisks: [...both, { id: 'risk-000000000000', reason: 'r' }] },
      'a risk the coordinator already accepted': { value: 'resolved', evidence: 'x', acceptRisks: [...both, { text: 'byte-cap loss is documented', reason: 'r' }] },
      'a missing reason': { value: 'resolved', evidence: 'x', acceptRisks: [both[0], { id: second.id }] },
      'a blank reason': { value: 'resolved', evidence: 'x', acceptRisks: [both[0], { id: second.id, reason: '  ' }] },
      'an entry naming nothing': { value: 'resolved', evidence: 'x', acceptRisks: [{ reason: 'r' }] },
      'id and text naming different risks': { value: 'resolved', evidence: 'x', acceptRisks: [{ id: first.id, text: second.text, reason: 'r' }] },
      'the same risk with two reasons': { value: 'resolved', evidence: 'x', acceptRisks: [both[0], { text: first.text, reason: 'other' }, both[1]] },
      'an unknown field': { value: 'resolved', evidence: 'x', acceptRisks: [{ ...both[0], override: 'y' }] },
      'not a list': { value: 'resolved', evidence: 'x', acceptRisks: both[0] },
      'risks left unaccepted under resolved': { value: 'resolved', evidence: 'x', acceptRisks: [both[0]] },
      'any other refusal: no evidence': { value: 'resolved', evidence: ' ', acceptRisks: both },
      'any other refusal: a related issue that does not exist': { value: 'split', evidence: 'x', related: ['2026-01-01-no-such-issue'], acceptRisks: both },
      'any other refusal: a run that does not exist': { value: 'resolved', evidence: 'x', runId: 'no-such-run', acceptRisks: both }
    }
    for (const [what, call] of Object.entries(refusals)) {
      const threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, call))
      t.ok(`${what} is refused`, threw instanceof f.issues.IssueError, threw?.message)
      t.eq('and issue.json is untouched', await fs.readFile(path.join(f.issuePath, 'issue.json'), 'utf8').catch(() => null), before)
    }
    const after = await f.issues.getIssue(P, f.issue.id)
    t.eq('neither an acceptance nor a disposition is on record', [after.acceptedRisks, after.disposition], [[], null])
    t.eq('and both risks are still listed', after.unacceptedRisks.risks.length, 2)

    const named = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'resolved', evidence: 'x', runId: run.runId }))
    t.eq('resolved without acceptRisks is refused', named?.status, 409)
    t.ok('naming the route and the ids', named?.message.includes('acceptRisks') && named.message.includes(first.id) && !named.message.includes('on the record first'), named?.message)
    const partly = await f.issues.setIssueDisposition(P, f.issue.id, { value: 'partially-resolved', evidence: 'x', acceptRisks: [both[0]] })
    t.eq('partially-resolved may accept some, leaving the rest open', [partly.acceptedRisks.length, partly.disposition.openRisks.map((r) => r.description)], [1, [second.text]])
    t.eq('the listing narrows to the rest', partly.unacceptedRisks.risks.map((r) => r.id), [second.id])
    t.ok('a risk accepted once is no longer unaccepted to name', /names no unaccepted/.test((await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'resolved', evidence: 'x', acceptRisks: [both[0], both[1]] })))?.message ?? ''))
    const refusedSupervisor = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'resolved', evidence: 'x', by: 'supervisor', override: 'I say so' }))
    t.eq('the supervisor still has no override', refusedSupervisor?.status, 409)
    const overridden = await f.issues.setIssueDisposition(P, f.issue.id, { value: 'resolved', evidence: 'x', override: 'weekly review' })
    t.eq('an operator\'s override works as before, the risk staying open', [overridden.disposition.override, overridden.disposition.openRisks.length, overridden.acceptedRisks.length], [{ reason: 'weekly review', openRisksAtOverride: 1 }, 1, 1])
  }

  t.section('8. the supervisor\'s contract carries acceptRisks to the same recording path')
  {
    const action = (acceptRisks) => JSON.stringify({ message: 'ok', action: { type: 'set_disposition', project: 'p', issueId: 'i', value: 'resolved', evidence: 'e', acceptRisks } })
    t.eq('a well-formed value passes the validator', parseSupervisorResponse(action([{ id: 'risk-1', reason: 'r' }, { text: 't', reason: 'r' }])).action.acceptRisks.length, 2)
    for (const [what, bad] of Object.entries({ 'a string': 'x', null: null, 'an object': { id: 'a', reason: 'r' }, 'a non-object entry': ['risk-1'], 'no name': [{ reason: 'r' }], 'no reason': [{ id: 'a' }], 'a blank reason': [{ id: 'a', reason: ' ' }], 'a non-string id': [{ id: 1, reason: 'r' }], 'an unknown field': [{ id: 'a', reason: 'r', override: 'x' }] })) {
      let threw = false
      try { parseSupervisorResponse(action(bad)) } catch { threw = true }
      t.ok(`${what} is rejected`, threw)
    }
    let otherAction = false
    try { parseSupervisorResponse(JSON.stringify({ message: 'ok', action: { type: 'archive_issue', project: 'p', issueId: 'i', acceptRisks: [] } })) } catch { otherAction = true }
    t.ok('another action does not take the field', otherAction)

    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    await engine.drive()
    await releaseWorkspace(engine)
    const P = 'devpanel-project'
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-accept-'))
    const script = []
    let charter = ''
    const adapter = { invoke: async (args) => {
      charter = args.instructions
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: script.shift() ?? null }), usage: { costUsd: 0 } }
    } }
    // As top-supervisor-service.mjs maps it, onto the real recording path.
    const tools = {
      projects: async () => [{ id: P }], playbooks: async () => [], listIssues: async () => [], getIssue: async () => ({}),
      setDisposition: (a) => f.issues.setIssueDisposition(a.project, a.issueId, { value: a.value, evidence: a.evidence, runId: a.runId ?? null, related: a.related ?? null, acceptRisks: a.acceptRisks ?? null, by: 'supervisor' })
    }
    const risks = (await f.issues.getIssue(P, f.issue.id)).unacceptedRisks.risks
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    script.push({ type: 'set_disposition', project: P, issueId: f.issue.id, value: 'resolved', evidence: 'read the closure', acceptRisks: risks.map((r) => ({ id: r.id, reason: 'acceptable here' })) })
    await agent.start({ model: 'm', projects: [P], message: 'go', limits: { maxCalls: 5, maxRuns: 1, maxConcurrent: 1, maxStartsPerIssue: 1 } })
    await wait(() => agent.get().messages.some((m) => m.role === 'tool'))
    const issue = await f.issues.getIssue(P, f.issue.id)
    t.eq('one supervisor call records resolved', issue.disposition?.value, 'resolved')
    t.eq('by the supervisor', [issue.disposition?.by, issue.acceptedRisks.map((a) => a.by)], ['supervisor', ['supervisor', 'supervisor']])
    t.ok('the prompt names the field', charter.includes('set_disposition {project,issueId,value,evidence,runId?,related?,acceptRisks?}'))
    t.ok('and no longer says only partially-resolved is open', !charter.includes('unaccepted — use partially-resolved'))
    await agent.stop()
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })

    // Neither wiring runs in this suite (no server, no real service): it is read from the source.
    const source = async (file) => fs.readFile(new URL(`../server/${file}`, import.meta.url), 'utf8')
    t.ok('the supervisor service passes the field, as supervisor', /setIssueDisposition\([^)]*acceptRisks:a\.acceptRisks\?\?null,by:'supervisor'/.test(await source('top-supervisor-service.mjs')))
    t.ok('the route passes the field, as operator', /setIssueDisposition\(project, id, \{[^}]*by: 'operator'[^}]*acceptRisks \}\)/.test(await source('index.js')))
  }

  await cleanupFixtures()
}
