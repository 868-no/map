//! One node's panel.

use serde::Serialize;

use super::{brokers, dest, downlinks, first_per_reception, identity_of, identity_of_report, is_device_telemetry, is_identity, is_named_report, is_position, latest_by, origins, position_of, position_rows, referenced, sig_counts, telemetry_of, traceroute_hops, Node};
use crate::graph::{self, Stats};
use crate::row::{Interner, Row};
use crate::util::{iso, key_hex, map, node_id, set, FxMap, FxSet};

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
    /// Region and LoRa preset as heard (topics, channel names) and as reported.
    pub radio: crate::radio::Radio,
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
    n.mqtt_downlink = downlinks(&traceroute_hops(rows)).remove(&num);
    if let Some(r) = latest_by(&own, is_identity, |r| r.src).get(&num) {
        n.identity = Some(identity_of(r, i));
    } else if let Some(r) = latest_by(&own, is_named_report, |r| r.src).get(&num) {
        n.identity = Some(identity_of_report(r, i));
    }
    if let Some(r) = position_rows(&own).get(&num) {
        n.position = Some(position_of(r, i));
    }
    if let Some(r) = latest_by(&own, is_device_telemetry, |r| r.src).get(&num) {
        n.telemetry = Some(telemetry_of(r));
    }
    let radio = crate::radio::radio(&own, i);
    let mut d = NodeDetail { node: n, positions: vec![], telemetry_series: vec![], heard_by: vec![], heard: vec![], recent_packets: vec![], truncated: false, radio };
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
