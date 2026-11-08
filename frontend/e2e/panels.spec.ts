import { expect, test, type Page } from '@playwright/test'
import { mapReportRow, mockObservations, nodeRows } from './mock'

// The watchlist (D-192), place search (D-193) and the Regions panel with its
// links (D-194), on synthetic data (e2e/mock.ts), plus the filters' link
// evidence boxes.

type Hook = { layers: () => { id: string; data: unknown[] }[] }
const nodeId = (n: number) => '!' + n.toString(16).padStart(8, '0')

// Two nodes in Trondheim (Trøndelag), heard by each other's gateway.
const A = 0x33000001, GW = 0x33000002
const rows = () => [...nodeRows(A, 'TRDA', { lat: 63.43, lon: 10.4, gw: GW }), ...nodeRows(GW, 'TRGW', { lat: 63.42, lon: 10.45, role: 'ROUTER' })]

async function open(page: Page, query = '') {
  await page.goto('/' + query)
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
}

/** Open a tool-rail panel (D-066), unless it is already open. */
async function showPanel(page: Page, name: string) {
  const b = page.getByRole('button', { name, exact: true })
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click()
}

const layerIds = (page: Page) => page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.layers().map((l) => l.id))

test('a place picked from the search is ringed, and closing the panel clears the ring', async ({ page }) => {
  const asked: string[] = []
  await page.route('**/api/v1/places*', (route) => {
    asked.push(new URL(route.request().url()).searchParams.get('q') ?? '')
    return route.fulfill({ json: { places: [{ name: 'Hamar', kind: 'By', municipality: 'Hamar', county: 'Innlandet', lat: 60.7945, lon: 11.0680 }], attribution: 'Place names: © Kartverket' } })
  })
  await mockObservations(page, rows())
  await open(page)
  await showPanel(page, 'Nodes')
  await page.getByPlaceholder(/Search/).fill('Hamar')
  const places = page.getByRole('region', { name: 'Places' })
  await expect(places).toContainText('Place names: © Kartverket')
  expect(asked).toContain('Hamar')
  await places.getByRole('button', { name: /Hamar/ }).click()
  await expect.poll(() => layerIds(page)).toContain('place')
  // The map goes there.
  const lat = () => page.evaluate(() => (window as unknown as { __meshmap: { map: { getCenter: () => { lat: number } } } }).__meshmap.map.getCenter().lat)
  await expect.poll(async () => Math.abs((await lat()) - 60.79), { timeout: 15_000 }).toBeLessThan(0.3)
  // Closing the panel clears the search, and the ring with it.
  await page.getByRole('button', { name: 'Close nodes' }).click()
  await expect.poll(() => layerIds(page)).not.toContain('place')
  await showPanel(page, 'Nodes')
  await expect(page.getByPlaceholder(/Search/)).toHaveValue('')
})

test('a region link opens its page, also when it names a node too', async ({ page }) => {
  await mockObservations(page, rows())
  await open(page, '?region=Tr%C3%B8ndelag')
  await expect(page.getByRole('button', { name: 'Regions', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const panel = page.getByRole('complementary', { name: 'Regions' })
  await expect(panel.locator('.region-title')).toHaveText('Trøndelag', { timeout: 30_000 })
  await expect(panel.locator('.region-stats')).toContainText('Nodes here')
  // Back to the list: the URL stops naming the region.
  await panel.getByRole('button', { name: '‹ All regions' }).click()
  await expect(panel.getByRole('button', { name: /Vestlandet/ })).toBeVisible()
  await expect(page).not.toHaveURL(/region=/)

  // A region and a node: the region's page, and the node is dropped.
  await open(page, `?region=Vestlandet&node=${nodeId(A)}`)
  await expect(page.getByRole('complementary', { name: 'Regions' }).locator('.region-title')).toHaveText('Vestlandet', { timeout: 30_000 })
  await expect(page).toHaveURL(/region=Vestlandet/)
  await expect(page).not.toHaveURL(/node=/)
})

test('the Regions panel breaks the nodes down by hardware and firmware, for a region and the whole mesh', async ({ page }) => {
  // A runs 2.8 or later as far as its key shows; the gateway states 2.7.15 in its map report.
  // A third node, heard but never placed, counts for the mesh only.
  const LOOSE = 0x33000003
  await mockObservations(page, [
    ...nodeRows(A, 'TRDA', { lat: 63.43, lon: 10.4, gw: GW, hw: 'HELTEC_V3', keyId: A }),
    ...nodeRows(GW, 'TRGW', { lat: 63.42, lon: 10.45, role: 'ROUTER', hw: 'RAK4631' }),
    mapReportRow(GW, { role: 'ROUTER', hw_model: 'RAK4631', modem_preset: 'NARROW_FAST', has_default_channel: true, firmware_version: '2.7.15' }),
    ...nodeRows(LOOSE, 'LOOS', { hw: 'T_ECHO' }), // no gateway heard it: nothing to estimate a position from
  ])
  await open(page, '?region=Tr%C3%B8ndelag')
  const panel = page.getByRole('complementary', { name: 'Regions' })
  const fleet = panel.getByRole('region', { name: 'Hardware and firmware' })
  await expect(fleet).toContainText('2 nodes heard in the selected period whose position or estimate lies in Trøndelag', { timeout: 30_000 })
  for (const text of ['Heltec V3', 'RAK4631', 'Router', 'Narrow Fast', '2.8 or later (inferred)']) await expect(fleet).toContainText(text)
  await expect(fleet).not.toContainText('LilyGO T-Echo')
  // The firmware line opens to its exact versions.
  await expect(fleet).not.toContainText('2.7.15')
  await fleet.getByRole('button', { name: /^2\.7/ }).click()
  await expect(fleet).toContainText('2.7.15')

  // The list: the whole mesh, the unplaced node included.
  await panel.getByRole('button', { name: '‹ All regions' }).click()
  const mesh = panel.getByRole('region', { name: 'Hardware and firmware' })
  await expect(mesh).toContainText('3 nodes heard in the selected period, placed on the map or not')
  await expect(mesh).toContainText('LilyGO T-Echo')
})

test("a region's Share link names the region and period, never the selected node", async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await mockObservations(page, rows())
  // A node is selected (Details), then the Regions panel is opened: the selection stays.
  await open(page, `?node=${nodeId(A)}&duration=24h`)
  await expect(page.locator('.node-panel')).toContainText(nodeId(A), { timeout: 30_000 })
  await showPanel(page, 'Regions')
  const panel = page.getByRole('complementary', { name: 'Regions' })
  await panel.getByRole('button', { name: /Trøndelag/ }).click()
  await expect(panel.locator('.region-title')).toHaveText('Trøndelag')
  await expect(page).toHaveURL(/node=/) // the address bar still carries the selection
  await panel.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible()
  const link = new URL(await page.evaluate(() => navigator.clipboard.readText()))
  expect(link.searchParams.get('region')).toBe('Trøndelag')
  expect(link.searchParams.get('duration')).toBe('24h')
  expect(link.searchParams.has('node')).toBe(false)
})

test('a watched node is listed at the top of Nodes, and stays watched after a reload', async ({ page }) => {
  await mockObservations(page, rows())
  await open(page)
  await showPanel(page, 'Nodes')
  await expect(page.locator('.watch-hint')).toContainText('kept in this browser only')
  await open(page, `?node=${nodeId(A)}`)
  const watch = page.getByRole('button', { name: '☆ Watch' })
  await watch.click()
  await expect(page.getByRole('button', { name: '★ Watching' })).toHaveAttribute('aria-pressed', 'true')
  await showPanel(page, 'Nodes')
  const list = page.getByRole('region', { name: 'Watched nodes' })
  await expect(list.getByRole('heading')).toHaveText('Watched (1)')
  await expect(list.locator('.watch-row')).toContainText('TRDA long')
  await expect(list.locator('.watch-row')).toContainText(/heard .* ago/)
  // Above the search.
  const listBox = (await list.boundingBox())!, searchBox = (await page.getByPlaceholder(/Search/).boundingBox())!
  expect(listBox.y).toBeLessThan(searchBox.y)

  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
  await showPanel(page, 'Nodes')
  const again = page.getByRole('region', { name: 'Watched nodes' })
  await expect(again.locator('.watch-row')).toContainText('TRDA long')
  // Stop watching: the list goes, the hint is back.
  await again.getByRole('button', { name: 'Stop watching TRDA long' }).click()
  await expect(page.getByRole('region', { name: 'Watched nodes' })).toHaveCount(0)
  await expect(page.locator('.watch-hint')).toBeVisible()
})

test('the last link evidence box left checked cannot be unchecked', async ({ page }) => {
  await open(page)
  await showPanel(page, 'Filters')
  const panel = page.getByRole('complementary', { name: 'Filters' })
  const boxes = ['NeighborInfo', 'Traceroute', 'Heard directly by a gateway', 'Guessed from relay byte'].map((n) => panel.getByLabel(n, { exact: true }))
  for (const b of boxes) await expect(b).toBeChecked() // none chosen: every kind counts
  for (const b of boxes.slice(0, 3)) await b.uncheck()
  await expect(boxes[3]).toBeChecked()
  await expect(boxes[3]).toBeDisabled()
  await expect(panel.locator('.filter-head')).toContainText('1 filter active')
  // Turning another back on frees it.
  await boxes[0].check()
  await expect(boxes[3]).toBeEnabled()
})
