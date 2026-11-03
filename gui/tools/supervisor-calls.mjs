#!/usr/bin/env node
/*
 * Calls per started run for a stated period, read-only: the top-level supervisor's model calls from the spending
 * ledger, over the runs it started in that period, so a before and an after are computed the same way.
 *
 *   npm run --silent supervisor-calls -- --from 2026-10-26 --to 2026-11-01
 *
 * Both days are inclusive, in UTC, as the ledger's windows are. It reads the ledger (DEVPANEL_SUPERVISOR_DIR, else
 * <issues>/.supervisor) and the run records of the issues named there, and writes nothing: no session, no run, no
 * ledger line. It does not load the ledger through createLedger: load() repairs a torn tail in the file.
 *
 * Exit 2 for arguments, 1 for a ledger that cannot be read or a damaged line. A missing ledger is an answer
 * (`coverage: none`), not a failure.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { ISSUES_DIR, getIssue } from '../server/issues.js'
import { parseLedger } from '../server/runtime/ledger.mjs'
import { packedRunsOf, runsOf } from '../server/supervisor-overview.mjs'

const USAGE = 'usage: npm run --silent supervisor-calls -- --from YYYY-MM-DD --to YYYY-MM-DD'
const refuse = (message) => { console.error(message); console.error(USAGE); process.exit(2) }

const args = process.argv.slice(2)
const given = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') { console.error(USAGE); process.exit(0) }
  if (!['--from', '--to'].includes(args[i])) refuse(`unknown argument: ${args[i]}`)
  if (!args[i + 1] || args[i + 1].startsWith('--')) refuse(`${args[i]} needs a date`)
  given[args[i].slice(2)] = args[i + 1]
  i++
}
const day = (name) => {
  const value = given[name]
  if (!value) refuse(`--${name} is required`)
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null
  // Round-tripped: 2026-02-31 parses to March in some readings and is no day at all.
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) refuse(`--${name} is not a date: ${value}`)
  return parsed.getTime()
}
const fromMs = day('from'), toMs = day('to') + 86_400_000 - 1
if (fromMs > toMs) refuse('--from is after --to')

const file = path.join(process.env.DEVPANEL_SUPERVISOR_DIR ?? path.join(ISSUES_DIR, '.supervisor'), 'ledger.jsonl')
let text = null
try { text = await fs.readFile(file, 'utf8') } catch (error) {
  if (error.code !== 'ENOENT') { console.error(`cannot read ${file}: ${error.message}`); process.exit(1) }
}
let parsed = { entries: [], tail: '', tailEntry: null }
if (text !== null) {
  try { parsed = parseLedger(text, file) } catch (error) { console.error(error.message); process.exit(1) }
}
const entries = parsed.tailEntry ? [...parsed.entries, parsed.tailEntry] : parsed.entries

// The ledger's own replay, kept to what is counted here: a reservation and how it ended.
const reservations = new Map()
const wakes = []
for (const entry of entries) {
  if (entry.kind === 'reserve') reservations.set(entry.id, { ...entry, settled: null, released: null })
  else if (entry.kind === 'settle') { if (reservations.has(entry.id)) reservations.get(entry.id).settled = entry }
  else if (entry.kind === 'release') { if (reservations.has(entry.id)) reservations.get(entry.id).released = entry }
  else if (entry.kind === 'wake') wakes.push(entry)
}
const within = (entry) => { const at = Date.parse(entry.at ?? ''); return at >= fromMs && at <= toMs }
const stamps = entries.map((e) => Date.parse(e.at ?? '')).filter(Number.isFinite)
const firstAt = stamps.length ? Math.min(...stamps) : null, lastAt = stamps.length ? Math.max(...stamps) : null
const coverage = firstAt === null ? 'none' : firstAt > fromMs || lastAt < fromMs || toMs > Date.now() ? 'partial' : 'complete'

const inPeriod = [...reservations.values()].filter(within)
const ofSubject = (subject) => inPeriod.filter((r) => r.subject === subject)
const calls = ofSubject('model-call')

/** An attempt with no ending on the ledger is a live run or an uncertain launch; only a run carrying its launch id says which. */
async function carriedByARun ({ id, meta }) {
  if (!meta?.project || !meta?.issueId) return false
  const issue = await getIssue(meta.project, meta.issueId).catch(() => null)
  if (!issue) return false
  const runs = issue.packed ? await packedRunsOf(meta.project, meta.issueId) : await runsOf(issue.path)
  return runs.some((run) => run.supervisorLaunchId === id)
}
const starts = { reserved: 0, started: 0, neverStarted: 0, uncertain: 0 }
for (const attempt of ofSubject('run-start')) {
  starts.reserved++
  if (attempt.released) starts.neverStarted++
  else if (attempt.settled || await carriedByARun(attempt)) starts.started++
  else starts.uncertain++
}
// Reads the same for a call Stop kept from the adapter (older code settled those at 0) and a real one reported at
// exactly 0: left out of the figure in every period, so a before and an after are computed alike, and counted.
const atZero = (r) => r.settled?.costKnown === true && r.settled.costUsdMicros === 0
const own = calls.filter((r) => !r.released && !r.meta?.side)
const supervisor = own.filter((r) => !atZero(r)).length

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  period: { from: given.from, to: given.to, timezone: 'UTC', inclusive: true },
  ledger: {
    file, entries: entries.length, firstAt: firstAt === null ? null : new Date(firstAt).toISOString(), lastAt: lastAt === null ? null : new Date(lastAt).toISOString(),
    ...(parsed.tail && !parsed.tailEntry ? { tornTail: true } : {}),
    coverage,
    means: 'none: nothing recorded. partial: the ledger begins after the period starts, ends before it, or the period has not ended, so the counts may be short. complete: the ledger spans the start of a period that has ended; it cannot prove the supervisor ran throughout.'
  },
  calls: {
    supervisor,
    sideQuestions: calls.filter((r) => !r.released && r.meta?.side).length,
    notStarted: calls.filter((r) => r.released).length,
    settledAtZero: own.filter(atZero).length,
    decisions: ofSubject('decision').filter((r) => !r.released).length
  },
  wakes: wakes.filter(within).length,
  starts,
  callsPerStartedRun: {
    of: supervisor, total: starts.started, perRun: starts.started ? Math.round((supervisor / starts.started) * 100) / 100 : null,
    means: 'the supervisor\'s own model calls reserved in the period (repair and action-result turns included; side questions, calls that never reached a runtime, and calls.settledAtZero are not: such a line is a call Stop kept from the adapter or a real one reported at exactly 0, and the ledger cannot say which, so the figure is low by at most that many) over the runs it started in the period (a reservation that ended settled, or that a run record carries as its supervisorLaunchId). Runs an operator started are not counted, and a run that started in the period may spend calls after it. perRun is null when nothing started, and unknown is not zero.'
  }
}, null, 2))
