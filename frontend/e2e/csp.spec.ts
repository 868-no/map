// The page runs under its Content-Security-Policy (web/Caddyfile) without a
// violation, and MapLibre's worker is the bundled same-origin script (v6:
// worker-src 'self', no blob: workers).
import { expect, test } from '@playwright/test'

type Hook = { layers: () => { id: string; data: unknown[] }[] }

test('the page runs within its CSP, with MapLibre on its same-origin worker', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.layers().find((l) => l.id === 'nodes')?.data.length ?? 0), { timeout: 30_000 }).toBeGreaterThan(0)
  const workers = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('maplibre-gl-worker')))
  expect(workers.length, 'MapLibre loaded its worker').toBeGreaterThan(0)
  expect(workers.every((u) => new URL(u).origin === new URL(page.url()).origin)).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
})
