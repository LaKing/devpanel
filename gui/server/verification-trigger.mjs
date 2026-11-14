/*
 * The full verification's delivery trigger (docs/tactical-playbooks.md "The daily full
 * verification"): a cycle starts by itself once `afterDeliveries` deliveries to the source
 * have happened on one stage since the last cycle that covered them (host settings
 * `fullVerification.afterDeliveries`, default 10, 0 = off).
 *
 * A delivery stops counting only when a cycle entry of its project established coverage
 * (`coverageEstablished`: the whole suite ran, full-verification-drive.mjs suiteRanOf) and
 * lists it in `coverage.covered`. One the snapshot could not establish (indeterminate), one
 * delivered after the snapshot (notShipped) and every delivery of an entry that never tested
 * (refused, failed before its suite, incomplete) keep counting.
 *
 * That alone would start the next cycle as soon as one ended without testing. A stage whose
 * latest automatic cycle established nothing for it is therefore held back: its next automatic
 * cycle also needs `afterDeliveries` deliveries made after that cycle began (`suppressed`).
 * A later cycle of any trigger that establishes coverage for the stage clears it. A hand start
 * is never held.
 */

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
  const covered = new Map()
  for (const record of records) {
    for (const entry of record.projects ?? []) {
      if (!establishes(entry)) continue
      const set = covered.get(entry.project) ?? new Set()
      for (const c of entry.coverage?.covered ?? []) set.add(c.runId)
      covered.set(entry.project, set)
    }
  }
  const out = []
  for (const { host, stage, projects } of stages) {
    const runs = []
    for (const project of projects) {
      for (const d of await deliveriesOf(project)) if (!covered.get(project)?.has(d.runId)) runs.push({ project, ...d })
    }
    const ofStage = (record) => (record.projects ?? []).filter((e) => projects.includes(e.project) && (e.host ?? null) === host)
    // Newest first: the latest cycle that established coverage here, and the latest automatic one that did not.
    const cleared = records.find((r) => ofStage(r).some(establishes))
    const failed = records.find((r) => r.trigger === 'deliveries' && r.deliveries?.host === host && !ofStage(r).some(establishes))
    let suppressed = null
    if (failed && (!cleared || (time(failed.startedAt ?? failed.frozenAt) ?? 0) > (time(cleared.startedAt ?? cleared.frozenAt) ?? 0))) {
      const since = time(failed.startedAt ?? failed.frozenAt) ?? 0
      const fresh = runs.filter((r) => (time(r.at) ?? 0) > since).length
      if (fresh < threshold) suppressed = { sinceCycle: failed.id, needs: threshold - fresh, reason: 'the stage\'s latest automatic cycle established no coverage; the next needs as many deliveries again' }
    }
    out.push({ host, stage, projects, count: runs.length, runs, threshold, suppressed, due: threshold > 0 && runs.length >= threshold && !suppressed })
  }
  return out
}
