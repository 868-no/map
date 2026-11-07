//! A late copy of an old packet (a gateway uplinking it again, hours on)
//! never stands in for a node's latest state (D-180).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z
const HOUR: i64 = 3_600_000;

fn telemetry(i: i64, t: i64, gw: u32, pid: u32, lp: &str, battery: f64, uptime: i64) -> Value {
    json!({"i": i, "t": t, "b": "x", "g": gw, "s": 5, "d": 4294967295u32, "p": pid, "y": "telemetry", "l": lp, "o": format!("{:016x}", 0x100 + i),
           "sg": "not-applicable", "sn": 5.0, "hs": 3, "hl": 2, "te": {"kind": "device", "battery": battery, "voltage": 3.9, "uptime": uptime}})
}

#[test]
fn a_late_copy_of_an_old_report_is_not_the_latest() {
    let rows = json!([
        telemetry(1, T0, 7, 50, "0000000000000001", 31.0, 551_440),
        telemetry(2, T0 + HOUR, 7, 51, "0000000000000002", 75.0, 3_600),
        telemetry(3, T0 + 36 * HOUR, 8, 50, "0000000000000001", 31.0, 551_440), // the first, uplinked again
    ]);
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    let (s, t) = (T0 as f64, (T0 + 37 * HOUR) as f64);

    let d: Value = serde_json::from_str(&e.view("node", s, t, "{}", "!00000005").unwrap()).unwrap();
    assert_eq!(d["telemetry"]["battery"], 75.0, "panel: {}", d["telemetry"]);
    assert_eq!(d["telemetry"]["uptime"], 3_600, "panel: {}", d["telemetry"]);
}

fn position(i: i64, t: i64, gw: u32, lp: i64, lat: f64) -> Value {
    json!({"i": i, "t": t, "b": "x", "g": gw, "s": 5, "d": 4294967295u32, "p": 100 + lp, "y": "position", "l": format!("{lp:016x}"), "o": format!("{:016x}", 0x100 + i),
           "sg": "not-applicable", "sn": 5.0, "hs": 3, "hl": 2, "po": {"lat": lat, "lon": 10.7, "precision_bits": 32, "precision_known": true}})
}

#[test]
fn a_late_copy_of_an_old_position_is_no_return_there() {
    const MIN: i64 = 60_000;
    // Three reports at 60.0, then three at 59.0; then the second 60.0 report uplinked again hours on.
    let rows = json!([
        position(1, T0, 7, 1, 60.0), position(2, T0 + 10 * MIN, 7, 2, 60.0), position(3, T0 + 20 * MIN, 7, 3, 60.0),
        position(4, T0 + 30 * MIN, 7, 4, 59.0), position(5, T0 + 40 * MIN, 7, 5, 59.0), position(6, T0 + 50 * MIN, 7, 6, 59.0),
        position(7, T0 + 300 * MIN, 8, 2, 60.0),
    ]);
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    let snap: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 400 * MIN) as f64, "{}", "").unwrap()).unwrap();
    let node = snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "!00000005").expect("the node");
    assert!(node["moved_at"].is_string(), "the move is kept: {node}");
    let track = node["track"].as_array().unwrap();
    assert_eq!(track.last().unwrap()["lat"], 59.0, "the trail ends where it went: {track:?}");
}
