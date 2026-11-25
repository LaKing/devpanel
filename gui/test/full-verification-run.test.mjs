import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { engineOnlyRefusal, loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { preflight } from '../server/config/preflight.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { createFullVerification } from '../server/full-verification.mjs'
import { createCycleRuns, cycleRunView } from '../server/full-verification-run.mjs'
import { createSupervisor, supportedActions } from '../server/supervisor.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { awaitsAutoResume } from '../server/runtime/run-control.mjs'
import { instanceName } from '../server/runtime/instance-drive.mjs'
import { listRuns, getRun } from '../server/runs-api.mjs'
import { sandbox, cleanupSandboxes } from './helpers.mjs'

export const name = 'full verification playbook — the engine program starts the existing cycle as one run: its timeline, explanation, preview, Stop as an interrupted cycle, recovery at start, the projects it verifies'

const P = 'site-project'
const HOST = 'ssh-config:stage-host'
const PHASES = [
  { id: 'freeze', title: 'Close admission for the projects it verifies', engine: 'full-verification-freeze' },
  { id: 'wait', title: 'Wait for writes and drives in flight', engine: 'full-verification-wait' },
  { id: 'stages', title: 'Verify every stage', engine: 'full-verification-stages' },
  { id: 'outcome', title: 'Record changes and handle the outcome', engine: 'full-verification-outcome' },
  { id: 'thaw', title: 'Open admission and resume', engine: 'full-verification-thaw' }
]

async function until (fn, label, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const readJson = (file) => fs.readFile(file, 'utf8').then(JSON.parse)

/** A project on a stage host with dynamic instances, verified by the cycle on an instance of its own. */
const infra = {
  [P]: {
    staging: { id: 'stage', ssh: { hostRef: HOST, workdir: '/opt' }, projectRoot: '/opt/stage-base', files: {} },
    testDrive: {
      modules: {
        collections: ['@*'],
        lint: { id: 'lint', run: '/opt/t/lint.sh {{instance}} {{files}}' },
        load: { id: 'load', run: '/opt/t/load.sh {{instance}}' },
        restart: { id: 'restart', run: '/opt/t/reload.sh {{instance}}' },
        ready: { id: 'ready', run: '/opt/t/instance.sh ready {{instanceName}}' },
        test: { id: 'module-selftest', run: '/opt/t/selftest.sh {{instance}} {{filters}}' },
        instance: {
          root: '/opt/stage-instances',
          create: { run: '/opt/t/instance.sh create {{instanceName}} "$PWD"' },
          start: { run: '/opt/t/instance.sh start {{instanceName}}' },
          destroy: { run: '/opt/t/instance.sh destroy {{instanceName}}' },
          fullSuite: { test: { id: 'full-suite', run: '/opt/t/full-suite.sh {{instance}}', timeoutSeconds: 3600 } }
        }
      }
    }
  }
}

/** The change list the preview reads (cycleChanges' shape), for one checkout. */
const CHANGES = { computedAt: '2026-11-25T10:00:00.000Z', limits: [], repositories: [{ checkout: '/fixture/site', project: P, readBy: [P], range: { from: null, to: { commit: 'abc' }, basis: 'since-coverage-baseline', since: '2026-10-01' }, commits: { list: [], total: 0 }, deliveries: [{ project: P, issueId: 'delivered-one', runId: 'r1' }], uncommitted: { paths: ['a.js'], total: 1 } }] }

/**
 * One panel process: a real supervisor over a small issue store, the real cycle with an instance stage whose drive
 * runs until it is aborted or released, and the run wrapper. `fvSupervisor` is the supervisor as the cycle sees it,
 * its resume of paused runs recorded instead of driven.
 */
async function panel ({ root, dir, issueIds, paused = [], harnessDir }) {
  const issuesDir = path.join(dir, 'issues')
  const verificationDir = path.join(issuesDir, '.verification')
  const issuePath = (id) => path.join(issuesDir, P, id)
  for (const id of [...issueIds, ...paused.map((p) => p.issueId)]) await fs.mkdir(issuePath(id), { recursive: true })
  await fs.mkdir(path.join(dir, 'projects', P), { recursive: true })
  const latestOf = async (id) => {
    const names = await fs.readdir(path.join(issuePath(id), 'runs')).catch(() => [])
    for (const n of names.sort().reverse()) {
      const run = await readJson(path.join(issuePath(id), 'runs', n, 'run.json')).catch(() => null)
      if (run) return { runId: run.runId, status: run.status, live: ['pending', 'preflighting', 'running', 'stopping'].includes(run.status) }
    }
    return null
  }
  const holder = (project, id) => ({ id, project, name: id, openedOn: '2026-11-25', path: issuePath(id), packed: false, home: false, steps: [] })
  const issues = {
    listProjects: async () => [{ id: P }],
    getIssue: async (project, id) => holder(project, id),
    getRunHolder: async (project, id) => holder(project, id),
    listIssues: async (project) => Promise.all([...issueIds, ...paused.map((p) => p.issueId)].map(async (id) => ({ ...holder(project, id), latestRun: await latestOf(id) })))
  }
  const supervisor = createSupervisor({ issues, availabilityFile: path.join(dir, 'availability.json'), harnessDir, projectsDir: path.join(dir, 'projects'), configRoot: root })
  const calls = { thaws: [], resumes: [], destroys: [], drives: [], ended: [] }
  let release = null
  const released = new Promise((resolve) => { release = resolve })
  const fvSupervisor = {
    freeze: (...a) => supervisor.freeze(...a),
    thaw: (id) => { calls.thaws.push(id); return supervisor.thaw(id) },
    frozen: () => supervisor.frozen(),
    busy: () => supervisor.busy(),
    busyActions: () => supervisor.busyActions(),
    releaseIdle: () => supervisor.releaseIdle(),
    isActive: (...a) => supervisor.isActive(...a),
    stop: (...a) => supervisor.stop(...a),
    resume: async (a) => { calls.resumes.push(a); return {} },
    start: async () => { throw new Error('no release run is expected here') }
  }
  let cycleRuns = null
  const fv = createFullVerification({
    supervisor: fvSupervisor, issues: { ...issues, ISSUES_DIR: issuesDir, createIssue: async () => ({ id: 'red' }), addStepFile: async () => {} },
    verificationDir, settings: () => null, pollMs: 20, graceMs: 3000, maxWaitMs: 600_000, log: { warn () {} },
    resolveHost: async (ssh) => ({ host: String(ssh?.hostRef ?? '').replace(/^ssh-config:/, ''), pinned: null }),
    infrastructureOf: async (project) => infra[project] ?? null,
    projectsConfig: async () => new Map([[P, { id: P }]]),
    resolve: async (playbookId, { projectId }) => ({ ok: true, resolved: { configHash: `hash-${projectId}`, workspace: { base: 'working-tree' }, infrastructure: infra[projectId] ?? null, fence: { selection: 1, repository: 1 }, liveExecution: { blockers: [] } } }),
    provision: async (args) => { const p = path.join(args.root, `worktree-${args.runId}`); await fs.mkdir(p, { recursive: true }); return { path: p, baseCommit: 'snap', isolation: 'git-worktree' } },
    releaseWorkspace: async () => {},
    recordSnapshot: async () => ({ repository: '/fixture/site/.git', ownCommit: 'own', excludes: [], links: [] }),
    readMotion: async () => ({ at: Date.now(), checkouts: [] }),
    snapshottedOf: async () => ({ repositories: [], worktrees: [], unknown: false }),
    drive: async ({ target, runDir, dirName, signal }) => {
      calls.drives.push(target.stageInstance.name)
      const out = path.join(runDir, 'checks', dirName)
      await fs.mkdir(out, { recursive: true })
      const how = await new Promise((resolve) => {
        if (signal?.aborted) return resolve('aborted')
        signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        released.then(() => resolve('released'))
      })
      return { result: how === 'aborted' ? 'failed' : 'passed', dir: path.join('checks', dirName), commands: [{ id: 'full-suite', passed: how !== 'aborted', exitCode: how === 'aborted' ? 143 : 0 }], stageInstance: { name: target.stageInstance.name, root: target.stageInstance.root, host: HOST, slot: 0, cap: 4, fresh: true, state: 'live' } }
    },
    destroyInstances: async (driveId) => { calls.destroys.push(driveId); return [{ name: instanceName(driveId), passed: true }] },
    coverageOf: async () => ({ basis: 'cycle-snapshot', covered: [], indeterminate: [], notShipped: [] }),
    deliveriesOf: async () => [],
    projectPathOf: async (project) => `/fixture/${project}`,
    runAction: async () => ({ status: 'completed' }),
    versionOf: async () => null,
    headOf: async () => 'abc',
    emit: (event) => cycleRuns?.noteChanged(event),
    onEnded: (notice) => { calls.ended.push(notice) }
  })
  cycleRuns = createCycleRuns({ fullVerification: fv, supervisor, issues, verificationDir, changesOf: async () => CHANGES, log: { warn () {} } })
  supervisor.setEngineRunner('full-verification', cycleRuns)
  return { supervisor, fv, cycleRuns, calls, release, issuePath, verificationDir, issues }
}

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }
  try {
    const root = await sandbox()
    const harnessDir = path.join(root, 'harness')

    t.section('AC1: the catalogue playbook names the full-verification program, resolves runnable, and is not refused as engine-only')
    {
      const config = await loadConfig({ root })
      const r = await resolvePlaybook('full-verification', { config, root })
      t.ok('it resolves', r.ok, JSON.stringify(r.errors))
      t.eq('an engine-only playbook naming the program, with no blocker', [r.resolved.kind, r.resolved.engineProgram, r.resolved.liveExecution.eligible, r.resolved.liveExecution.blockers], ['engine-only', 'full-verification', true, []])
      t.eq('its five phases', r.resolved.phases.map((p) => p.engine), PHASES.map((p) => p.engine))
      t.eq('no start refusal', engineOnlyRefusal(r.resolved), null)
      let probes = 0
      const pf = await preflight(r.resolved, { probe: async () => { probes++ }, root })
      t.eq('preflight probes nothing and is launch-ready', [probes, pf.launchReady, pf.probed], [0, true, false])
    }

    t.section('AC7: the preview carries the change list and the runs the freeze would pause; the command line says it cannot')
    {
      const withReader = await previewRun({ playbookId: 'full-verification', configRoot: root, cyclePreview: async () => ({ scope: [P], changes: { state: 'computed' }, wouldPause: [{ runId: 'x' }] }) })
      t.eq('the panel preview carries the cycle reading', [withReader.ok, withReader.cycle.scope, withReader.cycle.wouldPause.length, withReader.prerequisites], [true, [P], 1, []])
      const cli = await previewRun({ playbookId: 'full-verification', configRoot: root })
      t.ok('the command-line preview says it carries neither', /neither the change list nor the runs the freeze would pause/.test(cli.cycle.unread), JSON.stringify(cli.cycle))
    }

    t.section('AC2: the view of a cycle record — status, phase timeline, where each entry\'s output is')
    {
      const base = { id: '2026-11-25.1', scope: { projects: [P] }, asked: [], frozenAt: '2026-11-25T10:00:00.000Z', projects: [] }
      const v0 = cycleRunView({ record: null, phases: PHASES, preview: { scope: [P] }, startedAt: 't0', observed: {} })
      t.eq('before the cycle exists: running in its freeze, the preview on the first entry', [v0.status, v0.phase, v0.phases[0].detail.preview.scope], ['running', 'freeze', [P]])
      const waiting = cycleRunView({ record: { ...base, state: 'frozen', waitingOn: [{ project: P, kind: 'write' }] }, phases: PHASES, observed: {} })
      t.eq('frozen: freeze done, waiting', [waiting.phase, waiting.phases.map((p) => p.state)], ['wait', ['done', 'running', 'pending', 'pending', 'pending']])
      const entries = [
        { project: P, stage: 'stage', mode: 'instance', state: 'running', runDir: '/v/x', driveId: 'fv-x' },
        { project: 'b-project', stage: 'stage', state: 'refused', verdict: 'red', refusal: { code: 'HOST_HAS_INSTANCES' } },
        { project: 'fw-project', stage: 'stage', mode: 'derived', derived: { from: [] }, state: 'deriving' },
        { project: 'tool-project', stage: null, verifiedThrough: 'instances', reason: 'the project has no infrastructure' }
      ]
      const running = cycleRunView({ record: { ...base, state: 'running', seatsIdleAt: 't1', startedAt: 't1', projects: entries }, phases: PHASES, stopping: true, observed: {} })
      t.eq('a stop asked: stopping, in its stages', [running.status, running.phase], ['stopping', 'stages'])
      t.eq('each entry says where its output is, and nothing misleading where nothing was driven',
        running.phases[2].detail.entries.map((e) => [e.project, e.output.where]), [[P, 'feed'], ['b-project', 'none'], ['fw-project', 'none'], ['tool-project', 'none']])
      t.ok('a refused entry names why it has no output', /refused \(HOST_HAS_INSTANCES\)/.test(running.phases[2].detail.entries[1].output.reason))
      const green = cycleRunView({ record: { ...base, state: 'ended', verdict: 'green', seatsIdleAt: 't1', startedAt: 't1', endedAt: 't9', changes: { computedAt: 't5', repositories: [] }, outcome: { committed: true }, resumed: [], heldForOperator: [], leftPaused: [], refused: [], projects: [] }, phases: PHASES, observed: {} })
      t.eq('ended green: completed, every phase done', [green.status, green.phases.map((p) => p.state)], ['completed', ['done', 'done', 'done', 'done', 'done']])
      const run = { status: 'completed', engineProgram: 'full-verification', cycleRun: { ...green, phases: green.phases } }
      t.eq('its result and explanation', [runResult(run, {}).result, explainRun(run).headline], ['completed', 'Full verification green'])
      const stopped = cycleRunView({ record: { ...base, state: 'interrupted', seatsIdleAt: 't1', startedAt: 't1', endedAt: 't9', interruption: { reason: 'stopped', by: 'tester', at: 't3' }, outcome: { skipped: 'interrupted', interrupted: true }, resumed: [{ runId: 'p' }], heldForOperator: [], leftPaused: [], refused: [], projects: [] }, phases: PHASES, observed: {} })
      t.eq('interrupted in its stages: later phases skipped, thaw done', [stopped.status, stopped.phases.map((p) => p.state)], ['cancelled', ['done', 'done', 'interrupted', 'skipped', 'done']])
      const failed = cycleRunView({ record: { ...base, state: 'failed', error: 'boom', seatsIdleAt: 't1', startedAt: 't1', endedAt: 't9', projects: [] }, phases: PHASES, observed: {} })
      t.eq('failed', [failed.status, failed.phases[2].state], ['failed', 'failed'])
      t.eq('a live run offers Stop, an ended one nothing', [supportedActions({ status: 'running', engineProgram: 'full-verification' }, { active: true }), supportedActions({ status: 'cancelled', engineProgram: 'full-verification' })], [['stop'], []])
    }

    t.section('AC1, AC2, AC4, AC7: a start from an issue of a project in the scope runs the cycle as one run; Stop ends it as an interrupted cycle')
    let firstCycle = null
    let firstRun = null
    {
      const dir = await temp('devpanel-fvrun-')
      const pausedRun = { issueId: 'paused-one', runId: 'p1' }
      const w = await panel({ root, dir, issueIds: ['wrapper', 'other'], paused: [pausedRun], harnessDir })
      await fs.mkdir(path.join(w.issuePath('paused-one'), 'runs', 'p1'), { recursive: true })
      await fs.writeFile(path.join(w.issuePath('paused-one'), 'runs', 'p1', 'run.json'), JSON.stringify({ runId: 'p1', status: 'paused', pause: { kind: 'full-verification', cycleId: 'earlier' } }))

      // What a freeze would pause, read-only: a live in-place run of the scope (gone again before the start).
      w.supervisor.active.set(`${P}/other`, { runId: 'in-place-run', project: P, issueId: 'other', writes: true, engine: null, reservation: { resolution: { resolved: { workspace: { isolation: 'in-place' } } }, run: {} } })
      const preview = await w.cycleRuns.preview()
      t.eq('the preview names the scope, the change list and the in-place run the freeze would pause',
        [preview.scope, preview.changes.state, preview.changes.repositories[0].sections.map((s) => s.kind), preview.wouldPause.map((r) => [r.runId, r.reason])],
        [[P], 'computed', ['delivered', 'by-hand', 'uncommitted'], [['in-place-run', 'in-place']]])
      w.supervisor.active.delete(`${P}/other`)

      const started = await w.supervisor.start({ project: P, issueId: 'wrapper', playbookId: 'full-verification', configRoot: root })
      t.eq('the start is accepted as a running run', started.status, 'running')
      const runFile = path.join(w.issuePath('wrapper'), 'runs', started.runId, 'run.json')
      const running = await until(async () => { const r = await readJson(runFile).catch(() => null); return r?.phase?.id === 'stages' && w.calls.drives.length ? r : null }, 'the cycle to drive its stage')
      t.eq('one run record, no steps, the engine program', [running.status, running.steps.length, running.engineProgram, running.playbook.id, running.playbook.strategy], ['running', 0, 'full-verification', 'full-verification', null])
      const second = await w.supervisor.start({ project: P, issueId: 'wrapper', playbookId: 'full-verification', configRoot: root }).catch((e) => e)
      t.ok('a second start on the same issue is refused', second instanceof Error && /already/.test(second.message), second?.message)
      const record = await w.fv.recordOf(running.cycleRun.cycleId)
      t.eq('the cycle record names the run and was started as a playbook run', [record.run, record.trigger], [{ project: P, issueId: 'wrapper', runId: started.runId }, 'playbook'])
      t.ok('the cycle reached its stages with the wrapper live: it never waited for its own run', record.state === 'running' && w.supervisor.busy().length === 0, JSON.stringify(w.supervisor.busy()))
      t.eq('the first timeline entry carries the preview: change list and would-pause', [running.cycleRun.phases[0].detail.preview.changes.state, Array.isArray(running.cycleRun.phases[0].detail.preview.wouldPause)], ['computed', true])
      const listed = await listRuns(w.issuePath('wrapper'), { strict: true })
      t.eq('the run list shows it with its cycle and explanation', [listed[0].status, listed[0].cycleRun?.cycleId, /Full verification: Verify every stage/.test(listed[0].explanation.headline)], ['running', record.id, true])
      const detail = await getRun(w.issuePath('wrapper'), started.runId, { issues: w.issues, project: P, issueId: 'wrapper', isActive: true })
      t.eq('the run detail shows the timeline and offers Stop', [detail.cycleRun.phases.map((p) => p.id), detail.actions], [PHASES.map((p) => p.id), ['stop']])

      await w.supervisor.stop({ project: P, issueId: 'wrapper', runId: started.runId, actor: 'tester' })
      const ended = await until(async () => { const r = await readJson(runFile).catch(() => null); return r?.status === 'cancelled' ? r : null }, 'the run to settle')
      await w.supervisor.settle()
      const after = await w.fv.recordOf(record.id)
      t.eq('the cycle ended interrupted, stopped by the operator who stopped the run', [after.state, after.interruption.reason, after.interruption.by, after.verdict], ['interrupted', 'stopped', 'tester', null])
      t.eq('admission thawed', [w.calls.thaws.includes(record.id), w.supervisor.frozen()], [true, null])
      t.ok('the cycle\'s instance destroyed', w.calls.destroys.includes(after.projects.find((e) => e.project === P).driveId), JSON.stringify(w.calls.destroys))
      t.eq('the run its freeze held paused is resumed', w.calls.resumes.map((r) => r.runId), ['p1'])
      t.eq('the run mirrors it: cancelled, the stages interrupted, the thaw done', [ended.cycleRun.state, ended.cycleRun.phases.map((p) => p.state)], ['interrupted', ['done', 'done', 'interrupted', 'skipped', 'done']])
      const words = explainRun(ended)
      t.ok('the explanation says it was stopped, and by whom', /Stopped by tester/.test(words.detail), words.detail)
      t.ok('a Stop does not read as a wait bound', !/wait bound/.test(JSON.stringify(words)), JSON.stringify(words))
      t.eq('nothing is offered on it any more, and the run lock is free', [supportedActions(ended), await fs.stat(path.join(w.issuePath('wrapper'), '.run.lock')).then(() => 'held', () => 'free')], [[], 'free'])
      firstCycle = record.id
      firstRun = { ...w, runId: started.runId }
      w.release()
    }

    t.section('AC6: every project the cycle verifies links to its run; a project outside it does not')
    {
      const links = await firstRun.cycleRuns.forProject(P)
      t.eq('the project in the scope lists the run', links.map((l) => [l.cycleId, l.run.runId, l.state]), [[firstCycle, firstRun.runId, 'interrupted']])
      t.eq('a project outside the scope lists none', await firstRun.cycleRuns.forProject('elsewhere-project'), [])
    }

    t.section('AC5, A6: a service shutdown leaves the cycle to recovery; at the next start the run is settled, never live with a dead owner')
    {
      const dir = await temp('devpanel-fvrun-restart-')
      const a = await panel({ root, dir, issueIds: ['wrapper'], harnessDir })
      const started = await a.supervisor.start({ project: P, issueId: 'wrapper', playbookId: 'full-verification', configRoot: root })
      const runFile = path.join(a.issuePath('wrapper'), 'runs', started.runId, 'run.json')
      const live = await until(async () => { const r = await readJson(runFile).catch(() => null); return r?.phase?.id === 'stages' && a.calls.drives.length ? r : null }, 'the cycle to drive its stage')
      await a.supervisor.shutdown({ graceMs: 5000 })
      const leftBehind = await readJson(runFile)
      const cycle = await a.fv.recordOf(live.cycleRun.cycleId)
      t.eq('the run is left stopping, never cancelled by a shutdown mark', [leftBehind.status, leftBehind.stoppedBy ?? null, awaitsAutoResume(leftBehind)], ['stopping', null, false])
      t.eq('the cycle was not interrupted by the shutdown', [cycle.state, cycle.interruption ?? null], ['running', null])

      // The next process: reconcile, then the cycle's own recover(), then the run's.
      const b = await panel({ root, dir, issueIds: ['wrapper'], harnessDir })
      const recovered = await b.supervisor.reconcile()
      const settled = await readJson(runFile)
      t.eq('reconcile settles the run instead of marking it recovery-required', [settled.status, settled.blockedReason ?? null, recovered.length, Boolean(settled.cycleRun.ownerLost)], ['cancelled', null, 0, true])
      t.eq('it offers no recover', supportedActions(settled), [])
      await b.fv.recover()
      const mirrored = await b.cycleRuns.recover()
      const final = await readJson(runFile)
      t.eq('the run carries how recover() left its cycle', [mirrored.map((m) => m.runId), final.status, final.cycleRun.state], [[started.runId], 'cancelled', 'interrupted'])
      t.ok('recover() destroyed what the cycle\'s instance drive left, as for any interrupted cycle', b.calls.destroys.length > 0, JSON.stringify(b.calls.destroys))
      t.ok('the explanation says the panel stopped before the cycle ended', /panel stopped before the cycle ended/.test(explainRun(final).detail), explainRun(final).detail)
      t.eq('recovering again changes nothing', await b.cycleRuns.recover(), [])
      a.release()
      await a.fv.settle()
    }

    t.section('AC8: a trigger cycle is unchanged: no run, its own trigger')
    {
      const dir = await temp('devpanel-fvrun-hand-')
      const w = await panel({ root, dir, issueIds: [], harnessDir })
      w.release()
      const hand = await w.fv.startNow({ by: 'tester' })
      await w.fv.settle()
      const record = await w.fv.recordOf(hand.id)
      t.eq('a hand start names no run', [record.trigger, record.run ?? null], ['hand', null])
      t.eq('and lists on no project', await w.cycleRuns.forProject(P), [])
      t.eq('recordOf finds an earlier cycle on disk too', (await firstRun.fv.recordOf(firstCycle))?.id, firstCycle)
    }
  } finally {
    await cleanupSandboxes()
    for (const d of temps) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}
