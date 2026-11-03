import { earlierDrives, reproducedSelftests, retryNewSelftestFailures, sameFailureEarlier } from '../server/runtime/selftest-retry.mjs'
import { checkSummary } from '../server/runtime/check-summary.mjs'

export const name = 'selftest retry — a drive gated only by new selftest failures runs once more before it counts'

const fresh = (tests) => ({ verdict: 'new-failures', newFailures: tests.map((test) => ({ command: 'collect', test })) })
const drive = (dir, selftest, result = 'passed') => ({ revision: 'r1', dir, result, baselineComparison: { selftest } })
const record = (c) => ({ dir: c.dir, result: c.result })

async function attempt ({ first, retry, again, limit = 1, earlier = [] }) {
    const calls = { reruns: 0, events: [] }
    const out = await retryNewSelftestFailures({ result: first, limit, aborted: () => false, record, earlier,
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

    t.section('a failure history classifies is out of the verdict: no second drive, and the lists of both drives merge')
    {
        const ignored = (test) => ({ command: 'collect', test, ignoredByGate: true })
        const { out, calls } = await attempt({ first: drive('checks/002', { verdict: 'unstable', newFailures: [], unstable: [ignored('svc/flaky')] }) })
        t.eq('an unstable verdict asks for no second drive', [calls.reruns, out.dir], [0, 'checks/002'])
        const beside = { ...fresh(['core/new']), unstable: [ignored('svc/flaky')] }
        const reproduced = await attempt({ first: drive('checks/002', beside), retry: drive('checks/003', null), again: { selftest: { ...fresh(['core/new']), unstable: [ignored('svc/flaky'), ignored('svc/other')] } } })
        t.eq('a stable new failure still gets its second drive, and stands', [reproduced.calls.reruns, reproduced.out.baselineComparison.selftest.verdict, reproduced.out.baselineComparison.selftest.newFailures.map((f) => f.test)], [1, 'new-failures', ['core/new']])
        t.eq('each ignored test is listed once', reproduced.out.baselineComparison.selftest.unstable.map((f) => f.test), ['svc/flaky', 'svc/other'])
        const cleared = await attempt({ first: drive('checks/002', beside), retry: drive('checks/003', null), again: { selftest: { verdict: 'unstable', newFailures: [], unstable: [ignored('svc/other')] } } })
        t.eq('cleared by the retry, the drive passes the gate as unstable, naming both', [cleared.out.dir, cleared.out.flaky, cleared.out.baselineComparison.selftest.verdict, cleared.out.baselineComparison.selftest.unstable.map((f) => f.test)], ['checks/003', true, 'unstable', ['svc/flaky', 'svc/other']])
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

    const reproducedOn = (revision, tests) => ({ revision, retryEvidence: { reproduced: tests.map((test) => ({ command: 'collect', test })) } })

    t.section('AC1: every new failure reproduced on an earlier revision: no second drive, and the record says so')
    {
        const { out, calls } = await attempt({ first: drive('checks/009', fresh(['a', 'b'])), retry: null, again: null, earlier: [reproducedOn('r0', ['a']), reproducedOn('r00', ['b', 'c'])] })
        t.eq('no retry drive ran, and no attempt is recorded', [calls.reruns, out.attempts], [0, undefined])
        t.eq('the record names the failures and the revisions that reproduced them', out.retrySkipped, { reason: 'selftest-reproduced-earlier', failures: [{ command: 'collect', test: 'a', revision: 'r0' }, { command: 'collect', test: 'b', revision: 'r00' }] })
        t.eq('the journal says so too, with no checks-retry', calls.events.map((e) => [e.type, e.revision, e.reason]), [['checks-retry-skipped', 'r1', 'selftest-reproduced-earlier']])
        t.eq('the first drive stands, its gate unchanged', [out.dir, out.baselineComparison.selftest.verdict], ['checks/009', 'new-failures'])
        t.ok('a reviewer reads it in the check summary', /already failed in two drives/.test(checkSummary(out).retryNote))
    }

    t.section('AC3: a failure not reproduced earlier still gets its drive')
    {
        const earlier = [reproducedOn('r0', ['a'])]
        const mixed = await attempt({ first: drive('checks/009', fresh(['a', 'new'])), retry: drive('checks/010', null), again: { selftest: fresh(['a', 'new']) }, earlier })
        t.eq('one new failure among reproduced ones: the retry ran', [mixed.calls.reruns, mixed.out.retrySkipped, mixed.out.selftestReproduced], [1, undefined, true])
        const none = await attempt({ first: drive('checks/009', fresh(['a'])), retry: drive('checks/010', null), again: { selftest: fresh(['a']) } })
        t.eq('no earlier revision: the retry ran', none.calls.reruns, 1)
        const off = await attempt({ first: drive('checks/009', fresh(['a'])), retry: null, again: null, limit: 0, earlier })
        t.eq('retryFailed: 0 had no retry to skip, and records none', [off.calls.reruns, off.out.retrySkipped, off.calls.events], [0, undefined, []])
    }

    t.section('what a later revision may count as reproduced')
    {
        const twice = (await attempt({ first: drive('checks/002', fresh(['x', 'y'])), retry: drive('checks/003', null), again: { selftest: fresh(['x']) } })).out
        t.eq('the tests named by both drives', reproducedSelftests(twice), [{ command: 'collect', test: 'x' }])
        const notMade = (await attempt({ first: drive('checks/002', fresh(['x'])), retry: drive('checks/003', null), again: { selftest: { verdict: 'not-made' } } })).out
        t.eq('a retry comparison not made sets selftestReproduced but names nothing twice', [notMade.selftestReproduced, reproducedSelftests(notMade)], [true, []])
        const again = await attempt({ first: drive('checks/009', fresh(['x'])), retry: drive('checks/010', null), again: { selftest: fresh(['x']) }, earlier: [{ revision: 'r0', retryEvidence: { reproduced: reproducedSelftests(notMade) } }] })
        t.eq('so that later revision still gets its drive', again.calls.reruns, 1)
        t.eq('a cleared failure counts for nothing', reproducedSelftests((await attempt({ first: drive('checks/002', fresh(['x'])), retry: drive('checks/003', null), again: { selftest: { verdict: 'none', newFailures: [] } } })).out), [])
    }

    t.section('which history entries speak for this drive')
    {
        const entry = (revision, targetKey) => ({ revision, retryEvidence: { targetKey } })
        const history = [entry('r1', 'full'), entry('r2', 'full'), entry('r3', 'smoke'), { revision: 'r4' }]
        t.eq('another revision of the same target only: not this revision, another tier or an older record', earlierDrives(history, { revision: 'r2', targetKey: 'full' }).map((h) => h.revision), ['r1'])
        t.eq('a first drive reads an absent history', earlierDrives(undefined, { revision: 'r1', targetKey: 'full' }), [])
    }

    t.section('AC2: a failed command is answered only by the same way on an earlier revision, with a passing base')
    {
        const earlier = [{ revision: 'r0', tier: 'smoke', retryEvidence: { failures: [{ command: 'drive', way: 'timeout-no-output' }, { command: 'boot', way: 'crash:a' }] } }]
        const passes = { dir: 'checks/base', result: 'passed', commands: [{ id: 'drive', passed: true }, { id: 'boot', passed: true }] }
        const same = (failures, base = passes) => sameFailureEarlier({ failures, earlier, base })
        t.eq('the same timeout', same([{ command: 'drive', way: 'timeout-no-output' }]), [{ command: 'drive', way: 'timeout-no-output', revision: 'r0', tier: 'smoke' }])
        t.eq('the same crash signature', same([{ command: 'boot', way: 'crash:a', marker: 'm' }])?.[0]?.marker, 'm')
        t.eq('another crash signature', same([{ command: 'boot', way: 'crash:b' }]), null)
        t.eq('the same way on another command', same([{ command: 'boot', way: 'timeout-no-output' }]), null)
        t.eq('a failure with no identity', same([{ command: 'drive', way: null }]), null)
        t.eq('one first occurrence beside a repeat', same([{ command: 'drive', way: 'timeout-no-output' }, { command: 'lint', way: 'crash:a' }]), null)
        t.eq('no failed command to compare', same([]), null)
        const timeout = [{ command: 'drive', way: 'timeout-no-output' }]
        t.eq('a base not driven yet shows nothing', same(timeout, null), null)
        t.eq('a base that could not be checked', same(timeout, { result: 'unavailable' }), null)
        t.eq('a base that hung too', same(timeout, { result: 'failed', commands: [{ id: 'drive', passed: false, timedOut: true }] }), null)
        t.eq('a base that did not run the command', same(timeout, { result: 'failed', commands: [] }), null)
    }
}
