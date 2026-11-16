//! Evidence-backed links, MQTT ones kept apart (D-055).

use super::{first_per_packet, first_per_reception};
use crate::graph::{self, traceroute_samples, Edge, Ev, LatLon, RelayContext, SKey, Sample};
use crate::row::{ty, HeardFrom, Row};
use crate::util::{map, FxMap, FxSet};

pub const MAX_EDGES: usize = 20000;
/// Links shorter than this never show a move, whatever the window's range
/// bound: that bound falls to 50 km when few links are trusted (a filtered
/// view), and the community mesh's longest trusted link is 159 km (D-223).
pub const FAR_MOVE_MIN_M: f64 = 200_000.0;

pub struct EdgeResult {
    pub edges: Vec<Edge>,
    pub truncated: bool,
    /// The measured readings of the radio evidence, for link history (D-105).
    pub readings: super::link::LinkReadings,
    /// The relay each relayed copy here resolved to, by row id, for
    /// copies::Copies to reuse rather than resolve again.
    pub resolved: FxMap<i64, Option<u32>>,
    /// Nodes found to have moved by a link longer than radio reaches, with
    /// when they were back (D-223).
    pub moved: FxMap<u32, i64>,
}

/// Adjacent segments of every valid traceroute copy, in row order: link
/// evidence (deduplicated in reduce) and downlink evidence alike.
pub struct TracerouteHops {
    pub samples: Vec<Sample>,
    /// Per traceroute copy: its index in the rows, and where its samples end.
    pub ends: Vec<(usize, usize)>,
}

pub fn traceroute_hops(rows: &[&Row]) -> TracerouteHops {
    // Only traceroutes count: callers may pass just those (views::ByType).
    let (mut samples, mut ends) = (Vec::new(), Vec::new());
    for (k, r) in rows.iter().enumerate() {
        if r.ty != ty::TRACEROUTE {
            continue;
        }
        if let Some(t) = r.traceroute().filter(|t| t.valid) {
            traceroute_samples(r.src, r.dst.unwrap_or(0), t.is_reply, &t.route, &t.snr_towards, &t.route_back, &t.snr_back, r.t, &mut samples);
            ends.push((k, samples.len()));
        }
    }
    TracerouteHops { samples, ends }
}

/// Evidence-backed links. Relay bytes resolve only against known nodes,
/// their reported positions, and the roles that can rebroadcast.
/// `neighborinfo`: the NeighborInfo rows among them, in row order (views::ByType).
/// `hops`: traceroute_hops of the rows.
/// `downlinkers`: probable downlinking nodes, whose 0 dB traceroute hops become MQTT links (None: off).
/// `moved`: when nodes last moved (D-073); radio evidence from before either end's move is dropped.
/// `mobile`: nodes that moved in the window, spared the signal rule (D-153).
/// `estimated`: location estimates (with their uncertainty, metres) of nodes
/// without a reported position, ruling relay candidates out by range (D-222).
#[allow(clippy::too_many_arguments)]
pub fn build_edges(rows: &[&Row], neighborinfo: &[&Row], hops: &[Sample], known: &[u32], pos: FxMap<u32, LatLon>, silent: FxSet<u32>, downlinkers: Option<&FxSet<u32>>, moved: &FxMap<u32, i64>, rules: super::Rules, mobile: FxSet<u32>, estimated: FxMap<u32, (LatLon, f64)>) -> (EdgeResult, RelayContext) {
    let current = |moved: &FxMap<u32, i64>, s: &Sample| moved.get(&s.src).is_none_or(|&t| s.t >= t) && moved.get(&s.dst).is_none_or(|&t| s.t >= t);
    let mut samples: Vec<Sample> = Vec::new();
    // A. NeighborInfo: neighbour -> reporter, the first copy of each logical packet.
    for r in first_per_packet(neighborinfo.iter().copied(), |r| r.ty == ty::NEIGHBORINFO) {
        for &(id, snr) in r.neighbors() {
            samples.push(Sample { src: id, dst: r.src, ev: Ev::Neighbor, t: r.t, snr, rssi: None, key: SKey::Lp(r.lp) });
        }
    }
    // B. Traceroute: adjacent segments of every valid copy (deduplicated in
    // reduce). Hops that went over MQTT are links of their own, never radio
    // evidence (relay resolution, estimates, link statistics) (D-055).
    let mut mqtt: Vec<Sample> = Vec::new();
    match downlinkers {
        Some(d) => {
            for s in hops {
                if graph::is_mqtt_hop(s, d) { mqtt.push(*s) } else { samples.push(*s) }
            }
        }
        None => samples.extend_from_slice(hops),
    }
    // C/D. Gateway receptions: zero-hop RF -> source->gateway; relayed with a hint -> resolved after.
    let rx = first_per_reception(rows, |r| matches!(r.heard_from(), HeardFrom::Direct | HeardFrom::Relayed(Some(_))) && (r.snr.is_some() || r.rssi.is_some()));
    let mut pending: Vec<(Sample, u8, u32, u32, i64)> = Vec::new();
    for r in &rx {
        let s = Sample { src: 0, dst: r.gw.unwrap(), ev: Ev::DirectRf, t: r.t, snr: r.snr, rssi: r.rssi.map(|v| v as f64), key: SKey::Ok(r.ok) };
        match r.heard_from() {
            HeardFrom::Relayed(Some(b)) => pending.push((s, b, r.src, r.gw.unwrap(), r.id)),
            _ => samples.push(Sample { src: r.src, ..s }),
        }
    }
    samples.retain(|s| current(moved, s));
    // Each RF event once, as the link statistics count them: the range rule
    // (D-177) needs a pair seen more than once, and copies of one traceroute
    // (several gateways, or a reply repeating its request's hops) are one sighting.
    let confirmed = |samples: &[Sample]| -> Vec<(u32, u32)> {
        let mut seen: FxSet<(u32, u32, Ev, SKey)> = crate::util::set();
        samples.iter().filter(|s| s.ev != Ev::RelayHint && (s.key == SKey::None || seen.insert((s.src, s.dst, s.ev, s.key)))).map(|s| (s.src, s.dst)).collect()
    };
    let mut ctx = RelayContext::new(known.iter().copied(), pos.clone(), confirmed(&samples), silent.clone(), mobile.clone());
    // A link longer than radio reaches between where two nodes report
    // themselves: one of them was elsewhere, and moved (D-223).
    let range = (if rules.range { ctx.max_range_m } else { ctx.loose_range_m }).max(FAR_MOVE_MIN_M);
    let away = if rules.moves { far_moves(&samples, &pos, &estimated, &mobile, range) } else { map() };
    let mut moved = moved.clone();
    if !away.is_empty() {
        for (&n, &t) in &away {
            let m = moved.entry(n).or_insert(t);
            *m = (*m).max(t);
        }
        samples.retain(|s| current(&moved, s));
        let mut mobile = mobile;
        mobile.extend(away.keys().copied());
        ctx = RelayContext::new(known.iter().copied(), pos, confirmed(&samples), silent, mobile);
    }
    ctx.estimated = estimated;
    ctx.signal_rule = rules.signal;
    ctx.origin_rule = rules.origin;
    if !rules.range {
        ctx.max_range_m = ctx.loose_range_m;
    }
    let mut resolved: FxMap<i64, Option<u32>> = FxMap::with_capacity_and_hasher(pending.len(), Default::default());
    for (s, hint, origin, gw, id) in pending {
        let res = ctx.resolve_detail(hint, origin, gw, s.rssi);
        resolved.insert(id, res.and_then(Result::ok).map(|(n, _)| n));
        // A relay chosen because it already has a link to the gateway adds nothing to that link.
        if let Some(Ok((n, false))) = res {
            let s = Sample { src: n, ev: Ev::RelayHint, ..s };
            if current(&moved, &s) {
                samples.push(s)
            }
        }
    }
    let mut readings = super::link::LinkReadings::default();
    let mut edges = graph::reduce_kept(&samples, |s| readings.push(s));
    let truncated = edges.len() > MAX_EDGES;
    edges.truncate(MAX_EDGES);
    edges.extend(graph::reduce_mqtt(&mqtt));
    (EdgeResult { edges, truncated, readings, resolved, moved: away }, ctx)
}

/// Nodes that moved, judged by links (D-223): a radio sample between two
/// nodes whose reported positions (or, for a node with none, its estimate
/// less its uncertainty) lie farther apart than `range` shows one of them
/// was elsewhere then. A node placed only by its estimate moved rather than
/// one placed by a reported position; otherwise the one with the larger
/// share of its samples on such links (both on a tie). It was back after the
/// last of them. Nodes known to move by a reported position are left to their
/// positions; a mover without one is judged at its estimate. Only measured
/// evidence counts (direct receptions, NeighborInfo, traceroutes): a relay
/// byte may be a collision with another node, never a sign of moving.
fn far_moves(samples: &[Sample], pos: &FxMap<u32, LatLon>, estimated: &FxMap<u32, (LatLon, f64)>, mobile: &FxSet<u32>, range: f64) -> FxMap<u32, i64> {
    let place = |n: u32| pos.get(&n).map(|&p| (p, 0.0)).or_else(|| estimated.get(&n).copied());
    let (mut total, mut far): (FxMap<u32, u32>, FxMap<u32, u32>) = (map(), map());
    let mut found: Vec<&Sample> = Vec::new();
    for s in samples {
        *total.entry(s.src).or_default() += 1;
        *total.entry(s.dst).or_default() += 1;
        let moving = |n: u32| mobile.contains(&n) && pos.contains_key(&n);
        if s.ev == Ev::RelayHint || s.src == s.dst || moving(s.src) || moving(s.dst) {
            continue;
        }
        let (Some((a, ea)), Some((b, eb))) = (place(s.src), place(s.dst)) else { continue };
        if graph::distance_m(a, b) - ea - eb > range {
            *far.entry(s.src).or_default() += 1;
            *far.entry(s.dst).or_default() += 1;
            found.push(s);
        }
    }
    let share = |n: u32| f64::from(far[&n]) / f64::from(total[&n]);
    let mut out: FxMap<u32, i64> = map();
    for s in found {
        let guessed = |n: u32| !pos.contains_key(&n);
        let (a, b) = match (guessed(s.src), guessed(s.dst)) {
            (true, false) => (1.0, 0.0),
            (false, true) => (0.0, 1.0),
            _ => (share(s.src), share(s.dst)),
        };
        for (n, mine, theirs) in [(s.src, a, b), (s.dst, b, a)] {
            if mine >= theirs {
                let t = out.entry(n).or_insert(s.t + 1);
                *t = (*t).max(s.t + 1);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(src: u32, dst: u32, t: i64) -> Sample {
        Sample { src, dst, ev: Ev::DirectRf, t, snr: None, rssi: None, key: SKey::None }
    }

    #[test]
    fn a_link_beyond_radio_range_moves_the_end_that_has_more_of_them() {
        // D-223: T reports Oslo but was heard twice by rooftop G in Trondheim
        // (382 km); G hears its neighbours N1, N2 all the time, T its own.
        let (t, g, n1, n2, o) = (1u32, 2, 3, 4, 5);
        let oslo = LatLon { lat: 59.93, lon: 10.75 };
        let trd = LatLon { lat: 63.35, lon: 10.36 };
        let pos: FxMap<u32, LatLon> = [(t, oslo), (o, oslo), (g, trd), (n1, trd), (n2, trd)].into_iter().collect();
        let mut v: Vec<Sample> = (0..20).flat_map(|k| [s(n1, g, k), s(n2, g, k)]).collect();
        v.extend((0..5).map(|k| s(t, o, k)));
        v.extend([s(t, g, 100), s(t, g, 220)]);
        let away = far_moves(&v, &pos, &map(), &crate::util::set(), 200_000.0);
        assert_eq!(away, [(t, 221)].into_iter().collect(), "T moved and was back after its last far link");
        // Within range: nothing moved; already moving: left to its positions.
        assert!(far_moves(&v, &pos, &map(), &crate::util::set(), 400_000.0).is_empty());
        assert!(far_moves(&v, &pos, &map(), &[t].into_iter().collect(), 200_000.0).is_empty());
        // A relay byte resolved that far may be a collision: never a move.
        let hint = Sample { ev: Ev::RelayHint, ..s(t, g, 100) };
        let mut w: Vec<Sample> = v.iter().filter(|x| x.dst != g || x.src != t).copied().collect();
        w.push(hint);
        assert!(far_moves(&w, &pos, &map(), &crate::util::set(), 200_000.0).is_empty());
        // A node with no reported position counts at its estimate, less its uncertainty.
        let est: FxMap<u32, (LatLon, f64)> = [(t, (oslo, 10_000.0))].into_iter().collect();
        let no_t: FxMap<u32, LatLon> = pos.iter().filter(|e| *e.0 != t).map(|(&n, &p)| (n, p)).collect();
        assert_eq!(far_moves(&v, &no_t, &est, &crate::util::set(), 200_000.0), [(t, 221)].into_iter().collect());
        assert!(far_moves(&v, &no_t, &[(t, (oslo, 200_000.0))].into_iter().collect(), &crate::util::set(), 200_000.0).is_empty(), "too uncertain to tell");
        // An estimate gives way to a reported position, whatever the shares; a
        // mover without a reported position is judged at its estimate.
        let g_est: FxMap<u32, LatLon> = pos.iter().filter(|e| *e.0 != g).map(|(&n, &p)| (n, p)).collect();
        let at = [(g, (trd, 1_000.0))].into_iter().collect();
        assert_eq!(far_moves(&v, &g_est, &at, &crate::util::set(), 200_000.0), [(g, 221)].into_iter().collect());
        assert_eq!(far_moves(&v, &no_t, &est, &[t].into_iter().collect(), 200_000.0), [(t, 221)].into_iter().collect());
        // Two nodes known only by the far link: either could have moved.
        let away = far_moves(&[s(t, g, 7)], &pos, &map(), &crate::util::set(), 200_000.0);
        assert_eq!(away, [(t, 8), (g, 8)].into_iter().collect());
    }
}
