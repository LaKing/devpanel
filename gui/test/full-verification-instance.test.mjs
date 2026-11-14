import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createFullVerification, driveIdOf } from '../server/full-verification.mjs'
import { manualClock } from '../server/runtime/clock.mjs'
import { driveCommands, instanceName } from '../server/runtime/instance-drive.mjs'
import { writesCheckout } from '../server/run-exclusivity.mjs'
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
    resolve: async (playbookId, { projectId }) => { calls.resolves.push(projectId); return { ok: true, resolved: { configHash: `hash-${projectId}`, workspace, fence: { selection: 1, repository: 1 }, liveExecution: { blockers: [] } } } },
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

    t.section('5. what writes the checkout: delivery, release or in place; Analysis, Triage and inquiries only read')
    {
      t.eq('an analysis (no delivery, own worktree) reads', writesCheckout({ tactic: 'analysis', workspace: { isolation: 'git-worktree' }, completion: { delivery: { action: 'none' } } }), false)
      t.eq('a triage reads', writesCheckout({ tactic: 'triage', workspace: { isolation: 'git-worktree' }, completion: { delivery: { action: 'none' } } }), false)
      t.eq('an analysis in place writes', writesCheckout({ tactic: 'analysis', workspace: { isolation: 'in-place' }, completion: { delivery: { action: 'none' } } }), true)
      t.eq('a deployment writes', writesCheckout({ tactic: 'deployment', workspace: { isolation: 'git-worktree' }, completion: { delivery: { action: 'none' } } }), true)
      t.eq('an implementation that applies to the source writes', writesCheckout({ tactic: 'implementation', workspace: { isolation: 'git-worktree' }, completion: { delivery: { action: 'apply-to-source' } } }), true)
      t.eq('a run that cannot be read is taken to write', writesCheckout(null), true)
    }

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
      const resumeEngine = async ({ runId, issuePath }) => ({ runId, issuePath, run: structuredClone(blocked), runLock: { release: async () => {} },
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
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
