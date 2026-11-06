//! meshmap engine: the browser's mesh derivation, compiled to WebAssembly
//! (D-040). The derivation worker hands it raw JSON text (API pages, live
//! rows, persisted chunks) and asks for views as JSON text; rows never become
//! JavaScript objects.

pub mod channels;
pub mod copies;
pub mod geo;
pub mod health;
pub mod landsdel;
pub mod movement;
pub mod graph;
pub mod packets;
pub mod radio;
pub mod reach;
pub mod reliability;
pub mod row;
pub mod store;
pub mod util;
pub mod views;
pub mod zerocost;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::row::Interner;
use crate::store::Store;
use crate::util::{key64, parse_node};
use crate::views::{build_node_detail, build_snapshot, build_traffic, bucket_for, filter_fn, Built, Filters, GeoOptions, Rules};

#[derive(Deserialize)]
struct GeoSettings {
    enabled: bool,
    min_precision_bits: u32,
    #[serde(default)]
    exclude: Option<Vec<String>>,
    #[serde(flatten)]
    params: geo::Params,
}

#[derive(Deserialize)]
/// Every field is optional: what an update leaves out keeps its current
/// value (the rules start on, the node limit at MAX_NODES).
struct Options {
    #[serde(default)]
    geo: Option<GeoSettings>,
    /// Exclude nodes whose role never rebroadcasts (CLIENT_MUTE) from relay
    /// candidates (default on; off only to compare with the old server views).
    #[serde(default)]
    silent_rule: Option<bool>,
    /// Traceroute hops at exactly 0 dB as MQTT links (default on; off only to
    /// compare with the old server views).
    #[serde(default)]
    mqtt_links: Option<bool>,
    /// Drop link evidence from before a node's latest move (default on; off
    /// only to compare with the old server views) (D-073).
    #[serde(default)]
    move_rule: Option<bool>,
    /// Rule out relays too far away for the signal a gateway measured
    /// (default on; off only to compare with the old server views) (D-136).
    #[serde(default)]
    signal_rule: Option<bool>,
    /// Bound relay range by links seen more than once between nodes that
    /// did not move (default on; off only to compare with the old server
    /// views) (D-177).
    #[serde(default)]
    range_rule: Option<bool>,
    /// Count the originator as a relay candidate for its own byte (default
    /// on; off only to compare with the old server views) (D-179).
    #[serde(default)]
    origin_rule: Option<bool>,
    /// Nodes the snapshot keeps, the most active first (default MAX_NODES,
    /// D-182). Kept until set again, so options without it leave it alone.
    #[serde(default)]
    max_nodes: Option<usize>,
}

/// A view request's window and filters at one store version (memo key).
struct Key {
    start: i64,
    end: i64,
    filters: String,
    version: u64,
}

impl Key {
    fn is(&self, start: i64, end: i64, filters: &str, version: u64) -> bool {
        (self.start, self.end, self.version) == (start, end, version) && self.filters == filters
    }
}

#[wasm_bindgen]
pub struct Engine {
    i: Interner,
    store: Store,
    geo: GeoOptions,
    rules: Rules,
    built: Option<(Key, Built)>,
    /// The filtered window's rows as indices into the store, shared by the
    /// views of one rebuild (snapshot, traffic, node, packet log, route).
    rows: Option<(Key, Vec<u32>)>,
    /// Interned strings at which to drop those no row holds any more (compact).
    compact_at: usize,
    /// The regions' outlines for health (D-161), empty until set_regions.
    regions: landsdel::Regions,
}

/// Interned strings below which the interner is never compacted.
const COMPACT_MIN: usize = 4096;
/// How far back an ACK looks for the copies of the packet it answers (D-172).
const ACK_LOOKBACK_MS: i64 = 15 * 60 * 1000;

impl Default for Engine {
    fn default() -> Self {
        Engine { i: Interner::default(), store: Store::default(), geo: GeoOptions::default(), rules: Rules::default(), built: None, rows: None, compact_at: COMPACT_MIN, regions: landsdel::Regions::default() }
    }
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

impl Engine {
    /// A view as JSON (Engine::view_bytes for the page; tests read it as
    /// text): kind is snapshot, traffic, node, packetlog, route, reach,
    /// health or link; arg is the node id (node, packetlog, reach), packet key
    /// (route) or "a|b" node ids (link). "null"
    /// means the node is neither observed nor referenced in the window.
    pub fn view(&mut self, kind: &str, start: f64, end: f64, filters: &str, arg: &str) -> Result<String, JsError> {
        let (start, end) = (start as i64, end as i64);
        match kind {
            "snapshot" => Ok(json(&self.build(start, end, filters)?.snapshot)),
            "traffic" => {
                self.filter(start, end, filters)?;
                Ok(json(&build_traffic(&self.rows(), start, bucket_for(end - start), &self.i)))
            }
            "node" => {
                let num = parse_node(arg).ok_or_else(|| err("invalid node id"))?;
                self.build(start, end, filters)?;
                let b = &self.built.as_ref().unwrap().1;
                Ok(json(&build_node_detail(&self.rows(), num, b, &self.i)))
            }
            "packetlog" => {
                let num = parse_node(arg).ok_or_else(|| err("invalid node id"))?;
                self.build(start, end, filters)?;
                let b = &self.built.as_ref().unwrap().1;
                // Its invalid rows too, which the filters always leave out (D-093).
                let invalid = self.i.get("invalid");
                let (a, z) = self.store.range(start, end);
                let mut rows = self.rows();
                let replies = b.replies.get_or_init(|| packets::ReplyIndex::new(&rows));
                rows.extend(self.store.rows()[a..z].iter().filter(|r| Some(r.ty) == invalid && r.src == num));
                Ok(json(&packets::packet_log(&rows, num, &b.ctx, replies, &self.i)))
            }
            "route" => {
                let lp = key64(arg);
                self.build(start, end, filters)?;
                let all = self.rows();
                let rows: Vec<&row::Row> = all.iter().copied().filter(|r| r.lp == lp).collect();
                // ACKs answering it: their senders received it (D-096).
                let ack = self.i.get("ack");
                let index = self.built.as_ref().unwrap().1.replies.get_or_init(|| packets::ReplyIndex::new(&all));
                let acked: Vec<u32> = match rows.first().and_then(|r| r.pid.map(|p| (r.src, p))) {
                    Some((src, pid)) => {
                        let mut v: Vec<u32> = index.answering(pid, src, &all).filter(|r| r.routing().is_some_and(|rt| Some(rt.kind) == ack)).map(|r| r.src).collect();
                        v.sort_unstable();
                        v.dedup();
                        v
                    }
                    None => vec![],
                };
                // A traceroute request: its replies record its whole way to the target.
                let replies: Vec<&row::Row> = match rows.first().filter(|r| r.traceroute().is_some_and(|t| t.valid && !t.is_reply)).and_then(|r| r.pid.map(|p| (r.src, p))) {
                    Some((src, pid)) => index.traceroute_replies(pid, src, &all).collect(),
                    None => vec![],
                };
                let b = &self.built.as_ref().unwrap().1;
                Ok(json(&packets::packet_route(&rows, &b.ctx, &b.roles, &self.i, &acked, &replies)))
            }
            "reach" => {
                // arg: node id, with "|internet" to follow MQTT links too (D-069).
                let (id, internet) = arg.split_once('|').map_or((arg, false), |(a, b)| (a, b == "internet"));
                let num = parse_node(id).ok_or_else(|| err("invalid node id"))?;
                self.build(start, end, filters)?;
                let b = &self.built.as_ref().unwrap().1;
                // Current roles, not the relay rule's window-wide set (D-177): reach is
                // about where a packet sent now would go.
                let silent: util::FxSet<u32> = b.roles.iter().filter(|(_, r)| views::is_silent_role(r)).map(|(&n, _)| n).collect();
                let rows = self.store.rows();
                let own: Vec<&row::Row> = self.rows.as_ref().map_or(&[][..], |(_, idx)| idx).iter().map(|&k| &rows[k as usize]).filter(|r| r.src == num).collect();
                Ok(json(&reach::reach(num, &b.snapshot.edges, &silent, internet, &own)))
            }
            "link" => {
                // arg: "!aaaaaaaa|!bbbbbbbb" (D-105).
                let (a, b) = arg.split_once('|').and_then(|(a, b)| Some((parse_node(a)?, parse_node(b)?))).ok_or_else(|| err("invalid link"))?;
                self.build(start, end, filters)?;
                let built = &self.built.as_ref().unwrap().1;
                Ok(json(&views::link::link_history(&built.readings, a, b)))
            }
            "health" => {
                self.build(start, end, filters)?;
                let b = &self.built.as_ref().unwrap().1;
                let hours = (end - start) as f64 / 3_600_000.0;
                // Rows that failed verification, which the filters always leave out (D-108).
                let invalid_ty = self.i.get("invalid");
                let (lo, hi) = self.store.range(start, end);
                let invalid: Vec<&row::Row> = self.store.rows()[lo..hi].iter().filter(|r| Some(r.ty) == invalid_ty).collect();
                let rows = self.rows();
                let presets = b.presets.get_or_init(|| channels::PresetIndex::new(&rows, &b.traceroute_contacts, &self.i));
                Ok(json(&health::health(&rows, &invalid, &b.snapshot.nodes, &b.copies, presets, &self.i, hours, &self.regions)))
            }
            _ => Err(err(format!("unknown view {kind}"))),
        }
    }


    /// Selects the window's rows passing the filters (Engine::rows),
    /// memoised until the store or the request changes.
    fn filter(&mut self, start: i64, end: i64, filters: &str) -> Result<(), JsError> {
        let version = self.store.version;
        if self.rows.as_ref().is_none_or(|(k, _)| !k.is(start, end, filters, version)) {
            let f: Filters = serde_json::from_str(filters).map_err(err)?;
            let keep = filter_fn(&f, &self.i);
            let (a, b) = self.store.range(start, end);
            let idx = (a..b).filter(|&k| keep(&self.store.rows()[k])).map(|k| k as u32).collect();
            self.rows = Some((Key { start, end, filters: filters.to_string(), version }, idx));
        }
        Ok(())
    }

    /// Drops interned strings that no row holds any more, once the interner
    /// has doubled since it last was: names, status texts and ping rows'
    /// strings would otherwise pile up over a long session as rows leave.
    /// Called after rows are dropped; amortised, since a compaction that
    /// frees little doubles the threshold.
    fn compact(&mut self) {
        if self.i.len() < self.compact_at {
            return;
        }
        let mut keep = vec![false; self.i.len()];
        self.store.for_each_id(|x| keep[*x as usize] = true);
        let new = self.i.retain(&keep);
        self.store.for_each_id(|x| *x = new[*x as usize]);
        self.store.version += 1; // memos hold ids: rebuild them
        self.compact_at = (2 * self.i.len()).max(COMPACT_MIN);
    }

    /// The rows selected by the last Engine::filter.
    fn rows(&self) -> Vec<&row::Row> {
        self.rows.as_ref().map_or(vec![], |(_, idx)| idx.iter().map(|&k| &self.store.rows()[k as usize]).collect())
    }

    /// The snapshot (and relay context) for a window and filters, memoised
    /// until the store or the request changes; their rows are selected too.
    fn build(&mut self, start: i64, end: i64, filters: &str) -> Result<&Built, JsError> {
        let version = self.store.version;
        self.filter(start, end, filters)?;
        if self.built.as_ref().is_none_or(|(k, _)| !k.is(start, end, filters, version)) {
            let b = build_snapshot(&self.rows(), &self.i, &self.geo, self.rules);
            self.built = Some((Key { start, end, filters: filters.to_string(), version }, b));
        }
        Ok(&self.built.as_ref().unwrap().1)
    }
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine::default()
    }

    /// {geo?: capabilities.geolocation, silent_rule?, mqtt_links?, move_rule?, signal_rule?, range_rule?, origin_rule?: bool, max_nodes?: number}
    pub fn set_options(&mut self, options: &str) -> Result<(), JsError> {
        let o: Options = serde_json::from_str(options).map_err(err)?;
        let geo_changed = o.geo.is_some();
        if let Some(g) = o.geo {
            self.geo = GeoOptions {
                enabled: g.enabled,
                min_precision_bits: g.min_precision_bits,
                exclude: g.exclude.unwrap_or_default().iter().filter_map(|s| parse_node(s)).collect(),
                params: g.params,
                terrain: std::mem::take(&mut self.geo.terrain),
            };
        }
        let r = self.rules;
        let rules = Rules {
            silent: o.silent_rule.unwrap_or(r.silent),
            mqtt_links: o.mqtt_links.unwrap_or(r.mqtt_links),
            moves: o.move_rule.unwrap_or(r.moves),
            signal: o.signal_rule.unwrap_or(r.signal),
            range: o.range_rule.unwrap_or(r.range),
            origin: o.origin_rule.unwrap_or(r.origin),
            max_nodes: o.max_nodes.map_or(r.max_nodes, |n| n.max(1)),
        };
        // Views are rebuilt only for what changed: new geolocation settings, or other rules.
        if geo_changed || rules != r {
            self.rules = rules;
            self.built = None;
        }
        Ok(())
    }

    /// The regions' outlines (the map's Regions layer GeoJSON) for the
    /// health rule on gateways' topic roots (D-161). Replaces the last set.
    pub fn set_regions(&mut self, geojson: &str) -> Result<(), JsError> {
        self.regions = landsdel::Regions::parse(geojson).map_err(err)?;
        Ok(())
    }

    /// Line-of-sight classes of router links from the server's terrain cross
    /// sections (D-143): [{a: "!id", b: "!id", class}]. Replaces the last set.
    pub fn set_terrain(&mut self, links: &str) -> Result<(), JsError> {
        #[derive(serde::Deserialize)]
        struct L {
            a: String,
            b: String,
            class: String,
        }
        let ls: Vec<L> = serde_json::from_str(links).map_err(err)?;
        let terrain = ls
            .into_iter()
            .filter_map(|l| {
                let (a, b) = (parse_node(&l.a)?, parse_node(&l.b)?);
                Some(((a.min(b), a.max(b)), l.class))
            })
            .collect();
        if terrain != self.geo.terrain {
            self.geo.terrain = terrain;
            self.built = None;
        }
        Ok(())
    }

    /// Stages one /observations page; returns its metadata as JSON.
    pub fn stage(&mut self, page: &str, batch: u32) -> Result<String, JsError> {
        self.store.stage(page, batch, &mut self.i).map(|m| json(&m)).map_err(err)
    }
    pub fn commit(&mut self, batch: u32) -> u32 {
        self.store.commit(batch) as u32
    }
    pub fn discard(&mut self, batch: u32) {
        self.store.discard(batch)
    }
    /// Merges a JSON array of rows at or after `lo` (live rows, restored chunks).
    pub fn add_rows(&mut self, rows: &str, lo: f64) -> Result<u32, JsError> {
        self.store.add_json(rows, lo as i64, &mut self.i).map(|n| n as u32).map_err(err)
    }
    pub fn reset(&mut self) {
        self.store.reset();
        self.compact();
    }
    pub fn trim_before(&mut self, t: f64) {
        self.store.trim_before(t as i64);
        self.compact();
    }
    pub fn newest_t(&self) -> f64 {
        self.store.newest_t() as f64
    }
    pub fn count(&self) -> u32 {
        self.store.rows().len() as u32
    }
    /// "<rows>.<newest id>" in [start, end): changes whenever the window's data does.
    pub fn revision(&self, start: f64, end: f64) -> String {
        let (n, m) = self.store.stats(start as i64, end as i64);
        format!("n{n}.m{m}")
    }
    /// Hours (start ms) that gained rows since the last call.
    pub fn take_dirty(&mut self) -> Vec<f64> {
        self.store.take_dirty().into_iter().map(|h| h as f64).collect()
    }
    /// Rows in [lo, hi) as the API's JSON array (the persisted copy).
    pub fn export(&self, lo: f64, hi: f64) -> String {
        self.store.export(lo as i64, hi as i64, &self.i)
    }

    /// Engine::view as UTF-8 bytes (a Uint8Array in JS): the page decodes
    /// them once, with no UTF-16 string in between.
    pub fn view_bytes(&mut self, kind: &str, start: f64, end: f64, filters: &str, arg: &str) -> Result<Vec<u8>, JsError> {
        self.view(kind, start, end, filters, arg).map(String::into_bytes)
    }

    /// Transmissions proven by live rows (JSON array), attributed with the
    /// latest snapshot's relay context; JSON array of arrays, one per row.
    pub fn transmissions(&mut self, rows: &str) -> Result<String, JsError> {
        let rows = row::parse_rows(rows, &mut self.i, |_| true).map_err(err)?;
        let empty = Built::default();
        let b = self.built.as_ref().map_or(&empty, |(_, b)| b);
        let invalid = self.i.get("invalid");
        // Invalid rows prove nothing, not even a transmission (D-093).
        let ack = self.i.get("ack");
        let out: Vec<Vec<packets::Transmission>> = rows
            .iter()
            .map(|r| {
                if Some(r.ty) == invalid {
                    return vec![];
                }
                // A reply's record of its request's way comes first, so the
                // reply's own pings can wait for it to reach the target.
                let mut t = packets::forward_route(r, &b.ctx);
                t.extend(packets::transmissions(r, &b.ctx, &b.roles));
                // The answered packet's copies from the last quarter of an
                // hour: its routing graph gives the way it took there, the
                // ACK's the way back (D-172).
                if let Some(rt) = r.routing().filter(|rt| Some(rt.kind) == ack && rt.request != 0) {
                    let sender = r.dst.unwrap_or(u32::MAX);
                    let (mut original, mut copies): (Vec<&row::Row>, Vec<&row::Row>) = (vec![], vec![]);
                    for o in self.store.slice(r.t - ACK_LOOKBACK_MS, r.t + 1).iter().filter(|o| Some(o.ty) != invalid) {
                        if o.src == sender && o.pid == Some(rt.request) {
                            original.push(o)
                        }
                        // The ACK's own copies so far, this one last: the way it took back.
                        if o.lp == r.lp {
                            copies.push(o)
                        }
                    }
                    copies.push(r);
                    t.extend(packets::delivery_ping(r, ack, &original, &copies, &b.ctx, &b.roles, &self.i));
                }
                t
            })
            .collect();
        Ok(json(&out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_only_dropped_rows_held_are_compacted_away() {
        let mut e = Engine::new();
        // 5000 status texts, one per second, then one row of every kind with strings of its own.
        let mut rows: Vec<String> = (0..5000)
            .map(|k| format!(r#"{{"i":{k},"t":{},"b":"x","g":7,"s":5,"y":"node_status","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","ns":{{"status":"text {k}"}}}}"#, k * 1000))
            .collect();
        let t = 5_000_000;
        let base = |k: i64, ty: &str| format!(r#""i":{k},"t":{},"b":"b{k}","g":7,"s":5,"c":"c{k}","y":"{ty}","l":"{k:016x}","o":"{k:016x}","sg":"s{k}","rr":"r{k}","cr":"cr{k}","tp":"tp{k}""#, t + k);
        rows.push(format!(r#"{{{},"mr":{{"region":"rg","modem_preset":"mp","long_name":"ln1","short_name":"sn1","hw_model":"hw1","role":"ro1"}}}}"#, base(9001, "mapreport")));
        rows.push(format!(r#"{{{},"ni":{{"long_name":"ln2","short_name":"sn2","hw_model":"hw2","role":"ro2"}}}}"#, base(9002, "nodeinfo")));
        rows.push(format!(r#"{{{},"te":{{"kind":"tk","battery":50}}}}"#, base(9003, "telemetry")));
        rows.push(format!(r#"{{{},"rt":{{"kind":"rk","error":"re","request_id":3}}}}"#, base(9004, "routing")));
        rows.push(format!(r#"{{{},"sf":{{"kind":"sk"}}}}"#, base(9005, "store_forward")));
        rows.push(format!(r#"{{{},"iv":"why"}}"#, base(9006, "invalid")));
        e.add_rows(&format!("[{}]", rows.join(",")), f64::NEG_INFINITY).unwrap();
        let kept = e.export(t as f64, f64::MAX);
        let before = e.i.len();
        e.trim_before(t as f64);
        assert!(e.i.len() < before - 4900, "{} strings left of {before}", e.i.len());
        assert_eq!(e.export(t as f64, f64::MAX), kept, "kept rows read the same");
    }

    #[test]
    fn an_options_update_keeps_what_it_leaves_out() {
        let mut e = Engine::new();
        e.set_options(r#"{"signal_rule": false}"#).unwrap();
        e.set_options(r#"{"max_nodes": 10}"#).unwrap();
        assert!(!e.rules.signal, "the signal rule stays off");
        assert_eq!(e.rules.max_nodes, 10);
    }
}
