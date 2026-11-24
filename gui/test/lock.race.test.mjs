import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquire, currentOwner } from '../server/runtime/lock.mjs'

/*
 * AC3: a release, and the cleanup of a dead takeover gate, remove a lock only
 * under the gate after checking the token there. Each interleaving is injected
 * at a one-shot fs seam that base and candidate both reach; no sleeps order it.
 */

/** Wrap fs[name] until restored; `hook(args, real)` decides what the call does. */
function patch (name, hook) {
  const real = fs[name]
  fs[name] = (...args) => hook(args, real)
  return () => { fs[name] = real }
}

const tokenAt = (file) => fs.readFile(file, 'utf8').then((text) => JSON.parse(text).token, () => null)

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-lock-race-'))
  const dead = { ...(await currentOwner()), pid: 999999, processStartedAt: '1' }
  try {
    t.section('R3a. a release never deletes the lock of an owner who took over between its check and its unlink')
    {
      const file = path.join(dir, 'r3a.lock')
      const a = await acquire(file, { purpose: 'a' })
      let armed = false
      let fired = 0
      let b = null
      const restore = patch('readFile', async (args, real) => {
        const result = await real(...args)
        if (armed && args[0] === file) {
          armed = false
          fired++
          // B treats A's live lock as stale (its run ended) and takes it over,
          // right after A has read its own token back.
          b = await acquire(file, { purpose: 'b', stale: async (held) => held.token === a.token }).catch((error) => error)
        }
        return result
      })
      let released
      try {
        armed = true
        released = await a.release()
      } finally { restore() }
      t.eq('the seam ran once, inside the release', fired, 1)
      const bAcquired = Boolean(b?.token)
      const now = await tokenAt(file)
      t.ok('a lock B acquired is still B\'s after A\'s release', !bAcquired || now === b.token, `B ${bAcquired ? 'acquired' : `refused (${b?.message})`}; lock now ${now}; release returned ${released}`)
      if (bAcquired) await fs.rm(file, { force: true })
      t.ok('no gate is left behind', !await fs.stat(`${file}.takeover`).then(() => true, () => false))
    }

    t.section('R3b. a dead gate\'s cleanup never deletes a gate a live contender published after it looked')
    {
      const file = path.join(dir, 'r3b.lock')
      const gate = `${file}.takeover`
      await fs.writeFile(file, JSON.stringify({ purpose: 'run', token: 'dead-lock', owner: dead }))
      await fs.writeFile(gate, JSON.stringify({ purpose: 'takeover', token: 'dead-gate', owner: dead }))
      let reads = 0
      let fired = 0
      let c = null
      let dPublished = false
      const dToken = crypto.randomUUID()
      const restore = patch('readFile', async (args, real) => {
        const result = await real(...args)
        // The second read of the gate is the one a cleaner removes on: base reads it
        // again before its unlink, the candidate reads it under <gate>.takeover.
        if (args[0] === gate && ++reads === 2 && !fired) {
          fired++
          // C cleans the dead gate through the real code and takes the lock over;
          // then D, a live contender, publishes its gate the way createWith does.
          c = await acquire(file, { purpose: 'c' }).catch((error) => error)
          const temp = `${gate}.d.tmp`
          await fs.writeFile(temp, JSON.stringify({ purpose: 'takeover', token: dToken, owner: await currentOwner() }))
          dPublished = await fs.link(temp, gate).then(() => true, () => false)
          await fs.rm(temp, { force: true })
        }
        return result
      })
      let x
      try {
        x = await acquire(file, { purpose: 'x' }).catch((error) => error)
      } finally { restore() }
      t.eq('the seam ran once, inside the cleanup', fired, 1)
      const now = await tokenAt(gate)
      t.ok('a gate D published is still D\'s after the cleanup', !dPublished || now === dToken, `D ${dPublished ? 'published' : 'was refused'}; gate now ${now}`)
      for (const h of [x, c]) if (h?.token) await h.release()
      await fs.rm(gate, { force: true })
      await fs.rm(file, { force: true })
    }

    t.section('R3c. regression guards: a dead gate does not stop a release; a removed folder is not brought back')
    {
      const file = path.join(dir, 'r3c.lock')
      const a = await acquire(file, { purpose: 'a' })
      await fs.writeFile(`${file}.takeover`, JSON.stringify({ purpose: 'takeover', token: 'dead-gate', owner: dead }))
      t.eq('the release succeeds', await a.release(), true)
      t.ok('and the lock is gone', await tokenAt(file) === null)
      await fs.rm(`${file}.takeover`, { force: true })

      const gone = path.join(dir, 'gone')
      const b = await acquire(path.join(gone, 'run.lock'), { purpose: 'b' })
      await fs.rm(gone, { recursive: true, force: true })
      t.eq('a release in a removed folder reports nothing released', await b.release(), false)
      t.ok('and creates nothing', !await fs.stat(gone).then(() => true, () => false))
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
