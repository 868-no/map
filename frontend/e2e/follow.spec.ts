import { expect, test } from '@playwright/test'
import type { ObsRow } from '../src/api/types'
import { mockObservations, nodeRows } from './mock'

// The view follows the selected node when it moves (D-210).

type M = {
  jumpTo: (o: object) => void
  getCenter: () => { lng: number; lat: number }
  isMoving: () => boolean
  project: (p: [number, number]) => { x: number; y: number }
}
type Hook = { __meshmap: { map: M } }

const N = 0x33000001, GW = 0x33000002

test('a selected node that moves keeps its place on screen', async ({ page }) => {
  test.setTimeout(90_000)
  let release!: (make: () => ObsRow[]) => void
  const live = new Promise<() => ObsRow[]>((r) => (release = r))
  await mockObservations(page, [
    ...nodeRows(N, 'MOVER', { lat: 59.91, lon: 10.75 }),
    ...nodeRows(GW, 'GATE', { lat: 59.95, lon: 11.05, role: 'ROUTER' }),
  ], live)
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto('/?node=!33000001')
  await page.waitForFunction(() => !!(window as unknown as Partial<Hook>).__meshmap, null, { timeout: 30_000 })
  await expect(page.locator('.node-panel h2')).toBeVisible({ timeout: 30_000 })
  const moving = () => page.evaluate(() => (window as unknown as Hook).__meshmap.map.isMoving())
  await expect.poll(moving, { timeout: 10_000 }).toBe(false)
  await page.waitForTimeout(1000) // the flight, if it starts late

  // The viewer puts the node off centre, then it reports a position 2 km east.
  await page.evaluate(() => (window as unknown as Hook).__meshmap.map.jumpTo({ center: [10.7, 59.9], zoom: 11 }))
  const at = (lon: number, lat: number) => page.evaluate(([x, y]) => (window as unknown as Hook).__meshmap.map.project([x, y]), [lon, lat])
  const before = await at(10.75, 59.91)
  const centre = await page.evaluate(() => (window as unknown as Hook).__meshmap.map.getCenter())
  release(() => nodeRows(N, 'MOVER', { lat: 59.91, lon: 10.786, t: Date.now() - 1000 }))

  // The view pans by the move: the node's new position is where the old one was.
  await expect.poll(async () => {
    if (await moving()) return Infinity
    const p = await at(10.786, 59.91)
    return Math.hypot(p.x - before.x, p.y - before.y)
  }, { timeout: 30_000 }).toBeLessThan(1)
  const after = await page.evaluate(() => (window as unknown as Hook).__meshmap.map.getCenter())
  expect(after.lng - centre.lng).toBeCloseTo(0.036, 3)
  expect(after.lat).toBeCloseTo(centre.lat, 4)
})
