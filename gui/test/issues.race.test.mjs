import fs from 'node:fs/promises'
import path from 'node:path'
import { acquire } from '../server/runtime/lock.mjs'
import { writeJson } from '../server/runtime/persistence.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * AC4: disposition and follow-up writes are serialized per issue, so a stale
 * read-modify-write never lands over newer state. Each contender is injected at
 * the rename that publishes the first writer's file (persistence.mjs
 * writeAtomic), which base and candidate both reach after their read. A
 * contender that may block on a lock is awaited only until it finishes or is
 * seen refused at the lock's link (EEXIST): no sleeps order anything.
 */
const P = 'devpanel-project'

function patch (name, hook) {
  const real = fs[name]
  fs[name] = (...args) => hook(args, real)
  return () => { fs[name] = real }
}

/** Resolves when a link to `lockFile` is refused because someone holds it. */
function blockedAt (lockFile) {
  let resolve
  const seen = new Promise((r) => { resolve = r })
  const restore = patch('link', async (args, real) => {
    try { return await real(...args) } catch (error) {
      if (error.code === 'EEXIST' && args[1] === lockFile) resolve()
      throw error
    }
  })
  return { seen, restore }
}

/** Run `contender` the first time `target` is renamed into place, before that rename lands. */
function atRename (target, contender) {
  let fired = 0
  const restore = patch('rename', async (args, real) => {
    if (!fired && args[1] === target) { fired++; await contender() }
    return real(...args)
  })
  return { restore, fired: () => fired }
}

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

export default async function (t) {
  const f = await engineFixture()

  async function settledRun (name, risks) {
    const issue = await f.issues.createIssue(P, { name })
    const runId = `2026-01-01T00-00-00-000Z-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`
    const runFile = path.join(issue.path, 'runs', runId, 'run.json')
    await writeJson(runFile, {
      runId, issue: { project: P, id: issue.id }, status: 'completed', outcome: 'resolved',
      closure: { revision: null, at: new Date().toISOString(), residualRisks: risks.map((description) => ({ description, accepted: false })) }
    })
    return { issue, runId, runFile, meta: path.join(issue.path, 'issue.json') }
  }

  t.section('R4a. a priority set while a disposition is being written is not lost')
  {
    const issue = await f.issues.createIssue(P, { name: 'Disposition against priority' })
    const meta = path.join(issue.path, 'issue.json')
    const lock = blockedAt(path.join(issue.path, '.step-alloc.lock'))
    let priority
    const seam = atRename(meta, async () => {
      priority = f.issues.setIssuePriority(P, issue.id, { value: 'high', reason: 'set meanwhile' })
      await Promise.race([priority.catch(() => {}), lock.seen])
    })
    try {
      await f.issues.setIssueDisposition(P, issue.id, { value: 'declined', evidence: 'checked' })
      await priority
    } finally { seam.restore(); lock.restore() }
    t.eq('the seam ran once', seam.fired(), 1)
    const after = await readJson(meta)
    t.eq('both the disposition and the priority are on the record', [after.disposition?.value ?? null, after.priority?.value ?? null], ['declined', 'high'])
  }

  t.section('R4b. a run.json writer holding the run lock is never overwritten by follow-ups')
  {
    const s = await settledRun('Follow-ups against a run writer', ['risk one'])
    let w = null
    const seam = atRename(s.runFile, async () => {
      // W: any writer of run.json, under the issue's run lock as the engine and integration write it.
      try {
        const lock = await acquire(path.join(s.issue.path, '.run.lock'), { purpose: 'w' })
        try {
          const run = await readJson(s.runFile)
          await writeJson(s.runFile, { ...run, marker: 'W' })
          w = 'wrote'
        } finally { await lock.release() }
      } catch (error) { w = `refused: ${error.message}` }
    })
    let made
    try { made = await f.issues.createFollowUps(P, s.issue.id, s.runId).catch((error) => error) } finally { seam.restore() }
    t.eq('the seam ran once', seam.fired(), 1)
    const after = await readJson(s.runFile)
    t.ok('a write W made is still there', w !== 'wrote' || after.marker === 'W', `W ${w}; marker ${after.marker ?? 'missing'}`)
    t.eq('the follow-ups are recorded', [made?.followUps?.length ?? null, after.closure.followUps?.length ?? 0], [1, 1])
  }

  t.section('R4c. a disposition accepting a risk waits for follow-ups reading the accepted risks')
  {
    const s = await settledRun('Follow-ups against a disposition', ['risk one', 'risk two'])
    const lock = blockedAt(path.join(s.issue.path, '.step-alloc.lock'))
    const order = []
    let disposition
    const seam = atRename(s.runFile, async () => {
      disposition = f.issues.setIssueDisposition(P, s.issue.id, { value: 'partially-resolved', evidence: 'checked', runId: s.runId, acceptRisks: [{ text: 'risk two', reason: 'acceptable' }] })
        .then(() => order.push('disposition written'))
      await Promise.race([disposition, lock.seen])
    })
    try {
      await f.issues.createFollowUps(P, s.issue.id, s.runId)
      order.push('follow-ups written')
      await disposition
    } finally { seam.restore(); lock.restore() }
    t.eq('the seam ran once', seam.fired(), 1)
    t.eq('the disposition lands only after the follow-ups\' read-modify-write', order, ['follow-ups written', 'disposition written'])
  }

  t.section('R4d. follow-ups are refused while a run of the issue holds the run lock, and write nothing')
  {
    const s = await settledRun('Follow-ups while the run lock is held', ['risk one'])
    const before = await fs.readFile(s.runFile, 'utf8')
    const lock = await acquire(path.join(s.issue.path, '.run.lock'), { purpose: 'run', runId: 'another' })
    let refused
    try { refused = await f.issues.createFollowUps(P, s.issue.id, s.runId).then(() => null, (error) => error) } finally { await lock.release() }
    t.eq('refused with 409', refused?.status ?? null, 409)
    t.ok('run.json is unchanged', await fs.readFile(s.runFile, 'utf8') === before)
  }

  await cleanupFixtures()
}
