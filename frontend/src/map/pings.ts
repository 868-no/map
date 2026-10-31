// Radar-ping traffic animation. Each RF transmission attributed to a node
// (by the WebAssembly engine, from live rows) becomes one expanding ring
// centred on the transmitter, growing until it encloses every node known to
// have heard that transmission directly. State lives outside React: the map
// animation loop reads it each frame.
import type { Transmission } from '../derive/protocol'

export type { Transmission }

// ---- animation state ----
//
// A ping grows, lingers, then fades. Receptions keep arriving over several
// seconds (MQTT upload delays), so a ping accepts receivers until it is gone:
// a receiver outside the ring makes it grow again from its current size, and
// any new receiver brings a lingering or fading ring back to full strength.

type LngLat = [number, number]

interface Ping {
  tx: string
  center: LngLat
  born: number
  rebroadcast: boolean
  unicast: boolean // addressed to one node: its links animate too; broadcasts show only the ring
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

// A window that is covered or minimised can stop getting animation frames
// while document.hidden stays false (e.g. on Linux compositors). Pings are
// only wanted while frames arrive, or they pile up unseen.
const FRAME_GAP_MS = 1000
let lastFrame = -Infinity

/** The animation loop calls this on every frame it gets. */
export function frameArrived(now: number): void {
  lastFrame = now
}

/** Whether the page is being painted (a frame arrived recently). */
export function painting(now = performance.now()): boolean {
  return now - lastFrame < FRAME_GAP_MS
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
/**
 * Positions of the nodes currently drawn. Estimates are recomputed on every
 * rebuild and may move or vanish while a ping is on screen, so each frame
 * follows the current markers instead of the positions a ping started with.
 * Empty (tests, before the first snapshot): pings keep their own positions.
 */
let drawn: Map<string, LngLat> = new Map()
export function setPingPositions(pos: Map<string, LngLat>): void {
  drawn = pos
}

/** Grow again from wherever the ring is now. */
function regrow(p: Ping, to: number, now: number) {
  p.from = p.heard ? radiusAt(p, now) : 0
  p.to = to
  p.growStart = now
  p.settled = now + PING_GROW
}

export function addTransmission(t: Transmission, pos: Map<string, LngLat>, now = performance.now()): void {
  const center = pos.get(t.tx)
  if (!center) return
  let p = pings.get(t.key)
  if (!p) {
    const s = seen.get(t.key)
    if (s !== undefined && now - s < SEEN_TTL) return
    if (pings.size >= MAX_PINGS) pings.delete(pings.keys().next().value!) // drop the oldest under heavy traffic
    p = { tx: t.tx, center, born: now, rebroadcast: t.rebroadcast, unicast: t.unicast, heard: false, heardAt: 0, receivers: new Map(), from: 0, to: 0, growStart: now, settled: now + PING_GROW }
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
    regrow(p, dist * OVERSHOOT, now)
    p.heard = true
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
/**
 * The link from a transmitter to one direct receiver, drawn as far as the
 * ring's edge: `tip` is that point, `progress` its fraction of the way
 * (1 once the ring has reached the receiver).
 */
export interface Trail { from: LngLat; to: LngLat; tip: LngLat; progress: number; alpha: number; rebroadcast: boolean }
export interface Flash { pos: LngLat; alpha: number; scale: number; rebroadcast: boolean }

/** Ground metres per screen pixel at a latitude and MapLibre zoom (512 px tiles). */
export function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

/** Current rings and blips (pixels at this zoom) and receiver flashes. */
/**
 * Moves a ping onto the current markers: the transmitter and each receiver
 * where it is drawn now; receivers no longer drawn are dropped, and one that
 * moved beyond the ring makes it grow again. False when the transmitter is gone.
 */
function follow(p: Ping, now: number): boolean {
  const c = drawn.get(p.tx)
  if (!c) return false
  p.center = c
  for (const [id, rx] of p.receivers) {
    const rp = drawn.get(id)
    if (!rp) {
      p.receivers.delete(id)
      continue
    }
    rx.pos = rp
    rx.dist = distanceM(c, rp)
    if (rx.dist * OVERSHOOT > p.to + 1) regrow(p, rx.dist * OVERSHOOT, now)
  }
  return true
}

// Web Mercator y for a latitude: the ring is a circle on screen, so a point
// a given fraction along a link must be interpolated in projected space.
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90

/** The point `f` of the way from a to b on screen (Web Mercator). */
export function along(a: LngLat, b: LngLat, f: number): LngLat {
  return [a[0] + (b[0] - a[0]) * f, latOf(mercY(a[1]) + (mercY(b[1]) - mercY(a[1])) * f)]
}

export function activePings(now: number, zoom: number): { rings: Ring[]; blips: Blip[]; flashes: Flash[]; trails: Trail[] } {
  const rings: Ring[] = [], blips: Blip[] = [], flashes: Flash[] = [], trails: Trail[] = []
  for (const [k, p] of pings) {
    if (p.waitFor) {
      const parent = pings.get(p.waitFor.key)
      const reached = parent?.receivers.get(p.waitFor.rx)?.reachedAt
      // Start when the upstream ring got here; if it is gone or never gets
      // here within the collection time, start then rather than never. Never
      // later: after a pause without frames, waiting relays keep their own
      // timing (and mostly expire) instead of all starting at once.
      if (reached === undefined && parent && now - p.waitFor.since < PING_COLLECT) continue
      const start = Math.min(reached ?? now, now, p.waitFor.since + PING_COLLECT)
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
    if (drawn.size && !follow(p, now)) {
      pings.delete(k) // its transmitter is no longer on the map
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
        // The link grows with the ring: its head is on the ring's edge until the ring reaches the receiver.
        if (p.unicast && rx.dist > 0) {
          const progress = Math.min(px / (rx.dist / mpp), 1)
          trails.push({ from: p.center, to: rx.pos, tip: along(p.center, rx.pos, progress), progress, alpha, rebroadcast: p.rebroadcast })
        }
        const since = rx.reachedAt === undefined ? -1 : now - rx.reachedAt
        if (since >= 0 && since < FLASH) flashes.push({ pos: rx.pos, alpha: Math.round(255 * (1 - since / FLASH)), scale: since / FLASH, rebroadcast: p.rebroadcast })
      }
    } else if (now - p.born < BLIP_LIFE) {
      const t = (now - p.born) / BLIP_LIFE
      blips.push({ center: p.center, scale: ease(t), alpha: Math.round(255 * (1 - t)), rebroadcast: p.rebroadcast })
    }
  }
  for (const [k, s] of seen) if (now - s > SEEN_TTL) seen.delete(k)
  return { rings, blips, flashes, trails }
}

export function clearPings(): void {
  pings.clear()
  seen.clear()
  lastFrame = -Infinity
}

export function pingCount(): number {
  return pings.size
}
