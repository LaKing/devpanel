#!/usr/bin/env node
/*
 * The devpanel broker's MCP server, run by a seat's CLI inside the fence
 * (phase 3 of the seat-access fence). It holds nothing:
 * each tool call is forwarded, with the turn's token, over the per-turn Unix
 * socket the panel bound into the fence (DEVPANEL_BROKER_SOCKET). The token
 * is read from the 0600 file DEVPANEL_BROKER_TOKEN_FILE names, so it never
 * appears on any command line (DEVPANEL_BROKER_TOKEN is still read when set
 * directly, for a caller that runs the shim by hand). The panel checks the token, the grant and the query
 * on every call and records it before answering.
 *
 * MCP over stdio: newline-delimited JSON-RPC 2.0.
 */
import fs from 'node:fs'
import net from 'node:net'
import readline from 'node:readline'

const SOCKET = process.env.DEVPANEL_BROKER_SOCKET
const TOKEN = (() => {
  const file = process.env.DEVPANEL_BROKER_TOKEN_FILE
  if (file) { try { return fs.readFileSync(file, 'utf8').trim() || null } catch { return null } }
  return process.env.DEVPANEL_BROKER_TOKEN || null
})()

const TOOL_LIST = [
  {
    name: 'inspect_environment',
    description: 'Read an operator-declared diagnostic resource of a configured environment (its status, or a named log/file), bounded. No shell, no credentials.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['environment'], properties: { environment: { type: 'string' }, resource: { type: 'string', description: '"status" or a declared file name' } } }
  },
  {
    name: 'db_query',
    description: 'Read-only query against a granted database of a configured environment. op: find | count | distinct | aggregate | listCollections. Only allow-listed stages and operators; results are capped (time, documents, bytes) and truncation is marked; every call is recorded as run evidence.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['environment', 'query'],
      properties: {
        environment: { type: 'string' },
        query: {
          type: 'object', required: ['op', 'database'],
          properties: {
            op: { enum: ['find', 'count', 'distinct', 'aggregate', 'listCollections'] }, database: { type: 'string' }, collection: { type: 'string' },
            filter: { type: 'object' }, projection: { type: 'object' }, sort: { type: 'object' }, limit: { type: 'integer' }, skip: { type: 'integer' },
            field: { type: 'string' }, pipeline: { type: 'array' }
          }
        }
      }
    }
  }
]

function forward (tool, args) {
  return new Promise((resolve) => {
    if (!SOCKET || !TOKEN) { resolve({ ok: false, error: 'the broker is not attached to this turn' }); return }
    const conn = net.createConnection(SOCKET)
    let data = ''
    conn.on('connect', () => conn.write(JSON.stringify({ token: TOKEN, tool, args }) + '\n'))
    conn.on('data', (chunk) => { data += chunk })
    conn.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve({ ok: false, error: 'the broker returned no answer' }) } })
    conn.on('error', (error) => resolve({ ok: false, error: `the broker is unreachable: ${error.code ?? error.message}` }))
  })
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', async (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (id === undefined) return   // notifications (initialized, cancelled) need no answer
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'devpanel', version: '1' } } })
  } else if (method === 'ping') {
    send({ id, result: {} })
  } else if (method === 'tools/list') {
    send({ id, result: { tools: TOOL_LIST } })
  } else if (method === 'tools/call') {
    const name = params?.name
    if (!TOOL_LIST.some((t) => t.name === name)) { send({ id, error: { code: -32602, message: `unknown tool ${name}` } }); return }
    const reply = await forward(name, params?.arguments ?? {})
    send({ id, result: { content: [{ type: 'text', text: JSON.stringify(reply.ok ? reply.result : { error: reply.error, code: reply.code ?? null }, null, 2) }], isError: !reply.ok } })
  } else {
    send({ id, error: { code: -32601, message: `method ${method} not found` } })
  }
})
