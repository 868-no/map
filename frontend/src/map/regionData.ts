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
 * can fall in the sea or in Sweden. `centre` is the region's centre of mass
 * (its area's centroid, on an equal-area projection; tests/regions.test.ts
 * checks it against the boundaries), where the Regions panel's "Show on the
 * map" goes, at `zoom` (Nord-Norge is long). Nord-Norge's falls just across
 * the border, near the three-country cairn: the region curves around it.
 */
export const REGION_LABELS: { id: RegionId; name: string; pos: [number, number]; centre: [number, number]; zoom: number }[] = [
  { id: 'nord', name: 'Nord-Norge', pos: [14.6, 66.5], centre: [20.62, 68.69], zoom: 4.6 },
  { id: 'trondelag', name: 'Trøndelag', pos: [12.3, 64.5], centre: [11.35, 63.72], zoom: 6.3 },
  { id: 'vest', name: 'Vestlandet', pos: [6.5, 60.75], centre: [6.68, 61.0], zoom: 6.2 }, // a line below Østlandet: they share a latitude band
  { id: 'ost', name: 'Østlandet', pos: [10.6, 61.75], centre: [9.99, 60.7], zoom: 6.2 },
  { id: 'sor', name: 'Sørlandet', pos: [7.3, 59.15], centre: [7.62, 58.69], zoom: 7.1 },
]

/**
 * A region's centre of mass, [lon, lat]: the centroid of its polygons (holes
 * subtracted) on Lambert's cylindrical equal-area projection (x = longitude,
 * y = sin latitude), so every square kilometre weighs the same, whereas on
 * Web Mercator the far north would weigh more.
 */
export function centreOfMass(geometry: RegionFeature['geometry']): [number, number] {
  const polys = (geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]) as [number, number][][][]
  let a = 0, cx = 0, cy = 0
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const [lon0, lat0] = ring[i], [lon1, lat1] = ring[(i + 1) % ring.length]
        const x0 = (lon0 * Math.PI) / 180, y0 = Math.sin((lat0 * Math.PI) / 180)
        const x1 = (lon1 * Math.PI) / 180, y1 = Math.sin((lat1 * Math.PI) / 180)
        const c = x0 * y1 - x1 * y0 // signed: outer rings run counter-clockwise, holes clockwise
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
      }
    }
  }
  a /= 2
  return [((cx / (6 * a)) * 180) / Math.PI, (Math.asin(cy / (6 * a)) * 180) / Math.PI]
}

/** Names are an overview aid: hidden once node names take over. */
export const REGION_LABEL_MAX_ZOOM = 9
