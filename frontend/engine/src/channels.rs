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
//! name on any preset). One inference (`infer`) serves the node panel
//! and health alike.

use serde::Serialize;

use crate::graph::Ev;
use crate::radio::preset_of;
use crate::row::{ty, Interner, Row};
use crate::util::{map, node_id, set, FxMap, FxSet};

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

/// Pairs of nodes that heard each other over the air in `rows`. hops:
/// traceroute_hops of the rows.
fn radio_contacts(rows: &[&Row], hops: &[crate::graph::Sample]) -> Vec<(u32, u32)> {
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
    out.extend(hops.iter().filter(|s| s.ev == Ev::Traceroute && s.snr != Some(0.0)).map(|s| (s.src, s.dst)));
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

/// The window's radio groups and every node's own preset evidence: the
/// same for every node, so made once per build (views::Built).
#[derive(Default)]
pub struct PresetIndex {
    ev: FxMap<u32, (String, bool)>,
    contacts: Vec<(u32, u32)>,
    /// Each node in a radio contact, with its group's root.
    root: FxMap<u32, u32>,
    /// Every group's members by root, in node order.
    groups: FxMap<u32, Vec<u32>>,
    /// Every group's members' evidence by root: preset -> members (in node
    /// order), confirmed and named apart.
    confirmed: FxMap<u32, FxMap<String, Vec<u32>>>,
    named: FxMap<u32, FxMap<String, Vec<u32>>>,
}

impl PresetIndex {
    /// hops: traceroute_hops of the rows.
    pub fn new(rows: &[&Row], hops: &[crate::graph::Sample], i: &Interner) -> Self {
        let contacts = radio_contacts(rows, hops);
        let mut parent: FxMap<u32, u32> = map();
        for &(a, b) in &contacts {
            union(&mut parent, a, b);
        }
        let keys: Vec<u32> = parent.keys().copied().collect();
        let root: FxMap<u32, u32> = keys.into_iter().map(|n| (n, find(&mut parent, n))).collect();
        let mut groups: FxMap<u32, Vec<u32>> = map();
        for (&n, &r) in &root {
            groups.entry(r).or_default().push(n);
        }
        let ev = evidence(rows, i);
        let (mut confirmed, mut named): (FxMap<u32, FxMap<String, Vec<u32>>>, FxMap<u32, FxMap<String, Vec<u32>>>) = (map(), map());
        for (r, g) in groups.iter_mut() {
            g.sort_unstable();
            for &n in g.iter() {
                if let Some((p, c)) = ev.get(&n) {
                    let by = if *c { &mut confirmed } else { &mut named };
                    by.entry(*r).or_default().entry(p.clone()).or_default().push(n);
                }
            }
        }
        PresetIndex { ev, contacts, root, groups, confirmed, named }
    }
}

/// A node's preset as the window's evidence ranks it, strongest first
/// (§6.13): its own confirmed map report; its radio group's confirmed
/// reports, all agreeing; a default channel name it was heard on most (a
/// hint); the default name most of its group was heard on (a hint). The
/// one inference behind the node panel (preset_guess) and health's preset
/// rule, so the two never disagree.
pub struct Inferred<'x> {
    /// None on conflict.
    pub preset: Option<&'x str>,
    /// As PresetGuess::basis.
    pub basis: &'static str,
    /// The group members whose evidence it rests on, in node order (radio contact bases).
    pub from: &'x [u32],
    /// Presets and how many group members each, on conflict.
    pub conflict: Vec<(String, usize)>,
}

/// None without evidence.
pub fn infer(num: u32, ix: &PresetIndex) -> Option<Inferred<'_>> {
    fn it<'x>(preset: Option<&'x str>, basis: &'static str, from: &'x [u32], conflict: Vec<(String, usize)>) -> Option<Inferred<'x>> {
        Some(Inferred { preset, basis, from, conflict })
    }
    match ix.ev.get(&num) {
        Some((p, true)) => return it(Some(p), "map_report", &[], vec![]),
        Some((p, false)) => {
            // Its own hint yields only to confirmed reports of its group (below).
            if ix.root.get(&num).and_then(|r| ix.confirmed.get(r)).is_none_or(|c| c.is_empty()) {
                return it(Some(p), "channel_name", &[], vec![]);
            }
        }
        None => {}
    }
    // Its own evidence is never among its group's: a confirmed node returned
    // above, and a node with a hint is not in the named tally consulted below.
    let root = ix.root.get(&num)?;
    if let Some(c) = ix.confirmed.get(root).filter(|c| !c.is_empty()) {
        if c.len() == 1 {
            let (p, from) = c.iter().next().unwrap();
            return it(Some(p), "radio_contact", from, vec![]);
        }
        let mut v: Vec<(String, usize)> = c.iter().map(|(p, m)| (p.clone(), m.len())).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        return it(None, "conflict", &[], v);
    }
    // The default name most of the group was heard on (ties: the first by name).
    let (p, from) = ix.named.get(root)?.iter().max_by(|a, b| a.1.len().cmp(&b.1.len()).then(b.0.cmp(a.0)))?;
    it(Some(p), "radio_contact_channel_name", from, vec![])
}

/// What the window says about `num`'s modem preset (`infer`, with its radio
/// contacts for the panel); None without evidence.
pub fn preset_guess(num: u32, ix: &PresetIndex) -> Option<PresetGuess> {
    let inferred = infer(num, ix)?;
    let mut direct: FxSet<u32> = set();
    for &(a, b) in &ix.contacts {
        if a == num {
            direct.insert(b);
        } else if b == num {
            direct.insert(a);
        }
    }
    let group = ix.root.get(&num).map_or(0, |r| ix.groups[r].len() - 1);
    // Direct contacts first, then by node number: stable, and the nearest evidence leads.
    let mut from: Vec<u32> = inferred.from.iter().copied().filter(|&n| n != num).collect();
    from.sort_by_key(|n| (!direct.contains(n), *n));
    let via = from.iter().take(5).map(|&n| node_id(n)).collect();
    Some(PresetGuess { preset: inferred.preset.map(str::to_string), basis: inferred.basis, via, group, direct: direct.len(), conflict: inferred.conflict })
}
