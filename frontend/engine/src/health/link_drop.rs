//! Router link drop (D-197): a router's links to other routers falling
//! at one time and staying down, each link against itself, so a change
//! in which partners happen to be heard cannot fake it.

use super::{role_of, span_words, Ctx, Issue, Issues};
use crate::roles;
use crate::util::{node_id, FxSet};
use crate::views::link::RouterLink;
use crate::views::Node;

/// Router link drop (D-197): a sudden, lasting fall in the SNR of a
/// router's radio links to other routers, each link direction compared
/// with itself. The change point is searched every LINK_DROP_STEP_MS, at
/// least LINK_DROP_MIN_BEFORE_MS after its first reading and
/// LINK_DROP_MIN_AFTER_MS before the newest data, then refined to a
/// reading within LINK_DROP_REFINE_MS of it, judged by the links' medians
/// over LINK_DROP_LOCAL_MS either side, which must still be
/// LINK_DROP_MIN_AFTER_MS before the newest data. A link counts with at least
/// LINK_DROP_MIN_READINGS readings on each side. Flagged when, of at least
/// LINK_DROP_MIN_LINKS such links, at least half fell by LINK_DROP_DB or
/// more (median after against median before), those reach at least
/// LINK_DROP_MIN_PARTNERS other routers, and over the last half of the
/// time since, the links were still LINK_DROP_STILL_DB or more down.
pub const LINK_DROP_DB: f64 = -6.0;
pub const LINK_DROP_STILL_DB: f64 = -3.0;
pub const LINK_DROP_MIN_LINKS: usize = 2;
pub const LINK_DROP_MIN_PARTNERS: usize = 2;
pub const LINK_DROP_MIN_READINGS: usize = 5;
pub const LINK_DROP_MIN_BEFORE_MS: i64 = 3 * 3_600_000;
pub const LINK_DROP_MIN_AFTER_MS: i64 = 6 * 3_600_000;
pub const LINK_DROP_STEP_MS: i64 = 15 * 60_000;
pub const LINK_DROP_REFINE_MS: i64 = 3 * 3_600_000;
pub const LINK_DROP_LOCAL_MS: i64 = 6 * 3_600_000;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let (nodes, newest) = (cx.nodes, cx.newest);
    let routers: Vec<&Node> = nodes.iter().filter(|x| roles::is_router(role_of(x)) && x.moved_at.is_none()).collect();
    let router_nums: FxSet<u32> = nodes.iter().filter(|x| roles::is_router(role_of(x))).map(|x| x.num).collect();
    let by_router = crate::views::link::router_links(cx.readings, &router_nums);
    for r in &routers {
        let Some(d) = by_router.get(&r.num).and_then(|links| find_link_drop(links, newest)) else { continue };
        let fell: Vec<String> = d
            .links
            .iter()
            .map(|c| format!("{} {} {:+.1} → {:+.1} dB ({} and {} readings)", if c.out { "heard by" } else { "hearing" }, node_id(c.partner), c.before, c.after, c.n_before, c.n_after))
            .collect();
        let detail = format!(
            "From {} on, its radio links to other routers were {:.0} dB weaker (the median change per link and direction, each against itself), and still were at the newest data, {} later: {}. Median SNR at the receiving end before and after, from NeighborInfo, traceroutes, gateway receptions and resolved relays. Several links falling at once point at the router itself rather than its partners: check the antenna, cable, connectors and mount (water in a connector, or a mount loosened by wind, often follows rain and gusts). Icing can do the same until it melts. The Links tab of its Details charts its router links over the period.",
            crate::util::time_mark(d.at),
            -d.drop,
            span_words(newest - d.at),
            fell.join("; ")
        );
        out.push(Issue { node: node_id(r.num), kind: "router_link_drop", severity: "warning", summary: format!("Router links {:.0} dB weaker since {}", -d.drop, crate::util::time_mark(d.at)), detail, weight: -d.drop });
    }
}

/// One link direction's SNR before and after a router's change point (D-197).
#[derive(Debug, Clone, PartialEq)]
pub struct LinkChange {
    pub partner: u32,
    /// The router transmitted, the partner heard it.
    pub out: bool,
    /// Median SNR (dB) before and after.
    pub before: f64,
    pub after: f64,
    pub n_before: usize,
    pub n_after: usize,
}

/// A router's links falling at one time (D-197).
#[derive(Debug, Clone, PartialEq)]
pub struct LinkDrop {
    /// The change point, Unix ms: its first weaker readings are from then on.
    pub at: i64,
    /// The upper median of the links' changes, dB (negative).
    pub drop: f64,
    /// Every link judged, the largest fall first.
    pub links: Vec<LinkChange>,
}

/// The upper median: at least half the values are at or below it.
fn upper_median(v: &mut [f64]) -> f64 {
    let h = v.len() / 2;
    *v.select_nth_unstable_by(h, f64::total_cmp).1
}

/// Median SNR of `l`'s readings in [a, b) (indices), reusing `scratch`.
fn median_of(l: &RouterLink, a: usize, b: usize, scratch: &mut Vec<f32>) -> f64 {
    scratch.clear();
    scratch.extend_from_slice(&l.snr[a..b]);
    crate::views::link::median_f32(scratch)
}

/// A sudden, lasting fall in a router's links (its router_links), up to the
/// window's newest data, by the rule's thresholds (LINK_DROP_*); None when
/// there is none. Linear in the readings for the coarse search (prefix sums,
/// one sweep); medians only near the best candidate.
pub fn find_link_drop(links: &[RouterLink], newest: i64) -> Option<LinkDrop> {
    let first = links.iter().filter_map(|l| l.t.first().copied()).min()?;
    let (lo, hi) = (first.saturating_add(LINK_DROP_MIN_BEFORE_MS), newest.saturating_sub(LINK_DROP_MIN_AFTER_MS));
    if links.len() < LINK_DROP_MIN_LINKS || lo > hi {
        return None;
    }
    let enough = |nb: usize, na: usize| nb >= LINK_DROP_MIN_READINGS && na >= LINK_DROP_MIN_READINGS;
    // Coarse: every step, each link's mean after minus mean before, weighted
    // by how much each side holds (n_before n_after / n), summed: dense links
    // place the change, a link with a handful of readings cannot.
    let sums: Vec<Vec<f64>> = links
        .iter()
        .map(|l| {
            let mut s = Vec::with_capacity(l.snr.len() + 1);
            s.push(0.0);
            for &x in l.snr.iter() {
                s.push(s[s.len() - 1] + x as f64);
            }
            s
        })
        .collect();
    let mut idx = vec![0usize; links.len()];
    let mut best: Option<(f64, i64)> = None;
    let mut tau = lo.div_euclid(LINK_DROP_STEP_MS) * LINK_DROP_STEP_MS + LINK_DROP_STEP_MS;
    while tau <= hi {
        let (mut score, mut counted) = (0.0, 0);
        for (k, l) in links.iter().enumerate() {
            while idx[k] < l.t.len() && l.t[idx[k]] < tau {
                idx[k] += 1;
            }
            let (nb, n) = (idx[k], l.t.len());
            if enough(nb, n - nb) {
                let d = (sums[k][n] - sums[k][nb]) / (n - nb) as f64 - sums[k][nb] / nb as f64;
                score += d * (nb * (n - nb)) as f64 / n as f64;
                counted += 1;
            }
        }
        if counted >= LINK_DROP_MIN_LINKS && best.is_none_or(|b| score < b.0) {
            best = Some((score, tau));
        }
        tau += LINK_DROP_STEP_MS;
    }
    let coarse = best?.1;
    let split = |l: &RouterLink, t: i64| l.t.partition_point(|&x| x < t);
    // Means first: no median work for a router whose links did not fall.
    let mut means: Vec<f64> = links
        .iter()
        .zip(&sums)
        .filter_map(|(l, s)| {
            let (nb, n) = (split(l, coarse), l.t.len());
            enough(nb, n - nb).then(|| (s[n] - s[nb]) / (n - nb) as f64 - s[nb] / nb as f64)
        })
        .collect();
    if means.len() < LINK_DROP_MIN_LINKS || upper_median(&mut means) > LINK_DROP_DB / 2.0 {
        return None;
    }
    // Refined: the reading near it where the links' local medians fall most.
    let mut scratch: Vec<f32> = Vec::new();
    let mut cands: Vec<i64> = links.iter().flat_map(|l| l.t[split(l, coarse - LINK_DROP_REFINE_MS)..split(l, coarse + LINK_DROP_REFINE_MS + 1)].iter().copied()).filter(|&t| t > lo && t < newest).collect();
    cands.sort_unstable();
    cands.dedup();
    let every = cands.len().div_ceil(400).max(1); // bounded work for a very busy router
    let mut at = coarse;
    let mut best_local: Option<f64> = None;
    for &c in cands.iter().step_by(every) {
        let mut score = 0.0;
        let mut counted = 0;
        for l in links {
            let (a, m, b) = (split(l, c - LINK_DROP_LOCAL_MS), split(l, c), split(l, c + LINK_DROP_LOCAL_MS));
            if m - a >= 3 && b - m >= 3 {
                score += median_of(l, m, b, &mut scratch) - median_of(l, a, m, &mut scratch);
                counted += 1;
            }
        }
        if counted > 0 && best_local.is_none_or(|s| score < s) {
            best_local = Some(score);
            at = c;
        }
    }
    // Refining may move it later than the coarse search may look: the
    // weaker readings must still have lasted.
    if newest - at < LINK_DROP_MIN_AFTER_MS {
        return None;
    }
    // Judged by each link's medians before and after.
    let mut changes: Vec<LinkChange> = Vec::new();
    let mut still: Vec<f64> = Vec::new();
    let late = at + (newest - at) / 2;
    for l in links {
        let (m, n) = (split(l, at), l.t.len());
        if !enough(m, n - m) {
            continue;
        }
        let before = median_of(l, 0, m, &mut scratch);
        let after = median_of(l, m, n, &mut scratch);
        changes.push(LinkChange { partner: l.partner, out: l.out, before, after, n_before: m, n_after: n - m });
        let k = split(l, late);
        if n - k >= 3 {
            still.push(median_of(l, k, n, &mut scratch) - before);
        }
    }
    if changes.len() < LINK_DROP_MIN_LINKS || still.is_empty() {
        return None;
    }
    let drop = upper_median(&mut changes.iter().map(|c| c.after - c.before).collect::<Vec<_>>());
    let partners: FxSet<u32> = changes.iter().filter(|c| c.after - c.before <= LINK_DROP_DB).map(|c| c.partner).collect();
    if drop > LINK_DROP_DB || partners.len() < LINK_DROP_MIN_PARTNERS || upper_median(&mut still) > LINK_DROP_STILL_DB {
        return None;
    }
    changes.sort_by(|a, b| (a.after - a.before).total_cmp(&(b.after - b.before)).then(a.partner.cmp(&b.partner)).then(a.out.cmp(&b.out)));
    Some(LinkDrop { at, drop, links: changes })
}

#[cfg(test)]
mod tests {
    use super::find_link_drop;
    use crate::channels::PresetIndex;
    use crate::copies::Copies;
    use crate::health::tests::{sender, H};
    use crate::health::{health, Issue};
    use crate::row::{Interner, Row};
    use crate::views::link::{LinkReadings, RouterLink};

    /// A link direction read every 20 minutes over 72 h, at `snr(hour)` with
    /// a repeatable ±1.5 dB of noise; `keep(hour)` picks which readings exist.
    fn link(partner: u32, out: bool, snr: impl Fn(f64) -> f64, keep: impl Fn(f64) -> bool) -> RouterLink {
        let (mut t, mut s) = (Vec::new(), Vec::new());
        for k in 0..216u32 {
            let h = k as f64 / 3.0;
            if keep(h) {
                let noise = ((k.wrapping_mul(2_654_435_761) ^ partner.wrapping_mul(40_503)) % 31) as f64 / 10.0 - 1.5;
                t.push((h * H as f64) as i64);
                s.push((snr(h) + noise) as f32);
            }
        }
        RouterLink { partner, out, t: t.into(), snr: s.into() }
    }
    const ALL: fn(f64) -> bool = |_| true;
    const END: i64 = 72 * H;

    #[test]
    fn a_routers_links_falling_at_once_and_staying_down_are_found_with_their_time() {
        // From hour 40 its links to 2 and 3 (both ways) are 10 dB weaker; 4's are not.
        let step = |h: f64| if h < 40.0 { 8.0 } else { -2.0 };
        let links = [link(2, true, step, ALL), link(2, false, step, ALL), link(3, true, step, ALL), link(3, false, |h| step(h) - 3.0, ALL), link(4, true, |_| 1.0, ALL)];
        let d = find_link_drop(&links, END).expect("flagged");
        assert!((d.at - 40 * H).abs() <= 20 * 60_000, "at {}", crate::util::iso(d.at));
        assert!(d.drop <= -9.0 && d.drop >= -11.0, "{}", d.drop);
        assert_eq!(d.links.len(), 5);
        assert_eq!(d.links.last().unwrap().partner, 4, "the steady link is listed last");
    }

    #[test]
    fn a_change_in_which_partners_are_heard_is_no_drop() {
        // A strong partner heard mostly before hour 40, a weak one mostly
        // after: the median of all readings falls 15 dB, no link does.
        let early = |h: f64| h < 40.0 || (h as u32).is_multiple_of(6);
        let later = |h: f64| h >= 40.0 || (h as u32).is_multiple_of(6);
        let links = [link(2, true, |_| 10.0, early), link(2, false, |_| 10.0, early), link(3, true, |_| -5.0, later), link(3, false, |_| -5.0, later)];
        assert_eq!(find_link_drop(&links, END), None);
    }

    #[test]
    fn a_short_dip_a_rise_or_a_drop_on_one_partner_is_not_flagged() {
        // Down 10 dB for 4 hours, then back.
        let dip = |h: f64| if (40.0..44.0).contains(&h) { -2.0 } else { 8.0 };
        assert_eq!(find_link_drop(&[link(2, true, dip, ALL), link(2, false, dip, ALL), link(3, true, dip, ALL), link(3, false, dip, ALL)], END), None);
        // Recovery: 10 dB stronger from hour 40.
        let rise = |h: f64| if h < 40.0 { -2.0 } else { 8.0 };
        assert_eq!(find_link_drop(&[link(2, true, rise, ALL), link(2, false, rise, ALL), link(3, true, rise, ALL), link(3, false, rise, ALL)], END), None);
        // Both directions of one partner only: the path or the partner, not this router.
        let step = |h: f64| if h < 40.0 { 8.0 } else { -2.0 };
        assert_eq!(find_link_drop(&[link(2, true, step, ALL), link(2, false, step, ALL), link(3, true, |_| 5.0, ALL)], END), None);
        // Too recent to call lasting: 4 hours before the newest data.
        let late = |h: f64| if h < 68.0 { 8.0 } else { -2.0 };
        assert_eq!(find_link_drop(&[link(2, true, late, ALL), link(2, false, late, ALL), link(3, true, late, ALL), link(3, false, late, ALL)], END), None);
        // A single link (one direction to one partner) is too few.
        assert_eq!(find_link_drop(&[link(2, true, step, ALL)], END), None);
    }

    #[test]
    fn a_router_link_drop_is_a_warning_naming_its_links() {
        let mut i = Interner::default();
        // Routers 1 to 3; 9 only sends the window's newest row.
        let mut nodes: Vec<crate::views::Node> = (1..=3).map(|n| sender(&mut i, n, "ROUTER", &[]).0).collect();
        let (client, rows) = sender(&mut i, 9, "CLIENT", &[END]);
        nodes.push(client);
        let step = |h: f64| if h < 40.0 { 8.0 } else { -2.0 };
        let mut samples: Vec<crate::graph::Sample> = Vec::new();
        for l in [link(2, true, step, ALL), link(2, false, step, ALL), link(3, true, step, ALL), link(9, true, step, ALL)] {
            let (src, dst) = if l.out { (1, l.partner) } else { (l.partner, 1) };
            for (k, (&t, &snr)) in l.t.iter().zip(l.snr.iter()).enumerate() {
                samples.push(crate::graph::Sample { src, dst, ev: crate::graph::Ev::Traceroute, t, snr: Some(snr as f64), rssi: None, key: crate::graph::SKey::Ok((src as u64) << 40 | (dst as u64) << 20 | k as u64) });
            }
        }
        let refs: Vec<&Row> = rows.iter().collect();
        let got = health(&refs, &refs, &nodes, &[], &LinkReadings::new(&samples), &Copies::default(), &PresetIndex::default(), &i, 72.0, &crate::landsdel::Regions::default()).issues;
        let d: Vec<&Issue> = got.iter().filter(|x| x.kind == "router_link_drop").collect();
        assert_eq!(d.len(), 1, "router 1 only: 2 and 3 each see one partner fall");
        assert_eq!((d[0].node.as_str(), d[0].severity), ("!00000001", "warning"));
        assert!(d[0].summary.starts_with("Router links 10 dB weaker since {{t:"), "{}", d[0].summary);
        assert!(d[0].detail.contains("heard by !00000002") && d[0].detail.contains("hearing !00000002") && !d[0].detail.contains("!00000009"), "{}", d[0].detail);
    }
}
