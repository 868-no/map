// The promo video's phone part (promo/STORYBOARD.md), about 27 s: the app on a
// generic phone, installed from its own Settings button, launched from the
// home screen; then the address. It starts on the map take's last frame
// (run map.spec.ts first), so the two join without a cut.
import { test } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { ADDRESS, Take, mix } from '../lib'
import { stageHtml } from '../phone'

type LngLat = [number, number]
// Southern and central Norway, where nearly all the nodes are, on the phone's screen.
const VIEW = { center: [10.9, 61.4] as LngLat, zoom: 4.35 }

test('phone', async ({ page }) => {
  // The map take's last frame (PROMO_BG: another image, to try this take alone).
  const frames = 'promo/.frames/map'
  const last = process.env.PROMO_BG ?? `${frames}/${readdirSync(frames).filter((f) => f.endsWith('.png')).sort().pop()}`
  const k = new Take(page, 'phone')
  k.touch = true
  await k.openStage(stageHtml(), { '/promo-bg.png': last }, VIEW)
  const css = (v: Record<string, number | string>) =>
    page.evaluate((v) => { for (const [n, x] of Object.entries(v)) document.documentElement.style.setProperty('--' + n, String(x)) }, v)
  const app = k.app
  // The browser offers the install, as Chrome does once the app qualifies:
  // the app shows its own button for it (src/pwa.ts).
  await app.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> }
    e.prompt = () => Promise.resolve()
    e.userChoice = new Promise((r) => ((window as unknown as { __promoChoice: (c: unknown) => void }).__promoChoice = r))
    window.dispatchEvent(e)
  })

  // 1. The map recedes, the phone rises with the app open in its browser.
  await k.animate(1.4, (e) => css({ 'bg-blur': 16 * e, 'bg-dim': mix(1, 0.42, e), 'phone-y': mix(1100, 0, e) }))
  k.caption('Også på mobilen', 4.4, 'Det samme kartet, i nettleseren på telefonen', 'side')
  await k.hold(3.4)

  // 2. Settings, at the end of the tool bar: install.
  k.caption('Installer det som en app', 9.2, 'Rett fra Innstillinger, uten app-butikk', 'side')
  const phone = (await page.locator('#phone').boundingBox())!
  // Up close on the lower part of the screen (the tool bar, Settings and the install
  // dialog), the phone in the left half: the captions keep the right.
  await k.focus({ x: phone.x, y: phone.y + phone.height * 0.42, width: phone.width * 2.3, height: phone.height * 0.58 }, 0.9, 20)
  await k.click(app.locator('.rail-more-right'), { real: false })
  const tools = await app.evaluate(() => { const t = document.querySelector('.rail-tools')!; return { from: t.scrollLeft, to: t.scrollWidth - t.clientWidth } })
  await k.animate(0.45, (e) => app.evaluate((x) => { document.querySelector('.rail-tools')!.scrollLeft = x }, mix(tools.from, tools.to, e)))
  await k.hold(0.3)
  await k.click(app.getByRole('button', { name: 'Settings', exact: true }))
  await k.hold(0.8)
  await k.click(app.getByRole('button', { name: /Install 868.no Map/ }))
  await k.animate(0.35, (e) => css({ sheet: e }))
  await k.hold(1.4)
  await k.click(page.locator('#install'), { real: false })
  await k.animate(0.3, (e) => css({ sheet: 1 - e }))
  await app.evaluate(() => {
    ;(window as unknown as { __promoChoice: (c: unknown) => void }).__promoChoice({ outcome: 'accepted' })
    window.dispatchEvent(new Event('appinstalled'))
  })
  await k.hold(0.3)

  // 3. Home: the new icon, then launched from it, full screen.
  await k.animate(0.5, (e) => css({ 'app-scale': mix(1, 0.9, e), 'app-op': 1 - e, home: e }))
  await k.focus({ x: phone.x, y: phone.y + phone.height * 0.2, width: phone.width * 2.3, height: phone.height * 0.5 }, 0.8, 20)
  await k.hold(0.3)
  k.caption('Rett på hjemskjermen', 7.4, 'Åpnes i fullskjerm, som en vanlig app', 'side')
  await k.animate(0.5, (e) => css({ icon: e < 0.7 ? (1.12 * e) / 0.7 : 1.12 - (0.12 * (e - 0.7)) / 0.3, label: e }), (t) => t)
  await k.hold(1)
  const icon = page.locator('#newapp img')
  const at = await k.centre(icon)
  const screen = (await page.locator('#screen').boundingBox())!
  await css({ sx: `${at.x - screen.x}px`, sy: `${at.y - screen.y}px`, 'splash-op': 1 })
  await k.click(icon, { real: false })
  await k.animate(0.45, (e) => css({ splash: e }))
  // Under the splash: the app as a fresh launch (no browser bar, panel closed, tools scrolled back).
  await css({ home: 0, toolbar: 0, 'app-scale': 1, 'app-op': 1 })
  await app.getByRole('button', { name: 'Close settings' }).dispatchEvent('click')
  await app.evaluate(() => { document.querySelector('.rail-tools')!.scrollLeft = 0 })
  await k.map((m, v) => m.jumpTo(v), VIEW)
  await k.hold(0.8)
  await k.animate(0.4, (e) => css({ 'splash-op': 1 - e }))
  await k.unfocus(1)
  await k.hold(1)

  // 4. The address, beside the phone.
  k.caption(ADDRESS, 5.5, undefined, 'end')
  await k.hold(5.7)
})
