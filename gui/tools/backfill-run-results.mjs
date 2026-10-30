#!/usr/bin/env node
/*
 * One-off: give every run that ended before result entries existed its
 * `NNN-result/` step (server/run-result-step.mjs). Dry run unless --apply.
 *
 *   node tools/backfill-run-results.mjs            list what would be written
 *   node tools/backfill-run-results.mjs --apply    write them
 *   node tools/backfill-run-results.mjs --apply --rewrite
 *                                                  also rewrite existing entries in the current format
 *
 * Only runs that have ended (completed, blocked, failed, cancelled) and have
 * no result entry yet. An issue's missing results are written oldest run
 * first; step numbers only grow, so they land after the issue's newest step
 * (the folder view still files each under its own run). Archived issues are
 * skipped — the server refuses writes into them — and counted. A run being
 * written by a live process is skipped: its end writes its own entry.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeRunResultStep } from '../server/run-result-step.mjs'
import { issuesRoot } from '../server/project-path.mjs'
import { archiveState } from '../server/issue-archive.mjs'

const ISSUES = issuesRoot()
const apply = process.argv.includes('--apply')
const rewrite = process.argv.includes('--rewrite')
const ENDED = ['completed', 'blocked', 'failed', 'cancelled']

const dirs = async (p) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
const json = (file) => fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null)

let written = 0; let skippedArchived = 0; let failed = 0
for (const project of await dirs(ISSUES)) {
  for (const issueName of await dirs(path.join(ISSUES, project))) {
    const issuePath = path.join(ISSUES, project, issueName)
    if (!await json(path.join(issuePath, 'issue.json'))) continue
    const reservations = await json(path.join(issuePath, '.step-reservations.json')) ?? []
    const have = new Set(reservations.map((r) => /^run-result:(.+)$/.exec(r?.invocationId ?? '')?.[1]).filter(Boolean))
    const runs = []
    for (const runId of await dirs(path.join(issuePath, 'runs'))) {
      if (runId.startsWith('worktree-') || runId.startsWith('workspace-') || (have.has(runId) && !rewrite)) continue
      const run = await json(path.join(issuePath, 'runs', runId, 'run.json'))
      if (run && ENDED.includes(run.status)) runs.push({ runId, startedAt: run.startedAt ?? '', status: run.status })
    }
    if (!runs.length) continue
    if (await archiveState(issuePath)) { skippedArchived += runs.length; continue }
    for (const r of runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      const label = `${project}/${issueName} ${r.runId} (${r.status})`
      if (!apply) { console.log(`would write  ${label}`); written++; continue }
      try {
        const folder = await writeRunResultStep({ issuePath, runId: r.runId })
        console.log(`wrote ${path.basename(folder)}  ${label}`)
        written++
      } catch (error) {
        console.log(`FAILED  ${label}: ${error.message}`)
        failed++
      }
    }
  }
}
console.log(`\n${apply ? 'Wrote' : 'Would write'} ${written} result entr${written === 1 ? 'y' : 'ies'}${failed ? `, ${failed} failed` : ''}; ${skippedArchived} run(s) in archived issues skipped.${apply ? '' : ' Run with --apply to write them.'}`)
