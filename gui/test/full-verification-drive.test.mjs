import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { cycleGate, driveFiles, fullVerificationDrive } from '../server/runtime/full-verification-drive.mjs'

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
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
