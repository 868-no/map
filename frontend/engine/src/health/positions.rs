//! Positions: a stale position report, and one its reception contradicts.

use super::{Ctx, Issues};

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    for x in cx.nodes {
        let n = x.num;
        if let Some(p) = &x.stale_position {
            out.add(n, "stale_position", "notice", "Position report is stale".into(), format!("Its last position report is from {}, more than a day before the newest data (a week for a router, base station or node that has stayed in one place). {}", p.observed_at, if x.estimate.is_some() { "It is estimated instead." } else { "It is left off the map." }));
        }
        if let Some(p) = &x.rejected_position {
            let km = |m: f64| if m >= 10_000.0 { format!("{:.0} km", m / 1000.0) } else { format!("{:.1} km", m / 1000.0) };
            out.add(n, "position_contradicted", "warning", "Reported position contradicts its reception".into(), format!("Its position report of {} puts it at {:.4}, {:.4}, {} from gateway {}, which heard it directly at {} dBm: from no farther than {}. The report is ignored{}. A fixed position typed in wrong (latitude and longitude swapped or repeated) does this.", p.position.observed_at, p.position.lat, p.position.lon, km(p.distance_m), p.gateway, p.rssi, km(p.bound_m), if x.position.is_some() { ", and an earlier one is used" } else if x.estimate.is_some() { ", and it is estimated instead" } else { "" }));
        }
    }
}
