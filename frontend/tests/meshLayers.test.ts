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
    const c = byId(build({ ...base, links: [{ ...link }], selection: { kind: 'node', id: '!b' } }))
    expect(c.uncertainty.data).not.toBe(b.uncertainty.data) // only the selected node's circle now
    expect(c['links-other'].updateTriggers).toEqual(b['links-other'].updateTriggers) // a node selection leaves links alone
  })

  it('draws the uplink kind in a badge on the rim and a downlink beside it (D-084, D-186)', () => {
    const gw = (id: string, lon: number, extra: object): PlacedNode => ({ node: { ...node(id), is_gateway: true, ...extra }, kind: 'reported', lon, lat: 61, age: 0 })
    const ls = byId(meshLayerBuilder()({ ...base, placed: [gw('!u', 5, { multi_uplink: true }), gw('!d', 7, { multi_uplink: true, mqtt_downlink: { zero_snr: 3, traceroutes: 4 } }), gw('!g', 9, {}), gw('!b', 11, { mqtt_downlink: { zero_snr: 3, traceroutes: 4 } }), { ...gw('!o', 13, { mqtt_downlink: { zero_snr: 3, traceroutes: 4 } }), node: { ...node('!o'), mqtt_downlink: { zero_snr: 3, traceroutes: 4 } } }] }))
    const glyphs = (ls['node-glyphs'].data as { p: PlacedNode; icon: string; part: string }[]).filter((g) => g.part === 'uplink' || g.part === 'down').map((g) => `${g.p.node.id}:${g.icon}`)
    expect(glyphs.sort()).toEqual(['!b:down', '!b:up', '!d:down', '!d:upAll', '!g:up', '!o:down', '!u:upAll'])
  })

  it('draws a marker drawn later above an earlier node and its glyphs, by depth (D-187)', () => {
    // A downlinking gateway listed first, a plain node at the same position after it.
    const gw: PlacedNode = { node: { ...node('!g'), is_gateway: true, mqtt_downlink: { zero_snr: 3, traceroutes: 4 } }, kind: 'reported', lon: 10, lat: 60, age: 0 }
    const plain: PlacedNode = { node: node('!p'), kind: 'reported', lon: 10, lat: 60, age: 0 }
    const ls = byId(meshLayerBuilder()({ ...base, placed: [gw, plain] }))
    const order = (props: Record<string, unknown>, d: unknown, index: number) => (props.getDrawOrder as (d: unknown, o: { index: number }) => number)(d, { index })
    // One layer of markers and one of glyphs, whatever overlaps.
    expect(Object.keys(ls).filter((id) => id.startsWith('node'))).toEqual(['nodes', 'node-glyphs'])
    const markers = ls.nodes.data as PlacedNode[]
    expect(markers.map((p) => p.node.id)).toEqual(['!g', '!p'])
    const glyphs = ls['node-glyphs'].data as { p: PlacedNode; part: string }[]
    expect(glyphs.map((g) => `${g.p.node.id}:${g.part}`)).toEqual(['!g:role', '!g:rim', '!g:badge', '!g:uplink', '!g:down', '!p:role'])
    // The gateway's glyphs are above its disc and below the later node's disc; that node's glyph above both.
    const disc = markers.map((p, k) => order(ls.nodes, p, k))
    const glyph = glyphs.map((g, k) => order(ls['node-glyphs'], g, k))
    expect(glyph.slice(0, 5).every((d) => d > disc[0] && d < disc[1])).toBe(true)
    expect(glyph[5]).toBeGreaterThan(disc[1])
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
    expect((ls['node-glyphs'].data as { p: PlacedNode; part: string }[]).filter((g) => g.p.node.id === '!m').map((g) => g.part)).toEqual(['role', 'plane'])
    expect('trails' in byId(build({ ...base, placed: [...placed, mover] }))).toBe(false) // off by default
    // With another node selected, its trail is hidden; with this one, shown.
    const on = { ...base.toggles, trails: true }
    expect('trails' in byId(build({ ...base, placed: [...placed, mover], toggles: on, selection: { kind: 'node', id: '!a' } }))).toBe(false)
    expect((byId(build({ ...base, placed: [...placed, mover], toggles: on, selection: { kind: 'node', id: '!m' } })).trails.data as unknown[]).length).toBe(2)
  })

  it('shows only the selected node\'s accuracy circle when one is selected', () => {
    const build = meshLayerBuilder()
    // Switched on (base) with nothing selected: the estimated node's circle.
    expect((byId(build(base)).uncertainty.data as unknown[]).length).toBe(1)
    // Another node selected: its circle only, here none (no coarse position).
    expect('uncertainty' in byId(build({ ...base, selection: { kind: 'node', id: '!a' } }))).toBe(false)
    // The estimated node selected: its own.
    expect((byId(build({ ...base, selection: { kind: 'node', id: '!b' } })).uncertainty.data as unknown[]).length).toBe(1)
  })

  it('keeps a position trail short: the last three places, then the marker', () => {
    const track = Array.from({ length: 6 }, (_, k) => ({ lat: 60 + k * 0.01, lon: 10, at: `t${k}` }))
    const mover: PlacedNode = { node: { ...node('!m'), moved_at: 't5', track }, kind: 'reported', lon: 10, lat: 60.07, age: 0 }
    const ls = byId(meshLayerBuilder()({ ...base, placed: [mover], toggles: { ...base.toggles, trails: true } }))
    expect((ls.trails.data as unknown[]).length).toBe(3)
  })
})

