import { expect, test } from '@playwright/test'

// D-051, D-066: Settings on the tool rail holds the theme and the links
// about the site; the policy states this deployment's own settings.
test('settings hold the theme, source code, license and privacy policy', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const menu = page.getByRole('complementary', { name: 'Settings' })
  await expect(menu.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()
  await expect(menu.getByRole('link', { name: /Source code on GitHub/ })).toHaveAttribute('href', /^https:\/\/github\.com\/868-no\/map/)
  await expect(menu.getByRole('link', { name: /License/ })).toHaveAttribute('href', /\/LICENSE$/)
  await expect(menu.getByRole('link', { name: /Privacy policy/ })).toHaveAttribute('href', '/privacy.html')
  // The version: the commit the image was built from, or a development build.
  await expect(menu.locator('.version')).toHaveText(/^Version ([0-9a-f]{7}|development build)$/)
  // One panel at a time; Escape closes it.
  await page.getByRole('button', { name: 'Layers', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Layers' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#dock')).toBeHidden()
  // The map's credit line carries only the required map credits.
  await expect(page.locator('.attribution')).toHaveText('© OpenMapTiles © OpenStreetMap contributors')
})

test('the privacy policy fills in retention and operator details from the API', async ({ page, request }) => {
  const caps = await (await request.get('/api/v1/capabilities')).json()
  await page.goto('/privacy.html')
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible()
  const months = caps.retention_months === 1 ? 'one month' : `${caps.retention_months} months`
  await expect(page.locator('[data-fill="retention-short"]')).toHaveText(months)
  if (caps.operator?.contact) await expect(page.locator('[data-show="contact"]').first()).toBeVisible()
  else await expect(page.locator('[data-show="no-contact"]')).toBeVisible()
  await expect(page.getByRole('link', { name: '← Back to the map' })).toHaveAttribute('href', '/')
})
