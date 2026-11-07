import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { startRun, worktreeDiffDelivery, releaseOwnership, gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { applyToSource } from '../server/runtime/source-delivery.mjs'
import { differingPaths, inertProof, isInert, mergeOntoSource, reconcileUnavailable } from '../server/runtime/source-reconcile.mjs'
import { runMetrics } from '../server/runtime/run-metrics.mjs'
import { loadConfig } from '../server/config/load.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { undeliveredApproval } from '../server/runtime/carry-forward.mjs'
import { supportedActions, createSupervisor } from '../server/supervisor.mjs'
import { autoReconcileRefusal } from '../server/runtime/auto-reconcile.mjs'
import { readCheckLog } from '../server/runtime/check-log.mjs'
import { getRun } from '../server/runs-api.mjs'
import { summariseRun } from '../server/supervisor-summary.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import { reconcilePending } from '../server/runtime/run-control.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
export const name = 'reconcile-delivery — an approved patch refused for drift on its own paths is merged onto the source, revalidated and delivered'

const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

/*
 * The source repository has server.mjs (ten lines) and changelog.txt. During
 * the implement turn the author changes the worktree and someone else changes
 * the live checkout (`source`), so the approved patch is refused at delivery
 * for drift on its own paths. The local check fails only on the combination
 * of the candidate's fix and an INCOMPATIBLE source line, so it passes on the
 * approved candidate and on the source alone (no inherited failure) and fails
 * on a merge of the two.
 */
const COMPATIBLE = '      - id: compatible\n        run: "! (grep -q fixed server.mjs && grep -q INCOMPATIBLE server.mjs)"\n'
async function blockedRun ({ worktree, source, commands = COMPATIBLE, target = '' }) {
  let engine
  const script = scriptFor()
  const f = await engineFixture({ playbook: 'implementation', delivery: 'apply-to-source', script: async (turn) => {
    if (turn.stepId === 'implement') {
      for (const [file, text] of Object.entries(worktree)) await fs.writeFile(path.join(engine.run.workspace.path, file), text)
      for (const [file, text] of Object.entries(source)) await fs.writeFile(path.join(f.projectPath, file), text)
    }
    return script(turn.stepId.startsWith('audit-implement-') ? { ...turn, stepId: 'audit-implementation' } : turn)
  } })
  await fs.writeFile(path.join(f.projectPath, 'server.mjs'), lines(10))
  await fs.writeFile(path.join(f.projectPath, 'changelog.txt'), 'v1 released\n')
  await git(f.projectPath, 'add', '-A')
  await git(f.projectPath, 'commit', '-qm', 'source')
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
    `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: 0\n${target}    commands:\n${commands}`)
  const options = { base: 'working-tree', participants: { 'auditor-1': { model: 'opus-5' } } }
  const resolved = await resolvePlaybook(f.playbookId, { root: f.configRoot, projectId: 'devpanel-project', runOptions: options })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({ ...f, issue: { ...f.issue, project: 'devpanel-project' }, deliveryProvider: worktreeDiffDelivery, expectConfigHash: resolved.resolved.configHash, runOptions: options })
  await engine.drive()
  return { f, engine }
}

const read = (f, file) => fs.readFile(path.join(f.projectPath, file), 'utf8')
const getRunView = async (f, engine) => summariseRun(await getRun(f.issuePath, engine.runId, { issues: f.issues, project: 'devpanel-project', issueId: f.issue.id }))
const checkNumber = (dir) => dir.split('/')[1]

const PROJECT = 'devpanel-project'
const RETRY_MS = 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const periods = () => sleep(RETRY_MS * 10)
const until = async (test, label) => {
  const end = Date.now() + 60000
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await sleep(10)
  }
}
const CHANGELOG_ONLY = { worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }), 'changelog.txt': 'candidate: fixed line 9\nv1 released\n' }, source: { 'changelog.txt': 'other: landed first\nv1 released\n' } }
const CODE_CONFLICT = { worktree: { 'server.mjs': lines(10, { 5: 'line 5 by the candidate' }) }, source: { 'server.mjs': lines(10, { 5: 'line 5 by someone else' }) } }
const DECLARED = "'**/changelog.txt': prepend"
const PREPEND = { '**/changelog.txt': 'prepend' }
// A clean code edit at delivery merges by itself (source-merge.mjs); a run blocks for reconcile only beside this changelog conflict.
const WITH_CHANGELOG = ({ worktree, source }) => ({ worktree: { ...CHANGELOG_ONLY.worktree, ...worktree }, source: { ...CHANGELOG_ONLY.source, ...source } })
const types = (events) => events.map((e) => e.type)
const finishes = (events, runId = null) => events.filter((e) => e.type === 'run-finished' && (!runId || e.runId === runId)).length
const shows = (run, text) => JSON.stringify(explainRun(run)).includes(text)
const DO_NOT_LAND = 'automatic reconcile running; do not land by hand'

export default async function (t) {
  const temps = []
  const runFile = (f, runId) => path.join(f.issuePath, 'runs', runId, 'run.json')
  const record = async (f, runId) => JSON.parse(await fs.readFile(runFile(f, runId), 'utf8'))

  /* A run blocked at delivery, its project declaring `policy`, and a supervisor whose events are kept. */
  async function supervisedRun (scenario, { policy = DECLARED, wrap = (issues) => issues, onEvent = null } = {}) {
    const { f, engine } = await blockedRun(scenario)
    await fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true })
    await fs.writeFile(path.join(f.configRoot, 'projects', `${PROJECT}.yaml`), `id: ${PROJECT}\nworkspace:\n  reconcile:\n    ${policy}\n`)
    await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reconcile-projects-'))
    temps.push(projectsDir)
    await fs.symlink(f.projectPath, path.join(projectsDir, PROJECT))
    const open = (over = {}) => {
      const events = []
      const handler = over.onEvent ?? onEvent
      const supervisor = createSupervisor({ issues: (over.wrap ?? wrap)(f.issues), emit: (e) => { events.push(e); handler?.(e) }, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot, reconcileRetryMs: RETRY_MS })
      return { supervisor, events }
    }
    const runId = engine.runId
    return { f, engine, runId, open, ids: { project: PROJECT, issueId: f.issue.id, runId } }
  }

  try {
    t.section('1. clean merge: the source changed another line of the patched file')
    {
      // Delivery merges it by itself (source-merge.mjs): nothing is blocked and nothing is left to reconcile.
      const direct = await blockedRun({ worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }) }, source: { 'server.mjs': lines(10, { 1: 'line 1 elsewhere' }) } })
      t.eq('delivery merged it at once', `${direct.engine.run.status} ${direct.engine.run.outcome}`, 'completed resolved', `${direct.engine.run.blockedReason} ${direct.engine.run.delivery?.error}`)
      t.eq('the source holds both changes', await read(direct.f, 'server.mjs'), lines(10, { 1: 'line 1 elsewhere', 9: 'line 9 fixed' }))
      t.eq('no reconcile was needed or is offered', [direct.engine.run.reconciliations ?? null, supportedActions(direct.engine.run)], [null, ['start-new']])
      await releaseOwnership(direct.engine, { reason: 'test' }).catch(() => {})

      // Beside a changelog that conflicts, delivery blocks on the changelog alone and reconcile merges both.
      const { f, engine } = await blockedRun({ worktree: { ...CHANGELOG_ONLY.worktree }, source: { ...CHANGELOG_ONLY.source, 'server.mjs': lines(10, { 1: 'line 1 elsewhere' }) } })
      t.eq('delivery was refused for the conflict on its own path', `${engine.run.blockedReason} ${engine.run.delivery?.application?.state}`, 'source-delivery-blocked source-drift')
      t.eq('only the conflicting path is recorded as drifted', engine.run.delivery.application.drifted, ['changelog.txt'])
      t.eq('reconcile is offered beside finalize', supportedActions(engine.run), ['reconcile-delivery', 'finalize', 'start-new'])
      const approved = engine.run.closure.revision
      await engine.reconcileDelivery({ policy: PREPEND })
      t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${engine.run.delivery?.error} ${JSON.stringify(engine.run.reconciliations?.at(-1))}`)
      t.eq('the source holds both changes', await read(f, 'server.mjs'), lines(10, { 1: 'line 1 elsewhere', 9: 'line 9 fixed' }))
      const revision = engine.run.revisions.at(-1)
      t.eq('the merged candidate is a revision reconciled from the approved one', revision.reconciledFrom, approved)
      t.eq('the delivered revision is the merged one', engine.run.delivery.revision, revision.fingerprint)
      t.ok('every approval carried with reconciledFrom', engine.run.approvals.some((a) => a.revision === revision.fingerprint && a.reconciledFrom === approved) &&
        engine.run.approvals.filter((a) => a.revision === approved).length === engine.run.approvals.filter((a) => a.revision === revision.fingerprint).length)
      const attempt = engine.run.reconciliations.at(-1)
      t.eq('the checks ran on the merged candidate', `${attempt.checks.result} ${engine.run.checkResults.at(-1).revision === revision.fingerprint}`, 'passed true')
      t.eq('the delivery record names the merge', [engine.run.delivery.reconciliation.from, engine.run.delivery.reconciliation.mergeBase, engine.run.delivery.reconciliation.merged, engine.run.delivery.reconciliation.appended],
        [approved, engine.run.workspace.baseCommit, ['server.mjs'], ['changelog.txt']])
      const gitDir = engine.run.workspace.gitDir ? ['--git-dir', engine.run.workspace.gitDir] : ['-C', engine.run.workspace.path]
      t.eq('the source base B′ is a commit over the snapshot', (await exec('git', [...gitDir, 'rev-parse', `${engine.run.delivery.reconciliation.sourceBase}^`])).stdout.trim(), engine.run.workspace.baseCommit)
      t.eq('the source index and HEAD are untouched', (await git(f.projectPath, 'status', '--porcelain')).split('\n').map((l) => l.trim()).filter(Boolean), ['M changelog.txt', 'M server.mjs'])
      const events = (await readEvents(f.issuePath, engine.runId)).events.map((e) => e.type)
      t.ok('journaled', ['reconcile-started', 'reconciled'].every((e) => events.includes(e)) && events.at(-1) === 'finished')
      t.eq('nothing further is offered', supportedActions(engine.run), ['start-new'])
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('2. append-resolved changelog: both sides added an entry at its end')
    {
      const scenario = { worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }), 'changelog.txt': 'v1 released\ncandidate: fixed line 9\n' }, source: { 'changelog.txt': 'v1 released\nother: landed first\n' } }
      const { f, engine } = await blockedRun(scenario)
      t.eq('refused for the changelog', engine.run.delivery.application.drifted, ['changelog.txt'])
      await engine.reconcileDelivery({ policy: {} })
      t.eq('without a policy the conflict refuses', `${engine.run.status} ${engine.run.blockedReason} ${engine.run.reconciliations.at(-1).state}`, 'blocked source-delivery-blocked conflicts')
      t.eq('naming the path', engine.run.reconciliations.at(-1).conflicts, ['changelog.txt'])
      t.eq('the source is untouched', await read(f, 'changelog.txt'), 'v1 released\nother: landed first\n')
      t.ok('reconcile is still offered', supportedActions(engine.run).includes('reconcile-delivery'))
      await engine.reconcileDelivery({ policy: { '**/changelog.txt': 'append' } })
      t.eq('with the path declared append it delivers', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${JSON.stringify(engine.run.reconciliations.at(-1))}`)
      t.eq("the source's entry is kept and the candidate's appended", await read(f, 'changelog.txt'), 'v1 released\nother: landed first\ncandidate: fixed line 9\n')
      t.eq('the rest of the patch landed', await read(f, 'server.mjs'), lines(10, { 9: 'line 9 fixed' }))
      t.eq('the delivery names the appended path', [engine.run.delivery.reconciliation.appended, engine.run.delivery.reconciliation.merged, engine.run.delivery.reconciliation.n], [['changelog.txt'], [], 2])
      t.eq('both attempts are on the run', engine.run.reconciliations.map((r) => r.state), ['conflicts', 'accepted'])
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('2b. a newest-first changelog declared prepend: the candidate\'s entry goes on top')
    {
      const scenario = { worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }), 'changelog.txt': 'candidate: fixed line 9\nv1 released\n' }, source: { 'changelog.txt': 'other: landed first\nv1 released\n' } }
      const { f, engine } = await blockedRun(scenario)
      t.eq('changelog-only drift on a declared path is reconciled without being asked', autoReconcileRefusal(engine.run, { '**/changelog.txt': 'prepend' }), null)
      t.ok('but not when the project declares nothing', /does not declare.*changelog\.txt/.test(autoReconcileRefusal(engine.run, {})))
      await engine.reconcileDelivery({ policy: { '**/changelog.txt': 'prepend' } })
      t.eq('it delivers', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${JSON.stringify(engine.run.reconciliations.at(-1))}`)
      t.eq("the candidate's entry is above the source's", await read(f, 'changelog.txt'), 'candidate: fixed line 9\nother: landed first\nv1 released\n')
      t.eq('the delivery names the path', engine.run.delivery.reconciliation.appended, ['changelog.txt'])
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('2c. the panel reconciles a changelog-only drift by itself when the run ends')
    {
      const scenario = { worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }), 'changelog.txt': 'candidate: fixed line 9\nv1 released\n' }, source: { 'changelog.txt': 'other: landed first\nv1 released\n' } }
      const { f, engine } = await blockedRun(scenario)
      await fs.mkdir(path.join(f.configRoot, 'projects'), { recursive: true })
      await fs.writeFile(path.join(f.configRoot, 'projects', 'devpanel-project.yaml'), "id: devpanel-project\nworkspace:\n  reconcile:\n    '**/changelog.txt': prepend\n")
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
      const projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reconcile-projects-'))
      temps.push(projectsDir)
      await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project'))
      const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
      // Finalize ends like any run (announceEnd): still blocked by the drift, which starts the automatic attempt.
      await supervisor.finalize({ project: 'devpanel-project', issueId: f.issue.id, runId: engine.runId })
      const runFile = path.join(f.issue.path, 'runs', engine.runId, 'run.json')
      const until = Date.now() + 60000
      let run
      do { await new Promise((r) => setTimeout(r, 100)); run = JSON.parse(await fs.readFile(runFile, 'utf8')) } while ((!run.reconciliations?.some((r) => r.endedAt) || run.status === 'running') && Date.now() < until)
      t.eq('it is delivered without anyone pressing Reconcile', `${run.status} ${run.outcome}`, 'completed resolved', JSON.stringify(run.reconciliations?.at(-1) ?? run.blockedReason))
      t.eq('the attempt is the engine\'s', run.reconciliations?.[0]?.by, 'engine')
      t.eq("the candidate's entry is above the source's", await read(f, 'changelog.txt'), 'candidate: fixed line 9\nother: landed first\nv1 released\n')
      await supervisor.shutdown?.()
    }

    t.section('2d. accepted: the end is announced once, after the automatic reconcile is decided')
    {
      let seen = null
      const s = await supervisedRun(CHANGELOG_ONLY, { onEvent: (e) => {
        if (e.type === 'finished' && e.reason === 'finalize') seen ??= JSON.parse(readFileSync(runFile(s.f, s.runId), 'utf8'))
      } })
      const { supervisor, events } = s.open()
      await supervisor.finalize(s.ids)
      t.eq('the block is on the record with its marker before the engine\'s end event', [seen?.status, reconcilePending(seen), seen?.reconciliations?.length ?? 0], ['blocked', true, 0])
      t.ok('and already says so before reconcile-started', shows(seen, DO_NOT_LAND), JSON.stringify(explainRun(seen)))
      await until(() => finishes(events) > 0, 'the end announcement')
      const order = types(events)
      t.ok('run-finished comes after the reconcile is decided', order.indexOf('reconciled') >= 0 && order.indexOf('run-finished') > order.indexOf('reconciled'), order.join(' '))
      await periods()
      t.eq('exactly once', finishes(events), 1)
      const run = await record(s.f, s.runId)
      t.eq('it reports the actual end state, marker gone', [run.status, run.outcome, run.autoReconcile ?? null], ['completed', 'resolved', null])
      await supervisor.shutdown?.()
    }

    t.section('2e. refused: the end is announced once, after the refusal, and the run stays blocked')
    {
      const s = await supervisedRun(CODE_CONFLICT, { policy: "'server.mjs': append" })
      const { supervisor, events } = s.open()
      await supervisor.finalize(s.ids)
      await until(() => finishes(events) > 0, 'the end announcement')
      const order = types(events)
      t.ok('run-finished comes after the refusal', order.indexOf('reconcile-refused') >= 0 && order.indexOf('run-finished') > order.indexOf('reconcile-refused'), order.join(' '))
      await periods()
      t.eq('exactly once', finishes(events), 1)
      const run = await record(s.f, s.runId)
      t.eq('blocked as before, one attempt on the record, marker gone', [run.status, run.blockedReason, run.reconciliations.length, run.autoReconcile ?? null], ['blocked', 'source-delivery-blocked', 1, null])
      t.ok('the attempt ended refused', run.reconciliations[0].state !== 'accepted' && Boolean(run.reconciliations[0].endedAt), run.reconciliations[0].state)
      await supervisor.shutdown?.()
    }

    t.section('2f. never ran, the project busy: recorded, announced once, Reconcile still offered')
    {
      // Another issue's live run, as the admission reads it; only once the operator's own finalize has passed admission.
      let busy = null
      const wrap = (issues) => ({ ...issues, listIssues: async (project, options) => [...await issues.listIssues(project, options), ...(busy ? [busy] : [])] })
      let lock = null
      const s = await supervisedRun(CHANGELOG_ONLY, { wrap, onEvent: (e) => {
        if (e.type === 'finished' && e.reason === 'finalize') busy = { id: 'another-issue', path: other.path, latestRun: { live: true, runId: 'held-run' } }
      } })
      const other = await s.f.issues.getIssue(PROJECT, (await s.f.issues.createIssue(PROJECT, { name: 'Holds the project' })).id)
      lock = await acquire(path.join(other.path, '.run.lock'), { purpose: 'test', runId: 'held-run' })
      const { supervisor, events } = s.open()
      await supervisor.finalize(s.ids)
      await until(() => finishes(events) > 0, 'the end announcement')
      await lock.release()
      await periods()
      t.eq('exactly once', finishes(events), 1)
      const run = await record(s.f, s.runId)
      t.eq('no attempt, marker recorded as not run', [run.reconciliations?.length ?? 0, run.autoReconcile?.state, reconcilePending(run)], [0, 'not-run', false])
      t.ok('the reason names the run it cannot share the project with', /cannot share the project/.test(run.autoReconcile.reason), run.autoReconcile.reason)
      t.ok('the journal comes first', types(events).indexOf('reconcile-not-run') >= 0 && types(events).indexOf('reconcile-not-run') < types(events).indexOf('run-finished'), types(events).join(' '))
      t.ok('the explanation says it did not run and offers Reconcile', shows(run, 'The automatic reconcile did not run') && shows(run, 'Reconcile delivery'), JSON.stringify(explainRun(run)))
      t.ok('and Reconcile is still an action', supportedActions(run).includes('reconcile-delivery'))
      await supervisor.shutdown?.()
    }

    t.section('2g. an automatic reconcile does not apply: announced at once, as before')
    {
      const s = await supervisedRun(CODE_CONFLICT)
      const { supervisor, events } = s.open()
      await supervisor.finalize(s.ids)
      t.eq('announced by the time finalize returns', finishes(events), 1)
      const run = await record(s.f, s.runId)
      t.eq('no marker and no attempt', [run.autoReconcile ?? null, run.reconciliations?.length ?? 0, reconcilePending(run)], [null, 0, false])
      t.ok('the explanation does not say it is running', !shows(run, DO_NOT_LAND), JSON.stringify(explainRun(run)))
      await periods()
      t.eq('still once', finishes(events), 1)
      await supervisor.shutdown?.()
    }

    t.section('2h. the lock is held when the attempt starts: it never ran, and the release waits for the lock')
    {
      let grab = false
      let lock = null
      const wrap = (issues) => ({ ...issues, getIssue: async (...args) => {
        if (grab) { grab = false; lock = await acquire(path.join(s.f.issuePath, '.run.lock'), { purpose: 'test', runId: s.runId }) }
        return issues.getIssue(...args)
      } })
      const s = await supervisedRun(CHANGELOG_ONLY, { wrap, onEvent: (e) => { if (e.type === 'finished' && e.reason === 'finalize') grab = true } })
      const { supervisor, events } = s.open()
      // The attempt reads the project's configuration first: the lock is held until the attempt has really met it.
      const warned = []
      const warn = console.warn
      console.warn = (...args) => { warned.push(args.join(' ')); warn(...args) }
      try {
        await supervisor.finalize(s.ids)
        await until(() => warned.some((w) => /did not run: another run already holds this issue/.test(w)), 'the attempt to meet the held lock')
        await periods()
        t.eq('nothing is announced while it is held', finishes(events), 0)
        t.ok('and the marker stands', reconcilePending(await record(s.f, s.runId)))
        await lock.release()
        await until(() => finishes(events) > 0, 'the end announcement')
      } finally {
        console.warn = warn
      }
      await periods()
      t.eq('once released, exactly one announcement', finishes(events), 1)
      const run = await record(s.f, s.runId)
      t.eq('and no attempt, recorded as not run', [run.reconciliations?.length ?? 0, run.autoReconcile?.state], [0, 'not-run'])
      await supervisor.shutdown?.()
    }

    t.section('2k. a marker this server wrote is its own end path\'s: a sweep leaves it alone')
    {
      // The run has ended and its marker is on the record; its announcement is held at the gate.
      let closed = false
      let open = null
      let reached = false
      const gate = new Promise((resolve) => { open = resolve })
      const wrap = (issues) => ({ ...issues, getIssue: async (...args) => {
        if (closed) { reached = true; await gate }
        return issues.getIssue(...args)
      } })
      const s = await supervisedRun(CHANGELOG_ONLY, { wrap, onEvent: (e) => { if (e.type === 'finished' && e.reason === 'finalize') closed = true } })
      const { supervisor, events } = s.open()
      const finalized = supervisor.finalize(s.ids)
      await until(() => reached, 'the end path to reach the gate')
      const held = await record(s.f, s.runId)
      t.ok('the marker names this server', reconcilePending(held) && typeof held.autoReconcile.owner === 'string', JSON.stringify(held.autoReconcile))
      await supervisor.reconcile()
      await periods()
      const after = await record(s.f, s.runId)
      t.eq('the sweep leaves it as it was', after.autoReconcile, held.autoReconcile)
      t.eq('and announces nothing', [finishes(events), types(events).includes('reconcile-not-run')], [0, false])
      closed = false
      open()
      await finalized
      await until(() => finishes(events) > 0, 'the end announcement')
      await periods()
      const run = await record(s.f, s.runId)
      t.eq('its own end path decides it, announced once', [run.status, run.autoReconcile ?? null, finishes(events), types(events).includes('reconcile-not-run')], ['completed', null, 1, false])
      await supervisor.shutdown?.()
    }

    t.section('2i. a read fails when the run ends: nothing is announced until the record reads')
    {
      for (const [label, scenario, failFor, expected] of [
        ['transient, reconcile applies', CHANGELOG_ONLY, 1, 'completed'],
        ['many periods, reconcile applies', CHANGELOG_ONLY, 10, 'completed'],
        ['many periods, reconcile does not apply', CODE_CONFLICT, 10, 'blocked']
      ]) {
        let failing = false
        const wrap = (issues) => ({ ...issues, getIssue: async (...args) => {
          if (failing) throw new Error('disk fault')
          return issues.getIssue(...args)
        } })
        const s = await supervisedRun(scenario, { wrap, onEvent: (e) => { if (e.type === 'finished' && e.reason === 'finalize') failing = true } })
        const { supervisor, events } = s.open()
        await supervisor.finalize(s.ids)
        await sleep(RETRY_MS * failFor)
        t.eq(`${label}: nothing announced while it fails`, finishes(events), 0)
        const applies = scenario === CHANGELOG_ONLY
        t.eq(`${label}: the marker as it should be`, reconcilePending(await record(s.f, s.runId)), applies)
        failing = false
        await until(() => finishes(events) > 0, 'the end announcement')
        await periods()
        t.eq(`${label}: once healed, exactly one announcement`, finishes(events), 1)
        const run = await record(s.f, s.runId)
        t.eq(`${label}: the end state, marker gone`, [run.status, run.autoReconcile ?? null], [expected, null])
        if (applies) t.ok(`${label}: after the decision`, types(events).indexOf('run-finished') > types(events).indexOf('reconciled'), types(events).join(' '))
        await supervisor.shutdown?.()
      }
      // A record that is gone cannot hold anything: it is announced and not retried.
      let gone = false
      const wrap = (issues) => ({ ...issues, getIssue: async (...args) => {
        if (gone) throw Object.assign(new Error('no such issue'), { status: 404 })
        return issues.getIssue(...args)
      } })
      const s = await supervisedRun(CHANGELOG_ONLY, { wrap, onEvent: (e) => { if (e.type === 'finished' && e.reason === 'finalize') gone = true } })
      const { supervisor, events } = s.open()
      await supervisor.finalize(s.ids)
      t.eq('gone: announced', finishes(events), 1)
      await periods()
      t.eq('gone: and not again', finishes(events), 1)
      await supervisor.shutdown?.()
    }

    t.section('2j. a marker left by an earlier server: released at startup, whatever stood in the way')
    {
      const s = await supervisedRun(CHANGELOG_ONLY)
      const base = await record(s.f, s.runId)
      const write = (run) => fs.writeFile(runFile(s.f, s.runId), JSON.stringify(run))
      const marker = { state: 'pending', at: '2026-11-02T10:00:00.000Z', owner: 'an earlier server' }
      const pending = { ...base, autoReconcile: marker }
      const lockFile = path.join(s.f.issuePath, '.run.lock')

      // The explanation, on a real record.
      t.eq('the fixture is the blocked record', [base.blockedReason, base.delivery.application.drifted], ['source-delivery-blocked', ['changelog.txt']])
      t.ok('pending, before reconcile-started', shows(pending, DO_NOT_LAND))
      t.ok('pending, during the attempt', shows({ ...pending, reconciliations: [{ n: 1, state: 'merging' }] }, DO_NOT_LAND))
      t.ok('decided: it no longer says so', !shows(base, DO_NOT_LAND))
      const next = (run) => explainRun(run).next
      t.ok('recorded drift: Reconcile delivery before landing by hand', next(base).indexOf('Reconcile delivery') === 0 && next(base).indexOf('by hand') > 0, next(base))
      const olderRecord = { ...base, delivery: { ...base.delivery, application: { state: 'source-drift', error: "The approved patch's own paths changed: changelog.txt. Merge them." } } }
      t.ok('drift only in an older record\'s message: the same', next(olderRecord).indexOf('Reconcile delivery') === 0 && next(olderRecord).indexOf('by hand') > 0, next(olderRecord))
      t.ok('with the worktree gone it is not offered', !next({ ...base, workspace: { ...base.workspace, state: 'removed' } }).includes('Reconcile delivery'))

      // Refused like a live run while it holds.
      await write(pending)
      {
        const { supervisor } = s.open()
        const removed = await supervisor.deleteRun(s.ids).then(() => null, (e) => e)
        t.eq('deleting the run is refused', removed?.status, 409)
        const archived = await s.f.issues.setIssueArchived(PROJECT, s.f.issue.id, true).then(() => null, (e) => e)
        t.ok('archiving the issue is refused', /Stop the active run/.test(archived?.message ?? ''), archived?.message)
        await supervisor.shutdown?.()
      }

      // Restart: the record reads.
      await write(pending)
      {
        const { supervisor, events } = s.open()
        await supervisor.reconcile()
        t.eq('restart: announced once', finishes(events), 1)
        t.ok('restart: journaled first', types(events).indexOf('reconcile-not-run') >= 0 && types(events).indexOf('reconcile-not-run') < types(events).indexOf('run-finished'), types(events).join(' '))
        const run = await record(s.f, s.runId)
        t.eq('restart: recorded as not run', [run.autoReconcile.state, reconcilePending(run)], ['not-run', false])
        t.ok('restart: naming the restart', /restarted/.test(run.autoReconcile.reason), run.autoReconcile.reason)
        await supervisor.shutdown?.()
      }

      // The lock is held at startup: the release keeps trying, and depends only on what the holder left.
      await write(pending)
      {
        const lock = await acquire(lockFile, { purpose: 'test', runId: s.runId })
        const { supervisor, events } = s.open()
        await supervisor.reconcile()
        await periods()
        t.eq('held lock: nothing announced', finishes(events), 0)
        t.ok('held lock: the marker stands', reconcilePending(await record(s.f, s.runId)))
        await lock.release()
        await until(() => finishes(events) > 0, 'the end announcement')
        await periods()
        t.eq('released: exactly one announcement', finishes(events), 1)
        t.eq('released: recorded as not run', (await record(s.f, s.runId)).autoReconcile.state, 'not-run')
        await supervisor.shutdown?.()
      }
      // A real landing holds the lock, leaves the marker and announces only itself.
      await write(pending)
      {
        const { supervisor, events } = s.open()
        await supervisor.markLanded({ ...s.ids, by: 'a person', applied: 'the patch', handChanges: 'none', checkout: '/somewhere' })
        t.eq('a landing announces itself, not the end', [types(events).includes('run-landed'), finishes(events)], [true, 0])
        const landed = await record(s.f, s.runId)
        t.ok('a landing leaves the marker', Boolean(landed.landed) && reconcilePending(landed))
        await supervisor.reconcile()
        t.eq('the release after it announces once', finishes(events), 1)
        t.eq('and records it as not run', (await record(s.f, s.runId)).autoReconcile.state, 'not-run')
        await supervisor.shutdown?.()
      }
      {
        await write(pending)
        const lock = await acquire(lockFile, { purpose: 'test', runId: s.runId })
        const { supervisor, events } = s.open()
        await supervisor.reconcile()
        const { autoReconcile: _gone, ...decided } = pending
        await write({ ...decided, status: 'completed', outcome: 'resolved', blockedReason: null })
        await lock.release()
        await periods()
        t.eq('the holder decided it: the release announces nothing', finishes(events), 0)
        t.eq('and writes nothing', (await record(s.f, s.runId)).autoReconcile ?? null, null)
        await supervisor.shutdown?.()
      }
      {
        await write(pending)
        const lock = await acquire(lockFile, { purpose: 'test', runId: s.runId })
        const { supervisor, events } = s.open()
        await supervisor.reconcile()
        const remarked = { ...marker, at: '2026-11-02T11:00:00.000Z' }
        await write({ ...pending, autoReconcile: remarked })
        await lock.release()
        await periods()
        t.eq('the holder re-marked it: the release announces nothing', finishes(events), 0)
        t.eq('and leaves the new marker', (await record(s.f, s.runId)).autoReconcile, remarked)
        await supervisor.shutdown?.()
      }

      // The record cannot be read at startup; one server start, no operator.
      await fs.writeFile(runFile(s.f, s.runId), '{ not json')
      {
        const { supervisor, events } = s.open()
        await supervisor.reconcile()
        await periods()
        t.eq('unreadable at startup: nothing announced', finishes(events), 0)
        t.eq('unreadable at startup: nothing written', await fs.readFile(runFile(s.f, s.runId), 'utf8'), '{ not json')
        await write(pending)
        await until(() => finishes(events) > 0, 'the end announcement')
        await periods()
        t.eq('healed: exactly one announcement', finishes(events), 1)
        t.ok('healed: journaled first', types(events).indexOf('reconcile-not-run') >= 0 && types(events).indexOf('reconcile-not-run') < types(events).indexOf('run-finished'), types(events).join(' '))
        const run = await record(s.f, s.runId)
        t.eq('healed: recorded as not run', [run.autoReconcile.state, reconcilePending(run)], ['not-run', false])
        t.ok('healed: naming the restart', /restarted/.test(run.autoReconcile.reason), run.autoReconcile.reason)
        await supervisor.shutdown?.()
      }
      for (const [label, healedTo] of [['a settled run', { ...base, status: 'completed', outcome: 'resolved', blockedReason: null }], ['a blocked run with no marker', base]]) {
        await fs.writeFile(runFile(s.f, s.runId), '{ not json')
        const { supervisor, events } = s.open()
        await supervisor.reconcile()
        const bytes = JSON.stringify(healedTo)
        await fs.writeFile(runFile(s.f, s.runId), bytes)
        await periods()
        t.eq(`unreadable at startup, healed as ${label}: nothing announced`, finishes(events), 0)
        t.eq(`unreadable at startup, healed as ${label}: not written`, await fs.readFile(runFile(s.f, s.runId), 'utf8'), bytes)
        await supervisor.shutdown?.()
      }

      // Something above the record cannot be read; the retry stops once it can.
      for (const method of ['listIssues', 'listProjects']) {
        await write(pending)
        let failing = true
        let calls = 0
        const wrap = (issues) => ({ ...issues, [method]: async (...args) => {
          calls++
          if (failing) throw new Error('disk fault')
          return issues[method](...args)
        } })
        const { supervisor, events } = s.open({ wrap })
        await supervisor.reconcile()
        await periods()
        t.eq(`${method} fails at startup: nothing announced`, finishes(events), 0)
        failing = false
        await until(() => finishes(events) > 0, 'the end announcement')
        await periods()
        const seen = calls
        await periods()
        t.eq(`${method} heals: exactly one announcement`, finishes(events), 1)
        t.eq(`${method} heals: the retry has stopped`, calls, seen)
        await supervisor.shutdown?.()
      }

      // Other records of the same sweep are handled as usual, before it returns.
      await write(pending)
      {
        const copyRun = async (name, run) => {
          const issue = await s.f.issues.getIssue(PROJECT, (await s.f.issues.createIssue(PROJECT, { name })).id)
          await fs.cp(path.dirname(runFile(s.f, s.runId)), path.join(issue.path, 'runs', s.runId), { recursive: true })
          await fs.writeFile(path.join(issue.path, 'runs', s.runId, 'run.json'), JSON.stringify(run))
          return issue
        }
        const readable = await copyRun('A readable pending run', pending)
        const live = await copyRun('A live run nobody owns', { ...base, status: 'running', outcome: null, blockedReason: null })
        await fs.writeFile(runFile(s.f, s.runId), '{ not json')
        const { supervisor, events } = s.open()
        const recovered = await supervisor.reconcile()
        const ofIssue = (issue) => events.filter((e) => e.type === 'run-finished' && e.issueId === issue.id).length
        t.eq('another pending record is released before the sweep returns', ofIssue(readable), 1)
        t.ok('a live record nobody owns is recovered as usual', recovered.some((r) => r.issueId === live.id), JSON.stringify(recovered))
        t.eq('the unreadable one announces nothing yet', ofIssue(s.f.issue), 0)
        await write(pending)
        await until(() => ofIssue(s.f.issue) > 0, 'the end announcement')
        await periods()
        t.eq('healed: one more announcement, for that record only', [ofIssue(s.f.issue), ofIssue(readable), finishes(events)], [1, 1, 2])
        await supervisor.shutdown?.()
      }

      // A read fault is not a missing run: monitoring keeps following it (runs-api.mjs).
      const read = (runId) => getRun(s.f.issuePath, runId, { issues: s.f.issues, project: PROJECT, issueId: s.f.issue.id }).then(() => null, (e) => e)
      await fs.writeFile(runFile(s.f, s.runId), '{ not json')
      t.eq('an unreadable record answers 503', (await read(s.runId))?.status, 503)
      await write(base)
      t.eq('a missing record answers 404', (await read('2026-01-01T00-00-00-000Z-00000000'))?.status, 404)
    }

    t.section('3. conflicting code path: nothing is delivered, the carry-forward stays')
    {
      const { f, engine } = await blockedRun({ worktree: { 'server.mjs': lines(10, { 5: 'line 5 by the candidate' }) }, source: { 'server.mjs': lines(10, { 5: 'line 5 by someone else' }) } })
      t.ok('drift on a code path is never reconciled automatically', /does not declare.*server\.mjs/.test(autoReconcileRefusal(engine.run, { '**/changelog.txt': 'append' })))
      await engine.reconcileDelivery({ policy: { '**/changelog.txt': 'append' } })
      t.eq('still blocked as before', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked source-delivery-blocked')
      t.ok('and one attempt is the only automatic one', /already attempted/.test(autoReconcileRefusal(engine.run, { '**': 'append' })))
      t.eq('the conflicting path is listed', [engine.run.reconciliations.at(-1).state, engine.run.reconciliations.at(-1).conflicts], ['conflicts', ['server.mjs']])
      t.eq('the source is untouched', await read(f, 'server.mjs'), lines(10, { 5: 'line 5 by someone else' }))
      t.ok('no revision or approval was added', !engine.run.revisions.some((r) => r.reconciledFrom) && !engine.run.approvals.some((a) => a.reconciledFrom))
      t.eq('the next run still starts from the approved patch', (await undeliveredApproval(f.issuePath, 'next'))?.runId, engine.runId)
      t.ok('journaled', (await readEvents(f.issuePath, engine.runId)).events.some((e) => e.type === 'reconcile-refused' && e.state === 'conflicts'))
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('4. a merged candidate that fails revalidation is not delivered')
    {
      const { f, engine } = await blockedRun(WITH_CHANGELOG({ worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }) }, source: { 'server.mjs': lines(10, { 1: 'line 1 INCOMPATIBLE' }) } }))
      t.eq('the approved candidate passed its check', engine.run.checkResults.at(-1)?.result, 'passed')
      await engine.reconcileDelivery({ policy: PREPEND })
      const attempt = engine.run.reconciliations.at(-1)
      t.eq('the merge was clean but the check failed, as a new failure', `${attempt.state} ${attempt.checks.result} ${attempt.checks.gating}`, 'revalidation-failed failed failed', JSON.stringify(attempt))
      t.eq('still blocked as before', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked source-delivery-blocked')
      t.eq('the source is untouched', await read(f, 'server.mjs'), lines(10, { 1: 'line 1 INCOMPATIBLE' }))
      t.ok('no approval was carried', !engine.run.approvals.some((a) => a.reconciledFrom))
      const reason = 'required command compatible failed; not on the base: compatible: (command) (passes on the base)'
      t.eq('the entry names the condition that failed', attempt.checks.reason, reason)
      t.eq('and so does the refusal', attempt.error, `the checks on the merged candidate did not pass the gate (gating failed; drive result failed): ${reason}`)
      t.ok('the refused check is no check of the approved revision', engine.run.checkResults.every((c) => c.revision === attempt.from && c.dir !== attempt.checks.dir))
      t.eq('closure still reads the approved revision', engine.run.closure.revision, attempt.from)
      const view = await getRunView(f, engine)
      t.eq('get_run shows the check and its reason', [view.reconciliation.checks.dir, view.reconciliation.checks.gating, view.reconciliation.checks.reason, view.reconciliation.checks.commands.map((c) => c.id)], [attempt.checks.dir, 'failed', reason, ['compatible']])
      const log = await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: checkNumber(attempt.checks.dir), command: 'compatible' })
      t.eq('get_check_log reads its log, bound to the merged candidate', [log.result, log.exitCode, log.revision], ['failed', attempt.checks.commands[0].exitCode, attempt.revision])
      t.ok('a command it did not record is still refused', await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: checkNumber(attempt.checks.dir), command: 'other' }).then(() => false, (e) => /No recorded command log/.test(e.message)))

      await engine.reconcileDelivery({ policy: PREPEND })
      const second = engine.run.reconciliations.at(-1)
      const again = await getRunView(f, engine)
      t.eq('a second attempt keeps its own check', [second.n, second.state, second.checks.dir !== attempt.checks.dir], [2, 'revalidation-failed', true])
      t.eq('get_run still shows the earlier attempt\'s check', [again.reconciliation.n, again.reconciliation.earlier.map((e) => [e.n, e.checks.dir, e.checks.reason])], [2, [[1, attempt.checks.dir, reason]]])
      t.eq('and its log is still readable', (await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: checkNumber(attempt.checks.dir), command: 'compatible' })).result, 'failed')
      t.eq('closure and approvals as before', [engine.run.closure.revision, engine.run.approvals.some((a) => a.reconciledFrom)], [attempt.from, false])
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('4a. a merged candidate whose drive passes and whose selftest is new is refused, and says so')
    {
      // The failed test appears only on the merge: the approved candidate and the source alone report none.
      const collect = '      - id: collect\n        report: selftest\n        run: |\n          if grep -q fixed server.mjs && grep -q INCOMPATIBLE server.mjs; then t=\',{"test":"core/new","error":"regression"}\'; fi\n          echo "== runtime/selftest.report"\n          printf \'{\\n  "total": 1,\\n  "tests": [{"test":"core/a"}%s]\\n}\\n\' "$t"\n'
      const { f, engine } = await blockedRun({ ...WITH_CHANGELOG({ worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }) }, source: { 'server.mjs': lines(10, { 1: 'line 1 INCOMPATIBLE' }) } }), commands: collect })
      t.eq('the approved candidate passed its gate', engine.run.blockedReason, 'source-delivery-blocked', JSON.stringify(engine.run.checkResults.at(-1)?.baselineComparison))
      await engine.reconcileDelivery({ policy: PREPEND })
      const attempt = engine.run.reconciliations.at(-1)
      const reason = 'selftest verdict new-failures: collect: core/new'
      t.eq('the drive passed and the gate failed', [attempt.state, attempt.checks.result, attempt.checks.gating], ['revalidation-failed', 'passed', 'failed'], JSON.stringify(attempt))
      t.eq('the entry names the selftest', attempt.checks.reason, reason)
      t.ok('the refusal does too', attempt.error.endsWith(reason), attempt.error)
      t.eq('the record behind it is kept', attempt.checks.baselineComparison.selftest.newFailures, [{ command: 'collect', test: 'core/new' }])
      t.eq('get_run shows it', (await getRunView(f, engine)).reconciliation.checks.reason, reason)
      t.eq('its log is readable', (await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: checkNumber(attempt.checks.dir), command: 'collect' })).result, 'passed')
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    // A check that also counts every drive, candidate or base, outside anything a run owns.
    const counted = async (more = '') => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reconcile-drives-'))
      temps.push(dir)
      const file = path.join(dir, 'drives')
      return { commands: `      - id: count\n        run: "echo drive >> ${file}"\n${more}`, target: '    compareBaseline: true\n',
        drives: async () => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length }
    }
    const INERT = { '**/changelog.txt': { rule: 'prepend', inert: true } }
    const INERT_YAML = "'**/changelog.txt': { rule: prepend, inert: true }"
    const FOREIGN = { worktree: CHANGELOG_ONLY.worktree, source: { ...CHANGELOG_ONLY.source, 'source.txt': 'changed by someone else\n' } }
    const OWN_CODE = { worktree: CHANGELOG_ONLY.worktree, source: { ...CHANGELOG_ONLY.source, 'server.mjs': lines(10, { 1: 'line 1 elsewhere' }) } }
    const checkDirs = (f, engine) => fs.readdir(path.join(f.issuePath, 'runs', engine.runId, 'checks')).then((d) => d.sort())

    t.section('8. inert: the policy loads, opt-in per path')
    {
      const f = await engineFixture({ playbook: 'implementation' })
      const file = path.join(f.configRoot, 'projects', `${PROJECT}.yaml`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      const load = async (value) => {
        await fs.writeFile(file, `id: ${PROJECT}\nworkspace:\n  reconcile:\n    'changelog.txt': ${value}\n`)
        const cfg = await loadConfig({ root: f.configRoot })
        return { errors: cfg.errors.filter((e) => e.file?.endsWith(`projects/${PROJECT}.yaml`)).length, policy: cfg.projects.get(PROJECT)?.workspace?.reconcile }
      }
      for (const value of ['append', 'prepend', '{ rule: prepend }', '{ rule: append, inert: true }', '{ rule: prepend, inert: false }']) t.eq(`${value} loads`, (await load(value)).errors, 0)
      for (const value of ['{ inert: true }', "{ rule: prepend, inert: 'yes' }", '{ rule: prepend, inert: true, other: 1 }', '{ rule: rewrite, inert: true }', 'inert']) t.ok(`${value} is refused`, (await load(value)).errors > 0)
      t.ok('declared inert', isInert({ 'a.txt': { rule: 'append', inert: true } }, 'a.txt'))
      for (const policy of [{}, { 'a.txt': 'append' }, { 'a.txt': { rule: 'append' } }, { 'a.txt': { rule: 'append', inert: false } }, { 'b.txt': { rule: 'append', inert: true } }]) t.ok(`not inert under ${JSON.stringify(policy)}`, !isInert(policy, 'a.txt'))
      t.ok('the first entry naming a path decides: a later glob adds no inertness', !isInert({ 'a.txt': 'append', '*.txt': { rule: 'append', inert: true } }, 'a.txt'))
    }

    t.section('8a. the proof: all of the drift inert, and nothing else differs')
    {
      const fp = (entries) => ({ entries: entries.map(([p, contentHash, mode = '000644', status = 'unchanged']) => ({ path: p, contentHash, mode, status })) })
      t.eq('same content and mode: nothing differs', differingPaths(fp([['a', 'x']]), fp([['a', 'x', '000644', 'modified']])), [])
      t.eq('content', differingPaths(fp([['a', 'x']]), fp([['a', 'y']])), ['a'])
      t.eq('a mode-only change', differingPaths(fp([['a', 'x']]), fp([['a', 'x', '000755']])), ['a'])
      t.eq('a deletion', differingPaths(fp([['a', 'x']]), fp([['a', null, undefined, 'deleted']])), ['a'])
      t.eq('an added path', differingPaths(fp([]), fp([['a', 'x']])), ['a'])
      const approved = fp([['changelog.txt', 'mine'], ['server.mjs', 'code']])
      const composed = fp([['changelog.txt', 'both'], ['server.mjs', 'code']])
      const drift = (...paths) => paths.map((p) => ({ path: p }))
      t.eq('inert drift, the rest identical: proved', inertProof(INERT, drift('changelog.txt'), approved, composed), { proved: true, paths: ['changelog.txt'], nonInertDrift: [], nonInertDriftCount: 0, differing: [], compared: 1 })
      t.eq('a non-inert path drifted to the approved bytes: not proved, though nothing differs', [inertProof(INERT, drift('changelog.txt', 'server.mjs'), approved, composed).proved, inertProof(INERT, drift('changelog.txt', 'server.mjs'), approved, composed).nonInertDrift], [false, ['server.mjs']])
      const moved = inertProof(INERT, drift('changelog.txt'), approved, fp([['changelog.txt', 'both'], ['server.mjs', 'other']]))
      t.eq('a non-inert path differs: not proved, though all the drift is inert', [moved.proved, moved.differing], [false, ['server.mjs']])
      t.eq('no drifted path is inert: the policy did not come into it', inertProof(INERT, drift('server.mjs'), approved, composed), null)
    }

    t.section('8b. inert-only drift: composed, proved, carried and delivered with no drive')
    {
      const c = await counted()
      const { f, engine } = await blockedRun({ ...CHANGELOG_ONLY, ...c })
      const approved = engine.run.closure.revision
      const before = { drives: await c.drives(), dirs: await checkDirs(f, engine), baselines: engine.run.baselineChecks.length }
      t.ok('the approved revision and its base were driven', before.drives >= 2 && before.baselines >= 1, JSON.stringify(before))
      const driven = engine.run.checkResults.at(-1)
      let calls = 0
      const real = engine.checkCandidate
      engine.checkCandidate = (...args) => { calls++; return real.apply(engine, args) }
      await engine.reconcileDelivery({ policy: INERT })
      const attempt = engine.run.reconciliations.at(-1)
      t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${JSON.stringify(attempt)}`)
      t.eq('no check command ran, on the candidate or a base', await c.drives(), before.drives)
      t.eq('the check runner was never asked', calls, 0)
      t.eq('no check directory appeared', await checkDirs(f, engine), before.dirs)
      t.eq('no baseline was added', engine.run.baselineChecks.length, before.baselines)
      t.eq("the source holds the composition: the source's entry kept, the candidate's added", await read(f, 'changelog.txt'), 'candidate: fixed line 9\nother: landed first\nv1 released\n')
      t.eq('and the reviewed code', await read(f, 'server.mjs'), lines(10, { 9: 'line 9 fixed' }))
      const revision = engine.run.revisions.at(-1).fingerprint
      t.ok('the delivered revision is the composed one', revision !== approved && engine.run.delivery.revision === revision)
      t.eq('the proof is recorded', [attempt.inert.proved, attempt.inert.paths, attempt.inert.differing, attempt.inert.compared > 0], [true, ['changelog.txt'], [], true])
      t.ok('every approval carried', engine.run.approvals.filter((a) => a.revision === approved).length > 0 && engine.run.approvals.filter((a) => a.revision === approved).length === engine.run.approvals.filter((a) => a.revision === revision && a.reconciledFrom === approved).length)
      const carried = engine.run.checkResults.at(-1)
      t.eq("the approved revision's result is carried, its drive named", [carried.revision, carried.result, carried.dir, carried.at, carried.carriedFrom, carried.carriedBecause], [revision, 'passed', driven.dir, driven.at, approved, 'inert-drift-only'])
      t.eq('the attempt says why no drive ran', [attempt.noDrive.reason, attempt.noDrive.paths, attempt.noDrive.check.revision, attempt.noDrive.check.dir], ['inert-drift-only', ['changelog.txt'], approved, driven.dir])
      t.ok('in words', /declared inert/.test(attempt.noDrive.detail) && /no check ran/.test(attempt.noDrive.detail), attempt.noDrive.detail)
      t.eq('the attempt has no check of its own', [attempt.checks.result, attempt.checks.dir ?? null, attempt.checks.carriedFrom], ['not-run', null, approved])
      t.eq('closure counted it, and says it was carried', [engine.run.closure.checks.gating, engine.run.closure.checks.carriedFrom, engine.run.closure.verificationLevel], ['passed', approved, 'verified'])
      t.eq('the delivery names it', engine.run.delivery.reconciliation.noDrive.reason, 'inert-drift-only')
      const view = await getRunView(f, engine)
      t.eq('get_run shows it', [view.reconciliation.noDrive.reason, view.reconciliation.checks.reason, view.checkResults.at(-1).carriedFrom, view.checkResults.at(-1).carriedBecause], ['inert-drift-only', attempt.noDrive.detail, approved, 'inert-drift-only'])
      const log = await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: checkNumber(driven.dir), command: 'count' })
      t.eq('its log still reads as the revision that was driven', log.revision, approved)
      t.ok('journaled as no drive', (await readEvents(f.issuePath, engine.runId)).events.some((e) => e.type === 'reconciled' && e.noDrive === true))
      t.ok('no drive, so no auditor is asked to read one', !engine.run.steps.some((s) => s.reconcileNotice))
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('8c. mixed drift, or a path not declared inert: the drive runs, and a reader can tell')
    {
      for (const [label, scenario, nonInert] of [['drift on another own path', OWN_CODE, ['server.mjs']], ['drift outside the approved patch', FOREIGN, ['source.txt']]]) {
        const c = await counted()
        const { f, engine } = await blockedRun({ ...scenario, ...c })
        const before = await c.drives()
        const undeclared = autoReconcileRefusal(engine.run, INERT)
        // The clean own-path edit merged at delivery, so only the declared changelog conflicted: the automatic attempt applies to both.
        t.eq(`${label}: the automatic attempt applies`, undeclared, null)
        await engine.reconcileDelivery({ policy: INERT })
        const attempt = engine.run.reconciliations.at(-1)
        t.eq(`${label}: delivered`, `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${JSON.stringify(attempt)}`)
        t.ok(`${label}: the configured checks ran, on the candidate and its base`, (await c.drives()) >= before + 2, `${before} -> ${await c.drives()}`)
        t.eq(`${label}: the attempt says why`, [attempt.inert.proved, attempt.inert.paths, attempt.inert.nonInertDrift], [false, ['changelog.txt'], nonInert])
        t.ok(`${label}: and holds the drive's own record, not a carried one`, Boolean(attempt.checks.dir) && attempt.checks.result === 'passed' && !attempt.noDrive && !attempt.checks.carriedFrom)
        const check = engine.run.checkResults.at(-1)
        t.eq(`${label}: the result is the drive's`, [check.revision, check.dir, check.carriedFrom ?? null], [engine.run.revisions.at(-1).fingerprint, attempt.checks.dir, null])
        t.eq(`${label}: closure and the delivery say no carry`, [engine.run.closure.checks.carriedFrom ?? null, engine.run.delivery.reconciliation.noDrive ?? null], [null, null])
        await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
      }
      for (const policy of [{ '**/changelog.txt': 'prepend' }, { '**/changelog.txt': { rule: 'prepend' } }, { '**/changelog.txt': { rule: 'prepend', inert: false } }]) {
        const c = await counted()
        const { engine } = await blockedRun({ ...CHANGELOG_ONLY, ...c })
        const before = await c.drives()
        await engine.reconcileDelivery({ policy })
        const attempt = engine.run.reconciliations.at(-1)
        t.ok(`${JSON.stringify(policy)}: the drive runs and nothing about inertness is recorded`, (await c.drives()) > before && attempt.state === 'accepted' && Boolean(attempt.checks.dir) && !attempt.inert && !attempt.noDrive, JSON.stringify(attempt))
        await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
      }
    }

    t.section('8d. mixed drift keeps the refusals')
    {
      const failing = await blockedRun({ worktree: CHANGELOG_ONLY.worktree, source: { ...CHANGELOG_ONLY.source, 'server.mjs': lines(10, { 1: 'line 1 INCOMPATIBLE' }) } })
      await failing.engine.reconcileDelivery({ policy: INERT })
      t.eq('a failing drive refuses, nothing delivered', [failing.engine.run.reconciliations.at(-1).state, failing.engine.run.status, failing.engine.run.approvals.some((a) => a.reconciledFrom)], ['revalidation-failed', 'blocked', false])
      await releaseOwnership(failing.engine, { reason: 'test' }).catch(() => {})
      const c = await counted()
      const rewritten = await blockedRun({ worktree: { 'server.mjs': lines(10, { 9: 'line 9 fixed' }), 'changelog.txt': 'rewritten by the candidate\n' }, source: CHANGELOG_ONLY.source, ...c })
      const before = await c.drives()
      await rewritten.engine.reconcileDelivery({ policy: INERT })
      const attempt = rewritten.engine.run.reconciliations.at(-1)
      t.eq('inert does not widen the merge: a rewrite of the inert path still conflicts', [attempt.state, attempt.conflicts, await c.drives()], ['conflicts', ['changelog.txt'], before])
      await releaseOwnership(rewritten.engine, { reason: 'test' }).catch(() => {})
    }

    t.section('8e. a selftest reads the inert file: declared inert, it is not re-run; that is the project\'s responsibility')
    {
      // Fails only on the composition: the approved candidate has no entry of the source's, the source alone none of the candidate's.
      const collect = '      - id: collect\n        report: selftest\n        run: |\n          if grep -q other changelog.txt && grep -q candidate changelog.txt; then t=\',{"test":"core/changelog","error":"two entries"}\'; fi\n          echo "== runtime/selftest.report"\n          printf \'{\\n  "total": 1,\\n  "tests": [{"test":"core/a"}%s]\\n}\\n\' "$t"\n'
      const c = await counted(collect)
      const inert = await blockedRun({ ...CHANGELOG_ONLY, ...c })
      t.eq('the approved candidate passed it', inert.engine.run.blockedReason, 'source-delivery-blocked', JSON.stringify(inert.engine.run.checkResults.at(-1)?.baselineComparison))
      const before = await c.drives()
      await inert.engine.reconcileDelivery({ policy: INERT })
      t.eq('declared inert: delivered with no drive', [inert.engine.run.status, await c.drives(), inert.engine.run.reconciliations.at(-1).noDrive?.reason], ['completed', before, 'inert-drift-only'])
      t.ok('with the bytes that selftest would have refused', /candidate/.test(await read(inert.f, 'changelog.txt')) && /other/.test(await read(inert.f, 'changelog.txt')))
      await releaseOwnership(inert.engine, { reason: 'test' }).catch(() => {})
      const driven = await blockedRun({ ...CHANGELOG_ONLY, ...(await counted(collect)) })
      await driven.engine.reconcileDelivery({ policy: { '**/changelog.txt': 'prepend' } })
      const attempt = driven.engine.run.reconciliations.at(-1)
      t.eq('not declared: the same drift is driven and the selftest refuses it', [attempt.state, attempt.checks.reason], ['revalidation-failed', 'selftest verdict new-failures: collect: core/changelog'], JSON.stringify(attempt))
      await releaseOwnership(driven.engine, { reason: 'test' }).catch(() => {})
      const doc = readFileSync(new URL('../../docs/project-infrastructure.md', import.meta.url), 'utf8')
      t.ok("the project documentation says it is the project's responsibility", doc.includes("Declaring a path inert makes it the project's responsibility that no check\ndepends on that file, because no drive will re-check it."))
    }

    t.section('8f. an approved result that passed only on inherited failures carries through closure')
    {
      const { f, engine } = await blockedRun({ ...CHANGELOG_ONLY, commands: '      - id: inherited\n        run: "false"\n' })
      const driven = engine.run.checkResults.at(-1)
      t.eq('it failed as run and passes the gate, known on the base', [engine.run.blockedReason, driven.result, driven.baselineComparison?.failures?.verdict], ['source-delivery-blocked', 'failed', 'baseline-known'], JSON.stringify(driven.baselineComparison))
      const metrics = runMetrics(engine.run)
      await engine.reconcileDelivery({ policy: INERT })
      t.eq('delivered: closure judges it on the base it was driven on, not B′', [engine.run.status, engine.run.closure.checks.result, engine.run.closure.checks.gating, engine.run.closure.checks.carriedFrom], ['completed', 'failed', 'passed', engine.run.reconciliations.at(-1).from], `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
      const after = runMetrics(engine.run)
      t.eq('the carried copy is no second regression, and leaves the basis alone', [after.regressionsAfterApproval, after.regressionsBasis], [metrics.regressionsAfterApproval, metrics.regressionsBasis])
      t.eq('the same base drive, and its log', (await readCheckLog({ issuePath: f.issuePath, runId: engine.runId, check: checkNumber(driven.dir), command: 'inherited' })).revision, engine.run.reconciliations.at(-1).from)
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('8g. Finalize after a failed delivery: the carried result still counts, and still no drive')
    {
      const c = await counted()
      const { f, engine } = await blockedRun({ ...CHANGELOG_ONLY, ...c })
      const provider = engine.deliveryProvider
      let thrown = false
      engine.deliveryProvider = { deliver: async (args) => { if (!thrown) { thrown = true; throw new Error('disk full') } return provider.deliver(args) } }
      const before = await c.drives()
      await engine.reconcileDelivery({ policy: INERT })
      t.eq('accepted, delivery failed', [engine.run.reconciliations.at(-1).state, engine.run.status, engine.run.blockedReason], ['accepted', 'blocked', 'delivery-failed'])
      t.eq('finalize is offered', supportedActions(engine.run).includes('finalize'), true)
      await engine.finalize()
      t.eq('Finalize delivers the composed candidate', [engine.run.status, engine.run.delivery.revision, engine.run.delivery.reconciliation.noDrive?.reason], ['completed', engine.run.revisions.at(-1).fingerprint, 'inert-drift-only'], `${engine.run.blockedReason} ${engine.run.delivery?.error}`)
      t.eq('no drive there either', await c.drives(), before)
      t.ok('and the source has it', /other/.test(await read(f, 'changelog.txt')) && /candidate/.test(await read(f, 'changelog.txt')))
      await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
    }

    t.section('8h. nothing passing to carry: the proof holds, and the drive runs')
    {
      for (const [label, spoil] of [['the only result is a smoke', (r) => ({ ...r, tier: 'smoke' })], ['the result does not pass the gate', (r) => ({ ...r, result: 'failed', baselineComparison: null })]]) {
        const c = await counted()
        const { engine } = await blockedRun({ ...CHANGELOG_ONLY, ...c })
        engine.run.checkResults = engine.run.checkResults.map(spoil)
        const before = await c.drives()
        await engine.reconcileDelivery({ policy: INERT })
        const attempt = engine.run.reconciliations.at(-1)
        t.eq(`${label}: not carried, and says so`, [attempt.inert.proved, /no full check result/.test(attempt.inert.notCarried), attempt.noDrive ?? null], [true, true, null])
        t.ok(`${label}: the drive ran and delivered`, (await c.drives()) > before && Boolean(attempt.checks.dir) && engine.run.status === 'completed', `${engine.run.status} ${JSON.stringify(attempt)}`)
        await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
      }
    }

    t.section('8i. the panel does it by itself: the automatic reconcile shares all of it')
    {
      for (const [label, scenario, noDrive] of [['inert-only', CHANGELOG_ONLY, true], ['with foreign drift', FOREIGN, false]]) {
        const c = await counted()
        const s = await supervisedRun({ ...scenario, ...c }, { policy: INERT_YAML })
        const { supervisor, events } = s.open()
        const before = await c.drives()
        await supervisor.finalize(s.ids)
        await until(() => finishes(events) > 0, 'the end announcement')
        await periods()
        t.eq(`${label}: announced once`, finishes(events), 1)
        const run = await record(s.f, s.runId)
        t.eq(`${label}: delivered, the engine's attempt`, [run.status, run.reconciliations[0].by], ['completed', 'engine'], JSON.stringify(run.reconciliations[0]))
        t.eq(`${label}: ${noDrive ? 'no drive' : 'the drive ran'}`, [Boolean(run.reconciliations[0].noDrive), (await c.drives()) === before], [noDrive, noDrive])
        await supervisor.shutdown?.()
      }
    }

    t.section('5. what is offered')
    {
      const blocked = (application, extra = {}) => ({ status: 'blocked', blockedReason: 'source-delivery-blocked', participants: {}, workspace: { path: '/w', state: 'retained' }, integrity: { status: 'clear' }, delivery: { action: 'apply-to-source', application }, ...extra })
      t.eq('foreign drift only: finalize', supportedActions(blocked({ state: 'failed', error: 'lock' })), ['finalize', 'start-new'])
      t.eq('an older record naming its own paths in the message', supportedActions(blocked({ state: 'source-drift', error: "The destination matches neither the base snapshot nor the approved revision. The approved patch's own paths changed: a.txt. The verified patch remains available" })), ['reconcile-delivery', 'finalize', 'start-new'])
      t.eq('a removed worktree offers nothing', supportedActions(blocked({ state: 'source-drift', drifted: ['a.txt'] }, { workspace: { path: '/w', state: 'removed' } })), ['start-new'])
      t.eq('a patch-only delivery is not reconciled', supportedActions(blocked({ state: 'source-drift', drifted: ['a.txt'] }, { delivery: { action: 'worktree-diff' } })), ['finalize', 'start-new'])
    }

    // Module level, as source-delivery.test.mjs and private-repository.test.mjs
    // drive delivery: a provisioned workspace, its patch, drift, the merge.
    const tmp = async (prefix) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); temps.push(d); return d }
    const repository = async (files) => {
      const dir = await tmp('reconcile-repo-')
      await git(dir, 'init', '-q', '-b', 'main'); await git(dir, 'config', 'user.email', 't@t'); await git(dir, 'config', 'user.name', 'T')
      for (const [file, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await fs.writeFile(path.join(dir, file), text) }
      await git(dir, 'add', '-A'); await git(dir, 'commit', '-qm', 'base')
      return dir
    }
    const approve = async (projectPath, policy, edit) => {
      const runs = await tmp('reconcile-runs-')
      const runId = 'run-' + Math.random().toString(16).slice(2, 10)
      const runDir = path.join(runs, runId)
      await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
      const ws = await gitWorktreeProvider.create({ projectPath, runId, root: runs, policy: { base: 'working-tree', ...policy } })
      const baseline = await baselineOf(ws.path)
      await edit(ws.path)
      const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
      const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir })
      return { ws, runId, runDir, baseline, fp, receipt, release: () => gitWorktreeProvider.release({ projectPath, path: ws.path, repository: ws.repository }) }
    }
    const mergeOf = (a) => mergeOntoSource({ workspace: a.ws, baseline: a.baseline, revision: a.fp.fingerprint, patchFile: path.join(a.runDir, a.receipt.artifactRef), policy: {}, ref: `refs/devpanel/reconciled/${a.runId}-1`, runDir: a.runDir })
    const offered = (application) => reconcileUnavailable({ status: 'blocked', blockedReason: 'source-delivery-blocked', workspace: { path: '/w' }, delivery: { action: 'apply-to-source', application } })

    t.section('6. a private repository publishes the merged delta onto the real source, never the snapshot\'s exclusions (auditor-1-001)')
    {
      const src = await repository({ 'app.txt': lines(10), 'secret.env': 'TOKEN=committed\n' })
      await fs.writeFile(path.join(src, 'secret.env'), 'TOKEN=local-modified\n')   // excluded, uncommitted
      const a = await approve(src, { repository: 1, excludes: ['secret.env'] }, (dir) => fs.writeFile(path.join(dir, 'app.txt'), lines(10, { 9: 'line 9 fixed' })))
      t.ok('A and S differ', a.ws.sourceBase && a.ws.sourceBase !== a.ws.baseCommit)
      await fs.writeFile(path.join(src, 'app.txt'), lines(10, { 1: 'line 1 elsewhere' }))
      // Delivery itself would merge this edit (source-merge.mjs); reconcile's merge is driven directly here.
      const merge = await mergeOf(a)
      try {
        t.eq('merged', merge.state, 'merged', merge.error)
        t.eq('A′ is a child of the source base A', await git(src, 'rev-parse', `${merge.publicationBase}^`).then((s) => s.trim()), a.ws.sourceBase)
        t.eq('B′ is in the source repository too', await git(src, 'rev-parse', `${merge.sourceBase}^`).then((s) => s.trim()), a.ws.baseCommit)
        const c = merge.candidate
        const published = await worktreeDiffDelivery.deliver({ action: 'commit', revision: c.fingerprint.fingerprint, fingerprint: c.fingerprint, baseCommit: c.baseCommit, baseline: c.baseline,
          workspacePath: c.path, workspace: { ...a.ws, path: c.path, baseCommit: c.baseCommit, sourceBase: merge.publicationBase }, runDir: a.runDir })
        t.eq('verified and translated, not identity', [published.reconstruction?.verified, published.publication?.translation], [true, 'applied'], published.reconstruction?.detail)
        const reviewed = (await git(src, 'diff', '--name-status', merge.sourceBase, published.reviewed)).trim()
        t.eq('the merged delta is the reviewed path alone', reviewed, 'M\tapp.txt')
        t.eq('the published delta onto A′ is exactly the merged delta', (await git(src, 'diff', '--name-status', merge.publicationBase, published.commit)).trim(), reviewed)
        t.eq('the excluded path keeps the source base\'s content', (await git(src, 'show', `${published.commit}:secret.env`)).trim(), 'TOKEN=committed')
        t.eq('and the published file holds both changes', await git(src, 'show', `${published.commit}:app.txt`), lines(10, { 1: 'line 1 elsewhere', 9: 'line 9 fixed' }))
        t.ok('the local, uncommitted secret reached no commit', !(await git(src, 'log', '--all', '-p')).includes('local-modified'))
      } finally {
        await merge.release?.()
        await a.release()
      }
    }

    t.section('7. drift on a materialized owner path is offered reconcile, merged, and dispatched to the owner (auditor-1-002)')
    {
      const owner = await repository({ 'modules/shared.txt': lines(10) })
      const app = await repository({ 'source.txt': 'original\n' })
      await fs.symlink(path.join(owner, 'modules'), path.join(app, 'shared'))
      const a = await approve(app, { symlinks: 'materialize' }, (dir) => fs.writeFile(path.join(dir, 'shared/shared.txt'), lines(10, { 9: 'line 9 fixed' })))
      t.eq('the link was materialized', a.ws.symlinks.materialized, ['shared'])
      await fs.writeFile(path.join(owner, 'modules/shared.txt'), lines(10, { 1: 'line 1 by the owner' }))
      // Owner delivery would merge this edit itself (source-merge.mjs); a conflict there records the path as drifted, which offers reconcile.
      t.eq('a drifted owner path is offered reconcile', offered({ state: 'source-drift', drifted: ['shared/shared.txt'] }), null)
      const merge = await mergeOf(a)
      try {
        t.eq('merged, not refused as unsupported', [merge.state, merge.merged], ['merged', ['shared/shared.txt']], merge.error)
        const c = merge.candidate
        const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: c.fingerprint.fingerprint, fingerprint: c.fingerprint, baseCommit: c.baseCommit, baseline: c.baseline, workspacePath: c.path, workspace: a.ws, runDir: a.runDir })
        const delivered = await applyToSource({ workspace: { ...a.ws, path: c.path, baseCommit: c.baseCommit }, baseline: c.baseline, revision: c.fingerprint.fingerprint, fingerprint: c.fingerprint, receipt, runDir: a.runDir })
        t.eq('the owner delivery of the merged candidate completes', delivered.application.state, 'complete', delivered.application.error)
        t.eq('the owner checkout holds both changes', await fs.readFile(path.join(owner, 'modules/shared.txt'), 'utf8'), lines(10, { 1: 'line 1 by the owner', 9: 'line 9 fixed' }))
        t.ok('the source link is preserved', (await fs.lstat(path.join(app, 'shared'))).isSymbolicLink())
      } finally {
        await merge.release?.()
        await a.release()
      }
    }

    t.section('7b. an inert changelog under a materialized link: the proof reads through the link, and sees the owner\'s other drift')
    {
      const policy = { '**/changelog.txt': { rule: 'prepend', inert: true } }
      const scenario = async () => {
        const owner = await repository({ 'modules/shared.txt': lines(10), 'modules/changelog.txt': 'v1 released\n' })
        const app = await repository({ 'source.txt': 'original\n' })
        await fs.symlink(path.join(owner, 'modules'), path.join(app, 'shared'))
        const a = await approve(app, { symlinks: 'materialize' }, async (dir) => {
          await fs.writeFile(path.join(dir, 'shared/shared.txt'), lines(10, { 9: 'line 9 fixed' }))
          await fs.writeFile(path.join(dir, 'shared/changelog.txt'), 'candidate: fixed\nv1 released\n')
        })
        await fs.writeFile(path.join(owner, 'modules/changelog.txt'), 'other: landed first\nv1 released\n')
        return { owner, a }
      }
      const merge = (a) => mergeOntoSource({ workspace: a.ws, baseline: a.baseline, revision: a.fp.fingerprint, patchFile: path.join(a.runDir, a.receipt.artifactRef), policy, ref: `refs/devpanel/reconciled/${a.runId}-1`, runDir: a.runDir })
      {
        const { a } = await scenario()
        const m = await merge(a)
        try {
          t.eq('proved, on the path as the worktree names it', [m.state, m.inert?.proved, m.inert?.paths, m.inert?.differing, m.appended], ['merged', true, ['shared/changelog.txt'], [], ['shared/changelog.txt']], m.error)
        } finally {
          await m.release?.()
          await a.release()
        }
      }
      {
        const { owner, a } = await scenario()
        await fs.writeFile(path.join(owner, 'modules/shared.txt'), lines(10, { 1: 'line 1 by the owner' }))
        const m = await merge(a)
        try {
          t.eq('code drift at the owner: not proved', [m.state, m.inert?.proved, m.inert?.nonInertDrift], ['merged', false, ['shared/shared.txt']], m.error)
        } finally {
          await m.release?.()
          await a.release()
        }
      }
    }

    t.section('8. an accepted check result: reconcile reruns the checks; named failures stay accepted, a failure nobody named is refused')
    {
      const commands = `${COMPATIBLE}      - id: flaky\n        run: "! grep -q fixed server.mjs"\n`
      const worktree = { 'server.mjs': lines(10, { 9: 'line 9 fixed' }) }
      const accepted = async (source) => {
        const { f, engine } = await blockedRun({ ...WITH_CHANGELOG({ worktree, source: { 'server.mjs': source } }), commands })
        t.ok('the check stopped it and acceptance is offered', supportedActions(engine.run).includes('accept-check-result'), `${engine.run.blockedReason} ${supportedActions(engine.run)}`)
        await engine.acceptCheckResult({ failures: ['flaky'], reason: 'unrelated', revision: engine.run.revisions.at(-1).fingerprint, actor: 'alice' })
        await engine.drive()
        t.eq('delivery was refused for drift, as it would be', `${engine.run.blockedReason} ${engine.run.delivery?.application?.state}`, 'source-delivery-blocked source-drift')
        t.eq('the acceptance is on the closure', engine.run.closure.acceptedCheckRisk?.failures.map((x) => x.key), ['flaky'])
        t.eq('the run does not read as delivered', runResult(engine.run, {}).result, 'incomplete')
        return { f, engine }
      }
      {
        const { f, engine } = await accepted(lines(10, { 1: 'line 1 elsewhere' }))
        const approved = engine.run.closure.revision
        await engine.reconcileDelivery({ policy: PREPEND, actor: 'alice' })
        const attempt = engine.run.reconciliations.at(-1)
        t.eq('the checks ran again on the merged candidate', `${attempt.state} ${attempt.checks.result} ${attempt.checks.gating} ${attempt.acceptedCheckRisk}`, 'accepted failed failed true')
        t.eq('delivered', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved', `${engine.run.blockedReason} ${engine.run.delivery?.error}`)
        t.eq('the source holds both changes', await read(f, 'server.mjs'), lines(10, { 1: 'line 1 elsewhere', 9: 'line 9 fixed' }))
        t.eq('the acceptance stays bound to the approved revision', engine.run.closure.acceptedCheckRisk?.revision, approved)
        t.eq('and it still does not read as verified', engine.run.closure.verificationLevel, 'review-only')
        t.eq('the result is the delivery', runResult(engine.run, {}).result, 'delivered')
        await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
      }
      {
        const { f, engine } = await accepted(lines(10, { 1: 'line 1 INCOMPATIBLE' }))
        await engine.reconcileDelivery({ policy: PREPEND, actor: 'alice' })
        t.eq('a failure nobody named is refused', engine.run.reconciliations.at(-1).state, 'revalidation-failed')
        t.eq('still blocked as before', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked source-delivery-blocked')
        t.eq('the source is untouched', await read(f, 'server.mjs'), lines(10, { 1: 'line 1 INCOMPATIBLE' }))
        await releaseOwnership(engine, { reason: 'test' }).catch(() => {})
      }
    }
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
    await cleanupFixtures()
  }
}
