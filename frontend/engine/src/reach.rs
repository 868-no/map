//! How far a node's packets reach at each hop limit (D-069).
//!
//! A packet leaves its originator with hop limit H. Nodes that hear it
//! directly receive it with H left. A node relays only what it received with
//! more than 0 left, and spends a hop doing so, except on a 0-cost link
//! (D-068): what it heard from a favourite router it passes on with the hop
//! limit unchanged. The first hop, from the originator, always costs one.
//! CLIENT_MUTE nodes never relay. So a node needs the smallest H at which
//! some transmitter it hears sends the packet: 0 for the originator's direct
//! hearers, otherwise the hops the relay before it had already spent plus
//! the one it needs left to relay at all.
//!
//! Only links observed in the window count (directed: the receiving end
//! heard the transmitting end), so the result is a sketch of the mesh as
//! seen, not a coverage prediction.

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use serde::Serialize;

use crate::graph::Edge;
use crate::row::Row;
use crate::util::{map, node_id, FxMap, FxSet};

/// Firmware's highest hop limit.
pub const MAX_HOPS: u8 = 7;

#[derive(Serialize, Debug, PartialEq)]
pub struct Reached {
    pub id: String,
    /// The smallest hop limit at which this node receives the packet.
    pub need: u8,
    /// The transmitter it hears it from at that hop limit.
    pub via: String,
    /// The hop into it is a 0-cost link (it relays onwards for free).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub free: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Reach {
    pub origin: String,
    /// The hop limit its own packets were sent with (most common in the window).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hop_start: Option<u8>,
    /// Internet (MQTT) links were followed too.
    pub internet: bool,
    pub nodes: Vec<Reached>,
}

/// edges: the window's links; silent: nodes that never relay; own: the
/// originator's rows (for its hop limit).
pub fn reach(origin: u32, edges: &[Edge], silent: &FxSet<u32>, internet: bool, own: &[&Row]) -> Reach {
    // Who hears whom: tx -> [(rx, free)]. Inferred links are guesses and stay out.
    let mut out: FxMap<u32, Vec<(u32, bool)>> = map();
    for e in edges {
        if e.inferred || (e.mqtt && !internet) {
            continue;
        }
        let free = e.zero_cost.is_some_and(|z| z.likely);
        out.entry(e.src_num).or_default().push((e.dst_num, free));
    }
    // Dijkstra over (node, came in free) by hops already spent on arrival.
    let mut spent: FxMap<(u32, bool), u8> = map();
    let mut best: FxMap<u32, (u8, u32, bool)> = map(); // node -> (need, via, free)
    let mut heap = BinaryHeap::new();
    for &(rx, _) in out.get(&origin).map_or(&[][..], |v| v) {
        if rx != origin {
            best.insert(rx, (0, origin, false));
            if spent.get(&(rx, false)).is_none_or(|&s| s > 0) {
                spent.insert((rx, false), 0);
                heap.push(Reverse((0u8, rx, false)));
            }
        }
    }
    while let Some(Reverse((s, x, free_in))) = heap.pop() {
        if spent.get(&(x, free_in)).is_some_and(|&v| v < s) || silent.contains(&x) {
            continue;
        }
        let need = s + 1; // x relays only with at least one hop left
        if need > MAX_HOPS {
            continue;
        }
        let sends = if free_in { s } else { s + 1 };
        for &(rx, free) in out.get(&x).map_or(&[][..], |v| v) {
            if rx == origin {
                continue;
            }
            if best.get(&rx).is_none_or(|&(n, _, _)| need < n) {
                best.insert(rx, (need, x, free));
            }
            if spent.get(&(rx, free)).is_none_or(|&v| sends < v) {
                spent.insert((rx, free), sends);
                heap.push(Reverse((sends, rx, free)));
            }
        }
    }
    let mut hs: FxMap<i16, usize> = map();
    for r in own {
        if r.src == origin {
            if let Some(h) = r.hs {
                *hs.entry(h).or_default() += 1;
            }
        }
    }
    let hop_start = hs.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(h, _)| h.clamp(0, MAX_HOPS as i16) as u8);
    let mut nodes: Vec<Reached> = best.into_iter().map(|(n, (need, via, free))| Reached { id: node_id(n), need, via: node_id(via), free }).collect();
    nodes.sort_by(|a, b| a.need.cmp(&b.need).then(a.id.cmp(&b.id)));
    Reach { origin: node_id(origin), hop_start, internet, nodes }
}
