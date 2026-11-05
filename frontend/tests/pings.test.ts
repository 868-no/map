import { beforeEach, describe, expect, it } from 'vitest'
import { activePings as rawPings, addTransmission, BLIP_LIFE, RING_BANDS, ringProfile, clearPings, distanceM, metresPerPixel, MIN_RING_PX, PING_COLLECT, PING_FADE, PING_GROW, PING_LINGER, DELIVERY_TRAVEL, deliveryTravel, pingCount } from '../src/map/pings'

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
  const tx = (rx?: string) => ({ key: `p|${A}`, tx: A, rx, rebroadcast: false })
  it('an ACK animates a delivery from the sender to the node that got it, not a ring', () => {
    addTransmission({ key: `77|${A}|delivered`, tx: A, rx: B, rebroadcast: false, delivered: true }, pos, 0)
    expect(pingCount()).toBe(1)
    const mid = activePings(DELIVERY_TRAVEL / 2)
    expect(mid.rings).toHaveLength(0)
    expect(mid.deliveries).toHaveLength(1)
    expect(mid.deliveries[0].progress).toBeGreaterThan(0.5) // eased: fast start
    expect(mid.deliveries[0].progress).toBeLessThan(1)
    expect(mid.arrivals).toHaveLength(0)
    const arrived = activePings(DELIVERY_TRAVEL + 100)
    expect(arrived.deliveries[0].progress).toBe(1)
    expect(arrived.arrivals).toHaveLength(1)
    // The same ACK delivered again (another gateway) does not restart it.
    addTransmission({ key: `77|${A}|delivered`, tx: A, rx: B, rebroadcast: false, delivered: true }, pos, DELIVERY_TRAVEL + 200)
    expect(pingCount()).toBe(1)
    expect(activePings(60_000).deliveries).toHaveLength(0)
  })
  it("an ACK's delivery travels the packet's way hop by hop, dashed where a hop is not known", () => {
    const path = [{ a: A, b: GW, dashed: false, why: 'relay' }, { a: GW, b: B, dashed: true, why: 'gap' }]
    addTransmission({ key: `78|${A}|delivered`, tx: A, rx: B, rebroadcast: false, delivered: true, path }, pos, 0)
    const travel = deliveryTravel(2)
    expect(travel).toBeGreaterThan(DELIVERY_TRAVEL)
    // Early on only the first hop has started.
    const early = activePings(50).deliveries
    expect(early.map((d) => d.style)).toEqual(['solid'])
    expect(early[0].from).toEqual(pos.get(A))
    const done = activePings(travel + 100)
    expect(done.deliveries.map((d) => [d.from, d.to, d.style, d.progress])).toEqual([[pos.get(A), pos.get(GW), 'solid', 1], [pos.get(GW), pos.get(B), 'dashed', 1]])
    expect(done.arrivals).toHaveLength(1)
    expect(done.arrivals[0].pos).toEqual(pos.get(B))
  })
  it('a delivery bridges an unplaced node dashed, and needs both ends placed', () => {
    const path = [{ a: A, b: C, dashed: false, why: 'relay' }, { a: C, b: B, dashed: false, why: 'relay' }]
    addTransmission({ key: `79|${A}|delivered`, tx: A, rx: B, rebroadcast: false, delivered: true, path }, pos, 0)
    expect(activePings(DELIVERY_TRAVEL + 100).deliveries.map((d) => [d.from, d.to, d.style])).toEqual([[pos.get(A), pos.get(B), 'dashed']])
    clearPings()
    addTransmission({ key: `80|${A}|delivered`, tx: A, rx: C, rebroadcast: false, delivered: true, path: [{ a: A, b: C, dashed: true, why: 'delivered' }] }, pos, 0)
    expect(pingCount()).toBe(0)
  })
  const ack = { key: `81|${A}|delivered`, tx: A, rx: B, rebroadcast: false, delivered: true, packet: 'aa:51', path: [{ a: A, b: B, dashed: true, why: 'delivered' }], back: [{ a: B, b: GW, dashed: false, why: 'direct' }, { a: GW, b: A, dashed: true, why: 'delivered' }] }
  it("then the ACK travels its own way back, leaving once the packet has arrived", () => {
    addTransmission(ack, pos, 0)
    const there = deliveryTravel(1), back = deliveryTravel(2)
    expect(activePings(there - 100).deliveries.map((d) => d.leg)).toEqual(['there'])
    const returning = activePings(there + 50)
    expect(returning.deliveries.map((d) => [d.leg, d.style])).toEqual([['there', 'delivered'], ['back', 'solid']])
    expect(returning.arrivals.map((f) => f.pos)).toEqual([pos.get(B)])
    const home = activePings(there + back + 100)
    expect(home.deliveries.map((d) => [d.leg, d.to, d.progress])).toEqual([['there', pos.get(B), 1], ['back', pos.get(GW), 1], ['back', pos.get(A), 1]])
    expect(home.arrivals.map((f) => f.pos)).toEqual([pos.get(A)])
  })
  it('a packet already animated does not travel again: only the ACK goes back', () => {
    addTransmission({ key: `lp|${A}`, tx: A, rx: GW, rebroadcast: false, packet: 'aa:51' }, pos, 0)
    addTransmission(ack, pos, 1000)
    // Its ring is still on its way to GW: the ACK waits for it.
    expect(activePings(1050).deliveries).toHaveLength(0)
    expect(activePings(PING_GROW - 10).deliveries).toHaveLength(0)
    const now = activePings(PING_GROW + 10).deliveries
    expect(now.map((d) => [d.leg, d.from])).toEqual([['back', pos.get(B)]])
    expect(now[0].progress).toBeLessThan(0.1) // it leaves only now
    // And the delivery's own way there counts as animating it: a late live copy pings no more.
    clearPings()
    addTransmission(ack, pos, 0)
    addTransmission({ key: `lp|${A}`, tx: A, rx: GW, rebroadcast: false, packet: 'aa:51' }, pos, 500)
    expect(pingCount()).toBe(1)
  })
  it("a later copy of the ACK updates its way back until that way has started", () => {
    addTransmission({ ...ack, back: [{ a: B, b: A, dashed: true, why: 'delivered' }] }, pos, 0)
    addTransmission(ack, pos, 500)
    expect(activePings(deliveryTravel(1) + 50).deliveries.filter((d) => d.leg === 'back').map((d) => d.to)).toEqual([pos.get(GW)])
    addTransmission({ ...ack, back: [{ a: B, b: A, dashed: true, why: 'delivered' }] }, pos, deliveryTravel(1) + 100)
    expect(activePings(deliveryTravel(1) + 150).deliveries.filter((d) => d.leg === 'back').map((d) => d.to)).toEqual([pos.get(GW)])
  })
  it('a stretch whose hops are not known travels as a line, and the relay beyond it waits for it', () => {
    // A sent it; how it reached B is not known; B relayed it to GW.
    addTransmission({ key: `p|${A}`, tx: A, rebroadcast: false }, pos, 0)
    addTransmission({ key: `p|${A}>${B}`, tx: A, rx: B, rebroadcast: false, gap: 'gap' }, pos, 0)
    addTransmission({ key: `p|${B}`, tx: B, rx: GW, rebroadcast: true }, pos, 0)
    const mid = activePings(PING_GROW / 2)
    expect(mid.rings).toHaveLength(0) // B waits; the gap draws no ring
    expect(mid.gaps).toHaveLength(1)
    expect(mid.gaps[0]).toMatchObject({ from: pos.get(A), to: pos.get(B), internet: false })
    expect(mid.gaps[0].progress).toBeGreaterThan(0)
    expect(mid.gaps[0].progress).toBeLessThan(1)
    const reached = activePings(PING_GROW)
    expect(reached.gaps[0].progress).toBe(1)
    expect(reached.flashes.map((f) => f.pos)).toEqual([pos.get(B)])
    // B's ring starts as the gap arrives.
    const relayed = activePings(PING_GROW + PING_GROW / 2)
    expect(relayed.rings.map((r) => r.center)).toEqual([pos.get(B)])
  })
  it('a gap over the internet is marked so, and one with an end not placed is not drawn', () => {
    addTransmission({ key: `q|${A}>${GW}`, tx: A, rx: GW, rebroadcast: false, gap: 'internet' }, pos, 0)
    expect(activePings(100).gaps.map((g) => g.internet)).toEqual([true])
    clearPings()
    addTransmission({ key: `q|${A}>${C}`, tx: A, rx: C, rebroadcast: false, gap: 'unknown_relay' }, pos, 0)
    expect(pingCount()).toBe(0)
    expect(activePings(100).blips).toHaveLength(0)
  })
  it('a traceroute reply replays its request only if the request was not animated already', () => {
    const live = { key: `lp|${A}`, tx: A, rx: B, rebroadcast: false, packet: 'aa:4d' }
    const replay = { key: `rqaa:4d|${A}`, tx: A, rx: B, rebroadcast: false, packet: 'aa:4d', replay: true }
    addTransmission(live, pos, 0)
    addTransmission(replay, pos, 1000)
    expect(pingCount()).toBe(1) // the replay was skipped
    clearPings()
    addTransmission(replay, pos, 0)
    expect(pingCount()).toBe(1) // never seen live: replayed
    addTransmission({ ...replay, key: `rqaa:4d|${B}`, tx: B, rx: A, rebroadcast: true }, pos, 100)
    expect(pingCount()).toBe(2) // the replay's next hop still plays
    addTransmission(live, pos, 500)
    expect(pingCount()).toBe(2) // a late live copy does not animate it twice
  })
  it('animates a link to each receiver, broadcast or not', () => {
    addTransmission(tx(B), pos, 0)
    const { rings, trails } = activePings(PING_GROW / 2)
    expect(rings).toHaveLength(1)
    expect(trails).toHaveLength(1)
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
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true }, pos, 0)
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
  it('a traceroute reply leaves the target only after its request\'s way there is drawn, however long', () => {
    // C asked E seven hops away; the reply replays C -> 1 -> ... -> 6 -> E, then goes back E -> 6.
    const hops: [string, [number, number]][] = [[C, [10, 63]], ...[1, 2, 3, 4, 5, 6].map((i): [string, [number, number]] => [`!0000000${i}`, [10 + 0.2 * i, 63]]), ['!0000000e', [11.4, 63]]]
    const where = new Map(hops)
    const n = hops.length - 1, E = hops[n][0], at = (id: string) => where.get(id)!
    for (let k = 0; k < n; k++) {
      addTransmission({ key: `rqcc:4d|${hops[k][0]}`, tx: hops[k][0], rx: hops[k + 1][0], rebroadcast: k > 0, packet: 'cc:4d', replay: true }, where, 0)
    }
    addTransmission({ key: `reply|${E}`, tx: E, rx: hops[n - 1][0], rebroadcast: false, packet: '0e:1f4', after: 'cc:4d' }, where, 0)
    const ringAt = (now: number, id: string) => rawPings(now, Z).rings.find((r) => r.center[0] === at(id)[0])
    // Each hop waits for the one before: the last forward hop starts well past the collection time.
    let t = 0
    while (!ringAt(t, hops[n - 1][0]) && t < 60_000) t += 50
    expect(t).toBeGreaterThan(PING_COLLECT)
    expect(ringAt(t, E)).toBeUndefined() // the reply still waits
    // The reply starts when the request's last ring reaches the target.
    while (!ringAt(t, E) && t < 60_000) t += 50
    const last = ringAt(t, hops[n - 1][0])!
    expect(last.radiusPx * MPP).toBeGreaterThanOrEqual(distanceM(at(hops[n - 1][0]), at(E)) * 0.98)
    expect(ringAt(t, E)!.radiusPx).toBeLessThan(MIN_RING_PX)
  })
  it('a reply whose request was seen live waits for that ring too', () => {
    addTransmission({ key: `lp|${A}`, tx: A, rx: C, rebroadcast: false, packet: 'aa:4d' }, pos, 0)
    addTransmission({ key: `reply|${C}`, tx: C, rx: A, rebroadcast: false, packet: 'cc:1f4', after: 'aa:4d' }, pos, 10)
    expect(ring(100, [10.2, 63])).toBeUndefined()
    let t = 100
    while (!ring(t, [10.2, 63]) && t < PING_GROW * 2) t += 20
    expect(ring(t, [10.0, 63])!.radiusPx * MPP).toBeGreaterThanOrEqual(distanceM([10, 63], [10.2, 63]) * 0.98)
  })
  it('a transmission handed over late starts where it would be by now, not from the beginning', () => {
    // Arrived 8 s ago in a window without frames: ringed and fading, not just starting.
    addTransmission({ key: `p|${A}`, tx: A, rx: C, rebroadcast: false }, pos, 1000 - 8000)
    addTransmission({ key: `q|${A}`, tx: A, rx: C, rebroadcast: false }, pos, 1000)
    const rings = rawPings(1000 + 16, Z).rings
    expect(rings).toHaveLength(2)
    const [late, fresh] = rings
    expect(late.radiusPx).toBeGreaterThan(fresh.radiusPx)
    expect(late.alpha).toBeLessThan(255)
    // And one handed over after its whole life has passed never shows.
    addTransmission({ key: `r|${A}`, tx: A, rx: C, rebroadcast: false }, pos, 1000 - PING_COLLECT - 1000)
    expect(rawPings(1000 + 32, Z).rings).toHaveLength(2)
  })
  it('after a pause without frames, waiting relays do not all start at once', () => {
    addTransmission({ key: `p|${A}`, tx: A, rx: C, rebroadcast: false }, pos, 0)
    addTransmission({ key: `p|${C}`, tx: C, rx: GW, rebroadcast: true }, pos, 0)
    expect(rawPings(3 * PING_COLLECT, Z).rings).toHaveLength(0)
  })
})

describe('painting', () => {
  beforeEach(() => clearPings())
  it('is true only while animation frames arrive', async () => {
    const { frameArrived, painting } = await import('../src/map/pings')
    expect(painting(0)).toBe(false)
    frameArrived(5000)
    expect(painting(5500)).toBe(true)
    expect(painting(8000)).toBe(false)
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
  const tx = (rx?: string) => ({ key: `q|${A}`, tx: A, rx, rebroadcast: false })
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
