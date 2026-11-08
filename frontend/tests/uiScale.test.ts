import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOGGLES_KEY, UI_SCALES } from '../src/state/store'
import { applyUiScale } from '../src/theme'

// The UI scale (Settings): kept with the theme in TOGGLES_KEY, applied to
// <html> as --ui-scale, which index.css sizes everything from.
const save = (v: unknown) => localStorage.setItem(TOGGLES_KEY, JSON.stringify(v))
const loadStore = async () => {
  vi.resetModules()
  return (await import('../src/state/store')).useStore.getState().toggles
}
const html = document.documentElement

describe('UI scale', () => {
  beforeEach(() => {
    localStorage.clear()
    html.style.removeProperty('--ui-scale')
  })
  afterEach(() => localStorage.clear())

  it('is 100 % when nothing is saved', async () => {
    expect((await loadStore()).uiScale).toBe(1)
  })

  it('keeps a saved scale Settings offers, and nothing else', async () => {
    save({ uiScale: 1.3, theme: 'light' })
    expect(await loadStore()).toMatchObject({ uiScale: 1.3, theme: 'light' })
    for (const bad of [7, 0, -1, '1.3', null, 1.2]) {
      save({ uiScale: bad })
      expect((await loadStore()).uiScale).toBe(1)
    }
  })

  it('is saved when changed', async () => {
    vi.resetModules()
    const { useStore } = await import('../src/state/store')
    useStore.getState().setToggles({ uiScale: 1.15 })
    expect(JSON.parse(localStorage.getItem(TOGGLES_KEY)!).uiScale).toBe(1.15)
  })

  it('is set on <html> for the stylesheet', () => {
    applyUiScale(1.5)
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.5')
  })

  // public/theme-boot.js runs before the app, so it cannot import UI_SCALES:
  // it must read the same key and accept exactly the same scales.
  it('is applied before the first paint by the boot script, for the same scales', () => {
    const boot = readFileSync('public/theme-boot.js', 'utf8')
    expect(boot).toContain(`'${TOGGLES_KEY}'`)
    const run = () => new Function(boot)()
    for (const v of UI_SCALES) {
      html.style.removeProperty('--ui-scale')
      save({ uiScale: v })
      run()
      expect(html.style.getPropertyValue('--ui-scale') || '1').toBe(String(v))
    }
    html.style.removeProperty('--ui-scale')
    save({ uiScale: 9 })
    run()
    expect(html.style.getPropertyValue('--ui-scale')).toBe('')
  })
})
