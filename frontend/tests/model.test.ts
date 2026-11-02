import { describe, expect, it } from 'vitest'
import { ageColor, AGE_STOPS, isOnline, ONLINE_MS, bridgeRoute, filterEdges, glyphInk, relativeLuminance, isInfraRole, mqttDownlink, mqttUplink, LOW_ZOOM_LINKS, precisionErrorM, visibleLinks, lastHeardAge, ageMs, linkGeometry, placeNodes, roleRadius } from '../src/map/model'

// WCAG contrast ratio.
const contrast = (a: readonly number[], b: readonly number[]) => (Math.max(relativeLuminance(a), relativeLuminance(b)) + 0.05) / (Math.min(relativeLuminance(a), relativeLuminance(b)) + 0.05)
import { defaultFilters, defaultToggles } from '../src/state/store'

const node = (id: string, extra: object = {}) => ({ id, num: parseInt(id.slice(1), 16), status: 'observed', packets: 1, receptions: 1, gateway_receptions: 0, is_gateway: false,
  signatures: { verified: 0, unsigned: 1, unverifiable: 0, not_applicable: 0 }, last_seen: '2026-10-31T00:00:00Z', ...extra }) as never
const edge = (src: string, dst: string, extra: object = {}) => ({ src, dst, src_num: 0, dst_num: 0, samples: 3, confidence: 'high', inferred: false, reason: '',
  evidence: { neighbor: 1, traceroute: 0, direct_rf: 0, relay_hint: 0 }, snr: { n: 0 }, rssi: { n: 0 }, first_at: '', last_at: '', ...extra }) as never

describe('map view model', () => {
  it('separates reported, estimated and unpositioned nodes', () => {
    const { placed, unplaced } = placeNodes([
      node('!00000001', { position: { lat: 63, lon: 10, precision_bits: 32, precision_known: true, signature: 'unsigned', observed_at: '' } }),
      node('!00000002', { estimate: { lat: 63.1, lon: 10.1, uncertainty_radius_m: 3000 } }),
      node('!00000003'),
    ], Date.parse('2026-10-31T00:00:00Z'), 3600_000)
    expect(placed.map((p) => p.kind)).toEqual(['reported', 'estimated'])
    expect(placed[1].radiusM).toBe(3000)
    expect(unplaced).toHaveLength(1)
  })
  it('scales last-heard age logarithmically over the selected window', () => {
    const end = Date.parse('2026-10-31T04:00:00Z')
    const n = node('!1', { last_seen: '2026-10-31T03:00:00Z' })
    const W = 72 * 3600_000
    expect(lastHeardAge(node('!1', { last_seen: '2026-10-31T04:00:00Z' }), end, W)).toBe(0)
    expect(lastHeardAge(n, end, W)).toBeCloseTo(Math.log(7) / Math.log(433)) // an hour ago: about a third along, not 1/72
    expect(lastHeardAge(node('!1', { last_seen: '2026-10-30T00:00:00Z' }), end, 3600_000)).toBe(1)
    for (const a of [0, 0.25, 0.5, 1]) expect(lastHeardAge(node('!1', { last_seen: new Date(end - ageMs(a, W)).toISOString() }), end, W)).toBeCloseTo(a)
    // Referenced-only nodes count from when they were last named.
    expect(lastHeardAge(node('!1', { last_seen: undefined, last_referenced: '2026-10-31T04:00:00Z' }), end, W)).toBe(0)
    expect(ageColor(0)).toEqual(AGE_STOPS[0])
    expect(ageColor(1)).toEqual(AGE_STOPS[AGE_STOPS.length - 1])
    expect(ageColor(0.5)).toEqual(AGE_STOPS[2])
  })
  it('matches the backend precision error for coarse positions', () => {
    expect(precisionErrorM(32, 63)).toBe(0)
    expect(precisionErrorM(15, 63)).toBeGreaterThan(700)
    expect(precisionErrorM(15, 63)).toBeLessThan(900)
  })
  it('sizes markers by role', () => {
    expect(roleRadius('ROUTER')).toBe(roleRadius('ROUTER_LATE'))
    expect(roleRadius('ROUTER')).toBeGreaterThan(roleRadius('CLIENT_BASE'))
    expect(roleRadius('CLIENT_BASE')).toBeGreaterThan(roleRadius('CLIENT'))
    expect(roleRadius(undefined)).toBe(roleRadius('CLIENT_MUTE'))
  })
  it('hides inferred links when toggled and applies confidence filters', () => {
    const es = [edge('!a', '!b'), edge('!b', '!c', { confidence: 'low', inferred: true })]
    expect(filterEdges(es, defaultFilters, { ...defaultToggles, inferred: false })).toHaveLength(1)
    expect(filterEdges(es, { ...defaultFilters, minConfidence: 'high' }, defaultToggles)).toHaveLength(1)
  })
  it('classes a link as infrastructure only when both ends are routers', () => {
    const pos = new Map<string, [number, number]>([['!a', [10, 63]], ['!b', [10.1, 63]], ['!c', [10.2, 63]], ['!d', [10.3, 63]]])
    const roles = new Map<string, string | undefined>([['!a', 'ROUTER'], ['!b', 'ROUTER_LATE'], ['!c', 'CLIENT_BASE'], ['!d', undefined]])
    const g = linkGeometry([edge('!a', '!b'), edge('!a', '!c'), edge('!b', '!d')], pos, roles)
    const infra = (a: string, b: string) => g.find((l) => l.a === a && l.b === b)!.infra
    expect(infra('!a', '!b')).toBe(true)
    expect(infra('!a', '!c')).toBe(false)
    expect(infra('!b', '!d')).toBe(false)
    expect(isInfraRole('CLIENT')).toBe(false)
  })
  it('keeps MQTT links apart from radio links, never as infrastructure (D-055)', () => {
    const pos = new Map<string, [number, number]>([['!a', [10, 63]], ['!b', [10.1, 63]]])
    const roles = new Map<string, string | undefined>([['!a', 'ROUTER'], ['!b', 'ROUTER']])
    const g = linkGeometry([edge('!a', '!b'), edge('!a', '!b', { mqtt: true }), edge('!b', '!a', { mqtt: true })], pos, roles)
    expect(g).toHaveLength(2)
    const radio = g.find((l) => !l.mqtt)!, mqtt = g.find((l) => l.mqtt)!
    expect(radio.infra).toBe(true)
    expect(radio.ba).toBeUndefined()
    expect(mqtt.infra).toBe(false)
    expect(mqtt.ab?.mqtt && mqtt.ba?.mqtt).toBe(true)
  })
  it('collapses both directions into one line and skips unplaced endpoints', () => {
    const pos = new Map<string, [number, number]>([['!a', [10, 63]], ['!b', [10.1, 63]], ['!c', [10.2, 63]]])
    const g = linkGeometry([edge('!b', '!a', { confidence: 'medium' }), edge('!a', '!b', { confidence: 'low', inferred: true }), edge('!a', '!z'), edge('!b', '!c', { inferred: true, confidence: 'low' })], pos)
    expect(g).toHaveLength(2)
    const ab = g.find((l) => l.a === '!a')!
    expect(ab.ab?.src).toBe('!a')
    expect(ab.ba?.src).toBe('!b')
    expect(ab.confidence).toBe('medium')
    expect(ab.inferred).toBe(false) // one direction has non-inferred evidence
    expect(ab.samples).toBe(6)
    const bc = g.find((l) => l.a === '!b')!
    expect(bc.inferred).toBe(true)
  })
  it('level of detail: selected node, low-zoom cap, viewport culling', () => {
    const mk = (a: string, b: string, x0: number, x1: number) => ({ a, b, path: [[x0, 60], [x1, 60]], infra: false, inferred: false, confidence: 'high', samples: 1, arrows: [] }) as never
    const ls = [mk('!a', '!b', 10, 10.1), mk('!b', '!c', 10.1, 10.2), mk('!c', '!d', 30, 30.1)]
    expect(visibleLinks(ls, { selectedNode: '!b', zoom: 12, bounds: null })).toHaveLength(2)
    expect(visibleLinks(ls, { selectedNode: null, zoom: 12, bounds: [9.9, 59.9, 10.3, 60.1] })).toHaveLength(2)
    const many = Array.from({ length: LOW_ZOOM_LINKS + 5 }, (_, i) => mk(`!${i}`, `!x${i}`, 10, 10.1))
    expect(visibleLinks(many, { selectedNode: null, zoom: 6, bounds: null })).toHaveLength(LOW_ZOOM_LINKS)
  })
})

describe('MQTT direction glyphs (D-054)', () => {
  const node = (is_gateway: boolean, down: boolean) =>
    ({ id: '!1', num: 1, status: 'observed', packets: 0, receptions: 0, gateway_receptions: 0, is_gateway, signatures: { verified: 0, unsigned: 0, unverifiable: 0, not_applicable: 0 }, ...(down ? { mqtt_downlink: { zero_snr: 3, traceroutes: 4 } } : {}) }) as Parameters<typeof mqttUplink>[0]
  it('marks uplink, downlink, both or neither', () => {
    // Inside the marker: how it uplinks; beside it: whether it downlinks (D-084).
    expect(mqttUplink(node(true, false))).toBe('up')
    expect(mqttUplink({ ...node(true, true), multi_uplink: true })).toBe('upAll')
    expect(mqttUplink(node(false, true))).toBeUndefined()
    expect(mqttDownlink(node(false, true))).toBe(true)
    expect(mqttDownlink(node(true, true))).toBe(true)
    expect(mqttDownlink(node(true, false))).toBe(false)
  })
  it('inks dark on the newest (light) fill and light on the oldest (dark) one, at 4:1 or better', () => {
    expect(glyphInk(AGE_STOPS[0])[0]).toBeLessThan(50)
    expect(glyphInk(AGE_STOPS[AGE_STOPS.length - 1])[0]).toBeGreaterThan(200)
    for (let k = 0; k <= 20; k++) {
      const c = ageColor(k / 20)
      expect(contrast(glyphInk(c), c)).toBeGreaterThan(4)
    }
  })
})

describe('age ramp on both basemaps', () => {
  const DARK_BG = [0x0e, 0x11, 0x16] // web/styles/dark.json background
  const LIGHT_BG = [0xf3, 0xf1, 0xec] // web/styles/light.json background
  it('stands out from both backgrounds at every age', () => {
    for (let k = 0; k <= 20; k++) {
      expect(contrast(ageColor(k / 20), DARK_BG)).toBeGreaterThan(3)
      expect(contrast(ageColor(k / 20), LIGHT_BG)).toBeGreaterThan(2)
    }
  })
  it('falls in lightness from newest to oldest', () => {
    for (let k = 1; k < AGE_STOPS.length; k++) expect(relativeLuminance(AGE_STOPS[k])).toBeLessThan(relativeLuminance(AGE_STOPS[k - 1]))
  })
})

describe('packet routes across nodes without a position', () => {
  const seg = (a: string, b: string, why: 'traceroute' | 'relay' = 'traceroute') => ({ a, b, dashed: false, why })
  it('joins placed nodes across unplaced ones, dashed, so the route stays whole', () => {
    // origin(unplaced) -> u1(unplaced) -> L -> u2(unplaced) -> R -> gw: L and R must stay connected.
    const pos = new Map<string, [number, number]>([['L', [5, 60]], ['R', [5.3, 60.3]], ['gw', [5.4, 60.4]]])
    const out = bridgeRoute([seg('o', 'u1'), seg('u1', 'L'), seg('L', 'u2'), seg('u2', 'R'), seg('R', 'gw')], pos)
    expect(out.map((s) => [s.seg.a, s.seg.b, s.dashed]).sort()).toEqual([['L', 'R', true], ['R', 'gw', false]])
  })
  it('draws placed segments unchanged, and a bridge only where no real segment joins the pair', () => {
    const pos = new Map<string, [number, number]>([['a', [0, 0]], ['c', [1, 1]], ['d', [2, 2]]])
    const out = bridgeRoute([seg('a', 'b'), seg('b', 'c'), seg('b', 'd'), seg('a', 'c', 'relay')], pos)
    expect(out.map((s) => `${s.seg.a}>${s.seg.b}${s.dashed ? '~' : ''}`)).toEqual(['a>c', 'a>d~'])
  })
})

describe('online', () => {
  const end = Date.parse('2026-11-02T12:00:00Z')
  it('is heard within 3 hours of the window end', () => {
    expect(isOnline({ last_seen: new Date(end - ONLINE_MS).toISOString() }, end)).toBe(true)
    expect(isOnline({ last_seen: new Date(end - ONLINE_MS - 1000).toISOString() }, end)).toBe(false)
    expect(isOnline({}, end)).toBe(false) // only named by others
  })
})
