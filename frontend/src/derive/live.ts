// Live rows to ping receptions: the same fields the server summarises in
// its live events, read from the full row.
import type { ObsRow } from '../api/types'
import type { Reception } from '../map/pings'
import { nodeId } from './graph'

export function receptionFromRow(r: ObsRow): Reception {
  const tr = r.tr?.valid ? r.tr : undefined
  const hops = tr ? (tr.is_reply ? tr.route_back : tr.route) ?? [] : null
  return {
    node: nodeId(r.s), gw: r.g != null ? nodeId(r.g) : undefined, lp: r.l, direct_rf: r.dr,
    relay: r.r ?? undefined, hops: r.hs != null && r.hl != null ? r.hs - r.hl : undefined,
    path: hops ? hops.map((h) => (h.unknown ? '' : nodeId(h.id))) : null,
    snr: r.sn ?? undefined, rssi: r.rs ?? undefined,
  }
}
