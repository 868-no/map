//! Router role review (D-189): routers rebroadcast everything they hear,
//! so they pay off where they reach nodes others do not. From the
//! window's radio links (medium confidence or better), which only show
//! what gateways reported: notices, worded as such. Routers covering the
//! same nodes, routers with little reach, and relays at one site.

use super::{role_of, Ctx, Issues};
use crate::roles;
use crate::util::{map, node_id, FxMap, FxSet};
use crate::views::Node;

/// Router role review (D-189). Overlap: a router with at least
/// OVERLAP_MIN_NEIGHBOURS radio neighbours, at least OVERLAP_SHARE of them
/// also neighbours of another router it hears. Little reach: a router with
/// at most FEW_LINKS radio neighbours (but one at least: with none, nothing
/// is known of its reach, and the isolated rule speaks for it) over at least FEW_LINKS_MIN_PACKETS
/// of its own packets. Co-located relays: nodes that rebroadcast, reporting
/// positions within SITE_M of each other (every pair), precise to SITE_MIN_BITS.
pub const OVERLAP_MIN_NEIGHBOURS: usize = 5;
pub const OVERLAP_SHARE: f64 = 0.9;
pub const FEW_LINKS: usize = 1;
pub const FEW_LINKS_MIN_PACKETS: usize = 20;
pub const SITE_M: f64 = 100.0;
pub const SITE_MIN_BITS: u32 = 18;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let nodes = cx.nodes;
    let mut neighbours: FxMap<u32, FxSet<u32>> = map();
    for e in cx.edges.iter().filter(|e| !e.mqtt && !e.inferred && e.confidence != "low") {
        neighbours.entry(e.src_num).or_default().insert(e.dst_num);
        neighbours.entry(e.dst_num).or_default().insert(e.src_num);
    }
    let empty = FxSet::default();
    let near = |n: u32| neighbours.get(&n).unwrap_or(&empty);
    let routers: Vec<&Node> = nodes.iter().filter(|x| roles::is_router(role_of(x)) && x.moved_at.is_none()).collect();
    for r in &routers {
        let mine = near(r.num);
        if mine.len() >= OVERLAP_MIN_NEIGHBOURS {
            // The other router it hears that covers most of its neighbours; of
            // two that cover each other, only the one with fewer neighbours
            // (or the higher id) is named, so a pair gets one notice.
            let best = routers
                .iter()
                .filter(|o| o.num != r.num && mine.contains(&o.num))
                .map(|o| (o, mine.iter().filter(|&&m| m == o.num || near(o.num).contains(&m)).count()))
                .max_by(|a, b| a.1.cmp(&b.1).then(b.0.num.cmp(&a.0.num)));
            if let Some((o, shared)) = best
                && shared as f64 >= OVERLAP_SHARE * mine.len() as f64
                && (mine.len() < near(o.num).len() || (mine.len() == near(o.num).len() && r.num > o.num))
            {
                out.add(r.num, "router_overlap", "notice", format!("Covers the same nodes as router {}", node_id(o.num)), format!("{shared} of its {} radio neighbours are also neighbours of {} (or {} itself), a router it hears directly. Two routers reaching the same nodes both rebroadcast every packet: twice the airtime, no new reach. One of them as CLIENT would do the same job; keep the better-placed one as router. Only links that gateways reported are known, so check on site before changing.", mine.len(), node_id(o.num), node_id(o.num)));
            }
        }
        let own_packets = cx.own.get(&r.num).map_or(0, FxMap::len);
        if own_packets >= FEW_LINKS_MIN_PACKETS && (1..=FEW_LINKS).contains(&mine.len()) {
            out.add(r.num, "router_few_links", "notice", format!("Router with {} radio link{}", mine.len(), if mine.len() == 1 { "" } else { "s" }), format!("Gateways reported it linked to {} node{} over {own_packets} of its packets. A router rebroadcasts everything it hears, which helps most on a high site that hears many nodes; with few neighbours, CLIENT is usually the better role. A site that only gateways nobody reports from can hear would look the same, so check its placement first.", mine.len(), if mine.len() == 1 { "" } else { "s" }));
        }
    }
    // Co-located relays: nodes that rebroadcast, at one site. They repeat
    // the same packets from the same place; all but one could be CLIENT_MUTE.
    let placed: Vec<(&Node, crate::graph::LatLon)> = nodes
        .iter()
        .filter(|x| x.moved_at.is_none() && !roles::is_silent(role_of(x)) && x.status == "observed")
        .filter_map(|x| x.position.as_ref().filter(|p| p.precision_known && p.precision_bits >= SITE_MIN_BITS).map(|p| (x, crate::graph::LatLon { lat: p.lat, lon: p.lon })))
        .collect();
    // Pairs within SITE_M, from a sweep north to south: only nodes less than
    // SITE_M apart in latitude are measured, so a whole country costs little
    // more than its sorting.
    let mut by_lat: Vec<usize> = (0..placed.len()).collect();
    by_lat.sort_unstable_by(|&a, &b| placed[a].1.lat.total_cmp(&placed[b].1.lat));
    let band = SITE_M / 111_000.0; // degrees of latitude, a little more than SITE_M
    let mut close: Vec<Vec<usize>> = vec![Vec::new(); placed.len()];
    for (k, &a) in by_lat.iter().enumerate() {
        for &b in &by_lat[k + 1..] {
            if placed[b].1.lat - placed[a].1.lat > band {
                break;
            }
            if crate::graph::distance_m(placed[a].1, placed[b].1) <= SITE_M {
                close[a].push(b);
                close[b].push(a);
            }
        }
    }
    // Sites around the relay to keep (a router role first, then the most
    // radio neighbours): each takes the nearest free nodes within SITE_M of
    // every member so far, so a site's members are all within SITE_M of each
    // other and a chain of relays does not become one long site.
    let keep_first = |x: &Node| (!roles::is_router(role_of(x)), std::cmp::Reverse(near(x.num).len()), x.num);
    let mut by_keep: Vec<usize> = (0..placed.len()).collect();
    by_keep.sort_by_key(|&k| keep_first(placed[k].0));
    let mut taken = vec![false; placed.len()];
    let mut sites: Vec<Vec<&Node>> = Vec::new();
    for &a in &by_keep {
        if taken[a] {
            continue;
        }
        let mut free: Vec<usize> = close[a].iter().copied().filter(|&b| !taken[b]).collect();
        free.sort_by(|&b, &c| crate::graph::distance_m(placed[a].1, placed[b].1).total_cmp(&crate::graph::distance_m(placed[a].1, placed[c].1)).then(keep_first(placed[b].0).cmp(&keep_first(placed[c].0))));
        let mut site = vec![a];
        for b in free {
            if site[1..].iter().all(|m| close[b].contains(m)) {
                site.push(b);
            }
        }
        if site.len() >= 2 {
            for &k in &site {
                taken[k] = true;
            }
            sites.push(site.iter().map(|&k| placed[k].0).collect());
        }
    }
    for mut site in sites {
        // The one to keep relaying: a router role first, then the most radio neighbours.
        site.sort_by_key(|x| keep_first(x));
        let keep = site[0].num;
        let all: Vec<String> = site.iter().map(|x| node_id(x.num)).collect();
        for x in &site[1..] {
            out.add(x.num, "co_located", "notice", format!("Relays from the same site as {}", node_id(keep)), format!("{} nodes that rebroadcast report positions within {SITE_M:.0} m of each other ({}). Each repeats the same packets from the same place: more airtime, no more reach. All but one, here {} (a router, or the most radio neighbours), could be CLIENT_MUTE, which still sends its own packets.", site.len(), all.join(", "), node_id(keep)));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::channels::PresetIndex;
    use crate::copies::Copies;
    use crate::health::health;
    use crate::health::tests::sender;
    use crate::row::{Interner, Row};
    use crate::views::link::LinkReadings;

    #[test]
    fn router_roles_are_reviewed_from_links_and_sites() {
        let mut i = Interner::default();
        let m = 60_000;
        let times: Vec<i64> = (0..30).map(|k| k * 10 * m).collect();
        let (a, ra) = sender(&mut i, 1, "ROUTER", &times);
        let (b, rb) = sender(&mut i, 2, "ROUTER", &times);
        let (c, rc) = sender(&mut i, 3, "ROUTER", &times);
        // Three clients within 100 m, precise positions; 21 has the most links.
        let at = |n: u32, lat: f64| {
            let mut x = crate::views::Node::new(n);
            x.identity = Some(crate::views::Identity { role: "CLIENT".into(), ..Default::default() });
            x.position = Some(crate::views::Position { lat, lon: 10.0, alt: None, precision_bits: 32, precision_known: true, signature: "unsigned".into(), observed_at: "2026-11-05T00:00:00Z".into(), source: "position".into() });
            x
        };
        let site = [at(20, 60.0), at(21, 60.0004), at(22, 60.0008)];
        let link = |s: u32, d: u32| crate::graph::Edge { src_num: s, dst_num: d, confidence: "high", ..Default::default() };
        // A hears B and 10..13; B hears A and 10..14: A adds nothing B does not reach. C hears only 10.
        let mut edges: Vec<crate::graph::Edge> = vec![link(1, 2), link(1, 10), link(1, 11), link(1, 12), link(1, 13), link(2, 10), link(2, 11), link(2, 12), link(2, 13), link(2, 14), link(3, 10), link(21, 10), link(21, 11)];
        edges.push(crate::graph::Edge { src_num: 3, dst_num: 14, confidence: "low", ..Default::default() }); // low confidence: not counted
        let rows: Vec<Row> = [ra, rb, rc].into_iter().flatten().collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let nodes: Vec<crate::views::Node> = [a, b, c].into_iter().chain(site).collect();
        let got = health(&refs, &[], &nodes, &edges, &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        let of = |kind: &str| got.iter().filter(|x| x.kind == kind).map(|x| (x.node.as_str(), x.summary.as_str())).collect::<Vec<_>>();
        assert_eq!(of("router_overlap"), [("!00000001", "Covers the same nodes as router !00000002")]);
        assert_eq!(of("router_few_links"), [("!00000003", "Router with 1 radio link")]);
        assert_eq!(of("co_located"), [("!00000014", "Relays from the same site as !00000015"), ("!00000016", "Relays from the same site as !00000015")]);
    }

    #[test]
    fn a_chain_of_relays_is_not_one_long_site() {
        let i = Interner::default();
        // Four clients in a line about 89 m apart (267 m end to end), and a
        // router 50 m from the third: sites hold only nodes all within 100 m
        // of each other, around the router first.
        let at = |n: u32, role: &str, lat: f64, lon: f64| {
            let mut x = crate::views::Node::new(n);
            x.identity = Some(crate::views::Identity { role: role.into(), ..Default::default() });
            x.position = Some(crate::views::Position { lat, lon, alt: None, precision_bits: 32, precision_known: true, signature: "unsigned".into(), observed_at: "2026-11-05T00:00:00Z".into(), source: "position".into() });
            x
        };
        let nodes = [at(1, "CLIENT", 60.0, 10.0), at(2, "CLIENT", 60.0008, 10.0), at(3, "CLIENT", 60.0016, 10.0), at(4, "CLIENT", 60.0024, 10.0), at(5, "ROUTER", 60.0016, 10.0009)];
        let got = health(&[], &[], &nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        let sites: Vec<(&str, &str)> = got.iter().filter(|x| x.kind == "co_located").map(|x| (x.node.as_str(), x.summary.as_str())).collect();
        assert_eq!(sites, [("!00000002", "Relays from the same site as !00000001"), ("!00000003", "Relays from the same site as !00000005")]);
    }
}
