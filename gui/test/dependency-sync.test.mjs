import fs from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
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
import { holdsSync, noteSync, settleRunSyncs, settleSync, stageEvents, standingSyncs, sweepSyncs, syncDisposition } from '../server/runtime/sync-records.mjs'
import { withStageInstance } from '../server/runtime/checks.mjs'
import { destroyRunInstances, holdsInstance, LOCAL_HOST } from '../server/runtime/stage-instances.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { launchReadiness } from '../server/supervisor-readiness.mjs'

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
  const tier = async ({ sync = null, start = null, ready = null, revert = null, declare = true, test = 'ok' } = {}) => {
    const dir = await temp('devpanel-sync-')
    const log = path.join(dir, 'log')
    const say = (word) => `echo ${word} {{instanceName}} >> '${log}'`
    await fs.writeFile(path.join(dir, 'ok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    await fs.writeFile(path.join(dir, 'later'), '#!/bin/sh\ntest -f round-1.txt\n', { mode: 0o755 })
    const modules = {
      collections: ['@*'],
      lint: { id: 'lint', run: `${dir}/ok {{instance}} {{files}}` },
      load: { id: 'load', run: say('load') }, restart: { id: 'restart', run: say('restart') }, ready: { id: 'ready', run: ready ? ready({ dir, say }) : say('ready') },
      test: { id: 'module-selftest', run: `${dir}/${test} {{instance}} {{filter}}` }, finallyCommands: [REPORT],
      instance: {
        root: path.join(dir, 'instances'),
        create: { run: `${say('create')}; if [ ! -f '${dir}/synced' ]; then echo "package.json differs from the base instance's" >&2; exit 3; fi; mkdir -p {{instance}}`, unavailableExitCodes: [3], unavailableReason: 'the candidate\'s dependency manifests differ from the stage\'s' },
        start: start ? start({ dir, say }) : { run: say('start'), busyExitCodes: [4, 5], busyRetrySeconds: 1, staleExitCodes: [6] },
        destroy: { run: `${say('destroy')} && rm -rf {{instance}}` },
        ...(declare ? { syncDependencies: {
          run: `${say('sync')}; printf '%s\\n' {{changed}} > '${dir}/changed'; ${sync ?? `touch '${dir}/synced'`}`, unavailableExitCodes: [3, 7], unavailableReason: 'the stage refused to install this candidate\'s dependencies',
          revert: { run: `echo revert {{instanceName}} >> '${log}'; ${revert ?? `rm -f '${dir}/synced'`}` }
        } } : {})
      }
    }
    const lines = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split(NL).filter(Boolean).map((l) => l.split(' ')[0])
    return { dir, target: { kind: 'local', modules }, lines }
  }
  const records = async () => (await fs.readdir(slotDirectory(LOCAL_HOST)).catch(() => [])).filter((n) => n.startsWith('sync-') && n.endsWith('.json')).sort()
  // Another run's sync, as its noteSync leaves it in the host journal (sync-records.mjs).
  const journalFile = () => path.join(slotDirectory(LOCAL_HOST), 'syncs.jsonl')
  const OTHER = { event: 'sync', owner: 'dp-other', runId: 'run-other', files: ['@c/b/npm.sh'] }
  // One stage two runs share: create refuses whenever the candidate's manifest (`@c/a/npm.sh`, which only the
  // manifest-changing run has) and the stage's (`synced`) differ, as the real one compares them; a sync and a
  // revert stop every instance on it (their `up` goes). `before*`, `sync` and `ready` add barriers for an order.
  const shared = async (barriers = () => ({})) => {
    const dir = await temp('devpanel-shared-stage-')
    const log = path.join(dir, 'log')
    const inst = path.join(dir, 'instances')
    const say = (word) => `echo ${word} {{instanceName}} >> '${log}'`
    const wait = (file) => `i=0; while [ ! -f '${dir}/${file}' ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; `
    const { beforeCreate = '', sync = '', ready = '', revert = null } = barriers({ dir, wait })
    await fs.writeFile(path.join(dir, 'ok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const modules = {
      collections: ['@*'],
      lint: { id: 'lint', run: `${dir}/ok {{instance}} {{files}}` },
      load: { id: 'load', run: say('load') }, restart: { id: 'restart', run: say('restart') },
      ready: { id: 'ready', run: `${ready}test -f {{instance}}/up` },
      test: { id: 'module-selftest', run: `${dir}/ok {{instance}} {{filter}}` }, finallyCommands: [REPORT],
      instance: {
        root: inst,
        create: { run: `${beforeCreate}${say('create')}; if test -f @c/a/npm.sh; then want=1; else want=0; fi; if [ -f '${dir}/synced' ]; then on=1; else on=0; fi; if [ $want != $on ]; then echo "the candidate's manifests differ from the base instance's" >&2; exit 3; fi; mkdir -p {{instance}}`, unavailableExitCodes: [3] },
        start: { run: `${say('start')}; touch {{instance}}/up`, staleExitCodes: [6] },
        destroy: { run: `${say('destroy')} && rm -rf {{instance}}` },
        syncDependencies: {
          run: `${say('sync')}; : {{changed}} ; touch '${dir}/synced'; rm -f '${inst}'/*/up; ${sync}`, unavailableExitCodes: [3, 7],
          revert: { run: `echo revert {{instanceName}} >> '${log}'; ${revert ?? `rm -f '${dir}/synced' '${inst}'/*/up`}` }
        }
      }
    }
    const lines = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split(NL).filter(Boolean)
    return { dir, target: { kind: 'local', modules }, lines }
  }
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
      t.eq('create, sync, create again, the drive as ever; as it ends its instance goes and the sync is reverted', await lines(), ['create', 'sync', 'create', 'start', 'ready', 'destroy', 'revert'])
      t.eq('the records in the order they ran, the refused create not among them', check.commands.map((c) => [c.id, c.passed]).slice(0, 4), [[SYNC_ID, true], [CREATE_ID, true], ['lint', true], [START_ID, true]])
      t.eq('the script got exactly the revision\'s changed manifests', (await fs.readFile(path.join(dir, 'changed'), 'utf8')).trim().split(NL), ['@c/a/npm.sh', '@c/a/package.json'])
      const sync = check.stageInstance.dependencySync
      t.eq('on the check: files, outcome, and what create had said', [sync.files, sync.outcome, Number.isInteger(sync.durationMs), sync.createSaid.includes('package.json differs')], [['@c/a/npm.sh', '@c/a/package.json'], 'synced', true, true])
      t.eq('on the run, reverted by the drive', engine.run.dependencySyncs.map((d) => [d.name, d.outcome, d.files.length, d.settled?.passed, d.settled?.reason]), [[name, 'synced', 2, true, 'drive-ended']])
      t.eq('the instance was created by this drive and destroyed as it ended', [check.stageInstance.created, check.stageInstance.state, check.stageInstance.destroyed?.reason], [true, 'destroyed', 'dependencies-reverted'])
      t.ok('said in words for reviewers', instanceWords(check).includes('were installed on the whole stage') && instanceWords(check).includes('@c/a/package.json') && instanceWords(check).includes('were reverted'), instanceWords(check))
      t.eq('the sync and the revert are waits, begun and ended, which the wall clock excuses', [events.filter((e) => e.type === 'checks-waiting').map((e) => e.reason), (engine.run.driveSlotWaits ?? []).length], [['dependency-sync', 'dependency-revert'], 2])
      t.eq('the stage is back on its deployed set: no marker, no record', [await exists(path.join(dir, 'synced')), (await records()).includes(`sync-${name}.json`)], [false, false])
      const journal = await stageEvents(LOCAL_HOST)
      t.eq('the host journal names each step of it, with the run', journal.filter((e) => e.owner === name).map((e) => [e.event, e.runId]), [['sync', engine.runId], ['synced', engine.runId], ['revert', engine.runId], ['reverted', engine.runId]])
      t.eq('the run\'s end finds nothing left to revert', await settleRunSyncs(engine.runId, { how: 'revert', reason: 'again' }), [])
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

    t.section('create and sync may report the drive unavailable (the run\'s pinned snapshot is gone): no sync follows such a create, and both read the run\'s id')
    {
      const gone = 'devpanel-unavailable: this run\'s application snapshot v-old is no longer on the stage'
      const { dir, target, lines } = await tier()
      const { create } = target.modules.instance
      target.modules.instance.create = { ...create, reportsUnavailable: true, run: `echo "$DEVPANEL_RUN_ID" > '${dir}/create-run'; echo create {{instanceName}} >> '${dir}/log'; echo "${gone}"; exit 1` }
      const { engine } = await scenario({ target, files: MANIFESTS })
      const check = engine.run.checkResults.at(-1)
      t.eq('create: unavailable, though the revision changed a manifest nothing was synced', [check.result, await lines(), engine.run.dependencySyncs, (await records()).length], ['unavailable', ['create'], undefined, 0])
      t.ok('with what create said', check.error.includes('application snapshot v-old is no longer on the stage'), check.error)
      t.eq('create read the run\'s id', (await fs.readFile(path.join(dir, 'create-run'), 'utf8')).trim(), engine.runId)
      t.eq('one revision: no author round on it', engine.run.steps.filter((s) => s.stepId === 'implement').length, 1)
      await end(engine)

      const second = await tier({ sync: `echo "$DEVPANEL_RUN_ID" > '${dir}/sync-run'; echo "${gone}"; exit 1` })
      second.target.modules.instance.syncDependencies.reportsUnavailable = true
      const synced = await scenario({ target: second.target, files: MANIFESTS })
      const refused = synced.engine.run.checkResults.at(-1)
      t.eq('sync: unavailable, no second create, no revert owed', [refused.result, await second.lines(), refused.stageInstance.dependencySync.outcome, (await records()).length], ['unavailable', ['create', 'sync'], 'unavailable', 0])
      t.ok('with what the sync said', refused.error.includes('application snapshot v-old is no longer on the stage'), refused.error)
      t.eq('the sync read the run\'s id', (await fs.readFile(path.join(dir, 'sync-run'), 'utf8')).trim(), synced.engine.runId)
      await end(synced.engine)
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
      t.eq('no sync ran: the stage already had these manifests', engine.run.dependencySyncs, undefined)
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

    // One drive straight through the check runner's instance step (checks.mjs withStageInstance): `commands` are
    // the records the drive leaves, `before` runs as the drive starts, `driveTiming` is the test injection.
    const directDrive = async ({ bound, runId, runDir, commands, outcome, before = null, driveTiming = {} }) => {
      const result = { dir: 'checks/direct', commands: [], result: 'unavailable', error: null }
      let thrown = null
      try {
        await withStageInstance({ target: bound, host: LOCAL_HOST, result, runId, runDir, clock: { now: () => Date.now(), iso: () => new Date().toISOString() }, signal: null, onWait: null, driveTiming, entries: [] }, async () => {
          if (before) await before()
          result.commands.push(...commands)
          result.result = outcome
        })
      } catch (error) { thrown = error }
      return { result, thrown }
    }
    const up = [{ id: CREATE_ID, passed: true }, { id: START_ID, passed: true }, { id: 'ready', passed: true }]

    t.section('AC3: another run\'s sync lands between a held instance\'s journal reading and the drive\'s use of it: it reaches the drive\'s classification, so a failure is environmental, never failed')
    {
      const { dir, target } = await tier()
      const runDir = await temp('devpanel-direct-run-')
      const runId = `direct-gap-${Date.now()}`
      const { target: bound } = modulesDrive(target, { affected: { modules: ['@c/a'], core: null }, files: [], instanceName: instanceName(runId) })
      const first = await directDrive({ bound, runId, runDir, commands: up, outcome: 'passed' })
      t.eq('the first drive leaves a live instance', [first.result.result, first.result.stageInstance.state, holdsInstance(instanceName(runId))], ['passed', 'live', true])
      // The interleaving that escaped both readings: the event lands after the history was read, before the drive ran.
      const gap = await directDrive({ bound, runId, runDir, commands: [{ id: 'load', passed: true }, { id: 'restart', passed: false }], outcome: 'failed',
        driveTiming: { afterStageRead: () => appendFileSync(journalFile(), JSON.stringify({ ...OTHER, at: 'in-the-gap' }) + NL) } })
      const used = gap.result.stageInstance
      t.eq('not replaced (the reading saw nothing), so the reload failed', [used.fresh, used.replaced, used.destroyed?.reason], [false, undefined, 'reload-failed'])
      t.eq('the failure is unavailable and environmental, naming the other run', [gap.result.result, gap.result.environmental?.cause, used.disturbedBy?.map((d) => d.runId)], ['unavailable', 'dependency-sync', ['run-other']])
      // The same event before the drive begins: the reading sees it and the instance is replaced instead.
      await directDrive({ bound, runId, runDir, commands: up, outcome: 'passed' })
      appendFileSync(journalFile(), JSON.stringify({ ...OTHER, at: 'before-the-drive' }) + NL)
      const before = await directDrive({ bound, runId, runDir, commands: up, outcome: 'passed' })
      t.eq('an event before the reading: replaced, not counted again as a disturbance', [before.result.stageInstance.replaced?.reason, before.result.stageInstance.fresh, before.result.stageInstance.disturbedBy, before.result.result], ['stage-dependencies-replaced', true, undefined, 'passed'])
      await destroyRunInstances(runId, { reason: 'test' })
      await fs.rm(path.join(dir, 'instances'), { recursive: true, force: true })
    }

    t.section('AC1: a cancelled drive that synced reverts the sync as it ends')
    {
      const { dir, target } = await tier()
      const runDir = await temp('devpanel-direct-run-')
      const runId = `direct-cancel-${Date.now()}`
      const owner = instanceName(runId)
      const { target: bound } = modulesDrive(target, { affected: { modules: ['@c/a'], core: null }, files: [], instanceName: owner })
      const cancelled = await directDrive({ bound, runId, runDir, commands: [{ id: CREATE_ID, passed: true }], outcome: 'passed',
        before: async () => {
          // As createStep leaves it: the sync noted and installed, then the drive is stopped mid-way.
          await noteSync({ owner, host: LOCAL_HOST, kind: 'local', runId, runDir, revert: { run: `echo cancelled-revert >> '${dir}/log'` }, files: ['@c/a/package.json'] })
          await settleSync(owner, { host: LOCAL_HOST, installed: true, prior: false })
          throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        } })
      t.eq('the cancellation still reaches the caller', cancelled.thrown?.name, 'AbortError')
      t.eq('reverted as the drive ended, the record gone, nothing held', [cancelled.result.stageInstance.dependencySync?.reverted?.passed, cancelled.result.stageInstance.dependencySync?.reverted?.reason, (await fs.readFile(path.join(dir, 'log'), 'utf8')).includes('cancelled-revert'), (await records()).includes(`sync-${owner}.json`), holdsSync(owner)], [true, 'drive-ended', true, false, false])
      await destroyRunInstances(runId, { reason: 'test' })
    }

    t.section('AC2: a sync record rewritten while other runs read it: every reading is whole and names the run and its manifests')
    {
      const owner = 'dp-read-write'
      const dir = await temp('devpanel-sync-rw-')
      // A large record, so a write in place would take long enough to be caught half done.
      const files = Array.from({ length: 4000 }, (_, i) => `@c/m${String(i).padStart(4, '0')}/package.json`)
      await noteSync({ owner, host: LOCAL_HOST, kind: 'local', runId: 'run-rw', revert: { run: `echo rw >> '${dir}/log'` }, files })
      let writing = true
      let readings = 0
      const errors = []
      const missing = []
      const writer = (async () => {
        for (let i = 0; i < 100; i++) await settleSync(owner, { host: LOCAL_HOST, installed: true, prior: true })
        writing = false
      })()
      const reader = async () => {
        while (writing) {
          try {
            const mine = (await standingSyncs()).find((s) => s.owner === owner)
            readings++
            if (!mine || mine.runId !== 'run-rw' || mine.files.length !== files.length) missing.push(readings)
          } catch (error) { errors.push(error.message) }
        }
      }
      await Promise.all([writer, reader(), reader(), reader()])
      t.ok('100 rewrites beside continuous readings: no parse error, the record whole each time', readings > 0 && errors.length === 0 && missing.length === 0, JSON.stringify({ readings, errors: errors.slice(0, 3), errorCount: errors.length, missing: missing.length }))
      t.eq('no temporary file is left beside it', (await fs.readdir(slotDirectory(LOCAL_HOST))).filter((n) => n.endsWith('.tmp')), [])
      t.eq('reverted at the end', (await settleRunSyncs('run-rw', { how: 'revert', reason: 'test' })).map((r) => r.passed), [true])
    }

    t.section('AC1: a sync whose answer never came (a timeout) may have installed: the drive reverts it as it ends all the same')
    {
      const { target, lines } = await tier({ sync: 'sleep 5' })
      target.modules.instance.syncDependencies.timeoutSeconds = 1
      const { engine } = await scenario({ target, files: MANIFESTS })
      const log = await lines()
      const syncs = engine.run.dependencySyncs ?? []
      t.ok('every sync is followed by its revert', log.filter((l) => l === 'sync').length > 0 && log.filter((l) => l === 'sync').length === log.filter((l) => l === 'revert').length && log.indexOf('revert') > log.indexOf('sync'), log.join(','))
      t.eq('each recorded as reverted by its drive; nothing left on record', [syncs.length > 0 && syncs.every((d) => d.outcome === 'failed' && d.settled?.passed === true && d.settled.reason === 'drive-ended'), (await records()).length], [true, 0], JSON.stringify(syncs))
      await end(engine)
    }

    t.section('AC3: another run\'s sync since the instance\'s last drive: it is not loaded into but replaced, and the run is told')
    {
      const { dir, target, lines } = await tier({ test: 'later' })
      await fs.writeFile(path.join(dir, 'synced'), '')
      // Between the first drive and the second, another run syncs the stage (its line in the host journal).
      const { engine, events } = await scenario({ target, files: (round) => { if (round) { appendFileSync(journalFile(), JSON.stringify({ ...OTHER, at: 'between' }) + NL); return { 'round-1.txt': 'work\n' } } return {} } })
      const check = engine.run.checkResults.at(-1)
      t.eq('the run completes on its second revision', [engine.run.status, engine.run.revisions.length, check.result], ['completed', 2, 'passed'], check.error ?? engine.run.blockedReason)
      t.eq('no load into the stopped instance: destroyed and created again', await lines(), ['create', 'start', 'ready', 'destroy', 'create', 'start', 'ready'])
      t.eq('the replacement names the other run', [check.stageInstance.replaced?.reason, check.stageInstance.replaced?.by?.map((d) => [d.event, d.runId])], ['stage-dependencies-replaced', [['sync', 'run-other']]])
      t.eq('told on the run and as an event', [engine.run.stageDisturbances?.map((d) => d.by.map((b) => [b.when, b.runId])), events.filter((e) => e.type === 'stage-instance-disturbed').length], [[[['before-drive', 'run-other']]], 1])
      t.ok('and in words', instanceWords(check).includes('another run\'s dependency sync (run run-other'), instanceWords(check))
      await end(engine)
    }

    t.section('AC3: another run\'s sync stops the instance during the drive: unavailable and environmental, not failed; one more drive, whose pass stands; no author round')
    {
      const { dir, target } = await tier({ ready: ({ dir: d, say }) => `if [ ! -f '${d}/ready-once' ]; then touch '${d}/ready-once'; echo '${JSON.stringify(OTHER)}' >> '${journalFile()}'; echo "the instance is not running" >&2; exit 1; fi; ${say('ready')}` })
      await fs.writeFile(path.join(dir, 'synced'), '')
      const { engine, events } = await scenario({ target })
      const check = engine.run.checkResults.at(-1)
      const first = check.attempts?.[0]
      t.eq('the run completes on its one revision, with no author round', [engine.run.status, engine.run.revisions.length, engine.run.steps.filter((s) => s.stepId === 'implement').length], ['completed', 1, 1], check.error ?? engine.run.blockedReason)
      t.eq('the disturbed drive: unavailable, environmental, naming the other run', [first?.result, first?.environmental?.cause, first?.environmental?.by?.map((d) => d.runId)], ['unavailable', 'dependency-sync', ['run-other']])
      t.ok('with why', first?.error?.includes('run run-other') && first.error.includes('says nothing about the candidate'), first?.error)
      t.eq('the second drive passed, recovered from the environment, not flaky', [check.result, check.recoveredFrom, check.flaky], ['passed', 'environmental', undefined])
      t.eq('one retry, the run told', [events.filter((e) => e.type === 'checks-retry').length, engine.run.stageDisturbances?.map((d) => [d.environmental, d.by[0].when])], [1, [[true, 'during-drive']]])
      await end(engine)
    }

    t.section('AC1 and AC2: a revert that fails as the drive ends stays on record; the supervisor and other runs read it, and another run\'s create is environmental')
    {
      const { dir, target } = await shared(() => ({ revert: 'echo "the deployed set could not be installed" >&2; exit 1' }))
      const a = await scenario({ target, files: MANIFESTS })
      const aCheck = a.engine.run.checkResults.at(-1)
      const owner = instanceName(a.engine.runId)
      t.eq('the manifest-changing run passes; its revert as the drive ended failed', [aCheck.result, aCheck.stageInstance.dependencySync.reverted?.passed], ['passed', false], aCheck.error)
      t.ok('said in words', instanceWords(aCheck).includes('their revert failed'), instanceWords(aCheck))
      const standing = (await standingSyncs()).find((s) => s.owner === owner)
      t.eq('the record names the run, the deviating manifests and the state, and nobody answers for it now', [standing?.runId, standing?.files, standing?.state, standing?.held, Boolean(standing?.revertFailed)], [a.engine.runId, ['@c/a/npm.sh', '@c/a/package.json'], 'revert-failed', false, true])
      const readiness = await launchReadiness({ project: P, projectPath: dir, inspect: async () => null, stagingSyncs: () => standingSyncs() })
      t.eq('the supervisor\'s readiness lists it', readiness.stagingSyncs?.filter((s) => s.owner === owner).map((s) => [s.runId, s.state]), [[a.engine.runId, 'revert-failed']])
      const b = await scenario({ target })
      const bCheck = b.engine.run.checkResults.at(-1)
      t.eq('the other run: unavailable and environmental, no author round', [bCheck.result, bCheck.environmental?.cause, bCheck.environmental?.by?.map((s) => s.runId), b.engine.run.steps.filter((s) => s.stepId === 'implement').length], ['unavailable', 'dependency-sync', [a.engine.runId], 1])
      t.ok('its reason names the run whose dependencies stand', bCheck.error.includes(a.engine.runId) && bCheck.error.includes('could not revert'), bCheck.error)
      t.eq('told on the run', b.engine.run.stageDisturbances?.at(-1)?.by.map((d) => [d.when, d.runId]), [['at-create', a.engine.runId]])
      await fs.rm(path.join(slotDirectory(LOCAL_HOST), `sync-${owner}.json`), { force: true })
      await end(a.engine)
      await end(b.engine)
    }

    t.section('AC4: two concurrent runs on one stage, one changing a manifest and the other not: both drives complete, and the stage is left on its deployed set')
    for (const [order, barriers] of [
      // (i) The manifest-changing run's sync stands when the other run creates: that create waits for the revert (or, when the revert came first, sees it in the journal) and asks again.
      ['its sync stands when the other run creates', ({ dir, wait }) => ({
        beforeCreate: `if ! test -f @c/a/npm.sh && [ ! -f '${dir}/b-go' ]; then ${wait('synced')}touch '${dir}/b-go'; fi; `,
        sync: wait('b-go')
      })],
      // (ii) The other run's instance is up and in its drive when the sync stops it: that drive is environmental, the next one passes.
      ['the other run is mid-drive when it syncs', ({ dir, wait }) => ({
        beforeCreate: `if test -f @c/a/npm.sh && [ ! -f '${dir}/a-go' ]; then ${wait('b-at-ready')}touch '${dir}/a-go'; fi; `,
        sync: `touch '${dir}/a-synced'`,
        ready: `if ! test -f @c/a/npm.sh && [ ! -f '${dir}/b-ready-once' ]; then touch '${dir}/b-at-ready'; ${wait('a-synced')}touch '${dir}/b-ready-once'; fi; `
      })]
    ]) {
      const { dir, target, lines } = await shared(barriers)
      const [a, b] = await Promise.all([scenario({ target, files: MANIFESTS }), scenario({ target })])
      const [aCheck, bCheck] = [a.engine.run.checkResults.at(-1), b.engine.run.checkResults.at(-1)]
      t.eq(`${order}: both runs complete on their one revision, both drives passed`, [a.engine.run.status, b.engine.run.status, aCheck.result, bCheck.result, a.engine.run.revisions.length, b.engine.run.revisions.length], ['completed', 'completed', 'passed', 'passed', 1, 1], `${aCheck.error ?? a.engine.run.blockedReason} | ${bCheck.error ?? b.engine.run.blockedReason} | ${(await lines()).join(',')}`)
      t.eq(`${order}: the manifest-changing run synced and reverted as its drive ended`, [a.engine.run.dependencySyncs?.map((d) => [d.outcome, d.settled?.passed])], [[['synced', true]]])
      t.eq(`${order}: the stage is back on its deployed set, no sync on record`, [await exists(path.join(dir, 'synced')), (await standingSyncs()).length], [false, 0])
      const told = b.engine.run.stageDisturbances ?? []
      t.ok(`${order}: the other run was told, naming the manifest-changing run`, told.some((d) => d.by.some((x) => x.runId === a.engine.runId)), JSON.stringify(told))
      if (order.startsWith('the other run is mid-drive')) {
        t.eq(`${order}: its disturbed drive was environmental, the next one passed`, [bCheck.attempts?.[0]?.result, bCheck.attempts?.[0]?.environmental?.cause, bCheck.recoveredFrom], ['unavailable', 'dependency-sync', 'environmental'])
      } else t.eq(`${order}: its create waited for, or saw, the sync and asked again`, [bCheck.stageInstance.foreignSync?.by?.[0]?.runId, bCheck.attempts], [a.engine.runId, undefined])
      await end(a.engine)
      await end(b.engine)
    }

    t.section('what becomes of a sync, read off its run')
    {
      const delivered = { status: 'completed', outcome: 'resolved', delivery: { action: 'apply-to-source', completedAt: 'now' }, revisions: [{}] }
      t.eq('only a run still driving keeps a standing sync; a pause, a shutdown, a delivery and every other end revert it; so does a run that is gone',
        [syncDisposition({ status: 'paused' }), syncDisposition({ status: 'cancelled', stoppedBy: 'service-shutdown' }), syncDisposition(delivered),
          syncDisposition({ status: 'blocked' }), syncDisposition({ status: 'failed' }), syncDisposition({ status: 'cancelled' }), syncDisposition(null), syncDisposition({ status: 'running' })],
        ['revert', 'revert', 'revert', 'revert', 'revert', 'revert', 'revert', 'live'])
    }

    t.section('the supervisor: a sync still standing at a run\'s end, its pause or a shutdown is reverted where the instance is destroyed; a deleted run is tried again')
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
        t.eq('a paused run: reverted, the record gone (its next drive syncs again)', [(await read(paused.issue, paused.runId)).status, (await logged()).includes('paused'), await exists(paused.file)], ['paused', true, false])
        await paused.supervisor.stop(paused.named).catch(() => {})
        await paused.supervisor.settle()

        const shut = await live('shutdown')
        await shut.supervisor.shutdown({ graceMs: 15000 })
        t.eq('a service shutdown reverts it too: the resumed run syncs again', [(await read(shut.issue, shut.runId)).stoppedBy, (await logged()).includes('shutdown'), await exists(shut.file)], ['service-shutdown', true, false])

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
        const by = Object.fromEntries(swept.map((s) => [s.owner, s.passed]))
        t.eq('reverted: the ended, vanished, crashed, paused and delivered runs\' syncs', [by['dp-ended'], by['dp-gone'], by['dp-crashed'], by['dp-paused'], by['dp-delivered']], [true, true, true, true, true], JSON.stringify(swept))
        const left = (await records()).map((n) => n.slice(5, -5)).filter((n) => n.startsWith('dp-')).sort()
        t.eq('kept: a run that drives again in this process, a live owner\'s, an unknown owner\'s', left, ['dp-live', 'dp-resumed', 'dp-unknown'])
        t.eq('each revert ran once', (await logged()).filter((l) => l.startsWith('swept-')).sort(), ['swept-dp-crashed', 'swept-dp-delivered', 'swept-dp-ended', 'swept-dp-gone', 'swept-dp-paused'])
        for (const owner of ['dp-live', 'dp-resumed', 'dp-unknown']) await fs.rm(path.join(hostDir, `sync-${owner}.json`), { force: true })
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
