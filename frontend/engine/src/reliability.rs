//! How often routers are seen relaying what they should relay (D-078).
//!
//! A ROUTER or ROUTER_LATE rebroadcasts every packet it receives with hops
//! left (it never cancels for having heard others). It received a packet
//! when it uplinked it itself as a gateway, or when the packet came from a
//! transmitter it hears on a high-confidence link (3 samples or more), with
//! hops left.
//!
//! Its rebroadcast is seen when a gateway reports a copy whose last-hop byte
//! resolves to it, or a traceroute lists it. A gateway uplinks only the first
//! copy it hears, so a packet counts only where a witness — a gateway that
//! hears the router — uplinked the packet at all; even then the router's copy
//! stays invisible whenever another copy reached the witness first. The share
//! is therefore a lower bound on how often it relays: comparable between
//! routers of the same role and coverage, not an absolute reliability.
//! A witness that uplinks every copy it hears (D-084) reports the router's
//! copy even when another arrived first, so with such witnesses the share
//! comes closer to the real rate.

use serde::Serialize;

use crate::copies::Copies;
use crate::graph::Edge;
use crate::row::Row;
use crate::util::{map, set, FxMap, FxSet};

/// Packets needed before a share is shown.
pub const MIN_EXPECTED: usize = 10;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Relaying {
    /// Packets it received with hops left, where a witness gateway uplinked them.
    pub expected: usize,
    /// Of those, packets whose rebroadcast by it was reported.
    pub seen: usize,
    /// Gateways that hear it directly (its witnesses).
    pub witnesses: usize,
    /// Of `expected`, packets it uplinked itself (certain receptions); the
    /// rest are inferred from a strong link to the transmitter.
    pub received_as_gateway: usize,
}

/// Routers (ROUTER, ROUTER_LATE) with their relaying, keyed by node.
/// packets: every packet's radio copies (`copies::Copies` of `rows`); gateways:
/// every node that uplinked anything in the window.
pub fn relaying(packets: &Copies, rows: &[&Row], gateways: &FxSet<u32>, edges: &[Edge], roles: &FxMap<u32, String>) -> FxMap<u32, Relaying> {
    let routers: FxSet<u32> = roles.iter().filter(|(_, r)| matches!(r.as_str(), "ROUTER" | "ROUTER_LATE")).map(|(&n, _)| n).collect();
    // Who hears whom: (tx, rx).
    let mut witnesses: FxMap<u32, FxSet<u32>> = map(); // router -> gateways that hear it
    let mut strong: FxSet<(u32, u32)> = set(); // (tx, rx) high-confidence radio links
    for e in edges.iter().filter(|e| !e.mqtt && !e.inferred) {
        if routers.contains(&e.src_num) && gateways.contains(&e.dst_num) && e.dst_num != e.src_num && e.confidence != "low" {
            witnesses.entry(e.src_num).or_default().insert(e.dst_num);
        }
        if e.confidence == "high" && e.samples >= 3 {
            strong.insert((e.src_num, e.dst_num));
        }
    }
    // The routers each gateway witnesses: a packet can only count for
    // routers a gateway that uplinked it witnesses.
    let mut witnessed: FxMap<u32, Vec<u32>> = map();
    for (&router, ws) in &witnesses {
        for &w in ws {
            witnessed.entry(w).or_default().push(router);
        }
    }
    let mut acc: FxMap<u32, (usize, usize, usize)> = map(); // expected, seen, as gateway
    // Per-packet scratch, reused: a packet has few transmitters and gateways.
    let mut sent: Vec<(u32, i16)> = Vec::new(); // hop limit each transmitter sent (first copy)
    let mut uplinked: Vec<(u32, i16)> = Vec::new(); // gateway -> hop limit it received
    let mut traced: Vec<u32> = Vec::new();
    let mut cands: Vec<u32> = Vec::new();
    for copies in packets.packets(rows) {
        let origin = copies.first().row.src;
        let to = copies.first().row.dst;
        sent.clear();
        uplinked.clear();
        traced.clear();
        for h in copies.iter() {
            let r = h.row;
            let g = r.gw.unwrap();
            if let Some(hl) = r.hl {
                if !uplinked.iter().any(|x| x.0 == g) {
                    uplinked.push((g, hl));
                }
                if let Some(sender) = h.sender.filter(|&s| !sent.iter().any(|x| x.0 == s)) {
                    sent.push((sender, hl));
                }
            }
            if let Some(t) = r.traceroute().filter(|t| t.valid) {
                let hops = if t.is_reply { &t.route_back } else { &t.route };
                traced.extend(hops.iter().filter(|h| !h.unknown && Some(h.id) != r.gw).map(|h| h.id));
            }
        }
        // Routers with a witness that got the packet (a witness is never the
        // router itself); without one nothing could be seen.
        cands.clear();
        for &(g, _) in &uplinked {
            cands.extend(witnessed.get(&g).into_iter().flatten());
        }
        cands.sort_unstable();
        cands.dedup();
        for &router in &cands {
            if router == origin || to == Some(router) {
                continue; // its own packets, and packets for it, are not relayed
            }
            let own = uplinked.iter().any(|&(g, hl)| g == router && hl > 0);
            let inferred = !own && sent.iter().any(|&(u, l)| u != router && l > 0 && strong.contains(&(u, router)));
            if !own && !inferred {
                continue;
            }
            let e = acc.entry(router).or_default();
            e.0 += 1;
            if own {
                e.2 += 1;
            }
            if sent.iter().any(|x| x.0 == router) || traced.contains(&router) {
                e.1 += 1;
            }
        }
    }
    acc.into_iter()
        .map(|(n, (expected, seen, gw))| (n, Relaying { expected, seen, witnesses: witnesses.get(&n).map_or(0, |w| w.len()), received_as_gateway: gw }))
        .collect()
}
