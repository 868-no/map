//! Heard only by its own gateway.

use super::{Ctx, Issues};
use crate::row::ty;
use crate::util::FxSet;

/// Own packets before "only its own gateway hears it" applies.
pub const ISOLATED_MIN_PACKETS: usize = 10;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let heard_by: FxSet<u32> = cx.rows.iter().filter(|r| r.gw.is_some_and(|g| g != r.src)).map(|r| r.src).collect();
    for (&n, pk) in &cx.own {
        let packets = pk.values().filter(|r| r.ty != ty::MAPREPORT).count();
        if packets >= ISOLATED_MIN_PACKETS && !heard_by.contains(&n) && pk.values().any(|r| r.gw == Some(n)) {
            out.add(n, "isolated", "notice", "No other gateway reports it".into(), format!("None of its {packets} packets were uplinked by another gateway. It may simply have no other gateway in range (nodes that are not gateways can still hear it), or a poor antenna or location, or different radio settings than its neighbours."));
        }
    }
}
