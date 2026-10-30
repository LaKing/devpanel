#!/usr/bin/env node
/*
 * Reclaim disk from finished runs. Dry run unless --apply.
 *
 *   node tools/gc-runs.mjs                         report what would be reclaimed
 *   node tools/gc-runs.mjs --apply                 reclaim the always-safe kinds
 *   node tools/gc-runs.mjs --apply --remove-worktree <runId> [...]
 *                                                  also remove those runs' retained worktrees
 *
 * Always-safe kinds, for runs no process is driving:
 *   - checks/<n>/candidate.tar: the archive a check shipped. Its sha256 is in the
 *     check result; the candidate is rebuildable from base + patch.
 *   - integrity manifests nothing can read again: every before/after capture
 *     except the run's current checkpoint, the latest report's before/after, a
 *     pending invocation's baseline and the initial one.
 *   - legacy checkResults[].materialization.remoteEntries inside run.json, moved
 *     to checks/<n>/remote-entries.json (hash recorded), as new checks do.
 *
 * Retained worktrees are only reported, with why they are kept, unless named
 * with --remove-worktree: a worktree can hold the only copy of undelivered work.
 * A run that can still be resumed, recovered, finalized or given an integrity
 * disposition is refused unless --force. Base snapshot refs are listed, never
 * removed: checks and patch application rebuild candidates from them.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { writeJson } from '../server/runtime/persistence.mjs'
import { ownerLiveness } from '../server/runtime/lock.mjs'
import { supportedActions, LIVE_STATUSES } from '../server/supervisor.mjs'
import { repositoryGitArgs } from '../server/runtime/engine-git.mjs'
import { issuesRoot } from '../server/project-path.mjs'

const exec = promisify(execFile)
const ISSUES = issuesRoot()
const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const force = argv.includes('--force')
const removeWorktrees = new Set()
for (let i = 0; i < argv.length; i++) if (argv[i] === '--remove-worktree') while (argv[i + 1] && !argv[i + 1].startsWith('--')) removeWorktrees.add(argv[++i])

const human = (n) => n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`
const size = async (file) => (await fs.stat(file).catch(() => null))?.size ?? 0
async function du (dir) {
  try { return Number((await exec('du', ['-sb', dir], { maxBuffer: 1 << 20 })).stdout.split('\t')[0]) } catch { return 0 }
}
const exists = (p) => fs.access(p).then(() => true, () => false)

const totals = { tars: 0, manifests: 0, remoteEntries: 0, worktrees: 0 }
const kept = []
const skipped = []

async function lockHeldFor (issuePath, runId) {
  try {
    const record = JSON.parse(await fs.readFile(path.join(issuePath, '.run.lock'), 'utf8'))
    return record.owner?.runId === runId && await ownerLiveness(record.owner) === 'alive'
  } catch { return false }
}

async function collect (issuePath, runId, runDir, run) {
  // 1. Check archives.
  for (const dir of await fs.readdir(path.join(runDir, 'checks')).catch(() => [])) {
    const tar = path.join(runDir, 'checks', dir, 'candidate.tar')
    const bytes = await size(tar)
    if (!bytes) continue
    totals.tars += bytes
    if (apply) await fs.rm(tar, { force: true })
  }

  // 2. Integrity manifests nothing will read again.
  const integrity = run.integrity ?? {}
  const keep = new Set(['initial', integrity.checkpoint, integrity.latest?.before, integrity.latest?.after,
    ...Object.values(run.participants ?? {}).map((p) => p.pendingInvocation?.integrityBefore)].filter(Boolean))
  for (const file of await fs.readdir(path.join(runDir, 'integrity')).catch(() => [])) {
    if (!file.endsWith('.json') || file.endsWith('-report.json') || file.endsWith('-quarantine.json')) continue
    if (keep.has(file.slice(0, -5))) continue
    const full = path.join(runDir, 'integrity', file)
    totals.manifests += await size(full)
    if (apply) await fs.rm(full, { force: true })
  }

  // 3. Legacy remote listings inside run.json.
  let changed = false
  for (const check of run.checkResults ?? []) {
    const m = check.materialization
    if (!Array.isArray(m?.remoteEntries) || !check.dir) continue
    const text = JSON.stringify(m.remoteEntries)
    totals.remoteEntries += Buffer.byteLength(text)
    if (!apply) continue
    await fs.writeFile(path.join(runDir, check.dir, 'remote-entries.json'), text)
    m.remoteEntryCount = m.remoteEntries.length
    m.remoteEntriesFile = 'remote-entries.json'
    m.remoteEntriesSha256 = crypto.createHash('sha256').update(text).digest('hex')
    delete m.remoteEntries
    changed = true
  }
  if (changed) await writeJson(path.join(runDir, 'run.json'), run)

  // 4. Retained worktrees: reported; removed only when named.
  const wt = run.workspace?.path
  if (!wt || run.workspace.state === 'removed' || run.workspace.isolation === 'in-place' || !await exists(wt)) return
  const bytes = await du(wt)
  const actions = supportedActions(run)
  const live = actions.filter((a) => ['resume', 'recover', 'finalize', 'resolve-integrity', 'retry-input', 'refresh-checks', 'answer'].includes(a))
  const entry = { runId, issue: path.relative(ISSUES, issuePath), status: run.status, blockedReason: run.blockedReason ?? null, state: run.workspace.state, reason: run.workspace.retainedReason ?? null, actions, bytes }
  if (!removeWorktrees.has(runId)) { kept.push(entry); return }
  if (live.length && !force) { skipped.push({ ...entry, why: `still offers ${live.join(', ')}; pass --force to remove anyway` }); return }
  totals.worktrees += bytes
  if (!apply) { kept.push({ ...entry, wouldRemove: true }); return }
  // The repository that owns the worktree, asked of the worktree itself: run
  // records do not carry `issue.projectPath`, and without an owner the
  // directory went but git kept listing it as a (prunable) worktree.
  // Asked through the recorded git directory when there is one (engine-git.mjs):
  // the worktree's `.git` entry is seat-writable and is not followed.
  // A private repository (0d) is registered nowhere: the tree and its Git
  // directories simply go.
  if (run.workspace?.repository?.kind === 'private') {
    await fs.rm(wt, { recursive: true, force: true })
    await fs.rm(run.workspace.repository.root, { recursive: true, force: true })
    run.workspace = { ...run.workspace, state: 'removed', retainedReason: `removed by gc-runs at ${new Date().toISOString()} (operator named it)` }
    await writeJson(path.join(runDir, 'run.json'), run)
    return
  }
  const common = await exec('git', [...repositoryGitArgs(wt, run.workspace?.gitDir ?? null), 'rev-parse', '--path-format=absolute', '--git-common-dir']).then((r) => r.stdout.trim()).catch(() => null)
  const projectPath = common && path.basename(common) === '.git' ? path.dirname(common) : run.workspace?.source?.path ?? run.issue?.projectPath ?? null
  if (projectPath) await exec('git', ['-C', projectPath, 'worktree', 'remove', '--force', wt]).catch(() => {})
  if (await exists(wt)) await fs.rm(wt, { recursive: true, force: true })
  if (projectPath) await exec('git', ['-C', projectPath, 'worktree', 'prune']).catch(() => {})
  run.workspace = { ...run.workspace, state: 'removed', retainedReason: `removed by gc-runs at ${new Date().toISOString()} (operator named it)` }
  await writeJson(path.join(runDir, 'run.json'), run)
}

for (const project of await fs.readdir(ISSUES).catch(() => [])) {
  if (project.startsWith('.')) continue
  const projectDir = path.join(ISSUES, project)
  if (!(await fs.stat(projectDir)).isDirectory()) continue
  for (const issue of await fs.readdir(projectDir)) {
    const issuePath = path.join(projectDir, issue)
    const runsDir = path.join(issuePath, 'runs')
    for (const runId of await fs.readdir(runsDir).catch(() => [])) {
      if (runId.startsWith('worktree-') || runId.startsWith('workspace-')) continue
      const runDir = path.join(runsDir, runId)
      let run
      try { run = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8')) } catch { continue }
      if (LIVE_STATUSES.includes(run.status) || run.status === 'paused' || await lockHeldFor(issuePath, runId)) { skipped.push({ runId, issue, why: `run is ${run.status}` }); continue }
      await collect(issuePath, runId, runDir, run)
    }
  }
}

const verb = apply ? 'reclaimed' : 'reclaimable'
console.log(`check archives ${verb}: ${human(totals.tars)}`)
console.log(`superseded integrity manifests ${verb}: ${human(totals.manifests)}`)
console.log(`legacy remote listings moved out of run.json${apply ? '' : ' (would be)'}: ${human(totals.remoteEntries)}`)
if (removeWorktrees.size) console.log(`worktrees ${apply ? 'removed' : 'that would be removed'}: ${human(totals.worktrees)}`)
if (kept.length) {
  console.log(`\nretained worktrees (${human(kept.reduce((n, k) => n + k.bytes, 0))}); remove with --remove-worktree <runId>:`)
  for (const k of kept.sort((a, b) => b.bytes - a.bytes)) console.log(`  ${k.wouldRemove ? '[would remove] ' : ''}${human(k.bytes).padStart(9)}  ${k.runId}  ${k.status}${k.blockedReason ? `/${k.blockedReason}` : ''}  offers: ${k.actions.join(', ') || '—'}  ${k.issue}`)
}
for (const s of skipped) console.log(`skipped ${s.runId}: ${s.why}`)
if (!apply) console.log('\ndry run: nothing was changed. Re-run with --apply.')
