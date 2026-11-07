import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { runChecks } from './checks.mjs'
import { compareFailures, compareSelftestReports } from './baseline-failures.mjs'

/*
 * The full check of a daily full verification run (execution-contract.md "Full
 * verification freeze"): after its staging release completed, the project's full
 * test-drive tier drives the run's own snapshot (the development checkout as it
 * stood), and its failures are compared with the drive of the latest cycle in
 * which this stage was green. Not the baseline cache: that one is keyed by the
 * exact base commit, and each day's checkout has another. A failure that was
 * already there is inherited and does not make the stage red; a new one does.
 * Without a previous green cycle, any failure is red.
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

/** The newest cycle entry in which this project's stage was green, with a drive to compare against. */
export async function previousGreen ({ verificationDir, project, stage, exceptRunId = null }) {
  for (const record of await cycleRecords(verificationDir)) {
    const entry = (record.projects ?? []).find((p) => p.project === project && p.stage === stage && p.verdict === 'green' && p.runId !== exceptRunId && p.check?.dir && p.runDir)
    if (entry) return { cycleId: record.id, ...entry }
  }
  return null
}

/** Copy the previous green drive into this run, verifying every file against the cycle record. */
async function adopt (previous, runDir) {
  const to = path.join(runDir, 'checks', PREVIOUS_DIR)
  await fs.rm(to, { recursive: true, force: true })
  await fs.mkdir(to, { recursive: true })
  const check = JSON.parse(await fs.readFile(path.join(previous.runDir, 'run.json'), 'utf8')).fullVerification?.check?.result
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
export async function fullVerificationDrive ({ target, workspace, runDir, runId, project, stage, verificationDir, clock, signal = null, platform, onDriveWait = null, drive = runChecks }) {
  const check = await drive({ target, revision: null, base: true, dirName: DRIVE_DIR, baseCommit: workspace.baseCommit, workspacePath: workspace.path, gitDir: workspace.gitDir ?? null,
    runDir, clock, signal, platform, runId, onDriveWait })
  const previous = await previousGreen({ verificationDir, project, stage, exceptRunId: runId })
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
