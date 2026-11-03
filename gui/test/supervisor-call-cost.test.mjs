import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { cumulativeDelta } from '../../harness/shared.mjs'
import { estimateCallCost, leavesCleanBaseline } from '../server/runtime/call-cost.mjs'
import { createLedger } from '../server/runtime/ledger.mjs'
import { remainingBudget } from '../server/supervisor-summary.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { supervisorCost } from '../src/format.js'

export const name = 'supervisor call cost — estimated from a call\'s own tokens, or unknown'

const PRICE = { id: 'm', inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10, cachedInputUsdPerMillionTokens: 1, source: 'test fixture', asOf: '2026-01-01' }
const OPTIONS = { model: 'm', message: 'go', limits: { maxCalls: 50 } }
const temps = []
const wait = async (test, ms = 8000) => { const end = Date.now() + ms; while (!(await test())) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const cancelled = (extra = {}) => Object.assign(new Error('cancelled'), { name: 'AbortError', termination: {} }, extra)

/*
 * The Codex adapter's accounting over a fake thread: running totals per thread,
 * the real cumulativeDelta, and the descriptor as harness/codex.mjs builds it. A
 * step says what the call really used and what it reported, so an inflated delta
 * arises the way it does live instead of being scripted.
 */
function fakeCodex (threads = new Map()) {
  const steps = [], calls = []
  let forks = 0
  const invoke = async (args) => {
    const step = steps.shift() ?? {}
    calls.push(args)
    if (step.hold) await step.hold
    const parent = args.session?.id ?? null
    const id = args.fork ? `fork-${++forks}` : step.thread ?? parent ?? 'thread-1'
    const start = step.resetTo ? { input: 0, output: 0, cached: 0 } : threads.get(id) ?? (args.fork ? threads.get(parent) : null) ?? { input: 0, output: 0, cached: 0 }
    const used = { input: 0, output: 0, cached: 0, ...step.used }
    const totals = { input: start.input + used.input, output: start.output + used.output, cached: start.cached + used.cached }
    threads.set(id, totals)
    if (step.fail) throw step.fail
    const report = step.report ?? ['input', 'output', 'cached']
    const reported = {
      inputTokens: report.includes('input') ? totals.input : null,
      outputTokens: report.includes('output') ? totals.output : null,
      cacheReadTokens: report.includes('cached') ? totals.cached : null
    }
    const { delta, totals: next, basis } = cumulativeDelta(args.session?.tokenTotals ?? null, reported)
    return {
      session: { id, tokenTotals: Object.keys(next).length ? next : (args.session?.tokenTotals ?? null) },
      response: JSON.stringify({ message: 'ok', action: null }),
      usage: { provider: 'openai', inputTokens: delta.inputTokens, outputTokens: delta.outputTokens, cacheCreationTokens: null, cacheReadTokens: delta.cacheReadTokens,
        tokens: (delta.inputTokens ?? 0) + (delta.outputTokens ?? 0), costUsd: step.reportedCost ?? null, tokensReported: reported, tokensBasis: basis }
    }
  }
  return { steps, calls, invoke, threads }
}

async function setup ({ pricing = PRICE, state = null, threads } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-call-cost-'))
  temps.push(dir)
  if (state) await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state))
  const fake = fakeCodex(threads)
  const model = { id: 'm', title: 'M', harness: 'codex', model: 'wire', verification: { status: 'verified' }, ...(pricing ? { pricing } : {}) }
  const agent = await createTopSupervisor({
    dir, adapter: { invoke: fake.invoke }, pollMs: 20, models: async () => [model],
    tools: { projects: async () => [], playbooks: async () => [], listIssues: async () => [] }
  })
  const answers = () => agent.get().messages.filter((m) => m.role === 'assistant' && !m.side)
  const settled = () => answers().length
  const idle = () => agent.get().status === 'active' && !agent.get().pending
  /** One call: the first by Start, the rest by a message. Returns what its chat message says it cost. */
  const start = async (step = { used: { input: 10 } }) => {
    const before = settled()
    fake.steps.push(step)
    await agent.start(OPTIONS)
    await wait(() => settled() === before + 1 && idle())
    return answers().at(-1).cost
  }
  const turn = async (step = { used: { input: 10 } }) => {
    const before = settled()
    fake.steps.push(step)
    await agent.chat('next')
    await wait(() => settled() === before + 1 && idle())
    return answers().at(-1).cost
  }
  /** A call that ends in a cancellation: nothing comes back, and Start resumes the same session. */
  const failTurn = async (step) => {
    fake.steps.push(step)
    await agent.chat('next')
    await wait(() => agent.get().status === 'stopped')
  }
  const settlements = async () => (await fs.readFile(path.join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'settle')
  const close = async () => { await agent.stop(); await agent.shutdown() }
  return { dir, agent, fake, start, turn, failTurn, settlements, close }
}

export default async function (t) {
  t.section('C1: the arithmetic is the call\'s own tokens at the entry\'s rates')
  {
    const codex = { provider: 'openai', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400, tokensBasis: 'first', tokensReported: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 } }
    t.eq('OpenAI counts cached input inside input', estimateCallCost(codex, PRICE).usd, (600 * 2 + 400 * 1 + 100 * 10) / 1e6)
    const additive = { provider: 'zai', inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheCreationTokens: 200 }
    t.eq('other providers report each category apart, and a cache write falls back to the input rate', estimateCallCost(additive, PRICE).usd, (100 * 2 + 1000 * 1 + 200 * 2 + 10 * 10) / 1e6)
    t.eq('a cache-write rate is used when given', estimateCallCost(additive, { ...PRICE, cacheWriteUsdPerMillionTokens: 5 }).usd, (100 * 2 + 1000 * 1 + 200 * 5 + 10 * 10) / 1e6)
    t.ok('counts without a thread total are the invocation\'s own, in a fork as well', estimateCallCost(additive, PRICE, { resumed: true, fork: true }) !== null)
    t.eq('an estimate says how it was reached', [estimateCallCost(codex, PRICE).source, estimateCallCost(codex, PRICE).asOf, estimateCallCost(codex, PRICE).tokensBasis, estimateCallCost(codex, PRICE).tokens.cacheRead], ['test fixture', '2026-01-01', 'first', 400])
  }

  t.section('C1: a Codex basis is taken only where it is this call\'s alone')
  {
    const usage = (tokensBasis) => ({ provider: 'openai', inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, tokensBasis, tokensReported: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0 } })
    t.ok('first on a fresh session', estimateCallCost(usage('first'), PRICE, { resumed: false }) !== null)
    t.eq('first on a resumed session is the whole thread', estimateCallCost(usage('first'), PRICE, { resumed: true, ownUsage: true }), null)
    t.ok('delta with a clean baseline', estimateCallCost(usage('delta'), PRICE, { resumed: true, ownUsage: true }) !== null)
    t.eq('delta without one', estimateCallCost(usage('delta'), PRICE, { resumed: true, ownUsage: false }), null)
    t.eq('reset', estimateCallCost(usage('reset'), PRICE, { resumed: true, ownUsage: true }), null)
    t.eq('a fork, whose counters nobody has observed', estimateCallCost(usage('delta'), PRICE, { resumed: true, ownUsage: true, fork: true }), null)
    t.eq('counters incomplete in this invocation', estimateCallCost({ ...usage('delta'), tokensReported: { inputTokens: 5, outputTokens: 1, cacheReadTokens: null } }, PRICE, { resumed: true, ownUsage: true }), null)
    t.eq('a clean baseline needs every counter', leavesCleanBaseline({ tokensBasis: 'delta', tokensReported: { inputTokens: 1, outputTokens: null, cacheReadTokens: 1 } }), false)
    t.eq('and no reset', leavesCleanBaseline(usage('reset')), false)
    t.eq('and the same session', leavesCleanBaseline(usage('delta'), { priorSessionId: 'a', sessionId: 'b' }), false)
    t.eq('which is all it takes', leavesCleanBaseline(usage('delta'), { priorSessionId: 'a', sessionId: 'a' }), true)
  }

  t.section('C1, C4: a call using 30 reports nothing; the next delta holds 50 and is not believed')
  {
    const s = await setup()
    const first = await s.start({ used: { input: 100 } })
    t.eq('a fresh session\'s first call is estimated', [first.basis, first.usd], ['estimated', 200 / 1e6])
    const silent = await s.turn({ used: { input: 30 }, report: [] })
    t.eq('a success with no usage is unknown', [silent.basis, silent.usd], ['unknown', null])
    const inflated = await s.turn({ used: { input: 20 } })
    t.eq('the next, whose delta is 50 and whose own use is 20, stays unknown', [inflated.basis, inflated.usd], ['unknown', null])
    const clean = await s.turn({ used: { input: 10 } })
    t.eq('the one after is estimated from its own 10 tokens only', [clean.basis, clean.usd], ['estimated', 20 / 1e6])
    const lines = await s.settlements()
    t.eq('its ledger line records them', lines.at(-1).estimate.tokens.input, 10)
    t.eq('no line was ever estimated at 50', lines.filter((l) => l.estimate?.tokens.input === 50).length, 0)
    t.eq('both unknown calls are counted', s.agent.get().cost.unknownCalls, 2)
    t.eq('and both estimates summed', [s.agent.get().cost.estimatedCalls, s.agent.get().cost.estimatedUsd], [2, 220 / 1e6])
    await s.close()
  }

  t.section('C1, C4: a cancelled call hands back nothing, so the call after it stays unknown')
  {
    const s = await setup()
    await s.start({ used: { input: 100 } })
    await s.failTurn({ used: { input: 40 }, fail: cancelled() })
    t.eq('the cancelled call is counted unknown', s.agent.get().cost.unknownCalls, 1)
    t.eq('the session survives Stop', s.agent.get().session.id, 'thread-1')
    const after = await s.start({ used: { input: 20 } })
    t.eq('the next delta holds the cancelled tokens: unknown', after.basis, 'unknown')
    const clean = await s.turn({ used: { input: 10 } })
    t.eq('then estimated from its own tokens', [clean.basis, clean.usd], ['estimated', 20 / 1e6])
    await s.close()
  }

  t.section('C1, C4: a failed call leaves no clean baseline, and one reporting a cost adds it')
  {
    const s = await setup()
    await s.start({ used: { input: 100 } })
    t.eq('a clean turn proves its session', s.agent.get().ownUsageSession, 'thread-1')
    await s.failTurn({ used: { input: 1 }, fail: cancelled({ payload: { total_cost_usd: 0.25 } }) })
    t.eq('the proof does not survive the failure', s.agent.get().ownUsageSession, null)
    t.eq('its reported cost is reported, not unknown', [s.agent.get().cost.reportedUsd, s.agent.get().cost.unknownCalls], [0.25, 0])
    await s.agent.shutdown()
  }

  t.section('C1, C4: partial counters leave the totals short, so that call and the next are unknown')
  {
    for (const [what, report] of [['cached input', ['input', 'output']], ['output', ['input', 'cached']]]) {
      const s = await setup()
      await s.start({ used: { input: 100 } })
      t.eq(`${what} missing: unknown`, (await s.turn({ used: { input: 5, output: 1, cached: 2 }, report })).basis, 'unknown')
      t.eq('the next is unknown too', (await s.turn({ used: { input: 5, output: 1, cached: 2 } })).basis, 'unknown')
      const clean = await s.turn({ used: { input: 10 } })
      t.eq('then estimated from its own tokens', [clean.basis, clean.usd], ['estimated', 20 / 1e6])
      await s.close()
    }
  }

  t.section('C1, C4: a changed session id and a counter reset prove nothing')
  {
    const s = await setup()
    await s.start({ used: { input: 100 } })
    t.eq('another thread answered: unknown', (await s.turn({ thread: 'thread-2', used: { input: 500 } })).basis, 'unknown')
    t.eq('and the next', (await s.turn({ used: { input: 5 } })).basis, 'unknown')
    t.eq('then estimated', (await s.turn({ used: { input: 5 } })).basis, 'estimated')
    t.eq('counters went down: unknown', (await s.turn({ resetTo: true, used: { input: 3 } })).basis, 'unknown')
    t.eq('and the next', (await s.turn({ used: { input: 5 } })).basis, 'unknown')
    t.eq('then estimated', (await s.turn({ used: { input: 5 } })).basis, 'estimated')
    await s.close()
  }

  t.section('C1, C4: a fresh session with no usage, and a session older than this accounting')
  {
    const s = await setup()
    t.eq('no usage on a fresh session: unknown', (await s.start({ used: { input: 100 }, report: [] })).basis, 'unknown')
    t.eq('the next has no totals to subtract: unknown', (await s.turn({ used: { input: 5 } })).basis, 'unknown')
    t.eq('then estimated', (await s.turn({ used: { input: 5 } })).basis, 'estimated')
    await s.close()

    const threads = new Map([['thread-1', { input: 100, output: 0, cached: 0 }]])
    const state = { status: 'stopped', session: { id: 'thread-1', tokenTotals: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 } },
      model: { id: 'm', title: 'M', harness: 'codex', model: 'wire', verification: { status: 'verified' } }, messages: [], queue: [], ownedRuns: [], previews: {}, calls: 0, starts: 0, startsByIssue: {}, launches: [], failedLaunches: {}, history: {}, startBudgetVersion: 2, costUsd: 0, unknownCostCalls: 0 }
    const old = await setup({ state, threads })
    t.eq('a resumed session with no recorded clean turn: unknown', (await old.start({ used: { input: 20 } })).basis, 'unknown')
    const next = await old.turn({ used: { input: 10 } })
    t.eq('then estimated from its own tokens', [next.basis, next.usd], ['estimated', 20 / 1e6])
    await old.close()
  }

  t.section('C1, C4: the forked ask is unknown and counted, and so is the main call after it')
  {
    const s = await setup()
    await s.start({ used: { input: 100 } })
    s.fake.steps.push({ used: { input: 7 } })
    await s.agent.ask('A side question')
    await wait(() => !s.agent.get().asking)
    const answer = s.agent.get().messages.find((m) => m.side === 'answer')
    t.eq('the fork ran in a copy', s.fake.calls.at(-1).fork, true)
    t.eq('its cost is unknown, though its delta looks like its own', [answer.cost.basis, answer.cost.usd], ['unknown', null])
    t.eq('and counted', s.agent.get().cost.unknownCalls, 1)
    t.eq('its ledger line estimates nothing', (await s.settlements()).at(-1).estimated, undefined)
    t.eq('the next main call is unknown', (await s.turn({ used: { input: 5 } })).basis, 'unknown')
    t.eq('the one after is estimated', (await s.turn({ used: { input: 5 } })).basis, 'estimated')

    let release
    const held = new Promise((resolve) => { release = resolve })
    const inFlight = s.fake.calls.length
    const answered = s.agent.get().messages.filter((m) => m.role === 'assistant' && !m.side).length
    s.fake.steps.push({ used: { input: 5 }, hold: held })
    await s.agent.chat('next')
    await wait(() => s.fake.calls.length === inFlight + 1)
    s.fake.steps.push({ used: { input: 7 } })
    await s.agent.ask('Another side question')
    await wait(() => !s.agent.get().asking)
    release()
    await wait(() => s.agent.get().messages.filter((m) => m.role === 'assistant' && !m.side).length === answered + 1 && s.agent.get().status === 'active')
    t.eq('a main call a fork overlapped is unknown', s.agent.get().messages.filter((m) => m.role === 'assistant' && !m.side).at(-1).cost.basis, 'unknown')
    t.eq('with no fork left running, the next is estimated', (await s.turn({ used: { input: 5 } })).basis, 'estimated')
    await s.close()
  }

  t.section('C1, C4: a forked ask that fails adds what it reports, and is unknown only when it reports nothing')
  {
    const s = await setup()
    await s.start({ used: { input: 100 } })
    const ask = async (fail) => {
      s.fake.steps.push({ used: { input: 7 }, fail })
      const before = s.agent.get().messages.filter((m) => m.side === 'answer').length
      await s.agent.ask('A side question')
      await wait(() => !s.agent.get().asking && s.agent.get().messages.filter((m) => m.side === 'answer').length === before + 1)
      return s.agent.get().messages.filter((m) => m.side === 'answer').at(-1)
    }
    const reported = await ask(Object.assign(new Error('boom'), { payload: { total_cost_usd: 0.25 } }))
    t.eq('its reported cost is reported', [s.agent.get().cost.reportedUsd, s.agent.get().cost.unknownCalls, reported.cost.basis, reported.failed], [0.25, 0, 'reported', true])
    t.eq('and on the ledger', [(await s.settlements()).at(-1).costUsdMicros, (await s.settlements()).at(-1).costKnown], [250_000, true])
    await ask(new Error('boom'))
    t.eq('with none reported it is unknown', [s.agent.get().cost.reportedUsd, s.agent.get().cost.unknownCalls], [0.25, 1])
    const settledBefore = (await s.settlements()).length
    await ask(Object.assign(new Error('spawn fake ENOENT'), { kind: 'spawn-error', started: false }))
    t.eq('one that never started cost nothing', [s.agent.get().cost.unknownCalls, (await s.settlements()).length], [1, settledBefore])
    const lines = (await fs.readFile(path.join(s.dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
    t.eq('its reservation goes back', lines.at(-1).kind, 'release')
    await s.close()
  }

  t.section('C2: an estimate is marked on the ledger, apart from a reported cost')
  {
    const s = await setup()
    await s.start({ used: { input: 100, output: 10 } })
    await s.turn({ used: { input: 5 }, reportedCost: 0.5 })
    const [estimated, reported] = await s.settlements()
    t.eq('the estimated line carries no known cost', [estimated.costKnown, estimated.costUsdMicros], [false, null])
    t.eq('it is marked, with its amount', [estimated.estimated, estimated.estimatedUsdMicros], [true, 300])
    t.eq('and says how it was reached', [estimated.estimate.tokens.input, estimated.estimate.rates.input, estimated.estimate.source, estimated.estimate.tokensBasis], [100, 2, 'test fixture', 'first'])
    t.eq('a reported line is as it always was', [reported.costKnown, reported.costUsdMicros, reported.estimated], [true, 500_000, undefined])
    await s.close()
    const replayed = createLedger({ file: path.join(s.dir, 'ledger.jsonl') })
    await replayed.load()
    const day = replayed.usage().day
    t.eq('a restart reads them apart', [day.estimatedCalls, day.estimatedUsdMicros, day.settledUsdMicros], [1, 300, 500_300])
  }

  t.section('C3: the view says reported, estimated and unknown apart')
  {
    const s = await setup()
    await s.start({ used: { input: 100 } })
    await s.turn({ used: { input: 100 } })
    await s.turn({ used: { input: 5 }, report: [] })
    await s.turn({ used: { input: 5 }, reportedCost: 0.5 })
    const expected = { reportedUsd: 0.5, estimatedUsd: 400 / 1e6, estimatedCalls: 2, unknownCalls: 1 }
    t.eq('on the full view', s.agent.get().cost, expected)
    t.eq('on the status the app bar polls', s.agent.status().cost, expected)
    t.eq('costUsd is what was reported, nothing else', s.agent.get().costUsd, 0.5)
    t.eq('each message says its own', s.agent.get().messages.filter((m) => m.role === 'assistant').map((m) => m.cost.basis), ['estimated', 'estimated', 'unknown', 'reported'])
    t.eq('the panel\'s words', supervisorCost(expected), ['$0.50 reported', '~$0.0004 estimated (2 calls)', '1 call unknown cost'])
    t.eq('nothing spent says nothing', supervisorCost({ reportedUsd: 0, estimatedUsd: 0, estimatedCalls: 0, unknownCalls: 0 }), [])
    await s.close()
  }

  t.section('C3: the supervisor reads them apart too, where windows decide')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-call-cost-'))
    temps.push(dir)
    const ledger = createLedger({ file: path.join(dir, 'ledger.jsonl') })
    await ledger.load()
    await ledger.reserve({ id: 'a', subject: 'model-call' })
    await ledger.settle({ id: 'a', estimate: { usd: 0.25 } })
    await ledger.reserve({ id: 'b', subject: 'model-call' })
    await ledger.settle({ id: 'b' })
    const limits = { starts: 1, usd: 1, unpricedRuns: 1, unpricedCalls: 10 }
    const budget = remainingBudget({ limits: { maxCalls: 1, maxRuns: 1, maxStartsPerIssue: 1 } }, { policy: { active: true, policy: { enforceAllowances: true, daily: limits, monthly: limits, perWakeCalls: 5 } }, usage: ledger.usage() })
    t.eq('the estimate is in what is committed, and said', [budget.policy.windows.day.usd.committed, budget.policy.windows.day.usd.estimated], [0.25, 0.25])
    t.eq('the unknown call is counted beside it', budget.policy.windows.day.unknownCalls, 1)
  }

  t.section('C4: what cannot be estimated stays unknown, and unknown is not zero')
  {
    const s = await setup({ pricing: null })
    const cost = await s.start({ used: { input: 100 } })
    t.eq('a model with no price: unknown', [cost.basis, cost.usd], ['unknown', null])
    t.eq('counted', s.agent.get().cost.unknownCalls, 1)
    const line = (await s.settlements()).at(-1)
    t.eq('settled with no cost at all', [line.costKnown, line.costUsdMicros, line.estimated], [false, null, undefined])
    await s.close()

    const empty = await setup()
    const none = await empty.start({ used: { input: 0, output: 0 } })
    t.eq('zero tokens is no usage, never $0', [none.basis, none.usd, empty.agent.get().cost.estimatedCalls], ['unknown', null, 0])
    await empty.close()

    t.eq('no usage object at all', estimateCallCost(null, PRICE), null)
    t.eq('no counts in it', estimateCallCost({ provider: 'zai', inputTokens: null, outputTokens: null }, PRICE), null)
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
}
