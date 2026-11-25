import { OTHER } from './rule.mjs'

/*
 * What a consult seat is told (docs/consult.md "The seat's brief").
 *
 * One text for both seats of a round: they differ only in their model, so a
 * disagreement is about the question and not about what each was shown. The
 * first round never shows another seat's opinion; the second shows nothing else new.
 */

const NL = String.fromCharCode(10)

const LANGUAGES = { en: 'English', hu: 'Hungarian', de: 'German' }
export const languageName = (code) => LANGUAGES[code] ?? code ?? 'English'

const OWNER_REASONS = [
  'production-deployment: releasing to a production system',
  'irreversible-data-loss: deleting data or anything else that cannot be undone',
  'spending: money beyond what the project already allows',
  'agreed-rule-change: it changes a rule the owner agreed on in writing (not merely applies or interprets one)',
  'product-intent: what the product should do, where no file, rule or precedent says'
]

function contract ({ brief }) {
  const lines = [
    'Reply with ONE JSON object and nothing after it:',
    '```json',
    brief
      ? '{"verdict": "owner", "ownerReason": "<one of the reasons below>", "reasoning": "<what you read and what it shows, short>", "confidence": "high|medium|low", "ownerBrief": {"question": "...", "why": "...", "options": [{"label": "...", "consequence": "..."}], "recommendation": "..."}}'
      : '{"verdict": "answer|owner", "choice": "<an option key, or \\"other\\">", "answer": "<the decision to follow, 1-3 sentences>", "conditions": ["<a constraint the work must honour>"], "reasoning": "<short>", "evidence": [{"location": "<file:line>", "observation": "<what it shows>"}], "confidence": "high|medium|low", "ownerReason": "<only with verdict owner>", "ownerBrief": {"question": "...", "why": "...", "options": [{"label": "...", "consequence": "..."}], "recommendation": "..."}}',
    '```'
  ]
  return lines.join(NL)
}

function briefRules (language) {
  return [
    `ownerBrief is how this would be put to the project's owner, a person who knows the product and not this code. Write it in ${languageName(language)}:`,
    '- question: at most two sentences, answerable as it stands;',
    '- no file names, identifiers, option letters or internal terms unless you explain them in a few words;',
    '- why: one sentence on what depends on the answer;',
    '- options: two to four, each with its consequence in one sentence;',
    '- recommendation: which option, and why, in one sentence.',
    'It is required even when you answer the question yourself: it is used if the panel does not agree.',
    'Everything outside ownerBrief (answer, conditions, reasoning, evidence) is in English: later turns of the run read it.'
  ].join(NL)
}

/** What a seat is told about the rest of the panel: `others` is how many other seats answer the same question. */
const panelNote = (others) => (others === 0 ? 'You are the only consultant asked: your answer, when you give one, is the decision.'
  : others === 1 ? 'Another consultant answers the same question independently. You are not shown its answer and must not look for it.'
    : `${others} other consultants answer the same question independently. You are not shown their answers and must not look for them.`)

function header ({ request, roots, scratchDir, note }) {
  return [
    `You are a member of a consult panel: a senior second opinion asked before a question is put to a person. ${['operator', 'supervisor'].includes(request.askedBy?.role) || !request.askedBy?.role ? `It was raised by ${request.askedBy?.role === 'operator' ? 'an operator' : 'the supervisor of automated runs'}` : `It was raised by the ${request.askedBy.role} of an automated run`} on the project ${request.project}.`,
    note,
    '',
    'You can read everything listed below and change nothing. Read the code, the rules and the record yourself: verify what the question claims (numbers, precedents, quoted rules) instead of trusting it. If you cannot read what you need, say so in reasoning and answer with confidence "low".',
    '',
    '## What you can read',
    ...roots.map((r) => `- ${r.alias ?? r.path}  (${r.what})`),
    `- ${scratchDir}  (your scratch directory, the only place you can write)`
  ].join(NL)
}

function question ({ request, options }) {
  const lines = ['## The question', request.question]
  if (request.reason) lines.push('', '## Why it was raised', request.reason)
  if (request.category) lines.push('', `Category given by the asker: ${request.category}.`)
  if (options?.length) {
    lines.push('', '## Options', ...options.map((o) => `- \`${o.key}\`: ${o.label}${o.conditions?.length ? ` (conditions: ${o.conditions.join('; ')})` : ''}`),
      `- \`${OTHER}\`: a different decision, which you state in "answer"`)
  }
  return lines.join(NL)
}

/** The first round: decide, or say it is a person's. */
export function decidePrompt ({ request, options, roots, scratchDir, language, others = 1 }) {
  return [
    header({ request, roots, scratchDir, note: panelNote(others) }),
    '',
    question({ request, options }),
    '',
    '## Your task',
    'Decide whether this can be answered from the code, the documented rules and precedent in what you can read. Most questions can: a choice between technical routes, how an existing rule applies to a new case, whether an approach is sound.',
    'Say verdict "owner" only when the decision is a person\'s whatever the evidence says, and name which with ownerReason:',
    ...OWNER_REASONS.map((r) => `- ${r}`),
    'Otherwise say verdict "answer": choose the option that is right by its key, or "other" with your own decision. "conditions" are what the work must honour for your answer to hold: at most five, only what follows from this question, none that merely restates a rule the project already enforces. Give evidence with locations you actually read.',
    '',
    briefRules(language),
    '',
    contract({ brief: false })
  ].join(NL)
}

/** The second round: the same seat, shown the other's opinion. */
export function reconcilePrompt ({ options, others, language, last = false, seats = others.length + 1 }) {
  const shown = (o) => JSON.stringify({ verdict: o.verdict, choice: o.choice, answer: o.answer, conditions: o.conditions ?? [], reasoning: o.reasoning, evidence: o.evidence ?? [], confidence: o.confidence }, null, 2)
  const one = others.length === 1
  return [
    one ? 'The other consultant answered the same question differently. Its opinion:' : 'The panel did not agree on the same question. The other consultants\' opinions:',
    ...others.flatMap((other) => [...(one ? [] : ['', `### ${other.seat}`]), '```json', shown(other.opinion), '```']),
    '',
    one ? 'Check its evidence where it differs from yours, then give your final opinion in the same JSON form. Change your answer only if its evidence convinces you; agreeing to end the disagreement helps nobody.'
      : 'Check their evidence where it differs from yours, then give your final opinion in the same JSON form. Change your answer only if evidence convinces you; agreeing to end the disagreement helps nobody.',
    'An answer any of you gave as "other" is now an option of its own (alt-1, alt-2, ...): to keep or to adopt it, choose its key.',
    ...(last && seats > 2 ? ['This is the last round. If the panel still differs after it, the option most of you chose is the decision; a verdict "owner" is never outvoted.'] : []),
    '',
    '## Options now',
    ...options.map((x) => `- \`${x.key}\`: ${x.label}${x.conditions?.length ? ` (conditions: ${x.conditions.join('; ')})` : ''}`),
    `- \`${OTHER}\`: none of these; state your own in "answer"`,
    '',
    briefRules(language),
    '',
    contract({ brief: false })
  ].join(NL)
}

/** Mode `brief`: the decision is a person's; the seat only writes the question for them. */
export function briefPrompt ({ request, options, roots, scratchDir, language }) {
  return [
    header({ request, roots, scratchDir, note: 'This question is reserved to a person: you do not decide it. Your task is to put it so that the person can answer it quickly and well.' }),
    '',
    question({ request, options }),
    '',
    '## Your task',
    'Read enough to understand what is really being asked and what each answer would lead to. Then write ownerBrief. In "recommendation" say what you would choose and why; the person decides.',
    'ownerReason is one of:',
    ...OWNER_REASONS.map((r) => `- ${r}`),
    '',
    briefRules(language),
    '',
    contract({ brief: true })
  ].join(NL)
}

/** One repair turn after a reply that did not satisfy the contract. */
export function repairPrompt (problem) {
  return [`Your reply could not be used: ${problem}`, 'Reply again with the single JSON object, complete, and nothing after it.'].join(NL)
}
