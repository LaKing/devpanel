import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { sshConnection } from '../runtime/ssh.mjs'

/*
 * A database that listens only on a Unix socket inside its environment (no TCP
 * port, so nothing on the network reaches it) is queried through the
 * environment's own declared SSH connection: for one query the broker opens an
 * SSH socket forward (`ssh -N -L <local socket>:<remote socket>`), connects the
 * driver to the local end, and closes both when the query is done.
 *
 * Decision: a forward per query, not a standing tunnel. A standing one would be
 * a second way into the database that outlives every grant; this one exists
 * only while a granted call runs, and the grant is checked before it opens
 * (broker.mjs `environmentFor`). The price is one SSH handshake per query.
 *
 * The local end lives in a private directory (mkdtemp: mode 0700) of the panel
 * host, outside every fence: a seat never sees it, only the broker's own socket.
 * SSH itself decides nothing about reading or writing: the database principal
 * the URI names must be read-only (project.schema.json `database`).
 */

const WAIT_STEP_MS = 50

/**
 * The connection URI with its host replaced by a local Unix socket, as the
 * MongoDB driver spells one (percent-encoded path). Credentials, the default
 * database and the options stay as the operator wrote them.
 */
export function uriThroughSocket (uri, localPath) {
  const match = /^mongodb:\/\/(?:([^@/]*)@)?[^/?]*(.*)$/s.exec(uri ?? '')
  if (!match) throw new Error('a database reached through a socket needs a mongodb:// URI (mongodb+srv:// names hosts to discover, which a socket cannot be)')
  const [, credentials, rest] = match
  return `mongodb://${credentials != null ? `${credentials}@` : ''}${encodeURIComponent(localPath)}${rest}`
}

/**
 * Open the forward. Resolves `{ localPath, close() }` once the local socket
 * exists; rejects, with what SSH said, when SSH ends first or the socket does
 * not appear in time. `close()` ends exactly the process started here and
 * removes the directory; it never throws.
 */
export async function openSocketForward ({ ssh, remotePath, timeoutMs = 15000, spawnImpl = spawn }) {
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || remotePath.includes('\0')) throw new Error('the database socket path must be absolute')
  const { command, args } = await sshConnection(ssh)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dpm-'))
  // The name matters: the MongoDB driver reads a host as a Unix socket only when it ends in `.sock`; any other
  // name is taken for a hostname, and the connection times out in server selection.
  const localPath = path.join(dir, 'm.sock')
  // The destination stays last. ExitOnForwardFailure: a forward that cannot be set up ends SSH instead of leaving a
  // session with nothing behind the socket. No command, no terminal, no stdin: the session carries the forward only.
  const child = spawnImpl(command, [...args.slice(0, -1), '-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindMask=0177', '-L', `${localPath}:${remotePath}`, args.at(-1)],
    { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (error) => resolve({ error }))
  })
  let ended = null
  exited.then((result) => { ended = result })
  const close = async () => {
    if (!ended) {
      child.kill('SIGTERM')
      const killer = setTimeout(() => { if (!ended) child.kill('SIGKILL') }, 2000)
      await exited
      clearTimeout(killer)
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ended) {
      await close()
      throw new Error(`the SSH forward to the database socket ended before it was ready (${ended.error?.message ?? `exit ${ended.code ?? ended.signal}`})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
    }
    if (await fs.stat(localPath).then((s) => s.isSocket(), () => false)) return { localPath, close }
    if (Date.now() > deadline) {
      await close()
      throw new Error(`the SSH forward to the database socket was not ready within ${timeoutMs} ms${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
  }
}
