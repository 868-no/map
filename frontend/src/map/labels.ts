// Node names that would overlap on screen are grouped into clusters. A
// collapsed cluster shows one name and "+N"; an exploded one fans every name
// out around the cluster with a leader line to its marker. Markers never
// move. Pure functions in Web Mercator world pixels (unit-tested).
import { roleRank, type PlacedNode } from './model'
import { NODE_RADIUS } from './roleIcons'

const TILE = 512 // MapLibre's world size at zoom 0

export function toPixels(lon: number, lat: number, zoom: number): [number, number] {
  const w = TILE * 2 ** zoom
  const s = Math.sin((Math.max(Math.min(lat, 85.05), -85.05) * Math.PI) / 180)
  return [((lon + 180) / 360) * w, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w]
}

export function fromPixels(x: number, y: number, zoom: number): [number, number] {
  const w = TILE * 2 ** zoom
  const lon = (x / w) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / w))) * 180) / Math.PI
  return [lon, lat]
}

const labelText = (p: PlacedNode) => p.node.identity?.short_name || p.node.id.slice(-4)

/** Approximate rendered label box (18 px system font, outline included). */
const LABEL_H = 22
const labelWidth = (text: string) => text.length * 10 + 10

export interface Cluster {
  id: string
  members: PlacedNode[] // lead first
  lead: PlacedNode
}

/** Most prominent member names the collapsed cluster: routers first, then the busiest. */
function prominence(p: PlacedNode): number {
  return roleRank(p.node.identity?.role) * 1e9 + p.node.packets + p.node.gateway_receptions
}

/**
 * Group nodes whose labels would overlap at this zoom (label boxes centred
 * above each marker). Every node belongs to exactly one cluster; most are
 * singletons. Grid-bucketed, so large meshes stay cheap.
 */
export function clusterLabels(placed: PlacedNode[], zoom: number): Cluster[] {
  const n = placed.length
  const px = placed.map((p) => {
    const [x, y] = toPixels(p.lon, p.lat, zoom)
    return { x, y: y - NODE_RADIUS - 12, w: labelWidth(labelText(p)) }
  })
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const CELL = 128
  const grid = new Map<string, number[]>()
  px.forEach((q, i) => {
    const k = `${Math.floor(q.x / CELL)},${Math.floor(q.y / CELL)}`
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  })
  px.forEach((a, i) => {
    const cx = Math.floor(a.x / CELL), cy = Math.floor(a.y / CELL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (j <= i) continue
          const b = px[j]
          if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < LABEL_H) parent[find(i)] = find(j)
        }
      }
    }
  })
  const groups = new Map<number, PlacedNode[]>()
  placed.forEach((p, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(p)
    else groups.set(r, [p])
  })
  return [...groups.values()].map((members) => {
    members.sort((a, b) => prominence(b) - prominence(a) || (a.node.id < b.node.id ? -1 : 1))
    return { id: members.map((m) => m.node.id).sort().join(','), members, lead: members[0] }
  })
}

export interface FanSlot {
  node: PlacedNode
  pos: [number, number] // label position (lon, lat)
}

/**
 * The most names a cluster fans out. Clusters join transitively, so in a
 * dense town one can hold hundreds of nodes: their names would not fit on a
 * ring anyone can read, and placing them costs O(n²) per ring size tried.
 * The rest are counted in a "+N more" under the ring; zooming in splits the
 * cluster.
 */
export const FAN_MAX = 12

/** The members a fan names: the most prominent, and always `keep` (the selected node) when it is a member. */
function fanMembers(c: Cluster, keep?: string | null): PlacedNode[] {
  if (c.members.length <= FAN_MAX) return c.members
  const top = c.members.slice(0, FAN_MAX) // members are sorted by prominence
  const kept = keep ? c.members.find((m) => m.node.id === keep) : undefined
  if (kept && !top.includes(kept)) top[FAN_MAX - 1] = kept
  return top
}

interface FanLayout {
  slots: FanSlot[]
  centre: [number, number] // world pixels
  r: number // ring radius, pixels
}

function fanLayout(c: Cluster, zoom: number, keep?: string | null): FanLayout {
  const pts = fanMembers(c, keep).map((m) => ({ m, p: toPixels(m.lon, m.lat, zoom), w: labelWidth(labelText(m)) }))
  const cx = pts.reduce((s, q) => s + q.p[0], 0) / pts.length
  const cy = pts.reduce((s, q) => s + q.p[1], 0) / pts.length
  const n = pts.length
  const angle = (q: (typeof pts)[number]) => Math.atan2(q.p[1] - cy, q.p[0] - cx)
  // Coincident markers have no direction: keep their order stable by id.
  const ordered = [...pts].sort((a, b) => angle(a) - angle(b) || (a.m.node.id < b.m.node.id ? -1 : 1))
  // Start at the first marker's direction; straight above when they coincide.
  const spread = pts.some((q) => Math.hypot(q.p[0] - cx, q.p[1] - cy) > 0.5)
  const base = spread ? angle(ordered[0]) : -Math.PI / 2
  const at = (r: number) => ordered.map((q, i) => {
    const t = base + (2 * Math.PI * i) / n
    return { q, x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) }
  })
  // Smallest ring (from 48 px) on which no two label boxes overlap.
  const clear = (slots: ReturnType<typeof at>) =>
    slots.every((a, i) => slots.every((b, j) => j <= i || Math.abs(a.x - b.x) >= (a.q.w + b.q.w) / 2 + 4 || Math.abs(a.y - b.y) >= LABEL_H + 2))
  let r = 48
  while (r < 600 && !clear(at(r))) r += 4
  return { slots: at(r).map((s) => ({ node: s.q.m, pos: fromPixels(s.x, s.y, zoom) })), centre: [cx, cy], r }
}

/**
 * Exploded layout: names on a ring around the cluster's centre, assigned in
 * the angular order of their markers so leader lines do not cross. The ring
 * grows with the cluster so names keep apart. At most FAN_MAX names.
 */
export function fanOut(c: Cluster, zoom: number, keep?: string | null): FanSlot[] {
  return fanLayout(c, zoom, keep).slots
}

/** One rendered name: a collapsed cluster's, or one member's in an exploded fan. */
export interface LabelDatum {
  label: true
  cluster: Cluster
  node: PlacedNode // the node this label names (the lead when collapsed)
  text: string
  pos: [number, number]
  exploded: boolean
  /** A fan's "+N more": how many names it leaves out, and the ring's centre (lon, lat) to zoom in on. */
  more?: { count: number; centre: [number, number] }
}

/** Labels for the clusters; `keep` (the selected node) is always among a fan's names. */
export function labelData(clusters: Cluster[], exploded: Set<string>, zoom: number, keep?: string | null): { labels: LabelDatum[]; leaders: { from: [number, number]; to: [number, number] }[] } {
  const labels: LabelDatum[] = []
  const leaders: { from: [number, number]; to: [number, number] }[] = []
  for (const c of clusters) {
    if (c.members.length > 1 && exploded.has(c.id)) {
      const fan = fanLayout(c, zoom, keep)
      for (const s of fan.slots) {
        labels.push({ label: true, cluster: c, node: s.node, text: labelText(s.node), pos: s.pos, exploded: true })
        leaders.push({ from: [s.node.lon, s.node.lat], to: s.pos })
      }
      const left = c.members.length - fan.slots.length
      if (left > 0) {
        const [cx, cy] = fan.centre
        labels.push({
          label: true, cluster: c, node: c.lead, text: `+${left} more`, exploded: true,
          pos: fromPixels(cx, cy + fan.r + LABEL_H + 6, zoom), // under the ring's lowest name
          more: { count: left, centre: fromPixels(cx, cy, zoom) },
        })
      }
    } else {
      const extra = c.members.length - 1
      labels.push({ label: true, cluster: c, node: c.lead, text: labelText(c.lead) + (extra ? ` +${extra}` : ''), pos: [c.lead.lon, c.lead.lat], exploded: false })
    }
  }
  return { labels, leaders }
}
