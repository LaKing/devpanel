import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { createChat } from '../server/supervisor-chat.mjs'

export const name = 'top supervisor — the chat lives beside the state: a state change costs the same with a 4 MB chat, readers get it bounded, and an old state migrates without loss'

const wait = async (test) => { const end = Date.now() + 4000; while (!await test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }
const models = async () => [{ id: 'test-model', title: 'Test', model: 'wire', verification: { status: 'verified' } }]
const tools = { projects: async () => [{ id: 'one-project' }], playbooks: async () => [], listIssues: async () => [{ id: 'issue' }] }
const quiet = { invoke: async () => { throw Error('not called') } }
const KB = 1024

// Chats as the live one is: replies and tool results (JSON strings, the bulk), every message with an id.
function spread (bytes) {
  const messages = []
  let size = 0, i = 0
  while (size < bytes) {
    const m = i % 2
      ? { id: `m-${i}`, at: '2026-11-15T00:00:00.000Z', role: 'tool', text: JSON.stringify({ issues: Array.from({ length: 12 }, (_, k) => ({ id: `issue-${i}-${k}`, status: 'open', name: `Issue name ${k} of round ${i}` })) }), action: { type: 'list_issues', project: 'one-project' } }
      : { id: `m-${i}`, at: '2026-11-15T00:00:00.000Z', role: 'assistant', text: `Reply ${i}`.padEnd(400, '.'), usage: { tokens: 100 }, durationMs: 1000, invocationId: `inv-${i}`, promptBytes: 900, rawResponse: `{"message":"Reply ${i}"}`, protocol: { valid: true, repairAttempt: 0 } }
    messages.push(m); size += JSON.stringify(m).length; i++
  }
  return messages
}
const oneHuge = () => [
  { id: 'm-0', at: '2026-11-15T00:00:00.000Z', role: 'user', text: 'Mission' },
  { id: 'm-1', at: '2026-11-15T00:00:00.000Z', role: 'assistant', text: 'Reading', usage: { tokens: 100 }, durationMs: 1000 },
  { id: 'm-huge', at: '2026-11-15T00:00:00.000Z', role: 'tool', text: 'R'.repeat(4_000_000), action: { type: 'get_file', project: 'one-project', issueId: 'issue', note: 'N'.repeat(5000) } },
  { id: 'm-3', at: '2026-11-15T00:00:00.000Z', role: 'assistant', text: 'Done' }
]
// Limits are UTF-8 bytes on the wire, not string length.
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
// Replies in a script that takes three bytes a character: 200 of them just below the bounding limit each.
const cjk = () => Array.from({ length: 240 }, (_, i) => ({ id: `c-${i}`, at: '2026-11-15T00:00:00.000Z', role: 'assistant', text: '漢'.repeat(5000) }))
const legacy = (messages, extra = {}) => JSON.stringify({ status: 'stopped', session: null, model: null, messages, queue: [], ownedRuns: [], previews: {}, calls: 0, starts: 0, costUsd: 0, unknownCostCalls: 0, ...extra }, null, 2)
const chatBytes = async (dir) => { let n = 0; for (const f of await fs.readdir(dir)) if (/^chat.*\.jsonl$/.test(f)) n += (await fs.stat(path.join(dir, f))).size; return n }
const chatLines = async (dir) => {
  const names = (await fs.readdir(dir)).filter((f) => /^chat.*\.jsonl$/.test(f))
  return names.length ? (await fs.readFile(path.join(dir, names[0]), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
// Every message, read back a page at a time from the newest, as the chat view pages.
async function allMessages (agent) {
  if (typeof agent.messages !== 'function') return null
  const out = []
  let before = undefined
  for (;;) {
    const page = agent.messages({ before, limit: 500 })
    out.unshift(...page.entries)
    if (!page.from) return out
    before = page.from
  }
}

export default async function (t) {
  const roots = []
  const tmp = async (label) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), `devpanel-chat-${label}-`)); roots.push(d); return d }
  const realClone = globalThis.structuredClone
  try {
    for (const [label, messages] of [['40 kB spread', spread(40_000)], ['4 MB spread', spread(4_000_000)], ['one 4 MB message', oneHuge()], ['three-byte characters', cjk()]]) {
      t.section(`a state change and a reading with a chat of ${label}`)
      const dir = await tmp('size')
      await fs.writeFile(path.join(dir, 'state.json'), legacy(messages))
      const events = []
      const agent = await createTopSupervisor({ dir, models, adapter: quiet, tools, pollMs: 20, emit: (e) => events.push(e) })
      try {
        const stateBefore = (await fs.stat(path.join(dir, 'state.json'))).size, chatBefore = await chatBytes(dir)
        let cloned = 0
        globalThis.structuredClone = (value, options) => { cloned += JSON.stringify(value)?.length ?? 0; return realClone(value, options) }
        events.length = 0
        await agent.setCampaign({ campaign: { projects: ['one-project'] }, actor: 'tester' })
        const clonedByChange = cloned
        cloned = 0
        const body = JSON.stringify(agent.get())
        const clonedByReading = cloned
        globalThis.structuredClone = realClone
        const written = (await fs.stat(path.join(dir, 'state.json'))).size + Math.max(0, await chatBytes(dir) - chatBefore)
        t.ok('bytes written for one state change stay under 256 kB', written < 256 * KB, `${written} bytes (state.json was ${stateBefore})`)
        t.ok('bytes cloned for that change stay under 512 kB', clonedByChange < 512 * KB, `${clonedByChange} bytes`)
        t.ok('what a reader of the state is sent stays under 512 kB', bytes(body) < 512 * KB, `${bytes(body)} bytes`)
        t.ok('of which the chat stays under 256 kB, in UTF-8 bytes', bytes(JSON.parse(body).messages) < 256 * KB, `${bytes(JSON.parse(body).messages)} bytes`)
        t.ok('and what is cloned for it too', clonedByReading < 512 * KB, `${clonedByReading} bytes`)
        t.ok('every event emitted is small and carries no chat', events.length > 0 && events.every((e) => JSON.stringify(e).length < 2 * KB && !('messages' in e)), JSON.stringify(events).slice(0, 200))
        const view = JSON.parse(body)
        t.eq('the reading says how much chat there is', view.chat?.total, messages.length + 1)
        t.eq('and shows the newest message', view.messages.at(-1)?.text, 'Campaign scope set by tester: projects one-project.')
        const page = typeof agent.messages === 'function' ? agent.messages({ before: view.chat?.from ?? 0, limit: 500 }) : null
        t.ok('a page of older messages stays under 512 kB, in UTF-8 bytes', page !== null && bytes(page) <= 512 * KB, page ? `${bytes(page)} bytes` : 'no paging')
        if (label === 'one 4 MB message') {
          const shown = [...view.messages, ...(page?.entries ?? [])].find((m) => m.id === 'm-huge')
          t.ok('the huge message is shown bounded, saying what was cut', shown?.truncated?.bytes > 4_000_000 && shown.truncated.fields.includes('text') && shown.text === 'R'.repeat(8000) && shown.action?.type === 'get_file', JSON.stringify(shown?.truncated))
          t.ok('and read whole only on request', typeof agent.message === 'function' && agent.message('m-huge').text === 'R'.repeat(4_000_000))
        }
        if (label === '4 MB spread') {
          const all = await allMessages(agent)
          t.eq('paging from the newest returns every message once, in order', all?.map((m) => m.id), [...messages.map((m) => m.id), view.messages.at(-1).id])
        }
      } finally { globalThis.structuredClone = realClone; await agent.shutdown() }
    }

    t.section('an old state with prompts inside migrates: prompts first, then the chat, then the state')
    const prompts = { 'call-1': 'P'.repeat(50_000), 'call-2': 'short prompt', 'failed-1': 'the failed call\'s prompt', 'pending-1': 'the pending call\'s prompt' }
    const oldMessages = [
      { id: 'm1', role: 'user', text: 'Mission' },
      { id: 'm2', role: 'assistant', text: 'first', invocationId: 'call-1', prompt: prompts['call-1'], rawResponse: 'first' },
      { id: 'm3', role: 'assistant', text: 'second', invocationId: 'call-2', prompt: prompts['call-2'], rawResponse: 'second', side: 'answer' }
    ]
    const oldState = legacy(oldMessages, { failureHistory: [{ kind: 'model', invocationId: 'failed-1', prompt: prompts['failed-1'], error: 'spawn', started: false }], pending: { kind: 'model', invocationId: 'pending-1', prompt: prompts['pending-1'] } })
    const expected = oldMessages.map(({ prompt, ...m }) => prompt ? { ...m, promptBytes: prompt.length } : m)
    const migrated = async (dir, label) => {
      const agent = await createTopSupervisor({ dir, models, adapter: quiet, tools, pollMs: 20 })
      try {
        const disk = await fs.readFile(path.join(dir, 'state.json'), 'utf8')
        const lines = await chatLines(dir)
        t.eq(`${label}: the chat file holds every message, in order, each field kept and promptBytes added`, lines, expected)
        t.ok(`${label}: no prompt anywhere in the chat file or the state`, !JSON.stringify(lines).includes('"prompt"') && !disk.includes('"prompt"') && !('messages' in JSON.parse(disk)))
        for (const [id, text] of Object.entries(prompts)) t.eq(`${label}: prompt ${id} is its file, exactly`, (await agent.prompt(id)).prompt, text)
        t.eq(`${label}: the recorded failure and the pending call say how large their prompts were`, [agent.get().failureHistory[0].promptBytes, agent.get().pending.promptBytes], [prompts['failed-1'].length, prompts['pending-1'].length])
        t.eq(`${label}: the reading shows the same messages`, agent.get().messages, expected)
      } finally { await agent.shutdown() }
    }
    { const dir = await tmp('migrate'); await fs.writeFile(path.join(dir, 'state.json'), oldState); await migrated(dir, 'fresh') }
    {
      // A crash during step 1: some prompts are already files.
      const dir = await tmp('crash1'); await fs.writeFile(path.join(dir, 'state.json'), oldState)
      await fs.mkdir(path.join(dir, 'prompts')); await fs.writeFile(path.join(dir, 'prompts', 'call-1.json'), prompts['call-1'])
      await migrated(dir, 'after a crash with prompts half moved')
    }
    {
      // A crash during step 2: the chat file's temporary copy is left behind.
      const dir = await tmp('crash2'); await fs.writeFile(path.join(dir, 'state.json'), oldState)
      await fs.writeFile(path.join(dir, 'chat.jsonl.0000.tmp'), '{"id":"m1","role":"us')
      await migrated(dir, 'after a crash while writing the chat')
    }
    {
      // A crash after step 2: a finished chat file, the state not yet rewritten. The old state wins.
      const dir = await tmp('crash3'); await fs.writeFile(path.join(dir, 'state.json'), oldState)
      await fs.writeFile(path.join(dir, 'chat.jsonl'), JSON.stringify(expected[0]) + '\n')
      await migrated(dir, 'after a crash before the state was saved')
    }
    {
      // A prompt that cannot be kept stops the load before anything is written.
      const dir = await tmp('failed'); await fs.writeFile(path.join(dir, 'state.json'), oldState)
      await fs.writeFile(path.join(dir, 'prompts'), 'not a directory')
      const refused = await createTopSupervisor({ dir, models, adapter: quiet, tools, pollMs: 20 }).then((a) => a.shutdown().then(() => false), () => true)
      t.ok('a prompt that cannot be kept refuses the load', refused)
      t.eq('and leaves state.json exactly as it was', await fs.readFile(path.join(dir, 'state.json'), 'utf8'), oldState)
      t.eq('with no chat file written', (await fs.readdir(dir)).filter((f) => f.startsWith('chat')), [])
    }

    t.section('reading the chat again costs nothing that grows with it: bounded forms and usage are kept, not recomputed')
    {
      const realStringify = JSON.stringify
      const reads = { n: 0 }
      const counted = (i) => { const m = { id: `a-${i}`, role: 'assistant', text: 'reply', durationMs: 10 }; Object.defineProperty(m, 'usage', { enumerable: true, get () { reads.n++; return { tokens: 5 } } }); return m }
      const perRead = []
      for (const n of [40, 4000]) {
        const chat = createChat({ dir: await tmp(`usage-${n}`) })
        for (let i = 0; i < n; i++) chat.append(counted(i))
        reads.n = 0
        const one = [chat.usage?.(), chat.briefUsage?.()]
        perRead.push(reads.n)
        t.eq(`with ${n} replies the totals are right`, one, [{ tokens: 5 * n, durationMs: 10 * n, untimed: 0 }, { tokens: 5 * n, durationMs: 10 * n, untimed: 0 }])
      }
      t.eq('a reading of the usage reads no message, whether there are 40 replies or 4000', perRead, [0, 0])
      const chat = createChat({ dir: await tmp('field') })
      chat.append({ id: 'm-0', role: 'user', text: 'Mission' })
      chat.append({ id: 'big', role: 'tool', text: 'noted', action: { type: 'add_note', project: 'p', issueId: 'i', text: 'N'.repeat(4_000_000) } })
      // No reading before the count starts: the first one is measured too.
      let serialised = 0
      JSON.stringify = (...args) => { const out = realStringify(...args); serialised += out?.length ?? 0; return out }
      let shown
      try { chat.tail(); shown = chat.tail().entries.at(-1); chat.page({ before: 2 }) } finally { JSON.stringify = realStringify }
      t.ok('a retained 4 MB field is serialised when the message is written, not at any reading, the first included', serialised < 64 * KB, `${serialised} characters serialised by three readings`)
      t.ok('and the message is shown bounded, its action named', shown?.truncated?.fields?.includes('action') && shown.action?.type === 'add_note' && shown.text === 'noted')
      chat.amend(chat.entry('big'), { text: 'changed' })
      t.eq('a change to the message is shown at the next reading', chat.tail().entries.at(-1).text, 'changed')
    }

    t.section('an old message with no id is still read whole on request')
    {
      const dir = await tmp('noid')
      await fs.writeFile(path.join(dir, 'state.json'), legacy([{ role: 'user', text: 'Mission' }, { role: 'tool', text: 'R'.repeat(4_000_000), action: { type: 'get_file' } }, { role: 'assistant', text: 'Done' }]))
      const agent = await createTopSupervisor({ dir, models, adapter: quiet, tools, pollMs: 20 })
      try {
        const shown = agent.get().messages.find((m) => m.role === 'tool')
        t.ok('the migrated message has an id the chat view can ask with', typeof shown?.id === 'string' && /^[A-Za-z0-9-]+$/.test(shown.id) && shown.truncated?.fields.includes('text'), JSON.stringify({ id: shown?.id, truncated: shown?.truncated }))
        t.eq('and the whole text comes back for it', shown?.id ? agent.message(shown.id).text.length : null, 4_000_000)
        t.ok('every migrated message has one, the same on every page', (await allMessages(agent)).every((m) => typeof m.id === 'string'))
        const again = agent.get().messages.map((m) => m.id)
        await agent.shutdown()
        const reopened = await createTopSupervisor({ dir, models, adapter: quiet, tools, pollMs: 20 })
        t.eq('and keeps it across a restart', reopened.get().messages.map((m) => m.id), again)
        await reopened.shutdown()
      } catch (e) { await agent.shutdown().catch(() => {}); throw e }
    }

    t.section('after a failed write or fsync, a restart reads the chat exactly as it was in memory')
    {
      // Faults of the chat file's own handle: the write, or the fsync after the bytes reached the file.
      const realOpen = fs.open
      const faulty = (target) => {
        const faults = []
        fs.open = async (...args) => {
          const handle = await realOpen(...args)
          const fault = args[0] === target && faults.shift()
          if (fault === 'write') handle.writeFile = async () => { throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' }) }
          if (fault === 'fsync') handle.sync = async () => { throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }) }
          return handle
        }
        return faults
      }
      // How a save writes the chat: flush() where the chat has it, else what the previous revision's save did (take the lines when the save is asked, write them in its turn).
      const saver = (chat) => {
        if (typeof chat.flush === 'function') return () => chat.flush()
        let chain = Promise.resolve()
        return () => { const lines = chat.take(); const p = chain.then(() => lines ? chat.write(lines) : undefined); chain = p.catch(() => {}); return p }
      }
      const reload = async (dir) => { const again = createChat({ dir }); await again.load(); return again.entries }
      try {
        {
          const dir = await tmp('retry-once')
          const chat = createChat({ dir })
          const faults = faulty(path.join(dir, chat.file))
          const save = saver(chat)
          chat.append({ id: 'once', role: 'user', text: 'Only once' })
          faults.push('fsync')
          const failed = await save().then(() => false, () => true)
          t.ok('a write fails after its bytes reached the file', failed && (await fs.readFile(path.join(dir, chat.file), 'utf8')).includes('Only once'))
          await save()
          t.eq('after the retry and a restart the message is there once', (await reload(dir)).map((m) => m.id), ['once'])
        }
        {
          const dir = await tmp('retry-order')
          const chat = createChat({ dir })
          const faults = faulty(path.join(dir, chat.file))
          const save = saver(chat)
          faults.push('write')
          chat.append({ id: 'a', role: 'user', text: 'first' })
          const first = save()
          chat.append({ id: 'b', role: 'user', text: 'second' })
          const second = save()
          const outcomes = await Promise.allSettled([first, second])
          await save()
          t.eq('a failed write while the next save waits: the first save fails', outcomes[0].status, 'rejected')
          t.eq('and the order on disk is the order in memory, a then b', (await reload(dir)).map((m) => m.id), chat.entries.map((m) => m.id))
        }
        {
          const dir = await tmp('retry-amend')
          const chat = createChat({ dir })
          const faults = faulty(path.join(dir, chat.file))
          const save = saver(chat)
          chat.append({ id: 'a', role: 'assistant', text: 'raw reply' })
          await save()
          chat.amend(chat.entry('a'), { text: 'first' })
          faults.push('fsync')
          const first = save()
          chat.amend(chat.entry('a'), { text: 'second' })
          const second = save()
          await Promise.allSettled([first, second])
          await save()
          t.eq('an fsync failure, then a newer amendment: the newest text wins after a restart', (await reload(dir)).map((m) => m.text), ['second'])
          t.eq('as it does in memory', chat.entries.map((m) => m.text), ['second'])
        }
      } finally { fs.open = realOpen }
    }

    t.section('restart, a torn line, a side question, New session')
    const dir = await tmp('life')
    const adapter = { invoke: async (args) => args.fork
      ? { session: args.session, response: 'The side answer', usage: { costUsd: 0 } }
      : { session: { id: 's' }, response: JSON.stringify({ message: 'parsed reply', action: null }), usage: { costUsd: 0, tokens: 42 } } }
    let agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
    await agent.start({ model: 'test-model', projects: ['one-project'], message: 'Mission', limits: { maxCalls: 10 } })
    await wait(() => agent.get().messages.some((m) => m.role === 'assistant' && m.protocol?.valid))
    await agent.ask('A side question?')
    await wait(() => agent.get().asking === null && agent.get().messages.some((m) => m.side === 'answer'))
    await agent.stop()
    const before = agent.get()
    await agent.shutdown()
    t.ok('a reply\'s parsed text and verdict are amendment lines in the chat file', (await chatLines(dir)).some((l) => l.amend && l.set?.text === 'parsed reply'))
    await fs.appendFile(path.join(dir, before.chatFile), '{"id":"torn","role":"sys')
    agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
    const after = agent.get()
    t.eq('after a restart the chat is what it was', after.messages.slice(0, before.messages.length), before.messages)
    const reply = after.messages.find((m) => m.role === 'assistant' && !m.side)
    t.eq('with the reply as it was amended', [reply.text, reply.protocol?.valid], ['parsed reply', true])
    t.ok('the torn final line is dropped and reported', !after.messages.some((m) => m.id === 'torn') && after.chat.recovered?.truncatedBytes > 0 && (await fs.readFile(path.join(dir, before.chatFile), 'utf8')).endsWith('\n'))
    const question = after.messages.find((m) => m.side === 'question'), answer = after.messages.find((m) => m.side === 'answer')
    t.eq('the side question and its answer survive the restart', [question?.text, answer?.text, answer?.replyTo === question?.id], ['A side question?', 'The side answer', true])
    const count = after.chat.total
    await agent.reset()
    const fresh = agent.get()
    const archive = JSON.parse(await fs.readFile(path.join(dir, fresh.reset.archive), 'utf8'))
    t.eq('New session archives the whole previous chat inline, as before', archive.messages.length, count)
    t.ok('the new conversation has a file of its own, named in the state', /^chat-.+\.jsonl$/.test(fresh.chatFile) && fresh.chatFile !== before.chatFile)
    t.eq('and the old file is gone', (await fs.readdir(dir)).filter((f) => /^chat.*\.jsonl$/.test(f)), [fresh.chatFile])
    t.eq('the new chat holds only the fresh-session message', fresh.messages.map((m) => m.role), ['system'])
    await agent.shutdown()
    agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
    t.eq('which a restart reads back from the new file', agent.get().messages.map((m) => m.text), fresh.messages.map((m) => m.text))
    await agent.shutdown()
  } finally {
    globalThis.structuredClone = realClone
    for (const d of roots) await fs.rm(d, { recursive: true, force: true })
  }
}
