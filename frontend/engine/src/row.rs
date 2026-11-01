//! Rows: the API's compact observation rows, parsed straight from JSON text
//! into a compact in-memory form (strings interned, keys as integers).

use serde::{Deserialize, Serialize};
use std::borrow::Cow;

use crate::util::{key64, key_hex, map, FxMap};

/// Interned strings (brokers, channels, packet types, signature and crypto
/// states, reception reasons, roles and names).
pub struct Interner {
    strs: Vec<String>,
    ids: FxMap<String, u32>,
}

/// Well-known packet types, interned first so they have fixed ids.
pub mod ty {
    pub const NONE: u32 = 0;
    pub const POSITION: u32 = 1;
    pub const MAPREPORT: u32 = 2;
    pub const NODEINFO: u32 = 3;
    pub const TELEMETRY: u32 = 4;
    pub const NEIGHBORINFO: u32 = 5;
    pub const TRACEROUTE: u32 = 6;
    pub const RELAYED: u32 = 7; // reception reason
    pub const VIA_MQTT: u32 = 8;
    pub const NON_RF: u32 = 9;
    pub const NO_RX_METRICS: u32 = 10;
    pub const DEVICE: u32 = 11; // telemetry kind
}

impl Default for Interner {
    fn default() -> Self {
        let mut i = Interner { strs: Vec::new(), ids: map() };
        for s in ["", "position", "mapreport", "nodeinfo", "telemetry", "neighborinfo", "traceroute", "relayed", "via_mqtt", "non_rf_transport", "no_rx_metrics", "device"] {
            i.id(s);
        }
        i
    }
}

impl Interner {
    pub fn id(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.ids.get(s) {
            return i;
        }
        let i = self.strs.len() as u32;
        self.strs.push(s.to_string());
        self.ids.insert(s.to_string(), i);
        i
    }
    pub fn get(&self, s: &str) -> Option<u32> {
        self.ids.get(s).copied()
    }
    pub fn s(&self, i: u32) -> &str {
        &self.strs[i as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hop {
    pub id: u32,
    pub unknown: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct NodeInfo {
    pub long_name: u32,
    pub short_name: u32,
    pub hw_model: u32,
    pub role: u32,
    pub has_public_key: bool,
    pub untrusted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub lat: f64,
    pub lon: f64,
    pub alt: Option<i32>,
    pub bits: u32,
    pub known: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Telemetry {
    pub kind: u32,
    pub battery: Option<f64>,
    pub voltage: Option<f64>,
    pub ch_util: Option<f64>,
    pub air_util: Option<f64>,
    pub uptime: Option<u32>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Traceroute {
    pub valid: bool,
    pub is_reply: bool,
    pub route: Vec<Hop>,
    pub snr_towards: Vec<Option<f64>>,
    pub route_back: Vec<Hop>,
    pub snr_back: Vec<Option<f64>>,
}

/// What a node's own map report says about itself and its radio (interned
/// strings). `default_channel` is the only proof the preset is in use:
/// firmware reports the stored preset even under a custom modem config.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapReport {
    pub region: u32,
    pub preset: u32,
    pub default_channel: bool,
    pub long_name: u32,
    pub short_name: u32,
    pub hw_model: u32,
    pub role: u32,
}

/// Port-specific decoded fields (most rows have none).
#[derive(Clone, Debug, PartialEq)]
pub enum Detail {
    MapReport(MapReport),
    NodeInfo(NodeInfo),
    Telemetry(Telemetry),
    Neighbors(Vec<(u32, Option<f64>)>),
    Traceroute(Traceroute),
}

/// One observation. Strings are Interner ids; keys are 64-bit.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: i64,
    pub t: i64,
    pub broker: u32,
    pub gw: Option<u32>,
    pub src: u32,
    pub dst: Option<u32>,
    pub pid: Option<u32>,
    pub channel: u32, // 0 = none
    pub ty: u32,
    pub lp: u64,
    pub ok: u64,
    pub snr: Option<f64>,
    pub rssi: Option<i32>,
    pub hs: Option<i16>,
    pub hl: Option<i16>,
    pub relay: Option<i32>,
    pub sig: u32,
    pub dr: bool,
    pub rr: u32,     // reception reason, 0 = none
    pub crypto: u32, // 0 = none
    pub bytes: i32,
    pub nk: bool, // sent without OK-to-MQTT, uplinked by another gateway
    pub topic: u32, // MQTT topic root, 0 = unknown
    pub pos: Option<Position>,
    pub detail: Option<Box<Detail>>,
}

impl Row {
    pub fn hops(&self) -> Option<i16> {
        Some(self.hs? - self.hl?)
    }
    pub fn traceroute(&self) -> Option<&Traceroute> {
        match self.detail.as_deref() {
            Some(Detail::Traceroute(t)) => Some(t),
            _ => None,
        }
    }
    pub fn nodeinfo(&self) -> Option<&NodeInfo> {
        match self.detail.as_deref() {
            Some(Detail::NodeInfo(n)) => Some(n),
            _ => None,
        }
    }
    pub fn telemetry(&self) -> Option<&Telemetry> {
        match self.detail.as_deref() {
            Some(Detail::Telemetry(t)) => Some(t),
            _ => None,
        }
    }
    pub fn map_report(&self) -> Option<MapReport> {
        match self.detail.as_deref() {
            Some(Detail::MapReport(m)) => Some(*m),
            _ => None,
        }
    }
    pub fn neighbors(&self) -> &[(u32, Option<f64>)] {
        match self.detail.as_deref() {
            Some(Detail::Neighbors(n)) => n,
            _ => &[],
        }
    }
}

// ---- JSON (the API's ObsRow) ----

#[derive(Deserialize, Serialize, Default)]
struct JNi<'a> {
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    long_name: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    short_name: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    hw_model: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    role: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "is_false")]
    has_public_key: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    identity_untrusted: bool,
}

#[derive(Deserialize, Serialize)]
struct JPo {
    lat: f64,
    lon: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alt: Option<i32>,
    #[serde(default)]
    precision_bits: u32,
    #[serde(default)]
    precision_known: bool,
}

#[derive(Deserialize, Serialize)]
struct JTe<'a> {
    #[serde(borrow, default)]
    kind: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    battery: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    voltage: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ch_util: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    air_util: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uptime: Option<u32>,
}

#[derive(Deserialize, Serialize)]
struct JNb {
    id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    snr: Option<f64>,
}

#[derive(Deserialize, Serialize)]
struct JNbs {
    #[serde(default)]
    neighbors: Option<Vec<JNb>>,
}

#[derive(Deserialize, Serialize)]
struct JMr<'a> {
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    region: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    modem_preset: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    has_default_channel: bool,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    long_name: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    short_name: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    hw_model: Cow<'a, str>,
    #[serde(borrow, default, skip_serializing_if = "is_empty")]
    role: Cow<'a, str>,
}

#[derive(Deserialize, Serialize)]
struct JHop {
    id: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    unknown: bool,
}

#[derive(Deserialize, Serialize)]
struct JTr {
    #[serde(default)]
    valid: bool,
    #[serde(default)]
    is_reply: bool,
    #[serde(default)]
    route: Option<Vec<JHop>>,
    #[serde(default)]
    snr_towards: Option<Vec<Option<f64>>>,
    #[serde(default)]
    route_back: Option<Vec<JHop>>,
    #[serde(default)]
    snr_back: Option<Vec<Option<f64>>>,
}

/// The API's compact row (`ObsRow` in the OpenAPI document).
#[derive(Deserialize, Serialize)]
pub struct JRow<'a> {
    i: i64,
    t: i64,
    #[serde(borrow)]
    b: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    g: Option<u32>,
    s: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    d: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    p: Option<u32>,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    c: Option<Cow<'a, str>>,
    #[serde(borrow)]
    y: Cow<'a, str>,
    #[serde(borrow)]
    l: Cow<'a, str>,
    #[serde(borrow)]
    o: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sn: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rs: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hs: Option<i16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hl: Option<i16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    r: Option<i32>,
    #[serde(borrow)]
    sg: Cow<'a, str>,
    #[serde(default, skip_serializing_if = "is_false")]
    dr: bool,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    rr: Option<Cow<'a, str>>,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    cr: Option<Cow<'a, str>>,
    #[serde(default, skip_serializing_if = "is_zero")]
    by: i32,
    #[serde(default, skip_serializing_if = "is_false")]
    nk: bool,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    tp: Option<Cow<'a, str>>,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    ni: Option<JNi<'a>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    po: Option<JPo>,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    te: Option<JTe<'a>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nb: Option<JNbs>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tr: Option<JTr>,
    #[serde(borrow, default, skip_serializing_if = "Option::is_none")]
    mr: Option<JMr<'a>>,
}

fn is_false(b: &bool) -> bool {
    !*b
}
fn is_zero(v: &i32) -> bool {
    *v == 0
}
fn is_empty(s: &Cow<'_, str>) -> bool {
    s.is_empty()
}

fn hops(v: Option<Vec<JHop>>) -> Vec<Hop> {
    v.unwrap_or_default().into_iter().map(|h| Hop { id: h.id, unknown: h.unknown }).collect()
}

impl JRow<'_> {
    pub fn into_row(self, i: &mut Interner) -> Row {
        let detail = if let Some(m) = self.mr {
            Some(Detail::MapReport(MapReport {
                region: i.id(&m.region),
                preset: i.id(&m.modem_preset),
                default_channel: m.has_default_channel,
                long_name: i.id(&m.long_name),
                short_name: i.id(&m.short_name),
                hw_model: i.id(&m.hw_model),
                role: i.id(&m.role),
            }))
        } else if let Some(n) = self.ni {
            Some(Detail::NodeInfo(NodeInfo {
                long_name: i.id(&n.long_name),
                short_name: i.id(&n.short_name),
                hw_model: i.id(&n.hw_model),
                role: i.id(&n.role),
                has_public_key: n.has_public_key,
                untrusted: n.identity_untrusted,
            }))
        } else if let Some(t) = self.te {
            Some(Detail::Telemetry(Telemetry { kind: i.id(&t.kind), battery: t.battery, voltage: t.voltage, ch_util: t.ch_util, air_util: t.air_util, uptime: t.uptime }))
        } else if let Some(n) = self.nb {
            Some(Detail::Neighbors(n.neighbors.unwrap_or_default().into_iter().map(|x| (x.id, x.snr)).collect()))
        } else {
            self.tr.map(|t| {
                Detail::Traceroute(Traceroute {
                    valid: t.valid,
                    is_reply: t.is_reply,
                    route: hops(t.route),
                    snr_towards: t.snr_towards.unwrap_or_default(),
                    route_back: hops(t.route_back),
                    snr_back: t.snr_back.unwrap_or_default(),
                })
            })
        };
        Row {
            id: self.i,
            t: self.t,
            broker: i.id(&self.b),
            gw: self.g,
            src: self.s,
            dst: self.d,
            pid: self.p,
            channel: self.c.map_or(0, |c| i.id(&c)),
            ty: i.id(&self.y),
            lp: key64(&self.l),
            ok: key64(&self.o),
            snr: self.sn,
            rssi: self.rs,
            hs: self.hs,
            hl: self.hl,
            relay: self.r,
            sig: i.id(&self.sg),
            dr: self.dr,
            rr: self.rr.map_or(0, |c| i.id(&c)),
            crypto: self.cr.map_or(0, |c| i.id(&c)),
            bytes: self.by,
            nk: self.nk,
            topic: self.tp.map_or(0, |t| i.id(&t)),
            pos: self.po.map(|p| Position { lat: p.lat, lon: p.lon, alt: p.alt, bits: p.precision_bits, known: p.precision_known }),
            detail: detail.map(Box::new),
        }
    }
}

/// Back to the API's JSON shape (for the persisted copy in IndexedDB).
pub fn to_json<'a>(r: &Row, i: &'a Interner) -> JRow<'a> {
    let s = |x: u32| Cow::Borrowed(i.s(x));
    let opt = |x: u32| if x == 0 { None } else { Some(Cow::Borrowed(i.s(x))) };
    let jh = |v: &[Hop]| Some(v.iter().map(|h| JHop { id: h.id, unknown: h.unknown }).collect());
    let mut j = JRow {
        i: r.id, t: r.t, b: s(r.broker), g: r.gw, s: r.src, d: r.dst, p: r.pid, c: opt(r.channel), y: s(r.ty),
        l: Cow::Owned(key_hex(r.lp)), o: Cow::Owned(key_hex(r.ok)), sn: r.snr, rs: r.rssi, hs: r.hs, hl: r.hl, r: r.relay,
        sg: s(r.sig), dr: r.dr, rr: opt(r.rr), cr: opt(r.crypto), by: r.bytes, nk: r.nk, tp: opt(r.topic),
        ni: None, po: r.pos.map(|p| JPo { lat: p.lat, lon: p.lon, alt: p.alt, precision_bits: p.bits, precision_known: p.known }),
        te: None, nb: None, tr: None, mr: None,
    };
    match r.detail.as_deref() {
        Some(Detail::MapReport(m)) => {
            j.mr = Some(JMr {
                region: s(m.region),
                modem_preset: s(m.preset),
                has_default_channel: m.default_channel,
                long_name: s(m.long_name),
                short_name: s(m.short_name),
                hw_model: s(m.hw_model),
                role: s(m.role),
            })
        }
        Some(Detail::NodeInfo(n)) => {
            j.ni = Some(JNi { long_name: s(n.long_name), short_name: s(n.short_name), hw_model: s(n.hw_model), role: s(n.role), has_public_key: n.has_public_key, identity_untrusted: n.untrusted })
        }
        Some(Detail::Telemetry(t)) => j.te = Some(JTe { kind: s(t.kind), battery: t.battery, voltage: t.voltage, ch_util: t.ch_util, air_util: t.air_util, uptime: t.uptime }),
        Some(Detail::Neighbors(n)) => j.nb = Some(JNbs { neighbors: Some(n.iter().map(|&(id, snr)| JNb { id, snr }).collect()) }),
        Some(Detail::Traceroute(t)) => {
            j.tr = Some(JTr { valid: t.valid, is_reply: t.is_reply, route: jh(&t.route), snr_towards: Some(t.snr_towards.clone()), route_back: jh(&t.route_back), snr_back: Some(t.snr_back.clone()) })
        }
        None => {}
    }
    j
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_round_trips_an_api_row() {
        let text = r#"{"i":7,"t":1793414269260,"b":"no868","g":304365663,"s":1275887421,"d":4294967295,"p":369828293,"c":"NarrowFast","y":"nodeinfo","l":"6d09cc29ab957b72","o":"3fc571de3bbcedf8","sn":7,"rs":-106,"hs":7,"hl":0,"r":19,"sg":"unsigned","rr":"relayed","cr":"ctr_unauthenticated","by":84,"ni":{"long_name":"HORTEN","short_name":"NORb","hw_model":"SEEED","role":"CLIENT_BASE","has_public_key":true}}"#;
        let mut i = Interner::default();
        let j: JRow = serde_json::from_str(text).unwrap();
        let r = j.into_row(&mut i);
        assert_eq!((r.id, r.src, r.ty, r.rr, r.hops()), (7, 1275887421, ty::NODEINFO, ty::RELAYED, Some(7)));
        assert_eq!(i.s(r.nodeinfo().unwrap().short_name), "NORb");
        let back = serde_json::to_string(&to_json(&r, &i)).unwrap();
        let again: JRow = serde_json::from_str(&back).unwrap();
        assert_eq!(again.into_row(&mut i), r);
    }
}
