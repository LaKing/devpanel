import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { acquire, LockHeld } from './runtime/lock.mjs'
import { runProcess } from './runtime/process.mjs'
import { ISSUES_DIR as DEFAULT_ISSUES_DIR } from './issues.js'
import { projectPath as projectDir, projectsRoot } from './project-path.mjs'
import { hostSettings } from './config/host-settings.mjs'

/*
 * Project actions: operator scripts that act on the LIVE project checkout, run
 * on this host, with their output streamed and kept.
 *
 * The canonical action is `checkpoint.sh` in the project root. Projects commit
 * through it: it increments the version, adds the files, commits them and
 * publishes when a remote exists, in one script, and it is the only sanctioned
 * way to commit such a checkout. Every project that has a checkpoint.sh is given
 * a `checkpoint` action; `projects/<id>.yaml` can declare more, or override the
 * built-in one, under `actions`.
 *
 * What runs is installed configuration — a script on disk or a saved command —
 * never text supplied by a model or a browser. The caller names an action id.
 *
 * One operation per project at a time. Its record and its output live under
 * <issues>/<project>/.actions/<operation-id>/ so a browser that opens late, a
 * reconnecting one and a model asking afterwards all read the same bytes.
 * Output is appended before the socket event for it is emitted, like run live
 * output.
 */

const ISSUES_DIR = () => process.env.DEVPANEL_ISSUES_DIR ?? DEFAULT_ISSUES_DIR

const DEFAULT_TIMEOUT_SECONDS = 600
const OUTPUT_MAX_BYTES = Number(process.env.DEVPANEL_ACTION_OUTPUT_MAX_BYTES ?? 8 * 1024 * 1024)
const TAIL_CHARS = 16 * 1024
const ID_RE = /^[a-z0-9-]+$/
const OPERATION_ID_RE = /^[0-9TZ-]+-[0-9a-f]{8}$/

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

/*
 * What an action does to the checkout, declared and never inferred.
 *
 * `commit-checkout` says: this action commits the checkout, and does nothing
 * else that someone asking for an uncommitted checkout to be committed would
 * not expect. Nothing else is declared, and a script's name declares nothing at
 * all — a checkpoint.sh may version, push to a remote, restart a service or deploy,
 * and the registry only ever proved that the file exists. An action without a
 * declared effect is one an operator runs deliberately, never one an agent may
 * decide to run on its own reasoning.
 */
export const ACTION_EFFECTS = ['commit-checkout']
const declaredEffect = (value) => ACTION_EFFECTS.includes(value) ? value : null

/**
 * `# DEVPANEL key: value` header lines. An installation whose scripts already
 * carry another marker word (an editor's own convention) names it in the host
 * settings' projectActions.headerMarkers; DEVPANEL is always read.
 */
export function parseScriptHeader (text, markers = hostSettings().projectActions.headerMarkers) {
  const header = {}
  const pattern = new RegExp(`^#\\s*(?:${markers.join('|')})\\s+([a-z]+):\\s*(.*?)\\s*$`, 'i')
  for (const line of text.split('\n').slice(0, 30)) {
    const m = pattern.exec(line)
    if (m) header[m[1].toLowerCase()] = m[2]
  }
  return header
}

function actionsDir (issuesDir, project) { return path.join(issuesDir, project, '.actions') }
function operationDir (issuesDir, project, operationId) { return path.join(actionsDir(issuesDir, project), operationId) }

async function writeJson (file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2))
  await fs.rename(tmp, file)
}

async function readJson (file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function assertProject (project) {
  if (typeof project !== 'string' || !project || project.includes('/') || project.includes('..') || project.startsWith('.')) throw fail('no such project', 404)
}

/**
 * Every action a project offers: the built-in `checkpoint` (when checkpoint.sh exists) and
 * whatever `projects/<id>.yaml` declares. A declared action with the built-in's
 * id replaces it, so a project can say exactly how it is checkpointed.
 */
export async function listProjectActions (project, { root, projectsDir = projectsRoot(), issuesDir = ISSUES_DIR() } = {}) {
  assertProject(project)
  const projectPath = projectDir(project, projectsDir)
  let stat
  try { stat = await fs.stat(projectPath) } catch { throw fail('no such project', 404) }
  if (!stat.isDirectory()) throw fail('no such project', 404)

  const boilerplate = await fs.stat(path.join(projectPath, '@boilerplate')).then((s) => s.isDirectory()).catch(() => false)
  const actions = new Map()

  const checkpointScript = path.join(projectPath, 'checkpoint.sh')
  const checkpointText = await fs.readFile(checkpointScript, 'utf8').catch(() => null)
  if (checkpointText !== null) {
    const header = parseScriptHeader(checkpointText, hostSettings(root ? { root } : {}).projectActions.headerMarkers)
    actions.set('checkpoint', {
      id: 'checkpoint',
      label: header.cmd || 'Checkpoint',
      hint: header.hint || 'Increment the version, commit and publish the checkout with checkpoint.sh',
      icon: header.icon || null,
      effect: declaredEffect(header.effect),
      run: 'bash ./checkpoint.sh',
      cwd: projectPath,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      source: 'checkpoint.sh',
      builtin: true
    })
  }

  const { loadConfig } = await import('./config/load.mjs')
  const config = await loadConfig(root ? { root } : {})
  const errors = config.errors.filter((e) => e.file?.endsWith(`/projects/${project}.yaml`))
  if (errors.length) throw fail(errors.map((e) => e.message).join('; '), 422)
  for (const declared of config.projects.get(project)?.actions ?? []) {
    actions.set(declared.id, {
      id: declared.id,
      label: declared.label || declared.id,
      hint: declared.hint || '',
      icon: null,
      effect: declaredEffect(declared.effect),
      run: declared.run,
      cwd: projectPath,
      timeoutSeconds: declared.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      source: `projects/${project}.yaml`,
      builtin: false
    })
  }

  const recent = await listOperations(project, { issuesDir, limit: 20 })
  const running = recent.find((o) => o.status === 'running') ?? null
  return {
    project,
    boilerplate,
    checkpointRequired: boilerplate,
    actions: [...actions.values()].map((a) => ({ ...a, last: recent.find((o) => o.action === a.id) ?? null })),
    running
  }
}

/** Operation records, newest first. Each is the persisted operation.json (no output). */
export async function listOperations (project, { issuesDir = ISSUES_DIR(), limit = 20 } = {}) {
  assertProject(project)
  let names = []
  try { names = (await fs.readdir(actionsDir(issuesDir, project))).filter((n) => OPERATION_ID_RE.test(n)) } catch { return [] }
  names.sort().reverse()
  const out = []
  for (const name of names.slice(0, limit)) {
    const record = await readJson(path.join(operationDir(issuesDir, project, name), 'operation.json'))
    if (record) out.push(record)
  }
  return out
}

/** One operation with its output after `after` (exclusive), for catch-up and for the model. */
export async function readOperation (project, operationId, { issuesDir = ISSUES_DIR(), after = 0 } = {}) {
  assertProject(project)
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) throw fail('no such operation', 404)
  const dir = operationDir(issuesDir, project, operationId)
  const operation = await readJson(path.join(dir, 'operation.json'))
  if (!operation) throw fail('no such operation', 404)
  const entries = []
  let text = ''
  try { text = await fs.readFile(path.join(dir, 'output.jsonl'), 'utf8') } catch { /* nothing written yet */ }
  for (const line of text.split('\n')) {
    if (!line) continue
    try { const entry = JSON.parse(line); if (entry.seq > after) entries.push(entry) } catch { /* torn last line still being written */ }
  }
  return { operation, entries, next: entries.at(-1)?.seq ?? after }
}

// Operations this process started, so a stop request reaches the right child.
const inflight = new Map()

/**
 * Start an action. Resolves as soon as the operation is recorded and the
 * process is being spawned, with `{ operation, done }`; `done` settles with the
 * final record. An operation already running on the project is refused (409):
 * two checkpoints interleaved on one checkout is exactly what nobody wants.
 */
export async function startProjectAction ({ project, actionId, root, projectsDir = projectsRoot(), issuesDir = ISSUES_DIR(), emit = () => {}, signal = null, actor = 'operator' }) {
  if (typeof actionId !== 'string' || !ID_RE.test(actionId)) throw fail('no such action', 404)
  const listing = await listProjectActions(project, { root, projectsDir, issuesDir })
  const action = listing.actions.find((a) => a.id === actionId)
  if (!action) throw fail(`project ${project} has no action "${actionId}"`, 404)

  let lock
  try {
    lock = await acquire(path.join(actionsDir(issuesDir, project), '.lock'), { purpose: 'project-action' })
  } catch (error) {
    if (error instanceof LockHeld) {
      const running = listing.running
      throw Object.assign(fail(`an action is already running on ${project}${running ? ` (${running.action}, operation ${running.id})` : ''}`, 409), { operationId: running?.id ?? null })
    }
    throw error
  }

  try {
  const startedAt = new Date()
  const id = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`
  const dir = operationDir(issuesDir, project, id)
  await fs.mkdir(dir, { recursive: true })
  const recordFile = path.join(dir, 'operation.json')
  const outputFile = path.join(dir, 'output.jsonl')
  const operation = {
    id, project, action: action.id, label: action.label, run: action.run, cwd: action.cwd, source: action.source,
    actor, status: 'running', startedAt: startedAt.toISOString(), endedAt: null, pid: null,
    exitCode: null, signal: null, cancelled: false, timedOut: false, truncated: false, durationMs: null,
    stdoutTail: null, stderrTail: null, error: null
  }
  await writeJson(recordFile, operation)
  emit({ type: 'started', project, operationId: id, action: action.id, operation })

  let seq = 0
  let bytes = 0
  let capped = false
  let chain = Promise.resolve()
  // Appends are serialised and each event is emitted only once its line is on
  // disk, so the backlog and the stream never disagree.
  const append = (kind, text) => {
    chain = chain.then(async () => {
      const marker = ['spawn', 'exit', 'truncated'].includes(kind)
      if (capped && !marker) return
      const entry = { seq: ++seq, at: new Date().toISOString(), kind, text }
      const line = JSON.stringify(entry) + '\n'
      if (!capped && !marker && bytes + Buffer.byteLength(line) > OUTPUT_MAX_BYTES) {
        capped = true
        operation.truncated = true
        const cap = { seq: entry.seq, at: entry.at, kind: 'truncated', text: `output capped at ${OUTPUT_MAX_BYTES} bytes; further output was not kept` }
        await fs.appendFile(outputFile, JSON.stringify(cap) + '\n')
        emit({ type: 'output', project, operationId: id, action: action.id, entry: cap })
        return
      }
      bytes += Buffer.byteLength(line)
      await fs.appendFile(outputFile, line)
      emit({ type: 'output', project, operationId: id, action: action.id, entry })
    }).catch(() => {})
    return chain
  }

  const controller = new AbortController()
  const timeout = AbortSignal.timeout(action.timeoutSeconds * 1000)
  const signals = [controller.signal, timeout, ...(signal ? [signal] : [])]
  inflight.set(`${project}/${id}`, controller)

  const done = (async () => {
    try {
      const result = await runProcess({
        command: '/bin/bash',
        args: ['-c', action.run],
        cwd: action.cwd,
        // Non-interactive by construction: no terminal, no credential prompts.
        env: { ...process.env, DEVPANEL_PROJECT_ACTION: action.id, DEVPANEL_OPERATION_ID: id, GIT_TERMINAL_PROMPT: '0', TERM: 'dumb' },
        signal: AbortSignal.any(signals),
        maxBuffer: 4 * 1024 * 1024,
        observe: {
          onSpawn: ({ pid }) => { operation.pid = pid; append('spawn', `pid ${pid}: ${action.run} (in ${action.cwd})`) },
          onOutput: (stream, chunk) => { append(stream, chunk) }
        }
      })
      operation.exitCode = result.code
      operation.signal = result.signal
      operation.cancelled = result.cancelled
      operation.timedOut = result.cancelled && timeout.aborted && !controller.signal.aborted && !signal?.aborted
      operation.durationMs = result.durationMs
      operation.stdoutTail = result.stdout.slice(-TAIL_CHARS)
      operation.stderrTail = result.stderr.slice(-TAIL_CHARS)
      operation.status = result.cancelled ? 'interrupted' : result.code === 0 ? 'completed' : 'failed'
      await append('exit', result.cancelled
        ? `interrupted (${operation.timedOut ? `deadline of ${action.timeoutSeconds}s reached` : 'stopped'}); process group terminated`
        : `exit code ${result.code}${result.signal ? ` (signal ${result.signal})` : ''} after ${Math.round(result.durationMs / 1000)}s`)
    } catch (error) {
      operation.status = 'failed'
      operation.error = error.message
      await append('exit', `could not run: ${error.message}`)
    } finally {
      operation.endedAt = new Date().toISOString()
      try {
        await chain
        await writeJson(recordFile, operation)
      } finally {
        inflight.delete(`${project}/${id}`)
        await lock.release()
      }
      emit({ type: 'ended', project, operationId: id, action: action.id, operation })
    }
    return operation
  })()

  return { operation, done }
  } catch (error) {
    await lock.release()
    throw error
  }
}

/** Stop a running operation this process owns. Resolves once the child is confirmed gone. */
export async function stopProjectAction (project, operationId, { issuesDir = ISSUES_DIR() } = {}) {
  assertProject(project)
  const controller = inflight.get(`${project}/${operationId}`)
  if (!controller) {
    const { operation } = await readOperation(project, operationId, { issuesDir })
    if (operation.status !== 'running') return operation
    throw fail('that operation belongs to a process that is no longer running; inspect it before retrying', 409)
  }
  controller.abort()
  // The record is rewritten by the runner once termination is confirmed.
  const deadline = Date.now() + 30000
  while (inflight.has(`${project}/${operationId}`) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
  return (await readOperation(project, operationId, { issuesDir })).operation
}

/**
 * What a model gets back: the record plus bounded output, so it can judge
 * whether the checkpoint did what it was meant to instead of trusting the exit code.
 */
export function operationReport (operation) {
  const { stdoutTail, stderrTail, ...rest } = operation
  return { ...rest, stdout: stdoutTail ?? '', stderr: stderrTail ?? '', outputBounded: `last ${TAIL_CHARS} characters of each stream` }
}
