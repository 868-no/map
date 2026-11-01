//! Link graph from in-window evidence (spec §7); ported from the backend's
//! internal/graph via the TypeScript worker. Pure: callers pass only rows
//! inside the window.

use serde::Serialize;

use crate::row::Hop;
use crate::util::{iso, map, node_id, round2, set, FxMap, FxSet, BROADCAST};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Ev {
    Neighbor,
    Traceroute,
    DirectRf,
    RelayHint,
}

/// What makes two samples the same RF event (deduplicated per edge and type).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum SKey {
    None,
    Lp(u64),
    Ok(u64),
    Tr(u64, u8, u16),
}

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub src: u32,
    pub dst: u32,
    pub ev: Ev,
    pub t: i64,
    pub snr: Option<f64>,
    pub rssi: Option<f64>,
    pub key: SKey,
}

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Stats {
    pub n: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<f64>,
}

#[derive(Serialize, Clone, Copy, Default, Debug, PartialEq)]
pub struct EvidenceCounts {
    pub neighbor: u32,
    pub traceroute: u32,
    pub direct_rf: u32,
    pub relay_hint: u32,
}

impl EvidenceCounts {
    pub fn direct(&self) -> u32 {
        self.neighbor + self.traceroute + self.direct_rf
    }
}

/// Directed src -> dst: dst heard src.
#[derive(Serialize, Clone, Debug)]
pub struct Edge {
    pub src: String,
    pub dst: String,
    pub src_num: u32,
    pub dst_num: u32,
    pub evidence: EvidenceCounts,
    pub samples: u32,
    pub confidence: &'static str,
    pub inferred: bool,
    pub reason: &'static str,
    pub snr: Stats,
    pub rssi: Stats,
    pub first_at: String,
    pub last_at: String,
    /// Carried over MQTT, not radio: built only from traceroute hops recorded
    /// at exactly 0 dB (D-055). Kept apart from radio links.
    #[serde(skip_serializing_if = "is_false")]
    pub mqtt: bool,
    #[serde(skip)]
    pub first: i64,
    #[serde(skip)]
    pub last: i64,
}

struct Acc {
    keys: FxSet<(Ev, SKey)>,
    counts: EvidenceCounts,
    snr: Vec<(i64, f64)>,
    rssi: Vec<(i64, f64)>,
    first: i64,
    last: i64,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Splits off traceroute hops that went over MQTT: a packet a node took from
/// a broker (downlink) has no radio reception, so the hop into it records
/// exactly 0 dB. Only hops into probable downlinking nodes (views::downlinks,
/// D-054) count: elsewhere a 0 dB reading is a genuine one that rounded to 0
/// (D-055). Returns (radio, mqtt).
pub fn split_mqtt(samples: Vec<Sample>, downlinkers: &FxSet<u32>) -> (Vec<Sample>, Vec<Sample>) {
    samples.into_iter().partition(|s| !(s.ev == Ev::Traceroute && s.snr == Some(0.0) && downlinkers.contains(&s.dst)))
}

/// MQTT links from split-off samples: marked, with no radio signal statistics.
pub fn reduce_mqtt(samples: &[Sample]) -> Vec<Edge> {
    let mut out = reduce(samples);
    for e in &mut out {
        e.mqtt = true;
        e.reason = "traceroute hop recorded at exactly 0 dB: the receiver took the packet from an MQTT broker, not over radio";
        e.snr = Stats::default();
        e.rssi = Stats::default();
    }
    out
}

fn invalid(n: u32) -> bool {
    n == 0 || n == BROADCAST
}

/// Folds samples into edges; duplicate samples (same key, direction and evidence) count once.
pub fn reduce(samples: &[Sample]) -> Vec<Edge> {
    let mut m: FxMap<(u32, u32), Acc> = map();
    for s in samples {
        if s.src == s.dst || invalid(s.src) || invalid(s.dst) {
            continue;
        }
        let a = m.entry((s.src, s.dst)).or_insert_with(|| Acc { keys: set(), counts: EvidenceCounts::default(), snr: vec![], rssi: vec![], first: s.t, last: s.t });
        if s.key != SKey::None && !a.keys.insert((s.ev, s.key)) {
            continue;
        }
        match s.ev {
            Ev::Neighbor => a.counts.neighbor += 1,
            Ev::Traceroute => a.counts.traceroute += 1,
            Ev::DirectRf => a.counts.direct_rf += 1,
            Ev::RelayHint => a.counts.relay_hint += 1,
        }
        if let Some(v) = s.snr.filter(|v| !v.is_nan()) {
            a.snr.push((s.t, v));
        }
        if let Some(v) = s.rssi.filter(|v| !v.is_nan()) {
            a.rssi.push((s.t, v));
        }
        a.first = a.first.min(s.t);
        a.last = a.last.max(s.t);
    }
    let mut out: Vec<Edge> = m
        .into_iter()
        .map(|((src, dst), a)| {
            let c = a.counts;
            let (confidence, inferred, reason) = confidence(&c);
            Edge {
                src: node_id(src),
                dst: node_id(dst),
                src_num: src,
                dst_num: dst,
                evidence: c,
                samples: c.neighbor + c.traceroute + c.direct_rf + c.relay_hint,
                confidence,
                inferred,
                reason,
                snr: stats(&a.snr, true),
                rssi: stats(&a.rssi, true),
                first_at: iso(a.first),
                last_at: iso(a.last),
                mqtt: false,
                first: a.first,
                last: a.last,
            }
        })
        .collect();
    out.sort_by(|x, y| y.samples.cmp(&x.samples).then(x.src_num.cmp(&y.src_num)).then(x.dst_num.cmp(&y.dst_num)));
    out
}

fn confidence(c: &EvidenceCounts) -> (&'static str, bool, &'static str) {
    let types = [c.neighbor, c.traceroute, c.direct_rf, c.relay_hint].iter().filter(|&&n| n > 0).count();
    if c.neighbor > 0 || c.traceroute > 0 {
        if types > 1 {
            return ("high", false, "reported by NeighborInfo/traceroute and corroborated by other evidence");
        }
        if c.neighbor > 0 {
            return ("high", false, "reported by NeighborInfo");
        }
        return ("high", false, "observed traceroute segment");
    }
    if c.direct_rf > 0 {
        if c.relay_hint > 0 {
            return ("medium", false, "direct gateway RF reception, corroborated by relay hints");
        }
        return ("medium", false, "direct gateway RF reception (zero-hop packet)");
    }
    ("low", true, "inferred from unique relay-node byte; not directly confirmed")
}

/// Median (mean of the middle pair when even), min, max and latest value;
/// rounded to 0.01 when `round` (edge statistics) or as-is (SQL aggregates).
pub fn stats(v: &[(i64, f64)], round: bool) -> Stats {
    if v.is_empty() {
        return Stats::default();
    }
    let mut last = v[0];
    for &x in v {
        if x.0 > last.0 {
            last = x;
        }
    }
    let mut vals: Vec<f64> = v.iter().map(|x| x.1).collect();
    vals.sort_by(|a, b| a.total_cmp(b));
    let h = vals.len() / 2;
    let med = if vals.len() % 2 == 0 { (vals[h - 1] + vals[h]) / 2.0 } else { vals[h] };
    let r = |x: f64| if round { round2(x) } else { x };
    Stats { n: vals.len(), median: Some(if round { round2(med) } else { med }), min: Some(r(vals[0])), max: Some(r(vals[vals.len() - 1])), last: Some(r(last.1)) }
}

/// Adjacent segments actually traversed. snr[k] is measured at the receiver
/// of segment k of [origin, route...]; one extra trailing SNR means the
/// endpoint received it too. For a reply the forward path runs to -> route
/// -> from, and the return path from -> route_back -> to. Segments touching
/// an unknown hop produce nothing; no shortcut is invented.
#[allow(clippy::too_many_arguments)]
pub fn traceroute_samples(from: u32, to: u32, is_reply: bool, route: &[Hop], snr_t: &[Option<f64>], route_back: &[Hop], snr_b: &[Option<f64>], t: i64, lp: u64, out: &mut Vec<Sample>) {
    let (fo, fd) = if is_reply { (to, from) } else { (from, to) };
    segments(fo, fd, route, snr_t, t, lp, 0, out);
    if is_reply {
        segments(from, to, route_back, snr_b, t, lp, 1, out);
    }
}

#[allow(clippy::too_many_arguments)]
fn segments(origin: u32, dest: u32, route: &[Hop], snr: &[Option<f64>], t: i64, lp: u64, dir: u8, out: &mut Vec<Sample>) {
    let mut seq = Vec::with_capacity(route.len() + 2);
    seq.push(Hop { id: origin, unknown: false });
    seq.extend_from_slice(route);
    if snr.len() == route.len() + 1 {
        seq.push(Hop { id: dest, unknown: false });
    }
    for k in 0..seq.len().saturating_sub(1) {
        let (a, b) = (seq[k], seq[k + 1]);
        if a.unknown || b.unknown {
            continue;
        }
        out.push(Sample { src: a.id, dst: b.id, ev: Ev::Traceroute, t, snr: snr.get(k).copied().flatten(), rssi: None, key: SKey::Tr(lp, dir, k as u16) });
    }
}

// ---- relay hints ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

/// Great-circle distance in metres.
pub fn distance_m(a: LatLon, b: LatLon) -> f64 {
    let r = std::f64::consts::PI / 180.0;
    let (dlat, dlon) = ((b.lat - a.lat) * r, (b.lon - a.lon) * r);
    let h = (dlat / 2.0).sin().powi(2) + (a.lat * r).cos() * (b.lat * r).cos() * (dlon / 2.0).sin().powi(2);
    2.0 * 6_371_000.0 * h.sqrt().asin()
}

/// Relay candidates lie within the longest confirmed link plus margin, never below 50 km.
pub const MIN_RELAY_RANGE_M: f64 = 50_000.0;
pub const RELAY_RANGE_SLACK: f64 = 1.25;

/// Roles that may relay without spending a hop (Meshtastic's favourite-router "0-cost" rule).
pub fn zero_cost_role(role: &str) -> bool {
    matches!(role, "ROUTER" | "ROUTER_LATE" | "CLIENT_BASE")
}

/// What the window knows for narrowing a last-hop byte.
#[derive(Default)]
pub struct RelayContext {
    by_byte: Vec<Vec<u32>>, // window nodes by low byte
    pub pos: FxMap<u32, LatLon>,
    confirmed: FxSet<(u32, u32)>,
    silent: FxSet<u32>, // known never to rebroadcast (CLIENT_MUTE)
    pub max_range_m: f64,
}

fn pair(a: u32, b: u32) -> (u32, u32) {
    if a < b { (a, b) } else { (b, a) }
}

impl RelayContext {
    /// known: window nodes; pos: reported positions only; confirmed:
    /// non-relay evidence pairs (src, dst); silent: nodes that never rebroadcast.
    pub fn new(known: impl IntoIterator<Item = u32>, pos: FxMap<u32, LatLon>, confirmed: impl IntoIterator<Item = (u32, u32)>, silent: FxSet<u32>) -> Self {
        let mut c = RelayContext { by_byte: vec![Vec::new(); 256], pos, confirmed: set(), silent, max_range_m: MIN_RELAY_RANGE_M };
        for k in known {
            c.by_byte[(k & 0xff) as usize].push(k);
        }
        let mut longest: f64 = 0.0;
        for (a, b) in confirmed {
            c.confirmed.insert(pair(a, b));
            if let (Some(&pa), Some(&pb)) = (c.pos.get(&a), c.pos.get(&b)) {
                longest = longest.max(distance_m(pa, pb));
            }
        }
        c.max_range_m = MIN_RELAY_RANGE_M.max(longest * RELAY_RANGE_SLACK);
        c
    }

    /// Narrows a last-hop byte to one node: window nodes with that low byte
    /// other than origin and gateway, minus those positioned beyond radio
    /// range of the gateway and those whose role never rebroadcasts; if
    /// several remain, the single one with confirmed evidence to the gateway
    /// wins. A byte equal to the gateway's own is the gateway itself.
    pub fn resolve(&self, hint: u8, origin: u32, gw: u32) -> Option<Result<u32, ()>> {
        if hint == 0 || hint == (gw & 0xff) as u8 {
            return None; // unmatched
        }
        let gp = self.pos.get(&gw);
        let mut cands: Vec<u32> = Vec::new();
        for &k in self.by_byte.get(hint as usize).map_or(&[][..], |v| v) {
            if k == origin || k == gw || self.silent.contains(&k) {
                continue;
            }
            if let (Some(&p), Some(&g)) = (self.pos.get(&k), gp) {
                if distance_m(p, g) > self.max_range_m {
                    continue;
                }
            }
            cands.push(k);
        }
        match cands.len() {
            0 => None,
            1 => Some(Ok(cands[0])),
            _ => {
                let linked: Vec<u32> = cands.into_iter().filter(|&k| self.confirmed.contains(&pair(k, gw))).collect();
                if linked.len() == 1 { Some(Ok(linked[0])) } else { Some(Err(())) }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A traceroute hop src -> dst in traceroute lp, received at snr.
    fn hop(src: u32, dst: u32, lp: u64, snr: f64) -> Sample {
        Sample { src, dst, ev: Ev::Traceroute, t: 0, snr: Some(snr), rssi: None, key: SKey::Tr(lp, 0, 0) }
    }

    #[test]
    fn zero_db_hops_into_downlinking_nodes_go_over_mqtt() {
        // 2 downlinks. Its 0 dB hops go over MQTT; its other readings, and 0 dB
        // readings at 4 (an ordinary node), stay radio.
        let v = vec![hop(1, 2, 1, 0.0), hop(1, 2, 2, 0.0), hop(1, 2, 2, 0.0), hop(3, 2, 3, 0.0), hop(1, 2, 4, 5.0), hop(3, 4, 5, 0.0)];
        let (radio, mqtt) = split_mqtt(v, &[2].into_iter().collect());
        let pairs = |s: &[Sample]| s.iter().map(|x| (x.src, x.dst, x.snr.unwrap())).collect::<Vec<_>>();
        assert_eq!(pairs(&mqtt), vec![(1, 2, 0.0), (1, 2, 0.0), (1, 2, 0.0), (3, 2, 0.0)]);
        assert_eq!(pairs(&radio), vec![(1, 2, 5.0), (3, 4, 0.0)]);
        let e = reduce_mqtt(&mqtt);
        let bridge = e.iter().find(|x| x.src_num == 1).unwrap();
        assert!(bridge.mqtt && bridge.snr.n == 0);
        assert_eq!(bridge.evidence.traceroute, 2, "copies of one traceroute count once");
    }

    fn ctx(known: &[u32], confirmed: &[(u32, u32)]) -> RelayContext {
        RelayContext::new(known.iter().copied(), map(), confirmed.iter().copied(), set())
    }

    #[test]
    fn relay_resolution() {
        let c = ctx(&[0x1111_1142, 0x2222_2242, 0x3333_3333], &[]);
        assert_eq!(c.resolve(0x42, 0, 0), Some(Err(())), "ambiguous");
        assert_eq!(c.resolve(0, 0, 0), None);
        assert_eq!(c.resolve(0x99, 0, 0), None);
        assert_eq!(c.resolve(0x33, 0, 0), Some(Ok(0x3333_3333)));
        assert_eq!(c.resolve(0x33, 0x3333_3333, 0), None, "origin excluded");
        assert_eq!(c.resolve(0x33, 0, 0x3333_3333), None, "gateway excluded");
        let c = ctx(&[0x1111_1142, 0x2222_2242, 0x0000_aa01], &[(0x2222_2242, 0x0000_aa01)]);
        assert_eq!(c.resolve(0x42, 5, 0x0000_aa01), Some(Ok(0x2222_2242)), "confirmed link breaks the tie");
        let c = ctx(&[0x0000_aa42, 0x1111_1142], &[]);
        assert_eq!(c.resolve(0x42, 1, 0x0000_aa42), None, "gateway byte is the gateway");
    }

    #[test]
    fn silent_roles_are_never_relays() {
        let mut silent = set();
        silent.insert(0x1111_1142);
        let c = RelayContext::new([0x1111_1142u32, 0x2222_2242], map(), [], silent);
        assert_eq!(c.resolve(0x42, 1, 2), Some(Ok(0x2222_2242)));
    }

    #[test]
    fn range_narrows_candidates() {
        let mut pos = map();
        pos.insert(0x0000_aa01, LatLon { lat: 59.9, lon: 10.7 });
        pos.insert(0x1111_1142, LatLon { lat: 59.95, lon: 10.75 });
        pos.insert(0x2222_2242, LatLon { lat: 63.4, lon: 10.4 });
        let c = RelayContext::new([0x0000_aa01u32, 0x1111_1142, 0x2222_2242], pos, [], set());
        assert_eq!(c.resolve(0x42, 5, 0x0000_aa01), Some(Ok(0x1111_1142)));
    }

    #[test]
    fn reduce_dedupes_and_ranks() {
        let s = |src, dst, ev, key| Sample { src, dst, ev, t: 1, snr: Some(5.0), rssi: None, key };
        let e = reduce(&[s(1, 2, Ev::Neighbor, SKey::Lp(9)), s(1, 2, Ev::Neighbor, SKey::Lp(9)), s(1, 2, Ev::DirectRf, SKey::Ok(1)), s(3, 3, Ev::Neighbor, SKey::None)]);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].samples, e[0].confidence, e[0].evidence.neighbor), (2, "high", 1));
    }

    #[test]
    fn traceroute_segments_skip_unknown_hops() {
        let mut out = vec![];
        let route = [Hop { id: 2, unknown: false }, Hop { id: BROADCAST, unknown: true }, Hop { id: 3, unknown: false }];
        traceroute_samples(1, 9, false, &route, &[Some(1.0), None, Some(2.0), Some(3.0)], &[], &[], 0, 7, &mut out);
        let segs: Vec<(u32, u32)> = out.iter().map(|s| (s.src, s.dst)).collect();
        assert_eq!(segs, vec![(1, 2), (3, 9)]);
    }
}
