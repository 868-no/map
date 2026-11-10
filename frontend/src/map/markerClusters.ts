// Node markers that overlap on screen at low zoom are drawn as one cluster
// (D-204): a disc with the member count, at one member's real position (the
// most prominent: routers first, then reported positions, then the busiest),
// coloured by the most recently heard member. Nothing is placed where no
// node is. Pure functions in Web Mercator world pixels (unit-tested).
import { toPixels } from './labels'
import { roleRank, type PlacedNode } from './model'
import { NODE_RADIUS } from './roleIcons'

/** Markers cluster only below this zoom; from here every marker is drawn and names take over (§7.6). */
export const MARKER_CLUSTER_MAX_ZOOM = 10

/** A cluster disc's radius in pixels: a little larger than a node's marker (D-186), growing with the count's digits. */
export function clusterRadius(count: number): number {
  return NODE_RADIUS + (count < 10 ? 3 : count < 100 ? 4 : 6)
}

/** Markers whose discs (outlines included) come this close in pixels overlap. */
const OUTLINE_PX = 2
/** Grid cell: at least the farthest reach tested (the largest cluster disc plus a marker and the outline). */
const CELL = 32

export interface MarkerCluster {
  marker: true // tells a cluster from a node or a name when picked
  id: string // the representative's id
  rep: PlacedNode // drawn at its position
  members: PlacedNode[] // the representative first, then by prominence
  freshest: number // the smallest last-heard age among the members
}

export interface MarkerClustering {
  shown: PlacedNode[] // markers drawn on their own, in input order
  clusters: MarkerCluster[]
  anchor: Map<string, [number, number]> // a clustered node's id -> its cluster's drawn position
}

/** Which member represents a cluster: routers first, reported before estimated, then the busiest. */
function markerOrder(a: PlacedNode, b: PlacedNode): number {
  return (
    roleRank(b.node.identity?.role) - roleRank(a.node.identity?.role) ||
    (a.kind === 'estimated' ? 1 : 0) - (b.kind === 'estimated' ? 1 : 0) ||
    b.node.packets + b.node.gateway_receptions - (a.node.packets + a.node.gateway_receptions) ||
    (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)
  )
}

/**
 * Cluster overlapping markers at this zoom. Exempt nodes (selected, search
 * results, the ends of the selected link, a drawn route's nodes) are always
 * drawn on their own and never absorbed.
 *
 * Greedy, in prominence order: a node that overlaps an existing cluster's
 * disc joins it; otherwise it absorbs every unassigned node whose marker
 * overlaps its own. Clusters therefore never chain across the map, and the
 * most prominent node of each group is its representative. Grid-bucketed:
 * linear in node count. Recomputed on zoom changes, not while panning.
 */
export function clusterMarkers(placed: PlacedNode[], zoom: number, exempt: ReadonlySet<string> = new Set()): MarkerClustering {
  if (zoom >= MARKER_CLUSTER_MAX_ZOOM || placed.length < 2) return { shown: placed, clusters: [], anchor: new Map() }
  const cand = placed.filter((p) => !exempt.has(p.node.id)).sort(markerOrder)
  const pts = cand.map((p) => {
    const [x, y] = toPixels(p.lon, p.lat, zoom)
    return { p, x, y, r: NODE_RADIUS }
  })
  const key = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
  const grid = new Map<string, number[]>()
  pts.forEach((q, i) => {
    const k = key(q.x, q.y)
    const l = grid.get(k)
    if (l) l.push(i)
    else grid.set(k, [i])
  })
  const near = <T>(g: Map<string, T[]>, x: number, y: number, f: (v: T) => void) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const v of g.get(`${cx + dx},${cy + dy}`) ?? []) f(v)
  }

  const assigned = new Array<boolean>(pts.length).fill(false)
  // Clusters formed so far, bucketed by their representative's pixel.
  type Group = { at: (typeof pts)[number]; members: PlacedNode[] }
  const groups: Group[] = []
  const groupGrid = new Map<string, Group[]>()
  pts.forEach((q, i) => {
    if (assigned[i]) return
    // Inside an existing cluster's disc: join the nearest such cluster.
    let best: Group | undefined, bestD = Infinity
    near(groupGrid, q.x, q.y, (g) => {
      const d = Math.hypot(g.at.x - q.x, g.at.y - q.y)
      if (d < clusterRadius(g.members.length) + q.r + OUTLINE_PX && d < bestD) [best, bestD] = [g, d]
    })
    assigned[i] = true
    if (best) return void best.members.push(q.p)
    // Otherwise it leads: it takes every unassigned marker overlapping its own.
    const members = [q.p]
    near(grid, q.x, q.y, (j) => {
      if (assigned[j]) return
      const o = pts[j]
      if (Math.hypot(o.x - q.x, o.y - q.y) < q.r + o.r + OUTLINE_PX) {
        assigned[j] = true
        members.push(o.p)
      }
    })
    if (members.length < 2) return // overlaps nothing: drawn on its own
    const g = { at: q, members }
    groups.push(g)
    const k = key(q.x, q.y)
    const l = groupGrid.get(k)
    if (l) l.push(g)
    else groupGrid.set(k, [g])
  })

  const anchor = new Map<string, [number, number]>()
  const clusters = groups.map(({ at, members }): MarkerCluster => {
    members.sort(markerOrder) // the representative stays first: it sorts before every node it absorbed or that joined it
    for (const m of members) anchor.set(m.node.id, [at.p.lon, at.p.lat])
    return { marker: true, id: at.p.node.id, rep: at.p, members, freshest: Math.min(...members.map((m) => m.age)) }
  })
  return { shown: anchor.size ? placed.filter((p) => !anchor.has(p.node.id)) : placed, clusters, anchor }
}

/**
 * Positions as drawn: a clustered node at its cluster's disc, every other
 * node where its marker is. Links, pings and reach paths use these (D-043).
 */
export function drawnPositions(pos: Map<string, [number, number]>, anchor: Map<string, [number, number]>): Map<string, [number, number]> {
  if (anchor.size === 0) return pos
  const out = new Map(pos)
  for (const [id, p] of anchor) out.set(id, p)
  return out
}

/** Hover text for a cluster: its count, then its members by prominence (at most `max` lines of names). */
export function clusterSummary(k: MarkerCluster, name: (id: string) => string, max = 8): string {
  const n = k.members.length
  const names = k.members.slice(0, n > max ? max - 1 : max).map((m) => name(m.node.id))
  if (n > names.length) names.push(`and ${n - names.length} more`)
  return [`${n} nodes close together; click to zoom in`, ...names].join('\n')
}
