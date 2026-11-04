import { describe, expect, it } from 'vitest'
import type { Edge, MeshNode, SnapshotView } from '../src/derive/views'
import { again, routerLinks, TERRAIN_POLLS, terrainEnd, terrainGaveUp } from '../src/state/terrain'

const node = (id: string, role: string, extra: Partial<MeshNode> = {}): MeshNode => ({
  id, num: 1, status: 'observed', packets: 0, receptions: 0, gateway_receptions: 0, is_gateway: false,
  signatures: { verified: 0, unsigned: 0, unverifiable: 0, not_applicable: 0 },
  identity: { role, has_public_key: false, signature: 'unsigned', observed_at: '' },
  position: { lat: 63.4, lon: 10.4, precision_bits: 32, precision_known: true, signature: 'unsigned', observed_at: '', source: 'position' },
  ...extra,
})
const edge = (src: string, dst: string, mqtt = false) => ({ src, dst, mqtt }) as unknown as Edge

describe('terrain (D-143)', () => {
  it('puts an antenna at the reported altitude, else leaves it to the server', () => {
    expect(terrainEnd(node('!a', 'ROUTER'))).toEqual({ lat: 63.4, lon: 10.4, alt: undefined })
    const high = node('!a', 'ROUTER')
    high.position!.alt = 812
    expect(terrainEnd(high)?.alt).toBe(812)
    const zero = node('!a', 'ROUTER')
    zero.position!.alt = 0 // Meshtastic's "no altitude"
    expect(terrainEnd(zero)?.alt).toBeUndefined()
    expect(terrainEnd(node('!a', 'ROUTER', { position: undefined }))).toBeNull()
  })

  it('classifies router-to-router radio links between reported positions, once per pair', () => {
    const nodes = [node('!a', 'ROUTER'), node('!b', 'ROUTER_LATE'), node('!c', 'CLIENT'), node('!d', 'ROUTER', { position: undefined })]
    const snap = { nodes, edges: [edge('!a', '!b'), edge('!b', '!a'), edge('!a', '!c'), edge('!a', '!d'), edge('!b', '!a', true)] } as unknown as SnapshotView
    expect(routerLinks(snap).map((l) => [l.a, l.b])).toEqual([['!a', '!b']])
  })

  it('polls an answer still missing heights, backing off, and then gives up', () => {
    const q = (incomplete: boolean, n: number) => ({ state: { data: { incomplete }, dataUpdateCount: n } })
    expect(again(q(false, 1))).toBe(false)
    expect(again(q(true, 1))).toBeGreaterThan(0)
    expect(again(q(true, TERRAIN_POLLS))).toBe(60_000)
    expect(terrainGaveUp(q(true, TERRAIN_POLLS))).toBe(false)
    expect(again(q(true, TERRAIN_POLLS + 1))).toBe(false)
    expect(terrainGaveUp(q(true, TERRAIN_POLLS + 1))).toBe(true)
    expect(terrainGaveUp(q(false, TERRAIN_POLLS + 1))).toBe(false)
  })
})
