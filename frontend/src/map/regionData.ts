// The regions layer's data shapes and name positions, free of map imports
// (so tests can load them without WebGL).

export type RegionId = 'nord' | 'trondelag' | 'vest' | 'ost' | 'sor'

export interface RegionFeature {
  type: 'Feature'
  properties: { id: RegionId; region: string }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
}

export interface RegionCollection {
  type: 'FeatureCollection'
  features: RegionFeature[]
}

/**
 * Where each name sits: hand-picked inland points away from the busiest
 * node clusters, since the geometric centre of a long or fjord-cut region
 * can fall in the sea or in Sweden. The Regions panel's "Show on the map"
 * goes there, at `zoom` (Nord-Norge is long).
 */
export const REGION_LABELS: { id: RegionId; name: string; pos: [number, number]; zoom: number }[] = [
  { id: 'nord', name: 'Nord-Norge', pos: [14.6, 66.5], zoom: 4.6 },
  { id: 'trondelag', name: 'Trøndelag', pos: [12.3, 64.5], zoom: 6.3 },
  { id: 'vest', name: 'Vestlandet', pos: [6.5, 60.75], zoom: 6.2 }, // a line below Østlandet: they share a latitude band
  { id: 'ost', name: 'Østlandet', pos: [10.6, 61.75], zoom: 6.2 },
  { id: 'sor', name: 'Sørlandet', pos: [7.3, 59.15], zoom: 7.1 },
]

/** Names are an overview aid: hidden once node names take over. */
export const REGION_LABEL_MAX_ZOOM = 9
