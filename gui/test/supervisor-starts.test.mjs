import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { createStartGate, concurrentStarts, migrateStartLimits } from '../server/supervisor-starts.mjs'
import { inspectLaunchState } from '../server/supervisor-launch-state.mjs'
import { remainingBudget } from '../server/supervisor-summary.mjs'

export const name = 'supervisor starts — durable scopes, reservations and useful retries'
const exec = promisify(execFile)
const rejected = async (fn) => { try { await fn(); return null } catch (e) { return e } }
const wait = async (test) => { const until = Date.now() + 5000; while (!test()) { if (Date.now() > until) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 5)) } }
const preview = (issueId, project = 'p', configHash = 'config') => ({ project, issueId, playbook: 'test', runOptions: {}, configHash })
const fresh = (limits = {}) => ({ status: 'active', starts: 0, calls: 0, startsByIssue: {}, launches: [], failedLaunches: {}, ownedRuns: [], activationStarts: 0, activationId: 'activation', limits: { maxRuns: 10, maxStartsPerIssue: 2, maxConcurrent: 2, maxCalls: 20, ...limits } })

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-starts-'))
  const services = []
  try {
    t.section('session limits: Start and restart resume the allowance; New session begins a fresh one')
    const dir = path.join(root, 'service')
    let actions = [], launches = 0
    const runs = new Map()
    const tools = {
      projects: async () => [{ id: 'p' }, { id: 'q' }], playbooks: async () => [], listIssues: async () => [],
      preview: async () => ({ ok: true, configHash: 'config' }),
      start: async () => { const run = { runId: `r${++launches}`, status: 'completed' }; runs.set(run.runId, run); return run },
      getRun: async (_p, _i, id) => runs.get(id), stop: async () => {}
    }
    const models = async () => [{ id: 'm', model: 'wire', verification: { status: 'verified' } }]
    const adapter = { invoke: async (a) => ({ session: a.session ?? { id: 'session' }, response: JSON.stringify({ message: 'action', action: actions.shift()?.(JSON.parse(a.prompt).event) ?? null }), usage: { costUsd: 0 } }) }
    const make = async () => { const s = await createTopSupervisor({ dir, models, tools, adapter, pollMs: 10000 }); services.push(s); return s }
    const activate = async (s, issueId, project = 'p', limits) => {
      actions = [() => ({ type: 'preview', project, issueId, playbook: 'test' }), (e) => ({ type: 'start_run', project, issueId, previewId: e.result.previewId })]
      const before = s.get().calls ?? 0
      await s.start({ model: 'm', projects: ['p', 'q'], message: 'one launch', ...(limits ? { limits } : {}) })
      await wait(() => s.get().status === 'active' && s.get().calls === before + 3 && !s.get().pending)
      await s.stop()
    }
    let service = await make()
    await activate(service, 'issue', 'p', { maxRuns: 4, maxStartsPerIssue: 2, maxCalls: 20, maxConcurrent: 2 })
    await activate(service, 'issue')
    t.eq('two activations share the issue allowance', launches, 2)
    t.eq('calls accumulate across activations: Start resumes the session allowance', service.get().calls, 6)
    t.eq('activation starts have a separate counter', service.get().activationStarts, 1)
    await service.shutdown()
    service = await make()
    t.eq('a server restart preserves the session counters', [service.get().calls, service.get().starts, service.get().startsByIssue['p/issue']], [6, 2, 2])
    await activate(service, 'issue')
    t.eq('restart cannot buy a third issue start', launches, 2)
    t.eq('and calls keep accumulating after it', service.get().calls, 9)
    t.eq('per-issue usage remains cumulative', service.get().startsByIssue['p/issue'], 2)
    t.eq('omitting limits retains the saved caps', service.get().limits.maxRuns, 4)
    await service.reset()
    t.eq('New session begins with fresh session counters', [service.get().calls, service.get().starts, JSON.stringify(service.get().startsByIssue)], [0, 0, '{}'])
    t.eq('and what the previous session used is history', [service.get().history.sessions, service.get().history.starts, service.get().history.startsByIssue['p/issue']], [1, 2, 2])
    await activate(service, 'issue')
    t.eq('New session permits the issue another attempt', launches, 3)
    await activate(service, 'issue')
    await activate(service, 'issue')
    t.eq('bounded again by the per-issue cap within the new session', launches, 4)
    await activate(service, 'issue', 'q')
    t.eq('the same issue slug in another project has its own allowance', launches, 5)
    await activate(service, 'other')
    t.eq('another issue uses the fourth session slot', launches, 6)
    await activate(service, 'last')
    t.eq('the session cap holds until New session', launches, 6)
    const remaining = remainingBudget(service.get())
    t.eq('session remaining is exhausted', remaining.starts.remaining, 0)
    t.eq('and it says so rather than leaving it to arithmetic', remaining.starts.exhausted, true)
    t.ok('naming New session as the way out', /New session/.test(remaining.starts.consequence), remaining.starts.consequence)
    t.eq('scope is explicit', [remaining.scopes.maxRuns, remaining.scopes.maxStartsPerIssue, remaining.scopes.maxCalls], ['session', 'project/issue, this session', 'session'])
    t.eq('history is reported as accounting, never as a gate', [remaining.history.role, remaining.history.decides], ['accounting', false])
    await service.reset()
    // History survives; settled work does not. A finished run is history, and
    // carrying it forward makes a fresh session read last week's work as its own business.
    t.eq('the history sums every earlier session', [service.get().history.sessions, service.get().history.starts], [2, 6])
    t.ok('no settled run followed the new session', service.get().ownedRuns.every((r) => !['completed', 'cancelled', 'failed', 'blocked'].includes(r.status)), JSON.stringify(service.get().ownedRuns.map((r) => r.status)))
    await activate(service, 'last')
    t.eq('New session opens a fresh session allowance', launches, 7)

    t.section('an asynchronous failed run cannot be repeated by Start; New session permits one more deliberate attempt')
    {
      let failedStarts = 0
      const failedTools = { ...tools,
        start: async () => ({ runId: `failed${++failedStarts}`, status: 'failed' }),
        getRun: async () => ({ status: 'failed', blockedReason: 'known unresolved condition' }) }
      const makeFailing = async () => { const s = await createTopSupervisor({ dir: path.join(root, 'failed-service'), models, adapter, tools: failedTools, pollMs: 10000 }); services.push(s); return s }
      let failureService = await makeFailing()
      await activate(failureService, 'a', 'p', { maxStartsPerIssue: 4 })
      await activate(failureService, 'a')
      t.eq('failed input launched only once across activations', failedStarts, 1)
      t.eq('rejected retries did not spend extra starts', failureService.get().starts, 1)
      await failureService.shutdown()
      failureService = await makeFailing()
      t.ok('the guard is on disk across a server restart', Object.keys(failureService.get().failedLaunches).length > 0)
      await activate(failureService, 'a')
      t.eq('and still blocks the unchanged input after it', failedStarts, 1)
      await failureService.reset()
      t.eq('New session clears the failed-launch guards', Object.keys(failureService.get().failedLaunches).length, 0)
      await activate(failureService, 'a')
      t.eq('and permits one more attempt at the unchanged input', failedStarts, 2)
      await activate(failureService, 'a')
      t.eq('which, failing again, is guarded again for the rest of the session', failedStarts, 2)
      t.ok('with the guard on record', Object.keys(failureService.get().failedLaunches).length > 0)
    }

    t.section('simultaneous launches reserve global and concurrent capacity before the external start')
    for (const limits of [{ maxRuns: 1, maxConcurrent: 2 }, { maxRuns: 10, maxConcurrent: 1 }]) {
      let state = fresh(limits), release, called = 0
      const file = path.join(root, `reservation-${limits.maxRuns}.json`)
      const gate = createStartGate({ getState: () => state, save: () => fs.writeFile(file, JSON.stringify(state)), tools: {
        getRun: async () => ({ status: 'completed' }),
        start: async () => {
          called++
          const disk = JSON.parse(await fs.readFile(file, 'utf8'))
          t.eq('attempt charged before external launch', disk.starts, 1)
          t.eq('concurrency reserved before external launch', concurrentStarts(disk), 1)
          await new Promise((r) => { release = r })
          return { runId: 'reserved-run', status: 'running' }
        }
      } })
      const first = gate.start(preview('first'))
      await wait(() => Boolean(release))
      const second = await rejected(() => gate.start(preview('second', 'q')))
      t.ok('competing decision refused', Boolean(second))
      t.eq('only one external launch', called, 1)
      release(); await first
      t.eq('reserved slot transferred to owned run', concurrentStarts(state), 1)
      state = JSON.parse(await fs.readFile(file, 'utf8'))
      state.launches[0].status = 'reserved'; delete state.launches[0].runId
      state.ownedRuns = []
      t.eq('a recovered reservation still consumes concurrency', concurrentStarts(state), 1)
    }

    t.section('independent launches can use separate available slots')
    {
      const state = fresh(), releases = [], calls = []
      const gate = createStartGate({ getState: () => state, save: async () => {}, tools: {
        getRun: async () => ({ status: 'running' }),
        start: async (p) => { calls.push(p); await new Promise((r) => releases.push(r)); return { runId: p.issueId, status: 'running' } }
      } })
      const first = gate.start(preview('a'))
      const second = gate.start(preview('b', 'q'))
      await wait(() => releases.length === 2)
      t.eq('two independent slots reserved', concurrentStarts(state), 2)
      t.eq('both attempts charged', state.starts, 2)
      releases.forEach((r) => r()); await Promise.all([first, second])
      t.eq('distinct durable launch identifiers', new Set(calls.map((p) => p.launchId)).size, 2)
    }

    t.section('failure guards and uncertain reservations persist; useful retries stay charged')
    {
      let state = fresh({ maxStartsPerIssue: 4 }), calls = 0, input = 'original', mode = 'failed'
      const file = path.join(root, 'failure.json')
      const tools = {
        launchState: async () => ({ key: input }), getRun: async () => ({ status: 'failed', blockedReason: 'same failure' }),
        start: async () => { calls++; if (mode !== 'success') throw Object.assign(new Error('same failure'), mode === 'failed' ? { started: false } : {}); return { runId: `r${calls}`, status: 'running' } }
      }
      const make = () => createStartGate({ getState: () => state, save: () => fs.writeFile(file, JSON.stringify(state)), tools })
      let gate = make()
      await rejected(() => gate.start(preview('a')))
      t.eq('definite failure consumes lifetime usage', state.starts, 1)
      t.eq('definite non-start releases concurrency', concurrentStarts(state), 0)
      state = JSON.parse(await fs.readFile(file, 'utf8')); gate = make()
      await rejected(() => gate.start(preview('a')))
      t.eq('same failure is not retried after restart', calls, 1)
      t.eq('admission rejection does not consume another attempt', state.starts, 1)
      input = 'changed'; mode = 'unknown'
      await rejected(() => gate.start(preview('a')))
      t.eq('changed inputs permit a bounded retry', calls, 2)
      t.eq('unknown result retains capacity', concurrentStarts(state), 1)
      state = JSON.parse(await fs.readFile(file, 'utf8')); gate = make()
      input = 'changed-again'
      t.ok('unknown launch cannot be repeated even with changed inputs', await rejected(() => gate.start(preview('a'))))
      const launchId = state.launches.at(-1).id
      await gate.reconcile({ launchId, notStarted: true, reason: 'Inspected run storage and confirmed no run was created' })
      t.eq('reconciliation releases the slot', concurrentStarts(state), 0)
      t.eq('reconciliation does not refund starts', state.starts, 2)
      mode = 'success'; await gate.start(preview('a'))
      t.eq('useful retry remains inside the cumulative allowance', state.starts, 3)
      await gate.refresh()
      t.ok('asynchronous run failure also blocks unchanged retry', await rejected(() => gate.start(preview('a'))))
      const failed = state.launches.at(-1)
      await gate.retry({ launchId: failed.id, reason: 'Verified external service repair that is not represented by source/config hashes' })
      await gate.start(preview('a'))
      t.eq('explicit operator disposition still consumes the final allowance', state.starts, 4)
      t.ok('operator disposition cannot widen the per-issue cap', await rejected(() => gate.start(preview('a', 'p', 'new-config'))))
    }

    t.section('uncertain receipts must match the durable launch identifier')
    {
      const state = fresh()
      let receiptId = 'unrelated'
      const gate = createStartGate({ getState: () => state, save: async () => {}, tools: {
        start: async () => { throw new Error('Receipt interrupted') },
        getRun: async () => ({ status: 'running', supervisorLaunchId: receiptId })
      } })
      await rejected(() => gate.start(preview('a')))
      const launchId = state.launches[0].id
      t.ok('unrelated run cannot settle a reservation', await rejected(() => gate.reconcile({ launchId, runId: 'actual', reason: 'Inspect persisted receipt' })))
      receiptId = launchId
      await gate.reconcile({ launchId, runId: 'actual', reason: 'Persisted run carries the matching launch identifier' })
      t.eq('matching receipt becomes owned', state.ownedRuns[0].runId, 'actual')
      t.eq('receipt reconciliation keeps its start charge', state.starts, 1)
      t.eq('running receipt keeps its concurrency slot', concurrentStarts(state), 1)
    }

    t.section('legacy migration uses persistent ownership and archived sessions, not only the last activation')
    {
      const dir = path.join(root, 'legacy'); await fs.mkdir(dir)
      const owned = (n) => ({ project: 'p', issueId: 'a', runId: `old${n}`, status: 'completed' })
      await fs.writeFile(path.join(dir, 'state.old.json'), JSON.stringify({ starts: 1, startsByIssue: { 'p/a': 1 }, ownedRuns: [owned(5)] }))
      const state = { starts: 2, startsByIssue: { 'p/a': 2 }, ownedRuns: [1, 2, 3, 4].map(owned) }
      await migrateStartLimits(state, dir)
      // Legacy counters were lifetime sums; they become history, not this session's usage.
      t.eq('four starts over two activations plus archived start recovered as history', state.history.starts, 5)
      t.eq('per-issue history recovers all owned attempts', state.history.startsByIssue['p/a'], 5)
      t.eq('and none of it is charged to the session', [state.starts, JSON.stringify(state.startsByIssue), state.startBudgetVersion], [0, '{}', 2])
      await migrateStartLimits(state, dir)
      t.eq('migration is idempotent', [state.history.starts, state.starts], [5, 0])
      const interrupted = { starts: 0, ownedRuns: [], pending: { kind: 'action', action: { type: 'start_run', project: 'p', issueId: 'unattributed' } } }
      const emptyDir = path.join(root, 'interrupted'); await fs.mkdir(emptyDir)
      await migrateStartLimits(interrupted, emptyDir)
      t.eq('legacy ambiguous launch consumes a concurrent reservation', concurrentStarts(interrupted), 1)
      t.eq('legacy ambiguous launch is remembered in history', interrupted.history.startsByIssue['p/unattributed'], 1)

      // A version-1 state whose counters were lifetime sums: the session's own
      // usage is read back from the launches it made since its last New session.
      const v1 = {
        startBudgetVersion: 1, starts: 9, startsByIssue: { 'p/a': 6, 'p/b': 3 }, failedLaunches: { k: {} }, ownedRuns: [],
        reset: { at: '2026-09-16T01:00:00.000Z' },
        launches: [
          { id: '1', project: 'p', issueId: 'a', status: 'finished', at: '2026-09-15T23:00:00.000Z' },
          { id: '2', project: 'p', issueId: 'a', status: 'finished', at: '2026-09-16T02:00:00.000Z' },
          { id: '3', project: 'p', issueId: 'b', status: 'started', at: '2026-09-16T03:00:00.000Z' },
          { id: '4', project: 'p', issueId: 'c', status: 'uncertain', migrated: true }
        ]
      }
      await migrateStartLimits(v1, emptyDir)
      t.eq('lifetime sums move into history', [v1.history.starts, v1.history.startsByIssue['p/a']], [9, 6])
      t.eq('the session is charged only its own launches since the last New session', [v1.starts, v1.startsByIssue['p/a'], v1.startsByIssue['p/b'], v1.startsByIssue['p/c'] ?? 0], [2, 1, 1, 0])
      t.eq('failed-launch guards of the running session are kept', Object.keys(v1.failedLaunches).length, 1)
      t.eq('and the migration is on record', typeof v1.startLimitMigration.sessionScope.at, 'string')
    }

    t.section('the same dirty checkout is rejected before launch, even under a new configuration')
    {
      const projectPath = path.join(root, 'repo'); await fs.mkdir(projectPath)
      const git = (args) => exec('git', ['-C', projectPath, ...args])
      await git(['init', '-q']); await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.invalid'])
      const source = path.join(projectPath, 'source.txt')
      await fs.writeFile(source, 'base'); await git(['add', '.']); await git(['commit', '-qm', 'base'])
      const state = fresh(), launched = []
      const gate = createStartGate({ getState: () => state, save: async () => {}, tools: {
        launchState: (p) => inspectLaunchState({ projectPath, configHash: p.configHash, workspace: { base: p.runOptions.base ?? 'head' } }),
        getRun: async () => ({ status: 'completed' }), start: async (p) => { launched.push(p); return { runId: 'clean-run', status: 'completed' } }
      } })
      await fs.writeFile(source, 'dirty')
      t.ok('dirty checkout blocked', /clean checkout/.test((await rejected(() => gate.start(preview('a'))))?.message))
      await fs.writeFile(source, 'still dirty')
      t.ok('new preview/config cannot bypass dirty-base condition', /clean checkout/.test((await rejected(() => gate.start(preview('a', 'p', 'different'))))?.message))
      t.eq('no actual launch or paid preflight', launched.length, 0)
      t.eq('no retry allowance spent on known inadmissible attempts', state.starts, 0)
      const alternative = await inspectLaunchState({ projectPath, configHash: 'config', workspace: { base: 'working-tree' } })
      t.eq('explicit working-tree base is permitted', alternative.blockedReason, undefined)
      await fs.writeFile(source, 'base')
      await gate.start(preview('a'))
      t.eq('repairing the checkout permits a launch', launched.length, 1)
    }

    t.section('an ending the settle timer reads first still wakes the monitoring poll')
    {
      const state = fresh()
      let status = 'preflighting'
      const gate = createStartGate({ getState: () => state, save: async () => {}, tools: {
        getRun: async () => ({ status, blockedReason: status === 'failed' ? 'preflight-refused' : null }),
        start: async () => ({ runId: 'r', status })
      } })
      await gate.start(preview('a'))
      status = 'failed'
      await gate.refresh()
      const owned = state.ownedRuns[0]
      t.eq('refresh records the ending on the launch and the owned run', [state.launches[0].status, owned.status], ['finished', 'failed'])
      t.eq('but the poll baseline still holds what monitoring last saw, so the poll reports the change', owned.observedStatus, 'preflighting')
    }

    t.section('a preflight refused only for want of proof does not guard the unchanged start')
    {
      const state = fresh({ maxStartsPerIssue: 3 })
      let counts = { failures: 0, unproven: 2 }, launched = 0
      const gate = createStartGate({ getState: () => state, save: async () => {}, tools: {
        getRun: async () => ({ status: 'failed', blockedReason: 'preflight-refused', preflight: { state: 'refused', counts } }),
        start: async () => ({ runId: `r${++launched}`, status: 'preflighting' })
      } })
      await gate.start(preview('a'))
      await gate.refresh()
      t.eq('a timed-out probe leaves no failed-launch guard', Object.keys(state.failedLaunches).length, 0)
      await gate.start(preview('a'))
      t.eq('so the same start is accepted again', launched, 2)
      // Mixed: one real failure beside a timed-out probe is still a fact about the inputs.
      counts = { failures: 1, unproven: 1 }
      await gate.refresh()
      t.eq('a refusal with a real failure beside an unproven one is guarded', Object.values(state.failedLaunches).map((f) => f.reason), ['preflight-refused'])
      t.ok('and the unchanged start is refused', /Unchanged failed launch is blocked/.test((await rejected(() => gate.start(preview('a'))))?.message))
      t.eq('no third launch was made', launched, 2)
      const older = fresh()
      const olderGate = createStartGate({ getState: () => older, save: async () => {}, tools: {
        getRun: async () => ({ status: 'failed', blockedReason: 'preflight-refused', preflight: { state: 'refused', summary: '0 failure(s), 2 unproven' } }),
        start: async () => ({ runId: 'old', status: 'preflighting' })
      } })
      await olderGate.start(preview('a'))
      await olderGate.refresh()
      t.eq('a record without counts (older runs) stays guarded as before', Object.keys(older.failedLaunches).length, 1)
    }

    t.section('a start refused for momentary occupancy is neither guarded nor charged, however often it happens')
    {
      const state = fresh({ maxStartsPerIssue: 2, maxRuns: 3 }), released = []
      let busy = true, launched = 0
      const gate = createStartGate({
        getState: () => state, save: async () => {},
        ledger: { reserve: async () => {}, settle: async () => {}, release: async (r) => { released.push(r.id) } },
        tools: {
          getRun: async () => ({ status: 'running' }),
          start: async () => {
            if (busy) throw Object.assign(new Error('a run is already active on this project (issue x); wait for it to finish'), { status: 409, started: false, retryable: true })
            return { runId: `r${++launched}`, status: 'running' }
          }
        }
      })
      for (let n = 0; n < 5; n++) t.ok(`refusal ${n + 1} reaches the caller as retryable`, (await rejected(() => gate.start(preview('a'))))?.retryable === true)
      t.eq('no guard was recorded', state.failedLaunches, {})
      t.eq('no slot or reservation is held', [concurrentStarts(state), state.launches.filter((a) => a.status === 'reserved' || a.status === 'uncertain').length], [0, 0])
      t.eq('every ledger reservation was released', released.length, 5)
      t.eq('and no start was spent', [state.starts, state.activationStarts, JSON.stringify(state.startsByIssue)], [0, 0, '{}'])
      t.ok('each attempt says its charge came back', state.launches.every((a) => a.status === 'failed' && a.chargeReturned === true))
      busy = false
      await gate.start(preview('a'))
      t.eq('once the occupancy clears the identical start is admitted', launched, 1)
      t.eq('and that genuine launch is charged', [state.starts, state.startsByIssue['p/a']], [1, 1])
      await gate.start(preview('a'))
      t.ok('so the per-issue cap still bounds real launches', /Start limit reached for this issue/.test((await rejected(() => gate.start(preview('a'))))?.message))
      t.eq('and no third launch was made', launched, 2)
    }

    t.section('a retryable error with no proof of a non-start keeps its reservation and its charge')
    {
      const state = fresh()
      const gate = createStartGate({ getState: () => state, save: async () => {}, tools: {
        getRun: async () => ({ status: 'running' }),
        start: async () => { throw Object.assign(new Error('connection lost mid-launch'), { retryable: true }) }
      } })
      await rejected(() => gate.start(preview('a')))
      t.eq('the outcome stays uncertain, holding the slot', [state.launches[0].status, concurrentStarts(state)], ['uncertain', 1])
      t.eq('and the charge', state.starts, 1)
      t.eq('with no guard', state.failedLaunches, {})
    }

    t.section('the gate marks its own occupancy refusals')
    {
      const state = fresh({ maxConcurrent: 1 })
      let stoppingNow = false, launched = 0
      const gate = createStartGate({ getState: () => state, save: async () => {}, stopping: () => stoppingNow, tools: {
        getRun: async () => ({ status: state.launches[0]?.finishedForTest ? 'completed' : 'running' }),
        start: async () => ({ runId: `r${++launched}`, status: 'running' })
      } })
      await gate.start(preview('a'))
      const full = await rejected(() => gate.start(preview('b')))
      t.ok('the concurrency limit refuses', /Concurrent-run limit/.test(full?.message), full?.message)
      t.eq('as retryable, with nothing started', [full?.retryable, full?.started], [true, false])
      t.eq('charging nothing', state.starts, 1)
      state.launches[0].finishedForTest = true
      await gate.start(preview('b'))
      t.eq('the same start passes once the slot frees', launched, 2)
      stoppingNow = true
      const stopped = await rejected(() => gate.start(preview('c')))
      t.eq('a stopping supervisor refuses retryably too', [/stopping/.test(stopped?.message), stopped?.retryable, stopped?.started], [true, true, false])
      stoppingNow = false

      const policyState = fresh()
      const policyGate = createStartGate({
        getState: () => policyState, save: async () => {}, tools: {},
        ledger: { usage: () => ({ day: {}, month: {} }) },
        policy: { active: true, policy: { concurrent: 0, daily: {}, monthly: {}, perWakeCalls: 1 } }
      })
      const policyRefused = await rejected(() => policyGate.start(preview('a')))
      t.eq('the spending policy\'s concurrency limit is marked as well', [policyRefused?.limit, policyRefused?.retryable, policyRefused?.started], ['concurrent', true, false])
    }
  } finally {
    for (const s of services) await s.shutdown()
    await fs.rm(root, { recursive: true, force: true })
  }
}
