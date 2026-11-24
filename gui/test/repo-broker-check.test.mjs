import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { runRepoBrokerCheck } from '../live/repo-broker-check.mjs'

export const name = 'the --repo-broker live check hands the shim its token as a file, checked without a paid call'

/*
 * `npm run live -- --repo-broker` calls adapter.invoke itself, so it is the one
 * caller besides the engine that builds a broker for a turn. A fake adapter
 * stands in for the CLI here: it records what it was handed and runs the real
 * shim the way a CLI would, with exactly the MCP environment it was given.
 */
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-repo-broker-'))
  let handed = null
  const adapter = {
    probe: async () => ({ installation: { status: 'installed', version: 'fake 1.0', detail: null } }),
    invoke: async ({ broker }) => {
      handed = {
        keys: Object.keys(broker),
        mode: await fs.stat(broker.tokenFile).then((st) => st.mode & 0o777, () => null)
      }
      const child = spawn(process.execPath, [broker.shim], { env: { PATH: process.env.PATH, DEVPANEL_BROKER_SOCKET: broker.socket, DEVPANEL_BROKER_TOKEN_FILE: broker.tokenFile }, stdio: ['pipe', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (c) => { out += c })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'db_query', arguments: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } } }) + '\n')
      for (let i = 0; i < 250 && !out.includes('\n'); i++) await new Promise((r) => setTimeout(r, 20))
      child.kill()
      const reply = JSON.parse(out.split('\n')[0] || '{}')
      const result = JSON.parse(reply.result?.content?.[0]?.text ?? '{}')
      return { response: `count: ${result.result}`, session: null, usage: null, diagnostics: {} }
    }
  }
  try {
    const result = await runRepoBrokerCheck({ adapter, harnessId: 'fake', model: 'm', root, ledgerDir: path.join(root, 'ledger') })
    const stage = (n) => result.stages.find((s) => s.name === n)?.status
    t.eq('the adapter gets a token file and no token', [handed?.keys.includes('tokenFile'), handed?.keys.includes('token')], [true, false])
    t.eq('the file is 0600', handed?.mode, 0o600)
    t.eq('the shim, given only the file, reached the broker: the call is recorded and its answer came back', [stage('the broker recorded the db_query call'), stage('the random answer reached the model')], ['pass', 'pass'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  // A setup failure after the listener and the token file exist leaves nothing behind.
  const failRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-repo-broker-fail-'))
  try {
    let turnDir = null
    let invoked = false
    const failing = { probe: adapter.probe, invoke: async () => { invoked = true; return {} } }
    const outcome = await runRepoBrokerCheck({
      adapter: failing, harnessId: 'fake', model: 'm', root: failRoot, ledgerDir: path.join(failRoot, 'ledger'),
      tokenWriter: async (dir, token) => { turnDir = dir; await fs.writeFile(path.join(dir, 't'), token, { mode: 0o600 }); throw new Error('injected: token file write failed') }
    }).then(() => null, (e) => e)
    t.ok('the setup failure is reported, and no turn ran', /injected/.test(outcome?.message ?? '') && !invoked, outcome?.message)
    t.eq('the token file, the socket and their folder are removed', turnDir && await fs.stat(turnDir).then(() => true, () => false), false)
    const worktrees = (await fs.readdir(path.join(failRoot, 'runs')).catch(() => [])).filter((n) => n.startsWith('worktree-'))
    t.eq('the worktree is released', worktrees, [])
  } finally {
    await fs.rm(failRoot, { recursive: true, force: true })
  }
}
