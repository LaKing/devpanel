import { writeAtomic } from './persistence.mjs'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fingerprint, workspaceProjection } from './fingerprint.mjs'
import { worktreeGitArgs, engineGitEnv } from './engine-git.mjs'
import { GIT_OUTPUT_LIMIT, gitRead } from './working-tree.mjs'

const hash = (value) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
// The limit snapshot and gate read under: a lower one here would let a tree be
// admitted and cut, then fail this first capture after preflight was paid.
const git = async (dir, args, gitDir = null) => (await gitRead('git', [...worktreeGitArgs(dir, gitDir), ...args], {
  env: engineGitEnv({ GIT_OPTIONAL_LOCKS: '0' }), maxBuffer: GIT_OUTPUT_LIMIT
})).stdout

const statCache = new Map()
const STAT_CACHE_TREES = 8
// A file modified this close to the previous capture's start may have changed
// again within the same timestamp tick; it is always re-read.
const RACY_MARGIN_MS = 2000

// Source identity is independent of candidate revisions and of the mutable index.
// Include ignored/untracked source and tracked files even under normal exclusions.
export async function captureIntegrity (workspace, { clock, trackedPaths = [] } = {}) {
  await fs.access(workspace.path)
  const marker = await fs.lstat(path.join(workspace.path, '.git')).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  let repository = null
  const gitlinks = []
  if (marker || workspace.baseCommit) {
    if (!marker) throw new Error('workspace Git metadata disappeared')
    // The git directory recorded at provisioning, when there is one: the `.git`
    // entry in the worktree is seat-writable and is never followed here; what it
    // now says is recorded as `entry` and compared instead (engine-git.mjs).
    const recorded = workspace.gitDir ?? null
    const gitDir = recorded ?? (await git(workspace.path, ['rev-parse', '--absolute-git-dir'])).trim()
    const entry = recorded ? (marker.isFile() ? await fs.readFile(path.join(workspace.path, '.git'), 'utf8') : `not a file (${marker.isDirectory() ? 'directory' : marker.isSymbolicLink() ? 'link' : 'other'})`) : undefined
    // `<mode> <object> <stage>\t<path>` per entry. A gitlink (mode 160000, a
    // submodule pointer) has no content in this repository: git materialises
    // it as an empty directory, or a nested checkout when initialised. Its
    // identity is the commit it points to, so it is recorded as such rather
    // than required to exist as a file.
    const staged = (await git(workspace.path, ['ls-files', '--stage', '-z'], recorded)).split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t')
      const [mode, object] = line.slice(0, tab).split(' ')
      return { mode, object, path: line.slice(tab + 1) }
    })
    const gitlinkPaths = new Set(staged.filter((e) => e.mode === '160000').map((e) => e.path))
    trackedPaths = [...new Set([...trackedPaths, ...staged.map((e) => e.path)])].filter((p) => !gitlinkPaths.has(p)).sort()
    gitlinks.push(...staged.filter((e) => gitlinkPaths.has(e.path)).map((e) => ({ path: e.path, mode: 'gitlink', contentHash: hash(`gitlink:${e.object}`) })))
    repository = {
      gitDir,
      commonDir: (await git(workspace.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], recorded)).trim(),
      head: (await git(workspace.path, ['rev-parse', '--verify', 'HEAD'], recorded)).trim(),
      headRef: await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8'),
      // Logical entries/flags, not stat-cache bytes changed by a read-only git status.
      index: await git(workspace.path, ['ls-files', '--stage', '-v', '-z'], recorded),
      ...(entry !== undefined ? { entry } : {})
    }
  }
  // Stats from this process's previous capture of the same tree: an identical
  // stat keeps its hash (see fingerprint `reuse`). Held in memory only, so a
  // restarted server's first capture reads everything, and nothing on disk can
  // vouch for a file it did not read.
  const startedMs = Date.now()
  const previous = statCache.get(workspace.path) ?? null
  const record = new Map()
  const projection = workspaceProjection(workspace)
  if (projection.exclude) trackedPaths = trackedPaths.filter((rel) => !projection.exclude(rel))
  const source = await fingerprint(workspace.path, {
    strict: true, includePaths: trackedPaths, projection, clock, concurrency: 16, record,
    reuse: previous ? { entries: previous.entries, cutoffMs: previous.startedMs - RACY_MARGIN_MS } : null
  })
  statCache.delete(workspace.path)
  statCache.set(workspace.path, { startedMs, entries: record })
  while (statCache.size > STAT_CACHE_TREES) statCache.delete(statCache.keys().next().value)
  const entries = [...source.entries.map(({ path, mode, contentHash }) => ({ path, mode, contentHash })), ...gitlinks]
    .sort((a, b) => a.path.localeCompare(b.path))
  // Repositories inside the worktree (a `.git` entry below its root). Recorded
  // beside the hash, not in it, so captures taken before this existed still
  // compare equal; a new one is reported by integrityChanges.
  return { hash: hash({ entries, repository }), entries, repository, trackedPaths, nestedGit: source.nestedGit ?? [], at: source.computedAt }
}

export function integrityChanges (before, after) {
  const old = new Map(before.entries.map((e) => [e.path, e]))
  const fresh = new Map(after.entries.map((e) => [e.path, e]))
  const paths = [...new Set([...old.keys(), ...fresh.keys()])].sort()
    .filter((p) => JSON.stringify(old.get(p)) !== JSON.stringify(fresh.get(p)))
    .map((p) => ({ path: p, change: !old.has(p) ? 'added' : !fresh.has(p) ? 'deleted' : 'modified' }))
  // `entry` (the worktree's `.git` file) is compared only when both captures
  // recorded it, so a checkpoint taken before it existed is not a change.
  const entryChanged = before.repository?.entry !== undefined && after.repository?.entry !== undefined && before.repository.entry !== after.repository.entry
  const head = before.repository?.head !== after.repository?.head || before.repository?.headRef !== after.repository?.headRef || before.repository?.gitDir !== after.repository?.gitDir || before.repository?.commonDir !== after.repository?.commonDir || entryChanged
  const index = before.repository?.index !== after.repository?.index
  // A nested repository the engine did not provision (R9-3): the host must
  // never resolve it, so it is a change in its own right. Compared only when
  // both captures recorded the list.
  const nested = Array.isArray(before.nestedGit) && Array.isArray(after.nestedGit)
    ? after.nestedGit.filter((p) => !before.nestedGit.includes(p)) : []
  return { paths, head, index, entry: entryChanged, nested, changed: paths.length > 0 || head || index || nested.length > 0 }
}

export async function writeIntegrity (dir, name, value) {
  await fs.mkdir(path.join(dir, 'integrity'), { recursive: true })
  const file = path.join(dir, 'integrity', `${name}.json`)
  // Compact: a manifest lists every tracked path (tens of thousands on a large
  // checkout) and is written before and after every working turn; indentation
  // roughly doubled its size for a file only the engine reads.
  await writeAtomic(file, JSON.stringify(value) + '\n')
  return `integrity/${name}.json`
}

export const readIntegrity = async (dir, name) => JSON.parse(await fs.readFile(path.join(dir, 'integrity', `${name}.json`), 'utf8'))
