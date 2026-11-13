import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'

export const name = 'top-level supervisor — it consults the panel before it asks the operator'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const brief = { question: 'Elfogadjuk a hibát?', why: 'Ettől függ a szállítás.', options: [{ label: 'Igen', consequence: 'a' }, { label: 'Nem', consequence: 'b' }], recommendation: 'Igen.', positions: [{ seat: 'consultant-1', choice: 'recommended' }, { seat: 'consultant-2', choice: 'other' }] }
const opinions = [{ seat: 'consultant-1', model: 'fable-5-2', verdict: 'answer', choice: 'recommended', answer: 'Fix it in the framework.', confidence: 'high', reasoning: 'r1' }, { seat: 'consultant-2', model: 'gpt-6-astra', verdict: 'answer', choice: 'recommended', answer: 'Fix it in the framework.', confidence: 'high', reasoning: 'r2' }]

export default async function (t) {
  t.section('1. the action vocabulary')
  {
    const ok = (action) => { try { parseSupervisorResponse(JSON.stringify({ message: 'm', action })); return true } catch { return false } }
    t.ok('consult needs a question, a recommendation and a project', ok({ type: 'consult', question: 'q', recommendation: 'r', project: 'p' }) && !ok({ type: 'consult', question: 'q', project: 'p' }))
    t.ok('it may name an issue and a run', ok({ type: 'consult', question: 'q', recommendation: 'r', project: 'p', issueId: 'i', runId: 'x', reason: 'why' }) && !ok({ type: 'consult', question: 'q', recommendation: 'r', project: 'p', runId: 'x' }))
    t.ok('ask_operator takes its kind', ok({ type: 'ask_operator', question: 'q', kind: 'reserved', reservedBy: 'production' }) && ok({ type: 'ask_operator', question: 'q', kind: 'undecided', consultId: 'sc-1' }))
    t.ok('an unknown kind or reason is refused', !ok({ type: 'ask_operator', question: 'q', kind: 'technical' }) && !ok({ type: 'ask_operator', question: 'q', kind: 'reserved', reservedBy: 'because' }))
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-consult-'))
  const invocations = []
  const consults = []
  let script = []
  let outcome = () => ({ id: 'c1', outcome: 'resolved', answerText: 'Fix it in the framework.', conditions: ['keep the API'], opinions })
  const models = async () => [{ id: 'test-model', title: 'Test model', harness: 'claude', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
  const adapter = { invoke: async (args) => {
    invocations.push(args)
    const event = JSON.parse(args.prompt).event
    const action = script.shift()?.(event) ?? null
    return { session: args.session ?? { id: 'persistent-session' }, response: JSON.stringify({ message: 'Supervisor reply', action }), usage: { costUsd: 0.01 } }
  } }
  const paused = { status: 'paused', pause: { id: 'p1', kind: 'owner-hold', question: 'q' } }
  const tools = {
    projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => [],
    getRun: async (project, issueId, runId) => (runId === 'paused-run' ? paused : { status: 'blocked' }),
    getIssue: async (project, issueId) => ({ runs: issueId === 'paused-issue' ? [{ runId: 'old', status: 'completed' }, { runId: 'paused-run', status: 'paused' }] : [] }),
    consult: async (request) => { consults.push(request); return outcome(request) }
  }
  const events = () => invocations.map((i) => JSON.parse(i.prompt).event)
  const results = () => invocations.map((i) => JSON.parse(i.prompt).event).filter((e) => e?.type === 'tool-result')
  const agent = await createTopSupervisor({ dir, models, adapter, tools, emit: () => {}, pollMs: 20 })
  try {
    t.section('2. a consult runs in the background and its result wakes the supervisor')
    script = [() => ({ type: 'consult', question: 'Which layer takes the fix?', recommendation: 'The framework.', project: 'one-project', issueId: 'issue-1' })]
    await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Coordinate' })
    await wait(() => events().some((e) => e?.type === 'consult-result'))
    const woken = events().find((e) => e?.type === 'consult-result')
    t.eq('the panel got the question, the recommendation and what it concerns', consults.map((c) => [c.mode, c.question, c.recommendation, c.project, c.issueId]), [['decide', 'Which layer takes the fix?', 'The framework.', 'one-project', 'issue-1']])
    t.eq('the result carries the agreed answer and what to do with it', [woken.outcome, woken.answer, woken.conditions, /act on it within your authority/.test(woken.next)], ['resolved', 'Fix it in the framework.', ['keep the API'], true])
    t.eq('each seat\'s position is in it', woken.positions.map((p) => [p.seat, p.choice]), [['consultant-1', 'recommended'], ['consultant-2', 'recommended']])
    const charter = invocations[0].instructions ?? ''
    t.ok('the charter says: consult before the operator, and not for a paused run\'s question', /do not guess and do not ask the operator: consult/.test(charter) && /do not repeat it with ask_operator/.test(charter) && /Nothing else goes to the operator without a consult first/.test(charter))
    await wait(() => agent.get().status === 'active')

    t.section('3. ask_operator: only what is reserved, or what the panel did not settle')
    const ask = async (action) => {
      const before = results().length
      script = [() => action]
      await agent.chat('go on')
      await wait(() => results().length > before)
      await wait(() => agent.get().status === 'active')
      return results().at(-1)
    }
    const said = (r) => JSON.stringify(r)
    t.ok('without a kind it is refused, pointing at consult', /needs kind/.test(said(await ask({ type: 'ask_operator', question: 'Which layer?', project: 'one-project' }))))
    t.ok('undecided without a consult is refused', /consult first/.test(said(await ask({ type: 'ask_operator', question: 'Which layer?', kind: 'undecided', consultId: 'sc-none', project: 'one-project' }))))
    const settled = agent.get().consults[0].id
    t.ok('a question the panel settled is not the operator\'s', /settled that question/.test(said(await ask({ type: 'ask_operator', question: 'Which layer?', kind: 'undecided', consultId: settled, project: 'one-project' }))))
    t.eq('nothing was recorded so far', agent.questions().length, 0)

    outcome = () => ({ id: 'c2', outcome: 'escalated', reason: 'the seats chose differently', brief, opinions })
    script = [() => ({ type: 'consult', question: 'Accept the failing test?', recommendation: 'Accept.', project: 'one-project', issueId: 'issue-1', runId: 'blocked-run' })]
    await agent.chat('next')
    await wait(() => events().filter((e) => e?.type === 'consult-result').length === 2)
    await wait(() => agent.get().status === 'active')
    const open = agent.get().consults[1].id
    await ask({ type: 'ask_operator', question: 'Accept the failing test?', kind: 'undecided', consultId: open, project: 'one-project', issueId: 'issue-1' })
    t.eq('an unsettled consult may go to the operator, with the panel\'s wording and positions', [agent.questions().length, agent.questions()[0].kind, agent.questions()[0].brief.question, agent.questions()[0].consult.outcome], [1, 'undecided', brief.question, 'escalated'])

    outcome = () => ({ id: 'c3', outcome: 'escalated', reason: 'reserved to a person', brief, opinions: opinions.slice(0, 1) })
    await ask({ type: 'ask_operator', question: 'Deploy production now?', kind: 'reserved', reservedBy: 'production', project: 'one-project' })
    await wait(() => agent.questions().length === 2 && agent.questions()[1].brief)
    t.eq('a reserved question is open at once and gets its plain wording from a brief-only consult', [agent.questions()[1].kind, agent.questions()[1].reservedBy, consults.at(-1).mode, agent.questions()[1].brief.question], ['reserved', 'production', 'brief', brief.question])
    t.eq('a brief never wakes the supervisor', events().filter((e) => e?.type === 'consult-result').length, 2)
    t.ok('a run paused on its question is not asked about again', /paused on a question already/.test(said(await ask({ type: 'ask_operator', question: 'q', kind: 'reserved', reservedBy: 'owner-question', project: 'one-project', issueId: 'issue-1', runId: 'paused-run' }))))
    t.eq('still two open questions', agent.questions().length, 2)
    t.ok('nor is one whose run id is left out: the issue\'s paused run is found', /paused on a question already/.test(said(await ask({ type: 'ask_operator', question: 'q', kind: 'reserved', reservedBy: 'owner-question', project: 'one-project', issueId: 'paused-issue' }))))
    t.ok('an undecided question concerns what its consult concerned', /That consult was about one-project\/issue-1/.test(said(await ask({ type: 'ask_operator', question: 'Something else', kind: 'undecided', consultId: open, project: 'one-project', issueId: 'issue-2' }))))
    t.eq('still two open questions, and the undecided one is scoped by its consult', [agent.questions().length, agent.questions()[0].project, agent.questions()[0].issueId, agent.questions()[0].consult.question], [2, 'one-project', 'issue-1', 'Accept the failing test?'])
  } finally {
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('4. without a panel ask_operator works as it always did')
  {
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-consult-'))
    const calls = []
    let once = [() => ({ type: 'ask_operator', question: 'Accept?', project: 'one-project' }), () => ({ type: 'consult', question: 'q', recommendation: 'r', project: 'one-project' })]
    const plain = await createTopSupervisor({ dir: dir2, models, emit: () => {}, pollMs: 20,
      adapter: { invoke: async (args) => { calls.push(JSON.parse(args.prompt).event); return { session: { id: 's' }, response: JSON.stringify({ message: 'm', action: once.shift()?.() ?? null }), usage: { costUsd: 0.01 } } } },
      tools: { projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => [] } })
    try {
      await plain.start({ model: 'test-model', projects: ['one-project'], message: 'Coordinate' })
      await wait(() => calls.filter((e) => e?.type === 'tool-result').length >= 2)
      t.eq('the question is recorded without a kind', plain.questions().length, 1)
      t.ok('and consult says it is not available', /not available/.test(JSON.stringify(calls.filter((e) => e?.type === 'tool-result')[1])))
    } finally {
      await plain.shutdown()
      await fs.rm(dir2, { recursive: true, force: true })
    }
  }
}
