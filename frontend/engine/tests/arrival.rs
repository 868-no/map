//! An anchored node that arrived from a trip in the window moved: its stay
//! began when it came back, so earlier contacts were made elsewhere; a single
//! far reading stays a GPS spike (D-181).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z
const MIN: i64 = 60_000;
const HOME: (f64, f64) = (61.8791, 10.1843);

/// One Position packet from !00000005 at (lat, lon, alt), 14-bit precision.
fn report(k: i64, (lat, lon): (f64, f64), alt: i32) -> Value {
    json!({"i": k, "t": T0 + k * 10 * MIN, "b": "x", "g": 7, "s": 5, "d": 4294967295u32, "p": 100 + k, "y": "position", "l": format!("{:016x}", 0xa00 + k),
           "o": format!("{:016x}", 0xb00 + k), "sg": "unsigned", "sn": 5.0, "rs": -110, "hs": 3, "hl": 2, "rr": "relayed",
           "po": {"lat": lat, "lon": lon, "alt": alt, "precision_bits": 14, "precision_known": true}})
}

fn node(rows: Vec<Value>) -> Value {
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows).to_string(), f64::NEG_INFINITY).unwrap();
    let snap: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 24 * 60 * MIN) as f64, "{}", "").unwrap()).unwrap();
    snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "!00000005").cloned().unwrap()
}

#[test]
fn a_node_that_flew_in_and_settled_moved_when_it_arrived() {
    let mut rows = vec![report(0, (59.07, 8.59), 9949), report(1, (59.39, 9.35), 7192), report(2, (59.99, 10.97), 1518)];
    rows.extend((3..9).map(|k| report(k, HOME, 818)));
    let n = node(rows);
    assert!(!n["refined"].is_null() || !n["position"].is_null(), "{n}");
    assert_eq!(n["moved_at"], "2026-10-31T00:30:00.000Z", "it arrived with its first report home: {n}");
    assert!(n["airborne"].is_null() || n["airborne"] == false, "at rest at 818 m, not airborne: {n}");
}

#[test]
fn one_far_reading_at_home_is_a_spike() {
    let mut rows: Vec<Value> = (0..8).map(|k| report(k, HOME, 818)).collect();
    rows[3] = report(3, (61.07, 10.42), 171);
    let n = node(rows);
    assert!(n["moved_at"].is_null(), "{n}");
}
