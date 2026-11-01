//! The snapshot: time-isolated nodes, links and counts.

use serde::Serialize;

use super::estimate::estimate;
use super::{brokers, build_edges, downlinks, identity_of, is_device_telemetry, is_identity, latest_by, origins, position_of, position_rows, referenced, sig_counts, telemetry_of, Node};
use crate::geo;
use crate::graph::{Edge, LatLon, RelayContext};
use crate::row::{Interner, Row};
use crate::util::{iso, map, set, FxMap, FxSet};

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

#[derive(Serialize, Clone, Debug)]
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
}

impl Default for GeoOptions {
    fn default() -> Self {
        GeoOptions { enabled: false, min_precision_bits: 15, exclude: set(), params: geo::Params::default() }
    }
}

/// Snapshot plus the relay context it used (for packet logs, routes and pings).
pub struct Built {
    pub snapshot: Snapshot,
    pub ctx: RelayContext,
    pub roles: FxMap<u32, String>,
}

/// Roles that never rebroadcast: a relay byte can never mean them.
pub fn is_silent_role(role: &str) -> bool {
    role == "CLIENT_MUTE"
}

/// Time-isolated nodes, links and counts. rows: in-window and filtered.
/// Engine rules added after the server views were recorded (D-041); each can
/// be switched off to compare with them.
#[derive(Clone, Copy, Debug)]
pub struct Rules {
    pub silent: bool,     // roles that never rebroadcast are no relay candidates
    pub mqtt_links: bool, // 0 dB traceroute hops are MQTT links, not radio (D-055)
}

impl Default for Rules {
    fn default() -> Self {
        Rules { silent: true, mqtt_links: true }
    }
}

pub fn build_snapshot(rows: &[&Row], i: &Interner, g: &GeoOptions, rules: Rules) -> Built {
    let mut nodes: FxMap<u32, Node> = map();
    for (n, o) in origins(rows) {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        x.first = o.first;
        x.last = o.last;
        x.packets = o.packets.len();
        x.receptions = o.receptions.len();
        x.signatures = sig_counts(&o, i);
        x.brokers = Some(brokers(&o, i));
        x.mqtt_opt_out = o.opt_out;
    }
    // Gateway activity (an unauthenticated MQTT claim, but still an in-window observation).
    let mut gws: FxMap<u32, (i64, i64, FxSet<u64>)> = map();
    for r in rows {
        if let Some(g) = r.gw {
            let a = gws.entry(g).or_insert_with(|| (r.t, r.t, set()));
            a.0 = a.0.min(r.t);
            a.1 = a.1.max(r.t);
            a.2.insert(r.ok);
        }
    }
    for (n, (first, last, rx)) in gws {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        x.is_gateway = true;
        x.gateway_receptions = rx.len();
        x.first = x.first.min(first);
        x.last = x.last.max(last);
    }
    for (n, d) in downlinks(rows) {
        nodes.entry(n).or_insert_with(|| Node::new(n)).mqtt_downlink = Some(d);
    }
    for (n, r) in latest_by(rows, is_identity, |r| r.src) {
        nodes.entry(n).or_insert_with(|| Node::new(n)).identity = Some(identity_of(r, i));
    }
    for (n, r) in position_rows(rows) {
        let x = nodes.entry(n).or_insert_with(|| Node::new(n));
        x.position = Some(position_of(r, i));
        x.pos = r.pos;
    }
    for (n, r) in latest_by(rows, is_device_telemetry, |r| r.src) {
        nodes.entry(n).or_insert_with(|| Node::new(n)).telemetry = Some(telemetry_of(r));
    }
    for n in referenced(rows) {
        nodes.entry(n).or_insert_with(|| {
            let mut x = Node::new(n);
            x.status = "referenced";
            x
        });
    }
    for x in nodes.values_mut() {
        if x.first != i64::MAX {
            x.first_seen = Some(iso(x.first));
            x.last_seen = Some(iso(x.last));
        }
    }

    let mut counts = window_counts(rows, i);
    let known: Vec<u32> = nodes.keys().copied().collect();
    let pos: FxMap<u32, LatLon> = nodes.iter().filter_map(|(&n, x)| x.pos.map(|p| (n, LatLon { lat: p.lat, lon: p.lon }))).collect();
    let roles: FxMap<u32, String> = nodes.iter().filter_map(|(&n, x)| x.identity.as_ref().filter(|id| !id.role.is_empty()).map(|id| (n, id.role.clone()))).collect();
    let silent: FxSet<u32> = if rules.silent { roles.iter().filter(|(_, r)| is_silent_role(r)).map(|(&n, _)| n).collect() } else { set() };
    let downlinkers: FxSet<u32> = nodes.iter().filter(|(_, x)| x.mqtt_downlink.is_some()).map(|(&n, _)| n).collect();
    let (er, ctx) = build_edges(rows, &known, pos, silent, rules.mqtt_links.then_some(&downlinkers));
    if g.enabled {
        let radio: Vec<Edge> = er.edges.iter().filter(|e| !e.mqtt).cloned().collect();
        estimate(&mut nodes, &radio, g);
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
    counts.edges = er.edges.iter().filter(|e| !e.mqtt).count();
    list.sort_by(|a, b| (b.packets + b.gateway_receptions).cmp(&(a.packets + a.gateway_receptions)).then(a.num.cmp(&b.num)));
    if list.len() > MAX_NODES {
        list.truncate(MAX_NODES);
        counts.nodes_truncated = true;
    }
    Built {
        snapshot: Snapshot { nodes: list, edges: er.edges, edges_truncated: er.truncated, counts, diagnostics: Diagnostics { relay_ambiguous: er.ambiguous, relay_unmatched: er.unmatched } },
        ctx,
        roles,
    }
}

fn window_counts(rows: &[&Row], i: &Interner) -> Counts {
    let (mut packets, mut receptions) = (set::<u64>(), set::<u64>());
    let mut by_type: FxMap<u32, FxSet<u64>> = map();
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    for r in rows {
        packets.insert(r.lp);
        receptions.insert(r.ok);
        by_type.entry(r.ty).or_insert_with(set).insert(r.lp);
        first = first.min(r.t);
        last = last.max(r.t);
    }
    Counts {
        packets: packets.len(),
        receptions: receptions.len(),
        by_type: by_type.into_iter().map(|(k, v)| (i.s(k).to_string(), v.len())).collect(),
        first_event: (!rows.is_empty()).then(|| iso(first)),
        last_event: (!rows.is_empty()).then(|| iso(last)),
        ..Default::default()
    }
}
