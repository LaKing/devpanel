/*
 * Is a request one the panel's own page made, judged from what a browser cannot be made to forge?
 *
 * Decision: only credentials a browser attaches BY ITSELF need this. A reverse proxy's basic-auth login
 * (proxy-user.mjs) is cached by the browser and sent with a cross-site <form method=POST>, a cross-site
 * <img> and a cross-site WebSocket handshake alike, so without this check any page the operator visits could
 * stop a run or start a checkpoint. The token (X-Devpanel-Token / Bearer / socket auth) is set by script and
 * never sent cross-site, so a token request is not checked; local-login.mjs makes the same check of its own.
 *
 * Mechanism: Sec-Fetch-Site, when sent, must be same-origin or none (every current browser sends it, also
 * on GET). Origin, when sent, must name the Host the request arrived for: the fallback for older browsers.
 * A client sending neither (curl, the devpanel skill) is no browser and is admitted.
 * Pitfall: behind the proxy the Host header must stay the public name (haproxy keeps it); a proxy that
 * rewrites Host to the backend address would refuse every proxied browser write.
 */
export function sameSite (headers = {}) {
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.origin
  if (origin === undefined) return true
  if (origin === 'null' || !headers.host) return false
  try { return new URL(origin).host.toLowerCase() === String(headers.host).toLowerCase() } catch { return false }
}
