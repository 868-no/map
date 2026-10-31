//! Every mesh view, derived from the decoded observations of one window
//! (a port of the backend's internal/query via the TypeScript worker).
//! Callers pass only rows with observed_at in [start, end); filters narrow
//! them further. Output shapes are the API's.

use serde::{Deserialize, Serialize};

use crate::geo::{self, precision_error_m, Anchor, Estimate, Measurement};
use crate::graph::{self, distance_m, reduce, traceroute_samples, Edge, Ev, LatLon, RelayContext, SKey, Sample, Stats};
use crate::row::{ty, Interner, Position as RowPos, Row};
use crate::util::{iso, key_hex, map, node_id, set, FxMap, FxSet, BROADCAST};

pub const MAX_NODES: usize = 5000;
pub const MAX_EDGES: usize = 20000;

#[derive(Deserialize, Default, Clone)]
pub struct Filters {
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub brokers: Vec<String>,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub gateways: Vec<u32>,
}

/// Rows passing the filters (empty lists mean all).
pub fn apply_filters<'a>(rows: &'a [Row], f: &Filters, i: &Interner) -> Vec<&'a Row> {
    let ids = |v: &[String]| -> Option<FxSet<u32>> { (!v.is_empty()).then(|| v.iter().map(|s| i.get(s).unwrap_or(u32::MAX)).collect()) };
    let (ch, br, ty_) = (ids(&f.channels), ids(&f.brokers), ids(&f.types));
    let gw: Option<FxSet<u32>> = (!f.gateways.is_empty()).then(|| f.gateways.iter().copied().collect());
    rows.iter()
        .filter(|r| {
            ch.as_ref().is_none_or(|s| r.channel != 0 && s.contains(&r.channel))
                && br.as_ref().is_none_or(|s| s.contains(&r.broker))
                && gw.as_ref().is_none_or(|s| r.gw.is_some_and(|g| s.contains(&g)))
                && ty_.as_ref().is_none_or(|s| s.contains(&r.ty))
        })
        .collect()
}

// ---- output shapes (the API's) ----

#[derive(Serialize, Clone, Debug)]
pub struct Identity {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub long_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub short_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub hw_model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub role: String,
    pub has_public_key: bool,
    pub signature: String,
    pub observed_at: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Position {
    pub lat: f64,
    pub lon: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<i32>,
    pub precision_bits: u32,
    pub precision_known: bool,
    pub signature: String,
    pub observed_at: String,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Telemetry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voltage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ch_util: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub air_util: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u32>,
    pub observed_at: String,
}

#[derive(Serialize, Clone, Copy, Default, Debug)]
pub struct Signatures {
    pub verified: usize,
    pub unsigned: usize,
    pub unverifiable: usize,
    pub not_applicable: usize,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Clone, Debug)]
pub struct Node {
    pub id: String,
    pub num: u32,
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<Identity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<Telemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub packets: usize,
    pub receptions: usize,
    pub gateway_receptions: usize,
    pub is_gateway: bool,
    pub signatures: Signatures,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brokers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "is_false")]
    pub mqtt_opt_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate: Option<Estimate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_note: Option<String>,
    #[serde(skip)]
    first: i64,
    #[serde(skip)]
    last: i64,
    #[serde(skip)]
    pos: Option<RowPos>,
}

impl Node {
    fn new(n: u32) -> Self {
        Node {
            id: node_id(n), num: n, status: "observed", identity: None, position: None, telemetry: None, first_seen: None, last_seen: None,
            packets: 0, receptions: 0, gateway_receptions: 0, is_gateway: false, signatures: Signatures::default(), brokers: None,
            mqtt_opt_out: false, estimate: None, estimate_note: None, first: i64::MAX, last: i64::MIN, pos: None,
        }
    }
}

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

pub fn is_identity(r: &Row) -> bool {
    r.ty == ty::NODEINFO && !r.nodeinfo().is_some_and(|n| n.untrusted)
}
pub fn is_position(r: &Row) -> bool {
    (r.ty == ty::POSITION || r.ty == ty::MAPREPORT) && r.pos.is_some()
}
pub fn is_device_telemetry(r: &Row) -> bool {
    r.ty == ty::TELEMETRY && r.telemetry().is_some_and(|t| t.kind == ty::DEVICE)
}

fn identity_of(r: &Row, i: &Interner) -> Identity {
    let s = |x: Option<u32>| x.map_or(String::new(), |x| i.s(x).to_string());
    let n = r.nodeinfo();
    Identity {
        long_name: s(n.map(|n| n.long_name)),
        short_name: s(n.map(|n| n.short_name)),
        hw_model: s(n.map(|n| n.hw_model)),
        role: s(n.map(|n| n.role)),
        has_public_key: n.is_some_and(|n| n.has_public_key),
        signature: i.s(r.sig).to_string(),
        observed_at: iso(r.t),
    }
}

fn position_of(r: &Row, i: &Interner) -> Position {
    let p = r.pos.unwrap();
    Position { lat: p.lat, lon: p.lon, alt: p.alt, precision_bits: p.bits, precision_known: p.known, signature: i.s(r.sig).to_string(), observed_at: iso(r.t), source: i.s(r.ty).to_string() }
}

fn telemetry_of(r: &Row) -> Telemetry {
    let t = r.telemetry().unwrap();
    Telemetry { battery: t.battery, voltage: t.voltage, ch_util: t.ch_util, air_util: t.air_util, uptime: t.uptime, observed_at: iso(r.t) }
}

/// Between a node's latest Position packet and latest map report: when their
/// precision circles overlap they agree and the more precise one wins; when
/// they do not, the node may have moved and the newer one wins. Unknown
/// precision cannot be compared, so the newer one wins too.
pub fn choose_position<'a>(a: &'a Row, b: &'a Row) -> &'a Row {
    let (newer_, older) = if newer(a, b) { (b, a) } else { (a, b) };
    let (pa, pb) = (a.pos.unwrap(), b.pos.unwrap());
    if !pa.known || !pb.known {
        return newer_;
    }
    let d = distance_m(LatLon { lat: pa.lat, lon: pa.lon }, LatLon { lat: pb.lat, lon: pb.lon });
    if d > precision_error_m(pa.bits, pa.lat) + precision_error_m(pb.bits, pb.lat) {
        return newer_;
    }
    if older.pos.unwrap().bits > newer_.pos.unwrap().bits { older } else { newer_ }
}

/// Each node's position row: latest of each packet type, then choose_position.
fn position_rows<'a>(rows: &[&'a Row]) -> FxMap<u32, &'a Row> {
    let mut out = latest_by(rows, |r| r.ty == ty::POSITION && r.pos.is_some(), |r| r.src);
    for (n, r) in latest_by(rows, |r| r.ty == ty::MAPREPORT && r.pos.is_some(), |r| r.src) {
        let pick = match out.get(&n) {
            Some(p) => choose_position(p, r),
            None => r,
        };
        out.insert(n, pick);
    }
    out
}

struct Origin {
    first: i64,
    last: i64,
    packets: FxSet<u64>,
    receptions: FxSet<u64>,
    sig: FxMap<u32, FxSet<u64>>,
    brokers: FxSet<u32>,
    opt_out: bool,
}

fn origins(rows: &[&Row]) -> FxMap<u32, Origin> {
    let mut m: FxMap<u32, Origin> = map();
    for r in rows {
        let o = m.entry(r.src).or_insert_with(|| Origin { first: r.t, last: r.t, packets: set(), receptions: set(), sig: map(), brokers: set(), opt_out: false });
        o.first = o.first.min(r.t);
        o.last = o.last.max(r.t);
        o.packets.insert(r.lp);
        o.receptions.insert(r.ok);
        o.sig.entry(r.sig).or_insert_with(set).insert(r.lp);
        o.brokers.insert(r.broker);
        o.opt_out |= r.nk;
    }
    m
}

fn sig_counts(o: &Origin, i: &Interner) -> Signatures {
    let c = |s: &str| i.get(s).and_then(|id| o.sig.get(&id)).map_or(0, |x| x.len());
    Signatures { verified: c("verified"), unsigned: c("unsigned"), unverifiable: c("unverifiable"), not_applicable: c("not-applicable") }
}

fn brokers(o: &Origin, i: &Interner) -> Vec<String> {
    let mut b: Vec<String> = o.brokers.iter().map(|&x| i.s(x).to_string()).collect();
    b.sort();
    b
}

/// Nodes mentioned by NeighborInfo, valid traceroute hops or traceroute destinations.
pub fn referenced(rows: &[&Row]) -> FxSet<u32> {
    let mut out = set();
    let mut add = |n: u32| {
        if n > 0 && n < BROADCAST {
            out.insert(n);
        }
    };
    for r in rows {
        if r.ty == ty::NEIGHBORINFO {
            for &(id, _) in r.neighbors() {
                add(id);
            }
        }
        if r.ty == ty::TRACEROUTE {
            if let Some(t) = r.traceroute().filter(|t| t.valid) {
                for h in t.route.iter().chain(&t.route_back) {
                    if !h.unknown {
                        add(h.id);
                    }
                }
            }
            if let Some(d) = r.dst.filter(|&d| d != 0 && d != BROADCAST) {
                add(d);
            }
        }
    }
    out
}

pub struct EdgeResult {
    pub edges: Vec<Edge>,
    pub truncated: bool,
    pub ambiguous: usize,
    pub unmatched: usize,
}

/// Evidence-backed links. Relay bytes resolve only against known nodes,
/// their reported positions, and the roles that can rebroadcast.
pub fn build_edges(rows: &[&Row], known: &[u32], pos: FxMap<u32, LatLon>, silent: FxSet<u32>) -> (EdgeResult, RelayContext) {
    let mut samples: Vec<Sample> = Vec::new();
    // A. NeighborInfo: neighbour -> reporter, the first copy of each logical packet.
    let mut first_nb: Vec<&Row> = Vec::new();
    let mut nb_idx: FxMap<u64, usize> = map();
    for &r in rows {
        if r.ty != ty::NEIGHBORINFO {
            continue;
        }
        match nb_idx.get(&r.lp) {
            Some(&k) => {
                let cur = first_nb[k];
                if r.t < cur.t || (r.t == cur.t && r.id < cur.id) {
                    first_nb[k] = r
                }
            }
            None => {
                nb_idx.insert(r.lp, first_nb.len());
                first_nb.push(r)
            }
        }
    }
    for r in &first_nb {
        for &(id, snr) in r.neighbors() {
            samples.push(Sample { src: id, dst: r.src, ev: Ev::Neighbor, t: r.t, snr, rssi: None, key: SKey::Lp(r.lp) });
        }
    }
    // B. Traceroute: adjacent segments of every valid copy (deduplicated in reduce).
    for r in rows {
        if r.ty != ty::TRACEROUTE {
            continue;
        }
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            traceroute_samples(r.src, r.dst.unwrap_or(0), t.is_reply, &t.route, &t.snr_towards, &t.route_back, &t.snr_back, r.t, r.lp, &mut samples);
        }
    }
    // C/D. Gateway receptions: zero-hop RF -> source->gateway; relayed with a hint -> resolved after.
    let mut rx = first_per_reception(rows, |r| r.gw.is_some() && (r.dr || (r.rr == ty::RELAYED && r.relay.is_some())) && (r.snr.is_some() || r.rssi.is_some()));
    rx.sort_by_key(|r| r.id);
    let mut pending: Vec<(Sample, u8, u32, u32)> = Vec::new();
    for r in &rx {
        let s = Sample { src: 0, dst: r.gw.unwrap(), ev: Ev::DirectRf, t: r.t, snr: r.snr, rssi: r.rssi.map(|v| v as f64), key: SKey::Ok(r.ok) };
        if r.dr {
            samples.push(Sample { src: r.src, ..s });
        } else {
            pending.push((s, (r.relay.unwrap_or(0) & 0xff) as u8, r.src, r.gw.unwrap()));
        }
    }
    let confirmed: Vec<(u32, u32)> = samples.iter().filter(|s| s.ev != Ev::RelayHint).map(|s| (s.src, s.dst)).collect();
    let ctx = RelayContext::new(known.iter().copied(), pos, confirmed, silent);
    let (mut ambiguous, mut unmatched) = (0, 0);
    for (s, hint, origin, gw) in pending {
        match ctx.resolve(hint, origin, gw) {
            Some(Ok(n)) => samples.push(Sample { src: n, ev: Ev::RelayHint, ..s }),
            Some(Err(())) => ambiguous += 1,
            None => unmatched += 1,
        }
    }
    let mut edges = reduce(&samples);
    let truncated = edges.len() > MAX_EDGES;
    edges.truncate(MAX_EDGES);
    (EdgeResult { edges, truncated, ambiguous, unmatched }, ctx)
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
pub fn build_snapshot(rows: &[&Row], i: &Interner, g: &GeoOptions, silent_rule: bool) -> Built {
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
    let silent: FxSet<u32> = if silent_rule { roles.iter().filter(|(_, r)| is_silent_role(r)).map(|(&n, _)| n).collect() } else { set() };
    let (er, ctx) = build_edges(rows, &known, pos, silent);
    if g.enabled {
        estimate(&mut nodes, &er.edges, g);
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
    counts.edges = er.edges.len();
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

/// Estimates for unpositioned nodes from direct (non-relay) links to precise anchors.
fn estimate(nodes: &mut FxMap<u32, Node>, edges: &[Edge], g: &GeoOptions) {
    let mut anchors: FxMap<u32, Anchor> = map();
    for (&n, x) in nodes.iter() {
        if let Some(p) = x.pos.filter(|p| p.known && p.bits >= g.min_precision_bits && !g.exclude.contains(&n)) {
            anchors.insert(n, Anchor { node: n, lat: p.lat, lon: p.lon, err_m: precision_error_m(p.bits, p.lat) });
        }
    }
    struct Agg {
        snr_sum: f64,
        snr_w: f64,
        rssi_sum: f64,
        rssi_w: f64,
        samples: u32,
        first: i64,
        last: i64,
    }
    let mut links: FxMap<u32, Vec<(u32, Agg)>> = map(); // target -> (anchor, agg) in first-seen order
    let mut add = |target: u32, anchor: u32, e: &Edge| {
        let direct = e.evidence.direct();
        if direct == 0 {
            return;
        }
        let v = links.entry(target).or_default();
        let k = match v.iter().position(|(a, _)| *a == anchor) {
            Some(k) => k,
            None => {
                v.push((anchor, Agg { snr_sum: 0.0, snr_w: 0.0, rssi_sum: 0.0, rssi_w: 0.0, samples: 0, first: e.first, last: e.last }));
                v.len() - 1
            }
        };
        let a = &mut v[k].1;
        a.samples += direct;
        if let Some(m) = e.snr.median {
            a.snr_sum += m * e.snr.n as f64;
            a.snr_w += e.snr.n as f64;
        }
        if let Some(m) = e.rssi.median {
            a.rssi_sum += m * e.rssi.n as f64;
            a.rssi_w += e.rssi.n as f64;
        }
        a.first = a.first.min(e.first);
        a.last = a.last.max(e.last);
    };
    for e in edges {
        if anchors.contains_key(&e.src_num) {
            add(e.dst_num, e.src_num, e);
        }
        if anchors.contains_key(&e.dst_num) {
            add(e.src_num, e.dst_num, e);
        }
    }
    for (&n, x) in nodes.iter_mut() {
        if x.pos.is_some() || g.exclude.contains(&n) {
            continue;
        }
        let mut ms: Vec<Measurement> = links
            .get(&n)
            .map(|v| {
                v.iter()
                    .map(|(anchor, a)| Measurement {
                        anchor: *anchor,
                        samples: a.samples,
                        first: a.first,
                        last: a.last,
                        snr: (a.snr_w > 0.0).then(|| a.snr_sum / a.snr_w),
                        rssi: (a.rssi_w > 0.0).then(|| a.rssi_sum / a.rssi_w),
                    })
                    .collect()
            })
            .unwrap_or_default();
        ms.sort_by_key(|m| m.anchor);
        if ms.is_empty() {
            x.estimate_note = Some(format!("no confirmed direct links to nodes reporting a position with at least {}-bit precision", g.min_precision_bits));
            continue;
        }
        match geo::locate(&anchors, &ms, &g.params, node_id) {
            Ok(e) => x.estimate = Some(e),
            Err(reason) => x.estimate_note = Some(reason),
        }
    }
}

// ---- traffic ----

const BUCKET_LADDER: [i64; 5] = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
pub const MAX_BUCKETS: i64 = 600;

pub fn bucket_for(duration_ms: i64) -> i64 {
    for b in BUCKET_LADDER {
        if duration_ms / b <= MAX_BUCKETS {
            return b;
        }
    }
    BUCKET_LADDER[BUCKET_LADDER.len() - 1]
}

/// Go's time.Duration.String for the ladder values.
fn duration_string(ms: i64) -> String {
    let (h, m) = (ms / 3_600_000, ms % 3_600_000 / 60_000);
    if h > 0 { format!("{h}h{m}m0s") } else { format!("{m}m0s") }
}

#[derive(Serialize)]
pub struct Bucket {
    pub start: String,
    pub packets: usize,
    pub receptions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_type: Option<std::collections::BTreeMap<String, usize>>,
}

#[derive(Serialize)]
pub struct Traffic {
    pub bucket: String,
    pub buckets: Vec<Bucket>,
    pub packets: usize,
    pub receptions: usize,
}

/// Unique packets (in the bucket of their first in-window reception) counted
/// separately from receptions, so several gateways never inflate packets.
pub fn build_traffic(rows: &[&Row], start: i64, bucket: i64, i: &Interner) -> Traffic {
    let mut firsts: FxMap<u64, (i64, u32)> = map();
    let mut recs: FxMap<u64, i64> = map();
    for r in rows {
        firsts.entry(r.lp).and_modify(|f| {
            f.0 = f.0.min(r.t);
            if i.s(r.ty) < i.s(f.1) {
                f.1 = r.ty
            }
        }).or_insert((r.t, r.ty));
        recs.entry(r.ok).and_modify(|t| *t = (*t).min(r.t)).or_insert(r.t);
    }
    let bin = |t: i64| start + (t - start).div_euclid(bucket) * bucket;
    let mut buckets: std::collections::BTreeMap<i64, (usize, usize, std::collections::BTreeMap<String, usize>)> = Default::default();
    for &t in recs.values() {
        buckets.entry(bin(t)).or_default().1 += 1;
    }
    for &(t, typ) in firsts.values() {
        let b = buckets.entry(bin(t)).or_default();
        b.0 += 1;
        *b.2.entry(i.s(typ).to_string()).or_default() += 1;
    }
    Traffic {
        bucket: duration_string(bucket),
        packets: firsts.len(),
        receptions: recs.len(),
        buckets: buckets.into_iter().map(|(k, (p, rx, bt))| Bucket { start: iso(k), packets: p, receptions: rx, by_type: (p > 0).then_some(bt) }).collect(),
    }
}

// ---- node detail ----

const MAX_SAMPLES: usize = 500;
const MAX_PACKETS: usize = 100;
const MAX_GATEWAYED: usize = 200;

#[derive(Serialize)]
pub struct PositionSample {
    pub at: String,
    pub lat: f64,
    pub lon: f64,
    pub precision_bits: u32,
    pub precision_known: bool,
    pub signature: String,
}

#[derive(Serialize)]
pub struct TelemetrySample {
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voltage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ch_util: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub air_util: Option<f64>,
}

#[derive(Serialize)]
pub struct Hearing {
    pub node: String,
    pub receptions: usize,
    pub direct_rf: usize,
    pub snr: Stats,
    pub rssi: Stats,
    pub last_at: String,
}

#[derive(Serialize)]
pub struct PacketSummary {
    pub at: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub packet_id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    pub signature: String,
    pub crypto: String,
    pub receptions: usize,
    pub bytes: i32,
}

#[derive(Serialize)]
pub struct NodeDetail {
    #[serde(flatten)]
    pub node: Node,
    pub positions: Vec<PositionSample>,
    pub telemetry_series: Vec<TelemetrySample>,
    pub heard_by: Vec<Hearing>,
    pub heard: Vec<Hearing>,
    pub recent_packets: Vec<PacketSummary>,
    pub truncated: bool,
}

pub fn dest(d: Option<u32>) -> Option<String> {
    match d {
        None | Some(0) => None,
        Some(BROADCAST) => Some("broadcast".into()),
        Some(n) => Some(node_id(n)),
    }
}

/// One node's in-window details, or None when it is neither observed nor referenced.
pub fn build_node_detail(rows: &[&Row], num: u32, i: &Interner) -> Option<NodeDetail> {
    let mut n = Node::new(num);
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    let mut own: Vec<&Row> = Vec::new();
    let mut gw_rx = set::<u64>();
    for &r in rows {
        if r.src == num || r.gw == Some(num) {
            first = first.min(r.t);
            last = last.max(r.t);
        }
        if r.src == num {
            own.push(r);
        }
        if r.gw == Some(num) {
            gw_rx.insert(r.ok);
        }
    }
    if let Some(o) = origins(&own).get(&num) {
        n.packets = o.packets.len();
        n.receptions = o.receptions.len();
        n.signatures = sig_counts(o, i);
        n.brokers = Some(brokers(o, i));
        n.mqtt_opt_out = o.opt_out;
    }
    n.gateway_receptions = gw_rx.len();
    n.is_gateway = !gw_rx.is_empty();
    if let Some(r) = latest_by(&own, is_identity, |r| r.src).get(&num) {
        n.identity = Some(identity_of(r, i));
    }
    if let Some(r) = position_rows(&own).get(&num) {
        n.position = Some(position_of(r, i));
    }
    if let Some(r) = latest_by(&own, is_device_telemetry, |r| r.src).get(&num) {
        n.telemetry = Some(telemetry_of(r));
    }
    let mut d = NodeDetail { node: n, positions: vec![], telemetry_series: vec![], heard_by: vec![], heard: vec![], recent_packets: vec![], truncated: false };
    if first == i64::MAX {
        if !referenced(rows).contains(&num) {
            return None;
        }
        d.node.status = "referenced";
        return Some(d);
    }
    d.node.first_seen = Some(iso(first));
    d.node.last_seen = Some(iso(last));

    // One sample per logical packet (its first copy), capped in key order like the server.
    let per_packet = |keep: &dyn Fn(&Row) -> bool, truncated: &mut bool| -> Vec<&Row> {
        let mut m: FxMap<u64, &Row> = map();
        for &r in &own {
            if !keep(r) {
                continue;
            }
            m.entry(r.lp).and_modify(|cur| if r.t < cur.t || (r.t == cur.t && r.id < cur.id) { *cur = r }).or_insert(r);
        }
        let mut list: Vec<&Row> = m.into_values().collect();
        list.sort_by_key(|r| key_hex(r.lp));
        if list.len() > MAX_SAMPLES {
            list.truncate(MAX_SAMPLES);
            *truncated = true;
        }
        list.sort_by_key(|r| r.t);
        list
    };
    let mut truncated = false;
    d.positions = per_packet(&is_position, &mut truncated)
        .into_iter()
        .map(|r| {
            let p = r.pos.unwrap();
            PositionSample { at: iso(r.t), lat: p.lat, lon: p.lon, precision_bits: p.bits, precision_known: p.known, signature: i.s(r.sig).to_string() }
        })
        .collect();
    d.telemetry_series = per_packet(&is_device_telemetry, &mut truncated)
        .into_iter()
        .map(|r| {
            let t = r.telemetry().unwrap();
            TelemetrySample { at: iso(r.t), battery: t.battery, voltage: t.voltage, ch_util: t.ch_util, air_util: t.air_util }
        })
        .collect();
    d.truncated = truncated;
    d.heard_by = hearings(rows, |r| r.src == num && r.gw.is_some_and(|g| g != r.src), |r| r.gw.unwrap());
    d.heard = hearings(rows, |r| r.gw == Some(num) && r.src != num, |r| r.src);

    // Recent unique packets (no bodies, ever).
    let mut pk: FxMap<u64, Vec<&Row>> = map();
    for &r in &own {
        pk.entry(r.lp).or_default().push(r);
    }
    let min_str = |v: &mut dyn Iterator<Item = u32>| -> Option<String> { v.filter(|&x| x != 0).map(|x| i.s(x).to_string()).filter(|s| !s.is_empty()).min() };
    let mut recent: Vec<(i64, PacketSummary)> = pk
        .into_values()
        .map(|rs| {
            let at = rs.iter().map(|r| r.t).min().unwrap();
            let to = rs.iter().filter_map(|r| r.dst).min();
            (
                at,
                PacketSummary {
                    at: iso(at),
                    ty: min_str(&mut rs.iter().map(|r| r.ty)).unwrap_or_default(),
                    packet_id: rs.iter().filter_map(|r| r.pid).min().unwrap_or(0),
                    to: dest(to),
                    channel: min_str(&mut rs.iter().map(|r| r.channel)),
                    signature: min_str(&mut rs.iter().map(|r| r.sig)).unwrap_or_default(),
                    crypto: min_str(&mut rs.iter().map(|r| r.crypto)).unwrap_or_default(),
                    receptions: rs.iter().map(|r| r.ok).collect::<FxSet<u64>>().len(),
                    bytes: rs.iter().map(|r| r.bytes).min().unwrap_or(0),
                },
            )
        })
        .collect();
    recent.sort_by(|a, b| b.0.cmp(&a.0));
    recent.truncate(MAX_PACKETS);
    d.recent_packets = recent.into_iter().map(|(_, p)| p).collect();
    Some(d)
}

/// Receptions grouped by the other side; radio statistics from direct-RF receptions only.
fn hearings(rows: &[&Row], keep: impl Fn(&Row) -> bool, other: impl Fn(&Row) -> u32) -> Vec<Hearing> {
    let mut groups: FxMap<u32, Vec<&Row>> = map();
    for r in first_per_reception(rows, keep) {
        groups.entry(other(r)).or_default().push(r);
    }
    let mut out: Vec<(u32, Hearing)> = groups
        .into_iter()
        .map(|(k, rs)| {
            let direct: Vec<&&Row> = rs.iter().filter(|r| r.dr).collect();
            let snr: Vec<(i64, f64)> = direct.iter().filter_map(|r| r.snr.map(|v| (r.t, v))).collect();
            let rssi: Vec<(i64, f64)> = direct.iter().filter_map(|r| r.rssi.map(|v| (r.t, v as f64))).collect();
            (k, Hearing { node: node_id(k), receptions: rs.len(), direct_rf: direct.len(), snr: graph::stats(&snr, false), rssi: graph::stats(&rssi, false), last_at: iso(rs.iter().map(|r| r.t).max().unwrap()) })
        })
        .collect();
    out.sort_by(|a, b| b.1.receptions.cmp(&a.1.receptions).then(a.0.cmp(&b.0)));
    out.truncate(MAX_GATEWAYED);
    out.into_iter().map(|(_, h)| h).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::Position as P;

    fn pos(id: i64, ty: u32, lat: f64, bits: u32, t: i64) -> Row {
        Row {
            id, t, broker: 0, gw: None, src: 1, dst: None, pid: None, channel: 0, ty, lp: id as u64, ok: id as u64, snr: None, rssi: None, hs: None, hl: None,
            relay: None, sig: 0, dr: false, rr: 0, crypto: 0, bytes: 0, nk: false, pos: Some(P { lat, lon: 10.7, alt: None, bits, known: bits > 0 }), detail: None,
        }
    }

    #[test]
    fn choose_position_between_packet_and_map_report() {
        const H: i64 = 3_600_000;
        let (p, m) = (ty::POSITION, ty::MAPREPORT);
        // 14 bits: ~1.2 km error radius; 32 bits: exact. 200 m apart: overlapping.
        let cases = [
            ("overlap: precise older wins", pos(1, p, 61.2232, 32, 0), pos(2, m, 61.2250, 14, H), p),
            ("overlap: precise newer wins", pos(1, p, 61.2232, 13, 0), pos(2, m, 61.2250, 16, H), m),
            ("overlap, equal precision: newer", pos(1, p, 61.2232, 16, H), pos(2, m, 61.2233, 16, 0), p),
            ("apart (moving): newer despite lower precision", pos(1, p, 61.0, 32, 0), pos(2, m, 61.45, 14, H), m),
            ("unknown precision: newer", pos(1, p, 61.2232, 0, H), pos(2, m, 61.2232, 32, 0), p),
        ];
        for (name, a, b, want) in cases {
            assert_eq!(choose_position(&a, &b).ty, want, "{name}");
            assert_eq!(choose_position(&b, &a).ty, want, "{name} (swapped)");
        }
    }
}
