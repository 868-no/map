//! Hop limit higher than its packets needed.

use super::{Ctx, Issues};
use crate::util::{map, FxMap};

/// Packets with a known hop count before the hop-limit rule applies, how
/// many hops more than its packets needed (95th percentile) count as too
/// many, and the lowest hop limit it applies to. Gateways are only part of
/// the mesh, so a limit a little above what they needed is fine.
pub const HOP_MIN_PACKETS: usize = 20;
pub const HOP_SPARE: i16 = 3;
pub const HOP_FLAG_FROM: i16 = 6;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let mut fewest: FxMap<u64, i16> = map();
    for &r in cx.rows {
        if r.gw.is_some_and(|g| g != r.src)
            && r.over_radio()
            && let Some(h) = r.hops().filter(|&h| h >= 0)
        {
            let e = fewest.entry(r.lp).or_insert(h);
            *e = (*e).min(h);
        }
    }
    for (&n, pk) in &cx.own {
        let mut starts: FxMap<i16, usize> = map();
        let mut needed: Vec<i16> = Vec::new();
        for r in pk.values() {
            if let Some(hs) = r.hs {
                *starts.entry(hs).or_default() += 1;
            }
            if let Some(&f) = fewest.get(&r.lp) {
                needed.push(f);
            }
        }
        let Some((&hs, _)) = starts.iter().max_by_key(|&(h, c)| (*c, *h)) else { continue };
        if needed.len() < HOP_MIN_PACKETS || hs < HOP_FLAG_FROM {
            continue;
        }
        needed.sort_unstable();
        let p95 = needed[(needed.len() * 95).div_ceil(100).saturating_sub(1)];
        if hs - p95 >= HOP_SPARE {
            let suggest = (p95 + 1).max(3);
            out.add(n, "hop_limit", "notice", format!("Hop limit {hs}, but its packets needed at most {p95}"), format!("Gateways heard 95 % of its {} packets within {p95} hops, yet it sends with a hop limit of {hs}: every spare hop is another round of rebroadcasts. A limit around {suggest} would likely reach the same gateways (nodes beyond them are not seen here; the reach simulator under Details shows what each limit reaches).", needed.len()));
        }
    }
}
