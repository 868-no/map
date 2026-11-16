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
/// How many of its newest packets tell the hop limit it uses now (D-226).
pub const HOP_RECENT: usize = 10;

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
        // Its limit now: the most common among its newest packets, so a
        // limit lowered within the window is judged as lowered (D-226).
        let mut sent: Vec<(i64, i16)> = pk.values().filter_map(|r| r.hs.map(|h| (r.t, h))).collect();
        sent.sort_unstable();
        let mut starts: FxMap<i16, usize> = map();
        for &(_, h) in sent.iter().rev().take(HOP_RECENT) {
            *starts.entry(h).or_default() += 1;
        }
        let Some((&hs, _)) = starts.iter().max_by_key(|&(h, c)| (*c, *h)) else { continue };
        // What its packets sent with that limit needed.
        let mut needed: Vec<i16> = pk.values().filter(|r| r.hs == Some(hs)).filter_map(|r| fewest.get(&r.lp).copied()).collect();
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

#[cfg(test)]
mod tests {
    use crate::health::tests::{issues, H};
    use crate::row::{Interner, JRow, Row};

    /// Node 5's packet `k` sent with hop limit `hs`, heard by gateway 9 after one hop.
    fn sent(i: &mut Interner, k: i64, hs: i16) -> Row {
        let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":9,"s":5,"y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","hs":{hs},"hl":{}}}"#, k * H / 10, hs - 1);
        serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
    }

    #[test]
    fn a_hop_limit_lowered_in_the_window_is_judged_as_lowered() {
        let mut i = Interner::default();
        let mut rows: Vec<Row> = (1..=30).map(|k| sent(&mut i, k, 7)).collect();
        let got = issues(&rows, &i);
        let h = got.iter().find(|x| x.kind == "hop_limit").expect("limit 7, one hop needed");
        assert!(h.summary.starts_with("Hop limit 7, but its packets needed at most 1"), "{h:?}");
        // Lowered to 3: its newest packets say so, and 3 is not flagged.
        rows.extend((31..=40).map(|k| sent(&mut i, k, 3)));
        assert!(issues(&rows, &i).iter().all(|x| x.kind != "hop_limit"));
        // A reply now and then with another hop start does not change it.
        rows.truncate(30);
        rows.extend((31..=33).map(|k| sent(&mut i, k, 3)));
        assert!(issues(&rows, &i).iter().any(|x| x.kind == "hop_limit"));
    }
}
