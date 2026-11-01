import { retryNewSelftestFailures } from '../server/runtime/selftest-retry.mjs'

export const name = 'selftest retry — a drive gated only by new selftest failures runs once more before it counts'

const fresh = (tests) => ({ verdict: 'new-failures', newFailures: tests.map((test) => ({ command: 'collect', test })) })
const drive = (dir, selftest, result = 'passed') => ({ revision: 'r1', dir, result, baselineComparison: { selftest } })
const record = (c) => ({ dir: c.dir, result: c.result })

async function attempt ({ first, retry, again, limit = 1 }) {
    const calls = { reruns: 0, events: [] }
    const out = await retryNewSelftestFailures({ result: first, limit, aborted: () => false, record,
        rerun: async () => { calls.reruns++; return retry }, compare: async () => again, persist: async (e) => calls.events.push(e) })
    return { out, calls }
}

export default async function (t) {
    t.section('an unstable new failure is cleared by the second drive')
    {
        const { out, calls } = await attempt({ first: drive('checks/002', fresh(['service/fox'])), retry: drive('checks/003', null), again: { selftest: { verdict: 'none', newFailures: [] } } })
        t.eq('the drive ran once more, said so on the journal', [calls.reruns, calls.events[0]?.reason], [1, 'new-selftest-failures'])
        t.eq('the retry replaces the first drive and is marked flaky', [out.dir, out.flaky, out.baselineComparison.selftest.verdict], ['checks/003', true, 'none'])
        t.eq('the first drive is kept as an attempt with what it named', out.attempts, [{ dir: 'checks/002', result: 'passed', newFailures: [{ command: 'collect', test: 'service/fox' }] }])
    }

    t.section('a new failure named again reproduces, and the first drive stands')
    {
        const { out } = await attempt({ first: drive('checks/002', fresh(['service/fox'])), retry: drive('checks/003', null), again: { selftest: fresh(['service/fox', 'other']) } })
        t.eq('the first drive stands, recorded as reproduced', [out.dir, out.selftestReproduced, out.flaky], ['checks/002', true, undefined])
        t.eq('the retry is an attempt', out.attempts[0].dir, 'checks/003')
    }

    t.section('a different unstable test in the retry: nothing failed twice, so nothing is new')
    {
        const again = { selftest: { ...fresh(['service/fox']), baselineKnown: [{ command: 'collect', test: 'seed' }] } }
        const { out } = await attempt({ first: drive('checks/004', fresh(['service/settlement', 'fox/capture'])), retry: drive('checks/005', null), again })
        t.eq('the retry replaces the first drive, flaky', [out.dir, out.flaky, out.selftestReproduced], ['checks/005', true, undefined])
        t.eq('its comparison passes the gate: no new failures, the inherited ones kept', [out.baselineComparison.selftest.verdict, out.baselineComparison.selftest.newFailures], ['baseline-known', []])
        t.eq('every one-drive failure is named as flaky', out.baselineComparison.selftest.flakyFailures.map((f) => f.test), ['service/settlement', 'fox/capture', 'service/fox'])
    }

    t.section('a partial reproduction names only what failed twice')
    {
        const { out } = await attempt({ first: drive('checks/002', fresh(['admin/(thread-ready)', 'seed-apply', 'service/fox'])), retry: drive('checks/003', null), again: { selftest: fresh(['seed-apply']) } })
        t.eq('the first drive stands, reproduced', [out.dir, out.selftestReproduced], ['checks/002', true])
        t.eq('new failures are the intersection', out.baselineComparison.selftest.newFailures.map((f) => f.test), ['seed-apply'])
        t.eq('the rest are flaky', out.baselineComparison.selftest.flakyFailures.map((f) => f.test), ['admin/(thread-ready)', 'service/fox'])
        t.eq('the gate still fails it', out.baselineComparison.selftest.verdict, 'new-failures')
    }

    t.section('nothing else is retried')
    {
        const cases = {
            'a failed result (retryFailedCheck owns it)': drive('d', fresh(['x']), 'failed'),
            'a baseline-known failure': drive('d', { verdict: 'baseline-known', newFailures: [] }),
            'a check already retried': { ...drive('d', fresh(['x'])), attempts: [{ dir: 'e' }] }
        }
        for (const [label, first] of Object.entries(cases)) t.eq(label, (await attempt({ first, retry: null, again: null })).calls.reruns, 0)
        t.eq('retryFailed: 0 turns it off', (await attempt({ first: drive('d', fresh(['x'])), retry: null, again: null, limit: 0 })).calls.reruns, 0)
        const { out } = await attempt({ first: drive('checks/002', fresh(['x'])), retry: drive('checks/003', null, 'unavailable'), again: null })
        t.eq('a retry that did not pass proves nothing: the first drive stands', [out.dir, out.attempts[0].result, out.flaky], ['checks/002', 'unavailable', undefined])
    }
}
