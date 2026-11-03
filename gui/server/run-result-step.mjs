import fs from 'node:fs/promises'
import path from 'node:path'

import { withStepReservation } from './step-allocation.mjs'
import { writeAtomic } from './runtime/persistence.mjs'
import * as store from './runtime/store.mjs'
import { explainRun } from './runtime/run-explanation.mjs'
import { runResult } from './runtime/run-result.mjs'
import { ignoredSelftests, ignoredWords } from './runtime/selftest-history.mjs'

/*
 * What a run left behind, written into the issue folder when it ends: a
 * `NNN-result` step with `result.md` (a readable account) and, when the run
 * saved one, `changes.patch`. The issue folder is then the whole story —
 * report, the agents' turns, and what came of them — for a person reading it.
 *
 * It is keyed by `run-result:<runId>`, so a later end of the same run (a
 * blocked run resumed or finalized) rewrites the same folder in place rather
 * than adding another. Keyed steps count as engine-written by provenance,
 * which keeps this out of the next run's agent input exactly like old agent
 * turns are kept out (runtime/current-window.mjs).
 */

const PATCH_LIMIT = 10 * 1024 * 1024
const ENDED = ['completed', 'blocked', 'failed', 'cancelled']

// Cost, as the panel reports it: time as hh:mm:ss and tokens in millions.
const hms = (ms) => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}
const mtok = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return null
  const m = Number(n) / 1e6
  return `${m >= 10 ? m.toFixed(1) : m >= 0.01 ? m.toFixed(2) : m >= 0.0001 ? m.toFixed(4) : m === 0 ? '0' : '<0.0001'} M tokens`
}

/** The account itself, as Markdown. Exported for tests. */
export function renderResult (run, outputs = {}, { approvedPatch = false } = {}) {
  const e = explainRun(run, { outputs }) ?? { headline: run.status }
  const result = runResult(run, outputs)
  const steps = (run.steps ?? []).map((s) => s.number)
  const lines = [
    `# ${e.headline}`,
    '',
    `Run \`${run.runId}\` · ${run.playbook?.title ?? run.playbook?.id ?? 'playbook'} · ${run.status}${result.resultLabel ? ` · ${result.resultLabel}` : ''}`,
    ''
  ]
  // The page shortens the coordinator's reasoning; the record keeps all of it.
  const reasoning = Object.entries(outputs).filter(([, o]) => o?.valid && o.contract === 'closureConfirmation')
    .sort(([x], [y]) => Number(x) - Number(y)).at(-1)?.[1]?.output?.reasoning
  const detail = run.blockedReason === 'closure-conditions-unmet' && reasoning ? reasoning : e.detail
  if (detail) lines.push(detail, '')
  if (e.cause) lines.push('```text', e.cause, '```', '')
  // Unfenced operation (macOS under the install's opt-in) is part of what the run was.
  if (run.unfenced) {
    lines.push('## Unfenced run', '', `${run.unfenced.reason}. Seats ran as ${run.unfenced.seats}, local checks ${run.unfenced.checks}, tooling commands ${run.unfenced.tooling}: nothing but each CLI's own sandbox confined them.`, '')
  }
  if (e.unmet?.length) {
    lines.push('## Not met', '')
    for (const u of e.unmet) lines.push(`- ${u.id ? `**${u.id}**: ` : ''}${u.text ?? 'not met'}`)
    lines.push('')
  }
  const d = run.delivery
  lines.push('## What reached the project', '')
  if (run.artifactApplication?.verified) lines.push(`The saved patch was applied to \`${run.artifactApplication.path}\` and verified.`)
  else if (!d) lines.push('Nothing was delivered.')
  else if (!d.completedAt) lines.push(`Delivery did not complete${d.error ? `: ${d.error}` : '.'}`)
  else if (d.action === 'apply-to-source') lines.push(`Applied to \`${d.application?.path ?? 'the project'}\` and verified; not committed.`)
  else if (d.action === 'worktree-diff') lines.push('Saved as a patch; the project itself was not changed.')
  else if (d.action === 'commit') lines.push(`Committed on \`${d.branch}\`${run.integration?.mergeCommit ? ` and merged into \`${run.integration.targetBranch}\`` : ', not merged'}.`)
  else if (d.action === 'in-place') lines.push('Changed directly in the project checkout.')
  else if (d.action === 'none') lines.push('The report is the result; no files changed.')
  if (d?.artifactRef) lines.push('', 'The change is in `changes.patch` next to this file.')
  if (approvedPatch) lines.push('', 'The approved revision\'s patch is in `changes.patch` next to this file: its check artifact, verified against the revision\'s fingerprint. It reached no project.')
  lines.push('')
  const asked = run.ownerInput
  if (asked?.questions?.length) {
    lines.push('## Asked before starting', '')
    for (const q of asked.questions) {
      const answer = asked.answer?.answers?.[q.id]
      lines.push(`- **${q.id}** ${q.question}${q.recommendation ? ` — recommended: ${q.recommendation}` : ''}${answer ? `\n  - answered: ${answer}` : ''}`)
    }
    lines.push('')
  }
  if (asked?.split?.length) {
    lines.push('## Proposed split', '')
    for (const [i, part] of asked.split.entries()) lines.push(`${i + 1}. **${part.title}**: ${part.scope}`)
    if (asked.answer?.split) lines.push('', `The owner ${asked.answer.split === 'accept' ? 'accepted the split' : 'declined the split'}.`)
    lines.push('')
  }
  // Technical choices the coordinator made instead of asking; the owner may overrule them.
  const assumptions = Object.entries(outputs).filter(([, o]) => o?.valid && o.contract === 'handoff' && o.output?.assumptions?.length)
    .sort(([x], [y]) => Number(x) - Number(y)).flatMap(([n, o]) => o.output.assumptions.map((a) => ({ ...a, step: n })))
  if (assumptions.length) {
    lines.push('## Assumptions made', '')
    for (const a of assumptions) lines.push(`- ${a.decision} — ${a.reason} (step ${String(a.step).padStart(3, '0')})`)
    lines.push('')
  }
  const risks = run.closure?.residualRisks ?? []
  if (risks.length) {
    lines.push('## Left open', '')
    for (const r of risks) lines.push(`- ${r.accepted === false ? '**needs follow-up**: ' : 'accepted: '}${r.description}`)
    lines.push('')
  }
  const accepted = run.closure?.acceptedCheckRisk
  if (accepted) {
    lines.push('## Accepted check failures', '', `${accepted.by} accepted these failures on revision \`${accepted.revision}\`. The checks did not pass, so this is not verified. Reason: ${accepted.reason}`, '')
    for (const f of accepted.failures ?? []) lines.push(`- \`${f.key}\`${f.message ? ` — ${f.message}` : ''}`)
    for (const id of accepted.notRun ?? []) lines.push(`- \`${id}\` did not run because of them`)
    lines.push('')
  }
  // Failures the unchanged project has too: they did not block this run. Each
  // may deserve an issue of its own; nothing is opened automatically.
  const inherited = run.closure?.checks?.baselineKnown ?? []
  if (inherited.length) {
    lines.push('## Baseline-known check failures', '', 'These also fail on the unchanged project, so they did not block this run. Each may be proposed as a separate issue.', '')
    for (const f of inherited) lines.push(`- \`${f.command}\`${f.test === '(command)' ? '' : `: ${f.test}`}${f.message && f.test !== '(command)' ? ` — ${f.message}` : ''}`)
    lines.push('')
  }
  // The gate passed over these on history's word; the report says so, since one may be a real regression.
  const ignored = ignoredSelftests(run)
  if (ignored.length) {
    lines.push('## Unstable selftests ignored by the gate', '')
    for (const f of ignored) lines.push(`- ${ignoredWords(f)}`)
    lines.push('')
  }
  if (e.next || e.kept) lines.push('## Next', '', [e.kept, e.next].filter(Boolean).join(' '), '')
  const used = run.budgets?.used ?? {}
  lines.push('## Record', '',
    `- Steps of this run: ${steps.length ? `${steps[0]}–${steps.at(-1)} (${steps.length})` : 'none'}`,
    `- Time: ${hms(run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : null) ?? '—'}${run.timing?.agentMs ? ` (${hms(run.timing.agentMs)} in agents)` : ''}`,
    `- Tokens: ${mtok(used.tokens) ?? 'not reported'}`,
    `- Started ${run.startedAt ?? '—'}, ended ${run.endedAt ?? '—'}`,
    `- Everything else (prompts, outputs, runtime logs, evidence) is under \`runs/${run.runId}/\`.`,
    '')
  return lines.join('\n')
}

/**
 * Write (or rewrite) the result step of one run. Returns the step folder, or
 * null when the run has not ended. Never throws for a missing optional piece:
 * a run that failed at launch still gets its account.
 */
export async function writeRunResultStep ({ issuePath, runId, projectPath = null }) {
  const run = await store.readRun(issuePath, runId).catch(() => null)
  if (!run || !ENDED.includes(run.status)) return null
  const outputs = await store.readOutputs(issuePath, runId).catch(() => ({}))
  // A check artifact that does not verify is simply not carried, like any other missing piece.
  // Imported here: apply-artifact loads launch and the engine, and this module is reached from
  // issues.js, so a static import would load them into read-only tools such as tools/overview.mjs.
  const { approvedCheckPatch } = await import('./runtime/apply-artifact.mjs')
  const approved = await approvedCheckPatch({ issuePath, runId, projectPath }).catch(() => null)
  const source = approved?.file ?? (run.delivery?.artifactRef ? path.join(store.runDir(issuePath, runId), run.delivery.artifactRef) : null)
  let patch = null
  if (source) {
    const stat = await fs.stat(source).catch(() => null)
    // The limit is the delivered copy's: an approved check artifact is the same bytes /patch serves, whatever their size.
    if (stat?.isFile() && (approved || stat.size <= PATCH_LIMIT)) patch = await fs.readFile(source)
  }
  const text = renderResult(run, outputs, { approvedPatch: Boolean(approved && patch) })
  return withStepReservation(issuePath, { slug: 'result', invocationId: `run-result:${runId}` }, async (entry) => {
    const folder = path.join(issuePath, entry.folder)
    await fs.mkdir(folder, { recursive: true })
    await writeAtomic(path.join(folder, 'result.md'), text)
    // A later end may have left no patch: one an earlier end copied must not stand for this one.
    if (patch) await writeAtomic(path.join(folder, 'changes.patch'), patch)
    else await fs.rm(path.join(folder, 'changes.patch'), { force: true })
    return folder
  })
}
