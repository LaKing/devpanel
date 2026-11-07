import { io } from 'socket.io-client'
import { reactive, readonly, watch } from 'vue'

import { authToken, hasProxyLogin, markRejected } from '@/auth'

/**
 * One socket for the whole app. Components read `connection` and never touch the
 * socket directly, so there is a single place where server events land.
 */
const state = reactive({
  status: 'connecting', // 'connecting' | 'online' | 'offline'
  attempts: 0,
  latency: null,
  host: null,
  version: null,
  tickMs: 2000,
  metrics: null,
  updatedAt: null,
  /* Whether the process answering is older than the code on disk — the reason a
     freshly built page can call a route the server has never heard of. */
  source: null,
  /* The last `verification:changed` event of the daily full verification: the
     dashboard card and the verification page reload when it moves. */
  verification: null,
  error: null
})

// No URL: connect back to the origin that served the page. In dev that is the
// Vite server, which proxies /socket.io through to the Node backend.
// The socket carries run events, so it authenticates like the API. It stays
// closed until a token or a verified proxy login exists, rather than hammering the
// server with refusals. The proxy login rides on the browser's own Basic header.
export const socket = io({
  path: '/socket.io',
  transports: ['websocket', 'polling'],
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 8000,
  autoConnect: false,
  auth: (cb) => cb({ token: authToken.value })
})

function connectWithToken () {
  if (!authToken.value && !hasProxyLogin.value) { socket.disconnect(); return }
  socket.disconnect()
  socket.connect()
}

watch([authToken, hasProxyLogin], connectWithToken, { immediate: true })

socket.on('connect', () => {
  state.status = 'online'
  state.attempts = 0
  state.error = null
  measureLatency()
})

socket.on('disconnect', (reason) => {
  state.status = 'offline'
  state.latency = null
  state.error = reason
})

socket.io.on('reconnect_attempt', (attempt) => {
  state.status = 'connecting'
  state.attempts = attempt
})

socket.on('connect_error', (err) => {
  state.status = 'offline'
  state.error = err.message
  // A refused handshake is an auth problem, not a network one.
  if (/unauthoris|unauthoriz/i.test(err.message)) {
    markRejected()
    socket.disconnect()
  }
})

socket.on('hello', (payload) => {
  state.host = payload.host
  state.version = payload.version ?? null
  state.tickMs = payload.tickMs
  applyMetrics(payload.metrics)
})

socket.on('metrics', applyMetrics)
socket.on('verification:changed', (event) => { state.verification = { ...event, at: Date.now() } })

function applyMetrics (metrics) {
  if (!metrics) return
  state.metrics = metrics
  if (metrics.source) state.source = metrics.source
  state.updatedAt = Date.now()
}

function measureLatency () {
  const sentAt = Date.now()
  socket.timeout(5000).emit('ping:check', sentAt, (err, echoed) => {
    if (err || echoed !== sentAt) return
    state.latency = Date.now() - sentAt
  })
}

// Keep the latency reading fresh without spamming the server.
setInterval(() => {
  if (state.status === 'online') measureLatency()
}, 10_000)

export const connection = readonly(state)
