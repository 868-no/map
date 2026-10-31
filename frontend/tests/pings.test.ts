import { beforeEach, describe, expect, it } from 'vitest'
import { activePings as rawPings, addTransmission, BLIP_LIFE, RING_BANDS, ringProfile, clearPings, distanceM, metresPerPixel, MIN_RING_PX, PING_COLLECT, PING_FADE, PING_GROW, PING_LINGER } from '../src/map/pings'

// Attribution (which transmissions a reception proves) lives in the engine
// and is tested there (frontend/engine/src/packets.rs); these are the animation's.
const A = '!000000aa', B = '!000000bb', C = '!000000cc', GW = '!000000dd'

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
  const tx = (rx?: string) => ({ key: `p|${A}`, tx: A, rx, rebroadcast: false, unicast: true })
  it('animates links only for unicast packets; a broadcast shows just the ring', () => {
    addTransmission({ ...tx(B), unicast: false }, pos, 0)
    const { rings, trails } = activePings(PING_GROW / 2)
    expect(rings).toHaveLength(1)
    expect(trails).toHaveLength(0)
  })
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
  it('the link to each receiver grows with the ring edge and arrives with it', () => {
    addTransmission(tx(GW), pos, 0)
    addTransmission(tx(B), pos, 0)
    for (const t of [PING_GROW / 4, PING_GROW / 2]) {
      const { rings, trails } = activePings(t)
      const toB = trails.find((x) => x.to === pos.get(B))!
      // The head sits on the ring's edge: as far from the transmitter as the ring's radius.
      expect(distanceM(toB.from, toB.tip)).toBeCloseTo(rings[0].radiusM, -1)
      expect(toB.progress).toBeLessThan(1)
    }
    // Same frame: once the ring reaches GW, so has its link (and the receiver flashes).
    let t = 0
    while (activePings(t).flashes.length === 0) t += 10
    const { trails } = activePings(t)
    expect(trails.find((x) => x.to === pos.get(GW))!.progress).toBe(1)
    expect(trails.find((x) => x.to === pos.get(B))!.progress).toBeLessThan(1)
    expect(activePings(PING_GROW).trails.every((x) => x.progress === 1)).toBe(true)
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
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true, unicast: true }, pos, 0)
    expect(activePings(1).rings).toHaveLength(0)
  })
})

describe('signal gradient', () => {
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
    addTransmission({ key: `p|${A}`, tx: A, rx: C, rebroadcast: false, unicast: true }, pos, 0)
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true, unicast: true }, pos, 10)
    expect(ring(100, [10.2, 63])).toBeUndefined() // still waiting
    let t = 100
    while (!ring(t, [10.2, 63]) && t < PING_GROW * 2) t += 20
    expect(ring(t, [10.0, 63])!.radiusPx * metresPerPixel(63, Z)).toBeGreaterThanOrEqual(distanceM([10, 63], [10.2, 63]) * 0.98)
    expect(ring(t, [10.2, 63])!.radiusPx).toBeLessThan(MIN_RING_PX) // just starting
  })
  it('without upstream information the relay pings immediately', () => {
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true, unicast: true }, pos, 0)
    expect(ring(100, [10.2, 63])).toBeDefined()
  })
  it('starts at the latest when the upstream ping is gone', () => {
    addTransmission({ key: `p|${A}`, tx: A, rx: C, rebroadcast: false, unicast: true }, pos, 0)
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true, unicast: true }, pos, 0)
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

describe('pings follow the markers drawn now', () => {
  beforeEach(() => clearPings())
  const tx = (rx?: string) => ({ key: `q|${A}`, tx: A, rx, rebroadcast: false, unicast: true })
  it('a receiver whose estimate moves is followed; one no longer drawn is dropped', async () => {
    const { setPingPositions } = await import('../src/map/pings')
    const at = new Map<string, [number, number]>([[A, [10, 63]], [B, [10.2, 63]], [GW, [10.1, 63]]])
    setPingPositions(at)
    addTransmission(tx(GW), at, 0)
    addTransmission(tx(B), at, 0)
    // B's estimate moves farther out: its link goes there and the ring regrows to reach it.
    const moved = new Map(at).set(B, [10.3, 63.05] as [number, number])
    setPingPositions(moved)
    expect(activePings(100).trails.find((t) => t.to === moved.get(B))).toBeDefined()
    expect(activePings(100 + 2 * PING_GROW).trails.find((t) => t.to === moved.get(B))!.progress).toBe(1)
    // GW is no longer drawn (e.g. its estimate vanished): no link to where it was.
    const gone = new Map(moved)
    gone.delete(GW)
    setPingPositions(gone)
    expect(activePings(200 + 2 * PING_GROW).trails.map((t) => t.to)).toEqual([moved.get(B)])
    // The transmitter gone: the ping ends.
    setPingPositions(new Map([[B, moved.get(B)!]]))
    expect(activePings(300 + 2 * PING_GROW).trails).toHaveLength(0)
    setPingPositions(new Map())
  })
})
