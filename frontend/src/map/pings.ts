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
  heard: boolean // has at least one placeable direct receiver
  heardAt: number
  receivers: Map<string, { pos: LngLat; dist: number; strength?: number; reachedAt?: number }>
  from: number // metres at the start of the current growth
  to: number // metres the current growth ends at (farthest receiver, with margin)
  growStart: number
  settled: number // when the ring last stopped growing or gained a receiver
  packet?: string // "origin:id", when known
  // A rebroadcast whose upstream transmission is on the map waits, unseen,
  // until that ring reaches this transmitter; so does a traceroute reply
  // leaving the target until its request's ring gets there.
  waitFor?: { key: string; rx: string; since: number }
  // Not a radio transmission: the way to its one receiver, whose hops are
  // not known (D-173). It travels as a line, dashed (dotted over the
  // internet), at the pace of a ring, and draws no ring.
  gap?: 'gap' | 'unknown_relay' | 'internet'
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
// only wanted while frames arrive, or they pile up unseen. While no ping is
// on the map the loop probes for a frame about once a second.
const FRAME_GAP_MS = 2500
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

const added = new Set<() => void>()
/** Called whenever a ping is added (the animation loop starts on it). Returns an unsubscribe. */
export function onPingAdded(fn: () => void): () => void {
  added.add(fn)
  return () => added.delete(fn)
}

// ---- deliveries (D-096, D-172) ----
//
// An ACK proves its sender received the packet it answers. It is drawn as a
// line travelling the packet's way from the original sender to that node, as
// the packet's routing graph shows it, then the ACK's way back to the sender,
// as the ACK's graph shows it: solid where a hop is known, dashed where it is
// not (the whole way, when where a node heard the packet from is not known).
// Each end flashes as a line reaches it. A packet already animated, live or
// replayed, travels no second time: only the ACK's way back is drawn. Unlike
// a radio ping it draws no ring.

/** How a delivery's hop is drawn, as in a packet's routing graph. */
export type DeliveryStyle = 'solid' | 'dashed' | 'delivered' | 'internet'
type Hop = { a: string; b: string; dashed: boolean; why: string }
// nodes and hops: the whole way; pos and styles: its placed nodes, as last drawn.
interface Way { nodes: string[]; hops: DeliveryStyle[]; pos: LngLat[]; styles: DeliveryStyle[] }
// waitFor: the packet answered, animated already, whose pings the ACK waits for (since: when it began waiting).
interface Delivery { there?: Way; back?: Way; born: number; waitFor?: { packet: string; since: number } }
export const DELIVERY_TRAVEL = 2000 // ms, for one hop
const DELIVERY_TRAVEL_MAX = 5000 // ms, however many hops
const DELIVERY_LINGER = 3000 // ms
const DELIVERY_FADE = 1500 // ms
const deliveries = new Map<string, Delivery>()

/** Travel time of a delivery over `hops` hops: longer ways take a little longer. */
export const deliveryTravel = (hops: number) => Math.min(DELIVERY_TRAVEL * (1 + 0.4 * Math.max(hops - 1, 0)), DELIVERY_TRAVEL_MAX)
const travelOf = (w?: Way) => (w ? deliveryTravel(w.pos.length - 1) : 0)

/** One hop of a delivery line: `tip` is how far it has travelled. */
export interface DeliveryLine { from: LngLat; to: LngLat; tip: LngLat; progress: number; alpha: number; style: DeliveryStyle; leg: 'there' | 'back' }

function styleOf(seg: { dashed: boolean; why: string }): DeliveryStyle {
  return seg.why === 'internet' ? 'internet' : !seg.dashed ? 'solid' : seg.why === 'delivered' ? 'delivered' : 'dashed'
}

/**
 * The placed nodes of a way and the style of each hop between them. An
 * unplaced node is bridged, dashed, as routes are; undefined when either
 * end is not placed.
 */
function placeWay(nodes: string[], hops: DeliveryStyle[], pos: Map<string, LngLat>): { pos: LngLat[]; styles: DeliveryStyle[] } | undefined {
  if (!pos.get(nodes[0]) || !pos.get(nodes[nodes.length - 1])) return undefined
  const out: LngLat[] = [], styles: DeliveryStyle[] = []
  let skipped = false
  nodes.forEach((n, k) => {
    const p = pos.get(n)
    if (!p) {
      if (k > 0) skipped = true
      return
    }
    if (k === 0) out.push(p)
    else {
      out.push(p)
      const own = hops[k - 1]
      styles.push(skipped && own === 'solid' ? 'dashed' : own)
      skipped = false
    }
  })
  return { pos: out, styles }
}

function wayOf(path: Hop[] | undefined, pos: Map<string, LngLat>): Way | undefined {
  if (!path?.length) return undefined
  const nodes = [path[0].a, ...path.map((x) => x.b)], hops = path.map(styleOf)
  const placed = placeWay(nodes, hops, pos)
  return placed && { nodes, hops, ...placed }
}

function addDelivery(t: Transmission, pos: Map<string, LngLat>, now: number): void {
  if (!t.rx) return
  const back = wayOf(t.back, pos)
  const cur = deliveries.get(t.key)
  if (cur) {
    // Another copy of the ACK: its graph has grown, so take the way back
    // it now shows, unless that way has started.
    if (back && now - cur.born < travelOf(cur.there)) cur.back = back
    return
  }
  const s = seen.get(t.key)
  if (s !== undefined && now - s < SEEN_TTL) return
  // The packet answered travels only if it has not been animated already.
  const prior = t.packet ? animated.get(t.packet) : undefined
  const shown = prior !== undefined && now - prior.at < REPLAY_DEDUPE_MS
  // Without a way from the engine: one hop straight to the node.
  const there = shown ? undefined : wayOf(t.path?.length ? t.path : [{ a: t.tx, b: t.rx, dashed: false, why: 'delivered' }], pos)
  if (!there && !back) return
  if (there && t.packet) animated.set(t.packet, { at: now, replay: true })
  if (deliveries.size >= MAX_PINGS) deliveries.delete(deliveries.keys().next().value!)
  // A packet animated already may still be on its way: the ACK leaves once its pings have arrived.
  deliveries.set(t.key, { there, back, born: now, waitFor: shown && t.packet ? { packet: t.packet, since: now } : undefined })
  added.forEach((fn) => fn())
}

/** Moves a way onto the current markers; false when either end is no longer drawn. */
function followWay(w: Way | undefined): boolean {
  if (!w || !drawn.size) return true
  const placed = placeWay(w.nodes, w.hops, drawn)
  if (!placed) return false
  w.pos = placed.pos
  w.styles = placed.styles
  return true
}

/** A way's hops `elapsed` ms into its travel (none before it starts). */
function wayLines(w: Way, elapsed: number, alpha: number, leg: DeliveryLine['leg'], out: DeliveryLine[]): void {
  if (elapsed < 0) return
  const travel = travelOf(w), hops = w.pos.length - 1
  // The head moves along the whole way at one pace: each hop takes its share of the travel by length.
  const lengths = w.pos.slice(1).map((p, i) => Math.max(distanceM(w.pos[i], p), 1))
  const total = lengths.reduce((a, b) => a + b, 0)
  let left = ease(Math.min(elapsed / travel, 1)) * total
  for (let i = 0; i < hops; i++) {
    const progress = i === hops - 1 && elapsed >= travel ? 1 : Math.min(Math.max(left / lengths[i], 0), 1)
    left -= lengths[i]
    if (progress <= 0 && i > 0) break
    out.push({ from: w.pos[i], to: w.pos[i + 1], tip: along(w.pos[i], w.pos[i + 1], progress), progress, alpha, style: w.styles[i], leg })
  }
}

/** Whether a packet's pings are still on their way: a ring growing, or a rebroadcast waiting for its upstream ring. */
function travelling(packet: string, now: number): boolean {
  for (const p of pings.values()) if (p.packet === packet && (p.waitFor || (p.heard && now < p.growStart + PING_GROW))) return true
  return false
}

function activeDeliveries(now: number): { lines: DeliveryLine[]; arrivals: Flash[] } {
  const lines: DeliveryLine[] = [], arrivals: Flash[] = []
  const flash = (pos: LngLat, since: number) => {
    if (since >= 0 && since < FLASH * 1.5) arrivals.push({ pos, alpha: Math.round(255 * (1 - since / (FLASH * 1.5))), scale: since / (FLASH * 1.5), rebroadcast: false })
  }
  for (const [k, d] of deliveries) {
    if (d.waitFor) {
      // Never later than the collection time, so a ring that keeps growing cannot hold it forever.
      if (travelling(d.waitFor.packet, now) && now - d.waitFor.since < PING_COLLECT) continue
      d.born = now
      d.waitFor = undefined
    }
    const age = now - d.born
    if (!followWay(d.there) || !followWay(d.back)) {
      deliveries.delete(k)
      continue
    }
    const there = travelOf(d.there), back = travelOf(d.back)
    const end = there + back + DELIVERY_LINGER + DELIVERY_FADE
    if (age >= end) {
      deliveries.delete(k)
      seen.set(k, now)
      continue
    }
    const fadeStart = end - DELIVERY_FADE
    const alpha = Math.round(255 * (age < fadeStart ? 1 : 1 - (age - fadeStart) / DELIVERY_FADE))
    if (d.there) {
      wayLines(d.there, age, alpha, 'there', lines)
      flash(d.there.pos[d.there.pos.length - 1], age - there)
    }
    // The ACK leaves once the packet has reached its node.
    if (d.back) {
      wayLines(d.back, age - there, alpha, 'back', lines)
      flash(d.back.pos[d.back.pos.length - 1], age - there - back)
    }
  }
  return { lines, arrivals }
}

// Packets already animated, live or replayed, by "origin:id" (D-106): a
// traceroute reply's replay of its request's route is skipped when the
// request itself was seen travelling, and the other way round.
const animated = new Map<string, { at: number; replay: boolean }>()
export const REPLAY_DEDUPE_MS = 120_000

/** Add a transmission; a ping still on the map takes the new receiver. */
export function addTransmission(t: Transmission, pos: Map<string, LngLat>, now = performance.now()): void {
  if (t.delivered) return addDelivery(t, pos, now)
  if (t.packet) {
    const prior = animated.get(t.packet)
    if (prior && now - prior.at < REPLAY_DEDUPE_MS && prior.replay !== !!t.replay) return // shown the other way already
    if (!prior || now - prior.at >= REPLAY_DEDUPE_MS) animated.set(t.packet, { at: now, replay: !!t.replay })
    if (animated.size > 2000) for (const [k, v] of animated) if (now - v.at >= REPLAY_DEDUPE_MS) animated.delete(k)
  }
  const center = pos.get(t.tx)
  if (!center) return
  let p = pings.get(t.key)
  if (!p) {
    const s = seen.get(t.key)
    if (s !== undefined && now - s < SEEN_TTL) return
    if (pings.size >= MAX_PINGS) pings.delete(pings.keys().next().value!) // drop the oldest under heavy traffic
    // A gap needs both ends placed to be drawn at all.
    if (t.gap && !(t.rx && pos.get(t.rx))) return
    p = { tx: t.tx, center, born: now, rebroadcast: t.rebroadcast, heard: false, heardAt: 0, receivers: new Map(), from: 0, to: 0, growStart: now, settled: now + PING_GROW, packet: t.packet, gap: t.gap }
    // Who did this transmitter hear the packet from? If that ping is on the
    // map, start only when its ring arrives here. A traceroute reply starts
    // only when its request, live or replayed, has reached the target.
    const lp = packetOf(t.key)
    for (const [k, q] of pings) {
      if ((packetOf(k) === lp || (t.after && q.packet === t.after)) && q.receivers.has(t.tx)) {
        p.waitFor = { key: k, rx: t.tx, since: now }
        if (packetOf(k) === lp) break
      }
    }
    pings.set(t.key, p)
    added.forEach((fn) => fn())
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
/** A stretch of a packet's way whose hops are not known (D-173), drawn as far as it has travelled. */
export interface GapLine { from: LngLat; to: LngLat; tip: LngLat; progress: number; alpha: number; rebroadcast: boolean; internet: boolean }

/** Ground metres per screen pixel at a latitude and MapLibre zoom (512 px tiles). */
export function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)
}

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
export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
const latOf = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90

/** The point `f` of the way from a to b on screen (Web Mercator). */
export function along(a: LngLat, b: LngLat, f: number): LngLat {
  return [a[0] + (b[0] - a[0]) * f, latOf(mercY(a[1]) + (mercY(b[1]) - mercY(a[1])) * f)]
}

/** Current rings and blips (pixels at this zoom) and receiver flashes. */
export function activePings(now: number, zoom: number): { rings: Ring[]; blips: Blip[]; flashes: Flash[]; trails: Trail[]; gaps: GapLine[]; deliveries: DeliveryLine[]; arrivals: Flash[] } {
  const rings: Ring[] = [], blips: Blip[] = [], flashes: Flash[] = [], trails: Trail[] = [], gaps: GapLine[] = []
  for (const [k, p] of pings) {
    if (p.waitFor) {
      const parent = pings.get(p.waitFor.key)
      // While that ring itself still waits (a replayed route arrives whole),
      // the time limit below counts from when it starts.
      if (parent?.waitFor) {
        p.waitFor.since = now
        continue
      }
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
    if (p.heard && p.gap) {
      // A line, no ring: it reaches its receiver as a ring would.
      const fadeStart = end - PING_FADE
      const alpha = Math.round(255 * (now < fadeStart ? 1 : 1 - (now - fadeStart) / PING_FADE))
      for (const rx of p.receivers.values()) {
        const progress = Math.min(radiusAt(p, now) / Math.max(rx.dist, 1), 1)
        if (rx.reachedAt === undefined && progress >= 1) rx.reachedAt = now
        gaps.push({ from: p.center, to: rx.pos, tip: along(p.center, rx.pos, progress), progress, alpha, rebroadcast: p.rebroadcast, internet: p.gap === 'internet' })
        const since = rx.reachedAt === undefined ? -1 : now - rx.reachedAt
        if (since >= 0 && since < FLASH) flashes.push({ pos: rx.pos, alpha: Math.round(255 * (1 - since / FLASH)), scale: since / FLASH, rebroadcast: p.rebroadcast })
      }
    } else if (p.heard) {
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
        if (rx.dist > 0) {
          const progress = Math.min(px / (rx.dist / mpp), 1)
          trails.push({ from: p.center, to: rx.pos, tip: along(p.center, rx.pos, progress), progress, alpha, rebroadcast: p.rebroadcast })
        }
        const since = rx.reachedAt === undefined ? -1 : now - rx.reachedAt
        if (since >= 0 && since < FLASH) flashes.push({ pos: rx.pos, alpha: Math.round(255 * (1 - since / FLASH)), scale: since / FLASH, rebroadcast: p.rebroadcast })
      }
    } else if (!p.gap && now - p.born < BLIP_LIFE) {
      const t = (now - p.born) / BLIP_LIFE
      blips.push({ center: p.center, scale: ease(t), alpha: Math.round(255 * (1 - t)), rebroadcast: p.rebroadcast })
    }
  }
  const { lines, arrivals } = activeDeliveries(now)
  for (const [k, s] of seen) if (now - s > SEEN_TTL) seen.delete(k)
  return { rings, blips, flashes, trails, gaps, deliveries: lines, arrivals }
}

export function clearPings(): void {
  pings.clear()
  deliveries.clear()
  animated.clear()
  seen.clear()
  lastFrame = -Infinity
}

export function pingCount(): number {
  return pings.size + deliveries.size
}
