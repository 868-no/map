import { expect, test } from '@playwright/test'

// D-051: the privacy policy and the source code are one click away, and the
// policy states this deployment's own settings.
test('links to the privacy policy and the GitHub repository', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Source code on GitHub' })).toHaveAttribute('href', /^https:\/\/github\.com\/868-no\/map/)
  await expect(page.locator('.attribution').getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy.html')
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
