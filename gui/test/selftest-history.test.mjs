import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { promisify } from 'node:util'

import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace, releaseOwnership, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { plan } from '../server/runtime/engine.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { baselineOf, fingerprint, treeIdentity } from '../server/runtime/fingerprint.mjs'
import { compareSelftestReports, gatingResult, gateReason, identifyCheckFailures, inconclusiveBase } from '../server/runtime/baseline-failures.mjs'
import { classifyAll, classifyTest, EXPIRY_PASSES, forgetRunDrives, historyDir, moduleBoundary, openStability, readDrives, recordDrive, scanDeclarations, touchVerdict } from '../server/runtime/selftest-history.mjs'
import { checkSummary } from '../server/runtime/check-summary.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { renderResult } from '../server/run-result-step.mjs'
import { runMetrics } from '../server/runtime/run-metrics.mjs'
import { localTarget, stagingTarget } from '../server/infrastructure.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'unstable selftests — classified from recorded drives by each route, not gating, expiring, and still reported'

const exec = promisify(execFile)
const NOW = Date.parse('2026-11-03T00:00:00.000Z')
const DAY = 86400000
const TEST = 'service/service-fox-technician'
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```\n'
const revisionIn = (p) => /Current revision: (\S+)/.exec(p)?.[1] ?? null

/** One recorded drive, `days` before NOW. `failed`/`passed` are of the command `collect`. */
let serial = 0
const drive = ({ days = 1, issue = 'issue-a', run = `run-${issue}`, kind = 'candidate', bytes = 'tree-1', target = 'target-1', failed = [], passed = [], asNew = [], base = 'base-1', revision = 'rev' }) => ({
  id: `drive-${++serial}`, at: new Date(NOW - days * DAY).toISOString(), runId: run, issueId: issue, kind, treeIdentity: bytes, targetKey: target, revision, baseCommit: base, tier: null, dir: `checks/${String(serial).padStart(3, '0')}`, changedPaths: [],
  commands: [{ command: 'collect', failed, passed, asNew: asNew.map(([test, verdict]) => ({ test, touch: { verdict } })) }]
})
const fails = (over = {}) => drive({ failed: [TEST], ...over })
const passes = (over = {}) => drive({ passed: [TEST], ...over })
const newOn = (issue, verdict = 'untouched', over = {}) => drive({ issue, failed: [TEST], asNew: [[TEST, verdict]], bytes: `tree-${issue}`, ...over })
const current = (over = {}) => ({ id: 'current', at: new Date(NOW).toISOString(), runId: 'this-run', issueId: 'this-issue', kind: 'candidate', dir: 'checks/900', treeIdentity: 'tree-now', targetKey: 'target-1', ...over })
const judge = (drives, over = {}) => classifyTest({ drives, command: 'collect', test: TEST, current: current(over), issueId: 'this-issue', now: NOW })

/** Entries of a tree as a fingerprint holds them; `changed` are its non-unchanged paths. */
const treeOf = (files, changed = []) => files.map((p) => ({ path: p, status: changed.includes(p) ? 'modified' : 'unchanged', mode: '000644', contentHash: 'sha256:x' }))

export default async function (t) {
  const temps = []
  const tempDir = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(d); return d }

  /** A real tree on disk, for the declarations a file holds. */
  async function touchOf ({ files, changed, test = TEST, module = null, maxScanBytes }) {
    const root = await tempDir('devpanel-tree-')
    for (const [file, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await fs.writeFile(path.join(root, file), text)
    }
    const entries = treeOf(Object.keys(files), changed)
    const scan = await scanDeclarations({ tests: [test], entries, root, ...(maxScanBytes ? { maxScanBytes } : {}) })
    return touchVerdict({ test, module, files: Object.keys(files), declaring: scan.declaring?.get(test) ?? [], changed, incomplete: scan.incomplete ?? null })
  }

  t.section('AC1: the record reads back per test, candidate and base, a reused base once, with the issue folder gone')
  {
    const issues = await tempDir('devpanel-history-')
    const issuePath = path.join(issues, 'proj', '2026-11-01-some-issue')
    const dir = historyDir(issuePath)
    t.eq('the record sits beside the issues, outside any issue', dir, path.join(issues, 'proj', '.selftest-history'))
    t.eq('no record yet reads as none', await readDrives(dir), [])
    const base = { ...drive({ kind: 'base', passed: [TEST], run: 'run-1' }), id: 'run-1:base:base-1:T' }
    await recordDrive(dir, base, { now: NOW })
    await recordDrive(dir, fails({ run: 'run-1' }), { now: NOW })
    // Another run adopted run-1's base from the baseline cache: the same drive under the same id.
    await recordDrive(dir, { ...base, runId: 'run-2', reused: { fromRun: 'run-1', key: 'k' } }, { now: NOW })
    await fs.appendFile(path.join(dir, 'run-2.jsonl'), '{"id":"torn')
    const drives = await readDrives(dir)
    const twoBases = await tempDir('devpanel-history-ids-')
    const record = (over) => openStability({ issuePath: path.join(twoBases, 'proj', 'issue'), runId: 'r', target: { commands: [{ id: 'collect', report: 'selftest' }] }, targetKey: 't', clock: { now: () => NOW }, runDir: twoBases }).record(over)
    await fs.mkdir(path.join(twoBases, 'checks/base-a'), { recursive: true })
    await fs.mkdir(path.join(twoBases, 'checks/base-b'), { recursive: true })
    const stdout = `== runtime/selftest.report\n${JSON.stringify({ tests: [{ test: TEST }] })}\n`
    await fs.writeFile(path.join(twoBases, 'checks/base-a/collect.stdout'), stdout)
    await fs.writeFile(path.join(twoBases, 'checks/base-b/collect.stdout'), stdout)
    const at = new Date(NOW).toISOString()
    const baseDrive = (dir, extra = {}) => ({ dir: `checks/${dir}`, at, commands: [{ id: 'collect', passed: true }], ...extra })
    await record({ check: baseDrive('base-a', { unfinished: true }), kind: 'base', baseCommit: 'b' })
    await record({ check: baseDrive('base-b'), kind: 'base', baseCommit: 'b' })
    await record({ check: baseDrive('base-b', { reused: { fromRun: 'r', key: 'k', fromDir: 'checks/base-a' } }), kind: 'base', baseCommit: 'b' })
    t.eq('auditor-1-007: two base drives in one clock tick stay two, and a reused one counts once', (await readDrives(path.join(twoBases, 'proj', '.selftest-history'))).map((d) => [d.dir, d.unfinished ?? false]).sort(), [['checks/base-a', true], ['checks/base-b', false]])
    t.eq('a torn line is skipped, a reused base counts once', drives.map((d) => d.kind).sort(), ['base', 'candidate'])
    t.eq('both kinds say how the test ended', drives.map((d) => [d.kind, d.commands[0].failed.includes(TEST), d.commands[0].passed.includes(TEST)]).sort(), [['base', false, true], ['candidate', true, false]])
    await fs.mkdir(issuePath, { recursive: true })
    await fs.rm(issuePath, { recursive: true })
    t.eq('packing or removing the issue leaves it readable', (await readDrives(dir)).length, 2)
    await forgetRunDrives(issuePath, 'run-1')
    t.eq('a deleted run takes its file with it', (await readDrives(dir)).map((d) => d.runId), ['run-2'])
    const old = await tempDir('devpanel-prune-')
    await recordDrive(old, drive({ run: 'old-run', days: 40 }), { now: NOW })
    await recordDrive(old, drive({ run: 'new-run' }), { now: NOW })
    t.eq('a file of drives past 30 days is pruned on write', (await readDrives(old)).map((d) => d.runId), ['new-run'])

  }

  t.section('AC2: route 1, passed and failed on the same bytes')
  {
    t.eq('a pass and this failure on one tree, across runs', judge([passes({ bytes: 'tree-now', run: 'other' })])?.routes, ['same-bytes'])
    t.eq('a pass and a failure of one earlier tree', judge([passes({ bytes: 'b' }), fails({ bytes: 'b', run: 'other' })])?.routes, ['same-bytes'])
    t.eq('in one run', judge([passes({ bytes: 'b', run: 'r' }), fails({ bytes: 'b', run: 'r' })])?.routes, ['same-bytes'])
    t.eq('identical trees pair across a changed base', judge([passes({ bytes: 'b', base: 'base-1' }), fails({ bytes: 'b', base: 'base-2' })])?.routes, ['same-bytes'])
    t.eq('a candidate pairs with a later base drive of its tree', judge([fails({ bytes: 'b', kind: 'candidate' }), passes({ bytes: 'b', kind: 'base', days: 0.5 })])?.routes, ['same-bytes'])
    t.eq('different bytes do not pair', judge([passes({ bytes: 'b' }), fails({ bytes: 'c' })]), null)
    t.eq('a different target definition does not pair', judge([passes({ bytes: 'b', target: 'target-2' }), fails({ bytes: 'b', target: 'target-1' })]), null)
    t.eq('failures alone do not pair', judge([fails({ bytes: 'tree-now' }), fails({ bytes: 'tree-now' })]), null)
    t.eq('a drive with no tree identity (a base cached before this) is no evidence', judge([passes({ bytes: null }), fails({ bytes: null })], { treeIdentity: null }), null)

    const a = await tempDir('devpanel-tree-a-')
    for (const [file, text] of [['one.txt', 'one\n'], ['two.txt', 'two\n']]) await fs.writeFile(path.join(a, file), text)
    const otherBase = await tempDir('devpanel-tree-base-')
    await fs.writeFile(path.join(otherBase, 'one.txt'), 'older\n')
    const [onItself, onOther] = [await fingerprint(a, { baseline: await baselineOf(a) }), await fingerprint(a, { baseline: await baselineOf(otherBase) })]
    t.ok('fingerprints of one tree differ with their baseline', onItself.fingerprint !== onOther.fingerprint)
    t.eq('its tree identity does not', treeIdentity(onItself.entries), treeIdentity(onOther.entries))
    await fs.writeFile(path.join(a, 'two.txt'), 'changed\n')
    t.ok('other bytes have another', treeIdentity((await fingerprint(a)).entries) !== treeIdentity(onItself.entries))
  }

  t.section('AC3: route 2, failed as new on revisions proved not to touch its module')
  {
    t.eq('two other issues classify it', judge([newOn('a'), newOn('b')])?.routes, ['unrelated-revisions'])
    t.eq('one other issue does not', judge([newOn('a'), newOn('a', 'untouched', { run: 'again' })]), null)
    t.eq('this issue\'s own revisions do not', judge([newOn('this-issue'), newOn('this-issue'), newOn('a')]), null)
    t.eq('touched revisions do not', judge([newOn('a', 'touched'), newOn('b', 'touched')]), null)
    t.eq('unknown revisions never do', judge([newOn('a', 'unknown'), newOn('b', 'unknown')]), null)
    t.eq('a failure not new against a base does not', judge([drive({ issue: 'a', failed: [TEST], bytes: 'x' }), drive({ issue: 'b', failed: [TEST], bytes: 'y' })]), null)

    const SERVICE = { 'modules/service/package.json': '{}\n', 'modules/service/fox.js': `selftest('${TEST}')\n`, 'modules/service/impl.js': 'impl\n', 'docs/service-guide.md': 'about service\n', 'lib/x.js': 'x\n' }
    const FLAT = { 'test/fox.test.mjs': 'test("service-fox-technician")\n', 'server/fox.mjs': 'impl\n', 'test/other.mjs': 'o\n' }
    const DISPATCH = { 'modules/dispatch/handler.js': 'register("service-fox-technician")\n', 'modules/dispatch/other.js': 'o\n', 'lib/x.js': 'x\n' }
    const verdict = async (args) => { const r = await touchOf(args); return [r.verdict, r.reason] }

    const guide = await touchOf({ files: SERVICE, changed: ['docs/service-guide.md'] })
    t.eq('docs/service-guide.md is outside modules/service: untouched', [guide.verdict, guide.source, guide.boundary], ['untouched', 'manifest', 'modules/service'])
    t.eq('modules/service/impl.js is inside: touched', (await touchOf({ files: SERVICE, changed: ['modules/service/impl.js'] })).verdict, 'touched')
    t.eq('a flat test/ declaration with the implementation elsewhere: unknown', await verdict({ files: FLAT, changed: ['server/fox.mjs'] }), ['unknown', 'no-module-directory'])
    t.eq('a change beside that declaration: touched, by widening only', (await touchOf({ files: FLAT, changed: ['test/other.mjs'] })).verdict, 'touched')
    t.eq('a declaring file alone proves no boundary', await verdict({ files: DISPATCH, changed: ['lib/x.js'] }), ['unknown', 'no-module-directory'])
    t.eq('a change beside it: touched, by widening only', (await touchOf({ files: DISPATCH, changed: ['modules/dispatch/other.js'] })).verdict, 'touched')
    const stated = await touchOf({ files: DISPATCH, changed: ['lib/x.js'], module: 'modules/dispatch' })
    t.eq('a module the report states, sharing no name token: untouched', [stated.verdict, stated.source], ['untouched', 'report'])
    t.eq('and a change inside it: touched', (await touchOf({ files: DISPATCH, changed: ['modules/dispatch/other.js'], module: 'modules/dispatch' })).verdict, 'touched')
    const fileBoundary = touchVerdict({ test: TEST, module: 'svc/impl.js', files: ['svc/impl.js', 'svc/other.js'], changed: ['svc/other.js'] })
    t.eq('auditor-1-006: a stated module that is a regular file is no boundary', [fileBoundary.verdict, fileBoundary.reason], ['unknown', 'report-module-missing'])
    t.eq('a stated module naming no directory: unknown', await verdict({ files: DISPATCH, changed: ['lib/x.js'], module: 'modules/gone' }), ['unknown', 'report-module-missing'])
    t.eq('an invalid stated module counts as absent', await verdict({ files: DISPATCH, changed: ['lib/x.js'], module: '../outside' }), ['unknown', 'no-module-directory'])
    t.eq('a named directory without a manifest: unknown', await verdict({ files: { 'modules/service/impl.js': `selftest('${TEST}')\n`, 'lib/x.js': 'x\n' }, changed: ['lib/x.js'] }), ['unknown', 'no-manifest'])
    t.eq('with a manifest, declared only outside it: unknown', await verdict({ files: { 'modules/service/package.json': '{}\n', 'modules/service/impl.js': 'i\n', 'docs/fox.md': 'service-fox-technician\n', 'lib/x.js': 'x\n' }, changed: ['lib/x.js'] }), ['unknown', 'not-declared-inside'])
    t.eq('a directory named test is test-only', await verdict({ test: 'test/foo-check', files: { 'test/package.json': '{}\n', 'test/foo.js': 'foo-check\n', 'test/bar.js': 'b\n', 'lib/x.js': 'x\n' }, changed: ['lib/x.js'] }), ['unknown', 'test-only'])
    t.eq('a directory of nothing but its manifest and declaration is test-only', await verdict({ files: { 'service/package.json': '{}\n', 'service/fox.js': 'service-fox-technician\n', 'lib/x.js': 'x\n' }, changed: ['lib/x.js'] }), ['unknown', 'test-only'])
    t.eq('two directories passing every test: unknown, never a union', await verdict({ files: { 'a/service/package.json': '{}\n', 'a/service/fox.js': 'service-fox-technician\n', 'a/service/i.js': 'i\n', 'b/service/package.json': '{}\n', 'b/service/fox.js': 'service-fox-technician\n', 'b/service/i.js': 'i\n', 'lib/x.js': 'x\n' }, changed: ['lib/x.js'] }), ['unknown', 'ambiguous'])
    const worker = await touchOf({ test: 'worker/some-check', files: { 'lib/w/module@worker.mjs': 'm\n', 'lib/w/check.js': 'some-check\n', 'lib/w/impl.js': 'i\n', 'docs/a.md': 'a\n' }, changed: ['docs/a.md'] })
    t.eq('a module@<name>.mjs manifest names its directory', [worker.verdict, worker.boundary], ['untouched', 'lib/w'])
    t.eq('a longer name is not its declaration', await verdict({ files: { 'modules/service/package.json': '{}\n', 'modules/service/fox.js': 'service-fox-technician-extra\n', 'modules/service/i.js': 'i\n', 'lib/x.js': 'x\n' }, changed: ['lib/x.js'] }), ['unknown', 'not-declared-inside'])
    t.eq('a declaration at the root widens to the whole tree', (await touchOf({ files: { 'x.js': 'service-fox-technician\n', 'lib/y.js': 'y\n' }, changed: ['lib/y.js'] })).verdict, 'touched')
    t.eq('the read budget exhausted: unknown', await verdict({ files: SERVICE, changed: ['docs/service-guide.md'], maxScanBytes: 1 }), ['unknown', 'read-budget'])
    const scanned = await new Promise((resolve) => {
      const root = path.join(os.tmpdir(), `devpanel-empty-name-${process.pid}`)
      const code = `
        import fs from 'node:fs/promises'; import path from 'node:path'; import { parentPort, workerData } from 'node:worker_threads'
        const { scanDeclarations } = await import(workerData.module)
        await fs.mkdir(workerData.root, { recursive: true }); await fs.writeFile(path.join(workerData.root, 'a.txt'), 'abc')
        const scan = await scanDeclarations({ tests: [''], entries: [{ path: 'a.txt', status: 'unchanged', mode: '000644' }], root: workerData.root })
        parentPort.postMessage(scan.declaring.get('').length)`
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`), { workerData: { root, module: pathToFileURL(path.join(CONFIG_ROOT, 'gui/server/runtime/selftest-history.mjs')).href } })
      const timer = setTimeout(() => { worker.terminate(); resolve('hung') }, 5000)
      worker.on('message', (n) => { clearTimeout(timer); worker.terminate(); fs.rm(root, { recursive: true, force: true }).finally(() => resolve(n)) })
      worker.on('error', (e) => { clearTimeout(timer); resolve(e.message) })
    })
    t.eq('auditor-1-008: an empty test name ends the scan and declares nothing', scanned, 0)
    t.eq('too many changed paths: unknown', touchVerdict({ test: TEST, files: [], changed: null }).verdict, 'unknown')
    t.eq('a test name with no segment names no directory', moduleBoundary({ test: 'plain', files: ['plain/package.json'] }).reason, 'no-module-directory')
  }

  t.section('AC8, AC9: which drives made it unstable, and how it expires')
  {
    const pair = [passes({ bytes: 'b', run: 'r1', issue: 'i1', days: 3, revision: 'rev-1' }), fails({ bytes: 'b', run: 'r2', issue: 'i2', days: 2, revision: 'rev-2' })]
    const c = judge(pair)
    t.eq('the evidence names each drive', c.evidence.map((e) => [e.run, e.issue, e.check, e.revision, e.treeIdentity, e.outcome]), [['r1', 'i1', pair[0].dir, 'rev-1', 'b', 'passed'], ['r2', 'i2', pair[1].dir, 'rev-2', 'b', 'failed']])
    t.eq('the window and what ends it are stated', [c.window.days, c.expiresAfterPasses, c.evidenceTotal, c.passesSinceLastFailure], [14, EXPIRY_PASSES, 2, 0])
    t.ok('a long record keeps the latest evidence and says how much there was', (() => { const many = judge(Array.from({ length: 10 }, (_, i) => i % 2 ? passes({ bytes: 'b', days: 10 - i }) : fails({ bytes: 'b', days: 10 - i }))); return many.evidence.length === 6 && many.evidenceTotal === 10 })())

    const clean = Array.from({ length: EXPIRY_PASSES }, (_, i) => passes({ bytes: `clean-${i}`, days: 1 - i * 0.1 }))
    const flaky = [passes({ bytes: 'b', days: 5 }), fails({ bytes: 'b', days: 4 })]
    t.eq('short of the passes it is still unstable', judge([...flaky, ...clean.slice(0, EXPIRY_PASSES - 1)])?.passesSinceLastFailure, EXPIRY_PASSES - 1)
    t.eq('after them a new failure has nothing to pair with and gates', judge([...flaky, ...clean]), null)
    t.eq('and so does the next failure: earlier evidence does not come back', judge([...flaky, ...clean, fails({ bytes: 'b', days: 0.2 })]), null)
    for (const n of [5, 6, 9, 10]) {
      const identical = Array.from({ length: n }, (_, i) => passes({ bytes: 'b', days: 3 - i * 0.1 }))
      t.eq(`auditor-1-004: after ${n} passes on those very bytes a failure still gates`, judge([...flaky, ...identical, fails({ bytes: 'b', days: 1 })]), null)
    }
    t.eq('route 2 evidence expires the same way', judge([newOn('a', 'untouched', { days: 5 }), newOn('b', 'untouched', { days: 4 }), ...clean]), null)
    t.eq('a drive that does not report the test observes nothing', judge([...flaky, ...clean.slice(0, EXPIRY_PASSES - 1), drive({ passed: ['other'], days: 0.1 })])?.routes, ['same-bytes'])
    t.eq('evidence past the window is gone', judge([passes({ bytes: 'b', days: 20 }), fails({ bytes: 'b', days: 15 })]), null)
    t.eq('classifyAll reads the record as it stands', classifyAll(flaky, { now: NOW }).map((u) => [u.command, u.test]), [['collect', TEST]])
  }

  t.section('AC4, AC10, AC12: an unstable failure does not gate; a stable new failure still does')
  {
    const runDir = await tempDir('devpanel-gate-')
    const collected = (tests) => `== runtime/selftest.report\n${JSON.stringify({ tests })}\n`
    const side = async (dir, stdout, passed = true) => {
      await fs.mkdir(path.join(runDir, dir), { recursive: true })
      if (stdout !== null) await fs.writeFile(path.join(runDir, dir, 'collect.stdout'), stdout)
      return { dir, result: passed ? 'passed' : 'failed', sourceRevision: 'base-1', commands: [{ id: 'collect', passed, exitCode: passed ? 0 : 1 }] }
    }
    const target = { commands: [{ id: 'collect', report: 'selftest' }] }
    const run = { workspace: { baseCommit: 'base-1' } }
    const flaky = { test: 'svc/flaky', error: 'x' }
    const stable = { test: 'core/stable', error: 'x' }
    const classifier = (...names) => (command, test) => names.includes(test) ? { routes: ['same-bytes'], evidence: [], evidenceTotal: 2, revisionTouch: { verdict: 'unknown', reason: 'no-module-directory' } } : null
    const base = await side('checks/base', collected([{ test: 'svc/flaky' }, { test: 'core/stable' }, { test: 'worker/inner' }]))
    const candidate = await side('checks/001', collected([flaky, { test: 'core/stable' }]))
    const compare = (over = {}) => compareSelftestReports({ runDir, target, base, candidate, sourceRevision: 'base-1', unstable: classifier('svc/flaky'), ...over })

    const only = await compare()
    t.eq('the verdict is unstable, nothing new', [only.verdict, only.newFailures, only.unstable.map((u) => u.test)], ['unstable', [], ['svc/flaky']])
    t.eq('the entry says the gate ignored it and which comparison it had', [only.unstable[0].ignoredByGate, only.unstable[0].comparedNew, only.unstable[0].revisionTouch.verdict], [true, true, 'unknown'])
    const check = { result: 'passed', baselineComparison: { selftest: only }, commands: [] }
    t.eq('the gate passes', [gatingResult(check, run), gateReason(check, run)], ['passed', null])
    t.eq('an operator is not asked to accept it', identifyCheckFailures(check, run).failures, [])
    t.ok('the comparison\'s instruction says so', /gate ignored/.test(only.instruction))
    t.eq('without history it is a new failure, as before', (await compare({ unstable: null })).newFailures, [{ command: 'collect', test: 'svc/flaky' }])
    t.eq('with no classification of it, likewise', (await compare({ unstable: classifier() })).verdict, 'new-failures')

    const mixedCandidate = await side('checks/002', collected([flaky, stable]))
    const mixed = await compare({ candidate: mixedCandidate })
    t.eq('a stable new failure beside it still gates', [mixed.verdict, mixed.newFailures.map((f) => f.test), mixed.unstable.map((u) => u.test)], ['new-failures', ['core/stable'], ['svc/flaky']])
    t.eq('the gate fails on it alone', gateReason({ result: 'passed', baselineComparison: { selftest: mixed }, commands: [] }, run), 'selftest verdict new-failures: collect: core/stable')

    const knownBase = await side('checks/base2', collected([flaky]))
    const inherited = await compare({ base: knownBase })
    t.eq('a failure the base has too stays inherited', [inherited.verdict, inherited.baselineKnown.map((f) => f.test), inherited.unstable], ['baseline-known', ['svc/flaky'], undefined])

    t.section('AC4: nothing about the base can make it gate')
    const none = await compare({ base: null })
    t.eq('no base', [none.verdict, none.unstable[0].comparedNew, none.unjudged], ['unstable', false, undefined])
    const unavailable = await compare({ base: { result: 'unavailable' } })
    t.eq('a base that could not be checked', unavailable.verdict, 'unstable')
    const stopped = await compare({ base: await side('checks/base3', null, false) })
    t.eq('a base that stopped before its selftests', [stopped.verdict, stopped.baseUnfinished], ['unstable', undefined])
    const unfinishedBase = await side('checks/base4', collected([{ test: 'worker/(suite)', error: 'RPC timed out' }]))
    const unfinished = await compare({ base: unfinishedBase })
    t.eq('a base that did not finish', [unfinished.verdict, unfinished.unstable[0].comparedNew, unfinished.baseUnfinished], ['unstable', false, undefined])
    t.eq('and that is not inconclusive', inconclusiveBase({ result: 'passed', baselineComparison: { selftest: unfinished } }, run), false)
    const stillOpen = await compare({ base: unfinishedBase, candidate: mixedCandidate })
    t.eq('what is left open is still not-made, the ignored one still listed', [stillOpen.verdict, stillOpen.baseUnfinished, stillOpen.unjudged, stillOpen.unstable.map((u) => u.test)], ['not-made', true, [{ command: 'collect', test: 'core/stable' }], ['svc/flaky']])

    t.section('AC4, AC10: a suite-level entry is classified the same way and says tests did not run')
    const suiteCandidate = await side('checks/003', collected([{ test: 'worker/(suite)', error: 'RPC timed out' }, { test: 'svc/flaky' }]))
    const suite = await compare({ candidate: suiteCandidate, unstable: classifier('worker/(suite)') })
    t.eq('it does not gate', [suite.verdict, gatingResult({ result: 'passed', baselineComparison: { selftest: suite } }, run)], ['unstable', 'passed'])
    t.eq('the tests the base passed and this report lacks are named', [suite.unstable[0].level, suite.unstable[0].notObserved], ['suite', { count: 2, sample: ['core/stable', 'worker/inner'] }])
    const suiteWords = checkSummary({ revision: 'r', result: 'passed', baselineComparison: { selftest: suite } }).unstableNote[0]
    t.ok('the report says tests under it did not run', /tests under it did not run, so they were not checked \(2 that passed on the base are missing here/.test(suiteWords), suiteWords)
    const noBase = await compare({ base: null, candidate: suiteCandidate, unstable: classifier('worker/(suite)') })
    t.ok('with no base, how many is unknown', /how many is unknown/.test(checkSummary({ revision: 'r', result: 'passed', baselineComparison: { selftest: noBase } }).unstableNote[0]))

    t.section('AC10: the wording says what is known of the revision')
    const words = (revisionTouch) => checkSummary({ revision: 'r', result: 'passed', baselineComparison: { selftest: { verdict: 'unstable', newFailures: [], unstable: [{ command: 'collect', test: 'svc/flaky', routes: ['same-bytes'], ignoredByGate: true, revisionTouch }] } } }).unstableNote[0]
    t.ok('a touching revision: this change may have caused it', /the gate ignored this failure.*This revision changed its module \(svc\/a\.js\), so this may be a regression caused by this change/.test(words({ verdict: 'touched', matched: ['svc/a.js'] })))
    t.ok('an undecided one: could not be established', /could not be established \(no-manifest\), so it may be a real regression/.test(words({ verdict: 'unknown', reason: 'no-manifest' })))
    t.ok('an untouched one: can still be real', /did not touch its module; it can still be a real regression/.test(words({ verdict: 'untouched' })))
  }

  t.section('AC11: the opt-out')
  {
    const base = { commands: [{ id: 'c', run: 'r' }] }
    const infra = { staging: { ssh: {} }, testDrive: base }
    t.eq('unset, the target is what it was: no target hash moves', [Object.hasOwn(localTarget(base), 'classifyUnstable'), Object.hasOwn(stagingTarget(infra), 'classifyUnstable')], [false, false])
    t.eq('true is the default and changes nothing either', Object.hasOwn(localTarget({ ...base, classifyUnstable: true }), 'classifyUnstable'), false)
    t.eq('false reaches the target of either kind', [localTarget({ ...base, classifyUnstable: false }).classifyUnstable, stagingTarget({ ...infra, testDrive: { ...base, classifyUnstable: false } }).classifyUnstable], [false, false])

    const schema = JSON.parse(await fs.readFile(path.join(CONFIG_ROOT, 'schemas/project.schema.json'), 'utf8'))
    t.ok('the project schema takes it on local checks and the test drive', Boolean(schema.properties.checks.properties.classifyUnstable) && JSON.stringify(schema).includes('"classifyUnstable"'))
    t.ok('AC7: and it holds no list of tests', !/unstable(Tests|List)/i.test(JSON.stringify(schema)))

    const issues = await tempDir('devpanel-optout-')
    const issuePath = path.join(issues, 'proj', 'issue')
    const runDir = path.join(issuePath, 'runs', 'r')
    await fs.mkdir(path.join(runDir, 'checks/001'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'checks/001/collect.stdout'), `== runtime/selftest.report\n${JSON.stringify({ tests: [{ test: TEST, error: 'x' }] })}\n`)
    const check = { dir: 'checks/001', at: new Date(NOW).toISOString(), treeIdentity: 'tree-now', commands: [{ id: 'collect', passed: true }] }
    await recordDrive(historyDir(issuePath), passes({ bytes: 'tree-now', run: 'older' }), { now: NOW })
    const open = (over) => openStability({ issuePath, runId: 'r', target: { commands: [{ id: 'collect', report: 'selftest' }], ...over }, targetKey: 'target-1', clock: { now: () => NOW }, runDir })
    const on = await open({}).prepare({ check, revision: 'rev', fp: { entries: [] }, workspacePath: issuePath, baseCommit: 'b' })
    t.eq('on by default the record classifies it', on('collect', TEST)?.routes, ['same-bytes'])
    const offStability = open({ classifyUnstable: false })
    t.eq('opted out nothing is classified', await offStability.prepare({ check, revision: 'rev', fp: { entries: [] }, workspacePath: issuePath, baseCommit: 'b' }), null)
    await offStability.record({ check, kind: 'candidate', revision: 'rev', baseCommit: 'b', fp: { entries: [] } })
    t.eq('its drives are still recorded', (await readDrives(historyDir(issuePath))).some((d) => d.runId === 'r'), true)

    const noHistory = await tempDir('devpanel-nohistory-')
    const blocked = path.join(noHistory, 'proj', 'issue')
    await fs.mkdir(path.join(noHistory, 'proj'), { recursive: true })
    await fs.writeFile(historyDir(blocked), 'not a directory')
    const unreadable = openStability({ issuePath: blocked, runId: 'r', target: { commands: [{ id: 'collect', report: 'selftest' }] }, targetKey: 't', clock: { now: () => NOW }, runDir })
    t.eq('a history that cannot be read classifies nothing', await unreadable.prepare({ check, revision: 'rev', fp: { entries: [] }, workspacePath: issuePath, baseCommit: 'b' }), null)
    t.ok('and says why', /could not be read/.test(unreadable.unavailable), unreadable.unavailable)
    await unreadable.record({ check, kind: 'candidate', revision: 'rev', baseCommit: 'b', fp: { entries: [] } })
    t.ok('a line that cannot be written fails nothing, and says so', Boolean(unreadable.historyError))
  }

  /*
   * The whole engine on a local `report: selftest` target. The collector reports
   * on the unchanged project (no work.txt) every test passing plus worker/inner;
   * on the candidate the tests named in `failing` fail. The record is seeded so
   * that `seeded` tests are unstable by route 2 in two other issues.
   */
  async function engineRun ({ failing, seeded = failing, confirmRisks = null, target = '', playbookChecks = '', writes = { 'work.txt': 'work\n' }, confirm = () => true, extraCommands = '', collectOverride = null, onRecheck = null, onImplement = null }) {
    const prompts = []
    let engine = null
    const script = async (turn) => {
      const { stepId, role, round, prompt } = turn
      prompts.push({ stepId, role, round, prompt })
      if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
      if (stepId === 'implement') {
        onImplement?.({ engine, round })
        for (const [file, text] of Object.entries(writes)) {
          await fs.mkdir(path.dirname(path.join(engine.run.workspace.path, file)), { recursive: true })
          await fs.writeFile(path.join(engine.run.workspace.path, file), text)
        }
        return fence({ summary: 'Implemented', basedOnRevision: revisionIn(prompt) })
      }
      if (stepId.startsWith('audit-')) {
        const answer = prompt.includes('Re-review of revision') ? onRecheck?.(turn) : null
        return answer ?? fence({ verdict: 'approved', artifactRevision: revisionIn(prompt), findings: [], priorFindings: [] })
      }
      if (stepId === 'confirm') {
        if (!confirm()) return fence({ satisfied: false, criteria: [{ id: 'AC1', met: false, unmet: 'owner-gate', evidence: 'not yet' }], revision: revisionIn(prompt) })
        return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revisionIn(prompt), ...(confirmRisks ? { residualRisks: confirmRisks } : {}) })
      }
      return scriptFor()(turn)
    }
    const f = await engineFixture({ playbook: 'implementation', script })
    const failed = failing.map((test) => `{"test":"${test}","error":"x"}`).join(',')
    const passed = ['core/a', 'worker/inner', ...failing].map((test) => `{"test":"${test}"}`).join(',')
    const collect = collectOverride ?? `if test -f work.txt; then t='${failed}'; else t='${passed}'; fi; echo "== runtime/selftest.report"; printf '{"tests":[%s]}\\n' "$t"`
    await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
      `\nchecks:\n  requirement: required\n${playbookChecks}  target:\n    kind: local\n${target}    commands:\n      - id: collect\n        report: selftest\n        run: ${JSON.stringify(collect)}\n${extraCommands}`)
    const at = new Date(f.clock.now() - DAY).toISOString()
    const dir = historyDir(f.issuePath)
    for (const issue of ['other-issue-a', 'other-issue-b']) {
      await recordDrive(dir, { ...drive({ issue, run: `run-${issue}`, failed: seeded, asNew: seeded.map((test) => [test, 'untouched']), bytes: `tree-${issue}` }), at }, { now: f.clock.now() })
    }
    const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
    const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
    if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
    engine = await startRun({
      expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
      configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
    })
    await engine.drive()
    return { f, engine, prompts, implementTurns: prompts.filter((p) => p.stepId === 'implement').length, events: (await readEvents(f.issuePath, engine.runId)).events }
  }

  t.section('AC4, AC5, AC6, AC10: through the engine, ignored touched, unknown and suite-level failures deliver with no extra round and stay named')
  {
    const risks = [{ description: 'worker/(suite) was ignored by the gate: tests under it did not run', accepted: false }]
    const { f, engine, prompts, implementTurns, events } = await engineRun({
      failing: ['svc/touch-check', 'other/flaky-check', 'worker/(suite)'], writes: { 'work.txt': 'work\n', 'svc/impl.js': 'changed\n' }, confirmRisks: risks,
      playbookChecks: '  concurrent: false\n'
    })
    const run = engine.run
    t.eq('the run completes, delivered', `${run.status} ${run.outcome}`, 'completed resolved', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    t.eq('with no author round beyond the first', implementTurns, 1)
    t.eq('and no second drive', events.filter((e) => e.type === 'checks-retry').length, 0)
    const check = run.checkResults.at(-1)
    const selftest = check.baselineComparison.selftest
    t.eq('the check passed its gate', [check.result, gatingResult(check, run), selftest.verdict, selftest.newFailures], ['passed', 'passed', 'unstable', []])
    const by = Object.fromEntries(selftest.unstable.map((u) => [u.test, u]))
    t.eq('this revision touched one of them', by['svc/touch-check'].revisionTouch.verdict, 'touched')
    t.eq('could not say of another', [by['other/flaky-check'].revisionTouch.verdict, by['other/flaky-check'].revisionTouch.reason], ['unknown', 'no-module-directory'])
    t.eq('and the suite-level one names the tests that did not run', [by['worker/(suite)'].level, by['worker/(suite)'].notObserved.sample], ['suite', ['core/a', 'worker/inner']])
    t.eq('its evidence is the two other issues\' drives, not this one', by['other/flaky-check'].evidence.map((e) => e.issue).sort(), ['other-issue-a', 'other-issue-b'])
    t.eq('closure keeps the record', run.closure.checks.selftest.unstable.map((u) => u.test).sort(), ['other/flaky-check', 'svc/touch-check', 'worker/(suite)'])
    t.eq('closure gating passed', run.closure.checks.gating, 'passed')
    t.eq('the residual risk is on the closure, and did not stop delivery', run.closure.residualRisks.map((r) => r.accepted), [false])

    const confirm = prompts.find((p) => p.stepId === 'confirm').prompt
    t.ok('AC5: the coordinator is told each, and that it is no reason to call a criterion unmet', /selftest\.unstable lists failures the gate ignored/.test(confirm) && /no reason to call a criterion unmet/.test(confirm) && confirm.includes('other/flaky-check'))
    t.ok('and to name those it owes under residualRisks', /Name svc\/touch-check, other\/flaky-check, worker\/\(suite\) under residualRisks/.test(confirm.replace(/\s+/g, ' ')) || /under residualRisks/.test(confirm))
    const audit = prompts.find((p) => p.stepId.startsWith('audit-implement')).prompt
    t.ok('AC5: the auditor reading the drive sees it and the note', audit.includes('other/flaky-check') && audit.includes('unstableNote') && /the gate ignored this failure/.test(audit))

    const explanation = explainRun(run)
    t.ok('AC6: the explanation names each', ['svc/touch-check', 'other/flaky-check', 'worker/(suite)'].every((x) => explanation.detail.includes(x)), explanation.detail)
    t.ok('AC10: and says the gate ignored it', /the gate ignored this failure/.test(explanation.detail) && /this may be a regression caused by this change/.test(explanation.detail))
    t.eq('the headline stays what the run did', explanation.tone, 'success')
    const result = renderResult(run, {})
    t.ok('AC10: the result file says so too', /## Unstable selftests ignored by the gate/.test(result) && result.includes('worker/(suite)'), result.slice(0, 400))
    t.eq('not counted as a regression after approval', runMetrics(run).regressionsAfterApproval, 0)

    const recorded = await readDrives(historyDir(f.issuePath))
    const own = recorded.filter((d) => d.runId === engine.runId)
    t.eq('AC1: this run recorded its candidate and its base', own.map((d) => d.kind).sort(), ['base', 'candidate'])
    t.eq('with the bytes each tested', own.every((d) => /^sha256:/.test(d.treeIdentity)), true)
    t.eq('what it failed as new, with the touch of each', own.find((d) => d.kind === 'candidate').commands[0].asNew.map((n) => [n.test, n.touch.verdict]).sort(), [['other/flaky-check', 'unknown'], ['svc/touch-check', 'touched'], ['worker/(suite)', 'unknown']])
    await releaseWorkspace(engine)
  }

  t.section('AC12: through the engine, a stable test\'s new failure still gates')
  {
    const { engine, implementTurns, events } = await engineRun({ failing: ['core/stable'], seeded: ['something/else'], target: '    retryFailed: 1\n' })
    const check = engine.run.checkResults.at(-1)
    t.eq('its comparison names it new', [check.baselineComparison.selftest.verdict, check.baselineComparison.selftest.newFailures.map((f) => f.test)], ['new-failures', ['core/stable']])
    t.eq('the gate fails it', gatingResult(check, engine.run), 'failed')
    t.ok('it gets its second drive', events.some((e) => e.type === 'checks-retry' && e.reason === 'new-selftest-failures'))
    t.ok('the author is sent back, and the run does not close resolved', implementTurns > 1 && engine.run.outcome !== 'resolved', `${implementTurns} ${engine.run.status} ${engine.run.outcome}`)
    await releaseWorkspace(engine)
  }

  t.section('AC11: through the engine, opted out, the same history gates')
  {
    const { engine, events } = await engineRun({ failing: ['other/flaky-check'], target: '    classifyUnstable: false\n    retryFailed: 1\n' })
    const check = engine.run.checkResults.at(-1)
    t.eq('its new failure gates as it did', [check.baselineComparison.selftest.verdict, check.baselineComparison.selftest.unstable, gatingResult(check, engine.run)], ['new-failures', undefined, 'failed'])
    t.ok('with its second drive', events.some((e) => e.type === 'checks-retry'))
    await releaseWorkspace(engine)
  }

  const auditsOf = (prompts) => prompts.filter((p) => p.stepId.startsWith('audit-'))
  const rereviewed = (prompts) => auditsOf(prompts).filter((p) => p.prompt.includes('Re-review of revision'))
  const replayTurn = (engine) => plan(engine.snapshot, engine.activeSteps(), engine.outputs, { checkResults: engine.checkEvidence() })
  const collectRun = (test) => `if test -f work.txt; then t='{"test":"${test}","error":"x"}'; else t='{"test":"${test}"}'; fi; echo "== runtime/selftest.report"; printf '{"tests":[%s]}\n' "$t"`

  t.section('auditor-1-005 (AC5): a drive after approval reaches the auditor, with no author round')
  {
    const { engine, prompts, implementTurns } = await engineRun({ failing: ['other/flaky-check'], target: '    timing: approved\n' })
    t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason}`)
    t.eq('the author took one turn', implementTurns, 1)
    t.eq('the auditor reviewed, then again once the drive ran, in one round', auditsOf(prompts).map((p) => [p.round, p.prompt.includes('Re-review of revision')]), [[0, false], [0, true]])
    const prompt = rereviewed(prompts)[0].prompt
    t.ok('the prompt names the test and says the gate ignored it', prompt.includes('other/flaky-check') && /the gate ignored/.test(prompt))
    t.ok('and that a listed failure alone is no ground for changes-needed', /A listed failure alone is no ground for changes-needed/.test(prompt))
    const audits = engine.run.steps.filter((s) => s.stepId.startsWith('audit-'))
    const check = engine.run.checkResults.at(-1)
    t.eq('the re-review is keyed by the drive', audits.at(-1).recheckDrive, check.dir)
    t.eq('the approval is the re-review\'s', engine.run.approvals.map((a) => a.step), [audits.at(-1).number])
    t.ok('replay asks for nothing again', replayTurn(engine).kind !== 'turn', replayTurn(engine).kind)
    await releaseWorkspace(engine)
  }

  t.section('auditor-1-009: a notification re-review returning changes-needed takes back that seat\'s earlier approval')
  {
    const finding = { id: 'auditor-1-defect', severity: 'major', blocking: true, description: 'the revision breaks this', criterion: 'AC1', location: 'work.txt:1' }
    let answered = false
    let atNextTurn = null
    const { engine, prompts } = await engineRun({ failing: ['other/flaky-check'], target: '    timing: approved\n',
      writes: { 'work.txt': 'work\n' },
      onRecheck: (turn) => { if (answered) return null; answered = true; return fence({ verdict: 'changes-needed', artifactRevision: revisionIn(turn.prompt), findings: [finding], priorFindings: [] }) },
      onImplement: ({ engine: e, round }) => { if (round === 1 && !atNextTurn) atNextTurn = { approvals: e.run.approvals.map((a) => a.step), outstanding: e.run.outstandingFindings.map((f) => f.id) } } })
    t.ok('the auditor\'s own finding sent the author a round', prompts.some((p) => p.stepId === 'implement' && p.round === 1), JSON.stringify(prompts.map((p) => [p.stepId, p.round])))
    t.eq('its earlier approval no longer counts for that revision', atNextTurn?.approvals, [])
    t.eq('and the finding stands', atNextTurn?.outstanding, ['auditor-1-defect'])
    t.eq('the seat is not asked of that drive again in the next round', rereviewed(prompts).length, 1)
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  }

  t.section('auditor-1-005 (AC5): a drive beside the reviews, and one the audit already read')
  {
    const beside = await engineRun({ failing: ['other/flaky-check'] })
    t.eq('beside the reviews: delivered in one author turn', [`${beside.engine.run.status} ${beside.engine.run.outcome}`, beside.implementTurns], ['completed resolved', 1])
    t.ok('an audit prompt names the test and says the gate ignored it', auditsOf(beside.prompts).some((p) => p.prompt.includes('other/flaky-check') && /the gate ignored/.test(p.prompt)))
    await releaseWorkspace(beside.engine)
    const seen = await engineRun({ failing: ['other/flaky-check'], playbookChecks: '  concurrent: false\n' })
    t.eq('an audit that read the drive gets no re-review', auditsOf(seen.prompts).map((p) => p.prompt.includes('Re-review of revision')), [false])
    t.eq('its step says which drive it read', seen.engine.run.steps.find((s) => s.stepId.startsWith('audit-')).checksSeen, seen.engine.run.checkResults.at(-1).dir)
    await releaseWorkspace(seen.engine)
    const clean = await engineRun({ failing: ['core/stable'], seeded: [], target: '    timing: approved\n' })
    t.eq('a drive that ignored nothing adds no turn', rereviewed(clean.prompts).length, 0)
    await releaseOwnership(clean.engine, { reason: 'test' }).catch(() => {})
  }

  t.section('auditor-1-005 (AC5): smoke and full drives each reach the auditor once')
  {
    const { engine, prompts, implementTurns } = await engineRun({ failing: ['other/flaky-check'], target: '    tiers:\n      smoke: [collect]\n' })
    t.eq('delivered in one author turn', [`${engine.run.status} ${engine.run.outcome}`, implementTurns], ['completed resolved', 1], `${engine.run.blockedReason}`)
    const drives = engine.run.steps.filter((s) => s.recheckDrive).map((s) => s.recheckDrive)
    t.eq('no seat is told of one drive twice', drives.length, new Set(drives).size)
    t.ok('the full drive reached it', drives.includes(engine.run.checkResults.filter((c) => c.tier === 'full').at(-1).dir), JSON.stringify(drives))
    t.ok('and every prompt names the test', rereviewed(prompts).every((p) => p.prompt.includes('other/flaky-check')))
    await releaseWorkspace(engine)
  }

  t.section('auditor-1-005 (AC5): Refresh checks, a different ignored test on a revision already re-reviewed')
  {
    let approve = false
    const { engine, prompts } = await engineRun({ failing: ['other/flaky-check'], seeded: ['other/flaky-check', 'another/flaky-check'], target: '    timing: approved\n', confirm: () => approve })
    t.eq('stopped at closure, the first drive already re-reviewed', [engine.run.blockedReason, rereviewed(prompts).length], ['closure-conditions-unmet', 1])
    const firstDrive = engine.run.steps.find((s) => s.recheckDrive).recheckDrive
    approve = true
    const authorTurns = prompts.filter((p) => p.stepId === 'implement').length
    await engine.refreshClosureChecks({ kind: 'local', commands: [{ id: 'collect', report: 'selftest', run: collectRun('another/flaky-check'), timeoutSeconds: 30 }] })
    await engine.drive()
    t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason}`)
    t.eq('with one more re-review', rereviewed(prompts).length, 2)
    t.ok('naming the new test', rereviewed(prompts)[1].prompt.includes('another/flaky-check'))
    const drives = engine.run.steps.filter((s) => s.recheckDrive).map((s) => s.recheckDrive)
    t.eq('keyed by the new drive, the earlier step untouched', drives, [firstDrive, engine.run.checkResults.at(-1).dir])
    t.eq('no author round', prompts.filter((p) => p.stepId === 'implement').length, authorTurns)
    t.ok('replay asks for nothing again', replayTurn(engine).kind !== 'turn', replayTurn(engine).kind)
    await releaseWorkspace(engine)
  }

  t.section('auditor-1-005 (AC5): Refresh checks that ignored nothing adds no audit')
  {
    let approve = false
    const { engine, prompts } = await engineRun({ failing: ['other/flaky-check'], target: '    timing: approved\n', confirm: () => approve })
    approve = true
    const audits = auditsOf(prompts).length
    await engine.refreshClosureChecks({ kind: 'local', commands: [{ id: 'verified', run: 'echo verified', timeoutSeconds: 10 }] })
    await engine.drive()
    t.eq('delivered with no added audit', [engine.run.status, auditsOf(prompts).length], ['completed', audits], `${engine.run.blockedReason}`)
    await releaseWorkspace(engine)
  }

  t.section('auditor-1-005: an open check acceptance waits for the turn and is not refused by it')
  {
    const { engine, prompts } = await engineRun({ failing: ['other/flaky-check'], target: '    timing: approved\n    retryFailed: 0\n', extraCommands: '      - id: flaky\n        run: test ! -f work.txt\n' })
    t.eq('stopped by its own failed command', engine.run.blockedReason, 'checks-failed-unchanged')
    // A drive no audit read: the run's own audits read it in the round the author answered.
    for (const s of engine.run.steps) delete s.checksSeen
    const before = rereviewed(prompts).length
    await engine.acceptCheckResult({ failures: ['flaky'], reason: 'unrelated', revision: engine.run.revisions.at(-1).fingerprint, actor: 'alice' })
    await engine.drive()
    t.eq('the auditor was told', rereviewed(prompts).length, before + 1)
    t.eq('the acceptance went on', [engine.run.closure?.acceptedCheckRisk?.failures.map((f) => f.key), engine.run.closure?.checkAcceptanceRefusal ?? null, engine.run.checkAcceptanceRefusal ?? null], [['flaky'], null, null], `${engine.run.status} ${engine.run.blockedReason}`)
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  }

  /*
   * A reconcile: the author fixes server.mjs, someone else changes it in the checkout, so delivery
   * refuses for drift on its own path. The collector fails `failing` only on the merge of both.
   * `onNotice(turn)` answers the auditor on the merged drive; unset, it approves.
   */
  const serverLines = (edit = {}) => Array.from({ length: 10 }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
  async function reconcileRun ({ failing = 'core/merge-only', seeded = true, onNotice = null } = {}) {
    const prompts = []
    let engine = null
    const script = async (turn) => {
      const { stepId, round, prompt } = turn
      prompts.push({ stepId, round, prompt })
      if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
      if (stepId === 'implement') {
        await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), serverLines({ 9: 'line 9 fixed' }))
        // Drift delivery never merges on its own (a mode change on a path the patch edits always conflicts,
        // execution-contract.md "Merging with manual edits"), and that is no text conflict the engine would
        // return to the author: the run blocks, and only a reconcile carries the patch onto it.
        await fs.chmod(path.join(f.projectPath, 'server.mjs'), 0o755)
        return fence({ summary: 'Implemented', basedOnRevision: revisionIn(prompt) })
      }
      if (stepId.startsWith('audit-')) {
        if (prompt.includes('Re-review of revision') && onNotice) return onNotice({ turn, engine, approved: fence({ verdict: 'approved', artifactRevision: revisionIn(prompt), findings: [], priorFindings: [] }) })
        return fence({ verdict: 'approved', artifactRevision: revisionIn(prompt), findings: [], priorFindings: [] })
      }
      if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revisionIn(prompt) })
      return scriptFor()(turn)
    }
    const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script })
    await fs.writeFile(path.join(f.projectPath, 'server.mjs'), serverLines())
    await exec('git', ['-C', f.projectPath, 'add', '-A'])
    await exec('git', ['-C', f.projectPath, 'commit', '-qm', 'source'])
    const collect = `t='{"test":"core/a"}'; if ${failing ? 'grep -q fixed server.mjs && test -x server.mjs' : 'false'}; then t="$t"',{"test":"${failing}","error":"x"}'; fi; echo "== runtime/selftest.report"; printf '{"tests":[%s]}\n' "$t"`
    await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
      `\nchecks:\n  requirement: required\n  concurrent: false\n  target:\n    kind: local\n    retryFailed: 0\n    commands:\n      - id: collect\n        report: selftest\n        run: ${JSON.stringify(collect)}\n`)
    const dir = historyDir(f.issuePath)
    const at = new Date(f.clock.now() - DAY).toISOString()
    for (const issue of seeded && failing ? ['other-issue-a', 'other-issue-b'] : []) {
      await recordDrive(dir, { ...drive({ issue, run: `run-${issue}`, failed: [failing], asNew: [[failing, 'untouched']], bytes: `tree-${issue}` }), at }, { now: f.clock.now() })
    }
    const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
    const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
    if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
    engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider: worktreeDiffDelivery, expectConfigHash: resolved.resolved.configHash, runOptions: options })
    await engine.drive()
    const before = { status: engine.run.status, blockedReason: engine.run.blockedReason, audits: auditsOf(prompts).length, approvals: engine.run.approvals.length }
    return { f, engine, prompts, before }
  }
  const standsAsBefore = (t, engine, before, label) => {
    t.eq(`${label}: the run stands blocked as it was`, [engine.run.status, engine.run.blockedReason], [before.status, before.blockedReason])
    t.eq(`${label}: nothing carried`, [engine.run.approvals.length, engine.run.approvals.some((a) => a.reconciledFrom), engine.run.revisions.some((r) => r.reconciledFrom)], [before.approvals, false, false])
  }

  t.section('auditor-1-005 (AC5): a reconcile drive reaches the auditor before delivery')
  {
    const { f, engine, prompts, before } = await reconcileRun()
    t.eq('delivery refused for drift, as it would be', before.blockedReason, 'source-delivery-blocked')
    await engine.reconcileDelivery({ policy: {} })
    const attempt = engine.run.reconciliations.at(-1)
    t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${JSON.stringify(attempt.error ?? attempt.state)}`)
    t.eq('with no author round', prompts.filter((p) => p.stepId === 'implement').length, 1)
    const notice = rereviewed(prompts)
    t.eq('one turn for the seat', notice.length, 1)
    t.ok('naming the test, that the gate ignored it, and the merged paths', notice[0].prompt.includes('core/merge-only') && /the gate ignored/.test(notice[0].prompt) && notice[0].prompt.includes('Merged paths: server.mjs'))
    const patch = path.join(f.issuePath, 'runs', engine.runId, 'evidence', 'reconcile', '1', 'merged.patch')
    t.ok('and the patch it can read', notice[0].prompt.includes(patch) && (await fs.readFile(patch, 'utf8')).includes('fixed'))
    const step = engine.run.steps.find((s) => s.reconcileNotice)
    t.eq('the step is the reconcile\'s, keyed by the drive', [step.reconcileNotice, step.recheckDrive], [1, attempt.checks.dir])
    t.ok('the approvals were carried as ever', engine.run.approvals.some((a) => a.reconciledFrom))
    t.ok('the explanation names it', explainRun(engine.run).detail.includes('core/merge-only'), explainRun(engine.run).detail)
    t.ok('replay asks for nothing again', replayTurn(engine).kind !== 'turn', replayTurn(engine).kind)
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  }

  t.section('auditor-1-005: a reconcile drive that ignored nothing adds no turn')
  {
    const { engine, prompts, before } = await reconcileRun({ failing: 'core/merge-only', seeded: false })
    await engine.reconcileDelivery({ policy: {} })
    t.eq('its new failure gates, as any other, with no audit', [engine.run.reconciliations.at(-1).state, auditsOf(prompts).length], ['revalidation-failed', before.audits])
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  }

  t.section('auditor-1-005: a reconcile drive with no failure at all delivers with no added audit')
  {
    const { engine, prompts, before } = await reconcileRun({ failing: null })
    await engine.reconcileDelivery({ policy: {} })
    t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${engine.run.reconciliations.at(-1).error ?? ''}`)
    t.eq('with no audit step added', [auditsOf(prompts).length, engine.run.steps.some((s) => s.reconcileNotice)], [before.audits, false])
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  }

  t.section('auditor-1-005: every way the turn can end short refuses the attempt, with the block restored')
  {
    const finding = { id: 'auditor-1-merge', severity: 'major', blocking: true, description: 'the merge drops the fix', criterion: 'AC1', location: 'server.mjs:2' }
    const found = await reconcileRun({ onNotice: ({ turn }) => fence({ verdict: 'changes-needed', artifactRevision: revisionIn(turn.prompt), findings: [finding], priorFindings: [] }) })
    await found.engine.reconcileDelivery({ policy: {} })
    t.eq('an auditor\'s finding refuses it, naming the finding', [found.engine.run.reconciliations.at(-1).state, /the merge drops the fix/.test(found.engine.run.reconciliations.at(-1).error)], ['auditor-finding', true])
    standsAsBefore(t, found.engine, found.before, 'a finding')
    t.eq('no author round', found.prompts.filter((p) => p.stepId === 'implement').length, 1)
    t.ok('nothing delivered, and Reconcile still offered', supportedActions(found.engine.run).includes('reconcile-delivery'), supportedActions(found.engine.run).join(' '))
    await releaseOwnership(found.engine, { reason: 'test' }).catch(() => {})

    const garbled = await reconcileRun({ onNotice: () => 'no structured output here' })
    await garbled.engine.reconcileDelivery({ policy: {} })
    t.eq('a protocol block refuses it', garbled.engine.run.reconciliations.at(-1).state, 'notice-unfinished')
    standsAsBefore(t, garbled.engine, garbled.before, 'a protocol block')
    await releaseOwnership(garbled.engine, { reason: 'test' }).catch(() => {})

    const failing = await reconcileRun({ onNotice: () => { throw new Error('the runtime fell over') } })
    await failing.engine.reconcileDelivery({ policy: {} })
    t.eq('a failed turn refuses it', [failing.engine.run.reconciliations.at(-1).state, /the runtime fell over/.test(failing.engine.run.reconciliations.at(-1).error)], ['notice-failed', true])
    standsAsBefore(t, failing.engine, failing.before, 'a failed turn')
    t.eq('and leaves no failure on the run', failing.engine.run.failure ?? null, null)
    await releaseOwnership(failing.engine, { reason: 'test' }).catch(() => {})

    const cancelled = await reconcileRun({ onNotice: ({ engine, approved }) => { engine.controller.abort(); return approved } })
    await cancelled.engine.reconcileDelivery({ policy: {} })
    t.ok('a cancelled turn refuses it', ['notice-unfinished', 'notice-failed'].includes(cancelled.engine.run.reconciliations.at(-1).state), cancelled.engine.run.reconciliations.at(-1).state)
    standsAsBefore(t, cancelled.engine, cancelled.before, 'a cancelled turn')
    await releaseOwnership(cancelled.engine, { reason: 'test' }).catch(() => {})

    const held = await reconcileRun({ onNotice: ({ engine, approved }) => { engine.run.cleanup = { entries: [{ role: 'auditor-1', tag: 'tag', reason: 'unproved' }] }; return approved } })
    await held.engine.reconcileDelivery({ policy: {} })
    t.eq('a cleanup hold refuses it', held.engine.run.reconciliations.at(-1).state, 'notice-unfinished')
    standsAsBefore(t, held.engine, held.before, 'a cleanup hold')
    await releaseOwnership(held.engine, { reason: 'test' }).catch(() => {})
  }

  t.section('auditor-1-007 (AC1): an unfinished base replaced by its redrive stays on the record')
  {
    const marker = path.join(await tempDir('devpanel-redrive-'), 'stopped-early')
    const collect = `if ! test -f work.txt && ! test -f ${marker}; then touch ${marker}; t='{"test":"worker/(suite)","error":"RPC timed out"},{"test":"core/finished"}'; elif test -f work.txt; then t='{"test":"svc/new-check","error":"x"},{"test":"core/finished"}'; else t='{"test":"core/finished"},{"test":"svc/new-check"}'; fi; echo "== runtime/selftest.report"; printf '{"tests":[%s]}\\n' "$t"`
    const { f, engine } = await engineRun({ failing: ['svc/new-check'], seeded: [], collectOverride: collect })
    t.eq('the unfinished base is kept and a second was driven', engine.run.baselineChecks.map((b) => Boolean(b.unfinished)), [true, false])
    const bases = (await readDrives(historyDir(f.issuePath))).filter((d) => d.runId === engine.runId && d.kind === 'base')
    t.eq('two base lines, the first unfinished', bases.map((b) => b.unfinished ?? false), [true, false])
    t.ok('with what its finished suites reported', bases[0].commands[0].passed.includes('core/finished') && bases[0].commands[0].failed.includes('worker/(suite)'))
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
  }

  // Last, and guarded: in a seat whose children print nothing through a pipe (report 015's did, hello-world included)
  // a parse here would end the suite before everything above. That is a skip, never a pass.
  t.section('AC1, AC8: the tool reads the record')
  {
    const probe = await exec(process.execPath, ['-e', 'console.log("hello")']).then((r) => r.stdout, () => '')
    if (probe.trim() !== 'hello') t.skip('the history tool through a child process', `a child Node printed ${JSON.stringify(probe)} through a pipe in this environment`)
    else {
        const projects = await tempDir('devpanel-tool-')
        const history = path.join(projects, 'proj', '.selftest-history')
        const recent = (days) => new Date(Date.now() - days * DAY).toISOString()
        await recordDrive(history, { ...passes({ run: 'r1', bytes: 'same' }), at: recent(2) }, { now: Date.now() })
        await recordDrive(history, { ...fails({ run: 'r2', bytes: 'same' }), at: recent(1) }, { now: Date.now() })
        const tool = path.join(CONFIG_ROOT, 'gui', 'tools', 'selftest-history.mjs')
        const env = { ...process.env, DEVPANEL_ISSUES_DIR: projects }
        const one = JSON.parse((await exec(process.execPath, [tool, '--project', 'proj', '--test', TEST], { env })).stdout)
        t.eq('the tool reads one test\'s drives', one.drives.map((d) => d.outcome), ['passed', 'failed'])
        t.eq('and its classification, naming the drives', one.classification[0].unstable.evidence.map((e) => e.run), ['r1', 'r2'])
        const all = JSON.parse((await exec(process.execPath, [tool, '--project', 'proj'], { env })).stdout)
        t.eq('without a test it lists what reads as unstable', all.unstable.map((u) => u.test), [TEST])
        t.ok('a mistyped flag is refused', await exec(process.execPath, [tool, '--project', 'proj', '--tset', 'x'], { env }).then(() => false, (e) => e.code === 2))
    }
  }

  for (const d of temps) await fs.rm(d, { recursive: true, force: true })
}
