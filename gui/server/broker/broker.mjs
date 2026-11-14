import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import { validateQuery, GrammarError } from './grammar.mjs'
import { reference } from '../runtime/ssh.mjs'
import { openSocketForward, uriThroughSocket } from './socket-forward.mjs'

/*
 * The broker (phase 3 of the seat-access fence): what a
 * fenced seat may learn about an environment, asked through the panel instead
 * of through SSH. Two tools, `inspect_environment` (the operator-declared
 * resources, infrastructure.mjs) and `db_query` (the allow-list grammar,
 * grammar.mjs, against a read-only principal).
 *
 *  - A token per turn, bound to project, issue, run, invocation and seat,
 *    revoked when the turn ends and unknown after a restart (process memory).
 *  - Grants checked on EVERY call, as they stand then: staging is granted to the
 *    project by declaring its `database`; a production environment needs an
 *    operator grant on the run's own issue (`grants.json`), unexpired and
 *    unrevoked, naming the seat when it names seats. An inquiry never inherits
 *    its related issue's grant: grants are read from the run's issue alone.
 *  - Caps on time, documents and bytes; truncation is marked.
 *  - Each call is recorded under `runs/<id>/evidence/broker/NNN.json` BEFORE its
 *    result returns; a failed write refuses the result.
 *  - Redaction is a display feature (decision 1), not a boundary.
 *  - A database declared with a `socket` listens on no network: each query
 *    reaches it through an SSH socket forward over the environment's own SSH
 *    connection, opened after the grant check and closed with the query
 *    (socket-forward.mjs).
 */

export const DEFAULT_CAPS = Object.freeze({ timeMs: 10000, documents: 200, bytes: 1024 * 1024 })
export const TOOLS = Object.freeze(['inspect_environment', 'db_query'])

export class BrokerError extends Error {
  constructor (message, code = 'REFUSED') { super(message); this.code = code }
}

/** The environments a project declares, each with its kind. */
function environments (infra) {
  if (!infra) return []
  return [{ ...infra.staging, kind: 'staging' }, ...(infra.deployments ?? []).map((d) => ({ ...d, kind: 'production' }))]
}

/** Does any environment of this configuration declare a database? Then the broker attaches to its turns. */
export const brokerConfigured = (infra) => environments(infra).some((e) => e?.database)

/** An operator grant for a production environment, stored on the issue. */
export async function readGrants (issuePath) {
  try { return JSON.parse(await fs.readFile(path.join(issuePath, 'grants.json'), 'utf8')) } catch { return [] }
}

export async function writeGrant (issuePath, { environment, reason, expiresAt, seats = [], providers = 'any', by = 'operator' }) {
  if (by !== 'operator') throw new BrokerError('only an operator grants production access', 'FORBIDDEN')
  if (typeof reason !== 'string' || !reason.trim()) throw new BrokerError('a grant needs a reason')
  if (!Number.isFinite(Date.parse(expiresAt))) throw new BrokerError('a grant needs an expiry')
  const grants = await readGrants(issuePath)
  const grant = { id: crypto.randomUUID(), environment, reason: reason.trim(), expiresAt: new Date(expiresAt).toISOString(), seats, providers, by, at: new Date().toISOString(), revokedAt: null,
    // What the grant form says, recorded with it: seats limit who may EXECUTE
    // queries; results belong to the whole run.
    scope: 'results belong to the whole run, including evidence, reports and coordinator context' }
  grants.push(grant)
  const file = path.join(issuePath, 'grants.json')
  await fs.writeFile(`${file}.tmp`, JSON.stringify(grants, null, 2))
  await fs.rename(`${file}.tmp`, file)
  return grant
}

export async function revokeGrant (issuePath, id) {
  const grants = await readGrants(issuePath)
  const grant = grants.find((g) => g.id === id)
  if (!grant) throw new BrokerError('no such grant', 'NOT_FOUND')
  grant.revokedAt = new Date().toISOString()
  const file = path.join(issuePath, 'grants.json')
  await fs.writeFile(`${file}.tmp`, JSON.stringify(grants, null, 2))
  await fs.rename(`${file}.tmp`, file)
  return grant
}

/**
 * The real driver, loaded only when a database is configured and used.
 * `direct`: talk to the one server the URI names and discover nothing. A member
 * of a replica set advertises its peers by addresses that mean something only
 * inside its environment; through a forwarded socket only that one end exists.
 */
export async function mongoDriver (uri, { direct = false } = {}) {
  let mongodb
  try { mongodb = await import('mongodb') } catch { throw new BrokerError('the MongoDB driver is not installed on this panel', 'UNAVAILABLE') }
  const client = new mongodb.MongoClient(uri, { readPreference: 'secondaryPreferred', serverSelectionTimeoutMS: 5000, ...(direct ? { directConnection: true } : {}) })
  await client.connect()
  return {
    async run ({ database, collection, op, filter = {}, projection, sort, limit, skip, field, pipeline, maxTimeMS, signal }) {
      const db = client.db(database)
      if (op === 'listCollections') return (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
      const coll = db.collection(collection)
      if (op === 'count') return coll.countDocuments(filter, { maxTimeMS })
      if (op === 'distinct') return coll.distinct(field, filter, { maxTimeMS })
      const cursor = op === 'find'
        ? coll.find(filter, { projection, sort, skip, limit, maxTimeMS })
        : coll.aggregate(pipeline, { maxTimeMS })
      const abort = () => cursor.close().catch(() => {})
      signal?.addEventListener('abort', abort, { once: true })
      try {
        const out = []
        for await (const doc of cursor) { out.push(doc); if (out.length >= limit) break }
        return out
      } finally { await cursor.close().catch(() => {}); signal?.removeEventListener('abort', abort) }
    },
    close: () => client.close()
  }
}

/**
 * The driver for an environment's declared database: by its URI, or, when the
 * declaration names a `socket`, through an SSH socket forward that lives as long
 * as the driver (closed with it, also when the connection fails).
 */
export async function environmentDriver (env, { connect = mongoDriver, forward = openSocketForward } = {}) {
  const uri = await reference(env.database.uriRef)
  if (!uri) throw new BrokerError(`the connection reference of ${env.id} resolves to nothing`, 'UNAVAILABLE')
  if (!env.database.socket) return connect(uri)
  let tunnel
  try { tunnel = await forward({ ssh: env.ssh, remotePath: env.database.socket.path }) } catch (error) { throw new BrokerError(error.message, 'UNAVAILABLE') }
  try {
    const driver = await connect(uriThroughSocket(uri, tunnel.localPath), { direct: true })
    return { run: (request) => driver.run(request), close: async () => { try { await driver.close?.() } finally { await tunnel.close() } } }
  } catch (error) {
    await tunnel.close()
    throw error
  }
}

/**
 * @param loadInfrastructure (project) => the project's infrastructure (configured, current)
 * @param inspect           ({project, environment, resource}) => the inspection result
 * @param driverFor         (environment) => a driver { run(request) } for its database
 */
export function createBroker ({ loadInfrastructure, inspect, driverFor = environmentDriver, clock = { now: () => Date.now(), iso: () => new Date().toISOString() } }) {
  const turns = new Map()
  const sequences = new Map()

  function openTurn ({ project, issueId, issuePath, runId, runDir, invocationId, seat, operations = TOOLS }) {
    const token = crypto.randomBytes(24).toString('hex')
    turns.set(token, { project, issueId, issuePath, runId, runDir, invocationId, seat, operations: [...operations], revoked: false })
    return { token, revoke: () => { const t = turns.get(token); if (t) t.revoked = true; turns.delete(token) } }
  }

  async function environmentFor (binding, name) {
    const env = environments(await loadInfrastructure(binding.project)).find((e) => e?.id === name)
    if (!env) throw new BrokerError(`unknown environment ${name}`, 'NOT_FOUND')
    if (env.kind === 'staging') return { env, grant: { kind: 'project', environment: name } }
    const now = clock.now()
    const grant = (await readGrants(binding.issuePath)).find((g) => g.environment === name && !g.revokedAt && Date.parse(g.expiresAt) > now &&
      (!g.seats?.length || g.seats.includes(binding.seat)))
    if (!grant) throw new BrokerError(`no operator grant on this issue for ${name}${binding.seat ? ` and seat ${binding.seat}` : ''}`, 'FORBIDDEN')
    return { env, grant: { kind: 'issue', id: grant.id, environment: name, expiresAt: grant.expiresAt } }
  }

  /** Allocate NNN.json with O_EXCL: concurrent calls get unique receipts. */
  async function record (binding, entry) {
    const dir = path.join(binding.runDir, 'evidence', 'broker')
    await fs.mkdir(dir, { recursive: true })
    let n = sequences.get(dir) ?? (await fs.readdir(dir).catch(() => [])).filter((f) => /^\d{3,}\.json$/.test(f)).length
    for (;;) {
      n++
      const file = path.join(dir, `${String(n).padStart(3, '0')}.json`)
      try {
        const handle = await fs.open(file, 'wx')
        try { await handle.writeFile(JSON.stringify(entry, null, 2)); await handle.sync() } finally { await handle.close() }
        sequences.set(dir, n)
        return path.relative(binding.runDir, file)
      } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
  }

  async function call (token, { tool, args = {} } = {}, { signal = null } = {}) {
    const binding = turns.get(token)
    if (!binding || binding.revoked) throw new BrokerError('the turn token is not valid (ended, revoked, or from before a restart)', 'TOKEN')
    if (!binding.operations.includes(tool)) throw new BrokerError(`tool ${tool} is not granted to this turn`, 'FORBIDDEN')
    const started = clock.now()
    const base = { at: clock.iso(), tool, seat: binding.seat, invocationId: binding.invocationId, request: args }
    let result
    let entry
    try {
      const { env, grant } = await environmentFor(binding, args.environment)
      if (tool === 'inspect_environment') {
        result = await inspect({ project: binding.project, environment: env.id, resource: args.resource ?? 'status' })
        entry = { ...base, grant, outcome: result.available ? 'ok' : 'unavailable', bytes: Buffer.byteLength(JSON.stringify(result)), truncated: false }
      } else {
        if (!env.database) throw new BrokerError(`${env.id} declares no database`, 'NOT_FOUND')
        const caps = { ...DEFAULT_CAPS, ...(env.database.caps ?? {}) }
        const granted = env.database.databases ?? []
        const allowed = (db, coll) => granted.some((d) => d.name === db && (coll === null || (d.collections ?? ['*']).includes('*') || d.collections.includes(coll)))
        const query = validateQuery(args.query, allowed)
        const limit = Math.min(query.limit ?? caps.documents, caps.documents)
        const pipeline = query.op === 'aggregate' ? [...query.pipeline, { $limit: caps.documents + 1 }] : undefined
        // A held timer (AbortSignal.timeout's is unref'd): the cap must fire even
        // when nothing else keeps the process busy.
        const cap = new AbortController()
        const timer = setTimeout(() => cap.abort(new BrokerError(`the query exceeded ${caps.timeMs} ms`, 'TIMEOUT')), caps.timeMs)
        const driver = await driverFor(env)
        let raw
        try {
          raw = await driver.run({ ...query, limit: limit + 1, pipeline, maxTimeMS: caps.timeMs, signal: signal ? AbortSignal.any([signal, cap.signal]) : cap.signal })
        } finally { clearTimeout(timer); await driver.close?.().catch?.(() => {}) }
        // A driver that ends its cursor on abort returns what it had: that is a
        // timeout, not a complete answer (implementation audit).
        if (cap.signal.aborted) throw cap.signal.reason instanceof BrokerError ? cap.signal.reason : new BrokerError(`the query exceeded ${caps.timeMs} ms`, 'TIMEOUT')
        if (query.op === 'listCollections') raw = raw.filter((c) => allowed(query.database, c))
        let truncated = false
        if (Array.isArray(raw) && raw.length > limit) { raw = raw.slice(0, limit); truncated = true }
        let body = JSON.stringify(raw)
        if (Buffer.byteLength(body) > caps.bytes) {
          truncated = true
          if (Array.isArray(raw)) { while (raw.length && Buffer.byteLength(JSON.stringify(raw)) > caps.bytes) raw = raw.slice(0, Math.floor(raw.length / 2)) } else raw = null
          body = JSON.stringify(raw)
        }
        result = { environment: env.id, op: query.op, database: query.database, collection: query.collection ?? null, result: raw, truncated,
          redaction: env.database.redact?.length ? 'display only: not a confidentiality boundary' : null }
        entry = { ...base, grant, outcome: 'ok', bytes: Buffer.byteLength(body), truncated, durationMs: clock.now() - started }
      }
    } catch (error) {
      entry = { ...base, outcome: 'refused', error: error.message, code: error.code ?? (error instanceof GrammarError ? 'GRAMMAR' : 'ERROR'), durationMs: clock.now() - started }
      try { await record(binding, entry) } catch { /* the refusal itself is returned */ }
      throw error instanceof BrokerError || error instanceof GrammarError ? error : new BrokerError(error.message, 'ERROR')
    }
    // Recorded before it returns; a failed write refuses the result.
    let receipt
    try { receipt = await record(binding, entry) } catch (error) { throw new BrokerError(`the call could not be recorded (${error.message}); its result is withheld`, 'RECORD') }
    return { ...result, receipt }
  }

  /**
   * A per-turn Unix socket for the MCP shim inside the fence. Each connection
   * sends one JSON line {token, tool, args} and reads one JSON line back.
   */
  async function serveTurn ({ socketPath, token }) {
    await fs.mkdir(path.dirname(socketPath), { recursive: true })
    await fs.rm(socketPath, { force: true })
    const sockets = new Set()
    const server = net.createServer((conn) => {
      sockets.add(conn); conn.once('close', () => sockets.delete(conn))
      let buffer = ''
      conn.on('data', async (chunk) => {
        buffer += chunk
        const nl = buffer.indexOf('\n')
        if (nl < 0) { if (buffer.length > 1024 * 1024) conn.destroy(); return }
        const line = buffer.slice(0, nl)
        buffer = ''
        let reply
        try {
          const request = JSON.parse(line)
          if (request.token !== token) throw new BrokerError('the turn token does not match this socket', 'TOKEN')
          reply = { ok: true, result: await call(token, request) }
        } catch (error) { reply = { ok: false, error: error.message, code: error.code ?? 'ERROR' } }
        conn.end(JSON.stringify(reply) + '\n')
      })
      conn.on('error', () => {})
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    // A connection a leftover process holds open must not keep the turn from
    // ending: the token is already revoked, so the sockets are simply destroyed.
    const close = () => new Promise((resolve) => {
      server.close(() => { fs.rm(socketPath, { force: true }).then(resolve, resolve) })
      for (const conn of sockets) conn.destroy()
    })
    return { socketPath, close }
  }

  return { openTurn, call, serveTurn, turns }
}
