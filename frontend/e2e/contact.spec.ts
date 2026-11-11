import { expect, test } from '@playwright/test'
import { mockObservations, nodeRows } from './mock'

// A node with a public key can be imported into the Meshtastic apps (D-213).

const KEYED = 0x34000001, KEYLESS = 0x34000002
const URL = 'https://meshtastic.org/v/#CIGAgKADEiQKCSEzNDAwMDAwMRIKS0VZRUQgbG9uZxoFS0VZRUQ'

test('Import shows a QR code and the contact link', async ({ page }) => {
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
  await expect(dialog.getByRole('link', { name: 'Open in Meshtastic' })).toHaveAttribute('href', URL)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // A node without a key has nothing to import.
  await page.goto('/?node=!34000002')
  await expect(page.locator('.node-panel h2')).toHaveText('NOKEY long', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Share' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0)
})
