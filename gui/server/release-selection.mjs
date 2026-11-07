import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolvePlaybook } from './config/load.mjs'
import { needsSelection } from './config/release-plan.mjs'
import { FINGERPRINT_RULE, treeIdentity } from './runtime/fingerprint.mjs'
import { contentIdentity, extractMember, RELEASE_EXCLUDES } from './runtime/release.mjs'
import { runProcess } from './runtime/process.mjs'
import { stagedReleasePassed } from './runtime/run-result.mjs'
import { destinationFingerprint } from './runtime/source-delivery.mjs'
import { packedRunsOf, runsOf } from './supervisor-overview.mjs'

/*
 * Which green staging release a production release promotes when the operator
 * names none (docs/tactical-playbooks.md "Configuring releases").
 *
 * The candidate is the project's development checkout, as a new run would
 * snapshot it. Green staging releases (open and archived issues) are compared
 * newest first, and the first whose content equals the checkout's is chosen.
 * The checkout is read through that release's own projection (its materialized
 * links, excludes and nested repositories: the reader delivery uses,
 * source-delivery.mjs destinationFingerprint), and both sides are compared as a
 * tree identity under one fingerprint rule. A receipt that recorded no identity,
 * or one under another rule, is read from its retained archive after the
 * archive's hash is verified; an archive that is missing or changed makes that
 * release unverifiable, and it never matches. Nothing here starts anything.
 */

const sha256File = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
})

const issuesModule = () => import('./issues.js')

/** The daily full verification's run homes of a project (issues.js listRunHomes): their staging releases count too. */
export const runHomesOf = async (project, listHomes = null) => (listHomes ?? (await issuesModule()).listRunHomes)(project).catch(() => [])

/** Every green staging release of a project, newest first, with the issue (or run home) that holds it. */
export async function greenStagingReleases ({ project, listIssues, listHomes = null, readRuns = runsOf, readPackedRuns = packedRunsOf }) {
  const list = listIssues ?? (await issuesModule()).listIssues
  const [open, archived, homes] = await Promise.all([list(project), list(project, { archived: true }), runHomesOf(project, listHomes)])
  const out = []
  for (const issue of [...open, ...archived, ...homes]) {
    const runs = issue.packed ? await readPackedRuns(issue.project ?? project, issue.id) : await readRuns(issue.path)
    for (const run of runs) if (run.release?.tactic === 'staging' && stagedReleasePassed(run.release, run)) out.push({ issue, run })
  }
  return out.sort((a, b) => String(b.run.release.startedAt ?? b.run.startedAt ?? '').localeCompare(String(a.run.release.startedAt ?? a.run.startedAt ?? '')))
}

/** A green staging release held in a packed issue, by its run id (runtime/release.mjs stagedRelease). */
export async function findPackedRelease (project, releaseId, { listIssues = null, readPackedRuns = packedRunsOf } = {}) {
  const list = listIssues ?? (await issuesModule()).listIssues
  for (const issue of await list(project, { archived: true })) {
    if (!issue.packed) continue
    const run = (await readPackedRuns(issue.project ?? project, issue.id)).find((r) => r.runId === releaseId)
    if (run?.release) return { issue, run }
  }
  return null
}

/**
 * Whether a release's retained archive is there and is the recorded bytes, read
 * now: a recorded or remembered identity says what the archive held, never that
 * it still holds it. Packed issues are read from their bundle.
 */
export async function archiveVerified ({ issue, run }) {
  const sha256 = run.release?.sha256
  if (!sha256) return false
  let scratch = null
  try {
    let archive = path.join(issue.path ?? '', 'runs', run.runId, 'artifacts', 'release.tar')
    if (issue.packed) {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-release-verify-'))
      archive = path.join(scratch, 'release.tar')
      await extractMember(issue.location, `${issue.id}/runs/${run.runId}/artifacts/release.tar`, archive)
    }
    return await sha256File(archive) === sha256
  } catch {
    return false
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

const identities = new Map()
/** A release's content identity from its retained archive, verified against its recorded hash; null when it cannot be. */
export async function archiveIdentity ({ issue, run }) {
  const sha256 = run.release.sha256
  if (!sha256) return null
  const key = `${sha256}\0${FINGERPRINT_RULE}`
  if (identities.has(key)) return identities.get(key)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-release-identity-'))
  try {
    let archive = path.join(issue.path ?? '', 'runs', run.runId, 'artifacts', 'release.tar')
    if (issue.packed) {
      archive = path.join(scratch, 'release.tar')
      await extractMember(issue.location, `${issue.id}/runs/${run.runId}/artifacts/release.tar`, archive)
    }
    if (await sha256File(archive) !== sha256) return null
    const tree = path.join(scratch, 'tree')
    await fs.mkdir(tree)
    const extracted = await runProcess({ command: 'tar', args: ['-xpf', archive, '-C', tree], maxBuffer: 1048576 })
    if (extracted.code !== 0 || extracted.cancelled) return null
    const identity = await contentIdentity(tree)
    identities.set(key, identity)
    return identity
  } catch {
    return null
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** The checkout's content as the release's run would have snapshotted it. */
export async function checkoutIdentity (projectPath, workspace = {}) {
  const baseline = new Map()
  baseline.modes = new Map()
  const read = await destinationFingerprint({ ...workspace, source: { ...(workspace.source ?? {}), path: projectPath } }, baseline, undefined, [], { excludes: RELEASE_EXCLUDES })
  return { identity: treeIdentity(read.entries), rule: read.rule }
}

const describe = ({ issue, run }) => ({ issueId: issue.id, runId: run.runId, startedAt: run.release.startedAt ?? run.startedAt ?? null, packed: Boolean(issue.packed) })

/**
 * The newest green staging release whose content is the checkout's, or why there is none:
 *   { releaseId, issueId, startedAt, packed, matched: 'content-identity' }
 *   { releaseId: null, reason: 'no-green-staging' | 'content-not-staged', latestGreen, compared, unverifiable }
 */
export async function selectStagedRelease ({ project, projectPath, listIssues, listHomes = null, readRuns, readPackedRuns, identityOfArchive = archiveIdentity, identityOfCheckout = checkoutIdentity, verifyArchive = archiveVerified }) {
  const green = await greenStagingReleases({ project, listIssues, listHomes, readRuns, readPackedRuns })
  const unverifiable = []
  const compared = []
  const checkout = new Map()
  for (const release of green) {
    const recorded = release.run.release.content
    const content = recorded?.identity && recorded.rule === FINGERPRINT_RULE ? recorded : await identityOfArchive(release)
    if (!content) { unverifiable.push(describe(release)); continue }
    const workspace = release.run.workspace ?? {}
    const key = JSON.stringify([workspace.symlinks?.materialized ?? [], workspace.symlinks?.selection ?? null, workspace.base?.excludes ?? [], workspace.base?.nested ?? []])
    if (!checkout.has(key)) checkout.set(key, await identityOfCheckout(projectPath, workspace).catch(() => null))
    const candidate = checkout.get(key)
    compared.push(describe(release))
    if (!candidate || candidate.rule !== content.rule || candidate.identity !== content.identity) continue
    // The identity matched; the archive must still be the recorded bytes, or this release cannot be promoted.
    if (!(await verifyArchive(release))) { unverifiable.push(describe(release)); continue }
    return { releaseId: release.run.runId, ...describe(release), matched: 'content-identity' }
  }
  return { releaseId: null, reason: green.length ? 'content-not-staged' : 'no-green-staging', latestGreen: green[0] ? describe(green[0]) : null, compared, unverifiable }
}

/**
 * Resolve a playbook, filling a production release's releaseId from the
 * selection when the operator named none. Preview and start both go through
 * here, so what a preview showed is what the start resolves (the fill is in the
 * configHash).
 */
export async function resolveWithRelease (playbookId, options, select) {
  const first = await resolvePlaybook(playbookId, options)
  if (!first.ok || !needsSelection(first.resolved) || !select) return first
  const stagedRelease = await select()
  return resolvePlaybook(playbookId, { ...options, stagedRelease })
}
