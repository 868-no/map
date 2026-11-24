//! When a node counts as online (D-230): heard within twice its own cadence
//! of NodeInfo and position packets before the window's end, and never less
//! than ONLINE_MIN_MS nor more than ONLINE_MAX_MS. A fixed 3 h flagged nodes
//! sending only NodeInfo (every 3 h by default) offline for minutes of every
//! cycle; over 51 days of the community mesh, 56 % of all 3 h silences ended
//! within the next 15 minutes.

use crate::health::{usual_gap, EVENT_MS};
use crate::row::{ty, Row};
use crate::util::{map, FxMap};
use crate::views::{first_per_packet, Node};

/// Never offline sooner than this after it was last heard, however often it
/// announces itself: lost packets make a short cadence's silences uneven.
pub const ONLINE_MIN_MS: i64 = 4 * 3_600_000;
/// Always offline once silent this long, however rarely it announces itself.
pub const ONLINE_MAX_MS: i64 = 24 * 3_600_000;
/// Silent for this many of its usual gaps: offline.
pub const ONLINE_CADENCE_FACTOR: i64 = 2;
/// NodeInfo and position events (a minute or more apart) needed to know its cadence.
pub const ONLINE_MIN_EVENTS: usize = 4;

/// Each node's cadence: the median gap between the NodeInfo and position
/// packets it sent (first copy each, merged within a minute), from at least
/// ONLINE_MIN_EVENTS of them. `rows`: the window's valid rows, unfiltered,
/// so a filter never changes whether a node is online.
pub fn cadences(rows: &[&Row]) -> FxMap<u32, i64> {
    let mut heard: FxMap<u32, Vec<i64>> = map();
    for r in first_per_packet(rows.iter().copied(), |r| r.ty == ty::NODEINFO || r.ty == ty::POSITION) {
        heard.entry(r.src).or_default().push(r.t);
    }
    heard
        .into_iter()
        .filter_map(|(n, mut ts)| {
            ts.sort_unstable();
            ts.dedup_by(|b, a| *b - *a < EVENT_MS);
            usual_gap(&ts, ONLINE_MIN_EVENTS).map(|g| (n, g))
        })
        .collect()
}

/// Sets each heard node's cadence and offline_after_ms from `rows` (see
/// cadences); nodes only named by others get neither.
pub fn set_offline_after<'a>(nodes: impl Iterator<Item = &'a mut Node>, rows: &[&Row]) {
    let c = cadences(rows);
    for x in nodes.filter(|x| x.status == "observed") {
        x.cadence_ms = c.get(&x.num).copied();
        x.offline_after_ms = Some(offline_after(x.cadence_ms));
    }
}

/// How long after it was last heard a node with this cadence counts as
/// offline; ONLINE_MIN_MS when its cadence is unknown.
pub fn offline_after(cadence: Option<i64>) -> i64 {
    cadence.map_or(ONLINE_MIN_MS, |c| (ONLINE_CADENCE_FACTOR * c).clamp(ONLINE_MIN_MS, ONLINE_MAX_MS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::{Interner, JRow};

    const M: i64 = 60_000;
    const H: i64 = 60 * M;

    fn sent(i: &mut Interner, k: u64, src: u32, y: &str, t: i64) -> Row {
        let text = format!(r#"{{"i":{k},"t":{t},"b":"x","g":9,"s":{src},"y":"{y}","l":"{k:016x}","o":"{k:016x}","sg":"unsigned"}}"#);
        serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
    }

    #[test]
    fn cadence_is_the_median_gap_of_nodeinfo_and_positions() {
        let mut i = Interner::default();
        let mut rows = Vec::new();
        // Node 1: NodeInfo every 3 h, with a text in between that does not count.
        rows.extend((0..6).map(|k| sent(&mut i, k, 1, "nodeinfo", k as i64 * 3 * H)));
        rows.push(sent(&mut i, 50, 1, "text", 90 * M));
        // Node 2: positions every 15 minutes, NodeInfo every 3 h.
        rows.extend((0..24).map(|k| sent(&mut i, 100 + k, 2, "position", k as i64 * 15 * M)));
        rows.extend((0..2).map(|k| sent(&mut i, 200 + k, 2, "nodeinfo", 7 * M + k as i64 * 3 * H)));
        // Node 3: three NodeInfo only, too few to tell.
        rows.extend((0..3).map(|k| sent(&mut i, 300 + k, 3, "nodeinfo", k as i64 * 3 * H)));
        // Node 4: telemetry only.
        rows.extend((0..10).map(|k| sent(&mut i, 400 + k, 4, "telemetry", k as i64 * 30 * M)));
        let refs: Vec<&Row> = rows.iter().collect();
        let c = cadences(&refs);
        assert_eq!((c.get(&1), c.get(&3), c.get(&4)), (Some(&(3 * H)), None, None));
        assert!(c[&2] <= 15 * M);
    }

    #[test]
    fn copies_and_bursts_are_one_event() {
        let mut i = Interner::default();
        let mut rows = Vec::new();
        for k in 0..5 {
            let t = k as i64 * 6 * H;
            rows.push(sent(&mut i, k, 1, "nodeinfo", t));
            rows.push(sent(&mut i, k, 1, "nodeinfo", t + 5_000)); // another gateway's copy
            rows.push(sent(&mut i, 100 + k, 1, "position", t + 20_000)); // sent with it
        }
        let refs: Vec<&Row> = rows.iter().collect();
        assert_eq!(cadences(&refs)[&1], 6 * H);
    }

    #[test]
    fn offline_after_twice_the_cadence_within_bounds() {
        assert_eq!(offline_after(None), ONLINE_MIN_MS);
        assert_eq!(offline_after(Some(15 * M)), ONLINE_MIN_MS);
        assert_eq!(offline_after(Some(3 * H)), 6 * H);
        assert_eq!(offline_after(Some(12 * H)), ONLINE_MAX_MS);
        assert_eq!(offline_after(Some(48 * H)), ONLINE_MAX_MS);
    }
}
