//! Probable MQTT downlinks from traceroute hop SNRs (D-054).

use serde::Serialize;

use super::TracerouteHops;
use crate::row::Row;
use crate::util::{map, FxMap};

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
    /// When it last looked downlinked, if the traceroutes since show it no
    /// longer does (D-226): downlink switched off within the window.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub stopped: Option<String>,
}

pub const DOWNLINK_MIN: usize = 3;
pub const DOWNLINK_SHARE: f64 = 0.25;
/// Downlink switched off (D-226): at least this many traceroutes after the
/// last that looked downlinked, of which at most `DOWNLINK_STOPPED_SHARE`
/// reached it at exactly 0 dB (genuine readings round to 0 dB on 1-11 %).
pub const DOWNLINK_STOPPED_MIN: usize = 10;
pub const DOWNLINK_STOPPED_SHARE: f64 = 0.1;

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
    // Per node, each traceroute once: when it was first heard, and whether
    // any copy recorded the node at exactly 0 dB.
    type Traces = FxMap<(u32, u32, u64), (i64, bool)>;
    let mut per: FxMap<u32, Traces> = map();
    let mut start = 0;
    for &(k, end) in &hops.ends {
        let (r, copy) = (rows[k], &hops.samples[start..end]);
        start = end;
        let Some(t) = r.traceroute() else { continue };
        let key = traceroute_key(r, t.is_reply, t.request);
        for h in copy {
            let Some(snr) = h.snr.filter(|_| h.dst != 0) else { continue };
            let e = per.entry(h.dst).or_default().entry(key).or_insert((r.t, false));
            e.0 = e.0.min(r.t);
            e.1 |= snr == 0.0;
        }
    }
    per.into_iter()
        .filter_map(|(n, traces)| {
            let mut v: Vec<(i64, bool)> = traces.into_values().collect();
            v.sort_unstable();
            let looks = |zero: usize, all: usize| zero >= DOWNLINK_MIN && zero as f64 >= DOWNLINK_SHARE * all as f64;
            let zero = v.iter().filter(|x| x.1).count();
            looks(zero, v.len()).then(|| (n, Downlink { zero_snr: zero, traceroutes: v.len(), stopped: stopped(&v, looks) }))
        })
        .collect()
}

/// When a downlinker stopped (D-226): the latest split of its traceroutes
/// (time order) where those before still look downlinked and the at least
/// `DOWNLINK_STOPPED_MIN` after look like radio, at most
/// `DOWNLINK_STOPPED_SHARE` at 0 dB; the time of the last 0 dB reading
/// before it. Off and on again ends with it downlinking: not stopped.
fn stopped(v: &[(i64, bool)], looks: impl Fn(usize, usize) -> bool) -> Option<String> {
    let mut after = v.iter().filter(|x| x.1).count();
    let mut before = 0;
    let mut found = None;
    for (s, x) in v.iter().enumerate() {
        let rest = v.len() - s;
        if rest < DOWNLINK_STOPPED_MIN {
            break;
        }
        if looks(before, s) && after as f64 <= DOWNLINK_STOPPED_SHARE * rest as f64 {
            found = v[..s].iter().rev().find(|y| y.1).map(|y| y.0);
        }
        if x.1 {
            before += 1;
            after -= 1;
        }
    }
    found.map(crate::util::iso)
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
        assert_eq!(d.get(&3), Some(&Downlink { zero_snr: 3, traceroutes: 4, stopped: None }));
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
        assert_eq!(downlinks_of(&rows).get(&3), Some(&Downlink { zero_snr: 10, traceroutes: 14, stopped: None }));
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
        assert_eq!(downlinks_of(&rows).get(&3), Some(&Downlink { zero_snr: 3, traceroutes: 3, stopped: None }));
    }

    #[test]
    fn a_downlink_switched_off_in_the_window_is_stopped() {
        // Five traceroutes at 0 dB, then ten at radio readings (one a
        // genuine 0 dB): stopped at the last of the five.
        let at = |k: i64, snr: f64| Row { t: k * 60_000, ..trace(k, [5.0, snr]) };
        let mut rows: Vec<Row> = (1..=5).map(|k| at(k, 0.0)).collect();
        rows.extend((6..=15).map(|k| at(k, if k == 9 { 0.0 } else { -4.0 })));
        let d = downlinks_of(&rows).remove(&3).expect("still a downlinker for the links");
        assert_eq!(d.stopped, Some(crate::util::iso(5 * 60_000)));
        // Too few radio readings since to tell.
        assert_eq!(downlinks_of(&rows[..12]).remove(&3).and_then(|d| d.stopped), None);
        // On again at the end: not stopped.
        rows.extend((16..=19).map(|k| at(k, 0.0)));
        assert_eq!(downlinks_of(&rows).remove(&3).and_then(|d| d.stopped), None);
    }
}
