//! Nodes that move (D-073).
//!
//! A node's reported positions in the window, in time order, are its track.
//! It moved when two consecutive positions lie further apart than a few
//! hundred metres beyond what their precision explains: a position truncated
//! to N bits can jump a whole cell while the node stands still, so the
//! threshold grows with both positions' worst-case error. The time of its
//! latest move is when its current place began; radio evidence from before
//! then describes another place, so links are built only from later samples.

use serde::Serialize;

use crate::geo::precision_error_m;
use crate::graph::{distance_m, LatLon};
use crate::row::{ty, Row};
use crate::util::{iso, map, FxMap};

/// Base distance for a move, before precision slack.
pub const MOVE_M: f64 = 300.0;
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

/// The distance two positions must exceed to count as a move.
pub fn move_threshold_m(a: (f64, u32), b: (f64, u32)) -> f64 {
    MOVE_M + PRECISION_SLACK * (precision_error_m(a.1, a.0) + precision_error_m(b.1, b.0))
}

/// Nodes that moved within `rows`, with their tracks.
pub fn movements(rows: &[&Row]) -> FxMap<u32, Movement> {
    let mut by_node: FxMap<u32, Vec<&Row>> = map();
    for &r in rows {
        if (r.ty == ty::POSITION || r.ty == ty::MAPREPORT) && r.pos.is_some() {
            by_node.entry(r.src).or_default().push(r);
        }
    }
    let mut out = map();
    for (n, mut rs) in by_node {
        rs.sort_by_key(|r| (r.t, r.id));
        // One point per distinct place, in order (copies from several gateways collapse).
        let mut pts: Vec<&Row> = Vec::new();
        for r in rs {
            let p = r.pos.unwrap();
            if pts.last().is_none_or(|l| {
                let q = l.pos.unwrap();
                q.lat != p.lat || q.lon != p.lon
            }) {
                pts.push(r);
            }
        }
        let mut moved_at = None;
        for w in pts.windows(2) {
            let (a, b) = (w[0].pos.unwrap(), w[1].pos.unwrap());
            let d = distance_m(LatLon { lat: a.lat, lon: a.lon }, LatLon { lat: b.lat, lon: b.lon });
            if d > move_threshold_m((a.lat, a.bits), (b.lat, b.bits)) {
                moved_at = Some(w[1].t);
            }
        }
        if let Some(moved_at) = moved_at {
            let skip = pts.len().saturating_sub(MAX_TRACK);
            let track = pts[skip..].iter().map(|r| {
                let p = r.pos.unwrap();
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
        assert_eq!(move_threshold_m((60.0, 32), (60.0, 32)), MOVE_M);
        // 13 bits: cells of several kilometres, so jumping to the next one is not a move.
        assert!(move_threshold_m((63.0, 13), (63.0, 13)) > 7_000.0);
    }
}
