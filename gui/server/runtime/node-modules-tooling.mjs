import fs from 'node:fs/promises'
import path from 'node:path'

import { resolveMounts } from './tooling-mounts.mjs'

/*
 * Seat tooling found in a project's checkout (host settings `tooling.nodeModules`,
 * opt-in): what a projects/<id>.yaml would declare by hand for an npm project,
 * for every project that declares no tooling of its own.
 *
 *   - Each node_modules directory beside a package.json (the checkout's root and
 *     up to MAX_DEPTH levels below, dot directories and node_modules skipped) is a
 *     read-only mount at the same worktree-relative path.
 *   - It is taken only as a real directory whose real path is that path inside the
 *     checkout: a symlink, or a path that leaves the checkout through a link, is
 *     left out (`skipped`, with the reason), never followed. Otherwise the project
 *     tree would decide what a seat may read: a node_modules link to ~/.ssh,
 *     created by anyone who can write the checkout (a delivered patch included),
 *     would be mounted for the next run. Each one also passes the declared-mount
 *     checks (resolveMounts: forbidden roots, the panel's data, a repository root,
 *     source the snapshot selects); a failure leaves it out as well.
 *   - Its build caches (CACHE_DIRS) are masked: in the fence each is an empty
 *     writable directory, whether or not the checkout has one (harness/fence.mjs
 *     maskedMountArgs). The checkout's own hold derived data that may embed values
 *     from the project's git-ignored configuration, and the tools write there
 *     (vite's bundled config in .vite-temp, vitest's results cache).
 *   - Its package.json `test` and `lint` scripts become declared commands
 *     (`npm run <script> -- <args>`), run offline like every declared command.
 *
 * The engine checks an automatic mount again before each turn (still a real
 * directory at its recorded real path), since the checkout may change after
 * resolution.
 */

export const CACHE_DIRS = ['.cache', '.vite', '.vite-temp', '.vitest', '.vitest-cache']
export const SCRIPTS = ['test', 'lint']
const MAX_DEPTH = 3

async function readPackage (dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) } catch { return null }
}

/** The package.json directories (relative, posix) that hold a node_modules entry, with the parsed package.json. */
async function packageDirs (root) {
  const found = []
  async function walk (rel, depth) {
    const dir = path.join(root, rel)
    const pkg = await readPackage(dir)
    if (pkg && await fs.lstat(path.join(dir, 'node_modules')).then(() => true, () => false)) found.push({ rel, pkg })
    if (depth >= MAX_DEPTH) return
    // Dirent.isDirectory() is false for a symlink, so the walk never leaves the checkout.
    const entries = (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1)
    }
  }
  await walk('', 0)
  return found
}

/**
 * The tooling a project's checkout provides: { mounts, commands, skipped }, each
 * mount `{ target, source, sourceReal, auto: true, masks }`, each command
 * `{ id, cwd?, run, description, auto: true }`, each skipped `{ target, reason }`.
 */
export async function nodeModulesTooling (projectPath) {
  const out = { mounts: [], commands: [], skipped: [] }
  const root = await fs.realpath(projectPath).catch(() => null)
  if (!root) return out
  for (const { rel, pkg } of await packageDirs(root)) {
    const target = rel ? `${rel}/node_modules` : 'node_modules'
    const lexical = path.join(root, target)
    const st = await fs.lstat(lexical)
    if (st.isSymbolicLink() || !st.isDirectory()) { out.skipped.push({ target, reason: 'is a symlink or not a directory; only a real directory in the checkout is mounted' }); continue }
    if (await fs.realpath(lexical).catch(() => null) !== lexical) { out.skipped.push({ target, reason: 'resolves outside its place in the checkout' }); continue }
    const { mounts: [mount], errors } = await resolveMounts([{ target, source: target }], { projectPath: root })
    if (errors.length) { out.skipped.push({ target, reason: errors[0].message }); continue }
    out.mounts.push({ ...mount, auto: true, masks: [...CACHE_DIRS] })
    for (const script of SCRIPTS) {
      if (typeof pkg.scripts?.[script] !== 'string') continue
      out.commands.push({
        id: rel ? `${rel.replaceAll('/', '-')}-${script}` : script,
        ...(rel ? { cwd: rel } : {}),
        run: `npm run ${script} -- <args>`,
        description: `the "${script}" script of ${rel ? `${rel}/package.json` : 'package.json'} (${pkg.scripts[script]}) with the mounted ${target}; <args> are optional arguments for it (test files to narrow a run), or nothing`,
        auto: true
      })
    }
  }
  return out
}
