// Norway's five regions (landsdeler) as a reference layer beneath the mesh.
// Boundaries: Kartverket's 2024 counties (CC BY 4.0), dissolved and
// simplified by scripts/regions.sh. Fetched only when the layer is on.
import { useEffect, useState } from 'react'
import { GeoJsonLayer, TextLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import regionsUrl from '../assets/regions.geojson?url'
import { UNDER_LABELS, type RGBA } from './deckShared'
import type { MapPalette } from './palette'
import { REGION_LABELS, REGION_LABEL_MAX_ZOOM, type RegionCollection, type RegionFeature, type RegionId } from './regionData'

export { REGION_LABELS, type RegionCollection, type RegionId } from './regionData'

let cached: Promise<RegionCollection> | undefined

/** The region polygons, loaded once the layer is first switched on. */
export function useRegions(enabled: boolean): RegionCollection | null {
  const [data, setData] = useState<RegionCollection | null>(null)
  useEffect(() => {
    if (!enabled || data) return
    let live = true
    cached ??= fetch(regionsUrl).then((r) => {
      if (!r.ok) throw new Error(`regions: HTTP ${r.status}`)
      return r.json() as Promise<RegionCollection>
    })
    cached.then(
      (fc) => live && setData(fc),
      (e) => {
        cached = undefined // try again next time the layer is switched on
        console.warn('regions unavailable', e)
      },
    )
    return () => {
      live = false
    }
  }, [enabled, data])
  return enabled ? data : null
}

/** Faint per-region fills with outlines, and the region names at overview zooms. */
export function regionLayers(fc: RegionCollection, zoom: number, c: MapPalette): Layer[] {
  const tint = (id: RegionId, a: number) => [...c.regions[id], a] as RGBA
  const layers: Layer[] = [
    new GeoJsonLayer<RegionFeature['properties']>({
      id: 'regions', ...UNDER_LABELS, data: fc as never,
      filled: true, stroked: true,
      getFillColor: (f) => tint(f.properties.id, c.regionFillAlpha),
      getLineColor: (f) => tint(f.properties.id, 170),
      lineWidthUnits: 'pixels', getLineWidth: 1.5,
      pickable: false,
      updateTriggers: { getFillColor: [c], getLineColor: [c] },
    }),
  ]
  if (zoom < REGION_LABEL_MAX_ZOOM) {
    layers.push(
      new TextLayer<(typeof REGION_LABELS)[number]>({
        id: 'region-labels', ...UNDER_LABELS, data: REGION_LABELS,
        getPosition: (l) => l.pos, getText: (l) => l.name,
        // Scale with the map, within limits: small on the national overview.
        getSize: 25_000, sizeUnits: 'meters', sizeMinPixels: 12, sizeMaxPixels: 22,
        getColor: (l) => tint(l.id, 230),
        characterSet: 'auto', fontFamily: 'system-ui, sans-serif', fontWeight: 800,
        outlineWidth: 4, outlineColor: c.textOutline, fontSettings: { sdf: true, fontSize: 64, buffer: 16, radius: 16 },
        pickable: false,
        updateTriggers: { getColor: [c] },
      }),
    )
  }
  return layers
}
