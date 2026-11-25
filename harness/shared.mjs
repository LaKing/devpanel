import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runProcess, ProcessError } from '../gui/server/runtime/process.mjs'

/*
 * The provider-independent half of an adapter.
 *
 * Installation probing, the paid model-access probe loop, the invocation ledger
 * and its reconciliation, the line-buffered event observer and the read-only
 * scratch check are the same for every CLI runtime. What an adapter still owns:
 * how a turn is launched (arguments, environment, sandboxing), how its event
 * stream is read (`describeEvent` and what each event contributes), and how the
 * provider's usage is normalised.
 */

export const NL = String.fromCharCode(10)

// --- the child environment -------------------------------------------------------

/*
 * What a CLI runtime inherits from the panel, when the run's snapshot says
 * `fence.hygiene: 1` (and always for runless turns: supervisor, oracle, probe).
 *
 * The panel's own environment can hold its API token, database references and
 * other providers' keys; a copy of `process.env` handed every one of them to
 * every seat, its shell and the model. So the child starts from an allow-list:
 * ordinary process settings (locale, paths, certificates, proxies) plus the
 * variables of the ONE provider this runtime talks to — the selected
 * connection's credential is the accepted exception, since the runtime needs it.
 * Nothing named DEVPANEL_* is inherited; the adapter sets the ones it means to.
 * `DEVPANEL_REAP_TAG` is added by runProcess after this, so reaping is unchanged.
 *
 * `DEVPANEL_CHILD_ENV_PASS` (comma-separated names, `PREFIX*` for a prefix) lets
 * the test suite hand its fake CLIs their control variables; it names what to
 * pass, it never widens anything by default.
 */
const BASE_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR',
  'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'
])
const BASE_ENV_PREFIXES = ['LC_', 'XDG_']
export const PROVIDER_ENV_PREFIXES = Object.freeze({
  claude: ['ANTHROPIC_', 'CLAUDE_', 'DISABLE_'],
  codex: ['OPENAI_', 'CODEX_'],
  gemini: ['GEMINI_', 'GOOGLE_', 'CLOUDSDK_'],
  // The login is a file in the seat's home; no variable of the service is the CLI's to read (GOOGLE_* would switch its auth).
  antigravity: []
})

export function childEnvironment (provider, source = process.env) {
  const prefixes = [...BASE_ENV_PREFIXES, ...(PROVIDER_ENV_PREFIXES[provider] ?? [])]
  const passNames = new Set()
  const passPrefixes = []
  for (const item of String(source.DEVPANEL_CHILD_ENV_PASS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (item.endsWith('*')) passPrefixes.push(item.slice(0, -1))
    else passNames.add(item)
  }
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    const listed = BASE_ENV_NAMES.has(key) || passNames.has(key) || passPrefixes.some((p) => key.startsWith(p))
    const provided = !key.startsWith('DEVPANEL_') && prefixes.some((p) => key.startsWith(p))
    if (listed || provided) env[key] = value
  }
  return env
}

// --- probing -------------------------------------------------------------------

/** The result scaffold plus the `--version` check every adapter starts with. */
export async function installationProbe (command, { id, depth, models = [], profile = 'default', endpointRef = null, credentialRef = null, account = null, capabilities }) {
  const result = {
    id,
    depth,
    connection: { profile, endpointRef, credentialRef, account },
    capabilities,
    probedAt: new Date().toISOString(),
    installation: { status: 'missing', version: null, path: null, detail: null },
    authentication: { status: 'unknown', detail: 'not probed: requires a live call' },
    modelAccess: Object.fromEntries(models.map((m) => [m, { status: 'unknown', detail: 'not probed: requires a live call' }]))
  }

  try {
    const run = await runProcess({ command, args: ['--version'] })
    result.installation = run.code === 0
      ? { status: 'installed', version: run.stdout.trim().split(NL)[0], path: null, detail: null }
      : { status: 'error', version: null, path: null, detail: run.stderr.trim().slice(0, 200) }
  } catch (error) {
    result.installation = {
      status: error.code === 'ENOENT' ? 'missing' : 'error',
      version: null, path: null, detail: error.message
    }
  }
  return result
}

/**
 * Depths 2 and 3 COST A CALL: proving credentials work, or that a model is
 * reachable, means using it. Callers must budget for these.
 *
 * Each model goes through the adapter's own `invoke`, so the probe gets the same
 * response validation, error classification, cancellation and termination
 * guarantees as a real turn — in a disposable workspace, never the caller's
 * directory. `costKnown` says whether a successful turn's `usage.costUsd` is a
 * real number for this connection; when it is not, every call counts as unknown.
 */
export async function probeModels (result, { invoke, models, profile = 'default', endpointRef = null, credentialRef = null, account = null, signal = null, timeoutMs = 120000, costKnown = false }) {
  result.usage = { tokens: 0, costUsd: 0, costUnknownCalls: 0 }
  result.invocations = 0

  const probeCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-probe-'))
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline

  try {
    for (const model of models) {
      result.invocations += 1
      try {
        const turn = await invoke({
          model,
          cwd: probeCwd,
          prompt: 'Reply with the single word OK.',
          profile,
          // The probe must run as the connection it claims to prove. Without this
          // the scaffold keeps the requested label while the call goes out under
          // the ambient login, and preflight approves the wrong evidence.
          account,
          endpointRef,
          credentialRef,
          signal: combined,
          ledgerDir: null,
          meta: { invocationId: `probe-${model}` }
        })
        result.authentication = { status: 'ok', detail: null }
        result.modelAccess[model] = { status: 'ok', detail: null }
        result.usage.tokens += turn.usage?.tokens ?? 0
        if (costKnown && typeof turn.usage?.costUsd === 'number') result.usage.costUsd += turn.usage.costUsd
        else result.usage.costUnknownCalls += 1
      } catch (error) {
        // The call was attempted, so it may have cost something regardless.
        result.usage.costUnknownCalls += 1

        if (error.name === 'AbortError') {
          result.authentication = { status: 'unknown', detail: 'probe cancelled or timed out' }
          result.modelAccess[model] = { status: 'unknown', detail: 'probe cancelled or timed out' }
          break
        }
        const detail = (error.stderr ?? error.message ?? '').toString().slice(0, 200)
        const credentialish = /auth|credential|api key|unauthor|forbidden|401|403/i.test(detail)
        result.authentication = credentialish
          ? { status: 'invalid', detail }
          : { status: result.authentication.status === 'ok' ? 'ok' : 'unknown', detail }
        result.modelAccess[model] = { status: credentialish ? 'unknown' : 'denied', detail }
      }
    }
  } finally {
    await fs.rm(probeCwd, { recursive: true, force: true }).catch(() => {})
  }

  return result
}

// --- the ledger ----------------------------------------------------------------

/**
 * Where an adapter records what it actually did, per invocation. Recovery reads
 * it: without an attributable record there is no way to tell a turn that never
 * started from one that finished just before the engine died.
 *
 * The ledger lives in RUN METADATA, never in the workspace. Inside the worktree
 * it would be part of the candidate: every turn would change the revision
 * fingerprint, and `git add -A` at delivery would ship the transcript.
 */
/** Ledger phases written by harness/config-guard.mjs, never a runtime outcome. */
export const GUARD_PHASES = new Set(['guarded', 'config-inherited', 'quarantine-intent', 'config-checked', 'config-resolved'])

/**
 * `guarded`: the ledger is shared with harness/config-guard.mjs (codex, gemini).
 * Only then are its phases left out of the outcome and a torn non-final line
 * skipped; any other ledger (claude) is read strictly, exactly as before.
 */
export function createLedger (fileName, { guarded = false } = {}) {
  const ledgerFile = (ledgerDir) => path.join(ledgerDir, fileName)

  async function record (ledgerDir, entry) {
    if (!ledgerDir) return
    try {
      await fs.mkdir(ledgerDir, { recursive: true })
      await fs.appendFile(ledgerFile(ledgerDir), JSON.stringify(entry) + NL, 'utf8')
    } catch { /* a ledger we cannot write is reported as uncertain later */ }
  }

  /**
   * Anything that cannot be tied to THIS invocation is uncertain, never "not
   * started" — another run's session could easily be the more recent one.
   */
  async function reconcile (invocationId, { ledgerDir } = {}) {
    if (!ledgerDir) return { phase: 'uncertain', reason: 'no ledger location supplied' }
    let lines = []
    try {
      const raw = (await fs.readFile(ledgerFile(ledgerDir), 'utf8')).split(NL).filter(Boolean)
      // Guarded: a malformed line followed by valid records is a torn write that a
      // later append closed (config-guard.mjs appendLine): skipped. A malformed final
      // line is an interrupted write: the whole ledger stays uncertain, as before.
      if (!guarded) lines = raw.map((l) => JSON.parse(l))
      else raw.forEach((l, i) => { try { lines.push(JSON.parse(l)) } catch (error) { if (i === raw.length - 1) throw error } })
    } catch {
      // No ledger at all is not evidence of absence.
      return { phase: 'uncertain', reason: 'no adapter ledger available' }
    }

    // The configuration guard's lines (config-guard.mjs) share the ledger and
    // say nothing about whether the runtime finished.
    const tied = lines.filter((e) => e.invocationId === invocationId && !(guarded && GUARD_PHASES.has(e.phase)))
    if (tied.length) {
      const last = tied[tied.length - 1]
      if (last.phase === 'not-started') return { phase: 'not-started', reason: last.error }
      return last.phase === 'completed'
        ? { phase: 'completed', sessionId: last.sessionId, session: last.session ?? null, response: last.response, usage: last.usage }
        : { phase: 'uncertain', reason: `invocation recorded as ${last.phase}` }
    }
    if (lines.length) return { phase: 'uncertain', reason: 'ledger activity cannot be tied to this invocation' }
    return { phase: 'not-started' }
  }

  return { record, reconcile }
}

// --- the event stream ----------------------------------------------------------

/**
 * Line-buffer stdout and report each JSON event to the observer, with the pid
 * once it is known. `onEvent(event)` lets the adapter capture what it needs from
 * the stream; `describeEvent(event)` turns one into liveness (a tool call proves
 * the process is working, not that the answer is close). Nothing here is
 * required for the turn to succeed.
 */
export function lineObserver ({ observe, describeEvent, onEvent = () => {} }) {
  let buffer = ''
  let count = 0
  let pid = null
  const report = (event) => {
    onEvent(event)
    const described = describeEvent(event)
    if (!described) return
    count += 1
    observe?.onActivity?.({ at: new Date().toISOString(), pid, ...described })
  }
  return {
    get count () { return count },
    hooks: {
      onSpawn ({ pid: p, command, args, cwd }) {
        pid = p
        observe?.onSpawn?.({ pid, command, args, cwd })
        observe?.onActivity?.({ at: new Date().toISOString(), pid, kind: 'spawned', detail: null })
      },
      onOutput (stream, chunk) {
        // Raw bytes first, every stream: the GUI shows the runtime's output as
        // it is written, not a summary of it.
        try { observe?.onOutput?.(stream, chunk) } catch { /* telemetry cannot suppress event parsing */ }
        if (stream !== 'stdout') return
        buffer += chunk
        let nl
        while ((nl = buffer.indexOf(NL)) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('{')) continue
          try { report(JSON.parse(line)) } catch { /* partial or non-JSON */ }
        }
      }
    }
  }
}

// --- invocation helpers --------------------------------------------------------

/**
 * A read-only source turn needs somewhere to write that is not the worktree.
 * Returns the resolved scratch root.
 */
export async function assertScratchOutsideWorktree (cwd, scratchDir) {
  const sourceRoot = await fs.realpath(cwd)
  const scratchRoot = scratchDir ? await fs.realpath(scratchDir) : null
  if (!scratchRoot || scratchRoot === sourceRoot || scratchRoot.startsWith(sourceRoot + path.sep)) throw new Error('read-only source turns require scratch space outside the worktree')
  return { sourceRoot, scratchRoot }
}

/** The abort the engine expects, carrying proof the process group is gone. */
export function cancelledError (termination) {
  const error = new Error('cancelled')
  error.name = 'AbortError'
  error.termination = termination
  return error
}

/**
 * The runtime's descendant scan (process.mjs `leftovers.scan`) on an error
 * raised after it ran: whether its escaped processes were proved gone is the
 * engine's to judge (cleanup-barrier.mjs), whatever went wrong afterwards.
 */
export function withReap (error, run) {
  const scan = run?.leftovers?.scan
  if (scan && error && typeof error === 'object' && !error.reap) error.reap = scan
  return error
}

/** A failed RUN is not a bad answer; the engine must never treat it as one. */
export const runtimeError = (message, detail = {}) => new ProcessError(message, { kind: 'runtime-error', ...detail })

/** Dotted version compare: versionAtLeast('2.1.277', '2.1.277') is true; unknown versions are never "at least". */
export function versionAtLeast (version, minimum) {
  if (typeof version !== 'string') return false
  const a = version.split('.').map(n => parseInt(n, 10))
  const b = minimum.split('.').map(n => parseInt(n, 10))
  if (a.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/**
 * Some runtimes report RUNNING TOTALS for a resumed session, not what this
 * invocation used. Given the totals recorded on the session descriptor after
 * the previous invocation and the totals reported now, return what this
 * invocation added.
 *
 *   basis 'first'  — no previous totals on the session: the reported values are
 *                    this invocation's (a fresh session, or a descriptor written
 *                    before totals were tracked — then a one-off over-count).
 *   basis 'delta'  — every key grew or held: the difference is this turn.
 *   basis 'reset'  — a key went backwards: the runtime started a new total
 *                    (session file gone, different machine); the reported value
 *                    is taken as this invocation's, never a negative.
 *
 * `reported` values that are null stay null in the delta and are not stored.
 */
export function cumulativeDelta (previous, reported) {
  const keys = Object.keys(reported).filter(k => typeof reported[k] === 'number')
  const known = previous && typeof previous === 'object' && keys.some(k => typeof previous[k] === 'number')
  const delta = { ...reported }
  let basis = known ? 'delta' : 'first'
  if (known && keys.some(k => typeof previous[k] === 'number' && reported[k] < previous[k])) basis = 'reset'
  if (basis === 'delta') for (const k of keys) delta[k] = typeof previous[k] === 'number' ? reported[k] - previous[k] : reported[k]
  const totals = {}
  for (const k of keys) totals[k] = reported[k]
  return { delta, totals, basis }
}
