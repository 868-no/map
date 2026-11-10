//! Packets and receptions over time.

use serde::Serialize;

use crate::row::Row;
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
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Bucket {
    pub start: String,
    pub packets: usize,
    pub receptions: usize,
}

#[derive(Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Traffic {
    pub bucket: String,
    pub buckets: Vec<Bucket>,
    pub packets: usize,
    pub receptions: usize,
}

/// Unique packets (in the bucket of their first in-window reception) counted
/// separately from receptions, so several gateways never inflate packets.
pub fn build_traffic(rows: &[&Row], start: i64, bucket: i64) -> Traffic {
    let mut firsts: FxMap<u64, i64> = FxMap::with_capacity_and_hasher(rows.len(), Default::default());
    let mut recs: FxMap<u64, i64> = FxMap::with_capacity_and_hasher(rows.len(), Default::default());
    let (mut lo, mut hi) = (i64::MAX, i64::MIN);
    for r in rows {
        firsts.entry(r.lp).and_modify(|t| *t = (*t).min(r.t)).or_insert(r.t);
        recs.entry(r.ok).and_modify(|t| *t = (*t).min(r.t)).or_insert(r.t);
        lo = lo.min(r.t);
        hi = hi.max(r.t);
    }
    // Bins are dense (bucket_for keeps them to a few hundred): an array by
    // bin number from the earliest, not a search per count.
    let bin = |t: i64| (t - start).div_euclid(bucket);
    let first = if rows.is_empty() { 0 } else { bin(lo) };
    let n = if rows.is_empty() { 0 } else { (bin(hi) - first + 1) as usize };
    let mut buckets: Vec<(usize, usize)> = vec![(0, 0); n];
    for &t in recs.values() {
        buckets[(bin(t) - first) as usize].1 += 1;
    }
    for &t in firsts.values() {
        buckets[(bin(t) - first) as usize].0 += 1;
    }
    Traffic {
        bucket: duration_string(bucket),
        packets: firsts.len(),
        receptions: recs.len(),
        buckets: buckets
            .into_iter()
            .enumerate()
            .filter(|(_, (p, rx))| *p > 0 || *rx > 0)
            .map(|(k, (p, rx))| Bucket { start: iso(start + (first + k as i64) * bucket), packets: p, receptions: rx })
            .collect(),
    }
}
