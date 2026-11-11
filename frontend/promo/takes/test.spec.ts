import { test } from '@playwright/test'
import { Take } from '../lib'

test('test take', async ({ page }) => {
  const k = new Take(page, 'test')
  await k.open('', { center: [12.5, 63.2], zoom: 4.6 })
  k.caption('Meshtastic-nettet i Norge', 3.2, 'Live, fra 868.no')
  await k.hold(1.5)
  await k.move({ center: [10.75, 59.92], zoom: 9.2 }, 4.5)
  await k.hold(1)
})
