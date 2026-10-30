import fs from 'node:fs/promises'
import path from 'node:path'

import { hostSettings } from '../config/host-settings.mjs'
import { runProcess } from './process.mjs'
import { engineGitEnv, HARDENED, LOCAL_TRANSPORT } from './engine-git.mjs'

/*
 * The panel's own Git store (host settings gitStore, under dataRoot): one bare
 * repository per project, <dataRoot>/repos/<project>.git, that borrows the
 * project's objects through objects/info/alternates. With it, everything the
 * engine writes into Git — snapshot objects, refs/devpanel/*, the candidate
 * branch devpanel/<issue>/<run> — lands in the store, and the project's own
 * repository is only ever read (and, for an operator-approved merge, fetched
 * into). Off by default: without the setting the project repository is the
 * store, as it always was.
 *
 * The store reads the project's history in place, so a snapshot's parent is a
 * project commit: rewriting the project's history and pruning it can leave an
 * old run's snapshot without its parent. Live runs never depend on that; their
 * engine directory holds its own depth-1 copy.
 */

const NL = String.fromCharCode(10)

async function git (args, { env = {} } = {}) {
  const result = await runProcess({ command: 'git', args: [...HARDENED, ...args], env: engineGitEnv(env), stdin: '', maxBuffer: 64 * 1024 * 1024 })
  if (result.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${(result.stderr || result.stdout).trim().split(NL)[0]}`)
  return result.stdout
}

/** Where a project's store lives, or null when the host keeps the project repository as the store. */
export function gitStoreDir (project, settings = hostSettings()) {
  if (!settings.gitStore || !settings.dataRoot || !project) return null
  if (path.basename(project) !== project || ['.', '..'].includes(project)) throw new Error(`invalid project identity for the Git store: ${project}`)
  return path.join(settings.dataRoot, 'repos', `${project}.git`)
}

/**
 * Create the store if it is missing and point its alternates at the project
 * repository's objects (rewritten when the project moved). Returns
 * { dir, objects, sourceObjects }, all real paths.
 */
export async function ensureGitStore ({ dir, sourceRepository }) {
  const source = await fs.realpath(sourceRepository)
  const sourceObjects = path.join(source, 'objects')
  if (!await fs.stat(path.join(dir, 'objects')).then((s) => s.isDirectory(), () => false)) {
    await fs.mkdir(path.dirname(dir), { recursive: true })
    await git(['-c', 'init.defaultBranch=devpanel', 'init', '-q', '--bare', dir])
    // Nothing the panel writes here is garbage: runs name their snapshots by ref,
    // and a store never needs repacking against its source.
    await git(['--git-dir', dir, 'config', 'gc.auto', '0'])
  }
  const real = await fs.realpath(dir)
  const alternates = path.join(real, 'objects', 'info', 'alternates')
  if ((await fs.readFile(alternates, 'utf8').catch(() => '')).trim() !== sourceObjects) {
    await fs.mkdir(path.dirname(alternates), { recursive: true })
    await fs.writeFile(alternates, sourceObjects + NL)
  }
  return { dir: real, objects: path.join(real, 'objects'), sourceObjects }
}

/** Whether `candidateRepository` is the panel's store of the repository whose common dir is `sourceCommon`. */
export async function isStoreOf (candidateRepository, sourceCommon) {
  const alternates = await fs.readFile(path.join(candidateRepository, 'objects', 'info', 'alternates'), 'utf8').catch(() => null)
  if (alternates === null) return false
  const sourceObjects = await fs.realpath(path.join(sourceCommon, 'objects')).catch(() => null)
  return Boolean(sourceObjects) && alternates.split(NL).map((l) => l.trim()).includes(sourceObjects)
}

/**
 * Bring a store's candidate into the project repository for an operator-approved
 * merge: objects only, through FETCH_HEAD, no ref written. Throws unless
 * `commit` is then present.
 */
export async function fetchFromStore ({ source, store, branch, commit }) {
  await git(['-C', source, ...LOCAL_TRANSPORT, 'fetch', '-q', '--no-tags', '--no-write-fetch-head', `file://${store}`, `refs/heads/${branch}`])
  await git(['-C', source, 'cat-file', '-e', `${commit}^{commit}`])
}
