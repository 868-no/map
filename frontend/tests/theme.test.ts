import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveTheme } from '../src/theme'
import { TOGGLES_KEY } from '../src/state/store'

type StyleLayer = { id: string; type: string; paint?: Record<string, unknown> } & Record<string, unknown>
const style = (name: string) => JSON.parse(readFileSync(`../web/styles/${name}.json`, 'utf8')) as { layers: StyleLayer[]; sources: unknown; glyphs: string }

describe('themes', () => {
  it('follow the browser unless the viewer chose one', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
  })

  // Switching theme copies paint properties onto the live map (applyStylePaint),
  // so the two styles must have the same layers, differing only in colours.
  it('light and dark map styles differ only in paint', () => {
    const dark = style('dark'), light = style('light')
    const strip = (l: StyleLayer) => ({ ...l, paint: Object.keys(l.paint ?? {}) })
    expect(light.layers.map(strip)).toEqual(dark.layers.map(strip))
    expect(light.sources).toEqual(dark.sources)
    expect(light.glyphs).toBe(dark.glyphs)
  })

  it('the boot script reads the saved theme from the store\'s key', () => {
    expect(readFileSync('public/theme-boot.js', 'utf8')).toContain(`'${TOGGLES_KEY}'`)
  })
})
