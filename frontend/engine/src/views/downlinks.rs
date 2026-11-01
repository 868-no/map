//! Probable MQTT downlinks from traceroute hop SNRs (D-054).

use serde::Serialize;

use crate::graph::traceroute_samples;
use crate::row::{ty, Row};
use crate::util::{map, set, FxMap, FxSet};

/// Evidence that a node takes packets from an MQTT broker (downlink) and
/// transmits them: traceroutes record the SNR each hop received at, and a
/// packet that arrived from MQTT has no radio reception, so it is recorded
/// at exactly 0 dB. Genuine readings round to 0 dB too, on 1-11% of a node's
/// traceroutes in the 2026-11 data; downlinking gateways sat at 52-79% (D-054).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Downlink {
    pub zero_snr: usize,    // traceroutes that reached the node at exactly 0 dB
    pub traceroutes: usize, // traceroutes recording an SNR at the node
}

pub const DOWNLINK_MIN: usize = 3;
pub const DOWNLINK_SHARE: f64 = 0.25;

/// Probable MQTT downlink per node, from in-window traceroute hop SNRs
/// (distinct traceroute packets, so many gateways uplinking one count once).
pub fn downlinks(rows: &[&Row]) -> FxMap<u32, Downlink> {
    let mut per: FxMap<u32, (FxSet<u64>, FxSet<u64>)> = map();
    let mut hops = Vec::new();
    for r in rows {
        if r.ty != ty::TRACEROUTE {
            continue;
        }
        let Some(t) = r.traceroute().filter(|t| t.valid) else { continue };
        hops.clear();
        traceroute_samples(r.src, r.dst.unwrap_or(0), t.is_reply, &t.route, &t.snr_towards, &t.route_back, &t.snr_back, r.t, r.lp, &mut hops);
        for h in &hops {
            let Some(snr) = h.snr.filter(|_| h.dst != 0) else { continue };
            let e = per.entry(h.dst).or_insert_with(|| (set(), set()));
            if snr == 0.0 { e.0.insert(r.lp) } else { e.1.insert(r.lp) };
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
    use crate::views::test_rows::pos;

    /// A traceroute request 1 -> 2 -> 3 (destination 9), with the SNR each hop received at.
    fn trace(id: i64, snr: [f64; 2]) -> Row {
        use crate::row::{Detail, Hop, Traceroute};
        let route = vec![Hop { id: 2, unknown: false }, Hop { id: 3, unknown: false }];
        let detail = Detail::Traceroute(Traceroute { valid: true, is_reply: false, route, snr_towards: snr.iter().map(|&v| Some(v)).collect(), route_back: vec![], snr_back: vec![] });
        Row { ty: ty::TRACEROUTE, dst: Some(9), pos: None, detail: Some(Box::new(detail)), ..pos(id, 0, 0.0, 0, 0) }
    }

    #[test]
    fn downlink_needs_several_traceroutes_at_exactly_zero_db() {
        // Node 3 is reached at 0 dB in 3 of 4 traceroutes: downlinking. Node 2 never.
        let rows = [trace(1, [5.0, 0.0]), trace(2, [6.0, 0.0]), trace(3, [4.0, 0.0]), trace(4, [5.0, -3.0])];
        let refs: Vec<&Row> = rows.iter().collect();
        let d = downlinks(&refs);
        assert_eq!(d.get(&3), Some(&Downlink { zero_snr: 3, traceroutes: 4 }));
        assert!(!d.contains_key(&2));
        // Copies of one traceroute (several gateways) count once.
        let dup = [trace(1, [5.0, 0.0]), trace(1, [5.0, 0.0]), trace(1, [5.0, 0.0])];
        assert!(downlinks(&dup.iter().collect::<Vec<_>>()).is_empty());
        // A genuine 0 dB now and then is not enough: 3 of 13 is under a quarter.
        let mut many: Vec<Row> = (1..=10).map(|k| trace(k, [5.0, -2.0])).collect();
        many.extend((11..=13).map(|k| trace(k, [5.0, 0.0])));
        assert!(downlinks(&many.iter().collect::<Vec<_>>()).is_empty());
    }
}
