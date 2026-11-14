import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { composeContext, countAttempt, recordSent } from '../server/supervisor-context.mjs'

export const name = 'top supervisor — its unchanging prompt blocks are sent only when the session lacks them'

const wait = async (test, ms = 5000) => { const end = Date.now() + ms; while (!await test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const models = async () => [{ id: 'test-model', title: 'Test', harness: 'claude', model: 'wire', verification: { status: 'verified' } }]
const PROJECTS = ['a-project', 'b-project', 'c-project']
const START = { model: 'test-model', projects: [], message: 'Mission', limits: { maxCalls: 200 } }

/* A panel shaped like a real one: per-project infrastructure, a roster with notes, playbooks with intents. */
function panel () {
  const infra = Object.fromEntries(PROJECTS.map((id, n) => [id, {
    orientation: `${id}: ${'how the application is laid out and where its logs are. '.repeat(60 + n * 10)}`,
    staging: { id: 'stage', ssh: { host: `${id}.stage` }, testDrive: { commands: Array.from({ length: 8 }, (_, i) => ({ id: `step-${i}`, run: `./drive.sh step ${i} --verbose` })) } },
    stagingDeployment: { enabled: n === 0 }
  }]))
  const roster = Array.from({ length: 12 }, (_, i) => ({
    id: `seat-model-${i}`, title: `Seat model ${i}`, harness: i % 2 ? 'codex' : 'claude', contextWindow: 200000, efforts: ['low', 'medium', 'high'],
    verified: true, available: true, notes: `What model ${i} is and what about it is unmeasured. `.repeat(14)
  }))
  const playbooks = Array.from({ length: 6 }, (_, i) => ({
    id: `playbook-${i}`, title: `Playbook ${i}`, description: 'What this playbook does, its seats and its budgets. '.repeat(12),
    intents: ['bugfix', 'feature', 'refactor'].map((id) => ({ id, title: id, summary: 'An intent overlay for this kind of work. '.repeat(3) }))
  }))
  const notes = []
  const tools = {
    projects: async () => PROJECTS.map((id) => ({ id })),
    playbooks: async () => structuredClone(playbooks),
    seatModels: async () => structuredClone(roster),
    infrastructure: async (id) => { if (!infra[id]) throw Error(`No project ${id}`); return structuredClone(infra[id]) },
    listIssues: async () => [{ id: 'issue', status: 'open', name: 'An issue' }],
    getIssue: async () => ({ name: 'An issue' }),
    addNote: async (a) => { notes.push(a); return { number: '001' } }
  }
  return { infra, roster, playbooks, notes, tools }
}

/*
 * A fake runtime that keeps a session id the way the real ones do (the same on resume, a new one when invoked
 * without), records what each call was sent, and answers with the next scripted action. `h.answers` holds
 * per-call replacements of the reply, in order (null keeps it; a function may throw).
 */
function runtime () {
  const h = { calls: [], forks: [], actions: [], answers: [], made: 0 }
  h.adapter = {
    invoke: async (args) => {
      if (args.fork) { h.forks.push(args); return { session: { id: `fork-${h.forks.length}` }, response: 'An answer in prose.', usage: { costUsd: 0 } } }
      const call = { ...args, sent: JSON.parse(args.prompt) }
      h.calls.push(call)
      const answer = h.answers.shift()
      const reply = { session: { id: args.session?.id ?? `s${++h.made}` }, response: JSON.stringify({ message: 'ok', action: h.actions.shift() ?? null }), usage: { costUsd: 0 } }
      return answer ? answer(call, reply) : reply
    }
  }
  return h
}

const isMarker = (block, get) => block?.unchanged === true && typeof block.since === 'string' && typeof block.call === 'string' && block.get === get
const getOf = (block, project) => `get_context ${JSON.stringify(project ? { block, project } : { block })}`
/** Every block of a sent prompt, in full or a marker for each, as [key, 'full'|'marker']. */
function shape (sent) {
  const out = {}
  for (const id of PROJECTS) out[`infrastructure:${id}`] = isMarker(sent.infrastructure[id], getOf('infrastructure', id)) ? 'marker' : typeof sent.infrastructure[id]?.orientation === 'string' ? 'full' : 'other'
  out.seatModels = isMarker(sent.seatModels, getOf('seatModels')) ? 'marker' : Array.isArray(sent.seatModels) ? 'full' : 'other'
  out.playbooks = isMarker(sent.playbooks, getOf('playbooks')) ? 'marker' : Array.isArray(sent.playbooks) ? 'full' : 'other'
  out.history = isMarker(sent.remaining.history, getOf('history')) ? 'marker' : sent.remaining.history?.role === 'accounting' ? 'full' : 'other'
  return out
}
const all = (value) => Object.fromEntries([...PROJECTS.map((id) => `infrastructure:${id}`), 'seatModels', 'playbooks', 'history'].map((k) => [k, value]))
const idle = (agent) => { const s = agent.get(); return s.status === 'active' && s.pending === null && !s.queue.length }

export default async function (t) {
  // Retries after a failed call in milliseconds, as quota-fallback.test.mjs does: the module reads it at load.
  process.env.DEVPANEL_SUPERVISOR_RETRY_MS = '5'
  const { createTopSupervisor } = await import(`../server/top-supervisor.mjs?context=${Date.now()}`)
  delete process.env.DEVPANEL_SUPERVISOR_RETRY_MS
  const dirs = []
  const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-context-')); dirs.push(d); return d }
  const agents = []
  const create = async (options) => { const a = await createTopSupervisor({ models, pollMs: 20, ...options }); agents.push(a); return a }
  const turn = async (agent, h, text, count = 1) => { const n = h.calls.length; await agent.chat(text); await wait(() => h.calls.length >= n + count && idle(agent)); return h.calls.at(-1) }
  try {
    t.section('composeContext and recordSent: a marker only for bytes the same session already holds')
    {
      const current = { infrastructure: { x: { a: 1 }, y: null }, playbooks: [1], seatModels: [2], history: { role: 'accounting' } }
      const first = composeContext(current, null, { sessionId: 's' })
      t.eq('with no record everything goes in full; a null goes as it is', [first.full.sort(), first.unchanged, first.fields.infrastructure.y], [['history', 'infrastructure:x', 'playbooks', 'seatModels'], [], null])
      const record = recordSent(null, { priorSessionId: null, sessionId: 's', offered: first.offered, full: first.full, invocationId: 'c1', at: 'T1', chars: 100 })
      t.eq('a call that sent everything leaves nothing counted toward the resend', record.charsSinceFull, 0)
      const second = composeContext(current, record, { sessionId: 's' })
      t.eq('the same session gets markers naming the call', [second.full, second.fields.playbooks], [[], { unchanged: true, since: 'T1', call: 'c1', get: 'get_context {"block":"playbooks"}' }])
      t.eq('another session gets everything again', composeContext(current, record, { sessionId: 'other' }).unchanged, [])
      const grown = recordSent(record, { priorSessionId: 's', sessionId: 's', offered: second.offered, full: [], invocationId: 'c2', at: 'T2', chars: 70 })
      t.eq('a call of markers counts toward the resend and keeps the entries', [grown.charsSinceFull, grown.entries.playbooks.invocationId], [70, 'c1'])
      t.eq('past the bound everything goes in full', composeContext(current, grown, { sessionId: 's', resendAfterChars: 70 }).unchanged, [])
      const without = recordSent(grown, { priorSessionId: 's', sessionId: 's', offered: { playbooks: grown.entries.playbooks.hash }, full: [], invocationId: 'c3', at: 'T3', chars: 1 })
      t.eq('a project no longer listed drops out of the record', Object.keys(without.entries), ['playbooks'])
      t.eq('a call with no session records nothing', recordSent(record, { priorSessionId: 's', sessionId: null, offered: {}, full: [], invocationId: 'c', at: 'T', chars: 1 }), null)
      t.eq('an attempted call counts its prompt toward the resend, entries untouched', [countAttempt(record, { sessionId: 's', chars: 30 }).charsSinceFull, countAttempt(record, { sessionId: 's', chars: 30 }).entries], [30, record.entries])
      t.eq('an attempt on another session, or none, counts nothing', [countAttempt(record, { sessionId: 'other', chars: 30 }), countAttempt(null, { sessionId: 's', chars: 30 })], [record, null])
    }

    t.section('first call full, then markers; a changed project file or roster entry goes again, alone')
    {
      const dir = await tmp(), f = panel(), h = runtime()
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      const first = h.calls[0]
      t.eq('the first call carries every block in full', shape(first.sent), all('full'))
      t.eq('the full infrastructure is the project file', first.sent.infrastructure['b-project'], f.infra['b-project'])
      const second = await turn(agent, h, 'again')
      t.eq('the second call carries markers only', shape(second.sent), all('marker'))
      t.eq('each marker names the call that carried the block', second.sent.seatModels.call, first.meta.invocationId)
      t.eq('the second call ran on the same session', second.session.id, first.session === null ? 's1' : first.session.id)
      const ratio = second.prompt.length / first.prompt.length
      t.ok('a steady call is at most a quarter of a full one', ratio <= 0.25, `${second.prompt.length} / ${first.prompt.length} = ${ratio.toFixed(3)}`)

      f.infra['b-project'].orientation += ' A new log directory.'
      const third = await turn(agent, h, 'b changed')
      t.eq('a changed project file goes in full, the others stay markers', shape(third.sent), { ...all('marker'), 'infrastructure:b-project': 'full' })
      t.eq('with the new bytes', third.sent.infrastructure['b-project'].orientation.endsWith('A new log directory.'), true)

      f.roster[3].notes = 'Retired.'
      const fourth = await turn(agent, h, 'roster changed')
      t.eq('a changed roster entry sends seatModels again, nothing else', shape(fourth.sent), { ...all('marker'), seatModels: 'full' })
      const fifth = await turn(agent, h, 'quiet')
      t.eq('and then it is a marker again', shape(fifth.sent), all('marker'))

      const last = agent.get().lastPrompt
      t.eq('GET /api/supervisor reports the last call\'s prompt size', [last.invocationId, last.chars, agent.status().lastPromptChars], [fifth.meta.invocationId, fifth.prompt.length, fifth.prompt.length])
      t.eq('and what it carried in full and as markers', [last.full, last.unchanged.length], [[], 6])
      t.eq('the kept prompt record is exactly what was sent, markers included', (await agent.prompt(fifth.meta.invocationId)).prompt, fifth.prompt)

      // A side question is answered in a fork of the session; it changes nothing the session was sent.
      const before = structuredClone(agent.get().contextSent)
      await agent.ask('What do you hold?')
      await wait(() => agent.get().messages.some((m) => m.side === 'answer'))
      t.eq('ask forks the supervisor\'s own session', [h.forks[0].fork, h.forks[0].session.id], [true, fifth.session.id])
      t.eq('and leaves the session and what it was sent as they were', [agent.get().session.id, agent.get().contextSent], [fifth.session.id, before])
      const sixth = await turn(agent, h, 'after the question')
      t.eq('the next call still carries markers on the same session', [sixth.session.id, shape(sixth.sent)], [fifth.session.id, all('marker')])
    }

    t.section('get_context returns a block in full, read now')
    {
      const dir = await tmp(), f = panel(), h = runtime()
      h.actions.push({ type: 'get_context', block: 'infrastructure', project: 'b-project' }, { type: 'get_context', block: 'seatModels' },
        { type: 'get_context', block: 'playbooks' }, { type: 'get_context', block: 'history' },
        { type: 'get_context', block: 'nothing' }, { type: 'get_context', block: 'infrastructure', project: 'no-project' }, { type: 'get_context', block: 'infrastructure' })
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      await agent.start(START)
      await wait(() => h.calls.length === 8 && idle(agent))
      const results = h.calls.slice(1).map((c) => c.sent.event.result)
      t.eq('infrastructure, for the project named', results[0], { block: 'infrastructure', project: 'b-project', content: f.infra['b-project'] })
      t.eq('the seat catalogue', results[1].content, f.roster)
      t.eq('the playbooks', results[2].content, f.playbooks)
      t.eq('the earlier sessions\' accounting', [results[3].content.role, results[3].content.decides], ['accounting', false])
      t.ok('an unknown block is refused', /Unknown block "nothing"/.test(results[4].error))
      t.ok('an unknown project is refused', /No project "no-project"/.test(results[5].error))
      t.ok('infrastructure needs its project', /needs a project/.test(results[6].error))
      t.eq('while the prompts around them carried markers', shape(h.calls[7].sent), all('marker'))
      t.eq('and nothing was started', agent.get().starts, 0)
    }

    t.section('a restart on the same session resends nothing; New session resends everything')
    {
      const dir = await tmp(), f = panel(), h = runtime()
      let agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      await agent.stop(); await agent.shutdown()
      agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      await agent.start({ ...START, message: 'After the restart' })
      await wait(() => h.calls.length === 2 && idle(agent))
      t.eq('the restarted service resumes the same session', h.calls[1].session?.id, 's1')
      t.eq('and sends markers: the session holds the blocks', shape(h.calls[1].sent), all('marker'))
      await agent.stop()
      await agent.reset()
      await agent.start({ ...START, message: 'A fresh session' })
      await wait(() => h.calls.length === 3 && idle(agent))
      t.eq('New session opens a new native session', [h.calls[2].session ?? null, h.calls.length], [null, 3])
      t.eq('which gets every block in full', shape(h.calls[2].sent), all('full'))
      const next = await turn(agent, h, 'again')
      t.eq('and markers after that', [next.session.id, shape(next.sent)], ['s2', all('marker')])
    }

    t.section('a failed call counts toward the resend bound: its prompt may have reached the session')
    {
      const dir = await tmp(), f = panel(), h = runtime()
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools, resendAfterChars: 1 })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      t.eq('call 1 carries every block in full', shape(h.calls[0].sent), all('full'))
      h.answers.push(() => { throw Error('the runtime crashed mid-turn') })
      await turn(agent, h, 'go on', 2)
      const [failed, retry] = h.calls.slice(1, 3)
      t.eq('call 2 carried markers, and failed', shape(failed.sent), all('marker'))
      t.eq('call 3 carries every block again: the failed prompt counted toward the bound', shape(retry.sent), all('full'))
      t.eq('on the same session', retry.session.id, failed.session.id)
    }
    {
      // Counted before the call and saved with it: a restart after the failure keeps the count. The runtime here
      // fails to start, which ends the activation; even that attempt is counted, the conservative direction.
      const dir = await tmp(), f = panel(), h = runtime()
      let agent = await create({ dir, adapter: h.adapter, tools: f.tools, resendAfterChars: 2000 })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      h.answers.push(() => { throw Object.assign(Error('the runtime could not start'), { kind: 'spawn-error', started: false }) })
      await agent.chat('go on')
      const stateFile = path.join(dir, 'state.json')
      await wait(async () => JSON.parse(await fs.readFile(stateFile, 'utf8')).status === 'stopped')
      const failed = h.calls[1]
      t.eq('the failed call carried markers', shape(failed.sent).playbooks, 'marker')
      t.ok('its prompt is counted on disk', JSON.parse(await fs.readFile(stateFile, 'utf8')).contextSent.charsSinceFull >= failed.prompt.length, String(failed.prompt.length))
      await agent.shutdown()
      agent = await create({ dir, adapter: h.adapter, tools: f.tools, resendAfterChars: 2000 })
      await agent.start({ ...START, message: 'After the restart' })
      await wait(() => h.calls.length === 3 && idle(agent))
      t.eq('the resumed activation, past the bound, goes in full on the same session', [h.calls[2].session?.id ?? null, shape(h.calls[2].sent)], [failed.session.id, all('full')])
    }

    t.section('the bounded resend: past the bound every block goes again')
    {
      const dir = await tmp(), f = panel(), h = runtime()
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools, resendAfterChars: 1 })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      for (const text of ['one', 'two', 'three']) await turn(agent, h, text)
      t.eq('full, markers, then full again once the session has been sent the bound, then markers', h.calls.map((c) => shape(c.sent).playbooks), ['full', 'marker', 'full', 'marker'])
      t.eq('all of them at once', shape(h.calls[2].sent), all('full'))
    }

    t.section('a failed call is not counted as sent: its retry still carries the blocks; a repair turn keeps them')
    {
      const dir = await tmp(), f = panel(), h = runtime()
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      f.roster[0].available = false
      h.answers.push(() => { throw Error('the runtime crashed mid-turn') })
      const retried = await turn(agent, h, 'the roster changed', 2)
      const [failed, retry] = h.calls.slice(-2)
      t.eq('the failed call carried the changed catalogue', shape(failed.sent).seatModels, 'full')
      t.eq('its retry carries it again, the same event', [shape(retry.sent).seatModels, retry.sent.event.text], ['full', 'the roster changed'])
      t.eq('the retry is the last call', retried, retry)
      t.eq('the activation went on and no failure is left counted', [agent.get().status, agent.get().ownFailures], ['active', 0])
      const after = await turn(agent, h, 'quiet')
      t.eq('once a call returned, it is a marker', shape(after.sent).seatModels, 'marker')

      h.answers.push((_call, reply) => ({ ...reply, response: 'not the reply format' }))
      await turn(agent, h, 'say something', 2)
      const repair = h.calls.at(-1)
      t.eq('the format-repair turn is the next call', repair.sent.event.type, 'protocol-repair')
      t.eq('its markers point at calls that returned on this session', shape(repair.sent), all('marker'))
    }

    t.section('a resume that comes back on another session is a failed resume: never adopted, then a new session in full')
    for (const label of ['another id', 'no id']) {
      const dir = await tmp(), f = panel(), h = runtime()
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      await agent.start(START)
      await wait(() => h.calls.length === 1 && idle(agent))
      // The reply from the other session asks for one note, the new session's reply for another.
      h.actions.push({ type: 'add_note', project: 'a-project', issueId: 'issue', text: 'from the other session' }, { type: 'add_note', project: 'a-project', issueId: 'issue', text: 'from the new session' })
      h.answers.push((_call, reply) => ({ ...reply, session: { id: label === 'no id' ? null : 'stranger' } }))
      const n = h.calls.length
      await turn(agent, h, 'note it', 3)
      const [mismatched, retry] = h.calls.slice(n, n + 2)
      t.eq(`${label}: the call went to s1 with markers`, [mismatched.session.id, shape(mismatched.sent).playbooks], ['s1', 'marker'])
      t.ok(`${label}: its reply was kept and marked, not acted on`, agent.get().messages.some((m) => m.discarded === 'session-mismatch' && m.invocationId === mismatched.meta.invocationId))
      t.eq(`${label}: the next call opens a new session`, retry.session ?? null, null)
      t.eq(`${label}: with every block in full`, shape(retry.sent), all('full'))
      t.eq(`${label}: and the same event`, retry.sent.event.text, 'note it')
      t.eq(`${label}: only the new session's reply was acted on`, f.notes.map((x) => x.text), ['from the new session'])
      const retired = agent.get().sessionHistory.at(-1)
      t.eq(`${label}: the old session is retired, naming what came back`, [retired.session.id, retired.replacedBy, retired.reason], ['s1', label === 'no id' ? null : 'stranger', 'resume-returned-another-session'])
      t.eq(`${label}: the returned session is never resumed`, h.calls.some((c) => c.session?.id === 'stranger'), false)
      t.eq(`${label}: same model, activation going on`, [agent.get().model.id, agent.get().status], ['test-model', 'active'])
      const next = await turn(agent, h, 'go on')
      t.eq(`${label}: the new session gets markers after that`, [next.session.id, shape(next.sent)], ['s2', all('marker')])
    }

    t.section('an owed retry survives the wake\'s last allowed call')
    for (const label of ['a failed call', 'another session']) {
      const dir = await tmp(), f = panel(), h = runtime()
      await fs.writeFile(path.join(dir, 'spending-policy.json'), JSON.stringify({ version: 1, daily: { usd: 100, starts: 10, unpricedRuns: 10, unpricedCalls: 100 }, monthly: { usd: 1000, starts: 100, unpricedRuns: 100, unpricedCalls: 1000 }, concurrent: 3, perWakeCalls: 2 }))
      const agent = await create({ dir, adapter: h.adapter, tools: f.tools })
      // The first call reads a block, so its result is the wake's second and last allowed call.
      h.actions.push({ type: 'get_context', block: 'playbooks' })
      h.answers.push(null, label === 'a failed call' ? () => { throw Error('the runtime crashed mid-turn') } : (_c, r) => ({ ...r, session: { id: 'stranger' } }))
      await agent.start(START)
      // Until the refused chain has closed (its wake gone): a message sent while it closes joins that wake.
      await wait(() => h.calls.length === 2 && (agent.get().deferred ?? []).some((d) => d.retry) && !agent.get().queue.length && agent.get().status === 'active' && agent.get().wake === null)
      const owed = agent.get().deferred.find((d) => d.retry)
      t.eq(`${label}: no third call in that wake`, h.calls.length, 2)
      t.eq(`${label}: the event is held, not dropped`, [owed.event.type, owed.event.action.type, /perWakeCalls/.test(owed.reason)], ['tool-result', 'get_context', true])
      const next = await turn(agent, h, 'a new wake')
      t.ok(`${label}: the next wake carries it`, (next.sent.event.deferred ?? []).some((d) => d.retry && d.event.type === 'tool-result' && d.event.result.block === 'playbooks'))
      if (label === 'another session') t.eq(`${label}: on a new session with every block in full`, [next.session ?? null, shape(next.sent)], [null, all('full')])
      t.eq(`${label}: and it is no longer held`, (agent.get().deferred ?? []).some((d) => d.retry), false)
    }
  } finally {
    for (const a of agents) { await a.stop().catch(() => {}); await a.shutdown().catch(() => {}) }
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true })
  }
}
