import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REGION_LABELS, centreOfMass, type RegionCollection } from '../src/map/regionData'

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
  // "Show on the map" goes to the stored centre (D-201): it must stay the
  // boundaries' centre of mass if scripts/regions.sh redraws them.
  it("stores each region's centre of mass", () => {
    for (const l of REGION_LABELS) {
      const f = fc.features.find((x) => x.properties.id === l.id)!
      const [lon, lat] = centreOfMass(f.geometry)
      expect(Math.abs(lon - l.centre[0]), `${l.name} longitude ${lon.toFixed(3)}`).toBeLessThan(0.01)
      expect(Math.abs(lat - l.centre[1]), `${l.name} latitude ${lat.toFixed(3)}`).toBeLessThan(0.01)
    }
  })
  it('weighs area alike in the north and south', () => {
    // A 2°×2° square: on an equal-area projection its centre of mass lies a
    // little south of the middle latitude, where degrees of longitude are wider.
    const sq = { type: 'Polygon' as const, coordinates: [[[10, 60], [12, 60], [12, 62], [10, 62], [10, 60]]] }
    const [lon, lat] = centreOfMass(sq)
    expect(lon).toBeCloseTo(11, 6)
    expect(lat).toBeGreaterThan(60.9)
    expect(lat).toBeLessThan(61)
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
