//! The engine against the retired server views, recorded for a real 12-hour
//! window (tests/fixtures/mesh-12h, D-041), and against its own recorded
//! output for that window with default options (engine.json; record it again
//! with UPDATE_GOLDEN=1 after an intended change).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const ROWS: &str = include_str!("fixtures/mesh-12h/observations.json");
const EXPECTED: &str = include_str!("fixtures/mesh-12h/expected.json");

/// Times to whole milliseconds (the server kept microseconds), numbers to
/// 1e-4 as f64, heard lists by node, and engine-only fields (`source`, `radio`,
/// `mqtt_downlink`, `zero_cost`, …) dropped, as are links and estimates, whose
/// rules have moved on from the server's (D-087).
fn normalize(v: &Value) -> Value {
    norm(v, true)
}

/// normalize, keeping the engine-only fields unless `server`.
fn norm(v: &Value, server: bool) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| norm(x, server)).collect()),
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, x) in o {
                if server && (k == "source" || k == "radio" || k == "mqtt_downlink" || k == "zero_cost" || k == "moved_at" || k == "track" || k == "airborne" || k == "refined" || k == "relaying" || k == "multi_uplink"
                    // Links and the estimates built on them left the retired server's rules in D-087
                    // (count-aware confidence, traceroute and relay evidence counted once): engine.json covers them.
                    || k == "edges" || k == "estimate" || k == "estimate_note" || k == "last_referenced" || k == "own_uplinks"
                    // And so has how many are estimated: anchors at one site count as one (D-175).
                    || k == "estimated"
                    // The server counted a packet under every status any copy had; one per packet now (D-087).
                    || k == "signatures" || k == "uptime") {
                    continue;
                }
                let mut x = norm(x, server);
                if (k == "heard" || k == "heard_by") && x.is_array() {
                    x.as_array_mut().unwrap().sort_by(|a, b| a["node"].as_str().cmp(&b["node"].as_str()));
                }
                out.insert(k.clone(), x);
            }
            Value::Object(out)
        }
        Value::String(s) if is_time(s) => json!(millis(s)),
        Value::Number(n) => json!((n.as_f64().unwrap() * 1e4).round() / 1e4),
        _ => v.clone(),
    }
}

fn is_time(s: &str) -> bool {
    s.len() >= 20 && s.as_bytes()[4] == b'-' && s.as_bytes()[10] == b'T' && (s.ends_with('Z') || s.contains('+'))
}

/// "YYYY-MM-DDTHH:MM:SS(.fff…)Z" to Unix milliseconds (floored).
fn millis(s: &str) -> f64 {
    let n = |a: usize, b: usize| s[a..b].parse::<i64>().unwrap();
    let (y, mo, d, h, mi, se) = (n(0, 4), n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19));
    let frac = s[19..].trim_start_matches('.').trim_end_matches('Z');
    let ms = if s.as_bytes()[19] == b'.' { format!("{:0<3}", &frac[..frac.len().min(3)]).parse::<i64>().unwrap() } else { 0 };
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (((days * 24 + h) * 60 + mi) * 60 + se) as f64 * 1000.0 + ms as f64
}

/// The server took a node's latest NodeInfo, position or telemetry by its
/// latest copy; the engine by its first (D-176). In this window that tells
/// apart only !552ad94c's identity: its NodeInfo 928744739, first heard at
/// 13:52:41, had a copy uplinked at 13:54:52, after 928744741 (13:52:54).
fn server_views() -> Value {
    serde_json::from_str(&EXPECTED.replace(r#""observed_at":"2026-10-31T13:54:52.30196Z""#, r#""observed_at":"2026-10-31T13:52:55.174Z""#)).unwrap()
}

#[test]
fn engine_matches_the_recorded_server_views() {
    let expected = server_views();
    let mut e = Engine::new();
    e.set_options(&json!({ "geo": expected["geolocation"], "silent_rule": false, "mqtt_links": false, "move_rule": false, "signal_rule": false, "range_rule": false }).to_string()).unwrap();
    assert!(e.add_rows(ROWS, f64::NEG_INFINITY).unwrap() > 6000);
    let (s, t) = (millis(expected["window"]["start"].as_str().unwrap()), millis(expected["window"]["end"].as_str().unwrap()));
    let view = |e: &mut Engine, kind: &str, filters: Value, arg: &str| -> Value { serde_json::from_str(&e.view(kind, s, t, &filters.to_string(), arg).unwrap()).unwrap() };

    assert_eq!(normalize(&view(&mut e, "snapshot", json!({}), "")), normalize(&expected["snapshot"]), "snapshot");
    assert_eq!(normalize(&view(&mut e, "traffic", json!({}), "")), normalize(&expected["traffic"]), "traffic");
    assert_eq!(normalize(&view(&mut e, "snapshot", json!({"types": ["position", "nodeinfo"]}), "")), normalize(&expected["snapshot_position_nodeinfo"]), "filtered snapshot");
    let nodes = expected["nodes"].as_object().unwrap();
    assert_eq!(nodes.len(), 10);
    for (id, want) in nodes {
        assert_eq!(normalize(&view(&mut e, "node", json!({}), id)), normalize(want), "node {id}");
    }
}

/// Nodes whose packet logs are recorded (b161 and 9b0f relayed by relay byte
/// and traceroute, 1224 sent only, 011e neither) and logical packets whose
/// routes are (traceroutes relayed by b161, a telemetry packet it relayed,
/// and a NodeInfo heard by four gateways).
const LOG_NODES: &[&str] = &["!b1610d41", "!9b0f4bd5", "!1224405f", "!011e7098"];
const ROUTES: &[&str] = &["5b183f9a5eda8a24", "cfad293b363dece8", "6d56465f5dec6de5", "e57c03ceeb34b221"];

/// Every view kind with default options (CLIENT_MUTE, MQTT-link, move and signal rules on),
/// engine-only fields kept: locks the engine's current behaviour.
#[test]
fn engine_matches_its_recorded_views() {
    let expected: Value = serde_json::from_str(EXPECTED).unwrap();
    let mut e = Engine::new();
    e.set_options(&json!({ "geo": expected["geolocation"] }).to_string()).unwrap();
    e.add_rows(ROWS, f64::NEG_INFINITY).unwrap();
    let (s, t) = (millis(expected["window"]["start"].as_str().unwrap()), millis(expected["window"]["end"].as_str().unwrap()));
    let view = |e: &mut Engine, kind: &str, filters: Value, arg: &str| -> Value { serde_json::from_str(&e.view(kind, s, t, &filters.to_string(), arg).unwrap()).unwrap() };
    let per = |e: &mut Engine, kind: &str, args: &mut dyn Iterator<Item = &str>| -> Value { Value::Object(args.map(|a| (a.to_string(), view(e, kind, json!({}), a))).collect()) };

    let got = json!({
        "snapshot": view(&mut e, "snapshot", json!({}), ""),
        "traffic": view(&mut e, "traffic", json!({}), ""),
        "snapshot_position_nodeinfo": view(&mut e, "snapshot", json!({"types": ["position", "nodeinfo"]}), ""),
        "nodes": per(&mut e, "node", &mut expected["nodes"].as_object().unwrap().keys().map(String::as_str)),
        "packetlogs": per(&mut e, "packetlog", &mut LOG_NODES.iter().copied()),
        "routes": per(&mut e, "route", &mut ROUTES.iter().copied()),
        "health": view(&mut e, "health", json!({}), ""),
    });
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/mesh-12h/engine.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some_and(|v| !v.is_empty()) {
        std::fs::write(path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
        return;
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("engine.json (UPDATE_GOLDEN=1 records it)")).unwrap();
    for k in ["snapshot", "traffic", "snapshot_position_nodeinfo", "health"] {
        assert_eq!(norm(&got[k], false), norm(&want[k], false), "{k}");
    }
    for k in ["nodes", "packetlogs", "routes"] {
        let (g, w) = (got[k].as_object().unwrap(), want[k].as_object().unwrap());
        assert_eq!(g.keys().collect::<Vec<_>>(), w.keys().collect::<Vec<_>>(), "{k}");
        for (a, x) in g {
            assert_eq!(norm(x, false), norm(&w[a], false), "{k} {a}");
        }
    }
}

#[test]
fn time_parsing_matches_the_formatter() {
    assert_eq!(millis("2026-10-31T02:37:49.260Z"), 1_793_414_269_260.0);
    assert_eq!(millis("2026-10-31T02:37:49.260123Z"), 1_793_414_269_260.0);
    assert_eq!(millis("2026-10-31T02:37:49Z"), 1_793_414_269_000.0);
}
