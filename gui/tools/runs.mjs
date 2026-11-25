#!/usr/bin/env node
/*
 * One JSON line per run of a project, read-only (server/run-export.mjs): the
 * per-run measurements the overview only totals, the cause each run stopped on
 * and the next run of the same issue, for cohort analysis.
 *
 *   npm run --silent runs -- --project devpanel-project
 *   npm run --silent runs -- --project devpanel-project --from 2026-11-01 --to 2026-11-24
 *
 * --from and --to are UTC: a day (YYYY-MM-DD, inclusive) or an ISO time ending in Z.
 * Open and packed (archived) issues are both read. An input that cannot be read is
 * one {"unreadable": <path>, "error": ...} line; the last line is {"totals": ...}.
 *
 * It reads the issue store (DEVPANEL_ISSUES_DIR) and writes nothing: no session, no
 * run, no ledger line. Exit 2 for arguments, 1 when the project has no directory at
 * all, else 0, whatever could not be read.
 */
import { ISSUES_DIR } from '../server/issues.js'
import { exportRuns, isProjectId, validTimestamp } from '../server/run-export.mjs'

const USAGE = 'usage: npm run --silent runs -- --project <id> [--from <utc>] [--to <utc>]'
const DAY = 86_400_000
const refuse = (message) => { console.error(message); console.error(USAGE); process.exit(2) }

const args = process.argv.slice(2)
const given = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') { console.error(USAGE); process.exit(0) }
  if (!['--project', '--from', '--to'].includes(args[i])) refuse(`unknown argument: ${args[i]}`)
  const name = args[i].slice(2)
  if (!args[i + 1] || args[i + 1].startsWith('--')) refuse(`${args[i]} needs a value`)
  if (name in given) refuse(`${args[i]} given twice`)
  given[name] = args[i + 1]
  i++
}
if (!given.project) refuse('--project is required')
if (!isProjectId(given.project)) refuse(`not a project id: ${given.project}`)

const instant = (name, endOfDay) => {
  const value = given[name]
  if (value === undefined) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`)
    // Round-tripped: 2026-02-31 is no day at all.
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) refuse(`--${name} is not a date: ${value}`)
    return day.getTime() + (endOfDay ? DAY - 1 : 0)
  }
  // A UTC time that names the instant written: 2026-02-31T12:00:00Z is no time at all, not March 3.
  const at = value.endsWith('Z') && validTimestamp(value) ? Date.parse(value) : NaN
  if (!Number.isFinite(at)) refuse(`--${name} is neither a UTC day (YYYY-MM-DD) nor a UTC time ending in Z: ${value}`)
  return at
}
const from = instant('from', false)
const to = instant('to', true)
if (from != null && to != null && from > to) refuse('--from is after --to')

let result
try {
  result = await exportRuns({ issuesDir: ISSUES_DIR, project: given.project, from, to })
} catch (error) {
  // Never an abort: what went wrong is a line like any other input that did not read.
  console.log(JSON.stringify({ unreadable: ISSUES_DIR, error: String(error?.message ?? error) }))
  process.exit(0)
}
if (result.missing) {
  console.error(`no directory for project ${given.project} under ${ISSUES_DIR} (neither ${given.project}/ nor .archive/${given.project}/)`)
  process.exit(1)
}
process.stdout.write(result.lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
