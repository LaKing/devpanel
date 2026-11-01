import { getValidator, schemaId } from '../config/load.mjs'

/*
 * Structured output extraction.
 *
 * An agent's response is prose with a machine-readable object somewhere in it.
 * Finding that object by regular expression is what lost a valid handoff in the
 * first live runs: a non-greedy fence match ended inside a JSON string that
 * happened to contain three backticks. Boundaries are therefore found by a
 * scanner that understands JSON strings, and the result is classified so a
 * reader can tell an agent that broke the contract from an engine that could
 * not read a contract-compliant answer.
 *
 * Selection is deliberately conservative:
 *   1. objects inside ```json fences are preferred; bare objects are the fallback
 *   2. among the candidates, the ones that satisfy the contract are kept
 *   3. exactly one survivor is an answer; several different survivors are
 *      ambiguous and go to protocol repair rather than being guessed at
 */

const NL = String.fromCharCode(10)

/** Top-level fields each contract requires; kept in step with agent-outputs.schema.json. */
export const CONTRACT_REQUIRED = {
  triageResult: ['fit', 'reasoning', 'acceptanceCriteria'],
  handoff: ['targetRole', 'prompt'],
  authorArtifact: ['summary'],
  documentArtifact: ['summary'],
  reviewResult: ['verdict', 'artifactRevision', 'findings'],
  closureConfirmation: ['satisfied', 'criteria']
}

/**
 * Scan one JSON object starting at text[start] (which must be '{'). Returns the
 * index just past its closing brace, or -1 when the object never closes.
 * String-aware: braces inside strings do not count, escapes are honoured.
 */
export function scanObject (text, start) {
  if (text[start] !== '{') return -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

/** Every parseable top-level object in `text`, with where it sits. */
export function bareObjects (text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('{', i)
    if (open < 0) break
    const end = scanObject(text, open)
    if (end < 0) { i = open + 1; continue }
    const raw = text.slice(open, end)
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push({ start: open, end, value, fenced: false })
      i = end
    } catch {
      i = open + 1
    }
  }
  return out
}

/** Objects that open immediately inside a ```json fence. */
export function fencedObjects (text) {
  const out = []
  const opener = /```json[ \t]*\r?\n/g
  let m
  while ((m = opener.exec(text)) !== null) {
    let at = m.index + m[0].length
    while (at < text.length && /\s/.test(text[at])) at++
    if (text[at] !== '{') continue
    const end = scanObject(text, at)
    if (end < 0) continue
    try {
      const value = JSON.parse(text.slice(at, end))
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out.push({ start: at, end, value, fenced: true })
        opener.lastIndex = end
      }
    } catch { /* a fenced block that is not JSON is not a candidate */ }
  }
  return out
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/*
 * Validators compiled from a SNAPSHOT's contract definitions, keyed by the
 * snapshot's hash. A run must be judged by the definitions it was started with
 * and shown: validating against whatever schemas/ holds now would let an edit
 * on disk flip a recorded answer from accepted to rejected mid-run.
 */
const snapshotValidators = new Map()
const SNAPSHOT_ID = 'https://devpanel/snapshot/agent-outputs.schema.json'

async function validatorFor (contracts, root) {
  if (contracts?.defs && contracts.hash) {
    if (!snapshotValidators.has(contracts.hash)) {
      const { Ajv2020 } = await import('ajv/dist/2020.js')
      const { default: addFormats } = await import('ajv-formats')
      const ajv = new Ajv2020({ allErrors: true, strict: false })
      addFormats(ajv)
      ajv.addSchema({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: SNAPSHOT_ID, $defs: contracts.defs })
      snapshotValidators.set(contracts.hash, ajv)
    }
    return { ajv: snapshotValidators.get(contracts.hash), id: SNAPSHOT_ID, defs: contracts.defs }
  }
  return { ajv: await getValidator(root), id: schemaId('agent-outputs'), defs: null }
}

/**
 * Why a candidate fails the contract, or null when it satisfies it.
 * Presence first, so the message names the missing fields plainly; then the
 * schema, so a verdict of "maybe" or a finding without a severity is caught.
 */
export function contractError (value, contract, { ajv, id, defs } = {}) {
  const required = defs?.[contract]?.required ?? CONTRACT_REQUIRED[contract] ?? []
  const missing = required.filter((f) => value[f] === undefined)
  if (missing.length) return `missing ${missing.join(', ')}`
  const validate = ajv?.getSchema(`${id}#/$defs/${contract}`)
  if (validate && !validate(value)) {
    // A length violation names the actual length: told only the limit, a coordinator
    // shortened blind and missed it twice in a row (2026-11-01).
    const at = (pointer) => pointer.split('/').slice(1).reduce((v, k) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], value)
    const length = (e) => e.keyword === 'maxLength' && typeof at(e.instancePath) === 'string' ? ` (it has ${at(e.instancePath).length}; shorten by at least ${at(e.instancePath).length - e.params.limit})` : ''
    const detail = validate.errors.slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}${length(e)}`).join('; ')
    return `does not satisfy the ${contract} contract — ${detail}`
  }
  return null
}

/**
 * Extract and validate.
 *
 * Result shape:
 *   valid           whether exactly one contract-compliant object was found
 *   output          the object (the closest candidate when invalid, for diagnosis)
 *   error           one sentence a participant can act on
 *   classification  no-structured-output | contract-violation | ambiguous-output
 *   diagnostics     candidate counts and the per-candidate errors
 *
 * `contracts` is the snapshot's { hash, defs }; when given, validation is
 * compiled from it and the live schema files are not consulted.
 */
export async function extractOutput (text, contract, { root, contracts = null } = {}) {
  if (!contract) return { valid: true, output: null, contract: null }
  const source = typeof text === 'string' ? text : ''

  const fenced = fencedObjects(source)
  const candidates = fenced.length ? fenced : bareObjects(source)
  const diagnostics = { fenced: fenced.length, bare: fenced.length ? null : candidates.length, candidates: candidates.length, errors: [] }

  if (!candidates.length) {
    return {
      valid: false,
      output: null,
      contract,
      classification: 'no-structured-output',
      error: `no JSON object found; end the response with a fenced json block matching the ${contract} contract`,
      diagnostics
    }
  }

  const validator = await validatorFor(contracts, root)
  const judged = candidates.map((c) => ({ ...c, problem: contractError(c.value, contract, validator) }))
  diagnostics.errors = judged.map((c) => c.problem)
  const fits = judged.filter((c) => c.problem === null)

  if (fits.length === 1 || (fits.length > 1 && fits.every((c) => same(c.value, fits[0].value)))) {
    return { valid: true, output: fits[0].value, contract, classification: null, diagnostics }
  }

  if (fits.length > 1) {
    return {
      valid: false,
      output: fits[fits.length - 1].value,
      contract,
      classification: 'ambiguous-output',
      error: `${fits.length} different JSON objects satisfy the ${contract} contract; provide exactly one`,
      diagnostics
    }
  }

  // Nothing fits. Report the candidate that came closest: the last one, since
  // the required block is asked for at the end of the response.
  const last = judged[judged.length - 1]
  return {
    valid: false,
    output: last.value,
    contract,
    classification: 'contract-violation',
    error: judged.length === 1 ? last.problem : `${judged.length} JSON objects found, none satisfies the ${contract} contract; the last one ${last.problem}`,
    diagnostics
  }
}

/**
 * The contract as text a participant can write to. Rendered from the snapshotted
 * schema definition, so it names required fields, enums and descriptions, and
 * nothing a participant would have to guess.
 */
export function describeContract (name, def) {
  if (!def) return `Contract \`${name}\`: definition unavailable.`
  const lines = [`Contract \`${name}\` — a JSON object with these fields:`]
  const required = new Set(def.required ?? [])
  for (const [field, spec] of Object.entries(def.properties ?? {})) {
    lines.push(`- ${field}${required.has(field) ? ' (required)' : ' (optional)'}: ${describeType(spec)}${spec.description ? ` — ${spec.description}` : ''}`)
    // One level in, for the shape of an array's items or of a nested object.
    // A field described only as "object" is a field an agent has to guess at.
    const nested = spec.items?.properties ? spec.items : (spec.properties ? spec : null)
    if (nested) {
      const req = new Set(nested.required ?? [])
      for (const [sub, subSpec] of Object.entries(nested.properties)) {
        lines.push(`    - ${sub}${req.has(sub) ? ' (required)' : ''}: ${describeType(subSpec)}${subSpec.description ? ` — ${subSpec.description}` : ''}`)
      }
    }
  }
  if (def.additionalProperties === false) lines.push('No other fields are accepted.')
  return lines.join(NL)
}

function describeType (spec) {
  if (Object.hasOwn(spec, 'const')) return JSON.stringify(spec.const)
  if (spec.enum) return `one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}`
  const type = Array.isArray(spec.type) ? spec.type.join(' | ') : spec.type ?? 'value'
  if (type === 'array') return `array of ${spec.items?.type === 'object' ? 'objects' : spec.items?.type ?? 'values'}${spec.minItems != null ? `, at least ${spec.minItems} items` : ''}${spec.maxItems != null ? `, at most ${spec.maxItems} items` : ''}${spec.items?.maxLength != null ? `, each at most ${spec.items.maxLength} characters` : ''}`
  return `${type}${spec.maxLength != null ? `, at most ${spec.maxLength} characters` : ''}`
}
