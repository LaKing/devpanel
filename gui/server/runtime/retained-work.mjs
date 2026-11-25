import fs from 'node:fs/promises'
import path from 'node:path'
import * as store from './store.mjs'
import { readRegularFile } from './persistence.mjs'
import { seedApplies, undeliveredApproval, readSeedPatch } from './carry-forward.mjs'
import { walkWindowInputs, windowBudget } from './current-window.mjs'
import { retainedArtifactCandidates, firstVerified, retainedReason, undeliveredApprovedRevision, returnedServable } from './apply-artifact.mjs'
import { acceptedReviews, checkSchedule } from './engine.mjs'
import { isModulesTarget, undeclaredModulesReason, countsForClosure } from './modules-tier.mjs'

/*
 * What a follow-up start would build on, for the start preview (preview.mjs): the earlier run and
 * revision the launch rules select, which case applies, the findings recorded against it and the
 * checks the new candidate gets. Read-only: run records, outputs and opens of retained files; no git,
 * no agent, nothing written. It decides nothing: provisioning asks carry-forward.mjs again at launch,
 * and Accumulate captures its window then (execution-contract.md "Retained work in the start preview").
 *
 * - seed: the selector's choice (carry-forward.mjs undeliveredApproval), whether this start would
 *   apply it at all (seedApplies, the launch's own decision), and its file read as provisioning
 *   reads it, without blocking (readSeedPatch).
 * - candidates: each earlier run's patch Accumulate would carry, with the ways to reach it — included
 *   by this start's Accumulate, included if Accumulate were turned on (the same capture walk with the
 *   same resolved budget, current-window.mjs walkWindowInputs, writing nothing), or a download whose
 *   bytes match a runtime-recorded digest (apply-artifact.mjs). One with no way to reach it is a
 *   diagnostic, never a reusable candidate.
 * - label: seed, retained-candidate, both, or none; a seed that cannot be read is said beside it.
 */
const NOTE = 'The preview does not say the patch applies cleanly. Launch decides the seed again when it provisions; the new candidate goes through review, the checks above and delivery as configured.'

/** The checks the new candidate gets, and their timing only when they will run (D′). */
export function checksOutlook (resolved, coverage = null, projectId = null) {
  const checks = resolved.checks ?? {}
  const target = checks.target ?? null
  const base = { requirement: checks.requirement ?? 'none', target: target ? { kind: target.kind ?? null, tier: target.tier ?? null } : null, schedule: null }
  if (resolved.workspace?.isolation === 'in-place') return { ...base, state: 'not-run', detail: 'In-place work runs no checks: they rebuild the candidate from base plus patch, and in-place work has neither.' }
  if (!target) {
    return checks.requirement === 'none' || !checks.requirement
      ? { ...base, state: 'none', detail: 'This playbook configures no check.' }
      : { ...base, state: 'unavailable', detail: `Checks are ${checks.requirement}, but no check target is configured.` }
  }
  if (isModulesTarget(target) && !target.modules) return { ...base, state: 'unavailable', detail: undeclaredModulesReason(projectId) }
  if (coverage?.state === 'unavailable') return { ...base, state: 'unavailable', detail: coverage.detail ?? 'What the modules tier would test could not be read.' }
  const schedule = checkSchedule(resolved)
  // Revision checks run only after a step that records a revision: a playbook with none (Analysis) checks nothing.
  if (!schedule.length) return { ...base, state: 'not-run', detail: 'This playbook records no candidate revision, so no revision check runs.' }
  const detail = checks.requirement === 'none'
    ? 'Checks run at the times below and gate nothing (requirement none).'
    : `Checks are ${checks.requirement}; the timing below is each phase's default with the exceptions the engine applies.`
  // The configured identities of what runs: each tier's command ids, a tier only when the schedule runs it.
  const ids = (list) => (Array.isArray(list) ? list : []).map((x) => typeof x === 'string' ? x : x?.id).filter(Boolean)
  const commands = []
  if (target.tiers?.smoke && schedule.some((ph) => String(ph.default).startsWith('smoke-'))) commands.push({ tier: 'smoke', ids: ids(target.tiers.smoke) })
  const targeted = target.tiers?.targeted
  if (targeted && schedule.some((ph) => ph.exceptions.some((e) => e.id === 'targeted-on-repair'))) commands.push({ tier: 'targeted', ids: ids([targeted.command, ...(targeted.always ?? [])]) })
  commands.push({ tier: isModulesTarget(target) ? 'modules' : 'full', ids: [...ids(target.commands), ...ids(target.finallyCommands)] })
  return { ...base, state: 'configured', detail, schedule, commands }
}

/** The run's recorded delivery return, when it is an object; anything else is no return. */
function returnOf (run) {
  const first = Array.isArray(run?.deliveryReturns) ? run.deliveryReturns[0]?.from : null
  const from = first ?? run?.pendingDeliveryReturn?.from
  return from && typeof from === 'object' ? from : null
}

async function readRuns (issuePath) {
  const entries = await fs.readdir(store.runsDir(issuePath), { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e })
  const runs = []
  const unreadableRuns = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('worktree-') || entry.name.startsWith('workspace-')) continue
    // Read-only: a damaged journal is reported, never persisted as a recovery finding (AC10). No run.json
    // is a directory that holds no run; anything else (EACCES on the directory or the file, a FIFO in
    // its place, a record that does not parse) is a run that exists and cannot be read.
    try {
      runs.push(await store.readRunReadOnly(issuePath, entry.name))
    } catch (error) {
      if (error.code !== 'ENOENT') unreadableRuns.push({ runId: entry.name, code: error.code ?? 'unparseable' })
    }
  }
  return { runs: runs.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''))), unreadableRuns }
}

/** A link to the original artifact, or the reason there is none (AC1). */
async function linkFor (issuePath, run, artifact, revision) {
  if (!artifact || !revision) return { artifact: null, revision: revision ?? null, reason: 'the existing patch routes cannot serve a revision-bound patch for this run' }
  const resolved = await retainedArtifactCandidates({ issuePath, run, artifact, revision })
  if (resolved.refused) return { artifact: null, revision, reason: retainedReason(resolved.refused) }
  const found = await firstVerified(resolved.candidates)
  if (found.bytes) return { artifact, revision, runId: run.runId, size: found.size, sha256: found.sha256 }
  return { artifact: null, revision, reason: found.skipped.map((s) => retainedReason(s.reason)).join('; '), skipped: found.skipped.map(({ ref, reason }) => ({ ref, reason })) }
}

/** The artifact `/runs/:id/patch`'s writer copied into changes.patch, as an original (never the copy). */
function changesPatchArtifact (run) {
  if (run.delivery?.artifactRef) return { artifact: 'delivery', revision: run.delivery.reconstruction?.verified === true ? run.delivery.reconstruction.fingerprint : null }
  const approved = undeliveredApprovedRevision(run)
  return approved ? { artifact: 'check', revision: approved.fingerprint } : { artifact: null, revision: null }
}

/** A run's outputs, each file read on its own: one that does not parse drops itself, not the rest. */
async function readOutputsEach (issuePath, runId) {
  const dir = path.join(store.runDir(issuePath, runId), 'outputs')
  const names = await fs.readdir(dir).catch(() => [])
  const outputs = {}
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    // Non-blocking and regular files only: a FIFO in an output's place drops itself, it never stalls the preview.
    const value = await readRegularFile(path.join(dir, name), 'utf8').then(JSON.parse, () => undefined).catch(() => undefined)
    if (value !== undefined) outputs[name.replace(/\.json$/, '')] = value
  }
  return outputs
}

/** Recorded open findings of one run, each tied to the evidence it came from (AC3). */
async function findingsOf (issuePath, run) {
  // Read apart from the open findings: a malformed reconciliation entry costs only the reconciliation.
  const reconciliation = (() => {
    try {
      const last = Array.isArray(run.reconciliations) ? run.reconciliations.at(-1) : null
      const found = Array.isArray(last?.auditorFindings) ? last.auditorFindings.filter((f) => f && typeof f === 'object') : []
      if (!found.length) return null
      return { n: last.n ?? null, state: last.state ?? null, mergedRevision: last.revision ?? null, approvedRevision: last.from ?? null,
        items: found.map((f) => ({ id: f.id ?? null, severity: f.severity ?? null, blocking: typeof f.blocking === 'boolean' ? f.blocking : null, description: f.description ?? null })) }
    } catch { return null }
  })()
  if (!Array.isArray(run.outstandingFindings)) return { state: 'unknown', detail: 'This run records no open findings field.', items: [], reconciliation }
  // Outputs and the snapshot are read apart: a closure finding's revision needs only the return record
  // and the confirmation's output; review provenance needs the snapshot too.
  const outputs = await readOutputsEach(issuePath, run.runId)
  let group = null
  try {
    group = acceptedReviews({ snapshot: await store.readSnapshot(issuePath, run.runId), run, outputs }).group
  } catch { group = null }
  const items = run.outstandingFindings.filter((f) => f && typeof f === 'object').map((f) => {
    const base = { id: f.id, severity: f.severity ?? null, blocking: typeof f.blocking === 'boolean' ? f.blocking : null, description: f.description ?? null }
    if (f.source === 'plan-review') return { ...base, provenance: { source: 'plan-review', against: 'plan', raisedInStep: f.raisedInStep ?? null, revision: null } }
    if (f.source === 'closure-confirmation') {
      // raisedInStep is the engine's return decision; the confirmation it came from, and the
      // revision that confirmation examined, are on the run's closureReturns entry and its output.
      const back = (Array.isArray(run.closureReturns) ? run.closureReturns : []).find((r) => String(r.step) === String(f.raisedInStep))
      const confirmed = back?.confirmationStep != null ? outputs[back.confirmationStep]?.output : null
      return { ...base, provenance: { source: 'closure-confirmation', raisedInStep: f.raisedInStep ?? null, confirmationStep: back?.confirmationStep ?? null, revision: confirmed?.revision ?? null } }
    }
    const from = group?.find((x) => (x.out.output.findings ?? []).some((g) => g.id === f.id))
    return { ...base, provenance: from ? { source: 'review', step: from.step.number, role: from.step.role, revision: from.out.output.artifactRevision ?? null } : { source: 'review', revision: null, matched: false } }
  })
  if (!items.length && !group?.length) return { state: 'unknown', detail: 'This run recorded no accepted review, so whether anything is open is not known.', items: [], reconciliation }
  return { state: 'recorded', items, reconciliation }
}

function priorCheckOf (run, revision) {
  if (!revision) return null
  const last = [...(Array.isArray(run.checkHistory) ? run.checkHistory : [])].reverse().find((c) => c?.revision === revision && countsForClosure(c))
  return last ? { revision, result: last.result ?? null, gating: last.gating ?? null, at: last.at ?? null } : { revision, result: null, gating: null, at: null }
}

export async function retainedWork ({ issuePath, resolved, coverage = null, projectId = null }) {
  const { runs, unreadableRuns } = await readRuns(issuePath)
  const byId = new Map(runs.map((r) => [r.runId, r]))
  const diagnostics = unreadableRuns.map(({ runId, code }) => ({ runId, unreadable: code, reason: `the run could not be read (${code}); the seed selector skips it, and a window capture would stop on it` }))

  // --- the seed: the launch's own two decisions --------------------------------
  const applies = seedApplies({ participants: resolved.participants, isolation: resolved.workspace?.isolation, stagedRelease: resolved.release?.mode === 'production' })
  let selection = null
  try {
    selection = await undeliveredApproval(issuePath, null, { readRun: store.readRunReadOnly })
  } catch (error) {
    diagnostics.push({ reason: `which earlier run a seed would come from could not be read (${error.code ?? error.message})` })
  }
  let seed = null
  let seedArtifact = null
  if (selection) {
    const run = byId.get(selection.runId)
    // Return metadata is read defensively: an obsolete or malformed pointer means the seed is the delivery's.
    const from = returnOf(run)
    const artifact = typeof from?.artifactRef === 'string' && path.resolve(store.runDir(issuePath, selection.runId), from.artifactRef) === selection.patch ? 'returned' : 'delivery'
    seedArtifact = artifact
    const probe = await readSeedPatch(selection.patch, { probe: true })
    seed = {
      runId: selection.runId, revision: selection.revision, reason: selection.reason, applies: applies.applies, notApplied: applies.reason,
      state: probe.state, code: probe.code ?? null,
      outcome: probe.state === 'available' ? 'applied to the new worktree at launch: cleanly, merged three-way, with conflict markers, or handed over as context only (decided then)' : 'context-only: the approved patch could not be read',
      link: run ? await linkFor(issuePath, run, artifact, selection.revision).catch((error) => ({ artifact: null, revision: selection.revision, reason: `the run's record could not be read for a link (${error.message})` })) : { artifact: null, revision: selection.revision, reason: 'run.json could not be read' }
    }
    if (!applies.applies) diagnostics.push({ runId: seed.runId, reason: `this start would not seed (${applies.reason}); the selector names run ${seed.runId} revision ${seed.revision}, its patch ${seed.state}` })
    else if (probe.state !== 'available') diagnostics.push({ runId: seed.runId, reason: `the selected seed is ${probe.state}${probe.code ? ` (${probe.code})` : ''}: launch hands it over as context only` })
  }

  // --- candidates: what Accumulate would carry, and how to reach each ------------
  const selected = resolved.runOptions?.accumulate === true
  // The Accumulate prediction is one reading among several: whatever stops it (a reservation file or a run
  // record that does not parse, an unreadable input) stops only it, never the seed, links or findings.
  let walk
  try {
    walk = await walkWindowInputs({ issuePath, runId: null, budget: windowBudget(resolved.windowLimits ?? {}), accumulate: true, read: false, readRun: store.readRunReadOnly })
  } catch (error) {
    walk = { prior: [], stopped: { code: error.code ?? null, message: error.message }, failed: true }
  }
  if (walk.stopped) diagnostics.push({ reason: walk.failed ? `what Accumulate would carry could not be read (${walk.stopped.message}); a window capture would stop there too` : `a window capture would fail on an input (${walk.stopped.code ?? walk.stopped.message}): nothing after it is included` })
  const candidates = []
  const notListed = walk.stopped ? `capture-fails:${walk.stopped.code ?? 'error'}` : 'not-listed'
  // One run's malformed record costs that run's entries only, never the preview (AC3).
  const candidatesOf = async (run) => {
    const last = Array.isArray(run.revisions) ? run.revisions.at(-1)?.fingerprint ?? null : null
    const entries = []
    for (const item of walk.prior.filter((p) => p.runId === run.runId && ['changes.patch', 'candidate.patch'].includes(p.name))) {
      const { artifact, revision } = item.name === 'changes.patch' ? changesPatchArtifact(run) : { artifact: 'check', revision: last }
      // A capture that would throw on any input returns no window at all: nothing, before or after it, reaches the launch.
      const inclusion = !resolved.tactic ? 'no-window' : walk.stopped ? `capture-fails:${walk.stopped.code ?? 'error'}` : item.state
      const link = await linkFor(issuePath, run, artifact, revision)
      // Each access path is judged by its own bytes: an empty copy does not hide a non-empty original.
      const access = []
      if (inclusion === 'included' && item.size > 0) access.push(selected ? 'accumulate' : 'accumulate-if-enabled')
      if (link.artifact && link.size > 0) access.push('download')
      entries.push({ item, artifact, revision, inclusion, link, access })
    }
    for (const e of entries) {
      const entry = { runId: run.runId, name: e.item.name, revision: e.revision, approved: e.item.name === 'changes.patch', size: e.item.size ?? null, accumulate: { included: e.inclusion === 'included', reason: e.inclusion, selected }, link: e.link, access: e.access }
      if (e.access.length) candidates.push(entry)
      else diagnostics.push({ runId: run.runId, name: e.item.name, revision: e.revision, reason: `retained, but Accumulate would omit it (${e.item.size === 0 ? 'empty' : e.inclusion}) and it has no verified download (${e.link.artifact ? 'the original is empty' : e.link.reason})` })
    }
    // Every original the run recorded, discovered on its own and not through the walk (AC1, AC7): the
    // delivered patch, the patch a delivery returned, and the check original of the last revision (the
    // resolver's own history and migration rules), each unless an entry above already asked for it.
    const approved = undeliveredApprovedRevision(run)?.fingerprint ?? null
    const from = returnOf(run)
    const originals = []
    if (typeof run.delivery?.artifactRef === 'string') originals.push({ name: 'changes.patch', artifact: 'delivery', revision: changesPatchArtifact(run).revision, approved: true })
    // A returned patch is served only while it is the selected seed (the route's own decision, returnedServable),
    // and that one is the seed, linked above: a returned patch is never offered as a separate candidate.
    if (typeof from?.artifactRef === 'string' && !returnedServable(seed, run.runId, from.revision)) {
      diagnostics.push({ runId: run.runId, name: 'returned.patch', revision: typeof from.revision === 'string' ? from.revision : null, reason: 'a patch a delivery returned is served only while it is the selected seed, and it is not' })
    }
    if (last) originals.push({ name: 'candidate.patch', artifact: 'check', revision: last, approved: approved === last, quiet: true })
    for (const o of originals) {
      if (entries.some((e) => e.artifact === o.artifact && e.revision === o.revision)) continue
      // The selected seed's own original is the seed, linked above; another source of the same revision
      // (a check original beside a missing delivery seed) is examined on its own.
      if (seed && run.runId === seed.runId && o.revision === seed.revision && o.artifact === seedArtifact) continue
      const link = await linkFor(issuePath, run, o.artifact, o.revision)
      if (link.artifact && link.size > 0) {
        candidates.push({ runId: run.runId, name: o.name, revision: o.revision, approved: o.approved, size: link.size, accumulate: { included: false, reason: notListed, selected }, link, access: ['download'] })
      } else if (!(o.quiet && link.reason === retainedReason('revision-not-recorded'))) {
        diagnostics.push({ runId: run.runId, name: o.name, revision: o.revision, reason: `the run recorded ${o.artifact === 'check' ? `a check candidate of revision ${o.revision}` : o.artifact === 'returned' ? 'a patch a delivery returned' : 'a delivered patch'}, but it cannot be used: ${link.artifact ? 'it is empty' : link.reason}` })
      }
    }
  }
  for (const run of runs.filter((r) => ['completed', 'blocked', 'failed', 'cancelled'].includes(r.status) && r.startedAt)) {
    try { await candidatesOf(run) } catch (error) {
      diagnostics.push({ runId: run.runId, reason: `this run's record could not be read for retained work (${error.message}); the other runs are shown` })
    }
  }

  // --- label --------------------------------------------------------------------
  const labels = []
  if (seed?.applies && seed.state === 'available') labels.push('seed')
  if (candidates.length) labels.push('retained-candidate')
  if (!labels.length) labels.push('none')

  // --- evidence runs: chosen apart from artifacts --------------------------------
  const ended = runs.filter((r) => ['completed', 'blocked', 'failed', 'cancelled'].includes(r.status))
  const evidenceIds = []
  if (selection) evidenceIds.push(selection.runId)
  else {
    // The latest run with something recorded, else the latest ended run at all, whose findings
    // state (recorded, or unknown) is then said explicitly (AC3).
    const latest = ended.filter((r) => r.revisions?.length || r.outstandingFindings?.length || r.reconciliations?.length).at(-1) ?? ended.at(-1)
    if (latest) evidenceIds.push(latest.runId)
  }
  const primary = candidates.at(-1)?.runId
  if (primary && !evidenceIds.includes(primary)) evidenceIds.push(primary)
  const evidence = []
  for (const id of evidenceIds) {
    const run = byId.get(id)
    if (!run) continue
    const revision = Array.isArray(run.revisions) ? run.revisions.at(-1)?.fingerprint ?? null : null
    // Each part read apart: a malformed field makes that part unknown, never the preview.
    let findings
    try { findings = await findingsOf(issuePath, run) } catch (error) {
      findings = { state: 'unknown', detail: `This run's findings could not be read (${error.message}).`, items: [], reconciliation: null }
    }
    let priorCheck = null
    try { priorCheck = priorCheckOf(run, revision) } catch { priorCheck = null }
    evidence.push({ runId: id, status: run.status, startedAt: run.startedAt ?? null, revision, findings, priorCheck })
  }

  const findings = unreadableRuns.length
    ? { state: 'unknown', unreadableRuns: unreadableRuns.map((u) => u.runId), detail: `${unreadableRuns.length} run record${unreadableRuns.length === 1 ? '' : 's'} could not be read (${unreadableRuns.map((u) => `${u.runId}: ${u.code}`).join(', ')}), so whether findings are open is not known${evidence.length ? '; the findings shown come from the readable runs only' : ''}.` }
    : evidence.length ? null : { state: 'none', detail: 'No earlier run of this issue has ended, so no findings are recorded.' }
  return { state: 'read', labels, seed, candidates, accumulate: { selected, captures: Boolean(resolved.tactic) }, evidence, findings, diagnostics, checks: checksOutlook(resolved, coverage, projectId), note: NOTE }
}
