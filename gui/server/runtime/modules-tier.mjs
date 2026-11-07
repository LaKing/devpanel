import crypto from 'node:crypto'
import path from 'node:path'
import { isSelftestReport, readReport, selftestStates } from './baseline-failures.mjs'
import { shellQuote } from './ssh.mjs'

/*
 * The modules tier (docs/project-infrastructure.md "The modules tier",
 * execution-contract.md "The modules tier"): the per-revision check of coding
 * playbooks on a Boilerplate project. A module is `<collection>/<module>/`
 * (a collection is a declared top-level directory); every other path is core.
 * What a revision affects is read off its fingerprint's entries, and each
 * module's checksum off the same entries (and the base's off the run's
 * baseline), so both stand under the fingerprint's own rule and excludes.
 */

const sha256 = (text) => 'sha256:' + crypto.createHash('sha256').update(text).digest('hex')

/** A matcher for the declared collection names (`*` matches any run of characters). */
export function collectionMatcher (collections = []) {
  const patterns = collections.map((c) => new RegExp('^' + c.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'))
  return (name) => patterns.some((p) => p.test(name))
}

/** The module a path belongs to (`<collection>/<module>`), or null for a core path. */
export function moduleOf (rel, collections) {
  const isCollection = typeof collections === 'function' ? collections : collectionMatcher(collections)
  const parts = rel.split('/')
  return parts.length >= 3 && isCollection(parts[0]) ? `${parts[0]}/${parts[1]}` : null
}

/** A revision's files as checksums read them: every present entry of its fingerprint. */
export const revisionFiles = (entries) => (entries ?? []).filter((e) => e.status !== 'deleted' && e.contentHash).map((e) => ({ path: e.path, mode: e.mode ?? '', contentHash: e.contentHash }))

/** The base's files, from the run's baseline (path -> contentHash, with `.modes`). */
export const baseFiles = (baseline) => [...(baseline ?? new Map())].map(([p, contentHash]) => ({ path: p, mode: baseline.modes?.get(p) ?? '', contentHash }))

/** Each module's sha256 over its files' path, mode and content hash, in path order. */
export function moduleChecksums (files, collections) {
  const isCollection = collectionMatcher(collections)
  const lines = new Map()
  for (const f of files) {
    const module = moduleOf(f.path, isCollection)
    if (!module) continue
    if (!lines.has(module)) lines.set(module, [])
    lines.get(module).push([f.path, f.mode, f.contentHash].join('\0'))
  }
  return Object.fromEntries([...lines].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([module, l]) => [module, sha256(l.sort().join('\n'))]))
}

/** The modules whose checksum differs between two sets, or that only one of them has. */
export function changedModules (before, after) {
  return [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((m) => before?.[m] !== after?.[m]).sort()
}

/**
 * What a revision affects: the triage list ∪ the modules of its changed paths.
 * Changed paths outside every module give core, as their directories (the root
 * as '.'). A changed module the triage did not list is `unlisted`; a listed one
 * the tree does not hold is `notInTree`. Nothing here refuses.
 */
export function affectedModules ({ triage = [], entries = [], collections, checksums = {} }) {
  const isCollection = collectionMatcher(collections)
  const changed = (entries ?? []).filter((e) => e.status && e.status !== 'unchanged')
  const fromPaths = new Set()
  const coreDirs = new Set()
  let corePaths = 0
  for (const e of changed) {
    const module = moduleOf(e.path, isCollection)
    if (module) fromPaths.add(module)
    else { corePaths++; coreDirs.add(path.posix.dirname(e.path)) }
  }
  const listed = [...new Set((triage ?? []).filter((m) => typeof m === 'string' && m.length).map((m) => m.replace(/\/+$/, '')))].sort()
  const paths = [...fromPaths].sort()
  return {
    triage: listed,
    fromPaths: paths,
    modules: [...new Set([...listed, ...paths])].sort(),
    unlisted: paths.filter((m) => !listed.includes(m)),
    notInTree: listed.filter((m) => !(m in checksums)),
    core: corePaths ? { paths: corePaths, dirs: [...coreDirs].sort() } : null
  }
}

/** The revision's changed .mjs/.vue files that still exist: what the lint command gets. */
export const lintFiles = (entries) => (entries ?? []).filter((e) => ['added', 'modified'].includes(e.status) && /\.(mjs|vue)$/.test(e.path)).map((e) => e.path).sort()

/** A filter a program might still misread although it arrives as one argument. */
const unusual = (filter) => filter.startsWith('-') || /[\u0000-\u001f\u007f-\u009f]/.test(filter) || filter.length > 200

/**
 * One drive of the tier for a revision: lint (left out with no files), load,
 * restart, ready, a test per affected module then per core directory (the root
 * gets `rootFilter`, default '.'), a browser run per affected module when the
 * project declares one, then the finalizers. Each file and filter is
 * shell-quoted into its template's own word, so whatever bytes a path holds it
 * arrives as one argument and runs nothing; no filter is ever refused.
 */
export function modulesDrive (target, { affected, files = [] }) {
  const m = target.modules
  const fill = (command, placeholder, values) => ({ ...command, run: command.run.replace(`{{${placeholder}}}`, () => values.map(shellQuote).join(' ')) })
  const commands = []
  if (files.length) commands.push(fill(m.lint, 'files', files))
  commands.push(m.load, m.restart, m.ready)
  // Hook subscribers in this tree (affectedModules.viaHooks, module-hooks.mjs) are tested here too, once each.
  const modules = [...new Set([...(affected?.modules ?? []), ...(affected?.viaHooks ?? []).filter((v) => v.inTree).map((v) => v.module)])].sort()
  const filters = [
    ...modules.map((module) => ({ module, filter: module })),
    ...(affected?.core?.dirs ?? []).map((dir) => ({ core: dir, filter: dir === '.' ? (m.rootFilter ?? '.') : dir }))
  ]
  const tests = []
  filters.forEach((f, i) => {
    const id = `${m.test.id}-${i + 1}`
    commands.push(fill({ ...m.test, id }, 'filter', [f.filter]))
    tests.push({ id, slot: 'test', ...f })
  })
  if (m.browser) {
    filters.filter((f) => f.module).forEach((f, i) => {
      const id = `${m.browser.id}-${i + 1}`
      commands.push(fill({ ...m.browser, id }, 'filter', [f.filter]))
      tests.push({ id, slot: 'browser', ...f })
    })
  }
  const { tiers, compareBaseline, baselineCache, ...rest } = target
  return {
    target: { ...rest, tier: 'modules', commands, ...(m.finallyCommands ? { finallyCommands: m.finallyCommands } : {}) },
    plan: {
      lint: files.length ? { files } : { files: [], skipped: 'no-changed-files' },
      tests,
      unusualFilters: [...new Set(filters.map((f) => f.filter).filter(unusual))]
    }
  }
}

/** What an auditor is told of the revision under review: unlisted modules are told, never refused. */
export function affectedModulesNotice (revision) {
  const a = revision.affectedModules
  const list = (xs) => xs?.length ? xs.map((x) => JSON.stringify(x)).join(', ') : 'none'
  const lines = [`Modules tier, revision ${revision.fingerprint}: changed modules (checksum differs from the base) ${list(revision.modules?.changed)}; affected modules tested (the triage list ∪ the modules of the changed paths) ${list(a.modules)}; core directories ${list(a.core?.dirs)}.`]
  if (a.unlisted?.length) lines.push(`Changed modules the triage did not list: ${list(a.unlisted)} (recorded as affectedModules.unlisted; this refuses nothing — judge whether the change belongs there).`)
  if (revision.hooks?.state === 'read' && revision.hooks.changed?.length) lines.push(`Hook signatures this revision changes: ${list(revision.hooks.changed)}; every subscriber in the module pool is affected and locked (affectedModules.viaHooks): ${(a.viaHooks ?? []).map((v) => `${JSON.stringify(v.module)} (${v.project}; ${v.hooks.join(', ')}; ${v.inTree ? 'tested in this drive' : 'tested in a subscriber drive of its project'})`).join(', ') || 'none'}.`)
  if (revision.hooks?.state === 'unavailable') lines.push(`The pool's hook reader could not read this revision (${revision.hooks.error}): which subscribers a hook change affects is unknown, so the modules check is unavailable.`)
  if (revision.moduleLocks?.yielded?.length) lines.push(`While waiting for module locks this run gave up its locks on ${list(revision.moduleLocks.yielded)} to break a wait cycle and took them again; another run may have changed them meanwhile.`)
  if (a.notInTree?.length) lines.push(`Listed by the triage but not in this revision's tree: ${list(a.notInTree)} (their filters still ran).`)
  return lines.join(' ')
}

/** Check records that count for closure: the full drive, or the modules tier where it is the target. */
export const countsForClosure = (c) => ['full', 'modules'].includes(c?.tier ?? 'full')

/** Whether a check target is the modules tier (declared or not). */
export const isModulesTarget = (target) => target?.tier === 'modules' || Boolean(target?.modules)

/**
 * The failed tests a modules drive's selftest reports name, and the reports that
 * could not be read: either blocks the revision (no base to inherit from).
 */
export async function modulesSelftestFailures ({ runDir, target, check }) {
  const failures = []
  const unreadable = []
  const declared = [...(target.commands ?? []), ...(target.finallyCommands ?? [])].filter((c) => isSelftestReport(c.report))
  let read = 0
  for (const { id } of declared) {
    const got = await readReport(runDir, check, id)
    if (got.notRun || got.failed) continue
    if (!got.report) { unreadable.push({ command: id, error: got.error }); continue }
    read++
    for (const [test, state] of selftestStates(got.report).state) if (state === 'FAIL') failures.push({ command: id, test })
  }
  // A passing drive must have shown a report: one that ran none, or only failed or skipped
  // collectors, proved no test (the declaration requires a collector, modulesErrors).
  if (!read && !unreadable.length && check?.result === 'passed') unreadable.push({ command: declared.map((c) => c.id).join(', ') || null, error: 'no selftest report was read' })
  return { failures, unreadable }
}
