import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFullVerification, derivedVerdict, driveIdOf } from '../server/full-verification.mjs'
import { manualClock } from '../server/runtime/clock.mjs'
import { driveCommands, instanceName } from '../server/runtime/instance-drive.mjs'
import { deliveryCounts } from '../server/verification-trigger.mjs'
import { createSupervisor, supportedActions } from '../server/supervisor.mjs'
import { readVerificationFile, VERIFICATION_PAGE_CHARS } from '../server/runtime/check-log.mjs'
import { engineFixture } from './fakes/fixture.mjs'

export const name = 'full verification on a stage instance — no release to a protected host, an instance of the cycle\'s own destroyed at every end, the evidence kept, the delivery trigger, the supervisor told, and a freeze that holds back only writing runs and deliveries'

const BASE = '/opt/stage-base'
const HOST = 'ssh-config:stage-host'
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))
const report = (tests) => `== runtime/selftest.report\n${JSON.stringify({ tests })}\n`

/** A project on a stage host with dynamic instances, its tooling outside the base instance's root. */
function instanceInfra ({ fullSuite = true, browser = false, suiteBrowser = false } = {}) {
  return {
    staging: { id: 'stage', ssh: { hostRef: HOST, workdir: '/opt' }, projectRoot: BASE, files: {} },
    testDrive: {
      modules: {
        collections: ['@*'],
        lint: { id: 'lint', run: '/opt/stage-tools/lint.sh {{instance}} {{files}}' },
        load: { id: 'load', run: '/opt/stage-tools/load.sh {{instance}}' },
        restart: { id: 'restart', run: '/opt/stage-tools/reload.sh {{instance}}' },
        ready: { id: 'ready', run: '/opt/stage-tools/instance.sh ready {{instanceName}}' },
        test: { id: 'module-selftest', run: '/opt/stage-tools/selftest.sh {{instance}} {{filters}}' },
        ...(browser ? { browser: { id: 'module-browser', run: '/opt/stage-tools/browser.sh {{instance}} {{filter}}' } } : {}),
        finallyCommands: [{ id: 'collect-selftest-report', run: 'cat {{instance}}/runtime/selftest.report', report: 'selftest' }],
        instance: {
          root: '/opt/stage-instances',
          create: { run: '/opt/stage-tools/instance.sh create {{instanceName}} "$PWD"' },
          start: { run: '/opt/stage-tools/instance.sh start {{instanceName}}', busyExitCodes: [4] },
          destroy: { run: '/opt/stage-tools/instance.sh destroy {{instanceName}}' },
          ...(fullSuite ? { fullSuite: {
            test: { id: 'full-suite', run: '/opt/stage-tools/full-suite.sh {{instance}}', timeoutSeconds: 3600 },
            ...(suiteBrowser ? { browser: { id: 'full-browser', run: '/opt/stage-tools/browser-check.sh {{instance}}' } } : {}),
            finallyCommands: [{ id: 'collect-log', run: 'cat {{instance}}/runtime/log/current/project.log' }]
          } } : {})
        }
      }
    }
  }
}
const releaseInfra = (hostRef) => ({ staging: { id: 'stage', ssh: { hostRef, workdir: '/opt' }, projectRoot: BASE, files: {} } })

/**
 * A cycle's seams around projects `infra`: a fake supervisor and issue store, a snapshot provider, a drive standing in
 * for runChecks (it records every command a fresh instance drive would run, writes the outputs into the drive directory
 * and returns `outcome(target)`), the instance destroy, the snapshot's coverage and each project's deliveries.
 */
function seams ({ issuesDir, infra, outcome, deliveries = {}, covered = () => ({}), workspace = { base: 'working-tree' } }) {
  const calls = { starts: [], resolves: [], provisions: [], releases: [], destroys: [], commands: [], targets: [], ended: [], issues: [], actions: [], dispositions: 0, freezes: [] }
  const supervisor = {
    frozenState: null,
    async freeze (cycleId) { calls.freezes.push(cycleId); this.frozenState = { cycleId }; return [] },
    thaw () { this.frozenState = null; return true },
    frozen () { return this.frozenState },
    busy: () => [],
    isActive: () => false,
    async start (args) { calls.starts.push(args); throw new Error('no release run is expected here') },
    async resume () { return {} }
  }
  const issues = {
    ISSUES_DIR: issuesDir,
    listProjects: async () => Object.keys(infra).map((id) => ({ id })),
    listIssues: async () => [],
    async createIssue (project, args) { calls.issues.push({ project, ...args }); return { id: `issue-${calls.issues.length}` } },
    async addStepFile () {},
    async setIssueDisposition () { calls.dispositions++ },
    async ensureRunHome () { throw new Error('an instance stage has no run home') }
  }
  const drive = async ({ target, runDir, dirName, runId }) => {
    calls.targets.push(target)
    const commands = [...driveCommands(target, true), ...(target.finallyCommands ?? [])]
    calls.commands.push(...commands.map((c) => c.run), target.stageInstance.destroy.run)
    const dir = path.join(runDir, 'checks', dirName)
    await fs.mkdir(dir, { recursive: true })
    const result = await outcome(target, { runId })
    for (const [file, text] of Object.entries(result.files ?? {})) await fs.writeFile(path.join(dir, file), text)
    return { result: result.result, dir: path.join('checks', dirName), commands: result.commands, ...(result.skipped ? { skipped: result.skipped } : {}), stageInstance: { name: target.stageInstance.name, root: target.stageInstance.root, host: HOST, slot: 0, cap: 4, fresh: true, state: 'live' } }
  }
  const options = {
    supervisor, issues, settings: () => null, pollMs: 1000, log: { warn () {} },
    infrastructureOf: async (project) => infra[project],
    resolve: async (playbookId, { projectId }) => { calls.resolves.push(projectId); return { ok: true, resolved: { configHash: `hash-${projectId}`, workspace, infrastructure: infra[projectId] ?? null, fence: { selection: 1, repository: 1 }, liveExecution: { blockers: [] } } } },
    provision: async (args) => { calls.provisions.push(args); const p = path.join(args.root, `worktree-${args.runId}`); await fs.mkdir(p, { recursive: true }); return { path: p, baseCommit: 'snap', isolation: 'git-worktree' } },
    releaseWorkspace: async (w) => { calls.releases.push(w.path) },
    drive,
    destroyInstances: async (driveId) => { calls.destroys.push(driveId); return [{ name: instanceName(driveId), passed: true, reason: 'cycle-ended' }] },
    coverageOf: async ({ project, candidates }) => { const c = covered(project, candidates) ?? {}; return { basis: 'cycle-snapshot', covered: (c.covered ?? candidates ?? []).map((runId) => ({ runId })), indeterminate: (c.indeterminate ?? []).map((runId) => ({ runId, reason: 'snapshot-differs' })), notShipped: [] } },
    deliveriesOf: async (project) => deliveries[project] ?? [],
    projectPathOf: async (project) => `/fixture/${project}`,
    projectsConfig: async () => new Map(Object.keys(infra).map((id) => [id, { id }])),
    runAction: async (a) => { calls.actions.push(a); return { status: 'completed' } },
    versionOf: async () => null,
    onEnded: (notice) => { calls.ended.push(notice) }
  }
  return { calls, options }
}

const passing = (suiteExit = 0) => async (target) => {
  const suite = target.commands.find((c) => c.id === 'full-suite')
  return {
    result: suiteExit === 0 ? 'passed' : 'failed',
    commands: [{ id: 'instance-create', passed: true, exitCode: 0 }, { id: 'instance-start', passed: true, exitCode: 0 }, { id: 'ready', passed: true, exitCode: 0 },
      { id: suite.id, passed: suiteExit === 0, exitCode: suiteExit }, ...(target.commands.some((c) => c.id === 'full-browser') ? [{ id: 'full-browser', passed: true, exitCode: 0 }] : []),
      { id: 'collect-selftest-report', passed: true, exitCode: 0 }, { id: 'collect-log', passed: true, exitCode: 0 }],
    files: {
      'collect-selftest-report.stdout': report([{ test: 'a: works' }, { test: 'mail: provider', skipped: 'external: no mail account on an instance' }, ...(suiteExit ? [{ test: 'b: breaks', error: 'boom' }] : [])]),
      'collect-log.stdout': 'READY\n', 'full-suite.log': '$ full-suite\n'
    }
  }
}
const readinessFails = async () => ({
  result: 'failed',
  commands: [{ id: 'instance-create', passed: true, exitCode: 0 }, { id: 'instance-start', passed: true, exitCode: 0 }, { id: 'ready', passed: false, exitCode: 1 }, { id: 'collect-selftest-report', passed: false, exitCode: 1 }],
  skipped: [{ id: 'full-suite', required: true, reason: 'needs ready' }],
  files: { 'ready.log': 'not ready\n' }
})

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  const cycle = async (s, verificationDir, clock = manualClock(Date.parse('2026-11-14T09:00:00.000Z'))) => {
    const fv = createFullVerification({ ...s.options, clock, verificationDir })
    return { fv, run: async () => { const started = await fv.startNow({ by: 'tester' }); await fv.settle(); return readJson(path.join(verificationDir, started.date, 'cycle.json')) } }
  }
  try {
    t.section('1. a stage host with dynamic instances: no release run, an instance of the cycle\'s own, no command names the base instance; another project on that host is refused')
    {
      const issuesDir = await temp('devpanel-fvi-')
      const verificationDir = path.join(issuesDir, '.verification')
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra(), 'shop-project': releaseInfra(HOST) }, outcome: passing(), deliveries: { 'app-project': [{ issueId: 'i1', runId: 'r1', at: '2026-11-14T08:00:00.000Z' }] } })
      const { run } = await cycle(s, verificationDir)
      const record = await run()
      const app = record.projects.find((p) => p.project === 'app-project')
      const shop = record.projects.find((p) => p.project === 'shop-project')
      const driveId = driveIdOf(record.id, 'app-project')
      t.eq('no Deployment run started, for either project', s.calls.starts.length, 0)
      t.eq('the project without an instance on that host is refused, never released to', [shop.verdict, shop.refusal?.code], ['red', 'HOST_HAS_INSTANCES'])
      t.eq('and its playbook was not even resolved', s.calls.resolves, ['app-project'])
      t.eq('the record names the protected host and who declares its instances', record.protectedHosts, { [HOST]: ['app-project'] })
      t.ok('every command of the cycle names its instance', s.calls.commands.every((run) => run.includes(`/opt/stage-instances/${instanceName(driveId)}`) || run.includes(instanceName(driveId))), s.calls.commands.join(' | '))
      t.eq('no command names the base instance\'s root', s.calls.commands.filter((run) => run.includes(BASE)), [])
      t.eq('the record names the instance it used', [app.mode, app.instance.name, app.instance.root, app.driveId], ['instance', instanceName(driveId), `/opt/stage-instances/${instanceName(driveId)}`, driveId])
      t.eq('its candidate: the development checkout, snapshotted as a run\'s working-tree base', [s.calls.provisions[0].projectPath, s.calls.provisions[0].runId, s.calls.provisions[0].policy.base, app.snapshot.baseCommit], ['/fixture/app-project', driveId, 'working-tree', 'snap'])
      t.eq('the instance is destroyed and the snapshot released at the cycle\'s end', [s.calls.destroys, s.calls.releases.length, app.instance.destroyed.passed, app.workspace.released], [[driveId], 1, true, true])
      t.eq('green: the suite ran, compared with no earlier instance drive', [app.verdict, app.check.gating, app.suiteRan?.command, app.coverageEstablished], ['green', 'passed', 'full-suite', true])
      t.eq('the test the instance cannot run is reported as such, neither failure nor pass', app.check.notOnInstance, [{ command: 'collect-selftest-report', test: 'mail: provider', reason: 'external: no mail account on an instance' }])
      t.eq('the evidence stays under the cycle record after the instance is gone', app.evidence.dir, path.join(verificationDir, record.date, record.id, 'app-project', 'checks', 'full-verification'))
      t.eq('the selftest report and the project log are there', await Promise.all(['collect-selftest-report.stdout', 'collect-log.stdout'].map((f) => fs.readFile(path.join(app.evidence.dir, f), 'utf8').then(() => true, () => false))), [true, true])
      t.eq('and the drive is kept beside them for the next cycle', (await readJson(path.join(app.runDir, 'drive.json'))).fullVerification.check.gating, 'passed')
      t.eq('the record lists the delivered runs it covered', app.coverage.covered.map((c) => c.runId), ['r1'])
      t.eq('one red entry (the refused project) makes the cycle red, and red opens its issue', [record.verdict, s.calls.issues.map((i) => i.project)], ['red', ['shop-project']])
      const notice = s.calls.ended[0]
      t.eq('the top-level supervisor is told once, with the outcome and the record', [s.calls.ended.length, notice.cycleId, notice.verdict, notice.record], [1, record.id, 'red', path.join(verificationDir, record.date, 'cycle.json')])
      t.eq('and where each entry\'s evidence is, and what it covered', notice.projects.map((p) => [p.project, p.instance, p.evidence, p.covered]), [['app-project', instanceName(driveId), app.evidence.dir, ['r1']], ['shop-project', null, null, []]])
      t.eq('the cycle resolved no issue', s.calls.dispositions, 0)
    }

    t.section('2. however the drive ends, the instance is destroyed and the snapshot released; a stage without a full suite never falls back to the base')
    {
      const issuesDir = await temp('devpanel-fvi-throw-')
      const verificationDir = path.join(issuesDir, '.verification')
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra() }, outcome: async () => { throw new Error('ssh: connection reset') } })
      const record = await (await cycle(s, verificationDir)).run()
      const app = record.projects[0]
      t.eq('the drive threw: red, the instance destroyed, the snapshot released', [app.verdict, app.refusal.message, s.calls.destroys.length, s.calls.releases.length, app.coverageEstablished], ['red', 'ssh: connection reset', 1, 1, false])
      t.eq('and its issue opened, naming the drive', s.calls.issues[0].input.includes(`on stage instance \`${instanceName(driveIdOf(record.id, 'app-project'))}\``), true)

      const bare = seams({ issuesDir: await temp('devpanel-fvi-bare-'), infra: { 'app-project': instanceInfra({ fullSuite: false }) }, outcome: passing() })
      const bareRecord = await (await cycle(bare, path.join(bare.options.issues.ISSUES_DIR, '.verification'))).run()
      t.eq('no full suite: refused, nothing snapshotted, created or released', [bareRecord.projects[0].refusal.code, bare.calls.provisions.length, bare.calls.starts.length], ['FULL_SUITE_UNDECLARED', 0, 0])
    }

    t.section('3. declared browser checks: run when the full suite names a browser run, else the entry is incomplete, never green')
    {
      const bound = seams({ issuesDir: await temp('devpanel-fvi-browser-'), infra: { 'app-project': instanceInfra({ browser: true, suiteBrowser: true }) }, outcome: passing() })
      const boundRecord = await (await cycle(bound, path.join(bound.options.issues.ISSUES_DIR, '.verification'))).run()
      t.eq('the browser run follows the suite', bound.calls.targets[0].commands.map((c) => c.id).slice(-2), ['full-suite', 'full-browser'])
      t.eq('green, with the browser run in the evidence', [boundRecord.projects[0].verdict, boundRecord.projects[0].browser, boundRecord.projects[0].evidence.browser], ['green', 'declared', ['full-browser']])
      const unbound = seams({ issuesDir: await temp('devpanel-fvi-unbound-'), infra: { 'app-project': instanceInfra({ browser: true }) }, outcome: passing() })
      const record = await (await cycle(unbound, path.join(unbound.options.issues.ISSUES_DIR, '.verification'))).run()
      const app = record.projects[0]
      t.eq('modules.browser without an instance browser run: incomplete, the cycle red', [app.verdict, app.incomplete.reason, record.verdict], ['incomplete', 'BROWSER_CHECKS_UNBOUND', 'red'])
      t.eq('no checkpoint ran, its issue opened and names why', [unbound.calls.actions.length, unbound.calls.issues.length, unbound.calls.issues[0].input.includes('BROWSER_CHECKS_UNBOUND')], [0, 1, true])
      t.eq('its deliveries stay counted: no coverage established', app.coverageEstablished, false)
    }

    t.section('4. the delivery trigger: ten per stage since the last cycle that covered them; a cycle that tested nothing holds the stage back, a red one that tested retires what it covered')
    {
      const issuesDir = await temp('devpanel-fvi-trigger-')
      const verificationDir = path.join(issuesDir, '.verification')
      const deliveries = { 'app-project': [], 'shop-project': [] }
      const delivered = (project, n, at) => { for (let i = 0; i < n; i++) deliveries[project].push({ issueId: `${project}-i${deliveries[project].length}`, runId: `${project}-r${deliveries[project].length}`, at }) }
      let outcome = readinessFails
      let threshold = 10
      const indeterminate = new Set()
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra(), 'shop-project': instanceInfra() }, outcome: (target, x) => outcome(target, x), deliveries,
        covered: (project, candidates) => ({ covered: (candidates ?? []).filter((r) => !indeterminate.has(r)), indeterminate: (candidates ?? []).filter((r) => indeterminate.has(r)) }) })
      const clock = manualClock(Date.parse('2026-11-14T09:00:00.000Z'))
      const fv = createFullVerification({ ...s.options, clock, verificationDir, afterDeliveries: () => threshold })
      const check = async () => { const c = await fv.deliveryCheck(); await fv.settle(); return c?.stages?.[0] }
      delivered('app-project', 6, '2026-11-14T08:00:00.000Z')
      delivered('shop-project', 3, '2026-11-14T08:00:00.000Z')
      const nine = await check()
      t.eq('two projects on one stage add up; nine: no cycle', [nine.host, nine.projects, nine.count, nine.due, s.calls.freezes.length], [HOST, ['app-project', 'shop-project'], 9, false, 0])
      delivered('shop-project', 1, '2026-11-14T08:30:00.000Z')
      await check()
      const first = await readJson(path.join(verificationDir, '2026-11-14', 'cycle.json'))
      t.eq('the tenth starts a cycle by itself, naming the stage and the deliveries', [s.calls.freezes.length, first.trigger, first.deliveries.host, first.deliveries.count, first.deliveries.threshold], [1, 'deliveries', HOST, 10, 10])
      t.eq('readiness failed, so the suite never ran: the drive is failed and nothing was proved', [first.projects[0].check.result, first.projects[0].suiteRan, first.projects[0].coverageEstablished], ['failed', null, false])
      const held = await check()
      t.eq('its deliveries still count, and the stage is held back instead of starting again at once', [held.count, held.due, held.suppressed?.sinceCycle, held.suppressed?.needs, s.calls.freezes.length], [10, false, first.id, 10, 1])
      t.eq('a hand start is never held', (await fv.startNow({ by: 'tester' }).then((r) => r.trigger)), 'hand')
      await fv.settle()
      // The hand cycle above tested nothing either: the back-off stays with the latest automatic cycle.
      outcome = passing(1)
      indeterminate.add('app-project-r2')
      delivered('app-project', 10, '2026-11-14T10:00:00.000Z')
      clock.advance(2 * 60 * 60 * 1000)
      await check()
      const second = await readJson(path.join(verificationDir, '2026-11-14', 'cycle.json'))
      t.eq('ten more after that cycle began: the next one starts', [second.trigger, second.deliveries.count], ['deliveries', 20])
      t.eq('its suite failed its own test: red, and the suite ran', [second.verdict, second.projects[0].suiteRan?.passed, second.projects[0].coverageEstablished], ['red', false, true])
      const after = await check()
      t.eq('what was delivered before its snapshot stops counting, the delivery whose bytes it could not find included', [after.count, after.runs.map((r) => r.runId), after.due], [0, [], false])
      t.eq('the record still says which was which', [second.projects[0].coverage.indeterminate.map((c) => c.runId), second.projects[0].coverage.covered.some((c) => c.runId === 'app-project-r2')], [['app-project-r2'], false])
      threshold = 0
      delivered('app-project', 20, '2026-11-14T12:00:00.000Z')
      const off = await fv.deliveryCheck()
      t.eq('afterDeliveries 0: the trigger is off', [s.calls.freezes.length, off?.threshold], [3, 10])
    }

    // 5. What writes the checkout (run-exclusivity.mjs writesCheckout) is tested in run-exclusivity.test.mjs.

    t.section('6. the freeze asks and waits for writing runs only; deliveries are refused, and one caught in admission is waited for and refused before it delivers')
    {
      const dir = await temp('devpanel-fvi-freeze-')
      let release
      const held = new Promise((resolve) => { release = resolve })
      let getIssueCalls = 0
      const issues = {
        getRunHolder: async (project, id) => ({ id, project, path: path.join(dir, id), packed: false }),
        getIssue: async (project, id) => { getIssueCalls++; if (id === 'held') await held; return { id, project, path: path.join(dir, id), packed: false } },
        listIssues: async () => [], listProjects: async () => []
      }
      const delivered = []
      await fs.mkdir(path.join(dir, 'app-project'), { recursive: true })
      // Blocked at delivery with its worktree kept: what Finalize is offered for.
      const blocked = { status: 'blocked', blockedReason: 'delivery-unverifiable', outcome: 'unresolved', participants: {}, workspace: { path: path.join(dir, 'worktree'), state: 'active' } }
      let supervisor = null
      const resumeEngine = async ({ runId, issuePath }) => ({ runId, issuePath, run: structuredClone(blocked), runLock: { release: async () => {} }, finalizeLimits: () => ({}),
        // The run of section 7 sees a freeze begin while it delivers.
        finalize: async () => { delivered.push(runId); if (runId === 'auto-run') await supervisor.freeze('2026-11-14.2'); return 'delivered' },
        reconcileDelivery: async () => { delivered.push(runId) } })
      supervisor = createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir, resumeEngine })
      t.ok('the fake run waits at delivery, so finalize is offered for it', supportedActions(blocked).includes('finalize'), JSON.stringify(supportedActions(blocked)))
      const asked = []
      const engineOf = () => ({ run: { status: 'running' }, requestFreeze (cycleId) { asked.push(cycleId); return null } })
      // Runs of another project, so the finalize below shares nothing with them (run-exclusivity.mjs).
      supervisor.active.set('lib-project/writing', { runId: 'w', project: 'lib-project', issueId: 'writing', phase: 'run', engine: engineOf(), writes: true })
      supervisor.active.set('lib-project/reading', { runId: 'r', project: 'lib-project', issueId: 'reading', phase: 'run', engine: engineOf(), writes: false })
      // A finalize admitted before the freeze, held inside admission (its getIssue), not active yet.
      const pending = supervisor.finalize({ project: 'app-project', issueId: 'held', runId: 'held-run' }).then(() => 'delivered', (error) => error.code ?? error.message)
      await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('it is held inside its admission', [getIssueCalls, supervisor.active.has('app-project/held')], [1, false])
      const frozen = await supervisor.freeze('2026-11-14.1')
      t.eq('the freeze asks the writing run and names the delivery being admitted; the reading run is left alone', [frozen.map((r) => r.runId), asked.length], [['w', 'held-run'], 1])
      t.eq('the cycle waits for both, and not for the reading run', supervisor.busy().map((r) => [r.runId, r.phase, r.pending === true]), [['w', 'run', false], ['held-run', 'finalize', true]])
      let refused = null
      try { await supervisor.finalize({ project: 'app-project', issueId: 'other', runId: 'other-run' }) } catch (error) { refused = error.code }
      t.eq('a finalize asked for during the freeze is refused before anything is read', [refused, getIssueCalls, supervisor.busy().length], ['FULL_VERIFICATION_FREEZE', 1, 2])
      try { await supervisor.reconcileDelivery({ project: 'app-project', issueId: 'other', runId: 'other-run' }) } catch (error) { refused = error.code }
      t.eq('a reconcile too', refused, 'FULL_VERIFICATION_FREEZE')
      release()
      t.eq('the held finalize reaches its re-check and is refused there, delivering nothing', [await pending, delivered], ['FULL_VERIFICATION_FREEZE', []])
      supervisor.active.delete('lib-project/writing')
      t.eq('then nothing is left to wait for', supervisor.busy(), [])
      supervisor.thaw('2026-11-14.1')
      t.eq('after the thaw a finalize delivers', [await supervisor.finalize({ project: 'app-project', issueId: 'later', runId: 'later-run' }).then((r) => r.runId, (e) => e.message), delivered], ['later-run', ['later-run']])

      t.section('7. an automatic reconcile due while frozen is put off, not spent, and tried once when admission opens again')
      // A run whose end asks for an automatic reconcile (run-control.mjs reconcilePending); it ends as a freeze begins.
      const runDir = path.join(dir, 'auto', 'runs', 'auto-run')
      await fs.mkdir(runDir, { recursive: true })
      const at = '2026-11-14T09:30:00.000Z'
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'auto-run', status: 'blocked', blockedReason: 'source-delivery-blocked', outcome: 'unresolved', autoReconcile: { state: 'pending', at } }))
      const stateOf = async () => (await readJson(path.join(runDir, 'run.json'))).autoReconcile
      await supervisor.finalize({ project: 'app-project', issueId: 'auto', runId: 'auto-run' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      t.eq('its end came during the freeze: the reconcile is still pending, nothing decided it', [supervisor.frozen()?.cycleId, await stateOf()], ['2026-11-14.2', { state: 'pending', at }])
      supervisor.thaw('2026-11-14.2')
      const end = Date.now() + 5000
      while ((await stateOf()).state === 'pending' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('after the thaw it is tried, once, and its own answer is recorded (here it cannot run on this record)', (await stateOf()).state, 'not-run')
      supervisor.active.clear()
    }

    t.section('7b. a freeze scoped to the cycle\'s projects: a project outside it delivers, finalizes, reconciles and auto-reconciles; one inside is refused as before')
    {
      const dir = await temp('devpanel-fvi-scope-')
      let release
      const held = new Promise((resolve) => { release = resolve })
      const issues = {
        getRunHolder: async (project, id) => ({ id, project, path: path.join(dir, id), packed: false }),
        getIssue: async (project, id) => { if (id === 'held') await held; return { id, project, path: path.join(dir, id), packed: false } },
        listIssues: async () => [], listProjects: async () => []
      }
      const delivered = []
      await fs.mkdir(path.join(dir, 'app-project'), { recursive: true })
      const blocked = { status: 'blocked', blockedReason: 'delivery-unverifiable', outcome: 'unresolved', participants: {}, workspace: { path: path.join(dir, 'worktree'), state: 'active' } }
      const resumeEngine = async ({ runId, issuePath }) => ({ runId, issuePath, run: structuredClone(blocked), runLock: { release: async () => {} }, finalizeLimits: () => ({}),
        finalize: async () => { delivered.push(runId); return 'delivered' },
        reconcileDelivery: async () => { delivered.push(`reconcile:${runId}`) } })
      const supervisor = createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir: path.join(dir, 'harness'), projectsDir: dir, configRoot: dir, resumeEngine })
      const asked = []
      const engineOf = (name) => ({ run: { status: 'running' }, requestFreeze (cycleId) { asked.push([name, cycleId]); return null } })
      supervisor.active.set('lib-project/writing', { runId: 'w', project: 'lib-project', issueId: 'writing', phase: 'run', engine: engineOf('lib'), writes: true })
      supervisor.active.set('tool-project/writing', { runId: 'o', project: 'tool-project', issueId: 'writing', phase: 'run', engine: engineOf('tool'), writes: true })
      // An app-project finalize caught in its admission when the freeze begins: outside the scope, never waited for.
      const pending = supervisor.finalize({ project: 'app-project', issueId: 'held', runId: 'held-run' }).then(() => 'delivered', (error) => error.code ?? error.message)
      await new Promise((resolve) => setTimeout(resolve, 20))
      const frozen = await supervisor.freeze('2026-11-14.3', { projects: ['lib-project'] })
      t.eq('only the scope\'s writing run is asked and listed; the out-of-scope run and admission are not', [frozen.map((r) => r.runId), asked], [['w'], [['lib', '2026-11-14.3']]])
      t.eq('the cycle waits only for the scope', supervisor.busy().map((r) => r.runId), ['w'])
      t.eq('the freeze names its projects', supervisor.frozen().projects, ['lib-project'])
      t.eq('a finalize outside the scope delivers during the freeze', await supervisor.finalize({ project: 'app-project', issueId: 'out', runId: 'out-run' }).then((r) => r.runId, (e) => e.code ?? e.message), 'out-run')
      // This fake run is not an apply-to-source delivery, so the reconcile stops at the run's own check: past the freeze.
      const reconciled = await supervisor.reconcileDelivery({ project: 'app-project', issueId: 'out2', runId: 'out2-run' }).then((r) => r.runId, (e) => e.code ?? e.message)
      t.ok('a reconcile outside the scope is not refused for the cycle: it reaches the run\'s own check', reconciled !== 'FULL_VERIFICATION_FREEZE' && /cannot be reconciled/.test(reconciled), reconciled)
      release()
      t.eq('the held finalize outside the scope passes its re-check and delivers', await pending, 'delivered')
      let refused = null
      try { await supervisor.finalize({ project: 'lib-project', issueId: 'in', runId: 'in-run' }) } catch (error) { refused = error.code }
      t.eq('a finalize inside the scope is refused as before', refused, 'FULL_VERIFICATION_FREEZE')
      refused = null
      try { await supervisor.reconcileDelivery({ project: 'lib-project', issueId: 'in', runId: 'in-run' }) } catch (error) { refused = error.code }
      t.eq('a reconcile inside the scope too', refused, 'FULL_VERIFICATION_FREEZE')
      t.eq('what was delivered: only the out-of-scope runs', delivered.sort(), ['held-run', 'out-run'])
      // An automatic reconcile of an out-of-scope run, due while frozen, is tried at once rather than put off.
      const runDir = path.join(dir, 'auto', 'runs', 'auto-run')
      await fs.mkdir(runDir, { recursive: true })
      const at = '2026-11-14T09:30:00.000Z'
      await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'auto-run', status: 'blocked', blockedReason: 'source-delivery-blocked', outcome: 'unresolved', autoReconcile: { state: 'pending', at } }))
      await supervisor.finalize({ project: 'app-project', issueId: 'auto', runId: 'auto-run' })
      const end = Date.now() + 5000
      while ((await readJson(path.join(runDir, 'run.json'))).autoReconcile.state === 'pending' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
      t.eq('the automatic reconcile outside the scope is decided while the cycle is still frozen', [supervisor.frozen()?.cycleId, (await readJson(path.join(runDir, 'run.json'))).autoReconcile.state], ['2026-11-14.3', 'not-run'])
      supervisor.thaw('2026-11-14.3')
      supervisor.active.clear()
    }

    t.section('8. the host is protected by any project\'s instances, one verified through its instances included; the snapshot is always the working tree')
    {
      const skipped = { ...instanceInfra(), staging: { ...instanceInfra().staging, fullVerification: 'instances' } }
      const s = seams({ issuesDir: await temp('devpanel-fvi-skipped-'), infra: { 'framework-project': skipped, 'shop-project': releaseInfra(HOST) }, outcome: passing() })
      const record = await (await cycle(s, path.join(s.options.issues.ISSUES_DIR, '.verification'))).run()
      const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
      t.eq('the declaring project is verified through its instances; the host is still protected', [by['framework-project'].verifiedThrough, record.protectedHosts], ['instances', { [HOST]: ['framework-project'] }])
      t.eq('the release-mode project on that host is refused, never started', [by['shop-project'].verdict, by['shop-project'].refusal?.code, s.calls.starts.length, s.calls.resolves], ['red', 'HOST_HAS_INSTANCES', 0, []])

      const head = seams({ issuesDir: await temp('devpanel-fvi-head-'), infra: { 'app-project': instanceInfra() }, outcome: passing(), workspace: { base: 'head', requireCleanBase: true, symlinks: 'materialize' } })
      await (await cycle(head, path.join(head.options.issues.ISSUES_DIR, '.verification'))).run()
      const policy = head.calls.provisions[0].policy
      t.eq('a project whose runs take HEAD: the cycle still snapshots the checkout as it stands', [policy.base, policy.requireCleanBase, policy.symlinks], ['working-tree', false, 'materialize'])
    }

    t.section('9. a cycle that recovery ends is told to the supervisor once it exists, once; a normal end is recorded as told')
    {
      const issuesDir = await temp('devpanel-fvi-recover-')
      const verificationDir = path.join(issuesDir, '.verification')
      await fs.mkdir(path.join(verificationDir, '2026-11-13'), { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-13', 'cycle.json'), JSON.stringify({ id: '2026-11-13.1', date: '2026-11-13', trigger: 'deliveries', state: 'running', verdict: null, projects: [] }))
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra() }, outcome: passing() })
      let ready = false
      const told = []
      const fv = createFullVerification({ ...s.options, verificationDir, clock: manualClock(Date.parse('2026-11-14T08:00:00.000Z')),
        onEnded: (notice) => { if (!ready) throw new Error('the top-level supervisor is not ready yet'); told.push(notice) } })
      await fv.recover()
      const owed = await readJson(path.join(verificationDir, '2026-11-13', 'cycle.json'))
      t.eq('recovery marks it interrupted and owes the announcement; nobody is told yet', [owed.state, owed.announce, told.length], ['interrupted', 'pending', 0])
      t.eq('asked before the supervisor exists, it stays owed', [await fv.announcePending(), (await readJson(path.join(verificationDir, '2026-11-13', 'cycle.json'))).announce], [[], 'pending'])
      ready = true
      t.eq('once it exists, it is told', await fv.announcePending(), ['2026-11-13.1'])
      t.eq('as an interrupted cycle, with the record', [told[0].cycleId, told[0].state, told[0].record], ['2026-11-13.1', 'interrupted', path.join(verificationDir, '2026-11-13', 'cycle.json')])
      t.eq('and only once', [await fv.announcePending(), told.length, (await readJson(path.join(verificationDir, '2026-11-13', 'cycle.json'))).announce], [[], 1, 'delivered'])
      const started = await fv.startNow({ by: 'tester' })
      await fv.settle()
      t.eq('a cycle that ends normally is told at its end and recorded as told', [told.length, told.at(-1).cycleId, (await readJson(path.join(verificationDir, started.date, 'cycle.json'))).announce], [2, started.id, 'delivered'])
    }

    t.section('9b. a replayed announcement names the file that holds its own cycle, after a later cycle of the date rotated it')
    {
      const issuesDir = await temp('devpanel-fvi-rotate-')
      const verificationDir = path.join(issuesDir, '.verification')
      const s = seams({ issuesDir, infra: { 'app-project': instanceInfra() }, outcome: passing() })
      let ready = false
      const told = []
      const fv = createFullVerification({ ...s.options, verificationDir, clock: manualClock(Date.parse('2026-11-14T08:00:00.000Z')),
        onEnded: (notice) => { if (!ready) throw new Error('the top-level supervisor is not ready yet'); told.push(notice) } })
      const a = await fv.startNow({ by: 'tester' })
      await fv.settle()
      const b = await fv.startNow({ by: 'tester' })
      await fv.settle()
      const day = path.join(verificationDir, a.date)
      t.eq('cycle A was rotated to cycle.1.json by cycle B, both still owed', [(await readJson(path.join(day, 'cycle.1.json'))).id, (await readJson(path.join(day, 'cycle.json'))).id, told.length], [a.id, b.id, 0])
      ready = true
      t.eq('both are told once the supervisor exists, oldest first', await fv.announcePending(), [a.id, b.id])
      const [ofA, ofB] = told
      t.eq('A\'s notice names A\'s own record file, never B\'s', [ofA.cycleId, ofA.record, (await readJson(ofA.record)).id], [a.id, path.join(day, 'cycle.1.json'), a.id])
      t.ok('and A\'s evidence', ofA.projects[0].evidence.startsWith(path.join(day, a.id, 'app-project')), ofA.projects[0].evidence)
      t.eq('B\'s names cycle.json', [ofB.cycleId, ofB.record], [b.id, path.join(day, 'cycle.json')])
      t.eq('each is recorded as told in its own file', [(await readJson(path.join(day, 'cycle.1.json'))).announce, (await readJson(path.join(day, 'cycle.json'))).announce], ['delivered', 'delivered'])
    }

    t.section('10. the supervisor reads the records and evidence, and nothing outside them')
    {
      const issuesDir = await temp('devpanel-fvi-read-')
      const verificationDir = path.join(issuesDir, '.verification')
      const evidence = path.join(verificationDir, '2026-11-14', '2026-11-14.1', 'app-project', 'checks', 'full-verification')
      await fs.mkdir(evidence, { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-14', 'cycle.json'), JSON.stringify({ id: '2026-11-14.1' }))
      await fs.writeFile(path.join(evidence, 'collect-log.stdout'), 'READY\n' + 'x'.repeat(VERIFICATION_PAGE_CHARS + 10))
      await fs.writeFile(path.join(issuesDir, 'secret.txt'), 'not yours')
      await fs.symlink(path.join(issuesDir, 'secret.txt'), path.join(evidence, 'leak.stdout'))
      const read = (p, offset) => readVerificationFile({ verificationDir, path: p, offset }).catch((e) => ({ refused: e.status, message: e.message }))
      t.eq('a cycle record, by its path relative to the records', JSON.parse((await read('2026-11-14/cycle.json')).text).id, '2026-11-14.1')
      const page = await read(path.join(evidence, 'collect-log.stdout'))
      t.eq('an evidence file, by the absolute path an event gives, paged', [page.text.startsWith('READY'), page.truncated, page.next], [true, true, VERIFICATION_PAGE_CHARS])
      t.eq('and read on to its end', [(await read(path.join(evidence, 'collect-log.stdout'), page.next)).text.length, (await read(path.join(evidence, 'collect-log.stdout'), page.next)).next], ['READY\n'.length + 10, undefined])
      t.eq('an evidence directory is listed', (await read(evidence)).entries.map((e) => e.name), ['collect-log.stdout', 'leak.stdout'])
      t.eq('a parent step out is refused', (await read('../secret.txt')).refused, 403)
      t.eq('an absolute path outside is refused', (await read(path.join(issuesDir, 'secret.txt'))).refused, 403)
      t.eq('a link leading outside is refused', (await read(path.join(evidence, 'leak.stdout'))).refused, 403)
      t.eq('a path that does not exist is not found', (await read('2026-11-14/nothing.json')).refused, 404)
    }

    t.section('11. a read-only run started during the freeze runs through the real start path, never frozen; a writing one is refused')
    {
      const f = await engineFixture({ playbook: 'analysis' })
      const dir = await temp('devpanel-fvi-start-')
      const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
      try {
        const projectsDir = path.join(f.issuesDir, 'projects')
        await fs.mkdir(projectsDir, { recursive: true })
        await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project')).catch(() => {})
        process.env.DEVPANEL_PROJECTS_DIR = projectsDir
        process.env.DEVPANEL_FAKE_CONTROL = path.join(dir, 'control.json')
        await fs.writeFile(process.env.DEVPANEL_FAKE_CONTROL, JSON.stringify({ ledger: path.join(dir, 'ledger.jsonl'), delayMs: 0 }))
        await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs'))}\n`)
        const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
        await supervisor.freeze('2026-11-14.9')
        const issue = await f.issues.createIssue('devpanel-project', { name: 'Read while frozen' })
        const { runId } = await supervisor.start({ project: 'devpanel-project', issueId: issue.id, playbookId: 'analysis', configRoot: f.configRoot })
        await supervisor.settle()
        const run = JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
        const events = (await fs.readFile(path.join(issue.path, 'runs', runId, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
        t.ok('the analysis started while frozen, and its engine was never asked to freeze', !events.some((e) => e.type === 'freeze-requested') && run.freezeRequested == null && run.pause?.kind !== 'full-verification', JSON.stringify({ status: run.status, pause: run.pause, types: events.map((e) => e.type).slice(0, 12) }))
        t.ok('it took turns during the freeze', events.some((e) => /step|turn/.test(e.type)), events.map((e) => e.type).join(','))
        t.eq('the cycle does not wait for it', supervisor.busy(), [])
        let refused = null
        try { await supervisor.start({ project: 'devpanel-project', issueId: (await f.issues.createIssue('devpanel-project', { name: 'Write while frozen' })).id, playbookId: 'implementation', configRoot: f.configRoot }) } catch (error) { refused = error.code }
        t.eq('an implementation (it delivers) is refused through the same path', refused, 'FULL_VERIFICATION_FREEZE')
        supervisor.thaw('2026-11-14.9')
      } finally {
        for (const [key, env] of [['projects', 'DEVPANEL_PROJECTS_DIR'], ['control', 'DEVPANEL_FAKE_CONTROL']]) {
          if (saved[key] === undefined) delete process.env[env]
          else process.env[env] = saved[key]
        }
      }
    }

    // A framework and an instance naming it, both on dynamic instances. The instance's snapshot materializes the
    // framework's lib/ as fw/. Each scenario says what the recheck finds, how the checkouts read around the snapshot,
    // and what each checkpoint commits; the git seams are fakes, so nothing here touches a repository.
    const T0 = Date.parse('2026-11-14T08:59:00.000Z')
    const FRAMEWORK = '/fixture/framework-project'
    const SITE = '/fixture/site-project'
    const pool = ({ suiteFails = [], recheckOf = () => null, movingIn = [], unreadIn = [], failAction = null, commitUntested = {}, covered = () => ({}), linked = true } = {}) => {
      const s = seams({ issuesDir: null, infra: { 'framework-project': instanceInfra(), 'site-project': instanceInfra() }, outcome: async (target, { runId }) => passing(suiteFails.some((p) => runId.endsWith(p.replace(/[^a-z0-9]+/g, '-'))) ? 1 : 0)(target), covered })
      const heads = { [FRAMEWORK]: 'f0', [SITE]: 's0' }
      Object.assign(s.calls, { rechecks: [], compared: [], readings: [] })
      Object.assign(s.options, {
        projectsConfig: async () => new Map([['framework-project', { id: 'framework-project' }], ['site-project', { id: 'site-project', framework: 'framework-project' }]]),
        provision: async (args) => {
          s.calls.provisions.push(args)
          const p = path.join(args.root, `worktree-${args.runId}`)
          await fs.mkdir(p, { recursive: true })
          const project = args.projectPath.split('/').pop()
          const again = args.runId.endsWith('-recheck')
          if (again) s.calls.rechecks.push(project)
          return { path: p, baseCommit: again ? (recheckOf(project) ? `moved-${project}` : `snap-${project}`) : `snap-${project}`, isolation: 'git-worktree' }
        },
        recordSnapshot: async ({ projectDir }) => ({ repository: `${projectDir}/.git`, ownCommit: 'own', excludes: [], links: projectDir === SITE && linked ? [{ path: 'fw', owner: FRAMEWORK, prefix: 'lib', consumerExcludes: [], skipped: [] }] : [] }),
        compareSnapshots: async ({ to }) => ({ sameTree: false, moved: recheckOf(to.replace('moved-', '')) }),
        readMotion: async ({ projectDir, extra = [] }) => {
          const after = s.calls.readings.filter((r) => r === projectDir).length % 2 === 1
          s.calls.readings.push(projectDir)
          const project = projectDir.split('/').pop()
          const paths = movingIn.includes(project) ? { 'lib/thread.js': { mtimeMs: after ? T0 + 30000 : T0 - 60000, size: after ? 120 : 80 } } : { 'notes.txt': { mtimeMs: T0 - 3 * 60 * 60 * 1000, size: 5 } }
          return { at: after ? T0 + 60000 : T0, checkouts: [unreadIn.includes(project) && after ? { checkout: projectDir, error: 'git status: not a git repository' } : { checkout: projectDir, paths }, ...extra.map((c) => ({ checkout: c, paths: {} }))] }
        },
        headOf: async (checkout) => heads[checkout],
        runAction: async (a) => {
          s.calls.actions.push(a)
          const checkout = `/fixture/${a.project}`
          heads[checkout] = `${heads[checkout]}+1`
          return a.project === failAction ? { id: 'op-fail', status: 'failed', exitCode: 2 } : { status: 'completed' }
        },
        compareCommit: async (args) => {
          s.calls.compared.push({ checkout: args.checkout, commit: args.commit, headBefore: args.headBefore, views: args.views.map((v) => [v.repository, v.at, v.prefix]) })
          const untested = commitUntested[args.checkout] ?? []
          return { state: 'compared', commit: args.commit, untested: { paths: untested.map((p) => ({ path: p, reason: 'differs-from-tested' })), total: untested.length }, bumped: [], views: args.views.length }
        }
      })
      return s
    }
    const poolCycle = async (s, prefix) => {
      const issuesDir = await temp(prefix)
      s.options.issues.ISSUES_DIR = issuesDir
      return (await cycle(s, path.join(issuesDir, '.verification'), manualClock(Date.parse('2026-11-14T09:00:00.000Z')))).run()
    }

    t.section('11b. a writing run of a project outside the cycle\'s scope starts through the real start path and is never frozen')
    {
      const f = await engineFixture({ playbook: 'analysis' })
      const dir = await temp('devpanel-fvi-start-scope-')
      const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
      try {
        const projectsDir = path.join(f.issuesDir, 'projects')
        await fs.mkdir(projectsDir, { recursive: true })
        await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project')).catch(() => {})
        process.env.DEVPANEL_PROJECTS_DIR = projectsDir
        process.env.DEVPANEL_FAKE_CONTROL = path.join(dir, 'control.json')
        await fs.writeFile(process.env.DEVPANEL_FAKE_CONTROL, JSON.stringify({ ledger: path.join(dir, 'ledger.jsonl'), delayMs: 0 }))
        await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs'))}\n`)
        const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
        await supervisor.freeze('2026-11-14.8', { projects: ['app-project'] })
        const issue = await f.issues.createIssue('devpanel-project', { name: 'Write beside a cycle that does not verify this project' })
        let started = null
        try { started = await supervisor.start({ project: 'devpanel-project', issueId: issue.id, playbookId: 'implementation', configRoot: f.configRoot }) } catch (error) { started = { refused: error.code ?? error.message } }
        t.ok('an implementation (it delivers) of a project outside the scope is admitted', Boolean(started?.runId), JSON.stringify(started))
        t.eq('the cycle does not wait for it', supervisor.busy(), [])
        if (started?.runId) {
          // Driven to its own end while the cycle stays frozen.
          await supervisor.settle()
          const events = (await fs.readFile(path.join(issue.path, 'runs', started.runId, 'events.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
          const run = JSON.parse(await fs.readFile(path.join(issue.path, 'runs', started.runId, 'run.json'), 'utf8'))
          t.ok('it took seat turns while the cycle was frozen', events.some((e) => e.type === 'step'), JSON.stringify({ status: run.status, types: events.map((e) => e.type).slice(0, 12) }))
          t.ok('its engine was never asked to freeze, and it never paused for the cycle', !events.some((e) => e.type === 'freeze-requested' || e.type === 'turn-withheld') && run.freezeRequested == null && run.pause?.kind !== 'full-verification', JSON.stringify({ status: run.status, pause: run.pause, types: events.map((e) => e.type).slice(0, 12) }))
          t.ok('the cycle was frozen throughout', supervisor.frozen()?.cycleId === '2026-11-14.8')
        }
        supervisor.thaw('2026-11-14.8')
      } finally {
        for (const [key, env] of [['projects', 'DEVPANEL_PROJECTS_DIR'], ['control', 'DEVPANEL_FAKE_CONTROL']]) {
          if (saved[key] === undefined) delete process.env[env]
          else process.env[env] = saved[key]
        }
      }
    }

    t.section('12. a green cycle compares every checkout it snapshotted before the chain: unchanged, the chain runs and every commit is compared with the tested views (the framework derived from its instance)')
    {
      const s = pool()
      const record = await poolCycle(s, 'devpanel-fvi-unchanged-')
      const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
      t.eq('every green entry was rechecked before any checkpoint: the instance snapshotted again, the derived framework has no snapshot of its own', [s.calls.rechecks.sort(), by['framework-project'].recheck.state, by['site-project'].recheck.state], [['site-project'], 'no-snapshot', 'unchanged'])
      t.eq('the instance\'s recheck covers the framework checkout it read through its link', by['site-project'].recheck.checkouts, [SITE, FRAMEWORK])
      t.eq('nothing moved: the chain ran as before', s.calls.actions.map((a) => [a.project, a.args]), [['framework-project', ['--minor']], ['site-project', []]])
      t.eq('the cycle committed', [record.outcome.committed, record.outcome.bump.withheld, record.outcome.commitWithheld], [true, [], undefined])
      t.eq('each commit compared with every tested view of its checkout: the framework\'s only through the instance\'s copy of lib, the instance\'s with its own link as a followed view', s.calls.compared.map((c) => [c.checkout, c.headBefore, c.commit, c.views]), [
        [FRAMEWORK, 'f0', 'f0+1', [[`${SITE}/.git`, 'fw', 'lib']]],
        [SITE, 's0', 's0+1', [[`${SITE}/.git`, '', ''], [`${SITE}/.git`, 'fw', 'fw']]]
      ])
      t.eq('nothing untested was committed', [record.outcome.bump.chain.map((c) => c.afterCommit.state), record.outcome.bump.untestedCommitted], [['compared', 'compared'], []])
      t.eq('the event says the cycle committed', [s.calls.ended[0].outcome.committed, s.calls.ended[0].outcome.withheld, s.calls.ended[0].projects.map((p) => [p.project, p.recheck, p.commitWithheld])], [true, [], [['framework-project', 'no-snapshot', false], ['site-project', 'unchanged', false]]])
    }

    t.section('12b. an instance whose snapshot materializes nothing of the framework: the framework is driven after it, as before, and says why')
    {
      const s = pool({ linked: false })
      const record = await poolCycle(s, 'devpanel-fvi-unlinked-')
      const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
      t.eq('both entries were driven, the framework after its instance', s.calls.provisions.filter((a) => !a.runId.endsWith('-recheck')).map((a) => a.projectPath), [SITE, FRAMEWORK])
      t.eq('the framework entry says it was not derived, and is a driven instance entry', [by['framework-project'].derivation?.state, by['framework-project'].mode, by['framework-project'].derived], ['not-derived', 'instance', undefined])
      t.eq('every green entry was snapshotted again before any checkpoint', [s.calls.rechecks.sort(), by['framework-project'].recheck.state, by['site-project'].recheck.state], [['framework-project', 'site-project'], 'unchanged', 'unchanged'])
      t.eq('each commit compared with every tested view of its checkout: the framework\'s own', s.calls.compared.map((c) => [c.checkout, c.views]), [
        [FRAMEWORK, [[`${FRAMEWORK}/.git`, '', '']]],
        [SITE, [[`${SITE}/.git`, '', '']]]
      ])
      t.eq('the chain ran and committed', [s.calls.actions.map((a) => [a.project, a.args]), record.outcome.committed], [[['framework-project', ['--minor']], ['site-project', []]], true])
    }

    t.section('13. a file edited after the snapshot withholds its pool\'s checkpoints and is named; the entries stay green; only the deliveries the snapshot held retire')
    {
      const s = pool({ recheckOf: (project) => project === 'site-project' ? [{ checkout: SITE, paths: ['src/cart.js'], total: 1 }] : null, covered: (project) => project === 'site-project' ? { covered: ['r1'], indeterminate: ['r2'] } : {} })
      s.options.deliveriesOf = async (project) => project === 'site-project' ? [{ issueId: 'i1', runId: 'r1', at: '2026-11-14T08:00:00.000Z' }, { issueId: 'i2', runId: 'r2', at: '2026-11-14T08:10:00.000Z' }] : []
      const record = await poolCycle(s, 'devpanel-fvi-moved-')
      const site = record.projects.find((p) => p.project === 'site-project')
      t.eq('no checkpoint ran for the pool', s.calls.actions, [])
      t.eq('the entries stay green as test results', [record.verdict, record.projects.map((p) => p.verdict)], ['green', ['green', 'green']])
      t.eq('the outcome names the checkout that moved and its path; the cycle did not commit', [record.outcome.committed, record.outcome.commitWithheld, record.outcome.bump.withheld], [false, true, [{ framework: 'framework-project', members: ['framework-project', 'site-project'], moved: [{ project: 'site-project', state: 'moved', checkouts: [{ checkout: SITE, paths: ['src/cart.js'], total: 1 }] }] }]])
      t.eq('every member entry says its commit was withheld', record.projects.map((p) => [p.project, p.commitWithheld?.framework]), [['framework-project', 'framework-project'], ['site-project', 'framework-project']])
      t.eq('the record says which deliveries it retires: only those whose bytes the snapshot held', site.coverage.retires, { rule: 'covered-only', reason: 'commit withheld: only the deliveries whose bytes the tested snapshot held are retired; the indeterminate ones keep counting', runIds: ['r1'] })
      const notice = s.calls.ended[0]
      t.eq('the verification-ended event carries it', [notice.verdict, notice.outcome.committed, notice.outcome.withheld[0].moved[0].checkouts[0].paths, notice.projects.find((p) => p.project === 'site-project').commitWithheld], ['green', false, ['src/cart.js'], true])
      const counts = await deliveryCounts({ stages: [{ host: HOST, stage: 'stage', projects: ['site-project'] }], deliveriesOf: s.options.deliveriesOf, records: [record], threshold: 1 })
      t.eq('the indeterminate delivery keeps counting, the covered one retired', counts[0].runs.map((r) => r.runId), ['r2'])
      const automatic = { ...record, trigger: 'deliveries', deliveries: { host: HOST } }
      const held = await deliveryCounts({ stages: [{ host: HOST, stage: 'stage', projects: ['site-project'] }], deliveriesOf: s.options.deliveriesOf, records: [automatic], threshold: 1 })
      t.eq('an automatic cycle that withheld its commit holds the stage back like one that tested nothing', [held[0].due, held[0].suppressed?.sinceCycle, /withheld its commit/.test(held[0].suppressed?.reason ?? '')], [false, record.id, true])
    }

    t.section('14. a framework edit seen through an instance\'s link withholds the whole pool, the framework\'s own checkpoint and its instances\'')
    {
      const s = pool({ recheckOf: (project) => project === 'site-project' ? [{ checkout: FRAMEWORK, paths: ['lib/thread.js'], total: 1 }] : null })
      const record = await poolCycle(s, 'devpanel-fvi-framework-')
      t.eq('the derived framework has no snapshot of its own; the instance\'s copy of it moved', record.projects.map((p) => [p.project, p.recheck.state]), [['framework-project', 'no-snapshot'], ['site-project', 'moved']])
      t.eq('no checkpoint ran: neither the framework\'s nor its instance\'s', [s.calls.actions, record.outcome.committed], [[], false])
      t.eq('the outcome names the framework checkout and its path', record.outcome.bump.withheld[0].moved[0].checkouts, [{ checkout: FRAMEWORK, paths: ['lib/thread.js'], total: 1 }])
    }

    t.section('15. a checkout moving at snapshot time is recorded on a red and on a green entry, and shown in cycle.json, the red issue and the event; no verdict changes')
    {
      // Unlinked, so the framework is driven and takes a snapshot of its own.
      const s = pool({ movingIn: ['framework-project', 'site-project'], suiteFails: ['site-project'], linked: false })
      const record = await poolCycle(s, 'devpanel-fvi-moving-')
      const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
      t.eq('both entries were moving at snapshot time; the verdicts are the suite\'s', record.projects.map((p) => [p.project, p.verdict, p.snapshotDuringEdits]), [['framework-project', 'green', true], ['site-project', 'red', true]])
      const m = by['site-project'].snapshotMotion
      t.eq('the newest change, the paths changed within the window and between the readings', [m.newest, m.recent.paths.map((p) => p.path), m.during.paths, m.windowMs], [{ checkout: SITE, path: 'lib/thread.js', at: new Date(T0 + 30000).toISOString() }, ['lib/thread.js'], [{ checkout: SITE, path: 'lib/thread.js' }], 5 * 60 * 1000])
      const issue = s.calls.issues.find((i) => i.project === 'site-project')
      t.ok('the red issue says the snapshot was taken during edits, with the moving path', issue.input.includes('Snapshot taken during edits') && issue.input.includes('## Moving paths at snapshot time') && issue.input.includes('`lib/thread.js`'), issue.input)
      const notice = s.calls.ended[0].projects
      t.eq('the event carries it for both, with the moving paths', notice.map((p) => [p.project, p.snapshotDuringEdits, p.movingPaths]), [['framework-project', true, [{ checkout: FRAMEWORK, path: 'lib/thread.js' }]], ['site-project', true, [{ checkout: SITE, path: 'lib/thread.js' }]]])
      const still = await poolCycle(pool({ linked: false }), 'devpanel-fvi-still-')
      t.eq('a checkout last changed hours before, unchanged between the readings: not moving', still.projects.map((p) => p.snapshotDuringEdits), [false, false])
      const blind = pool({ unreadIn: ['site-project'] })
      const unknown = await poolCycle(blind, 'devpanel-fvi-unread-')
      const site = unknown.projects.find((p) => p.project === 'site-project')
      t.eq('a checkout whose reading failed: unknown (null), never false, the failure named; the verdict unchanged', [site.snapshotDuringEdits, site.snapshotMotion.unread, site.verdict, blind.calls.ended[0].projects.find((p) => p.project === 'site-project').snapshotDuringEdits], [null, [{ checkout: SITE, error: 'git status: not a git repository' }], 'green', null])
    }

    t.section('16. every checkpoint attempt is compared, a failed one that committed included; a difference is reported, never reverted')
    {
      const s = pool({ failAction: 'framework-project', commitUntested: { [FRAMEWORK]: ['lib/slipped.js'] } })
      const record = await poolCycle(s, 'devpanel-fvi-failed-')
      const step = record.outcome.bump.chain[0]
      t.eq('the framework\'s checkpoint failed after committing; its commit was compared all the same', [step.status, step.headBefore, step.afterCommit.state, step.afterCommit.untested.paths], ['failed', 'f0', 'compared', [{ path: 'lib/slipped.js', reason: 'differs-from-tested' }]])
      t.eq('the committed-but-untested difference is in the outcome and the event', [record.outcome.bump.untestedCommitted, s.calls.ended[0].outcome.untestedCommitted.map((u) => u.paths)], [[{ project: 'framework-project', state: 'compared', commit: 'f0+1', paths: [{ path: 'lib/slipped.js', reason: 'differs-from-tested' }], total: 1 }], [[{ path: 'lib/slipped.js', reason: 'differs-from-tested' }]]])
      t.eq('no further action ran: nothing was reverted, the chain stopped as before', [s.calls.actions.map((a) => [a.project, a.actionId]), record.outcome.committed], [[['framework-project', 'checkpoint']], false])
    }

    t.section('17. a checkpoint the service stop interrupted is compared at the next start')
    {
      const dir = await temp('devpanel-fvi-recover-')
      const verificationDir = path.join(dir, '.verification')
      const step = { project: 'framework-project', framework: 'framework-project', action: 'checkpoint', args: ['--minor'], status: 'running', headBefore: 'f0', startedAt: '2026-11-14T09:30:00.000Z' }
      const entry = { project: 'framework-project', stage: 'stage', verdict: 'green', snapshot: { baseCommit: 'snap', repository: `${FRAMEWORK}/.git`, ownCommit: 'own', excludes: [], links: [] } }
      await fs.mkdir(path.join(verificationDir, '2026-11-14'), { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-14', 'cycle.json'), JSON.stringify({ id: '2026-11-14.1', date: '2026-11-14', state: 'outcome', projects: [entry], outcome: { verdict: 'green', committed: false, bump: { chain: [step], untestedCommitted: [] } } }))
      const s = pool({ commitUntested: { [FRAMEWORK]: ['lib/half.js'] } })
      s.options.headOf = async () => 'f0+1'
      const fv = createFullVerification({ ...s.options, issues: { ...s.options.issues, ISSUES_DIR: dir }, clock: manualClock(Date.parse('2026-11-14T10:00:00.000Z')), verificationDir })
      await fv.recover()
      const after = await readJson(path.join(verificationDir, '2026-11-14', 'cycle.json'))
      const recovered = after.outcome.bump.chain[0]
      t.eq('the step reads interrupted and its commit was compared by the recovery', [after.state, recovered.status, recovered.afterCommit.observedBy, recovered.afterCommit.untested.paths.map((p) => p.path)], ['interrupted', 'interrupted', 'recovery', ['lib/half.js']])
      t.eq('against the views the record kept', s.calls.compared.map((c) => [c.checkout, c.headBefore, c.commit, c.views]), [[FRAMEWORK, 'f0', 'f0+1', [[`${FRAMEWORK}/.git`, '', '']]]])
      t.eq('and it is in the outcome', after.outcome.bump.untestedCommitted.map((u) => [u.project, u.total]), [['framework-project', 1]])
    }

    t.section('18. a cycle shaped like 2026-11-17.2: the instance green, the framework\'s own drive would fail on the application deployed on the base; the framework is derived, green, and the chain commits')
    {
      // Driven, the framework's suite would fail; derived, it is never driven.
      const s = pool({ suiteFails: ['framework-project'] })
      const issuesDir = await temp('devpanel-fvi-derived-')
      s.options.issues.ISSUES_DIR = issuesDir
      const { fv, run } = await cycle(s, path.join(issuesDir, '.verification'))
      const record = await run()
      const by = Object.fromEntries(record.projects.map((p) => [p.project, p]))
      const frameworkDrive = driveIdOf(record.id, 'framework-project')
      t.eq('no instance, resolve, snapshot or suite for the framework', [s.calls.resolves, s.calls.provisions.filter((a) => a.runId === frameworkDrive).length, s.calls.targets.filter((tg) => tg.stageInstance.name === instanceName(frameworkDrive)).length, s.calls.destroys.includes(frameworkDrive)], [['site-project'], 0, 0, false])
      const fw = by['framework-project']
      t.eq('its entry is derived from the instance entry, and green', [fw.mode, fw.state, fw.verdict, fw.derived.from.map((f) => [f.project, f.verdict, f.state, f.suiteRan, f.coverageEstablished, f.links]), fw.derived.red, fw.driveId, fw.instance, fw.snapshot], ['derived', 'settled', 'green', [['site-project', 'green', 'settled', true, true, [{ path: 'fw', prefix: 'lib' }]]], [], undefined, undefined, undefined])
      t.eq('it establishes coverage like the entries it comes from; it is not a static verified-through entry', [fw.coverageEstablished, fw.suiteRan, fw.verifiedThrough], [true, true, undefined])
      t.eq('the cycle is green and the chain ran in the usual order, committing', [record.verdict, s.calls.actions.map((a) => [a.project, a.args]), record.outcome.committed], ['green', [['framework-project', ['--minor']], ['site-project', []]], true])
      const notice = s.calls.ended[0].projects
      t.eq('the verification-ended event names the derived entry and its instance entry', notice.map((p) => [p.project, p.mode, p.verdict, p.derived]), [['framework-project', 'derived', 'green', { from: ['site-project'], red: [], unmaterialized: 0 }], ['site-project', 'instance', 'green', null]])
      const latest = (await fv.latest()).cycle
      t.eq('the API (latest) carries the derived entry beside its instance entry', latest.projects.map((p) => [p.project, p.mode, p.derived?.from.map((f) => f.project) ?? null]), [['framework-project', 'derived', ['site-project']], ['site-project', 'instance', null]])
    }

    t.section('19. an instance entry red on a test makes the derived framework red; its issue names the instance entry and its failing tests')
    {
      const s = pool({ suiteFails: ['site-project'] })
      const record = await poolCycle(s, 'devpanel-fvi-derived-red-')
      const fw = record.projects.find((p) => p.project === 'framework-project')
      t.eq('the derived entry is red and names the instance entry', [fw.mode, fw.verdict, fw.derived.red.map((r) => [r.project, r.reason.startsWith('red')])], ['derived', 'red', [['site-project', true]]])
      t.eq('one issue per red project: the instance\'s own and the framework\'s', s.calls.issues.map((i) => i.project).sort(), ['framework-project', 'site-project'])
      const issue = s.calls.issues.find((i) => i.project === 'framework-project').input
      t.ok('the framework\'s issue says it is derived, from which entry, with that entry\'s failing test', issue.includes('No drive of its own') && issue.includes('- Derived from:') && issue.includes('`site-project`') && issue.includes('b: breaks') && issue.includes('From the instance entry of `site-project`') && issue.includes('## Failing tests of the instance entries it is derived from'), issue)
      t.ok('and never presents a drive of its own', !issue.includes(driveIdOf(record.id, 'framework-project')) && !issue.includes('- Drive:'), issue)
      t.eq('the event says which entry made it red', s.calls.ended[0].projects.find((p) => p.project === 'framework-project').derived.red.map((r) => r.project), ['site-project'])
    }

    t.section('20. a derived entry is never green on an instance entry that is refused, interrupted, incomplete, without its suite or without established coverage')
    {
      const ok = { project: 'site-project', state: 'settled', verdict: 'green', suiteRan: true, coverageEstablished: true }
      t.eq('every instance entry green, settled, suite run, coverage established: green', derivedVerdict([ok, { ...ok, project: 'shop-project' }]), { verdict: 'green', red: [] })
      const cases = [
        [{ state: 'refused', verdict: 'red', refusal: { code: 'X', message: 'no' }, coverageEstablished: false }, /^refused: X: no$/],
        [{ state: 'interrupted', verdict: 'red', coverageEstablished: false }, /^interrupted$/],
        [{ verdict: 'incomplete', incomplete: { reason: 'BROWSER_CHECKS_UNBOUND' }, coverageEstablished: false }, /^incomplete: BROWSER_CHECKS_UNBOUND$/],
        [{ verdict: 'red' }, /^red/],
        [{ suiteRan: false }, /whole suite did not run/],
        [{ coverageEstablished: false }, /coverage is not established/]
      ]
      for (const [patch, reason] of cases) {
        const got = derivedVerdict([{ ...ok, project: 'shop-project' }, { ...ok, ...patch }])
        t.ok(`${JSON.stringify(patch)}: red, naming site-project with why`, got.verdict === 'red' && got.red.length === 1 && got.red[0].project === 'site-project' && reason.test(got.red[0].reason), JSON.stringify(got))
      }
      t.eq('no instance entry at all: never green', derivedVerdict([]).verdict, 'red')
      const refused = pool()
      refused.options.drive = async () => { throw new Error('the stage host is gone') }
      const r = await poolCycle(refused, 'devpanel-fvi-derived-refused-')
      t.eq('an instance entry refused after its snapshot: the framework is derived and red', r.projects.map((p) => [p.project, p.mode, p.verdict, p.state]), [['framework-project', 'derived', 'red', 'settled'], ['site-project', 'instance', 'red', 'refused']])
      const incomplete = pool()
      const infra = { 'framework-project': instanceInfra(), 'site-project': instanceInfra({ browser: true }) }
      incomplete.options.infrastructureOf = async (project) => infra[project]
      const i = await poolCycle(incomplete, 'devpanel-fvi-derived-incomplete-')
      t.eq('an incomplete instance entry: the framework is derived and red', i.projects.map((p) => [p.project, p.verdict]), [['framework-project', 'red'], ['site-project', 'incomplete']])
    }

    t.section('21. the framework\'s deliveries are read through the instances\' copies; a delivery on a path no copy held is not retired and is listed')
    {
      const s = pool()
      const asked = []
      s.options.deliveriesOf = async (project) => project === 'framework-project' ? [{ issueId: 'i8', runId: 'r8', at: '2026-11-14T08:00:00.000Z' }, { issueId: 'i9', runId: 'r9', at: '2026-11-14T08:10:00.000Z' }] : []
      s.options.coverageOf = async (args) => {
        asked.push(args)
        return args.project === 'framework-project'
          ? { basis: 'instance-views', covered: [{ runId: 'r8' }], indeterminate: [{ runId: 'r9', reason: 'not-materialized', paths: ['version'] }], notShipped: [] }
          : { basis: 'cycle-snapshot', covered: [], indeterminate: [], notShipped: [] }
      }
      const record = await poolCycle(s, 'devpanel-fvi-derived-coverage-')
      const fw = record.projects.find((p) => p.project === 'framework-project')
      const q = asked.find((a) => a.project === 'framework-project')
      t.eq('the framework\'s coverage is asked through the instance\'s copy of it, for its deliveries still counting', [q.views.map((v) => [v.repository, v.commit, v.at, v.prefix]), q.candidates, q.snapshotPath, q.snapshotAt], [[[`${SITE}/.git`, 'snap-site-project', 'fw', 'lib']], ['r8', 'r9'], undefined, record.projects.find((p) => p.project === 'site-project').snapshotAt])
      t.eq('the entry keeps it and lists the path no copy held', [fw.coverage.basis, fw.coverage.covered.map((c) => c.runId), fw.coverage.indeterminate.map((c) => [c.runId, c.reason, c.paths]), fw.derived.unmaterialized], ['instance-views', ['r8'], [['r9', 'not-materialized', ['version']]], { paths: ['version'], total: 1 }])
      const counts = await deliveryCounts({ stages: [{ host: HOST, stage: 'stage', projects: ['framework-project'] }], deliveriesOf: s.options.deliveriesOf, records: [record], threshold: 1 })
      t.eq('the covered delivery retires; the one on a path no instance materializes keeps counting', counts[0].runs.map((r) => r.runId), ['r9'])
      t.eq('the event counts the untested paths', s.calls.ended[0].projects.find((p) => p.project === 'framework-project').derived.unmaterialized, 1)
    }

    t.section('22. a framework alone in a cycle (its instance is configured but has no entry) is driven exactly as before')
    {
      const s = seams({ issuesDir: null, infra: { 'framework-project': instanceInfra() }, outcome: passing() })
      s.options.projectsConfig = async () => new Map([['framework-project', { id: 'framework-project' }], ['site-project', { id: 'site-project', framework: 'framework-project' }]])
      const issuesDir = await temp('devpanel-fvi-alone-')
      s.options.issues.ISSUES_DIR = issuesDir
      const record = await (await cycle(s, path.join(issuesDir, '.verification'))).run()
      const fw = record.projects[0]
      const driveId = driveIdOf(record.id, 'framework-project')
      t.eq('one snapshot, one drive, one destroy of its own instance', [s.calls.provisions.filter((a) => !a.runId.endsWith('-recheck')).map((a) => a.runId), s.calls.targets.length, s.calls.destroys], [[driveId], 1, [driveId]])
      t.eq('a driven instance entry, neither derived nor deferred', [fw.mode, fw.state, fw.verdict, fw.derived, fw.derivation], ['instance', 'settled', 'green', undefined, undefined])
    }

    t.section('23. recover() after an interrupted cycle: a derived or deferred framework entry has no instance to destroy, no workspace and no run home')
    {
      const dir = await temp('devpanel-fvi-recover-derived-')
      const verificationDir = path.join(dir, '.verification')
      const site = { project: 'site-project', stage: 'stage', host: HOST, mode: 'instance', state: 'running', driveId: 'fv-x-site-project', instance: { name: instanceName('fv-x-site-project') } }
      const deriving = { project: 'framework-project', stage: 'stage', host: HOST, mode: 'derived', state: 'deriving', startedAt: '2026-11-14T09:20:00.000Z' }
      const deferred = { project: 'other-framework-project', stage: 'stage', host: HOST, mode: 'instance', state: 'deferred', derivation: { state: 'pending', instances: ['site-project'] } }
      await fs.mkdir(path.join(verificationDir, '2026-11-14'), { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-14', 'cycle.json'), JSON.stringify({ id: '2026-11-14.1', date: '2026-11-14', state: 'running', projects: [deriving, deferred, site] }))
      const s = pool()
      const fv = createFullVerification({ ...s.options, issues: { ...s.options.issues, ISSUES_DIR: dir }, clock: manualClock(Date.parse('2026-11-14T10:00:00.000Z')), verificationDir })
      await fv.recover()
      const after = await readJson(path.join(verificationDir, '2026-11-14', 'cycle.json'))
      t.eq('only the instance entry\'s drive is destroyed; nothing is released; no run home is asked for', [s.calls.destroys, s.calls.releases], [['fv-x-site-project'], []])
      t.eq('the derived and the deferred entries read interrupted, red, establishing nothing', after.projects.map((p) => [p.project, p.state, p.verdict, p.coverageEstablished, p.instance ?? null]), [
        ['framework-project', 'interrupted', 'red', false, null], ['other-framework-project', 'interrupted', 'red', false, null], ['site-project', 'interrupted', 'red', false, { name: instanceName('fv-x-site-project'), destroyed: { passed: true, at: '2026-11-14T10:00:00.000Z' } }]])
    }
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
