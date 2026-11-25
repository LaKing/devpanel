import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFullVerification, cycleScope, localDate, readCycleConfig, stageOf } from '../server/full-verification.mjs'
import { hostConfigDir, hostConfigSelection, overlay } from '../server/config/host-config.mjs'
import { discoveredProjects, listProjectDirs, readProjectDirs } from '../server/project-path.mjs'
import { slugify } from '../server/issues.js'
import { manualClock } from '../server/runtime/clock.mjs'
import { TARGET_MISSING } from '../server/config/release-plan.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolvePlaybook } from '../server/config/load.mjs'
import { sandbox, startCycleByHand } from './helpers.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { startRun, worktreeDiffDelivery, releaseWorkspace } from '../server/runtime/launch.mjs'
import YAML from 'yaml'

// The fixtures' stage hosts are aliases no ssh configuration resolves: each cycle pins them as named (no connection is made).
const fakeResolve = async (ssh) => ({ host: String(ssh?.hostRef ?? '').replace(/^ssh-config:/, ''), pinned: null })

export const name = 'full verification — only a playbook run starts a cycle, no daily time, the scoped freeze and its wait, one run per stage, the record'

const BERLIN = { at: '06:00', timeZone: 'Europe/Berlin' }
const iso = (ms) => new Date(ms).toISOString()

async function until (fn, label, ms = 5000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const environment = (id, hostRef, extra = {}) => ({ id, ssh: { hostRef, workdir: '/opt' }, projectRoot: '/opt/app', files: {}, ...extra })

/**
 * The projects a cycle reads, a fake supervisor and issue store, and what they were asked.
 * `checks` replaces a project's full check, `files` are written into its run's drive directory,
 * `frameworkOf` declares instances (framework:), `failAction` names a project whose checkpoint fails.
 */
function world ({ busy = [], issuesDir, paused = [], checks = {}, files = {}, frameworkOf = {}, failAction = null }) {
  const infra = {
    // A release target for the staging environment (the Deployment resolution's TARGET_MISSING otherwise); lib-project has none.
    'app-project': { staging: environment('stage', 'ssh-config:stage-a'), release: { targets: { stage: {} } } },
    'shop-project': { staging: environment('stage', 'ssh-config:stage-a'), release: { targets: { stage: {} } } },
    'lib-project': { staging: environment('stage', 'ssh-config:stage-b') },
    'framework-project': { staging: environment('stage', 'ssh-config:stage-c', { fullVerification: 'instances' }), release: { targets: { stage: {} } } },
    'tool-project': null
  }
  const calls = { freezes: [], scopes: [], thaws: [], starts: [], resumes: [], createIssue: 0, issues: [], attachments: [], actions: [], order: [], homes: [] }
  const runCount = new Map()
  const runs = new Map()
  const activeOnHost = new Map()
  let maxPerHost = 0
  const host = (project) => infra[project]?.staging.ssh.hostRef
  const supervisor = {
    busyList: busy,
    frozenState: null,
    async freeze (cycleId, options) { calls.freezes.push(cycleId); calls.scopes.push(options?.projects ?? null); this.frozenState = { cycleId, at: '2026-11-07T05:00:00.000Z' }; return [] },
    thaw (cycleId) { calls.thaws.push(cycleId); calls.order.push('thaw'); this.frozenState = null; return true },
    frozen () { return this.frozenState },
    busy () { return this.busyList },
    isActive: () => false,
    async start (args) {
      calls.starts.push(args)
      const h = host(args.project)
      activeOnHost.set(h, (activeOnHost.get(h) ?? 0) + 1)
      maxPerHost = Math.max(maxPerHost, activeOnHost.get(h))
      const n = (runCount.get(args.project) ?? 0) + 1
      runCount.set(args.project, n)
      const runId = n === 1 ? `run-${args.project}` : `run-${args.project}-${n}`
      const check = { result: { result: 'passed', dir: 'checks/full-verification' }, gating: 'passed', baseline: null, baseCommit: 'abc', files: { 'selftest.stdout': 'f00' }, ...(checks[args.project] ?? {}) }
      const driveDir = path.join(issuesDir, args.project, `.${args.issueId}`, 'runs', runId, check.result.dir)
      await fs.mkdir(driveDir, { recursive: true })
      for (const [name, text] of Object.entries(files[args.project] ?? {})) await fs.writeFile(path.join(driveDir, name), text)
      runs.set(runId, { host: h, record: { runId, status: 'completed', outcome: 'resolved', endedAt: '2026-11-07T05:30:00.000Z',
        release: { tactic: 'staging', status: 'completed', environment: 'stage' },
        fullVerification: { cycleId: args.cycle, check } } })
      return { runId, status: 'preflighting' }
    },
    async resume (args) { calls.resumes.push(args); return { status: 'pending' } }
  }
  const issues = {
    ISSUES_DIR: issuesDir,
    listProjects: async () => Object.keys(infra).map((id) => ({ id })),
    listIssues: async (project) => paused.filter((p) => p.project === project).map((p) => ({ id: p.issueId, path: `/fixture/${p.issueId}`, latestRun: { runId: p.runId, status: 'paused' } })),
    async createIssue (project, args) {
      calls.createIssue++
      calls.issues.push({ project, ...args })
      calls.order.push(`issue:${project}`)
      return { id: `issue-${calls.createIssue}`, project }
    },
    async addStepFile (project, id, number, name, bytes) { calls.attachments.push({ project, id, number, name, text: bytes.toString('utf8') }) },
    async ensureRunHome (project, date) {
      calls.homes.push({ project, date })
      const dir = path.join(issuesDir, project, `.verification-${date}`)
      await fs.mkdir(dir, { recursive: true })
      return { id: `verification-${date}`, path: dir }
    }
  }
  const readRun = async (issuePath, runId) => {
    const pausedRun = paused.find((p) => p.runId === runId)
    if (pausedRun) return { runId, status: 'paused', pause: { kind: 'full-verification', manualPending: pausedRun.manualPending === true } }
    const run = runs.get(runId)
    // Read once settled: the next run of that host may start now.
    activeOnHost.set(run.host, activeOnHost.get(run.host) - 1)
    return run.record
  }
  const resolve = async (playbookId, { projectId, runOptions }) => ({ ok: true, resolved: { configHash: `hash-${projectId}`, runOptions, infrastructure: infra[projectId] ?? null, liveExecution: { blockers: projectId === 'lib-project' ? [{ reason: TARGET_MISSING }] : [] } } })
  // The outcome's seams: the projects' framework: declarations, a fake checkpoint action, the versions it bumps.
  const versions = { 'framework-project': '0.4.12', 'app-project': '0.4.12-3', 'shop-project': '0.4.12-7' }
  const seams = {
    projectsConfig: async () => new Map(Object.keys(infra).map((id) => [id, { id, ...(frameworkOf[id] ? { framework: frameworkOf[id] } : {}) }])),
    versionOf: async (project) => versions[project] ?? null,
    async runAction ({ project, actionId, args }) {
      calls.actions.push([project, actionId, args])
      calls.order.push(`action:${project}`)
      if (project === failAction) return { id: `op-${calls.actions.length}`, status: 'failed', exitCode: 3 }
      versions[project] = args.includes('--minor') ? '0.5.0' : '0.5.0-1'
      return { id: `op-${calls.actions.length}`, status: 'completed', exitCode: 0 }
    }
  }
  return { supervisor, issues, readRun, resolve, infrastructureOf: async (project) => infra[project], calls, seams, maxPerHost: () => maxPerHost }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  try {
    t.section('2. the stage rule: staging is a stage unless declared verified through its instances')
    {
      t.eq('no infrastructure', stageOf('p', null).verifiedThrough, 'instances')
      t.eq('declared', stageOf('p', { staging: environment('stage', 'h', { fullVerification: 'instances' }) }).verifiedThrough, 'instances')
      t.eq('a staging environment is a stage on its host', stageOf('p', { staging: environment('stage', 'h') }), { project: 'p', stage: 'stage', host: 'h' })
    }

    t.section('3. a cycle started as a playbook run: freeze, one run per stage, one per host, the record')
    {
      const issuesDir = await temp('devpanel-fv-issues-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir })
      const clock = manualClock(Date.parse('2026-11-07T04:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => BERLIN, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, pollMs: 1000, log: { warn () {} } })
      const wrapping = { project: 'app-project', issueId: 'verification-2026-11-07-cycle', runId: 'run-fv-1' }
      await startCycleByHand(fv, { by: 'tester', trigger: 'deliveries', run: wrapping })
      t.eq('admission closes for the day\'s first cycle', w.calls.freezes, ['2026-11-07.1'])
      const record = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.state === 'ended' ? r : null }, 'the cycle to end')
      t.eq('the record names its entrance and the run it belongs to, with no schedule', [record.id, record.trigger, record.run, record.schedule ?? null], ['2026-11-07.1', 'deliveries', wrapping, null])
      t.eq('one Deployment run per stage that could start, in environment staging, as the full verification', w.calls.starts.map((s) => [s.project, s.playbookId, s.issueId, s.runOptions, s.cycle, s.expectConfigHash]).sort(), [
        ['app-project', 'deployment', 'verification-2026-11-07', { environment: 'staging', fullVerification: true }, '2026-11-07.1', 'hash-app-project'],
        ['shop-project', 'deployment', 'verification-2026-11-07', { environment: 'staging', fullVerification: true }, '2026-11-07.1', 'hash-shop-project']
      ])
      t.eq('never two runs on one staging host at once', w.maxPerHost(), 1)
      const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
      t.eq('no infrastructure: verified through its instances, no run', [by['tool-project'].verifiedThrough, by['tool-project'].runId], ['instances', undefined])
      t.eq('a declared framework: verified through its instances, no run', [by['framework-project'].verifiedThrough, by['framework-project'].stage, by['framework-project'].runId], ['instances', 'stage', undefined])
      t.eq('a stage without a release target is a red refusal, not stageless', [by['lib-project'].verdict, by['lib-project'].refusal?.code, by['lib-project'].runId], ['red', 'TARGET_MISSING', undefined])
      t.eq('each run with its verdict', [by['app-project'].verdict, by['shop-project'].verdict], ['green', 'green'])
      t.ok('and its timing', ['startedAt', 'endedAt'].every((k) => typeof by['app-project'][k] === 'string') && Number.isInteger(by['app-project'].durationMs))
      t.eq('and the drive a later cycle compares with', [by['app-project'].check.gating, by['app-project'].check.dir, by['app-project'].runDir], ['passed', 'checks/full-verification', path.join(issuesDir, 'app-project', '.verification-2026-11-07', 'runs', 'run-app-project')])
      t.eq('the cycle is red when a stage is', record.verdict, 'red')
      t.ok('it froze, found the seats idle, ran and ended in order', record.frozenAt <= record.seatsIdleAt && record.seatsIdleAt <= record.startedAt && record.startedAt <= record.endedAt)
      t.eq('admission opened again', w.calls.thaws, ['2026-11-07.1'])
      t.eq('red: no checkpoint ran', w.calls.actions, [])
      t.eq('one issue for the red project, named for the cycle\'s date, project and stage', w.calls.issues.map((i) => [i.project, i.input.split('\n')[0]]), [['lib-project', '# Full verification 2026-11-07: lib-project red on stage']])
      t.eq('the record lists it', record.outcome.issues.map((i) => [i.project, i.issueId, i.name]), [['lib-project', 'issue-1', 'Full verification 2026-11-07: lib-project red on stage']])
      t.ok('the issue says why: the refusal', w.calls.issues[0].input.includes('TARGET_MISSING'))
      t.eq('the issue was opened before admission reopened', w.calls.order, ['issue:lib-project', 'thaw'])

      t.section('4. "Full verification now": the same freeze, runs and record, the earlier cycle kept')
      // The record says 'ended' before the cycle's promise lets go of the slot: wait for the cycle itself.
      await fv.settle()
      const hand = await startCycleByHand(fv, { by: 'tester' })
      t.eq('a hand start returns the frozen record', [hand.id, hand.trigger, hand.by, hand.state, typeof hand.run?.runId], ['2026-11-07.2', 'hand', 'tester', 'frozen', 'string'])
      const second = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.id === '2026-11-07.2' && r.state === 'ended' ? r : null }, 'the hand cycle')
      t.eq('the same freeze', w.calls.freezes, ['2026-11-07.1', '2026-11-07.2'])
      t.eq('the same runs', w.calls.starts.filter((s) => s.cycle === '2026-11-07.2').length, 2)
      t.eq('the same record shape', second.projects.map((p) => p.project).sort(), record.projects.map((p) => p.project).sort())
      t.eq('a later cycle of the date opens its own issue, named with its id', [w.calls.issues.length, w.calls.issues[1].input.split('\n')[0], w.calls.issues[1].openedBy.from.cycle], [2, '# Full verification 2026-11-07.2: lib-project red on stage', '2026-11-07.2'])
      t.eq('the first cycle of the day is kept beside it', (await readJson(path.join(verificationDir, '2026-11-07', 'cycle.1.json'))).id, '2026-11-07.1')
      fv.stop()
    }

    t.section('5. the cycle starts only when no seat turn is running, and resumes what it paused')
    {
      const issuesDir = await temp('devpanel-fv-wait-')
      const verificationDir = path.join(issuesDir, '.verification')
      const paused = [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen' }, { project: 'app-project', issueId: '2026-11-01-held', runId: 'r-held', manualPending: true }]
      const w = world({ issuesDir, busy: [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen', phase: 'run' }], paused })
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, pollMs: 1000, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      const waiting = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.waitingOn?.length ? r : null }, 'the wait to be recorded')
      t.eq('frozen and waiting on the live run, with nothing started', [waiting.state, waiting.waitingOn.map((b) => b.runId), w.calls.starts.length], ['frozen', ['r-frozen'], 0])
      let refused = null
      try { await startCycleByHand(fv) } catch (error) { refused = error.code }
      t.eq('a second cycle is refused while one runs', refused, 'FULL_VERIFICATION_RUNNING')
      clock.advance(1000)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('still busy: still nothing started', w.calls.starts.length, 0)
      w.supervisor.busyList = []
      clock.advance(1000)
      const ended = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.state === 'ended' ? r : null }, 'the cycle to end')
      t.ok('runs started once the seats were idle', w.calls.starts.length === 2 && Boolean(ended.seatsIdleAt))
      t.eq('the run the freeze paused is resumed, by the cycle', w.calls.resumes, [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen', actor: 'service', origin: 'full-verification' }])
      t.eq('a run with an operator pause pending stays paused for that operator', [ended.resumed.map((r) => r.runId), ended.heldForOperator.map((r) => r.runId)], [['r-frozen'], ['r-held']])
      t.eq('a start without a time zone records no schedule and uses UTC dates', [ended.schedule ?? null, ended.timeZone], [null, 'UTC'])
    }

    t.section('5b. the end of a cycle is announced once it is no longer active, whatever its announcement did')
    {
      const issuesDir = await temp('devpanel-fv-settle-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir })
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const order = []
      let lastEmit = null
      const emit = (event) => { order.push({ at: 'emit' }); lastEmit = event }
      const onEnded = async () => { order.push({ at: 'announce-rejected' }); throw new Error('the supervisor is away') }
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, pollMs: 1000, emit, onEnded, log: { warn () {} } })
      const started = await startCycleByHand(fv, { by: 'tester' })
      await fv.settle()
      const rejectedAt = order.findIndex((o) => o.at === 'announce-rejected')
      const lastAt = order.map((o) => o.at).lastIndexOf('emit')
      t.ok('the announcement was attempted and rejected', rejectedAt >= 0)
      t.ok('an event follows the rejected announcement', lastAt > rejectedAt, JSON.stringify(order))
      t.eq('it is the existing verification:changed, for that cycle', [lastEmit.type, lastEmit.id], ['verification:changed', started.id])
      t.eq('and a refresh it triggers reads the cycle inactive', (await fv.latest()).active, false)
    }
    {
      const issuesDir = await temp('devpanel-fv-failstart-')
      const w = world({ issuesDir })
      const events = []
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: { ...w.supervisor, freeze: async () => { throw new Error('freeze refused') } }, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir: path.join(issuesDir, '.verification'), resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, emit: (e) => events.push(e), log: { warn () {} } })
      let failed = null
      try { await startCycleByHand(fv, { by: 'tester' }) } catch (error) { failed = error.message }
      t.eq('a start that failed after taking an id says so with an event, and is not active', [failed, events.length, events[0]?.type, (await fv.latest()).active], ['freeze refused', 1, 'verification:changed', false])
    }
    {
      // AC2: the newest cycle record exists but cannot be read; latest() fails rather than publish an older cycle.
      const issuesDir = await temp('devpanel-fv-unreadable-')
      const w = world({ issuesDir })
      const verificationDir = path.join(issuesDir, '.verification')
      await fs.mkdir(path.join(verificationDir, '2026-11-06'), { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-06', 'cycle.json'), JSON.stringify({ id: '2026-11-06.1', state: 'ended' }))
      await fs.mkdir(path.join(verificationDir, '2026-11-07', 'cycle.json'), { recursive: true })   // reading it fails (EISDIR)
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
      const unreadable = await fv.latest().then(() => null, (error) => error)
      t.eq('an unreadable newest cycle is a 503 naming its date, never the older cycle', [unreadable?.status, /2026-11-07/.test(unreadable?.message ?? '')], [503, true])
      await fs.rm(path.join(verificationDir, '2026-11-07'), { recursive: true })
      await fs.mkdir(path.join(verificationDir, '2026-11-07'))
      t.eq('a date with no cycle record yet is passed over (nothing unreadable)', (await fv.latest()).cycle?.id, '2026-11-06.1')
      const listing = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir: path.join(verificationDir, '2026-11-06', 'cycle.json'), resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
      t.eq('an unlistable verification directory is a 503 too', (await listing.latest().then(() => null, (error) => error))?.status, 503)
    }

    t.section('6. AC4, AC5: no cycle without its run; no daily time; afterDeliveries 0 starts nothing on its own')
    {
      const issuesDir = await temp('devpanel-fv-off-')
      const w = world({ issuesDir })
      const clock = manualClock(Date.parse('2026-11-07T04:00:00.000Z'))
      const warnings = []
      const entered = []
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => BERLIN, afterDeliveries: () => 0, deliveryPollMs: 60 * 60 * 1000, verificationDir: path.join(issuesDir, '.verification'), resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn: (m) => warnings.push(m), info () {} } })
      let refused = null
      try { await fv.startForRun({ by: 'tester', trigger: 'hand' }) } catch (error) { refused = error.code }
      t.eq('a start that names no Full verification run is refused, nothing frozen', [refused, w.calls.freezes.length], ['FULL_VERIFICATION_NEEDS_RUN', 0])
      t.eq('the old hand start is gone', typeof fv.startNow, 'undefined')
      fv.setEntrance({ start: async (o) => { entered.push(o); return { run: { project: 'app-project', issueId: 'verification-2026-11-07-cycle', runId: 'r' } } }, busy: () => false })
      fv.start()
      t.ok('a daily time in the settings is said to start nothing', warnings.some((m) => /fullVerification\.at/.test(m)), JSON.stringify(warnings))
      for (let i = 0; i < 49; i++) clock.advance(60 * 60 * 1000)
      await new Promise((resolve) => setTimeout(resolve, 20))
      await fv.deliveryCheck()
      t.eq('two days past 06:00 local twice, with afterDeliveries 0: no cycle, no entrance asked', [w.calls.freezes.length, entered.length], [0, 0])
      t.eq('latest() says the engine starts nothing itself, and carries no schedule', [(await fv.latest()).afterDeliveries, (await fv.latest()).schedule], [0, undefined])
      t.eq('the zone still dates records', localDate(clock.now(), 'Europe/Berlin'), '2026-11-09')
      fv.stop()
    }

    t.section('7. a cycle the service left unfinished is marked interrupted at the next start')
    {
      const issuesDir = await temp('devpanel-fv-recover-')
      const verificationDir = path.join(issuesDir, '.verification')
      await fs.mkdir(path.join(verificationDir, '2026-11-06'), { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-06', 'cycle.json'), JSON.stringify({ id: '2026-11-06.1', date: '2026-11-06', state: 'running', projects: [] }))
      const paused = [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen' }]
      const w = world({ issuesDir, paused })
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T08:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
      const recovered = await fv.recover()
      const record = await readJson(path.join(verificationDir, '2026-11-06', 'cycle.json'))
      t.eq('interrupted, with an end', [record.state, typeof record.endedAt], ['interrupted', 'string'])
      t.eq('the runs its freeze paused are resumed', recovered.resumed.map((r) => r.runId), ['r-frozen'])
    }

    t.section('8. a run home is not an issue: no issue folder, lists unchanged, getIssue 404')
    {
      const issuesDir = await temp('devpanel-fv-home-')
      const before = process.env.DEVPANEL_ISSUES_DIR
      process.env.DEVPANEL_ISSUES_DIR = issuesDir
      try {
        const issues = await import(`../server/issues.js?full-verification=${Date.now()}`)
        const issue = await issues.createIssue('devpanel-project', { name: 'An ordinary issue' })
        const listed = (await issues.listIssues('devpanel-project')).map((i) => i.id)
        const entries = (await fs.readdir(path.join(issuesDir, 'devpanel-project'))).filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n))
        const home = await issues.ensureRunHome('devpanel-project', '2026-11-07', '# Full verification\n')
        t.eq('the home is issues/<project>/.verification-<date>, id verification-<date>', [home.id, home.path, home.kind], ['verification-2026-11-07', path.join(issuesDir, 'devpanel-project', '.verification-2026-11-07'), 'verification'])
        t.eq('its parent is the project\'s issue folder', path.dirname(home.path), path.join(issuesDir, 'devpanel-project'))
        t.eq('the issue list is unchanged', (await issues.listIssues('devpanel-project')).map((i) => i.id), listed)
        t.eq('and its archive tab', (await issues.listIssues('devpanel-project', { archived: true })).length, 0)
        t.eq('no issue folder was created', (await fs.readdir(path.join(issuesDir, 'devpanel-project'))).filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n)), entries)
        let status = null
        try { await issues.getIssue('devpanel-project', home.id) } catch (error) { status = error.status }
        t.eq('getIssue does not know it', status, 404)
        t.eq('the run routes do', (await issues.getRunHolder('devpanel-project', home.id)).path, home.path)
        t.eq('an issue still reads as one', (await issues.getRunHolder('devpanel-project', issue.id)).id, issue.id)
        const step = await issues.createStep('devpanel-project', home.id, { name: 'turn', response: 'answered' })
        t.ok('its runs take steps', Boolean(step?.number))
        t.eq('listed as a run home', (await issues.listRunHomes('devpanel-project')).map((h) => h.id), ['verification-2026-11-07'])
        t.eq('the task report is written once', await fs.readFile(path.join(home.path, '000-report', 'response.md'), 'utf8'), '# Full verification\n')

        // The cycle home (entrance-started Full verification runs): beside the Deployment home of the same date, never an issue.
        const cycleHome = await issues.ensureCycleHome('devpanel-project', '2026-11-07', '# Full verification runs\n')
        t.eq('the cycle home is issues/<project>/.verification-<date>-cycle, kind verification-cycle', [cycleHome.id, cycleHome.path, cycleHome.kind, cycleHome.home], ['verification-2026-11-07-cycle', path.join(issuesDir, 'devpanel-project', '.verification-2026-11-07-cycle'), 'verification-cycle', true])
        t.eq('getRunHolder reads it', (await issues.getRunHolder('devpanel-project', cycleHome.id)).path, cycleHome.path)
        let cycleStatus = null
        try { await issues.getIssue('devpanel-project', cycleHome.id) } catch (error) { cycleStatus = error.status }
        t.eq('getIssue does not know it either', cycleStatus, 404)
        t.eq('listCycleHomes lists it', (await issues.listCycleHomes('devpanel-project')).map((h) => h.id), ['verification-2026-11-07-cycle'])
        t.eq('listRunHomes (coverage, deliveries, release selection) leaves it out', (await issues.listRunHomes('devpanel-project')).map((h) => h.id), ['verification-2026-11-07'])
        t.eq('the issue list is still unchanged', (await issues.listIssues('devpanel-project')).map((i) => i.id), listed)
        t.ok('its runs take steps too', Boolean((await issues.createStep('devpanel-project', cycleHome.id, { name: 'turn', response: 'answered' }))?.number))
      } finally {
        if (before === undefined) delete process.env.DEVPANEL_ISSUES_DIR
        else process.env.DEVPANEL_ISSUES_DIR = before
      }
    }

    t.section('9. one red entry makes the cycle red, a project whose infrastructure cannot be read included')
    for (const [label, projects, expected] of [['an invalid project alone', ['bad-project'], 'red'], ['an invalid project beside a green stage', ['bad-project', 'app-project'], 'red'], ['a green stage alone', ['app-project'], 'green']]) {
      const issuesDir = await temp('devpanel-fv-verdict-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir })
      w.issues.listProjects = async () => projects.map((id) => ({ id }))
      const infrastructureOf = async (project) => { if (project === 'bad-project') throw new Error('projects/bad-project.yaml: /infrastructure must have required property staging'); return w.infrastructureOf(project) }
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      const record = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.state === 'ended' ? r : null }, 'the cycle to end')
      t.eq(`${label}: the cycle is ${expected}`, [record.verdict, record.projects.find((p) => p.project === 'bad-project')?.refusal?.code ?? null], [expected, projects.includes('bad-project') ? 'INFRASTRUCTURE_INVALID' : null])
    }

    t.section('10. a run of an earlier cycle is frozen and waited for like any other, and cannot continue during the freeze')
    {
      const dir = await temp('devpanel-fv-supervisor-')
      // A run of the 2026-11-05 cycle, paused, whose continuation would be asked for during today's freeze.
      const oldHome = path.join(dir, '.verification-2026-11-05')
      await fs.mkdir(path.join(oldHome, 'runs', 'old-paused'), { recursive: true })
      await fs.writeFile(path.join(oldHome, 'runs', 'old-paused', 'run.json'), JSON.stringify({ runId: 'old-paused', status: 'paused', fullVerification: { cycleId: '2026-11-05.1' } }))
      const issues = {
        getRunHolder: async (project, id) => ({ id, project, path: oldHome, home: true, packed: false }),
        getIssue: async () => { throw Object.assign(new Error('no such issue'), { status: 404 }) },
        listIssues: async () => [],
        listProjects: async () => []
      }
      const supervisor = createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir })
      const asked = []
      const engineOf = (status) => ({ run: { status }, requestFreeze (cycleId) { asked.push(cycleId); return null } })
      supervisor.active.set('app-project/verification-2026-11-06', { runId: 'old-running', issuePath: path.join(dir, '.verification-2026-11-06'), project: 'app-project', issueId: 'verification-2026-11-06', phase: 'run', engine: engineOf('running'), home: true, cycleId: '2026-11-06.1' })
      supervisor.active.set('app-project/verification-2026-11-07', { runId: 'today', issuePath: path.join(dir, '.verification-2026-11-07'), project: 'app-project', issueId: 'verification-2026-11-07', phase: 'run', engine: engineOf('running'), home: true, cycleId: '2026-11-07.1' })
      const frozen = await supervisor.freeze('2026-11-07.1')
      t.eq('the earlier cycle\'s run is asked to stop, the cycle\'s own is not', [frozen.map((r) => r.runId), asked], [['old-running'], ['2026-11-07.1']])
      t.eq('the cycle waits for it', supervisor.busy().map((r) => r.runId), ['old-running'])
      let refused = null
      try { await supervisor.resume({ project: 'app-project', issueId: 'verification-2026-11-05', runId: 'old-paused', actor: 'operator', origin: 'panel' }) } catch (error) { refused = error.code ?? error.message }
      t.eq('its continuation is refused while frozen', refused, 'FULL_VERIFICATION_FREEZE')
      supervisor.thaw('2026-11-07.1')
      supervisor.active.clear()
    }

    t.section('11. a run of an earlier cycle that this cycle froze is resumed when it ends, unless an operator pause was pending')
    {
      const issuesDir = await temp('devpanel-fv-old-home-')
      const verificationDir = path.join(issuesDir, '.verification')
      const paused = [{ project: 'app-project', issueId: 'verification-2026-11-05', runId: 'old-frozen' }, { project: 'shop-project', issueId: 'verification-2026-11-05', runId: 'old-held', manualPending: true }]
      const w = world({ issuesDir, paused })
      // Run homes are not issues: only listRunHomes names them.
      w.issues.listIssues = async () => []
      w.issues.listRunHomes = async (project) => paused.filter((p) => p.project === project).map((p) => ({ id: p.issueId, path: `/fixture/${project}/.${p.issueId}`, home: true, latestRun: { runId: p.runId, status: 'paused' } }))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      const record = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.state === 'ended' ? r : null }, 'the cycle to end')
      t.eq('the earlier cycle\'s frozen run is resumed by the cycle', w.calls.resumes, [{ project: 'app-project', issueId: 'verification-2026-11-05', runId: 'old-frozen', actor: 'service', origin: 'full-verification' }])
      t.eq('and recorded; the one with an operator pause pending is held for the operator', [record.resumed.map((r) => r.runId), record.heldForOperator.map((r) => r.runId), record.refused], [['old-frozen'], ['old-held'], []])
    }

    // The outcome (part 4): the framework and the instances naming it, with a fake checkpoint action.
    const pool = ['framework-project', 'app-project', 'shop-project']
    const instances = { 'app-project': 'framework-project', 'shop-project': 'framework-project' }
    const cycleOf = async (w, extra = {}, { projects = pool } = {}) => {
      const issuesDir = w.issuesDir
      const verificationDir = path.join(issuesDir, '.verification')
      w.issues.listProjects = async () => projects.map((id) => ({ id }))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} }, ...extra })
      const run = async () => {
        const started = await startCycleByHand(fv, { by: 'tester' })
        await fv.settle()
        return readJson(path.join(verificationDir, started.date, 'cycle.json'))
      }
      return { fv, run }
    }
    const worldIn = async (prefix, options = {}) => { const issuesDir = await temp(prefix); return { ...world({ issuesDir, ...options }), issuesDir } }

    t.section('12. green: the framework\'s checkpoint with --minor, then each instance\'s, in order; versions recorded')
    {
      const w = await worldIn('devpanel-fv-green-', { frameworkOf: instances })
      const record = await (await cycleOf(w)).run()
      t.eq('every stage green', record.verdict, 'green')
      t.eq('the fake checkpoint ran on the framework with --minor, then the instances by id', w.calls.actions, [['framework-project', 'checkpoint', ['--minor']], ['app-project', 'checkpoint', []], ['shop-project', 'checkpoint', []]])
      t.eq('each step is recorded with its versions before and after', record.outcome.bump.chain.map((s) => [s.project, s.args, s.status, s.operationId, s.versionBefore, s.versionAfter]), [
        ['framework-project', ['--minor'], 'completed', 'op-1', '0.4.12', '0.5.0'],
        ['app-project', [], 'completed', 'op-2', '0.4.12-3', '0.5.0-1'],
        ['shop-project', [], 'completed', 'op-3', '0.4.12-7', '0.5.0-1']
      ])
      t.eq('the resulting versions', record.outcome.bump.versions, { 'framework-project': '0.5.0', 'app-project': '0.5.0-1', 'shop-project': '0.5.0-1' })
      t.eq('nothing failed and nothing was left', [record.outcome.bump.failed, record.outcome.bump.notRun], [null, []])
      t.eq('green opens no issue', w.calls.createIssue, 0)
      t.eq('admission reopened after the last action', w.calls.order, ['action:framework-project', 'action:app-project', 'action:shop-project', 'thaw'])
      t.eq('the cycle ended', record.state, 'ended')

      const none = await worldIn('devpanel-fv-green-none-')
      const alone = await (await cycleOf(none)).run()
      t.eq('green with no framework declared: nothing runs, and the record says why', [alone.verdict, none.calls.actions, alone.outcome.bump.chain, /no project names a framework/.test(alone.outcome.bump.reason)], ['green', [], [], true])
    }

    t.section('13. a failed action mid-chain stops the chain; the failure is recorded and admission still reopens')
    {
      const w = await worldIn('devpanel-fv-chain-', { frameworkOf: instances, failAction: 'app-project' })
      const record = await (await cycleOf(w)).run()
      t.eq('the framework ran, the failing instance ran, the next did not', w.calls.actions.map((a) => a[0]), ['framework-project', 'app-project'])
      t.eq('the failure is recorded', [record.outcome.bump.failed?.project, record.outcome.bump.chain.at(-1).status, record.outcome.bump.chain.at(-1).exitCode], ['app-project', 'failed', 3])
      t.ok('with its reason', /exit code 3/.test(record.outcome.bump.failed?.reason ?? ''))
      t.eq('what did not run is listed', record.outcome.bump.notRun, [{ project: 'shop-project', framework: 'framework-project', args: [] }])
      t.eq('only completed steps have a resulting version', record.outcome.bump.versions, { 'framework-project': '0.5.0' })
      t.eq('admission reopened after it', [w.calls.order.at(-1), record.state], ['thaw', 'ended'])
    }

    t.section('14. red: no bump; one issue per red project with its failing test, log excerpt and run; a later red cycle opens its own')
    {
      const failed = { result: { result: 'failed', dir: 'checks/full-verification', commands: [{ id: 'selftest', passed: false, exitCode: 1, log: 'selftest.log', stderr: '1 failing' }] },
        gating: 'failed', failures: { verdict: 'new-failures', newFailures: [{ command: 'selftest', test: 'cart/checkout total' }] } }
      const log = '$ run selftest\n\nok cart/add\nok cart/remove\nFAIL cart/checkout total: expected 3, got 4\n    at total (cart.mjs:12)\n\n--- exit 1 ---\n'
      const w = await worldIn('devpanel-fv-red-', { frameworkOf: instances, checks: { 'shop-project': failed }, files: { 'shop-project': { 'selftest.log': log } } })
      const { fv, run } = await cycleOf(w)
      const record = await run()
      t.eq('the cycle is red and no checkpoint ran', [record.verdict, w.calls.actions], ['red', []])
      t.eq('one issue, for the red project only', w.calls.issues.map((i) => i.project), ['shop-project'])
      const issue = w.calls.issues[0]
      t.eq('named Full verification <date>: <project> red on <stage>', issue.input.split('\n')[0], '# Full verification 2026-11-07: shop-project red on stage')
      t.eq('opened by the engine from the cycle and its run', issue.openedBy, { user: 'engine', from: { project: 'shop-project', runId: 'run-shop-project', via: 'full-verification', cycle: '2026-11-07.1' } })
      t.ok('it holds the run id', issue.input.includes('`run-shop-project`'))
      t.ok('the failing test', issue.input.includes('`selftest: cart/checkout total` (new)'))
      t.ok('and its log excerpt', issue.input.includes('FAIL cart/checkout total: expected 3, got 4') && issue.input.includes('_From the log._'))
      t.eq('the complete list is attached to the report step', w.calls.attachments.map((a) => [a.project, a.id, a.number, a.name]), [['shop-project', 'issue-1', '000', 'failing-tests.md']])
      t.ok('with the same test and excerpt', w.calls.attachments[0].text.includes('cart/checkout total') && w.calls.attachments[0].text.includes('expected 3, got 4'))
      t.eq('the record lists the issue', record.outcome.issues, [{ project: 'shop-project', stage: 'stage', name: 'Full verification 2026-11-07: shop-project red on stage', runId: 'run-shop-project', issueId: 'issue-1', failingCount: 1, attachments: ['failing-tests.md'] }])
      t.eq('the failing tests are on the cycle entry too', record.projects.find((p) => p.project === 'shop-project').check.failingTests, [{ command: 'selftest', test: 'cart/checkout total', basis: 'new' }])
      t.eq('admission reopened after the issue was opened', w.calls.order, ['issue:shop-project', 'thaw'])

      const second = await run()
      t.eq('a later red cycle that date opens a separate issue', [second.id, w.calls.issues.length], ['2026-11-07.2', 2])
      const again = w.calls.issues[1]
      t.eq('named with its cycle id', again.input.split('\n')[0], '# Full verification 2026-11-07.2: shop-project red on stage')
      // The id an issue takes is a slug of its name's beginning: the two cycles' issues of one long-named project must not share it.
      const long = (id) => slugify(`Full verification ${id}: a-long-named-shop.example-project red on its-stage`)
      t.ok('and so under another issue id than the first cycle\'s, however long the project\'s name', long('2026-11-07') !== long('2026-11-07.2'))
      t.eq('with its own cycle and run', [again.openedBy.from.cycle, again.openedBy.from.runId], ['2026-11-07.2', 'run-shop-project-2'])
      t.ok('and its own evidence', again.input.includes('`run-shop-project-2`') && again.input.includes('expected 3, got 4'))
      t.eq('the first issue was neither reused nor rewritten', [w.calls.issues[0].input, w.calls.attachments.length], [issue.input, 2])
      fv.stop()
    }

    t.section('15. red with a selftest comparison not made: the unjudged failures are listed with their report excerpts')
    {
      const notMade = { result: { result: 'passed', dir: 'checks/full-verification', commands: [{ id: 'collect', passed: true, exitCode: 0 }] }, gating: 'failed',
        selftest: { verdict: 'not-made', reason: 'collect: no baseline of this source revision could be captured', newFailures: [], unjudged: [{ command: 'collect', test: 'mod/a' }] } }
      const stdout = 'summary\n== /opt/app/selftest.report\n[{"test":"mod/ok"},{"test":"mod/a","error":"boom: mod/a broke","stack":"at a (mod/a.mjs:1)"}]\n'
      const w = await worldIn('devpanel-fv-unjudged-', { frameworkOf: instances, checks: { 'shop-project': notMade }, files: { 'shop-project': { 'collect.stdout': stdout } } })
      const record = await (await cycleOf(w)).run()
      t.eq('red, no bump', [record.verdict, w.calls.actions], ['red', []])
      const issue = w.calls.issues[0]
      t.ok('the unjudged test is listed with its basis', issue.input.includes('`collect: mod/a` (unjudged)'))
      t.ok('with the error and stack from its report entry', issue.input.includes('boom: mod/a broke') && issue.input.includes('at a (mod/a.mjs:1)') && issue.input.includes('_From the selftest report._'))
      t.ok('and why the comparison was not made', issue.input.includes('not-made (collect: no baseline of this source revision could be captured)'))
      t.eq('one failing test counted', record.outcome.issues[0].failingCount, 1)
    }

    t.section('15b. red with no baseline for a failed command: the failures its output names, not only the command')
    {
      // compareFailures without a base: not-made, nothing named (baseline-failures.mjs). The log names the failure early, then 60 passes.
      const passes = Array.from({ length: 60 }, (_, i) => `ok cart/case ${i + 1}`).join('\n')
      const log = `$ run selftest\n\nFAIL cart/checkout: expected 3, got 4\n    at checkout (cart.mjs:40)\n${passes}\n--- exit 1 in 12 ms ---\n`
      const noBase = { result: { result: 'failed', dir: 'checks/full-verification', commands: [{ id: 'selftest', run: 'run selftest', required: true, passed: false, exitCode: 1, log: 'selftest.log', stderr: '' }] },
        gating: 'failed', failures: { verdict: 'not-made', reason: 'no baseline of this source revision', newFailures: [] } }
      const w = await worldIn('devpanel-fv-nobase-', { frameworkOf: instances, checks: { 'shop-project': noBase }, files: { 'shop-project': { 'selftest.log': log } } })
      const record = await (await cycleOf(w)).run()
      t.eq('red, no bump', [record.verdict, w.calls.actions], ['red', []])
      t.eq('the failing test is named from the command\'s own output', record.projects.find((p) => p.project === 'shop-project').check.failingTests, [{ command: 'selftest', test: 'cart/checkout', basis: 'unjudged', message: 'expected 3, got 4' }])
      const issue = w.calls.issues[0]
      t.ok('the issue body names it', issue.input.includes('`selftest: cart/checkout` (unjudged)'))
      t.ok('with its diagnostic line from the log', issue.input.includes('FAIL cart/checkout: expected 3, got 4') && issue.input.includes('at checkout (cart.mjs:40)'))
      t.ok('not as a bare whole-command entry', !issue.input.includes('`selftest: (command)`'))
      const attached = w.calls.attachments[0]?.text ?? ''
      t.ok('the attachment holds the same evidence', attached.includes('`selftest: cart/checkout` (unjudged)') && attached.includes('FAIL cart/checkout: expected 3, got 4'))

      // Against a passing previous green drive compareFailures names the whole command (baseline-failures.mjs
      // whole(): 'passes on the base'; likewise a timeout or a differing exit code): the names still come first.
      for (const reason of ['passes on the base', 'exit 1 here, 2 on the base']) {
        const passing = { ...noBase, failures: { verdict: 'new-failures', reason: '1 failure does not occur on the base', newFailures: [{ command: 'selftest', test: '(command)', message: reason }] } }
        const pw = await worldIn('devpanel-fv-passbase-', { frameworkOf: instances, checks: { 'shop-project': passing }, files: { 'shop-project': { 'selftest.log': log } } })
        const pr = await (await cycleOf(pw)).run()
        t.eq(`whole-command "${reason}": the named failure replaces it, the reason kept as context`, pr.projects.find((p) => p.project === 'shop-project').check.failingTests, [{ command: 'selftest', test: 'cart/checkout', basis: 'new', message: 'expected 3, got 4', context: reason }])
        const body = pw.calls.issues[0].input
        const file = pw.calls.attachments[0]?.text ?? ''
        t.ok('… the body has the name, the FAIL line and the reason', body.includes('`selftest: cart/checkout` (new)') && body.includes('FAIL cart/checkout: expected 3, got 4') && body.includes(reason))
        t.ok('… so has failing-tests.md, and neither has a lone (command)', file.includes('`selftest: cart/checkout` (new)') && file.includes('FAIL cart/checkout: expected 3, got 4') && !body.includes('`selftest: (command)`') && !file.includes('`selftest: (command)`'))
      }
      const wholeOnly = { ...noBase, failures: { verdict: 'new-failures', newFailures: [{ command: 'selftest', test: '(command)', message: 'passes on the base' }] } }
      const ww = await worldIn('devpanel-fv-passbase-silent-', { frameworkOf: instances, checks: { 'shop-project': wholeOnly }, files: { 'shop-project': { 'selftest.log': `$ run selftest\n\nsomething broke\n--- exit 1 in 3 ms ---\n` } } })
      const wr = await (await cycleOf(ww)).run()
      t.eq('against a passing base, an output naming no failure keeps the whole-command entry', wr.projects.find((p) => p.project === 'shop-project').check.failingTests, [{ command: 'selftest', test: '(command)', basis: 'new', message: 'passes on the base' }])

      const silent = await worldIn('devpanel-fv-nobase-silent-', { frameworkOf: instances, checks: { 'shop-project': noBase }, files: { 'shop-project': { 'selftest.log': `$ run selftest\n\nsomething broke\n--- exit 1 in 3 ms ---\n` } } })
      const silentRecord = await (await cycleOf(silent)).run()
      t.eq('an output that names no failure still falls back to the whole command', silentRecord.projects.find((p) => p.project === 'shop-project').check.failingTests.map((f) => [f.test, f.basis]), [['(command)', 'command']])
    }

    t.section('16. more failing tests than the issue body shows: every one, with its excerpt, is in the attachment')
    {
      const tests = Array.from({ length: 35 }, (_, i) => `mod/t${i + 1}`)
      const many = { result: { result: 'passed', dir: 'checks/full-verification', commands: [{ id: 'collect', passed: true, exitCode: 0 }] }, gating: 'failed',
        selftest: { verdict: 'not-made', reason: 'no baseline', newFailures: [], unjudged: tests.map((test) => ({ command: 'collect', test })) } }
      const stdout = `== /opt/app/selftest.report\n${JSON.stringify(tests.map((test, i) => ({ test, error: `err-${i + 1}` })))}\n`
      const options = { frameworkOf: instances, checks: { 'shop-project': many }, files: { 'shop-project': { 'collect.stdout': stdout } } }
      const w = await worldIn('devpanel-fv-many-', options)
      const record = await (await cycleOf(w)).run()
      const body = w.calls.issues[0].input
      t.eq('the body shows the first 30', (body.match(/^### `collect: mod\/t\d+`/gm) ?? []).length, 30)
      t.ok('and names the attachment holding all 35', body.includes('All 35 failing tests with their excerpts: `failing-tests.md` on the report step (000).'))
      const attached = w.calls.attachments.map((a) => a.name)
      const text = w.calls.attachments.map((a) => a.text).join('\n')
      t.eq('one attachment on the report step', [attached, w.calls.attachments[0].number], [['failing-tests.md'], '000'])
      t.ok('it names every failing test', tests.every((test) => text.includes(`\`collect: ${test}\` (unjudged)`)))
      t.ok('with every excerpt', tests.every((_, i) => text.includes(`\nerr-${i + 1}\n`)))
      t.eq('the record counts them and names the attachment', [record.outcome.issues[0].failingCount, record.outcome.issues[0].attachments], [35, ['failing-tests.md']])

      const split = await worldIn('devpanel-fv-split-', options)
      const limit = 1500
      const splitRecord = await (await cycleOf(split, { maxAttachmentBytes: limit })).run()
      const parts = split.calls.attachments
      t.ok('over the attachment limit the list is split into parts', parts.length > 1 && parts.every((p, i) => p.name === `failing-tests-${i + 1}.md`))
      t.ok('each part within the limit', parts.every((p) => Buffer.byteLength(p.text) <= limit), parts.map((p) => Buffer.byteLength(p.text)))
      const joined = parts.map((p) => p.text).join('\n')
      t.ok('together the parts hold every test and excerpt', tests.every((test, i) => joined.includes(`\`collect: ${test}\` (unjudged)`) && joined.includes(`\nerr-${i + 1}\n`)))
      t.eq('the body and the record name every part', [parts.every((p) => split.calls.issues[0].input.includes(`\`${p.name}\``)), splitRecord.outcome.issues[0].attachments], [true, parts.map((p) => p.name)])
    }

    t.section('17. a release-mode drive proves its deliveries only when every required command answered on its own and its report parsed')
    {
      const dir = 'checks/full-verification'
      const report = '== /opt/app/runtime/selftest.report\n{"tests":[{"test":"a: works"}]}\n'
      const recordOf = async (check, files = {}) => {
        const w = await worldIn('devpanel-fv-release-ran-', { checks: { 'app-project': check }, files: { 'app-project': files } })
        return (await (await cycleOf(w, {}, { projects: ['app-project'] })).run()).projects[0]
      }
      const timedOut = await recordOf({ result: { result: 'failed', dir, commands: [{ id: 'build', required: true, passed: true, exitCode: 0 }, { id: 'selftest', required: true, passed: false, exitCode: 124, timedOut: true }] }, gating: 'failed', selftest: { reports: [{ command: 'selftest', verdict: 'not-applicable' }] } }, { 'selftest.stdout': report })
      t.eq('the last suite command timed out (nothing skipped): no coverage established', [timedOut.check.result, timedOut.check.skipped, timedOut.suiteRan, timedOut.coverageEstablished], ['failed', undefined, null, false])
      const unparsed = await recordOf({ result: { result: 'passed', dir, commands: [{ id: 'selftest', required: true, passed: true, exitCode: 0 }] }, gating: 'passed', selftest: { reports: [{ command: 'selftest', verdict: 'none' }] } }, { 'selftest.stdout': 'no report\n' })
      t.eq('every command passed but the declared report does not parse: none either', [unparsed.suiteRan, unparsed.coverageEstablished], [null, false])
      const ran = await recordOf({ result: { result: 'failed', dir, commands: [{ id: 'selftest', required: true, passed: false, exitCode: 1 }] }, gating: 'failed', selftest: { reports: [{ command: 'selftest', verdict: 'not-applicable' }] } }, { 'selftest.stdout': report })
      t.eq('the suite failed its own tests and its report parsed: established', [ran.suiteRan?.report?.command, ran.coverageEstablished], ['selftest', true])
    }

    t.section('18. the scope: projects with staging and their whole module pools, decided before the freeze and passed to it')
    {
      const stage = (host) => ({ staging: environment('stage', host), release: { targets: { stage: {} } } })
      const infras = new Map([['site-project', stage('h')], ['fw-project', null], ['sibling-project', null], ['lonely-project', null], ['tool-project', null], ['broken-project', { error: 'invalid' }]])
      const config = new Map([
        ['site-project', { id: 'site-project', framework: 'fw-project' }],
        ['fw-project', { id: 'fw-project' }],
        ['sibling-project', { id: 'sibling-project', framework: 'fw-project' }],
        ['lonely-project', { id: 'lonely-project', infrastructure: { testDrive: { modules: { collections: ['@*'] } } } }],
        ['tool-project', { id: 'tool-project' }]
      ])
      t.eq('a staged instance brings its framework (through poolIdOf) and its unstaged sibling; a project with modules but no staging, one without infrastructure and an invalid one stay out', cycleScope({ infras, config }), ['fw-project', 'sibling-project', 'site-project'])
      t.eq('a framework named by a staged instance is in scope even when its own configuration is missing', cycleScope({ infras: new Map([['site-project', stage('h')]]), config: new Map([['site-project', { id: 'site-project', framework: 'gone-project' }]]) }), ['gone-project', 'site-project'])
      t.eq('without pools known, only the staged projects', cycleScope({ infras, config: null }), ['site-project'])
      const w = await worldIn('devpanel-fv-scope-', { frameworkOf: instances })
      const record = await (await cycleOf(w, {}, { projects: [...pool, 'tool-project'] })).run()
      t.eq('the freeze is given the scope, and the record keeps it; the project without infrastructure is not in it', [w.calls.scopes, record.scope.projects], [[['app-project', 'framework-project', 'shop-project']], ['app-project', 'framework-project', 'shop-project']])
    }

    t.section('19. the supervisor\'s freeze holds only its scope: an out-of-scope run is never asked, waited for or refused, and an operator pause still pauses it')
    {
      const dir = await temp('devpanel-fv-scoped-supervisor-')
      const pausedPath = path.join(dir, 'paused')
      await fs.mkdir(path.join(pausedPath, 'runs', 'p-run'), { recursive: true })
      await fs.writeFile(path.join(pausedPath, 'runs', 'p-run', 'run.json'), JSON.stringify({ runId: 'p-run', status: 'paused' }))
      const issues = {
        getRunHolder: async (project, id) => ({ id, project, path: pausedPath, packed: false }),
        getIssue: async () => { throw Object.assign(new Error('no such issue'), { status: 404 }) },
        listIssues: async () => [],
        listProjects: async () => []
      }
      const supervisor = createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir })
      const asked = []
      const engineOf = (name) => ({ run: { status: 'running' }, requestFreeze (cycleId) { asked.push(['freeze', name]); return null }, async requestPause () { asked.push(['pause', name]) } })
      supervisor.active.set('app-project/in', { runId: 'in-run', issuePath: path.join(dir, 'in'), project: 'app-project', issueId: 'in', phase: 'run', engine: engineOf('app'), writes: true, stopping: false })
      supervisor.active.set('devpanel-project/out', { runId: 'out-run', issuePath: path.join(dir, 'out'), project: 'devpanel-project', issueId: 'out', phase: 'run', engine: engineOf('devpanel'), writes: true, stopping: false })
      const frozen = await supervisor.freeze('2026-11-07.5', { projects: ['app-project', 'framework-project'] })
      t.eq('only the scope\'s writing run is asked to stop', [frozen.map((r) => r.runId), asked], [['in-run'], [['freeze', 'app']]])
      t.eq('the cycle waits only for it', supervisor.busy().map((r) => r.runId), ['in-run'])
      await supervisor.pause({ project: 'devpanel-project', issueId: 'out', runId: 'out-run' })
      await supervisor.pause({ project: 'app-project', issueId: 'in', runId: 'in-run' })
      t.eq('an operator pause reaches both runs as an operator pause; the out-of-scope one is never asked to freeze', asked, [['freeze', 'app'], ['pause', 'devpanel'], ['pause', 'app']])
      supervisor.active.clear()
      const codeOf = (promise) => promise.then(() => 'ran', (error) => error.code ?? error.message)
      const outResume = await codeOf(supervisor.resume({ project: 'devpanel-project', issueId: 'paused', runId: 'p-run', actor: 'operator', origin: 'panel' }))
      t.ok('a continuation outside the scope is not refused for the cycle (it fails later, on this fixture, for its own reason)', outResume !== 'FULL_VERIFICATION_FREEZE', outResume)
      t.eq('the same continuation inside the scope is refused as before', await codeOf(supervisor.resume({ project: 'app-project', issueId: 'paused', runId: 'p-run', actor: 'operator', origin: 'panel' })), 'FULL_VERIFICATION_FREEZE')
      const outFinalize = await codeOf(supervisor.finalize({ project: 'devpanel-project', issueId: 'paused', runId: 'p-run' }))
      t.ok('a finalize outside the scope is not refused for the cycle', outFinalize !== 'FULL_VERIFICATION_FREEZE', outFinalize)
      t.eq('one inside it is', await codeOf(supervisor.finalize({ project: 'app-project', issueId: 'paused', runId: 'p-run' })), 'FULL_VERIFICATION_FREEZE')
      supervisor.thaw('2026-11-07.5')
      t.eq('after the thaw the freeze holds nothing', supervisor.frozen(), null)
    }

    t.section('20. the end of a cycle resumes only its scope\'s pauses; one of a project outside it is named and left to recovery')
    {
      const paused = [{ project: 'app-project', issueId: 'issue-in', runId: 'r-in' }, { project: 'tool-project', issueId: 'issue-out', runId: 'r-out' }]
      const w = await worldIn('devpanel-fv-scoped-thaw-', { paused })
      const { fv, run } = await cycleOf(w, {}, { projects: ['app-project', 'shop-project', 'tool-project'] })
      const record = await run()
      t.eq('the scope\'s pause is resumed; the out-of-scope one is not', w.calls.resumes.map((r) => r.runId), ['r-in'])
      t.eq('and is named in leftPaused', record.leftPaused.map((r) => [r.project, r.runId, r.reason]), [['tool-project', 'r-out', 'outside this cycle\'s scope']])
      const recovered = await fv.recover()
      t.eq('recovery at the next start resumes every full-verification pause, that one included', recovered.resumed.map((r) => r.runId), ['r-in', 'r-out'])
    }

    t.section('21. the checkpoint chain covers only the pools the cycle verified: a pool with no staged member never reaches the action')
    {
      const w = await worldIn('devpanel-fv-unverified-pool-', { frameworkOf: instances })
      const projectsConfig = async () => new Map([...pool.map((id) => [id, { id, ...(instances[id] ? { framework: instances[id] } : {}) }]), ['fw2-project', { id: 'fw2-project' }], ['inst2-project', { id: 'inst2-project', framework: 'fw2-project' }]])
      const record = await (await cycleOf(w, { projectsConfig }, { projects: [...pool, 'fw2-project', 'inst2-project'] })).run()
      t.eq('green, and the staged pool is checkpointed as before', [record.verdict, w.calls.actions.map((a) => a[0])], ['green', ['framework-project', 'app-project', 'shop-project']])
      t.eq('the unstaged pool is named, never run', [record.outcome.bump.notVerified.map((n) => [n.framework, n.members]), record.outcome.bump.chain.some((s) => s.framework === 'fw2-project')], [[['fw2-project', ['fw2-project', 'inst2-project']]], false])
    }

    // The inputs a cycle reads, built from the world's own seams: `override` replaces a project's infrastructure.
    const inputsOf = async (w, projects, override = {}, extra = {}) => {
      const infras = new Map()
      for (const id of projects) infras.set(id, Object.hasOwn(override, id) ? override[id] : await w.infrastructureOf(id))
      return { projects, infras, config: await w.seams.projectsConfig(), unreadable: [], ...extra }
    }

    t.section('22. stages come from the reading the scope was decided from: a project that gains staging after the freeze gets no stage')
    {
      const w = await worldIn('devpanel-fv-drift-')
      const projects = ['app-project', 'shop-project', 'tool-project']
      let reads = 0
      // Every reading after the first (the release guard's) shows tool-project with a staging environment.
      const cycleInputs = async () => (++reads === 1 ? inputsOf(w, projects) : inputsOf(w, projects, { 'tool-project': { staging: environment('stage', 'ssh-config:stage-z') } }))
      const record = await (await cycleOf(w, { cycleInputs }, { projects })).run()
      t.ok('the configuration was read again after the freeze', reads > 1, String(reads))
      t.eq('tool-project stays verified through its instances, outside the scope, with no run', [record.projects.find((p) => p.project === 'tool-project').verifiedThrough, record.scope.projects.includes('tool-project'), w.calls.starts.some((s) => s.project === 'tool-project')], ['instances', false, false])
    }

    t.section('23. a release starts only on the target the freeze decided, after a complete fresh reading shows its host unprotected')
    {
      const projects = ['app-project', 'shop-project']
      const caseOf = async (label, { fresh = null, resolveOf = null, resolveHost = null } = {}) => {
        const w = await worldIn(`devpanel-fv-guard-${label}-`)
        let reads = 0
        const cycleInputs = async () => (++reads === 1 ? inputsOf(w, projects) : (fresh ? fresh(w) : inputsOf(w, projects)))
        const resolve = resolveOf ? (id, options) => resolveOf(w, id, options) : w.resolve
        const record = await (await cycleOf(w, { cycleInputs, resolve, ...(resolveHost ? { resolveHost } : {}) }, { projects })).run()
        const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
        return { w, record, by, codes: projects.map((p) => by[p].refusal?.code ?? by[p].verdict), started: w.calls.starts.map((s) => s.project) }
      }
      const plain = await caseOf('plain')
      t.eq('unchanged plain release stages start and finish green (no false drift)', [plain.codes, plain.started, plain.record.verdict], [['green', 'green'], ['app-project', 'shop-project'], 'green'])
      const drifted = await caseOf('drift', { resolveOf: async (w, id, options) => { const r = await w.resolve(id, options); return options.projectId === 'shop-project' ? { ...r, resolved: { ...r.resolved, infrastructure: { staging: environment('stage', 'ssh-config:stage-z') } } } : r } })
      t.eq('a stage whose resolved target moved since the freeze is refused STAGE_DRIFTED and never started; the other starts', [drifted.codes, drifted.started], [['green', 'STAGE_DRIFTED'], ['app-project']])
      // G4: each stage host is resolved once and pinned at the freeze; a release whose host resolves elsewhere when it would start is refused.
      let resolutions = 0
      const moved = await caseOf('moved', { resolveHost: async (ssh) => ({ host: ++resolutions === 1 ? 'stage-a.pinned' : 'stage-a.elsewhere', pinned: null }) })
      t.eq('G4 a release whose host moved since the freeze is refused STAGE_HOST_MOVED and never started', [moved.codes, moved.started, moved.record.scope.hosts], [['STAGE_HOST_MOVED', 'STAGE_HOST_MOVED'], [], [{ hostRef: 'ssh-config:stage-a', host: 'stage-a.pinned' }]])
      const unresolvable = await caseOf('unresolved', { resolveHost: async () => { throw new Error('no such host') } })
      t.eq('G4 a stage whose host cannot be resolved at the freeze is refused STAGE_HOST_UNRESOLVED', [unresolvable.codes, unresolvable.started], [['STAGE_HOST_UNRESOLVED', 'STAGE_HOST_UNRESOLVED'], []])
      const unreadable = await caseOf('unreadable', { fresh: (w) => inputsOf(w, projects, {}, { unreadable: [{ path: '/host-config/projects', code: 'EACCES' }] }) })
      t.eq('a fresh reading with something unreadable declines every release', [unreadable.codes, unreadable.started], [['STAGE_UNVERIFIABLE', 'STAGE_UNVERIFIABLE'], []])
      const broken = await caseOf('broken', { fresh: (w) => inputsOf(w, [...projects, 'peer-project'], { 'peer-project': { error: 'invalid file' } }) })
      t.ok('a peer whose configuration is invalid declines them too, named', broken.codes.every((c) => c === 'STAGE_UNVERIFIABLE') && /peer-project/.test(broken.by['app-project'].refusal.message) && broken.started.length === 0, JSON.stringify(broken.codes))
      const thrown = await caseOf('thrown', { fresh: async () => { throw new Error('load failed') } })
      t.eq('a fresh reading that throws declines them', [thrown.codes, thrown.started], [['STAGE_UNVERIFIABLE', 'STAGE_UNVERIFIABLE'], []])
      const instanceInfra = { staging: environment('stage', 'ssh-config:stage-a'), testDrive: { modules: { instance: { create: { run: 'x' } } } } }
      const protectedNow = await caseOf('protected', { fresh: (w) => inputsOf(w, [...projects, 'peer-project'], { 'peer-project': instanceInfra }) })
      t.eq('a host a peer now declares dynamic instances on is refused HOST_HAS_INSTANCES', [protectedNow.codes, protectedNow.started], [['HOST_HAS_INSTANCES', 'HOST_HAS_INSTANCES'], []])
    }

    t.section('24. the production reading: an unreadable root, project, marker or host-config directory refuses the cycle before anything is frozen')
    {
      const dir = await temp('devpanel-fv-unreadable-')
      const probe = path.join(dir, 'probe')
      await fs.mkdir(probe)
      await fs.chmod(probe, 0o000)
      const blocked = await fs.readdir(probe).then(() => false, () => true)
      await fs.chmod(probe, 0o755)
      if (!blocked) t.skip('chmod 000 does not stop a read here (running as root): the unreadable cases cannot be made')
      else {
        // A discovery root with one project the process cannot enter: the listing drops it silently, the reading names it.
        const root = path.join(dir, 'root')
        await fs.mkdir(path.join(root, 'shop', '.git'), { recursive: true })
        await fs.mkdir(path.join(root, 'locked', '.git'), { recursive: true })
        const discovery = { pattern: '*', markers: ['.git'] }
        await fs.chmod(path.join(root, 'locked'), 0o000)
        try {
          t.eq('the cached discovery leaves the unreadable project out without a word (the old fallback)', [...discoveredProjects(root, discovery).keys()], ['shop-project'])
          const read = await readProjectDirs(root, discovery)
          t.eq('readProjectDirs lists what it found and names the marker it could not read', [read.projects.map((p) => p.id), read.unreadable.map((u) => [path.relative(root, u.path), u.code])], [['shop-project'], [['locked/.git', 'EACCES']]])
        } finally { await fs.chmod(path.join(root, 'locked'), 0o755) }
        const plainRoot = path.join(dir, 'plain')
        await fs.mkdir(path.join(plainRoot, 'a-project'), { recursive: true })
        await fs.chmod(plainRoot, 0o000)
        try {
          t.eq('an unreadable root lists as empty, as always', await listProjectDirs(plainRoot), [])
          t.eq('and readProjectDirs names it', (await readProjectDirs(plainRoot, null)).unreadable.map((u) => [u.path, u.code]), [[plainRoot, 'EACCES']])
        } finally { await fs.chmod(plainRoot, 0o755) }
        // A data root holding host-config that the process cannot traverse, and no host-config in the config root.
        const configRoot = path.join(dir, 'config')
        await fs.mkdir(configRoot)
        const dataRoot = path.join(dir, 'data')
        await fs.mkdir(path.join(dataRoot, 'host-config', 'projects'), { recursive: true })
        const env = { DEVPANEL_DATA_ROOT: dataRoot }
        await fs.chmod(dataRoot, 0o000)
        try {
          t.eq('hostConfigDir falls back to the in-tree directory without a word (the old fallback)', hostConfigDir({ root: configRoot, env }), path.join(configRoot, 'host-config'))
          t.eq('hostConfigSelection names the data root\'s host-config it could not stat', hostConfigSelection({ root: configRoot, env }).unreadable.map((u) => [u.path, u.code]), [[path.join(dataRoot, 'host-config'), 'EACCES']])
          // Through the production path: createFullVerification without injected readers.
          const w = world({ issuesDir: await temp('devpanel-fv-unreadable-issues-') })
          const verificationDir = path.join(w.issues.ISSUES_DIR, '.verification')
          const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, readRun: w.readRun, configRoot, projectsDir: plainRoot, discovery: null, env, log: { warn () {} } })
          let refused = null
          try { await startCycleByHand(fv, { by: 'tester' }) } catch (error) { refused = error }
          t.eq('the cycle is refused 503 FULL_VERIFICATION_SCOPE_UNREADABLE naming the directory', [refused?.status, refused?.code, refused?.unreadable?.map((u) => u.path)], [503, 'FULL_VERIFICATION_SCOPE_UNREADABLE', [path.join(dataRoot, 'host-config')]])
          t.eq('nothing was frozen and no record written', [w.calls.freezes, await fs.readdir(verificationDir).catch(() => [])], [[], []])
        } finally { await fs.chmod(dataRoot, 0o755) }
        // An absent data root is not unreadable.
        t.eq('a data root that does not exist reports nothing', hostConfigSelection({ root: configRoot, env: { DEVPANEL_DATA_ROOT: path.join(dir, 'nowhere') } }).unreadable, [])
      }
    }

    t.section('25. one configuration load at freeze time: staging and pool membership agree even when the files change right after it')
    {
      const dir = await temp('devpanel-fv-one-load-')
      const projectsDir = path.join(dir, 'projects-root')
      for (const id of ['site-project', 'fw-project']) await fs.mkdir(path.join(projectsDir, id), { recursive: true })
      const site = { id: 'site-project', framework: 'fw-project', infrastructure: { staging: environment('stage', 'h'), release: { targets: { stage: {} } } } }
      const loads = []
      // The loader as the cycle sees it; right after the first load the site leaves staging and the pool.
      const load = async ({ hostDir }) => {
        loads.push(hostDir)
        const projects = new Map(loads.length === 1 ? [['site-project', site], ['fw-project', { id: 'fw-project' }]] : [['site-project', { id: 'site-project' }], ['fw-project', { id: 'fw-project' }]])
        return { projects, errors: [], unreadable: [] }
      }
      const first = await readCycleConfig({ root: dir, projectsDir, discovery: null, env: {}, load })
      t.eq('loaded once; the scope reads staging and the framework from that one load', [loads.length, cycleScope(first)], [1, ['fw-project', 'site-project']])
      const second = await readCycleConfig({ root: dir, projectsDir, discovery: null, env: {}, load })
      t.eq('a later reading sees neither, consistently', [loads.length, cycleScope(second)], [2, []])
    }

    t.section('26. a pool with no stage the cycle drives is not in the scope and never checkpointed: its unstaged subscriber is not frozen')
    {
      const instancesOnly = { staging: environment('stage', 'ssh-config:stage-c', { fullVerification: 'instances' }) }
      t.eq('an instances-only framework and its unstaged subscriber stay out; the unrelated staged project is in', cycleScope({
        infras: new Map([['fw-project', instancesOnly], ['sub-project', null], ['shop-project', { staging: environment('stage', 'h'), release: { targets: { stage: {} } } }]]),
        config: new Map([['fw-project', { id: 'fw-project' }], ['sub-project', { id: 'sub-project', framework: 'fw-project' }], ['shop-project', { id: 'shop-project' }]])
      }), ['shop-project'])
      const w = await worldIn('devpanel-fv-undriven-pool-')
      const projectsConfig = async () => new Map([['framework-project', { id: 'framework-project' }], ['sub-project', { id: 'sub-project', framework: 'framework-project' }], ['shop-project', { id: 'shop-project' }]])
      const record = await (await cycleOf(w, { projectsConfig }, { projects: ['framework-project', 'sub-project', 'shop-project'] })).run()
      t.eq('the freeze holds only the driven project', [w.calls.scopes, record.scope.projects], [[['shop-project']], ['shop-project']])
      t.eq('green on the unrelated stage, and the undriven pool never reaches the checkpoint', [record.verdict, w.calls.actions, record.outcome.bump.notVerified?.map((n) => n.framework)], ['green', [], ['framework-project']])
    }

    t.section('27. a file where the projects root or the projects category belongs is unreadable (ENOTDIR), not an empty listing; a file in place of a host-config candidate is passed over as before')
    {
      const dir = await temp('devpanel-fv-enotdir-')
      const file = path.join(dir, 'not-a-directory')
      await fs.writeFile(file, 'x')
      t.eq('a regular file as the projects root: readProjectDirs names it ENOTDIR', (await readProjectDirs(file, null)).unreadable.map((u) => [u.path, u.code]), [[file, 'ENOTDIR']])
      t.eq('a regular file as a discovery root: the walk names it ENOTDIR', (await readProjectDirs(file, { pattern: '*', markers: ['.git'] })).unreadable.map((u) => [u.path, u.code]), [[file, 'ENOTDIR']])
      const files = await overlay({ tree: path.join(dir, 'missing'), host: file, match: (n) => n.endsWith('.yaml') })
      t.eq('a regular file as the host projects directory: the overlay lists nothing and names it ENOTDIR; a missing in-tree one is simply absent', [files.length, files.unreadable.map((u) => [u.dir, u.code])], [0, [[file, 'ENOTDIR']]])
      const configRoot = path.join(dir, 'config')
      await fs.mkdir(configRoot)
      const dataRoot = path.join(dir, 'data')
      await fs.mkdir(dataRoot)
      await fs.writeFile(path.join(dataRoot, 'host-config'), 'x')
      t.eq('a file named host-config in the data root is not a candidate: nothing reported, the in-tree path chosen', hostConfigSelection({ root: configRoot, env: { DEVPANEL_DATA_ROOT: dataRoot } }), { dir: path.join(configRoot, 'host-config'), unreadable: [] })
      const w = world({ issuesDir: await temp('devpanel-fv-enotdir-issues-') })
      const verificationDir = path.join(w.issues.ISSUES_DIR, '.verification')
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, readRun: w.readRun, configRoot, projectsDir: file, discovery: null, env: {}, log: { warn () {} } })
      let refused = null
      try { await startCycleByHand(fv, { by: 'tester' }) } catch (error) { refused = error }
      t.eq('through the production path the cycle refuses FULL_VERIFICATION_SCOPE_UNREADABLE, nothing frozen', [refused?.code, refused?.unreadable?.map((u) => u.code), w.calls.freezes], ['FULL_VERIFICATION_SCOPE_UNREADABLE', ['ENOTDIR'], []])
    }

    t.section('28. the cycle reads the projects root the issue store and supervisor hold, not a later reading of the setting')
    {
      const dir = await temp('devpanel-fv-root-')
      const storeRoot = path.join(dir, 'store-root')
      await fs.mkdir(path.join(storeRoot, 'a-project'), { recursive: true })
      const laterRoot = path.join(dir, 'later-root')
      await fs.writeFile(laterRoot, 'not a directory')
      const configRoot = path.join(dir, 'config')
      await fs.mkdir(configRoot)
      const w = world({ issuesDir: await temp('devpanel-fv-root-issues-') })
      w.issues.PROJECTS_DIR = storeRoot
      const saved = process.env.DEVPANEL_PROJECTS_DIR
      // The setting now names another (here unusable) root; the issue store still holds storeRoot.
      process.env.DEVPANEL_PROJECTS_DIR = laterRoot
      try {
        const verificationDir = path.join(w.issues.ISSUES_DIR, '.verification')
        const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, readRun: w.readRun, configRoot, discovery: null, env: {}, log: { warn () {} } })
        const started = await startCycleByHand(fv, { by: 'tester' }).catch((error) => ({ refused: error.code ?? error.message }))
        await fv.settle()
        t.ok('the cycle starts from the issue store\'s root, not refused over the later setting', Boolean(started.id), JSON.stringify(started))
        const record = started.id ? await readJson(path.join(verificationDir, started.date, 'cycle.json')) : null
        t.eq('and lists that root\'s projects', record?.projects.map((p) => p.project), ['a-project'])
      } finally {
        if (saved === undefined) delete process.env.DEVPANEL_PROJECTS_DIR
        else process.env.DEVPANEL_PROJECTS_DIR = saved
      }
    }

    t.section('29. a pool whose only stage is refused up front (a release to a host another project protects) is not in the scope: its unstaged writer is not frozen, its pool never checkpointed')
    {
      const peer = (fullSuite) => ({ staging: environment('stage', 'ssh-config:stage-a'), testDrive: { modules: { instance: { create: { run: 'x' }, ...(fullSuite ? { fullSuite: { run: 'y' } } : {}) } } } })
      const config = new Map([['peer-project', { id: 'peer-project' }], ['app-project', { id: 'app-project', framework: 'fw-project' }], ['fw-project', { id: 'fw-project' }], ['writer-project', { id: 'writer-project', framework: 'fw-project' }]])
      const infras = (fullSuite) => new Map([['peer-project', peer(fullSuite)], ['app-project', { staging: environment('stage', 'ssh-config:stage-a') }], ['fw-project', null], ['writer-project', null]])
      t.eq('the release stage on the protected host brings nothing in; the protecting instance project is in', cycleScope({ infras: new Map([...infras(true)].map(([id, i]) => [id, id === 'app-project' ? { ...i, release: { targets: { stage: {} } } } : i])), config }), ['peer-project'])
      t.eq('an instance stage without a full suite is refused up front too: nothing in scope', cycleScope({ infras: infras(false), config }), [])
      const w = await worldIn('devpanel-fv-refused-pool-')
      const projects = ['peer-project', 'app-project', 'fw-project', 'writer-project']
      const record = await (await cycleOf(w, { infrastructureOf: async (id) => infras(false).get(id) ?? null, projectsConfig: async () => config }, { projects })).run()
      t.eq('through the cycle: the freeze holds nobody, the refused stage is red, nothing is checkpointed', [w.calls.scopes, record.projects.find((p) => p.project === 'app-project').refusal?.code, w.calls.actions], [[[]], 'HOST_HAS_INSTANCES', []])
    }

    t.section('30. the protected-host check is the last step before the start: a peer that declares instances on the host during the checkout reading stops the release')
    {
      const w = await worldIn('devpanel-fv-guard-late-')
      const projects = ['app-project', 'shop-project']
      let protectedNow = false
      const peer = { staging: environment('stage', 'ssh-config:stage-a'), testDrive: { modules: { instance: { create: { run: 'x' } } } } }
      const cycleInputs = async () => inputsOf(w, protectedNow ? [...projects, 'peer-project'] : projects, protectedNow ? { 'peer-project': peer } : {})
      // The checkout reading before the start is awaited; the peer's declaration lands while it runs.
      const readMotion = async () => { protectedNow = true; return { checkouts: [] } }
      const record = await (await cycleOf(w, { cycleInputs, readMotion, projectPathOf: async (id) => `/fixture/${id}` }, { projects })).run()
      t.eq('both releases are refused HOST_HAS_INSTANCES and supervisor.start is never called', [record.projects.map((p) => p.refusal?.code ?? p.verdict), w.calls.starts.length], [['HOST_HAS_INSTANCES', 'HOST_HAS_INSTANCES'], 0])
    }

    t.section('31. a release stage with no staging release target (the real loader and resolver) brings nothing into the freeze: the unstaged writer is not frozen, the stage ends TARGET_MISSING, nothing is checkpointed')
    {
      const env = (id) => ({ id, ssh: { hostRef: `ssh-config:${id}.invalid`, workdir: '/tmp' }, projectRoot: '/tmp/fixture', files: {} })
      const configRoot = await sandbox(async (dir) => {
        await fs.mkdir(path.join(dir, 'projects'))
        await fs.writeFile(path.join(dir, 'projects', 'app-project.yaml'), YAML.stringify({ id: 'app-project', framework: 'fw-project', infrastructure: { kind: 'boilerplate', orientation: 'Fixture', staging: env('stage'), deployments: [env('prod')], testDrive: { requirement: 'optional', commands: [{ id: 'noop', run: 'true' }] } } }))
        await fs.writeFile(path.join(dir, 'projects', 'fw-project.yaml'), YAML.stringify({ id: 'fw-project', workspace: { base: 'working-tree' } }))
        await fs.writeFile(path.join(dir, 'projects', 'writer-project.yaml'), YAML.stringify({ id: 'writer-project', framework: 'fw-project' }))
      })
      const projectsDir = await temp('devpanel-fv-no-target-projects-')
      for (const id of ['app-project', 'fw-project', 'writer-project']) await fs.mkdir(path.join(projectsDir, id))
      const inputs = await readCycleConfig({ root: configRoot, projectsDir, discovery: null, env: {} })
      t.eq('the real loader reads the fixture with no invalid project and nothing unreadable', [[...inputs.infras.values()].filter((i) => i?.error), inputs.unreadable], [[], []])
      const resolution = await resolvePlaybook('deployment', { root: configRoot, runOptions: { environment: 'staging' }, projectId: 'app-project' })
      t.ok('the real Deployment resolution reports the missing target', (resolution.resolved?.liveExecution?.blockers ?? resolution.errors ?? []).some((b) => (b.reason ?? b.message) === TARGET_MISSING), JSON.stringify(resolution.resolved?.liveExecution?.blockers ?? resolution.errors))
      t.eq('and the scope from that same reading is empty', cycleScope(inputs), [])
      const w = world({ issuesDir: await temp('devpanel-fv-no-target-issues-'), frameworkOf: {} })
      const verificationDir = path.join(w.issues.ISSUES_DIR, '.verification')
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, readRun: w.readRun, configRoot, projectsDir, discovery: null, env: {}, ...w.seams, projectsConfig: undefined, log: { warn () {} } })
      const started = await startCycleByHand(fv, { by: 'tester' })
      await fv.settle()
      const record = await readJson(path.join(verificationDir, started.date, 'cycle.json'))
      t.eq('through the cycle (real loader and resolver): nobody frozen, the stage refused TARGET_MISSING, no start, no checkpoint', [w.calls.scopes, record.projects.find((p) => p.project === 'app-project').refusal?.code, w.calls.starts.length, w.calls.actions], [[[]], 'TARGET_MISSING', 0, []])
    }

    t.section('32. a stage the frozen reading left out is never started in that cycle: a release target written right after the freeze changes nothing until the next cycle')
    {
      const env = (id) => ({ id, ssh: { hostRef: `ssh-config:${id}.invalid`, workdir: '/tmp' }, projectRoot: '/tmp/fixture', files: {} })
      const target = { workdir: '/tmp', ownership: 'fixture', rollback: 'manual', commands: Object.fromEntries(['inspect', 'checkpoint', 'verifyCheckpoint', 'apply', 'verifyRelease', 'restart', 'observe', 'test', 'restore', 'verifyRestore'].map((id) => [id, { run: 'true', timeoutSeconds: 10 }])) }
      const app = (withTarget) => ({ id: 'app-project', framework: 'fw-project', infrastructure: { kind: 'boilerplate', orientation: 'Fixture', staging: env('stage'), deployments: [env('prod')], testDrive: { requirement: 'optional', commands: [{ id: 'noop', run: 'true' }] }, ...(withTarget ? { release: { targets: { stage: target, prod: target } } } : {}) } })
      const configRoot = await sandbox(async (dir) => {
        await fs.mkdir(path.join(dir, 'projects'))
        await fs.writeFile(path.join(dir, 'projects', 'app-project.yaml'), YAML.stringify(app(false)))
        await fs.writeFile(path.join(dir, 'projects', 'fw-project.yaml'), YAML.stringify({ id: 'fw-project', workspace: { base: 'working-tree' } }))
        await fs.writeFile(path.join(dir, 'projects', 'writer-project.yaml'), YAML.stringify({ id: 'writer-project', framework: 'fw-project' }))
      })
      const projectsDir = await temp('devpanel-fv-late-target-projects-')
      for (const id of ['app-project', 'fw-project', 'writer-project']) await fs.mkdir(path.join(projectsDir, id))
      const dir = await temp('devpanel-fv-late-target-supervisor-')
      const real = createSupervisor({ issues: { getRunHolder: async () => { throw new Error('none') }, getIssue: async () => { throw new Error('none') }, listIssues: async () => [], listProjects: async () => [] }, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir })
      const asked = []
      // The unstaged pool writer, live and writing.
      real.active.set('writer-project/w', { runId: 'writer-run', project: 'writer-project', issueId: 'w', phase: 'run', writes: true, engine: { run: { status: 'running' }, requestFreeze () { asked.push('writer-run'); return null } } })
      let starts = 0
      const supervisor = {
        ...real,
        // The real freeze, then a valid staging release target lands at once.
        async freeze (...args) { const r = await real.freeze(...args); await fs.writeFile(path.join(configRoot, 'projects', 'app-project.yaml'), YAML.stringify(app(true))); return r },
        async start () { starts++; throw new Error('a stage outside the frozen scope reached supervisor.start') }
      }
      const w = world({ issuesDir: await temp('devpanel-fv-late-target-issues-') })
      const verificationDir = path.join(w.issues.ISSUES_DIR, '.verification')
      const actions = []
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, readRun: w.readRun, configRoot, projectsDir, discovery: null, env: {}, versionOf: async () => null, runAction: async (a) => { actions.push(a); return { status: 'completed' } }, log: { warn () {} } })
      const started = await startCycleByHand(fv, { by: 'tester' })
      await fv.settle()
      const record = await readJson(path.join(verificationDir, started.date, 'cycle.json'))
      const entry = record.projects.find((p) => p.project === 'app-project')
      t.eq('the frozen scope is empty and the live writer was never asked to pause', [record.scope.projects, asked], [[], []])
      t.ok('the stage stays refused with the reason the frozen reading gave, though a target exists now', entry.refusal?.code === 'TARGET_MISSING' && /read when the cycle froze/.test(entry.refusal.message), JSON.stringify(entry.refusal))
      t.eq('supervisor.start is never called and nothing is checkpointed', [starts, actions], [0, []])
      const now = await resolvePlaybook('deployment', { root: configRoot, runOptions: { environment: 'staging' }, projectId: 'app-project' })
      t.ok('the late target is real: the Deployment resolution no longer reports TARGET_MISSING', now.ok && !(now.resolved.liveExecution?.blockers ?? []).some((b) => b.reason === TARGET_MISSING), JSON.stringify(now.resolved?.liveExecution?.blockers ?? now.errors))
      real.active.clear()
    }

    // Note 001: whatever the frozen cycle waits for is bounded; at the bound it ends interrupted, not run, and admission opens.
    const pinned = async (ssh) => ({ host: ssh.hostRef.replace(/^ssh-config:/, ''), pinned: null })
    const cycleFile = (verificationDir) => readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null)

    t.section('33. G17 the busy wait is bounded on the injected clock: interrupted, nothing driven or committed, what was in flight named, admission thawed')
    {
      const issuesDir = await temp('devpanel-fv-bound-busy-')
      const verificationDir = path.join(issuesDir, '.verification')
      const stuck = { project: 'app-project', issueId: 'stuck', runId: 'r-stuck', phase: 'run', kind: 'run' }
      const w = world({ issuesDir, busy: [stuck] })
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, resolveHost: pinned, pollMs: 1000, maxWaitMs: 10_000, graceMs: 0, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      await until(async () => (await cycleFile(verificationDir))?.waitingOn?.length, 'the wait to be recorded')
      clock.advance(9_000)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('before the bound it still waits, frozen', [(await cycleFile(verificationDir)).state, w.calls.thaws.length], ['frozen', 0])
      clock.advance(1_500)
      const ended = await until(async () => { const r = await cycleFile(verificationDir); return r?.state === 'interrupted' ? r : null }, 'the cycle to be interrupted')
      t.eq('interrupted at the busy wait, by the configured bound', [ended.interruption?.reason, ended.interruption?.label, ended.verdict], ['wait-bound', 'busy', null])
      t.eq('no stage started, no checkpoint ran, the outcome was skipped', [w.calls.starts.length, w.calls.actions.length, ended.outcome?.skipped, ended.outcome?.interrupted, ended.outcome?.committed], [0, 0, 'interrupted', true, false])
      t.ok('what was still in flight is named, never lifted silently', (ended.interruption?.inFlight ?? []).some((b) => b.runId === 'r-stuck'), JSON.stringify(ended.interruption))
      t.eq('admission thawed once, for this cycle', w.calls.thaws, [ended.id])
    }

    t.section('34. G17 a bound inside the freeze itself ends the cycle the same way')
    {
      const issuesDir = await temp('devpanel-fv-bound-freeze-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir })
      w.supervisor.freeze = function (cycleId) { w.calls.freezes.push(cycleId); this.frozenState = { cycleId }; return new Promise(() => {}) }
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, resolveHost: pinned, pollMs: 1000, maxWaitMs: 5_000, graceMs: 0, log: { warn () {} } })
      const starting = startCycleByHand(fv, { by: 'tester' })
      await until(() => w.calls.freezes.length === 1, 'the freeze to be asked')
      clock.advance(5_001)
      await starting
      const ended = await until(async () => { const r = await cycleFile(verificationDir); return r?.state === 'interrupted' ? r : null }, 'the cycle to be interrupted')
      t.eq('interrupted inside the freeze, nothing driven, admission thawed', [ended.interruption?.label, w.calls.starts.length, w.calls.thaws.length, w.supervisor.frozen()], ['freeze', 0, 1, null])
    }

    t.section('38. a stage run that registers after the bound, inside the grace: asked to stop, its entry interrupted (not refused); the cycle interrupted with its reason, thawed, its scope\'s pause resumed, nothing checkpointed')
    {
      const issuesDir = await temp('devpanel-fv-bound-late-start-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir, paused: [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen' }] })
      let release = null
      const pending = new Promise((resolve) => { release = resolve })
      const stops = []
      w.supervisor.start = async (args) => { w.calls.starts.push(args); await pending; return { runId: 'r-late', status: 'preflighting' } }
      w.supervisor.stop = async (args) => { stops.push(args) }
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, resolveHost: pinned, pollMs: 1000, maxWaitMs: 5_000, graceMs: 30_000, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      await until(() => w.calls.starts.length === 1, 'the stage start to be asked')
      clock.advance(5_001)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('in the grace: still frozen, nobody asked to stop yet (the run has no id)', [w.calls.thaws.length, stops.length], [0, 0])
      release()
      await until(() => stops.length === 1, 'the late run to be asked to stop')
      t.eq('the run registered after the bound is asked to stop', stops, [{ project: 'app-project', issueId: 'verification-2026-11-07', runId: 'r-late' }])
      const ended = await until(async () => { clock.advance(1_000); const r = await cycleFile(verificationDir); return r?.state === 'interrupted' ? r : null }, 'the cycle to be interrupted')
      const app = ended.projects.find((e) => e.project === 'app-project')
      t.eq('interrupted by the bound on that stage, with its reason, no verdict', [ended.interruption?.reason, ended.interruption?.label, ended.verdict], ['wait-bound', 'stage app-project', null])
      t.eq('its entry reads interrupted, as the stage recorded it, not refused', [app.state, app.verdict, app.refusal ?? null, /registered/.test(app.interrupted?.reason ?? '')], ['interrupted', null, null, true])
      t.eq('the next stage on that host never started', [w.calls.starts.length, ended.projects.find((e) => e.project === 'shop-project').state], [1, 'not-run'])
      t.eq('thawed once; its scope\'s pause resumed; nothing checkpointed', [w.calls.thaws, w.calls.resumes.map((r) => r.runId), w.calls.actions.length], [[ended.id], ['r-frozen'], 0])
    }

    t.section('39. resumes that stall after the thaw hold nothing: the end is recorded and announced at their bound, a new cycle starts, and the old one never resumes a run under the new freeze')
    {
      const issuesDir = await temp('devpanel-fv-bound-resume-')
      const verificationDir = path.join(issuesDir, '.verification')
      const stuck = { project: 'app-project', issueId: 'stuck', runId: 'r-stuck', phase: 'run', kind: 'run' }
      const w = world({ issuesDir, busy: [stuck], paused: [{ project: 'app-project', issueId: 'p1', runId: 'r-p1' }, { project: 'app-project', issueId: 'p2', runId: 'r-p2' }] })
      let release = null
      const stalled = new Promise((resolve) => { release = resolve })
      w.supervisor.resume = async function (args) { w.calls.resumes.push(args); if (w.calls.resumes.length === 1) await stalled; return { status: 'pending' } }
      const told = []
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, resolveHost: pinned, pollMs: 1000, maxWaitMs: 10_000, graceMs: 0, resumeMs: 3_000, onEnded: (n) => { told.push(n) }, log: { warn () {} } })
      const a = await startCycleByHand(fv, { by: 'tester' })
      await until(async () => (await cycleFile(verificationDir))?.waitingOn?.length, 'the wait to be recorded')
      clock.advance(10_500)
      await until(() => w.calls.resumes.length === 1, 'the first resume to be asked')
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('while that resume stalls, the end is neither recorded nor announced', [(await cycleFile(verificationDir)).state, told.length], ['resuming', 0])
      clock.advance(3_001)
      const ended = await until(async () => { const r = await cycleFile(verificationDir); return r?.state === 'interrupted' && told.length ? r : null }, 'the end to be recorded and announced')
      t.eq('the end names the resume still pending at the bound', [ended.resume?.timedOut, ended.resume?.boundSeconds, ended.resume?.pending?.runId], [true, 3, 'r-p1'])
      t.eq('and is announced as interrupted', [told.length, told[0].cycleId, told[0].state], [1, a.id, 'interrupted'])
      w.supervisor.busyList = []
      const b = await startCycleByHand(fv, { by: 'tester' })
      t.ok('a new cycle starts, not refused as running', b.id && b.id !== a.id, JSON.stringify(b.id))
      release()
      const older = path.join(verificationDir, a.date, 'cycle.1.json')
      const late = await until(async () => { const r = await readJson(older).catch(() => null); return r?.leftPaused?.some((x) => x.runId === 'r-p2') ? r : null }, 'the late resume to be recorded in the older cycle\'s own file')
      t.eq('the older cycle resumed only what it began before the new one started; the rest is left paused, named', [late.id, late.resumed.map((x) => x.runId), late.leftPaused.find((x) => x.runId === 'r-p2').reason], [a.id, ['r-p1'], 'a newer cycle started before this one finished resuming'])
      t.eq('the late write landed in the older cycle\'s file, never over the new cycle\'s', (await cycleFile(verificationDir)).id, b.id)
      await fv.settle()
    }

    t.section('35. G15 the cycle starts sooner: a contained run in seat turns is not waited for; another run\'s drive in flight on its host is, and the record says so')
    {
      const dir = await temp('devpanel-fv-sooner-')
      const real = createSupervisor({ issues: { getRunHolder: async () => { throw new Error('none') }, getIssue: async () => { throw new Error('none') }, listIssues: async () => [], listProjects: async () => [] }, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir, seatFencePolicy: () => ({ mode: 'fence' }) })
      const asked = []
      // A contained writing run of a verified project, taking seat turns: confined (namespace 1, a proved fence), its own worktree.
      const snapshot = { tactic: 'implementation', workspace: { isolation: 'worktree', symlinks: 'reject' }, fence: { namespace: 1 }, delivery: { action: 'apply-to-source' } }
      real.active.set('app-project/contained', { runId: 'r-contained', project: 'app-project', issueId: 'contained', phase: 'run', writes: true, engine: { snapshot, run: { status: 'running', workspace: { path: path.join(dir, 'wt') } }, requestFreeze () { asked.push('r-contained'); return null } } })
      // An out-of-scope run's drive already in flight on the cycle's host (original AC5: no other run's drive).
      const drive = real.gates.gateFor({ project: 'elsewhere-project', runId: 'r-drive', writes: true, whole: false }).tryDrive('stage-a').ticket
      const issuesDir = await temp('devpanel-fv-sooner-issues-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir })
      const fake = w.supervisor
      const supervisor = { ...fake, freeze: (...a) => { fake.calls = true; return real.freeze(...a) }, thaw: (id) => { real.thaw(id); return fake.thaw.call(fake, id) }, frozen: () => real.frozen(), busy: () => real.busy(), busyActions: () => real.busyActions(), releaseIdle: () => [] }
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ resolveHost: fakeResolve, supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, resolveHost: pinned, snapshottedOf: async () => ({ repositories: [path.join(dir, 'source', '.git')], worktrees: [path.join(dir, 'source')], unknown: false }), pollMs: 1000, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      const waiting = await until(async () => { const r = await cycleFile(verificationDir); return r?.waitingOn?.length ? r : null }, 'the wait to be recorded')
      t.eq('the contained run is neither asked to pause nor waited for', [asked, waiting.asked.map((a) => a.runId)], [[], []])
      t.eq('the cycle waits only for the drive on its host, of a run outside its scope', waiting.waitingOn.map((b) => [b.kind, b.runId, b.host]), [['drive', 'r-drive', 'stage-a']])
      drive.release()
      // Advanced until the cycle ends, never once: the poll it needs may be scheduled only after the record write settles.
      let ended = null
      for (let i = 0; i < 200 && !ended; i++) {
        clock.advance(1000)
        await new Promise((resolve) => setTimeout(resolve, 10))
        const r = await cycleFile(verificationDir)
        if (r?.state === 'ended') ended = r
      }
      t.eq('once it ended the cycle went on; the record says what it waited for and for how long', [ended.waited?.for, ended.waited?.ms >= 1000, w.calls.starts.length > 0], [['drive'], true, true])
      t.eq('the contained run never paused for the cycle', asked, [])
      real.active.clear()
    }

    t.section('37. only hosts the cycle drives are pinned and frozen: a pool member verified through its instances adds no host')
    {
      const issuesDir = await temp('devpanel-fv-hosts-')
      const w = world({ issuesDir, frameworkOf: { 'app-project': 'framework-project' } })
      w.issues.listProjects = async () => ['framework-project', 'app-project'].map((id) => ({ id }))
      const verificationDir = path.join(issuesDir, '.verification')
      const pinnedRefs = []
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, resolveHost: async (ssh) => { pinnedRefs.push(ssh.hostRef); return pinned(ssh) }, snapshottedOf: async () => ({ repositories: [], worktrees: [] }), log: { warn () {} } })
      const started = await startCycleByHand(fv, { by: 'tester' })
      await fv.settle()
      const record = await readJson(path.join(verificationDir, started.date, 'cycle.json'))
      t.ok('the framework is in the scope (its pool is verified)', record.scope.projects.includes('framework-project'), JSON.stringify(record.scope.projects))
      t.eq('but only the driven stage\'s host is pinned and frozen', [pinnedRefs.includes('ssh-config:stage-c'), record.scope.hosts.map((h) => h.hostRef)], [false, ['ssh-config:stage-a']])
      // A member whose instance stage is refused up front (no full suite) has a host of its own the cycle never drives.
      const refusedRefs = []
      const issuesDir2 = await temp('devpanel-fv-hosts-refused-')
      const w2 = world({ issuesDir: issuesDir2, frameworkOf: { 'app-project': 'framework-project' } })
      w2.issues.listProjects = async () => ['framework-project', 'app-project'].map((id) => ({ id }))
      const infra2 = async (project) => project === 'framework-project' ? { staging: environment('stage', 'ssh-config:stage-x'), testDrive: { modules: { instance: {} } } } : w2.infrastructureOf(project)
      const fv2 = createFullVerification({ supervisor: w2.supervisor, issues: w2.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir: path.join(issuesDir2, '.verification'), resolve: w2.resolve, infrastructureOf: infra2, readRun: w2.readRun, ...w2.seams, resolveHost: async (ssh) => { refusedRefs.push(ssh.hostRef); return pinned(ssh) }, snapshottedOf: async () => ({ repositories: [], worktrees: [] }), log: { warn () {} } })
      const started2 = await startCycleByHand(fv2, { by: 'tester' })
      await fv2.settle()
      const record2 = await readJson(path.join(issuesDir2, '.verification', started2.date, 'cycle.json'))
      t.eq('a refused stage\'s own host is neither pinned nor frozen', [refusedRefs.includes('ssh-config:stage-x'), record2.scope.hosts.map((h) => h.hostRef).includes('ssh-config:stage-x')], [false, false])
    }

    t.section('36. G14 a real apply-to-source delivery that became ready during the cycle is applied only after the cycle\'s checkpoint (green) or after its red end, and is not in the commit')
    for (const verdict of ['green', 'red']) {
      const exec = promisify(execFile)
      // A contained writing run of app-project on the fake harness, delivering apply-to-source into the checkout the cycle snapshots.
      const base = scriptFor()
      let engine = null
      const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async (turn) => {
        if (turn.stepId === 'implement') await fs.writeFile(path.join(engine.run.workspace.path, 'server.mjs'), 'export default 1\n')
        return base(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
      } })
      const src = await fs.realpath(f.projectPath)
      const common = await fs.realpath(path.join(src, '.git'))
      const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'opus-5' } } }
      const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
      engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider: worktreeDiffDelivery, expectConfigHash: resolved.resolved.configHash, runOptions: options })
      const dir = await temp(`devpanel-fv-g14-${verdict}-`)
      const real = createSupervisor({ issues: { getRunHolder: async () => { throw new Error('none') }, getIssue: async () => { throw new Error('none') }, listIssues: async () => [], listProjects: async () => [] }, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir, seatFencePolicy: () => ({ mode: 'fence' }) })
      // The engine's write gate, as the supervisor installs it on a contained run of a verified project.
      engine.cycleGate = real.cycleGateFor({ project: 'app-project', issueId: 'g14', runId: engine.runId, writes: true, whole: false })
      const w = world({ issuesDir: await temp(`devpanel-fv-g14-${verdict}-issues-`), frameworkOf: { 'shop-project': 'app-project' }, ...(verdict === 'red' ? { checks: { 'app-project': { gating: 'failed', result: { result: 'failed', dir: 'checks/full-verification' } } } } : {}) })
      w.issues.listProjects = async () => ['app-project', 'shop-project'].map((id) => ({ id }))
      const order = []
      let releaseStages
      const stagesMayStart = new Promise((resolve) => { releaseStages = resolve })
      const fake = w.supervisor
      const supervisor = { ...fake,
        freeze: (...a) => real.freeze(...a),
        thaw: (id) => { order.push('thaw'); real.thaw(id); return fake.thaw.call(fake, id) },
        frozen: () => real.frozen(), busy: () => real.busy(), busyActions: () => real.busyActions(), releaseIdle: () => [],
        async start (args) { await stagesMayStart; return fake.start(args) } }
      let deliveredAtCheckpoint = null
      const seams = { ...w.seams, async runAction (a) {
        // The checkpoint commits what the checkout holds now.
        order.push(`checkpoint:${a.project}`)
        if (a.project === 'app-project') {
          deliveredAtCheckpoint = await fs.stat(path.join(src, 'server.mjs')).then(() => true, () => false)
          await exec('git', ['-C', src, 'add', '-A'])
          await exec('git', ['-C', src, 'commit', '-qm', 'checkpoint', '--allow-empty'])
        }
        return w.seams.runAction(a)
      } }
      const verificationDir = path.join(w.issues.ISSUES_DIR, '.verification')
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...seams, resolveHost: pinned, snapshottedOf: async () => ({ repositories: [common], worktrees: [src] }), pollMs: 1000, log: { warn () {} } })
      await startCycleByHand(fv, { by: 'tester' })
      // The run's seat turns go on during the cycle; its delivery reaches the write gate and waits there.
      const driving = engine.drive().then(() => order.push('delivered'))
      await until(() => engine.run.cycleWait?.kind === 'write' || ['completed', 'blocked', 'failed'].includes(engine.run.status), 'the delivery to wait for the cycle', 60000)
      t.eq(`${verdict}: the real delivery waits at the gate for this cycle, the checkout untouched`, [engine.run.cycleWait?.action, engine.run.cycleWait?.repositories, await fs.stat(path.join(src, 'server.mjs')).then(() => true, () => false)], ['delivery', [common], false])
      releaseStages()
      for (let i = 0; i < 100 && !order.includes('delivered'); i++) { clock.advance(1000); await new Promise((resolve) => setTimeout(resolve, 30)) }
      await driving
      const ended = await until(async () => { const r = await cycleFile(verificationDir); return ['ended', 'failed'].includes(r?.state) ? r : null }, 'the cycle to end')
      t.eq(`${verdict}: the cycle's verdict, and the run completed after it`, [ended.verdict, engine.run.status], [verdict, 'completed'], engine.run.blockedReason)
      if (verdict === 'green') {
        t.ok('green: the checkpoint ran first, the delivery only after the thaw', order.indexOf('checkpoint:app-project') >= 0 && order.indexOf('checkpoint:app-project') < order.indexOf('thaw') && order.indexOf('thaw') < order.indexOf('delivered'), JSON.stringify(order))
        const committed = (await exec('git', ['-C', src, 'show', '--name-only', '--format=', 'HEAD'])).stdout.split('\n').filter(Boolean)
        t.eq('the checkout did not hold the delivery when the checkpoint committed, and the commit does not either', [deliveredAtCheckpoint, committed.includes('server.mjs')], [false, false])
      } else {
        t.ok('red: no checkpoint ran; the delivery landed after the red end thawed admission', !order.some((o) => o.startsWith('checkpoint:')) && order.indexOf('thaw') < order.indexOf('delivered'), JSON.stringify(order))
        t.eq('nothing was committed', (await exec('git', ['-C', src, 'rev-list', '--count', 'HEAD'])).stdout.trim(), '1')
      }
      t.eq(`${verdict}: the delivery is in the checkout afterwards, uncommitted`, (await exec('git', ['-C', src, 'status', '--porcelain', '--', 'server.mjs'])).stdout.trim(), '?? server.mjs')
      t.eq(`${verdict}: its wait is on the run record, ended by the thaw`, (engine.run.cycleWaits ?? []).map((x) => [x.kind, x.action, x.outcome]), [['write', 'delivery', 'thawed']])
      await releaseWorkspace(engine).catch(() => {})
    }

  } finally {
    await cleanupFixtures()
    for (const d of temps) await fs.rm(d, { recursive: true, force: true })
  }
}
