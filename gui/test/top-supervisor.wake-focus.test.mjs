import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createAdvisor } from '../server/decisions/advisor.mjs'
import { alwaysWakes, createWakeFilter, holdOutside, normaliseCampaign, splitByCampaign, summariseEvent } from '../server/decisions/wake-filter.mjs'
import { issuesChanged } from '../server/supervisor-payload.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { fakeOracle } from './fakes/decision-oracle.mjs'

export const name = 'top supervisor — issue changes outside its declared campaign wait for the next wake'

const ALPHA = 'alpha-project', BETA = 'beta-project'
const CONFIG = { id: 'jev', model: 'jev-latest', threshold: 0.9, hash: 'test', pricing: { inputUsdPerMillionTokens: 0.042, outputUsdPerMillionTokens: 0 }, maxCallCostUsd: 0.01 }
const temps = []
const wait = async (test, ms = 8000) => { const end = Date.now() + ms; while (!(await test())) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const refusal = async (fn) => { try { await fn(); return null } catch (error) { return error } }
const row = (id, report = null) => ({ id, status: 'open', name: id, ...(report ? { report: { kind: 'fault', trust: 'fault', reporter: report } } : {}) })

/** A running supervisor over two projects. `events()` is what each model call was told. */
async function setup ({ focus = [], mission = 'Mission', oracle = null, script = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-wake-focus-'))
  temps.push(dir)
  const lists = { [ALPHA]: [], [BETA]: [] }
  const prompts = [], failures = []
  let breakPrompt = null
  const adapter = { invoke: async (args) => {
    if (failures.length) throw failures.shift()
    prompts.push(JSON.parse(args.prompt))
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: script.shift() ?? null }), usage: { costUsd: 0 } }
  } }
  const agent = await createTopSupervisor({
    dir, adapter, pollMs: 20, maxDeferMs: 100,
    models: async () => [{ id: 'm', title: 'M', model: 'wire', verification: { status: 'verified' } }],
    tools: { projects: async () => [{ id: ALPHA }, { id: BETA }], listIssues: async (p) => lists[p],
      playbooks: async () => { if (breakPrompt) { const e = breakPrompt; breakPrompt = null; throw e } return [] } },
    ...(oracle ? { decisions: ({ spending }) => createAdvisor({ spending, loadProvider: async () => CONFIG, createOracle: () => oracle }) } : {})
  })
  const options = { model: 'm', focus, message: mission, limits: { maxCalls: 30 } }
  const idle = () => agent.get().status === 'active' && !agent.get().pending
  // How many calls Start's chain makes is the caller's to say: a reply that leads to another call is idle only after it.
  const begin = async (calls = 1) => { const n = prompts.length; await agent.start(options); await wait(() => prompts.length === n + calls && idle()) }
  const close = async () => { await agent.stop(); await agent.shutdown() }
  const held = () => agent.get().deferred ?? []
  return { agent, lists, prompts, failures, begin, idle, close, held, events: () => prompts.map((p) => p.event), failPrompt: (e) => { breakPrompt = e } }
}

export default async function (t) {
  t.section('C5, C6: a change outside the declared projects wakes nothing and rides with the next wake')
  {
    const s = await setup()
    await s.agent.setCampaign({ campaign: { projects: [ALPHA] }, actor: 'someone' })
    await s.begin()
    t.eq('the model is told the scope', s.prompts[0].campaign.projects, [ALPHA])
    t.eq('and who set it', s.agent.get().campaign.by, 'someone')
    s.lists[BETA].push(row('beta-1'))
    await wait(() => s.held().length === 1)
    await pause(250)
    t.eq('no provider, and past maxDeferMs: still no call', s.prompts.length, 1)
    t.eq('held as outside', [s.held()[0].outside, s.held()[0].event.project, s.held()[0].event.issues[0].id], [true, BETA, 'beta-1'])
    await s.agent.chat('Anything new?')
    await wait(() => s.prompts.length === 2 && s.idle())
    t.eq('the next wake is the operator\'s', s.events()[1].type, 'user')
    t.eq('and carries what was held', s.events()[1].deferred.map((d) => [d.outside, d.event.issues[0].id]), [[true, 'beta-1']])
    t.eq('nothing stays held', s.held().length, 0)
    await s.close()
  }

  t.section('C5, C6, C7: a named reporter is held inside a campaign project; a mixed change wakes for the rest')
  {
    const s = await setup()
    await s.agent.setCampaign({ campaign: { projects: [ALPHA], leaveReporters: ['reporter-a'] } })
    await s.begin()
    s.lists[ALPHA].push(row('left', 'reporter-a'))
    await wait(() => s.held().length === 1)
    await pause(200)
    t.eq('a report left to others wakes nothing, with no provider', s.prompts.length, 1)
    s.lists[ALPHA].push(row('other-report', 'reporter-b'))
    await wait(() => s.prompts.length === 2 && s.idle())
    t.eq('another reporter\'s is inside and wakes', s.events()[1].issues.map((i) => i.id), ['other-report'])
    t.eq('carrying what was held', s.events()[1].deferred[0].event.issues.map((i) => i.id), ['left'])
    s.lists[ALPHA].push(row('left-2', 'reporter-a'), row('plain'))
    await wait(() => s.prompts.length === 3 && s.idle())
    t.eq('a mixed change wakes with only its in-scope rows', s.events()[2].issues.map((i) => i.id), ['plain'])
    t.eq('and its outside rows beside them', s.events()[2].deferred.map((d) => d.event.issues.map((i) => i.id)), [['left-2']])
    await s.close()
  }

  t.section('C5: the scope is the operator\'s, set while it runs, and refused when wrong')
  {
    const s = await setup({ script: [{ type: 'set_campaign', campaign: null }] })
    await s.agent.setCampaign({ campaign: { leaveReporters: ['reporter-a'] } })
    await s.begin(2)
    t.eq('the model has no action to change it: its reply is sent back for repair', [s.events()[1].type, /Unknown or malformed/.test(s.events()[1].error)], ['protocol-repair', true])
    t.eq('so it stands', s.agent.get().campaign.leaveReporters, ['reporter-a'])
    await s.agent.setCampaign({ campaign: { projects: [ALPHA] } })
    t.eq('set during an activation, with no restart', s.agent.get().status, 'active')
    s.lists[BETA].push(row('beta-1'))
    await wait(() => s.held().length === 1)
    t.eq('and in force at once', s.prompts.length, 2)
    t.eq('an unknown project is refused', (await refusal(() => s.agent.setCampaign({ campaign: { projects: ['no-such-project'] } })))?.status, 400)
    t.eq('an unknown field is refused', (await refusal(() => s.agent.setCampaign({ campaign: { focus: [ALPHA] } })))?.status, 400)
    t.eq('a list that is not one is refused', (await refusal(() => s.agent.setCampaign({ campaign: { leaveReporters: 'reporter-a' } })))?.status, 400)
    t.eq('a refusal changes nothing', s.agent.get().campaign.projects, [ALPHA])
    await s.agent.setCampaign({ campaign: { projects: [], leaveReporters: [] } })
    t.eq('declaring nothing clears it', s.agent.get().campaign, null)
    await s.close()
    t.eq('names are trimmed and repeated once', normaliseCampaign({ leaveReporters: [' a ', 'a'] }), { projects: [], leaveReporters: ['a'] })
    t.eq('too many are refused', (() => { try { return normaliseCampaign({ leaveReporters: Array.from({ length: 51 }, (_, i) => `r${i}`) }) } catch (e) { return e.status } })(), 400)
  }

  t.section('Ruling R1: with no declared scope and no confident answer the change wakes, whatever the mission says')
  {
    for (const mission of ['Handle security issues across all projects', 'Work only on alpha-project']) {
      const s = await setup({ focus: [ALPHA], mission })
      await s.begin()
      s.lists[BETA].push(row('security-issue'))
      await wait(() => s.prompts.length === 2 && s.idle())
      t.eq(`no provider, "${mission}": woken`, [s.events()[1].type, s.events()[1].project], ['issues-changed', BETA])
      t.eq('never held', s.held().length, 0)
      await s.close()
    }
    for (const [what, script] of [['answers wake', { pick: { wake: 'wake' } }], ['is unavailable', { fail: { class: 'transient', charged: 'unknown' } }], ['is unsure', { pick: { wake: 'outside' }, confidence: 0.5 }]]) {
      const oracle = fakeOracle([script])
      const s = await setup({ focus: [ALPHA], mission: 'Handle security issues across all projects', oracle })
      await s.begin()
      s.lists[BETA].push(row('security-issue'))
      await wait(() => s.prompts.length === 2 && s.idle())
      t.eq(`the provider ${what}: woken`, [s.events()[1].project, s.held().length], [BETA, 0])
      t.eq('it was shown the focus', oracle.calls[0].state.focus, [ALPHA])
      await s.close()
    }
  }

  t.section('C5: a confident provider holds with no timer; a plain defer keeps its timer')
  {
    const outside = fakeOracle([{ pick: { wake: 'outside' } }])
    const s = await setup({ oracle: outside, mission: 'Only the billing work; reports from the shop are left to someone else.' })
    await s.begin()
    s.lists[ALPHA].push(row('shop-report', 'reporter-b'))
    await wait(() => s.held().length === 1)
    await pause(250)
    t.eq('held past maxDeferMs without a call', s.prompts.length, 1)
    t.eq('as outside, on the provider\'s record', [s.held()[0].outside, typeof s.held()[0].decision], [true, 'string'])
    t.eq('the row told it who reported', outside.calls[0].state.event.issues[0].report.reporter, 'reporter-b')
    t.eq('the mission is passed verbatim', outside.calls[0].state.mission, 'Only the billing work; reports from the shop are left to someone else.')
    await s.close()

    const deferring = await setup({ oracle: fakeOracle([{ pick: { wake: 'defer' } }]) })
    await deferring.begin()
    deferring.lists[ALPHA].push(row('routine'))
    await wait(() => deferring.prompts.length === 2 && deferring.idle())
    t.eq('routine holding still wakes at the limit', [deferring.events()[1].type, deferring.events()[1].deferred.length], ['deferred-events', 1])
    await deferring.close()

    const run = await createWakeFilter({ advisor: { ask: async () => ({ status: 'answered', key: 'k', decisions: { wake: { value: 'outside', confidence: 0.99, confident: true } } }) }, dir: '/nonexistent' })
      .route({ type: 'run-changed', changed: ['status'], run: { status: 'running' } })
    t.eq('outside on a run change is no more than a defer: its timer stands', [run.wake, run.outside], [false, undefined])
  }

  t.section('C6: what is held stays bounded, and survives a New session')
  {
    const deferred = []
    const summary = (issues, extra = {}) => summariseEvent({ type: 'issues-changed', project: BETA, total: 1, issues, ...extra })
    holdOutside(deferred, { at: '2026-01-01T00:00:00.000Z', summary: summary([{ ...row('a'), status: 'open' }]), reason: 'r' })
    holdOutside(deferred, { at: '2026-01-01T00:01:00.000Z', summary: summary([{ ...row('a'), status: 'resolved' }]), reason: 'r' })
    t.eq('one entry per project', deferred.length, 1)
    t.eq('the newest row wins', deferred[0].event.issues.map((i) => [i.id, i.status]), [['a', 'resolved']])
    t.eq('it says when it began, and how much merged', [deferred[0].at, deferred[0].lastAt, deferred[0].changes], ['2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 2])
    holdOutside(deferred, { at: 'x', summary: summary([], { removed: ['a'] }), reason: 'r' })
    t.eq('a removal replaces the row', [deferred[0].event.issues.length, deferred[0].event.removed], [0, ['a']])
    holdOutside(deferred, { at: 'x', summary: summary([row('a')]), reason: 'r' })
    t.eq('and coming back replaces the removal', [deferred[0].event.issues.length, deferred[0].event.removed], [1, undefined])
    for (let n = 0; n < 60; n++) holdOutside(deferred, { at: 'x', summary: summary([row(`n${n}`)], { removed: [`gone${n}`] }), reason: 'r' })
    t.eq('still one entry', deferred.length, 1)
    t.eq('rows and removals are capped', [deferred[0].event.issues.length, deferred[0].event.removed.length], [40, 40])
    t.eq('what fell off is counted', deferred[0].event.omitted, 41)
    t.ok('with where to read it', /list_issues/.test(deferred[0].event.detail))
    t.eq('the newest are what is kept', deferred[0].event.issues.at(-1).id, 'n59')
    t.eq('a change over the summary\'s own cap says so', summariseEvent({ type: 'issues-changed', project: BETA, issues: Array.from({ length: 45 }, (_, n) => row(`m${n}`)) }).omitted, 5)

    const s = await setup()
    await s.agent.setCampaign({ campaign: { projects: [ALPHA] } })
    await s.begin()
    s.lists[BETA].push(row('beta-1'))
    await wait(() => s.held().length === 1)
    await s.agent.stop()
    await s.agent.reset()
    t.eq('New session keeps what is held', s.held().map((d) => d.event.project), [BETA])
    t.eq('and the scope', s.agent.get().campaign.projects, [ALPHA])
    const n = s.prompts.length
    await s.agent.start({ model: 'm', message: 'Again', limits: { maxCalls: 30 } })
    await wait(() => s.prompts.length === n + 1 && s.idle())
    t.eq('and delivers it with the next wake', s.events().at(-1).deferred.map((d) => d.event.project), [BETA])
    await s.close()
  }

  t.section('C6: what is held survives a call that never reached the supervisor')
  {
    const kinds = [
      ['a runtime that never started', (s) => s.failures.push(Object.assign(new Error('spawn fake ENOENT'), { kind: 'spawn-error', started: false }))],
      ['a cancelled call', (s) => s.failures.push(Object.assign(new Error('cancelled'), { name: 'AbortError', termination: {} }))],
      ['a prompt that could not be built', (s) => s.failPrompt(new Error('no catalogue'))]
    ]
    for (const [what, arrange] of kinds) {
      const s = await setup()
      await s.agent.setCampaign({ campaign: { projects: [ALPHA] } })
      await s.begin()
      s.lists[BETA].push(row('beta-1'))
      await wait(() => s.held().length === 1)
      arrange(s)
      await s.agent.chat('Wake up')
      await wait(() => s.agent.get().status === 'stopped')
      t.eq(`${what}: nothing reached the model`, s.prompts.length, 1)
      t.eq('the entry stays held', s.held().map((d) => d.event.issues[0].id), ['beta-1'])
      await s.begin()
      t.eq('and reaches the next successful call', s.events().at(-1).deferred.map((d) => d.event.issues[0].id), ['beta-1'])
      t.eq('after which it is no longer held', s.held().length, 0)
      await s.close()
    }
  }

  t.section('C7: what is inside, or never filtered, is not touched by the rule')
  {
    const event = (issues, extra = {}) => ({ type: 'issues-changed', project: ALPHA, total: 1, issues, ...extra })
    t.eq('no campaign: nothing is split', splitByCampaign(event([row('a')]), {}).outside, null)
    const inside = splitByCampaign(event([row('a')]), { campaign: { projects: [ALPHA], leaveReporters: ['r'] } })
    t.eq('an in-scope row stays', [inside.outside, inside.rest.issues.length], [null, 1])
    t.eq('a row with an open owned run is never outside', splitByCampaign(event([row('a', 'r')]), { campaign: { projects: [], leaveReporters: ['r'] }, ownedIssues: [`${ALPHA}/a`] }).outside, null)
    t.eq('nor by project', splitByCampaign(event([row('a')]), { campaign: { projects: [BETA], leaveReporters: [] }, ownedIssues: [`${ALPHA}/a`] }).outside, null)
    const gone = splitByCampaign(event([], { removed: ['a'] }), { campaign: { projects: [], leaveReporters: ['r'] } })
    t.eq('a removal has no reporter to read: not established as outside', [gone.outside, gone.rest.removed], [null, ['a']])
    const goneOut = splitByCampaign(event([], { removed: ['a'] }), { campaign: { projects: [BETA], leaveReporters: [] } })
    t.eq('the project test can place it', [goneOut.rest, goneOut.outside.removed], [null, ['a']])
    const scope = { campaign: { projects: [BETA], leaveReporters: [] } }
    for (const always of [
      { type: 'user' }, { type: 'tool-result' }, { type: 'protocol-repair' }, { type: 'model-substituted' }, { type: 'operator-answer' },
      { type: 'run-changed', run: { status: 'failed', issue: { project: ALPHA } } },
      { type: 'run-changed', run: { status: 'paused', issue: { project: ALPHA } } },
      { type: 'run-changed', run: { status: 'completed', outcome: 'unresolved', issue: { project: ALPHA } } }
    ]) {
      t.eq(`${always.type} ${always.run?.status ?? ''}: not split, and always wakes`, [splitByCampaign(always, scope).outside, splitByCampaign(always, scope).rest, alwaysWakes(always)], [null, always, true])
    }

    const s = await setup()
    await s.agent.setCampaign({ campaign: { projects: [ALPHA] } })
    await s.begin()
    s.lists[ALPHA].push(row('alpha-1'))
    await wait(() => s.prompts.length === 2 && s.idle())
    t.eq('a change inside the scope wakes, with no provider', [s.events()[1].type, s.events()[1].issues[0].id, s.held().length], ['issues-changed', 'alpha-1', 0])
    await s.close()
  }

  t.section('Rows from the real issue list carry the reporter the rule reads')
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-wake-list-'))
    temps.push(root)
    const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
    try {
      process.env.DEVPANEL_ISSUES_DIR = path.join(root, 'issues')
      process.env.DEVPANEL_PROJECTS_DIR = path.join(root, 'projects')
      await fs.mkdir(path.join(root, 'projects', ALPHA), { recursive: true })
      await fs.mkdir(path.join(root, 'issues'))
      const issues = await import(`../server/issues.js?wake-focus=${Date.now()}`)
      await issues.createIssue(ALPHA, { input: '# A fault\n\nIt broke.', openedBy: { user: 'reporter-a' }, reportOrigin: { kind: 'fault', category: 'error', reporter: 'reporter-a', trust: 'fault' } })
      await issues.createIssue(ALPHA, { input: '# Plain\n\nNot a report.', openedBy: { user: 'someone' } })
      const changed = issuesChanged(ALPHA, '[]', await issues.listIssues(ALPHA))
      const { outside, rest } = splitByCampaign(changed, { campaign: { projects: [], leaveReporters: ['reporter-a'] } })
      t.eq('the report is held', outside.issues.map((i) => i.report), [{ kind: 'fault', trust: 'fault', reporter: 'reporter-a' }])
      t.eq('the plain issue is not', rest.issues.map((i) => i.report), [undefined])
      t.eq('the summary keeps it', summariseEvent(outside).issues[0].report.reporter, 'reporter-a')
    } finally {
      for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
}
