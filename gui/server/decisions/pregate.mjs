import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { confidentAnswer } from './index.mjs'
import { PURPOSE, HOLD_STEP, triageRequest } from './triage-shadow.mjs'

/*
 * Triage pre-gate (rollout step 3 of docs/decisions.md).
 *
 * Before a Triage run starts, the decision provider is asked about the issue.
 * Its answer is recorded under the issue (`<issue>/decisions/`) and hard-linked
 * into the run it preceded, where the agreement report reads it.
 *
 * What it may change, and only when the answer is at or above the threshold:
 *
 *  - A confident `close-issue` or `needs-input` HOLDS the Triage start. The
 *    refusal carries proposals. Only an operator resolves a hold: by confirming
 *    a proposal, or by starting anyway with a stated reason. The top-level
 *    supervisor is not an operator and has no override.
 *  - Every confident answer becomes a proposal on the issue page. Nothing is
 *    applied until an operator confirms it, and a confirmation is written down
 *    with the decision record it rests on.
 *
 * Below the threshold, unavailable, or not configured: the start proceeds
 * exactly as it did before, and there is nothing to propose.
 */

export const OVERRIDE_REASON_MAX = 500

export class PregateHold extends Error {
  constructor (record, proposals) {
    const gate = record.decisions.gate
    super(`The decision provider judged this issue "${gate.value}" at confidence ${gate.confidence.toFixed(2)} (threshold ${gate.threshold}), so Triage was not started. An operator can confirm a proposal on the issue page, or start anyway with a reason.`)
    this.name = 'PregateHold'
    // For the caller that overrides; not part of what a refusal reports.
    Object.defineProperty(this, 'record', { value: record, enumerable: false })
    Object.assign(this, {
      status: 409,
      code: 'PREGATE_HOLD',
      started: false,
      retryable: false,
      resolvableBy: 'operator',
      pregate: { key: record.key, gate: gate.value, confidence: gate.confidence, threshold: gate.threshold, proposals }
    })
  }
}

const decisionsDir = (issuePath) => path.join(issuePath, 'decisions')
const recordFile = (issuePath, key) => path.join(decisionsDir(issuePath), `${PURPOSE}-${key.slice(0, 16)}.json`)

const readJson = async (file) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Write a file once; a second writer of the same name gets the first one's content. */
async function writeOnce (file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  try {
    await fs.link(temp, file)
    return { value, won: true }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return { value: await readJson(file), won: false }
  } finally {
    await fs.rm(temp, { force: true })
  }
}

const describe = (d) => `${d.value} (confidence ${d.confidence.toFixed(2)}, threshold ${d.threshold})`

/**
 * What an operator could confirm, from the confident answers only.
 * A priority is proposed only while nobody has set one: a person's ordering is
 * not something a classifier is invited to overrule.
 */
export function proposalsOf (record, issue) {
  if (record?.status !== 'answered') return []
  const out = []
  const gate = confidentAnswer(record, 'gate')
  const duplicate = confidentAnswer(record, 'duplicateOf')
  if (duplicate && duplicate.value !== 'none') {
    out.push({
      id: 'close-duplicate',
      title: `Close as a duplicate of ${duplicate.value}`,
      effect: { disposition: 'duplicate', duplicateOf: duplicate.value },
      basis: { duplicateOf: describe(duplicate), ...(gate ? { gate: describe(gate) } : {}) }
    })
  }
  if (gate?.value === 'close-issue' && !out.length) {
    out.push({
      id: 'close',
      title: 'Close without a run: invalid, out of scope, or no change needed',
      effect: { disposition: 'not-resolved' },
      basis: { gate: describe(gate) }
    })
  }
  if (gate?.value === 'needs-input') {
    out.push({
      id: 'needs-input',
      title: 'Hold for more information before Triage',
      effect: { note: HOLD_STEP },
      basis: { gate: describe(gate) }
    })
  }
  const priority = confidentAnswer(record, 'priority')
  if (priority && !issue?.priority) {
    out.push({ id: 'priority', title: `Set priority to ${priority.value}`, effect: { priority: priority.value }, basis: { priority: describe(priority) } })
  }
  const playbook = confidentAnswer(record, 'playbook')
  if (playbook) {
    // Advisory only: it preselects the start dialog, and starting is the confirmation.
    out.push({ id: 'playbook', title: `Suggested playbook: ${playbook.value}`, effect: { playbook: playbook.value }, basis: { playbook: describe(playbook) }, confirmable: false })
  }
  return out.map((p) => ({ confirmable: true, ...p }))
}

/**
 * @param issues   the issues store
 * @param advisor  decisions/advisor.mjs
 * @param deadlineMs  how long a start waits for the provider before proceeding without it
 */
export function createPregate ({ issues, advisor, deadlineMs = 15000, clock = { iso: () => new Date().toISOString() } }) {
  /** `using` names a roster model (and effort) to ask instead of the provider. */
  async function assess ({ project, issueId, signal = null, using = null, retryUnavailable = false }) {
    const issue = await issues.getIssue(project, issueId)
    const { state, questions } = await triageRequest({ issues, project, issueId })
    const args = { dir: decisionsDir(issue.path), purpose: PURPOSE, subject: { project, issueId }, state, questions, signal, retryUnavailable }
    const record = using?.model ? await advisor.askModel({ ...args, model: using.model, effort: using.effort ?? null }) : await advisor.ask(args)
    return { issue, record }
  }

  /** The recorded assessments of this issue, newest first, with their proposals and confirmations; asks nothing. */
  async function latest ({ project, issueId }) {
    const issue = await issues.getIssue(project, issueId)
    let names = []
    try { names = await fs.readdir(decisionsDir(issue.path)) } catch { names = [] }
    const records = []
    for (const name of names.filter((n) => n.startsWith(`${PURPOSE}-`) && /^[^.]+\.json$/.test(n))) {
      const r = await readJson(path.join(decisionsDir(issue.path), name))
      if (r) records.push(r)
    }
    records.sort((a, b) => ((a.recordedAt ?? '') < (b.recordedAt ?? '') ? 1 : -1))
    const record = records[0] ?? null
    // Every assessment, newest first — by the provider and by any models asked —
    // each with what it alone could propose and what of that was confirmed.
    const assessments = []
    for (const r of records) assessments.push({ record: r, proposals: proposalsOf(r, issue), confirmations: await confirmationsOf(issue.path, r.key) })
    return {
      record,
      proposals: proposalsOf(record, issue),
      confirmations: record ? await confirmationsOf(issue.path, record.key) : [],
      history: records.length,
      assessments
    }
  }

  async function confirmationsOf (issuePath, key) {
    let names = []
    try { names = await fs.readdir(decisionsDir(issuePath)) } catch { return [] }
    const prefix = `${PURPOSE}-${key.slice(0, 16)}.confirm-`
    const out = []
    for (const n of names.filter((x) => x.startsWith(prefix) && x.endsWith('.json'))) out.push(await readJson(path.join(decisionsDir(issuePath), n)))
    return out.filter(Boolean)
  }

  /**
   * The decision a Triage start would meet now, asking nobody: the same key check() would record
   * under, and whether its record holds. Read before "Start anyway" is sent, so a hold that changed
   * (a note added, another provider, no record yet) is caught before the request.
   */
  async function current ({ project, issueId }) {
    const issue = await issues.getIssue(project, issueId)
    const { state, questions } = await triageRequest({ issues, project, issueId })
    const k = await advisor.currentKey({ purpose: PURPOSE, state, questions })
    if (!k.configured) return { configured: false, holds: false, reason: 'not-configured' }
    if (k.held) return { configured: true, holds: false, reason: 'provider-held' }
    const record = await readJson(recordFile(issue.path, k.key))
    if (!record) return { configured: true, key: k.key, recorded: false, holds: null, reason: 'not-asked' }
    const gate = confidentAnswer(record, 'gate')
    return { configured: true, key: k.key, recorded: true, holds: Boolean(gate && ['close-issue', 'needs-input'].includes(gate.value)), gate: gate?.value ?? null }
  }

  return {
    PURPOSE,
    current,
    // Asked for by someone on purpose: a failed earlier ask is asked again.
    // The gate before a Triage start (check) never re-asks.
    assess: async (args) => (await assess({ ...args, retryUnavailable: true })).record,
    latest,

    /**
     * The gate a Triage start passes through. Resolves the record (or skip) the
     * start went ahead on; throws PregateHold when a confident answer holds it.
     * A slow provider is abandoned at the deadline and the start proceeds.
     */
    async check ({ project, issueId }) {
      const signal = AbortSignal.timeout(deadlineMs)
      let result
      try { result = await assess({ project, issueId, signal }) } catch (error) {
        return { skipped: 'error', message: error.message }
      }
      const { issue, record } = result
      const gate = confidentAnswer(record, 'gate')
      if (gate && ['close-issue', 'needs-input'].includes(gate.value)) throw new PregateHold(record, proposalsOf(record, issue))
      return record
    },

    /**
     * Put the record a run started on beside the run, where the agreement report
     * reads it: a hard link, so it is the same bytes and costs nothing. An
     * override is written there too, naming who overrode what and why.
     */
    async attach ({ issuePath, runId, record, override = null }) {
      if (!record?.key) return null
      const dir = path.join(issuePath, 'runs', runId, 'decisions')
      await fs.mkdir(dir, { recursive: true })
      const name = `${PURPOSE}-${record.key.slice(0, 16)}.json`
      await fs.link(recordFile(issuePath, record.key), path.join(dir, name)).catch((error) => { if (error.code !== 'EEXIST') throw error })
      if (override) await writeOnce(path.join(dir, 'pregate-override.json'), { key: record.key, ...override })
      return name
    },

    /**
     * Apply one proposal of the record `key`, as the operator. The proposal is
     * recomputed from the record on disk, never taken from the request, so only
     * what the provider confidently answered can be applied.
     */
    async confirm ({ project, issueId, key, proposalId, actor = 'operator' }) {
      const issue = await issues.getIssue(project, issueId)
      if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw Object.assign(new Error('key must be the decision record\'s sha256'), { status: 400 })
      const record = await readJson(recordFile(issue.path, key))
      if (!record || record.key !== key) throw Object.assign(new Error('no such pre-gate decision on this issue'), { status: 404 })
      // Confirmed before: applying it again would double what it did.
      const confirmFile = path.join(decisionsDir(issue.path), `${PURPOSE}-${key.slice(0, 16)}.confirm-${String(proposalId).replace(/[^a-z-]/g, '')}.json`)
      const earlier = await readJson(confirmFile)
      if (earlier) return { confirmation: earlier, applied: false, issue }
      const proposal = proposalsOf(record, issue).find((p) => p.id === proposalId)
      if (!proposal) throw Object.assign(new Error(`the decision does not confidently support "${proposalId}"`), { status: 409 })
      if (!proposal.confirmable) throw Object.assign(new Error(`"${proposalId}" is advisory; it is confirmed by starting that playbook`), { status: 409 })

      const source = `decision ${record.provider} ${record.model ?? record.requestedModel} ${key.slice(0, 16)}`
      const basis = Object.entries(proposal.basis).map(([q, v]) => `${q} ${v}`).join('; ')
      const confirmation = { key, proposalId, effect: proposal.effect, basis: proposal.basis, by: actor, at: clock.iso() }
      const { won, value } = await writeOnce(confirmFile, confirmation)
      if (!won) return { confirmation: value, applied: false, issue: await issues.getIssue(project, issueId) }

      try {
        await apply(proposal, { project, issueId, source, basis, actor })
      } catch (error) {
        // Not applied, so not confirmed: the next attempt must be able to try again.
        await fs.rm(confirmFile, { force: true })
        throw error
      }
      return { confirmation, applied: true, issue: await issues.getIssue(project, issueId) }
    }
  }

  async function apply (proposal, { project, issueId, source, basis, actor }) {
      if (proposal.effect.disposition) {
        const evidence = proposal.effect.duplicateOf
          ? `Duplicate of ${proposal.effect.duplicateOf}. Proposed by ${source} (${basis}); confirmed by ${actor}.`
          : `Closed without a run: judged invalid, out of scope or needing no change. Proposed by ${source} (${basis}); confirmed by ${actor}.`
        await issues.setIssueDisposition(project, issueId, { value: proposal.effect.disposition, evidence, by: 'operator', related: proposal.effect.duplicateOf ? [proposal.effect.duplicateOf] : null })
      } else if (proposal.effect.priority) {
        await issues.setIssuePriority(project, issueId, { value: proposal.effect.priority, reason: `Proposed by ${source} (${basis}); confirmed by ${actor}.`, by: 'operator' })
      } else if (proposal.effect.note) {
        await issues.createStep(project, issueId, {
          name: HOLD_STEP,
          format: 'md',
          text: `# Held before Triage\n\nThe report lacks a fact needed to classify it (${basis}; ${source}; confirmed by ${actor}).\n\nAdd what is missing as a note: what happened, where, how to reproduce it, and what is wanted. The next Triage start assesses the report again.\n`
        })
      }
  }
}
