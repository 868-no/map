// One packet's routing graph, from every in-window reception of it (all
// rows sharing its logical key). Segments are directed transmitter ->
// receiver. A segment is solid when both nodes are known to have been
// adjacent, dashed when one or more nodes between them are unknown.
import type { MeshNode, ObsRow } from '../api/types'
import { nodeId, resolveRelay, type RelayContext } from './graph'
import { ZERO_COST_ROLES } from '../map/pings'

export interface RouteSegment {
  a: string // transmitter
  b: string // receiver
  dashed: boolean // nodes between a and b are missing
  why: 'direct' | 'traceroute' | 'relay' | 'gap' | 'unknown_relay'
}

export interface PacketRoute {
  origin: string
  type: string
  segments: RouteSegment[]
  receptions: number
}

/** rows: every in-window row of one logical packet. */
export function buildRoute(rows: ObsRow[], ctx: RelayContext, nodes: MeshNode[]): PacketRoute | null {
  if (rows.length === 0) return null
  const origin = rows[0].s
  const role = new Map(nodes.map((n) => [n.num, n.identity?.role]))
  const segs = new Map<string, RouteSegment>()
  const add = (a: number, b: number, dashed: boolean, why: RouteSegment['why']) => {
    if (a === b) return
    const k = `${a}>${b}`
    const cur = segs.get(k)
    if (!cur || (cur.dashed && !dashed)) segs.set(k, { a: nodeId(a), b: nodeId(b), dashed, why })
  }
  for (const r of rows) {
    const gw = r.g
    if (gw == null || gw === origin) continue // no gateway, or the sender's own uplink
    const tr = r.tr?.valid ? r.tr : undefined
    if (tr) {
      // Recorded route: origin, relays in order, then the gateway (which may
      // have appended itself already). Unknown hops leave a dashed gap.
      const hops = (tr.is_reply ? tr.route_back : tr.route) ?? []
      const chain: (number | null)[] = [origin, ...hops.map((h) => (h.unknown ? null : h.id))]
      if (chain[chain.length - 1] !== gw) chain.push(gw)
      let last = origin
      let gap = false
      for (const n of chain.slice(1)) {
        if (n == null) {
          gap = true
          continue
        }
        add(last, n, gap, gap ? 'gap' : 'traceroute')
        last = n
        gap = false
      }
      continue
    }
    if (r.rr === 'via_mqtt' || r.rr === 'non_rf_transport') continue // not heard over radio
    if (r.dr || r.rr === 'no_rx_metrics') {
      add(origin, gw, false, 'direct') // zero hops: the gateway heard the sender
      continue
    }
    const hops = r.hs != null && r.hl != null ? r.hs - r.hl : undefined
    const [relay, res] = r.r != null ? resolveRelay(r.r & 0xff, origin, gw, ctx) : [0, 'unmatched' as const]
    if (res !== 'resolved') {
      add(origin, gw, true, 'unknown_relay')
      continue
    }
    add(relay, gw, false, 'relay')
    // One hop spent, by a relay that cannot receive at zero cost: it heard the sender itself.
    const rr = role.get(relay)
    const direct = hops === 1 && rr != null && rr !== '' && !ZERO_COST_ROLES.has(rr)
    add(origin, relay, !direct, direct ? 'relay' : 'gap')
  }
  return { origin: nodeId(origin), type: rows[0].y, segments: [...segs.values()], receptions: new Set(rows.map((r) => r.o)).size }
}
