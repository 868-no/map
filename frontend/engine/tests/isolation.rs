//! Spec §17 tests 11-14, the engine's half: every derived field comes only
//! from rows inside [start, end) (the server's half is that /observations
//! returns exactly those rows: backend test/integration TestTemporalIsolation).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const H: f64 = 3_600_000.0;
const T0: f64 = 1_793_404_800_000.0; // 2026-10-31T00:00:00Z
const A: &str = "!0a00000a";

fn rows() -> String {
    let row = |i: i64, t: f64, y: &str, extra: Value| {
        let mut r = json!({"i": i, "t": t as i64, "b": "it", "s": 0x0a00000a, "g": 0x0c00000c, "y": y,
            "l": format!("{i:016x}"), "o": format!("{:016x}", i + 100), "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "dr": true});
        r.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        r
    };
    json!([
        row(1, T0 + H, "nodeinfo", json!({"ni": {"long_name": "OldName"}})),
        row(2, T0 + H, "position", json!({"po": {"lat": 63.0, "lon": 10.4, "precision_bits": 32, "precision_known": true}})),
        row(3, T0 + 5.0 * H, "telemetry", json!({"te": {"kind": "device", "battery": 80.0}})),
        row(4, T0 + 9.0 * H, "nodeinfo", json!({"ni": {"long_name": "NewName"}})),
        row(5, T0 + 9.0 * H, "position", json!({"po": {"lat": 64.0, "lon": 10.4, "precision_bits": 32, "precision_known": true}})),
    ])
    .to_string()
}

#[test]
fn derived_fields_come_only_from_the_window() {
    let mut e = Engine::new();
    e.add_rows(&rows(), f64::NEG_INFINITY).unwrap();
    let node = |e: &mut Engine, s: f64, t: f64| -> Option<Value> {
        let snap: Value = serde_json::from_str(&e.view("snapshot", s, t, "{}", "").unwrap()).unwrap();
        snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == A).cloned()
    };
    let name = |n: &Value| n["identity"]["long_name"].as_str().map(str::to_string);
    let lat = |n: &Value| n["position"]["lat"].as_f64();
    let (t1, t2, t3) = (T0 + H, T0 + 5.0 * H, T0 + 9.0 * H);

    let n = node(&mut e, t2 - H, t2 + H).expect("observed through its telemetry");
    assert_eq!((name(&n), lat(&n)), (None, None), "only T2: neither name nor position (tests 11/12)");
    let n = node(&mut e, t1 - H, t2 + H).unwrap();
    assert_eq!((name(&n), lat(&n)), (Some("OldName".into()), Some(63.0)), "T1 not T3");
    let n = node(&mut e, t2 - H, t3 + H).unwrap();
    assert_eq!((name(&n), lat(&n)), (Some("NewName".into()), Some(64.0)), "T3 not T1");
    let n = node(&mut e, t1 - H, t3).unwrap();
    assert_eq!(name(&n), Some("OldName".into()), "end exactly at T3 hides the rename (test 14)");
    assert!(node(&mut e, t1, t1 + H).is_some(), "start exactly at T1 includes it (test 13)");
    assert!(node(&mut e, t1 + 1.0, t1 + 2.0 * H).is_none(), "start 1 ms after T1 excludes it (test 13)");
    assert!(node(&mut e, t1 - H, t1).is_none(), "end exactly at T1 excludes it (test 13)");
    let detail: Value = serde_json::from_str(&e.view("node", t2 - H, t2 + H, "{}", A).unwrap()).unwrap();
    assert!(detail["identity"].is_null() && detail["positions"].as_array().unwrap().is_empty(), "node detail obeys the window");
    assert_eq!(e.view("node", t1, t3, "{}", "!0b00000b").unwrap(), "null", "absent node");
}
