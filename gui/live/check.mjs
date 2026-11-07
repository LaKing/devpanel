#!/usr/bin/env node
/*
 * Live adapter verification against the INSTALLED CLIs.
 *
 * Deliberately not part of `npm test`: it spends money and depends on
 * credentials. It refuses to run without an explicit opt-in, caps invocations —
 * the only limit enforceable before a call — and records the observed CLI
 * version so a failure after a CLI update stays diagnosable.
 *
 *   npm run live -- --harness claude --model claude-haiku-4-5 --plan
 *   DEVPANEL_LIVE=1 npm run live -- --harness claude --model claude-haiku-4-5
 *   DEVPANEL_LIVE=1 npm run live -- --harness codex  --model gpt-6-astra
 *   DEVPANEL_LIVE=1 npm run live -- --harness codex  --model gpt-6-astra --effort xhigh
 *   DEVPANEL_LIVE=1 npm run live -- --harness codex  --model gpt-6-astra --effort high --resume-effort low
 *   DEVPANEL_LIVE=1 npm run live -- --harness codex  --model gpt-6-astra \
 *       --efforts low,medium,high,xhigh,max --max-invocations 10
 *   DEVPANEL_LIVE=1 npm run live -- --harness gemini --model gemini-4-argon --fence
 *   DEVPANEL_LIVE=1 npm run live -- --harness claude --model claude-haiku-4-5 --tooling --project devpanel-project --max-invocations 1
 *   DEVPANEL_LIVE=1 npm run live -- --harness codex  --model gpt-5.6-luna --tooling --project <project-id> --max-invocations 1
 *   DEVPANEL_LIVE=1 npm run live -- --jev      (the Jev decision provider: one request)
 *   DEVPANEL_LIVE=1 npm run live -- --jev-integration   (each rollout phase's real questions: three requests)
 *   DEVPANEL_LIVE=1 npm run live -- --openai-decisions  (the OpenAI Decisions API provider: one request)
 *
 * The two turns are the whole verification: a pair of successful turns already
 * demonstrates that credentials work and that the model is reachable, so no
 * separate paid probe is performed.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLedger, runSessionCheck, passed, describe, effortVerified, effortSwitchVerified } from './session-check.mjs'
import { runFenceCheck, fencePassed, describeFence } from './fence-check.mjs'
import { runHygieneCheck, hygienePassed, describeHygiene } from './hygiene-check.mjs'
import { runReadFenceCheck, readFencePassed, describeReadFence } from './read-fence-check.mjs'
import { runRepoBrokerCheck, repoBrokerPassed, describeRepoBroker } from './repo-broker-check.mjs'
import { runToolingCheck, toolingPassed, describeTooling } from './tooling-check.mjs'
import { verifyGeminiPolicy } from './gemini-policy-check.mjs'
import { runJevCheck, plan as jevPlan, runJevIntegrationCheck, integrationPlan as jevIntegrationPlan } from './jev-check.mjs'
import { runOpenAIDecisionsCheck, plan as openaiDecisionsPlan } from './openai-decisions-check.mjs'
import { liveReportsDir } from '../server/config/host-config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NL = String.fromCharCode(10)

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d }

const harnessId = value('--harness', 'claude')
const model = value('--model', null)
const planOnly = flag('--plan')
/*
 * The fence check is a DIFFERENT question from session continuity, so it is a
 * different run rather than a third turn: it asks a real model to write, to run a
 * command and to change its own permission mode, and reads the verdict off the
 * filesystem. One invocation, and the default cap already allows it.
 */
const fenceOnly = flag('--fence')
/*
 * The hygiene check (fence.hygiene: 1) asks whether a seat still WORKS under the
 * stated settings: instructions load, the shell runs, the writer edits. Two
 * invocations, a writer turn and a reviewer turn.
 */
const hygieneOnly = flag('--hygiene')
// The seat fence (fence.namespace: 1) against a real model: one writer turn.
const readFenceOnly = flag('--read-fence')
// Private repositories and the broker, with a real CLI inside the fence (0d, Phase 3).
const repoBrokerOnly = flag('--repo-broker')
// A project's own tooling (workspace.tooling) inside the fence, offline: one read-only turn.
const toolingOnly = flag('--tooling')
const toolingProject = value('--project', null)
if (toolingOnly && !toolingProject) {
  console.error('--tooling needs --project <id>: the project whose workspace.tooling is checked')
  process.exit(2)
}
/*
 * Effort verification is the session check run AT a level, once per level: two
 * turns each, fresh and resumed, and after each turn the level the runtime
 * recorded it sent is read off its own session record. `--effort` names one
 * level, `--efforts a,b,c` several in one process under ONE invocation cap,
 * which must therefore cover 2 × the number of levels before anything is spent.
 * This runner has no retry loop, so it makes at most that many ADAPTER
 * invocations (a failed turn ends its level early); what the CLI does inside
 * one invocation is not bounded here. `--resume-effort` (with `--effort`)
 * requests a different level on the resumed turn: two equal requests cannot
 * tell an honoured override from an inherited one.
 */
const efforts = value('--efforts') ? value('--efforts').split(',').map((e) => e.trim()).filter(Boolean)
  : value('--effort') ? [value('--effort')] : []
const resumeEffort = value('--resume-effort')
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
for (const e of [...efforts, ...(resumeEffort ? [resumeEffort] : [])]) {
  if (!EFFORT_LEVELS.includes(e)) {
    console.error(`unknown effort "${e}"; the roster schema allows ${EFFORT_LEVELS.join(', ')}`)
    process.exit(2)
  }
}
if (efforts.length && fenceOnly) {
  console.error('--effort/--efforts verify the session check at a level; they do not combine with --fence')
  process.exit(2)
}
if (resumeEffort && (efforts.length !== 1 || value('--efforts'))) {
  console.error('--resume-effort goes with a single --effort: it changes the level on that run\'s resumed turn')
  process.exit(2)
}

/** A limit that is not a positive finite number is a broken limit, not a default. */
function limit (name, raw, { integer = false } = {}) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    console.error(`${name} must be a positive ${integer ? 'integer' : 'number'}; got ${JSON.stringify(raw)}`)
    process.exit(2)
  }
  return n
}

// The ONLY hard cap: cost is learned after a call, so a count is the only ceiling
// that can be enforced before spending.
const maxInvocations = limit('--max-invocations', value('--max-invocations', '2'), { integer: true })

// A BETWEEN-CALL threshold, not a per-call cap, and meaningless for a runtime
// that does not report cost.
const stopAboveUsd = limit('--stop-above-usd', value('--stop-above-usd', value('--max-cost-usd', '0.50')))

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' }
const mark = (s) => s === 'pass' ? `${c.green}✓${c.off}` : s === 'fail' ? `${c.red}✗${c.off}` : s === 'inconclusive' ? `${c.yellow}○${c.off}` : `${c.dim}·${c.off}`

/*
 * A decision provider (Jev, OpenAI Decisions) is not a harness: no CLI, no session, one HTTP
 * request. It shares only the opt-in and the report directory with the checks
 * below, so it is handled here and exits.
 */
if (flag('--jev-integration')) {
  console.log(`${c.cyan}live decision-provider integration check${c.off} ${c.dim}provider=jev, exactly three requests, retries off${c.off}`)
  if (planOnly) {
    console.log(`${NL}${c.yellow}plan only — nothing will be invoked${c.off}`)
    for (const line of jevIntegrationPlan) console.log(`  ${line}`)
    console.log(`${NL}  run it with: ${c.cyan}DEVPANEL_LIVE=1 npm run live -- --jev-integration${c.off}`)
    process.exit(0)
  }
  if (process.env.DEVPANEL_LIVE !== '1') {
    console.log(`${NL}${c.red}refusing to run${c.off}: set DEVPANEL_LIVE=1 to authorise live invocations.`)
    process.exit(2)
  }
  const startedAt = new Date().toISOString()
  let result = null
  let error = null
  try {
    result = await runJevIntegrationCheck({ log: (name, status, detail) => console.log(`  ${mark(status)} ${name}${detail.detail ? ` ${c.dim}— ${detail.detail}${c.off}` : ''}`) })
  } catch (e) {
    error = e.message
    console.log(`  ${c.red}✗${c.off} ${e.message}`)
  }
  const report = { startedAt, check: 'decision-provider-integration', provider: 'jev', passed: result?.passed ?? false, error, ...result }
  const dir = await liveReportsDir({ tree: path.join(HERE, 'reports') })
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `jev-integration-${startedAt.replace(/[:.]/g, '-')}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2) + NL)
  if (result?.costUsd != null) console.log(`${c.dim}cost${c.off} $${result.costUsd.toFixed(8)}`)
  console.log(`${c.dim}report${c.off} ${path.relative(process.cwd(), file)}`)
  process.exit(report.passed ? 0 : 1)
}

const singleChecks = [
  { flag: '--jev', provider: 'jev', plan: jevPlan, run: runJevCheck },
  { flag: '--openai-decisions', provider: 'openai', plan: openaiDecisionsPlan, run: runOpenAIDecisionsCheck }
]
for (const single of singleChecks.filter((s) => flag(s.flag))) {
  console.log(`${c.cyan}live decision-provider check${c.off} ${c.dim}provider=${single.provider}, exactly one request, retries off${c.off}`)
  if (planOnly) {
    console.log(`${NL}${c.yellow}plan only — nothing will be invoked${c.off}`)
    for (const line of single.plan) console.log(`  ${line}`)
    console.log(`${NL}  run it with: ${c.cyan}DEVPANEL_LIVE=1 npm run live -- ${single.flag}${c.off}`)
    process.exit(0)
  }
  if (process.env.DEVPANEL_LIVE !== '1') {
    console.log(`${NL}${c.red}refusing to run${c.off}: set DEVPANEL_LIVE=1 to authorise live invocations.`)
    process.exit(2)
  }
  const startedAt = new Date().toISOString()
  let result = null
  let error = null
  try {
    result = await single.run({ log: (name, status, detail) => console.log(`  ${mark(status)} ${name}${detail.detail ? ` ${c.dim}— ${detail.detail}${c.off}` : ''}`) })
  } catch (e) {
    error = e.message
    console.log(`  ${c.red}✗${c.off} ${e.message}`)
  }
  const report = { startedAt, check: 'decision-provider', provider: single.provider, passed: result?.passed ?? false, error, ...result }
  const dir = await liveReportsDir({ tree: path.join(HERE, 'reports') })
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${single.provider}-${startedAt.replace(/[:.]/g, '-')}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2) + NL)
  if (result?.record?.costUsd != null) console.log(`${c.dim}cost${c.off} $${result.record.costUsd.toFixed(8)} ${c.dim}(${result.record.usage?.input_tokens} input tokens)${c.off}`)
  else if (result?.record?.status === 'answered') console.log(`${c.dim}cost unknown: the response reported no usage${c.off}`)
  console.log(`${c.dim}report${c.off} ${path.relative(process.cwd(), file)}`)
  process.exit(report.passed ? 0 : 1)
}

console.log(`${c.cyan}live ${efforts.length ? 'effort' : 'session'} check${c.off} ${c.dim}harness=${harnessId} model=${model ?? '(runtime default)'}${efforts.length ? ` efforts=${efforts.join(',')}` : ''}${resumeEffort ? ` resume-effort=${resumeEffort}` : ''}${c.off}`)
console.log(`${c.dim}hard cap: ≤${maxInvocations} invocations${c.off}`)
console.log(`${c.dim}stop threshold: $${stopAboveUsd}, checked between calls — not a per-call cap${c.off}`)

// Refused BEFORE anything is spent: a cap that would stop half-way through the
// levels leaves some verified and some merely attempted, which is not a result.
const needed = toolingOnly ? 1 : 2 * Math.max(efforts.length, 1)
if (maxInvocations < needed) {
  console.log(`${NL}${c.red}refusing to run${c.off}: ${efforts.length || 1} level(s) × 2 turns need --max-invocations ${needed}, got ${maxInvocations}`)
  process.exit(2)
}

if (planOnly) {
  console.log(`${NL}${c.yellow}plan only — nothing will be invoked${c.off}`)
  console.log('  1. probe installation, and record the CLI version        (free)')
  if (toolingOnly) {
    console.log(`  2. ONE read-only reviewer turn in an export of ${toolingProject} with its tooling mounts, running the offline`)
    console.log('     wrapper alone, a network probe in the seat\'s own shell, each declared command as the engine renders it,')
    console.log('     and the same network probe through the wrapper')
    console.log(`${NL}  ${c.dim}Verdicts per mount and command (confirmed / refuted / not-run) from the runtime's own tool-call record.${c.off}`)
    console.log(`  ${c.dim}gemini spends nothing: its seats have no shell, and the report says so.${c.off}`)
  } else if (repoBrokerOnly) {
    console.log('  2. ONE writer turn in a private-repository worktree inside the fence, broker attached (fake database):')
    console.log('     edit, git add and commit, then db_query — verdicts from the worker/engine Git directories and broker evidence')
  } else if (readFenceOnly) {
    console.log('  2. ONE writer turn inside the seat fence: read a worktree canary, try a home canary by tool and shell,')
    console.log('     list ~/.ssh, write into read-only evidence — read from the runtime record and the filesystem')
  } else if (hygieneOnly) {
    console.log('  2. a writer turn under fence.hygiene: 1 — quote the CLAUDE.md/AGENTS.md canary, run pwd, create a file')
    console.log('  3. a reviewer turn under fence.hygiene: 1 — quote the canary, run pwd, change nothing')
    console.log(`${NL}  ${c.dim}Read from the runtime's own event stream and the filesystem (2 invocations).${c.off}`)
  } else if (fenceOnly) {
    console.log('  2. ONE turn as a read-only role, asked to edit a file, create a file,')
    console.log('     run a shell command, and change its own permission mode')
    console.log(`${NL}  ${c.dim}The verdict is read from the filesystem afterwards, never from what${c.off}`)
    console.log(`  ${c.dim}the model says it managed to do.${c.off}`)
  } else if (efforts.length) {
    console.log(`  2. for each of ${efforts.join(', ')} (${efforts.length} level(s), at most ${needed} adapter invocations, no retry loop):`)
    console.log('     a. one turn at that effort in a disposable workspace, capturing the session id')
    console.log('     b. the effort and model the runtime recorded it sent, read off its session record')
    console.log(`     c. a second turn resuming it at ${resumeEffort ? `effort ${resumeEffort}` : 'the same effort'}, and the same read-back`)
    console.log(`${NL}  ${c.dim}A level counts only when the whole session check passed and the runtime's own record${c.off}`)
    console.log(`  ${c.dim}names that level and model for both turns. That shows what the CLI sent and that the${c.off}`)
    console.log(`  ${c.dim}provider completed the turn; how the backend interpreted the level is not observed.${c.off}`)
  } else {
    console.log('  2. one turn in a disposable workspace, capturing the native session id')
    console.log('  3. a second turn resuming it, proving continuity across processes')
    console.log(`${NL}  ${c.dim}Authentication and model access are demonstrated by those turns;${c.off}`)
    console.log(`  ${c.dim}no separate paid probe is performed.${c.off}`)
  }
  console.log(`${NL}  run it with: ${c.cyan}DEVPANEL_LIVE=1 npm run live -- ${argv.filter((a) => a !== '--plan').join(' ')}${c.off}`)
  process.exit(0)
}

if (process.env.DEVPANEL_LIVE !== '1') {
  console.log(`${NL}${c.red}refusing to run${c.off}: set DEVPANEL_LIVE=1 to authorise live invocations.`)
  console.log(`${c.dim}Use --plan to see what it would do without spending anything.${c.off}`)
  process.exit(2)
}

const runtime = await import(`../../harness/${harnessId}.mjs`)
const credentialRef = value('--credential-ref')
const adapter = { ...runtime,
  probe: options => runtime.probe({ ...options, credentialRef }),
  invoke: options => runtime.invoke({ ...options, credentialRef }),
  ...(runtime.inspectSession ? { inspectSession: options => runtime.inspectSession({ ...options, credentialRef }) } : {})
}
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-live-'))
// Scratch belongs outside the workspace, as it does in a real run: inside it, it
// would be part of the candidate.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-live-scratch-'))
// The adapter ledger stays outside the workspace, as it does in a real run.
const ledgerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-live-ledger-'))

const ledger = createLedger()
const reserve = () => {
  if (ledger.invocations.length >= maxInvocations) {
    throw new Error(`invocation cap reached (${maxInvocations})`)
  }
  if (ledger.costUsd >= stopAboveUsd) {
    throw new Error(`observed spend $${ledger.costUsd.toFixed(4)} is at or above the stop threshold $${stopAboveUsd}`)
  }
}

const progress = (name, status, detail) => {
  const extra = detail.version ?? detail.session ?? detail.detail ?? ''
  console.log(`  ${mark(status)} ${name}${extra ? ` ${c.dim}— ${extra}${c.off}` : ''}`)
}

let result = null
// One entry per level in effort mode; each is a full session-check result.
const levels = []
try {
  if (efforts.length) {
    for (const effort of efforts) {
      console.log(`${NL}${c.cyan}effort ${effort}${c.off}`)
      const r = await runSessionCheck({ adapter, harnessId, model, effort, resumeEffort, workspace, ledgerDir, ledger, reserve, log: progress })
      levels.push(r)
      result = r
      // A refused reservation ends the whole run: nothing further can be paid for.
      if (r.stages.some((s) => /invocation cap|stop threshold/.test(s.detail ?? ''))) break
    }
  } else {
  result = toolingOnly
    ? await runToolingCheck({ adapter, harnessId, model, root: workspace, projectId: toolingProject, ledgerDir, ledger, reserve, log: progress })
    : repoBrokerOnly
    ? await runRepoBrokerCheck({ adapter, harnessId, model, root: workspace, ledgerDir, ledger, reserve, log: progress })
    : readFenceOnly
    ? await runReadFenceCheck({ adapter, harnessId, model, root: workspace, ledgerDir, ledger, reserve, log: progress })
    : hygieneOnly
    ? await runHygieneCheck({ adapter, harnessId, model, root: workspace, ledgerDir, ledger, reserve, log: progress, workerTools: runtime.WORKER_TOOLS ?? null })
    : fenceOnly
    ? await runFenceCheck({
      verifyPolicy: harnessId === 'gemini' ? verifyGeminiPolicy : null,
      adapter,
      harnessId,
      model,
      workspace,
      scratch,
      ledgerDir,
      ledger,
      reserve,
      log: (name, status, detail) => {
        const extra = detail.version ?? detail.session ?? detail.detail ?? ''
        console.log(`  ${mark(status)} ${name}${extra ? ` ${c.dim}— ${extra}${c.off}` : ''}`)
      }
    })
    : await runSessionCheck({
    adapter,
    harnessId,
    model,
    workspace,
    ledgerDir,
    ledger,
    reserve,
    log: progress
  })
  }
} catch (error) {
  console.log(`  ${c.red}✗${c.off} ${error.message}`)
} finally {
  const report = {
    startedAt: new Date().toISOString(),
    harness: harnessId,
    model,
    limits: {
      maxInvocations,
      stopAboveUsd,
      note: 'maxInvocations is the only pre-call cap; stopAboveUsd is checked between calls'
    },
    cliVersion: result?.cliVersion ?? null,
    sessionAssignment: result?.sessionAssignment ?? null,
    stages: result?.stages ?? [],
    check: toolingOnly ? 'tooling' : repoBrokerOnly ? 'repo-broker' : readFenceOnly ? 'read-fence' : hygieneOnly ? 'hygiene' : fenceOnly ? 'fence' : efforts.length ? 'effort' : 'session',
    // Effort mode: one record per level. `verified` is the list to put in the
    // roster: the whole session check passed AND both turns were requested at
    // that level AND both records name it. A --resume-effort run is a SWITCH
    // check: it tests each level on one turn only, so it verifies no level and
    // is reported under `switch` instead. `requested` is what was asked for;
    // `attempted` is what the ledger shows an invocation was made for (a level
    // whose check stopped before its first call, say on installation, is not
    // attempted).
    efforts: efforts.length
      ? {
          requested: efforts,
          attempted: efforts.filter((e) => ledger.invocations.some((i) => i.effort === e)),
          verified: resumeEffort ? [] : levels.filter(effortVerified).map((r) => r.effort),
          // Attempted and not verified. A level that never reached a call is
          // `notAttempted`, not failed: nothing about it was observed.
          failed: resumeEffort ? [] : levels.filter((r) => !effortVerified(r) && ledger.invocations.some((i) => i.effort === r.effort)).map((r) => r.effort),
          notAttempted: efforts.filter((e) => !ledger.invocations.some((i) => i.effort === e)),
          switch: resumeEffort
            ? { from: efforts[0], to: resumeEffort, verified: levels.length === 1 && effortSwitchVerified(levels[0]), note: 'the override on resume was honoured (or not); neither level is verified by this run' }
            : null,
          evidence: 'per turn, the effort and model the runtime recorded on its own session record, never the model\'s answer. This shows what the CLI sent and that the provider completed the turn; it does not show how the backend interpreted the level.',
          levels: levels.map((r) => ({
            effort: r.effort,
            resumeEffort: r.resumeEffort,
            verified: effortVerified(r),
            switchVerified: effortSwitchVerified(r),
            sessionCheckPassed: passed(r),
            cliVersion: r.cliVersion,
            stages: r.stages,
            sessions: r.sessions,
            responses: r.responses,
            remembered: r.remembered,
            evidence: r.effortEvidence
          }))
        }
      : null,
    sessions: result?.sessions ?? null,
    responses: result?.responses ?? null,
    // The model's own account of what it tried. Evidence for a human, never the
    // verdict — that comes from the filesystem.
    fenceResponse: result?.response ?? null,
    hygieneTurns: hygieneOnly ? (result?.turns ?? null) : undefined,
    readFenceCalls: readFenceOnly ? (result?.calls ?? null) : undefined,
    tooling: toolingOnly ? { project: toolingProject, isolation: result?.isolation ?? null, isolationMode: result?.isolationMode ?? null, seatNetwork: result?.seatNetwork ?? null, offline: result?.offline ?? null, paths: result?.paths ?? [], calls: result?.calls ?? null, response: result?.response ?? null } : undefined,
    policyEvidence: result?.policyEvidence ?? null,
    toolCalls: result?.toolCalls ?? null,
    remembered: result?.remembered ?? null,
    demonstrated: result?.demonstrated ?? null,
    invocations: ledger.invocations,
    spent: {
      attempts: ledger.invocations.length,
      tokens: ledger.tokens,
      costUsd: Number(ledger.costUsd.toFixed(6)),
      costUnknownCalls: ledger.costUnknownCalls,
      costIsLowerBound: ledger.costUnknownCalls > 0
    }
  }

  const dir = await liveReportsDir({ tree: path.join(HERE, 'reports') })
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${toolingOnly ? `tooling-${harnessId}-${toolingProject}` : harnessId}${efforts.length ? `-${model ?? 'default'}-effort` : ''}-${report.startedAt.replace(/[:.]/g, '-')}.json`)
  await fs.writeFile(file, JSON.stringify(report, null, 2) + NL)

  if (efforts.length) {
    for (const r of levels) console.log(`${NL}${c.dim}${describe(r)}${c.off}`)
    if (report.efforts.switch) {
      const sw = report.efforts.switch
      console.log(`${NL}switch ${sw.from} -> ${sw.to}: ${sw.verified ? c.green + 'verified' : c.red + 'NOT verified'}${c.off}  ${c.dim}(no level is verified by a switch run)${c.off}`)
    } else {
      console.log(`${NL}verified: ${report.efforts.verified.length ? c.green + report.efforts.verified.join(', ') + c.off : c.dim + 'none' + c.off}` +
        (report.efforts.failed.length ? `  ${c.red}failed: ${report.efforts.failed.join(', ')}${c.off}` : '') +
        (report.efforts.notAttempted.length ? `  ${c.yellow}not attempted: ${report.efforts.notAttempted.join(', ')}${c.off}` : ''))
    }
  } else if (result) console.log(`${NL}${c.dim}${toolingOnly ? describeTooling(result) : repoBrokerOnly ? describeRepoBroker(result) : readFenceOnly ? describeReadFence(result) : hygieneOnly ? describeHygiene(result) : fenceOnly ? describeFence(result) : describe(result)}${c.off}`)
  if (ledger.costUnknownCalls) {
    console.log(`  ${c.yellow}!${c.off} ${c.dim}${harnessId} reported no cost for ${ledger.costUnknownCalls} call(s), so the spend threshold could not protect you — the invocation cap did${c.off}`)
  }
  console.log(`${c.dim}cli version${c.off} ${report.cliVersion ?? 'unknown'}`)
  console.log(`${c.dim}report${c.off} ${path.relative(process.cwd(), file)}`)

  await fs.rm(workspace, { recursive: true, force: true })
  await fs.rm(scratch, { recursive: true, force: true })
  await fs.rm(ledgerDir, { recursive: true, force: true })
}

// Effort mode exits 0 only when EVERY requested level was verified — or, for a
// switch run, when the switch was.
process.exit(efforts.length
  ? (levels.length === efforts.length && levels.every((r) => resumeEffort ? effortSwitchVerified(r) : effortVerified(r)) ? 0 : 1)
  : (result && (toolingOnly ? toolingPassed(result) : repoBrokerOnly ? repoBrokerPassed(result) : readFenceOnly ? readFencePassed(result) : hygieneOnly ? hygienePassed(result) : fenceOnly ? fencePassed(result) : passed(result)) ? 0 : 1))
