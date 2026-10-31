import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'allow' })

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
  const tile = await request.get('/tiles/basemap.pmtiles', { headers: { Range: 'bytes=0-127' } })
  expect(tile.status()).toBe(206)
  expect(tile.headers()['cache-control']).toContain('max-age=')
})

test('works offline with the last data received, and never stores tiles in the worker cache', async ({ page, context }) => {
  await page.goto('/')
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active), { timeout: 30_000 }).toBe(true)
  await page.reload() // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.getByRole('button', { name: 'Nodes & details' }).click()
  await expect(page.locator('.node-row').first()).toBeVisible()
  const names = await page.locator('.node-row .nm').allTextContents()
  // The worker saves its rows to IndexedDB in the background; go offline once saved.
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const req = indexedDB.open('meshmap-derive')
    req.onsuccess = () => {
      const g = req.result.transaction('meta').objectStore('meta').get('state')
      g.onsuccess = () => resolve(!!g.result?.cov)
    }
    req.onerror = () => resolve(false)
  })), { timeout: 15_000 }).toBe(true)

  await context.setOffline(true)
  await page.reload()
  await expect(page.locator('.topbar h1')).toHaveText('Mesh Observatory')
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible()
  await page.getByRole('button', { name: 'Nodes & details' }).click()
  await expect(page.locator('.node-row').first()).toBeVisible()
  expect(await page.locator('.node-row .nm').allTextContents()).toEqual(names)

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
      const c = req.result.transaction('rows').objectStore('rows').count()
      c.onsuccess = () => resolve(c.result)
    }
    req.onerror = () => resolve(0)
  }))
  expect(held).toBeGreaterThan(0)
  await context.setOffline(false)
})
