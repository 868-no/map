//! A node that changed role in the window (D-177): a router that turned
//! CLIENT_MUTE relayed while it was a router, so it stays a relay candidate,
//! and a far node sharing its relay byte is not credited instead.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000;
const F: u32 = 0x94ed_7591; // near the gateway; router, then CLIENT_MUTE
const H: u32 = 0x6a73_4b91; // same last byte, far away
const G: u32 = 0xf6a6_fd67; // the gateway
const O: u32 = 0x0a00_00a0; // an originator

fn row(i: i64, t: i64, extra: Value) -> Value {
    let mut r = json!({"i": i, "t": T0 + t * 60_000, "b": "it", "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000), "sg": "unsigned"});
    r.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    r
}

fn nodeinfo(i: i64, t: i64, src: u32, role: &str, lat: f64, lon: f64) -> [Value; 2] {
    [
        row(i, t, json!({"s": src, "g": src, "y": "nodeinfo", "rr": "own_packet", "ni": {"long_name": format!("n{src:x}"), "role": role}})),
        row(i + 1, t, json!({"s": src, "g": src, "y": "position", "rr": "own_packet", "po": {"lat": lat, "lon": lon, "precision_bits": 32, "precision_known": true}})),
    ]
}

#[test]
fn a_router_that_turned_client_mute_is_still_the_relay() {
    let mut rows: Vec<Value> = vec![];
    rows.extend(nodeinfo(1, 0, F, "ROUTER", 63.52, 10.89));
    rows.extend(nodeinfo(3, 0, H, "ROUTER", 61.22, 7.12));
    rows.extend(nodeinfo(5, 0, G, "ROUTER_LATE", 63.39, 10.43));
    // Copies of O's packets relayed (byte 0x91) to G while F was a router...
    for k in 0..5 {
        rows.push(row(10 + k, 10 + k, json!({"s": O, "g": G, "y": "text", "hs": 3, "hl": 2, "r": 0x91, "sn": -6.0, "rs": -122})));
    }
    // ... then F turns CLIENT_MUTE.
    rows.push(nodeinfo(40, 50, F, "CLIENT_MUTE", 63.52, 10.89)[0].clone());
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows).to_string(), f64::NEG_INFINITY).unwrap();
    let s: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    let link = |src: u32| s["edges"].as_array().unwrap().iter().any(|x| x["src"] == format!("!{src:08x}") && x["dst"] == format!("!{G:08x}"));
    assert!(link(F), "the relay was F: {:#}", s["edges"]);
    assert!(!link(H), "never the far node sharing its byte");
}
