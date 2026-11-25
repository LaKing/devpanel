import fs from 'node:fs/promises'
import path from 'node:path'

import { createFakeHarness, FAKE_RUNTIME_PID } from './harness.mjs'
import { scriptFor } from './fixture.mjs'

/*
 * The scripted fake harness, as a module a *separate process* can load.
 *
 * The in-process fake is configured by passing a closure. A server running in
 * its own process cannot be handed a closure, so this variant reads a JSON
 * control file on every call. That also lets a test change the runtime's
 * behaviour part-way through a run — which is the only way to reach the states
 * that only exist while a turn is in flight.
 *
 *   DEVPANEL_FAKE_CONTROL   path to the control file
 *
 * Control file fields, all optional:
 *   ledger          where the runtime records what it did
 *   delayMs         how long each turn takes to answer
 *   delayFor        per-step overrides, e.g. { implement: 8000 } — a run only
 *                   reaches an interesting turn quickly if the others are fast
 *   writes          files a step writes into the workspace BEFORE it answers,
 *                   e.g. { implement: { file: 'wip.txt', text: '...' } } — an
 *                   author changes the workspace long before it responds
 *   hangOnAbortMs   how long the runtime takes to die after being cancelled —
 *                   a process that stops instantly never exercises "Stopping"
 *   failInvoke      message for a runtime that refuses to run at all
 *   probeDelayMs    how long a probe takes — preflight is paid, so stopping
 *                   during it has to be reachable from a test
 *   auth            authentication status a probe reports (default 'ok')
 *   modelAccess     model-access status a probe reports (default 'ok')
 *   script          options forwarded to scriptFor()
 *   noise           per-step noisy output while the turn is in flight, e.g.
 *                   { implement: { chunks: 400, bytes: 1024, intervalMs: 10 } };
 *                   chunk i of step s is `DPNOISE:<s>:<i> ` padded to `bytes`
 *                   and newline-terminated, so a test can find each one
 */

/** Chunk `i` of a step's noise: deterministic and greppable. */
export const noiseChunk = (stepId, i, bytes = 1024) => {
  const head = `DPNOISE:${stepId}:${i} `
  return head + '.'.repeat(Math.max(0, bytes - head.length - 1)) + String.fromCharCode(10)
}

// Read per call, not at import: the module is cached across test suites, and a
// path captured once would point every later suite at the first suite's file.
async function control () {
  try {
    return JSON.parse(await fs.readFile(process.env.DEVPANEL_FAKE_CONTROL, 'utf8'))
  } catch {
    return {}
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve()
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  function onAbort () {
    clearTimeout(timer)
    reject(Object.assign(new Error('cancelled mid-turn'), { name: 'AbortError' }))
  }
  signal?.addEventListener('abort', onAbort, { once: true })
})

export const id = 'fake'

export const capabilities = {
  sessionAssignment: 'preassign',
  resume: true,
  effort: true,
  structuredOutput: true,
  cancellation: true,
  instructions: true
}

const build = async () => {
  const cfg = await control()
  return {
    cfg,
    harness: createFakeHarness({
      ledgerPath: cfg.ledger,
      script: (meta) => scriptFor(cfg.script ?? {})(meta)
    })
  }
}

export async function probe (options = {}) {
  const { cfg, harness } = await build()
  await sleep(cfg.probeDelayMs ?? 0, options.signal)
  const result = await harness.probe(options)

  // A runtime that cannot authenticate, or cannot reach a model, is the ordinary
  // reason a start fails. It has to be reachable from a test.
  if (cfg.auth) result.authentication = { status: cfg.auth, detail: cfg.authDetail ?? null }
  if (cfg.modelAccess) {
    for (const model of Object.keys(result.modelAccess)) {
      result.modelAccess[model] = { status: cfg.modelAccess, detail: cfg.modelDetail ?? null }
    }
  }
  return result
}

export async function reconcile (invocationId) {
  const { harness } = await build()
  return harness.reconcile(invocationId)
}

export async function invoke (args) {
  const { cfg, harness } = await build()
  if (cfg.failInvoke) throw new Error(cfg.failInvoke)
  args.observe?.onActivity?.({ at: new Date().toISOString(), pid: FAKE_RUNTIME_PID, kind: 'tool-use', detail: 'fake' })
  args.observe?.onSpawn?.({ pid: process.pid, command: 'fake-runtime', args: ['--role', args.meta?.role ?? 'unknown'], cwd: args.cwd ?? process.cwd() })
  args.observe?.onOutput?.('stdout', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'source.txt' } }] } }) + String.fromCharCode(10))

  const stepId = args.meta?.stepId ?? null

  // A real author edits the workspace while it works, and long before it
  // answers. Anything that reads "did work happen" from the response alone
  // cannot see this.
  const write = stepId ? cfg.writes?.[stepId] : null
  if (write && args.cwd) {
    const file = path.join(args.cwd, write.file)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, write.text ?? 'work in progress', 'utf8')
  }

  // Pacing happens here rather than inside the script so that cancellation is
  // observed while the turn is genuinely in flight.
  const delay = (stepId && cfg.delayFor?.[stepId] != null) ? cfg.delayFor[stepId] : (cfg.delayMs ?? 0)
  const noise = stepId ? cfg.noise?.[stepId] : null
  try {
    if (noise) {
      // The noise is the turn's work: it runs to the end, then any remaining delay.
      const started = Date.now()
      for (let i = 0; i < (noise.chunks ?? 0); i++) {
        args.observe?.onOutput?.('stdout', noiseChunk(stepId, i, noise.bytes ?? 1024))
        await sleep(noise.intervalMs ?? 10, args.signal)
      }
      await sleep(delay - (Date.now() - started), args.signal)
    } else {
      await sleep(delay, args.signal)
    }
  } catch (error) {
    // A runtime does not vanish the instant it is asked to. Confirming
    // termination is what makes "stopping" a state rather than an instant.
    await new Promise((resolve) => setTimeout(resolve, cfg.hangOnAbortMs ?? 0))
    throw error
  }

  return harness.invoke(args)
}
