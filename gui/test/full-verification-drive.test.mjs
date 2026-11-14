import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { cycleGate, driveFiles, fullVerificationDrive, instanceCycleTarget, notOnInstanceOf, previousGreen, suiteRanOf } from '../server/runtime/full-verification-drive.mjs'
import { driveCommands } from '../server/runtime/instance-drive.mjs'

export const name = 'full verification drive — the full tier on the snapshot, judged against the previous green cycle'

const target = { kind: 'ssh', tier: 'full', commands: [{ id: 'selftest', run: 'selftest', required: true, report: 'selftest' }] }
const report = (tests) => `== /opt/app/selftest.report\n${JSON.stringify(tests)}\n`

/** A runChecks stand-in: writes the drive's report where the real one would and returns its record. */
const driveWith = (tests, result = 'passed') => async ({ runDir, dirName, baseCommit }) => {
  const dir = path.join(runDir, 'checks', dirName)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'selftest.stdout'), report(tests))
  await fs.writeFile(path.join(dir, 'selftest.log'), '$ selftest\n')
  return { result, dir: path.join('checks', dirName), baseCommit, commands: [{ id: 'selftest', run: 'selftest', passed: result === 'passed', exitCode: result === 'passed' ? 0 : 1, log: 'selftest.log' }] }
}

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fv-drive-'))
  try {
    const verificationDir = path.join(root, '.verification')
    const workspace = { path: root, baseCommit: 'today' }
    const runDirOf = async (name) => { const d = path.join(root, 'runs', name); await fs.mkdir(d, { recursive: true }); return d }
    const drive = (tests, runId, result) => runDirOf(runId).then((runDir) => fullVerificationDrive({ target, workspace, runDir, runId, project: 'app-project', stage: 'stage', verificationDir, clock: null, drive: driveWith(tests, result) }))

    t.section('1. no previous green cycle: a clean drive passes, any failure is red')
    {
      const clean = await drive([{ test: 'mod/one' }], 'first-clean')
      t.eq('clean, nothing to compare with', [clean.gating, clean.baseline], ['passed', null])
      const failing = await drive([{ test: 'mod/one', error: 'boom' }], 'first-failing')
      t.eq('a failure cannot be called inherited without a green cycle', failing.gating, 'failed')
    }

    t.section('2. against the previous green cycle: an inherited failure passes, a new one is red')
    {
      // Yesterday's green cycle, whose drive failed mod/old already.
      const previousRunDir = await runDirOf('yesterday')
      const previous = await driveWith([{ test: 'mod/old', error: 'known' }, { test: 'mod/one' }])({ runDir: previousRunDir, dirName: 'full-verification', baseCommit: 'yesterday-commit' })
      await fs.writeFile(path.join(previousRunDir, 'run.json'), JSON.stringify({ runId: 'yesterday', fullVerification: { check: { result: previous } } }))
      const files = await driveFiles(previousRunDir, previous)
      await fs.mkdir(path.join(verificationDir, '2026-11-06'), { recursive: true })
      await fs.writeFile(path.join(verificationDir, '2026-11-06', 'cycle.json'), JSON.stringify({ id: '2026-11-06.1', projects: [
        { project: 'app-project', stage: 'stage', verdict: 'green', runId: 'yesterday', runDir: previousRunDir, check: { dir: previous.dir, baseCommit: 'yesterday-commit', files } },
        { project: 'other-project', stage: 'stage', verdict: 'green', runId: 'elsewhere', runDir: previousRunDir, check: { dir: previous.dir, files } }
      ] }))
      const inherited = await drive([{ test: 'mod/old', error: 'known' }, { test: 'mod/one' }], 'today-inherited')
      t.eq('the previous green cycle of this stage is the baseline', inherited.baseline, { cycleId: '2026-11-06.1', runId: 'yesterday', baseCommit: 'yesterday-commit' })
      t.eq('an inherited failure does not make the stage red', [inherited.selftest.verdict, inherited.gating], ['baseline-known', 'passed'])
      const fresh = await drive([{ test: 'mod/old', error: 'known' }, { test: 'mod/one', error: 'new today' }], 'today-new')
      t.eq('a new failure does', [fresh.selftest.verdict, fresh.selftest.newFailures.map((f) => f.test), fresh.gating], ['new-failures', ['mod/one'], 'failed'])
      t.ok('the drive\'s files are hashed for the next cycle', typeof fresh.files['selftest.stdout'] === 'string')

      t.section('3. a baseline whose files changed since the cycle recorded them is not used')
      await fs.appendFile(path.join(previousRunDir, previous.dir, 'selftest.stdout'), 'tampered\n')
      const tampered = await drive([{ test: 'mod/old', error: 'known' }], 'today-tampered')
      t.ok('recorded as unusable', /changed since cycle 2026-11-06\.1/.test(tampered.baseline?.unusable ?? ''))
      t.eq('and the failure is red', tampered.gating, 'failed')
    }

    t.section('4. the gate itself')
    {
      t.eq('a drive that could not run is not passed', cycleGate({ result: 'unavailable' }), 'unavailable')
      t.eq('a failed drive with inherited failures passes', cycleGate({ result: 'failed' }, { failures: { verdict: 'baseline-known' }, selftest: { verdict: 'baseline-known' } }), 'passed')
      t.eq('a failed drive with a new selftest failure is red', cycleGate({ result: 'failed' }, { failures: { verdict: 'baseline-known' }, selftest: { verdict: 'new-failures' } }), 'failed')
    }

    t.section('5. the cycle on a stage instance: create, start, ready, the whole suite and browser run, collectors; every command names the instance')
    {
      const modules = {
        collections: ['@*'],
        lint: { id: 'lint', run: '/opt/stage-tools/lint.sh {{instance}} {{files}}' },
        load: { id: 'load', run: '/opt/stage-tools/load.sh {{instance}}' },
        restart: { id: 'restart', run: '/opt/stage-tools/reload.sh {{instance}}' },
        ready: { id: 'ready', run: '/opt/stage-tools/instance.sh ready {{instanceName}}' },
        test: { id: 'module-selftest', run: '/opt/stage-tools/selftest.sh {{instance}} {{filters}}' },
        finallyCommands: [{ id: 'collect-selftest-report', run: 'cat {{instance}}/runtime/selftest.report', report: 'selftest' }],
        instance: {
          root: '/opt/stage-instances',
          create: { run: '/opt/stage-tools/instance.sh create {{instanceName}} "$PWD"' },
          start: { run: '/opt/stage-tools/instance.sh start {{instanceName}}', busyExitCodes: [4] },
          destroy: { run: '/opt/stage-tools/instance.sh destroy {{instanceName}}' },
          fullSuite: {
            test: { id: 'full-suite', run: '/opt/stage-tools/full-suite.sh {{instance}}', timeoutSeconds: 3600 },
            browser: { id: 'full-browser', run: '/opt/stage-tools/browser-check.sh {{instance}}' },
            finallyCommands: [{ id: 'collect-log', run: 'cat {{instance}}/runtime/log/current/project.log' }]
          }
        }
      }
      const infra = { staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage', workdir: '/opt' }, projectRoot: '/opt/stage-base' }, testDrive: { modules } }
      const cycleTarget = instanceCycleTarget(infra, 'dp-fv-1')
      const fresh = driveCommands(cycleTarget, true)
      t.eq('a fresh drive: create, start, ready, the suite, the browser run', fresh.map((c) => c.id), ['instance-create', 'instance-start', 'ready', 'full-suite', 'full-browser'])
      t.eq('then the tier\'s collectors and the suite\'s', cycleTarget.finallyCommands.map((c) => c.id), ['collect-selftest-report', 'collect-log'])
      t.eq('the suite and the browser run each go on past their own failure', fresh.filter((c) => ['full-suite', 'full-browser'].includes(c.id)).map((c) => c.ownFailureContinues), [true, true])
      t.eq('the full tier, no lint, on the stage host', [cycleTarget.tier, cycleTarget.kind, fresh.some((c) => c.id === 'lint')], ['full', 'ssh', false])
      const every = [...fresh, ...cycleTarget.finallyCommands, cycleTarget.stageInstance.destroy]
      t.ok('every command names the cycle\'s instance', every.every((c) => c.run.includes('/opt/stage-instances/dp-fv-1') || c.run.includes('dp-fv-1')), every.map((c) => c.run).join(' | '))
      t.eq('none names the base instance', every.filter((c) => c.run.includes('/opt/stage-base')).map((c) => c.id), [])
      t.eq('no full suite declared: no target', instanceCycleTarget({ ...infra, testDrive: { modules: { ...modules, instance: { ...modules.instance, fullSuite: undefined } } } }, 'dp-x'), null)

      t.section('6. suiteRanOf: only the whole suite run to an answer, with a report that parses, proves the deliveries were tested')
      const dir = await runDirOf('suite-ran')
      const drive = path.join(dir, 'checks', 'full-verification')
      await fs.mkdir(drive, { recursive: true })
      const reportText = report({ tests: [{ test: 'a: works' }, { test: 'b: breaks', error: 'boom' }, { test: 'c: provider', skipped: 'external: no provider on an instance' }] })
      const rec = (id, passed, extra = {}) => ({ id, passed, exitCode: passed ? 0 : 1, ...extra })
      const ran = async ({ commands, skipped = [], files = {} }) => {
        await fs.rm(drive, { recursive: true, force: true })
        await fs.mkdir(drive, { recursive: true })
        for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(drive, name), text)
        return suiteRanOf({ runDir: dir, check: { dir: 'checks/full-verification', commands, skipped }, target: cycleTarget, suiteId: 'full-suite' })
      }
      const upTo = [rec('instance-create', true), rec('instance-start', true)]
      t.eq('ready failed, the suite skipped behind it: not run', await ran({ commands: [...upTo, rec('ready', false), rec('collect-selftest-report', true)], skipped: [{ id: 'full-suite', required: true }], files: { 'collect-selftest-report.stdout': reportText } }), null)
      t.eq('the suite timed out: not an answer', await ran({ commands: [...upTo, rec('ready', true), rec('full-suite', false, { timedOut: true, exitCode: 124 }), rec('collect-selftest-report', true)], files: { 'collect-selftest-report.stdout': reportText } }), null)
      const failedOwn = await ran({ commands: [...upTo, rec('ready', true), rec('full-suite', false), rec('collect-selftest-report', true)], files: { 'collect-selftest-report.stdout': reportText } })
      t.eq('the suite failed its own tests, its report parses: ran (a parsed report with failures, and no baseline at all)', [failedOwn?.command, failedOwn?.passed, failedOwn?.exitCode, failedOwn?.report.command], ['full-suite', false, 1, 'collect-selftest-report'])
      t.eq('the suite passed, its report did not parse: not proved', await ran({ commands: [...upTo, rec('ready', true), rec('full-suite', true), rec('collect-selftest-report', true)], files: { 'collect-selftest-report.stdout': 'no report here\n' } }), null)
      t.eq('the collector failed and printed nothing (a not-applicable entry, no unread one): not proved', await ran({ commands: [...upTo, rec('ready', true), rec('full-suite', true), rec('collect-selftest-report', false)], files: {} }), null)
      t.eq('the suite passed, its report parses: ran', (await ran({ commands: [...upTo, rec('ready', true), rec('full-suite', true), rec('collect-selftest-report', true)], files: { 'collect-selftest-report.stdout': reportText } }))?.passed, true)
      t.eq('tests the report skipped are named, with their reason: not on an instance by design', await notOnInstanceOf({ runDir: dir, check: { dir: 'checks/full-verification', commands: [rec('collect-selftest-report', true)] }, target: cycleTarget }),
        [{ command: 'collect-selftest-report', test: 'c: provider', reason: 'external: no provider on an instance' }])

      t.section('7. an instance drive is compared only with earlier instance drives')
      const records = path.join(root, '.verification-modes')
      await fs.mkdir(path.join(records, '2026-11-14'), { recursive: true })
      await fs.writeFile(path.join(records, '2026-11-14', 'cycle.json'), JSON.stringify({ id: '2026-11-14.1', projects: [{ project: 'app-project', stage: 'stage', verdict: 'green', runId: 'r1', runDir: '/x', check: { dir: 'checks/full-verification' } }] }))
      t.eq('a release entry (no mode) is no instance baseline', await previousGreen({ verificationDir: records, project: 'app-project', stage: 'stage', mode: 'instance' }), null)
      t.eq('it is a release baseline', (await previousGreen({ verificationDir: records, project: 'app-project', stage: 'stage' }))?.runId, 'r1')
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
