import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readRun, writeRun, readPrompts } from '../server/runtime/store.mjs'
import { ProcessError } from '../server/runtime/process.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { recordInstruction, selectInstructions, legacyTurnRecord, turnIdentity, instructionsBlock, readChat } from '../server/runtime/coordinator-chat.mjs'
import { engineFixture, scriptFor, blocking, simulateProcessDeath, pausingStrategy } from './fakes/fixture.mjs'

export const name = 'operator instructions reach the next turn of every seat (coordinator-chat.mjs, engine attachInstructions)'

const A = 'Alpha: keep the public API unchanged.'
const B = 'Bravo: log every retry.'
const C = 'Charlie: no new dependencies.'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
class Crash extends Error {}

const base = (f) => ({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, issuePath: f.issuePath, projectPath: f.projectPath, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
const start = (f, invoke = f.fake.invoke, extra = {}) => startRun({ ...base(f), harnesses: { fake: { ...f.fake, invoke } }, ...extra })
const instruct = (f, engine, text) => recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: engine.run, text, actor: 'Alice' })
const recorder = (f, seen, before = null) => async (a) => { seen.push(a); await before?.(a); return f.fake.invoke(a) }
const reopen = async (f, runId, fake = {}) => {
  await simulateProcessDeath(f.issuePath)
  return resumeRun({ issuePath: f.issuePath, runId, harnesses: { fake: { ...f.fake, ...fake } }, stepStore: f.stepStore, clock: f.clock,
    configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
}
/** Drive until the hook throws, the way a process dies there: nothing after it runs. */
async function crashOn (engine, hook, when) {
  engine.hooks[hook] = async (e) => { if (when(e)) { delete e.hooks[hook]; throw new Crash(hook) } }
  try { await engine.drive() } catch (error) { if (error instanceof Crash) return true; throw error }
  return false
}
const auditOf = (role = 'auditor-1', round = 0) => (e) => { const c = e.run.participants[role]?.pendingInvocation?.cursor; return Boolean(c?.stepId?.startsWith('audit-implement')) && c.round === round }
const stepsOf = (run, role, stepPrefix) => run.steps.filter((s) => s.role === role && s.stepId.startsWith(stepPrefix))
const uncertain = { reconcile: async () => ({ phase: 'uncertain', reason: 'invocation recorded as started' }) }
const rateLimited = (invocationId) => new ProcessError('claude exited 1', { kind: 'runtime-error', code: 1, stderr: 'API Error: 429 rate_limit_error retry-after: 7', invocationId })
const earlierCount = (prompt) => (prompt.match(/\(given earlier\)/g) ?? []).length

export default async function (t) {
  t.section('1. selecting a launch\'s instructions: per seat, per turn, per session')
  {
    const e = (id) => ({ id, kind: 'instruction', at: '2026-11-25T00:00:00Z', actor: 'op', text: id })
    const AB = [e('A'), e('B')]
    const rec = (key, ids, available, scope = 'main', reached = true) => ({ key, snapshot: { ids, available }, reached: reached ? [{ invocationId: 'x', scope }] : [] })
    let s = selectInstructions({ entries: AB, steps: [], role: 'auditor-1', record: rec('K', ['A'], ['A']), key: 'K' })
    t.eq('a replay carries its turn\'s snapshot, not what came later, on a fresh session, all marked earlier', [s.replay, s.list.map((x) => x.id), [...s.earlier], s.reset], [true, ['A'], ['A'], ['main']])
    s = selectInstructions({ entries: AB, steps: [], role: 'auditor-1', record: rec('K', [], ['A']), key: 'K' })
    t.eq('an empty snapshot replayed in its own scope keeps the session and carries []', [s.list.length, s.reset], [0, []])
    s = selectInstructions({ entries: AB, steps: [], role: 'coordinator', scope: 'main', record: rec('K', [], ['A'], 'read'), key: 'K' })
    t.eq('…replayed in a scope no reached attempt used, that scope is reset and the boundary is carried, marked earlier', [s.reset, s.list.map((x) => x.id), [...s.earlier]], [['main'], ['A'], ['A']])
    s = selectInstructions({ entries: AB, steps: [], role: 'auditor-1', record: rec('K', ['A'], ['A'], 'main', false), key: 'K' })
    t.eq('a turn no attempt reached selects again from the chat', [s.replay, s.list.map((x) => x.id), s.reset], [false, ['A', 'B'], []])
    s = selectInstructions({ entries: AB, steps: [{ role: 'coordinator', instructions: ['A'] }], role: 'coordinator', scope: 'main', record: rec('other', ['A'], ['A'], 'read'), key: 'K' })
    t.eq('another turn\'s read record adds nothing to a kept main session, and resets the read one', [s.replay, s.list.map((x) => x.id), s.reset], [false, ['B'], ['read']])
    const k1 = turnIdentity({ phase: 'p', stepId: 'audit-implement-1', round: 0, attempt: 1, recheck: 'r', recheckDrive: 'd1' })
    const k2 = turnIdentity({ phase: 'p', stepId: 'audit-implement-1', round: 0, attempt: 1, recheck: 'r', recheckDrive: 'd2' })
    s = selectInstructions({ entries: AB, steps: [], role: 'auditor-1', record: rec(k1, ['A'], ['A']), key: k2 })
    t.ok('a re-review for another drive is another turn', k1 !== k2 && !s.replay && s.list.map((x) => x.id).join() === 'A,B', JSON.stringify(s))
    s = selectInstructions({ entries: AB, steps: [{ role: 'auditor-1', instructions: ['A'] }], role: 'coordinator', freshSession: false })
    t.eq('a resumed session marks nothing earlier, whoever carried first', [s.list.map((x) => x.id), s.earlier.size], [['A', 'B'], 0])
    s = selectInstructions({ entries: AB, steps: [{ role: 'auditor-1', instructions: ['A'] }, { role: 'coordinator', instructions: ['B'] }], role: 'auditor-1', freshSession: true })
    t.eq('a fresh session gets all, marked as this seat\'s own earlier carries', [s.list.map((x) => x.id), [...s.earlier]], [['A', 'B'], ['A']])
    const legacy = legacyTurnRecord({ invocationId: 'p1', cursor: { phase: 'p', stepId: 'audit-implement-1', round: 1, attempt: 1 }, instructions: ['A'] },
      [e('C'), e('A'), e('B')], [{ role: 'auditor-1', instructions: ['C'] }], 'auditor-1')
    t.eq('an older pending turn replays its ids, plus its seat\'s own carries, no later instruction', [legacy.snapshot.ids, legacy.snapshot.available, legacy.reached], [['A'], ['C', 'A'], [{ invocationId: 'p1', scope: 'main' }]])
    t.ok('the worker wording says what an instruction is not', instructionsBlock([e('A')], { seat: 'seat' }).includes('Only the coordinator\'s decisions do that.') && instructionsBlock([e('A')], { seat: 'seat' }).includes('you cannot restart, reset or end the run'))
    t.ok('the coordinator\'s wording is as it was', instructionsBlock([e('A')]).includes('They direct the run; they are not evidence about the project.') && instructionsBlock([e('A')]).includes('a rule stated above'))
  }

  t.section('2. an instruction recorded during the author\'s turn reaches the auditor\'s next turn and the coordinator\'s, each recorded with its role')
  {
    const f = await engineFixture()
    const seen = []
    let engine = null
    let id = null
    engine = await start(f, recorder(f, seen, async (a) => { if (a.meta.stepId === 'implement' && !id) id = (await instruct(f, engine, A)).id }))
    const run = await engine.drive()
    t.eq('the run completes', `${run.status}/${run.outcome}`, 'completed/resolved', run.blockedReason)
    const implement = run.steps.find((s) => s.stepId === 'implement')
    t.ok('the author\'s own turn, already launched, does not carry it', !(implement.instructions ?? []).includes(id))
    const after = seen.slice(seen.findIndex((a) => a.meta.stepId === 'implement') + 1)
    const audit = after.find((a) => a.meta.role === 'auditor-1')
    const coordinator = after.find((a) => a.meta.role === 'coordinator')
    t.ok('the auditor\'s next prompt carries it, verbatim, marked as the operator\'s', audit?.prompt.includes('## Operator instructions') && audit.prompt.includes(A) && audit.prompt.includes('— Alice:'))
    t.ok('the coordinator\'s next prompt carries it', coordinator?.prompt.includes(A))
    t.eq('the auditor\'s step records role and ids', stepsOf(run, 'auditor-1', 'audit').map((s) => [s.role, s.instructions, s.instructionScope]), [['auditor-1', [id], 'main']])
    const coordStep = run.steps.find((s) => s.invocationId === coordinator?.meta.invocationId)
    t.eq('…and so does the coordinator\'s', [coordStep?.role, coordStep?.instructions], ['coordinator', [id]])
    // AC3: the coordinator's block is what it always was, resumed and unmarked, though the auditor carried it first.
    const records = Object.values(await readPrompts(f.issuePath, engine.runId))
    const coordRecord = records.find((r) => r.invocationId === coordinator.meta.invocationId)
    const entry = (await readChat(f.issuePath, engine.runId)).find((x) => x.id === id)
    const block = coordRecord.appended.find((a) => a.reason === 'operator-instructions')
    t.eq('the coordinator\'s block is byte for byte the coordinator\'s wording, unmarked', block?.text, instructionsBlock([entry]))
    const reasons = coordRecord.appended.map((a) => a.reason)
    t.eq('in its old place: right after the captured input', reasons[reasons.indexOf('operator-instructions') - 1], 'captured-input')
    t.ok('the rendered prompt holds the appended texts in that order', coordRecord.rendered.indexOf(block.text) < coordRecord.rendered.indexOf(coordRecord.appended[reasons.indexOf('operator-instructions') + 1]?.text ?? '\u0000') || reasons.at(-1) === 'operator-instructions')
    t.ok('no coordinator record carries a worker window policy', records.filter((r) => r.role === 'coordinator').every((r) => !r.appended.some((a) => a.reason === 'window-policy')))
    t.ok('worker records do', records.filter((r) => r.role !== 'coordinator').every((r) => r.appended.some((a) => a.reason === 'window-policy')))
    await releaseWorkspace(engine)
  }

  t.section('3. the cut-off is the launch: recorded before the call, it is in the prompt; after, in the seat\'s next turn')
  {
    const f = await engineFixture()
    const seen = []
    const engine = await start(f, recorder(f, seen))
    let id = null
    engine.hooks.beforeInvoke = async (e) => { if (e.run.participants['auditor-1']?.pendingInvocation && !id) id = (await instruct(f, e, B)).id }
    const run = await engine.drive()
    const audit = seen.find((a) => a.meta.role === 'auditor-1')
    t.ok('recorded while the audit turn was being prepared, it is in that prompt', audit?.prompt.includes(B))
    const record = (await readPrompts(f.issuePath, engine.runId))[audit.meta.invocationId]
    t.ok('…and in the prompt the record keeps', record.rendered.includes(B) && record.rendered === audit.prompt)
    t.eq('…and on its step', stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, [id])
    await releaseWorkspace(engine)
  }
  {
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    const order = []
    const seen = []
    let recording = null
    const engine = await start(f, recorder(f, seen, async (a) => { if (a.meta.stepId === 'implement') order.push(`invoke:${a.meta.round}`) }))
    engine.hooks.launching = async (e) => {
      if (e.run.participants.implementer?.pendingInvocation && !recording) {
        order.push('record')
        recording = instruct(f, e, C).then((x) => { order.push('appended'); return x })
      }
    }
    const run = await engine.drive()
    const { id } = await recording
    t.ok('an append started at the launch seam completes only after the runtime was called', order.indexOf('invoke:0') > -1 && order.indexOf('invoke:0') < order.indexOf('appended'), order.join(' '))
    const impls = seen.filter((a) => a.meta.stepId === 'implement')
    t.ok('it is not in the turn already launched', !impls[0].prompt.includes(C) && !(stepsOf(run, 'implementer', 'implement')[0].instructions ?? []).includes(id))
    t.ok('it is in the seat\'s next turn', impls[1]?.prompt.includes(C) && stepsOf(run, 'implementer', 'implement')[1]?.instructions?.includes(id))
    await releaseWorkspace(engine)
  }

  t.section('4. two reviewers invoked at once each carry it; neither depends on the other')
  {
    const f = await engineFixture({ playbook: 'implementation' })
    const options = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } }
    const log = []
    let engine = null
    let id = null
    const invoke = async (a) => {
      if (a.meta.stepId === 'implement' && !id) id = (await instruct(f, engine, A)).id
      if (a.meta.stepId.startsWith('audit-implement')) { const x = { role: a.meta.role, prompt: a.prompt, from: Date.now() }; log.push(x); await sleep(150); x.to = Date.now() }
      return f.fake.invoke(a)
    }
    engine = await start(f, invoke, { runOptions: options, expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })).resolved.configHash })
    const run = await engine.drive()
    t.eq('the run completes', run.status, 'completed', run.blockedReason)
    t.ok('the two audits overlapped', log.length === 2 && log[0].from < log[1].to && log[1].from < log[0].to, JSON.stringify(log.map((x) => [x.role, x.from, x.to])))
    t.ok('both prompts carry it', log.every((x) => x.prompt.includes(A)), log.map((x) => x.role).join())
    t.eq('both steps record it, each with its role', ['auditor-1', 'auditor-2'].map((r) => stepsOf(run, r, 'audit')[0]?.instructions), [[id], [id]])
    await releaseWorkspace(engine)
  }

  t.section('5. a restart: what a turn in flight was sent is neither lost nor counted before its step')
  {
    // Crash before attachment: nothing was attached, nothing ran; the retry carries it.
    const f = await engineFixture()
    const engine = await start(f)
    const a = await instruct(f, engine, A)
    t.ok('the crash fired before the audit\'s launch', await crashOn(engine, 'beforeInvoke', auditOf()))
    const seen = []
    const resumed = await reopen(f, engine.runId, { invoke: recorder(f, seen) })
    t.eq('the pending audit has nothing attached yet', resumed.run.participants['auditor-1'].pendingInvocation?.instructions, undefined)
    await resumed.recover()
    const run = await resumed.drive()
    t.ok('the re-invoked audit carries it', seen.find((x) => x.meta.role === 'auditor-1')?.prompt.includes(A))
    t.eq('exactly one auditor step lists it', stepsOf(run, 'auditor-1', 'audit').filter((s) => s.instructions?.includes(a.id)).length, 1)
    await releaseWorkspace(resumed)
  }
  {
    // What the launch attached is on disk before the runtime is called.
    const f = await engineFixture()
    let engine = null
    let onDisk = null
    engine = await start(f, async (x) => {
      if (x.meta.role === 'auditor-1' && !onDisk) onDisk = { at: x.meta.invocationId, run: await readRun(f.issuePath, engine.runId) }
      return f.fake.invoke(x)
    })
    const a = await instruct(f, engine, A)
    await engine.drive()
    const p = onDisk.run.participants['auditor-1']
    t.eq('the pending invocation on disk names what it carries', p.pendingInvocation?.instructions, [a.id])
    t.ok('…and the seat\'s turn record holds the snapshot and this attempt', p.turnInstructions?.snapshot.ids.includes(a.id) && p.turnInstructions.reached.some((r) => r.invocationId === onDisk.at))
    t.eq('a recorded step leaves no turn record behind', engine.run.participants['auditor-1'].turnInstructions, undefined)
    await releaseWorkspace(engine)
  }
  {
    // A crash after attachment, before the runtime started (as left on disk): not started, so it selects again: A and B, same session.
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    let engine = null
    let a = null
    engine = await start(f, recorder(f, [], async (x) => { if (x.meta.stepId === 'implement' && x.meta.round === 1 && !a) a = await instruct(f, engine, A) }))
    t.ok('the crash fired before the round-2 audit', await crashOn(engine, 'beforeInvoke', auditOf('auditor-1', 1)))
    const run = await readRun(f.issuePath, engine.runId)
    const p = run.participants['auditor-1']
    const sessionBefore = p.session?.id
    Object.assign(p.pendingInvocation, { instructions: [a.id], instructionScope: 'main' })
    p.turnInstructions = { key: turnIdentity(p.pendingInvocation.cursor), snapshot: { ids: [a.id], available: [a.id] }, reached: [{ invocationId: p.pendingInvocation.invocationId, scope: 'main' }] }
    await writeRun(f.issuePath, engine.runId, run)
    const b = await instruct(f, engine, B)
    const seen = []
    const resumed = await reopen(f, engine.runId, { invoke: recorder(f, seen) })
    await resumed.recover()
    t.eq('not started: the attempt no longer fixes its turn', resumed.run.participants['auditor-1'].turnInstructions?.reached, [])
    const done = await resumed.drive()
    const audit = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('its first real launch carries A and B', audit?.prompt.includes(A) && audit.prompt.includes(B))
    t.eq('on the session it had', audit?.session?.id, sessionBefore)
    t.eq('its step lists both', stepsOf(done, 'auditor-1', 'audit')[1]?.instructions, [a.id, b.id])
    await releaseWorkspace(resumed)
  }
  {
    // A crash after the agent finished: the work is adopted with what its prompt carried.
    const f = await engineFixture()
    const engine = await start(f)
    const a = await instruct(f, engine, A)
    t.ok('the crash fired after the audit finished', await crashOn(engine, 'afterInvokeBeforePersist', auditOf()))
    const resumed = await reopen(f, engine.runId)
    await resumed.recover()
    t.eq('the adopted step lists the ids it was sent', stepsOf(resumed.run, 'auditor-1', 'audit')[0]?.instructions, [a.id])
    t.eq('and the turn record is gone', resumed.run.participants['auditor-1'].turnInstructions, undefined)
    await resumed.drive()
    await releaseWorkspace(resumed)
  }

  // The clean uncertain path: started, not known to have finished, retried. One builder for 5d–5g.
  const uncertainAudit = async ({ before = [A], afterCrash = [B], fake = {}, hooks = null, edit = null } = {}) => {
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    const engine = await start(f)
    const ids = {}
    for (const text of before) ids[text] = (await instruct(f, engine, text)).id
    const crashed = await crashOn(engine, 'afterInvokeBeforePersist', auditOf())
    if (edit) await edit(f, engine)
    for (const text of afterCrash) ids[text] = (await instruct(f, engine, text)).id
    const seen = []
    const resumed = await reopen(f, engine.runId, { ...uncertain, invoke: recorder(f, seen), ...fake(f, seen) })
    if (hooks) Object.assign(resumed.hooks, hooks)
    await resumed.recover({ retryUncertain: true })
    return { f, resumed, ids, seen, crashed }
  }
  {
    const { resumed, ids, seen, crashed } = await uncertainAudit({ fake: () => ({}) })
    t.ok('the crash fired after the first audit', crashed)
    const run = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('the replay carries its snapshot (A), not what was recorded after its launch (B)', replay?.prompt.includes(A) && !replay.prompt.includes(B))
    t.eq('on a fresh session, everything marked earlier', [replay?.session ?? null, earlierCount(replay?.prompt ?? '')], [null, 1])
    t.eq('its step lists A', stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, [ids[A]])
    t.eq('B reaches the auditor\'s next new turn', stepsOf(run, 'auditor-1', 'audit')[1]?.instructions, [ids[B]])
    const coordinator = seen.find((x) => x.meta.role === 'coordinator')
    t.ok('and the coordinator\'s next turn', coordinator?.prompt.includes(B) && !coordinator.prompt.includes(A))
    await releaseWorkspace(resumed)
  }
  {
    // A second failed replay still carries only the original snapshot.
    let failed = false
    const { resumed, ids, seen } = await uncertainAudit({ fake: (f, seen) => ({ invoke: async (x) => {
      seen.push(x)
      if (x.meta.role === 'auditor-1' && !failed) { failed = true; throw rateLimited(x.meta.invocationId) }
      return f.fake.invoke(x)
    } }) })
    const run = await resumed.drive()
    const replays = seen.filter((x) => x.meta.role === 'auditor-1' && x.meta.round === 0)
    t.eq('the replay ran twice', replays.length, 2)
    t.ok('the second still carries A only, on a fresh session', replays[1].prompt.includes(A) && !replays[1].prompt.includes(B) && !replays[1].session)
    t.eq('its step lists A; B goes to the next new turn', [stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, stepsOf(run, 'auditor-1', 'audit')[1]?.instructions], [[ids[A]], [ids[B]]])
    await releaseWorkspace(resumed)
  }
  {
    // A withheld replay leaves the snapshot fixed by the attempt that did reach.
    let frozen = false
    const { resumed, ids, seen } = await uncertainAudit({ fake: () => ({}), hooks: { launching: async (e) => { if (!frozen && e.run.participants['auditor-1']?.pendingInvocation) { frozen = true; await e.requestFreeze('2026-11-25.1') } } } })
    await resumed.drive()
    t.eq('the replay was withheld by the freeze', [resumed.run.status, resumed.run.pause?.kind], ['paused', 'full-verification'])
    delete resumed.hooks.launching
    await resumed.resumeExecution({ actor: 'service', origin: 'full-verification' })
    const run = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('after the thaw the turn still carries A only', replay?.prompt.includes(A) && !replay.prompt.includes(B))
    t.eq('A on its step, B on the next', [stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, stepsOf(run, 'auditor-1', 'audit')[1]?.instructions], [[ids[A]], [ids[B]]])
    await releaseWorkspace(resumed)
  }
  {
    // An empty snapshot: the uncertain path clears the session, so the replay is fresh and carries the (empty) boundary.
    const { resumed, ids, seen } = await uncertainAudit({ before: [], afterCrash: [A], fake: () => ({}) })
    const run = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('the replay carries nothing recorded after its launch, on a new session', !replay?.prompt.includes(A) && !replay?.session)
    t.eq('its step lists none; the next new turn carries A', [stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, stepsOf(run, 'auditor-1', 'audit')[1]?.instructions], [undefined, [ids[A]]])
    await releaseWorkspace(resumed)
  }
  {
    // A pending turn from before per-seat delivery: it replays its own ids plus the seat's earlier carries, never by timestamp.
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    const engine = await start(f)
    const c = await instruct(f, engine, C)
    t.ok('the crash fired before the round-2 audit', await crashOn(engine, 'beforeInvoke', auditOf('auditor-1', 1)))
    const a = await instruct(f, engine, A)
    const b = await instruct(f, engine, B)
    const run = await readRun(f.issuePath, engine.runId)
    const p = run.participants['auditor-1']
    // B was recorded before this "startedAt": the old fallback would have taken it.
    Object.assign(p.pendingInvocation, { instructions: [a.id], instructionScope: 'main', startedAt: new Date(Date.now() + 60_000).toISOString() })
    delete p.turnInstructions
    await writeRun(f.issuePath, engine.runId, run)
    const seen = []
    const resumed = await reopen(f, engine.runId, { ...uncertain, invoke: recorder(f, seen) })
    await resumed.recover({ retryUncertain: true })
    const done = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('the replay carries A and the seat\'s own C, not B', replay?.prompt.includes(A) && replay.prompt.includes(C) && !replay.prompt.includes(B))
    t.eq('both marked earlier', earlierCount(replay?.prompt ?? ''), 2)
    t.eq('its step lists them in recorded order', stepsOf(done, 'auditor-1', 'audit')[1]?.instructions, [c.id, a.id])
    await releaseWorkspace(resumed)
  }

  t.section('6. a freeze withholds a prepared turn: its first real launch selects again')
  {
    const f = await engineFixture()
    let engine = null
    let a = null
    const seen = []
    engine = await start(f, recorder(f, seen, async (x) => { if (x.meta.stepId === 'implement' && !a) a = await instruct(f, engine, A) }))
    let frozen = false
    engine.hooks.launching = async (e) => { if (!frozen && e.run.participants['auditor-1']?.pendingInvocation) { frozen = true; await e.requestFreeze('2026-11-25.1') } }
    await engine.drive()
    t.eq('the audit was withheld', [engine.run.status, engine.run.pause?.kind, seen.some((x) => x.meta.role === 'auditor-1')], ['paused', 'full-verification', false])
    t.eq('its attempt reached nothing', engine.run.participants['auditor-1'].turnInstructions?.reached, [])
    const b = await instruct(f, engine, B)
    delete engine.hooks.launching
    await engine.resumeExecution({ actor: 'service', origin: 'full-verification' })
    const run = await engine.drive()
    const audit = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('after the thaw it carries A and B', audit?.prompt.includes(A) && audit.prompt.includes(B))
    t.eq('and records both', stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, [a.id, b.id])
    await releaseWorkspace(engine)
  }

  t.section('7. a retried turn never resends into a session that may hold its prompt')
  {
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    let engine = null
    let a = null
    let failed = false
    const seen = []
    engine = await start(f, async (x) => {
      seen.push(x)
      if (x.meta.stepId === 'implement' && x.meta.round === 1 && !a) a = await instruct(f, engine, A)
      if (x.meta.role === 'auditor-1' && x.meta.round === 1 && !failed) { failed = true; throw rateLimited(x.meta.invocationId) }
      return f.fake.invoke(x)
    })
    const run = await engine.drive()
    const audits = seen.filter((x) => x.meta.role === 'auditor-1' && x.meta.round === 1)
    t.ok('the first attempt carried A on the kept session', audits[0].prompt.includes(A) && Boolean(audits[0].session?.id))
    t.ok('the retry runs on a fresh session with A, marked earlier', audits[1].prompt.includes(A) && !audits[1].session && earlierCount(audits[1].prompt) >= 1)
    t.eq('the step lists A once', stepsOf(run, 'auditor-1', 'audit')[1]?.instructions, [a.id])
    await releaseWorkspace(engine)
  }
  {
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    let failed = false
    const seen = []
    const engine = await start(f, async (x) => {
      seen.push(x)
      if (x.meta.role === 'auditor-1' && x.meta.round === 1 && !failed) { failed = true; throw rateLimited(x.meta.invocationId) }
      return f.fake.invoke(x)
    })
    await engine.drive()
    const audits = seen.filter((x) => x.meta.role === 'auditor-1')
    t.ok('control: a retried turn that carried nothing keeps its session', audits.length === 3 && audits[1].session?.id && audits[2].session?.id === audits[1].session.id, JSON.stringify(audits.map((x) => x.session?.id ?? null)))
    await releaseWorkspace(engine)
  }

  t.section('8. session scope: a reading turn\'s session, and a turn that changes scope')
  {
    // The uncertain retry of a read-scope turn clears the session it ran on.
    const f = await engineFixture()
    const engine = await start(f)
    t.ok('the crash fired after the triage turn', await crashOn(engine, 'afterInvokeBeforePersist', (e) => e.run.steps.length === 0))
    const run = await readRun(f.issuePath, engine.runId)
    const p = run.participants.coordinator
    p.pendingInvocation.sessionScope = 'read'
    p.readSession = { id: 'read-session' }
    p.session = { id: 'main-session' }
    await writeRun(f.issuePath, engine.runId, run)
    const resumed = await reopen(f, engine.runId, uncertain)
    await resumed.recover({ retryUncertain: true })
    t.eq('both sessions are cleared', [resumed.run.participants.coordinator.readSession ?? null, resumed.run.participants.coordinator.session ?? null], [null, null])
    await releaseWorkspace(resumed)
  }
  // A coordinator paused after triage (main session holding A), then its next turn's cursor captured by a crash before launch.
  const pausedCoordinator = async () => {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which branch?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await start(f)
    const a = await instruct(f, engine, A)
    await engine.drive()
    await engine.answer({ pauseId: engine.run.pause.id, text: 'main', actor: 'Alice' })
    const crashed = await crashOn(engine, 'beforeInvoke', (e) => Boolean(e.run.participants.coordinator?.pendingInvocation))
    const run = await readRun(f.issuePath, engine.runId)
    return { f, engine, a, run, p: run.participants.coordinator, crashed }
  }
  {
    // Another turn's read record: nothing added to the kept main session; the read one is reset.
    const { f, engine, a, run, p, crashed } = await pausedCoordinator()
    t.ok('the crash fired before the coordinator\'s next turn', crashed)
    const mainSession = p.session?.id
    delete p.pendingInvocation
    p.state = 'ready'
    p.readSession = { id: 'read-session' }
    p.turnInstructions = { key: 'another-turn', snapshot: { ids: [a.id], available: [a.id] }, reached: [{ invocationId: 'gone', scope: 'read' }] }
    await writeRun(f.issuePath, engine.runId, run)
    const seen = []
    const resumed = await reopen(f, engine.runId, { invoke: recorder(f, seen) })
    await resumed.recover()
    await resumed.drive()
    const next = seen.find((x) => x.meta.role === 'coordinator')
    t.ok('the main session already carried A: it is not sent again', next && !next.prompt.includes(A))
    t.eq('the main session is resumed', next?.session?.id, mainSession)
    t.eq('the read session that may hold A is reset', resumed.run.participants.coordinator.readSession ?? null, null)
    await releaseWorkspace(resumed)
  }
  {
    // The same turn launched in read scope carrying A, interrupted; the fence is off at the restart, so it replays in main.
    const { f, engine, a, run, p } = await pausedCoordinator()
    const pending = p.pendingInvocation
    Object.assign(pending, { sessionScope: 'read', instructionScope: 'read', instructions: [a.id] })
    p.readSession = { id: 'read-session' }
    p.turnInstructions = { key: turnIdentity(pending.cursor), snapshot: { ids: [a.id], available: [a.id] }, reached: [{ invocationId: pending.invocationId, scope: 'read' }] }
    await writeRun(f.issuePath, engine.runId, run)
    const b = await instruct(f, engine, B)
    const seen = []
    const resumed = await reopen(f, engine.runId, { ...uncertain, invoke: recorder(f, seen) })
    await resumed.recover({ retryUncertain: true })
    const done = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'coordinator')
    t.ok('the main replay carries A only, marked earlier', replay?.prompt.includes(A) && !replay.prompt.includes(B) && earlierCount(replay.prompt) === 1)
    t.eq('on a fresh session', replay?.session ?? null, null)
    const step = done.steps.find((s) => s.invocationId === replay?.meta.invocationId)
    t.eq('its step lists A in main scope', [step?.instructions, step?.instructionScope], [[a.id], 'main'])
    t.ok('B reaches the coordinator\'s next turn', seen.filter((x) => x.meta.role === 'coordinator').slice(1).some((x) => x.prompt.includes(B)))
    await releaseWorkspace(resumed)
  }
  {
    // A read turn that carried [] (A was at its boundary), aborted gracefully with both sessions kept; replayed in main with the fence off.
    const { f, engine, a, run, p } = await pausedCoordinator()
    const key = turnIdentity(p.pendingInvocation.cursor)
    const invocationId = p.pendingInvocation.invocationId
    delete p.pendingInvocation
    p.state = 'ready'
    p.readSession = { id: 'read-session' }
    p.turnInstructions = { key, snapshot: { ids: [], available: [a.id] }, reached: [{ invocationId, scope: 'read' }] }
    t.ok('the main session is kept, as an abort leaves it', Boolean(p.session?.id))
    await writeRun(f.issuePath, engine.runId, run)
    const seen = []
    const resumed = await reopen(f, engine.runId, { invoke: recorder(f, seen) })
    await resumed.recover()
    const done = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'coordinator')
    t.eq('the main replay runs on a fresh session', replay?.session ?? null, null)
    t.ok('and carries the boundary, A, marked earlier', replay?.prompt.includes(A) && earlierCount(replay.prompt) === 1)
    const step = done.steps.find((s) => s.invocationId === replay?.meta.invocationId)
    t.eq('its step lists A in main scope', [step?.instructions, step?.instructionScope], [[a.id], 'main'])
    await releaseWorkspace(resumed)
  }

  t.section('9. verbatim: a multiline instruction with indented lines reaches every seat byte for byte')
  {
    const text = 'First, the rule:\n  - keep `run.json` readable\n\tand this tabbed line\n\nAfter a blank line, the end.'
    const f = await engineFixture()
    const seen = []
    const engine = await start(f, recorder(f, seen))
    await instruct(f, engine, text)
    await engine.drive()
    const worker = seen.find((x) => x.meta.role === 'implementer')
    const coordinator = seen.find((x) => x.meta.role === 'coordinator')
    t.ok('a worker\'s prompt holds the recorded text exactly', worker?.prompt.includes(`— Alice:\n${text}\n`))
    t.ok('so does the coordinator\'s', coordinator?.prompt.includes(`— Alice:\n${text}\n`))
    await releaseWorkspace(engine)
  }

  t.section('10. a crash after a turn\'s step was saved and before its pending pointer cleared: nothing is left to replay')
  {
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    const engine = await start(f)
    const a = await instruct(f, engine, A)
    // What the audit's pending invocation looked like once the runtime had answered.
    let auditPending = null
    engine.hooks.afterInvokeBeforePersist = async (e) => {
      const p = e.run.participants['auditor-1']?.pendingInvocation
      if (p && p.cursor.round === 0 && !auditPending) auditPending = JSON.parse(JSON.stringify(p))
    }
    t.ok('the crash fired before the round-2 author turn', await crashOn(engine, 'beforeInvoke', (e) => e.run.participants.implementer?.pendingInvocation?.cursor?.round === 1))
    const run = await readRun(f.issuePath, engine.runId)
    const auditor = run.participants['auditor-1']
    const committed = run.steps.find((s) => s.invocationId === auditPending?.invocationId)
    t.eq('the audit carried A and its step is saved', committed?.instructions, [a.id])
    const session = auditor.session?.id
    // The durable state of a crash between the step's save and the pointer's clearing: step, pointer, no turn record.
    auditor.pendingInvocation = { ...auditPending, stepNumber: committed.number }
    delete auditor.turnInstructions
    await writeRun(f.issuePath, engine.runId, run)
    const seen = []
    const resumed = await reopen(f, engine.runId, { invoke: recorder(f, seen) })
    await resumed.recover()
    t.eq('recovery finishes the commit and leaves no replay record', [resumed.run.participants['auditor-1'].pendingInvocation ?? null, resumed.run.participants['auditor-1'].turnInstructions], [null, undefined])
    t.eq('the step is not recorded twice', resumed.run.steps.filter((s) => s.invocationId === auditPending.invocationId).length, 1)
    await resumed.drive()
    const next = seen.find((x) => x.meta.role === 'auditor-1')
    t.eq('the auditor\'s next turn resumes its session', next?.session?.id, session)
    t.ok('and repeats nothing it carried', next && !next.prompt.includes(A))
    await releaseWorkspace(resumed)
  }

  t.section('11. concurrent reviewers and a replay: reviewer 2 commits A and B while reviewer 1 is in flight with A; reviewer 1\'s replay carries only A')
  {
    const f = await engineFixture({ playbook: 'implementation' })
    const options = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } }
    let engine = null
    let b = null
    let releaseSecond
    const secondMayLaunch = new Promise((resolve) => { releaseSecond = resolve })
    const invoke = async (x) => {
      if (x.meta.role === 'auditor-1' && !b) {
        b = await instruct(f, engine, B)
        releaseSecond()
        // Reviewer 2 launches, carries A and B, and its step is recorded while this one is still in flight.
        while (!engine.run.steps.some((s) => s.role === 'auditor-2')) await sleep(20)
      }
      return f.fake.invoke(x)
    }
    engine = await start(f, invoke, { runOptions: options, expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })).resolved.configHash })
    const a = await instruct(f, engine, A)
    // The hook serves every turn: the one it is called for is the pending invocation it has not seen yet.
    const prepared = new Set()
    engine.hooks.beforeInvoke = async (e) => {
      const [role] = Object.entries(e.run.participants).find(([, p]) => p.pendingInvocation && !prepared.has(p.pendingInvocation.invocationId)) ?? []
      if (role) prepared.add(e.run.participants[role].pendingInvocation.invocationId)
      if (role === 'auditor-2') await secondMayLaunch
    }
    const crashed = await crashOn(engine, 'afterInvokeBeforePersist', (e) => e.run.steps.some((s) => s.role === 'auditor-2') && Boolean(e.run.participants['auditor-1']?.pendingInvocation))
    t.ok('reviewer 1 was cut short after reviewer 2 committed', crashed)
    t.eq('reviewer 2 carried A and B', stepsOf(engine.run, 'auditor-2', 'audit')[0]?.instructions, [a.id, b.id])
    await sleep(100)
    const seen = []
    const resumed = await reopen(f, engine.runId, { ...uncertain, invoke: recorder(f, seen) })
    await resumed.recover({ retryUncertain: true })
    const run = await resumed.drive()
    const replay = seen.find((x) => x.meta.role === 'auditor-1')
    t.ok('reviewer 1\'s replay carries A only', replay?.prompt.includes(A) && !replay.prompt.includes(B))
    t.eq('its step lists A', stepsOf(run, 'auditor-1', 'audit')[0]?.instructions, [a.id])
    await releaseWorkspace(resumed)
  }
}
