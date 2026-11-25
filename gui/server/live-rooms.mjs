import { clipForDelivery } from './runtime/store.mjs'

/*
 * Live output goes only to the sockets watching that invocation.
 *
 * A viewer joins a socket.io room per invocation (`live:subscribe`, acked) and
 * leaves it on close, hide or switch (`live:unsubscribe`); socket.io drops a
 * disconnected socket from every room. Every other event is still broadcast.
 *
 * A room is named by the exact ids the event carries, so it matches whatever
 * the routes accept (a project name with spaces, a full-verification run home):
 * nothing here is a naming rule, and a room name never reaches the filesystem.
 * Subscribing grants nothing a socket did not already have: only authenticated
 * sockets get this far, and before this they received every chunk.
 */

export const MAX_LIVE_ROOMS = 64
const MAX_ID = 512

const okId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && !v.includes('\0')

export const runRoom = (project, issueId, runId, invocationId) => `live:run:${JSON.stringify([project, issueId, runId, invocationId])}`
export const supervisorRoom = (invocationId) => `live:sup:${invocationId}`

/** The room a subscribe payload names, or null when it is malformed. */
export function roomFor (payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.scope === 'supervisor') return okId(payload.invocationId) ? supervisorRoom(payload.invocationId) : null
  if (payload.scope !== 'run') return null
  const { project, issueId, runId, invocationId } = payload
  return [project, issueId, runId, invocationId].every(okId) ? runRoom(project, issueId, runId, invocationId) : null
}

/** Answer a socket's subscribe and unsubscribe requests. */
export function attachLiveRooms (socket) {
  const ack = (fn, value) => { if (typeof fn === 'function') fn(value) }
  socket.on('live:subscribe', (payload, fn) => {
    const room = roomFor(payload)
    if (!room) return ack(fn, { ok: false, error: 'invalid subscription' })
    const held = [...socket.rooms].filter((r) => r.startsWith('live:')).length
    if (!socket.rooms.has(room) && held >= MAX_LIVE_ROOMS) return ack(fn, { ok: false, error: `at most ${MAX_LIVE_ROOMS} live subscriptions per connection` })
    socket.join(room)
    ack(fn, { ok: true })
  })
  socket.on('live:unsubscribe', (payload, fn) => {
    const room = roomFor(payload)
    if (room) socket.leave(room)
    ack(fn, { ok: Boolean(room) })
  })
}

/** A run event's live chunk, to its room only; clipped like an HTTP page so no frame carries an oversized entry. */
export function deliverRunLive (io, event) {
  io?.to(runRoom(event.project, event.issueId, event.runId, event.invocationId)).emit('run:event', { ...event, entry: clipForDelivery(event.entry) })
}

export function deliverSupervisorLive (io, event) {
  io?.to(supervisorRoom(event.invocationId)).emit('supervisor:live', { ...event, entry: clipForDelivery(event.entry) })
}
