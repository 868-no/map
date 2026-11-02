//! One link's evidence over time (D-105): every radio sample between two
//! nodes, per direction, for the link panel's history charts.

use serde::Serialize;

use crate::graph::{Ev, SKey, Sample};
use crate::util::{node_id, set, FxSet};

/// Most recent points kept per direction.
pub const MAX_LINK_POINTS: usize = 2000;

#[derive(Serialize, Debug, PartialEq)]
pub struct LinkPoint {
    /// Observed, Unix ms.
    pub t: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rssi: Option<f64>,
    pub ev: &'static str,
}

#[derive(Serialize, Debug)]
pub struct LinkHistory {
    pub a: String,
    pub b: String,
    /// a heard by b (a transmitted, b received), oldest first.
    pub ab: Vec<LinkPoint>,
    pub ba: Vec<LinkPoint>,
}

fn ev_name(e: Ev) -> &'static str {
    match e {
        Ev::Neighbor => "neighbor",
        Ev::Traceroute => "traceroute",
        Ev::DirectRf => "direct_rf",
        Ev::RelayHint => "relay_hint",
    }
}

/// The samples from `src` to `dst` that measured a signal, each RF event once
/// (as the link statistics count them).
fn direction(samples: &[Sample], src: u32, dst: u32) -> Vec<LinkPoint> {
    let mut seen: FxSet<(Ev, SKey)> = set();
    let mut out: Vec<LinkPoint> = samples
        .iter()
        .filter(|s| s.src == src && s.dst == dst && (s.snr.is_some() || s.rssi.is_some()))
        .filter(|s| s.key == SKey::None || seen.insert((s.ev, s.key)))
        .map(|s| LinkPoint { t: s.t, snr: s.snr, rssi: s.rssi, ev: ev_name(s.ev) })
        .collect();
    out.sort_by_key(|p| p.t);
    if out.len() > MAX_LINK_POINTS {
        out.drain(..out.len() - MAX_LINK_POINTS);
    }
    out
}

pub fn link_history(samples: &[Sample], a: u32, b: u32) -> LinkHistory {
    LinkHistory { a: node_id(a), b: node_id(b), ab: direction(samples, a, b), ba: direction(samples, b, a) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_direction_in_time_order_with_each_event_once() {
        let s = |src, dst, t, snr: Option<f64>, key| Sample { src, dst, ev: Ev::DirectRf, t, snr, rssi: None, key };
        let samples = [s(1, 2, 30, Some(3.0), SKey::Ok(9)), s(1, 2, 10, Some(5.0), SKey::Ok(8)), s(1, 2, 31, Some(3.0), SKey::Ok(9)), s(2, 1, 20, Some(-4.0), SKey::Ok(7)), s(1, 2, 40, None, SKey::Ok(6))];
        let h = link_history(&samples, 1, 2);
        assert_eq!(h.ab.iter().map(|p| (p.t, p.snr)).collect::<Vec<_>>(), vec![(10, Some(5.0)), (30, Some(3.0))], "the duplicate and the unmeasured one dropped");
        assert_eq!(h.ba.len(), 1);
    }
}
