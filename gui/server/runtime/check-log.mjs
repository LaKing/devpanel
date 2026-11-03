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
