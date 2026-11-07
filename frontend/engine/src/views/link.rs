//! One link's evidence over time (D-105): every radio sample between two
//! nodes, per direction, for the link panel's history charts.

use serde::Serialize;

use crate::graph::{Ev, Sample};
use crate::util::node_id;

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
/// statistics count them). Sorted by direction and time on the first link
/// view of a build (most builds never show one), so one direction's history
/// is a slice found by binary search.
#[derive(Default)]
pub struct LinkReadings {
    readings: std::cell::RefCell<Vec<Reading>>,
    sorted: std::cell::Cell<bool>,
}

/// Signals are whole or quarter dB (firmware integers, or SNR in quarters),
/// which f32 holds exactly; to hundredths, so any other value reads as sent.
fn wide(v: f32) -> Option<f64> {
    (!v.is_nan()).then(|| crate::util::round2(v as f64))
}

impl LinkReadings {
    /// From samples, deduplicated as graph::reduce counts them.
    pub fn new(samples: &[Sample]) -> Self {
        let mut r = LinkReadings::default();
        crate::graph::reduce_kept(samples, |s| r.push(s));
        r
    }

    /// Adds a sample reduce kept (counted once), if it measured a signal.
    pub fn push(&mut self, s: &Sample) {
        if s.snr.is_some() || s.rssi.is_some() {
            self.readings.get_mut().push(Reading { src: s.src, dst: s.dst, t: s.t, snr: s.snr.map_or(f32::NAN, |x| x as f32), rssi: s.rssi.map_or(f32::NAN, |x| x as f32), ev: s.ev });
        }
    }

    /// The readings from `src` to `dst`, oldest first, the newest MAX_LINK_POINTS.
    fn direction(&self, src: u32, dst: u32) -> Vec<LinkPoint> {
        if !self.sorted.replace(true) {
            // Stable: equal times keep the samples' order, as the view did.
            self.readings.borrow_mut().sort_by_key(|r| (r.src, r.dst, r.t));
        }
        let v = self.readings.borrow();
        let lo = v.partition_point(|r| (r.src, r.dst) < (src, dst));
        let hi = v.partition_point(|r| (r.src, r.dst) <= (src, dst));
        let run = &v[lo.max(hi.saturating_sub(MAX_LINK_POINTS))..hi];
        run.iter().map(|r| LinkPoint { t: r.t, snr: wide(r.snr), rssi: wide(r.rssi), ev: ev_name(r.ev) }).collect()
    }
}

pub fn link_history(readings: &LinkReadings, a: u32, b: u32) -> LinkHistory {
    LinkHistory { a: node_id(a), b: node_id(b), ab: readings.direction(a, b), ba: readings.direction(b, a) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::SKey;

    #[test]
    fn each_direction_in_time_order_with_each_event_once() {
        let s = |src, dst, t, snr: Option<f64>, key| Sample { src, dst, ev: Ev::DirectRf, t, snr, rssi: None, key };
        let samples = [s(1, 2, 30, Some(3.0), SKey::Ok(9)), s(1, 2, 10, Some(5.0), SKey::Ok(8)), s(1, 2, 31, Some(3.0), SKey::Ok(9)), s(2, 1, 20, Some(-4.0), SKey::Ok(7)), s(1, 2, 40, None, SKey::Ok(6))];
        let h = link_history(&LinkReadings::new(&samples), 1, 2);
        assert_eq!(h.ab.iter().map(|p| (p.t, p.snr)).collect::<Vec<_>>(), vec![(10, Some(5.0)), (30, Some(3.0))], "the duplicate and the unmeasured one dropped");
        assert_eq!(h.ba.len(), 1);
    }
}
