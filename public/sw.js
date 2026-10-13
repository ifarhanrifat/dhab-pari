// Dhab Pari service worker.
//
// Real ask: "remove these offline pages... these are creating serious
// problems" — offline page caching kept serving a stale homepage/ticker/
// video-page/donation-page to anyone who already had this worker
// installed, no matter how many times the real fix was deployed: every
// redesign/bugfix shipped landed invisibly behind an already-cached copy.
// This worker no longer caches or serves ANY page or asset — every
// request always goes straight to the network, so a pull-to-refresh (or
// just reopening the app) always shows exactly what's live, same as a
// normal browser tab. The one real, still-wanted feature — Web Push,
// which fires even when nobody has the app open — doesn't need any
// caching at all and is unaffected.
//
// activate wipes every cache this worker (or an earlier version of it)
// ever created, so a device that already has the old offline-caching
// worker installed gets cleaned up automatically the next time it checks
// for an update — this is what actually reaches an already-installed
// device; changing this file again never would have.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Real Web Push (migration 348 / /api/push/dispatch) — this is what fires
// even when nobody has the site open, the whole point of the exercise. The
// payload is the small JSON object the dispatch route sends: title, body,
// link. No caching concerns here — a push always carries fresh data, never
// reused from a prior show().
self.addEventListener('push', (event) => {
  let data = { title: 'Dhab Pari', body: '', link: '/' }
  try { data = { ...data, ...event.data.json() } } catch { /* non-JSON payload, keep defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { link: data.link },
    })
  )
})

// Focus an already-open tab on the right page rather than always opening a
// new one — the common case is someone tapping a notification while the app
// is already open in the background.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = event.notification.data?.link || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) { client.navigate(link); return client.focus() }
      }
      return self.clients.openWindow(link)
    })
  )
})
