//! Probable MQTT downlinks from traceroute hop SNRs (D-054).

use serde::Serialize;

use super::TracerouteHops;
use crate::row::Row;
use crate::util::{map, set, FxMap, FxSet};

/// Evidence that a node takes packets from an MQTT broker (downlink) and
/// transmits them: traceroutes record the SNR each hop received at, and a
/// packet that arrived from MQTT has no radio reception, so it is recorded
/// at exactly 0 dB. Genuine readings round to 0 dB too, on 1-11% of a node's
/// traceroutes in the 2026-11 data; downlinking gateways sat at 52-79% (D-054).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Downlink {
    pub zero_snr: usize,    // traceroutes that reached the node at exactly 0 dB
    pub traceroutes: usize, // traceroutes recording an SNR at the node
}

pub const DOWNLINK_MIN: usize = 3;
pub const DOWNLINK_SHARE: f64 = 0.25;

/// Which traceroute a row belongs to: (requester, request id), so a
/// request, its reply and every gateway's copy of either count once, while
/// identical traceroutes repeated later count each time. Hop sample keys
/// cannot tell those apart: they key RF hops by path and SNRs (D-087).
fn traceroute_key(r: &Row, is_reply: bool, request: u32) -> (u32, u32, u64) {
    match (is_reply, r.dst, r.pid) {
        (true, Some(to), _) if request != 0 => (to, request, 0),
        (false, _, Some(pid)) => (r.src, pid, 0),
        // No ids to pair it by: the packet alone.
        _ => (0, 0, r.lp),
    }
}

/// Probable MQTT downlink per node, from the hop SNRs of the window's
/// traceroutes (`rows`: callers may pass just those, views::ByType; `hops`:
/// traceroute_hops of them).
pub fn downlinks(rows: &[&Row], hops: &TracerouteHops) -> FxMap<u32, Downlink> {
    type Traces = FxSet<(u32, u32, u64)>;
    let mut per: FxMap<u32, (Traces, Traces)> = map();
    let mut start = 0;
    for &(k, end) in &hops.ends {
        let (r, copy) = (rows[k], &hops.samples[start..end]);
        start = end;
        let Some(t) = r.traceroute() else { continue };
        let key = traceroute_key(r, t.is_reply, t.request);
        for h in copy {
            let Some(snr) = h.snr.filter(|_| h.dst != 0) else { continue };
            let e = per.entry(h.dst).or_insert_with(|| (set(), set()));
            if snr == 0.0 { e.0.insert(key) } else { e.1.insert(key) };
        }
    }
    per.into_iter()
        .filter_map(|(n, (zero, other))| {
            let d = Downlink { zero_snr: zero.len(), traceroutes: zero.union(&other).count() };
            (d.zero_snr >= DOWNLINK_MIN && d.zero_snr as f64 >= DOWNLINK_SHARE * d.traceroutes as f64).then_some((n, d))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::ty;
    use crate::views::test_rows::pos;

    fn downlinks_of(rows: &[Row]) -> FxMap<u32, Downlink> {
        let rows: Vec<&Row> = rows.iter().collect();
        downlinks(&rows, &crate::views::traceroute_hops(&rows))
    }

    /// A traceroute request 1 -> 2 -> 3 (destination 9), with the SNR each hop received at.
    fn trace(id: i64, snr: [f64; 2]) -> Row {
        use crate::row::{Detail, Hop, Traceroute};
        let route = vec![Hop { id: 2, unknown: false }, Hop { id: 3, unknown: false }];
        let detail = Detail::Traceroute(Traceroute { valid: true, is_reply: false, route, snr_towards: snr.iter().map(|&v| Some(v)).collect(), route_back: vec![], snr_back: vec![], request: 0 });
        Row { ty: ty::TRACEROUTE, dst: Some(9), pid: Some(id as u32), pos: None, detail: Some(Box::new(detail)), ..pos(id, 0, 0.0, 0, 0) }
    }

    #[test]
    fn downlink_needs_several_traceroutes_at_exactly_zero_db() {
        // Node 3 is reached at 0 dB in 3 of 4 traceroutes: downlinking. Node 2 never.
        let rows = [trace(1, [5.0, 0.0]), trace(2, [6.0, 0.0]), trace(3, [4.0, 0.0]), trace(4, [5.0, -3.0])];
        let d = downlinks_of(&rows);
        assert_eq!(d.get(&3), Some(&Downlink { zero_snr: 3, traceroutes: 4 }));
        assert!(!d.contains_key(&2));
        // Copies of one traceroute (several gateways) count once.
        let dup = [trace(1, [5.0, 0.0]), trace(1, [5.0, 0.0]), trace(1, [5.0, 0.0])];
        assert!(downlinks_of(&dup).is_empty());
        // A genuine 0 dB now and then is not enough: 3 of 13 is under a quarter.
        let mut many: Vec<Row> = (1..=10).map(|k| trace(k, [5.0, -2.0])).collect();
        many.extend((11..=13).map(|k| trace(k, [5.0, 0.0])));
        assert!(downlinks_of(&many).is_empty());
    }

    #[test]
    fn identical_traceroutes_each_count() {
        // Ten traceroutes along the same route, all reaching 3 at exactly
        // 0 dB, share every hop key; each is still a traceroute of its own.
        let mut rows: Vec<Row> = (1..=10).map(|k| trace(k, [5.0, 0.0])).collect();
        rows.extend([(11, -1.0), (12, -2.0), (13, 3.5), (14, 1.25)].map(|(k, snr)| trace(k, [5.0, snr])));
        assert_eq!(downlinks_of(&rows).get(&3), Some(&Downlink { zero_snr: 10, traceroutes: 14 }));
    }

    #[test]
    fn a_reply_counts_with_its_request() {
        use crate::row::{Detail, Hop, Traceroute};
        // Requests 1-3 from node 1 (pids 1-3); 9's replies repeat their
        // forward SNRs: still three traceroutes, not six.
        let reply = |id: i64, request: u32| {
            let route = vec![Hop { id: 2, unknown: false }, Hop { id: 3, unknown: false }];
            let detail = Detail::Traceroute(Traceroute { valid: true, is_reply: true, route, snr_towards: vec![Some(5.0), Some(0.0)], route_back: vec![], snr_back: vec![], request });
            Row { ty: ty::TRACEROUTE, src: 9, dst: Some(1), pid: Some(id as u32), pos: None, detail: Some(Box::new(detail)), ..pos(id, 0, 0.0, 0, 0) }
        };
        let rows = [trace(1, [5.0, 0.0]), trace(2, [5.0, 0.0]), trace(3, [5.0, 0.0]), reply(101, 1), reply(102, 2), reply(103, 3)];
        assert_eq!(downlinks_of(&rows).get(&3), Some(&Downlink { zero_snr: 3, traceroutes: 3 }));
    }
}
