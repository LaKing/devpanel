import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { engineFixture } from './fakes/fixture.mjs'
import {
  REPOSITORY_FAULTS, inspectSourceRepository, repositoryFaultError, usesSourceRepository
} from '../server/runtime/source-repository.mjs'

export const name = 'start preconditions — a checkout git cannot read is refused before anything is reserved or spent'

const exec = promisify(execFile)
const NL = String.fromCharCode(10)
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')

const temps = []
const temp = async (prefix) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir }

/** A repository with one commit, optionally left dirty the way a live checkout is. */
async function checkout ({ commit = true, dirty = false, untracked = false } = {}) {
  const dir = await temp('precond-proj-')
  await exec('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await exec('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await exec('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'source.txt'), 'committed' + NL)
  if (commit) {
    await exec('git', ['-C', dir, 'add', '-A'])
    await exec('git', ['-C', dir, 'commit', '-qm', 'base'])
  }
  if (dirty) await fs.writeFile(path.join(dir, 'source.txt'), 'live edit' + NL)
  if (untracked) await fs.writeFile(path.join(dir, 'live-only.txt'), 'never committed' + NL)
  return dir
}

/** git as another user sees it, without needing another user: git's own test hook. */
const asAnotherOwner = async (projectPath, args) => {
  try {
    const { stdout } = await exec('git', ['-C', projectPath, ...args], { env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } })
    return { ok: true, stdout: stdout.trim(), stderr: '' }
  } catch (error) {
    return { ok: false, stdout: '', stderr: (error.stderr ?? error.message ?? '').trim() }
  }
}

/**
 * A fixture whose supervisor sees `repository` as the project checkout, and
 * whose fake runtime records every probe it is asked for.
 *
 * The probe log is the evidence for the claim that costs nothing: preflight
 * probes at model depth, one paid call per participant, so a start that is
 * refused before reservation has to leave that file absent.
 */
async function supervisorOver (repository, { playbook = 'implementation' } = {}) {
  const f = await engineFixture({ playbook })
  const projectsDir = path.join(f.issuesDir, 'projects')
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.symlink(repository ?? f.projectPath, path.join(projectsDir, 'devpanel-project'))

  const state = await temp('precond-state-')
  const probeLog = path.join(state, 'probes.jsonl')
  const control = path.join(state, 'control.json')
  await fs.writeFile(control, JSON.stringify({ ledger: path.join(state, 'ledger.jsonl'), delayMs: 0 }))
  process.env.DEVPANEL_FAKE_CONTROL = control
  // The real fake runtime, wrapped so that asking it anything is recorded.
  await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), [
    'import fs from \'node:fs/promises\'',
    `export * from ${JSON.stringify(HARNESS_MODULE)}`,
    `import { probe as base } from ${JSON.stringify(HARNESS_MODULE)}`,
    'export async function probe (options) {',
    `  await fs.appendFile(${JSON.stringify(probeLog)}, JSON.stringify(options?.model ?? null) + ${JSON.stringify(NL)})`,
    '  return base(options)',
    '}'
  ].join(NL) + NL)

  // Project actions resolve the checkout from the environment, the way the
  // server does; the suite restores what it found when it finishes.
  process.env.DEVPANEL_PROJECTS_DIR = projectsDir
  const { createSupervisor } = await import('../server/supervisor.mjs')
  const supervisor = createSupervisor({
    issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot
  })
  return {
    f,
    supervisor,
    projectPath: repository ?? f.projectPath,
    start: (options = {}) => supervisor.start({ project: 'devpanel-project', issueId: f.issue.id, playbookId: playbook, configRoot: f.configRoot, ...options }),
    probes: async () => (await fs.readFile(probeLog, 'utf8').catch(() => '')).split(NL).filter(Boolean).length,
    runs: async () => (await fs.readdir(path.join(f.issuePath, 'runs')).catch(() => [])).filter((e) => !e.startsWith('.'))
  }
}

const refusal = async (start) => { try { await start(); return null } catch (error) { return error } }

export default async function (t) {
  const projectsDirBefore = process.env.DEVPANEL_PROJECTS_DIR
  t.section('1. every fault the source checkout can have, named from git\'s own words')
  {
    t.eq('a committed checkout is usable', await inspectSourceRepository({ projectPath: await checkout() }), null)

    const empty = await inspectSourceRepository({ projectPath: await checkout({ commit: false }) })
    t.eq('a repository with no commits is EMPTY_REPOSITORY', empty?.code, 'EMPTY_REPOSITORY')
    t.ok('naming the unborn branch and why it matters', /refs\/heads\/main.*no commits.*base commit/s.test(empty?.message ?? ''), empty?.message)
    t.ok('and the remedy is an initial commit', /git commit/.test(empty?.remedy ?? ''), empty?.remedy)

    const plain = await inspectSourceRepository({ projectPath: await temp('precond-plain-') })
    t.eq('a directory that is not a repository is NOT_A_REPOSITORY', plain?.code, 'NOT_A_REPOSITORY')
    t.ok('with git\'s own refusal kept as evidence', /not a git repository/i.test(plain?.detail ?? ''), plain?.detail)

    const foreign = await checkout()
    const unsafe = await inspectSourceRepository({ projectPath: foreign, git: asAnotherOwner })
    t.eq('a checkout owned by another user is UNSAFE_REPOSITORY', unsafe?.code, 'UNSAFE_REPOSITORY')
    t.ok('the remedy names both the ownership fix and the exception', /chown/.test(unsafe?.remedy ?? '') && unsafe?.remedy?.includes(`safe.directory ${foreign}`), unsafe?.remedy)

    // HEAD that is neither a symbolic ref nor a commit: not "empty", and saying
    // so would send an operator to make a commit that changes nothing.
    const broken = await checkout()
    await fs.writeFile(path.join(broken, '.git', 'HEAD'), '0'.repeat(40) + NL)
    const unreadable = await inspectSourceRepository({ projectPath: broken })
    t.eq('a HEAD that resolves to nothing is UNREADABLE_REPOSITORY', unreadable?.code, 'UNREADABLE_REPOSITORY')

    t.ok('every code is one of the stable four', [empty, plain, unsafe, unreadable].every((f) => REPOSITORY_FAULTS.includes(f.code)))
  }

  t.section('2. cleanliness is not judged here — the base policy decides that, at provisioning time')
  {
    t.eq('a checkout with tracked modifications is readable', await inspectSourceRepository({ projectPath: await checkout({ dirty: true }) }), null)
    t.eq('and so is one with untracked files', await inspectSourceRepository({ projectPath: await checkout({ untracked: true }) }), null)
  }

  t.section('3. the refusal carries its own classification, because there is no run to carry it')
  {
    const error = repositoryFaultError(await inspectSourceRepository({ projectPath: await checkout({ commit: false }) }))
    t.eq('rejected as unprocessable', error.status, 422)
    t.eq('classified as the environment\'s fault', error.class, 'environment')
    t.eq('nothing was started', error.started, false)
    t.eq('and retrying it unchanged cannot help', error.retryable, false)
    t.eq('the code travels with it', error.code, 'EMPTY_REPOSITORY')
    t.ok('the message a panel shows already contains the remedy', error.message.includes(error.remedy), error.message)
  }

  t.section('4. a deployment run is exempt: its workspace is a staged release, not a worktree of this repository')
  {
    t.eq('implementation needs the source checkout', usesSourceRepository({ tactic: null }), true)
    t.eq('so does staging, which is cut from it', usesSourceRepository({ tactic: 'staging' }), true)
    t.eq('deployment does not', usesSourceRepository({ tactic: 'deployment' }), false)
  }

  t.section('5. a start on an empty checkout is refused before reservation, before probing, before spending')
  {
    const s = await supervisorOver(await checkout({ commit: false }))
    const error = await refusal(s.start)
    t.eq('the start is refused', error?.code, 'EMPTY_REPOSITORY')
    t.eq('with the environment classification on the rejected start', [error?.status, error?.class, error?.started, error?.retryable], [422, 'environment', false, false])
    t.ok('and the remedy', /git commit/.test(error?.remedy ?? ''), error?.remedy)
    t.eq('no model was probed', await s.probes(), 0)
    t.eq('no run was reserved', await s.runs(), [])
    await s.supervisor.settle()
  }

  t.section('6. the same gate for a directory that is not a repository, and for one owned by another user')
  {
    const plain = await supervisorOver(await temp('precond-plain-srv-'))
    const notRepo = await refusal(plain.start)
    t.eq('not a repository is refused', notRepo?.code, 'NOT_A_REPOSITORY')
    t.eq('nothing was probed or reserved', [await plain.probes(), (await plain.runs()).length], [0, 0])
    await plain.supervisor.settle()

    const foreign = await supervisorOver(await checkout())
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1'
    const unsafe = await refusal(foreign.start)
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER
    t.eq('a checkout git calls dubious is refused', unsafe?.code, 'UNSAFE_REPOSITORY')
    t.ok('naming the checkout', unsafe?.message?.includes('owned by another user'), unsafe?.message)
    t.eq('nothing was probed or reserved', [await foreign.probes(), (await foreign.runs()).length], [0, 0])
    await foreign.supervisor.settle()
  }

  t.section('7. a readable checkout still starts, and the base policy still decides what happens to a dirty one')
  {
    const healthy = await supervisorOver(null)
    const started = await healthy.start()
    await healthy.supervisor.settle()
    const { readRun } = await import('../server/runtime/store.mjs')
    const run = await readRun(healthy.f.issuePath, started.runId)
    t.eq('a committed checkout reaches a real run', run.status, 'completed', run.blockedReason)
    t.ok('and the participants were probed', await healthy.probes() > 0)

    // Whether a dirty checkout is acceptable is still the base policy's
    // decision, and provisioning still takes it against the tree as it is then.
    // The same reading is now also taken before reservation, because a start
    // refused only at provisioning had already paid for its preflight.
    const dirty = await supervisorOver(await checkout({ dirty: true }))
    // The implementation strategy snapshots a dirty tree by default; the run
    // chooses head, whose policy refuses one.
    const refusal = await dirty.start({ runOptions: { base: 'head' } }).catch((e) => e)
    t.eq('a dirty checkout under base "head" is refused before anything is reserved', (await dirty.runs()).length, 0)
    t.eq('with the refusal classified, since there is no run to carry it', [refusal.status, refusal.code, refusal.started], [422, 'DIRTY_BASE', false])
    t.ok('in the base policy\'s own words', /requires a clean checkout/.test(refusal.message ?? ''), refusal.message)
    t.eq('and nothing was probed', await dirty.probes(), 0)
  }

  // The top-level supervisor, with every tool stubbed except the ones under
  // test: `start` is the real supervisor, and `launchState`/`runProjectAction`
  // (when given) the real ones, so what is exercised is the production path and
  // not a copy of it.
  async function coordinator (s, { launchState = null, script, until, calls = 12, mission = 'Run the issue' } = {}) {
    const { createTopSupervisor } = await import('../server/top-supervisor.mjs')
    const issueId = s.f.issue.id
    let remaining = (script ?? [
      () => ({ type: 'preview', project: 'devpanel-project', issueId, playbook: 'implementation' }),
      (e) => ({ type: 'start_run', project: 'devpanel-project', issueId, previewId: e.result.previewId })
    ]).slice()
    const adapter = {
      invoke: async (args) => {
        const event = JSON.parse(args.prompt).event
        return { session: args.session ?? { id: 'session' }, response: JSON.stringify({ message: 'ok', action: remaining.shift()?.(event) ?? null }), usage: { costUsd: 0 } }
      }
    }
    const tools = {
      projects: async () => [{ id: 'devpanel-project' }],
      playbooks: async () => [],
      infrastructure: async () => ({}),
      listIssues: async () => [{ id: issueId }],
      getIssue: async () => ({ name: 'issue' }),
      // The real configuration hash: a start is bound to the preview it came
      // from, so a stub hash would fail the binding instead of the gate.
      preview: async () => {
        const { resolvePlaybook } = await import('../server/config/load.mjs')
        const resolved = await resolvePlaybook('implementation', { root: s.f.configRoot, runOptions: {}, projectId: 'devpanel-project' })
        return { ok: true, configHash: resolved.ok ? resolved.resolved.configHash : 'unresolved' }
      },
      // The real run's state: stopping an owned run, and judging whether a slot
      // is free, both read it.
      getRun: async (project, issueId, runId) => {
        const { readRun } = await import('../server/runtime/store.mjs')
        return readRun(s.f.issuePath, runId).then((r) => ({ runId, status: r.status })).catch(() => ({ runId, status: 'running' }))
      },
      stop: (a) => s.supervisor.stop({ project: a.project, issueId: a.issueId, runId: a.runId }).catch(() => ({})),
      createIssue: (a) => s.f.issues.createIssue(a.project, { input: a.input }),
      addNote: (a) => s.f.issues.createStep(a.project, a.issueId, { name: 'supervisor-note', text: a.text, format: 'md' }),
      start: (p) => s.supervisor.start({ project: p.project, issueId: p.issueId, playbookId: 'implementation', expectConfigHash: p.configHash, runOptions: p.runOptions, configRoot: s.f.configRoot, supervisorLaunchId: p.launchId }),
      ...(launchState ? { launchState } : {})
    }
    const agent = await createTopSupervisor({ dir: await temp('precond-sup-'), models: async () => [{ id: 'test-model', title: 'Test', model: 'wire', defaultEffort: 'high', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    const told = () => agent.get().messages.filter((m) => m.role === 'tool').map((m) => m.text).join(NL)
    await agent.start({ model: 'test-model', focus: ['devpanel-project'], message: mission, limits: { maxCalls: calls, maxRuns: 3, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    const done = until ?? (() => /no valid HEAD/.test(told()))
    const end = Date.now() + 15000
    while (!done(agent.get(), told())) {
      if (Date.now() > end) break
      await new Promise((r) => setTimeout(r, 20))
    }
    const state = agent.get()
    const text = told()
    await agent.stop().catch(() => {})
    await agent.shutdown().catch(() => {})
    return { state, told: text }
  }

  t.section('8. the coordinator\'s start_run meets the same gate, and its slot is released')
  {
    const s = await supervisorOver(await checkout({ commit: false }))
    try {
      const { state, told } = await coordinator(s)
      t.ok('the coordinator is told what is wrong with the checkout', /no valid HEAD/.test(told), told.slice(0, 200))
      t.ok('and what to do about it', /git commit/.test(told), told.slice(0, 200))
      const launch = state.launches.at(-1)
      t.eq('the launch is recorded as failed, not uncertain', launch?.status, 'failed')
      t.eq('so the concurrency slot is released rather than held', state.launches.filter((a) => ['reserved', 'uncertain'].includes(a.status)).length, 0)
      t.eq('and the unchanged input is remembered as a failed launch', Object.keys(state.failedLaunches ?? {}).length, 1)
      t.eq('no model was probed and no run was reserved', [await s.probes(), (await s.runs()).length], [0, 0])
    } finally { await s.supervisor.settle() }
  }

  t.section('9. with the launch-state tool wired as the service wires it, the same fault is named before a start is even spent')
  {
    const s = await supervisorOver(await checkout({ commit: false }))
    const { inspectLaunchState } = await import('../server/supervisor-launch-state.mjs')
    try {
      const { state, told } = await coordinator(s, {
        launchState: (p) => inspectLaunchState({ projectPath: s.projectPath, workspace: {}, configHash: p.configHash })
      })
      t.ok('admission names the fault in the same words', /Launch condition unresolved.*no valid HEAD/s.test(told), told.slice(0, 200))
      t.ok('with the same remedy', /git commit/.test(told), told.slice(0, 200))
      t.eq('no start attempt was spent on it', state.starts, 0)
      t.eq('and no launch was reserved', state.launches.length, 0)
      t.eq('nothing was probed and no run exists', [await s.probes(), (await s.runs()).length], [0, 0])
    } finally { await s.supervisor.settle() }
  }

  t.section('10. a repository fault is delegated as an issue, not acted on: the supervisor has no verb for it')
  {
    const repository = await checkout({ commit: false })
    const s = await supervisorOver(repository)
    const { inspectLaunchState } = await import('../server/supervisor-launch-state.mjs')
    const issueId = s.f.issue.id
    try {
      const { state, told } = await coordinator(s, {
        launchState: (p) => inspectLaunchState({ projectPath: s.projectPath, workspace: {}, configHash: p.configHash }),
        mission: 'Run the issue, and commit the project checkout if that is what is blocking the run.',
        calls: 20,
        script: [
          () => ({ type: 'preview', project: 'devpanel-project', issueId, playbook: 'implementation' }),
          (e) => ({ type: 'start_run', project: 'devpanel-project', issueId, previewId: e.result.previewId }),
          // Even asked plainly by the mission, this is not a verb the plane has.
          () => ({ type: 'run_project_action', project: 'devpanel-project', action: 'push' }),
          () => ({ type: 'create_issue', project: 'devpanel-project', input: 'The checkout has no commits; commit its starting files before runs can be cut from it.' })
        ],
        until: (state) => (state.observedIssues?.['devpanel-project'] ?? '').includes('checkout')
      })
      t.ok('the start is refused and says what could clear it', /"resolvableBy":"commit-action"/.test(told), told.slice(0, 200))
      t.ok('running the commit action is not an action that exists', /Unknown or malformed supervisor action/.test(told) || state.messages.some((m) => /Unknown or malformed/.test(m.text ?? '')), told.slice(-300))
      const log = await exec('git', ['-C', s.projectPath, 'log', '--oneline']).then((r) => r.stdout.trim()).catch(() => '')
      t.eq('so the checkout is untouched', log, '')
      const issues = await s.f.issues.listIssues('devpanel-project')
      t.eq('and the work is recorded where work is recorded', issues.length, 2)
      t.eq('with no start spent on a fault it cannot clear', [state.starts, (await s.runs()).length], [0, 0])
    } finally { await s.supervisor.settle() }
  }

  t.section('10b. an operator-owned fault is delegated as an issue, not retried and not improvised')
  {
    const s = await supervisorOver(await temp('precond-plain-srv-'))
    const { inspectLaunchState } = await import('../server/supervisor-launch-state.mjs')
    const issueId = s.f.issue.id
    try {
      const { state, told } = await coordinator(s, {
        launchState: (p) => inspectLaunchState({ projectPath: s.projectPath, workspace: {}, configHash: p.configHash }),
        script: [
          () => ({ type: 'preview', project: 'devpanel-project', issueId, playbook: 'implementation' }),
          (e) => ({ type: 'start_run', project: 'devpanel-project', issueId, previewId: e.result.previewId }),
          () => ({ type: 'create_issue', project: 'devpanel-project', input: 'The checkout at /projects/devpanel-project is not a git repository; initialise it and commit its starting files before runs can be cut from it.' })
        ],
        until: (state) => (state.observedIssues?.['devpanel-project'] ?? '').includes('checkout')
      })
      t.ok('the refusal says no configured action can clear it', /"resolvableBy":"operator"/.test(told), told.slice(0, 200))
      const issues = await s.f.issues.listIssues('devpanel-project')
      t.eq('the work is recorded as an issue rather than left in the chat', issues.length, 2)
      t.ok('naming the fault and the remedy', issues.some((i) => /not a git repository|checkout/i.test(i.name ?? '')), issues.map((i) => i.name).join(' | '))
      t.eq('and no start was spent on a fault no action can fix', [state.starts, (await s.runs()).length], [0, 0])
    } finally { await s.supervisor.settle() }
  }

  // The real supervisor behind the real gate, without the service's wrapper, so
  // the classification has to be on the refusals themselves.
  const gateOver = async (s, state) => {
    const { createStartGate } = await import('../server/supervisor-starts.mjs')
    const launched = []
    const gate = createStartGate({
      getState: () => state, save: async () => {},
      tools: {
        getRun: async () => ({ status: 'running' }),
        start: async (p) => { const r = await s.supervisor.start({ project: p.project, issueId: p.issueId, playbookId: 'implementation', configRoot: s.f.configRoot, supervisorLaunchId: p.launchId }); launched.push(r); return r }
      }
    })
    return { gate, launched }
  }
  const gateState = () => ({ status: 'active', starts: 0, calls: 0, startsByIssue: {}, launches: [], failedLaunches: {}, ownedRuns: [], activationStarts: 0, activationId: 'a', limits: { maxRuns: 2, maxStartsPerIssue: 2, maxConcurrent: 5, maxCalls: 20 } })
  const previewOf = (issueId) => ({ project: 'devpanel-project', issueId, playbook: 'implementation', runOptions: {}, configHash: 'config' })
  const holdPreflight = async (ms) => {
    const control = process.env.DEVPANEL_FAKE_CONTROL
    await fs.writeFile(control, JSON.stringify({ ...JSON.parse(await fs.readFile(control, 'utf8')), probeDelayMs: ms }))
  }

  t.section('10c. a busy project refuses the same start repeatedly, and admits it once the project frees')
  {
    const s = await supervisorOver(null)
    const issueId = s.f.issue.id
    const second = await s.f.issues.createIssue('devpanel-project', { input: 'Another issue of the same project' })
    try {
      await holdPreflight(60000)
      const holding = await s.start()
      const state = gateState()
      const { gate, launched } = await gateOver(s, state)
      for (let n = 0; n < 4; n++) {
        const refused = await refusal(() => gate.start(previewOf(second.id)))
        t.ok(`refusal ${n + 1} names the busy project`, /already active on this project/.test(refused?.message ?? ''), refused?.message)
        t.eq('and is marked', [refused?.status, refused?.started, refused?.retryable], [409, false, true])
      }
      t.eq('nothing is recorded in failedLaunches', state.failedLaunches, {})
      t.eq('no launch reservation or slot is held', state.launches.filter((a) => ['reserved', 'uncertain'].includes(a.status)).length, 0)
      t.eq('no start was used, past both caps', [state.starts, JSON.stringify(state.startsByIssue)], [0, '{}'])

      const again = await refusal(() => s.start())
      t.eq('the holding issue itself refuses as active, marked', [/already active for this issue/.test(again?.message ?? ''), again?.started, again?.retryable], [true, false, true])

      // A second process sees the run only in persisted state: its lock owner.
      const { createSupervisor } = await import('../server/supervisor.mjs')
      const other = createSupervisor({ issues: s.f.issues, harnessDir: path.join(s.f.configRoot, 'harness'), projectsDir: path.join(s.f.issuesDir, 'projects'), configRoot: s.f.configRoot })
      const persisted = await refusal(() => other.start({ project: 'devpanel-project', issueId: second.id, playbookId: 'implementation', configRoot: s.f.configRoot }))
      t.eq('another process\'s run on the project refuses the same way', [/already active on this project/.test(persisted?.message ?? ''), persisted?.started, persisted?.retryable], [true, false, true])

      await s.supervisor.stop({ project: 'devpanel-project', issueId, runId: holding.runId })
      await s.supervisor.settle()
      await holdPreflight(0)
      const result = await gate.start(previewOf(second.id))
      t.ok('once the project frees the identical start is admitted', Boolean(result?.runId))
      t.eq('as a real launch', launched.length, 1)
      t.eq('charged once', [state.starts, state.startsByIssue[`devpanel-project/${second.id}`]], [1, 1])
    } finally { await holdPreflight(0); await s.supervisor.settle() }
  }

  t.section('10d. the other occupancy refusals of a start are marked')
  {
    const s = await supervisorOver(null)
    try {
      const [first, racing] = await Promise.allSettled([s.start(), s.start()])
      t.eq('a double start: the first goes ahead', first.status, 'fulfilled')
      t.eq('the second is refused as starting, marked', [/already being started/.test(racing.reason?.message ?? ''), racing.reason?.started, racing.reason?.retryable], [true, false, true])
      await s.supervisor.settle()

      const { acquire } = await import('../server/runtime/lock.mjs')
      const held = await acquire(path.join(s.f.issuePath, '.run.lock'), { purpose: 'test', runId: 'held' })
      const locked = await refusal(() => s.start())
      await held.release()
      t.eq('a held run lock is marked', [locked?.message, locked?.status, locked?.started, locked?.retryable], ['another run already holds this issue', 409, false, true])

      const { createAvailabilityStore } = await import('../server/runtime/failure.mjs')
      const { resolvePlaybook } = await import('../server/config/load.mjs')
      const resolved = await resolvePlaybook('implementation', { root: s.f.configRoot, runOptions: {}, projectId: 'devpanel-project' })
      const model = Object.values(resolved.resolved.participants)[0].model.id
      const store = createAvailabilityStore(path.join(s.f.issuesDir, '.availability.json'))
      await store.recordExhausted({ modelId: model, reason: 'test hold', retryAfterMs: 3600000 })
      const cooling = await refusal(() => s.start())
      t.eq('a model on an availability hold is marked', [/is exhausted until/.test(cooling?.message ?? ''), cooling?.started, cooling?.retryable], [true, false, true])
      await store.clear(model)
      const state = gateState()
      t.ok('and the start passes once the hold is cleared', Boolean((await (await gateOver(s, state)).gate.start(previewOf(s.f.issue.id)))?.runId))
    } finally { await s.supervisor.settle() }
  }

  t.section('10e. a persistent fault stays guarded on the unchanged start')
  {
    const s = await supervisorOver(await checkout({ commit: false }))
    try {
      const state = gateState()
      const { gate, launched } = await gateOver(s, state)
      const issueKey = `devpanel-project/${s.f.issue.id}`
      const first = await refusal(() => gate.start(previewOf(s.f.issue.id)))
      t.eq('the fault is refused as not retryable', [first?.code, first?.started, first?.retryable], ['EMPTY_REPOSITORY', false, false])
      t.eq('and is recorded in failedLaunches', Object.keys(state.failedLaunches).length, 1)
      t.eq('its start stays charged', [state.starts, state.startsByIssue[issueKey]], [1, 1])
      const second = await refusal(() => gate.start(previewOf(s.f.issue.id)))
      t.ok('the unchanged start is refused', /Unchanged failed launch is blocked/.test(second?.message ?? ''), second?.message)
      t.eq('without reaching the supervisor or charging again', [launched.length, state.launches.length, state.starts], [0, 1, 1])
      t.eq('no run exists', (await s.runs()).length, 0)
    } finally { await s.supervisor.settle() }
  }

  t.section('11. over HTTP, a refused start is a 422 that carries the code, the class and the remedy')
  {
    const { startStage } = await import('./browser/stage.mjs')
    const stage = await startStage()
    // A second project beside the stage's own, initialised but never committed —
    // exactly the state a freshly created project directory is in.
    const empty = path.join(stage.projectsDir, 'empty-project')
    await fs.mkdir(empty)
    await exec('git', ['-C', empty, 'init', '-q', '-b', 'main'])
    const issue = (await stage.request('/api/projects/empty-project/issues', { method: 'POST', body: JSON.stringify({ name: 'The displayed text is not as desired' }) })).body
    const refused = await stage.request(`/api/projects/empty-project/issues/${issue.id}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
    t.eq('refused 422 with the code', [refused.status, refused.body?.code], [422, 'EMPTY_REPOSITORY'])
    t.eq('classified on the response, because there is no run to classify', [refused.body?.class, refused.body?.started, refused.body?.retryable], ['environment', false, false])
    t.ok('the message a panel shows already contains the remedy', /git commit/.test(refused.body?.error ?? ''), refused.body?.error)
    t.ok('and git\'s own words are kept as detail', /Needed a single revision|refs\/heads\/main/.test(refused.body?.detail ?? ''), refused.body?.detail)
    const listed = (await stage.request(`/api/projects/empty-project/issues/${issue.id}/runs`)).body
    t.eq('no run was created', (Array.isArray(listed) ? listed : listed?.runs ?? []).length, 0)
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
  delete process.env.DEVPANEL_FAKE_CONTROL
  if (projectsDirBefore === undefined) delete process.env.DEVPANEL_PROJECTS_DIR
  else process.env.DEVPANEL_PROJECTS_DIR = projectsDirBefore
}
