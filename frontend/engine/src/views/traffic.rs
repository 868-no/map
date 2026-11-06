//! Packets and receptions over time.

use serde::Serialize;

use crate::row::{Interner, Row};
use crate::util::{iso, FxMap};

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
    let mut firsts: FxMap<u64, (i64, u32)> = FxMap::with_capacity_and_hasher(rows.len(), Default::default());
    let mut recs: FxMap<u64, i64> = FxMap::with_capacity_and_hasher(rows.len(), Default::default());
    let (mut lo, mut hi) = (i64::MAX, i64::MIN);
    for r in rows {
        firsts.entry(r.lp).and_modify(|f| {
            f.0 = f.0.min(r.t);
            if r.ty != f.1 && i.s(r.ty) < i.s(f.1) {
                f.1 = r.ty
            }
        }).or_insert((r.t, r.ty));
        recs.entry(r.ok).and_modify(|t| *t = (*t).min(r.t)).or_insert(r.t);
        lo = lo.min(r.t);
        hi = hi.max(r.t);
    }
    // Bins are dense (bucket_for keeps them to a few hundred): an array by
    // bin number from the earliest, not a search per count. Types counted by
    // interned id; named once per bucket at the end.
    let bin = |t: i64| (t - start).div_euclid(bucket);
    let first = if rows.is_empty() { 0 } else { bin(lo) };
    let n = if rows.is_empty() { 0 } else { (bin(hi) - first + 1) as usize };
    let mut buckets: Vec<(usize, usize, FxMap<u32, usize>)> = (0..n).map(|_| Default::default()).collect();
    for &t in recs.values() {
        buckets[(bin(t) - first) as usize].1 += 1;
    }
    for &(t, typ) in firsts.values() {
        let b = &mut buckets[(bin(t) - first) as usize];
        b.0 += 1;
        *b.2.entry(typ).or_default() += 1;
    }
    Traffic {
        bucket: duration_string(bucket),
        packets: firsts.len(),
        receptions: recs.len(),
        buckets: buckets
            .into_iter()
            .enumerate()
            .filter(|(_, (p, rx, _))| *p > 0 || *rx > 0)
            .map(|(k, (p, rx, bt))| Bucket { start: iso(start + (first + k as i64) * bucket), packets: p, receptions: rx, by_type: (p > 0).then(|| bt.into_iter().map(|(typ, n)| (i.s(typ).to_string(), n)).collect()) })
            .collect(),
    }
}
