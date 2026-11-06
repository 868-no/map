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

/// One measured reading of a link direction, as the link history shows it:
/// 32 bytes, against a full `Sample`'s 72, kept for the window's lifetime.
#[derive(Clone, Copy, Debug)]
struct Reading {
    src: u32,
    dst: u32,
    t: i64,
    /// NaN: not measured.
    snr: f32,
    rssi: f32,
    ev: Ev,
}

/// Every link's measured readings (D-105), each RF event once (as the link
/// statistics count them), sorted by direction and time: one direction's
/// history is a slice found by binary search.
#[derive(Default)]
pub struct LinkReadings(Vec<Reading>);

/// Signals are whole or quarter dB (firmware integers, or SNR in quarters),
/// which f32 holds exactly; to hundredths, so any other value reads as sent.
fn wide(v: f32) -> Option<f64> {
    (!v.is_nan()).then(|| crate::util::round2(v as f64))
}

impl LinkReadings {
    pub fn new(samples: &[Sample]) -> Self {
        let mut seen: FxSet<(u32, u32, Ev, SKey)> = set();
        let mut v: Vec<Reading> = samples
            .iter()
            .filter(|s| s.snr.is_some() || s.rssi.is_some())
            .filter(|s| s.key == SKey::None || seen.insert((s.src, s.dst, s.ev, s.key)))
            .map(|s| Reading { src: s.src, dst: s.dst, t: s.t, snr: s.snr.map_or(f32::NAN, |x| x as f32), rssi: s.rssi.map_or(f32::NAN, |x| x as f32), ev: s.ev })
            .collect();
        // Stable: equal times keep the samples' order, as the view did.
        v.sort_by_key(|r| (r.src, r.dst, r.t));
        LinkReadings(v)
    }

    /// The readings from `src` to `dst`, oldest first, the newest MAX_LINK_POINTS.
    fn direction(&self, src: u32, dst: u32) -> Vec<LinkPoint> {
        let lo = self.0.partition_point(|r| (r.src, r.dst) < (src, dst));
        let hi = self.0.partition_point(|r| (r.src, r.dst) <= (src, dst));
        let run = &self.0[lo.max(hi.saturating_sub(MAX_LINK_POINTS))..hi];
        run.iter().map(|r| LinkPoint { t: r.t, snr: wide(r.snr), rssi: wide(r.rssi), ev: ev_name(r.ev) }).collect()
    }
}

pub fn link_history(readings: &LinkReadings, a: u32, b: u32) -> LinkHistory {
    LinkHistory { a: node_id(a), b: node_id(b), ab: readings.direction(a, b), ba: readings.direction(b, a) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_direction_in_time_order_with_each_event_once() {
        let s = |src, dst, t, snr: Option<f64>, key| Sample { src, dst, ev: Ev::DirectRf, t, snr, rssi: None, key };
        let samples = [s(1, 2, 30, Some(3.0), SKey::Ok(9)), s(1, 2, 10, Some(5.0), SKey::Ok(8)), s(1, 2, 31, Some(3.0), SKey::Ok(9)), s(2, 1, 20, Some(-4.0), SKey::Ok(7)), s(1, 2, 40, None, SKey::Ok(6))];
        let h = link_history(&LinkReadings::new(&samples), 1, 2);
        assert_eq!(h.ab.iter().map(|p| (p.t, p.snr)).collect::<Vec<_>>(), vec![(10, Some(5.0)), (30, Some(3.0))], "the duplicate and the unmeasured one dropped");
        assert_eq!(h.ba.len(), 1);
    }
}
