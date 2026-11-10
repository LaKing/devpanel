import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'
import { modulesErrors } from '../server/infrastructure.mjs'
import { currentOwner } from '../server/runtime/lock.mjs'
import { slotDirectory } from '../server/runtime/drive-slots.mjs'
import { modulesDrive } from '../server/runtime/modules-tier.mjs'
import { checkSummary } from '../server/runtime/check-summary.mjs'
import { CREATE_ID, driveCommands, INSTANCE_NAME, instanceName, instanceVerdict, instanceWords, START_ID } from '../server/runtime/instance-drive.mjs'
import { destroyInstance, destroyRunInstances, holdInstance, holdsInstance, instanceCap, LOCAL_HOST, sweepInstances } from '../server/runtime/stage-instances.mjs'
import { createSupervisor } from '../server/supervisor.mjs'

export const name = 'stage instances — one per run: the name, create on the first drive and reuse after, the exits that mean "needs an install" and "host full", an instance in doubt, the cap, the sweep that spares live owners, and the destroy at every end and pause'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const NL = String.fromCharCode(10)
const P = 'devpanel-project'
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')
const REPORT = { id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[{"test":"@c/a: works"}]}\'', report: 'selftest' }

/** An Implementation run on a `kind: local` modules tier (as modules-tier.test.mjs); the worker changes a module each round. */
async function scenario ({ target }) {
  const state = { engine: null }
  const script = async (turn) => {
    const { stepId, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      const ws = state.engine.run.workspace.path
      await fs.mkdir(path.join(ws, '@c/a'), { recursive: true })
      await fs.writeFile(path.join(ws, '@c/a/x.mjs'), `export const round = ${round}\n`)
      await fs.writeFile(path.join(ws, `round-${round}.txt`), 'work\n')
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement: 'required', target })}\n`)
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: P })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: P },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  return { engine, f, events: (await readEvents(f.issuePath, engine.runId)).events }
}

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  const exists = (p) => fs.lstat(p).then(() => true, () => false)
  const until = async (label, check, ms = 20000) => {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  // A tier whose every command appends "<word> <instance name>" to a log; `over` replaces commands.
  const tier = async (over = {}) => {
    const dir = await temp('devpanel-instances-')
    const log = path.join(dir, 'log')
    const say = (word) => `echo ${word} {{instanceName}} >> '${log}'`
    const { instance: instanceOver = {}, ...slots } = over
    // lint and test take a literally named program: `ok` passes, `later` only on the second revision's bytes.
    await fs.writeFile(path.join(dir, 'ok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await fs.writeFile(path.join(dir, 'later'), '#!/bin/sh\ntest -f round-1.txt\n', { mode: 0o755 })
    const modules = {
      collections: ['@*'],
      lint: { id: 'lint', run: `${dir}/ok {{instance}} {{files}}` },
      load: { id: 'load', run: say('load') }, restart: { id: 'restart', run: say('restart') }, ready: { id: 'ready', run: say('ready') },
      test: { id: 'module-selftest', run: `${dir}/ok {{instance}} {{filter}}` }, finallyCommands: [REPORT],
      ...Object.fromEntries(Object.entries(slots).map(([slot, make]) => [slot, make({ dir, say })])),
      instance: { root: path.join(dir, 'instances'), create: { run: `${say('create')} && mkdir -p {{instance}}`, unavailableExitCodes: [3], unavailableReason: 'the candidate changes dependency manifests and needs an install' },
        start: { run: say('start'), busyExitCodes: [4], busyRetrySeconds: 1 }, destroy: { run: `${say('destroy')} && rm -rf {{instance}}` },
        ...Object.fromEntries(Object.entries(instanceOver).map(([step, make]) => [step, make({ dir, say })])) }
    }
    const lines = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split(NL).filter(Boolean).map((l) => l.split(' ')[0])
    return { dir, target: { kind: 'local', modules }, lines }
  }

  try {
    t.section('the name: derived from the run id alone, always one the stage accepts')
    {
      const id = '2026-11-06T21-12-56-193Z-4a916d66'
      t.eq('a run id that is a valid name is kept readable', instanceName(id), 'dp-2026-11-06t21-12-56-193z-4a916d66')
      t.eq('the same run always gives the same name', instanceName(id), instanceName(id))
      const names = [instanceName(id), instanceName(id, 'other-project'), instanceName('Odd_Run.Id/with stuff'), instanceName('x'.repeat(80)), instanceName('other-run')]
      t.ok('every name is 1-40 characters of a-z, 0-9 and -', names.every((n) => INSTANCE_NAME.test(n)), names.join(' '))
      t.eq('another tree of the run, another run and an unusual id each get their own', new Set(names).size, names.length)
    }

    t.section('the drive: every command names the instance; a first drive creates and starts it, a later one loads into it')
    {
      const { target } = await tier()
      const { target: bound } = modulesDrive(target, { affected: { modules: ['@c/a'], core: null }, files: ['@c/a/x.mjs'], instanceName: 'dp-run' })
      const root = `${target.modules.instance.root}/dp-run`
      t.eq('the instance root and name are substituted', [bound.commands.find((c) => c.id === 'lint').run, bound.stageInstance.root, bound.stageInstance.create.run.includes('create dp-run')], [`${path.dirname(target.modules.instance.root)}/ok ${root} '@c/a/x.mjs'`, root, true])
      t.ok('no placeholder is left anywhere', ![...bound.commands, ...bound.finallyCommands, bound.stageInstance.create, bound.stageInstance.start, bound.stageInstance.destroy].some((c) => c.run.includes('{{')))
      t.eq('a first drive: create, lint, start, ready, tests', driveCommands(bound, true).map((c) => c.id), [CREATE_ID, 'lint', START_ID, 'ready', 'module-selftest-1'])
      t.eq('a later drive: lint, load, restart, ready, tests', driveCommands(bound, false).map((c) => c.id), ['lint', 'load', 'restart', 'ready', 'module-selftest-1'])
      const ran = (...ids) => ({ commands: ids.map((id) => ({ id: id.replace('!', ''), passed: !id.endsWith('!') })) })
      t.eq('up: it stays', [instanceVerdict(bound, true, ran(CREATE_ID, START_ID, 'ready')), instanceVerdict(bound, false, ran('load', 'restart', 'ready', 'module-selftest-1!'))], ['live', 'live'])
      t.eq('a failed or missing step: in doubt', [instanceVerdict(bound, true, ran(CREATE_ID, `${START_ID}!`)), instanceVerdict(bound, true, ran(CREATE_ID)), instanceVerdict(bound, false, ran('load', 'restart!'))], ['doubt', 'doubt', 'doubt'])
      t.eq('nothing ran: as it was', [instanceVerdict(bound, true, ran()), instanceVerdict(bound, false, ran('lint!'))], ['untouched', 'untouched'])
      t.ok('a tier with an instance refuses to be driven without a name', (() => { try { modulesDrive(target, { affected: { modules: [], core: null } }); return false } catch { return true } })())
    }

    t.section('configuration: the instance rules, and the fixed-instance form still resolves')
    {
      const { target } = await tier()
      t.eq('a whole declaration passes', modulesErrors(target), [])
      const { instance, ...fixed } = target.modules
      t.ok('placeholders without modules.instance are refused', modulesErrors({ modules: fixed }).some((e) => e.includes('need modules.instance')))
      const plain = { ...fixed, lint: { id: 'lint', run: 'lint-it /opt/stage {{files}}' }, load: { id: 'load', run: 'load-it' }, restart: { id: 'restart', run: 'restart-it' }, ready: { id: 'ready', run: 'ready-it' }, test: { id: 'module-selftest', run: 'selftest-it /opt/stage {{filter}}' } }
      t.eq('the base-instance mode (no instance, fixed paths) is valid as before', modulesErrors({ modules: plain }), [])
      t.eq('and drives without an instance', modulesDrive({ modules: plain }, { affected: { modules: ['@c/a'], core: null }, files: [] }).target.stageInstance, undefined)
      t.ok('create must name the instance', modulesErrors({ modules: { ...target.modules, instance: { ...instance, create: { run: 'make-one' } } } }).some((e) => e.includes('modules.instance.create.run must name the instance')))
      t.ok('a tier command that names no instance would test something else', modulesErrors({ modules: { ...target.modules, load: { id: 'load', run: 'load-it' } } }).some((e) => e.includes('modules.load.run must name the instance')))
      t.ok('the collector names no instance', modulesErrors({ modules: { ...target.modules, instance: { ...instance, gc: { run: 'gc {{instanceName}}' } } } }).some((e) => e.includes('gc.run')))
      t.ok('command kinds are refused with an instance', modulesErrors({ modules: { ...target.modules, load: { ...target.modules.load, kind: 'privileged' } } }).some((e) => e.includes('unstructured')))
      t.ok('the engine\'s own ids are reserved', modulesErrors({ modules: { ...target.modules, finallyCommands: [{ ...REPORT, id: CREATE_ID }] } }).some((e) => e.includes(CREATE_ID)))
    }

    t.section('the cap: a host keeps so many instances; a run over it waits and is never refused')
    {
      const slotsDir = await temp('devpanel-instance-slots-')
      const dir = await temp('devpanel-instance-cap-')
      const make = (n, max) => ({ name: n, root: path.join(dir, n), ...(max ? { max } : {}), destroy: { run: `echo destroy ${n} >> '${dir}/log'` } })
      t.eq('the default is 4', [hostSettings().testDrive.maxInstances, instanceCap({})], [4, 4])
      t.eq('a project may lower it, never raise it', [instanceCap({ max: 2 }), instanceCap({ max: 9 })], [2, 4])
      const a = await holdInstance({ instance: make('cap-a', 1), host: 'h', kind: 'local', runId: 'run-a', slotsDir })
      t.eq('the first run gets a slot, fresh', [a.fresh, a.slot, a.cap], [true, 0, 1])
      t.eq('its next drive finds the instance held', (await holdInstance({ instance: make('cap-a', 1), host: 'h', kind: 'local', runId: 'run-a', slotsDir })).fresh, false)
      const waits = []
      const b = holdInstance({ instance: make('cap-b', 1), host: 'h', kind: 'local', runId: 'run-b', slotsDir, pollMs: 20, onWait: (w) => waits.push([w.phase, w.reason]) })
      await until('the second run to wait', () => waits.length === 1)
      t.eq('the wait is told as it begins, for the wall clock', waits, [['start', 'instances-full']])
      t.eq('another host is not affected', (await holdInstance({ instance: make('cap-c', 1), host: 'other', kind: 'local', runId: 'run-c', slotsDir })).fresh, true)
      await fs.mkdir(path.join(dir, 'cap-a'))
      const gone = await destroyInstance('cap-a', { reason: 'run-completed' })
      t.eq('destroying the first frees its slot', [gone.passed, gone.reason, holdsInstance('cap-a')], [true, 'run-completed', false])
      const got = await b
      t.eq('and the waiting run takes it', [got.fresh, got.slot, waits.at(-1)?.[0]], [true, 0, 'end'])
      t.ok('with the wait measured', got.waitMs > 0)

      t.section('the sweep: an instance of a live owner is never touched, a dead owner\'s is destroyed, an unknown owner\'s is left')
      const hostDir = slotDirectory('h', slotsDir)
      const record = (n, runId) => ({ name: n, root: path.join(dir, n), runId, kind: 'local', host: 'h', destroy: { run: `echo destroy ${n} >> '${dir}/log' && rm -rf '${path.join(dir, n)}'` } })
      const plant = async (slot, n, owner, runId = `run-${n}`) => {
        await fs.mkdir(path.join(dir, n))
        await fs.writeFile(path.join(hostDir, `instance-${slot}.json`), JSON.stringify({ ...record(n, runId), slot }))
        await fs.writeFile(path.join(hostDir, `instance-${slot}.lock`), JSON.stringify({ purpose: 'stage-instance', token: `t-${n}`, owner }))
      }
      const me = await currentOwner()
      await plant(5, 'dead', { ...me, pid: 999999, processStartedAt: '1' })
      await plant(6, 'unknown', { ...me, host: 'another-machine' })
      const swept = await sweepInstances({ slotsDir })
      t.eq('only the dead owner\'s instance is destroyed', swept.map((s) => [s.name, s.reason, s.passed]), [['dead', 'owner-gone', true]], swept[0]?.error)
      t.eq('the live run keeps its instance and the unknown owner\'s stands', [holdsInstance('cap-b'), await exists(path.join(dir, 'dead')), await exists(path.join(dir, 'unknown')), await exists(path.join(hostDir, 'instance-6.json'))], [true, false, true, true])
      t.eq('the live run\'s record is still there', (await fs.readdir(hostDir)).filter((n) => n.startsWith('instance-0')).sort(), ['instance-0.json', 'instance-0.lock'])

      // A run that comes back in another process: its earlier instance goes before a new one is created.
      await plant(7, 'cap-d', { ...me, pid: 999998, processStartedAt: '1' }, 'run-d')
      const back = await holdInstance({ instance: make('cap-d'), host: 'h', kind: 'local', runId: 'run-d', slotsDir })
      t.eq('a returning run removes its earlier instance first and starts fresh', [back.fresh, await exists(path.join(dir, 'cap-d')), (await fs.readFile(path.join(dir, 'log'), 'utf8')).includes('destroy cap-d')], [true, false, true])

      // A leftover that cannot be removed keeps its slot: the host never runs more than its cap.
      await fs.rm(path.join(hostDir, 'instance-6.lock'))
      await fs.writeFile(path.join(hostDir, 'instance-6.json'), JSON.stringify({ ...record('unknown', 'run-u'), slot: 6, destroy: { run: 'exit 1' } }))
      const failed = await destroyRunInstances('run-u', { reason: 'run-deleted', slotsDir })
      t.eq('a destroy that fails is reported, and its record stays', [failed.map((d) => [d.name, d.passed]), await exists(path.join(hostDir, 'instance-6.json'))], [[['unknown', false]], true])
      for (const n of ['cap-b', 'cap-c', 'cap-d']) await destroyInstance(n, { reason: 'test' })
    }

    t.section('an engine run: created on the first drive, reused by the next revision, recorded with its timings; destroyed when the run ends')
    {
      // The first revision's test fails on its own exit, so a second revision is driven on the same instance.
      const { target, lines } = await tier({ test: ({ dir }) => ({ id: 'module-selftest', run: `${dir}/later {{instance}} {{filter}}` }) })
      const { engine, events } = await scenario({ target })
      const name = instanceName(engine.runId)
      t.eq('the run completes on its second revision', [engine.run.status, engine.run.revisions.length], ['completed', 2], engine.run.blockedReason)
      t.eq('create and start once, then load and restart: one instance for the run', await lines(), ['create', 'start', 'ready', 'load', 'restart', 'ready'])
      const [first, second] = engine.run.checkHistory.map((h) => engine.run.checkResults.find((c) => c.dir === h.dir) ?? h)
      t.eq('one instance on the run\'s record, serving both drives', engine.run.stageInstances.map((i) => [i.name, i.drives, i.destroyed]), [[name, 2, undefined]])
      t.ok('with its create, start and ready times', [engine.run.stageInstances[0].createMs, engine.run.stageInstances[0].startMs, engine.run.stageInstances[0].readyMs].every(Number.isInteger), JSON.stringify(engine.run.stageInstances[0]))
      t.eq('the closing check names the instance and what the drive did with it', [second.stageInstance?.name, second.stageInstance?.fresh, second.stageInstance?.state, Number.isInteger(second.stageInstance?.loadMs)], [name, false, 'live', true], JSON.stringify(first))
      t.ok('said in words for reviewers', checkSummary(second).stageInstanceNote.includes(`loaded the candidate into the run's stage instance ${name}`) && instanceWords({ stageInstance: { name, host: 'h', fresh: true, state: 'live', createMs: 7000, startMs: 500, readyMs: 120000 } }).includes('create 7 s, start 1 s, ready 120 s'))
      t.eq('the failed test cost no second drive', events.filter((e) => e.type === 'checks-retry').length, 0)
      t.eq('the instance stays for as long as the run drives', holdsInstance(name), true)
      const destroyed = await destroyRunInstances(engine.runId, { reason: 'run-completed' })
      t.eq('the run\'s end destroys it', [destroyed.map((d) => [d.name, d.passed, d.reason]), (await lines()).at(-1), holdsInstance(name), await exists(second.stageInstance.root)], [[[name, true, 'run-completed']], 'destroy', false, false])
      await releaseWorkspace(engine)
    }

    t.section('create says the candidate needs an install: the check is unavailable with the reason, nothing is tested elsewhere, no author round')
    {
      const { target, lines } = await tier({ instance: { create: ({ say }) => ({ run: `${say('create')}; echo "package.json differs from the base instance's {{instanceName}}" >&2; exit 3`, unavailableExitCodes: [3], unavailableReason: 'the candidate changes dependency manifests and needs an install' }) } })
      const { engine, events } = await scenario({ target })
      const check = engine.run.checkResults.at(-1)
      t.eq('one revision, not completed', [engine.run.revisions.length, engine.run.status === 'completed'], [1, false])
      t.eq('the check is unavailable, not failed', [check.result, check.commands.map((c) => c.id)], ['unavailable', [CREATE_ID, 'collect']])
      t.ok('with the declared reason and what the command said', check.error.includes('needs an install') && check.error.includes('package.json differs') && check.error.includes('exit 3'), check.error)
      t.eq('nothing was started, loaded or tested', await lines(), ['create'])
      t.eq('no retry and no author round', [events.filter((e) => e.type === 'checks-retry').length, engine.run.steps.filter((s) => s.stepId === 'implement').length], [0, 1])
      t.eq('and no slot is held', holdsInstance(instanceName(engine.runId)), false)
      await releaseWorkspace(engine)
    }

    t.section('start says the stage is full: asked again until it starts, a wait that is excused, never a failure')
    {
      const { target, lines } = await tier({ instance: { start: ({ dir, say }) => ({ run: `n=$(cat '${dir}/n' 2>/dev/null || echo 0); echo $((n+1)) > '${dir}/n'; if [ "$n" -lt 2 ]; then exit 4; fi; ${say('start')}`, busyExitCodes: [4], busyRetrySeconds: 1 }) } })
      const { engine, events } = await scenario({ target })
      const check = engine.run.checkResults.at(-1)
      const start = check.commands.find((c) => c.id === START_ID)
      t.eq('the run completes on its one revision', [engine.run.status, engine.run.revisions.length, check.result], ['completed', 1, 'passed'], engine.run.blockedReason)
      t.eq('the third attempt started it', [start.passed, start.attempts, await lines()], [true, 3, ['create', 'start', 'ready']])
      // The fixture's clock stands still, so the wait measures 0 here; its interval is what the engine keeps.
      t.ok('the wait is on the command', Number.isInteger(start.busyWaitMs), JSON.stringify(start))
      t.eq('told as a wait for the stage, begun and ended', events.filter((e) => e.type === 'checks-waiting').map((e) => e.reason), ['stage-full'])
      t.eq('and kept as a drive wait, which the wall clock excuses', (engine.run.driveSlotWaits ?? []).length, 1)
      t.eq('no retry was spent on it', events.filter((e) => e.type === 'checks-retry').length, 0)
      await destroyRunInstances(engine.runId, { reason: 'run-completed' })
      await releaseWorkspace(engine)
    }

    t.section('an instance in doubt is destroyed at once: the retry creates a new one, on the first drive and after a failed reload')
    {
      // ready fails once: the instance did not come up.
      const up = await tier({ ready: ({ dir, say }) => ({ id: 'ready', run: `${say('ready')}; if [ -f '${dir}/ready' ]; then exit 0; fi; touch '${dir}/ready'; exit 1` }) })
      const first = await scenario({ target: up.target })
      t.eq('the run completes, the pass recorded flaky', [first.engine.run.status, first.engine.run.checkResults.at(-1).flaky], ['completed', true], first.engine.run.blockedReason)
      t.eq('destroyed after the failed ready, created again by the retry', await up.lines(), ['create', 'start', 'ready', 'destroy', 'create', 'start', 'ready'])
      t.eq('both instances are on the record, the first with why it went', first.engine.run.stageInstances.map((i) => [i.drives, i.destroyed?.reason, i.destroyed?.passed]), [[1, 'did-not-come-up', true], [1, undefined, undefined]])
      await destroyRunInstances(first.engine.runId, { reason: 'run-completed' })
      await releaseWorkspace(first.engine)

      // The second revision's restart fails once: what runs in the instance is unknown.
      const reload = await tier({
        test: ({ dir }) => ({ id: 'module-selftest', run: `${dir}/later {{instance}} {{filter}}` }),
        restart: ({ dir, say }) => ({ id: 'restart', run: `${say('restart')}; if [ -f '${dir}/restarted' ]; then exit 0; fi; touch '${dir}/restarted'; exit 1` })
      })
      const second = await scenario({ target: reload.target })
      t.eq('the run completes on its second revision', [second.engine.run.status, second.engine.run.revisions.length], ['completed', 2], second.engine.run.blockedReason)
      t.eq('the failed reload destroys the instance and the retry starts from a new one', await reload.lines(), ['create', 'start', 'ready', 'load', 'restart', 'destroy', 'create', 'start', 'ready'])
      t.eq('recorded: two drives on the first, destroyed for the reload', second.engine.run.stageInstances.map((i) => [i.drives, i.destroyed?.reason]), [[2, 'reload-failed'], [1, undefined]])
      await destroyRunInstances(second.engine.runId, { reason: 'run-completed' })
      await releaseWorkspace(second.engine)
    }

    t.section('the supervisor destroys a run\'s instance at every end, at a pause and with a deleted run')
    {
      const f = await engineFixture()
      const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
      const dir = await temp('devpanel-instance-ends-')
      try {
        const projectsDir = path.join(f.issuesDir, 'projects')
        await fs.mkdir(projectsDir, { recursive: true })
        await fs.symlink(f.projectPath, path.join(projectsDir, P)).catch(() => {})
        process.env.DEVPANEL_PROJECTS_DIR = projectsDir
        process.env.DEVPANEL_FAKE_CONTROL = path.join(dir, 'control.json')
        await fs.writeFile(process.env.DEVPANEL_FAKE_CONTROL, JSON.stringify({ ledger: path.join(dir, 'ledger.jsonl'), delayMs: 400 }))
        await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(HARNESS_MODULE)}` + NL)
        const read = async (issue, runId) => JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
        const logged = async () => (await fs.readFile(path.join(dir, 'log'), 'utf8').catch(() => '')).split(NL).filter(Boolean)
        // A live run with an instance, as its first modules drive leaves it.
        const live = async (label) => {
          const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
          const issue = await f.issues.createIssue(P, { name: `Ends ${label}` })
          const { runId } = await supervisor.start({ project: P, issueId: issue.id, playbookId: f.playbookId, configRoot: f.configRoot })
          const instance = instanceName(runId)
          const root = path.join(dir, instance)
          await fs.mkdir(root)
          await holdInstance({ instance: { name: instance, root, destroy: { run: `echo ${label} >> '${dir}/log' && rm -rf '${root}'` } }, host: LOCAL_HOST, kind: 'local', runId })
          return { supervisor, issue, runId, instance, root, named: { project: P, issueId: issue.id, runId } }
        }
        const gone = async (r) => [holdsInstance(r.instance), await exists(r.root)]

        const ended = await live('ended')
        await ended.supervisor.settle()
        t.eq(`a run that ends on its own (${(await read(ended.issue, ended.runId)).status})`, [await gone(ended), (await logged()).includes('ended')], [[false, false], true])

        const stopped = await live('stopped')
        await stopped.supervisor.stop(stopped.named)
        await stopped.supervisor.settle()
        t.eq('a stopped run', [(await read(stopped.issue, stopped.runId)).status, await gone(stopped)], ['cancelled', [false, false]])

        const paused = await live('paused')
        await paused.supervisor.pause(paused.named)
        await paused.supervisor.settle()
        t.eq('a paused run gives its instance back too: the next drive creates one', [(await read(paused.issue, paused.runId)).status, await gone(paused)], ['paused', [false, false]])

        const shut = await live('shutdown')
        await shut.supervisor.shutdown({ graceMs: 15000 })
        t.eq('a service shutdown', [(await read(shut.issue, shut.runId)).stoppedBy, await gone(shut)], ['service-shutdown', [false, false]])

        // An instance whose destroy failed at the run's end is tried again when the run is deleted.
        const hostDir = slotDirectory(LOCAL_HOST)
        const left = path.join(dir, 'left')
        await fs.mkdir(left)
        await fs.writeFile(path.join(hostDir, 'instance-9.json'), JSON.stringify({ name: 'left', root: left, runId: stopped.runId, kind: 'local', host: LOCAL_HOST, slot: 9, destroy: { run: `echo deleted >> '${dir}/log' && rm -rf '${left}'` } }))
        await stopped.supervisor.deleteRun(stopped.named)
        t.eq('a deleted run', [await exists(left), (await logged()).at(-1), await exists(path.join(hostDir, 'instance-9.json'))], [false, 'deleted', false])
        t.eq('each destroy ran once', (await logged()).sort(), ['deleted', 'ended', 'paused', 'shutdown', 'stopped'])
      } finally {
        for (const [key, env] of [['projects', 'DEVPANEL_PROJECTS_DIR'], ['control', 'DEVPANEL_FAKE_CONTROL']]) {
          if (saved[key] === undefined) delete process.env[env]
          else process.env[env] = saved[key]
        }
      }
    }
  } finally {
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
