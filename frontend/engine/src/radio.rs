//! A node's region and LoRa preset, deduced from where its packets were
//! heard: the MQTT topic root (region) and the channel name (preset). One
//! node can be heard on several topics and channel names, because each
//! gateway uplinks with its own configuration; every combination is listed.
//! A node's own map report states the region exactly, and the preset only
//! when it also reports a default channel (`Reported::preset_confirmed`).

use serde::Serialize;

use crate::row::{ty, Interner, Row};
use crate::util::{iso, map, set, FxMap, FxSet};

/// Meshtastic's modem presets by their default channel names (the name a
/// channel gets when left unnamed), plus long-form spellings seen in use.
const PRESETS: &[(&str, &str)] = &[
    ("LongFast", "LONG_FAST"),
    ("LongSlow", "LONG_SLOW"),
    ("VLongSlow", "VERY_LONG_SLOW"),
    ("VeryLongSlow", "VERY_LONG_SLOW"),
    ("MediumSlow", "MEDIUM_SLOW"),
    ("MediumFast", "MEDIUM_FAST"),
    ("MediumTurbo", "MEDIUM_TURBO"),
    ("ShortSlow", "SHORT_SLOW"),
    ("ShortFast", "SHORT_FAST"),
    ("ShortTurbo", "SHORT_TURBO"),
    ("LongMod", "LONG_MODERATE"),
    ("LongModerate", "LONG_MODERATE"),
    ("LongTurbo", "LONG_TURBO"),
    ("LiteFast", "LITE_FAST"),
    ("LiteSlow", "LITE_SLOW"),
    ("NarrowFast", "NARROW_FAST"),
    ("NarrowSlow", "NARROW_SLOW"),
    ("TinyFast", "TINY_FAST"),
    ("TinySlow", "TINY_SLOW"),
];

/// The preset a channel name stands for, if it is a preset's default name
/// (case-insensitive); custom channel names say nothing about the preset.
pub fn preset_of(channel: &str) -> Option<&'static str> {
    PRESETS.iter().find(|(name, _)| name.eq_ignore_ascii_case(channel)).map(|&(_, p)| p)
}

/// The LoRa regions an MQTT topic root allows. The region is the segment
/// after "msh"; in Norway (".../EU_868/NO/...") that root is used for both
/// EU_868 and EU_N_868.
pub fn regions_of(topic: &str) -> Vec<String> {
    let segs: Vec<&str> = topic.split('/').collect();
    match segs.as_slice() {
        [_, "EU_868", "NO", ..] => vec!["EU_868".into(), "EU_N_868".into()],
        [_, region, ..] if !region.is_empty() => vec![(*region).to_string()],
        _ => vec![],
    }
}

/// One way the node was heard: a topic root and channel name.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct HeardAs {
    pub topic: String,
    pub regions: Vec<String>, // possible LoRa regions (empty: unknown)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub preset: Option<&'static str>, // None: unknown (custom channel name)
    pub receptions: usize,
    pub last_at: String,
}

/// The node's own map report (exact).
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Reported {
    #[serde(skip_serializing_if = "String::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub region: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub modem_preset: String,
    /// The preset is confirmed in use (has_default_channel). Without it the
    /// node may run a custom modem config: firmware still reports the stored
    /// preset, LONG_FAST unless changed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub preset_confirmed: bool,
    pub at: String,
}

#[derive(Serialize, Debug, PartialEq, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Radio {
    pub heard_as: Vec<HeardAs>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub reported: Option<Reported>,
    /// Channels it was seen on (D-064).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub channels: Vec<crate::channels::ChannelUse>,
    /// Its modem preset as far as the window shows (D-064).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub preset: Option<crate::channels::PresetGuess>,
    /// As a gateway: the MQTT topic roots it uplinked under (D-090).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<_>", optional))]
    pub uplink_topics: Vec<TopicUse>,
}

/// A topic root a gateway uplinked under: distinct receptions and the last one.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct TopicUse {
    pub topic: String,
    pub regions: Vec<String>,
    pub receptions: usize,
    pub last_at: String,
}

/// uplinked: the window's rows the node uplinked as a gateway. Most
/// gateways use one root; several mean its configuration changed or it
/// publishes to several brokers. Busiest first.
pub fn uplink_topics(uplinked: &[&Row], i: &Interner) -> Vec<TopicUse> {
    let mut groups: FxMap<u32, (FxSet<u64>, i64)> = map();
    for &r in uplinked {
        if r.topic == 0 {
            continue;
        }
        let g = groups.entry(r.topic).or_insert_with(|| (set(), r.t));
        g.0.insert(r.ok);
        g.1 = g.1.max(r.t);
    }
    let mut out: Vec<TopicUse> = groups
        .into_iter()
        .map(|(t, (rx, last))| {
            let topic = i.s(t).to_string();
            TopicUse { regions: regions_of(&topic), topic, receptions: rx.len(), last_at: iso(last) }
        })
        .collect();
    out.sort_unstable_by(|a, b| b.receptions.cmp(&a.receptions).then(a.topic.cmp(&b.topic)));
    out
}

/// own: the window's rows originated by the node. Map reports are the
/// node's own MQTT messages, not receptions, so they only feed `reported`.
pub fn radio(own: &[&Row], i: &Interner) -> Radio {
    let mut groups: FxMap<(u32, u32), (FxSet<u64>, i64)> = map();
    let mut order: Vec<(u32, u32)> = Vec::new();
    let mut latest_report: Option<&Row> = None;
    for &r in own {
        if r.ty == ty::MAPREPORT {
            if r.map_report().is_some() && latest_report.is_none_or(|l| (r.t, r.id) > (l.t, l.id)) {
                latest_report = Some(r);
            }
            continue;
        }
        if r.topic == 0 {
            continue; // rows stored before topics were recorded
        }
        let k = (r.topic, r.channel);
        let g = groups.entry(k).or_insert_with(|| {
            order.push(k);
            (set(), r.t)
        });
        g.0.insert(r.ok);
        g.1 = g.1.max(r.t);
    }
    let mut heard_as: Vec<HeardAs> = order
        .into_iter()
        .map(|k| {
            let (rx, last) = &groups[&k];
            let topic = i.s(k.0).to_string();
            let channel = (k.1 != 0).then(|| i.s(k.1).to_string());
            HeardAs { regions: regions_of(&topic), preset: channel.as_deref().and_then(preset_of), topic, channel, receptions: rx.len(), last_at: iso(*last) }
        })
        .collect();
    heard_as.sort_unstable_by(|a, b| b.receptions.cmp(&a.receptions).then(a.topic.cmp(&b.topic)));
    let reported = latest_report.map(|r| {
        let m = r.map_report().unwrap();
        Reported { region: i.s(m.region).to_string(), modem_preset: i.s(m.preset).to_string(), preset_confirmed: m.default_channel, at: iso(r.t) }
    });
    Radio { heard_as, reported, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_from_default_channel_names_only() {
        assert_eq!(preset_of("NarrowFast"), Some("NARROW_FAST"));
        assert_eq!(preset_of("longfast"), Some("LONG_FAST"));
        assert_eq!(preset_of("LongMod"), Some("LONG_MODERATE"));
        assert_eq!(preset_of("Custom"), None);
        assert_eq!(preset_of("OWLCHAT"), None);
    }

    #[test]
    fn regions_from_topic_roots() {
        assert_eq!(regions_of("msh/EU_868/NO/Trøndelag"), vec!["EU_868", "EU_N_868"], "Norway uses EU_868 for both");
        assert_eq!(regions_of("msh/EU_868/NO"), vec!["EU_868", "EU_N_868"]);
        assert_eq!(regions_of("msh/EU_N_868"), vec!["EU_N_868"]);
        assert_eq!(regions_of("msh/EU_868/SE"), vec!["EU_868"]);
        assert_eq!(regions_of("msh/US"), vec!["US"]);
        assert_eq!(regions_of("msh"), Vec::<String>::new());
    }

    #[test]
    fn every_way_a_node_was_heard_and_its_own_report() {
        let mut i = Interner::default();
        let text = r#"[
          {"i":1,"t":10,"b":"x","g":7,"s":5,"c":"NarrowFast","y":"text","l":"0000000000000001","o":"0000000000000011","sg":"unsigned","tp":"msh/EU_868/NO/Trøndelag"},
          {"i":2,"t":20,"b":"x","g":8,"s":5,"c":"NarrowFast","y":"text","l":"0000000000000001","o":"0000000000000012","sg":"unsigned","tp":"msh/EU_868/NO/Trøndelag"},
          {"i":3,"t":30,"b":"x","g":9,"s":5,"c":"Custom","y":"text","l":"0000000000000002","o":"0000000000000013","sg":"unsigned","tp":"msh/EU_N_868"},
          {"i":4,"t":40,"b":"x","g":5,"s":5,"c":"NarrowFast","y":"mapreport","l":"0000000000000003","o":"0000000000000014","sg":"not-applicable","tp":"msh/EU_868/NO","mr":{"region":"EU_N_868","modem_preset":"NARROW_FAST"}}
        ]"#;
        let rows: Vec<Row> = serde_json::from_str::<Vec<crate::row::JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let r = radio(&refs, &i);
        assert_eq!(r.heard_as.len(), 2, "the map report is not a reception");
        assert_eq!((r.heard_as[0].topic.as_str(), r.heard_as[0].preset, r.heard_as[0].receptions), ("msh/EU_868/NO/Trøndelag", Some("NARROW_FAST"), 2));
        assert_eq!(r.heard_as[0].regions, vec!["EU_868", "EU_N_868"]);
        assert_eq!((r.heard_as[1].regions.clone(), r.heard_as[1].preset), (vec!["EU_N_868".to_string()], None));
        let rep = r.reported.unwrap();
        assert_eq!((rep.region.as_str(), rep.modem_preset.as_str()), ("EU_N_868", "NARROW_FAST"));
    }

    #[test]
    fn a_gateways_uplink_topics_busiest_first() {
        let mut i = Interner::default();
        let text = r#"[
          {"i":1,"t":10,"b":"x","g":7,"s":5,"y":"text","l":"0000000000000001","o":"0000000000000011","sg":"unsigned","tp":"msh/EU_868/NO/Trøndelag"},
          {"i":2,"t":20,"b":"x","g":7,"s":6,"y":"text","l":"0000000000000002","o":"0000000000000012","sg":"unsigned","tp":"msh/EU_868/NO/Trøndelag"},
          {"i":3,"t":30,"b":"x","g":7,"s":6,"y":"text","l":"0000000000000003","o":"0000000000000013","sg":"unsigned","tp":"msh/EU_868"},
          {"i":4,"t":40,"b":"x","g":7,"s":6,"y":"text","l":"0000000000000004","o":"0000000000000014","sg":"unsigned"}
        ]"#;
        let rows: Vec<Row> = serde_json::from_str::<Vec<crate::row::JRow>>(text).unwrap().into_iter().map(|r| r.into_row(&mut i)).collect();
        let refs: Vec<&Row> = rows.iter().collect();
        let t = uplink_topics(&refs, &i);
        let got: Vec<(&str, usize)> = t.iter().map(|x| (x.topic.as_str(), x.receptions)).collect();
        assert_eq!(got, vec![("msh/EU_868/NO/Trøndelag", 2), ("msh/EU_868", 1)], "rows without a topic are left out");
        assert_eq!(t[1].regions, vec!["EU_868"]);
    }
}
