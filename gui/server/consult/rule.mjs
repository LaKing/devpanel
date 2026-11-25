/*
 * The consult panel's decision rule (docs/consult.md "The rule"), pure.
 *
 * Whether opinions agree is never a model's reading of the texts: each seat
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
 * What one round of opinions settles. The rule is the same however many seats are occupied: every occupied seat
 * names the same option and none with low confidence. With one seat that is the seat's own answer.
 *
 * After the last round (`last`) seats that still differ are settled by the majority: an option more than half of the
 * seats asked chose with confidence is the decision, and who dissented is named (`dissent`). Two against one decides;
 * one against one, or three different answers, does not.
 * Decision: a seat that says the question is a person's (`owner`: production, irreversible loss, spending, a written
 * rule, product intent) is never outvoted. Those are the decisions the owner reserved; a vote among models must not
 * take one of them because two of three thought it was not reserved.
 *
 * @param options   the options that round offered ([{key, label}])
 * @param opinions  [{ seat, opinion }] — a validated opinion per seat, or null for a seat that gave none
 * @param last      true when no further round follows: the majority may decide
 * @returns { outcome: 'resolved', choice, answer, conditions, dissent? } | { outcome: 'undecided', why }
 *        | { outcome: 'escalated', why } | { outcome: 'unavailable', why }
 */
export function judge (options, opinions, { last = false } = {}) {
  const agreed = unanimous(options, opinions)
  if (agreed.outcome !== 'undecided' || !last) return agreed
  // More than half of the seats asked, each naming the same offered option with confidence. An answer of a seat's own
  // (`other`) is nobody else's, so it never forms a majority.
  const votes = new Map()
  for (const o of opinions) if (o.opinion.confidence !== 'low' && o.opinion.choice !== OTHER) votes.set(o.opinion.choice, [...(votes.get(o.opinion.choice) ?? []), o])
  const [choice, voters] = [...votes].find(([, seats]) => seats.length * 2 > opinions.length) ?? []
  const option = options.find((o) => o.key === choice)
  if (!option) return agreed
  const conditions = [...new Set([...(option.conditions ?? []), ...voters.flatMap((o) => o.opinion.conditions ?? [])])]
  const dissent = opinions.filter((o) => !voters.includes(o)).map((o) => ({ seat: o.seat, choice: o.opinion.choice, confidence: o.opinion.confidence }))
  return { outcome: 'resolved', choice, answer: option.label, conditions, dissent }
}

/** Every seat on one option: resolved, or why not. */
function unanimous (options, opinions) {
  const missing = opinions.filter((o) => !o.opinion)
  if (missing.length) return { outcome: 'unavailable', why: `no usable opinion from ${missing.map((o) => o.seat).join(', ')}` }
  const owner = opinions.filter((o) => o.opinion.verdict === 'owner')
  if (owner.length) return { outcome: 'escalated', why: `${owner.map((o) => o.seat).join(' and ')} left it to a person (${owner.map((o) => o.opinion.ownerReason).join(', ')})` }
  const choices = new Set(opinions.map((o) => o.opinion.choice))
  if (choices.size !== 1) return { outcome: 'undecided', why: `the seats chose differently (${opinions.map((o) => `${o.seat}: ${o.opinion.choice}`).join(', ')})` }
  const [choice] = choices
  const single = opinions.length === 1
  const low = opinions.filter((o) => o.opinion.confidence === 'low')
  // One occupied seat has nobody to agree with: an answer of its own is the decision, named as the option
  // (`alt-1`) a second round would have made of it, so callers read it like any agreed alternative.
  if (choice === OTHER && single && !low.length) return { outcome: 'resolved', choice: 'alt-1', answer: opinions[0].opinion.answer, conditions: [...new Set(opinions[0].opinion.conditions ?? [])] }
  if (choice === OTHER && !single) return { outcome: 'undecided', why: 'each seat gave an answer of its own' }
  const option = options.find((o) => o.key === choice)
  if (!option && choice !== OTHER) return { outcome: 'undecided', why: `"${choice}" is not one of the options offered` }
  if (low.length) return { outcome: 'undecided', why: single ? `${low[0].seat} answered with low confidence` : `${low.map((o) => o.seat).join(' and ')} agreed with low confidence` }
  const conditions = [...new Set([...(option.conditions ?? []), ...opinions.flatMap((o) => o.opinion.conditions ?? [])])]
  return { outcome: 'resolved', choice, answer: option.label, conditions }
}

/** The answer as later turns read it: the agreed text, then the conditions the agreeing seats attached. */
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
