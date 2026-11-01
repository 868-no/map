//! The engine against the retired server views, recorded for a real 12-hour
//! window (tests/fixtures/mesh-12h, D-041).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const ROWS: &str = include_str!("fixtures/mesh-12h/observations.json");
const EXPECTED: &str = include_str!("fixtures/mesh-12h/expected.json");

/// Times to whole milliseconds (the server kept microseconds), numbers to
/// 1e-4 as f64, heard lists by node, and engine-only fields (`source`, `radio`,
/// `mqtt_downlink`) dropped.
fn normalize(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
        Value::Object(o) => {
            let mut out = serde_json::Map::new();
            for (k, x) in o {
                if k == "source" || k == "radio" || k == "mqtt_downlink" {
                    continue;
                }
                let mut x = normalize(x);
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

#[test]
fn engine_matches_the_recorded_server_views() {
    let expected: Value = serde_json::from_str(EXPECTED).unwrap();
    let mut e = Engine::new();
    e.set_options(&json!({ "geo": expected["geolocation"], "silent_rule": false }).to_string()).unwrap();
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

#[test]
fn time_parsing_matches_the_formatter() {
    assert_eq!(millis("2026-10-31T02:37:49.260Z"), 1_793_414_269_260.0);
    assert_eq!(millis("2026-10-31T02:37:49.260123Z"), 1_793_414_269_260.0);
    assert_eq!(millis("2026-10-31T02:37:49Z"), 1_793_414_269_000.0);
}
