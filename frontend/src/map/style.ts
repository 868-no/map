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
 * Load a bundled style (dark or light) and point it at the configured tile source.
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

const paintRequests = new WeakMap<maplibregl.Map, number>()

/**
 * Switch the map to another style with the same layers (the light and dark
 * themes) by copying its paint properties: unlike setStyle, this keeps the
 * deck.gl layers interleaved in the style and the viewer's layer visibility.
 */
export async function applyStylePaint(map: maplibregl.Map, styleURL: string): Promise<void> {
  // Only the latest request paints: after quick theme toggles, an earlier
  // style answering last must not repaint the theme just left.
  const token = (paintRequests.get(map) ?? 0) + 1
  paintRequests.set(map, token)
  const res = await fetch(styleURL)
  if (!res.ok) throw new Error(`map style unavailable (${res.status})`)
  const style = (await res.json()) as StyleSpecification
  if (paintRequests.get(map) !== token) return
  for (const l of style.layers) {
    if (!map.getLayer(l.id) || !('paint' in l) || !l.paint) continue
    for (const [k, v] of Object.entries(l.paint)) map.setPaintProperty(l.id, k, v)
  }
}

/** Id of the style layer that mesh overlays are inserted beneath. */
export const LABELS_BEFORE = 'labels-start'

