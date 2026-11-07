import fs from 'node:fs/promises'
import path from 'node:path'

import { systemClock } from './runtime/clock.mjs'
import { hostSettings } from './config/host-settings.mjs'
import { resolvePlaybook } from './config/load.mjs'
import { TARGET_MISSING } from './config/release-plan.mjs'
import { projectInfrastructure } from './infrastructure.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { stagedReleasePassed } from './runtime/run-result.mjs'

/*
 * The daily full verification (docs/tactical-playbooks.md "The daily full
 * verification", execution-contract.md "Full verification freeze").
 *
 * At the host settings' `fullVerification.at` in its `timeZone` (or by hand,
 * POST /api/verification/start) a cycle:
 *   1. closes admission (supervisor.freeze): no run starts or continues, and every
 *      live run of an issue pauses at its next step boundary as `full-verification`;
 *   2. waits until no run of an issue is left in this process, so no seat turn runs;
 *   3. starts one Deployment run (environment staging, `fullVerification`) per
 *      configured stage, in the project's run home issues/<project>/.verification-<date>/,
 *      one at a time per staging host and hosts side by side: the candidate is the
 *      development checkout as it stands, and the run drives the full check tier on
 *      it against the previous green cycle (runtime/full-verification-drive.mjs);
 *      a project with no infrastructure, or whose staging declares
 *      `fullVerification: instances`, is recorded as verified through its instances;
 *   4. waits until those runs settle, opens admission and resumes the runs it paused;
 *   5. writes issues/.verification/<date>/cycle.json at every step.
 * It bumps no version and opens no issue: part 4 of the daily verification reads the record.
 */

export const HOUR = 60 * 60 * 1000
const LIVE = ['pending', 'preflighting', 'running', 'stopping']
const SETTLED_CYCLE = ['ended', 'interrupted', 'failed']

/** The zone's local wall-clock parts of an instant. */
function localParts (ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]))
  return parts
}

/** YYYY-MM-DD in the zone. */
export function localDate (ms, timeZone) {
  const p = localParts(ms, timeZone)
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

const offsetAt = (ms, timeZone) => {
  const p = localParts(ms, timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** The instant a local date and HH:MM name in the zone: the earlier of an ambiguous time, the shifted one of a skipped time. */
function zonedInstant (year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  const candidates = [...new Set([offsetAt(wall - 12 * HOUR, timeZone), offsetAt(wall + 12 * HOUR, timeZone)])].map((o) => wall - o)
  const exact = candidates.filter((t) => { const p = localParts(t, timeZone); return p.hour === hour && p.minute === minute && p.day === day })
  return exact.length ? Math.min(...exact) : Math.max(...candidates)
}

/** The first instant after `nowMs` at which the zone's clock reads `at`. */
export function nextTrigger ({ at, timeZone }, nowMs) {
  const [hour, minute] = at.split(':').map(Number)
  const today = localParts(nowMs, timeZone)
  for (let day = 0; day < 3; day++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + day))
    const t = zonedInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, timeZone)
    if (t > nowMs) return t
  }
  throw new Error(`no ${at} in ${timeZone} within three days of ${new Date(nowMs).toISOString()}`)
}

/** What a project is to the cycle: a stage to release to, or verified through its instances. */
export function stageOf (project, infra) {
  if (!infra) return { project, stage: null, verifiedThrough: 'instances', reason: 'the project has no infrastructure' }
  if (infra.staging?.fullVerification === 'instances') return { project, stage: infra.staging.id, verifiedThrough: 'instances', reason: 'its staging declares fullVerification: instances' }
  return { project, stage: infra.staging.id, host: infra.staging.ssh?.hostRef ?? infra.staging.id }
}

const report = ({ project, stage }) => `# Daily full verification of ${project} on ${stage}

This is the panel's daily full verification, not a reported problem. Release the project's development
checkout as it stands to the staging environment \`${stage}\` and assess that release as for any staging
release. After the release, the engine drives the project's full check tier on the same snapshot and
compares it with the previous green cycle; a new failure stops the run on its own.

Nothing is to be changed, delivered or opened: no source edit, no version bump, no issue. Accept the
release when the release evidence shows it healthy; reject it, with the evidence, when it does not.
`

/**
 * The scheduler and the cycle. `supervisor` is the run supervisor (freeze, thaw,
 * busy, start, resume, isActive); `issues` the issue store (listProjects,
 * listIssues, ensureRunHome); everything time-based runs on `clock`.
 */
export function createFullVerification ({
  supervisor,
  issues,
  clock = systemClock,
  settings = () => hostSettings().fullVerification,
  configRoot = process.env.DEVPANEL_CONFIG_ROOT,
  verificationDir = path.join(issues.ISSUES_DIR, '.verification'),
  resolve = (playbookId, options) => resolvePlaybook(playbookId, options),
  infrastructureOf = (project) => projectInfrastructure(project, { root: configRoot }),
  readRun = (issuePath, runId) => fs.readFile(path.join(issuePath, 'runs', runId, 'run.json'), 'utf8').then(JSON.parse),
  emit = null,
  pollMs = 5000,
  log = console
} = {}) {
  let cancel = null
  let current = null
  let running = null
  let stopped = false

  const wait = (ms) => new Promise((resolve) => clock.after(ms, resolve))
  const changed = (record) => emit?.({ type: 'verification:changed', id: record.id, state: record.state })

  async function write (record) {
    await writeJson(path.join(verificationDir, record.date, 'cycle.json'), record)
    changed(record)
  }

  /** Keep an earlier cycle of the same date as cycle.<n>.json; cycle.json is always the latest. */
  async function rotate (date) {
    const dir = path.join(verificationDir, date)
    await fs.mkdir(dir, { recursive: true })
    const names = await fs.readdir(dir)
    const kept = names.filter((n) => /^cycle\.\d+\.json$/.test(n)).length
    if (names.includes('cycle.json')) {
      await fs.rename(path.join(dir, 'cycle.json'), path.join(dir, `cycle.${kept + 1}.json`))
      return kept + 2
    }
    return kept + 1
  }

  async function latestRecord () {
    const dates = (await fs.readdir(verificationDir).catch(() => [])).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()
    for (const date of dates) {
      const record = await fs.readFile(path.join(verificationDir, date, 'cycle.json'), 'utf8').then(JSON.parse, () => null)
      if (record) return record
    }
    return null
  }

  /** Whether a scheduled cycle already ran for this local date (once per date). */
  async function scheduledOn (date) {
    const names = await fs.readdir(path.join(verificationDir, date)).catch(() => [])
    for (const n of names.filter((x) => /^cycle(\.\d+)?\.json$/.test(x))) {
      const record = await fs.readFile(path.join(verificationDir, date, n), 'utf8').then(JSON.parse, () => null)
      if (record?.trigger === 'schedule') return true
    }
    return false
  }

  // ------------------------------------------------------------ the schedule

  function readSettings () {
    try { return settings() } catch (error) { log.warn?.(`[devpanel] full verification: the host settings could not be read: ${error.message}`); return null }
  }

  /** Arm the next wake: the trigger when it is within the hour, else an hour from now to read the settings again. */
  function arm () {
    cancel?.()
    cancel = null
    if (stopped) return
    const s = readSettings()
    if (!s) { cancel = clock.after(HOUR, arm); return }
    const next = nextTrigger(s, clock.now())
    const delay = next - clock.now()
    cancel = delay <= HOUR ? clock.after(delay, () => fire(s, next)) : clock.after(HOUR, arm)
  }

  async function fire (armed, at) {
    const s = readSettings()
    // Edited since it was armed: the next wake follows the new block, or none.
    if (!s || s.at !== armed.at || s.timeZone !== armed.timeZone) return arm()
    arm()
    const date = localDate(at, s.timeZone)
    if (await scheduledOn(date)) return
    await startCycle({ trigger: 'schedule', by: 'schedule', scheduledFor: new Date(at).toISOString() })
      .catch((error) => log.warn?.(`[devpanel] the scheduled full verification did not start: ${error.message}`))
  }

  // --------------------------------------------------------------- the cycle

  /** Start a cycle and return a copy of its record as frozen; the cycle goes on in the background. */
  async function startCycle ({ trigger, by = null, scheduledFor = null }) {
    if (running) throw Object.assign(new Error(`a full verification cycle is already running (${current.id})`), { status: 409, code: 'FULL_VERIFICATION_RUNNING', cycleId: current.id })
    const s = readSettings()
    const timeZone = s?.timeZone ?? 'UTC'
    const date = localDate(clock.now(), timeZone)
    const record = {
      id: null, date, trigger, by, scheduledFor, schedule: s ? { at: s.at, timeZone: s.timeZone } : null, timeZone,
      state: 'frozen', verdict: null, frozenAt: clock.iso(), seatsIdleAt: null, startedAt: null, endedAt: null,
      asked: [], waitingOn: [], projects: [], resumed: [], heldForOperator: [], refused: [], error: null
    }
    running = true
    current = record
    try {
      record.id = `${date}.${await rotate(date)}`
      record.asked = await supervisor.freeze(record.id)
      await write(record)
    } catch (error) {
      running = null
      current = null
      supervisor.thaw(record.id)
      throw error
    }
    // The record as it stood when admission closed; the cycle goes on changing its own copy.
    const frozen = structuredClone(record)
    running = cycle(record).catch((error) => log.warn?.(`[devpanel] full verification ${record.id} failed: ${error.message}`)).finally(() => { running = null })
    return frozen
  }

  async function cycle (record) {
    try {
      // No run of an issue left in this process: no seat turn is running.
      for (;;) {
        const busy = supervisor.busy()
        if (!busy.length) break
        if (JSON.stringify(busy) !== JSON.stringify(record.waitingOn)) { record.waitingOn = busy; await write(record) }
        await wait(pollMs)
      }
      record.waitingOn = []
      record.seatsIdleAt = clock.iso()
      record.state = 'running'
      record.startedAt = clock.iso()
      const projects = await issues.listProjects()
      for (const p of projects) {
        const id = p.id ?? p
        const infra = await infrastructureOf(id).catch((error) => ({ error: error.message }))
        record.projects.push(infra?.error ? { project: id, stage: null, verdict: 'red', refusal: { code: 'INFRASTRUCTURE_INVALID', message: infra.error } } : stageOf(id, infra))
      }
      await write(record)
      const hosts = new Map()
      for (const entry of record.projects.filter((e) => e.stage && !e.verifiedThrough && !e.verdict)) hosts.set(entry.host, [...(hosts.get(entry.host) ?? []), entry])
      // One run at a time per staging host; hosts side by side (drive slots still decide each drive).
      await Promise.all([...hosts.values()].map(async (entries) => { for (const entry of entries) await runStage(record, entry) }))
      // Every entry that is not verified through its instances counts, a project whose
      // configuration could not be read included: one red entry makes the cycle red.
      const judged = record.projects.filter((e) => !e.verifiedThrough)
      record.verdict = judged.some((e) => e.verdict !== 'green') ? 'red' : judged.length ? 'green' : 'no-stages'
    } catch (error) {
      record.error = error.message
      record.verdict = 'red'
    } finally {
      record.state = 'resuming'
      supervisor.thaw(record.id)
      await write(record).catch(() => {})
      await resumeFrozen(record).catch((error) => { record.error ??= `resuming: ${error.message}` })
      record.state = record.error ? 'failed' : 'ended'
      record.endedAt = clock.iso()
      await write(record).catch((error) => log.warn?.(`[devpanel] the full verification record ${record.id} could not be written: ${error.message}`))
    }
  }

  async function runStage (record, entry) {
    entry.state = 'starting'
    try {
      const home = await issues.ensureRunHome(entry.project, record.date, report(entry))
      entry.issueId = home.id
      entry.runHome = home.path
      const runOptions = { environment: 'staging', fullVerification: true }
      const resolution = await resolve('deployment', { root: configRoot, runOptions, projectId: entry.project })
      if (!resolution.ok) throw Object.assign(new Error(resolution.errors.map((e) => `${e.field}: ${e.message}`).join('; ')), { code: 'CONFIGURATION_INVALID' })
      const blockers = resolution.resolved.liveExecution?.blockers ?? []
      if (blockers.length) throw Object.assign(new Error(blockers.map((b) => b.reason).join('; ')), { code: blockers.some((b) => b.reason === TARGET_MISSING) ? 'TARGET_MISSING' : 'NOT_LAUNCHABLE' })
      const started = await supervisor.start({ project: entry.project, issueId: home.id, playbookId: 'deployment', expectConfigHash: resolution.resolved.configHash, runOptions, configRoot, cycle: record.id })
      Object.assign(entry, { runId: started.runId, runDir: path.join(home.path, 'runs', started.runId), state: 'running', startedAt: clock.iso() })
      await write(record)
      let run = null
      for (;;) {
        run = await readRun(home.path, started.runId).catch(() => null)
        if (run && !LIVE.includes(run.status) && !supervisor.isActive(entry.project, home.id)) break
        await wait(pollMs)
      }
      const check = run.fullVerification?.check ?? null
      Object.assign(entry, {
        state: 'settled', status: run.status, outcome: run.outcome ?? null, blockedReason: run.blockedReason ?? null,
        release: run.release ? { status: run.release.status, environment: run.release.environment ?? null } : null,
        endedAt: run.endedAt ?? clock.iso(),
        check: check ? { dir: check.result?.dir ?? null, result: check.result?.result ?? null, gating: check.gating, baseline: check.baseline ?? null, baseCommit: check.baseCommit ?? null, files: check.files ?? {},
          newFailures: [...(check.selftest?.newFailures ?? []), ...(check.failures?.newFailures ?? [])].map((f) => ({ command: f.command, test: f.test })) } : null,
        verdict: stagedReleasePassed(run.release, run) && check?.gating === 'passed' ? 'green' : 'red'
      })
    } catch (error) {
      Object.assign(entry, { state: 'refused', verdict: 'red', refusal: { code: error.code ?? null, status: error.status ?? null, message: error.message } })
    }
    entry.durationMs = entry.startedAt ? Math.max(0, Date.parse(entry.endedAt ?? clock.iso()) - Date.parse(entry.startedAt)) : null
    await write(record)
  }

  /**
   * Resume every run of an issue or a run home the freeze paused; one where an operator's pause was
   * pending as well stays paused for that operator. Refusals are recorded, never retried.
   */
  async function resumeFrozen (record) {
    for (const p of await issues.listProjects()) {
      const project = p.id ?? p
      // The issues, and the run homes: a run of an earlier cycle this cycle froze is resumed the same way.
      const holders = [...await issues.listIssues(project).catch(() => []), ...(issues.listRunHomes ? await issues.listRunHomes(project).catch(() => []) : [])]
      for (const issue of holders) {
        const latest = issue.latestRun
        if (latest?.status !== 'paused') continue
        const run = await readRun(issue.path, latest.runId).catch(() => null)
        if (run?.pause?.kind !== 'full-verification') continue
        const named = { project, issueId: issue.id, runId: latest.runId }
        if (run.pause.manualPending) { record.heldForOperator.push(named); continue }
        try {
          await supervisor.resume({ ...named, actor: 'service', origin: 'full-verification' })
          record.resumed.push(named)
        } catch (error) {
          record.refused.push({ ...named, reason: error.message })
        }
      }
    }
  }

  return {
    /** Arm the schedule. Absent `fullVerification` block: the timer only reads the settings again hourly. */
    start () { stopped = false; arm() },
    stop () { stopped = true; cancel?.(); cancel = null },
    /** "Full verification now": the same freeze, runs and record as the scheduled cycle. */
    startNow: ({ by = 'operator' } = {}) => startCycle({ trigger: 'hand', by }),
    /** A cycle the previous process left unfinished is marked interrupted; the runs it paused are resumed. */
    async recover () {
      const record = await latestRecord()
      if (record && !SETTLED_CYCLE.includes(record.state)) {
        Object.assign(record, { state: 'interrupted', endedAt: clock.iso(), error: 'the service stopped before the cycle ended; its runs were not resumed automatically' })
        await write(record)
      }
      const resumed = { id: record?.id ?? null, resumed: [], heldForOperator: [], refused: [] }
      await resumeFrozen(resumed)
      return resumed
    },
    async latest () {
      const s = readSettings()
      return {
        schedule: s ? { at: s.at, timeZone: s.timeZone, next: new Date(nextTrigger(s, clock.now())).toISOString() } : null,
        active: Boolean(running),
        frozen: supervisor.frozen?.() ?? null,
        cycle: running ? current : await latestRecord()
      }
    },
    /** For tests: the cycle in progress settles. */
    settle: () => Promise.resolve(running)
  }
}
