import { ignoredWords } from './selftest-history.mjs'
import { failedModuleTests } from './baseline-failures.mjs'

/** Model-facing evidence summary. Full manifests/logs stay in the retained check artifact. */
export function checkSummary (check, fullEvidence = null) {
  if (!check) return null
  const clip = value => typeof value === 'string' ? value.slice(0, 2000) : value ?? null
  const m = check.materialization
  return {
    revision: check.revision, result: check.result, target: check.target, at: check.at,
    // A smoke result answers whether the revision boots; only the full drive counts for closure.
    ...(check.tier ? { tier: check.tier, tierNote: check.tier === 'smoke' ? 'Smoke tier: boot and lint only. A failure returns the revision to the author; a pass does not stand in for the full drive, which runs on the approved revision and is what closure counts.'
      : check.tier === 'targeted' ? 'Targeted tier: only the tests named in `targeted.tests` and the commands declared to run with them, not the whole drive. A failure returns the revision to the author; a pass shows those tests only and does not stand in for the full drive, which runs on the approved revision and is what closure counts.'
        : check.tier === 'modules' ? 'Modules tier: lint, the candidate loaded into the stage instance, and the selftests of the affected modules and core directories. Every failure blocks (no base comparison); this is the result closure counts.'
          : 'Full drive: the result closure counts.' } : {}),
    ...(check.targeted ? { targeted: check.targeted } : {}),
    ...(check.targetedDeclined ? { targetedDeclined: check.targetedDeclined } : {}),
    durationMs: check.durationMs, step: check.step, dir: check.dir, error: clip(check.error), fullEvidence,
    // durationMs includes this: how long the drive waited for a slot on its staging host (drive-slots.mjs).
    ...(check.driveSlot?.waitMs ? { driveSlot: check.driveSlot } : {}),
    // Not a drive of this revision: the approved revision's result, carried over inert drift (engine.reconcileDelivery).
    ...(check.carriedFrom ? { carriedFrom: check.carriedFrom, carriedBecause: check.carriedBecause ?? null } : {}),
    // Run on the smoke's instance rather than from scratch: still the full drive closure counts.
    ...(check.continuedFrom ? { continuedFrom: check.continuedFrom, continuedNote: `This full drive continued the smoke's running instance (${check.continuedFrom.dir}): it executed ${check.continuedFrom.ran.join(', ') || 'no command'} and the finalizers, and the records marked fromSmoke are the smoke's.${check.continuedFrom.declaredBeforeServices.length ? ` ${check.continuedFrom.declaredBeforeServices.join(', ')} ran after the service started, though declared before it, so the service never saw their effect: judge whether this drive's evidence still answers for what depends on them.` : ''}${check.continuedFrom.notCounted.length ? ` ${check.continuedFrom.notCounted.map((c) => c.id).join(', ')} read as not run, as in a fresh drive, although a smoke log exists (notCounted).` : ''}` } : {}),
    ...(check.continuation ? { continuation: check.continuation } : {}),
    materialization: m ? { method: m.method, verified: m.verified, detail: clip(m.detail), archiveSha256: m.archiveSha256,
      remoteSha256: m.remoteSha256, remoteEntryCount: m.remoteEntryCount ?? m.remoteEntries?.length ?? null,
      beforeCommands: m.beforeCommands, afterCommands: m.afterCommands,
      remoteTermination: m.remoteTermination ? { confirmed: m.remoteTermination.confirmed, stderr: clip(m.remoteTermination.stderr) } : null,
      cleanup: typeof m.cleanup === 'object' ? { ...m.cleanup, stdout: clip(m.cleanup.stdout), stderr: clip(m.cleanup.stderr) } : m.cleanup } : null,
    commands: (check.commands ?? []).slice(0, 30).map(c => ({ id: c.id, required: c.required, passed: c.passed,
      exitCode: c.exitCode, signal: c.signal, timedOut: c.timedOut, durationMs: c.durationMs, log: c.log,
      stdout: clip(c.stdout), stderr: clip(c.stderr), error: clip(c.error),
      // Every PASS/FAIL-style line of the whole output (checks.mjs resultLines): the
      // evidence a non-gating selftest collector holds, readable from any seat.
      ...(c.results ? { results: c.results } : {}), ...(c.fromSmoke ? { fromSmoke: c.fromSmoke } : {}) })),
    commandCount: check.commands?.length ?? 0,
    // Commands that did not run after a required failure: their outcome is unknown.
    ...(check.skipped?.length ? { skipped: check.skipped } : {}),
    // The modules tier: every module whose test or browser command failed in this drive, and what never ran.
    ...(modulesSummary(check) ?? {}),
    ...(check.baselineComparison ? { baselineComparison: check.baselineComparison } : {}),
    // Failures the gate passed over on history's word: never read as nothing happened.
    ...(check.baselineComparison?.selftest?.unstable?.length ? { unstableNote: check.baselineComparison.selftest.unstable.map(ignoredWords) } : {}),
    // Earlier attempts on the same revision (the engine's retry of a failure).
    // `flaky` means this pass followed a failure of identical bytes.
    ...(check.attempts?.length ? { attempts: check.attempts, flaky: check.flaky === true,
      retryNote: check.selftestReproduced ? 'The new selftest failures were named again by a second drive of this same revision: they reproduce. Each attempt\'s newFailures lists them.'
        : check.flaky && check.attempts.some(a => a.newFailures?.length) ? 'A second drive of this same revision no longer names the new selftest failures the first one did (attempts[].newFailures): they are unstable, not reproduced; name them as a residual risk if they touch what this change does.'
        : check.flaky ? 'An earlier attempt on this same revision failed and the retry passed: the failure is not reproducible, but the instability is real; name it as a residual risk if the failing commands touch what this change does.'
        : check.attempts.some(a => a.result !== 'failed') ? 'The failure stands: a retry on this same revision could not run (see its error), so it neither confirms nor clears the failure.'
          : 'Every attempt on this same revision failed: the failure reproduces.' } : {}),
    // No second drive: an earlier revision of this run already answered what it would.
    ...(check.retrySkipped ? { retrySkipped: check.retrySkipped,
      retryNote: check.retrySkipped.reason === 'selftest-reproduced-earlier' ? 'Not driven a second time: every new selftest failure here already failed in two drives of an earlier revision of this run (retrySkipped.failures names that revision).'
        : check.retrySkipped.reason === 'tests-failed' ? 'Not driven a second time: the modules drive ran its tests and they failed (retrySkipped.commands); the same revision would fail them again.'
        : 'Not driven a second time: every failed required command failed the same way on an earlier revision of this run and the base passed it (retrySkipped.commands names the way and the revision).' } : {}),
    instruction: 'Summary only. Full evidence includes the file manifest and command details; inspect it when needed. A passed smoke test is not proof of all acceptance criteria. A command\'s `results` lists every PASS/FAIL-style line of its whole output, including non-gating collectors: quote those lines as evidence instead of saying the report is unreadable.'
  }
}

/**
 * A modules drive's failures by module. Its test commands do not stop each other
 * (checks.mjs runCommandSet), so `failed` is every failing module of the drive,
 * not the first; `notRun` is non-empty only when a command ended in a way that
 * left the instance in doubt.
 */
function modulesSummary (check) {
  if (check.tier !== 'modules') return null
  const read = failedModuleTests(check)
  if (!read) return null
  const named = check.modules.selftestFailures ?? []
  return { modules: {
    tested: check.modules.tests.flatMap((t) => t.filters ?? [t.filter]).filter((f, i, all) => all.indexOf(f) === i),
    ...(check.modules.failedFirst?.length ? { failedFirst: check.modules.failedFirst } : {}),
    failed: read.failed, notRun: read.notRun,
    selftestFailures: named.slice(0, 60), ...(named.length > 60 ? { selftestFailuresTotal: named.length } : {}),
    ...(check.modules.reportUnreadable?.length ? { reportUnreadable: check.modules.reportUnreadable } : {}),
    note: `Modules tier: a test or browser command that fails on its own exit does not stop the others, so \`failed\` lists EVERY failing module of this drive${read.failed.length ? ' — answer all of them in one revision, not only the first' : ''}. \`notRun\` holds commands that did not run because an earlier one timed out, was killed or could not be reached: their outcome is unknown, not a pass.${read.failed.some((f) => f.undetermined) ? ' An `undetermined` entry is one command that tested several filters: read `selftestFailures` and its log for which.' : ''}`
  } }
}
