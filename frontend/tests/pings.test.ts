import { beforeEach, describe, expect, it } from 'vitest'
import { activePings as rawPings, addTransmission, BLIP_LIFE, RING_BANDS, ringProfile, signalStrength, clearPings, distanceM, metresPerPixel, MIN_RING_PX, PING_COLLECT, PING_FADE, PING_GROW, PING_LINGER, resolveRelay, transmissions, type MeshContext } from '../src/map/pings'

const A = '!000000aa', B = '!000000bb', C = '!000000cc', GW = '!000000dd', C2 = '!111111cc'
const ctx = (nodes: string[], links: [string, string][] = [], roles: Record<string, string> = {}, pos: Record<string, [number, number]> = {}, maxRangeM = 50_000): MeshContext => {
  const s = new Set(links.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]))
  return { nodes, confirmed: (a, b) => s.has(`${a}|${b}`), role: (id) => roles[id], pos: (id) => pos[id], maxRangeM }
}

describe('attributing transmissions', () => {
  it('a direct reception is the originator heard by the gateway', () => {
    expect(transmissions({ node: A, gw: GW, lp: 'p', direct_rf: true }, ctx([A, GW]))).toEqual([{ key: `p|${A}`, tx: A, rx: GW, rebroadcast: false }])
    expect(transmissions({ node: A, gw: GW, lp: 'p', hops: 0 }, ctx([A, GW]))[0].rx).toBe(GW)
  })
  it('a gateway uplinking its own packet is a first broadcast with no known receiver', () => {
    expect(transmissions({ node: GW, gw: GW, lp: 'p' }, ctx([GW]))).toEqual([{ key: `p|${GW}`, tx: GW, rx: undefined, rebroadcast: false }])
  })
  it('a relayed reception is a rebroadcast by the resolved last hop', () => {
    const t = transmissions({ node: A, gw: GW, lp: 'p', relay: 0xcc, hops: 2 }, ctx([A, C, GW]))
    expect(t).toEqual([
      { key: `p|${A}`, tx: A, rx: undefined, rebroadcast: false },
      { key: `p|${C}`, tx: C, rx: GW, rebroadcast: true },
    ])
  })
  it('hop count 1 proves a direct first hop only when the relay cannot relay at zero cost', () => {
    const ev = { node: A, gw: GW, lp: 'p', relay: 0xcc, hops: 1 }
    // CLIENT cannot receive at zero cost, so it spent the only hop: it heard the originator.
    expect(transmissions(ev, ctx([A, C, GW], [], { [C]: 'CLIENT' }))[0].rx).toBe(C)
    // Zero-cost-capable or unknown role: earlier relays may be hidden.
    for (const role of ['ROUTER', 'ROUTER_LATE', 'CLIENT_BASE']) expect(transmissions(ev, ctx([A, C, GW], [], { [C]: role }))[0].rx).toBeUndefined()
    expect(transmissions(ev, ctx([A, C, GW]))[0].rx).toBeUndefined()
    // Higher counts never imply it.
    expect(transmissions({ ...ev, hops: 2 }, ctx([A, C, GW], [], { [C]: 'CLIENT' }))[0].rx).toBeUndefined()
    // The relay's own rebroadcast to the gateway is known either way.
    expect(transmissions(ev, ctx([A, C, GW]))[1]).toEqual({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true })
  })
  it('never guesses an ambiguous relay byte, but link evidence can disambiguate', () => {
    expect(resolveRelay(0xcc, A, GW, ctx([A, C, C2, GW]))).toBeUndefined()
    expect(resolveRelay(0xcc, A, GW, ctx([A, C, C2, GW], [[C2, GW]]))).toBe(C2)
    expect(transmissions({ node: A, gw: GW, lp: 'p', relay: 0xcc, hops: 1 }, ctx([A, C, C2, GW]))).toHaveLength(1)
  })
  it('traceroutes use the recorded route, not the hop count or relay byte', () => {
    // Real reply copy: hops = 1 and relay byte 0x73, but route_back shows two relays.
    const R1 = '!997b0449', R2 = '!672f1873', G = '!3afab911', O = '!8a84e409'
    const t = transmissions({ node: O, gw: G, lp: 'tr', relay: 0x73, hops: 1, path: [R1, R2, G] }, ctx([O, R1, R2, G]))
    expect(t).toEqual([
      { key: `tr|${O}`, tx: O, rx: R1, rebroadcast: false },
      { key: `tr|${R1}`, tx: R1, rx: R2, rebroadcast: true },
      { key: `tr|${R2}`, tx: R2, rx: G, rebroadcast: true },
    ])
  })
  it('a traceroute gateway that did not append itself still heard the last relay', () => {
    const t = transmissions({ node: A, gw: GW, lp: 'tr', path: [C] }, ctx([A, C, GW]))
    expect(t.map((x) => [x.tx, x.rx])).toEqual([[A, C], [C, GW]])
    expect(transmissions({ node: A, gw: GW, lp: 'tr', path: [] }, ctx([A, GW])).map((x) => [x.tx, x.rx])).toEqual([[A, GW]])
  })
  it('an unrecorded traceroute hop breaks the chain without inventing receivers', () => {
    const t = transmissions({ node: A, gw: GW, lp: 'tr', path: ['', C] }, ctx([A, C, GW]))
    expect(t.map((x) => [x.tx, x.rx])).toEqual([[A, undefined], [C, GW]])
  })
  it('excludes relay candidates beyond radio range of the gateway, but never unpositioned ones', () => {
    const pos: Record<string, [number, number]> = { [GW]: [10.4, 63.43], [C]: [10.5, 63.5], [C2]: [10.75, 59.91] } // C2 in Oslo, ~390 km away
    expect(resolveRelay(0xcc, A, GW, ctx([A, C, C2, GW], [], {}, pos))).toBe(C)
    expect(resolveRelay(0xcc, A, GW, ctx([A, C, C2, GW], [], {}, { [GW]: pos[GW], [C2]: pos[C2] }))).toBe(C) // C unpositioned stays, C2 out of range
    expect(resolveRelay(0xcc, A, GW, ctx([A, C, C2, GW], [], {}, pos, 500_000))).toBeUndefined() // a proven long link widens the bound
  })
  it('the relay byte never resolves to the originator or the gateway', () => {
    expect(resolveRelay(0xaa, A, GW, ctx([A, GW]))).toBeUndefined()
  })
})

const Z = 10
const MPP = metresPerPixel(63, Z)
const activePings = (now: number) => {
  const r = rawPings(now, Z)
  return { ...r, rings: r.rings.map((x) => ({ ...x, radiusM: x.radiusPx * MPP })) }
}

describe('ping animation', () => {
  beforeEach(() => clearPings())
  const pos = new Map<string, [number, number]>([[A, [10, 63]], [B, [10.2, 63]], [GW, [10.1, 63]]])
  const AB = distanceM([10, 63], [10.2, 63]), AG = distanceM([10, 63], [10.1, 63])
  const tx = (rx?: string) => ({ key: `p|${A}`, tx: A, rx, rebroadcast: false })
  it('grows to the farthest direct receiver, lingers, then fades away', () => {
    addTransmission(tx(GW), pos, 0)
    addTransmission(tx(B), pos, 100)
    const grown = activePings(100 + PING_GROW).rings
    expect(grown).toHaveLength(1)
    expect(grown[0].radiusM).toBeGreaterThan(AB)
    const lingering = activePings(100 + PING_GROW + PING_LINGER - 1).rings[0]
    expect(lingering.alpha).toBe(255)
    expect(lingering.radiusM).toBeCloseTo(grown[0].radiusM)
    expect(activePings(100 + PING_GROW + PING_LINGER + PING_FADE / 2).rings[0].alpha).toBeLessThan(255)
    expect(activePings(100 + PING_GROW + PING_LINGER + PING_FADE).rings).toHaveLength(0)
  })
  it('grows again from its current size when a farther receiver arrives after it stopped', () => {
    addTransmission(tx(GW), pos, 0)
    const settled = activePings(PING_GROW + 1000).rings[0].radiusM
    expect(settled).toBeLessThan(AB)
    addTransmission(tx(B), pos, PING_GROW + 1000)
    expect(activePings(PING_GROW + 1000).rings[0].radiusM).toBeCloseTo(settled) // no jump
    const mid = activePings(PING_GROW + 1000 + PING_GROW / 2).rings[0].radiusM
    expect(mid).toBeGreaterThan(settled)
    expect(activePings(2 * PING_GROW + 1000).rings[0].radiusM).toBeGreaterThan(AB)
  })
  it('a new receiver revives a fading ring', () => {
    addTransmission(tx(GW), pos, 0)
    const fading = PING_GROW + PING_LINGER + PING_FADE / 2
    expect(activePings(fading).rings[0].alpha).toBeLessThan(255)
    addTransmission(tx(B), pos, fading)
    expect(activePings(fading + 10).rings[0].alpha).toBe(255)
  })
  it('receivers flash as the wavefront reaches them, nearer ones first', () => {
    addTransmission(tx(GW), pos, 0)
    addTransmission(tx(B), pos, 0)
    expect(activePings(1).flashes).toHaveLength(0)
    let t = 0
    while (activePings(t).flashes.length === 0) t += 20 // first flash: the nearer gateway
    expect(activePings(t).rings[0].radiusM).toBeGreaterThanOrEqual(AG)
    expect(activePings(t).rings[0].radiusM).toBeLessThan(AB)
  })
  it('a transmission with no known receiver is a brief blip that can still become a ring later', () => {
    addTransmission(tx(), pos, 0)
    expect(activePings(10).blips).toHaveLength(1)
    expect(activePings(BLIP_LIFE + 1).blips).toHaveLength(0) // gone from the map quickly…
    addTransmission(tx(GW), pos, BLIP_LIFE + 4000) // …but a late receiver still grows a ring from nothing
    expect(activePings(BLIP_LIFE + 4001).rings[0].radiusM).toBeLessThan(AG / 10)
    expect(activePings(BLIP_LIFE + 4000 + PING_GROW).rings[0].radiusM).toBeGreaterThan(AG)
  })
  it('a receiver-less transmission stops collecting after the collection window', () => {
    addTransmission(tx(), pos, 0)
    activePings(PING_COLLECT + 1)
    addTransmission(tx(GW), pos, PING_COLLECT + 2)
    expect(activePings(PING_COLLECT + 3).rings).toHaveLength(0)
  })
  it('later copies of a finished transmission do not ping again', () => {
    addTransmission(tx(GW), pos, 0)
    const end = PING_GROW + PING_LINGER + PING_FADE
    activePings(end + 1)
    addTransmission(tx(B), pos, end + 2)
    expect(activePings(end + 3).rings).toHaveLength(0)
    addTransmission(tx(), pos, end + 4)
    addTransmission(tx(GW), pos, end + 2)
    expect(activePings(end + 3).rings).toHaveLength(0)
  })
  it('a receiver at the same position still gets a visible ring', () => {
    const co = new Map<string, [number, number]>([[A, [10, 63]], [GW, [10, 63]]])
    addTransmission(tx(GW), co, 0)
    expect(rawPings(1, Z).flashes).toHaveLength(1) // at distance 0 the receiver lights up immediately
    const r = rawPings(PING_GROW, Z).rings
    expect(r).toHaveLength(1)
    expect(r[0].radiusPx).toBeCloseTo(MIN_RING_PX)
  })
  it('ring size follows the map zoom', () => {
    addTransmission(tx(B), pos, 0)
    const near = rawPings(PING_GROW, 12).rings[0].radiusPx, far = rawPings(PING_GROW, 9).rings[0].radiusPx
    expect(near).toBeGreaterThan(far)
  })
  it('skips transmitters without a position', () => {
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true }, pos, 0)
    expect(activePings(1).rings).toHaveLength(0)
  })
})

describe('signal gradient', () => {
  it('maps SNR, else RSSI, to 0..1', () => {
    expect(signalStrength(-20)).toBe(0)
    expect(signalStrength(10)).toBe(1)
    expect(signalStrength(undefined, -100)).toBeCloseTo(0.5)
    expect(signalStrength()).toBeUndefined()
  })
  it('attaches the measurement only to the reporting gateway', () => {
    const t = transmissions({ node: A, gw: GW, lp: 'p', relay: 0xcc, hops: 2, snr: 5 }, ctx([A, C, GW]))
    expect(t.find((x) => x.rx === GW)?.strength).toBeCloseTo(25 / 30)
    expect(t.find((x) => x.tx === A)?.strength).toBeUndefined()
  })
  it('is opaque at the transmitter, follows receivers, fades out, and never rises outward', () => {
    const p = ringProfile(120, [{ px: 40, strength: 0.3 }, { px: 80, strength: 0.9 }])
    expect(p).toHaveLength(RING_BANDS)
    expect(p[0]).toBeGreaterThan(0.8)
    expect(p[RING_BANDS - 1]).toBeLessThan(0.15)
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeLessThanOrEqual(p[i - 1])
    const strong = ringProfile(120, [{ px: 80, strength: 0.9 }]), weak = ringProfile(120, [{ px: 80, strength: 0.1 }])
    expect(strong[6]).toBeGreaterThan(weak[6])
  })
})

describe('rebroadcast ordering', () => {
  beforeEach(() => clearPings())
  const pos = new Map<string, [number, number]>([[A, [10, 63]], [C, [10.2, 63]], [GW, [10.3, 63]]])
  const ring = (now: number, center: [number, number]) => rawPings(now, Z).rings.find((r) => r.center[0] === center[0])
  it('a relay does not ping before the originator\'s ring reaches it', () => {
    addTransmission({ key: `p|${A}`, tx: A, rx: C, rebroadcast: false }, pos, 0)
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true }, pos, 10)
    expect(ring(100, [10.2, 63])).toBeUndefined() // still waiting
    let t = 100
    while (!ring(t, [10.2, 63]) && t < PING_GROW * 2) t += 20
    expect(ring(t, [10.0, 63])!.radiusPx * metresPerPixel(63, Z)).toBeGreaterThanOrEqual(distanceM([10, 63], [10.2, 63]) * 0.98)
    expect(ring(t, [10.2, 63])!.radiusPx).toBeLessThan(MIN_RING_PX) // just starting
  })
  it('without upstream information the relay pings immediately', () => {
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true }, pos, 0)
    expect(ring(100, [10.2, 63])).toBeDefined()
  })
  it('starts at the latest when the upstream ping is gone', () => {
    addTransmission({ key: `p|${A}`, tx: A, rx: C, rebroadcast: false }, pos, 0)
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true }, pos, 0)
    const end = PING_GROW + PING_LINGER + PING_FADE
    expect(ring(end + 10, [10.2, 63])).toBeDefined()
  })
})

describe('pingWanted', () => {
  it('skips stale packets and hidden pages', async () => {
    const { pingWanted, PING_MAX_AGE_MS } = await import('../src/map/pings')
    const now = 1_800_000_000_000
    expect(pingWanted(now - 800, now, false)).toBe(true)
    expect(pingWanted(now - PING_MAX_AGE_MS - 1, now, false)).toBe(false) // replayed after the tab woke up
    expect(pingWanted(now - 800, now, true)).toBe(false) // nobody is watching
  })
})

describe('relay byte equal to the gateway', () => {
  it('is the gateway itself, never another node with that byte', async () => {
    const { resolveRelay } = await import('../src/map/pings')
    const ctx = { nodes: ['!aaaa0011', '!bbbb0011', '!cccc0022'], confirmed: () => false, role: () => undefined, pos: () => undefined, maxRangeM: 50_000 }
    expect(resolveRelay(0x11, '!cccc0022', '!aaaa0011', ctx)).toBeUndefined()
    expect(resolveRelay(0x11, '!cccc0022', '!dddd0033', ctx)).toBeUndefined() // still ambiguous between the two
    expect(resolveRelay(0x22, '!aaaa0011', '!dddd0033', { ...ctx, nodes: ['!aaaa0011', '!cccc0022'] })).toBe('!cccc0022')
  })
})
