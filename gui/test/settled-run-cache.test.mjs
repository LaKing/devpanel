import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { settledRunCache } from '../server/settled-run-cache.mjs'

export const name = 'settled run cache — the supervisor\'s monitoring reads a settled run again only when its record or its issue changed'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-settled-'))
  const issuePath = path.join(dir, 'issue-a')
  const runFile = path.join(issuePath, 'runs', 'r1', 'run.json')
  const issueFile = path.join(issuePath, 'issue.json')
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)) }
  try {
    await write(issueFile, { id: 'issue-a' })
    await write(runFile, { runId: 'r1', status: 'completed', outcome: 'resolved' })
    let reads = 0, locates = 0, active = false, packed = false, clock = 1_000_000
    const detail = settledRunCache({
      locate: async () => { locates++; return { path: issuePath, packed } },
      // A packed issue has no run folder: its record comes from the bundle.
      read: async (issue, project, issueId, runId) => { reads++; return issue.packed ? { runId, status: 'completed', packed: true } : { ...JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8')), nested: { list: [1] } } },
      isActive: () => active, keepMs: 60_000, now: () => clock
    })
    const get = () => detail('p', 'issue-a', 'r1')

    t.section('a settled run is read once and answered from what was kept')
    const first = await get()
    for (let i = 0; i < 20; i++) await get()
    t.eq('twenty more calls read nothing', [reads, locates], [1, 1])
    const again = await get()
    t.eq('the answer is the same', again, first)
    again.nested.list.push(2); again.status = 'changed by the caller'
    t.eq('and a copy: what a caller does to it reaches nobody else', (await get()), first)

    t.section('a write to the run\'s record, or to its issue\'s, is seen at the next call')
    await write(runFile, { runId: 'r1', status: 'completed', outcome: 'resolved', landed: { by: 'owner' } })
    t.eq('the landing recorded on the run', [(await get()).landed, reads], [{ by: 'owner' }, 2])
    await get()
    t.eq('kept again afterwards', reads, 2)
    await write(issueFile, { id: 'issue-a', disposition: { state: 'resolved' } })
    await get()
    t.eq('a disposition written on the issue reads the run again', reads, 3)

    t.section('nothing is kept longer than the limit')
    clock += 59_000
    await get()
    t.eq('within it: kept', reads, 3)
    clock += 2_000
    await get()
    t.eq('past it: read again', reads, 4)

    t.section('what can still move is never kept')
    for (const status of ['running', 'pending', 'preflighting', 'stopping', 'paused']) {
      await write(runFile, { runId: 'r1', status })
      const before = reads
      await get(); await get()
      t.eq(`${status}: read every time`, reads - before, 2)
    }
    await write(runFile, { runId: 'r1', status: 'blocked', blockedReason: 'source-delivery-blocked', reconcilePending: true })
    let before = reads
    await get(); await get()
    t.eq('an undecided automatic reconcile: read every time', reads - before, 2)
    await write(runFile, { runId: 'r1', status: 'blocked', blockedReason: 'source-delivery-blocked' })
    await get()
    active = true
    before = reads
    await get(); await get()
    t.eq('a run the run supervisor holds active (a finalize in flight): read every time, kept entry or not', reads - before, 2)
    active = false

    t.section('a packed issue and a missing run answer as they did')
    await get(); before = reads
    packed = true
    await fs.rm(path.join(issuePath, 'runs'), { recursive: true })
    const fromBundle = await get(); await get()
    t.eq('the folder is gone (packed): the kept entry is dropped and the bundle read each time', [reads - before, fromBundle.packed], [2, true])
    packed = false
    const gone = settledRunCache({ locate: async () => ({ path: issuePath, packed: false }), read: async () => { throw Object.assign(new Error('no such run'), { status: 404 }) } })
    t.eq('a run that is gone still answers 404', (await gone('p', 'issue-a', 'r1').catch((e) => e)).status, 404)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
