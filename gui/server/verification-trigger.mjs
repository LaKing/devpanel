/*
 * The full verification's delivery trigger (docs/tactical-playbooks.md "Full verification
 * cycles"): a cycle starts by itself once `afterDeliveries` deliveries to the source
 * have happened on one stage since the last cycle that covered them (host settings
 * `fullVerification.afterDeliveries`, default 10, 0 = off).
 *
 * A delivery stops counting only when a cycle entry of its project established coverage
 * (`coverageEstablished`: the whole suite ran, full-verification-drive.mjs suiteRanOf) on a
 * snapshot taken after it: the entry lists it in `coverage.covered` (the snapshot held its
 * bytes) or in `coverage.indeterminate` (delivered before the snapshot, its bytes not found as
 * delivered). One delivered after the snapshot (notShipped) and every delivery of an entry that
 * never tested (refused, failed before its suite, incomplete) keep counting.
 *
 * Decision: an indeterminate delivery is accounted for too. Its paths were changed since, by a
 * person or a later hand landing, and the checkout as it stood was tested whole; no later cycle
 * can read it differently, so counting it on kept a stage due for ever (seen live on the first
 * instance cycle: 97 such deliveries on one stage). The coverage record keeps saying which is which.
 *
 * That alone would start the next cycle as soon as one ended without testing. A stage whose
 * latest automatic cycle established nothing for it is therefore held back: its next automatic
 * cycle also needs `afterDeliveries` deliveries made after that cycle began (`suppressed`).
 * A later cycle of any trigger that establishes coverage for the stage clears it. A hand start
 * is never held.
 *
 * A green cycle whose commit was withheld (a checkout moved after its snapshot, full-verification.mjs
 * `commitWithheld` on the entry) retires only the deliveries its snapshot held the bytes of
 * (`coverage.covered`, staging-coverage.mjs: its own bytes or those of a later delivery built on
 * them), as the entry's `coverage.retires` says; its indeterminate deliveries keep counting. Such a
 * cycle holds the stage back like one that established nothing, and clears nothing, so somebody
 * editing the checkout through every cycle does not start one after another.
 *
 * A framework entry derived from its pool instances (full-verification.mjs) names a delivery touching a framework
 * path no instance's snapshot held as indeterminate with reason `not-materialized`: nothing tested those bytes, so
 * it keeps counting whatever the entry established.
 */
const NOT_MATERIALIZED = 'not-materialized'

const time = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null }

/** Whether one cycle entry proved the deliveries its coverage names. */
export const establishes = (entry) => entry?.coverageEstablished === true

/**
 * Per stage: the deliveries still counting, whether a cycle is due and why it is held back.
 * `stages` is [{ host, stage, projects: [project] }] (only stages a cycle can verify);
 * `deliveriesOf(project)` lists a project's deliveries (staging-coverage.mjs deliveriesOf);
 * `records` are the cycle records newest first (full-verification-drive.mjs cycleRecords).
 */
export async function deliveryCounts ({ stages, deliveriesOf, records, threshold }) {
  const accounted = new Map()
  for (const record of records) {
    for (const entry of record.projects ?? []) {
      if (!establishes(entry)) continue
      const set = accounted.get(entry.project) ?? new Set()
      for (const c of [...(entry.coverage?.covered ?? []), ...(entry.commitWithheld ? [] : (entry.coverage?.indeterminate ?? []).filter((c) => c.reason !== NOT_MATERIALIZED))]) set.add(c.runId)
      accounted.set(entry.project, set)
    }
  }
  const out = []
  for (const { host, stage, projects } of stages) {
    const runs = []
    for (const project of projects) {
      for (const d of await deliveriesOf(project)) if (!accounted.get(project)?.has(d.runId)) runs.push({ project, ...d })
    }
    const ofStage = (record) => (record.projects ?? []).filter((e) => projects.includes(e.project) && (e.host ?? null) === host)
    // Newest first: the latest cycle that established coverage here, and the latest automatic one that did not.
    const withheld = (record) => ofStage(record).some((e) => e.commitWithheld)
    const cleared = records.find((r) => ofStage(r).some(establishes) && !withheld(r))
    const failed = records.find((r) => r.trigger === 'deliveries' && r.deliveries?.host === host && (!ofStage(r).some(establishes) || withheld(r)))
    let suppressed = null
    if (failed && (!cleared || (time(failed.startedAt ?? failed.frozenAt) ?? 0) > (time(cleared.startedAt ?? cleared.frozenAt) ?? 0))) {
      const since = time(failed.startedAt ?? failed.frozenAt) ?? 0
      const fresh = runs.filter((r) => (time(r.at) ?? 0) > since).length
      if (fresh < threshold) suppressed = { sinceCycle: failed.id, needs: threshold - fresh, reason: withheld(failed) ? 'the stage\'s latest automatic cycle withheld its commit (a checkout moved after its snapshot); the next needs as many deliveries again' : 'the stage\'s latest automatic cycle established no coverage; the next needs as many deliveries again' }
    }
    out.push({ host, stage, projects, count: runs.length, runs, threshold, suppressed, due: threshold > 0 && runs.length >= threshold && !suppressed })
  }
  return out
}
