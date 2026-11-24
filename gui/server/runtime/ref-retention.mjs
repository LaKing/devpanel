import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

import { engineGitEnv, HARDENED } from './engine-git.mjs'
import { acquireSourceLocks, releaseSourceLocks } from './source-lock.mjs'
import { inspectJournalReadOnly } from './store.mjs'
import { selectUndeliveredApproval } from './carry-forward.mjs'
import { reconcilePending } from './run-control.mjs'
import { ownerLiveness } from './lock.mjs'
import { parsePatchContent } from '../staging-coverage.mjs'
import { isIssueId } from '../issues.js'

/*
 * Retiring refs/devpanel/* of runs that no longer need them (execution-contract.md
 * "Retiring refs/devpanel/*"). When in doubt, keep the ref: a leaked ref costs a
 * few objects, a wrongly retired one loses evidence.
 *
 * A ref goes only when its run sits in an open issue with a readable, settled
 * record whose retention is proven unneeded: an exact apply-to-source delivery
 * whose delivered bytes are committed at the destination's HEAD, or the run was
 * deleted (deleteRun). Packed issues are never read, so their refs stay.
 *
 * Every Git call here is strict (strictGit): replacement objects are ignored and
 * anything on stderr, even beside exit 0, aborts the pass. The deletion is one
 * `update-ref --no-deref --stdin` transaction under the delivery lock, each ref
 * against its expected oid, re-read while the transaction holds its locks.
 *
 * The caller passes `actionsOf` (supervisor.mjs supportedActions): importing the
 * supervisor here would make a cycle.
 */

export const RUN_ID = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}'
const PER_RUN = new RegExp(`^refs/devpanel/(base|candidates|reviewed)/(${RUN_ID})$`)
const PER_ATTEMPT = new RegExp(`^refs/devpanel/(reconciled|delivery-return)/(${RUN_ID})-(\\d+)(-source)?$`)
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const NUL = String.fromCharCode(0)
const SETTLED = ['completed', 'failed', 'cancelled']
const LIVE = ['preflighting', 'pending', 'running', 'stopping']

export class RefRetirementAborted extends Error {
  constructor (message, { kind = 'enumeration', command = null, stderr = null, at = null } = {}) {
    super(message)
    this.name = 'RefRetirementAborted'
    this.kind = kind
    this.command = command
    this.stderr = stderr
    this.at = at
  }

  toJSON () { return { aborted: true, kind: this.kind, message: this.message, command: this.command, stderr: this.stderr, at: this.at } }
}

const gitArgs = (args) => ['--no-replace-objects', ...HARDENED, ...args]
// No lazy fetch from a promisor remote: a read here must never write objects (a partial clone answers a missing object with an error instead).
const retirementEnv = () => engineGitEnv({ GIT_NO_LAZY_FETCH: '1' })

/**
 * Git as the retirement path runs it: no replacement objects, hardened, and
 * strict. A non-zero exit is `git-failed`; anything on stderr beside exit 0 is
 * `git-warning`. Only a clean call returns its stdout. Never pass -q/--quiet:
 * it silences exactly the warnings this exists to see.
 */
export function strictGit (args, { input = null } = {}) {
  const full = gitArgs(args)
  const command = `git ${args.join(' ')}`
  return new Promise((resolve, reject) => {
    const child = execFile('git', full, { env: retirementEnv(), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(new RefRetirementAborted(`${command}: ${error.message}`, { kind: 'git-failed', command, stderr: String(stderr ?? '') }))
      if (error) return reject(new RefRetirementAborted(`${command} exited ${error.code}: ${String(stderr).trim().split('\n')[0]}`, { kind: 'git-failed', command, stderr: String(stderr) }))
      if (String(stderr).length) return reject(new RefRetirementAborted(`${command} warned: ${String(stderr).trim().split('\n')[0]}`, { kind: 'git-warning', command, stderr: String(stderr) }))
      resolve(String(stdout))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

/** `{ family, runId }` of a ref this rule knows, else null (kept as another shape). */
export function parseRef (name) {
  const m = PER_RUN.exec(name) ?? PER_ATTEMPT.exec(name)
  return m ? { family: m[1], runId: m[2] } : null
}

/** Every refs/devpanel/* ref of a repository: `[{ ref, oid, symref }]`. Strict: a malformed line aborts. */
export async function listRefs (repository, names = ['refs/devpanel/']) {
  const out = await strictGit(['--git-dir', repository, 'for-each-ref', '--format=%(objectname) %(refname) %(symref)', ...names])
  const refs = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [oid, ref, symref = '', ...rest] = line.split(' ')
    if (!OID.test(oid) || !ref?.startsWith('refs/devpanel/') || rest.length) throw new RefRetirementAborted(`unreadable for-each-ref line: ${line}`, { kind: 'enumeration', at: { repository } })
    refs.push({ ref, oid, symref })
  }
  return refs
}

export const refFormat = async (repository) => (await strictGit(['--git-dir', repository, 'rev-parse', '--show-ref-format'])).trim()

/** The destination checkout as the commit proof binds it: its real path, Git common directory and HEAD commit. */
export async function retirementTarget (dir) {
  const real = await fs.realpath(dir)
  const common = (await strictGit(['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  return { path: real, repository: await fs.realpath(common), head: (await strictGit(['-C', real, 'rev-parse', '--verify', 'HEAD^{commit}'])).trim() }
}

const strictDir = async (dir, at) => {
  try { return await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
    throw new RefRetirementAborted(`cannot list ${dir}: ${error.code ?? error.message}`, { kind: 'enumeration', at })
  }
}

/** Whether a file exists; any answer but "yes" or "no such file" aborts. */
const strictExists = async (file, at) => {
  try { await fs.access(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new RefRetirementAborted(`cannot read ${file}: ${error.code ?? error.message}`, { kind: 'enumeration', at })
  }
}

/**
 * The open issues' runs, strictly: a directory that cannot be listed aborts.
 * A run record that cannot be read or parsed is kept as unreadable, not an
 * abort (its refs stay). Nothing is written; no run is read through store.readRun.
 */
export async function inventory (issuesRoot) {
  const issues = []
  for (const project of await strictDir(issuesRoot, { step: 'issues' })) {
    if (!project.isDirectory() || project.name.startsWith('.')) continue
    const projectDir = path.join(issuesRoot, project.name)
    for (const issue of await strictDir(projectDir, { project: project.name, step: 'project' })) {
      if (!issue.isDirectory() || issue.name.startsWith('.')) continue
      issues.push(await issueInventory({ issuePath: path.join(projectDir, issue.name), project: project.name, issueId: issue.name }))
    }
  }
  const byRun = new Map()
  for (const issue of issues) for (const entry of issue.runs) byRun.set(entry.runId, [...(byRun.get(entry.runId) ?? []), entry])
  return { issues, byRun }
}

/** One issue folder's runs, strictly. */
async function issueInventory ({ issuePath, project, issueId }) {
  const at = { project, issue: issueId, step: 'runs' }
  const archived = await strictExists(path.join(issuePath, '.archive.json'), at)
  let entries = []
  try { entries = await fs.readdir(path.join(issuePath, 'runs'), { withFileTypes: true }) } catch (error) {
    if (error.code !== 'ENOENT') throw new RefRetirementAborted(`cannot list ${path.join(issuePath, 'runs')}: ${error.code ?? error.message}`, { kind: 'enumeration', at })
  }
  // Only a folder the panel itself takes for an issue (issues.js isIssueId, getIssue's rule) can
  // authorize anything; another (a backup, a copy) is read so a run id there still counts as a holder.
  const issue = { project, issueId, issuePath, archived, notIssue: !isIssueId(issueId), runs: [] }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('worktree-') || e.name.startsWith('workspace-')) continue
    const file = path.join(issuePath, 'runs', e.name, 'run.json')
    let run = null, written = 0
    try {
      run = JSON.parse(await fs.readFile(file, 'utf8'))
      if (!run || typeof run !== 'object' || Array.isArray(run)) run = null
    } catch { run = null }
    if (run) {
      try { written = (await fs.stat(file)).mtimeMs } catch (error) {
        throw new RefRetirementAborted(`cannot stat ${file}: ${error.code ?? error.message}`, { kind: 'enumeration', at })
      }
    }
    issue.runs.push({ project, issueId, issuePath, runId: e.name, run, written, issue })
  }
  issue.unreadable = issue.runs.some((r) => !r.run)
  issue.seedRunId = issue.unreadable ? null : selectUndeliveredApproval(issuePath, issue.runs.map((r) => ({ id: r.runId, prior: r.run, written: r.written })))?.runId ?? null
  return issue
}

/** The repository the run's refs were written in, as recorded. */
export const recordedRepository = (run) => run?.workspace?.repository?.source ?? run?.workspace?.source?.repository ?? null

async function lockLive (issuePath, runId) {
  let record
  try { record = JSON.parse(await fs.readFile(path.join(issuePath, '.run.lock'), 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return false
    return true   // unreadable: cannot tell, so held
  }
  if (record?.owner?.runId !== runId) return false
  return (await ownerLiveness(record.owner)) !== 'dead'
}

async function publicationPhase (issuePath, runId) {
  try { return JSON.parse(await fs.readFile(path.join(issuePath, 'runs', runId, 'publication.json'), 'utf8'))?.phase ?? null } catch (error) {
    return error.code === 'ENOENT' ? null : 'unreadable'
  }
}

/**
 * The gates on one run, from its record and what was read beside it. `deleting`:
 * the run is being deleted (proof enough once the gates hold; its workspace goes
 * with it). Otherwise a passing run still needs proveDelivered.
 * Returns { keep: reason } or { ok: true }.
 */
export function retentionOf (entry, { actions, lockHeld = false, publication = null, journalClean = true, deleting = false } = {}) {
  if (entry.issue?.notIssue) return { keep: 'not-an-issue' }
  if (entry.issue?.archived) return { keep: 'archived-issue' }
  if (!entry.run) return { keep: 'unreadable-record' }
  if (entry.issue?.unreadable) return { keep: 'issue-has-unreadable-record' }
  if (!journalClean || publication === 'unreadable') return { keep: 'unreadable-record' }
  const run = entry.run
  if (run.runId !== entry.runId || run.issue?.project !== entry.project || run.issue?.id !== entry.issueId) return { keep: 'ambiguous-record' }
  if (LIVE.includes(run.status) || lockHeld) return { keep: 'live' }
  if (run.status === 'paused') return { keep: 'paused' }
  if (run.recovery?.required || run.journal?.recoveryRequired || Object.values(run.participants ?? {}).some((p) => p?.pendingInvocation || p?.state === 'recovery-required')) return { keep: 'recovery' }
  if (reconcilePending(run)) return { keep: 'reconcile-pending' }
  if (run.pendingDeliveryReturn) return { keep: 'delivery-return-pending' }
  if (['publishing', 'published'].includes(run.integration?.phase) || publication === 'publishing') return { keep: 'integration-pending' }
  const offered = actions(run)
  if (offered.includes('integrate')) return { keep: 'integration-pending' }
  if (offered.includes('finalize') || offered.includes('reconcile-delivery')) return { keep: 'finalize-able' }
  if (offered.includes('recover')) return { keep: 'recovery' }
  if (offered.includes('resume')) return { keep: 'resumable' }
  if (!SETTLED.includes(run.status)) return { keep: run.status === 'blocked' ? 'blocked' : 'not-settled' }
  if (offered.length !== 1 || offered[0] !== 'start-new') return { keep: `still-actionable:${offered.join(',')}` }
  if (entry.issue?.seedRunId === entry.runId) return { keep: 'carry-forward-seed' }
  if (deleting) return { ok: true }
  if (['active', 'retained'].includes(run.workspace?.state)) return { keep: 'worktree-retained' }
  const d = run.delivery, a = d?.application
  if (run.status !== 'completed' || d?.action !== 'apply-to-source' || !d.completedAt || run.landed || run.artifactApplication) return { keep: 'not-delivered' }
  if (!a || a.verified !== true || a.state !== 'complete' || ['merged', 'mergedFrom', 'merge', 'composed', 'owners'].some((k) => k in a) || d.merged || d.conflicts) return { keep: 'not-exact-delivery' }
  if (!d.revision || d.revision !== run.closure?.revision || d.reconstruction?.verified !== true || !a.path || a.path !== run.workspace?.source?.path) return { keep: 'not-exact-delivery' }
  return { ok: true }
}

/**
 * The gates on one inventoried run, reading what retentionOf needs beside the
 * record (lock, journal, publication journal), all without writing.
 */
export async function evaluateRun (entry, { actionsOf, deleting = false }) {
  if (!entry.run || entry.issue?.notIssue || entry.issue?.archived || entry.issue?.unreadable) return retentionOf(entry, { actions: actionsOf, deleting })
  const journal = await inspectJournalReadOnly(entry.issuePath, entry.runId)
  return retentionOf(entry, {
    actions: actionsOf,
    deleting,
    journalClean: journal.clean,
    lockHeld: await lockLive(entry.issuePath, entry.runId),
    publication: await publicationPhase(entry.issuePath, entry.runId)
  })
}

const realOrNull = (p) => p ? fs.realpath(p).catch(() => null) : Promise.resolve(null)
const sha256 = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')

/**
 * The proof that an exact apply-to-source delivery is committed: the patch is the
 * delivered one (its recorded hash) and covers the whole delivery (its paths are
 * changedPaths), the destination is the recorded checkout and repository, and its
 * HEAD's original tree holds every post-image (mode and full blob), deletions absent.
 * { proved: true, target } or { proved: false, reason }. Git warnings throw.
 */
export async function proveDelivered (entry) {
  const run = entry.run, d = run.delivery, ws = run.workspace
  const runDir = path.join(entry.issuePath, 'runs', entry.runId)
  const file = path.resolve(runDir, String(d.artifactRef ?? ''))
  if (!d.artifactRef || !file.startsWith(runDir + path.sep)) return { proved: false, reason: 'patch-unverified' }
  const bytes = await fs.readFile(file).catch(() => null)
  if (!bytes || !d.application?.patchHash || sha256(bytes) !== d.application.patchHash) return { proved: false, reason: 'patch-unverified' }
  const parsed = parsePatchContent(bytes.toString('utf8'))
  const changed = Array.isArray(d.changedPaths) ? d.changedPaths : []
  const paths = (parsed ?? []).map((e) => e.path)
  if (!parsed?.length || !changed.length || new Set(paths).size !== paths.length || new Set(changed).size !== changed.length ||
    paths.length !== changed.length || !changed.every((p) => paths.includes(p))) return { proved: false, reason: 'patch-unverified' }
  if (parsed.some((e) => e.post !== null && (!e.post.blob || !OID.test(e.post.blob) || !e.post.mode))) return { proved: false, reason: 'not-committed' }

  const recordedPath = ws?.source?.path, recordedRepo = ws?.source?.repository
  if (!recordedPath || !recordedRepo || !(await realOrNull(recordedPath))) return { proved: false, reason: 'destination-mismatch' }
  const target = await retirementTarget(recordedPath)
  if (target.path !== recordedPath || target.repository !== recordedRepo) return { proved: false, reason: 'destination-mismatch' }

  const listing = await strictGit(['--literal-pathspecs', '--git-dir', recordedRepo, 'ls-tree', '-r', '-t', '-z', '--full-tree', target.head, '--', ...paths])
  const tree = new Map()
  for (const line of listing.split(NUL)) {
    if (!line) continue
    const tab = line.indexOf('\t')
    const [mode, type, oid] = line.slice(0, tab).split(' ')
    tree.set(line.slice(tab + 1), { mode, type, oid })
  }
  for (const e of parsed) {
    const got = tree.get(e.path)
    if (e.post === null ? got : !got || got.type !== 'blob' || got.mode !== e.post.mode || got.oid !== e.post.blob) return { proved: false, reason: 'not-committed' }
  }
  return { proved: true, target }
}

const count = (map, key) => { map[key] = (map[key] ?? 0) + 1 }

/**
 * What the rule would retire, per repository (`repositories`: [{ repository,
 * projects }]). Read-only: no lock, nothing written; a destination proof made
 * here is a preview (retireRefs proves it again under the lock). Any enumeration
 * error or Git warning throws RefRetirementAborted; there is no partial result.
 */
export async function scanRetirement ({ issuesRoot, repositories, actionsOf }) {
  const index = await inventory(issuesRoot)
  const decisions = new Map()
  const decide = async (entry, repository) => {
    const key = `${entry.issuePath}\0${entry.runId}\0${repository}`
    if (decisions.has(key)) return decisions.get(key)
    let result = await evaluateRun(entry, { actionsOf })
    if (result.ok) {
      const recorded = await realOrNull(recordedRepository(entry.run))
      if (!recorded || recorded !== repository) result = { keep: 'repository-mismatch' }
      else {
        const proof = await proveDelivered(entry).catch((error) => { throw annotate(error, { project: entry.project, issue: entry.issueId, run: entry.runId, step: 'proof' }) })
        result = proof.proved ? { ok: true, target: proof.target } : { keep: proof.reason }
      }
    }
    decisions.set(key, result)
    return result
  }

  const reports = []
  for (const { repository: given, projects = [] } of repositories) {
    const at = { projects, repository: given, step: 'repository' }
    const repository = await fs.realpath(given).catch((error) => { throw new RefRetirementAborted(`repository ${given} cannot be read: ${error.code ?? error.message}`, { kind: 'enumeration', at }) })
    const format = await refFormat(repository).catch((error) => { throw annotate(error, at) })
    const refs = await listRefs(repository).catch((error) => { throw annotate(error, at) })
    const report = { repository, projects, refFormat: format, preview: true, total: refs.length, byFamily: {}, retire: [], kept: {} }
    for (const r of refs) count(report.byFamily, r.ref.split('/')[2] ?? 'other')
    if (format !== 'files') {
      report.blocked = 'unsupported-ref-format'
      report.kept['unsupported-ref-format'] = refs.length
      reports.push(report)
      continue
    }
    for (const r of refs) {
      if (r.symref) { count(report.kept, 'symbolic'); continue }
      const parsed = parseRef(r.ref)
      if (!parsed) { count(report.kept, 'other-shape'); continue }
      const holders = index.byRun.get(parsed.runId) ?? []
      if (!holders.length) { count(report.kept, 'unattributed'); continue }
      if (holders.length > 1) { count(report.kept, 'ambiguous'); continue }
      const result = await decide(holders[0], repository)
      if (!result.ok) { count(report.kept, result.keep); continue }
      report.retire.push({ ref: r.ref, oid: r.oid, runId: parsed.runId, project: holders[0].project, issue: holders[0].issueId, destination: result.target })
    }
    reports.push(report)
  }
  return { reports, index }
}

function annotate (error, at) {
  if (error instanceof RefRetirementAborted && !error.at) error.at = at
  return error
}

/** The reply lines of a running `update-ref --stdin`, awaited one at a time. */
function replies (child) {
  const queue = [], waiting = []
  let buffer = '', closed = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
      if (waiting.length) waiting.shift()(line); else queue.push(line)
    }
  })
  child.stdout.on('close', () => { closed = true; while (waiting.length) waiting.shift()(null) })
  return () => queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(null) : new Promise((resolve) => waiting.push(resolve))
}

const EXPECTED_OID_REFUSAL = /^fatal: prepare: cannot lock ref '([^']+)': is at [0-9a-f]+ but expected [0-9a-f]+\n?$/

/**
 * One transaction deleting `selected` ([{ ref, oid }]) in `repository`, each
 * against its oid, with --no-deref. While prepared (Git then holds every ref's
 * lock), the refs are read again: any that moved, vanished or turned symbolic
 * aborts the whole transaction (`changed`, nothing deleted). Returns
 * { retired, changed }. Anything else unexpected throws RefRetirementAborted.
 */
export async function deleteTransaction (repository, selected, { afterPrepare = null } = {}) {
  const command = 'git update-ref --no-deref --stdin'
  const child = spawn('git', gitArgs(['--git-dir', repository, 'update-ref', '--no-deref', '--stdin']), { env: retirementEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => { stderr += c })
  child.stdin.on('error', () => {})
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)))
  child.on('error', () => {})
  const next = replies(child)
  const send = (line) => child.stdin.write(line + '\n')
  const fail = async (message) => {
    child.stdin.end()
    await exited
    const refusal = EXPECTED_OID_REFUSAL.exec(stderr)
    if (refusal && selected.some((s) => s.ref === refusal[1])) return { retired: [], changed: selected.map((s) => s.ref) }
    throw new RefRetirementAborted(`${command}: ${message}${stderr ? `: ${stderr.trim().split('\n')[0]}` : ''}`, { kind: 'git-failed', command, stderr, at: { repository, step: 'transaction' } })
  }
  const expect = async (line, reply) => {
    send(line)
    const got = await next()
    return got === reply
  }
  if (!(await expect('start', 'start: ok'))) return fail('start was not acknowledged')
  for (const s of selected) send(`delete ${s.ref} ${s.oid}`)
  if (!(await expect('prepare', 'prepare: ok'))) return fail('prepare was not acknowledged')
  if (afterPrepare) await afterPrepare()
  let now
  try {
    now = await listRefs(repository, selected.map((s) => s.ref))
  } catch (error) {
    await expect('abort', 'abort: ok').catch(() => {})
    child.stdin.end()
    await exited
    throw annotate(error, { repository, step: 'prepared re-check' })
  }
  const exact = now.filter((r) => selected.some((s) => s.ref === r.ref))
  const intact = selected.every((s) => exact.some((r) => r.ref === s.ref && r.oid === s.oid && !r.symref)) && exact.length === selected.length
  if (!intact) {
    const aborted = await expect('abort', 'abort: ok')
    child.stdin.end()
    const code = await exited
    if (!aborted || code !== 0 || stderr) throw new RefRetirementAborted(`${command}: abort was not clean${stderr ? `: ${stderr.trim()}` : ''}`, { kind: 'git-failed', command, stderr, at: { repository, step: 'abort' } })
    return { retired: [], changed: selected.filter((s) => !exact.some((r) => r.ref === s.ref && r.oid === s.oid && !r.symref)).map((s) => s.ref) }
  }
  // Git has said something on stderr while preparing: a warning, never a commit after it.
  if (stderr) {
    await expect('abort', 'abort: ok').catch(() => {})
    child.stdin.end()
    await exited
    throw new RefRetirementAborted(`${command} warned before commit: ${stderr.trim().split('\n')[0]}`, { kind: 'git-warning', command, stderr, at: { repository, step: 'prepared' } })
  }
  if (!(await expect('commit', 'commit: ok'))) return fail('commit was not acknowledged')
  child.stdin.end()
  const code = await exited
  if (code !== 0 || stderr) throw new RefRetirementAborted(`${command} ${code !== 0 ? `exited ${code}` : 'warned'}: ${stderr.trim()}`, { kind: code !== 0 ? 'git-failed' : 'git-warning', command, stderr, at: { repository, step: 'commit' } })
  return { retired: selected.map((s) => s.ref), changed: [] }
}

/**
 * Retire `selected` ([{ ref, oid }]) in `repository` under the delivery lock of
 * every repository in `lockRepositories` (runtime/source-lock.mjs). Under the
 * lock: the ref format again, a strict re-listing (a name no longer direct at
 * its captured oid stays, `changed`), then `reprove` (the tool's proofs again;
 * returns the subset still proved and why the rest stays), then the transaction.
 */
export async function retireRefs ({ repository, lockRepositories = [repository], selected, reprove = null, clock, hooks = {} }) {
  const locks = await acquireSourceLocks([repository, ...lockRepositories], { purpose: 'ref-retirement', clock })
  try {
    if ((await refFormat(repository)) !== 'files') return { retired: [], changed: [], dropped: selected.map((s) => ({ ref: s.ref, reason: 'unsupported-ref-format' })), blocked: 'unsupported-ref-format' }
    const current = new Map((await listRefs(repository)).map((r) => [r.ref, r]))
    const changed = []
    let still = selected.filter((s) => {
      const r = current.get(s.ref)
      const ok = r && !r.symref && r.oid === s.oid
      if (!ok) changed.push(s.ref)
      return ok
    })
    let dropped = []
    if (reprove && still.length) ({ keep: still, dropped } = await reprove(still))
    if (!still.length) return { retired: [], changed, dropped }
    if (hooks.beforePrepare) await hooks.beforePrepare()
    const result = await deleteTransaction(repository, still, { afterPrepare: hooks.afterPrepare })
    return { retired: result.retired, changed: [...changed, ...result.changed], dropped }
  } finally {
    await releaseSourceLocks(locks)
  }
}

/**
 * Apply the scan: per repository, retire what it listed, the proofs made again
 * under the lock (destination re-read and equal to the preview's). Returns the
 * per-repository outcome; a Git warning or enumeration error throws.
 */
export async function applyRetirement ({ issuesRoot, repositories, actionsOf, clock, hooks = {} }) {
  const { reports } = await scanRetirement({ issuesRoot, repositories, actionsOf })
  const outcomes = []
  for (const report of reports) {
    if (report.blocked || !report.retire.length) { outcomes.push({ ...report, retired: [], changed: [], dropped: [] }); continue }
    const destinations = [...new Set(report.retire.map((r) => r.destination.repository))]
    const reprove = async (still) => {
      // The scan again, now under the lock: the gates and the proof, the destination (path, repository, HEAD) equal to the preview's.
      const again = await scanRetirement({ issuesRoot, repositories: [{ repository: report.repository, projects: report.projects }], actionsOf })
      const listed = again.reports[0].retire
      const keep = [], dropped = []
      for (const s of still) {
        const before = report.retire.find((r) => r.ref === s.ref)
        const now = listed.find((r) => r.ref === s.ref && r.oid === s.oid)
        if (now && JSON.stringify(now.destination) === JSON.stringify(before.destination)) keep.push(s); else dropped.push({ ref: s.ref, reason: now ? 'destination-mismatch' : 'no-longer-proved' })
      }
      return { keep, dropped }
    }
    if (hooks.beforeLock) await hooks.beforeLock(report)
    const result = await retireRefs({ repository: report.repository, lockRepositories: destinations, selected: report.retire.map(({ ref, oid }) => ({ ref, oid })), reprove, clock, hooks })
    outcomes.push({ ...report, preview: false, ...result })
  }
  return outcomes
}

/**
 * deleteRun's side, before anything is removed: the gates on the run being
 * deleted, read from the strict inventory of every open issue (the run id held
 * by this issue alone: a run of that id anywhere else keeps the refs), the
 * record read raw, and the refs named for it, captured with their oids.
 * { eligible, repository, refs } or { eligible: false, reason }.
 */
export async function planDeletedRun ({ issuesRoot, issuePath, runId, actionsOf }) {
  const holders = (await inventory(issuesRoot)).byRun.get(runId) ?? []
  if (holders.length > 1) return { eligible: false, reason: 'ambiguous' }
  const entry = holders[0]
  if (!entry || await realOrNull(entry.issuePath) !== await realOrNull(issuePath)) return { eligible: false, reason: 'unreadable-record' }
  const result = await evaluateRun(entry, { actionsOf, deleting: true })
  if (!result.ok) return { eligible: false, reason: result.keep }
  const repository = await realOrNull(recordedRepository(entry.run))
  if (!repository) return { eligible: false, reason: 'repository-mismatch' }
  if ((await refFormat(repository)) !== 'files') return { eligible: false, reason: 'unsupported-ref-format' }
  const refs = (await listRefs(repository)).filter((r) => !r.symref && parseRef(r.ref)?.runId === runId).map(({ ref, oid }) => ({ ref, oid }))
  return { eligible: true, repository, refs }
}
