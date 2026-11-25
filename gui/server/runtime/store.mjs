import { legacyJournalDisposition } from './legacy-journal.mjs'
import { writeJson, writeJsonExclusive, appendDurable, readRegularFile } from './persistence.mjs'
import { constants as fsConstants } from 'node:fs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './clock.mjs'
import { WALL_CLOCK_RULE } from './wall-clock.mjs'

/*
 * Durable run state, under <issue>/runs/<run-id>/.
 *
 *   run.json                 status, participants, sessions, step map, approvals
 *   resolved-playbook.json   the snapshot this run executes — prompt BYTES, not paths
 *   outputs/NNN.json         structured agent output, kept out of the step folder
 *   artifacts/               patches and delivery artifacts
 *   events.jsonl             append-only transitions
 *
 * State is written before any event is emitted, so a reconnecting client
 * reconstructs progress from storage and never from the stream.
 */

const NL = String.fromCharCode(10)

export const runsDir = (issuePath) => path.join(issuePath, 'runs')
/*
 * A run id is a single path segment of letters, digits, '-' and '_'. Checked
 * here, where every run path is built, because the id arrives from URLs:
 * Express decodes %2F, and path.join would follow '..' out of the runs folder.
 */
const RUN_ID = /^[A-Za-z0-9_-]+$/
export const runDir = (issuePath, runId) => {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw Object.assign(new Error('Invalid run id'), { status: 400 })
  return path.join(runsDir(issuePath), runId)
}

// Every record the store reads (run.json, the snapshot, outputs, baselines) through a non-blocking regular-file read.
const readJson = async (file) => JSON.parse(await readRegularFile(file, 'utf8'))

/**
 * Freeze the configuration a run executes, embedding the actual prompt bytes.
 * Paths and hashes are not enough to render from: a hash cannot be un-hashed, and
 * a template can be edited or deleted mid-run. The hashes stay, to prove the
 * snapshot matches what was on disk when the run started.
 */
export async function buildSnapshot (resolved) {
  const prompts = {}
  for (const [name, ref] of Object.entries(resolved.prompts)) {
    prompts[name] = {
      file: ref.file,
      hash: ref.hash,
      body: await fs.readFile(ref.file, 'utf8')
    }
  }
  // Role instructions are embedded for the same reason prompts are: a path is not
  // something a run can render from three hours later.
  const participants = structuredClone(resolved.participants)
  for (const p of Object.values(participants)) {
    if (p.instructions) {
      try { p.instructionsBody = await fs.readFile(p.instructions, 'utf8') } catch { p.instructionsBody = null }
    } else {
      p.instructionsBody = null
    }
  }

  // The output contracts are embedded too. A turn is told the DEFINITION of the
  // shape it must return, and that text must come from the same frozen bytes
  // the validator judges it against, not from whatever the schema file says
  // later.
  let contracts = resolved.contracts ? { ...resolved.contracts, defs: null } : null
  if (resolved.contracts?.file) {
    try {
      contracts.defs = JSON.parse(await fs.readFile(resolved.contracts.file, 'utf8')).$defs ?? null
    } catch { contracts.defs = null }
  }

  return { ...structuredClone(resolved), participants, prompts, contracts, snapshotOf: resolved.configHash }
}

export async function initRun (issuePath, { runId, issue, resolved, clock = systemClock, supervisorLaunchId = null }) {
  const dir = runDir(issuePath, runId)
  await fs.mkdir(path.join(dir, 'outputs'), { recursive: true })
  await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true })

  await writeJson(path.join(dir, 'resolved-playbook.json'), await buildSnapshot(resolved))

  const participants = {}
  for (const [role, p] of Object.entries(resolved.participants)) {
    participants[role] = {
      role,
      model: p.model.id,
      harness: p.model.harness,
      profile: p.model.profile,
      effort: p.effort,
      sessionAssignment: null,
      session: null,
      state: 'uninitialised',
      pendingInvocation: null,
      turns: 0
    }
  }

  const run = {
    runId,
    ...(supervisorLaunchId ? { supervisorLaunchId } : {}),
    issue,
    playbook: {
      id: resolved.playbook.id,
      version: resolved.playbook.version,
      strategy: resolved.strategy.id,
      strategyVersion: resolved.strategy.version,
      intent: resolved.intent?.id ?? null,
      // The EXACT configuration this run was cut from, not just its name and a
      // version number a person has to remember to raise. Editing a playbook's
      // YAML changes this and nothing else about it, so later statistics group
      // the edited configuration apart instead of silently rewriting what the
      // older runs were runs OF.
      configHash: resolved.configHash ?? null
    },
    status: 'pending',
    outcome: null,
    blockedReason: null,
    startedAt: clock.iso(),
    endedAt: null,
    workspace: { isolation: null, path: null, baseCommit: null, state: 'pending' },
    participants,
    phase: { id: null, round: 0, stepId: null },
    steps: [],
    revisions: [],
    approvals: [],
    checkResults: [],
    outstandingFindings: [],
    budgets: { limits: resolved.budgets, used: { steps: 0 } },
    failures: [],
    failure: null,
    pause: null,
    // Time actually spent waiting on agents, kept apart from wall clock: a run
    // that took an hour of which four minutes were agents is a different problem
    // from one that was busy the whole time.
    timing: { agentMs: 0, abandonedMs: 0, unknownSteps: 0 },
    // Turns that ran and never answered: their time counts against the wall
    // clock (wall-clock.mjs). A record without these two predates the rule.
    interruptedTurns: [],
    wallClockRule: WALL_CLOCK_RULE,
    delivery: null,
    closure: null,
    recovery: { required: false, reason: null, detectedAt: null }
  }

  await appendDurable(path.join(dir, 'events.jsonl'), '', { flag: 'wx' })
  await writeJson(path.join(dir, 'run.json'), run)
  return run
}

/** A pause's id: its own, or for one recorded before pauses had ids, the same derived one every reader uses. */
export const pauseIdOf = (runId, pause) => pause?.id ?? (pause ? 'legacy-' + crypto.createHash('sha256').update(JSON.stringify([runId, pause])).digest('hex') : null)

export async function readRun (issuePath, runId) {
  const run = await readJson(path.join(runDir(issuePath, runId), 'run.json'))
  if (run.pause && !run.pause.id) run.pause.id = pauseIdOf(runId, run.pause)
  const { events, ...journal } = await inspectRunJournal(issuePath, runId)
  return journalOverlay(run, journal)
}

/**
 * What a journal reading adds to a run record, the same for the run detail (readRun, which inspects and may
 * publish a finding) and the list summary (readJournalFinding, which only reads): a damaged journal is a
 * recovery, dated by the run's own recovery or else by the finding's first detection, so both readings name
 * the same occurrence (notifications link to it).
 */
export function journalOverlay (run, journal) {
  run.journal = journal
  if (journal.recoveryRequired && !run.abandonment) {
    run.recovery = { ...run.recovery, required: true, reason: journal.message,
      detectedAt: (run.recovery?.required ? run.recovery?.detectedAt : null) ?? journal.finding?.detectedAt ?? null }
  }
  return run
}
/**
 * readRun for a reader that must write nothing (the start preview, its patch download): the
 * journal is judged by inspectJournalReadOnly, so damage is reported, never persisted as a
 * recovery finding. A journal that is not clean reads as recovery required, as readRun reads damage.
 */
export async function readRunReadOnly (issuePath, runId) {
  const run = await readJson(path.join(runDir(issuePath, runId), 'run.json'))
  if (run.pause && !run.pause.id) run.pause.id = 'legacy-' + crypto.createHash('sha256').update(JSON.stringify([runId, run.pause])).digest('hex')
  const verdict = await inspectJournalReadOnly(issuePath, runId)
  run.journal = { complete: verdict.clean, readOnly: true, reason: verdict.reason }
  if (!verdict.clean && verdict.reason !== 'legacy journal retired' && !run.abandonment) run.recovery = { ...run.recovery, required: true, reason: verdict.reason }
  return run
}

/**
 * The journal as a list reading sees it: the persisted finding and the legacy retirement only. Never parses
 * events.jsonl and never writes, so a list read racing an engine append can neither take a half-written tail
 * for damage nor publish a finding (only the engine, requireCompleteEvents callers and readRun publish one).
 */
export async function readJournalFinding (issuePath, runId) {
  try {
    const disposition = await legacyJournalDisposition(issuePath, runId)
    if (disposition) {
      // The finding it retired stays beside it: when the recovery began, for time to response.
      const finding = await readJson(path.join(runDir(issuePath, runId), 'journal-recovery.json')).catch(() => null)
      return { complete: false, recoveryRequired: false, retired: true, disposition, finding, message: 'Legacy pre-execution failure retired with preserved evidence.' }
    }
  } catch (error) { return { complete: false, recoveryRequired: true, message: error.message, finding: null } }
  let finding
  try { finding = await readJson(path.join(runDir(issuePath, runId), 'journal-recovery.json')) } catch (error) {
    if (error.code === 'ENOENT') return { recoveryRequired: false }
    return { complete: false, recoveryRequired: true, finding: null, message: `Event journal recovery record is unreadable: ${error.code ?? error.message}. Execution requires recovery.` }
  }
  if (!finding || typeof finding.message !== 'string' || finding.recoveryRequired !== true) return { complete: false, recoveryRequired: true, finding: null, message: 'Event journal recovery record is unreadable. Execution requires recovery.' }
  return { complete: false, recoveryRequired: true, finding, message: finding.message + ' A durable recovery finding remains even if journal bytes are subsequently repaired.' }
}
export const readSnapshot = (issuePath, runId) => readJson(path.join(runDir(issuePath, runId), 'resolved-playbook.json'))

export async function writeRun (issuePath, runId, run) {
  await writeJson(path.join(runDir(issuePath, runId), 'run.json'), run)
  return run
}

/*
 * The per-append journal check (execution-contract.md "Persistence and decision
 * identity"). A clean full read leaves a trusted entry for the journal: its
 * identity (dev, ino, size, mtime, ctime) and an owned copy of its last 8 KiB
 * with their hash. An append whose journal still matches that entry, with no
 * recovery or legacy-disposition record beside it, does not read the journal
 * again; anything else gets the full read-and-validate at once. After its own
 * write an append re-reads the old and the new last 8 KiB before it trusts the
 * new state. An append the trusted entry vouches for reads at most 24 KiB, so it
 * costs the same at any length; one whose check misses reads the whole journal.
 * An entry vouches only for the names (paths) it was validated or written
 * through, and a name belongs to at most one entry (pathOwner): a name that now
 * resolves to another file loses its old membership and gets the full read.
 *
 * Appends, checks and full reads of one journal take turns in this process
 * (journalChains), so a check never sees this process's own append half
 * written. Chain and cache are keyed by the file's identity (dev:ino), which
 * every name of one journal shares: symlinks, hard links, bind mounts. Inside a
 * slot only the unchained *Locked functions may run; a public journal function
 * called from inside a slot would wait on itself.
 */
const JOURNAL_TAIL = 8192
const SIDE_FILES = ['journal-recovery.json', 'legacy-journal-disposition.json']
const journalCache = new Map()
const journalChains = new Map()
const journalQueued = new Map()
const pathOwner = new Map()   // resolved journal name -> the one cache key whose entry vouches for it

/** Drop a name's membership in any entry other than `key` (it now resolves elsewhere). */
function releaseElsewhere (name, key) {
  const owner = pathOwner.get(name)
  if (owner === undefined || owner === key) return
  journalCache.get(owner)?.paths.delete(name)
  pathOwner.delete(name)
}

const journalPath = (issuePath, runId) => path.join(runDir(issuePath, runId), 'events.jsonl')
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const identityOf = (s) => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs })
const sameIdentity = (a, s) => a.dev === s.dev && a.ino === s.ino && a.size === s.size && a.mtimeNs === s.mtimeNs && a.ctimeNs === s.ctimeNs
// A copy in an allocation of its own: a view would keep the whole journal, or a large event, alive.
const ownedTail = (bytes) => {
  const n = Math.min(bytes.length, JOURNAL_TAIL)
  const out = Buffer.allocUnsafeSlow(n)
  bytes.copy(out, 0, bytes.length - n)
  return out
}
const isEventRecord = (value) => !!value && !Array.isArray(value) && typeof value === 'object' &&
  typeof value.type === 'string' && !!value.type && typeof value.at === 'string'

/** The realpath of a path that may not exist yet: its nearest existing ancestor, the rest rejoined. */
async function existingRealpath (target) {
  const rest = []
  let current = path.resolve(target)
  for (;;) {
    try { return path.join(await fs.realpath(current), ...rest) } catch (error) {
      const parent = path.dirname(current)
      if (error.code !== 'ENOENT' || parent === current) throw error
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}

/** ino:<dev>:<ino> when the journal exists; its resolved path when it does not; else lexical, never cached. */
async function journalKey (file) {
  try {
    const s = await fs.stat(file, { bigint: true })
    return { key: `ino:${s.dev}:${s.ino}`, canonical: true }
  } catch (error) {
    if (error.code === 'ENOENT') {
      try { return { key: 'path:' + await existingRealpath(file), canonical: true } } catch {}
    }
    return { key: 'lex:' + path.resolve(file), canonical: false }
  }
}

function enqueue (key, fn) {
  const run = (journalChains.get(key) ?? Promise.resolve()).then(() => fn())
  const tail = run.then(() => {}, () => {})
  journalChains.set(key, tail)
  journalQueued.set(key, (journalQueued.get(key) ?? 0) + 1)
  tail.then(() => {
    const left = journalQueued.get(key) - 1
    if (left) journalQueued.set(key, left); else journalQueued.delete(key)
    if (journalChains.get(key) === tail) journalChains.delete(key)
  })
  return run
}

/** Run fn in the journal's slot, under the key that is current when the work starts. */
async function inJournalChain (file, fn) {
  let ident = await journalKey(file)
  for (let attempt = 0; ; attempt++) {
    const outcome = await enqueue(ident.key, async () => {
      const now = await journalKey(file)
      if (now.key === ident.key) return { value: await fn(now) }
      if (attempt > 0) return { value: await fn({ key: now.key, canonical: false }) }
      return { next: now }
    })
    if (!outcome.next) return outcome.value
    ident = outcome.next
  }
}

/*
 * After a full read. `stat` is the identity the bytes were read under, or null when the content
 * was refused, unreadable or moved: then the entry goes. Content read whole and clean is
 * trusted even when a caller's own side file refuses it (one hard-linked run's recovery
 * record says nothing about the shared journal); the caller's name joins the names the entry
 * vouches for only when its whole result is clean.
 */
function seed (ident, file, stat, bytes, cleanForCaller) {
  const name = path.resolve(file)
  releaseElsewhere(name, ident.key)
  if (!ident.canonical || !stat || ident.key !== `ino:${stat.dev}:${stat.ino}`) return journalCache.delete(ident.key)
  const tail = ownedTail(bytes)
  const known = journalCache.get(ident.key)
  const paths = new Set(known && sameIdentity(known, stat) && known.tail.equals(tail) ? known.paths : [])
  if (cleanForCaller) { paths.add(name); pathOwner.set(name, ident.key) } else {
    paths.delete(name)
    if (pathOwner.get(name) === ident.key) pathOwner.delete(name)
  }
  journalCache.set(ident.key, { ...identityOf(stat), tail, tailHash: sha256(tail), paths })
}

/**
 * The trusted entry if the journal still matches it, read through a name it was validated or
 * written through: an fstat, at most 8 KiB read, two stats. A name the entry does not own (new
 * to it, or last recorded under another file, such as a path switched to a link elsewhere and
 * back) gets the full read; a name now resolving elsewhere first loses its old membership.
 */
async function quickCheck (dir, file, ident) {
  const name = path.resolve(file)
  releaseElsewhere(name, ident.key)
  const entry = ident.canonical ? journalCache.get(ident.key) : null
  if (!entry || !entry.paths.has(name) || pathOwner.get(name) !== ident.key) return null
  let handle
  try {
    handle = await fs.open(file, 'r')
    const s = await handle.stat({ bigint: true })
    if (!sameIdentity(entry, s)) return null
    const n = entry.tail.length
    const bytes = Buffer.alloc(n)
    const { bytesRead } = await handle.read(bytes, 0, n, Number(s.size) - n)
    if (bytesRead !== n || !bytes.equals(entry.tail) || sha256(bytes) !== entry.tailHash) return null
  } catch { return null } finally { await handle?.close().catch(() => {}) }
  for (const name of SIDE_FILES) {
    try { await fs.stat(path.join(dir, name)); return null } catch (error) { if (error.code !== 'ENOENT') return null }
  }
  return entry
}

/** The quick check, else today's full validation and refusal. Returns the entry an append may build on. */
async function vouchLocked (issuePath, runId, file, ident) {
  const entry = await quickCheck(path.dirname(file), file, ident)
  if (entry) return { journal: { status: 'complete', complete: true, recoveryRequired: false, stoppedAt: null, message: null }, entry }
  // The full read below replaces or drops the entry from what it finds.
  const journal = await inspectLocked(issuePath, runId, file, ident)
  if (journal.recoveryRequired || journal.retired) {
    throw Object.assign(new Error(journal.message), { code: 'EVENT_JOURNAL_RECOVERY_REQUIRED', status: 409, journal })
  }
  return { journal, entry: ident.canonical ? journalCache.get(ident.key) ?? null : null }
}

/**
 * After our own write: the old last 8 KiB are still what we vouched for, the new
 * last 8 KiB are what we computed, and nothing moved meanwhile. Only then is the
 * new state trusted. Any failure leaves no entry; the append itself stands.
 */
async function proveAppend (file, ident, vouched, line) {
  let handle
  try {
    handle = await fs.open(file, 'r')
    const s1 = await handle.stat({ bigint: true })
    if (s1.dev !== vouched.dev || s1.ino !== vouched.ino || s1.size !== vouched.size + BigInt(line.length)) return
    const old = vouched.tail
    const oldBytes = Buffer.alloc(old.length)
    if ((await handle.read(oldBytes, 0, old.length, Number(vouched.size) - old.length)).bytesRead !== old.length || !oldBytes.equals(old)) return
    const m = Math.min(line.length, JOURNAL_TAIL)
    const k = Math.min(old.length, JOURNAL_TAIL - m)
    const tail = Buffer.allocUnsafeSlow(k + m)
    old.copy(tail, 0, old.length - k)
    line.copy(tail, k, line.length - m)
    const newBytes = Buffer.alloc(tail.length)
    if ((await handle.read(newBytes, 0, tail.length, Number(s1.size) - tail.length)).bytesRead !== tail.length || !newBytes.equals(tail)) return
    const s2 = await handle.stat({ bigint: true })
    if (!sameIdentity(s1, s2) || !ident.canonical || ident.key !== `ino:${s1.dev}:${s1.ino}`) return
    journalCache.set(ident.key, { ...identityOf(s1), tail, tailHash: sha256(tail), paths: vouched.paths })
  } catch {} finally { await handle?.close().catch(() => {}) }
}

async function appendLocked (issuePath, runId, file, ident, event, clock) {
  // The journal is checked first: a damaged journal refuses before the record is judged.
  const { entry: vouched } = await vouchLocked(issuePath, runId, file, ident)
  const record = { at: clock.iso(), ...event }
  let text, parsed = null
  try { text = JSON.stringify(record); parsed = JSON.parse(text) } catch {}
  if (typeof text !== 'string' || text.includes(NL) || !isEventRecord(parsed)) {
    throw Object.assign(new Error('Event record refused before writing: an event needs a type and an at string'), { code: 'EVENT_RECORD_INVALID', status: 400 })
  }
  const line = Buffer.from(text + NL)
  journalCache.delete(ident.key)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await appendDurable(file, line)
  if (vouched) await proveAppend(file, ident, vouched, line)
  return record
}

export async function appendEvent (issuePath, runId, event, { clock = systemClock, emit = null } = {}) {
  const file = journalPath(issuePath, runId)
  const record = await inJournalChain(file, (ident) => appendLocked(issuePath, runId, file, ident, event, clock))
  // Emission happens only after the durable write, outside the journal's slot.
  if (emit) emit(record)
  return record
}

/** The whole journal through one handle, with the identity it had while read (null if it moved). */
async function readJournal (file) {
  let handle
  try { handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK) } catch (error) { return { error } }
  try {
    const s0 = await handle.stat({ bigint: true })
    // A FIFO or device in the journal's place is unreadable, never waited on.
    if (!s0.isFile()) return { error: Object.assign(new Error('the event journal is not a regular file'), { code: 'ENOTREG' }) }
    const bytes = await handle.readFile()
    const s1 = await handle.stat({ bigint: true })
    return { bytes, stat: sameIdentity(s0, s1) && s1.size === BigInt(bytes.length) ? s1 : null }
  } catch (error) { return { error } } finally { await handle.close().catch(() => {}) }
}

/** Read only a contiguous, newline-committed prefix. Never skip a bad record. */
async function parseEvents (file) {
  const events = []
  const problem = (status, line, byteOffset, detail) => ({
    events, status, complete: false, recoveryRequired: true,
    stoppedAt: { line, byteOffset },
    message: `Event journal ${status} at line ${line}, byte ${byteOffset}: ${detail}. Readable history is diagnostic only; execution requires recovery.`
  })
  const read = await readJournal(file)
  if (read.error) {
    return { journal: problem(read.error.code === 'ENOENT' ? 'missing' : 'unreadable', 1, 0, read.error.code ?? read.error.message), bytes: null, stat: null }
  }
  const { bytes, stat } = read
  return { journal: parseBytes(bytes, events, problem), bytes, stat }
}

function parseBytes (bytes, events, problem) {
  let offset = 0, line = 1
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    const terminated = end !== -1
    let value
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, terminated ? end : bytes.length))
      value = JSON.parse(text)
      if (!isEventRecord(value)) throw new Error('Expected an event object with type and at strings')
    } catch (error) {
      const incomplete = !terminated && /unexpected end|unterminated/i.test(error.message)
      return problem(incomplete ? 'incomplete-tail' : terminated ? 'corrupt-record' : 'corrupt-tail', line, offset, error.message)
    }
    // Even syntactically valid JSON without the append delimiter is uncommitted.
    if (!terminated) return problem('incomplete-tail', line, offset, 'Final append has no newline delimiter')
    events.push(value)
    offset = end + 1
    line++
  }
  return { events, status: 'complete', complete: true, recoveryRequired: false, stoppedAt: null, message: null }
}

/** No caller may infer execution authority from a recovered prefix. */
export async function inspectRunJournal (issuePath, runId) {
  const file = journalPath(issuePath, runId)
  return inJournalChain(file, (ident) => inspectLocked(issuePath, runId, file, ident))
}

async function inspectLocked (issuePath, runId, file, ident) {
  const { journal, bytes, stat } = await parseEvents(file)
  const result = await judgeJournal(issuePath, runId, journal)
  const clean = result.complete && !result.recoveryRequired && !result.retired && !result.finding && !result.recoveryPersistenceError
  seed(ident, file, journal.complete ? stat : null, bytes, clean)
  return result
}

async function judgeJournal (issuePath, runId, journal) {
  try {
    const disposition = await legacyJournalDisposition(issuePath, runId)
    if (disposition) return { ...journal, complete: false, recoveryRequired: false, retired: true, disposition,
      message: 'Legacy pre-execution failure retired with preserved evidence. This run cannot resume; new runs are allowed.' }
  } catch (error) { return { ...journal, complete: false, recoveryRequired: true, message: error.message } }
  const file = path.join(runDir(issuePath, runId), 'journal-recovery.json')
  let finding
  try {
    finding = await readJson(file)
    if (!finding || typeof finding.message !== 'string' || finding.recoveryRequired !== true) throw new Error('Invalid recovery finding')
  } catch (error) {
    if (error.code !== 'ENOENT') return { ...journal, complete: false, recoveryRequired: true,
      message: `Event journal recovery record is unreadable: ${error.code ?? error.message}. Execution requires recovery.` }
  }
  if (journal.recoveryRequired && !finding) {
    const { events, ...diagnostic } = journal
    finding = { ...diagnostic, detectedAt: new Date().toISOString() }
    // This runs on every read of a run. A reader can hold the path of an issue being packed or
    // deleted: its journal is missing because the run is gone, and creating the directories here
    // would bring back a folder without its archive marker, which then reads as an open issue.
    // Published exclusively: two first readers at once must agree on one detectedAt (the occurrence
    // a notification links to), so the one that loses adopts the finding already there.
    try { await writeJsonExclusive(file, finding, { parents: false }) } catch (error) {
      let adopted = null
      if (error.code === 'EEXIST') adopted = await readJson(file).catch(() => null)
      if (adopted?.recoveryRequired === true && typeof adopted.message === 'string') finding = adopted
      else return { ...journal, recoveryPersistenceError: error.code ?? error.message,
        message: journal.message + ` Recovery finding could not be persisted: ${error.code ?? error.message}.` }
    }
  }
  if (finding) return { ...journal, complete: false, recoveryRequired: true, finding,
    message: (journal.message ?? finding.message) + ' A durable recovery finding remains even if journal bytes are subsequently repaired.' }
  return journal
}

export const readEvents = inspectRunJournal

/**
 * Whether a run's journal is clean, read without writing anything: the same
 * reading as inspectRunJournal, which persists a recovery finding when it finds
 * damage. A read-only reader (ref-retention.mjs) takes damage, a finding already
 * on disk, an unreadable finding or a retired legacy journal all as "not clean".
 */
export async function inspectJournalReadOnly (issuePath, runId) {
  const file = journalPath(issuePath, runId)
  return inJournalChain(file, async (ident) => {
    const { journal, bytes, stat } = await parseEvents(file)
    const verdict = await judgeReadOnly(issuePath, runId, journal)
    // A clean read-only reading is as good a validation as any: it seeds the entry too.
    seed(ident, file, journal.complete ? stat : null, bytes, verdict.clean)
    return verdict
  })
}

async function judgeReadOnly (issuePath, runId, journal) {
  if (journal.recoveryRequired) return { clean: false, reason: journal.message }
  try {
    if (await legacyJournalDisposition(issuePath, runId)) return { clean: false, reason: 'legacy journal retired' }
  } catch (error) { return { clean: false, reason: error.message } }
  try {
    await fs.access(path.join(runDir(issuePath, runId), 'journal-recovery.json'))
    return { clean: false, reason: 'a journal recovery finding is on record' }
  } catch (error) {
    if (error.code !== 'ENOENT') return { clean: false, reason: `journal recovery record unreadable: ${error.code ?? error.message}` }
  }
  return { clean: true, reason: null }
}

/** Throws EVENT_JOURNAL_RECOVERY_REQUIRED as before; a journal matching its trusted entry is not read again. */
export async function requireCompleteEvents (issuePath, runId) {
  const file = journalPath(issuePath, runId)
  return inJournalChain(file, async (ident) => (await vouchLocked(issuePath, runId, file, ident)).journal)
}

/** Test seam: the trusted entry for a journal, and how many calls are queued on it. */
export const __journalCache = {
  async get (issuePath, runId) { return journalCache.get((await journalKey(journalPath(issuePath, runId))).key) ?? null },
  async queued (issuePath, runId) { return journalQueued.get((await journalKey(journalPath(issuePath, runId))).key) ?? 0 }
}

/**
 * The prompt an agent was actually sent, keyed by invocation. Written before the
 * call, so a turn that never returns still shows what was asked. Kept in run
 * metadata: the step folder holds only response.md.
 */
export const writePrompt = (issuePath, runId, invocationId, data) =>
  writeJson(path.join(runDir(issuePath, runId), 'prompts', `${invocationId}.json`), data)

export async function readPrompts (issuePath, runId) {
  const dir = path.join(runDir(issuePath, runId), 'prompts')
  const out = {}
  let names = []
  try { names = await fs.readdir(dir) } catch { return out }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const record = await readJson(path.join(dir, name))
    out[record.invocationId] = record
  }
  return out
}

export const writeOutput = (issuePath, runId, number, data) =>
  writeJson(path.join(runDir(issuePath, runId), 'outputs', `${number}.json`), data)

/** A run's structured outputs. With `strict` (the panel's refresh) only a missing outputs/ reads as none; any other failure throws. */
export async function readOutputs (issuePath, runId, { strict = false } = {}) {
  const dir = path.join(runDir(issuePath, runId), 'outputs')
  const out = {}
  let names = []
  try { names = await fs.readdir(dir) } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error
    return out
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    out[name.replace(/\.json$/, '')] = await readJson(path.join(dir, name))
  }
  return out
}

/*
 * Everything the runtime wrote while a turn was in flight, per invocation, at
 * runs/<run-id>/live/<invocationId>.jsonl. Raw stdout and stderr chunks, in
 * order, with spawn and exit markers. The step's response.md remains the
 * result; this is the transcript of how it was produced, kept so a browser
 * that arrives late, or reconnects, reads the same bytes a live one saw.
 */
const LIVE_MAX_BYTES = Number(process.env.DEVPANEL_LIVE_MAX_BYTES ?? 64 * 1024 * 1024)

export const liveFile = (issuePath, runId, invocationId) =>
  path.join(runDir(issuePath, runId), 'live', `${invocationId.replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`)

/** Kinds that are metadata about the invocation, not its output. Kept past the cap. */
const TERMINAL_KINDS = new Set(['spawn', 'exit', 'truncated'])

/**
 * Append one entry. Returns { kept, entry }: `entry` is what was actually
 * persisted and should be forwarded — the entry itself, or the cap marker that
 * replaced it — and `kept` is false once output is being dropped.
 *
 * Output past the cap is dropped, but the markers that say what happened to
 * the invocation are not: a viewer must see that the log was capped and that
 * the turn ended, or a capped turn looks like one that is still running.
 */
export const appendLive = (issuePath, runId, invocationId, entry, sizes = new Map(), options = {}) =>
  appendLiveFile(liveFile(issuePath, runId, invocationId), entry, sizes, options)

/*
 * The seq of the last entry written to each file, per recorder (keyed by its
 * `sizes` map). Sequence numbers are allocated before the append and output
 * past the cap is dropped, so the persisted seqs can skip (1, 2, 3, 5): a
 * viewer cannot tell a missed socket event from such a hole by arithmetic.
 * Each persisted entry is therefore forwarded with `prev`, the seq of the
 * entry before it in the file.
 */
const lastSeqs = new WeakMap()

/** The same, to any live file (the top-level supervisor keeps its own). */
export async function appendLiveFile (file, entry, sizes = new Map(), { maxBytes = LIVE_MAX_BYTES } = {}) {
  const size = sizes.get(file) ?? 0
  const capped = size >= maxBytes

  if (capped && !TERMINAL_KINDS.has(entry.kind)) return { kept: false, entry: null, prev: null }

  await fs.mkdir(path.dirname(file), { recursive: true })
  let seqs = lastSeqs.get(sizes)
  if (!seqs) { seqs = new Map(); lastSeqs.set(sizes, seqs) }
  // A recorder that has not written this file yet: whatever is already there
  // (a writer resumed on an existing file) comes first.
  if (!seqs.has(file)) seqs.set(file, (await readLiveFile(file)).at(-1)?.seq ?? 0)
  let record = entry
  const line = JSON.stringify(entry) + NL
  if (!capped && size + Buffer.byteLength(line) > maxBytes && !TERMINAL_KINDS.has(entry.kind)) {
    record = { ...entry, kind: 'truncated', text: `live log capped at ${maxBytes} bytes; further output was not kept` }
  }
  const payload = JSON.stringify(record) + NL
  const bytes = Buffer.byteLength(payload)
  await fs.appendFile(file, payload, { mode: 0o600 })
  sizes.set(file, record.kind === 'truncated' ? Math.max(size + bytes, maxBytes) : size + bytes)
  const prev = seqs.get(file)
  seqs.set(file, record.seq)
  return { kept: record === entry, entry: record, prev }
}

/** Entries after sequence number `after` (exclusive), so a client can catch up incrementally. */
export const readLive = (issuePath, runId, invocationId, options = {}) =>
  readLiveFile(liveFile(issuePath, runId, invocationId), options)

export async function readLiveFile (file, { after = 0 } = {}) {
  let text = ''
  try { text = await fs.readFile(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split(NL)) {
    if (!line) continue
    try {
      const entry = JSON.parse(line)
      if (entry.seq > after) out.push(entry)
    } catch { /* a torn last line is still being written */ }
  }
  return out
}

/*
 * Bounded reads of a live log, for viewers (opt-in: a plain `after` read stays
 * the full suffix). A page holds at most LIVE_PAGE_ENTRIES entries and
 * LIVE_PAGE_BYTES of serialized entries, so escaping and metadata count. An
 * entry that cannot fit a page alone is returned clipped (`sliced`), and its
 * text is read in bounded slices with `entry` + `offset`.
 */
export const LIVE_PAGE_BYTES = 512 * 1024
export const LIVE_PAGE_ENTRIES = 1000
const ENVELOPE_BYTES = 1024
const FIELD_KEEP_BYTES = 16 * 1024
const entryBytes = (entry) => Buffer.byteLength(JSON.stringify(entry)) + 1

/** Never split a surrogate pair. */
function cutAt (text, end) {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) return end - 1
  }
  return end
}

/** The longest prefix of `text` from `offset` whose JSON string form fits `budget` bytes. */
function fitText (text, offset, budget) {
  let lo = offset
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(JSON.stringify(text.slice(offset, mid))) <= budget) lo = mid
    else hi = mid - 1
  }
  return cutAt(text, lo)
}

/** An entry as it may be delivered: itself when it fits `maxBytes`, else its text clipped and marked. */
export function clipForDelivery (entry, maxBytes = LIVE_PAGE_BYTES - ENVELOPE_BYTES) {
  if (!entry || entryBytes(entry) <= maxBytes) return entry
  const text = typeof entry.text === 'string' ? entry.text : ''
  const out = { seq: entry.seq, at: entry.at, kind: entry.kind }
  const omitted = []
  for (const [key, value] of Object.entries(entry)) {
    if (key in out || key === 'text') continue
    if (Buffer.byteLength(JSON.stringify(value) ?? '') <= FIELD_KEEP_BYTES) out[key] = value
    else omitted.push(key)
  }
  if (omitted.length) out.omitted = omitted
  const shell = { ...out, text: '', sliced: { total: text.length, offset: 0, length: 0 } }
  const end = fitText(text, 0, Math.max(0, maxBytes - entryBytes(shell) - 32))
  return { ...out, text: text.slice(0, end), sliced: { total: text.length, offset: 0, length: end } }
}

const intOr = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback)

/**
 * One bounded page. `after` (forward from a seq, exclusive), `tail` (the last N)
 * or `before` (backward from a seq, exclusive); `limit` caps the entries.
 */
export function pageLive (all, { after = 0, before = null, tail = null, limit = LIVE_PAGE_ENTRIES } = {}) {
  const max = Math.min(Math.max(1, intOr(limit, LIVE_PAGE_ENTRIES)), LIVE_PAGE_ENTRIES)
  const budget = LIVE_PAGE_BYTES - ENVELOPE_BYTES
  const last = all.at(-1)?.seq ?? 0
  let entries = []
  let used = 0
  const take = (entry, front) => {
    const delivered = entries.length ? entry : clipForDelivery(entry, budget)
    const bytes = entryBytes(delivered)
    if (entries.length && (entries.length >= max || used + bytes > budget)) return false
    if (front) entries.unshift(delivered); else entries.push(delivered)
    used += bytes
    return delivered === entry
  }
  if (tail != null || before != null) {
    const n = tail != null ? Math.min(Math.max(1, intOr(tail, max)), max) : max
    const end = before != null ? all.findIndex((e) => e.seq >= before) : -1
    const upto = end < 0 ? all.length : end
    for (let i = upto - 1; i >= 0 && entries.length < n; i--) {
      // Backward, a clipped entry ends the page: it is the oldest one held.
      if (!take(all[i], true) || entries[0].sliced) break
    }
    const first = entries[0]?.seq ?? null
    const firstIndex = first == null ? upto : all.findIndex((e) => e.seq === first)
    const lastHeld = entries.at(-1)?.seq ?? null
    const lastIndex = lastHeld == null ? upto - 1 : all.findIndex((e) => e.seq === lastHeld)
    return { entries, next: lastHeld ?? (firstIndex > 0 ? all[firstIndex - 1].seq : 0), first, last, more: lastIndex < all.length - 1, earlier: firstIndex > 0 }
  }
  const start = all.findIndex((e) => e.seq > after)
  if (start >= 0) {
    for (let i = start; i < all.length; i++) {
      if (!take(all[i], false) || entries.at(-1).sliced) break
    }
  }
  const held = entries.length
  const lastHeld = entries.at(-1)?.seq ?? after
  return {
    entries,
    next: lastHeld,
    first: entries[0]?.seq ?? null,
    last,
    more: start >= 0 && start + held < all.length,
    earlier: start > 0 || (start < 0 && all.length > 0)
  }
}

/** A bounded slice of one entry's text, from `offset` (UTF-16 code units). */
export function sliceLiveEntry (all, seq, offset = 0) {
  const entry = all.find((e) => e.seq === seq)
  if (!entry) return null
  const text = typeof entry.text === 'string' ? entry.text : ''
  const from = Math.min(intOr(offset, 0), text.length)
  const end = fitText(text, from, LIVE_PAGE_BYTES - ENVELOPE_BYTES)
  return { seq, offset: from, text: text.slice(from, end), total: text.length, done: end >= text.length }
}

/*
 * A live-output route's query. A plain `after` is the full suffix, as it always was;
 * `limit`, `tail`, `before` or `entry` (+ `offset`) ask for one bounded page or slice.
 * `after` is parsed exactly as the routes always did (any finite number, else 0);
 * for the new parameters anything but a whole number is absent.
 */
export function parseLiveQuery (q = {}) {
  const n = (v) => { if (v === undefined) return null; const x = Number(v); return Number.isInteger(x) && x >= 0 ? x : null }
  const after = Number(q.after ?? 0)
  return { after: Number.isFinite(after) ? after : 0, limit: n(q.limit), tail: n(q.tail), before: n(q.before), entry: n(q.entry), offset: n(q.offset) ?? 0 }
}


/**
 * A live read for a viewer: bounded when asked (`limit`, `tail`, `before`,
 * `entry`), else exactly the old full suffix after `after`.
 */
export async function readLiveView (file, { after = 0, limit = null, tail = null, before = null, entry = null, offset = 0 } = {}) {
  if (entry != null) return sliceLiveEntry(await readLiveFile(file), entry, offset)
  if (limit == null && tail == null && before == null) {
    const entries = await readLiveFile(file, { after })
    return { entries, next: entries.at(-1)?.seq ?? after, legacy: true }
  }
  return pageLive(await readLiveFile(file), { after, before, tail, limit: limit ?? LIVE_PAGE_ENTRIES })
}

/**
 * The baseline the run's fingerprints are measured against. Persisted at start:
 * rebuilding it on restart would measure the MODIFIED workspace against itself
 * and silently redefine what "changed" means.
 */
export const writeBaseline = async (issuePath, runId, baseline) => {
  await writeJson(path.join(runDir(issuePath, runId), 'baseline.json'), Object.fromEntries(baseline))
  // Modes beside the hashes, in their own file: baseline.json stays a flat
  // path -> hash map that older runs and readers already understand.
  if (baseline.modes) await writeJson(path.join(runDir(issuePath, runId), 'baseline-modes.json'), Object.fromEntries(baseline.modes))
}

export async function readBaseline (issuePath, runId) {
  let baseline
  try {
    baseline = new Map(Object.entries(await readJson(path.join(runDir(issuePath, runId), 'baseline.json'))))
  } catch {
    return null
  }
  // A run started before modes were recorded has no sidecar: mode-only changes
  // are then invisible to it, exactly as they were. Only absence means that. A
  // sidecar that exists but cannot be read or parsed is carried as an error, so
  // nothing downstream can mistake "unknown" for "unchanged".
  const modesFile = path.join(runDir(issuePath, runId), 'baseline-modes.json')
  try {
    baseline.modes = new Map(Object.entries(await readJson(modesFile)))
  } catch (error) {
    if (error?.code !== 'ENOENT') baseline.modesError = `${modesFile}: ${error.message}`
  }
  return baseline
}

export const newRunId = (clock = systemClock) =>
  `${new Date(clock.now()).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
