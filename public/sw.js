// Dhab Pari service worker.
//
// Deliberately conservative: this app shows people money — bills, balances,
// donation totals. Serving a stale balance from cache would be worse than
// showing nothing, so NOTHING from Supabase, /api, or any authenticated page
// (/admin, /portal) is ever cached, online or offline — that line does not
// move below.
//
// Within that line, public read-mostly pages (home, projects, directory,
// news, etc.) now get real offline support too: every successful visit is
// saved, so a page someone has already opened keeps working with no signal
// at all, instead of only ever showing the offline placeholder. The figures
// on those pages already tolerate some staleness on a live connection too —
// the Server Components behind them run with `revalidate = 300` — so a
// cached copy used only when the network is slow or absent is the same
// staleness this app already accepts, not a new risk.
//
// Bump CACHE_VERSION / PAGES_CACHE to force every client to drop the old cache.
const CACHE_VERSION = 'dp-shell-v3'
const PAGES_CACHE = 'dp-pages-v1'
const CURRENT_CACHES = [CACHE_VERSION, PAGES_CACHE]
const OFFLINE_URL = '/offline.html'
// A slow village connection should still feel instant: if the network
// hasn't answered within this window, hand back the last good copy right
// away rather than making someone stare at a spinner. The network request
// keeps running in the background and refreshes the cache for next time.
const NAV_TIMEOUT_MS = 3500

const PRECACHE = [
  OFFLINE_URL,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // Don't make the user close every tab to get a fixed version.
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !CURRENT_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// True only for the production build. In dev, Turbopack regenerates chunk URLs
// on every recompile and reuses names across compiles, so a cache-first rule
// hands back chunks that no longer exist — which is exactly what put the dev
// server into an endless reload loop. Belt and braces: PwaProvider no longer
// registers this worker outside production, but a worker already installed in
// someone's browser keeps running until it is replaced, and this check is what
// makes that stale copy harmless in the meantime.
function isDevHost() {
  const h = self.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local')
}

function isCacheableAsset(url) {
  if (isDevHost()) return false
  // In a production build Next.js content-hashes these filenames, so a cached
  // copy can never be stale — a new build produces a new URL.
  return url.pathname.startsWith('/_next/static/')
    || url.pathname.startsWith('/icons/')
    || /\.(png|jpg|jpeg|svg|webp|avif|woff2?)$/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  if (isDevHost()) return

  const url = new URL(request.url)

  // Never touch anything that carries live data or credentials.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/admin')) return
  if (url.pathname.startsWith('/portal')) return

  // Navigations: race the network against a short timeout. A fast/normal
  // connection always wins the race, so nothing changes for most visits —
  // the page is as fresh as it always was. A slow or absent connection
  // instead gets the last copy of this exact page that was ever saved, so
  // a flaky village signal shows something real instantly instead of a
  // spinner, and no signal at all still shows the real page, not a
  // placeholder, for anywhere already visited once.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request)

        const networkFetch = fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            caches.open(PAGES_CACHE).then((cache) => cache.put(request, copy))
          }
          return response
        })
        // Keep the worker alive long enough for the cache write above to
        // finish even when the race below resolves from the timeout/cache
        // branch first and nothing else is awaiting this promise.
        event.waitUntil(networkFetch.catch(() => {}))

        if (!cached) {
          return networkFetch.catch(() => caches.match(OFFLINE_URL).then((r) => r ?? Response.error()))
        }

        const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS))
        return Promise.race([networkFetch, timeout]).catch(() => cached)
      })()
    )
    return
  }

  // Fingerprinted static assets: cache-first (instant repeat loads).
  if (isCacheableAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone()
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
          }
          return response
        })
      })
    )
  }
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
