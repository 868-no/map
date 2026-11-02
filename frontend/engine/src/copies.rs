//! Each packet's gateway copies, grouped once per snapshot with the
//! transmitter each copy was heard from (D-083). Zero-cost detection (D-068)
//! and router reliability (D-078) both walk every packet's copies; grouping
//! and resolving last-hop bytes (D-024) once serves both.

use crate::graph::RelayContext;
use crate::row::{ty, Row};
use crate::util::{map, FxMap};

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
