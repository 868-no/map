//! Per-node output shapes and the rows they come from.

use serde::Serialize;

use super::{latest_by, newer, Downlink};
use crate::geo::{precision_error_m, Estimate};
use crate::graph::{distance_m, LatLon};
use crate::row::{ty, Interner, Position as RowPos, Row};
use crate::util::{iso, map, node_id, set, FxMap, FxSet, BROADCAST};

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
    /// "mapreport" when the identity comes from the node's own map report
    /// (no NodeInfo in the window); empty for NodeInfo.
    #[serde(skip_serializing_if = "str::is_empty")]
    pub source: &'static str,
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

fn is_zero(n: &usize) -> bool {
    *n == 0
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
    /// Its newest reported position, when that is older than STALE_POSITION_MS
    /// before the window's latest observation (D-094): it is then no anchor
    /// and the node is estimated; without an estimate it is left off the map,
    /// since links drawn to an old place would mislead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_position: Option<Position>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub telemetry: Option<Telemetry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    /// For a node only named by others (status "referenced"): when it was last named.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_referenced: Option<String>,
    pub packets: usize,
    pub receptions: usize,
    /// Of `receptions`, those it uplinked itself as a gateway (its own map
    /// reports among them): not heard over the air by anyone else.
    #[serde(skip_serializing_if = "is_zero")]
    pub own_uplinks: usize,
    pub gateway_receptions: usize,
    pub is_gateway: bool,
    /// A gateway that uplinks every copy of a packet it hears, not only the
    /// first (a future firmware option, D-084).
    #[serde(skip_serializing_if = "is_false")]
    pub multi_uplink: bool,
    pub signatures: Signatures,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brokers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "is_false")]
    pub mqtt_opt_out: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate: Option<Estimate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mqtt_downlink: Option<Downlink>,
    /// When it last moved more than a few hundred metres (D-073): links use
    /// only evidence from after that.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_at: Option<String>,
    /// Its positions in time order, newest last, when it moved (D-073).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<Vec<crate::movement::TrackPoint>>,
    /// Moving and reporting more than 750 m above sea level (D-073).
    #[serde(skip_serializing_if = "is_false")]
    pub airborne: bool,
    /// Its position narrowed from reports jumping around one place (D-077);
    /// the map places it here rather than at the latest report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refined: Option<crate::movement::Anchor>,
    /// Routers: how often it is seen relaying what it should relay (D-078).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relaying: Option<crate::reliability::Relaying>,
    #[serde(skip)]
    pub(super) first: i64,
    #[serde(skip)]
    pub(super) last: i64,
    #[serde(skip)]
    pub(super) pos: Option<RowPos>,
}

impl Node {
    /// Its narrowed position (D-077); call after its position is set.
    pub(super) fn set_anchor(&mut self, a: &crate::movement::Anchor) {
        if !a.narrowed {
            return; // the latest report already says as much; it only stops counting as moving
        }
        self.refined = Some(a.clone());
        if let Some(p) = self.pos.as_mut() {
            p.lat = a.lat;
            p.lon = a.lon;
        }
    }

    pub(super) fn set_movement(&mut self, m: &crate::movement::Movement) {
        self.moved_at = Some(iso(m.moved_at));
        self.track = Some(m.track.clone());
        self.airborne = self.position.as_ref().and_then(|p| p.alt).is_some_and(|a| a > crate::movement::AIRBORNE_M);
    }

    pub(super) fn new(n: u32) -> Self {
        Node {
            id: node_id(n), num: n, status: "observed", identity: None, position: None, stale_position: None, telemetry: None, first_seen: None, last_seen: None, last_referenced: None, own_uplinks: 0,
            packets: 0, receptions: 0, gateway_receptions: 0, is_gateway: false, multi_uplink: false, signatures: Signatures::default(), brokers: None,
            mqtt_opt_out: false, estimate: None, estimate_note: None, mqtt_downlink: None, moved_at: None, track: None, airborne: false, refined: None, relaying: None, first: i64::MAX, last: i64::MIN, pos: None,
        }
    }
}

pub fn is_identity(r: &Row) -> bool {
    r.ty == ty::NODEINFO && !r.nodeinfo().is_some_and(|n| n.untrusted)
}
/// A node's own map report that names it: its identity when the window
/// holds no NodeInfo from it (nodes heard only through their map reports).
pub fn is_named_report(r: &Row) -> bool {
    r.ty == ty::MAPREPORT && r.map_report().is_some_and(|m| m.long_name != 0 || m.short_name != 0)
}
pub fn is_position(r: &Row) -> bool {
    (r.ty == ty::POSITION || r.ty == ty::MAPREPORT) && r.pos.is_some()
}
pub fn is_device_telemetry(r: &Row) -> bool {
    r.ty == ty::TELEMETRY && r.telemetry().is_some_and(|t| t.kind == ty::DEVICE)
}

/// Environment telemetry with at least one reading (D-099).
pub fn is_environment(r: &Row) -> bool {
    r.ty == ty::TELEMETRY && r.telemetry().is_some_and(|t| t.kind != ty::DEVICE && (t.temp.is_some() || t.humidity.is_some() || t.pressure.is_some()))
}

pub(super) fn identity_of(r: &Row, i: &Interner) -> Identity {
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
        source: "",
    }
}

/// The identity a named map report gives (see `is_named_report`).
pub(super) fn identity_of_report(r: &Row, i: &Interner) -> Identity {
    let m = r.map_report().unwrap();
    Identity {
        long_name: i.s(m.long_name).to_string(),
        short_name: i.s(m.short_name).to_string(),
        hw_model: i.s(m.hw_model).to_string(),
        role: i.s(m.role).to_string(),
        has_public_key: false, // map reports do not carry it
        signature: i.s(r.sig).to_string(),
        observed_at: iso(r.t),
        source: "mapreport",
    }
}

pub(super) fn position_of(r: &Row, i: &Interner) -> Position {
    let p = r.pos.unwrap();
    Position { lat: p.lat, lon: p.lon, alt: p.alt, precision_bits: p.bits, precision_known: p.known, signature: i.s(r.sig).to_string(), observed_at: iso(r.t), source: i.s(r.ty).to_string() }
}

pub(super) fn telemetry_of(r: &Row) -> Telemetry {
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

/// A reported position older than this before the window's latest
/// observation is stale: the node is estimated instead (D-094).
pub const STALE_POSITION_MS: i64 = 24 * 3600 * 1000;

/// Each node's position row, unless its newest position report is stale
/// relative to `now`; stale rows are returned separately.
pub(super) fn fresh_position_rows<'a>(rows: &[&'a Row], now: i64) -> (FxMap<u32, &'a Row>, FxMap<u32, &'a Row>) {
    let newest = latest_by(rows, |r| (r.ty == ty::POSITION || r.ty == ty::MAPREPORT) && r.pos.is_some(), |r| r.src);
    position_rows(rows).into_iter().partition(|(n, _)| newest.get(n).is_some_and(|r| now - r.t <= STALE_POSITION_MS))
}

/// Each node's position row: latest of each packet type, then choose_position.
pub(super) fn position_rows<'a>(rows: &[&'a Row]) -> FxMap<u32, &'a Row> {
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

pub(super) struct Origin {
    pub(super) first: i64,
    pub(super) last: i64,
    pub(super) packets: FxSet<u64>,
    pub(super) receptions: FxSet<u64>,
    /// Receptions it uplinked itself, as a gateway (map reports among them).
    pub(super) own_uplinks: FxSet<u64>,
    sig_rows: Vec<(u64, u32)>, // (packet, status) of every copy
    brokers: FxSet<u32>,
    pub(super) opt_out: bool,
}

pub(super) fn origins(rows: &[&Row]) -> FxMap<u32, Origin> {
    let mut m: FxMap<u32, Origin> = map();
    for r in rows {
        let o = m.entry(r.src).or_insert_with(|| Origin { first: r.t, last: r.t, packets: set(), receptions: set(), own_uplinks: set(), sig_rows: vec![], brokers: set(), opt_out: false });
        o.first = o.first.min(r.t);
        o.last = o.last.max(r.t);
        o.packets.insert(r.lp);
        o.receptions.insert(r.ok);
        if r.gw == Some(r.src) {
            o.own_uplinks.insert(r.ok);
        }
        o.sig_rows.push((r.lp, r.sig));
        o.brokers.insert(r.broker);
        o.opt_out |= r.nk;
    }
    m
}

/// One status per packet, its best copy's: relays can strip a signature, so
/// a packet some gateway verified counts as verified, once.
pub(super) fn sig_counts(o: &Origin, i: &Interner) -> Signatures {
    let mut best: FxMap<u64, u32> = map();
    for &(lp, s) in &o.sig_rows {
        let b = best.entry(lp).or_insert(s);
        if crate::packets::sig_rank(i.s(s)) > crate::packets::sig_rank(i.s(*b)) {
            *b = s;
        }
    }
    let mut out = Signatures::default();
    for s in best.values() {
        match i.s(*s) {
            "verified" => out.verified += 1,
            "unsigned" => out.unsigned += 1,
            "unverifiable" => out.unverifiable += 1,
            _ => out.not_applicable += 1,
        }
    }
    out
}

pub(super) fn brokers(o: &Origin, i: &Interner) -> Vec<String> {
    let mut b: Vec<String> = o.brokers.iter().map(|&x| i.s(x).to_string()).collect();
    b.sort();
    b
}

/// Nodes named in others' NeighborInfo, valid traceroute hops or traceroute
/// destinations, with when they were last named.
pub fn referenced(rows: &[&Row]) -> FxMap<u32, i64> {
    let mut out: FxMap<u32, i64> = map();
    for r in rows {
        let mut add = |n: u32| {
            if n > 0 && n < BROADCAST {
                let t = out.entry(n).or_insert(r.t);
                *t = (*t).max(r.t);
            }
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::views::test_rows::pos;

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

    #[test]
    fn positions_older_than_a_day_are_stale() {
        const H: i64 = 3_600_000;
        let (p, m) = (ty::POSITION, ty::MAPREPORT);
        let old = pos(1, p, 61.2, 32, 0);
        let rows = [&old];
        let (fresh, stale) = fresh_position_rows(&rows, 24 * H);
        assert!(fresh.contains_key(&1) && stale.is_empty(), "exactly a day old is still fresh");
        let (fresh, stale) = fresh_position_rows(&rows, 25 * H);
        assert!(fresh.is_empty() && stale.contains_key(&1));
        // A recent map report that agrees with an older precise position keeps it fresh,
        // even though the precise one is what gets shown.
        let recent = pos(2, m, 61.2001, 14, 24 * H);
        let rows = [&old, &recent];
        let (fresh, _) = fresh_position_rows(&rows, 25 * H);
        assert_eq!(fresh.get(&1).map(|r| r.id), Some(1));
    }
}
