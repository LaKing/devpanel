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

/**
 * The projects a cycle reads, a fake supervisor and issue store, and what they were asked.
 * `checks` replaces a project's full check, `files` are written into its run's drive directory,
 * `frameworkOf` declares instances (framework:), `failAction` names a project whose checkpoint fails.
 */
function world ({ busy = [], issuesDir, paused = [], checks = {}, files = {}, frameworkOf = {}, failAction = null }) {
  const infra = {
    'app-project': { staging: environment('stage', 'ssh-config:stage-a') },
    'shop-project': { staging: environment('stage', 'ssh-config:stage-a') },
    'lib-project': { staging: environment('stage', 'ssh-config:stage-b') },
    'framework-project': { staging: environment('stage', 'ssh-config:stage-c', { fullVerification: 'instances' }) },
    'tool-project': null
  }
  const calls = { freezes: [], thaws: [], starts: [], resumes: [], createIssue: 0, issues: [], attachments: [], actions: [], order: [], homes: [] }
  const runCount = new Map()
  const runs = new Map()
  const activeOnHost = new Map()
  let maxPerHost = 0
  const host = (project) => infra[project]?.staging.ssh.hostRef
  const supervisor = {
    busyList: busy,
    frozenState: null,
    async freeze (cycleId) { calls.freezes.push(cycleId); this.frozenState = { cycleId, at: '2026-11-07T05:00:00.000Z' }; return [] },
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
  const resolve = async (playbookId, { projectId, runOptions }) => ({ ok: true, resolved: { configHash: `hash-${projectId}`, runOptions, liveExecution: { blockers: projectId === 'lib-project' ? [{ reason: TARGET_MISSING }] : [] } } })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock, settings: () => BERLIN, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, pollMs: 1000, log: { warn () {} } })
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
      t.eq('red: no checkpoint ran', w.calls.actions, [])
      t.eq('one issue for the red project, named for the cycle\'s date, project and stage', w.calls.issues.map((i) => [i.project, i.input.split('\n')[0]]), [['lib-project', '# Full verification 2026-11-07: lib-project red on stage']])
      t.eq('the record lists it', record.outcome.issues.map((i) => [i.project, i.issueId, i.name]), [['lib-project', 'issue-1', 'Full verification 2026-11-07: lib-project red on stage']])
      t.ok('the issue says why: the refusal', w.calls.issues[0].input.includes('TARGET_MISSING'))
      t.eq('the issue was opened before admission reopened', w.calls.order, ['issue:lib-project', 'thaw'])
      t.eq('the schedule armed the next day', (await fv.latest()).schedule.next, '2026-11-08T05:00:00.000Z')

      t.section('4. "Full verification now": the same freeze, runs and record, the earlier cycle kept')
      // The record says 'ended' before the cycle's promise lets go of the slot: wait for the cycle itself.
      await fv.settle()
      const hand = await fv.startNow({ by: 'tester' })
      t.eq('a hand start returns the frozen record', [hand.id, hand.trigger, hand.by, hand.state], ['2026-11-07.2', 'hand', 'tester', 'frozen'])
      const second = await until(async () => { const r = await readJson(path.join(verificationDir, '2026-11-07', 'cycle.json')).catch(() => null); return r?.id === '2026-11-07.2' && r.state === 'ended' ? r : null }, 'the hand cycle')
      t.eq('the same freeze', w.calls.freezes, ['2026-11-07.1', '2026-11-07.2'])
      t.eq('the same runs', w.calls.starts.filter((s) => s.cycle === '2026-11-07.2').length, 2)
      t.eq('the same record shape', second.projects.map((p) => p.project).sort(), record.projects.map((p) => p.project).sort())
      t.eq('a later cycle of the date opens its own issue, named with its id', [w.calls.issues.length, w.calls.issues[1].input.split('\n')[0], w.calls.issues[1].openedBy.from.cycle], [2, '# Full verification 2026-11-07: lib-project red on stage (cycle 2026-11-07.2)', '2026-11-07.2'])
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock, settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, pollMs: 1000, log: { warn () {} } })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock, settings: () => settings, verificationDir: path.join(issuesDir, '.verification'), resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T08:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} } })
      await fv.startNow({ by: 'tester' })
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
      const fv = createFullVerification({ supervisor: w.supervisor, issues: w.issues, clock: manualClock(Date.parse('2026-11-07T09:00:00.000Z')), settings: () => null, verificationDir, resolve: w.resolve, infrastructureOf: w.infrastructureOf, readRun: w.readRun, ...w.seams, log: { warn () {} }, ...extra })
      const run = async () => {
        const started = await fv.startNow({ by: 'tester' })
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
      t.eq('named with its cycle id', again.input.split('\n')[0], '# Full verification 2026-11-07: shop-project red on stage (cycle 2026-11-07.2)')
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
  } finally {
    for (const d of temps) await fs.rm(d, { recursive: true, force: true })
  }
}
