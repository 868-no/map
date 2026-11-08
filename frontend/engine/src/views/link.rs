//! One link's evidence over time (D-105): every radio sample between two
//! nodes, per direction, for the link panel's history charts; and a
//! router's links to other routers, for its link quality chart and the
//! router link drop rule (D-197).

use serde::Serialize;

use crate::graph::{Ev, Sample};
use crate::util::{map, node_id, FxMap, FxSet};

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
    /// The noise floor each end measures, [Unix ms, dBm], oldest first, the
    /// newest MAX_LINK_POINTS; empty for an end that sent none (D-199).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub floor_a: Vec<(i64, i32)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub floor_b: Vec<(i64, i32)>,
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
pub(crate) struct Reading {
    pub src: u32,
    pub dst: u32,
    pub t: i64,
    /// NaN: not measured.
    pub snr: f32,
    pub rssi: f32,
    pub ev: Ev,
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

    /// Every reading, in no particular order (router link quality, D-197):
    /// read in one pass, so a build that shows no link history never sorts them.
    pub(crate) fn all(&self) -> std::cell::Ref<'_, Vec<Reading>> {
        self.readings.borrow()
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

pub fn link_history(readings: &LinkReadings, floors: &super::noise::NoiseFloors, a: u32, b: u32) -> LinkHistory {
    LinkHistory { a: node_id(a), b: node_id(b), ab: readings.direction(a, b), ba: readings.direction(b, a), floor_a: floors.newest(a, MAX_LINK_POINTS), floor_b: floors.newest(b, MAX_LINK_POINTS) }
}

/// One direction of a router's radio link to another router (D-197): its
/// SNR readings at the receiving end, in time order.
#[derive(Debug, Default, Clone)]
pub struct RouterLink {
    pub partner: u32,
    /// The router transmitted and the partner heard it; else the reverse.
    pub out: bool,
    pub t: Vec<i64>,
    pub snr: Vec<f32>,
}

/// Every link direction between two routers that has SNR readings, by
/// router (each direction is listed under both ends). From the window's
/// radio readings as link statistics count them: every RF event once, over
/// radio only (MQTT hops are links of their own), relay hints included,
/// as an edge's SNR median includes them (D-197).
pub fn router_links(readings: &LinkReadings, routers: &FxSet<u32>) -> FxMap<u32, Vec<RouterLink>> {
    let keep = |r: &&Reading| !r.snr.is_nan() && routers.contains(&r.src) && routers.contains(&r.dst);
    let all = readings.all();
    // One vector, sized exactly and sorted, rather than one growing per direction.
    let mut v: Vec<(u32, u32, i64, f32)> = Vec::with_capacity(all.iter().filter(keep).count());
    v.extend(all.iter().filter(keep).map(|r| (r.src, r.dst, r.t, r.snr)));
    drop(all);
    v.sort_unstable_by_key(|x| (x.0, x.1, x.2)); // equal times: either order gives the same medians
    let mut out: FxMap<u32, Vec<RouterLink>> = map();
    for run in v.chunk_by(|a, b| (a.0, a.1) == (b.0, b.1)) {
        let (src, dst) = (run[0].0, run[0].1);
        let t: Vec<i64> = run.iter().map(|x| x.2).collect();
        let snr: Vec<f32> = run.iter().map(|x| x.3).collect();
        out.entry(dst).or_default().push(RouterLink { partner: src, out: false, t: t.clone(), snr: snr.clone() });
        out.entry(src).or_default().push(RouterLink { partner: dst, out: true, t, snr });
    }
    // In a fixed order: the map's is arbitrary, and the rule must not depend on it.
    for links in out.values_mut() {
        links.sort_unstable_by_key(|l| (l.partner, l.out));
    }
    out
}

/// Bin widths for the router link quality chart, the narrowest first; a
/// window gets the narrowest giving at most MAX_QUALITY_BINS bins.
const QUALITY_BINS: [i64; 7] = [900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000];
pub const MAX_QUALITY_BINS: i64 = 72;

/// The bin width for a window of `span` ms.
pub fn quality_bin(span: i64) -> i64 {
    QUALITY_BINS.iter().copied().find(|&b| span / b <= MAX_QUALITY_BINS).unwrap_or(QUALITY_BINS[QUALITY_BINS.len() - 1])
}

/// A router's link quality over the window (D-197): per time bin, the
/// median SNR of its radio links to other routers and the readings it
/// rests on, in both directions.
#[derive(Serialize, Debug, PartialEq)]
pub struct RouterQuality {
    /// Bin width, ms; bins start at the window's start.
    pub bin_ms: i64,
    /// Its transmissions as other routers heard them: [bin middle (Unix
    /// ms), median SNR (dB), readings], bins with readings only.
    pub heard: Vec<(i64, f64, usize)>,
    /// Other routers as it heard them.
    pub hearing: Vec<(i64, f64, usize)>,
    /// The noise floor it measures (D-199): [bin middle, median dBm,
    /// readings], bins with readings only; empty when it sends none.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub floor: Vec<(i64, f64, usize)>,
}

/// Median of `v` (mean of the middle pair when even), as graph::stats takes it; v is reordered.
pub fn median_f32(v: &mut [f32]) -> f64 {
    let n = v.len();
    let h = n / 2;
    let (lo, &mut mid, _) = v.select_nth_unstable_by(h, f32::total_cmp);
    if n % 2 == 1 {
        mid as f64
    } else {
        let below = lo.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        f64::midpoint(below as f64, mid as f64)
    }
}

/// `num`'s router link quality over [start, end), or None when it has no
/// SNR reading to or from another router. floors: its noise floor readings
/// (D-199), binned alike.
pub fn router_quality(readings: &LinkReadings, num: u32, routers: &FxSet<u32>, floors: &[(i64, i32)], start: i64, end: i64) -> Option<RouterQuality> {
    let bin = quality_bin(end - start);
    // (bin, heard) -> SNRs, from one pass over the readings.
    let mut bins: FxMap<(i64, bool), Vec<f32>> = map();
    for r in readings.all().iter().filter(|r| !r.snr.is_nan() && r.t >= start && r.t < end) {
        let heard = if r.src == num && routers.contains(&r.dst) {
            true
        } else if r.dst == num && routers.contains(&r.src) {
            false
        } else {
            continue;
        };
        bins.entry(((r.t - start) / bin, heard)).or_default().push(r.snr);
    }
    if bins.is_empty() {
        return None;
    }
    let mut heard = Vec::new();
    let mut hearing = Vec::new();
    for ((k, h), mut snrs) in bins {
        let p = (start + k * bin + bin / 2, crate::util::round2(median_f32(&mut snrs)), snrs.len());
        if h { heard.push(p) } else { hearing.push(p) }
    }
    heard.sort_unstable_by_key(|p| p.0);
    hearing.sort_unstable_by_key(|p| p.0);
    let mut floor_bins: FxMap<i64, Vec<f32>> = map();
    for &(t, f) in floors.iter().filter(|x| x.0 >= start && x.0 < end) {
        floor_bins.entry((t - start) / bin).or_default().push(f as f32);
    }
    let mut floor: Vec<(i64, f64, usize)> = floor_bins.into_iter().map(|(k, mut v)| (start + k * bin + bin / 2, crate::util::round2(median_f32(&mut v)), v.len())).collect();
    floor.sort_unstable_by_key(|p| p.0);
    Some(RouterQuality { bin_ms: bin, heard, hearing, floor })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::SKey;

    #[test]
    fn each_direction_in_time_order_with_each_event_once() {
        let s = |src, dst, t, snr: Option<f64>, key| Sample { src, dst, ev: Ev::DirectRf, t, snr, rssi: None, key };
        let samples = [s(1, 2, 30, Some(3.0), SKey::Ok(9)), s(1, 2, 10, Some(5.0), SKey::Ok(8)), s(1, 2, 31, Some(3.0), SKey::Ok(9)), s(2, 1, 20, Some(-4.0), SKey::Ok(7)), s(1, 2, 40, None, SKey::Ok(6))];
        let h = link_history(&LinkReadings::new(&samples), &Default::default(), 1, 2);
        assert_eq!(h.ab.iter().map(|p| (p.t, p.snr)).collect::<Vec<_>>(), vec![(10, Some(5.0)), (30, Some(3.0))], "the duplicate and the unmeasured one dropped");
        assert_eq!(h.ba.len(), 1);
    }

    #[test]
    fn a_routers_links_to_routers_by_bin_in_both_directions() {
        const H: i64 = 3_600_000;
        let s = |src, dst, t, snr: f64, k| Sample { src, dst, ev: Ev::Traceroute, t, snr: Some(snr), rssi: None, key: SKey::Ok(k) };
        // Router 1 heard by router 2 (two bins), hearing router 3; client 4 hears it too (not counted).
        let samples = [s(1, 2, 10, 8.0, 1), s(1, 2, 20, 6.0, 2), s(1, 2, 30, 1.0, 3), s(1, 2, H + 5, -2.0, 4), s(3, 1, 40, 4.0, 5), s(1, 4, 50, 9.0, 6), s(1, 2, 25 * H, 0.0, 7)];
        let r = LinkReadings::new(&samples);
        let routers: FxSet<u32> = [1, 2, 3].into_iter().collect();
        let q = router_quality(&r, 1, &routers, &[], 0, 24 * H).unwrap();
        assert_eq!(q.bin_ms, 30 * 60_000, "24 h in at most 72 bins");
        assert_eq!(q.heard, vec![(15 * 60_000, 6.0, 3), (H + 15 * 60_000, -2.0, 1)], "the reading after the window left out");
        assert_eq!(q.hearing, vec![(15 * 60_000, 4.0, 1)]);
        assert!(q.floor.is_empty(), "no local stats, no floor");
        assert!(router_quality(&r, 5, &routers, &[(10, -100)], 0, 24 * H).is_none(), "a floor alone is no link quality");
        assert_eq!((quality_bin(H), quality_bin(72 * H), quality_bin(168 * H), quality_bin(336 * H)), (900_000, H, 3 * H, 6 * H));
        let links = router_links(&r, &routers);
        assert_eq!(links[&1].iter().map(|l| (l.partner, l.out, l.t.len())).collect::<Vec<_>>(), vec![(2, true, 5), (3, false, 1)]);
        assert_eq!(links[&2][0].snr, vec![8.0, 6.0, 1.0, -2.0, 0.0]);
        assert_eq!(median_f32(&mut [4.0, 1.0, 3.0, 2.0]), 2.5);
    }

    fn floors(text: &str) -> (crate::row::Interner, Vec<crate::row::Row>) {
        let mut i = crate::row::Interner::default();
        let rows = serde_json::from_str::<Vec<crate::row::JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        (i, rows)
    }

    #[test]
    fn a_link_carries_the_noise_floor_of_each_end_that_measures_one() {
        // Node 1 sends local stats twice (one packet heard twice), node 2 none, node 3 once.
        let (i, rows) = floors(r#"[
          {"i":1,"t":100,"b":"x","g":9,"s":1,"y":"telemetry","l":"01","o":"01","sg":"unsigned","te":{"kind":"local","noise_floor":-105}},
          {"i":2,"t":101,"b":"x","g":8,"s":1,"y":"telemetry","l":"01","o":"02","sg":"unsigned","te":{"kind":"local","noise_floor":-105}},
          {"i":3,"t":200,"b":"x","g":9,"s":1,"y":"telemetry","l":"03","o":"03","sg":"unsigned","te":{"kind":"local","noise_floor":-101}},
          {"i":4,"t":300,"b":"x","g":9,"s":3,"y":"telemetry","l":"04","o":"04","sg":"unsigned","te":{"kind":"local","noise_floor":-96}}
        ]"#);
        let refs: Vec<&crate::row::Row> = rows.iter().collect();
        let f = crate::views::noise::NoiseFloors::new(&refs, &i);
        let s = |src, dst, t, rssi: f64, k| Sample { src, dst, ev: Ev::DirectRf, t, snr: Some(1.0), rssi: Some(rssi), key: SKey::Ok(k) };
        let r = LinkReadings::new(&[s(1, 2, 150, -100.0, 1), s(2, 1, 160, -98.0, 2)]);
        let h = link_history(&r, &f, 2, 1);
        assert!(h.floor_a.is_empty(), "node 2 measures none");
        assert_eq!(h.floor_b, vec![(100, -105), (200, -101)], "one reading per packet");
        let json = serde_json::to_string(&h).unwrap();
        assert!(!json.contains("floor_a") && json.contains(r#""floor_b":[[100,-105],[200,-101]]"#), "{json}");
        assert_eq!(link_history(&r, &f, 1, 3).floor_b, vec![(300, -96)]);
    }

    #[test]
    fn a_routers_noise_floor_is_binned_like_its_links() {
        const H: i64 = 3_600_000;
        let s = |src, dst, t, snr: f64, k| Sample { src, dst, ev: Ev::Traceroute, t, snr: Some(snr), rssi: None, key: SKey::Ok(k) };
        let r = LinkReadings::new(&[s(1, 2, 10, 8.0, 1)]);
        let routers: FxSet<u32> = [1, 2].into_iter().collect();
        let floor = [(5, -110), (20, -100), (30, -104), (H, -95), (25 * H, -90)];
        let q = router_quality(&r, 1, &routers, &floor, 0, 24 * H).unwrap();
        assert_eq!(q.floor, vec![(15 * 60_000, -104.0, 3), (H + 15 * 60_000, -95.0, 1)], "medians per 30 min bin; the reading after the window left out");
    }
}
