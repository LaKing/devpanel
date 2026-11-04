import { legacyJournalDisposition } from './legacy-journal.mjs'
import { writeJson, appendDurable } from './persistence.mjs'
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

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

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

export async function readRun (issuePath, runId) {
  const run = await readJson(path.join(runDir(issuePath, runId), 'run.json'))
  if (run.pause && !run.pause.id) run.pause.id = 'legacy-' + crypto.createHash('sha256').update(JSON.stringify([runId, run.pause])).digest('hex')
  const { events, ...journal } = await inspectRunJournal(issuePath, runId)
  run.journal = journal
  if (journal.recoveryRequired && !run.abandonment) run.recovery = { ...run.recovery, required: true, reason: journal.message }
  return run
}
export const readSnapshot = (issuePath, runId) => readJson(path.join(runDir(issuePath, runId), 'resolved-playbook.json'))

export async function writeRun (issuePath, runId, run) {
  await writeJson(path.join(runDir(issuePath, runId), 'run.json'), run)
  return run
}

export async function appendEvent (issuePath, runId, event, { clock = systemClock, emit = null } = {}) {
  const file = path.join(runDir(issuePath, runId), 'events.jsonl')
  await requireCompleteEvents(issuePath, runId)
  const record = { at: clock.iso(), ...event }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await appendDurable(file, JSON.stringify(record) + NL)
  // Emission happens only after the durable write.
  if (emit) emit(record)
  return record
}

/** Read only a contiguous, newline-committed prefix. Never skip a bad record. */
async function parseEvents (issuePath, runId) {
  const events = []
  let bytes
  const problem = (status, line, byteOffset, detail) => ({
    events, status, complete: false, recoveryRequired: true,
    stoppedAt: { line, byteOffset },
    message: `Event journal ${status} at line ${line}, byte ${byteOffset}: ${detail}. Readable history is diagnostic only; execution requires recovery.`
  })
  try { bytes = await fs.readFile(path.join(runDir(issuePath, runId), 'events.jsonl')) } catch (error) {
    return problem(error.code === 'ENOENT' ? 'missing' : 'unreadable', 1, 0, error.code ?? error.message)
  }
  let offset = 0, line = 1
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset)
    const terminated = end !== -1
    let value
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, terminated ? end : bytes.length))
      value = JSON.parse(text)
      if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.type !== 'string' || !value.type || typeof value.at !== 'string') throw new Error('Expected an event object with type and at strings')
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
  const journal = await parseEvents(issuePath, runId)
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
    try { await writeJson(file, finding, { parents: false }) } catch (error) {
      return { ...journal, recoveryPersistenceError: error.code ?? error.message,
        message: journal.message + ` Recovery finding could not be persisted: ${error.code ?? error.message}.` }
    }
  }
  if (finding) return { ...journal, complete: false, recoveryRequired: true, finding,
    message: (journal.message ?? finding.message) + ' A durable recovery finding remains even if journal bytes are subsequently repaired.' }
  return journal
}

export const readEvents = inspectRunJournal

export async function requireCompleteEvents (issuePath, runId) {
  const journal = await inspectRunJournal(issuePath, runId)
  if (journal.recoveryRequired || journal.retired) {
    throw Object.assign(new Error(journal.message), { code: 'EVENT_JOURNAL_RECOVERY_REQUIRED', status: 409, journal })
  }
  return journal
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

export async function readOutputs (issuePath, runId) {
  const dir = path.join(runDir(issuePath, runId), 'outputs')
  const out = {}
  let names = []
  try { names = await fs.readdir(dir) } catch { return out }
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

/** The same, to any live file (the top-level supervisor keeps its own). */
export async function appendLiveFile (file, entry, sizes = new Map(), { maxBytes = LIVE_MAX_BYTES } = {}) {
  const size = sizes.get(file) ?? 0
  const capped = size >= maxBytes

  if (capped && !TERMINAL_KINDS.has(entry.kind)) return { kept: false, entry: null }

  await fs.mkdir(path.dirname(file), { recursive: true })
  let record = entry
  const line = JSON.stringify(entry) + NL
  if (!capped && size + Buffer.byteLength(line) > maxBytes && !TERMINAL_KINDS.has(entry.kind)) {
    record = { ...entry, kind: 'truncated', text: `live log capped at ${maxBytes} bytes; further output was not kept` }
  }
  const bytes = Buffer.byteLength(JSON.stringify(record) + NL)
  await appendDurable(file, JSON.stringify(record) + NL)
  sizes.set(file, record.kind === 'truncated' ? Math.max(size + bytes, maxBytes) : size + bytes)
  return { kept: record === entry, entry: record }
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
