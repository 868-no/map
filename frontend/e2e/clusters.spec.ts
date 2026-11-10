import { expect, test, type Page } from '@playwright/test'
import { mockObservations, nodeRows } from './mock'

// D-204: below zoom 10, markers that overlap are one disc with their count,
// at their most prominent member; hover lists them, a click zooms in until
// they come apart, and a selected node is always drawn on its own.
type Placed = { lon: number; lat: number; node: { id: string } }
type HookLayer = { id: string; data: unknown[] }
type Hook = {
  layers: () => HookLayer[]
  map: { jumpTo: (o: object) => void; project: (p: [number, number]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement; getZoom: () => number; isMoving: () => boolean }
}

// Three nodes within a few hundred metres in Trondheim (a router among them) and one in Oslo.
const rows = [
  ...nodeRows(0x30000001, 'ALFA', { lat: 63.43, lon: 10.39 }),
  ...nodeRows(0x30000002, 'BRAV', { lat: 63.432, lon: 10.395, role: 'ROUTER' }),
  ...nodeRows(0x30000003, 'CHAR', { lat: 63.428, lon: 10.4 }),
  ...nodeRows(0x30000004, 'FARX', { lat: 59.91, lon: 10.75 }),
]

const drawn = (page: Page) =>
  page.evaluate(() => {
    const ls = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
    const nodes = (ls.find((l) => l.id === 'nodes')?.data ?? []) as Placed[]
    const clusters = (ls.find((l) => l.id === 'node-clusters')?.data ?? []) as { rep: Placed; members: Placed[] }[]
    return { nodes: nodes.length, clusters: clusters.map((k) => ({ rep: k.rep.node.id, n: k.members.length })) }
  })

const jump = (page: Page, center: [number, number], zoom: number) =>
  page.evaluate(([center, zoom]) => (window as unknown as { __meshmap: Hook }).__meshmap.map.jumpTo({ center, zoom }), [center, zoom] as const)

test('overlapping markers cluster at low zoom; hover lists them, click zooms in, selection stays apart', async ({ page }) => {
  await mockObservations(page, rows)
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: Hook }).__meshmap)
  await expect(page.locator('.counters')).toContainText('4 positioned') // counts stay complete
  await page.waitForTimeout(1500) // initial fit-to-data
  await jump(page, [10.4, 63.43], 7)
  await expect.poll(() => drawn(page)).toEqual({ nodes: 1, clusters: [{ rep: '!30000002', n: 3 }] }) // at the router

  // Hover the disc: its members, most prominent first.
  const pt = await page.evaluate(() => {
    const m = (window as unknown as { __meshmap: Hook }).__meshmap.map
    const r = m.getCanvas().getBoundingClientRect()
    const p = m.project([10.395, 63.432])
    return { x: r.left + p.x, y: r.top + p.y }
  })
  await page.mouse.move(pt.x, pt.y)
  const tip = page.getByRole('tooltip')
  await expect(tip).toContainText('3 nodes close together')
  await expect(tip).toContainText('BRAV')

  // Click: the map zooms in until they come apart.
  await page.mouse.click(pt.x, pt.y)
  await expect.poll(() => page.evaluate(() => {
    const m = (window as unknown as { __meshmap: Hook }).__meshmap.map
    return m.getZoom() >= 10 && !m.isMoving()
  }), { timeout: 10_000 }).toBe(true)
  await expect.poll(() => drawn(page)).toEqual({ nodes: 4, clusters: [] })
  await expect(page).not.toHaveURL(/node=/) // zooming in selects nothing

  // A selected node never hides in a cluster, zoomed out again.
  await page.getByRole('button', { name: 'Nodes', exact: true }).click()
  await page.locator('.node-row', { hasText: 'ALFA' }).click()
  await expect.poll(() => page.evaluate(() => !(window as unknown as { __meshmap: Hook }).__meshmap.map.isMoving()), { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(800) // the fly to the selection
  await jump(page, [10.4, 63.43], 7)
  await expect.poll(() => drawn(page)).toEqual({ nodes: 2, clusters: [{ rep: '!30000002', n: 2 }] })
})

test('a watched node is never hidden in a cluster (D-192)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('meshmap.watch', JSON.stringify({ ids: ['!30000003'], notify: false })))
  await mockObservations(page, rows)
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: Hook }).__meshmap)
  await expect(page.locator('.counters')).toContainText('4 positioned')
  await page.waitForTimeout(1500) // initial fit-to-data
  await jump(page, [10.4, 63.43], 7)
  await expect.poll(() => drawn(page)).toEqual({ nodes: 2, clusters: [{ rep: '!30000002', n: 2 }] })
})
