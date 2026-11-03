import type { Page } from '@playwright/test'

/**
 * Documentation screenshots, written to docs/screenshots with
 * UPDATE_SCREENSHOTS=1 and skipped otherwise: they assert nothing, and a
 * full-page screenshot of a software-rendered map can take tens of seconds.
 */
export async function docShot(page: Page, name: string, opts: Parameters<Page['screenshot']>[0] = {}): Promise<void> {
  if (process.env.UPDATE_SCREENSHOTS !== '1') return
  await page.screenshot({ ...opts, path: `../docs/screenshots/${name}` })
}
