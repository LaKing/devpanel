import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { fallbackCandidates, createQuotaFallback } from '../server/runtime/model-fallback.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { CONFIG_ROOT, sandbox, withoutSeat } from './helpers.mjs'
import { admits } from '../server/runtime/spending-policy.mjs'
import { remainingBudget } from '../server/supervisor-summary.mjs'

export default async function (t) {
  const model = (id, harness, extra = {}) => ({ id, model: `${id}-wire`, harness, contextWindow: 1000000, verification: { status: 'verified' }, ...extra })
  const a = model('a', 'claude'), b = model('b', 'codex')
  const roster = [a, b, model('small', 'codex', { contextWindow: 1000 }), model('unverified', 'codex', { verification: { status: 'unverified' } }), model('cooling', 'codex'), model('same-account', 'claude')]
  const availability = { check: async id => id === 'cooling' ? { reason: 'quota' } : null }
  const candidates = await fallbackCandidates({ models: roster, current: a, availability })
  t.eq('compatible verified models only, another account first', candidates.map(m => m.id), ['b', 'same-account'])
  t.eq('occupied seats excluded', (await fallbackCandidates({ models: roster, current: a, availability, excluded: ['b', 'same-account'] })).length, 0)
  t.eq('allowlist excludes other providers', (await fallbackCandidates({ models: roster, current: a, availability, allowedModels: ['b'] })).map(m=>m.id), ['b'])
  t.eq('empty allowlist disables substitution', (await fallbackCandidates({ models: roster, current: a, availability, allowedModels: [] })).length, 0)
  let probes=0
  const fallback=createQuotaFallback({loadModels:async()=>roster,availability,probeFor:()=>{probes++;throw Error('must not probe a forbidden model')}})
  const restricted={run:{participants:{implementer:{}},failures:[]},snapshot:{participants:{implementer:{model:b}},fallbackModels:['b']},participantSpec:()=>({model:b}),harnesses:{claude:{invoke(){}},codex:{invoke(){}}}}
  t.eq('engine stops when its allowed quota pool has no alternative',await fallback({engine:restricted,role:'implementer',spec:{model:b}}),null)
  t.eq('forbidden alternatives are never probed',probes,0)
  // A playbook restricting substitution: the implementation playbook with an
  // occupied auditor seat and an allowlist, as an operator would write it.
  const restrict=(list)=>sandbox(async root=>{
    const file=path.join(root,'playbooks','implementation.yaml')
    const text=withoutSeat(await fs.readFile(file,'utf8'),'auditor-1').replace('participants:\n','participants:\n  auditor-1:\n    model: gpt-6-sol\n')
    await fs.writeFile(file,text+['fallbackModels:',...list.map(id=>`  - ${id}`)].join('\n')+'\n')
  })
  const preset=await resolvePlaybook('implementation',{root:await restrict(['opus-5','gpt-6-astra','gpt-6-luna'])})
  t.ok('restricted preset resolves',preset.ok,JSON.stringify(preset.errors))
  t.eq('the assigned seats are unchanged by the allowlist',Object.fromEntries(Object.entries(preset.resolved?.participants??{}).map(([role,p])=>[role,p.model.id])),{'auditor-1':'gpt-6-sol',coordinator:'opus-5-5',implementer:'opus-5-5'})
  t.eq('fallback restriction survives into the immutable snapshot',preset.resolved?.fallbackModels,['opus-5','gpt-6-astra','gpt-6-luna'])
  t.eq('omitted allowlist keeps normal fallback',(await resolvePlaybook('implementation',{root:CONFIG_ROOT})).resolved?.fallbackModels??null,null)
  const invalidRoot=await restrict(['opus-5','nonexistent-model'])
  t.ok('unknown fallback model is a configuration error',!(await resolvePlaybook('implementation',{root:invalidRoot})).ok)

  const policy = { version: 1, daily: { usd: 100, starts: 1, unpricedRuns: 1, unpricedCalls: 1 }, monthly: { usd: 1000, starts: 1, unpricedRuns: 1, unpricedCalls: 1 }, concurrent: 3, perWakeCalls: 100 }
  const usage = { day: { committedUsdMicros: 100845329, committedUsd: 100.845329, starts: 999, unpricedRuns: 999, unpricedCalls: 999 }, month: { committedUsdMicros: 9999999999 } }
  for (const subject of ['model-call', 'run-start']) t.eq(`advisory ${subject} continues past all calendar estimates`, admits({ policy, usage, subject, maxCostUsd: 100000 }).ok, true)
  t.eq('concurrency still protects live work', admits({ policy, usage, subject: 'run-start', concurrent: 3 }).ok, false)
  const budget = remainingBudget({ limits: { maxCalls: 2000, maxRuns: 200, maxStartsPerIssue: 20 } }, { policy: { active: true, policy }, usage })
  t.eq('supervisor sees spending as nonbinding', budget.policy.decides, false)
  t.eq('supervisor receives recorded cost without exhausted allowance', budget.policy.windows.day.committedUsd, 100.845329)

  // The supervisor's own model out of quota: nothing is substituted, the activation stops on its own account
  // and its live run is left running; a failure of another kind does not end the activation at all.
  const wait = async (test, what) => { const end = Date.now() + 5000; while (!test()) { if (Date.now() > end) throw Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 10)) } }
  const supervisor = async ({ invoke, runs = {} }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-quota-supervisor-'))
    const seen = [], exhausted = [], stopped = []
    // The runs it owns, as an earlier activation of this session left them on disk.
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ status: 'stopped', session: null, model: null, messages: [], queue: [], previews: {}, calls: 0, starts: 0, costUsd: 0, unknownCostCalls: 0,
      ownedRuns: Object.keys(runs).map((runId) => ({ project: 'p-project', issueId: 'i', runId, status: runs[runId].status })) }))
    const service = await createTopSupervisor({ dir, models: async () => [a, b], pollMs: 50,
      tools: { projects: async () => [], playbooks: async () => [], listIssues: async () => [],
        getRun: async (project, issueId, runId) => runs[runId] ?? Object.assign(new Error('no such run'), { status: 404 }),
        stop: async (r) => { stopped.push(r.runId); runs[r.runId].status = 'cancelled' },
        recordExhausted: async x => exhausted.push(x), availability: { check: async id => exhausted.some(x => x.modelId === id) ? {} : null } },
      adapter: { invoke: async args => { seen.push(args); return invoke(args, seen.length) } }
    })
    return { dir, service, seen, exhausted, stopped, end: async () => { await service.shutdown(); await fs.rm(dir, { recursive: true, force: true }) } }
  }

  t.section('the supervisor\'s model out of quota: no substitution, the activation stops, its runs go on')
  {
    const runs = { live: { status: 'running' } }
    const s = await supervisor({ runs, invoke: async () => { throw Object.assign(Error('Provider quota exhausted'), { stderr: 'insufficient_quota' }) } })
    try {
      const statePath = path.join(s.dir, 'state.json')
      await s.service.start({ model: 'a', message: 'Continue existing work' })
      // An owned live run, as a start of this session would have recorded it.
      await wait(() => s.service.get().status === 'stopped', `the stop after the quota failure (${s.service.get().status}: ${s.service.get().reason})`)
      t.eq('one call, on the supervisor\'s own model: no other model is tried', s.seen.map(x => x.model), ['a-wire'])
      t.eq('the model is recorded as exhausted', s.exhausted[0]?.modelId, 'a')
      t.ok('the reason says nothing was substituted', /No other model is substituted/.test(s.service.get().reason), s.service.get().reason)
      t.eq('stopped, not recovery-required: Start continues the same session', [s.service.get().status, s.service.get().model.id, s.service.get().mission], ['stopped', 'a', 'Continue existing work'])
      t.ok('the event that met the quota is kept for the next start', JSON.parse(await fs.readFile(statePath, 'utf8')).queue.length >= 1)
      t.eq('its live run was not stopped', [s.stopped, runs.live.status], [[], 'running'])
    } finally { await s.end() }
  }

  t.section('a failure of the supervisor\'s own does not stop its runs')
  {
    const runs = { live: { status: 'running' } }
    const s = await supervisor({ runs, invoke: async () => ({ session: { id: 's' }, response: 'not json at all', usage: { costUsd: 0 } }) })
    try {
      await s.service.start({ model: 'a', message: 'Coordinate' })
      await wait(() => s.seen.length >= 2 && s.service.get().status === 'active' && /format repair exhausted/.test(s.service.get().reason ?? ''), `the format failure (${s.service.get().status}: ${s.service.get().reason})`)
      t.eq('a reply that could not be read, twice: the activation is still active', [s.service.get().status, s.service.get().ownFailures], ['active', 1])
      t.ok('it says that it goes on and that Stop ends it', s.service.get().messages.some((m) => /The activation goes on/.test(m.text) && /Stop ends it/.test(m.text)))
      t.eq('no run was stopped', [s.stopped, runs.live.status], [[], 'running'])
      await s.service.stop()
      t.eq('an operator\'s Stop still ends it, and that Stop is what stops its runs', [s.service.get().status, s.stopped], ['stopped', ['live']])
    } finally { await s.end() }
  }

  t.section('a failed call is tried again; five failures in a row end the activation on its own account')
  {
    process.env.DEVPANEL_SUPERVISOR_RETRY_MS = '5'
    const { createTopSupervisor: fresh } = await import(`../server/top-supervisor.mjs?retry=${Date.now()}`)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-quota-supervisor-'))
    let calls = 0, failUntil = 2
    const stopped = []
    const service = await fresh({ dir, models: async () => [a, b], pollMs: 50,
      tools: { projects: async () => [], playbooks: async () => [], listIssues: async () => [], stop: async (r) => stopped.push(r.runId) },
      adapter: { invoke: async () => { calls++; if (calls <= failUntil) throw new Error('connection reset by peer'); return { session: { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } } } } })
    try {
      await service.start({ model: 'a', message: 'Coordinate' })
      await wait(() => calls >= 3 && service.get().status === 'active' && service.get().ownFailures === 0, `the retry (${calls} calls, ${service.get().status})`)
      t.eq('two failed calls, then the same event is answered: nothing was lost and nothing stopped', [calls, service.get().status, service.get().pending ?? null, stopped], [3, 'active', null, []])
      failUntil = Infinity
      await service.chat('again')
      await wait(() => service.get().status === 'stopped', `the stop after five failures (${service.get().status}, ${service.get().ownFailures})`)
      t.eq('five in a row end it, as stopped and with its runs untouched', [service.get().ownFailures, service.get().status, stopped], [5, 'stopped', []])
    } finally { delete process.env.DEVPANEL_SUPERVISOR_RETRY_MS; await service.shutdown(); await fs.rm(dir, { recursive: true, force: true }) }
  }
}
