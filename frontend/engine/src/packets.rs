//! Per-node packet logs, one packet's routing graph, and the transmissions
//! a live reception proves (for the radar-ping animation).

use serde::Serialize;

use crate::graph::{last_byte, zero_cost_role, RelayContext};
use crate::row::{HeardFrom, Interner, Row};
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
    /// The node whose packet this answers (a traceroute reply, an ACK or
    /// error): the node did not send it of its own accord.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_response_to: Option<String>,
    /// Type invalid: why its content was not kept (D-093).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invalid: Option<String>,
}

/// Who a packet answers: the requester of a traceroute reply, or the sender
/// of the packet an ACK or error is about (its destination, either way).
fn in_response_to(r: &Row) -> Option<u32> {
    let answers = r.traceroute().is_some_and(|t| t.valid && t.is_reply) || r.routing().is_some_and(|rt| rt.request != 0);
    r.dst.filter(|&d| answers && d != BROADCAST && d != r.src)
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
        if let (Some(g), HeardFrom::Relayed(Some(b))) = (r.gw, r.heard_from())
            && g != num
            && b == last_byte(num)
            && ctx.resolve(b, r.src, g, r.rssi.map(f64::from)) == Some(Ok(num))
        {
            note(false, Some(g));
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
    let n_in = inbound.len();
    // The newest MAX_LOG of each, chosen before their entries (strings,
    // replies) are built.
    fn newest<T>(mut v: Vec<(i64, T)>) -> impl Iterator<Item = T> {
        v.sort_by_key(|a| std::cmp::Reverse(a.0));
        v.truncate(MAX_LOG);
        v.into_iter().map(|x| x.1)
    }
    let own = newest(own.into_values().map(|rs| (rs.iter().map(|r| r.t).min().unwrap(), rs)).collect());
    let relayed = newest(relayed.into_values().map(|e| (e.first, e)).collect());
    let inbound = newest(inbound.into_values().map(|r| (r.t, r)).collect());
    let own_list: Vec<OwnPacket> = own
        .map(|rs| {
            let first = rs.iter().copied().reduce(|a, b| if b.t < a.t { b } else { a }).unwrap();
            use crate::row::ty;
            let others: Vec<&Row> = rs.iter().copied().filter(|r| r.gw.is_some_and(|g| g != num)).collect();
            let radio = |r: &&&Row| r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF;
            let hops = others.iter().filter(radio).filter_map(|r| r.hops()).min();
            let best = rs.iter().map(|r| r.sig).max_by_key(|&s| i.sig_rank(s)).map_or("unsigned", |s| i.s(s));
            OwnPacket {
                    lp: key_hex(first.lp),
                    at: iso(first.t),
                    ty: i.s(first.ty).to_string(),
                    to: dest(first.dst),
                    channel: (first.channel != 0).then(|| i.s(first.channel).to_string()),
                    hops,
                    gateways: others.iter().filter_map(|r| r.gw).collect::<FxSet<u32>>().len(),
                    by_itself: rs.iter().any(|r| r.gw == Some(num)),
                    downlinked: others.iter().any(|r| RelayContext::downlinked(r)),
                    receptions: rs.iter().map(|r| r.ok).collect::<FxSet<u64>>().len(),
                    signature: best.to_string(),
                    replies: first.pid.map_or(vec![], |p| replies.replies(p, num, rows, i)),
                    answers: replies.answer(first, &more, i),
                    in_response_to: in_response_to(first).map(node_id),
                    invalid: first.invalid().map(|v| i.s(v).to_string()),
            }
        })
        .collect();
    let rel_list: Vec<RelayedPacket> = relayed
        .map(|e| {
            let mut gws: Vec<u32> = e.gateways.into_iter().collect();
            gws.sort_unstable();
            let mut evidence = vec![];
            if e.byte {
                evidence.push("relay_byte");
            }
            if e.route {
                evidence.push("traceroute");
            }
            RelayedPacket { lp: key_hex(e.row.lp), at: iso(e.first), origin: node_id(e.row.src), ty: i.s(e.row.ty).to_string(), to: dest(e.row.dst), evidence, gateways: gws.into_iter().map(node_id).collect() }
        })
        .collect();
    let in_list: Vec<InboundPacket> = inbound.map(|r| InboundPacket { lp: key_hex(r.lp), at: iso(r.t), origin: node_id(r.src), ty: i.s(r.ty).to_string(), answers: replies.answer(r, &more, i) }).collect();
    PacketLog {
        own: own_list,
        relayed: rel_list,
        inbound: in_list,
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
    traceroutes: FxMap<(u32, u32), Vec<u32>>, // (request id, addressed to) -> valid traceroute replies
    /// How many rows it was made from.
    pub rows: usize,
}

impl ReplyIndex {
    pub fn new(rows: &[&Row]) -> Self {
        let mut ix = ReplyIndex { by_request: map(), by_id: map(), traceroutes: map(), rows: rows.len() };
        for (k, &r) in rows.iter().enumerate() {
            if let (Some(rt), Some(d)) = (r.routing(), r.dst)
                && rt.request != 0
            {
                ix.by_request.entry((rt.request, d)).or_default().push(k as u32);
            }
            if let (Some(t), Some(d)) = (r.traceroute(), r.dst)
                && t.valid
                && t.is_reply
            {
                ix.traceroutes.entry((t.request, d)).or_default().push(k as u32);
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

    /// The routing rows answering `sender`'s packet `pid`. rows: those it
    /// was made from.
    pub fn answering<'a>(&self, pid: u32, sender: u32, rows: &[&'a Row]) -> impl Iterator<Item = &'a Row> {
        debug_assert_eq!(rows.len(), self.rows, "ReplyIndex used with other rows than it was made from");
        self.by_request.get(&(pid, sender)).into_iter().flatten().map(|&k| rows[k as usize])
    }

    /// The valid traceroute replies to `sender`'s request `pid`. rows: those
    /// it was made from.
    pub fn traceroute_replies<'a>(&self, pid: u32, sender: u32, rows: &[&'a Row]) -> impl Iterator<Item = &'a Row> {
        debug_assert_eq!(rows.len(), self.rows, "ReplyIndex used with other rows than it was made from");
        self.traceroutes.get(&(pid, sender)).into_iter().flatten().map(|&k| rows[k as usize])
    }

    /// Replies to `sender`'s packet `pid`, grouped by who answered and how.
    /// rows: those it was made from.
    pub fn replies(&self, pid: u32, sender: u32, rows: &[&Row], i: &Interner) -> Vec<Reply> {
        debug_assert_eq!(rows.len(), self.rows, "ReplyIndex used with other rows than it was made from");
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
        v.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
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
    /// A traceroute's way there ("forward": the request, requester to
    /// target) or back ("back": the reply, target to requester).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leg: Option<&'static str>,
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
/// `replies`: for a traceroute request, the replies answering it. A
/// traceroute is drawn both ways, each hop tagged with its leg: the way there
/// (each reply records the request's whole way to the target, which no
/// gateway's copy of the request may have seen past where it was uplinked)
/// and the way back (the replies' own copies).
pub fn packet_route(rows: &[&Row], ctx: &RelayContext, roles: &FxMap<u32, String>, i: &Interner, acked: &[u32], replies: &[&Row]) -> PacketRoute {
    let Some(first) = rows.first() else {
        return PacketRoute { origin: String::new(), ty: String::new(), at: String::new(), segments: vec![], receptions: 0, delivered: vec![] };
    };
    let origin = first.src;
    type Key = (u32, u32, Option<&'static str>);
    let mut order: Vec<Key> = Vec::new();
    let mut segs: FxMap<Key, (bool, &'static str)> = map();
    let mut add = |a: u32, b: u32, dashed: bool, why: &'static str, leg: Option<&'static str>| {
        if a == b {
            return;
        }
        match segs.get_mut(&(a, b, leg)) {
            Some(cur) => {
                if cur.0 && !dashed {
                    *cur = (false, why)
                }
            }
            None => {
                segs.insert((a, b, leg), (dashed, why));
                order.push((a, b, leg));
            }
        }
    };
    // A traceroute's recorded chain of nodes, None where one is unknown.
    let mut add_chain = |chain: Vec<(Option<u32>, bool)>, leg: &'static str| {
        let mut it = chain.into_iter();
        let Some((Some(mut last), _)) = it.next() else { return };
        let mut gap = false;
        for (n, internet) in it {
            match n {
                None => gap = true,
                Some(n) => {
                    add(last, n, gap, if internet { "internet" } else if gap { "gap" } else { "traceroute" }, Some(leg));
                    last = n;
                    gap = false;
                }
            }
        }
    };
    let leg = |t: &crate::row::Traceroute| if t.is_reply { "back" } else { "forward" };
    use crate::row::ty;
    let mut add_seg: Vec<(u32, u32, bool, &'static str)> = vec![];
    for r in rows {
        let Some(gw) = r.gw.filter(|&g| g != origin) else { continue };
        let over_radio = r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF;
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            add_chain(traceroute_chain(r, t, gw, over_radio, ctx), leg(t));
            continue;
        }
        let byte = match r.heard_from() {
            HeardFrom::NotRadio => continue, // not heard over radio
            HeardFrom::Direct => {
                add_seg.push((origin, gw, false, "direct"));
                continue;
            }
            HeardFrom::Relayed(b) | HeardFrom::Downlinked(b) => b,
            HeardFrom::Unknown => None,
        };
        match byte.and_then(|b| ctx.resolve(b, origin, gw, r.rssi.map(f64::from))) {
            Some(Ok(relay)) if RelayContext::downlinked(r) => {
                // Taken from MQTT and transmitted with no hops left (D-087).
                add_seg.push((relay, gw, false, "relay"));
                add_seg.push((origin, relay, true, "internet"));
            }
            Some(Ok(relay)) => {
                add_seg.push((relay, gw, false, "relay"));
                // One hop spent, by a relay that cannot receive at zero cost: it heard the sender itself.
                let direct = r.hops() == Some(1) && roles.get(&relay).is_some_and(|ro| !ro.is_empty() && !zero_cost_role(ro));
                add_seg.push((origin, relay, !direct, if direct { "relay" } else { "gap" }));
            }
            _ if RelayContext::downlinked(r) => add_seg.push((origin, gw, true, "internet")),
            _ => add_seg.push((origin, gw, true, "unknown_relay")),
        }
    }
    // A reply: the way there, as it recorded its request's.
    if let Some((_, chain)) = recorded_request(first, ctx) {
        add_chain(chain, "forward");
    }
    // A request: the way there as its replies recorded it, and the way back
    // as their copies show it.
    for reply in replies {
        let Some(chain) = recorded_request(reply, ctx).filter(|(requester, _)| *requester == origin).map(|(_, c)| c) else { continue };
        add_chain(chain, "forward");
        if let (Some(gw), Some(t)) = (reply.gw.filter(|&g| g != reply.src), reply.traceroute().filter(|t| t.valid)) {
            let over_radio = reply.rr != ty::VIA_MQTT && reply.rr != ty::NON_RF;
            add_chain(traceroute_chain(reply, t, gw, over_radio, ctx), "back");
        }
    }
    drop(add_chain);
    for (a, b, dashed, why) in add_seg {
        add(a, b, dashed, why, None);
    }
    for &n in acked {
        add(origin, n, true, "delivered", None);
    }
    PacketRoute {
        origin: node_id(origin),
        ty: i.s(first.ty).to_string(),
        at: iso(rows.iter().map(|r| r.t).min().unwrap_or(first.t)),
        segments: order.into_iter().map(|(a, b, leg)| {
            let (dashed, why) = segs[&(a, b, leg)];
            RouteSegment { a: node_id(a), b: node_id(b), dashed, why, leg }
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
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
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
    /// the live packet it describes (D-106). For a delivery, the packet the
    /// ACK answers (D-172).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub packet: Option<String>,
    /// Reconstructed after the fact (a traceroute reply's record of its
    /// request's way), not seen as it happened: skipped when that packet was
    /// already animated (D-106).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub replay: bool,
    /// A traceroute reply's transmissions name the request they answer
    /// ("origin:id"): the reply leaves the target only once the request's
    /// way there has been drawn reaching it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    /// A delivery: the way the answered packet took from its sender to the
    /// acknowledging node, as its routing graph shows it, dashed where a part
    /// is not known (D-172).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<RouteSegment>,
    /// A delivery: the way the ACK took back from the acknowledging node to
    /// the sender, dashed where a part is not known (D-172).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub back: Vec<RouteSegment>,
    /// Not a radio transmission: a stretch of the packet's way from `tx` to
    /// `rx` whose hops are not known, drawn as the routing graph draws it
    /// (D-173): "gap" (nodes between are missing), "unknown_relay" (an
    /// unresolved last-hop byte), "internet" (over MQTT).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gap: Option<&'static str>,
}

fn packet_ref(origin: u32, id: u32) -> String {
    format!("{origin:08x}:{id:08x}")
}

/// A recorded way: each node (None where unknown), with whether the hop into
/// it crossed the internet.
pub type Chain = Vec<(Option<u32>, bool)>;

/// The request's whole way as a traceroute reply records it: requester,
/// route, target (the reply's sender), each node (None where unknown) with
/// whether the hop into it crossed the internet (exactly 0 dB into a probable
/// downlinker, D-054). Returns the requester too.
pub fn recorded_request(r: &Row, ctx: &RelayContext) -> Option<(u32, Chain)> {
    let t = r.traceroute().filter(|t| t.valid && t.is_reply && t.request != 0)?;
    let requester = r.dst.filter(|&d| d != BROADCAST && d != r.src)?;
    let mut chain = vec![(Some(requester), false)];
    let hops = t.route.iter().map(|h| (!h.unknown).then_some(h.id)).chain([Some(r.src)]);
    for (k, n) in hops.enumerate() {
        let internet = n.is_some_and(|n| ctx.downlinkers.contains(&n)) && t.snr_towards.get(k).copied().flatten() == Some(0.0);
        chain.push((n, internet));
    }
    Some((requester, chain))
}

/// A traceroute reply records the way its request travelled: requester ->
/// route -> target, with the SNR at each receiver. Replayed as transmissions
/// of the request (D-106); hops over the internet are not radio.
pub fn forward_route(r: &Row, ctx: &RelayContext) -> Vec<Transmission> {
    let Some((requester, chain)) = recorded_request(r, ctx) else { return vec![] };
    let Some(t) = r.traceroute() else { return vec![] };
    let packet = packet_ref(requester, t.request);
    chain_steps(&chain)
        .into_iter()
        .map(|st| {
            // The SNR at the receiver, for a radio hop to the very next node.
            let snr = st.gap.is_none().then(|| st.rx.and(t.snr_towards.get(st.k).copied().flatten())).flatten();
            Transmission {
                key: match st.gap {
                    Some(_) => format!("rq{packet}|{}>{}", node_id(st.tx), st.rx.map_or(String::new(), node_id)),
                    None => format!("rq{packet}|{}", node_id(st.tx)),
                },
                tx: node_id(st.tx),
                rx: st.rx.map(node_id),
                rebroadcast: st.k > 0,
                strength: snr.and_then(|s| signal_strength(Some(s), None)),
                packet: Some(packet.clone()),
                replay: true,
                gap: st.gap,
                ..Default::default()
            }
        })
        .collect()
}

/// An ACK proves its sender received the packet it answers: the original
/// sender (the ACK's destination) reached it (D-096). `ack`: the interned
/// "ack" kind. `original`: the in-window rows of the packet it answers, whose
/// routing graph gives the way it took to the acknowledging node; `copies`:
/// the ACK's own copies (this one included), whose graph gives the way it
/// took back to the sender (D-172).
pub fn delivery_ping(r: &Row, ack: Option<u32>, original: &[&Row], copies: &[&Row], ctx: &RelayContext, roles: &FxMap<u32, String>, i: &Interner) -> Option<Transmission> {
    let rt = r.routing().filter(|rt| Some(rt.kind) == ack && rt.request != 0)?;
    let sender = r.dst.filter(|&d| d != r.src && d != u32::MAX)?;
    let (from, to) = (node_id(sender), node_id(r.src));
    let segments = if original.is_empty() { vec![] } else { packet_route(original, ctx, roles, i, &[], &[]).segments };
    let path = delivery_path(&segments, &from, &to);
    let segments = if copies.is_empty() { vec![] } else { packet_route(copies, ctx, roles, i, &[], &[]).segments };
    let back = delivery_path(&segments, &to, &from);
    Some(Transmission { key: format!("{:08x}|{from}|delivered", rt.request), tx: from, rx: Some(to), rebroadcast: false, strength: None, delivered: true, packet: Some(packet_ref(sender, rt.request)), replay: false, after: None, path, back, gap: None })
}

/// The way a packet took from its origin to one node, through its routing
/// graph's segments (the way there; known hops preferred over dashed ones).
/// When no drawn hop reaches that node, where it heard the packet from is not
/// known: one dashed "delivered" segment from the origin stands for it.
pub fn delivery_path(segments: &[RouteSegment], origin: &str, to: &str) -> Vec<RouteSegment> {
    let usable: Vec<&RouteSegment> = segments.iter().filter(|s| s.leg != Some("back") && s.why != "delivered").collect();
    // Dijkstra over a handful of segments: a dashed hop costs more than a known one.
    let mut best: FxMap<&str, (u32, Option<usize>)> = map();
    best.insert(origin, (0, None));
    let mut done: FxSet<&str> = set();
    while let Some((n, d)) = best.iter().filter(|(n, _)| !done.contains(*n)).map(|(&n, &(d, _))| (n, d)).min_by_key(|&(n, d)| (d, n)) {
        done.insert(n);
        if n == to {
            break;
        }
        for (k, s) in usable.iter().enumerate().filter(|(_, s)| s.a == n) {
            let w = d + if s.dashed { 4 } else { 1 };
            let e = best.entry(s.b.as_str()).or_insert((u32::MAX, None));
            if w < e.0 {
                *e = (w, Some(k));
            }
        }
    }
    let mut path = vec![];
    let mut at = to;
    while let Some(&(_, Some(k))) = best.get(at).filter(|_| at != origin) {
        path.push(RouteSegment { leg: None, ..usable[k].clone() });
        at = usable[k].a.as_str();
    }
    if path.is_empty() {
        return vec![RouteSegment { a: origin.to_string(), b: to.to_string(), dashed: true, why: "delivered", leg: None }];
    }
    path.reverse();
    path
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
        // A reply answers its request: drawn after the request reaches the target.
        let after = t.is_reply.then(|| r.dst.filter(|&d| d != BROADCAST && d != r.src && t.request != 0).map(|d| packet_ref(d, t.request))).flatten();
        let packet = r.pid.map(|p| packet_ref(r.src, p));
        return chain_steps(&chain)
            .into_iter()
            .map(|st| Transmission {
                key: if st.gap.is_some() { format!("{lp}|{}>{}", node_id(st.tx), st.rx.map_or(String::new(), node_id)) } else { key(st.tx) },
                tx: node_id(st.tx),
                rx: st.rx.map(node_id),
                rebroadcast: st.k > 0,
                strength: st.rx.filter(|&x| Some(x) == r.gw && st.gap.is_none()).and(strength),
                packet: packet.clone(),
                after: after.clone(),
                gap: st.gap,
                ..Default::default()
            })
            .collect();
    }
    let first = |rx: Option<u32>, s: Option<f64>| Transmission { key: key(r.src), tx: node_id(r.src), rx: rx.map(node_id), rebroadcast: false, strength: s, delivered: false, packet: r.pid.map(|p| packet_ref(r.src, p)), replay: false, after: None, path: vec![], back: vec![], gap: None };
    // The way from the sender to a node, its hops not known (D-173).
    let gap = |rx: u32, kind: &'static str| Transmission { key: format!("{lp}|{}>{}", node_id(r.src), node_id(rx)), tx: node_id(r.src), rx: Some(node_id(rx)), packet: r.pid.map(|p| packet_ref(r.src, p)), gap: Some(kind), ..Default::default() };
    let Some(gw) = r.gw else { return vec![first(None, None)] };
    let (byte, downlinked) = match r.heard_from() {
        HeardFrom::Direct => return vec![first(Some(gw), strength)],
        HeardFrom::Relayed(b) => (b, false),
        HeardFrom::Downlinked(b) => (b, true),
        HeardFrom::Unknown => (None, false),
        // Not heard over the air.
        HeardFrom::NotRadio => return vec![first(None, None)],
    };
    let relay = match byte.and_then(|b| ctx.resolve(b, r.src, gw, r.rssi.map(f64::from))) {
        Some(Ok(n)) => n,
        // Heard, but not from whom: the sender's way to the gateway, as the
        // routing graph draws it.
        _ => return vec![first(None, None), gap(gw, if downlinked { "internet" } else { "unknown_relay" })],
    };
    // A downlinked copy (D-088) carries no hop count: the relay got it from MQTT.
    let heard_origin = !downlinked && r.hops() == Some(1) && roles.get(&relay).is_some_and(|ro| !ro.is_empty() && !zero_cost_role(ro));
    let mut out = vec![first(heard_origin.then_some(relay), None)];
    if !heard_origin {
        out.push(gap(relay, if downlinked { "internet" } else { "gap" }));
    }
    out.push(Transmission { key: key(relay), tx: node_id(relay), rx: Some(node_id(gw)), rebroadcast: true, strength, packet: r.pid.map(|p| packet_ref(r.src, p)), ..Default::default() });
    out
}

/// One step of a recorded way (`k`: the transmitter's place in it).
struct Step {
    k: usize,
    tx: u32,
    rx: Option<u32>,
    gap: Option<&'static str>,
}

/// A recorded way's transmissions: each known node passes the packet on to
/// the next known one, by radio when that is the very next node and the hop
/// is over the air, else as a gap (D-173): "internet" when a hop between them
/// crossed it, "gap" when nodes between them are missing. A node followed by
/// missing ones also transmitted, to whom is not known. The last node only
/// received.
fn chain_steps(chain: &[(Option<u32>, bool)]) -> Vec<Step> {
    let known: Vec<(usize, u32)> = chain.iter().enumerate().filter_map(|(k, c)| c.0.map(|n| (k, n))).collect();
    let mut out = vec![];
    for (i, &(k, tx)) in known.iter().enumerate() {
        if k > 0 && k + 1 == chain.len() {
            break;
        }
        match known.get(i + 1) {
            Some(&(j, rx)) if j == k + 1 => out.push(Step { k, tx, rx: Some(rx), gap: chain[j].1.then_some("internet") }),
            Some(&(j, rx)) => {
                out.push(Step { k, tx, rx: None, gap: None });
                let internet = chain[k + 1..=j].iter().any(|c| c.1);
                out.push(Step { k, tx, rx: Some(rx), gap: Some(if internet { "internet" } else { "gap" }) });
            }
            None => out.push(Step { k, tx, rx: None, gap: None }),
        }
    }
    out
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
        RelayContext::new(known.iter().copied(), map(), links.iter().copied(), set(), set())
    }
    fn roles(m: &[(u32, &str)]) -> FxMap<u32, String> {
        m.iter().map(|&(n, r)| (n, r.to_string())).collect()
    }
    /// The radio transmissions, transmitter and receiver.
    fn pairs(t: &[Transmission]) -> Vec<(String, Option<String>)> {
        t.iter().filter(|x| x.gap.is_none()).map(|x| (x.tx.clone(), x.rx.clone())).collect()
    }
    /// The stretches whose hops are not known (D-173).
    fn gaps(t: &[Transmission]) -> Vec<(String, String, &'static str)> {
        t.iter().filter_map(|x| Some((x.tx.clone(), x.rx.clone()?, x.gap?))).collect()
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
        assert!(t.iter().find(|x| x.tx == id(C)).unwrap().rebroadcast);
        // How A's packet reached C is not known: a gap, ahead of C's transmission so C's ring can wait for it.
        assert_eq!(gaps(&t), vec![(id(A), id(C), "gap")]);
        assert_eq!(t.iter().map(|x| x.gap.is_some()).collect::<Vec<_>>(), vec![false, true, false]);
        assert_eq!(t[1].key, format!("{:016x}|{}>{}", 0xabc, id(A), id(C)));
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
        // Heard directly: no gap.
        assert_eq!(gaps(&transmissions(&ev, &c, &roles(&[(C, "CLIENT")]))), vec![]);
    }

    #[test]
    fn ambiguous_bytes_are_never_guessed() {
        assert_eq!(ctx(&[A, C, C2, GW], &[]).resolve(0xcc, A, GW, None), Some(Err(())));
        assert_eq!(ctx(&[A, C, C2, GW], &[(C2, GW)]).resolve(0xcc, A, GW, None), Some(Ok(C2)));
        let t = transmissions(&relayed(row(A, GW), 0xcc, 1), &ctx(&[A, C, C2, GW], &[]), &map());
        assert_eq!(pairs(&t), vec![(id(A), None)]);
        assert_eq!(gaps(&t), vec![(id(A), id(GW), "unknown_relay")], "the way to the gateway, relay unknown");
        assert_eq!(ctx(&[A, GW], &[]).resolve(0xaa, A, GW, None), None, "never the originator");
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
        let t = transmissions(&traceroute(row(A, GW), &[None, Some(C)]), &ctx(&[A, C, GW], &[]), &map());
        assert_eq!(pairs(&t), vec![(id(A), None), (id(C), Some(id(GW)))]);
        // ... and bridges it with a gap, before C transmits.
        assert_eq!(gaps(&t), vec![(id(A), id(C), "gap")]);
        assert_eq!(t.iter().position(|x| x.gap.is_some()), Some(1));
    }

    #[test]
    fn relay_candidates_beyond_radio_range_are_excluded_but_never_unpositioned_ones() {
        let at = |lon: f64, lat: f64| LatLon { lat, lon };
        let mk = |pos: &[(u32, LatLon)], long: Option<(u32, u32)>| {
            let mut c = RelayContext::new([A, C, C2, GW], pos.iter().copied().collect(), long, set(), set());
            if long.is_some() {
                c.max_range_m = 500_000.0;
            }
            c
        };
        let all = [(GW, at(10.4, 63.43)), (C, at(10.5, 63.5)), (C2, at(10.75, 59.91))]; // C2 in Oslo, ~390 km away
        assert_eq!(mk(&all, None).resolve(0xcc, A, GW, None), Some(Ok(C)));
        assert_eq!(mk(&[all[0], all[2]], None).resolve(0xcc, A, GW, None), Some(Ok(C)), "C unpositioned stays, C2 out of range");
        assert_eq!(mk(&all, Some((A, GW))).resolve(0xcc, A, GW, None), Some(Err(())), "a proven long link widens the bound");
        // A strong signal at the gateway rules out the relay 390 km away even
        // then, leaving the near one; a weak one rules out neither (D-136).
        assert_eq!(mk(&all, Some((A, GW))).resolve(0xcc, A, GW, Some(-55.0)), Some(Ok(C)));
        assert_eq!(mk(&all, Some((A, GW))).resolve(0xcc, A, GW, Some(-95.0)), Some(Err(())));
    }

    #[test]
    fn the_free_space_bound_leaves_every_real_link_and_rules_out_the_impossible() {
        use crate::graph::max_distance_m;
        // 70 dB budget at 869.5 MHz: -50 dBm within about 27 km, -80 dBm about 870 km.
        assert!((max_distance_m(-50.0) / 1000.0 - 27.5).abs() < 0.5);
        assert!((max_distance_m(-80.0) / 1000.0 - 870.0).abs() < 10.0);
        // Measured links (D-136): 43 km at -75 dBm into an amplified gateway, 74 km at -103 dBm.
        assert!(max_distance_m(-75.0) > 43_000.0 && max_distance_m(-103.0) > 74_000.0);
        // A relay byte read at -58 dBm cannot come from 250 km away.
        assert!(max_distance_m(-58.0) < 250_000.0);
        // Very strong readings never rule out a relay within 15 km: shared positions can be that far off.
        assert_eq!(max_distance_m(-17.0), crate::graph::SIGNAL_FLOOR_M);
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
        assert_eq!(c.resolve(0x11, 0xcccc_0022, 0xaaaa_0011, None), None);
        assert_eq!(c.resolve(0x11, 0xcccc_0022, 0xdddd_0033, None), Some(Err(())));
    }

    #[test]
    fn only_flagged_copies_count_as_downlinked() {
        let c = ctx(&[A, C, GW], &[]);
        let ro = roles(&[(C, "CLIENT")]);
        // A relayed copy with no hops left is ordinary radio: C heard A itself.
        let plain = relayed(row(A, GW), 0xcc, 1);
        assert!(!RelayContext::downlinked(&plain));
        assert_eq!(pairs(&transmissions(&plain, &c, &ro)), vec![(id(A), Some(id(C))), (id(C), Some(id(GW)))]);
        // Flagged via_mqtt: C took it from MQTT, so only its own transmission is radio.
        let flagged = Row { rr: crate::row::ty::VIA_MQTT, ..relayed(row(A, GW), 0xcc, 0) };
        assert!(RelayContext::downlinked(&flagged));
        assert_eq!(pairs(&transmissions(&flagged, &c, &ro)), vec![(id(A), None), (id(C), Some(id(GW)))]);
        assert_eq!(gaps(&transmissions(&flagged, &c, &ro)), vec![(id(A), id(C), "internet")]);
        assert_eq!(gaps(&transmissions(&plain, &c, &ro)), vec![]);
        // With no last hop, nothing radio is proven.
        let bare = Row { rr: crate::row::ty::VIA_MQTT, ..row(A, GW) };
        assert_eq!(pairs(&transmissions(&bare, &c, &ro)), vec![(id(A), None)]);
        assert_eq!(gaps(&transmissions(&bare, &c, &ro)), vec![(id(A), id(GW), "internet")]);
        // Not over the air at all: nothing but the sender's own broadcast.
        assert_eq!(gaps(&transmissions(&Row { rr: crate::row::ty::NON_RF, ..row(A, GW) }, &c, &ro)), vec![]);
    }

    #[test]
    fn own_answers_name_who_they_answer() {
        use crate::row::{Interner, Routing};
        let mut it = Interner::default();
        let (routing, ack) = (it.id("routing"), it.id("ack"));
        // A answers C's traceroute and acknowledges C's message; its own broadcast answers no one.
        let reply = Row { dst: Some(C), pid: Some(500), lp: 1, detail: Some(Box::new(Detail::Traceroute(Traceroute { valid: true, is_reply: true, route: vec![], snr_towards: vec![], route_back: vec![], snr_back: vec![], request: 77 }))), ..row(A, GW) };
        let acked = Row { ty: routing, dst: Some(C), pid: Some(501), lp: 2, detail: Some(Box::new(Detail::Routing(Routing { kind: ack, error: 0, request: 78 }))), ..row(A, GW) };
        let own = Row { pid: Some(502), lp: 3, ..row(A, GW) };
        let request = Row { dst: Some(C), pid: Some(503), lp: 4, ..traceroute(row(A, GW), &[]) };
        let rows = [reply, acked, own, request];
        let refs: Vec<&Row> = rows.iter().collect();
        let log = packet_log(&refs, A, &ctx(&[A, C, GW], &[]), &ReplyIndex::new(&refs), &it);
        let by = |lp: u64| log.own.iter().find(|p| p.lp == key_hex(lp)).unwrap().in_response_to.clone();
        assert_eq!((by(1), by(2), by(3), by(4)), (Some(id(C)), Some(id(C)), None, None));
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
        let c = ctx(&[A, C, GW], &[]);
        let d = delivery_ping(&answer(ack), Some(ack), &[], &[], &c, &map(), &it).unwrap();
        assert_eq!((d.tx.as_str(), d.rx.as_deref(), d.delivered), (id(A).as_str(), Some(id(C).as_str()), true));
        assert_eq!(delivery_ping(&answer(err), Some(ack), &[], &[], &c, &map(), &it), None, "an error is no delivery");
        assert_eq!(delivery_ping(&row(A, GW), Some(ack), &[], &[], &c, &map(), &it), None, "not a routing packet");
        // The route of the answered packet gains a dashed "delivered" segment to the acker.
        let msg = Row { pid: Some(77), dst: Some(C), dr: true, ..row(A, GW) };
        let route = packet_route(&[&msg], &ctx(&[A, C, GW], &[]), &map(), &it, &[C], &[]);
        assert_eq!(route.delivered, vec![id(C)]);
        assert!(route.segments.iter().any(|s| s.a == id(A) && s.b == id(C) && s.why == "delivered" && s.dashed));
    }

    #[test]
    fn a_delivery_follows_the_answered_packets_way_dashed_where_unknown() {
        use crate::row::{Interner, Routing};
        let mut it = Interner::default();
        let (routing, ack) = (it.id("routing"), it.id("ack"));
        // A's DM 77 to C2, acknowledged by C2, which is no gateway.
        let answer = Row { ty: routing, dst: Some(A), detail: Some(Box::new(Detail::Routing(Routing { kind: ack, error: 0, request: 77 }))), ..row(C2, GW) };
        let seg = |s: &RouteSegment| (s.a.clone(), s.b.clone(), s.dashed, s.why);
        let path = |original: &[&Row], c: &RelayContext| delivery_ping(&answer, Some(ack), original, &[], c, &map(), &it).unwrap().path.iter().map(seg).collect::<Vec<_>>();
        // No copy of the DM: where C2 heard it from is unknown, one dashed hop from A.
        let unknown = vec![(id(A), id(C2), true, "delivered")];
        assert_eq!(path(&[], &ctx(&[A, C, C2, GW], &[])), unknown);
        // GW heard it straight from A, which says nothing about C2.
        let direct = Row { pid: Some(77), dst: Some(C2), ..hops(row(A, GW), 0) };
        assert_eq!(path(&[&direct], &ctx(&[A, C, C2, GW], &[])), unknown);
        // A traceroute-like record through C to C2: the known hops, in order.
        let traced = Row { pid: Some(77), dst: Some(C2), ..traceroute(row(A, C2), &[Some(C)]) };
        assert_eq!(path(&[&traced], &ctx(&[A, C, C2, GW], &[])), vec![(id(A), id(C), false, "traceroute"), (id(C), id(C2), false, "traceroute")]);
    }

    #[test]
    fn a_delivery_returns_along_the_acks_own_way() {
        use crate::row::{Interner, Routing};
        let mut it = Interner::default();
        let (routing, ack) = (it.id("routing"), it.id("ack"));
        let c = ctx(&[A, C, C2, GW], &[]);
        // C2's ACK to A, heard by GW straight from C2: from GW on, the way to A is not known.
        let answer = Row { ty: routing, dst: Some(A), detail: Some(Box::new(Detail::Routing(Routing { kind: ack, error: 0, request: 77 }))), ..hops(row(C2, GW), 0) };
        let d = delivery_ping(&answer, Some(ack), &[], &[&answer], &c, &map(), &it).unwrap();
        assert_eq!(d.back, vec![RouteSegment { a: id(C2), b: id(A), dashed: true, why: "delivered", leg: None }], "GW is no stop on the way to A");
        assert_eq!(d.packet.as_deref(), Some("000000aa:0000004d"), "names the packet it answers");
        // Heard by A itself, a gateway, straight from C2: the way back is known.
        let at_a = Row { ty: routing, dst: Some(A), detail: Some(Box::new(Detail::Routing(Routing { kind: ack, error: 0, request: 77 }))), ..hops(row(C2, A), 0) };
        let d = delivery_ping(&at_a, Some(ack), &[], &[&answer, &at_a], &c, &map(), &it).unwrap();
        assert_eq!(d.back.iter().map(|s| (s.a.clone(), s.b.clone(), s.dashed)).collect::<Vec<_>>(), vec![(id(C2), id(A), false)]);
    }

    #[test]
    fn a_delivery_path_prefers_known_hops_and_skips_the_way_back() {
        let s = |a: u32, b: u32, dashed: bool, leg: Option<&'static str>| RouteSegment { a: id(a), b: id(b), dashed, why: if dashed { "gap" } else { "relay" }, leg };
        // A -> C2 directly but dashed, or A -> C -> C2 known: the known way wins.
        let segs = vec![s(A, C2, true, None), s(A, C, false, None), s(C, C2, false, None), s(C2, GW, false, None)];
        let p = delivery_path(&segs, &id(A), &id(C2));
        assert_eq!(p.iter().map(|x| (x.a.clone(), x.b.clone())).collect::<Vec<_>>(), vec![(id(A), id(C)), (id(C), id(C2))]);
        // A traceroute's way back never counts as the way there.
        let back = vec![s(A, C2, false, Some("back"))];
        assert_eq!(delivery_path(&back, &id(A), &id(C2)), vec![RouteSegment { a: id(A), b: id(C2), dashed: true, why: "delivered", leg: None }]);
    }

    #[test]
    fn a_traceroute_requests_route_runs_to_the_target_as_its_reply_recorded() {
        use crate::row::Interner;
        let it = Interner::default();
        // C asks A (request 77). The only gateway copy, at GW, saw it go C -> GW;
        // A's reply records the whole way: C -> GW -> C2 -> A.
        let request = Row { dst: Some(A), pid: Some(77), ..traceroute(row(C, GW), &[]) };
        let reply = Row {
            dst: Some(C),
            pid: Some(500),
            lp: 0xdef,
            detail: Some(Box::new(Detail::Traceroute(Traceroute { valid: true, is_reply: true, route: vec![Hop { id: GW, unknown: false }, Hop { id: C2, unknown: false }], snr_towards: vec![Some(4.0), Some(2.0), Some(-6.0)], route_back: vec![], snr_back: vec![], request: 77 }))),
            ..row(A, GW)
        };
        let segs = |rows: &[&Row], replies: &[&Row]| packet_route(rows, &ctx(&[A, C, C2, GW], &[]), &map(), &it, &[], replies).segments.iter().map(|s| (s.a.clone(), s.b.clone(), s.dashed, s.leg)).collect::<Vec<_>>();
        let f = Some("forward");
        assert_eq!(segs(&[&request], &[]), vec![(id(C), id(GW), false, f)]);
        // The way there as the reply recorded it, and the way back as its copy shows: A -> GW.
        let both = vec![(id(C), id(GW), false, f), (id(GW), id(C2), false, f), (id(C2), id(A), false, f), (id(A), id(GW), false, Some("back"))];
        assert_eq!(segs(&[&request], &[&reply]), both);
        // The reply's own route shows both legs as well, the way back first.
        let mut from_reply = segs(&[&reply], &[]);
        from_reply.sort_unstable();
        let mut want = both[1..].to_vec();
        want.push((id(C), id(GW), false, f));
        want.sort_unstable();
        assert_eq!(from_reply, want);
        // A reply to someone else's request with the same id adds nothing.
        let other = Row { dst: Some(GW), ..reply.clone() };
        assert_eq!(segs(&[&request], &[&other]), vec![(id(C), id(GW), false, f)]);
    }

    #[test]
    fn a_replayed_route_bridges_unrecorded_hops_with_a_gap() {
        // C2 asked A (request 77); the reply records C2 -> ? -> C -> A.
        let reply = Row {
            dst: Some(C2),
            pid: Some(500),
            detail: Some(Box::new(Detail::Traceroute(Traceroute { valid: true, is_reply: true, route: vec![Hop { id: 0xffff_ffff, unknown: true }, Hop { id: C, unknown: false }], snr_towards: vec![Some(4.0), Some(2.0), Some(-6.0)], route_back: vec![], snr_back: vec![], request: 77 }))),
            ..row(A, GW)
        };
        let t = forward_route(&reply, &ctx(&[A, C, C2, GW], &[]));
        assert_eq!(pairs(&t), vec![(id(C2), None), (id(C), Some(id(A)))]);
        assert_eq!(gaps(&t), vec![(id(C2), id(C), "gap")]);
        assert!(t.iter().all(|x| x.replay && x.packet.as_deref() == Some("111111cc:0000004d")));
        let g = t.iter().find(|x| x.gap.is_some()).unwrap();
        assert_eq!((g.key.as_str(), g.strength), ("rq111111cc:0000004d|!111111cc>!000000cc", None));
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
        assert!(live.iter().all(|x| x.after.is_none()));
        // The reply's own way back names the request it answers.
        let back = transmissions(&reply, &ctx(&[A, C, GW], &[]), &map());
        assert!(!back.is_empty() && back.iter().all(|x| x.after.as_deref() == Some("000000cc:0000004d") && !x.replay));
    }
}
