import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { writeJson } from '../runtime/persistence.mjs'

/*
 * Standard Web Push on node:crypto, with no dependency (docs/operator-alerts.md):
 * the payload is encrypted for the browser's subscription (RFC 8291, aes128gcm) and
 * the request is signed with the panel's own VAPID key (RFC 8292). The push service
 * sees only ciphertext; what the plaintext holds is notifier.mjs's alertPayload.
 */

export const TTL_SECONDS = 3600
export const TIMEOUT_MS = 15000

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (text) => Buffer.from(String(text), 'base64url')

/** RFC 8291 §3: one record, the last (delimiter 0x02), rs 4096. `ephemeral` and `salt` exist for the RFC's test vector. */
export function encrypt (plaintext, { p256dh, auth }, { ephemeral = null, salt = crypto.randomBytes(16) } = {}) {
  const uaPublic = unb64u(p256dh)
  const authSecret = unb64u(auth)
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('subscription p256dh is not an uncompressed P-256 key')
  if (authSecret.length !== 16) throw new Error('subscription auth secret must be 16 bytes')
  const ecdh = crypto.createECDH('prime256v1')
  if (ephemeral) ecdh.setPrivateKey(unb64u(ephemeral))
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

/** The inverse, for tests: what a browser holding the subscription's private key would read. */
export function decrypt (message, { privateKey, auth }) {
  const salt = message.subarray(0, 16)
  const idlen = message[20]
  const asPublic = message.subarray(21, 21 + idlen)
  const data = message.subarray(21 + idlen)
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.setPrivateKey(unb64u(privateKey))
  const uaPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, unb64u(auth), keyInfo, 32))
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(data.subarray(data.length - 16))
  const padded = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()])
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')
}

/** The panel's VAPID key pair, made once and kept 0600 beside the notifier's state. */
export async function loadVapid (dir) {
  const file = path.join(dir, 'vapid.json')
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const pub = publicKey.export({ format: 'jwk' })
  const keys = { privateJwk: jwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])) }
  await writeJson(file, keys, { mode: 0o600 })
  return keys
}

/** RFC 8292: an ES256 JWT for the push service's origin, and the header that carries it. */
export function vapidAuthorization (endpoint, vapid, { subject, now = Date.now() } = {}) {
  const aud = new URL(endpoint).origin
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }))
  const key = crypto.createPrivateKey({ key: vapid.privateJwk, format: 'jwk' })
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`
}

// Push services a browser hands out subscriptions on; anything else is refused at subscription and at every send.
const PUSH_HOSTS = ['fcm.googleapis.com', '.push.services.mozilla.com', 'web.push.apple.com', '.notify.windows.com']

export function allowedEndpoint (endpoint, extra = (process.env.DEVPANEL_PUSH_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean)) {
  let url
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  return [...PUSH_HOSTS, ...extra].some((h) => h.startsWith('.') ? url.hostname.endsWith(h) : url.hostname === h)
}

// Errors where no connection to the push service was made: nothing can have been handed over, so a retry is safe.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])

/**
 * The transport: one POST per send. `send` starts the request (fetch is called) before its first await, so the
 * notifier's revocation check and the request start in the same tick. Every HTTP status is final; a redirect is
 * never followed. The outcome is accepted (201/202), gone (404/410: the subscription is dead), failed (any other
 * status), connect-error (no connection made) or unanswered (timed out, or broke after it may have been sent).
 */
export function webPushTransport ({ dir, subject = process.env.DEVPANEL_PUSH_SUBJECT || 'mailto:devpanel@localhost', fetchImpl = fetch } = {}) {
  let vapid = null
  return {
    async init () { vapid = await loadVapid(dir); return vapid.publicKey },
    publicKey: () => vapid?.publicKey ?? null,
    send (subscription, payload, { timeoutMs = TIMEOUT_MS } = {}) {
      if (!allowedEndpoint(subscription.endpoint)) return Promise.resolve({ outcome: 'failed', status: null, error: 'endpoint not on the push service allow-list', endedAt: new Date().toISOString() })
      const body = encrypt(JSON.stringify(payload), subscription.keys)
      const request = fetchImpl(subscription.endpoint, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body,
        headers: { TTL: String(TTL_SECONDS), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthorization(subscription.endpoint, vapid, { subject }) }
      })
      return request.then((res) => {
        const endedAt = new Date().toISOString()
        if (res.status === 201 || res.status === 202) return { outcome: 'accepted', status: res.status, endedAt }
        if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status, endedAt }
        return { outcome: 'failed', status: res.status, endedAt }
      }, (error) => {
        const endedAt = new Date().toISOString()
        const code = error?.cause?.code ?? error?.code
        if (CONNECT_CODES.has(code)) return { outcome: 'connect-error', error: code, endedAt }
        return { outcome: 'unanswered', cause: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'error', error: code ?? error?.name ?? String(error), endedAt }
      })
    }
  }
}
