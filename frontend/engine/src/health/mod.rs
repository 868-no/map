//! Mesh health (D-095): known problems found in the window's rows by rules,
//! and an airtime estimate of who keeps the channel busy.
//!
//! Every rule works only from what gateways reported, so it can miss
//! things and its numbers are lower bounds; the wording says so where it
//! matters. Thresholds are constants in each rule's module so they are easy
//! to find, and re-exported here.
//!
//! One module per rule or family of rules, each adding its issues from the
//! shared `Ctx`: traceroute (flooding), hop_limit, preset (another preset
//! than the mesh's), isolated (heard only by its own gateway), admin
//! (remote-admin requests refused), gateways (unencrypted uplinks, moving
//! gateways, topic roots, D-161), downlinks (probable MQTT downlinks),
//! positions (stale or contradicted), busy_channel (channel and transmit
//! utilisation), batteries (low, falling, D-099), chatty (frequent
//! broadcasts), burst (many packets in a short time, D-209), restarts
//! (D-099), identities (shared keys, D-142, and duplicate names),
//! impersonation (D-108), silent (silent infrastructure, D-188),
//! router_roles (router role review, D-189), link_drop (router link drop,
//! D-197) and airtime (the estimate, and who causes much of it).

mod admin;
mod airtime;
mod batteries;
mod burst;
mod busy_channel;
mod chatty;
mod downlinks;
mod gateways;
mod hop_limit;
mod identities;
mod impersonation;
mod isolated;
mod link_drop;
mod positions;
mod preset;
mod restarts;
mod router_roles;
mod silent;
mod traceroute;

pub use admin::ADMIN_REFUSALS_MIN;
pub use airtime::{airtime, Airtime, NodeAirtime, StoreForwardNode, StoreForwardStats, AIRTIME_WARN_SHARE, STORE_FORWARD_SHARE};
pub use batteries::{BATTERY_FALL_PER_DAY, BATTERY_LOW, BATTERY_TREND_MIN_REPORTS, BATTERY_WARN_AT};
pub use busy_channel::{AIR_UTIL_WARN, CH_UTIL_PROBLEM, CH_UTIL_WARN};
pub use burst::{BURST_MIN, BURST_MS};
pub use chatty::{NODEINFO_PER_H, POSITION_PER_H, TELEMETRY_PER_H};
pub use hop_limit::{HOP_FLAG_FROM, HOP_MIN_PACKETS, HOP_SPARE};
pub use identities::{SHARED_KEY_MIN_SWITCHES, SHARED_KEY_OVERLAP_MS};
pub use impersonation::SPOOF_MIN;
pub use isolated::ISOLATED_MIN_PACKETS;
pub use link_drop::{
    find_link_drop, LinkChange, LinkDrop, LINK_DROP_DB, LINK_DROP_LOCAL_MS, LINK_DROP_MIN_AFTER_MS, LINK_DROP_MIN_BEFORE_MS, LINK_DROP_MIN_LINKS, LINK_DROP_MIN_PARTNERS, LINK_DROP_MIN_READINGS, LINK_DROP_REFINE_MS, LINK_DROP_STEP_MS, LINK_DROP_STILL_DB,
};
pub use restarts::RESTARTS_WARN;
pub use router_roles::{FEW_LINKS, FEW_LINKS_MIN_PACKETS, OVERLAP_MIN_NEIGHBOURS, OVERLAP_SHARE, SITE_M, SITE_MIN_BITS};
pub use silent::{gone_quiet, heard_times, usual_gap, SILENT_BATTERY_LOW, SILENT_GAP_FACTOR, SILENT_MIN_EVENTS, SILENT_MIN_MS};
pub use traceroute::{TRACEROUTE_MIN, TRACEROUTE_PROBLEM_PER_H, TRACEROUTE_WARN_PER_H};

use serde::Serialize;

use crate::channels::PresetIndex;
use crate::copies::Copies;
use crate::graph::Edge;
use crate::landsdel::Regions;
use crate::row::{ty, Interner, Row, Telemetry};
use crate::util::{map, node_id, FxMap};
use crate::views::link::LinkReadings;
use crate::views::{first_per_packet, Node};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Issue {
    pub node: String,
    pub kind: &'static str,
    /// problem, warning or notice.
    #[cfg_attr(test, ts(type = "'problem' | 'warning' | 'notice'"))]
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

#[derive(Serialize, Debug, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct Health {
    pub issues: Vec<Issue>,
    pub airtime: Airtime,
}

/// What the rules look at: health's arguments, and what it derives from
/// them once for all of them.
struct Ctx<'a> {
    /// The window's rows passing the filters.
    rows: &'a [&'a Row],
    /// The window's rows that failed decoding or verification (D-093), and
    /// the rest, unfiltered (D-188).
    invalid: Vec<&'a Row>,
    live: Vec<&'a Row>,
    nodes: &'a [Node],
    edges: &'a [Edge],
    readings: &'a LinkReadings,
    presets: &'a PresetIndex,
    i: &'a Interner,
    regions: &'a Regions,
    /// The span rates are over (see `health`).
    hours: f64,
    /// Each node's own packets, first copy each, by logical packet.
    own: FxMap<u32, FxMap<u64, &'a Row>>,
    /// The newest of the window's valid rows, Unix ms (i64::MIN with none).
    newest: i64,
}

impl Ctx<'_> {
    /// Node `n`'s own packets of type `t` that `keep` accepts.
    fn count(&self, n: u32, t: u32, keep: impl Fn(&Row) -> bool) -> usize {
        self.own.get(&n).map_or(0, |m| m.values().filter(|r| r.ty == t && keep(r)).count())
    }
}

/// The issues the rules add.
#[derive(Default)]
struct Issues(Vec<Issue>);

impl Issues {
    fn add(&mut self, n: u32, kind: &'static str, severity: &'static str, summary: String, detail: String) {
        self.0.push(Issue { node: node_id(n), kind, severity, summary, detail, weight: 0.0 });
    }

    /// An issue with its own weight.
    fn push(&mut self, issue: Issue) {
        self.0.push(issue);
    }
}

/// A node's role from its identity, empty when unknown.
fn role_of(x: &Node) -> &str {
    x.identity.as_ref().map_or("", |id| id.role.as_str())
}

/// One node's device telemetry among its own packets, in time order.
fn device_telemetry<'a>(pk: &FxMap<u64, &'a Row>) -> Vec<(i64, &'a Telemetry)> {
    let mut tel: Vec<(i64, &Telemetry)> = pk.values().filter_map(|r| r.telemetry().filter(|t| t.kind == ty::DEVICE).map(|t| (r.t, t))).collect();
    tel.sort_by_key(|x| x.0);
    tel
}

fn rank(severity: &str) -> u8 {
    match severity {
        "problem" => 0,
        "warning" => 1,
        _ => 2,
    }
}

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
pub fn health<'a>(rows: &'a [&'a Row], window: &[&'a Row], nodes: &'a [Node], edges: &'a [Edge], readings: &'a LinkReadings, copies: &Copies, presets: &'a PresetIndex, i: &'a Interner, hours: f64, regions: &'a Regions) -> Health {
    // Rates over the span the data covers, which can be shorter than the
    // window (the service started later, or was down).
    let (lo, hi) = rows.iter().fold((i64::MAX, i64::MIN), |(lo, hi), r| (lo.min(r.t), hi.max(r.t)));
    let span = if hi > lo { (hi - lo) as f64 / 3_600_000.0 } else { 0.0 };
    let hours = hours.min(span).max(1.0);

    // Own packets, first copy each, and the window's rows unfiltered.
    let invalid_ty = i.get("invalid");
    let (invalid, live): (Vec<&Row>, Vec<&Row>) = window.iter().partition(|r| Some(r.ty) == invalid_ty);
    let mut own: FxMap<u32, FxMap<u64, &Row>> = map();
    for r in first_per_packet(rows.iter().copied(), |_| true) {
        own.entry(r.src).or_default().insert(r.lp, r);
    }
    let newest = live.iter().map(|r| r.t).max().unwrap_or(i64::MIN);
    let cx = Ctx { rows, invalid, live, nodes, edges, readings, presets, i, regions, hours, own, newest };

    let mut out = Issues::default();
    traceroute::check(&cx, &mut out);
    hop_limit::check(&cx, &mut out);
    preset::check(&cx, &mut out);
    isolated::check(&cx, &mut out);
    admin::check(&cx, &mut out);
    gateways::check(&cx, &mut out);
    downlinks::check(&cx, &mut out);
    positions::check(&cx, &mut out);
    busy_channel::check(&cx, &mut out);
    batteries::check(&cx, &mut out);
    chatty::check(&cx, &mut out);
    burst::check(&cx, &mut out);
    restarts::check(&cx, &mut out);
    identities::check(&cx, &mut out);
    impersonation::check(&cx, &mut out);
    silent::check(&cx, &mut out);
    router_roles::check(&cx, &mut out);
    link_drop::check(&cx, &mut out);
    let air = airtime(copies, rows, i, hours);
    airtime::check(&air, &mut out);

    let mut issues = out.0;
    issues.sort_unstable_by(|a, b| rank(a.severity).cmp(&rank(b.severity)).then(a.kind.cmp(b.kind)).then(b.weight.total_cmp(&a.weight)).then(a.node.cmp(&b.node)).then(a.summary.cmp(&b.summary)).then(a.detail.cmp(&b.detail)));
    Health { issues, airtime: air }
}

/// Helpers for the rules' tests.
#[cfg(test)]
mod tests {
    use super::{health, Issue};
    use crate::channels::PresetIndex;
    use crate::copies::Copies;
    use crate::row::{Interner, JRow, Row};
    use crate::views::link::LinkReadings;

    pub(super) const H: i64 = 3_600_000;

    pub(super) fn telemetry(i: &mut Interner, k: i64, battery: f64, uptime: u32) -> Row {
        let text = format!(
            r#"{{"i":{k},"t":{},"b":"x","g":7,"s":5,"y":"telemetry","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","te":{{"kind":"device","battery":{battery},"uptime":{uptime}}}}}"#,
            k * 3 * H
        );
        serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
    }

    pub(super) fn issues(rows: &[Row], i: &Interner) -> Vec<Issue> {
        let refs: Vec<&Row> = rows.iter().collect();
        health(&refs, &[], &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), i, 48.0, &crate::landsdel::Regions::default()).issues
    }

    /// A node `n` with `role` sending one packet at each of `times` (ms).
    pub(super) fn sender(i: &mut Interner, n: u32, role: &str, times: &[i64]) -> (crate::views::Node, Vec<Row>) {
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

    /// A gateway at (lat, lon) and one uplink of it under `topic`.
    pub(super) fn gateway(i: &mut Interner, n: u32, lat: f64, lon: f64, topic: &str, k: i64) -> (crate::views::Node, Row) {
        let mut x = crate::views::Node::new(n);
        x.is_gateway = true;
        x.position = Some(crate::views::Position { lat, lon, alt: None, precision_bits: 32, precision_known: true, signature: "unsigned".into(), observed_at: "2026-11-05T00:00:00Z".into(), source: "position".into() });
        let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":{n},"s":5,"y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","tp":"{topic}"}}"#, k * H);
        (x, serde_json::from_str::<JRow>(&text).unwrap().into_row(i))
    }

    pub(super) fn node_issues(rows: &[Row], nodes: &[crate::views::Node], i: &Interner) -> Vec<Issue> {
        let refs: Vec<&Row> = rows.iter().collect();
        health(&refs, &[], nodes, &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), i, 48.0, &crate::landsdel::tests::fixture()).issues
    }
}
