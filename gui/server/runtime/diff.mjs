import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { worktreeGitArgs, engineGitEnv } from './engine-git.mjs'
import { fenceStubSet } from './fingerprint.mjs'

const exec = promisify(execFile)
const NL = String.fromCharCode(10)

/*
 * The candidate as a patch, for a reviewer.
 *
 * An auditor handed the author's report and a fingerprint has the author's
 * account of the change, not the change. This renders what the worktree
 * actually differs by from the base commit — tracked edits and untracked files
 * alike — as a unified diff the reviewer reads before anything else. Read-only:
 * `git diff` refreshes stat caches at most, which source integrity treats as no
 * change, and nothing here touches the index or HEAD.
 */
export const DEFAULT_DIFF_LIMIT = 256 * 1024
/** What the fingerprint leaves out (fingerprint.mjs DEFAULT_EXCLUDES); `.git` is never listed. */
const FINGERPRINT_EXCLUDES = ['node_modules', '.devpanel-lock']

/** Untracked paths without the fence's stubs: the fingerprint does not hold them, so the patch will not. */
const withoutFenceStubs = async (dir, paths, stubs) => {
  const fence = await fenceStubSet(dir, stubs)
  return paths.filter((rel) => !fence.has(rel))
}

const git = async (dir, args, { maxBuffer = 64 * 1024 * 1024, gitDir = null, timeout = 0 } = {}) => {
  try {
    return (await exec('git', [...worktreeGitArgs(dir, gitDir), ...args], { env: engineGitEnv({ GIT_OPTIONAL_LOCKS: '0' }), maxBuffer, timeout })).stdout
  } catch (error) {
    // `git diff --no-index` exits 1 when files differ; that is the normal case.
    if (typeof error.code === 'number' && error.code === 1 && typeof error.stdout === 'string') return error.stdout
    throw error
  }
}

/**
 * @returns {{ text: string, files: number, truncated: boolean, bytes: number }}
 */
export async function candidateDiff (workspacePath, { baseCommit = null, maxBytes = DEFAULT_DIFF_LIMIT, gitDir = null, fenceStubs = [] } = {}) {
  if (!workspacePath) return { text: '', files: 0, truncated: false, bytes: 0 }
  const base = baseCommit ?? 'HEAD'
  const parts = []
  let files = 0
  // Tracked changes, staged or not, against the base the worktree was cut from.
  const tracked = await git(workspacePath, ['diff', '--no-color', '--no-ext-diff', '--no-renames', base, '--'], { gitDir })
  if (tracked.trim()) { parts.push(tracked); files += (tracked.match(/^diff --git /gm) ?? []).length }
  // Untracked files are part of the candidate too; render each as a new file.
  // The scope is the fingerprint's, not .gitignore's: a file the writer adds
  // AND ignores is still delivered, so the reviewer sees it, marked (audit I10).
  const list = async (extra) => (await git(workspacePath, ['ls-files', '--others', '-z', ...extra], { gitDir })).split('\0').filter(Boolean)
  const untracked = (await withoutFenceStubs(workspacePath, await list(FINGERPRINT_EXCLUDES.map((e) => `--exclude=${e}`)), fenceStubs)).sort()
  const notIgnored = new Set(await list(['--exclude-standard']))
  for (const file of untracked) {
    files += 1
    const one = await git(workspacePath, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file], { gitDir }).catch(() => `diff --git a/${file} b/${file}${NL}new file (unreadable)${NL}`)
    const marked = notIgnored.has(file) ? '' : `# ${file}: matched by an ignore rule in the worktree, yet part of the candidate and delivered${NL}`
    parts.push(marked + one.replace(/^diff --git a\/dev\/null b\/(.*)$/m, 'diff --git a/$1 b/$1'))
  }
  let text = parts.join('')
  const bytes = Buffer.byteLength(text)
  let truncated = false
  if (bytes > maxBytes) {
    truncated = true
    text = Buffer.from(text).subarray(0, maxBytes).toString('utf8') + `${NL}${NL}[diff truncated at ${maxBytes} bytes of ${bytes}; read the rest in the worktree]${NL}`
  }
  if (!text) text = '(the worktree is identical to the base commit: no candidate changes)' + NL
  return { text, files, truncated, bytes }
}

/** The paths candidateDiff would show, without their content: tracked changes and untracked files. */
export async function candidatePaths (workspacePath, { baseCommit = null, gitDir = null, timeout = 30000, fenceStubs = [] } = {}) {
  const names = async (args) => (await git(workspacePath, args, { gitDir, timeout })).split('\0').filter(Boolean)
  const tracked = await names(['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', baseCommit ?? 'HEAD', '--'])
  const untracked = await names(['ls-files', '--others', '-z', ...FINGERPRINT_EXCLUDES.map((e) => `--exclude=${e}`)])
  return [...new Set([...tracked, ...await withoutFenceStubs(workspacePath, untracked, fenceStubs)])]
}
