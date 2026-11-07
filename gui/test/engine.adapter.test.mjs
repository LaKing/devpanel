import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { runProcess, alive } from '../server/runtime/process.mjs'
import { createAvailabilityStore } from '../server/runtime/failure.mjs'
import { engineFixture, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

export const name = 'engine ↔ adapter — the wiring between them, through real adapters'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const STUBBORN = path.join(HERE, 'fakes/cli/stubborn.mjs')
const NL = String.fromCharCode(10)

const temps = []
async function temp () {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'eng-adapter-'))
  temps.push(d)
  return d
}

/** A shim standing in for an installed CLI, recording exactly how it was called. */
async function shim ({ mode = 'ok', shape = 'claude', record, env = {} }) {
  const file = path.join(await temp(), 'cli')
  await fs.writeFile(file, [
    '#!/bin/sh',
    `export AGENT_MODE='${mode}'`,
    `export AGENT_SHAPE='${shape}'`,
    `export AGENT_RECORD='${record}'`,
    ...Object.entries(env).map(([k, v]) => `export ${k}='${v}'`),
    `exec "${process.execPath}" "${AGENT}" "$@"`
  ].join(NL) + NL)
  await fs.chmod(file, 0o755)
  return file
}

const readRecord = async (file) =>
  (await fs.readFile(file, 'utf8').catch(() => '')).split(NL).filter(Boolean).map((l) => JSON.parse(l))

/**
 * A fixture whose playbook drives the REAL claude adapter, pointed at a shim.
 * This is the seam the shim-only tests could not exercise: run state, snapshot,
 * engine and adapter all in one path.
 */
async function adapterFixture ({ mode = 'ok' } = {}) {
  const record = path.join(await temp(), 'calls')
  // auditor-1 on a different Claude model than the Opus coordinator and
  // implementer, so each seat's own wire model is observable at the far end.
  const f = await engineFixture({ auditor: 'haiku-4-5' })

  // Point the roster at the real claude adapter, with a distinctive effort and
  // role instructions so the wiring is observable at the far end.
  for (const name of await fs.readdir(path.join(f.configRoot, 'roster'))) {
    const file = path.join(f.configRoot, 'roster', name)
    let text = await fs.readFile(file, 'utf8')
    text = text.replace(/^harness: .*$/m, 'harness: claude')
    await fs.writeFile(file, text)
  }
  process.env.DEVPANEL_CLAUDE_BIN = await shim({ mode, record })

  const claude = await import('../../harness/claude.mjs')
  return { ...f, record, harnesses: { claude }, probe: (h, o) => claude.probe(o) }
}

const start = (f, extra = {}) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath,
  projectPath: f.projectPath,
  harnesses: f.harnesses,
  stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot,
  probe: f.probe,
  clock: f.clock,
  deliveryProvider: f.delivery,
  ...extra
})

export default async function (t) {
  // ============================================ 1. the resolved participant
  t.section('1. the engine hands the adapter the RESOLVED participant')
  {
    const f = await adapterFixture()
    const engine = await start(f)
    await engine.drive({ maxTurns: 4 })   // triage, brief, implement, audit

    const all = await readRecord(f.record)
    // Preflight probes go through the same shim; only turns carry a marker.
    const calls = all.filter((c) => c.marker)
    t.ok('the adapter was invoked', calls.length >= 4, `${calls.length} turns of ${all.length} calls`)

    const models = [...new Set(calls.map((c) => c.received.model))]
    t.ok('the WIRE model reached the runtime, not the roster id',
      models.every((m) => m.startsWith('claude-')), models.join(','))
    t.ok('specifically the coordinator\'s and implementer\'s', models.includes('claude-opus-5-5'), models.join(','))
    t.ok('and the auditor\'s', models.includes('claude-haiku-4-5'), models.join(','))
    t.ok('no roster id leaked through', !models.some((m) => ['opus-5-5', 'haiku-4-5'].includes(m)))

    const efforts = calls.map((c) => c.received.effort)
    t.ok('effort came from the resolved participant', efforts.includes('medium') || efforts.includes('high'),
      JSON.stringify([...new Set(efforts)]))

    // Working seats run in the worktree; tool-free coordinator turns in their
    // own scratch directory, where nothing they could write reaches the candidate.
    t.ok('the workspace was every working seat\'s cwd', calls.filter((c) => !c.received.toolFree).every((c) => c.received.cwd.includes('worktree-')))
    t.ok('and coordinator turns ran tool-free in scratch', calls.filter((c) => c.received.toolFree).every((c) => c.received.cwd.includes(`${path.sep}scratch${path.sep}`)) && calls.some((c) => c.received.toolFree))
    t.ok('every turn carried its marker', calls.every((c) => typeof c.marker === 'string' && c.marker.startsWith('devpanel:')))
    await releaseWorkspace(engine)
  }

  t.section('1b. role instructions reach the runtime when a playbook sets them')
  {
    const f = await adapterFixture()
    const instructionsFile = path.join(f.configRoot, 'playbooks', 'auditor-instructions.md')
    await fs.writeFile(instructionsFile, 'You audit. You never edit.')
    const pb = path.join(f.configRoot, 'playbooks', 'implementation.yaml')
    const text = await fs.readFile(pb, 'utf8')
    await fs.writeFile(pb, text.replace('  auditor-1:\n    model: haiku-4-5',
      `  auditor-1:\n    model: haiku-4-5\n    instructions: ${instructionsFile}`))

    const engine = await start(f)
    await engine.drive()
    const calls = (await readRecord(f.record)).filter((c) => c.marker)
    // Coordinator turns carry the engine's coordinator instructions; the
    // playbook's role instructions are the auditor's.
    const auditorCalls = calls.filter((c) => c.received.instructions && !c.received.toolFree)
    t.ok('the auditor received its instructions', auditorCalls.length > 0, `${auditorCalls.length} of ${calls.length}`)
    t.eq('verbatim', auditorCalls[0]?.received.instructions, 'You audit. You never edit.')
    t.ok('and other roles did not', calls.some((c) => c.received.instructions === null))
    await releaseWorkspace(engine)
  }

  t.section('1c. a provider profile reaches the runtime through the engine')
  {
    process.env.DEEPSEEK_BASE_URL = 'https://deepseek.example.invalid/v1'
    process.env.DEEPSEEK_AUTH_TOKEN = 'deepseek-secret'
    const f = await adapterFixture()
    const rosterFile = path.join(f.configRoot, 'roster/deepseek-flash.yaml')
    const roster = await fs.readFile(rosterFile, 'utf8')
    await fs.writeFile(rosterFile, roster.replace(/^endpointRef: .*$/m, 'endpointRef: env:DEEPSEEK_BASE_URL').replace(/^credentialRef: .*$/m, 'credentialRef: env:DEEPSEEK_AUTH_TOKEN'))
    // Bind the auditor to the deepseek profile of the same adapter.
    const pb = path.join(f.configRoot, 'playbooks', 'implementation.yaml')
    const text = await fs.readFile(pb, 'utf8')
    await fs.writeFile(pb, text.replace('model: haiku-4-5', 'model: deepseek-flash'))

    const engine = await start(f)
    await engine.drive()
    const calls = (await readRecord(f.record)).filter((c) => c.marker)
    const viaProfile = calls.filter((c) => c.received.baseUrl === 'https://deepseek.example.invalid/v1')
    t.ok('the auditor\'s turns went through the profile endpoint', viaProfile.length > 0, `${viaProfile.length} of ${calls.length}`)
    t.eq('with the profile credential', viaProfile[0]?.received.authToken, 'present')
    t.eq('and the profile wire model', viaProfile[0]?.received.model, 'deepseek-flash')
    t.ok('default-profile turns did not inherit it', calls.some((c) => c.received.baseUrl !== 'https://deepseek.example.invalid/v1'))
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.DEEPSEEK_AUTH_TOKEN
    await releaseWorkspace(engine)
  }

  // ============================================ 2. reconciliation for real
  t.section('2. recovery reconciles through the real adapter after a restart')
  {
    const f = await adapterFixture()
    const engine = await start(f)
    // Crash after the agent finished but before the engine recorded it.
    engine.hooks.afterInvokeBeforePersist = async (e) => {
      delete e.hooks.afterInvokeBeforePersist
      throw new Error('crash')
    }
    await engine.drive().catch(() => {})

    const before = (await readRecord(f.record)).filter((c) => c.marker).length
    await simulateProcessDeath(f.issuePath)
    const resumed = await resumeRun({
      issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore,
      clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery,
      workspaceProvider: f.workspaceProvider, projectPath: f.projectPath
    })

    const ledger = path.join(f.issuePath, 'runs', engine.runId, 'adapters', 'claude-ledger.jsonl')
    t.ok('the adapter ledger lives in run metadata', await fs.stat(ledger).then(() => true, () => false), ledger)

    await resumed.recover()
    t.ok('the completed work was found and adopted', resumed.run.steps.length === 1, `${resumed.run.steps.length} steps`)
    t.ok('the run is NOT blocked for recovery', resumed.run.status !== 'blocked', resumed.run.blockedReason)
    t.eq('and the agent was not asked to repeat it', (await readRecord(f.record)).filter((c) => c.marker).length, before)
    t.ok('the adopted response is the one the runtime produced',
      resumed.run.steps[0].response.includes('Here is the work'))
    await releaseWorkspace(resumed)
  }

  t.section('2b. the ledger does not contaminate the candidate')
  {
    const f = await adapterFixture()
    const engine = await start(f)
    await engine.drive()

    const inWorkspace = await fs.readdir(engine.run.workspace.path)
    t.ok('no adapter ledger in the workspace', !inWorkspace.some((n) => n.includes('ledger')), inWorkspace.join(','))

    const fingerprinted = engine.run.revisions.map((r) => r.fingerprint)
    t.eq('exactly one revision, from the implement step', fingerprinted.length, 1)

    // Every step after the fingerprint must leave it alone.
    const closing = engine.run.closure?.revision
    t.eq('the closing revision is the recorded one', closing, fingerprinted[0])
    t.eq('and the run closed', engine.run.outcome, 'resolved')

    const patch = await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, engine.run.delivery.artifactRef), 'utf8')
    t.ok('the delivered artifact carries no transcript', !patch.includes('ledger'), patch.slice(0, 80))
    await releaseWorkspace(engine)
  }

  // ============================================ 3. abort listener lifetime
  t.section('3. completed turns leave no abort listener behind')
  {
    const controller = new AbortController()
    const dir = await temp()

    // Several turns complete normally on a shared signal.
    const pids = []
    for (let i = 0; i < 3; i++) {
      const run = await runProcess({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        signal: controller.signal
      })
      pids.push(run.pid)
      t.eq(`turn ${i + 1} completed cleanly`, run.cancelled, false)
    }

    t.eq('no listeners accumulated on the shared signal',
      typeof controller.signal.eventListenerCount === 'function' ? controller.signal.eventListenerCount('abort') : 0, 0)

    // Now a real turn is cancelled on that same signal.
    const pidFile = path.join(dir, 'pids')
    const spawnedTree = (async () => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const seen = await readRecord(pidFile)
        if (seen.length >= 2) { controller.abort(); return seen }
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('tree never appeared')
    })()

    const cancelled = await runProcess({
      command: process.execPath, args: [STUBBORN, 'parent'],
      env: { ...process.env, PID_FILE: pidFile }, signal: controller.signal, graceMs: 250
    })
    const tree = await spawnedTree

    t.ok('the live turn was cancelled', cancelled.cancelled)
    t.ok('and its tree is gone', tree.every((p) => !alive(p.pid)))
    t.ok('the earlier, completed turns were not targeted',
      cancelled.termination.confirmedAt !== null && !pids.includes(cancelled.pid))
  }

  t.section('a broken Bash sandbox cannot become a weakened analysis')
  {
    const f = await adapterFixture()
    const engine = await start(f)
    process.env.DEVPANEL_CLAUDE_BIN = await shim({ mode:'sandbox-error', record:f.record })
    let failure
    try { await engine.drive() } catch(error) { failure=error }
    t.eq('the engine receives an explicit environment failure',failure?.kind,'environment-error')
    t.eq('classification is durable on the run',engine.run.failure?.class,'environment')
    t.eq('no agent response is accepted',engine.run.steps.length,0)
    t.eq('no retry or workaround turn runs',(await readRecord(f.record)).filter(call=>call.marker).length,1)
    t.eq('the failed invocation is no longer pending',Object.values(engine.run.participants).filter(p=>p.pendingInvocation).length,0)
    await releaseWorkspace(engine)
  }

  t.section('a login rejected after another process replaced the credential file is retried once with the new file')
  {
    for (const rotate of [true, false]) {
      const f = await adapterFixture()
      const engine = await start(f)
      const home = await temp()
      const file = path.join(home, '.credentials.json')
      await fs.writeFile(file, 'stale')
      const saved = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = home
      process.env.DEVPANEL_CLAUDE_BIN = await shim({ mode: 'oauth-expired', record: f.record, env: rotate ? { AGENT_ROTATE_CREDENTIALS: '1' } : {} })
      const availability = createAvailabilityStore(path.join(await temp(), 'availability.json'), { clock: f.clock })
      engine.availability = availability
      let thrown = null
      try { await engine.drive({ maxTurns: 2 }) } catch (error) { thrown = error }
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = saved
      const turns = (await readRecord(f.record)).filter((c) => c.marker)
      const first = engine.run.failures[0]
      if (rotate) {
        t.eq('changed: the failure is transient', first?.class, 'transient')
        t.eq('and retried', first?.retried, true)
        t.eq('at once, not after the backoff', first?.retryInMs, 1000)
        t.eq('the change is on the record', `${first?.credentials?.changed}:${first?.credentials?.how}`, 'true:replaced')
        t.ok('with both states of the file, not its content', first?.credentials?.atStart?.ino !== first?.credentials?.atFailure?.ino && !JSON.stringify(first.credentials).includes('hash'))
        t.eq('the retry read the new file', turns.slice(0, 2).map((c) => c.received.credentials).join(','), 'stale,fresh')
        t.eq('one failure, and the run went on', `${engine.run.failures.length}:${engine.run.failure}:${thrown?.message ?? null}`, '1:null:null')
      } else {
        t.eq('unchanged: the failure is auth', engine.run.failure?.class, 'auth')
        t.eq('not runtime, and not retried', `${first?.class}:${first?.retryable}:${first?.retried}:${turns.length}`, 'auth:false:false:1')
        t.eq('the unchanged file is on the record', `${engine.run.failure?.credentials?.changed}:${engine.run.failure?.credentials?.how}`, 'false:null')
        t.eq('the model\'s availability is unchanged', (await availability.all()).length, 0)
        t.ok('the run failed with the runtime error', thrown?.kind === 'runtime-error', thrown?.message)
      }
      await releaseWorkspace(engine)
    }
  }

  // Adapters mkdir their ledger directory, which is a sibling of the workspace
  // and therefore not itself a tracked temp — remove both.
  await Promise.all(temps.splice(0).flatMap((d) => [
    fs.rm(d, { recursive: true, force: true }).catch(() => {}),
    fs.rm(`${d}-ledger`, { recursive: true, force: true }).catch(() => {})
  ]))
  delete process.env.DEVPANEL_CLAUDE_BIN
  await cleanupFixtures()
}
