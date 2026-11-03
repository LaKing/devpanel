import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { installRemoteManager, fireTimer } from './fakes/remote-manager.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { continuationPlan, tierTarget } from '../server/runtime/baseline-cache.mjs'
import { compareFailures, compareSelftestReports, gatingResult } from '../server/runtime/baseline-failures.mjs'
import { expiryUnit } from '../server/runtime/remote-check-process.mjs'
import { openStability, historyDir } from '../server/runtime/selftest-history.mjs'
import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'

export const name = 'smoke continuation — a full drive runs on its smoke\'s proved instance, says why when it cannot, and leaves comparison and gating what a fresh drive would'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * The service manager is the fake one, without the fence (`no-fence`): this suite
 * is about what the engine decides, so it does not depend on bubblewrap. A `join`
 * on a RUNNING service needs a fence to enter, so that case is in
 * remote-confinement.test.mjs, against a real bubblewrap.
 */
export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }

  const projectPath = await temp('cc-proj-')
  await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(projectPath, 'source.txt'), 'original' + NL)
  await run('git', ['-C', projectPath, 'add', '-A'])
  await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'cc1', root: await temp('cc-ws-'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'value.txt'), '2' + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })

  const shimDir = await temp('cc-shim-')
  const managerEnv = await installRemoteManager(shimDir)
  const unitsDir = path.join(shimDir, 'units')
  await fs.mkdir(unitsDir)
  await fs.writeFile(path.join(unitsDir, 'no-fence'), '')
  const shim = path.join(shimDir, 'ssh')
  await fs.writeFile(shim, ['#!/bin/sh', managerEnv, 'for last; do :; done', 'if [ -e "$DEVPANEL_TEST_UNITS/ssh-down" ]; then case "$last" in *devpanel-claim*) exit 255;; esac; fi', 'exec /bin/sh -c "$last"'].join(NL) + NL, { mode: 0o755 })
  const saved = { bin: process.env.DEVPANEL_SSH_BIN, host: process.env.CHECK_TEST_HOST }
  process.env.DEVPANEL_SSH_BIN = shim; process.env.CHECK_TEST_HOST = 'shim'
  const flag = (name) => path.join(unitsDir, name)

  const executedFile = path.join(shimDir, 'executed')
  const executed = async () => (await fs.readFile(executedFile, 'utf8').catch(() => '')).split(NL).filter(Boolean)
  const forget = () => fs.rm(executedFile, { force: true })
  // Every command says it ran, outside the candidate.
  const cmd = (id, run = 'true', extra = {}) => ({ id, kind: 'candidate', run: `echo ${id} >> ${executedFile}; ${run}`, ...extra })
  const service = (id = 'start', extra = {}) => ({ id, kind: 'candidate', service: true, run: `echo ${id} >> ${executedFile}; exec sleep 120`, ...extra })
  const FAILS = 'echo lint failed; exit 3'

  const workdirs = []
  const targetOf = async (commands, smoke, { finallyCommands = [], tiers = {} } = {}) => {
    const workdir = await temp('cc-remote-')
    workdirs.push(workdir)
    return { kind: 'ssh', ssh: { hostRef: 'env:CHECK_TEST_HOST', workdir }, commands, finallyCommands, confinement: { user: os.userInfo().username, home: os.homedir() }, tiers: { smoke, ...tiers } }
  }
  const drive = (target, runDir, extra = {}) => runChecks({ target, revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir, ...extra })
  const smokeOf = async (target, runDir) => {
    const plan = continuationPlan(target)
    const smoke = await drive(tierTarget(target, 'smoke'), runDir, { keep: { seconds: plan.keepSeconds } })
    return { plan, smoke, instance: smoke.kept ? { ...smoke.kept, revision: fp.fingerprint } : null }
  }
  /** A smoke, whatever happens to its instance, then the full drive that follows it. */
  const smokeThenFull = async (target, { runDir = null, between = null } = {}) => {
    const dir = runDir ?? await temp('cc-run-')
    const { plan, smoke, instance } = await smokeOf(target, dir)
    if (!instance) throw new Error(`the smoke kept nothing: ${smoke.instanceNotKept ?? smoke.error ?? smoke.result}`)
    await between?.(instance)
    await forget()
    const full = await drive(tierTarget(target, 'full'), dir, { continueFrom: { instance, smoke, plan } })
    return { dir, smoke, instance, full, ran: await executed() }
  }
  const unitFile = (unit) => path.join(unitsDir, `${unit}.json`)
  const startUnit = (instance) => instance.services.find((s) => s.id === 'start').unit
  const invocations = async () => (await fs.readFile(path.join(unitsDir, 'invocations.jsonl'), 'utf8')).trim().split(NL).map((l) => JSON.parse(l))
  const left = async (target) => fs.readdir(target.ssh.workdir)

  try {
    t.section('a service that writes its started marker late: the start waits, and readiness never races it')
    {
      const MARKER = '.devpanel-service-pid'
      const writesAfter = (seconds) => `echo start >> ${executedFile}; { sleep ${seconds}; echo $$ > ${MARKER}; } & exec sleep 120`
      const readiness = cmd('readiness', `cat ${MARKER}`)
      const driveOf = async (commands, extra) => { const dir = await temp('cc-run-'); const target = await targetOf(commands, [], extra); const result = await drive(target, dir); return { dir, target, result, log: (id) => fs.readFile(path.join(dir, result.dir, `${id}.log`), 'utf8') } }

      const race = await driveOf([service('start', { run: writesAfter(60) }), readiness])
      t.eq('without a declared marker the same service loses the race: readiness fails on the missing file', [race.result.commands[0].passed, race.result.commands[1].passed, /No such file/.test(race.result.commands[1].stderr)], [true, false, true], JSON.stringify(race.result.commands))

      const late = await driveOf([service('start', { startedMarker: MARKER, startedTimeoutSeconds: 30, run: writesAfter(2) }), readiness])
      t.eq('with it the drive proceeds past the start and readiness', [late.result.result, ...late.result.commands.map((c) => c.passed)], ['passed', true, true], late.result.error ?? JSON.stringify(late.result.commands))
      t.ok('the start command waited for the marker', late.result.commands[0].durationMs >= 1900, String(late.result.commands[0].durationMs))
      t.eq('nothing of the rule is in a good start\'s output', /devpanel-started/.test(await late.log('start')), false)

      const never = await driveOf([service('start', { startedMarker: MARKER, startedTimeoutSeconds: 1 }), readiness, cmd('after', 'true', { needs: ['start'] })], { finallyCommands: [cmd('logs')] })
      const said = 'devpanel-started: service start did not start: marker .devpanel-service-pid is missing after the bound of 1 s and its unit is active'
      t.eq('a service that never writes it fails the drive', never.result.result, 'failed', never.result.error)
      const failed = never.result.commands.find((c) => c.id === 'start')
      t.eq('at the start command', [failed.passed, failed.exitCode, failed.timedOut], [false, 1, false])
      t.ok('whose record names the marker and the bound', failed.stderr.includes(said), failed.stderr)
      t.ok('as does its log', (await never.log('start')).includes(said))
      t.eq('readiness never ran', never.result.commands.map((c) => c.id), ['start', 'logs'])
      t.eq('and is recorded as skipped because of the start, also when it declares needs', never.result.skipped, [{ id: 'readiness', required: true, reason: 'an earlier required command failed' }, { id: 'after', required: true, reason: 'needs start, which failed' }])
      t.eq('the failed start\'s service is stopped and the candidate removed', await left(never.target), [])

      const tight = await driveOf([service('start', { startedMarker: MARKER, startedTimeoutSeconds: 1, timeoutSeconds: 2 }), readiness])
      const tightStart = tight.result.commands[0]
      t.eq('a timeout barely above the bound cannot cut the wait short', [tightStart.passed, tightStart.exitCode, tightStart.timedOut], [false, 1, false], JSON.stringify(tightStart))
      t.ok('the diagnostic is on its record and in its log', tightStart.stderr.includes(said) && (await tight.log('start')).includes(said), tightStart.stderr)
      t.ok('and the bound was honoured, not cut short', tightStart.durationMs >= 1000, String(tightStart.durationMs))
      const shortTimeout = await driveOf([service('start', { startedMarker: MARKER, startedTimeoutSeconds: 30, timeoutSeconds: 1, run: writesAfter(2) }), readiness])
      t.eq('a marker later than timeoutSeconds but within the bound still starts', [shortTimeout.result.result, ...shortTimeout.result.commands.map((c) => c.passed)], ['passed', true, true], JSON.stringify(shortTimeout.result.commands))

      await forget()
      const optional = await driveOf([service('start', { required: false, startedMarker: MARKER, startedTimeoutSeconds: 1 }), { ...readiness, join: 'start' }, cmd('plain', 'true', { required: false })])
      const optionalStart = optional.result.commands[0]
      t.ok('an optional service that never writes it carries the diagnostic on its record and log', !optionalStart.passed && optionalStart.stderr.includes(said) && (await optional.log('start')).includes(said), optionalStart.stderr)
      t.eq('a joining readiness is skipped, naming the start, and never executed', [optional.result.skipped, (await executed()).filter((id) => id === 'readiness')], [[{ id: 'readiness', required: true, reason: 'needs start, which failed' }, { id: 'plain', required: false, reason: 'an earlier required command failed' }], []])
      t.eq('a required command skipped behind it fails the drive, rather than passing unrun', optional.result.result, 'failed')
      const optionalAll = await driveOf([service('start', { required: false, startedMarker: MARKER, startedTimeoutSeconds: 1 }), cmd('needer', `cat ${MARKER}`, { required: false, needs: ['start'] }), cmd('independent')])
      t.eq('with only optional dependents, the others still run and the drive stands', [optionalAll.result.result, optionalAll.result.commands.map((c) => c.id), optionalAll.result.skipped.map((s) => s.id)], ['passed', ['start', 'independent'], ['needer']], JSON.stringify(optionalAll.result.commands))

      const ended = await driveOf([service('start', { startedMarker: MARKER, startedTimeoutSeconds: 60, run: 'exit 3' }), readiness])
      t.ok('a unit that ends first fails at once, naming the marker and the bound', ended.result.commands[0].durationMs < 30000 && ended.result.commands[0].stderr.includes('its unit is inactive and marker .devpanel-service-pid is missing (bound 60 s)'), JSON.stringify(ended.result.commands[0]))

      const stale = await driveOf([service('start', { startedMarker: 'source.txt' }), readiness])
      t.ok('a marker the candidate already holds proves nothing and fails the start', stale.result.result === 'failed' && stale.result.commands[0].stderr.includes('marker source.txt already exists before the start'), JSON.stringify(stale.result.commands[0]))

      const target = await targetOf([service('start', { startedMarker: MARKER, startedTimeoutSeconds: 30, run: writesAfter(1) }), readiness, cmd('deep', `cat ${MARKER}`)], ['start', 'readiness'])
      const { smoke, full, ran } = await smokeThenFull(target)
      t.eq('a continued full drive carries the start the smoke proved, without starting it again', [full.result, full.commands.find((c) => c.id === 'start').fromSmoke, ran], ['passed', smoke.dir, ['deep']], full.error)
    }

    t.section('a prefix tier: only the commands after the smoke run, on its instance')
    {
      const target = await targetOf([cmd('prepare'), service(), cmd('readiness'), cmd('deep')], ['prepare', 'start', 'readiness'], { finallyCommands: [cmd('logs')] })
      const { smoke, instance, full, ran, dir } = await smokeThenFull(target)
      t.eq('the smoke passed', smoke.result, 'passed', smoke.error)
      t.eq('the full drive passed', full.result, 'passed', full.error ?? JSON.stringify(full.commands.filter((c) => !c.passed)))
      t.eq('it executed the later command and the finalizer only', ran, ['deep', 'logs'])
      t.eq('on the smoke\'s directory', full.continuedFrom?.remoteDir, instance.remoteDir)
      t.eq('the record says which drive it continued', full.continuedFrom?.dir, smoke.dir)
      t.eq('the record lists what the smoke ran and what this drive ran', [full.continuedFrom?.smokeRun, full.continuedFrom?.ran], [['prepare', 'start', 'readiness'], ['deep']])
      t.eq('nothing ran out of position', full.continuedFrom?.outOfPosition, [])
      t.eq('the record is the full drive\'s, in declared order', full.commands.map((c) => c.id), ['prepare', 'start', 'readiness', 'deep', 'logs'])
      t.ok('the smoke\'s commands are marked as carried', full.commands.filter((c) => c.fromSmoke === smoke.dir).length === 3)
      t.ok('the carried logs are in this drive\'s directory', (await Promise.all(['prepare', 'start', 'readiness'].flatMap((id) => [`${id}.log`, `${id}.stdout`]).map((f) => fs.access(path.join(dir, full.dir, f)).then(() => true, () => false)))).every(Boolean))
      t.ok('the service ran once: the same start throughout', full.continuedFrom?.services?.[0]?.invocationId === instance.services[0].invocationId && Boolean(instance.services[0].invocationId))
      t.eq('the materialization says where the candidate came from', full.materialization.method, 'smoke-instance')
      t.eq('the candidate was checked before and after', [full.materialization.beforeCommands?.modified, full.materialization.afterCommands?.modified], [0, 0])
      t.eq('the expiry timer is disarmed', await fs.access(unitFile(`${expiryUnit(instance.remoteDir)}.timer`)).then(() => true, () => false), false)
      t.eq('the normal end took the instance', await left(target), [])
      const started = JSON.parse(await fs.readFile(unitFile(startUnit(instance)), 'utf8').catch(() => '{}'))
      t.ok('and its service', !started.pid || !(await fs.readFile(`/proc/${started.pid}/stat`, 'utf8').then((s) => !s.slice(s.lastIndexOf(')') + 2).startsWith('Z'), () => false)))
    }

    t.section('a non-prefix tier continues too: its command runs late, and the record says so')
    {
      const target = await targetOf([cmd('prepare'), cmd('lint'), service(), cmd('readiness'), cmd('selftest')], ['prepare', 'start', 'readiness'], { finallyCommands: [cmd('logs')] })
      const { full, ran } = await smokeThenFull(target)
      t.eq('it passed', full.result, 'passed', full.error)
      t.eq('exactly the commands the smoke did not run, in declared order, then the finalizers', ran, ['lint', 'selftest', 'logs'])
      t.eq('its records are in declared order', full.commands.map((c) => c.id), ['prepare', 'lint', 'start', 'readiness', 'selftest', 'logs'])
      t.eq('the commands the smoke ran', full.continuedFrom?.smokeRun, ['prepare', 'start', 'readiness'])
      t.eq('the commands this drive ran', full.continuedFrom?.ran, ['lint', 'selftest'])
      t.eq('which ran out of position', full.continuedFrom?.outOfPosition, [{ id: 'lint', declaredBefore: ['start', 'readiness'] }])
      t.eq('which ran after a service it was declared before', full.continuedFrom?.declaredBeforeServices, ['lint'])
      t.eq('nothing is left', await left(target), [])
    }

    t.section('a smoke\'s only addition being finalizers: the drive continues and runs just those')
    {
      const target = await targetOf([cmd('prepare'), service()], ['prepare', 'start'], { finallyCommands: [cmd('collect-report')] })
      const { full, ran } = await smokeThenFull(target)
      t.eq('only the finalizer ran', ran, ['collect-report'])
      t.eq('it passed on the smoke\'s records', full.result, 'passed', full.error)
      t.eq('no command of its own', full.continuedFrom?.ran, [])
    }

    t.section('auditor-1\'s scenario: an inherited failure gets the verdict and the gate a fresh drive gets')
    {
      const target = await targetOf([cmd('prepare'), cmd('lint', FAILS), service(), cmd('readiness')], ['prepare', 'start', 'readiness'])
      const dir = await temp('cc-run-')
      const fullTarget = tierTarget(target, 'full')
      const base = { ...await drive(fullTarget, dir, { revision: null, base: true, dirName: 'base-a' }), sourceRevision: ws.baseCommit }
      const judge = async (check) => {
        const failures = await compareFailures({ runDir: dir, target: fullTarget, base, candidate: check, sourceRevision: ws.baseCommit })
        return { verdict: failures.verdict, notRun: failures.notRun, gate: gatingResult({ ...check, baselineComparison: { failures } }, { workspace: { baseCommit: ws.baseCommit } }) }
      }
      const { full: continued, ran, smoke } = await smokeThenFull(target, { runDir: dir })
      const fresh = await drive(fullTarget, dir)
      t.eq('only lint executed on the instance', ran, ['lint'])
      t.eq('a fresh drive: not made, start and readiness not run, gate failed', await judge(fresh), { verdict: 'not-made', notRun: ['start', 'readiness'], gate: 'failed' })
      t.eq('the continued drive: the same', await judge(continued), { verdict: 'not-made', notRun: ['start', 'readiness'], gate: 'failed' })
      t.eq('the same records', continued.commands.map((c) => c.id), fresh.commands.map((c) => c.id))
      t.eq('the same skips, with the same reasons', continued.skipped, fresh.skipped)
      t.eq('the smoke\'s logs are named, as not counted', continued.continuedFrom?.notCounted?.map(({ id, dir: from, log }) => [id, from, log]), [['start', smoke.dir, 'start.log'], ['readiness', smoke.dir, 'readiness.log']])
      t.ok('their real logs stay with the smoke', await fs.access(path.join(dir, smoke.dir, 'start.log')).then(() => true, () => false))
      t.ok('and are not in this drive\'s directory', !(await fs.access(path.join(dir, continued.dir, 'start.stdout')).then(() => true, () => false)))
    }

    t.section('the same outcomes give the same records, verdict and gate as a fresh drive')
    const REPORT = 'echo "== runtime/selftest.report"; printf \'{"tests":[{"test":"core/a"}]}\\n\''
    const onCandidate = 'test ! -f value.txt'
    const rows = [
      ['a later command fails', [cmd('prepare'), service(), cmd('readiness'), cmd('deep', onCandidate)], ['prepare', 'start', 'readiness']],
      ['an out-of-position optional command fails', [cmd('prepare'), cmd('lint', FAILS, { required: false }), service(), cmd('readiness')], ['prepare', 'start', 'readiness']],
      ['a required failure, then smoke commands whose needs are met', [cmd('prepare'), cmd('lint', FAILS), service('start', { needs: ['prepare'] }), cmd('readiness', 'true', { needs: ['prepare'] })], ['prepare', 'start', 'readiness']],
      ['a required failure, then a smoke command whose needs are not met', [cmd('prepare'), cmd('lint', FAILS), service(), cmd('readiness', 'true', { needs: ['start'] })], ['prepare', 'start', 'readiness']],
      ['a command that joins a skipped service', [cmd('prepare'), cmd('lint', FAILS), service(), cmd('selftest', 'true', { join: 'start', needs: ['prepare'] })], ['prepare', 'start']],
      ['a failed optional smoke command another needs', [cmd('prepare'), service(), cmd('optional', 'exit 1', { required: false }), cmd('lint', FAILS), cmd('dependent', 'true', { needs: ['optional'] })], ['prepare', 'start', 'optional', 'dependent']],
      ['a selftest report on a smoke command', [cmd('prepare'), service(), cmd('collect', REPORT, { report: 'selftest' }), cmd('deep')], ['prepare', 'start', 'collect']]
    ]
    for (const [label, commands, smokeIds] of rows) {
      const target = await targetOf(commands, smokeIds, { finallyCommands: [cmd('logs')] })
      const dir = await temp('cc-run-')
      const fullTarget = tierTarget(target, 'full')
      const base = { ...await drive(fullTarget, dir, { revision: null, base: true, dirName: 'base-r' }), sourceRevision: ws.baseCommit }
      const read = async (check) => {
        const failures = check.result === 'failed' ? await compareFailures({ runDir: dir, target: fullTarget, base, candidate: check, sourceRevision: ws.baseCommit }) : null
        const selftest = await compareSelftestReports({ runDir: dir, target: fullTarget, base, candidate: check, sourceRevision: ws.baseCommit })
        return { result: check.result, commands: check.commands.map((c) => [c.id, c.passed]), skipped: check.skipped ?? [], verdict: failures?.verdict ?? null, notRun: failures?.notRun ?? null, selftest: selftest?.verdict ?? null,
          gate: gatingResult({ ...check, baselineComparison: { ...(failures ? { failures } : {}), ...(selftest ? { selftest } : {}) } }, { workspace: { baseCommit: ws.baseCommit } }) }
      }
      const { full: continued } = await smokeThenFull(target, { runDir: dir })
      const fresh = await drive(fullTarget, dir)
      t.ok(`${label}: it did continue`, Boolean(continued.continuedFrom), JSON.stringify(continued.continuation))
      t.eq(`${label}: as a fresh drive`, await read(continued), await read(fresh))
    }

    t.section('a smoke service the drive skips is stopped before the finalizers, which find what they would in a fresh drive')
    {
      const up = cmd('service-up', 'true', { join: 'start', required: false })
      const target = await targetOf([cmd('prepare'), cmd('lint', FAILS), service(), cmd('readiness')], ['prepare', 'start', 'readiness'], { finallyCommands: [up] })
      const { full, instance } = await smokeThenFull(target)
      t.eq('confirmed stopped', full.materialization.skippedServicesStopped, { units: [startUnit(instance)], confirmed: true, stderr: full.materialization.skippedServicesStopped?.stderr })
      t.eq('a finalizer joining it fails', full.commands.find((c) => c.id === 'service-up')?.passed, false)
      t.eq('the drive still judged the required failure', full.result, 'failed')
    }

    t.section('fallback: what cannot be proved runs from scratch, and says why')
    const STANDARD = () => targetOf([cmd('prepare'), service(), cmd('readiness'), cmd('deep')], ['prepare', 'start', 'readiness'])
    const faults = [
      ['the service died', 'service-not-active', async (i) => { const { pid } = JSON.parse(await fs.readFile(unitFile(startUnit(i)), 'utf8')); process.kill(-pid, 'SIGKILL'); await sleep(200) }],
      ['the service was started again', 'unit-identity-changed', async (i) => { const f = unitFile(startUnit(i)); const entry = JSON.parse(await fs.readFile(f, 'utf8')); await fs.writeFile(f, JSON.stringify({ ...entry, invocationId: 'another-start' })) }],
      ['the keep window ended', 'expired', async (i) => { await fireTimer(shimDir, expiryUnit(i.remoteDir)) }],
      ['the candidate directory is gone', 'instance-gone', async (i) => { await fs.rm(i.remoteDir, { recursive: true, force: true }) }],
      ['the host could not answer', 'unreadable', async () => { await fs.writeFile(flag('ssh-down'), '') }],
      ['the candidate changed between smoke and full', 'candidate-changed', async (i) => { await fs.writeFile(path.join(i.remoteDir, 'value.txt'), 'tampered' + NL) }]
    ]
    for (const [label, reason, fault] of faults) {
      const target = await STANDARD()
      const { full, ran, instance } = await smokeThenFull(target, { between: fault })
      await fs.rm(flag('ssh-down'), { force: true })
      t.eq(`${label}: says why`, full.continuation?.reason, reason, JSON.stringify(full.continuation))
      t.ok(`${label}: no continuedFrom`, !full.continuedFrom)
      t.eq(`${label}: ran from scratch, in declared order`, ran, ['prepare', 'start', 'readiness', 'deep'])
      t.eq(`${label}: a plain passing full drive`, full.result, 'passed', full.error)
      t.ok(`${label}: on a directory of its own`, !full.commands.some((c) => c.fromSmoke) && Boolean(full.materialization.archiveSha256))
      t.eq(`${label}: the old instance is gone with this one`, await left(target), [], instance.remoteDir)
    }

    t.section('files a command added do not stop a continuation; the candidate\'s own do')
    {
      const target = await STANDARD()
      const { full } = await smokeThenFull(target, { between: async (i) => { await fs.writeFile(path.join(i.remoteDir, 'runtime-output.txt'), 'added' + NL) } })
      t.ok('an added file: it continued', Boolean(full.continuedFrom), JSON.stringify(full.continuation))
      t.eq('and counted the addition', full.materialization.beforeCommands?.added, 1)
    }

    t.section('logs that cannot be carried: from scratch, and the instance is removed')
    {
      const target = await STANDARD()
      const dir = await temp('cc-run-')
      const { full } = await smokeThenFull(target, { runDir: dir, between: async () => { await fs.rm(path.join(dir, 'checks', '001', 'prepare.stdout')) } })
      t.eq('says why', full.continuation?.reason, 'unreadable', JSON.stringify(full.continuation))
      t.eq('a plain passing drive', full.result, 'passed', full.error)
      t.eq('nothing is left', await left(target), [])
    }

    t.section('an instance is kept only when it is proved quiet, listed and armed; otherwise the ordinary end')
    {
      const notKept = async (label, target, expected, setup = null) => {
        const dir = await temp('cc-run-')
        await setup?.()
        const { smoke } = await smokeOf(target, dir)
        t.ok(`${label}: not kept`, !smoke.kept, JSON.stringify(smoke.kept))
        t.ok(`${label}: says why`, expected.test(smoke.instanceNotKept ?? ''), smoke.instanceNotKept)
        return smoke
      }
      const failed = await STANDARD()
      failed.commands[2] = cmd('readiness', 'exit 2')
      t.eq('a failed smoke stays failed', (await notKept('a failed smoke', failed, /did not finish normally/)).result, 'failed')
      t.eq('and removes its instance', await left(failed), [])

      const finalizer = await targetOf([cmd('prepare'), service()], ['prepare', 'start', 'logs'], { finallyCommands: [cmd('logs', 'exit 1')] })
      t.eq('a failed required finalizer: as today', (await notKept('a failed required finalizer', finalizer, /did not finish normally/)).result, 'unavailable')

      const pidFile = path.join(shimDir, 'service.pid')
      const stopping = await targetOf([cmd('prepare'), { id: 'start', kind: 'candidate', service: true, run: `echo $$ > ${pidFile}; exec sleep 120` }], ['prepare', 'start', 'stop-it'], { finallyCommands: [cmd('stop-it', `kill "$(cat ${pidFile})"; sleep 0.3`)] })
      const stopped = await notKept('a finalizer that stopped the service', stopping, /service start is not active/)
      t.eq('and the smoke still passed', stopped.result, 'passed', stopped.error)

      // 124 is how a remote command's own time limit reads (checks.mjs runOne).
      const timedOut = await targetOf([cmd('prepare'), service(), cmd('slow', 'exit 124', { required: false })], ['prepare', 'start', 'slow'])
      await notKept('an optional command that timed out', timedOut, /slow did not finish normally/)

      const arming = await STANDARD()
      const unarmed = await notKept('a timer that could not be armed', arming, /expiry timer could not be armed/, () => fs.writeFile(flag('fail-arm'), ''))
      await fs.rm(flag('fail-arm'), { force: true })
      t.eq('the smoke keeps its result', unarmed.result, 'passed', unarmed.error)
      t.eq('and its ordinary cleanup', await left(arming), [])

      const noService = await targetOf([cmd('prepare'), cmd('deep')], ['prepare'])
      await notKept('a smoke with no service', noService, /no service/)
    }

    t.section('only a smoke that may be continued outlives its lifetime; every other drive keeps it')
    {
      const target = await targetOf([cmd('prepare'), service('start', { lifetimeSeconds: 100 }), cmd('deep')], ['prepare', 'start'], { tiers: { keepSeconds: 60 } })
      const dir = await temp('cc-run-')
      const { instance } = await smokeOf(target, dir)
      const limit = async (unit) => (await invocations()).filter((i) => i.unit === unit).at(-1)?.args.find((a) => a.startsWith('--property=RuntimeMaxSec='))
      t.eq('the kept smoke: lifetime plus keep window', await limit(startUnit(instance)), '--property=RuntimeMaxSec=160s')
      const timer = (await invocations()).filter((i) => i.unit === expiryUnit(instance.remoteDir)).at(-1)
      t.ok('the timer waits the keep window', timer?.args.includes('--on-active=60s'), JSON.stringify(timer?.args?.slice(0, 6)))
      await fireTimer(shimDir, expiryUnit(instance.remoteDir))
      t.eq('a fired timer removes the instance without the panel', await left(target), [])
      const fresh = await drive(tierTarget(target, 'full'), dir)
      const freshStart = (await invocations()).filter((i) => i.args.includes('--property=RuntimeMaxSec=100s')).at(-1)
      t.eq('a fresh full drive: the plain lifetime', Boolean(freshStart), true, JSON.stringify(fresh.error))
    }

    t.section('continuationPlan: what the panel can say before anything runs')
    {
      const plan = (commands, smoke, extra = {}, kind = 'ssh') => continuationPlan({ kind, commands, tiers: { smoke, ...extra } })
      const a = { id: 'a', kind: 'candidate' }; const b = { id: 'b', kind: 'candidate' }; const s = { id: 's', kind: 'candidate', service: true }; const z = { id: 'z', kind: 'candidate' }
      t.eq('no tiers: nothing to continue', continuationPlan({ kind: 'ssh', commands: [a] }), null)
      t.eq('a prefix', [plan([a, s, z], ['a', 's']).run, plan([a, s, z], ['a', 's']).outOfPosition, plan([a, s, z], ['a', 's']).refusal], [['z'], [], null])
      const gap = plan([a, b, s, z], ['s', 'a'])
      t.eq('the order inside tiers.smoke does not matter', gap.smokeRun, ['a', 's'])
      t.eq('a command between smoke commands runs after them', [gap.run, gap.outOfPosition, gap.declaredBeforeServices], [['b', 'z'], [{ id: 'b', declaredBefore: ['s'] }], ['b']])
      t.eq('before a plain smoke command only, not a service', plan([s, b, a], ['s', 'a']).declaredBeforeServices, [])
      t.eq('only finalizers added', plan([a, s], ['a', 's']).run, [])
      t.eq('no service', plan([a, z], ['a']).refusal, 'no-service')
      t.eq('a local target', plan([a, s], ['a', 's'], {}, 'local').refusal, 'local-target')
      t.eq('opted out', plan([a, s], ['a', 's'], { continueSmoke: false }).refusal, 'opted-out')
      t.eq('the keep window has a default and can be set', [plan([s], ['s']).keepSeconds, plan([s], ['s'], { keepSeconds: 60 }).keepSeconds], [1800, 60])
    }

    t.section('a report carried from the smoke leaves no second line in the selftest history')
    {
      const dir = await temp('cc-run-')
      const issuePath = path.join(await temp('cc-issues-'), 'proj', 'issue')
      await fs.mkdir(path.join(dir, 'checks', 'c'), { recursive: true })
      await fs.writeFile(path.join(dir, 'checks', 'c', 'collect.stdout'), '== runtime/selftest.report\n{"tests":[{"test":"core/a"}]}\n')
      const stability = openStability({ issuePath, runId: 'r', target: { commands: [{ id: 'collect', report: 'selftest' }] }, targetKey: 'k', clock: { now: () => Date.now() }, runDir: dir })
      const check = (extra) => ({ dir: 'checks/c', at: new Date().toISOString(), result: 'passed', commands: [{ id: 'collect', passed: true, ...extra }] })
      await stability.record({ check: check({ fromSmoke: 'checks/s' }), kind: 'candidate', revision: 'r1', baseCommit: 'b' })
      t.eq('carried: nothing recorded', await fs.readdir(historyDir(issuePath)).catch(() => []), [])
      await stability.record({ check: check({}), kind: 'candidate', revision: 'r1', baseCommit: 'b' })
      t.ok('run by this drive: recorded', (await fs.readdir(historyDir(issuePath))).length > 0)
      t.eq('and nothing broke', stability.historyError, null)
    }
  } finally {
    process.env.DEVPANEL_SSH_BIN = saved.bin; process.env.CHECK_TEST_HOST = saved.host
    if (saved.bin === undefined) delete process.env.DEVPANEL_SSH_BIN
    if (saved.host === undefined) delete process.env.CHECK_TEST_HOST
    // Any service a failed assertion left behind.
    for (const name of await fs.readdir(unitsDir).catch(() => [])) {
      if (!name.endsWith('.json')) continue
      const { pid } = JSON.parse(await fs.readFile(path.join(unitsDir, name), 'utf8').catch(() => '{}'))
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
    }
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
