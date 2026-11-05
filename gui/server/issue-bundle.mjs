import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { writeJson } from './runtime/persistence.mjs'
import { renderResult } from './run-result-step.mjs'
import { worktreeGitArgs, engineGitEnv } from './runtime/engine-git.mjs'
import { withLock } from './runtime/lock.mjs'

/*
 * An archived issue, packed.
 *
 * Archiving takes an issue out of the project's folder and keeps it as one
 * compressed bundle under `issues/.archive/<project>/`:
 *
 *   <id>.tar.gz      the whole issue folder, minus run worktrees (checkouts of
 *                    the project). Every run's patch is inside, and a worktree's
 *                    own changes are saved as a patch before it goes.
 *   <id>.json        what is shown without unpacking: the issue as the lists
 *                    describe it, each run's summary, and each run's result
 *   <id>.runs.json   the run records, for the supervisor's history statistics
 *   <id>.notes.json  notes the engine owed the issue after it was archived, kept
 *                    beside the bundle, which stays as verified; a restore turns
 *                    them into steps (issues.js createEngineNote)
 *   <id>.coverage-receipts.json  which notes this issue's own releases still owe
 *                    others, since packing (staging-coverage.mjs)
 *   <id>.repeat-lookup.json  the outcome of a repeat lookup that was still pending when
 *                    the report was opened, in whatever state the issue is since
 *                    (report-identity.mjs); it outlives a restore, as notes do
 *
 * Packing is verified before anything is removed: the bundle must list every
 * file that was packed. Restore unpacks it back into the project folder, after
 * which the three files go. A run cannot be resumed after its issue was packed
 * — its worktree is gone — but everything it recorded comes back.
 *
 * An id names one issue. The bundle, its summary and its run records hold their id
 * (archivedIdHolders): packing refuses to replace them and restore refuses to replace
 * a folder, each naming both, and a bundle is published with link(), which cannot
 * replace one. `<bundle>.lock` keeps one pack or restore per id. `.moves.lock` is held
 * only for the moment an issue moves between folder and bundle, and by a listing that
 * must see each issue exactly once (report-identity.mjs).
 */

const run = promisify(execFile)
const BIG = { maxBuffer: 256 * 1024 * 1024 }

export const archiveRoot = (issuesDir) => path.join(issuesDir, '.archive')
export function bundleFiles (issuesDir, project, id) {
  const base = path.join(archiveRoot(issuesDir), project, id)
  return { dir: path.dirname(base), bundle: `${base}.tar.gz`, summary: `${base}.json`, runs: `${base}.runs.json`, notes: `${base}.notes.json`, receipts: `${base}.coverage-receipts.json`, repeatLookup: `${base}.repeat-lookup.json`, lock: `${base}.tar.gz.lock` }
}

const exists = (p) => fs.access(p).then(() => true, () => false)
const readJson = (file) => fs.readFile(file, 'utf8').then(JSON.parse)

/** The files that say an archived issue has this id; notes and receipts wait for one and hold nothing. */
export async function archivedIdHolders (issuesDir, project, id) {
  const { bundle, summary, runs } = bundleFiles(issuesDir, project, id)
  const held = await Promise.all([bundle, summary, runs].map(async (f) => (await exists(f) ? f : null)))
  return held.filter(Boolean)
}

/** A folder and an archived issue of one id, refused by name: neither may replace the other. */
function collision (issuesDir, project, id, doing) {
  const folder = path.join(issuesDir, project, id)
  const { bundle } = bundleFiles(issuesDir, project, id)
  return Object.assign(new Error(`${doing} was refused: the folder ${folder} and the archived issue ${bundle} have the same id, ${id}, and neither may replace the other.`), { status: 409, collision: { id, folder, bundle } })
}

/** Refuses when archiving this folder would land on an archived issue of its id. */
export async function refuseArchiveOverBundle (issuesDir, project, id) {
  if ((await archivedIdHolders(issuesDir, project, id)).length) throw collision(issuesDir, project, id, `Archiving ${id}`)
}

/** Held only while an issue moves between folder and bundle, or while a listing must see each issue once. */
export function withMoves (issuesDir, project, fn, { waitMs = 10000 } = {}) {
  return withLock(path.join(archiveRoot(issuesDir), project, '.moves.lock'), { purpose: 'issue-moves', waitMs }, fn)
}

/** Locks mean nothing once packed; worktrees are left out only once their changes are saved. */
const lock = (rel) => /^\.(run|step-alloc)\.lock$/.test(rel)

async function filesIn (dir, rel = '') {
  const out = []
  for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (lock(child)) continue
    if (entry.isDirectory()) out.push(...await filesIn(dir, child))
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(child)
  }
  return out
}

/** Each run's record, with the configuration hash it was cut from made explicit. */
async function runRecords (dir) {
  const runsDir = path.join(dir, 'runs')
  const out = []
  for (const entry of await fs.readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || /^(worktree|workspace)-/.test(entry.name)) continue
    const record = await readJson(path.join(runsDir, entry.name, 'run.json')).catch(() => null)
    if (!record) continue
    if (!record.playbook?.configHash) {
      const snapshot = await readJson(path.join(runsDir, entry.name, 'resolved-playbook.json')).catch(() => null)
      const hash = snapshot?.configHash ?? snapshot?.snapshotOf ?? null
      if (hash) record.playbook = { ...record.playbook, configHash: hash }
    }
    const outputs = {}
    for (const f of await fs.readdir(path.join(runsDir, entry.name, 'outputs')).catch(() => [])) {
      const o = await readJson(path.join(runsDir, entry.name, 'outputs', f)).catch(() => null)
      if (o) outputs[f.replace(/\.json$/, '')] = o
    }
    out.push({ record, outputs })
  }
  return out.sort((a, b) => String(a.record.startedAt ?? '').localeCompare(String(b.record.startedAt ?? '')))
}

/** Each run's result: its written result.md, else the same account rendered now. */
async function results (dir, runs) {
  const reservations = await readJson(path.join(dir, '.step-reservations.json')).catch(() => [])
  const written = new Map((Array.isArray(reservations) ? reservations : [])
    .map((r) => [/^run-result:(.+)$/.exec(r?.invocationId ?? '')?.[1], r?.folder]).filter(([id]) => id))
  const out = []
  for (const { record, outputs } of runs) {
    const folder = written.get(record.runId)
    const text = folder ? await fs.readFile(path.join(dir, folder, 'result.md'), 'utf8').catch(() => null) : null
    out.push({ runId: record.runId, startedAt: record.startedAt ?? null, status: record.status, folder: folder ?? null, text: text ?? renderResult(record, outputs) })
  }
  return out
}

/** Shared staging deployments of this issue, retries included: what its packed page and the pending list still read. */
async function stagingOperations (dir) {
  const names = await fs.readdir(path.join(dir, 'operations')).catch(() => [])
  const out = []
  for (const name of names.filter((n) => /^staging-deployment(-.+)?\.json$/.test(n))) {
    const op = await readJson(path.join(dir, 'operations', name)).catch(() => null)
    if (op) out.push({ id: op.id ?? null, status: op.status ?? null, startedAt: op.startedAt ?? null, endedAt: op.endedAt ?? null, ...(op.coverage ? { coverage: op.coverage } : {}) })
  }
  return out
}

const PATCH_LIMIT = 100 * 1024 * 1024

/*
 * A worktree can hold the only copy of work no run delivered. Before one goes,
 * its content is saved as a patch against the run's base, built in a
 * throwaway index so the worktree and its own index are not touched. Anything
 * that cannot be saved stops the packing: the issue stays as it is.
 */
async function saveWorktreeChanges (dir, runs) {
  const saved = []
  for (const { record } of runs) {
    const wt = path.join(dir, 'runs', `worktree-${record.runId}`)
    if (!await exists(wt)) continue
    // Not a checkout this run made (no git link): kept in the bundle as it is.
    if (!await exists(path.join(wt, '.git'))) continue
    const base = record.workspace?.baseCommit
    if (!base) throw Object.assign(new Error(`run ${record.runId} kept a worktree but no base commit; its changes cannot be saved, so the issue was not packed`), { status: 409 })
    const index = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-archive-')), 'index')
    const env = engineGitEnv({ GIT_INDEX_FILE: index })
    try {
      // Named git directory when the run recorded one (engine-git.mjs): the
      // worktree's own `.git` entry is seat-writable and is not followed.
      const g = worktreeGitArgs(wt, record.workspace?.gitDir ?? null)
      await run('git', [...g, 'read-tree', base], { env, ...BIG })
      await run('git', [...g, 'add', '-A'], { env, ...BIG })
      const { stdout } = await run('git', [...g, 'diff', '--cached', '--binary', base], { env, maxBuffer: PATCH_LIMIT, encoding: 'buffer' })
      if (stdout.length) {
        const target = path.join(dir, 'runs', record.runId, 'artifacts', 'worktree-at-archive.patch')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, stdout)
      }
    } catch (error) {
      throw Object.assign(new Error(`the worktree of run ${record.runId} could not be saved as a patch (${error.message.split('\n')[0]}); the issue was not packed`), { status: 409 })
    } finally {
      await fs.rm(path.dirname(index), { recursive: true, force: true })
    }
    saved.push(`worktree-${record.runId}`)
  }
  return saved
}

/**
 * Pack an issue folder into its bundle and remove the folder.
 * `issue` is the issue as the lists describe it (issues.js readIssue), kept
 * as the summary. `releaseWorktrees(dir)` hands run worktrees back to git.
 */
export async function packIssue ({ issuesDir, project, id, issue, releaseWorktrees }) {
  const dir = path.join(issuesDir, project, id)
  const files = bundleFiles(issuesDir, project, id)
  await fs.mkdir(files.dir, { recursive: true })
  return withLock(files.lock, { purpose: 'issue-pack' }, async () => {
    // Before a worktree is touched: a refused issue stays exactly as it was.
    if (!await exists(dir)) throw Object.assign(new Error(`${id} has no folder to pack; it was packed already.`), { status: 409 })
    await refuseArchiveOverBundle(issuesDir, project, id)

    const runs = await runRecords(dir)
    const { runs: runList = [], ...described } = issue
    const summary = {
      version: 1,
      issue: { ...described, path: null, packed: true },
      runs: runList,
      results: await results(dir, runs),
      operations: await stagingOperations(dir),
      packedAt: new Date().toISOString()
    }

    // Only worktrees whose changes are now saved go; any other stays in the bundle.
    const saved = await saveWorktreeChanges(dir, runs)
    await releaseWorktrees?.(saved.map((name) => path.join(dir, 'runs', name)))
    for (const name of saved) await fs.rm(path.join(dir, 'runs', name), { recursive: true, force: true })
    // A private repository (0d) goes with its worktree: its base and published
    // candidates are refs in the source repository, and it is no record.
    for (const { record } of runs) {
      const root = record.workspace?.repository?.kind === 'private' ? path.join(dir, 'runs', record.runId, 'git') : null
      if (root && !await exists(path.join(dir, 'runs', `worktree-${record.runId}`))) await fs.rm(root, { recursive: true, force: true })
    }

    const packed = await filesIn(dir)
    // This attempt's own file: nothing else can name what becomes the bundle, and tar has exited before it does.
    const work = await fs.mkdtemp(path.join(files.dir, '.pack-'))
    const tmp = path.join(work, 'bundle.tar.gz')
    let removing
    try {
      await run('tar', ['-C', path.join(issuesDir, project), '--exclude', `${id}/.run.lock`, '--exclude', `${id}/.step-alloc.lock`, '-czf', tmp, id], BIG)
      // Verified before anything is removed: the bundle unpacks, and holds every
      // file that was there. Unpacked rather than listed: tar escapes names in a
      // listing (a seat once created a file named with git's C-quoting, `\\303\\237…`),
      // GNU tar's way out (--quoting-style=literal) does not exist in macOS's bsdtar,
      // and an unpacked tree is compared by the same filesIn() whatever tar wrote.
      const verifyDir = await fs.mkdtemp(path.join(path.dirname(files.bundle), '.verify-'))
      let unpacked
      try {
        await run('tar', ['-C', verifyDir, '-xzf', tmp], BIG)
        unpacked = new Set(await filesIn(path.join(verifyDir, id)).catch(() => []))
      } finally {
        await fs.rm(verifyDir, { recursive: true, force: true })
      }
      const missing = packed.filter((f) => !unpacked.has(f))
      if (missing.length) {
        throw Object.assign(new Error(`The archive bundle is missing ${missing.length} file(s) (${missing.slice(0, 3).join(', ')}); the issue was left unpacked.`), { status: 500 })
      }
      const unpackedBytes = (await Promise.all(packed.map((f) => fs.lstat(path.join(dir, f)).then((s) => s.size, () => 0)))).reduce((a, b) => a + b, 0)
      await withMoves(issuesDir, project, async () => {
        // link(), not rename(): it cannot replace a bundle another writer put there.
        try { await fs.link(tmp, files.bundle) } catch (error) {
          if (error.code === 'EEXIST') throw collision(issuesDir, project, id, `Archiving ${id}`)
          throw error
        }
        await fs.rm(work, { recursive: true, force: true })
        summary.bundle = { bytes: (await fs.stat(files.bundle)).size, unpackedBytes, files: packed.length }
        await writeJson(files.runs, runs.map((r) => r.record))
        await writeJson(files.summary, summary)
        // Out of reach in one step, then removed: a request reading the issue meanwhile sees it whole or
        // not at all. It never sees a run whose journal has gone, and cannot write into a tree being removed.
        removing = await fs.mkdtemp(path.join(path.dirname(dir), '.removing-'))
        await fs.rename(dir, path.join(removing, id))
      })
    } finally {
      await fs.rm(work, { recursive: true, force: true })
    }
    await fs.rm(removing, { recursive: true, force: true })
    return summary
  })
}

/**
 * Unpack a bundle back into the project folder; the bundle files go once it is there.
 * Extracted privately and published whole. mkdir reserves the destination, so anything
 * already there, empty or not, refuses the restore, and rename replaces only that
 * reservation. `beforePublish` and `afterClaim` exist only so a test can land between the steps.
 */
export async function unpackIssue ({ issuesDir, project, id, beforePublish = null, afterClaim = null }) {
  const files = bundleFiles(issuesDir, project, id)
  const target = path.join(issuesDir, project, id)
  await fs.mkdir(files.dir, { recursive: true })
  return withLock(files.lock, { purpose: 'issue-restore' }, async () => {
    const held = await archivedIdHolders(issuesDir, project, id)
    if (await exists(target)) {
      // The other restore got here first: nothing is extracted over what has happened since.
      if (!held.length) return target
      throw collision(issuesDir, project, id, `Restoring ${id}`)
    }
    const work = await fs.mkdtemp(path.join(issuesDir, project, '.restoring-'))
    try {
      await run('tar', ['-C', work, '-xzf', files.bundle], BIG)
      const extracted = path.join(work, id)
      if (!await exists(extracted)) {
        throw Object.assign(new Error('The bundle did not unpack to the issue folder.'), { status: 500 })
      }
      // Worktrees did not travel: say so on each run, so nothing offers to resume one.
      for (const entry of await fs.readdir(path.join(extracted, 'runs'), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || /^(worktree|workspace)-/.test(entry.name)) continue
        const file = path.join(extracted, 'runs', entry.name, 'run.json')
        const record = await readJson(file).catch(() => null)
        if (record?.workspace && record.workspace.state !== 'removed') {
          record.workspace = { ...record.workspace, state: 'removed', retainedReason: 'removed when the issue was archived' }
          await writeJson(file, record)
        }
      }
      await beforePublish?.()
      await withMoves(issuesDir, project, async () => {
        try { await fs.mkdir(target) } catch (error) {
          if (error.code === 'EEXIST') throw collision(issuesDir, project, id, `Restoring ${id}`)
          throw error
        }
        await afterClaim?.()
        try { await fs.rename(extracted, target) } catch (error) {
          if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
          // Someone wrote into the reservation: what they wrote stays, and so does the bundle.
          await fs.rmdir(target).catch(() => {})
          throw collision(issuesDir, project, id, `Restoring ${id}`)
        }
        await Promise.all([files.bundle, files.summary, files.runs, files.receipts].map((f) => fs.rm(f, { force: true })))
      })
    } finally {
      await fs.rm(work, { recursive: true, force: true })
    }
    return target
  })
}

/** The summary of one packed issue, or null. */
export async function packedSummary (issuesDir, project, id) {
  return readJson(bundleFiles(issuesDir, project, id).summary).catch(() => null)
}

/** Every packed issue of a project, as summaries. */
export async function packedSummaries (issuesDir, project) {
  const dir = path.join(archiveRoot(issuesDir), project)
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => /^\d{4}-\d{2}-\d{2}-.+\.json$/.test(n) && !n.endsWith('.runs.json') && !n.endsWith('.notes.json') && !n.endsWith('.coverage-receipts.json') && !n.endsWith('.repeat-lookup.json'))
  const out = []
  for (const n of names) {
    const s = await readJson(path.join(dir, n)).catch(() => null)
    if (s?.issue) out.push(s)
  }
  return out
}

/** The run records of a packed issue, for history statistics. */
export async function packedRuns (issuesDir, project, id) {
  return readJson(bundleFiles(issuesDir, project, id).runs).catch(() => [])
}

/** Remove a packed issue for good. */
export async function deletePacked (issuesDir, project, id) {
  const files = bundleFiles(issuesDir, project, id)
  await Promise.all([files.bundle, files.summary, files.runs, files.notes, files.receipts, files.repeatLookup].map((f) => fs.rm(f, { force: true })))
}
