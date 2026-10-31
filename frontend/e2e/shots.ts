import type { Page } from '@playwright/test'

/**
 * Documentation screenshots. Written to docs/screenshots only with
 * UPDATE_SCREENSHOTS=1, so ordinary test runs never change tracked files;
 * otherwise they go to the (ignored) results folder for inspection.
 */
export function docShot(page: Page, name: string, opts: Parameters<Page['screenshot']>[0] = {}) {
  const dir = process.env.UPDATE_SCREENSHOTS === '1' ? '../docs/screenshots' : 'e2e/.results/screenshots'
  return page.screenshot({ ...opts, path: `${dir}/${name}` })
}
