import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { proxyLogin } from './proxy-user.mjs'
import { tokenFile as tokenFileFor } from './project-path.mjs'

/*
 * A shared bearer token guarding the API and the socket.
 *
 * This exists because run data is not metadata: an agent response can quote the
 * project's source, a prompt can carry an excerpt of it, and a delivery artifact
 * is a patch. Exposing those over an unauthenticated port publishes the code.
 *
 * The token is stored server-side, generated on first start if absent, and never
 * sent to the browser except by the operator pasting it in.
 */

const TOKEN_FILE = tokenFileFor()

let cached = null

/** Read the token, generating one on first start. Owner-readable only. */
export async function loadToken () {
  if (cached) return cached

  if (process.env.DEVPANEL_TOKEN) {
    cached = process.env.DEVPANEL_TOKEN.trim()
    return cached
  }

  try {
    const existing = (await fs.readFile(TOKEN_FILE, 'utf8')).trim()
    if (existing) { cached = existing; return cached }
  } catch { /* generate below */ }

  const token = crypto.randomBytes(32).toString('base64url')
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 })
  await fs.writeFile(TOKEN_FILE, token + String.fromCharCode(10), { mode: 0o600 })
  await fs.chmod(TOKEN_FILE, 0o600)
  cached = token
  return cached
}

export const tokenFile = () => TOKEN_FILE
export const resetTokenCache = () => { cached = null }

/** Constant-time compare, so a wrong token cannot be discovered by timing. */
function matches (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

/*
 * The browser sends the token in X-Devpanel-Token, never in Authorization: a request
 * carries one Authorization header, and when a proxy in front (a reverse proxy's basic auth)
 * owns it, a Bearer header set by fetch() replaces the browser's Basic credentials and
 * the proxy refuses every API call. Bearer stays accepted for direct clients (the
 * devpanel skill, tests) that reach the server without that proxy.
 */
function presented (req) {
  const own = req.headers?.['x-devpanel-token']
  if (typeof own === 'string' && own) return own.trim()
  const header = req.headers?.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  return null
}

/**
 * Guard every route except the explicitly public ones.
 *
 * /api/health is public on purpose — it reports liveness and nothing else, and a
 * health check that needs a credential is not much of a health check.
 * A verified reverse-proxy basic-auth login (req.login, set by proxy-user.mjs identify()
 * mounted before this) admits a request like the token does.
 */
export function requireToken (token, { publicPaths = ['/api/health'] } = {}) {
  return (req, res, next) => {
    if (publicPaths.includes(req.path)) return next()
    if (matches(presented(req), token) || req.login?.verified) return next()
    res.status(401).json({ error: 'a bearer token is required', hint: 'the operator can find it in .devpanel-token' })
  }
}

/** The same check for a socket handshake; `local` is server/local-login.mjs's admission, when enabled. */
export function socketAuth (token, { local = null } = {}) {
  return (socket, next) => {
    const offered = socket.handshake?.auth?.token ?? null
    if (matches(offered, token)) return next()
    if (local?.admits(socket.handshake?.headers)) return next()
    proxyLogin(socket.handshake?.headers).then((login) => {
      if (login?.verified) return next()
      const error = new Error('unauthorised')
      error.data = { reason: 'a bearer token is required' }
      next(error)
    }, next)
  }
}
