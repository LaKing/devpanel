import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFullVerification, nextTrigger, localDate, stageOf } from '../server/full-verification.mjs'
import { manualClock } from '../server/runtime/clock.mjs'
import { TARGET_MISSING } from '../server/config/release-plan.mjs'
import { createSupervisor } from '../server/supervisor.mjs'

export const name = 'full verification — the daily schedule on a fake clock, the freeze wait, one run per stage, the record, the hand start'

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

/** The projects a cycle reads, a fake supervisor and issue store, and what they were asked. */
function world ({ busy = [], issuesDir, paused = [] }) {
  const infra = {
    'app-project': { staging: environment('stage', 'ssh-config:stage-a') },
    'shop-project': { staging: environment('stage', 'ssh-config:stage-a') },
    'lib-project': { staging: environment('stage', 'ssh-config:stage-b') },
    'framework-project': { staging: environment('stage', 'ssh-config:stage-c', { fullVerification: 'instances' }) },
    'tool-project': null
  }
  const calls = { freezes: [], thaws: [], starts: [], resumes: [], createIssue: 0, homes: [] }
  const runs = new Map()
  const activeOnHost = new Map()
  let maxPerHost = 0
  const host = (project) => infra[project]?.staging.ssh.hostRef
  const supervisor = {
    busyList: busy,
    frozenState: null,
    async freeze (cycleId) { calls.freezes.push(cycleId); this.frozenState = { cycleId, at: '2026-11-07T05:00:00.000Z' }; return [] },
    thaw (cycleId) { calls.thaws.push(cycleId); this.frozenState = null; return true },
    frozen () { return this.frozenState },
    busy () { return this.busyList },
    isActive: () => false,
    async start (args) {
      calls.starts.push(args)
      const h = host(args.project)
      activeOnHost.set(h, (activeOnHost.get(h) ?? 0) + 1)
      maxPerHost = Math.max(maxPerHost, activeOnHost.get(h))
      const runId = `run-${args.project}`
      runs.set(runId, { host: h, record: { runId, status: 'completed', outcome: 'resolved', endedAt: '2026-11-07T05:30:00.000Z',
        release: { tactic: 'staging', status: 'completed', environment: 'stage' },
        fullVerification: { cycleId: args.cycle, check: { result: { result: 'passed', dir: 'checks/full-verification' }, gating: 'passed', baseline: null, baseCommit: 'abc', files: { 'selftest.stdout': 'f00' } } } } })
      return { runId, status: 'preflighting' }
    },
    async resume (args) { calls.resumes.push(args); return { status: 'pending' } }
  }
  const issues = {
    ISSUES_DIR: issuesDir,
    listProjects: async () => Object.keys(infra).map((id) => ({ id })),
    listIssues: async (project) => paused.filter((p) => p.project === project).map((p) => ({ id: p.issueId, path: `/fixture/${p.issueId}`, latestRun: { runId: p.runId, status: 'paused' } })),
    createIssue: async () => { calls.createIssue++ },
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
  const resolve = async (playbookId, { projectId, runOptions }) => ({ ok: true, resolved: { configHash: `hash-${projectId}`, runOptions, liveExecution: { blockers: projectId === 'lib-project' ? [{ reason: TARGET_MISSING }] : [] } } })
  return { supervisor, issues, readRun, resolve, infrastructureOf: async (project) => infra[project], calls, maxPerHost: () => maxPerHost }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  try {
    t.section('1. the trigger time, in the configured zone, across daylight saving')
    {
      t.eq('06:00 in Berlin on 2026-11-07 (CET) is 05:00Z', iso(nextTrigger(BERLIN, Date.parse('2026-11-07T04:00:00.000Z'))), '2026-11-07T05:00:00.000Z')
      t.eq('after it, the next day', iso(nextTrigger(BERLIN, Date.parse('2026-11-07T05:00:00.000Z'))), '2026-11-08T05:00:00.000Z')
      t.eq('on the day clocks go forward (2026-03-29) 06:00 is 04:00Z', iso(nextTrigger(BERLIN, Date.parse('2026-03-29T00:00:00.000Z'))), '2026-03-29T04:00:00.000Z')
      t.eq('on the day clocks go back (2026-10-25) 06:00 is 05:00Z', iso(nextTrigger(BERLIN, Date.parse('2026-10-25T00:00:00.000Z'))), '2026-10-25T05:00:00.000Z')
      t.eq('an ambiguous time is its earlier instant', iso(nextTrigger({ at: '02:30', timeZone: 'Europe/Berlin' }, Date.parse('2026-10-24T22:00:00.000Z'))), '2026-10-25T00:30:00.000Z')
      t.eq('a skipped time fires shifted forward', iso(nextTrigger({ at: '02:30', timeZone: 'Europe/Berlin' }, Date.parse('2026-03-28T23:00:00.000Z'))), '2026-03-29T01:30:00.000Z')
      t.eq('the record date is local', localDate(Date.parse('2026-11-06T23:30:00.000Z'), 'Europe/Berlin'), '2026-11-07')
    }

    t.section('2. the stage rule: staging is a stage unless declared verified through its instances')
    {
      t.eq('no infrastructure', stageOf('p', null).verifiedThrough, 'instances')
      t.eq('declared', stageOf('p', { staging: environment('stage', 'h', { fullVerification: 'instances' }) }).verifiedThrough, 'instances')
      t.eq('a staging environment is a stage on its host', stageOf('p', { staging: environment('stage', 'h') }), { project: 'p', stage: 'stage', host: 'h' })
    }

    t.section('3. a scheduled cycle on a fake clock: freeze, one run per stage, one per host, the record')
    {
      const issuesDir = await temp('devpanel-fv-issues-')
      const verificationDir = path.join(issuesDir, '.verification')
      const w = world({ issuesDir })
      const clock = manualClock(Date.parse('2026-11-07T04:00:00.000Z'))
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock, settings: () => BERLIN, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, pollMs: 1000, log: { warn () {} } })
      fv.start()
      clock.advance(60 * 60 * 1000 - 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('nothing before 06:00 local', w.calls.freezes.length, 0)
      clock.advance(1)
      await until(() => w.calls.freezes.length === 1, 'the freeze')
      t.eq('at 06:00 local admission closes for the day\'s first cycle', w.calls.freezes, ['2026-11-07.1'])
      const record = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.state === 'ended' ? r : null }, 'the cycle to end')
      t.eq('the record names the trigger and the schedule', [record.id, record.trigger, record.schedule], ['2026-11-07.1', 'schedule', BERLIN])
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
      t.eq('the cycle opened no issue', w.calls.createIssue, 0)
      t.eq('the schedule armed the next day', (await fv.latest()).schedule.next, '2026-11-08T05:00:00.000Z')

      t.section('4. "Full verification now": the same freeze, runs and record, the earlier cycle kept')
      const hand = await fv.startNow({ by: 'tester' })
      t.eq('a hand start returns the frozen record', [hand.id, hand.trigger, hand.by, hand.state], ['2026-11-07.2', 'hand', 'tester', 'frozen'])
      const second = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.id === '2026-11-07.2' && r.state === 'ended' ? r : null }, 'the hand cycle')
      t.eq('the same freeze', w.calls.freezes, ['2026-11-07.1', '2026-11-07.2'])
      t.eq('the same runs', w.calls.starts.filter((s) => s.cycle === '2026-11-07.2').length, 2)
      t.eq('the same record shape', second.projects.map((p) => p.project).sort(), record.projects.map((p) => p.project).sort())
      t.eq('the scheduled cycle of the day is kept beside it', (await readJson(path.join(verificationDir, '2026-11-07', 'cycle.1.json'))).id, '2026-11-07.1')
      fv.stop()
    }

    t.section('5. the cycle starts only when no seat turn is running, and resumes what it paused')
    {
      const issuesDir = await temp('devpanel-fv-wait-')
      const verificationDir = path.join(issuesDir, '.verification')
      const paused = [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen' }, { project: 'app-project', issueId: '2026-11-01-held', runId: 'r-held', manualPending: true }]
      const w = world({ issuesDir, busy: [{ project: 'app-project', issueId: '2026-11-01-frozen', runId: 'r-frozen', phase: 'run' }], paused })
      const clock = manualClock(Date.parse('2026-11-07T09:00:00.000Z'))
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, pollMs: 1000, log: { warn () {} } })
      await fv.startNow({ by: 'tester' })
      const waiting = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.waitingOn?.length ? r : null }, 'the wait to be recorded')
      t.eq('frozen and waiting on the live run, with nothing started', [waiting.state, waiting.waitingOn.map((b) => b.runId), w.calls.starts.length], ['frozen', ['r-frozen'], 0])
      let refused = null
      try { await fv.startNow() } catch (error) { refused = error.code }
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
      t.eq('a hand start without a schedule records none and uses UTC dates', [ended.schedule, ended.timeZone], [null, 'UTC'])
    }

    t.section('6. off without the block; no catch-up after the time has passed')
    {
      const issuesDir = await temp('devpanel-fv-off-')
      const w = world({ issuesDir })
      const clock = manualClock(Date.parse('2026-11-07T04:00:00.000Z'))
      let settings = null
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock, settings: () => settings, verificationDir: path.join(issuesDir, '.verification'), resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, log: { warn () {} } })
      fv.start()
      for (let i = 0; i < 49; i++) clock.advance(60 * 60 * 1000)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('no block: no cycle in two days', [w.calls.freezes.length, (await fv.latest()).schedule], [0, null])
      // The block appears now, 06:00 local on 2026-11-09, and is first read an hour later: that day's cycle is not caught up.
      settings = BERLIN
      const now = clock.now()
      t.eq('it is 06:00 local on 2026-11-09 when the block appears', [localDate(now, 'Europe/Berlin'), iso(now)], ['2026-11-09', '2026-11-09T05:00:00.000Z'])
      clock.advance(60 * 60 * 1000)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('read again within the hour, no cycle for the time already passed', w.calls.freezes.length, 0)
      t.eq('the next is tomorrow\'s', (await fv.latest()).schedule.next, '2026-11-10T05:00:00.000Z')
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T08:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, log: { warn () {} } })
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
        const home = await issues.ensureRunHome('devpanel-project', '2026-11-07', '# Daily full verification\n')
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
        t.eq('the task report is written once', await fs.readFile(path.join(home.path, '000-report', 'response.md'), 'utf8'), '# Daily full verification\n')
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf, readRun: w.readRun, log: { warn () {} } })
      await fv.startNow({ by: 'tester' })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, log: { warn () {} } })
      await fv.startNow({ by: 'tester' })
      const record = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.state === 'ended' ? r : null }, 'the cycle to end')
      t.eq('the earlier cycle\'s frozen run is resumed by the cycle', w.calls.resumes, [{ project: 'app-project', issueId: 'verification-2026-11-05', runId: 'old-frozen', actor: 'service', origin: 'full-verification' }])
      t.eq('and recorded; the one with an operator pause pending is held for the operator', [record.resumed.map((r) => r.runId), record.heldForOperator.map((r) => r.runId), record.refused], [['old-frozen'], ['old-held'], []])
    }
  } finally {
    for (const d of temps) await fs.rm(d, { recursive: true, force: true })
  }
}
