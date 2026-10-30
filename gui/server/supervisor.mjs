import { checksOnlyBlock, continueUnavailable, resumeUnavailable, ownerLossRecoverable } from './runtime/run-control.mjs'
import { writeRunResultStep } from './run-result-step.mjs'
import { launchPreconditions } from './launch-preconditions.mjs'
import { projectInfrastructure, stagingTarget } from './infrastructure.mjs'
import { projectPath as projectDir, projectsRoot, resolveProjectPath } from './project-path.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { preflight, assertLaunchable } from './config/preflight.mjs'
import {
  abandonReservation,
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
import { LockHeld, ownerLiveness, withLock } from './runtime/lock.mjs'
import { hostPlatform } from './runtime/platform.mjs'
import { terminatePids } from './runtime/process.mjs'
import { openCleanup, noteLostTags, proveEntries, cleanupRefusal, readBarrier, liftBarrierEntries, syncBarrier, unrecordedCleanup, unrecordedRefusal } from './runtime/cleanup-barrier.mjs'
import { createProbeExecutor } from './runtime/probe-budget.mjs'
import { reconcileIntegration } from './runtime/integrate.mjs'
import * as store from './runtime/store.mjs'
import { readChat, coordinatorRole, instructionRefusal, chatView, recordInstruction, askCoordinator } from './runtime/coordinator-chat.mjs'
import { captureIntegrity, integrityChanges, readIntegrity } from './runtime/integrity.mjs'
import { createAvailabilityStore } from './runtime/failure.mjs'
import { inspectSourceRepository, repositoryFaultError, usesSourceRepository } from './runtime/source-repository.mjs'
import { createQuotaFallback } from './runtime/model-fallback.mjs'
import { resolvePlaybook, loadConfig } from './config/load.mjs'
import { OVERRIDE_REASON_MAX, PregateHold } from './decisions/pregate.mjs'
import { inquiryState, inquiryPackable, inquiryClosed } from './inquiry.mjs'

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

export function createSupervisor ({
  issues,
  emit = null,
  harnessDir = HARNESS_DIR,
  projectsDir = PROJECTS_DIR,
  maxProbeInvocations = MAX_PROBE_INVOCATIONS,
  shutdownGraceMs = SHUTDOWN_GRACE_MS,
  configRoot = process.env.DEVPANEL_CONFIG_ROOT,
  // Advisory decisions (docs/decisions.md), both absent unless the server wires
  // them: the Triage pre-gate (decisions/pregate.mjs) and the reclassifier of
  // `runtime` failures (decisions/failure-advisor.mjs).
  pregate = null,
  failureAdvisor = null,
  // Host-wide memory of exhausted models, beside the issues. One file for every
  // project: a quota burnt by one run is a quota burnt for all of them.
  availabilityFile = path.join(issues.ISSUES_DIR ?? process.env.DEVPANEL_ISSUES_DIR ?? '.', '.availability.json'),
  // The host's OS probes (platform.mjs): lock liveness and the cleanup proof.
  platform = hostPlatform()
} = {}) {
  const availability = createAvailabilityStore(availabilityFile)
  /** Runs this process is driving, keyed by issue. At most one per issue. */
  const active = new Map()
  /** Reservations in flight, so a double-click cannot become two runs. */
  const starting = new Set()
  let shuttingDown = false

  const key = (project, issueId) => `${project}/${issueId}`

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
   */
  // The project is validated BEFORE the lock path is built from it: the lock
  // creates its directory, and a name such as `..` would put it outside issues/.
  const admission = async (project, fn) => {
    if (!issues.ISSUES_DIR) return fn()
    await issues.requireProject(project)
    return withLock(path.join(issues.ISSUES_DIR, project, '.admission.lock'), { purpose: 'admission', waitMs: 60000 }, fn)
  }

  /** A closed inquiry is terminal until reopened; an inquiry runs only as one. */
  function inquiryAdmission (issue, { playbookId = null, runOptions = null } = {}) {
    if (inquiryClosed(issue)) throw err(409, `inquiry ${issue.id} is closed (${issue.inquiry.closure.action} of run ${issue.inquiry.closure.runId}); reopen it before starting or continuing a run`)
    if (playbookId === null) return
    if (issue.kind === 'inquiry' && (playbookId !== 'analysis' || runOptions?.inquiry !== true)) throw err(409, 'an inquiry runs only the analysis playbook as an inquiry (preview it through inquire)')
    if (issue.kind !== 'inquiry' && runOptions?.inquiry === true) throw err(409, 'only an inquiry runs as an inquiry')
  }

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
      if (['shared', 'fence', 'mcp-devpanel'].includes(id)) continue   // helpers and the broker's MCP shim, not runtimes
      // The cache-buster reloads the adapter file only: what it imports
      // (shared.mjs, gui/server/runtime/*) stays the copy this process loaded at
      // start. An adapter updated on disk that needs a newer export from those
      // therefore fails to import until the service restarts; the reason is kept
      // so the probe can name it instead of reporting a missing adapter.
      try { adapters[id] = await import(`${path.join(harnessDir, file)}?t=${Date.now()}`) } catch (error) { adapters[HARNESS_LOAD_FAILURES][id] = error }
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
  async function start ({ project, issueId, playbookId, expectConfigHash = null, runOptions = {}, configRoot: root = configRoot, supervisorLaunchId = null, pregateOverride = null }) {
    if (shuttingDown) throw Object.assign(err(503, 'the server is shutting down'), { started: false, retryable: true })
    const k = key(project, issueId)

    // Two guards, because they fail differently: this one catches a double-click
    // in one process, the run lock catches a second process.
    if (starting.has(k)) throw err(409, 'a run is already being started for this issue')
    if (active.has(k)) throw err(409, 'a run is already active for this issue', { runId: active.get(k).runId })
    // Reserve synchronously, before any I/O, so different issues in one project
    // cannot race each other through preflight. All panel and supervisor starts
    // share this guard; stopping still owns its slot until drive settles.
    const holder = [...active.values()].find((run) => run.project === project)?.issueId ??
      [...starting].find((id) => id.startsWith(`${project}/`))?.slice(project.length + 1) ?? null
    if (holder) {
      throw err(409, `a run is already active on this project (issue ${holder}); wait for it to finish`, { issueId: holder })
    }
    starting.add(k)

    let reservation
    let harnesses
    let projectPath
    let pregateRecord = null
    try { await admission(project, async () => {
      // The synchronous guard above covers this process. A run driven by
      // ANOTHER process shows only in persisted state: a live run on any other
      // issue of this project whose lock owner is still alive blocks too. Two
      // candidates cut from one base commit are two patches that conflict at
      // integration, and nothing reviews that.
      const busy = await projectBusy(project, issueId)
      if (busy) throw err(409, `a run is already active on this project (issue ${busy.issueId}); wait for it to finish`, { runId: busy.runId, issueId: busy.issueId })

      const issue = await issues.getIssue(project, issueId)
      if (issue.packed) throw err(409, 'This issue is archived. Restore it before starting or continuing a run.')
      inquiryAdmission(issue, { playbookId, runOptions })
      projectPath = await resolveProjectPath(project, { projectsDir })
      harnesses = await loadHarnesses()
      // A model this host has seen exhausted is not started again before its
      // recorded reset. Checked before anything is reserved, so a refused start
      // leaves no failed run behind.
      const resolution = await resolvePlaybook(playbookId, { root, runOptions, projectId: project })
      if (resolution.ok) {
        for (const [role, participant] of Object.entries(resolution.resolved.participants)) {
          const cooling = await availability.check(participant.model.id)
          if (cooling) throw err(409, `model ${participant.model.id} (${role}) is exhausted until ${cooling.exhaustedUntil}${cooling.assumed ? ' (assumed hold)' : ''}: ${cooling.reason}${cooling.runId ? ` (observed in run ${cooling.runId})` : ''}. Wait, choose another model, or clear the record.`, { availability: cooling })
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
        const blocked = await launchPreconditions({ projectPath, workspace: resolution.resolved.workspace ?? {}, configHash: resolution.resolved.configHash })
        if (blocked) throw Object.assign(err(422, blocked.message, { code: blocked.code }), { started: false, retryable: false, class: 'environment' })
      }
      // The Triage pre-gate: asked before anything is reserved, so a hold leaves
      // no run behind. Only an operator may start past a hold, and only with a
      // reason; the start then goes ahead and the override is kept with the run.
      if (pregate && resolution.ok && resolution.resolved.tactic === 'triage') {
        if (pregateOverride != null) {
          const reason = typeof pregateOverride.reason === 'string' ? pregateOverride.reason.trim() : ''
          if (!reason || reason.length > OVERRIDE_REASON_MAX) throw err(400, `starting past the pre-gate needs a reason of 1-${OVERRIDE_REASON_MAX} characters`)
          if (pregateOverride.by !== 'operator') throw err(403, 'only an operator can start past the pre-gate')
          pregateOverride = { by: 'operator', reason, at: new Date().toISOString() }
        }
        try {
          pregateRecord = await pregate.check({ project, issueId })
        } catch (error) {
          if (!(error instanceof PregateHold) || !pregateOverride) throw error
          pregateRecord = error.record
          pregateOverride.held = { gate: error.pregate.gate, confidence: error.pregate.confidence }
        }
      }
      reservation = await reserveRun({
        playbookId,
        supervisorLaunchId,
        // Name, folder and date travel with the run. Prompts render them, and a
        // coordinator told to read an issue folder needs the folder to be there.
        issue: { project, id: issueId, name: issue.name ?? null, openedOn: issue.openedOn ?? null, path: issue.path },
        issuePath: issue.path,
        configRoot: root,
        expectConfigHash,
        runOptions,
        unrecordedBarrier: await unrecordedBarrier(path.dirname(issue.path))
      })
    }) } catch (error) {
      starting.delete(k)
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
      finished: null
    }
    active.set(k, record)
    starting.delete(k)
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

    return { runId: record.runId, status: 'preflighting' }
  }

  /**
   * Is another issue of this project being driven by some other process? From
   * persisted live runs whose lock owner is alive. A run persisted as live with
   * a dead owner is recovery work, not a running run, and does not block.
   */
  async function projectBusy (project, exceptIssueId) {
    let list = []
    try { list = await issues.listIssues(project) } catch { return null }
    for (const issue of list) {
      if (issue.id === exceptIssueId) continue
      const latest = issue.latestRun
      if (!latest?.live) continue
      const owner = await lockOwner(issue.path, latest.runId)
      if (owner.forThisRun && held(owner)) return { runId: latest.runId, issueId: issue.id }
    }
    return null
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
      await recordPreflight(reservation, {
        state, result, usage: probe.spent, detail: refusal?.message ?? null, depth: 'model'
      })
      emit?.({
        type: 'preflight', project, issueId, runId: record.runId, state, attempts: probe.spent.invocations
      })

      if (state !== 'passed') {
        const stopped = state === 'cancelled' || record.controller.signal.aborted
        record.refusal = refusal
        await abandonReservation(reservation, {
          status: stopped ? 'cancelled' : 'failed',
          blockedReason: stopped ? null : 'preflight-refused'
        })
        return
      }

      if (record.controller.signal.aborted) {
        await abandonReservation(reservation, { status: 'cancelled' })
        return
      }

      // ---- provisioning ----
      const engine = await provisionRun(reservation, {
        projectPath, projectAlias,
        harnesses,
        stepStore: { create: (options) => issues.createStep(project, issueId, options) },
        workspaceProvider: gitWorktreeProvider,
        deliveryProvider: worktreeDiffDelivery,
        configRoot: root,
        availability,
        emit: (event) => emit?.({ ...event, project, issueId, runId: record.runId })
      })

      await driveEngine(record, engine)
    } catch (error) {
      await failRecord(record, error)
    } finally {
      await settleWorkspace(record)
      active.delete(k)
      await announceEnd(project, issueId, record.runId)
    }
  }

  /** The agent phase proper, shared by a fresh start and a resume after a decision. */
  async function driveEngine (record, engine) {
    if (failureAdvisor) engine.failureAdvisor = failureAdvisor
    engine.quotaFallback = createQuotaFallback({ loadModels: async () => [...(await loadConfig({ root: configRoot })).roster.values()], availability, probeFor, root: configRoot })
    record.engine = engine
    record.phase = 'run'
    // A stop that arrived during preflight still applies: the engine inherits it.
    if (record.stopping || record.controller.signal.aborted) {
      engine.cancel('requested')
      // No invocation has begun. drive() refuses an already-aborted controller,
      // so settle here instead of leaving a permanent "stopping" record.
      engine.run.status = 'cancelled'
      engine.run.outcome = 'unresolved'
      engine.run.endedAt = engine.clock.iso()
      await engine.persist({ type: 'cancelled', between: 'provisioning-and-drive' })
      return
    }
    if (record.pauseRequested && !engine.run.pauseRequested) await engine.requestPause()
    await engine.drive()
  }

  /**
   * Answer the question a paused run asked, and drive it on.
   *
   * The answer is recorded by the engine as an operator step before anything
   * resumes, so a crash right after leaves the decision on disk. The same
   * one-live-run-per-project rule applies as for a start.
   */
  async function answer ({ project, issueId, runId, text, actor, pauseId, retryInput = false, refreshChecks = false, resume = false, recover = false, integrity = null, budgets = {}, continueRun = false }) {
    if (shuttingDown) throw Object.assign(err(503, 'the server is shutting down'), { started: false, retryable: true })
    const k = key(project, issueId)
    if (starting.has(k) || active.has(k)) throw err(409, 'a run is already active for this issue')
    const holder = [...active.values()].find((run) => run.project === project)?.issueId ??
      [...starting].find((id) => id.startsWith(`${project}/`))?.slice(project.length + 1) ?? null
    if (holder) throw err(409, `a run is already active on this project (issue ${holder}); wait for it to finish`, { issueId: holder })
    starting.add(k)
    let engine = null
    try {
      let issue
      await admission(project, async () => {
        const busy = await projectBusy(project, issueId)
        if (busy) throw err(409, `a run is already active on this project (issue ${busy.issueId}); wait for it to finish`, { runId: busy.runId, issueId: busy.issueId })
        issue = await issues.getIssue(project, issueId)
        if (issue.packed) throw err(409, 'This issue is archived. Restore it before starting or continuing a run.')
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
      })
      if (integrity) {
        // Pinned to the state the operator inspected; the engine refuses a
        // disposition for a workspace that changed since, or one that is not
        // allowed for what the quarantined turn did.
        try {
          await engine.resolveIntegrity({ disposition: integrity.disposition, expectedStateHash: integrity.expectedStateHash, reason: integrity.reason, actor: actor ?? 'operator' })
        } catch (error) { throw err(409, error.message) }
        if (integrity.disposition === 'abandon') {
          await engine.runLock?.release().catch(() => {})
          starting.delete(k)
          await announceEnd(project, issueId, runId)
          return { runId, status: engine.run.status, integrity: engine.run.integrity.status }
        }
      }
      if (!resume && !recover && !integrity && !retryInput && !refreshChecks && !continueRun && engine.run.status !== 'paused') throw err(409, 'this run is not waiting for a decision')
      if (recover) {
        const outcome = await engine.recoverOwnerLoss({ budgets })
        if (!outcome.resumed) {
          // Reconciliation is recorded; what is left needs a person.
          await engine.runLock?.release().catch(() => {})
          starting.delete(k)
          emit?.({ type: 'run-recovery-required', project, issueId, runId })
          return { runId, status: engine.run.status, recovered: false, reason: outcome.reason }
        }
      }
      const decision = integrity ? { integrity: integrity.disposition } : recover ? { recovered: true } : resume ? await engine.resumeExecution({ budgets, unrecordedBarrier: await unrecordedBarrier(path.dirname(issue.path)) }) : continueRun ? await engine.continueRun({ text, actor, budgets }) : refreshChecks ? await engine.refreshClosureChecks(stagingTarget(await projectInfrastructure(project, { root: configRoot }))) : retryInput ? await engine.retryInputFailure() : await engine.answer({ text, actor, pauseId })
      // The worktree was handed back when the run paused; it is ours again.
      if (engine.run.workspace?.state === 'retained') {
        engine.run.workspace.state = 'active'
        engine.run.workspace.retainedReason = null
        await store.writeRun(engine.issuePath, engine.runId, engine.run)
      }
      const record = { runId, issuePath: issue.path, project, issueId, phase: 'run', engine, reservation: null, controller: new AbortController(), stopping: false, finished: null }
      active.set(k, record)
      starting.delete(k)
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
      if (engine && !active.has(k)) await engine.runLock?.release().catch(() => {})
      throw translate(error)
    }
  }

  /**
   * What a quarantined run's workspace holds now, against the state the turn
   * received: the evidence a disposition is pinned to. Read-only; takes no lock.
   */
  async function inspectIntegrity ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const issue = await issues.getIssue(project, issueId)
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
  async function announceEnd (project, issueId, runId, type = 'run-finished') {
    let inquiry = false
    try {
      const issue = await issues.getIssue(project, issueId)
      inquiry = issue.kind === 'inquiry'
      await writeRunResultStep({ issuePath: issue.path, runId })
    } catch (error) {
      console.warn(`[devpanel] could not write the result of ${project}/${issueId} run ${runId}: ${error.message}`)
    }
    emit?.({ type, project, issueId, runId })
    // An answered inquiry (row 4) packs itself once its run is settled; every
    // other ending waits for a close or an acknowledgement.
    if (inquiry) {
      await admission(project, () => packInquiryLocked(project, issueId))
        .then((r) => { if (r.packed) emit?.({ type: 'inquiry-packed', project, issueId, runId }) })
        .catch((error) => console.warn(`[devpanel] inquiry ${project}/${issueId} was not packed: ${error.message}`))
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
    await issues.setIssueArchived(project, issueId, true, { overrideReason: `inquiry ${f.state.state}${f.issue.inquiry?.closure ? ` (${f.issue.inquiry.closure.action})` : ''}` })
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
        await issues.setIssueArchived(project, inquiryId, false)
        issue = await issues.getIssue(project, inquiryId)
      } else if (issue.archived) await issues.setIssueArchived(project, inquiryId, false)
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
    const issue = await issues.getIssue(project, issueId).catch((error) => { if (error.status === 404) return null; throw error })
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
      const tags = !run ? [] : await withLock(path.join(issuePath, '.run.lock'), { purpose: 'cleanup-acknowledgement', takeOverDead: false }, async () => {
        current = await store.readRun(issuePath, runId)
        const open = openCleanup(current)
        for (const entry of open) Object.assign(entry, { acknowledgedAt: at, acknowledgement })
        if (open.length) {
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
      return withLock(path.join(issuePath, '.run.lock'), { purpose: 'cleanup-proof', takeOverDead: false }, async () => {
        const current = await store.readRun(issuePath, runId)
        const open = openCleanup(current)
        let outcome
        try { outcome = await settle(open) } finally { await store.writeRun(issuePath, runId, current) }
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

  async function settleWorkspace (record) {
    const { engine, reservation } = record

    // Never provisioned: there is no workspace, only the lock, which
    // abandonReservation has already released.
    if (!engine) {
      await reservation.runLock.release().catch(() => {})
      return
    }

    const run = engine.run
    // A barrier write that failed during a turn leaves the entry on the run
    // only: held here until the file takes it.
    await keepOnBarrier(path.dirname(engine.issuePath), run)

    try {
      const verdict = await workspaceUnchanged(engine).catch((error) => ({
        unchanged: false, proven: false, reason: `the comparison itself failed: ${error.message}`
      }))
      const disposition = workspaceDisposition(run, verdict)
      if (disposition.discard) await discardWorkspace(engine)
      else await releaseOwnership(engine, { reason: `${run.status}: ${disposition.reason}` })
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

    if (!record.stopping) {
      record.stopping = true
      const target = record.engine ?? record.reservation
      target.run.status = 'stopping'
      await store.writeRun(record.issuePath, runId, target.run)
      emit?.({ type: 'stopping', project, issueId, runId, phase: record.phase })
      record.controller.abort()
      record.engine?.cancel('requested')
    }

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
   * A stop for a run this process is not driving.
   *
   * "Not in memory" is not the same as "already stopped". A run persisted as live
   * is either owned by another process — which this one cannot stop — or owned by
   * nobody, in which case what happened to its last invocation is unknown and the
   * honest answer is recovery, not a clean cancellation.
   */
  async function stopUnowned ({ project, issueId, runId }) {
    const issue = await issues.getIssue(project, issueId)
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

    const foreignLive = held(owner) && !owner.mine
    const reconciled = await markUnowned(issue.path, run, owner, { releaseLock: !foreignLive })
    return {
      runId,
      status: reconciled.status,
      blockedReason: reconciled.blockedReason,
      recoveryRequired: true
    }
  }

  /**
   * Evaluate closure again for a run that stopped at delivery. Same exclusivity
   * as a start or an answer: one live run per project, ownership taken through
   * the lock, the worktree settled afterwards by the same rules as any finish.
   * `reconcile` first merges the approved patch onto the drifted source under
   * the project's current `workspace.reconcile` policy (engine.reconcileDelivery).
   */
  async function finalize ({ project, issueId, runId, reconcile = false, actor = 'operator' }) {
    const action = reconcile ? 'reconcile-delivery' : 'finalize'
    if (shuttingDown) throw Object.assign(err(503, 'the server is shutting down'), { started: false, retryable: true })
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const k = key(project, issueId)
    if (starting.has(k) || active.has(k)) throw err(409, 'a run is already active for this issue')
    const holder = [...active.values()].find((run) => run.project === project)?.issueId ??
      [...starting].find((id) => id.startsWith(`${project}/`))?.slice(project.length + 1) ?? null
    if (holder) throw err(409, `a run is already active on this project (issue ${holder}); wait for it to finish`, { issueId: holder })
    starting.add(k)
    let engine = null
    try {
      let issue
      await admission(project, async () => {
        const busy = await projectBusy(project, issueId)
        if (busy) throw err(409, `a run is already active on this project (issue ${busy.issueId}); wait for it to finish`, { runId: busy.runId, issueId: busy.issueId })
        issue = await issues.getIssue(project, issueId)
        if (issue.packed) throw err(409, 'This issue is archived. Restore it before starting or continuing a run.')
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
      })
      if (!supportedActions(engine.run).includes(action)) throw err(409, reconcile ? `This run cannot be reconciled: ${reconcileUnavailable(engine.run) ?? 'it is not waiting at delivery'}.` : 'This run is not waiting at delivery; there is nothing to finalize.')
      // The policy is the project's as configured now, like a check refresh's target; it is recorded on the attempt.
      const policy = reconcile ? (await loadConfig({ root: configRoot })).projects.get(project)?.workspace?.reconcile ?? {} : null
      if (engine.run.workspace?.state === 'retained') {
        engine.run.workspace.state = 'active'
        engine.run.workspace.retainedReason = null
        await store.writeRun(engine.issuePath, engine.runId, engine.run)
      }
      const record = { runId, issuePath: issue.path, project, issueId, phase: action, engine, reservation: null, controller: new AbortController(), stopping: false, finished: null }
      active.set(k, record)
      starting.delete(k)
      emit?.({ type: reconcile ? 'run-reconciling' : 'run-finalizing', project, issueId, runId })
      try {
        if (reconcile) await engine.reconcileDelivery({ policy, actor })
        else await engine.finalize()
      } catch (error) {
        await failRecord(record, error)
      } finally {
        await settleWorkspace(record)
        active.delete(k)
        await announceEnd(project, issueId, runId)
      }
      return { runId, status: engine.run.status, outcome: engine.run.outcome, blockedReason: engine.run.blockedReason,
        ...(reconcile ? { reconciliation: engine.run.reconciliations?.at(-1) ?? null } : {}) }
    } catch (error) {
      starting.delete(k)
      if (engine && !active.has(k)) await engine.runLock?.release().catch(() => {})
      throw translate(error)
    }
  }

  async function abandon ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const issue = await issues.getIssue(project, issueId)
    if (active.has(key(project, issueId))) throw err(409, 'Stop the active run and wait for it to finish before abandoning.')
    try {
      return await withLock(path.join(issue.path, '.run.lock'), { purpose: 'run-abandon', takeOverDead: false }, async () => {
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
        run.blockedReason = null
        run.recovery = { required: false, resolution: 'abandoned', resolvedAt: at }
        for (const participant of Object.values(run.participants ?? {})) {
          participant.pendingInvocation = null
          participant.state = 'abandoned'
        }
        if (run.workspace && run.workspace.state !== 'removed') {
          run.workspace.state = 'retained'
          run.workspace.retainedReason = 'Operator abandoned interrupted work; outcomes remain unverified.'
        }
        await store.writeRun(issue.path, runId, run)
        await announceEnd(project, issueId, runId, 'run-abandoned')
        return run
      })
    } catch (error) {
      if (error.code === 'ENOENT') throw err(404, 'No such run')
      if (error instanceof LockHeld) throw err(409, 'Execution still owns this issue, or ownership cannot be verified. Abandonment refused.')
      throw error
    }
  }

  /**
   * Delete a settled run: its workspace, its record under runs/<id>/ and its
   * step folders in the issue (turns, operator answers, the result entry).
   * Irreversible, and on the operator's click alone: the panel asks nothing, as
   * the trash icon promises. What stays: the step reservations, so a number is
   * never handed out twice and provenance holds; the spending ledger, which is
   * accounting; refs/devpanel/* in the source repository, which pin nothing
   * reviewable once the run is gone. A live or paused run is refused — stop or
   * abandon it first — and the issue lock is taken so no start races the delete.
   */
  async function deleteRun ({ project, issueId, runId }) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const issue = await issues.getIssue(project, issueId)
    if (issue.packed || issue.archived) throw err(409, 'This issue is archived. Restore it before deleting a run.')
    if (active.has(key(project, issueId)) || starting.has(key(project, issueId))) throw err(409, 'A run is active on this issue; wait for it to settle.')
    try {
      return await withLock(path.join(issue.path, '.run.lock'), { purpose: 'run-delete', takeOverDead: false }, async () => {
        const run = await store.readRun(issue.path, runId)
        if (LIVE_STATUSES.includes(run.status) || run.status === 'paused') throw err(409, `The run is ${run.status}. Stop or abandon it before deleting.`)
        // Its record may be the only durable copy of an unproved cleanup (the barrier file refused it).
        if ((await unrecordedCleanup(path.dirname(issue.path), run)).length) throw err(409, unrecordedRefusal(run, 'deleting the run'), { code: 'CLEANUP_UNRECORDED' })
        await removeRunWorkspace(run, await resolveProjectPath(project, { projectsDir }).catch(() => null))
        let reservations = []
        try { reservations = JSON.parse(await fs.readFile(path.join(issue.path, '.step-reservations.json'), 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
        const folders = new Set((run.steps ?? []).map((s) => `${s.number}-${s.slug}`))
        for (const r of reservations) if (r.invocationId === `run-result:${runId}`) folders.add(r.folder)
        // Only folders named like steps, directly in the issue: nothing outside it can be named here.
        for (const folder of folders) if (/^\d{3}-[a-z0-9-]+$/.test(folder)) await fs.rm(path.join(issue.path, folder), { recursive: true, force: true })
        await fs.rm(store.runDir(issue.path, runId), { recursive: true, force: true })
        return { runId, deleted: true, steps: [...folders].sort() }
      })
    } catch (error) {
      if (error.code === 'ENOENT') throw err(404, 'No such run')
      if (error instanceof LockHeld) throw err(409, 'Execution still owns this issue, or ownership cannot be verified. Run not deleted.')
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
      if (error instanceof LockHeld) throw err(409, 'Execution still owns this issue, or ownership cannot be verified. Landing not recorded.')
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
  async function markUnowned (issuePath, run, owner, { releaseLock = true } = {}) {
    const wasStopping = run.status === 'stopping'
    const detail = owner.liveness === 'absent'
      ? 'no lock was held for it when this server took over'
      : `the process that owned it (pid ${owner.record?.owner?.pid}) is gone`

    run.status = 'blocked'
    run.outcome = 'unresolved'
    run.blockedReason = 'recovery-required'
    // When the owner was last seen doing something: the time from then until a
    // recovery is time nobody owned the run, not time the run spent.
    const events = await store.readEvents(issuePath, run.runId).catch(() => null)
    run.recovery = {
      required: true,
      ownerLost: true,
      reason: `the run was ${wasStopping ? 'stopping' : 'live'} when its owner disappeared — ${detail}`,
      detectedAt: new Date().toISOString(),
      lastActivityAt: events?.events?.at(-1)?.at ?? null
    }
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

    // A dead owner's lock must not keep the issue hostage — but only the lock
    // that belonged to THIS run, and only if nothing living is behind it.
    if (releaseLock) {
      await fs.rm(path.join(issuePath, '.run.lock'), { force: true }).catch(() => {})
    }
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
    let projects = []
    try {
      projects = await issues.listProjects()
    } catch {
      return recovered
    }

    for (const project of projects) {
      const projectId = project.id ?? project.name ?? project
      // Active issues only. That is safe *because* archiving refuses an issue
      // holding a live or recovery-required run — the two rules depend on each
      // other, so loosening either one without the other leaves a run persisted
      // as live that nothing will ever reconcile.
      let list = []
      try { list = await issues.listIssues(projectId) } catch { continue }

      for (const issue of list) {
        let names = []
        try {
          names = (await fs.readdir(store.runsDir(issue.path), { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
            .map((e) => e.name)
        } catch { continue }

        for (const runId of names) {
          const run = await store.readRun(issue.path, runId).catch(() => null)
          if (!run) continue
          // A publication the previous process did not finish: settle it from
          // its record before anything else is offered on the run.
          if (['publishing', 'published'].includes(run.integration?.phase)) {
            const settled = await reconcileIntegration({ issuePath: issue.path, runId }).catch((error) => ({ error: error.message }))
            emit?.({ type: 'integration-reconciled', project: projectId, issueId: issue.id, runId, phase: settled.phase ?? null, error: settled.error ?? null })
          }
          // The barrier as the run records say: open entries a failed write
          // left off it are put back (or held here), settled ones lifted.
          await keepOnBarrier(path.dirname(issue.path), run)
          if (!LIVE_STATUSES.includes(run.status)) continue

          const owner = await lockOwner(issue.path, runId)
          const foreignLive = held(owner) && !owner.mine

          // Live and holding the lock FOR THIS RUN: it genuinely belongs to
          // someone else, so leave it entirely alone.
          if (owner.forThisRun && foreignLive) continue

          await markUnowned(issue.path, run, owner, { releaseLock: !foreignLive })
          recovered.push({ project: projectId, issueId: issue.id, runId })
          emit?.({ type: 'run-recovery-required', project: projectId, issueId: issue.id, runId })
        }
      }
    }
    return recovered
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

      for (const issue of list) {
        let names = []
        try {
          names = (await fs.readdir(store.runsDir(issue.path), { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !e.name.startsWith('worktree-') && !e.name.startsWith('workspace-'))
            .map((e) => e.name)
        } catch { continue }

        for (const runId of names) {
          const run = await store.readRun(issue.path, runId).catch(() => null)
          if (!run) continue
          // A publication the previous process did not finish: settle it from
          // its record before anything else is offered on the run.
          if (['publishing', 'published'].includes(run.integration?.phase)) {
            const settled = await reconcileIntegration({ issuePath: issue.path, runId }).catch((error) => ({ error: error.message }))
            emit?.({ type: 'integration-reconciled', project: projectId, issueId: issue.id, runId, phase: settled.phase ?? null, error: settled.error ?? null })
          }
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

    await Promise.allSettled(records.map((r) =>
      stop({ project: r.project, issueId: r.issueId, runId: r.runId })))

    // Whatever does not settle in time is left for the next start-up to
    // reconcile — as recovery-required, which is what it genuinely is.
    const settled = await Promise.race([
      Promise.allSettled(records.map((r) => r.finished)).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs))
    ])

    return { stopped: records.length, settled }
  }

  const isActive = (project, issueId) => active.has(key(project, issueId))

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
  const asking = new Map() // `${project}/${issueId}/${runId}` -> Set of question ids in flight

  /** The live engine when the run is driven here, else a lock-free read of it. */
  async function chatEngine (project, issueId, runId) {
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw err(400, 'Invalid run id')
    const live = active.get(key(project, issueId))
    if (live?.runId === runId && live.engine) return live.engine
    const issue = await issues.getIssue(project, issueId)
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
      asking: [...(asking.get(`${project}/${issueId}/${runId}`) ?? [])],
      entries: chatView(entries, engine.run.steps ?? [], { asking: asking.get(`${project}/${issueId}/${runId}`) ?? new Set() })
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
    const inFlight = asking.get(k) ?? new Set()
    asking.set(k, inFlight)
    let recorded
    const ready = new Promise((resolve) => { recorded = resolve })
    const done = askCoordinator(engine, {
      text, actor, harnesses,
      emit: (event) => emit?.({ ...event, project, issueId, runId }),
      onAsking: (id) => { inFlight.add(id); recorded(id) }
    }).finally(() => { inFlight.clear(); asking.delete(k) })
    // Validation and "no session yet" fail before anything is recorded.
    const first = await Promise.race([ready, done.then(() => null)])
    if (first === null) await done
    done.catch((error) => console.error('coordinator question failed', error))
    return { questionId: first, state: 'asking' }
  }

  return { chatHistory, acknowledgeCleanup, proveCleanup, instructCoordinator, askCoordinator: askCoordinatorQuestion, inquiryStatus, closeInquiry, reopenInquiry, packInquiry, start, answer, pause: pauseRun, resume: args => answer({ ...args, resume: true }), recover: args => answer({ ...args, recover: true }), resolveIntegrity: ({ disposition, expectedStateHash, reason, ...args }) => answer({ ...args, integrity: { disposition, expectedStateHash, reason } }), inspectIntegrity, retryInput: args => answer({ ...args, retryInput: true }), refreshChecks: args => answer({ ...args, refreshChecks: true }), continueRun: args => answer({ ...args, continueRun: true }), finalize, reconcileDelivery: args => finalize({ ...args, reconcile: true }), stop, abandon, deleteRun, markLanded, isActive, settle, reconcile, shutdown, liveAgents, active, availability, deliveryActions: worktreeDiffDelivery.actions }
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
  if (error instanceof LockHeld) return err(409, 'another run already holds this issue')
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
export function supportedActions (run, { active = false } = {}) {
  const base = baseActions(run, { active })
  const open = openCleanup(run)
  if (!open.length || active || LIVE_STATUSES.includes(run.status)) return base
  return [...(open.some((e) => e.structural) || !hostPlatform().descendantScan?.proved ? [] : ['prove-cleanup']), 'acknowledge-cleanup', ...base]
}

function baseActions (run, { active = false } = {}) {
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
  if (run.status === 'paused') return run.pause?.kind === 'manual' ? (resumeUnavailable(run) ? ['abandon'] : ['resume', 'abandon']) : ['answer', 'abandon']
  // Stopped only by failed checks on an approved revision: rerunning them is the remedy, beside resume.
  const refreshable = checksOnlyBlock(run) && run.integrity?.status === 'clear' && !run.release && run.workspace?.state !== 'removed'
  if (!resumeUnavailable(run)) return refreshable ? ['refresh-checks', 'resume', 'start-new'] : ['resume', 'start-new']
  if (run.status === 'blocked') {
    // Other blockers retain their specific recovery and finalization controls.
    if (run.blockedReason === 'recovery-required' || run.recovery?.required) return ['abandon']
    // Stopped at the hand-off with the approved candidate still on disk: the
    // reviews stand, so closure may be evaluated again once the cause is fixed.
    if ((['closure-conditions-unmet', 'refreshed-checks-failed'].includes(run.blockedReason) || refreshable) && run.integrity?.status === 'clear' && !run.release && run.workspace?.state !== 'removed') return continueUnavailable(run) ? ['refresh-checks', 'start-new'] : ['continue', 'refresh-checks', 'start-new']
    if (run.blockedReason === 'checks-failed-unchanged' && !continueUnavailable(run)) return ['continue', 'start-new']
    const finalizable = FINALIZABLE_BLOCKS.includes(run.blockedReason) && run.workspace?.path && run.workspace.state !== 'removed' && run.integrity?.status !== 'quarantined'
    // Refused for drift on the approved patch's own paths: merging it onto the source is the remedy.
    if (finalizable && !reconcileUnavailable(run)) return ['reconcile-delivery', 'finalize', 'start-new']
    return finalizable ? ['finalize', 'start-new'] : ['start-new']
  }
  if (run.status === 'failed' && /input_too_large|Input exceeds the maximum length/i.test(run.failures?.at(-1)?.evidence ?? '') && run.integrity?.status === 'clear' && !run.recovery?.required && !run.release && run.workspace?.state !== 'removed') return ['retry-input', 'start-new']
  if (['completed', 'cancelled', 'failed'].includes(run.status)) {
    // A committed, verified, not-yet-integrated candidate may be integrated.
    const integrable = run.integrity?.status !== 'abandoned' && run.delivery?.action === 'commit' && run.delivery.completedAt && run.delivery.commit && !run.integration?.mergeCommit && !['publishing', 'published'].includes(run.integration?.phase)
    return integrable ? ['start-new', 'integrate'] : ['start-new']
  }
  return active ? ['stop'] : []
}
