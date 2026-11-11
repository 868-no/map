//! Restarts (D-099): a router's or base station's uptime going backwards
//! between device telemetry reports, beyond what the time between them
//! explains.

use super::{device_telemetry, Ctx, Issues};

/// Restarts (uptime going backwards between reports) before it is a warning.
pub const RESTARTS_WARN: usize = 3;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let fixed = cx.fixed();
    for (&n, pk) in &cx.own {
        if !fixed.contains(&n) {
            continue;
        }
        let tel = device_telemetry(pk);
        let mut restarts: Vec<i64> = Vec::new();
        let mut prev: Option<(i64, u32)> = None;
        for (t, x) in &tel {
            let Some(u) = x.uptime else { continue };
            if let Some((pt, pu)) = prev {
                // Uptime went backwards, beyond what the time between reports explains.
                if u < pu && u as i64 * 1000 < t - pt {
                    restarts.push(t - u as i64 * 1000);
                }
            }
            prev = Some((*t, u));
        }
        if let Some(&last) = restarts.last() {
            let sev = if restarts.len() >= RESTARTS_WARN { "warning" } else { "notice" };
            let times = if restarts.len() == 1 { "once".to_string() } else { format!("{} times", restarts.len()) };
            out.add(n, "restarted", sev, format!("Restarted {times}"), format!("Its uptime went back to zero {times} in the window, last around {}. Repeated restarts point at power trouble (a weak battery or supply) or a crashing firmware.", crate::util::iso(last)));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::health::tests::{node_issues, role_node, telemetry};
    use crate::row::{Interner, Row};

    /// Uptime grows with each report, resets after report 5, grows again.
    fn restarting(i: &mut Interner) -> Vec<Row> {
        (0..10).map(|k| telemetry(i, k, 100.0, if k < 6 { 50_000 + k as u32 * 10_800 } else { 600 + (k as u32 - 6) * 10_800 })).collect()
    }

    #[test]
    fn uptime_going_back_counts_as_a_restart() {
        let mut i = Interner::default();
        let rows = restarting(&mut i);
        for role in ["ROUTER", "ROUTER_LATE", "CLIENT_BASE"] {
            let got = node_issues(&rows, &[role_node(5, role)], &i);
            let r = got.iter().find(|x| x.kind == "restarted").unwrap_or_else(|| panic!("{role}: restart seen"));
            assert_eq!((r.severity, r.summary.as_str()), ("notice", "Restarted once"));
        }
        // A node reporting uptime 0 every time has not restarted.
        let zero: Vec<Row> = (0..10).map(|k| telemetry(&mut i, k, 100.0, 0)).collect();
        assert!(node_issues(&zero, &[role_node(5, "ROUTER")], &i).iter().all(|x| x.kind != "restarted"));
    }

    #[test]
    fn other_roles_and_unknown_nodes_are_not_flagged_for_restarts() {
        let mut i = Interner::default();
        let rows = restarting(&mut i);
        for role in ["CLIENT", "CLIENT_MUTE", "TRACKER", "ROUTER_CLIENT", "REPEATER", ""] {
            assert!(node_issues(&rows, &[role_node(5, role)], &i).iter().all(|x| x.kind != "restarted"), "{role:?}");
        }
        assert!(node_issues(&rows, &[], &i).iter().all(|x| x.kind != "restarted"), "no node");
    }
}
