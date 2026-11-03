#!/usr/bin/env node
/*
 * The record of selftest outcomes across drives, read-only, as JSON
 * (execution-contract.md "Unstable selftests").
 *
 *   npm run selftest-history -- --project <id>                 every test classified unstable, and what route 2 could not judge
 *   npm run selftest-history -- --project <id> --test <name>   that test's drives and its classification
 *
 * It reads issues/<project>/.selftest-history and writes nothing. Nothing here
 * imports an adapter, the engine or the run supervisor.
 */
import path from 'node:path'

import { ISSUES_DIR } from '../server/issues.js'
import { classifyAll, classifyTest, readDrives } from '../server/runtime/selftest-history.mjs'

const USAGE = 'usage: npm run selftest-history -- --project <id> [--test <name>]'
const args = process.argv.slice(2)
const options = {}
// Strict parsing: a mistyped flag silently ignored would report something other than was asked.
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--help') { console.error(USAGE); process.exit(0) }
  if (!['--project', '--test'].includes(args[i]) || !args[i + 1]) { console.error(`bad argument: ${args[i]}`); console.error(USAGE); process.exit(2) }
  options[args[i].slice(2)] = args[i + 1]
}
if (!options.project || options.project.includes('/') || options.project.startsWith('.')) { console.error(USAGE); process.exit(2) }

const dir = path.join(ISSUES_DIR, options.project, '.selftest-history')
const drives = await readDrives(dir)
const now = Date.now()
const generatedAt = new Date(now).toISOString()

if (options.test) {
  const seen = drives.flatMap((d) => (d.commands ?? []).flatMap((c) => {
    const outcome = c.failed?.includes(options.test) ? 'failed' : c.passed?.includes(options.test) ? 'passed' : null
    if (!outcome) return []
    const asNew = c.asNew?.find((n) => n.test === options.test)
    return [{ command: c.command, outcome, at: d.at, run: d.runId, issue: d.issueId, check: d.dir, kind: d.kind, revision: d.revision, baseCommit: d.baseCommit, treeIdentity: d.treeIdentity, ...(d.reused ? { reused: d.reused } : {}), ...(asNew ? { asNew: true, touch: asNew.touch } : {}) }]
  }))
  const commands = [...new Set(seen.map((s) => s.command))]
  console.log(JSON.stringify({ generatedAt, project: options.project, test: options.test, drives: seen,
    classification: commands.map((command) => ({ command, unstable: classifyTest({ drives, command, test: options.test, now }) })) }, null, 2))
} else {
  const unknown = {}
  for (const d of drives) for (const c of d.commands ?? []) for (const n of c.asNew ?? []) if (n.touch?.verdict === 'unknown') unknown[n.touch.reason] = (unknown[n.touch.reason] ?? 0) + 1
  console.log(JSON.stringify({ generatedAt, project: options.project, drives: drives.length, unstable: classifyAll(drives, { now }), newFailuresWithUnknownModule: unknown }, null, 2))
}
