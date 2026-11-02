import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Inherited check failures (execution-contract.md "Inherited check failures").
 *
 * A failed required command of the candidate is inherited only when the base
 * of the same source revision failed it the same way. "The same way" is read
 * off each command's complete log, never a digest of it:
 *
 *   failure blocks  a failure line (FAIL, not ok, ✗ …) with its test identity
 *                   (in TAP the path of enclosing test names, `parent > child`)
 *                   and every diagnostic line that belongs to it
 *   pass points     a pass line (PASS, ok, ✓ …), by its exact text
 *   unattributed    every other line, in order (stderr always)
 *
 * Every candidate failure block must equal a distinct base block (else
 * new-failures, naming the test); every base pass must still be reported (else
 * not-made); the unattributed lines must equal the base's exactly, in order
 * (else not-made). Lines are compared byte for byte. The only normalisation is
 * the table below, each rule at the exact position its format defines it:
 *
 *   N0    CRLF becomes LF
 *   F1-a  the runner's `$ <run>` header and `--- exit … ---` footer are cut
 *   F1-b  engine-generated devpanel-check-* names
 *   F1-c  `--- stderr ---` ends any block; stderr is unattributed
 *   F2    node:test TAP (line 1 `TAP version 13|14`): the test-point ordinal,
 *         the YAML block's first `duration_ms` key, `# Subtest:` headers
 *         before their own point, nested plans before their parent point,
 *         and the top-level plan + trailer at the end of stdout
 *
 * Anything else that differs keeps a failure from counting as inherited.
 */

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const clip = (text) => String(text ?? '').slice(0, 240)

// F1-b: remote check directory, unit names, local mkdtemp directory.
const ENGINE_NAMES = /devpanel-check-(?:[0-9a-f]{12}-[0-9a-f]{12}|[0-9a-f]{24}|[A-Za-z0-9]{6})\b/g
const STDERR = '--- stderr ---'
const FAIL = /^\s*(?:FAIL(?:ED)?|not ok|✗|✘|×)(?=[\s:]|$)/
const PASS = /^\s*(?:PASS|ok|✓|✔)(?=[\s:]|$)/
const SEPARATOR = /\s(?:—|-)\s|:\s/
// F2-b: a test point, nested in whole 4-space levels.
const POINT = /^((?: {4})*)(not ok|ok) (\d+)(?: - (.*))?$/
const TRAILER = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']

/**
 * The command's own stdout and stderr from its log (F1-a), or null when the
 * log is not the runner's. The runner writes `$ <run>`, a blank line, stdout,
 * then `\n--- stderr ---\n` and stderr when there is any, then the exit line;
 * the separate `.stdout` file says exactly where stdout ends.
 */
export function commandOutput (log, run, stdout = null) {
  const head = `$ ${run}\n\n`
  const text = String(log).replace(/\r\n/g, '\n')
  const footer = /\n--- exit [^\n]* ---\n$/.exec(text)
  if (!text.startsWith(head) || !footer) return null
  const body = text.slice(head.length, footer.index)
  const separator = `\n${STDERR}\n`
  const out = stdout === null ? null : String(stdout).replace(/\r\n/g, '\n')
  const end = out !== null && body.startsWith(out) ? out.length : body.indexOf(separator) < 0 ? body.length : body.indexOf(separator)
  const rest = body.slice(end)
  if (rest !== '' && !rest.startsWith(separator)) return null
  return { stdout: body.slice(0, end), stderr: rest === '' ? null : rest.slice(separator.length) }
}

// A final newline ends the last line; it is not a blank line of its own.
const splitLines = (text) => text === '' ? [] : text.replace(/\n$/, '').split('\n')

function identity (line) {
  const rest = line.replace(/^\s*(?:FAIL(?:ED)?|not ok|✗|✘|×):?\s*/, '')
  const m = SEPARATOR.exec(rest)
  return { test: m ? rest.slice(0, m.index) : rest, message: m ? rest.slice(m.index + m[0].length) : '' }
}

function fingerprinted (command, failures) {
  // `key` is a TAP test's full path (JSON), so names containing ' > ' cannot collide.
  return failures.map((f) => ({ command, test: clip(f.test), message: clip(f.message), fingerprint: sha256([command, f.key ?? f.test, f.lines.join('\n')].join('\0')) }))
}

function tapParts (command, lines) {
  const failures = []; const passes = []; const unattributed = []
  const stderrAt = lines.indexOf(STDERR)
  const end = stderrAt < 0 ? lines.length : stderrAt
  // F2-e(iii): the top-level plan and the exact trailer, last on stdout.
  let stop = end
  while (stop > 0 && lines[stop - 1] === '') stop--
  const tail = lines.slice(stop - 9, stop)
  const trailer = stop >= 10 && /^1\.\.\d+$/.test(tail[0]) && TRAILER.every((key, i) => new RegExp(`^# ${key} \\d+(?:\\.\\d+)?$`).test(tail[i + 1]))
  const bodyEnd = trailer ? stop - 9 : end
  // C6: a test's identity is the path of enclosing test names. node:test opens
  // each test with `# Subtest: X` at its own depth and closes it with its point
  // at that depth, so `parents[k]` is the test open at depth k. A point whose
  // enclosing tests are not all open, or that closes a different name than the
  // one opened at its depth, leaves the hierarchy unestablished: not-made.
  const parents = []
  let ambiguous = null
  for (let i = 1; i < bodyEnd; i++) {
    const line = lines[i]
    const point = POINT.exec(line)
    if (point) {
      const [, indent, kind, , name = ''] = point
      const depth = indent.length / 4
      // (Array.from: a skipped depth is a hole, which `some` would not visit.)
      if (Array.from({ length: depth }, (_, k) => parents[k]).some((p) => p === undefined)) ambiguous ??= `the enclosing tests of "${name}" are not established`
      if (parents[depth] !== undefined && parents[depth] !== name) ambiguous ??= `"${name}" closes the test opened as "${parents[depth]}"`
      const path = [...parents.slice(0, depth), name]
      parents.length = depth
      const block = [`${indent}${kind}${point[4] !== undefined ? ` - ${name}` : ''}`]
      // F2-c: the YAML block opens directly after its point and closes at `<indent>  ...`.
      if (lines[i + 1] === `${indent}  ---`) {
        block.push(lines[i + 1])
        let j = i + 2
        // F2-d: the reporter's timing is the block's first key, at its own depth.
        if (new RegExp(`^${indent}  duration_ms: \\d+(?:\\.\\d+)?$`).test(lines[j] ?? '')) j++
        for (; j < bodyEnd && lines[j] !== `${indent}  ...`; j++) block.push(lines[j])
        if (j < bodyEnd) block.push(lines[j])
        i = j
      }
      if (kind === 'not ok') failures.push({ test: path.join(' > '), key: JSON.stringify(path), message: '', lines: block })
      else passes.push(`${kind} ${JSON.stringify(path)}`)
      continue
    }
    const subtest = /^((?: {4})*)# Subtest: (.*)$/.exec(line)
    if (subtest) {
      // F2-e(i): a header directly before its own point, or opening its nested stream that closes with it.
      const [, indent, name] = subtest
      const next = lines[i + 1] ?? ''
      const own = POINT.exec(next)
      const closing = lines.slice(i + 1, bodyEnd).find((x) => x.startsWith(indent) && !x.startsWith(indent + ' ') && !x.startsWith(indent + '#'))
      const closes = closing && POINT.exec(closing)
      if ((own && own[1] === indent && (own[4] ?? '') === name) ||
          (next.startsWith(indent + '    ') && closes && closes[1] === indent && (closes[4] ?? '') === name)) {
        parents.length = indent.length / 4
        parents[indent.length / 4] = name
        continue
      }
    }
    // F2-e(ii): a nested plan directly before its parent's point.
    const plan = /^((?: {4})+)1\.\.\d+$/.exec(line)
    if (plan) {
      const parent = POINT.exec(lines[i + 1] ?? '')
      if (parent && parent[1] === plan[1].slice(4)) continue
    }
    unattributed.push(line)
  }
  // What follows the trailer (its final newline) and stderr stay as written.
  for (let i = trailer ? stop : end; i < lines.length; i++) unattributed.push(lines[i])
  return { failures: fingerprinted(command, failures), passes, unattributed, ...(ambiguous ? { ambiguous } : {}) }
}

/**
 * A command's output (`{stdout, stderr}`, or stdout alone as a string) split
 * into failure blocks, pass points and unattributed lines.
 */
export function outputParts (command, output) {
  const { stdout, stderr = null } = typeof output === 'string' ? { stdout: output } : output
  const prepare = (text) => splitLines(String(text).replace(/\r\n/g, '\n').replace(ENGINE_NAMES, 'devpanel-check-*'))
  const lines = [...prepare(stdout), ...(stderr === null ? [] : [STDERR, ...prepare(stderr)])]
  if (/^TAP version 1[34]$/.test(lines[0] ?? '')) return tapParts(command, lines)
  const failures = []; const passes = []; const unattributed = []
  let current = null
  let inStderr = false
  for (const line of lines) {
    if (line === STDERR) { current = null; inStderr = true; unattributed.push(line); continue }
    if (!inStderr && FAIL.test(line)) { current = { ...identity(line), lines: [line] }; failures.push(current); continue }
    if (!inStderr && PASS.test(line)) { passes.push(line); current = null; continue }
    if (current) current.lines.push(line)
    else unattributed.push(line)
  }
  return { failures: fingerprinted(command, failures), passes, unattributed }
}

/** Multiset difference: the items of `a` that `b` does not account for. */
function unmatched (a, b, key = (x) => x) {
  const pool = b.map(key)
  return a.filter((x) => { const i = pool.indexOf(key(x)); if (i < 0) return true; pool.splice(i, 1); return false })
}

async function readOutput (runDir, check, command) {
  const dir = path.join(runDir, check.dir ?? '')
  try {
    const stdout = await fs.readFile(path.join(dir, `${command.id}.stdout`), 'utf8').catch(() => null)
    return commandOutput(await fs.readFile(path.join(dir, command.log), 'utf8'), command.run, stdout)
  } catch { return null }
}

const requiredIds = (target) => [...(target?.commands ?? []), ...(target?.finallyCommands ?? [])].filter((c) => c.required !== false).map((c) => c.id)

/** AC1: the failure fingerprints of a check's failed required commands, as stored with a baseline. */
export async function failureFingerprints ({ runDir, check, target }) {
  const required = new Set(requiredIds(target))
  const failures = []
  for (const c of (check.commands ?? []).filter((x) => required.has(x.id) && !x.passed)) {
    const output = await readOutput(runDir, check, c)
    const parts = output === null ? null : outputParts(c.id, output)
    failures.push(...(parts?.failures ?? []), {
      command: c.id, test: '(command)', message: `exit ${c.exitCode ?? c.signal ?? 'none'}${c.timedOut ? ' (timed out)' : ''}`,
      fingerprint: parts ? sha256([c.id, c.exitCode, parts.passes.join('\n'), parts.unattributed.join('\n')].join('\0')) : null,
      ...(parts ? {} : { unreadable: true }), ...(parts?.ambiguous ? { ambiguous: parts.ambiguous } : {})
    })
  }
  return failures
}

/**
 * The candidate's failed check against the base of the same source revision.
 * `baseline-known` only when every failure of every failed required command is
 * the base's own; otherwise `new-failures` (naming them) or `not-made` (why the
 * comparison could not establish it). Both of those block.
 */
export async function compareFailures ({ runDir, target, base, candidate, sourceRevision }) {
  const record = { verdict: 'not-made', reason: null, sourceRevision, capturedAt: base?.capturedAt ?? base?.at ?? null, baselineDir: base?.dir ?? null,
    baselineKnown: [], newFailures: [], notRun: [], notMade: [],
    instruction: 'Only newFailures count against the candidate; baselineKnown failures occur identically on the unchanged base of the same source revision and do not block. not-made means nothing may be taken as inherited.' }
  const notMade = (reason) => { record.verdict = 'not-made'; record.reason = reason; return record }
  if (!base) return notMade('no baseline of this source revision could be captured')
  if (base.result === 'unavailable') return notMade(`the base could not be checked: ${base.error ?? 'unavailable'}`)
  if ((base.sourceRevision ?? base.baseCommit) !== sourceRevision) return notMade(`the baseline is of ${base.sourceRevision ?? base.baseCommit ?? 'an unknown revision'}, not ${sourceRevision}`)

  const required = requiredIds(target)
  const ran = new Map((candidate.commands ?? []).map((c) => [c.id, c]))
  record.notRun = required.filter((id) => !ran.has(id))
  if (record.notRun.length) record.notMade.push({ command: null, reason: `required ${record.notRun.length === 1 ? 'command' : 'commands'} ${record.notRun.join(', ')} did not run, so ${record.notRun.length === 1 ? 'its' : 'their'} outcome is unknown` })

  for (const c of (candidate.commands ?? []).filter((x) => required.includes(x.id) && !x.passed)) {
    const b = (base.commands ?? []).find((x) => x.id === c.id)
    const whole = (reason) => record.newFailures.push({ command: c.id, test: '(command)', message: reason })
    if (!b) { record.notMade.push({ command: c.id, reason: 'the base did not run it' }); continue }
    if (b.passed) { whole('passes on the base'); continue }
    if (c.timedOut || c.signal || b.timedOut || b.signal) { whole('a timeout or signal is never inherited'); continue }
    if (b.exitCode !== c.exitCode) { whole(`exit ${c.exitCode} here, ${b.exitCode} on the base`); continue }
    const [bo, co] = [await readOutput(runDir, base, b), await readOutput(runDir, candidate, c)]
    if (bo === null || co === null) { record.notMade.push({ command: c.id, reason: 'its log could not be read as the runner wrote it' }); continue }
    const [bp, cp] = [outputParts(c.id, bo), outputParts(c.id, co)]
    const ambiguous = cp.ambiguous ?? bp.ambiguous
    if (ambiguous) { record.notMade.push({ command: c.id, reason: `its test hierarchy could not be established: ${clip(ambiguous)}` }); continue }
    const fresh = unmatched(cp.failures, bp.failures, (f) => f.fingerprint)
    record.newFailures.push(...fresh)
    record.baselineKnown.push(...unmatched(cp.failures, fresh, (f) => f.fingerprint))
    if (fresh.length) continue
    const lost = unmatched(bp.passes, cp.passes)
    if (lost.length) record.notMade.push({ command: c.id, reason: `the base reported results the candidate did not: ${clip(lost.slice(0, 3).join('; '))}` })
    else if (bp.unattributed.join('\n') !== cp.unattributed.join('\n')) record.notMade.push({ command: c.id, reason: 'output outside its failure blocks differs from the base' })
    else if (!cp.failures.length) record.baselineKnown.push({ command: c.id, test: '(command)', message: `exit ${c.exitCode}`, fingerprint: sha256([c.id, c.exitCode, cp.unattributed.join('\n')].join('\0')) })
  }
  if (record.newFailures.length) { record.verdict = 'new-failures'; record.reason = `${record.newFailures.length} ${record.newFailures.length === 1 ? 'failure does' : 'failures do'} not occur on the base` }
  else if (record.notMade.length) return notMade(record.notMade.map((x) => x.command ? `${x.command}: ${x.reason}` : x.reason).join('; '))
  else { record.verdict = 'baseline-known'; record.reason = null }
  return record
}

/*
 * Selftest reports (execution-contract.md "Selftest reports"). A command that
 * declares `report: selftest` prints one `== <path>/selftest.report` line
 * and then that file's JSON (after a few summary lines grepped from it). The
 * failed tests are read from the structure, never from text: a test is any
 * object with a string `test`, failed when it has `error` or `stack` and is not
 * skipped, and its identity is that whole string. This is a case of its own
 * beside the byte rules above; it never makes a failure inherited.
 *
 * An older spelling carries a site prefix, `<site>-selftest`; it names the same
 * format and is read the same (SELFTEST_REPORT), so existing configuration keeps
 * its value and its configHash.
 */
export const SELFTEST_REPORT = /^(?:[a-z0-9][a-z0-9.]*-)?selftest$/
export const isSelftestReport = (report) => typeof report === 'string' && SELFTEST_REPORT.test(report)
const REPORT_HEADER = /^== (\S*\/selftest\.report)$/

/** The report in a command's stdout, or `{ error }` saying why it cannot be read. */
export function selftestReport (stdout) {
  const lines = String(stdout ?? '').replace(/\r\n/g, '\n').split('\n')
  const headers = lines.flatMap((l, i) => REPORT_HEADER.test(l) ? [i] : [])
  if (headers.length !== 1) return { error: `expected exactly one "== …/selftest.report" line, found ${headers.length}` }
  const start = headers[0] + 1
  const next = lines.findIndex((l, i) => i > start && l.startsWith('== '))
  // JSON escapes newlines, so no line of the report starts with `== `.
  const segment = lines.slice(start, next < 0 ? lines.length : next)
  // `cat` prints the file last; the grepped summary lines before it are
  // fragments of it and never parse together with what follows.
  for (let i = 0; i < segment.length; i++) {
    if (!/^[[{]/.test(segment[i])) continue
    const text = segment.slice(i).join('\n')
    // The value ends where its brackets balance: a report file without a final
    // newline glues the next "== <log>" header to its closing brace.
    try { return { path: REPORT_HEADER.exec(lines[headers[0]])[1], report: JSON.parse(text.slice(0, jsonEnd(text))) } } catch {}
  }
  return { error: 'no JSON report follows the line naming it' }
}

/** The length of the JSON object or array at the start of `text` (string-aware), or the whole text. */
function jsonEnd (text) {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1
  }
  return text.length
}

/** A tester entry for a whole suite or thread, not one test: the last name segment is parenthesised. */
const isSuiteLevel = (test) => /(^|\/)\([a-z-]+\)$/.test(test)

/** The names of the report's failed tests (a name that failed once is failed). */
export function failedSelftests (report) {
  const state = new Map()
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk)
    if (!o || typeof o !== 'object') return
    if (typeof o.test === 'string' && state.get(o.test) !== 'FAIL') state.set(o.test, o.skipped ? 'SKIP' : (o.error || o.stack) ? 'FAIL' : 'PASS')
    Object.values(o).forEach(walk)
  }
  walk(report)
  return [...state].filter(([, s]) => s === 'FAIL').map(([test]) => test)
}

async function readReport (runDir, check, id) {
  const c = (check?.commands ?? []).find((x) => x.id === id)
  if (!c) return { error: 'did not run', notRun: true }
  if (!c.passed) return { failed: true }
  const stdout = await fs.readFile(path.join(runDir, check.dir ?? '', `${id}.stdout`), 'utf8').catch(() => null)
  return stdout === null ? { error: 'its output could not be read' } : selftestReport(stdout)
}

/**
 * The suite-level failures ("worker/(suite)", "(suite-busy)") in a check's
 * declared selftest reports: non-empty means some suite never ran, so the check
 * cannot serve as a complete base. engine.checkCandidate redrives such a base
 * once and never keeps or caches it.
 */
export async function unfinishedSuites ({ runDir, target, check }) {
  const declared = [...(target?.commands ?? []), ...(target?.finallyCommands ?? [])].filter((c) => isSelftestReport(c.report))
  const found = []
  for (const { id } of declared) {
    const r = await readReport(runDir, check, id)
    if (r.failed || r.notRun) found.push(`${id}/(report)`)
    else if (r.report) found.push(...failedSelftests(r.report).filter(isSuiteLevel))
  }
  return found
}

/**
 * The candidate's selftest failures against the base of the same source
 * revision, or null when no command declares a report. `new-failures` (naming
 * them) and `not-made` (a report that cannot be read or compared while the
 * candidate lists failures) fail the check; `baseline-known`, `none` and
 * `not-applicable` (the command itself failed: the byte rules judge it) do not.
 */
export async function compareSelftestReports ({ runDir, target, base, candidate, sourceRevision }) {
  const declared = [...(target?.commands ?? []), ...(target?.finallyCommands ?? [])].filter((c) => isSelftestReport(c.report))
  if (!declared.length) return null
  const record = { verdict: 'none', reason: null, reports: [], newFailures: [], baselineKnown: [],
    instruction: 'Selftest failures compared with the base by test name. newFailures fail the check and must be fixed or explained by the author; baselineKnown failures occur on the unchanged base too and do not block. not-made means the report could not be read or compared while the candidate lists failures (including a base whose selftest run did not complete): it is not evidence of a regression, and the remedy is a complete base, not a source change.' }
  const notMade = []
  // How many of the not-made reasons are an unfinished base and nothing else: then the comparison is
  // inconclusive for a reason outside the candidate (inconclusiveBase), not a report it failed to produce.
  let unfinishedBase = 0
  const read = (check, id) => readReport(runDir, check, id)
  for (const { id } of declared) {
    const cand = await read(candidate, id)
    if (cand.failed) { record.reports.push({ command: id, verdict: 'not-applicable' }); continue }
    if (cand.error) { notMade.push(`${id}: ${cand.error}`); continue }
    const failed = failedSelftests(cand.report)
    if (!failed.length) { record.reports.push({ command: id, path: cand.path, failed: 0, verdict: 'none' }); continue }
    if (!base || base.result === 'unavailable') { notMade.push(`${id}: no baseline of this source revision could be captured`); continue }
    if ((base.sourceRevision ?? base.baseCommit) !== sourceRevision) { notMade.push(`${id}: the baseline is not of ${sourceRevision}`); continue }
    const b = await read(base, id)
    // A base whose report command failed or never ran stopped before its selftests (a readiness race on
    // 2026-11-01): like a suite that did not finish, a fresh base answers it, not the author. A report
    // that was produced but cannot be read is another matter, and stays a plain not-made.
    if (b.failed || b.notRun) { notMade.push(`${id}: on the base, ${b.error ?? 'the command failed'}, so its selftest run did not complete`); unfinishedBase++; continue }
    if (b.error) { notMade.push(`${id}: on the base, ${b.error}`); continue }
    const known = new Set(failedSelftests(b.report))
    const fresh = failed.filter((test) => !known.has(test))
    // A suite-level entry on the base ("worker/(suite)" after an RPC timeout, "(suite-busy)", "admin/(thread-ready)")
    // means some suite there never ran, so a failure absent from the base may simply not have been reached: the
    // comparison cannot call it new. DKIM run 2026-10-17 was refused twice on two inherited failures this way.
    const unfinished = [...known].filter(isSuiteLevel)
    if (fresh.length && unfinished.length) {
      notMade.push(`${id}: the base selftest run did not complete (${unfinished.join(', ')}), so ${fresh.length} candidate ${fresh.length === 1 ? 'failure' : 'failures'} cannot be judged new or inherited`)
      unfinishedBase++
      continue
    }
    record.newFailures.push(...fresh.map((test) => ({ command: id, test })))
    record.baselineKnown.push(...failed.filter((test) => known.has(test)).map((test) => ({ command: id, test })))
    record.reports.push({ command: id, path: cand.path, failed: failed.length, verdict: fresh.length ? 'new-failures' : 'baseline-known' })
  }
  if (record.newFailures.length) { record.verdict = 'new-failures'; record.reason = `${record.newFailures.length} selftest ${record.newFailures.length === 1 ? 'failure does' : 'failures do'} not occur on the base` }
  else if (notMade.length) { record.verdict = 'not-made'; record.reason = notMade.join('; '); if (unfinishedBase === notMade.length) record.baseUnfinished = true }
  else if (record.baselineKnown.length) record.verdict = 'baseline-known'
  else if (record.reports.length && record.reports.every((r) => r.verdict === 'not-applicable')) record.verdict = 'not-applicable'
  return record
}

/**
 * Whether `check` fails the gate only because the base's selftest run did not finish (`baseUnfinished`): without
 * the selftest comparison it would pass. Such a result says nothing about the candidate. The review loop stops
 * on it (`checks-inconclusive`) instead of giving the author a round, and Refresh checks drives a fresh base,
 * since an unfinished base is never kept or cached (engine.checkCandidate).
 */
export function inconclusiveBase (check, run) {
  const selftest = check?.baselineComparison?.selftest
  if (selftest?.verdict !== 'not-made' || !selftest.baseUnfinished) return false
  return gatingResult({ ...check, baselineComparison: { ...check.baselineComparison, selftest: null } }, run) === 'passed'
}

/** Whether a check's selftest reports name a failure it may not pass over. */
const selftestBlocks = (check) => ['new-failures', 'not-made'].includes(check?.baselineComparison?.selftest?.verdict)

/**
 * What a check result counts as for the gates: a failure whose every failed
 * required command is baseline-known, against the base of this run's source
 * revision, counts as passed. A selftest report with a new failure, or one that
 * cannot be compared, makes it failed whatever ran; it never makes a failure
 * pass. `result` itself always stays what ran.
 */
export function gatingResult (check, run) {
  if (check?.result === 'passed') return selftestBlocks(check) ? 'failed' : 'passed'
  if (check?.result !== 'failed') return check?.result
  const f = check.baselineComparison?.failures
  return f?.verdict === 'baseline-known' && Boolean(f.sourceRevision) && f.sourceRevision === run?.workspace?.baseCommit && !selftestBlocks(check) ? 'passed' : 'failed'
}

/**
 * In words, which condition made `gatingResult` anything but passed, or null
 * when it passed: only what gated, so a failure inherited from the base is not
 * named beside the selftest that blocked. The records it reads stay on the check.
 */
export function gateReason (check, run) {
  if (gatingResult(check, run) === 'passed') return null
  if (!['passed', 'failed'].includes(check?.result)) return `the check did not complete (${check?.result ?? 'no result'})${check?.error ? `: ${check.error}` : ''}`
  const named = (list) => `${list.slice(0, 5).map((f) => `${f.command ?? '?'}: ${f.test}${f.message ? ` (${f.message})` : ''}`).join(', ')}${list.length > 5 ? ` and ${list.length - 5} more` : ''}`
  const parts = []
  const f = check.baselineComparison?.failures
  if (check.result === 'failed' && !(f?.verdict === 'baseline-known' && Boolean(f.sourceRevision) && f.sourceRevision === run?.workspace?.baseCommit)) {
    const failed = (check.commands ?? []).filter((c) => c.required !== false && !c.passed).map((c) => c.id)
    parts.push(failed.length ? `required ${failed.length === 1 ? 'command' : 'commands'} ${failed.join(', ')} failed` : check.error ?? 'the check failed')
    if (f?.verdict === 'new-failures') parts.push(`not on the base: ${named(f.newFailures)}`)
    else if (f?.verdict === 'not-made') parts.push(`comparison with the base not made: ${f.reason}`)
    else if (f?.verdict === 'baseline-known') parts.push(`known only on ${f.sourceRevision ?? 'an unknown revision'}, not this source revision`)
    else parts.push('no comparison with the base was made')
  }
  const selftest = check.baselineComparison?.selftest
  if (selftest?.verdict === 'new-failures') parts.push(`selftest verdict new-failures: ${named(selftest.newFailures)}`)
  else if (selftest?.verdict === 'not-made') parts.push(`selftest verdict not-made: ${selftest.reason}`)
  return parts.join('; ')
}
