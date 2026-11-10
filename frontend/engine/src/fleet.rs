//! What the mesh's nodes are (D-196): the nodes heard in the window counted
//! by role, hardware model, modem preset and firmware, per region (the
//! Regions panel, regions.rs). The whole mesh is counted by the server over
//! everything kept, by these rules as far as its hourly summaries hold them
//! (D-198, backend storage/fleet.go): change both together.
//!
//! - Role and hardware: the node's identity (its latest NodeInfo, else its
//!   own map report); enum names as sent, humanised by the UI.
//! - Preset: what the node panel shows (channels::infer): its own map report
//!   when a default channel proves it, else what channel names and radio
//!   contact imply; "unknown" without evidence or when the evidence conflicts.
//! - Firmware: the version of its latest map report that states one, grouped
//!   by major.minor. Most nodes send no map report, so the rest get the
//!   generation the window shows, never an exact version: a node id derived
//!   from its key is firmware 2.8 or later, one from its hardware while it
//!   announces a key 2.7 or earlier (D-142); packets sent without a hop start
//!   are firmware before 2.3. Otherwise "unknown".

use serde::Serialize;

use crate::channels::{infer, PresetIndex};
use crate::row::{ty, Interner, Row};
use crate::util::{map, FxMap};
use crate::views::Node;

/// One value and how many nodes have it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS), ts(rename = "FleetCount"))]
pub struct Count {
    pub name: String,
    pub nodes: usize,
}

/// Nodes on one firmware line, or of one inferred generation.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct FirmwareCount {
    /// "reported": the major.minor of the version its map report states;
    /// inferred, never a version: "key" (2.8 or later), "hardware" (2.7 or
    /// earlier), "no_hop_start" (before 2.3); "unknown".
    #[cfg_attr(test, ts(type = "'reported' | 'key' | 'hardware' | 'no_hop_start' | 'unknown'"))]
    pub basis: &'static str,
    /// The major.minor, e.g. "2.7" (reported only).
    #[serde(skip_serializing_if = "String::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub version: String,
    pub nodes: usize,
    /// The exact versions within it, newest first (reported only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub versions: Vec<Count>,
}

/// The breakdown of a set of nodes. Each list: most nodes first, then by
/// name, "unknown" last; firmware: reported lines newest first, then the
/// inferred generations newest first, then "unknown".
#[derive(Serialize, Debug, Default, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Fleet {
    /// Nodes counted: those heard in the window (not only named by others).
    pub nodes: usize,
    pub roles: Vec<Count>,
    pub hardware: Vec<Count>,
    pub presets: Vec<Count>,
    pub firmware: Vec<FirmwareCount>,
}

pub const UNKNOWN: &str = "unknown";

/// What the window's rows say about each node's firmware.
#[derive(Default)]
pub struct FirmwareIndex<'r> {
    /// The latest map report stating a version, by node.
    reported: FxMap<u32, &'r Row>,
    /// Nodes that sent packets (other than map reports): true when one
    /// carried a hop start.
    hop_start: FxMap<u32, bool>,
}

impl<'r> FirmwareIndex<'r> {
    pub fn new(rows: &[&'r Row]) -> Self {
        let mut ix = FirmwareIndex { reported: map(), hop_start: map() };
        for &r in rows {
            if r.ty == ty::MAPREPORT {
                if r.map_report().is_some_and(|m| m.firmware != 0) && ix.reported.get(&r.src).is_none_or(|p| (r.t, r.id) > (p.t, p.id)) {
                    ix.reported.insert(r.src, r);
                }
            } else {
                *ix.hop_start.entry(r.src).or_insert(false) |= r.hs.is_some();
            }
        }
        ix
    }

    /// Its firmware: (basis, exact version for "reported").
    fn of<'i>(&self, x: &Node, i: &'i Interner) -> (&'static str, &'i str) {
        if let Some(m) = self.reported.get(&x.num).and_then(|r| r.map_report()) {
            return ("reported", i.s(m.firmware));
        }
        match x.identity.as_ref().and_then(|id| id.node_id_from) {
            Some("key") => ("key", ""),
            Some(_) => ("hardware", ""),
            None if self.hop_start.get(&x.num) == Some(&false) => ("no_hop_start", ""),
            None => (UNKNOWN, ""),
        }
    }
}

/// Order of the inferred generations, newest first, then unknown.
const INFERRED: [&str; 4] = ["key", "hardware", "no_hop_start", UNKNOWN];

/// Counts nodes into a Fleet.
#[derive(Default)]
pub struct Tally {
    nodes: usize,
    roles: FxMap<String, usize>,
    hardware: FxMap<String, usize>,
    presets: FxMap<String, usize>,
    /// Exact reported versions, and inferred generations by basis.
    versions: FxMap<String, usize>,
    inferred: FxMap<&'static str, usize>,
}

fn or_unknown(s: &str) -> &str {
    if s.is_empty() || s == "UNSET" {
        UNKNOWN
    } else {
        s
    }
}

/// A version's numbers, for ordering ("2.7.15" before "2.7.9"); text that
/// is no number sorts first.
fn numbers(v: &str) -> Vec<u32> {
    v.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// "2.7.15" -> "2.7".
fn major_minor(v: &str) -> &str {
    v.match_indices('.').nth(1).map_or(v, |(k, _)| &v[..k])
}

fn sorted(m: FxMap<String, usize>) -> Vec<Count> {
    let mut v: Vec<Count> = m.into_iter().map(|(name, nodes)| Count { name, nodes }).collect();
    v.sort_unstable_by(|a, b| (a.name == UNKNOWN).cmp(&(b.name == UNKNOWN)).then(b.nodes.cmp(&a.nodes)).then(a.name.cmp(&b.name)));
    v
}

impl Tally {
    /// One node's facts (Facts::of).
    pub fn add(&mut self, f: &Facts) {
        self.nodes += 1;
        *self.roles.entry(f.role.clone()).or_insert(0) += 1;
        *self.hardware.entry(f.hardware.clone()).or_insert(0) += 1;
        *self.presets.entry(f.preset.clone()).or_insert(0) += 1;
        if f.firmware.0 == "reported" {
            *self.versions.entry(f.firmware.1.clone()).or_insert(0) += 1;
        } else {
            *self.inferred.entry(f.firmware.0).or_insert(0) += 1;
        }
    }

    pub fn finish(self) -> Fleet {
        let mut lines: FxMap<String, Vec<Count>> = map();
        for (v, nodes) in self.versions {
            lines.entry(major_minor(&v).to_string()).or_default().push(Count { name: v, nodes });
        }
        let mut firmware: Vec<FirmwareCount> = lines
            .into_iter()
            .map(|(version, mut versions)| {
                versions.sort_unstable_by(|a, b| numbers(&b.name).cmp(&numbers(&a.name)).then(a.name.cmp(&b.name)));
                FirmwareCount { basis: "reported", nodes: versions.iter().map(|c| c.nodes).sum(), version, versions }
            })
            .collect();
        firmware.sort_unstable_by(|a, b| numbers(&b.version).cmp(&numbers(&a.version)).then(a.version.cmp(&b.version)));
        firmware.extend(INFERRED.iter().filter_map(|&basis| self.inferred.get(basis).map(|&nodes| FirmwareCount { basis, version: String::new(), nodes, versions: vec![] })));
        Fleet { nodes: self.nodes, roles: sorted(self.roles), hardware: sorted(self.hardware), presets: sorted(self.presets), firmware }
    }
}

/// One node's values, counted for its region.
pub struct Facts {
    role: String,
    hardware: String,
    preset: String,
    /// (basis, exact version when reported)
    firmware: (&'static str, String),
}

impl Facts {
    /// None for a node only named by others: it was not heard.
    pub fn of(x: &Node, presets: &PresetIndex, fw: &FirmwareIndex, i: &Interner) -> Option<Facts> {
        if x.status != "observed" {
            return None;
        }
        let id = x.identity.as_ref();
        let preset = infer(x.num, presets).and_then(|p| p.preset).unwrap_or(UNKNOWN);
        let (basis, version) = fw.of(x, i);
        Some(Facts {
            role: or_unknown(id.map_or("", |id| id.role.as_str())).to_string(),
            hardware: or_unknown(id.map_or("", |id| id.hw_model.as_str())).to_string(),
            preset: preset.to_string(),
            firmware: (basis, version.to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_group_by_line_newest_first_and_inferred_generations_follow() {
        let mut t = Tally::default();
        let f = |role: &str, fw: (&'static str, &str)| Facts { role: role.into(), hardware: "HELTEC_V3".into(), preset: "LONG_FAST".into(), firmware: (fw.0, fw.1.into()) };
        for x in [
            f("CLIENT", ("reported", "2.7.9")),
            f("CLIENT", ("reported", "2.7.15")),
            f("ROUTER", ("reported", "2.7.15")),
            f(UNKNOWN, ("reported", "2.10.0")),
            f("CLIENT", ("reported", "2.6.11")),
            f("CLIENT", (UNKNOWN, "")),
            f("CLIENT", ("no_hop_start", "")),
            f("CLIENT", ("key", "")),
        ] {
            t.add(&x);
        }
        let fleet = t.finish();
        assert_eq!(fleet.nodes, 8);
        let lines: Vec<(&str, &str, usize)> = fleet.firmware.iter().map(|c| (c.basis, c.version.as_str(), c.nodes)).collect();
        assert_eq!(lines, [("reported", "2.10", 1), ("reported", "2.7", 3), ("reported", "2.6", 1), ("key", "", 1), ("no_hop_start", "", 1), (UNKNOWN, "", 1)]);
        assert_eq!(fleet.firmware[1].versions, [Count { name: "2.7.15".into(), nodes: 2 }, Count { name: "2.7.9".into(), nodes: 1 }]);
        // Most first, unknown last however many.
        assert_eq!(fleet.roles.iter().map(|c| (c.name.as_str(), c.nodes)).collect::<Vec<_>>(), [("CLIENT", 6), ("ROUTER", 1), (UNKNOWN, 1)]);
    }

    #[test]
    fn unset_and_empty_are_unknown() {
        assert_eq!((or_unknown(""), or_unknown("UNSET"), or_unknown("RAK4631")), (UNKNOWN, UNKNOWN, "RAK4631"));
        assert_eq!((major_minor("2.7.15"), major_minor("2.7")), ("2.7", "2.7"));
    }
}
