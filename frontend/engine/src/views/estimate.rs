//! Location estimates for unpositioned nodes.

use super::{GeoOptions, Node};
use crate::geo::{self, precision_error_m, Anchor, Measurement};
use crate::graph::Edge;
use crate::util::{map, node_id, FxMap};

/// Estimates for unpositioned nodes from direct (non-relay) links to precise anchors.
pub(super) fn estimate(nodes: &mut FxMap<u32, Node>, edges: &[Edge], g: &GeoOptions) {
    let mut anchors: FxMap<u32, Anchor> = map();
    for (&n, x) in nodes.iter() {
        if let Some(p) = x.pos.filter(|p| p.known && p.bits >= g.min_precision_bits && !g.exclude.contains(&n)) {
            anchors.insert(n, Anchor { node: n, lat: p.lat, lon: p.lon, err_m: precision_error_m(p.bits, p.lat) });
        }
    }
    struct Agg {
        snr_sum: f64,
        snr_w: f64,
        rssi_sum: f64,
        rssi_w: f64,
        samples: u32,
        first: i64,
        last: i64,
    }
    let mut links: FxMap<u32, Vec<(u32, Agg)>> = map(); // target -> (anchor, agg) in first-seen order
    let mut add = |target: u32, anchor: u32, e: &Edge| {
        let direct = e.evidence.direct();
        if direct == 0 {
            return;
        }
        let v = links.entry(target).or_default();
        let k = match v.iter().position(|(a, _)| *a == anchor) {
            Some(k) => k,
            None => {
                v.push((anchor, Agg { snr_sum: 0.0, snr_w: 0.0, rssi_sum: 0.0, rssi_w: 0.0, samples: 0, first: e.first, last: e.last }));
                v.len() - 1
            }
        };
        let a = &mut v[k].1;
        a.samples += direct;
        if let Some(m) = e.snr.median {
            a.snr_sum += m * e.snr.n as f64;
            a.snr_w += e.snr.n as f64;
        }
        if let Some(m) = e.rssi.median {
            a.rssi_sum += m * e.rssi.n as f64;
            a.rssi_w += e.rssi.n as f64;
        }
        a.first = a.first.min(e.first);
        a.last = a.last.max(e.last);
    };
    for e in edges.iter().filter(|e| !e.mqtt) {
        if anchors.contains_key(&e.src_num) {
            add(e.dst_num, e.src_num, e);
        }
        if anchors.contains_key(&e.dst_num) {
            add(e.src_num, e.dst_num, e);
        }
    }
    for (&n, x) in nodes.iter_mut() {
        if x.pos.is_some() || g.exclude.contains(&n) {
            continue;
        }
        let mut ms: Vec<Measurement> = links
            .get(&n)
            .map(|v| {
                v.iter()
                    .map(|(anchor, a)| Measurement {
                        anchor: *anchor,
                        samples: a.samples,
                        first: a.first,
                        last: a.last,
                        snr: (a.snr_w > 0.0).then(|| a.snr_sum / a.snr_w),
                        rssi: (a.rssi_w > 0.0).then(|| a.rssi_sum / a.rssi_w),
                    })
                    .collect()
            })
            .unwrap_or_default();
        ms.sort_by_key(|m| m.anchor);
        if ms.is_empty() {
            x.estimate_note = Some(format!("no confirmed direct links to nodes reporting a position with at least {}-bit precision", g.min_precision_bits));
            continue;
        }
        match geo::locate(&anchors, &ms, &g.params, node_id) {
            Ok(e) => x.estimate = Some(e),
            Err(reason) => x.estimate_note = Some(reason),
        }
    }
}
