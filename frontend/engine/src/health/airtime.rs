//! Airtime: an estimate of who keeps the channel busy, with the
//! store-and-forward part of it (D-103), and the issues it raises.

use serde::Serialize;

use super::Issues;
use crate::copies::Copies;
use crate::row::{Interner, Row};
use crate::util::{map, node_id, FxMap};

/// Share of the window's estimated airtime one node's packets may cause
/// before it is flagged.
pub const AIRTIME_WARN_SHARE: f64 = 0.10;
/// Share of the window's airtime one node's store-and-forward may take before it is noted.
pub const STORE_FORWARD_SHARE: f64 = 0.02;

/// One node's share of the window's estimated airtime.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct NodeAirtime {
    pub node: String,
    #[serde(skip)]
    pub num: u32,
    /// Its packets, including every rebroadcast of them seen (the airtime it causes).
    pub caused: f64,
    /// What it transmitted itself: its own packets and others' it relayed.
    pub transmitted: f64,
    pub packets: usize,
    /// Transmissions of its packets seen: its own plus relays'.
    pub transmissions: usize,
    /// Its caused airtime by packet type, as shares of `caused`, largest first.
    pub by_type: Vec<(String, f64)>,
}

/// One node's store-and-forward traffic (D-103).
#[derive(Serialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct StoreForwardNode {
    pub node: String,
    #[serde(skip)]
    pub num: u32,
    pub packets: usize,
    /// Share of the window's estimated airtime (its packets with rebroadcasts).
    pub share: f64,
    /// Packets by message kind, most first.
    pub by_kind: Vec<(String, usize)>,
    pub heartbeats_per_hour: f64,
    /// History replays (router_text_*): count and text bytes.
    pub replays: usize,
    pub replay_bytes: usize,
}

/// Store-and-forward's part of the airtime (D-103).
#[derive(Serialize, Debug, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct StoreForwardStats {
    pub packets: usize,
    pub share: f64,
    /// Packets and airtime share by message kind, most airtime first.
    pub by_kind: Vec<(String, usize, f64)>,
    pub nodes: Vec<StoreForwardNode>,
}

#[derive(Serialize, Debug, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Airtime {
    pub packets: usize,
    pub transmissions: usize,
    pub store_forward: StoreForwardStats,
    /// Share of the window's estimated airtime by packet type, largest first.
    pub by_type: Vec<(String, f64)>,
    /// Every node that caused or transmitted any, by caused share: the
    /// node panel shows any node's, so the list is never cut.
    pub nodes: Vec<NodeAirtime>,
}

fn pct(x: f64) -> String {
    if x >= 0.1 { format!("{:.0} %", x * 100.0) } else { format!("{:.1} %", x * 100.0) }
}

/// On-air size estimate of one packet: the 16-byte radio header, its
/// payload, the Data wrapper when we saw it decoded, and a 64-byte XEdDSA
/// signature plus its tag when it carried one.
fn wire_bytes(r: &Row, i: &Interner) -> f64 {
    let decoded = i.decoded(r.crypto);
    let signed = i.sig_rank(r.sig) >= 2; // verified or unverifiable
    16.0 + r.bytes.max(0) as f64 + if decoded { 4.0 } else { 0.0 } + if signed { 66.0 } else { 0.0 }
}

/// Relative airtime of one transmission: LoRa spends a fixed preamble and
/// header time on every packet, worth about 20 bytes at the presets used
/// here, plus time proportional to its size. Only shares are reported, so
/// the unit cancels out.
fn cost(r: &Row, i: &Interner) -> f64 {
    20.0 + wire_bytes(r, i)
}

/// Estimated airtime: every packet costs one transmission by its originator
/// plus one per distinct relay seen (resolved last hops, traceroute routes).
/// A lower bound: relays no gateway heard are missed. copies: every
/// packet's radio copies (`copies::Copies` of `rows`).
pub fn airtime(copies: &Copies, rows: &[&Row], i: &Interner, hours: f64) -> Airtime {
    let mut total = 0.0;
    let mut tx_total = 0;
    let mut types: FxMap<u32, f64> = map();
    #[derive(Default)]
    struct Acc {
        caused: f64,
        transmitted: f64,
        packets: usize,
        transmissions: usize,
        types: FxMap<u32, f64>,
    }
    let mut acc: FxMap<u32, Acc> = map();
    #[derive(Default)]
    struct Sf {
        packets: usize,
        air: f64,
        kinds: FxMap<u32, usize>,
        heartbeats: usize,
        replays: usize,
        replay_bytes: usize,
    }
    let mut sf: FxMap<u32, Sf> = map();
    let mut sf_kinds: FxMap<u32, (usize, f64)> = map();
    let (heartbeat, text_direct, text_broadcast) = (i.get("router_heartbeat"), i.get("router_text_direct"), i.get("router_text_broadcast"));
    let mut packets = 0;
    let mut relays: Vec<u32> = Vec::new(); // one packet's distinct relays (scratch)
    for group in copies.packets(rows) {
        let row = group.first().row;
        relays.clear();
        for h in group.iter() {
            if let Some(s) = h.sender.filter(|&s| s != row.src) {
                relays.push(s);
            }
            relays.extend(h.row.traced_relays().filter(|&x| x != row.src));
        }
        relays.sort_unstable();
        relays.dedup();
        packets += 1;
        let c = cost(row, i);
        let n = 1 + relays.len();
        let all = c * n as f64;
        if let Some(f) = row.store_forward() {
            let e = sf.entry(row.src).or_default();
            e.packets += 1;
            e.air += all;
            *e.kinds.entry(f.kind).or_default() += 1;
            if Some(f.kind) == heartbeat {
                e.heartbeats += 1;
            }
            if Some(f.kind) == text_direct || Some(f.kind) == text_broadcast {
                e.replays += 1;
                e.replay_bytes += f.text_bytes.max(0) as usize;
            }
            let k = sf_kinds.entry(f.kind).or_default();
            k.0 += 1;
            k.1 += all;
        }
        total += all;
        tx_total += n;
        *types.entry(row.ty).or_default() += all;
        let a = acc.entry(row.src).or_default();
        a.caused += all;
        a.transmitted += c;
        a.packets += 1;
        a.transmissions += n;
        *a.types.entry(row.ty).or_default() += all;
        for &relay in &relays {
            acc.entry(relay).or_default().transmitted += c;
        }
    }
    if total == 0.0 {
        return Airtime::default();
    }
    let shares = |m: FxMap<u32, f64>, of: f64| -> Vec<(String, f64)> {
        let mut v: Vec<(String, f64)> = m.into_iter().map(|(t, x)| (i.s(t).to_string(), x / of)).collect();
        v.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    };
    let mut nodes: Vec<NodeAirtime> = acc
        .into_iter()
        .map(|(n, a)| NodeAirtime { node: node_id(n), num: n, caused: a.caused / total, transmitted: a.transmitted / total, packets: a.packets, transmissions: a.transmissions, by_type: if a.caused > 0.0 { shares(a.types, a.caused) } else { vec![] } })
        .collect();
    nodes.sort_unstable_by(|a, b| b.caused.total_cmp(&a.caused).then(b.transmitted.total_cmp(&a.transmitted)).then(a.node.cmp(&b.node)));
    let hours = hours.max(1.0);
    let mut sf_nodes: Vec<StoreForwardNode> = sf
        .into_iter()
        .map(|(n, e)| {
            let mut by_kind: Vec<(String, usize)> = e.kinds.into_iter().map(|(k, c)| (i.s(k).to_string(), c)).collect();
            by_kind.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            StoreForwardNode { node: node_id(n), num: n, packets: e.packets, share: e.air / total, by_kind, heartbeats_per_hour: e.heartbeats as f64 / hours, replays: e.replays, replay_bytes: e.replay_bytes }
        })
        .collect();
    sf_nodes.sort_unstable_by(|a, b| b.share.total_cmp(&a.share).then(a.node.cmp(&b.node)));
    let mut by_kind: Vec<(String, usize, f64)> = sf_kinds.into_iter().map(|(k, (c, a))| (i.s(k).to_string(), c, a / total)).collect();
    by_kind.sort_unstable_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
    let store_forward = StoreForwardStats { packets: sf_nodes.iter().map(|x| x.packets).sum(), share: sf_nodes.iter().map(|x| x.share).sum(), by_kind, nodes: sf_nodes };
    Airtime { packets, transmissions: tx_total, store_forward, by_type: shares(types, total), nodes }
}

/// Nodes causing a large share of the airtime, and store-and-forward taking much of it.
pub(super) fn check(air: &Airtime, out: &mut Issues) {
    for a in air.nodes.iter().filter(|a| a.caused >= AIRTIME_WARN_SHARE) {
        let top: Vec<String> = a.by_type.iter().take(2).map(|(t, s)| format!("{t} {}", pct(*s))).collect();
        out.add(a.num, "airtime", "warning", format!("Causes {} of the airtime", pct(a.caused)), format!("Its {} packets and their {} transmissions seen make up about {} of the window's estimated airtime ({}).", a.packets, a.transmissions, pct(a.caused), top.join(", ")));
    }

    for f in air.store_forward.nodes.iter().filter(|f| f.share >= STORE_FORWARD_SHARE) {
        let kinds: Vec<String> = f.by_kind.iter().take(3).map(|(k, c)| format!("{c} {}", k.replace('_', " "))).collect();
        out.add(f.num, "store_forward", "notice", format!("Store-and-forward takes {} of the airtime", pct(f.share)), format!("{} store-and-forward packets ({}), {:.1} heartbeats per hour, {} history replays. Each heartbeat and replay is flooded like any packet; a longer heartbeat interval or a smaller history window would free airtime.", f.packets, kinds.join(", "), f.heartbeats_per_hour, f.replays));
    }
}
