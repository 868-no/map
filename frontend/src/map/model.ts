// Pure view-model helpers for map layers (unit-tested; no WebGL here).
import type { Edge, MeshNode, RouteSegment } from '../derive/views'
import type { Filters, Toggles } from '../state/store'

export type NodeKind = 'reported' | 'estimated' | 'unpositioned'

export interface PlacedNode {
  node: MeshNode
  kind: NodeKind
  lon: number
  lat: number
  age: number // 0 = heard at the window end, 1 = heard only at its start
  radiusM?: number // uncertainty for estimates
}

/**
 * The age scale's knee: ages well below it are told apart about linearly,
 * longer ones logarithmically (D-087). With a 3-day window the ramp's stops
 * fall at about 0, 35 min, 3.3 h, 16 h and 72 h, instead of 18 h apart.
 */
export const AGE_TAU_MS = 10 * 60_000

/** A node's display name: long name, else short name, else its id. */
export function nodeName(n: Pick<MeshNode, 'identity'> | undefined, id: string): string {
  return n?.identity?.long_name || n?.identity?.short_name || id
}

/** A node heard within this long before the window's end is online (D-101). */
export const ONLINE_MS = 3 * 3_600_000

/** Heard within ONLINE_MS of the window's end; nodes only named by others never are. */
export function isOnline(n: Pick<MeshNode, 'last_seen'>, endMs: number): boolean {
  return !!n.last_seen && endMs - Date.parse(n.last_seen) <= ONLINE_MS
}

/**
 * How long before the window end the node was last heard (0 = at the end,
 * 1 = only at its start), on a logarithmic scale over the window, so recent
 * activity is told apart. A node only named by others counts from when it
 * was last named.
 */
export function lastHeardAge(n: MeshNode, endMs: number, windowMs: number): number {
  const t = n.last_seen ?? n.last_referenced
  if (!t || windowMs <= 0) return 1
  const dt = Math.min(Math.max(endMs - Date.parse(t), 0), windowMs)
  return Math.log1p(dt / AGE_TAU_MS) / Math.log1p(windowMs / AGE_TAU_MS)
}

/** The time before the window end that an age fraction stands for (lastHeardAge's inverse). */
export function ageMs(age: number, windowMs: number): number {
  return AGE_TAU_MS * Math.expm1(age * Math.log1p(windowMs / AGE_TAU_MS))
}

/**
 * Last-heard colour ramp, the same on both basemaps: gold, orange, red,
 * magenta, violet, with lightness falling throughout (so it reads in order
 * without colour vision too). Stops are at age 0, 0.25, 0.5, 0.75 and 1 of
 * the selected window. Every stop sits in a middle band of luminance: at
 * least 3:1 against the dark background (the old inferno ramp's oldest stop
 * sank into it at 2.7:1) and 2:1 against the light one (its newest pale
 * yellow vanished at 1.1:1); markers' dark outlines and the rings' dark halo
 * carry the rest, also over roads, water and land cover.
 */
export const AGE_STOPS: [number, number, number][] = [
  [226, 152, 0],
  [236, 116, 16],
  [218, 66, 56],
  [192, 52, 128],
  [130, 68, 190],
]

export function ageColor(age: number, stops: readonly [number, number, number][] = AGE_STOPS): [number, number, number] {
  const x = Math.min(Math.max(age, 0), 1) * (stops.length - 1)
  const i = Math.min(Math.floor(x), stops.length - 2), f = x - i
  const a = stops[i], b = stops[i + 1]
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number]
}

/**
 * Worst-case error of a position reported with Meshtastic precision bits:
 * half the diagonal of the precision cell (firmware reports its centre).
 * Mirrors the engine's geo::precision_error_m (frontend/engine/src/geo.rs).
 */
export function precisionErrorM(bits: number, lat: number): number {
  if (bits >= 32) return 0
  const half = (2 ** (32 - bits) * 1e-7 * 111_320) / 2
  return Math.hypot(half, half * Math.cos((lat * Math.PI) / 180))
}

/**
 * How a node moves packets between the mesh and MQTT, as glyphs (D-054,
 * D-084). One rule: the glyph inside the marker tells how it uplinks (up: the
 * first copy of each packet; upAll: every copy, a double chevron), and a
 * downlink is always a small down arrow beside the marker (`down`). A small
 * marker has no room for an uplink and a downlink shape together.
 */
export type MqttFlow = 'up' | 'upAll' | 'down'
/** The same arrows as solid shapes (24x24), drawn on the map as tinted icons: fonts differ too much. */
export const MQTT_ARROW: Record<MqttFlow, string> = {
  up: 'M12 2 20 11h-5v11H9V11H4z',
  upAll: 'M12 2 21.5 11 18.3 14.2 12 7.6 5.7 14.2 2.5 11z M12 10.5 21.5 19.5 18.3 22.7 12 16.1 5.7 22.7 2.5 19.5z',
  down: 'M12 22 4 13h5V2h6v11h5z',
}

/** An aircraft (24x24), the badge on airborne nodes (D-073). */
export const PLANE = 'M11 1.5h2l1 7.5 8.5 4.5v2.2L14 13.5l-.6 5.3 2.6 2v1.7L12 21.4l-4 1.1v-1.7l2.6-2-.6-5.3-8.5 2.2v-2.2L10 9z'

/** The uplink glyph inside the marker, if it uplinks (see MqttFlow). */
export function mqttUplink(n: MeshNode): 'up' | 'upAll' | undefined {
  return n.is_gateway ? (n.multi_uplink ? 'upAll' : 'up') : undefined
}

/** It probably downlinks: a down arrow beside the marker (see MqttFlow). */
export function mqttDownlink(n: MeshNode): boolean {
  return !!n.mqtt_downlink
}

/** Ink for a glyph on a marker filled with rgb: dark on light fills, light on dark ones. */
export function glyphInk(rgb: readonly number[]): [number, number, number] {
  // Whichever ink contrasts more (WCAG): dark wins above ~18% luminance.
  return relativeLuminance(rgb) > 0.18 ? [14, 17, 22] : [250, 250, 248]
}

/** WCAG relative luminance of an sRGB colour (0..255 channels). */
export function relativeLuminance([r, g, b]: readonly number[]): number {
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Infrastructure roles: links between two of these are infrastructure links. */
export function isInfraRole(role: string | undefined): boolean {
  return role === 'ROUTER' || role === 'ROUTER_LATE'
}

/** Marker radius in pixels by device role. */
export function roleRadius(role: string | undefined): number {
  switch (role) {
    case 'ROUTER':
    case 'ROUTER_LATE':
      return 8
    case 'CLIENT_BASE':
      return 6.5
    default:
      return 5
  }
}

export function placeNodes(nodes: MeshNode[], endMs: number, windowMs: number): { placed: PlacedNode[]; unplaced: MeshNode[] } {
  const placed: PlacedNode[] = []
  const unplaced: MeshNode[] = []
  for (const n of nodes) {
    const age = lastHeardAge(n, endMs, windowMs)
    // A position narrowed from noisy reports (D-077) places it better than the latest report.
    if (n.position) placed.push({ node: n, kind: 'reported', lon: n.refined?.lon ?? n.position.lon, lat: n.refined?.lat ?? n.position.lat, age })
    else if (n.estimate) placed.push({ node: n, kind: 'estimated', lon: n.estimate.lon, lat: n.estimate.lat, age, radiusM: n.estimate.uncertainty_radius_m })
    else unplaced.push(n)
  }
  return { placed, unplaced }
}

const rank: Record<string, number> = { low: 0, medium: 1, high: 2 }

export function filterEdges(edges: Edge[], f: Filters, t: Toggles): Edge[] {
  return edges.filter((e) => {
    if (rank[e.confidence] < rank[f.minConfidence]) return false
    if (e.inferred && !t.inferred) return false
    if (f.evidence.length) {
      const ev = e.evidence as unknown as Record<string, number>
      if (!f.evidence.some((k) => (ev[k] ?? 0) > 0)) return false
    }
    return true
  })
}

/** One drawn line per node pair; each direction keeps its own evidence. */
export interface LinkGeom {
  a: string
  b: string
  ab?: Edge // a -> b (b heard a)
  ba?: Edge // b -> a (a heard b)
  path: [[number, number], [number, number]]
  confidence: string // the better of the two directions
  inferred: boolean // only when every present direction is inferred
  samples: number
  infra: boolean // both ends have an infrastructure role (ROUTER / ROUTER_LATE); never for MQTT links
  mqtt: boolean // carried over MQTT, not radio (D-055): drawn in its own layer
}

/**
 * Collapse directed edges into one line per pair of placed nodes, ordered by
 * total samples (best-supported first). Pairs with an unplaced end are skipped.
 */
export function linkGeometry(edges: Edge[], pos: Map<string, [number, number]>, roles: Map<string, string | undefined> = new Map()): LinkGeom[] {
  // A pair can have both a radio link and an MQTT link: one line each.
  const pairs = new Map<string, { a: string; b: string; mqtt: boolean; ab?: Edge; ba?: Edge }>()
  for (const e of edges) {
    const [a, b] = e.src < e.dst ? [e.src, e.dst] : [e.dst, e.src]
    const mqtt = !!e.mqtt
    const k = `${a}|${b}|${mqtt}`
    const p = pairs.get(k) ?? pairs.set(k, { a, b, mqtt }).get(k)!
    if (e.src === a) p.ab = e
    else p.ba = e
  }
  const out: LinkGeom[] = []
  for (const { a, b, mqtt, ab, ba } of pairs.values()) {
    const pa = pos.get(a), pb = pos.get(b)
    if (!pa || !pb || (pa[0] === pb[0] && pa[1] === pb[1])) continue
    const dirs = [ab, ba].filter((e): e is Edge => !!e)
    const best = dirs.reduce((x, y) => (rank[y.confidence] > rank[x.confidence] ? y : x))
    out.push({ a, b, ab, ba, path: [pa, pb], confidence: best.confidence, inferred: dirs.every((e) => e.inferred),
      samples: dirs.reduce((n, e) => n + e.samples, 0), infra: !mqtt && isInfraRole(roles.get(a)) && isInfraRole(roles.get(b)), mqtt })
  }
  return out.sort((x, y) => y.samples - x.samples)
}

/** Link opacity by confidence (low links are also dashed). */
/** A selected packet's route (D-037). */
export const ROUTE_COLOR: [number, number, number, number] = [255, 170, 60, 240]
/** A traceroute's two legs, drawn side by side: the way there and the way back. */
export const TRACE_COLOR: Record<'forward' | 'back', [number, number, number, number]> = { forward: [255, 92, 200, 240], back: [90, 150, 255, 240] }

/** Ring around nodes that did not allow MQTT uplink (D-032). */
export const OPT_OUT_RING: [number, number, number, number] = [255, 77, 77, 255]

export const CONFIDENCE_ALPHA: Record<string, number> = { high: 235, medium: 150, low: 120 }

/** Link widths in pixels: one per class, never by sample count. */
export const LINK_WIDTH = { infra: 3, other: 1.25 }


/** Most links drawn at low zoom (best-supported first; counts and lists stay complete). */
export const LOW_ZOOM_LINKS = 3000

/**
 * Level of detail: a selected node shows all of its own links and nothing
 * else; below zoom 9 only the best-supported links; zoomed in, only links
 * touching the viewport (with a 25 % margin).
 */
export function visibleLinks(links: LinkGeom[], o: { selectedNode: string | null; zoom: number; bounds: [number, number, number, number] | null }): LinkGeom[] {
  if (o.selectedNode) return links.filter((g) => g.a === o.selectedNode || g.b === o.selectedNode)
  if (o.zoom < 9) return links.length > LOW_ZOOM_LINKS ? links.slice(0, LOW_ZOOM_LINKS) : links // sorted by samples
  if (!o.bounds) return links
  const [w, s, e, n] = o.bounds
  const mx = (e - w) * 0.25, my = (n - s) * 0.25
  const inside = (p: [number, number]) => p[0] >= w - mx && p[0] <= e + mx && p[1] >= s - my && p[1] <= n + my
  return links.filter((g) => inside(g.path[0]) || inside(g.path[1]))
}

/**
 * The links to draw with the link open in Details among them: it is drawn
 * whatever the filters, link toggles and level of detail leave out, from all
 * edges and every placed marker, and last, so it lies on top.
 */
export function withSelectedLink(shown: LinkGeom[], sel: { src: string; dst: string; mqtt?: boolean } | null, edges: Edge[], pos: Map<string, [number, number]>, roles: Map<string, string | undefined>): LinkGeom[] {
  if (!sel) return shown
  const mqtt = !!sel.mqtt
  const pair = edges.filter((e) => !!e.mqtt === mqtt && ((e.src === sel.src && e.dst === sel.dst) || (e.src === sel.dst && e.dst === sel.src)))
  const g = linkGeometry(pair, pos, roles)[0]
  if (!g) return shown
  return [...shown.filter((x) => !(x.a === g.a && x.b === g.b && x.mqtt === g.mqtt)), g]
}

/**
 * A packet's route as drawable segments. Nodes without a position cannot be
 * drawn: each placed node is joined to the nearest placed nodes before it in
 * the route, dashed across the ones skipped, so the route stays whole.
 */
export function bridgeRoute(segs: RouteSegment[], pos: Map<string, [number, number]>): { from: [number, number]; to: [number, number]; dashed: boolean; seg: RouteSegment }[] {
  // Per traceroute leg: a bridge never joins the way there to the way back.
  const into = new Map<string, RouteSegment[]>()
  const k = (leg: string | undefined, n: string) => `${leg ?? ''}|${n}`
  for (const g of segs) into.set(k(g.leg, g.b), [...(into.get(k(g.leg, g.b)) ?? []), g])
  const placedBefore = (n: string, leg: string | undefined, seen: Set<string>): string[] => {
    if (seen.has(n)) return []
    seen.add(n)
    return (into.get(k(leg, n)) ?? []).flatMap((g) => (pos.has(g.a) ? [g.a] : placedBefore(g.a, leg, seen)))
  }
  const out: ReturnType<typeof bridgeRoute> = []
  const drawn = new Set<string>()
  // Segments between placed nodes first, so a bridge never replaces a real one.
  const ordered = [...segs.filter((g) => pos.has(g.a)), ...segs.filter((g) => !pos.has(g.a))]
  for (const g of ordered) {
    const b = pos.get(g.b)
    if (!b) continue
    for (const a of pos.has(g.a) ? [g.a] : placedBefore(g.a, g.leg, new Set())) {
      const key = `${a}>${g.b}>${g.leg ?? ''}`
      if (drawn.has(key)) continue
      drawn.add(key)
      const bridged = a !== g.a
      out.push({ from: pos.get(a)!, to: b, dashed: g.dashed || bridged, seg: bridged ? { ...g, a, dashed: true, why: 'gap' } : g })
    }
  }
  return out
}

/** Where a moving node was at `at` (ms): its last track point by then, else its first (D-073). */
export function positionAt(track: { lat: number; lon: number; at: string }[], at: number): [number, number] {
  let p = track[0]
  for (const x of track) if (Date.parse(x.at) <= at) p = x
  return [p.lon, p.lat]
}

