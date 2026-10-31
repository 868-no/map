// Per-node packet logs, derived from the window's rows: the node's own
// packets, and other nodes' packets it relayed. Relaying is known from a
// gateway's last-hop byte resolving to the node (same narrowing as links)
// or from the node appearing in a traceroute's recorded route.
import type { Edge, MeshNode, ObsRow } from '../api/types'
import { iso, nodeId, relayContext, resolveRelay, type LatLon, type RelayContext, type Sample } from './graph'

export const MAX_LOG = 200

export interface OwnPacket {
  lp: string // logical packet key
  at: string // first in-window reception
  type: string
  to?: string // node id or "broadcast"
  channel?: string
  hops?: number // fewest hops any gateway saw (hop_start - hop_limit)
  gateways: number
  receptions: number
  signature: string
}

export interface RelayedPacket {
  lp: string
  at: string // first evidence of this node relaying it
  origin: string
  type: string
  to?: string
  evidence: ('relay_byte' | 'traceroute')[]
  gateways: string[] // gateways that heard this node's rebroadcast (relay byte)
}

export interface PacketLog {
  own: OwnPacket[]
  relayed: RelayedPacket[]
  truncated: boolean
}

const BROADCAST = 0xffffffff
const dest = (d?: number) => (d == null || d === 0 ? undefined : d === BROADCAST ? 'broadcast' : nodeId(d))

/** The relay context the snapshot used: its nodes, reported positions and non-relay links. */
export function contextFromSnapshot(nodes: MeshNode[], edges: Edge[]): RelayContext {
  const pos = new Map<number, LatLon>()
  for (const n of nodes) if (n.position) pos.set(n.num, { lat: n.position.lat, lon: n.position.lon })
  const confirmed: Sample[] = edges
    .filter((e) => e.evidence.neighbor + e.evidence.traceroute + e.evidence.direct_rf > 0)
    .map((e) => ({ src: e.src_num, dst: e.dst_num, ev: 'neighbor', t: 0, key: '' }))
  return relayContext(nodes.map((n) => n.num), pos, confirmed)
}

/** rows: in-window and filtered, ordered by (t, id). */
export function buildPacketLog(rows: ObsRow[], num: number, ctx: RelayContext): PacketLog {
  const own = new Map<string, ObsRow[]>()
  const relayed = new Map<string, { first: number; row: ObsRow; evidence: Set<'relay_byte' | 'traceroute'>; gateways: Set<number> }>()
  const note = (r: ObsRow, ev: 'relay_byte' | 'traceroute', gw?: number) => {
    let e = relayed.get(r.l)
    if (!e) relayed.set(r.l, (e = { first: r.t, row: r, evidence: new Set(), gateways: new Set() }))
    e.first = Math.min(e.first, r.t)
    e.evidence.add(ev)
    if (gw != null) e.gateways.add(gw)
  }
  for (const r of rows) {
    if (r.s === num) {
      const l = own.get(r.l)
      if (l) l.push(r)
      else own.set(r.l, [r])
      continue
    }
    // A gateway heard this node's rebroadcast (not its own uplink of the packet).
    if (r.g != null && r.g !== num && !r.dr && r.rr === 'relayed' && r.r != null && ((r.r & 0xff) === (num & 0xff))) {
      const [who, res] = resolveRelay(r.r & 0xff, r.s, r.g, ctx)
      if (res === 'resolved' && who === num) note(r, 'relay_byte', r.g)
    }
    // Traceroutes record each relay: the route for requests, route_back for
    // replies. The uplinking gateway appends itself too; that last entry only
    // received the copy.
    const tr = r.tr?.valid ? r.tr : undefined
    let hops = tr ? (tr.is_reply ? tr.route_back : tr.route) ?? [] : []
    if (hops.length && hops[hops.length - 1].id === r.g) hops = hops.slice(0, -1)
    if (hops.some((h) => !h.unknown && h.id === num)) note(r, 'traceroute')
  }
  const ownList = [...own.values()].map((rs) => {
    const hops = rs.flatMap((r) => (r.hs != null && r.hl != null ? [r.hs - r.hl] : []))
    const first = rs.reduce((a, b) => (b.t < a.t ? b : a))
    return {
      t: first.t,
      p: {
        lp: first.l, at: iso(first.t), type: first.y, ...(dest(first.d) ? { to: dest(first.d) } : {}), ...(first.c ? { channel: first.c } : {}),
        ...(hops.length ? { hops: Math.min(...hops) } : {}),
        gateways: new Set(rs.flatMap((r) => (r.g != null ? [r.g] : []))).size, receptions: new Set(rs.map((r) => r.o)).size, signature: first.sg,
      } satisfies OwnPacket,
    }
  })
  const relayedList = [...relayed.values()].map((e) => ({
    t: e.first,
    p: {
      lp: e.row.l, at: iso(e.first), origin: nodeId(e.row.s), type: e.row.y, ...(dest(e.row.d) ? { to: dest(e.row.d) } : {}),
      evidence: [...e.evidence].sort(), gateways: [...e.gateways].sort((a, b) => a - b).map(nodeId),
    } satisfies RelayedPacket,
  }))
  const newest = <T,>(l: { t: number; p: T }[]) => l.sort((a, b) => b.t - a.t).slice(0, MAX_LOG).map((x) => x.p)
  return { own: newest(ownList), relayed: newest(relayedList), truncated: ownList.length > MAX_LOG || relayedList.length > MAX_LOG }
}
