import type { Page } from '@playwright/test'

type Hook = { __meshmap?: { map: { areTilesLoaded: () => boolean; loaded: () => boolean } } }

/**
 * Documentation screenshots, written to docs/screenshots with
 * UPDATE_SCREENSHOTS=1 and skipped otherwise: they assert nothing, and a
 * full-page screenshot of a software-rendered map can take tens of seconds.
 * First they wait (briefly, without failing) for the window's data and the
 * map's tiles, so a shot never shows "Loading window…" or half-drawn tiles.
 */
export async function docShot(page: Page, name: string, opts: Parameters<Page['screenshot']>[0] = {}): Promise<void> {
  if (process.env.UPDATE_SCREENSHOTS !== '1') return
  await page.locator('.counters[aria-busy="false"], .counters:not([aria-busy])').first().waitFor({ state: 'attached', timeout: 30_000 }).catch(() => {})
  await page.waitForFunction(() => {
    const m = (window as unknown as Hook).__meshmap?.map
    return !m || (m.loaded() && m.areTilesLoaded())
  }, null, { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(500) // the frame after the last tile
  await page.screenshot({ ...opts, path: `../docs/screenshots/${name}` })
}
