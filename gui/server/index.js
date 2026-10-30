import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import express from 'express'
import { Server } from 'socket.io'

import { hostInfo, metricsSnapshot } from './metrics.js'
import * as issues from './issues.js'
import { setIssueDependencies } from './issue-dependencies.mjs'
import { attentionList } from './attention.mjs'
import {
  addStepFile, createIssue, createStep, getIssue, IssueError,
  listIssues, listProjects, MAX_FILE_BYTES, readStepFile
} from './issues.js'
import { certDir, logDir, projectPath } from './project-path.mjs'
import { loadToken, requireToken, socketAuth, tokenFile } from './auth.mjs'
import { localLogin, localLoginMiddleware } from './local-login.mjs'
import { getRun, listPlaybooks, listRuns, preview, readLiveOutput, readStepResponse } from './runs-api.mjs'
import { sourceState } from './staleness.mjs'
import { topSupervisorService } from './top-supervisor-service.mjs'
import { projectInfrastructure, inspectEnvironment } from './infrastructure.mjs'
import { readGrants, writeGrant, revokeGrant } from './broker/broker.mjs'
import { listProjectActions, readOperation, startProjectAction, stopProjectAction } from './project-actions.mjs'
import { createSupervisor } from './supervisor.mjs'
import { createOwnerInput } from './owner-input.mjs'
import { clientHost } from './opened-by.mjs'
import { identify, proxyActor } from './proxy-user.mjs'
import { reportRouter } from './report.mjs'
import { issueStats } from './issue-stats.mjs'
import { CONFIG_ROOT, loadDecisionProvider } from './decisions/index.mjs'
import { loadConfig } from './config/load.mjs'
import { hostSettings } from './config/host-settings.mjs'
import { createAdvisor, decisionProviderStatus } from './decisions/advisor.mjs'
import { createFailureAdvisor } from './decisions/failure-advisor.mjs'
import { createPregate } from './decisions/pregate.mjs'
import { triageAgreement } from './decisions/triage-shadow.mjs'
import { installLogging } from './logging.mjs'
import { LockHeld } from './runtime/lock.mjs'
import { integrateRun, integrationTarget, reconcileIntegration } from './runtime/integrate.mjs'
import { applyRunArtifact, retainedPatch } from './runtime/apply-artifact.mjs'
import { checkPatch } from './runtime/patch-check.mjs'
import { availabilityReport } from './availability-api.mjs'
import { createModelPerformanceService } from './model-performance.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
// DEVPANEL_DIST_DIR: a build outside the checkout (a seat builds into its
// scratch directory for the browser suite, so dist/ never enters a candidate).
const DIST = process.env.DEVPANEL_DIST_DIR ?? path.join(ROOT, 'dist')
const logger = installLogging({
  dir: logDir(),
  maxBytes: Number(process.env.DEVPANEL_LOG_MAX_BYTES ?? 10 * 1024 * 1024),
  backups: Number(process.env.DEVPANEL_LOG_BACKUPS ?? 5)
})
console.info('Service starting; file log:', logger.file)
// This installation's own defaults (docs/host-config.md "Host settings"). An invalid
// file stops the start rather than run on the neutral defaults; while a host move
// is pending, the carried copy is in force, and the log says so.
try {
  const settings = hostSettings()
  if (settings.pending) console.warn(`host move pending: host settings are read from ${settings.file}; run node tools/migrate-host-config.mjs`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const PORT = Number(process.env.PORT ?? 443)
// HOST is one bind address, or a comma-separated list of them (e.g. a LAN and a
// VPN address). A list binds the wildcard and drops every connection that did
// not arrive at one of the listed addresses.
const HOSTS = (process.env.HOST ?? '0.0.0.0').split(',').map((h) => h.trim()).filter(Boolean)
const HOST = HOSTS.length > 1 ? '0.0.0.0' : HOSTS[0] ?? '0.0.0.0'
const TICK_MS = Number(process.env.DEVPANEL_TICK_MS ?? 2000)

// TLS from <project>/cert/localhost.{crt,key} (make-cert.sh writes them).
// Set DEVPANEL_TLS=0 to serve plain HTTP instead.
const CERT_DIR = certDir()
const TLS_CERT = process.env.DEVPANEL_TLS_CERT ?? path.join(CERT_DIR, 'localhost.crt')
const TLS_KEY = process.env.DEVPANEL_TLS_KEY ?? path.join(CERT_DIR, 'localhost.key')
const TLS_ENABLED = process.env.DEVPANEL_TLS !== '0'

function readTlsMaterial () {
  if (!TLS_ENABLED) return null

  if (!fs.existsSync(TLS_CERT) || !fs.existsSync(TLS_KEY)) {
    console.error(`no certificate at ${TLS_CERT} — run ./make-cert.sh, or set DEVPANEL_TLS=0 to serve plain HTTP`)
    process.exit(1)
  }

  try {
    return { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }
  } catch (err) {
    console.error(`cannot read the certificate (${err.code}): ${err.message}`)
    process.exit(1)
  }
}

// In dev the Vue app is served by Vite on its own origin, so socket.io needs to
// accept it. In production the app is served from this origin and needs nothing.
const DEV_ORIGINS = (process.env.DEVPANEL_DEV_ORIGINS ??
  'https://localhost:5173,https://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

const app = express()
app.disable('x-powered-by')

// tokenFile is public so the sign-in page can say where the token is on THIS
// install (/srv on the Linux hosts, ~/devpanel on a Mac); the home directory is
// shown as ~ so an unauthenticated caller does not learn the account name.
const home = os.homedir()
const shownTokenFile = tokenFile().startsWith(home + path.sep) ? '~' + tokenFile().slice(home.length) : tokenFile()
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, at: Date.now(), uptime: Math.round(process.uptime()), tokenFile: shownTokenFile })
})

// Everything below the health check needs the token. Agent responses, prompts
// and delivery artifacts can all contain the project's own source, so this gate
// comes BEFORE any endpoint that could return them — not only before controls.
const TOKEN = await loadToken()
logger.addSecret(TOKEN)
// Before the gate on purpose: a private-network peer may open an issue and nothing else (report.mjs).
app.use(reportRouter({ createIssue, emit: (payload) => io.emit('issues:changed', payload) }))
app.use('/api', identify())
const LOCAL = localLogin({ host: HOSTS.length > 1 ? HOSTS.join(',') : HOST, port: PORT })
app.use('/api', localLoginMiddleware(LOCAL))
app.use('/api', requireToken(TOKEN))

// The issues directory is configured on its own (DEVPANEL_ISSUES_DIR), never derived from the projects root.
const info = () => hostInfo({ issuesDir: issues.ISSUES_DIR })
app.get('/api/info', (_req, res) => {
  res.json(info())
})

app.use(express.json({ limit: '2mb' }))
// The reverse proxy's basic-auth login, when there is one, is the actor of every request (proxy-user.mjs).
app.use('/api', proxyActor())
app.get('/api/whoami', (req, res) => res.json({ user: req.actor, verified: req.login?.verified === true }))

// Small wrapper so a rejected promise becomes a 500 instead of an unhandled
// rejection that takes the process down.
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)

app.get('/api/projects', route(async (_req, res) => {
  res.json(await listProjects())
}))

async function knownInfrastructureProject (project) {
  if (!(await listProjects()).some(p => p.id === project)) throw Object.assign(new Error('Unknown project'), { status: 404 })
}
app.get('/api/projects/:project/infrastructure', route(async (req, res) => {
  await knownInfrastructureProject(req.params.project)
  res.json(await projectInfrastructure(req.params.project, { root: process.env.DEVPANEL_CONFIG_ROOT }))
}))
app.get('/api/projects/:project/infrastructure/:environment/:resource', route(async (req, res) => {
  await knownInfrastructureProject(req.params.project)
  res.json(await inspectEnvironment(req.params, { root: process.env.DEVPANEL_CONFIG_ROOT }))
}))

/*
 * Project actions: checkpoint.sh and other operator scripts on the live checkout.
 * Starting one answers at once with the operation record; its output arrives
 * over the socket as `project:action` events and is re-readable by operation id.
 */
app.get('/api/projects/:project/actions', route(async (req, res) => {
  await knownInfrastructureProject(req.params.project)
  res.json(await listProjectActions(req.params.project, { root: process.env.DEVPANEL_CONFIG_ROOT }))
}))
app.post('/api/projects/:project/actions/:action', route(async (req, res) => {
  await knownInfrastructureProject(req.params.project)
  const { operation } = await startProjectAction({ project: req.params.project, actionId: req.params.action, root: process.env.DEVPANEL_CONFIG_ROOT, actor: req.actor ?? 'operator', emit: emitProjectAction })
  res.status(202).json({ operation })
}))
app.get('/api/projects/:project/actions/operations/:operationId', route(async (req, res) => {
  await knownInfrastructureProject(req.params.project)
  const after = Number.parseInt(req.query.after ?? '0', 10)
  res.json(await readOperation(req.params.project, req.params.operationId, { after: Number.isFinite(after) && after > 0 ? after : 0 }))
}))
app.post('/api/projects/:project/actions/operations/:operationId/stop', route(async (req, res) => {
  await knownInfrastructureProject(req.params.project)
  res.json({ operation: await stopProjectAction(req.params.project, req.params.operationId) })
}))

app.get('/api/projects/:project/issues', route(async (req, res) => {
  // Inquiries (Phase 4) are the supervisor's questions, not issues: listed only when asked for.
  const listed = await listIssues(req.params.project, { archived: req.query.archived === 'true' })
  res.json(req.query.inquiries === 'true' ? listed : listed.filter((issue) => issue.kind !== 'inquiry'))
}))

app.post('/api/projects/:project/issues', route(async (req, res) => {
  // Who opened it: the name the operator gave, at the machine they connected from.
  const issue = await createIssue(req.params.project, { name: req.body?.name, input: req.body?.input, openedBy: { user: req.body?.actor || 'operator', host: await clientHost(req) } })
  // Any other open panel should see it appear.
  io.emit('issues:changed', { reason: 'issue-created', project: issue.project, id: issue.id })
  res.status(201).json(issue)
}))

app.get('/api/projects/:project/issues/:id', route(async (req, res) => {
  res.json(await getIssue(req.params.project, req.params.id))
}))

// Where the issue came from, what came out of it, and what it waits for or holds up (issue-family.mjs).
app.get('/api/projects/:project/issues/:id/family', route(async (req, res) => {
  res.json(await issues.issueFamily(req.params.project, req.params.id))
}))

for (const action of ['archive', 'restore']) {
  app.post(`/api/projects/:project/issues/:id/${action}`, route(async (req, res) => {
    const { project, id } = req.params
    let issue
    try { issue = await issues.setIssueArchived(project, id, action === 'archive', { overrideReason: req.body?.overrideReason ?? null }) } catch (error) {
      if (error instanceof LockHeld) {
        throw new IssueError('This issue is busy. Stop its run and resolve any pending recovery before archiving or restoring.', 409)
      }
      throw error
    }
    io.emit('issues:changed', { reason: action === 'archive' ? 'issue-archived' : 'issue-restored', project, id })
    res.json(issue)
  }))
}

// An explicit decision about the issue, with evidence. Separate from archive
// (which hides) and from any run's outcome (which is the run's).
app.post('/api/projects/:project/issues/:id/disposition', route(async (req, res) => {
  const { project, id } = req.params
  const { value, evidence, runId = null, override = null, related = null } = req.body ?? {}
  const issue = await issues.setIssueDisposition(project, id, { value, evidence, runId, by: 'operator', override, related })
  io.emit('issues:changed', { reason: 'issue-disposition', project, id })
  res.json(issue)
}))

// Where an issue sits in the execution order. Distinct from severity, which is
// a technical fact, and from disposition, which is about the outcome.
app.post('/api/projects/:project/issues/:id/priority', route(async (req, res) => {
  const { project, id } = req.params
  const { value, reason } = req.body ?? {}
  const issue = await issues.setIssuePriority(project, id, { value, reason, by: 'operator' })
  io.emit('issues:changed', { reason: 'issue-priority', project, id })
  res.json(issue)
}))

// Prerequisites (issue-dependencies.mjs): the supervisor will not start an
// issue while one of these is open; an empty list clears them.
app.post('/api/projects/:project/issues/:id/dependencies', route(async (req, res) => {
  const { project, id } = req.params
  const { dependsOn, reason } = req.body ?? {}
  const issue = await setIssueDependencies(project, id, { dependsOn, reason, by: 'operator' })
  io.emit('issues:changed', { reason: 'issue-dependencies', project, id })
  res.json(issue)
}))

// Production data grants (Phase 3): operator only, per issue, for a declared
// deployment environment; checked by the broker on every call. The supervisor
// has no route here. Seats limit who may execute queries; results belong to
// the whole run.
app.get('/api/projects/:project/issues/:id/grants', route(async (req, res) => {
  res.json(await readGrants((await issues.getIssue(req.params.project, req.params.id)).path))
}))
app.post('/api/projects/:project/issues/:id/grants', route(async (req, res) => {
  const { project, id } = req.params
  const issue = await issues.getIssue(project, id)
  if (issue.packed) throw Object.assign(new Error('this issue is archived'), { status: 409 })
  const { environment, reason, expiresAt, seats = [], providers = 'any' } = req.body ?? {}
  const infra = await projectInfrastructure(project, { root: process.env.DEVPANEL_CONFIG_ROOT })
  if (!(infra?.deployments ?? []).some((d) => d.id === environment)) throw Object.assign(new Error(`${environment} is not a deployment environment of ${project}; staging is granted to the project by its configuration`), { status: 400 })
  if (!Array.isArray(seats) || seats.some((x) => typeof x !== 'string' || !/^[a-z0-9-]+$/.test(x))) throw Object.assign(new Error('seats must be a list of seat names'), { status: 400 })
  try {
    const grant = await writeGrant(issue.path, { environment, reason, expiresAt, seats, providers, by: 'operator' })
    io.emit('issues:changed', { reason: 'grant', project, id })
    res.json(grant)
  } catch (error) { throw Object.assign(error, { status: 400 }) }
}))
app.post('/api/projects/:project/issues/:id/grants/:grantId/revoke', route(async (req, res) => {
  const { project, id, grantId } = req.params
  const grant = await revokeGrant((await issues.getIssue(project, id)).path, grantId).catch((error) => { throw Object.assign(error, { status: 404 }) })
  io.emit('issues:changed', { reason: 'grant-revoked', project, id })
  res.json(grant)
}))

// Inquiries (Phase 4): the supervisor's questions. An operator may read, close,
// acknowledge and reopen them like the supervisor; the same rules apply.
app.get('/api/projects/:project/inquiries/:id', route(async (req, res) => {
  res.json(await supervisor.inquiryStatus({ project: req.params.project, inquiryId: req.params.id }))
}))
for (const action of ['close', 'acknowledge']) {
  app.post(`/api/projects/:project/inquiries/:id/${action}`, route(async (req, res) => {
    const { project, id } = req.params
    const { runId, reason = null } = req.body ?? {}
    const result = await supervisor.closeInquiry({ project, inquiryId: id, runId, reason, action, by: 'operator' })
    io.emit('issues:changed', { reason: `inquiry-${action}`, project, id })
    res.json(result)
  }))
}
app.post('/api/projects/:project/inquiries/:id/reopen', route(async (req, res) => {
  const { project, id } = req.params
  const result = await supervisor.reopenInquiry({ project, inquiryId: id, reason: req.body?.reason, by: 'operator' })
  io.emit('issues:changed', { reason: 'inquiry-reopen', project, id })
  res.json(result)
}))

// Where the issue's time went, across its runs: per seat and model, the
// coordinator, and how long it stood (server/issue-stats.mjs). Read-only.
app.get('/api/projects/:project/issues/:id/stats', route(async (req, res) => {
  const issue = await getIssue(req.params.project, req.params.id)
  const runs = await issues.readRunRecords(req.params.project, req.params.id)
  res.json(issueStats(runs, { issue: { openedAt: issue.openedAt, archivedAt: issue.archived ? (issue.archivedAt ?? issue.archive?.packedAt ?? null) : undefined } }))
}))

// Follow-up issues for the residual risks a run's closure left unaccepted.
app.post('/api/projects/:project/issues/:id/runs/:runId/followups', route(async (req, res) => {
  const { project, id, runId } = req.params
  const result = await issues.createFollowUps(project, id, runId, { by: { user: req.body?.actor || 'operator', host: await clientHost(req) } })
  io.emit('issues:changed', { reason: 'follow-ups-created', project, id })
  res.status(201).json(result)
}))

// Operator approval to integrate a committed candidate into the project's
// integration branch. Bound to the revision the operator saw.
// What an approval must name: the declared repository, branch and its head now.
app.get('/api/projects/:project/issues/:id/runs/:runId/integration-target', route(async (req, res) => {
  const { project, id, runId } = req.params
  const issue = await unpackedIssue(project, id)
  res.json(await integrationTarget({ project, projectPath: projectPath(project), configRoot: process.env.DEVPANEL_CONFIG_ROOT, runId, issuePath: issue.path }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/integrate', route(async (req, res) => {
  const { project, id, runId } = req.params
  const { expectedRevision, targetBranch = null, expectedTargetHead = null } = req.body ?? {}
  if (!expectedRevision) throw Object.assign(new Error('expectedRevision is required: approve the revision you reviewed'), { status: 400 })
  if (supervisor.isActive(project, id)) throw Object.assign(new Error('a run is active on this issue; wait for it to settle'), { status: 409 })
  const issue = await unpackedIssue(project, id)
  const result = await integrateRun({
    issuePath: issue.path, runId, project, projectPath: projectPath(project),
    configRoot: process.env.DEVPANEL_CONFIG_ROOT, expectedRevision, targetBranch, expectedTargetHead, approvedBy: 'operator'
  })
  io.emit('run:event', { type: 'integrated', project, issueId: id, runId, ok: !result.error })
  res.status(result.error ? 409 : 200).json(result)
}))

app.get('/api/projects/:project/issues/:id/runs/:runId/patch', route(async (req, res) => {
  const { project, id, runId } = req.params
  const issue = await unpackedIssue(project, id)
  const { file } = await retainedPatch(issue.path, runId)
  res.download(file)
}))

// Read-only, asked each time the issue page shows the run: would the patch apply to the checkout now?
app.get('/api/projects/:project/issues/:id/runs/:runId/patch-check', route(async (req, res) => {
  const { project, id, runId } = req.params
  const issue = await unpackedIssue(project, id)
  const { file } = await retainedPatch(issue.path, runId)
  res.json(await checkPatch({ patchFile: file, projectPath: projectPath(project) }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/apply-artifact', route(async (req, res) => {
  const { project, id, runId } = req.params
  if (supervisor.isActive(project, id)) throw Object.assign(new Error('Wait for the active run to settle'), { status: 409 })
  const issue = await unpackedIssue(project, id)
  const result = await applyRunArtifact({ issuePath: issue.path, runId,
    projectPath: projectPath(project), expectedRevision: req.body?.expectedRevision })
  io.emit('run:event', { type: 'artifact-applied', project, issueId: id, runId, application: result.application })
  res.status(result.error ? 409 : 200).json(result)
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/integration/reconcile', route(async (req, res) => {
  const { project, id, runId } = req.params
  const issue = await unpackedIssue(project, id)
  const result = await reconcileIntegration({ issuePath: issue.path, runId })
  io.emit('run:event', { type: 'integration-reconciled', project, issueId: id, runId, phase: result.phase })
  res.json(result)
}))

app.post('/api/supervisor/finish', route(async (_req, res) => res.status(202).json(await topSupervisor.finish())))
app.post('/api/supervisor/reset', route(async (_req, res) => res.json(await topSupervisor.reset())))

// Permanent, and only for an issue that was archived first. Archive is the
// reversible step; this one is not, so it is deliberately not reachable from an
// active issue.
app.delete('/api/projects/:project/issues/:id', route(async (req, res) => {
  const { project, id } = req.params
  const result = await issues.deleteIssue(project, id)
  io.emit('issues:changed', { reason: 'issue-deleted', project, id })
  res.json(result)
}))

// ---- read-only run views -------------------------------------------------

// Run events reach only authenticated sockets — the handshake is gated, so a
// subscription cannot be opened without the token.
let supervisor = null
let topSupervisor = null
let modelPerformance = null
const emitProjectAction = (event) => { io?.emit('project:action', event) }

const emitRunEvent = (event) => {
  const { type, project, issueId, runId, role, stepId } = event
  // Output chunks and activity ticks are high-volume and already on disk.
  if (type !== 'live' && type !== 'activity') console.info('Issue run event:', { type, project, issueId, runId, role, stepId })
  io?.emit('run:event', event)
}

// Every agent currently invoked, anywhere. Behind the same token as the rest:
// role, model and step names describe what is being done to a project's code.
app.get('/api/supervisor', route(async (_req, res) => res.json(topSupervisor.get())))
app.get('/api/supervisor/status', route(async (_req, res) => res.json(topSupervisor.status())))
app.get('/api/supervisor/models', route(async (_req, res) => res.json(await topSupervisor.models())))
app.post('/api/supervisor/start', route(async (req, res) => res.status(201).json(await topSupervisor.start(req.body ?? {}))))
app.post('/api/supervisor/launches/reconcile', route(async (req, res) => res.json(await topSupervisor.reconcileLaunch(req.body ?? {}))))
app.post('/api/supervisor/launches/retry', route(async (req, res) => res.json(await topSupervisor.retryLaunch(req.body ?? {}))))
// A side question, answered in a fork of the supervisor's session (202; the
// answer arrives in the chat). Its questions to the operator, and their answers.
app.post('/api/supervisor/ask', route(async (req, res) => res.status(202).json(await topSupervisor.ask(req.body?.text))))
app.get('/api/supervisor/live/:invocationId', route(async (req, res) => {
  const after = Number(req.query.after ?? 0)
  res.json(await topSupervisor.live(req.params.invocationId, { after: Number.isFinite(after) ? after : 0 }))
}))
app.get('/api/supervisor/questions', route(async (_req, res) => res.json(topSupervisor.questions())))
app.post('/api/supervisor/questions/:id/answer', route(async (req, res) => res.json(await topSupervisor.answerQuestion(req.params.id, req.body ?? {}))))
app.post('/api/supervisor/messages', route(async (req, res) => res.status(202).json(await topSupervisor.chat(req.body?.text))))
app.post('/api/supervisor/stop', route(async (_req, res) => {
  const stopping = topSupervisor.stop()
  stopping.catch(error => console.error('Supervisor stop:', error.message))
  res.status(202).json(topSupervisor.get())
}))

/* An archived issue packed out of the folder has no runs to act on or read
   until it is restored; its results are on the issue itself. */
async function unpackedIssue (project, id) {
  const issue = await getIssue(project, id)
  if (issue.packed) throw new IssueError('This issue is archived and packed. Restore it to see or act on its runs.', 409)
  return issue
}

app.get('/api/attention', route(async (_req, res) => {
  // The supervisor's open questions come first: nothing else can answer them.
  const questions = (topSupervisor?.questions() ?? []).map((q) => ({
    kind: 'supervisor-question', questionId: q.id, project: q.project ?? null, issueId: q.issueId ?? null,
    issueName: q.issueId ?? 'Supervisor', since: q.at, headline: q.question, options: q.options ?? null
  }))
  res.json([...questions, ...await attentionList({ listProjects: issues.listProjects, listIssues: issues.listIssues })])
}))

app.get('/api/agents', route(async (_req, res) => {
  res.json(await supervisor.liveAgents())
}))

// The decision provider's row on the availability page: configuration, key usability, hold, last call.
const decisionProviders = () => decisionProviderStatus({
  loadProvider, store: supervisor.availability, advisors: [advisor, wakeAdvisor],
  usage: (() => { try { return topSupervisor?.decisionSpending?.().ledger.usage() ?? null } catch { return null } })()
})

// Models this host has seen exhausted, with their recorded reset. A start that
// names one is refused with 409 until the record expires or an operator clears it.
app.get('/api/availability', route(async (_req, res) => {
  res.json(await availabilityReport({ store: supervisor.availability, performance: modelPerformance, configRoot: process.env.DEVPANEL_CONFIG_ROOT, decisionProviders }))
}))
// Explicit operator action: one bounded hello-world call per eligible model.
app.post('/api/availability/refresh', route(async (_req, res) => {
  await modelPerformance.refresh()
  res.status(202).json(await availabilityReport({ store: supervisor.availability, performance: modelPerformance, configRoot: process.env.DEVPANEL_CONFIG_ROOT, decisionProviders }))
}))
// An operator's own hold: "this model is out until <instant>", for a quota the
// provider announced but no run has hit yet.
app.post('/api/availability/:model', route(async (req, res) => {
  const { until, reason, actor } = req.body ?? {}
  if (typeof until !== 'string' || !until) throw Object.assign(new Error('until (an ISO instant) is required'), { status: 400 })
  if (typeof actor !== 'string' || !actor.trim()) throw Object.assign(new Error('the actor must be named'), { status: 400 })
  const record = await supervisor.availability.recordExhausted({ modelId: req.params.model, reason: reason?.trim() || `operator hold by ${actor.trim()}`, until, actor: actor.trim() })
  res.status(201).json(record)
}))
app.delete('/api/availability/:model', route(async (req, res) => {
  const cleared = await supervisor.availability.clear(req.params.model)
  res.json({ model: req.params.model, cleared })
}))

// One short real request to the decision provider (a fraction of a cent), on the ledger like
// any other ask. A hold refuses it like any other ask; the page says so.
app.post('/api/decisions/probe', route(async (_req, res) => {
  const record = await advisor.ask({
    dir: path.join(issues.ISSUES_DIR, '.supervisor', 'decisions'),
    purpose: 'probe',
    subject: { probe: 'availability-page' },
    // The instant makes every probe its own question; a probe is never answered from a record.
    state: { probe: 'availability check', at: new Date().toISOString(), text: 'Water boils at 100 degrees Celsius at sea level.' },
    questions: { ok: { type: 'noul', instructions: 'Does the text say that water boils at 100 degrees Celsius at sea level?' } }
  })
  res.json({ record, providers: await decisionProviders() })
}))

// How the Triage pre-gate's answers agree with what Triage and operators did (docs/decisions.md).
app.get('/api/decisions/triage-shadow', route(async (_req, res) => {
  const config = await loadProvider()
  res.json(await triageAgreement({ issues, threshold: config?.threshold ?? null }))
}))

/*
 * Who can assess an issue: the active decision provider, and every verified
 * roster model at any effort it supports. Unverified models are listed but not
 * offered, as for runs; a model on hold says until when.
 */
async function assessors () {
  const config = await loadProvider().catch(() => null)
  const { roster } = await loadConfig({ root: process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT })
  const models = []
  for (const m of roster.values()) {
    const hold = await supervisor.availability.check(m.id).catch(() => null)
    models.push({ id: m.id, title: m.title ?? m.id, harness: m.harness, efforts: Array.isArray(m.efforts) ? m.efforts : [], defaultEffort: m.defaultEffort ?? null,
      verified: m.verification?.status === 'verified', heldUntil: hold?.exhaustedUntil ?? null })
  }
  return { provider: config ? { id: config.id, title: config.title ?? config.id, model: config.model } : null, models: models.sort((a, b) => a.title.localeCompare(b.title)) }
}
const pregateView = async (project, issueId) => {
  const config = await loadProvider()
  return { configured: Boolean(config), threshold: config?.threshold ?? null, assessors: await assessors(), ...await pregate.latest({ project, issueId }) }
}

// The pre-gate on one issue: the newest assessment and what an operator could confirm.
app.get('/api/projects/:project/issues/:id/pregate', route(async (req, res) => {
  res.json(await pregateView(req.params.project, req.params.id))
}))

// Ask now. With no model named, the decision provider (fractions of a cent); with
// { model, effort }, that roster model through its CLI. A question already
// answered by the same assessor is read from its record, never asked twice.
app.post('/api/projects/:project/issues/:id/pregate', route(async (req, res) => {
  const { project, id: issueId } = req.params
  let using = null
  if (req.body?.model) {
    const { roster } = await loadConfig({ root: process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT })
    const model = roster.get(String(req.body.model))
    if (!model) throw Object.assign(new Error(`no roster model "${req.body.model}"`), { status: 400 })
    if (model.verification?.status !== 'verified') throw Object.assign(new Error(`${model.id} is not verified; verify it before asking it anything`), { status: 409 })
    const effort = req.body.effort ?? null
    const efforts = Array.isArray(model.efforts) ? model.efforts : []
    if (effort !== null && !efforts.includes(effort)) throw Object.assign(new Error(`${model.id} does not support effort "${effort}"${efforts.length ? ` (it supports ${efforts.join(', ')})` : ' (it takes none)'}`), { status: 400 })
    using = { model, effort }
  }
  const record = await pregate.assess({ project, issueId, using })
  if (record?.skipped && using) throw Object.assign(new Error(record.skipped === 'held' ? `${using.model.id} is on hold until ${record.hold.exhaustedUntil}; see Model availability` : 'not available: the spending ledger is not open'), { status: 409, code: 'DECISIONS_UNAVAILABLE' })
  if (record?.skipped) throw Object.assign(new Error(`the decision provider is ${record.skipped === 'not-configured' ? 'not configured (decisions/<id>.yaml, as decisions/active.yaml selects; jev by default)' : record.skipped === 'held' ? `on hold until ${record.hold.exhaustedUntil} (${record.hold.reason}); see Model availability` : 'not available: the spending ledger is not open'}`), { status: 409, code: 'DECISIONS_UNAVAILABLE' })
  res.json(await pregateView(project, issueId))
}))

app.post('/api/projects/:project/issues/:id/pregate/confirm', route(async (req, res) => {
  const { project, id: issueId } = req.params
  const { key, proposal } = req.body ?? {}
  const result = await pregate.confirm({ project, issueId, key, proposalId: proposal, actor: req.actor ?? 'operator' })
  io.emit('issues:changed', { reason: 'pregate-confirmed', project, id: issueId })
  res.json(result)
}))

app.get('/api/playbooks', route(async (_req, res) => {
  res.json(await listPlaybooks({}))
}))

app.get('/api/playbooks/:id/preview', route(async (req, res) => {
  const { project, issue: issueId } = req.query
  let runOptions = {}
  if (req.query.options !== undefined) {
    try { runOptions = JSON.parse(req.query.options) } catch {
      throw Object.assign(new Error('invalid run options JSON'), { status: 400 })
    }
  }
  let issue = null
  let projectRef = null
  if (project && issueId) {
    const found = await getIssue(project, issueId)
    issue = { name: found.name, openedOn: found.openedOn, path: found.path, project: found.project }
    projectRef = { id: project, path: projectPath(project) }
  }
  const result = await preview(req.params.id, { issue, project: projectRef, deliveryActions: supervisor.deliveryActions, runOptions })
  res.status(result.ok ? 200 : 422).json(result)
}))

app.get('/api/projects/:project/issues/:id/runs', route(async (req, res) => {
  const issue = await getIssue(req.params.project, req.params.id)
  res.json(issue.packed ? [] : await listRuns(issue.path))
}))

app.get('/api/projects/:project/issues/:id/runs/:runId', route(async (req, res) => {
  const issue = await unpackedIssue(req.params.project, req.params.id)
  res.json(await getRun(issue.path, req.params.runId, {
    issues,
    project: req.params.project,
    issueId: req.params.id,
    isActive: supervisor.isActive(req.params.project, req.params.id)
  }))
}))

// The runtime's own output for one turn, as recorded. `after` continues from a
// sequence number, so a client that missed socket events catches up without
// re-reading everything.
app.get('/api/projects/:project/issues/:id/runs/:runId/live/:invocationId', route(async (req, res) => {
  const issue = await unpackedIssue(req.params.project, req.params.id)
  const after = Number(req.query.after ?? 0)
  res.json(await readLiveOutput(issue.path, req.params.runId, req.params.invocationId, { after: Number.isFinite(after) ? after : 0 }))
}))

// ---- run control ---------------------------------------------------------

// The operator's conversation with a run's coordinator (runtime/coordinator-chat.mjs).
// `question` is answered in a fork of the coordinator's session and changes
// nothing; `instruction` is delivered in the coordinator's next turn. Answers
// and deliveries arrive as run:event {type:'chat'}.
app.get('/api/projects/:project/issues/:id/runs/:runId/chat', route(async (req, res) => {
  res.json(await supervisor.chatHistory({ project: req.params.project, issueId: req.params.id, runId: req.params.runId }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/chat', route(async (req, res) => {
  const { kind, text, actor } = req.body ?? {}
  const args = { project: req.params.project, issueId: req.params.id, runId: req.params.runId, text, actor }
  if (kind === 'instruction') return res.status(201).json(await supervisor.instructCoordinator(args))
  if (kind === 'question') return res.status(202).json(await supervisor.askCoordinator(args))
  res.status(400).json({ error: 'kind must be question or instruction' })
}))

app.post('/api/projects/:project/issues/:id/runs', route(async (req, res) => {
  const { playbook, configHash, runOptions = {}, pregate: pregateBody = null } = req.body ?? {}
  if (!playbook) throw Object.assign(new Error('a playbook id is required'), { status: 400 })

  // Returns as soon as the run has an id and durable state; execution continues
  // in the background, so closing the browser does not stop it.
  const started = await supervisor.start({
    project: req.params.project,
    issueId: req.params.id,
    playbookId: playbook,
    // Optional, and checked when given: it ties this start to the exact
    // configuration the operator was shown.
    expectConfigHash: configHash ?? null,
    runOptions,
    configRoot: process.env.DEVPANEL_CONFIG_ROOT,
    // The panel is the operator: this is the one place a pre-gate hold is overridden.
    pregateOverride: pregateBody?.override ? { by: 'operator', reason: pregateBody.reason } : null
  })
  res.status(201).json(started)
}))

// Answer the question a paused run asked. The engine records the answer as an
// operator step and the supervisor drives the run on.
app.post('/api/projects/:project/issues/:id/runs/:runId/pause', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  res.status(202).json(await supervisor.pause({ project, issueId, runId }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/resume', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  res.status(202).json(await supervisor.resume({ project, issueId, runId, budgets: req.body?.budgets ?? {} }))
}))

app.get('/api/projects/:project/issues/:id/runs/:runId/integrity', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  res.json(await supervisor.inspectIntegrity({ project, issueId, runId }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/integrity', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  const { disposition, expectedStateHash, reason } = req.body ?? {}
  if (!['accept-partial', 'restored', 'abandon'].includes(disposition)) throw Object.assign(new Error('disposition must be accept-partial, restored or abandon'), { status: 400 })
  if (typeof expectedStateHash !== 'string' || !expectedStateHash) throw Object.assign(new Error('expectedStateHash is required: inspect the workspace first'), { status: 400 })
  if (typeof reason !== 'string' || !reason.trim()) throw Object.assign(new Error('a reason is required'), { status: 400 })
  const result = await supervisor.resolveIntegrity({ project, issueId, runId, disposition, expectedStateHash, reason: reason.trim(), actor: req.actor ?? 'operator' })
  io.emit('issues:changed', { reason: 'run-integrity-resolved', project, id: issueId })
  res.status(202).json(result)
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/recover', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  res.status(202).json(await supervisor.recover({ project, issueId, runId, budgets: req.body?.budgets ?? {} }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/answer', route(async (req, res) => {
  const { answer, actor, pauseId } = req.body ?? {}
  res.json(await supervisor.answer({
    project: req.params.project,
    issueId: req.params.id,
    runId: req.params.runId,
    text: answer,
    pauseId,
    actor
  }))
}))

// Answer what a triage asked before starting work (run.ownerInput): the answers
// become a note on the issue and the same configuration starts again; an
// accepted split becomes new issues instead. See server/owner-input.mjs.
app.post('/api/projects/:project/issues/:id/runs/:runId/owner-input', route(async (req, res) => {
  const { actor, answers = null, split = null, note = null } = req.body ?? {}
  const { project, id: issueId, runId } = req.params
  const result = await createOwnerInput({ issues, supervisor, configRoot: process.env.DEVPANEL_CONFIG_ROOT }).answer({ project, issueId, runId, actor, answers, split, note, host: await clientHost(req) })
  io.emit('issues:changed', { reason: 'owner-input', project, id: issueId })
  res.json(result)
}))

// Continue a run stopped at closure: the author gets another round on the
// retained candidate, with the operator's instruction and the new issue notes.
app.post('/api/projects/:project/issues/:id/runs/:runId/continue', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  const { instruction = '', actor, budgets = {} } = req.body ?? {}
  res.status(202).json(await supervisor.continueRun({ project, issueId, runId, text: instruction, actor: req.actor ?? actor, budgets }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/refresh-checks', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  res.status(202).json(await supervisor.refreshChecks({ project, issueId, runId }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/retry-input', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  res.status(202).json(await supervisor.retryInput({ project, issueId, runId }))
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/finalize', route(async (req, res) => {
  const { project, id, runId } = req.params
  const result = await supervisor.finalize({ project, issueId: id, runId })
  io.emit('issues:changed', { reason: 'run-finalized', project, id })
  res.json(result)
}))

// Merge the approved patch onto source that drifted on its own paths, revalidate, deliver (source-reconcile.mjs).
app.post('/api/projects/:project/issues/:id/runs/:runId/reconcile-delivery', route(async (req, res) => {
  const { project, id, runId } = req.params
  const result = await supervisor.reconcileDelivery({ project, issueId: id, runId, actor: req.actor ?? req.body?.actor ?? 'operator' })
  io.emit('issues:changed', { reason: 'run-reconciled', project, id })
  res.json(result)
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/abandon', route(async (req, res) => {
  const { project, id, runId } = req.params
  const run = await supervisor.abandon({ project, issueId: id, runId })
  io.emit('issues:changed', { reason: 'run-abandoned', project, id })
  res.json({ runId, status: run.status })
}))

// Delete a settled run: workspace, record and step folders (supervisor.deleteRun).
app.delete('/api/projects/:project/issues/:id/runs/:runId', route(async (req, res) => {
  const { project, id, runId } = req.params
  const result = await supervisor.deleteRun({ project, issueId: id, runId })
  io.emit('issues:changed', { reason: 'run-deleted', project, id })
  res.json(result)
}))

// A run's escaped descendants were not proved gone (runtime/cleanup-barrier.mjs):
// prove it again, or record a person's acknowledgement with the reason (OP-1).
app.post('/api/projects/:project/issues/:id/runs/:runId/cleanup-proof', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  const result = await supervisor.proveCleanup({ project, issueId, runId, actor: req.actor ?? req.body?.actor ?? 'operator' })
  io.emit('issues:changed', { reason: 'run-cleanup-proved', project, id: issueId })
  res.json(result)
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/cleanup-acknowledgement', route(async (req, res) => {
  const { project, id: issueId, runId } = req.params
  const result = await supervisor.acknowledgeCleanup({ project, issueId, runId, reason: req.body?.reason, actor: req.actor ?? req.body?.actor ?? 'operator' })
  io.emit('issues:changed', { reason: 'run-cleanup-acknowledged', project, id: issueId })
  res.json(result)
}))

// An operator's record that the run's work was landed by hand (supervisor.markLanded).
app.post('/api/projects/:project/issues/:id/runs/:runId/landed', route(async (req, res) => {
  const { project, id, runId } = req.params
  const { applied, commit, checkout, handChanges, landedAt } = req.body ?? {}
  const result = await supervisor.markLanded({ project, issueId: id, runId, by: req.actor ?? req.body?.actor ?? 'operator', applied, commit, checkout, handChanges, landedAt })
  io.emit('issues:changed', { reason: 'run-landed', project, id })
  res.json(result)
}))

app.post('/api/projects/:project/issues/:id/runs/:runId/stop', route(async (req, res) => {
  const result = await supervisor.stop({
    project: req.params.project,
    issueId: req.params.id,
    runId: req.params.runId,
    wait: req.body?.wait === true
  })
  res.json(result)
}))

app.get('/api/projects/:project/issues/:id/steps/:number/response', route(async (req, res) => {
  const text = await readStepResponse(issues, req.params.project, req.params.id, req.params.number)
  // Served as text, never as HTML: the browser must not be asked to interpret
  // agent output as markup.
  res.type('text/plain; charset=utf-8').send(text)
}))

app.post('/api/projects/:project/issues/:id/steps', route(async (req, res) => {
  const { project, id } = req.params
  const { name = null, text = null, format = 'md', links = null } = req.body ?? {}
  const step = await createStep(project, id, { name, text, format, links })
  io.emit('issues:changed', { reason: 'step-created', project, id, step: step.id })
  res.status(201).json(step)
}))

/*
 * Attach a file to a step.
 *
 * The body is the file itself, with the name in the path — no multipart, so
 * there is no parser to get wrong, and the size ceiling is enforced by the body
 * reader before anything reaches disk.
 */
app.post('/api/projects/:project/issues/:id/steps/:number/files/:filename',
  express.raw({ type: '*/*', limit: MAX_FILE_BYTES }),
  route(async (req, res) => {
    const { project, id, number, filename } = req.params
    const step = await addStepFile(project, id, number, filename, req.body)
    io.emit('issues:changed', { reason: 'step-file-added', project, id, step: step.id })
    res.status(201).json(step)
  }))

app.get('/api/projects/:project/issues/:id/steps/:number/files/:filename', route(async (req, res) => {
  const { project, id, number, filename } = req.params
  const file = await readStepFile(project, id, number, filename)

  /*
   * Always a download, never a rendered page.
   *
   * The operator's token lives in sessionStorage on this origin. An uploaded
   * .html or .svg served inline would run as same-origin script with access to
   * it, so nothing here is given a type a browser will execute.
   */
  res.type('application/octet-stream')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/["\\]/g, '')}"`)
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.send(file.bytes)
}))

/*
 * An /api path that matched nothing.
 *
 * Express's default is an HTML page reading "Cannot DELETE /api/…", which tells
 * the operator nothing and reaches the client as an unparseable body. The usual
 * cause is this process being older than the page that called it, so the answer
 * says so.
 */
app.use('/api', route(async (req, res) => {
  const source = await sourceState()
  res.status(404).json({
    error: source.stale
      ? `no such endpoint: ${req.method} /api${req.path} — this server is running code from before the last change, so restart it`
      : `no such endpoint: ${req.method} /api${req.path}`,
    stale: source.stale
  })
}))

const hasBuild = fs.existsSync(path.join(DIST, 'index.html'))

if (hasBuild) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }))
  // SPA fallback. Registered as middleware rather than a wildcard route because
  // Express 5 no longer accepts a bare '*' path.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api/')) return next()
    // The shell must always be revalidated. Its assets carry content hashes
    // and may be cached for an hour, but a browser that keeps an old
    // index.html after a rebuild asks for asset names that no longer exist,
    // gets 404s for its script, and shows a page on which nothing opens.
    res.sendFile(path.join(DIST, 'index.html'), { cacheControl: false, headers: { 'Cache-Control': 'no-cache' } })
  })
} else {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.status(503).type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>devpanel — no build</title>
<style>
  body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f9f9f7; color: #0b0b0b; margin: 0;
         display: grid; place-items: center; min-height: 100vh; }
  main { max-width: 34rem; padding: 2rem; }
  code { background: #eceae4; padding: .15em .4em; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d0d; color: #fff; } code { background: #2c2c2a; }
  }
</style>
<main>
  <h1>The GUI has not been built yet</h1>
  <p>The API and socket.io endpoints on this port are live, but there is no
     <code>dist/</code> to serve.</p>
  <p>Run <code>./install.sh</code> once, then <code>./start.sh</code>. For live
     reloading during development, use <code>./start.sh dev</code> instead.</p>
</main>`)
  })
}

// Express 5 identifies an error handler by its four parameters.
app.use((err, _req, res, _next) => {
  console.warn(`${_req.method} ${_req.path}: ${err.message}`)
  if (err instanceof IssueError) return res.status(err.status).json({ error: err.message })
  // A start refused before a run was reserved carries its classification on the
  // error itself, because there is no run record to read it from.
  if (typeof err.status === 'number') {
    return res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.class ? { class: err.class } : {}),
      ...(err.started === false ? { started: false } : {}),
      ...(typeof err.retryable === 'boolean' ? { retryable: err.retryable } : {}),
      ...(err.remedy ? { remedy: err.remedy } : {}),
      ...(err.resolvableBy ? { resolvableBy: err.resolvableBy } : {}),
      ...(err.detail ? { detail: err.detail } : {}),
      ...(err.pregate ? { pregate: err.pregate } : {})
    })
  }
  console.error('request failed:', err.stack ?? err.message)
  res.status(500).json({ error: 'internal error' })
})

// eslint-disable-next-line no-var -- hoisted so the routes above can close over it
var io
const tls = readTlsMaterial()
const server = tls ? https.createServer(tls, app) : http.createServer(app)
const scheme = tls ? 'https' : 'http'
io = new Server(server, {
  cors: { origin: DEV_ORIGINS, methods: ['GET', 'POST'] }
})

// The socket carries run events, so it needs the same credential as the API.
io.use(socketAuth(TOKEN, { local: LOCAL }))

// Advisory decisions (docs/decisions.md): the active provider under the configuration
// root (decisions/active.yaml selects decisions/<id>.yaml; Jev when nothing selects). The top-level supervisor below
// owns the spending ledger and lends it per ask, so nothing is asked before it exists.
const loadProvider = () => loadDecisionProvider({ root: process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT })
// The host's availability store (the Model availability page) holds the provider too, as `decision:<id>`.
const availabilityStore = () => supervisor?.availability ?? null
const advisor = createAdvisor({ spending: () => topSupervisor?.decisionSpending?.() ?? null, availability: availabilityStore, loadProvider })
let wakeAdvisor = null
const pregate = createPregate({ issues, advisor })
supervisor = createSupervisor({ issues, emit: emitRunEvent, pregate, failureAdvisor: createFailureAdvisor({ advisor }) })
modelPerformance = await createModelPerformanceService({ file: path.join(issues.ISSUES_DIR, '.model-performance.json'), availability: supervisor.availability })

/*
 * Rebuild ownership before serving anything.
 *
 * A run persisted as live belongs either to a process that is still there or to
 * one that is gone. Without settling that first, this server would advertise Stop
 * on runs it cannot stop and report "already stopped" for runs it merely never
 * knew about.
 */
const recovered = await supervisor.reconcile()
let previousSupervisorState = null
topSupervisor = await topSupervisorService({ issues, supervisor, modelPerformance,
  decisions: ({ spending }) => (wakeAdvisor = createAdvisor({ spending, availability: availabilityStore, loadProvider })),
  emit: (event) => {
    // A working call's streamed output: its own channel, so it does not make
    // every open supervisor page re-read the whole state per chunk.
    if (event?.type === 'live') { io?.emit('supervisor:live', event); return }
    if (event?.type === 'question') { io?.emit('supervisor:changed'); io?.emit('issues:changed', { reason: 'supervisor-question' }); return }
    const key = JSON.stringify(event)
    if (key !== previousSupervisorState) { console.info('Supervisor state:', event); previousSupervisorState = key }
    io?.emit('supervisor:changed')
  },
  changed: () => io?.emit('issues:changed', { reason: 'supervisor-action' })
})
if (recovered.length) {
  console.log(`              ${recovered.length} run(s) from a previous process need recovery`)
}
{
  // Which gate is in force, said once at startup. A policy that failed to load
  // is otherwise invisible until a start is refused for a reason nobody expects.
  const { spending } = topSupervisor.get()
  console.log(spending.active
    ? `              spending policy active: ${spending.decides} decide admission (${spending.ledger.entries} ledger entries)${spending.ignored ? `; ${spending.ignored.join('; ')}` : ''}`
    : `              spending policy NOT active (${spending.reason}); ${spending.decides} decide admission`)
}

// The metrics ticker only runs while somebody is watching.
let ticker = null

function stopTicker () {
  if (!ticker) return
  clearInterval(ticker)
  ticker = null
}

async function tick () {
  // Checked here rather than in the 'disconnect' handler: clientsCount has not
  // necessarily settled by the time that fires, so the ticker retires itself.
  if (io.engine.clientsCount === 0) return stopTicker()
  io.emit('metrics', metricsSnapshot({
    clients: io.engine.clientsCount,
    source: await sourceState()
  }))
}

function startTicker () {
  if (ticker) return
  ticker = setInterval(tick, TICK_MS)
  ticker.unref()
}

io.on('connection', (socket) => {
  sourceState().then((source) => socket.emit('hello', {
    host: info(),
    tickMs: TICK_MS,
    metrics: metricsSnapshot({ clients: io.engine.clientsCount, source })
  }))

  // Round-trip latency probe: the client sends a timestamp, we hand it straight back.
  socket.on('ping:check', (sentAt, ack) => {
    if (typeof ack === 'function') ack(sentAt)
  })

  startTicker()
})

if (HOSTS.length > 1) {
  const allowed = new Set(HOSTS)
  server.on('connection', (socket) => {
    if (!allowed.has(socket.localAddress?.replace(/^::ffff:/, ''))) socket.destroy()
  })
}

server.listen(PORT, HOST, () => {
  const mode = hasBuild ? 'serving dist/' : 'API only — no dist/ build found'
  // 0.0.0.0 is not something you can type into a browser.
  const port = (scheme === 'https' && PORT === 443) || (scheme === 'http' && PORT === 80) ? '' : `:${PORT}`
  for (const host of HOSTS.length > 1 ? HOSTS : [HOST]) {
    const shown = host === '0.0.0.0' || host === '::' ? os.hostname() : host
    console.log(`devpanel gui  ${scheme}://${shown}${port}  (${mode})`)
  }
  console.log(`              API and socket require a bearer token — ${tokenFile()}`)
  if (!tls) console.log('              TLS is off — serving plain HTTP')
})

let closing = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // A second signal is an instruction to stop waiting, not to start again.
    if (closing) { console.log(`\n${signal} again — exiting now`); process.exit(1) }
    closing = true
    console.log(`\n${signal} — stopping supervised runs`)

    // Stop listening first, so nothing new arrives while runs are being stopped.
    io.close()
    server.close()

    // Exiting without this leaves agent processes running with no owner, and
    // runs persisted as live whose owner is about to disappear.
    await modelPerformance.shutdown().catch(error => console.error(error.message))
    await topSupervisor.shutdown().catch(error => console.error(error.message))
    const result = await supervisor.shutdown().catch(() => ({ stopped: 0, settled: false }))
    console.log(result.settled
      ? `stopped ${result.stopped} run(s)`
      : `${result.stopped} run(s) did not settle in time — they will be reconciled on the next start`)
    process.exit(0)
  })
}
