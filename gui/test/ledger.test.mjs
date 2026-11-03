import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createLedger, windowsFor } from '../server/runtime/ledger.mjs'

export const name = 'spending ledger — append-only, replayed, and honest about what it does not know'

const temps = []
const temp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-ledger-')); temps.push(d); return path.join(d, 'ledger.jsonl') }
const at = (iso) => Date.parse(iso)

/** A ledger reopened from the same file: exactly what a restart does. */
const reopen = async (file) => { const l = createLedger({ file }); await l.load(); return l }

export default async function (t) {
  t.section('1. windows are UTC, and a zone nobody implemented is refused rather than assumed')
  {
    t.eq('a day is a UTC calendar day', windowsFor(at('2026-09-15T23:59:59Z')), { day: '2026-09-15', month: '2026-09' })
    t.eq('and the next instant is the next day', windowsFor(at('2026-09-16T00:00:00Z')), { day: '2026-09-16', month: '2026-09' })
    let refused = null
    try { windowsFor(at('2026-09-15T12:00:00Z'), 'Europe/Budapest') } catch (e) { refused = e.message }
    t.ok('an unimplemented timezone throws instead of silently meaning UTC', /only UTC windows are implemented/.test(refused ?? ''), refused)
  }

  t.section('2. an outstanding reservation is spent until something says otherwise')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 5 })
    const before = l.usage(at('2026-09-15T10:01:00Z'))
    t.eq('the window holds what was reserved, before a cent is spent', [before.day.reservedUsdMicros, before.day.settledUsdMicros, before.day.committedUsdMicros], [5_000_000, 0, 5_000_000])
    t.eq('and counts it as outstanding', [before.day.starts, before.day.outstanding], [1, 1])

    // The crash case: nothing settled it, and the process died.
    const afterCrash = await reopen(file)
    t.eq('a restart finds it still outstanding, not forgotten', afterCrash.usage(at('2026-09-15T10:02:00Z')).day.committedUsdMicros, 5_000_000)
    t.eq('and it is listed as such', afterCrash.outstanding().map((r) => r.id), ['r1'])

    await afterCrash.settle({ id: 'r1', costUsd: 2, at: at('2026-09-15T10:03:00Z') })
    const settled = afterCrash.usage(at('2026-09-15T10:04:00Z'))
    t.eq('settling replaces the reservation with what it cost', [settled.day.reservedUsdMicros, settled.day.settledUsdMicros, settled.day.committedUsdMicros], [0, 2_000_000, 2_000_000])
    t.eq('and it is no longer outstanding', settled.day.outstanding, 0)
  }

  t.section('3. an overage is recorded where it happened, and the window holds what was really spent')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 3 })
    const entry = await l.settle({ id: 'r1', costUsd: 7.5, at: at('2026-09-15T11:00:00Z') })
    t.eq('the overage is on the settlement', entry.overageUsdMicros, 4_500_000)
    const usage = l.usage(at('2026-09-15T12:00:00Z'))
    t.eq('the window holds the real cost, not the cap', usage.day.settledUsdMicros, 7_500_000)
    t.eq('with the overage reported separately', usage.day.overageUsdMicros, 4_500_000)
    // Whether that refuses further admissions is admission's decision; the
    // ledger's duty is that the number is there to refuse on.
    t.ok('so a limit of 5 is visibly exceeded rather than quietly absorbed', usage.day.settledUsdMicros > 5_000_000)
  }

  t.section('4. unknown cost is never a number: it consumes an allowance of its own')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'priced', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 4 })
    await l.settle({ id: 'priced', costUsd: 4, at: at('2026-09-15T10:30:00Z') })
    await l.reserve({ id: 'unpriced', subject: 'run-start', at: at('2026-09-15T11:00:00Z') })
    const held = l.usage(at('2026-09-15T11:01:00Z'))
    t.eq('an unpriced reservation reserves no money', held.day.reservedUsdMicros, 0)
    t.eq('it draws on the unpriced allowance instead', held.day.unpricedRuns, 1)
    t.ok('and never borrows the priced run\'s figure as an estimate', held.day.committedUsdMicros === 4_000_000, JSON.stringify(held.day))

    await l.settle({ id: 'unpriced', costUsd: null, at: at('2026-09-15T12:00:00Z') })
    const after = l.usage(at('2026-09-15T12:01:00Z'))
    t.eq('settling it with no price keeps it unpriced', after.day.unpricedRuns, 1)
    t.eq('and adds nothing to the money spent', after.day.settledUsdMicros, 4_000_000)

    // A subject that reserves nothing on purpose — a model call, priced only
    // after it returns — must not have its whole cost read as overage, or every
    // call would close a window it never exceeded.
    await l.reserve({ id: 'call', subject: 'model-call', at: at('2026-09-15T13:00:00Z') })
    const settled = await l.settle({ id: 'call', costUsd: 0.01, at: at('2026-09-15T13:00:05Z') })
    t.eq('spending against no reservation is not an overage', settled.overageUsdMicros, 0)
    const calls = l.usage(at('2026-09-15T13:01:00Z'))
    t.eq('but it is still money spent', calls.day.settledUsdMicros, 4_010_000)
    t.eq('and the window records no overage', calls.day.overageUsdMicros, 0)
    // The violation this splits: one shared allowance let unpriced CALLS consume
    // the RUN budget while remaining unbounded themselves.
    t.eq('a call counts against the call allowance, never the run one', [calls.day.unpricedCalls, calls.day.unpricedRuns], [1, 1])
  }

  t.section('4a. an estimate is counted in the window, and said apart; old lines read as they always did')
  {
    const file = await temp()
    const l = createLedger({ file })
    await l.load()
    const when = at('2026-09-15T10:00:00Z')
    for (const id of ['estimated', 'reported', 'unknown']) await l.reserve({ id, subject: 'model-call', at: when })
    const line = await l.settle({ id: 'estimated', estimate: { usd: 0.25, tokens: { input: 5 }, source: 's' }, at: when })
    t.eq('an estimate is no known cost', [line.costKnown, line.costUsdMicros, line.overageUsdMicros], [false, null, 0])
    t.eq('and is marked, with how it was reached', [line.estimated, line.estimatedUsdMicros, line.estimate], [true, 250_000, { tokens: { input: 5 }, source: 's' }])
    await l.settle({ id: 'reported', costUsd: 1, at: when })
    await l.settle({ id: 'unknown', at: when })
    let refused = null
    await l.reserve({ id: 'both', subject: 'model-call', at: when })
    try { await l.settle({ id: 'both', costUsd: 1, estimate: { usd: 1 }, at: when }) } catch (e) { refused = e.message }
    t.ok('a known cost and an estimate cannot both settle', /both a known cost and an estimate/.test(refused ?? ''))
    await l.settle({ id: 'both', at: when })
    const day = l.usage(when).day
    t.eq('the window holds it', [day.settledUsdMicros, day.committedUsd], [1_250_000, 1.25])
    t.eq('and says how much of that is estimated', [day.estimatedUsdMicros, day.estimatedUsd, day.estimatedCalls], [250_000, 0.25, 1])
    t.eq('unknown calls are counted, as no money', day.unknownCalls, 2)
    t.eq('the unpriced-call allowance counts every call, as before', day.unpricedCalls, 4)
    await fs.appendFile(file, JSON.stringify({ kind: 'reserve', id: 'old', subject: 'model-call', at: new Date(when).toISOString(), day: '2026-09-15', month: '2026-09', reservedUsdMicros: 0, unpriced: true, meta: {} }) + '\n' +
      JSON.stringify({ kind: 'settle', id: 'old', at: new Date(when).toISOString(), costUsdMicros: null, costKnown: false, overageUsdMicros: 0, meta: {} }) + '\n')
    const again = await reopen(file)
    t.eq('a line from before estimates replays as unknown', [again.usage(when).day.unknownCalls, again.usage(when).day.estimatedCalls, again.usage(when).day.settledUsdMicros], [3, 1, 1_250_000])
  }

  t.section('4b. money is integers: a sum no float can hold exactly still lands exactly')
  {
    const file = await temp()
    const l = await reopen(file)
    // 0.1 + 0.2 > 0.3 in binary floating point. A ceiling decided that way
    // refuses a run it has the money for.
    for (const [id, usd] of [['a', 0.1], ['b', 0.2]]) {
      await l.reserve({ id, subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: usd })
      await l.settle({ id, costUsd: usd, at: at('2026-09-15T10:01:00Z') })
    }
    const usage = l.usage(at('2026-09-15T10:02:00Z'))
    t.eq('two tenths and one tenth are exactly three tenths', usage.day.settledUsdMicros, 300_000)
    t.ok('which the float sum is not', 0.1 + 0.2 !== 0.3)
    t.eq('and the dollars beside them are for reading', usage.day.settledUsd, 0.3)

    // A hundred small settlements: float drift accumulates, integers do not.
    const many = await reopen(await temp())
    for (let n = 0; n < 100; n++) {
      await many.reserve({ id: `c${n}`, subject: 'model-call', at: at('2026-09-15T10:00:00Z') })
      await many.settle({ id: `c${n}`, costUsd: 0.07, at: at('2026-09-15T10:00:01Z') })
    }
    t.eq('a hundred settlements of seven cents are exactly seven dollars', many.usage(at('2026-09-15T10:01:00Z')).day.settledUsdMicros, 7_000_000)
    t.eq('and none of them is an overage', many.usage(at('2026-09-15T10:01:00Z')).day.overageUsdMicros, 0)
    t.eq('all counted as calls, not as runs', [many.usage(at('2026-09-15T10:01:00Z')).day.unpricedCalls, many.usage(at('2026-09-15T10:01:00Z')).day.unpricedRuns], [100, 0])
  }

  t.section('5. a torn final line loses that line and nothing before it')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 1 })
    await l.reserve({ id: 'r2', subject: 'run-start', at: at('2026-09-15T10:05:00Z'), maxCostUsd: 2 })
    // A crash mid-append: the last line never finished.
    await fs.appendFile(file, '{"kind":"reserve","id":"r3","subject":"run-st')

    const recovered = await reopen(file)
    t.eq('the complete entries survive', recovered.outstanding().map((r) => r.id), ['r1', 'r2'])
    t.eq('the torn one is gone', recovered.usage(at('2026-09-15T10:10:00Z')).day.committedUsdMicros, 3_000_000)
    t.ok('and the truncation is recorded rather than silent', recovered.recovered?.truncatedBytes > 0, JSON.stringify(recovered.recovered))

    // The file must still be appendable, or the next write concatenates onto a
    // broken line and corrupts an entry that was previously fine.
    await recovered.reserve({ id: 'r4', subject: 'run-start', at: at('2026-09-15T10:20:00Z'), maxCostUsd: 4 })
    const again = await reopen(file)
    t.eq('appending after recovery keeps every earlier fact readable', again.outstanding().map((r) => r.id), ['r1', 'r2', 'r4'])
    t.eq('with nothing double-counted', again.usage(at('2026-09-15T10:30:00Z')).day.committedUsdMicros, 7_000_000)
  }

  t.section('5b. a damaged line in the middle refuses to load instead of erasing what follows')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 5 })
    await fs.appendFile(file, 'not json\n')
    await fs.appendFile(file, JSON.stringify({ kind: 'reserve', id: 'r2', subject: 'run-start', at: '2026-09-15T10:05:00.000Z', maxCostUsd: 50, maxCostUsdMicros: 50_000_000 }) + '\n')
    const before = await fs.readFile(file, 'utf8')
    let refused = null
    try { await reopen(file) } catch (error) { refused = error }
    t.ok('the load is refused, naming the line', /line 2/.test(refused?.message ?? ''), refused?.message)
    t.eq('and nothing is truncated: the later reservation is still on disk', await fs.readFile(file, 'utf8'), before)
  }

  t.section('5c. a complete but unterminated final line is kept and terminated')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 1 })
    const text = await fs.readFile(file, 'utf8')
    await fs.writeFile(file, text.slice(0, -1))
    const reopened = await reopen(file)
    t.eq('the entry survives', reopened.outstanding().map((r) => r.id), ['r1'])
    t.eq('nothing was reported as dropped', reopened.recovered, null)
    await reopened.reserve({ id: 'r2', subject: 'run-start', at: at('2026-09-15T10:01:00Z'), maxCostUsd: 2 })
    t.eq('the next append does not join onto it', (await reopen(file)).outstanding().map((r) => r.id), ['r1', 'r2'])
  }

  t.section('6. nothing is ever rewritten, and an id cannot be reused')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 1 })
    const first = await fs.readFile(file, 'utf8')
    await l.settle({ id: 'r1', costUsd: 1, at: at('2026-09-15T10:01:00Z') })
    const second = await fs.readFile(file, 'utf8')
    t.ok('a settlement appends; it does not edit the reservation', second.startsWith(first), second)
    t.eq('both facts are on disk', second.trim().split('\n').length, 2)

    for (const [label, fn] of [
      ['reserving the same id twice', () => l.reserve({ id: 'r1', subject: 'run-start', maxCostUsd: 1 })],
      ['settling twice', () => l.settle({ id: 'r1', costUsd: 1 })],
      ['releasing something already spent', () => l.release({ id: 'r1', reason: 'changed my mind' })],
      ['settling what was never reserved', () => l.settle({ id: 'nope', costUsd: 1 })],
      ['a reservation with a negative ceiling', () => l.reserve({ id: 'neg', subject: 'run-start', maxCostUsd: -1 })],
      ['a subject nobody defined', () => l.reserve({ id: 'x', subject: 'lunch', maxCostUsd: 1 })],
      ['releasing without a reason', () => l.release({ id: 'r2', reason: ' ' })]
    ]) {
      let refused = null
      try { await fn() } catch (e) { refused = e.message }
      t.ok(`${label} is refused`, Boolean(refused), refused ?? 'accepted')
    }
  }

  t.section('7. a released reservation gives the money back; a settled one never can')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'r1', subject: 'run-start', at: at('2026-09-15T10:00:00Z'), maxCostUsd: 9 })
    await l.release({ id: 'r1', reason: 'the start was refused before anything ran', at: at('2026-09-15T10:00:30Z') })
    const usage = l.usage(at('2026-09-15T10:01:00Z'))
    t.eq('a release removes the commitment entirely', [usage.day.committedUsdMicros, usage.day.starts, usage.day.outstanding], [0, 0, 0])
    t.eq('and it stays gone across a restart', (await reopen(file)).usage(at('2026-09-15T10:02:00Z')).day.committedUsdMicros, 0)
  }

  t.section('8. windows close on their own boundaries')
  {
    const file = await temp()
    const l = await reopen(file)
    await l.reserve({ id: 'yesterday', subject: 'run-start', at: at('2026-09-14T23:00:00Z'), maxCostUsd: 10 })
    await l.settle({ id: 'yesterday', costUsd: 10, at: at('2026-09-14T23:30:00Z') })
    await l.reserve({ id: 'today', subject: 'run-start', at: at('2026-09-15T01:00:00Z'), maxCostUsd: 2 })
    await l.settle({ id: 'today', costUsd: 2, at: at('2026-09-15T01:30:00Z') })
    const now = l.usage(at('2026-09-15T02:00:00Z'))
    t.eq('the day holds only today', now.day.settledUsdMicros, 2_000_000)
    t.eq('the month holds both', now.month.settledUsdMicros, 12_000_000)
    t.eq('and says which windows it means', [now.windows.day, now.windows.month], ['2026-09-15', '2026-09'])
    const lastMonth = l.usage(at('2026-10-01T00:00:00Z'))
    t.eq('a new month starts empty', [lastMonth.month.settledUsdMicros, lastMonth.day.settledUsdMicros], [0, 0])
  }

  t.section('9. a wake is durable: a restart mid-chain resumes it rather than granting a fresh allowance')
  {
    const file = await temp()
    const l = await reopen(file)
    const opened = await l.openWake({ id: 'w1', at: at('2026-09-15T10:00:00Z'), reason: 'issues-changed' })
    t.eq('a new wake starts at zero', [opened.calls, opened.resumed], [0, false])
    for (const n of [1, 2, 3]) {
      await l.reserve({ id: `call-${n}`, subject: 'model-call', at: at('2026-09-15T10:0' + n + ':00Z'), maxCostUsd: 1, meta: { wake: 'w1' } })
      await l.settle({ id: `call-${n}`, costUsd: 0.2, at: at('2026-09-15T10:0' + n + ':30Z') })
    }
    t.eq('its calls are counted from the ledger', l.wakeCalls('w1'), 3)

    const afterCrash = await reopen(file)
    t.eq('a restart resumes the same wake', (await afterCrash.openWake({ id: 'w1', at: at('2026-09-15T10:10:00Z') })).resumed, true)
    t.eq('with the count it already had, not a fresh one', afterCrash.wakeCalls('w1'), 3)
    t.eq('a different wake has its own count', afterCrash.wakeCalls('w2'), 0)
    t.eq('and the calls are money like anything else', afterCrash.usage(at('2026-09-15T10:11:00Z')).day.settledUsdMicros, 600_000)
    t.eq('counted as calls, not as starts', [afterCrash.usage(at('2026-09-15T10:11:00Z')).day.modelCalls, afterCrash.usage(at('2026-09-15T10:11:00Z')).day.starts], [3, 0])
  }

  t.section('10. reading or writing before the replay is a mistake, not a default')
  {
    const l = createLedger({ file: await temp() })
    let refused = null
    try { l.usage() } catch (e) { refused = e.message }
    t.ok('usage before load() throws rather than reporting an empty ledger', /must run before/.test(refused ?? ''), refused)
    refused = null
    try { await l.reserve({ id: 'r', subject: 'run-start', maxCostUsd: 1 }) } catch (e) { refused = e.message }
    t.ok('and so does reserving', /must run before/.test(refused ?? ''), refused)
  }

  for (const file of temps) await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {})
}
