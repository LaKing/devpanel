import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import { inspectSourceRepository } from './runtime/source-repository.mjs'
import { classifyUntracked, describeBlocking, snapshotPathspec } from './runtime/working-tree.mjs'

const exec = promisify(execFile)
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

// The working-tree diff only feeds the key, so it is hashed as it streams: read
// whole it exceeded any buffer on a checkout whose materialized collections show
// as thousands of deletions (d250, 2026-10-31: "stdout maxBuffer length exceeded"
// refused a start).
function streamedHash (args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const digest = crypto.createHash('sha256')
    let stderr = ''
    child.stdout.on('data', (chunk) => digest.update(chunk))
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(digest.digest('hex')) : reject(Object.assign(new Error(`git ${args.join(' ')} exited ${code}`), { stderr })))
  })
}

// Re-read engine-owned launch inputs; a new preview ID or a model's assertion
// that something changed is not evidence that a persistent failure was fixed.
export async function inspectLaunchState ({ projectPath, workspace = {}, configHash }) {
  // Two runners: one bound to the project, one free — classification has to ask
  // a NESTED repository for its own HEAD.
  const raw = async (args) => (await exec('git', args, {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 32 * 1024 * 1024
  })).stdout
  const git = async (args) => raw(['-C', projectPath, ...args])
  // The same repository faults the start path refuses, in the same words, so a
  // checkout the panel would name precisely is not described to the supervisor
  // as merely "unreadable". Keyed by the fault, so an unchanged one stays
  // blocked and fixing it is a changed input.
  const fault = await inspectSourceRepository({ projectPath })
  if (fault) return { key: hash({ projectPath, condition: fault.code }), code: fault.code, resolvableBy: fault.resolvableBy, blockedReason: `${fault.message} ${fault.remedy}` }
  try {
    const head = (await git(['rev-parse', '--verify', 'HEAD'])).trim()
    // --untracked-files=no avoids parsing rename records or filenames as status.
    const tracked = await git(['status', '--porcelain=v1', '-z', '--untracked-files=no'])
    const base = workspace.base ?? 'head'
    if (base === 'head' && (workspace.requireCleanBase ?? true) && tracked.length) {
      // Committing the checkout is exactly what the project's commit action does,
      // so this one is resolvable by the supervisor rather than only by a person.
      return { key: hash({ projectPath, base, condition: 'DIRTY_BASE' }), code: 'DIRTY_BASE', resolvableBy: 'commit-action', blockedReason: `base policy "head" requires a clean checkout in ${projectPath}; clean it or explicitly select another base policy. A still-dirty checkout is not a useful retry.` }
    }
    const ref = typeof base === 'object' ? (await git(['rev-parse', '--verify', `${base.commit}^{commit}`])).trim() : head
    const excludes = workspace.excludes ?? []
    const diff = base === 'working-tree' ? await streamedHash(['-C', projectPath, 'diff', '--binary', 'HEAD', '--', ...snapshotPathspec(excludes)]) : null
    const untracked = []
    if (base === 'working-tree') {
      // One classification, shared with the snapshot the launch would build, so a
      // reading cannot be more permissive than what `git add -A` will accept.
      let scan = await classifyUntracked({ projectPath, run: raw, excludes })
      // A tree that moved mid-scan describes no single state. Read it once more
      // before saying anything about it.
      if (scan.unstable.length) scan = await classifyUntracked({ projectPath, run: raw, excludes })
      if (scan.blocking.length) {
        return { key: hash({ projectPath, base, condition: 'UNREADABLE_WORKTREE', paths: scan.blocking.map((b) => b.path) }), code: 'UNREADABLE_WORKTREE', resolvableBy: 'operator', blockedReason: `${describeBlocking(scan.blocking)}. A run cut from "working-tree" would fail to build its base, after preflight had already been paid for.` }
      }
      if (scan.unstable.length) {
        return { key: hash({ projectPath, base, condition: 'MOVING_WORKTREE', at: Date.now() }), code: 'MOVING_WORKTREE', resolvableBy: 'operator', blockedReason: `the working tree changed while it was being read (${scan.unstable[0].path}: ${scan.unstable[0].reason}); a base cut from it would not be the tree anyone inspected.` }
      }
      untracked.push(...scan.entries)
    }
    // `head` and the key travel together: the key proves whether the source
    // moved, the head says what it was when it was read.
    return { key: hash({ configHash, projectPath, base, ref, diff, untracked }), head, base, ref }
  } catch (error) {
    return { key: hash({ projectPath, condition: 'unreadable-repository' }), blockedReason: `cannot inspect the source checkout: ${error.stderr?.trim() || error.message}` }
  }
}
