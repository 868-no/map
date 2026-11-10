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
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Reached {
    pub id: String,
    /// The smallest hop limit at which this node receives the packet.
    pub need: u8,
    /// The transmitter it hears it from at that hop limit.
    pub via: String,
    /// The hop into it is a 0-cost link (it relays onwards for free).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub free: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Reach {
    pub origin: String,
    /// The hop limit its own packets were sent with (most common in the window).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
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
        if r.src == origin
            && let Some(h) = r.hs
        {
            *hs.entry(h).or_default() += 1;
        }
    }
    let hop_start = hs.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(h, _)| h.clamp(0, MAX_HOPS as i16) as u8);
    let mut nodes: Vec<Reached> = best.into_iter().map(|(n, (need, via, free))| Reached { id: node_id(n), need, via: node_id(via), free }).collect();
    nodes.sort_unstable_by(|a, b| a.need.cmp(&b.need).then(a.id.cmp(&b.id)));
    Reach { origin: node_id(origin), hop_start, internet, nodes }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::{Interner, JRow};
    use crate::util::set;
    use crate::zerocost::ZeroCost;

    fn link(src: u32, dst: u32) -> Edge {
        Edge { src_num: src, dst_num: dst, confidence: "high", ..Default::default() }
    }

    #[test]
    fn hop_limits_follow_relays_free_links_and_silent_nodes() {
        // 1 -> 2 -> 3 -> 4 with 3 CLIENT_MUTE; 2 -> 5 over MQTT; 4 -> 6 a
        // guess; 2 -> 7 a 0-cost link, then 7 -> 8 -> 9; 2 -> 1 back.
        let mut edges = vec![link(1, 2), link(2, 3), link(3, 4), link(2, 7), link(7, 8), link(8, 9), link(2, 1)];
        edges.push(Edge { mqtt: true, ..link(2, 5) });
        edges.push(Edge { inferred: true, ..link(4, 6) });
        edges[3].zero_cost = Some(ZeroCost { free: 5, spent: 0, likely: true });
        let silent: FxSet<u32> = [3].into_iter().collect();
        let mut i = Interner::default();
        let own: Vec<Row> = [(1, 3), (2, 3), (3, 4)]
            .iter()
            .map(|&(k, hs)| serde_json::from_str::<JRow>(&format!(r#"{{"i":{k},"t":{k},"b":"x","g":2,"s":1,"y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","hs":{hs}}}"#)).unwrap().into_row(&mut i))
            .collect();
        let refs: Vec<&Row> = own.iter().collect();
        let got = reach(1, &edges, &silent, false, &refs);
        let need: Vec<(&str, u8, &str, bool)> = got.nodes.iter().map(|r| (r.id.as_str(), r.need, r.via.as_str(), r.free)).collect();
        // 9 needs 2, not 3: 7 got it over a 0-cost link and passes it on with the hop unspent.
        assert_eq!(need, [("!00000002", 0, "!00000001", false), ("!00000003", 1, "!00000002", false), ("!00000007", 1, "!00000002", true), ("!00000008", 2, "!00000007", false), ("!00000009", 2, "!00000008", false)]);
        assert_eq!((got.hop_start, got.internet), (Some(3), false), "the hop limit most of its packets left with");
        let online = reach(1, &edges, &set(), true, &[]);
        assert!(online.nodes.iter().any(|r| r.id == "!00000005" && r.need == 1), "MQTT links with internet on");
        assert!(online.nodes.iter().any(|r| r.id == "!00000004" && r.need == 2), "3 relays once it is not silent");
        assert!(online.nodes.iter().all(|r| r.id != "!00000006" && r.id != "!00000001"), "no guesses, nor the origin");
    }
}
