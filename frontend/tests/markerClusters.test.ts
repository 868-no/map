import { describe, expect, it } from 'vitest'
import type { MeshNode } from '../src/derive/views'
import { toPixels } from '../src/map/labels'
import { clusterMarkers, clusterRadius, clusterSummary, drawnPositions, MARKER_CLUSTER_MAX_ZOOM } from '../src/map/markerClusters'
import type { PlacedNode } from '../src/map/model'
import { NODE_RADIUS } from '../src/map/roleIcons'

const node = (id: string, lat: number, lon: number, o: { role?: string; packets?: number; age?: number; kind?: 'reported' | 'estimated' } = {}): PlacedNode => ({
  kind: o.kind ?? 'reported', lat, lon, age: o.age ?? 0.5,
  node: { id, num: 0, status: 'observed', packets: o.packets ?? 1, receptions: 0, gateway_receptions: 0, is_gateway: false, signatures: { verified: 0, unsigned: 0, unverifiable: 0, not_applicable: 0 }, identity: { short_name: id.slice(-4), role: o.role, has_public_key: false, signature: 'unsigned', observed_at: '' } } as MeshNode,
})

// Trondheim: a few nodes within ~1 km, overlapping at zoom 7, apart at zoom 12.
const client = node('!0000000a', 63.43, 10.39, { age: 0.6 })
const router = node('!0000000b', 63.432, 10.395, { role: 'ROUTER', age: 0.9 })
const busy = node('!0000000c', 63.428, 10.4, { packets: 500, age: 0.1 })
const far = node('!0000000d', 59.91, 10.75) // Oslo
const ids = (ps: PlacedNode[]) => ps.map((p) => p.node.id).sort()

describe('marker clusters', () => {
  it('draws every marker on its own from zoom 10', () => {
    const placed = [client, router, busy, far]
    const m = clusterMarkers(placed, MARKER_CLUSTER_MAX_ZOOM)
    expect(m.shown).toBe(placed) // the same array: layer memos stay valid
    expect(m.clusters).toEqual([])
    expect(m.anchor.size).toBe(0)
  })

  it('groups overlapping markers at the most prominent member, coloured by the freshest', () => {
    const m = clusterMarkers([client, router, busy, far], 7)
    expect(m.clusters).toHaveLength(1)
    const [k] = m.clusters
    expect(k.rep).toBe(router) // a router outranks a busier client
    expect(k.id).toBe(router.node.id)
    expect(k.members[0]).toBe(router)
    expect(ids(k.members)).toEqual(ids([client, router, busy]))
    expect(k.freshest).toBe(0.1) // the busy client was heard most recently
    expect(m.shown).toEqual([far])
    // Every member is anchored at the representative's real position: no invented position.
    for (const p of k.members) expect(m.anchor.get(p.node.id)).toEqual([router.lon, router.lat])
  })

  it('clusters only markers that overlap on screen', () => {
    // Two clients 2 px further apart than their discs (outline included) reach.
    const z = 8
    const [x] = toPixels(10.39, 63.43, z)
    const gap = 2 * NODE_RADIUS + 2 + 2
    const step = (gap / (512 * 2 ** z)) * 360
    const a = node('!000000a1', 63.43, 10.39), b = node('!000000a2', 63.43, 10.39 + step)
    expect(toPixels(b.lon, b.lat, z)[0] - x).toBeCloseTo(gap, 6)
    expect(clusterMarkers([a, b], z).clusters).toEqual([])
    const c = node('!000000a3', 63.43, 10.39 + step / 2)
    expect(clusterMarkers([a, c], z).clusters).toHaveLength(1)
  })

  it('never hides exempt nodes (selection, search results) inside a cluster', () => {
    const m = clusterMarkers([client, router, busy], 7, new Set([router.node.id]))
    expect(ids(m.shown)).toEqual([router.node.id])
    expect(m.clusters).toHaveLength(1)
    expect(m.clusters[0].rep).toBe(busy) // the busiest of the rest
    expect(m.anchor.has(router.node.id)).toBe(false)
  })

  it('prefers a reported position over an estimate as the representative', () => {
    const est = node('!000000e1', 63.43, 10.39, { packets: 900, kind: 'estimated' })
    const rep = node('!000000e2', 63.4301, 10.3901, { packets: 1 })
    expect(clusterMarkers([est, rep], 7).clusters[0].rep).toBe(rep)
  })

  it('does not chain: a line of overlapping markers splits into several clusters', () => {
    // 30 clients along a parallel, each overlapping its neighbours.
    const z = 7, px = 6, step = (px / (512 * 2 ** z)) * 360
    const line = Array.from({ length: 30 }, (_, i) => node(`!00000${String(100 + i)}`, 63, 8 + i * step))
    const m = clusterMarkers(line, z)
    expect(m.clusters.length).toBeGreaterThan(1)
    // Every node is either shown or in exactly one cluster.
    const inClusters = m.clusters.flatMap((k) => k.members)
    expect(new Set(inClusters.map((p) => p.node.id)).size).toBe(inClusters.length)
    expect(inClusters.length + m.shown.length).toBe(line.length)
    // No member lies farther from its representative than the disc and its own marker reach.
    for (const k of m.clusters) {
      const [rx, ry] = toPixels(k.rep.lon, k.rep.lat, z)
      for (const p of k.members) {
        const [x, y] = toPixels(p.lon, p.lat, z)
        expect(Math.hypot(x - rx, y - ry)).toBeLessThan(clusterRadius(k.members.length) + NODE_RADIUS + 2 + 1e-6)
      }
    }
  })

  it('moves clustered nodes to their disc for links and pings, and leaves the rest', () => {
    const pos = new Map<string, [number, number]>([client, router, busy, far].map((p) => [p.node.id, [p.lon, p.lat]]))
    const m = clusterMarkers([client, router, busy, far], 7)
    const d = drawnPositions(pos, m.anchor)
    expect(d.get(client.node.id)).toEqual([router.lon, router.lat])
    expect(d.get(far.node.id)).toEqual([far.lon, far.lat])
    expect(pos.get(client.node.id)).toEqual([client.lon, client.lat]) // the input is untouched
    expect(drawnPositions(pos, new Map())).toBe(pos)
  })

  it('summarises its members for hover, most prominent first', () => {
    const many = Array.from({ length: 12 }, (_, i) => node(`!0000020${i.toString(16)}`, 63.43, 10.39, { packets: 100 - i }))
    const [k] = clusterMarkers(many, 6).clusters
    const lines = clusterSummary(k, (id) => `N-${id.slice(-1)}`).split('\n')
    expect(lines[0]).toBe('12 nodes close together; click to zoom in')
    expect(lines.slice(1, 3)).toEqual(['N-0', 'N-1'])
    expect(lines).toHaveLength(1 + 8)
    expect(lines.at(-1)).toBe('and 5 more')
    expect(clusterSummary(clusterMarkers([client, router], 7).clusters[0], (id) => id).split('\n')).toHaveLength(3)
  })

  it('stays fast for a large mesh', () => {
    const big = Array.from({ length: 5000 }, (_, i) => node(`!${(0x10000 + i).toString(16)}`, 58 + (i % 100) * 0.13, 5 + Math.floor(i / 100) * 0.5))
    const t = performance.now()
    const m = clusterMarkers(big, 5)
    expect(performance.now() - t).toBeLessThan(500)
    expect(m.clusters.reduce((n, k) => n + k.members.length, 0) + m.shown.length).toBe(big.length)
  })
})
