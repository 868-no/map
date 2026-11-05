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
use crate::views::Node;

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

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Issue {
    pub node: String,
    pub kind: &'static str,
    /// problem, warning or notice.
    pub severity: &'static str,
    pub summary: String,
    pub detail: String,
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
            if let Some(t) = h.row.traceroute().filter(|t| t.valid) {
                let hops = if t.is_reply { &t.route_back } else { &t.route };
                relays.extend(hops.iter().filter(|x| !x.unknown && x.id != row.src && Some(x.id) != h.row.gw).map(|x| x.id));
            }
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

/// The window's known issues and airtime. `hours`: the window's length;
/// rates use the span its rows cover when that is shorter. `invalid`: the
/// window's rows that failed decoding or verification, which the filters
/// keep out of `rows` (D-093). nodes, copies, presets: the build's (views::Built).
pub fn health(rows: &[&Row], invalid: &[&Row], nodes: &[Node], copies: &Copies, presets: &PresetIndex, i: &Interner, hours: f64) -> Health {
    // Rates over the span the data covers, which can be shorter than the
    // window (the service started later, or was down).
    let (lo, hi) = rows.iter().fold((i64::MAX, i64::MIN), |(lo, hi), r| (lo.min(r.t), hi.max(r.t)));
    let span = if hi > lo { (hi - lo) as f64 / 3_600_000.0 } else { 0.0 };
    let hours = hours.min(span).max(1.0);
    let mut out: Vec<Issue> = Vec::new();
    let mut add = |n: u32, kind: &'static str, severity: &'static str, summary: String, detail: String| out.push(Issue { node: node_id(n), kind, severity, summary, detail });

    // Own packets, first copy each, and per-node counts by type.
    let mut own: FxMap<u32, FxMap<u64, &Row>> = map();
    for &r in rows {
        own.entry(r.src).or_default().entry(r.lp).and_modify(|c| if r.t < c.t { *c = r }).or_insert(r);
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
        if r.gw.is_some_and(|g| g != r.src) && r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF {
            if let Some(h) = r.hops().filter(|&h| h >= 0) {
                let e = fewest.entry(r.lp).or_insert(h);
                *e = (*e).min(h);
            }
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
        if let (Some(rt), Some(d)) = (r.routing(), r.dst) {
            if refused.contains(&rt.error) {
                refusals.entry(d).or_default().insert(r.src);
            }
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
            if r.crypto == plain {
                if let Some(g) = r.gw {
                    *gws.entry(g).or_default() += 1;
                }
            }
        }
        for (g, c) in gws {
            add(g, "plaintext_uplink", "notice", "Uplinks to MQTT unencrypted".into(), format!("{c} of its uplinks arrived decrypted (MQTT encryption off): anyone subscribed to the broker reads its channels' traffic in the clear, including channels whose key is not public."));
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
        let device = i.get("device");
        let tel = count(n, ty::TELEMETRY, &|r| r.telemetry().is_some_and(|t| Some(t.kind) == device)) as f64 / hours;
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
    let device = i.get("device");
    for (&n, pk) in &own {
        let mut tel: Vec<(i64, &crate::row::Telemetry)> = pk.values().filter_map(|r| r.telemetry().filter(|t| Some(t.kind) == device).map(|t| (r.t, t))).collect();
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
        if let Some(id) = x.identity.as_ref() {
            if let Some(k) = id.key_num {
                by_key.entry(k).or_default().push((x.num, id.signature == "verified" && k == x.num));
            }
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
            match holder.filter(|h| with.contains(h)) {
                Some(h) => add(n, "shared_key", "warning", format!("Announces the public key of {}", node_id(h)), format!("{} proved holding this key (a verified signature; firmware 2.8 derives its id from it), while this id announced it unsigned at the same time. Either a device set up from {}'s backup or with its key copied, which can then read its direct messages, or someone announcing another node's key; signatures still tell them apart. A copy should get a new key.", node_id(h), node_id(h))),
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
    let mut claimed: FxMap<u32, (FxSet<u64>, FxMap<u32, usize>, FxSet<u32>)> = map();
    for &r in invalid {
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
    out.sort_unstable_by(|a, b| rank(a.severity).cmp(&rank(b.severity)).then(a.kind.cmp(b.kind)).then(a.node.cmp(&b.node)).then(a.summary.cmp(&b.summary)).then(a.detail.cmp(&b.detail)));
    Health { issues: out, airtime: air }
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
        health(&refs, &[], &[], &Copies::default(), &PresetIndex::default(), i, 48.0).issues
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
        let got = health(&[], &refs, &[], &Copies::default(), &PresetIndex::default(), &i, 48.0).issues;
        let s: Vec<&Issue> = got.iter().filter(|x| x.kind == "spoofed").collect();
        assert_eq!(s.len(), 1, "decoding failures alone are not impersonation");
        assert!(s[0].summary.starts_with("3 packets"));
        // A changed key is explained as a likely reset.
        let rekeyed: Vec<Row> = (1..=4).map(|k| bad(&mut i, k, "nodeinfo_key_mismatch")).collect();
        let refs: Vec<&Row> = rekeyed.iter().collect();
        let got = health(&[], &refs, &[], &Copies::default(), &PresetIndex::default(), &i, 48.0).issues;
        assert!(got.iter().any(|x| x.kind == "spoofed" && x.detail.contains("reset or reflashed")));
    }
}
