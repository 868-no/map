//! Batteries: a low battery in the last device telemetry, and a fixed
//! node's battery falling fast over the window's reports (D-099).

use super::{device_telemetry, role_of, Ctx, Issues};
use crate::roles;
use crate::util::FxSet;

/// Battery (%) that counts as low (101 is external power).
pub const BATTERY_LOW: f64 = 15.0;
/// Battery trend (D-099): a least-squares slope over its reports, at least
/// this many over at least a day; falling this fast (% per day) is flagged,
/// as a warning when it is at most BATTERY_WARN_AT or empty within a week.
pub const BATTERY_TREND_MIN_REPORTS: usize = 8;
pub const BATTERY_FALL_PER_DAY: f64 = 5.0;
pub const BATTERY_WARN_AT: f64 = 50.0;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    for x in cx.nodes {
        if let Some(b) = x.telemetry.as_ref().and_then(|t| t.battery).filter(|&b| b <= BATTERY_LOW) {
            out.add(x.num, "battery_low", "notice", format!("Battery {b:.0} %"), "Its last device telemetry reports a low battery.".into());
        }
    }
    // Only for routers and base stations: a handheld or tracker drains and
    // is charged as it is used.
    let fixed: FxSet<u32> = cx.nodes.iter().filter(|x| roles::is_fixed(role_of(x))).map(|x| x.num).collect();
    for (&n, pk) in &cx.own {
        if !fixed.contains(&n) {
            continue;
        }
        let tel = device_telemetry(pk);
        let batt: Vec<(f64, f64)> = tel.iter().filter_map(|(t, x)| x.battery.filter(|&b| b <= 100.0).map(|b| (*t as f64 / 86_400_000.0, b))).collect();
        if batt.len() < BATTERY_TREND_MIN_REPORTS || batt[batt.len() - 1].0 - batt[0].0 < 1.0 {
            continue;
        }
        let k = batt.len() as f64;
        let (mx, my) = (batt.iter().map(|p| p.0).sum::<f64>() / k, batt.iter().map(|p| p.1).sum::<f64>() / k);
        let var: f64 = batt.iter().map(|p| (p.0 - mx).powi(2)).sum();
        let slope = if var > 0.0 { batt.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>() / var } else { 0.0 };
        let now = batt[batt.len() - 1].1;
        if slope <= -BATTERY_FALL_PER_DAY {
            let days = now / -slope;
            let sev = if now <= BATTERY_WARN_AT || days <= 7.0 { "warning" } else { "notice" };
            out.add(n, "battery_falling", sev, format!("Battery falling about {:.0} % a day", -slope), format!("Its battery went from about {:.0} % to {now:.0} % over {:.1} days ({} reports): at this rate it is empty {}. A solar node that does not recover overnight, or a failing battery.", batt[0].1, batt[batt.len() - 1].0 - batt[0].0, batt.len(), if days < 1.5 { "within a day".to_string() } else { format!("in about {days:.0} days") }));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::health::tests::{node_issues, telemetry};
    use crate::row::{Interner, Row};

    /// The telemetry helper's sender (node 5) with `role`.
    fn node(role: &str) -> crate::views::Node {
        let mut x = crate::views::Node::new(5);
        x.identity = Some(crate::views::Identity { role: role.into(), ..Default::default() });
        x
    }

    #[test]
    fn a_fixed_nodes_battery_falling_fast_is_flagged_and_a_steady_one_is_not() {
        let mut i = Interner::default();
        // 12 reports over 33 h, 80 % down to 36 %: 32 % a day.
        let falling: Vec<Row> = (0..12).map(|k| telemetry(&mut i, k, 80.0 - 4.0 * k as f64, 1000 + k as u32 * 10_800)).collect();
        for role in ["ROUTER", "ROUTER_LATE", "CLIENT_BASE"] {
            let got = node_issues(&falling, &[node(role)], &i);
            let b = got.iter().find(|x| x.kind == "battery_falling").unwrap_or_else(|| panic!("{role} flagged"));
            assert_eq!(b.severity, "warning");
        }
        // Swinging around a level, as a solar node does, is not.
        let steady: Vec<Row> = (0..12).map(|k| telemetry(&mut i, k, if k % 2 == 0 { 90.0 } else { 70.0 }, 1000 + k as u32 * 10_800)).collect();
        assert!(node_issues(&steady, &[node("ROUTER")], &i).iter().all(|x| x.kind != "battery_falling"));
    }

    #[test]
    fn other_roles_and_unknown_nodes_are_not_flagged_for_a_falling_battery() {
        let mut i = Interner::default();
        let falling: Vec<Row> = (0..12).map(|k| telemetry(&mut i, k, 80.0 - 4.0 * k as f64, 1000 + k as u32 * 10_800)).collect();
        for role in ["CLIENT", "CLIENT_MUTE", "TRACKER", "ROUTER_CLIENT", "REPEATER", ""] {
            assert!(node_issues(&falling, &[node(role)], &i).iter().all(|x| x.kind != "battery_falling"), "{role:?}");
        }
        assert!(node_issues(&falling, &[], &i).iter().all(|x| x.kind != "battery_falling"), "no node");
    }
}
