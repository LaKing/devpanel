import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor, blocking, simulateProcessDeath } from './fakes/fixture.mjs'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents, runDir } from '../server/runtime/store.mjs'
import { classifyTest, historyDir, readDrives, recordDrive } from '../server/runtime/selftest-history.mjs'
import { overlappingSections } from './helpers.mjs'

export const name = 'check tiers — a smoke beside the reviews, the full drive once after approval, and only the full drive closes; a base drive reused across runs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

/*
 * `boot` is the smoke tier, `deep` only runs in the full drive. Rounds in
 * `reject` get a blocking finding from the reviewer. `f` reuses a fixture for
 * a second run on the same issue and checkout.
 */
async function scenario ({ boot, deep, reject = new Set(), extra = '', f = null, onRound = null, target = null, onAudit = null, hooks = null, beforeRun = null }) {
  // The fixture's harness keeps the script it was made with; a later run on
  // the same fixture reaches its own engine and reviews through `state`.
  const state = f?.state ?? { engine: null, log: [], reject }
  Object.assign(state, { log: [], reject, onRound, onAudit })
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await state.onRound?.(round)
      await fs.writeFile(path.join(state.engine.run.workspace.path, `round-${round}.txt`), 'work\n')
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      await state.onAudit?.(round, state)
      state.log.push({ role, round, revision: revision(prompt), checksRunning: Boolean(state.engine.checksInFlight) })
      if (state.reject.has(round)) return fence({ verdict: 'changes-needed', artifactRevision: revision(prompt), findings: [blocking(`${role}-${round}`)], priorFindings: [] })
      return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  if (!f) {
    f = await engineFixture({ playbook: 'implementation', script })
    f.state = state
    await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), target
      ? `\nchecks: ${JSON.stringify({ requirement: 'required', target })}\n`
      : `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: 0\n${extra}    tiers:\n      smoke: [boot]\n    commands:\n      - id: boot\n        run: ${JSON.stringify(boot)}\n      - id: deep\n        run: ${JSON.stringify(deep)}\n`)
  }
  await beforeRun?.(f)
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  if (hooks) Object.assign(engine.hooks, hooks)
  await (hooks ? engine.drive().catch(() => {}) : engine.drive())
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, log: state.log, events, f }
}

const started = (events, tier) => events.filter((e) => e.type === 'checks-started' && e.tier === tier).map((e) => e.revision)

export default async function (t) {
  const sections = []

  sections.push(['a smoke failure returns to the author through the failed-check path; that revision gets no full drive', async (t) => {
    // Fails on the first revision only (round-0.txt without round-1.txt); the base has neither and passes.
    const { engine, events } = await scenario({ boot: 'test ! -f round-0.txt || test -f round-1.txt', deep: 'true' })
    const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the failed smoke cost one more round, with every reviewer approving', engine.run.revisions.length, 2)
    t.eq('the first revision\'s smoke is on the record as failed', engine.run.checkHistory?.find((h) => h.revision === first && h.tier === 'smoke')?.result, 'failed')
    t.eq('the smoke ran on both revisions', started(events, 'smoke'), [first, second])
    t.eq('the full drive ran once, on the approved second revision', started(events, 'full'), [second])
    await releaseWorkspace(engine)
  }])

  sections.push(['the smoke runs on every revision beside the reviews; the full drive once, after approval', async (t) => {
    const { engine, events, log } = await scenario({ boot: 'true', deep: 'true', reject: new Set([0]) })
    const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the smoke ran on the rejected revision too', started(events, 'smoke'), [first, second])
    t.eq('the full drive only on the approved one', started(events, 'full'), [second])
    t.ok('every review saw its revision\'s smoke started first', log.every((a) => events.findIndex((e) => e.type === 'checks-started' && e.tier === 'smoke' && e.revision === a.revision) >= 0), JSON.stringify(log))
    const closing = engine.run.checkResults.filter((c) => c.revision === second)
    t.eq('the closing revision holds a smoke and a full result', closing.map((c) => c.tier), ['smoke', 'full'])
    t.eq('closure saw the passing full drive', engine.run.closure?.conditions?.checksSatisfied, true)
    t.eq('a local target has no instance to continue, and says so', closing.find((c) => c.tier === 'full')?.continuation?.reason, 'local-target')
    await releaseWorkspace(engine)
  }])

  sections.push(['a passing smoke never stands in for the full drive at closure', async (t) => {
    // The full drive fails on every candidate (it has round-0.txt), never on the base: a new failure.
    const { engine, events } = await scenario({ boot: 'true', deep: 'test ! -f round-0.txt' })
    t.ok('every smoke passed', engine.run.checkHistory.filter((h) => h.tier === 'smoke').every((h) => h.result === 'passed'))
    t.ok('the full drive ran and failed', started(events, 'full').length >= 1 && engine.run.checkHistory.filter((h) => h.tier === 'full').every((h) => h.result === 'failed'))
    t.ok('the run did not complete', engine.run.status !== 'completed', `${engine.run.status} ${engine.run.blockedReason}`)
    t.ok('and nothing closed on the smoke', engine.run.closure?.conditions?.checksSatisfied !== true)
    await releaseWorkspace(engine).catch(() => {})
  }])

  sections.push(['a baseline the run holds is reused for a later revision only while its identity still matches', async (t) => {
  for (const change of [false, true]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-held-'))
    const counter = path.join(dir, 'base-runs')
    const staged = path.join(dir, 'deployment-scope.json')
    const environment = path.join(dir, 'node')
    await fs.writeFile(staged, '{}\n')
    await fs.writeFile(environment, 'v22.11.0\n')
    const counted = `if ! ls round-*.txt >/dev/null 2>&1; then echo base >> ${counter}; fi; true`
    const extra = `    compareBaseline: true\n    baselineCache:\n      files: [${staged}]\n      environment: "cat ${environment}"\n`
    // Between the first (rejected) revision and the second, staging and the host change, or nothing does.
    const onRound = async (round) => {
      if (round === 1 && change) { await fs.writeFile(staged, '{"changed":true}\n'); await fs.writeFile(environment, 'v22.12.0\n') }
    }
    const { engine } = await scenario({ boot: counted, deep: 'true', reject: new Set([0]), extra, onRound })
    const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq(`${change ? 'changed' : 'unchanged'}: the run completes`, engine.run.status, 'completed', `${engine.run.blockedReason}`)
    const bases = (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length
    const smokeOf = (revision) => engine.run.checkResults.find((c) => c.revision === revision && c.tier === 'smoke')
    // The first baseline is the smoke tier's (the full drive comes after approval); same tier, same target key.
    const smokeBases = engine.run.baselineChecks.filter((b) => b.targetKey === engine.run.baselineChecks[0]?.targetKey)
    if (change) {
      // smoke base for the first revision, a fresh one for the second, and the full drive's.
      t.eq('changed: the second revision got a fresh smoke base drive', bases, 3)
      t.ok('changed: the two smoke baselines were taken under different identities', smokeBases.length === 2 && smokeBases[0].identityKey !== smokeBases[1].identityKey && Boolean(smokeBases[1].identityKey), JSON.stringify(engine.run.baselineChecks.map((b) => [b.dir, b.identityKey])))
      t.ok('changed: each kept its own directory', smokeBases.length === 2 && smokeBases[0].dir !== smokeBases[1].dir)
      const latest = smokeOf(second)
      t.ok('changed: the second revision was compared with the fresh baseline, not the old one', !latest || latest.baselineComparison?.baselineDir === smokeBases[1]?.dir, JSON.stringify(latest?.baselineComparison?.baselineDir))
    } else {
      // smoke base once (reused by the second revision), and the full drive's.
      t.eq('unchanged: the held smoke baseline served both revisions', bases, 2)
    }
    t.ok(`${change ? 'changed' : 'unchanged'}: two revisions were checked`, Boolean(first && second))
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }
  }])

  sections.push(['a base drive whose identity changed or could not be read during it is never reused', async (t) => {
  for (const fault of ['changed', 'unreadable']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-unstable-'))
    const counter = path.join(dir, 'base-runs')
    const staged = path.join(dir, 'deployment-scope.json')
    const environment = path.join(dir, 'node')
    const once = path.join(dir, 'faulted')
    await fs.writeFile(staged, '{"staging":"A"}\n')
    await fs.writeFile(environment, 'v22.11.0\n')
    // The first base drive changes the staging file (or removes the environment's
    // source) while it runs; the identity read after it then differs (or fails).
    const disturb = fault === 'changed' ? `echo '{"staging":"B"}' > ${staged}` : `rm -f ${environment}`
    // Each base drive prints its own number, so its log shows which drive wrote it.
    const boot = `if ! ls round-*.txt >/dev/null 2>&1; then echo base >> ${counter}; echo "base drive $(wc -l < ${counter})"; if [ ! -e ${once} ]; then touch ${once}; ${disturb}; fi; fi; true`
    const extra = `    compareBaseline: true\n    baselineCache:\n      files: [${staged}]\n      environment: "cat ${environment}"\n`
    // Before the next revision the original identity is back, exactly as it was before that drive.
    const onRound = async (round) => {
      if (round === 1) { await fs.writeFile(staged, '{"staging":"A"}\n'); await fs.writeFile(environment, 'v22.11.0\n') }
    }
    const { engine } = await scenario({ boot, deep: 'true', reject: new Set([0]), extra, onRound })
    const [, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq(`${fault}: the run completes`, engine.run.status, 'completed', `${engine.run.blockedReason}`)
    const smokeBases = engine.run.baselineChecks.filter((b) => b.targetKey === engine.run.baselineChecks[0]?.targetKey)
    const [disturbed, fresh] = smokeBases
    t.eq(`${fault}: the disturbed drive is recorded as such`, disturbed?.cache?.state, fault === 'changed' ? 'unstable' : 'unavailable', JSON.stringify(disturbed?.cache))
    t.eq(`${fault}: and vouches for no identity`, disturbed?.identityKey, undefined)
    // first revision's smoke base, a fresh one for the second, the full drive's base.
    t.eq(`${fault}: the second revision did not reuse it: a fresh base drive ran`, (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length, 3)
    t.ok(`${fault}: the fresh baseline stands for the restored identity, in a directory of its own`, Boolean(fresh?.identityKey) && Boolean(disturbed?.dir) && fresh.dir !== disturbed.dir, JSON.stringify(smokeBases.map((b) => [b.dir, b.identityKey, b.cache?.state])))
    const logOf = (b) => fs.readFile(path.join(runDir(engine.issuePath, engine.runId), b?.dir ?? 'missing', 'boot.stdout'), 'utf8').catch((e) => e.code)
    t.eq(`${fault}: the disturbed baseline's log is still the disturbed drive's own`, (await logOf(disturbed)).trim(), 'base drive 1')
    t.eq(`${fault}: the fresh drive wrote its own log`, (await logOf(fresh)).trim(), 'base drive 2')
    const latest = engine.run.checkResults.find((c) => c.revision === second && c.tier === 'smoke')
    t.ok(`${fault}: the second revision was compared with the fresh baseline`, latest?.baselineComparison?.baselineDir === fresh?.dir, JSON.stringify(latest?.baselineComparison?.baselineDir))
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }
  }])

  sections.push(['the base drive of each tier is reused by the next run on the same base commit, and the run says so', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-cache-'))
    const counter = path.join(dir, 'base-runs')
    const staged = path.join(dir, 'deployment-scope.json')
    await fs.writeFile(staged, '{}\n')
    // Each command counts its runs on the base (no round file there).
    const counted = (id) => `if ! ls round-*.txt >/dev/null 2>&1; then echo ${id} >> ${counter}; fi; true`
    const extra = `    compareBaseline: true\n    baselineCache:\n      files: [${staged}]\n      environment: "echo node-v22"\n`
    const one = await scenario({ boot: counted('boot'), deep: counted('deep'), extra })
    t.eq('the first run completes', one.engine.run.status, 'completed', `${one.engine.run.blockedReason}`)
    const baseRuns = (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length
    t.ok('it drove the base of both tiers', baseRuns >= 3, String(baseRuns))
    t.eq('and stored both', one.engine.run.baselineChecks.map((b) => b.cache?.state), ['stored', 'stored'])
    await releaseWorkspace(one.engine)
    const entries = (await fs.readdir(path.join(path.dirname(one.f.issuePath), '.baselines'))).filter((n) => !n.startsWith('.'))
    t.eq('under issues/<project>/.baselines', entries.length, 2)

    const two = await scenario({ boot: counted('boot'), deep: counted('deep'), f: one.f })
    t.eq('the second run completes', two.engine.run.status, 'completed', `${two.engine.run.blockedReason}`)
    t.eq('on the same base commit', two.engine.run.workspace.baseCommit, one.engine.run.workspace.baseCommit)
    t.eq('no base command ran again', (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length, baseRuns)
    t.ok('every baseline it used was reused from the first run', two.engine.run.baselineChecks.length === 2 && two.engine.run.baselineChecks.every((b) => b.reused?.fromRun === one.engine.runId), JSON.stringify(two.engine.run.baselineChecks.map((b) => b.reused ?? b.cache)))
    t.ok('the comparison names the reuse for reviewers', two.engine.run.checkResults.every((c) => c.baselineComparison?.reused?.fromRun === one.engine.runId))
    await releaseWorkspace(two.engine)

    await fs.writeFile(staged, '{"changed":true}\n')
    const three = await scenario({ boot: counted('boot'), deep: counted('deep'), f: one.f })
    t.ok('a changed staging file is a miss: the base runs again', (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length > baseRuns)
    t.ok('and nothing is marked reused', three.engine.run.baselineChecks.every((b) => !b.reused))
    await releaseWorkspace(three.engine)
    await fs.rm(dir, { recursive: true, force: true })
  }])

  /*
   * The whole engine on an SSH target, through the fake service manager without
   * the fence (check-continuation.test.mjs has the drive's own cases). Every
   * command says it ran, outside the candidate; `workdir` empty means nothing was
   * left on the host.
   */
  const sshDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-ssh-')))
  const managerEnv = await installRemoteManager(sshDir)
  await fs.mkdir(path.join(sshDir, 'units'))
  await fs.writeFile(path.join(sshDir, 'units', 'no-fence'), '')
  await fs.writeFile(path.join(sshDir, 'ssh'), ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join('\n') + '\n', { mode: 0o755 })
  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.CHECK_TEST_HOST }
  process.env.DEVPANEL_SSH_BIN = path.join(sshDir, 'ssh')
  process.env.CHECK_TEST_HOST = 'shim'
  // Each target says in a file of its own what ran, so targets can be driven side by side.
  const executedFile = path.join(sshDir, 'executed')
  const executedFiles = new Map()
  const executed = async (target) => (await fs.readFile(executedFiles.get(target), 'utf8').catch(() => '')).split('\n').filter(Boolean)
  const cmd = (id, run = 'true', extra = {}) => ({ id, kind: 'candidate', run: `echo ${id} >> ${executedFile}; ${run}`, ...extra })
  const service = { id: 'start', kind: 'candidate', service: true, run: `echo start >> ${executedFile}; exec sleep 120` }
  const sshTarget = async (commands, smoke, { retryFailed = 0, tiers = {}, ...rest } = {}) => {
    const workdir = await fs.realpath(await fs.mkdtemp(path.join(sshDir, 'remote-')))
    const file = `${workdir}.executed`
    const target = { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, retryFailed, confinement: { user: os.userInfo().username, home: os.homedir() }, tiers: { smoke, ...tiers }, commands: commands.map((c) => ({ ...c, run: c.run.replaceAll(executedFile, file) })), ...rest }
    executedFiles.set(target, file)
    return target
  }
  const STANDARD = [cmd('prepare'), service, cmd('ready'), cmd('deep')]
  const SMOKE = ['prepare', 'start', 'ready']
  const left = (target) => fs.readdir(target.ssh.workdir)
  const fullOf = (engine) => engine.run.checkResults.filter((c) => c.tier === 'full').at(-1)
  const smokeOf = (engine) => engine.run.checkResults.filter((c) => c.tier === 'smoke').at(-1)

  try {
    sections.push(['the full drive continues the smoke\'s instance, and closure counts it as the full drive', async (t) => {
      const target = await sshTarget(STANDARD, SMOKE)
      const { engine, events } = await scenario({ target })
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(fullOf(engine)?.continuation)}`)
      t.eq('each command executed once', await executed(target), ['prepare', 'start', 'ready', 'deep'])
      t.eq('the record states what it continued', fullOf(engine)?.continuedFrom?.dir, smokeOf(engine)?.dir)
      t.eq('closure saw the passing full drive', engine.run.closure?.conditions?.checksSatisfied, true)
      t.eq('the verification is the same as any full drive\'s', fullOf(engine)?.tier, 'full')
      t.eq('its history says so', engine.run.checkHistory.find((h) => h.tier === 'full')?.continuedFrom, smokeOf(engine)?.dir)
      t.eq('its event says so', events.find((e) => e.type === 'checks' && e.tier === 'full')?.continuedFrom, smokeOf(engine)?.dir)
      t.eq('the instance is no longer held', engine.run.keptInstance, null)
      t.eq('nothing is left on the host', await left(target), [])
      await releaseWorkspace(engine)
    }])

    sections.push(['a passing non-prefix tier continues and closes', async (t) => {
      const target = await sshTarget([cmd('prepare'), cmd('lint'), service, cmd('ready'), cmd('deep')], SMOKE)
      const { engine } = await scenario({ target })
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      t.eq('the command outside the smoke ran on the instance', await executed(target), ['prepare', 'start', 'ready', 'lint', 'deep'])
      t.eq('and is on the record as out of position', fullOf(engine)?.continuedFrom?.declaredBeforeServices, ['lint'])
      t.eq('closure saw the passing full drive', engine.run.closure?.conditions?.checksSatisfied, true)
      await releaseWorkspace(engine)
    }])

    sections.push(['a rejected revision\'s instance is discarded before the author\'s next turn; the approved one is continued', async (t) => {
      const target = await sshTarget(STANDARD, SMOKE)
      let leftAtAuthor = null
      const { engine, events } = await scenario({ target, reject: new Set([0]), onRound: async (round) => { if (round === 1) leftAtAuthor = await left(target) } })
      const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      t.eq('the rejected instance was gone when the author worked', leftAtAuthor, [])
      t.eq('discarded for that reason', engine.run.discardedInstances?.map((d) => [d.revision, d.reason, d.passed]), [[first, 'no-full-drive-follows', true]])
      t.ok('with an event', events.some((e) => e.type === 'instance-discarded' && e.revision === first))
      t.eq('the full drive continued the approved revision\'s smoke', [fullOf(engine)?.revision, fullOf(engine)?.continuedFrom?.dir], [second, smokeOf(engine)?.dir])
      t.eq('nothing is left on the host', await left(target), [])
      await releaseWorkspace(engine)
    }])

    sections.push(['a cancelled run discards its instance', async (t) => {
      const target = await sshTarget(STANDARD, SMOKE)
      let held = null
      // The smoke has finished and kept its instance when the operator cancels.
      const { engine } = await scenario({ target, hooks: {}, onAudit: async (round, state) => {
        await state.engine.checksInFlight
        held = state.engine.run.keptInstance
        state.engine.cancel('test')
      } })
      t.ok('an instance was held when the run was cancelled', Boolean(held?.remoteDir))
      t.eq('the run is cancelled', engine.run.status, 'cancelled', `${engine.run.blockedReason}`)
      t.eq('the instance is not held now', engine.run.keptInstance ?? null, null)
      t.eq('discarded for the run ending', engine.run.discardedInstances?.map((d) => [d.reason, d.passed]), [['run-ended', true]])
      t.eq('nothing is left on the host', await left(target), [])
      await releaseWorkspace(engine).catch(() => {})
    }])

    sections.push(['a restart: the instance survives on the record, and the proof decides', async (t) => {
      const crashing = () => ({ beforeInvoke: async (x) => {
        if (!Object.values(x.run.participants).some((p) => p.pendingInvocation?.cursor?.stepId?.startsWith('audit-'))) return
        delete x.hooks.beforeInvoke
        throw Object.assign(new Error('owner crashed'), { injected: true })
      } })
      const crashThenResume = async (tamper = null) => {
        const target = await sshTarget(STANDARD, SMOKE)
        const { engine, f } = await scenario({ target, hooks: crashing() })
        const held = engine.run.keptInstance
        await simulateProcessDeath(f.issuePath)
        const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
        f.state.engine = resumed
        await resumed.recover()
        tamper?.(resumed)
        await resumed.drive()
        return { target, held, resumed }
      }
      {
        const { target, held, resumed } = await crashThenResume()
        t.ok('a crash leaves it on the record', Boolean(held?.remoteDir))
        t.eq('the resumed run completes', resumed.run.status, 'completed', `${resumed.run.blockedReason}`)
        t.eq('and continues it', fullOf(resumed)?.continuedFrom?.remoteDir, held?.remoteDir)
        t.eq('nothing is left on the host', await left(target), [])
        await releaseWorkspace(resumed)
      }
      {
        const { target, resumed } = await crashThenResume((r) => { r.run.keptInstance.targetKey = 'another-definition' })
        t.eq('another definition: from scratch, saying why', fullOf(resumed)?.continuation?.reason, 'target-changed', JSON.stringify(fullOf(resumed)?.continuation))
        t.eq('the old instance is gone', await left(target), [])
        await releaseWorkspace(resumed)
      }
      {
        const { target, resumed } = await crashThenResume((r) => { r.run.keptInstance.revision = 'sha256:another-revision' })
        t.eq('another revision: from scratch, saying why', fullOf(resumed)?.continuation?.reason, 'revision-changed', JSON.stringify(fullOf(resumed)?.continuation))
        t.eq('the old instance is gone', await left(target), [])
        await releaseWorkspace(resumed)
      }
    }])

    sections.push(['Refresh checks always runs from scratch', async (t) => {
      const target = await sshTarget(STANDARD, SMOKE)
      const { engine } = await scenario({ target })
      await fs.rm(executedFiles.get(target), { force: true })
      await engine.maybeRunChecks({ force: true, target: engine.snapshot.checks.target })
      t.eq('says why', fullOf(engine)?.continuation?.reason, 'refresh')
      t.eq('every command executed', await executed(target), ['prepare', 'start', 'ready', 'deep'])
      t.eq('nothing is left on the host', await left(target), [])
      await releaseWorkspace(engine)
    }])

    sections.push(['a continued drive that fails is retried from scratch; the fresh result is the one that counts', async (t) => {
      const once = path.join(sshDir, 'failed-once')
      const target = await sshTarget([cmd('prepare'), service, cmd('ready'), cmd('deep', `test -e ${once} || { touch ${once}; exit 1; }`)], SMOKE, { retryFailed: 1 })
      const { engine } = await scenario({ target })
      const full = fullOf(engine)
      t.eq('the run completes on the retry', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      t.eq('the retry passed, marked flaky', [full?.result, full?.flaky], ['passed', true])
      t.ok('the attempt that continued is on the record', Boolean(full?.attempts?.[0]?.continuedFrom), JSON.stringify(full?.attempts))
      t.eq('the record says why this drive ran from scratch', full?.continuation?.reason, 'retry')
      t.eq('the retry ran in declared order', (await executed(target)).slice(-4), ['prepare', 'start', 'ready', 'deep'])
      t.eq('nothing is left on the host', await left(target), [])
      await releaseWorkspace(engine)
    }])

    sections.push(['the same scenario as auditor-1\'s, with the default retry: the fresh drive reaches comparison, and the verdict is its own', async (t) => {
      const target = await sshTarget([cmd('prepare'), cmd('lint', 'echo lint failed; exit 3'), service, cmd('ready')], SMOKE, { retryFailed: 1, compareBaseline: true })
      const { engine } = await scenario({ target })
      const full = engine.run.checkHistory.filter((h) => h.tier === 'full')
      const record = engine.run.checkResults.filter((c) => c.tier === 'full').at(-1) ?? null
      t.ok('the run did not close on an inherited failure with commands not run', engine.run.status !== 'completed', `${engine.run.status} ${engine.run.blockedReason}`)
      t.ok('the gate failed it', full.every((h) => h.gating === 'failed'), JSON.stringify(full))
      if (record) {
        t.eq('not made, its later commands not run', [record.baselineComparison?.failures?.verdict, record.baselineComparison?.failures?.notRun], ['not-made', ['start', 'ready']])
        t.ok('from the drive that ran from scratch', Boolean(record.attempts?.[0]?.continuedFrom) && !record.continuedFrom, JSON.stringify(record.attempts))
      }
      await releaseWorkspace(engine).catch(() => {})
    }])

    sections.push(['new selftest failures on a smoke discard its instance before the second drive', async (t) => {
      const collect = 'if ls round-*.txt >/dev/null 2>&1; then r=\'{"test":"core/a","error":"x"}\'; else r=\'{"test":"core/a"}\'; fi; echo "== runtime/selftest.report"; printf \'{"tests":[%s]}\\n\' "$r"'
      const target = await sshTarget([cmd('prepare'), service, cmd('collect', collect, { report: 'selftest' }), cmd('deep')], ['prepare', 'start', 'collect'], { retryFailed: 1 })
      const { engine, events } = await scenario({ target })
      // Which step stopped the retry, when one does: the base, the verdict or the retry itself.
      const seen = JSON.stringify({ discarded: engine.run.discardedInstances, bases: engine.run.baselineChecks?.map((b) => [b.dir, b.result, b.error]), smoke: smokeOf(engine)?.baselineComparison?.selftest && { verdict: smokeOf(engine).baselineComparison.selftest.verdict, reason: smokeOf(engine).baselineComparison.selftest.reason }, retries: events.filter((e) => e.type.startsWith('checks-retry')) })
      t.ok('the base it compared with could be driven', engine.run.baselineChecks?.some((b) => b.result === 'passed'), seen)
      t.ok('the second drive ran for new selftest failures', events.some((e) => e.type === 'checks-retry' && e.reason === 'new-selftest-failures'), seen)
      t.ok('the first drive\'s instance was discarded for the rerun', engine.run.discardedInstances?.some((d) => d.reason === 'selftest-retry'), seen)
      t.eq('no instance is held', engine.run.keptInstance ?? null, null)
      t.eq('nothing is left on the host', await left(target), [])
      await releaseWorkspace(engine).catch(() => {})
    }])

    sections.push(['a carried report stays one observation through the retry path, and a later failure is classified as it would be', async (t) => {
      const once = path.join(sshDir, 'failed-once-report')
      const report = 'echo "== runtime/selftest.report"; printf \'{"tests":[{"test":"core/a"}]}\\n\''
      const target = await sshTarget([cmd('prepare'), service, cmd('collect', report, { report: 'selftest' }), cmd('deep', `test -e ${once} || { touch ${once}; exit 1; }`)], ['prepare', 'start', 'collect'], { retryFailed: 1 })
      // A failure and two passes on one tree: two more passes keep it unstable, a third would expire it (EXPIRY_PASSES).
      const seeds = [{ failed: ['core/a'] }, { passed: ['core/a'] }, { passed: ['core/a'] }]
      const { engine, f } = await scenario({ target, beforeRun: async (fixture) => {
        for (const [i, outcome] of seeds.entries()) {
          await recordDrive(historyDir(fixture.issuePath), { id: `seed-${i}`, at: new Date(fixture.clock.now() - 86400000 + i * 1000).toISOString(), runId: 'seed', issueId: 'another-issue', kind: 'candidate', treeIdentity: 'seed-tree', targetKey: 'seed-key', revision: 'seed', baseCommit: 'seed', tier: null, dir: `checks/seed-${i}`, changedPaths: [], commands: [{ command: 'collect', failed: [], passed: [], asNew: [], ...outcome }] }, { now: fixture.clock.now() })
        }
      } })
      const full = fullOf(engine)
      const attempt = full?.attempts?.[0]
      const drives = await readDrives(historyDir(f.issuePath))
      t.eq('the run completes on the fresh retry', [engine.run.status, full?.flaky], ['completed', true], `${engine.run.blockedReason}`)
      t.eq('the attempt that continued keeps the report\'s provenance', attempt?.commands?.find((c) => c.id === 'collect')?.fromSmoke, smokeOf(engine)?.dir)
      t.eq('and leaves no line in the history: it ran no report', drives.filter((d) => d.dir === attempt?.dir), [])
      t.eq('one line per execution: the smoke\'s and the retry\'s', drives.filter((d) => d.runId === engine.runId).map((d) => d.dir), [smokeOf(engine)?.dir, full?.dir])
      const later = classifyTest({ drives, command: 'collect', test: 'core/a', now: f.clock.now() })
      t.eq('so a later failure of the test still reads as unstable', later?.routes, ['same-bytes'], JSON.stringify(later))
      t.eq('with the passes that really happened', later?.passesSinceLastFailure, 4)
      await releaseWorkspace(engine)
    }])

    sections.push(['tiers.continueSmoke: false runs the full drive from scratch and keeps nothing', async (t) => {
      const target = await sshTarget(STANDARD, SMOKE, { tiers: { continueSmoke: false } })
      const { engine } = await scenario({ target })
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      t.eq('says why', fullOf(engine)?.continuation?.reason, 'opted-out')
      t.eq('every smoke command ran twice', await executed(target), ['prepare', 'start', 'ready', 'prepare', 'start', 'ready', 'deep'])
      t.ok('the smoke kept nothing', !smokeOf(engine)?.kept)
      await releaseWorkspace(engine)
    }])

    sections.push(['the base drive stays a from-scratch drive of the whole target, and the comparison reads every command', async (t) => {
      const target = await sshTarget(STANDARD, SMOKE, { compareBaseline: true })
      const { engine } = await scenario({ target })
      const count = (list, id) => list.filter((x) => x === id).length
      const ran = await executed(target)
      t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
      t.ok('it continued', Boolean(fullOf(engine)?.continuedFrom), JSON.stringify(fullOf(engine)?.continuation))
      t.eq('prepare: the smoke, its base and the full tier\'s base; not the continued drive', count(ran, 'prepare'), 3)
      t.eq('deep: the continued drive and the full tier\'s base', count(ran, 'deep'), 2)
      t.eq('every command compared with the base', fullOf(engine)?.baselineComparison?.unchanged, ['prepare', 'start', 'ready', 'deep'])
      t.eq('no base drive left anything behind', await left(target), [])
      await releaseWorkspace(engine)
    }])

    await overlappingSections(t, sections)
  } finally {
    process.env.DEVPANEL_SSH_BIN = saved.bin; process.env.CHECK_TEST_HOST = saved.host
    if (saved.bin === undefined) delete process.env.DEVPANEL_SSH_BIN
    if (saved.host === undefined) delete process.env.CHECK_TEST_HOST
    for (const name of await fs.readdir(path.join(sshDir, 'units')).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const { pid } = JSON.parse(await fs.readFile(path.join(sshDir, 'units', name), 'utf8').catch(() => '{}'))
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    await fs.rm(sshDir, { recursive: true, force: true })
  }
}
