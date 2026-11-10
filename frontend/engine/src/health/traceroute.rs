//! Traceroute flooding: frequent automated traceroutes, each flooded
//! through the mesh and answered.

use super::{Ctx, Issues};
use crate::row::ty;
use crate::util::FxMap;

/// Traceroute requests per hour from one node that count as flooding the
/// mesh (warning), and as a problem. Each request is flooded and answered.
pub const TRACEROUTE_WARN_PER_H: f64 = 4.0;
pub const TRACEROUTE_PROBLEM_PER_H: f64 = 10.0;
/// Fewest requests before the traceroute rule applies (short windows).
pub const TRACEROUTE_MIN: usize = 10;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let hours = cx.hours;
    let traceroutes: FxMap<u32, usize> = cx.own.keys().map(|&n| (n, cx.count(n, ty::TRACEROUTE, |r| r.traceroute().is_some_and(|t| !t.is_reply)))).filter(|&(_, c)| c > 0).collect();
    let mut rates: Vec<f64> = traceroutes.values().map(|&c| c as f64 / hours).collect();
    rates.sort_unstable_by(f64::total_cmp);
    let median = rates.get(rates.len() / 2).copied().unwrap_or(0.0);
    for (&n, &c) in &traceroutes {
        let rate = c as f64 / hours;
        if c >= TRACEROUTE_MIN && rate >= TRACEROUTE_WARN_PER_H {
            let sev = if rate >= TRACEROUTE_PROBLEM_PER_H { "problem" } else { "warning" };
            out.add(n, "traceroute_flood", sev, format!("Sends {rate:.1} traceroutes per hour"), format!("{c} traceroute requests in the window; the median among nodes sending any is {median:.1} per hour. Every request floods the mesh and is answered, so frequent automated traceroutes cost everyone airtime."));
        }
    }
}
