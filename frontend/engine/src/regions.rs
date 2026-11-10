//! Region summaries (D-194): the window's mesh per landsdel, for the Regions
//! panel. Nodes count for the region their reported position or estimate
//! lies in (landsdel::Regions, as the map's Regions layer draws them); what
//! gateways uplinked under a topic root naming a region counts for it too,
//! as the long-term trends count it. Each region also gets its nodes'
//! breakdown by role, hardware, preset and firmware (fleet.rs, D-196); the
//! whole mesh's is the server's, over everything kept (D-198).

use serde::Serialize;

use crate::channels::PresetIndex;
use crate::fleet::{Facts, FirmwareIndex, Fleet, Tally};
use crate::landsdel::{region_of_topic, Regions, NAMES};
use crate::row::{Interner, Row};
use crate::util::{map, FxMap, FxSet};
use crate::views::Node;

#[derive(Serialize, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RegionSummary {
    pub name: &'static str,
    /// Nodes placed in it (a reported position or an estimate), and their ids.
    pub nodes: usize,
    pub members: Vec<String>,
    pub routers: usize,
    pub bases: usize,
    pub gateways: usize,
    /// Distinct senders and gateways of rows uplinked under a topic root naming it.
    pub topic_nodes: usize,
    pub topic_gateways: usize,
    /// The median of its nodes' median channel utilisation, and how many reported one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub ch_util: Option<f64>,
    pub ch_util_nodes: usize,
    /// The node reporting the busiest channel, and its median.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub busiest: Option<(String, f64)>,
    /// Its nodes heard in the window by role, hardware, preset and firmware (D-196).
    pub fleet: Fleet,
}

#[derive(Serialize, Debug, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RegionsView {
    /// The outlines are in: false until the worker has handed them over.
    pub loaded: bool,
    pub regions: Vec<RegionSummary>,
    /// Placed nodes outside every region (abroad, or far out at sea).
    pub outside: usize,
}

fn median(v: &mut [f64]) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable_by(f64::total_cmp);
    let k = v.len() / 2;
    Some(if v.len() % 2 == 1 { v[k] } else { f64::midpoint(v[k - 1], v[k]) })
}

/// The window's regions. `nodes`: the build's (snapshot and beyond);
/// `presets`: the build's preset index.
pub fn regions<'a>(regions: &Regions, nodes: impl Iterator<Item = &'a Node>, rows: &[&Row], presets: &PresetIndex, i: &Interner) -> RegionsView {
    if regions.is_empty() {
        return RegionsView::default();
    }
    let mut out: Vec<RegionSummary> = NAMES.iter().map(|&name| RegionSummary { name, ..Default::default() }).collect();
    let at = |name: &str| NAMES.iter().position(|&n| n == name).unwrap();
    let mut util: Vec<Vec<f64>> = vec![Vec::new(); NAMES.len()];
    let mut outside = 0;
    let firmware = FirmwareIndex::new(rows);
    let mut fleets: Vec<Tally> = NAMES.iter().map(|_| Tally::default()).collect();
    for x in nodes {
        let Some((lat, lon)) = x.position.as_ref().map(|p| (p.lat, p.lon)).or_else(|| x.estimate.as_ref().map(|e| (e.lat, e.lon))) else { continue };
        let Some(name) = regions.region_at(lat, lon) else {
            outside += 1;
            continue;
        };
        if let Some(f) = Facts::of(x, presets, &firmware, i) {
            fleets[at(name)].add(&f);
        }
        let r = &mut out[at(name)];
        r.nodes += 1;
        r.members.push(x.id.clone());
        let role = x.identity.as_ref().map_or("", |id| id.role.as_str());
        if crate::roles::is_router(role) {
            r.routers += 1;
        } else if crate::roles::is_base(role) {
            r.bases += 1;
        }
        if x.is_gateway {
            r.gateways += 1;
        }
        if let Some(c) = x.ch_util {
            util[at(name)].push(c);
            if r.busiest.as_ref().is_none_or(|b| c > b.1) {
                r.busiest = Some((x.id.clone(), c));
            }
        }
    }
    // Rows by the region their topic root names: interned once per topic.
    let mut topic_region: FxMap<u32, Option<usize>> = map();
    let mut senders: Vec<FxSet<u32>> = vec![FxSet::default(); NAMES.len()];
    let mut gws: Vec<FxSet<u32>> = vec![FxSet::default(); NAMES.len()];
    for r in rows {
        let Some(k) = *topic_region.entry(r.topic).or_insert_with(|| region_of_topic(i.s(r.topic)).map(at)) else { continue };
        senders[k].insert(r.src);
        if let Some(g) = r.gw {
            gws[k].insert(g);
        }
    }
    for ((k, r), fleet) in out.iter_mut().enumerate().zip(fleets) {
        r.fleet = fleet.finish();
        r.members.sort_unstable();
        r.topic_nodes = senders[k].len();
        r.topic_gateways = gws[k].len();
        r.ch_util_nodes = util[k].len();
        r.ch_util = median(&mut util[k]);
    }
    RegionsView { loaded: true, regions: out, outside }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::JRow;

    fn placed(n: u32, role: &str, lat: f64, lon: f64, gateway: bool, ch: Option<f64>) -> Node {
        let mut x = Node::new(n);
        x.identity = Some(crate::views::Identity { role: role.into(), ..Default::default() });
        x.position = Some(crate::views::Position { lat, lon, alt: None, precision_bits: 32, precision_known: true, signature: "unsigned".into(), observed_at: "2026-11-05T00:00:00Z".into(), source: "position".into() });
        x.is_gateway = gateway;
        x.ch_util = ch;
        x
    }

    #[test]
    fn nodes_and_topics_count_for_their_regions() {
        let rs = crate::landsdel::tests::fixture();
        let nodes = [
            placed(1, "ROUTER", 63.43, 10.39, true, Some(30.0)), // Trondheim
            placed(2, "CLIENT_BASE", 63.40, 10.40, false, Some(10.0)),
            placed(3, "CLIENT", 59.91, 10.75, false, None), // Oslo
            placed(4, "CLIENT", 55.0, 3.0, false, None),    // the North Sea: outside
        ];
        let mut i = Interner::default();
        let row = |i: &mut Interner, k: u64, src: u32, gw: u32, topic: &str| {
            serde_json::from_str::<JRow>(&format!(r#"{{"i":{k},"t":{k},"b":"x","g":{gw},"s":{src},"y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","tp":"{topic}"}}"#)).unwrap().into_row(i)
        };
        let rows = [row(&mut i, 1, 3, 1, "msh/EU_868/NO/Trøndelag"), row(&mut i, 2, 2, 1, "msh/EU_868/NO/Trøndelag"), row(&mut i, 3, 3, 9, "msh/EU_868/NO/Østlandet")];
        let refs: Vec<&Row> = rows.iter().collect();
        let presets = PresetIndex::new(&refs, &[], &i);
        let v = regions(&rs, nodes.iter(), &refs, &presets, &i);
        assert!(v.loaded);
        assert_eq!(v.outside, 1);
        let t = v.regions.iter().find(|r| r.name == "Trøndelag").unwrap();
        assert_eq!((t.nodes, t.routers, t.bases, t.gateways, t.topic_nodes, t.topic_gateways), (2, 1, 1, 1, 2, 1));
        assert_eq!((t.ch_util, t.busiest.clone()), (Some(20.0), Some(("!00000001".to_string(), 30.0))));
        let o = v.regions.iter().find(|r| r.name == "Østlandet").unwrap();
        assert_eq!((o.nodes, o.members.clone(), o.topic_nodes, o.ch_util), (1, vec!["!00000003".to_string()], 1, None));
        assert!(!regions(&Regions::default(), nodes.iter(), &refs, &presets, &i).loaded);
    }

    /// (name, nodes) pairs of a breakdown list.
    fn counts(c: &[crate::fleet::Count]) -> Vec<(&str, usize)> {
        c.iter().map(|c| (c.name.as_str(), c.nodes)).collect()
    }

    /// (basis, major.minor, nodes) of a firmware breakdown.
    fn lines(f: &crate::fleet::Fleet) -> Vec<(&str, &str, usize)> {
        f.firmware.iter().map(|c| (c.basis, c.version.as_str(), c.nodes)).collect()
    }

    #[test]
    fn nodes_break_down_by_role_hardware_preset_and_firmware_per_region() {
        let rs = crate::landsdel::tests::fixture();
        let with = |mut x: Node, hw: &str, from: Option<&'static str>| {
            let id = x.identity.as_mut().unwrap();
            id.hw_model = hw.into();
            id.node_id_from = from;
            x
        };
        let mut unplaced = Node::new(5);
        unplaced.identity = Some(crate::views::Identity { role: "CLIENT".into(), hw_model: "UNSET".into(), node_id_from: Some("hardware"), ..Default::default() });
        let mut named_only = placed(6, "ROUTER", 63.41, 10.41, false, None);
        named_only.status = "referenced";
        let nodes = [
            with(placed(1, "ROUTER", 63.43, 10.39, true, None), "RAK4631", None),               // Trondheim
            with(placed(2, "CLIENT_BASE", 63.40, 10.40, false, None), "HELTEC_V3", Some("key")), // Trondheim
            with(placed(3, "CLIENT", 59.91, 10.75, false, None), "HELTEC_V3", None),             // Oslo
            with(placed(4, "CLIENT", 55.0, 3.0, false, None), "T_ECHO", None),                    // the North Sea: outside
            unplaced,
            named_only,
        ];
        let mut i = Interner::default();
        let row = |i: &mut Interner, k: u64, src: u32, extra: &str| {
            serde_json::from_str::<JRow>(&format!(r#"{{"i":{k},"t":{k},"b":"x","g":{src},"s":{src},"l":"{k:016x}","o":"{k:016x}",{extra}}}"#)).unwrap().into_row(i)
        };
        let rows = [
            // 1: a map report proving its preset with a default channel, and its version (newest counts).
            row(&mut i, 1, 1, r#""y":"mapreport","sg":"not-applicable","mr":{"modem_preset":"MEDIUM_FAST","has_default_channel":true,"firmware_version":"2.6.11"}"#),
            row(&mut i, 2, 1, r#""y":"mapreport","sg":"not-applicable","mr":{"modem_preset":"MEDIUM_FAST","has_default_channel":true,"firmware_version":"2.7.15"}"#),
            // 2: a map report without a default channel (no proof) and no version; its traffic names LongFast.
            row(&mut i, 3, 2, r#""y":"mapreport","sg":"not-applicable","mr":{"modem_preset":"MEDIUM_FAST"}"#),
            row(&mut i, 4, 2, r#""y":"text","sg":"unsigned","c":"LongFast","hs":3,"hl":3"#),
            // 3: traffic on a custom channel, without a hop start (firmware before 2.3).
            row(&mut i, 5, 3, r#""y":"text","sg":"unsigned","c":"Hytta""#),
            // 5: sends with a hop start: newer than 2.3, and its id says 2.7 or earlier.
            row(&mut i, 6, 5, r#""y":"text","sg":"unsigned","hs":3,"hl":3"#),
        ];
        let refs: Vec<&Row> = rows.iter().collect();
        let presets = PresetIndex::new(&refs, &[], &i);
        let v = regions(&rs, nodes.iter(), &refs, &presets, &i);

        let t = &v.regions.iter().find(|r| r.name == "Trøndelag").unwrap().fleet;
        assert_eq!(t.nodes, 2, "the node only named by others is not counted");
        assert_eq!(counts(&t.roles), [("CLIENT_BASE", 1), ("ROUTER", 1)]);
        assert_eq!(counts(&t.hardware), [("HELTEC_V3", 1), ("RAK4631", 1)]);
        assert_eq!(counts(&t.presets), [("LONG_FAST", 1), ("MEDIUM_FAST", 1)], "a reported preset counts only with a default channel");
        assert_eq!(lines(t), [("reported", "2.7", 1), ("key", "", 1)]);
        assert_eq!(counts(&t.firmware[0].versions), [("2.7.15", 1)], "its latest report's version");

        let o = &v.regions.iter().find(|r| r.name == "Østlandet").unwrap().fleet;
        assert_eq!((o.nodes, counts(&o.presets), lines(o)), (1, vec![("unknown", 1)], vec![("no_hop_start", "", 1)]));
        assert_eq!(v.regions.iter().find(|r| r.name == "Vestlandet").unwrap().fleet, crate::fleet::Fleet::default());
        // Nodes outside every region, or never placed, count in none (the whole mesh is the server's, D-198).
        assert_eq!(v.regions.iter().map(|r| r.fleet.nodes).sum::<usize>(), 3);
    }
}
