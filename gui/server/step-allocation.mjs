import fs from 'node:fs/promises'
import path from 'node:path'
import { withIssueLock } from './issue-locks.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { requireUnarchived } from './issue-archive.mjs'

// The issue's step lock is the issue-level lock pack, restore and delete hold for their
// whole operation (issue-locks.mjs). Never created: a folder that went refuses (ISSUE_MOVED),
// a lifecycle operation holding it refuses (ISSUE_BUSY), both retryable. `held` is only for
// a caller that already holds it (restore turning kept notes into steps).
export async function withStepReservation (dir, {slug, invocationId = null, onReserve = null, origin = null, waitMs = 10000, held = false}, write) {
  if (origin !== null && !['agent-turn','external-report','human-input'].includes(origin)) throw new Error('Invalid step origin')
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid step slug')
  const locked = held ? (fn) => fn() : (fn) => withIssueLock(path.join(dir,'.step-alloc.lock'),{purpose:'step-allocation',waitMs},fn)
  return locked(async()=>{
    await requireUnarchived(dir)
    const file=path.join(dir,'.step-reservations.json')
    let reservations
    try { reservations=JSON.parse(await fs.readFile(file,'utf8')) } catch(e){if(e.code!=='ENOENT')throw e;reservations=[]}
    if (!Array.isArray(reservations) || reservations.some(r => !r || !/^\d{3}$/.test(String(r.number)) || !new RegExp(`^${r.number}-[a-z0-9-]+$`).test(r.folder ?? ''))) throw new Error('Invalid step reservations')
    let entry=invocationId ? reservations.find(r=>r.invocationId===invocationId) : null
    if (!entry) {
      const numbers=(await fs.readdir(dir)).map(n=>/^(\d{3})-/.exec(n)?.[1]).filter(Boolean).map(Number)
      const number=String(Math.max(-1,...numbers,...reservations.map(r=>Number(r.number)))+1).padStart(3,'0')
      if(number.length>3)throw Object.assign(new Error('this issue has run out of step numbers'),{status:409})
      entry={...(origin ? {origin} : {}),number,folder:`${number}-${slug}`,invocationId,at:new Date().toISOString()}
      reservations.push(entry);await writeJson(file,reservations)
      if(onReserve)await onReserve(entry)
    }
    return write(entry)
  })
}
