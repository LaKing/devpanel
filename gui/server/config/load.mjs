import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import YAML from 'yaml'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { runOptionErrors, applyRunOptions, canonicalOptions } from './run-options.mjs'
import { infrastructureErrors, localChecksErrors, localTarget, stagingTarget, tierErrors } from '../infrastructure.mjs'
import { forbiddenRoots, homeExemption, PANEL_ROOT } from '../runtime/selection.mjs'
import { targetErrors, resolveMounts } from '../runtime/tooling-mounts.mjs'
import { nodeModulesTooling } from '../runtime/node-modules-tooling.mjs'
import { resolveProjectPath } from '../project-path.mjs'
import { DEFAULT_CONFIG_ROOT, hostConfigDir, discover } from './host-config.mjs'
import { hostSettings } from './host-settings.mjs'
import { harnessRefusal } from '../runtime/confinement-policy.mjs'
import { hostPlatform } from '../runtime/platform.mjs'

/*
 * Configuration loading. Filesystem and validation only — nothing here invokes a
 * harness, so a preview works offline. Capability probing lives in preflight.mjs.
 *
 * The output is one immutable, fully resolved playbook. Every failure carries the
 * source file and the field that caused it.
 */

export const CONFIG_ROOT = DEFAULT_CONFIG_ROOT

const SCHEMA_NAMES = [
  'harness-capabilities', 'roster-model', 'strategy-template', 'intent',
  'playbook', 'agent-outputs', 'revision-fingerprint', 'run', 'lock', 'project'
]

// Only these strategy paths may be overridden by a playbook. Anything else is a
// hard error: an override is a narrow dial, not a way to rewrite the algorithm.
const OVERRIDE_ALLOW = /^[a-z0-9-]+\.maxRounds$/

const REQUIREMENT_RANK = { none: 0, optional: 1, required: 2 }

/*
 * The seat-access policy step new runs resolve under. `hygiene: 1` (Phase 0b):
 * worker seats get an allow-listed environment and stated CLI settings instead
 * of the operator's (see harness/shared.mjs childEnvironment and the adapters).
 * `selection: 1` (Phase 0c, snapshot selection v1): materialized links carry
 * their owner's selection, targets are authorized, exclusions hold for every
 * base policy (runtime/selection.mjs).
 * `repository: 1` (Phase 0d): the run's work tree has its own engine and worker
 * Git directories under the run (engine-git.mjs), a commit candidate is
 * published into the source atomically and integration merges its
 * translation onto the source base (runtime/publication.mjs).
 */
export const FENCE_POLICY = Object.freeze({ hygiene: 1, selection: 1, namespace: 1, repository: 1 })

// Top-level fields of each agent-output contract, used to validate context refs
// such as steps.triage.output.acceptanceCriteria.
const OUTPUT_FIELDS = {
  triageBrief: ['targetRole', 'prompt'],
  triageDisposition: ['disposition', 'reasoning', 'response', 'issues'],
  releaseAssessment: ['summary','verdict','findings','openQuestions','observations'],
  investigationResult: ['summary', 'findings', 'openQuestions'],
  reportDisposition: ['disposition', 'reasoning', 'response', 'issues'],
  triageResult: ['fit', 'issuePresent', 'reasoning', 'acceptanceCriteria', 'concerns', 'suggestion', 'autonomy'],
  handoff: ['targetRole', 'prompt', 'rationale', 'mustAddress', 'assumptions'],
  authorArtifact: ['summary', 'basedOnRevision', 'resolves', 'notes'],
  documentArtifact: ['summary', 'resolves', 'openQuestions', 'notes'],
  reviewResult: ['verdict', 'artifactRevision', 'findings', 'priorFindings'],
  closureConfirmation: ['satisfied', 'revision', 'criteria', 'reasoning', 'residualRisks']
}

export class ConfigError extends Error {
  constructor (message, { file = null, path: field = null } = {}) {
    super(message)
    this.file = file
    this.field = field
  }
  toJSON () { return { message: this.message, file: this.file, field: this.field } }
}

const err = (list, message, file, field) => { list.push(new ConfigError(message, { file, path: field }).toJSON()) }

/** Tooling mounts and commands name host paths of one project, and reconcile policy names its files: projects/<id>.yaml only. */
function projectOnlyTooling (data, file, errors) {
  const found = ['mounts', 'commands'].filter((key) => data.workspace?.tooling?.[key] !== undefined)
  for (const key of found) err(errors, `workspace.tooling.${key} is a project setting (projects/<id>.yaml), not a strategy or playbook one`, file, `/workspace/tooling/${key}`)
  if (data.workspace?.reconcile !== undefined) err(errors, 'workspace.reconcile is a project setting (projects/<id>.yaml), not a strategy or playbook one', file, '/workspace/reconcile')
  return found.length > 0 || data.workspace?.reconcile !== undefined
}

function sha256 (text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex')
}

function deepFreeze (value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

// --- schema plumbing -------------------------------------------------------

// Keyed by root AND by the contents of that root's schemas: two roots must never
// share a compiled validator, and editing a schema in place must not be masked by
// a stale cache entry.
const validators = new Map()

export async function getValidator (root = CONFIG_ROOT) {
  const sources = []
  for (const name of SCHEMA_NAMES) {
    sources.push(await fs.readFile(path.join(root, 'schemas', `${name}.schema.json`), 'utf8'))
  }
  const key = `${root}\u0000${sha256(sources.join('\u0000'))}`

  if (!validators.has(key)) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    for (const source of sources) ajv.addSchema(JSON.parse(source))
    validators.set(key, ajv)
  }
  return validators.get(key)
}

export const schemaId = (name) => `https://devpanel/schemas/${name}.schema.json`

async function readYaml (file) {
  const text = await fs.readFile(file, 'utf8')
  return { data: YAML.parse(text), hash: sha256(text) }
}

async function validate (root, name, data, file, errors, field = '') {
  const ajv = await getValidator(root)
  const check = ajv.getSchema(schemaId(name))
  if (check(data)) return true
  for (const e of check.errors) {
    err(errors, e.message ?? 'invalid', file, (field + (e.instancePath || '')) || '/')
  }
  return false
}

async function listFiles (dir, ext) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(ext)).sort()
  } catch {
    return []
  }
}

// --- discovery -------------------------------------------------------------

/**
 * Every roster entry, strategy, playbook and adapter file, schema-validated.
 * Roster, playbooks and projects are each the union of the in-tree directory and the
 * host directory's (host-config.mjs); a host file shadows the in-tree one of the same
 * name. A roster entry on a harness the host settings disable is left out, so no
 * seat, supervisor or fallback can name it.
 */
export async function loadConfig ({ root = CONFIG_ROOT, hostDir = hostConfigDir({ root }) } = {}) {
  const errors = []
  const roster = new Map()
  const strategies = new Map()
  const playbooks = new Map()
  const sources = {}
  const shadowed = []
  const hostFiles = async (id) => {
    const files = await discover(id, { root, hostDir })
    sources[id] = { tree: files.filter((f) => f.source === 'tree').length, host: files.filter((f) => f.source === 'host').length }
    for (const f of files) if (f.shadows) shadowed.push({ category: id, name: f.name, tree: f.shadows, host: f.file })
    return files
  }

  const disabled = new Set(hostSettings({ root, hostDir }).harnesses.disabled)
  const disabledModels = new Map()
  for (const { name, file } of await hostFiles('roster')) {
    const { data, hash } = await readYaml(file)
    if (!await validate(root, 'roster-model', data, file, errors)) continue
    if (disabled.has(data.harness)) { disabledModels.set(data.id, data.harness); continue }
    if (data.defaultEffort != null && !(data.efforts ?? []).includes(data.defaultEffort)) {
      err(errors, `defaultEffort "${data.defaultEffort}" is not in efforts`, file, '/defaultEffort')
      continue
    }
    if (roster.has(data.id)) { err(errors, `duplicate roster id "${data.id}"`, file, '/id'); continue }
    roster.set(data.id, { ...data, file, hash })
  }

  for (const dir of (await fs.readdir(path.join(root, 'strategy-templates'), { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const file = path.join(root, 'strategy-templates', dir, 'strategy.yaml')
    let read
    try { read = await readYaml(file) } catch { err(errors, 'strategy.yaml missing', file, '/'); continue }
    if (!await validate(root, 'strategy-template', read.data, file, errors)) continue
    if (projectOnlyTooling(read.data, file, errors)) continue
    const strategy = { ...read.data, dir: path.dirname(file), file, hash: read.hash, intents: new Map() }

    // Intents: prompt overlays the strategy offers. Each names the steps it
    // speaks to, and a step that does not exist in this strategy is an error
    // here rather than silence at run time.
    const stepIds = new Set()
    for (const phase of strategy.phases) for (const step of phase.loop ? phase.loop.steps : [phase.step]) if (step?.id) stepIds.add(step.id)
    for (const name of await listFiles(path.join(strategy.dir, 'intents'), '.yaml')) {
      const ifile = path.join(strategy.dir, 'intents', name)
      let iread
      try { iread = await readYaml(ifile) } catch (e) { err(errors, `unreadable intent: ${e.message}`, ifile, '/'); continue }
      if (!await validate(root, 'intent', iread.data, ifile, errors)) continue
      if (iread.data.id !== name.replace(/\.yaml$/, '')) { err(errors, `intent id "${iread.data.id}" does not match its file name`, ifile, '/id'); continue }
      const unknown = Object.keys(iread.data.guidance).filter((id) => !stepIds.has(id))
      if (unknown.length) { err(errors, `intent guidance names steps the strategy does not have: ${unknown.join(', ')}`, ifile, '/guidance'); continue }
      strategy.intents.set(iread.data.id, { ...iread.data, file: ifile, hash: iread.hash })
    }
    strategies.set(read.data.id, strategy)
  }

  for (const { file } of await hostFiles('playbooks')) {
    const { data, hash } = await readYaml(file)
    if (!await validate(root, 'playbook', data, file, errors)) continue
    if (projectOnlyTooling(data, file, errors)) continue
    if (playbooks.has(data.id)) { err(errors, `duplicate playbook id "${data.id}"`, file, '/id'); continue }
    const tiers = tierErrors(data.checks?.target)
    for (const message of tiers) err(errors, message, file, '/checks/target')
    if (tiers.length) continue
    playbooks.set(data.id, { ...data, file, hash })
  }

  // Every module in harness/ except the shared helpers, which are not a runtime.
  const harnesses = (await listFiles(path.join(root, 'harness'), '.mjs')).map((f) => f.replace(/\.mjs$/, '')).filter((id) => !['shared', 'fence', 'mcp-devpanel'].includes(id))  // helpers and the broker's MCP shim, not adapters

  // Per-project source and integration settings, optional.
  const projects = new Map()
  for (const { name, file } of await hostFiles('projects')) {
    const { data, hash } = await readYaml(file)
    if (!await validate(root, 'project', data, file, errors)) continue
    const problems = infrastructureErrors(data.infrastructure)
    if (new Set((data.evidence ?? []).map(e => e.name)).size !== (data.evidence ?? []).length) problems.push('evidence names must be unique')
    const mountProblems = targetErrors(data.workspace?.tooling?.mounts ?? [])
    for (const message of mountProblems) err(errors, message, file, '/workspace/tooling/mounts')
    if (mountProblems.length) continue
    for (const message of problems) err(errors, message, file, '/infrastructure')
    if (problems.length) continue
    const checkProblems = localChecksErrors(data)
    for (const message of checkProblems) err(errors, message, file, '/checks')
    if (checkProblems.length) continue
    if (data.id !== name.replace(/\.yaml$/, '')) { err(errors, `project id "${data.id}" does not match its file name`, file, '/id'); continue }
    projects.set(data.id, { ...data, file, hash })
  }

  return { root, hostDir, roster, strategies, playbooks, harnesses, projects, errors, sources, shadowed, disabledModels }
}

/** A project's source repository and integration branch, declared or defaulted. */
export async function projectConfig (projectId, { root = CONFIG_ROOT, projectPath }) {
  const cfg = await loadConfig({ root })
  const declared = cfg.projects.get(projectId) ?? null
  // Declared means both named and valid; a partial file is not a declaration.
  const complete = Boolean(declared?.sourceRepository && declared?.integrationBranch)
  return {
    id: projectId,
    sourceRepository: complete ? declared.sourceRepository : projectPath,
    integrationBranch: complete ? declared.integrationBranch : null,
    declared: complete,
    file: declared?.file ?? null,
    errors: cfg.errors.filter((e) => e.file && e.file.endsWith(`projects/${projectId}.yaml`)).map((e) => e.message)
  }
}

// --- resolution ------------------------------------------------------------

function applyOverrides (phases, overrides, file, errors) {
  const byId = new Map(phases.map((p) => [p.id, p]))
  const out = JSON.parse(JSON.stringify(phases))
  const outById = new Map(out.map((p) => [p.id, p]))

  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!OVERRIDE_ALLOW.test(key)) {
      err(errors, `override "${key}" is not an overridable path`, file, `/overrides/${key}`)
      continue
    }
    const [phaseId, field] = key.split('.')
    const phase = byId.get(phaseId)
    if (!phase) { err(errors, `override targets unknown phase "${phaseId}"`, file, `/overrides/${key}`); continue }
    if (!phase.loop) { err(errors, `phase "${phaseId}" has no loop to override`, file, `/overrides/${key}`); continue }
    if (typeof value !== 'number' || value < 1) {
      err(errors, `override "${key}" must be a positive integer`, file, `/overrides/${key}`); continue
    }
    outById.get(phaseId).loop[field] = value
  }
  return out
}

function checkWorkflow (strategy, errors) {
  const steps = []
  const phaseIds = new Set()
  const stepOutputs = new Map()

  for (const phase of strategy.phases) {
    const at = `/phases/${phase.id}`
    if (phaseIds.has(phase.id)) err(errors, `duplicate phase id "${phase.id}"`, strategy.file, at)
    phaseIds.add(phase.id)
    for (const step of phase.loop ? phase.loop.steps : [phase.step]) steps.push({ phase, step })
  }

  // Step ids become folder slugs and are referenced by name, so they must be
  // unique across the whole strategy, not merely within a phase.
  for (const { phase, step } of steps) {
    if (stepOutputs.has(step.id)) {
      err(errors, `duplicate step id "${step.id}"; step ids are referenced by name and must be unique`, strategy.file, `/phases/${phase.id}`)
    }
    stepOutputs.set(step.id, step.output ?? null)
  }

  const seen = new Set()
  for (const { phase, step } of steps) {
    const at = `/phases/${phase.id}`
    if (!strategy.roles[step.role]) {
      err(errors, `step "${step.id}" uses role "${step.role}", which the strategy does not define`, strategy.file, at)
    }

    for (const ref of step.context ?? []) {
      const m = /^steps\.([a-z0-9-]+)\.(response|output)(?:\.([A-Za-z0-9_.]+))?$/.exec(ref)
      if (!m) continue
      const [, target, kind, field] = m
      if (!seen.has(target)) {
        err(errors, `step "${step.id}" references steps.${target}, which does not run before it`, strategy.file, at)
        continue
      }
      if (kind === 'output' && !stepOutputs.get(target)) {
        err(errors, `step "${step.id}" reads steps.${target}.output, but step "${target}" declares no output contract`, strategy.file, at)
      }
      if (kind === 'output' && field && stepOutputs.get(target)) {
        const contract = stepOutputs.get(target)
        const root = field.split('.')[0]
        if (!OUTPUT_FIELDS[contract]?.includes(root)) {
          err(errors, `step "${step.id}" reads steps.${target}.output.${root}, which is not a field of the ${contract} contract`, strategy.file, at)
        }
      }
    }

    // promptFrom must name a step that actually produces a handoff prompt.
    if (step.promptFrom) {
      const m = /^steps\.([a-z0-9-]+)\.output\.prompt$/.exec(step.promptFrom)
      if (!m) {
        err(errors, `promptFrom must name a handoff prompt, got "${step.promptFrom}"`, strategy.file, at)
      } else if (!seen.has(m[1])) {
        err(errors, `promptFrom references steps.${m[1]}, which does not run before it`, strategy.file, at)
      } else if (stepOutputs.get(m[1]) !== 'handoff') {
        err(errors, `promptFrom names steps.${m[1]}.output.prompt, but step "${m[1]}" produces "${stepOutputs.get(m[1]) ?? 'no output'}", not a handoff`, strategy.file, at)
      }
    }

    seen.add(step.id)
  }

  // Transition targets must exist.
  for (const phase of strategy.phases) {
    for (const t of phase.transitions ?? []) {
      if (t.to === 'await-input' && !(typeof t.question === 'string' && t.question.trim())) {
        err(errors, `phase "${phase.id}" transitions to await-input without a question`, strategy.file, `/phases/${phase.id}/transitions`)
      } else if (t.to === 'ask-owner' && phase.step?.output !== 'triageResult') {
        // What the owner is asked is the triage output's autonomy record; no other step carries one.
        err(errors, `phase "${phase.id}" transitions to ask-owner, which only a triageResult step can do`, strategy.file, `/phases/${phase.id}/transitions`)
      } else if (!['abort', 'await-input', 'ask-owner'].includes(t.to) && !phaseIds.has(t.to)) {
        err(errors, `phase "${phase.id}" transitions to "${t.to}", which is not a phase in this strategy`, strategy.file, `/phases/${phase.id}/transitions`)
      }
    }
  }

  return steps
}

/**
 * Resolve one playbook into an immutable, fully-resolved object.
 *
 * Hard errors (unbound role, invalid effort, missing prompt) produce ok:false.
 * An unverified model is NOT a hard error — it resolves for preview and is
 * reported through liveExecution.blockers, which preflight enforces.
 */
const offHarness = (cfg, id) => cfg.disabledModels?.has(id) ? ` (its harness, ${cfg.disabledModels.get(id)}, is disabled in the host settings; override this playbook in host-config/playbooks/)` : ''

export async function resolvePlaybook (id, { root = CONFIG_ROOT, config = null, runOptions = {}, projectId = null, platform = hostPlatform() } = {}) {
  const optionErrors = runOptionErrors(runOptions)
  if (optionErrors.length) return { ok: false, errors: optionErrors }
  const cfg = config ?? await loadConfig({ root })
  const errors = [...cfg.errors]
  const project = projectId ? cfg.projects.get(projectId) : null
  const infrastructure = project?.infrastructure ?? null

  let playbook = cfg.playbooks.get(id)
  if (!playbook) {
    return { ok: false, errors: [...errors, new ConfigError(`no playbook "${id}"`, { file: path.join(root, 'playbooks') }).toJSON()] }
  }

  playbook = applyRunOptions(playbook, runOptions)

  const strategy = cfg.strategies.get(playbook.strategy)
  if (!strategy) {
    err(errors, `strategy "${playbook.strategy}" not found`, playbook.file, '/strategy')
    return { ok: false, errors }
  }
  if (playbook.strategyVersion != null && playbook.strategyVersion !== strategy.version) {
    err(errors, `pinned strategyVersion ${playbook.strategyVersion} but ${strategy.id} is version ${strategy.version}`, playbook.file, '/strategyVersion')
  }

  // Roles bound exactly once, no extras, at most one writer.
  const roles = Object.keys(strategy.roles)
  for (const role of Object.keys(runOptions.participants ?? {})) if (!roles.includes(role)) err(errors, `unknown seat "${role}"`, playbook.file, "/runOptions/participants")
  const bound = Object.keys(playbook.participants)
  for (const role of roles) if (!bound.includes(role) && !strategy.roles[role].optional) err(errors, `role "${role}" is not bound`, playbook.file, '/participants')
  for (const b of bound) if (!roles.includes(b)) err(errors, `"${b}" is not a role in strategy ${strategy.id}`, playbook.file, `/participants/${b}`)
  const writers = roles.filter((r) => strategy.roles[r].writesCode)
  if (writers.includes('coordinator')) err(errors, 'the coordinator delegates source work and cannot be a source writer', strategy.file, '/roles/coordinator/writesCode')
  if (writers.length > 1) err(errors, `strategy declares ${writers.length} code-writing roles; at most one is allowed`, strategy.file, '/roles')

  // Participants.
  const participants = {}
  const blockers = []
  for (const id of playbook.fallbackModels ?? []) {
    if (!cfg.roster.has(id)) err(errors, `fallback model "${id}" is not in the roster${offHarness(cfg, id)}`, playbook.file, '/fallbackModels')
  }
  for (const [role, p] of Object.entries(playbook.participants)) {
    const field = `/participants/${role}`
    const model = cfg.roster.get(p.model)
    if (!model) { err(errors, `model "${p.model}" is not in the roster${offHarness(cfg, p.model)}`, playbook.file, `${field}/model`); continue }
    if (!cfg.harnesses.includes(model.harness)) {
      err(errors, `model "${model.id}" needs harness "${model.harness}", which has no adapter in harness/`, model.file, '/harness')
    }

    // Unknown capability and unsupported capability are different failures.
    let effort = p.effort ?? null
    if (effort != null) {
      if (model.efforts === null) {
        err(errors, `effort "${effort}" cannot be validated: ${model.id} has unknown effort levels (efforts: null). Verify the roster entry first.`, playbook.file, `${field}/effort`)
      } else if (model.efforts.length === 0) {
        err(errors, `${model.id} supports no effort setting; remove effort from this participant`, playbook.file, `${field}/effort`)
      } else if (!model.efforts.includes(effort)) {
        err(errors, `effort "${effort}" is not supported by ${model.id} on harness ${model.harness} (supported: ${model.efforts.join(', ')})`, playbook.file, `${field}/effort`)
      }
    } else {
      effort = model.defaultEffort ?? null
    }

    if (model.verification?.status !== 'verified') {
      blockers.push({ role, model: model.id, reason: 'roster entry is unverified', file: model.file })
    }
    // A harness this host cannot confine (gemini on macOS): previewed, never run.
    const refusal = harnessRefusal(model.harness, { platform })
    if (refusal) blockers.push({ role, model: model.id, kind: 'platform-unsupported', reason: refusal, remedy: 'put this seat on a claude or codex model', file: model.file })

    participants[role] = {
      role,
      coordinationOnly: role === 'coordinator',
      writesCode: Boolean(strategy.roles[role]?.writesCode),
      model: {
        id: model.id, wire: model.model, harness: model.harness, profile: model.profile ?? 'default',
        credentialRef: model.credentialRef ?? null, endpointRef: model.endpointRef ?? null,
        account: model.account ?? null,
        verification: model.verification, file: model.file, hash: model.hash
      },
      effort,
      instructions: p.instructions ?? null
    }
  }

  if (runOptions.inquiry && strategy.tactic !== 'analysis') err(errors, `an inquiry runs the analysis tactic only, not ${strategy.tactic ?? strategy.id}`, playbook.file, '/runOptions/inquiry')
  if (['staging','deployment'].includes(strategy.tactic)) {
    const environment = runOptions.environment ?? (strategy.tactic === 'staging' ? infrastructure?.staging?.id : infrastructure?.deployments?.[0]?.id)
    if (strategy.tactic === 'deployment' && (infrastructure?.deployments?.length ?? 0) > 1 && !runOptions.environment) blockers.push({role:'release-operator',model:null,reason:'Select a deployment environment explicitly when multiple targets are configured',file:project?.file??null})
    const allowed = strategy.tactic === 'staging' ? [infrastructure?.staging?.id] : (infrastructure?.deployments ?? []).map(e => e.id)
    if (!allowed.includes(environment) || !infrastructure?.release?.targets?.[environment]) blockers.push({ role:'release-operator', model:null, reason:'Release target requires installed checkpoint, restore, ownership and verification commands', file:project?.file ?? null })
    if (strategy.tactic === 'deployment' && !runOptions.releaseId) blockers.push({role:'release-operator',model:null,reason:'Deployment requires the releaseId of a successfully staged release',file:project?.file ?? null})
  } else if (runOptions.releaseId || runOptions.environment) err(errors,'releaseId/environment only apply to staging or deployment',playbook.file,'/runOptions')

  // Checks: a playbook may strengthen the requirement, never weaken it.
  const strategyReq = strategy.checks?.requirement ?? 'optional'
  const playbookReq = playbook.checks?.requirement ?? strategyReq
  if (REQUIREMENT_RANK[playbookReq] < REQUIREMENT_RANK[strategyReq]) {
    err(errors, `playbook weakens checks requirement from "${strategyReq}" to "${playbookReq}"; a playbook may only strengthen it`, playbook.file, '/checks/requirement')
  }

  // Budgets: a playbook may only tighten.
  const budgets = {}
  for (const key of ['maxSteps', 'wallClockMinutes', 'maxTokens', 'maxCostUsd']) {
    const s = strategy.budgets?.[key]
    const b = playbook.budgets?.[key]
    if (b != null && s != null && b > s) {
      err(errors, `playbook widens ${key} from ${s} to ${b}; a playbook may only tighten budgets`, playbook.file, `/budgets/${key}`)
    }
    const value = b ?? s
    if (value != null) budgets[key] = value
  }

  const repairCap = strategy.reviewPolicy?.protocolRepair?.maxAttempts ?? 0
  if (runOptions.repairAttempts != null && runOptions.repairAttempts > repairCap) {
    err(errors, `repair attempts exceed the strategy limit of ${repairCap}`, playbook.file, '/repairAttempts')
  }

  // The intent: the playbook's default, or the run's choice. Either must be one
  // the strategy defines; an unknown one is a hard error, not a silent no-op.
  let intent = null
  if (playbook.intent != null) {
    const found = strategy.intents.get(playbook.intent)
    if (!found) err(errors, `intent "${playbook.intent}" is not defined by strategy ${strategy.id} (available: ${[...strategy.intents.keys()].join(', ') || 'none'})`, playbook.file, runOptions.intent ? '/runOptions/intent' : '/intent')
    else intent = { id: found.id, title: found.title, description: found.description, covers: found.covers ?? [], guidance: found.guidance, file: found.file, hash: found.hash, source: runOptions.intent ? 'run' : 'playbook' }
  }

  const phases = applyOverrides(strategy.phases, playbook.overrides, playbook.file, errors)
  const steps = checkWorkflow({ ...strategy, phases }, errors)

  // Prompt templates must exist on disk.
  const prompts = {}
  for (const { phase, step } of steps) {
    if (!step.prompt) continue
    const file = path.join(strategy.dir, 'prompts', step.prompt)
    try {
      const text = await fs.readFile(file, 'utf8')
      prompts[step.prompt] = { file, hash: sha256(text) }
    } catch {
      err(errors, `prompt "${step.prompt}" for step "${step.id}" not found`, strategy.file, `/phases/${phase.id}`)
    }
  }

  // The output contracts are part of what a run executes: a turn is told their
  // definition and judged against it, so they contribute to the config hash and
  // are snapshotted with the prompts.
  const contractsFile = path.join(root, 'schemas', 'agent-outputs.schema.json')
  let contracts = null
  try {
    contracts = { file: contractsFile, hash: sha256(await fs.readFile(contractsFile, 'utf8')) }
  } catch {
    err(errors, 'agent-outputs.schema.json not found', contractsFile, '/')
  }

  const strategyDefault = strategy.completion.autoClose?.minimumVerification ?? 'verified'
  const autoClose = {
    minimumVerification: playbook.autoClose?.minimumVerification ?? strategyDefault,
    justification: playbook.autoClose?.justification ?? null,
    source: playbook.autoClose?.minimumVerification ? 'playbook' : 'strategy',
    strategyDefault
  }

  // One effective policy, stated once. The strategy's own autoClose is folded
  // into the top-level value above and does not travel separately: a consumer
  // reading completion.autoClose would see the strategy default and misreport
  // a playbook that explicitly chose review-only.
  const { autoClose: _strategyAutoClose, ...completionBase } = strategy.completion
  const completion = structuredClone(completionBase)
  const sourceDeliveryChoice = ['implementation', 'plan-and-implement'].includes(strategy.tactic)
  if (playbook.delivery?.action) {
    const order = ['none', 'worktree-diff', 'commit', 'merge']
    const sourceSelection = [playbook.delivery.action, completion.delivery.action].includes('apply-to-source')
    if ((sourceSelection || runOptions.delivery !== undefined) && !sourceDeliveryChoice) {
      err(errors, 'source delivery choices belong to Implementation, Plan and implement, and Refactoring', playbook.file, '/delivery/action')
    } else if (!sourceSelection && order.indexOf(playbook.delivery.action) < order.indexOf(completion.delivery.action)) {
      err(errors, `playbook weakens delivery from "${completion.delivery.action}" to "${playbook.delivery.action}"; a playbook may only strengthen it`, playbook.file, '/delivery/action')
    } else completion.delivery = { ...completion.delivery, action: playbook.delivery.action, source: 'playbook' }
  }

  if (strategy.completion.requires.includes('reportDispositionRecorded')) {
    const steps = strategy.phases.flatMap(p => p.step ? [p.step] : p.loop.steps)
    if (!['triage', 'analysis'].includes(strategy.tactic) || completion.delivery.action !== 'none' ||
        Object.values(strategy.roles).some(r => r.writesCode) ||
        steps.some(s => s.recordsRevision) ||
        !steps.some(s => s.output === 'triageDisposition' || (s.role === 'coordinator' && s.output === 'reportDisposition'))) {
      err(errors, 'reportDispositionRecorded requires read-only assessment with no delivery and a disposition step', strategy.file, '/completion/requires')
    }
  }

  // Tooling mounts are resolved against this host: a missing source is recorded
  // on the snapshot, not an error, and the engine refuses the project's seat
  // turns naming it (runtime/tooling-mounts.mjs).
  let toolingMounts = []
  if (project?.workspace?.tooling?.mounts?.length) {
    const resolvedMounts = await resolveMounts(project.workspace.tooling.mounts, { projectPath: await resolveProjectPath(project.id).catch(() => null) })
    for (const e of resolvedMounts.errors) err(errors, e.message, project.file, `/workspace/tooling/mounts/${e.index}/source`)
    toolingMounts = resolvedMounts.mounts
  }
  // A project that declares no tooling gets what its checkout provides, when the
  // host opted in (host settings tooling.nodeModules; runtime/node-modules-tooling.mjs).
  let autoTooling = null
  if (projectId && !project?.workspace?.tooling?.mounts?.length && !project?.workspace?.tooling?.commands?.length && hostSettings({ root, hostDir: cfg.hostDir }).tooling.nodeModules) {
    const projectPath = await resolveProjectPath(projectId).catch(() => null)
    if (projectPath) autoTooling = await nodeModulesTooling(projectPath)
    if (autoTooling) toolingMounts = autoTooling.mounts
  }

  // Delivery validation must finish before deciding whether resolution succeeded.
  if (errors.length) return { ok: false, errors }

  const contributing = [
    playbook.hash, strategy.hash, contracts.hash,
    ...(project ? [project.hash] : []),
    ...(intent ? [intent.hash] : []),
    ...Object.values(participants).map((p) => p.model.hash),
    ...Object.values(prompts).map((p) => p.hash)
  ].sort()

  if (Object.keys(runOptions).length) contributing.push(sha256(JSON.stringify(canonicalOptions(runOptions))))
  // The seat-access policy a run executes under is part of what it is, so a
  // policy step starts a new configuration group (harness/README.md "Seat hygiene").
  contributing.push(sha256(`fence:${JSON.stringify(FENCE_POLICY)}`))
  // Tooling found in the checkout is configuration no file states: a change in it starts a new group too.
  if (autoTooling) contributing.push(sha256(`tooling:${JSON.stringify({ mounts: autoTooling.mounts.map((m) => ({ target: m.target, masks: m.masks })), commands: autoTooling.commands, skipped: autoTooling.skipped })}`))

  const resolved = {
    // Frozen per run: the adapters read it from the snapshot, so a run resolved
    // before a policy step keeps the policy it started with.
    fence: { ...FENCE_POLICY },
    infrastructure,
    tactic: strategy.tactic ?? null,
    windowLimits: {maxInputFiles:100,maxInputBytes:26214400,maxInputFileBytes:26214400,maxPromptChars:60000,...(project?.windowLimits??{})},
    evidence: project?.evidence ?? (infrastructure ? [infrastructure.staging, ...infrastructure.deployments].flatMap(e => Object.entries(e.files ?? {}).map(([name, p]) => ({name:`${e.id}-${name}`,path:p,required:false}))) : []),
    runOptions: canonicalOptions(runOptions),
    parameterDefinitions: {
      ...(sourceDeliveryChoice ? { delivery: ['apply-to-source', 'worktree-diff'] } : {}),
      release: ['staging','deployment'].includes(strategy.tactic) ? { tactic: strategy.tactic, environments: (strategy.tactic === 'staging' ? [infrastructure?.staging] : infrastructure?.deployments ?? []).filter(Boolean).map(e => ({id:e.id,description:e.description})) } : null,
      seats: Object.entries(strategy.roles).map(([role, spec]) => ({ role, optional: spec.optional === true, description: spec.description, model: participants[role]?.model.id ?? null })),
      budgetCaps: strategy.budgets ?? {},
      repairCap,
      intents: [...strategy.intents.values()].map((i) => ({ id: i.id, title: i.title, description: i.description, covers: i.covers ?? [] })),
      models: [...cfg.roster.values()].map((m) => ({ id: m.id, title: m.title, harness: m.harness, efforts: m.efforts, defaultEffort: m.defaultEffort ?? null, verification: m.verification.status }))
    },
    playbook: {
      id: playbook.id,
      version: playbook.version,
      title: playbook.title ?? null,
      // Carried through because prompts reference it — dropping it turned a known
      // value into a symbolic slot in the preview.
      description: playbook.description ?? null,
      file: playbook.file,
      hash: playbook.hash
    },
    strategy: { id: strategy.id, version: strategy.version, dir: strategy.dir, file: strategy.file, hash: strategy.hash },
    intent,
    participants,
    ...(playbook.fallbackModels !== undefined ? { fallbackModels: playbook.fallbackModels } : {}),
    roles: strategy.roles,
    // The strategy owns isolation and the clean-base rule; the base itself may
    // be chosen by the project, playbook or run, and travels with the run.
    workspace: {
      ...(strategy.tactic ? {retention:{completed:'delete',unsuccessful:'retain'}} : {}),
      isolation: 'git-worktree', requireCleanBase: true, onUnsupported: 'block', base: 'head', symlinks: 'reject',
      ...(strategy.workspace ?? {}),
      ...(project?.workspace ?? {}),
      tooling: { allowLiveCheckout: false, allowedRoots: [], ...(strategy.workspace?.tooling ?? {}), ...(project?.workspace?.tooling ?? {}), ...(playbook.workspace?.tooling ?? {}),
        // Project-only (refused elsewhere at load): mounts as resolved on this host.
        ...(toolingMounts.length ? { mounts: toolingMounts } : {}), ...(project?.workspace?.tooling?.commands?.length ? { commands: project.workspace.tooling.commands } : {}),
        ...(autoTooling?.commands.length ? { commands: autoTooling.commands } : {}),
        ...(autoTooling && (autoTooling.mounts.length || autoTooling.skipped.length) ? { auto: 'nodeModules', ...(autoTooling.skipped.length ? { autoSkipped: autoTooling.skipped } : {}) } : {}) },
      ...(playbook.workspace?.base !== undefined ? { base: playbook.workspace.base, baseSource: runOptions.base !== undefined ? 'run' : 'playbook' } : { baseSource: project?.workspace?.base !== undefined ? 'project' : 'strategy' }),
      ...(playbook.workspace?.symlinks !== undefined ? { symlinks: playbook.workspace.symlinks } : {}),
      ...(playbook.workspace?.isolation !== undefined ? { isolation: playbook.workspace.isolation, isolationSource: runOptions.isolation !== undefined ? 'run' : 'playbook' } : {}),
      ...(playbook.workspace?.excludes !== undefined ? { excludes: playbook.workspace.excludes } : {}),
      ...(playbook.workspace?.retention ? {retention:playbook.workspace.retention} : {})
    },
    reviewPolicy: { ...strategy.reviewPolicy, protocolRepair: { ...strategy.reviewPolicy?.protocolRepair, maxAttempts: runOptions.repairAttempts ?? repairCap } },
    retryPolicy: { maxAttempts: 3, baseDelaySeconds: 30, maxDelaySeconds: 600, ...(strategy.retryPolicy ?? {}) },
    checks: infrastructure && steps.some(({ step }) => step.recordsRevision)
      ? { requirement: REQUIREMENT_RANK[playbookReq] > REQUIREMENT_RANK[infrastructure.testDrive.requirement ?? 'required'] ? playbookReq : (infrastructure.testDrive.requirement ?? 'required'), target: stagingTarget(infrastructure), boundToRevision: true, ...(playbook.checks?.concurrent !== undefined ? { concurrent: playbook.checks.concurrent } : {}) }
      : project?.checks && steps.some(({ step }) => step.recordsRevision)
        // A project's own local checks (no SSH staging) replace an absent playbook target the same way.
        ? { requirement: REQUIREMENT_RANK[playbookReq] > REQUIREMENT_RANK[project.checks.requirement ?? 'required'] ? playbookReq : (project.checks.requirement ?? 'required'), target: localTarget(project.checks), boundToRevision: true, ...(playbook.checks?.concurrent !== undefined ? { concurrent: playbook.checks.concurrent } : {}) }
      : { requirement: playbookReq, target: playbook.checks?.target ?? null, boundToRevision: true, ...(playbook.checks?.concurrent !== undefined ? { concurrent: playbook.checks.concurrent } : {}) },
    autoClose,
    budgets,
    completion,
    phases,
    prompts,
    contracts,
    liveExecution: { eligible: blockers.length === 0, blockers },
    configHash: sha256(contributing.join('\n')),
    resolvedAt: new Date().toISOString()
  }

  // Checks rebuild the candidate from base plus patch. In place there is neither,
  // so a requirement that must pass could never be met: refuse before anything
  // is spent rather than let the run block at closure with checksSatisfied false.
  if (resolved.workspace.isolation === 'in-place' && resolved.checks.requirement === 'required') {
    const errors = []
    err(errors, 'in-place work cannot satisfy required checks: checks rebuild the candidate from base plus patch, and in-place work has neither. Use an isolated worktree, or a playbook whose checks are optional.', playbook.file, resolved.workspace.isolationSource === 'run' ? '/isolation' : '/workspace/isolation')
    return { ok: false, errors }
  }

  // The seat fence (fence.namespace: 1) mounts nothing live: an isolated run
  // asking for the live checkout is refused here, not silently unmounted, and
  // every allowed root is checked against what no run may read (R2-5, R3-4;
  // implementation audit I12). In-place runs are namespace: partial by design.
  if (resolved.fence.namespace === 1 && resolved.workspace.isolation !== 'in-place') {
    const errors = []
    const tooling = resolved.workspace.tooling
    if (tooling.allowLiveCheckout === true) err(errors, 'allowLiveCheckout is not available to a fenced, isolated run: the live checkout is never mounted (use isolation in-place, recorded as namespace partial)', playbook.file, '/workspace/tooling/allowLiveCheckout')
    for (const message of await allowedRootErrors(tooling.allowedRoots ?? [], { projectPath: project?.path ?? null })) err(errors, message, project?.file ?? playbook.file, '/workspace/tooling/allowedRoots')
    if (errors.length) return { ok: false, errors }
  }

  return { ok: true, resolved: deepFreeze(resolved), errors: [] }
}

/**
 * What an allowed root may not be: the real home, `issues/`, the panel's
 * checkout outside its `tools/` subtree (release procedures are the one
 * tooling grant, R3-4), a container mount, or a Git repository root — a root is
 * read-only tooling, never source. A root that does not exist is refused too:
 * the fence would bind nothing and the seat would be told it may read it.
 */
export async function allowedRootErrors (roots, { projectPath = null } = {}) {
  const out = []
  const forbidden = await forbiddenRoots()
  let exempt
  try { exempt = await homeExemption() } catch (error) { return [error.message] }
  const panel = await fs.realpath(PANEL_ROOT).catch(() => PANEL_ROOT)
  const within = (root, p) => p === root || p.startsWith(root + path.sep)
  for (const root of roots) {
    const real = await fs.realpath(root).catch(() => null)
    if (!real) { out.push(`allowedRoots: ${root} does not exist`); continue }
    if (within(panel, real) && !within(path.join(panel, 'tools'), real)) { out.push(`allowedRoots: ${root} is inside the panel's own checkout; only its tools/ subtree may be granted`); continue }
    const hit = [...forbidden].find((f) => f !== panel && (within(f, real) || within(real, f)) && !exempt(f, real))
    if (hit) { out.push(`allowedRoots: ${root} reaches ${hit}, which no run may read`); continue }
    if (projectPath && within(await fs.realpath(projectPath).catch(() => projectPath), real)) { out.push(`allowedRoots: ${root} is inside the project checkout, which the run reads through its snapshot`); continue }
    if (await fs.lstat(path.join(real, '.git')).then(() => true, () => false)) out.push(`allowedRoots: ${root} is a Git repository; a root is read-only tooling, never source`)
  }
  return out
}
