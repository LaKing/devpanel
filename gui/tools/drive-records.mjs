#!/usr/bin/env node
/*
 * The test drives that began in a period, read-only, as JSON: drive time, slot
 * wait and result per drive, to set beside a host's samples
 * (docs/project-infrastructure.md "Measuring a host during concurrent drives").
 *
 *   npm run --silent drive-records -- --project <id> [--project <id>] --from <utc> --to <utc>
 *
 * A run keeps its drives in several places, and a revision's evidence leaves
 * `checkResults` when the next revision comes: this reads them all from
 * run.json, or the bundle's <id>.runs.json once packed. It writes nothing.
 * Nothing here imports an adapter, the engine or the run supervisor.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { ISSUES_DIR } from '../server/issues.js'

const USAGE = 'usage: npm run --silent drive-records -- --project <id> [--project <id>] --from <utc> --to <utc>'
const args = process.argv.slice(2)
const projects = []
let from = null, to = null
// Strict parsing: a mistyped flag silently ignored would report something other than was asked.
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--help') { console.error(USAGE); process.exit(0) }
  if (!['--project', '--from', '--to'].includes(args[i]) || !args[i + 1]) { console.error(`bad argument: ${args[i]}`); console.error(USAGE); process.exit(2) }
  if (args[i] === '--project') projects.push(args[i + 1])
  else if (args[i] === '--from') from = Date.parse(args[i + 1])
  else to = Date.parse(args[i + 1])
}
if (!projects.length || !Number.isFinite(from) || !Number.isFinite(to) || projects.some((p) => p.includes('/') || p.startsWith('.'))) { console.error(USAGE); process.exit(2) }

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
// Where an unpacked run's directory is; a packed run's snapshot stays in its bundle.
const runDirs = new WeakMap()
const listDir = (dir) => fs.readdir(dir).catch(() => [])

/** Every run record of a project: live issues' run.json, then packed issues' bundles. */
async function runRecords (project) {
  const records = []
  const issuesDir = path.join(ISSUES_DIR, project)
  for (const issue of await listDir(issuesDir)) {
    if (issue.startsWith('.')) continue
    for (const run of await listDir(path.join(issuesDir, issue, 'runs'))) {
      // runs/ also holds worktrees, which have no run.json.
      const record = await readJson(path.join(issuesDir, issue, 'runs', run, 'run.json')).catch((error) => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : { unreadable: `${issue}/${run}: ${error.message}` })
      if (record) {
        records.push(record)
        runDirs.set(record, path.join(issuesDir, issue, 'runs', run))
      }
    }
  }
  const packed = path.join(ISSUES_DIR, '.archive', project)
  for (const name of await listDir(packed)) if (name.endsWith('.runs.json')) records.push(...await readJson(path.join(packed, name)))
  return records
}

/**
 * One run's drives; a drive named by several of its records appears once. Each
 * carries `target` where its record says or a slot proves it; `kinds` is what the
 * run's records say of its target, because the history keeps none.
 */
function drivesOf (run) {
  const drives = []
  const kinds = new Set()
  const add = (c, kind) => {
    // A carried result and a base reused from the cache are another drive's times.
    if (!c?.at || c.carriedFrom || c.reused) return
    if (c.target) kinds.add(c.target)
    // The history names only a retried revision's last directory: without two to compare, the interval decides.
    if (drives.some((d) => d.at === c.at && (d.dir && c.dir ? d.dir === c.dir : d.durationMs === c.durationMs))) return
    const wait = c.driveSlot?.waitMs ?? (c.dir ? (run.driveSlotWaits ?? []).filter((w) => w.dir === c.dir).reduce((sum, w) => sum + (Date.parse(w.to) - Date.parse(w.from)), 0) : null)
    // Only a remote drive takes a slot.
    drives.push({ at: c.at, kind, target: c.target ?? (c.driveSlot || wait > 0 ? 'ssh' : null), tier: c.tier ?? null, dir: c.dir ?? null, result: c.result ?? null, gating: c.gating ?? null,
      durationMs: c.durationMs ?? null, waitMs: wait, driveMs: typeof c.durationMs === 'number' && wait != null ? c.durationMs - wait : null,
      host: c.driveSlot?.host ?? null, cap: c.driveSlot?.cap ?? null,
      failed: (c.commands ?? []).filter((x) => x.passed === false && x.required !== false).map((x) => x.id),
      timedOut: (c.commands ?? []).filter((x) => x.timedOut).map((x) => x.id),
      ...(c.continuedFrom ? { continuedFromSmoke: true } : {}), ...(c.unfinished ? { unfinished: true } : {}) })
  }
  const withAttempts = (c, kind) => {
    for (const a of c?.attempts ?? []) add({ ...a, tier: c.tier, target: c.target }, kind)
    add(c, kind)
  }
  for (const c of [...(run.checkResults ?? []), ...(run.priorCheckResults ?? []), ...(run.reconciliations ?? []).map((r) => r.checks)]) withAttempts(c, 'candidate')
  for (const b of run.baselineChecks ?? []) withAttempts(b, 'base')
  for (const d of run.diagnosticDrives ?? []) withAttempts(d, 'diagnostic')
  // An earlier revision's drives: the history keeps each one's interval, and only
  // the last one's directory and result. What it does not keep stays null.
  for (const h of run.checkHistory ?? []) {
    const runs = h.runs ?? []
    runs.forEach((r, i) => {
      const last = i === runs.length - 1
      add({ at: r.at, durationMs: r.durationMs, tier: h.tier, ...(last ? { dir: h.dir, result: h.result, gating: h.gating, continuedFrom: h.continuedFrom } : {}) }, 'candidate')
    })
  }
  return { drives, kinds }
}

/**
 * A drive's target when its own record does not say: the one kind everything about
 * the run agrees on (its records, its refreshes, its snapshot), else null. A refresh
 * replaces the target, so without the snapshot a refreshed run's first target is unknown.
 */
async function runTarget (run, kinds) {
  const refreshes = [run.checkRefresh, ...(run.checkRefreshHistory ?? [])].filter(Boolean)
  const evidence = new Set([...kinds, ...refreshes.map((r) => r.target?.kind).filter(Boolean)])
  const dir = runDirs.get(run)
  const original = dir ? (await readJson(path.join(dir, 'resolved-playbook.json')).catch(() => null))?.checks?.target?.kind : null
  if (original) evidence.add(original)
  else if (refreshes.length) return null
  return evidence.size === 1 ? [...evidence][0] : null
}

const count = (list, key) => list.reduce((into, d) => { const k = String(d[key]); into[k] = (into[k] ?? 0) + 1; return into }, {})
const mean = (values) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null

const drives = []
const targetUnknown = []
const unreadable = []
for (const project of projects) {
  for (const run of await runRecords(project)) {
    if (run.unreadable) { unreadable.push(run.unreadable); continue }
    const { drives: ofRun, kinds } = drivesOf(run)
    const inPeriod = ofRun.filter((d) => Date.parse(d.at) >= from && Date.parse(d.at) <= to)
    const fallback = inPeriod.some((d) => !d.target) ? await runTarget(run, kinds) : null
    for (const drive of inPeriod) {
      const target = drive.target ?? fallback
      // A local check runs on the panel host, so it says nothing of a staging host.
      if (target === 'local') continue
      const named = { project, issue: run.issue?.id ?? null, run: run.runId ?? null, ...drive, target }
      if (target) drives.push(named)
      else targetUnknown.push(named)
    }
  }
}
drives.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

// Drive time only compares like with like: a smoke is not a full drive, a full
// drive continuing a smoke's instance runs less of it, and a failed one stops anywhere.
const tierOf = (d) => `${d.tier ?? 'full'}${d.continuedFromSmoke ? '+continued' : ''}`
const byTier = {}
for (const tier of new Set(drives.map(tierOf))) {
  const of = drives.filter((d) => tierOf(d) === tier)
  const judged = of.filter((d) => d.result)
  const driveMs = judged.filter((d) => d.result === 'passed').map((d) => d.driveMs).filter((v) => typeof v === 'number')
  const waitMs = of.map((d) => d.waitMs).filter((v) => typeof v === 'number')
  byTier[tier] = { drives: of.length, byResult: count(judged, 'result'), resultNotKept: of.length - judged.length,
    notPassed: { count: judged.filter((d) => d.result !== 'passed').length, of: judged.length },
    passedDriveMs: { mean: mean(driveMs), max: driveMs.length ? Math.max(...driveMs) : null, of: driveMs.length },
    waitMs: { mean: mean(waitMs), max: waitMs.length ? Math.max(...waitMs) : null, of: waitMs.length, waited: waitMs.filter((v) => v > 0).length } }
}
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  scope: { projects, from: new Date(from).toISOString(), to: new Date(to).toISOString(), issuesDir: ISSUES_DIR,
    means: 'remote drives of these projects that began in the period, by the panel clock, from the run records at generatedAt: a drive not yet finished is not recorded yet, and local checks are left out. durationMs includes waitMs; driveMs is the drive without the slot wait; null is not recorded, never 0. targetUnknown holds drives whose records do not say remote or local, in no total' },
  totals: { drives: drives.length, byKind: count(drives, 'kind'), byCap: count(drives, 'cap'), byHost: count(drives, 'host'), byTier },
  ...(targetUnknown.length ? { targetUnknown } : {}),
  ...(unreadable.length ? { unreadable } : {}),
  drives
}, null, 2))
