import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { modulesErrors } from '../server/infrastructure.mjs'
import { currentOwner } from '../server/runtime/lock.mjs'
import { slotDirectory } from '../server/runtime/drive-slots.mjs'
import { modulesDrive } from '../server/runtime/modules-tier.mjs'
import { CREATE_ID, DESTROY_ID, instanceName, instanceWords, START_ID, SYNC_ID } from '../server/runtime/instance-drive.mjs'
import { changedManifests, syncOf } from '../server/runtime/dependency-sync.mjs'
import { noteSync, settleRunSyncs, sweepSyncs, syncDisposition } from '../server/runtime/sync-records.mjs'
import { destroyRunInstances, holdsInstance, LOCAL_HOST } from '../server/runtime/stage-instances.mjs'
import { createSupervisor } from '../server/supervisor.mjs'

export const name = 'dependency sync — a run that changes dependency manifests gets them installed on the stage: create\'s refusal, the sync and the second create, a revision that changed none, the stage\'s refusals, a stale instance, a start held by a sync, and the revert at every undelivered end and for a dead owner'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const NL = String.fromCharCode(10)
const P = 'devpanel-project'
const HARNESS_MODULE = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')
const REPORT = { id: 'collect', run: 'echo "== runtime/selftest.report"; echo \'{"tests":[{"test":"@c/a: works"}]}\'', report: 'selftest' }

/** An Implementation run on a `kind: local` modules tier; the worker writes `files` (path -> content) beside a module file. */
async function scenario ({ target, files = {} }) {
  const state = { engine: null }
  const script = async (turn) => {
    const { stepId, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      const ws = state.engine.run.workspace.path
      for (const [rel, text] of Object.entries({ '@c/a/x.mjs': `export const round = ${round}\n`, ...(typeof files === 'function' ? files(round) : files) })) {
        await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true })
        await fs.writeFile(path.join(ws, rel), text)
      }
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
  const MANIFESTS = { '@c/a/package.json': '{"dependencies":{"is-number":"7.0.0"}}\n', '@c/a/npm.sh': 'npm install is-number@7.0.0\n' }
  // A stage that refuses a create until `synced` exists, as one whose manifests differ from the candidate's does.
  // Every command appends "<word> <instance name>" to a log; `sync` (shell text) is what the sync command does.
  const tier = async ({ sync = null, start = null, declare = true, test = 'ok' } = {}) => {
    const dir = await temp('devpanel-sync-')
    const log = path.join(dir, 'log')
    const say = (word) => `echo ${word} {{instanceName}} >> '${log}'`
    await fs.writeFile(path.join(dir, 'ok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await fs.writeFile(path.join(dir, 'later'), '#!/bin/sh\ntest -f round-1.txt\n', { mode: 0o755 })
    const modules = {
      collections: ['@*'],
      lint: { id: 'lint', run: `${dir}/ok {{instance}} {{files}}` },
      load: { id: 'load', run: say('load') }, restart: { id: 'restart', run: say('restart') }, ready: { id: 'ready', run: say('ready') },
      test: { id: 'module-selftest', run: `${dir}/${test} {{instance}} {{filter}}` }, finallyCommands: [REPORT],
      instance: {
        root: path.join(dir, 'instances'),
        create: { run: `${say('create')}; if [ ! -f '${dir}/synced' ]; then echo "package.json differs from the base instance's" >&2; exit 3; fi; mkdir -p {{instance}}`, unavailableExitCodes: [3], unavailableReason: 'the candidate\'s dependency manifests differ from the stage\'s' },
        start: start ? start({ dir, say }) : { run: say('start'), busyExitCodes: [4, 5], busyRetrySeconds: 1, staleExitCodes: [6] },
        destroy: { run: `${say('destroy')} && rm -rf {{instance}}` },
        ...(declare ? { syncDependencies: {
          run: `${say('sync')}; printf '%s\\n' {{changed}} > '${dir}/changed'; ${sync ?? `touch '${dir}/synced'`}`, unavailableExitCodes: [3, 7], unavailableReason: 'the stage refused to install this candidate\'s dependencies',
          revert: { run: `echo revert {{instanceName}} >> '${log}'; rm -f '${dir}/synced'` }
        } } : {})
      }
    }
    const lines = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split(NL).filter(Boolean).map((l) => l.split(' ')[0])
    return { dir, target: { kind: 'local', modules }, lines }
  }
  const records = async () => (await fs.readdir(slotDirectory(LOCAL_HOST)).catch(() => [])).filter((n) => n.startsWith('sync-') && n.endsWith('.json')).sort()
  const end = async (engine) => { await destroyRunInstances(engine.runId, { reason: 'test' }); await settleRunSyncs(engine.runId, { how: 'revert', reason: 'test' }); await releaseWorkspace(engine) }

  try {
    t.section('which paths are dependency manifests, and what the sync command receives')
    {
      const entries = [{ path: 'package.json', status: 'modified' }, { path: '@c/a/package-lock.json', status: 'added' }, { path: '@c/a/npm.sh', status: 'unchanged' }, { path: '@c/b/dnf.sh', status: 'deleted' },
        { path: '@boilerplate/node-version', status: 'modified' }, { path: '@c/a/package.json.mjs', status: 'modified' }, { path: 'it\'s/package.json', status: 'added' }]
      t.eq('changed manifests by file name, deletions included, unchanged ones not', changedManifests(entries), ['@boilerplate/node-version', '@c/a/package-lock.json', '@c/b/dnf.sh', 'it\'s/package.json', 'package.json'])
      t.eq('a project may name its own', changedManifests(entries, ['npm.sh', 'package.json.mjs']), ['@c/a/package.json.mjs'])
      const { target } = await tier()
      const { target: bound } = modulesDrive(target, { affected: { modules: ['@c/a'], core: null }, files: [], instanceName: 'dp-run' })
      const sync = syncOf(bound.stageInstance, entries)
      t.ok('each path arrives as one shell word, the owner named', sync.command.run.includes('printf \'%s\\n\' \'@boilerplate/node-version\' \'@c/a/package-lock.json\' \'@c/b/dnf.sh\' \'it\'\\\'\'s/package.json\' \'package.json\' >') && sync.command.run.includes('echo sync dp-run') && sync.command.id === SYNC_ID, sync.command.run)
      t.eq('the revert names the owner too', sync.revert.run.includes('echo revert dp-run'), true)
      t.eq('a tier without the declaration has no sync', syncOf({ name: 'x' }, entries), null)

      t.section('configuration: what a syncDependencies declaration must hold')
      const m = target.modules
      const withSync = (over) => modulesErrors({ modules: { ...m, instance: { ...m.instance, syncDependencies: { ...m.instance.syncDependencies, ...over } } } })
      t.eq('a whole declaration passes', modulesErrors(target), [])
      t.ok('the command takes the changed paths once, as a word of its own', withSync({ run: 'sync {{instanceName}}' }).some((e) => e.includes('{{changed}}')) && withSync({ run: 'sync {{instanceName}} "{{changed}}"' }).some((e) => e.includes('{{changed}}')) && withSync({ run: 'sync {{instanceName}} {{changed}} {{changed}}' }).length === 1)
      t.ok('the sync and the revert name the owner', withSync({ run: 'sync {{changed}}' }).length === 1 && withSync({ revert: { run: 'revert-it' } }).some((e) => e.includes('revert.run')))
      t.ok('an exit is a wait or a refusal, not both', withSync({ busyExitCodes: [7] }).some((e) => e.includes('not both')))
      t.ok('so is start\'s', modulesErrors({ modules: { ...m, instance: { ...m.instance, start: { ...m.instance.start, staleExitCodes: [5] } } } }).some((e) => e.includes('not both')))
      t.ok('create must be able to say when', modulesErrors({ modules: { ...m, instance: { ...m.instance, create: { run: m.instance.create.run } } } }).some((e) => e.includes('create.unavailableExitCodes')))
      t.ok('the engine\'s ids are reserved', [SYNC_ID, DESTROY_ID].every((id) => modulesErrors({ modules: { ...m, finallyCommands: [{ ...REPORT, id }] } }).some((e) => e.includes(id))))
      const resolved = await (async () => { const f = await engineFixture({ playbook: 'implementation' }); await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `\nchecks: ${JSON.stringify({ requirement: 'required', target: { kind: 'local', modules: { ...m, instance: { ...m.instance, syncDependencies: { run: 'x {{instanceName}} {{changed}}' } } } } })}\n`); return resolvePlaybook('implementation', { root: f.configRoot, projectId: P }) })()
      t.ok('the schema requires the revert beside the sync', !resolved.ok && resolved.errors.some((e) => /revert/.test(e.message)), JSON.stringify(resolved.errors?.map((e) => e.message)))
    }

    t.section('a revision that changes a manifest: create refuses, the stage is synced, create runs again; the sync is on the check, on the run and on record')
    {
      const { dir, target, lines } = await tier()
      const { engine, events } = await scenario({ target, files: MANIFESTS })
      const name = instanceName(engine.runId)
      const check = engine.run.checkResults.at(-1)
      t.eq('the run completes on its one revision', [engine.run.status, engine.run.revisions.length, check.result], ['completed', 1, 'passed'], check.error ?? engine.run.blockedReason)
      t.eq('create, sync, create again, then the drive as ever', await lines(), ['create', 'sync', 'create', 'start', 'ready'])
      t.eq('the records in the order they ran, the refused create not among them', check.commands.map((c) => [c.id, c.passed]).slice(0, 4), [[SYNC_ID, true], [CREATE_ID, true], ['lint', true], [START_ID, true]])
      t.eq('the script got exactly the revision\'s changed manifests', (await fs.readFile(path.join(dir, 'changed'), 'utf8')).trim().split(NL), ['@c/a/npm.sh', '@c/a/package.json'])
      const sync = check.stageInstance.dependencySync
      t.eq('on the check: files, outcome, and what create had said', [sync.files, sync.outcome, Number.isInteger(sync.durationMs), sync.createSaid.includes('package.json differs')], [['@c/a/npm.sh', '@c/a/package.json'], 'synced', true, true])
      t.eq('on the run, so the supervisor knows a revert may be owed', engine.run.dependencySyncs.map((d) => [d.name, d.outcome, d.files.length, d.settled]), [[name, 'synced', 2, undefined]])
      t.eq('the instance was created by this drive', [check.stageInstance.created, check.stageInstance.state], [true, 'live'])
      t.ok('said in words for reviewers', instanceWords(check).includes('were installed on the whole stage') && instanceWords(check).includes('@c/a/package.json'), instanceWords(check))
      t.eq('the sync is a wait, begun and ended, which the wall clock excuses', [events.filter((e) => e.type === 'checks-waiting').map((e) => e.reason), (engine.run.driveSlotWaits ?? []).length], [['dependency-sync'], 1])
      t.eq('a record on the host\'s slots names the run and how to revert', [(await records()).includes(`sync-${name}.json`), JSON.parse(await fs.readFile(path.join(slotDirectory(LOCAL_HOST), `sync-${name}.json`), 'utf8')).runId], [true, engine.runId])
      await destroyRunInstances(engine.runId, { reason: 'test' })
      const reverted = await settleRunSyncs(engine.runId, { how: 'revert', reason: 'run-blocked' })
      t.eq('the revert runs once, after the instance is gone, and the record goes', [reverted.map((r) => [r.owner, r.passed, r.reason]), (await lines()).slice(-2), await exists(path.join(dir, 'synced')), (await records()).includes(`sync-${name}.json`)], [[[name, true, 'run-blocked']], ['destroy', 'revert'], false, false])
      t.eq('a second call finds nothing to revert', await settleRunSyncs(engine.runId, { how: 'revert', reason: 'again' }), [])
      await releaseWorkspace(engine)
    }

    t.section('a revision that changed no manifest: unavailable as before, told to start again from the current base; nothing is synced')
    {
      const { target, lines } = await tier()
      const { engine } = await scenario({ target })
      const check = engine.run.checkResults.at(-1)
      t.eq('unavailable, create alone ran', [check.result, await lines(), engine.run.status === 'completed'], ['unavailable', ['create'], false])
      t.ok('with create\'s reason and the way out', check.error.includes('package.json differs') && check.error.includes('Start the run again from the current base'), check.error)
      t.eq('nothing on the run, nothing on record, no slot held', [engine.run.dependencySyncs, check.stageInstance.dependencySync.outcome, (await records()).length, holdsInstance(instanceName(engine.runId))], [undefined, 'not-changed', 0, false])
      await end(engine)

      const none = await tier({ declare: false })
      const plain = await scenario({ target: none.target, files: MANIFESTS })
      t.eq('a tier that declares no sync keeps today\'s refusal, manifest or not', [plain.engine.run.checkResults.at(-1).result, await none.lines(), plain.engine.run.checkResults.at(-1).stageInstance.dependencySync], ['unavailable', ['create'], undefined])
      await end(plain.engine)
    }

    t.section('the stage refuses the sync (not this candidate\'s, needs a release, another owner\'s stands): unavailable with what it said, no author round, no revert owed')
    for (const [code, words] of [[3, 'the base instance moved ahead of the candidate'], [7, 'the dependencies of dp-other are installed']]) {
      const { target, lines } = await tier({ sync: `echo "${words}" >&2; exit ${code}` })
      const { engine } = await scenario({ target, files: MANIFESTS })
      const check = engine.run.checkResults.at(-1)
      t.eq(`exit ${code}: unavailable, no second create`, [check.result, await lines(), check.commands.map((c) => c.id)], ['unavailable', ['create', 'sync'], [SYNC_ID, 'collect']])
      t.ok('the reason is the stage\'s own', check.error.includes(words) && check.error.includes(`exit ${code}`) && check.stageInstance.dependencySync.outcome === 'unavailable', check.error)
      t.eq('one revision, the refusal on the run, no record left', [engine.run.steps.filter((s) => s.stepId === 'implement').length, engine.run.dependencySyncs.map((d) => d.outcome), (await records()).length], [1, ['unavailable'], 0])
      await end(engine)
    }
    {
      // The install fails on the first revision's bytes: that is the author's to fix, and the stage says it put the previous set back.
      const { target, lines } = await tier({ sync: 'if grep -q 7.0.0 @c/a/package.json; then echo "the install failed; the previous dependencies are installed again" >&2; exit 1; fi; touch "$(dirname "$0")/synced" 2>/dev/null; exit 1' })
      const { engine, events } = await scenario({ target, files: MANIFESTS })
      const first = engine.run.checkHistory[0]
      t.eq('a failed install is a failed check, not unavailable', [first.result, (await lines()).slice(0, 2), engine.run.dependencySyncs[0].outcome], ['failed', ['create', 'sync'], 'failed'])
      t.eq('with no second drive on the same bytes: it would restart the base again for the same answer', [events.filter((e) => e.type === 'checks-retry').length, events.find((e) => e.type === 'checks-retry-skipped')?.reason, (await lines()).slice(2, 4)], [0, 'dependency-sync-failed', ['create', 'sync']])
      t.eq('and leaves no record: the stage chose the exit', (await records()).length, 0)
      await end(engine)
    }

    t.section('an earlier sync of the run stands when a later one is refused; a sync whose answer never came is still owed')
    {
      const slotsDir = await temp('devpanel-sync-slots-')
      const dir = await temp('devpanel-sync-prior-')
      const note = (files) => noteSync({ owner: 'dp-prior', host: 'h', kind: 'local', runId: 'run-prior', revert: { run: `echo revert >> '${dir}/log'` }, files, slotsDir })
      const { settleSync } = await import('../server/runtime/sync-records.mjs')
      t.eq('the first note finds none', await note(['a/package.json']), false)
      await settleSync('dp-prior', { host: 'h', installed: true, prior: false, slotsDir })
      t.eq('the second finds the first', await note(['b/npm.sh']), true)
      await settleSync('dp-prior', { host: 'h', installed: false, prior: true, slotsDir })
      const record = JSON.parse(await fs.readFile(path.join(slotDirectory('h', slotsDir), 'sync-dp-prior.json'), 'utf8'))
      t.eq('the record stays, naming every file ever handed over', record.files, ['a/package.json', 'b/npm.sh'])
      t.eq('and is reverted with the run', (await settleRunSyncs('run-prior', { how: 'revert', reason: 'run-failed', slotsDir })).map((r) => r.passed), [true])
      await note(['a/package.json'])
      await settleSync('dp-prior', { host: 'h', installed: false, prior: false, slotsDir })
      t.eq('a refused first sync leaves nothing', await exists(path.join(slotDirectory('h', slotsDir), 'sync-dp-prior.json')), false)
    }

    t.section('start says the instance went stale: destroyed, created again and started in the same drive, no failure and no retry')
    {
      const stale = ({ dir, say }) => ({ run: `if [ ! -f '${dir}/stale-once' ]; then touch '${dir}/stale-once'; echo "the base instance's dependencies were replaced after {{instanceName}} was created" >&2; exit 6; fi; ${say('start')}`, busyExitCodes: [4, 5], busyRetrySeconds: 1, staleExitCodes: [6] })
      const { dir, target, lines } = await tier({ start: stale })
      await fs.writeFile(path.join(dir, 'synced'), '')
      const { engine, events } = await scenario({ target })
      const check = engine.run.checkResults.at(-1)
      t.eq('the run completes on its one revision', [engine.run.status, check.result], ['completed', 'passed'], check.error ?? engine.run.blockedReason)
      t.eq('create, (start refused), destroy, create, start', await lines(), ['create', 'destroy', 'create', 'start', 'ready'])
      t.eq('one create and one start on the record, the destroy between', check.commands.map((c) => c.id).slice(0, 4), [CREATE_ID, 'lint', DESTROY_ID, START_ID])
      t.ok('recorded on the instance and said in words', check.stageInstance.recreated?.reason === 'stale' && instanceWords(check).includes('gone stale'), JSON.stringify(check.stageInstance))
      t.eq('no retry, one instance on the run', [events.filter((e) => e.type === 'checks-retry').length, engine.run.stageInstances.length], [0, 1])
      await end(engine)

      // Stale because another run's sync stands: the second create is refused, and that is unavailable, not a failure.
      const other = await tier({ start: ({ dir, say }) => ({ run: `rm -f '${dir}/synced'; echo stale {{instanceName}} >&2; exit 6`, staleExitCodes: [6] }) })
      await fs.writeFile(path.join(other.dir, 'synced'), '')
      const refused = await scenario({ target: other.target })
      const last = refused.engine.run.checkResults.at(-1)
      t.eq('a stale instance that cannot be created again: unavailable, the instance gone', [last.result, await other.lines(), last.stageInstance.state, await exists(last.stageInstance.root)], ['unavailable', ['create', 'destroy', 'create'], 'destroyed', false])
      t.ok('with why', last.error.includes('Start the run again from the current base'), last.error)
      await end(refused.engine)
    }

    t.section('a later revision that changes a manifest is not loaded into the run\'s instance: the instance is replaced, so create decides')
    {
      // The first revision's test fails on its own exit; the second adds a manifest.
      const { dir, target, lines } = await tier({ test: 'later' })
      await fs.writeFile(path.join(dir, 'synced'), '')
      const { engine } = await scenario({ target, files: (round) => round ? { ...MANIFESTS, 'round-1.txt': 'work\n' } : {} })
      const check = engine.run.checkResults.at(-1)
      t.eq('the run completes on its second revision', [engine.run.status, engine.run.revisions.length], ['completed', 2], check.error ?? engine.run.blockedReason)
      t.eq('no load: the instance is destroyed and made again from the candidate', await lines(), ['create', 'start', 'ready', 'destroy', 'create', 'start', 'ready'])
      t.eq('on the check and on the run', [check.stageInstance.fresh, check.stageInstance.replaced?.reason, engine.run.stageInstances.map((i) => i.destroyed?.reason)], [true, 'dependencies-changed', ['dependencies-changed', undefined]])
      await end(engine)

      // The same two revisions without a manifest: loaded into the one instance, as ever.
      const same = await tier({ test: 'later' })
      await fs.writeFile(path.join(same.dir, 'synced'), '')
      const plain = await scenario({ target: same.target, files: (round) => round ? { 'round-1.txt': 'work\n' } : {} })
      t.eq('a revision that changes none is loaded', [plain.engine.run.status, await same.lines()], ['completed', ['create', 'start', 'ready', 'load', 'restart', 'ready']])
      await end(plain.engine)
    }

    t.section('start says a deployment or a sync holds the stage: a wait like a full stage')
    {
      const held = ({ dir, say }) => ({ run: `n=$(cat '${dir}/n' 2>/dev/null || echo 0); echo $((n+1)) > '${dir}/n'; if [ "$n" -lt 1 ]; then exit 5; fi; ${say('start')}`, busyExitCodes: [4, 5], busyRetrySeconds: 1, staleExitCodes: [6] })
      const { dir, target } = await tier({ start: held })
      await fs.writeFile(path.join(dir, 'synced'), '')
      const { engine, events } = await scenario({ target })
      const start = engine.run.checkResults.at(-1).commands.find((c) => c.id === START_ID)
      t.eq('asked again, started, told as a wait', [engine.run.status, start.passed, start.attempts, events.filter((e) => e.type === 'checks-waiting').length], ['completed', true, 2, 1])
      await end(engine)
    }

    t.section('what becomes of a sync, read off its run')
    {
      const delivered = { status: 'completed', outcome: 'resolved', delivery: { action: 'apply-to-source', completedAt: 'now' }, revisions: [{}] }
      t.eq('paused keeps; a shutdown\'s stop keeps while the next start resumes it; delivered drops; every other end reverts; gone reverts',
        [syncDisposition({ status: 'paused' }), syncDisposition({ status: 'cancelled', stoppedBy: 'service-shutdown' }, { resume: true }), syncDisposition({ status: 'cancelled', stoppedBy: 'service-shutdown' }, { resume: false }), syncDisposition(delivered),
          syncDisposition({ ...delivered, delivery: { action: 'worktree-diff', completedAt: 'now' } }), syncDisposition({ status: 'blocked' }), syncDisposition({ status: 'failed' }), syncDisposition({ status: 'cancelled' }), syncDisposition(null), syncDisposition({ status: 'running' })],
        ['keep', 'keep', 'revert', 'drop', 'revert', 'revert', 'revert', 'revert', 'revert', 'live'])
    }

    t.section('the supervisor: reverts where it destroys the instance of a run that ended undelivered; a pause and a shutdown keep the sync; a deleted run is tried again')
    {
      const f = await engineFixture()
      const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, control: process.env.DEVPANEL_FAKE_CONTROL }
      const dir = await temp('devpanel-sync-ends-')
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
        const hostDir = slotDirectory(LOCAL_HOST)
        // A live run that synced, as its first modules drive leaves it.
        const live = async (label, revert = `echo ${label} >> '${dir}/log'`) => {
          const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
          const issue = await f.issues.createIssue(P, { name: `Sync ${label}` })
          const { runId } = await supervisor.start({ project: P, issueId: issue.id, playbookId: f.playbookId, configRoot: f.configRoot })
          const owner = instanceName(runId)
          await noteSync({ owner, host: LOCAL_HOST, kind: 'local', runId, runDir: path.join(issue.path, 'runs', runId), revert: { run: revert }, files: ['package.json'] })
          return { supervisor, issue, runId, owner, file: path.join(hostDir, `sync-${owner}.json`), named: { project: P, issueId: issue.id, runId } }
        }

        const stopped = await live('stopped')
        await stopped.supervisor.stop(stopped.named)
        await stopped.supervisor.settle()
        t.eq('a stopped run: reverted, the record gone', [(await read(stopped.issue, stopped.runId)).status, (await logged()).includes('stopped'), await exists(stopped.file)], ['cancelled', true, false])

        const paused = await live('paused')
        await paused.supervisor.pause(paused.named)
        await paused.supervisor.settle()
        t.eq('a paused run keeps its claim: no revert, the record stays', [(await read(paused.issue, paused.runId)).status, (await logged()).includes('paused'), await exists(paused.file)], ['paused', false, true])
        await paused.supervisor.stop(paused.named).catch(() => {})
        await paused.supervisor.settle()
        const afterPause = await read(paused.issue, paused.runId)
        if (afterPause.status === 'paused') await settleRunSyncs(paused.runId, { how: 'revert', reason: 'test' })
        t.eq('and is reverted once the run ends', await exists(paused.file), false)

        const shut = await live('shutdown')
        await shut.supervisor.shutdown({ graceMs: 15000 })
        t.eq('a service shutdown keeps it for the resume at the next start', [(await read(shut.issue, shut.runId)).stoppedBy, (await logged()).includes('shutdown'), await exists(shut.file)], ['service-shutdown', false, true])

        t.section('the sweep at the panel\'s start: a dead owner\'s sync is judged by its run; a live or unknown owner\'s is never touched')
        const me = await currentOwner()
        const dead = { ...me, pid: 999999, processStartedAt: '1' }
        const plant = async (owner, runDir, lockOwner) => {
          await fs.writeFile(path.join(hostDir, `sync-${owner}.json`), JSON.stringify({ owner, runId: path.basename(runDir ?? 'none'), runDir, kind: 'local', host: LOCAL_HOST, revert: { run: `echo swept-${owner} >> '${dir}/log'` }, files: ['package.json'] }))
          if (lockOwner) await fs.writeFile(path.join(hostDir, `sync-${owner}.lock`), JSON.stringify({ purpose: 'dependency-sync', token: `t-${owner}`, owner: lockOwner }))
        }
        const fakeRun = async (id, run, lockOwner = null) => {
          const issueDir = path.join(dir, `issue-${id}`)
          const runDir = path.join(issueDir, 'runs', id)
          await fs.mkdir(runDir, { recursive: true })
          await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ runId: id, ...run }))
          if (lockOwner) await fs.writeFile(path.join(issueDir, '.run.lock'), JSON.stringify({ purpose: 'run', token: 't', owner: { ...lockOwner, runId: id } }))
          return runDir
        }
        await plant('dp-ended', await fakeRun('ended', { status: 'blocked' }), dead)
        await plant('dp-gone', path.join(dir, 'no-such-issue', 'runs', 'gone'), dead)
        await plant('dp-crashed', await fakeRun('crashed', { status: 'running' }, dead), dead)
        await plant('dp-paused', await fakeRun('paused', { status: 'paused' }), dead)
        await plant('dp-delivered', await fakeRun('delivered', { status: 'completed', outcome: 'resolved', delivery: { action: 'apply-to-source', completedAt: 'now' }, revisions: [{}] }), dead)
        await plant('dp-resumed', await fakeRun('resumed', { status: 'running' }, me), null)
        await plant('dp-live', await fakeRun('live', { status: 'blocked' }), me)
        await plant('dp-unknown', await fakeRun('unknown', { status: 'blocked' }), { ...me, host: 'another-machine' })
        const swept = await sweepSyncs()
        const by = Object.fromEntries(swept.map((s) => [s.owner, s.kept ?? s.passed]))
        t.eq('reverted: the ended run\'s, the vanished run\'s, the crashed run\'s; forgotten: the delivered run\'s', [by['dp-ended'], by['dp-gone'], by['dp-crashed'], by['dp-delivered'], by[shut.owner]], [true, true, true, 'delivered', undefined], JSON.stringify(swept))
        const left = (await records()).map((n) => n.slice(5, -5)).filter((n) => n.startsWith('dp-') && n !== shut.owner).sort()
        t.eq('kept: a paused run\'s, a run that drives again in this process, a live owner\'s, an unknown owner\'s', left, ['dp-live', 'dp-paused', 'dp-resumed', 'dp-unknown'])
        t.eq('the shutdown\'s run keeps its record too: it awaits the resume', await exists(shut.file), true)
        t.eq('each revert ran once', (await logged()).filter((l) => l.startsWith('swept-')).sort(), ['swept-dp-crashed', 'swept-dp-ended', 'swept-dp-gone'])
        for (const owner of ['dp-live', 'dp-paused', 'dp-resumed', 'dp-unknown', shut.owner]) await fs.rm(path.join(hostDir, `sync-${owner}.json`), { force: true })
        for (const owner of ['dp-live', 'dp-unknown']) await fs.rm(path.join(hostDir, `sync-${owner}.lock`), { force: true })

        // A revert that fails at the run's end leaves the record; deleting the run tries again.
        const failing = await live('deleted', `test -f '${dir}/may-revert' && echo deleted >> '${dir}/log'`)
        await failing.supervisor.stop(failing.named)
        await failing.supervisor.settle()
        t.eq('a failed revert keeps the record, with why', [await exists(failing.file), Boolean(JSON.parse(await fs.readFile(failing.file, 'utf8')).revertFailed)], [true, true])
        await fs.writeFile(path.join(dir, 'may-revert'), '')
        await failing.supervisor.deleteRun(failing.named)
        t.eq('a deleted run: reverted', [(await logged()).at(-1), await exists(failing.file)], ['deleted', false])
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
