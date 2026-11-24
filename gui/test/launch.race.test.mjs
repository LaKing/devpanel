import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resumeRun, startRun, releaseOwnership } from '../server/runtime/launch.mjs'
import { withLock } from '../server/runtime/lock.mjs'
import * as store from '../server/runtime/store.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * AC1: resumeRun takes the run lock before it reads run.json and the baseline.
 * The interleaving is injected at the one awaited call both versions reach
 * inside resumeRun's acquire before the lock is published: the write of the
 * lock's temp file (lock.mjs createWith). No sleeps order it.
 */
const P = 'devpanel-project'
const LOCK_TEMP = /^\.run\.lock\.\d+\.[0-9a-f-]{36}\.tmp$/

export default async function (t) {
  t.section('R1. a writer that held the run lock until just before the resume took it is read, not lost')
  {
    const f = await engineFixture()
    const engine = await startRun({ ...f, issue: { ...f.issue, project: P }, issuePath: f.issuePath, stepStore: f.stepStore, deliveryProvider: f.delivery })
    await engine.drive()
    await releaseOwnership(engine)
    const lockFile = path.join(f.issuePath, '.run.lock')
    const runId = engine.runId

    let entered = 0
    let wFailed = null
    const real = fs.writeFile
    fs.writeFile = async (target, ...rest) => {
      if (!entered && typeof target === 'string' && LOCK_TEMP.test(path.basename(target))) {
        entered++
        // W: holds the run lock, writes run.json and the baseline, releases.
        // Its own lock temp write passes straight through (the hook has been entered).
        await withLock(lockFile, { purpose: 'w' }, async () => {
          const run = await store.readRun(f.issuePath, runId)
          delete run.journal
          await store.writeRun(f.issuePath, runId, { ...run, marker: 'W' })
          const baseline = (await store.readBaseline(f.issuePath, runId)) ?? new Map()
          await store.writeBaseline(f.issuePath, runId, new Map([...baseline, ['w-marker', 'h']]))
        }).catch((error) => { wFailed = error })
      }
      return real(target, ...rest)
    }
    let resumed
    try {
      resumed = await resumeRun({ issuePath: f.issuePath, runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
    } finally { fs.writeFile = real }
    t.eq('the seam was entered once', entered, 1)
    t.eq('W completed', wFailed?.message ?? null, null)
    t.ok('the resumed engine holds the run lock', Boolean(resumed.runLock?.token) && JSON.parse(await fs.readFile(lockFile, 'utf8')).token === resumed.runLock.token)
    t.eq('the resumed engine read W\'s run.json', resumed.run.marker ?? null, 'W')
    t.eq('the resumed engine read W\'s baseline', resumed.baseline.get('w-marker') ?? null, 'h')
    await resumed.runLock?.release()
  }

  t.section('R1b. regression guard: a resume of a folder that has gone fails and brings nothing back')
  {
    const gone = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-resume-gone-')), 'issue')
    const refused = await resumeRun({ issuePath: gone, runId: '2026-01-01T00-00-00-000Z-abcdef12', harnesses: {} }).then(() => null, (error) => error)
    t.ok('the resume is refused', refused instanceof Error)
    t.ok('the folder is not recreated', !await fs.stat(gone).then(() => true, () => false))
  }

  await cleanupFixtures()
}
