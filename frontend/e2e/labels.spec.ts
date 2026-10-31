import { expect, test, type Page } from '@playwright/test'
import { docShot } from './shots'

// Names of nodes close together collapse into one ("NAME +N") and fan out
// on hover or while one of them is selected; markers never move.
type HookLayer = { id: string; data: { text?: string }[] }
type Hook = { layers: () => HookLayer[]; map: { jumpTo: (o: object) => void; project: (p: [number, number]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement; isMoving: () => boolean } }

const now = new Date().toISOString()
const mk = (i: number, name: string, lat: number, lon: number, role?: string) => ({
  id: '!' + (0x20000000 + i).toString(16), num: 0x20000000 + i, status: 'observed', packets: 5, receptions: 5, gateway_receptions: 0, is_gateway: false,
  signatures: { verified: 0, unsigned: 5, unverifiable: 0, not_applicable: 0 }, first_seen: now, last_seen: now,
  identity: { long_name: `${name} long`, short_name: name, role, has_public_key: false, signature: 'unsigned', observed_at: now },
  position: { lat, lon, precision_bits: 32, precision_known: true, signature: 'unsigned', observed_at: now },
})
const nodes = [mk(1, 'ALFA', 59.91, 10.75), mk(2, 'BRAV', 59.9102, 10.7502, 'ROUTER'), mk(3, 'CHAR', 59.9101, 10.7505), mk(4, 'FARX', 60.3, 11.2)]

const labels = (page: Page) =>
  page.evaluate(() => {
    const ls = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
    return { texts: (ls.find((l) => l.id === 'node-labels')?.data ?? []).map((d) => d.text).sort(), leaders: ls.find((l) => l.id === 'label-leaders')?.data.length ?? 0 }
  })

test('close-together names collapse, and fan out on hover and selection', async ({ page }) => {
  await page.route('**/api/v1/snapshot*', (route) => {
    const end = new Date()
    route.fulfill({ json: {
      meta: { window: { start: new Date(end.getTime() - 72 * 3600e3).toISOString(), end: end.toISOString(), rolling: true }, revision: 'labels', filters: {}, generated_at: now },
      nodes, edges: [], edges_truncated: false, diagnostics: { relay_ambiguous: 0, relay_unmatched: 0 },
      counts: { packets: 20, receptions: 20, nodes: 4, referenced: 0, positioned: 4, estimated: 0, edges: 0, by_type: {}, nodes_truncated: false },
    } })
  })
  await page.goto('/?derive=server')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: Hook }).__meshmap)
  await expect(page.locator('.counters')).toContainText('4 nodes')
  await page.waitForTimeout(1500) // initial fit-to-data
  await page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.map.jumpTo({ center: [10.7502, 59.9101], zoom: 13 }))
  // Every placed node is labelled (off-screen ones too); the three nearby collapse.
  await expect.poll(() => labels(page)).toEqual({ texts: ['BRAV +2', 'FARX'], leaders: 0 })

  // Hover a marker of the cluster: every name fans out with a leader line.
  const pt = await page.evaluate(() => {
    const m = (window as unknown as { __meshmap: Hook }).__meshmap.map
    const r = m.getCanvas().getBoundingClientRect()
    const p = m.project([10.75, 59.91])
    return { x: r.left + p.x, y: r.top + p.y }
  })
  await page.mouse.move(pt.x, pt.y)
  await expect.poll(async () => (await labels(page)).texts).toEqual(['ALFA', 'BRAV', 'CHAR', 'FARX'])
  expect((await labels(page)).leaders).toBe(3)
  await page.waitForTimeout(300)
  await docShot(page, 'label-fan.png', { clip: { x: pt.x - 200, y: pt.y - 150, width: 400, height: 300 } })

  // Leave: it collapses again after a short grace period.
  await page.mouse.move(pt.x + 300, pt.y + 200)
  await expect.poll(async () => (await labels(page)).texts).toEqual(['BRAV +2', 'FARX'])

  // Select one of them: the cluster stays open while it is selected.
  await page.getByRole('button', { name: 'Nodes & details' }).click()
  await page.locator('.node-row', { hasText: 'ALFA' }).click()
  await expect.poll(async () => (await labels(page)).texts, { timeout: 10_000 }).toEqual(['ALFA', 'BRAV', 'CHAR', 'FARX'])
  await page.mouse.move(5, 300)
  await page.waitForTimeout(800)
  expect((await labels(page)).texts).toEqual(['ALFA', 'BRAV', 'CHAR', 'FARX'])
})
