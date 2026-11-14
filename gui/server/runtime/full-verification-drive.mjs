import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { runChecks } from './checks.mjs'
import { compareFailures, compareSelftestReports, isSelftestReport, selftestReport, skippedSelftests } from './baseline-failures.mjs'
import { withInstance } from './instance-drive.mjs'
import { exitedOnItsOwn } from './modules-tier.mjs'
import { modulesTarget } from '../infrastructure.mjs'

/*
 * The full check of a daily full verification run (execution-contract.md "Full
 * verification freeze"): after its staging release completed, the project's full
 * test-drive tier drives the run's own snapshot (the development checkout as it
 * stood), and its failures are compared with the drive of the latest cycle in
 * which this stage was green. Not the baseline cache: that one is keyed by the
 * exact base commit, and each day's checkout has another. A failure that was
 * already there is inherited and does not make the stage red; a new one does.
 * Without a previous green cycle, any failure is red.
 *
 * On a stage host with dynamic instances (`testDrive.modules.instance`) the cycle starts
 * no run: it drives `instanceCycleTarget` itself, on an instance of its own created from
 * its snapshot of the development checkout (full-verification.mjs runInstanceStage), and
 * compares only with earlier instance drives (`mode`).
 */

export const DRIVE_DIR = 'full-verification'
export const PREVIOUS_DIR = 'previous-green'

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const BLOCKING = ['new-failures', 'not-made']

/** sha256 of every file of a drive's directory, by name: what a later cycle verifies before comparing. */
export async function driveFiles (runDir, check) {
  const dir = path.join(runDir, check?.dir ?? '')
  const files = {}
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile()) files[e.name] = sha256(await fs.readFile(path.join(dir, e.name)))
  }
  return files
}

/** Cycle record files, newest first: <date>/cycle.json before <date>/cycle.<n>.json, n descending. */
export async function cycleRecords (verificationDir) {
  const out = []
  const dates = (await fs.readdir(verificationDir).catch(() => [])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
  for (const date of dates) {
    const names = (await fs.readdir(path.join(verificationDir, date)).catch(() => []))
      .map((n) => ({ n, i: n === 'cycle.json' ? Infinity : Number(/^cycle\.(\d+)\.json$/.exec(n)?.[1] ?? NaN) }))
      .filter((x) => !Number.isNaN(x.i)).sort((a, b) => b.i - a.i)
    for (const { n } of names) {
      const record = await fs.readFile(path.join(verificationDir, date, n), 'utf8').then(JSON.parse, () => null)
      if (record) out.push(record)
    }
  }
  return out
}

/**
 * The newest cycle entry in which this project's stage was green, with a drive to compare against,
 * of the same mode (`release`: a Deployment run's drive, the mode of an entry that names none;
 * `instance`: a cycle's own drive on a stage instance), since the two run different commands.
 */
export async function previousGreen ({ verificationDir, project, stage, exceptRunId = null, mode = 'release' }) {
  for (const record of await cycleRecords(verificationDir)) {
    const entry = (record.projects ?? []).find((p) => p.project === project && p.stage === stage && p.verdict === 'green' && (p.mode ?? 'release') === mode && p.runId !== exceptRunId && p.check?.dir && p.runDir)
    if (entry) return { cycleId: record.id, ...entry }
  }
  return null
}

/** Copy the previous green drive into this run, verifying every file against the cycle record. */
async function adopt (previous, runDir) {
  const to = path.join(runDir, 'checks', PREVIOUS_DIR)
  await fs.rm(to, { recursive: true, force: true })
  await fs.mkdir(to, { recursive: true })
  // A run's record, or an instance drive's own drive.json (same shape).
  const check = JSON.parse(await fs.readFile(path.join(previous.runDir, previous.recordFile ?? 'run.json'), 'utf8')).fullVerification?.check?.result
  if (!check) throw new Error(`run ${previous.runId} records no full verification drive`)
  for (const [name, hash] of Object.entries(previous.check.files ?? {})) {
    if (name.includes('/') || name.startsWith('.')) throw new Error(`unexpected file name ${name} in the cycle record`)
    const bytes = await fs.readFile(path.join(previous.runDir, previous.check.dir, name))
    if (sha256(bytes) !== hash) throw new Error(`${name} of run ${previous.runId} changed since cycle ${previous.cycleId} recorded it`)
    await fs.writeFile(path.join(to, name), bytes)
  }
  return { ...check, dir: path.join('checks', PREVIOUS_DIR) }
}

/**
 * The cycle's gate on a drive: passed when the drive passed and no selftest failure
 * is new; a failed drive passes only when every failure of its failed required
 * commands is the previous green drive's own and no selftest failure is new.
 */
export function cycleGate (check, { failures = null, selftest = null } = {}) {
  const selftestBlocks = Boolean(selftest && BLOCKING.includes(selftest.verdict))
  if (check?.result === 'passed') return selftestBlocks ? 'failed' : 'passed'
  if (check?.result !== 'failed') return check?.result ?? 'not-run'
  return failures?.verdict === 'baseline-known' && !selftestBlocks ? 'passed' : 'failed'
}

/** Drive the full tier on the run's snapshot and judge it against the previous green cycle. */
export async function fullVerificationDrive ({ target, workspace, runDir, runId, project, stage, verificationDir, clock, signal = null, platform, onDriveWait = null, drive = runChecks, mode = 'release' }) {
  const check = await drive({ target, revision: null, base: true, dirName: DRIVE_DIR, baseCommit: workspace.baseCommit, workspacePath: workspace.path, gitDir: workspace.gitDir ?? null,
    runDir, clock, signal, platform, runId, onDriveWait })
  const previous = await previousGreen({ verificationDir, project, stage, exceptRunId: runId, mode })
  let base = null
  let baseline = null
  if (previous) {
    try {
      base = await adopt(previous, runDir)
      baseline = { cycleId: previous.cycleId, runId: previous.runId, baseCommit: previous.check.baseCommit ?? null }
    } catch (error) {
      baseline = { cycleId: previous.cycleId, runId: previous.runId, unusable: error.message }
    }
  }
  // The comparison is across revisions on purpose: today's checkout against the last green one.
  const sourceRevision = base?.baseCommit ?? null
  const baseCheck = base ? { ...base, sourceRevision } : null
  const selftest = await compareSelftestReports({ runDir, target, base: baseCheck, candidate: check, sourceRevision })
  const failures = check.result === 'failed' ? await compareFailures({ runDir, target, base: baseCheck, candidate: check, sourceRevision }) : null
  const gating = cycleGate(check, { failures, selftest })
  return { result: check, baseline, selftest, failures, gating, files: await driveFiles(runDir, check), baseCommit: workspace.baseCommit }
}

/**
 * The target of a cycle on a stage instance: the modules tier's create, start and ready
 * (instance-drive.mjs driveCommands makes a fresh drive of it), then the whole suite and
 * the whole browser run of `modules.instance.fullSuite`, each continuing past its own
 * failure, then the tier's collectors and the suite's. Every command names the instance
 * `name` (infrastructure.mjs instanceErrors), so none reaches the base instance. Null
 * when the project declares no full suite.
 */
export function instanceCycleTarget (infra, name) {
  const modules = infra?.testDrive?.modules
  const suite = modules?.instance?.fullSuite
  if (!suite) return null
  const { modules: _modules, timing: _timing, ...rest } = modulesTarget(infra)
  const commands = [modules.load, modules.restart, modules.ready, { ...suite.test, ownFailureContinues: true },
    ...(suite.browser ? [{ ...suite.browser, ownFailureContinues: true }] : [])]
  const finallyCommands = [...(modules.finallyCommands ?? []), ...(suite.finallyCommands ?? [])]
  return withInstance({ ...rest, tier: 'full', commands, ...(finallyCommands.length ? { finallyCommands } : {}) }, modules, name)
}

const reportCommands = (target) => [...(target?.commands ?? []), ...(target?.finallyCommands ?? [])].filter((c) => isSelftestReport(c.report))

/** Each declared report command that ran, with the report its own output holds (parsed), or why none. */
async function readReports ({ runDir, check, target }) {
  const out = []
  for (const { id } of reportCommands(target)) {
    if (!(check?.commands ?? []).some((c) => c.id === id)) continue
    const stdout = await fs.readFile(path.join(runDir, check.dir ?? '', `${id}.stdout`), 'utf8').catch(() => null)
    const parsed = stdout === null ? { error: 'its output could not be read' } : selftestReport(stdout)
    out.push({ command: id, ...(parsed.report ? { report: parsed.report, path: parsed.path } : { error: parsed.error }) })
  }
  return out
}

/**
 * Whether the whole suite of an instance drive ran, the evidence that its deliveries were
 * tested (verification-trigger.mjs): the suite's own record, not skipped behind a failed
 * readiness (checks.mjs runCommandSet), passing or failing on its own exit (no timeout,
 * signal or unavailable answer), and a selftest report that parses out of a report
 * command's output. What the comparison recorded is not that evidence: a failed collector
 * reads as not-applicable there, and with no baseline a parsed report leaves no entry.
 * `{ command, passed, exitCode, report }`, or null.
 */
export async function suiteRanOf ({ runDir, check, target, suiteId }) {
  const record = (check?.commands ?? []).find((c) => c.id === suiteId)
  if (!record || (check.skipped ?? []).some((s) => s.id === suiteId)) return null
  if (!record.passed && !exitedOnItsOwn(record)) return null
  const read = (await readReports({ runDir, check, target })).find((r) => r.report)
  if (!read) return null
  return { command: suiteId, passed: record.passed === true, exitCode: record.exitCode ?? null, report: { command: read.command, path: read.path ?? null } }
}

/**
 * The same evidence for a cycle's Deployment run (a release-mode entry), whose full tier is the project's own
 * command list: every required command ran (none skipped) and answered on its own (passed, or failed on its own
 * exit: no timeout, signal or unavailable answer), and, where the target declares a selftest report (the drive's
 * comparison names its commands), a report parses out of one of those commands' output. A timed-out last command
 * fails the drive without skipping anything; it proves nothing. `{ commands, report }`, or null.
 */
export async function fullTierRanOf ({ runDir, check, selftest = null }) {
  const required = (check?.commands ?? []).filter((c) => c.required !== false)
  if (!required.length || (check.skipped ?? []).some((s) => s.required !== false)) return null
  if (!required.every((c) => c.passed || exitedOnItsOwn(c))) return null
  const declared = [...new Set([...(selftest?.reports ?? []), ...(selftest?.unread ?? [])].map((r) => r.command).filter(Boolean))]
  if (!declared.length) return { commands: required.map((c) => c.id), report: null }
  for (const id of declared) {
    const stdout = await fs.readFile(path.join(runDir, check.dir ?? '', `${id}.stdout`), 'utf8').catch(() => null)
    const parsed = stdout === null ? null : selftestReport(stdout)
    if (parsed?.report) return { commands: required.map((c) => c.id), report: { command: id, path: parsed.path ?? null } }
  }
  return null
}

/** The tests the drive's selftest reports name as skipped: on an instance, the ones that cannot run there by design. */
export async function notOnInstanceOf ({ runDir, check, target }) {
  const seen = new Set()
  const out = []
  for (const r of await readReports({ runDir, check, target })) {
    for (const s of r.report ? skippedSelftests(r.report) : []) {
      if (seen.has(s.test)) continue
      seen.add(s.test)
      out.push({ command: r.command, ...s })
    }
  }
  return out
}
