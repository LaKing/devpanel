import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

export const name = 'top supervisor — its state stays small: prompts are kept beside it, and an idle activation writes nothing'

const wait = async (test) => { const end = Date.now() + 4000; while (!await test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const models = async () => [{ id: 'test-model', title: 'Test', model: 'wire', verification: { status: 'verified' } }]
const tools = { projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => [{ id: 'issue' }] }

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-state-'))
  const stateFile = path.join(dir, 'state.json')
  let agent = null
  try {
    t.section('a state written with a prompt on every reply is moved once, at load')
    const big = 'P'.repeat(50_000)
    await fs.writeFile(stateFile, JSON.stringify({
      status: 'stopped', session: null, model: null, queue: [], ownedRuns: [], previews: {}, calls: 2, starts: 0, costUsd: 0, unknownCostCalls: 0,
      messages: [
        { id: 'm1', role: 'user', text: 'Mission' },
        { id: 'm2', role: 'assistant', text: 'first', invocationId: 'call-1', prompt: big, rawResponse: 'first' },
        { id: 'm3', role: 'assistant', text: 'second', invocationId: 'call-2', prompt: 'short prompt', rawResponse: 'second' }
      ],
      failureHistory: [{ kind: 'model', invocationId: 'failed-1', prompt: 'the failed call\'s prompt', error: 'spawn', started: false }]
    }))
    agent = await createTopSupervisor({ dir, models, adapter: { invoke: async () => { throw Error('not called') } }, tools, pollMs: 20 })
    const loaded = agent.get()
    t.eq('no message carries a prompt any more', loaded.messages.map((m) => m.prompt), [undefined, undefined, undefined])
    t.eq('each reply says how large its prompt was', loaded.messages.map((m) => m.promptBytes ?? null), [null, 50_000, 12])
    t.eq('a recorded failure is treated the same', [loaded.failureHistory[0].prompt, loaded.failureHistory[0].promptBytes], [undefined, 24])
    t.eq('the prompts are files beside the state', (await fs.readdir(path.join(dir, 'prompts'))).sort(), ['call-1.json', 'call-2.json', 'failed-1.json'])
    t.eq('read back whole through the supervisor', [(await agent.prompt('call-1')).prompt === big, (await agent.prompt('failed-1')).prompt], [true, 'the failed call\'s prompt'])
    t.eq('a call with no kept prompt reads as null', (await agent.prompt('never-made')).prompt, null)
    t.ok('and a name that is not an invocation id is refused', await agent.prompt('../state').then(() => false, () => true))
    const onDisk = await fs.readFile(stateFile, 'utf8')
    t.ok('the state file on disk has shrunk to match', onDisk.length < 5000 && !onDisk.includes('PPPP'), `${onDisk.length} bytes`)
    await agent.shutdown()

    t.section('a call\'s prompt goes to its file, never into the state')
    const sent = []
    const adapter = { invoke: async (args) => { sent.push(args); return { session: { id: 's' }, response: JSON.stringify({ message: 'ok', action: null }), usage: { costUsd: 0 } } } }
    let events = 0
    agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20, emit: () => { events++ } })
    await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Mission', limits: { maxCalls: 10 } })
    await wait(() => agent.get().status === 'active' && sent.length === 1 && agent.get().pending === null)
    const reply = agent.get().messages.findLast((m) => m.role === 'assistant')
    t.eq('the reply names its call and the prompt\'s size', [reply.prompt, reply.promptBytes], [undefined, sent[0].prompt.length])
    t.eq('and the kept file holds exactly what the model was sent', (await agent.prompt(reply.invocationId)).prompt, sent[0].prompt)

    t.section('an idle activation rewrites nothing: a poll that changed nothing saves nothing')
    // The first polls record their baselines (issues seen, the ready queue): wait until two readings in a row agree.
    let last = null
    await wait(async () => { const now = (await fs.stat(stateFile)).ino; const same = now === last; last = now; await new Promise((r) => setTimeout(r, 100)); return same })
    const before = await fs.stat(stateFile)
    const eventsBefore = events
    await new Promise((r) => setTimeout(r, 400))   // some twenty polls
    const after = await fs.stat(stateFile)
    t.eq('the file was not replaced', [after.ino, after.mtimeMs], [before.ino, before.mtimeMs])
    t.eq('and no state event was announced', events - eventsBefore, 0)
    await agent.chat('A note')
    await wait(() => sent.length === 2 && agent.get().pending === null)
    t.ok('a real change is written as before', (await fs.stat(stateFile)).ino !== before.ino)
    await agent.stop()
    await agent.shutdown()

    t.section('a poll slower than its interval does not pile up: an operator action waits for one poll at most')
    // Each poll takes 150 ms against a 20 ms interval. Queued without limit, a second of idling leaves some fifty polls
    // (over seven seconds) in front of whatever the operator does next.
    let polls = 0
    const slow = { ...tools, listIssues: async () => { polls++; await new Promise((r) => setTimeout(r, 150)); return [{ id: 'issue' }] } }
    agent = await createTopSupervisor({ dir, models, adapter, tools: slow, pollMs: 20 })
    await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Again', limits: { maxCalls: 10 } })
    await wait(() => agent.get().status === 'active' && agent.get().pending === null && polls > 0)
    await new Promise((r) => setTimeout(r, 1000))
    const pollsInASecond = polls
    const asked = Date.now()
    await agent.chat('Operator note')
    const waited = Date.now() - asked
    t.ok('the polls of an idle second ran one after another, none queued behind another', pollsInASecond <= 9, `${pollsInASecond} polls`)
    t.ok('and the operator\'s message was taken within about one poll', waited < 600, `${waited} ms`)
    await agent.stop()
  } finally {
    await agent?.shutdown?.().catch(() => {})
    await fs.rm(dir, { recursive: true, force: true })
  }
}
