import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import path from 'node:path'

import { hostSettings } from './config/host-settings.mjs'

/*
 * The person behind a request: the reverse proxy's basic-auth login, verified here.
 *
 * A reverse proxy with HTTP basic auth asks the browser for a login and forwards
 * the `Authorization: Basic` header unchanged. The panel does not trust that
 * header because of where it came from — seats reach the host network, and a
 * header is trivial to forge (no localhost exemption). It checks the password
 * itself against what the proxy publishes read-only in a users directory,
 * <usersDir>/<u>/: each digest file (host settings proxyLogin.digestFiles,
 * default `.hash`) holds the SHA-512 hex of a password that admits the user, and
 * a plaintext `.password` counts too (see expectedDigests: any one admits). A
 * verified login is worth the bearer token (auth.mjs). Nothing here writes.
 *
 * The users directory is DEVPANEL_USERS_DIR, else the host settings'
 * proxyLogin.usersDir. Without one (a dev machine, a proxy that publishes
 * nothing) the name is still used as the actor, but unverified: attribution
 * only, the token is still required.
 */

const defaultUsersDir = () => process.env.DEVPANEL_USERS_DIR ?? hostSettings().proxyLogin.usersDir
const defaultDigestFiles = () => hostSettings().proxyLogin.digestFiles
// A conservative user name: letters, digits, dot, underscore and dash, at most 64.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA512_HEX = /^[0-9a-f]{128}$/i

const sha512 = (text) => crypto.createHash('sha512').update(text, 'utf8').digest()

/** `Authorization: Basic` → {user, password}, split at the first colon (RFC 7617), or null. */
export function parseBasic (header) {
  const match = /^basic\s+([A-Za-z0-9+/]+=*)\s*$/i.exec(header ?? '')
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  const user = decoded.slice(0, colon)
  return NAME.test(user) ? { user, password: decoded.slice(colon + 1) } : null
}

// A small regular file, never through a symlink (the user directory is checked with lstat by the caller).
async function readSmall (file) {
  let handle
  try { handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK) } catch { return null }
  try {
    const stat = await handle.stat()
    return stat.isFile() && stat.size <= 4096 ? await handle.readFile('utf8') : null
  } catch { return null } finally { await handle.close() }
}

// Every digest that may admit this user. The digest files are separate credentials and each is valid
// (a proxy may publish its own login's digest beside a password of the user's own). A plaintext
// `.password` counts too.
async function expectedDigests (usersDir, user, digestFiles) {
  const dir = path.join(usersDir, user)
  const stat = await fs.lstat(dir).catch(() => null)
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return []
  const digests = []
  const plain = (await readSmall(path.join(dir, '.password')))?.replace(/[\r\n]+$/, '')
  if (plain) digests.push(sha512(plain))
  for (const name of digestFiles) {
    const hash = (await readSmall(path.join(dir, name)))?.trim()
    if (hash && SHA512_HEX.test(hash)) digests.push(Buffer.from(hash, 'hex'))
  }
  return digests
}

/**
 * {user, verified} for a request carrying a Basic header, else null. `verified: false` only when no
 * users directory exists; with one, a name whose password does not check out is no one (null).
 */
export async function proxyLogin (headers, options = {}) {
  const outcome = await examineLogin(headers, options)
  return outcome.login
}

/**
 * {login, reason}: the login as proxyLogin returns it, and a reason code when a Basic header did not
 * verify (no-basic-header, unparsable-header, empty-password, no-credential, bad-password). A code, never
 * the password or the digest: it is what identify() logs so a refused login can be diagnosed.
 */
export async function examineLogin (headers, { usersDir = defaultUsersDir(), digestFiles = defaultDigestFiles() } = {}) {
  const header = headers?.authorization
  if (!header) return { login: null, reason: 'no-basic-header' }
  const basic = parseBasic(header)
  if (!basic) return { login: null, reason: /^basic\s/i.test(header) ? 'unparsable-header' : 'no-basic-header' }
  const root = usersDir ? await fs.realpath(usersDir).catch(() => null) : null
  if (!root) return { login: { user: basic.user, verified: false }, reason: 'no-users-directory' }
  if (!basic.password) return { login: null, reason: 'empty-password', user: basic.user }
  const expected = await expectedDigests(root, basic.user, digestFiles)
  if (!expected.length) return { login: null, reason: 'no-credential', user: basic.user }
  const offered = sha512(basic.password)
  // Every digest is compared, so the time taken does not say which credential matched.
  const matched = expected.map((digest) => crypto.timingSafeEqual(offered, digest)).includes(true)
  if (matched) return { login: { user: basic.user, verified: true }, reason: null }
  return { login: null, reason: 'bad-password', user: basic.user }
}

// A refused login is logged once per user and reason per 10 minutes: enough to diagnose, never a flood.
const REPORTED_MAX = 2000
const REPORTED_WINDOW_MS = 10 * 60 * 1000
const reported = new Map()
function reportRefusal (outcome, req) {
  if (!outcome.reason || outcome.reason === 'no-users-directory') return
  if (outcome.reason === 'no-basic-header' && req.headers?.['x-forwarded-for'] === undefined) return
  const now = Date.now()
  const key = `${outcome.user ?? '-'}:${outcome.reason}`
  if (now - (reported.get(key) ?? 0) < REPORTED_WINDOW_MS) return
  if (reported.size >= REPORTED_MAX) {
    for (const [k, ts] of reported) if (now - ts >= REPORTED_WINDOW_MS) reported.delete(k)
    while (reported.size >= REPORTED_MAX) reported.delete(reported.keys().next().value)
  }
  reported.set(key, now)
  console.warn(`proxy login not verified: ${outcome.reason}${outcome.user ? ` (user ${outcome.user})` : ''} on ${req.method} ${req.path}${req.headers?.['x-forwarded-for'] ? ' via proxy' : ''}`)
}

/** Mounted BEFORE requireToken: sets req.login, which the token gate accepts when verified. */
export function identify (options) {
  return (req, _res, next) => examineLogin(req.headers, options).then((outcome) => {
    req.login = outcome.login
    reportRefusal(outcome, req)
    next()
  }, next)
}

/** Mounted after express.json(): req.actor is the login's name, and it overrides any body.actor. */
export function proxyActor () {
  return (req, _res, next) => {
    req.actor = req.login?.user ?? null
    if (req.actor && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) req.body.actor = req.actor
    next()
  }
}
