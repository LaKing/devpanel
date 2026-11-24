import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { createBroker } from '../server/broker/broker.mjs'
import { SHIM, writeTokenFile } from '../server/broker/index.mjs'

/*
 * Do private repositories (fence.repository: 1) and the broker (Phase 3) work
 * with a real CLI inside the seat fence, under the CLI's OWN sandbox too?
 *
 * ONE writer turn per harness, in the worktree of a private repository, with
 * the devpanel MCP server attached to an in-process broker whose database is a
 * fake that answers a random number. The turn is asked to edit a file, `git
 * add` and `git commit` it, and to call db_query for a count. Verdicts come
 * from the filesystem and the broker's evidence, never from what the model
 * says: the worker directory's HEAD must be a new commit whose parent is the
 * base, the engine directory's HEAD must not have moved, and the broker must
 * have recorded the call, whose random answer appears in the reply.
 */

const exec = promisify(execFile)
const NL = String.fromCharCode(10)
const PANEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// `tokenWriter` is injectable only so a test can make the setup fail and see nothing left behind.
export async function runRepoBrokerCheck ({ adapter, harnessId, model, root, ledgerDir, reserve = () => {}, log = () => {}, ledger, tokenWriter = writeTokenFile }) {
  const result = { harness: harnessId, model, stages: [] }
  const stage = (name, status, detail = {}) => { result.stages.push({ name, status, ...detail }); log(name, status, detail) }
  const probed = await adapter.probe({ depth: 'installation' })
  result.cliVersion = probed.installation.version
  if (probed.installation.status !== 'installed') { stage('installation', 'fail', { detail: probed.installation.detail }); return result }
  stage('installation', 'pass', { version: probed.installation.version })

  // A project with history, provisioned as a run would be.
  const projectPath = path.join(root, 'project')
  await fs.mkdir(projectPath, { recursive: true })
  const git = (dir, ...a) => exec('git', ['-C', dir, ...a]).then((r) => r.stdout.trim())
  await git(projectPath, 'init', '-q', '-b', 'main'); await git(projectPath, 'config', 'user.email', 'o@o'); await git(projectPath, 'config', 'user.name', 'O')
  await fs.writeFile(path.join(projectPath, 'notes.txt'), 'first' + NL); await git(projectPath, 'add', '-A'); await git(projectPath, 'commit', '-qm', 'history one')
  await fs.writeFile(path.join(projectPath, 'notes.txt'), 'second' + NL); await git(projectPath, 'commit', '-qam', 'history two')
  const runs = path.join(root, 'runs'); const runId = `live-${Date.now()}`
  await fs.mkdir(path.join(runs, runId), { recursive: true })
  const ws = await gitWorktreeProvider.create({ projectPath, runId, root: runs, policy: { base: 'head', repository: 1 } })
  const repo = ws.repository
  try {
    const scratch = path.join(root, 'scratch'); const evidence = path.join(root, 'evidence')
    for (const d of [scratch, evidence]) await fs.mkdir(d, { recursive: true })

    const answer = crypto.randomInt(100000, 999999)
    const broker = createBroker({
      loadInfrastructure: async () => ({ staging: { id: 'stage', files: {}, database: { uriRef: 'env:NONE', databases: [{ name: 'app' }] } }, deployments: [] }),
      inspect: async () => ({ available: false }),
      driverFor: async () => ({ run: async (q) => (q.op === 'count' ? answer : []) })
    })
    const { token, revoke } = broker.openTurn({ project: 'live', issueId: 'live', issuePath: root, runId, runDir: path.join(runs, runId), invocationId: 'live-repo-broker', seat: 'implementer' })
    // Everything the turn's broker holds (token, listener, token file) is released however setup or the turn ends.
    let turnDir = null, served = null
    let turn
    try {
      turnDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpb-'))
      served = await broker.serveTurn({ socketPath: path.join(turnDir, 's'), token })
      const tokenFile = await tokenWriter(turnDir, token)
      const node = await fs.realpath(process.execPath)
      const nodeRoot = node.startsWith('/usr/') ? null : path.dirname(path.dirname(node))

      const prompt = [
        'This is an environment check. Do EVERY step, in order; do not ask for confirmation.',
        '1. Append the line "seat edit" to notes.txt in the current directory.',
        '2. With your shell run: git add -A && git commit -m "seat commit"  and then: git log --oneline',
        '3. Call the devpanel tool db_query with {"environment":"stage","query":{"op":"count","database":"app","collection":"users"}} and quote the number it returns.',
        'Report each step\'s output verbatim.'
      ].join(NL)
      try {
        reserve()
        turn = await adapter.invoke({
          model, cwd: ws.path, scratchDir: scratch, ledgerDir, prompt, hygiene: true, marker: `devpanel:repo-broker:${Date.now()}`,
          tooling: { writesCode: true, allowLiveCheckout: false, liveCheckout: null, allowedRoots: [evidence, scratch], networkAccess: true, gitWorker: repo.worker, gitDirectories: [repo.engine] },
          fence: { cwd: ws.path, writable: [ws.path, repo.worker, scratch, turnDir], readOnly: [evidence, path.join(repo.engine, 'objects'), SHIM, ...(nodeRoot ? [nodeRoot] : [])], entries: [path.join(ws.path, '.git')], panelRoot: PANEL },
          broker: { socket: path.join(turnDir, 's'), tokenFile, shim: SHIM, node },
          meta: { invocationId: 'live-repo-broker', role: 'implementer' }
        })
        ledger?.record({ stage: 'repo-broker', outcome: 'completed', session: turn.session?.id ?? null, usage: turn.usage })
        stage('turn completed', 'pass', { session: turn.session?.id ?? null })
      } catch (error) {
        ledger?.record({ stage: 'repo-broker', outcome: 'failed', error: error.message, usage: null })
        stage('turn completed', 'fail', { detail: [error.message, error.stderr].filter(Boolean).join(' — ').slice(0, 400) })
      }
    } finally {
      revoke()
      await served?.close().catch(() => {})
      if (turnDir) await fs.rm(turnDir, { recursive: true, force: true })
    }
    if (turn) {
      const fence = turn.diagnostics?.fence
      stage('the turn ran inside a proved fence', fence?.namespace === 1 ? 'pass' : 'fail', { detail: (JSON.stringify(fence) ?? 'no fence diagnostics').slice(0, 300) })
      const head = await exec('git', ['--git-dir', repo.worker, 'rev-parse', 'HEAD']).then((r) => r.stdout.trim(), () => null)
      const parent = head ? await exec('git', ['--git-dir', repo.worker, 'rev-parse', `${head}^`]).then((r) => r.stdout.trim(), () => null) : null
      stage('the seat committed in its worker directory', head && head !== ws.baseCommit && parent === ws.baseCommit ? 'pass' : 'fail', { detail: `worker HEAD ${head?.slice(0, 12)}, parent ${parent?.slice(0, 12)}, base ${ws.baseCommit.slice(0, 12)}` })
      const engineHead = await exec('git', ['--git-dir', repo.engine, 'rev-parse', 'HEAD']).then((r) => r.stdout.trim())
      stage('the engine directory did not move', engineHead === ws.baseCommit ? 'pass' : 'fail')
      const records = await fs.readdir(path.join(runs, runId, 'evidence', 'broker')).catch(() => [])
      const ok = []
      for (const f of records) { const r = JSON.parse(await fs.readFile(path.join(runs, runId, 'evidence', 'broker', f), 'utf8')); if (r.outcome === 'ok' && r.tool === 'db_query') ok.push(r) }
      stage('the broker recorded the db_query call', ok.length ? 'pass' : 'fail', { detail: `${records.length} record(s)` })
      stage('the random answer reached the model', (turn.response ?? '').includes(String(answer)) ? 'pass' : 'fail', { detail: `expected ${answer}` })
      stage('the history before the snapshot is not visible', (turn.response ?? '').includes('history one') ? 'fail' : 'pass')
    }
  } finally {
    // The worktree is handed back whatever happened above.
    await gitWorktreeProvider.release({ projectPath, path: ws.path, repository: repo })
  }
  return result
}

export const repoBrokerPassed = (result) => result.stages.length > 0 && result.stages.every((s) => s.status === 'pass')
export function describeRepoBroker (result) {
  const failed = result.stages.filter((s) => s.status !== 'pass')
  return failed.length ? `NOT VERIFIED: ${failed.map((s) => `${s.name}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}` : 'worker Git and the broker work inside the fence, under the CLI\'s own sandbox'
}
