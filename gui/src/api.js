/** Thin fetch wrapper: same-origin JSON, with server error messages preserved. */
import { authHeaders, markRejected } from '@/auth'

async function request (path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers ?? {}) }
  })

  // A refused token is not a request failure to retry — the operator must supply
  // a new one, so surface it as an auth state change rather than an error toast.
  if (response.status === 401) {
    markRejected()
    throw new Error('unauthorised: the panel needs a valid token')
  }

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json')
  const body = isJson ? await response.json().catch(() => null) : null

  if (!response.ok) {
    // The API reports failures as { error }; fall back to the status line.
    // The body travels with the error: a refusal can carry what to do next (a code, a pre-gate hold's proposals).
    throw Object.assign(new Error(body?.error ?? body?.errors?.map((e) => `${e.field || '/'}: ${e.message}`).join('; ') ?? `${response.status} ${response.statusText}`), { status: response.status, body })
  }

  return body
}

const enc = encodeURIComponent

export const api = {
  infrastructure: project => request(`/api/projects/${encodeURIComponent(project)}/infrastructure`),
  checkoutOverlap: project => request(`/api/projects/${encodeURIComponent(project)}/checkout-overlap`),
  moduleLocks: project => request(`/api/projects/${encodeURIComponent(project)}/module-locks`),
  inspectEnvironment: (project, environment, resource) => request(`/api/projects/${encodeURIComponent(project)}/infrastructure/${encodeURIComponent(environment)}/${encodeURIComponent(resource)}`),
  /** checkpoint.sh and other operator scripts on the live checkout; output streams as `project:action` socket events. */
  projectActions: project => request(`/api/projects/${enc(project)}/actions`),
  runProjectAction: (project, action) => request(`/api/projects/${enc(project)}/actions/${enc(action)}`, { method: 'POST' }),
  actionOperation: (project, operationId, after = 0) => request(`/api/projects/${enc(project)}/actions/operations/${enc(operationId)}?after=${after}`),
  stopProjectAction: (project, operationId) => request(`/api/projects/${enc(project)}/actions/operations/${enc(operationId)}/stop`, { method: 'POST' }),
  supervisor: () => request('/api/supervisor'),
  supervisorStatus: () => request('/api/supervisor/status'),
  supervisorModels: () => request('/api/supervisor/models'),
  startSupervisor: (options) => request('/api/supervisor/start', { method: 'POST', body: JSON.stringify(options) }),
  askSupervisor: (text) => request('/api/supervisor/ask', { method: 'POST', body: JSON.stringify({ text }) }),
  supervisorLive: (invocationId, after = 0) => request(`/api/supervisor/live/${enc(invocationId)}?after=${after}`),
  supervisorQuestions: () => request('/api/supervisor/questions'),
  answerSupervisorQuestion: (id, answer, actor) => request(`/api/supervisor/questions/${enc(id)}/answer`, { method: 'POST', body: JSON.stringify({ answer, actor }) }),
  setSupervisorCampaign: (campaign, actor) => request('/api/supervisor/campaign', { method: 'POST', body: JSON.stringify({ campaign, actor }) }),
  chatSupervisor: (text) => request('/api/supervisor/messages', { method: 'POST', body: JSON.stringify({ text }) }),
  stopSupervisor: () => request('/api/supervisor/stop', { method: 'POST' }),
  /** Every <projects-root>/*-project, each with its issue count. */
  listProjects: () => request('/api/projects'),

  listIssues: (project, { archived = false } = {}) => request(`/api/projects/${enc(project)}/issues${archived ? '?archived=true' : ''}`),

  archiveIssue: (project, id, payload = {}) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/archive`, { method: 'POST', body: JSON.stringify(payload) }),
  reconcileIntegration: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/integration/reconcile`, { method: 'POST' }),
  integrationTarget: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/integration-target`),
  setDisposition: (project, id, payload) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/disposition`, { method: 'POST', body: JSON.stringify(payload) }),
  setPriority: (project, id, payload) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/priority`, { method: 'POST', body: JSON.stringify(payload) }),
  /** Parent, children, prerequisites and dependents of one issue (server/issue-family.mjs). */
  issueFamily: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/family`),
  issueStats: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/stats`),
  createFollowUps: (project, id, runId, actor) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/followups`, { method: 'POST', body: JSON.stringify({ actor }) }),
  finishSupervisor: () => request('/api/supervisor/finish', { method: 'POST' }),
  resetSupervisor: () => request('/api/supervisor/reset', { method: 'POST' }),
  integrateRun: (project, id, runId, payload) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/integrate`, { method: 'POST', body: JSON.stringify(payload) }),
  /** Read-only: would the run's patch apply to the checkout now (server/runtime/patch-check.mjs). */
  patchCheck: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/patch-check`),
  applyArtifact: (project, id, runId, expectedRevision) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/apply-artifact`, { method: 'POST', body: JSON.stringify({ expectedRevision }) }),
  async downloadRunPatch (project, id, runId) {
    const res = await fetch(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/patch`, { headers: authHeaders() })
    if (res.status === 401) { markRejected(); throw new Error('unauthorised') }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.blob()
  },
  restoreIssue: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/restore`, { method: 'POST' }),

  createIssue: (project, payload) => request(`/api/projects/${enc(project)}/issues`, {
    method: 'POST',
    body: JSON.stringify(payload)
  }),

  getIssue: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}`),

  /** Permanent. The server refuses unless the issue is archived first. */
  deleteIssue: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}`, {
    method: 'DELETE'
  }),

  createStep: (project, id, payload) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/steps`, {
    method: 'POST',
    body: JSON.stringify(payload)
  }),

  /** The body is the file itself — no multipart, so nothing has to parse it. */
  async addStepFile (project, id, number, file) {
    const url = `/api/projects/${enc(project)}/issues/${enc(id)}/steps/${enc(number)}/files/${enc(file.name)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' },
      body: file
    })
    if (res.status === 401) { markRejected(); throw new Error('unauthorised') }
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
    return body
  },

  /** A download URL. The token is a header, so it is never put in this. */
  stepFileUrl: (project, id, number, name) =>
    `/api/projects/${enc(project)}/issues/${enc(id)}/steps/${enc(number)}/files/${enc(name)}`,

  async downloadStepFile (project, id, number, name) {
    const res = await fetch(api.stepFileUrl(project, id, number, name), { headers: authHeaders() })
    if (res.status === 401) { markRejected(); throw new Error('unauthorised') }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.blob()
  },

  // ---- runs -------------------------------------------------------------
  /** Every agent currently invoked, across every project. */
  listAgents: () => request('/api/agents'),
  /** The daily full verification: the latest cycle, and "Full verification now" (server/full-verification.mjs). */
  verificationLatest: () => request('/api/verification/latest'),
  startVerification: () => request('/api/verification/start', { method: 'POST', body: '{}' }),
  listAttention: () => request('/api/attention'),
  listPlaybooks: () => request('/api/playbooks'),
  previewPlaybook: (playbookId, { project, issue, runOptions = {} } = {}) => {
    const params = new URLSearchParams()
    if (project && issue) { params.set('project', project); params.set('issue', issue) }
    if (Object.keys(runOptions).length) params.set('options', JSON.stringify(runOptions))
    const q = params.size ? `?${params}` : ''
    return request(`/api/playbooks/${enc(playbookId)}/preview${q}`)
  },
  listRuns: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs`),
  getRun: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}`),
  liveOutput: (project, id, runId, invocationId, after = 0) =>
    request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/live/${enc(invocationId)}?after=${after}`),

  /** `configHash` binds the start to the preview the operator actually read. */
  /** `pregate` is `{ override: true, reason }` only when an operator starts Triage past a pre-gate hold. */
  startRun: (project, id, playbook, configHash = null, runOptions = {}, pregate = null) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs`, {
    method: 'POST',
    body: JSON.stringify({ playbook, configHash, runOptions, ...(pregate ? { pregate } : {}) })
  }),
  /** The decision provider's newest assessment of an issue, with proposals; asks nothing. */
  pregate: (project, id) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/pregate`),
  /** Ask the decision provider now (paid, fractions of a cent). */
  /** Assess with the decision provider, or with { model, effort } a roster model. */
  assessPregate: (project, id, using = {}) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/pregate`, { method: 'POST', body: JSON.stringify(using) }),
  confirmPregate: (project, id, key, proposal) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/pregate/confirm`, { method: 'POST', body: JSON.stringify({ key, proposal }) }),
  finalizeRun: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/finalize`, { method: 'POST' }),
  reconcileDelivery: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/reconcile-delivery`, { method: 'POST', body: JSON.stringify({}) }),
  /** Permanent: the run's workspace, record and step folders. Refused while live or paused. */
  deleteRun: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}`, { method: 'DELETE' }),
  abandonRun: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/abandon`, { method: 'POST' }),
  stopRun: (project, id, runId, payload = {}) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/stop`, {
    method: 'POST', body: JSON.stringify(payload)
  }),
  pauseRun: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/pause`, { method: 'POST' }),
  inspectIntegrity: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/integrity`),
  resolveIntegrity: (project, id, runId, body) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/integrity`, { method: 'POST', body: JSON.stringify(body) }),
  acknowledgeCleanup: (project, id, runId, reason) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/cleanup-acknowledgement`, { method: 'POST', body: JSON.stringify({ reason }) }),
  recoverRun: (project, id, runId, actor) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/recover`, { method: 'POST', body: JSON.stringify({ actor }) }),
  resumeRun: (project, id, runId, budgets = {}, actor, acceptShortWallClock = false) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/resume`, { method: 'POST', body: JSON.stringify({ budgets, actor, acceptShortWallClock }) }),
  refreshChecks: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/refresh-checks`, { method: 'POST', body: JSON.stringify({}) }),
  acceptCheckResult: (project, id, runId, body) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/accept-check-result`, { method: 'POST', body: JSON.stringify(body) }),
  continueRun: (project, id, runId, body) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/continue`, { method: 'POST', body: JSON.stringify(body) }),
  answerRun: (project, id, runId, answer, actor, pauseId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer, actor, pauseId })
  }),
  coordinatorChat: (project, id, runId) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/chat`),
  sendCoordinatorChat: (project, id, runId, body) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/chat`, { method: 'POST', body: JSON.stringify(body) }),
  answerOwnerInput: (project, id, runId, body) => request(`/api/projects/${enc(project)}/issues/${enc(id)}/runs/${enc(runId)}/owner-input`, { method: 'POST', body: JSON.stringify(body) }),
  availability: () => request('/api/availability'),
  refreshAvailability: () => request('/api/availability/refresh', { method: 'POST' }),
  clearAvailability: (model) => request(`/api/availability/${enc(model)}`, { method: 'DELETE' }),
  /** One short real request to the decision provider, from the Model availability page. */
  probeDecisions: () => request('/api/decisions/probe', { method: 'POST' }),
  holdAvailability: (model, until, reason, actor) => request(`/api/availability/${enc(model)}`, { method: 'POST', body: JSON.stringify({ until, reason, actor }) }),

  /** Plain text, never HTML: agent output is data, not markup. */
  async stepResponse (project, id, number) {
    const res = await fetch(`/api/projects/${enc(project)}/issues/${enc(id)}/steps/${enc(number)}/response`, {
      headers: authHeaders()
    })
    if (res.status === 401) { markRejected(); throw new Error('unauthorised') }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    return res.text()
  }
}
