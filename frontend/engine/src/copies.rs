//! Each packet's gateway copies, grouped once per snapshot with the
//! transmitter each copy was heard from (D-083). Zero-cost detection (D-068)
//! and router reliability (D-078) both walk every packet's copies; grouping
//! and resolving last-hop bytes (D-024) once serves both, and spotting
//! gateways that uplink every copy they hear (D-084).

use crate::graph::RelayContext;
use crate::row::{ty, Row};
use crate::util::{map, set, FxMap, FxSet};

pub struct Heard<'a> {
    pub row: &'a Row,
    /// Who the gateway heard this copy from: the originator for direct
    /// receptions, else the relay its last-hop byte resolves to. Only for
    /// copies with a hop limit, uplinked by a gateway other than the originator.
    pub sender: Option<u32>,
}

/// Radio copies reported by a gateway (no map reports, no copies that came
/// over MQTT or from outside RF), grouped by packet, in row order.
pub fn by_packet<'a>(rows: &[&'a Row], ctx: &RelayContext) -> Vec<Vec<Heard<'a>>> {
    let mut groups: FxMap<u64, Vec<Heard<'a>>> = map();
    for &r in rows {
        let Some(gw) = r.gw else { continue };
        if r.ty == ty::MAPREPORT || r.rr == ty::VIA_MQTT || r.rr == ty::NON_RF {
            continue;
        }
        let sender = match r.hl {
            Some(_) if gw != r.src => {
                if r.dr || r.hs == r.hl {
                    Some(r.src)
                } else {
                    r.relay.and_then(|b| ctx.resolve((b & 0xff) as u8, r.src, gw)).and_then(Result::ok)
                }
            }
            _ => None,
        };
        groups.entry(r.lp).or_default().push(Heard { row: r, sender });
    }
    groups.into_values().collect()
}

/// Packets a gateway must have uplinked more than one copy of before it
/// counts as uplinking every copy it hears.
pub const MULTI_UPLINK_MIN_PACKETS: usize = 3;

/// Gateways that uplink every copy they hear (D-084). Firmware today uplinks
/// only the first copy of a packet; a gateway with a future option to upload
/// each copy reports one packet several times, from different last hops (or
/// hop limits, or traceroute routes). Its own packets do not count. Copies
/// are distinct receptions: byte-identical re-deliveries collapse at ingest.
pub fn multi_uplinkers(rows: &[&Row]) -> FxSet<u32> {
    // Copies per (gateway, packet), then packets per gateway with more than one.
    let mut copies: FxMap<(u32, u64), usize> = map();
    for &r in rows {
        let Some(g) = r.gw else { continue };
        if g == r.src || r.ty == ty::MAPREPORT || r.rr == ty::VIA_MQTT || r.rr == ty::NON_RF {
            continue;
        }
        *copies.entry((g, r.lp)).or_default() += 1;
    }
    let mut count: FxMap<u32, usize> = map();
    for ((g, _), n) in copies {
        if n > 1 {
            *count.entry(g).or_default() += 1;
        }
    }
    let mut out = set();
    out.extend(count.into_iter().filter(|&(_, n)| n >= MULTI_UPLINK_MIN_PACKETS).map(|(g, _)| g));
    out
}
