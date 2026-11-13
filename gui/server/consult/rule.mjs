/*
 * The consult panel's decision rule (docs/consult.md "The rule"), pure.
 *
 * Whether two opinions agree is never a model's reading of two texts: each seat
 * names one of the options it was offered, and agreement is the same key. An
 * answer no option covers (`other`) becomes a named option of the next round
 * (`alt-1`, `alt-2`), which the other seat can then choose.
 */

export const OTHER = 'other'
export const RECOMMENDED = 'recommended'

/** The options of the first round: the asker's recommendation first, then its own closed options. */
export function optionsFor (request) {
  const options = []
  if (request.recommendation) options.push({ key: RECOMMENDED, label: request.recommendation })
  for (const o of request.options ?? []) {
    const key = String(o.key ?? o)
    if ([OTHER, RECOMMENDED].includes(key) || options.some((x) => x.key === key)) continue
    options.push({ key, label: String(o.label ?? o) })
  }
  return options
}

/** The next round's options: the previous ones plus every `other` answer as `alt-<n>`, by seat order. */
export function nextOptions (options, opinions) {
  const out = [...options]
  let n = out.filter((o) => /^alt-\d+$/.test(o.key)).length
  for (const { opinion } of opinions) {
    if (opinion?.verdict !== 'answer' || opinion.choice !== OTHER) continue
    out.push({ key: `alt-${++n}`, label: opinion.answer, conditions: opinion.conditions ?? [] })
  }
  return out
}

/**
 * What one round of opinions settles.
 *
 * @param options   the options that round offered ([{key, label}])
 * @param opinions  [{ seat, opinion }] — a validated opinion per seat, or null for a seat that gave none
 * @returns { outcome: 'resolved', choice, answer, conditions } | { outcome: 'undecided', why }
 *        | { outcome: 'escalated', why } | { outcome: 'unavailable', why }
 */
export function judge (options, opinions) {
  const missing = opinions.filter((o) => !o.opinion)
  if (missing.length) return { outcome: 'unavailable', why: `no usable opinion from ${missing.map((o) => o.seat).join(', ')}` }
  const owner = opinions.filter((o) => o.opinion.verdict === 'owner')
  if (owner.length) return { outcome: 'escalated', why: `${owner.map((o) => o.seat).join(' and ')} left it to a person (${owner.map((o) => o.opinion.ownerReason).join(', ')})` }
  const choices = new Set(opinions.map((o) => o.opinion.choice))
  if (choices.size !== 1) return { outcome: 'undecided', why: `the seats chose differently (${opinions.map((o) => `${o.seat}: ${o.opinion.choice}`).join(', ')})` }
  const [choice] = choices
  if (choice === OTHER) return { outcome: 'undecided', why: 'each seat gave an answer of its own' }
  const option = options.find((o) => o.key === choice)
  if (!option) return { outcome: 'undecided', why: `"${choice}" is not one of the options offered` }
  const low = opinions.filter((o) => o.opinion.confidence === 'low')
  if (low.length) return { outcome: 'undecided', why: `${low.map((o) => o.seat).join(' and ')} agreed with low confidence` }
  const conditions = [...new Set([...(option.conditions ?? []), ...opinions.flatMap((o) => o.opinion.conditions ?? [])])]
  return { outcome: 'resolved', choice, answer: option.label, conditions }
}

/** The answer as later turns read it: the agreed text, then the conditions both seats attached. */
export function answerText ({ answer, conditions = [] }) {
  return conditions.length ? `${answer}\n\nConditions:\n${conditions.map((c) => `- ${c}`).join('\n')}` : answer
}

/**
 * The question as a person gets it when the panel did not decide: the first
 * seat's brief, with each seat's position beside it.
 */
export function briefFor (opinions, why) {
  const first = opinions.find((o) => o.opinion?.ownerBrief)
  if (!first) return null
  return {
    ...first.opinion.ownerBrief,
    by: first.seat,
    positions: opinions.filter((o) => o.opinion).map((o) => ({
      seat: o.seat, verdict: o.opinion.verdict, choice: o.opinion.choice ?? null, answer: o.opinion.answer ?? null,
      confidence: o.opinion.confidence, recommendation: o.opinion.ownerBrief?.recommendation ?? null
    })),
    undecidedBecause: why
  }
}
