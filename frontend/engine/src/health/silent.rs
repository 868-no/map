//! Silent infrastructure (D-188): routers and gateways heard in the
//! window that then went quiet for much longer than their usual rhythm,
//! from all its valid rows: filters choose what to look at, not whether
//! a node is alive. A node on the move (a car, a hike) comes and goes by
//! design. The watchlist (D-192) shares the rhythm helpers.

use super::{role_of, span_words, Ctx, Issue, Issues};
use crate::roles;
use crate::row::Row;
use crate::util::{map, node_id, FxMap, FxSet};
use crate::views::{first_per_packet, Node};

/// Silent infrastructure (D-188): a router or gateway counts as silent once
/// nothing was heard from it for SILENT_GAP_FACTOR times its usual gap
/// between transmissions or uplinks, and at least SILENT_MIN_MS, before the
/// newest data in the window; its usual gap needs SILENT_MIN_EVENTS of them.
pub const SILENT_MIN_MS: i64 = 3 * 3_600_000;
pub const SILENT_GAP_FACTOR: i64 = 4;
pub const SILENT_MIN_EVENTS: usize = 4;
/// Battery (%) that, last reported before a silence, suggests it ran flat.
pub const SILENT_BATTERY_LOW: f64 = 20.0;

/// Copies and bursts closer together than this are one event of a node's rhythm.
const EVENT_MS: i64 = 60_000;

/// A role as a word for the start of a sentence.
fn role_word(role: &str) -> &'static str {
    match role {
        "ROUTER" => "Router",
        "ROUTER_LATE" => "Router (late)",
        "ROUTER_CLIENT" => "Router/client",
        "REPEATER" => "Repeater",
        _ => "Node",
    }
}

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let nodes = cx.nodes;
    let newest = cx.newest;
    let is_infra = |x: &Node| roles::is_infra(role_of(x));
    let kept: FxSet<u32> = nodes.iter().filter(|x| (is_infra(x) || x.is_gateway) && x.moved_at.is_none()).map(|x| x.num).collect();
    let heard = heard_times(&cx.live, |n| kept.contains(&n));
    for x in nodes.iter().filter(|x| kept.contains(&x.num)) {
        let role = role_of(x);
        let infra = is_infra(x);
        let Some(ts) = heard.get(&x.num) else { continue };
        let Some(usual) = usual_gap(ts, SILENT_MIN_EVENTS) else { continue };
        let last = ts[ts.len() - 1];
        let silent = newest - last;
        if !gone_quiet(silent, usual, SILENT_MIN_MS) {
            continue;
        }
        let what = match (infra, x.is_gateway) {
            (true, true) => format!("{} and gateway", role_word(role)),
            (true, false) => role_word(role).to_string(),
            _ => "Gateway".to_string(),
        };
        let mut detail = format!("{what}, last heard {} ({} before the newest data in the window); it was usually heard every {}.", crate::util::iso(last), span_words(silent), span_words(usual.max(60_000)));
        if let Some(t) = &x.telemetry {
            let mut parts: Vec<String> = Vec::new();
            if let Some(b) = t.battery {
                parts.push(if b > 100.0 { "external power".into() } else { format!("battery {b:.0} %") });
            }
            if let Some(v) = t.voltage.filter(|&v| v > 0.0) {
                parts.push(format!("{v:.2} V"));
            }
            if let Some(u) = t.uptime {
                parts.push(format!("up {}", span_words(u as i64 * 1000)));
            }
            if !parts.is_empty() {
                detail.push_str(&format!(" Its last device telemetry ({}): {}.", t.observed_at, parts.join(", ")));
            }
            if t.battery.is_some_and(|b| b <= SILENT_BATTERY_LOW) {
                detail.push_str(" The battery was low then: it may have run flat.");
            }
        }
        detail.push_str(if x.is_gateway {
            " As a gateway it also stopped uplinking: its power, internet connection or broker login may be down."
        } else {
            " Gateways stopped hearing it: it may be off or out of power, or the gateways that heard it may be down themselves."
        });
        out.push(Issue { node: node_id(x.num), kind: "silent", severity: "warning", summary: format!("Silent for {}", span_words(silent)), detail, weight: silent as f64 });
    }
}

/// When each node `want` picks was heard, for the silence rules (D-188,
/// D-192): its own packets (first copy each: a late copy is not the node
/// speaking again) and its uplinks as a gateway, in time order, with events
/// less than a minute after the last kept one merged into it.
pub fn heard_times(rows: &[&Row], want: impl Fn(u32) -> bool) -> FxMap<u32, Vec<i64>> {
    let mut out: FxMap<u32, Vec<i64>> = map();
    for &r in rows {
        if let Some(g) = r.gw.filter(|&g| want(g)) {
            out.entry(g).or_default().push(r.t);
        }
    }
    for r in first_per_packet(rows.iter().copied(), |r| want(r.src)) {
        out.entry(r.src).or_default().push(r.t);
    }
    for ts in out.values_mut() {
        ts.sort_unstable();
        ts.dedup_by(|b, a| *b - *a < EVENT_MS);
    }
    out
}

/// A node's usual gap between events (heard_times): the median, from at
/// least `min_events` of them; None with fewer.
pub fn usual_gap(ts: &[i64], min_events: usize) -> Option<i64> {
    if ts.len() < min_events.max(2) {
        return None;
    }
    let mut gaps: Vec<i64> = ts.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_unstable();
    Some(gaps[gaps.len() / 2])
}

/// Quiet for `quiet` ms counts as gone quiet: SILENT_GAP_FACTOR times its
/// usual gap, and at least `min_ms`.
pub fn gone_quiet(quiet: i64, usual: i64, min_ms: i64) -> bool {
    quiet >= min_ms.max(SILENT_GAP_FACTOR * usual)
}

#[cfg(test)]
mod tests {
    use super::{gone_quiet, heard_times, usual_gap};
    use crate::channels::PresetIndex;
    use crate::copies::Copies;
    use crate::health::health;
    use crate::health::tests::{sender, H};
    use crate::row::{Interner, JRow, Row};
    use crate::views::link::LinkReadings;

    #[test]
    fn infrastructure_that_goes_quiet_for_long_is_listed_longest_first() {
        let mut i = Interner::default();
        let m = 60_000;
        // Heard every 30 minutes for a day; the rows run on to hour 48 (another node).
        let every = |from: i64, to: i64| (0..).map(move |k| from + k * 30 * m).take_while(move |&t| t <= to).collect::<Vec<_>>();
        let (a, ra) = sender(&mut i, 1, "ROUTER", &every(0, 24 * H)); // silent 24 h
        let (b, rb) = sender(&mut i, 2, "ROUTER_LATE", &every(0, 40 * H)); // silent 8 h
        let (c, rc) = sender(&mut i, 3, "ROUTER", &every(0, 47 * H)); // 1 h: not yet
        let (d, rd) = sender(&mut i, 4, "CLIENT", &every(0, 10 * H)); // a client: never listed
        let (mut e, re) = sender(&mut i, 5, "ROUTER", &every(0, 10 * H));
        e.moved_at = Some("2026-11-05T00:00:00Z".into()); // on the move: comes and goes
        let (f, rf) = sender(&mut i, 6, "CLIENT", &every(0, 48 * H));
        let rows: Vec<Row> = [ra, rb, rc, rd, re, rf].into_iter().flatten().collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let nodes = [a, b, c, d, e, f];
        let got = health(&refs, &refs, &nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        // Filters that leave out the window's later rows (a type, channel or
        // broker filter) change nothing: liveness comes from the whole window.
        let early: Vec<&Row> = refs.iter().copied().filter(|r| r.t <= 10 * H).collect();
        let filtered = health(&early, &refs, &nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        assert_eq!(filtered.iter().filter(|x| x.kind == "silent").count(), 2);
        let silent: Vec<(&str, &str)> = got.iter().filter(|x| x.kind == "silent").map(|x| (x.node.as_str(), x.summary.as_str())).collect();
        assert_eq!(silent, [("!00000001", "Silent for 24 h"), ("!00000002", "Silent for 8.0 h")]);
        assert!(got.iter().find(|x| x.node == "!00000001" && x.kind == "silent").unwrap().detail.contains("usually heard every 30 min"));
    }

    #[test]
    fn a_nodes_rhythm_counts_its_packets_once_and_its_uplinks() {
        let mut i = Interner::default();
        let m = 60_000;
        let row = |i: &mut Interner, k: u64, lp: u64, src: u32, gw: u32, t: i64| {
            let text = format!(r#"{{"i":{k},"t":{t},"b":"x","g":{gw},"s":{src},"y":"text","l":"{lp:016x}","o":"{lp:016x}","sg":"unsigned"}}"#);
            serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
        };
        // Node 1's packet at 0, a late copy of it at 30 min (not another
        // event), a second packet at 60 min; node 1 uplinks node 2's at 61
        // min (one event with the packet a minute before) and at 120 min.
        let rows = [row(&mut i, 1, 10, 1, 9, 0), row(&mut i, 2, 10, 1, 8, 30 * m), row(&mut i, 3, 11, 1, 9, 60 * m), row(&mut i, 4, 12, 2, 1, 60 * m + 30_000), row(&mut i, 5, 13, 2, 1, 120 * m)];
        let refs: Vec<&Row> = rows.iter().collect();
        let heard = heard_times(&refs, |n| n == 1);
        assert_eq!(heard.get(&1), Some(&vec![0, 60 * m, 120 * m]));
        assert!(!heard.contains_key(&2), "only the nodes asked for");
        assert_eq!(usual_gap(&heard[&1], 3), Some(60 * m));
        assert_eq!(usual_gap(&heard[&1], 4), None);
        assert!(gone_quiet(4 * 60 * m, 60 * m, 3 * 60 * m) && !gone_quiet(4 * 60 * m - 1, 60 * m, 3 * 60 * m));
    }
}
