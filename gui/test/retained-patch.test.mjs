import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { retainedPatchDownload } from '../server/runtime/apply-artifact.mjs'
import { lastCandidatePatch } from '../server/runtime/prior-runs.mjs'
import { undeliveredApproval } from '../server/runtime/carry-forward.mjs'

export const name = 'retained-patch — the start preview\'s download serves only bytes a runtime-recorded digest proves'

const exec = promisify(execFile)
const sha = (bytes) => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex')
const R = (n) => 'sha256:' + String(n).repeat(64).slice(0, 64)
const fp16 = (r) => r.replace('sha256:', '').slice(0, 16)
const PATCH = Buffer.from('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
const OTHER = Buffer.from('replacement bytes\n')

async function run (record, files = {}) {
  const issuePath = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-retained-patch-'))
  const dir = path.join(issuePath, 'runs', 'run-a')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId: 'run-a', status: 'blocked', steps: [], ...record }))
  await fs.writeFile(path.join(dir, 'events.jsonl'), '')
  for (const [rel, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), bytes)
  }
  return { issuePath, dir }
}
const refused = (promise) => promise.then(() => ({ code: 'served' }), (e) => ({ code: e.code, status: e.status, message: e.message }))

const delivery = (revision, over = {}) => ({ action: 'worktree-diff', revision, artifactRef: `artifacts/${fp16(revision)}.patch`, reconstruction: { verified: true, fingerprint: revision }, ...over })
const checkRecord = (revision, dir, hash) => ({ revision, dir, artifact: { ref: `${dir}/artifacts/${fp16(revision)}.patch`, patchHash: hash } })

export default async function (t) {
  t.section('a delivery artifact whose digest the runtime recorded: exactly those bytes; replaced bytes are refused')
  {
    const { issuePath, dir } = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1), { patchHash: sha(PATCH) }) }, { [`artifacts/${fp16(R(1))}.patch`]: PATCH })
    const served = await retainedPatchDownload({ issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) })
    t.ok('the bytes are the file\'s', served.bytes.equals(PATCH))
    t.eq('bound to the revision', [served.revision, served.sha256], [R(1), sha(PATCH)])
    t.eq('a wrong revision is stale', (await refused(retainedPatchDownload({ issuePath, runId: 'run-a', artifact: 'delivery', revision: R(9) }))).code, 'stale')
    await fs.writeFile(path.join(dir, 'artifacts', `${fp16(R(1))}.patch`), OTHER)
    const r = await refused(retainedPatchDownload({ issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) }))
    t.eq('the file replaced under the same artifactRef: 409 changed', [r.status, r.code], [409, 'changed'])
  }

  t.section('an older engine delivery: delivery.application.patchHash is a recorded digest; artifactApplication.patchHash never is')
  {
    const applied = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1), { action: 'apply-to-source', application: { state: 'complete', patchHash: sha(PATCH) } }) }, { [`artifacts/${fp16(R(1))}.patch`]: PATCH })
    t.ok('the application digest proves the bytes', (await retainedPatchDownload({ issuePath: applied.issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) })).bytes.equals(PATCH))
    for (const [what, application] of [['a failed, recovery-required application', { verified: false, state: 'recovery-required', patchHash: sha(PATCH) }], ['a verified application', { verified: true, state: 'complete', patchHash: sha(PATCH) }]]) {
      const { issuePath } = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1)), artifactApplication: application }, { [`artifacts/${fp16(R(1))}.patch`]: PATCH })
      t.eq(`${what}: its digest proves nothing, 409 unprovable`, (await refused(retainedPatchDownload({ issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) }))).code, 'unprovable')
    }
    // The shape apply-artifact.mjs could record: the file replaced after reconstruction was verified, the digest taken of the replacement.
    const swapped = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1)), artifactApplication: { verified: true, patchHash: sha(OTHER) } }, { [`artifacts/${fp16(R(1))}.patch`]: OTHER })
    t.eq('a replacement whose digest was taken after verification is never served', (await refused(retainedPatchDownload({ issuePath: swapped.issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) }))).code, 'unprovable')
  }

  t.section('a check artifact: every record of the revision is walked, history included')
  {
    const hist = await run({ revisions: [{ fingerprint: R(2) }], checkResults: [], checkHistory: [checkRecord(R(2), 'checks/001', sha(PATCH))] }, { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH })
    const served = await retainedPatchDownload({ issuePath: hist.issuePath, runId: 'run-a', artifact: 'check', revision: R(2) })
    t.ok('after a delivery return cleared checkResults, the history-only original is served', served.bytes.equals(PATCH))
    t.eq('the same file lastCandidatePatch names', served.file, await fs.realpath(await lastCandidatePatch(hist.issuePath, { runId: 'run-a', revisions: [{ fingerprint: R(2) }], checkResults: [], checkHistory: [checkRecord(R(2), 'checks/001', sha(PATCH))] })))
    await fs.writeFile(path.join(hist.dir, 'checks/001/artifacts', `${fp16(R(2))}.patch`), OTHER)
    t.eq('its bytes changed: 409 changed', (await refused(retainedPatchDownload({ issuePath: hist.issuePath, runId: 'run-a', artifact: 'check', revision: R(2) }))).code, 'changed')

    const two = await run({ revisions: [{ fingerprint: R(2) }], checkResults: [checkRecord(R(2), 'checks/001', sha(PATCH)), checkRecord(R(2), 'checks/002', sha(PATCH))] }, { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH })
    const older = await retainedPatchDownload({ issuePath: two.issuePath, runId: 'run-a', artifact: 'check', revision: R(2) })
    t.ok('the newer record\'s file is missing: the older matching original is served', older.file.includes(`${path.sep}001${path.sep}`) && older.bytes.equals(PATCH))
    await fs.mkdir(path.join(two.dir, 'checks/002/artifacts'), { recursive: true })
    await fs.writeFile(path.join(two.dir, 'checks/002/artifacts', `${fp16(R(2))}.patch`), OTHER)
    t.ok('the newer one\'s bytes changed: the older one is served', (await retainedPatchDownload({ issuePath: two.issuePath, runId: 'run-a', artifact: 'check', revision: R(2) })).file.includes(`${path.sep}001${path.sep}`))

    const none = await run({ revisions: [{ fingerprint: R(2) }], checkResults: [{ revision: R(2), dir: 'checks/001' }] }, { [`checks/001/artifacts/${fp16(R(2))}.patch`]: PATCH })
    const r = await refused(retainedPatchDownload({ issuePath: none.issuePath, runId: 'run-a', artifact: 'check', revision: R(2) }))
    t.eq('a check from before recorded digests: 409 unprovable', r.code, 'unprovable')
    t.ok('the message names why', /no runtime-recorded digest/.test(r.message), r.message)
  }

  t.section('a returned seed: still the selector\'s choice, else stale')
  {
    const from = { revision: R(3), artifactRef: `artifacts/${fp16(R(3))}.patch`, patchHash: sha(PATCH) }
    const { issuePath } = await run({ startedAt: '2026-11-20T00:00:00.000Z', revisions: [{ fingerprint: R(3) }, { fingerprint: R(4) }], deliveryReturns: [{ n: 1, from }], closure: { revision: R(4), conditions: {} } }, { [`artifacts/${fp16(R(3))}.patch`]: PATCH })
    const selectSeed = () => undeliveredApproval(issuePath, null)
    t.ok('served while selected', (await retainedPatchDownload({ issuePath, runId: 'run-a', artifact: 'returned', revision: R(3), selectSeed })).bytes.equals(PATCH))
    t.eq('another revision: stale', (await refused(retainedPatchDownload({ issuePath, runId: 'run-a', artifact: 'returned', revision: R(4), selectSeed }))).code, 'stale')
  }

  t.section('never blocks, never leaves the run, never over the cap')
  {
    const fifoRun = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1), { patchHash: sha(PATCH) }) })
    await fs.mkdir(path.join(fifoRun.dir, 'artifacts'), { recursive: true })
    if (!await exec('mkfifo', [path.join(fifoRun.dir, 'artifacts', `${fp16(R(1))}.patch`)]).then(() => true, () => false)) t.skip('FIFO in place of the patch', 'mkfifo could not run here')
    else {
      const r = await Promise.race([refused(retainedPatchDownload({ issuePath: fifoRun.issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) })), new Promise((resolve) => setTimeout(() => resolve({ code: 'timeout' }), 5000))])
      t.eq('a FIFO: 409 unreadable, at once', r.code, 'unreadable')
    }
    const big = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1), { patchHash: sha(PATCH) }) }, { [`artifacts/${fp16(R(1))}.patch`]: PATCH })
    t.eq('over the cap: 409 tooLarge', (await refused(retainedPatchDownload({ issuePath: big.issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1), cap: PATCH.length - 1 }))).code, 'tooLarge')
    const out = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1), { patchHash: sha(PATCH), artifactRef: `../outside/${fp16(R(1))}.patch` }) })
    await fs.mkdir(path.join(out.issuePath, 'runs', 'outside'), { recursive: true })
    await fs.writeFile(path.join(out.issuePath, 'runs', 'outside', `${fp16(R(1))}.patch`), PATCH)
    t.eq('a recorded path outside the run\'s artifacts: refused', (await refused(retainedPatchDownload({ issuePath: out.issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) }))).code, 'unreadable')
    // The run's artifacts/ itself a link to a directory outside the run, holding a file whose digest matches.
    const linked = await run({ revisions: [{ fingerprint: R(1) }], delivery: delivery(R(1), { patchHash: sha(PATCH) }) })
    const elsewhere = path.join(linked.issuePath, 'elsewhere')
    await fs.mkdir(elsewhere, { recursive: true })
    await fs.writeFile(path.join(elsewhere, `${fp16(R(1))}.patch`), PATCH)
    await fs.symlink(elsewhere, path.join(linked.dir, 'artifacts'))
    t.eq('an artifacts root that resolves outside the run: refused, never served', (await refused(retainedPatchDownload({ issuePath: linked.issuePath, runId: 'run-a', artifact: 'delivery', revision: R(1) }))).code, 'unreadable')
    t.eq('an invalid run id: refused', (await refused(retainedPatchDownload({ issuePath: out.issuePath, runId: '../x', artifact: 'delivery', revision: R(1) }))).status, 409)
  }
}
