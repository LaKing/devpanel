import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'

import { ProcessError } from '../gui/server/runtime/process.mjs'
import { appendDurable, syncDir } from '../gui/server/runtime/persistence.mjs'

/*
 * The operator's configuration in a shared CLI home (harness/README.md "Seat
 * hygiene", "Operator configuration in the shared CLI homes").
 *
 * The home stays writable for the login and the sessions. What the operator's
 * own CLI reads as configuration is handled in two ways:
 *
 *   - entries whose empty form is harmless (directories, empty TOML and
 *     Markdown) are created when missing and bound read-only over themselves
 *     by the fence (prepare, called by fence.mjs applyFence only after the
 *     unchanged fence was proved);
 *   - files an empty placeholder would break (JSON settings, hooks, .env) are
 *     snapshotted before the turn and compared after it, whatever the turn's
 *     ending (runGuarded). One that appeared or changed is moved aside into
 *     `<name>.devpanel-quarantine-<label>-<ts>` and the turn fails. Nothing is
 *     deleted.
 *
 * Every line the guard writes goes to the adapter's own ledger, durably, so a
 * crash at any point leaves what recovery needs (recoverPending): the pre-turn
 * snapshot before launch, each move's intent before the move, the verdict
 * before the caller can acknowledge it (resolveConfig).
 */

/** Test seams, no-ops by default: force an interleaving or a crash point. */
export const hooks = { afterPublish: null, beforeFinalize: null, beforeCheckedWrite: null, beforeMove: null, stamp: null }
const hook = async (name, ...args) => { if (hooks[name]) await hooks[name](...args) }

const NL = '\n'
const lstat = (p) => fs.lstat(p).then((st) => st, (error) => { if (error.code === 'ENOENT') return null; throw error })
const kind = (st) => !st ? 'absent' : st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'

/** A label usable in a file name: the run id, else the invocation id. */
export function guardLabel (meta = {}, fallback = 'turn') {
  return String(meta.runId ?? meta.invocationId ?? fallback).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)
}

class ConfigRefusal extends Error {}

/**
 * The guard for one home. `bindRoot` is what the fence binds writable (the
 * CLI home); `base` the directory holding the configuration (the same, or
 * `.gemini` inside it, created plain and left writable when `ensureBase`).
 */
export function configGuard ({ bindRoot, base = bindRoot, ensureBase = false, dirs = [], emptyFiles = [], checkedFiles = [] }) {
  return { plan: { bindRoot, base, ensureBase, dirs, emptyFiles, checkedFiles }, prepare: () => prepareConfig({ bindRoot, base, ensureBase, dirs, emptyFiles, checkedFiles }) }
}

/**
 * Make every required entry exist with the right type. Validates everything
 * before creating anything: a symlink or a wrong type at any listed name
 * (checked files included) refuses the turn and leaves the home as it was.
 */
export async function prepareConfig ({ bindRoot, base = bindRoot, ensureBase = false, dirs = [], emptyFiles = [], checkedFiles = [] }) {
  // An absent home is not bound into the fence: nothing a seat writes there
  // reaches the operator's home, so nothing is created in it either.
  const refuse = (p, found, wanted) => { throw new ConfigRefusal(`configuration entry ${p} is ${found === 'absent' ? 'missing' : `a ${found}`}; a fenced seat turn needs a plain ${wanted} there, bound read-only (replace it with a plain ${wanted})`) }
  const root = await lstat(bindRoot)
  if (!root) return { skipped: 'home-absent', home: base, bindRoot }
  // A home the fence would still bind (it resolves a symlink and binds the
  // target writable) but that is not a plain directory is refused, never skipped.
  if (!root.isDirectory()) refuse(bindRoot, kind(root), 'directory')
  const at = (name) => path.join(base, name)
  const baseStat = await lstat(base)
  if (baseStat && !baseStat.isDirectory()) refuse(base, kind(baseStat), 'directory')
  if (!baseStat && !ensureBase) return { skipped: 'home-absent', home: base, bindRoot }
  const want = [...dirs.map((n) => [at(n), 'dir']), ...emptyFiles.map((n) => [at(n), 'file']), ...checkedFiles.map((n) => [at(n), 'file'])]
  if (baseStat) {
    for (const [p, type] of want) {
      const st = await lstat(p)
      if (st && kind(st) !== type) refuse(p, kind(st), type === 'dir' ? 'directory' : 'file')
    }
  }
  const created = []
  if (!baseStat) { await fs.mkdir(base, { mode: 0o700 }).catch((e) => { if (e.code !== 'EEXIST') throw e }); created.push(base) }
  const settle = async (p, type, make) => {
    if (await lstat(p)) return
    try { await make(); created.push(p) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const st = await lstat(p)
    if (kind(st) !== type) refuse(p, kind(st), type === 'dir' ? 'directory' : 'file')
  }
  for (const name of dirs) await settle(at(name), 'dir', () => fs.mkdir(at(name), { mode: 0o700 }))
  for (const name of emptyFiles) await settle(at(name), 'file', async () => { const h = await fs.open(at(name), 'wx', 0o600); await h.close() })
  const entries = []
  for (const name of emptyFiles) entries.push(at(name))
  for (const name of checkedFiles) if (kind(await lstat(at(name))) === 'file') entries.push(at(name))
  return { home: base, bindRoot, readOnly: dirs.map(at), entries, watch: checkedFiles.map(at), created }
}

/**
 * Whether the final fence arguments hold every required bind: the home bound
 * writable, then each prepared entry bound read-only over itself after it.
 * Returns the first path that is not, or null.
 */
export async function missingBind (args, prepared) {
  const triple = (flag, p) => { for (let i = 0; i + 2 < args.length; i++) if (args[i] === flag && args[i + 1] === p && args[i + 2] === p) return i; return -1 }
  const home = triple('--bind', await fs.realpath(prepared.bindRoot).catch(() => null))
  if (home < 0) return prepared.bindRoot
  for (const [p, type] of [...prepared.readOnly.map((p) => [p, 'dir']), ...prepared.entries.map((p) => [p, 'file'])]) {
    if (kind(await lstat(p)) !== type) return p
    const at = triple('--ro-bind', await fs.realpath(p).catch(() => null))
    if (at < 0 || at < home) return p
  }
  return null
}

// --- the snapshot -------------------------------------------------------------

async function hashFile (p) {
  const handle = await fs.open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    const hash = crypto.createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    return hash.digest('hex')
  } finally { await handle.close() }
}

async function describe (p) {
  let st
  try { st = await lstat(p) } catch (error) { return { exists: true, unreadable: error.code ?? error.message } }
  if (!st) return { exists: false }
  const type = kind(st)
  const out = { exists: true, type, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino }
  try {
    if (type === 'file') out.sha256 = await hashFile(p)
    if (type === 'symlink') out.target = await fs.readlink(p)
  } catch (error) {
    // Its content cannot be verified; it can still be moved by rename.
    out.unreadable = error.code ?? error.message
  }
  return out
}

/** exists, type, size, mtime and sha256 of each watched path. */
export async function snapshotConfig (watch) {
  const out = {}
  for (const p of watch) out[p] = await describe(p)
  return out
}

const comparable = (d) => d ? JSON.stringify([d.exists, d.type ?? null, d.size ?? null, d.mtimeMs ?? null, d.sha256 ?? null, d.target ?? null, d.unreadable ?? null]) : 'null'
const same = (a, b) => comparable(a) === comparable(b)
const changeOf = (before, after) => after.unreadable ? 'unverifiable' : !after.exists ? 'removed' : !before?.exists ? 'created' : 'modified'
const identityOf = (d) => ({ dev: d.dev, ino: d.ino, type: d.type, size: d.size, sha256: d.sha256 ?? null })
const identityMatches = (want, got) => got.exists && got.dev === want.dev && got.ino === want.ino && got.type === want.type && (want.type !== 'file' || want.sha256 === null || got.sha256 === want.sha256)

// --- the move -----------------------------------------------------------------

/** Both directory syncs, claim first, before a move counts as done. */
async function syncMove (claim, srcDir, target) {
  try {
    await syncDir(claim)
    await syncDir(srcDir)
    return { status: 'quarantined', quarantinedTo: target }
  } catch (error) {
    return { status: 'quarantine-unsynced', quarantinedTo: target, error: error.code ?? error.message }
  }
}

/**
 * Move `src` aside. The outer name is claimed with an exclusive mkdir, so no
 * existing path is ever claimed or replaced; the move goes to a random inner
 * name inside it (Node has no no-replace rename: the residual is a same-uid
 * process guessing that name within microseconds). The intent, naming the
 * claim actually made, is durable before the rename.
 */
async function quarantine (src, label, { identity, intent }) {
  const dir = path.dirname(src)
  const name = path.basename(src)
  const stamp = hooks.stamp?.() ?? new Date().toISOString().replace(/[:.]/g, '-')
  let claim = null
  for (let n = 1; n <= 20 && !claim; n++) {
    const candidate = path.join(dir, `${name}.devpanel-quarantine-${label}-${stamp}${n > 1 ? `-${n}` : ''}`)
    try { await fs.mkdir(candidate, { mode: 0o700 }); claim = candidate } catch (error) {
      if (error.code !== 'EEXIST') return { status: 'quarantine-failed', error: error.code ?? error.message }
    }
  }
  if (!claim) return { status: 'quarantine-failed', error: 'no free quarantine name' }
  const inner = `${name}.${crypto.randomBytes(16).toString('hex')}`
  const target = path.join(claim, inner)
  await intent({ path: src, claim, inner, identity })
  await hook('beforeMove', { src, claim, target })
  try { await fs.rename(src, target) } catch (error) {
    return { status: 'quarantine-failed', claim, error: error.code ?? error.message }
  }
  return syncMove(claim, dir, target)
}

// --- the turn -----------------------------------------------------------------

/** Guarded turns per real home, for the overlap rule. */
const active = new Map()
const activeIds = new Set()

const ledgerLine = (entry) => JSON.stringify({ ...entry, at: new Date().toISOString() }) + NL

/**
 * Append one durable ledger line. A torn final line (an append cut short by a
 * crash) is closed first, so the new line can never be swallowed by it.
 */
async function appendLine (ledgerFile, entry) {
  let lead = ''
  try {
    const handle = await fs.open(ledgerFile, 'r')
    try {
      const { size } = await handle.stat()
      if (size > 0) {
        const { buffer } = await handle.read({ buffer: Buffer.alloc(1), position: size - 1 })
        if (buffer[0] !== 0x0a) lead = NL
      }
    } finally { await handle.close() }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await appendDurable(ledgerFile, lead + ledgerLine(entry))
}

async function readLedger (ledgerFile) {
  let text
  try { text = await fs.readFile(ledgerFile, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const out = []
  for (const line of text.split(NL)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* torn final line */ }
  }
  return out
}

/**
 * Tell every other guarded turn on this home about changes about to be moved:
 * in memory at once (synchronously, so a creating turn that later finds the
 * file gone still fails), then durably in each turn's own ledger, before
 * anything moves.
 */
async function publish (home, diffs, foundBy, self = null) {
  const others = diffs.length ? [...(active.get(home) ?? [])].filter((t) => t !== self) : []
  for (const t of others) t.inherited.push(...diffs.map((d) => ({ path: d.path, change: d.change, inherited: true, foundBy })))
  await hook('afterPublish', { invocationId: foundBy, diffs })
  for (const t of others) {
    if (t.ledgerFile) await appendLine(t.ledgerFile, ({ invocationId: t.invocationId, phase: 'config-inherited', foundBy, violations: diffs.map((d) => ({ path: d.path, change: d.change })) }))
  }
}

/** Quarantine every changed path that still exists; record the rest. */
async function settleDiffs (diffs, { label, ledgerFile, invocationId }) {
  const out = []
  for (const d of diffs) {
    const v = { path: d.path, change: d.change, before: d.before, after: d.after }
    if (d.after?.exists) {
      Object.assign(v, await quarantine(d.path, label, {
        identity: identityOf(d.after),
        intent: (i) => appendLine(ledgerFile, ({ invocationId, phase: 'quarantine-intent', change: d.change, before: d.before, after: d.after, ...i }))
      }))
    }
    out.push(v)
  }
  return out
}

/**
 * Snapshot, launch, check: the post-turn check runs whatever the turn's ending
 * (exit, failure, cancellation, a thrown spawn error). Returns
 * `{ run, thrown, integrity }`; integrity is null for an unguarded turn.
 */
export async function runGuarded ({ config, label, ledgerFile, invocationId, context = null }, launch) {
  if (!config || config.skipped) {
    try { return { run: await launch(), thrown: null, integrity: null } } catch (error) { return { run: null, thrown: error, integrity: null } }
  }
  const before = await snapshotConfig(config.watch)
  const unreadable = Object.entries(before).filter(([, d]) => d.unreadable)
  if (unreadable.length) {
    throw new ProcessError(`the operator's configuration cannot be verified before the turn (${unreadable.map(([p, d]) => `${p}: ${d.unreadable}`).join('; ')}); the turn was not started`, { kind: 'environment-error', started: false, invocationId })
  }
  try {
    if (!ledgerFile) throw new Error('no ledger location for this turn')
    await appendLine(ledgerFile, ({ invocationId, phase: 'guarded', home: config.home, label, watch: config.watch, before, ...(context ? { context } : {}) }))
    // Read back: recovery can only use a baseline it can parse.
    if (!(await readLedger(ledgerFile)).some((e) => e.invocationId === invocationId && e.phase === 'guarded')) throw new Error('the written baseline cannot be read back')
  } catch (error) {
    throw new ProcessError(`the pre-turn configuration snapshot could not be persisted (${error.message}); the turn was not started`, { kind: 'environment-error', started: false, invocationId })
  }
  const home = await fs.realpath(config.home).catch(() => config.home)
  const turn = { invocationId, label, ledgerFile, inherited: [] }
  if (!active.has(home)) active.set(home, new Set())
  active.get(home).add(turn)
  activeIds.add(invocationId)
  let run = null
  let thrown = null
  try {
    try { run = await launch() } catch (error) { thrown = error }
    try {
      return { run, thrown, integrity: await checkTurn(turn, { home, config, before, label, ledgerFile, invocationId }) }
    } catch (guardError) {
      // The runtime ran: its result stays, and an incomplete check is itself a
      // violation (no verdict line, so recovery replays what was recorded).
      const known = turn.found ?? []
      const violations = known.length ? known.map((d) => ({ path: d.path, change: d.change, status: 'check-failed', error: guardError.message }))
        : [{ path: config.home, change: 'unverifiable', status: 'check-failed', error: guardError.message }]
      return { run, thrown, guardError, integrity: { kind: 'cli-config', home: config.home, label, invocationId, violations: [...violations, ...turn.inherited], incomplete: true } }
    }
  } finally {
    active.get(home)?.delete(turn)
    activeIds.delete(invocationId)
  }
}

async function checkTurn (turn, { home, config, before, label, ledgerFile, invocationId }) {
  const after = await snapshotConfig(config.watch)
  // Synchronous: compute and publish to every overlapping turn on this home
  // before anything moves, so a turn that created the file and now finds it
  // gone still fails.
  const diffs = config.watch.filter((p) => !same(before[p], after[p])).map((p) => ({ path: p, change: changeOf(before[p], after[p]), before: before[p], after: after[p] }))
  turn.found = diffs
  await publish(home, diffs, invocationId, turn)
  const own = await settleDiffs(diffs, { label, ledgerFile, invocationId })
  await hook('beforeFinalize', { invocationId })
  // Synchronous: the verdict and the deregistration in one step.
  const violations = [...own, ...turn.inherited]
  active.get(home)?.delete(turn)
  activeIds.delete(invocationId)
  const integrity = { kind: 'cli-config', home: config.home, label, invocationId, violations }
  await hook('beforeCheckedWrite', { invocationId })
  // A move whose directory syncs failed is not done: no completion line, so
  // recovery replays its intent.
  if (!violations.some((v) => v.status === 'quarantine-unsynced')) {
    await appendLine(ledgerFile, ({ invocationId, phase: 'config-checked', integrity, resolved: violations.length === 0 }))
  }
  return integrity
}

// --- recovery -----------------------------------------------------------------

/**
 * Replay the intents recorded for one path, oldest first. Every move whose
 * destination still holds the recorded object must have both its directory
 * syncs succeed (an older unsynced move stays replayable even when a newer
 * intent exists); an older intent whose move never happened was superseded.
 * `current` is the one read of the original path that also decided what was
 * published, and so decides whether anything newer there is moved now.
 */
async function replayPath (intents, before, current, label, ledgerFile, invocationId) {
  const out = []
  let latestMismatch = null
  for (const [i, intent] of intents.entries()) {
    const target = path.join(intent.claim, intent.inner)
    const found = await describe(target)
    const base = { path: intent.path, change: intent.change }
    const isLatest = i === intents.length - 1
    if (found.exists && identityMatches(intent.identity, found)) out.push({ ...base, ...await syncMove(intent.claim, path.dirname(intent.path), target) })
    else if (found.exists) { if (isLatest) latestMismatch = target; else out.push({ ...base, status: 'quarantine-unverified', claim: intent.claim }) }
    else if (isLatest && !(current.exists && !same(before, current))) out.push({ ...base, status: 'quarantine-failed', claim: intent.claim, error: 'neither the claimed destination nor the original path holds it' })
  }
  const latest = intents.at(-1)
  if (current.exists && !same(before, current)) {
    const moved = await quarantine(latest.path, label, {
      identity: identityOf(current),
      intent: (i) => appendLine(ledgerFile, ({ invocationId, phase: 'quarantine-intent', change: latest.change, before, after: current, ...i }))
    })
    out.push({ path: latest.path, change: current.unreadable ? 'unverifiable' : out.length ? 'modified' : latest.change, ...moved, ...(latestMismatch ? { earlierClaim: { path: latestMismatch, status: 'quarantine-unverified' } } : {}) })
  } else if (latestMismatch) out.push({ path: latest.path, change: latest.change, status: 'quarantine-unverified', claim: latest.claim })
  return out
}

async function recoverOne (lines, { ledgerFile, invocationId }) {
  const tied = lines.filter((e) => e.invocationId === invocationId)
  const g = tied.findLastIndex((e) => e.phase === 'guarded')
  if (g < 0) return null
  const after = tied.slice(g + 1)
  if (after.some((e) => e.phase === 'config-resolved')) return null
  const guarded = tied[g]
  const context = guarded.context ?? null
  if (activeIds.has(invocationId)) return { invocationId, context, active: true }
  const checked = after.findLast((e) => e.phase === 'config-checked')
  if (checked) return checked.resolved ? null : { invocationId, context, integrity: checked.integrity, replayed: true }
  const label = guarded.label
  const violations = []
  const intents = new Map()
  for (const intent of after.filter((e) => e.phase === 'quarantine-intent')) intents.set(intent.path, [...(intents.get(intent.path) ?? []), intent])
  // One read of every watched path drives both what is published and what is
  // moved: nothing is moved that overlapping turns were not told about first.
  const now = await snapshotConfig([...new Set([...(guarded.watch ?? []), ...intents.keys()])])
  const diffs = Object.keys(now).filter((p) => !same(guarded.before?.[p], now[p])).map((p) => ({ path: p, change: changeOf(guarded.before?.[p], now[p]), before: guarded.before?.[p], after: now[p] }))
  const home = await fs.realpath(guarded.home).catch(() => guarded.home)
  await publish(home, diffs.filter((d) => d.after.exists), invocationId)
  for (const [p, list] of intents) violations.push(...await replayPath(list, guarded.before?.[p], now[p], label, ledgerFile, invocationId))
  for (const line of after.filter((e) => e.phase === 'config-inherited')) {
    for (const v of line.violations ?? []) violations.push({ ...v, inherited: true, foundBy: line.foundBy })
  }
  violations.push(...await settleDiffs(diffs.filter((d) => !intents.has(d.path)), { label, ledgerFile, invocationId }))
  const integrity = { kind: 'cli-config', home: guarded.home, label, invocationId, violations, recovered: true }
  if (!violations.some((v) => v.status === 'quarantine-unsynced')) {
    await appendLine(ledgerFile, ({ invocationId, phase: 'config-checked', integrity, resolved: violations.length === 0 }))
  }
  return violations.length ? { invocationId, context, integrity } : null
}

/**
 * What an interrupted guarded invocation left: replayed from its ledger lines,
 * checked now where nothing was recorded. With `invocationId`, that invocation
 * only (null when nothing is pending, `{ active: true }` while it still runs);
 * without, every pending invocation in the ledger, as an array.
 */
export async function recoverPending ({ ledgerFile, invocationId = null }) {
  const lines = await readLedger(ledgerFile)
  if (invocationId) return recoverOne(lines, { ledgerFile, invocationId })
  const ids = [...new Set(lines.filter((e) => e.phase === 'guarded').map((e) => e.invocationId))]
  const out = []
  for (const id of ids) {
    const r = await recoverOne(lines, { ledgerFile, invocationId: id })
    if (r && !r.active) out.push(r)
  }
  return out
}

/**
 * The caller has persisted its record of a violation: stop replaying it. Never
 * acknowledges a verdict that was not recorded (a move still unsynced).
 */
export async function resolveConfig ({ ledgerFile, invocationId }) {
  const tied = (await readLedger(ledgerFile)).filter((e) => e.invocationId === invocationId)
  const g = tied.findLastIndex((e) => e.phase === 'guarded')
  if (g < 0) return true
  const after = tied.slice(g + 1)
  if (after.some((e) => e.phase === 'config-resolved')) return true
  if (!after.some((e) => e.phase === 'config-checked')) return false
  await appendLine(ledgerFile, ({ invocationId, phase: 'config-resolved' }))
  return true
}

/** The error a guarded turn fails with, cancelled or not. */
export function configViolation (integrity, { cli, run = null, thrown = null, invocationId = null } = {}) {
  const what = integrity.violations.map((v) => {
    const name = path.basename(v.path)
    const verb = v.change === 'created' ? 'created' : v.change === 'removed' ? 'removed' : v.change === 'unverifiable' ? 'made unreadable' : 'changed'
    const where = v.inherited ? ` (found by the overlapping turn ${v.foundBy})`
      : v.status === 'quarantined' ? `, moved to ${v.quarantinedTo}`
        : v.status ? ` (${v.status}${v.quarantinedTo ? `: ${v.quarantinedTo}` : ''}${v.error ? `: ${v.error}` : ''}; move it aside by hand)` : ''
    return `${verb} ${name}${where}`
  }).join('; ')
  const ending = run?.cancelled ? '; the turn was also cancelled' : run && run.code !== 0 ? `; the runtime also exited ${run.code}` : thrown ? `; the turn also failed: ${thrown.message}` : ''
  return new ProcessError(`integrity violation: during the ${cli} seat turn the operator's configuration in ${integrity.home} was touched: ${what}${ending}. Nothing was deleted. The turn's answer is not used; inspect the quarantined file and restore it if it was yours.`,
    { kind: 'environment-error', integrity, invocationId, ...(thrown ? { cause: thrown } : {}), ...(run?.termination ? { termination: run.termination } : {}) })
}

/** What the guard did for a turn, as the step records it (diagnostics.fence.config). */
export function configDiagnostics (config) {
  if (!config) return null
  return config.skipped ? { skipped: config.skipped, home: config.home } : { home: config.home, created: config.created, readOnly: config.readOnly.length, watched: config.watch }
}
