//! Watched nodes (D-192): the few facts the watchlist shows for each node a
//! viewer keeps an eye on, in one view: when it was last heard, whether it
//! has gone quiet for longer than its own rhythm, its last battery, and how
//! many gateways heard it. The list lives in the browser; nothing is stored.

use serde::Serialize;

use crate::health::{gone_quiet, heard_times, usual_gap};
use crate::row::Row;
use crate::util::{iso, map, node_id, FxMap, FxSet};
use crate::views::Node;

/// A watched node counts as quiet once nothing was heard from it for this
/// long and health::SILENT_GAP_FACTOR times its usual gap, before the newest data
/// (health::gone_quiet, as the silent-infrastructure rule, D-188).
pub const QUIET_MIN_MS: i64 = 3_600_000;
/// Events (a minute or more apart) needed to know its usual gap.
pub const QUIET_MIN_EVENTS: usize = 4;

#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Watched {
    pub id: String,
    /// observed, referenced (only named by others) or absent (not in the window).
    #[cfg_attr(test, ts(type = "'observed' | 'referenced' | 'absent'"))]
    pub status: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub long_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub short_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub last_seen: Option<String>,
    /// Time from it was last heard to the newest data in the window (ms).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub quiet_ms: Option<i64>,
    /// Its median gap between transmissions or uplinks (ms), when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub usual_gap_ms: Option<i64>,
    /// Quiet for much longer than usual (see QUIET_MIN_MS).
    pub quiet: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub battery: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub voltage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub telemetry_at: Option<String>,
    pub packets: usize,
    /// Distinct gateways that got its packets.
    pub gateways: usize,
    pub is_gateway: bool,
}

/// The watched nodes, in the order asked for. `rows`: the window's rows
/// passing the filters (gateways that got its packets); `live`: all its
/// valid rows, unfiltered, for when it was heard and whether it went quiet,
/// which a filter must not change (D-192). `nodes`: the build's nodes (the
/// snapshot's and those past its limit).
pub fn watch<'a>(ids: &[u32], rows: &[&Row], live: &[&Row], nodes: impl Iterator<Item = &'a Node>) -> Vec<Watched> {
    let want: FxSet<u32> = ids.iter().copied().collect();
    let by: FxMap<u32, &Node> = nodes.filter(|n| want.contains(&n.num)).map(|n| (n.num, n)).collect();
    let hi = live.iter().map(|r| r.t).max().unwrap_or(0);
    let mut heard = heard_times(live, |n| want.contains(&n));
    let mut gws: FxMap<u32, FxSet<u32>> = map();
    for r in rows {
        if let Some(g) = r.gw.filter(|_| want.contains(&r.src)) {
            gws.entry(r.src).or_default().insert(g);
        }
    }
    ids.iter()
        .map(|&n| {
            let Some(x) = by.get(&n) else {
                return Watched { id: node_id(n), status: "absent", long_name: String::new(), short_name: String::new(), role: String::new(), last_seen: None, quiet_ms: None, usual_gap_ms: None, quiet: false, battery: None, voltage: None, telemetry_at: None, packets: 0, gateways: 0, is_gateway: false };
            };
            let ts = heard.remove(&n).unwrap_or_default();
            let usual = usual_gap(&ts, QUIET_MIN_EVENTS);
            let quiet_ms = ts.last().map(|&last| hi - last);
            let quiet = matches!((quiet_ms, usual), (Some(q), Some(u)) if gone_quiet(q, u, QUIET_MIN_MS));
            let id = x.identity.as_ref();
            let t = x.telemetry.as_ref();
            Watched {
                id: x.id.clone(),
                status: x.status,
                long_name: id.map(|i| i.long_name.clone()).unwrap_or_default(),
                short_name: id.map(|i| i.short_name.clone()).unwrap_or_default(),
                role: id.map(|i| i.role.clone()).unwrap_or_default(),
                last_seen: ts.last().map(|&l| iso(l)).or_else(|| x.last_seen.clone()),
                quiet_ms,
                usual_gap_ms: usual,
                quiet,
                battery: t.and_then(|t| t.battery),
                voltage: t.and_then(|t| t.voltage),
                telemetry_at: t.map(|t| t.observed_at.clone()),
                packets: x.packets,
                gateways: gws.get(&n).map_or(0, FxSet::len),
                is_gateway: x.is_gateway,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::{Interner, JRow};

    fn sent(i: &mut Interner, k: u64, src: u32, gw: u32, t: i64) -> Row {
        let text = format!(r#"{{"i":{k},"t":{t},"b":"x","g":{gw},"s":{src},"y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned"}}"#);
        serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
    }

    #[test]
    fn watched_nodes_report_when_they_went_quiet() {
        let mut i = Interner::default();
        let m = 60_000;
        // Node 1: every 10 minutes for 2 h, then nothing for 3 h (node 2 carries on).
        let mut rows: Vec<Row> = (0..12).map(|k| sent(&mut i, k, 1, if k % 2 == 0 { 8 } else { 9 }, k as i64 * 10 * m)).collect();
        rows.extend((0..30).map(|k| sent(&mut i, 100 + k, 2, 8, k as i64 * 10 * m)));
        let refs: Vec<&Row> = rows.iter().collect();
        let nodes = [Node::new(1), Node::new(2)];
        let got = watch(&[1, 2, 3], &refs, &refs, nodes.iter());
        assert_eq!(got.iter().map(|w| (w.id.as_str(), w.status, w.quiet)).collect::<Vec<_>>(), [("!00000001", "observed", true), ("!00000002", "observed", false), ("!00000003", "absent", false)]);
        assert_eq!((got[0].usual_gap_ms, got[0].quiet_ms, got[0].gateways), (Some(10 * m), Some(180 * m), 2));
    }

    #[test]
    fn filters_do_not_make_a_watched_node_quiet() {
        let mut i = Interner::default();
        let m = 60_000;
        // Every 10 minutes for 5 h; the filters keep only its first 2 h.
        let rows: Vec<Row> = (0..30).map(|k| sent(&mut i, k, 1, 8, k as i64 * 10 * m)).collect();
        let live: Vec<&Row> = rows.iter().collect();
        let filtered: Vec<&Row> = rows.iter().take(12).collect();
        let got = watch(&[1], &filtered, &live, [Node::new(1)].iter());
        assert_eq!((got[0].quiet, got[0].quiet_ms), (false, Some(0)));
    }
}
