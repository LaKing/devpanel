/*
 * Where a staging or deployment run releases, and which staged release a
 * production release promotes. Pure: the caller reads the issues and passes the
 * selection in (release-selection.mjs), so resolution stays filesystem-free.
 *
 * A deployment run has three environments by name:
 *   staging                   release this run's snapshot to the staging target (the default)
 *   production                promote a green staging release's archive to the production target
 *   staging-then-production   both in one run, production only after staging passed
 * An exact deployment environment id still selects that production target.
 * Production is never a default: only a named environment reaches it.
 */

export const RELEASE_ENVIRONMENTS = [
  { id: 'staging', title: 'Staging', description: 'Release this snapshot to the staging target. Needs no releaseId.' },
  { id: 'production', title: 'Production', description: 'Promote the newest green staging release of this content (or the releaseId you name) to production.' },
  { id: 'staging-then-production', title: 'Staging first, Deployment on success', description: 'Release to staging and, only when that passed, promote the same archive to production in this run.' }
]

/**
 * An environment id that claims another environment's name: a deployment called
 * staging or staging-then-production, or a staging environment called production
 * or staging-then-production. The names are reserved for their meaning.
 */
export function reservedEnvironmentErrors (infra) {
  if (!infra) return []
  const errors = []
  if (['production', 'staging-then-production'].includes(infra.staging?.id)) errors.push(`the staging environment cannot be called ${infra.staging.id}: that name is reserved for a deployment environment`)
  for (const e of infra.deployments ?? []) if (['staging', 'staging-then-production'].includes(e.id)) errors.push(`a deployment environment cannot be called ${e.id}: that name is reserved for a release environment`)
  return errors
}

export const NO_GREEN_STAGING = "No green staging release matches the content of this project's checkout: run a Deployment to staging (or 'Staging first, Deployment on success'), or name a releaseId."
const TARGET_MISSING = 'Release target requires installed checkpoint, restore, ownership and verification commands'

export function releasePlan ({ tactic, infrastructure: infra, runOptions = {}, stagedRelease = null, file = null }) {
  const blockers = []
  const errors = []
  const block = (reason, extra = {}) => blockers.push({ role: 'release-operator', model: null, reason, file, ...extra })
  const stagingId = infra?.staging?.id ?? null
  const deployments = (infra?.deployments ?? []).map((e) => e.id)
  const environment = runOptions.environment ?? (tactic === 'staging' ? stagingId : 'staging')
  let mode = null
  let staging = null
  let production = null
  // The three names mean what they say whatever the project calls its environments:
  // they are matched before any configured id, so no id can turn the default into
  // production (infrastructure.mjs also refuses an id that claims another name).
  if (tactic === 'staging') {
    mode = 'staging'
    if (environment === stagingId || environment === 'staging') staging = stagingId
  } else if (environment === 'staging') {
    mode = 'staging'; staging = stagingId
  } else if (environment === 'production' || environment === 'staging-then-production') {
    mode = environment
    if (mode === 'staging-then-production') staging = stagingId
    if (deployments.length === 1) production = deployments[0]
    else if (mode === 'production' && deployments.includes('production')) production = 'production'
    else if (deployments.length > 1) block(`Select a deployment environment explicitly when multiple targets are configured (${deployments.join(', ')})${mode === 'staging-then-production' ? '; staging-then-production needs a single production target' : ''}`)
  } else if (stagingId && environment === stagingId) {
    mode = 'staging'; staging = stagingId
  } else if (deployments.includes(environment)) {
    mode = 'production'; production = environment
  } else {
    block(`Unknown release environment "${environment}": choose staging, production or staging-then-production`)
  }
  const needed = mode === 'staging' ? [staging] : mode === 'production' ? [production] : mode === 'staging-then-production' ? [staging, production] : []
  const ambiguous = blockers.length > 0
  if (!ambiguous && (needed.some((id) => !id) || needed.some((id) => !infra?.release?.targets?.[id]))) block(TARGET_MISSING)

  let releaseId = null
  let releaseIdSource = null
  let filledFrom = null
  let latestGreen = null
  if (mode === 'production') {
    if (runOptions.releaseId) {
      releaseId = runOptions.releaseId; releaseIdSource = 'operator'
    } else if (stagedRelease?.releaseId) {
      releaseId = stagedRelease.releaseId; releaseIdSource = 'filled'
      filledFrom = { issueId: stagedRelease.issueId ?? null, runId: stagedRelease.releaseId, startedAt: stagedRelease.startedAt ?? null, packed: Boolean(stagedRelease.packed) }
    } else {
      latestGreen = stagedRelease?.latestGreen ?? null
      block(NO_GREEN_STAGING, { kind: 'no-green-staging', latestGreen, selection: stagedRelease?.reason ?? 'not-selected', unverifiable: stagedRelease?.unverifiable ?? [], remedy: latestGreen ? `name releaseId ${latestGreen.runId} (the latest green staging release) explicitly, or release this content to staging first` : 'there is no green staging release in this project: release to staging first' })
    }
  } else if (runOptions.releaseId) {
    errors.push(`releaseId applies only to the production environment; ${mode ?? environment} releases this run's own snapshot`)
  }
  return {
    plan: { mode, environment, staging, production, releaseId, releaseIdSource, filledFrom, latestGreen },
    blockers,
    errors
  }
}

/** The plan a snapshot runs under; a snapshot resolved before plans existed derives the old one. */
export function planOf (snapshot) {
  if (snapshot.release) return snapshot.release
  const infra = snapshot.infrastructure
  const env = snapshot.runOptions?.environment
  if (snapshot.tactic === 'staging') return { mode: 'staging', environment: env ?? infra?.staging?.id ?? null, staging: env ?? infra?.staging?.id ?? null, production: null, releaseId: null, legacy: true }
  return { mode: 'production', environment: env ?? infra?.deployments?.[0]?.id ?? null, staging: null, production: env ?? infra?.deployments?.[0]?.id ?? null, releaseId: snapshot.runOptions?.releaseId ?? null, releaseIdSource: 'operator', legacy: true }
}

/** Whether resolution needs a staged-release selection read from the issues. */
export const needsSelection = (resolved) => resolved?.release?.mode === 'production' && resolved.release.releaseIdSource !== 'operator'
