import { expect, test, type Page } from '@playwright/test'

// Noise floors (D-199) on the demo mesh: its routers send local statistics
// (backend/internal/demo), Gråkallen (a router and gateway) the noisiest;
// Trondheim Sentrum, a client, sends none. Their ids follow from the demo's
// fixed keys.
const GRAK = '!207d2af1', TRDS = '!88bd9f97'
// The live demo sends a router's local stats beside its device telemetry:
// within a minute at the e2e rate.
const LIVE = 90_000

// The last hour: the live demo's readings so far span minutes of it, where
// on a three-day axis they would all sit at its right edge.
async function openNode(page: Page, id: string, tab: string) {
  await page.goto(`/?node=${id}&duration=1`)
  await page.waitForFunction(() => !!(window as unknown as { __meshmap?: unknown }).__meshmap, null, { timeout: 30_000 })
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
}

/** Screenshots for review, with NOISE_SHOTS=<dir>: the element in both themes. */
async function shots(page: Page, el: ReturnType<Page['locator']>, name: string) {
  const dir = process.env.NOISE_SHOTS
  if (!dir) return
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await el.scrollIntoViewIfNeeded()
    await el.screenshot({ path: `${dir}/${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
}

test("a router's Telemetry tab charts the noise floor it measures; a node without local stats has no such chart (D-199)", async ({ page }) => {
  test.setTimeout(LIVE + 60_000)
  await openNode(page, GRAK, 'Telemetry')
  const chart = page.locator('.node-panel .tchart').filter({ has: page.locator('.tchart-label', { hasText: /^Noise floor$/ }) })
  await expect(chart).toBeVisible({ timeout: LIVE })
  await expect(chart.locator('.tchart-read')).toContainText(/-\d+ dBm/)
  await expect(page.locator('.node-panel .noise-floor')).toContainText('background radio noise it measures')
  await shots(page, page.locator('.node-panel .noise-floor'), 'telemetry-noise-floor')

  await openNode(page, TRDS, 'Telemetry')
  await expect(page.locator('.node-panel')).toContainText(/Device \(latest\)|No telemetry/, { timeout: 30_000 })
  await expect(page.locator('.node-panel .tchart').first()).toBeVisible()
  await expect(page.locator('.node-panel .tchart-label', { hasText: /^Noise floor$/ })).toHaveCount(0)
})

test("a link's RSSI chart draws the noise floor of each end that measures one (D-199)", async ({ page }) => {
  test.setTimeout(LIVE + 60_000)
  await openNode(page, GRAK, 'Links')
  await page.locator('ul.links li button', { hasText: 'Trondheim Sentrum' }).first().click()
  const rssi = page.locator('.link-history .tchart').filter({ has: page.locator('.tchart-label', { hasText: /^RSSI$/ }) })
  await expect(rssi.locator('.tchart-legend')).toContainText(/Noise floor at GRAK \(\d+\)/, { timeout: LIVE })
  await expect(rssi.locator('.tchart-legend')).not.toContainText('Noise floor at TRDS')
  await expect(rssi.locator('.tchart-line.dashed')).not.toHaveCount(0)
  await expect(page.locator('.link-history')).toContainText('the noise floor each end measures')
  // The SNR chart stays as it was.
  const snr = page.locator('.link-history .tchart').filter({ has: page.locator('.tchart-label', { hasText: /^SNR$/ }) })
  await expect(snr.locator('.tchart-line.dashed')).toHaveCount(0)
  await shots(page, page.locator('.link-history'), 'link-rssi-noise-floor')
})

test("a router's link quality chart draws its noise floor on a dBm scale of its own (D-199)", async ({ page }) => {
  test.setTimeout(LIVE + 60_000)
  await openNode(page, GRAK, 'Links')
  const section = page.locator('section.router-links')
  await expect(section.getByRole('heading', { name: 'Router links' })).toBeVisible({ timeout: 30_000 })
  await expect(section.locator('.tchart-legend')).toContainText(/Its noise floor \(dBm, right\) \(\d+ readings\)/, { timeout: LIVE })
  await expect(section.locator('.tchart-y.band')).toHaveCount(2)
  await expect(section.locator('.tchart-y.band').first()).toContainText('dBm')
  await expect(section.getByRole('img')).toHaveAttribute('aria-label', /Its noise floor on a scale of its own/)
  await expect(section).toContainText('the noise floor it measures')
  await shots(page, section, 'router-links-noise-floor')
})
