// Dhab Pari service worker.
//
// Deliberately conservative: this app shows people money — bills, balances,
// donation totals. Serving a stale balance from cache would be worse than
// showing nothing, so NOTHING from Supabase, /api, or any authenticated page
// is ever cached. This only makes the app *shell* load instantly and shows a
// proper offline page instead of the browser's dinosaur.
//
// Bump CACHE_VERSION to force every client to drop the old cache.
const CACHE_VERSION = 'dp-shell-v1'
const OFFLINE_URL = '/offline.html'

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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

function isCacheableAsset(url) {
  // Next.js fingerprints these filenames, so a cached copy can never be stale
  // — a new build produces a new URL.
  return url.pathname.startsWith('/_next/static/')
    || url.pathname.startsWith('/icons/')
    || /\.(png|jpg|jpeg|svg|webp|avif|woff2?)$/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Never touch anything that carries live data or credentials.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname.startsWith('/admin')) return
  if (url.pathname.startsWith('/portal')) return

  // Navigations: always go to the network so the page is fresh; fall back to
  // the offline page only when the device genuinely has no connection.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r ?? Response.error()))
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
