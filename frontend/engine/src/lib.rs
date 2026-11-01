//! meshmap engine: the browser's mesh derivation, compiled to WebAssembly
//! (D-040). The derivation worker hands it raw JSON text (API pages, live
//! rows, persisted chunks) and asks for views as JSON text; rows never become
//! JavaScript objects.

pub mod channels;
pub mod geo;
pub mod movement;
pub mod graph;
pub mod packets;
pub mod radio;
pub mod reach;
pub mod row;
pub mod store;
pub mod util;
pub mod views;
pub mod zerocost;

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::row::{Interner, JRow};
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
struct Options {
    #[serde(default)]
    geo: Option<GeoSettings>,
    /// Exclude nodes whose role never rebroadcasts (CLIENT_MUTE) from relay
    /// candidates (default on; off only to compare with the old server views).
    #[serde(default = "yes")]
    silent_rule: bool,
    /// Traceroute hops at exactly 0 dB as MQTT links (default on; off only to
    /// compare with the old server views).
    #[serde(default = "yes")]
    mqtt_links: bool,
    /// Drop link evidence from before a node's latest move (default on; off
    /// only to compare with the old server views) (D-073).
    #[serde(default = "yes")]
    move_rule: bool,
}

fn yes() -> bool {
    true
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
}

impl Default for Engine {
    fn default() -> Self {
        Engine { i: Interner::default(), store: Store::default(), geo: GeoOptions::default(), rules: Rules::default(), built: None, rows: None }
    }
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

impl Engine {
    /// Selects the window's rows passing the filters (Engine::rows),
    /// memoised until the store or the request changes.
    fn filter(&mut self, start: i64, end: i64, filters: &str) -> Result<(), JsError> {
        let version = self.store.version;
        if self.rows.as_ref().is_none_or(|(k, _)| !k.is(start, end, filters, version)) {
            let f: Filters = serde_json::from_str(filters).map_err(err)?;
            let keep = filter_fn(&f, &self.i);
            let (a, b) = self.store.range(start, end);
            let idx = (a..b).filter(|&k| keep(&self.store.rows[k])).map(|k| k as u32).collect();
            self.rows = Some((Key { start, end, filters: filters.to_string(), version }, idx));
        }
        Ok(())
    }

    /// The rows selected by the last Engine::filter.
    fn rows(&self) -> Vec<&row::Row> {
        self.rows.as_ref().map_or(vec![], |(_, idx)| idx.iter().map(|&k| &self.store.rows[k as usize]).collect())
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

    /// {geo: capabilities.geolocation, silent_rule?: bool, mqtt_links?: bool, move_rule?: bool}
    pub fn set_options(&mut self, options: &str) -> Result<(), JsError> {
        let o: Options = serde_json::from_str(options).map_err(err)?;
        if let Some(g) = o.geo {
            self.geo = GeoOptions {
                enabled: g.enabled,
                min_precision_bits: g.min_precision_bits,
                exclude: g.exclude.unwrap_or_default().iter().filter_map(|s| parse_node(s)).collect(),
                params: g.params,
            };
        }
        self.rules = Rules { silent: o.silent_rule, mqtt_links: o.mqtt_links, moves: o.move_rule };
        self.built = None;
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
        self.store.reset()
    }
    pub fn trim_before(&mut self, t: f64) {
        self.store.trim_before(t as i64)
    }
    pub fn keep_only(&mut self, lo: f64, hi: f64) {
        self.store.keep_only(lo as i64, hi as i64)
    }
    pub fn newest_t(&self) -> f64 {
        self.store.newest_t() as f64
    }
    pub fn count(&self) -> u32 {
        self.store.rows.len() as u32
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

    /// A view as JSON: kind is snapshot, traffic, node, packetlog, route or reach;
    /// arg is the node id (node, packetlog) or packet key (route). "null"
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
                self.filter(start, end, filters)?;
                Ok(json(&build_node_detail(&self.rows(), num, &self.i)))
            }
            "packetlog" => {
                let num = parse_node(arg).ok_or_else(|| err("invalid node id"))?;
                self.build(start, end, filters)?;
                let b = &self.built.as_ref().unwrap().1;
                Ok(json(&packets::packet_log(&self.rows(), num, &b.ctx, &self.i)))
            }
            "route" => {
                let lp = key64(arg);
                self.build(start, end, filters)?;
                let rows: Vec<&row::Row> = self.rows().into_iter().filter(|r| r.lp == lp).collect();
                let b = &self.built.as_ref().unwrap().1;
                Ok(json(&packets::packet_route(&rows, &b.ctx, &b.roles, &self.i)))
            }
            "reach" => {
                // arg: node id, with "|internet" to follow MQTT links too (D-069).
                let (id, internet) = arg.split_once('|').map_or((arg, false), |(a, b)| (a, b == "internet"));
                let num = parse_node(id).ok_or_else(|| err("invalid node id"))?;
                self.build(start, end, filters)?;
                let b = &self.built.as_ref().unwrap().1;
                let silent: util::FxSet<u32> = b.roles.iter().filter(|(_, r)| views::is_silent_role(r)).map(|(&n, _)| n).collect();
                let own: Vec<&row::Row> = self.rows().into_iter().filter(|r| r.src == num).collect();
                Ok(json(&reach::reach(num, &b.snapshot.edges, &silent, internet, &own)))
            }
            _ => Err(err(format!("unknown view {kind}"))),
        }
    }

    /// Transmissions proven by live rows (JSON array), attributed with the
    /// latest snapshot's relay context; JSON array of arrays, one per row.
    pub fn transmissions(&mut self, rows: &str) -> Result<String, JsError> {
        let parsed: Vec<JRow> = serde_json::from_str(rows).map_err(err)?;
        let rows: Vec<row::Row> = parsed.into_iter().map(|r| r.into_row(&mut self.i)).collect();
        let empty = Built { snapshot: views::Snapshot { nodes: vec![], edges: vec![], edges_truncated: false, counts: Default::default(), diagnostics: Default::default() }, ctx: Default::default(), roles: util::map() };
        let b = self.built.as_ref().map_or(&empty, |(_, b)| b);
        let out: Vec<Vec<packets::Transmission>> = rows.iter().map(|r| packets::transmissions(r, &b.ctx, &b.roles)).collect();
        Ok(json(&out))
    }
}
