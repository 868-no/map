//! Coarse locations for unpositioned nodes from direct links to positioned
//! anchors (design §6.12); ported from the backend's internal/geo. Estimates
//! carry explicit uncertainty; underdetermined cases yield nothing.

use serde::{Deserialize, Serialize};

use crate::util::{iso, round_away};

#[derive(Clone, Copy, Debug)]
pub struct Anchor {
    pub node: u32,
    pub lat: f64,
    pub lon: f64,
    pub err_m: f64,
}

/// Worst-case error of a position reported with the given precision bits: half the cell diagonal.
pub fn precision_error_m(bits: u32, lat: f64) -> f64 {
    if bits >= 32 {
        return 0.0;
    }
    let cell = 1e-7 * 2f64.powi(32 - bits as i32);
    let half_lat = cell / 2.0 * 111_320.0;
    let half_lon = half_lat * (lat * std::f64::consts::PI / 180.0).cos();
    half_lat.hypot(half_lon)
}

#[derive(Clone, Copy, Debug)]
pub struct Measurement {
    pub anchor: u32,
    pub snr: Option<f64>,
    pub rssi: Option<f64>,
    pub samples: u32,
    pub first: i64,
    pub last: i64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Calibration {
    pub p0_dbm: f64,
    pub path_loss_exponent: f64,
}

/// Acceptance gates (the operator's settings, from /capabilities).
#[derive(Clone, Debug, Deserialize)]
pub struct Params {
    pub min_anchors: usize,
    pub min_samples: u32,
    pub min_anchor_spacing_m: f64,
    pub min_spread_m: f64,
    pub min_shape_ratio: f64,
    pub max_anchor_distance_m: f64,
    pub floor_m: f64,
    pub uncalibrated_floor_m: f64,
    #[serde(default)]
    pub calibration: Option<Calibration>,
}

impl Default for Params {
    fn default() -> Self {
        Params { min_anchors: 3, min_samples: 5, min_anchor_spacing_m: 200.0, min_spread_m: 500.0, min_shape_ratio: 0.2, max_anchor_distance_m: 150_000.0, floor_m: 500.0, uncalibrated_floor_m: 2000.0, calibration: None }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Estimate {
    pub lat: f64,
    pub lon: f64,
    pub uncertainty_radius_m: f64,
    pub method: &'static str,
    pub quality: &'static str,
    pub anchor_count: usize,
    pub sample_count: u32,
    pub anchors: Vec<String>,
    pub evidence_from: String,
    pub evidence_to: String,
    pub reasons: Vec<String>,
}

struct Enu {
    lat0: f64,
    lon0: f64,
    kx: f64,
    ky: f64,
}

impl Enu {
    fn new(lat0: f64, lon0: f64) -> Self {
        const R: f64 = 6_371_008.8;
        let d = std::f64::consts::PI / 180.0;
        Enu { lat0, lon0, kx: R * (lat0 * d).cos() * d, ky: R * d }
    }
    fn to(&self, lat: f64, lon: f64) -> (f64, f64) {
        ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)
    }
    fn from(&self, x: f64, y: f64) -> (f64, f64) {
        (self.lat0 + y / self.ky, self.lon0 + x / self.kx)
    }
}

struct Pt {
    x: f64,
    y: f64,
    m: Measurement,
    a: Anchor,
    /// Anchors at the same site merged into this one (D-175).
    with: Vec<u32>,
}

/// Anchors closer than `spacing` are devices at one site: one viewpoint,
/// not several, so each such group becomes one anchor (D-175). Its position
/// is the sample-weighted mean of theirs, its error covers each of theirs
/// from there, its samples add up, and its SNR and RSSI are sample-weighted
/// means. The anchor with the most samples (then the lowest number) names
/// the site. Returns the sites and the merged groups, each a site's nodes.
fn merge_sites(mut pts: Vec<Pt>, spacing: f64) -> (Vec<Pt>, Vec<Vec<u32>>) {
    pts.sort_by_key(|q| (std::cmp::Reverse(q.m.samples), q.a.node));
    let mut out: Vec<Pt> = Vec::with_capacity(pts.len());
    /// Per site: sample-weighted sums and weights of SNR and RSSI, and its members' (x, y, err).
    struct Site {
        sig: [f64; 4],
        members: Vec<(f64, f64, f64)>,
    }
    let mut acc: Vec<Site> = Vec::new();
    for q in pts {
        let w = q.m.samples as f64;
        let sig = [q.m.snr.map_or(0.0, |v| v * w), q.m.snr.map_or(0.0, |_| w), q.m.rssi.map_or(0.0, |v| v * w), q.m.rssi.map_or(0.0, |_| w)];
        match out.iter().position(|s| (s.x - q.x).hypot(s.y - q.y) < spacing) {
            Some(k) => {
                let s = &mut out[k];
                let (ws, t) = (s.m.samples as f64, s.m.samples as f64 + w);
                let lerp = |a: f64, b: f64| (a * ws + b * w) / t;
                (s.x, s.y, s.a.lat, s.a.lon) = (lerp(s.x, q.x), lerp(s.y, q.y), lerp(s.a.lat, q.a.lat), lerp(s.a.lon, q.a.lon));
                s.m.samples += q.m.samples;
                s.m.first = s.m.first.min(q.m.first);
                s.m.last = s.m.last.max(q.m.last);
                s.with.push(q.a.node);
                let Site { sig: a, members } = &mut acc[k];
                for (t, v) in a.iter_mut().zip(sig) {
                    *t += v;
                }
                members.push((q.x, q.y, q.a.err_m));
                s.m.snr = (a[1] > 0.0).then(|| a[0] / a[1]);
                s.m.rssi = (a[3] > 0.0).then(|| a[2] / a[3]);
                s.a.err_m = members.iter().map(|&(x, y, e)| e + (x - s.x).hypot(y - s.y)).fold(0.0, f64::max);
            }
            None => {
                acc.push(Site { sig, members: vec![(q.x, q.y, q.a.err_m)] });
                out.push(q);
            }
        }
    }
    let groups = out.iter().filter(|s| !s.with.is_empty()).map(|s| std::iter::once(s.a.node).chain(s.with.iter().copied()).collect()).collect();
    (out, groups)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_unstable_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn fmt0(v: f64) -> String {
    format!("{:.0}", v.round())
}

/// Signal against distance, fitted over the window's router-to-router links
/// with a clear line of sight (D-143): SNR = a + b·log10(km). It cannot say
/// how far one link reaches, links scatter by about 6 dB, but it can say
/// roughly how far a link is not, and so push a centroid that has nothing
/// to pull it one way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ranging {
    pub a: f64,
    pub b: f64,
    pub links: usize,
}

/// Links a ranging fit needs.
pub const MIN_RANGING_LINKS: usize = 8;
/// A centroid with no anchor in a sector wider than this is compensated.
pub const GAP_DEG: f64 = 135.0;
/// A ranged move shorter than this is no move: the centroid stands.
pub const RANGED_MIN_MOVE_M: f64 = 100.0;

impl Ranging {
    /// Least squares over (km, snr); none with too few links, or when signal
    /// does not fall with distance.
    pub fn fit(links: &[(f64, f64)]) -> Option<Ranging> {
        let pts: Vec<(f64, f64)> = links.iter().filter(|(km, s)| *km > 0.0 && s.is_finite()).map(|&(km, s)| (km.log10(), s)).collect();
        if pts.len() < MIN_RANGING_LINKS {
            return None;
        }
        let n = pts.len() as f64;
        let mx = pts.iter().map(|p| p.0).sum::<f64>() / n;
        let my = pts.iter().map(|p| p.1).sum::<f64>() / n;
        let sxx: f64 = pts.iter().map(|p| (p.0 - mx).powi(2)).sum();
        if sxx <= 0.0 {
            return None;
        }
        let b = pts.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>() / sxx;
        (b < 0.0).then_some(Ranging { a: my - b * mx, b, links: pts.len() })
    }
    /// The distance the model gives a link's SNR, m.
    pub fn range_m(&self, snr: f64) -> f64 {
        1000.0 * 10f64.powf((snr - self.a) / self.b)
    }
}

/// The widest sector, in degrees, seen from (x, y) with no anchor in it.
fn widest_gap(x: f64, y: f64, pts: &[Pt]) -> f64 {
    let mut b: Vec<f64> = pts.iter().map(|q| (q.y - y).atan2(q.x - x).to_degrees().rem_euclid(360.0)).collect();
    if b.len() < 2 {
        return 360.0;
    }
    b.sort_unstable_by(|p, q| p.total_cmp(q));
    let wrap = b[0] + 360.0 - b[b.len() - 1];
    b.windows(2).map(|w| w[1] - w[0]).fold(wrap, f64::max)
}

/// Moves a centroid to where the anchors' distances best match the ranges
/// their SNR gives (least squares in log distance), each range capped at
/// the anchors' mean distance from the centroid: a weak link may say "not
/// close", never "very far". A grid search over the whole reach, then
/// finer grids around the best point: robust, and cheap
/// for a handful of anchors. None when that best point is within
/// RANGED_MIN_MOVE_M of the centroid: nothing worth reporting as a move.
fn ranged(pts: &[Pt], x0: f64, y0: f64, r: &Ranging) -> Option<(f64, f64)> {
    let cap = pts.iter().map(|q| (q.x - x0).hypot(q.y - y0)).sum::<f64>() / pts.len() as f64;
    // (x, y, 2·ln range, weight): ln d = ½·ln d², so no square root per point.
    let obs: Vec<(f64, f64, f64, f64)> =
        pts.iter().filter_map(|q| q.m.snr.map(|s| (q.x, q.y, 2.0 * r.range_m(s).min(cap).max(100.0).ln(), (q.m.samples as f64).sqrt()))).collect();
    if obs.len() < 3 {
        return None;
    }
    // Four times the least squares in ln d: the same minimum.
    let cost = |x: f64, y: f64| obs.iter().map(|&(ax, ay, lr2, w)| w * (((ax - x).powi(2) + (ay - y).powi(2)).max(1e4).ln() - lr2).powi(2)).sum::<f64>();
    let reach = pts.iter().map(|q| (q.x - x0).hypot(q.y - y0)).fold(0.0, f64::max) + cap;
    let (mut bx, mut by, mut best) = (x0, y0, cost(x0, y0));
    let mut search = |cx: f64, cy: f64, step: f64, n: i32| {
        for i in -n..=n {
            for j in -n..=n {
                let (x, y) = (cx + i as f64 * step, cy + j as f64 * step);
                let c = cost(x, y);
                if c < best {
                    (bx, by, best) = (x, y, c);
                }
            }
        }
        (bx, by)
    };
    // The whole reach at reach/20, then ±2 of its steps at a tenth of that
    // (a coarser second level can settle in the wrong one of two shallow
    // minima), then ±2 steps of the last level at half its step, down to
    // under a metre: about 4k evaluations instead of 10k.
    let mut step = reach / 20.0;
    let (mut cx, mut cy) = search(x0, y0, step, 20);
    step /= 10.0;
    (cx, cy) = search(cx, cy, step, 20);
    while step > 1.0 {
        step /= 2.0;
        (cx, cy) = search(cx, cy, step, 4);
    }
    ((cx - x0).hypot(cy - y0) >= RANGED_MIN_MOVE_M).then_some((cx, cy))
}

/// Estimates one target, or the reason it cannot. With a ranging model, an
/// uncalibrated centroid that leaves more than GAP_DEG without anchors is
/// moved by it (D-143).
pub fn locate(
    anchors: &crate::util::FxMap<u32, Anchor>,
    ms: &[Measurement],
    p: &Params,
    ranging: Option<&Ranging>,
    node_id: impl Fn(u32) -> String,
) -> Result<Estimate, String> {
    let mut pts: Vec<Pt> = ms.iter().filter_map(|m| anchors.get(&m.anchor).filter(|_| m.samples > 0).map(|a| Pt { x: 0.0, y: 0.0, m: *m, a: *a, with: vec![] })).collect();
    if pts.len() < p.min_anchors {
        return Err(format!("only {} positioned anchor{} with direct links (need {})", pts.len(), if pts.len() == 1 { "" } else { "s" }, p.min_anchors));
    }
    let e = Enu::new(median(pts.iter().map(|q| q.a.lat).collect()), median(pts.iter().map(|q| q.a.lon).collect()));
    let mut dropped = 0;
    pts.retain_mut(|q| {
        (q.x, q.y) = e.to(q.a.lat, q.a.lon);
        if q.x.hypot(q.y) > p.max_anchor_distance_m {
            dropped += 1;
            false
        } else {
            true
        }
    });
    if pts.len() < p.min_anchors {
        return Err(format!("inconsistent anchors: {dropped} implausibly distant from the rest"));
    }
    let samples: u32 = pts.iter().map(|q| q.m.samples).sum();
    if samples < p.min_samples {
        return Err(format!("only {samples} independent samples (need {})", p.min_samples));
    }
    let (pts, sites) = merge_sites(pts, p.min_anchor_spacing_m);
    if pts.len() < p.min_anchors {
        return Err(format!("only {} anchor sites: anchors less than {} m apart count as one (need {})", pts.len(), fmt0(p.min_anchor_spacing_m), p.min_anchors));
    }
    let n = pts.len() as f64;
    let cx = pts.iter().map(|q| q.x).sum::<f64>() / n;
    let cy = pts.iter().map(|q| q.y).sum::<f64>() / n;
    let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
    for q in &pts {
        let (dx, dy) = (q.x - cx, q.y - cy);
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
    }
    (sxx, syy, sxy) = (sxx / n, syy / n, sxy / n);
    let (tr, det) = (sxx + syy, sxx * syy - sxy * sxy);
    let disc = (tr * tr / 4.0 - det).max(0.0).sqrt();
    let (l1, l2) = (tr / 2.0 + disc, tr / 2.0 - disc);
    if tr.sqrt() < p.min_spread_m {
        return Err(format!("anchors clustered (spread {} m < {} m)", fmt0(tr.sqrt()), fmt0(p.min_spread_m)));
    }
    if l1 <= 0.0 || (l2.max(0.0) / l1).sqrt() < p.min_shape_ratio {
        return Err("anchors nearly collinear: position not constrained in two dimensions".into());
    }
    let (mut from, mut to) = (0i64, 0i64);
    let mut names: Vec<String> = Vec::with_capacity(pts.len());
    for q in &pts {
        names.push(node_id(q.a.node));
        names.extend(q.with.iter().map(|&n| node_id(n)));
        if from == 0 || q.m.first < from {
            from = q.m.first;
        }
        to = to.max(q.m.last);
    }
    names.sort_unstable();
    let mut reasons = Vec::new();
    let (mut x, mut y, mut unc);
    let (method, quality);
    if let Some(cal) = p.calibration.filter(|_| pts.iter().filter(|q| q.m.rssi.is_some()).count() >= p.min_anchors) {
        (x, y, unc) = wls(&pts, cal, cx, cy)?;
        method = "log_distance_wls";
        quality = "low";
        reasons.push("calibrated log-distance model on RSSI; terrain and antennas still dominate error".to_string());
        unc = unc.max(p.floor_m);
    } else {
        // Uncalibrated: SNR-weighted centroid; it claims nothing finer than "among these anchors".
        let mut sw = 0.0;
        (x, y) = (0.0, 0.0);
        for q in &pts {
            let mut w = q.m.samples as f64;
            if let Some(s) = q.m.snr {
                w *= 10f64.powf(s.clamp(-20.0, 15.0) / 20.0);
            }
            x += w * q.x;
            y += w * q.y;
            sw += w;
        }
        x /= sw;
        y /= sw;
        quality = "very_low";
        reasons.push("uncalibrated: weighted centroid of anchors heard directly; SNR does not measure distance".to_string());
        // Anchors on one side only: nothing pulls the centroid the other
        // way, so it sits too close to them (D-143).
        let gap = widest_gap(x, y, &pts);
        match ranging.filter(|_| gap > GAP_DEG).and_then(|r| ranged(&pts, x, y, r).map(|xy| (r, xy))) {
            Some((r, (rx, ry))) => {
                reasons.push(format!(
                    "anchors leave {}° without data: moved {:.1} km by distances from SNR (SNR = {:.1} {} {:.1}·log10 km over {} clear router links)",
                    fmt0(gap),
                    (rx - x).hypot(ry - y) / 1000.0,
                    r.a,
                    if r.b < 0.0 { "−" } else { "+" },
                    r.b.abs(),
                    r.links
                ));
                (x, y) = (rx, ry);
                method = "ranged_centroid";
            }
            None => method = "weighted_centroid",
        }
        let md: f64 = pts.iter().map(|q| (q.x - x).hypot(q.y - y)).sum();
        unc = (md / n).max(p.uncalibrated_floor_m);
    }
    if dropped > 0 {
        reasons.push(format!("{dropped} distant anchor(s) ignored as inconsistent"));
    }
    for g in &sites {
        reasons.push(format!("anchors {} are less than {} m apart: counted as one site", g.iter().map(|&n| node_id(n)).collect::<Vec<_>>().join(", "), fmt0(p.min_anchor_spacing_m)));
    }
    // Anchors' reported positions may be off by up to err_m; added in full.
    let anchor_err = pts.iter().fold(0.0f64, |m, q| m.max(q.a.err_m));
    if anchor_err > 0.0 {
        unc += anchor_err;
        reasons.push(format!("radius includes up to {} m of anchor position imprecision", fmt0(round_away(anchor_err / 100.0) * 100.0)));
    }
    let (lat, lon) = e.from(x, y);
    Ok(Estimate {
        // Never report finer than ~100 m in coordinates.
        lat: round_away(lat * 1000.0) / 1000.0,
        lon: round_away(lon * 1000.0) / 1000.0,
        uncertainty_radius_m: round_away(unc / 100.0) * 100.0,
        method,
        quality,
        anchor_count: pts.len(),
        sample_count: samples,
        anchors: names,
        evidence_from: iso(from),
        evidence_to: iso(to),
        reasons,
    })
}

/// Levenberg-Marquardt on range residuals from the log-distance model with Huber weights.
fn wls(pts: &[Pt], c: Calibration, x0: f64, y0: f64) -> Result<(f64, f64, f64), String> {
    if c.path_loss_exponent <= 0.0 {
        return Err("invalid calibration exponent".into());
    }
    struct O {
        x: f64,
        y: f64,
        r: f64,
        w: f64,
    }
    let os: Vec<O> = pts
        .iter()
        .filter_map(|q| q.m.rssi.map(|rssi| O { x: q.x, y: q.y, r: 10f64.powf((c.p0_dbm - rssi) / (10.0 * c.path_loss_exponent)), w: (q.m.samples as f64).sqrt() }))
        .collect();
    let cost = |x: f64, y: f64| os.iter().map(|o| o.w * ((x - o.x).hypot(y - o.y) - o.r).powi(2)).sum::<f64>();
    let (mut x, mut y, mut lambda) = (x0, y0, 1e-3);
    let mut cur = cost(x, y);
    for _ in 0..100 {
        let (mut a11, mut a12, mut a22, mut b1, mut b2) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for o in &os {
            let (dx, dy) = (x - o.x, y - o.y);
            let d = dx.hypot(dy).max(1.0);
            let res = d - o.r;
            let k = 0.5 * o.r;
            let w = o.w * if res.abs() > k { k / res.abs() } else { 1.0 };
            let (jx, jy) = (dx / d, dy / d);
            a11 += w * jx * jx;
            a12 += w * jx * jy;
            a22 += w * jy * jy;
            b1 -= w * jx * res;
            b2 -= w * jy * res;
        }
        let (m11, m22) = (a11 * (1.0 + lambda) + 1e-9, a22 * (1.0 + lambda) + 1e-9);
        let det = m11 * m22 - a12 * a12;
        if det.abs() < 1e-12 {
            lambda *= 10.0;
            continue;
        }
        let (mut dx, mut dy) = ((m22 * b1 - a12 * b2) / det, (m11 * b2 - a12 * b1) / det);
        let step = dx.hypot(dy);
        if step > 5000.0 {
            dx = dx * 5000.0 / step;
            dy = dy * 5000.0 / step;
        }
        let nc = cost(x + dx, y + dy);
        if nc < cur {
            x += dx;
            y += dy;
            cur = nc;
            lambda = (lambda / 3.0).max(1e-7);
            if dx.hypot(dy) < 1.0 {
                break;
            }
        } else {
            lambda *= 4.0;
            if lambda > 1e6 {
                break;
            }
        }
    }
    let max_r = os.iter().fold(0.0f64, |m, o| m.max(o.r + (o.x - x0).hypot(o.y - y0)));
    if (x - x0).hypot(y - y0) > max_r {
        return Err("calibrated fit did not converge to a plausible location".into());
    }
    let (mut ss_db, mut mean_r) = (0.0, 0.0);
    for o in &os {
        let d = (x - o.x).hypot(y - o.y).max(1.0);
        let obs = c.p0_dbm - 10.0 * c.path_loss_exponent * o.r.log10();
        let pred = c.p0_dbm - 10.0 * c.path_loss_exponent * d.log10();
        ss_db += (obs - pred).powi(2);
        mean_r += o.r;
    }
    mean_r /= os.len() as f64;
    let sigma = (ss_db / os.len() as f64).sqrt().max(6.0);
    Ok((x, y, mean_r * (10f64.powf(sigma / (10.0 * c.path_loss_exponent)) - 1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{map, node_id};

    #[test]
    fn precision_error() {
        assert_eq!(precision_error_m(32, 60.0), 0.0);
        let e = precision_error_m(16, 60.0);
        assert!((e - 405.0).abs() < 10.0, "{e}");
    }

    #[test]
    fn centroid_needs_three_spread_anchors() {
        let mut anchors = map();
        for (n, lat, lon) in [(1u32, 59.9, 10.7), (2, 59.95, 10.8), (3, 59.85, 10.85)] {
            anchors.insert(n, Anchor { node: n, lat, lon, err_m: 0.0 });
        }
        let m = |a| Measurement { anchor: a, snr: Some(5.0), rssi: None, samples: 2, first: 1, last: 2 };
        let est = locate(&anchors, &[m(1), m(2), m(3)], &Params::default(), None, node_id).unwrap();
        assert_eq!(est.method, "weighted_centroid");
        assert!(est.lat > 59.85 && est.lat < 59.95);
        assert!(locate(&anchors, &[m(1), m(2)], &Params::default(), None, node_id).unwrap_err().starts_with("only 2 positioned anchors"));
    }

    #[test]
    fn anchors_at_one_site_count_as_one() {
        let mut anchors = map();
        // 1 and 4 share a roof (identical coordinates), 5 is 100 m from them.
        for (n, lat, lon) in [(1u32, 59.9, 10.7), (2, 59.95, 10.8), (3, 59.85, 10.85), (4, 59.9, 10.7), (5, 59.9009, 10.7)] {
            anchors.insert(n, Anchor { node: n, lat, lon, err_m: 0.0 });
        }
        let m = |a, samples| Measurement { anchor: a, snr: Some(5.0), rssi: None, samples, first: a as i64, last: 10 + a as i64 };
        let est = locate(&anchors, &[m(1, 2), m(2, 2), m(3, 2), m(4, 6), m(5, 2)], &Params::default(), None, node_id).unwrap();
        assert_eq!((est.anchor_count, est.sample_count), (3, 14), "three sites, every sample kept");
        assert_eq!(est.anchors.len(), 5, "all five named");
        assert!(est.reasons.iter().any(|r| r == "anchors !00000004, !00000001, !00000005 are less than 200 m apart: counted as one site"), "{:?}", est.reasons);
        // The site's own spread (up to ~100 m) counts as anchor imprecision.
        assert!(est.reasons.iter().any(|r| r.starts_with("radius includes up to 100 m")), "{:?}", est.reasons);
        // The same estimate as with the site's samples on one anchor.
        let one = locate(&anchors, &[m(1, 10), m(2, 2), m(3, 2)], &Params::default(), None, node_id).unwrap();
        assert!((est.lat - one.lat).abs() <= 0.001 && (est.lon - one.lon).abs() <= 0.001, "{est:?} {one:?}");
        // Two sites are not enough, however many anchors they hold.
        let e = locate(&anchors, &[m(1, 2), m(4, 2), m(5, 2), m(2, 2)], &Params::default(), None, node_id).unwrap_err();
        assert_eq!(e, "only 2 anchor sites: anchors less than 200 m apart count as one (need 3)");
    }

    #[test]
    fn ranging_fit() {
        let links: Vec<(f64, f64)> = [2.0, 5.0, 10.0, 20.0, 40.0, 80.0, 3.0, 30.0].iter().map(|&km: &f64| (km, 10.0 - 7.0 * km.log10())).collect();
        let r = Ranging::fit(&links).unwrap();
        assert!((r.a - 10.0).abs() < 1e-9 && (r.b + 7.0).abs() < 1e-9 && r.links == 8);
        assert!((r.range_m(3.0) - 10_000.0).abs() < 1.0);
        assert!(Ranging::fit(&links[..7]).is_none(), "too few links");
        let rising: Vec<(f64, f64)> = links.iter().map(|&(km, s)| (km, -s)).collect();
        assert!(Ranging::fit(&rising).is_none(), "signal must fall with distance");
    }

    // Anchors north, east and west of a target 30 km south of their middle:
    // the centroid sits among them; weak links say the target is further
    // off, and with nothing to the south, ranging moves it south.
    // SNRs that already fit the centroid: nothing to move, so no
    // "ranged_centroid" claiming a 0.0 km move.
    #[test]
    fn ranging_that_does_not_move_is_none() {
        let r = Ranging { a: 10.0, b: -7.0, links: 10 };
        let pts: Vec<Pt> = [(0.0, 20_000.0), (17_320.5, -10_000.0), (-17_320.5, -10_000.0)]
            .iter()
            .enumerate()
            .map(|(i, &(x, y)): (usize, &(f64, f64))| {
                let km = x.hypot(y) / 1000.0;
                let m = Measurement { anchor: i as u32, snr: Some(10.0 - 7.0 * km.log10()), rssi: None, samples: 4, first: 1, last: 2 };
                Pt { x, y, m, a: Anchor { node: i as u32, lat: 0.0, lon: 0.0, err_m: 0.0 }, with: vec![] }
            })
            .collect();
        assert_eq!(ranged(&pts, 0.0, 0.0, &r), None);
        let (x, y) = ranged(&pts, 6_000.0, 0.0, &r).expect("off-centre: moved back");
        assert!(x.hypot(y) < 100.0, "{x} {y}");
    }

    #[test]
    fn ranging_moves_a_one_sided_centroid() {
        let mut anchors = map();
        for (n, lat, lon) in [(1u32, 63.30, 9.5), (2, 63.45, 10.0), (3, 63.30, 10.5)] {
            anchors.insert(n, Anchor { node: n, lat, lon, err_m: 0.0 });
        }
        let r = Ranging { a: 10.0, b: -7.0, links: 10 };
        let target = (63.05, 10.0);
        let ms: Vec<Measurement> = [1u32, 2, 3]
            .iter()
            .map(|&a| {
                let x = anchors[&a];
                let km = crate::graph::distance_m(crate::graph::LatLon { lat: x.lat, lon: x.lon }, crate::graph::LatLon { lat: target.0, lon: target.1 }) / 1000.0;
                Measurement { anchor: a, snr: Some(10.0 - 7.0 * km.log10()), rssi: None, samples: 10, first: 1, last: 2 }
            })
            .collect();
        let plain = locate(&anchors, &ms, &Params::default(), None, node_id).unwrap();
        let est = locate(&anchors, &ms, &Params::default(), Some(&r), node_id).unwrap();
        assert_eq!(plain.method, "weighted_centroid");
        assert_eq!(est.method, "ranged_centroid", "{:?}", est.reasons);
        assert!(est.lat < plain.lat - 0.05, "moved south: {} → {}", plain.lat, est.lat);
        // Surrounded: a centroid with anchors all round is left alone.
        anchors.insert(4, Anchor { node: 4, lat: 62.9, lon: 10.0, err_m: 0.0 });
        let mut ms4 = ms.clone();
        ms4.push(Measurement { anchor: 4, snr: Some(0.0), rssi: None, samples: 10, first: 1, last: 2 });
        assert_eq!(locate(&anchors, &ms4, &Params::default(), Some(&r), node_id).unwrap().method, "weighted_centroid");
    }
}

