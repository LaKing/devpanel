import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './runtime/clock.mjs'
import * as store from './runtime/store.mjs'
import { LockHeld, acquire } from './runtime/lock.mjs'
import { SERVICE_SHUTDOWN } from './runtime/run-control.mjs'
import { CHANGES_MS, changeList, cycleChanges, scopeUnreadable } from './full-verification.mjs'
import { cycleRecords } from './runtime/full-verification-drive.mjs'
import { CHANGE_PATHS, readCheckouts, readGit } from './runtime/full-verification-snapshot.mjs'
import { resolveProjectPath } from './project-path.mjs'

/*
 * The Full verification playbook (playbooks/full-verification.yaml, an engine-only playbook whose phases name the
 * full-verification engine program, config/engine-operations.mjs) runs the existing cycle (full-verification.mjs) as
 * one run, held on the issue it was started from. The cycle is wrapped, never changed: its record names the run
 * (`record.run`), and the run mirrors the record into `run.cycleRun` (status, a timeline of the playbook's phases,
 * what each phase holds) on every write of the record (`verification:changed`).
 *
 * - Entrances: every cycle is this playbook's run. POST /api/verification/start (the dashboard's button), the delivery
 *   check at fullVerification.afterDeliveries and the top-level supervisor's start_verification call startEntrance(),
 *   which holds the run in the day's cycle home (issues.js ensureCycleHome) of the first project of the cycle's scope
 *   (else of the first project); an issue's start dialog starts it on that issue. The cycle's `trigger` names the
 *   entrance (hand, deliveries, supervisor; playbook for the start dialog).
 * - Start: supervisor.start reserves the run (one live run per issue, its run lock) and hands it to drive().
 *   Before the cycle freezes, drive() records the preview on the first phase: the change list read now (part 1's
 *   list, full-verification.mjs cycleChanges/changeList) and the live runs the freeze would pause.
 * - Stop: the run's controller aborts; drive() forwards it to the cycle as an interruption with reason `stopped`, and
 *   the cycle ends as an interrupted cycle ends (settleInterruption, thaw, resume, instances destroyed by their drives).
 *   A service shutdown is not a Stop: the cycle is left to recover() at the next start, as before, and the run record
 *   is left `stopping` (never cancelled with stoppedBy service-shutdown, which resumeInterrupted would resume).
 * - A runner failure after the start: the cycle is interrupted with the run (stopped by `engine`), and the run stays live,
 *   reachable by Stop, until the cycle settled; only then does it read failed.
 * - Recovery: supervisor.reconcile settles a live run with a dead owner as cancelled (markUnownedHeld); after the
 *   cycle's own recover(), recover() here mirrors the record recover() left onto the run.
 * - Live output: the verification output feed (GET /api/verification/output?cycle=<id>), as on /verification.
 */

const PROGRAM = 'full-verification'
const SETTLED = ['ended', 'interrupted', 'failed']
const LIVE = ['pending', 'preflighting', 'running', 'stopping']
const THAW = 4

/** How far a cycle got, as the index of the playbook phase it is in (freeze, wait, stages, outcome, thaw; 5: ended). */
function reachedOf (record) {
  if (!record) return 0
  if (SETTLED.includes(record.state)) return 5
  if (record.state === 'resuming') return THAW
  if (record.state === 'running') return record.changes || record.outcome ? 3 : 2
  return 1
}

/** The phase an interrupted or failed cycle stopped in, read off its record. */
function stoppedIn (record) {
  if (!record.seatsIdleAt) return 1
  if (record.outcome && !record.outcome.skipped && !record.outcome.interrupted) return 3
  return record.startedAt ? 2 : 1
}

/** Where an entry's output can be read: the verification output feed for every entry with a drive or run directory. */
function outputOf (e) {
  if (typeof e.runDir === 'string') return { where: 'feed', ...(e.runId ? { run: { issueId: e.issueId ?? null, runId: e.runId } } : {}) }
  const why = e.verifiedThrough ? `verified through its instances (${e.reason ?? 'no stage of its own'})`
    : e.mode === 'derived' || e.derived ? 'derived from its instances\' entries: their output is theirs'
      : e.state === 'deferred' ? 'waits for its instances'
        : e.refusal ? `refused (${e.refusal.code ?? 'refused'}): nothing was driven`
          : e.state === 'not-run' || e.state === 'interrupted' ? `${e.state}: nothing was driven`
            : 'no drive yet'
  return { where: 'none', reason: why }
}

/**
 * What the run shows of a cycle (pure): its status and phase, and the playbook's phases with state, times and what
 * each holds. `observed` keeps when this process first saw a phase begin (the record has no time for some of them).
 */
export function cycleRunView ({ record, phases, preview = null, stopping = false, observed = null, now = new Date().toISOString(), startedAt = null }) {
  const reached = reachedOf(record)
  const settled = record && SETTLED.includes(record.state)
  const halted = settled && record.state !== 'ended' ? stoppedIn(record) : null
  // Live, each phase's start is when it was first seen; read back later (recovery), only the record's own times.
  const seen = observed ?? {}
  if (observed) for (let i = 0; i <= Math.min(reached, THAW); i++) observed[i] ??= now
  const timeOf = (i) => [
    startedAt ?? record?.frozenAt,
    seen[1] ?? record?.frozenAt,
    record?.startedAt ?? record?.seatsIdleAt ?? seen[2],
    seen[3],
    seen[4]
  ][i] ?? null
  const detail = [
    () => ({ preview, scope: record?.scope?.projects ?? null, asked: record?.asked ?? null, hosts: record?.scope?.hosts ?? null, ...(record?.scope?.unresolvedHosts ? { unresolvedHosts: record.scope.unresolvedHosts } : {}) }),
    () => record ? { waitingOn: record.waitingOn ?? [], waited: record.waited ?? null } : null,
    () => record?.startedAt ? {
      entries: (record.projects ?? []).map((e) => ({
        project: e.project, stage: e.stage ?? null, mode: e.mode ?? (e.verifiedThrough ? 'instances' : null), state: e.state ?? null, verdict: e.verdict ?? null,
        refusal: e.refusal?.code ?? null, runId: e.runId ?? null, issueId: e.issueId ?? null, driveId: e.driveId ?? null, instance: e.instance?.name ?? null,
        flaky: (e.flaky ?? []).map((f) => ({ command: f.command, test: f.test })), output: outputOf(e)
      }))
    } : null,
    () => reached >= 3 ? {
      verdict: record.verdict ?? null, changes: changeList(record),
      committed: record.outcome?.committed === true, withheld: (record.outcome?.bump?.withheld ?? []).map((w) => w.framework),
      issues: (record.outcome?.issues ?? []).map((i) => ({ project: i.project, issueId: i.issueId, name: i.name ?? null })),
      reason: record.outcome?.reason ?? record.outcome?.skipped ?? null
    } : null,
    () => reached >= THAW ? {
      resumed: record.resumed ?? [], heldForOperator: record.heldForOperator ?? [], leftPaused: record.leftPaused ?? [], refused: record.refused ?? [],
      interruption: record.interruption ?? null, error: record.error ?? null
    } : null
  ]
  const shown = phases.map((p, i) => {
    let state
    if (halted != null && i !== THAW) state = i < halted ? 'done' : i === halted ? (record.state === 'failed' ? 'failed' : 'interrupted') : 'skipped'
    else state = i < reached ? 'done' : i === reached ? 'running' : 'pending'
    const begun = state !== 'pending' && state !== 'skipped'
    return {
      id: p.id, title: p.title ?? null, engine: p.engine, state,
      startedAt: begun ? timeOf(i) : null,
      endedAt: ['done', 'interrupted', 'failed'].includes(state) ? (i === THAW ? record?.endedAt ?? null : timeOf(i + 1) ?? record?.endedAt ?? null) : null,
      detail: begun ? detail[i]?.() ?? null : null
    }
  })
  const status = !settled ? (stopping ? 'stopping' : 'running') : record.state === 'ended' ? 'completed' : record.state === 'interrupted' ? 'cancelled' : 'failed'
  const current = shown.find((p) => p.state === 'running') ?? null
  return {
    status, terminal: Boolean(settled), phase: current?.id ?? null,
    cycleId: record?.id ?? null, state: record?.state ?? null, trigger: record?.trigger ?? null, verdict: record?.verdict ?? null,
    scope: record?.scope?.projects ?? null, interruption: record?.interruption ?? null, error: record?.error ?? null,
    stages: record?.startedAt ? { total: (record.projects ?? []).filter((e) => e.stage && !e.verifiedThrough).length, settled: (record.projects ?? []).filter((e) => e.stage && !e.verifiedThrough && e.verdict).length } : null,
    red: (record?.projects ?? []).filter((e) => !e.verifiedThrough && e.verdict === 'red').map((e) => e.project),
    phases: shown
  }
}

/** Apply a cycle's view to a run record (mutates `run`). */
function applyView (run, view, at) {
  const { status, terminal, phase, ...rest } = view
  run.cycleRun = { ...(run.cycleRun ?? {}), program: PROGRAM, ...rest, mirroredAt: at }
  run.phase = { id: phase, round: 0, stepId: null }
  run.status = status
  if (terminal) {
    run.endedAt ??= at
    if (status === 'failed') run.failure ??= { class: 'runtime', message: view.error ?? 'the full verification cycle failed' }
  }
}

export function createCycleRuns ({
  fullVerification,
  supervisor,
  issues,
  verificationDir = path.join(issues.ISSUES_DIR, '.verification'),
  clock = systemClock,
  projectPathOf = (project) => resolveProjectPath(project),
  headOf = async (checkout) => (await readGit(['-C', checkout, 'rev-parse', 'HEAD'])).trim(),
  readCheckoutsOf = (checkouts) => readCheckouts(checkouts),
  /** The change list for these projects read now; default: cycleChanges over each checkout's HEAD and git status now. */
  changesOf = null,
  changesMs = CHANGES_MS,
  log = console
} = {}) {
  /** Runs this process drives, by cycle id: told of every write of their cycle's record. */
  const watching = new Map()
  /** Runs this process drives now, from their reservation to their end (a run still previewing has no cycle yet). */
  const driving = new Set()
  /** An entrance being admitted (startEntrance), and what each entrance-started run's cycle records: by holder key. */
  let starting = 0
  const entrances = new Map()

  async function changesNow (projects) {
    const entries = []
    for (const project of projects) {
      const dir = await Promise.resolve().then(() => projectPathOf(project)).catch(() => null)
      if (!dir) { entries.push({ project, atSnapshot: { error: 'the project checkout could not be resolved' } }); continue }
      const checkout = await fs.realpath(dir).catch(() => dir)
      const reading = await readCheckoutsOf([checkout])
      const checkouts = []
      for (const c of reading.checkouts ?? []) {
        if (c.error) { checkouts.push({ checkout: c.checkout, error: c.error }); continue }
        const paths = Object.keys(c.paths ?? {}).sort()
        checkouts.push({ checkout: c.checkout, head: await Promise.resolve().then(() => headOf(c.checkout)).catch(() => null), uncommitted: { paths: paths.slice(0, CHANGE_PATHS), total: paths.length } })
      }
      entries.push({ project, atSnapshot: { readAt: clock.iso(), checkouts } })
    }
    return cycleChanges({ record: { projects: entries }, records: await cycleRecords(verificationDir), projectPathOf, listIssues: (p, o) => issues.listIssues(p, o), listHomes: issues.listRunHomes ? (p) => issues.listRunHomes(p) : null, clock })
  }

  /**
   * What a cycle started now would do, read-only (AC7): the projects it verifies, what changed in them since the last
   * verification (read now, before any snapshot; the cycle reads it again at its snapshot) and which live runs its freeze
   * would pause. Never throws: a part that cannot be read says so.
   */
  async function preview () {
    const readAt = clock.iso()
    let scope
    try {
      const read = await fullVerification.scope()
      if (read.unreadable?.length) return { readAt, scope: null, error: `the projects the cycle would verify cannot be decided: ${read.unreadable.map((u) => u.message ?? `${u.path} (${u.code ?? 'error'})`).join('; ')}` }
      scope = read.projects
    } catch (error) {
      return { readAt, scope: null, error: error.message }
    }
    const freeze = supervisor.freezeCandidates?.(scope) ?? { wouldPause: [], mayContinue: [], pending: [] }
    let disarm = null
    const timedOut = new Promise((resolve) => { disarm = clock.after(changesMs, () => resolve(null)) })
    let changes
    try {
      const computed = await Promise.race([Promise.resolve().then(() => (changesOf ?? changesNow)(scope)), timedOut])
      changes = computed ? changeList({ changes: computed }) : { state: 'failed', error: `not computed within ${Math.round(changesMs / 1000)} s` }
    } catch (error) {
      changes = { state: 'failed', error: error.message }
    } finally {
      disarm?.()
    }
    return { readAt, basis: 'read now, before any snapshot: the cycle reads what changed again when it snapshots each checkout', scope, changes, ...freeze }
  }

  /** Refused before anything is reserved: one cycle at a time, and one Full verification run at a time in this process. */
  async function admit () {
    if (driving.size) throw Object.assign(new Error(`a Full verification run is already being driven (${[...driving].join(', ')})`), { status: 409, code: 'FULL_VERIFICATION_RUNNING', started: false, retryable: true })
    const latest = await fullVerification.latest().catch(() => null)
    if (latest?.active) throw Object.assign(new Error(`a full verification cycle is already running (${latest.cycle?.id ?? 'unknown'})`), { status: 409, code: 'FULL_VERIFICATION_RUNNING', cycleId: latest.cycle?.id ?? null, started: false, retryable: true })
  }

  /** Whether a Full verification run is being started or driven by this process (the delivery check waits for it). */
  // An entrance's note stands from before its run is reserved until drive() takes it: a run reserved but not yet driven
  // counts while the supervisor holds it live (a reservation whose launch failed holds nothing).
  const handedOver = () => [...entrances.keys()].some((k) => { const i = k.indexOf('/'); return supervisor.isActive?.(k.slice(0, i), k.slice(i + 1)) ?? false })
  const busy = () => starting > 0 || driving.size > 0 || handedOver()

  /**
   * An entrance (POST /api/verification/start, the delivery check, the top-level supervisor): start the Full verification
   * playbook run in the day's cycle home. Refused before anything is reserved when a cycle or such a run is live or the
   * scope cannot be read. Returns the run.
   */
  async function startEntrance ({ trigger, by, deliveries = null, expectConfigHash = null }) {
    // Another entrance being admitted, or its run reserved and not yet driven: this one is refused before it touches
    // anything, so it can never overwrite or remove that entrance's note (and with it the cycle's trigger).
    if (busy()) throw Object.assign(new Error('a Full verification run is already being started'), { status: 409, code: 'FULL_VERIFICATION_RUNNING', started: false, retryable: true })
    starting++
    try {
      await admit()
      const read = await fullVerification.scope()
      // The cycle's own refusal (503, as startCycle gives it): the configuration cannot be read now, which may pass.
      if (read.unreadable?.length) throw Object.assign(scopeUnreadable(read.unreadable), { started: false, retryable: true })
      // The holder's project: the first of the scope, else the first project (a cycle with an empty scope still runs).
      const ids = (list) => list.map((p) => p?.id ?? p).filter((id) => typeof id === 'string').sort()
      const project = ids(read.projects ?? [])[0] ?? ids(await issues.listProjects())[0]
      if (!project) throw Object.assign(new Error('there is no project to hold the Full verification run'), { status: 409, code: 'FULL_VERIFICATION_NO_PROJECT', started: false, retryable: false })
      const date = clock.iso().slice(0, 10)
      const home = await issues.ensureCycleHome(project, date, `# Full verification ${date}\n\nThe Full verification playbook runs this home holds were started by an entrance: by hand (POST /api/verification/start, the dashboard), after the configured number of deliveries per stage, or by the top-level supervisor. Each run is one full verification cycle.\n`)
      const k = `${project}/${home.id}`
      const note = { trigger, by, deliveries }
      entrances.set(k, note)
      let started
      try {
        started = await supervisor.start({ project, issueId: home.id, playbookId: PROGRAM, expectConfigHash, runOptions: {} })
      } catch (error) {
        // Only this entrance's own note goes.
        if (entrances.get(k) === note) entrances.delete(k)
        throw error
      }
      return { run: { project, issueId: home.id, runId: started.runId }, status: started.status }
    } finally {
      starting--
    }
  }

  /** The playbook's phases, from the run's own snapshot. */
  const phasesOf = async (issuePath, runId) => (await store.readSnapshot(issuePath, runId).catch(() => null))?.phases ?? []

  /** Drive one run (supervisor.mjs launchEngineProgram): start the cycle, mirror it, settle the run. */
  async function drive (context) {
    driving.add(context.runId)
    const entrance = entrances.get(`${context.project}/${context.issueId}`) ?? null
    entrances.delete(`${context.project}/${context.issueId}`)
    try {
      await driveRun(context, entrance)
    } finally {
      driving.delete(context.runId)
      if (entrance) fullVerification.noteEntranceRunEnded?.({ runId: context.runId, refused: Boolean(context.run.cycleRun?.refused) })
    }
  }

  async function driveRun ({ project, issueId, runId, issuePath, run, signal, stoppedBy, stopActor, stopping, write, emit }, entrance) {
    const phases = await phasesOf(issuePath, runId)
    const observed = {}
    const started = run.startedAt
    const shown = (record, extra = {}) => cycleRunView({ record, phases, preview: run.cycleRun?.preview ?? null, stopping: stopping(), observed, now: clock.iso(), startedAt: started, ...extra })
    const progress = () => emit?.({ type: 'cycle-run-progress', status: run.status, phase: run.phase?.id ?? null })

    // A service shutdown leaves the cycle to the next start's recovery and the run record as beginStop wrote it.
    let detached = false
    let letGo = null
    const leaving = new Promise((resolve) => { letGo = resolve })
    const stopCycle = new AbortController()
    const onAbort = () => {
      if (stoppedBy() === SERVICE_SHUTDOWN) { detached = true; letGo(); return }
      stopCycle.abort({ by: stopActor() ?? 'operator' })
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    if (detached) return

    // The first timeline entry: what the cycle would verify, what changed, and what its freeze would pause.
    run.cycleRun = { ...(run.cycleRun ?? {}), program: PROGRAM, preview: await preview() }
    applyView(run, shown(null), clock.iso())
    await write()
    progress()
    if (detached) return

    let begun
    try {
      // The entrance that started the run names the cycle's trigger; an issue's start dialog is `playbook`.
      begun = await fullVerification.startForRun({
        by: entrance?.by ?? 'operator', trigger: entrance?.trigger ?? 'playbook', deliveries: entrance?.deliveries ?? null,
        run: { project, issueId, runId }, signal: stopCycle.signal
      })
    } catch (error) {
      if (detached) return
      // Nothing was frozen: the cycle refused (one already running, a scope that cannot be read).
      Object.assign(run, { status: 'failed', endedAt: clock.iso(), failure: { class: 'environment', code: error.code ?? null, message: error.message } })
      run.cycleRun = { ...run.cycleRun, refused: { code: error.code ?? null, message: error.message } }
      await write()
      progress()
      return
    }

    // Mirrors, one write in flight and the newest record pending, in order.
    let latest = begun.cycle
    let chain = Promise.resolve()
    let queued = false
    // The runner itself failed after the start: nothing more is mirrored onto the run (the supervisor records the failure).
    let failed = false
    const mirror = () => {
      if (queued) return chain
      queued = true
      chain = chain.then(async () => {
        queued = false
        if (detached || failed) return
        applyView(run, shown(latest), clock.iso())
        await write()
        progress()
      }).catch((error) => log.warn?.(`[devpanel] full verification run ${runId}: the record could not be mirrored: ${error.message}`))
      return chain
    }
    const watcher = async () => { latest = (await fullVerification.recordOf(begun.cycle.id).catch(() => null)) ?? latest; if (!SETTLED.includes(latest.state)) mirror() }
    watching.set(begun.cycle.id, watcher)
    try {
      mirror()
      const ended = await Promise.race([begun.done, leaving])
      if (detached) return
      latest = ended ?? latest
      await chain
      if (detached) return
      applyView(run, shown(latest), clock.iso())
      await write()
      progress()
    } catch (error) {
      if (detached) throw error
      // risk-7460361803f8: a run that fails while its cycle is live would leave the cycle frozen and out of Stop's reach. The
      // cycle is interrupted with the run (stopped by the engine) and the run stays live, with Stop's listener, until the cycle
      // settled; only then does the failure reach the supervisor, which records it. A service shutdown meanwhile lets go as
      // before (the cycle is left to the next start's recovery, and the shutdown is not made a failure).
      failed = true
      stopCycle.abort({ by: 'engine' })
      await Promise.race([begun.done.catch(() => null), leaving])
      const settled = async () => { const record = await fullVerification.recordOf(begun.cycle.id).catch(() => null); return !record || SETTLED.includes(record.state) }
      while (!detached && !(await settled())) await Promise.race([new Promise((resolve) => clock.after(1000, resolve)), leaving])
      if (detached) return
      await chain
      throw error
    } finally {
      watching.delete(begun.cycle.id)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** A cycle's record was written (full-verification.mjs `verification:changed`): mirror it onto its run. */
  function noteChanged (event) {
    const watcher = event?.id ? watching.get(event.id) : null
    if (watcher) watcher().catch(() => {})
  }

  /**
   * At the panel's start, after the cycle's own recover(): each run of the newest cycle records whose run record does
   * not carry how its cycle ended gets it, under its issue's run lock (a lock a live or unknown owner holds is left).
   */
  async function recover () {
    const mirrored = []
    const records = (await cycleRecords(verificationDir).catch(() => [])).filter((r) => r.run).slice(0, 10)
    for (const record of records) {
      if (!SETTLED.includes(record.state)) continue
      const { project, issueId, runId } = record.run
      const holder = await (issues.getRunHolder ?? issues.getIssue)(project, issueId).catch(() => null)
      if (!holder?.path || holder.packed) continue
      const seen = await store.readRun(holder.path, runId).catch(() => null)
      if (!seen?.engineProgram || (seen.cycleRun?.state === record.state && !LIVE.includes(seen.status))) continue
      let lock = null
      try {
        lock = await acquire(path.join(holder.path, '.run.lock'), { purpose: 'cycle-run-recovery', runId, mkdir: false })
      } catch (error) {
        if (error instanceof LockHeld) continue
        log.warn?.(`[devpanel] full verification run ${runId} could not be recovered: ${error.message}`)
        continue
      }
      try {
        const run = await store.readRun(holder.path, runId)
        const view = cycleRunView({ record, phases: await phasesOf(holder.path, runId), preview: run.cycleRun?.preview ?? null, now: clock.iso(), startedAt: run.startedAt })
        applyView(run, view, clock.iso())
        run.stoppedBy = null
        await store.writeRun(holder.path, runId, run)
        mirrored.push({ project, issueId, runId, cycleId: record.id })
      } catch (error) {
        log.warn?.(`[devpanel] full verification run ${runId} could not be recovered: ${error.message}`)
      } finally {
        await lock.release().catch(() => {})
      }
    }
    return mirrored
  }

  /** The Full verification runs whose cycle verifies this project (its scope), newest first (AC6). */
  async function forProject (project, { limit = 10 } = {}) {
    return (await cycleRecords(verificationDir)).filter((r) => r.run && (r.scope?.projects ?? []).includes(project)).slice(0, limit)
      .map((r) => ({ cycleId: r.id, date: r.date, state: r.state, verdict: r.verdict ?? null, run: r.run }))
  }

  return { admit, busy, startEntrance, drive, preview, noteChanged, recover, forProject }
}
