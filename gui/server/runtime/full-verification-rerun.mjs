import { isSuiteLevel, selftestStates } from './baseline-failures.mjs'
import { exitedOnItsOwn, takesAllFilters } from './modules-tier.mjs'
import { shellQuote } from './ssh.mjs'

/*
 * The rerun of failed tests alone in a full verification on a stage instance
 * (execution-contract.md "Full verification freeze", docs/project-infrastructure.md
 * "The full verification on a stage instance"). One test failing once in a suite of
 * thousands no longer decides a cycle: when the whole suite failed on named tests and
 * nothing else, each failed test runs again alone on the same instance before the cycle
 * destroys it (full-verification.mjs runInstanceStage). A test that passes alone is
 * flaky: recorded, told and reported, never silent, and it does not make the entry red.
 * A test that fails again, or whose rerun proves nothing, leaves the entry red as before.
 *
 * Only named tests are rerun, never a whole module: the rerun needs a command that selects
 * them (`fullSuite.rerun.test`, or `rerun.namedTests` saying the tier's own `test` command
 * takes test names where it takes filters). Without one the entry says so and stays red.
 * This file decides and judges; it runs nothing.
 */

export const DEFAULT_MAX_TESTS = 10
export const RERUN_DIR = 'full-verification-rerun'

const skip = (reason, message) => ({ skip: { reason, message } })

/** How a project reruns: `{ maxTests, template, placeholder }`, or `{ maxTests?, skip }` saying why it does not. */
export function rerunSettings (infra) {
  const modules = infra?.testDrive?.modules
  const declared = modules?.instance?.fullSuite?.rerun
  if (declared === false) return skip('opted-out', 'the project opted out of the rerun (modules.instance.fullSuite.rerun: false)')
  const maxTests = declared?.maxTests ?? DEFAULT_MAX_TESTS
  if (declared?.test) return { maxTests, template: declared.test, placeholder: declared.test.run.includes('{{tests}}') ? 'tests' : 'test' }
  if (declared?.namedTests && modules?.test) return { maxTests, template: modules.test, placeholder: takesAllFilters(modules.test) ? 'filters' : 'filter' }
  return { maxTests, ...skip('cannot-select-named-tests', 'no command of the project selects named tests: declare modules.instance.fullSuite.rerun.test, or rerun.namedTests: true when the tier\'s test command takes test names as filters; a whole module is never rerun') }
}

const how = (c) => c.timedOut ? 'timed out' : c.signal ? `ended on ${c.signal}` : `exit ${c.exitCode ?? 'none'}`

/**
 * Whether a red entry's failed tests are rerun, and which: `{ reported, tests }` or
 * `{ skip: { reason, message }, reported? }`. Never for a failure that is not a failed
 * test (the instance not up, the suite not answering on its own, another command failed
 * or skipped, a report unreadable, a suite or thread that did not run whole). The bound
 * counts every distinct failed test the suite's reports name, inherited ones included;
 * inherited failures are not rerun, except a test the previous green entry passed only
 * alone (`previousFlaky`). `reports` are readReports of the suite drive; `baseFailed` the
 * failed tests of the previous green drive's reports, or null.
 */
export function rerunPlan ({ settings, incomplete = false, check, suiteRan, suiteId, reports = [], baseFailed = null, previousFlaky = [] }) {
  if (settings.skip) return { skip: settings.skip }
  if (incomplete) return skip('incomplete', 'the entry is incomplete (a declared check did not run), so no rerun can make it green')
  const result = check?.result
  if (result?.stageInstance?.state !== 'live') return skip('not-a-test-failure', `the instance did not stay up after the suite (${result?.stageInstance?.state ?? 'no instance'}): a failed create, start or ready is not a failed test`)
  if (!suiteRan) return skip('not-a-test-failure', 'the whole suite did not answer on its own with a readable selftest report (it did not run, timed out, was killed, or its report did not parse)')
  const skipped = (result.skipped ?? []).find((s) => s.required !== false)
  if (skipped) return skip('not-a-test-failure', `${skipped.id} did not run (${skipped.reason ?? 'skipped'})`)
  const other = (result.commands ?? []).find((c) => c.required !== false && !c.passed && (c.id !== suiteId || !exitedOnItsOwn(c)))
  if (other) return skip('not-a-test-failure', `${other.id} failed (${how(other)}), which no test rerun answers`)
  const unread = [...reports.filter((r) => !r.report).map((r) => `${r.command}: ${r.error}`), ...(check.selftest?.unread ?? []).map((u) => `${u.command}: ${u.reason}`)]
  if (unread.length || !reports.length) return skip('not-a-test-failure', `the selftest report could not be read (${unread.join('; ') || 'none was collected'})`)
  const reported = new Map()
  for (const r of reports) {
    const { state, modules } = selftestStates(r.report)
    for (const [test, s] of state) if (s === 'FAIL' && !reported.has(test)) reported.set(test, { command: r.command, test, ...(modules.has(test) ? { module: modules.get(test) } : {}) })
  }
  const suiteLevel = [...reported.keys()].filter(isSuiteLevel)
  if (suiteLevel.length) return { reported: reported.size, ...skip('not-a-test-failure', `a suite or thread did not run whole (${suiteLevel.join(', ')}): not a test that can run alone`) }
  if (reported.size > settings.maxTests) return { reported: reported.size, ...skip('over-bound', `the suite reported ${reported.size} failed tests, more than the bound of ${settings.maxTests} (inherited ones included): nothing was rerun`) }
  const flaky = new Set(previousFlaky.map((f) => f.test))
  const tests = [...reported.values()].filter((f) => !baseFailed?.includes(f.test) || flaky.has(f.test))
  if (!tests.length) return { reported: reported.size, ...skip('no-named-tests', reported.size ? 'every failed test the report names fails in the previous green cycle too (inherited): nothing to rerun' : 'the report names no failed test, so nothing narrower than the suite can be rerun') }
  return { reported: reported.size, tests }
}

/** The module a failed test belongs to for grouping: the tester's own word, else the first segment of its name, else null. */
const moduleOf = (t) => t.module ?? (t.test.includes('/') ? t.test.split('/')[0] : null)

/**
 * The rerun commands: one per test (`{{test}}`, `{{filter}}`), or one per module holding only that
 * module's failed tests (`{{tests}}`, `{{filters}}`; a test whose module is unknown runs alone). Each
 * name is shell-quoted into the template's own word. Ids `<template id>-rerun-<n>`.
 */
export function rerunCommands (tests, { template, placeholder }) {
  const groups = []
  const byModule = new Map()
  for (const t of tests) {
    const module = ['tests', 'filters'].includes(placeholder) ? moduleOf(t) : null
    if (module === null) { groups.push([t]); continue }
    if (!byModule.has(module)) { byModule.set(module, []); groups.push(byModule.get(module)) }
    byModule.get(module).push(t)
  }
  return groups.map((group, i) => {
    const { timeoutSecondsPerFilter: each, ...one } = template
    const bound = each ? { timeoutSeconds: (one.timeoutSeconds ?? 900) + each * group.length } : {}
    return { tests: group, command: { ...one, ...bound, id: `${template.id}-rerun-${i + 1}`, run: template.run.replace(`{{${placeholder}}}`, () => group.map((t) => shellQuote(t.test)).join(' ')), ownFailureContinues: true } }
  })
}

/**
 * Each test of one rerun drive as `passed`, `failed` or `not-observed` (with `why`). A pass counts
 * only when the drive was not unavailable, the instance stayed up, the rerun command ran and passed,
 * or ended by its own exit (modules-tier.mjs exitedOnItsOwn) while its report fails another test of
 * the group, every required collector passed, and the reports parse and name the test PASS. Anything
 * else proves nothing and is not a pass: a rerun that printed passes and then timed out is not-observed.
 */
export function judgeRerun ({ drive, command, tests, reports = [], target }) {
  const notObserved = (why) => tests.map((t) => ({ ...t, rerun: 'not-observed', why }))
  if (!drive || drive.result === 'unavailable') return notObserved(`the rerun drive was unavailable${drive?.error ? `: ${drive.error}` : ''}`)
  if (drive.stageInstance && drive.stageInstance.state !== 'live') return notObserved(`the instance did not stay up (${drive.stageInstance.state})`)
  const record = (drive.commands ?? []).find((c) => c.id === command.id)
  if (!record || (drive.skipped ?? []).some((s) => s.id === command.id)) return notObserved('the rerun command did not run')
  if (!record.passed && !exitedOnItsOwn(record)) return notObserved(`the rerun command did not end on its own (${how(record)})`)
  const collector = (target?.finallyCommands ?? []).filter((c) => c.required !== false).find((c) => (drive.commands ?? []).find((r) => r.id === c.id)?.passed !== true)
  if (collector) return notObserved(`the collector ${collector.id} did not pass`)
  if (!reports.length || reports.some((r) => !r.report)) return notObserved(`the rerun's selftest report could not be read${reports.find((r) => !r.report) ? ` (${reports.find((r) => !r.report).error})` : ''}`)
  const states = new Map()
  for (const r of reports) for (const [test, s] of selftestStates(r.report).state) if (states.get(test) !== 'FAIL') states.set(test, s)
  const failedHere = tests.some((t) => states.get(t.test) === 'FAIL')
  return tests.map((t) => {
    const s = states.get(t.test)
    if (s === 'FAIL') return { ...t, rerun: 'failed' }
    if (s !== 'PASS') return { ...t, rerun: 'not-observed', why: `the rerun's report does not name it as run${s === 'SKIP' ? ' (skipped)' : ''}` }
    if (record.passed || failedHere) return { ...t, rerun: 'passed' }
    return { ...t, rerun: 'not-observed', why: `the rerun command exited ${record.exitCode} while its report fails no test of its group` }
  })
}

/**
 * The selftest-history lines (selftest-history.mjs) of an entry's flaky tests: the suite drive as a
 * failure and the rerun as a pass, on one tree (`treeIdentity`) and target, under the report command
 * that named them, so the unstable classification pairs them (same-bytes). No issue: a cycle's lines
 * never count as another issue's unrelated revision.
 */
export function flakyHistoryLines ({ project, driveId, flaky, suiteCheck, rerunAt, baseCommit, at }) {
  const treeIdentity = suiteCheck?.treeIdentity ?? `commit:${baseCommit}`
  const targetKey = `full-verification:${project}`
  const commands = [...new Set(flaky.map((f) => f.command))]
  const base = { runId: driveId, issueId: null, treeIdentity, targetKey, revision: null, baseCommit, tier: 'full', changedPaths: null }
  const suiteAt = suiteCheck?.at ?? at
  // The rerun came after the suite: its line sorts after it even when a clock read both alike.
  const after = Date.parse(rerunAt ?? at) > Date.parse(suiteAt) ? (rerunAt ?? at) : new Date(Date.parse(suiteAt) + 1).toISOString()
  return [
    { ...base, id: `${driveId}:full-verification:${suiteAt}`, at: suiteAt, kind: 'full-verification', dir: suiteCheck?.dir ?? null,
      commands: commands.map((command) => ({ command, failed: flaky.filter((f) => f.command === command).map((f) => f.test), passed: [], asNew: [] })) },
    { ...base, id: `${driveId}:full-verification-rerun:${after}`, at: after, kind: 'full-verification-rerun', dir: null,
      commands: commands.map((command) => ({ command, failed: [], passed: flaky.filter((f) => f.command === command).map((f) => f.test), asNew: [] })) }
  ]
}
