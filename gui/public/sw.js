/*
 * devpanel's service worker: operator alerts only (docs/operator-alerts.md). It shows a pushed alert and opens
 * the panel's alert page when it is clicked. It has no fetch handler: it never caches or serves the panel, so
 * every page still goes through the panel's own sign-in.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const url = typeof data.url === 'string' && data.url.startsWith('/alerts/') ? data.url : '/'
  event.waitUntil(self.registration.showNotification(data.title || 'devpanel needs attention', {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url }
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
        await client.focus()
        return client.navigate ? client.navigate(url) : undefined
      }
    }
    return self.clients.openWindow(url)
  })())
})
