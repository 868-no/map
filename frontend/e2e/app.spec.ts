import { expect, test, type Page } from '@playwright/test'
import { directReception, mockObservations, nodeRows } from './mock'
import { docShot } from './shots'

type Labels = { counts: Record<string, number>; names: Record<string, string[]> }
// Shape of the e2e hook's layers(): our own mesh layers (id + data).
type HookLayer = { id: string; data: unknown[] }
type Hook = { layers: () => HookLayer[] }

/** Turn both link layers on (off by default, D-047) before the page loads. */
async function withLinks(page: Page) {
  await page.addInitScript(() => localStorage.setItem('meshmap:toggles:v6', JSON.stringify({ infraLinks: true, otherLinks: true })))
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

test('roads and city names show by default, local names on request, and the choice is remembered', async ({ page }) => {
  test.skip(!!process.env.MESHMAP_NO_BASEMAP, 'needs the self-hosted basemap (not built in CI)')
  await ready(page)
  const labels = () => page.evaluate(() => (window as unknown as { __meshmap: { queryLabels: () => Labels } }).__meshmap.queryLabels())
  await viewAt(page, 63.43, 10.40, 10)
  await expect.poll(async () => (await labels()).names['place-city'] ?? [], { timeout: 30_000 }).toContain('Trondheim')
  await expect.poll(async () => sum(await labels(), 'road-')).toBeGreaterThan(0)
  const l = await labels()
  expect(sum(l, 'place-village') + sum(l, 'road-name') + sum(l, 'mountain-peak')).toBe(0)
  expect(l.counts['water'] ?? 0).toBeGreaterThan(0)
  await showLayers(page, ['Local place names'])
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
  await viewAt(page, 63.43, 10.40, 10)
  await expect.poll(async () => sum(await labels(), 'place-village'), { timeout: 30_000 }).toBeGreaterThan(0)
})

test('genuine place, peak, road and border labels render (self-hosted basemap)', async ({ page }) => {
  test.skip(!!process.env.MESHMAP_NO_BASEMAP, 'needs the self-hosted basemap (not built in CI)')
  await ready(page)
  await showLayers(page, ['Local place names', 'Peaks', 'Road names and numbers'])
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
  // The public key comes from its own endpoint: a base64 key, or none retained.
  await expect(page.locator('.node-panel dt:text-is("Public key") + dd')).toHaveText(/[A-Za-z0-9+/]{43}=|none retained/)
  // A node announcing a key says where its id comes from (D-142).
  if (/announces a public key/.test(await page.locator('.node-panel dt:text-is("Identity") + dd').innerText())) {
    await expect(page.locator('.node-panel dt:text-is("Node id") + dd')).toHaveText(/derived from its key: firmware 2\.8 or newer|from its hardware: firmware 2\.7 or older/)
  }
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
    expect(b).not.toMatch(/"(envelope_bytes|envelope|encrypted|payload|psk|xeddsa_signature)"\s*:/)
  }
})

test('slide the window back, then return to live', async ({ page }) => {
  await ready(page)
  await page.locator('.live-indicator .badge').click() // the header's indicator opens the Period panel (D-067)
  await expect(page.getByRole('complementary', { name: 'Period' })).toBeVisible()
  // A short window, so there is older data to slide to however young the database is.
  await page.getByRole('button', { name: '1h', exact: true }).click()
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
  // Fit first: an open phone panel covers the map's lower controls.
  await page.getByRole('button', { name: 'Fit to data' }).click()
  // The rail lies along the bottom, tools left to right in the desktop's
  // top-to-bottom order, and scrolls sideways when they don't fit (D-132).
  const rail = page.locator('.rail')
  const r = (await rail.boundingBox())!
  expect(r.width).toBeGreaterThan(r.height)
  expect(844 - (r.y + r.height)).toBeLessThan(20)
  const xs = await rail.locator('.rail-btn').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().left))
  expect(xs).toEqual([...xs].sort((p, q) => p - q))
  expect(await rail.locator('.rail-btn').first().getAttribute('aria-label')).toBe('Nodes')
  // An arrow marks the end with more tools; it scrolls to them.
  const tools = rail.locator('.rail-tools')
  expect(await tools.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
  await expect(rail.locator('.rail-more-left')).toHaveCount(0)
  await rail.locator('.rail-more-right').click()
  await expect.poll(() => tools.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0)
  await expect(rail.locator('.rail-more-left')).toBeVisible()
  await tools.evaluate((e) => e.scrollTo({ left: e.scrollWidth }))
  await expect(rail.getByRole('button', { name: 'Settings', exact: true })).toBeInViewport()
  await expect(rail.locator('.rail-more-right')).toHaveCount(0)
  await tools.evaluate((e) => e.scrollTo({ left: 0 }))
  await openPanel(page)
  await expect(page.locator('#dock')).toBeVisible()
  // The panel sits on the rail, growing upwards.
  const d = (await page.locator('#dock').boundingBox())!
  expect(r.y - (d.y + d.height)).toBeGreaterThan(0)
  expect(r.y - (d.y + d.height)).toBeLessThan(12)
  await expect(page.locator('.live-indicator')).toBeVisible()
  await expect(page.locator('.node-row').first()).toBeVisible()
  await page.waitForTimeout(1500)
  await docShot(page, 'mobile.png')
})

test('legend explains role sizes and a last-heard scale that follows the window', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  await showPanel(page, 'Legend')
  await expect(page.locator('.age-labels')).toContainText('72 h') // logarithmic: 35 min, 3.3 h, 16 h, 72 h
  await expect(page.locator('.legend')).toContainText('ROUTER_LATE')
  await showPanel(page, 'Period')
  await page.getByRole('button', { name: '24h', exact: true }).click()
  await showPanel(page, 'Legend')
  await expect(page.locator('.age-labels')).toContainText('24 h')
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
  // Closing Details keeps the selection: still only its links.
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page.locator('#dock')).toBeHidden()
  expect((await layerData()).links.every(([a, b]) => a === id || b === id)).toBe(true)
  // Clicking empty sea clears it, and other nodes' links come back. Selecting
  // zoomed in and links outside the view are culled, so zoom out to all of
  // the data first: a sparse mesh may have none of them near the selected node.
  await page.evaluate(() => (window as unknown as { __meshmap: { map: { jumpTo: (o: object) => void } } }).__meshmap.map.jumpTo({ center: [3.0, 66.0], zoom: 8 }))
  await page.waitForTimeout(500)
  const box = (await page.locator('.map').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page).not.toHaveURL(/node=/)
  await page.getByRole('button', { name: 'Fit to data' }).click()
  await expect.poll(async () => (await layerData()).links.some(([a, b]) => a !== id && b !== id)).toBe(true)
})

test('the panel is closed until something is selected, and closes again when the selection closes', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#dock')).toBeHidden()
  await openPanel(page)
  await expect(page.locator('#dock')).toBeVisible()
  await page.locator('.node-row').first().click()
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Details', exact: true }).click() // its rail button closes it, keeping the selection
  await expect(page.locator('#dock')).toBeHidden()
  await expect(page).toHaveURL(/node=/)
  await page.getByRole('button', { name: 'Details', exact: true }).click() // and opens it again on the same node
  await expect(page.locator('.node-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(page.locator('#dock')).toBeHidden()
  // Select a node on the map itself, from a page with nothing selected (the
  // node above stays selected, and may be the one picked below, whose name
  // label then replaces the hover tooltip): the panel opens on Details, and
  // closing the details hides it again.
  await ready(page)
  await expect(page).not.toHaveURL(/node=/)
  await page.waitForFunction(() => {
    const l = (window as unknown as { __meshmap: Hook }).__meshmap.layers()
    return (l.find((x) => x.id === 'nodes')?.data.length ?? 0) > 0
  }, null, { timeout: 30_000 })
  // The most isolated node: a click on one in a crowd may land on its fanned-out cluster instead.
  const hit = await page.evaluate(() => {
    const mm = (window as unknown as { __meshmap: Hook & { map: { project: (p: [number, number]) => { x: number; y: number } } } }).__meshmap
    const nodes = mm.layers().find((l) => l.id === 'nodes')!.data as { lon: number; lat: number }[]
    const gap = (n: { lon: number; lat: number }) => Math.min(...nodes.filter((m) => m !== n).map((m) => Math.hypot(m.lon - n.lon, (m.lat - n.lat) * 2)), Infinity)
    const best = nodes.reduce((a, b) => (gap(b) > gap(a) ? b : a))
    const p = mm.map.project([best.lon, best.lat])
    return { x: p.x, y: p.y, lon: best.lon, lat: best.lat }
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
  // Clicks no longer depend on how quickly the page handles mouse down and
  // up (MapLibre's click, then deck.gl's pick); clicking again is a no-op once
  // selected, so retrying only covers a click that landed mid-flight.
  await expect(async () => {
    await page.mouse.click(box.x + pt.x, box.y + pt.y)
    await expect(page.locator('#dock')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page.locator('#dock')).toBeHidden()
})

test('opens on Norway, fits the data once it loads, and clicking empty map clears the selection', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap)
  // D-074: Lindesnes, Utsira, Nordkapp and Grense Jakobselv are on screen before the data arrives...
  type M = { map: { getBounds: () => { contains: (p: [number, number]) => boolean } }; layers: () => { id: string; data: { lon: number; lat: number }[] }[] }
  const markers = () => page.evaluate(() => (window as unknown as { __meshmap: M }).__meshmap.layers().find((l) => l.id === 'nodes')?.data.length ?? 0)
  // Both read at once: data arriving between two reads would fit the view away.
  expect(await page.evaluate(() => {
    const mm = (window as unknown as { __meshmap: M }).__meshmap
    if (mm.layers().find((l) => l.id === 'nodes')?.data.length) return true
    const b = mm.map.getBounds()
    return ([[7.05, 57.98], [4.88, 59.3], [25.78, 71.17], [30.8, 69.8]] as [number, number][]).every((p) => b.contains(p))
  })).toBe(true)
  // ...then the view fits the markers: every one is on screen.
  await expect.poll(markers, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => {
    const mm = (window as unknown as { __meshmap: M }).__meshmap
    const b = mm.map.getBounds()
    return mm.layers().find((l) => l.id === 'nodes')!.data.every((n) => b.contains([n.lon, n.lat]))
  })).toBe(true)
  // Select a node from the list, then click empty sea far from any node.
  await openPanel(page)
  await page.locator('.node-row').first().click()
  await expect(page.locator('.node-panel')).toBeVisible()
  // Selecting flies to the node (zoom ≥ 10) once it is placed and the panel is
  // open: let that finish, or it can start after the jump below and bring the
  // node back under the click.
  type Cam = { map: { getZoom: () => number; isMoving: () => boolean } }
  await expect.poll(() => page.evaluate(() => {
    const m = (window as unknown as { __meshmap: Cam }).__meshmap.map
    return m.getZoom() >= 10 && !m.isMoving()
  }), { timeout: 15_000 }).toBe(true)
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
  // A mocked mesh and stream: deterministic, unlike waiting for the real mesh to speak.
  const O = 0x31000001, GW = 0x31000002
  let release!: (make: () => ReturnType<typeof directReception>[]) => void
  const live = new Promise<() => ReturnType<typeof directReception>[]>((r) => (release = r))
  await mockObservations(page, [...nodeRows(O, 'ORIG', { lat: 59.91, lon: 10.75 }), ...nodeRows(GW, 'GATE', { lat: 59.95, lon: 11.05, role: 'ROUTER' })], live)
  await ready(page)
  const packets = async () => Number(/(\d+) packets/.exec((await page.locator('.counters').textContent()) ?? '')?.[1] ?? 0)
  await expect.poll(packets, { timeout: 30_000 }).toBe(4)
  const fetches: string[] = []
  page.on('request', (r) => r.url().includes('/api/v1/observations') && fetches.push(r.url()))
  release(() => [directReception(O, GW)])
  await expect.poll(packets, { timeout: 15_000 }).toBe(5)
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
    await page.getByRole('tab', { name: /^Packets/ }).click()
    await expect(page.getByRole('heading', { name: /^Packet log/ })).toBeVisible()
    if (i === 0) await expect(toggle).not.toBeChecked() // own packets only by default
    await toggle.check()
    await page.waitForTimeout(300)
    if (await log.locator('tbody tr[data-kind="relayed"]').count()) break
  }
  const total = async () => Number(/\((\d+)/.exec((await page.getByRole('heading', { name: /^Packet log/ }).textContent()) ?? '')?.[1])
  const relayedCount = async () => Number(/Include relayed \((\d+)/.exec((await page.locator('label', { has: toggle }).textContent()) ?? '')?.[1])
  await toggle.uncheck()
  await expect(log.locator('tbody tr[data-kind="relayed"]')).toHaveCount(0) // no relayed packets
  // Live traffic keeps adding own packets, so compare the toggle's effect, not two moments' totals.
  const own = await total(), relayed = await relayedCount()
  expect(relayed).toBeGreaterThan(0)
  await toggle.check()
  await expect.poll(async () => (await total()) - own).toBeGreaterThanOrEqual(relayed)

  const layers = () => page.evaluate(() => Object.fromEntries((window as unknown as { __meshmap: Hook }).__meshmap.layers().map((l) => [l.id, l.data.length])))
  const links = async () => Object.entries(await layers()).reduce((n, [k, v]) => n + (k.startsWith('links-') ? v : 0), 0)
  await expect.poll(links).toBeGreaterThan(0)
  // Pick a packet; its route replaces the links. A settled row, with Enter:
  // live rows keep sliding in at the top, so the first row may never hold
  // still long enough for a click.
  await log.locator('tbody tr:not([data-pending])').first().press('Enter')
  await expect(page.locator('.route-note')).toBeVisible()
  await expect.poll(async () => 'route' in (await layers()) && (await links()) === 0).toBe(true)
  await expect(log.locator('tbody tr.active')).toHaveCount(1)
  // Selecting it again (here with Enter: live rows keep arriving above it, so
  // a click can wait in vain for it to hold still) clears the route and
  // brings the links back.
  await log.locator('tbody tr.active').press('Enter')
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
  // Role filter (D-145): applied while NodeInfo still counts, so roles exist.
  // (Filtering to position-only below strips identities and their roles.)
  const router = panel.getByRole('button', { name: 'Router', exact: true })
  await expect(router).toBeVisible({ timeout: 30_000 })
  await router.click()
  await expect(page).toHaveURL(/role=ROUTER/)
  await panel.getByRole('button', { name: 'position' }).click()
  await panel.getByLabel('Only nodes with reported positions').check()
  await expect(filters.locator('.rail-badge')).toHaveText('3')
  await expect(page).toHaveURL(/type=position/)
  await panel.getByRole('button', { name: 'Reset' }).click()
  await expect(filters.locator('.rail-badge')).toHaveCount(0)
  // Another rail button swaps the panel; pressing the open one closes it.
  await showPanel(page, 'Legend')
  await expect(page.getByRole('complementary', { name: 'Legend' })).toBeVisible()
  await page.getByRole('button', { name: 'Legend', exact: true }).click()
  await expect(page.locator('#dock')).toBeHidden()
})

// D-145: the node list obeys the node filters and warns when they hide nodes.
test('the node list applies node filters and alerts when nodes are hidden', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  const rows = page.locator('.node-row')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  const before = await rows.count()
  await expect(page.locator('.node-filter-alert')).toHaveCount(0)
  // Hide the client nodes by keeping only routers (a minority).
  await showPanel(page, 'Filters')
  const routerChip = page.getByRole('complementary', { name: 'Filters' }).getByRole('button', { name: 'Router', exact: true })
  await expect(routerChip).toBeVisible({ timeout: 30_000 })
  await routerChip.click()
  await openPanel(page)
  const alert = page.locator('.node-filter-alert')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText(/hidden by the active node filters/)
  await expect.poll(() => rows.count()).toBeLessThan(before) // fewer nodes listed
  await alert.getByRole('button', { name: 'Show all' }).click()
  await expect(page.locator('.node-filter-alert')).toHaveCount(0)
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
  await page.getByRole('tab', { name: /^Links/ }).click()
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

test('closing the Nodes panel clears its search', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  await page.getByPlaceholder(/Search/).fill('zz-no-such-node')
  await page.getByRole('button', { name: 'Close nodes' }).click()
  await openPanel(page)
  await expect(page.getByPlaceholder(/Search/)).toHaveValue('')
})


// D-076: Settings → Reset forgets everything stored and reloads.
test('reset clears stored settings and data, then reloads', async ({ page }) => {
  await ready(page)
  await showPanel(page, 'Settings')
  await page.getByRole('complementary', { name: 'Settings' }).getByLabel('Dark').check()
  await showPanel(page, 'Layers')
  await page.getByRole('complementary', { name: 'Layers' }).getByLabel('Regions (landsdeler)').check()
  expect(await page.evaluate(() => localStorage.length)).toBeGreaterThan(0)
  await showPanel(page, 'Settings')
  page.once('dialog', (d) => d.accept())
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reset and reload' }).click()])
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
  expect(await page.evaluate(() => localStorage.getItem('meshmap:toggles:v6'))).toBeNull()
  await showPanel(page, 'Layers')
  await expect(page.getByRole('complementary', { name: 'Layers' }).getByLabel('Regions (landsdeler)')).not.toBeChecked()
  await showPanel(page, 'Settings')
  await expect(page.getByRole('complementary', { name: 'Settings' }).getByLabel('Auto')).toBeChecked()
})

// D-080: a permanent link opens the node; Share copies it.
test('a node link opens that node, and Share copies a permanent one', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await ready(page)
  // A placed node to link to.
  await page.waitForFunction(() => ((window as unknown as { __meshmap: Hook }).__meshmap.layers().find((l) => l.id === 'nodes')?.data.length ?? 0) > 0, null, { timeout: 30_000 })
  const id = await page.evaluate(() => ((window as unknown as { __meshmap: Hook }).__meshmap.layers().find((l) => l.id === 'nodes')!.data[0] as { node: { id: string } }).node.id)
  await page.goto(`/?node=${id}`)
  await expect(page.locator('.node-panel')).toContainText(id, { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${new URL(page.url()).origin}/?node=${id}`)
  // The address bar follows the selection.
  await expect(page).toHaveURL(new RegExp(`node=(%21|!)${id.slice(1)}`))
  // Closing Details keeps the node selected, and in the address bar.
  await page.getByRole('button', { name: 'Close details' }).click()
  await expect(page.locator('#dock')).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`node=(%21|!)${id.slice(1)}`))
})

test('the Health panel lists known issues and airtime, and Details shows a node\'s own', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'Health' }).click()
  const panel = page.locator('.health-panel')
  await expect(panel).toContainText('Airtime (estimated)', { timeout: 30_000 })
  await expect(panel).toContainText(/No known issues|problem|warning|notice/)
  await docShot(page, 'health.png')
  // Picking a node in the airtime list opens its details, with its health and airtime.
  await panel.locator('.shares').nth(1).locator('button').first().click()
  await expect(page.locator('.node-panel .node-health')).toBeVisible()
  await page.getByRole('tab', { name: /^Packets/ }).click()
  await expect(page.locator('.node-panel')).toContainText('Airtime (est.)')
})

test('the panel can be resized by its left edge, the width is remembered, and double-click resets it', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  const dock = page.locator('#dock')
  const handle = page.getByRole('separator', { name: 'Panel width' })
  const width = async () => (await dock.boundingBox())!.width
  const before = await width()
  const h = (await handle.boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x - 150, h.y + h.height / 2, { steps: 5 })
  await page.mouse.up()
  expect(await width()).toBeGreaterThan(before + 120)
  const wide = await width()
  await page.reload()
  await ready(page)
  await openPanel(page)
  await expect.poll(width).toBeCloseTo(wide, 0)
  await handle.dblclick()
  await expect.poll(width).toBeCloseTo(before, 0)
  // Arrow keys work too.
  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(width).toBeGreaterThan(before)
})

test('node details are split into tabs, and the chosen tab is kept for the next node', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  await page.locator('.node-row').first().click()
  const tabs = page.getByRole('tablist', { name: 'Node details' })
  await expect(tabs.getByRole('tab', { name: /^Overview/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.node-panel')).toContainText('Position')
  await expect(page.locator('.node-panel')).not.toContainText('Packet log')
  await tabs.getByRole('tab', { name: /^Radio/ }).click()
  await expect(page.locator('.node-panel')).toContainText('LoRa preset')
  // Arrow keys move between tabs.
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: /^Telemetry/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.node-panel')).toContainText(/Device \(latest\)|No telemetry/)
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: /^Packets/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: /^Packet log/ })).toBeVisible()
  // Another node opens on the same tab.
  await showPanel(page, 'Nodes')
  await page.locator('.node-row').nth(1).click()
  await expect(page.getByRole('heading', { name: /^Packet log/ })).toBeVisible()
})

test('the Telemetry tab charts every metric over the whole selected period, with a hover readout', async ({ page }) => {
  await ready(page)
  await openPanel(page)
  // A node that reports telemetry.
  const tab = page.getByRole('tab', { name: /^Telemetry/ })
  for (let i = 0; i < 20; i++) {
    await showPanel(page, 'Nodes')
    await page.locator('.node-row').nth(i).click()
    await tab.click()
    await expect(page.locator('.node-panel')).toContainText(/Device \(latest\)|No telemetry/)
    if (await page.locator('.tchart').count()) break
  }
  const chart = page.locator('.tchart').first()
  await expect(chart).toBeVisible({ timeout: 30_000 })
  await expect(chart.locator('.tchart-x span')).toHaveCount(3)
  await docShot(page, 'telemetry.png')
  const plot = chart.locator('.tchart-plot')
  const box = (await plot.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
  await expect(chart.locator('.tchart-cursor')).toHaveCount(1)
  await expect(chart.locator('.tchart-at')).not.toHaveText('latest')
  // Every chart of the tab inspects the same moment, each with its own reading near it.
  const charts = page.locator('.node-panel .tchart')
  await expect(page.locator('.node-panel .tchart-cursor')).toHaveCount(await charts.count())
  await expect(page.locator('.node-panel .tchart-at', { hasText: 'latest' })).toHaveCount(0)
  // Leaving the chart lets them all go back to the latest reading.
  await page.mouse.move(box.x - 40, box.y + box.height / 2)
  await expect(page.locator('.node-panel .tchart-cursor')).toHaveCount(0)
})

test('only online nodes: offline ones leave the map, and Details says which a node is', async ({ page }) => {
  await ready(page)
  // Marker counts move with live traffic (estimates come and go between rebuilds), so the
  // test checks what is drawn: with the filter on, only nodes heard in the last 3 h.
  const drawn = () => page.evaluate(() => {
    const mm = window as unknown as { __meshmap: Hook }
    // 'nodes' holds every marker once.
    const ps = (mm.__meshmap.layers().find((l) => l.id === 'nodes')?.data ?? []) as { node: { last_seen?: string } }[]
    const offline = ps.filter((p) => !p.node.last_seen || Date.now() - Date.parse(p.node.last_seen) > 3 * 3_600_000).length
    return { all: ps.length, offline }
  })
  await expect.poll(async () => (await drawn()).all, { timeout: 30_000 }).toBeGreaterThan(0)
  await showPanel(page, 'Filters')
  await page.getByLabel(/Only online nodes/).check()
  await expect.poll(async () => (await drawn()).offline).toBe(0)
  expect((await drawn()).all).toBeGreaterThan(0)
  await expect(page.locator('.rail-btn[aria-label="Filters"] .rail-badge')).toHaveText('1')
  const filtered = (await drawn()).all
  await page.getByLabel(/Only online nodes/).uncheck()
  await expect.poll(async () => (await drawn()).all).toBeGreaterThanOrEqual(filtered)
  await openPanel(page)
  await page.locator('.node-row').first().click()
  await expect(page.locator('.node-panel .tag.online, .node-panel .tag.offline')).toHaveCount(1)
})

test('the rail opens long-term trends by day, week and month', async ({ page }) => {
  await ready(page)
  await page.locator('.rail-btn[aria-label="Trends"]').click()
  const panel = page.locator('.trends-panel')
  await expect(panel.locator('.bchart').first()).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('.trends-table tbody tr').first()).toBeVisible()
  await docShot(page, 'trends.png')
  await panel.getByRole('button', { name: 'Monthly' }).click()
  await expect(panel.getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.trends-table th').first()).toHaveText('Month')
})

test('a link shows its signal over the selected period, both directions', async ({ page }) => {
  await withLinks(page)
  await ready(page)
  await openPanel(page)
  for (let i = 0; i < 15; i++) {
    await showPanel(page, 'Nodes')
    await page.locator('.node-row').nth(i).click()
    await page.getByRole('tab', { name: /^Links/ }).click()
    if (await page.locator('ul.links li button').count()) break
  }
  await page.locator('ul.links li button').first().click()
  await expect(page.locator('.link-history .tchart').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.link-history .tchart-legend').first()).toContainText('→')
  await page.locator('.link-history').scrollIntoViewIfNeeded()
  await docShot(page, 'link-history.png')
})

test('the map view is remembered: a reload opens where it was left, without fitting the data', async ({ page }) => {
  type M = { map: { jumpTo: (o: object) => void; getCenter: () => { lng: number; lat: number }; getZoom: () => number } }
  await ready(page)
  await page.waitForTimeout(1500) // let the fit on first load finish
  await page.evaluate(() => (window as unknown as { __meshmap: M }).__meshmap.map.jumpTo({ center: [8.5, 61.5], zoom: 9.3 }))
  await page.waitForTimeout(300)
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap)
  await page.waitForTimeout(2500) // long enough for a fit, had there been one
  const v = await page.evaluate(() => { const m = (window as unknown as { __meshmap: M }).__meshmap.map; const c = m.getCenter(); return { lng: c.lng, lat: c.lat, zoom: m.getZoom() } })
  expect(v.zoom).toBeCloseTo(9.3, 1)
  expect(v.lng).toBeCloseTo(8.5, 2)
  expect(v.lat).toBeCloseTo(61.5, 2)
})

// A two-finger twist or Shift+arrows can turn the map; one button turns it back.
test('Reset north turns a rotated map back to north up', async ({ page }) => {
  type M = { map: { jumpTo: (o: object) => void; getBearing: () => number } }
  await ready(page)
  await page.evaluate(() => (window as unknown as { __meshmap: M }).__meshmap.map.jumpTo({ bearing: 60 }))
  await page.getByRole('button', { name: 'Reset north' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __meshmap: M }).__meshmap.map.getBearing()), { timeout: 5000 }).toBe(0)
})

test('a hollow (estimated) marker is clickable inside its ring, not only on it', async ({ page }) => {
  type Placed = { node: { id: string }; kind: string; lon: number; lat: number }
  type M = Hook & {
    map: { project: (p: [number, number]) => { x: number; y: number }; jumpTo: (o: object) => void }
    pick: (x: number, y: number) => { layer: string; node?: string } | null
  }
  await ready(page)
  await page.waitForFunction(() => ((window as unknown as { __meshmap: Hook }).__meshmap.layers().find((x) => x.id === 'nodes')?.data as Placed[] | undefined)?.some((p) => p.kind === 'estimated') ?? false, null, { timeout: 30_000 })
  await page.waitForTimeout(1500) // the fit on first load
  // The estimated node furthest from any other marker, so nothing else lies under the click.
  const hit = await page.evaluate(() => {
    const nodes = (window as unknown as { __meshmap: M }).__meshmap.layers().find((l) => l.id === 'nodes')!.data as Placed[]
    const gap = (n: Placed) => Math.min(...nodes.filter((m) => m !== n).map((m) => Math.hypot(m.lon - n.lon, (m.lat - n.lat) * 2)), Infinity)
    const best = nodes.filter((n) => n.kind === 'estimated').reduce((a, b) => (gap(b) > gap(a) ? b : a))
    return { id: best.node.id, lon: best.lon, lat: best.lat }
  })
  // Zoom 9: node names (from zoom 10) would cover part of the marker, and pick as its label.
  await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: M }).__meshmap.map.jumpTo({ center: [lon, lat], zoom: 9 }), [hit.lon, hit.lat])
  await page.waitForTimeout(800)
  const pt = await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: M }).__meshmap.map.project([lon, lat]), [hit.lon, hit.lat])
  // The clear inside picks the marker at every pixel, the centre too (D-187 keeps it undrawn, not unpickable).
  for (const [dx, dy] of [[0, 0], [4, 0], [0, -5], [-3, 3]]) {
    const got = await page.evaluate(([x, y]) => (window as unknown as { __meshmap: M }).__meshmap.pick(x, y), [pt.x + dx, pt.y + dy])
    expect(got, `pick at ${dx},${dy}`).toEqual({ layer: 'nodes', node: hit.id })
  }
  // And a click at its centre selects it: hover first, as a user would, then click.
  const box = (await page.locator('.map').boundingBox())!
  await page.mouse.move(box.x + pt.x, box.y + pt.y)
  await expect(page.locator('.tooltip')).toBeVisible()
  await expect(async () => {
    await page.mouse.click(box.x + pt.x, box.y + pt.y)
    await expect(page.locator('#dock')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await expect(page).toHaveURL(new RegExp(`node=(!|%21)${hit.id.slice(1)}`))
})

test('selecting a node on the map with the panel closed centres it beside the panel that opens', async ({ page }) => {
  type M = Hook & { map: { project: (p: [number, number]) => { x: number; y: number }; jumpTo: (o: object) => void } }
  await ready(page)
  await expect(page.locator('#dock')).toBeHidden()
  await page.waitForFunction(() => ((window as unknown as { __meshmap: Hook }).__meshmap.layers().find((x) => x.id === 'nodes')?.data.length ?? 0) > 0, null, { timeout: 30_000 })
  await page.waitForTimeout(1500) // the fit on first load
  // The most isolated node, so the click selects it rather than a cluster.
  const hit = await page.evaluate(() => {
    const nodes = (window as unknown as { __meshmap: M }).__meshmap.layers().find((l) => l.id === 'nodes')!.data as { lon: number; lat: number }[]
    const gap = (n: { lon: number; lat: number }) => Math.min(...nodes.filter((m) => m !== n).map((m) => Math.hypot(m.lon - n.lon, (m.lat - n.lat) * 2)), Infinity)
    const best = nodes.reduce((a, b) => (gap(b) > gap(a) ? b : a))
    return { lon: best.lon, lat: best.lat }
  })
  await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: M }).__meshmap.map.jumpTo({ center: [lon, lat], zoom: 11 }), [hit.lon, hit.lat])
  await page.waitForTimeout(800)
  const box = (await page.locator('.map').boundingBox())!
  const pt = await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: M }).__meshmap.map.project([lon, lat]), [hit.lon, hit.lat])
  // As a user would: hover first (a tooltip, or its name cluster fanning out), then click,
  // again if the headless renderer took the click for a long press.
  await page.mouse.move(box.x + pt.x, box.y + pt.y)
  await expect.poll(async () => (await page.locator('.tooltip').isVisible()) || (await page.evaluate(() =>
    (window as unknown as { __meshmap: Hook }).__meshmap.layers().some((l) => l.id === 'label-leaders')))).toBe(true)
  await expect(async () => {
    await page.mouse.click(box.x + pt.x, box.y + pt.y)
    await expect(page.locator('#dock')).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  await page.waitForTimeout(1200) // the flight
  const dock = (await page.locator('#dock').boundingBox())!
  const now = await page.evaluate(([lon, lat]) => (window as unknown as { __meshmap: M }).__meshmap.map.project([lon, lat]), [hit.lon, hit.lat])
  const freeCentre = (dock.x - box.x) / 2 // the middle of the map left of the panel
  expect(Math.abs(now.x - freeCentre)).toBeLessThan(40)
})
