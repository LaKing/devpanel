import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { installRemoteManager } from './fakes/remote-manager.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { slotDirectory } from '../server/runtime/drive-slots.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { gitWorktreeProvider, releaseWorkspace, startRun } from '../server/runtime/launch.mjs'
import { acquire } from '../server/runtime/lock.mjs'

export const name = 'drive wait — a wait for a slot is never failed, and the wall clock does not count it'

const NL = String.fromCharCode(10)
const BUDGET = 240 * 60_000
const HOST = 'host-wait'

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  const until = async (label, check, ms = 20000) => {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const shimDir = await temp('dw-shim-')
  const managerEnv = await installRemoteManager(shimDir)
  await fs.mkdir(path.join(shimDir, 'units'))
  await fs.writeFile(path.join(shimDir, 'units', 'no-fence'), '')
  const state = await temp('dw-state-')
  const shim = path.join(shimDir, 'ssh')
  await fs.writeFile(shim, [
    '#!/bin/sh',
    `D='${state}'`,
    'if [ "$1" = -G ] && [ -e "$D/fail" ]; then echo "no config" >&2; exit 255; fi',
    managerEnv,
    'if [ -e "$D/down" ]; then echo "ssh: connect: refused" >&2; exit 255; fi',
    'for last; do :; done',
    'exec /bin/sh -c "$last"'
  ].join(NL) + NL, { mode: 0o755 })
  const savedBin = process.env.DEVPANEL_SSH_BIN
  process.env.DEVPANEL_SSH_BIN = shim

  /** A real engine (manual clock), and a drive of its candidate through the engine's own wait accounting. */
  const setup = async () => {
    const f = await engineFixture()
    const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath,
      harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.deliveryProvider })
    // Its own worktree: the engine here only keeps the books.
    const ws = await gitWorktreeProvider.create({ projectPath: f.projectPath, runId: 'drive-wait', root: await temp('dw-ws-'), policy: { base: 'head' } })
    const baseline = await baselineOf(ws.path)
    await fs.writeFile(path.join(ws.path, 'value.txt'), 'changed' + NL)
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    const slotsDir = await temp('dw-slots-')
    const hold = () => Promise.all([0, 1].map((n) => acquire(path.join(slotDirectory(HOST, slotsDir), `slot-${n}.lock`), { purpose: 'test' })))
    const drive = async (timing = {}) => runChecks({ baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, revision: fp.fingerprint, fingerprint: fp,
      runDir: await temp('dw-run-'), clock: f.clock, signal: engine.controller.signal, onDriveWait: (wait) => engine.noteDriveWait(wait),
      target: { kind: 'ssh', ssh: { hostRef: `ssh-config:${HOST}`, workdir: await temp('dw-remote-') }, commands: [{ id: 'run', run: 'true' }] },
      driveTiming: { slotsDir, pollMs: 10, retryMs: 10, attemptMs: 5000, windowMs: 30000, ...timing } })
    return { f, engine, hold, drive }
  }
  const releaseAll = (locks) => Promise.all(locks.map((lock) => lock.release()))

  try {
    t.section('a deadline falling during an unrecorded wait neither aborts nor fails the drive; the budget applies again after it')
    {
      const { f, engine, hold, drive } = await setup()
      const locks = await hold()
      const disarm = engine.armDeadline()
      const running = drive()
      await until('the drive to wait', () => engine.openDriveWaits.size === 1)
      t.eq('the wait is not on any result yet', engine.run.driveSlotWaits ?? [], [])
      f.clock.advance(BUDGET + 60_000)
      t.eq('the deadline fired and did not abort', engine.controller.signal.aborted, false)
      t.eq('budgetExceeded does not count the wait in progress', engine.budgetExceeded(), null)
      t.eq('it is still waiting', engine.openDriveWaits.size, 1)
      await releaseAll(locks)
      const result = await running
      t.eq('the drive passes', result.result, 'passed', result.error)
      t.ok('its wait is on the result', result.driveSlot.waitMs >= BUDGET + 60_000, JSON.stringify(result.driveSlot))
      t.eq('and on the run, closed', [engine.openDriveWaits.size, engine.run.driveSlotWaits.length], [0, 1])
      t.eq('the budget is not spent by it', engine.budgetExceeded(), null)
      f.clock.advance(BUDGET - 60_000)
      t.eq('the moved deadline has not come', engine.controller.signal.aborted, false)
      f.clock.advance(60_000 + 2000)
      t.eq('then it stops the run', [engine.controller.signal.aborted, engine.abortReason], [true, 'deadline'])
      t.eq('and budgetExceeded says so', engine.budgetExceeded(), 'wallClockMinutes')
      disarm()
      await releaseWorkspace(engine)
    }

    t.section('a stop during a wait gives cancelled, and closes the entry')
    {
      const { engine, hold, drive } = await setup()
      const locks = await hold()
      const running = drive()
      await until('the drive to wait', () => engine.openDriveWaits.size === 1)
      engine.cancel('requested')
      const result = await running
      t.eq('cancelled, unavailable', [result.result, result.error], ['unavailable', 'cancelled'])
      t.eq('the entry is closed', [engine.openDriveWaits.size, engine.run.driveSlotWaits.length], [0, 1])
      await releaseAll(locks)
      await releaseWorkspace(engine)
    }

    t.section('a stop during resolving gives cancelled, and closes the entry')
    {
      const { engine, drive } = await setup()
      await fs.writeFile(path.join(state, 'fail'), '')
      const running = drive()
      await until('the drive to wait on its host', () => engine.openDriveWaits.size === 1)
      engine.cancel('requested')
      const result = await running
      await fs.rm(path.join(state, 'fail'))
      t.eq('cancelled, unavailable', [result.result, result.error], ['unavailable', 'cancelled'])
      t.eq('the entry is closed', [engine.openDriveWaits.size, engine.run.driveSlotWaits.length], [0, 1])
      t.eq('it never had a host', result.driveSlot.host, null)
      await releaseWorkspace(engine)
    }

    t.section('a pinned connection that fails is an ordinary SSH failure, and the slot is free')
    {
      const { engine, hold, drive } = await setup()
      await fs.writeFile(path.join(state, 'down'), '')
      const result = await drive()
      await fs.rm(path.join(state, 'down'))
      t.eq('unavailable', result.result, 'unavailable')
      t.ok('with what SSH said', /refused/.test(result.error), result.error)
      await releaseAll(await hold())
      await releaseWorkspace(engine)
    }
  } finally {
    if (savedBin === undefined) delete process.env.DEVPANEL_SSH_BIN; else process.env.DEVPANEL_SSH_BIN = savedBin
    await cleanupFixtures()
    for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
