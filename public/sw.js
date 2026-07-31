/*
 * Jerry Pattern Lab — offline shell.
 *
 * The app is a single bundle over a local history: once it has loaded, nothing
 * it does on screen needs the network. This keeps it that way on a phone with
 * no signal, and makes a warm open instant rather than a round trip.
 *
 * Build assets are content-hashed, so they are cached forever and a new build
 * simply asks for new filenames. The HTML entry and the jackpot feed are the
 * two things that must stay fresh, so both go to the network first and fall
 * back to the cache only when it is unreachable.
 */
const VERSION = 'jpl-v1'
const SHELL = `${VERSION}-shell`
const ASSETS = `${VERSION}-assets`

const SHELL_URLS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './apple-touch-icon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // One bad URL must not fail the whole install
      .then((cache) => Promise.allSettled(SHELL_URLS.map((u) => cache.add(u))))
      .then(() => undefined),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})

/** Network first, falling back to whatever was cached last. */
async function freshFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response && response.ok) cache.put(request, response.clone())
    return response
  } catch (err) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw err
  }
}

/** Cache first — correct only for content-hashed, immutable build output. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response && response.ok) cache.put(request, response.clone())
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      freshFirst(request, SHELL).catch(() =>
        caches.match('./index.html', { ignoreSearch: true }).then((r) => r ?? Response.error()),
      ),
    )
    return
  }

  if (url.pathname.endsWith('/jackpots.json')) {
    event.respondWith(freshFirst(request, SHELL).catch(() => Response.error()))
    return
  }

  if (/\/assets\/|\.(?:js|css|woff2?|png|webp|svg|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, ASSETS))
  }
})
