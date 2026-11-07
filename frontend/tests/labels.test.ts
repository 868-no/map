import { describe, expect, it } from 'vitest'
import type { MeshNode } from '../src/derive/views'
import { clusterLabels, FAN_MAX, fanOut, fromPixels, labelData, toPixels } from '../src/map/labels'
import type { PlacedNode } from '../src/map/model'

const node = (id: string, lat: number, lon: number, name: string, role?: string, packets = 1): PlacedNode => ({
  kind: 'reported', lat, lon, age: 0,
  node: { id, num: 0, status: 'observed', packets, receptions: 0, gateway_receptions: 0, is_gateway: false, signatures: { verified: 0, unsigned: 0, unverifiable: 0, not_applicable: 0 }, identity: { short_name: name, role, has_public_key: false, signature: 'unsigned', observed_at: '' } } as MeshNode,
})

// ~50 m apart near Oslo: overlapping names at zoom 12, separate at zoom 18.
const a = node('!0000000a', 59.9100, 10.7500, 'ALFA')
const b = node('!0000000b', 59.9104, 10.7503, 'BRAV', 'ROUTER')
const c = node('!0000000c', 59.9102, 10.7508, 'CHAR', undefined, 50)
const far = node('!0000000d', 60.2, 11.0, 'FAR')

describe('label clusters', () => {
  it('round-trips world pixels', () => {
    const [x, y] = toPixels(10.75, 59.91, 12.5)
    const [lon, lat] = fromPixels(x, y, 12.5)
    expect(lon).toBeCloseTo(10.75, 9)
    expect(lat).toBeCloseTo(59.91, 9)
  })

  it('groups names that would overlap, led by the most prominent node', () => {
    const cs = clusterLabels([a, b, c, far], 12)
    const big = cs.find((x) => x.members.length > 1)!
    expect(big.members.map((m) => m.node.id).sort()).toEqual([a, b, c].map((n) => n.node.id).sort())
    expect(big.lead).toBe(b) // a router outranks a busier client
    expect(cs.filter((x) => x.members.length === 1).map((x) => x.lead)).toEqual([far])
    expect(clusterLabels([a, b, c], 18).every((x) => x.members.length === 1)).toBe(true) // zoomed in: no overlap
  })

  it('collapses to one name with a count, and fans out to every name with leader lines', () => {
    const cs = clusterLabels([a, b, c, far], 12)
    const big = cs.find((x) => x.members.length > 1)!
    const collapsed = labelData(cs, new Set(), 12)
    expect(collapsed.labels.map((l) => l.text).sort()).toEqual(['BRAV +2', 'FAR'])
    expect(collapsed.leaders).toEqual([])
    const open = labelData(cs, new Set([big.id]), 12)
    expect(open.labels.map((l) => l.text).sort()).toEqual(['ALFA', 'BRAV', 'CHAR', 'FAR'])
    expect(open.leaders).toHaveLength(3)
  })

  it('fans names far enough apart not to overlap, markers unmoved', () => {
    const many = Array.from({ length: 8 }, (_, i) => node(`!0000001${i}`, 59.91, 10.75, `N${i}XX`)) // coincident markers
    const [cl] = clusterLabels(many, 14)
    const slots = fanOut(cl, 14).map((s) => toPixels(s.pos[0], s.pos[1], 14))
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const dx = Math.abs(slots[i][0] - slots[j][0]), dy = Math.abs(slots[i][1] - slots[j][1])
        expect(dx >= 50 || dy >= 22).toBe(true)
      }
    }
    expect(many.every((m) => m.lat === 59.91 && m.lon === 10.75)).toBe(true)
  })

  it('fans out at most FAN_MAX names, the selected one always among them, and counts the rest', () => {
    const crowd = Array.from({ length: 40 }, (_, i) => node(`!000001${i.toString(16).padStart(2, '0')}`, 59.91, 10.75, `N${i}`, undefined, 100 - i))
    const [cl] = clusterLabels(crowd, 14)
    expect(cl.members).toHaveLength(40)
    const quiet = crowd[39].node.id // the least prominent
    const open = labelData([cl], new Set([cl.id]), 14, quiet)
    const names = open.labels.filter((l) => !l.more)
    expect(names).toHaveLength(FAN_MAX)
    expect(names.some((l) => l.node.node.id === quiet)).toBe(true)
    expect(open.leaders).toHaveLength(FAN_MAX)
    const more = open.labels.find((l) => l.more)!
    expect(more.text).toBe(`+${40 - FAN_MAX} more`)
    expect(more.more!.count).toBe(40 - FAN_MAX)
    expect(fanOut(cl, 14)).toHaveLength(FAN_MAX)
  })
})
