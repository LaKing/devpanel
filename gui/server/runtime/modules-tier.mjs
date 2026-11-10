import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import { isSelftestReport, readReport, selftestReport, selftestStates } from './baseline-failures.mjs'
import { shellQuote } from './ssh.mjs'
import { withInstance } from './instance-drive.mjs'

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
 * Whether a failed command ended by its own exit: no timeout, no signal, no
 * report that the drive cannot be made, and an exit status a program chooses
 * (1–123). 124 is the remote timeout, 125–127 a command that could not be
 * launched, 128+n a shell's word for a signal, 255 ssh's own. Only a chosen
 * exit is a test's answer; anything else leaves the instance's state in doubt.
 */
export const exitedOnItsOwn = (c) => !c.timedOut && !c.signal && !c.unavailable && Number.isInteger(c.exitCode) && c.exitCode >= 1 && c.exitCode < 124

/** Whether a test or browser template takes every filter in one command (`{{filters}}`) instead of one per command. */
export const takesAllFilters = (command) => typeof command?.run === 'string' && command.run.includes('{{filters}}')

/**
 * One drive of the tier for a revision: lint (left out with no files), load,
 * restart, ready, a test per affected module then per core directory (the root
 * gets `rootFilter`, default '.'), a browser run per affected module when the
 * project declares one, then the finalizers. A template holding `{{filters}}`
 * gets ONE command with every filter as an argument of its own (`<id>-1`).
 * Each file and filter is shell-quoted into its template's own word, so whatever
 * bytes a path holds it arrives as one argument and runs nothing; no filter is
 * ever refused.
 *
 * Test and browser commands carry `ownFailureContinues`: the instance is up by
 * then, so one that exits non-zero on its own does not keep the others from
 * running (checks.mjs runCommandSet) and the author hears of every failing
 * module in one round. `failedFirst` (filters that failed in the run's previous
 * drive, failedFilters) moves those to the front, order otherwise kept.
 *
 * A tier that declares `instance` (instance-drive.mjs) is bound to `instanceName`,
 * the caller's instance for this tree: its commands name that instance, and the
 * check runner creates it on the first drive in place of load and restart.
 */
export function modulesDrive (target, { affected, files = [], failedFirst = [], instanceName = null }) {
  const m = target.modules
  const fill = (command, placeholder, values) => ({ ...command, run: command.run.replace(`{{${placeholder}}}`, () => values.map(shellQuote).join(' ')) })
  const commands = []
  if (files.length) commands.push(fill(m.lint, 'files', files))
  commands.push(m.load, m.restart, m.ready)
  // Hook subscribers in this tree (affectedModules.viaHooks, module-hooks.mjs) are tested here too, once each.
  const modules = [...new Set([...(affected?.modules ?? []), ...(affected?.viaHooks ?? []).filter((v) => v.inTree).map((v) => v.module)])].sort()
  const declared = [
    ...modules.map((module) => ({ module, filter: module })),
    ...(affected?.core?.dirs ?? []).map((dir) => ({ core: dir, filter: dir === '.' ? (m.rootFilter ?? '.') : dir }))
  ]
  const first = new Set(failedFirst ?? [])
  const filters = [...declared.filter((f) => first.has(f.filter)), ...declared.filter((f) => !first.has(f.filter))]
  const tests = []
  const expand = (slot, template, list) => {
    if (!list.length) return
    if (takesAllFilters(template)) {
      const id = `${template.id}-1`
      // One command for N filters: its bound is the declared one plus the declared share of each filter.
      const { timeoutSecondsPerFilter: each, ...one } = template
      const bound = each ? { timeoutSeconds: (one.timeoutSeconds ?? 900) + each * list.length } : {}
      commands.push({ ...fill({ ...one, id }, 'filters', list.map((f) => f.filter)), ...bound, ownFailureContinues: true })
      tests.push({ id, slot, filters: list.map((f) => f.filter), modules: list.filter((f) => f.module).map((f) => f.module), core: list.filter((f) => f.core).map((f) => f.core) })
      return
    }
    list.forEach((f, i) => {
      const id = `${template.id}-${i + 1}`
      commands.push({ ...fill({ ...template, id }, 'filter', [f.filter]), ownFailureContinues: true })
      tests.push({ id, slot, ...f })
    })
  }
  expand('test', m.test, filters)
  if (m.browser) expand('browser', m.browser, filters.filter((f) => f.module))
  const ran = filters.filter((f) => first.has(f.filter)).map((f) => f.filter)
  const { tiers, compareBaseline, baselineCache, ...rest } = target
  const driven = { ...rest, tier: 'modules', commands, ...(m.finallyCommands ? { finallyCommands: m.finallyCommands } : {}) }
  return {
    target: m.instance ? withInstance(driven, m, instanceName) : driven,
    plan: {
      lint: files.length ? { files } : { files: [], skipped: 'no-changed-files' },
      tests,
      ...(ran.length ? { failedFirst: ran } : {}),
      unusualFilters: [...new Set(filters.map((f) => f.filter).filter(unusual))]
    }
  }
}

/**
 * The filters whose test or browser command failed in a modules drive: what the
 * run's next drive runs first (kept on the check history, which outlives the
 * revision). A command that took several filters names all of them, since its
 * exit does not say which failed.
 */
export function failedFilters (check) {
  const failed = new Set((check?.commands ?? []).filter((c) => !c.passed).map((c) => c.id))
  return [...new Set((check?.modules?.tests ?? []).filter((t) => failed.has(t.id)).flatMap((t) => t.filters ?? [t.filter]))]
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

/**
 * Whether a failed modules drive failed in its tests alone: every failed required
 * command is one of the drive's test or browser commands (modulesDrive's
 * `<id>-<n>`) and exited on its own. The same bytes on the same instance answer
 * the same, so the engine returns to the author without a second drive, which
 * would only cost the host another drive. A failed lint, load, restart or ready
 * (or the creation and start of a stage instance),
 * a timeout, a signal, a launch failure or ssh's own exit 255 (exitedOnItsOwn)
 * is not the tests' answer and keeps the retry (`retryFailed`).
 */
export function failedInTests (target, check) {
  const prefixes = [target?.modules?.test?.id, target?.modules?.browser?.id].filter(Boolean)
  const isTest = (id) => prefixes.some((p) => typeof id === 'string' && id.startsWith(`${p}-`) && /^\d+$/.test(id.slice(p.length + 1)))
  const failed = (check?.commands ?? []).filter((c) => c.required !== false && !c.passed)
  return check?.result === 'failed' && failed.length > 0 && failed.every((c) => isTest(c.id) && exitedOnItsOwn(c))
}

/** Check records that count for closure: the full drive, or the modules tier where it is the target. */
export const countsForClosure = (c) => ['full', 'modules'].includes(c?.tier ?? 'full')

/** Whether a check target is the modules tier (declared or not). */
export const isModulesTarget = (target) => target?.tier === 'modules' || Boolean(target?.modules)

/** A report's failed tests, each with the module the tester states beside it, if any. */
function failedOf (command, report) {
  const { state, modules } = selftestStates(report)
  return [...state].filter(([, s]) => s === 'FAIL').map(([test]) => ({ command, test, ...(modules.has(test) ? { module: modules.get(test) } : {}) }))
}

/**
 * The failed tests a modules drive's selftest reports name, and the reports that
 * could not be read: either blocks the revision (no base to inherit from). The
 * report of a test command that itself failed is read for its names too.
 */
export async function modulesSelftestFailures ({ runDir, target, check }) {
  const failures = []
  const unreadable = []
  const declared = [...(target.commands ?? []), ...(target.finallyCommands ?? [])].filter((c) => isSelftestReport(c.report))
  let read = 0
  for (const { id } of declared) {
    const got = await readReport(runDir, check, id)
    if (got.notRun) continue
    if (got.failed) {
      // A test that exited non-zero on its own still printed its report: the names tell the author
      // which tests failed (and, for a command of several filters, in which module). Best effort:
      // the command's failure already gates, so a report that cannot be read here adds nothing.
      const record = check.commands.find((c) => c.id === id)
      if (!exitedOnItsOwn(record)) continue
      const stdout = await fs.readFile(path.join(runDir, check.dir ?? '', `${id}.stdout`), 'utf8').catch(() => null)
      const report = stdout === null ? null : selftestReport(stdout).report
      if (report) failures.push(...failedOf(id, report))
      continue
    }
    if (!got.report) { unreadable.push({ command: id, error: got.error }); continue }
    read++
    failures.push(...failedOf(id, got.report))
  }
  // A passing drive must have shown a report: one that ran none, or only failed or skipped
  // collectors, proved no test (the declaration requires a collector, modulesErrors).
  if (!read && !unreadable.length && check?.result === 'passed') unreadable.push({ command: declared.map((c) => c.id).join(', ') || null, error: 'no selftest report was read' })
  return { failures, unreadable }
}
