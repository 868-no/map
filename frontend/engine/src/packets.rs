//! Per-node packet logs, one packet's routing graph, and the transmissions
//! a live reception proves (for the radar-ping animation).

use serde::Serialize;

use crate::graph::{zero_cost_role, RelayContext};
use crate::row::{Interner, Row};
use crate::util::{iso, key_hex, map, node_id, set, FxMap, FxSet, BROADCAST};
use crate::views::dest;

pub const MAX_LOG: usize = 200;

#[derive(Serialize)]
pub struct OwnPacket {
    pub lp: String,
    pub at: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// The fewest hops any other gateway's copy shows (hop start minus hop
    /// limit; 0-cost relays do not count). Its own uplink and copies taken
    /// from MQTT (downlinked) are left out: they say nothing about the path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops: Option<i16>,
    /// Other gateways that uplinked it.
    pub gateways: usize,
    /// It uplinked it itself, as a gateway.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub by_itself: bool,
    /// Some copy reached a gateway through an MQTT downlink (D-087).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub downlinked: bool,
    pub receptions: usize,
    pub signature: String,
    /// ACKs and errors answering it, by who sent them (D-092).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub replies: Vec<Reply>,
    /// For a routing packet: what it says and which packet it answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Answer>,
    /// Type invalid: why its content was not kept (D-093).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid: Option<String>,
}

/// Routing packets from one node answering a packet: ACKs or one error.
#[derive(Serialize, Debug, PartialEq)]
pub struct Reply {
    pub from: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Distinct routing packets (a sender that retries gets each copy answered).
    pub count: usize,
}

/// What a routing packet says: ack or error, for the packet with this id.
#[derive(Serialize, Debug, PartialEq)]
pub struct Answer {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub request_id: u32,
    /// The answered packet's key, when it is in the window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub re: Option<String>,
}

/// A routing packet or encrypted direct message addressed to the node.
#[derive(Serialize)]
pub struct InboundPacket {
    pub lp: String,
    pub at: String,
    pub origin: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answers: Option<Answer>,
}

#[derive(Serialize)]
pub struct RelayedPacket {
    pub lp: String,
    pub at: String,
    pub origin: String,
    #[serde(rename = "type")]
    pub ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub evidence: Vec<&'static str>,
    pub gateways: Vec<String>,
}

#[derive(Serialize)]
pub struct PacketLog {
    pub own: Vec<OwnPacket>,
    pub relayed: Vec<RelayedPacket>,
    pub inbound: Vec<InboundPacket>,
    pub truncated: bool,
}

/// Signature statuses, weakest first: a packet's status is its best copy's
/// (relays can strip a signature; they cannot add one).
pub fn sig_rank(s: &str) -> u8 {
    match s {
        "verified" => 3,
        "unverifiable" => 2,
        "unsigned" => 1,
        _ => 0, // not-applicable
    }
}

/// Relaying is known from a gateway's last-hop byte resolving to the node
/// (same narrowing as links) or from the node in a traceroute's recorded
/// route; the uplinking gateway's own trailing entry only received it.
/// replies: made from the start of `rows` (the window's rows; the node's
/// invalid rows may follow).
pub fn packet_log(rows: &[&Row], num: u32, ctx: &RelayContext, replies: &ReplyIndex, i: &Interner) -> PacketLog {
    let mut own: FxMap<u64, Vec<&Row>> = map();
    struct Rel<'a> {
        first: i64,
        row: &'a Row,
        byte: bool,
        route: bool,
        gateways: FxSet<u32>,
    }
    let mut relayed: FxMap<u64, Rel> = map();
    let routing_ty = i.get("routing");
    let dm_ty = i.get("direct_message");
    let mut inbound: FxMap<u64, &Row> = map();
    let more = replies.more_ids(&rows[replies.rows.min(rows.len())..]);
    for &r in rows {
        if r.src == num {
            own.entry(r.lp).or_default().push(r);
            continue;
        }
        if r.dst == Some(num) && (Some(r.ty) == routing_ty || Some(r.ty) == dm_ty) {
            inbound.entry(r.lp).and_modify(|cur| if r.t < cur.t { *cur = r }).or_insert(r);
        }
        let mut note = |route: bool, gw: Option<u32>| {
            let e = relayed.entry(r.lp).or_insert_with(|| Rel { first: r.t, row: r, byte: false, route: false, gateways: set() });
            e.first = e.first.min(r.t);
            if route { e.route = true } else { e.byte = true }
            if let Some(g) = gw {
                e.gateways.insert(g);
            }
        };
        if let (Some(g), Some(relay)) = (r.gw, r.relay) {
            if g != num && !r.dr && r.rr == crate::row::ty::RELAYED && (relay & 0xff) as u32 == (num & 0xff) && ctx.resolve((relay & 0xff) as u8, r.src, g) == Some(Ok(num)) {
                note(false, Some(g));
            }
        }
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            let mut hops: &[crate::row::Hop] = if t.is_reply { &t.route_back } else { &t.route };
            if hops.last().is_some_and(|h| Some(h.id) == r.gw) {
                hops = &hops[..hops.len() - 1];
            }
            if hops.iter().any(|h| !h.unknown && h.id == num) {
                note(true, None);
            }
        }
    }
    let n_own = own.len();
    let n_rel = relayed.len();
    let mut own_list: Vec<(i64, OwnPacket)> = own
        .into_values()
        .map(|rs| {
            let first = rs.iter().copied().reduce(|a, b| if b.t < a.t { b } else { a }).unwrap();
            use crate::row::ty;
            let others: Vec<&Row> = rs.iter().copied().filter(|r| r.gw.is_some_and(|g| g != num)).collect();
            let radio = |r: &&&Row| r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF;
            let hops = others.iter().filter(radio).filter_map(|r| r.hops()).min();
            let best = rs.iter().map(|r| i.s(r.sig)).max_by_key(|s| sig_rank(s)).unwrap_or("unsigned");
            (
                first.t,
                OwnPacket {
                    lp: key_hex(first.lp),
                    at: iso(first.t),
                    ty: i.s(first.ty).to_string(),
                    to: dest(first.dst),
                    channel: (first.channel != 0).then(|| i.s(first.channel).to_string()),
                    hops,
                    gateways: others.iter().filter_map(|r| r.gw).collect::<FxSet<u32>>().len(),
                    by_itself: rs.iter().any(|r| r.gw == Some(num)),
                    downlinked: others.iter().any(|r| ctx.downlinked(r)),
                    receptions: rs.iter().map(|r| r.ok).collect::<FxSet<u64>>().len(),
                    signature: best.to_string(),
                    replies: first.pid.map_or(vec![], |p| replies.replies(p, num, rows, i)),
                    answers: replies.answer(first, &more, i),
                    invalid: first.invalid().map(|v| i.s(v).to_string()),
                },
            )
        })
        .collect();
    let mut rel_list: Vec<(i64, RelayedPacket)> = relayed
        .into_values()
        .map(|e| {
            let mut gws: Vec<u32> = e.gateways.into_iter().collect();
            gws.sort();
            let mut evidence = vec![];
            if e.byte {
                evidence.push("relay_byte");
            }
            if e.route {
                evidence.push("traceroute");
            }
            (e.first, RelayedPacket { lp: key_hex(e.row.lp), at: iso(e.first), origin: node_id(e.row.src), ty: i.s(e.row.ty).to_string(), to: dest(e.row.dst), evidence, gateways: gws.into_iter().map(node_id).collect() })
        })
        .collect();
    let n_in = inbound.len();
    let mut in_list: Vec<(i64, InboundPacket)> =
        inbound.into_values().map(|r| (r.t, InboundPacket { lp: key_hex(r.lp), at: iso(r.t), origin: node_id(r.src), ty: i.s(r.ty).to_string(), answers: replies.answer(r, &more, i) })).collect();
    own_list.sort_by(|a, b| b.0.cmp(&a.0));
    rel_list.sort_by(|a, b| b.0.cmp(&a.0));
    in_list.sort_by(|a, b| b.0.cmp(&a.0));
    own_list.truncate(MAX_LOG);
    rel_list.truncate(MAX_LOG);
    in_list.truncate(MAX_LOG);
    PacketLog {
        own: own_list.into_iter().map(|x| x.1).collect(),
        relayed: rel_list.into_iter().map(|x| x.1).collect(),
        inbound: in_list.into_iter().map(|x| x.1).collect(),
        truncated: n_own > MAX_LOG || n_rel > MAX_LOG || n_in > MAX_LOG,
    }
}

/// Routing packets by the packet they answer, and packets by sender and id,
/// to pair ACKs and errors with what they answer (D-092). A routing packet
/// is addressed to the original's sender and carries its packet id; an
/// error may come from a relay rather than the destination, so the
/// answering node is not required to be the original's destination. Rows
/// are positions in the rows it was made from, so one index per build
/// serves every view (views::Built).
#[derive(Default)]
pub struct ReplyIndex {
    by_request: FxMap<(u32, u32), Vec<u32>>, // (request id, addressed to) -> rows
    by_id: FxMap<(u32, u32), u64>,           // (sender, packet id) -> packet key
    /// How many rows it was made from.
    pub rows: usize,
}

impl ReplyIndex {
    pub fn new(rows: &[&Row]) -> Self {
        let mut ix = ReplyIndex { by_request: map(), by_id: map(), rows: rows.len() };
        for (k, &r) in rows.iter().enumerate() {
            if let (Some(rt), Some(d)) = (r.routing(), r.dst) {
                if rt.request != 0 {
                    ix.by_request.entry((rt.request, d)).or_default().push(k as u32);
                }
            }
            if let Some(p) = r.pid.filter(|&p| p != 0) {
                ix.by_id.entry((r.src, p)).or_insert(r.lp);
            }
        }
        ix
    }

    /// Packet ids of `more` rows (after those it was made from) that the
    /// index does not know, for `answer`.
    pub fn more_ids(&self, more: &[&Row]) -> FxMap<(u32, u32), u64> {
        let mut out: FxMap<(u32, u32), u64> = map();
        for r in more {
            if let Some(p) = r.pid.filter(|&p| p != 0 && !self.by_id.contains_key(&(r.src, p))) {
                out.entry((r.src, p)).or_insert(r.lp);
            }
        }
        out
    }

    /// Replies to `sender`'s packet `pid`, grouped by who answered and how.
    /// rows: those it was made from.
    pub fn replies(&self, pid: u32, sender: u32, rows: &[&Row], i: &Interner) -> Vec<Reply> {
        let Some(rs) = self.by_request.get(&(pid, sender)) else { return vec![] };
        let mut groups: FxMap<(u32, u32, u32), FxSet<u64>> = map();
        let mut order = vec![];
        for &k in rs {
            let r = rows[k as usize];
            let rt = r.routing().unwrap();
            let k = (r.src, rt.kind, rt.error);
            groups.entry(k).or_insert_with(|| {
                order.push(k);
                set()
            });
            groups.get_mut(&k).unwrap().insert(r.lp);
        }
        order.into_iter().map(|k| Reply { from: node_id(k.0), kind: i.s(k.1).to_string(), error: (k.2 != 0).then(|| i.s(k.2).to_string()), count: groups[&k].len() }).collect()
    }

    /// What a routing packet says, and the answered packet when known
    /// (`more`: ids from more_ids).
    pub fn answer(&self, r: &Row, more: &FxMap<(u32, u32), u64>, i: &Interner) -> Option<Answer> {
        let rt = r.routing()?;
        let re = r.dst.and_then(|d| self.by_id.get(&(d, rt.request)).or_else(|| more.get(&(d, rt.request)))).map(|&lp| key_hex(lp));
        Some(Answer { kind: i.s(rt.kind).to_string(), error: (rt.error != 0).then(|| i.s(rt.error).to_string()), request_id: rt.request, re })
    }
}

/// A node's routing traffic in the window: ACKs and errors it sent, and
/// those addressed to it, errors by firmware reason (D-092).
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Delivery {
    pub acks_sent: usize,
    pub acks_received: usize,
    pub errors_sent: Vec<(String, usize)>,
    pub errors_received: Vec<(String, usize)>,
}

pub fn delivery(rows: &[&Row], num: u32, i: &Interner) -> Option<Delivery> {
    let ack = i.get("ack");
    let (mut sent, mut recv): (FxMap<u64, &Row>, FxMap<u64, &Row>) = (map(), map());
    for &r in rows {
        if r.routing().is_none() {
            continue;
        }
        if r.src == num {
            sent.insert(r.lp, r);
        } else if r.dst == Some(num) {
            recv.insert(r.lp, r);
        }
    }
    if sent.is_empty() && recv.is_empty() {
        return None;
    }
    let tally = |m: &FxMap<u64, &Row>| -> (usize, Vec<(String, usize)>) {
        let mut acks = 0;
        let mut errs: FxMap<u32, usize> = map();
        for r in m.values() {
            let rt = r.routing().unwrap();
            if Some(rt.kind) == ack {
                acks += 1;
            } else if rt.error != 0 {
                *errs.entry(rt.error).or_default() += 1;
            }
        }
        let mut v: Vec<(String, usize)> = errs.into_iter().map(|(e, n)| (i.s(e).to_string(), n)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        (acks, v)
    };
    let (acks_sent, errors_sent) = tally(&sent);
    let (acks_received, errors_received) = tally(&recv);
    Some(Delivery { acks_sent, acks_received, errors_sent, errors_received })
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RouteSegment {
    pub a: String,
    pub b: String,
    pub dashed: bool,
    pub why: &'static str,
}

#[derive(Serialize)]
pub struct PacketRoute {
    pub origin: String,
    #[serde(rename = "type")]
    pub ty: String,
    /// When it was first heard: where moved nodes were then (D-073).
    pub at: String,
    pub segments: Vec<RouteSegment>,
    pub receptions: usize,
    /// Nodes whose ACK confirms they received it (D-096).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub delivered: Vec<String>,
}

/// One packet's routing graph from every in-window reception of it.
/// Segments are transmitter -> receiver; dashed where nodes are missing.
/// `acked`: nodes whose ACK answered it; each gets a "delivered" segment
/// from the origin (the path is unknown, so dashed) unless one is drawn (D-096).
pub fn packet_route(rows: &[&Row], ctx: &RelayContext, roles: &FxMap<u32, String>, i: &Interner, acked: &[u32]) -> PacketRoute {
    let Some(first) = rows.first() else {
        return PacketRoute { origin: String::new(), ty: String::new(), at: String::new(), segments: vec![], receptions: 0, delivered: vec![] };
    };
    let origin = first.src;
    let mut order: Vec<(u32, u32)> = Vec::new();
    let mut segs: FxMap<(u32, u32), (bool, &'static str)> = map();
    let mut add = |a: u32, b: u32, dashed: bool, why: &'static str| {
        if a == b {
            return;
        }
        match segs.get_mut(&(a, b)) {
            Some(cur) => {
                if cur.0 && !dashed {
                    *cur = (false, why)
                }
            }
            None => {
                segs.insert((a, b), (dashed, why));
                order.push((a, b));
            }
        }
    };
    use crate::row::ty;
    for r in rows {
        let Some(gw) = r.gw.filter(|&g| g != origin) else { continue };
        let over_radio = r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF;
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            let (mut last, mut gap) = (origin, false);
            for (n, internet) in traceroute_chain(r, t, gw, over_radio, ctx).into_iter().skip(1) {
                match n {
                    None => gap = true,
                    Some(n) => {
                        add(last, n, gap, if internet { "internet" } else if gap { "gap" } else { "traceroute" });
                        last = n;
                        gap = false;
                    }
                }
            }
            continue;
        }
        if !over_radio && !ctx.downlinked(r) {
            continue; // not heard over radio
        }
        if r.dr || r.rr == ty::NO_RX_METRICS {
            add(origin, gw, false, "direct");
            continue;
        }
        match r.relay.and_then(|b| ctx.resolve((b & 0xff) as u8, origin, gw)) {
            Some(Ok(relay)) if ctx.downlinked(r) => {
                // Taken from MQTT and transmitted with no hops left (D-087).
                add(relay, gw, false, "relay");
                add(origin, relay, true, "internet");
            }
            Some(Ok(relay)) => {
                add(relay, gw, false, "relay");
                // One hop spent, by a relay that cannot receive at zero cost: it heard the sender itself.
                let direct = r.hops() == Some(1) && roles.get(&relay).is_some_and(|ro| !ro.is_empty() && !zero_cost_role(ro));
                add(origin, relay, !direct, if direct { "relay" } else { "gap" });
            }
            _ if ctx.downlinked(r) => add(origin, gw, true, "internet"),
            _ => add(origin, gw, true, "unknown_relay"),
        }
    }
    for &n in acked {
        add(origin, n, true, "delivered");
    }
    PacketRoute {
        origin: node_id(origin),
        ty: i.s(first.ty).to_string(),
        at: iso(rows.iter().map(|r| r.t).min().unwrap_or(first.t)),
        segments: order.into_iter().map(|(a, b)| {
            let (dashed, why) = segs[&(a, b)];
            RouteSegment { a: node_id(a), b: node_id(b), dashed, why }
        }).collect(),
        receptions: rows.iter().map(|r| r.ok).collect::<FxSet<u64>>().len(),
        delivered: acked.iter().map(|&n| node_id(n)).collect(),
    }
}

/// A traceroute copy's path, origin first: each node (None where unknown)
/// with whether the hop into it crossed the internet (exactly 0 dB into a
/// probable downlinker, D-054). The uplinking gateway ends it when the copy
/// reached it over the air.
fn traceroute_chain(r: &Row, t: &crate::row::Traceroute, gw: u32, over_radio: bool, ctx: &RelayContext) -> Vec<(Option<u32>, bool)> {
    let (hops, snr) = if t.is_reply { (&t.route_back, &t.snr_back) } else { (&t.route, &t.snr_towards) };
    let mut chain: Vec<(Option<u32>, bool)> = vec![(Some(r.src), false)];
    for (k, h) in hops.iter().enumerate() {
        let n = (!h.unknown).then_some(h.id);
        let internet = n.is_some_and(|n| ctx.downlinkers.contains(&n)) && snr.get(k).copied().flatten() == Some(0.0);
        chain.push((n, internet));
    }
    if over_radio && chain.last().and_then(|c| c.0) != Some(gw) {
        chain.push((Some(gw), false));
    }
    chain
}

// ---- live pings ----

/// Who transmitted, and (if known) who heard that transmission directly.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Transmission {
    pub key: String, // packet + transmitter: one ping per RF transmission
    pub tx: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rx: Option<String>,
    pub rebroadcast: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strength: Option<f64>, // 0..1 signal at rx, when rx is the reporting gateway
    /// Not a radio transmission: an ACK proving `rx` received `tx`'s packet,
    /// by whatever path (D-096).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub delivered: bool,
    /// The packet transmitted, as "origin:id" (hex): ties a replayed route to
    /// the live packet it describes (D-106).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet: Option<String>,
    /// Reconstructed after the fact (a traceroute reply's record of its
    /// request's way), not seen as it happened: skipped when that packet was
    /// already animated (D-106).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub replay: bool,
}

fn packet_ref(origin: u32, id: u32) -> String {
    format!("{origin:08x}:{id:08x}")
}

/// A traceroute reply records the way its request travelled: requester ->
/// route -> target, with the SNR at each receiver. Replayed as transmissions
/// of the request (D-106); hops into a probable downlinker at exactly 0 dB
/// went over the internet and are not radio.
pub fn forward_route(r: &Row, ctx: &RelayContext) -> Vec<Transmission> {
    let Some(t) = r.traceroute().filter(|t| t.valid && t.is_reply && t.request != 0) else { return vec![] };
    let Some(requester) = r.dst.filter(|&d| d != BROADCAST && d != r.src) else { return vec![] };
    let packet = packet_ref(requester, t.request);
    let mut chain: Vec<Option<u32>> = vec![Some(requester)];
    chain.extend(t.route.iter().map(|h| (!h.unknown).then_some(h.id)));
    chain.push(Some(r.src));
    let mut out = vec![];
    for k in 0..chain.len() - 1 {
        let (Some(tx), rx) = (chain[k], chain[k + 1]) else { continue };
        let snr = t.snr_towards.get(k).copied().flatten();
        if rx.is_some_and(|n| ctx.downlinkers.contains(&n)) && snr == Some(0.0) {
            continue; // over the internet
        }
        out.push(Transmission {
            key: format!("rq{packet}|{}", node_id(tx)),
            tx: node_id(tx),
            rx: rx.map(node_id),
            rebroadcast: k > 0,
            strength: snr.and_then(|s| signal_strength(Some(s), None)),
            delivered: false,
            packet: Some(packet.clone()),
            replay: true,
        });
    }
    out
}

/// An ACK proves its sender received the packet it answers: the original
/// sender (the ACK's destination) reached it (D-096). `ack`: the interned
/// "ack" kind.
pub fn delivery_ping(r: &Row, ack: Option<u32>) -> Option<Transmission> {
    let rt = r.routing().filter(|rt| Some(rt.kind) == ack && rt.request != 0)?;
    let sender = r.dst.filter(|&d| d != r.src && d != u32::MAX)?;
    Some(Transmission { key: format!("{:08x}|{}|delivered", rt.request, node_id(sender)), tx: node_id(sender), rx: Some(node_id(r.src)), rebroadcast: false, strength: None, delivered: true, packet: None, replay: false })
}

/// Measured signal to 0..1: SNR -20..+10 dB, else RSSI -130..-70 dBm.
pub fn signal_strength(snr: Option<f64>, rssi: Option<i32>) -> Option<f64> {
    let clamp = |v: f64| v.clamp(0.0, 1.0);
    snr.map(|s| clamp((s + 20.0) / 30.0)).or(rssi.map(|r| clamp((r as f64 + 130.0) / 60.0)))
}

/// The transmissions one gateway reception proves.
/// - Traceroutes record every relay in order (exact; replaces the heuristics).
/// - The originator always transmitted the first broadcast; a gateway that
///   heard it directly (zero hops) is a receiver of it.
/// - Otherwise the gateway heard a rebroadcast by the last-hop relay; when the
///   byte resolves uniquely, that relay transmitted and the gateway received.
/// - Hop count 1 with a resolved relay whose known role cannot receive at zero
///   cost: that relay heard the originator directly.
pub fn transmissions(r: &Row, ctx: &RelayContext, roles: &FxMap<u32, String>) -> Vec<Transmission> {
    let lp = key_hex(r.lp);
    let key = |tx: u32| format!("{lp}|{}", node_id(tx));
    let strength = signal_strength(r.snr, r.rssi);
    use crate::row::ty;
    if let Some(t) = r.traceroute().filter(|t| t.valid) {
        let over_radio = r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF;
        let chain = match r.gw {
            Some(g) => traceroute_chain(r, t, g, over_radio, ctx),
            None => traceroute_chain(r, t, r.src, false, ctx),
        };
        let mut out = vec![];
        for k in 0..chain.len() {
            let Some(tx) = chain[k].0 else { continue };
            if k > 0 && k == chain.len() - 1 {
                break; // the last node only received
            }
            // A hop over the internet is no radio transmission: no ping for it.
            if chain.get(k + 1).is_some_and(|c| c.1) {
                continue;
            }
            let rx = chain.get(k + 1).and_then(|c| c.0);
            out.push(Transmission { key: key(tx), tx: node_id(tx), rx: rx.map(node_id), rebroadcast: k > 0, strength: rx.filter(|&x| Some(x) == r.gw).and(strength), delivered: false, packet: r.pid.map(|p| packet_ref(r.src, p)), replay: false });
        }
        return out;
    }
    let first = |rx: Option<u32>, s: Option<f64>| Transmission { key: key(r.src), tx: node_id(r.src), rx: rx.map(node_id), rebroadcast: false, strength: s, delivered: false, packet: r.pid.map(|p| packet_ref(r.src, p)), replay: false };
    let Some(gw) = r.gw else { return vec![first(None, None)] };
    let downlinked = ctx.downlinked(r);
    if gw == r.src || r.rr == ty::NON_RF || (downlinked && r.relay.is_none()) {
        return vec![first(None, None)]; // the gateway did not hear it over the air
    }
    if !downlinked && (r.dr || r.hops() == Some(0)) {
        return vec![first(Some(gw), strength)];
    }
    let relay = match r.relay.and_then(|b| ctx.resolve((b & 0xff) as u8, r.src, gw)) {
        Some(Ok(n)) => n,
        _ => return vec![first(None, None)],
    };
    // A downlinked copy (D-088) carries no hop count: the relay got it from MQTT.
    let heard_origin = !downlinked && r.hops() == Some(1) && roles.get(&relay).is_some_and(|ro| !ro.is_empty() && !zero_cost_role(ro));
    vec![
        first(heard_origin.then_some(relay), None),
        Transmission { key: key(relay), tx: node_id(relay), rx: Some(node_id(gw)), rebroadcast: true, strength, delivered: false, packet: r.pid.map(|p| packet_ref(r.src, p)), replay: false },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::LatLon;
    use crate::row::{Detail, Hop, Row, Traceroute};

    const A: u32 = 0x0000_00aa;
    const C: u32 = 0x0000_00cc;
    const C2: u32 = 0x1111_11cc;
    const GW: u32 = 0x0000_00dd;

    fn row(src: u32, gw: u32) -> Row {
        Row {
            id: 1, t: 0, broker: 0, gw: Some(gw), src, dst: None, pid: None, channel: 0, ty: 0, lp: 0xabc, ok: 1, snr: None, rssi: None,
            hs: None, hl: None, relay: None, sig: 0, dr: false, rr: 0, crypto: 0, bytes: 0, nk: false, wa: false, topic: 0, pos: None, detail: None,
        }
    }
    fn hops(r: Row, n: i16) -> Row {
        Row { hs: Some(3), hl: Some(3 - n), ..r }
    }
    fn relayed(r: Row, byte: i32, n: i16) -> Row {
        hops(Row { relay: Some(byte), ..r }, n)
    }
    fn traceroute(r: Row, path: &[Option<u32>]) -> Row {
        let route = path.iter().map(|h| h.map_or(Hop { id: 0xffff_ffff, unknown: true }, |id| Hop { id, unknown: false })).collect();
        Row { detail: Some(Box::new(Detail::Traceroute(Traceroute { valid: true, is_reply: false, route, snr_towards: vec![], route_back: vec![], snr_back: vec![], request: 0 }))), ..r }
    }
    fn ctx(known: &[u32], links: &[(u32, u32)]) -> RelayContext {
        RelayContext::new(known.iter().copied(), map(), links.iter().copied(), set())
    }
    fn roles(m: &[(u32, &str)]) -> FxMap<u32, String> {
        m.iter().map(|&(n, r)| (n, r.to_string())).collect()
    }
    fn pairs(t: &[Transmission]) -> Vec<(String, Option<String>)> {
        t.iter().map(|x| (x.tx.clone(), x.rx.clone())).collect()
    }
    fn id(n: u32) -> String {
        node_id(n)
    }

    #[test]
    fn direct_and_own_receptions() {
        let t = transmissions(&Row { dr: true, ..row(A, GW) }, &ctx(&[A, GW], &[]), &map());
        assert_eq!(pairs(&t), vec![(id(A), Some(id(GW)))]);
        assert!(!t[0].rebroadcast);
        assert_eq!(t[0].key, format!("{:016x}|{}", 0xabc, id(A)));
        assert_eq!(pairs(&transmissions(&hops(row(A, GW), 0), &ctx(&[A, GW], &[]), &map())), vec![(id(A), Some(id(GW)))]);
        // A gateway uplinking its own packet: a first broadcast with no known receiver.
        assert_eq!(pairs(&transmissions(&row(GW, GW), &ctx(&[GW], &[]), &map())), vec![(id(GW), None)]);
    }

    #[test]
    fn relayed_reception_is_a_rebroadcast_by_the_resolved_last_hop() {
        let t = transmissions(&relayed(row(A, GW), 0xcc, 2), &ctx(&[A, C, GW], &[]), &map());
        assert_eq!(pairs(&t), vec![(id(A), None), (id(C), Some(id(GW)))]);
        assert!(t[1].rebroadcast);
    }

    #[test]
    fn hop_count_one_proves_a_direct_first_hop_only_for_roles_that_spend_a_hop() {
        let c = ctx(&[A, C, GW], &[]);
        let ev = relayed(row(A, GW), 0xcc, 1);
        assert_eq!(transmissions(&ev, &c, &roles(&[(C, "CLIENT")]))[0].rx, Some(id(C)));
        for role in ["ROUTER", "ROUTER_LATE", "CLIENT_BASE"] {
            assert_eq!(transmissions(&ev, &c, &roles(&[(C, role)]))[0].rx, None, "{role}");
        }
        assert_eq!(transmissions(&ev, &c, &map())[0].rx, None, "unknown role");
        assert_eq!(transmissions(&relayed(row(A, GW), 0xcc, 2), &c, &roles(&[(C, "CLIENT")]))[0].rx, None);
        assert_eq!(pairs(&transmissions(&ev, &c, &map()))[1], (id(C), Some(id(GW))));
    }

    #[test]
    fn ambiguous_bytes_are_never_guessed() {
        assert_eq!(ctx(&[A, C, C2, GW], &[]).resolve(0xcc, A, GW), Some(Err(())));
        assert_eq!(ctx(&[A, C, C2, GW], &[(C2, GW)]).resolve(0xcc, A, GW), Some(Ok(C2)));
        assert_eq!(transmissions(&relayed(row(A, GW), 0xcc, 1), &ctx(&[A, C, C2, GW], &[]), &map()).len(), 1);
        assert_eq!(ctx(&[A, GW], &[]).resolve(0xaa, A, GW), None, "never the originator");
    }

    #[test]
    fn traceroutes_use_the_recorded_route() {
        // Real reply copy: hops = 1 and relay byte 0x73, but the route shows two relays.
        let (r1, r2, g, o) = (0x997b_0449, 0x672f_1873, 0x3afa_b911, 0x8a84_e409);
        let ev = traceroute(relayed(row(o, g), 0x73, 1), &[Some(r1), Some(r2), Some(g)]);
        let t = transmissions(&ev, &ctx(&[o, r1, r2, g], &[]), &map());
        assert_eq!(pairs(&t), vec![(id(o), Some(id(r1))), (id(r1), Some(id(r2))), (id(r2), Some(id(g)))]);
        assert_eq!(t.iter().map(|x| x.rebroadcast).collect::<Vec<_>>(), vec![false, true, true]);
        // A gateway that did not append itself still heard the last relay.
        assert_eq!(pairs(&transmissions(&traceroute(row(A, GW), &[Some(C)]), &ctx(&[A, C, GW], &[]), &map())), vec![(id(A), Some(id(C))), (id(C), Some(id(GW)))]);
        assert_eq!(pairs(&transmissions(&traceroute(row(A, GW), &[]), &ctx(&[A, GW], &[]), &map())), vec![(id(A), Some(id(GW)))]);
        // An unrecorded hop breaks the chain without inventing receivers.
        assert_eq!(pairs(&transmissions(&traceroute(row(A, GW), &[None, Some(C)]), &ctx(&[A, C, GW], &[]), &map())), vec![(id(A), None), (id(C), Some(id(GW)))]);
    }

    #[test]
    fn relay_candidates_beyond_radio_range_are_excluded_but_never_unpositioned_ones() {
        let at = |lon: f64, lat: f64| LatLon { lat, lon };
        let mk = |pos: &[(u32, LatLon)], long: Option<(u32, u32)>| {
            let mut c = RelayContext::new([A, C, C2, GW], pos.iter().copied().collect(), long, set());
            if long.is_some() {
                c.max_range_m = 500_000.0;
            }
            c
        };
        let all = [(GW, at(10.4, 63.43)), (C, at(10.5, 63.5)), (C2, at(10.75, 59.91))]; // C2 in Oslo, ~390 km away
        assert_eq!(mk(&all, None).resolve(0xcc, A, GW), Some(Ok(C)));
        assert_eq!(mk(&[all[0], all[2]], None).resolve(0xcc, A, GW), Some(Ok(C)), "C unpositioned stays, C2 out of range");
        assert_eq!(mk(&all, Some((A, GW))).resolve(0xcc, A, GW), Some(Err(())), "a proven long link widens the bound");
    }

    #[test]
    fn signal_strength_belongs_to_the_reporting_gateway() {
        assert_eq!(signal_strength(Some(-20.0), None), Some(0.0));
        assert_eq!(signal_strength(Some(10.0), None), Some(1.0));
        assert!((signal_strength(None, Some(-100)).unwrap() - 0.5).abs() < 1e-9);
        assert_eq!(signal_strength(None, None), None);
        let t = transmissions(&Row { snr: Some(5.0), ..relayed(row(A, GW), 0xcc, 2) }, &ctx(&[A, C, GW], &[]), &map());
        assert!((t.iter().find(|x| x.rx == Some(id(GW))).unwrap().strength.unwrap() - 25.0 / 30.0).abs() < 1e-9);
        assert_eq!(t.iter().find(|x| x.tx == id(A)).unwrap().strength, None);
    }

    #[test]
    fn a_byte_equal_to_the_gateway_is_the_gateway() {
        let c = ctx(&[0xaaaa_0011, 0xbbbb_0011, 0xcccc_0022], &[]);
        assert_eq!(c.resolve(0x11, 0xcccc_0022, 0xaaaa_0011), None);
        assert_eq!(c.resolve(0x11, 0xcccc_0022, 0xdddd_0033), Some(Err(())));
    }

    #[test]
    fn only_flagged_copies_count_as_downlinked() {
        let c = ctx(&[A, C, GW], &[]);
        let ro = roles(&[(C, "CLIENT")]);
        // A relayed copy with no hops left is ordinary radio: C heard A itself.
        let plain = relayed(row(A, GW), 0xcc, 1);
        assert!(!c.downlinked(&plain));
        assert_eq!(pairs(&transmissions(&plain, &c, &ro)), vec![(id(A), Some(id(C))), (id(C), Some(id(GW)))]);
        // Flagged via_mqtt: C took it from MQTT, so only its own transmission is radio.
        let flagged = Row { rr: crate::row::ty::VIA_MQTT, ..relayed(row(A, GW), 0xcc, 0) };
        assert!(c.downlinked(&flagged));
        assert_eq!(pairs(&transmissions(&flagged, &c, &ro)), vec![(id(A), None), (id(C), Some(id(GW)))]);
        // With no last hop, nothing radio is proven.
        let bare = Row { rr: crate::row::ty::VIA_MQTT, ..row(A, GW) };
        assert_eq!(pairs(&transmissions(&bare, &c, &ro)), vec![(id(A), None)]);
    }

    #[test]
    fn acks_and_errors_pair_with_what_they_answer() {
        use crate::row::{Interner, Routing};
        let mut it = Interner::default();
        let (routing, ack, err, dm, nr) = (it.id("routing"), it.id("ack"), it.id("error"), it.id("direct_message"), it.id("NO_RESPONSE"));
        // A's DM 77 to C, answered twice by C (A retried) and once with an error by a relay.
        let msg = Row { ty: dm, dst: Some(C), pid: Some(77), lp: 1, ..row(A, GW) };
        let answer = |src: u32, lp: u64, kind: u32, error: u32| Row { ty: routing, dst: Some(A), pid: Some(lp as u32 + 1000), lp, detail: Some(Box::new(Detail::Routing(Routing { kind, error, request: 77 }))), ..row(src, GW) };
        let rows = [msg, answer(C, 2, ack, 0), answer(C, 3, ack, 0), Row { ok: 9, ..answer(C, 3, ack, 0) }, answer(GW, 4, err, nr)];
        let refs: Vec<&Row> = rows.iter().collect();
        let log = packet_log(&refs, A, &ctx(&[A, C, GW], &[]), &ReplyIndex::new(&refs), &it);
        let sent = log.own.iter().find(|p| p.lp == key_hex(1)).unwrap();
        assert_eq!(sent.replies, vec![Reply { from: id(C), kind: "ack".into(), error: None, count: 2 }, Reply { from: id(GW), kind: "error".into(), error: Some("NO_RESPONSE".into()), count: 1 }]);
        assert_eq!(log.inbound.len(), 3, "routing packets addressed to it, one per packet");
        assert!(log.inbound.iter().all(|p| p.answers.as_ref().unwrap().re.as_deref() == Some(key_hex(1).as_str())));
        // C's view: its ACKs say what they answer.
        let clog = packet_log(&refs, C, &ctx(&[A, C, GW], &[]), &ReplyIndex::new(&refs), &it);
        assert_eq!(clog.own[0].answers.as_ref().map(|a| (a.kind.as_str(), a.request_id)), Some(("ack", 77)));
        assert_eq!(delivery(&refs, A, &it), Some(Delivery { acks_sent: 0, acks_received: 2, errors_sent: vec![], errors_received: vec![("NO_RESPONSE".into(), 1)] }));
        assert_eq!(delivery(&refs, C, &it).map(|d| d.acks_sent), Some(2));
    }

    #[test]
    fn an_ack_proves_delivery_and_an_error_does_not() {
        use crate::row::{Interner, Routing};
        let mut it = Interner::default();
        let (routing, ack, err) = (it.id("routing"), it.id("ack"), it.id("error"));
        let answer = |kind: u32| Row { ty: routing, dst: Some(A), detail: Some(Box::new(Detail::Routing(Routing { kind, error: 0, request: 77 }))), ..row(C, GW) };
        let d = delivery_ping(&answer(ack), Some(ack)).unwrap();
        assert_eq!((d.tx.as_str(), d.rx.as_deref(), d.delivered), (id(A).as_str(), Some(id(C).as_str()), true));
        assert_eq!(delivery_ping(&answer(err), Some(ack)), None, "an error is no delivery");
        assert_eq!(delivery_ping(&row(A, GW), Some(ack)), None, "not a routing packet");
        // The route of the answered packet gains a dashed "delivered" segment to the acker.
        let msg = Row { pid: Some(77), dst: Some(C), dr: true, ..row(A, GW) };
        let route = packet_route(&[&msg], &ctx(&[A, C, GW], &[]), &map(), &it, &[C]);
        assert_eq!(route.delivered, vec![id(C)]);
        assert!(route.segments.iter().any(|s| s.a == id(A) && s.b == id(C) && s.why == "delivered" && s.dashed));
    }

    #[test]
    fn a_traceroute_reply_replays_its_requests_route_tied_to_that_packet() {
        // C asked A (request id 77): the reply from A to C records C -> GW -> A.
        let reply = Row {
            dst: Some(C),
            pid: Some(500),
            detail: Some(Box::new(Detail::Traceroute(Traceroute { valid: true, is_reply: true, route: vec![Hop { id: GW, unknown: false }], snr_towards: vec![Some(4.0), Some(-6.0)], route_back: vec![], snr_back: vec![], request: 77 }))),
            ..row(A, GW)
        };
        let t = forward_route(&reply, &ctx(&[A, C, GW], &[]));
        assert_eq!(pairs(&t), vec![(id(C), Some(id(GW))), (id(GW), Some(id(A)))]);
        assert!(t.iter().all(|x| x.replay && x.packet.as_deref() == Some("000000cc:0000004d")));
        assert!(!t[0].rebroadcast && t[1].rebroadcast);
        // The live request from C carries the same packet reference, so either can stand in for the other.
        let request = Row { pid: Some(77), dr: true, ..row(C, GW) };
        let live = transmissions(&request, &ctx(&[A, C, GW], &[]), &map());
        assert_eq!(live[0].packet.as_deref(), Some("000000cc:0000004d"));
        assert!(!live[0].replay);
        // A request (not a reply) replays nothing.
        assert!(forward_route(&request, &ctx(&[A, C, GW], &[])).is_empty());
    }
}
