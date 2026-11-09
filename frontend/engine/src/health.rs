//! Mesh health (D-095): known problems found in the window's rows by rules,
//! and an airtime estimate of who keeps the channel busy.
//!
//! Every rule works only from what gateways reported, so it can miss
//! things and its numbers are lower bounds; the wording says so where it
//! matters. Thresholds are constants here so they are easy to find.

use serde::Serialize;

use crate::channels::PresetIndex;
use crate::copies::Copies;
use crate::row::{ty, Interner, Row};
use crate::util::{map, node_id, FxMap, FxSet};
use crate::views::link::{LinkReadings, RouterLink};
use crate::views::{first_per_packet, Node};

/// Traceroute requests per hour from one node that count as flooding the
/// mesh (warning), and as a problem. Each request is flooded and answered.
pub const TRACEROUTE_WARN_PER_H: f64 = 4.0;
pub const TRACEROUTE_PROBLEM_PER_H: f64 = 10.0;
/// Fewest requests before the traceroute rule applies (short windows).
pub const TRACEROUTE_MIN: usize = 10;
/// Packets with a known hop count before the hop-limit rule applies, how
/// many hops more than its packets needed (95th percentile) count as too
/// many, and the lowest hop limit it applies to. Gateways are only part of
/// the mesh, so a limit a little above what they needed is fine.
pub const HOP_MIN_PACKETS: usize = 20;
pub const HOP_SPARE: i16 = 3;
pub const HOP_FLAG_FROM: i16 = 6;
/// Channel utilisation (%) a node reports: firmware stops its own optional
/// broadcasts above 25 % and goes quiet above 40 %.
pub const CH_UTIL_WARN: f64 = 25.0;
pub const CH_UTIL_PROBLEM: f64 = 40.0;
/// Transmit airtime (%) a node reports: EU 868 MHz allows 10 % per hour.
pub const AIR_UTIL_WARN: f64 = 10.0;
/// Own packets before "only its own gateway hears it" applies.
pub const ISOLATED_MIN_PACKETS: usize = 10;
/// Broadcast rates per hour above firmware defaults that count as chatty.
pub const POSITION_PER_H: f64 = 4.0;
pub const NODEINFO_PER_H: f64 = 1.0;
pub const TELEMETRY_PER_H: f64 = 4.0;
/// Battery (%) that counts as low (101 is external power).
pub const BATTERY_LOW: f64 = 15.0;
/// Battery trend (D-099): a least-squares slope over its reports, at least
/// this many over at least a day; falling this fast (% per day) is flagged,
/// as a warning when it is at most BATTERY_WARN_AT or empty within a week.
pub const BATTERY_TREND_MIN_REPORTS: usize = 8;
pub const BATTERY_FALL_PER_DAY: f64 = 5.0;
pub const BATTERY_WARN_AT: f64 = 50.0;
/// Restarts (uptime going backwards between reports) before it is a warning.
pub const RESTARTS_WARN: usize = 3;
/// Shared keys: how long two ids announcing one key must both be active (D-142).
pub const SHARED_KEY_OVERLAP_MS: i64 = 30 * 60_000;
/// Shared keys: how often the sender must switch between the two ids, in time
/// order, for them to be active together: an upgrade to 2.8 and a rollback
/// (or a second upgrade) switch at most three times (D-154).
pub const SHARED_KEY_MIN_SWITCHES: usize = 4;
/// Share of the window's estimated airtime one node's packets may cause
/// before it is flagged.
pub const AIRTIME_WARN_SHARE: f64 = 0.10;
/// Share of the window's airtime one node's store-and-forward may take before it is noted.
pub const STORE_FORWARD_SHARE: f64 = 0.02;
/// Packets claiming to be from one node that failed verification before it
/// is flagged as possibly impersonated (D-108).
pub const SPOOF_MIN: usize = 3;
/// Distinct nodes refusing its remote-admin requests before it is noted.
pub const ADMIN_REFUSALS_MIN: usize = 2;
/// Silent infrastructure (D-188): a router or gateway counts as silent once
/// nothing was heard from it for SILENT_GAP_FACTOR times its usual gap
/// between transmissions or uplinks, and at least SILENT_MIN_MS, before the
/// newest data in the window; its usual gap needs SILENT_MIN_EVENTS of them.
pub const SILENT_MIN_MS: i64 = 3 * 3_600_000;
pub const SILENT_GAP_FACTOR: i64 = 4;
pub const SILENT_MIN_EVENTS: usize = 4;
/// Battery (%) that, last reported before a silence, suggests it ran flat.
pub const SILENT_BATTERY_LOW: f64 = 20.0;
/// Roles that keep the mesh together: their silence is worth a warning.
pub const INFRA_ROLES: [&str; 4] = ["ROUTER", "ROUTER_LATE", "ROUTER_CLIENT", "REPEATER"];
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
/// Roles whose job is to relay for others.
pub const ROUTER_ROLES: [&str; 2] = ["ROUTER", "ROUTER_LATE"];
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

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Issue {
    pub node: String,
    pub kind: &'static str,
    /// problem, warning or notice.
    pub severity: &'static str,
    pub summary: String,
    pub detail: String,
    /// Orders issues of one kind, highest first (a silence's length); 0 for most.
    #[serde(skip)]
    pub weight: f64,
}

/// A duration in words: minutes, hours or days.
pub fn span_words(ms: i64) -> String {
    let h = ms as f64 / 3_600_000.0;
    if h < 1.0 {
        format!("{:.0} min", (h * 60.0).max(1.0))
    } else if h < 48.0 {
        if h < 10.0 { format!("{h:.1} h") } else { format!("{h:.0} h") }
    } else {
        format!("{:.0} days", h / 24.0)
    }
}

/// One node's share of the window's estimated airtime.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct NodeAirtime {
    pub node: String,
    #[serde(skip)]
    pub num: u32,
    /// Its packets, including every rebroadcast of them seen (the airtime it causes).
    pub caused: f64,
    /// What it transmitted itself: its own packets and others' it relayed.
    pub transmitted: f64,
    pub packets: usize,
    /// Transmissions of its packets seen: its own plus relays'.
    pub transmissions: usize,
    /// Its caused airtime by packet type, as shares of `caused`, largest first.
    pub by_type: Vec<(String, f64)>,
}

/// One node's store-and-forward traffic (D-103).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct StoreForwardNode {
    pub node: String,
    #[serde(skip)]
    pub num: u32,
    pub packets: usize,
    /// Share of the window's estimated airtime (its packets with rebroadcasts).
    pub share: f64,
    /// Packets by message kind, most first.
    pub by_kind: Vec<(String, usize)>,
    pub heartbeats_per_hour: f64,
    /// History replays (router_text_*): count and text bytes.
    pub replays: usize,
    pub replay_bytes: usize,
}

/// Store-and-forward's part of the airtime (D-103).
#[derive(Serialize, Debug, Default)]
pub struct StoreForwardStats {
    pub packets: usize,
    pub share: f64,
    /// Packets and airtime share by message kind, most airtime first.
    pub by_kind: Vec<(String, usize, f64)>,
    pub nodes: Vec<StoreForwardNode>,
}

#[derive(Serialize, Debug, Default)]
pub struct Airtime {
    pub packets: usize,
    pub transmissions: usize,
    pub store_forward: StoreForwardStats,
    /// Share of the window's estimated airtime by packet type, largest first.
    pub by_type: Vec<(String, f64)>,
    /// Every node that caused or transmitted any, by caused share: the
    /// node panel shows any node's, so the list is never cut.
    pub nodes: Vec<NodeAirtime>,
}

#[derive(Serialize, Debug, Default)]
pub struct Health {
    pub issues: Vec<Issue>,
    pub airtime: Airtime,
}

/// A role as a word for the start of a sentence.
fn role_word(role: &str) -> &'static str {
    match role {
        "ROUTER" => "Router",
        "ROUTER_LATE" => "Router (late)",
        "ROUTER_CLIENT" => "Router/client",
        "REPEATER" => "Repeater",
        _ => "Node",
    }
}

fn rank(severity: &str) -> u8 {
    match severity {
        "problem" => 0,
        "warning" => 1,
        _ => 2,
    }
}

fn pct(x: f64) -> String {
    if x >= 0.1 { format!("{:.0} %", x * 100.0) } else { format!("{:.1} %", x * 100.0) }
}

/// On-air size estimate of one packet: the 16-byte radio header, its
/// payload, the Data wrapper when we saw it decoded, and a 64-byte XEdDSA
/// signature plus its tag when it carried one.
fn wire_bytes(r: &Row, i: &Interner) -> f64 {
    let decoded = i.decoded(r.crypto);
    let signed = i.sig_rank(r.sig) >= 2; // verified or unverifiable
    16.0 + r.bytes.max(0) as f64 + if decoded { 4.0 } else { 0.0 } + if signed { 66.0 } else { 0.0 }
}

/// Relative airtime of one transmission: LoRa spends a fixed preamble and
/// header time on every packet, worth about 20 bytes at the presets used
/// here, plus time proportional to its size. Only shares are reported, so
/// the unit cancels out.
fn cost(r: &Row, i: &Interner) -> f64 {
    20.0 + wire_bytes(r, i)
}

/// Estimated airtime: every packet costs one transmission by its originator
/// plus one per distinct relay seen (resolved last hops, traceroute routes).
/// A lower bound: relays no gateway heard are missed. copies: every
/// packet's radio copies (`copies::Copies` of `rows`).
pub fn airtime(copies: &Copies, rows: &[&Row], i: &Interner, hours: f64) -> Airtime {
    let mut total = 0.0;
    let mut tx_total = 0;
    let mut types: FxMap<u32, f64> = map();
    #[derive(Default)]
    struct Acc {
        caused: f64,
        transmitted: f64,
        packets: usize,
        transmissions: usize,
        types: FxMap<u32, f64>,
    }
    let mut acc: FxMap<u32, Acc> = map();
    #[derive(Default)]
    struct Sf {
        packets: usize,
        air: f64,
        kinds: FxMap<u32, usize>,
        heartbeats: usize,
        replays: usize,
        replay_bytes: usize,
    }
    let mut sf: FxMap<u32, Sf> = map();
    let mut sf_kinds: FxMap<u32, (usize, f64)> = map();
    let (heartbeat, text_direct, text_broadcast) = (i.get("router_heartbeat"), i.get("router_text_direct"), i.get("router_text_broadcast"));
    let mut packets = 0;
    let mut relays: Vec<u32> = Vec::new(); // one packet's distinct relays (scratch)
    for group in copies.packets(rows) {
        let row = group.first().row;
        relays.clear();
        for h in group.iter() {
            if let Some(s) = h.sender.filter(|&s| s != row.src) {
                relays.push(s);
            }
            relays.extend(h.row.traced_relays().filter(|&x| x != row.src));
        }
        relays.sort_unstable();
        relays.dedup();
        packets += 1;
        let c = cost(row, i);
        let n = 1 + relays.len();
        let all = c * n as f64;
        if let Some(f) = row.store_forward() {
            let e = sf.entry(row.src).or_default();
            e.packets += 1;
            e.air += all;
            *e.kinds.entry(f.kind).or_default() += 1;
            if Some(f.kind) == heartbeat {
                e.heartbeats += 1;
            }
            if Some(f.kind) == text_direct || Some(f.kind) == text_broadcast {
                e.replays += 1;
                e.replay_bytes += f.text_bytes.max(0) as usize;
            }
            let k = sf_kinds.entry(f.kind).or_default();
            k.0 += 1;
            k.1 += all;
        }
        total += all;
        tx_total += n;
        *types.entry(row.ty).or_default() += all;
        let a = acc.entry(row.src).or_default();
        a.caused += all;
        a.transmitted += c;
        a.packets += 1;
        a.transmissions += n;
        *a.types.entry(row.ty).or_default() += all;
        for &relay in &relays {
            acc.entry(relay).or_default().transmitted += c;
        }
    }
    if total == 0.0 {
        return Airtime::default();
    }
    let shares = |m: FxMap<u32, f64>, of: f64| -> Vec<(String, f64)> {
        let mut v: Vec<(String, f64)> = m.into_iter().map(|(t, x)| (i.s(t).to_string(), x / of)).collect();
        v.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        v
    };
    let mut nodes: Vec<NodeAirtime> = acc
        .into_iter()
        .map(|(n, a)| NodeAirtime { node: node_id(n), num: n, caused: a.caused / total, transmitted: a.transmitted / total, packets: a.packets, transmissions: a.transmissions, by_type: if a.caused > 0.0 { shares(a.types, a.caused) } else { vec![] } })
        .collect();
    nodes.sort_unstable_by(|a, b| b.caused.total_cmp(&a.caused).then(b.transmitted.total_cmp(&a.transmitted)).then(a.node.cmp(&b.node)));
    let hours = hours.max(1.0);
    let mut sf_nodes: Vec<StoreForwardNode> = sf
        .into_iter()
        .map(|(n, e)| {
            let mut by_kind: Vec<(String, usize)> = e.kinds.into_iter().map(|(k, c)| (i.s(k).to_string(), c)).collect();
            by_kind.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            StoreForwardNode { node: node_id(n), num: n, packets: e.packets, share: e.air / total, by_kind, heartbeats_per_hour: e.heartbeats as f64 / hours, replays: e.replays, replay_bytes: e.replay_bytes }
        })
        .collect();
    sf_nodes.sort_unstable_by(|a, b| b.share.total_cmp(&a.share).then(a.node.cmp(&b.node)));
    let mut by_kind: Vec<(String, usize, f64)> = sf_kinds.into_iter().map(|(k, (c, a))| (i.s(k).to_string(), c, a / total)).collect();
    by_kind.sort_unstable_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
    let store_forward = StoreForwardStats { packets: sf_nodes.iter().map(|x| x.packets).sum(), share: sf_nodes.iter().map(|x| x.share).sum(), by_kind, nodes: sf_nodes };
    Airtime { packets, transmissions: tx_total, store_forward, by_type: shares(types, total), nodes }
}

/// A claimed sender's rejected packets (lp), their rejection reasons with
/// counts, and the gateways that heard them.
type Claims = (FxSet<u64>, FxMap<u32, usize>, FxSet<u32>);

/// The window's known issues and airtime. `hours`: the window's length;
/// rates use the span its rows cover when that is shorter. `rows`: the
/// window's rows passing the filters. `window`: all of the window's rows,
/// unfiltered: those that failed decoding or verification, which the
/// filters always keep out of `rows` (D-093), for the impersonation rule,
/// and the rest for whether routers and gateways went silent (D-188),
/// which a type, channel or broker filter must not change. nodes, copies, presets: the build's (views::Built).
/// `regions`: the regions' outlines for the topic-root rule (D-161); empty
/// until the worker has handed them over, and then that rule is skipped.
/// `readings`: the build's radio link readings (router link drop, D-197).
#[allow(clippy::too_many_arguments)] // mostly views::Built's parts; a params struct would only repackage them
pub fn health(rows: &[&Row], window: &[&Row], nodes: &[Node], edges: &[crate::graph::Edge], readings: &LinkReadings, copies: &Copies, presets: &PresetIndex, i: &Interner, hours: f64, regions: &crate::landsdel::Regions) -> Health {
    // Rates over the span the data covers, which can be shorter than the
    // window (the service started later, or was down).
    let (lo, hi) = rows.iter().fold((i64::MAX, i64::MIN), |(lo, hi), r| (lo.min(r.t), hi.max(r.t)));
    let span = if hi > lo { (hi - lo) as f64 / 3_600_000.0 } else { 0.0 };
    let hours = hours.min(span).max(1.0);
    let mut out: Vec<Issue> = Vec::new();
    let mut weighted: Vec<Issue> = Vec::new();
    let mut add = |n: u32, kind: &'static str, severity: &'static str, summary: String, detail: String| out.push(Issue { node: node_id(n), kind, severity, summary, detail, weight: 0.0 });

    // Own packets, first copy each, and per-node counts by type.
    let invalid_ty = i.get("invalid");
    let (invalid, live): (Vec<&Row>, Vec<&Row>) = window.iter().partition(|r| Some(r.ty) == invalid_ty);
    let mut own: FxMap<u32, FxMap<u64, &Row>> = map();
    for r in first_per_packet(rows.iter().copied(), |_| true) {
        own.entry(r.src).or_default().insert(r.lp, r);
    }
    let count = |n: u32, t: u32, keep: &dyn Fn(&Row) -> bool| own.get(&n).map_or(0, |m| m.values().filter(|r| r.ty == t && keep(r)).count());

    // Traceroute flooding.
    let traceroutes: FxMap<u32, usize> = own.keys().map(|&n| (n, count(n, ty::TRACEROUTE, &|r| r.traceroute().is_some_and(|t| !t.is_reply)))).filter(|&(_, c)| c > 0).collect();
    let mut rates: Vec<f64> = traceroutes.values().map(|&c| c as f64 / hours).collect();
    rates.sort_unstable_by(f64::total_cmp);
    let median = rates.get(rates.len() / 2).copied().unwrap_or(0.0);
    for (&n, &c) in &traceroutes {
        let rate = c as f64 / hours;
        if c >= TRACEROUTE_MIN && rate >= TRACEROUTE_WARN_PER_H {
            let sev = if rate >= TRACEROUTE_PROBLEM_PER_H { "problem" } else { "warning" };
            add(n, "traceroute_flood", sev, format!("Sends {rate:.1} traceroutes per hour"), format!("{c} traceroute requests in the window; the median among nodes sending any is {median:.1} per hour. Every request floods the mesh and is answered, so frequent automated traceroutes cost everyone airtime."));
        }
    }

    // Hop limit higher than its packets needed.
    let mut fewest: FxMap<u64, i16> = map();
    for &r in rows {
        if r.gw.is_some_and(|g| g != r.src)
            && r.over_radio()
            && let Some(h) = r.hops().filter(|&h| h >= 0)
        {
            let e = fewest.entry(r.lp).or_insert(h);
            *e = (*e).min(h);
        }
    }
    for (&n, pk) in &own {
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
            add(n, "hop_limit", "notice", format!("Hop limit {hs}, but its packets needed at most {p95}"), format!("Gateways heard 95 % of its {} packets within {p95} hops, yet it sends with a hop limit of {hs}: every spare hop is another round of rebroadcasts. A limit around {suggest} would likely reach the same gateways (nodes beyond them are not seen here; the reach simulator under Details shows what each limit reaches).", needed.len()));
        }
    }

    // Wrong preset: the mesh's preset from its channel names (each packet once
    // per name); a node the node panel's inference puts on another preset.
    let named: FxSet<(&'static str, u64)> = rows.iter().filter_map(|r| i.preset(r.channel).map(|p| (p, r.lp))).collect();
    let mut by_preset: FxMap<&'static str, usize> = map();
    for &(p, _) in &named {
        *by_preset.entry(p).or_default() += 1;
    }
    let mesh = by_preset.iter().max_by_key(|&(p, c)| (*c, *p)).map(|(&p, _)| p);
    if let Some(mesh) = mesh {
        for (&n, pk) in &own {
            let Some(g) = crate::channels::infer(n, presets) else { continue };
            let Some(p) = g.preset.filter(|&p| p != mesh) else { continue };
            let why = match g.basis {
                "map_report" => "Its own map report confirms",
                "radio_contact" => "Map reports of nodes it shares radio contact with confirm",
                // Channel names are only a hint (a secondary channel can carry
                // such a name): never when it was also heard on the mesh's.
                "channel_name" if pk.len() >= 3 && !pk.values().any(|r| i.preset(r.channel) == Some(mesh)) => "Its packets were heard on a channel named for",
                _ => continue,
            };
            add(n, "preset", "warning", format!("Uses {} while the mesh uses {}", label(p), label(mesh)), format!("{why} the {} preset, but most of the mesh is heard on {}. Nodes on different presets cannot hear each other, so it is cut off from most of the mesh.", label(p), label(mesh)));
        }
    }

    // Heard only by its own gateway.
    let heard_by: FxSet<u32> = rows.iter().filter(|r| r.gw.is_some_and(|g| g != r.src)).map(|r| r.src).collect();
    for (&n, pk) in &own {
        let packets = pk.values().filter(|r| r.ty != ty::MAPREPORT).count();
        if packets >= ISOLATED_MIN_PACKETS && !heard_by.contains(&n) && pk.values().any(|r| r.gw == Some(n)) {
            add(n, "isolated", "notice", "No other gateway reports it".into(), format!("None of its {packets} packets were uplinked by another gateway. It may simply have no other gateway in range (nodes that are not gateways can still hear it), or a poor antenna or location, or different radio settings than its neighbours."));
        }
    }

    // Admin requests refused.
    let refused = ["ADMIN_PUBLIC_KEY_UNAUTHORIZED", "NOT_AUTHORIZED"].iter().filter_map(|s| i.get(s)).collect::<FxSet<u32>>();
    let mut refusals: FxMap<u32, FxSet<u32>> = map();
    for &r in rows {
        if let (Some(rt), Some(d)) = (r.routing(), r.dst)
            && refused.contains(&rt.error)
        {
            refusals.entry(d).or_default().insert(r.src);
        }
    }
    for (n, by) in refusals {
        if by.len() >= ADMIN_REFUSALS_MIN {
            add(n, "admin_refused", "notice", format!("Remote-admin requests refused by {} nodes", by.len()), format!("{} nodes answered its admin messages with \"not authorised\": it is sending remote-administration requests to nodes that have not authorised its key. Often an app's device-info request or a survey script; it costs airtime and never succeeds.", by.len()));
        }
    }

    // Unencrypted uplinks.
    if let Some(plain) = i.get("plaintext_uplink") {
        let mut gws: FxMap<u32, usize> = map();
        for &r in rows {
            if r.crypto == plain
                && let Some(g) = r.gw
            {
                *gws.entry(g).or_default() += 1;
            }
        }
        for (g, c) in gws {
            add(g, "plaintext_uplink", "notice", "Uplinks to MQTT unencrypted".into(), format!("{c} of its uplinks arrived decrypted (MQTT encryption off): anyone subscribed to the broker reads its channels' traffic in the clear, including channels whose key is not public."));
        }
    }

    // Gateways that move, and gateways whose topic root names another
    // region than the one they are in (D-161).
    {
        let mut roots: FxMap<u32, FxMap<u32, usize>> = map();
        for &r in rows {
            if let Some(g) = r.gw.filter(|_| r.topic != 0) {
                *roots.entry(g).or_default().entry(r.topic).or_default() += 1;
            }
        }
        for x in nodes.iter().filter(|x| x.is_gateway) {
            let n = x.num;
            if let Some(at) = &x.moved_at {
                add(n, "moving_gateway", "warning", "Moves while uplinking to MQTT".into(), format!("It moved in the window (last around {at}) while uplinking what it hears. The map places nodes and draws links from where gateways hear them, so a moving gateway's receptions are weaker evidence; and its topic root, set for one region, travels with it into others. A gateway is best left in one place; a node carried around can stay a client."));
            }
            let (Some(p), Some(rs)) = (&x.position, roots.get(&n)) else { continue };
            let Some(here) = regions.region_at(p.lat, p.lon) else { continue };
            let mut used: Vec<(&str, usize)> = rs.iter().map(|(&t, &c)| (i.s(t), c)).collect();
            used.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
            use crate::landsdel::{misspelled_region, region_of_topic};
            let wrong: Vec<String> = used.iter().filter_map(|&(t, c)| region_of_topic(t).filter(|&r| r != here).map(|r| format!("{t} ({r}, {c} uplinks)"))).collect();
            let misspelt: Vec<String> = used.iter().filter(|&&(t, _)| region_of_topic(t).is_none()).filter_map(|&(t, c)| misspelled_region(t).map(|(seg, name)| format!("{t} ({c} uplinks: \"{seg}\" is not \"{name}\")"))).collect();
            let none: Vec<String> = used.iter().filter(|&&(t, _)| region_of_topic(t).is_none() && misspelled_region(t).is_none()).map(|&(t, c)| format!("{t} ({c} uplinks)")).collect();
            if !wrong.is_empty() {
                add(n, "topic_region", "warning", format!("Uplinks under another region's topic root, from {here}"), format!("Its position is in {here}, but it publishes under {}. Subscribers and maps that follow a region's root miss its traffic or place it in the wrong region; its root would normally end in /{here}.", wrong.join(", ")));
            } else if !misspelt.is_empty() {
                add(n, "topic_region", "warning", format!("Topic root misspells its region, from {here}"), format!("Its position is in {here}, but it publishes under {}. Region names in a root must be exact, case and æ, ø, å included ({}), or subscribers that follow the region's root miss its traffic; its root would normally end in /{here}.", misspelt.join(", "), crate::landsdel::NAMES.join(", ")));
            } else if !none.is_empty() {
                add(n, "topic_region", "notice", format!("Topic root names no region, from {here}"), format!("Its position is in {here}, but it publishes under {}, which names no region. Subscribers that follow a region's root miss its traffic; a root ending in /{here} would put it with its neighbours.", none.join(", ")));
            }
        }
    }

    // Per-node facts from the snapshot.
    let mut shorts: FxMap<&str, Vec<u32>> = map();
    for x in nodes {
        let n = x.num;
        if let Some(id) = x.identity.as_ref().filter(|id| !id.short_name.is_empty()) {
            shorts.entry(id.short_name.as_str()).or_default().push(n);
        }
        if let Some(d) = &x.mqtt_downlink {
            add(n, "downlink", "warning", "Probably downlinks from MQTT".into(), format!("{} of {} traceroutes reached it at exactly 0 dB, the reading of a packet taken from the broker. A downlinking node rebroadcasts far-away packets locally, which draws links that do not exist and wastes airtime.", d.zero_snr, d.traceroutes));
        }
        if let Some(p) = &x.stale_position {
            add(n, "stale_position", "notice", "Position report is stale".into(), format!("Its last position report is from {}, more than a day before the newest data (a week for a router, base station or node that has stayed in one place). {}", p.observed_at, if x.estimate.is_some() { "It is estimated instead." } else { "It is left off the map." }));
        }
        if let Some(p) = &x.rejected_position {
            let km = |m: f64| if m >= 10_000.0 { format!("{:.0} km", m / 1000.0) } else { format!("{:.1} km", m / 1000.0) };
            add(n, "position_contradicted", "warning", "Reported position contradicts its reception".into(), format!("Its position report of {} puts it at {:.4}, {:.4}, {} from gateway {}, which heard it directly at {} dBm: from no farther than {}. The report is ignored{}. A fixed position typed in wrong (latitude and longitude swapped or repeated) does this.", p.position.observed_at, p.position.lat, p.position.lon, km(p.distance_m), p.gateway, p.rssi, km(p.bound_m), if x.position.is_some() { ", and an earlier one is used" } else if x.estimate.is_some() { ", and it is estimated instead" } else { "" }));
        }
        if let Some(t) = &x.telemetry {
            if let Some(c) = t.ch_util.filter(|&c| c >= CH_UTIL_WARN) {
                let sev = if c >= CH_UTIL_PROBLEM { "problem" } else { "warning" };
                add(n, "channel_busy", sev, format!("Channel {c:.0} % busy"), format!("It reports {c:.1} % channel utilisation (the mesh median is usually a few per cent). Above 25 % firmware drops optional broadcasts, above 40 % nodes go quiet: something near it is flooding the channel."));
            }
            if let Some(a) = t.air_util.filter(|&a| a >= AIR_UTIL_WARN) {
                add(n, "airtime_limit", "warning", format!("Transmits {a:.0} % of the time"), format!("It reports {a:.1} % transmit airtime; EU 868 MHz allows 10 % per hour, after which it must stay silent."));
            }
            if let Some(b) = t.battery.filter(|&b| b <= BATTERY_LOW) {
                add(n, "battery_low", "notice", format!("Battery {b:.0} %"), "Its last device telemetry reports a low battery.".into());
            }
        }
        let moving = x.moved_at.is_some();
        let rate = |t: u32| count(n, t, &|_| true) as f64 / hours;
        let tel = count(n, ty::TELEMETRY, &|r| r.telemetry().is_some_and(|t| t.kind == ty::DEVICE)) as f64 / hours;
        for (kind, r, limit, what, default) in [
            ("chatty_position", if moving { 0.0 } else { rate(ty::POSITION) }, POSITION_PER_H, "positions", "the firmware default is one every 15 minutes at most, less when it is not moving"),
            ("chatty_nodeinfo", rate(ty::NODEINFO), NODEINFO_PER_H, "NodeInfo announcements", "the default is one every 3 hours"),
            ("chatty_telemetry", tel, TELEMETRY_PER_H, "device telemetry reports", "the default is one every 30 minutes"),
        ] {
            if r > limit {
                add(n, kind, "notice", format!("Sends {r:.1} {what} per hour"), format!("More often than needed ({default}); each one is flooded through the mesh."));
            }
        }
    }
    // Battery trend and restarts, from its device telemetry (D-099).
    for (&n, pk) in &own {
        let mut tel: Vec<(i64, &crate::row::Telemetry)> = pk.values().filter_map(|r| r.telemetry().filter(|t| t.kind == ty::DEVICE).map(|t| (r.t, t))).collect();
        tel.sort_by_key(|x| x.0);
        let batt: Vec<(f64, f64)> = tel.iter().filter_map(|(t, x)| x.battery.filter(|&b| b <= 100.0).map(|b| (*t as f64 / 86_400_000.0, b))).collect();
        if batt.len() >= BATTERY_TREND_MIN_REPORTS && batt[batt.len() - 1].0 - batt[0].0 >= 1.0 {
            let k = batt.len() as f64;
            let (mx, my) = (batt.iter().map(|p| p.0).sum::<f64>() / k, batt.iter().map(|p| p.1).sum::<f64>() / k);
            let var: f64 = batt.iter().map(|p| (p.0 - mx).powi(2)).sum();
            let slope = if var > 0.0 { batt.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>() / var } else { 0.0 };
            let now = batt[batt.len() - 1].1;
            if slope <= -BATTERY_FALL_PER_DAY {
                let days = now / -slope;
                let sev = if now <= BATTERY_WARN_AT || days <= 7.0 { "warning" } else { "notice" };
                add(n, "battery_falling", sev, format!("Battery falling about {:.0} % a day", -slope), format!("Its battery went from about {:.0} % to {now:.0} % over {:.1} days ({} reports): at this rate it is empty {}. A solar node that does not recover overnight, or a failing battery.", batt[0].1, batt[batt.len() - 1].0 - batt[0].0, batt.len(), if days < 1.5 { "within a day".to_string() } else { format!("in about {days:.0} days") }));
            }
        }
        let mut restarts: Vec<i64> = Vec::new();
        let mut prev: Option<(i64, u32)> = None;
        for (t, x) in &tel {
            let Some(u) = x.uptime else { continue };
            if let Some((pt, pu)) = prev {
                // Uptime went backwards, beyond what the time between reports explains.
                if u < pu && u as i64 * 1000 < t - pt {
                    restarts.push(t - u as i64 * 1000);
                }
            }
            prev = Some((*t, u));
        }
        if let Some(&last) = restarts.last() {
            let sev = if restarts.len() >= RESTARTS_WARN { "warning" } else { "notice" };
            let times = if restarts.len() == 1 { "once".to_string() } else { format!("{} times", restarts.len()) };
            add(n, "restarted", sev, format!("Restarted {times}"), format!("Its uptime went back to zero {times} in the window, last around {}. Repeated restarts point at power trouble (a weak battery or supply) or a crashing firmware.", crate::util::iso(last)));
        }
    }
    // Shared keys (D-142): ids announcing the same public key while both
    // active. A key passed on (an upgrade to 2.8 with the key kept, or a key
    // restored onto new hardware) leaves the old id silent first: not flagged;
    // nor is a rollback to the old id, which spans the new one's time but
    // takes turns with it rather than interleaving (D-154).
    // Anyone can announce any key unsigned, so a node whose NodeInfo verified
    // (it proved holding the key) is never flagged; the ids claiming its key
    // are. Without such a proof the claims cannot be told from a copied key,
    // and are a notice.
    let mut by_key: FxMap<u32, Vec<(u32, bool)>> = map();
    for x in nodes {
        if let Some(id) = x.identity.as_ref()
            && let Some(k) = id.key_num
        {
            by_key.entry(k).or_default().push((x.num, id.signature == "verified" && k == x.num));
        }
    }
    let span = |n: u32| own.get(&n).map(|m| m.values().fold((i64::MAX, i64::MIN), |(lo, hi), r| (lo.min(r.t), hi.max(r.t))));
    // Both ids' packets in time order (ties by id, so either way round
    // counts alike), and how often the sender switches between them.
    let switches = |a: u32, b: u32| {
        let mut v: Vec<(i64, u32)> = [a, b].iter().flat_map(|&n| own.get(&n).into_iter().flat_map(move |m| m.values().map(move |r| (r.t, n)))).collect();
        v.sort_unstable();
        v.windows(2).filter(|w| w[0].1 != w[1].1).count()
    };
    let overlap = |a: u32, b: u32| matches!((span(a), span(b)), (Some((a0, a1)), Some((b0, b1))) if a1.min(b1) - a0.max(b0) >= SHARED_KEY_OVERLAP_MS) && switches(a, b) >= SHARED_KEY_MIN_SWITCHES;
    for (k, ids) in by_key.into_iter().filter(|(_, v)| v.len() > 1) {
        let holder = ids.iter().find(|&&(_, proved)| proved).map(|&(n, _)| n);
        for &(n, proved) in &ids {
            if proved {
                continue;
            }
            let mut with: Vec<u32> = ids.iter().map(|&(o, _)| o).filter(|&o| o != n && overlap(n, o)).collect();
            if with.is_empty() {
                continue;
            }
            with.sort_unstable();
            let others: Vec<String> = with.iter().map(|&o| node_id(o)).collect();
            // A proven key's claimants are warned even when only they overlap
            // (the holder silent meanwhile): it is still the holder's key.
            match holder {
                Some(h) => add(n, "shared_key", "warning", format!("Announces the public key of {}", node_id(h)), format!("{} proved holding this key (a verified signature; firmware 2.8 derives its id from it), while this id announced it unsigned{}. Either a device set up from {}'s backup or with its key copied, which can then read its direct messages, or someone announcing another node's key; signatures still tell them apart. A copy should get a new key.", node_id(h), if with.contains(&h) { " at the same time".to_string() } else { format!(", at the same time as {}", others.join(", ")) }, node_id(h))),
                None => add(n, "shared_key", "notice", format!("Announces the same public key as {}", others.join(", ")), format!("Active at the same time with the same key, and none of them proved holding it (no verified signature, as on firmware 2.7 and earlier). Devices set up from one backup or with a copied key can read each other's direct messages, and on firmware 2.8 they would all take the id {}; but an unsigned NodeInfo can also announce another node's key, so check the devices before acting.", node_id(k))),
            }
        }
    }
    // Ids announcing one key are one device under two ids (an upgrade to 2.8,
    // or a copy the shared-key rule reports), not two nodes named alike.
    let key_of: FxMap<u32, u32> = nodes.iter().filter_map(|x| Some((x.num, x.identity.as_ref()?.key_num?))).collect();
    for (s, ns) in shorts.into_iter().filter(|(_, v)| v.len() > 1) {
        for &n in &ns {
            let k = key_of.get(&n);
            let others: Vec<String> = ns.iter().filter(|&&o| o != n && (k.is_none() || key_of.get(&o) != k)).map(|&o| node_id(o)).collect();
            if others.is_empty() {
                continue;
            }
            add(n, "duplicate_name", "notice", format!("Short name \"{s}\" is not unique"), format!("Also used by {}: easy to confuse on the map and in apps.", others.join(", ")));
        }
    }

    // Possible impersonation (D-108): packets claiming to be from a node whose
    // signature or key does not check out. Decoding failures are not counted.
    let trust = ["sig_invalid", "sig_malformed", "first_contact_invalid", "nodeinfo_key_mismatch", "strict_unverifiable"];
    let mut claimed: FxMap<u32, Claims> = map();
    for &r in &invalid {
        let Some(reason) = r.invalid().filter(|&v| trust.contains(&i.s(v))) else { continue };
        let e = claimed.entry(r.src).or_default();
        if e.0.insert(r.lp) {
            *e.1.entry(reason).or_default() += 1;
        }
        if let Some(g) = r.gw {
            e.2.insert(g);
        }
    }
    for (n, (packets, reasons, gws)) in claimed {
        if packets.len() < SPOOF_MIN {
            continue;
        }
        let mut rs: Vec<(String, usize)> = reasons.into_iter().map(|(k, c)| (i.s(k).to_string(), c)).collect();
        rs.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let list: Vec<String> = rs.iter().map(|(k, c)| format!("{c} × {}", k.replace('_', " "))).collect();
        let key_change = rs.iter().all(|(k, _)| k == "nodeinfo_key_mismatch");
        let first_contact = rs.iter().all(|(k, _)| k == "first_contact_invalid");
        let why = if first_contact {
            "No key is trusted for this node yet, and these signed NodeInfo packets did not establish one: the key they announce does not derive its node id, or their signature does not verify against that key. Someone may be announcing a key for its node number, or a gateway altered the packets on the way. They are kept out of the map, so they do not affect its links or counts."
        } else if key_change {
            "They announce a different public key than the one trusted for this node: most likely it was reset or reflashed and has a new key, which is trusted only once the old key's announcements leave retention. If not, someone is using its node number."
        } else {
            "Their signatures do not verify against the key trusted for this node: someone may be sending packets in its name, or its key changed. They are kept out of the map, so they do not affect its links or counts."
        };
        add(n, "spoofed", "warning", format!("{} packets in its name failed verification", packets.len()), format!("{} packets claiming to come from it ({}), reported by {} gateway{}. {why}", packets.len(), list.join(", "), gws.len(), if gws.len() == 1 { "" } else { "s" }));
    }

    // Silent infrastructure (D-188): routers and gateways heard in the
    // window that then went quiet for much longer than their usual rhythm,
    // from all its valid rows: filters choose what to look at, not whether
    // a node is alive. A node on the move (a car, a hike) comes and goes by
    // design.
    let is_infra = |x: &Node| INFRA_ROLES.contains(&role_of(x));
    let kept: FxSet<u32> = nodes.iter().filter(|x| (is_infra(x) || x.is_gateway) && x.moved_at.is_none()).map(|x| x.num).collect();
    let heard = heard_times(&live, |n| kept.contains(&n));
    let newest = live.iter().map(|r| r.t).max().unwrap_or(i64::MIN);
    for x in nodes.iter().filter(|x| kept.contains(&x.num)) {
        let role = role_of(x);
        let infra = is_infra(x);
        let Some(ts) = heard.get(&x.num) else { continue };
        let Some(usual) = usual_gap(ts, SILENT_MIN_EVENTS) else { continue };
        let last = ts[ts.len() - 1];
        let silent = newest - last;
        if !gone_quiet(silent, usual, SILENT_MIN_MS) {
            continue;
        }
        let what = match (infra, x.is_gateway) {
            (true, true) => format!("{} and gateway", role_word(role)),
            (true, false) => role_word(role).to_string(),
            _ => "Gateway".to_string(),
        };
        let mut detail = format!("{what}, last heard {} ({} before the newest data in the window); it was usually heard every {}.", crate::util::iso(last), span_words(silent), span_words(usual.max(60_000)));
        if let Some(t) = &x.telemetry {
            let mut parts: Vec<String> = Vec::new();
            if let Some(b) = t.battery {
                parts.push(if b > 100.0 { "external power".into() } else { format!("battery {b:.0} %") });
            }
            if let Some(v) = t.voltage.filter(|&v| v > 0.0) {
                parts.push(format!("{v:.2} V"));
            }
            if let Some(u) = t.uptime {
                parts.push(format!("up {}", span_words(u as i64 * 1000)));
            }
            if !parts.is_empty() {
                detail.push_str(&format!(" Its last device telemetry ({}): {}.", t.observed_at, parts.join(", ")));
            }
            if t.battery.is_some_and(|b| b <= SILENT_BATTERY_LOW) {
                detail.push_str(" The battery was low then: it may have run flat.");
            }
        }
        detail.push_str(if x.is_gateway {
            " As a gateway it also stopped uplinking: its power, internet connection or broker login may be down."
        } else {
            " Gateways stopped hearing it: it may be off or out of power, or the gateways that heard it may be down themselves."
        });
        weighted.push(Issue { node: node_id(x.num), kind: "silent", severity: "warning", summary: format!("Silent for {}", span_words(silent)), detail, weight: silent as f64 });
    }

    // Router role review (D-189): routers rebroadcast everything they hear,
    // so they pay off where they reach nodes others do not. From the
    // window's radio links (medium confidence or better), which only show
    // what gateways reported: notices, worded as such.
    fn role_of(x: &Node) -> &str {
        x.identity.as_ref().map_or("", |id| id.role.as_str())
    }
    let mut neighbours: FxMap<u32, FxSet<u32>> = map();
    for e in edges.iter().filter(|e| !e.mqtt && !e.inferred && e.confidence != "low") {
        neighbours.entry(e.src_num).or_default().insert(e.dst_num);
        neighbours.entry(e.dst_num).or_default().insert(e.src_num);
    }
    let empty = FxSet::default();
    let near = |n: u32| neighbours.get(&n).unwrap_or(&empty);
    let routers: Vec<&Node> = nodes.iter().filter(|x| ROUTER_ROLES.contains(&role_of(x)) && x.moved_at.is_none()).collect();
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
                add(r.num, "router_overlap", "notice", format!("Covers the same nodes as router {}", node_id(o.num)), format!("{shared} of its {} radio neighbours are also neighbours of {} (or {} itself), a router it hears directly. Two routers reaching the same nodes both rebroadcast every packet: twice the airtime, no new reach. One of them as CLIENT would do the same job; keep the better-placed one as router. Only links that gateways reported are known, so check on site before changing.", mine.len(), node_id(o.num), node_id(o.num)));
            }
        }
        let own_packets = own.get(&r.num).map_or(0, FxMap::len);
        if own_packets >= FEW_LINKS_MIN_PACKETS && (1..=FEW_LINKS).contains(&mine.len()) {
            add(r.num, "router_few_links", "notice", format!("Router with {} radio link{}", mine.len(), if mine.len() == 1 { "" } else { "s" }), format!("Gateways reported it linked to {} node{} over {own_packets} of its packets. A router rebroadcasts everything it hears, which helps most on a high site that hears many nodes; with few neighbours, CLIENT is usually the better role. A site that only gateways nobody reports from can hear would look the same, so check its placement first.", mine.len(), if mine.len() == 1 { "" } else { "s" }));
        }
    }
    // Router link drop (D-197): a router's links to other routers falling
    // at one time and staying down, each link against itself, so a change
    // in which partners happen to be heard cannot fake it.
    let router_nums: FxSet<u32> = nodes.iter().filter(|x| ROUTER_ROLES.contains(&role_of(x))).map(|x| x.num).collect();
    let by_router = crate::views::link::router_links(readings, &router_nums);
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
        weighted.push(Issue { node: node_id(r.num), kind: "router_link_drop", severity: "warning", summary: format!("Router links {:.0} dB weaker since {}", -d.drop, crate::util::time_mark(d.at)), detail, weight: -d.drop });
    }
    // Co-located relays: nodes that rebroadcast, at one site. They repeat
    // the same packets from the same place; all but one could be CLIENT_MUTE.
    let placed: Vec<(&Node, crate::graph::LatLon)> = nodes
        .iter()
        .filter(|x| x.moved_at.is_none() && !crate::views::is_silent_role(role_of(x)) && x.status == "observed")
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
    let keep_first = |x: &Node| (!ROUTER_ROLES.contains(&role_of(x)), std::cmp::Reverse(near(x.num).len()), x.num);
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
            add(x.num, "co_located", "notice", format!("Relays from the same site as {}", node_id(keep)), format!("{} nodes that rebroadcast report positions within {SITE_M:.0} m of each other ({}). Each repeats the same packets from the same place: more airtime, no more reach. All but one, here {} (a router, or the most radio neighbours), could be CLIENT_MUTE, which still sends its own packets.", site.len(), all.join(", "), node_id(keep)));
        }
    }

    // Airtime.
    let air = airtime(copies, rows, i, hours);
    for a in air.nodes.iter().filter(|a| a.caused >= AIRTIME_WARN_SHARE) {
        let top: Vec<String> = a.by_type.iter().take(2).map(|(t, s)| format!("{t} {}", pct(*s))).collect();
        add(a.num, "airtime", "warning", format!("Causes {} of the airtime", pct(a.caused)), format!("Its {} packets and their {} transmissions seen make up about {} of the window's estimated airtime ({}).", a.packets, a.transmissions, pct(a.caused), top.join(", ")));
    }

    for f in air.store_forward.nodes.iter().filter(|f| f.share >= STORE_FORWARD_SHARE) {
        let kinds: Vec<String> = f.by_kind.iter().take(3).map(|(k, c)| format!("{c} {}", k.replace('_', " "))).collect();
        add(f.num, "store_forward", "notice", format!("Store-and-forward takes {} of the airtime", pct(f.share)), format!("{} store-and-forward packets ({}), {:.1} heartbeats per hour, {} history replays. Each heartbeat and replay is flooded like any packet; a longer heartbeat interval or a smaller history window would free airtime.", f.packets, kinds.join(", "), f.heartbeats_per_hour, f.replays));
    }
    out.extend(weighted);
    out.sort_unstable_by(|a, b| rank(a.severity).cmp(&rank(b.severity)).then(a.kind.cmp(b.kind)).then(b.weight.total_cmp(&a.weight)).then(a.node.cmp(&b.node)).then(a.summary.cmp(&b.summary)).then(a.detail.cmp(&b.detail)));
    Health { issues: out, airtime: air }
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
            for &x in &l.snr {
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

/// Copies and bursts closer together than this are one event of a node's rhythm.
const EVENT_MS: i64 = 60_000;

/// When each node `want` picks was heard, for the silence rules (D-188,
/// D-192): its own packets (first copy each: a late copy is not the node
/// speaking again) and its uplinks as a gateway, in time order, with events
/// less than a minute after the last kept one merged into it.
pub fn heard_times(rows: &[&Row], want: impl Fn(u32) -> bool) -> FxMap<u32, Vec<i64>> {
    let mut out: FxMap<u32, Vec<i64>> = map();
    for &r in rows {
        if let Some(g) = r.gw.filter(|&g| want(g)) {
            out.entry(g).or_default().push(r.t);
        }
    }
    for r in first_per_packet(rows.iter().copied(), |r| want(r.src)) {
        out.entry(r.src).or_default().push(r.t);
    }
    for ts in out.values_mut() {
        ts.sort_unstable();
        ts.dedup_by(|b, a| *b - *a < EVENT_MS);
    }
    out
}

/// A node's usual gap between events (heard_times): the median, from at
/// least `min_events` of them; None with fewer.
pub fn usual_gap(ts: &[i64], min_events: usize) -> Option<i64> {
    if ts.len() < min_events.max(2) {
        return None;
    }
    let mut gaps: Vec<i64> = ts.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.sort_unstable();
    Some(gaps[gaps.len() / 2])
}

/// Quiet for `quiet` ms counts as gone quiet: SILENT_GAP_FACTOR times its
/// usual gap, and at least `min_ms`.
pub fn gone_quiet(quiet: i64, usual: i64, min_ms: i64) -> bool {
    quiet >= min_ms.max(SILENT_GAP_FACTOR * usual)
}

/// NARROW_FAST -> Narrow Fast.
fn label(p: &str) -> String {
    p.split('_').map(|w| w[..1].to_uppercase() + &w[1..].to_lowercase()).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::JRow;

    const H: i64 = 3_600_000;

    fn telemetry(i: &mut Interner, k: i64, battery: f64, uptime: u32) -> Row {
        let text = format!(
            r#"{{"i":{k},"t":{},"b":"x","g":7,"s":5,"y":"telemetry","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","te":{{"kind":"device","battery":{battery},"uptime":{uptime}}}}}"#,
            k * 3 * H
        );
        serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
    }

    fn issues(rows: &[Row], i: &Interner) -> Vec<Issue> {
        let refs: Vec<&Row> = rows.iter().collect();
        health(&refs, &[], &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), i, 48.0, &crate::landsdel::Regions::default()).issues
    }

    #[test]
    fn a_battery_falling_fast_is_flagged_and_a_steady_one_is_not() {
        let mut i = Interner::default();
        // 12 reports over 33 h, 80 % down to 36 %: 32 % a day.
        let falling: Vec<Row> = (0..12).map(|k| telemetry(&mut i, k, 80.0 - 4.0 * k as f64, 1000 + k as u32 * 10_800)).collect();
        let got = issues(&falling, &i);
        let b = got.iter().find(|x| x.kind == "battery_falling").expect("flagged");
        assert_eq!(b.severity, "warning");
        // Swinging around a level, as a solar node does, is not.
        let steady: Vec<Row> = (0..12).map(|k| telemetry(&mut i, k, if k % 2 == 0 { 90.0 } else { 70.0 }, 1000 + k as u32 * 10_800)).collect();
        assert!(issues(&steady, &i).iter().all(|x| x.kind != "battery_falling"));
    }

    /// A node `n` with `role` sending one packet at each of `times` (ms).
    fn sender(i: &mut Interner, n: u32, role: &str, times: &[i64]) -> (crate::views::Node, Vec<Row>) {
        let mut x = crate::views::Node::new(n);
        x.identity = Some(crate::views::Identity { role: role.into(), ..Default::default() });
        let rows = times
            .iter()
            .enumerate()
            .map(|(k, &t)| {
                let text = format!(r#"{{"i":{},"t":{t},"b":"x","g":99,"s":{n},"y":"text","l":"{:016x}","o":"{:016x}","sg":"unsigned"}}"#, n as usize * 1000 + k, n as usize * 1000 + k, n as usize * 1000 + k);
                serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
            })
            .collect();
        (x, rows)
    }

    #[test]
    fn infrastructure_that_goes_quiet_for_long_is_listed_longest_first() {
        let mut i = Interner::default();
        let m = 60_000;
        // Heard every 30 minutes for a day; the rows run on to hour 48 (another node).
        let every = |from: i64, to: i64| (0..).map(move |k| from + k * 30 * m).take_while(move |&t| t <= to).collect::<Vec<_>>();
        let (a, ra) = sender(&mut i, 1, "ROUTER", &every(0, 24 * H)); // silent 24 h
        let (b, rb) = sender(&mut i, 2, "ROUTER_LATE", &every(0, 40 * H)); // silent 8 h
        let (c, rc) = sender(&mut i, 3, "ROUTER", &every(0, 47 * H)); // 1 h: not yet
        let (d, rd) = sender(&mut i, 4, "CLIENT", &every(0, 10 * H)); // a client: never listed
        let (mut e, re) = sender(&mut i, 5, "ROUTER", &every(0, 10 * H));
        e.moved_at = Some("2026-11-05T00:00:00Z".into()); // on the move: comes and goes
        let (f, rf) = sender(&mut i, 6, "CLIENT", &every(0, 48 * H));
        let rows: Vec<Row> = [ra, rb, rc, rd, re, rf].into_iter().flatten().collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let nodes = [a, b, c, d, e, f];
        let got = health(&refs, &refs, &nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        // Filters that leave out the window's later rows (a type, channel or
        // broker filter) change nothing: liveness comes from the whole window.
        let early: Vec<&Row> = refs.iter().copied().filter(|r| r.t <= 10 * H).collect();
        let filtered = health(&early, &refs, &nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        assert_eq!(filtered.iter().filter(|x| x.kind == "silent").count(), 2);
        let silent: Vec<(&str, &str)> = got.iter().filter(|x| x.kind == "silent").map(|x| (x.node.as_str(), x.summary.as_str())).collect();
        assert_eq!(silent, [("!00000001", "Silent for 24 h"), ("!00000002", "Silent for 8.0 h")]);
        assert!(got.iter().find(|x| x.node == "!00000001" && x.kind == "silent").unwrap().detail.contains("usually heard every 30 min"));
    }

    #[test]
    fn a_nodes_rhythm_counts_its_packets_once_and_its_uplinks() {
        let mut i = Interner::default();
        let m = 60_000;
        let row = |i: &mut Interner, k: u64, lp: u64, src: u32, gw: u32, t: i64| {
            let text = format!(r#"{{"i":{k},"t":{t},"b":"x","g":{gw},"s":{src},"y":"text","l":"{lp:016x}","o":"{lp:016x}","sg":"unsigned"}}"#);
            serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
        };
        // Node 1's packet at 0, a late copy of it at 30 min (not another
        // event), a second packet at 60 min; node 1 uplinks node 2's at 61
        // min (one event with the packet a minute before) and at 120 min.
        let rows = [row(&mut i, 1, 10, 1, 9, 0), row(&mut i, 2, 10, 1, 8, 30 * m), row(&mut i, 3, 11, 1, 9, 60 * m), row(&mut i, 4, 12, 2, 1, 60 * m + 30_000), row(&mut i, 5, 13, 2, 1, 120 * m)];
        let refs: Vec<&Row> = rows.iter().collect();
        let heard = heard_times(&refs, |n| n == 1);
        assert_eq!(heard.get(&1), Some(&vec![0, 60 * m, 120 * m]));
        assert!(!heard.contains_key(&2), "only the nodes asked for");
        assert_eq!(usual_gap(&heard[&1], 3), Some(60 * m));
        assert_eq!(usual_gap(&heard[&1], 4), None);
        assert!(gone_quiet(4 * 60 * m, 60 * m, 3 * 60 * m) && !gone_quiet(4 * 60 * m - 1, 60 * m, 3 * 60 * m));
    }

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

    /// A gateway at (lat, lon) and one uplink of it under `topic`.
    fn gateway(i: &mut Interner, n: u32, lat: f64, lon: f64, topic: &str, k: i64) -> (crate::views::Node, Row) {
        let mut x = crate::views::Node::new(n);
        x.is_gateway = true;
        x.position = Some(crate::views::Position { lat, lon, alt: None, precision_bits: 32, precision_known: true, signature: "unsigned".into(), observed_at: "2026-11-05T00:00:00Z".into(), source: "position".into() });
        let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":{n},"s":5,"y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","tp":"{topic}"}}"#, k * H);
        (x, serde_json::from_str::<JRow>(&text).unwrap().into_row(i))
    }

    fn node_issues(rows: &[Row], nodes: &[crate::views::Node], i: &Interner) -> Vec<Issue> {
        let refs: Vec<&Row> = rows.iter().collect();
        health(&refs, &[], nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), i, 48.0, &crate::landsdel::tests::fixture()).issues
    }

    #[test]
    fn a_gateway_under_another_regions_root_is_flagged() {
        let mut i = Interner::default();
        // In Oslo: Trøndelag's root is a warning, no region a notice, its own none.
        let (oslo, wrong) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Trøndelag", 1);
        let got = node_issues(&[wrong], std::slice::from_ref(&oslo), &i);
        let t = got.iter().find(|x| x.kind == "topic_region").expect("flagged");
        assert_eq!(t.severity, "warning");
        assert!(t.summary.ends_with("from Østlandet") && t.detail.contains("msh/EU_868/NO/Trøndelag (Trøndelag, 1 uplinks)"), "{t:?}");
        let (_, bare) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO", 2);
        assert_eq!(node_issues(&[bare], std::slice::from_ref(&oslo), &i).iter().find(|x| x.kind == "topic_region").map(|x| x.severity), Some("notice"));
        // A misspelt region (ASCII for ø) is a warning naming the exact spelling.
        let (_, ascii) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Ostlandet", 5);
        let got = node_issues(&[ascii], std::slice::from_ref(&oslo), &i);
        let t = got.iter().find(|x| x.kind == "topic_region").expect("misspelt");
        assert!(t.severity == "warning" && t.detail.contains("\"Ostlandet\" is not \"Østlandet\""), "{t:?}");
        let (_, right) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Østlandet", 3);
        assert!(node_issues(&[right], &[oslo], &i).iter().all(|x| x.kind != "topic_region"));
        // Abroad there is no region to compare with.
        let (sthlm, any) = gateway(&mut i, 8, 59.33, 18.07, "msh/EU_868/NO/Trøndelag", 4);
        assert!(node_issues(&[any], &[sthlm], &i).iter().all(|x| x.kind != "topic_region"));
    }

    #[test]
    fn a_gateway_that_moved_is_flagged() {
        let mut i = Interner::default();
        let (mut x, r) = gateway(&mut i, 7, 63.43, 10.39, "msh/EU_868/NO/Trøndelag", 1);
        assert!(node_issues(std::slice::from_ref(&r), std::slice::from_ref(&x), &i).iter().all(|y| y.kind != "moving_gateway"));
        x.moved_at = Some("2026-11-04T12:00:00Z".into());
        let got = node_issues(std::slice::from_ref(&r), std::slice::from_ref(&x), &i);
        assert_eq!(got.iter().find(|y| y.kind == "moving_gateway").map(|y| y.severity), Some("warning"));
        // A node that moved but uplinks nothing is not.
        x.is_gateway = false;
        assert!(node_issues(&[r], &[x], &i).iter().all(|y| y.kind != "moving_gateway"));
    }

    #[test]
    fn uptime_going_back_counts_as_a_restart() {
        let mut i = Interner::default();
        // Uptime grows with each report, resets after report 5, grows again.
        let rows: Vec<Row> = (0..10).map(|k| telemetry(&mut i, k, 100.0, if k < 6 { 50_000 + k as u32 * 10_800 } else { 600 + (k as u32 - 6) * 10_800 })).collect();
        let got = issues(&rows, &i);
        let r = got.iter().find(|x| x.kind == "restarted").expect("restart seen");
        assert_eq!((r.severity, r.summary.as_str()), ("notice", "Restarted once"));
        // A node reporting uptime 0 every time has not restarted.
        let zero: Vec<Row> = (0..10).map(|k| telemetry(&mut i, k, 100.0, 0)).collect();
        assert!(issues(&zero, &i).iter().all(|x| x.kind != "restarted"));
    }

    #[test]
    fn packets_in_a_nodes_name_that_fail_verification_are_flagged() {
        let mut i = Interner::default();
        let bad = |i: &mut Interner, k: i64, reason: &str| {
            let text = format!(r#"{{"i":{k},"t":{k},"b":"x","g":7,"s":5,"y":"invalid","l":"{k:016x}","o":"{k:016x}","sg":"not-applicable","iv":"{reason}"}}"#);
            serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
        };
        let forged: Vec<Row> = (1..=3).map(|k| bad(&mut i, k, "sig_invalid")).collect();
        let decode: Vec<Row> = (4..=9).map(|k| bad(&mut i, k, "payload_invalid")).collect();
        let refs: Vec<&Row> = forged.iter().chain(&decode).collect();
        let got = health(&[], &refs, &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        let s: Vec<&Issue> = got.iter().filter(|x| x.kind == "spoofed").collect();
        assert_eq!(s.len(), 1, "decoding failures alone are not impersonation");
        assert!(s[0].summary.starts_with("3 packets"));
        // A changed key is explained as a likely reset.
        let rekeyed: Vec<Row> = (1..=4).map(|k| bad(&mut i, k, "nodeinfo_key_mismatch")).collect();
        let refs: Vec<&Row> = rekeyed.iter().collect();
        let got = health(&[], &refs, &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        assert!(got.iter().any(|x| x.kind == "spoofed" && x.detail.contains("reset or reflashed")));
    }

    /// A link direction read every 20 minutes over 72 h, at `snr(hour)` with
    /// a repeatable ±1.5 dB of noise; `keep(hour)` picks which readings exist.
    fn link(partner: u32, out: bool, snr: impl Fn(f64) -> f64, keep: impl Fn(f64) -> bool) -> RouterLink {
        let mut l = RouterLink { partner, out, ..Default::default() };
        for k in 0..216u32 {
            let h = k as f64 / 3.0;
            if keep(h) {
                let noise = ((k.wrapping_mul(2_654_435_761) ^ partner.wrapping_mul(40_503)) % 31) as f64 / 10.0 - 1.5;
                l.t.push((h * H as f64) as i64);
                l.snr.push((snr(h) + noise) as f32);
            }
        }
        l
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
            for (k, (&t, &snr)) in l.t.iter().zip(&l.snr).enumerate() {
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
