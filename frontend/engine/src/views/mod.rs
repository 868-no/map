//! Every mesh view, derived from the decoded observations of one window
//! (a port of the backend's internal/query via the TypeScript worker).
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

use crate::row::Row;
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

/// Latest row per key by (observed_at, id).
fn latest_by<'a>(rows: &[&'a Row], keep: impl Fn(&Row) -> bool, key: impl Fn(&Row) -> u32) -> FxMap<u32, &'a Row> {
    let mut m: FxMap<u32, &Row> = map();
    for &r in rows {
        if !keep(r) {
            continue;
        }
        m.entry(key(r)).and_modify(|cur| if newer(cur, r) { *cur = r }).or_insert(r);
    }
    m
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
            relay: None, sig: 0, dr: false, rr: 0, crypto: 0, bytes: 0, nk: false, topic: 0, pos: Some(P { lat, lon: 10.7, alt: None, bits, known: bits > 0 }), detail: None,
        }
    }
}
