import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { manualClock } from '../../server/runtime/clock.mjs'
import { gitWorktreeProvider, worktreeDiffDelivery } from '../../server/runtime/launch.mjs'
import { FENCE_STUBS } from '../../server/runtime/fingerprint.mjs'
import { createFakeHarness } from './harness.mjs'
import { CONFIG_ROOT, sandbox } from '../helpers.mjs'

/**
 * A crash is a dead process, not a released lock. Rewriting the recorded owner's
 * start time makes the liveness check report 'dead', which is what a restarted
 * server would genuinely observe.
 */
export async function simulateProcessDeath (issuePath) {
  const file = path.join(issuePath, '.run.lock')
  try {
    const lock = JSON.parse(await fs.readFile(file, 'utf8'))
    lock.owner.processStartedAt = '1'
    await fs.writeFile(file, JSON.stringify(lock, null, 2))
  } catch { /* no lock to age */ }
}

/** What a killed seat turn leaves: the fence's mount targets the CLI never got to remove. A path that exists is left. */
export async function leaveFenceStubs (root) {
  for (const rel of FENCE_STUBS) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    if (rel.endsWith('/')) await fs.mkdir(full, { recursive: true })
    else await fs.writeFile(full, '', { flag: 'wx', mode: 0o444 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
  }
}

/** Records what was delivered, so tests can assert delivery actually happened. */
export function fakeDelivery () {
  const calls = []
  return {
    calls,
    async deliver (args) {
      calls.push(args)
      if (args.action === 'apply-to-source') return worktreeDiffDelivery.deliver(args)
      const file = path.join(args.runDir, 'artifacts', 'delivered.patch')
      await fs.writeFile(file, `delivered ${args.revision}${NL}`, 'utf8')
      return { artifactRef: 'artifacts/delivered.patch' }
    }
  }
}

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj, null, 2), '```'].join(NL)

let fixtureImports = Promise.resolve()
let fixtureCount = 0

const temps = []
async function temp (prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

export async function cleanupFixtures () {
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}

/** Pull the rendered revision out of a prompt, the way a real agent would read it. */
const revisionIn = (prompt) => (prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0]

/**
 * Responses that satisfy every output contract. `plan` shapes the run:
 *   planFindings / implFindings — arrays of review rounds, each a findings list
 *   malformed — set of "stepId@attempt" that should emit an unreadable response
 */
/** Approval means no SUBSTANTIAL findings — a cosmetic note does not block. */
const substantial = (f) => f.blocking || f.severity === 'major' || f.severity === 'critical'
const verdictFor = (findings) => (findings.some(substantial) ? 'changes-needed' : 'approved')

/**
 * @param planDispositions  what the implementation auditor says became of each
 *                          plan-review finding, by id (or a function of the
 *                          review round returning that map); default: addressed
 */
/** A triage investigator's no-findings disposition under the two-seat sizing contract. */
export const triageNoFindings = {disposition:'no-findings',reasoning:'Nothing reproduced',response:'Checked the claim; nothing found.',issues:[],
  size:'minor',sizeReason:'Nothing to change was found.',affectedModules:[],
  autonomy:{verdict:'needs-owner-input',reason:'Nothing was found to work on.',questions:[{id:'Q1',question:'Close this issue as not reproducible?',category:'missing-information',recommendation:'Close it.'}]}}

export function scriptFor ({ planReviews = [[]], implReviews = [[]], malformed = new Set(), fitVerdict = true, confirm = true, planDispositions = {}, needsInput = null, operatorRequest = null } = {}) {
  // Every substantial plan finding must receive a disposition from the
  // implementation auditor, exactly as the engine will demand of a real one.
  const priorFindings = (round) => {
    const ids = new Set()
    for (const r of planReviews) for (const f of r) if (substantial(f)) ids.add(f.id)
    const table = typeof planDispositions === 'function' ? planDispositions(round) : planDispositions
    return [...ids].map((id) => ({ id, disposition: table[id] ?? 'addressed', reason: 'per script' }))
  }
  // A coordinator asks for the same work once, not on every pass: after an
  // evidence refresh the cycle repeats, and a script that re-asked would read as
  // the engine failing to remember rather than the coordinator deciding again.
  let asked = false
  return ({ role, stepId, attempt, round, prompt }) => {
    if (malformed.has(`${stepId}@${attempt}`)) return 'I could not comply. No structured output here.'

    switch (stepId) {
      case 'triage':
        return `Looked into it.${NL}${fence({ fit: fitVerdict, issuePresent: true, reasoning: 'reproduced', ...(needsInput ? { suggestion: { action: 'needs-input', reason: needsInput }, autonomy: { verdict: 'needs-owner-input', reason: needsInput, questions: [{ id: 'Q1', question: needsInput, category: 'missing-information', recommendation: 'the default' }] } } : { autonomy: { verdict: 'autonomous', reason: 'one run can finish it' } }), acceptanceCriteria: [{ id: 'AC1', statement: 'it works', verifiable: true }] })}`
      case 'brief':
        // The triage coordinator's brief is its own contract, not a handoff.
        if (prompt.includes('triageBrief')) return fence({ targetRole: 'investigator', prompt: 'Check the reported claim against the source.' })
      // falls through
      case 'brief-plan':
      case 'brief-implement':
      case 'handoff-plan':
      case 'handoff-plan-review':
      case 'handoff-implement':
      case 'handoff-implementation-review':
      case 'handoff-draft':
      case 'handoff-draft-review':
        // { stepId, request, with }: the coordinator asks for work on the live
        // checkout from exactly one handoff, the way a real one would ask once.
        // `with` puts other coordinator effects on the SAME handoff, which the
        // contract permits and which must not swallow the request.
        return `Briefing.${NL}${fence({ targetRole: stepId.includes('review') ? 'auditor' : stepId.includes('plan') ? 'planner' : 'implementer', prompt: `Work on ${stepId} (round ${round})`, rationale: 'because', ...(operatorRequest?.stepId === stepId && !asked ? ((asked = true), { operatorRequest: operatorRequest.request, ...(operatorRequest.with ?? {}) }) : {}) })}`
      // The analysis strategy: a document, reviewed like a plan.
      case 'draft':
        return `# The document${NL}Findings and a recommendation.${NL}${fence({ summary: 'the document', resolves: [], openQuestions: ['which option the operator prefers'] })}`
      case 'revise-draft':
        return `# The document (revised, round ${round + 1})${NL}${fence({ summary: 'the revised document', resolves: [] })}`
      case 'audit-draft': {
        const findings = planReviews[Math.min(round, planReviews.length - 1)] ?? []
        return `Reviewed the document.${NL}${fence({ verdict: verdictFor(findings), artifactRevision: null, findings })}`
      }
      case 'plan':
        return `A plan.${NL}${fence({ summary: 'the plan', basedOnRevision: null, resolves: [] })}`
      case 'revise-plan':
        return `A revised plan (round ${round + 1}).${NL}${fence({ summary: 'the revised plan', basedOnRevision: null, resolves: [] })}`
      case 'implement':
      case 'fix':
        return `Implemented.${NL}${fence({ summary: 'the change', basedOnRevision: revisionIn(prompt), resolves: [] })}`
      case 'execute':
        return `Done.${NL}${fence({ summary: 'the change', completed: true, basedOnRevision: revisionIn(prompt), resolves: [] })}`
      case 'audit-plan':
      case 'audit-plan-1': case 'audit-plan-2': case 'audit-plan-3': case 'audit-plan-4': {
        const findings = planReviews[Math.min(round, planReviews.length - 1)] ?? []
        return `Reviewed the plan.${NL}${fence({ verdict: verdictFor(findings), artifactRevision: revisionIn(prompt) ?? 'plan', findings })}`
      }
      case 'audit-implementation':
      case 'audit-implement-1': case 'audit-implement-2': case 'audit-implement-3': case 'audit-implement-4': {
        const findings = implReviews[Math.min(round, implReviews.length - 1)] ?? []
        const prior = priorFindings(round)
        const deferred = prior.some((d) => d.disposition === 'deferred')
        const verdict = deferred ? 'changes-needed' : verdictFor(findings)
        return `Reviewed the code.${NL}${fence({ verdict, artifactRevision: revisionIn(prompt), findings, priorFindings: prior })}`
      }
      case 'confirm': {
        // A revision is named only when the run produced one: a document run has none.
        const revision = revisionIn(prompt)
        // An unmet criterion is classified, as the contract demands; owner-gate
        // keeps it with the operator, so the run blocks rather than going back
        // to the author (engine.returnToReview).
        return `Checked the criteria.${NL}${fence({ satisfied: confirm, ...(revision ? { revision } : {}), criteria: [{ id: 'AC1', met: confirm, ...(confirm ? {} : { unmet: 'owner-gate' }), evidence: 'read it' }], reasoning: 'ok' })}`
      }
      case 'disposition':
        return fence({disposition:'no-findings',reasoning:'No actionable findings',response:'Investigation complete.',issues:[]})
      // The triage strategy's investigators return their disposition and size directly.
      case 'investigate':
        return fence(triageNoFindings)
      default:
        if (stepId === 'investigate-2' && prompt.includes('`triageDisposition`')) return fence(triageNoFindings)
        if (stepId.startsWith('investigate-')) return fence({...(prompt.includes('`releaseAssessment`')?{verdict:'approved'}:{}),summary:'Investigated source and evidence',findings:[],openQuestions:[]})
        return `Unscripted step ${stepId} for ${role}`
    }
  }
}

/** Occupy auditor-1 and pin the delivery action in the sandbox's copy of a playbook. */
async function occupy (dir, playbook, { auditor, delivery }) {
  const file = path.join(dir, 'playbooks', `${playbook}.yaml`)
  let text
  try { text = await fs.readFile(file, 'utf8') } catch { return }   // a test naming an absent playbook
  const strategy = (text.match(/^strategy: (.*)$/m) ?? [])[1]
  const roles = strategy ? await fs.readFile(path.join(dir, 'strategy-templates', strategy, 'strategy.yaml'), 'utf8').catch(() => '') : ''
  if (auditor !== undefined && /^  auditor-1:$/m.test(roles)) {
    // The playbook may occupy auditor-1 by default: the fixture's auditor
    // replaces it, and null empties the seat.
    text = text.replace(/^  auditor-1:\n(?:    .*\n)*/m, '')
    if (auditor) text = text.replace(/^participants:$/m, `participants:${NL}  auditor-1:${NL}    model: ${auditor}`)
  }
  if (delivery && /^delivery:$/m.test(text)) text = text.replace(/^(delivery:\n  action: ).*$/m, `$1${delivery}`)
  await fs.writeFile(file, text)
}

export const blocking = (id) => ({ id, severity: 'major', blocking: true, description: `${id} is wrong`, criterion: 'AC1', location: 'source.txt:1' })
export const cosmetic = (id) => ({ id, severity: 'minor', blocking: false, description: `${id} is a nitpick` })

/**
 * A complete engine fixture: a real git project, an issue, a config root whose
 * playbook uses the fake harness, and a scripted harness with its own ledger.
 *
 * @param auditor  roster id occupying `auditor-1` in the sandbox's copy of the
 *                 playbook (when its strategy has that seat), so an audited run
 *                 needs no run option; null leaves the optional seat empty
 * @param delivery the sandbox playbook's delivery action; worktree-diff keeps
 *                 the fixture's project checkout untouched unless a test asks
 */
export async function engineFixture ({ script = scriptFor(), sessionAssignment = 'preassign', loseMarker = false, playbook = 'implementation', auditor = 'gpt-6-sol', delivery: deliveryAction = 'worktree-diff' } = {}) {
  const clock = manualClock()

  // A real git repository, so the worktree provider is exercised for real.
  const projectPath = await temp('devpanel-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 'test@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'Fixture'])
  await fs.writeFile(path.join(projectPath, 'source.txt'), 'original' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])

  // A config root whose roster points every participant at the fake harness.
  const configRoot = await sandbox(async (dir) => {
    for (const f of await fs.readdir(path.join(dir, 'roster'))) {
      const file = path.join(dir, 'roster', f)
      let text = await fs.readFile(file, 'utf8')
      text = text.replace(/^harness: .*$/m, 'harness: fake')
        .replace(/^  status: unverified$/m, '  status: verified')
      await fs.writeFile(file, text)
    }
    await fs.writeFile(path.join(dir, 'harness', 'fake.mjs'), 'export const id = "fake"' + NL)
    await occupy(dir, playbook, { auditor, delivery: deliveryAction })
  })

  const issuesDir = await temp('devpanel-issues-')
  // issues.js fixes its directory when it loads, so a fresh module per fixture; fixtures
  // made side by side (overlappingSections) take turns setting what that module reads.
  const loading = fixtureImports.then(() => {
    process.env.DEVPANEL_ISSUES_DIR = issuesDir
    return import(`../../server/issues.js?fixture=${Date.now()}-${fixtureCount++}`)
  })
  fixtureImports = loading.catch(() => {})
  const issues = await loading
  const issue = await issues.createIssue('devpanel-project', { name: 'Engine fixture' })

  const ledgerPath = path.join(await temp('devpanel-ledger-'), 'ledger.jsonl')
  const fake = createFakeHarness({ script, ledgerPath, sessionAssignment, loseMarker, clock })

  // Forward EVERY option: dropping reuse/onReserve here silently disables the
  // reservation that makes turn persistence idempotent.
  const stepStore = {
    create: (options) => issues.createStep('devpanel-project', issue.id, options)
  }

  const delivery = fakeDelivery()

  return {
    clock,
    configRoot,
    delivery,
    projectPath,
    issuesDir,
    issue,
    issuePath: issue.path,
    issues,
    harnesses: { fake },
    fake,
    stepStore,
    playbookId: playbook,
    probe: (harness, opts) => fake.probe(opts),
    workspaceProvider: gitWorktreeProvider,
    async stepFolders () {
      return (await fs.readdir(issue.path, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && /^\d{3}-/.test(e.name)).map((e) => e.name).sort()
    },
    async filesIn (stepFolder) {
      return (await fs.readdir(path.join(issue.path, stepFolder))).sort()
    }
  }
}

/**
 * Put a sandboxed strategy back on the pause-based configuration: triage's
 * needs-input pauses (`await-input`) instead of ending for the owner, and/or
 * exhausted rounds ask `continue|stop` instead of the converging rule. The
 * shipped strategies no longer do either; the engine still supports both.
 */
export async function pausingStrategy (configRoot, { strategy = 'implementation', triage = true, rounds = true } = {}) {
  const file = path.join(configRoot, 'strategy-templates', strategy, 'strategy.yaml')
  let text = await fs.readFile(file, 'utf8')
  if (triage) {
    const before = text
    text = text.replace(/( +)- when: output\.suggestion\.action == needs-input\n +to: ask-owner\n/, (_, ind) => `${ind}- when: output.suggestion.action == needs-input\n${ind}  to: await-input\n${ind}  question: "{{output.suggestion.reason}}"\n`)
      .replace(/ +- when: output\.autonomy\.verdict == (needs-owner-input|too-large)\n +to: ask-owner\n/g, '')
    if (text === before) throw new Error(`pausingStrategy: no ask-owner transition in ${strategy}`)
  }
  if (rounds) text = text.replace(/onExhausted: extend-if-converging/g, 'onExhausted: await-input')
  await fs.writeFile(file, text)
}
