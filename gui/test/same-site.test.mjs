import { sameSite } from '../server/same-site.mjs'
import { requireToken } from '../server/auth.mjs'

export const name = 'same site — a browser-cached basic-auth login is accepted only from the panel\'s own pages'

const call = (mw, req) => new Promise((resolve) => {
  const res = { status (code) { this.code = code; return this }, json (body) { resolve({ code: this.code, body }) } }
  mw(req, res, () => resolve({ code: 'next' }))
})

export default async function (t) {
  t.section('1. the headers a browser cannot be made to forge')
  t.eq('no browser headers (curl, the skill) is admitted', sameSite({ host: 'panel.example' }), true)
  t.eq('Sec-Fetch-Site same-origin', sameSite({ 'sec-fetch-site': 'same-origin', host: 'panel.example' }), true)
  t.eq('Sec-Fetch-Site none (typed address)', sameSite({ 'sec-fetch-site': 'none' }), true)
  t.eq('Sec-Fetch-Site cross-site is refused', sameSite({ 'sec-fetch-site': 'cross-site' }), false)
  t.eq('Sec-Fetch-Site same-site (a sibling subdomain) is refused', sameSite({ 'sec-fetch-site': 'same-site' }), false)
  t.eq('Origin naming the Host', sameSite({ origin: 'https://Panel.example', host: 'panel.example' }), true)
  t.eq('Origin with the port of the Host', sameSite({ origin: 'https://panel.example:8443', host: 'panel.example:8443' }), true)
  t.eq('a foreign Origin is refused', sameSite({ origin: 'https://evil.example', host: 'panel.example' }), false)
  t.eq('Origin null is refused', sameSite({ origin: 'null', host: 'panel.example' }), false)
  t.eq('Origin without a Host is refused', sameSite({ origin: 'https://panel.example' }), false)

  t.section('2. requireToken: the proxy login is checked, the token is not')
  const gate = requireToken('t0ken')
  const login = { user: 'alice', verified: true }
  t.eq('a same-origin proxy-login POST passes', (await call(gate, { path: '/api/x', headers: { 'sec-fetch-site': 'same-origin' }, login })).code, 'next')
  t.eq('a cross-site proxy-login POST is 403', (await call(gate, { path: '/api/x', headers: { 'sec-fetch-site': 'cross-site' }, login })).code, 403)
  t.eq('the token passes even cross-site (scripts set it, browsers never send it by themselves)', (await call(gate, { path: '/api/x', headers: { 'x-devpanel-token': 't0ken', 'sec-fetch-site': 'cross-site' } })).code, 'next')
  t.eq('no credential is 401', (await call(gate, { path: '/api/x', headers: {} })).code, 401)
}
