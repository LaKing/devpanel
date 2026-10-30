import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { DecisionError } from './jev.mjs'
import { checkAnswers } from './questions.mjs'
import { bareObjects, fencedObjects } from '../runtime/structured-output.mjs'
import { classifyFailure } from '../runtime/failure.mjs'
import { runlessFence } from '../../../harness/fence.mjs'

/*
 * A roster model as a decision oracle: the same typed questions Jev answers,
 * put to any model the panel can run, at any effort it supports.
 *
 * One tool-free turn in a throwaway directory (the adapters' `supervisorOnly`
 * mode: no tools, no MCP, no project files), asked to reply with the answers
 * as JSON in the provider's own shape. The reply is untrusted exactly as a
 * provider response is: it must parse, and pass checkAnswers against the
 * questions asked, or the ask is a contract violation.
 *
 * Two things a model routinely gets slightly wrong are normalised rather than
 * failed: probabilities that do not quite sum to one are rescaled, and a
 * stated choice that is not its own most probable option is replaced by that
 * option — the distribution is the answer, the label a summary of it. A
 * missing confidence is the top probability, and says so.
 */

const HARNESS_DIR = () => process.env.DEVPANEL_HARNESS_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'harness')

const FORMAT = {
  choice: '{"type":"choice","choice":"<one option name>","probabilities":{"<each option>":<0..1>},"confidence":<0..1>}',
  score: '{"type":"score","score":<weighted level 0..n-1>,"probabilities":{"0":<0..1>,"1":<0..1>,...},"confidence":<0..1>}',
  noul: '{"type":"noul","noul":<probability that the answer is true, 0..1>}'
}

export function promptFor ({ state, questions }) {
  const lines = [
    'You are an advisory classifier. Read the issue below and answer each typed question about it.',
    'Do not use tools, read files or ask anything back. Reply with ONE JSON object and nothing else:',
    '{"answers": {"<question id>": <answer>, ...}}',
    '',
    'Answer formats, by question type:',
    ...Object.entries(FORMAT).map(([type, f]) => `- ${type}: ${f}`),
    '',
    'Probabilities use only the option names offered (for a score, the level indexes as strings) and sum to 1.',
    'List only options you consider possible; any option you leave out counts as probability 0.',
    'Confidence is how sure you are of the chosen option, from 0 to 1. Be calibrated: say 0.9 only when you would be wrong',
    'about one time in ten.',
    '',
    '## Questions',
    '```json',
    JSON.stringify(questions, null, 2),
    '```',
    '',
    '## The issue',
    '```json',
    JSON.stringify(state, null, 2),
    '```'
  ]
  return lines.join('\n')
}

function normalise (questions, answers) {
  const out = {}
  for (const [id, q] of Object.entries(questions)) {
    const a = answers?.[id]
    if (!a || typeof a !== 'object') { out[id] = a; continue }
    if (q.type === 'noul') { out[id] = { type: 'noul', noul: Number(a.noul) }; continue }
    // A model lists the options it thinks possible; an omitted option is 0.
    // (One it invents is kept, and checkAnswers refuses it.)
    const offered = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    const probs = Object.fromEntries(offered.map((k) => [k, 0]))
    for (const [k, v] of Object.entries(a.probabilities ?? {})) probs[k] = Number(v) || 0
    // Only a label and no distribution: the label, with certainty it did not quantify.
    if (!Object.values(probs).some((v) => v > 0) && q.type === 'choice' && offered.includes(a.choice)) probs[a.choice] = 1
    const sum = Object.values(probs).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0)
    if (sum > 0) for (const k of Object.keys(probs)) probs[k] = probs[k] / sum
    const top = Object.entries(probs).filter(([k]) => offered.includes(k)).reduce((best, cur) => (cur[1] > best[1] ? cur : best), [null, -1])
    const confidence = Number.isFinite(Number(a.confidence)) ? Math.min(1, Math.max(0, Number(a.confidence))) : top[1]
    if (q.type === 'choice') {
      out[id] = { type: 'choice', choice: top[0] ?? a.choice, probabilities: probs, confidence }
    } else {
      const score = Object.entries(probs).reduce((s, [k, p]) => s + Number(k) * p, 0)
      out[id] = { type: 'score', score, probabilities: probs, confidence }
    }
  }
  return out
}

/**
 * @param model   a roster entry (config/load.mjs)
 * @param effort  one of model.efforts, or null for the model's default
 */
export function createModelOracle ({ model, effort = null, loadAdapter = (harness) => import(pathToFileURL(path.join(HARNESS_DIR(), `${harness}.mjs`)).href), timeoutMs = 180000, now = () => Date.now() }) {
  const label = `${model.id}${effort ? `@${effort}` : ''}`
  return {
    id: `model:${model.id}`,
    model: label,
    async ask ({ state, questions, signal = null }) {
      const started = now()
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-assess-'))
      const deadline = AbortSignal.timeout(timeoutMs)
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
      let result
      try {
        const adapter = await loadAdapter(model.harness)
        const cwd = path.join(temp, 'workspace')
        const scratchDir = path.join(temp, 'scratch')
        await fs.mkdir(cwd); await fs.mkdir(scratchDir)
        result = await adapter.invoke({
          model: model.model, effort: effort ?? model.defaultEffort ?? null, profile: model.profile ?? 'default',
          endpointRef: model.endpointRef ?? null, credentialRef: model.credentialRef ?? null, account: model.account ?? null,
          cwd, scratchDir, session: null, supervisorOnly: true, hygiene: true, fence: runlessFence({ cwd, writable: [scratchDir] }), signal: combined,
          prompt: promptFor({ state, questions }),
          meta: { invocationId: `assess-${crypto.randomUUID()}`, role: 'assessor' }
        })
      } catch (error) {
        if (signal?.aborted) throw new DecisionError('cancelled', 'the ask was cancelled', { attempts: 1, model: label })
        if (deadline.aborted) throw new DecisionError('timeout', `no answer within ${timeoutMs / 1000} s`, { attempts: 1, charged: 'unknown', model: label })
        const failure = classifyFailure(error)
        const cls = failure.class === 'quota' ? 'rate-limit' : failure.class === 'auth' ? 'auth' : ['rate-limit', 'transient'].includes(failure.class) ? failure.class : 'transient'
        throw new DecisionError(cls, `${model.id} could not be asked (${failure.class ?? 'runtime'})`, { attempts: 1, charged: 'unknown', model: label })
      } finally {
        await fs.rm(temp, { recursive: true, force: true })
      }
      const usage = result.usage ?? null
      const costUsd = typeof usage?.costUsd === 'number' ? usage.costUsd : null
      const text = String(result.response ?? '')
      const candidates = [...fencedObjects(text), ...bareObjects(text)].map((c) => c.value).filter((v) => v && typeof v.answers === 'object')
      if (!candidates.length) {
        throw new DecisionError('contract-violation', 'the reply held no {"answers": …} object', { charged: 'yes', attempts: 1, usage, model: label })
      }
      const answers = normalise(questions, candidates.at(-1).answers)
      const violations = checkAnswers(questions, answers)
      if (violations.length) {
        throw new DecisionError('contract-violation', violations.join('; '), { charged: 'yes', attempts: 1, usage, model: label })
      }
      return { model: label, answers, usage, costUsd, attempts: 1, latencyMs: now() - started }
    }
  }
}

/**
 * A decision provider of `kind: model` (decisions/<id>.yaml): the roster model
 * it names, asked through its CLI as above, so a host whose only access is a
 * logged-in CLI (a subscription) can still have a provider. The roster entry is
 * resolved at the first ask and must be verified, as the Assess bar requires.
 */
export function createRosterModelOracle ({ config, loadRoster = async () => (await import('../config/load.mjs')).loadConfig().then((c) => c.roster), ...options }) {
  let oracle = null
  return {
    id: `model:${config.model}`,
    model: `${config.model}${config.effort ? `@${config.effort}` : ''}`,
    async ask (args) {
      if (!oracle) {
        const model = (await loadRoster()).get(config.model)
        if (!model) throw new DecisionError('configuration', `decisions/${config.id}.yaml names roster model "${config.model}", which is not in the roster`, { attempts: 0, charged: 'no' })
        if (model.verification?.status !== 'verified') throw new DecisionError('configuration', `${model.id} is not verified; a decision provider may name only a verified roster model`, { attempts: 0, charged: 'no' })
        oracle = createModelOracle({ model, effort: config.effort ?? null, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}), ...options })
      }
      return oracle.ask(args)
    }
  }
}
