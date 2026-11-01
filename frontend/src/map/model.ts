// Pure view-model helpers for map layers (unit-tested; no WebGL here).
import type { Edge, MeshNode } from '../api/types'
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

/** How long before the window end the node was last heard, as a fraction of the window (0..1). */
export function lastHeardAge(n: MeshNode, endMs: number, windowMs: number): number {
  if (!n.last_seen || windowMs <= 0) return 1
  return Math.min(Math.max((endMs - Date.parse(n.last_seen)) / windowMs, 0), 1)
}

/**
 * Last-heard colour ramp (inferno, reversed and clipped so the oldest stop
 * stays visible on the dark basemap; colourblind-safe, monotonic lightness).
 * Stops are at age 0, 0.25, 0.5, 0.75 and 1 of the selected window.
 */
export const AGE_STOPS: [number, number, number][] = [
  [252, 255, 164],
  [250, 194, 40],
  [245, 125, 21],
  [212, 72, 66],
  [159, 42, 99],
]

export function ageColor(age: number): [number, number, number] {
  const x = Math.min(Math.max(age, 0), 1) * (AGE_STOPS.length - 1)
  const i = Math.min(Math.floor(x), AGE_STOPS.length - 2), f = x - i
  const a = AGE_STOPS[i], b = AGE_STOPS[i + 1]
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number]
}

/**
 * Worst-case error of a position reported with Meshtastic precision bits:
 * half the diagonal of the precision cell (firmware reports its centre).
 * Mirrors the backend's geo.PrecisionErrorM.
 */
export function precisionErrorM(bits: number, lat: number): number {
  if (bits >= 32) return 0
  const half = (2 ** (32 - bits) * 1e-7 * 111_320) / 2
  return Math.hypot(half, half * Math.cos((lat * Math.PI) / 180))
}

/** Which way a node moves packets between the mesh and MQTT (D-054). */
export type MqttFlow = 'up' | 'down' | 'both'
export const MQTT_GLYPH: Record<MqttFlow, string> = { up: '↑', down: '↓', both: '↕' }
/** The same arrows as solid shapes (24x24), drawn on the map as tinted icons: fonts differ too much. */
export const MQTT_ARROW: Record<MqttFlow, string> = {
  up: 'M12 2 20 11h-5v11H9V11H4z',
  down: 'M12 22 4 13h5V2h6v11h5z',
  both: 'M12 1 19 8h-4.5v8H19l-7 7-7-7h4.5V8H5z',
}

export function mqttFlow(n: MeshNode): MqttFlow | undefined {
  const up = n.is_gateway, down = !!n.mqtt_downlink
  return up && down ? 'both' : up ? 'up' : down ? 'down' : undefined
}

/** Ink for a glyph on a marker filled with rgb: dark on light fills, light on dark ones. */
export function glyphInk(rgb: readonly number[]): [number, number, number] {
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
  return lum > 0.55 ? [14, 17, 22] : [250, 250, 248]
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
    if (n.position) placed.push({ node: n, kind: 'reported', lon: n.position.lon, lat: n.position.lat, age })
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
