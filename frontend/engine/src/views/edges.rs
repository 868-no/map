//! Evidence-backed links, MQTT ones kept apart (D-055).

use super::first_per_reception;
use crate::graph::{self, reduce, traceroute_samples, Edge, Ev, LatLon, RelayContext, SKey, Sample};
use crate::row::{ty, HeardFrom, Row};
use crate::util::{map, FxMap, FxSet};

pub const MAX_EDGES: usize = 20000;

pub struct EdgeResult {
    pub edges: Vec<Edge>,
    pub truncated: bool,
    pub ambiguous: usize,
    pub unmatched: usize,
    /// The radio evidence the edges were reduced from, for link history (D-105).
    pub samples: Vec<Sample>,
    /// The relay each relayed copy here resolved to, by row id, for
    /// copies::Copies to reuse rather than resolve again.
    pub resolved: FxMap<i64, Option<u32>>,
}

/// Adjacent segments of every valid traceroute copy, in row order: link
/// evidence (deduplicated in reduce) and downlink evidence alike.
pub fn traceroute_hops(rows: &[&Row]) -> Vec<Sample> {
    // Only traceroutes count: callers may pass just those (views::ByType).
    let mut out = Vec::new();
    for r in rows {
        if r.ty != ty::TRACEROUTE {
            continue;
        }
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            traceroute_samples(r.src, r.dst.unwrap_or(0), t.is_reply, &t.route, &t.snr_towards, &t.route_back, &t.snr_back, r.t, &mut out);
        }
    }
    out
}

/// Evidence-backed links. Relay bytes resolve only against known nodes,
/// their reported positions, and the roles that can rebroadcast.
/// `neighborinfo`: the NeighborInfo rows among them, in row order (views::ByType).
/// `hops`: traceroute_hops of the rows.
/// `downlinkers`: probable downlinking nodes, whose 0 dB traceroute hops become MQTT links (None: off).
/// `moved`: when nodes last moved (D-073); radio evidence from before either end's move is dropped.
/// `mobile`: nodes that moved in the window, spared the signal rule (D-153).
#[allow(clippy::too_many_arguments)]
pub fn build_edges(rows: &[&Row], neighborinfo: &[&Row], hops: &[Sample], known: &[u32], pos: FxMap<u32, LatLon>, silent: FxSet<u32>, downlinkers: Option<&FxSet<u32>>, moved: &FxMap<u32, i64>, signal_rule: bool, mobile: FxSet<u32>) -> (EdgeResult, RelayContext) {
    let current = |s: &Sample| moved.get(&s.src).is_none_or(|&t| s.t >= t) && moved.get(&s.dst).is_none_or(|&t| s.t >= t);
    let mut samples: Vec<Sample> = Vec::new();
    // A. NeighborInfo: neighbour -> reporter, the first copy of each logical packet.
    let mut first_nb: Vec<&Row> = Vec::new();
    let mut nb_idx: FxMap<u64, usize> = map();
    for &r in neighborinfo {
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
    samples.extend_from_slice(hops);
    // Traceroute hops that went over MQTT are links of their own, never radio
    // evidence (relay resolution, estimates, link statistics) (D-055).
    let (mut samples, mqtt) = match downlinkers {
        Some(d) => graph::split_mqtt(samples, d),
        None => (samples, vec![]),
    };
    // C/D. Gateway receptions: zero-hop RF -> source->gateway; relayed with a hint -> resolved after.
    let mut rx = first_per_reception(rows, |r| matches!(r.heard_from(), HeardFrom::Direct | HeardFrom::Relayed(Some(_))) && (r.snr.is_some() || r.rssi.is_some()));
    rx.sort_unstable_by_key(|r| r.id);
    let mut pending: Vec<(Sample, u8, u32, u32, i64)> = Vec::new();
    for r in &rx {
        let s = Sample { src: 0, dst: r.gw.unwrap(), ev: Ev::DirectRf, t: r.t, snr: r.snr, rssi: r.rssi.map(|v| v as f64), key: SKey::Ok(r.ok) };
        match r.heard_from() {
            HeardFrom::Relayed(Some(b)) => pending.push((s, b, r.src, r.gw.unwrap(), r.id)),
            _ => samples.push(Sample { src: r.src, ..s }),
        }
    }
    samples.retain(|s| current(s));
    let confirmed: Vec<(u32, u32)> = samples.iter().filter(|s| s.ev != Ev::RelayHint).map(|s| (s.src, s.dst)).collect();
    let mut ctx = RelayContext::new(known.iter().copied(), pos, confirmed, silent);
    ctx.signal_rule = signal_rule;
    ctx.mobile = mobile;
    let (mut ambiguous, mut unmatched) = (0, 0);
    let mut resolved: FxMap<i64, Option<u32>> = FxMap::with_capacity_and_hasher(pending.len(), Default::default());
    for (s, hint, origin, gw, id) in pending {
        let res = ctx.resolve_detail(hint, origin, gw, s.rssi);
        resolved.insert(id, res.and_then(Result::ok).map(|(n, _)| n));
        match res {
            // Chosen because it already has a link to the gateway: adds nothing to that link.
            Some(Ok((_, true))) => {}
            Some(Ok((n, false))) => {
                let s = Sample { src: n, ev: Ev::RelayHint, ..s };
                if current(&s) {
                    samples.push(s)
                }
            }
            Some(Err(())) => ambiguous += 1,
            None => unmatched += 1,
        }
    }
    let mut edges = reduce(&samples);
    let truncated = edges.len() > MAX_EDGES;
    edges.truncate(MAX_EDGES);
    edges.extend(graph::reduce_mqtt(&mqtt));
    (EdgeResult { edges, truncated, ambiguous, unmatched, samples, resolved }, ctx)
}
