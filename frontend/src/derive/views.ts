// Every mesh view, derived in the browser from the decoded observations of
// one window: a port of backend internal/query. Callers pass only rows with
// observed_at in [start, end); filters narrow them further. Output shapes are
// the API's, so the UI does not care where a view was computed.
import type { Edge, MeshNode, ObsRow, SnapshotBody, TrafficBody, NodeBody } from '../api/types'
import { distanceM, iso, nodeId, reduce, relayContext, resolveRelay, tracerouteSamples, type LatLon, type Sample } from './graph'
import { locate, precisionErrorM, Rejection, type Anchor, type GeoParams, type Measurement } from './geo'

export interface ViewFilters {
  channels?: string[]
  brokers?: string[]
  gateways?: number[]
  types?: string[]
}

export interface GeoOptions {
  enabled: boolean
  minPrecisionBits: number
  exclude: Set<number>
  params: GeoParams
}

export const MAX_NODES = 5000
export const MAX_EDGES = 20000
const BROADCAST = 0xffffffff

type Snapshot = Omit<SnapshotBody, 'meta' | '$schema'>
type Traffic = Omit<TrafficBody, 'meta' | '$schema'>
type NodeDetail = Omit<NodeBody, 'meta' | '$schema'>

/** Rows passing the view filters (empty lists mean all). */
export function applyFilters(rows: ObsRow[], f: ViewFilters): ObsRow[] {
  const ch = f.channels?.length ? new Set(f.channels) : null
  const br = f.brokers?.length ? new Set(f.brokers) : null
  const gw = f.gateways?.length ? new Set(f.gateways) : null
  const ty = f.types?.length ? new Set(f.types) : null
  if (!ch && !br && !gw && !ty) return rows
  return rows.filter((r) => (!ch || (r.c != null && ch.has(r.c))) && (!br || br.has(r.b)) && (!gw || (r.g != null && gw.has(r.g))) && (!ty || ty.has(r.y)))
}

/** Latest row per key by (observed_at, id). */
function latestBy(rows: ObsRow[], keep: (r: ObsRow) => boolean, key: (r: ObsRow) => number = (r) => r.s): Map<number, ObsRow> {
  const m = new Map<number, ObsRow>()
  for (const r of rows) {
    if (!keep(r)) continue
    const k = key(r), cur = m.get(k)
    if (!cur || r.t > cur.t || (r.t === cur.t && r.i > cur.i)) m.set(k, r)
  }
  return m
}

/** One row per reception (observation key), the lowest id. */
function firstPerReception(rows: ObsRow[], keep: (r: ObsRow) => boolean): ObsRow[] {
  const m = new Map<string, ObsRow>()
  for (const r of rows) {
    if (!keep(r)) continue
    const cur = m.get(r.o)
    if (!cur || r.i < cur.i) m.set(r.o, r)
  }
  return [...m.values()]
}

const isIdentity = (r: ObsRow) => r.y === 'nodeinfo' && !r.ni?.identity_untrusted
// Position packets and map reports both carry a node's own location.
const isPosition = (r: ObsRow) => (r.y === 'position' || r.y === 'mapreport') && r.po != null
const isDeviceTelemetry = (r: ObsRow) => r.y === 'telemetry' && r.te?.kind === 'device'

function identityOf(r: ObsRow): NonNullable<MeshNode['identity']> {
  const ni = r.ni ?? {}
  return {
    ...(ni.long_name ? { long_name: ni.long_name } : {}), ...(ni.short_name ? { short_name: ni.short_name } : {}),
    ...(ni.hw_model ? { hw_model: ni.hw_model } : {}), ...(ni.role ? { role: ni.role } : {}),
    has_public_key: !!ni.has_public_key, signature: r.sg as never, observed_at: iso(r.t),
  }
}

function positionOf(r: ObsRow): NonNullable<MeshNode['position']> {
  const p = r.po!
  return { lat: p.lat, lon: p.lon, ...(p.alt != null ? { alt: p.alt } : {}), precision_bits: p.precision_bits, precision_known: p.precision_known, signature: r.sg as never, observed_at: iso(r.t), source: r.y as 'position' | 'mapreport' }
}

const newerRow = (a: ObsRow, b: ObsRow) => (b.t > a.t || (b.t === a.t && b.i > a.i) ? b : a)

/**
 * Between a node's latest Position packet and latest map report: when their
 * precision circles overlap they agree and the more precise one wins; when
 * they do not, the node may have moved and the newer one wins. Unknown
 * precision cannot be compared, so the newer one wins too.
 */
export function choosePosition(a: ObsRow, b: ObsRow): ObsRow {
  const newer = newerRow(a, b), older = newer === a ? b : a
  const pa = a.po!, pb = b.po!
  if (!pa.precision_known || !pb.precision_known) return newer
  const d = distanceM(pa, pb)
  if (d > precisionErrorM(pa.precision_bits, pa.lat) + precisionErrorM(pb.precision_bits, pb.lat)) return newer
  return older.po!.precision_bits > newer.po!.precision_bits ? older : newer
}

/** Each node's position row: latest of each packet type, then choosePosition. */
function positionRows(rows: ObsRow[]): Map<number, ObsRow> {
  const pos = latestBy(rows, (r) => r.y === 'position' && r.po != null)
  const rep = latestBy(rows, (r) => r.y === 'mapreport' && r.po != null)
  const out = new Map(pos)
  for (const [n, r] of rep) {
    const p = out.get(n)
    out.set(n, p ? choosePosition(p, r) : r)
  }
  return out
}

function telemetryOf(r: ObsRow): NonNullable<MeshNode['telemetry']> {
  const { kind: _kind, ...rest } = r.te!
  return { ...rest, observed_at: iso(r.t) }
}

interface Origin {
  first: number
  last: number
  packets: Set<string>
  receptions: Set<string>
  sig: Record<string, Set<string>>
  brokers: Set<string>
  optOut: boolean // sent without OK-to-MQTT, uplinked by another gateway
}

const sigCounts = (o: Origin): MeshNode['signatures'] => ({
  verified: o.sig.verified?.size ?? 0, unsigned: o.sig.unsigned?.size ?? 0,
  unverifiable: o.sig.unverifiable?.size ?? 0, not_applicable: o.sig['not-applicable']?.size ?? 0,
})

function origins(rows: ObsRow[]): Map<number, Origin> {
  const m = new Map<number, Origin>()
  for (const r of rows) {
    let o = m.get(r.s)
    if (!o) m.set(r.s, (o = { first: r.t, last: r.t, packets: new Set(), receptions: new Set(), sig: {}, brokers: new Set(), optOut: false }))
    o.first = Math.min(o.first, r.t)
    o.last = Math.max(o.last, r.t)
    o.packets.add(r.l)
    o.receptions.add(r.o)
    ;(o.sig[r.sg] ??= new Set()).add(r.l)
    o.brokers.add(r.b)
    if (r.nk) o.optOut = true
  }
  return m
}

/** Nodes mentioned by NeighborInfo, valid traceroute hops or traceroute destinations. */
function referenced(rows: ObsRow[]): Set<number> {
  const out = new Set<number>()
  const add = (n: number | undefined) => {
    if (n != null && n > 0 && n < BROADCAST) out.add(n)
  }
  for (const r of rows) {
    if (r.y === 'neighborinfo') for (const nb of r.nb?.neighbors ?? []) add(nb.id)
    if (r.y === 'traceroute') {
      if (r.tr?.valid) for (const h of [...(r.tr.route ?? []), ...(r.tr.route_back ?? [])]) if (!h.unknown) add(h.id)
      if (r.d != null && r.d !== 0 && r.d !== BROADCAST) add(r.d)
    }
  }
  return out
}

export interface EdgeResult {
  edges: Edge[]
  truncated: boolean
  relayAmbiguous: number
  relayUnmatched: number
}

/** Evidence-backed links; relay hints resolve only against known nodes and their reported positions. */
export function buildEdges(rows: ObsRow[], known: number[], pos: Map<number, LatLon>): EdgeResult {
  const samples: Sample[] = []
  // A. NeighborInfo: neighbour -> reporter, the first copy of each logical packet.
  const firstNb = new Map<string, ObsRow>()
  for (const r of rows) {
    if (r.y !== 'neighborinfo') continue
    const cur = firstNb.get(r.l)
    if (!cur || r.t < cur.t || (r.t === cur.t && r.i < cur.i)) firstNb.set(r.l, r)
  }
  for (const r of firstNb.values()) for (const nb of r.nb?.neighbors ?? []) samples.push({ src: nb.id, dst: r.s, ev: 'neighbor', t: r.t, snr: nb.snr, key: r.l })
  // B. Traceroute: adjacent segments of every valid copy (deduplicated in reduce).
  for (const r of rows) {
    if (r.y !== 'traceroute' || !r.tr?.valid) continue
    samples.push(...tracerouteSamples({
      from: r.s, to: r.d ?? 0, isReply: r.tr.is_reply, route: r.tr.route ?? [], snrTowards: r.tr.snr_towards ?? [],
      routeBack: r.tr.route_back ?? [], snrBack: r.tr.snr_back ?? [], t: r.t, logical: r.l,
    }))
  }
  // C/D. Gateway receptions: zero-hop RF -> source->gateway; relayed with a hint -> resolved later.
  const rx = firstPerReception(rows, (r) => r.g != null && (!!r.dr || (r.rr === 'relayed' && r.r != null)) && (r.sn != null || r.rs != null))
  rx.sort((a, b) => a.i - b.i)
  const pending: { s: Sample; hint: number; origin: number; gw: number }[] = []
  for (const r of rx) {
    const s: Sample = { src: 0, dst: r.g!, ev: 'direct_rf', t: r.t, snr: r.sn, rssi: r.rs, key: r.o }
    if (r.dr) samples.push({ ...s, src: r.s })
    else pending.push({ s, hint: (r.r ?? 0) & 0xff, origin: r.s, gw: r.g! })
  }
  const rc = relayContext(known, pos, samples)
  let ambiguous = 0, unmatched = 0
  for (const p of pending) {
    const [cand, res] = resolveRelay(p.hint, p.origin, p.gw, rc)
    if (res === 'resolved') samples.push({ ...p.s, src: cand, ev: 'relay_hint' })
    else if (res === 'ambiguous') ambiguous++
    else unmatched++
  }
  let edges = reduce(samples)
  const truncated = edges.length > MAX_EDGES
  if (truncated) edges = edges.slice(0, MAX_EDGES)
  return { edges, truncated, relayAmbiguous: ambiguous, relayUnmatched: unmatched }
}

/** Time-isolated nodes, links and counts. rows: in-window and filtered. */
export function buildSnapshot(rows: ObsRow[], g: GeoOptions): Snapshot {
  const nodes = new Map<number, MeshNode>()
  const get = (n: number) => {
    let x = nodes.get(n)
    if (!x) {
      x = { id: nodeId(n), num: n, status: 'observed', packets: 0, receptions: 0, gateway_receptions: 0, is_gateway: false, signatures: { verified: 0, unsigned: 0, unverifiable: 0, not_applicable: 0 } }
      nodes.set(n, x)
    }
    return x
  }
  for (const [n, o] of origins(rows)) {
    const x = get(n)
    x.first_seen = iso(o.first)
    x.last_seen = iso(o.last)
    x.packets = o.packets.size
    x.receptions = o.receptions.size
    x.signatures = sigCounts(o)
    x.brokers = [...o.brokers].sort()
    if (o.optOut) x.mqtt_opt_out = true
  }
  // Gateway activity (an unauthenticated MQTT claim, but still an in-window observation).
  const gws = new Map<number, { first: number; last: number; rx: Set<string> }>()
  for (const r of rows) {
    if (r.g == null) continue
    let a = gws.get(r.g)
    if (!a) gws.set(r.g, (a = { first: r.t, last: r.t, rx: new Set() }))
    a.first = Math.min(a.first, r.t)
    a.last = Math.max(a.last, r.t)
    a.rx.add(r.o)
  }
  for (const [n, a] of gws) {
    const x = get(n)
    x.is_gateway = true
    x.gateway_receptions = a.rx.size
    if (!x.first_seen || a.first < Date.parse(x.first_seen)) x.first_seen = iso(a.first)
    if (!x.last_seen || a.last > Date.parse(x.last_seen)) x.last_seen = iso(a.last)
  }
  for (const [n, r] of latestBy(rows, isIdentity)) get(n).identity = identityOf(r)
  for (const [n, r] of positionRows(rows)) get(n).position = positionOf(r)
  for (const [n, r] of latestBy(rows, isDeviceTelemetry)) get(n).telemetry = telemetryOf(r)
  for (const n of referenced(rows)) if (!nodes.has(n)) get(n).status = 'referenced'

  const counts = windowCounts(rows)
  const pos = new Map<number, LatLon>()
  for (const [n, x] of nodes) if (x.position) pos.set(n, { lat: x.position.lat, lon: x.position.lon })
  const er = buildEdges(rows, [...nodes.keys()], pos)
  if (g.enabled) estimate(nodes, er.edges, g)

  let list = [...nodes.values()]
  for (const n of list) {
    if (n.status === 'observed') counts.nodes++
    else counts.referenced++
    if (n.position) counts.positioned++
    if (n.estimate) counts.estimated++
  }
  counts.edges = er.edges.length
  list.sort((a, b) => b.packets + b.gateway_receptions - (a.packets + a.gateway_receptions) || a.num - b.num)
  if (list.length > MAX_NODES) {
    list = list.slice(0, MAX_NODES)
    counts.nodes_truncated = true
  }
  return { nodes: list, edges: er.edges, edges_truncated: er.truncated, counts, diagnostics: { relay_ambiguous: er.relayAmbiguous, relay_unmatched: er.relayUnmatched } }
}

function windowCounts(rows: ObsRow[]): Snapshot['counts'] {
  const packets = new Set<string>(), receptions = new Set<string>()
  const byType = new Map<string, Set<string>>()
  let first = Infinity, last = -Infinity
  for (const r of rows) {
    packets.add(r.l)
    receptions.add(r.o)
    let s = byType.get(r.y)
    if (!s) byType.set(r.y, (s = new Set()))
    s.add(r.l)
    first = Math.min(first, r.t)
    last = Math.max(last, r.t)
  }
  return {
    packets: packets.size, receptions: receptions.size, nodes: 0, referenced: 0, positioned: 0, estimated: 0, edges: 0,
    by_type: Object.fromEntries([...byType].map(([k, v]) => [k, v.size])),
    ...(rows.length ? { first_event: iso(first), last_event: iso(last) } : {}),
    nodes_truncated: false,
  }
}

/** Estimates for unpositioned nodes from direct (non-relay) links to precise anchors. */
function estimate(nodes: Map<number, MeshNode>, edges: Edge[], g: GeoOptions) {
  const anchors = new Map<number, Anchor>()
  for (const [n, x] of nodes) {
    const p = x.position
    if (p && p.precision_known && p.precision_bits >= g.minPrecisionBits && !g.exclude.has(n)) anchors.set(n, { node: n, lat: p.lat, lon: p.lon, errM: precisionErrorM(p.precision_bits, p.lat) })
  }
  interface Agg { snrSum: number; snrW: number; rssiSum: number; rssiW: number; samples: number; first: number; last: number }
  const links = new Map<number, Map<number, Agg>>() // target -> anchor
  const add = (target: number, anchor: number, e: Edge) => {
    const direct = e.evidence.neighbor + e.evidence.traceroute + e.evidence.direct_rf
    if (direct === 0) return
    let byAnchor = links.get(target)
    if (!byAnchor) links.set(target, (byAnchor = new Map()))
    const f = Date.parse(e.first_at), l = Date.parse(e.last_at)
    let a = byAnchor.get(anchor)
    if (!a) byAnchor.set(anchor, (a = { snrSum: 0, snrW: 0, rssiSum: 0, rssiW: 0, samples: 0, first: f, last: l }))
    a.samples += direct
    if (e.snr.median != null) {
      a.snrSum += e.snr.median * e.snr.n
      a.snrW += e.snr.n
    }
    if (e.rssi.median != null) {
      a.rssiSum += e.rssi.median * e.rssi.n
      a.rssiW += e.rssi.n
    }
    a.first = Math.min(a.first, f)
    a.last = Math.max(a.last, l)
  }
  for (const e of edges) {
    if (anchors.has(e.src_num)) add(e.dst_num, e.src_num, e)
    if (anchors.has(e.dst_num)) add(e.src_num, e.dst_num, e)
  }
  for (const [n, x] of nodes) {
    if (x.position || g.exclude.has(n)) continue
    const ms: Measurement[] = []
    for (const [anchor, a] of links.get(n) ?? []) {
      ms.push({ anchor, samples: a.samples, first: a.first, last: a.last, ...(a.snrW > 0 ? { snr: a.snrSum / a.snrW } : {}), ...(a.rssiW > 0 ? { rssi: a.rssiSum / a.rssiW } : {}) })
    }
    ms.sort((a, b) => a.anchor - b.anchor)
    if (ms.length === 0) {
      x.estimate_note = `no confirmed direct links to nodes reporting a position with at least ${g.minPrecisionBits}-bit precision`
      continue
    }
    try {
      x.estimate = locate(anchors, ms, g.params, nodeId)
    } catch (err) {
      if (!(err instanceof Rejection)) throw err
      x.estimate_note = err.message
    }
  }
}

// ---- traffic ----

const BUCKET_LADDER = [60_000, 300_000, 900_000, 3_600_000, 21_600_000]
export const MAX_BUCKETS = 600

export function bucketFor(durationMs: number, requestedMs = 0): number {
  for (const b of BUCKET_LADDER) if (b >= requestedMs && Math.floor(durationMs / b) <= MAX_BUCKETS) return b
  return BUCKET_LADDER[BUCKET_LADDER.length - 1]
}

/** Go's time.Duration.String for the ladder values. */
function durationString(ms: number): string {
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h${m}m0s` : `${m}m0s`
}

/**
 * Unique packets (in the bucket of their first in-window reception) counted
 * separately from receptions, so several gateways never inflate packets.
 */
export function buildTraffic(rows: ObsRow[], startMs: number, bucketMs: number): Traffic {
  const firsts = new Map<string, { t: number; type: string }>()
  const recs = new Map<string, number>()
  for (const r of rows) {
    const f = firsts.get(r.l)
    if (!f) firsts.set(r.l, { t: r.t, type: r.y })
    else {
      f.t = Math.min(f.t, r.t)
      if (r.y < f.type) f.type = r.y
    }
    recs.set(r.o, Math.min(recs.get(r.o) ?? Infinity, r.t))
  }
  const bin = (t: number) => startMs + Math.floor((t - startMs) / bucketMs) * bucketMs
  const buckets = new Map<number, { packets: number; receptions: number; by_type: Record<string, number> }>()
  const at = (t: number) => {
    const k = bin(t)
    let b = buckets.get(k)
    if (!b) buckets.set(k, (b = { packets: 0, receptions: 0, by_type: {} }))
    return b
  }
  let packets = 0, receptions = 0
  for (const t of recs.values()) {
    at(t).receptions++
    receptions++
  }
  for (const f of firsts.values()) {
    const b = at(f.t)
    b.packets++
    b.by_type[f.type] = (b.by_type[f.type] ?? 0) + 1
    packets++
  }
  const out = [...buckets].sort((a, b) => a[0] - b[0]).map(([k, b]) => ({ start: iso(k), packets: b.packets, receptions: b.receptions, ...(b.packets ? { by_type: b.by_type } : {}) }))
  return { bucket: durationString(bucketMs), buckets: out, packets, receptions }
}

// ---- node detail ----

const MAX_SAMPLES = 500
const MAX_PACKETS = 100
const MAX_GATEWAYED = 200

/** One node's in-window details, or null when it is neither observed nor referenced. */
export function buildNodeDetail(rows: ObsRow[], num: number): NodeDetail | null {
  const d: NodeDetail = {
    id: nodeId(num), num, status: 'observed', packets: 0, receptions: 0, gateway_receptions: 0, is_gateway: false,
    signatures: { verified: 0, unsigned: 0, unverifiable: 0, not_applicable: 0 },
    positions: [], telemetry_series: [], heard_by: [], heard: [], recent_packets: [], truncated: false,
  }
  let first = Infinity, last = -Infinity
  const own: ObsRow[] = []
  const gwRx = new Set<string>()
  for (const r of rows) {
    if (r.s === num || r.g === num) {
      first = Math.min(first, r.t)
      last = Math.max(last, r.t)
    }
    if (r.s === num) own.push(r)
    if (r.g === num) gwRx.add(r.o)
  }
  const o = origins(own).get(num)
  if (o) {
    d.packets = o.packets.size
    d.receptions = o.receptions.size
    d.signatures = sigCounts(o)
    d.brokers = [...o.brokers].sort()
    if (o.optOut) d.mqtt_opt_out = true
  }
  d.gateway_receptions = gwRx.size
  d.is_gateway = gwRx.size > 0
  const id = latestBy(own, isIdentity).get(num)
  if (id) d.identity = identityOf(id)
  const p = positionRows(own).get(num)
  if (p) d.position = positionOf(p)
  const tm = latestBy(own, isDeviceTelemetry).get(num)
  if (tm) d.telemetry = telemetryOf(tm)

  if (first === Infinity) {
    if (!referenced(rows).has(num)) return null
    d.status = 'referenced'
    return d
  }
  d.first_seen = iso(first)
  d.last_seen = iso(last)

  // One sample per logical packet (its first copy), capped in key order like the server.
  const perPacket = (keep: (r: ObsRow) => boolean) => {
    const m = new Map<string, ObsRow>()
    for (const r of own) {
      if (!keep(r)) continue
      const cur = m.get(r.l)
      if (!cur || r.t < cur.t || (r.t === cur.t && r.i < cur.i)) m.set(r.l, r)
    }
    let list = [...m.values()].sort((a, b) => (a.l < b.l ? -1 : a.l > b.l ? 1 : 0))
    if (list.length > MAX_SAMPLES) {
      list = list.slice(0, MAX_SAMPLES)
      d.truncated = true
    }
    return list.sort((a, b) => a.t - b.t)
  }
  d.positions = perPacket(isPosition).map((r) => ({ at: iso(r.t), lat: r.po!.lat, lon: r.po!.lon, precision_bits: r.po!.precision_bits, precision_known: r.po!.precision_known, signature: r.sg }))
  d.telemetry_series = perPacket(isDeviceTelemetry).map((r) => {
    const t = r.te!
    return { at: iso(r.t), ...(t.battery != null ? { battery: t.battery } : {}), ...(t.voltage != null ? { voltage: t.voltage } : {}), ...(t.ch_util != null ? { ch_util: t.ch_util } : {}), ...(t.air_util != null ? { air_util: t.air_util } : {}) }
  })
  d.heard_by = hearings(rows, (r) => r.s === num && r.g != null && r.g !== r.s, (r) => r.g!)
  d.heard = hearings(rows, (r) => r.g === num && r.s !== r.g, (r) => r.s)

  // Recent unique packets (no bodies, ever).
  const pk = new Map<string, ObsRow[]>()
  for (const r of own) {
    const l = pk.get(r.l)
    if (l) l.push(r)
    else pk.set(r.l, [r])
  }
  const minStr = (v: (string | undefined)[]) => v.filter((x): x is string => x != null && x !== '').sort()[0]
  const minNum = (v: (number | undefined)[]) => {
    const n = v.filter((x): x is number => x != null)
    return n.length ? Math.min(...n) : undefined
  }
  d.recent_packets = [...pk.values()]
    .map((rs) => {
      const to = minNum(rs.map((r) => r.d))
      const pid = minNum(rs.map((r) => r.p))
      return {
        at: Math.min(...rs.map((r) => r.t)), type: minStr(rs.map((r) => r.y)) ?? '', packet_id: pid ?? 0,
        ...(to != null && to !== 0 ? { to: to === BROADCAST ? 'broadcast' : nodeId(to) } : {}),
        ...(minStr(rs.map((r) => r.c)) ? { channel: minStr(rs.map((r) => r.c)) } : {}),
        signature: minStr(rs.map((r) => r.sg)) ?? '', crypto: minStr(rs.map((r) => r.cr)) ?? '',
        receptions: new Set(rs.map((r) => r.o)).size, bytes: Math.min(...rs.map((r) => r.by ?? 0)), // omitted = 0
      }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_PACKETS)
    .map((p) => ({ ...p, at: iso(p.at) }))
  return d
}

/** Receptions grouped by the other side; radio statistics from direct-RF receptions only. */
function hearings(rows: ObsRow[], keep: (r: ObsRow) => boolean, other: (r: ObsRow) => number): NodeDetail['heard_by'] & object {
  const groups = new Map<number, ObsRow[]>()
  for (const r of firstPerReception(rows, keep)) {
    const k = other(r), l = groups.get(k)
    if (l) l.push(r)
    else groups.set(k, [r])
  }
  const out = [...groups].map(([k, rs]) => {
    const direct = rs.filter((r) => r.dr)
    return {
      node: nodeId(k), receptions: rs.length, direct_rf: direct.length, last_at: Math.max(...rs.map((r) => r.t)), num: k,
      snr: rawStats(direct.flatMap((r) => (r.sn != null ? [[r.t, r.sn] as [number, number]] : []))),
      rssi: rawStats(direct.flatMap((r) => (r.rs != null ? [[r.t, r.rs] as [number, number]] : []))),
    }
  })
  out.sort((a, b) => b.receptions - a.receptions || a.num - b.num)
  return out.slice(0, MAX_GATEWAYED).map(({ num: _num, last_at, ...h }) => ({ ...h, last_at: iso(last_at) }))
}

/** Like graph stats but unrounded, as the server reports these SQL aggregates. */
function rawStats(v: [number, number][]) {
  if (v.length === 0) return { n: 0 }
  let last = v[0]
  for (const x of v) if (x[0] > last[0]) last = x
  const vals = v.map((x) => x[1]).sort((a, b) => a - b)
  const h = vals.length >> 1
  const med = vals.length % 2 === 0 ? (vals[h - 1] + vals[h]) / 2 : vals[h]
  return { n: vals.length, median: med, min: vals[0], max: vals[vals.length - 1], last: last[1] }
}
