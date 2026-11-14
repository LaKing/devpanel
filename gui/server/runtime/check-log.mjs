import fs from 'node:fs/promises'
import path from 'node:path'
import { readRun, runDir } from './store.mjs'

/** Read only an engine-recorded command log, with a bounded tail for model context. */
export async function readCheckLog ({ issuePath, runId, check, command }) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId) || !/^(?:\d{3,}|diagnostic-\d{3,})$/.test(check)) throw Error('Invalid run or check identifier')
  const run = await readRun(issuePath, runId)
  // A retried check keeps its earlier attempts on the result that replaced them; a refused reconcile keeps its check on its entry; a diagnostic drive is its own record.
  const result = [...(run.checkResults ?? []), ...(run.diagnosticDrives ?? []), ...(run.reconciliations ?? []).map(r => r.checks).filter(c => c?.dir)].flatMap(c => [c, ...(c.attempts ?? []).map(a => ({ ...a, revision: c.revision }))]).find(c => c.dir === `checks/${check}`)
  const record = result?.commands?.find(c => c.id === command)
  if (!record || !record.log || path.basename(record.log) !== record.log) throw Error('No recorded command log matches this check')
  const root = await fs.realpath(runDir(issuePath, runId))
  const file = await fs.realpath(path.join(root, result.dir, record.log))
  if (!file.startsWith(root + path.sep)) throw Error('Check log escapes its run')
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - 32000)
    const bytes = Buffer.alloc(size - start)
    await handle.read(bytes, 0, bytes.length, start)
    return { runId, check, command, revision: result.revision ?? null, ...(result.diagnostic ? { diagnostic: true, ofRevision: result.ofRevision } : {}), result: result.result, exitCode: record.exitCode,
      text: bytes.toString('utf8'), truncated: start > 0, bytes: size, path: `checks/${check}/${record.log}` }
  } finally { await handle.close() }
}

export const VERIFICATION_PAGE_CHARS = 32000

/**
 * Read one file of the full verification's records, or list one of its directories, for the top-level
 * supervisor (get_verification_file): a cycle's cycle.json, an instance drive's drive.json and the evidence
 * its instance left (full-verification.mjs). Confined to `verificationDir`: `rel` is relative to it, or
 * absolute inside it as a verification-ended event names it; whatever links resolve to must stay inside,
 * and `..`, NUL or a path outside is refused. Text is paged by `offset` (characters), never whole.
 */
export async function readVerificationFile ({ verificationDir, path: rel, offset = 0 }) {
  if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) throw Object.assign(Error('Name a file or directory of the full verification records'), { status: 400 })
  if (!Number.isSafeInteger(offset) || offset < 0) throw Object.assign(Error('offset must be a non-negative integer'), { status: 400 })
  const root = await fs.realpath(verificationDir).catch(() => null)
  if (!root) throw Object.assign(Error('No full verification has been recorded yet'), { status: 404 })
  const asked = path.isAbsolute(rel) ? path.normalize(rel) : path.join(root, rel)
  if (rel.split(/[\\/]/).includes('..') || (asked !== root && !asked.startsWith(root + path.sep) && !asked.startsWith(path.resolve(verificationDir) + path.sep))) {
    throw Object.assign(Error('Only the full verification records (issues/.verification) can be read here'), { status: 403 })
  }
  const real = await fs.realpath(asked).catch(() => null)
  if (!real) throw Object.assign(Error(`No such file or directory in the full verification records: ${rel}`), { status: 404 })
  if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(Error('That path leads outside the full verification records'), { status: 403 })
  const shown = path.relative(root, real) || '.'
  const stat = await fs.stat(real)
  if (stat.isDirectory()) {
    const entries = await fs.readdir(real, { withFileTypes: true })
    const listed = []
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      listed.push({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other', ...(e.isFile() ? { bytes: (await fs.stat(path.join(real, e.name))).size } : {}) })
    }
    return { path: shown, type: 'directory', entries: listed }
  }
  if (!stat.isFile()) throw Object.assign(Error('Only regular files and directories can be read here'), { status: 400 })
  const text = await fs.readFile(real, 'utf8')
  const page = text.slice(offset, offset + VERIFICATION_PAGE_CHARS)
  const next = offset + page.length < text.length ? offset + page.length : null
  return { path: shown, type: 'file', bytes: stat.size, offset, text: page, ...(next !== null ? { next, truncated: true } : {}) }
}
