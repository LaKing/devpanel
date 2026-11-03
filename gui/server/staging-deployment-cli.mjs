#!/usr/bin/env node
import { CONFIG_ROOT } from './config/load.mjs'
import * as issues from './issues.js'
import { deployStaging, deploymentReport } from './staging-deployment.mjs'
import { deploymentCoverage, writeDeploymentNotes } from './staging-coverage.mjs'
import { projectPath } from './project-path.mjs'

const [project, issueId, ...extra] = process.argv.slice(2)
if (!project || !issueId || (extra.length && !(extra.length === 2 && extra[0] === '--retry-failed' && extra[1]))) throw new Error('Usage: node gui/server/staging-deployment-cli.mjs <project> <issue-id> [--retry-failed <operation-id>]')
const issue = await issues.getIssue(project, issueId)
if (issue.archived) throw new Error('Cannot deploy for an archived issue')
const { listRuns } = await import('./runs-api.mjs')
const runs = await listRuns(issue.path)
if (runs.some(r => ['pending', 'preflighting', 'running', 'stopping'].includes(r.status))) throw new Error('Stop the active issue run before deploying shared staging')
const controller = new AbortController()
const stop = () => controller.abort()
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  const result = await deployStaging({ project, issuePath: issue.path, root: process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT, signal: controller.signal, retryFailed: extra[1] ?? null,
    coverage: deploymentCoverage({ project, projectPath: projectPath(project), listIssues: (p, o) => issues.listIssues(p, o) }) })
  const report = deploymentReport(result)
  const note = await issues.createStep(project, issueId, { name: 'staging-deployment', text: report, format: 'md', invocationId: `staging-deployment:${result.id}` })
  await writeDeploymentNotes({ project, issue, operation: result, issues })
  console.log(JSON.stringify({ status: result.status, operationId: result.id, note: note.number, replayed: result.replayed ?? false }))
  if (result.status !== 'completed') process.exitCode = 1
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
