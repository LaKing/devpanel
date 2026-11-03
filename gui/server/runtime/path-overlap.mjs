import fs from 'node:fs/promises'
import path from 'node:path'

import { projectPath as projectDir } from '../project-path.mjs'
import { candidatePaths } from './diff.mjs'
import { planOfRun } from './engine.mjs'
import { escapingLinks, workspaceProjection } from './fingerprint.mjs'
import { splitPatch } from './patch-check.mjs'
import { priorRuns, stepText } from './prior-runs.mjs'
import * as store from './store.mjs'

/*
 * Would this candidate write files another live run is also touching?
 *
 * Other issues of the same project may run beside it, and two projects can edit
 * one file: an application's linked collection (`@…-modules -> <projects-root>/framework/…`)
 * delivers into the framework's checkout, and whichever run delivers second finds
 * its paths drifted. So both sides are reduced to where a delivery would really
 * land, and compared there. `workspace.related` plays no part: it grants read-only
 * snapshots and writes nothing.
 *
 * A reading, never a decision. It reserves and writes nothing, refuses nothing,
 * and can be out of date a moment later. Expected paths are an estimate from the
 * issue's earlier runs: a first run has none, which reads `unknown`, never `none`.
 * Plan paths are tokens from prose, so a file a plan only mentions can match, and
 * says so with `via: plan`. An absolute path in a plan is followed only when it
 * lies in a listed project; any other is compared as the string it is. A live
 * in-place run's writes through a link do not show in its git changes. Whatever
 * could not be read is named, and reads `unknown`, never `none`.
 */

const MAX_FILES_SHOWN = 30
// No path is longer than this, so nothing a delivery could write is dropped by it.
const MAX_PATH_LENGTH = 4096
const MAX_PATCH_BYTES = 64 * 1024 * 1024

const inside = (root, file) => file === root || file.startsWith(root + path.sep)
const REPORTED = ['overlap', 'unknown']
/** Whether a reading says something a start should carry. */
export const worthRecording = (report) => REPORTED.includes(report?.state)

/** What a resolved configuration would do with its candidate. */
export const deliveryActionOf = (resolved) => resolved?.workspace?.isolation === 'in-place' ? 'in-place' : resolved?.completion?.delivery?.action ?? null

/** Path-like tokens of prose, normalized; `..` never survives, so none climbs out of a root. */
export function pathsInText (text) {
  const found = new Set()
  for (const [raw] of String(text ?? '').matchAll(/[^\s`'"()<>[\]{},;|*]+/g)) {
    if (raw.includes('://') || raw.length > MAX_PATH_LENGTH) continue
    const token = raw.replace(/#L?\d.*$/, '').replace(/(:\d+)+(-\d+)?$/, '').replace(/[.:!?]+$/, '').replace(/^\.\//, '')
    if (!/[/.]/.test(token)) continue
    const segments = (token.startsWith('/') ? token.slice(1) : token).split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..')) continue
    found.add(token)
  }
  return [...found]
}

/** Where a path under `root` really is: every link followed, a file not there yet placed in its existing parent. */
async function realDestination (root, rel) {
  let current = path.join(root, rel)
  const rest = []
  while (inside(root, current) && current !== root) {
    const real = await fs.realpath(current).catch(() => null)
    if (real) return path.join(real, ...rest)
    rest.unshift(path.basename(current))
    current = path.dirname(current)
  }
  return path.join(root, ...rest)
}

/** The listed project an absolute path lies in, by any spelling of its directory: { root, rel }, or null. */
function locate (token, roots) {
  const hits = roots.filter((r) => r.spellings.some((s) => inside(s, token)))
  const owner = hits.sort((a, b) => b.path.length - a.path.length)[0]
  if (!owner) return null
  const spelling = owner.spellings.filter((s) => inside(s, token)).sort((a, b) => b.length - a.length)[0]
  return { root: owner.path, rel: path.relative(spelling, token) }
}

// An absolute path outside every listed project never touches the filesystem.
async function expectedDestination (root, token, roots) {
  if (!token.startsWith('/')) return realDestination(root, token)
  const hit = locate(token, roots)
  return hit ? realDestination(hit.root, hit.rel) : token
}

async function patchPaths (file, runId, gaps) {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) return []
  if (stat.size > MAX_PATCH_BYTES) { gaps.push(`the patch of run ${runId} is too large to read (${stat.size} bytes)`); return [] }
  return [...new Set(splitPatch(await fs.readFile(file, 'utf8')).flatMap((s) => [s.path, s.from]).filter(Boolean))]
}

const readWorktree = async (workspace) => {
  const exclude = workspaceProjection(workspace).exclude
  const paths = await candidatePaths(workspace.path, { baseCommit: workspace.baseCommit ?? null, gitDir: workspace.gitDir ?? null, fenceStubs: workspace.fenceStubs })
  return exclude ? paths.filter((p) => !exclude(p)) : paths
}

/** The paths an earlier run's candidate changes: retained worktree, delivered patch, then its latest check's patch. */
async function revisionPaths (issuePath, run, gaps) {
  if (!run.revisions?.length) return []
  const ws = run.workspace ?? {}
  if (ws.isolation === 'in-place') return run.delivery?.changedPaths ?? []
  if (ws.path && ws.state !== 'removed' && await fs.stat(ws.path).catch(() => null)) {
    const paths = await readWorktree(ws).catch((error) => { gaps.push(`the retained worktree of run ${run.runId} could not be read: ${error.message}`); return [] })
    if (paths.length) return paths
  }
  const dir = store.runDir(issuePath, run.runId)
  if (run.delivery?.artifactRef) {
    const paths = await patchPaths(path.join(dir, run.delivery.artifactRef), run.runId, gaps)
    if (paths.length) return paths
  }
  for (const record of [...(run.checkResults ?? []), ...(run.checkHistory ?? [])].reverse()) {
    if (!record.dir || !record.revision) continue
    const named = (record.migratedFrom ?? record.revision).replace('sha256:', '').slice(0, 16)
    const paths = await patchPaths(path.resolve(dir, record.dir, 'artifacts', `${named}.patch`), run.runId, gaps)
    if (paths.length) return paths
  }
  return []
}

/** The tokens of a run's plan, the approved one first. The step folder holds the full text. */
async function planPaths (issuePath, run, gaps) {
  try {
    const outputs = await store.readOutputs(issuePath, run.runId)
    const snapshot = await store.readSnapshot(issuePath, run.runId).catch(() => ({}))
    const plan = planOfRun(snapshot, run.steps ?? [], outputs)
    const number = plan.approvedStep ?? plan.currentStep
    if (number == null) return []
    const step = (run.steps ?? []).find((s) => s.number === number)
    return pathsInText(step ? await stepText(issuePath, step) : plan.approved ?? plan.current)
  } catch (error) {
    gaps.push(`the plan of run ${run.runId} could not be read: ${error.message}`)
    return []
  }
}

/** What the issue's newest earlier run with anything to say expects to change. */
async function expectedPaths (issuePath) {
  const gaps = []
  if (!issuePath) return { known: false, source: null, fromRun: null, paths: [], gaps }
  for (const run of (await priorRuns(issuePath, null)).reverse()) {
    const revision = await revisionPaths(issuePath, run, gaps)
    if (revision.length) return { known: true, source: 'previous-revision', fromRun: run.runId, paths: revision, gaps }
    const plan = await planPaths(issuePath, run, gaps)
    if (plan.length) return { known: true, source: 'plan', fromRun: run.runId, paths: plan, gaps }
  }
  return { known: false, source: null, fromRun: null, paths: [], gaps }
}

/** Where a live run's path lands: through the binding its delivery will use, else through the project's links. */
async function liveDestination (root, run, spelled, roots) {
  let rel = spelled
  if (spelled.startsWith('/')) {
    const hit = locate(spelled, roots)
    if (!hit) return spelled
    if (hit.root !== root) return realDestination(hit.root, hit.rel)
    rel = hit.rel
  }
  const binding = (run.workspace?.symlinks?.owners ?? []).find((o) => o.resolved && (rel === o.path || rel.startsWith(o.path + '/')))
  if (!binding) return realDestination(root, rel)
  return binding.directory ? path.join(binding.resolved, rel.slice(binding.path.length + 1)) : binding.resolved
}

/** A live run's files as of now: destination -> via. `reason` says why they could not all be read. */
async function touchedBy (root, issuePath, run, roots) {
  const files = new Map()
  const add = async (rel, via) => {
    const destination = await liveDestination(root, run, rel, roots)
    files.set(destination, [...new Set([...(files.get(destination) ?? []), via])])
  }
  const ws = run.workspace ?? {}
  let reason = null
  if (!ws.path) reason = 'it has no workspace yet'
  else if (ws.state === 'removed') reason = 'its workspace was removed'
  else {
    try {
      for (const rel of await readWorktree(ws)) await add(rel, 'worktree')
    } catch (error) { reason = `its worktree could not be read: ${error.message}` }
  }
  const gaps = []
  for (const token of await planPaths(issuePath, run, gaps)) await add(token, 'plan')
  if (gaps.length) reason = [reason, ...gaps].filter(Boolean).join('; ')
  if (!reason && !files.size) reason = 'it has changed and planned nothing yet'
  return { files, reason }
}

const list = (files) => {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  return { files: sorted.slice(0, MAX_FILES_SHOWN), more: Math.max(0, sorted.length - MAX_FILES_SHOWN) }
}

/** One entry per live run and owning project. */
function entriesOf (live, matches, { project, ownerOf }) {
  const byOwner = new Map()
  for (const match of matches) {
    const owner = ownerOf(match.destination)
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), match])
  }
  return [...byOwner].map(([ownerProject, files]) => ({
    project: live.project, issueId: live.issueId, runId: live.runId, status: live.status, delivery: live.delivery, ownerProject,
    // A third project writing into the owner is the same hazard as the owner's own run.
    relation: live.project === project ? 'same-project' : ownerProject === project ? 'candidate-owns' : ownerProject === live.project ? 'owner-live' : 'co-writer',
    ...list(files)
  }))
}

const names = (entry) => `${entry.files.map((f) => f.path).join(', ')}${entry.more ? ` and ${entry.more} more` : ''}`
const describe = (entry) => `${entry.project} (run ${entry.runId} of issue ${entry.issueId}, ${entry.status}) touches ${names(entry)}, owned by ${entry.ownerProject ?? 'a checkout outside every project'}`

function detailOf ({ state, expected, overlaps, possible, uncompared }) {
  const unread = `${expected.incomplete.length ? ` Expected files not fully read: ${expected.incomplete.join('; ')}.` : ''}${uncompared.length ? ` Not compared: ${uncompared.map((u) => `${u.project}${u.runId ? ` (run ${u.runId})` : ''}: ${u.reason}`).join('; ')}.` : ''}`
  if (state === 'overlap') return `This candidate's expected files, from the ${expected.source === 'plan' ? 'plan' : 'previous revision'} of run ${expected.fromRun}, are also being touched: ${overlaps.map(describe).join('; ')}. Whichever delivers second may find its paths drifted. The start is not refused.${unread}`
  if (state === 'none') return expected.known ? 'No other live run touches this candidate\'s expected files.' : 'No other run that delivers is live.'
  const first = expected.known ? `This candidate's expected files, from run ${expected.fromRun}, match nothing that could be read.` : 'This candidate\'s expected files are unknown: no earlier run of this issue has a plan or a revision. This is not an all-clear.'
  return `${first}${possible.length ? ` It could reach files other runs are touching: ${possible.map(describe).join('; ')}.` : ''}${unread} The start is not refused.`
}

/** Files of a live run this candidate's project can reach, for when its expected paths are unknown. */
async function reachable (root, files) {
  const links = await escapingLinks(root, { excludes: ['.git', 'node_modules'] }).catch(() => [])
  const matches = []
  for (const [destination, via] of files) {
    if (inside(root, destination)) { matches.push({ path: path.relative(root, destination), destination, via }); continue }
    const link = links.find((l) => inside(l.resolved, destination))
    if (link) matches.push({ path: path.join(link.path, path.relative(link.resolved, destination)), destination, via })
  }
  return matches
}

/**
 * @param listProjects  [{id, path}], issues.listProjects
 * @param listIssues    issue rows with `latestRun`, issues.listIssues
 * @returns inspect({ project, projectPath, issuePath, deliveryAction, now }) → the reading; it never throws
 */
export function createPathOverlap ({ listProjects, listIssues }) {
  return async function inspect ({ project, projectPath, issuePath = null, deliveryAction = null, now = Date.now() }) {
    const observedAt = new Date(now).toISOString()
    const empty = { observedAt, expected: { known: false, source: null, fromRun: null, count: 0, incomplete: [] }, overlaps: [], possible: [], uncompared: [] }
    if (deliveryAction === 'none') return { state: 'not-applicable', ...empty, detail: 'This configuration delivers nothing.' }
    try {
      const root = await fs.realpath(projectPath)
      const projects = await Promise.all((await listProjects()).map(async (p) => {
        const real = await fs.realpath(p.path).catch(() => p.path)
        return { id: p.id, path: real, spellings: [...new Set([real, p.path, projectDir(p.id)])] }
      }))
      const roots = projects.some((p) => p.path === root) ? projects : [...projects, { id: project, path: root, spellings: [root, projectPath] }]
      const expected = await expectedPaths(issuePath)
      const wanted = new Map()
      for (const rel of expected.paths) wanted.set(await expectedDestination(root, rel, roots), rel)

      // The longest root: a project inside another's directory owns its own files.
      const ownerOf = (destination) => projects.filter((p) => inside(p.path, destination)).sort((a, b) => b.path.length - a.path.length)[0]?.id ?? null

      const overlaps = [], possible = [], uncompared = []
      let liveRuns = 0
      for (const other of roots) {
        let rows
        try { rows = await listIssues(other.id) } catch (error) { uncompared.push({ project: other.id, issueId: null, runId: null, reason: `its issues could not be listed: ${error.message}` }); continue }
        for (const row of rows) {
          if (!row.latestRun?.live) continue
          // This candidate's own issue; every other issue of its project may be touching the same files.
          if (other.id === project && issuePath && path.resolve(row.path) === path.resolve(issuePath)) continue
          const { runId, status } = row.latestRun
          const run = await store.readRun(row.path, runId).catch(() => null)
          if (!run) { liveRuns++; uncompared.push({ project: other.id, issueId: row.id, runId, reason: 'its record could not be read' }); continue }
          const snapshot = await store.readSnapshot(row.path, runId).catch(() => null)
          const delivery = deliveryActionOf(snapshot)
          if (delivery === 'none') continue
          liveRuns++
          const live = { project: other.id, issueId: row.id, runId, status, delivery }
          const { files, reason } = await touchedBy(other.path, row.path, run, roots)
          if (reason) uncompared.push({ project: other.id, issueId: row.id, runId, reason })
          const matches = [...files].filter(([destination]) => wanted.has(destination)).map(([destination, via]) => ({ path: wanted.get(destination), destination, via }))
          overlaps.push(...entriesOf(live, matches, { project, ownerOf }))
          if (!expected.known && files.size) possible.push(...entriesOf(live, await reachable(root, files), { project, ownerOf }))
        }
      }
      const state = overlaps.length ? 'overlap' : uncompared.length || ((!expected.known || expected.gaps.length) && liveRuns) ? 'unknown' : 'none'
      const summary = { known: expected.known, source: expected.source, fromRun: expected.fromRun, count: expected.paths.length, incomplete: expected.gaps }
      return { state, observedAt, expected: summary, overlaps, possible, uncompared, detail: detailOf({ state, expected: summary, overlaps, possible, uncompared }) }
    } catch (error) {
      return { state: 'unavailable', ...empty, detail: `The overlap with other live runs could not be read: ${error.message}` }
    }
  }
}
