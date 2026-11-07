//! One node's panel.

use serde::Serialize;

use super::{first_per_reception, is_device_telemetry, Built, Node};
use crate::graph;
use crate::row::{Interner, Row};
use crate::util::{iso, map, node_id, set, FxMap, FxSet};

const MAX_SAMPLES: usize = 500;
const MAX_GATEWAYED: usize = 200;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime: Option<u32>,
}

/// One environment report (D-099).
#[derive(Serialize)]
pub struct EnvironmentSample {
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub humidity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressure: Option<f64>,
}

/// Its packets to one node that asked for an acknowledgement, and what came
/// back (D-109). Lower bounds: only packets and ACKs a gateway reported count.
#[derive(Serialize, Debug, PartialEq)]
pub struct PairDelivery {
    pub to: String,
    pub asked: usize,
    /// Confirmed: an ACK, or a reply from the recipient answering it (a
    /// traceroute is answered with its reply, rarely an ACK).
    pub acked: usize,
    /// Answered with an error (and never ACKed).
    pub errors: usize,
    /// ACKed only after the sender retried (several ACKs for one packet).
    pub retried: usize,
}

/// A status text the node broadcast (NODE_STATUS_APP), and when (D-103).
#[derive(Serialize)]
pub struct StatusText {
    pub status: String,
    pub at: String,
}

#[derive(Serialize)]
pub struct Hearing {
    pub node: String,
    pub receptions: usize,
    pub direct_rf: usize,
    /// Medians over the direct receptions: a relayed copy's measures the last relay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rssi: Option<f64>,
}

#[derive(Serialize)]
pub struct NodeDetail {
    #[serde(flatten)]
    pub node: Node,
    pub telemetry_series: Vec<TelemetrySample>,
    /// Its packets that asked for an ACK, by recipient, most first (D-109).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub delivery_by_recipient: Vec<PairDelivery>,
    /// Its status texts, newest first: each distinct text once, at its latest (D-103).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub node_status: Vec<StatusText>,
    /// Environment reports in time order, one per packet (D-099).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub environment_series: Vec<EnvironmentSample>,
    pub heard_by: Vec<Hearing>,
    /// A series kept only its newest MAX_SAMPLES reports.
    pub truncated: bool,
    /// Region and LoRa preset as heard (topics, channel names) and as reported.
    pub radio: crate::radio::Radio,
    /// ACKs and errors it sent and received (D-092).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<crate::packets::Delivery>,
}

/// One node's in-window details, or None when it is neither observed nor
/// referenced. b: the build of the same rows, whose window-wide parts
/// (downlinks, radio groups, replies) it reads rather than redoes.
pub fn build_node_detail(rows: &[&Row], num: u32, b: &Built, i: &Interner) -> Option<NodeDetail> {
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    let mut own: Vec<&Row> = Vec::new();
    let mut uplinked: Vec<&Row> = Vec::new(); // what it reported as a gateway
    // Every row it sent, uplinked or was sent: all its own parts need, in one pass.
    let mut mine: Vec<&Row> = Vec::new();
    for &r in rows {
        if r.src == num || r.gw == Some(num) || r.dst == Some(num) {
            mine.push(r);
        }
        if r.src == num || r.gw == Some(num) {
            first = first.min(r.t);
            last = last.max(r.t);
        }
        if r.src == num {
            own.push(r);
        }
        if r.gw == Some(num) {
            uplinked.push(r);
        }
    }
    // The node itself (identity, position, staleness, anchor, movement,
    // estimate, counts) is the snapshot's, built from the same rows: one
    // implementation of every per-node rule, also for a node beyond the
    // snapshot's node limit (D-182), which the build keeps aside.
    let n = b.snapshot.nodes.iter().chain(&b.beyond).find(|x| x.num == num).cloned().unwrap_or_else(|| Node::new(num));
    let mut radio = crate::radio::radio(&own, i);
    radio.channels = crate::channels::channel_use(num, &mine, i);
    radio.preset = crate::channels::preset_guess(num, b.presets.get_or_init(|| crate::channels::PresetIndex::new(rows, &b.traceroute_contacts, i)));
    radio.uplink_topics = crate::radio::uplink_topics(&uplinked, i);
    let mut d = NodeDetail { node: n, telemetry_series: vec![], environment_series: vec![], node_status: vec![], delivery_by_recipient: vec![], heard_by: vec![], truncated: false, radio, delivery: crate::packets::delivery(&mine, num, i) };
    if first == i64::MAX {
        // Neither sent nor uplinked anything: the snapshot's node says
        // whether others named it, and when.
        return (d.node.status == "referenced").then_some(d);
    }
    d.node.first_seen = Some(iso(first));
    d.node.last_seen = Some(iso(last));

    // One sample per logical packet (its first copy), in time order; the
    // newest MAX_SAMPLES when there are more.
    let per_packet = |keep: &dyn Fn(&Row) -> bool, truncated: &mut bool| -> Vec<&Row> {
        let mut m: FxMap<u64, &Row> = map();
        for &r in &own {
            if !keep(r) {
                continue;
            }
            m.entry(r.lp).and_modify(|cur| if r.t < cur.t || (r.t == cur.t && r.id < cur.id) { *cur = r }).or_insert(r);
        }
        let mut list: Vec<&Row> = m.into_values().collect();
        list.sort_by_key(|r| (r.t, r.lp));
        if list.len() > MAX_SAMPLES {
            list.drain(..list.len() - MAX_SAMPLES);
            *truncated = true;
        }
        list
    };
    let mut truncated = false;
    d.telemetry_series = per_packet(&is_device_telemetry, &mut truncated)
        .into_iter()
        .map(|r| {
            let t = r.telemetry().unwrap();
            TelemetrySample { at: iso(r.t), battery: t.battery, voltage: t.voltage, ch_util: t.ch_util, air_util: t.air_util, uptime: t.uptime }
        })
        .collect();
    d.environment_series = per_packet(&super::is_environment, &mut truncated)
        .into_iter()
        .map(|r| {
            let t = r.telemetry().unwrap();
            EnvironmentSample { at: iso(r.t), temp: t.temp, humidity: t.humidity, pressure: t.pressure }
        })
        .collect();
    d.truncated = truncated;
    d.delivery_by_recipient = delivery_by_recipient(rows, &mine, &own, num, b.replies.get_or_init(|| crate::packets::ReplyIndex::new(rows)), i);
    // Status texts: newest first, each once. Opt-out nodes' texts are never stored (empty).
    let mut texts: Vec<(i64, u32)> = own.iter().filter_map(|r| r.node_status().filter(|&s| !i.s(s).is_empty()).map(|s| (r.t, s))).collect();
    texts.sort_by_key(|a| std::cmp::Reverse(a.0));
    let mut seen_text = set::<u32>();
    d.node_status = texts.into_iter().filter(|(_, s)| seen_text.insert(*s)).take(5).map(|(t, s)| StatusText { status: i.s(s).to_string(), at: iso(t) }).collect();
    d.heard_by = hearings(&mine, |r| r.src == num && r.gw.is_some_and(|g| g != r.src), |r| r.gw.unwrap());

    Some(d)
}

/// Its unicast packets that asked for an ACK, by recipient, with the ACKs
/// and errors answering them (D-109). rows: those `replies` was made from;
/// mine: the rows it sent, uplinked or was sent.
fn delivery_by_recipient(rows: &[&Row], mine: &[&Row], own: &[&Row], num: u32, replies: &crate::packets::ReplyIndex, i: &Interner) -> Vec<PairDelivery> {
    let mut first: FxMap<u64, &Row> = map();
    for &r in own {
        if r.wa && r.pid.is_some() && r.dst.is_some_and(|d| d != crate::util::BROADCAST && d != num) {
            first.entry(r.lp).or_insert(r);
        }
    }
    // Replies answering one of its packets: (replier, request id).
    let answered: FxSet<(u32, u32)> = mine.iter().filter(|r| r.dst == Some(num)).filter_map(|r| r.traceroute().filter(|t| t.is_reply && t.request != 0).map(|t| (r.src, t.request))).collect();
    let (ack, error) = (i.get("ack"), i.get("error"));
    let mut per: FxMap<u32, PairDelivery> = map();
    for r in first.values() {
        let to = r.dst.unwrap();
        let e = per.entry(to).or_insert_with(|| PairDelivery { to: node_id(to), asked: 0, acked: 0, errors: 0, retried: 0 });
        e.asked += 1;
        // Distinct ACK packets (by who sent them and with what error, as
        // ReplyIndex::replies counts them), and whether an error came.
        let mut acks: FxSet<(u32, u32, u64)> = set();
        let mut erred = false;
        for a in replies.answering(r.pid.unwrap(), num, rows) {
            let rt = a.routing().unwrap();
            if Some(rt.kind) == ack {
                acks.insert((a.src, rt.error, a.lp));
            } else if Some(rt.kind) == error {
                erred = true;
            }
        }
        if !acks.is_empty() || answered.contains(&(to, r.pid.unwrap())) {
            e.acked += 1;
            if acks.len() > 1 {
                e.retried += 1;
            }
        } else if erred {
            e.errors += 1;
        }
    }
    let mut out: Vec<PairDelivery> = per.into_values().collect();
    out.sort_unstable_by(|a, b| b.asked.cmp(&a.asked).then(a.to.cmp(&b.to)));
    out
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
            (k, Hearing { node: node_id(k), receptions: rs.len(), direct_rf: direct.len(), snr: graph::stats(&snr, false).median, rssi: graph::stats(&rssi, false).median })
        })
        .collect();
    out.sort_unstable_by(|a, b| b.1.receptions.cmp(&a.1.receptions).then(a.0.cmp(&b.0)));
    out.truncate(MAX_GATEWAYED);
    out.into_iter().map(|(_, h)| h).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::JRow;

    fn build(rows: &[&Row], i: &Interner) -> Built {
        super::super::build_snapshot(rows, i, &Default::default(), Default::default())
    }

    #[test]
    fn a_long_series_keeps_its_newest_samples() {
        let mut i = Interner::default();
        // Packet keys rise with time, so key order would keep the oldest.
        let rows: Vec<Row> = (0..MAX_SAMPLES as i64 + 20)
            .map(|k| {
                let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":5,"s":5,"y":"telemetry","l":"{:016x}","o":"{k:016x}","sg":"unsigned","te":{{"kind":"device","battery":50}}}}"#, 1000 * k, 10_000 + k);
                serde_json::from_str::<JRow>(&text).unwrap().into_row(&mut i)
            })
            .collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let d = build_node_detail(&refs, 5, &build(&refs, &i), &i).unwrap();
        assert!(d.truncated);
        assert_eq!(d.telemetry_series.len(), MAX_SAMPLES);
        assert_eq!((d.telemetry_series[0].at.as_str(), d.telemetry_series[MAX_SAMPLES - 1].at.as_str()), (iso(20_000).as_str(), iso(1000 * (MAX_SAMPLES as i64 + 19)).as_str()));
    }

    #[test]
    fn status_texts_newest_first_each_once_without_empty_ones() {
        let mut i = Interner::default();
        let text = r#"[
          {"i":1,"t":1000,"b":"x","g":5,"s":5,"y":"node_status","l":"01","o":"01","sg":"unsigned","ns":{"status":"At the cabin"}},
          {"i":2,"t":2000,"b":"x","g":5,"s":5,"y":"node_status","l":"02","o":"02","sg":"unsigned","ns":{"status":"Back home"}},
          {"i":3,"t":3000,"b":"x","g":5,"s":5,"y":"node_status","l":"03","o":"03","sg":"unsigned","ns":{"status":"At the cabin"}},
          {"i":4,"t":4000,"b":"x","g":5,"s":5,"y":"node_status","l":"04","o":"04","sg":"unsigned","ns":{"status":""}}
        ]"#;
        let rows: Vec<Row> = serde_json::from_str::<Vec<JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let d = build_node_detail(&refs, 5, &build(&refs, &i), &i).unwrap();
        let got: Vec<&str> = d.node_status.iter().map(|s| s.status.as_str()).collect();
        assert_eq!(got, vec!["At the cabin", "Back home"]);
    }

    #[test]
    fn delivery_by_recipient_counts_confirmed_errors_and_retries() {
        let mut i = Interner::default();
        // Node 5 asks 9 three times: one ACKed once, one ACKed twice (retried), one answered with an error.
        let text = r#"[
          {"i":1,"t":1,"b":"x","g":7,"s":5,"d":9,"p":101,"y":"direct_message","l":"01","o":"01","sg":"not-applicable","wa":true},
          {"i":2,"t":2,"b":"x","g":7,"s":5,"d":9,"p":102,"y":"direct_message","l":"02","o":"02","sg":"not-applicable","wa":true},
          {"i":3,"t":3,"b":"x","g":7,"s":5,"d":9,"p":103,"y":"direct_message","l":"03","o":"03","sg":"not-applicable","wa":true},
          {"i":4,"t":4,"b":"x","g":7,"s":5,"d":9,"p":104,"y":"direct_message","l":"04","o":"04","sg":"not-applicable"},
          {"i":5,"t":5,"b":"x","g":7,"s":9,"d":5,"p":201,"y":"routing","l":"05","o":"05","sg":"unsigned","rt":{"kind":"ack","request_id":101}},
          {"i":6,"t":6,"b":"x","g":7,"s":9,"d":5,"p":202,"y":"routing","l":"06","o":"06","sg":"unsigned","rt":{"kind":"ack","request_id":102}},
          {"i":7,"t":7,"b":"x","g":7,"s":9,"d":5,"p":203,"y":"routing","l":"07","o":"07","sg":"unsigned","rt":{"kind":"ack","request_id":102}},
          {"i":8,"t":8,"b":"x","g":7,"s":7,"d":5,"p":204,"y":"routing","l":"08","o":"08","sg":"unsigned","rt":{"kind":"error","error":"NO_RESPONSE","request_id":103}},
          {"i":9,"t":9,"b":"x","g":7,"s":5,"d":9,"p":105,"y":"traceroute","l":"09","o":"09","sg":"not-applicable","wa":true,"tr":{"valid":true,"is_reply":false}},
          {"i":10,"t":10,"b":"x","g":7,"s":9,"d":5,"p":205,"y":"traceroute","l":"0a","o":"0a","sg":"not-applicable","tr":{"valid":true,"is_reply":true,"request_id":105}}
        ]"#;
        let rows: Vec<Row> = serde_json::from_str::<Vec<JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let d = build_node_detail(&refs, 5, &build(&refs, &i), &i).unwrap();
        assert_eq!(d.delivery_by_recipient, vec![PairDelivery { to: node_id(9), asked: 4, acked: 3, errors: 1, retried: 1 }], "the traceroute counts as confirmed by its reply; the packet that asked for no ACK is left out");
    }
}
