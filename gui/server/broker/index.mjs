import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBroker, brokerConfigured } from './broker.mjs'
import { projectInfrastructure, inspectEnvironment } from '../infrastructure.mjs'

export { brokerConfigured }

/** The shim a seat's CLI runs as its MCP server (harness/mcp-devpanel.mjs). */
export const SHIM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'harness', 'mcp-devpanel.mjs')

// One broker per panel process: tokens live in its memory, so a restart
// invalidates every token by construction.
const brokers = new Map()
export function panelBroker ({ configRoot } = {}) {
  const key = configRoot ?? ''
  if (!brokers.has(key)) {
    brokers.set(key, createBroker({
      loadInfrastructure: (project) => projectInfrastructure(project, { root: configRoot }),
      inspect: (a) => inspectEnvironment(a, { root: configRoot })
    }))
  }
  return brokers.get(key)
}

/**
 * The turn token as a 0600 file in the turn's private directory, for the shim
 * (DEVPANEL_BROKER_TOKEN_FILE). A CLI's MCP configuration is passed on its
 * command line, which any local user can read in /proc; the path is not a secret.
 */
export async function writeTokenFile (dir, token) {
  const file = path.join(dir, 't')
  await fs.writeFile(file, token, { mode: 0o600, flag: 'wx' })
  return file
}

/**
 * Open the broker for one turn: a token bound to it and a Unix socket in a
 * short private directory (socket paths are limited to ~108 bytes; a run
 * directory is longer). Returns what the adapter and the fence need, and
 * `close()`, which revokes the token and removes the socket. A failure while
 * opening leaves nothing behind: the token is revoked, the listener closed and
 * the directory with the token file removed. `tmpRoot` and `resolveNode` are
 * injectable only so a test can see that.
 */
export async function openBrokerTurn ({ configRoot, binding, tmpRoot = os.tmpdir(), resolveNode = () => fs.realpath(process.execPath) }) {
  const broker = panelBroker({ configRoot })
  const { token, revoke } = broker.openTurn(binding)
  let dir = null, served = null, tokenFile, node
  try {
    dir = await fs.mkdtemp(path.join(tmpRoot, 'dpb-'))
    tokenFile = await writeTokenFile(dir, token)
    served = await broker.serveTurn({ socketPath: path.join(dir, 's'), token })
    node = await resolveNode()
  } catch (error) {
    revoke()
    await served?.close().catch(() => {})
    if (dir) await fs.rm(dir, { recursive: true, force: true })
    throw error
  }
  const socketPath = path.join(dir, 's')
  // The node installation the shim runs on; /usr is in every fence already.
  const nodeRoot = node.startsWith('/usr/') ? null : path.dirname(path.dirname(node))
  return {
    token, tokenFile, socketPath, dir, shim: SHIM, node,
    fence: { writable: [dir], readOnly: [SHIM, ...(nodeRoot ? [nodeRoot] : [])] },
    id: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12),
    async close () { revoke(); await served.close(); await fs.rm(dir, { recursive: true, force: true }) }
  }
}
