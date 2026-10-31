import { expect, test, type Page } from '@playwright/test'
import { docShot } from './shots'
import { mockObservations, nodeRows } from './mock'

// Names of nodes close together collapse into one ("NAME +N") and fan out
// on hover or while one of them is selected; markers never move.
type HookLayer = { id: string; data: { text?: string }[] }
type Hook = { layers: () => HookLayer[]; map: { jumpTo: (o: object) => void; project: (p: [number, number]) => { x: number; y: number }; getCanvas: () => HTMLCanvasElement; isMoving: () => boolean } }

// Three nodes about 30 m apart (their names overlap) and one far away.
const rows = [
  ...nodeRows(0x20000001, 'ALFA', { lat: 59.91, lon: 10.75 }),
  ...nodeRows(0x20000002, 'BRAV', { lat: 59.9102, lon: 10.7502, role: 'ROUTER' }),
  ...nodeRows(0x20000003, 'CHAR', { lat: 59.9101, lon: 10.7505 }),
  ...nodeRows(0x20000004, 'FARX', { lat: 60.3, lon: 11.2 }),
]

const labels = (page: Page) =>
  page.evaluate(() => {
    const ls = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
    return { texts: (ls.find((l) => l.id === 'node-labels')?.data ?? []).map((d) => d.text).sort(), leaders: ls.find((l) => l.id === 'label-leaders')?.data.length ?? 0 }
  })

test('close-together names collapse, and fan out on hover and selection', async ({ page }) => {
  await mockObservations(page, rows)
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: Hook }).__meshmap)
  await expect(page.locator('.counters')).toContainText('4 positioned')
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
