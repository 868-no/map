//! Which channels a node is on, and its LoRa modem preset inferred from
//! radio contact (D-064).
//!
//! Channels: a gateway uplinks each reception under the name of its own
//! channel whose hash the packet carried, so a reception names a channel the
//! sender transmitted on and one the gateway has. A node's own map report
//! names its primary channel (the envelope's channel id). Nodes can be on
//! several channels.
//!
//! Presets: nodes that hear each other over the air share modem settings
//! (preset or custom parameters, and frequency slot): direct receptions,
//! NeighborInfo entries and traceroute hops join them into radio groups. A
//! preset known for one member holds for all. Evidence, strongest first:
//! a map report confirmed by `has_default_channel` (firmware reports the
//! stored preset even under a custom modem config), then a channel with a
//! preset's default name (a hint only: a secondary channel can carry such a
//! name on any preset).

use serde::Serialize;

use crate::graph::Ev;
use crate::radio::preset_of;
use crate::row::{ty, Interner, Row};
use crate::util::{map, node_id, set, FxMap, FxSet};
use crate::views::traceroute_hops;

#[derive(Serialize, Debug, PartialEq)]
pub struct ChannelUse {
    pub name: String,
    /// Its own packets uplinked on this channel (distinct packets).
    pub sent: usize,
    /// Others' receptions it uplinked on this channel (as a gateway).
    pub uplinked: usize,
    /// Its primary channel, from its own map report.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
}

/// The channels `num` was seen on, primary first, then by use.
pub fn channel_use(num: u32, rows: &[&Row], i: &Interner) -> Vec<ChannelUse> {
    let mut sent: FxMap<u32, FxSet<u64>> = map();
    let mut uplinked: FxMap<u32, FxSet<u64>> = map();
    let mut primary: Option<&Row> = None;
    for &r in rows {
        if r.channel == 0 {
            continue;
        }
        if r.src == num {
            if r.ty == ty::MAPREPORT {
                if primary.is_none_or(|p| (r.t, r.id) > (p.t, p.id)) {
                    primary = Some(r);
                }
                continue;
            }
            sent.entry(r.channel).or_insert_with(set).insert(r.lp);
        } else if r.gw == Some(num) {
            uplinked.entry(r.channel).or_insert_with(set).insert(r.ok);
        }
    }
    let primary = primary.map(|r| r.channel);
    let mut names: Vec<u32> = sent.keys().chain(uplinked.keys()).copied().chain(primary).collect();
    names.sort_unstable();
    names.dedup();
    let mut out: Vec<ChannelUse> = names
        .into_iter()
        .map(|c| ChannelUse {
            name: i.s(c).to_string(),
            sent: sent.get(&c).map_or(0, |s| s.len()),
            uplinked: uplinked.get(&c).map_or(0, |s| s.len()),
            primary: primary == Some(c),
        })
        .collect();
    out.sort_by(|a, b| b.primary.cmp(&a.primary).then((b.sent + b.uplinked).cmp(&(a.sent + a.uplinked))).then(a.name.cmp(&b.name)));
    out
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PresetGuess {
    /// The preset, when the evidence agrees; None on conflict.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// "map_report": its own confirmed map report; "radio_contact": confirmed
    /// map reports of nodes it shares radio settings with; "channel_name" /
    /// "radio_contact_channel_name": default channel names (a hint);
    /// "conflict": its radio group's confirmed reports disagree.
    pub basis: &'static str,
    /// Up to five nodes whose evidence it rests on (radio contact bases).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub via: Vec<String>,
    /// Other nodes in its radio group (sharing modem settings): everyone
    /// reachable through chains of radio contact, not only its own contacts.
    pub group: usize,
    /// Nodes it heard or was heard by itself, over the air.
    pub direct: usize,
    /// Presets and how many group members each, when they disagree.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub conflict: Vec<(String, usize)>,
}

fn find(p: &mut FxMap<u32, u32>, mut x: u32) -> u32 {
    while let Some(&q) = p.get(&x) {
        if q == x {
            break;
        }
        let g = p.get(&q).copied().unwrap_or(q);
        p.insert(x, g); // path halving
        x = q;
    }
    x
}

fn union(p: &mut FxMap<u32, u32>, a: u32, b: u32) {
    if a == b || a == 0 || b == 0 {
        return;
    }
    p.entry(a).or_insert(a);
    p.entry(b).or_insert(b);
    let (ra, rb) = (find(p, a), find(p, b));
    if ra != rb {
        p.insert(ra.max(rb), ra.min(rb));
    }
}

/// Pairs of nodes that heard each other over the air in `rows`.
fn radio_contacts(rows: &[&Row]) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for &r in rows {
        if let (true, Some(g)) = (r.dr, r.gw) {
            out.push((r.src, g));
        }
        if r.ty == ty::NEIGHBORINFO {
            out.extend(r.neighbors().iter().map(|&(n, _)| (r.src, n)));
        }
    }
    // Exactly 0 dB may be a hop taken from MQTT, not the air (D-054).
    out.extend(traceroute_hops(rows).into_iter().filter(|s| s.ev == Ev::Traceroute && s.snr != Some(0.0)).map(|s| (s.src, s.dst)));
    out
}

/// One node's own preset evidence: (preset, confirmed by a map report).
fn evidence(rows: &[&Row], i: &Interner) -> FxMap<u32, (String, bool)> {
    let mut report: FxMap<u32, &Row> = map();
    let mut named: FxMap<u32, FxMap<&'static str, usize>> = map();
    for &r in rows {
        if r.ty == ty::MAPREPORT {
            if r.map_report().is_some_and(|m| m.default_channel && m.preset != 0) && report.get(&r.src).is_none_or(|p| (r.t, r.id) > (p.t, p.id)) {
                report.insert(r.src, r);
            }
        } else if r.channel != 0 {
            if let Some(p) = preset_of(i.s(r.channel)) {
                *named.entry(r.src).or_insert_with(map).entry(p).or_insert(0) += 1;
            }
        }
    }
    let mut out: FxMap<u32, (String, bool)> = map();
    for (n, ps) in named {
        // The default name it was heard on most.
        if let Some((p, _)) = ps.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))) {
            out.insert(n, (p.to_string(), false));
        }
    }
    for (n, r) in report {
        out.insert(n, (i.s(r.map_report().unwrap().preset).to_string(), true));
    }
    out
}

/// What the window says about `num`'s modem preset; None without evidence.
pub fn preset_guess(num: u32, rows: &[&Row], i: &Interner) -> Option<PresetGuess> {
    let ev = evidence(rows, i);
    let contacts = radio_contacts(rows);
    let mut parent: FxMap<u32, u32> = map();
    parent.insert(num, num);
    let mut direct: FxSet<u32> = set();
    for &(a, b) in &contacts {
        union(&mut parent, a, b);
        if a == num {
            direct.insert(b);
        } else if b == num {
            direct.insert(a);
        }
    }
    let root = find(&mut parent, num);
    let keys: Vec<u32> = parent.keys().copied().collect();
    let mut members: Vec<u32> = keys.into_iter().filter(|&n| n != num && find(&mut parent, n) == root).collect();
    // Direct contacts first, then by node number: stable, and the nearest evidence leads.
    members.sort_by_key(|n| (!direct.contains(n), *n));
    let group = members.len();
    let n_direct = direct.len();
    let guess = |preset: Option<String>, basis, via: Vec<String>, conflict| Some(PresetGuess { preset, basis, via, group, direct: n_direct, conflict });

    if let Some((p, true)) = ev.get(&num) {
        return guess(Some(p.clone()), "map_report", vec![], vec![]);
    }
    let tally = |confirmed: bool| -> (FxMap<&str, Vec<u32>>, Vec<&str>) {
        let mut by: FxMap<&str, Vec<u32>> = map();
        let mut order = Vec::new();
        for &m in &members {
            if let Some((p, _)) = ev.get(&m).filter(|(_, c)| *c == confirmed) {
                by.entry(p.as_str()).or_insert_with(|| {
                    order.push(p.as_str());
                    Vec::new()
                }).push(m);
            }
        }
        (by, order)
    };
    let via = |ns: &[u32]| ns.iter().take(5).map(|&n| node_id(n)).collect::<Vec<_>>();
    let (confirmed, order) = tally(true);
    match order.len() {
        0 => {}
        1 => return guess(Some(order[0].to_string()), "radio_contact", via(&confirmed[order[0]]), vec![]),
        _ => {
            let mut c: Vec<(String, usize)> = order.iter().map(|p| (p.to_string(), confirmed[p].len())).collect();
            c.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            return guess(None, "conflict", vec![], c);
        }
    }
    if let Some((p, false)) = ev.get(&num) {
        return guess(Some(p.clone()), "channel_name", vec![], vec![]);
    }
    let (named, order) = tally(false);
    // The default name most of the group was heard on.
    let best = order.iter().max_by_key(|p| named[*p].len())?;
    guess(Some(best.to_string()), "radio_contact_channel_name", via(&named[*best]), vec![])
}
