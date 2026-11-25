import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '../server/runtime/store.mjs'
import { writeExclusive } from '../server/runtime/persistence.mjs'

export default async function (t) {
  const issue = await fs.mkdtemp(path.join(os.tmpdir(), 'event-journal-'))
  const dir = store.runDir(issue, 'run')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'events.jsonl')
  const prefix = '{"type":"approval","at":"2026-09-13","note":"é"}\n'
  try {
    await fs.writeFile(file, prefix + '{"type":')
    const result = await store.readEvents(issue, 'run')
    t.eq('truncated append preserves preceding valid approval', (result.events ?? result).length, 1)
    t.eq('incomplete final append is explicit', result.status, 'incomplete-tail')
    t.eq('partial history requires recovery', result.recoveryRequired, true)
    t.eq('interpretation stops on the second line', result.stoppedAt?.line, 2)
    t.eq('stop offset counts bytes, not characters', result.stoppedAt?.byteOffset, Buffer.byteLength(prefix))
    for (const [label, suffix, expected] of [
      ['middle corruption', 'broken\n{"type":"delivery","at":"later"}\n', 'corrupt-record'],
      ['terminated malformed last line', '{"type":\n', 'corrupt-record'],
      ['invalid final token', 'garbage', 'corrupt-tail'],
      ['valid JSON missing append delimiter', '{"type":"delivery","at":"later"}', 'incomplete-tail'],
      ['blank record', '\n', 'corrupt-record'],
      ['non-event JSON', 'null\n', 'corrupt-record']
    ]) {
      await fs.writeFile(file, prefix + suffix)
      const journal = await store.readEvents(issue, 'run')
      t.eq(`${label}: prefix retained without skipping ahead`, journal.events.length, 1)
      t.eq(`${label}: classified explicitly`, journal.status, expected)
      t.eq(`${label}: recovery required`, journal.recoveryRequired, true)
    }
    await fs.writeFile(file, Buffer.concat([Buffer.from(prefix), Buffer.from([0xff, 10])]))
    t.eq('invalid UTF-8 is corruption', (await store.readEvents(issue, 'run')).status, 'corrupt-record')
    // Independent healthy-journal fixture, not a repair of the damaged run.
    await fs.rm(path.join(dir, 'journal-recovery.json'))
    await fs.writeFile(file, prefix)
    t.eq('complete history remains authoritative', (await store.readEvents(issue, 'run')).complete, true)
    await fs.writeFile(file, '')
    t.eq('explicit empty journal is complete', (await store.readEvents(issue, 'run')).status, 'complete')
    await fs.rm(file)
    t.eq('missing journal is distinguished from empty', (await store.readEvents(issue, 'run')).status, 'missing')
    await fs.mkdir(file)
    t.eq('I/O failures are explicit', (await store.readEvents(issue, 'run')).status, 'unreadable')
    await fs.rmdir(file)
    await fs.writeFile(file, prefix + '{"type":')
    let failure
    try { await store.appendEvent(issue, 'run', { type: 'delivery' }) } catch (error) { failure = error }
    t.eq('append refuses a damaged journal', failure?.code, 'EVENT_JOURNAL_RECOVERY_REQUIRED')
    t.eq('failed append preserves original evidence', await fs.readFile(file, 'utf8'), prefix + '{"type":')
    await fs.writeFile(file, prefix)
    t.eq('merely truncating to a valid prefix cannot clear recovery', (await store.inspectRunJournal(issue, 'run')).recoveryRequired, true)
    await fs.writeFile(path.join(dir, 'journal-recovery.json'), '{')
    const unreadableFinding = await store.readEvents(issue, 'run')
    t.eq('damaged recovery metadata retains the readable prefix', unreadableFinding.events.length, 1)
    t.eq('damaged recovery metadata cannot clear recovery', unreadableFinding.recoveryRequired, true)
    t.ok('damaged recovery metadata is explicitly identified', unreadableFinding.message.includes('recovery record is unreadable'))
      // A journal finding is published exclusively, so concurrent first readers agree on one detectedAt.
    const once = path.join(dir, 'exclusive.json')
    await writeExclusive(once, 'first')
    let clash = null
    try { await writeExclusive(once, 'second') } catch (error) { clash = error.code }
    t.eq('a second exclusive write is refused', clash, 'EEXIST')
    t.eq('and the first bytes stay', await fs.readFile(once, 'utf8'), 'first')
    t.eq('no temporary file is left behind', (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')).length, 0)
  } finally { await fs.rm(issue, { recursive: true, force: true }) }
}
