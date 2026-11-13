import { expect, test } from '@playwright/test'
import { mockObservations, nodeRows } from './mock'

// A node with a public key can be imported into the Meshtastic apps (D-213).

const KEYED = 0x34000001, KEYLESS = 0x34000002
const URL = 'https://meshtastic.org/v/#CIGAgKADEiQKCSEzNDAwMDAwMRIKS0VZRUQgbG9uZxoFS0VZRUQ'

test('Import shows a QR code and the contact link to copy', async ({ page }) => {
  await mockObservations(page, [
    ...nodeRows(KEYED, 'KEYED', { lat: 59.91, lon: 10.75, keyId: KEYED }),
    ...nodeRows(KEYLESS, 'NOKEY', { lat: 59.95, lon: 11.05 }),
  ])
  await page.route('**/api/v1/nodes/*/contact', (r) => r.fulfill({
    json: { node: '!34000001', url: URL, long_name: 'KEYED long', short_name: 'KEYED', observed_at: new Date().toISOString(), signature: 'unsigned' },
  }))
  await page.goto('/?node=!34000001')
  await expect(page.locator('.node-panel h2')).toHaveText('KEYED long', { timeout: 30_000 })

  await page.getByRole('button', { name: 'Import' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import KEYED long' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('img', { name: /QR code/ })).toBeVisible()
  // On a desktop there is no app to open: the code and the link to copy.
  await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Open in Meshtastic' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // A node without a key has nothing to import.
  await page.goto('/?node=!34000002')
  await expect(page.locator('.node-panel h2')).toHaveText('NOKEY long', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0)
})

test.describe('on an Android phone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' })
  test('Open in Meshtastic names the app', async ({ page }) => {
    await mockObservations(page, nodeRows(KEYED, 'KEYED', { lat: 59.91, lon: 10.75, keyId: KEYED }))
    await page.route('**/api/v1/nodes/*/contact', (r) => r.fulfill({
      json: { node: '!34000001', url: URL, long_name: 'KEYED long', short_name: 'KEYED', observed_at: new Date().toISOString(), signature: 'verified' },
    }))
    await page.goto('/?node=!34000001')
    await page.getByRole('button', { name: 'Import' }).click({ timeout: 30_000 })
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Open in Meshtastic' }))
      .toHaveAttribute('href', `intent://meshtastic.org/v/#${URL.split('#')[1]}#Intent;scheme=https;package=com.geeksville.mesh;end`)
  })
})

// In beta mode, a node with a precise enough position links to a LinkSim coverage simulation (D-214, D-215).
test('Coverage opens LinkSim at the node', async ({ page }) => {
  await mockObservations(page, nodeRows(KEYED, 'KEYED', { lat: 59.91, lon: 10.75, keyId: KEYED }))
  await page.goto('/?node=!34000001')
  await expect(page.locator('.node-panel h2')).toHaveText('KEYED long', { timeout: 30_000 })
  // Hidden until beta mode is on (D-215): the Konami code, typed on the page.
  const link = page.getByRole('link', { name: /Coverage/ })
  await expect(link).toHaveCount(0)
  for (const k of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']) await page.keyboard.press(k)
  await expect(page.getByRole('button', { name: /Beta mode on/ })).toBeVisible()
  await expect(link).toHaveAttribute('target', '_blank')
  const u = new URL((await link.getAttribute('href'))!)
  expect(u.hostname).toMatch(/linksim\.link$/)
  expect(u.searchParams.get('site')).toBe('1')
  expect(u.searchParams.get('lat')).toBe('59.91000')
  expect(u.searchParams.get('name')).toBe('KEYED long')
})
