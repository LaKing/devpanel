import { extractOutput, describeContract, scanObject } from '../server/runtime/structured-output.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export const name = 'structured output — boundaries, selection and classification'

const NL = String.fromCharCode(10)
const fence = (text) => ['```json', text, '```'].join(NL)
const root = CONFIG_ROOT

export default async function (t) {
  t.section('1. a JSON string containing three backticks does not end the block')
  {
    // The exact shape that lost a valid handoff in the first live runs: a prompt
    // with embedded code examples inside the JSON string.
    const prompt = 'Implement it. Example:' + NL + '```js' + NL + 'const x = 1' + NL + '```' + NL + 'Then stop.'
    const obj = { targetRole: 'author', prompt, rationale: 'because' }
    const text = 'Here is the brief.' + NL + fence(JSON.stringify(obj, null, 2))
    const r = await extractOutput(text, 'handoff', { root })
    t.eq('the handoff is valid', r.valid, true, r.error)
    t.eq('and the prompt survived intact', r.output?.prompt, prompt)
    t.eq('it was found in a fence', r.diagnostics.fenced, 1)
  }

  t.section('2. a bare object is accepted when nothing is fenced')
  {
    const text = 'Final answer:' + NL + JSON.stringify({ summary: 's', basedOnRevision: null, resolves: [] }) + NL + 'Done.'
    const r = await extractOutput(text, 'authorArtifact', { root })
    t.eq('valid', r.valid, true, r.error)
    t.eq('nothing fenced', r.diagnostics.fenced, 0)
    t.eq('one bare candidate', r.diagnostics.bare, 1)
  }

  t.section('3. two different compliant objects are ambiguous, not guessed at')
  {
    const a = { targetRole: 'author', prompt: 'A' }
    const b = { targetRole: 'author', prompt: 'B' }
    const text = fence(JSON.stringify(a)) + NL + 'or perhaps' + NL + fence(JSON.stringify(b))
    const r = await extractOutput(text, 'handoff', { root })
    t.eq('invalid', r.valid, false)
    t.eq('classified as ambiguous', r.classification, 'ambiguous-output')
    t.ok('the error counts them', /2 different JSON objects/.test(r.error), r.error)

    const same = fence(JSON.stringify(a)) + NL + fence(JSON.stringify(a))
    const r2 = await extractOutput(same, 'handoff', { root })
    t.eq('but identical repeats are fine', r2.valid, true)
  }

  t.section('4. an example block does not compete with the real answer')
  {
    const example = fence(JSON.stringify({ example: true, note: 'this is the shape' }))
    const real = fence(JSON.stringify({ verdict: 'approved', artifactRevision: null, findings: [] }))
    const r = await extractOutput('Shape:' + NL + example + NL + 'Verdict:' + NL + real, 'reviewResult', { root })
    t.eq('the compliant one is chosen', r.valid, true, r.error)
    t.eq('two candidates were seen', r.diagnostics.candidates, 2)
  }

  t.section('5. a contract violation names the fields in the validator\'s words')
  {
    const r = await extractOutput(fence(JSON.stringify({ notes: 'only' })), 'authorArtifact', { root })
    t.eq('invalid', r.valid, false)
    t.eq('classified as a contract violation', r.classification, 'contract-violation')
    t.ok('names the missing field', /missing summary/.test(r.error), r.error)

    const bad = await extractOutput(fence(JSON.stringify({ verdict: 'maybe', artifactRevision: null, findings: [] })), 'reviewResult', { root })
    t.ok('an enum violation is reported with its path', /\/verdict/.test(bad.error), bad.error)

    const long = await extractOutput(fence(JSON.stringify({ targetRole: 'author', prompt: 'x'.repeat(2950) })), 'handoff', { root })
    t.ok('a length violation names the actual length and how much to cut', /\/prompt must NOT have more than 2400 characters \(it has 2950; shorten by at least 550\)/.test(long.error), long.error)
  }

  t.section('6. no JSON at all is classified as no structured output')
  {
    const r = await extractOutput('I have thoughts but no structured output.', 'handoff', { root })
    t.eq('invalid', r.valid, false)
    t.eq('classification', r.classification, 'no-structured-output')
    t.ok('the error says what to do', /fenced json block/.test(r.error), r.error)
  }

  t.section('7. the scanner')
  {
    t.eq('closes at the matching brace', scanObject('{"a":{"b":"}"}} tail', 0), 15)
    t.eq('honours escapes inside strings', scanObject('{"a":"\\"}"}', 0), 11)
    t.eq('reports an unclosed object', scanObject('{"a":1', 0), -1)
  }

  t.section('8. a contract renders as a definition, not a name')
  {
    const def = {
      required: ['verdict', 'findings'],
      additionalProperties: false,
      properties: {
        verdict: { enum: ['approved', 'changes-needed'], description: 'the verdict' },
        findings: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, blocking: { type: 'boolean' } } } },
        notes: { type: 'string' }
      }
    }
    const text = describeContract('reviewResult', def)
    t.ok('names the contract', text.includes('`reviewResult`'))
    t.ok('marks required fields', text.includes('verdict (required)'))
    t.ok('marks optional fields', text.includes('notes (optional)'))
    t.ok('lists enum values', text.includes('"approved", "changes-needed"'))
    t.ok('describes nested item fields', text.includes('- id (required)'))
    t.ok('says extra fields are refused', text.includes('No other fields are accepted'))
    t.ok('degrades honestly without a definition', describeContract('x', null).includes('unavailable'))

    // A nested OBJECT is described one level in too. Without this, the
    // coordinator is told a field is an "object" and has to guess its shape —
    // which is exactly how operatorRequest would have reached it.
    const withObject = {
      required: ['targetRole'],
      properties: {
        targetRole: { type: 'string' },
        operatorRequest: {
          type: 'object',
          required: ['question', 'reason'],
          description: 'work the run cannot do for itself',
          properties: {
            question: { type: 'string', description: 'what is being asked' },
            reason: { type: 'string', description: 'why the run cannot proceed' },
            projectAction: { type: 'string', description: 'the action that would do it' }
          }
        }
      }
    }
    const nested = describeContract('handoff', withObject)
    t.ok('the object field keeps its own description', nested.includes('operatorRequest (optional): object — work the run cannot do for itself'), nested)
    t.ok('its required sub-fields are named as required', nested.includes('- question (required): string — what is being asked') && nested.includes('- reason (required): string'), nested)
    t.ok('and its optional sub-field is named without it', nested.includes('- projectAction: string — the action that would do it'), nested)
  }

  t.section('9. the real handoff contract reaches the coordinator with the request spelled out')
  {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const schema = JSON.parse(await fs.readFile(path.join(process.cwd(), '..', 'schemas', 'agent-outputs.schema.json'), 'utf8'))
    const text = describeContract('handoff', schema.$defs.handoff)
    t.ok('operatorRequest is offered', /operatorRequest \(optional\)/.test(text), text)
    t.ok('with question, reason and the suggested action', /- question \(required\)/.test(text) && /- reason \(required\)/.test(text) && /- projectAction:/.test(text), text)
  }
}
