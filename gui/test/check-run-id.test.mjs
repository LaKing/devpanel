import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { installRemoteManager } from './fakes/remote-manager.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { baselineCacheFor, baselineIdentity } from '../server/runtime/baseline-cache.mjs'
import { gitWorktreeProvider, releaseWorkspace, startRun } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { localChecksErrors } from '../server/infrastructure.mjs'

export const name = 'check run id — every drive of one run sees one DEVPANEL_RUN_ID; a command can report the drive unavailable'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const REPORT = 'echo "devpanel-unavailable: the pin is gone" >&2; exit 3'

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

  const projectPath = await temp('rid-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'value.txt'), '1' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'rid', root: await temp('rid-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  const shared = { baseCommit: ws.baseCommit, baseline, workspacePath: ws.path }
  const candidate = async (target, extra = {}) => runChecks({ ...shared, target, revision: fp.fingerprint, fingerprint: fp, runDir: await temp('rid-run-'), ...extra })
  const baseDrive = async (target, extra = {}) => runChecks({ ...shared, target, revision: null, base: true, dirName: 'base', runDir: await temp('rid-run-'), ...extra })
  const said = (check, id) => check.commands.find((c) => c.id === id)?.stdout.trim()

  t.section('a local command sees the run, on the candidate and on the base')
  {
    const target = { kind: 'local', commands: [{ id: 'first', run: 'test -n "$DEVPANEL_RUN_ID"; echo "$DEVPANEL_RUN_ID"' }], finallyCommands: [{ id: 'last', run: 'echo "$DEVPANEL_RUN_ID"' }] }
    const cand = await candidate(target, { runId: 'run-a' })
    const base = await baseDrive(target, { runId: 'run-a' })
    t.eq('the candidate drive passed', cand.result, 'passed', cand.error)
    t.eq('its command read the run', said(cand, 'first'), 'run-a')
    t.eq('its finalizer read the run', said(cand, 'last'), 'run-a')
    t.eq('the base drive read the same run', said(base, 'first'), 'run-a')
    t.eq('another run reads another value', said(await candidate(target, { runId: 'run-b' }), 'first'), 'run-b')
  }

  const shimDir = await temp('rid-shim-')
  const managerEnv = await installRemoteManager(shimDir)
  await fs.mkdir(path.join(shimDir, 'units'))
  await fs.writeFile(path.join(shimDir, 'units', 'no-fence'), '')
  const shim = path.join(shimDir, 'ssh')
  await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'exec /bin/sh -c "$last"'].join(NL) + NL, { mode: 0o755 })
  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.CHECK_TEST_HOST }
  process.env.DEVPANEL_SSH_BIN = shim; process.env.CHECK_TEST_HOST = 'shim'
  const ssh = async () => ({ hostRef: 'env:CHECK_TEST_HOST', workdir: await temp('rid-remote-') })
  const confinement = { user: os.userInfo().username, home: os.homedir() }

  try {
    t.section('an SSH command of every kind sees the run, on the candidate and on the base')
    {
      const commands = [
        { id: 'in-fence', kind: 'candidate', run: 'echo "$DEVPANEL_RUN_ID"' },
        { id: 'host', kind: 'privileged', run: 'echo "$DEVPANEL_RUN_ID"' },
        { id: 'app', kind: 'candidate', service: true, run: 'echo "$DEVPANEL_RUN_ID" > service-saw; exec sleep 60' },
        { id: 'app-read', kind: 'candidate', run: 'for i in $(seq 50); do test -s service-saw && break; sleep 0.1; done; cat service-saw' }
      ]
      const target = { kind: 'ssh', ssh: await ssh(), commands, finallyCommands: [{ id: 'collect', kind: 'privileged', run: 'echo "$DEVPANEL_RUN_ID"' }], confinement }
      const cand = await candidate(target, { runId: 'run-a' })
      const base = await baseDrive(target, { runId: 'run-a' })
      t.eq('the candidate drive passed', cand.result, 'passed', cand.error ?? JSON.stringify(cand.commands.filter((c) => !c.passed)))
      for (const id of ['in-fence', 'host', 'app-read', 'collect']) {
        t.eq(`${id} read the run on the candidate`, said(cand, id), 'run-a')
        t.eq(`${id} read the same run on the base`, said(base, id), 'run-a')
      }
      t.eq('another run reads another value', said(await candidate({ ...target, ssh: await ssh() }, { runId: 'run-b' }), 'in-fence'), 'run-b')
      const plain = { kind: 'ssh', ssh: await ssh(), commands: [{ id: 'plain', run: 'echo "$DEVPANEL_RUN_ID"' }] }
      t.eq('a command without a kind reads it too', said(await candidate(plain, { runId: 'run-a' }), 'plain'), 'run-a')
    }

    t.section('a command reports unavailable over SSH: the reason is recorded, nothing later runs, a collector that then finds nothing changes neither')
    {
      const target = { kind: 'ssh', ssh: await ssh(), confinement,
        commands: [{ id: 'stage', kind: 'privileged', reportsUnavailable: true, run: REPORT }, { id: 'later', kind: 'candidate', run: 'true' }],
        finallyCommands: [{ id: 'collect', kind: 'privileged', run: 'exit 1' }] }
      for (const [label, check] of [['the candidate drive', await candidate(target)], ['the base drive', await baseDrive(target)]]) {
        t.eq(`${label} is unavailable, not failed`, check.result, 'unavailable', check.error)
        t.ok(`${label} carries the reason`, check.error?.startsWith('stage reported the drive cannot be made: the pin is gone'), check.error)
        t.eq(`${label} ran nothing after it`, check.skipped?.map((s) => s.id), ['later'])
        t.eq(`${label}'s command record says so`, check.commands.find((c) => c.id === 'stage').unavailable, 'the pin is gone')
      }
    }

    t.section('the same line from a command that did not declare it is an ordinary failure, over SSH too')
    {
      const target = { kind: 'ssh', ssh: await ssh(), confinement, commands: [{ id: 'stage', kind: 'privileged', run: REPORT }] }
      t.eq('failed', (await candidate(target)).result, 'failed')
    }

    t.section('the baseline identity: the environment command is told the run, and the key does not depend on it')
    {
      const seen = path.join(await temp('rid-env-'), 'seen')
      for (const remote of [false, true]) {
        const target = { kind: remote ? 'ssh' : 'local', ...(remote ? { ssh: await ssh() } : {}), commands: [{ id: 'probe', run: 'true' }],
          baselineCache: { environment: `test -n "$DEVPANEL_RUN_ID" && echo "$DEVPANEL_RUN_ID" >> ${seen}; echo same` } }
        const targetKey = crypto.createHash('sha256').update(JSON.stringify(target)).digest('hex')
        const of = (runId) => baselineIdentity({ target, targetKey, baseCommit: ws.baseCommit, runId })
        const [a, b] = [await of('run-a'), await of('run-b')]
        t.ok(`${target.kind}: both identities read`, Boolean(a.key && b.key), a.error ?? b.error)
        t.eq(`${target.kind}: two runs reading the same environment share a key`, a.key, b.key)
        t.ok(`${target.kind}: the record does not hold the run`, !JSON.stringify(a.record).includes('run-a'))
        await fs.rm(seen, { force: true })
        const cache = baselineCacheFor({ target, targetKey, baseCommit: ws.baseCommit, issuePath: path.join(await temp('rid-issues-'), 'p', 'i'), runDir: await temp('rid-run-'), runId: 'run-c', clock: { now: () => 0, iso: () => '' } })
        await cache.identity()
        t.eq(`${target.kind}: a check's cache reads it under its own run`, (await fs.readFile(seen, 'utf8')).trim(), 'run-c')
        await fs.rm(seen, { force: true })
      }
    }
  } finally {
    if (saved.bin === undefined) delete process.env.DEVPANEL_SSH_BIN; else process.env.DEVPANEL_SSH_BIN = saved.bin
    if (saved.host === undefined) delete process.env.CHECK_TEST_HOST; else process.env.CHECK_TEST_HOST = saved.host
  }

  t.section('what counts as a report, locally')
  {
    const local = (command, ...more) => ({ kind: 'local', commands: [command, ...more] })
    const reported = await candidate(local({ id: 'stage', reportsUnavailable: true, run: REPORT }, { id: 'later', run: 'true' }))
    t.eq('declared, non-zero, with the line: unavailable', reported.result, 'unavailable')
    t.ok('with the reason', reported.error?.includes('the pin is gone'), reported.error)
    t.eq('declared, non-zero, no line: failed', (await candidate(local({ id: 'stage', reportsUnavailable: true, run: 'exit 3' }))).result, 'failed')
    t.eq('declared, non-zero, a line with no reason: failed', (await candidate(local({ id: 'stage', reportsUnavailable: true, run: 'echo "devpanel-unavailable: "; exit 3' }))).result, 'failed')
    t.eq('declared, exit 0 with the line: passed', (await candidate(local({ id: 'stage', reportsUnavailable: true, run: 'echo "devpanel-unavailable: no"' }))).result, 'passed')
    t.eq('not declared: failed', (await candidate(local({ id: 'stage', run: REPORT }))).result, 'failed')
    t.eq('on an optional command the line decides nothing', (await candidate(local({ id: 'stage', required: false, reportsUnavailable: true, run: REPORT }, { id: 'later', run: 'true' }))).result, 'passed')
    const timedOut = await candidate(local({ id: 'stage', reportsUnavailable: true, timeoutSeconds: 1, run: 'echo "devpanel-unavailable: late"; exec sleep 30' }))
    t.eq('a command the engine ended did not report: failed', [timedOut.result, timedOut.commands[0].timedOut], ['failed', true])
    const earlier = await candidate(local({ id: 'build', run: 'exit 1' }, { id: 'stage', needs: [], reportsUnavailable: true, run: REPORT }))
    t.eq('another required command already failed: the failure stands', earlier.result, 'failed')
    t.eq('a required finalizer that then finds nothing leaves the report standing', (await candidate({ kind: 'local', commands: [{ id: 'stage', reportsUnavailable: true, run: REPORT }], finallyCommands: [{ id: 'collect', run: 'exit 1' }] })).result, 'unavailable')
  }

  t.section('config: the field belongs on a required command')
  {
    const errors = (checks) => localChecksErrors({ checks })
    t.eq('on a required command: fine', errors({ commands: [{ id: 'a', reportsUnavailable: true, run: 'true' }] }), [])
    t.ok('on an optional one: refused', errors({ commands: [{ id: 'k', run: 'true' }, { id: 'a', required: false, reportsUnavailable: true, run: 'true' }] }).some((e) => /a: reportsUnavailable applies to a required command/.test(e)))
    t.ok('on a finalizer: refused', errors({ commands: [{ id: 'k', run: 'true' }], finallyCommands: [{ id: 'f', reportsUnavailable: true, run: 'true' }] }).some((e) => /f: reportsUnavailable does not apply/.test(e)))
  }

  const launched = async (f) => startRun({
    playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
    workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
  })
  const withChecks = async (commands) => {
    const f = await engineFixture()
    await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'), `checks:\n  requirement: required\n  target:\n    kind: local\n    compareBaseline: true\n    commands:\n${commands}`)
    return launched(f)
  }

  t.section('in a run: the engine gives every drive its own run id, and two runs differ')
  {
    const drive = async () => {
      const engine = await withChecks('      - id: who\n        run: test -n "$DEVPANEL_RUN_ID"; echo "$DEVPANEL_RUN_ID"\n')
      const finished = await engine.drive()
      const seen = { id: engine.runId, candidate: said(finished.checkResults[0], 'who'), base: said(finished.baselineChecks[0], 'who'), result: finished.checkResults[0].result }
      await engine.maybeRunChecks({ force: true })
      seen.again = said(engine.run.checkResults.at(-1), 'who')
      await releaseWorkspace(engine)
      return seen
    }
    const one = await drive()
    const two = await drive()
    t.eq('the check passed', one.result, 'passed')
    t.eq('the candidate drive read this run\'s id', one.candidate, one.id)
    t.eq('its base drive read the same', one.base, one.id)
    t.eq('a later drive of the run read the same', one.again, one.id)
    t.eq('the second run read its own', two.candidate, two.id)
    t.ok('the two runs differ', one.id !== two.id)
  }

  t.section('in a run: a report is not retried, the base is not kept, and the reason reaches the record')
  {
    const engine = await withChecks('      - id: stage\n        reportsUnavailable: true\n        run: \'echo "devpanel-unavailable: the pin is gone" >&2; exit 3\'\n')
    const finished = await engine.drive()
    const check = finished.checkResults.at(-1)
    t.eq('the check is unavailable', check.result, 'unavailable', check.error)
    t.ok('with the reason', check.error?.includes('the pin is gone'), check.error)
    t.ok('never retried as a failure', !check.attempts?.length, JSON.stringify(check.attempts))
    t.eq('the base that reported is not kept', finished.baselineChecks?.length ?? 0, 0)
    t.eq('the comparison says why there is none', check.baselineComparison?.baselineResult, 'unavailable')
    t.ok('the run did not resolve on it', finished.outcome !== 'resolved', JSON.stringify({ status: finished.status, outcome: finished.outcome, blockedReason: finished.blockedReason }))
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
  for (const d of temps) await fs.rm(d, { recursive: true, force: true })
}
