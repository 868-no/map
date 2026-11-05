//! Packets and receptions over time.

use serde::Serialize;

use crate::row::{Interner, Row};
use crate::util::{iso, map, FxMap};

const BUCKET_LADDER: [i64; 5] = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
pub const MAX_BUCKETS: i64 = 600;

pub fn bucket_for(duration_ms: i64) -> i64 {
    for b in BUCKET_LADDER {
        if duration_ms / b <= MAX_BUCKETS {
            return b;
        }
    }
    BUCKET_LADDER[BUCKET_LADDER.len() - 1]
}

/// Go's time.Duration.String for the ladder values.
fn duration_string(ms: i64) -> String {
    let (h, m) = (ms / 3_600_000, ms % 3_600_000 / 60_000);
    if h > 0 { format!("{h}h{m}m0s") } else { format!("{m}m0s") }
}

#[derive(Serialize)]
pub struct Bucket {
    pub start: String,
    pub packets: usize,
    pub receptions: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by_type: Option<std::collections::BTreeMap<String, usize>>,
}

#[derive(Serialize)]
pub struct Traffic {
    pub bucket: String,
    pub buckets: Vec<Bucket>,
    pub packets: usize,
    pub receptions: usize,
}

/// Unique packets (in the bucket of their first in-window reception) counted
/// separately from receptions, so several gateways never inflate packets.
pub fn build_traffic(rows: &[&Row], start: i64, bucket: i64, i: &Interner) -> Traffic {
    let mut firsts: FxMap<u64, (i64, u32)> = map();
    let mut recs: FxMap<u64, i64> = map();
    for r in rows {
        firsts.entry(r.lp).and_modify(|f| {
            f.0 = f.0.min(r.t);
            if r.ty != f.1 && i.s(r.ty) < i.s(f.1) {
                f.1 = r.ty
            }
        }).or_insert((r.t, r.ty));
        recs.entry(r.ok).and_modify(|t| *t = (*t).min(r.t)).or_insert(r.t);
    }
    let bin = |t: i64| start + (t - start).div_euclid(bucket) * bucket;
    // Types counted by interned id; named once per bucket at the end.
    let mut buckets: std::collections::BTreeMap<i64, (usize, usize, FxMap<u32, usize>)> = Default::default();
    for &t in recs.values() {
        buckets.entry(bin(t)).or_default().1 += 1;
    }
    for &(t, typ) in firsts.values() {
        let b = buckets.entry(bin(t)).or_default();
        b.0 += 1;
        *b.2.entry(typ).or_default() += 1;
    }
    Traffic {
        bucket: duration_string(bucket),
        packets: firsts.len(),
        receptions: recs.len(),
        buckets: buckets.into_iter().map(|(k, (p, rx, bt))| Bucket { start: iso(k), packets: p, receptions: rx, by_type: (p > 0).then(|| bt.into_iter().map(|(typ, n)| (i.s(typ).to_string(), n)).collect()) }).collect(),
    }
}
