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
 *
 * A retry answers whether identical bytes fail again, and an earlier revision of
 * the run may already have answered it: such a retry cost ~19 minutes and only
 * repeated the answer. `run.checkHistory[].retryEvidence` keeps what the decision
 * needs after a new revision drops the older check results, and the rules below
 * read it. Only drives of the same target count (`targetKey`: a tier is another
 * target, its own commands against its own base), on another revision (a refresh
 * of the same bytes is no earlier revision). Skipping leaves `retrySkipped` on the
 * result and a `checks-retry-skipped` event.
 */
const key = (f) => `${f.command} ${f.test}`

/** The history entries a revision's retry decision may read. */
export const earlierDrives = (history, { revision, targetKey }) =>
    (history ?? []).filter((h) => h.revision !== revision && h.retryEvidence?.targetKey === targetKey)

/**
 * The tests a second drive of the same revision named again. A comparison the
 * retry could not make also sets `selftestReproduced`, with no test named twice:
 * nothing reproduced, so nothing for a later revision to skip on.
 */
export function reproducedSelftests (result) {
    if (!result.selftestReproduced) return []
    const named = new Set((result.attempts?.[0]?.newFailures ?? []).map(key))
    return (result.baselineComparison?.selftest?.newFailures ?? []).filter((f) => named.has(key(f))).map(({ command, test }) => ({ command, test }))
}

/**
 * Whether a failed drive's retry is already answered: every failed required
 * command failed the same way (failureIdentities) on an earlier revision, and the
 * base known now passed it. The commands, or null to retry. A base not yet driven
 * shows nothing, nor does one that hung or crashed too: then it may be the
 * environment, and a silent hang has passed on retry beside a hanging base.
 */
export function sameFailureEarlier ({ failures, earlier, base }) {
    if (!failures.length || !base || base.result === 'unavailable') return null
    const commands = []
    for (const f of failures) {
        const seen = f.way && earlier.find((h) => h.retryEvidence.failures?.some((e) => e.command === f.command && e.way === f.way))
        if (!seen || base.commands?.find((c) => c.id === f.command)?.passed !== true) return null
        commands.push({ ...f, revision: seen.revision, ...(seen.tier ? { tier: seen.tier } : {}) })
    }
    return commands
}

/** The failures the gate ignored across both drives, each test once. */
function bothIgnored (first, second) {
    const list = [...(first?.unstable ?? []), ...(second?.unstable ?? [])].filter((f, i, all) => all.findIndex((x) => key(x) === key(f)) === i)
    return list.length ? { unstable: list } : {}
}

export async function retryNewSelftestFailures ({ result, limit, aborted, rerun, compare, record, persist, earlier = [] }) {
    const selftest = result.baselineComparison?.selftest
    if (selftest?.verdict !== 'new-failures' || result.result !== 'passed' || result.attempts?.length || !(limit > 0) || aborted()) return result
    // Every new failure already failed twice on an earlier revision: a second drive here says nothing more.
    const before = new Map(earlier.flatMap((h) => (h.retryEvidence.reproduced ?? []).map((f) => [key(f), h.revision])))
    if (selftest.newFailures?.length && selftest.newFailures.every((f) => before.has(key(f)))) {
        const retrySkipped = { reason: 'selftest-reproduced-earlier', failures: selftest.newFailures.map((f) => ({ ...f, revision: before.get(key(f)) })) }
        await persist({ type: 'checks-retry-skipped', revision: result.revision, ...retrySkipped })
        return { ...result, retrySkipped }
    }
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
        return { ...result, baselineComparison: { ...result.baselineComparison, selftest: { ...selftest, newFailures: reproduced, ...(once.length ? { flakyFailures: once } : {}), ...bothIgnored(selftest, again.selftest) } },
            attempts: [{ ...record(retry), newFailures: later }], selftestReproduced: true }
    }
    const ignored = bothIgnored(selftest, again.selftest)
    const cleared = again.selftest ? { ...again.selftest, newFailures: [], verdict: ignored.unstable ? 'unstable' : again.selftest.baselineKnown?.length ? 'baseline-known' : 'none', ...(once.length ? { flakyFailures: once } : {}), ...ignored } : again.selftest
    return { ...retry, baselineComparison: { ...again, selftest: cleared }, attempts: [{ ...record(result), newFailures: selftest.newFailures }], flaky: true }
}
