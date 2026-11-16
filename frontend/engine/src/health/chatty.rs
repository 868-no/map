//! Chatty nodes: positions, NodeInfo or device telemetry broadcast more
//! often than the firmware defaults.

use super::{Ctx, Issues};
use crate::row::ty;

/// Broadcast rates per hour above firmware defaults that count as chatty.
pub const POSITION_PER_H: f64 = 4.0;
pub const NODEINFO_PER_H: f64 = 1.0;
pub const TELEMETRY_PER_H: f64 = 4.0;
/// How many of a node's newest broadcasts of a kind tell its rate now (the
/// mean gap between them, leaving out the longest), which must be over the
/// limit too: a rate brought down within the window is not flagged (D-226).
pub const CHATTY_RECENT: usize = 10;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let hours = cx.hours;
    for x in cx.nodes {
        let n = x.num;
        let moving = x.moved_at.is_some();
        let Some(own) = cx.own.get(&n) else { continue };
        // The rate now (D-226): the mean gap between its newest
        // `CHATTY_RECENT` of the kind, leaving out the longest, so a rate
        // brought down within the window no longer flags, while one gap
        // where gateways missed it does not clear it. With fewer, the
        // window's rate stands.
        let rate = |keep: &dyn Fn(&crate::row::Row) -> bool| {
            let mut ts: Vec<i64> = own.values().filter(|r| keep(r)).map(|r| r.t).collect();
            let all = ts.len() as f64 / hours;
            if ts.len() < CHATTY_RECENT {
                return (all, all);
            }
            ts.sort_unstable();
            let mut gaps: Vec<i64> = ts[ts.len() - CHATTY_RECENT..].windows(2).map(|w| w[1] - w[0]).collect();
            gaps.sort_unstable();
            gaps.pop();
            let sum: i64 = gaps.iter().sum();
            (all, if sum > 0 { 3_600_000.0 * gaps.len() as f64 / sum as f64 } else { all })
        };
        for (kind, (r, now), limit, what, default) in [
            ("chatty_position", if moving { (0.0, 0.0) } else { rate(&|r| r.ty == ty::POSITION) }, POSITION_PER_H, "positions", "the firmware default is one every 15 minutes at most, less when it is not moving"),
            ("chatty_nodeinfo", rate(&|r| r.ty == ty::NODEINFO), NODEINFO_PER_H, "NodeInfo announcements", "the default is one every 3 hours"),
            ("chatty_telemetry", rate(&|r| r.ty == ty::TELEMETRY && r.telemetry().is_some_and(|t| t.kind == ty::DEVICE)), TELEMETRY_PER_H, "device telemetry reports", "the default is one every 30 minutes"),
        ] {
            if r > limit && now > limit {
                out.add(n, kind, "notice", format!("Sends {r:.1} {what} per hour"), format!("More often than needed ({default}); each one is flooded through the mesh."));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::health::tests::{node_issues, role_node};
    use crate::row::{Interner, JRow, Row};

    /// Node 5's position report `k` at minute `m`.
    fn position(i: &mut Interner, k: i64, m: i64) -> Row {
        let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":9,"s":5,"y":"position","l":"{k:016x}","o":"{k:016x}","sg":"unsigned"}}"#, m * 60_000);
        serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
    }

    #[test]
    fn a_rate_brought_down_in_the_window_is_not_flagged() {
        let mut i = Interner::default();
        let x = role_node(5, "CLIENT");
        // Every 5 minutes for a day: 6 an hour over the 48 h window.
        let mut rows: Vec<Row> = (0..288).map(|k| position(&mut i, k, k * 5)).collect();
        let got = node_issues(&rows, std::slice::from_ref(&x), &i);
        assert!(got.iter().any(|y| y.kind == "chatty_position"), "{got:?}");
        // Then hourly for 8 hours: its rate now is one an hour.
        rows.extend((0..8).map(|k| position(&mut i, 1000 + k, 1440 + 60 * (k + 1))));
        let got = node_issues(&rows, std::slice::from_ref(&x), &i);
        assert!(got.iter().all(|y| y.kind != "chatty_position"), "{got:?}");
        // Slowed only for the last two: too soon to tell, still flagged.
        rows.truncate(290);
        assert!(node_issues(&rows, &[x], &i).iter().any(|y| y.kind == "chatty_position"));
    }
}
