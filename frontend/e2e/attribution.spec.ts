import { expect, test } from '@playwright/test'

// MapLibre's attribution control (and its vulnerable sanitizer) is not used;
// the required credit is rendered as static text.
test('map credit is visible without the MapLibre attribution control', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.attribution')).toContainText('OpenStreetMap contributors')
  await expect(page.locator('.attribution')).toContainText('OpenMapTiles')
  await expect(page.locator('.maplibregl-ctrl-attrib')).toHaveCount(0)
})
