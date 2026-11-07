import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTopSupervisor, releaseAuthorization } from '../server/top-supervisor.mjs'

export const name = 'release authorization — the supervisor starts a production release only on the operator\'s Authorize for that very preview'

const wait = async (condition, ms = 5000) => {
  const until = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const production = { mode: 'production', environment: 'production', releaseId: 'green-run', releaseIdSource: 'filled' }

export default async function (t) {
  t.section('S1–S5 through the supervisor: refused without, before, after a Decline and for another preview; started after Authorize')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-release-auth-'))
    const ids = {}
    let started = 0
    let script = []
    const adapter = { invoke: async (args) => {
      const event = JSON.parse(args.prompt).event
      const action = script.shift()?.(event) ?? null
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
    } }
    const tools = {
      projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [],
      getIssue: async () => ({ issue: { id: 'i' }, reports: [], runs: [] }),
      preview: async (a) => ({ ok: true, configHash: `h-${a.runOptions?.environment ?? 'staging'}`, tactic: 'deployment', releasePlan: a.runOptions?.environment === 'production' ? production : { mode: 'staging', environment: 'staging', releaseId: null, releaseIdSource: null } }),
      start: async () => { started++; return { runId: `r${started}`, status: 'running' } },
      getRun: async () => ({ status: 'completed' })
    }
    const preview = { type: 'preview', project: 'p', issueId: 'i', playbook: 'deployment', runOptions: { environment: 'production' } }
    const startOf = (key) => () => ({ type: 'start_run', project: 'p', issueId: 'i', previewId: ids[key] })
    const remember = (key, next) => (e) => { ids[key] = e.result.previewId; return next(e) }
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    script = [
      () => preview,
      remember('first', startOf('first')),                                                  // refused: no authorization
      () => ({ type: 'ask_operator', question: 'May I deploy production?', project: 'p', issueId: 'i', options: ['Yes', 'No'] }),
      () => null
    ]
    await agent.start({ model: 'm', projects: ['p'], message: 'go', limits: { maxCalls: 40, maxRuns: 4, maxConcurrent: 1, maxStartsPerIssue: 4 } })
    await wait(() => script.length === 0 && agent.questions().length === 1)
    const plain = agent.questions()[0]
    script = [
      startOf('first'),                                                                       // S4: a plain answered question does not count
      () => ({ type: 'ask_release_authorization', previewId: ids.first }),
      startOf('first'),                                                                       // S3: unanswered
      () => null
    ]
    await agent.answerQuestion(plain.id, { answer: 'Yes', actor: 'operator' })
    await wait(() => script.length === 0 && agent.questions().some((q) => q.authorizes))
    const first = agent.questions().find((q) => q.authorizes)
    t.eq('the server writes the question with Authorize and Decline', first.options, ['Authorize', 'Decline'])
    t.ok('naming the environment and the filled release', first.question.includes('environment production') && first.question.includes('green-run') && first.question.includes('filled'), first.question)
    t.eq('bound to the preview', [first.authorizes.previewId, first.authorizes.project, first.authorizes.issueId, first.authorizes.releaseId, first.authorizes.configHash], [ids.first, 'p', 'i', 'green-run', 'h-production'])
    let refusedAnswer = null
    try { await agent.answerQuestion(first.id, { answer: 'No', actor: 'operator' }) } catch (error) { refusedAnswer = error.message }
    t.ok('an answer other than Authorize or Decline is not accepted', Boolean(refusedAnswer), refusedAnswer)
    script = [
      startOf('first'),                                                                       // S2: declined
      () => preview,
      remember('second', () => ({ type: 'ask_release_authorization', previewId: ids.second })),
      () => null
    ]
    await agent.answerQuestion(first.id, { answer: 'Decline', actor: 'operator' })
    await wait(() => script.length === 0 && agent.questions().some((q) => q.authorizes?.previewId === ids.second))
    const second = agent.questions().find((q) => q.authorizes?.previewId === ids.second)
    script = [
      () => preview,
      remember('third', startOf('third')),                                                    // S5: another preview's Authorize does not carry over
      startOf('second'),                                                                      // S1: started
      () => ({ type: 'finish' })
    ]
    await agent.answerQuestion(second.id, { answer: 'Authorize', actor: 'operator' })
    await wait(() => agent.get().finishing === true)
    const tools_ = agent.get().messages.filter((m) => m.role === 'tool').map((m) => m.text ?? '')
    const said = (text) => tools_.filter((m) => m.includes(text)).length
    t.ok('refused without an authorization (and for another preview: S5)', said('call ask_release_authorization') >= 3, tools_.join('\n---\n'))
    t.eq('refused while unanswered (S3)', said('Awaiting the operator'), 1)
    t.eq('refused after a Decline (S2)', said('declined this release'), 1)
    t.eq('started once, only after Authorize (S1)', started, 1)
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('S5–S7 on the gate itself: a mismatched binding, a stale preview and a used authorization are refused; staging needs none')
  {
    const preview = { project: 'p', issueId: 'i', playbook: 'deployment', configHash: 'h1', release: production }
    const question = (over = {}, answer = 'Authorize') => ({ id: 'q', answer: answer ? { text: answer, actor: 'operator' } : null,
      authorizes: { previewId: 'P', project: 'p', issueId: 'i', playbook: 'deployment', environment: 'production', mode: 'production', releaseId: 'green-run', configHash: 'h1', usedBy: null, ...over } })
    const gate = (q, p = preview, id = 'P') => releaseAuthorization({ questions: [q] }, id, p)
    t.eq('an Authorize bound to this preview passes', gate(question()).refused, null)
    t.ok('S5: bound to another issue', /issueId/.test(gate(question({ issueId: 'other' })).refused))
    t.ok('S5: bound to another environment', /environment/.test(gate(question({ environment: 'staging-then-production' })).refused))
    t.ok('S5: bound to another release', /releaseId/.test(gate(question({ releaseId: 'other-run' })).refused))
    t.ok('S6: a stale binding (the configuration changed since)', /configHash/.test(gate(question(), { ...preview, configHash: 'h2' }).refused))
    t.ok('S7: an authorization starts one run only', /already started a run/.test(gate(question({ usedBy: { runId: 'r1' } })).refused))
    t.ok('a plain question with no binding never counts', /ask_release_authorization/.test(releaseAuthorization({ questions: [{ id: 'x', answer: { text: 'Yes' } }] }, 'P', preview).refused))
    t.eq('a staging preview needs no authorization', releaseAuthorization({ questions: [] }, 'P', { ...preview, release: { mode: 'staging' } }).refused, null)
    t.ok('staging-then-production needs one', /ask_release_authorization/.test(releaseAuthorization({ questions: [] }, 'P', { ...preview, release: { ...production, mode: 'staging-then-production' } }).refused))
  }
}
