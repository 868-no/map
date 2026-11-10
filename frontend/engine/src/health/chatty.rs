//! Chatty nodes: positions, NodeInfo or device telemetry broadcast more
//! often than the firmware defaults.

use super::{Ctx, Issues};
use crate::row::ty;

/// Broadcast rates per hour above firmware defaults that count as chatty.
pub const POSITION_PER_H: f64 = 4.0;
pub const NODEINFO_PER_H: f64 = 1.0;
pub const TELEMETRY_PER_H: f64 = 4.0;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let hours = cx.hours;
    for x in cx.nodes {
        let n = x.num;
        let moving = x.moved_at.is_some();
        let rate = |t: u32| cx.count(n, t, |_| true) as f64 / hours;
        let tel = cx.count(n, ty::TELEMETRY, |r| r.telemetry().is_some_and(|t| t.kind == ty::DEVICE)) as f64 / hours;
        for (kind, r, limit, what, default) in [
            ("chatty_position", if moving { 0.0 } else { rate(ty::POSITION) }, POSITION_PER_H, "positions", "the firmware default is one every 15 minutes at most, less when it is not moving"),
            ("chatty_nodeinfo", rate(ty::NODEINFO), NODEINFO_PER_H, "NodeInfo announcements", "the default is one every 3 hours"),
            ("chatty_telemetry", tel, TELEMETRY_PER_H, "device telemetry reports", "the default is one every 30 minutes"),
        ] {
            if r > limit {
                out.add(n, kind, "notice", format!("Sends {r:.1} {what} per hour"), format!("More often than needed ({default}); each one is flooded through the mesh."));
            }
        }
    }
}
