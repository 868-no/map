// Link graph from in-window evidence (spec §7): a port of backend
// internal/graph. Pure: callers pass evidence already restricted to the
// window, so nothing here can reach outside it.
import type { Edge } from '../api/types'

export type Evidence = 'neighbor' | 'traceroute' | 'direct_rf' | 'relay_hint'

/** One piece of evidence that src was heard by dst (SNR/RSSI measured at dst). */
export interface Sample {
  src: number
  dst: number
  ev: Evidence
  t: number // ms
  snr?: number
  rssi?: number
  key: string // deduplicates evidence derived from one RF event
}

export type Stats = Edge['snr']

export const nodeId = (n: number): string => '!' + (n >>> 0).toString(16).padStart(8, '0')
export const iso = (ms: number): string => new Date(ms).toISOString()

/** Go's math.Round: halves away from zero. */
export function round2(v: number): number {
  return (Math.sign(v) * Math.round(Math.abs(v) * 100)) / 100
}

interface Acc {
  src: number
  dst: number
  keys: Set<string>
  counts: Edge['evidence']
  snr: [number, number][] // [t, v]
  rssi: [number, number][]
  first: number
  last: number
}

const invalid = (n: number) => n === 0 || n === 0xffffffff

/** Fold samples into directed edges; duplicate samples (same key, direction and evidence) count once. */
export function reduce(samples: Sample[]): Edge[] {
  const m = new Map<string, Acc>()
  for (const s of samples) {
    if (s.src === s.dst || invalid(s.src) || invalid(s.dst)) continue
    const k = `${s.src}>${s.dst}`
    let a = m.get(k)
    if (!a) {
      a = { src: s.src, dst: s.dst, keys: new Set(), counts: { neighbor: 0, traceroute: 0, direct_rf: 0, relay_hint: 0 }, snr: [], rssi: [], first: s.t, last: s.t }
      m.set(k, a)
    }
    const dk = s.ev + '|' + s.key
    if (s.key !== '' && a.keys.has(dk)) continue
    a.keys.add(dk)
    a.counts[s.ev]++
    if (s.snr != null && !Number.isNaN(s.snr)) a.snr.push([s.t, s.snr])
    if (s.rssi != null && !Number.isNaN(s.rssi)) a.rssi.push([s.t, s.rssi])
    if (s.t < a.first) a.first = s.t
    if (s.t > a.last) a.last = s.t
  }
  const out: Edge[] = []
  for (const a of m.values()) {
    const c = a.counts
    const [confidence, inferred, reason] = confidenceOf(c)
    out.push({
      src: nodeId(a.src), dst: nodeId(a.dst), src_num: a.src, dst_num: a.dst, evidence: c,
      samples: c.neighbor + c.traceroute + c.direct_rf + c.relay_hint, confidence, inferred, reason,
      snr: stats(a.snr), rssi: stats(a.rssi), first_at: iso(a.first), last_at: iso(a.last),
    })
  }
  out.sort((x, y) => y.samples - x.samples || x.src_num - y.src_num || x.dst_num - y.dst_num)
  return out
}

function confidenceOf(c: Edge['evidence']): [Edge['confidence'], boolean, string] {
  const types = [c.neighbor, c.traceroute, c.direct_rf, c.relay_hint].filter((n) => n > 0).length
  if (c.neighbor > 0 || c.traceroute > 0) {
    if (types > 1) return ['high', false, 'reported by NeighborInfo/traceroute and corroborated by other evidence']
    if (c.neighbor > 0) return ['high', false, 'reported by NeighborInfo']
    return ['high', false, 'observed traceroute segment']
  }
  if (c.direct_rf > 0) {
    if (c.relay_hint > 0) return ['medium', false, 'direct gateway RF reception, corroborated by relay hints']
    return ['medium', false, 'direct gateway RF reception (zero-hop packet)']
  }
  return ['low', true, 'inferred from unique relay-node byte; not directly confirmed']
}

/** Median (mean of the middle pair when even), min, max and latest value, rounded to 0.01. */
export function stats(v: [number, number][]): Stats {
  if (v.length === 0) return { n: 0 }
  let last = v[0]
  for (const x of v) if (x[0] > last[0]) last = x
  const vals = v.map((x) => x[1]).sort((a, b) => a - b)
  const h = vals.length >> 1
  const med = vals.length % 2 === 0 ? (vals[h - 1] + vals[h]) / 2 : vals[h]
  return { n: vals.length, median: round2(med), min: round2(vals[0]), max: round2(vals[vals.length - 1]), last: round2(last[1]) }
}

export interface Hop {
  id: number
  unknown?: boolean
}

export interface TracerouteRecord {
  from: number
  to: number
  isReply: boolean
  route: Hop[]
  snrTowards: (number | null)[]
  routeBack: Hop[]
  snrBack: (number | null)[]
  t: number
  logical: string
}

/**
 * Adjacent segments actually traversed. snr[k] is measured at the receiver
 * of segment k of [origin, route...]; one extra trailing SNR means the
 * endpoint received it too. For a reply the forward path runs
 * to -> route -> from and the return path from -> route_back -> to.
 * Segments touching an unknown hop produce nothing; no shortcut is invented.
 */
export function tracerouteSamples(r: TracerouteRecord): Sample[] {
  const [fo, fd] = r.isReply ? [r.to, r.from] : [r.from, r.to]
  const out = segments(fo, fd, r.route, r.snrTowards, r.t, r.logical, 'f')
  if (r.isReply) out.push(...segments(r.from, r.to, r.routeBack, r.snrBack, r.t, r.logical, 'b'))
  return out
}

function segments(origin: number, dest: number, route: Hop[], snr: (number | null)[], t: number, logical: string, dir: string): Sample[] {
  const seq: Hop[] = [{ id: origin }, ...route]
  if (snr.length === route.length + 1) seq.push({ id: dest })
  const out: Sample[] = []
  for (let k = 0; k + 1 < seq.length; k++) {
    const a = seq[k], b = seq[k + 1]
    if (a.unknown || b.unknown) continue
    out.push({ src: a.id, dst: b.id, ev: 'traceroute', t, snr: snr[k] ?? undefined, key: `${logical}:${dir}:${k}` })
  }
  return out
}

// ---- relay hints ----

export interface LatLon {
  lat: number
  lon: number
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  const r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/** Relay candidates lie within the longest confirmed link plus margin, never below 50 km. */
export const MIN_RELAY_RANGE_M = 50_000
export const RELAY_RANGE_SLACK = 1.25

export interface RelayContext {
  known: number[]
  pos: Map<number, LatLon> // reported positions only, never estimates
  confirmed: Set<string> // unordered pairs with non-relay evidence
  maxRangeM: number
}

const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`)

export function relayContext(known: number[], pos: Map<number, LatLon>, confirmed: Sample[]): RelayContext {
  const c: RelayContext = { known, pos, confirmed: new Set(), maxRangeM: MIN_RELAY_RANGE_M }
  let longest = 0
  for (const s of confirmed) {
    if (s.ev === 'relay_hint') continue
    c.confirmed.add(pairKey(s.src, s.dst))
    const a = pos.get(s.src), b = pos.get(s.dst)
    if (a && b) longest = Math.max(longest, distanceM(a, b))
  }
  c.maxRangeM = Math.max(MIN_RELAY_RANGE_M, longest * RELAY_RANGE_SLACK)
  return c
}

export type RelayResult = 'unmatched' | 'resolved' | 'ambiguous'

/**
 * Narrow a last-hop byte to one node: window nodes with that low byte other
 * than origin and gateway, minus those positioned beyond radio range of the
 * gateway; if several remain, the single one with confirmed evidence to the
 * gateway wins.
 */
export function resolveRelay(hint: number, origin: number, gw: number, c: RelayContext): [number, RelayResult] {
  // A byte equal to the gateway's own is the gateway itself, not a relay
  // before it: never hand it to another node sharing that byte.
  if (hint === 0 || hint === (gw & 0xff)) return [0, 'unmatched']
  const gp = c.pos.get(gw)
  const cands: number[] = []
  for (const k of c.known) {
    if ((k & 0xff) !== hint || k === origin || k === gw) continue
    const p = c.pos.get(k)
    if (p && gp && distanceM(p, gp) > c.maxRangeM) continue
    cands.push(k)
  }
  if (cands.length === 0) return [0, 'unmatched']
  if (cands.length === 1) return [cands[0], 'resolved']
  const linked = cands.filter((k) => c.confirmed.has(pairKey(k, gw)))
  return linked.length === 1 ? [linked[0], 'resolved'] : [0, 'ambiguous']
}
