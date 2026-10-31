import * as maplibregl from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import { Protocol } from 'pmtiles'

let registered = false

/** Register the pmtiles:// protocol once (self-hosted basemap). */
export function registerPMTiles(): void {
  if (registered) return
  const p = new Protocol()
  maplibregl.addProtocol('pmtiles', p.tile)
  registered = true
}

/**
 * Load the bundled dark style and point it at the configured tile source.
 * MapLibre needs absolute URLs, so relative glyph and pmtiles paths are
 * resolved against this origin.
 */
export async function loadStyle(styleURL: string, tileSource: string): Promise<StyleSpecification> {
  const origin = window.location.origin
  const res = await fetch(styleURL)
  if (!res.ok) throw new Error(`map style unavailable (${res.status})`)
  const style = (await res.json()) as StyleSpecification
  let src = tileSource
  if (src.startsWith('pmtiles:///')) src = `pmtiles://${origin}${src.slice('pmtiles://'.length)}`
  else if (src.startsWith('/')) src = origin + src
  const omt = style.sources.openmaptiles as { url?: string }
  omt.url = src
  if (style.glyphs?.startsWith('/')) style.glyphs = origin + style.glyphs
  return style
}

/** Id of the style layer that mesh overlays are inserted beneath. */
export const LABELS_BEFORE = 'labels-start'

