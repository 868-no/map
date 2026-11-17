//! probe: the browser's mesh derivation, run natively against a site's rows.
//!
//! Fetches a window of rows from a deployment's public API the way the
//! browser does (whole settled UTC days from /observations/day, the rest
//! paged from /observations), hands them to the same engine with the same
//! options (the site's geolocation settings, the regions' outlines, terrain
//! classes of router links), and prints its views: what the map would show,
//! without a browser. One self-contained binary per platform (Linux, macOS,
//! Windows): the regions' outlines are compiled in, HTTPS is rustls checking
//! the system's trust store. `probe help` lists the commands.
//!
//! Days the server sends as final (immutable) are cached in the platform's
//! cache directory (cache_root), so later runs fetch only what is new.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use meshmap_engine::util::parse_node;
use meshmap_engine::Engine;
use serde_json::{json, Value};

/// The crate's version, and the commit a release build was made from
/// (PROBE_COMMIT, set by .github/workflows/probe.yml): the engine inside.
fn version() -> String {
    match option_env!("PROBE_COMMIT").filter(|c| !c.is_empty()) {
        Some(c) => format!("{} ({})", env!("CARGO_PKG_VERSION"), &c[..c.len().min(7)]),
        None => env!("CARGO_PKG_VERSION").to_string(),
    }
}

const USAGE: &str = concat!(": the map's mesh derivation, run natively against a site's rows
GPL-3.0-only; source: ", env!("CARGO_PKG_REPOSITORY"), "

usage: probe [options] <command> [args]

commands:
  nodes [text]           nodes in the window (matching text in id or names)
  node <id|name>         one node: identity, position, telemetry, links, health
  health [id|name]       health issues, of the whole mesh or one node
  view <kind> [arg]      a raw engine view as JSON: snapshot, traffic, regions,
                         health, node <id>, packetlog <id>, route <packet key>,
                         reach <id>[|internet], link <a>|<b>, watch <id,id,...>
  save <file>            save the window's rows and options for offline runs

options:
  --site URL             deployment (default https://map.868.no, or $PROBE_SITE)
  --hours N              window length (default: the site's default window)
  --start T, --end T     window bounds, UTC: 2026-11-14 or 2026-11-14T06:00Z
                         (default end: now, or the newest row with --rows)
  --rows FILE            rows saved by `save` instead of fetching
  --filters JSON         view filters, e.g. '{\"types\":[\"position\"]}'
  --max-nodes N          the snapshot's node limit (default: the engine's)
  --no-terrain           skip line-of-sight classes of router links
  --json                 print the view behind node/health/nodes as JSON
  --detail               health: print each issue's detail line
  --quiet                no progress on stderr
  --version              print the version

whole days are cached in ~/.cache/meshmap/probe (Linux), ~/Library/Caches/
meshmap/probe (macOS) or %LOCALAPPDATA%\\meshmap\\probe (Windows); set
PROBE_CACHE to use another directory, or to an empty value to cache nothing
");

const DEFAULT_SITE: &str = "https://map.868.no";
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
/// A UTC day can no longer change this long after it ends (slices.ts SETTLE_MS, D-159).
const SETTLE_MS: i64 = 30 * 60_000;
/// Rows per /observations page (the server's maximum).
const PAGE_LIMIT: u32 = 20_000;
/// Router links the browser classifies at most (terrain.ts routerLinks).
const TERRAIN_LINKS: usize = 400;
/// Asks for terrain classes while the server still fetches heights.
const TERRAIN_POLLS: u32 = 10;
/// The map's Regions layer outlines, for health's topic-root rule (D-161).
const REGIONS: &str = include_str!("../../../frontend/src/assets/regions.geojson");
const VIEW_KINDS: &[&str] = &["snapshot", "traffic", "node", "packetlog", "route", "reach", "regions", "watch", "health", "link"];

type Res<T> = Result<T, String>;

fn main() -> ExitCode {
    match run(std::env::args().skip(1).collect()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("probe: {e}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Default)]
struct Opts {
    site: String,
    hours: Option<f64>,
    start: Option<i64>,
    end: Option<i64>,
    rows: Option<PathBuf>,
    filters: String,
    max_nodes: Option<usize>,
    terrain: bool,
    json: bool,
    detail: bool,
    quiet: bool,
}

fn run(args: Vec<String>) -> Res<()> {
    let mut o = Opts { site: std::env::var("PROBE_SITE").unwrap_or_else(|_| DEFAULT_SITE.into()), filters: "{}".into(), terrain: true, ..Opts::default() };
    let mut rest = Vec::new();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let mut val = |name: &str| it.next().ok_or_else(|| format!("{name} needs a value"));
        match a.as_str() {
            "--site" => o.site = val("--site")?.trim_end_matches('/').to_string(),
            "--hours" => o.hours = Some(val("--hours")?.parse().map_err(|_| "--hours: not a number")?),
            "--start" => o.start = Some(parse_time(&val("--start")?)?),
            "--end" => o.end = Some(parse_time(&val("--end")?)?),
            "--rows" => o.rows = Some(val("--rows")?.into()),
            "--filters" => {
                let f = val("--filters")?;
                serde_json::from_str::<Value>(&f).map_err(|e| format!("--filters: {e}"))?;
                o.filters = f;
            }
            "--max-nodes" => o.max_nodes = Some(val("--max-nodes")?.parse().map_err(|_| "--max-nodes: not a number")?),
            "--no-terrain" => o.terrain = false,
            "--json" => o.json = true,
            "--detail" => o.detail = true,
            "--quiet" | "-q" => o.quiet = true,
            "-V" | "--version" => {
                println!("probe {}", version());
                return Ok(());
            }
            "-h" | "--help" | "help" => {
                print!("probe {}{USAGE}", version());
                return Ok(());
            }
            s if s.starts_with("--") => return Err(format!("unknown option {s} (see probe help)")),
            _ => rest.push(a),
        }
    }
    let Some((cmd, args)) = rest.split_first() else {
        print!("probe {}{USAGE}", version());
        return Ok(());
    };
    let arg = |i: usize, what: &str| args.get(i).map(String::as_str).ok_or_else(|| format!("{cmd} needs {what}"));
    // Checked before fetching anything.
    match cmd.as_str() {
        "nodes" | "health" => {}
        "node" => {
            arg(0, "a node id or name")?;
        }
        "save" => {
            arg(0, "a file")?;
        }
        "view" => {
            let kind = arg(0, "a view kind")?;
            if !VIEW_KINDS.contains(&kind) {
                return Err(format!("unknown view {kind}; one of {}", VIEW_KINDS.join(", ")));
            }
        }
        _ => return Err(format!("unknown command {cmd} (see probe help)")),
    }

    let mut p = Probe::load(&o)?;
    match cmd.as_str() {
        "nodes" => p.nodes(args.first().map(String::as_str), &o),
        "node" => p.node(&args[0], &o),
        "health" => p.health(args.first().map(String::as_str), &o),
        "view" => p.raw_view(&args[0], args.get(1).map_or("", String::as_str)),
        "save" => p.save(Path::new(&args[0])),
        _ => unreachable!(),
    }
}

/// The engine loaded with a window's rows and the site's options.
struct Probe {
    e: Engine,
    start: i64,
    end: i64,
    filters: String,
    meta: Value,
    quiet: bool,
    /// The snapshot view, parsed once (it is megabytes of JSON).
    snap: Option<Rc<Value>>,
}

impl Probe {
    fn load(o: &Opts) -> Res<Probe> {
        let mut e = Engine::new();
        let log = |m: &str| {
            if !o.quiet {
                eprintln!("{m}");
            }
        };
        let (start, end, mut meta) = if let Some(path) = &o.rows {
            let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            let (head, rows) = text.split_once('\n').ok_or_else(|| format!("{}: not a file saved by probe save", path.display()))?;
            let meta: Value = serde_json::from_str(head).map_err(|e| format!("{}: {e}", path.display()))?;
            let n = e.add_rows(rows, f64::NEG_INFINITY).map_err(|err| format!("{}: {err}", path.display()))?;
            let newest = e.newest_t() as i64 + 1;
            let hours = o.hours.or_else(|| meta["hours"].as_f64()).unwrap_or(72.0);
            let (start, end) = window(o.start, o.end.or(Some(newest)), hours);
            log(&format!("{n} rows from {}", path.display()));
            (start, end, meta)
        } else {
            let site = &o.site;
            let caps = get_json(&format!("{site}/api/v1/capabilities"))?;
            let hours = o.hours.or_else(|| caps["default_window_hours"].as_f64()).unwrap_or(72.0);
            let (start, end) = window(o.start, o.end, hours);
            let generation = fetch_rows(&mut e, site, start, end, &log)?;
            let meta = json!({ "site": site, "generation": generation, "hours": (end - start) as f64 / HOUR_MS as f64,
                "start": iso(start), "end": iso(end), "geolocation": caps["geolocation"] });
            (start, end, meta)
        };
        if start >= end {
            return Err("the window is empty".into());
        }
        let mut options = json!({ "geo": meta["geolocation"] });
        if let Some(n) = o.max_nodes {
            options["max_nodes"] = n.into();
        }
        e.set_options(&options.to_string()).map_err(|err| format!("the site's settings: {err}"))?;
        e.set_regions(REGIONS).map_err(|err| format!("the compiled-in regions: {err}"))?;
        let mut p = Probe { e, start, end, filters: o.filters.clone(), meta: Value::Null, quiet: o.quiet, snap: None };
        // Saved classes are used as saved; otherwise asked for, as the map does.
        let terrain = match (o.terrain, &o.rows) {
            (false, _) => json!([]),
            (true, Some(_)) => meta.get("terrain").cloned().unwrap_or_else(|| json!([])),
            (true, None) => p.terrain(&o.site)?,
        };
        if terrain.as_array().is_some_and(|t| !t.is_empty()) {
            p.e.set_terrain(&terrain.to_string()).map_err(|err| format!("terrain classes: {err}"))?;
            p.snap = None; // built without them
        }
        meta["terrain"] = terrain;
        log(&format!("window {} – {} ({:.1} h), {} rows", iso(start), iso(end), (end - start) as f64 / HOUR_MS as f64, p.e.count()));
        p.meta = meta;
        Ok(p)
    }

    fn view(&mut self, kind: &str, arg: &str) -> Res<Value> {
        let text = self.e.view(kind, self.start as f64, self.end as f64, &self.filters, arg).map_err(|e| format!("view {kind}: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("view {kind}: {e}"))
    }

    fn snapshot(&mut self) -> Res<Rc<Value>> {
        if self.snap.is_none() {
            self.snap = Some(Rc::new(self.view("snapshot", "")?));
        }
        Ok(Rc::clone(self.snap.as_ref().unwrap_or_else(|| unreachable!())))
    }

    /// Line-of-sight classes of the window's router-to-router links (terrain.ts).
    fn terrain(&mut self, site: &str) -> Res<Value> {
        let snap = self.snapshot()?;
        let links = router_links(&snap);
        if links.is_empty() {
            return Ok(json!([]));
        }
        let body = json!({ "links": links.iter().map(|(_, _, ea, eb)| {
            let mut l = json!({ "lat1": ea.0, "lon1": ea.1, "lat2": eb.0, "lon2": eb.1 });
            if let Some(a) = ea.2 { l["alt1"] = a.into(); }
            if let Some(a) = eb.2 { l["alt2"] = a.into(); }
            l
        }).collect::<Vec<_>>() });
        let mut got = Value::Null;
        for i in 0..TERRAIN_POLLS {
            got = post_json(&format!("{site}/api/v1/terrain/classes"), &body)?;
            if got["incomplete"].as_bool() != Some(true) {
                break;
            }
            if i + 1 < TERRAIN_POLLS {
                std::thread::sleep(Duration::from_secs(3));
            }
        }
        if got["incomplete"].as_bool() == Some(true) && !self.quiet {
            eprintln!("terrain heights still incomplete: links not classified yet stay unknown");
        }
        let classes = got["classes"].as_array().cloned().unwrap_or_default();
        Ok(Value::Array(
            links
                .iter()
                .zip(&classes)
                .filter(|(_, c)| c["class"].as_str().is_some_and(|c| c != "unknown"))
                .map(|((a, b, _, _), c)| json!({ "a": a, "b": b, "class": c["class"] }))
                .collect(),
        ))
    }

    /// A node id from an id, or from a unique match in a node's names.
    fn resolve(&mut self, s: &str) -> Res<String> {
        if let Some(n) = parse_node(s) {
            return Ok(format!("!{n:08x}"));
        }
        let snap = self.snapshot()?;
        let hits = matching(&snap, s);
        let exact: Vec<&Value> = hits.iter().copied().filter(|n| names(n).iter().any(|x| x.eq_ignore_ascii_case(s))).collect();
        match (hits.as_slice(), exact.as_slice()) {
            ([one], _) | (_, [one]) => Ok(one["id"].as_str().unwrap_or_default().to_string()),
            ([], _) => Err(format!("no node in the window matches {s:?}")),
            _ => Err(format!(
                "{s:?} matches {} nodes: {}",
                hits.len(),
                hits.iter().take(10).map(|n| format!("{} {}", n["id"].as_str().unwrap_or(""), label(n))).collect::<Vec<_>>().join(", ")
            )),
        }
    }

    fn nodes(&mut self, q: Option<&str>, o: &Opts) -> Res<()> {
        let snap = self.snapshot()?;
        let list = matching(&snap, q.unwrap_or(""));
        if o.json {
            return print_json(&Value::Array(list.into_iter().cloned().collect()));
        }
        let mut rows = vec![vec!["id".into(), "short".into(), "name".into(), "role".into(), "last seen".into(), "pkts".into(), "gw".into(), "place".into()]];
        for n in list {
            let id = &n["identity"];
            rows.push(vec![
                s(&n["id"]),
                s(&id["short_name"]),
                s(&id["long_name"]),
                s(&id["role"]),
                short_time(n["last_seen"].as_str().or(n["last_referenced"].as_str())),
                s(&n["packets"]),
                if n["is_gateway"].as_bool() == Some(true) { "gw".into() } else { String::new() },
                place(n),
            ]);
        }
        table(&rows);
        Ok(())
    }

    fn node(&mut self, q: &str, o: &Opts) -> Res<()> {
        let id = self.resolve(q)?;
        let view = self.view("node", &id)?;
        if view.is_null() {
            return Err(format!("{id} is neither heard nor named in the window"));
        }
        if o.json {
            return print_json(&view);
        }
        // The node's own fields are flattened into the view (NodeDetail).
        let n = &view;
        let ident = &n["identity"];
        println!("{id}  {}  ({})", label(n), s(&n["status"]));
        if !ident.is_null() {
            println!("  role {}  hw {}  key {}", or_dash(&ident["role"]), or_dash(&ident["hw_model"]), if ident["has_public_key"].as_bool() == Some(true) { "yes" } else { "no" });
        }
        println!("  first seen {}  last seen {}", short_time(n["first_seen"].as_str()), short_time(n["last_seen"].as_str().or(n["last_referenced"].as_str())));
        println!(
            "  packets {}  receptions {}  gateway receptions {}{}",
            s(&n["packets"]),
            s(&n["receptions"]),
            s(&n["gateway_receptions"]),
            if n["is_gateway"].as_bool() == Some(true) { "  (gateway)" } else { "" }
        );
        println!("  place {}", place(n));
        for (k, what) in [("stale_position", "stale position"), ("rejected_position", "rejected position")] {
            if !n[k].is_null() {
                println!("  {what} {}", n[k]);
            }
        }
        let t = &n["telemetry"];
        if !t.is_null() {
            let mut parts = vec![format!("battery {}", battery(&t["battery"]))];
            for (k, unit) in [("voltage", " V"), ("ch_util", " % ch"), ("air_util", " % air")] {
                if let Some(v) = t[k].as_f64() {
                    parts.push(format!("{v:.1}{unit}"));
                }
            }
            if let Some(u) = t["uptime"].as_f64() {
                parts.push(format!("up {:.1} d", u / 86_400.0));
            }
            println!("  telemetry {}", parts.join("  "));
        }

        let snap = self.snapshot()?;
        let names: HashMap<&str, String> = snap["nodes"].as_array().into_iter().flatten().map(|n| (n["id"].as_str().unwrap_or(""), label(n))).collect();
        let mut edges: Vec<&Value> = snap["edges"].as_array().into_iter().flatten().filter(|e| e["src"] == id.as_str() || e["dst"] == id.as_str()).collect();
        edges.sort_by(|a, b| b["samples"].as_u64().cmp(&a["samples"].as_u64()));
        println!("\nlinks ({})", edges.len());
        let mut rows = vec![vec!["dir".into(), "node".into(), "name".into(), "conf".into(), "samples".into(), "snr".into(), "rssi".into(), "evidence".into(), "last".into()]];
        for e in edges {
            let out = e["src"] == id.as_str();
            let other = if out { s(&e["dst"]) } else { s(&e["src"]) };
            let kind = if e["mqtt"].as_bool() == Some(true) {
                "mqtt".to_string()
            } else if e["inferred"].as_bool() == Some(true) {
                "guessed".to_string()
            } else {
                evidence(&e["evidence"])
            };
            rows.push(vec![
                if out { "→".into() } else { "←".into() },
                other.clone(),
                names.get(other.as_str()).cloned().unwrap_or_default(),
                s(&e["confidence"]),
                s(&e["samples"]),
                stat(&e["snr"]),
                stat(&e["rssi"]),
                kind,
                short_time(e["last_at"].as_str()),
            ]);
        }
        table(&rows);

        let heard: Vec<&Value> = view["heard_by"].as_array().into_iter().flatten().collect();
        if !heard.is_empty() {
            println!("\nheard by ({}{})", heard.len(), if view["truncated"].as_bool() == Some(true) { ", truncated" } else { "" });
            let mut rows = vec![vec!["gateway".into(), "name".into(), "receptions".into(), "direct".into(), "snr".into(), "rssi".into()]];
            for h in heard {
                let g = s(&h["node"]);
                rows.push(vec![g.clone(), names.get(g.as_str()).cloned().unwrap_or_default(), s(&h["receptions"]), s(&h["direct_rf"]), num(&h["snr"]), num(&h["rssi"])]);
            }
            table(&rows);
        }

        let health = self.view("health", "")?;
        let issues: Vec<&Value> = health["issues"].as_array().into_iter().flatten().filter(|i| i["node"] == id.as_str()).collect();
        println!("\nhealth ({})", issues.len());
        for i in issues {
            println!("  {:<8} {:<16} {}", s(&i["severity"]), s(&i["kind"]), s(&i["summary"]));
        }
        Ok(())
    }

    fn health(&mut self, q: Option<&str>, o: &Opts) -> Res<()> {
        let id = q.map(|q| self.resolve(q)).transpose()?;
        let mut h = self.view("health", "")?;
        if let (Some(id), Some(list)) = (&id, h["issues"].as_array_mut()) {
            list.retain(|i| i["node"] == id.as_str());
        }
        if o.json {
            return print_json(&h);
        }
        let snap = self.snapshot()?;
        let names: HashMap<&str, String> = snap["nodes"].as_array().into_iter().flatten().map(|n| (n["id"].as_str().unwrap_or(""), label(n))).collect();
        let issues = h["issues"].as_array().cloned().unwrap_or_default();
        let mut rows = vec![vec!["severity".into(), "kind".into(), "node".into(), "name".into(), "summary".into()]];
        for i in &issues {
            let n = s(&i["node"]);
            rows.push(vec![s(&i["severity"]), s(&i["kind"]), n.clone(), names.get(n.as_str()).cloned().unwrap_or_default(), s(&i["summary"])]);
            if o.detail {
                rows.push(vec![String::new(), String::new(), String::new(), String::new(), format!("  {}", times(&s(&i["detail"])))]);
            }
        }
        if issues.is_empty() {
            println!("no issues");
        } else {
            table(&rows);
        }
        Ok(())
    }

    fn raw_view(&mut self, kind: &str, arg: &str) -> Res<()> {
        let arg = match kind {
            "node" | "packetlog" => self.resolve(arg)?,
            "reach" => {
                let (id, rest) = arg.split_once('|').map_or((arg, None), |(a, b)| (a, Some(b)));
                let id = self.resolve(id)?;
                rest.map_or(id.clone(), |r| format!("{id}|{r}"))
            }
            "link" => {
                let (a, b) = arg.split_once('|').ok_or("link needs <a>|<b>")?;
                format!("{}|{}", self.resolve(a)?, self.resolve(b)?)
            }
            "watch" => arg.split(',').filter(|s| !s.is_empty()).map(|s| self.resolve(s)).collect::<Res<Vec<_>>>()?.join(","),
            "route" if arg.is_empty() => return Err("route needs a packet key (from a packet log)".into()),
            _ => arg.to_string(),
        };
        let v = self.view(kind, &arg)?;
        print_json(&v)
    }

    /// The window's rows, a line of options before them (terrain classes,
    /// geolocation settings), so a later run with --rows derives the same views.
    fn save(&mut self, path: &Path) -> Res<()> {
        let rows = self.e.export(self.start as f64, self.end as f64);
        let mut meta = self.meta.clone();
        meta["start"] = iso(self.start).into();
        meta["end"] = iso(self.end).into();
        meta["hours"] = ((self.end - self.start) as f64 / HOUR_MS as f64).into();
        let mut f = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        writeln!(f, "{meta}").and_then(|()| f.write_all(rows.as_bytes())).map_err(|e| format!("{}: {e}", path.display()))?;
        if !self.quiet {
            eprintln!("saved {} rows to {}", self.e.count(), path.display());
        }
        Ok(())
    }
}

/// The window [start, end): end defaults to now, start to `hours` before end.
fn window(start: Option<i64>, end: Option<i64>, hours: f64) -> (i64, i64) {
    let end = end.unwrap_or_else(now_ms);
    (start.unwrap_or(end - (hours * HOUR_MS as f64) as i64), end)
}

/// Loads [start, end) into the engine as the browser does (range.ts): whole
/// settled UTC days from /observations/day, the rest paged. Returns the generation.
fn fetch_rows(e: &mut Engine, site: &str, start: i64, end: i64, log: &dyn Fn(&str)) -> Res<String> {
    let generation = get_json(&format!("{site}/api/v1/retention"))?["generation"].as_str().ok_or("no generation in /retention")?.to_string();
    let settled = (now_ms() - SETTLE_MS).div_euclid(DAY_MS) * DAY_MS;
    let days: Vec<i64> = (start.div_euclid(DAY_MS) * DAY_MS..end).step_by(DAY_MS as usize).filter(|d| d + DAY_MS <= settled).collect();
    let cache = cache_dir(site, &generation);
    let mut batch = 0;
    let mut stage = |e: &mut Engine, text: &str| -> Res<Value> {
        let meta = e.stage(text, batch).map_err(|e| e.to_string())?;
        let meta: Value = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
        if meta["generation"] != generation.as_str() {
            return Err("the server changed generation while fetching: run again".into());
        }
        batch = meta["batch"].as_u64().unwrap_or(0) as u32;
        Ok(meta)
    };
    for &d in &days {
        let date = &iso(d)[..10];
        let file = cache.as_ref().map(|c| c.join(format!("{date}.json")));
        // A cached day the engine cannot read (written by another version,
        // damaged) is dropped and fetched again.
        if let Some(f) = &file
            && let Ok(t) = std::fs::read_to_string(f)
        {
            match stage(e, &t) {
                Ok(_) => {
                    log(&format!("day {date}: cached"));
                    continue;
                }
                Err(err) => {
                    log(&format!("day {date}: cached copy unreadable ({err}), fetching it again"));
                    let _ = std::fs::remove_file(f);
                }
            }
        }
        let r = get(&format!("{site}/api/v1/observations/day/{date}?generation={}", enc(&generation)))?;
        if r.status == 409 {
            return Err("the server changed generation while fetching: run again".into());
        }
        let immutable = r.cache_control.contains("immutable");
        let t = r.ok()?;
        log(&format!("day {date}: {:.1} MB", t.len() as f64 / 1e6));
        stage(e, &t)?;
        if let Some(f) = file.as_ref().filter(|_| immutable)
            && let Err(err) = write_atomic(f, &t)
        {
            log(&format!("day {date}: not cached ({}: {err})", f.display()));
        }
    }
    // The part after the last whole day.
    let since = days.last().map_or(start, |d| d + DAY_MS);
    if since < end {
        let mut cursor = String::new();
        let mut pages = 0;
        loop {
            let mut url = format!("{site}/api/v1/observations?start={}&end={}&since={}&limit={PAGE_LIMIT}", enc(&iso(start)), enc(&iso(end)), enc(&iso(since)));
            if !cursor.is_empty() {
                url += &format!("&cursor={}", enc(&cursor));
            }
            let meta = stage(e, &get(&url)?.ok()?)?;
            pages += 1;
            match meta["next_cursor"].as_str() {
                Some(c) if meta["more"].as_bool() == Some(true) => cursor = c.to_string(),
                _ => break,
            }
        }
        log(&format!("since {}: {pages} page(s)", iso(since)));
    }
    if batch != 0 {
        e.commit(batch);
    }
    Ok(generation)
}

/// Where whole days are kept: PROBE_CACHE, else the platform's cache
/// directory; None (no cache) when PROBE_CACHE is empty or no home is known.
fn cache_root() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = std::env::var_os("PROBE_CACHE") {
        return (!dir.is_empty()).then(|| PathBuf::from(dir));
    }
    let base = if cfg!(windows) {
        env("LOCALAPPDATA")
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|h| h.join("Library/Caches"))
    } else {
        env("XDG_CACHE_HOME").or_else(|| env("HOME").map(|h| h.join(".cache")))
    }?;
    Some(base.join("meshmap").join("probe"))
}

/// A site's days of one generation: <root>/<host>/<generation>.
fn cache_dir(site: &str, generation: &str) -> Option<PathBuf> {
    let safe = |s: &str| -> String { s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect() };
    Some(cache_root()?.join(safe(site.split("://").last().unwrap_or(site))).join(safe(generation)))
}

/// Writes a cached day whole or not at all: an interrupted run leaves no
/// half a day behind.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(path.parent().unwrap_or(path))?;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, path)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Router-to-router radio links between nodes reporting a position, once
/// per pair, at most TERRAIN_LINKS (terrain.ts routerLinks).
type End = (f64, f64, Option<f64>);
fn router_links(snap: &Value) -> Vec<(String, String, End, End)> {
    let nodes: HashMap<&str, &Value> = snap["nodes"].as_array().into_iter().flatten().map(|n| (n["id"].as_str().unwrap_or(""), n)).collect();
    let infra = |n: &Value| matches!(n["identity"]["role"].as_str(), Some("ROUTER" | "ROUTER_LATE"));
    let end_of = |n: &Value| -> Option<End> {
        let pos = &n["position"];
        if pos.is_null() {
            return None;
        }
        let p = if n["refined"].is_null() { pos } else { &n["refined"] };
        let round = |v: f64| (v * 1e5).round() / 1e5;
        Some((round(p["lat"].as_f64()?), round(p["lon"].as_f64()?), pos["alt"].as_f64().filter(|a| *a != 0.0)))
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for e in snap["edges"].as_array().into_iter().flatten() {
        if e["mqtt"].as_bool() == Some(true) {
            continue;
        }
        let (src, dst) = (e["src"].as_str().unwrap_or(""), e["dst"].as_str().unwrap_or(""));
        let (a, b) = if src < dst { (src, dst) } else { (dst, src) };
        if !seen.insert((a, b)) {
            continue;
        }
        let (Some(na), Some(nb)) = (nodes.get(a), nodes.get(b)) else { continue };
        if !infra(na) || !infra(nb) {
            continue;
        }
        if let (Some(ea), Some(eb)) = (end_of(na), end_of(nb)) {
            out.push((a.to_string(), b.to_string(), ea, eb));
        }
    }
    out.sort_by_key(|x| x.0.clone() + &x.1);
    out.truncate(TERRAIN_LINKS);
    out
}

// ---- HTTP ----

struct Got {
    status: u16,
    cache_control: String,
    body: String,
}

impl Got {
    fn ok(self) -> Res<String> {
        if self.status == 200 {
            return Ok(self.body);
        }
        let detail = serde_json::from_str::<Value>(&self.body).ok().and_then(|v| v["detail"].as_str().map(String::from)).unwrap_or_else(|| self.body.chars().take(200).collect());
        Err(format!("HTTP {}: {detail}", self.status))
    }
}

/// A body's largest size: a busy whole day is tens of MB uncompressed.
const BODY_LIMIT: u64 = 1 << 30;

/// One agent for every request (it keeps connections): statuses are answers,
/// not errors, and certificates are checked against the system's trust store.
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::Rustls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .build();
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(concat!("meshmap-probe/", env!("CARGO_PKG_VERSION")))
        .tls_config(tls)
        .build()
        .into()
});

/// A request, retried a few times when the server asks to wait (429, 503).
fn request(url: &str, post: Option<&Value>) -> Res<Got> {
    let mut tries = 0;
    loop {
        let res = match post {
            None => AGENT.get(url).call(),
            Some(b) => AGENT.post(url).header("content-type", "application/json").send(b.to_string()),
        };
        let mut r = res.map_err(|e| {
            let hint = if e.to_string().contains("No CA certificates") { " (install the system's CA certificates, e.g. the ca-certificates package)" } else { "" };
            format!("{url}: {e}{hint}")
        })?;
        let status = r.status().as_u16();
        let header = |k: &str| r.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let (cache_control, retry) = (header("cache-control"), header("retry-after").trim().parse::<u64>().unwrap_or(2));
        if matches!(status, 429 | 503) && tries < 3 {
            tries += 1;
            std::thread::sleep(Duration::from_secs(retry.clamp(1, 10)));
            continue;
        }
        let body = r.body_mut().with_config().limit(BODY_LIMIT).read_to_string().map_err(|e| format!("{url}: {e}"))?;
        return Ok(Got { status, cache_control, body });
    }
}

fn get(url: &str) -> Res<Got> {
    request(url, None)
}

fn get_json(url: &str) -> Res<Value> {
    serde_json::from_str(&get(url)?.ok()?).map_err(|e| format!("{url}: {e}"))
}

fn post_json(url: &str, body: &Value) -> Res<Value> {
    serde_json::from_str(&request(url, Some(body))?.ok()?).map_err(|e| format!("{url}: {e}"))
}

/// Percent-encodes a query value.
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// ---- time (UTC only) ----

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(DAY_MS), ms.rem_euclid(DAY_MS));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / HOUR_MS, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

/// 2026-11-14, 2026-11-14T06:00, 2026-11-14T06:00:00Z, … (UTC; a trailing Z is optional).
fn parse_time(s: &str) -> Res<i64> {
    let bad = || format!("{s:?}: not a UTC time like 2026-11-14 or 2026-11-14T06:00Z");
    let t = s.strip_suffix('Z').unwrap_or(s);
    let (date, time) = t.split_once(['T', ' ']).unwrap_or((t, "00:00"));
    let dp: Vec<i64> = date.split('-').map(str::parse).collect::<Result<_, _>>().map_err(|_| bad())?;
    let [y, mo, d] = dp[..] else { return Err(bad()) };
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let tp: Vec<i64> = hms.split(':').map(str::parse).collect::<Result<_, _>>().map_err(|_| bad())?;
    let (h, mi, sec) = match tp[..] {
        [h, m] => (h, m, 0),
        [h, m, s] => (h, m, s),
        _ => return Err(bad()),
    };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return Err(bad());
    }
    let ms = if frac.is_empty() { 0 } else { format!("{frac:0<3}")[..3].parse::<i64>().map_err(|_| bad())? };
    Ok(days_from_civil(y, mo, d) * DAY_MS + h * HOUR_MS + mi * 60_000 + sec * 1000 + ms)
}

/// Health text with its {{t:<unix ms>}} placeholders (the page shows local
/// times) as UTC times.
fn times(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find("{{t:") {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 4..];
        match tail.find("}}").and_then(|j| Some((j, tail[..j].parse::<i64>().ok()?))) {
            Some((j, ms)) => {
                out.push_str(&iso(ms)[..19].replace('T', " "));
                out.push_str(" UTC");
                rest = &tail[j + 2..];
            }
            None => {
                out.push_str("{{t:");
                rest = tail;
            }
        }
    }
    out + rest
}

/// An ISO time as "11-14 06:00" (the window is never years long).
fn short_time(t: Option<&str>) -> String {
    t.and_then(|t| t.get(5..16)).map_or_else(|| "-".into(), |t| t.replace('T', " "))
}

// ---- output ----

fn print_json(v: &Value) -> Res<()> {
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    let mut out = std::io::stdout().lock();
    // A closed pipe (| head) is not an error.
    let _ = writeln!(out, "{text}");
    Ok(())
}

fn s(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

fn or_dash(v: &Value) -> String {
    let t = s(v);
    if t.is_empty() { "-".into() } else { t }
}

fn num(v: &Value) -> String {
    v.as_f64().map_or_else(|| "-".into(), |x| format!("{x:.1}"))
}

fn battery(v: &Value) -> String {
    match v.as_f64() {
        None => "-".into(),
        Some(b) if b > 100.0 => "ext".into(),
        Some(b) => format!("{b:.0}%"),
    }
}

/// A link statistic's median.
fn stat(v: &Value) -> String {
    num(&v["median"])
}

/// A link's evidence counts, short: "rf 34 nb 3 tr 148 hint 1325".
fn evidence(v: &Value) -> String {
    [("direct_rf", "rf"), ("neighbor", "nb"), ("traceroute", "tr"), ("relay_hint", "hint")]
        .iter()
        .filter_map(|(k, short)| v[*k].as_u64().filter(|n| *n > 0).map(|n| format!("{short} {n}")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn label(n: &Value) -> String {
    let id = &n["identity"];
    match (id["short_name"].as_str(), id["long_name"].as_str()) {
        (Some(s), Some(l)) => format!("{s} {l}"),
        (Some(x), None) | (None, Some(x)) => x.to_string(),
        _ => String::new(),
    }
}

fn names(n: &Value) -> Vec<&str> {
    let id = &n["identity"];
    [id["short_name"].as_str(), id["long_name"].as_str()].into_iter().flatten().collect()
}

/// Nodes whose id or names contain q (any case), most packets first.
fn matching<'a>(snap: &'a Value, q: &str) -> Vec<&'a Value> {
    let q = q.to_lowercase();
    let mut v: Vec<&Value> = snap["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| q.is_empty() || n["id"].as_str().is_some_and(|i| i.contains(&q)) || names(n).iter().any(|x| x.to_lowercase().contains(&q)))
        .collect();
    v.sort_by(|a, b| b["packets"].as_u64().cmp(&a["packets"].as_u64()));
    v
}

/// Where the map puts a node: its reported position, else its estimate.
fn place(n: &Value) -> String {
    let p = &n["position"];
    if let (Some(lat), Some(lon)) = (p["lat"].as_f64(), p["lon"].as_f64()) {
        return format!("{lat:.4},{lon:.4} {}", s(&p["source"]));
    }
    let e = &n["estimate"];
    if let (Some(lat), Some(lon)) = (e["lat"].as_f64(), e["lon"].as_f64()) {
        let r = e["uncertainty_radius_m"].as_f64().map_or(String::new(), |r| format!(" ±{:.1} km", r / 1000.0));
        return format!("{lat:.4},{lon:.4} est{r} {}", s(&e["quality"]));
    }
    "-".into()
}

fn table(rows: &[Vec<String>]) {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let width: Vec<usize> = (0..cols).map(|c| rows.iter().filter_map(|r| r.get(c)).map(|x| x.chars().count()).max().unwrap_or(0)).collect();
    let mut out = std::io::stdout().lock();
    for r in rows {
        let line: Vec<String> = r.iter().enumerate().map(|(i, x)| if i + 1 == r.len() { x.clone() } else { format!("{x:<w$}", w = width[i]) }).collect();
        if writeln!(out, "{}", line.join("  ").trim_end()).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_round_trip() {
        for t in ["2026-11-14T06:00:00.000Z", "1970-01-01T00:00:00.000Z", "2024-02-29T23:59:59.999Z"] {
            assert_eq!(iso(parse_time(t).unwrap()), t);
        }
        assert_eq!(parse_time("2026-11-14").unwrap(), parse_time("2026-11-14T00:00Z").unwrap());
        assert_eq!(parse_time("2026-11-14 06:30").unwrap() - parse_time("2026-11-14").unwrap(), 6 * HOUR_MS + 30 * 60_000);
        assert!(parse_time("14.11.2026").is_err());
        assert!(parse_time("2026-13-01").is_err());
    }

    #[test]
    fn health_times_in_utc() {
        assert_eq!(times("from {{t:1794876551324}} to {{t:x}}"), "from 2026-11-17 00:49:11 UTC to {{t:x}}");
        assert_eq!(times("none"), "none");
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(enc("2026-11-14T06:00:00.000Z"), "2026-11-14T06%3A00%3A00.000Z");
        assert_eq!(enc("d5.r11+x"), "d5.r11%2Bx");
    }

    #[test]
    fn router_links_once_per_pair_between_placed_routers() {
        let snap = json!({
            "nodes": [
                { "id": "!00000001", "identity": { "role": "ROUTER" }, "position": { "lat": 63.123456, "lon": 10.0, "alt": 0 } },
                { "id": "!00000002", "identity": { "role": "ROUTER_LATE" }, "position": { "lat": 63.2, "lon": 10.1, "alt": 400 } },
                { "id": "!00000003", "identity": { "role": "CLIENT" }, "position": { "lat": 63.3, "lon": 10.2 } }
            ],
            "edges": [
                { "src": "!00000002", "dst": "!00000001" },
                { "src": "!00000001", "dst": "!00000002" },
                { "src": "!00000001", "dst": "!00000003" },
                { "src": "!00000001", "dst": "!00000002", "mqtt": true }
            ]
        });
        let l = router_links(&snap);
        assert_eq!(l.len(), 1);
        assert_eq!((l[0].0.as_str(), l[0].1.as_str()), ("!00000001", "!00000002"));
        assert_eq!(l[0].2, (63.12346, 10.0, None));
        assert_eq!(l[0].3.2, Some(400.0));
    }
}
