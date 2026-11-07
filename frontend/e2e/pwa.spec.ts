import { expect, test, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'allow' })

/** What the read-through cache (D-184) holds: whole days and today's stretch. */
function cached(page: Page) {
  return page.evaluate(() => new Promise<{ days: number; recent: boolean }>((resolve) => {
    // Never create or hold the database here: that would block the worker's schema upgrade.
    const req = indexedDB.open('meshmap-cache')
    req.onupgradeneeded = () => req.transaction?.abort()
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) {
        db.close()
        return resolve({ days: 0, recent: false })
      }
      const tx = db.transaction(['days', 'meta'])
      const n = tx.objectStore('days').count()
      const g = tx.objectStore('meta').get('state')
      tx.oncomplete = () => {
        db.close()
        resolve({ days: n.result, recent: !!g.result?.recent })
      }
    }
    req.onerror = () => resolve({ days: 0, recent: false })
  }))
}

/** Waits until the derivation worker has saved the window's rows in its cache. */
async function rowsSaved(page: Page) {
  await expect.poll(async () => (await cached(page)).recent, { timeout: 15_000 }).toBe(true)
}

test('installable: manifest with icons, service worker, static caching headers', async ({ page, request }) => {
  await page.goto('/')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifest = await (await request.get(href!)).json()
  expect(manifest.display).toBe('standalone')
  expect(manifest.start_url).toBe('/')
  for (const size of ['192x192', '512x512']) expect(manifest.icons.some((i: { sizes: string }) => i.sizes === size)).toBe(true)
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
  for (const i of manifest.icons) expect((await request.get(i.src)).ok()).toBe(true)
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), { timeout: 30_000 }).toBe(true)

  const asset = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((s) => (s as HTMLScriptElement).src).find((s) => s.includes('/assets/'))!)
  expect((await request.get(asset)).headers()['cache-control']).toContain('immutable')
  expect((await request.get('/')).headers()['cache-control']).toBe('no-cache')
  expect((await request.get('/sw.js')).headers()['cache-control']).toBe('no-cache')
  if (process.env.MESHMAP_NO_BASEMAP) return // the basemap archive is not built in CI
  const tile = await request.get('/tiles/basemap.pmtiles', { headers: { Range: 'bytes=0-127' } })
  expect(tile.status()).toBe(206)
  expect(tile.headers()['cache-control']).toContain('max-age=')
})

test('works offline with the last data received, and never stores tiles in the worker cache', async ({ page, context }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), { timeout: 30_000 }).toBe(true)
  await page.reload() // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible()
  const names = await page.locator('.node-row .nm').allTextContents()
  // The worker saves its rows to IndexedDB in the background; go offline once saved.
  await rowsSaved(page)

  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.topbar h1')).toHaveText('868.no Map')
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible()
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible()
  // The same nodes; their order follows when each was last heard, which moves on with busy traffic.
  expect((await page.locator('.node-row .nm').allTextContents()).sort()).toEqual([...names].sort())

  const urls = await page.evaluate(async () => {
    const urls: string[] = []
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname)
    return urls
  })
  expect(urls.some((u) => u.startsWith('/tiles/'))).toBe(false)
  expect(urls).toContain('/index.html')
  // Offline data comes from the derivation worker's IndexedDB cache, not the service worker's.
  expect(urls.some((u) => u.startsWith('/api/v1/observations'))).toBe(false)
  const held = await cached(page)
  expect(held.days > 0 || held.recent).toBe(true)
  await context.setOffline(false)
})

// A proxy's 502/503/504 while the backend restarts is no answer: the service
// worker serves its saved API responses and the map is built from the saved
// rows, as offline, rather than failing (D-140).
test('the saved copy serves while the backend is down behind the proxy', async ({ page, context }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), { timeout: 30_000 }).toBe(true)
  await page.reload() // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  await rowsSaved(page)
  await context.route('**/api/v1/**', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>' }))
  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible()
  await context.unroute('**/api/v1/**')
})

// The backend's own 503 (problem+json, "server busy, retry shortly") is an
// answer: the page retries it, never switching to the saved copy (D-156).
test('a busy backend is retried, not taken for one that is down', async ({ page, context }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), { timeout: 30_000 }).toBe(true)
  await page.reload() // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  await rowsSaved(page)
  let busy = 0
  await context.route('**/api/v1/observations*', (r) => {
    if (busy++ >= 2) return r.continue()
    return r.fulfill({ status: 503, contentType: 'application/problem+json', body: JSON.stringify({ title: 'Service Unavailable', status: 503, detail: 'server busy, retry shortly' }) })
  })
  await page.reload()
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  expect(busy).toBeGreaterThan(2) // answered busy twice, then fetched
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toHaveCount(0)
  await context.unroute('**/api/v1/observations*')
})

// D-184: whole past days and today's stretch are read through the cache, so a
// reload asks the server only for rows after the stretch, and a longer window
// after a shorter one reads its older days back instead of fetching them.
test('the cache is read through: a reload and a longer window ask only for what is new', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  await rowsSaved(page)
  const fetched: string[] = []
  page.on('request', (r) => /\/api\/v1\/observations(\/day|\?)/.test(r.url()) && fetched.push(r.url()))
  await page.reload()
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => fetched.length).toBeGreaterThan(0)
  expect(fetched.filter((u) => u.includes('/day/'))).toEqual([])
  expect(fetched.every((u) => u.includes('since='))).toBe(true)
  // Shorter, then longer again: the engine let the older rows go, the cache did not.
  fetched.length = 0
  await page.getByRole('button', { name: 'Period', exact: true }).click()
  await page.getByRole('button', { name: '24h', exact: true }).click()
  await page.getByRole('button', { name: '3d', exact: true }).click()
  await expect(page).toHaveURL(/^(?!.*duration=24h)/)
  await page.waitForTimeout(3000)
  expect(fetched.filter((u) => u.includes('/day/') || u.includes('until='))).toEqual([])
})
