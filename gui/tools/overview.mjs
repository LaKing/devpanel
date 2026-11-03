#!/usr/bin/env node
/*
 * The run outcome metrics, read-only: prints the same overview the top-level
 * supervisor reads (server/supervisor-overview.mjs) as JSON, with the moment it
 * was taken (generatedAt) and what it covers (scope).
 *
 *   npm run overview                                every project, archived history included
 *   npm run overview -- --project devpanel-project  one project (repeatable)
 *
 * It reads the projects root (DEVPANEL_PROJECTS_DIR) and the issue store
 * (DEVPANEL_ISSUES_DIR, packed archives included) and writes nothing: no
 * session, no run, no ledger line. Nothing here imports an adapter, the engine
 * or the run supervisor.
 */
import { ISSUES_DIR, listIssues, listProjects } from '../server/issues.js'
import { buildOverview } from '../server/supervisor-overview.mjs'
import { stagingPendingReport } from '../server/staging-coverage.mjs'
import { openDependencies } from '../server/issue-dependencies.mjs'
import { loadConfig } from '../server/config/load.mjs'
import { projectPath, projectsRoot } from '../server/project-path.mjs'

const USAGE = 'usage: npm run overview [-- --project <id> ...]'
const args = process.argv.slice(2)
const named = []
// Strict parsing: a mistyped flag silently ignored would report every project
// while the caller believes it filtered.
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') { console.error(USAGE); process.exit(0) }
  if (args[i] !== '--project' || !args[i + 1] || args[i + 1].startsWith('--')) {
    console.error(args[i] === '--project' ? '--project needs a project id' : `unknown argument: ${args[i]}`)
    console.error(USAGE)
    process.exit(2)
  }
  // A project named twice is read once: totals would otherwise count its runs twice.
  if (!named.includes(args[i + 1])) named.push(args[i + 1])
  i++
}

const known = (await listProjects()).map((p) => p.id)
const unknown = named.filter((p) => !known.includes(p))
if (unknown.length) {
  console.error(`no such project: ${unknown.join(', ')} (projects under ${projectsRoot()}: ${known.join(', ') || 'none'})`)
  process.exit(2)
}
const projects = named.length ? named : known

// One reading of the configuration, however many projects ask about it.
let config = null
const { generatedAt, ...overview } = await buildOverview({ projects, listIssues: (p, o) => listIssues(p, o), openDependencies,
  stagingPending: (project, lists) => stagingPendingReport({ project, projectPath: projectPath(project), lists, config: config ??= loadConfig({ root: process.env.DEVPANEL_CONFIG_ROOT }), listIssues: (p, o) => listIssues(p, o) }) })
console.log(JSON.stringify({
  generatedAt,
  scope: {
    projects,
    selected: named.length ? 'named' : 'all',
    projectsRoot: projectsRoot(),
    issuesDir: ISSUES_DIR,
    archived: 'included',
    means: 'the projects read, from the projects root and the issue store named here; open and archived (packed included) issues and every run under them, as they stood at generatedAt'
  },
  ...overview
}, null, 2))
