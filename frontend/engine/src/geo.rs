//! Coarse locations for unpositioned nodes from direct links to positioned
//! anchors (spec §8); ported from the backend's internal/geo. Estimates
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
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn fmt0(v: f64) -> String {
    format!("{:.0}", v.round())
}

/// Estimates one target, or the reason it cannot.
pub fn locate(anchors: &crate::util::FxMap<u32, Anchor>, ms: &[Measurement], p: &Params, node_id: impl Fn(u32) -> String) -> Result<Estimate, String> {
    let mut pts: Vec<Pt> = ms.iter().filter_map(|m| anchors.get(&m.anchor).filter(|_| m.samples > 0).map(|a| Pt { x: 0.0, y: 0.0, m: *m, a: *a })).collect();
    if pts.len() < p.min_anchors {
        return Err(format!("only {} positioned anchors with direct links (need {})", pts.len(), p.min_anchors));
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
    for i in 0..pts.len() {
        for j in i + 1..pts.len() {
            if (pts[i].x - pts[j].x).hypot(pts[i].y - pts[j].y) < p.min_anchor_spacing_m {
                return Err(format!("anchors {} and {} are collocated (< {} m apart)", node_id(pts[i].a.node), node_id(pts[j].a.node), fmt0(p.min_anchor_spacing_m)));
            }
        }
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
        if from == 0 || q.m.first < from {
            from = q.m.first;
        }
        to = to.max(q.m.last);
    }
    names.sort();
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
        let md: f64 = pts.iter().map(|q| (q.x - x).hypot(q.y - y)).sum();
        unc = (md / n).max(p.uncalibrated_floor_m);
        method = "weighted_centroid";
        quality = "very_low";
        reasons.push("uncalibrated: weighted centroid of anchors heard directly; SNR does not measure distance".to_string());
    }
    if dropped > 0 {
        reasons.push(format!("{dropped} distant anchor(s) ignored as inconsistent"));
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
        let est = locate(&anchors, &[m(1), m(2), m(3)], &Params::default(), node_id).unwrap();
        assert_eq!(est.method, "weighted_centroid");
        assert!(est.lat > 59.85 && est.lat < 59.95);
        assert!(locate(&anchors, &[m(1), m(2)], &Params::default(), node_id).unwrap_err().starts_with("only 2 positioned anchors"));
    }
}
