import { reactive } from 'vue'

import { api } from '@/api'
import { socket } from '@/socket'

/*
 * What the panel is doing, for the app bar: live runs and their agents, what
 * is waiting on a person, and where the supervisor stands. One store, one set
 * of requests, however many widgets read it.
 *
 * Refreshed when something changes (socket events, debounced) and on a slow
 * poll for runs another process drives. Output chunks and activity pings
 * change nothing here and are ignored. A failed refresh keeps the last
 * reading: a missed poll is not evidence that everything stopped.
 */

export const panel = reactive({ runs: [], attention: [], supervisor: null, loaded: false, error: '' })

let users = 0
let poller = null
let pending = null
// A server that predates /api/supervisor/status (not yet restarted) is read
// through the full endpoint, less often.
let fullSupervisor = false
let lastFull = 0

async function supervisorStatus () {
  if (!fullSupervisor) {
    try {
      const brief = await api.supervisorStatus()
      if (brief && typeof brief.status === 'string') return brief
      fullSupervisor = true
    } catch (err) { if (err.status !== 404) throw err; fullSupervisor = true }
  }
  if (Date.now() - lastFull < 30_000 && panel.supervisor) return panel.supervisor
  lastFull = Date.now()
  const s = await api.supervisor()
  const last = (s.messages ?? []).findLast((m) => m.role === 'assistant')
  return { status: s.status, finishing: Boolean(s.finishing), reason: s.reason ?? null, model: s.model?.title ?? s.model?.id ?? null, pending: s.pending?.kind ?? null,
    calls: s.calls ?? 0, starts: s.starts ?? 0, limits: s.limits ?? {}, costUsd: s.costUsd ?? 0, cost: s.cost ?? null, ownedRuns: (s.ownedRuns ?? []).length, last: last ? { text: String(last.text ?? '').slice(0, 280), at: last.at } : null }
}

async function load () {
  const [runs, attention, supervisor] = await Promise.allSettled([api.listAgents(), api.listAttention(), supervisorStatus()])
  if (runs.status === 'fulfilled') panel.runs = runs.value
  if (attention.status === 'fulfilled') panel.attention = attention.value
  if (supervisor.status === 'fulfilled') panel.supervisor = supervisor.value
  const failed = [runs, attention, supervisor].find((r) => r.status === 'rejected')
  panel.error = failed ? failed.reason?.message ?? 'refresh failed' : ''
  panel.loaded = true
}

function onChange (payload) {
  if (payload?.type === 'live' || payload?.type === 'activity') return
  clearTimeout(pending)
  pending = setTimeout(load, 300)
}

/** Start following (counted); returns the function that stops. */
export function followPanel () {
  if (users++ === 0) {
    load()
    poller = setInterval(load, 10_000)
    socket.on('run:event', onChange)
    socket.on('issues:changed', onChange)
    socket.on('supervisor:changed', onChange)
    socket.on('connect', load)
  }
  return () => {
    if (--users > 0) return
    clearInterval(poller)
    clearTimeout(pending)
    socket.off('run:event', onChange)
    socket.off('issues:changed', onChange)
    socket.off('supervisor:changed', onChange)
    socket.off('connect', load)
  }
}
