import { expect, test } from '@playwright/test'
import { directReception, mockObservations, nodeRows } from './mock'
import { docShot } from './shots'

type Hook = { pings: () => number; pingFrame: () => { rings: number; trails: number[] }; map: { jumpTo: (o: object) => void } }

// A live reception becomes a ring around the transmitter and an animated link
// to the receiver, the link's head riding the ring's edge (D-042).
test('a live reception pings, and its link animates toward the receiver', async ({ page }) => {
  const O = 0x30000001, GW = 0x30000002
  let release!: (make: () => ReturnType<typeof directReception>[]) => void
  const live = new Promise<() => ReturnType<typeof directReception>[]>((r) => (release = r))
  await mockObservations(page, [
    ...nodeRows(O, 'ORIG', { lat: 59.91, lon: 10.75 }),
    ...nodeRows(GW, 'GATE', { lat: 59.95, lon: 11.05, role: 'ROUTER' }),
  ], live)
  await page.setViewportSize({ width: 1000, height: 700 })
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: Hook }).__meshmap)
  await expect(page.locator('.counters')).toContainText('2 positioned')
  await page.waitForTimeout(1500) // initial fit
  await page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.map.jumpTo({ center: [10.9, 59.93], zoom: 10 }))
  await page.waitForTimeout(500)
  release(() => [directReception(O, GW)]) // the stream delivers it now
  const frame = () => page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.pingFrame())
  await expect.poll(() => page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.pings()), { timeout: 10_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1200) // mid-growth: a ring, and its link on the way
  const mid = await frame()
  await docShot(page, 'ping-link.png')
  expect(mid.rings).toBe(1)
  expect(mid.trails).toHaveLength(1)
  expect(mid.trails[0]).toBeGreaterThan(0)
  expect(mid.trails[0]).toBeLessThan(1)
  // The link arrives with the ring, then stays while the ring lingers.
  await expect.poll(async () => (await frame()).trails[0], { timeout: 5000 }).toBe(1)
})
