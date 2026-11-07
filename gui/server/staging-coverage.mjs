import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import { projectInfrastructure } from './infrastructure.mjs'
import { packedRunsOf, runsOf } from './supervisor-overview.mjs'
import { gitIdentity } from './runtime/fingerprint.mjs'
import { splitPatch } from './runtime/patch-check.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { stagedReleasePassed } from './runtime/run-result.mjs'

/*
 * What a staging release carried of the runs delivered into a project's
 * development checkout, read from content.
 *
 * A delivery's patch names, per path, the blob before and after it. A Staging
 * run's snapshot is compared with those when the release happens, and the result
 * stays on its record (run.release.coverage). A run is covered when, for every
 * path it changed, the snapshot holds its bytes or those of a later delivery
 * built on them. Recorded order only says which delivery is later, and a release
 * counts only for runs delivered before it started: order can exclude, and only
 * bytes establish coverage.
 *
 * Only a successful staging release clears a run. `deploy_staging` runs opaque saved
 * commands and leaves no shipped bytes to compare, so it names its candidates
 * unproven and changes no list; its checkout reading is information only.
 *
 * The engine starts nothing from this. It supplies the list; the top-level
 * supervisor or an operator cuts the batch (docs/staging-deployment.md).
 *
 * A delivery from before COVERAGE_BASELINE is history: counted in one number, its
 * content never read, named on no record and noted on no issue.
 */

/**
 * When coverage began, the same for every project and whatever it has configured,
 * so the same records always read the same. Older deliveries were never tracked,
 * and what their paths have held since names nothing anyone can act on.
 */
export const COVERAGE_BASELINE = '2026-11-03T00:00:00.000Z'
export const DEPLOYMENT_UNPROVEN = 'deployed-content-unproven'
const LIVE = ['preflighting', 'pending', 'running', 'stopping', 'paused']
const ENDED = ['completed', 'blocked', 'failed', 'cancelled']
const NAMES_IN_WORDS = 20

const safe = (rel) => typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) && rel.split('/').every((p) => p && p !== '.' && p !== '..')
const blobOf = (id) => (id && !/^0+$/.test(id) ? { blob: id } : {})
const delivery = (d) => `\`${d.runId}\`${d.issueId ? ` (${d.issueId})` : ''}`

/** A file header whose two sides are the same unquoted path: `--no-renames` makes every one so, spaces included. */
function sameSides (body) {
  const rest = /^diff --git (.*)$/m.exec(body)?.[1]
  if (!rest || rest.length < 5 || rest.startsWith('"')) return null
  const name = rest.slice(2, 2 + (rest.length - 5) / 2)
  return rest === `a/${name} b/${name}` ? name : null
}

/**
 * Per path, what a delivery's own patch (`--binary --full-index --no-renames`)
 * says stood before and after it: `{ blob, mode }`, null for absent. A mode-only
 * change has no index line, so no blob, and its bytes are not on record
 * (deliveredContent reads such a delivery as unknown). Null when a header cannot be read.
 */
export function parsePatchContent (text) {
  const entries = []
  for (const section of splitPatch(text)) {
    const rel = section.path ?? sameSides(section.body)
    if (!rel) return null
    let oldMode = null, newMode = null, index = null, added = false, deleted = false
    for (const line of section.body.split('\n').slice(1)) {
      if (line.startsWith('@@ ') || line.startsWith('--- ') || line === 'GIT binary patch') break
      let m
      if ((m = /^old mode (\d+)$/.exec(line))) oldMode = m[1]
      else if ((m = /^new mode (\d+)$/.exec(line))) newMode = m[1]
      else if ((m = /^new file mode (\d+)$/.exec(line))) { newMode = m[1]; added = true }
      else if ((m = /^deleted file mode (\d+)$/.exec(line))) { oldMode = m[1]; deleted = true }
      else if ((m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(line))) index = { pre: m[1], post: m[2], mode: m[3] ?? null }
    }
    if (!index && !(oldMode && newMode)) return null
    entries.push({
      path: rel,
      pre: added ? null : { ...blobOf(index?.pre), mode: oldMode ?? index?.mode },
      post: deleted ? null : { ...blobOf(index?.post), mode: newMode ?? index?.mode }
    })
  }
  return entries
}

/** Does what was read at a path (gitIdentity) hold this recorded state? A state with no blob holds nothing: unknown content is no match. */
export function holds (state, read) {
  if (state === null) return read === null
  if (!read || read.other || read.mode !== state.mode || !state.blob) return false
  return read[state.blob.length === 64 ? 'sha256' : 'sha1'] === state.blob
}

/** Two recorded states; an unknown before-image (undefined) or unknown content (no blob) never equals anything. */
const sameState = (a, b) => {
  if (a === undefined || b === undefined) return false
  if (a === null || b === null) return a === b
  return a.mode === b.mode && Boolean(a.blob) && a.blob === b.blob
}

/**
 * How a run's work reached the development checkout, if it did. Stricter than the
 * overview's deliveryOf: a retained patch or an unmerged commit is not in the
 * checkout. `at` is the order deliveries are read in, a landing's the time it was
 * recorded, not the time it claims.
 */
export function deliveredRun (run, { checkouts = [] } = {}) {
  if (run.landed) return { kind: 'manual', action: 'landed', at: run.landed.recordedAt ?? null }
  if (run.artifactApplication?.verified === true) return { kind: 'engine', action: 'artifact-applied', at: run.artifactApplication.completedAt ?? null }
  const d = run.delivery
  if (d?.completedAt && d.action === 'apply-to-source' && d.application?.verified === true) return { kind: 'engine', action: d.action, at: d.completedAt }
  if (d?.completedAt && d.action === 'in-place' && run.revisions?.length) return { kind: 'engine', action: d.action, at: d.completedAt }
  const merged = run.integration
  if (merged?.phase === 'complete' && merged.mergeCommit && (merged.worktrees?.updated ?? []).some((w) => checkouts.includes(w))) {
    return { kind: 'engine', action: 'integrated', at: merged.at ?? d?.completedAt ?? null }
  }
  return null
}

const before = (d, at) => Boolean(d.at && at) && Date.parse(d.at) <= Date.parse(at)

/** From before the baseline, by the delivery's time or, on an older record with none, its run's. A run with no time at all stays listed: nothing shows it is old. */
const isHistory = (delivered, run) => Date.parse(delivered.at ?? run.endedAt ?? run.startedAt ?? '') < Date.parse(COVERAGE_BASELINE)

const patchMemo = new Map()
const execTar = (args, maxBuffer = 256 * 1024 * 1024) => new Promise((resolve, reject) =>
  execFile('tar', args, { maxBuffer }, (error, stdout) => (error ? reject(error) : resolve(stdout))))

/** The patch a run delivered, parsed once per version of the file holding it: its own, or its packed issue's bundle. */
async function patchEntries (issue, run, ref) {
  const file = issue.packed ? issue.location : path.join(issue.path, 'runs', run.runId, ref)
  const stat = await fs.stat(file)
  const key = `${file}\0${run.runId}\0${ref}\0${stat.mtimeMs}\0${stat.size}`
  if (patchMemo.has(key)) return patchMemo.get(key)
  const text = issue.packed ? await execTar(['-xzOf', file, `${issue.id}/runs/${run.runId}/${ref}`]) : await fs.readFile(file, 'utf8')
  const entries = parsePatchContent(text)
  if (patchMemo.size >= 5000) patchMemo.delete(patchMemo.keys().next().value)
  patchMemo.set(key, entries)
  return entries
}

/** A landing's patch: the delivered one when it is the revision landed, else that revision's check artifact. */
function landedPatchRef (run) {
  const revision = run.landed.revision
  if (run.delivery?.artifactRef && run.delivery.revision === revision) return run.delivery.artifactRef
  const check = [...(run.checkResults ?? []), ...(run.checkHistory ?? [])].reverse().find((c) => c.dir && c.revision === revision)
  if (!check) return null
  return path.posix.join(check.dir, 'artifacts', `${(check.migratedFrom ?? check.revision).replace('sha256:', '').slice(0, 16)}.patch`)
}

/**
 * The bytes a delivery left, path by path, or the reason they cannot be known,
 * which reads as indeterminate and never as covered.
 */
async function deliveredContent (issue, run) {
  if (run.landed && !/^none\.?$/i.test(run.landed.handChanges?.trim() ?? '')) return { reason: 'landed-with-hand-changes' }
  if (!run.landed && !run.artifactApplication && run.delivery?.action === 'in-place') {
    return run.delivery.content ? { entries: run.delivery.content } : { reason: 'no-content-on-record' }
  }
  const ref = run.landed ? landedPatchRef(run) : run.delivery?.artifactRef
  if (!ref) return { reason: 'no-patch-on-record' }
  const entries = await patchEntries(issue, run, ref).catch(() => null)
  if (!entries?.length) return { reason: 'patch-unreadable' }
  // A chmod names modes and no blob, so no comparison can say its bytes are the ones it left.
  return entries.some((e) => e.post && !e.post.blob) ? { reason: 'mode-only-bytes-unknown' } : { entries }
}

/** Read once, when something asks: a delivery no question reaches never has its patch or bundle opened. */
const contentOf = async (d) => (d.content ??= await deliveredContent(d.issue, d.run))

/** The paths a delivery's record names; null when it names none (older than the field, or a landing of another revision), and then only its patch can say. */
const recordedPaths = (run) => (run.landed && run.delivery?.revision !== run.landed.revision ? null : run.delivery?.changedPaths ?? null)

/** What later deliveries built on this path's state left there, in order: this delivery's own first. */
async function chainPosts (d, entry, deliveries, upTo) {
  const posts = [entry.post]
  let tip = entry.post
  for (const later of deliveries.slice(deliveries.indexOf(d) + 1)) {
    if (upTo && !before(later, upTo)) break
    // A later delivery whose record shows it left this path alone keeps its patch and bundle closed.
    if (recordedPaths(later.run)?.includes(entry.path) === false) continue
    const next = (await contentOf(later)).entries?.find((e) => e.path === entry.path)
    if (!next) continue
    if (!sameState(next.pre, tip)) break
    tip = next.post
    posts.push(tip)
  }
  return posts
}

/** A run against one reading of the tree: covered, with what superseded it, or the paths the reading does not explain. */
async function compare (d, deliveries, read, upTo) {
  const superseded = []
  const paths = []
  for (const entry of d.content.entries) {
    const found = await read(entry.path)
    // Its own bytes answer it: only a path that differs asks what later deliveries left.
    if (holds(entry.post, found)) continue
    if ((await chainPosts(d, entry, deliveries, upTo)).some((post) => holds(post, found))) superseded.push(entry.path)
    else paths.push(entry.path)
  }
  return { paths, superseded }
}

const treeReader = (root) => (rel) => (safe(rel) ? gitIdentity(path.join(root, rel)) : { other: true })

const checkoutMemo = new Map()
/** The live checkout, a file re-read unless its stat is the one it had comfortably before it was last read. */
const checkoutReader = (root) => !root ? null : async (rel) => {
  if (!safe(rel)) return { other: true }
  const full = path.join(root, rel)
  const stat = await fs.lstat(full).catch(() => null)
  if (!stat) return null
  const key = `${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`
  const seen = checkoutMemo.get(full)
  if (seen?.key === key && seen.readAt - stat.ctimeMs > 2000) return seen.id
  const id = await gitIdentity(full)
  if (checkoutMemo.size >= 20000) checkoutMemo.delete(checkoutMemo.keys().next().value)
  checkoutMemo.set(full, { key, id, readAt: Date.now() })
  return id
}

/** Every operation record of an issue, retry archives included: its folder's, or its packed summary's copy. */
async function readOperationFiles (issue) {
  if (issue.packed) {
    if (issue.stagingOperations === 0) return []
    const [{ packedSummary }, { ISSUES_DIR }] = await Promise.all([import('./issue-bundle.mjs'), import('./issues.js')])
    return (await packedSummary(ISSUES_DIR, issue.project, issue.id))?.operations ?? []
  }
  const dir = path.join(issue.path, 'operations')
  const names = await fs.readdir(dir).catch(() => [])
  const out = []
  for (const name of names.filter((n) => /^staging-deployment(-.+)?\.json$/.test(n))) {
    const op = await fs.readFile(path.join(dir, name), 'utf8').then(JSON.parse).catch(() => null)
    if (op) out.push(op)
  }
  return out
}

/** The project as this reading needs it: deliveries in order, staging releases, deployments, what is live. */
async function projectState ({ project, projectPath = null, lists = null, listIssues, listHomes = null, readRuns = runsOf, readPackedRuns = packedRunsOf, readOperations = readOperationFiles }) {
  const [open, archived] = lists ? [lists.open, lists.archived] : await Promise.all([listIssues(project), listIssues(project, { archived: true })])
  // The daily full verification releases to staging from its run homes: what those carried is covered too.
  const homes = await (listHomes ?? (await import('./issues.js')).listRunHomes)(project).catch(() => [])
  const checkouts = projectPath ? [projectPath, await fs.realpath(projectPath).catch(() => projectPath)] : []
  const state = { project, projectPath, deliveries: [], history: 0, stagings: [], deployments: [], liveRuns: [] }
  for (const issue of [...open, ...archived, ...homes]) {
    const history = issue.packed ? await readPackedRuns(issue.project ?? project, issue.id) : await readRuns(issue.path)
    for (const run of history) {
      if (LIVE.includes(run.status)) state.liveRuns.push({ issueId: issue.id, runId: run.runId, status: run.status })
      const delivered = deliveredRun(run, { checkouts })
      if (delivered && isHistory(delivered, run)) state.history++
      else if (delivered) state.deliveries.push({ issue, issueId: issue.id, runId: run.runId, run, ...delivered })
      if (run.release?.tactic === 'staging') state.stagings.push({ issue, run })
    }
    for (const operation of await readOperations({ ...issue, project: issue.project ?? project })) state.deployments.push({ issue, operation })
  }
  state.deliveries.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.runId.localeCompare(b.runId))
  state.stagings.sort((a, b) => String(b.run.startedAt ?? '').localeCompare(String(a.run.startedAt ?? '')))
  state.named = new Set()
  const remember = (coverage) => { for (const e of coverage?.indeterminate ?? []) state.named.add(`${e.runId}\0${e.reason}`) }
  for (const { run } of state.stagings) remember(run.release.coverage)
  for (const { operation } of state.deployments) remember(operation.coverage)
  return state
}

const archiveHash = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')))
})

/** Copy one member of a packed issue's bundle out to a file, unheld. */
async function extractMember (bundle, member, target) {
  const child = spawn('tar', ['-xzOf', bundle, member], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))))
  })
  await Promise.all([pipeline(child.stdout, createWriteStream(target)), exited])
}

const NOT_FOUND = /^tar: .*: Not found in archive$|^tar: Exiting with failure status due to previous errors$/

/** Named members of a release archive, read from the archive. Members it lacks read as absent; any other trouble throws. */
export async function readTarMembers (archive, paths) {
  const found = new Map()
  const asked = paths.filter(safe)
  for (const rel of paths) if (!safe(rel)) found.set(rel, { other: true })
  if (!asked.length) return found
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-staging-coverage-'))
  try {
    await new Promise((resolve, reject) => {
      const child = execFile('tar', ['-xf', archive, '-C', dir, '--null', '--no-wildcards', '--verbatim-files-from', '-T', '-'], { maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (!error) return resolve()
        const lines = String(stderr).split('\n').filter(Boolean)
        if (error.code === 2 && lines.length && lines.every((line) => NOT_FOUND.test(line))) return resolve()
        reject(error)
      })
      child.stdin.on('error', () => {})
      child.stdin.end(asked.map((rel) => `./${rel}\0`).join(''))
    })
    for (const rel of asked) found.set(rel, await gitIdentity(path.join(dir, rel)))
    return found
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const tarMemo = new Map()
/**
 * A pre-feature green release's snapshot, from its retained archive verified
 * against the hash on its record; a missing or changed archive establishes
 * nothing. Reads the whole archive once per new set of paths, one reader at a
 * time per archive, and keeps what it read for the life of the process.
 */
async function retainedSnapshot ({ issue, run }, paths) {
  const sha256 = run.release.sha256
  if (!sha256) return null
  const memo = tarMemo.get(sha256) ?? { reads: new Map(), queue: Promise.resolve() }
  tarMemo.set(sha256, memo)
  const work = memo.queue.then(async () => {
    const missing = paths.filter((rel) => !memo.reads.has(rel))
    if (!missing.length) return memo.reads
    let scratch = null
    try {
      let archive = issue.packed ? null : path.join(issue.path, 'runs', run.runId, 'artifacts', 'release.tar')
      if (issue.packed) {
        scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-staging-archive-'))
        archive = path.join(scratch, 'release.tar')
        await extractMember(issue.location, `${issue.id}/runs/${run.runId}/artifacts/release.tar`, archive)
      }
      if (await archiveHash(archive) !== sha256) return null
      for (const [rel, id] of await readTarMembers(archive, missing)) memo.reads.set(rel, id)
      return memo.reads
    } finally {
      if (scratch) await fs.rm(scratch, { recursive: true, force: true })
    }
  }).catch(() => null)
  memo.queue = work
  return work
}

/**
 * Runs no successful staging release covers, with what successful ones named them.
 * A successful release that recorded nothing (older than this, or its reading
 * failed) is read from its retained archive, newest first, and writes nothing.
 */
async function uncovered (state) {
  const covered = new Set()
  const named = new Map()
  const retained = []
  for (const release of state.stagings) {
    if (!stagedReleasePassed(release.run.release, release.run)) continue
    const coverage = release.run.release.coverage
    if (!coverage || coverage.error) { retained.push(release); continue }
    for (const e of coverage.covered ?? []) covered.add(e.runId)
    for (const e of coverage.indeterminate ?? []) if (!named.has(e.runId)) named.set(e.runId, { reason: e.reason, paths: e.paths ?? [] })
  }
  let remaining = state.deliveries.filter((d) => !covered.has(d.runId))
  for (const d of remaining) await contentOf(d)
  for (const release of retained) {
    const candidates = remaining.filter((d) => d.content.entries && before(d, release.run.startedAt))
    if (!candidates.length) continue
    const snapshot = await retainedSnapshot(release, [...new Set(candidates.flatMap((d) => d.content.entries.map((e) => e.path)))])
    if (!snapshot) continue
    for (const d of candidates) {
      if (!(await compare(d, state.deliveries, async (rel) => snapshot.get(rel) ?? null, release.run.startedAt)).paths.length) covered.add(d.runId)
    }
    remaining = remaining.filter((d) => !covered.has(d.runId))
  }
  return { remaining, named }
}

/** What a staging release's snapshot carries, for its run record: read once, as the release happens. */
export async function stagingRunCoverage ({ snapshotPath, snapshotAt, ...project }) {
  const state = await projectState(project)
  const { remaining } = await uncovered(state)
  const record = { basis: 'release-snapshot', covered: [], indeterminate: [], notShipped: [] }
  const read = treeReader(snapshotPath)
  for (const d of remaining) {
    const name = { issueId: d.issueId, runId: d.runId }
    // Delivered after the snapshot was taken: not this release's to speak for.
    if (!before(d, snapshotAt)) { record.notShipped.push(name); continue }
    const indeterminate = (reason, paths = []) => record.indeterminate.push({ ...name, reason, paths, firstNamed: !state.named.has(`${d.runId}\0${reason}`) })
    if (!d.content.entries) { indeterminate(d.content.reason); continue }
    const { paths, superseded } = await compare(d, state.deliveries, read, snapshotAt)
    if (paths.length) indeterminate('snapshot-differs', paths)
    else record.covered.push({ ...name, ...(superseded.length ? { superseded } : {}) })
  }
  return record
}

/** Whether the checkout holds a run's bytes now: information, or the live list's test for a hand change. */
async function checkoutHolds (d, deliveries, read) {
  if (!d.content.entries || !read) return { reading: 'unknown', paths: [] }
  const { paths } = await compare(d, deliveries, read, null)
  return { reading: paths.length ? 'differs' : 'held', paths }
}

/**
 * The record of one `deploy_staging`. Every candidate reads indeterminate: the
 * commands are opaque and leave no shipped bytes to compare. The `checkout` field
 * says what the development checkout held around them, and nothing reads it to
 * decide coverage, a list or a batch.
 */
export function deploymentCoverage (project) {
  return {
    async before (startedAt) {
      const state = await projectState(project)
      const { remaining } = await uncovered(state)
      const read = checkoutReader(project.projectPath)
      const indeterminate = []
      for (const d of remaining.filter((c) => before(c, startedAt))) {
        indeterminate.push({
          issueId: d.issueId, runId: d.runId, reason: DEPLOYMENT_UNPROVEN,
          firstNamed: !state.named.has(`${d.runId}\0${DEPLOYMENT_UNPROVEN}`),
          checkout: { before: (await checkoutHolds(d, state.deliveries, read)).reading, after: 'not-read' }
        })
      }
      return { basis: DEPLOYMENT_UNPROVEN, covered: [], indeterminate, checkoutIs: 'information only: what the development checkout held around the commands; it decides nothing' }
    },
    async after (coverage) {
      const state = await projectState(project)
      const read = checkoutReader(project.projectPath)
      for (const entry of coverage.indeterminate) {
        const d = state.deliveries.find((c) => c.runId === entry.runId)
        if (!d) continue
        await contentOf(d)
        entry.checkout.after = (await checkoutHolds(d, state.deliveries, read)).reading
      }
    }
  }
}

/**
 * The pending list of a project, for every project whether or not it can release.
 *
 *   pending        no successful staging release covers it, none named it indeterminate,
 *                  and the checkout holds its bytes: a new release would carry it
 *   indeterminate  its bytes are unknown, a successful staging release could not find
 *                  them, or the checkout no longer holds them; stays until a
 *                  successful staging release's bytes establish it
 *   history        how many deliveries are from before COVERAGE_BASELINE; none is listed
 *
 * A deployment changes neither. batch.ready reads pending only, so a hand-edited
 * path stays visible and cannot prompt batches for ever.
 */
export async function stagingPendingReport ({ root = process.env.DEVPANEL_CONFIG_ROOT, infrastructure = undefined, config = null, ...project }) {
  const infra = infrastructure !== undefined ? infrastructure : await projectInfrastructure(project.project, { root, config }).catch(() => null)
  const configured = {
    stagingRelease: Boolean(infra?.staging?.id && infra?.release?.targets?.[infra.staging.id]),
    sharedDeployment: infra?.stagingDeployment?.enabled === true
  }
  const state = await projectState(project)
  const { remaining, named } = await uncovered(state)
  const read = checkoutReader(project.projectPath ?? null)
  const pending = []
  const indeterminate = []
  for (const d of remaining) {
    const entry = { issueId: d.issueId, runId: d.runId, kind: d.kind, action: d.action, at: d.at, archived: Boolean(d.issue.archived) }
    const red = state.stagings.find(({ run }) => !stagedReleasePassed(run.release, run) && [...(run.release.coverage?.covered ?? []), ...(run.release.coverage?.indeterminate ?? [])].some((e) => e.runId === d.runId))
    if (red) entry.lastAttempt = { issueId: red.issue.id, runId: red.run.runId, status: red.run.release.status }
    const deployed = state.deployments.filter(({ operation }) => operation.coverage?.indeterminate?.some((e) => e.runId === d.runId))
      .sort((a, b) => String(b.operation.startedAt ?? '').localeCompare(String(a.operation.startedAt ?? '')))[0]
    if (deployed) entry.lastDeployment = { issueId: deployed.issue.id, operationId: deployed.operation.id, status: deployed.operation.status }
    if (!d.content.entries) { indeterminate.push({ ...entry, reason: d.content.reason, paths: [] }); continue }
    const paths = d.content.entries.map((e) => e.path)
    if (named.has(d.runId)) { indeterminate.push({ ...entry, reason: named.get(d.runId).reason, paths: named.get(d.runId).paths }); continue }
    const held = await checkoutHolds(d, state.deliveries, read)
    if (held.reading === 'differs') indeterminate.push({ ...entry, reason: 'checkout-differs', paths: held.paths })
    else pending.push({ ...entry, paths })
  }
  const ready = configured.stagingRelease && pending.length > 0 && state.liveRuns.length === 0
  return {
    project: project.project, configured, pending, indeterminate, history: { count: state.history, before: COVERAGE_BASELINE }, liveRuns: state.liveRuns,
    releases: state.stagings.slice(0, 10).map(({ issue, run }) => ({ issueId: issue.id, runId: run.runId, status: run.release.status, passed: stagedReleasePassed(run.release, run),
      covered: run.release.coverage?.covered?.length ?? null, indeterminate: run.release.coverage?.indeterminate?.length ?? null })),
    batch: { ready, reason: ready ? 'pending runs and no delivery in progress' : !configured.stagingRelease ? 'no-staging-release-target' : !pending.length ? 'nothing-pending' : 'delivery-in-progress' }
  }
}

/** The named runs in words, for the run's explanation and notes. */
const listed = (names) => `${names.slice(0, NAMES_IN_WORDS).map(delivery).join(', ')}${names.length > NAMES_IN_WORDS ? ` and ${names.length - NAMES_IN_WORDS} more` : ''}`

function group (entries) {
  const byIssue = new Map()
  for (const entry of entries) byIssue.set(entry.issueId, [...(byIssue.get(entry.issueId) ?? []), entry])
  return byIssue
}

/**
 * A release's receipt, wherever its issue is: in its folder, or, once packed, in the
 * file kept beside its bundle (which stays as verified), falling back to the copy
 * packed inside it. What that copy said is kept beside it too, so a later start
 * does not unpack the bundle again.
 */
function receiptHome ({ project, issue, issues, rel, ref }) {
  if (!issue.packed) {
    const file = path.join(issue.path, rel)
    return { read: () => fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null), write: (receipt) => writeJson(file, receipt) }
  }
  const side = issues.packedReceiptsFile(project, issue.id)
  const kept = () => fs.readFile(side, 'utf8').then(JSON.parse).catch(() => ({}))
  const write = async (receipt) => writeJson(side, { ...await kept(), [ref]: receipt })
  return {
    write,
    async read () {
      const all = await kept()
      if (ref in all) return all[ref]
      const packed = await execTar(['-xzOf', issue.location, `${issue.id}/${rel}`]).then(JSON.parse).catch(() => null)
      await write(packed)
      return packed
    }
  }
}

const runReceipt = (args, runId) => receiptHome({ ...args, rel: `runs/${runId}/staging-coverage-notes.json`, ref: runId })
const operationReceipt = (args, id) => receiptHome({ ...args, rel: `operations/staging-coverage-notes-${id}.json`, ref: id })

/**
 * One note per issue, under a key, so a replay or a later end rewrites it; the
 * receipt says what is still owed. A resume writes only that: an issue whose note
 * is written is left alone.
 */
async function writeNotes ({ project, issues, key, home, notesFor, resume = false }) {
  const receipt = resume ? (await home.read()) ?? {} : {}
  for (const [issueId, text] of notesFor) {
    if (['written', 'gone'].includes(receipt[issueId]?.state)) continue
    try {
      const written = await issues.createEngineNote(project, issueId, { name: 'staging-coverage', text, invocationId: key })
      receipt[issueId] = { state: 'written', where: written.where }
    } catch (error) {
      receipt[issueId] = error.status === 404 ? { state: 'gone' } : { state: 'failed', reason: error.message }
    }
  }
  await home.write(receipt)
  return receipt
}

const notesOwed = async (home) => {
  const receipt = await home.read()
  return !receipt || Object.values(receipt).some((r) => r.state === 'failed')
}

/** The notes of a staging release, once the run has ended; on a later end the same notes say the new outcome. */
export async function writeRunCoverageNotes ({ project, issue, run, issues, resume = false }) {
  const coverage = run?.release?.coverage
  if (!coverage || coverage.error || !issues?.createEngineNote || run.release.tactic !== 'staging' || !ENDED.includes(run.status)) return null
  const passed = stagedReleasePassed(run.release, run)
  const link = `/projects/${project}/${issue.id}?run=${run.runId}`
  const outcome = passed ? 'passed' : `did not pass (release ${run.release.status}, run ${run.status})`
  const restore = run.release.status === 'rolled-back' ? ' The configured automatic restore ran and was verified.'
    : run.release.status === 'recovery-required' ? ' Staging needs recovery: the restore did not complete or was not available.' : ''
  const covered = group(coverage.covered ?? [])
  const unsure = group((coverage.indeterminate ?? []).filter((e) => e.firstNamed || !passed))
  const notesFor = new Map()
  for (const issueId of new Set([...covered.keys(), ...unsure.keys()])) {
    notesFor.set(issueId, [
      `# Staging release ${passed ? 'passed' : 'failed'}`, '',
      `[Release run ${run.runId}](${link}) on issue ${issue.id}: ${outcome}.${restore}`, '',
      ...(covered.has(issueId) ? [`Its snapshot carried this issue's delivered ${covered.get(issueId).length === 1 ? 'run' : 'runs'}: ${listed(covered.get(issueId))}.`, ''] : []),
      ...(unsure.has(issueId) ? [`Indeterminate, so not covered: ${unsure.get(issueId).map((e) => `\`${e.runId}\` (${e.reason})`).join(', ')}.`, ''] : []),
      ...(passed ? [] : ['The failure is attributed to every issue this release carried. No issue is chosen for the follow-up: the supervisor or an operator decides.'])
    ].join('\n').trimEnd())
  }
  return writeNotes({ project, issues, key: `staging-coverage:${run.runId}`, home: runReceipt({ project, issue, issues }, run.runId), notesFor, resume })
}

/** The notes of one `deploy_staging`: a green one first-named runs only, a red one every candidate, since nothing shows which it carried. */
export async function writeDeploymentNotes ({ project, issue, operation, issues, resume = false }) {
  const coverage = operation?.coverage
  if (!issues?.createEngineNote || !coverage || coverage.error || !operation.id) return null
  const passed = operation.status === 'completed'
  const reservations = await (issue.packed ? execTar(['-xzOf', issue.location, `${issue.id}/.step-reservations.json`]) : fs.readFile(path.join(issue.path, '.step-reservations.json'), 'utf8')).then(JSON.parse).catch(() => [])
  const report = reservations.find?.((r) => r?.invocationId === `staging-deployment:${operation.id}`)
  const notesFor = new Map()
  for (const [issueId, entries] of group(coverage.indeterminate.filter((e) => e.firstNamed || !passed))) {
    notesFor.set(issueId, [
      `# Shared staging deployment ${passed ? 'completed' : `did not complete (${operation.status})`}`, '',
      `[Deployment ${operation.id}](/projects/${project}/${issue.id}) on issue ${issue.id}${report ? `, report in step ${report.folder}` : ''}.`, '',
      `What it deployed is unproven: its saved commands leave no shipped bytes to compare. Only a staging release (a Deployment run in the staging environment) can clear these runs: ${entries.map((e) => `\`${e.runId}\` (the development checkout ${e.checkout?.before === 'held' ? 'held' : e.checkout?.before === 'differs' ? 'differed from' : 'could not be compared with'} its bytes before the commands)`).join(', ')}.`,
      ...(passed ? [] : ['', 'The failure is attributed to every run listed for it. No issue is chosen for the follow-up: the supervisor or an operator decides.'])
    ].join('\n'))
  }
  return writeNotes({ project, issues, key: `staging-coverage:${operation.id}`, home: operationReceipt({ project, issue, issues }, operation.id), notesFor, resume })
}

/**
 * At startup: notes a crash or a failed write lost, for what has settled. Given a
 * run, that run's; otherwise every deployment attempt of the issue, a retry's
 * archived ones too. An operation still `running` may be a CLI's; its replay writes them.
 */
export async function resumeCoverageNotes ({ project, issue, run = null, issues }) {
  if (!issues?.createEngineNote) return
  if (run) {
    if (run.release?.coverage && await notesOwed(runReceipt({ project, issue, issues }, run.runId))) await writeRunCoverageNotes({ project, issue, run, issues, resume: true })
    return
  }
  const operations = issue.packed ? await issues.packedOperations(project, issue.id) : await readOperationFiles(issue)
  for (const operation of operations) {
    if (!operation?.coverage || !operation.id || operation.status === 'running') continue
    if (await notesOwed(operationReceipt({ project, issue, issues }, operation.id))) await writeDeploymentNotes({ project, issue, operation, issues, resume: true })
  }
}

/** The same for a release issue archived since, packed or not: its bundle is only read. */
export async function resumeArchivedCoverageNotes ({ project, issue, issues }) {
  if (!issues?.createEngineNote) return
  for (const run of await issues.readRunRecords(project, issue.id)) {
    if (run.release?.coverage) await resumeCoverageNotes({ project, issue, run, issues })
  }
  await resumeCoverageNotes({ project, issue, issues })
}
