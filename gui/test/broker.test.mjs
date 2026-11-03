import fs from 'node:fs/promises'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { validateQuery } from '../server/broker/grammar.mjs'
import { createBroker, writeGrant, revokeGrant, brokerConfigured } from '../server/broker/broker.mjs'
import { SHIM } from '../server/broker/index.mjs'
import YAML from 'yaml'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'

export const name = 'Phase 3 — the broker: allow-list grammar, per-call grants, caps, recorded evidence, the MCP shim'

const refused = (fn) => { try { fn(); return null } catch (error) { return error.message } }

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }

  t.section('1. the grammar is an allow-list, validated recursively')
  {
    const all = () => true
    const only = (db, coll) => db === 'app' && (coll === null || ['users', 'orders'].includes(coll))
    t.ok('a find with operators passes', !refused(() => validateQuery({ op: 'find', database: 'app', collection: 'users', filter: { age: { $gte: 18 }, $or: [{ a: 1 }, { b: { $in: [1, 2] } }] }, projection: { name: 1 }, sort: { age: -1 }, limit: 5 }, all)))
    t.ok('an aggregate with $lookup into a granted collection passes', !refused(() => validateQuery({ op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $match: { a: 1 } }, { $lookup: { from: 'orders', localField: '_id', foreignField: 'user', as: 'o' } }, { $group: { _id: '$x', n: { $sum: 1 } } }] }, only)))
    for (const [label, q] of [
      ['$where in a filter', { op: 'find', database: 'app', collection: 'users', filter: { $where: 'sleep(1)' } }],
      ['$function in $expr', { op: 'find', database: 'app', collection: 'users', filter: { $expr: { $function: { body: 'x', args: [], lang: 'js' } } } }],
      ['$accumulator in $group', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $group: { _id: 1, x: { $accumulator: {} } } }] }],
      ['$out', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $out: 'copy' }] }],
      ['$merge', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $merge: { into: 'x' } }] }],
      ['$graphLookup', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $graphLookup: {} }] }],
      ['$currentOp', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $currentOp: {} }] }],
      ['a forbidden stage nested in $facet', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $facet: { a: [{ $match: {} }], b: [{ $out: 'x' }] } }] }],
      ['a forbidden stage nested in $lookup', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $lookup: { from: 'orders', as: 'o', pipeline: [{ $merge: 'x' }] } }] }],
      ['$lookup into an ungranted collection', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $lookup: { from: 'secrets', localField: 'a', foreignField: 'b', as: 'c' } }] }],
      ['$unionWith an ungranted collection', { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $unionWith: { coll: 'secrets' } }] }],
      ['an ungranted collection', { op: 'find', database: 'app', collection: 'secrets' }],
      ['a system collection', { op: 'find', database: 'app', collection: 'system.users' }],
      ['an unknown field', { op: 'find', database: 'app', collection: 'users', hint: 'x' }],
      ['an unknown op', { op: 'insert', database: 'app', collection: 'users' }],
      ['distinct without a field', { op: 'distinct', database: 'app', collection: 'users' }],
      ['listCollections of an ungranted database', { op: 'listCollections', database: 'admin' }]
    ]) t.ok(`refused: ${label}`, Boolean(refused(() => validateQuery(q, only))), label)
  }

  t.section('2. calls: tokens, grants checked every time, caps, evidence before the result')
  const project = 'app-project'
  const issuePath = await temp('broker-issue-')
  const runDir = path.join(issuePath, 'runs', 'r1')
  await fs.mkdir(runDir, { recursive: true })
  const infra = {
    staging: { id: 'stage', database: { uriRef: 'env:X', databases: [{ name: 'app', collections: ['users', 'orders'] }], caps: { documents: 3, bytes: 2048, timeMs: 500 } }, files: {} },
    deployments: [{ id: 'production', database: { uriRef: 'env:Y', databases: [{ name: 'app' }] }, files: {} }]
  }
  t.eq('configured when an environment declares a database', [brokerConfigured(infra), brokerConfigured({ staging: { id: 's' }, deployments: [] })], [true, false])
  const calls = []
  let now = Date.parse('2026-09-30T10:00:00Z')
  const docs = Array.from({ length: 10 }, (_, i) => ({ _id: i, name: `user-${i}`, pad: 'x'.repeat(100) }))
  const driver = {
    async run (q) {
      calls.push(q)
      if (q.collection === 'slow') return new Promise((resolve, reject) => q.signal.addEventListener('abort', () => reject(new Error('operation exceeded time limit')), { once: true }))
      // The real driver ends its cursor on abort and RESOLVES with what it had.
      if (q.collection === 'partial') return new Promise((resolve) => q.signal.addEventListener('abort', () => resolve(docs.slice(0, 1)), { once: true }))
      if (q.op === 'listCollections') return ['users', 'orders', 'secrets']
      if (q.op === 'count') return docs.length
      return docs.slice(0, q.limit)
    }
  }
  const broker = createBroker({ loadInfrastructure: async () => infra, inspect: async (a) => ({ ...a, available: true, stdout: 'active' }), driverFor: async () => driver,
    clock: { now: () => now, iso: () => new Date(now).toISOString() } })
  const turn = broker.openTurn({ project, issueId: 'i1', issuePath, runId: 'r1', runDir, invocationId: 'inv-1', seat: 'analyser' })
  {
    const r = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'find', database: 'app', collection: 'users', limit: 50 } } })
    t.eq('documents are capped and truncation is marked', [r.result.length <= 3, r.truncated], [true, true])
    t.eq('the driver was asked for one more than the cap', calls.at(-1).limit, 4)
    const receipt = JSON.parse(await fs.readFile(path.join(runDir, r.receipt), 'utf8'))
    t.ok('the call is recorded as run evidence', receipt.tool === 'db_query' && receipt.outcome === 'ok' && receipt.seat === 'analyser' && receipt.grant.kind === 'project' && receipt.truncated === true)
    const agg = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'aggregate', database: 'app', collection: 'users', pipeline: [{ $match: {} }] } } })
    t.eq('an aggregate gets the cap appended as its last stage', calls.at(-1).pipeline.at(-1), { $limit: 4 })
    t.ok('and is capped too', agg.result.length <= 3)
    const cols = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'listCollections', database: 'app' } } })
    t.eq('listCollections shows only granted collections', cols.result, ['users', 'orders'])
    const small = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } })
    t.eq('a count is returned whole', small.result, 10)
    const slow = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'find', database: 'app', collection: 'slow' } } }).then(() => null, (e) => e.message)
    t.eq('an ungranted collection is refused before the driver', /not granted/.test(slow ?? ''), true)
    infra.staging.database.databases[0].collections.push('slow')
    const timed = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'find', database: 'app', collection: 'slow' } } }).then(() => null, (e) => e.message)
    t.ok('the time cap cancels a slow query', /time limit/.test(timed ?? ''), timed)
    infra.staging.database.databases[0].collections.push('partial')
    const partial = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'find', database: 'app', collection: 'partial' } } }).then((r) => r, (e) => e)
    t.ok('a driver that returns a partial result on the cap is a TIMEOUT, not a complete answer', partial instanceof Error && partial.code === 'TIMEOUT', JSON.stringify(partial?.message ?? partial))
    const insp = await broker.call(turn.token, { tool: 'inspect_environment', args: { environment: 'stage', resource: 'status' } })
    t.eq('inspect_environment goes through the same gate', insp.stdout, 'active')
    const many = await Promise.all(Array.from({ length: 5 }, () => broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } })))
    t.eq('concurrent calls get unique receipts', new Set(many.map((m) => m.receipt)).size, 5)
  }
  {
    const denied = await broker.call(turn.token, { tool: 'db_query', args: { environment: 'production', query: { op: 'count', database: 'app', collection: 'users' } } }).then(() => null, (e) => e.message)
    t.ok('production without an operator grant is refused', /no operator grant/.test(denied ?? ''), denied)
    t.ok('the supervisor cannot grant', await writeGrant(issuePath, { environment: 'production', reason: 'x', expiresAt: '2026-10-01T00:00:00Z', by: 'supervisor' }).then(() => false, () => true))
    const grant = await writeGrant(issuePath, { environment: 'production', reason: 'incident 42', expiresAt: '2026-09-30T11:00:00Z', seats: ['analyser'] })
    t.eq('a granted seat may query production', (await broker.call(turn.token, { tool: 'db_query', args: { environment: 'production', query: { op: 'count', database: 'app', collection: 'users' } } })).result, 10)
    const other = broker.openTurn({ project, issueId: 'i1', issuePath, runId: 'r1', runDir, invocationId: 'inv-2', seat: 'coordinator' })
    t.ok('another seat may not execute under it', await broker.call(other.token, { tool: 'db_query', args: { environment: 'production', query: { op: 'count', database: 'app', collection: 'users' } } }).then(() => false, (e) => /no operator grant/.test(e.message)))
    now = Date.parse('2026-09-30T11:30:00Z')
    t.ok('expiry takes effect mid-run', await broker.call(turn.token, { tool: 'db_query', args: { environment: 'production', query: { op: 'count', database: 'app', collection: 'users' } } }).then(() => false, (e) => /no operator grant/.test(e.message)))
    now = Date.parse('2026-09-30T10:30:00Z')
    await revokeGrant(issuePath, grant.id)
    t.ok('revocation takes effect mid-run', await broker.call(turn.token, { tool: 'db_query', args: { environment: 'production', query: { op: 'count', database: 'app', collection: 'users' } } }).then(() => false, (e) => /no operator grant/.test(e.message)))
    turn.revoke()
    t.ok('a revoked turn token is refused', await broker.call(turn.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } }).then(() => false, (e) => e.code === 'TOKEN'))
    const restarted = createBroker({ loadInfrastructure: async () => infra, inspect: async () => ({}), driverFor: async () => driver })
    t.ok('a token from before a restart is unknown', await restarted.call(other.token, { tool: 'db_query', args: {} }).then(() => false, (e) => e.code === 'TOKEN'))
    const refusals = (await fs.readdir(path.join(runDir, 'evidence', 'broker'))).length
    t.ok('refusals are recorded too', refusals >= 16, String(refusals))
  }
  {
    const badRun = path.join(await temp('broker-bad-'), 'run')
    await fs.mkdir(badRun, { recursive: true })
    await fs.writeFile(path.join(badRun, 'evidence'), 'not a directory')
    const t2 = broker.openTurn({ project, issueId: 'i1', issuePath, runId: 'r2', runDir: badRun, invocationId: 'inv-3', seat: 'analyser' })
    const out = await broker.call(t2.token, { tool: 'db_query', args: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } }).then(() => null, (e) => e)
    t.ok('a call that cannot be recorded returns no result', out?.code === 'RECORD', out?.message)
  }

  t.section('3. the MCP shim, over the per-turn socket')
  {
    const turn2 = broker.openTurn({ project, issueId: 'i1', issuePath, runId: 'r1', runDir, invocationId: 'inv-4', seat: 'analyser' })
    const dir = await temp('dpb-test-')
    const served = await broker.serveTurn({ socketPath: path.join(dir, 's'), token: turn2.token })
    const rpc = async (token, messages) => {
      const child = spawn(process.execPath, [SHIM], { env: { PATH: process.env.PATH, DEVPANEL_BROKER_SOCKET: path.join(dir, 's'), DEVPANEL_BROKER_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (c) => { out += c })
      for (const m of messages) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
      const expected = messages.filter((m) => m.id !== undefined).length
      for (let i = 0; i < 200 && out.split('\n').filter(Boolean).length < expected; i++) await new Promise((r) => setTimeout(r, 20))
      child.kill()
      return out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }
    const replies = await rpc(turn2.token, [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'db_query', arguments: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } } },
      { id: 4, method: 'tools/call', params: { name: 'db_query', arguments: { environment: 'stage', query: { op: 'find', database: 'app', collection: 'users', filter: { $where: '1' } } } } }
    ])
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]))
    t.eq('initialize answers with tools capability', Boolean(byId[1]?.result?.capabilities?.tools), true)
    t.eq('two tools are listed', byId[2]?.result?.tools?.map((x) => x.name), ['inspect_environment', 'db_query'])
    t.eq('a query returns its result', JSON.parse(byId[3]?.result?.content?.[0]?.text ?? '{}').result, 10)
    t.ok('a forbidden query is an error result', byId[4]?.result?.isError === true && /\$where/.test(byId[4].result.content[0].text))
    const wrong = await rpc('not-the-token', [{ id: 1, method: 'tools/call', params: { name: 'db_query', arguments: { environment: 'stage', query: { op: 'count', database: 'app', collection: 'users' } } } }])
    t.ok('a wrong token is refused at the socket', wrong[0]?.result?.isError === true && /token/.test(wrong[0].result.content[0].text))
    // A leftover process holding a connection open must not hold the turn open.
    const dangling = net.connect(path.join(dir, 's'))
    await new Promise((r) => dangling.once('connect', r))
    const closed = await Promise.race([served.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 1500))])
    t.eq('close() ends although a connection is held open', closed, 'closed')
    dangling.destroy()
    turn2.revoke()
  }
  t.section('4. the engine attaches the broker to seats with tools, for the invocation only')
  {
    const seen = []
    const f = await engineFixture({ script: scriptFor() })
    const original = f.harnesses.fake.invoke
    f.harnesses.fake.invoke = async (options) => {
      const alive = options.broker ? await fs.stat(options.broker.socket).then(() => true, () => false) : null
      seen.push({ role: options.meta?.role, broker: options.broker, alive, prompt: options.prompt })
      return original(options)
    }
    const infraFile = path.join(f.configRoot, 'projects', 'devpanel-project.yaml')
    await fs.mkdir(path.dirname(infraFile), { recursive: true })
    await fs.writeFile(infraFile, YAML.stringify({ id: 'devpanel-project', infrastructure: {
      kind: 'boilerplate', orientation: 'Orientation.',
      staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage.invalid', workdir: '/srv' }, projectRoot: '/opt/stage', files: {}, database: { uriRef: 'env:DEVPANEL_TEST_NO_URI', databases: [{ name: 'app' }] } },
      deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:production.invalid', workdir: '/srv' }, projectRoot: '/opt/production', files: {} }],
      testDrive: { commands: [{ id: 'candidate', run: 'true' }] } } }))
    const savedSsh = process.env.DEVPANEL_SSH_BIN
    // Answers the `ssh -G` a drive reads its host with, and connects nowhere.
    const noSsh = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'broker-ssh-')), 'ssh')
    await fs.writeFile(noSsh, '#!/bin/sh\nif [ "$1" = -G ]; then echo "hostname stage.invalid"; exit 0; fi\nexit 1\n', { mode: 0o755 })
    process.env.DEVPANEL_SSH_BIN = noSsh
    try {
      const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath,
        configRoot: f.configRoot, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
      await engine.drive()
      const workers = seen.filter((x) => x.role !== 'coordinator')
      t.ok('every seat with tools got the broker, its socket live during the turn', workers.length > 0 && workers.every((x) => x.broker?.token && x.alive === true), JSON.stringify(workers.map((x) => [x.role, Boolean(x.broker), x.alive])))
      t.ok('tool-free coordinator turns did not', seen.filter((x) => x.role === 'coordinator').every((x) => !x.broker))
      t.ok('each turn had its own token', new Set(workers.map((x) => x.broker.token)).size === workers.length)
      t.ok('the socket is gone after the turn', !(await fs.stat(workers[0].broker.socket).then(() => true, () => false)))
      t.ok('the brief names the broker tools instead of SSH', workers.every((x) => /db_query/.test(x.prompt) && /never over SSH/.test(x.prompt)))
      await releaseWorkspace(engine)
    } finally { if (savedSsh === undefined) delete process.env.DEVPANEL_SSH_BIN; else process.env.DEVPANEL_SSH_BIN = savedSsh }
  }
  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}
