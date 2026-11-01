import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REGION_LABELS, type RegionCollection } from '../src/map/regionData'

// vitest runs in frontend/
const fc = JSON.parse(readFileSync('src/assets/regions.geojson', 'utf8')) as RegionCollection

type Ring = [number, number][]
const polygons = (g: RegionCollection['features'][number]['geometry']): Ring[][] =>
  g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][])

// Even-odd rule over every ring, so holes count as outside.
function inside([x, y]: [number, number], g: RegionCollection['features'][number]['geometry']): boolean {
  let hit = false
  for (const poly of polygons(g))
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j]
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
      }
  return hit
}

describe('Norway regions layer', () => {
  it('holds the five landsdeler', () => {
    expect(fc.features.map((f) => f.properties.region).sort()).toEqual(['Nord-Norge', 'Sørlandet', 'Trøndelag', 'Vestlandet', 'Østlandet'])
  })
  it('places every name inside its own region and no other', () => {
    for (const l of REGION_LABELS) {
      const hits = fc.features.filter((f) => inside(l.pos, f.geometry)).map((f) => f.properties.id)
      expect(hits, l.name).toEqual([l.id])
    }
  })
  it('puts known places in the right region', () => {
    const at = (lon: number, lat: number) => fc.features.find((f) => inside([lon, lat], f.geometry))?.properties.region
    expect(at(10.395, 63.43)).toBe('Trøndelag') // Trondheim
    expect(at(18.955, 69.65)).toBe('Nord-Norge') // Tromsø
    expect(at(5.32, 60.39)).toBe('Vestlandet') // Bergen
    expect(at(10.75, 59.91)).toBe('Østlandet') // Oslo
    expect(at(7.99, 58.15)).toBe('Sørlandet') // Kristiansand
  })
  // The layer insets each outline with a negative path offset, which lands
  // inside the region only when outer rings run counter-clockwise.
  it('winds outer rings counter-clockwise and holes clockwise (RFC 7946)', () => {
    const area = (r: Ring) => r.slice(1).reduce((s, b, i) => s + r[i][0] * b[1] - b[0] * r[i][1], 0) / 2
    for (const f of fc.features)
      for (const [outer, ...holes] of polygons(f.geometry)) {
        expect(area(outer)).toBeGreaterThan(0)
        for (const h of holes) expect(area(h)).toBeLessThan(0)
      }
  })
})
