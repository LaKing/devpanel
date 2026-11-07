import { Ajv2020 } from 'ajv/dist/2020.js'

// Per-run arguments only. Paths, credentials, commands and workflow structure
// are owned by the saved configuration, never accepted through this interface.
const positive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const validate = new Ajv2020({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  properties: {
    budgets: {
      type: 'object', additionalProperties: false,
      properties: { maxSteps: positive, wallClockMinutes: positive, maxTokens: positive, maxCostUsd: { type: 'number', exclusiveMinimum: 0 } }
    },
    rounds: {
      type: 'object', additionalProperties: false,
      patternProperties: { '^[a-z0-9-]+$': positive }
    },
    participants: {
      type: 'object', additionalProperties: false,
      patternProperties: {
        '^[a-z0-9-]+$': {
          type: ['object', 'null'], additionalProperties: false,
          properties: {
            model: { type: 'string', minLength: 1 },
            effort: { enum: [null, 'low', 'medium', 'high', 'xhigh', 'max'] }
          }
        }
      }
    },
    // A deployment's environment: staging (the default), production or
    // staging-then-production, or a configured environment id; releaseId names
    // the staged release production promotes instead of the filled one
    // (config/release-plan.mjs, resolved against the project there).
    releaseId: { type: 'string', pattern: '^[a-zA-Z0-9-]+$' },
    environment: { type: 'string', pattern: '^[a-z0-9-]+$' },
    repairAttempts: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    // Which of the strategy's intents overlays this run. Validated against the
    // strategy at resolution, like everything else here.
    intent: { type: ['string', 'null'], pattern: '^[a-z0-9-]+$' },
    // Which base the worktree is cut from, for this run only.
    base: { oneOf: [{ enum: ['head', 'working-tree'] }, { type: 'object', required: ['commit'], additionalProperties: false, properties: { commit: { type: 'string', minLength: 1 } } }] },
    symlinks: { enum: ['reject', 'materialize', 'allow'] },
    delivery: { enum: ['apply-to-source', 'worktree-diff'] },
    // Where the work happens: an isolated worktree with a verified patch (the
    // default), or directly in the project checkout with nothing to hand off.
    isolation: { enum: ['git-worktree', 'in-place'] },
    // Give this run what earlier runs of the issue produced (runtime/prior-runs.mjs),
    // e.g. to implement an analysis's findings. Off by default: a new run sees
    // only human input.
    accumulate: { type: 'boolean' },
    // A triage that closes autonomous starts the playbook its sizing recommends,
    // through the ordinary admission (server/auto-start.mjs). Triage only; it
    // changes nothing the run itself does, so it is left out of the configHash.
    autoStart: { type: 'boolean' },
    // A supervisor inquiry (Phase 4): frozen into the snapshot so the run's
    // findings stay proposals and publish nothing. Only the engine's inquiry
    // path sets it; resolution accepts it for the analysis tactic alone.
    inquiry: { const: true }
  }
})

export function runOptionErrors (options) {
  if (validate(options)) return []
  return validate.errors.map((e) => ({
    file: 'run options', field: e.instancePath || '/',
    message: `${e.instancePath || '/'} ${e.message}${e.params.additionalProperty ? `: ${e.params.additionalProperty}` : ''}`
  }))
}

export function canonicalOptions (value) {
  if (Array.isArray(value)) return value.map(canonicalOptions)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalOptions(value[key])]))
  return value
}

export function applyRunOptions (base, options) {
  const playbook = structuredClone(base)
  if (options.base !== undefined) playbook.workspace = { ...playbook.workspace, base: options.base }
  if (options.symlinks !== undefined) playbook.workspace = { ...playbook.workspace, symlinks: options.symlinks }
  if (options.isolation !== undefined) playbook.workspace = { ...playbook.workspace, isolation: options.isolation }
  if (options.delivery !== undefined) playbook.delivery = { action: options.delivery }
  if (options.intent !== undefined) {
    if (options.intent === null) delete playbook.intent
    else playbook.intent = options.intent
  }
  playbook.budgets = { ...playbook.budgets, ...options.budgets }
  playbook.overrides = { ...playbook.overrides }
  for (const [phase, rounds] of Object.entries(options.rounds ?? {})) playbook.overrides[`${phase}.maxRounds`] = rounds
  for (const [role, values] of Object.entries(options.participants ?? {})) {
    if (values === null) { delete playbook.participants[role]; continue }
    const participant = { ...playbook.participants[role] }
    // An effort belonging to the previous model is not a default for its replacement.
    if (values.model !== undefined && values.model !== participant.model) delete participant.effort
    Object.assign(participant, values)
    if (participant.effort === null) delete participant.effort
    playbook.participants[role] = participant
  }
  return playbook
}
