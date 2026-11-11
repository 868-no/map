// The promo video's map part (promo/STORYBOARD.md): one continuous take, about 50 s,
// ending on Norway; the phone take (phone.spec.ts) starts from its last frame.
import { test, type Page } from '@playwright/test'
import { Take, roundDown } from '../lib'

type LngLat = [number, number]
// Norway in the left half, the opening and closing cards in the right.
const NORWAY = { center: [19.5, 64.6] as LngLat, zoom: 4.3 }
const OSLO_AT: LngLat = [10.76, 59.93]
const OSLO = { center: OSLO_AT, zoom: 10.2 }
// The busiest router around Oslo in November 2026; any well-linked router works.
const ROUTER = { id: '!bfa97d12', at: [10.8134, 59.9654] as LngLat }

test('promo', async ({ page }) => {
  const k = new Take(page, 'map')
  await k.open('', NORWAY)
  const nodes = roundDown(await k.nodesOnMap())
  const dock = page.locator('#dock')

  // 1. The whole country, live.
  k.caption('Meshtastic-nettet i Norge', 5.4, 'Live, rett i nettleseren', 'side')
  await k.hold(5.6)

  // 2. Into Oslo, in a straight line: clusters come apart, pings fade.
  k.caption(`Over ${nodes} noder på kartet`, 6.6, 'Med posisjon, rolle og når de sist ble hørt')
  await k.glide(OSLO_AT, OSLO, 5.5)
  await k.hold(1.2)

  // 3. Router links, switched on in Layers.
  await k.click(page.getByRole('button', { name: 'Layers', exact: true }))
  const layers = page.getByRole('complementary', { name: 'Layers' })
  const links = layers.getByLabel('Router links')
  await k.focus(await k.region([links.locator('xpath=ancestor::label[1]')], { top: -60, height: 200 }))
  await k.click(links, { seconds: 0.5 })
  await k.hold(0.6)
  await k.click(page.getByRole('button', { name: 'Close layers' }), { seconds: 0.5 })
  await k.unfocus()
  k.caption('Se hvem som hører hvem', 5.2, 'Radiolenker fra NeighborInfo, traceroute og direkte mottak')
  await k.hidePointer()
  await k.move({ center: [10.7, 59.95], zoom: 9.9 }, 5)

  // 4. A router's details, then its telemetry.
  await k.clickMap(ROUTER.at, { seconds: 0.9 })
  await k.hold(0.6) // the panel opens, the map centres the router
  k.caption('Alt om hver node', 8.2, 'Naboer, signal, batteri og kanalbruk over tid')
  await k.focus(await k.region([dock], { top: 0, height: 470 }))
  await k.hold(1.6)
  await k.click(page.getByRole('tab', { name: /^Telemetry/ }), { seconds: 0.5 })
  await k.focus(await k.region([dock], { top: 90, height: 520 }), 0.8)
  await k.hold(2.6)

  // 5. A packet from its log: the route it took, hop by hop.
  await k.click(page.getByRole('tab', { name: /^Packets/ }), { seconds: 0.5 })
  const relayed = page.getByLabel(/Include relayed/)
  await k.focus(await k.region([relayed.locator('xpath=ancestor::label[1]'), page.getByRole('table', { name: 'Packet log' })], { top: -40, height: 420 }), 0.8)
  await k.click(relayed, { seconds: 0.5 })
  const row = await pickRoute(k, page)
  await k.focus(await k.region([row], { top: -160, height: 360 }), 0.6)
  await k.click(row, { seconds: 0.6 })
  if (!(await page.locator('.route-note').isVisible())) await row.press('Enter') // a click that landed as a row moved
  await k.hidePointer()
  k.caption('Følg en pakke hopp for hopp', 6.4, 'Hvilke noder som videresendte den, og hvem som hørte den')
  await k.unfocus(1.2)
  await k.hold(5.2)

  // 6. Health: what the rules found across the mesh.
  await k.click(page.getByRole('button', { name: 'Health', exact: true }), { seconds: 0.8 })
  k.caption('Finn feil før de merkes', 5.8, 'Automatiske sjekker av hele nettet')
  await k.focus(await k.region([dock], { top: 0, height: 500 }))
  await k.hidePointer()
  await k.hold(3.4)
  await k.unfocus(1)

  // 7. Back out to the country, in a straight line (the phone takes over from here).
  await k.page.keyboard.press('Escape')
  await k.clearSelection()
  await k.hold(0.3)
  k.pings = 'off' // a ring would sit behind the phone
  await k.glide(OSLO_AT, NORWAY, 4.5)
  await k.hold(0.5)
})

/**
 * Choose the packet whose route to show: a traceroute 10 minutes old or more
 * (a newer route can still grow between check and click) with every node
 * placed, else the route with the fewest dashed segments, traceroutes first.
 * Tries them unseen, marks the chosen row's element, then clears the route
 * and puts the camera back: the take selects it in view. Returns its row.
 */
async function pickRoute(k: Take, page: Page) {
  const rows = page.getByRole('table', { name: 'Packet log' }).locator('tbody tr:not([data-pending])')
  const info = await rows.evaluateAll((rs) => rs.map((r) => {
    const tr = r as HTMLTableRowElement
    return { at: Date.parse(tr.cells[0]?.title ?? ''), text: tr.innerText }
  }))
  const newest = Math.max(...info.map((r) => r.at).filter((t) => !Number.isNaN(t)))
  const settled = [...info.keys()].filter((i) => newest - info[i].at >= 600_000)
  const trace = (i: number) => /traceroute/.test(info[i].text)
  const order = settled.sort((a, b) => Number(!trace(a)) - Number(!trace(b))).slice(0, 80)
  const camera = await k.map((m) => ({ center: m.getCenter(), zoom: m.getZoom() }), null)
  const note = page.locator('.route-note')
  let best: { i: number; score: number } | null = null
  for (const i of order) {
    await rows.nth(i).press('Enter')
    // The app draws a route on its own timers, which run only as the paused
    // clock moves: step it (unrecorded; the panel fills the frame meanwhile).
    let text = ''
    for (let n = 0; n < 150 && !/segments/.test(text); n++) {
      await page.clock.runFor(20)
      text = (await note.innerText().catch(() => '')) ?? ''
    }
    const segs = Number(/(\d+) segments/.exec(text)?.[1] ?? 0)
    if (segs < 2) continue
    const dashed = Number(/(\d+) dashed/.exec(text)?.[1] ?? 0)
    const score = dashed * 2 + Number(!trace(i))
    if (!best || score < best.score) best = { i, score }
    if (score === 0) break
  }
  if (!best) throw new Error('no packet with a route in the log')
  await rows.nth(best.i).evaluate((r) => r.setAttribute('data-promo-pick', ''))
  if (await note.isVisible()) {
    await note.getByText('Clear route').click()
    for (let n = 0; n < 150 && (await note.isVisible()); n++) await page.clock.runFor(20)
  }
  await k.map((m, c) => { m.stop(); m.jumpTo(c) }, camera)
  await k.park()
  return page.locator('tr[data-promo-pick]')
}
