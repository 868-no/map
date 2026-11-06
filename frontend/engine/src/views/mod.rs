//! Every mesh view, derived from the decoded observations of one window
//! (once a port of the backend's server views, which it replaced, D-041).
//! Callers pass only rows with observed_at in [start, end); filters narrow
//! them further. Output shapes are the API's.
//!
//! filters: the request's row filters. node: per-node shapes and the row
//! picks behind them. downlinks: probable MQTT downlinks (D-054). edges:
//! links, MQTT ones kept apart (D-055). snapshot: nodes, links and counts.
//! estimate: locations of unpositioned nodes. traffic: packets over time.
//! detail: one node's panel.

mod detail;
mod downlinks;
mod edges;
mod estimate;
mod filters;
mod node;
pub mod link;
mod snapshot;
mod traffic;

pub use detail::*;
pub use downlinks::*;
pub use edges::*;
pub use filters::*;
pub use node::*;
pub use snapshot::*;
pub use traffic::*;

use crate::row::{ty, Row};
use crate::util::{map, node_id, FxMap, BROADCAST};

pub fn dest(d: Option<u32>) -> Option<String> {
    match d {
        None | Some(0) => None,
        Some(BROADCAST) => Some("broadcast".into()),
        Some(n) => Some(node_id(n)),
    }
}

// ---- helpers ----

fn newer(a: &Row, b: &Row) -> bool {
    b.t > a.t || (b.t == a.t && b.id > a.id)
}

/// The window's rows of the packet types whose views look at only them, in
/// row order: one pass sorts them out, so those views skip the rest.
pub(crate) struct ByType<'a> {
    pub nodeinfo: Vec<&'a Row>,
    pub mapreport: Vec<&'a Row>,
    /// Position packets and map reports (both carry positions).
    pub positioned: Vec<&'a Row>,
    pub telemetry: Vec<&'a Row>,
    pub neighborinfo: Vec<&'a Row>,
    pub traceroute: Vec<&'a Row>,
}

impl<'a> ByType<'a> {
    pub fn new(rows: &[&'a Row]) -> Self {
        let mut b = ByType { nodeinfo: vec![], mapreport: vec![], positioned: vec![], telemetry: vec![], neighborinfo: vec![], traceroute: vec![] };
        for &r in rows {
            match r.ty {
                ty::NODEINFO => b.nodeinfo.push(r),
                ty::MAPREPORT => {
                    b.mapreport.push(r);
                    b.positioned.push(r);
                }
                ty::POSITION => b.positioned.push(r),
                ty::TELEMETRY => b.telemetry.push(r),
                ty::NEIGHBORINFO => b.neighborinfo.push(r),
                ty::TRACEROUTE => b.traceroute.push(r),
                _ => {}
            }
        }
        b
    }
}

/// Per key, the newest packet's latest copy by (observed_at, id), packets
/// ranked by their first copy: a late copy (a gateway uplinking an old packet
/// again, hours or days on) never makes its packet the newest, its contents
/// being as old as the packet (D-180).
fn latest_by<'a>(rows: &[&'a Row], keep: impl Fn(&Row) -> bool, key: impl Fn(&Row) -> u32) -> FxMap<u32, &'a Row> {
    // Per packet: its first copy and its latest.
    let mut copies: FxMap<u64, (&Row, &Row)> = map();
    for &r in rows {
        if !keep(r) {
            continue;
        }
        copies
            .entry(r.lp)
            .and_modify(|(first, last)| {
                if newer(r, first) {
                    *first = r
                }
                if newer(last, r) {
                    *last = r
                }
            })
            .or_insert((r, r));
    }
    let mut m: FxMap<u32, (&Row, &Row)> = map();
    for (first, last) in copies.into_values() {
        m.entry(key(last)).and_modify(|cur| if newer(cur.0, first) { *cur = (first, last) }).or_insert((first, last));
    }
    m.into_iter().map(|(k, (_, last))| (k, last)).collect()
}

/// One row per reception (observation key): the lowest id, in first-appearance order.
fn first_per_reception<'a>(rows: &[&'a Row], keep: impl Fn(&Row) -> bool) -> Vec<&'a Row> {
    let mut idx: FxMap<u64, usize> = map();
    let mut out: Vec<&Row> = Vec::new();
    for &r in rows {
        if !keep(r) {
            continue;
        }
        match idx.get(&r.ok) {
            Some(&k) => {
                if r.id < out[k].id {
                    out[k] = r
                }
            }
            None => {
                idx.insert(r.ok, out.len());
                out.push(r)
            }
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod test_rows {
    use crate::row::{Position as P, Row};

    /// A position row from node 1 (logical packet and reception keys = id).
    pub fn pos(id: i64, ty: u32, lat: f64, bits: u32, t: i64) -> Row {
        Row {
            id, t, broker: 0, gw: None, src: 1, dst: None, pid: None, channel: 0, ty, lp: id as u64, ok: id as u64, snr: None, rssi: None, hs: None, hl: None,
            relay: None, sig: 0, dr: false, rr: 0, crypto: 0, bytes: 0, nk: false, wa: false, topic: 0, pos: Some(Box::new(P { lat, lon: 10.7, alt: None, bits, known: bits > 0 })), detail: None,
        }
    }
}
