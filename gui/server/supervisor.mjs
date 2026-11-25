import { acceptCheckUnavailable, awaitsAutoFinalize, awaitsAutoResume, awaitsRestart, awaitsSetup, continueUnavailable, integrateUnavailable, reconcilePending, refreshChecksUnavailable, resumeUnavailable, retryInputUnavailable, ownerLossRecoverable, restoreConfigRecovery, enterRecovery, leaveRecovery, SERVICE_SHUTDOWN } from './runtime/run-control.mjs'
import { writeRunResultStep } from './run-result-step.mjs'
import { resumeArchivedCoverageNotes, resumeCoverageNotes, stagingRunCoverage, writeRunCoverageNotes } from './staging-coverage.mjs'
import { launchPreconditions } from './launch-preconditions.mjs'
import { createPathOverlap, deliveryActionOf, worthRecording } from './runtime/path-overlap.mjs'
import { modulesTarget, projectInfrastructure, stagingTarget } from './infrastructure.mjs'
import { isModulesTarget } from './runtime/modules-tier.mjs'
import { coverageInput, modulesCoverage as coverageReading } from './runtime/modules-coverage.mjs'
import { projectPath as projectDir, projectsRoot, resolveProjectPath } from './project-path.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { preflight, assertLaunchable } from './config/preflight.mjs'
import { hostSettings } from './config/host-settings.mjs'
import {
  abandonReservation,
  pauseReservation,
  discardWorkspace,
  gitWorktreeProvider,
  provisionRun,
  recordPreflight,
  releaseOwnership,
  removeRunWorkspace,
  reserveRun,
  resumeRun,
  workspaceUnchanged,
  worktreeDiffDelivery
} from './runtime/launch.mjs'
import { FINALIZABLE_BLOCKS, HARNESS_LOAD_FAILURES, harnessUnavailable } from './runtime/engine.mjs'
import { reconcileUnavailable } from './runtime/source-reconcile.mjs'
import { planDeletedRun, retireRefs } from './runtime/ref-retention.mjs'
import { autoReconcileRefusal } from './runtime/auto-reconcile.mjs'
import { LockHeld, acquire, ownerLiveness, withLock } from './runtime/lock.mjs'
import { admissionLockFile, withIssueLock } from './issue-locks.mjs'
import { NOT_EXCLUSIVE, conflictMessage, conflicts, exclusivityOf, wholeFreeze, wholeFreezeQuick, writesCheckout } from './run-exclusivity.mjs'
import { gitStoreDir } from './runtime/git-store.mjs'
import { createCycleGates } from './cycle-gates.mjs'
import { fencePolicy } from './runtime/confinement-policy.mjs'
import { hostPlatform } from './runtime/platform.mjs'
import { runProcess, terminatePids } from './runtime/process.mjs'
import { openCleanup, noteLostTags, proveEntries, cleanupRefusal, readBarrier, liftBarrierEntries, syncBarrier, unrecordedCleanup, unrecordedRefusal } from './runtime/cleanup-barrier.mjs'
import { createProbeExecutor } from './runtime/probe-budget.mjs'
import { sweepPendingIntegration } from './runtime/integrate.mjs'
import * as store from './runtime/store.mjs'
import { readChat, coordinatorRole, instructionRefusal, chatView, recordInstruction, askCoordinator } from './runtime/coordinator-chat.mjs'
import { captureIntegrity, integrityChanges, readIntegrity } from './runtime/integrity.mjs'
import { createAvailabilityStore } from './runtime/failure.mjs'
import { inspectSourceRepository, repositoryFaultError, usesSourceRepository } from './runtime/source-repository.mjs'
import { resolvePlaybook, loadConfig, engineOnlyRefusal } from './config/load.mjs'
import { resolveWithRelease, selectStagedRelease } from './release-selection.mjs'
import { OVERRIDE_REASON_MAX, PregateHold } from './decisions/pregate.mjs'
import { inquiryState, inquiryPackable, inquiryClosed } from './inquiry.mjs'
import { forgetRunDrives } from './runtime/selftest-history.mjs'
import { destroyRunInstances } from './runtime/stage-instances.mjs'
import { settleRunSyncs, syncDisposition } from './runtime/sync-records.mjs'
import { routeAutoStart } from './auto-start.mjs'
import { poolIdOf, poolOf, poolRecord } from './runtime/module-pool.mjs'
import { conflictsWith, dropReservation, endContinuation, lockedMessage, locksModules, oweEnded, oweReleased, readPoolLocks, readReservations, reclaimRunLocks, releaseModules, releaseRunLocks, reservedAgainst, reserveModules, takeModules, yieldForPause } from './runtime/module-locks.mjs'

/*
 * Owns the lifecycle of running playbooks.
 *
 * Three things this module exists to get right:
 *
 *  - A run is durable and stoppable BEFORE it spends anything. Preflight probes
 *    at model depth, which costs a call per model; doing that outside a run would
 *    leave a window with money going out and nothing to inspect or interrupt.
 *  - Ownership is reconstructed at startup. A run persisted as live whose owner
 *    is gone is not "already stopped" — its true state is unknown, and unknown
 *    means recovery-required, not resolved.
 *  - Handing the issue back and destroying the candidate are separate acts. The
 *    git provider's release is a force-remove; a blocked run that never delivered
 *    holds the only copy of what was written.
 */

const PROJECTS_DIR = projectsRoot()
const HARNESS_DIR = process.env.DEVPANEL_HARNESS_DIR ??
  path.resolve(process.cwd(), '..', 'harness')

/*
 * Preflight probes at model depth, which costs a call per model. That spending
 * is authorised by the act of starting a run — a person pressed a button that
 * says so — but authorised is not unbounded, so the calls are still counted
 * against a ceiling. Diagnostics keep their own, stricter opt-in.
 */
const MAX_PROBE_INVOCATIONS = Number(process.env.DEVPANEL_MAX_PROBE_INVOCATIONS ?? 8)

/** How long a shutdown waits for runs to settle before it stops waiting. */
const SHUTDOWN_GRACE_MS = Number(process.env.DEVPANEL_SHUTDOWN_GRACE_MS ?? 10_000)

/** Statuses that claim a run is being driven by some process right now. */
export const LIVE_STATUSES = ['preflighting', 'pending', 'running', 'stopping']

const err = (status, message, detail = {}) =>
  Object.assign(new Error(message), { status, ...detail })

/**
 * A start refused for what holds the issue, the project or a model right now.
 * It says nothing about the launch's inputs and the identical start can pass once
 * that clears, so the start gate neither guards it nor keeps the attempt's charge.
 */
// A full verification run home's id (issues.js HOME_PATTERN): runs of the cycle, never an issue.
const HOME_PATTERN = /^verification-\d{4}-\d{2}-\d{2}$/

const occupied = (message, detail = {}) => err(409, message, { started: false, retryable: true, ...detail })

export function createSupervisor ({
  issues,
  emit = null,
  harnessDir = HARNESS_DIR,
  projectsDir = PROJECTS_DIR,
  maxProbeInvocations = MAX_PROBE_INVOCATIONS,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  // How soon an automatic reconcile's undecided state is tried again after a failed read or a held lock.
  reconcileRetryMs = 2000,
  configRoot = process.env.DEVPANEL_CONFIG_ROOT,
  // Advisory decisions (docs/decisions.md), both absent unless the server wires
  // them: the Triage pre-gate (decisions/pregate.mjs) and the reclassifier of
  // `runtime` failures (decisions/failure-advisor.mjs).
  pregate = null,
  failureAdvisor = null,
  // The consult panel (consult/consult.mjs): asked by a run before a person is. Optional: without it runs ask as before.
  consult = null,
  // The top-level supervisor's admission of a run's newly recorded non-approving review round
  // ({project, issueId, runId, rows} => {state}); without it runs record rounds and wake nobody.
  onReviewRounds = null,
  // Host-wide memory of exhausted models, beside the issues. One file for every
  // project: a quota burnt by one run is a quota burnt for all of them.
  availabilityFile = path.join(issues.ISSUES_DIR ?? process.env.DEVPANEL_ISSUES_DIR ?? '.', '.availability.json'),
  // The host's OS probes (platform.mjs): lock liveness and the cleanup proof.
  platform = hostPlatform(),
  // How finalize and reconcile load the run they deliver (launch.mjs resumeRun); a test hands in its own
  // to hold one between admission and delivery while a full verification freeze begins.
  resumeEngine = resumeRun,
  // How long a start, resume, recovery or inquiry action waits behind the project's admission lock
  // (another start, or an issue being archived, restored or deleted) before it is refused, retryably.
  admissionWaitMs = 60000,
  // Seams for tests only (deleteRun's wait behind the issue's step lock).
  seams = {},
  // The host's seat fence policy (confinement-policy.mjs), read to tell a contained writing run from one the
  // full verification freezes whole (run-exclusivity.mjs wholeFreeze); injected by tests.
  seatFencePolicy = (p) => fencePolicy({ platform: p }),
  // Where a run's base snapshot is written (runtime/git-store.mjs): a start during a cycle needs one (original AC7).
  gitStoreOf = (project) => gitStoreDir(project)
} = {}) {
  const availability = createAvailabilityStore(availabilityFile)
  const pathOverlap = createPathOverlap({ listProjects: () => issues.listProjects(), listIssues: (project) => issues.listIssues(project) })
  /** Runs this process is driving, keyed by issue. At most one per issue. */
  const active = new Map()
  /** Reservations in flight, so a double-click cannot become two runs. */
  const starting = new Set()
  let shuttingDown = false
  /** Names this process on the markers its runs write: any other owner's marker was left by an earlier server. */
  const instanceId = crypto.randomUUID()
  /** Automatic reconcile markers already attempted: one attempt per marker, whatever a failed write left on disk. */
  const attemptedReconciles = new Set()

  const key = (project, issueId) => `${project}/${issueId}`
  /** An issue, or a full verification run home (issues.getRunHolder); fakes without homes read issues only. */
  const holderOf = (project, issueId) => (issues.getRunHolder ?? issues.getIssue)(project, issueId)
  const homesOf = async (project) => (issues.listRunHomes ? issues.listRunHomes(project).catch(() => []) : [])

  /*
   * The full verification's admission freeze (server/full-verification.mjs,
   * execution-contract.md "Full verification freeze"). It holds only the projects the
   * cycle verifies (its scope: infrastructure.staging plus their module pools, fixed at
   * freeze time); a run of any other project is never asked, refused or waited for.
   * Within the scope, no writing run starts, continues or delivers except the cycle's
   * own; every live writing run is asked to pause at its next step boundary, and no seat
   * turn of it begins. A run that only reads (run-exclusivity.mjs writesCheckout: no
   * delivery, no release, not in place) is left alone and may start.
   */
  let freeze = null
  // The projects the cycle verifies (full-verification.mjs cycleScope), fixed when it froze; null: every project.
  let frozenProjects = null
  // Drives and checkout writes of contained runs wait at these (cycle-gates.mjs); everything else is as before.
  const gates = createCycleGates()
  /** Whether the freeze holds a writing run whole (run-exclusivity.mjs wholeFreeze), from its snapshot and workspace. */
  const wholeOf = async (snapshot, workspace = null) => (await wholeFreeze({ snapshot, workspace, frozen: gates.current(), fence: seatFencePolicy(platform), platform, env: process.env })).whole
  /** Whether a new writing run here could be contained: its turns fenced, no fallback to unfenced, and what the cycle snapshots readable. */
  const startsConfined = () => seatFencePolicy(platform)?.mode === 'fence' && !(platform?.bubblewrap && process.env.DEVPANEL_FENCE_UNPROVED === 'run') && !gates.current()?.unknown
  const snapshotOf = (record) => record.engine?.snapshot ?? record.reservation?.resolution?.resolved ?? record.snapshot ?? null
  const workspaceOf = (record) => record.engine?.run?.workspace ?? record.reservation?.run?.workspace ?? null
  /** Whole without any I/O (wholeFreezeQuick): asked synchronously, before any classification awaits. */
  const quickWhole = (snapshot) => Boolean(wholeFreezeQuick({ snapshot, frozen: gates.current(), fence: seatFencePolicy(platform), platform, env: process.env }))
  /**
   * A record's classification for the cycle frozen now, bound to it (continuation-crosses-thaw): applied only while that
   * cycle is still the active one; a cycle that thawed or was replaced meanwhile leaves the record unclassified for the
   * next. While it is read the record's drives and writes wait at the gates (`classifying`); found whole, its waits end.
   */
  async function classifyFor (record, cycleId, snapshot = snapshotOf(record), workspace = workspaceOf(record)) {
    if (!cycleId) return null
    if (quickWhole(snapshot)) { Object.assign(record, { whole: true, classifiedFor: cycleId }); gates.release(record.runId); return true }
    record.classifying = cycleId
    let whole
    try { whole = await wholeOf(snapshot, workspace) } catch { whole = true }
    if (record.classifying === cycleId) delete record.classifying
    if (gates.thawed.has(cycleId) || !gates.isActive(cycleId)) return null
    Object.assign(record, { whole, classifiedFor: cycleId })
    if (whole) gates.release(record.runId)
    return whole
  }
  /** At registration: a classification made for another cycle (or none) is not this one's. */
  function adoptClassification (record) {
    if (record.whole !== undefined && record.classifiedFor !== (freeze?.cycleId ?? null)) { delete record.whole; delete record.classifiedFor }
  }
  /**
   * The record's classification for the cycle frozen now, read until it belongs to that cycle (continuation-crosses-thaw,
   * handoff-requests-new-cycle-before-classification): one made for an earlier cycle, or none (a cycle that froze or
   * was replaced during the reading), is read again. `recheck` reads a contained decision once more against `workspace`
   * (provisional-workspace-classification); a whole one stands. Not applicable although that cycle is still the frozen
   * one: held whole, never read again in a loop. Nothing is awaited after its last look at `freeze`.
   */
  async function classifyNow (record, snapshot, workspace, { recheck = false } = {}) {
    let reread = recheck
    for (;;) {
      adoptClassification(record)
      const c = freeze?.cycleId
      if (!c || !frozenFor(record.project) || ofCycle(record) || !writes(record)) return
      if (record.whole === true || (record.whole === false && !reread)) return
      reread = false
      await classifyFor(record, c, snapshot, workspace)
      if (record.whole === undefined && freeze?.cycleId === c) Object.assign(record, { whole: true, classifiedFor: c })
    }
  }
  /** Whether the cycle frozen now classified this record whole: the only freeze request a handoff makes of its own. */
  const wholeForNow = (record) => frozenFor(record.project) && !ofCycle(record) && writes(record) && record.whole === true && record.classifiedFor === freeze?.cycleId
  /**
   * Original AC7: a start may proceed during a cycle only if it needs no write before its delivery. Provisioning pins the
   * base (refs/devpanel/base/<run>), writes its objects and registers a worktree in its destination repository: the
   * host's Git store for a private-repository run (fence.repository 1) when it keeps one, else the project's own
   * repository (launch.mjs cut, privateRepositories). A start whose destination is in what the cycle snapshots is
   * refused; one that cannot be read counts as in it (snapshot-preflight-writes).
   */
  async function provisionDestination (project, projectPath, resolved) {
    const store = resolved?.fence?.repository === 1 ? gitStoreOf(project) : null
    if (store) return store
    const out = await runProcess({ command: 'git', args: ['-C', projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'] }).catch(() => null)
    const dir = out?.code === 0 ? String(out.stdout ?? '').trim() : ''
    return dir ? await fs.realpath(dir).catch(() => dir) : null
  }
  async function provisionWritesSnapshot (project, projectPath, resolved) {
    const destination = await provisionDestination(project, projectPath, resolved)
    return destination ? gates.touchesSnapshot([destination]) : true
  }
  /**
   * Provisioning of a run already reserved (admitted before the cycle, or resumed in preflight): a write ticket for its
   * destination, taken at the gate with nothing awaited between it and provisionRun, so the cycle drains it (busy) or it
   * waits for the cycle (snapshot-preflight-writes). The wait is on the reservation's record, excused like any cycle wait;
   * a stop meanwhile ends it. An unreadable destination is asked as the project checkout itself.
   */
  async function provisionTicket (record, projectPath) {
    const destination = await provisionDestination(record.project, projectPath, snapshotOf(record))
    const gate = gates.gateFor(record)
    const run = record.reservation.run
    for (;;) {
      const answer = gate.tryWrite([destination ?? projectPath], { action: 'provisioning' })
      if (answer.ticket) return answer.ticket
      const token = answer.wait
      const id = `provisioning:${token.cycleId}:${token.seq}`
      run.cycleWait = { kind: 'write', action: 'provisioning', cycleId: token.cycleId, repositories: token.repositories, since: token.from, id }
      await writeReservation(record).catch(() => {})
      emit?.({ type: 'run-cycle-wait', project: record.project, issueId: record.issueId, runId: record.runId, phase: 'start' })
      try {
        await gates.waitFor(token, record.controller.signal)
      } finally {
        if (run.cycleWait?.id === id) run.cycleWait = null
        ;(run.cycleWaits ??= []).push({ kind: 'write', action: 'provisioning', cycleId: token.cycleId, repositories: token.repositories, from: token.from, to: token.ended?.to ?? new Date().toISOString(), endSeq: token.ended?.endSeq ?? null, id, outcome: token.ended ? 'thawed' : 'stopped' })
        await writeReservation(record).catch(() => {})
        emit?.({ type: 'run-cycle-wait', project: record.project, issueId: record.issueId, runId: record.runId, phase: 'end' })
      }
    }
  }
  /** A record the freeze waits for whole: in place, release, unreadable, reaching the snapshot; or not classified. */
  const wholeRecord = (record) => record.whole !== false
  const freezeRefusal = () => Object.assign(err(409, `Admission is closed to writing runs of the projects the full verification verifies (cycle ${freeze?.cycleId ?? 'ending'}, since ${freeze?.at ?? 'now'}): no run of those that can write the checkout starts, continues or delivers until the cycle ends.`, { code: 'FULL_VERIFICATION_FREEZE', cycleId: freeze?.cycleId ?? null }), { started: false, retryable: true })
  const freezeAsk = (cycleId) => ({ cycleId, at: new Date().toISOString() })
  /** Whether a project is in the scope of the cycle that froze; a project outside it is never frozen, asked or waited for. */
  const inScope = (project) => !frozenProjects || frozenProjects.has(project)
  /** Whether admission is closed for this project's writing runs. */
  const frozenFor = (project) => Boolean(freeze) && inScope(project)
  /** Only the runs of the cycle that closed admission are exempt; an earlier cycle's run is frozen like any other. */
  const ofCycle = (record) => Boolean(freeze && record.cycleId && record.cycleId === freeze.cycleId)
  /** Whether a record this process drives can write the checkout; one that does not say is taken to write. */
  const writes = (record) => record.writes !== false
  /*
   * Writing operations admitted but not in `active` yet (a start, a finalize or a reconcile still
   * preparing), from `starting.add` to `active.set`, keyed like `active`: the freeze lists them
   * and the cycle waits for them, so none is invisible when it takes its snapshot. A finalize that
   * reaches its delivery after the freeze began is refused there (finalize's re-check).
   */
  const pendingWrites = new Map()
  // Automatic reconciles a freeze refused: run once each when admission opens again.
  const deferredReconciles = new Map()
  /** Ask one run this process drives to stop at its next boundary for the cycle. Synchronous for an engine. */
  function freezeRecord (record) {
    // Only a record this cycle classified whole is asked: one left unclassified by a cycle change is never asked for the newer cycle.
    if (!freeze || !wholeForNow(record)) return null
    if (record.engine) return record.engine.requestFreeze(freeze.cycleId)
    record.freezeRequested = freezeAsk(freeze.cycleId)
    record.reservation.run.freezeRequested ??= record.freezeRequested
    return writeReservation(record)
  }
  /**
   * The reservation's run.json, written in order: each write serializes the reservation as it stands when its turn
   * comes, so a freeze request's write can never land after the thaw's clearing write (incomplete-cycle-bound).
   */
  function writeReservation (record) {
    const next = (record.reservationWrites ?? Promise.resolve()).catch(() => {}).then(() => store.writeRun(record.issuePath, record.runId, record.reservation.run))
    record.reservationWrites = next
    return next
  }
  /** Close admission for a cycle and ask every live writing run to pause; returns the runs and pending writing operations asked. */
  async function freezeAdmission (cycleId, { projects, hosts = [], snapshotted = null } = {}) {
    if (freeze && freeze.cycleId !== cycleId) throw err(409, `admission is already closed for cycle ${freeze.cycleId}`)
    if (gates.thawed.has(cycleId)) return []
    if (!freeze || projects !== undefined) frozenProjects = Array.isArray(projects) ? new Set(projects) : null
    freeze = { ...freezeAsk(cycleId), projects: frozenProjects ? [...frozenProjects] : null }
    gates.setFreeze({ cycleId, projects: frozenProjects ? [...frozenProjects] : null, hosts, snapshotted })
    // Each live writing run of the scope: classified now (whole or contained), and only a whole one is asked to stop.
    const records = [...active.values()].filter((record) => !ofCycle(record) && writes(record) && inScope(record.project))
    const asked = []
    const persisted = []
    const ask = (record) => {
      persisted.push(Promise.resolve(freezeRecord(record)).catch((error) => console.warn(`[devpanel] the freeze request of ${record.project}/${record.issueId} run ${record.runId} was not persisted: ${error.message}`)))
      asked.push({ project: record.project, issueId: record.issueId, runId: record.runId })
    }
    // Whole without any reading (in place, release, unreadable, unconfined): asked to stop now, synchronously, before any
    // classification awaits, as before this freeze waited for anything (whole-freeze-installation). The others wait at
    // the gates while they are read (`classifying`), none passing as if whole.
    const reading = []
    for (const record of records) {
      if (quickWhole(snapshotOf(record))) { Object.assign(record, { whole: true, classifiedFor: cycleId }); ask(record) } else { delete record.whole; record.classifying = cycleId; reading.push(record) }
    }
    for (const record of reading) {
      // Applied only while this cycle is the active one (classifyFor); a thaw meanwhile leaves the record alone.
      const whole = await classifyFor(record, cycleId)
      if (whole && !gates.thawed.has(cycleId)) ask(record)
    }
    // A freeze the cycle's bound interrupted meanwhile announces nothing; what it asked is taken back by the thaw.
    if (gates.thawed.has(cycleId)) { await Promise.all(persisted); return [] }
    for (const p of pendingWrites.values()) if (inScope(p.project)) asked.push({ project: p.project, issueId: p.issueId, runId: p.runId, phase: p.phase, pending: true })
    await Promise.all(persisted)
    if (!gates.thawed.has(cycleId)) emit?.({ type: 'admission-frozen', cycleId })
    return asked
  }
  function thawAdmission (cycleId = null) {
    if (freeze && cycleId && freeze.cycleId !== cycleId) return false
    const ended = cycleId ?? freeze?.cycleId ?? null
    // The cycle's waits end, in the order they began; nothing of it is applied any more (cycle-gates.mjs).
    if (ended) gates.thaw(ended)
    freeze = null
    frozenProjects = null
    if (ended) for (const record of active.values()) clearFreezeRequest(record, ended)
    emit?.({ type: 'admission-thawed', cycleId })
    // What the freeze put off, once each.
    const deferred = [...deferredReconciles.values()]
    deferredReconciles.clear()
    for (const d of deferred) autoReconcile(d.project, d.issueId, d.runId, d.at)
    // Held automatic integration recoveries: their wait ends with the thaw's stamps and the recovery runs again.
    const integrations = [...deferredIntegrations.values()]
    deferredIntegrations.clear()
    for (const d of integrations) resumeIntegration(d)
    return true
  }
  /**
   * After the thaw, one held integration recovery (integration-recovery): its wait's end is written under the issue's run
   * lock, after the wait's start has landed (the sweep that held it wrote the start under that lock and released it only
   * after), so the open wait can never be written after its end; then the recovery runs again. A lock held by another
   * owner (the sweep that held it, still unwinding, or a live run) is waited for and asked again, never given up after one try.
   */
  const lockRetries = 12
  const lockDelay = (i) => new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** i, 30_000)).unref?.())
  function resumeIntegration (d) {
    ;(async () => {
      await d.recorded
      for (let i = 0; ; i++) {
        let lock
        try {
          lock = await acquire(path.join(d.issuePath, '.run.lock'), { purpose: 'integration-recovery-wait', runId: d.runId, mkdir: false, platform })
        } catch (error) {
          if (!(error instanceof LockHeld) || i + 1 >= lockRetries) throw error
          await lockDelay(i)
          continue
        }
        try {
          await noteOperatorWait({ project: d.project, issueId: d.issueId, runId: d.runId, action: 'integration-recovery', repositories: d.repositories, token: d.token, phase: 'end' })
        } finally {
          await lock.release().catch(() => {})
        }
        break
      }
      let swept
      for (let i = 0; ; i++) {
        swept = await sweepPendingIntegration({ issuePath: d.issuePath, runId: d.runId, platform, hooks: { cycleGate: sweepGate(d.project, d.issueId, d.runId, d.issuePath) } })
        // Held by another owner of the lock: asked again. Held by a newer cycle: that cycle's thaw runs it (sweepGate).
        if (!(swept?.held && swept.settled?.refused?.code === 'RUN_LOCKED') || i + 1 >= lockRetries) break
        await lockDelay(i)
      }
      noteIntegrationSweep(swept, d.project, { id: d.issueId, path: d.issuePath }, d.runId)
    })().catch((error) => console.warn(`[devpanel] the held integration recovery of ${d.project}/${d.issueId} run ${d.runId} could not run after the thaw: ${error.message}`))
  }
  /**
   * The writing runs this process drives, and the writing operations still being admitted: until none is
   * left, a seat turn or a delivery may write the checkout. Read-only runs are not waited for.
   */
  const busy = () => [
    // Runs the cycle waits for whole (a contained run in seat turns is never listed: its turns write only its worktree).
    ...[...active.values()].filter((r) => !ofCycle(r) && writes(r) && inScope(r.project) && wholeRecord(r)).map((r) => ({ project: r.project, issueId: r.issueId, runId: r.runId, phase: r.phase, kind: 'run' })),
    ...[...pendingWrites.values()].filter((p) => inScope(p.project)).map((p) => ({ project: p.project, issueId: p.issueId, runId: p.runId, phase: p.phase, pending: true, kind: 'admission', since: p.since })),
    // A write into a repository the cycle snapshots, under way; a drive in flight on a staging host it drives on, of any run.
    ...gates.pending().filter((t) => (t.kind === 'write' && inScope(t.project) && gates.touchesSnapshot(t.repositories)) || (t.kind === 'drive' && gates.isCycleHost(t.host)))
      .map((t) => ({ project: t.project, issueId: t.issueId, runId: t.runId, phase: t.kind, kind: t.kind, since: t.since, ...(t.host ? { host: t.host } : {}), ...(t.action ? { action: t.action } : {}) }))
  ]
  /**
   * Committing project actions of the scope still holding their action lock (project-actions.mjs records the
   * effect in the lock itself, so one is visible from the moment it holds it, from the panel or the CLI).
   */
  async function busyActions () {
    if (!freeze || !issues.ISSUES_DIR) return []
    const projects = frozenProjects ? [...frozenProjects] : (await issues.listProjects().catch(() => [])).map((p) => p.id ?? p)
    const found = []
    for (const project of projects) {
      const file = path.join(issues.ISSUES_DIR, project, '.actions', '.lock')
      const held = await fs.readFile(file, 'utf8').then(JSON.parse, () => null)
      if (!held || held.purpose !== 'project-action') continue
      if (held.effect !== undefined && held.effect !== 'commit-checkout') continue
      if (await ownerLiveness(held.owner, { platform }).catch(() => 'unknown') === 'dead') continue
      found.push({ project, kind: 'project-action', action: held.action ?? null, since: held.acquiredAt ?? null })
    }
    return found
  }
  /** At a thaw: the ended cycle's freeze request leaves every place it sits (a live engine, a reservation in preflight). */
  function clearFreezeRequest (record, cycleId) {
    if (record.engine) {
      Promise.resolve(record.engine.clearFreeze?.(cycleId)).catch((error) => console.warn(`[devpanel] the freeze request of run ${record.runId} could not be cleared: ${error.message}`))
      if (record.freezeRequested?.cycleId === cycleId) delete record.freezeRequested
      return
    }
    let changed = false
    if (record.freezeRequested?.cycleId === cycleId) { delete record.freezeRequested; changed = true }
    if (record.reservation?.run?.freezeRequested?.cycleId === cycleId) { delete record.reservation.run.freezeRequested; changed = true }
    if (changed && record.reservation) writeReservation(record).catch((error) => console.warn(`[devpanel] the freeze request of run ${record.runId} could not be cleared: ${error.message}`))
  }
  /**
   * The write gate of an operator's operation on a run's candidate (integrate, integration recovery, apply-artifact):
   * `(repositories) => ticket`, waiting for a full verification that snapshots one of them; `onWait(token)` hears a wait begin.
   */
  function writeGateFor ({ project, issueId, runId, action }, onWait = null) {
    const gate = gates.gateFor({ project, issueId, runId, writes: true, whole: false })
    // `held`: a ticket of the same operation already admitted (a nested write passes on it when the cycle drains it).
    return async (repositories, { held = null } = {}) => {
      for (;;) {
        const answer = gate.tryWrite(repositories, { action, held })
        if (answer.ticket) return answer.ticket
        const token = answer.wait
        onWait?.(token)
        // On the run record and in its explanation while it lasts, and among its excused waits once it ends (original AC3).
        await noteOperatorWait({ project, issueId, runId, action, repositories, token, phase: 'start' })
        try {
          await gates.waitFor(token)
        } finally {
          await noteOperatorWait({ project, issueId, runId, action, repositories, token, phase: 'end' })
        }
      }
    }
  }
  /**
   * The automatic integration sweep's gate: it never waits. A publication whose checkouts a cycle snapshots is left for a
   * later sweep (FULL_VERIFICATION_WAIT, held like a locked run), so the sweep loop goes on and nothing is written.
   */
  // Held automatic integration recoveries, re-run by the thaw (as deferred reconciles are), each wait on its run record.
  const deferredIntegrations = new Map()
  function sweepGate (project, issueId, runId, issuePath) {
    const gate = gates.gateFor({ project, issueId, runId, writes: true, whole: false })
    return async (repositories) => {
      const answer = gate.tryWrite(repositories, { action: 'integration-sweep' })
      if (answer.ticket) return answer.ticket
      const key = `${project}/${issueId}/${runId}`
      if (!deferredIntegrations.has(key)) {
        // Written under the sweep's run lock, which is released only after it lands; the thaw awaits it before the end.
        const entry = { project, issueId, runId, issuePath, repositories, token: answer.wait }
        entry.recorded = noteOperatorWait({ project, issueId, runId, action: 'integration-recovery', repositories, token: answer.wait, phase: 'start' })
        deferredIntegrations.set(key, entry)
        await entry.recorded
      }
      throw Object.assign(new Error('a full verification snapshots this checkout: the publication is settled after it ends'), { code: 'FULL_VERIFICATION_WAIT' })
    }
  }
  /** Whether an open wait is the one `id` opened (one recorded before ids were kept: by its cycle). */
  const ownsWait = (open, id, cycleId) => Boolean(open) && (open.id ? open.id === id : open.cycleId === cycleId)
  /** An operator operation's cycle wait, recorded through the run's live engine when it has one, else on its stored record. */
  async function noteOperatorWait ({ project, issueId, runId, action, repositories, token, phase }) {
    const stamps = { from: token.from, to: token.ended?.to ?? null, cycleId: token.cycleId, endSeq: token.ended?.endSeq ?? null }
    const live = [...active.values()].find((r) => r.runId === runId && r.engine?.noteCycleWait)
    try {
      const id = `operator:${token.cycleId}:${token.seq}`
      if (live) return await live.engine.noteCycleWait({ phase, id, action, repositories, ...stamps })
      const holder = await holderOf(project, issueId)
      const run = await store.readRun(holder.path, runId)
      if (phase === 'start') run.cycleWait = { kind: 'write', action, cycleId: token.cycleId, repositories, since: token.from, id }
      else {
        // Only the wait this token opened is closed: a newer cycle's open wait, written meanwhile, stays (integration-recovery).
        if (ownsWait(run.cycleWait, id, token.cycleId)) run.cycleWait = null
        if (!(run.cycleWaits ?? []).some((w) => w.id === id)) (run.cycleWaits ??= []).push({ kind: 'write', action, repositories, ...stamps, id, to: stamps.to ?? new Date().toISOString(), outcome: token.ended ? 'thawed' : 'stopped' })
      }
      await store.writeRun(holder.path, runId, run)
      emit?.({ type: 'run-cycle-wait', project, issueId, runId, phase })
    } catch (error) {
      console.warn(`[devpanel] the full verification wait of run ${runId} (${action}) could not be recorded: ${error.message}`)
    }
  }
  /** Whether the freeze holds a stored run whole, read from its snapshot and record (an unreadable one is). */
  async function wholeStoredRun (project, issueId, runId) {
    const holder = await holderOf(project, issueId).catch(() => null)
    const snapshot = holder ? await store.readSnapshot(holder.path, runId).catch(() => null) : null
    const stored = holder ? await store.readRun(holder.path, runId).catch(() => null) : null
    return wholeOf(snapshot, stored?.workspace ?? null)
  }
  /** A request whose cycle is no longer the active freeze is never applied (after a thaw, or read back after a restart). */
  const activeRequest = (request) => Boolean(request && gates.isActive(request.cycleId))
  /** Before a contained run's drive waits, everything it holds on staging goes (AC6): the idle runs of the scope, at the freeze. */
  async function releaseIdle () {
    const failed = []
    // Only what stands on the hosts the cycle drives on: an instance on another host may be in use by a permitted drive.
    const hosts = (gates.current()?.hosts ?? []).map((h) => h.host).filter(Boolean)
    if (!hosts.length) return failed
    for (const record of [...active.values()]) {
      if (!freeze || !record.engine || wholeRecord(record) || !inScope(record.project)) continue
      // Read again for each run, right before its cleanup: a drive admitted before the freeze (a ticket on a cycle host) keeps what it drives.
      if (gates.pending().some((t) => t.kind === 'drive' && t.runId === record.runId && hosts.includes(t.host))) continue
      const ok = await Promise.resolve(record.engine.releaseHeld?.('full-verification', { hosts })).catch(() => false)
      if (ok === false) failed.push({ project: record.project, issueId: record.issueId, runId: record.runId, pendingRemovals: record.engine.run?.pendingRemovals ?? [] })
    }
    return failed
  }

  /*
   * In-place runs whose open cleanup entries the project barrier file could not
   * be written with, by project directory: admission stays closed on them all
   * the same (P3-3), and every in-place admission tries the write again. The
   * run records are what makes this durable: reconcile rebuilds the barrier
   * from them at every start.
   */
  const unrecorded = new Map()
  async function keepOnBarrier (projectDir, run) {
    if (!run) return
    const dir = path.resolve(projectDir)
    const held = unrecorded.get(dir) ?? new Map()
    try {
      await syncBarrier(dir, run, { at: new Date().toISOString(), by: 'supervisor' })
      held.delete(run.runId)
    } catch (error) {
      held.set(run.runId, { run, error: error.message })
    }
    if (held.size) unrecorded.set(dir, held)
    else unrecorded.delete(dir)
  }
  /** The open entries held here for a project, after writing them again from the run's record as it is now. */
  async function unrecordedBarrier (projectDir) {
    const dir = path.resolve(projectDir)
    for (const { run } of [...(unrecorded.get(dir)?.values() ?? [])]) {
      const now = await store.readRun(path.join(dir, run.issue?.id ?? ''), run.runId).catch(() => null)
      await keepOnBarrier(dir, now ?? run)
    }
    return [...(unrecorded.get(dir)?.values() ?? [])].flatMap(({ run, error }) => openCleanup(run).map((e) => ({
      issueId: run.issue?.id ?? null, runId: run.runId, tag: e.tag, structural: e.structural, unrecorded: error
    })))
  }

  /**
   * The project's durable admission lock (Phase 4, R4-2): start, resume,
   * recovery, finalize, inquiry close/acknowledge/reopen and inquiry packing
   * all take it, so their checks and the state they change cannot interleave —
   * across processes too (pid, boot id and start time, dead-owner proof).
   * Pack, restore and delete of an issue take it too (issues.js); a caller that
   * already holds it passes `admissionHeld`. Held past the wait: ISSUE_BUSY (409, retryable).
   */
  // The project is validated BEFORE the lock path is built from it: the lock
  // creates its directory, and a name such as `..` would put it outside issues/.
  const admission = async (project, fn) => {
    if (!issues.ISSUES_DIR) return fn()
    await issues.requireProject(project)
    return withIssueLock(admissionLockFile(issues.ISSUES_DIR, project), { purpose: 'admission', waitMs: admissionWaitMs, mkdir: true }, fn)
  }

  /** A closed inquiry is terminal until reopened; an inquiry runs only as one. */
  function inquiryAdmission (issue, { playbookId = null, runOptions = null } = {}) {
    if (inquiryClosed(issue)) throw err(409, `inquiry ${issue.id} is closed (${issue.inquiry.closure.action} of run ${issue.inquiry.closure.runId}); reopen it before starting or continuing a run`)
    if (playbookId === null) return
    if (issue.kind === 'inquiry' && (playbookId !== 'analysis' || runOptions?.inquiry !== true)) throw err(409, 'an inquiry runs only the analysis playbook as an inquiry (preview it through inquire)')
    if (issue.kind !== 'inquiry' && runOptions?.inquiry === true) throw err(409, 'only an inquiry runs as an inquiry')
  }

  /** Cache loaded harness modules by path + mtimeMs so repeated runs do not leak V8 ESM entries. */
  const harnessCache = new Map()

  /**
   * Every adapter in the harness directory, keyed by its filename.
   *
   * Enumerated rather than listed: an adapter that exists on disk but is not
   * named here would look, to a roster entry that references it, exactly like
   * one that was never written.
   */
  async function loadHarnesses () {
    const adapters = {}
    Object.defineProperty(adapters, HARNESS_LOAD_FAILURES, { value: {} })   // not enumerable: callers list the adapters
    let files = []
    try {
      files = (await fs.readdir(harnessDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
        .map((e) => e.name)
    } catch {
      return adapters
    }
    for (const file of files) {
      const id = file.slice(0, -4)
      if (['shared', 'fence', 'config-guard', 'mcp-devpanel'].includes(id)) continue   // helpers and the broker's MCP shim, not runtimes
      const fullPath = path.join(harnessDir, file)
      try {
        const mtimeMs = (await fs.stat(fullPath)).mtimeMs
        const cached = harnessCache.get(fullPath)
        if (cached && cached.mtimeMs === mtimeMs) {
          adapters[id] = cached.mod
        } else {
          const mod = await import(`${fullPath}?t=${mtimeMs}`)
          harnessCache.set(fullPath, { mtimeMs, mod })
          adapters[id] = mod
        }
      } catch (error) { adapters[HARNESS_LOAD_FAILURES][id] = error }
    }
    return adapters
  }

  const probeFor = (harnesses) => createProbeExecutor({
    load: async (harnessId) => {
      const adapter = harnesses[harnessId]
      if (!adapter) throw new Error(harnessUnavailable(harnesses, harnessId) ?? `no adapter for harness "${harnessId}"`)
      return adapter
    },
    allowPaid: true,
    maxInvocations: maxProbeInvocations
  })

  // ---------------------------------------------------------------- starting

  /**
   * Reserve a run and return. Everything expensive happens afterwards, inside a
   * run the caller can already see and stop.
   */
  async function start ({ project, issueId, playbookId, expectConfigHash = null, runOptions = {}, configRoot: root = configRoot, supervisorLaunchId = null, pregateOverride = null, cycle = null, signal = null }) {
    if (shuttingDown) throw Object.assign(err(503, 'the server is shutting down'), { started: false, retryable: true })
    // The cycle's own runs pass; a start of another cycle never does. Whether any other start
    // writes is known once its playbook resolves, below: a read-only one is admitted while frozen.
    if (freeze && cycle && cycle !== freeze.cycleId) throw freezeRefusal()
    const k = key(project, issueId)

    // Two guards, because they fail differently: this one catches a double-click
    // in one process, the run lock catches a second process. One live run per
    // issue; other issues of the project may run beside it (run-exclusivity.mjs).
    if (starting.has(k)) throw occupied('a run is already being started for this issue')
    if (active.has(k)) throw occupied('a run is already active for this issue', { runId: active.get(k).runId })
    starting.add(k)
    // Taken to write until its playbook says otherwise: a freeze beginning now waits for it.
    if (!cycle) pendingWrites.set(k, { project, issueId, runId: null, phase: 'start', since: new Date().toISOString() })

    let reservation
    let harnesses
    let projectPath
    let pregateRecord = null
    let startOverlap = null
    let home = false
    let modulePool = null
    let moduleExpected = []
    let startContained = false
    try { await admission(project, async () => {
      const issue = await holderOf(project, issueId)
      home = Boolean(issue.home)
      if (issue.packed) throw err(409, 'This issue is archived. Restore it before starting or continuing a run.')
      // A run home takes the cycle's own runs and nothing else; only those run as the full verification.
      if (home !== Boolean(cycle)) throw err(409, home ? 'a full verification run home takes runs only from the cycle' : 'only the full verification cycle starts a run in a run home')
      if (Boolean(runOptions?.fullVerification) !== home) throw err(409, 'runOptions.fullVerification is set by the full verification cycle, for its own runs only')
      inquiryAdmission(issue, { playbookId, runOptions })
      projectPath = await resolveProjectPath(project, { projectsDir })
      harnesses = await loadHarnesses()
      // A model this host has seen exhausted is not started again before its
      // recorded reset. Checked before anything is reserved, so a refused start
      // leaves no failed run behind.
      // A production release names the green staging release it promotes; when the
      // operator named none, it is filled here from the newest one whose content
      // is the checkout's (release-selection.mjs), as the preview showed.
      let stagedRelease = null
      const resolution = await resolveWithRelease(playbookId, { root, runOptions, projectId: project },
        async () => (stagedRelease = await selectStagedRelease({ project, projectPath, listIssues: (p, o) => issues.listIssues(p, o) })))
      // An engine-only playbook has no seats and its engine steps are not executed yet: refused before
      // anything is locked, reserved or probed, so no run and no seat step exist (config/load.mjs).
      const engineOnly = resolution.ok ? engineOnlyRefusal(resolution.resolved) : null
      if (engineOnly) throw engineOnly
      // The full verification's freeze holds back what can write the checkout, nothing else.
      // Only a writing run the freeze holds whole is refused: a contained one starts, its drives and writes wait.
      // Bound to the cycle that classified it; a cycle that thawed meanwhile refuses nothing, a newer one classifies again.
      for (let c = freeze?.cycleId; c && frozenFor(project) && !cycle && resolution.ok && writesCheckout(resolution.resolved); c = freeze?.cycleId) {
        const whole = await provisionWritesSnapshot(project, projectPath, resolution.resolved) || await wholeOf(resolution.resolved, null)
        if (freeze?.cycleId !== c) continue
        if (whole) throw freezeRefusal()
        startContained = c
        break
      }
      if (resolution.ok && (!writesCheckout(resolution.resolved) || startContained)) pendingWrites.delete(k)
      // A cycle interrupted while its own start was being admitted creates no run.
      if (signal?.aborted) throw Object.assign(err(409, 'the full verification cycle was interrupted before this start registered'), { code: 'CYCLE_INTERRUPTED', started: false })
      const noGreen = resolution.ok ? resolution.resolved.liveExecution.blockers.find((b) => b.kind === 'no-green-staging') : null
      if (noGreen) throw Object.assign(err(422, noGreen.reason, { code: 'NO_GREEN_STAGING', latestGreen: noGreen.latestGreen ?? null, unverifiable: noGreen.unverifiable ?? [] }), { started: false, retryable: false })
      if (resolution.ok) {
        // Admission serializes reservations, so what this reads cannot race another start.
        const holder = await exclusiveHolder(project, issueId, exclusivityOf(resolution.resolved))
        if (holder) throw occupied(conflictMessage(holder), holder)
        // A coding run shares its project's module pool (module-locks.mjs): a module of the
        // issue another live run holds refuses the start, naming the holder, before anything
        // exists. The supervisor's ready queue shows the same as a module-lock wait.
        if (locksModules(resolution.resolved)) {
          const read = await modulePoolOf(project, root)
          if (read) {
            const expected = issue.sizing?.affectedModules ?? []
            // A recorded decision of a run that waits for its set reserves it (module-locks.mjs readReservations):
            // the waiter is named first, behind whoever holds the module now, so no start overtakes it.
            const poolLocks = await readPoolLocks(read.pool.id)
            const conflicting = [...reservedAgainst(await standingReservations(read.pool.id), poolLocks, expected), ...conflictsWith(poolLocks, expected, { project, issueId })]
            if (conflicting.length) throw occupied(lockedMessage(conflicting), { code: 'MODULE_LOCKED', holders: conflicting })
            modulePool = read
            moduleExpected = expected
          }
        }
        for (const [role, participant] of Object.entries(resolution.resolved.participants)) {
          const cooling = await availability.check(participant.model.id)
          if (cooling) throw occupied(`model ${participant.model.id} (${role}) is exhausted until ${cooling.exhaustedUntil}${cooling.assumed ? ' (assumed hold)' : ''}: ${cooling.reason}${cooling.runId ? ` (observed in run ${cooling.runId})` : ''}. Wait, choose another model, or clear the record.`, { availability: cooling })
        }
      }
      // The source checkout is proven readable before anything is reserved or
      // probed. A checkout git refuses to read is the host's fault, not the
      // run's: no agent could act on it, and every model call preflight would
      // make first is spent on a run that cannot be provisioned. Cleanliness is
      // deliberately not judged here; that is the base policy's decision, made
      // at provisioning time against the tree as it is then.
      if (resolution.ok && usesSourceRepository(resolution.resolved)) {
        const fault = await inspectSourceRepository({ projectPath })
        if (fault) throw repositoryFaultError(fault)
        // The base and symlink policies are judged again at provisioning, which
        // stays the authority. Read here too because provisioning happens after
        // the paid preflight: 13 runs died with 0 steps on a dirty checkout or an
        // escaping link, each after paying to probe its models first.
        const blocked = await launchPreconditions({ projectPath, workspace: resolution.resolved.workspace ?? {}, configHash: resolution.resolved.configHash, selection: resolution.resolved.fence?.selection ?? 0 })
        if (blocked) throw Object.assign(err(422, blocked.message, { code: blocked.code }), { started: false, retryable: false, class: 'environment' })
      }
      // The Triage pre-gate: asked before anything is reserved, so a hold leaves
      // no run behind. Only an operator may start past a hold, and only with a
      // reason; the start then goes ahead and the override is kept with the run.
      if (pregate && resolution.ok && resolution.resolved.tactic === 'triage') {
        let expectKey = null
        if (pregateOverride != null) {
          const reason = typeof pregateOverride.reason === 'string' ? pregateOverride.reason.trim() : ''
          if (!reason || reason.length > OVERRIDE_REASON_MAX) throw err(400, `starting past the pre-gate needs a reason of 1-${OVERRIDE_REASON_MAX} characters`)
          if (pregateOverride.by !== 'operator') throw err(403, 'only an operator can start past the pre-gate')
          expectKey = typeof pregateOverride.expectKey === 'string' ? pregateOverride.expectKey : null
          pregateOverride = { by: 'operator', reason, at: new Date().toISOString() }
        }
        try {
          pregateRecord = await pregate.check({ project, issueId })
          // An override names the hold it was shown; with none holding now there is nothing to override.
          if (expectKey) throw err(409, 'the pre-gate no longer holds this issue', { code: 'PREGATE_CHANGED' })
        } catch (error) {
          if (error instanceof PregateHold && expectKey && error.record?.key !== expectKey) {
            throw err(409, 'the pre-gate decision changed since it was shown', { code: 'PREGATE_CHANGED', pregate: error.pregate })
          }
          if (!(error instanceof PregateHold) || !pregateOverride) throw error
          pregateRecord = error.record
          pregateOverride.held = { gate: error.pregate.gate, confidence: error.pregate.confidence }
        }
      }
      // Read again at the start, whatever a preview said. It informs and refuses
      // nobody: the start goes ahead with the warning on its record.
      if (resolution.ok) {
        const overlap = await pathOverlap({ project, projectPath, issuePath: issue.path, deliveryAction: deliveryActionOf(resolution.resolved) })
        if (worthRecording(overlap)) startOverlap = { ...overlap, by: supervisorLaunchId ? 'supervisor' : 'operator' }
      }
      // The locks first, under the run id the reservation will take, so a refused set leaves no run.
      let moduleLocks = null
      const presetRunId = modulePool ? store.newRunId() : null
      if (modulePool) {
        const startedAt = new Date().toISOString()
        const got = await takeModules({ pool: modulePool.pool.id, modules: moduleExpected, runId: presetRunId, project, issueId, issuePath: issue.path, startedAt, platform })
        if (got.conflicts.length) throw occupied(lockedMessage(got.conflicts), { code: 'MODULE_LOCKED', holders: got.conflicts })
        // Read again once taken: a waiter reserves before its decision is recorded, so a reservation made since the
        // check above is seen here, and the start gives back what it took (it never overtakes a recorded decision).
        const reserved = reservedAgainst(await standingReservations(modulePool.pool.id), await readPoolLocks(modulePool.pool.id), moduleExpected)
        if (reserved.length) {
          await releaseModules({ pool: modulePool.pool.id, held: got.held }).catch(() => {})
          throw occupied(lockedMessage(reserved), { code: 'MODULE_LOCKED', holders: reserved })
        }
        moduleLocks = { pool: modulePool.pool.id, project, issueId, held: got.held, waiting: null, takenAtStart: moduleExpected }
      }
      try {
      reservation = await reserveRun({
        runId: presetRunId,
        moduleLocks,
        modulePool: modulePool?.record ?? null,
        playbookId,
        supervisorLaunchId,
        startOverlap,
        // Name, folder and date travel with the run. Prompts render them, and a
        // coordinator told to read an issue folder needs the folder to be there.
        issue: { project, id: issueId, name: issue.name ?? null, openedOn: issue.openedOn ?? null, path: issue.path },
        issuePath: issue.path,
        configRoot: root,
        expectConfigHash,
        runOptions,
        stagedRelease: stagedRelease?.releaseId ? stagedRelease : null,
        unrecordedBarrier: await unrecordedBarrier(path.dirname(issue.path)),
        fullVerification: cycle ? { cycleId: cycle } : null
      })
      } catch (error) {
        if (moduleLocks) await releaseModules({ pool: moduleLocks.pool, held: moduleLocks.held }).catch(() => {})
        throw error
      }
    }) } catch (error) {
      starting.delete(k)
      pendingWrites.delete(k)
      throw translate(error)
    }

    const record = {
      runId: reservation.runId,
      issuePath: reservation.issuePath,
      project,
      issueId,
      phase: 'preflight',
      engine: null,
      reservation,
      controller: new AbortController(),
      stopping: false,
      finished: null,
      home,
      cycleId: cycle,
      writes: writesCheckout(reservation.resolution?.resolved),
      ...(startContained ? { whole: false, classifiedFor: startContained } : {})
    }
    // Registration: a cycle's start that its bound interrupted meanwhile leaves no live run (its reservation is abandoned).
    if (signal?.aborted) {
      starting.delete(k)
      pendingWrites.delete(k)
      await abandonReservation(reservation, { status: 'cancelled' }).catch(() => {})
      throw Object.assign(err(409, 'the full verification cycle was interrupted before this start registered'), { code: 'CYCLE_INTERRUPTED', started: false })
    }
    active.set(k, record)
    starting.delete(k)
    pendingWrites.delete(k)
    adoptClassification(record)
    // Admitted just before a freeze closed admission: a writing one is classified for it, and asked to pause only if whole.
    if (frozenFor(record.project) && !ofCycle(record) && writes(record)) {
      await classifyNow(record, snapshotOf(record), workspaceOf(record))
      await Promise.resolve(freezeRecord(record)).catch(() => {})
    }
    emit?.({ type: 'run-reserved', project, issueId, runId: record.runId, status: 'preflighting' })

    // The record the start went ahead on, beside the run, for the agreement report.
    if (pregateRecord?.key) {
      if (pregateRecord.status === 'unavailable') console.warn(`triage pre-gate for ${k}: ${pregateRecord.failure?.class}: ${pregateRecord.failure?.message}`)
      await pregate.attach({ issuePath: reservation.issuePath, runId: record.runId, record: pregateRecord, override: pregateOverride })
        .catch((error) => console.warn(`triage pre-gate for ${k} run ${record.runId} could not be attached: ${error.message}`))
    } else if (pregateRecord?.skipped === 'error') {
      console.warn(`triage pre-gate for ${k} failed, start proceeded without it: ${pregateRecord.message}`)
    }

    // Detached on purpose: the response returns now, the run continues.
    record.finished = drive(record, {
      harnesses,
      configRoot: root,
      projectPath, projectAlias: projectDir(project, projectsDir)
    })

    return { runId: record.runId, status: 'preflighting', ...(startOverlap ? { startOverlap } : {}) }
  }

  /**
   * Which other issue's run of this project a run of kind `mine` cannot run beside
   * (run-exclusivity.mjs). From persisted live runs whose lock owner is alive, however
   * they were started, and this process's own, which include a finalize of a blocked
   * run. A run persisted as live with a dead owner is recovery work, not a running run,
   * and does not block.
   */
  async function exclusiveHolder (project, exceptIssueId, mine, listed = null) {
    let list = listed ?? []
    if (!listed) try { list = await issues.listIssues(project) } catch { list = [] }
    // A cycle's release run holds the project's release target like any other.
    list = [...list, ...await homesOf(project)]
    const conflictOf = async (issuePath, runId) => conflicts(mine, exclusivityOf(await store.readSnapshot(issuePath, runId).catch(() => null)))
    const seen = new Set()
    for (const issue of list) {
      if (issue.id === exceptIssueId) continue
      const latest = issue.latestRun
      if (!latest?.live) continue
      const owner = await lockOwner(issue.path, latest.runId)
      if (!owner.forThisRun || !held(owner)) continue
      seen.add(latest.runId)
      if (await conflictOf(issue.path, latest.runId)) return { runId: latest.runId, issueId: issue.id }
    }
    for (const record of active.values()) {
      if (record.project !== project || record.issueId === exceptIssueId || seen.has(record.runId)) continue
      if (await conflictOf(record.issuePath, record.runId)) return { runId: record.runId, issueId: record.issueId }
    }
    return null
  }

  /**
   * The run holding this project's checkout now, which no start can run beside: a live
   * in-place run, by the test a start is refused on. Another issue's ordinary run holds
   * nothing. Read-only, and it takes a listing the caller already has. An observation:
   * start() decides, and a release run's refusal needs a playbook this cannot know.
   */
  function checkoutHolder (project, listed = null) {
    return exclusiveHolder(project, null, NOT_EXCLUSIVE, listed)
  }

  /**
   * The project's module pool read now (module-pool.mjs), with each member's modules-tier
   * target for subscriber drives: `{ pool, record }`, or null when the project has none.
   */
  async function modulePoolOf (project, root = configRoot, loaded = null, pools = null) {
    const config = loaded ?? await loadConfig({ root })
    // A pool reads the same for each of its members, and reading it walks every member's checkout: a caller
    // reading several projects at once (the ready queue) passes one map and the pool is walked once for all.
    const id = pools ? poolIdOf(project, config.projects) : null
    if (id && pools.has(id)) return pools.get(id)
    const pool = await poolOf(project, { projects: config.projects, resolvePath: (p) => resolveProjectPath(p, { projectsDir }) })
    if (!pool) return null
    const targets = {}
    for (const m of pool.members) {
      const infra = config.projects.get(m.project)?.infrastructure
      targets[m.project] = infra?.testDrive?.modules ? modulesTarget(infra) : null
    }
    const read = { pool, record: { ...poolRecord(pool), targets } }
    if (id) pools.set(id, read)
    return read
  }

  /** The pool's reservations that stand now (module-locks.mjs readReservations); a shutdown's ones only when the next start carries them on. */
  async function standingReservations (pool) {
    let resumeAfterShutdown = true
    try { resumeAfterShutdown = hostSettings({ ...(configRoot ? { root: configRoot } : {}) }).resumeAfterShutdown !== false } catch {}
    return readReservations(pool, { platform, resumeAfterShutdown })
  }

  /**
   * `moduleLocks` for readiness, preview and the project page: the pool, every lock in it
   * and, for an issue, the modules its triage named and which of them another live run
   * holds. Read-only; null when the project has no pool. An observation: start() decides.
   */
  async function moduleLockReading ({ project, issueId = null, playbook = null, config = null, pools = null }) {
    const read = await modulePoolOf(project, configRoot, config, pools)
    if (!read) return null
    const { pool } = read
    const held = (await readPoolLocks(pool.id, { platform })).map((l) => ({ ...l, owner: pool.modules.get(l.module)?.owner ?? null }))
    const issue = issueId ? await issues.getIssue(project, issueId, { settle: false }).catch(() => null) : null
    const expected = issue?.sizing?.affectedModules ?? []
    // Runs whose recorded decision waits for its set, with the modules they reserve and who holds them now.
    const reservations = (await standingReservations(pool.id)).map((r) => ({ ...r, behind: reservedAgainst([r], held, r.modules).map(({ module, behind }) => ({ module, runIds: behind })) }))
    return {
      pool: pool.id,
      members: pool.members.map((m) => m.project),
      modules: pool.modules.size,
      ...(pool.ambiguous.length ? { ambiguous: pool.ambiguous } : {}),
      ...(pool.unreadable.length ? { unreadable: pool.unreadable } : {}),
      held,
      reservations,
      ...(issueId ? { expected: { modules: expected, source: issue?.sizing ? 'sizing' : 'none' }, conflicts: [...reservedAgainst(reservations, held, expected), ...conflictsWith(held, expected, { project, issueId })] } : {}),
      ...(playbook ? { locks: playbook } : {})
    }
  }

  /**
   * `modulesCoverage` for preview and readiness (runtime/modules-coverage.mjs): what the modules
   * tier would test for the issue's newest recorded change set or expected paths, `unknown` when
   * there are none. Null for a target that is not a declared modules tier. Read-only, never throws.
   */
  async function modulesCoverage ({ project, projectPath = null, issueId = null, issuePath = null, target }) {
    if (!isModulesTarget(target) || !target?.modules) return null
    try {
      const issue = issueId ? await issues.getIssue(project, issueId, { settle: false }).catch(() => null) : null
      const input = await coverageInput({ issuePath: issuePath ?? issue?.path ?? null, target, projectPath })
      return coverageReading({ target, triage: issue?.sizing?.affectedModules ?? [], input })
    } catch (error) {
      return { state: 'unavailable', detail: `What the modules tier would test could not be read: ${error.message}` }
    }
  }

  /** Preflight, provision, run, settle. Everything after the response is sent. */
  async function drive (record, { harnesses, configRoot: root, projectPath, projectAlias }) {
    const { project, issueId, reservation } = record
    const k = key(project, issueId)
    const probe = probeFor(harnesses)

    try {
      // ---- paid phase, inside a run that already exists and can be stopped ----
      let result = null
      let failure = null
      try {
        result = await preflight(reservation.resolution.resolved, {
          probe, depth: 'model', root, signal: record.controller.signal, projectPath
        })
      } catch (error) {
        failure = error
      }

      const state = failure
        ? 'errored'
        : result.launchReady === true ? 'passed' : result.cancelled ? 'cancelled' : 'refused'

      // The refusal text, not just a count: "1 failure" tells an operator nothing
      // they can act on, and this is the only place the reason survives.
      const refusal = failure ?? (state === 'passed' ? null : refusalOf(result))

      // Written whatever the verdict: the probes were made, so what they cost is
      // part of this run's history even when it never runs.
      // A freeze request's reservation write (or the thaw's) lands before the preflight's own writes of the same file.
      await record.reservationWrites?.catch(() => {})
      await recordPreflight(reservation, {
        state, result, usage: probe.spent, detail: refusal?.message ?? null, depth: 'model'
      })
      emit?.({
        type: 'preflight', project, issueId, runId: record.runId, state, attempts: probe.spent.invocations
      })

      if (state !== 'passed') {
        const stopped = state === 'cancelled' || record.controller.signal.aborted
        record.refusal = refusal
        if (reservation.run.freezeRequested && !activeRequest(reservation.run.freezeRequested)) delete reservation.run.freezeRequested
        if (stopped && record.stoppedBy && (reservation.run.pauseRequested || reservation.run.freezeRequested)) {
          await pauseReservation(reservation)
          return
        }
        if (stopped && record.stoppedBy) reservation.run.stoppedBy = record.stoppedBy
        await abandonReservation(reservation, {
          status: stopped ? 'cancelled' : 'failed',
          blockedReason: stopped ? null : 'preflight-refused'
        })
        return
      }

      if (record.controller.signal.aborted) {
        await settleStopped(record)
        return
      }

      // ---- provisioning ----
      await record.reservationWrites?.catch(() => {})
      let engine
      let provisioning = null
      try {
        provisioning = await provisionTicket(record, projectPath)
        await record.reservationWrites?.catch(() => {})
        engine = await provisionRun(reservation, {
          projectPath, projectAlias,
          harnesses,
          stepStore: { create: (options) => issues.createStep(project, issueId, options) },
          workspaceProvider: gitWorktreeProvider,
          deliveryProvider: worktreeDiffDelivery,
          configRoot: root,
          availability,
          signal: record.controller.signal,
          emit: (event) => emit?.({ ...event, project, issueId, runId: record.runId })
        })
      } catch (error) {
        // Stopped while its base snapshot waited for a delivery or the cycle: nothing exists yet.
        if (error.name !== 'AbortError' || !record.controller.signal.aborted) throw error
        await settleStopped(record)
        return
      } finally {
        provisioning?.release()
      }

      await driveEngine(record, engine)
    } catch (error) {
      await failRecord(record, error)
    } finally {
      await settleWorkspace(record)
      active.delete(k)
      await announceEnd(project, issueId, record.runId)
    }
  }

  /** A reservation stopped before any workspace exists: paused if a pause was asked for, else cancelled. */
  async function settleStopped ({ reservation, stoppedBy }) {
    if (reservation.run.freezeRequested && !activeRequest(reservation.run.freezeRequested)) delete reservation.run.freezeRequested
    if (stoppedBy && (reservation.run.pauseRequested || reservation.run.freezeRequested)) {
      await pauseReservation(reservation)
      return
    }
    if (stoppedBy) reservation.run.stoppedBy = stoppedBy
    await abandonReservation(reservation, { status: 'cancelled' })
  }

  /** The agent phase proper, shared by a fresh start and a resume after a decision. */
  async function driveEngine (record, engine) {
    if (failureAdvisor) engine.failureAdvisor = failureAdvisor
    // The full verification's gates (cycle-gates.mjs): this run's drives and checkout writes ask them.
    engine.cycleGate = gates.gateFor(record)
    if (record.freezeRequested && !activeRequest(record.freezeRequested)) delete record.freezeRequested
    await engine.dropStaleFreeze()
    if (consult) engine.consult = consult
    armAutoReconcile(engine, record.project)
    // No quota fallback is installed (engine.quotaFallback stays unset): a seat whose model is exhausted stops its run,
    // which keeps its work and is resumed once the model answers. A weaker model is never put in a seat automatically.
    record.engine = engine
    record.phase = 'run'
    // A stop that arrived during preflight still applies: the engine inherits it.
    if (record.stopping || record.controller.signal.aborted) {
      engine.cancel(record.stoppedBy ?? 'requested')
      if (record.stoppedBy && record.pauseRequested) engine.run.pauseRequested ??= { at: engine.clock.iso() }
      if (record.stoppedBy && activeRequest(record.freezeRequested)) engine.run.freezeRequested ??= record.freezeRequested
      if (await engine.pauseForShutdown({ between: 'provisioning-and-drive' })) return
      // No invocation has begun. drive() refuses an already-aborted controller,
      // so settle here instead of leaving a permanent "stopping" record.
      engine.run.status = 'cancelled'
      engine.run.outcome = 'unresolved'
      engine.run.endedAt = engine.clock.iso()
      if (record.stoppedBy) engine.run.stoppedBy = record.stoppedBy
      await engine.persist({ type: 'cancelled', between: 'provisioning-and-drive', stoppedBy: record.stoppedBy })
      return
    }
    if (record.pauseRequested && !engine.run.pauseRequested) await engine.requestPause()
    // Only a writing run is held by the full verification's freeze; a read-only one admitted during it runs on.
    adoptClassification(record)
    // Against the real workspace now, whatever was decided before it existed: admission and a preflight freeze classify with
    // no workspace, and its writable paths (worktree, scratch, mounts) can lie inside a snapshotted checkout
    // (provisional-workspace-classification). Only a whole decision stands as it is.
    await classifyNow(record, engine.snapshot, engine.run.workspace, { recheck: true })
    // Asked only for a cycle that classified it whole: an unclassified record is never asked for a newer cycle.
    const request = activeRequest(record.freezeRequested) ? record.freezeRequested.cycleId : (wholeForNow(record) ? freeze.cycleId : null)
    if (request && !engine.run.freezeRequested) await engine.requestFreeze(request)
    await engine.drive()
  }

  /**
   * Answer the question a paused run asked, and drive it on.
   *
   * The answer is recorded by the engine as an operator step before anything
   * resumes, so a crash right after leaves the decision on disk. The same
   * exclusivity applies as for a start: one live run per issue, and none beside
   * a run this one cannot share the project with.
   */
  async function answer ({ project, issueId, runId, text, actor, origin, pauseId, retryInput = false, refreshChecks = false, resume = false, recover = false, integrity = null, budgets = {}, continueRun = false, acceptCheck = null, acceptShortWallClock = false }) {
    if (shuttingDown) throw Object.assign(err(503, 'the server is shutting down'), { started: false, retryable: true })
    const k = key(project, issueId)
    if (starting.has(k) || active.has(k)) throw err(409, 'a run is already active for this issue')
    starting.add(k)
    // Taken to write until its snapshot says otherwise: a freeze beginning now waits for it.
    pendingWrites.set(k, { project, issueId, runId, phase: 'continue', since: new Date().toISOString() })
    let engine = null
    let answerContained = false
    try {
      let issue
      await admission(project, async () => {
        issue = await holderOf(project, issueId)
        const snapshot = await store.readSnapshot(issue.path, runId).catch(() => null)
        // No writing run continues during the cycle but the cycle's own; the cycle resumes what it paused itself.
        if (frozenFor(project) && origin !== 'full-verification' && writesCheckout(snapshot)) {
          const stored = await store.readRun(issue.path, runId).catch(() => null)
          // Read again after each await: a cycle that thawed meanwhile refuses nothing (continuation-crosses-thaw).
          for (let c = freeze?.cycleId; c && frozenFor(project) && stored?.fullVerification?.cycleId !== c; c = freeze?.cycleId) {
            const whole = await wholeOf(snapshot, stored?.workspace ?? null)
            if (freeze?.cycleId !== c) continue
            if (whole) throw freezeRefusal()
            answerContained = c
            break
          }
        }
        if (!writesCheckout(snapshot) || answerContained) pendingWrites.delete(k)
        if (issue.packed) throw err(409, 'This issue is archived. Restore it before starting or continuing a run.')
        const holder = await exclusiveHolder(project, issueId, exclusivityOf(snapshot))
        if (holder) throw err(409, conflictMessage(holder), holder)
        inquiryAdmission(issue)
        const harnesses = await loadHarnesses()
        engine = await resumeRun({
          issuePath: issue.path,
          runId,
          harnesses,
          stepStore: { create: (options) => issues.createStep(project, issueId, options) },
          deliveryProvider: worktreeDiffDelivery,
          configRoot,
          projectPath: await resolveProjectPath(project, { projectsDir }),
          projectAlias: projectDir(project, projectsDir),
          availability,
          emit: (event) => emit?.({ ...event, project, issueId, runId })
        })
        // Its modules again (module-locks.mjs). A paused run gave its locks up at the pause and owes them;
        // an ended run's resume, continue, refresh of checks, accepted check result or input retry owes the
        // set its end gave back. Neither is refused for a lock: the decision is recorded and the engine takes
        // the set before anything goes on, waiting for a holder (takePendingModules). The reservation is
        // written first, under this run's issue lock, so from the moment the decision exists no start can
        // take a module the run waits for. One paused before that rule still names locks of an earlier
        // process: they become owed here. An integrity restore or accept-partial, and a recovery, re-take the
        // set first, and a module another run took meanwhile refuses them, naming the holder; an abandon takes none.
        if (engine.run.moduleLocks && !integrity && !recover) {
          // A paused run's yield is written now; an ended run's owed set goes to disk with its decision, so a
          // refused one leaves the record as it was (only the reservation is dropped, releaseEndedRunLocks).
          if (engine.run.status === 'paused') { if (await yieldForPause(engine.run)) await store.writeRun(issue.path, runId, engine.run) } else await oweEnded(engine.run)
          await reserveModules(engine.run, { issuePath: issue.path, decision: resume ? 'resume' : continueRun ? 'continue' : refreshChecks ? 'refresh-checks' : acceptCheck ? 'accept-check' : retryInput ? 'retry-input' : 'answer' })
        } else if (engine.run.moduleLocks && integrity?.disposition !== 'abandon') {
          const { conflicts } = await reclaimRunLocks(engine.run, { project, issueId, issuePath: issue.path, platform, persist: (run) => store.writeRun(issue.path, runId, run) })
          await store.writeRun(issue.path, runId, engine.run)
          if (conflicts.length) throw occupied(lockedMessage(conflicts), { code: 'MODULE_LOCKED', holders: conflicts })
        }
      })
      armAutoReconcile(engine, project)
      if (integrity) {
        // Pinned to the state the operator inspected; the engine refuses a
        // disposition for a workspace that changed since, or one that is not
        // allowed for what the quarantined turn did.
        try {
          await engine.resolveIntegrity({ disposition: integrity.disposition, expectedStateHash: integrity.expectedStateHash, reason: integrity.reason, actor: actor ?? 'operator' })
        } catch (error) { throw err(409, error.message) }
        if (integrity.disposition === 'abandon') {
          await releaseEndedRunLocks(engine.run, issue.path)
          await engine.runLock?.release().catch(() => {})
          starting.delete(k)
          pendingWrites.delete(k)
          await announceEnd(project, issueId, runId)
          return { runId, status: engine.run.status, integrity: engine.run.integrity.status }
        }
      }
      if (!resume && !recover && !integrity && !retryInput && !refreshChecks && !continueRun && !acceptCheck && engine.run.status !== 'paused') throw err(409, 'this run is not waiting for a decision')
      if (recover) {
        const outcome = await engine.recoverOwnerLoss({ budgets, actor, origin })
        if (!outcome.resumed) {
          // Reconciliation is recorded; what is left needs a person. The locks re-taken for it go back
          // (still required on the record, so the next recovery takes them again).
          await releaseEndedRunLocks(engine.run, issue.path)
          await engine.runLock?.release().catch(() => {})
          starting.delete(k)
          pendingWrites.delete(k)
          emit?.({ type: 'run-recovery-required', project, issueId, runId })
          return { runId, status: engine.run.status, recovered: false, reason: outcome.reason }
        }
      }
      const setup = resume && awaitsSetup(engine.run)
      const decision = integrity ? { integrity: integrity.disposition } : recover ? { recovered: true } : resume ? await engine.resumeExecution({ budgets, unrecordedBarrier: await unrecordedBarrier(path.dirname(issue.path)), actor, origin, acceptShortWallClock }) : acceptCheck ? await engine.acceptCheckResult({ ...acceptCheck, actor }) : continueRun ? await engine.continueRun({ text, actor, budgets, acceptShortWallClock }) : refreshChecks ? await engine.refreshClosureChecks(await projectInfrastructure(project, { root: configRoot }).then((infra) => infra ? (isModulesTarget(engine.snapshot.checks?.target) ? modulesTarget(infra) : stagingTarget(infra)) : null)) : retryInput ? await engine.retryInputFailure() : await engine.answer({ text, actor, pauseId })
      // The continuation went on (the run reads live again): its re-taken locks no longer need the marker.
      endContinuation(engine.run)
      // Stopped before it had a workspace: the setup it never finished, from its
      // own snapshot, and the turns after it, as a start would have gone on.
      if (setup) {
        engine.run.status = 'preflighting'
        engine.run.preflight = { ...engine.run.preflight, state: 'pending', startedAt: engine.clock.iso(), endedAt: null }
        await store.writeRun(engine.issuePath, engine.runId, engine.run)
        const reservation = { runId, runLock: engine.runLock, resolution: { resolved: engine.snapshot }, run: engine.run, issuePath: issue.path, clock: engine.clock }
        const record = { runId, issuePath: issue.path, project, issueId, phase: 'preflight', engine: null, reservation, controller: new AbortController(), stopping: false, finished: null, home: Boolean(issue.home), cycleId: engine.run.fullVerification?.cycleId ?? null, writes: writesCheckout(engine.snapshot), ...(answerContained ? { whole: false, classifiedFor: answerContained } : {}) }
        const harnesses = await loadHarnesses()
        const projectPath = await resolveProjectPath(project, { projectsDir })
        active.set(k, record)
        starting.delete(k)
        pendingWrites.delete(k)
        adoptClassification(record)
        // Admitted just before a freeze closed admission: a writing one is classified for it, and asked to pause only if whole.
        if (frozenFor(record.project) && !ofCycle(record) && writes(record)) {
          await classifyNow(record, snapshotOf(record), workspaceOf(record))
          await Promise.resolve(freezeRecord(record)).catch(() => {})
        }
        emit?.({ type: 'run-resumed', project, issueId, runId, decision })
        record.finished = drive(record, { harnesses, configRoot, projectPath, projectAlias: projectDir(project, projectsDir) })
        return { runId, status: 'preflighting', decision }
      }
      // The worktree was handed back when the run paused; it is ours again.
      if (engine.run.workspace?.state === 'retained') {
        engine.run.workspace.state = 'active'
        engine.run.workspace.retainedReason = null
        await store.writeRun(engine.issuePath, engine.runId, engine.run)
      }
      const record = { runId, issuePath: issue.path, project, issueId, phase: 'run', engine, reservation: null, controller: new AbortController(), stopping: false, finished: null, home: Boolean(issue.home), cycleId: engine.run.fullVerification?.cycleId ?? null, writes: writesCheckout(engine.snapshot), ...(answerContained ? { whole: false, classifiedFor: answerContained } : {}) }
      active.set(k, record)
      starting.delete(k)
      pendingWrites.delete(k)
      adoptClassification(record)
      // Admitted just before a freeze closed admission: a writing one is classified for it, and asked to pause only if whole.
      if (frozenFor(record.project) && !ofCycle(record) && writes(record)) {
        await classifyNow(record, snapshotOf(record), workspaceOf(record))
        await Promise.resolve(freezeRecord(record)).catch(() => {})
      }
      emit?.({ type: 'run-resumed', project, issueId, runId, decision })
      record.finished = (async () => {
        try {
          await driveEngine(record, engine)
        } catch (error) {
          await failRecord(record, error)
        } finally {
          await settleWorkspace(record)
          active.delete(k)
          await announceEnd(project, issueId, runId)
        }
      })()
      return { runId, status: 'pending', decision }
    } catch (error) {
      starting.delete(k)
      pendingWrites.delete(k)
      if (engine && !active.has(k)) {
        // Locks taken for a continuation that did not go on are given back: an ended run's stay required, a paused one's owed.
        await releaseEndedRunLocks(engine.run, engine.issuePath)
        await engine.runLock?.release().catch(() => {})
      }
      throw translate(error)
    }
  }

  /**
   * What a quarantined run's workspace holds now, against the state the turn
   * received: the evidence a disposition is pinned to. Read-only; takes no lock.
   */
  async function inspectIntegrity ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const issue = await holderOf(project, issueId)
    const engine = await resumeRun({ issuePath: issue.path, runId, harnesses: {}, takeLock: false, configRoot, projectPath: await resolveProjectPath(project, { projectsDir }).catch(() => null) })
    const report = engine.run.integrity?.latest ?? null
    if (engine.run.integrity?.status !== 'quarantined') throw err(409, 'this run has no source-integrity quarantine')
    const before = report?.before ? await readIntegrity(engine.integrityDir(), report.before) : null
    const current = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before?.trackedPaths })
    const changes = before ? integrityChanges(before, current) : null
    const acceptable = Boolean(report?.writesCode && report.outcome !== 'completed' && changes && !changes.head)
    return {
      runId,
      workspace: engine.run.workspace?.path ?? null,
      reason: report?.reason ?? null,
      role: report?.role ?? null,
      outcome: report?.outcome ?? null,
      cause: engine.run.recovery?.cause ?? null,
      stateHash: current.hash,
      restored: Boolean(before && current.hash === before.hash),
      changes: changes ? { head: changes.head, index: changes.index, paths: changes.paths.slice(0, 500), pathCount: changes.paths.length } : null,
      dispositions: [...(acceptable ? ['accept-partial'] : []), 'restored', 'abandon']
    }
  }

  async function failRecord (record, error) {
    const { engine, reservation } = record
    try {
      if (engine) {
        if (engine.run.integrity?.status === 'quarantined') return
        // An unacknowledged configuration violation keeps the recoverable state (engine markConfigUnresolved).
        if (engine.run.recovery?.configUnresolved || engine.run.configUnresolved?.length || engine.run.recovery?.consultPending) return
        engine.run.status = 'failed'
        engine.run.blockedReason = error.message
        engine.run.outcome = 'unresolved'
        engine.run.endedAt ??= engine.clock.iso()
        await store.writeRun(engine.issuePath, engine.runId, engine.run)
      } else {
        await abandonReservation(reservation, { blockedReason: error.message })
      }
    } catch { /* the failure itself must not throw */ }
  }

  /**
   * Hand the issue back, and decide — explicitly — whether the candidate goes
   * with it.
   *
   * The deletion is a `git worktree remove --force`, so the decision has to be
   * made on evidence about the FILES, not about the run's records. A recorded
   * revision is fingerprinted from a response; an author that wrote code and was
   * then cancelled, killed, or failed before answering has recorded nothing and
   * written plenty. Reading "no revisions" as "no work" is how that work is lost.
   *
   * So: delete only when the content is captured elsewhere, or when comparing the
   * workspace against its persisted baseline PROVES nothing changed. A comparison
   * that cannot be made is not a licence to delete.
   */
  /*
   * A run ended (or was abandoned): write its account into the issue folder
   * (run-result-step.mjs), then say so. The account is for people; failing to
   * write it is logged and changes nothing about the run.
   */
  const reconcilePolicyOf = async (project) => (await loadConfig({ root: configRoot })).projects.get(project)?.workspace?.reconcile ?? {}
  const armAutoReconcile = (engine, project) => {
    engine.reconcilePolicy = () => reconcilePolicyOf(project)
    engine.reconcileOwner = instanceId
    engine.releaseCoverage = async (args) => stagingRunCoverage({ ...args, project, projectPath: await resolveProjectPath(project, { projectsDir }).catch(() => null), listIssues: (p, o) => issues.listIssues(p, o) })
    // A newly recorded non-approving review round goes to the top-level supervisor before the run goes on (engine.recordReviewRounds).
    engine.admitReviewRounds = onReviewRounds ? (a) => onReviewRounds({ ...a, project, issueId: engine.run?.issue?.id, runId: engine.runId }) : null
  }
  // No record is left to hold a decision, so nothing is left to wait on.
  const recordGone = (error) => error.status === 404 || error.code === 'ENOENT'
  const announceFinished = (project, issueId, runId) => emit?.({ type: 'run-finished', project, issueId, runId })

  /*
   * Try until `attempt` stops throwing: whether a run may be announced can only
   * be read from its record, and a guess in either direction is wrong (told
   * settled while a reconcile is coming, or waiting for ever). No limit: a retry
   * is one read and one lock attempt. The first try is awaited, so a readable
   * record keeps its order; a restart picks up what a shutdown drops (reconcile()).
   */
  async function retryUntilEstablished (what, attempt, tries = 0) {
    if (tries > 0 && shuttingDown) return
    try {
      await attempt()
    } catch (error) {
      if (tries % 30 === 0) console.warn(`[devpanel] ${what} could not be established, trying again: ${error.message}`)
      setTimeout(() => retryUntilEstablished(what, attempt, tries + 1), reconcileRetryMs).unref()
    }
  }

  /*
   * A run blocked at delivery only by drift on paths the project declares
   * reconcilable (its changelog) is reconciled at once (auto-reconcile.mjs), not
   * left for a person. Not awaited: the run has ended and its account is written.
   * Only a marked run comes here (engine.evaluateClosure), and it is not announced
   * until the attempt decides it. An attempt that cannot run (the project became
   * busy, the record moved on) is recorded and announced by the release, leaving
   * the run blocked as it was, with Reconcile still offered.
   */
  function autoReconcile (project, issueId, runId, at) {
    const mark = `${runId}:${at}`
    // The full verification's freeze puts it off, never spends it: it runs once admission opens again.
    // Queued only while a cycle is frozen for the project now: the thaw that drains the queue clears the freeze in the same
    // tick, so one that thawed meanwhile (during the refusal's own cleanup, say) gets it run again at once, never left
    // behind a queue nobody drains (continuation-crosses-thaw).
    const defer = () => {
      attemptedReconciles.delete(mark)
      if (frozenFor(project)) deferredReconciles.set(mark, { project, issueId, runId, at })
      else autoReconcile(project, issueId, runId, at)
    }
    ;(async () => {
      // A run the freeze holds whole is put off as before; a contained run's reconcile is admitted and waits at its gate.
      for (let c = freeze?.cycleId; c && frozenFor(project); c = freeze?.cycleId) {
        const whole = await wholeStoredRun(project, issueId, runId)
        if (freeze?.cycleId !== c) continue
        // Put off only while the cycle that read it is still frozen; one that thawed meanwhile has drained its queue.
        if (whole) return defer()
        break
      }
      if (attemptedReconciles.has(mark)) throw new Error('the attempt ended without deciding it')
      const issue = await issues.getIssue(project, issueId)
      if (issue.packed) throw new Error('the issue was archived')
      const refusal = autoReconcileRefusal(await store.readRun(issue.path, runId), await reconcilePolicyOf(project))
      if (refusal) throw new Error(refusal)
      if (attemptedReconciles.size >= 2000) attemptedReconciles.delete(attemptedReconciles.values().next().value)
      attemptedReconciles.add(mark)
      try {
        await finalize({ project, issueId, runId, reconcile: true, actor: 'engine' })
      } catch (error) {
        if (error?.code === 'FULL_VERIFICATION_FREEZE') return defer()
        throw error
      }
    })().catch((error) => {
      console.warn(`[devpanel] automatic reconcile of ${project}/${issueId} run ${runId} did not run: ${error.message}`)
      return releaseAutoReconcile(project, issueId, runId, at, error.message)
    })
  }

  /*
   * An attempt that never ran is an ending too. Written under the issue's lock, on
   * the record as it reads then, so the outcome depends only on what a holder left:
   * a marker already decided or re-marked has its own announcement and gets none
   * here. A held lock is tried again; no holder is trusted to decide (markLanded
   * holds it and leaves the marker). A dead owner's lock is taken over (the default):
   * after a crash mid-attempt nothing else would ever free it.
   */
  function releaseAutoReconcile (project, issueId, runId, at, reason) {
    return retryUntilEstablished(`the automatic reconcile of ${project}/${issueId} run ${runId}`, async () => {
      let released = true
      try {
        const issue = await issues.getIssue(project, issueId)
        if (!issue.packed) {
          released = await withIssueLock(path.join(issue.path, '.run.lock'), { purpose: 'auto-reconcile-release', runId }, async () => {
            const run = await store.readRun(issue.path, runId)
            if (!reconcilePending(run) || run.autoReconcile.at !== at) return false
            run.autoReconcile = { state: 'not-run', reason, at: new Date().toISOString() }
            await store.writeRun(issue.path, runId, run)
            // The record is the decision; an incomplete journal must not hold it (store.mjs requireCompleteEvents).
            await store.appendEvent(issue.path, runId, { type: 'reconcile-not-run', reason }, { emit: (event) => emit?.({ ...event, project, issueId, runId }) })
              .catch((error) => console.warn(`[devpanel] could not journal the automatic reconcile of ${project}/${issueId} run ${runId}: ${error.message}`))
            return true
          })
        }
      } catch (error) {
        if (!recordGone(error)) throw error
      }
      if (!released) return
      await writeResult(project, issueId, runId)
      announceFinished(project, issueId, runId)
    })
  }

  /* A marker left by an earlier server: nothing is coming for it, so it ends here. */
  function releaseIfLeftBehind (project, issueId, run) {
    if (!reconcilePending(run) || run.autoReconcile.owner === instanceId) return null
    return releaseAutoReconcile(project, issueId, run.runId, run.autoReconcile.at, 'the server restarted before it was decided')
  }

  /** The run folders of an issue, as the issue's own listing reads them. */
  const runNames = async (issue) => (await fs.readdir(store.runsDir(issue.path), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
    .map((e) => e.name)

  /*
   * What the startup sweep could not read may hold a marker, and a marker nobody
   * reads waits for ever: the scopes it skipped are read again, and only those,
   * until they read. This only looks for markers. The startup handling a record
   * missed is not repeated, and a record that is not pending announces nothing.
   */
  function recoverHeldReconciles (scopes) {
    let left = scopes
    return retryUntilEstablished('a read the startup sweep could not make', async () => {
      const queue = left
      const failed = []
      let failure = null
      left = failed
      while (queue.length) {
        const scope = queue.pop()
        try {
          if (!scope.project) queue.push(...(await issues.listProjects()).map((p) => ({ project: p.id ?? p.name ?? p })))
          else if (!scope.issue) queue.push(...(await issues.listIssues(scope.project)).map((issue) => ({ ...scope, issue })))
          else if (!scope.runId) queue.push(...(await runNames(scope.issue)).map((runId) => ({ ...scope, runId })))
          else await releaseIfLeftBehind(scope.project, scope.issue.id, await store.readRun(scope.issue.path, scope.runId))
        } catch (error) {
          if (error.code === 'ENOENT') continue
          failed.push(scope)
          failure = error
        }
      }
      if (failure) throw failure
    })
  }

  /** The run's account in the issue folder, for people. Failing to write it is logged and changes nothing about the run. */
  async function writeResult (project, issueId, runId) {
    try {
      const issue = await holderOf(project, issueId)
      // Before the account, and never in its way: a release's notes on the issues it carried.
      await writeRunCoverageNotes({ project, issue, run: await store.readRun(issue.path, runId).catch(() => null), issues })
        .catch((error) => console.warn(`[devpanel] could not write the coverage notes of ${project}/${issueId} run ${runId}: ${error.message}`))
      await writeRunResultStep({ issuePath: issue.path, runId, projectPath: await resolveProjectPath(project, { projectsDir }).catch(() => null) })
      return { written: true, inquiry: issue.kind === 'inquiry' }
    } catch (error) {
      console.warn(`[devpanel] could not write the result of ${project}/${issueId} run ${runId}: ${error.message}`)
      return { written: false, inquiry: false }
    }
  }

  async function announceEnd (project, issueId, runId, type = 'run-finished') {
    let { written, inquiry } = await writeResult(project, issueId, runId)
    if (type !== 'run-finished') emit?.({ type, project, issueId, runId })
    // The record says whether it may be said: a failed read is not permission to.
    else {
      await retryUntilEstablished(`the end of ${project}/${issueId} run ${runId}`, async () => {
        let run = null
        try {
          const issue = await holderOf(project, issueId)
          if (!issue.packed) run = await store.readRun(issue.path, runId)
        } catch (error) {
          if (!recordGone(error)) throw error
        }
        if (!written) ({ written } = await writeResult(project, issueId, runId))
        if (reconcilePending(run)) autoReconcile(project, issueId, runId, run.autoReconcile.at)
        else announceFinished(project, issueId, runId)
      })
    }
    // An answered inquiry (row 4) packs itself once its run is settled; every
    // other ending waits for a close or an acknowledgement.
    if (inquiry) {
      await admission(project, () => packInquiryLocked(project, issueId))
        .then((r) => { if (r.packed) emit?.({ type: 'inquiry-packed', project, issueId, runId }) })
        .catch((error) => console.warn(`[devpanel] inquiry ${project}/${issueId} was not packed: ${error.message}`))
    }
    // A triage started with autoStart that closed autonomous starts its
    // recommended playbook now that the issue is free (auto-start.mjs).
    if (type === 'run-finished' && !inquiry) await autoStartAfter(project, issueId, runId)
    // A triage that ended with questions for the owner: the consult panel is asked
    // first (consult/owner-questions.mjs). Not awaited: the run has ended and holds nothing.
    if (type === 'run-finished' && !inquiry && afterEnd && !HOME_PATTERN.test(issueId)) {
      Promise.resolve().then(() => afterEnd({ project, issueId, runId })).catch((error) => console.warn(`[devpanel] consult after ${project}/${issueId} run ${runId} failed: ${error.message}`))
    }
  }

  /** What the server runs after a run's end was announced (the consult of a triage's owner questions). */
  let afterEnd = null
  function setAfterEnd (hook) { afterEnd = hook }

  /** The top-level supervisor's start gate, when one is attached (top-supervisor-service.mjs). */
  let supervisorAutoStart = null
  function setAutoStartGate (gate) { supervisorAutoStart = gate }

  async function autoStartAfter (project, issueId, runId) {
    try {
      // A run home's cycle run starts nothing after it.
      if (HOME_PATTERN.test(issueId)) return
      const issue = await issues.getIssue(project, issueId)
      if (issue.packed) return
      await routeAutoStart({ project, issueId, issuePath: issue.path, runId }, {
        getIssue: (p, id) => issues.getIssue(p, id),
        startOperator: ({ project: p, issueId: id, playbookId }) => start({ project: p, issueId: id, playbookId }),
        supervisorGate: supervisorAutoStart,
        shuttingDown: () => shuttingDown,
        emit
      })
    } catch (error) {
      console.warn(`[devpanel] autoStart after ${project}/${issueId} run ${runId} failed: ${error.message}`)
    }
  }

  // ------------------------------------------------------------- inquiries

  /** What an inquiry's latest run says now, with the facts packing depends on. */
  async function inquiryFacts (project, issueId) {
    const issue = await issues.getIssue(project, issueId)
    if (issue.kind !== 'inquiry') throw err(409, `${issueId} is not an inquiry`)
    if (issue.packed) {
      // The answer stays readable after packing: the latest run's record is in
      // the bundle (audit I4), and its row is the one it packed with.
      const runId = issue.latestRun?.runId ?? issue.runs?.at?.(-1)?.runId ?? null
      const run = runId ? await issues.readRunRecord(project, issueId, runId) : null
      const state = inquiryState({ run, pending: false, unreadable: Boolean(runId) && !run })
      return { issue, packed: true, runId, run, state: { ...state, closable: null } }
    }
    const runId = issue.latestRun?.runId ?? null
    let run = null
    let unreadable = false
    if (runId) {
      try { run = JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8')) } catch { unreadable = true }
    }
    const k = key(project, issueId)
    const pending = starting.has(k) || active.has(k)
    const owner = await lockOwner(issue.path, runId)
    const liveness = !owner.record || owner.liveness === 'absent' ? 'none' : owner.liveness
    const settled = !pending && liveness !== 'alive' && (!run?.workspace || run.workspace.state !== 'active')
    return { issue, packed: false, runId, run, unreadable, pending, liveness, settled, state: inquiryState({ run, pending, unreadable }) }
  }

  /** Pack an inquiry when the one predicate allows it. The caller holds the admission lock. */
  async function packInquiryLocked (project, issueId) {
    const f = await inquiryFacts(project, issueId)
    if (f.packed) return { packed: true, already: true }
    const verdict = inquiryPackable({ inquiry: f.issue, run: f.run, latestRunId: f.runId, liveness: f.liveness, settled: f.settled, pending: f.pending, unreadable: f.unreadable })
    if (!verdict.packable) return { packed: false, reason: verdict.reason, state: f.state }
    // Archiving writes the answer, the closure record and the run's result
    // text into the bundle before the folder goes (issue-bundle.mjs).
    // Inside the caller's admission lock (packInquiry, closeInquiry, the end of an inquiry's run): handed over, never taken again.
    await issues.setIssueArchived(project, issueId, true, { overrideReason: `inquiry ${f.state.state}${f.issue.inquiry?.closure ? ` (${f.issue.inquiry.closure.action})` : ''}`, admissionHeld: true })
    return { packed: true, state: f.state }
  }

  async function inquiryStatus ({ project, inquiryId }) {
    const f = await inquiryFacts(project, inquiryId)
    const d = f.run?.reportDisposition ?? null
    return {
      inquiryId, project, packed: f.packed, question: f.issue.inquiry?.question ?? null, relatedIssue: f.issue.inquiry?.relatedIssue ?? null,
      latestRunId: f.runId, ...f.state, closure: f.issue.inquiry?.closure ?? null,
      answer: d ? { disposition: d.disposition, response: d.response, reasoning: d.reasoning, proposals: (d.proposals ?? []).map((p) => ({ key: p.key, kind: p.kind, title: p.title })) } : null,
      ...(f.packed ? { archive: f.issue.archive ?? null } : {})
    }
  }

  /** close (rows 6–9) or acknowledge (row 5), bound to the latest run. */
  async function closeInquiry ({ project, inquiryId, runId, action, reason = null, by = 'operator' }) {
    if (!['close', 'acknowledge'].includes(action)) throw err(400, 'action must be close or acknowledge')
    if (!['operator', 'supervisor'].includes(by)) throw err(400, 'by must be operator or supervisor')
    if (action === 'close' && (typeof reason !== 'string' || !reason.trim())) throw err(400, 'closing an inquiry needs a reason')
    return admission(project, async () => {
      const f = await inquiryFacts(project, inquiryId)
      if (f.packed) throw err(409, `inquiry ${inquiryId} is already packed`)
      if (inquiryClosed(f.issue)) throw err(409, `inquiry ${inquiryId} is already closed; reopen it first`)
      if (!f.runId || runId !== f.runId) throw err(409, `stale: the latest run of ${inquiryId} is ${f.runId ?? 'none'}, not ${runId}`)
      if (f.state.closable !== action) throw err(409, `row ${f.state.row} (${f.state.state}) ${f.state.closable ? `takes ${f.state.closable}, not ${action}` : 'cannot be closed'}`)
      if (f.pending || f.liveness === 'alive' || f.liveness === 'unknown') throw err(409, `the run's owner is ${f.pending ? 'this process' : f.liveness}; wait for it to settle`)
      if (f.run?.recovery?.required) throw err(409, 'recovery is required first; closing never implies recovery')
      await issues.setInquiryClosure(project, inquiryId, { action, by, at: new Date().toISOString(), runId, reason: reason?.trim() ?? null, row: f.state.row })
      const packed = await packInquiryLocked(project, inquiryId)
      return { inquiryId, closed: action, row: f.state.row, packed: packed.packed, ...(packed.packed ? {} : { notPacked: packed.reason }) }
    })
  }

  /** Remove a closure: the inquiry is live again and a new close is needed. */
  async function reopenInquiry ({ project, inquiryId, reason, by = 'operator' }) {
    if (!['operator', 'supervisor'].includes(by)) throw err(400, 'by must be operator or supervisor')
    if (typeof reason !== 'string' || !reason.trim()) throw err(400, 'reopening an inquiry needs a reason')
    return admission(project, async () => {
      let issue = await issues.getIssue(project, inquiryId)
      // The kind is known packed or not (the bundle summary carries it): an
      // ordinary archived issue is never unpacked by this action (audit I9).
      if (issue.kind !== 'inquiry') throw err(409, `${inquiryId} is not an inquiry`)
      if (issue.packed) {
        await issues.setIssueArchived(project, inquiryId, false, { admissionHeld: true })
        issue = await issues.getIssue(project, inquiryId)
      } else if (issue.archived) await issues.setIssueArchived(project, inquiryId, false, { admissionHeld: true })
      if (issue.kind !== 'inquiry') throw err(409, `${inquiryId} is not an inquiry`)
      if (!inquiryClosed(issue)) return { inquiryId, reopened: false, detail: 'it was not closed' }
      await issues.setInquiryClosure(project, inquiryId, null, { reopenedBy: by, reason: reason.trim() })
      return { inquiryId, reopened: true }
    })
  }

  /**
   * The run whose cleanup is being settled, refused while live. `run` is null
   * when its record is gone; `issuePath` is null when the issue itself is gone
   * (deleted, or packed by archiving): its barrier entries are then all there
   * is, and they are settled from their own metadata.
   */
  async function cleanupTarget ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    if (typeof issueId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(issueId) || issueId.startsWith('.')) throw err(400, 'Invalid issue id')
    await issues.requireProject(project)
    const projectDir = path.join(issues.ISSUES_DIR, project)
    const issue = await holderOf(project, issueId).catch((error) => { if (error.status === 404) return null; throw error })
    if (!issue?.path) {
      if (!unrecorded.get(path.resolve(projectDir))?.has(runId) && !(await readBarrier(projectDir)).entries.some((e) => e.issueId === issueId && e.runId === runId)) {
        throw err(404, issue ? 'This issue is archived and its run has no barrier entry to settle.' : 'No such issue, and no barrier entry of this run remains.')
      }
      return { issuePath: null, projectDir, run: null }
    }
    if (active.get(key(project, issueId))?.runId === runId) throw err(409, 'This run is active here. Stop it and wait for it to settle first.')
    const run = await store.readRun(issue.path, runId).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
    if (run && LIVE_STATUSES.includes(run.status)) throw err(409, 'The run still claims to be active. Stop it before settling its cleanup.')
    const owner = await lockOwner(issue.path, runId)
    if (owner.forThisRun && held(owner)) throw err(409, `The run's lock is held by ${owner.liveness === 'alive' ? 'a live process' : 'a process whose liveness cannot be established'}.`)
    return { issuePath: issue.path, projectDir, run }
  }

  /*
   * A person's word that a run's escaped descendants are gone (OP-1): the run's
   * open cleanup entries and its barrier entries are lifted, recorded with who,
   * when and why. The only way for a structural entry (darwin, OP-2). Refused
   * while the run is live; a run whose record or issue is gone is settled from
   * the barrier alone.
   */
  async function acknowledgeCleanup ({ project, issueId, runId, reason, actor = 'operator' }) {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > 2000) throw err(400, 'A reason of at most 2000 characters is required: say what you checked.')
    return admission(project, async () => {
      const { issuePath, projectDir, run } = await cleanupTarget({ project, issueId, runId })
      const at = new Date().toISOString()
      const acknowledgement = { by: actor, at, reason: text }
      let current = null
      const tags = !run ? [] : await withIssueLock(path.join(issuePath, '.run.lock'), { purpose: 'cleanup-acknowledgement', takeOverDead: false }, async () => {
        current = await store.readRun(issuePath, runId)
        const open = openCleanup(current)
        for (const entry of open) Object.assign(entry, { acknowledgedAt: at, acknowledgement })
        if (open.length) {
          // Configuration recovery takes precedence over the settled hold (run-control.mjs).
          if (current.blockedReason === 'cleanup-unproved') restoreConfigRecovery(current, at)
          await store.writeRun(issuePath, runId, current)
          await store.appendEvent(issuePath, runId, { type: 'cleanup-acknowledged', by: actor, reason: text, tags: open.map((e) => e.tag) })
        }
        return open.map((e) => e.tag)
      })
      // What this server held for the run because the barrier file refused it.
      const dir = path.resolve(projectDir)
      const heldTags = openCleanup(unrecorded.get(dir)?.get(runId)?.run).map((e) => e.tag)
      unrecorded.get(dir)?.delete(runId)
      if (!unrecorded.get(dir)?.size) unrecorded.delete(dir)
      const lifted = await liftBarrierEntries(projectDir, { issueId, runId, type: 'acknowledged', by: actor, at, reason: text })
      if (current) await keepOnBarrier(projectDir, current)
      if (!tags.length && !lifted.length && !heldTags.length) throw err(409, 'Nothing to acknowledge: this run has no unproved cleanup.')
      emit?.({ type: 'cleanup-acknowledged', project, issueId, runId })
      return { runId, acknowledged: { ...acknowledgement, tags: [...new Set([...tags, ...lifted.map((e) => e.tag), ...heldTags])] } }
    })
  }

  /**
   * Prove a run's unproved cleanup on demand (Resume does it on its own): its
   * tags are scanned again, survivors of its own reaping stopped. Refused where
   * the entry is structural (darwin) or the scan unproved, and while the run is live.
   */
  async function proveCleanup ({ project, issueId, runId, actor = 'operator' }) {
    return admission(project, async () => {
      const { issuePath, projectDir, run } = await cleanupTarget({ project, issueId, runId })
      const at = new Date().toISOString()
      const settle = async (open) => {
        if (!open.length) return { still: [], proved: [] }
        const still = await proveEntries(open, { platform, at, terminate: terminatePids })
        const proved = open.filter((e) => e.provedAt)
        if (proved.length) await liftBarrierEntries(projectDir, { issueId, runId, tags: proved.map((e) => e.tag), type: 'proved', by: actor, at })
        return { still, proved }
      }
      if (!run) {
        // The run's record (or its issue) is gone: its barrier entries carry the tags.
        const entries = (await readBarrier(projectDir)).entries.filter((e) => e.issueId === issueId && e.runId === runId).map((e) => ({ ...e }))
        const { still, proved } = await settle(entries)
        if (still.length) throw cleanupRefusal(still)
        return { runId, proved: true, tags: proved.map((e) => e.tag) }
      }
      return withIssueLock(path.join(issuePath, '.run.lock'), { purpose: 'cleanup-proof', takeOverDead: false }, async () => {
        const current = await store.readRun(issuePath, runId)
        const open = openCleanup(current)
        let outcome
        try {
          outcome = await settle(open)
          if (!outcome.still.length && current.blockedReason === 'cleanup-unproved') restoreConfigRecovery(current, at)
        } finally { await store.writeRun(issuePath, runId, current) }
        // Barrier entries of tags the record has settled (proved before, or
        // written ahead of a record a crash lost) are lifted too.
        await keepOnBarrier(projectDir, current)
        const { still, proved } = outcome
        await store.appendEvent(issuePath, runId, { type: still.length ? 'cleanup-still-unproved' : 'cleanup-proved', by: actor, tags: (still.length ? still : proved).map((e) => e.tag) })
        if (still.length) throw cleanupRefusal(still)
        return { runId, proved: true, tags: proved.map((e) => e.tag) }
      })
    })
  }

  /**
   * A run's module locks go at its end and at a pause (module-locks.mjs): a paused run waits for
   * a person, so it holds nothing meanwhile and owes its set, which the engine takes again before
   * the run goes on. Written to the run record, and the release is announced so the supervisor's
   * ready queue reads the freed modules.
   */
  async function releaseEndedRunLocks (run, issuePath) {
    await destroyStageInstances(run, issuePath)
    if (!run?.moduleLocks) return
    try {
      // Its reservation goes too, unless the next start carries its decision on (a service shutdown).
      if (!awaitsRestart(run)) await dropReservation(run.moduleLocks.pool, run.runId)
      const paused = run.status === 'paused'
      if (paused ? await yieldForPause(run) : await releaseRunLocks(run)) {
        await store.writeRun(issuePath, run.runId, run)
        emit?.({ type: 'module-locks-released', project: run.issue?.project ?? null, issueId: run.issue?.id ?? null, runId: run.runId, modules: run.moduleLocks.released?.modules ?? [], ...(paused ? { paused: true } : {}) })
      }
    } catch (error) { console.warn(`module locks of run ${run.runId} could not be released: ${error.message}`) }
  }

  /**
   * A run's stage instances go whenever it stops driving (stage-instances.mjs): at every
   * end, and at a pause too. An idle instance holds gigabytes of its staging host and one
   * of its few instance slots for a wait of unknown length, while a new one costs minutes:
   * the run's next drive after a resume creates it again from the revision it then checks.
   * The destroy is written to the run's record (`stageInstances[].destroyed`).
   *
   * Dependencies the run installed on the stage (sync-records.mjs) are reverted by the
   * drive that installed them as it ends. One still standing here (that revert failed, or
   * the drive was cut short) is reverted now, after the instance is gone, at every end and
   * at a pause, delivered or not: the stage stays on its deployed set
   * (`dependencySyncs[].settled`).
   */
  async function destroyStageInstances (run, issuePath) {
    if (!run?.runId) return
    try {
      const reason = run.status === 'paused' ? 'run-paused' : `run-${run.status ?? 'ended'}`
      const destroyed = await destroyRunInstances(run.runId, { reason })
      const settled = syncDisposition(run) === 'revert' ? await settleRunSyncs(run.runId, { how: 'revert', reason }) : []
      for (const s of settled) {
        const entry = (run.dependencySyncs ?? []).findLast((d) => d.name === s.owner && d.outcome === 'synced' && !d.settled?.passed)
        const { owner, host, runId, files, ...rest } = s
        if (entry) entry.settled = rest
        if (s.passed === false) console.warn(`the dependencies run ${run.runId} installed on ${s.host} could not be reverted; the record stays and the run's deletion or the next panel start tries again: ${s.error}`)
      }
      if (!destroyed.length && !settled.length) return
      for (const d of destroyed) {
        const entry = (run.stageInstances ?? []).findLast((i) => i.name === d.name && !i.destroyed?.passed)
        if (entry) entry.destroyed = { reason: d.reason, at: d.at, durationMs: d.durationMs, passed: d.passed, ...(d.error ? { error: d.error } : {}) }
        if (!d.passed) console.warn(`stage instance ${d.name} of run ${run.runId} could not be destroyed on ${d.host}; it keeps its slot until a later attempt removes it: ${d.error}`)
      }
      await store.writeRun(issuePath, run.runId, run)
    } catch (error) { console.warn(`stage instances of run ${run.runId} could not be destroyed: ${error.message}`) }
  }

  /**
   * Removing a legacy linked worktree writes its registration into the project's own repository: a write ticket for that
   * repository, taken at the gate with nothing awaited between it and the removal, so the cycle sees the removal in flight
   * (busy) or the removal sees the cycle (linked-delivery-writes-before-gate). A cycle that snapshots the repository
   * refuses at once: the worktree is kept (retained, removable later), never removed without a ticket and never waited for.
   * `{ ticket }` (release it after the removal), `{ kept: reason }`, or `{}` when the removal writes no shared repository.
   */
  async function removalAdmission (record, ws, projectPath) {
    if (!ws?.path || ws.state === 'removed' || ws.isolation !== 'git-worktree' || ws.repository?.kind === 'private') return {}
    const out = await runProcess({ command: 'git', args: ['-C', projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'] }).catch(() => null)
    const dir = out?.code === 0 ? String(out.stdout ?? '').trim() : ''
    const common = dir ? await fs.realpath(dir).catch(() => dir) : projectPath
    // Kept for any run but the cycle's own, whole or contained: a settling run is not one the cycle drains.
    if (frozenFor(record.project) && !ofCycle(record) && gates.touchesSnapshot([common])) {
      return { kept: `${record.engine?.run?.status ?? 'ended'}: kept while full verification ${freeze.cycleId} snapshots its repository; its registration there is removed by a later removal of the workspace` }
    }
    const answer = gates.gateFor(record).tryWrite([common], { action: 'workspace-removal' })
    if (answer.ticket) return { ticket: answer.ticket }
    gates.cancel(answer.wait)
    return { kept: `${record.engine?.run?.status ?? 'ended'}: kept while full verification ${answer.wait.cycleId} snapshots its repository` }
  }

  async function settleWorkspace (record) {
    const { engine, reservation } = record

    // Never provisioned: there is no workspace, only the lock, which
    // abandonReservation has already released.
    if (!engine) {
      await releaseEndedRunLocks(reservation.run, reservation.issuePath)
      await reservation.runLock.release().catch(() => {})
      return
    }

    const run = engine.run
    await releaseEndedRunLocks(run, engine.issuePath)
    // A barrier write that failed during a turn leaves the entry on the run
    // only: held here until the file takes it.
    await keepOnBarrier(path.dirname(engine.issuePath), run)

    try {
      const verdict = await workspaceUnchanged(engine).catch((error) => ({
        unchanged: false, proven: false, reason: `the comparison itself failed: ${error.message}`
      }))
      const disposition = workspaceDisposition(run, verdict)
      // A legacy linked worktree is registered in the project's own repository: removing it writes there. While a cycle
      // snapshots that repository the worktree is kept (retained, removable later) instead of removed without a ticket
      // (linked-delivery-writes-before-gate). A private run's directories are its own and go as before.
      const admitted = disposition.discard ? await removalAdmission(record, run.workspace, engine.projectPath) : {}
      if (disposition.discard && !admitted.kept) {
        try { await discardWorkspace(engine) } finally { admitted.ticket?.release() }
      } else await releaseOwnership(engine, { reason: admitted.kept ?? `${run.status}: ${disposition.reason}` })
    } catch { /* ownership still goes back below */ }
    await engine.runLock?.release().catch(() => {})
  }

  async function pauseRun ({ project, issueId, runId }) {
    const record = active.get(key(project, issueId))
    if (!record || record.runId !== runId || record.stopping) throw err(409, 'This run is not active here. Reload its state before pausing.')
    if (record.engine) await record.engine.requestPause()
    else {
      record.pauseRequested = true
      record.reservation.run.pauseRequested ??= { at: new Date().toISOString() }
      await store.writeRun(record.issuePath, runId, record.reservation.run)
      emit?.({ type: 'pause-requested', project, issueId, runId })
    }
    return { runId, status: (record.engine ?? record.reservation).run.status, pauseRequested: true }
  }

  // ---------------------------------------------------------------- stopping

  /**
   * Ask a run to stop.
   *
   * Returns immediately with `stopping`; the run becomes `cancelled` only once
   * termination is confirmed. Repeated calls are harmless — the state is already
   * what they are asking for. A run that is preflighting stops too: the probes
   * are abandoned rather than paid for.
   */
  async function stop ({ project, issueId, runId, wait = false }) {
    const record = active.get(key(project, issueId))

    if (!record || record.runId !== runId) return stopUnowned({ project, issueId, runId })

    await beginStop(record)

    if (wait) {
      let timer
      try {
        await Promise.race([record.finished, new Promise(resolve => { timer = setTimeout(resolve, 30000) })])
      } finally { clearTimeout(timer) }
      const current = await store.readRun(record.issuePath, runId)
      return { runId, status: current.status, settling: active.has(key(project, issueId)) }
    }
    return { runId, status: 'stopping' }
  }

  /**
   * The stop itself. `stoppedBy` is only for the service's own shutdown, and
   * reaches the record only if the run really ends cancelled: a run that misses
   * the grace period is recovery-required, whatever was asked of it. A run
   * already stopping keeps the reason of the stop that came first.
   */
  async function beginStop (record, stoppedBy = null) {
    if (record.stopping) return
    const { project, issueId, runId } = record
    record.stopping = true
    record.stoppedBy = stoppedBy
    const target = record.engine ?? record.reservation
    target.run.status = 'stopping'
    await store.writeRun(record.issuePath, runId, target.run)
    emit?.({ type: 'stopping', project, issueId, runId, phase: record.phase })
    record.controller.abort()
    record.engine?.cancel(stoppedBy ?? 'requested')
  }

  /**
   * A stop for a run this process is not driving.
   *
   * "Not in memory" is not the same as "already stopped". A run persisted as live
   * is either owned by another process — which this one cannot stop — or owned by
   * nobody, in which case what happened to its last invocation is unknown and the
   * honest answer is recovery, not a clean cancellation.
   */
  async function stopUnowned ({ project, issueId, runId }) {
    const issue = await holderOf(project, issueId)
    const run = await store.readRun(issue.path, runId).catch(() => null)
    if (!run) throw err(404, 'no such run')

    // A run marked recovery-required was not stopped cleanly — what its last
    // invocation did is unknown. Reporting it as already stopped would claim
    // knowledge nobody has.
    if (run.blockedReason === 'recovery-required') {
      return {
        runId,
        status: run.status,
        blockedReason: run.blockedReason,
        recoveryRequired: true,
        detail: run.recovery?.reason ?? null
      }
    }

    if (!LIVE_STATUSES.includes(run.status)) {
      return { runId, status: run.status, alreadyStopped: true }
    }

    const owner = await lockOwner(issue.path, runId)
    if (owner.forThisRun && held(owner) && !owner.mine) {
      throw err(409, owner.liveness === 'alive' ? 'this run is driven by another process and cannot be stopped from here' : 'the owner of this run cannot be established, so it cannot be stopped from here', {
        owner: { pid: owner.record?.owner?.pid ?? null, host: owner.record?.owner?.host ?? null }
      })
    }

    const reconciled = await markUnowned(issue.path, run, owner)
    if (!reconciled) {
      // Nothing written: the lock is held, or the run settled meanwhile.
      const now = await store.readRun(issue.path, runId).catch(() => null)
      if (now && !LIVE_STATUSES.includes(now.status)) {
        return now.blockedReason === 'recovery-required'
          ? { runId, status: now.status, blockedReason: now.blockedReason, recoveryRequired: true, detail: now.recovery?.reason ?? null }
          : { runId, status: now.status, alreadyStopped: true }
      }
      throw err(409, 'the issue\'s run lock is held by another process, so this run cannot be marked from here now')
    }
    return {
      runId,
      status: reconciled.status,
      blockedReason: reconciled.blockedReason,
      recoveryRequired: true
    }
  }

  /**
   * Evaluate closure again for a run that stopped at delivery. Same exclusivity
   * as a start or an answer: one live run per issue, ownership taken through
   * the lock, the worktree settled afterwards by the same rules as any finish.
   * `reconcile` first merges the approved patch onto the drifted source under
   * the project's current `workspace.reconcile` policy (engine.reconcileDelivery).
   *
   * A finalize whose delivery meets a text conflict with the source gives it back
   * to the author (engine.returnFromDelivery), as the drive loop's own closure
   * does: the run is live again and is driven on here like an answered one. The
   * modules its end gave back are owed, never a refusal: the return is already on
   * the record, and the engine takes them before any turn, waiting for a holder.
   */
  async function finalize ({ project, issueId, runId, reconcile = false, actor = 'operator', budgets = {} }) {
    const action = reconcile ? 'reconcile-delivery' : 'finalize'
    if (shuttingDown) throw Object.assign(err(503, 'the server is shutting down'), { started: false, retryable: true })
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const k = key(project, issueId)
    if (starting.has(k) || active.has(k)) throw err(409, 'a run is already active for this issue')
    // During the full verification only a run the freeze holds whole is refused (one whose snapshot cannot be read
    // included, before anything else is read); a contained run's delivery is admitted, and its writes into what the
    // cycle snapshots wait for the thaw (cycle-gates.mjs).
    let contained = null
    for (let c = freeze?.cycleId; c && frozenFor(project); c = freeze?.cycleId) {
      const whole = await wholeStoredRun(project, issueId, runId)
      if (freeze?.cycleId !== c) continue
      if (whole) throw freezeRefusal()
      contained = c
      break
    }
    starting.add(k)
    pendingWrites.set(k, { project, issueId, runId, phase: action, since: new Date().toISOString() })
    let engine = null
    try {
      let issue
      await admission(project, async () => {
        issue = await issues.getIssue(project, issueId)
        if (issue.packed) throw err(409, 'This issue is archived. Restore it before starting or continuing a run.')
        const snapshot = await store.readSnapshot(issue.path, runId).catch(() => null)
        const holder = await exclusiveHolder(project, issueId, exclusivityOf(snapshot))
        if (holder) throw err(409, conflictMessage(holder), holder)
        inquiryAdmission(issue)
        const harnesses = await loadHarnesses()
        engine = await resumeEngine({
          issuePath: issue.path,
          runId,
          harnesses,
          stepStore: { create: (options) => issues.createStep(project, issueId, options) },
          deliveryProvider: worktreeDiffDelivery,
          configRoot,
          projectPath: await resolveProjectPath(project, { projectsDir }),
          projectAlias: projectDir(project, projectsDir),
          availability,
          emit: (event) => emit?.({ ...event, project, issueId, runId })
        })
      })
      armAutoReconcile(engine, project)
      if (!supportedActions(engine.run).includes(action)) throw err(409, reconcile ? `This run cannot be reconciled: ${reconcileUnavailable(engine.run) ?? 'it is not waiting at delivery'}.` : 'This run is not waiting at delivery; there is nothing to finalize.')
      // The budget is checked like every continuation's, before the workspace is touched:
      // refused here, the run stays blocked where it was (a refusal inside would fail it).
      if (!reconcile) engine.finalizeLimits({ budgets })
      // Its modules before it delivers (module-locks.mjs): owed since the run ended, taken by engine.finalize,
      // waited for while another run holds one, never refused. The reservation is written here, outside the
      // project's admission but under this run's issue lock (resumeEngine) and before engine.finalize records the
      // finalization: from that decision on, no start takes a module it waits for. A reconcile is unchanged.
      if (!reconcile && engine.run.moduleLocks) {
        await oweEnded(engine.run)
        await reserveModules(engine.run, { issuePath: issue.path, decision: 'finalize' })
      }
      // The policy is the project's as configured now, like a check refresh's target; it is recorded on the attempt.
      const policy = reconcile ? await reconcilePolicyOf(project) : null
      if (engine.run.workspace?.state === 'retained') {
        engine.run.workspace.state = 'active'
        engine.run.workspace.retainedReason = null
        await store.writeRun(engine.issuePath, engine.runId, engine.run)
      }
      const record = { runId, issuePath: issue.path, project, issueId, phase: action, engine, reservation: null, controller: new AbortController(), stopping: false, finished: null, home: Boolean(issue.home), cycleId: engine.run.fullVerification?.cycleId ?? null, writes: true, ...(contained ? { whole: false, classifiedFor: contained } : {}) }
      // At registration the classification is the current cycle's (continuation-crosses-thaw): one made for an earlier
      // cycle, or none (a cycle that froze while the engine was loading, when this was not yet in `active`), is read
      // again against this run's workspace, until the cycle frozen after the reading is the one it was read for.
      // `pendingWrites` still names the operation meanwhile, so the cycle waits for it.
      await classifyNow(record, engine.snapshot, engine.run.workspace)
      engine.cycleGate = gates.gateFor(record)
      active.set(k, record)
      starting.delete(k)
      pendingWrites.delete(k)
      const settle = async () => {
        await settleWorkspace(record)
        active.delete(k)
        await announceEnd(project, issueId, runId)
      }
      // The re-check before delivery, with nothing awaited between it and the delivery call: a freeze
      // that began while this was being prepared refuses it here, delivering nothing; otherwise the
      // delivery starts in this tick, already in `active`, and the cycle waits for it.
      if (frozenFor(project) && wholeRecord(record)) {
        await settleWorkspace(record).catch(() => {})
        active.delete(k)
        throw freezeRefusal()
      }
      // The operation answers `waiting` as soon as one of its writes waits for a full verification, and goes on in
      // the background: it ends by itself at the thaw, announced like any end (cycle-gates.mjs).
      let signalWaiting
      const waiting = new Promise((resolve) => { signalWaiting = resolve })
      engine.onCycleWait = (token) => signalWaiting(token)
      // Or as soon as it waits for a module another run holds: it delivers once the set is free.
      let signalModules
      const moduleWait = new Promise((resolve) => { signalModules = resolve })
      engine.onModuleWait = (wait) => signalModules(wait)
      const delivering = (async () => {
        emit?.({ type: reconcile ? 'run-reconciling' : 'run-finalizing', project, issueId, runId })
        try {
          const done = await (reconcile ? engine.reconcileDelivery({ policy, actor }) : engine.finalize({ mayReturnDelivery: true, budgets }))
          return { returned: !reconcile && done === 'returned' }
        } catch (error) {
          await failRecord(record, error)
          return { returned: false }
        }
      })()
      const afterDelivery = async ({ returned }) => {
        if (returned) {
          const decision = { deliveryReturn: engine.run.deliveryReturns?.length ?? null }
          record.finished = (async () => {
            try {
              if (oweReleased(engine.run)) await store.writeRun(engine.issuePath, engine.runId, engine.run)
              emit?.({ type: 'run-resumed', project, issueId, runId, decision })
              await driveEngine(record, engine)
            } catch (error) {
              await failRecord(record, error)
            } finally {
              await settle()
            }
          })()
          return { runId, status: 'pending', decision }
        }
        await settle()
        return { runId, status: engine.run.status, outcome: engine.run.outcome, blockedReason: engine.run.blockedReason,
          ...(reconcile ? { reconciliation: engine.run.reconciliations?.at(-1) ?? null } : {}) }
      }
      const first = await Promise.race([delivering.then((done) => ({ done })), waiting.then((token) => ({ token })), moduleWait.then((modules) => ({ modules }))])
      if (first.modules) {
        record.finished = delivering.then(afterDelivery).catch((error) => console.warn(`[devpanel] ${action} of ${project}/${issueId} run ${runId} after its module wait: ${error.message}`))
        return { runId, status: 'waiting', waitingFor: 'modules', modules: first.modules.modules, holders: first.modules.holders }
      }
      if (first.token) {
        record.finished = delivering.then(afterDelivery).catch((error) => console.warn(`[devpanel] ${action} of ${project}/${issueId} run ${runId} after the full verification: ${error.message}`))
        return { runId, status: 'waiting', cycleId: first.token.cycleId, waitingFor: reconcile ? 'reconcile' : 'delivery' }
      }
      return afterDelivery(first.done)
    } catch (error) {
      starting.delete(k)
      pendingWrites.delete(k)
      if (engine && !active.has(k)) {
        // A finalize refused before it was registered gives back its reservation (its set stays owed on the record).
        await releaseEndedRunLocks(engine.run, engine.issuePath)
        await engine.runLock?.release().catch(() => {})
      }
      throw translate(error)
    }
  }

  async function abandon ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const issue = await holderOf(project, issueId)
    if (active.has(key(project, issueId))) throw err(409, 'Stop the active run and wait for it to finish before abandoning.')
    try {
      return await withIssueLock(path.join(issue.path, '.run.lock'), { purpose: 'run-abandon', takeOverDead: false }, async () => {
        const run = await store.readRun(issue.path, runId)
        if (run.abandonment) return run
        if (LIVE_STATUSES.includes(run.status)) throw err(409, 'The run still claims to be active. Stop it before abandoning.')
        if (!['blocked', 'paused', 'failed'].includes(run.status) && !supportedActions(run).includes('abandon')) throw err(409, 'This run does not need abandonment.')
        const original = JSON.parse(await fs.readFile(path.join(store.runDir(issue.path, runId), 'run.json'), 'utf8'))
        const at = new Date().toISOString()
        // Preserve the unresolved facts before clearing the execution blockers.
        run.abandonment = { at, by: 'operator', previousStatus: run.status, recovery: original.recovery ?? null,
          blockedReason: run.blockedReason, participants: structuredClone(run.participants ?? {}),
          outcome: run.outcome, result: run.result, journal: run.journal ?? null, integrity: run.integrity ?? null }
        run.status = 'cancelled'
        run.endedAt = at
        run.outcome = 'unresolved'
        leaveRecovery(run, { how: 'abandoned', by: 'operator', at, clear: { required: false, resolution: 'abandoned', resolvedAt: at } })
        run.blockedReason = null
        for (const participant of Object.values(run.participants ?? {})) {
          participant.pendingInvocation = null
          participant.state = 'abandoned'
        }
        if (run.workspace && run.workspace.state !== 'removed') {
          run.workspace.state = 'retained'
          run.workspace.retainedReason = 'Operator abandoned interrupted work; outcomes remain unverified.'
        }
        await store.writeRun(issue.path, runId, run)
        // An abandoned run carries no decision on: a module reservation it left goes.
        await dropReservation(run.moduleLocks?.pool, runId).catch(() => {})
        await announceEnd(project, issueId, runId, 'run-abandoned')
        return run
      })
    } catch (error) {
      if (error.code === 'ENOENT') throw err(404, 'No such run')
      if (error instanceof LockHeld) throw err(409, 'Execution still owns this issue, or ownership cannot be verified. Abandonment refused.', { code: 'ISSUE_BUSY', retryable: true })
      throw error
    }
  }

  /**
   * Delete a settled run: its workspace, its record under runs/<id>/ and its
   * step folders in the issue (turns, operator answers, the result entry).
   * Irreversible, and on the operator's click alone: the panel asks nothing, as
   * the trash icon promises. What stays: the step reservations, so a number is
   * never handed out twice and provenance holds; the spending ledger, which is
   * accounting. Its refs/devpanel/* go too, but only when the run would have
   * kept nothing else (ref-retention.mjs, execution-contract.md "Retiring
   * refs/devpanel/*"): the gates are read before anything is removed, the refs
   * captured with their oids, and deleted in one transaction once the record is
   * gone; a run that fails a gate keeps its refs and is deleted all the same
   * (`refs` on the result says which). A live or paused run is refused — stop or
   * abandon it first — and the issue lock is taken so no start races the delete.
   */
  async function deleteRun ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const issue = await holderOf(project, issueId)
    if (issue.packed || issue.archived) throw err(409, 'This issue is archived. Restore it before deleting a run.')
    if (active.has(key(project, issueId)) || starting.has(key(project, issueId))) throw err(409, 'A run is active on this issue; wait for it to settle.')
    try {
      // The issue's step lock straight after the run lock, before anything changes: coverage receipts check and
      // write under it (issues.js writeCoverageReceipt), and a busy one refuses (ISSUE_BUSY) with nothing touched.
      return await withIssueLock(path.join(issue.path, '.run.lock'), { purpose: 'run-delete', takeOverDead: false }, () =>
        withIssueLock(path.join(issue.path, '.step-alloc.lock'), { purpose: 'run-delete', waitMs: seams.stepLockWaitMs ?? 10000, doing: 'Deleting the run' }, async () => {
        const run = await store.readRun(issue.path, runId)
        if (LIVE_STATUSES.includes(run.status) || run.status === 'paused') throw err(409, `The run is ${run.status}. Stop or abandon it before deleting.`)
        if (reconcilePending(run)) throw err(409, 'An automatic reconcile of this run is undecided; wait for it before deleting.')
        // Its record may be the only durable copy of an unproved cleanup (the barrier file refused it).
        if ((await unrecordedCleanup(path.dirname(issue.path), run)).length) throw err(409, unrecordedRefusal(run, 'deleting the run'), { code: 'CLEANUP_UNRECORDED' })
        // Before anything goes: may its refs go with it, and which, at which oids.
        const refPlan = await planDeletedRun({ issuesRoot: path.dirname(path.dirname(issue.path)), issuePath: issue.path, runId, actionsOf: (r) => supportedActions(r) })
          .catch((error) => ({ eligible: false, reason: 'error', error }))
        await removeRunWorkspace(run, await resolveProjectPath(project, { projectsDir }).catch(() => null))
        // Its end destroyed its stage instances; one that could not be removed then is tried once more.
        await destroyRunInstances(runId, { reason: 'run-deleted' }).catch(() => [])
        // So is a dependency sync neither its drive nor its end could revert.
        if (syncDisposition(run) === 'revert') await settleRunSyncs(runId, { how: 'revert', reason: 'run-deleted' }).catch(() => [])
        let reservations = []
        try { reservations = JSON.parse(await fs.readFile(path.join(issue.path, '.step-reservations.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
        const folders = new Set((run.steps ?? []).map((s) => `${s.number}-${s.slug}`))
        for (const r of reservations) if (r.invocationId === `run-result:${runId}`) folders.add(r.folder)
        // Only folders named like steps, directly in the issue: nothing outside it can be named here.
        for (const folder of folders) if (/^\d{3}-[a-z0-9-]+$/.test(folder)) await fs.rm(path.join(issue.path, folder), { recursive: true, force: true })
        await fs.rm(store.runDir(issue.path, runId), { recursive: true, force: true })
        // Its module reservation, if one was left (a deleted run reserves nothing: module-locks.mjs readReservations).
        await dropReservation(run.moduleLocks?.pool, runId).catch(() => {})
        // What its drives told the classification of unstable selftests goes with them.
        await forgetRunDrives(issue.path, runId)
        let refs = { retired: [], kept: refPlan.eligible ? null : refPlan.reason, changed: [], error: refPlan.error?.message ?? null }
        if (refPlan.eligible && refPlan.refs.length) {
          refs = await retireRefs({ repository: refPlan.repository, selected: refPlan.refs })
            .then((r) => ({ retired: r.retired, kept: null, changed: r.changed, error: null }), (error) => ({ retired: [], kept: null, changed: [], error: error.message }))
        }
        if (refs.error) console.warn(`deleteRun ${project}/${issueId}/${runId}: its refs/devpanel/* were kept: ${refs.error}`)
        return { runId, deleted: true, steps: [...folders].sort(), refs }
      }))
    } catch (error) {
      if (error.code === 'ENOENT') throw err(404, 'No such run')
      if (error instanceof LockHeld) throw err(409, 'Execution still owns this issue, or ownership cannot be verified. Run not deleted.', { code: 'ISSUE_BUSY', retryable: true })
      throw error
    }
  }

  /**
   * A person's record that they landed a run's work by hand: what was applied,
   * where it went (a commit or a checkout path), when, and what they changed
   * beyond the patch. It is a claim with evidence, nothing is read from the
   * source repository to support or refute it, and it changes no outcome,
   * closure or approval. A settled run has no engine in memory, so one is
   * loaded for it, holding the run lock, and the record is written through that
   * engine's queue (engine.recordLanding).
   */
  async function markLanded ({ project, issueId, runId, by, applied, commit = null, checkout = null, handChanges, landedAt = null }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\0\r]/.test(value) ? value.trim() : null
    const record = { by: text(by, 200), applied: text(applied, 2000), handChanges: text(handChanges, 4000),
      commit: commit == null ? null : text(commit, 64), checkout: checkout == null ? null : text(checkout, 1000) }
    if (!record.by) throw err(400, 'who landed it is required')
    if (!record.applied) throw err(400, 'applied is required: say what was applied (the patch, a part of it, a revision)')
    if (!record.handChanges) throw err(400, 'handChanges is required: say what was changed by hand beyond the patch, or "none"')
    if (!record.commit && !record.checkout) throw err(400, 'name the commit hash or the checkout path it landed in')
    if (record.commit && !/^[0-9a-f]{7,64}$/i.test(record.commit)) throw err(400, 'commit must be a hexadecimal commit hash')
    if (record.checkout && (!path.isAbsolute(record.checkout) || /[\x00-\x1f]/.test(record.checkout))) throw err(400, 'checkout must be an absolute path')
    if (landedAt != null && !Number.isFinite(Date.parse(landedAt))) throw err(400, 'landedAt must be a date and time')
    const issue = await issues.getIssue(project, issueId)
    if (issue.packed) throw err(409, 'This issue is archived. Restore it before recording a landing.')
    if (active.has(key(project, issueId)) || starting.has(key(project, issueId))) throw err(409, 'A run is active on this issue; wait for it to settle.')
    let engine = null
    try {
      engine = await resumeRun({ issuePath: issue.path, runId, harnesses: {}, configRoot, projectPath: await resolveProjectPath(project, { projectsDir }).catch(() => null) })
      const landed = await engine.recordLanding({ ...record, landedAt: landedAt ? new Date(landedAt).toISOString() : null })
      await engine.runLock?.release().catch(() => {})
      engine = null
      await announceEnd(project, issueId, runId, 'run-landed')
      return { runId, landed }
    } catch (error) {
      await engine?.runLock?.release().catch(() => {})
      if (error.code === 'ENOENT') throw err(404, 'No such run')
      if (error instanceof LockHeld) throw err(409, 'Execution still owns this issue, or ownership cannot be verified. Landing not recorded.', { code: 'ISSUE_BUSY', retryable: true })
      throw error
    }
  }

  // ----------------------------------------------------------- reconciliation

  /**
   * Who holds this issue, and whether they hold it for the run being asked about.
   *
   * The lock is per issue, not per run, so a live lock is only evidence about the
   * run it names. Reading it as evidence about a different run would leave a
   * stale run un-reconciled, and deleting it would strip a live owner of its lock.
   */
  /*
   * What a sweep's settling of an unfinished publication says. Only a record
   * that changed is announced: a refusal (the lock held, a journal needing
   * recovery) leaves the record as it was, and announcing it would wake every
   * dashboard into polling again into the same refusal. It is warned once.
   * True when another owner holds the issue's lock: the caller skips the run.
   */
  const integrationRefusals = new Set()
  function noteIntegrationSweep (swept, project, issue, runId) {
    const settled = swept?.settled
    if (!settled) return false
    const key = `${issue.path}\0${runId}`
    if (settled.reconciled === true) {
      for (const k of integrationRefusals) if (k.startsWith(`${key}\0`)) integrationRefusals.delete(k)
      emit?.({ type: 'integration-reconciled', project, issueId: issue.id, runId, phase: settled.phase ?? null, error: settled.integration?.error ?? null })
    } else if (settled.refused) {
      const once = `${key}\0${settled.refused.code ?? 'error'}`
      if (!integrationRefusals.has(once)) {
        integrationRefusals.add(once)
        console.warn(`[devpanel] the unfinished publication of ${project}/${issue.id} run ${runId} was not reconciled: ${settled.refused.message}`)
      }
    }
    return swept.held === true
  }

  /** An owner proved alive, or one whose liveness cannot be established: never taken over. */
  const held = (owner) => owner.liveness === 'alive' || owner.liveness === 'unknown'

  async function lockOwner (issuePath, runId = null) {
    const file = path.join(issuePath, '.run.lock')
    let record = null
    try {
      record = JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
      return { record: null, liveness: 'absent', mine: false, forThisRun: false }
    }
    const liveness = await ownerLiveness(record.owner, { platform })
    return {
      record,
      liveness,
      // Ours only when proved to be this very process: a pid equal to ours
      // whose start time cannot be read could be an earlier holder of it.
      mine: liveness === 'alive' && record.owner?.pid === process.pid,
      forThisRun: runId != null && record.owner?.runId === runId
    }
  }

  /**
   * A run whose owner is gone. What its last invocation did is unrecorded and
   * unrecoverable from state alone, so it is marked recovery-required rather than
   * quietly cancelled — a cancelled run says "nothing further happened", and
   * nobody here knows that.
   */
  async function markUnowned (issuePath, observed, owner) {
    // Under the issue's run lock, or not at all: a dead owner's lock is taken
    // over, a live or unknown one refuses, and the record is read again under it,
    // so an owner that appeared since `owner` was read is never overwritten.
    let lock
    try {
      lock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'recovery', runId: observed.runId, platform, mkdir: false })
    } catch (error) {
      if (error instanceof LockHeld) return null
      throw error
    }
    try {
      const run = await store.readRun(issuePath, observed.runId).catch(() => null)
      if (!run || !LIVE_STATUSES.includes(run.status)) return null
      return await markUnownedHeld(issuePath, run, owner)
    } finally {
      await lock.release()
    }
  }

  async function markUnownedHeld (issuePath, run, owner) {
    const wasStopping = run.status === 'stopping'
    const detail = owner.liveness === 'absent'
      ? 'no lock was held for it when this server took over'
      : `the process that owned it (pid ${owner.record?.owner?.pid}) is gone`

    run.outcome = 'unresolved'
    // When the owner was last seen doing something: the time from then until a
    // recovery is time nobody owned the run, not time the run spent.
    const events = await store.readEvents(issuePath, run.runId).catch(() => null)
    enterRecovery(run, {
      ownerLost: true,
      reason: `the run was ${wasStopping ? 'stopping' : 'live'} when its owner disappeared — ${detail}`,
      lastActivityAt: events?.events?.at(-1)?.at ?? null
    }, new Date().toISOString())
    // No agent is in flight: a durable application intent can be reconciled
    // from the destination by Finalize, without replaying a model invocation.
    const snapshot = await store.readSnapshot(issuePath, run.runId).catch(() => null)
    const application = await fs.readFile(path.join(store.runDir(issuePath, run.runId), 'source-application.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (snapshot?.completion?.delivery?.action === 'apply-to-source' &&
      application?.revision === run.revisions?.at(-1)?.fingerprint &&
      application?.path === run.workspace?.source?.path &&
      run.integrity?.status === 'clear' && !run.journal?.recoveryRequired &&
      Object.values(run.participants ?? {}).every(p => !p.pendingInvocation)) {
      run.blockedReason = 'source-delivery-interrupted'
      run.recovery = { required: false, reason: 'Finalize must reconcile source delivery from the destination fingerprint.', detectedAt: new Date().toISOString() }
    }
    // Whatever was written is left exactly as it was found.
    if (run.workspace?.state === 'active') {
      run.workspace.state = 'retained'
      run.workspace.retainedReason = 'the owning process disappeared; the candidate is untouched'
    }
    // The lost owner's turns left their reap tags on disk: scanned now, scan
    // only. A tag that scans clean is proved; a survivor, or a scan that
    // failed, stays open. A barrier write that fails is recorded on the run,
    // never thrown (one run must not stop the reconcile of the next), and the
    // supervisor holds the barrier itself until the write succeeds.
    try {
      await noteLostTags(run, { platform, projectDir: path.dirname(issuePath), at: new Date().toISOString() })
    } catch (error) {
      run.recovery.cleanupNoteFailed = { at: new Date().toISOString(), error: error.message }
    }
    await store.writeRun(issuePath, run.runId, run)
    await keepOnBarrier(path.dirname(issuePath), run)
    return run
  }

  /**
   * Rebuild ownership at startup.
   *
   * Every run persisted as live either belongs to a process that is still there —
   * leave it alone — or to one that is not, in which case it is recovery-required.
   * Without this, a restarted server advertises Stop on a run it cannot stop, and
   * answers "already stopped" for one it simply never knew about.
   */
  async function reconcile () {
    const recovered = []
    // What this sweep could not read; a marker in there is released once it reads.
    const unread = []
    let projects = []
    try {
      projects = await issues.listProjects()
    } catch {
      recoverHeldReconciles([{}])
      return recovered
    }

    for (const project of projects) {
      const projectId = project.id ?? project.name ?? project
      // Active issues only. That is safe *because* archiving refuses an issue
      // holding a live or recovery-required run — the two rules depend on each
      // other, so loosening either one without the other leaves a run persisted
      // as live that nothing will ever reconcile.
      let list = []
      try { list = await issues.listIssues(projectId) } catch { unread.push({ project: projectId }); continue }
      // The full verification's run homes hold runs too, and a crash leaves theirs to recover like any other.
      list = [...list, ...await homesOf(projectId)]
      // Notes kept for an archived issue whose restore did not get to them.
      await issues.drainArchivedNotes?.(projectId).catch((error) => console.warn(`[devpanel] could not finish the archived notes of ${projectId}: ${error.message}`))

      for (const issue of list) {
        await resumeCoverageNotes({ project: projectId, issue, issues }).catch((error) => console.warn(`[devpanel] could not resume the deployment notes of ${projectId}/${issue.id}: ${error.message}`))
        let names = []
        try {
          names = await runNames(issue)
        } catch (error) {
          if (error.code !== 'ENOENT') unread.push({ project: projectId, issue })
          continue
        }

        for (const runId of names) {
          // A publication the previous process did not finish is settled from
          // its record, under the run lock, before anything else is offered on
          // the run (sweepPendingIntegration).
          const swept = await sweepPendingIntegration({ issuePath: issue.path, runId, platform, hooks: { cycleGate: sweepGate(projectId, issue.id, runId, issue.path) } }).catch((error) => {
            if (error.code !== 'ENOENT') unread.push({ project: projectId, issue, runId })
            return null
          })
          // Another owner holds the issue: nothing more for this run until a
          // later sweep (the next start), so nothing is written without the lock.
          if (noteIntegrationSweep(swept, projectId, issue, runId)) continue
          const run = swept?.run
          if (!run) continue
          // No cycle and no waiting operation survive a restart: a wait left open on the record ends as stopped (the
          // operator asks again), so no run reads as waiting for an operation that no longer exists.
          // Only under the issue's run lock, and only when no live (or unknown) owner holds it: a wait another live process
          // keeps open is its own (orphaned-operator-cycle-wait).
          if (run.cycleWait && !held(await lockOwner(issue.path, runId))) {
            let lock = null
            try {
              lock = await acquire(path.join(issue.path, '.run.lock'), { purpose: 'cycle-wait-close', runId, platform, mkdir: false })
              const current = await store.readRun(issue.path, runId)
              if (current.cycleWait) {
                const open = current.cycleWait
                current.cycleWait = null
                ;(current.cycleWaits ??= []).push({ kind: open.kind ?? 'write', action: open.action ?? null, cycleId: open.cycleId ?? null, repositories: open.repositories ?? [], from: open.since ?? null, to: new Date().toISOString(), endSeq: null, outcome: 'stopped' })
                await store.writeRun(issue.path, runId, current)
                Object.assign(run, { cycleWait: null, cycleWaits: current.cycleWaits })
              }
            } catch (error) {
              console.warn(`[devpanel] the stale full verification wait of ${projectId}/${issue.id} run ${runId} was left: ${error.message}`)
            } finally {
              await lock?.release().catch(() => {})
            }
          }
          // The barrier as the run records say: open entries a failed write
          // left off it are put back (or held here), settled ones lifted.
          await keepOnBarrier(path.dirname(issue.path), run)
          await releaseIfLeftBehind(projectId, issue.id, run)
          if (!LIVE_STATUSES.includes(run.status)) {
            await resumeCoverageNotes({ project: projectId, issue, run, issues }).catch((error) => console.warn(`[devpanel] could not resume the coverage notes of ${projectId}/${issue.id} run ${runId}: ${error.message}`))
            continue
          }

          const owner = await lockOwner(issue.path, runId)
          const foreignLive = held(owner) && !owner.mine

          // Live and holding the lock FOR THIS RUN: it genuinely belongs to
          // someone else, so leave it entirely alone.
          if (owner.forThisRun && foreignLive) continue

          if (!await markUnowned(issue.path, run, owner)) {
            const now = await lockOwner(issue.path, runId)
            if (held(now)) console.warn(`[devpanel] reconcile skipped ${projectId}/${issue.id} run ${runId}: the issue's run lock is held (${now.liveness}, pid ${now.record?.owner?.pid ?? 'unknown'})`)
            continue
          }
          recovered.push({ project: projectId, issueId: issue.id, runId })
          emit?.({ type: 'run-recovery-required', project: projectId, issueId: issue.id, runId })
        }
      }
      // A release's notes outlive its issue being archived: nothing else would come for them.
      if (issues.createEngineNote) {
        for (const issue of await issues.listIssues(projectId, { archived: true }).catch(() => [])) {
          await resumeArchivedCoverageNotes({ project: projectId, issue, issues }).catch((error) => console.warn(`[devpanel] could not resume the coverage notes of archived ${projectId}/${issue.id}: ${error.message}`))
        }
      }
    }
    if (unread.length) recoverHeldReconciles(unread)
    return recovered
  }

  /**
   * Give back what the last shutdown took (host settings `resumeAfterShutdown`):
   * at start-up, after reconcile, before anything is served. Each run marked
   * `stoppedBy: 'service-shutdown'` goes through the ordinary resume, with no
   * budgets, so its limits, admission and every refusal are that resume's. One
   * attempt per mark: a refused run stays cancelled and marked with the reason on
   * `run.autoResumeRefused`, for a person; their resume clears both.
   *
   * Newest first: the slot of a project goes to what the last shutdown stopped,
   * not to an older mark left while this was switched off.
   */
  async function resumeInterrupted () {
    const found = []
    let projects = []
    try { projects = await issues.listProjects() } catch (error) {
      console.warn(`[devpanel] resuming interrupted runs: the projects could not be listed: ${error.message}`)
      return { resumed: [], refused: [] }
    }
    for (const project of projects) {
      const projectId = project.id ?? project.name ?? project
      const list = await issues.listIssues(projectId).catch(() => [])
      for (const issue of list) {
        const names = await runNames(issue).catch(() => [])
        for (const runId of names) {
          const run = await store.readRun(issue.path, runId).catch(() => null)
          if (awaitsAutoResume(run) || awaitsAutoFinalize(run)) found.push({ project: projectId, issue, run })
        }
      }
    }
    found.sort((a, b) => String(b.run.endedAt).localeCompare(String(a.run.endedAt)))

    const resumed = []
    const refused = []
    for (const { project, issue, run } of found) {
      const { runId } = run
      const named = { project, issueId: issue.id, runId }
      try {
        // Not the run a person went on with: they started another after this one stopped.
        if (issue.latestRun?.runId !== runId) throw err(409, `a newer run of this issue exists (${issue.latestRun?.runId ?? 'unknown'})`)
        // A finalize the shutdown stopped while it waited for its modules is finalized again; anything else resumes.
        if (awaitsAutoFinalize(run)) await finalize({ ...named, actor: 'service' })
        else await answer({ ...named, resume: true, actor: 'service', origin: 'service-restart' })
        resumed.push(named)
      } catch (error) {
        const reason = error.message
        refused.push({ ...named, reason })
        console.warn(`[devpanel] ${project}/${issue.id} run ${runId} was not resumed after the shutdown: ${reason}`)
        await withIssueLock(path.join(issue.path, '.run.lock'), { purpose: 'auto-resume-refused', takeOverDead: false }, async () => {
          const current = await store.readRun(issue.path, runId)
          current.autoResumeRefused = { at: new Date().toISOString(), reason }
          await store.writeRun(issue.path, runId, current)
          // A journal needing recovery may be the refusal itself; the record above holds it.
          await store.appendEvent(issue.path, runId, { type: 'auto-resume-refused', reason }).catch(() => {})
        }).catch((writeError) => console.warn(`[devpanel] the refusal could not be recorded on run ${runId}, the next start tries again: ${writeError.message}`))
        emit?.({ type: 'run-auto-resume-refused', ...named, reason })
      }
    }
    return { resumed, refused }
  }

  // ------------------------------------------------------------ live agents

  /**
   * Every agent currently invoked, across every project.
   *
   * Built from persisted state rather than from this process's memory, so a run
   * driven by another server still appears — but ownership is reported rather
   * than assumed. A run persisted as `running` whose owner is gone is not an
   * agent that is working; it is a run nobody is driving, and saying otherwise
   * would put a spinner next to something that will never move again.
   *
   * A live run with nothing in flight is included too, marked as between turns.
   * Dropping it would make a working playbook vanish from the list every time a
   * turn ends and reappear when the next one starts.
   */
  async function liveAgents () {
    const out = []
    let projects = []
    try { projects = await issues.listProjects() } catch { return out }

    for (const project of projects) {
      const projectId = project.id ?? project.name ?? project
      let list = []
      // Active issues only: an archived issue cannot hold a live run, because
      // archiving refuses one.
      try { list = await issues.listIssues(projectId) } catch { continue }
      list = [...list, ...await homesOf(projectId)]

      for (const issue of list) {
        let names = []
        try {
          names = (await fs.readdir(store.runsDir(issue.path), { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
            .map((e) => e.name)
        } catch { continue }

        for (const runId of names) {
          // A publication the previous process did not finish: settled under
          // the run lock first; a held lock leaves the run to a later poll.
          const swept = await sweepPendingIntegration({ issuePath: issue.path, runId, platform, hooks: { cycleGate: sweepGate(projectId, issue.id, runId, issue.path) } }).catch(() => null)
          if (noteIntegrationSweep(swept, projectId, issue, runId)) continue
          const run = swept?.run
          if (!run) continue
          if (!LIVE_STATUSES.includes(run.status)) continue

          const owner = await lockOwner(issue.path, runId)
          const driving = isActive(projectId, issue.id) && active.get(key(projectId, issue.id))?.runId === runId
          const ownership = driving
            ? 'this-process'
            : owner.forThisRun && owner.liveness === 'alive' ? 'another-process'
              : owner.forThisRun && owner.liveness === 'unknown' ? 'owner-unknown'
                : owner.liveness === 'alive' ? 'another-run' : 'unowned'

          const snapshot = await store.readSnapshot(issue.path, runId).catch(() => null)

          const agents = Object.entries(run.participants ?? {})
            .filter(([, p]) => p.pendingInvocation)
            .map(([role, p]) => {
              const spec = snapshot?.participants?.[role] ?? null
              return {
                role,
                model: spec?.model?.id ?? p.model ?? null,
                // The roster id is not what a runtime was invoked with; both matter.
                wireModel: spec?.model?.wire ?? null,
                harness: spec?.model?.harness ?? p.harness ?? null,
                profile: spec?.model?.profile ?? p.profile ?? null,
                effort: spec?.effort ?? p.effort ?? null,
                state: p.state,
                session: p.session?.id ?? null,
                stepId: p.pendingInvocation.cursor?.stepId ?? null,
                round: p.pendingInvocation.cursor?.round ?? null,
                attempt: p.pendingInvocation.cursor?.attempt ?? null,
                invocationId: p.pendingInvocation.invocationId,
                startedAt: p.pendingInvocation.startedAt,
                activity: p.pendingInvocation.activity ?? null
              }
            })

          out.push({
            project: projectId,
            issueId: issue.id,
            issueName: issue.name,
            runId,
            playbook: run.playbook,
            status: run.status,
            phase: run.phase,
            startedAt: run.startedAt,
            ownership,
            owner: owner.record?.owner
              ? { pid: owner.record.owner.pid, host: owner.record.owner.host }
              : null,
            budgets: run.budgets,
            steps: run.steps?.length ?? 0,
            agents,
            supportedActions: supportedActions(run, { active: driving })
          })
        }
      }
    }

    // Longest-waiting first: a turn that has been out for an hour is the one
    // somebody needs to look at.
    return out.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
  }

  // ------------------------------------------------------------ shutting down

  /**
   * Stop everything this process is driving, and wait for it.
   *
   * Exiting without this leaves agent processes running with nobody to attribute
   * them to, and leaves runs persisted as live whose owner is about to vanish.
   */
  async function shutdown ({ graceMs = shutdownGraceMs } = {}) {
    shuttingDown = true
    const records = [...active.values()]

    await Promise.allSettled(records.map((r) => beginStop(r, SERVICE_SHUTDOWN)))

    // Whatever does not settle in time is left for the next start-up to
    // reconcile — as recovery-required, which is what it genuinely is.
    const settled = await Promise.race([
      Promise.allSettled(records.map((r) => r.finished)).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs))
    ])

    return { stopped: records.length, settled }
  }

  const isActive = (project, issueId) => active.has(key(project, issueId))
  /** When the check this process is running for that run began; null when none is. */
  const liveCheckSince = (project, issueId, runId) => {
    const record = active.get(key(project, issueId))
    return record?.runId === runId ? record.engine?.checkRunningSince ?? null : null
  }

  /** For tests and shutdown: wait for whatever is running to settle. */
  const settle = () => Promise.allSettled([...active.values()].map((r) => r.finished))

  const packInquiry = ({ project, inquiryId }) => admission(project, () => packInquiryLocked(project, inquiryId))
  /*
   * The operator's conversation with a run's coordinator
   * (runtime/coordinator-chat.mjs). Neither kind of message takes the run lock
   * or touches run.json: a question is answered in a fork of the coordinator's
   * session, and an instruction is appended to the run's chat file for the
   * engine to deliver at the coordinator's next turn.
   */
  const asking = new Map() // `${project}/${issueId}/${runId}` -> Map of question id -> fork invocation id, in flight

  /** The live engine when the run is driven here, else a lock-free read of it. */
  async function chatEngine (project, issueId, runId) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const live = active.get(key(project, issueId))
    if (live?.runId === runId && live.engine) return live.engine
    const issue = await holderOf(project, issueId)
    if (issue.packed) throw err(409, 'This issue is archived. Restore it to talk to its runs.')
    return resumeRun({ issuePath: issue.path, runId, harnesses: {}, takeLock: false, configRoot, projectPath: await resolveProjectPath(project, { projectsDir }).catch(() => null) })
  }

  async function chatHistory ({ project, issueId, runId }) {
    const engine = await chatEngine(project, issueId, runId)
    const entries = await readChat(engine.issuePath, runId)
    const role = coordinatorRole(engine.snapshot)
    const p = role ? engine.run.participants?.[role] : null
    return {
      role,
      model: role ? engine.participantSpec(role).model?.id ?? null : null,
      canAsk: Boolean(p?.session?.id || p?.readSession?.id),
      instructionRefusal: instructionRefusal(engine.run),
      asking: [...(asking.get(`${project}/${issueId}/${runId}`)?.keys() ?? [])],
      entries: chatView(entries, engine.run.steps ?? [], { asking: asking.get(`${project}/${issueId}/${runId}`) ?? new Map() })
    }
  }

  async function instructCoordinator ({ project, issueId, runId, text, actor }) {
    const engine = await chatEngine(project, issueId, runId)
    if (!coordinatorRole(engine.snapshot)) throw err(409, 'this run has no coordinator seat')
    const entry = await recordInstruction({ issuePath: engine.issuePath, runId, run: engine.run, text, actor })
    const view = { ...entry, delivery: 'waiting', carriedBy: [] }
    emit?.({ type: 'chat', project, issueId, runId, entry: view })
    return view
  }

  /** Starts the question and returns once it is recorded; the answer arrives as a `chat` event. */
  async function askCoordinatorQuestion ({ project, issueId, runId, text, actor }) {
    if (shuttingDown) throw err(503, 'the server is shutting down')
    const k = `${project}/${issueId}/${runId}`
    if (asking.get(k)?.size) throw err(409, 'the coordinator is still answering the previous question')
    const engine = await chatEngine(project, issueId, runId)
    const harnesses = await loadHarnesses()
    const inFlight = asking.get(k) ?? new Map()
    asking.set(k, inFlight)
    let recorded
    const ready = new Promise((resolve) => { recorded = resolve })
    const done = askCoordinator(engine, {
      text, actor, harnesses,
      emit: (event) => emit?.({ ...event, project, issueId, runId }),
      onAsking: (id, invocationId) => { inFlight.set(id, invocationId ?? null); recorded(id) }
    }).finally(() => { inFlight.clear(); asking.delete(k) })
    // Validation and "no session yet" fail before anything is recorded.
    const first = await Promise.race([ready, done.then(() => null)])
    if (first === null) await done
    done.catch((error) => console.error('coordinator question failed', error))
    return { questionId: first, state: 'asking' }
  }

  return { setAutoStartGate, setAfterEnd, liveCheckSince, pathOverlap, chatHistory, acknowledgeCleanup, proveCleanup, instructCoordinator, askCoordinator: askCoordinatorQuestion, inquiryStatus, closeInquiry, reopenInquiry, packInquiry, start, answer, pause: pauseRun, resume: args => answer({ ...args, resume: true }), recover: args => answer({ ...args, recover: true }), resolveIntegrity: ({ disposition, expectedStateHash, reason, ...args }) => answer({ ...args, integrity: { disposition, expectedStateHash, reason } }), inspectIntegrity, retryInput: args => answer({ ...args, retryInput: true }), refreshChecks: args => answer({ ...args, refreshChecks: true }), continueRun: args => answer({ ...args, continueRun: true }), acceptCheckResult: ({ failures, reason, revision, authority = 'operator', ...args }) => answer({ ...args, acceptCheck: { failures, reason, revision, authority } }), finalize, reconcileDelivery: args => finalize({ ...args, reconcile: true }), stop, abandon, deleteRun, markLanded, isActive, checkoutHolder, settle, reconcile, resumeInterrupted, shutdown, liveAgents, active, availability, deliveryActions: worktreeDiffDelivery.actions, freeze: freezeAdmission, thaw: thawAdmission, frozen: () => freeze, frozenFor, wholeOf, startsConfined: () => startsConfined(), busy, busyActions, releaseIdle, gates, cycleGateFor: (record) => gates.gateFor(record), writeGateFor, moduleLockReading, modulesCoverage }
}

/**
 * May the worktree be deleted?
 *
 * Only when its content is provably captured elsewhere, or provably absent.
 * "Delivery completed" is not that: a `none` delivery captures nothing by
 * definition — an analysis run whose author accidentally wrote a file would
 * otherwise have that file deleted on completion — and a patch counts only when
 * reconstruction proved it. No reconstruction is no proof.
 */
export function workspaceDisposition (run, verdict) {
  if (run.workspace?.isolation === 'in-place') return { discard: false, reason: 'the workspace is the project checkout itself and is never removed' }
  if (openCleanup(run).length) return { discard: false, reason: 'processes a turn started were not proved gone; the workspace is kept until the cleanup is proved or acknowledged' }
  // A configuration violation not yet acknowledged, or a consult seat not yet
  // settled: the public recovery action needs the workspace (engine markConfigUnresolved).
  if (run.configUnresolved?.length || run.recovery?.consultPending) return { discard: false, reason: 'an interrupted guarded turn is still to be settled through recovery; the workspace is kept for it' }
  if (run.delivery?.action === 'apply-to-source' && (!run.delivery.completedAt || run.delivery.application?.verified !== true)) {
    return { discard: false, reason: 'source delivery is not verified; retain the candidate for finalization or manual application' }
  }
  if (run.workspace?.retention) {
    if (run.status !== 'completed' || run.outcome !== 'resolved') return {discard:false,reason:'unsuccessful tactical run retained for recovery'}
    if (run.workspace.retention.completed === 'retain') return {discard:false,reason:'completed workspace retained by project policy'}
  }
  if (run.journal?.recoveryRequired) return { discard: false, reason: 'event journal requires recovery; workspace retained' }
  if (run.status === 'paused') return { discard: false, reason: 'the run is paused for an operator decision and resumes in this worktree' }
  if (run.integrity?.status === 'quarantined') return { discard: false, reason: 'source integrity quarantine requires an explicit recovery disposition' }
  if (!resumeUnavailable(run)) return { discard: false, reason: 'unfinished run retained for operator resume' }
  if (verdict.unchanged && verdict.proven) return { discard: true, reason: verdict.reason }
  const delivery = run.delivery
  // Positive evidence only: a missing reconstruction, or one that says
  // anything but exactly true, is not proof the artifact rebuilds the content.
  const captured = Boolean(delivery?.completedAt) && delivery.action !== 'none' && delivery.reconstruction?.verified === true
  if (captured) return { discard: true, reason: 'the candidate is captured in the run artifacts and reconstruction was verified' }
  if (delivery?.completedAt && delivery.action !== 'none') {
    return { discard: false, reason: `delivery completed but reconstruction was not verified — ${verdict.reason}` }
  }
  if (delivery?.completedAt && delivery.action === 'none') {
    return { discard: false, reason: `the workspace changed but a "none" delivery captures nothing — ${verdict.reason}` }
  }
  return {
    discard: false,
    reason: verdict.proven
      ? `undelivered work is still here — ${verdict.reason}`
      : `kept because nothing proved it empty — ${verdict.reason}`
  }
}

/** The refusal assertLaunchable would raise, as a value. */
function refusalOf (result) {
  try {
    assertLaunchable(result)
    return new Error('refusing to launch: preflight did not pass')
  } catch (error) {
    return error
  }
}

/** Map internal failures onto answers a caller can act on. */
function translate (error) {
  // The admission lock is also held by an issue being archived, restored or deleted (issues.js); either way retryable.
  if (error instanceof LockHeld) return occupied(path.basename(error.file) === '.admission.lock' ? 'other starts on this project are still being admitted; try again shortly' : 'another run already holds this issue', { code: 'ISSUE_BUSY' })
  // The refusal names what was unproven. A generic message would leave the
  // operator with a button that fails for no stated reason.
  if (error.message?.startsWith('refusing to launch')) return err(422, error.message)
  if (error.errors) return err(422, error.message, { errors: error.errors })
  return error
}

/**
 * What the backend will actually accept for a run in this state. Settling an
 * unproved cleanup comes first, whatever else the run offers (an abandoned run
 * included): proving it where this host can scan, acknowledging it always.
 */
export function supportedActions (run, { active = false, refresh } = {}) {
  const base = baseActions(run, { active, refresh })
  const open = openCleanup(run)
  if (!open.length || active || LIVE_STATUSES.includes(run.status)) return base
  return [...(open.some((e) => e.structural) || !hostPlatform().descendantScan?.proved ? [] : ['prove-cleanup']), 'acknowledge-cleanup', ...base]
}

function baseActions (run, { active = false, refresh } = {}) {
  if (run.abandonment && run.status === 'cancelled') return ['start-new']
  // A restart, not a fault of the run: reconcile and continue, or give it up.
  if (!active && ownerLossRecoverable(run)) return ['recover', 'abandon']
  // Partial or unauthorised changes: inspect them and record a disposition.
  if (!active && run.integrity?.status === 'quarantined' && !run.journal?.recoveryRequired && run.workspace?.path && run.workspace.state !== 'removed') return ['resolve-integrity', 'abandon']
  if (!LIVE_STATUSES.includes(run.status) && Object.values(run.participants ?? {}).some(p => p.pendingInvocation || p.state === 'recovery-required')) return active ? ['stop'] : ['abandon']
  if (run.journal?.recoveryRequired) return active ? ['stop'] : ['abandon']
  if (run.integrity?.status === 'quarantined') return active ? ['stop'] : ['abandon']
  // Preflight spends money before the first turn. Stopping it has to be offered,
  // or the only way out of a slow probe is to wait for it to finish paying.
  if (run.status === 'preflighting' || run.status === 'pending') {
    return active ? (run.pauseRequested ? ['stop'] : ['pause', 'stop']) : []
  }
  if (run.status === 'running') return run.pauseRequested ? ['stop'] : ['pause', 'stop']
  if (run.status === 'stopping') return []
  // Manual pauses resume directly; policy questions still require an answer.
  if (run.status === 'paused') return ['manual', 'full-verification'].includes(run.pause?.kind) ? (resumeUnavailable(run) ? ['abandon'] : ['resume', 'abandon']) : ['answer', 'abandon']
  // Stopped only by failed checks on an approved revision: rerunning them is the remedy, beside resume.
  const refreshable = !refreshChecksUnavailable(run, refresh)
  const acceptable = !acceptCheckUnavailable(run, refresh)
  if (!resumeUnavailable(run)) return [...(refreshable ? ['refresh-checks'] : []), ...(acceptable ? ['accept-check-result'] : []), 'resume', 'start-new']
  if (run.status === 'blocked') {
    // Other blockers retain their specific recovery and finalization controls.
    if (run.blockedReason === 'recovery-required' || run.recovery?.required) return ['abandon']
    // Stopped at the hand-off with the approved candidate still on disk: the
    // reviews stand, so closure may be evaluated again once the cause is fixed.
    const continuable = !continueUnavailable(run)
    if (continuable || refreshable || acceptable) return [...(continuable ? ['continue'] : []), ...(refreshable ? ['refresh-checks'] : []), ...(acceptable ? ['accept-check-result'] : []), 'start-new']
    const finalizable = FINALIZABLE_BLOCKS.includes(run.blockedReason) && run.workspace?.path && run.workspace.state !== 'removed' && run.integrity?.status !== 'quarantined'
    // Refused for drift on the approved patch's own paths: merging it onto the source is the remedy.
    if (finalizable && !reconcileUnavailable(run)) return ['reconcile-delivery', 'finalize', 'start-new']
    return finalizable ? ['finalize', 'start-new'] : ['start-new']
  }
  if (!retryInputUnavailable(run)) return ['retry-input', 'start-new']
  if (['completed', 'cancelled', 'failed'].includes(run.status)) {
    // A committed, verified, not-yet-integrated candidate may be integrated.
    return integrateUnavailable(run) ? ['start-new'] : ['start-new', 'integrate']
  }
  return active ? ['stop'] : []
}
