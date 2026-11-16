import { expect, test } from '@playwright/test'
import { mockObservations, neighborRow, nodeRows } from './mock'

// Design §9 and §10.2 test 32 (client side): reference density of 2 000 nodes and
// 20 000 links, derived in the browser from synthetic observations; measure
// JS heap and frame rate while panning. Printed for docs/benchmarks.md.
for (const [N, E] of [[0, 0], [2000, 20000]] as const) test(`rendering ${N} nodes / ${E} edges: heap and frame rate`, async ({ page }) => {
  test.setTimeout(180_000)
  // Synthetic observations the browser derives the mesh from: positions for
  // three in four nodes, and NeighborInfo reports of ten neighbours each
  // (2 000 x 10 = 20 000 directed links). The nodes sit on ten concentric
  // rings of 200, each reporting the next ten on its ring, so no link is
  // longer than radio reaches (under 100 km): longer ones would read as the
  // node having moved (D-223).
  const num = (i: number) => 0x10000000 + i
  const RING = 200
  const rows = Array.from({ length: N }, (_, i) => {
    const r = Math.floor(i / RING), p = i % RING, f = (r + 1) / (N / RING), a = (2 * Math.PI * p) / RING
    const lat = 61.25 + 2.75 * f * Math.sin(a), lon = 8.75 + 3.25 * f * Math.cos(a)
    const positioned = i % 4 !== 0
    return [
      ...nodeRows(num(i), `N${i % 1000}`, positioned ? { lat, lon } : {}),
      ...(N > 0 && E > 0 ? [neighborRow(num(i), Array.from({ length: E / N }, (_, k) => num(r * RING + ((p + 1 + k) % RING))))] : []),
    ]
  }).flat()
  await mockObservations(page, rows)
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap)
  await expect(page.locator('.counters')).toContainText(`${E} links`)
  if (N > 0) {
    await page.getByRole('button', { name: 'Nodes', exact: true }).click() // the side panel starts hidden
    await expect(page.locator('.node-row').first()).toBeVisible()
  }
  await page.waitForTimeout(3000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  // From DevTools: performance.memory is coarse and cached, the same figure for an empty and a full map.
  const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize / 2 ** 20
  // Pan continuously for 5 s and count frames.
  const fps = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const m = (window as unknown as { __meshmap: { map: { panBy: (o: [number, number], a: object) => void } } }).__meshmap.map
        let frames = 0
        const t0 = performance.now()
        const tick = () => {
          frames++
          if (performance.now() - t0 < 5000) {
            m.panBy([6, 2], { animate: false })
            requestAnimationFrame(tick)
          } else resolve(frames / ((performance.now() - t0) / 1000))
        }
        requestAnimationFrame(tick)
      }),
  )
  console.log(`PERF ${N} nodes / ${E} edges: JS heap ${heap.toFixed(0)} MiB after GC; panning ${fps.toFixed(1)} fps (headless Chromium, software GL)`)
  expect(heap).toBeLessThan(250)
})
