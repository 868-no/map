// Service worker: offline app shell and last-known data. Built by the
// meshmap-sw Vite plugin, which fills in VERSION and PRECACHE.
// Map tiles are never stored here (they stay in the browser's HTTP cache),
// and the live event stream always goes to the network.

const VERSION = '__VERSION__'
/* global __PRECACHE__ -- replaced at build time by the meshmap-sw plugin */
const PRECACHE = __PRECACHE__
const SHELL = `meshmap-shell-${VERSION}`
const FONTS = 'meshmap-fonts-v1'
const DATA = 'meshmap-data-v2' // v2: size-capped (v1 is deleted on activation)
// Offline API copies are capped by size: snapshots can be several MB each.
const DATA_BUDGET_BYTES = 30 * 1024 * 1024
const DATA_MAX_ENTRY_BYTES = 10 * 1024 * 1024
const DATA_INDEX = '/__meshmap-data-index__'
const API_TIMEOUT_MS = 8000
const KEEP = [SHELL, FONTS, DATA]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('meshmap-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  const p = url.pathname

  // Network only: tiles (HTTP cache handles them), live stream, health,
  // metrics, and raw observations (the derivation worker keeps its own copy
  // in IndexedDB, so offline copies of pages would only duplicate it).
  if (p.startsWith('/tiles/') || p === '/api/v1/stream' || p === '/api/v1/observations' || p.startsWith('/health/') || p === '/metrics') return

  if (req.mode === 'navigate') {
    // Pages of their own (the privacy policy) are cached under their own
    // path; every other navigation is the app, whose offline copy is /index.html.
    event.respondWith(networkFirst(req, SHELL, p !== '/' && PRECACHE.includes(p) ? p : '/index.html'))
    return
  }
  if (p.startsWith('/api/')) {
    event.respondWith(apiNetworkFirst(req))
    return
  }
  if (p.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req, FONTS))
    return
  }
  if (p.startsWith('/styles/')) {
    event.respondWith(staleWhileRevalidate(req, SHELL))
    return
  }
  event.respondWith(cacheFirst(req, SHELL))
})

async function cacheFirst(req, name) {
  const hit = await caches.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (cacheable(req, res)) (await caches.open(name)).put(req, res.clone())
  return res
}

// Only what the request asked for: never an HTML page standing in for a
// script, stylesheet or other file (a fallback for a file of an older build).
function cacheable(req, res) {
  if (!res.ok) return false
  const html = (res.headers.get('content-type') || '').includes('text/html')
  return !html || req.mode === 'navigate' || req.destination === 'document'
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name)
  const hit = await cache.match(req)
  const fresh = fetch(req)
    .then((res) => {
      if (cacheable(req, res)) cache.put(req, res.clone())
      return res
    })
    .catch(() => hit)
  return hit || fresh
}

async function networkFirst(req, name, fallbackPath) {
  try {
    const res = await fetch(req)
    if (res.ok) (await caches.open(name)).put(fallbackPath, res.clone())
    return res
  } catch {
    return (await caches.match(fallbackPath)) || Response.error()
  }
}

// A proxy's answer while the backend is down or restarting: no answer from it.
const GATEWAY_DOWN = new Set([502, 503, 504])

// API: fresh data when online; the last successful response for the same
// URL when offline or the backend is down, marked so the app can say it is
// showing old data.
async function apiNetworkFirst(req) {
  const cache = await caches.open(DATA)
  let res
  try {
    res = await fetchWithTimeout(req, API_TIMEOUT_MS)
    if (res.ok) remember(cache, req, res.clone()).catch(() => {}) // in the background: never delay the response
    if (!GATEWAY_DOWN.has(res.status)) return res
  } catch {
    res = null
  }
  const hit = await cache.match(req)
  if (!hit && res) return res // the proxy's own error, with its detail
  if (!hit) return new Response(JSON.stringify({ title: 'Offline', status: 503, detail: 'offline and no saved copy of this view' }), {
    status: 503, headers: { 'content-type': 'application/problem+json', 'x-meshmap-offline': '1' },
  })
  const headers = new Headers(hit.headers)
  headers.set('x-meshmap-offline', '1')
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers })
}

function fetchWithTimeout(req, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  // Respect the page's own abort signal as well.
  if (req.signal) req.signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  return fetch(req, { signal: ctrl.signal }).finally(() => clearTimeout(t))
}

// Store an API response and keep the total under DATA_BUDGET_BYTES, evicting
// the least recently stored. The size index lives in the same cache; updates
// are serialised so concurrent responses cannot lose entries.
let indexLock = Promise.resolve()
function remember(cache, req, res) {
  const job = indexLock.then(async () => {
    const body = await res.blob()
    if (body.size > DATA_MAX_ENTRY_BYTES) return
    await cache.put(req, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }))
    const hit = await cache.match(DATA_INDEX)
    const index = hit ? await hit.json() : {}
    index[req.url] = { size: body.size, at: Date.now() }
    const entries = Object.entries(index).sort((a, b) => a[1].at - b[1].at)
    let total = entries.reduce((n, [, e]) => n + e.size, 0)
    for (const [url, e] of entries) {
      if (total <= DATA_BUDGET_BYTES) break
      await cache.delete(url)
      delete index[url]
      total -= e.size
    }
    await cache.put(DATA_INDEX, new Response(JSON.stringify(index), { headers: { 'content-type': 'application/json' } }))
  })
  indexLock = job.catch(() => {})
  return job
}
