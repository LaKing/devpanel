import path from 'node:path'

import { affectedModules, driveFilters, isModulesTarget } from './modules-tier.mjs'
import { planPaths, revisionPaths } from './path-overlap.mjs'
import { priorRuns } from './prior-runs.mjs'
import { readRunReadOnly } from './store.mjs'

/*
 * What the modules tier would test, read before a start (preview and readiness).
 *
 * A drive runs one selftest per filter (modules-tier.mjs driveFilters): every
 * affected module, then every core directory. A drive with no filter runs no
 * test, reads no selftest report, and its gate cannot pass (testedNothing,
 * baseline-failures.mjs). This says so before a start is spent, from the
 * issue's own evidence, and says `unknown` when there is none: it never claims
 * the tier will test nothing without a change set that shows it.
 *
 * The evidence is chosen like path-overlap's expectedPaths: the issue's ended
 * runs newest first, and within each run the first that answers of
 *   1. its latest revision's recorded affectedModules (the engine's reading of
 *      the fingerprint, engine.revisionModules), under the collections in force:
 *      this one may be known and empty;
 *   2. the paths of its latest revision (worktree, delivered patch, check patch);
 *   3. the paths its plan names.
 * An older run's empty revision therefore never outweighs a newer run's paths.
 * The reading describes that change set, never what the next author will change.
 * Read-only; a reading, never a decision.
 */

const MAX_FILTERS_SHOWN = 30
const sameCollections = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const filterNames = (filters) => filters.map((f) => f.filter)
const shown = (list) => `${list.slice(0, MAX_FILTERS_SHOWN).join(', ')}${list.length > MAX_FILTERS_SHOWN ? ` and ${list.length - MAX_FILTERS_SHOWN} more` : ''}`

/** A path as the project sees it: relative; an absolute one inside the project made relative, any other dropped. */
function relative (projectPath, file) {
  if (!file.startsWith('/')) return file
  if (!projectPath) return null
  const rel = path.relative(projectPath, file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null
}

/**
 * The newest evidence of what this issue changes, as the modules tier reads it:
 * `{ known: true, source, fromRun, revision?, affected? | paths?, incomplete, earlierDrive? }`,
 * or `{ known: false, incomplete }`. `affected` is a revision's recorded reading;
 * `paths` are paths still to be mapped.
 */
export async function coverageInput ({ issuePath, target, projectPath = null }) {
  const incomplete = []
  if (!issuePath) return { known: false, incomplete }
  const collections = target?.modules?.collections
  // Read-only (readRunReadOnly): the start preview reads earlier runs through here and writes nothing.
  for (const run of (await priorRuns(issuePath, null, { readRun: readRunReadOnly })).reverse()) {
   try {
    // An earlier drive of this run that tested nothing: a note beside the reading, never its proof.
    const empty = (Array.isArray(run.checkHistory) ? run.checkHistory : []).findLast((h) => h?.tier === 'modules' && h.modules?.tests === 0)
    const earlierDrive = empty ? { earlierDrive: { run: run.runId, revision: empty.revision ?? null, at: empty.at ?? null } } : {}
    const latest = Array.isArray(run.revisions) ? run.revisions.at(-1) : null
    if (latest?.affectedModules && sameCollections(latest.modules?.collections, collections)) {
      return { known: true, source: 'recorded-revision', fromRun: run.runId, revision: latest.fingerprint ?? null, affected: latest.affectedModules, incomplete, ...earlierDrive }
    }
    const revision = (await revisionPaths(issuePath, run, incomplete)).map((p) => relative(projectPath, p)).filter(Boolean)
    if (revision.length) return { known: true, source: 'previous-revision', fromRun: run.runId, revision: latest?.fingerprint ?? null, paths: revision, incomplete, ...earlierDrive }
    const plan = (await planPaths(issuePath, run, incomplete)).map((p) => relative(projectPath, p)).filter(Boolean)
    if (plan.length) return { known: true, source: 'plan', fromRun: run.runId, paths: plan, incomplete, ...earlierDrive }
   } catch (error) {
    // One run's malformed record is a gap in the reading, not the end of it.
    incomplete.push(`run ${run.runId} could not be read: ${error.message}`)
   }
  }
  return { known: false, incomplete }
}

/**
 * The reading: null unless the target is a declared modules tier; otherwise
 * `{ state: tests | nothing | unknown, filters | triageFilters, source, fromRun, detail }`.
 * `triage` is the issue's triage list (sizing.affectedModules), always tested.
 */
export function modulesCoverage ({ target, triage = [], input }) {
  if (!isModulesTarget(target) || !target.modules) return null
  const m = target.modules
  const listed = [...new Set((triage ?? []).filter((x) => typeof x === 'string' && x.length).map((x) => x.replace(/\/+$/, '')))].sort()
  const where = { source: input?.source ?? null, fromRun: input?.fromRun ?? null, ...(input?.revision ? { revision: input.revision } : {}),
    ...(input?.incomplete?.length ? { incomplete: input.incomplete } : {}), ...(input?.earlierDrive ? { earlierDrive: input.earlierDrive } : {}) }
  const note = input?.earlierDrive ? ` An earlier modules drive of run ${input.earlierDrive.run} tested nothing.` : ''
  if (!input?.known) {
    const triageFilters = filterNames(driveFilters(m, { modules: listed, core: null }))
    return { state: 'unknown', triageFilters, ...where,
      detail: `Modules tier coverage is unknown: no earlier run of this issue has a recorded revision or a plan naming paths, so which selftests run is decided per revision.${triageFilters.length ? ` The triage's modules are tested whatever changes: ${shown(triageFilters)}.` : ''}${note}` }
  }
  const affected = input.affected
    ? { modules: [...new Set([...listed, ...(input.affected.fromPaths ?? [])])].sort(), core: input.affected.core ?? null, viaHooks: input.affected.viaHooks ?? [] }
    : (({ modules, core }) => ({ modules, core }))(affectedModules({ triage: listed, entries: input.paths.map((p) => ({ path: p, status: 'modified' })), collections: m.collections }))
  const filters = filterNames(driveFilters(m, affected))
  const from = input.source === 'recorded-revision' || input.source === 'previous-revision'
    ? `the most recent recorded change set, run ${input.fromRun}${input.revision ? ` revision ${input.revision}` : ''}`
    : `the paths the plan of run ${input.fromRun} names`
  if (!filters.length) {
    return { state: 'nothing', filters, ...where,
      detail: `modules tier will test nothing for these paths (${from}): no module and no core directory gives a selftest filter, so no selftest report will be read and the gate will be inconclusive. This describes that change set, not what the next author will change.${note}` }
  }
  return { state: 'tests', filters: filters.slice(0, MAX_FILTERS_SHOWN), ...(filters.length > MAX_FILTERS_SHOWN ? { more: filters.length - MAX_FILTERS_SHOWN } : {}), ...where,
    detail: `Modules tier selftests for ${from}: ${shown(filters)}.` }
}
