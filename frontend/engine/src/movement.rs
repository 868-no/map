//! Nodes that move (D-073).
//!
//! A node's reported positions in the window, in time order, are its track.
//! It moved when a position lies further than a few hundred metres, beyond
//! what precision explains, from where it last settled: drift is measured
//! from that reference point, not from the previous position, so a slow
//! mover whose every step is short still counts once it has gone far enough.
//! A position truncated to N bits can jump a whole cell while the node stands
//! still, so the threshold grows with both positions' worst-case error, and
//! movement is judged on the node's finest positions alone. Each
//! move makes that position the new reference; the time of the latest move
//! is when its current place began. Radio evidence from before then describes
//! another place, so links are built only from later samples.

use serde::Serialize;

use crate::geo::precision_error_m;
use crate::graph::{distance_m, LatLon};
use crate::row::{ty, Row};
use crate::util::{iso, map, FxMap, FxSet};

/// Base distance for a move, before precision slack.
pub const MOVE_M: f64 = 300.0;
/// For a node whose role sits in one place (a router, a base station): an
/// unstable GPS can wander hundreds of metres, and such nodes rarely move,
/// so only a jump this far is a move (D-139).
pub const FIXED_MOVE_M: f64 = 2_000.0;
/// Each position's worst-case error counts this many times.
const PRECISION_SLACK: f64 = 1.5;
/// Points kept per track (the newest).
pub const MAX_TRACK: usize = 100;
/// Reported altitude (above sea level) that, while moving, means airborne.
pub const AIRBORNE_M: i32 = 750;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TrackPoint {
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<i32>,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Movement {
    /// When its current place began (its latest move), Unix ms.
    pub moved_at: i64,
    /// Distinct positions in time order, the newest last.
    pub track: Vec<TrackPoint>,
}

/// A position's precision in bits: one shared without a precision (bits 0,
/// `known` false) counts as full precision, as elsewhere (design §6.10).
pub fn bits(p: &crate::row::Position) -> u32 {
    if p.known { p.bits } else { 32 }
}

/// The distance two positions must exceed to count as a move, for a node
/// that is `fixed` (its role sits in one place) or not.
pub fn move_threshold(fixed: bool, a: (f64, u32), b: (f64, u32)) -> f64 {
    (if fixed { FIXED_MOVE_M } else { MOVE_M }) + PRECISION_SLACK * (precision_error_m(a.1, a.0) + precision_error_m(b.1, b.0))
}

/// A stationary node whose reports jump around one place (D-077): GPS noise
/// around a fixed spot, or reports of different precision. The agreeing
/// reports pick its place, never finer than it shared itself (design §6.10).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Anchor {
    pub lat: f64,
    pub lon: f64,
    /// Worst-case error of the narrowed position.
    pub radius_m: f64,
    /// Reports (one per packet) in the window, and how many agree on the place.
    pub reports: usize,
    pub agree: usize,
    /// It tells more than the latest report: a smaller error, or outlying
    /// reports set aside. Otherwise it only keeps the node from counting as moving.
    #[serde(skip)]
    pub narrowed: bool,
}

/// Reports needed before a node can be anchored.
pub const ANCHOR_MIN_REPORTS: usize = 5;
fn err_m(p: &crate::row::Position) -> f64 {
    if p.known { precision_error_m(p.bits, p.lat) } else { 0.0 }
}

/// Each node's position reports (Position packets and map reports with a
/// position) in time order: the input of `anchors_of` and `movements_of`,
/// grouped once for both.
pub fn positions_by_node<'a>(rows: &[&'a Row]) -> FxMap<u32, Vec<&'a Row>> {
    let mut by_node: FxMap<u32, Vec<&Row>> = map();
    for &r in rows {
        if (r.ty == ty::POSITION || r.ty == ty::MAPREPORT) && r.pos.is_some() {
            by_node.entry(r.src).or_default().push(r);
        }
    }
    for rs in by_node.values_mut() {
        rs.sort_unstable_by_key(|r| (r.t, r.id));
    }
    by_node
}

/// Anchored nodes in `rows` (see `Anchor`); `fixed`: nodes whose role sits in one place.
pub fn anchors(rows: &[&Row], fixed: &FxSet<u32>) -> FxMap<u32, Anchor> {
    anchors_of(&positions_by_node(rows), fixed)
}

/// Anchored nodes among grouped position reports (`positions_by_node`).
pub fn anchors_of(by_node: &FxMap<u32, Vec<&Row>>, fixed: &FxSet<u32>) -> FxMap<u32, Anchor> {
    let mut out = map();
    for (&n, all) in by_node {
        // One report per packet, however many gateways heard it.
        let mut seen = crate::util::set();
        let rs: Vec<&Row> = all.iter().copied().filter(|r| seen.insert(r.lp)).collect();
        if rs.len() < ANCHOR_MIN_REPORTS {
            continue;
        }
        let pos = |r: &Row| r.pos().unwrap();
        // The most reported place, and the reports near it.
        let mut count: FxMap<(u64, u64, u32), usize> = map();
        for r in &rs {
            let p = pos(r);
            *count.entry((p.lat.to_bits(), p.lon.to_bits(), p.bits)).or_default() += 1;
        }
        let (mode, repeats) = count.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(k, v)| (*k, *v)).unwrap();
        // Precise GPS readings never repeat exactly. For a fixed node the
        // report nearest all the others (the medoid) is then the place they
        // scatter around (D-139); for others it is not used, since a slow,
        // steady mover's readings cluster around their middle too.
        let fixed = fixed.contains(&n);
        let m = if repeats >= 2 || !fixed {
            rs.iter().map(|r| pos(r)).find(|p| (p.lat.to_bits(), p.lon.to_bits(), p.bits) == mode).unwrap()
        } else {
            medoid(&rs)
        };
        let near = |p: &crate::row::Position| distance_m(LatLon { lat: m.lat, lon: m.lon }, LatLon { lat: p.lat, lon: p.lon }) <= move_threshold(fixed, (m.lat, bits(&m)), (p.lat, bits(p)));
        let inliers: Vec<crate::row::Position> = rs.iter().map(|r| pos(r)).filter(near).collect();
        // Most reports at that place, and at least two of the latest three: it
        // is home now (a node that has just left is not held back by its past).
        let recent = rs.iter().rev().take(3).filter(|r| near(&pos(r))).count();
        if inliers.len() * 2 < rs.len() || recent < 2 {
            continue;
        }
        let (lat, lon, radius_m) = narrow(&inliers, &m);
        // Never wider than the latest report itself.
        let last = pos(rs.last().unwrap());
        // The latest report wins only when it is finer: equally coarse, it may be noise.
        let (lat, lon, radius_m) = if near(&last) && err_m(&last) < 0.9 * radius_m { (last.lat, last.lon, err_m(&last)) } else { (lat, lon, radius_m) };
        out.insert(n, Anchor { lat, lon, radius_m, reports: rs.len(), agree: inliers.len(), narrowed: radius_m < 0.9 * err_m(&last) || inliers.len() < rs.len() });
    }
    out
}

/// The report with the least summed distance to the others (the newest 200).
fn medoid(rs: &[&Row]) -> crate::row::Position {
    let ps: Vec<crate::row::Position> = rs.iter().rev().take(200).map(|r| r.pos().unwrap()).collect();
    // A fixed node's reports lie within a few hundred metres: a flat frame
    // (degrees of latitude, and of longitude shrunk to them at the reports'
    // mean latitude) ranks the sums as haversine does, without the trig per
    // pair. Only which sum is least matters, so no metres.
    let k = (ps.iter().map(|p| p.lat).sum::<f64>() / ps.len() as f64).to_radians().cos();
    let xy: Vec<(f64, f64)> = ps.iter().map(|p| (p.lon * k, p.lat)).collect();
    // Each pair once: n²/2 distances.
    let mut sums = vec![0.0; ps.len()];
    for i in 0..ps.len() {
        for j in i + 1..ps.len() {
            let d = (xy[i].0 - xy[j].0).hypot(xy[i].1 - xy[j].1);
            sums[i] += d;
            sums[j] += d;
        }
    }
    let best = (0..ps.len()).min_by(|&a, &b| sums[a].total_cmp(&sums[b])).unwrap();
    ps[best]
}

/// Where the agreeing reports put the node, and how sure that is.
fn narrow(inliers: &[crate::row::Position], mode: &crate::row::Position) -> (f64, f64, f64) {
    let finest = inliers.iter().map(bits).max().unwrap_or(32);
    if finest >= 24 {
        // Precise readings: their mean, as sure as their spread allows.
        let fine: Vec<_> = inliers.iter().filter(|p| bits(p) >= 24).collect();
        let k = fine.len() as f64;
        let (lat, lon) = (fine.iter().map(|p| p.lat).sum::<f64>() / k, fine.iter().map(|p| p.lon).sum::<f64>() / k);
        let rms = (fine.iter().map(|p| distance_m(LatLon { lat, lon }, LatLon { lat: p.lat, lon: p.lon }).powi(2)).sum::<f64>() / k).sqrt();
        return (lat, lon, (2.0 * rms / k.sqrt()).max(10.0));
    }
    // Truncated cells. Design §6.10: a position shared with reduced precision
    // keeps that precision, so nothing finer than the node's own finest
    // report is inferred (no narrowing to an edge or corner between cells).
    // Among the agreeing reports at the finest precision, the most reported
    // cell (ties: the latest) is where it is.
    let finest = inliers.iter().map(|p| p.bits).max().unwrap_or(mode.bits);
    // (cell, reports, index of its latest report): inliers come in time order.
    let mut count: Vec<(&crate::row::Position, usize, usize)> = Vec::new();
    for (k, p) in inliers.iter().enumerate().filter(|(_, p)| p.bits == finest) {
        match count.iter_mut().find(|(q, _, _)| q.lat == p.lat && q.lon == p.lon) {
            Some(c) => {
                c.1 += 1;
                c.2 = k;
            }
            None => count.push((p, 1, k)),
        }
    }
    let best = count.iter().max_by_key(|(_, n, last)| (*n, *last)).map_or(mode, |(p, _, _)| p);
    (best.lat, best.lon, err_m(best))
}

/// Nodes that moved within `rows`, with their tracks. Anchored nodes
/// (`anchors`: home now, with most reports there) are left out: their
/// readings away from home are noise, not trips.
pub fn movements_except(rows: &[&Row], anchored: &FxMap<u32, Anchor>, fixed: &FxSet<u32>) -> FxMap<u32, Movement> {
    movements_of(&positions_by_node(rows), anchored, fixed)
}

/// Nodes that moved, from grouped position reports (`positions_by_node`),
/// leaving out anchored nodes (their tracks are not computed at all).
/// Nodes in `fixed` (their role sits in one place) need a far bigger jump (D-139).
pub fn movements_of(by_node: &FxMap<u32, Vec<&Row>>, anchored: &FxMap<u32, Anchor>, fixed: &FxSet<u32>) -> FxMap<u32, Movement> {
    let mut out = map();
    for (&n, rs) in by_node {
        if anchored.contains_key(&n) {
            continue;
        }
        let fixed = fixed.contains(&n);
        // One point per distinct place, in order (copies from several gateways collapse).
        let mut pts: Vec<&Row> = Vec::new();
        for &r in rs {
            let p = r.pos().unwrap();
            if pts.last().is_none_or(|l| {
                let q = l.pos().unwrap();
                q.lat != p.lat || q.lon != p.lon
            }) {
                pts.push(r);
            }
        }
        // Judge movement on its finest positions: a node that reports precise
        // Position packets and coarse map reports moves within the coarse
        // cells unseen, and mixing the two inflates the threshold.
        let mut at = [0u32; 33];
        for r in &pts {
            if let Some(n) = at.get_mut(bits(&r.pos().unwrap()) as usize) {
                *n += 1
            }
        }
        let finest = (0..=32u32).rev().find(|&b| at[b as usize] >= 2);
        let judged: Vec<&Row> = match finest {
            Some(b) => pts.iter().copied().filter(|r| bits(&r.pos().unwrap()) == b).collect(),
            None => pts.clone(),
        };
        // A single reading far from the ones either side, which agree with
        // each other, is a GPS spike: an excursion needs two reports.
        let far = |a: &Row, b: &Row| {
            let (p, q) = (a.pos().unwrap(), b.pos().unwrap());
            distance_m(LatLon { lat: p.lat, lon: p.lon }, LatLon { lat: q.lat, lon: q.lon }) > move_threshold(fixed, (p.lat, bits(&p)), (q.lat, bits(&q)))
        };
        let judged: Vec<&Row> = (0..judged.len())
            .filter(|&k| k == 0 || k + 1 == judged.len() || !(far(judged[k], judged[k - 1]) && far(judged[k], judged[k + 1]) && !far(judged[k - 1], judged[k + 1])))
            .map(|k| judged[k])
            .collect();
        let mut moved_at = None;
        let mut reference = judged[0].pos().unwrap();
        for r in &judged[1..] {
            let b = r.pos().unwrap();
            let d = distance_m(LatLon { lat: reference.lat, lon: reference.lon }, LatLon { lat: b.lat, lon: b.lon });
            if d > move_threshold(fixed, (reference.lat, bits(&reference)), (b.lat, bits(&b))) {
                moved_at = Some(r.t);
                reference = b;
            }
        }
        if let Some(moved_at) = moved_at {
            let skip = pts.len().saturating_sub(MAX_TRACK);
            let track = pts[skip..].iter().map(|r| {
                let p = r.pos().unwrap();
                TrackPoint { lat: p.lat, lon: p.lon, alt: p.alt, at: iso(r.t) }
            }).collect();
            out.insert(n, Movement { moved_at, track });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coarse_cells_need_a_bigger_jump() {
        assert_eq!(move_threshold(false, (60.0, 32), (60.0, 32)), MOVE_M);
        assert_eq!(move_threshold(true, (60.0, 32), (60.0, 32)), FIXED_MOVE_M);
        // 13 bits: cells of several kilometres, so jumping to the next one is not a move.
        assert!(move_threshold(false, (63.0, 13), (63.0, 13)) > 7_000.0);
    }

    #[test]
    fn positions_without_a_precision_still_move() {
        // A car sharing positions with no precision (bits 0, unknown) drives
        // 100 km: bits 0 read as precision would be a whole-earth cell.
        let at = |id: i64, lat: f64| {
            let mut r = crate::views::test_rows::pos(id, ty::POSITION, lat, 0, id * 600_000);
            r.pos.as_mut().unwrap().known = false;
            r
        };
        let rows: Vec<Row> = (0..10).map(|k| at(k + 1, 59.0 + 0.1 * k as f64)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let m = movements_except(&refs, &map(), &crate::util::set());
        assert!(m.get(&1).is_some_and(|m| m.moved_at > 0));
    }
}
