import { expect, test, type Page } from '@playwright/test'
import { directReception, mockObservations, nodeRows } from './mock'

// Details on synthetic data (e2e/mock.ts): the packet log's live rows and
// resizable columns, and a link's cross section with its mark on the map.

type Hook = { layers: () => { id: string; data: unknown[] }[] }
const nodeId = (n: number) => '!' + n.toString(16).padStart(8, '0')

async function open(page: Page, query = '') {
  await page.goto('/' + query)
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
}

/** The selected node's packet log, from a node link (?node=) that opens Details. */
async function packetLog(page: Page, node: number) {
  await open(page, `?node=${nodeId(node)}`)
  await page.getByRole('tab', { name: /^Packets/ }).click()
  await expect(page.getByRole('heading', { name: /^Packet log/ })).toBeVisible({ timeout: 30_000 })
  return page.getByRole('table', { name: 'Packet log' })
}

test('a packet heard on the live stream joins the open packet log at once', async ({ page }) => {
  const O = 0x32000001, GW = 0x32000002
  let release!: (make: () => ReturnType<typeof directReception>[]) => void
  const live = new Promise<() => ReturnType<typeof directReception>[]>((r) => (release = r))
  await mockObservations(page, [...nodeRows(O, 'ORIG', { lat: 59.91, lon: 10.75, gw: GW }), ...nodeRows(GW, 'GATE', { lat: 59.95, lon: 11.05, role: 'ROUTER' })], live)
  const log = await packetLog(page, O)
  const rows = log.locator('tbody tr')
  await expect(rows.first()).toBeVisible()
  const before = await rows.count()
  release(() => [directReception(O, GW)])
  await expect(rows).toHaveCount(before + 1, { timeout: 15_000 })
})

test('packet log columns resize by drag and keys, are remembered, and reset', async ({ page }) => {
  const O = 0x32000011, GW = 0x32000012
  await mockObservations(page, [...nodeRows(O, 'ORIG', { lat: 59.91, lon: 10.75, gw: GW }), ...nodeRows(GW, 'GATE', { lat: 59.95, lon: 11.05, role: 'ROUTER' })])
  let log = await packetLog(page, O)
  const head = () => log.locator('th').filter({ hasText: /^Type/ })
  const width = async () => (await head().boundingBox())!.width
  const handle = () => page.getByRole('separator', { name: 'Type column width' })
  const before = await width()
  await expect(handle()).toHaveAttribute('aria-valuemin', '28')
  await expect(handle()).toHaveAttribute('aria-valuemax', /\d+/)

  // Drag: wider while dragging, saved only once let go.
  const h = (await handle().boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + 60, h.y + h.height / 2, { steps: 5 })
  await expect(page.locator('body.resizing-col')).toHaveCount(1)
  await page.mouse.up()
  await expect(page.locator('body.resizing-col')).toHaveCount(0)
  await expect.poll(width).toBeGreaterThan(before + 40)
  const wide = await width()
  expect(await page.evaluate(() => localStorage.getItem('meshmap.packetLogColumns'))).toBeTruthy()

  // Remembered across a reload.
  log = await packetLog(page, O)
  await expect.poll(width).toBeCloseTo(wide, 0)

  // Keys: a step per press, and Home gives the default back.
  await handle().focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(width).toBeCloseTo(wide + 10, 0)
  await expect(handle()).toHaveAttribute('aria-valuenow', String(Math.round(wide + 10)))
  await page.keyboard.press('Home')
  await expect.poll(width).toBeCloseTo(before, 0)

  // A shared column says its measured width too.
  await page.getByRole('separator', { name: 'From column width' }).focus()
  await expect(page.getByRole('separator', { name: 'From column width' })).toHaveAttribute('aria-valuenow', /^\d+$/)

  // Double-click resets a dragged column.
  const h2 = (await handle().boundingBox())!
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2)
  await page.mouse.down()
  await page.mouse.move(h2.x + 50, h2.y + h2.height / 2, { steps: 3 })
  await page.mouse.up()
  await expect.poll(width).toBeGreaterThan(before + 30)
  await handle().dblclick()
  await expect.poll(width).toBeCloseTo(before, 0)
  expect(await page.evaluate(() => localStorage.getItem('meshmap.packetLogColumns'))).toBeNull()
})

test("a link's cross section marks the hovered point on the map, and the mark goes with the panel", async ({ page }) => {
  const A = 0x32000021, B = 0x32000022
  await page.addInitScript(() => localStorage.setItem('meshmap:toggles:v6', JSON.stringify({ infraLinks: true, otherLinks: true })))
  await mockObservations(page, [
    ...nodeRows(A, 'ALFA', { lat: 59.91, lon: 10.75, role: 'ROUTER', gw: B }),
    ...nodeRows(B, 'BRAV', { lat: 59.95, lon: 11.05, role: 'ROUTER' }),
  ])
  // A terrain model, whatever the server under test has.
  await page.route('**/api/v1/capabilities*', async (route) => {
    const res = await route.fetch()
    const caps = await res.json()
    return route.fulfill({ response: res, json: { ...caps, features: { ...caps.features, terrain: true } } })
  })
  await page.route('**/api/v1/terrain/classes*', (route) => route.fulfill({ json: { attribution: 'e2e', classes: [] } }))
  await page.route('**/api/v1/terrain/profile*', (route) => {
    const n = 20, L = 20_000
    const samples = Array.from({ length: n }, (_, k) => {
      const f = (k + 1) / (n + 1)
      return { d: f * L, lat: 59.91 + f * 0.04, lon: 10.75 + f * 0.3, ground: 100 + 40 * Math.sin(f * Math.PI), bulge: 5 * f * (1 - f), line: 150, fresnel: 20 * Math.sqrt(f * (1 - f)) }
    })
    return route.fulfill({
      json: { attribution: 'Kartverket (e2e)', class: 'grazing', length_m: L, worst_d: samples[9].d, samples,
        a: { height: 150, ground: 100, source: 'terrain' }, b: { height: 150, ground: 100, source: 'terrain' } },
    })
  })
  await open(page, `?node=${nodeId(A)}`)
  await page.getByRole('tab', { name: /^Links/ }).click()
  await page.locator('ul.links li button').first().click()
  const plot = page.locator('.xsection-plot')
  await expect(plot).toBeVisible({ timeout: 30_000 })

  const probe = () => page.evaluate(() => (window as unknown as { __meshmap: Hook }).__meshmap.layers().some((l) => l.id === 'terrain-probe'))
  const box = (await plot.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('.xsection .tchart-read')).toContainText('from ALFA')
  await expect.poll(probe).toBe(true)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 80)
  await expect.poll(probe).toBe(false)

  // Escape closes Details under the pointer, with no pointerleave: the mark still goes.
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
  await expect.poll(probe).toBe(true)
  await page.keyboard.press('Escape')
  await expect(plot).toBeHidden()
  await expect.poll(probe).toBe(false)
})

test("a node's history over everything kept loads only when opened, by period, and says when there is none (D-195)", async ({ page }) => {
  const N = 0x32000031, GW = 0x32000032, NEW = 0x32000033
  await mockObservations(page, [
    ...nodeRows(N, 'HIST', { lat: 59.91, lon: 10.75, gw: GW, role: 'ROUTER' }),
    ...nodeRows(GW, 'GATE', { lat: 59.95, lon: 11.05 }),
    ...nodeRows(NEW, 'NEWB', { lat: 59.93, lon: 10.9, gw: GW }),
  ])
  // The demo stack holds days, not months: the server's answer is synthetic.
  const asked: string[] = []
  const week = (k: number) => new Date(Date.UTC(2026, 5, 1) + k * 7 * 86_400_000).toISOString()
  await page.route(/\/api\/v1\/trends\/node\//, (route) => {
    const u = new URL(route.request().url())
    asked.push(`${decodeURIComponent(u.pathname.split('/').pop()!)} ${u.searchParams.get('bucket')}`)
    if (u.pathname.endsWith(nodeId(NEW))) return route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{"status":404,"detail":"node not heard in the retained log"}' })
    const n = u.searchParams.get('bucket') === 'month' ? 3 : 12
    return route.fulfill({
      headers: { 'cache-control': 'public, max-age=900, stale-while-revalidate=3600' },
      json: {
        node: nodeId(N), bucket: u.searchParams.get('bucket'), since: week(0),
        buckets: Array.from({ length: n }, (_, k) => ({
          start: week(k), hours: 168, hours_heard: k < 6 ? 160 : 90, hours_gateway: 0, packets: 400 - k, receptions: k < 6 ? 1200 : 500,
          receptions_per_packet: (k < 6 ? 1200 : 500) / (400 - k), ...(k === n - 1 ? {} : { battery_min: k === 2 ? 101 : 80 - k }),
        })),
      },
    })
  })
  await open(page, `?node=${nodeId(N)}`)
  await page.getByRole('tab', { name: /^Overview/ }).click()
  const history = page.locator('details.node-history')
  await expect(history).toBeVisible({ timeout: 30_000 })
  expect(asked).toEqual([]) // nothing fetched while closed

  await history.locator('summary').click()
  await expect(history.getByText(/everything it keeps/)).toBeVisible()
  const table = history.getByRole('table', { name: 'History by period' })
  await expect(table.locator('tbody tr')).toHaveCount(12)
  // Newest first: the last week, heard 90 of 168 hours, no battery report.
  await expect(table.locator('tbody tr').first()).toContainText('90/168 h')
  await expect(table.locator('tbody tr').first().locator('td').last()).toHaveText('—')
  await expect(table.locator('tbody tr').filter({ hasText: 'external power' })).toHaveCount(1)
  await expect(history.locator('figure.bchart')).toHaveCount(4) // never a gateway: no chart of gateway hours
  await expect(history.locator('figure.bchart').filter({ hasText: 'Heard' }).locator('svg')).toHaveAttribute('aria-label', /95 %/)
  await expect(history.locator('figure.bchart').filter({ hasText: 'Gateways per packet' }).locator('.tchart-read')).toContainText('1.3')
  expect(asked).toEqual([`${nodeId(N)} week`])

  await history.getByRole('button', { name: 'Monthly' }).click()
  await expect(table.locator('tbody tr')).toHaveCount(3)
  expect(asked).toContain(`${nodeId(N)} month`)

  // A node not yet in the summaries.
  await open(page, `?node=${nodeId(NEW)}`)
  await page.locator('details.node-history summary').click()
  await expect(page.getByText(/Nothing from this node is in the long-term summaries yet/)).toBeVisible()
})
