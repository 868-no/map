import { describe, expect, it, vi } from 'vitest'
import type { Layer } from '@deck.gl/core'

vi.mock('../src/map/style', () => ({ LABELS_BEFORE: 'labels' })) // keeps MapLibre (no WebGL here) out
import { meshLayerBuilder, type MeshLayerInput } from '../src/map/meshLayers'
import type { LinkGeom, PlacedNode } from '../src/map/model'
import type { MeshNode } from '../src/derive/views'
import { defaultToggles } from '../src/state/store'
import { PALETTES } from '../src/map/palette'

const node = (id: string): MeshNode => ({
  id, num: 1, status: 'observed', packets: 1, receptions: 1, gateway_receptions: 0, is_gateway: false,
  signatures: { verified: 0, unsigned: 1, unverifiable: 0, not_applicable: 0 },
})
const placed: PlacedNode[] = [
  { node: node('!a'), kind: 'reported', lon: 10, lat: 60, age: 0 },
  { node: node('!b'), kind: 'estimated', lon: 10.1, lat: 60.1, age: 0.5, radiusM: 900 },
]
const link: LinkGeom = { a: '!a', b: '!b', path: [[10, 60], [10.1, 60.1]], confidence: 'high', inferred: false, samples: 3, infra: false, mqtt: false }
const base: MeshLayerInput = {
  placed, links: [link], selection: null, search: '', toggles: { ...defaultToggles, labels: false, uncertainty: true },
  zoom: 9, clusters: [], exploded: new Set(), route: null, palette: PALETTES.dark,
}
const byId = (ls: Layer[]) => Object.fromEntries(ls.map((l) => [l.id, l.props]))

describe('mesh layer builder', () => {
  it('keeps data arrays when only selection, search or zoom change', () => {
    const build = meshLayerBuilder()
    const a = byId(build(base))
    const b = byId(build({ ...base, selection: { kind: 'edge', src: '!a', dst: '!b' }, search: 'a', zoom: 9.5 }))
    for (const id of ['links-other', 'links-other-inferred', 'nodes', 'uncertainty']) expect(b[id].data).toBe(a[id].data)
    // Recolouring goes through updateTriggers instead.
    expect(b['links-other'].updateTriggers).not.toEqual(a['links-other'].updateTriggers)
    expect(b.nodes.updateTriggers).not.toEqual(a.nodes.updateTriggers)
  })

  it('rebuilds only the data whose inputs changed', () => {
    const build = meshLayerBuilder()
    const a = byId(build(base))
    const b = byId(build({ ...base, links: [{ ...link }] }))
    expect(b['links-other'].data).not.toBe(a['links-other'].data)
    expect(b.uncertainty.data).toBe(a.uncertainty.data)
    const c = byId(build({ ...base, links: [{ ...link }], selection: { kind: 'node', id: '!a' } }))
    expect(c.uncertainty.data).not.toBe(b.uncertainty.data) // the selected node's circle
    expect(c['links-other'].updateTriggers).toEqual(b['links-other'].updateTriggers) // a node selection leaves links alone
  })

  it('draws a fading trail with arrows behind a moving node, and a plane badge when airborne (D-073)', () => {
    const track = [{ lat: 60.2, lon: 10.2, at: 't0' }, { lat: 60.25, lon: 10.25, at: 't1' }]
    const mover: PlacedNode = { node: { ...node('!m'), moved_at: 't1', track, airborne: true }, kind: 'reported', lon: 10.3, lat: 60.3, age: 0 }
    const build = meshLayerBuilder()
    const ls = byId(build({ ...base, placed: [...placed, mover], toggles: { ...base.toggles, trails: true } }))
    const trail = ls.trails.data as { alpha: number }[]
    expect(trail).toHaveLength(2) // two positions, then on to the marker
    expect(trail[1].alpha).toBeGreaterThan(trail[0].alpha) // fading towards the oldest
    expect((ls['trail-arrows'].data as unknown[]).length).toBe(2)
    expect((ls['mqtt-glyphs'].data as { flow: string }[]).map((g) => g.flow)).toEqual(['plane'])
    expect('trails' in byId(build({ ...base, placed: [...placed, mover] }))).toBe(false) // off by default
    // With another node selected, its trail is hidden; with this one, shown.
    const on = { ...base.toggles, trails: true }
    expect('trails' in byId(build({ ...base, placed: [...placed, mover], toggles: on, selection: { kind: 'node', id: '!a' } }))).toBe(false)
    expect((byId(build({ ...base, placed: [...placed, mover], toggles: on, selection: { kind: 'node', id: '!m' } })).trails.data as unknown[]).length).toBe(2)
  })
})

