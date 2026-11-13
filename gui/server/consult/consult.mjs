import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'

import { DEFAULT_CONFIG_ROOT } from '../config/host-config.mjs'
import { hostSettings } from '../config/host-settings.mjs'
import { canonical } from '../decisions/index.mjs'
import { estimateCallCost } from '../runtime/call-cost.mjs'
import { fencePolicy } from '../runtime/confinement-policy.mjs'
import { classifyFailure } from '../runtime/failure.mjs'
import { bareObjects, fencedObjects } from '../runtime/structured-output.mjs'
import { loadPanel, resolveSeats } from './panel.mjs'
import { briefPrompt, decidePrompt, reconcilePrompt, repairPrompt } from './prompt.mjs'
import { consultRoots } from './roots.mjs'
import { answerText, briefFor, judge, nextOptions, optionsFor } from './rule.mjs'

/*
 * The consult panel (docs/consult.md): a question is put to two senior seats
 * that read everything read-only, before it reaches a person.
 *
 * Called by the engine for a run's questions and by the top-level supervisor
 * for its own. It decides nothing about runs: it returns `resolved` with the
 * agreed answer, `escalated` with the question written for a person, or
 * `unavailable`, and the caller acts as its own rules say.
 *
 * Everything is recorded under `<callerDir>/consults/<id>/` as it happens and
 * `result.json` is written before the result is returned, so a caller that
 * replays (a run after a crash) reads the record and never asks twice. The id
 * is the hash of the caller's key, the question and the mode: the same question
 * is one consult however often it is put.
 */

const NL = String.fromCharCode(10)
const HARNESS_DIR = () => process.env.DEVPANEL_HARNESS_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'harness')
const PANEL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')

const SEAT_INSTRUCTIONS = 'You are a read-only consultant. You may read files and run commands that only read; you change nothing outside your scratch directory, start no service and reach no remote host. Your whole reply is the JSON object the task asks for, preceded by at most a few sentences.'

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
const readJson = (file) => fs.readFile(file, 'utf8').then(JSON.parse, (error) => { if (error.code === 'ENOENT') return null; throw error })
async function writeJson (file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + NL)
  await fs.rename(temp, file)
}

export const consultId = ({ key, question, mode = 'decide' }) => sha(canonical({ key: key ?? null, question, mode })).slice(0, 16)

/** The fence of one seat turn: every root read-only, the scratch writable, credentials masked. Null when this host runs no fence. */
function defaultFence ({ roots, scratchDir }) {
  if (fencePolicy().mode !== 'fence') return null
  return { cwd: roots.cwd, writable: [scratchDir], readOnly: roots.roots.map((r) => r.alias ?? r.path), entries: [], masks: roots.masks, panelRoot: PANEL_ROOT }
}

/**
 * @param spending      () => ({ ledger, admit }) | null — the spending ledger and its gate (top-supervisor.mjs decisionSpending)
 * @param availability  the host's model availability store, or null
 * @param loadRoster    () => Map of roster entries
 * @param relatedOf     (project) => further project ids a consult on it may read
 * @param buildFence    ({ roots, scratchDir }) => fence spec | null; null means no proved read access, so no consult
 */
export function createConsult ({
  root = DEFAULT_CONFIG_ROOT,
  loadPanelConfig = () => loadPanel({ root }),
  loadRoster = async () => (await (await import('../config/load.mjs')).loadConfig({ root })).roster,
  relatedOf = async () => [],
  loadAdapter = (harness) => import(pathToFileURL(path.join(HARNESS_DIR(), `${harness}.mjs`)).href),
  rootsFor = consultRoots,
  buildFence = defaultFence,
  spending = () => null,
  availability = null,
  language = () => hostSettings().operatorLanguage,
  clock = { now: () => Date.now(), iso: () => new Date().toISOString() }
} = {}) {
  let validateOpinion = null
  async function opinionProblem (value) {
    if (!validateOpinion) {
      const ajv = new Ajv2020({ allErrors: true, strict: false })
      validateOpinion = ajv.compile(JSON.parse(await fs.readFile(path.join(root, 'schemas', 'consult-opinion.schema.json'), 'utf8')))
    }
    return validateOpinion(value) ? null : validateOpinion.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
  }

  /** The opinion in a reply, or what is wrong with it. */
  async function readOpinion (text, { options, brief }) {
    const found = [...fencedObjects(text), ...bareObjects(text)].map((c) => c.value).filter((v) => v && typeof v.verdict === 'string')
    if (!found.length) return { problem: 'it held no JSON object with a "verdict"' }
    const opinion = found.at(-1)
    const problem = await opinionProblem(opinion)
    if (problem) return { problem }
    if (brief && opinion.verdict !== 'owner') return { problem: 'this question is reserved to a person: the verdict must be "owner"' }
    if (opinion.verdict === 'answer' && opinion.choice !== 'other' && !options.some((o) => o.key === opinion.choice)) {
      return { problem: `"${opinion.choice}" is not one of the option keys (${[...options.map((o) => o.key), 'other'].join(', ')})` }
    }
    return { opinion }
  }

  // Admission reads the ledger's usage and the reservation changes it: the two
  // seats of a round start together, so each must see the other's reservation
  // or both pass on the last dollars. One at a time through this chain.
  let admitting = Promise.resolve()
  function reserveTurn ({ gate, panel, seat, tag }) {
    const turn = admitting.then(async () => {
      const verdict = gate?.admit ? gate.admit({ subject: 'decision', maxCostUsd: panel.maxTurnCostUsd }) : { ok: true }
      if (!verdict.ok) return { refused: verdict.detail ?? verdict.limit ?? 'the spending policy refused the call' }
      if (!gate?.ledger) return { reservation: null }
      const reservation = `consult-${tag}-${crypto.randomUUID()}`
      await gate.ledger.reserve({ id: reservation, subject: 'decision', maxCostUsd: panel.maxTurnCostUsd, meta: { purpose: 'consult', seat: seat.seat, model: seat.model.id } })
      return { reservation }
    })
    admitting = turn.catch(() => {})
    return turn
  }

  /** One adapter call of one seat, on the ledger, never throwing: `{ response, session, usage, costUsd }` or `{ error }`. */
  async function invoke ({ seat, prompt, session, dir, roots, scratchDir, panel, signal, tag }) {
    const fence = buildFence({ roots, scratchDir })
    if (!fence) return { error: { class: 'environment', message: 'this host runs no seat fence, so read-only access cannot be proved' } }
    const gate = spending()
    const { refused, reservation } = await reserveTurn({ gate, panel, seat, tag })
    if (refused) return { error: { class: 'spending-refused', message: refused } }
    const deadline = AbortSignal.timeout(panel.turnTimeoutMinutes * 60_000)
    const live = path.join(dir, 'live', `${tag}.jsonl`)
    await fs.mkdir(path.dirname(live), { recursive: true })
    let seq = 0
    try {
      const adapter = await loadAdapter(seat.model.harness)
      const result = await adapter.invoke({
        model: seat.model.model, effort: seat.effort, profile: seat.model.profile ?? 'default',
        endpointRef: seat.model.endpointRef ?? null, credentialRef: seat.model.credentialRef ?? null, account: seat.model.account ?? null,
        cwd: roots.cwd, scratchDir, session,
        // The adapters' read seat (a coordinator turn with `access: read`): read
        // tools and a read-only shell inside a proved fence, tool-free otherwise.
        supervisorOnly: true, readOnlyTools: true, hygiene: true, fence,
        tooling: { writesCode: false, allowedRoots: [scratchDir, ...roots.roots.map((r) => r.path).filter((p) => p !== roots.cwd)], allowLiveCheckout: true, networkAccess: false },
        cliHome: path.join(dir, 'cli-homes', seat.seat), ledgerDir: path.join(dir, 'ledger'),
        instructions: SEAT_INSTRUCTIONS, prompt, marker: `consult-${tag}`,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        observe: { onOutput: (chunk) => { fs.appendFile(live, JSON.stringify({ seq: seq++, at: clock.iso(), ...chunk }) + NL).catch(() => {}) } },
        meta: { invocationId: `consult-${tag}-${crypto.randomUUID()}`, role: seat.seat, stepId: 'consult' }
      })
      const usage = result.usage ?? null
      const costUsd = typeof usage?.costUsd === 'number' ? usage.costUsd
        : estimateCallCost(usage, seat.model.pricing ?? null, { resumed: Boolean(session), ownUsage: Boolean(session) })?.usd ?? null
      if (reservation) await gate.ledger.settle({ id: reservation, costUsd: costUsd ?? panel.maxTurnCostUsd, meta: { costKnown: costUsd != null } })
      // A seat that ran without its read tools read nothing: not a second opinion.
      if (result.diagnostics?.access !== 'read') return { error: { class: 'environment', message: `the seat had no read access (${result.diagnostics?.fence?.reason ?? result.diagnostics?.access ?? 'fence not proved'})` }, costUsd, usage }
      return { response: String(result.response ?? ''), session: result.session ?? null, usage, costUsd }
    } catch (error) {
      const cancelled = signal?.aborted
      const failure = cancelled ? { class: 'cancelled' } : deadline.aborted ? { class: 'timeout' } : classifyFailure(error)
      // A failed turn that reports its cost is settled at it; one that provably never started is released;
      // anything else stays reserved, the ledger's rule for a charge nobody can state.
      const failedCost = typeof error?.usage?.costUsd === 'number' ? error.usage.costUsd : null
      if (reservation && failedCost != null) await gate.ledger.settle({ id: reservation, costUsd: failedCost, meta: { costKnown: true, failure: failure.class ?? 'runtime' } })
      else if (reservation && error?.started === false) await gate.ledger.release({ id: reservation, reason: `consult ${failure.class ?? 'failure'}: the turn never started` })
      if (failure.class === 'quota' && availability) {
        await availability.recordExhausted({ modelId: seat.model.id, harness: seat.model.harness, reason: `consult: ${error.message}`, retryAfterMs: failure.retryAfterMs ?? null, role: seat.seat }).catch(() => {})
      }
      return { error: { class: failure.class ?? 'runtime', message: cancelled ? 'the consult was cancelled' : deadline.aborted ? `no answer within ${panel.turnTimeoutMinutes} minutes` : String(error.message ?? error).slice(0, 600) }, ...(failedCost != null ? { costUsd: failedCost } : {}) }
    }
  }

  /**
   * One seat's turn of one round, with one repair turn, recorded; a recorded turn is returned as it is.
   * @returns { seat, model, effort, opinion | null, error?, session, costUsd, durationMs }
   */
  async function seatTurn ({ seat, round, prompt, session, options, brief, dir, roots, panel, signal }) {
    const base = path.join(dir, `round-${round}`, seat.seat)
    const recorded = await readJson(`${base}.turn.json`)
    if (recorded) return recorded
    await fs.mkdir(path.dirname(base), { recursive: true })
    await fs.writeFile(`${base}.prompt.md`, prompt)
    const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), `devpanel-consult-${seat.seat}-`))
    const started = clock.now()
    const turn = { seat: seat.seat, model: seat.model.id, effort: seat.effort, round, opinion: null, session: session ?? null, costUsd: null, costUnknown: false, startedAt: clock.iso() }
    const add = (r) => { if (typeof r.costUsd === 'number') turn.costUsd = (turn.costUsd ?? 0) + r.costUsd; else turn.costUnknown = true }
    try {
      let reply = await invoke({ seat, prompt, session, dir, roots, scratchDir, panel, signal, tag: `r${round}-${seat.seat}` })
      add(reply)
      if (!reply.error) {
        await fs.writeFile(`${base}.response.md`, reply.response)
        turn.session = reply.session
        let read = await readOpinion(reply.response, { options, brief })
        if (read.problem && !signal?.aborted) {
          reply = await invoke({ seat, prompt: repairPrompt(read.problem), session: reply.session, dir, roots, scratchDir, panel, signal, tag: `r${round}-${seat.seat}-repair` })
          add(reply)
          if (!reply.error) {
            await fs.writeFile(`${base}.repair.response.md`, reply.response)
            turn.session = reply.session
            read = await readOpinion(reply.response, { options, brief })
          }
        }
        if (reply.error) turn.error = reply.error
        else if (read.problem) turn.error = { class: 'contract-violation', message: read.problem }
        else turn.opinion = read.opinion
      } else turn.error = reply.error
    } finally {
      await fs.rm(scratchDir, { recursive: true, force: true })
    }
    turn.durationMs = clock.now() - started
    // A cancelled turn is not an answer about the question: it is asked again when the caller resumes.
    if (turn.error?.class !== 'cancelled') await writeJson(`${base}.turn.json`, turn)
    return turn
  }

  /** Consults in flight in this process, by their record directory. */
  const running = new Map()

  const summary = (turns) => turns.map((t) => ({
    seat: t.seat, model: t.model, effort: t.effort, round: t.round,
    ...(t.opinion ? { verdict: t.opinion.verdict, choice: t.opinion.choice ?? null, answer: t.opinion.answer ?? null, conditions: t.opinion.conditions ?? [], confidence: t.opinion.confidence, reasoning: t.opinion.reasoning, evidence: t.opinion.evidence ?? [], ownerReason: t.opinion.ownerReason ?? null } : { error: t.error })
  }))

  return {
    /** The panel as configured now, or null. */
    panel: loadPanelConfig,

    /** A recorded result for this request, or null: what a caller reads before deciding whether to ask. */
    async recorded (request, { callerDir }) {
      return readJson(path.join(callerDir, 'consults', consultId(request), 'result.json'))
    },

    /**
     * @param request   { key, mode: 'decide' | 'brief', question, reason?, recommendation?, options?, category?, askedBy?, project, issueDir?, worktree? }
     * @param callerDir where the caller keeps its records (a run's directory, the supervisor's)
     * @returns { id, outcome: 'resolved' | 'escalated' | 'unavailable', answer?, answerText?, choice?, conditions?, opinions, brief?, reason?, rounds, costUsd, costUnknown, durationMs, replayed }
     */
    async consult (request, options = {}) {
      const { callerDir } = options
      if (!callerDir || !path.isAbsolute(callerDir)) throw new Error('a consult needs an absolute directory to be recorded in')
      if (typeof request?.question !== 'string' || !request.question.trim()) throw new Error('a consult needs a question')
      if (!request.project) throw new Error('a consult names the project it concerns')
      // Two callers with the same question share one consult: the second waits for
      // the first and reads its record, instead of running the seats over each
      // other's files. (One panel process per installation; the command line
      // records under another caller key.)
      const dir = path.join(callerDir, 'consults', consultId({ ...request, mode: request.mode === 'brief' ? 'brief' : 'decide' }))
      while (running.has(dir)) await running.get(dir).catch(() => {})
      const mine = this.consultOnce(request, options).finally(() => running.delete(dir))
      running.set(dir, mine)
      return mine
    },

    async consultOnce (request, { callerDir, signal = null } = {}) {
      const mode = request.mode === 'brief' ? 'brief' : 'decide'
      const id = consultId({ ...request, mode })
      const dir = path.join(callerDir, 'consults', id)
      const existing = await readJson(path.join(dir, 'result.json'))
      if (existing) return { ...existing, replayed: true }

      const started = clock.now()
      const base = { id, mode, key: request.key ?? null, question: request.question, project: request.project, askedAt: clock.iso() }
      const turns = []
      const finish = async (result, { record = true } = {}) => {
        const priced = turns.filter((t) => typeof t.costUsd === 'number')
        const full = { ...base, ...result, opinions: summary(turns), rounds: Math.max(0, ...turns.map((t) => t.round)),
          costUsd: priced.length ? priced.reduce((s, t) => s + t.costUsd, 0) : null, costUnknown: turns.some((t) => t.costUnknown),
          durationMs: clock.now() - started, recordedAt: clock.iso() }
        if (record) await writeJson(path.join(dir, 'result.json'), full)
        return { ...full, replayed: false }
      }
      const unavailable = (reason, options) => finish({ outcome: 'unavailable', reason }, options)

      // Nothing configured, or switched off: the question goes on as it did before
      // the panel existed, and is not recorded, so enabling the panel later asks it.
      let panel
      try { panel = await loadPanelConfig() } catch (error) { return unavailable(`the panel's configuration is invalid: ${error.message}`, { record: false }) }
      if (!panel) return unavailable('no consult panel is configured', { record: false })
      if (!panel.enabled) return unavailable('the consult panel is switched off', { record: false })

      await fs.mkdir(dir, { recursive: true })
      if (!await readJson(path.join(dir, 'request.json'))) await writeJson(path.join(dir, 'request.json'), { ...request, mode, id, panel: { hash: panel.hash, seats: panel.seats } })

      const { seats, problems } = await resolveSeats(panel, { roster: await loadRoster(), availability })
      const needed = mode === 'brief' ? seats.filter((s) => s.seat === 'consultant-1') : seats
      if (mode === 'brief' ? !needed.length : problems.length) return unavailable(problems.join('; '))

      let roots
      try {
        roots = await rootsFor({ project: request.project, issueDir: request.issueDir ?? null, worktree: request.worktree ?? null, related: await relatedOf(request.project), panel })
      } catch (error) { return unavailable(error.message) }
      if (roots.refused?.length) await writeJson(path.join(dir, 'roots.json'), { granted: roots.roots, masks: roots.masks, refused: roots.refused })

      let options = optionsFor(request)
      const common = { dir, roots, panel, signal }
      const scratchNote = 'a temporary directory named in your environment as DEVPANEL_SCRATCH_DIR'
      const promptArgs = { request, roots: roots.roots, scratchDir: scratchNote, language: language() }

      if (mode === 'brief') {
        const turn = await seatTurn({ ...common, seat: needed[0], round: 1, prompt: briefPrompt({ ...promptArgs, options }), session: null, options, brief: true })
        turns.push(turn)
        if (signal?.aborted) throw Object.assign(new Error('the consult was cancelled'), { name: 'AbortError' })
        if (!turn.opinion) return unavailable(`${turn.seat}: ${turn.error?.message ?? 'no opinion'}`)
        return finish({ outcome: 'escalated', reason: 'reserved to a person', brief: briefFor([turn], 'the decision is reserved to a person') })
      }

      let previous = null
      for (let round = 1; round <= panel.maxRounds; round++) {
        const current = await Promise.all(needed.map((seat) => {
          const mine = previous?.find((t) => t.seat === seat.seat)
          const other = previous?.find((t) => t.seat !== seat.seat)
          const prompt = round === 1 ? decidePrompt({ ...promptArgs, options }) : reconcilePrompt({ options, other, language: language() })
          return seatTurn({ ...common, seat, round, prompt, session: mine?.session ?? null, options, brief: false })
        }))
        turns.push(...current)
        if (signal?.aborted) throw Object.assign(new Error('the consult was cancelled'), { name: 'AbortError' })
        const verdict = judge(options, current)
        if (verdict.outcome === 'resolved') return finish({ outcome: 'resolved', choice: verdict.choice, answer: verdict.answer, conditions: verdict.conditions, answerText: answerText(verdict) })
        if (verdict.outcome === 'unavailable') return unavailable(`${verdict.why}: ${current.filter((t) => !t.opinion).map((t) => `${t.seat}: ${t.error?.message}`).join('; ')}`)
        if (verdict.outcome === 'escalated' || round === panel.maxRounds) {
          return finish({ outcome: 'escalated', reason: verdict.why, brief: briefFor(current, verdict.why) })
        }
        options = nextOptions(options, current)
        previous = current
      }
      return unavailable('the panel allows no round')
    }
  }
}
