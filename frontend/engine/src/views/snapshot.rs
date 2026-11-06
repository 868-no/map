//! The snapshot: time-isolated nodes, links and counts.

use std::cell::OnceCell;

use serde::Serialize;

use super::estimate::estimate;
use super::{brokers, build_edges, downlinks, identity_of, identity_of_report, is_device_telemetry, is_identity, is_named_report, latest_by, origins, position_of, fresh_position_rows, referenced, sig_counts, telemetry_of, traceroute_hops, Contradiction, Node, RejectedPosition};
use crate::geo;
use crate::graph::{Edge, LatLon, RelayContext};
use crate::row::{Interner, Row};
use crate::util::{iso, map, set, FxMap, FxSet};

/// Nodes the snapshot keeps by default, the most active first (D-182).
pub const MAX_NODES: usize = 5000;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Counts {
    pub packets: usize,
    pub receptions: usize,
    pub nodes: usize,
    pub referenced: usize,
    pub positioned: usize,
    pub estimated: usize,
    pub edges: usize,
    pub by_type: std::collections::BTreeMap<String, usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_event: Option<String>,
    pub nodes_truncated: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Diagnostics {
    pub relay_ambiguous: usize,
    pub relay_unmatched: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Snapshot {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub edges_truncated: bool,
    pub counts: Counts,
    pub diagnostics: Diagnostics,
}

pub struct GeoOptions {
    pub enabled: bool,
    pub min_precision_bits: u32,
    pub exclude: FxSet<u32>,
    pub params: geo::Params,
    /// Line-of-sight classes of router links, by node pair (smaller id
    /// first), from the server's terrain cross sections (D-143).
    pub terrain: FxMap<(u32, u32), String>,
}

impl Default for GeoOptions {
    fn default() -> Self {
        GeoOptions { enabled: false, min_precision_bits: 15, exclude: set(), params: geo::Params::default(), terrain: map() }
    }
}

/// Snapshot plus the relay context it used (for packet logs, routes and
/// pings), and what the other views of the same window and filters share:
/// worked out once per build rather than on every view request. Row
/// positions index the rows the build was made from (Engine::rows).
#[derive(Default)]
pub struct Built {
    pub snapshot: Snapshot,
    /// Nodes past the snapshot's node limit (D-182), most active first:
    /// left off the map, but their panels show them as built here.
    pub beyond: Vec<Node>,
    pub ctx: RelayContext,
    pub roles: FxMap<u32, String>,
    /// Radio link readings, for link history (D-105).
    pub readings: super::link::LinkReadings,
    /// Every packet's radio copies with their transmitters (health's airtime).
    pub copies: crate::copies::Copies,
    /// Pairs a traceroute hop shows heard each other over the air (radio
    /// groups, node view).
    pub traceroute_contacts: Vec<(u32, u32)>,
    /// Position packets the radio rules out, by logical packet (D-178).
    pub rejected: FxMap<u64, Contradiction>,
    /// Radio groups and preset evidence (node view), made on first use.
    pub presets: OnceCell<crate::channels::PresetIndex>,
    /// Routing replies by what they answer (node view, packet log), made on first use.
    pub replies: OnceCell<crate::packets::ReplyIndex>,
}

/// Roles that never rebroadcast: a relay byte can never mean them.
pub fn is_silent_role(role: &str) -> bool {
    role == "CLIENT_MUTE"
}

/// Nodes that never rebroadcast in the window: their role now is one that
/// never does, and so was every role they reported in it. A node that
/// changed role (a router turned CLIENT_MUTE) relayed while it was a
/// router, and stays a relay candidate for the whole window (D-177).
fn silent_nodes(roles: &FxMap<u32, String>, nodeinfo: &[&Row], mapreport: &[&Row], i: &Interner) -> FxSet<u32> {
    let mut out: FxSet<u32> = roles.iter().filter(|(_, r)| is_silent_role(r)).map(|(&n, _)| n).collect();
    if out.is_empty() {
        return out;
    }
    let reported = nodeinfo.iter().filter(|r| is_identity(r)).filter_map(|r| r.nodeinfo().map(|n| (r.src, n.role)));
    for (n, role) in reported.chain(mapreport.iter().filter_map(|r| r.map_report().map(|m| (r.src, m.role)))) {
        if role != 0 && !is_silent_role(i.s(role)) {
            out.remove(&n);
        }
    }
    out
}

/// Time-isolated nodes, links and counts. rows: in-window and filtered.
/// Engine rules added after the server views were recorded (D-041); each can
/// be switched off to compare with them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rules {
    pub silent: bool,     // roles that never rebroadcast are no relay candidates
    pub mqtt_links: bool, // 0 dB traceroute hops are MQTT links, not radio (D-055)
    pub moves: bool,      // links use only evidence from after either end's latest move (D-073)
    pub signal: bool,     // a strong reading rules out relays too far away to give it (D-136)
    pub range: bool,      // the relay range rests on repeated links between nodes that stayed put (D-177)
    pub origin: bool,     // the originator is a candidate for its own byte (D-179)
    /// Nodes the snapshot keeps, the most active first; the rest are left out (D-182).
    pub max_nodes: usize,
}

impl Default for Rules {
    fn default() -> Self {
        Rules { silent: true, mqtt_links: true, moves: true, signal: true, range: true, origin: true, max_nodes: MAX_NODES }
    }
}

pub fn build_snapshot(rows: &[&Row], i: &Interner, g: &GeoOptions, rules: Rules) -> Built {
    let mut by = super::ByType::new(rows);
    // Positions the radio rules out are no position at all (D-178): every
    // consumer below (place, staleness, anchors, movement, links, estimates)
    // works without them.
    let rejected = if rules.signal { super::contradicted_positions(&by.positioned) } else { map() };
    let mut ruled_out: Vec<&Row> = Vec::new();
    if !rejected.is_empty() {
        let (keep, out) = by.positioned.iter().partition(|r| !rejected.contains_key(&r.lp));
        by.positioned = keep;
        ruled_out = out;
    }
    let mut nodes: FxMap<u32, Node> = map();
    for (n, o) in origins(rows, i) {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        x.first = o.first;
        x.last = o.last;
        x.packets = o.packets.len();
        x.receptions = o.receptions.len();
        x.own_uplinks = o.own_uplinks.len();
        x.signatures = sig_counts(&o);
        x.brokers = Some(brokers(&o, i));
        x.mqtt_opt_out = o.opt_out;
    }
    // Gateway activity (an unauthenticated MQTT claim, but still an in-window observation).
    // The same pass finds the window's latest observation (now, below).
    let mut gws: FxMap<u32, (i64, i64, FxSet<u64>)> = map();
    let mut now = 0;
    for r in rows {
        now = now.max(r.t);
        if let Some(g) = r.gw {
            let a = gws.entry(g).or_insert_with(|| (r.t, r.t, set()));
            a.0 = a.0.min(r.t);
            a.1 = a.1.max(r.t);
            a.2.insert(r.ok);
        }
    }
    let gateways: FxSet<u32> = gws.keys().copied().collect();
    for (n, (first, last, rx)) in gws {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        x.is_gateway = true;
        x.gateway_receptions = rx.len();
        x.first = x.first.min(first);
        x.last = x.last.max(last);
    }
    let hops = traceroute_hops(&by.traceroute);
    let downlinks = downlinks(&by.traceroute, &hops);
    let hops = hops.samples;
    for (n, d) in downlinks {
        // A node known only from others' traceroutes is named, not heard.
        nodes
            .entry(n)
            .or_insert_with(|| {
                let mut x = Node::new(n);
                x.status = "referenced";
                x
            })
            .mqtt_downlink = Some(d);
    }
    for (n, r) in latest_by(&by.nodeinfo, is_identity, |r| r.src) {
        nodes.entry(n).or_insert_with(|| Node::new(n)).identity = Some(identity_of(r, i));
    }
    for (n, r) in latest_by(&by.mapreport, is_named_report, |r| r.src) {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        if x.identity.is_none() {
            x.identity = Some(identity_of_report(r, i));
        }
    }
    // Positions reported more than a day (a week for fixed nodes) before the
    // window's latest observation are stale: no anchor, and the node is
    // estimated (D-094, D-138).
    let fixed: FxSet<u32> = nodes.iter().filter(|(_, x)| x.identity.as_ref().is_some_and(|id| super::node::fixed_role(&id.role))).map(|(&n, _)| n).collect();
    let (fresh, stale) = fresh_position_rows(&by.positioned, now, |n| fixed.contains(&n));
    for (n, r) in fresh {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        x.position = Some(position_of(r, i));
        x.pos = r.pos();
    }
    for (n, r) in stale {
        nodes.entry(n).or_insert_with(|| Node::new(n)).stale_position = Some(position_of(r, i));
    }
    for (n, r) in latest_by(&ruled_out, |_| true, |r| r.src) {
        let c = rejected[&r.lp];
        nodes.entry(n).or_insert_with(|| Node::new(n)).rejected_position =
            Some(RejectedPosition { position: position_of(r, i), gateway: crate::util::node_id(c.gateway), rssi: c.rssi, distance_m: c.distance_m.round(), bound_m: c.bound_m.round() });
    }
    for (n, r) in latest_by(&by.telemetry, is_device_telemetry, |r| r.src) {
        nodes.entry(n).or_insert_with(|| Node::new(n)).telemetry = Some(telemetry_of(r));
    }
    for (n, t) in referenced(by.neighborinfo.iter().chain(&by.traceroute)) {
        let x = nodes.entry(n).or_insert_with(|| {
            let mut x = Node::new(n);
            x.status = "referenced";
            x
        });
        if x.status == "referenced" {
            x.last_referenced = Some(iso(t));
        }
    }
    // A node that did not allow MQTT uplink is never named (D-032), even when
    // an older NodeInfo or a map report in the window carries its name.
    for x in nodes.values_mut().filter(|x| x.mqtt_opt_out) {
        if let Some(id) = x.identity.as_mut() {
            id.long_name.clear();
            id.short_name.clear();
        }
    }
    for x in nodes.values_mut() {
        if x.first != i64::MAX {
            x.first_seen = Some(iso(x.first));
            x.last_seen = Some(iso(x.last));
        }
    }

    let mut counts = window_counts(rows, i);
    let known: Vec<u32> = nodes.keys().copied().collect();
    let roles: FxMap<u32, String> = nodes.iter().filter_map(|(&n, x)| x.identity.as_ref().filter(|id| !id.role.is_empty()).map(|id| (n, id.role.clone()))).collect();
    let silent: FxSet<u32> = if rules.silent { silent_nodes(&roles, &by.nodeinfo, &by.mapreport, i) } else { set() };
    let downlinkers: FxSet<u32> = nodes.iter().filter(|(_, x)| x.mqtt_downlink.is_some()).map(|(&n, _)| n).collect();
    // Nodes whose reports jump around one place get a narrowed position, and
    // their jumps are not movement (D-077). Nodes that moved (D-073): their
    // trails, and links only from after the move.
    let tracks = crate::movement::positions_by_node(&by.positioned);
    let anchored = if rules.moves { crate::movement::anchors_of(&tracks, &fixed) } else { map() };
    for (n, a) in &anchored {
        if let Some(x) = nodes.get_mut(n) {
            x.set_anchor(a);
        }
    }
    // Relay range checks use the narrowed positions (§6.10): a single GPS
    // spike as the latest report must not widen the range for the window.
    let pos: FxMap<u32, LatLon> = nodes.iter().filter_map(|(&n, x)| x.pos.map(|p| (n, LatLon { lat: p.lat, lon: p.lon }))).collect();
    let moves = crate::movement::movements_of(&tracks, &anchored, &fixed);
    for (n, m) in &moves {
        if let Some(x) = nodes.get_mut(n) {
            x.set_movement(m);
        }
    }
    let moved: FxMap<u32, i64> = if rules.moves { moves.iter().map(|(&n, m)| (n, m.moved_at)).collect() } else { map() };
    // Movers' latest positions say nothing of where they relayed or heard
    // a copy: the signal rule leaves them out (D-153).
    let mobile: FxSet<u32> = moves.keys().copied().collect();
    let (mut er, mut ctx) = build_edges(rows, &by.neighborinfo, &hops, &known, pos, silent, rules.mqtt_links.then_some(&downlinkers), &moved, rules, mobile);
    if rules.mqtt_links {
        ctx.downlinkers = downlinkers;
    }
    // Directional 0-cost evidence on radio links (D-068).
    let hears: FxSet<(u32, u32)> = er.edges.iter().filter(|e| !e.mqtt).map(|e| (e.src_num, e.dst_num)).collect();
    // Every packet's copies, with the transmitter each was heard from: once for both passes below.
    let copies = crate::copies::Copies::new(rows, &ctx, &er.resolved);
    let mut zc = crate::zerocost::detect(&copies, rows, &hears, &roles);
    for g in crate::copies::multi_uplinkers(rows) {
        if let Some(x) = nodes.get_mut(&g) {
            x.multi_uplink = true;
        }
    }
    for e in er.edges.iter_mut().filter(|e| !e.mqtt) {
        e.zero_cost = zc.remove(&(e.src_num, e.dst_num));
    }
    // Routers' relaying, from the links and every packet's copies (D-078).
    for (n, r) in crate::reliability::relaying(&copies, rows, &gateways, &er.edges, &roles) {
        if let Some(x) = nodes.get_mut(&n) {
            x.relaying = Some(r);
        }
    }
    if g.enabled {
        estimate(&mut nodes, &er.edges, g); // radio edges only: it skips MQTT ones
    }
    let mut list: Vec<Node> = nodes.into_values().collect();
    for n in &list {
        if n.status == "observed" {
            counts.nodes += 1
        } else {
            counts.referenced += 1
        }
        if n.position.is_some() {
            counts.positioned += 1
        }
        if n.estimate.is_some() {
            counts.estimated += 1
        }
    }
    // Radio links as the map draws them: one per node pair, whichever directions were heard.
    counts.edges = er.edges.iter().filter(|e| !e.mqtt).map(|e| (e.src_num.min(e.dst_num), e.src_num.max(e.dst_num))).collect::<FxSet<_>>().len();
    list.sort_unstable_by(|a, b| (b.packets + b.gateway_receptions).cmp(&(a.packets + a.gateway_receptions)).then(a.num.cmp(&b.num)));
    let beyond = if list.len() > rules.max_nodes {
        counts.nodes_truncated = true;
        list.split_off(rules.max_nodes)
    } else {
        Vec::new()
    };
    Built {
        snapshot: Snapshot { nodes: list, edges: er.edges, edges_truncated: er.truncated, counts, diagnostics: Diagnostics { relay_ambiguous: er.ambiguous, relay_unmatched: er.unmatched } },
        beyond,
        ctx,
        roles,
        readings: super::link::LinkReadings::new(&er.samples),
        copies,
        traceroute_contacts: crate::channels::traceroute_contacts(&hops),
        rejected,
        presets: OnceCell::new(),
        replies: OnceCell::new(),
    }
}

fn window_counts(rows: &[&Row], i: &Interner) -> Counts {
    let mut receptions: FxSet<u64> = FxSet::with_capacity_and_hasher(rows.len(), Default::default());
    // Distinct (type, packet): packets per type, and packets as the distinct keys among them.
    let mut typed: FxSet<(u32, u64)> = FxSet::with_capacity_and_hasher(rows.len() / 2, Default::default());
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    for r in rows {
        receptions.insert(r.ok);
        typed.insert((r.ty, r.lp));
        first = first.min(r.t);
        last = last.max(r.t);
    }
    let mut by_type: FxMap<u32, usize> = map();
    let mut packets: FxSet<u64> = FxSet::with_capacity_and_hasher(typed.len(), Default::default());
    for &(t, lp) in &typed {
        *by_type.entry(t).or_default() += 1;
        packets.insert(lp);
    }
    Counts {
        packets: packets.len(),
        receptions: receptions.len(),
        by_type: by_type.into_iter().map(|(k, v)| (i.s(k).to_string(), v)).collect(),
        first_event: (!rows.is_empty()).then(|| iso(first)),
        last_event: (!rows.is_empty()).then(|| iso(last)),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::JRow;

    #[test]
    fn a_node_known_only_as_a_downlinker_is_named_not_heard() {
        // Traceroutes from three nodes (uplinked by gateway 7) reach node 9 at
        // exactly 0 dB; 9 itself never sends or uplinks anything.
        let mut i = Interner::default();
        let text: Vec<String> = (1..=3)
            .map(|k| (k, 10 + k))
            .map(|(k, s)| format!(r#"{{"i":{k},"t":{k},"b":"x","g":7,"s":{s},"d":4,"p":{k},"y":"traceroute","l":"{k:016x}","o":"{k:016x}","sg":"not-applicable","tr":{{"valid":true,"is_reply":false,"route":[{{"id":9}}],"snr_towards":[0.0,{k}.5]}}}}"#))
            .collect();
        let rows: Vec<Row> = text.iter().map(|t| serde_json::from_str::<JRow>(t).unwrap().into_row(&mut i)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let g = GeoOptions { enabled: false, min_precision_bits: 15, exclude: set(), params: Default::default(), terrain: map() };
        let b = build_snapshot(&refs, &i, &g, Rules::default());
        let n = b.snapshot.nodes.iter().find(|n| n.num == 9).expect("node 9 is listed");
        assert!(n.mqtt_downlink.is_some(), "it downlinks");
        assert_eq!(n.status, "referenced");
        assert!(n.last_referenced.is_some());
        assert_eq!(b.snapshot.counts.nodes, 4, "only the three senders and gateway 7 were heard");
    }
}
