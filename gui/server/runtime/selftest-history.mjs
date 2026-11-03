import fs from 'node:fs/promises'
import path from 'node:path'

import { isSelftestReport, isSuiteLevel, passedSelftests, failedSelftests, readReport, selftestStates } from './baseline-failures.mjs'

/*
 * Unstable selftests, from recorded drives (execution-contract.md "Unstable
 * selftests"). The comparison with the base judges one drive; this remembers
 * across revisions and runs. Nobody keeps a list: each drive of a target with a
 * selftest report leaves one line in issues/<project>/.selftest-history/<runId>.jsonl
 * (outside the issue, so packing an issue leaves it readable), and a test is
 * classified by reading those lines:
 *
 *   same-bytes            within the period it passed and failed on one tree
 *                         (treeIdentity + targetKey), the current failure included
 *   unrelated-revisions   it failed as new on revisions proved not to touch its
 *                         module, in OTHER_ISSUES issues other than the current one:
 *                         a run's own regression must not classify itself
 *
 * The window is WINDOW_DAYS. EXPIRY_PASSES consecutive observed passes end a period
 * and discard everything before them, so a new failure then has nothing to pair
 * with and gates. A drive that does not report a test, or skips it, observes nothing.
 *
 * Whether a revision touched a test's module is `touched`, `untouched` or `unknown`,
 * and only `untouched` is route evidence. It needs an established boundary:
 *
 *   report     a `module` the tester states beside the test, a relative directory
 *   manifest   exactly one directory that holds a manifest (package.json or
 *              module@<name>.mjs), is named by the test name's first segment (its
 *              own name, or the manifest's <name>), declares the test in a file
 *              inside it, and is not test-only
 *
 * A directory merely named like the test, and the directory of any file declaring
 * it, only widen a module: a change there is `touched`, a change elsewhere proves
 * nothing. The boundary is the test's own module, not what that module uses.
 */
export const WINDOW_DAYS = 14
export const EXPIRY_PASSES = 5
export const OTHER_ISSUES = 2
const PRUNE_DAYS = 30
const MAX_CHANGED_PATHS = 5000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_SCAN_BYTES = 512 * 1024 * 1024
const MAX_EVIDENCE = 6
const MIN_NEEDLE = 4
const DAY_MS = 86400000

const MANIFEST = /^(?:package\.json|module@(.+)\.mjs)$/
const TEST_ONLY_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'e2e', 'selftest'])
const NAME_CHAR = /[A-Za-z0-9_-]/

export const historyDir = (issuePath) => path.join(path.dirname(issuePath), '.selftest-history')
const runFile = (dir, runId) => path.join(dir, `${runId}.jsonl`)

/** The drives of a project's ledger, oldest first, each once. A torn line is skipped; an unreadable directory throws. */
export async function readDrives (dir) {
  let names
  try { names = await fs.readdir(dir) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const byId = new Map()
  for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of (await fs.readFile(path.join(dir, name), 'utf8')).split('\n')) {
      if (!line) continue
      let drive
      try { drive = JSON.parse(line) } catch { continue }
      if (drive?.id && !byId.has(drive.id)) byId.set(drive.id, drive)
    }
  }
  return [...byId.values()].sort(inOrder)
}

const inOrder = (a, b) => Date.parse(a.at) - Date.parse(b.at) || String(a.id).localeCompare(String(b.id))

/** Append one drive; a file whose every drive is past PRUNE_DAYS goes. */
export async function recordDrive (dir, line, { now }) {
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(runFile(dir, line.runId), `${JSON.stringify(line)}\n`)
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl') && n !== `${line.runId}.jsonl`)) {
    const file = path.join(dir, name)
    const times = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return Date.parse(JSON.parse(l).at) } catch { return NaN } })
    if (times.every((t) => !(now - t <= PRUNE_DAYS * DAY_MS))) await fs.rm(file, { force: true })
  }
}

/** A deleted run's evidence leaves with it (supervisor.deleteRun). */
export const forgetRunDrives = (issuePath, runId) => fs.rm(runFile(historyDir(issuePath), runId), { force: true })

const inside = (file, dir) => dir === '' || file === dir || file.startsWith(`${dir}/`)
const dirOf = (file) => { const d = path.posix.dirname(file); return d === '.' ? '' : d }
const validModule = (value) => typeof value === 'string' && value !== '' && !path.posix.isAbsolute(value) && !value.split('/').some((s) => ['', '.', '..'].includes(s))

/** What the changed paths of a fingerprint hold, or null when there are too many to judge by. */
export function changedPaths (entries, { limit = MAX_CHANGED_PATHS } = {}) {
  const changed = (entries ?? []).filter((e) => e.status !== 'unchanged').map((e) => e.path)
  return changed.length > limit ? null : changed
}

function declares (content, needle) {
  if (!needle) return false
  for (let at = content.indexOf(needle); at >= 0; at = content.indexOf(needle, at + 1)) {
    const [before, after] = [content[at - 1] ?? '', content[at + needle.length] ?? '']
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true
  }
  return false
}

const needlesOf = (test) => {
  const last = test.split('/').at(-1)
  return (last !== test && last.length >= MIN_NEEDLE ? [test, last] : [test]).filter(Boolean)
}

/**
 * The files of the tree declaring each test: `{ declaring: Map(test -> paths) }`, or
 * `{ incomplete }` naming why the tree could not be read whole. Links are never
 * followed; a binary or oversized file declares nothing. Each file is read once.
 */
export async function scanDeclarations ({ tests, entries, root, maxScanBytes = MAX_SCAN_BYTES }) {
  const declaring = new Map(tests.map((t) => [t, []]))
  const needles = tests.map((t) => [t, needlesOf(t)])
  let spent = 0
  for (const entry of entries ?? []) {
    if (entry.status === 'deleted' || entry.mode === 'link') continue
    const file = path.join(root, entry.path)
    try {
      const { size } = await fs.stat(file)
      if (size > MAX_FILE_BYTES) continue
      spent += size
      if (spent > maxScanBytes) return { incomplete: 'read-budget' }
      const bytes = await fs.readFile(file)
      if (bytes.includes(0)) continue
      const content = bytes.toString('utf8')
      for (const [test, list] of needles) if (list.some((n) => declares(content, n))) declaring.get(test).push(entry.path)
    } catch { return { incomplete: 'unreadable-file' } }
  }
  return { declaring }
}

/**
 * The boundary of a test from the tree alone: `{ boundary }`, or `{ reason }` saying
 * which part of section "manifest" above fails, and always `widenedBy`, the
 * directories a change in which counts as touching it whether or not one was found.
 */
export function moduleBoundary ({ test, files, declaring = [] }) {
  const first = test.includes('/') ? test.split('/')[0] : null
  const directories = new Set()
  for (const file of files) for (let d = dirOf(file); d !== ''; d = dirOf(d)) directories.add(d)
  const manifests = new Map()
  for (const file of files.filter((f) => MANIFEST.test(path.posix.basename(f)))) manifests.set(dirOf(file), [...(manifests.get(dirOf(file)) ?? []), file])
  const manifestsIn = (dir) => manifests.get(dir) ?? []
  const named = first === null ? [] : [...directories].filter((d) => path.posix.basename(d) === first)
  const namedByManifest = first === null ? [] : [...manifests].filter(([d, list]) => d !== '' && list.some((f) => MANIFEST.exec(path.posix.basename(f))[1] === first)).map(([d]) => d)
  const candidates = [...new Set([...named, ...namedByManifest])]
  const widenedBy = [...new Set([...named, ...declaring.map(dirOf)])].sort()
  if (!candidates.length) return { reason: 'no-module-directory', widenedBy }
  const withManifest = candidates.filter((d) => manifestsIn(d).length)
  if (!withManifest.length) return { reason: 'no-manifest', widenedBy }
  const declaredInside = withManifest.filter((d) => declaring.some((f) => inside(f, d)))
  if (!declaredInside.length) return { reason: 'not-declared-inside', widenedBy }
  const unit = declaredInside.filter((d) => {
    if (TEST_ONLY_DIRS.has(path.posix.basename(d))) return false
    const set = new Set([...manifestsIn(d), ...declaring])
    return files.some((f) => inside(f, d) && !set.has(f))
  })
  if (!unit.length) return { reason: 'test-only', widenedBy }
  if (unit.length > 1) return { reason: 'ambiguous', widenedBy }
  return { boundary: unit[0], widenedBy }
}

/**
 * Whether a revision touched a test's module, from its changed paths (null: too
 * many to judge by). `module` is what the report stated, if anything.
 */
export function touchVerdict ({ test, module = null, files, declaring = [], changed, incomplete = null }) {
  const unknown = (reason, extra = {}) => ({ verdict: 'unknown', source: null, boundary: null, widenedBy: [], matched: [], reason, ...extra })
  if (changed === null) return unknown('too-many-paths')
  const matchedIn = (dirs) => changed.filter((f) => dirs.some((d) => inside(f, d))).slice(0, 5)
  if (validModule(module)) {
    if (!files.some((f) => f.startsWith(`${module}/`))) return unknown('report-module-missing')
    const matched = matchedIn([module])
    return { verdict: matched.length ? 'touched' : 'untouched', source: 'report', boundary: module, widenedBy: [], matched, reason: null }
  }
  if (incomplete) return unknown(incomplete)
  const { boundary = null, reason = null, widenedBy } = moduleBoundary({ test, files, declaring })
  const matched = matchedIn([...(boundary === null ? [] : [boundary]), ...widenedBy])
  if (matched.length) return { verdict: 'touched', source: boundary === null ? null : 'manifest', boundary, widenedBy, matched, reason }
  if (boundary === null) return unknown(reason, { widenedBy })
  return { verdict: 'untouched', source: 'manifest', boundary, widenedBy, matched, reason: null }
}

/** How a drive saw one test: 'pass', 'fail', or null when it observed nothing. */
function outcome (drive, command, test) {
  const c = (drive.commands ?? []).find((x) => x.command === command)
  if (!c) return null
  return c.failed?.includes(test) ? 'fail' : c.passed?.includes(test) ? 'pass' : null
}

const evidenceOf = (drive, command, test, result) => {
  const touch = (drive.commands ?? []).find((x) => x.command === command)?.asNew?.find((n) => n.test === test)?.touch
  return { run: drive.runId, issue: drive.issueId, check: drive.dir, kind: drive.kind, revision: drive.revision ?? null, treeIdentity: drive.treeIdentity ?? null, at: drive.at, outcome: result === 'fail' ? 'failed' : 'passed', ...(touch ? { touch: touch.verdict } : {}) }
}

/**
 * What the drives say of one test now. `current` is the failing drive being judged,
 * or null to read the record as it stands: the classification with its evidence
 * and how many passes followed the last failure, or null when it is not unstable.
 */
export function classifyTest ({ drives, command, test, current = null, issueId = null, now }) {
  const since = now - WINDOW_DAYS * DAY_MS
  let period = []
  let streak = 0
  for (const drive of drives) {
    if (!(Date.parse(drive.at) >= since)) continue
    const result = outcome(drive, command, test)
    if (!result) continue
    period.push({ drive, result })
    streak = result === 'pass' ? streak + 1 : 0
    // The streak runs on: every further pass keeps the period clear until a failure ends it.
    if (streak >= EXPIRY_PASSES) period = []
  }
  const passesSinceLastFailure = streak
  if (current) period.push({ drive: current, result: 'fail' })

  const pairs = new Map()
  for (const p of period) {
    if (!p.drive.treeIdentity) continue
    const key = `${p.drive.treeIdentity} ${p.drive.targetKey}`
    pairs.set(key, [...(pairs.get(key) ?? []), p])
  }
  const sameBytes = [...pairs.values()].filter((list) => list.some((p) => p.result === 'pass') && list.some((p) => p.result === 'fail')).flat()

  const unrelated = period.filter((p) => p.result === 'fail' && p.drive.issueId !== issueId &&
    (p.drive.commands ?? []).find((c) => c.command === command)?.asNew?.some((n) => n.test === test && n.touch?.verdict === 'untouched'))
  const issues = new Set(unrelated.map((p) => p.drive.issueId))
  const routes = [...(sameBytes.length ? ['same-bytes'] : []), ...(issues.size >= OTHER_ISSUES ? ['unrelated-revisions'] : [])]
  if (!routes.length) return null
  const evidence = [...(routes.includes('same-bytes') ? sameBytes : []), ...(routes.includes('unrelated-revisions') ? unrelated : [])]
    .filter((p, i, all) => all.findIndex((x) => x.drive.id === p.drive.id) === i).sort((a, b) => inOrder(a.drive, b.drive))
  return { routes, evidence: evidence.slice(-MAX_EVIDENCE).map((p) => evidenceOf(p.drive, command, test, p.result)), evidenceTotal: evidence.length, passesSinceLastFailure,
    window: { days: WINDOW_DAYS, since: new Date(since).toISOString() }, expiresAfterPasses: EXPIRY_PASSES }
}

/** Every test the ledger currently classifies as unstable, by command. */
export function classifyAll (drives, { now }) {
  const tests = new Set()
  for (const d of drives) for (const c of d.commands ?? []) for (const t of c.failed ?? []) tests.add(JSON.stringify([c.command, t]))
  return [...tests].map((k) => JSON.parse(k)).flatMap(([command, test]) => {
    const classification = classifyTest({ drives, command, test, now })
    return classification ? [{ command, test, ...classification }] : []
  })
}

async function readOutcomes ({ runDir, check, target }) {
  const declared = [...(target?.commands ?? []), ...(target?.finallyCommands ?? [])].filter((c) => isSelftestReport(c.report))
  const out = []
  for (const { id } of declared) {
    const r = await readReport(runDir, check, id)
    if (r.report) out.push({ command: id, failed: failedSelftests(r.report), passed: passedSelftests(r.report), modules: selftestStates(r.report).modules })
  }
  return out
}

/**
 * The ledger as one check sees it. `prepare` reads a drive's report and answers for
 * its failures (`classifier(command, test)`, null when opted out or when the
 * history cannot be read: then nothing is classified and failures gate, and
 * `unavailable` says why). `record` writes a drive and keeps it in view, so a retry
 * pairs with the first drive. Neither ever fails a check.
 */
export function openStability ({ issuePath, runId, target, targetKey, clock, runDir }) {
  const reports = [...(target?.commands ?? []), ...(target?.finallyCommands ?? [])].some((c) => isSelftestReport(c.report))
  const dir = historyDir(issuePath)
  const issueId = path.basename(issuePath)
  let drives = null
  const stability = {
    unavailable: null,
    historyError: null,
    touches: new Map(),
    async prepare ({ check, revision, fp, workspacePath, baseCommit }) {
      if (!reports) return null
      let failed
      try {
        const outcomes = await readOutcomes({ runDir, check, target })
        failed = [...new Set(outcomes.flatMap((o) => o.failed))]
        if (failed.length) {
          const entries = fp?.entries ?? []
          const files = entries.filter((e) => e.status !== 'deleted').map((e) => e.path)
          const changed = fp ? changedPaths(entries) : null
          const unstated = failed.filter((test) => !validModule(outcomes.find((o) => o.modules.has(test))?.modules.get(test)))
          const scan = unstated.length ? await scanDeclarations({ tests: unstated, entries, root: workspacePath }) : { declaring: new Map() }
          for (const o of outcomes) {
            for (const test of o.failed) {
              stability.touches.set(`${check.dir} ${o.command} ${test}`, touchVerdict({ test, module: o.modules.get(test) ?? null, files, declaring: scan.declaring?.get(test) ?? [], changed, incomplete: scan.incomplete ?? null }))
            }
          }
        }
      } catch (error) {
        stability.unavailable = `the drive's report could not be judged: ${error.message}`
        return null
      }
      if (!failed.length || target?.classifyUnstable === false) return null
      try { drives ??= await readDrives(dir) } catch (error) {
        stability.unavailable = `the selftest history could not be read: ${error.message}`
        return null
      }
      const current = { id: `${runId}:current:${check.dir}`, at: check.at, runId, issueId, kind: 'candidate', dir: check.dir, revision, baseCommit, treeIdentity: check.treeIdentity ?? null, targetKey }
      const now = clock.now()
      return (command, test) => {
        const classification = classifyTest({ drives, command, test, current, issueId, now })
        return classification ? { ...classification, revisionTouch: stability.touches.get(`${check.dir} ${command} ${test}`) ?? null } : null
      }
    },
    /** `selftest` is this drive's comparison, for what it failed as new. A drive with no readable report leaves no line. */
    async record ({ check, kind, revision = null, baseCommit, fp = null, selftest = null, treeIdentity = null }) {
      if (!reports) return
      try {
        // A report carried from the smoke (checks.mjs `fromSmoke`) is the smoke's
        // execution, already on the ledger: one run of a test is one line.
        const outcomes = await readOutcomes({ runDir, check: { ...check, commands: (check.commands ?? []).filter((c) => !c.fromSmoke) }, target })
        if (!outcomes.length) return
        const asNew = [...(selftest?.newFailures ?? []), ...(selftest?.unstable ?? []).filter((u) => u.comparedNew)]
        const origin = check.reused?.fromRun ?? runId
        const from = check.reused?.fromDir ?? check.dir
        const id = kind === 'base' ? `${origin}:base:${baseCommit}:${check.at}:${from}` : `${origin}:candidate:${revision}:${check.at}:${from}`
        const line = { id, at: check.at, runId, issueId, kind, treeIdentity: check.treeIdentity ?? treeIdentity, targetKey, revision, baseCommit, tier: target?.tier ?? null, dir: check.dir,
          ...(check.reused ? { reused: { fromRun: check.reused.fromRun, key: check.reused.key } } : {}), ...(check.unfinished ? { unfinished: true } : {}),
          changedPaths: fp ? changedPaths(fp.entries) : null,
          commands: outcomes.map((o) => ({ command: o.command, failed: o.failed, passed: o.passed,
            asNew: asNew.filter((f) => f.command === o.command).map((f) => ({ test: f.test, touch: stability.touches.get(`${check.dir} ${o.command} ${f.test}`) ?? null })) })) }
        if (drives && !drives.some((d) => d.id === id)) { drives.push(line); drives.sort(inOrder) }
        await recordDrive(dir, line, { now: clock.now() })
      } catch (error) { stability.historyError = error.message }
    }
  }
  return stability
}

/** The failures the gate ignored on what closure counted, else on the latest check of the last revision. */
export function ignoredSelftests (run) {
  const closing = run?.closure?.checks?.selftest
  if (closing) return closing.unstable ?? []
  const revision = run?.revisions?.at(-1)?.fingerprint
  const check = (run?.checkResults ?? []).filter((c) => c.revision === revision && c.tier !== 'smoke').at(-1)
  return check?.baselineComparison?.selftest?.unstable ?? []
}

/** What the record says of one ignored failure, for people and seats. */
export function ignoredWords (entry) {
  const name = `${entry.command}: ${entry.test}`
  const touch = entry.revisionTouch
  const about = touch?.verdict === 'touched' ? `This revision changed its module (${touch.matched?.join(', ')}), so this may be a regression caused by this change.`
    : touch?.verdict === 'untouched' ? 'This revision did not touch its module; it can still be a real regression.'
      : `Whether this revision touched its module could not be established${touch?.reason ? ` (${touch.reason})` : ''}, so it may be a real regression.`
  const unrun = entry.level === 'suite'
    ? ` The gate ignored a suite or thread entry: tests under it did not run, so they were not checked${entry.notObserved ? ` (${entry.notObserved.count} that passed on the base are missing here${entry.notObserved.sample?.length ? `, e.g. ${entry.notObserved.sample.slice(0, 3).join(', ')}` : ''})` : '; how many is unknown'}.`
    : ''
  return `${name}: the gate ignored this failure because recorded drives classify the test as unstable (${(entry.routes ?? []).join(', ')}). ${about}${unrun}`
}

/** Whether an ignored failure must be named as a residual risk at closure. */
export const owedAsRisk = (entry) => entry.level === 'suite' || isSuiteLevel(entry.test) || entry.revisionTouch?.verdict !== 'untouched'
