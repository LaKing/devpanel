#!/usr/bin/env node
/*
 * One consult from the command line (docs/consult.md): the question is put to
 * the panel's two seats, which read the project read-only, and the result is
 * printed as JSON.
 *
 *   npm run --silent consult -- --project <id> --question <file> [--issue <id>] [--run <id>]
 *       [--recommendation <text>] [--reason <text>] [--mode brief] [--plan]
 *
 * PAID: it launches the installed CLIs of the panel's models, so it refuses
 * without DEVPANEL_LIVE=1 unless --plan is given, which prints the seats, what
 * they could read and the prompt, and invokes nothing. It has no spending
 * ledger (that is the running panel's): the cost is on the printed result. The
 * record is kept under issues/.supervisor/consults/, so the same question asked
 * twice is answered from it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { ISSUES_DIR } from '../server/issues.js'
import { loadConfig } from '../server/config/load.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'
import { createConsult } from '../server/consult/consult.mjs'
import { loadPanel, resolveSeats } from '../server/consult/panel.mjs'
import { decidePrompt, briefPrompt } from '../server/consult/prompt.mjs'
import { projectFiles, relatedProjects } from '../server/consult/related.mjs'
import { consultRoots } from '../server/consult/roots.mjs'
import { optionsFor } from '../server/consult/rule.mjs'
import { createAvailabilityStore } from '../server/runtime/failure.mjs'

const USAGE = 'usage: npm run consult -- --project <id> --question <file> [--issue <id>] [--run <id>] [--recommendation <text>] [--reason <text>] [--mode brief] [--plan]'
const VALUE = ['--project', '--question', '--issue', '--run', '--recommendation', '--reason', '--mode']
const args = process.argv.slice(2)
const given = {}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan') { given.plan = true; continue }
  if (!VALUE.includes(args[i]) || args[i + 1] === undefined) { console.error(`unknown or incomplete argument: ${args[i]}`); console.error(USAGE); process.exit(2) }
  given[args[i].slice(2)] = args[++i]
}
if (!given.project || !given.question) { console.error(USAGE); process.exit(2) }
if (given.mode && !['brief', 'decide'].includes(given.mode)) { console.error('--mode is brief or decide'); process.exit(2) }

const config = await loadConfig()
const question = (await fs.readFile(given.question, 'utf8')).trim()
const issueDir = given.issue ? path.join(ISSUES_DIR, given.project, given.issue) : null
if (issueDir && !await fs.stat(issueDir).then((s) => s.isDirectory(), () => false)) { console.error(`no such issue: ${given.project}/${given.issue}`); process.exit(2) }
let worktree = null
if (given.run) {
  if (!issueDir) { console.error('--run needs --issue'); process.exit(2) }
  const run = JSON.parse(await fs.readFile(path.join(issueDir, 'runs', given.run, 'run.json'), 'utf8'))
  worktree = run.workspace?.state === 'removed' ? null : run.workspace?.path ?? null
}
const request = {
  key: `cli:${given.project}:${given.issue ?? ''}:${given.run ?? ''}`, mode: given.mode ?? 'decide', question,
  reason: given.reason ?? null, recommendation: given.recommendation ?? null, askedBy: { role: 'operator' },
  project: given.project, issueDir, worktree
}
const related = relatedProjects(config.projects, given.project)

if (given.plan) {
  const panel = await loadPanel()
  if (!panel) { console.error('no consult panel is configured (consult/panel.yaml)'); process.exit(1) }
  const { seats, problems } = await resolveSeats(panel, { roster: config.roster })
  const roots = await consultRoots({ project: given.project, issueDir, worktree, related, files: projectFiles(config.projects, given.project), panel })
  const prompt = (request.mode === 'brief' ? briefPrompt : decidePrompt)({ request, options: optionsFor(request), roots: roots.roots, scratchDir: '<scratch>', language: hostSettings().operatorLanguage })
  console.log(JSON.stringify({ plan: true, mode: request.mode, seats: seats.map((s) => ({ seat: s.seat, model: s.model.id, harness: s.model.harness, effort: s.effort })), problems, cwd: roots.cwd, roots: roots.roots, masks: roots.masks, prompt }, null, 2))
  process.exit(problems.length ? 1 : 0)
}
if (process.env.DEVPANEL_LIVE !== '1') { console.error('a consult launches real model turns: set DEVPANEL_LIVE=1, or pass --plan to see what it would do'); process.exit(2) }

const service = createConsult({
  loadRoster: async () => config.roster,
  relatedOf: async (project) => relatedProjects(config.projects, project),
  filesOf: async (project) => projectFiles(config.projects, project),
  availability: createAvailabilityStore(path.join(ISSUES_DIR, '.availability.json'))
})
const result = await service.consult(request, { callerDir: path.join(ISSUES_DIR, '.supervisor') })
console.log(JSON.stringify(result, null, 2))
process.exit(result.outcome === 'unavailable' ? 1 : 0)
