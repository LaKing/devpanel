import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { Ajv2020 } from 'ajv/dist/2020.js'

import { interpret } from './questions.mjs'
import { DecisionError } from './jev.mjs'
import { hostConfigDir } from '../config/host-config.mjs'

/*
 * Advisory decisions: typed questions to a cheap classifier, recorded before
 * anyone acts on them.
 *
 * This is NOT a harness and not a seat. A decision provider cannot read the
 * repository, run anything or write anything; it looks at the state it is handed
 * and returns probabilities. Callers use it to route (skip a step, suggest a
 * priority, defer a wake) and fall back to exactly what they did before whenever
 * it is not confident enough or not there. It is never asked about approvals,
 * closure, dispositions or anything bound to a fingerprint.
 *
 * Three rules this file exists to hold:
 *
 *  - **Recorded before acted on.** Every ask ends in a record on disk — an answer
 *    or an unavailability — before `ask()` returns. The same question about the
 *    same state is answered from that record forever after, so a replay after a
 *    crash takes the same branch it took the first time and never asks again.
 *  - **The threshold is applied once, at recording.** `confident` is stored, not
 *    re-derived, so tuning the threshold later changes future decisions, never
 *    the reading of past ones.
 *  - **Money on the ledger.** When a spending ledger is given, each ask reserves
 *    the configured per-call ceiling first and settles usage × price after. A
 *    refusal the provider could not have charged for is released; one whose
 *    charge is unknown stays committed, as every other uncertain spend does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CONFIG_ROOT = process.env.DEVPANEL_CONFIG_ROOT ?? path.resolve(HERE, '..', '..', '..')
const PURPOSE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * decisions/<name>: the host config's copy when it has one (host-config/decisions/,
 * docs/host-config.md), else the tracked one. Which provider is active and how it
 * is reached are this installation's choices, so they can be made without editing
 * the tracked files.
 */
async function readDecisionsFile (root, name) {
  const hostDir = hostConfigDir({ root })
  try { return await fs.readFile(path.join(hostDir, 'decisions', name), 'utf8') } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
  }
  return fs.readFile(path.join(root, 'decisions', name), 'utf8')
}

/** Sorted keys, so the same question about the same state has one key however it was built. */
export function canonical (value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

export const DEFAULT_DECISION_PROVIDER = 'jev'
const PROVIDER_ID = /^[a-z0-9-]+$/

/**
 * Which provider is active: `provider: <id>` in decisions/active.yaml, else Jev.
 * One file names one id, so exactly one provider is active at a time. A file
 * that names nothing usable throws, rather than quietly meaning Jev.
 */
export async function activeDecisionProviderId ({ root = CONFIG_ROOT } = {}) {
  let text
  try { text = await readDecisionsFile(root, 'active.yaml') } catch (error) {
    if (error.code === 'ENOENT') return { id: DEFAULT_DECISION_PROVIDER, selected: false }
    throw error
  }
  const parsed = YAML.parse(text)
  if (parsed == null) return { id: DEFAULT_DECISION_PROVIDER, selected: false }
  const extra = typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).filter((k) => k !== 'provider') : null
  if (!extra || extra.length || typeof parsed.provider !== 'string' || !PROVIDER_ID.test(parsed.provider)) {
    throw Object.assign(new Error('decisions/active.yaml must hold only "provider: <id>", naming decisions/<id>.yaml'), { provider: null })
  }
  return { id: parsed.provider, selected: true }
}

/**
 * decisions/<id>.yaml, schema-checked; with no id, the active one. Absent means
 * the provider is not configured (null), which callers treat exactly as
 * "unavailable" — unless decisions/active.yaml selected it by name, which
 * throws: an operator who chose a provider must see that it is missing, not be
 * switched off or back to Jev silently. Present but invalid throws too: a broken
 * configuration is an operator's problem to see. A thrown error names the
 * provider it concerns as `error.provider`.
 */
export async function loadDecisionProvider ({ id = null, root = CONFIG_ROOT } = {}) {
  let selected = false
  if (id == null) ({ id, selected } = await activeDecisionProviderId({ root }))
  const fail = (message) => Object.assign(new Error(message), { provider: id })
  let text
  try { text = await readDecisionsFile(root, `${id}.yaml`) } catch (error) {
    if (error.code === 'ENOENT') {
      if (selected) throw fail(`decisions/active.yaml selects "${id}", but decisions/${id}.yaml does not exist`)
      return null
    }
    throw error
  }
  const config = YAML.parse(text)
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(JSON.parse(await fs.readFile(path.join(root, 'schemas', 'decision-provider.schema.json'), 'utf8')))
  if (!validate(config)) {
    const detail = validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
    throw fail(`decisions/${id}.yaml is invalid: ${detail}`)
  }
  if (config.id !== id) throw fail(`decisions/${id}.yaml declares id "${config.id}"; the file name is the identity`)
  return { ...config, kind: config.kind ?? 'jev', hash: sha256(text) }
}

/** What a provider's usage cost, in dollars, from the configured price. Null when it reported none. */
export function costOf (usage, pricing) {
  if (!usage || !pricing || !Number.isInteger(usage.input_tokens)) return null
  const output = Number.isInteger(usage.output_tokens) ? usage.output_tokens : 0
  return (usage.input_tokens * pricing.inputUsdPerMillionTokens + output * pricing.outputUsdPerMillionTokens) / 1e6
}

/**
 * The interpretation of one question when it may be acted on; null when it may
 * not — unavailable, not asked, or below the threshold. Callers branch on this
 * and nothing else.
 */
export function confidentAnswer (record, questionId) {
  if (record?.status !== 'answered') return null
  const d = record.decisions?.[questionId]
  return d?.confident ? d : null
}

async function readRecord (file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Publish a record exactly once. A hard link of a fully written temp file cannot
 * be observed half-written, and fails when the name exists — so of two writers
 * (two processes, or a crash and its replay) the first wins and the second reads
 * what the first decided.
 */
async function publish (file, record) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  try {
    await fs.link(temp, file)
    return { record, won: true }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return { record: await readRecord(file), won: false }
  } finally {
    await fs.rm(temp, { force: true })
  }
}

/**
 * @param oracle   { id, model, ask({ state, questions, signal }) } — oracleFor(config) (advisor.mjs), or a fake
 * @param config   the loaded provider configuration (threshold, pricing, maxCallCostUsd)
 * @param ledger   optional spending ledger (runtime/ledger.mjs), already loaded
 * @param admit    optional ({ subject, maxCostUsd }) => { ok, limit?, detail? }; a refusal is recorded as unavailability
 */
export function createDecisions ({ oracle, config, ledger = null, admit = null, clock = { iso: () => new Date().toISOString() } }) {
  const pending = new Map()

  async function askOnce ({ dir, purpose, subject, state, questions, signal, retryUnavailable = false }) {
    const key = sha256(canonical({ provider: config.id, model: config.model, purpose, state, questions }))
    const file = path.join(dir, `${purpose}-${key.slice(0, 16)}.json`)

    const existing = await readRecord(file)
    // A failed ask is asked again only when someone asks for it on purpose; it
    // is kept beside the new one (a name the record listings skip) as history.
    if (existing && retryUnavailable && existing.status === 'unavailable') {
      await fs.rename(file, file.replace(/\.json$/, `.failed-${Date.now()}.json`)).catch((error) => { if (error.code !== 'ENOENT') throw error })
    } else if (existing) return { ...existing, replayed: true }

    const base = {
      version: 1,
      key,
      purpose,
      subject: subject ?? null,
      provider: config.id,
      configHash: config.hash ?? null,
      requestedModel: config.model,
      threshold: config.threshold,
      askedAt: clock.iso(),
      questions,
      state
    }

    let record
    const unavailable = (failure, extra = {}) => ({ ...base, ...extra, status: 'unavailable', recordedAt: clock.iso(), decisions: null, failure })

    const verdict = admit ? admit({ subject: 'decision', maxCostUsd: config.maxCallCostUsd }) : { ok: true }
    if (!verdict.ok) {
      record = unavailable({ class: 'spending-refused', message: verdict.detail ?? verdict.limit ?? 'refused', charged: 'no' })
    } else {
      const reservation = ledger ? `decision-${key.slice(0, 16)}-${crypto.randomUUID()}` : null
      if (ledger) await ledger.reserve({ id: reservation, subject: 'decision', maxCostUsd: config.maxCallCostUsd, meta: { purpose, provider: config.id } })
      try {
        const answer = await oracle.ask({ state, questions, signal })
        // A model asked through its CLI reports dollars; a provider reports tokens to price.
        const costUsd = answer.costUsd !== undefined ? answer.costUsd : costOf(answer.usage, config.pricing)
        // A response without usage cost something nobody can say; the ceiling is
        // what was reserved for it, so that is what the window keeps.
        if (ledger) await ledger.settle({ id: reservation, costUsd: costUsd ?? config.maxCallCostUsd, meta: { costKnown: costUsd != null } })
        const decisions = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, interpret(q, answer.answers[id], config.threshold)]))
        record = {
          ...base,
          status: 'answered',
          recordedAt: clock.iso(),
          model: answer.model,
          answers: answer.answers,
          decisions,
          usage: answer.usage ?? null,
          costUsd,
          attempts: answer.attempts,
          latencyMs: answer.latencyMs,
          ledger: reservation ? { id: reservation, state: 'settled' } : null
        }
      } catch (error) {
        if (!(error instanceof DecisionError)) throw error
        let ledgerState = null
        if (ledger) {
          if (error.charged === 'no') {
            await ledger.release({ id: reservation, reason: `${config.id} ${error.class}: not charged` })
            ledgerState = 'released'
          } else if (error.charged === 'yes') {
            const costUsd = costOf(error.usage, config.pricing)
            await ledger.settle({ id: reservation, costUsd: costUsd ?? config.maxCallCostUsd, meta: { costKnown: costUsd != null, failure: error.class } })
            ledgerState = 'settled'
          } else {
            ledgerState = 'outstanding'
          }
        }
        record = unavailable(
          { class: error.class, message: error.message, status: error.status, charged: error.charged, attempts: error.attempts, retryAfterMs: error.retryAfterMs ?? null },
          { model: error.model ?? null, usage: error.usage ?? null, ledger: reservation ? { id: reservation, state: ledgerState } : null }
        )
      }
    }

    const { record: kept, won } = await publish(file, record)
    return won ? { ...kept, replayed: false } : { ...kept, replayed: true }
  }

  return {
    provider: config.id,

    /**
     * Ask, or read back what was asked before.
     *
     * @param dir       where this subject's decisions live (an issue's or a run's `decisions/`)
     * @param purpose   what the decision is for, e.g. `triage-pregate`; part of the key and the file name
     * @param subject   what it concerns (an issue id, a run id), for the record
     * @returns the record; `confidentAnswer(record, id)` is what may be acted on
     */
    async ask ({ dir, purpose, subject = null, state, questions, signal = null, retryUnavailable = false }) {
      if (!dir || !path.isAbsolute(dir)) throw new Error('decisions need an absolute directory to be recorded in')
      if (!PURPOSE.test(purpose ?? '')) throw new Error('purpose must be lower-case letters, digits and "-"')
      // Concurrent asks of the same question in one process share one call.
      const id = `${dir}\u0000${sha256(canonical({ purpose, state, questions }))}`
      if (!pending.has(id)) {
        pending.set(id, askOnce({ dir, purpose, subject, state, questions, signal, retryUnavailable }).finally(() => pending.delete(id)))
      }
      return pending.get(id)
    }
  }
}
