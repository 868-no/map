import { nodeId, resolveRelay as resolve, ZERO_COST_ROLES, type RelayContext } from '../derive/graph'

// Radar-ping traffic animation. Each RF transmission we can attribute to a
// node becomes one expanding ring centred on the transmitter, growing until
// it encloses every node known to have heard that transmission directly.
// State lives outside React: the map animation loop reads it each frame.

/** The subset of a live reception event the animation needs. */
export interface Reception {
  node: string // originator
  gw?: string // gateway that uplinked this reception
  lp: string // logical packet key (same for every copy of one packet)
  direct_rf?: boolean // the gateway heard the originator's own transmission
  relay?: number // last byte of the node that transmitted what the gateway heard
  hops?: number // hop_start - hop_limit
  path?: string[] | null // traceroutes: relays after the originator, in order ("" = unrecorded hop)
  snr?: number // measured by the gateway (dB)
  rssi?: number // measured by the gateway (dBm)
}

/** Who transmitted, and (if known) who heard that transmission directly. */
export interface Transmission {
  key: string // packet + transmitter: one ping per RF transmission
  tx: string
  rx?: string
  rebroadcast: boolean
  strength?: number // 0..1 signal measured at rx, when rx is the reporting gateway
}

/** Map measured signal to 0..1: SNR -20..+10 dB, else RSSI -130..-70 dBm. */
export function signalStrength(snr?: number, rssi?: number): number | undefined {
  const clamp = (v: number) => Math.min(Math.max(v, 0), 1)
  if (snr !== undefined && snr !== null) return clamp((snr + 20) / 30)
  if (rssi !== undefined && rssi !== null) return clamp((rssi + 130) / 60)
  return undefined
}

export interface MeshContext {
  relay: RelayContext // the same context the links use (window nodes, reported positions, confirmed pairs, range)
  role: (id: string) => string | undefined // device role from in-window NodeInfo
}

export { ZERO_COST_ROLES }

const num = (id: string) => parseInt(id.slice(1), 16)

/**
 * Resolve a relay byte to one node, or nothing (never a guess): the shared
 * resolver the links use (derive/graph.ts, a port of the backend's).
 */
export function resolveRelay(byte: number, origin: string, gw: string, ctx: MeshContext): string | undefined {
  const [n, res] = resolve(byte, num(origin), num(gw), ctx.relay)
  return res === 'resolved' ? nodeId(n) : undefined
}

/**
 * Turn one gateway reception into the transmissions it proves.
 * - The originator always transmitted the first broadcast.
 * - A gateway hearing the originator directly is a receiver of that broadcast.
 * - Otherwise the gateway heard a rebroadcast by the last-hop relay; when the
 *   relay byte resolves uniquely, that is a transmission by the relay heard
 *   by the gateway.
 * - Hop count 1 with a resolved relay whose role is known and NOT one of
 *   ZERO_COST_ROLES: the first hop always spends a hop, and only those roles
 *   can receive at zero cost, so this relay was the single hop-spending first
 *   hop and heard the originator directly. With a zero-cost-capable or
 *   unknown role nothing is inferred (on mqtt.868.no traceroutes, 41 of 178
 *   count-1 copies had 2-5 relays, every one ending at such a role).
 */
export function transmissions(ev: Reception, ctx: MeshContext): Transmission[] {
  // Signal measurements belong to the gateway's own reception only.
  const strength = signalStrength(ev.snr, ev.rssi)
  return attribute(ev, ctx).map((t) => (t.rx && t.rx === ev.gw && strength !== undefined ? { ...t, strength } : t))
}

function attribute(ev: Reception, ctx: MeshContext): Transmission[] {
  if (ev.path) return traceroutePath(ev, ev.path)
  const origin = (rx?: string): Transmission => ({ key: `${ev.lp}|${ev.node}`, tx: ev.node, rx, rebroadcast: false })
  if (!ev.gw || ev.gw === ev.node) return [origin()]
  if (ev.direct_rf || ev.hops === 0) return [origin(ev.gw)]
  if (ev.relay === undefined || ev.relay === null) return [origin()]
  const relay = resolveRelay(ev.relay, ev.node, ev.gw, ctx)
  if (!relay) return [origin()]
  const role = ctx.role(relay)
  const firstHop = ev.hops === 1 && role !== undefined && !ZERO_COST_ROLES.has(role)
  return [origin(firstHop ? relay : undefined), { key: `${ev.lp}|${relay}`, tx: relay, rx: ev.gw, rebroadcast: true }]
}

/**
 * Traceroutes record every relay in order, and each node that received the
 * copy (including the uplinking gateway) adds itself; adjacent entries heard
 * each other directly. This is exact, so it replaces the hop-count and
 * relay-byte heuristics, which disagree with the route on real traffic.
 */
function traceroutePath(ev: Reception, path: string[]): Transmission[] {
  const chain = [ev.node, ...path]
  if (ev.gw && chain[chain.length - 1] !== ev.gw) chain.push(ev.gw)
  const out: Transmission[] = []
  for (let i = 0; i < chain.length; i++) {
    const tx = chain[i], rx = chain[i + 1]
    if (!tx) continue // an unrecorded hop transmitted, but we cannot place it
    if (i > 0 && i === chain.length - 1) break // the last node only received
    out.push({ key: `${ev.lp}|${tx}`, tx, rx: rx || undefined, rebroadcast: i > 0 })
  }
  return out
}

// ---- animation state ----
//
// A ping grows, lingers, then fades. Receptions keep arriving over several
// seconds (MQTT upload delays), so a ping accepts receivers until it is gone:
// a receiver outside the ring makes it grow again from its current size, and
// any new receiver brings a lingering or fading ring back to full strength.

type LngLat = [number, number]

interface Ping {
  center: LngLat
  born: number
  rebroadcast: boolean
  heard: boolean // has at least one placeable direct receiver
  heardAt: number
  receivers: Map<string, { pos: LngLat; dist: number; strength?: number; reachedAt?: number }>
  from: number // metres at the start of the current growth
  to: number // metres the current growth ends at (farthest receiver, with margin)
  growStart: number
  settled: number // when the ring last stopped growing or gained a receiver
  // A rebroadcast whose upstream transmission is on the map waits, unseen,
  // until that ring reaches this transmitter.
  waitFor?: { key: string; rx: string; since: number }
}

const packetOf = (key: string) => key.slice(0, key.lastIndexOf('|'))

export const PING_GROW = 3000 // ms per growth
export const PING_LINGER = 5000 // ms at full size after growth stops
export const PING_FADE = 2500 // ms fade-out
// A transmission with no placeable direct receiver is only a brief pulse, but
// stays open this long so a receiver arriving later still grows a ring.
export const BLIP_LIFE = 1500 // ms
export const PING_COLLECT = PING_GROW + PING_LINGER + PING_FADE
const OVERSHOOT = 1.08 // the farthest receiver sits just inside the ring
// Rings never stay smaller than this on screen, so receivers close to (or at
// the same reported position as) the transmitter are still visibly enclosed.
export const MIN_RING_PX = 22

/**
 * Pings show traffic as it happens. A hidden or frozen tab receives (or
 * replays) stream events late and in bursts; packets older than this when
 * handled, or handled while the page is hidden, get no ping.
 */
export const PING_MAX_AGE_MS = 10_000

export function pingWanted(observedMs: number, serverNowMs: number, hidden: boolean): boolean {
  return !hidden && serverNowMs - observedMs <= PING_MAX_AGE_MS
}
const FLASH = 900 // ms
const MAX_PINGS = 80
const SEEN_TTL = 20_000 // after a ping ends, late copies of that transmission never ping again
const pings = new Map<string, Ping>()
const seen = new Map<string, number>()

/** Great-circle distance in metres. */
export function distanceM(a: LngLat, b: LngLat): number {
  const r = Math.PI / 180
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

const ease = (t: number) => 1 - (1 - t) * (1 - t)
const growth = (p: Ping, now: number) => Math.min(Math.max((now - p.growStart) / PING_GROW, 0), 1)
const radiusAt = (p: Ping, now: number) => p.from + (p.to - p.from) * ease(growth(p, now))
const endOf = (p: Ping) => (p.heard ? p.settled + PING_LINGER + PING_FADE : p.born + PING_COLLECT)

/** Add a transmission; a ping still on the map takes the new receiver. */
export function addTransmission(t: Transmission, pos: Map<string, LngLat>, now = performance.now()): void {
  const center = pos.get(t.tx)
  if (!center) return
  let p = pings.get(t.key)
  if (!p) {
    const s = seen.get(t.key)
    if (s !== undefined && now - s < SEEN_TTL) return
    if (pings.size >= MAX_PINGS) pings.delete(pings.keys().next().value!) // drop the oldest under heavy traffic
    p = { center, born: now, rebroadcast: t.rebroadcast, heard: false, heardAt: 0, receivers: new Map(), from: 0, to: 0, growStart: now, settled: now + PING_GROW }
    // Who did this transmitter hear the packet from? If that ping is on the
    // map, start only when its ring arrives here.
    const lp = packetOf(t.key)
    for (const [k, q] of pings) {
      if (packetOf(k) === lp && q.receivers.has(t.tx)) {
        p.waitFor = { key: k, rx: t.tx, since: now }
        break
      }
    }
    pings.set(t.key, p)
  }
  const rp = t.rx ? pos.get(t.rx) : undefined
  if (!t.rx || !rp) return
  const known = p.receivers.get(t.rx)
  if (known) {
    // Another report from the same receiver can only add a missing measurement.
    if (known.strength === undefined && t.strength !== undefined) known.strength = t.strength
    return
  }
  const dist = distanceM(center, rp)
  p.receivers.set(t.rx, { pos: rp, dist, strength: t.strength })
  if (!p.heard || dist * OVERSHOOT > p.to) {
    // Grow again from wherever the ring is now (from nothing for a blip).
    if (!p.heard) p.heardAt = now
    p.from = p.heard ? radiusAt(p, now) : 0
    p.heard = true
    p.to = dist * OVERSHOOT
    p.growStart = now
    p.settled = now + PING_GROW
  } else {
    p.settled = Math.max(p.settled, now) // already inside: keep the ring up while it flashes
  }
}

export interface Ring { center: LngLat; radiusPx: number; alpha: number; rebroadcast: boolean; profile: number[] }

/** Bands in each ring's radial fill gradient. */
export const RING_BANDS = 16
const UNKNOWN_STRENGTH = 0.5

/**
 * Radial opacity profile (centre to edge, RING_BANDS values in 0..1): full at
 * the transmitter, the measured signal strength at each receiver's distance,
 * transparent at the edge, never increasing outward.
 */
export function ringProfile(radiusPx: number, receivers: { px: number; strength?: number }[]): number[] {
  const pts: [number, number][] = [[0, 1], ...receivers.filter((r) => r.px < radiusPx).map((r) => [r.px, r.strength ?? UNKNOWN_STRENGTH] as [number, number]), [radiusPx, 0]]
  pts.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  let floor = 1
  for (let i = 0; i < RING_BANDS; i++) {
    const r = ((i + 0.5) / RING_BANDS) * radiusPx
    let k = 0
    while (k < pts.length - 2 && pts[k + 1][0] < r) k++
    const [r0, a0] = pts[k], [r1, a1] = pts[k + 1]
    const v = r1 > r0 ? a0 + ((a1 - a0) * (r - r0)) / (r1 - r0) : a1
    floor = Math.min(floor, v)
    out.push(floor)
  }
  return out
}
export interface Blip { center: LngLat; scale: number; alpha: number; rebroadcast: boolean }
export interface Flash { pos: LngLat; alpha: number; scale: number; rebroadcast: boolean }

/** Ground metres per screen pixel at a latitude and MapLibre zoom (512 px tiles). */
export function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

/** Current rings and blips (pixels at this zoom) and receiver flashes. */
export function activePings(now: number, zoom: number): { rings: Ring[]; blips: Blip[]; flashes: Flash[] } {
  const rings: Ring[] = [], blips: Blip[] = [], flashes: Flash[] = []
  for (const [k, p] of pings) {
    if (p.waitFor) {
      const parent = pings.get(p.waitFor.key)
      const reached = parent?.receivers.get(p.waitFor.rx)?.reachedAt
      // Start when the upstream ring got here; if it is gone or never gets
      // here within the collection time, start now rather than never.
      if (reached === undefined && parent && now - p.waitFor.since < PING_COLLECT) continue
      const start = Math.min(reached ?? now, now)
      p.born = p.growStart = start
      p.from = 0
      if (p.heard) p.heardAt = start
      p.settled = start + PING_GROW
      p.waitFor = undefined
    }
    const end = endOf(p)
    if (now >= end) {
      pings.delete(k)
      seen.set(k, now)
      continue
    }
    if (p.heard) {
      const fadeStart = end - PING_FADE
      const alpha = Math.round(255 * (now < fadeStart ? 1 : 1 - (now - fadeStart) / PING_FADE))
      const mpp = metresPerPixel(p.center[1], zoom)
      const floor = MIN_RING_PX * ease(Math.min((now - p.heardAt) / PING_GROW, 1))
      const px = Math.max(radiusAt(p, now) / mpp, floor)
      const profile = ringProfile(px, [...p.receivers.values()].map((r) => ({ px: r.dist / mpp, strength: r.strength })))
      rings.push({ center: p.center, radiusPx: px, alpha, rebroadcast: p.rebroadcast, profile })
      for (const rx of p.receivers.values()) {
        if (rx.reachedAt === undefined && px >= rx.dist / mpp) rx.reachedAt = now
        const since = rx.reachedAt === undefined ? -1 : now - rx.reachedAt
        if (since >= 0 && since < FLASH) flashes.push({ pos: rx.pos, alpha: Math.round(255 * (1 - since / FLASH)), scale: since / FLASH, rebroadcast: p.rebroadcast })
      }
    } else if (now - p.born < BLIP_LIFE) {
      const t = (now - p.born) / BLIP_LIFE
      blips.push({ center: p.center, scale: ease(t), alpha: Math.round(255 * (1 - t)), rebroadcast: p.rebroadcast })
    }
  }
  for (const [k, s] of seen) if (now - s > SEEN_TTL) seen.delete(k)
  return { rings, blips, flashes }
}

export function clearPings(): void {
  pings.clear()
  seen.clear()
}

export function pingCount(): number {
  return pings.size
}
