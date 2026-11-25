/*
 * One viewer's subscription to an invocation's live output, on the panel's
 * single socket. The server sends a chunk only to sockets in that invocation's
 * room (server/live-rooms.mjs). Several viewers of one invocation can share a
 * socket, so membership is counted per socket and key: the room is left only
 * when the last viewer lets go.
 *
 * Free of Vue: the live-follow core and the transport test use it with a real
 * socket.io client.
 */

const held = new WeakMap() // socket -> Map(key -> count)

/** `target` is `{ scope: 'run', project, issueId, runId, invocationId }` or `{ scope: 'supervisor', invocationId }`. */
export function liveChannel (socket, target) {
  const payload = target.scope === 'supervisor'
    ? { scope: 'supervisor', invocationId: target.invocationId }
    : { scope: 'run', project: target.project, issueId: target.issueId, runId: target.runId, invocationId: target.invocationId }
  const key = JSON.stringify(payload)
  let counted = false
  const off = []
  const counts = () => { let m = held.get(socket); if (!m) { m = new Map(); held.set(socket, m) } return m }

  const matches = (event) => event?.type === 'live' && event.invocationId === payload.invocationId &&
    (payload.scope === 'supervisor' || (event.runId === payload.runId && event.issueId === payload.issueId && event.project === payload.project))

  return {
    payload,
    /** Join the room; resolves with the server's ack ({ ok }). Safe to repeat (a reconnect re-joins). */
    subscribe () {
      if (!counted) { counted = true; counts().set(key, (counts().get(key) ?? 0) + 1) }
      return new Promise((resolve) => socket.emit('live:subscribe', payload, (ack) => resolve(ack ?? { ok: false, error: 'no answer' })))
    },
    unsubscribe () {
      if (!counted) return
      counted = false
      const left = (counts().get(key) ?? 1) - 1
      if (left > 0) { counts().set(key, left); return }
      counts().delete(key)
      socket.emit('live:unsubscribe', payload)
    },
    /** `fn(event)` for each of this invocation's chunks: `{ entry, prev }`. */
    onEntry (fn) {
      const name = payload.scope === 'supervisor' ? 'supervisor:live' : 'run:event'
      const handler = (event) => { if (matches(event)) fn(event) }
      socket.on(name, handler)
      off.push(() => socket.off(name, handler))
    },
    onConnect (fn) {
      socket.on('connect', fn)
      off.push(() => socket.off('connect', fn))
    },
    close () {
      this.unsubscribe()
      for (const f of off.splice(0)) f()
    }
  }
}
