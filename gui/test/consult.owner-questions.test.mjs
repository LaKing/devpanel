import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createOwnerQuestionConsult } from '../server/consult/owner-questions.mjs'

export const name = 'consult panel — a triage\'s questions for the owner are put to it first'

const opinions = [{ seat: 'consultant-1', model: 'fable-5-2', effort: 'medium' }, { seat: 'consultant-2', model: 'gpt-6-astra', effort: 'medium' }]
const brief = { question: 'Maradjon a régi név?', why: 'A felület ettől függ.', options: [{ label: 'Igen', consequence: 'a' }, { label: 'Nem', consequence: 'b' }], recommendation: 'Igen.', positions: [] }

async function issueWith (runs) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'consult-owner-'))
  for (const [id, run] of Object.entries(runs)) {
    await fs.mkdir(path.join(dir, 'runs', id), { recursive: true })
    await fs.writeFile(path.join(dir, 'runs', id, 'run.json'), JSON.stringify({ runId: id, status: 'completed', outcome: 'unresolved', ...run }))
  }
  return dir
}
const asked = (over = {}) => ({ verdict: 'needs-owner-input', reason: 'Two readings.', questions: [{ id: 'Q1', question: 'Keep the old name?', category: 'requirement-conflict', recommendation: 'Keep it.' }, { id: 'Q2', question: 'Publish it?', category: 'authorization', recommendation: 'No.' }], askedBy: { phase: 'triage', stepId: 'triage', step: '001' }, at: '2026-11-13T00:00:00Z', answer: null, ...over })
const readRun = async (dir, id) => JSON.parse(await fs.readFile(path.join(dir, 'runs', id, 'run.json'), 'utf8'))

function service (dir, outcomes, { panel = { enabled: true, alwaysHuman: ['authorization'] } } = {}) {
  const requests = []
  const answers = []
  const events = []
  const consult = {
    panel: async () => panel,
    consult: async (request) => { requests.push(request); return { id: `c-${request.key}`, opinions, ...outcomes[request.key.split(':')[1]] } }
  }
  const run = createOwnerQuestionConsult({ consult, getIssue: async () => ({ path: dir, packed: false }), emit: (e) => events.push(e.type), answer: async (a) => { answers.push(a); return { started: { runId: 'next' } } } })
  return { run, requests, answers, events }
}
const resolved = (text) => ({ outcome: 'resolved', answerText: text })
const escalated = { outcome: 'escalated', reason: 'the seats chose differently', brief }

export default async function (t) {
  t.section('every question answered: the answers take the owner\'s path')
  {
    const dir = await issueWith({ r1: { ownerInput: asked({ questions: asked().questions.slice(0, 1) }) } })
    const s = service(dir, { Q1: resolved('Keep the old name.') })
    const result = await s.run({ project: 'p-project', issueId: 'i', runId: 'r1' })
    t.eq('resolved', result.outcome, 'resolved')
    t.eq('the question, its recommendation and category went to the panel', s.requests.map((r) => [r.key, r.mode, r.recommendation, r.category, r.askedBy.role]), [['owner-input:Q1', 'decide', 'Keep it.', 'requirement-conflict', 'triage']])
    t.eq('the owner-input answer is given in the panel\'s name', [s.answers[0].actor, s.answers[0].answers, s.answers[0].runId], ['consult panel (fable-5-2@medium + gpt-6-astra@medium)', { Q1: 'Keep the old name.' }, 'r1'])
    t.ok('the note says who answered and that the owner may overrule', /overrule/.test(s.answers[0].note) && /c-owner-input:Q1/.test(s.answers[0].note))
    t.eq('the run records the consult', (await readRun(dir, 'r1')).ownerInput.consult.status, 'resolved')
    t.eq('the panel\'s work is announced', s.events, ['owner-input-consulting', 'owner-input-consulted'])
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('one question left to the owner: nothing is answered, the owner gets the plain wording')
  {
    const dir = await issueWith({ r1: { ownerInput: asked() } })
    const s = service(dir, { Q1: resolved('Keep the old name.'), Q2: escalated })
    const result = await s.run({ project: 'p-project', issueId: 'i', runId: 'r1' })
    const run = await readRun(dir, 'r1')
    t.eq('escalated, and no answer was recorded', [result.outcome, s.answers.length, run.ownerInput.answer], ['escalated', 0, null])
    t.eq('an authorization question only gets its brief', s.requests.map((r) => r.mode), ['decide', 'brief'])
    t.eq('the open question carries the brief and what the panel said', [run.ownerInput.questions[1].brief.question, run.ownerInput.questions[1].consult.outcome, run.ownerInput.questions[0].brief ?? null], [brief.question, 'escalated', null])
    t.eq('asked again, the panel is not consulted twice', [await s.run({ project: 'p-project', issueId: 'i', runId: 'r1' }), s.requests.length], [null, 2])
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('a consult the last shutdown cut short goes on')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'consult-owner-root-'))
    const issue = path.join(dir, 'p-project', 'i')
    const one = asked({ questions: asked().questions.slice(0, 1) })
    await fs.mkdir(path.join(issue, 'runs', 'r1'), { recursive: true })
    await fs.mkdir(path.join(dir, 'p-project', 'done', 'runs', 'r9'), { recursive: true })
    await fs.writeFile(path.join(issue, 'runs', 'r1', 'run.json'), JSON.stringify({ runId: 'r1', status: 'completed', ownerInput: { ...one, consult: { status: 'running', startedAt: '2026-11-13T00:00:00Z' } } }))
    await fs.writeFile(path.join(dir, 'p-project', 'done', 'runs', 'r9', 'run.json'), JSON.stringify({ runId: 'r9', status: 'completed', ownerInput: { ...one, consult: { status: 'escalated' } } }))
    const s = service(issue, { Q1: resolved('Keep the old name.') }, { panel: { enabled: false } })
    const resumed = await s.run.resume({ issuesDir: dir })
    t.eq('only the unfinished one is found', resumed, [{ project: 'p-project', issueId: 'i', runId: 'r1' }])
    const end = Date.now() + 3000
    while (!s.answers.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    t.eq('it is finished from its records and answered once, even with the panel switched off since', [s.answers.length, s.answers[0]?.answers, (await readRun(issue, 'r1')).ownerInput.consult.startedAt], [1, { Q1: 'Keep the old name.' }, '2026-11-13T00:00:00Z'])
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('what is never consulted')
  {
    const dir = await issueWith({
      split: { ownerInput: asked({ verdict: 'too-large', questions: [], split: [{ title: 'a', scope: 'b' }] }) },
      answered: { ownerInput: asked({ answer: { by: 'owner', at: 'x' } }) },
      plain: {},
      earlier: { ownerInput: asked({ answer: { by: 'consult panel (fable-5-2@medium + gpt-6-astra@medium)', at: 'x' } }) },
      second: { ownerInput: asked() }
    })
    const s = service(dir, { Q1: resolved('x'), Q2: resolved('y') })
    for (const id of ['split', 'answered', 'plain']) t.eq(`${id}: not consulted`, await s.run({ project: 'p-project', issueId: 'i', runId: id }), null)
    t.eq('a second triage of an issue the panel already answered goes to the owner', [await s.run({ project: 'p-project', issueId: 'i', runId: 'second' }), s.requests.length], [null, 0])
    const off = service(dir, { Q1: resolved('x') }, { panel: { enabled: false } })
    t.eq('a panel switched off is not asked', [await off.run({ project: 'p-project', issueId: 'i', runId: 'second' }), off.requests.length], [null, 0])
    await fs.rm(dir, { recursive: true, force: true })
  }
}
