//! Per-node packet logs, one packet's routing graph, and the transmissions
//! a live reception proves (for the radar-ping animation).

use serde::Serialize;

use crate::graph::{zero_cost_role, RelayContext};
use crate::row::{Interner, Row};
use crate::util::{iso, key_hex, map, node_id, set, FxMap, FxSet};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hops: Option<i16>,
    pub gateways: usize,
    pub receptions: usize,
    pub signature: String,
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
    pub truncated: bool,
}

/// Relaying is known from a gateway's last-hop byte resolving to the node
/// (same narrowing as links) or from the node in a traceroute's recorded
/// route; the uplinking gateway's own trailing entry only received it.
pub fn packet_log(rows: &[&Row], num: u32, ctx: &RelayContext, i: &Interner) -> PacketLog {
    let mut own: FxMap<u64, Vec<&Row>> = map();
    struct Rel<'a> {
        first: i64,
        row: &'a Row,
        byte: bool,
        route: bool,
        gateways: FxSet<u32>,
    }
    let mut relayed: FxMap<u64, Rel> = map();
    for &r in rows {
        if r.src == num {
            own.entry(r.lp).or_default().push(r);
            continue;
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
            let hops = rs.iter().filter_map(|r| r.hops()).min();
            (
                first.t,
                OwnPacket {
                    lp: key_hex(first.lp),
                    at: iso(first.t),
                    ty: i.s(first.ty).to_string(),
                    to: dest(first.dst),
                    channel: (first.channel != 0).then(|| i.s(first.channel).to_string()),
                    hops,
                    gateways: rs.iter().filter_map(|r| r.gw).collect::<FxSet<u32>>().len(),
                    receptions: rs.iter().map(|r| r.ok).collect::<FxSet<u64>>().len(),
                    signature: i.s(first.sig).to_string(),
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
    own_list.sort_by(|a, b| b.0.cmp(&a.0));
    rel_list.sort_by(|a, b| b.0.cmp(&a.0));
    own_list.truncate(MAX_LOG);
    rel_list.truncate(MAX_LOG);
    PacketLog { own: own_list.into_iter().map(|x| x.1).collect(), relayed: rel_list.into_iter().map(|x| x.1).collect(), truncated: n_own > MAX_LOG || n_rel > MAX_LOG }
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
    pub segments: Vec<RouteSegment>,
    pub receptions: usize,
}

/// One packet's routing graph from every in-window reception of it.
/// Segments are transmitter -> receiver; dashed where nodes are missing.
pub fn packet_route(rows: &[&Row], ctx: &RelayContext, roles: &FxMap<u32, String>, i: &Interner) -> PacketRoute {
    let Some(first) = rows.first() else {
        return PacketRoute { origin: String::new(), ty: String::new(), segments: vec![], receptions: 0 };
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
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            let hops = if t.is_reply { &t.route_back } else { &t.route };
            let mut chain: Vec<Option<u32>> = std::iter::once(Some(origin)).chain(hops.iter().map(|h| (!h.unknown).then_some(h.id))).collect();
            if chain.last().copied().flatten() != Some(gw) {
                chain.push(Some(gw));
            }
            let (mut last, mut gap) = (origin, false);
            for n in chain.into_iter().skip(1) {
                match n {
                    None => gap = true,
                    Some(n) => {
                        add(last, n, gap, if gap { "gap" } else { "traceroute" });
                        last = n;
                        gap = false;
                    }
                }
            }
            continue;
        }
        if r.rr == ty::VIA_MQTT || r.rr == ty::NON_RF {
            continue; // not heard over radio
        }
        if r.dr || r.rr == ty::NO_RX_METRICS {
            add(origin, gw, false, "direct");
            continue;
        }
        match r.relay.and_then(|b| ctx.resolve((b & 0xff) as u8, origin, gw)) {
            Some(Ok(relay)) => {
                add(relay, gw, false, "relay");
                // One hop spent, by a relay that cannot receive at zero cost: it heard the sender itself.
                let direct = r.hops() == Some(1) && roles.get(&relay).is_some_and(|ro| !ro.is_empty() && !zero_cost_role(ro));
                add(origin, relay, !direct, if direct { "relay" } else { "gap" });
            }
            _ => add(origin, gw, true, "unknown_relay"),
        }
    }
    PacketRoute {
        origin: node_id(origin),
        ty: i.s(first.ty).to_string(),
        segments: order.into_iter().map(|(a, b)| {
            let (dashed, why) = segs[&(a, b)];
            RouteSegment { a: node_id(a), b: node_id(b), dashed, why }
        }).collect(),
        receptions: rows.iter().map(|r| r.ok).collect::<FxSet<u64>>().len(),
    }
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
    if let Some(t) = r.traceroute().filter(|t| t.valid) {
        let hops = if t.is_reply { &t.route_back } else { &t.route };
        let mut chain: Vec<Option<u32>> = std::iter::once(Some(r.src)).chain(hops.iter().map(|h| (!h.unknown).then_some(h.id))).collect();
        if let Some(g) = r.gw {
            if chain.last().copied().flatten() != Some(g) {
                chain.push(Some(g));
            }
        }
        let mut out = vec![];
        for k in 0..chain.len() {
            let Some(tx) = chain[k] else { continue };
            if k > 0 && k == chain.len() - 1 {
                break; // the last node only received
            }
            let rx = chain.get(k + 1).copied().flatten();
            out.push(Transmission { key: key(tx), tx: node_id(tx), rx: rx.map(node_id), rebroadcast: k > 0, strength: rx.filter(|&x| Some(x) == r.gw).and(strength) });
        }
        return out;
    }
    let first = |rx: Option<u32>, s: Option<f64>| Transmission { key: key(r.src), tx: node_id(r.src), rx: rx.map(node_id), rebroadcast: false, strength: s };
    let Some(gw) = r.gw else { return vec![first(None, None)] };
    if gw == r.src {
        return vec![first(None, None)];
    }
    if r.dr || r.hops() == Some(0) {
        return vec![first(Some(gw), strength)];
    }
    let relay = match r.relay.and_then(|b| ctx.resolve((b & 0xff) as u8, r.src, gw)) {
        Some(Ok(n)) => n,
        _ => return vec![first(None, None)],
    };
    let heard_origin = r.hops() == Some(1) && roles.get(&relay).is_some_and(|ro| !ro.is_empty() && !zero_cost_role(ro));
    vec![
        first(heard_origin.then_some(relay), None),
        Transmission { key: key(relay), tx: node_id(relay), rx: Some(node_id(gw)), rebroadcast: true, strength },
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
            hs: None, hl: None, relay: None, sig: 0, dr: false, rr: 0, crypto: 0, bytes: 0, nk: false, pos: None, detail: None,
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
        Row { detail: Some(Box::new(Detail::Traceroute(Traceroute { valid: true, is_reply: false, route, snr_towards: vec![], route_back: vec![], snr_back: vec![] }))), ..r }
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
}
