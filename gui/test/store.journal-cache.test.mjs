import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '../server/runtime/store.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture } from './fakes/fixture.mjs'

/*
 * The per-append journal check (store.mjs, execution-contract.md "Persistence
 * and decision identity"): an append to an unchanged journal reads a bounded
 * tail, never the whole journal; anything changed gets today's full validation;
 * appends, checks and reads of one journal (by any name) take turns.
 */
const NL = '\n'
const line = (type, extra = {}) => JSON.stringify({ type, at: '2026-11-25T00:00:00.000Z', ...extra }) + NL
const BOUND = 8192 + 16384   // the check's 8 KiB plus the proof's two 8 KiB reads

const journalOf = (issue, runId) => path.join(store.runDir(issue, runId), 'events.jsonl')
const exists = (file) => fs.access(file).then(() => true, () => false)

async function makeRun (issue, runId, content = '') {
  const dir = store.runDir(issue, runId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ runId }))
  await fs.writeFile(path.join(dir, 'events.jsonl'), content)
  return dir
}

/** Watch what the store does with the journal files: full reads and bytes read. */
function watchJournal (files) {
  const names = new Set(files.map((f) => path.resolve(f)))
  const counts = { readFile: 0, bytes: 0 }
  const open = fs.open
  fs.open = async (file, flags, ...rest) => {
    const handle = await open.call(fs, file, flags, ...rest)
    if (names.has(path.resolve(String(file)))) {
      const read = handle.read.bind(handle)
      const readFile = handle.readFile.bind(handle)
      handle.read = async (...args) => { const r = await read(...args); counts.bytes += r.bytesRead; return r }
      handle.readFile = async (...args) => { const b = await readFile(...args); counts.readFile++; counts.bytes += b.length; return b }
    }
    return handle
  }
  return { counts, reset () { counts.readFile = 0; counts.bytes = 0 }, restore () { fs.open = open } }
}

/** Counts JSON.parse calls made while fn runs. */
async function parses (fn) {
  const parse = JSON.parse
  let n = 0
  JSON.parse = (...args) => { n++; return parse(...args) }
  try { await fn() } finally { JSON.parse = parse }
  return n
}

/** A referenced timer, cleared when the promise settles, so a stall fails with its label. */
function within (promise, label, ms = 10000) {
  let timer
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out (deadlock?)')), ms) })])
    .finally(() => clearTimeout(timer))
}

/** Wait until n calls are queued on a journal's chain; the poll stops when the watchdog fires. */
async function queuedAtLeast (issuePath, runId, n, label) {
  let stop = false
  const poll = (async () => {
    while (!stop && await store.__journalCache.queued(issuePath, runId) < n) await new Promise((resolve) => setImmediate(resolve))
  })()
  try { await within(poll, label) } finally { stop = true }
}

/** Pause the next append to `file` half-way through its write; returns the gate. */
function pauseAppend (file) {
  const open = fs.open
  let paused, release
  const pausedP = new Promise((resolve) => { paused = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  let armed = true
  fs.open = async (target, flags, ...rest) => {
    const handle = await open.call(fs, target, flags, ...rest)
    if (armed && flags === 'a' && path.resolve(String(target)) === path.resolve(file)) {
      armed = false
      handle.writeFile = async (data) => {
        const bytes = Buffer.from(data)
        const half = Math.floor(bytes.length / 2)
        await handle.write(bytes, 0, half)
        paused()
        await gate
        await handle.write(bytes, half, bytes.length - half)
      }
    }
    return handle
  }
  return { paused: pausedP, release: () => release(), restore () { fs.open = open; release() } }
}

async function refusal (fn) { try { await fn(); return null } catch (error) { return error } }

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-cache-'))
  try {
    t.section('cache hit: an unchanged journal is not read again')
    {
      const issue = path.join(root, 'hit')
      await makeRun(issue, 'r', Array.from({ length: 50 }, (_, i) => line('seed', { i })).join(''))
      const file = journalOf(issue, 'r')
      const seedParses = await parses(() => store.readRun(issue, 'r'))
      t.ok('the first open (readRun) validates in full', seedParses >= 50, `${seedParses} parses`)
      const w = watchJournal([file])
      try {
        for (let i = 0; i < 5; i++) {
          w.reset()
          const n = await parses(() => store.appendEvent(issue, 'r', { type: 'hit', i }))
          t.eq(`append ${i + 1}: no full read`, w.counts.readFile, 0)
          t.eq(`append ${i + 1}: only its own record is parsed`, n, 1)
          t.ok(`append ${i + 1}: bytes read stay within the bound`, w.counts.bytes <= BOUND, `${w.counts.bytes} bytes`)
        }
        w.reset()
        await store.requireCompleteEvents(issue, 'r')
        await store.appendEvent(issue, 'r', { type: 'persist-path' })
        t.eq('requireCompleteEvents then appendEvent (the persist path): no full read', w.counts.readFile, 0)
      } finally { w.restore() }
      const journal = await store.readEvents(issue, 'r')
      t.eq('journal complete with every append', [journal.complete, journal.events.length], [true, 56])
    }

    t.section('a journal changed by someone else gets the full validation')
    {
      const cases = [
        ['outside append of a valid event', async (f) => fs.appendFile(f, line('outside')), 'appended'],
        ['outside append of a torn line', async (f) => fs.appendFile(f, '{"type":'), 'refused'],
        ['truncation in the middle of a record', async (f) => fs.truncate(f, (await fs.stat(f)).size - 5), 'refused'],
        ['truncation at a record boundary', async (f) => fs.truncate(f, (await fs.stat(f)).size - Buffer.byteLength(line('third'))), 'appended'],
        ['final newline removed', async (f) => fs.truncate(f, (await fs.stat(f)).size - 1), 'refused'],
        ['same-size edit inside the tail', async (f) => {
          const bytes = await fs.readFile(f)
          bytes[bytes.length - Buffer.byteLength(line('third'))] = 0x5b   // '{' → '['
          await fs.writeFile(f, bytes)
        }, 'refused'],
        ['replaced file (same bytes, new inode)', async (f) => {
          await fs.copyFile(f, f + '.new'); await fs.rename(f + '.new', f)
        }, 'appended'],
        ['journal-recovery.json appears', async (f) => fs.writeFile(path.join(path.dirname(f), 'journal-recovery.json'),
          JSON.stringify({ recoveryRequired: true, message: 'found by someone' })), 'refused'],
        ['legacy-journal-disposition.json appears', async (f) => fs.writeFile(path.join(path.dirname(f), 'legacy-journal-disposition.json'), '{}'), 'refused']
      ]
      for (const [label, change, expected] of cases) {
        const issue = path.join(root, 'change-' + label.replace(/[^a-z]+/g, '-'))
        await makeRun(issue, 'r', line('first') + line('second') + line('third'))
        const file = journalOf(issue, 'r')
        await store.readRun(issue, 'r')
        t.ok(`${label}: an entry is trusted before the change`, !!await store.__journalCache.get(issue, 'r'))
        await change(file)
        const before = await fs.readFile(file)
        const w = watchJournal([file])
        let error
        try { error = await refusal(() => store.appendEvent(issue, 'r', { type: 'after' })) } finally { w.restore() }
        t.eq(`${label}: the change sends the check to the full read`, w.counts.readFile, 1)
        if (expected === 'refused') {
          t.eq(`${label}: refused as today`, error?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
          t.ok(`${label}: never appended to`, (await fs.readFile(file)).equals(before))
          t.eq(`${label}: refused again on the next try`, (await refusal(() => store.appendEvent(issue, 'r', { type: 'again' })))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
        } else {
          t.eq(`${label}: accepted as today`, error, null)
          const next = watchJournal([file])
          try { await store.appendEvent(issue, 'r', { type: 'next' }) } finally { next.restore() }
          t.eq(`${label}: the clean full read re-seeded the entry; the next append is a hit`, next.counts.readFile, 0)
        }
      }
    }

    t.section('a same-size edit before the tail, in a later tick, is caught by the timestamps')
    {
      const issue = path.join(root, 'early-edit')
      await makeRun(issue, 'r', line('big', { pad: 'x'.repeat(20000) }) + line('small'))
      const file = journalOf(issue, 'r')
      await store.readRun(issue, 'r')
      const handle = await fs.open(file, 'r+')
      await handle.write(Buffer.from('['), 0, 1, 0)
      await handle.close()
      const later = new Date(Date.now() + 5000)
      await fs.utimes(file, later, later)
      const error = await refusal(() => store.appendEvent(issue, 'r', { type: 'after' }))
      t.eq('refused with corrupt-record', [error?.code, error?.journal?.status], ['EVENT_JOURNAL_RECOVERY_REQUIRED', 'corrupt-record'])
    }

    t.section('a record the parser would reject is refused before it is written')
    {
      const issue = path.join(root, 'invalid-record')
      await makeRun(issue, 'r', line('first'))
      const file = journalOf(issue, 'r')
      await store.readRun(issue, 'r')
      const before = await fs.readFile(file)
      t.eq('appendEvent({}) on a clean journal: EVENT_RECORD_INVALID', (await refusal(() => store.appendEvent(issue, 'r', {})))?.code, 'EVENT_RECORD_INVALID')
      t.ok('nothing written', (await fs.readFile(file)).equals(before))
      const w = watchJournal([file])
      try { await store.appendEvent(issue, 'r', { type: 'valid' }) } finally { w.restore() }
      t.eq('the trusted entry was kept: the next append is a hit', w.counts.readFile, 0)
      t.eq('an event that serializes to nothing (toJSON → undefined): EVENT_RECORD_INVALID',
        (await refusal(() => store.appendEvent(issue, 'r', { type: 'x', toJSON: () => undefined })))?.code, 'EVENT_RECORD_INVALID')
      await fs.appendFile(file, '{"type":')
      t.eq('appendEvent({}) on a torn journal: the journal refusal comes first', (await refusal(() => store.appendEvent(issue, 'r', {})))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    }

    t.section('a name replaced by a link to another, already trusted journal gets the full read')
    {
      const issue = path.join(root, 'replaced-by-link')
      const a = await makeRun(issue, 'a', line('a-first'))
      const b = await makeRun(issue, 'b', line('b-first') + line('b-second'))
      await store.readRun(issue, 'a')
      await store.readRun(issue, 'b')
      await fs.symlink(path.join(b, 'events.jsonl'), path.join(a, 'events.tmp'))
      await fs.rename(path.join(a, 'events.tmp'), path.join(a, 'events.jsonl'))
      const w = watchJournal([journalOf(issue, 'a')])
      try {
        await store.appendEvent(issue, 'a', { type: 'through-a' })
        t.eq('the append through the replaced name reads the whole journal', w.counts.readFile, 1)
        w.reset()
        await store.appendEvent(issue, 'a', { type: 'through-a-again' })
        t.eq('after that clean read the name is trusted: the next append is a hit', w.counts.readFile, 0)
      } finally { w.restore() }
    }

    t.section('a name switched A → B → C → back to B gets a full read at every switch')
    {
      const issue = path.join(root, 'switch-back')
      const a = await makeRun(issue, 'a', line('a-first'))
      const b = await makeRun(issue, 'b', line('b-first'))
      const c = await makeRun(issue, 'c', line('c-first') + line('c-second'))
      for (const run of ['a', 'b', 'c']) await store.readRun(issue, run)
      const pointAt = async (target) => {
        await fs.symlink(path.join(target, 'events.jsonl'), path.join(a, 'events.tmp'))
        await fs.rename(path.join(a, 'events.tmp'), path.join(a, 'events.jsonl'))
      }
      const w = watchJournal([journalOf(issue, 'a')])
      try {
        for (const [label, target] of [['B', b], ['C', c], ['back to B', b]]) {
          await pointAt(target)
          w.reset()
          await store.appendEvent(issue, 'a', { type: 'switched', to: label })
          t.eq(`switch to ${label}: the append through a reads the whole journal`, w.counts.readFile, 1)
          w.reset()
          await store.appendEvent(issue, 'a', { type: 'unchanged', to: label })
          t.eq(`switch to ${label}: the next unchanged append is a hit`, w.counts.readFile, 0)
        }
      } finally { w.restore() }
    }

    t.section('one hard-linked run\'s own recovery record does not evict the shared entry')
    {
      const issue = path.join(root, 'alias-refusal')
      const a = await makeRun(issue, 'a', line('first'))
      const b = await makeRun(issue, 'b')
      await fs.rm(path.join(b, 'events.jsonl'))
      await fs.link(path.join(a, 'events.jsonl'), path.join(b, 'events.jsonl'))
      await store.readRun(issue, 'a')
      await fs.writeFile(path.join(b, 'journal-recovery.json'), JSON.stringify({ recoveryRequired: true, message: 'b only' }))
      const w = watchJournal([journalOf(issue, 'a'), journalOf(issue, 'b')])
      try {
        for (const round of [1, 2]) {
          t.eq(`round ${round}: run b is refused for its own record`, (await refusal(() => store.requireCompleteEvents(issue, 'b')))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
          w.reset()
          await store.appendEvent(issue, 'a', { type: 'healthy', round })
          t.eq(`round ${round}: run a's next append is still a hit`, w.counts.readFile, 0)
        }
      } finally { w.restore() }
      t.eq('run a never got a recovery record', await exists(path.join(a, 'journal-recovery.json')), false)
    }

    t.section('bounded reads: a large last record, a large event, and owned tails')
    {
      const issue = path.join(root, 'large')
      await makeRun(issue, 'r', line('first') + line('huge', { pad: 'y'.repeat(2 * 1024 * 1024) }))
      const file = journalOf(issue, 'r')
      await store.readRun(issue, 'r')
      const seeded = await store.__journalCache.get(issue, 'r')
      t.eq('a 2 MiB seed keeps an owned 8 KiB tail', [seeded.tail.length, seeded.tail.buffer.byteLength], [8192, 8192])
      const w = watchJournal([file])
      try {
        for (const i of [1, 2]) {
          w.reset()
          await store.appendEvent(issue, 'r', { type: 'small', i })
          t.ok(`small append ${i} after a 2 MiB record: no full read, at most ${BOUND} bytes`, w.counts.readFile === 0 && w.counts.bytes <= BOUND, `${w.counts.readFile} full reads, ${w.counts.bytes} bytes`)
        }
        for (const size of [3 * 1024 * 1024, 8192, 8191]) {
          const base = Buffer.byteLength(JSON.stringify({ at: new Date().toISOString(), type: 'sized', pad: '' }) + NL)
          const event = { type: 'sized', pad: 'z'.repeat(size - base) }
          w.reset()
          const record = await store.appendEvent(issue, 'r', event)
          const written = Buffer.byteLength(JSON.stringify(record) + NL)
          const entry = await store.__journalCache.get(issue, 'r')
          const bytes = await fs.readFile(file)
          t.ok(`a ${written}-byte event on a full tail: no full read, within the bound`, w.counts.readFile === 0 && w.counts.bytes <= BOUND, `${w.counts.bytes} bytes`)
          t.ok(`a ${written}-byte event: the stored tail is exactly the file's last 8 KiB, in its own allocation`,
            !!entry && entry.tail.length === 8192 && entry.tail.buffer.byteLength === 8192 && entry.tail.equals(bytes.subarray(bytes.length - 8192)))
          w.reset()
          await store.appendEvent(issue, 'r', { type: 'after-sized' })
          t.eq(`after the ${written}-byte event the next append is a hit`, w.counts.readFile, 0)
        }
      } finally { w.restore() }
    }

    t.section('a clean read-only inspection seeds the entry; a damaged one writes nothing')
    {
      const issue = path.join(root, 'read-only')
      await makeRun(issue, 'r', line('first'))
      const file = journalOf(issue, 'r')
      t.eq('inspectJournalReadOnly: clean', (await store.inspectJournalReadOnly(issue, 'r')).clean, true)
      const w = watchJournal([file])
      try { await store.appendEvent(issue, 'r', { type: 'after-read-only' }) } finally { w.restore() }
      t.eq('the append after it is a hit (no second full parse)', w.counts.readFile, 0)
      await fs.appendFile(file, '{"type":')
      t.eq('inspectJournalReadOnly on a damaged journal: not clean', (await store.inspectJournalReadOnly(issue, 'r')).clean, false)
      t.eq('and it wrote no recovery finding', await exists(path.join(path.dirname(file), 'journal-recovery.json')), false)
      t.eq('the next append is refused as today', (await refusal(() => store.appendEvent(issue, 'r', { type: 'x' })))?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    }

    t.section('the post-append proof: a newline lost around our write is never trusted')
    {
      for (const when of ['before the write', 'after the write, before the proof']) {
        const issue = path.join(root, 'proof-' + when.replace(/[^a-z]+/g, '-'))
        await makeRun(issue, 'r', line('only'))
        const file = journalOf(issue, 'r')
        await store.readRun(issue, 'r')
        const size = (await fs.stat(file)).size
        const open = fs.open
        let appending = false, done = false
        const loseNewline = async () => {
          done = true
          const h = await open.call(fs, file, 'r+')
          await h.write(Buffer.from(' '), 0, 1, size - 1)
          await h.close()
        }
        fs.open = async (target, flags, ...rest) => {
          if (!done && path.resolve(String(target)) === path.resolve(file)) {
            if (flags === 'a') { appending = true; if (when === 'before the write') await loseNewline() }
            else if (appending && flags === 'r' && when !== 'before the write') await loseNewline()
          }
          return open.call(fs, target, flags, ...rest)
        }
        let error
        try { error = await refusal(() => store.appendEvent(issue, 'r', { type: 'big', pad: 'q'.repeat(9000) })) } finally { fs.open = open }
        t.eq(`${when}: that append completes, as today`, error, null)
        t.eq(`${when}: no entry is trusted`, await store.__journalCache.get(issue, 'r'), null)
        const next = await refusal(() => store.appendEvent(issue, 'r', { type: 'next' }))
        t.eq(`${when}: the next append gets the full read and corrupt-record`, [next?.code, next?.journal?.status], ['EVENT_JOURNAL_RECOVERY_REQUIRED', 'corrupt-record'])
      }
    }

    /*
     * A check or read started while this process's own append is half written
     * waits for it, through any name of the journal. The writer is released only
     * once the readers are queued on its chain (store.__journalCache.queued).
     */
    async function pausedCase (label, writer, reader, runDirs) {
      const pause = pauseAppend(journalOf(...writer))
      try {
        const appending = store.appendEvent(...writer, { type: 'paused-append' })
        await within(pause.paused, `${label}: the append reaching its write`)
        const torn = await fs.readFile(journalOf(...writer))
        t.ok(`${label}: the journal is really half written meanwhile`, torn[torn.length - 1] !== 10)
        const checking = store.requireCompleteEvents(...reader)
        const inspecting = store.inspectRunJournal(...reader)
        const loading = store.readRun(...reader)
        // A failure is reported once, through Promise.all below, never as an unhandled rejection.
        for (const p of [appending, checking, inspecting, loading]) p.catch(() => {})
        await queuedAtLeast(...writer, 4, `${label}: the readers joining the writer's chain`)
        pause.release()
        const [record, checked, inspected, run] = await within(Promise.all([appending, checking, inspecting, loading]), `${label}: everything settling`)
        t.ok(`${label}: appendEvent resolves to its record`, record.type === 'paused-append' && typeof record.at === 'string')
        t.eq(`${label}: requireCompleteEvents passes`, [checked.status, checked.complete], ['complete', true])
        t.ok(`${label}: inspectRunJournal is complete and ends with the record`, inspected.complete && !inspected.recoveryRequired &&
          JSON.stringify(inspected.events.at(-1)) === JSON.stringify(record))
        t.eq(`${label}: readRun reports no recovery`, [run.journal.complete, run.recovery?.required ?? false], [true, false])
        for (const dir of runDirs) t.eq(`${label}: no journal-recovery.json in ${path.basename(dir)}`, await exists(path.join(dir, 'journal-recovery.json')), false)
        t.ok(`${label}: one shared cache entry`, (await store.__journalCache.get(...writer)) === (await store.__journalCache.get(...reader)))
      } catch (error) {
        t.ok(label, false, error.message)
      } finally { pause.restore() }
    }

    t.section('appends, checks and reads take turns on one journal, by any name')
    {
      const same = path.join(root, 'same')
      const dir = await makeRun(same, 'r', line('first'))
      await store.readRun(same, 'r')
      await pausedCase('same path', [same, 'r'], [same, 'r'], [dir])

      const hard = path.join(root, 'hard')
      const a = await makeRun(hard, 'a', line('first'))
      const b = await makeRun(hard, 'b')
      await fs.rm(path.join(b, 'events.jsonl'))
      await fs.link(path.join(a, 'events.jsonl'), path.join(b, 'events.jsonl'))
      await store.readRun(hard, 'a')
      await pausedCase('hard link, append through a', [hard, 'a'], [hard, 'b'], [a, b])
      await pausedCase('hard link, append through b', [hard, 'b'], [hard, 'a'], [a, b])

      const leaf = path.join(root, 'leaf')
      const la = await makeRun(leaf, 'a', line('first'))
      const lb = await makeRun(leaf, 'b')
      await fs.rm(path.join(lb, 'events.jsonl'))
      await fs.symlink(path.join(la, 'events.jsonl'), path.join(lb, 'events.jsonl'))
      await store.readRun(leaf, 'a')
      await pausedCase('symlink at events.jsonl, append through a', [leaf, 'a'], [leaf, 'b'], [la, lb])
      await pausedCase('symlink at events.jsonl, append through b', [leaf, 'b'], [leaf, 'a'], [la, lb])

      const real = path.join(root, 'real-issue')
      const alias = path.join(root, 'alias-issue')
      const rd = await makeRun(real, 'r', line('first'))
      await fs.symlink(real, alias)
      await store.readRun(real, 'r')
      await pausedCase('symlinked issue directory', [real, 'r'], [alias, 'r'], [rd])
    }

    t.section('direct appends (as integration makes) interleave with engine persists')
    {
      const f = await engineFixture()
      const engine = await startRun({ issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses,
        stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, clock: f.clock,
        deliveryProvider: f.delivery, playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id }, probe: f.probe })
      try {
        await within(Promise.all([
          ...Array.from({ length: 10 }, (_, i) => engine.persist({ type: 'probe-engine', i })),
          ...Array.from({ length: 10 }, (_, i) => store.appendEvent(f.issuePath, engine.runId, { type: 'probe-direct', i }))
        ]), 'interleaved appends')
        const journal = await store.readEvents(f.issuePath, engine.runId)
        const seen = (type) => journal.events.filter((e) => e.type === type).map((e) => e.i).sort((x, y) => x - y)
        t.ok('every line complete', journal.complete && !journal.recoveryRequired)
        t.eq('each engine event once', seen('probe-engine'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        t.eq('each direct event once', seen('probe-direct'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

        const file = journalOf(f.issuePath, engine.runId)
        const pause = pauseAppend(file)
        try {
          const direct = store.appendEvent(f.issuePath, engine.runId, { type: 'paused-direct' })
          await within(pause.paused, 'direct append reaching its write')
          const persisting = engine.persist({ type: 'after-paused' })
          await queuedAtLeast(f.issuePath, engine.runId, 2, 'engine persist joining the chain')
          pause.release()
          await within(Promise.all([direct, persisting]), 'paused direct append and engine persist')
          const after = await store.readEvents(f.issuePath, engine.runId)
          t.ok('engine persist during a paused direct append succeeds; the journal ends with its event',
            after.complete && after.events.at(-1).type === 'after-paused')
          t.eq('no recovery finding', await exists(path.join(path.dirname(file), 'journal-recovery.json')), false)
        } finally { pause.restore() }
        const w = watchJournal([file])
        try { await engine.persist({ type: 'later' }) } finally { w.restore() }
        t.eq('later persists validate from the trusted entry', w.counts.readFile, 0)
      } finally { await releaseWorkspace(engine) }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
