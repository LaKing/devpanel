import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/*
 * Scripted fake harness.
 *
 * Its ledger is persisted SEPARATELY from engine state, on purpose. After a
 * simulated crash the engine's own run.json cannot distinguish "the agent never
 * ran" from "the agent finished and we died before recording it" — only an
 * independent record of what the runtime actually did can. That is exactly the
 * evidence a real adapter has to produce for recovery, so the fake models it.
 */

const uuid = () => crypto.randomUUID()

/*
 * The pid the fake runtime reports as its own. It has no process of its own,
 * and reporting the test runner's pid made owner-loss recovery's group probe
 * (`alive(-pid)`) find the runner itself "still running" whenever the runner
 * led its own process group (a shell job, setsid, a detached spawn). Above
 * Linux's highest pid_max (2^22) and darwin's pid range, so no group has it.
 */
export const FAKE_RUNTIME_PID = 2 ** 22 + 1

export class Ledger {
  constructor (file) { this.file = file }

  async append (entry) {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.appendFile(this.file, JSON.stringify(entry) + String.fromCharCode(10), 'utf8')
  }

  async entries () {
    try {
      const text = await fs.readFile(this.file, 'utf8')
      return text.split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  /**
   * The evidence a recovering engine consults.
   *
   * Three outcomes, and the third is the one that matters: an empty ledger means
   * the agent positively never ran, but a ledger holding activity that cannot be
   * TIED to this invocation is uncertain. Treating that as "no work" would repeat
   * an invocation that may already have changed the workspace; picking the most
   * recent session instead could adopt another run's work entirely.
   */
  async findByInvocation (invocationId) {
    const all = await this.entries()
    const tied = all.filter((e) => e.invocationId === invocationId)
    if (tied.length) return tied[tied.length - 1]
    if (all.some((e) => e.invocationId == null)) return { phase: 'uncertain', reason: 'ledger activity cannot be tied to this invocation' }
    return null
  }

  async invocationCount () {
    return (await this.entries()).filter((e) => e.phase === 'started').length
  }

  async sessionsFor (role) {
    return [...new Set((await this.entries()).filter((e) => e.role === role && e.sessionId).map((e) => e.sessionId))]
  }
}

/**
 * @param script    ({ role, stepId, attempt, round, prompt }) => string | { text, outcome, delayTicks }
 * @param ledgerPath  where the runtime's own record lives
 * @param sessionAssignment  'preassign' (id known before the turn) or 'discover'
 * @param loseMarker  simulate a runtime whose ledger cannot be tied back to the
 *                    invocation — recovery must then refuse to guess
 */
export function createFakeHarness ({
  id = 'fake',
  script,
  ledgerPath,
  sessionAssignment = 'preassign',
  loseMarker = false,
  capabilities: capsOverride = {},
  clock
} = {}) {
  const ledger = new Ledger(ledgerPath)

  const capabilities = {
    sessionAssignment,
    resume: true,
    effort: true,
    structuredOutput: true,
    cancellation: true,
    instructions: true,
    ...capsOverride
  }

  async function probe ({ depth = 'installation', models = [], profile = 'default', endpointRef = null, credentialRef = null } = {}) {
    return {
      id,
      depth,
      connection: { profile, endpointRef, credentialRef },
      capabilities,
      probedAt: clock ? clock.iso() : new Date().toISOString(),
      installation: { status: 'installed', version: 'fake-1.0.0', path: null, detail: null },
      authentication: { status: depth === 'installation' ? 'unknown' : 'ok', detail: null },
      modelAccess: Object.fromEntries(models.map((m) => [m, { status: depth === 'model' ? 'ok' : 'unknown', detail: null }]))
    }
  }

  async function invoke ({ session, prompt, marker, signal, meta = {}, observe = null } = {}) {
    const invocationId = meta.invocationId ?? uuid()
    const role = meta.role ?? 'unknown'

    // A real runtime is seen doing things before it answers. One event is
    // enough to prove the engine records what it is told.
    observe?.onActivity?.({ at: clock ? clock.iso() : new Date().toISOString(), pid: FAKE_RUNTIME_PID, kind: 'tool-use', detail: 'fake' })
    observe?.onSpawn?.({ pid: process.pid, command: 'fake-runtime', args: ['--role', role], cwd: meta.cwd ?? process.cwd() })
    observe?.onOutput?.('stdout', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file: 'source.txt' } }] } }) + String.fromCharCode(10))
    observe?.onOutput?.('stderr', 'fake runtime: working' + String.fromCharCode(10))

    // "The agent started" — recorded before any work, as a real runtime would.
    await ledger.append({
      invocationId: loseMarker ? null : invocationId,
      marker: loseMarker ? null : marker,
      role,
      stepId: meta.stepId ?? null,
      phase: 'started',
      at: clock ? clock.iso() : new Date().toISOString()
    })

    if (signal?.aborted) {
      await ledger.append({ invocationId, marker, role, phase: 'cancelled', at: clock ? clock.iso() : new Date().toISOString() })
      const error = new Error('cancelled before start')
      error.name = 'AbortError'
      throw error
    }

    // Race the script against the abort signal: a runtime that only checks for
    // cancellation after its work finishes can never be stopped mid-turn, which
    // is precisely the hung-invocation case a deadline must handle.
    const aborted = new Promise((_, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('cancelled mid-turn'), { name: 'AbortError' }))
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('cancelled mid-turn'), { name: 'AbortError' })), { once: true })
    })
    let produced
    try {
      produced = await Promise.race([script({ ...meta, role, prompt, session }), aborted])
    } catch (error) {
      await ledger.append({ invocationId, marker, role, phase: 'cancelled', at: clock ? clock.iso() : new Date().toISOString() })
      throw error
    }
    // `diagnostics` is what a real adapter reports beside the answer (its descendant scan, say).
    const { text, outcome = 'completed', delayTicks = 0, diagnostics = null } = typeof produced === 'string' ? { text: produced } : produced

    // Time the turn "took", on the injected clock. Real duration would make an
    // assertion about measurement into an assertion about how fast this machine
    // happens to be.
    if (delayTicks && typeof clock?.advance === 'function') clock.advance(delayTicks)

    // Cancellation is observed at the yield point, as it would be mid-stream.
    await new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error('cancelled mid-turn')
        error.name = 'AbortError'
        reject(error)
        return
      }
      const onAbort = () => {
        const error = new Error('cancelled mid-turn')
        error.name = 'AbortError'
        reject(error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      setImmediate(() => { signal?.removeEventListener('abort', onAbort); resolve() })
    }).catch(async (error) => {
      await ledger.append({ invocationId, marker, role, phase: 'cancelled', at: clock ? clock.iso() : new Date().toISOString() })
      throw error
    })

    const sessionId = session?.id ?? (sessionAssignment === 'preassign' ? meta.preassignedSession ?? uuid() : uuid())

    // "The agent finished" — the fact the engine may crash before recording.
    await ledger.append({
      invocationId: loseMarker ? null : invocationId,
      marker: loseMarker ? null : marker,
      role,
      stepId: meta.stepId ?? null,
      phase: 'completed',
      sessionId,
      outcome,
      response: text,
      at: clock ? clock.iso() : new Date().toISOString()
    })

    return { session: { id: sessionId }, response: text, usage: { turns: 1 }, outcome, ...(diagnostics ? { diagnostics } : {}) }
  }

  /**
   * Authoritative reconciliation. A runtime that cannot answer this must not be
   * treated as having done nothing — the engine blocks instead.
   */
  async function reconcile (invocationId) {
    const found = await ledger.findByInvocation(invocationId)
    if (found === null) return { phase: 'not-started' }
    return found
  }

  return { id, capabilities, probe, invoke, reconcile, ledger }
}
