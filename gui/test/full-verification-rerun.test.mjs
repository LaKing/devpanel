import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFullVerification, driveIdOf } from '../server/full-verification.mjs'
import { judgeRerun, rerunCommands, rerunPlan, rerunSettings } from '../server/runtime/full-verification-rerun.mjs'
import { classifyAll, readDrives } from '../server/runtime/selftest-history.mjs'
import { manualClock } from '../server/runtime/clock.mjs'
import { instanceName } from '../server/runtime/instance-drive.mjs'
import { modulesErrors } from '../server/infrastructure.mjs'

// The fixtures' stage hosts are aliases no ssh configuration resolves: each cycle pins them as named (no connection is made).
const fakeResolve = async (ssh) => ({ host: String(ssh?.hostRef ?? '').replace(/^ssh-config:/, ''), pinned: null })

export const name = 'full verification rerun — a failed test reruns alone on the same instance before it is destroyed: flaky when it passes (green, recorded, in the history and an issue), red when it fails again or proves nothing; never for a non-test failure, over the bound, opted out or without a command that selects named tests'

const HOST = 'ssh-config:stage-host'
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const report = (tests) => `== runtime/selftest.report\n${JSON.stringify({ tests })}\n`
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

function instanceInfra ({ rerun } = {}) {
  return {
    staging: { id: 'stage', ssh: { hostRef: HOST, workdir: '/opt' }, projectRoot: '/opt/stage-base', files: {} },
    testDrive: {
      modules: {
        collections: ['@*'],
        lint: { id: 'lint', run: '/opt/stage-tools/lint.sh {{instance}} {{files}}' },
        load: { id: 'load', run: '/opt/stage-tools/load.sh {{instance}}' },
        restart: { id: 'restart', run: '/opt/stage-tools/reload.sh {{instance}}' },
        ready: { id: 'ready', run: '/opt/stage-tools/instance.sh ready {{instanceName}}' },
        test: { id: 'module-selftest', run: '/opt/stage-tools/selftest.sh {{instance}} {{filters}}' },
        finallyCommands: [{ id: 'collect-selftest-report', run: 'cat {{instance}}/runtime/selftest.report', report: 'selftest' }],
        instance: {
          root: '/opt/stage-instances',
          create: { run: '/opt/stage-tools/instance.sh create {{instanceName}} "$PWD"' },
          start: { run: '/opt/stage-tools/instance.sh start {{instanceName}}' },
          destroy: { run: '/opt/stage-tools/instance.sh destroy {{instanceName}}' },
          fullSuite: {
            test: { id: 'full-suite', run: '/opt/stage-tools/full-suite.sh {{instance}}', timeoutSeconds: 3600 },
            finallyCommands: [{ id: 'collect-log', run: 'cat {{instance}}/runtime/log/current/project.log' }],
            ...(rerun !== undefined ? { rerun } : {})
          }
        }
      }
    }
  }
}

const ok = (id) => ({ id, passed: true, exitCode: 0 })
const collectors = (reportPassed = true) => [{ id: 'collect-selftest-report', passed: reportPassed, exitCode: reportPassed ? 0 : 1 }, ok('collect-log')]

/** The whole suite failing on `failed` (exit 1 on its own), every other test passing. */
const suiteFails = (failed, { suite = { passed: false, exitCode: 1 }, reportText = null } = {}) => ({
  result: 'failed',
  commands: [ok('instance-create'), ok('instance-start'), ok('ready'), { id: 'full-suite', ...suite }, ...collectors()],
  files: { 'collect-selftest-report.stdout': reportText ?? report([{ test: 'a: works' }, ...failed.map((test) => ({ test, error: 'boom' }))]), 'collect-log.stdout': 'READY\n' }
})

/**
 * A rerun drive: each named test the command selects passes or fails by `outcomes` (test -> 'pass' | 'fail').
 * `command` overrides the rerun command's record (a timeout), `collectorPassed` the report collector's.
 */
const rerunAnswers = (outcomes, { command = null, collectorPassed = true } = {}) => (target) => {
  const rerun = target.commands[0]
  const selected = Object.keys(outcomes).filter((test) => rerun.run.includes(`'${test}'`))
  const failed = selected.filter((test) => outcomes[test] === 'fail')
  return {
    result: failed.length || command || !collectorPassed ? 'failed' : 'passed',
    commands: [{ id: rerun.id, passed: !failed.length, exitCode: failed.length ? 1 : 0, ...(command ?? {}) }, ...collectors(collectorPassed)],
    files: { 'collect-selftest-report.stdout': report(selected.map((test) => outcomes[test] === 'fail' ? { test, error: 'again' } : { test })), 'collect-log.stdout': 'READY\n' }
  }
}

function seams ({ issuesDir, infra, suite, rerun = () => { throw new Error('no rerun drive is expected') }, listed = [], projects = null }) {
  const calls = { targets: [], suites: 0, reruns: [], destroys: [], releases: [], issues: [], files: [], notes: [], actions: [], ended: [] }
  const supervisor = { frozenState: null, async freeze (id) { this.frozenState = { id }; return [] }, thaw () { this.frozenState = null }, frozen () { return this.frozenState }, busy: () => [], isActive: () => false, async resume () { return {} }, async start () { throw new Error('no release run') } }
  const issues = {
    ISSUES_DIR: issuesDir,
    listProjects: async () => Object.keys(infra).map((id) => ({ id })),
    listIssues: async () => listed,
    async createIssue (project, args) { calls.issues.push({ project, ...args }); return { id: `issue-${calls.issues.length}` } },
    async createEngineNote (project, id, note) { calls.notes.push({ project, id, ...note }); return { where: 'step', step: '009' } },
    async addStepFile (project, id, step, name, bytes) { calls.files.push({ project, id, name, text: bytes.toString('utf8') }) },
    async ensureRunHome () { throw new Error('no run home') }
  }
  // As runChecks records a base drive: the commit it rebuilt (the comparison with the previous green drive reads it).
  const drive = async ({ target, runDir, dirName, baseCommit }) => {
    calls.targets.push(target)
    const isRerun = target.commands.length === 1 && target.commands[0].id.includes('-rerun-')
    const out = isRerun ? rerun(target) : suite(target)
    if (isRerun) calls.reruns.push(target.commands[0])
    const dir = path.join(runDir, 'checks', dirName)
    await fs.mkdir(dir, { recursive: true })
    for (const [file, text] of Object.entries(out.files ?? {})) await fs.writeFile(path.join(dir, file), text)
    return { result: out.result, dir: path.join('checks', dirName), baseCommit, commands: out.commands, ...(out.skipped ? { skipped: out.skipped } : {}), stageInstance: { name: target.stageInstance.name, root: target.stageInstance.root, host: HOST, fresh: !isRerun, state: out.instanceState ?? 'live' } }
  }
  const options = {
    supervisor, issues, settings: () => null, pollMs: 1000, log: { warn () {} },
    infrastructureOf: async (project) => infra[project],
    resolve: async (_p, { projectId }) => ({ ok: true, resolved: { configHash: `hash-${projectId}`, workspace: { base: 'working-tree' }, fence: { selection: 1, repository: 1 }, liveExecution: { blockers: [] } } }),
    provision: async (args) => { const p = path.join(args.root, `worktree-${args.runId}`); await fs.mkdir(p, { recursive: true }); return { path: p, baseCommit: 'snap' } },
    releaseWorkspace: async (w) => { calls.releases.push(w.path) },
    drive,
    destroyInstances: async (driveId) => { calls.destroys.push(driveId); return [{ name: instanceName(driveId), passed: true }] },
    coverageOf: async ({ candidates }) => ({ basis: 'cycle-snapshot', covered: (candidates ?? []).map((runId) => ({ runId })), indeterminate: [], notShipped: [] }),
    deliveriesOf: async () => [{ issueId: 'i1', runId: 'r1', at: '2026-11-15T08:00:00.000Z' }],
    projectPathOf: async (project) => `/fixture/${project}`,
    projectsConfig: async () => projects ?? new Map(Object.keys(infra).map((id) => [id, { id }])),
    runAction: async (a) => { calls.actions.push(a); return { status: 'completed' } },
    versionOf: async () => null,
    onEnded: (notice) => { calls.ended.push(notice) }
  }
  return { calls, options }
}

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  const clock = () => manualClock(Date.parse('2026-11-15T09:00:00.000Z'))
  const cycle = async (s, at = clock()) => {
    const verificationDir = path.join(s.options.issues.ISSUES_DIR, '.verification')
    const fv = createFullVerification({ resolveHost: fakeResolve, ...s.options, clock: at, verificationDir })
    const started = await fv.startNow({ by: 'tester' })
    await fv.settle()
    return { fv, verificationDir, record: await readJson(path.join(verificationDir, started.date, 'cycle.json')) }
  }
  const named = { namedTests: true }
  try {
    t.section('1. every failed test passes alone: green, the flaky tests named everywhere, both outcomes kept, two history lines, a flaky-test issue, the checkpoint chain, coverage, the instance destroyed')
    {
      const issuesDir = await temp('devpanel-fvr-green-')
      const projects = new Map([['app-project', { id: 'app-project' }], ['site-project', { id: 'site-project', framework: 'app-project' }]])
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails(['b: breaks', 'c: wobbles']), rerun: rerunAnswers({ 'b: breaks': 'pass', 'c: wobbles': 'pass' }), projects })
      const { fv, record } = await cycle(s)
      const app = record.projects[0]
      const driveId = driveIdOf(record.id, 'app-project')
      const root = `/opt/stage-instances/${instanceName(driveId)}`
      t.eq('each failed test ran alone, in a command of its own on the same instance (no load, no restart)', s.calls.reruns.map((c) => c.run), [`/opt/stage-tools/selftest.sh ${root} 'b: breaks'`, `/opt/stage-tools/selftest.sh ${root} 'c: wobbles'`])
      t.eq('each rerun drive runs only its rerun command and the collectors', s.calls.targets.slice(1).map((x) => [x.commands.map((c) => c.id), x.finallyCommands.map((c) => c.id)]), [[['module-selftest-rerun-1'], ['collect-selftest-report', 'collect-log']], [['module-selftest-rerun-2'], ['collect-selftest-report', 'collect-log']]])
      t.eq('green, the gate of the suite drive kept as it was', [app.verdict, app.check.gating, app.rerun.state, app.rerun.outcome, record.verdict], ['green', 'failed', 'ran', 'all-passed', 'green'])
      t.eq('the flaky tests are named on the entry with where they ran alone', app.flaky, [{ command: 'collect-selftest-report', test: 'b: breaks', dir: 'checks/full-verification-rerun-1' }, { command: 'collect-selftest-report', test: 'c: wobbles', dir: 'checks/full-verification-rerun-2' }])
      t.eq('both outcomes and their logs stay in the cycle\'s record directory', await Promise.all(['full-verification', 'full-verification-rerun-1', 'full-verification-rerun-2'].map((d) => fs.readFile(path.join(app.runDir, 'checks', d, 'collect-selftest-report.stdout'), 'utf8').then(() => true, () => false))), [true, true, true])
      t.eq('drive.json keeps the rerun beside the drive', (await readJson(path.join(app.runDir, 'drive.json'))).fullVerification.rerun.outcome, 'all-passed')
      t.eq('the verification API serves them', (await fv.latest()).cycle.projects[0].flaky.map((f) => f.test), ['b: breaks', 'c: wobbles'])
      const notice = s.calls.ended[0]
      t.eq('the verification-ended event names them and the rerun', [notice.verdict, notice.projects[0].flaky, notice.projects[0].rerun], ['green', [{ command: 'collect-selftest-report', test: 'b: breaks' }, { command: 'collect-selftest-report', test: 'c: wobbles' }], { state: 'ran', reason: 'all-passed' }])
      const drives = await readDrives(path.join(issuesDir, 'app-project', '.selftest-history'))
      t.eq('two history lines: the suite as a failure, the rerun as a pass, on one tree', drives.map((d) => [d.kind, d.treeIdentity, d.commands[0].failed, d.commands[0].passed]), [['full-verification', 'commit:snap', ['b: breaks', 'c: wobbles'], []], ['full-verification-rerun', 'commit:snap', [], ['b: breaks', 'c: wobbles']]])
      t.eq('the unstable classification sees both, same-bytes', classifyAll(drives, { now: Date.parse('2026-11-15T10:00:00.000Z') }).map((c) => [c.test, c.routes]), [['b: breaks', ['same-bytes']], ['c: wobbles', ['same-bytes']]])
      const issue = s.calls.issues[0]
      t.eq('one flaky-test issue for the project, opened by the engine from the cycle', [s.calls.issues.length, issue.project, issue.openedBy.from], [1, 'app-project', { project: 'app-project', runId: null, via: 'full-verification', cycle: record.id, subject: 'flaky-tests' }])
      t.ok('it names the flaky tests', issue.input.includes('flaky tests in app-project') && issue.input.includes('b: breaks') && issue.input.includes('c: wobbles'), issue.input)
      t.eq('the checkpoint chain ran as for any green cycle', s.calls.actions.map((a) => [a.project, a.args]), [['app-project', ['--minor']], ['site-project', []]])
      t.eq('the outcome records the issue', record.outcome.flaky.map((i) => [i.project, i.issueId, i.noted]), [['app-project', 'issue-1', false]])
      t.eq('a whole suite that ran: coverage established, the deliveries retired', [app.coverageEstablished, notice.projects[0].covered], [true, ['r1']])
      t.eq('the instance destroyed once, after the reruns', s.calls.destroys, [driveId])
    }

    t.section('2. an open flaky-test issue gets a note; no second issue')
    {
      const listed = [{ id: 'flaky-old', status: 'open', disposition: null, openedBy: { user: 'engine', from: { via: 'full-verification', cycle: '2026-11-14.1', subject: 'flaky-tests' } } },
        { id: 'red-old', status: 'open', openedBy: { user: 'engine', from: { via: 'full-verification', cycle: '2026-11-14.1' } } }]
      const s = seams({ issuesDir: await temp('devpanel-fvr-note-'), infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails(['b: breaks']), rerun: rerunAnswers({ 'b: breaks': 'pass' }), listed })
      const { record } = await cycle(s)
      t.eq('noted on the open flaky-test issue, nothing opened', [s.calls.issues.length, s.calls.notes.map((n) => [n.id, n.name, n.invocationId])], [0, [['flaky-old', 'flaky-tests', `full-verification:${record.id}:flaky`]]])
      t.eq('the outcome says so', record.outcome.flaky.map((i) => [i.issueId, i.noted]), [['flaky-old', true]])
    }

    t.section('3. one test fails again: red; failing-tests.md lists only it and names the flaky one apart')
    {
      const s = seams({ issuesDir: await temp('devpanel-fvr-red-'), infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails(['b: breaks', 'c: wobbles']), rerun: rerunAnswers({ 'b: breaks': 'pass', 'c: wobbles': 'fail' }) })
      const { record } = await cycle(s)
      const app = record.projects[0]
      t.eq('red as now, the rerun recorded', [app.verdict, record.verdict, app.rerun.outcome, app.rerun.tests.map((x) => [x.test, x.rerun])], ['red', 'red', 'some-not-passed', [['b: breaks', 'passed'], ['c: wobbles', 'failed']]])
      const attachment = s.calls.files.find((f) => f.name === 'failing-tests.md')?.text ?? ''
      t.ok('failing-tests.md lists the test that failed twice', attachment.includes('### `collect-selftest-report: c: wobbles` (failed-twice)'), attachment)
      t.ok('and not the flaky one as failing', !attachment.includes('### `collect-selftest-report: b: breaks`'), attachment)
      t.ok('which it names apart', /## Flaky[^\n]*\n[\s\S]*- `collect-selftest-report: b: breaks`/.test(attachment), attachment)
      t.eq('one red issue, no flaky-test issue for a red entry, no checkpoint', [s.calls.issues.length, s.calls.issues[0].openedBy.from.subject, s.calls.actions.length], [1, undefined, 0])
      t.eq('the instance destroyed', s.calls.destroys.length, 1)
    }

    t.section('4. the bound counts every reported failure of an entry the gate made red, inherited ones too: 11 reported, 10 inherited, no rerun; a passed gate is never overridden')
    {
      const passedSuite = (failed) => () => ({ ...suiteFails(failed), result: 'passed', commands: [ok('instance-create'), ok('instance-start'), ok('ready'), ok('full-suite'), ...collectors()] })
      // A first cycle, green; its drive is then made to report the inherited failures (and its record to verify them).
      const seedGreen = async (issuesDir, inherited) => {
        const first = seams({ issuesDir, infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: passedSuite([]) })
        const { verificationDir, record: one } = await cycle(first)
        const entry = one.projects[0]
        const text = report([{ test: 'a: works' }, ...inherited.map((test) => ({ test, error: 'known' }))])
        await fs.writeFile(path.join(entry.runDir, entry.check.dir, 'collect-selftest-report.stdout'), text)
        entry.check.files['collect-selftest-report.stdout'] = sha256(text)
        await fs.writeFile(path.join(verificationDir, one.date, 'cycle.json'), JSON.stringify(one, null, 2))
        return one
      }
      const issuesDir = await temp('devpanel-fvr-bound-')
      const inherited = Array.from({ length: 10 }, (_, i) => `old: ${i}`)
      const one = await seedGreen(issuesDir, inherited)
      t.eq('the first cycle is green', one.projects[0].verdict, 'green')
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails([...inherited, 'new: one']) })
      const { record } = await cycle(s)
      const app = record.projects[0]
      t.eq('compared with the first cycle', app.check.baseline?.cycleId, one.id)
      t.eq('over the bound: no rerun drive, red, the count and bound recorded', [s.calls.reruns.length, app.verdict, app.rerun.state, app.rerun.reason, app.rerun.reported, app.rerun.bound], [0, 'red', 'skipped', 'over-bound', 11, 10])
      t.eq('the instance destroyed', s.calls.destroys.length, 1)

      // 11 reported, every one inherited, the suite answering as on the green cycle: the gate passes, as it does today.
      const allDir = await temp('devpanel-fvr-inherited-')
      const eleven = Array.from({ length: 11 }, (_, i) => `old: ${i}`)
      const base = await seedGreen(allDir, eleven)
      const all = seams({ issuesDir: allDir, infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: passedSuite(eleven) })
      const green = (await cycle(all)).record.projects[0]
      t.eq('all inherited, gate passed: green as today, compared with the seeded cycle', [green.check.baseline?.cycleId, green.check.gating, green.verdict], [base.id, 'passed', 'green'])
      t.eq('the bound limits which red entries are rerun and never overrides a passed gate: no rerun drive, no over-bound', [all.calls.reruns.length, green.rerun ?? null, green.flaky ?? null], [0, null, null])
      t.eq('the instance destroyed', all.calls.destroys.length, 1)
    }

    t.section('5. a rerun that proves nothing is not a pass: passes printed and then a timeout, or a failed collector, stay red')
    {
      for (const [label, answers] of [
        ['a rerun that reported passes and then timed out', rerunAnswers({ 'b: breaks': 'pass' }, { command: { passed: false, exitCode: 124, timedOut: true } })],
        ['a rerun whose report collector failed', rerunAnswers({ 'b: breaks': 'pass' }, { collectorPassed: false })]
      ]) {
        const s = seams({ issuesDir: await temp('devpanel-fvr-timeout-'), infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails(['b: breaks']), rerun: answers })
        const { record } = await cycle(s)
        const app = record.projects[0]
        t.eq(`${label}: not observed, red, no flaky test, no history`, [app.rerun.tests[0].rerun, app.verdict, app.flaky ?? null, await fs.readdir(path.join(s.options.issues.ISSUES_DIR, 'app-project', '.selftest-history')).catch(() => [])], ['not-observed', 'red', null, []])
        t.ok(`${label}: the red issue says why`, s.calls.issues[0].input.includes('(not-observed)'), s.calls.issues[0].input)
        t.eq(`${label}: the instance destroyed`, s.calls.destroys.length, 1)
      }
    }

    t.section('6. no command selects named tests: no rerun, the reason recorded, red as now, the instance destroyed')
    {
      const s = seams({ issuesDir: await temp('devpanel-fvr-cannot-'), infra: { 'app-project': instanceInfra() }, suite: () => suiteFails(['b: breaks']) })
      const { record } = await cycle(s)
      const app = record.projects[0]
      t.eq('cannot-select-named-tests, no rerun drive', [app.rerun.state, app.rerun.reason, s.calls.reruns.length, app.verdict], ['skipped', 'cannot-select-named-tests', 0, 'red'])
      t.ok('the red issue says why', s.calls.issues[0].input.includes('not done, cannot-select-named-tests'), s.calls.issues[0].input)
      t.eq('the event says why', s.calls.ended[0].projects[0].rerun, { state: 'skipped', reason: 'cannot-select-named-tests' })
      t.eq('the instance destroyed', s.calls.destroys.length, 1)

      const out = seams({ issuesDir: await temp('devpanel-fvr-out-'), infra: { 'app-project': instanceInfra({ rerun: false }) }, suite: () => suiteFails(['b: breaks']) })
      const optedOut = (await cycle(out)).record.projects[0]
      t.eq('rerun: false opts out, said so', [optedOut.rerun.reason, out.calls.reruns.length, optedOut.verdict, out.calls.destroys.length], ['opted-out', 0, 'red', 1])
    }

    t.section('7. a failure that is not a failed test is never rerun into green')
    {
      const cases = [
        ['a failed ready (the suite never ran)', () => ({ result: 'failed', commands: [ok('instance-create'), ok('instance-start'), { id: 'ready', passed: false, exitCode: 1 }, ...collectors(false)], skipped: [{ id: 'full-suite', required: true, reason: 'needs ready' }], instanceState: 'destroyed', files: {} })],
        ['a suite that timed out', () => suiteFails(['b: breaks'], { suite: { passed: false, exitCode: 124, timedOut: true } })],
        ['an unreadable selftest report', () => suiteFails(['b: breaks'], { reportText: 'no report here\n' })],
        ['a failed collector beside the failed suite', () => ({ ...suiteFails(['b: breaks']), commands: [ok('instance-create'), ok('instance-start'), ok('ready'), { id: 'full-suite', passed: false, exitCode: 1 }, ok('collect-selftest-report'), { id: 'collect-log', passed: false, exitCode: 2 }] })]
      ]
      for (const [label, suite] of cases) {
        const s = seams({ issuesDir: await temp('devpanel-fvr-nontest-'), infra: { 'app-project': instanceInfra({ rerun: named }) }, suite })
        const app = (await cycle(s)).record.projects[0]
        t.eq(`${label}: not-a-test-failure, no rerun drive, red, the instance destroyed`, [app.rerun?.reason, s.calls.reruns.length, app.verdict, s.calls.destroys.length], ['not-a-test-failure', 0, 'red', 1])
      }
    }

    t.section('8. a test the previous green cycle passed only alone is not inherited: failing again, it gates and is rerun')
    {
      const issuesDir = await temp('devpanel-fvr-again-')
      const first = seams({ issuesDir, infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails(['b: breaks']), rerun: rerunAnswers({ 'b: breaks': 'pass' }) })
      const one = (await cycle(first)).record
      t.eq('the first cycle is green with b flaky', [one.projects[0].verdict, one.projects[0].flaky.map((f) => f.test)], ['green', ['b: breaks']])
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra({ rerun: named }) }, suite: () => suiteFails(['b: breaks']), rerun: rerunAnswers({ 'b: breaks': 'fail' }) })
      const app = (await cycle(s)).record.projects[0]
      t.eq('compared with the green cycle, b is flaky-again, not inherited', [app.check.baseline?.cycleId, app.check.flakyAgain, app.check.failingTests.some((f) => f.test === 'b: breaks' && f.basis === 'flaky-again')], [one.id, [{ command: 'collect-selftest-report', test: 'b: breaks' }], true])
      t.eq('it was rerun, failed again: red', [s.calls.reruns.length, app.rerun.tests.map((x) => x.rerun), app.verdict], [1, ['failed'], 'red'])
    }

    t.section('9. the plan and the judgement, unit by unit')
    {
      const settings = rerunSettings(instanceInfra({ rerun: { ...named, maxTests: 2 } }))
      t.eq('namedTests reuses the tier\'s test command with its {{filters}}', [settings.template.id, settings.placeholder, settings.maxTests], ['module-selftest', 'filters', 2])
      t.eq('absent rerun: on, but nothing selects named tests', [rerunSettings(instanceInfra()).skip.reason, rerunSettings(instanceInfra()).maxTests], ['cannot-select-named-tests', 10])
      const check = { result: { stageInstance: { state: 'live' }, commands: [{ id: 'full-suite', passed: false, exitCode: 1 }] } }
      const reports = [{ command: 'collect-selftest-report', report: { tests: [{ test: 'x/1', error: 'e' }, { test: 'x/2', error: 'e' }, { test: 'y/3', error: 'e' }] } }]
      t.eq('three reported, two inherited, bound 2: over-bound before any subtraction', rerunPlan({ settings, check, suiteRan: {}, suiteId: 'full-suite', reports, baseFailed: ['x/1', 'x/2'] }).skip.reason, 'over-bound')
      const wide = { ...settings, maxTests: 10 }
      t.eq('within the bound, inherited failures are not rerun', rerunPlan({ settings: wide, check, suiteRan: {}, suiteId: 'full-suite', reports, baseFailed: ['x/1'] }).tests.map((x) => x.test), ['x/2', 'y/3'])
      t.eq('a suite-level entry is not a test', rerunPlan({ settings: wide, check, suiteRan: {}, suiteId: 'full-suite', reports: [{ command: 'r', report: { tests: [{ test: 'worker/(suite)', error: 'e' }] } }] }).skip.reason, 'not-a-test-failure')
      const tests = [{ command: 'r', test: 'svc/a' }, { command: 'r', test: 'svc/b' }, { command: 'r', test: 'web/c' }, { command: 'r', test: 'plain' }]
      const many = rerunCommands(tests, { template: { id: 'rt', run: '/x/rerun.sh /i {{tests}}' }, placeholder: 'tests' })
      t.eq('{{tests}}: the failed tests of one module in one command, an unknown module alone', many.map((g) => g.command.run), ["/x/rerun.sh /i 'svc/a' 'svc/b'", "/x/rerun.sh /i 'web/c'", "/x/rerun.sh /i 'plain'"])
      t.eq('{{test}}: one command per test', rerunCommands(tests, { template: { id: 'rt', run: '/x/rerun.sh /i {{test}}' }, placeholder: 'test' }).length, 4)
      const command = { id: 'rt-rerun-1' }
      const passReport = [{ command: 'c', report: { tests: [{ test: 'svc/a' }] } }]
      const base = { result: 'passed', stageInstance: { state: 'live' }, commands: [{ id: 'rt-rerun-1', passed: true, exitCode: 0 }, { id: 'c', passed: true }] }
      const target = { finallyCommands: [{ id: 'c', report: 'selftest' }] }
      t.eq('a completed rerun whose report passes the test: passed', judgeRerun({ drive: base, command, tests: [tests[0]], reports: passReport, target })[0].rerun, 'passed')
      t.eq('a timed-out rerun whose report passes it: not observed', judgeRerun({ drive: { ...base, commands: [{ id: 'rt-rerun-1', passed: false, exitCode: 124, timedOut: true }, { id: 'c', passed: true }] }, command, tests: [tests[0]], reports: passReport, target })[0].rerun, 'not-observed')
      t.eq('a nonzero exit with no failed test of its group named: not observed', judgeRerun({ drive: { ...base, commands: [{ id: 'rt-rerun-1', passed: false, exitCode: 1 }, { id: 'c', passed: true }] }, command, tests: [tests[0]], reports: passReport, target })[0].rerun, 'not-observed')
      t.eq('an unreadable rerun report: not observed', judgeRerun({ drive: base, command, tests: [tests[0]], reports: [{ command: 'c', error: 'no JSON report' }], target })[0].rerun, 'not-observed')
    }

    t.section('10. rerun.test is validated: it names the instance and takes {{test}} or {{tests}} as a word of its own')
    {
      const errorsOf = (test) => modulesErrors({ modules: instanceInfra({ rerun: { test } }).testDrive.modules }).filter((e) => e.includes('rerun'))
      t.eq('a valid {{tests}} template passes', errorsOf({ id: 'rerun', run: '/opt/stage-tools/rerun.sh {{instance}} {{tests}}' }), [])
      t.ok('one that names no instance is refused', errorsOf({ id: 'rerun', run: '/opt/stage-tools/rerun.sh /fixed {{test}}' }).some((e) => e.includes('must name the instance')))
      t.ok('one that takes {{filter}} is refused', errorsOf({ id: 'rerun', run: '/opt/stage-tools/rerun.sh {{instance}} {{filter}}' }).some((e) => e.includes('selects named tests')))
      t.ok('one without a test placeholder is refused', errorsOf({ id: 'rerun', run: '/opt/stage-tools/rerun.sh {{instance}}' }).some((e) => e.includes('exactly once')))
      t.ok('one reusing a declared id is refused', errorsOf({ id: 'full-suite', run: '/opt/stage-tools/rerun.sh {{instance}} {{test}}' }).some((e) => e.includes('unique')))
      // The tier's report on its test command, no collector declaring one: the rerun drive (rerun.test + collectors) would show nothing.
      const reportless = (test) => {
        const modules = instanceInfra({ rerun: { test } }).testDrive.modules
        modules.test = { ...modules.test, report: 'selftest' }
        modules.finallyCommands = [{ id: 'collect-log-tier', run: 'cat {{instance}}/runtime/log/tier.log' }]
        return modulesErrors({ modules }).filter((e) => e.includes('rerun'))
      }
      t.ok('a rerun.test whose drive declares no selftest report is refused', reportless({ id: 'rerun', run: '/opt/stage-tools/rerun.sh {{instance}} {{test}}' }).some((e) => e.includes('report: selftest')))
      t.eq('the same with report: selftest on the rerun command passes', reportless({ id: 'rerun', run: '/opt/stage-tools/rerun.sh {{instance}} {{test}}', report: 'selftest' }), [])
    }
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
