#!/usr/bin/env node
/*
 * Dry-run preview, rendered for reading.
 *
 *   node server/runtime/preview-cli.mjs <playbook> [--issue <project>/<issue-id>] [--prompts]
 *
 * Side-effect free: nothing is invoked, probed, locked or created.
 */
import { previewRun, symbolic } from './preview.mjs'
import { continuationPlan } from './baseline-cache.mjs'
import { projectPath } from '../project-path.mjs'

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const value = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const playbookId = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--issue')

const c = {
  dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m', off: '\x1b[0m'
}
const sym = (s) => `${c.magenta}${s}${c.off}`
const head = (s) => console.log(`\n${c.bold}${s}${c.off}`)

if (!playbookId) {
  console.error('usage: preview-cli.mjs <playbook> [--issue <project>/<issue-id>] [--prompts]')
  process.exit(2)
}

// Loading an issue is a read; it creates nothing.
let issue = null
let project = null
const issueRef = value('--issue')
if (issueRef) {
  const [projectId, ...rest] = issueRef.split('/')
  const issues = await import('../issues.js')
  const found = await issues.getIssue(projectId, rest.join('/'))
  issue = { name: found.name, openedOn: found.openedOn, path: found.path, project: found.project, sizing: found.sizing ?? null }
  project = { id: projectId, path: projectPath(projectId) }
}

const p = await previewRun({ playbookId, issue, project })

if (!p.ok) {
  console.log(`${c.red}${playbookId} does not resolve${c.off}`)
  for (const e of p.errors) console.log(`  ${c.red}✗${c.off} ${e.message}  ${c.dim}${e.file ?? ''} ${e.field ?? ''}${c.off}`)
  process.exit(1)
}

console.log(`${c.cyan}${c.bold}${p.playbook.id}${c.off} v${p.playbook.version}  ${c.dim}→ ${p.strategy.id} v${p.strategy.version}${c.off}`)
console.log(`${c.dim}dry run — nothing is invoked, probed, locked or created${c.off}`)
console.log(`${c.dim}config${c.off} ${p.configHash}`)

head('Participants')
for (const q of p.participants) {
  const ver = q.verification === 'verified' ? `${c.green}verified${c.off}` : `${c.yellow}unverified${c.off}`
  const eff = q.effort ?? `${c.dim}no effort setting${c.off}`
  console.log(`  ${q.role.padEnd(12)} ${q.model} ${c.dim}(${q.wireModel})${c.off}`)
  console.log(`  ${' '.repeat(12)} ${c.dim}via${c.off} ${q.connection.label}  ${c.dim}effort${c.off} ${eff}  ${ver}${q.writesCode ? `  ${c.dim}[sole writer]${c.off}` : ''}`)
  if (q.connection.endpointRef || q.connection.credentialRef) {
    console.log(`  ${' '.repeat(12)} ${c.dim}refs${c.off} ${[q.connection.endpointRef, q.connection.credentialRef].filter(Boolean).join('  ')}`)
  }
  console.log(`  ${' '.repeat(12)} ${c.dim}live auth${c.off} ${sym(q.liveAuthentication)}`)
}

head('Plan')
for (const phase of p.phases) {
  const loop = phase.loop
    ? `  ${c.dim}loop ≤${phase.loop.maxRounds} rounds until${c.off} ${phase.loop.until}`
    : ''
  console.log(`  ${String(phase.order).padStart(2)}. ${c.bold}${phase.id}${c.off}${loop}`)
  for (const step of phase.steps) {
    const guard = step.when ? ` ${c.dim}when${c.off} ${step.when}` : ''
    const rev = step.recordsRevision ? ` ${c.dim}[fingerprints the candidate]${c.off}` : ''
    const together = step.concurrent ? ` ${c.dim}[runs at once with the adjacent concurrent steps]${c.off}` : ''
    console.log(`      ${step.id.padEnd(28)} ${c.dim}${step.role}${c.off}${guard}${rev}${together}`)
    if (step.promptSource.kind === 'template') {
      console.log(`        ${c.dim}prompt${c.off}  ${step.promptSource.template}`)
    } else {
      console.log(`        ${c.dim}prompt${c.off}  ${sym(step.promptSource.slot)}`)
    }
    if (step.output) console.log(`        ${c.dim}output${c.off}  ${step.output} → ${sym(step.outputSlot)}`)
    const runtime = step.context.filter((x) => x.availability === 'runtime')
    if (runtime.length) console.log(`        ${c.dim}needs${c.off}   ${runtime.map((x) => sym(x.slot)).join(' ')}`)
    const known = step.context.filter((x) => x.availability === 'now')
    if (known.length) console.log(`        ${c.dim}context${c.off} ${known.map((x) => x.ref).join(' ')}`)
  }
  for (const b of phase.branches) {
    console.log(`      ${c.yellow}branch${c.off} ${c.dim}if${c.off} ${b.when} ${c.dim}→${c.off} ${b.to} ${c.dim}(${b.outcome})${c.off}`)
  }
}

head('Limits')
console.log(`  ${c.dim}budgets${c.off}  ${Object.entries(p.limits.budgets).map(([k, v]) => `${k}=${v}`).join('  ')}`)
console.log(`  ${c.dim}rounds${c.off}   ${p.limits.rounds.map((r) => `${r.phase}=${r.maxRounds}`).join('  ')}`)
console.log(`  ${c.dim}repair${c.off}   ≤${p.reviewPolicy.protocolRepair.maxAttempts} attempts, then ${p.reviewPolicy.protocolRepair.onExhausted}`)
console.log(`  ${c.dim}workspace${c.off} ${p.workspace.isolation}${p.workspace.onUnsupported === 'block' ? `, blocks if unsupported` : ''}; base ${typeof p.workspace.base === 'object' ? `commit ${p.workspace.base.commit}` : p.workspace.base} (${p.workspace.baseSource}), symlinks ${p.workspace.symlinks}${p.workspace.excludes?.length ? `, excludes ${p.workspace.excludes.join(' ')}` : ''}`)

head('Verification and closure')
console.log(`  ${c.dim}checks${c.off}     requirement=${p.checks.requirement}  target=${p.checks.target?.kind ?? `${c.yellow}none${c.off}`}`)
if (p.checks.target?.tiers) {
  const ids = [...(p.checks.target.commands ?? []), ...(p.checks.target.finallyCommands ?? [])].map((x) => x.id)
  console.log(`  ${c.dim}smoke${c.off}      every revision, beside the reviews: ${p.checks.target.tiers.smoke.join(', ')}`)
  const targeted = p.checks.target.tiers.targeted
  if (targeted) console.log(`  ${c.dim}targeted${c.off}   instead of the smoke, on a repair revision whose failing tests are named: ${targeted.run} (for ${targeted.command}), with ${targeted.always.join(', ') || 'nothing else'}; closure never counts it`)
  console.log(`  ${c.dim}full${c.off}       once, on the approved revision; closure counts only this: ${ids.join(', ')}`)
  const continuing = continuationPlan(p.checks.target)
  if (continuing.refusal) console.log(`  ${c.dim}continue${c.off}   no: the full drive runs from scratch (${continuing.refusal})`)
  else {
    console.log(`  ${c.dim}continue${c.off}   the full drive continues the smoke's running instance, kept ${continuing.keepSeconds}s: skips ${continuing.smokeRun.join(', ')}; runs ${continuing.run.join(', ') || 'no command'}, then every finalizer`)
    if (continuing.outOfPosition.length) console.log(`  ${c.dim}order${c.off}      out of declared position: ${continuing.outOfPosition.map((o) => `${o.id} (declared before ${o.declaredBefore.join(', ')})`).join('; ')}`)
    if (continuing.declaredBeforeServices.length) console.log(`  ${c.yellow}warning${c.off}    ${continuing.declaredBeforeServices.join(', ')} will run after the service started: if the service depends on it at boot, or it needs the service down, set tiers.continueSmoke: false or declare it later`)
  }
} else if (p.checks.target) console.log(`  ${c.dim}timing${c.off}     ${p.checks.target.timing ?? 'every-revision'}`)
if (p.checks.target?.baselineCache) {
  const b = p.checks.target.baselineCache
  console.log(`  ${c.dim}baseline${c.off}   cached across runs (issues/<project>/.baselines), exact key: base commit, target hash, ${b.files?.length ? `files ${b.files.join(' ')}, ` : ''}environment command; keeps ${b.maxEntries ?? 12} entries, ${b.maxAgeDays ?? 14} days`)
}
console.log(`  ${c.dim}delivery${c.off}   ${p.delivery.action}${p.delivery.revalidateBeforeDelivery ? `, revalidated first` : ''}`)
console.log(`  ${c.dim}autoClose${c.off}  ${p.autoClose.minimumVerification} ${c.dim}(from ${p.autoClose.source})${c.off}`)
console.log(`  ${c.dim}requires${c.off}   ${p.completion.requires.join(', ')}`)

if (flag('--prompts')) {
  head('Strategy-owned prompts')
  for (const [name, prompt] of Object.entries(p.prompts)) {
    console.log(`\n  ${c.bold}${name}${c.off} ${c.dim}${prompt.hash.slice(0, 23)}${c.off}`)
    const body = prompt.rendered.split(String.fromCharCode(10))
      .map((l) => '    ' + l.replace(/«[^»]+»/g, (m) => sym(m)))
      .join(String.fromCharCode(10))
    console.log(body)
  }
}

for (const [category, title] of [['blocking', 'Cannot start'], ['outcome', 'Will not close automatically'], ['information', 'Execution details']]) {
  const entries = p.prerequisites.filter((pre) => pre.category === category)
  if (!entries.length) continue
  head(title)
  for (const pre of entries) console.log(`  ${category === 'information' ? c.dim + '·' + c.off : `${c.yellow}!${c.off}`} ${pre.detail}`)
}
console.log(`\n  ${p.configurationReady ? `${c.green}no known startup blockers${c.off}` : `${c.yellow}startup is blocked${c.off}`} ${c.dim}— preflight still has to prove installation, authentication and model access${c.off}`)
