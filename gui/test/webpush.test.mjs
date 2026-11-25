import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { allowedEndpoint, decrypt, encrypt, loadVapid, vapidAuthorization, webPushTransport } from '../server/notifications/webpush.mjs'
import { alertPayload } from '../server/notifications/notifier.mjs'

// RFC 8291 Appendix A.
const VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

export function browserKeys () {
  const ecdh = crypto.createECDH('prime256v1')
  ecdh.generateKeys()
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') }
}

export default async function (t) {
  t.section('RFC 8291 encryption')
  const body = encrypt(VECTOR.plaintext, { p256dh: VECTOR.uaPublic, auth: VECTOR.auth }, { ephemeral: VECTOR.asPrivate, salt: Buffer.from(VECTOR.salt, 'base64url') })
  t.eq('the RFC 8291 test vector is reproduced byte for byte', body.toString('base64url'), VECTOR.body)
  t.eq('and decrypts back with the browser key', decrypt(body, { privateKey: VECTOR.uaPrivate, auth: VECTOR.auth }), VECTOR.plaintext)

  t.section('VAPID')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vapid-'))
  try {
    const vapid = await loadVapid(dir)
    t.eq('the key file is private', (await fs.stat(path.join(dir, 'vapid.json'))).mode & 0o777, 0o600)
    t.eq('the same key is read back', (await loadVapid(dir)).publicKey, vapid.publicKey)
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, { subject: 'mailto:x@example.invalid', now: Date.parse('2026-11-25T00:00:00Z') })
    const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)
    const [h, c, s] = jwt.split('.')
    const claims = JSON.parse(Buffer.from(c, 'base64url'))
    t.eq('aud is the push service origin', claims.aud, 'https://fcm.googleapis.com')
    t.eq('exp is 12 hours ahead', claims.exp, Date.parse('2026-11-25T12:00:00Z') / 1000)
    const pub = Buffer.from(k, 'base64url')
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
    t.ok('the ES256 signature verifies against k', crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')))

    t.section('allow-list')
    t.ok('FCM is allowed', allowedEndpoint('https://fcm.googleapis.com/fcm/send/x', []))
    t.ok('Mozilla subdomains are allowed', allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x', []))
    t.ok('Apple is allowed', allowedEndpoint('https://web.push.apple.com/x', []))
    t.ok('plain http is refused', !allowedEndpoint('http://fcm.googleapis.com/x', []))
    t.ok('another host is refused', !allowedEndpoint('https://attacker.example/x', []))
    t.ok('a lookalike suffix is refused', !allowedEndpoint('https://evilpush.services.mozilla.com.example/x', []))
    t.ok('an operator-listed host is allowed', allowedEndpoint('https://push.internal.example/x', ['push.internal.example']))

    t.section('transport')
    const keys = browserKeys()
    const calls = []
    const respond = (status) => async (url, init) => { calls.push({ url, init }); return { status } }
    const make = (fetchImpl) => { const tr = webPushTransport({ dir, fetchImpl, subject: 'mailto:x@example.invalid' }); return tr.init().then(() => tr) }
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: keys.p256dh, auth: keys.auth } }
    const payload = alertPayload({ alertId: 'a1', createdAt: '2026-11-25T00:00:00Z', items: [{ kind: 'question' }, { kind: 'recovery' }] })
    let tr = await make(respond(201))
    t.eq('201 is accepted', (await tr.send(sub, payload)).outcome, 'accepted')
    const init = calls[0].init
    t.eq('TTL is one hour', init.headers.TTL, '3600')
    t.eq('redirects are never followed', init.redirect, 'manual')
    t.eq('content encoding is aes128gcm', init.headers['Content-Encoding'], 'aes128gcm')
    t.eq('the body decrypts to the payload', JSON.parse(decrypt(init.body, keys)).alertId, 'a1')
    tr = await make(respond(410)); t.eq('410 is gone', (await tr.send(sub, payload)).outcome, 'gone')
    tr = await make(respond(302)); t.eq('a redirect is a final failure, not followed', (await tr.send(sub, payload)).outcome, 'failed')
    tr = await make(respond(503)); t.eq('5xx is a final failure', (await tr.send(sub, payload)).outcome, 'failed')
    tr = await make(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) })
    t.eq('no connection is a connect-error', (await tr.send(sub, payload)).outcome, 'connect-error')
    tr = await make(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) })
    const timeout = await tr.send(sub, payload)
    t.eq('a timeout is unanswered', [timeout.outcome, timeout.cause].join('/'), 'unanswered/timeout')
    calls.length = 0
    tr = await make(respond(201))
    t.eq('an endpoint off the allow-list is never contacted', (await tr.send({ ...sub, endpoint: 'https://attacker.example/x' }, payload)).outcome, 'failed')
    t.eq('no request was made', calls.length, 0)

    t.section('payload carries no issue text or credential')
    const marker = 'SECRET-ISSUE-TEXT-7f3a'
    const items = [{ kind: 'question', key: `pause:p/${marker}/r/1`, project: 'p', issueId: marker, runId: 'r', issueName: marker, headline: marker }]
    const text = JSON.stringify(alertPayload({ alertId: 'a2', createdAt: '2026-11-25T00:00:00Z', items }))
    t.ok('the issue id, name and question are absent from the plaintext', !text.includes(marker))
    calls.length = 0
    tr = await make(respond(201))
    await tr.send(sub, alertPayload({ alertId: 'a2', createdAt: '2026-11-25T00:00:00Z', items }))
    const sent = calls[0].init
    t.ok('and from the headers', !JSON.stringify(sent.headers).includes(marker))
    t.ok('and from the decrypted body', !decrypt(sent.body, keys).includes(marker))
    t.ok('the VAPID private key is never sent', !JSON.stringify(sent.headers).includes(vapid.privateJwk.d))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
