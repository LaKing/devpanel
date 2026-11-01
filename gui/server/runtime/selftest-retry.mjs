/*
 * A drive that passed but whose selftest report names failures the base does
 * not have (verdict `new-failures`) fails the gate as surely as a failed
 * command, yet retryFailedCheck only reran failed RESULTS. Such a "new"
 * failure is often one test that is unstable on the staging instance, and the
 * author was sent another round for it, answered with the same revision, and
 * the run stopped `checks-failed-unchanged`. Here the drive runs once more on
 * the same revision (the same `target.retryFailed` allowance, never on top of
 * an earlier retry) and only a test that fails in BOTH drives counts as new:
 * identical bytes failing a test once is instability, not a regression. When
 * no test fails twice, the retry replaces the first drive, marked `flaky`,
 * with its comparison cleared of the one-drive failures (kept as
 * `flakyFailures`); a different unstable test in the retry is no reason to
 * fail it (a reconcile on 2026-11-01 was refused that way). When some do, the
 * first drive stands, recorded as reproduced, naming only those. A retry that
 * did not pass proves nothing about the selftests and only joins the attempts.
 * Called by engine.mjs after the base comparison, with the engine's own drive
 * and comparison injected.
 */
const key = (f) => `${f.command} ${f.test}`

export async function retryNewSelftestFailures ({ result, limit, aborted, rerun, compare, record, persist }) {
    const selftest = result.baselineComparison?.selftest
    if (selftest?.verdict !== 'new-failures' || result.result !== 'passed' || result.attempts?.length || !(limit > 0) || aborted()) return result
    await persist({ type: 'checks-retry', revision: result.revision, attempt: 2, failedDir: result.dir, reason: 'new-selftest-failures' })
    const retry = await rerun()
    if (retry.result !== 'passed') return { ...result, attempts: [record(retry)] }
    const again = await compare(retry)
    if (again.selftest?.verdict === 'not-made') return { ...result, attempts: [{ ...record(retry), newFailures: [] }], selftestReproduced: true }
    const later = again.selftest?.newFailures ?? []
    const twice = new Set(later.map(key))
    const reproduced = selftest.newFailures.filter((f) => twice.has(key(f)))
    const once = [...selftest.newFailures, ...later].filter((f) => !reproduced.some((r) => key(r) === key(f)))
    if (reproduced.length) {
        return { ...result, baselineComparison: { ...result.baselineComparison, selftest: { ...selftest, newFailures: reproduced, ...(once.length ? { flakyFailures: once } : {}) } },
            attempts: [{ ...record(retry), newFailures: later }], selftestReproduced: true }
    }
    const cleared = again.selftest ? { ...again.selftest, newFailures: [], verdict: again.selftest.baselineKnown?.length ? 'baseline-known' : 'none', ...(once.length ? { flakyFailures: once } : {}) } : again.selftest
    return { ...retry, baselineComparison: { ...again, selftest: cleared }, attempts: [{ ...record(result), newFailures: selftest.newFailures }], flaky: true }
}
