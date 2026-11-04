import { expect, test, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'allow' })

/** Waits until the derivation worker has saved its rows (and their coverage) to IndexedDB. */
async function rowsSaved(page: Page) {
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    // Never create or hold the database here: that would block the worker's schema upgrade.
    const req = indexedDB.open('meshmap-derive')
    req.onupgradeneeded = () => req.transaction?.abort()
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) {
        db.close()
        return resolve(false)
      }
      const g = db.transaction('meta').objectStore('meta').get('state')
      g.onsuccess = () => {
        db.close()
        resolve(!!g.result?.cov)
      }
    }
    req.onerror = () => resolve(false)
  })), { timeout: 15_000 }).toBe(true)
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

  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname)
    return urls
  })
  expect(cached.some((u) => u.startsWith('/tiles/'))).toBe(false)
  expect(cached).toContain('/index.html')
  // Offline data comes from the derivation worker's IndexedDB copy, not the cache.
  expect(cached.some((u) => u.startsWith('/api/v1/observations'))).toBe(false)
  const held = await page.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open('meshmap-derive')
    req.onsuccess = () => {
      const db = req.result
      const c = db.transaction('chunks').objectStore('chunks').count()
      c.onsuccess = () => {
        db.close()
        resolve(c.result)
      }
    }
    req.onerror = () => resolve(0)
  }))
  expect(held).toBeGreaterThan(0)
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

// D-102: rows are saved as one engine build re-exports them; another build
// must not trust that copy (it may lack fields the new engine reads).
test('a saved row copy from another engine build is discarded and the window fetched afresh', async ({ page }) => {
  const meta = (fn: string) => page.evaluate((fn) => new Promise<unknown>((resolve) => {
    const req = indexedDB.open('meshmap-derive')
    req.onupgradeneeded = () => req.transaction?.abort()
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('meta')) {
        db.close()
        return resolve(null)
      }
      const tx = db.transaction('meta', fn === 'tamper' ? 'readwrite' : 'readonly')
      const g = tx.objectStore('meta').get('state')
      g.onsuccess = () => {
        if (fn === 'tamper' && g.result) tx.objectStore('meta').put({ ...g.result, engine: 'an-older-build.wasm' }, 'state')
        tx.oncomplete = () => {
          db.close()
          resolve(g.result ?? null)
        }
      }
    }
    req.onerror = () => resolve(null)
  }), fn)
  await page.goto('/')
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => !!((await meta('read')) as { cov?: unknown } | null)?.cov, { timeout: 15_000 }).toBe(true)
  await meta('tamper')
  const fetched: string[] = []
  page.on('request', (r) => r.url().includes('/api/v1/observations') && fetched.push(r.url()))
  await page.reload()
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await expect(page.locator('.node-row').first()).toBeVisible({ timeout: 30_000 })
  // A trusted copy would only ask for what is new (since=...); a discarded one fetches the window.
  await expect.poll(() => fetched.some((u) => !u.includes('since=') && !u.includes('cursor='))).toBe(true)
  await expect.poll(async () => ((await meta('read')) as { engine?: string } | null)?.engine, { timeout: 15_000 }).not.toBe('an-older-build.wasm')
})
