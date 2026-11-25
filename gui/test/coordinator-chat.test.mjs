import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readRun } from '../server/runtime/store.mjs'
import { instructionsFor, chatView, instructionRefusal, recordInstruction, askCoordinator, readChat, chatFile, coordinatorRole } from '../server/runtime/coordinator-chat.mjs'
import { engineFixture, scriptFor, pausingStrategy } from './fakes/fixture.mjs'

const launch = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})

export default async (t) => {
  t.section('1. which instructions a coordinator turn is still owed')
  {
    const entries = [
      { id: 'i1', kind: 'instruction', at: '2026-10-03T10:00:00Z', actor: 'op', text: 'one' },
      { id: 'q1', kind: 'question', at: '2026-10-03T10:01:00Z', actor: 'op', text: 'why?' },
      { id: 'i2', kind: 'instruction', at: '2026-10-03T10:02:00Z', actor: 'op', text: 'two' }
    ]
    // A record from before per-seat delivery: coordinator steps only, the main one without a scope.
    const steps = [{ number: 3, stepId: 'brief', role: 'coordinator', instructions: ['i1'] }, { number: 4, stepId: 'triage', role: 'coordinator', instructions: ['i2'], instructionScope: 'read' }]
    t.eq('the main session is owed what no main-scope step carried', instructionsFor(entries, steps).map((e) => e.id), ['i2'])
    t.eq('the read session keeps its own account', instructionsFor(entries, steps, { scope: 'read' }).map((e) => e.id), ['i1'])
    t.eq('a fresh session is given every instruction', instructionsFor(entries, steps, { freshSession: true }).map((e) => e.id), ['i1', 'i2'])
    t.eq('questions are never delivered', instructionsFor(entries, []).map((e) => e.id), ['i1', 'i2'])
    t.eq('per seat: the coordinator reads the older record exactly as before', instructionsFor(entries, steps, { role: 'coordinator' }).map((e) => e.id), ['i2'])
    t.eq('per seat: an auditor is not credited with the coordinator\'s carry', instructionsFor(entries, steps, { role: 'auditor-1' }).map((e) => e.id), ['i1', 'i2'])
    const seatSteps = [...steps, { number: 5, stepId: 'audit-implement-1', role: 'auditor-1', instructions: ['i1', 'i2'] }]
    t.eq('…and the coordinator is not credited with the auditor\'s', instructionsFor(entries, seatSteps, { role: 'coordinator' }).map((e) => e.id), ['i2'])
    t.eq('a seat owes nothing it carried itself', instructionsFor(entries, seatSteps, { role: 'auditor-1' }).map((e) => e.id), [])
    const view = chatView(entries, seatSteps, { asking: new Set(['q1']) })
    t.eq('a carried instruction reads as delivered, naming its step', [view[0].delivery, view[0].carriedBy[0]?.step], ['delivered', 3])
    t.eq('…and every seat that carried it, with its role', view[0].carriedBy.map((c) => [c.step, c.role]), [[3, 'coordinator'], [5, 'auditor-1']])
    t.eq('a question in flight reads as asking', view[1].state, 'asking')
    t.eq('the same question after a restart reads as interrupted', chatView(entries, steps)[1].state, 'interrupted')
    t.eq('a completed run takes no instructions', typeof instructionRefusal({ status: 'completed' }), 'string')
    t.eq('a paused or failed one does', [instructionRefusal({ status: 'paused' }), instructionRefusal({ status: 'failed' })], [null, null])
  }

  t.section('2. an instruction given while the run waits is delivered in the next turn of every seat, once')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which branch?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    await engine.drive()
    t.eq('the run paused after triage', engine.run.status, 'paused')
    t.eq('the fixture has a coordinator seat', coordinatorRole(engine.snapshot), 'coordinator')

    let refused = null
    try { await recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: engine.run, text: '  ', actor: 'op' }) } catch (error) { refused = error }
    t.eq('an empty instruction is refused', refused?.status, 400)
    const instruction = await recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: engine.run, text: 'Keep the public API unchanged.', actor: 'Alice' })
    t.ok('it is on disk beside the run', (await fs.readFile(chatFile(f.issuePath, engine.runId), 'utf8')).includes(instruction.id))
    const stepsBefore = (await readRun(f.issuePath, engine.runId)).steps.length
    t.eq('recording it does not touch the run record', engine.run.steps.length, stepsBefore)

    await engine.answer({ pauseId: engine.run.pause.id, text: 'main', actor: 'Alice' })
    const seen = []
    engine.harnesses = { fake: { ...f.fake, invoke: async (a) => { seen.push(a); return f.fake.invoke(a) } } }
    const done = await engine.drive()
    t.eq('the run completes', `${done.status}/${done.outcome}`, 'completed/resolved', done.blockedReason)
    const coordinatorTurns = seen.filter((a) => a.meta.role === 'coordinator')
    const first = coordinatorTurns[0]
    t.ok('the next coordinator turn carries it verbatim, last', first?.prompt.includes('## Operator instructions') && first.prompt.includes('Keep the public API unchanged.'), first?.prompt.slice(-800))
    const byRole = {}
    for (const a of seen) (byRole[a.meta.role] ??= []).push(a)
    t.eq('every seat took a turn after it', Object.keys(byRole).sort(), ['auditor-1', 'coordinator', 'implementer'])
    for (const [role, turns] of Object.entries(byRole)) {
      t.ok(`${role}: its next turn carries it verbatim`, turns[0].prompt.includes('## Operator instructions') && turns[0].prompt.includes('Keep the public API unchanged.'))
      t.ok(`${role}: its later turns on the same session do not repeat it`, turns.slice(1).every((a) => !a.prompt.includes('Keep the public API unchanged.')), turns.length)
    }
    t.ok('a worker is told what an instruction is not', byRole.implementer[0].prompt.includes('Only the coordinator\'s decisions do that.') && !coordinatorTurns[0].prompt.includes('Only the coordinator\'s decisions do that.'))
    const carriers = done.steps.filter((s) => s.instructions?.includes(instruction.id))
    t.eq('each seat\'s step that carried it records so, with its role', carriers.map((s) => s.role).sort(), ['auditor-1', 'coordinator', 'implementer'], JSON.stringify(done.steps.map((s) => [s.stepId, s.role, s.instructions])))
    t.ok('…in the main session scope', carriers.every((s) => s.instructionScope === 'main'))
    const view = chatView(await readChat(f.issuePath, engine.runId), done.steps)
    t.eq('the chat shows it delivered in those steps', view[0].carriedBy.map((c) => c.step), carriers.map((s) => s.number))
    let late = null
    try { await recordInstruction({ issuePath: f.issuePath, runId: engine.runId, run: done, text: 'too late', actor: 'op' }) } catch (error) { late = error }
    t.eq('the completed run refuses another', late?.status, 409)
    await releaseWorkspace(engine)
  }

  t.section('3. a question is answered in a fork of the coordinator session and changes nothing')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which branch?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    await engine.drive()
    const before = JSON.stringify(await readRun(f.issuePath, engine.runId))
    const calls = []
    const fake = { invoke: async (a) => { calls.push(a); return { session: { id: 'forked' }, response: 'Because triage needs the branch.', usage: { costUsd: 0.01 }, outcome: 'completed' } } }
    const events = []
    const harness = engine.participantSpec('coordinator').model.harness
    const { question, answer } = await askCoordinator(engine, { text: 'Why did you stop?', actor: 'Alice', harnesses: { [harness]: fake }, emit: (e) => events.push(e) })
    const call = calls[0]
    t.eq('one invocation, forking the coordinator session', [calls.length, call?.fork, call?.session?.id], [1, true, engine.run.participants.coordinator.session.id])
    t.eq('tool-free', call?.supervisorOnly, true)
    t.ok('the prompt says it is a side question and where the run stands', /side question/.test(call?.prompt) && /Run status now: paused/.test(call?.prompt) && call.prompt.includes('Why did you stop?'))
    t.eq('the answer is recorded against the question', [answer.replyTo, answer.status, answer.text, answer.costUsd], [question.id, 'answered', 'Because triage needs the branch.', 0.01])
    t.eq('question and answer were announced', events.filter((e) => e.type === 'chat').length, 2)
    t.eq('the run record is byte-for-byte unchanged', JSON.stringify(await readRun(f.issuePath, engine.runId)), before)

    const failing = { invoke: async () => { throw Object.assign(new Error('claude exited 1'), { kind: 'runtime-error' }) } }
    const failed = await askCoordinator(engine, { text: 'Again?', actor: 'Alice', harnesses: { [harness]: failing } })
    t.eq('a runtime failure is recorded as an unanswered question, not thrown', failed.answer.status, 'failed')

    let refused = null
    const fresh = { ...engine, run: { ...engine.run, participants: { ...engine.run.participants, coordinator: { ...engine.run.participants.coordinator, session: null, readSession: null } } }, participantSpec: (r) => engine.participantSpec(r) }
    try { await askCoordinator(fresh, { text: 'Hello?', actor: 'op', harnesses: { [harness]: fake } }) } catch (error) { refused = error }
    t.eq('without a session there is nothing to ask', refused?.status, 409)
    t.eq('…and nothing was recorded for it', (await readChat(f.issuePath, engine.runId)).filter((e) => e.text === 'Hello?').length, 0)

    // The fork touched the operator's CLI configuration (harness/config-guard.mjs).
    const integrity = (id) => ({ kind: 'cli-config', invocationId: id, violations: [{ path: '/h/.codex/hooks.json', change: 'created', status: 'quarantined', quarantinedTo: '/h/.codex/q/hooks.json.abc' }] })
    const resolved = []
    let liveId = null
    const touching = {
      invoke: async (a) => { liveId = a.meta.invocationId; throw Object.assign(new Error('integrity violation: …'), { kind: 'environment-error', integrity: integrity(a.meta.invocationId) }) },
      recoverPending: async () => [],
      resolveConfig: async (id) => { resolved.push({ id, recorded: (await readChat(f.issuePath, engine.runId)).some((e) => e.invocationId === id && e.integrity) }) }
    }
    const touched = await askCoordinator(engine, { text: 'And now?', actor: 'Alice', harnesses: { [harness]: touching } })
    t.eq('the answer records the structured integrity', [touched.answer.status, touched.answer.integrity?.violations[0].change], ['failed', 'created'])
    t.eq('the adapter is acknowledged after the answer is on disk', resolved, [{ id: liveId, recorded: true }])

    // An interrupted earlier ask: its failure goes to that question, never to the new one.
    const oldQuestion = touched.question.id
    let recoveries = 0
    // The adapter calls afterFence only once its fence is proved (codex.mjs / gemini.mjs).
    let proved = true
    const replays = []
    const recovering = {
      invoke: async (a) => { if (a.fence && proved) replays.push(await a.afterFence?.()); return fake.invoke(a) },
      recoverPending: async () => { recoveries++; return [{ invocationId: 'ask-interrupted', context: { questionId: oldQuestion }, integrity: integrity('ask-interrupted') }] },
      resolveConfig: async (id) => { resolved.push({ id }) }
    }
    // Unfenced (the suite runs with DEVPANEL_FENCE=off): nothing is replayed, as before.
    await askCoordinator(engine, { text: 'Unfenced?', actor: 'Alice', harnesses: { [harness]: recovering } })
    t.eq('an unfenced ask never replays the guard (AC5)', recoveries, 0)
    t.eq('the fixture run is fenced by policy, so only the switch makes the ask unfenced', engine.snapshot.fence?.namespace, 1)
    const savedFence = process.env.DEVPANEL_FENCE
    delete process.env.DEVPANEL_FENCE
    let next
    try {
      // A requested fence that is not proved (the DEVPANEL_FENCE_UNPROVED=run fallback): no replay either.
      proved = false
      await askCoordinator(engine, { text: 'Unproved?', actor: 'Alice', harnesses: { [harness]: recovering } })
      t.eq('a requested but unproved fence never replays the guard (AC5)', recoveries, 0)
      proved = true
      next = await askCoordinator(engine, { text: 'One more?', actor: 'Alice', harnesses: { [harness]: recovering } })
    } finally { if (savedFence === undefined) delete process.env.DEVPANEL_FENCE; else process.env.DEVPANEL_FENCE = savedFence }
    t.eq('a proved fence replays it first', recoveries, 1)
    t.eq('the replay ran once, inside the adapter\'s fence (fence.mjs applyFence replay)', replays.length, 1)
    // A replay that fails is not swallowed: the adapter's applyFence treats it as possibly moved (rebuilds or refuses).
    const throwing = { ...recovering, recoverPending: async () => { throw new Error('config-checked could not be persisted') } }
    let surfaced = null
    const probing = { ...throwing, invoke: async (a) => { try { await a.afterFence?.() } catch (error) { surfaced = error.message } return fake.invoke(a) } }
    delete process.env.DEVPANEL_FENCE
    try { await askCoordinator(engine, { text: 'Throwing?', actor: 'Alice', harnesses: { [harness]: probing } }) } finally { if (savedFence === undefined) delete process.env.DEVPANEL_FENCE; else process.env.DEVPANEL_FENCE = savedFence }
    t.eq('a replay that throws reaches the adapter instead of reading as "nothing moved"', surfaced, 'config-checked could not be persisted')
    const chat = await readChat(f.issuePath, engine.runId)
    const recovered = chat.find((e) => e.invocationId === 'ask-interrupted')
    t.eq('the recovered failure is recorded on the original question', [recovered?.replyTo, recovered?.status, Boolean(recovered?.integrity)], [oldQuestion, 'failed', true])
    t.eq('the new question is answered normally, without it', [next.answer.replyTo, next.answer.status, next.answer.integrity], [next.question.id, 'answered', undefined])
    t.eq('the interrupted invocation is acknowledged', resolved.at(-1)?.id, 'ask-interrupted')
    await releaseWorkspace(engine)
  }

  t.section('4. the adapters fork rather than resume')
  {
    const claude = await fs.readFile(path.resolve(import.meta.dirname, '../../harness/claude.mjs'), 'utf8')
    const codex = await fs.readFile(path.resolve(import.meta.dirname, '../../harness/codex.mjs'), 'utf8')
    t.ok('claude: --fork-session under a new id', claude.includes("'--fork-session', '--session-id', sessionId"))
    t.ok('claude: thinking summaries requested', claude.includes('showThinkingSummaries: true'))
    t.ok('codex: exec fork', claude && codex.includes("fork ? 'fork' : 'resume'"))
    t.ok('codex: reasoning summaries requested', codex.includes('model_reasoning_summary="detailed"'))
  }
}
