import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { checksOnlyBlock } from '../server/runtime/run-control.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { renderResult } from '../server/run-result-step.mjs'
import { infrastructureErrors } from '../server/infrastructure.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { outputParts, compareFailures, failureFingerprints, gateReason, gatingResult, inconclusiveBase, selftestReport, failedSelftests, compareSelftestReports, isSelftestReport, unfinishedSuites } from '../server/runtime/baseline-failures.mjs'

export const name = 'inherited check failures — baseline-known failures do not block, new ones do'

/*
 * Real node:test (v22) TAP output, the test file's directory replaced by /work.
 *   TAP_BASE         three failing tests (alpha: deepEqual on {duration_ms}; beta:
 *                    a multi-line actual holding `1..3`, `  ...`, `# pass 4`;
 *                    parent with a failing nested child2), program output
 *                    `# \# tests 99` and `# ok 7 - fake`
 *   TAP_RERUN_ADDED  the same file run again with one more, passing, test
 *   NESTED_12/34     an error carrying expected/actual {duration_ms} without a
 *                    generated diff: only actual.duration_ms (12, 34) differs
 *                    besides the reporter's own timing
 *   CONSOLE_12/34    program output `tests 12` / `tests 34`, `1..9` and
 *                    `Subtest: gamma`, which node:test prints as `# …` comments
 */
const TAP_BASE = "TAP version 13\n# \\# tests 99\n# ok 7 - fake\n# Subtest: alpha\nnot ok 1 - alpha\n  ---\n  duration_ms: 12.895183\n  type: 'test'\n  location: '/work/sample.test.mjs:4:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly deep-equal:\n    + actual - expected\n    \n      {\n    +   duration_ms: 12\n    -   duration_ms: 0\n      }\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected:\n    duration_ms: 0\n  actual:\n    duration_ms: 12\n  operator: 'deepStrictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///work/sample.test.mjs:4:30)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.start (node:internal/test_runner/test:944:17)\n    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)\n  ...\n# Subtest: beta\nnot ok 2 - beta\n  ---\n  duration_ms: 2.698365\n  type: 'test'\n  location: '/work/sample.test.mjs:5:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    + actual - expected\n    \n    + 'line1\\n1..3\\n  ...\\n# pass 4'\n    - 'x'\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 'x'\n  actual: |-\n    line1\n    1..3\n      ...\n    # pass 4\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///work/sample.test.mjs:5:84)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.processPendingSubtests (node:internal/test_runner/test:744:18)\n    Test.postRun (node:internal/test_runner/test:1173:19)\n    Test.run (node:internal/test_runner/test:1101:12)\n    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)\n  ...\n# Subtest: parent\n    # Subtest: child\n    ok 1 - child\n      ---\n      duration_ms: 0.518707\n      type: 'test'\n      ...\n    # Subtest: child2\n    not ok 2 - child2\n      ---\n      duration_ms: 0.240304\n      type: 'test'\n      location: '/work/sample.test.mjs:6:72'\n      failureType: 'testCodeFailure'\n      error: 'boom'\n      code: 'ERR_TEST_FAILURE'\n      stack: |-\n        TestContext.<anonymous> (file:///work/sample.test.mjs:6:101)\n        Test.runInAsyncScope (node:async_hooks:214:14)\n        Test.run (node:internal/test_runner/test:1047:25)\n        Test.start (node:internal/test_runner/test:944:17)\n        TestContext.test (node:internal/test_runner/test:373:20)\n        TestContext.<anonymous> (file:///work/sample.test.mjs:6:72)\n        async Test.run (node:internal/test_runner/test:1054:7)\n        async Test.processPendingSubtests (node:internal/test_runner/test:744:7)\n      ...\n    1..2\nnot ok 3 - parent\n  ---\n  duration_ms: 1.594177\n  type: 'test'\n  location: '/work/sample.test.mjs:6:1'\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n1..3\n# tests 5\n# suites 0\n# pass 1\n# fail 4\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 349.70088\n"
const TAP_RERUN_ADDED = "TAP version 13\n# \\# tests 99\n# ok 7 - fake\n# Subtest: alpha\nnot ok 1 - alpha\n  ---\n  duration_ms: 11.285362\n  type: 'test'\n  location: '/work/sample.test.mjs:4:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly deep-equal:\n    + actual - expected\n    \n      {\n    +   duration_ms: 12\n    -   duration_ms: 0\n      }\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected:\n    duration_ms: 0\n  actual:\n    duration_ms: 12\n  operator: 'deepStrictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///work/sample.test.mjs:4:30)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.start (node:internal/test_runner/test:944:17)\n    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)\n  ...\n# Subtest: beta\nnot ok 2 - beta\n  ---\n  duration_ms: 3.373689\n  type: 'test'\n  location: '/work/sample.test.mjs:5:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    + actual - expected\n    \n    + 'line1\\n1..3\\n  ...\\n# pass 4'\n    - 'x'\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 'x'\n  actual: |-\n    line1\n    1..3\n      ...\n    # pass 4\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///work/sample.test.mjs:5:84)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.processPendingSubtests (node:internal/test_runner/test:744:18)\n    Test.postRun (node:internal/test_runner/test:1173:19)\n    Test.run (node:internal/test_runner/test:1101:12)\n    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)\n  ...\n# Subtest: parent\n    # Subtest: child\n    ok 1 - child\n      ---\n      duration_ms: 0.676766\n      type: 'test'\n      ...\n    # Subtest: child2\n    not ok 2 - child2\n      ---\n      duration_ms: 0.446042\n      type: 'test'\n      location: '/work/sample.test.mjs:6:72'\n      failureType: 'testCodeFailure'\n      error: 'boom'\n      code: 'ERR_TEST_FAILURE'\n      stack: |-\n        TestContext.<anonymous> (file:///work/sample.test.mjs:6:101)\n        Test.runInAsyncScope (node:async_hooks:214:14)\n        Test.run (node:internal/test_runner/test:1047:25)\n        Test.start (node:internal/test_runner/test:944:17)\n        TestContext.test (node:internal/test_runner/test:373:20)\n        TestContext.<anonymous> (file:///work/sample.test.mjs:6:72)\n        async Test.run (node:internal/test_runner/test:1054:7)\n        async Test.processPendingSubtests (node:internal/test_runner/test:744:7)\n      ...\n    1..2\nnot ok 3 - parent\n  ---\n  duration_ms: 2.15624\n  type: 'test'\n  location: '/work/sample.test.mjs:6:1'\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n# Subtest: added\nok 4 - added\n  ---\n  duration_ms: 0.217337\n  type: 'test'\n  ...\n1..4\n# tests 6\n# suites 0\n# pass 2\n# fail 4\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 409.152629\n"
const NESTED_12 = "TAP version 13\n# Subtest: alpha\nnot ok 1 - alpha\n  ---\n  duration_ms: 4.304127\n  type: 'test'\n  location: '/work/nested.test.mjs:3:1'\n  failureType: 'testCodeFailure'\n  error: 'timing record differs'\n  code: 'ERR_TEST_FAILURE'\n  expected:\n    duration_ms: 0\n  actual:\n    duration_ms: 12\n  stack: |-\n    TestContext.<anonymous> (file:///work/nested.test.mjs:3:43)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.start (node:internal/test_runner/test:944:17)\n    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 463.886959\n"
const NESTED_34 = "TAP version 13\n# Subtest: alpha\nnot ok 1 - alpha\n  ---\n  duration_ms: 3.786388\n  type: 'test'\n  location: '/work/nested.test.mjs:3:1'\n  failureType: 'testCodeFailure'\n  error: 'timing record differs'\n  code: 'ERR_TEST_FAILURE'\n  expected:\n    duration_ms: 0\n  actual:\n    duration_ms: 34\n  stack: |-\n    TestContext.<anonymous> (file:///work/nested.test.mjs:3:43)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.start (node:internal/test_runner/test:944:17)\n    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 421.902707\n"
const CONSOLE_12 = "TAP version 13\n# tests 12\n# 1..9\n# Subtest: gamma\n# Subtest: gamma\nnot ok 1 - gamma\n  ---\n  duration_ms: 8.86633\n  type: 'test'\n  location: '/work/console.test.mjs:4:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    \n    1 !== 2\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 2\n  actual: 1\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///work/console.test.mjs:4:127)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.start (node:internal/test_runner/test:944:17)\n    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 332.706968\n"
const CONSOLE_34 = "TAP version 13\n# tests 34\n# 1..9\n# Subtest: gamma\n# Subtest: gamma\nnot ok 1 - gamma\n  ---\n  duration_ms: 8.001503\n  type: 'test'\n  location: '/work/console.test.mjs:4:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    \n    1 !== 2\n    \n  code: 'ERR_ASSERTION'\n  name: 'AssertionError'\n  expected: 2\n  actual: 1\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///work/console.test.mjs:4:127)\n    Test.runInAsyncScope (node:async_hooks:214:14)\n    Test.run (node:internal/test_runner/test:1047:25)\n    Test.start (node:internal/test_runner/test:944:17)\n    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)\n  ...\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 332.426499\n"

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

// Compares one failed command, base against candidate, the way closure does.
const SOURCE = 'b'.repeat(40)
const temps = []
async function compare (base, candidate, { baseCheck = {}, candidateCheck = {}, target = null } = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-inherit-'))
  temps.push(runDir)
  const write = async (dir, side) => {
    await fs.mkdir(path.join(runDir, dir), { recursive: true })
    const stdout = side.stdout ?? side.out ?? ''
    const log = `$ run\n\n${stdout}${side.stderr ? `\n--- stderr ---\n${side.stderr}` : ''}\n--- exit ${side.exitCode ?? 1} in 1 ms ---\n`
    await fs.writeFile(path.join(runDir, dir, 'cmd.log'), side.log ?? log)
    await fs.writeFile(path.join(runDir, dir, 'cmd.stdout'), stdout)
    return { id: 'cmd', run: 'run', required: true, log: 'cmd.log', passed: side.passed ?? false, exitCode: side.exitCode ?? 1, signal: side.signal ?? null, timedOut: side.timedOut ?? false }
  }
  const b = { result: 'failed', dir: 'checks/base', sourceRevision: SOURCE, baseCommit: SOURCE, at: '2026-10-06T00:00:00.000Z', commands: [await write('checks/base', base)], ...baseCheck }
  const c = { result: 'failed', dir: 'checks/001', commands: [await write('checks/001', candidate)], ...candidateCheck }
  return compareFailures({ runDir, target: target ?? { commands: [{ id: 'cmd', run: 'run' }] }, base: b, candidate: c, sourceRevision: SOURCE })
}
const tapPoint = (n, name, actual) => `# Subtest: ${name}\nnot ok ${n} - ${name}\n  ---\n  duration_ms: 1.5\n  failureType: 'testCodeFailure'\n  expected: 1\n  actual: ${actual}\n  ...`
const tap = (points) => `TAP version 13\n${points.join('\n')}\n1..${points.length}\n# tests ${points.length}\n# suites 0\n# pass 0\n# fail ${points.length}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 40.5\n`

/*
 * The reviewers approve, the author answers unchanged after a failed check;
 * `commands` is the local check target. Returns the engine after it stopped.
 * With `regression`, the first round also writes break.txt and the second
 * removes it: the author fixing what the check found.
 */
async function scenario (commands, { regression = false, retryFailed = 0 } = {}) {
  const prompts = []
  let engine = null
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    prompts.push({ stepId, role, round, prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      if (round === 0) await fs.writeFile(path.join(engine.run.workspace.path, 'work.txt'), 'work\n')
      if (regression && round === 0) await fs.writeFile(path.join(engine.run.workspace.path, 'break.txt'), 'regression\n')
      if (regression && round === 1) await fs.rm(path.join(engine.run.workspace.path, 'break.txt'))
      if (regression) return fence({ summary: round ? 'Fixed the new selftest failure' : 'Implemented', basedOnRevision: revision(prompt) })
      return fence({ summary: round ? 'The failing check is not caused by this change' : 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  const yaml = commands.map((c) => `      - id: ${c.id}\n        run: ${JSON.stringify(c.run)}\n${c.needs ? `        needs: ${JSON.stringify(c.needs)}\n` : ''}${c.required === false ? '        required: false\n' : ''}${c.report ? `        report: ${c.report}\n` : ''}`).join('')
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
    `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: ${retryFailed}\n    commands:\n${yaml}`)
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  return { engine, prompts, implementTurns: prompts.filter((p) => p.stepId === 'implement').length }
}

// Identical on the base and the candidate: a failure the project already has.
const LEGACY = 'echo "FAIL legacy — expected 1 got 2"; echo "  at legacy.js:3:7"; exit 1'

/*
 * Selftest reports, as collect-selftest-report prints them: a wait line, the
 * `== <path>` line, summary lines grepped from the report, then the report.
 * The report's path and the inherited failure's message carry the process id,
 * so they differ between base and candidate as they do on a real test drive.
 * break.txt (a candidate file) adds a regression whose name shares a prefix
 * with the inherited failure: auditor-1's counterexample.
 */
const COLLECT = 'p=runtime/log/r$$/threads/App.tester/1/selftest.report; t=\'{"test":"socket — old-test","error":"inherited at \'$$\'"},{"test":"core/a"}\'; ' +
  'if test -f break.txt; then t="$t"\',{"test":"socket — new-test","error":"regression"}\'; fi; ' +
  'echo "waited: 1 s after the candidate\'s start"; echo "== $p"; echo \'  "total": 3,\'; printf \'{\\n  "total": 3,\\n  "tests": [%s]\\n}\\n\' "$t"'
const report = (tests, { pretty = true } = {}) => JSON.stringify({ total: tests.length, failed: tests.filter((x) => x.error).length, threads: { 'App.worker': { tests } } }, null, pretty ? 2 : 0)
const collected = (run, json, { trailing = false } = {}) =>
  `waited: 412 s after the candidate's start\n== runtime/log/${run}/threads/App.tester/1/selftest.report\n${json.split('\n').filter((l) => /"(total|failed|skipped)"/.test(l)).slice(0, 3).join('\n')}\n${json}\n` +
  (trailing ? '== runtime/worker-selftest-check.log\nPASS migration/a\n== runtime/document-seeder-regression.log\nok\n' : '')
const OLD = { test: 'socket — old-test', error: 'inherited error at 12:01:05' }
const NEW = { test: 'socket — new-test', error: 'regression' }

/** compareSelftestReports on one `collect` command, base against candidate stdout. */
async function compareReports (baseStdout, candidateStdout, { basePassed = true, candidatePassed = true, base: withBase = true } = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-selftest-'))
  temps.push(runDir)
  const side = async (dir, stdout, passed) => {
    await fs.mkdir(path.join(runDir, dir), { recursive: true })
    await fs.writeFile(path.join(runDir, dir, 'collect.stdout'), stdout)
    return { id: 'collect', passed, exitCode: passed ? 0 : 1 }
  }
  const b = { result: basePassed ? 'passed' : 'failed', dir: 'checks/base', sourceRevision: SOURCE, commands: [await side('checks/base', baseStdout, basePassed)] }
  const c = { result: candidatePassed ? 'passed' : 'failed', dir: 'checks/001', commands: [await side('checks/001', candidateStdout, candidatePassed)] }
  return compareSelftestReports({ runDir, target: { finallyCommands: [{ id: 'collect', run: 'x', report: 'selftest' }] }, base: withBase ? b : null, candidate: c, sourceRevision: SOURCE })
}

export default async function (t) {
  t.section('per-failure blocks: a failure is inherited only with its own complete diagnostics')
  {
    // auditor-1-01 (report 010): actual values swapped between two tests.
    const swapped = await compare({ out: tap([tapPoint(1, 'alpha', 2), tapPoint(2, 'beta', 3)]) }, { out: tap([tapPoint(1, 'alpha', 3), tapPoint(2, 'beta', 2)]) })
    t.eq('swapped assertion values are new failures of both tests', [swapped.verdict, swapped.newFailures.map((x) => x.test)], ['new-failures', ['alpha', 'beta']])
    const footer = '    at run (x.js:1:1)\n    at main (y.js:2:2)\nFAILED: 1 test'
    const assertion = await compare({ out: `FAIL t — x\nAssertionError: expected 1 got 2\n${footer}\n` }, { out: `FAIL t — x\nAssertionError: expected 1 got 3\n${footer}\n` })
    t.eq('a different assertion above an identical footer is new', assertion.newFailures.map((x) => x.test), ['t'])
    const crash = await compare({ out: 'FAIL legacy — broke\n' }, { out: 'FAIL legacy — broke\nTypeError: new scenario crashed\n' })
    t.eq('an extra crash line inside the block is new', crash.verdict, 'new-failures')
    const afterPass = await compare({ out: 'FAIL legacy — broke\nPASS b\n' }, { out: 'FAIL legacy — broke\nPASS b\nTypeError: crash\n' })
    t.eq('a crash after a pass line is not absorbed by it', afterPass.verdict, 'not-made')
    const same = await compare({ out: `FAIL legacy — expected 1 got 2\n  at legacy.js:3:7\n` }, { out: `FAIL legacy — expected 1 got 2\n  at legacy.js:3:7\n` })
    t.eq('identical output is baseline-known', [same.verdict, same.baselineKnown.map((x) => x.test)], ['baseline-known', ['legacy']])
    const mixed = await compare({ out: 'FAIL legacy — broke\n' }, { out: 'FAIL legacy — broke\nFAIL fresh — new\n' })
    t.eq('in one check, the inherited failure is known and the new one blocks', [mixed.verdict, mixed.baselineKnown.map((x) => x.test), mixed.newFailures.map((x) => x.test)], ['new-failures', ['legacy'], ['fresh']])
    const twice = await compare({ out: 'FAIL x — boom\n' }, { out: 'FAIL x — boom\nFAIL x — boom\n' })
    t.eq('a failure printed once more than on the base is new', twice.verdict, 'new-failures')
    const bare = await compare({ out: 'Error: cannot connect\n', stderr: 'exit early\n' }, { out: 'Error: cannot connect\n', stderr: 'exit early\n' })
    t.eq('without failure lines, identical output is baseline-known', bare.verdict, 'baseline-known')
    const bareDiff = await compare({ out: 'Error: cannot connect\n' }, { out: 'Error: cannot bind\n' })
    t.eq('without failure lines, different output is not-made', bareDiff.verdict, 'not-made')
    const stderr = await compare({ out: 'FAIL a — x\n', stderr: 'warn 1\n' }, { out: 'FAIL a — x\n', stderr: 'warn 2\n' })
    t.eq('different stderr beside identical failures is not-made', stderr.verdict, 'not-made')
    const lost = await compare({ out: 'FAIL a\nPASS b\nPASS c\n' }, { out: 'FAIL a\n' })
    t.eq('a candidate that reports fewer passes than the base is not-made', lost.verdict, 'not-made')
  }

  t.section('normalisation: values are compared as written (whitespace, numbers, hex, durations)')
  {
    // auditor-1-02 (reports 007, 010, 013).
    const hex = await compare({ out: 'FAIL register — expected 0x10 got 0x20\n' }, { out: 'FAIL register — expected 0x10 got 0x30\n' })
    t.eq('hex values inside a message are kept', hex.verdict, 'new-failures')
    const ms = await compare({ out: 'FAIL latency — expected (12 ms)\n' }, { out: 'FAIL latency — expected (34 ms)\n' })
    t.eq('a trailing parenthesised duration in a message is kept', ms.verdict, 'new-failures')
    const spaces = await compare({ out: tap([tapPoint(1, 'alpha', "'a  b'")]) }, { out: tap([tapPoint(1, 'alpha', "'a   b'")]) })
    t.eq("TAP actual 'a  b' against 'a   b' is new", spaces.newFailures.map((x) => x.test), ['alpha'])
    t.eq('two against three spaces in a message is new', (await compare({ out: 'FAIL t — got "a  b"\n' }, { out: 'FAIL t — got "a   b"\n' })).verdict, 'new-failures')
    t.eq('a blank line added inside a diagnostic is new', (await compare({ out: 'FAIL t — x\nAssertionError\n' }, { out: 'FAIL t — x\n\nAssertionError\n' })).verdict, 'new-failures')
    t.eq('a trailing space is new', (await compare({ out: 'FAIL t — x\n' }, { out: 'FAIL t — x \n' })).verdict, 'new-failures')
    t.eq('different indentation outside failure blocks is not-made', (await compare({ out: 'Error: a\n  at b\n' }, { out: 'Error: a\n    at b\n' })).verdict, 'not-made')
    t.eq('CRLF against LF only is baseline-known', (await compare({ out: 'FAIL t — x\r\nline\r\n' }, { out: 'FAIL t — x\nline\n' })).verdict, 'baseline-known')
    const engineNames = await compare({ out: 'FAIL legacy — expected 1 got 2\nin /tmp/devpanel-check-aB3xYz\nPASS a\n' }, { out: 'FAIL legacy — expected 1 got 2\nin /tmp/devpanel-check-Q9rTt1\nPASS a\nPASS new-test\n' })
    t.eq('engine-generated check names differ and a pass is added: baseline-known', engineNames.verdict, 'baseline-known')
    const [a, b, c] = ['in /opt/devpanel-check-0123456789ab-ba9876543210 a', 'in /opt/devpanel-check-ffffffffffff-000000000000 a', 'in /opt/devpanel-check-ffffffffffff-000000000000  a']
      .map((line) => outputParts('cmd', `FAIL t — x\n${line}\n`).failures[0].fingerprint)
    t.ok('fingerprints: equal when only engine names differ, different for one space', a === b && b !== c)
  }

  t.section('node:test TAP: only reporter metadata at its own position is removed (real output)')
  {
    // auditor-1-02 (report 016): actual.duration_ms is assertion data, not timing.
    const nested = await compare({ out: NESTED_12 }, { out: NESTED_34 })
    t.eq('nested actual.duration_ms 12 against 34 is a new failure of alpha', [nested.verdict, nested.newFailures.map((x) => x.test)], ['new-failures', ['alpha']])
    const timing = await compare({ out: NESTED_12 }, { out: NESTED_12.replace('  duration_ms: 4.304127', '  duration_ms: 9.75').replace(/# duration_ms [\d.]+/, '# duration_ms 999.5') })
    t.eq('only the reporter timing and trailer differ: baseline-known', timing.verdict, 'baseline-known')
    const rerun = await compare({ out: TAP_BASE }, { out: TAP_RERUN_ADDED })
    t.eq('a real rerun with one passing test added: every failure baseline-known, by its path', [rerun.verdict, rerun.baselineKnown.map((x) => x.test)], ['baseline-known', ['alpha', 'beta', 'parent > child2', 'parent']])
    const program = await compare({ out: CONSOLE_12 }, { out: CONSOLE_34 })
    t.eq('program output `# tests 12` against `# tests 34` is kept: not-made', program.verdict, 'not-made')
    const header = await compare({ out: CONSOLE_12 }, { out: CONSOLE_12.replace('# 1..9\n# Subtest: gamma\n', '# 1..9\n# Subtest: delta\n') })
    t.eq('a program-printed `# Subtest:` line is kept', header.verdict, 'not-made')
    const comment = await compare({ out: TAP_BASE }, { out: TAP_BASE.replace('# ok 7 - fake', '# ok 8 - fake') })
    t.eq('a program comment `# ok 7` is not an ordinal', comment.verdict, 'not-made')
    const scalar = await compare({ out: TAP_BASE }, { out: TAP_BASE.replace('    1..3\n      ...\n    # pass 4', '    1..4\n      ...\n    # pass 4') })
    t.eq('`1..3` inside a YAML block scalar is data', [scalar.verdict, scalar.newFailures.map((x) => x.test)], ['new-failures', ['beta']])
    const closer = await compare({ out: TAP_BASE }, { out: TAP_BASE.replace('    1..3\n      ...\n    # pass 4', '    1..3\n      ....\n    # pass 4') })
    t.eq('a deeper `  ...` inside a block scalar is data, not the closer', closer.newFailures.map((x) => x.test), ['beta'])
  }

  t.section('node:test TAP: a nested test is identified by the path of its enclosing tests')
  {
    // auditor-1-01 (report 022): equally named children of two suites, their
    // diagnostics swapped, the same helper location, the parents unchanged.
    const suite = (name, error) => `# Subtest: ${name}\n    # Subtest: same\n    not ok 1 - same\n      ---\n      duration_ms: 0.5\n      type: 'test'\n      location: '/work/helper.mjs:3:1'\n      failureType: 'testCodeFailure'\n      error: '${error}'\n      code: 'ERR_TEST_FAILURE'\n      ...\n    1..1\nnot ok 1 - ${name}\n  ---\n  duration_ms: 1.2\n  type: 'test'\n  location: '/work/suites.test.mjs:5:1'\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  code: 'ERR_TEST_FAILURE'\n  ...`
    const stream = (a, b) => `TAP version 13\n${suite('suiteA', a)}\n${suite('suiteB', b).replace('not ok 1 - suiteB', 'not ok 2 - suiteB')}\n1..2\n# tests 4\n# suites 0\n# pass 0\n# fail 4\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 30.1\n`
    const swapped = await compare({ out: stream('expected2', 'expected3') }, { out: stream('expected3', 'expected2') })
    t.eq('suiteA/same and suiteB/same with swapped diagnostics are new failures', [swapped.verdict, swapped.newFailures.map((x) => x.test)], ['new-failures', ['suiteA > same', 'suiteB > same']])
    t.eq('the parents are still baseline-known', swapped.baselineKnown.map((x) => x.test), ['suiteA', 'suiteB'])
    t.ok('and the check does not count as passed', gatingResult({ result: 'failed', baselineComparison: { failures: swapped } }, { workspace: { baseCommit: SOURCE } }) !== 'passed')
    const same = await compare({ out: stream('expected2', 'expected3') }, { out: stream('expected2', 'expected3') })
    t.eq('identical nested output is baseline-known, path by path', [same.verdict, same.baselineKnown.map((x) => x.test)], ['baseline-known', ['suiteA > same', 'suiteA', 'suiteB > same', 'suiteB']])
    const orphan = stream('expected2', 'expected3').replace('# Subtest: suiteA\n', '')
    t.eq('a nested point whose enclosing test is not opened: not-made', (await compare({ out: orphan }, { out: orphan })).verdict, 'not-made')
    const prints = outputParts('cmd', stream('expected2', 'expected3')).failures
    t.ok('stored fingerprints name the path and differ between the two children', prints[0].test === 'suiteA > same' && prints[2].test === 'suiteB > same' && prints[0].fingerprint !== outputParts('cmd', stream('expected3', 'expected3')).failures[0].fingerprint)
  }

  t.section('the comparison is made against the base of the same source revision, or not at all')
  {
    t.eq('a command that passes on the base is new', (await compare({ out: 'ok\n', passed: true, exitCode: 0 }, { out: 'FAIL t\n' })).verdict, 'new-failures')
    t.eq('a timeout is never inherited', (await compare({ out: '' }, { out: '', timedOut: true })).verdict, 'new-failures')
    t.eq('a different exit code is new', (await compare({ out: 'x\n', exitCode: 1 }, { out: 'x\n', exitCode: 2 })).verdict, 'new-failures')
    t.eq('a base that could not be checked: not-made', (await compare({ out: '' }, { out: '' }, { baseCheck: { result: 'unavailable', error: 'unreachable' } })).verdict, 'not-made')
    const stale = await compare({ out: 'x\n' }, { out: 'x\n' }, { baseCheck: { sourceRevision: 'c'.repeat(40), baseCommit: 'c'.repeat(40) } })
    t.eq('a baseline of another source revision: not-made, saying so', [stale.verdict, /not b{40}/.test(stale.reason)], ['not-made', true])
    t.eq('a log that is not the runner\'s: not-made', (await compare({ out: 'x\n', log: 'garbled' }, { out: 'x\n' })).verdict, 'not-made')
    const missing = await compare({ out: 'x\n' }, { out: 'x\n' }, { target: { commands: [{ id: 'cmd', run: 'run' }, { id: 'later', run: 'true' }] } })
    t.eq('a required command that did not run: not-made, listed', [missing.verdict, missing.notRun], ['not-made', ['later']])
    t.eq('no baseline at all: not-made', (await compareFailures({ runDir: os.tmpdir(), target: {}, base: null, candidate: { commands: [] }, sourceRevision: SOURCE })).verdict, 'not-made')
    const run = { workspace: { baseCommit: SOURCE } }
    const known = { result: 'failed', baselineComparison: { failures: { verdict: 'baseline-known', sourceRevision: SOURCE } } }
    t.eq('gating: baseline-known of this source revision counts as passed', gatingResult(known, run), 'passed')
    t.eq('gating: of another source revision it stays failed', gatingResult(known, { workspace: { baseCommit: 'c'.repeat(40) } }), 'failed')
    t.eq('gating: an older record without a comparison stays failed', gatingResult({ result: 'failed' }, run), 'failed')
  }

  t.section('baseline fingerprints (AC1) and needs validation')
  {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-inherit-'))
    temps.push(runDir)
    await fs.mkdir(path.join(runDir, 'checks/base'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'checks/base/cmd.log'), '$ run\n\nFAIL legacy — expected 1 got 2\n\n--- exit 1 in 1 ms ---\n')
    await fs.writeFile(path.join(runDir, 'checks/base/cmd.stdout'), 'FAIL legacy — expected 1 got 2\n')
    const prints = await failureFingerprints({ runDir, target: { commands: [{ id: 'cmd' }] }, check: { dir: 'checks/base', commands: [{ id: 'cmd', run: 'run', log: 'cmd.log', passed: false, exitCode: 1 }] } })
    t.eq('one entry per failure block and one per command', prints.map((p) => [p.command, p.test, p.message]), [['cmd', 'legacy', 'expected 1 got 2'], ['cmd', '(command)', 'exit 1']])
    t.ok('each with a fingerprint', prints.every((p) => /^[0-9a-f]{64}$/.test(p.fingerprint)))
    const infra = (commands, finallyCommands) => ({ staging: { id: 's', ssh: { hostRef: 'a', workdir: '/srv' } }, deployments: [], testDrive: { commands, ...(finallyCommands ? { finallyCommands } : {}) } })
    t.eq('needs naming an earlier command is accepted', infrastructureErrors(infra([{ id: 'a', run: 'x' }, { id: 'b', run: 'x', needs: ['a'] }])), [])
    t.ok('needs naming a later or unknown command is refused', infrastructureErrors(infra([{ id: 'b', run: 'x', needs: ['a'] }, { id: 'a', run: 'x' }])).some((e) => /needs must name an earlier command/.test(e)))
    t.ok('needs on a finalizer is refused', infrastructureErrors(infra([{ id: 'a', run: 'x' }], [{ id: 'f', run: 'x', needs: ['a'] }])).some((e) => /cannot declare needs/.test(e)))
  }

  t.section('a run whose only check failures are baseline-known closes, without another round')
  {
    const { engine, implementTurns } = await scenario([{ id: 'legacy', run: LEGACY }, { id: 'later', run: 'true', needs: [] }])
    const run = engine.run
    t.eq('the run completes', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    t.eq('one implementation round: no round spent on the inherited failure', implementTurns, 1)
    t.eq('the check itself still says failed', run.checkResults.at(-1)?.result, 'failed')
    const base = run.baselineChecks?.[0]
    t.eq('one baseline, captured for the failure, of the source revision', [run.baselineChecks?.length, base?.sourceRevision], [1, run.workspace.baseCommit])
    t.ok('with its capture time and the failure fingerprints', typeof base?.capturedAt === 'string' && base.failures.some((x) => x.command === 'legacy' && x.test === 'legacy'))
    t.eq('closure records the failure as baseline-known', [run.closure?.checks?.comparison, run.closure?.checks?.baselineKnown?.map((x) => x.test)], ['baseline-known', ['legacy']])
    t.eq('and counts the checks as verified', run.closure?.verificationLevel, 'verified')
    t.ok('an independent command still ran after the failure, on both sides', run.checkResults.at(-1).commands.some((c) => c.id === 'later') && base.commands.some((c) => c.id === 'later'))
    t.ok('the explanation says so', /baseline-known/.test(explainRun(run).detail ?? ''), JSON.stringify(explainRun(run)))
    t.ok('result.md proposes it as a separate issue', /## Baseline-known check failures[\s\S]*`legacy`: legacy/.test(renderResult(run, {})))
    await releaseWorkspace(engine)
  }

  t.section('a run with one new failure still blocks, beside the baseline-known one')
  {
    const { engine } = await scenario([{ id: 'legacy', run: `${LEGACY.replace('; exit 1', '')}; if test -f work.txt; then echo "FAIL fresh — broke"; fi; exit 1` }])
    const run = engine.run
    t.eq('blocked as checks-failed-unchanged', `${run.status} ${run.blockedReason}`, 'blocked checks-failed-unchanged')
    const failures = run.checkResults.at(-1)?.baselineComparison?.failures
    t.eq('the same check names the inherited and the new failure', [failures?.verdict, failures?.baselineKnown.map((x) => x.test), failures?.newFailures.map((x) => x.test)], ['new-failures', ['legacy'], ['fresh']])
    t.ok('it is a checks-only block', checksOnlyBlock(run))
    t.ok('the explanation names the new failure', /New failures: legacy: fresh/.test(explainRun(run).detail ?? ''), JSON.stringify(explainRun(run)))
    await releaseWorkspace(engine)
  }

  t.section('a base that cannot be checked: the comparison is not made and the failure blocks')
  {
    // On the base (no work.txt) the command deletes a candidate file: unavailable.
    const { engine } = await scenario([{ id: 'legacy', run: 'test -f work.txt || rm source.txt; exit 1' }])
    const run = engine.run
    t.eq('blocked', run.status, 'blocked', run.blockedReason)
    t.eq('the comparison was not made', run.checkResults.at(-1)?.baselineComparison?.failures?.verdict, 'not-made')
    t.ok('and the explanation says so', /could not be compared/.test(explainRun(run).detail ?? ''), JSON.stringify(explainRun(run)))
    await releaseWorkspace(engine)
  }

  t.section('selftest reports: the report is located in the collector\'s output, or not at all')
  {
    for (const pretty of [true, false]) {
      for (const trailing of [false, true]) {
        const found = selftestReport(collected('r1', report([OLD, NEW], { pretty }), { trailing }))
        t.eq(`${pretty ? 'pretty-printed' : 'minified'}${trailing ? ', with the application\'s logs after it' : ''}: its failed tests`, failedSelftests(found.report), ['socket — old-test', 'socket — new-test'])
      }
    }
    t.eq('the path it names', selftestReport(collected('r1', report([OLD]))).path, 'runtime/log/r1/threads/App.tester/1/selftest.report')
    t.eq('report: selftest names the format; an older site-prefixed spelling is read the same', ['selftest', 'site-selftest', 'app.example-selftest'].map(isSelftestReport), [true, true, true])
    t.eq('and nothing else is', ['selftests', '-selftest', 'Selftest', 'selftest-x', '', undefined].map(isSelftestReport), [false, false, false, false, false, false])
    // The real shape: the report file has no final newline,
    // so the next log's "== <path>" header is glued to the closing brace.
    const glued = '== runtime/log/r1/threads/App.tester/1/selftest.report\n' + report([OLD, NEW]) + '== runtime/worker-selftest-check.log\nPASS x (1ms)\n'
    t.eq('a log header glued to the closing brace: still read', failedSelftests(selftestReport(glued).report), ['socket — old-test', 'socket — new-test'])
    t.ok('no report line: unreadable', /found 0/.test(selftestReport('Tester selftest.report was not produced\n').error))
    t.ok('two report lines: unreadable', /found 2/.test(selftestReport(collected('a', report([OLD])) + collected('b', report([OLD]))).error))
    t.ok('a truncated report: unreadable', /no JSON report/.test(selftestReport(collected('r1', report([OLD])).slice(0, -20)).error))
    t.eq('skipped and passing tests are not failures; a name that failed once is', failedSelftests({ a: [{ test: 'x', skipped: true, error: 'e' }, { test: 'y' }, { test: 'z', stack: 's' }, { test: 'y', error: 'later' }] }), ['y', 'z'])
  }

  t.section('selftest reports: compared by the whole test name, never by message, path or position')
  {
    // auditor-1's counterexample: two tests whose names share "socket — ".
    const counter = await compareReports(collected('r1', report([OLD])), collected('r2', report([{ ...OLD, error: 'inherited error at 12:09:44' }, NEW])))
    t.eq('the regression is the one new failure', [counter.verdict, counter.newFailures, counter.baselineKnown.map((x) => x.test)],
      ['new-failures', [{ command: 'collect', test: 'socket — new-test' }], ['socket — old-test']])
    const inherited = await compareReports(collected('r1', report([OLD, { test: 'core/a' }]), { trailing: true }), collected('r2', report([{ test: 'core/a' }, { ...OLD, error: 'another message' }], { pretty: false }), { trailing: true }))
    t.eq('inherited only (another message, path, order and format): baseline-known', [inherited.verdict, inherited.newFailures], ['baseline-known', []])
    t.eq('no failure listed: none, without a base', (await compareReports('', collected('r2', report([{ test: 'core/a' }])), { base: false })).verdict, 'none')
    t.eq('failures listed and no base: not-made', (await compareReports('', collected('r2', report([OLD])), { base: false })).verdict, 'not-made')
    t.eq('failures listed and an unreadable base report: not-made', (await compareReports('garbage', collected('r2', report([OLD])))).verdict, 'not-made')
    t.eq('the candidate\'s report unreadable: not-made', (await compareReports(collected('r1', report([OLD])), 'garbage')).verdict, 'not-made')
    const crashed = [{ test: 'worker/(suite)', error: 'RPC call timed out after 900002ms' }, { test: '(suite-busy)', error: 'A selftest suite is still running' }]
    const incomplete = await compareReports(collected('r1', report(crashed)), collected('r2', report([OLD])))
    t.eq('a base whose suite did not complete: not-made, not new-failures', [incomplete.verdict, incomplete.newFailures], ['not-made', []])
    t.ok('and the reason names the unfinished suite', /did not complete \(worker\/\(suite\), \(suite-busy\)\)/.test(incomplete.reason), incomplete.reason)
    t.eq('it is marked as caused by the base alone', incomplete.baseUnfinished, true)
    t.eq('an unreadable base is not-made without that mark', (await compareReports('garbage', collected('r2', report([OLD])))).baseUnfinished, undefined)
    const stopped = await compareReports('', collected('r2', report([OLD])), { basePassed: false })
    t.eq('a base whose report command failed (stopped before its selftests) is unfinished too', [stopped.verdict, stopped.baseUnfinished], ['not-made', true])
    t.ok('saying its selftest run did not complete', /on the base, the command failed, so its selftest run did not complete/.test(stopped.reason), stopped.reason)
    const stoppedBase = { result: 'failed', dir: 'checks/base', commands: [{ id: 'collect', passed: false, exitCode: 1 }] }
    t.eq('and unfinishedSuites names it, so the engine neither keeps nor caches that base', await unfinishedSuites({ runDir: os.tmpdir(), target: { finallyCommands: [{ id: 'collect', report: 'selftest' }] }, check: stoppedBase }), ['collect/(report)'])
    t.eq('a base that never ran the command is unfinished as well', await unfinishedSuites({ runDir: os.tmpdir(), target: { finallyCommands: [{ id: 'collect', report: 'selftest' }] }, check: { result: 'failed', commands: [] } }), ['collect/(report)'])
    const passedWith = (selftest, extra = {}) => ({ result: 'passed', baselineComparison: { selftest }, ...extra })
    t.eq('inconclusiveBase: a passed drive whose only fault is the unfinished base', inconclusiveBase(passedWith(incomplete)), true)
    t.eq('but the gate still fails it', gatingResult(passedWith(incomplete)), 'failed')
    t.eq('not for a not-made of another cause', inconclusiveBase(passedWith({ verdict: 'not-made', reason: 'x' })), false)
    t.eq('not for new failures', inconclusiveBase(passedWith({ verdict: 'new-failures', newFailures: [{ test: 'x' }] })), false)
    t.eq('not when the drive failed on its own as well', inconclusiveBase({ result: 'failed', baselineComparison: { selftest: incomplete, failures: { verdict: 'new-failures' } } }), false)
    t.eq('the candidate\'s own suite failure against a complete base is still new', (await compareReports(collected('r1', report([OLD])), collected('r2', report([OLD, crashed[0]])))).verdict, 'new-failures')
    t.eq('an unfinished base still recognises what it did see as inherited', (await compareReports(collected('r1', report([OLD, ...crashed])), collected('r2', report([OLD])))).verdict, 'baseline-known')
    t.eq('the collector itself failed: not-applicable, the byte rules judge it', (await compareReports(collected('r1', report([OLD])), 'no report', { candidatePassed: false })).verdict, 'not-applicable')
  }

  t.section('selftest reports only ever add a failed gate')
  {
    const run = { workspace: { baseCommit: SOURCE } }
    const known = { verdict: 'baseline-known', sourceRevision: SOURCE }
    t.eq('passed, with a new selftest failure: failed', gatingResult({ result: 'passed', baselineComparison: { selftest: { verdict: 'new-failures' } } }, run), 'failed')
    t.eq('passed, with a report that cannot be compared: failed', gatingResult({ result: 'passed', baselineComparison: { selftest: { verdict: 'not-made' } } }, run), 'failed')
    t.eq('passed, with inherited selftest failures only: passed', gatingResult({ result: 'passed', baselineComparison: { selftest: { verdict: 'baseline-known' } } }, run), 'passed')
    t.eq('baseline-known by the byte rules, with a new selftest failure: failed', gatingResult({ result: 'failed', baselineComparison: { failures: known, selftest: { verdict: 'new-failures' } } }, run), 'failed')
    t.eq('baseline-known by the byte rules, inherited selftests: passed', gatingResult({ result: 'failed', baselineComparison: { failures: known, selftest: { verdict: 'baseline-known' } } }, run), 'passed')
    t.eq('a byte-rule failure stays failed whatever the report says', gatingResult({ result: 'failed', baselineComparison: { failures: { verdict: 'new-failures', sourceRevision: SOURCE }, selftest: { verdict: 'none' } } }, run), 'failed')
  }

  t.section('the gate names the condition that failed')
  {
    const run = { workspace: { baseCommit: SOURCE } }
    const known = { verdict: 'baseline-known', sourceRevision: SOURCE }
    const failedCommands = [{ id: 'drive', required: true, passed: false }, { id: 'lint', required: false, passed: false }]
    t.eq('a pass names nothing', gateReason({ result: 'passed' }, run), null)
    t.eq('an inherited failure names nothing', gateReason({ result: 'failed', commands: failedCommands, baselineComparison: { failures: known } }, run), null)
    t.eq('a selftest verdict, new', gateReason({ result: 'passed', baselineComparison: { selftest: { verdict: 'new-failures', newFailures: [{ command: 'collect', test: 'a' }] } } }, run), 'selftest verdict new-failures: collect: a')
    t.eq('a selftest verdict, not made', gateReason({ result: 'passed', baselineComparison: { selftest: { verdict: 'not-made', reason: 'collect: no baseline' } } }, run), 'selftest verdict not-made: collect: no baseline')
    t.eq('new failures, with the failed command', gateReason({ result: 'failed', commands: failedCommands, baselineComparison: { failures: { verdict: 'new-failures', newFailures: [{ command: 'drive', test: '(command)', message: 'passes on the base' }] } } }, run), 'required command drive failed; not on the base: drive: (command) (passes on the base)')
    t.eq('a comparison not made', gateReason({ result: 'failed', commands: failedCommands, baselineComparison: { failures: { verdict: 'not-made', reason: 'the base could not be checked' } } }, run), 'required command drive failed; comparison with the base not made: the base could not be checked')
    t.eq('no comparison at all', gateReason({ result: 'failed', commands: failedCommands }, run), 'required command drive failed; no comparison with the base was made')
    t.eq('inherited, but of another revision', gateReason({ result: 'failed', commands: failedCommands, baselineComparison: { failures: { verdict: 'baseline-known', sourceRevision: 'other' } } }, run), 'required command drive failed; known only on other, not this source revision')
    t.eq('an inherited failure is not blamed for the selftest that gated', gateReason({ result: 'failed', commands: failedCommands, baselineComparison: { failures: known, selftest: { verdict: 'not-made', reason: 'r' } } }, run), 'selftest verdict not-made: r')
    t.eq('a check that could not run', gateReason({ result: 'unavailable', error: 'ssh refused' }, run), 'the check did not complete (unavailable): ssh refused')
    t.ok('a long list is bounded', gateReason({ result: 'passed', baselineComparison: { selftest: { verdict: 'new-failures', newFailures: Array.from({ length: 7 }, (_, i) => ({ command: 'c', test: `t${i}` })) } } }, run).endsWith('c: t4 and 2 more'))
  }

  t.section('a new selftest failure fails a passing check: the author gets a round, fixes it, and the run closes')
  {
    // retryFailed 1: the selftest-gated drive runs once more first (selftest-retry.mjs); the regression reproduces.
    const { engine, prompts, implementTurns } = await scenario([{ id: 'collect', run: COLLECT, report: 'selftest' }], { regression: true, retryFailed: 1 })
    const run = engine.run
    t.eq('the run completes', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    t.eq('after exactly one more author round', implementTurns, 2)
    t.eq('the first revision\'s check passed as run, and its gate failed', run.checkHistory?.map((h) => [h.result, h.gating]), [['passed', 'failed'], ['passed', 'passed']])
    const implement1 = prompts.find((p) => p.stepId === 'implement' && p.round === 1)
    t.ok('the author was told which test is new', /"newFailures": \[\s*\{\s*"command": "collect",\s*"test": "socket — new-test"/.test(implement1?.prompt ?? ''))
    t.eq('the base was captured for the passing check', run.baselineChecks?.length, 1)
    const retries = (await readEvents(engine.issuePath, engine.runId)).events.filter((e) => e.type === 'checks-retry')
    t.eq('the gated drive ran once more before the author was sent back, and only that one', retries.map((e) => e.reason), ['new-selftest-failures'])
    t.ok('the author was told the failure reproduced', /they reproduce/.test(implement1?.prompt ?? ''))
    t.eq('closure records the inherited failure, which did not block', [run.closure?.checks?.selftest?.verdict, run.closure?.checks?.selftest?.baselineKnown?.map((x) => x.test)], ['baseline-known', ['socket — old-test']])
    await releaseWorkspace(engine)
  }

  t.section('a new selftest failure that a second drive does not repeat costs no author round')
  {
    // The candidate (work.txt) names the regression on its first drive only: a counter outside the rebuilt candidate.
    const seen = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-unstable-')), 'seen')
    temps.push(path.dirname(seen))
    const unstable = COLLECT.replace('if test -f break.txt; then', `if test -f work.txt && ! test -f ${seen}; then touch ${seen}; `)
    const { engine, implementTurns } = await scenario([{ id: 'collect', run: unstable, report: 'selftest' }], { retryFailed: 1 })
    const run = engine.run
    t.eq('the run completes', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    t.eq('without another author round', implementTurns, 1)
    const check = run.checkResults.at(-1)
    t.eq('the second drive stands, marked flaky, the first kept with what it named', [check.flaky, check.attempts?.[0]?.newFailures?.map((x) => x.test)], [true, ['socket — new-test']])
    await releaseWorkspace(engine)
  }

  t.section('a base whose selftest run did not finish is driven again, and an inherited failure costs no author round')
  {
    // The first base drive reports only suite-level failures (the DKIM run's worker RPC timeout); every later
    // drive reports the inherited failure. The candidate is told apart by work.txt, which only the author writes.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-unfinished-base-'))
    temps.push(dir)
    const marker = path.join(dir, 'crashed')
    const once = `if ! test -f work.txt && ! test -f ${marker}; then touch ${marker}; t='{"test":"worker/(suite)","error":"RPC call timed out after 900002ms"},{"test":"(suite-busy)","error":"busy"}'; ` +
      `else t='{"test":"socket — old-test","error":"inherited at '$$'"},{"test":"core/a"}'; fi; ` +
      'echo "waited: 1 s after the candidate\'s start"; echo "== runtime/log/r$$/threads/App.tester/1/selftest.report"; echo \'  "total": 2,\'; printf \'{\\n  "total": 2,\\n  "tests": [%s]\\n}\\n\' "$t"'
    const { engine, implementTurns } = await scenario([{ id: 'collect', run: once, report: 'selftest' }])
    const run = engine.run
    t.eq('the run completes', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    t.eq('in one implementation round', implementTurns, 1)
    t.eq('the unfinished base is kept as evidence, marked, and a second base was driven', run.baselineChecks?.map((b) => Boolean(b.unfinished)), [true, false])
    t.eq('the inherited failure is baseline-known against the complete base', [run.closure?.checks?.selftest?.verdict, run.closure?.checks?.selftest?.newFailures], ['baseline-known', []])
    await releaseWorkspace(engine)
  }

  t.section('a base that stays unfinished after its redrive stops the loop without an author round')
  {
    // Every base drive stops early until `healed` exists; the candidate (work.txt) reports one failure the base
    // never reached.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-unfinished-base-'))
    temps.push(dir)
    const healed = path.join(dir, 'healed')
    const always = `if ! test -f work.txt && ! test -f ${healed}; then t='{"test":"worker/(suite)","error":"RPC call timed out after 900002ms"}'; ` +
      `elif ! test -f work.txt; then t='{"test":"socket — old-test","error":"inherited at '$$'"}'; ` +
      `else t='{"test":"socket — old-test","error":"inherited at '$$'"},{"test":"core/a"}'; fi; ` +
      'echo "waited: 1 s after the candidate\'s start"; echo "== runtime/log/r$$/threads/App.tester/1/selftest.report"; echo \'  "total": 2,\'; printf \'{\\n  "total": 2,\\n  "tests": [%s]\\n}\\n\' "$t"'
    const { engine, implementTurns } = await scenario([{ id: 'collect', run: always, report: 'selftest' }])
    const run = engine.run
    t.eq('blocked as inconclusive', `${run.status} ${run.blockedReason}`, 'blocked checks-inconclusive')
    t.eq('the author was not sent round again', implementTurns, 1)
    t.eq('two base drives, both unfinished, neither held', run.baselineChecks?.map((b) => Boolean(b.unfinished)), [true, true])
    t.eq('the history marks the check inconclusive', run.checkHistory?.at(-1)?.inconclusive, true)
    t.ok('refresh-checks is offered', checksOnlyBlock(run))
    const said = explainRun(run)
    t.ok('the explanation says inconclusive, not a regression', /did not finish its tests/.test(said.headline) && /Inconclusive, not a regression/.test(said.detail), JSON.stringify(said))
    t.eq('refresh-checks and continue are offered, resume is not', supportedActions(run), ['continue', 'refresh-checks', 'start-new'])

    // The drive is fixed: Refresh checks must drive a fresh base, since an unfinished one is never held.
    await fs.writeFile(healed, '')
    // The snapshot's own target, so the same targetKey: only the unfinished mark keeps the old bases from being held.
    await engine.refreshClosureChecks(engine.snapshot.checks.target)
    await engine.drive()
    t.eq('with a complete base the run completes', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('the failure is inherited against it', engine.run.closure?.checks?.selftest?.verdict, 'baseline-known')
    t.eq('still no author round', engine.run.steps.filter((s) => s.stepId === 'implement').length, 1)
    await releaseWorkspace(engine)
  }

  t.section('inherited selftest failures only: the run closes in one round')
  {
    const { engine, prompts, implementTurns } = await scenario([{ id: 'collect', run: COLLECT, report: 'site-selftest' }])
    const run = engine.run
    t.eq('the run completes', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    t.eq('one implementation round', implementTurns, 1)
    t.eq('the inherited failure is baseline-known', [run.closure?.checks?.gating, run.closure?.checks?.selftest?.verdict, run.closure?.checks?.selftest?.newFailures], ['passed', 'baseline-known', []])
    // The fence is off in this suite: the confirmation has no tools, so the
    // engine quotes the gate and the selftest comparison into its prompt.
    const confirm = prompts.find((p) => p.stepId === 'confirm')?.prompt ?? ''
    t.ok('with the fence off, the confirmation prompt quotes the gate and the selftest comparison', /"gating":"passed"/.test(confirm) && /"selftest":\{"verdict":"baseline-known"/.test(confirm) && /socket — old-test/.test(confirm) && !/check logs \(read-only/.test(confirm))
    await releaseWorkspace(engine)
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
}
