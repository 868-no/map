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

    let snap: Value = serde_json::from_str(&e.view("snapshot", s, t, "{}", "").unwrap()).unwrap();
    let node = snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == "!00000005").expect("the node");
    assert_eq!(node["telemetry"]["battery"], 75.0, "snapshot: {}", node["telemetry"]);

    let d: Value = serde_json::from_str(&e.view("node", s, t, "{}", "!00000005").unwrap()).unwrap();
    assert_eq!(d["telemetry"]["battery"], 75.0, "panel: {}", d["telemetry"]);
    assert_eq!(d["telemetry"]["uptime"], 3_600, "panel: {}", d["telemetry"]);
}
