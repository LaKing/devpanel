import { isSelftestReport, isSuiteLevel, readReport, selftestStates } from './baseline-failures.mjs'

/*
 * Which tests a repair revision's targeted tier runs (`tiers.targeted`,
 * execution-contract.md "Reviews"). The names come from two structured records,
 * never from a finding's text: the failures an earlier revision's latest
 * drive gated on (a failed check is a finding the round cannot pass over, and
 * when every reviewer approved it is the only one), and `failingTests` on the
 * open blocking findings. Either all of them are usable or none run: a partial
 * set would not prove the repair, so the revision runs its smoke and says why.
 */

const DEFAULT_MAX_TESTS = 20
const MAX_NAME_LENGTH = 200

/** Safe to shell-quote and meaningful to run: a test, not a suite-level entry, and never read as an option. */
export const usableTestName = (name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH &&
  !name.startsWith('-') && !/[\u0000-\u001f\u007f-\u009f]/.test(name) && !isSuiteLevel(name)

/** The failures a drive gated on, by name: new ones and those no comparison could judge. */
export const namedFailuresOf = (check) => {
  const selftest = check?.baselineComparison?.selftest
  return [...(selftest?.newFailures ?? []), ...(selftest?.unjudged ?? [])].map(({ command, test }) => ({ command, test }))
}

/**
 * The decision for `revision` of a target declaring the tier, from what the run
 * recorded before it: `{ tests, sources }` or `{ declined: { reason, names? } }`.
 * Null when there is no decision to make: not declared, or the run's first revision.
 */
export function selectTargeted ({ target, run, revision }) {
  const declared = target?.tiers?.targeted
  if (!declared) return null
  const revisions = run.revisions ?? []
  const at = revisions.findLastIndex((r) => r.fingerprint === revision)
  if (at < 1) return null
  const sources = []
  // The latest drive of an earlier revision: a later pass of the same bytes (a full drive after
  // a failed smoke) supersedes what failed, and a revision that only asked for a diagnostic drive has none.
  const drive = (run.checkHistory ?? []).filter((h) => h.revision !== revision && h.result !== 'not-run').at(-1)
  if (drive?.gating === 'failed' && !drive.inconclusive && drive.namedFailures?.length) {
    sources.push({ from: 'drive', revision: drive.revision, ...(drive.tier ? { tier: drive.tier } : {}), dir: drive.dir ?? null, tests: drive.namedFailures.map((f) => f.test) })
  }
  for (const f of run.outstandingFindings ?? []) {
    if (f.blocking === true && f.failingTests?.length) sources.push({ from: 'finding', id: f.id, tests: f.failingTests })
  }
  const names = [...new Set(sources.flatMap((s) => s.tests))].sort()
  if (!names.length) return { declined: { reason: 'no-named-tests' } }
  const unusable = names.filter((name) => !usableTestName(name))
  if (unusable.length) return { declined: { reason: 'unusable-name', names: unusable.slice(0, 10).map((name) => String(name).slice(0, MAX_NAME_LENGTH)) } }
  if (names.length > (declared.maxTests ?? DEFAULT_MAX_TESTS)) return { declined: { reason: 'too-many', names: names.slice(0, 10) } }
  return { tests: names, sources }
}

/**
 * The named tests the drive's selftest reports do not show as run (passed or
 * failed): a filter that matched nothing must not read as a pass.
 */
export async function missingNamedTests ({ runDir, target, check, tests }) {
  const ran = new Set()
  for (const { id, report } of [...(target.commands ?? []), ...(target.finallyCommands ?? [])]) {
    if (!isSelftestReport(report)) continue
    const read = await readReport(runDir, check, id)
    if (!read.report) continue
    for (const [test, state] of selftestStates(read.report).state) if (state !== 'SKIP') ran.add(test)
  }
  return tests.filter((test) => !ran.has(test))
}
