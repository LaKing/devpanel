import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { ProcessError } from '../server/runtime/process.mjs'
import { cumulativeDelta } from '../../harness/shared.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — what a step cost: reported, estimated from roster pricing, or unknown'

const PRICE = { input: 2, output: 10, cached: 1 }
// One Codex-shaped turn: 1000 input (200 of them cached), 100 output, priced the OpenAI way.
const TURN = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200 }
const TURN_USD = ((1000 - 200) * PRICE.input + 200 * PRICE.cached + 100 * PRICE.output) / 1e6
const close = (a, b) => Math.abs(a - b) < 1e-12

/** A roster price for every model the fixture's config root has. */
async function priceEveryModel (configRoot) {
  const dir = path.join(configRoot, 'roster-pricing')
  await fs.mkdir(dir, { recursive: true })
  for (const f of await fs.readdir(path.join(configRoot, 'roster'))) {
    const id = /^id: (.+)$/m.exec(await fs.readFile(path.join(configRoot, 'roster', f), 'utf8'))?.[1]?.trim()
    if (!id) continue
    await fs.writeFile(path.join(dir, `${id}.yaml`), [`id: ${id}`, `inputUsdPerMillionTokens: ${PRICE.input}`, `outputUsdPerMillionTokens: ${PRICE.output}`,
      `cachedInputUsdPerMillionTokens: ${PRICE.cached}`, 'source: test fixture', 'asOf: 2026-01-01', ''].join('\n'))
  }
}

const start = (f, invoke) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath,
  projectPath: f.projectPath,
  harnesses: { fake: { ...f.fake, invoke } },
  stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot,
  probe: f.probe,
  clock: f.clock,
  deliveryProvider: f.delivery
})

/**
 * The fake harness made to report as Codex does: the THREAD's running total,
 * turned into this turn's delta against the totals on the session it was given.
 * `fail(args)` makes an attempt grow the thread and then fail after starting.
 */
function codexLike (inner, { fail = () => false } = {}) {
  const threads = new Map()
  const grow = (id) => {
    const t = threads.get(id) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    const next = { inputTokens: t.inputTokens + TURN.inputTokens, outputTokens: t.outputTokens + TURN.outputTokens, cacheReadTokens: t.cacheReadTokens + TURN.cacheReadTokens }
    threads.set(id, next)
    return next
  }
  return async (args) => {
    if (fail(args)) {
      if (args.session?.id) grow(args.session.id)
      throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: 'API Error: 429 rate_limit_error retry-after: 1', invocationId: args.meta.invocationId })
    }
    const result = await inner(args)
    const totals = grow(result.session.id)
    const { delta, basis } = cumulativeDelta(args.session?.tokenTotals ?? null, totals)
    return { ...result, session: { ...result.session, tokenTotals: totals },
      usage: { provider: 'openai', ...delta, cacheCreationTokens: null, tokens: delta.inputTokens + delta.outputTokens, costUsd: null, tokensReported: totals, tokensBasis: basis } }
  }
}

export default async function (t) {
  t.section('1. a reported cost is reported, never estimated')
  {
    const f = await engineFixture()
    await priceEveryModel(f.configRoot)
    const inner = f.fake.invoke
    const engine = await start(f, async (args) => ({ ...(await inner(args)), usage: { provider: 'anthropic', inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0, tokens: 15, costUsd: 0.01 } }))
    const run = await engine.drive()
    t.ok('every step says reported', run.steps.every((s) => s.cost?.basis === 'reported' && s.cost.usd === 0.01), JSON.stringify(run.steps[0].cost))
    t.ok('the reported sum is costUsd', close(run.budgets.used.costUsd, 0.01 * run.steps.length), `${run.budgets.used.costUsd}`)
    t.eq('nothing estimated, nothing unknown', [run.budgets.used.estimatedCostUsd ?? 0, run.budgets.used.costEstimatedSteps ?? 0, run.budgets.used.costUnknownSteps ?? 0], [0, 0, 0])
    await releaseWorkspace(engine)
  }

  t.section('2. a fresh turn and a resumed turn on a clean baseline are estimated, with provenance, apart from reported cost')
  {
    const f = await engineFixture()
    await priceEveryModel(f.configRoot)
    const engine = await start(f, codexLike(f.fake.invoke))
    const run = await engine.drive()
    t.eq('the run completed', run.status, 'completed', run.blockedReason)
    const priced = run.steps.filter((s) => s.usage?.tokensBasis)
    t.ok('both fresh and resumed turns ran', priced.some((s) => s.usage.tokensBasis === 'first') && priced.some((s) => s.usage.tokensBasis === 'delta'), priced.map((s) => s.usage.tokensBasis).join(','))
    t.ok('every one is estimated', priced.every((s) => s.cost?.basis === 'estimated'), JSON.stringify(priced.find((s) => s.cost?.basis !== 'estimated')?.cost))
    const step = priced.find((s) => s.usage.tokensBasis === 'delta')
    t.ok('at the turn\'s own tokens', close(step.cost.usd, TURN_USD), `${step.cost.usd}`)
    t.eq('with its provenance', [step.cost.source, step.cost.asOf, step.cost.rates.input, step.cost.rates.cachedInput, step.cost.tokensBasis, typeof step.cost.model], ['test fixture', '2026-01-01', 2, 1, 'delta', 'string'])
    t.ok('the estimate sums apart', close(run.budgets.used.estimatedCostUsd, TURN_USD * priced.length), `${run.budgets.used.estimatedCostUsd}`)
    t.eq('counted as estimated steps', run.budgets.used.costEstimatedSteps, priced.length)
    t.eq('reported cost is untouched', run.budgets.used.costUsd ?? 0, 0)
    t.eq('and nothing is unknown', run.budgets.used.costUnknownSteps ?? 0, 0)
    t.ok('the price reached the snapshot participant', Object.values(engine.snapshot.participants).every((p) => p.model.pricing?.inputUsdPerMillionTokens === 2))
    await releaseWorkspace(engine)
  }

  t.section('3. a resumed turn after an attempt that failed once started is unknown; the next one is priced again')
  {
    const f = await engineFixture()
    await priceEveryModel(f.configRoot)
    // The first resumed turn on the coordinator's main session fails after growing the thread.
    let failed = false
    const fail = (args) => {
      if (failed || args.meta.role !== 'coordinator' || !args.session?.id || args.readOnlyTools) return false
      failed = true
      return true
    }
    const engine = await start(f, codexLike(f.fake.invoke, { fail }))
    const run = await engine.drive()
    t.ok('the failure happened and was retried', failed && run.failures.some((x) => x.retried), JSON.stringify(run.failures))
    const retried = run.steps.find((s) => s.role === 'coordinator' && s.usage?.tokensBasis === 'delta')
    t.eq('its delta holds the failed attempt\'s tokens too', retried?.usage.inputTokens, 2 * TURN.inputTokens)
    t.eq('so it is not priced', [retried?.cost.basis, retried?.cost.reason], ['unknown', 'unproved-baseline'])
    t.eq('one unknown step', run.budgets.used.costUnknownSteps, 1)
    const after = run.steps.filter((s) => s.role === 'coordinator' && s.usage?.tokensBasis === 'delta' && s.number > retried.number)
    t.ok('later turns on that session are estimated again', after.length > 0 && after.every((s) => s.cost.basis === 'estimated'), JSON.stringify(after.map((s) => s.cost)))
    await releaseWorkspace(engine)
  }

  t.section('4. usage that cannot be priced is unknown, and only it')
  {
    const f = await engineFixture()
    const engine = await start(f, codexLike(f.fake.invoke))
    const run = await engine.drive()
    const withUsage = run.steps.filter((s) => s.usage)
    t.ok('no roster price: unknown/no-pricing', withUsage.every((s) => s.cost?.basis === 'unknown' && s.cost.reason === 'no-pricing'), JSON.stringify(withUsage[0]?.cost))
    t.eq('every such step counts as unknown', run.budgets.used.costUnknownSteps, withUsage.length)
    t.eq('with no estimate', run.budgets.used.estimatedCostUsd ?? 0, 0)
    t.ok('the snapshot carries no price', Object.values(engine.snapshot.participants).every((p) => p.model.pricing === null))
    await releaseWorkspace(engine)
  }
  {
    const f = await engineFixture()
    await priceEveryModel(f.configRoot)
    // The plain fake reports no token counts at all.
    const engine = await start(f, f.fake.invoke)
    const run = await engine.drive()
    const withUsage = run.steps.filter((s) => s.usage)
    t.ok('priced, but no token counts: unknown/no-token-counts', withUsage.length > 0 && withUsage.every((s) => s.cost?.basis === 'unknown' && s.cost.reason === 'no-token-counts'), JSON.stringify(withUsage[0]?.cost))
    t.eq('counted as unknown', run.budgets.used.costUnknownSteps, withUsage.length)
    await releaseWorkspace(engine)
  }

  t.section('5. resumed usage, decided per launch record')
  {
    const f = await engineFixture()
    await priceEveryModel(f.configRoot)
    const engine = await start(f, codexLike(f.fake.invoke))
    await engine.drive()
    const role = 'coordinator'
    const totals = { inputTokens: 5000, outputTokens: 500, cacheReadTokens: 1000 }
    const delta = { provider: 'openai', ...TURN, costUsd: null, tokensReported: totals, tokensBasis: 'delta' }
    const first = { ...delta, tokensReported: TURN, tokensBasis: 'first' }
    const s = { id: 'S1' }
    const cost = (pending, usage, session = s) => engine.stepCost(role, pending, session, usage)
    t.eq('a delta against a baseline recorded on the same session: estimated', cost({ priorSessionId: 'S1', usageBaseline: { session: 'S1' } }, delta).basis, 'estimated')
    t.eq('without a recorded baseline: unknown', cost({ priorSessionId: 'S1', usageBaseline: null }, delta).reason, 'unproved-baseline')
    t.eq('a baseline of another session: unknown', cost({ priorSessionId: 'S1', usageBaseline: { session: 'S0' } }, delta).reason, 'unproved-baseline')
    t.eq('the runtime answered on another session: unknown', cost({ priorSessionId: 'S1', usageBaseline: { session: 'S1' } }, delta, { id: 'S2' }).reason, 'unproved-baseline')
    t.eq('a "first" on a resumed session: unknown', cost({ priorSessionId: 'S1', usageBaseline: { session: 'S1' } }, first).reason, 'unproved-baseline')
    t.eq('a counter reset: unknown', cost({ priorSessionId: 'S1', usageBaseline: { session: 'S1' } }, { ...delta, tokensBasis: 'reset' }).reason, 'unproved-baseline')
    t.eq('a fresh session (an instruction reset launches with none): estimated', cost({ priorSessionId: null, usageBaseline: null }, first).basis, 'estimated')
    t.eq('a pending from before launch records (no priorSessionId) counts as resumed: unknown', cost({ usageBaseline: null }, first).reason, 'unproved-baseline')
    t.eq('per-invocation usage (no running total) is the turn\'s own: estimated', cost({ priorSessionId: 'S1', usageBaseline: null }, { provider: 'anthropic', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null }).basis, 'estimated')
    t.eq('missing token counts: unknown', cost({ priorSessionId: null }, { provider: 'openai', inputTokens: null, outputTokens: null, costUsd: null }).reason, 'no-token-counts')

    // An attempt that provably never started gives the baseline it took back.
    const p = { usageBaseline: {} }
    engine.unreachedAttempt(p, 'never', { sessionScope: undefined, usageBaseline: { session: 'S1' } })
    t.eq('a never-started attempt restores its baseline', p.usageBaseline.main, { session: 'S1' })
    t.eq('so the next delta on that session is estimated', cost({ priorSessionId: 'S1', usageBaseline: p.usageBaseline.main }, delta).basis, 'estimated')
    const q = { usageBaseline: { read: { session: 'R2' } } }
    engine.unreachedAttempt(q, 'never', { sessionScope: 'read', usageBaseline: { session: 'R1' } })
    t.eq('never over a baseline a later turn recorded', q.usageBaseline.read, { session: 'R2' })
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
