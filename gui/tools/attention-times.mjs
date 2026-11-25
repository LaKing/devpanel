#!/usr/bin/env node
/*
 * Time to response, read-only (docs/operator-alerts.md "Time to response"): every wait on a person that began in
 * a period (owner questions, triage questions, recoveries) with when it entered the waiting state and when it was
 * handled, from the run records, and whether an alert was accepted for it. Medians before and after alerts were
 * installed and by alerted; open and unrecorded waits counted apart, never guessed.
 *
 *   npm run --silent attention-times -- [--from <utc>] [--to <utc>] [--project <id>]
 *
 * Reads the issue store (packed archives included, journal findings overlaid as the inbox reads them), the top-level
 * supervisor's questions from its state and archived sessions, and issues/.notifications/; writes nothing.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ISSUES_DIR, listIssues, listProjects, readRunRecords } from '../server/issues.js'
import { collectWaits, supervisorQuestionHistory } from '../server/notifications/waits.mjs'

const USAGE = 'usage: npm run --silent attention-times -- [--from <utc>] [--to <utc>] [--project <id>]'
const opts = { from: null, to: null, project: null }
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const name = args[i].replace(/^--/, '')
  if (args[i] === '--help') { console.error(USAGE); process.exit(0) }
  if (!(name in opts) || !args[i + 1] || args[i + 1].startsWith('--')) { console.error(`unknown or incomplete argument: ${args[i]}`); console.error(USAGE); process.exit(2) }
  opts[name] = args[++i]
}
for (const k of ['from', 'to']) if (opts[k] && !Number.isFinite(Date.parse(opts[k]))) { console.error(`--${k} is not a date: ${opts[k]}`); process.exit(2) }

const dir = path.join(ISSUES_DIR, '.notifications')
const state = await fs.readFile(path.join(dir, 'state.json'), 'utf8').then(JSON.parse, () => null)
const alerted = new Map()
const text = await fs.readFile(path.join(dir, 'deliveries.jsonl'), 'utf8').catch(() => '')
for (const line of text.split('\n')) {
  let l
  try { l = JSON.parse(line) } catch { continue }
  if (l.outcome === 'accepted') for (const k of l.keys ?? []) if (!alerted.has(k) || l.endedAt < alerted.get(k)) alerted.set(k, l.endedAt)
}
const questions = await supervisorQuestionHistory(process.env.DEVPANEL_SUPERVISOR_DIR ?? path.join(ISSUES_DIR, '.supervisor'))
const result = await collectWaits({ listProjects, listIssues, readRunRecords: (p, i, options) => readRunRecords(p, i, { ...options, journal: true }), questions, alerted, installedAt: state?.installedAt ?? null,
  from: opts.from && new Date(opts.from).toISOString(), to: opts.to && new Date(opts.to).toISOString(), project: opts.project })
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2))
