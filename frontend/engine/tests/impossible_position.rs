//! A reported position that a direct reception rules out is ignored, and
//! Health says so (D-178).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z
const GW: u32 = 0x0000_0007;
const OTHER_GW: u32 = 0x0000_0008;
const NODE: u32 = 0x0000_0005;

/// A Position copy at (lat, lon), heard by `gw` at `rssi`, directly or relayed.
fn position(i: i64, t: i64, src: u32, gw: u32, lp: &str, (lat, lon): (f64, f64), (direct, rssi): (bool, i32)) -> Value {
    json!({"i": i, "t": t, "b": "x", "g": gw, "s": src, "d": 4294967295u32, "p": 100 + i, "y": "position", "l": lp, "o": format!("{:016x}", 0x100 + i),
           "sg": "unsigned", "sn": 10.0, "rs": rssi, "hs": 3, "hl": if direct { 3 } else { 2 }, "rr": if direct { "zero_hop_rf" } else { "relayed" }, "dr": direct,
           "po": {"lat": lat, "lon": lon, "precision_bits": 32, "precision_known": true}})
}

fn engine(rows: Value) -> Engine {
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    e
}

fn node(e: &mut Engine, id: &str) -> Value {
    let snap: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == id).cloned().expect("the node")
}

#[test]
fn a_position_heard_directly_from_far_beyond_its_signal_is_ignored() {
    let mut e = engine(json!([
        position(1, T0, GW, GW, "00000000000000a1", (63.3930, 10.4268), (true, -20)), // the gateway's own report
        position(2, T0 + 1_000, OTHER_GW, OTHER_GW, "00000000000000a2", (63.3537, 10.3612), (true, -20)),
        position(3, T0 + 60_000, NODE, GW, "00000000000000b1", (63.3930, 63.3930), (true, -43)), // heard directly, nearby
        position(4, T0 + 60_500, NODE, OTHER_GW, "00000000000000b1", (63.3930, 63.3930), (false, -81)), // relayed: judges nothing
    ]));
    let n = node(&mut e, "!00000005");
    assert!(n["position"].is_null(), "ignored: {n}");
    assert_eq!(n["rejected_position"]["gateway"], "!00000007", "{n}");
    assert!(n["rejected_position"]["distance_m"].as_f64().unwrap() > 1_000_000.0, "{n}");
    let health: Value = serde_json::from_str(&e.view("health", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    assert!(health.to_string().contains("position_contradicted"), "{health}");
    let d: Value = serde_json::from_str(&e.view("node", T0 as f64, (T0 + 3_600_000) as f64, "{}", "!00000005").unwrap()).unwrap();
    assert_eq!(d["positions"].as_array().unwrap().len(), 0, "not in its history: {}", d["positions"]);
}

#[test]
fn a_position_within_its_signal_stays_and_one_wrong_gateway_cannot_outvote_the_rest() {
    let mut e = engine(json!([
        position(1, T0, GW, GW, "00000000000000a1", (59.9, 10.7), (true, -20)), // this gateway's own place is wrong (Oslo)
        position(2, T0 + 1_000, OTHER_GW, OTHER_GW, "00000000000000a2", (63.36, 10.37), (true, -20)),
        position(3, T0 + 2_000, 0x0000_0009, 0x0000_0009, "00000000000000a3", (63.40, 10.40), (true, -20)),
        position(4, T0 + 60_000, NODE, GW, "00000000000000b1", (63.39, 10.42), (true, -45)),
        position(5, T0 + 60_100, NODE, OTHER_GW, "00000000000000b1", (63.39, 10.42), (true, -70)),
        position(6, T0 + 60_200, NODE, 0x0000_0009, "00000000000000b1", (63.39, 10.42), (true, -60)),
    ]));
    let n = node(&mut e, "!00000005");
    assert!(n["rejected_position"].is_null(), "{n}");
    assert_eq!(n["position"]["lon"], 10.42, "{n}");
}
