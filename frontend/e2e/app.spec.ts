import { expect, test, type Page } from '@playwright/test'
import { docShot } from './shots'

type Labels = { counts: Record<string, number>; names: Record<string, string[]> }
// Shape of the e2e hook's layers(): our own mesh layers (id + data).
type HookLayer = { id: string; data: unknown[] }
type Hook = { layers: () => HookLayer[] }

/** Turn both link layers on (off by default, D-047) before the page loads. */
async function withLinks(page: Page) {
  await page.addInitScript(() => localStorage.setItem('meshmap:toggles:v5', JSON.stringify({ infraLinks: true, otherLinks: true })))
}

async function ready(page: Page) {
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
}

/** Open a tool-rail panel (D-066), unless it is already open. */
async function showPanel(page: Page, name: string) {
  const b = page.getByRole('button', { name, exact: true })
  if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click()
}
const openPanel = (page: Page) => showPanel(page, 'Nodes')

async function viewAt(page: Page, lat: number, lon: number, zoom: number): Promise<Labels> {
  await page.evaluate(([lat, lon, zoom]) => (window as unknown as { __meshmap: { map: { jumpTo: (o: object) => void } } }).__meshmap.map.jumpTo({ center: [lon, lat], zoom }), [lat, lon, zoom])
  await page.waitForTimeout(300)
  await page.waitForFunction(() => {
    const m = (window as unknown as { __meshmap: { map: { loaded: () => boolean; areTilesLoaded: () => boolean } } }).__meshmap.map
    return m.loaded() && m.areTilesLoaded()
  }, null, { timeout: 30_000 })
  await page.waitForTimeout(500) // symbol placement
  return page.evaluate(() => (window as unknown as { __meshmap: { queryLabels: () => Labels } }).__meshmap.queryLabels())
}

const sum = (l: Labels, prefix: string) => Object.entries(l.counts).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0)

type MapHook = { map: { getPaintProperty: (layer: string, prop: string) => unknown } }
const pageBg = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)
const mapBg = (page: Page) => page.evaluate(() => (window as unknown as { __meshmap: MapHook }).__meshmap.map.getPaintProperty('background', 'background-color'))

// D-051: the theme follows the browser unless the viewer picks one; the
// choice is remembered and applied before the first paint.
test('follows the browser theme, and a chosen theme overrides it from the first paint', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await ready(page)
  expect(await pageBg(page)).toBe('rgb(246, 247, 249)')
  await expect.poll(() => mapBg(page)).toBe('#f3f1ec')
  await expect(page.locator('.topbar h1')).toHaveText('868.no Map')

  await showPanel(page, 'Settings')
  await page.getByRole('complementary', { name: 'Settings' }).getByLabel('Dark').check()
  await expect.poll(() => pageBg(page)).toBe('rgb(14, 17, 22)')
  await expect.poll(() => mapBg(page)).toBe('#0e1116')

  // Before any app code runs, the saved choice already applies.
  await page.goto('/', { waitUntil: 'commit' })
  await page.waitForSelector('html[data-theme]', { state: 'attached' })
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
  await showPanel(page, 'Settings')
  await page.getByRole('complementary', { name: 'Settings' }).getByLabel('Auto').check()
  await expect.poll(() => pageBg(page)).toBe('rgb(246, 247, 249)')
  await expect.poll(() => mapBg(page)).toBe('#f3f1ec')
})

async function showLayers(page: Page, names: string[]) {
  await showPanel(page, 'Layers')
  const panel = page.getByRole('complementary', { name: 'Layers' })
  for (const n of names) await panel.getByLabel(n).check()
  await page.getByRole('button', { name: 'Close layers' }).click()
}

test('basemap names are hidden by default and the choice is remembered', async ({ page }) => {
  await ready(page)
  const l = await viewAt(page, 63.43, 10.40, 10)
  expect(sum(l, 'place-') + sum(l, 'road-name') + sum(l, 'mountain-peak')).toBe(0)
  expect(sum(l, 'road-')).toBe(0)
  expect(l.counts['water'] ?? 0).toBeGreaterThan(0)
  await showLayers(page, ['Place names'])
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
  await expect.poll(async () => (await viewAt(page, 63.43, 10.40, 10)).names['place-city'] ?? [], { timeout: 30_000 }).toContain('Trondheim')
})

test('genuine place, peak, road and border labels render (self-hosted basemap)', async ({ page }) => {
  await ready(page)
  await showLayers(page, ['Place names', 'Peaks', 'Road names and numbers', 'Major roads', 'Minor roads and rail'])
  const labels = () => page.evaluate(() => (window as unknown as { __meshmap: { queryLabels: () => Labels } }).__meshmap.queryLabels())
  // Labels are placed asynchronously after tiles load: poll until present.
  await viewAt(page, 63.43, 10.40, 10)
  await expect.poll(async () => (await labels()).names['place-city'] ?? [], { timeout: 30_000 }).toContain('Trondheim')
  await expect.poll(async () => sum(await labels(), 'road-')).toBeGreaterThan(0)
  await docShot(page, 'trondheim.png')
  await viewAt(page, 61.636, 8.312, 11) // Jotunheimen
  await expect.poll(async () => ((await labels()).names['mountain-peak'] ?? []).length, { timeout: 30_000 }).toBeGreaterThan(0)
  await docShot(page, 'peaks-jotunheimen.png')
  await viewAt(page, 63.33, 12.1, 8) // Storlien: Norway–Sweden border
  await expect.poll(async () => (await labels()).counts['boundary-country'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0)
  await docShot(page, 'border-storlien.png')
})

test('default rolling 3-day window, presets and node details', async ({ page }) => {
  // Views are built in the browser from /observations (the worker's requests
  // are reported on the page); ?derive=server would use /snapshot instead.
  const snapshots: string[] = []
  page.on('request', (r) => /\/api\/v1\/(snapshot|observations)/.test(r.url()) && snapshots.push(r.url()))
  await ready(page)
  await expect(page.locator('.badge')).toContainText('LIVE')
  await expect.poll(() => snapshots.some((u) => u.includes('duration=72h'))).toBe(true)
  await showPanel(page, 'Period')
  await page.getByRole('button', { name: '24h', exact: true }).click()
  await expect.poll(() => snapshots.some((u) => u.includes('duration=24h'))).toBe(true)
  await expect(page).toHaveURL(/duration=24h/)
  await page.getByRole('button', { name: '3d', exact: true }).click()
  await openPanel(page)
  const first = page.locator('.node-row').first()
  await expect(first).toBeVisible()
  await first.click()
  await expect(page.locator('.node-panel h2')).toBeVisible()
  await expect(page.locator('.node-panel')).toContainText('Seen in window')
  await page.waitForTimeout(800) // fly-to animation
  await page.waitForFunction(() => {
    const m = (window as unknown as { __meshmap: { map: { loaded: () => boolean; areTilesLoaded: () => boolean } } }).__meshmap.map
    return m.loaded() && m.areTilesLoaded()
  })
  await page.waitForTimeout(500)
  await docShot(page, 'node-details.png')
  await page.getByRole('button', { name: 'Fit to data' }).click()
  await page.waitForTimeout(1500)
  await docShot(page, 'live-overview.png')
})

test('API payloads never carry envelopes, ciphertext or message bodies', async ({ page }) => {
  test.setTimeout(90_000)
  const bodies: string[] = []
  page.on('response', async (r) => {
    // Superseded responses (e.g. a live refresh) may have no retrievable body.
    if (r.url().includes('/api/v1/') && !r.url().includes('/stream') && r.ok()) bodies.push(await r.text().catch(() => ''))
  })
  await ready(page)
  await openPanel(page)
  await page.locator('.node-row').first().click()
  await expect(page.locator('.node-panel h2')).toBeVisible()
  // capabilities, retention, observations (node details are built in the browser)
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(3)
  // The live stream carries full rows now: check one delta as well.
  bodies.push(await page.evaluate(() => new Promise<string>((resolve) => {
    const es = new EventSource('/api/v1/stream?duration=72h')
    const done = (s: string) => { es.close(); resolve(s) }
    es.addEventListener('delta', (e) => done((e as MessageEvent).data))
    setTimeout(() => done(''), 45_000)
  })))
  // A quiet mesh may send nothing in that time; the stream's rows are the
  // same rows /observations returns, which were checked above either way.
  if (bodies.at(-1) !== '') expect(bodies.at(-1)).toContain('"row"')
  else test.info().annotations.push({ type: 'note', description: 'no live traffic within 45 s; stream payload not sampled' })
  for (const b of bodies) {
    expect(b).not.toMatch(/"(envelope_bytes|envelope|encrypted|payload|psk|xeddsa_signature)"/)
  }
})

test('slide the window back, then return to live', async ({ page }) => {
  await ready(page)
  await page.locator('.live-indicator .badge').click() // the header's indicator opens the Period panel (D-067)
  await expect(page.getByRole('complementary', { name: 'Period' })).toBeVisible()
  await page.getByRole('button', { name: 'Move window back' }).click()
  await expect(page.locator('.badge')).toContainText('HISTORICAL')
  await expect(page).toHaveURL(/start=.*end=/)
  await expect(page).not.toHaveURL(/at=/)
  await page.getByRole('button', { name: 'Return to live' }).click()
  await expect(page.locator('.badge')).toContainText('LIVE')
})

test('rejects nothing silently: invalid URL windows fall back, mobile layout works', async ({ page }) => {
  await page.goto('/?start=garbage&end=nope')
  await expect(page.locator('.badge')).toContainText('LIVE')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('#dock')).toBeHidden()
  await openPanel(page)
  await expect(page.locator('#dock')).toBeVisible()
  await expect(page.locator('.live-indicator')).toBeVisible()
  await expect(page.locator('.node-row').first()).toBeVisible()
  await page.getByRole('button', { name: 'Fit to data' }).click()
  await page.waitForTimeout(1500)
  await docShot(page, 'mobile.png')
})

test('legend explains role sizes and a last-heard scale that follows the window', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  await showPanel(page, 'Legend')
  await expect(page.locator('.age-labels')).toContainText('72 h before')
  await expect(page.locator('.legend')).toContainText('ROUTER_LATE')
  await showPanel(page, 'Period')
  await page.getByRole('button', { name: '24h', exact: true }).click()
  await showPanel(page, 'Legend')
  await expect(page.locator('.age-labels')).toContainText('24 h before')
})

test('selecting a node shows only its links, and accuracy circles only for it', async ({ page }) => {
  await withLinks(page)
  await ready(page)
  const layerData = () =>
    page.evaluate(() => {
      const layers = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
      const links = layers.filter((l) => l.id.startsWith('links-')).flatMap((l) => l.data as { a: string; b: string }[])
      const circles = layers.filter((l) => l.id === 'uncertainty').flatMap((l) => l.data)
      return { links: links.map((g) => [g.a, g.b]), circles: circles.length }
    })
  await expect.poll(async () => (await layerData()).links.length, { timeout: 30_000 }).toBeGreaterThan(1)
  expect((await layerData()).circles).toBe(0) // off by default
  // Pick a node that has links.
  const all = (await layerData()).links
  const id = all[0][0]
  await openPanel(page)
  await page.getByPlaceholder(/Search/).fill(id)
  await page.locator('.node-row').first().click()
  await expect.poll(async () => {
    const l = (await layerData()).links
    return l.length > 0 && l.every(([a, b]) => a === id || b === id)
  }).toBe(true)
  await page.getByRole('button', { name: 'Close details' }).click()
  // Other nodes' links come back (the count differs: selecting zoomed in, so viewport culling applies).
  await expect.poll(async () => (await layerData()).links.some(([a, b]) => a !== id && b !== id)).toBe(true)
})

test('the panel is closed until something is selected, and closes again when the selection closes', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#dock')).toBeHidden()
  await openPanel(page)
  await expect(page.locator('#dock')).toBeVisible()
  await page.locator('.node-row').first().click()
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Details', exact: true }).click() // its rail button closes it, and clears the selection
  await expect(page.locator('#dock')).toBeHidden()
  // Select a node on the map itself: the panel opens on Details, and closing the details hides it again.
  await page.waitForFunction(() => {
    const l = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
    return (l.find((x) => x.id === 'nodes')?.data.length ?? 0) > 0
  }, null, { timeout: 30_000 })
  const hit = await page.evaluate(() => {
    const mm = (window as unknown as { __meshmap: Hook & { map: { project: (p: [number, number]) => { x: number; y: number } } } }).__meshmap
    const nodes = mm.layers().find((l) => l.id === 'nodes')!.data as { lon: number; lat: number }[]
    const p = mm.map.project([nodes[0].lon, nodes[0].lat])
    return { x: p.x, y: p.y, lon: nodes[0].lon, lat: nodes[0].lat }
  })
  await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: { map: { jumpTo: (o: object) => void } } }).__meshmap.map.jumpTo({ center: [lon, lat], zoom: 11 }), [hit.lon, hit.lat])
  await page.waitForTimeout(800)
  const box = (await page.locator('.map').boundingBox())!
  const pt = await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: { map: { project: (p: [number, number]) => { x: number; y: number } } } }).__meshmap.map.project([lon, lat]), [hit.lon, hit.lat])
  await page.mouse.move(box.x + pt.x, box.y + pt.y)
  await page.waitForTimeout(300)
  // Hovering the node first, as a user would: a tooltip, or its name cluster fanning out.
  await expect.poll(async () => (await page.locator('.tooltip').isVisible()) || (await page.evaluate(() =>
    (window as unknown as { __meshmap: Hook }).__meshmap.layers().some((l) => l.id === 'label-leaders')))).toBe(true)
  await page.mouse.click(box.x + pt.x, box.y + pt.y)
  await expect(page.locator('#dock')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page.locator('#dock')).toBeHidden()
})

test('starts fitted to the data, and clicking empty map clears the selection', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap)
  const view = () => page.evaluate(() => {
    const m = (window as unknown as { __meshmap: { map: { getZoom: () => number; getCenter: () => { lng: number; lat: number } } } }).__meshmap.map
    return { z: m.getZoom(), c: m.getCenter() }
  })
  const caps = await (await page.request.get('/api/v1/capabilities')).json()
  await expect.poll(async () => Math.abs((await view()).z - caps.map.zoom) > 1e-3 || Math.abs((await view()).c.lat - caps.map.lat) > 1e-3, { timeout: 30_000 }).toBe(true)
  // Select a node from the list, then click empty sea far from any node.
  await openPanel(page)
  await page.locator('.node-row').first().click()
  await expect(page.locator('.node-panel')).toBeVisible()
  await page.evaluate(() => (window as unknown as { __meshmap: { map: { jumpTo: (o: object) => void } } }).__meshmap.map.jumpTo({ center: [3.0, 66.0], zoom: 8 })) // open Norwegian Sea
  await page.waitForTimeout(500)
  const box = (await page.locator('.map').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('.node-panel')).toHaveCount(0)
})

test('panels overlay the map without resizing it, and the map reaches the bottom edge', async ({ page }) => {
  await ready(page)
  await page.waitForTimeout(1000)
  const canvas = () => page.evaluate(() => { const c = (window as unknown as { __meshmap: { map: { getCanvas: () => HTMLCanvasElement } } }).__meshmap.map.getCanvas(); const r = c.getBoundingClientRect(); return [r.width, r.height, Math.round(r.bottom)] })
  const size = await canvas()
  expect(size[2]).toBe(page.viewportSize()!.height) // no bar along the bottom (D-067)
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight)).toBe(0)
  await showPanel(page, 'Period')
  await expect(page.getByRole('slider', { name: 'Window start' })).toBeInViewport()
  expect(await canvas()).toEqual(size)
})

test('every layer switch explains its data in a tooltip', async ({ page }) => {
  await ready(page)
  await showPanel(page, 'Layers')
  const titles = await page.getByRole('complementary', { name: 'Layers' }).locator('label').evaluateAll((ls) => ls.map((l) => l.getAttribute('title') ?? ''))
  expect(titles.length).toBeGreaterThan(10)
  for (const t of titles) expect(t.length).toBeGreaterThan(20)
})

test('live rows from the stream update the views without fetching', async ({ page }) => {
  test.setTimeout(120_000)
  await ready(page)
  await expect(page.locator('.counters')).toContainText('packets')
  const packets = async () => Number(/(\d+) packets/.exec((await page.locator('.counters').textContent()) ?? '')?.[1] ?? 0)
  await page.waitForTimeout(2000) // initial sync settled
  const fetches: string[] = []
  page.on('request', (r) => r.url().includes('/api/v1/observations') && fetches.push(r.url()))
  const before = await packets()
  // The real mesh sends a packet every few seconds; the stream delivers it as a row.
  await expect.poll(packets, { timeout: 50_000, intervals: [1000] }).toBeGreaterThan(before)
  expect(fetches).toEqual([])
})

test('the packet log combines own and relayed packets, and draws a packet route instead of links', async ({ page }) => {
  test.setTimeout(120_000)
  await withLinks(page)
  await ready(page)
  await openPanel(page)
  const log = page.getByRole('table', { name: 'Packet log' })
  const toggle = page.getByLabel(/Include relayed/)
  // A node that relayed something, so the toggle changes the list.
  const rows = page.locator('.node-row')
  for (let i = 0; i < 15; i++) {
    await showPanel(page, 'Nodes')
    await rows.nth(i).click()
    await expect(page.getByRole('heading', { name: /^Packet log/ })).toBeVisible()
    if (i === 0) await expect(toggle).not.toBeChecked() // own packets only by default
    await toggle.check()
    await page.waitForTimeout(300)
    if (await log.locator('tbody tr button.linkish').count()) break
  }
  const total = async () => Number(/\((\d+)/.exec((await page.getByRole('heading', { name: /^Packet log/ }).textContent()) ?? '')?.[1])
  const all = await total()
  await toggle.uncheck()
  await expect(log.locator('tbody tr button.linkish')).toHaveCount(0) // only own packets
  expect(await total()).toBeLessThan(all)
  await toggle.check()

  const layers = () => page.evaluate(() => Object.fromEntries((window as unknown as { __meshmap: Hook }).__meshmap.layers().map((l) => [l.id, l.data.length])))
  const links = async () => Object.entries(await layers()).reduce((n, [k, v]) => n + (k.startsWith('links-') ? v : 0), 0)
  await expect.poll(links).toBeGreaterThan(0)
  // Pick a packet; its route replaces the links.
  await log.locator('tbody tr').first().click()
  await expect(page.locator('.route-note')).toBeVisible()
  await expect.poll(async () => 'route' in (await layers()) && (await links()) === 0).toBe(true)
  await expect(log.locator('tbody tr.active')).toHaveCount(1)
  // Clicking it again clears the route and brings the links back.
  await log.locator('tbody tr.active').click()
  await expect(page.locator('.route-note')).toBeHidden()
  await expect.poll(links).toBeGreaterThan(0)
  expect('route' in (await layers())).toBe(false)
})

test('the map flies to a selected node once, not again when data refreshes', async ({ page }) => {
  test.setTimeout(90_000)
  await ready(page)
  await openPanel(page)
  await page.locator('.node-row').first().click()
  await expect(page.locator('.node-panel h2')).toBeVisible()
  await page.waitForTimeout(1500) // the fly-to
  // Move away; live rows keep rebuilding the views (at most 15 s apart for the default 72 h).
  await page.evaluate(() => (window as unknown as { __meshmap: { map: { jumpTo: (o: object) => void } } }).__meshmap.map.jumpTo({ center: [5.0, 58.0], zoom: 7 }))
  await page.waitForTimeout(20_000)
  const c = await page.evaluate(() => (window as unknown as { __meshmap: { map: { getCenter: () => { lng: number; lat: number } } } }).__meshmap.map.getCenter())
  expect(Math.abs(c.lng - 5.0)).toBeLessThan(1e-6)
  expect(Math.abs(c.lat - 58.0)).toBeLessThan(1e-6)
})

test('the regions layer draws the five landsdeler, names them at overview zooms and credits Kartverket', async ({ page }) => {
  test.setTimeout(90_000)
  await ready(page)
  const layers = () => page.evaluate(() => Object.fromEntries((window as unknown as { __meshmap: Hook }).__meshmap.layers().map((l) => [l.id, l.data])))
  expect('regions' in (await layers())).toBe(false) // off by default
  await expect(page.locator('.attribution')).not.toContainText('Kartverket')
  await showLayers(page, ['Regions (landsdeler)'])
  await viewAt(page, 65.4, 15.5, 4.1)
  await expect.poll(async () => ((await layers()).regions as unknown as { features?: unknown[] } | undefined)?.features?.length ?? 0).toBe(5)
  const names = ((await layers())['region-labels'] as { name: string }[]).map((l) => l.name)
  expect(names.sort()).toEqual(['Nord-Norge', 'Sørlandet', 'Trøndelag', 'Vestlandet', 'Østlandet'])
  await expect(page.locator('.attribution')).toContainText('© Kartverket')
  await page.waitForTimeout(500)
  await docShot(page, 'regions.png')
  // Zoomed in, the outlines stay and the names give way to node names.
  await viewAt(page, 63.43, 10.4, 10)
  await expect.poll(async () => Object.keys(await layers())).toContain('regions')
  expect('region-labels' in (await layers())).toBe(false)
})

// D-066: every control panel sits on the tool rail; active filters show as a badge there.
test('the tool rail opens one panel at a time and counts active filters', async ({ page }) => {
  await ready(page)
  const filters = page.getByRole('button', { name: 'Filters', exact: true })
  await expect(filters.locator('.rail-badge')).toHaveCount(0)
  await showPanel(page, 'Filters')
  const panel = page.getByRole('complementary', { name: 'Filters' })
  await panel.getByRole('button', { name: 'position' }).click()
  await panel.getByLabel('Only nodes with reported positions').check()
  await expect(filters.locator('.rail-badge')).toHaveText('2')
  await expect(page).toHaveURL(/type=position/)
  await panel.getByRole('button', { name: 'Reset' }).click()
  await expect(filters.locator('.rail-badge')).toHaveCount(0)
  // Another rail button swaps the panel; pressing the open one closes it.
  await showPanel(page, 'Legend')
  await expect(page.getByRole('complementary', { name: 'Legend' })).toBeVisible()
  await page.getByRole('button', { name: 'Legend', exact: true }).click()
  await expect(page.locator('#dock')).toBeHidden()
})

// D-069: a selected node's reach at each hop limit, drawn instead of its links.
test('the reach simulator counts nodes per hop limit and draws the reach on the map', async ({ page }) => {
  await withLinks(page)
  await ready(page)
  const layers = () => page.evaluate(() => Object.fromEntries((window as unknown as { __meshmap: Hook }).__meshmap.layers().map((l) => [l.id, l.data.length])))
  // A node with links, so it reaches someone.
  await expect.poll(async () => (await layers())['links-infra'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(0)
  const id = await page.evaluate(() => ((window as unknown as { __meshmap: Hook }).__meshmap.layers().find((l) => l.id === 'links-infra')!.data[0] as { a: string }).a)
  await openPanel(page)
  await page.getByPlaceholder(/Search/).fill(id)
  await page.locator('.node-row').first().click()
  const reach = page.locator('.reach')
  await expect(reach).toContainText(/Reaches \d+ node/)
  const slider = reach.getByRole('slider', { name: 'Max hops' })
  await slider.fill('0')
  const direct = Number(/Reaches (\d+)/.exec((await reach.textContent()) ?? '')![1])
  expect(direct).toBeGreaterThan(0) // it has links: someone hears it directly
  await slider.fill('7')
  expect(Number(/Reaches (\d+)/.exec((await reach.textContent()) ?? '')![1])).toBeGreaterThanOrEqual(direct)
  await reach.getByLabel('Show on the map').check()
  await expect.poll(async () => (await layers()).reach ?? 0).toBeGreaterThan(0)
  expect(Object.entries(await layers()).some(([k, n]) => k.startsWith('links-') && n > 0)).toBe(false) // reach replaces the links
  // Every drawn path leads back to the node, dashed across relays without a position.
  const orphans = await page.evaluate((origin) => {
    const ls = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
    const segs = ls.filter((l) => l.id === 'reach' || l.id === 'reach-gaps').flatMap((l) => l.data as { from: number[]; to: number[] }[])
    const o = (ls.find((l) => l.id === 'nodes')!.data as { lon: number; lat: number; node: { id: string } }[]).find((n) => n.node.id === origin)!
    const reached = new Set([`${o.lon},${o.lat}`])
    for (let grew = true; grew; ) {
      grew = false
      for (const sg of segs) if (reached.has(sg.from.join(',')) && !reached.has(sg.to.join(','))) { reached.add(sg.to.join(',')); grew = true }
    }
    return segs.filter((sg) => !reached.has(sg.from.join(','))).length
  }, id)
  expect(orphans).toBe(0)
  await page.waitForTimeout(1500) // the camera flew to the node when it was selected
  await docShot(page, 'reach.png')
  await reach.getByLabel('Show on the map').uncheck()
  await expect.poll(async () => 'reach' in (await layers())).toBe(false)
})
