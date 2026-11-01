//! Directional 0-cost links (D-068) and reach (D-069) on a small mesh:
//! O - R1 - R2 - X - Y, with gateways G1..G3 reporting what they hear.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000;
const O: u32 = 0x0a0000a1;
const R1: u32 = 0x0b0000b2;
const R2: u32 = 0x0c0000c3;
const X: u32 = 0x0d0000d4;
const Y: u32 = 0x0e0000e5;
const G1: u32 = 0x1f0000f6;
const G2: u32 = 0x2f0000f7;
const G3: u32 = 0x3f0000f8;

/// A gateway reception: hop start/limit as the last transmitter sent them, and its low byte.
fn rx(i: i64, lp: i64, src: u32, gw: u32, hs: i16, hl: i16, relay: Option<u32>) -> Value {
    let mut r = json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": src, "g": gw, "y": "text", "c": "NarrowFast", "l": format!("{lp:016x}"), "o": format!("{i:016x}"),
        "sg": "unsigned", "sn": 5.0, "hs": hs, "hl": hl, "dr": hs == hl});
    if let Some(n) = relay {
        r["r"] = json!(n & 0xff);
    }
    r
}

/// NeighborInfo from `who`: the nodes it hears (so links neighbour -> who).
fn heard(i: i64, who: u32, nbs: &[u32]) -> Value {
    json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": who, "g": G1, "y": "neighborinfo", "l": format!("{:016x}", 0xff00 + i), "o": format!("{i:016x}"),
        "sg": "unsigned", "nb": {"neighbors": nbs.iter().map(|n| json!({"id": n, "snr": 6.0})).collect::<Vec<_>>()}})
}

fn role(i: i64, who: u32, role: &str) -> Value {
    json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": who, "g": G1, "y": "nodeinfo", "l": format!("{:016x}", 0xee00 + i), "o": format!("{i:016x}"),
        "sg": "unsigned", "ni": {"long_name": format!("n{i}"), "role": role}})
}

fn mesh(packets: i64, r2_free: bool) -> Vec<Value> {
    let mut rows = vec![
        heard(1, R1, &[O, R2]), heard(2, R2, &[R1, X]), heard(3, X, &[R2, Y]), heard(4, Y, &[X]),
        role(5, R1, "ROUTER"), role(6, R2, "ROUTER"),
    ];
    let mut i = 100;
    for p in 0..packets {
        let lp = 0x5000 + p;
        // O sends with hop limit 3; G1 hears it directly, G2 hears R1's rebroadcast (2 left),
        // G3 hears R2's rebroadcast of R1's copy: 2 left if R2 relays R1 for free, else 1.
        rows.push(rx(i, lp, O, G1, 3, 3, Some(O)));
        rows.push(rx(i + 1, lp, O, G2, 3, 2, Some(R1)));
        rows.push(rx(i + 2, lp, O, G3, 3, if r2_free { 2 } else { 1 }, Some(R2)));
        // The other way: Y's packets, R2 relaying to R1 always costs a hop.
        let back = 0x6000 + p;
        rows.push(rx(i + 3, back, Y, G1, 3, 2, Some(R2)));
        rows.push(rx(i + 4, back, Y, G2, 3, 1, Some(R1)));
        i += 10;
    }
    rows
}

fn engine(rows: Vec<Value>) -> Engine {
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows).to_string(), f64::NEG_INFINITY).unwrap();
    e
}

fn view(e: &mut Engine, kind: &str, arg: &str) -> Value {
    serde_json::from_str(&e.view(kind, T0 as f64, (T0 + 3_600_000) as f64, "{}", arg).unwrap()).unwrap()
}

fn edge(snap: &Value, src: u32, dst: u32) -> Value {
    let id = |n: u32| format!("!{n:08x}");
    snap["edges"].as_array().unwrap().iter().find(|e| e["src"] == id(src) && e["dst"] == id(dst) && e["mqtt"].is_null()).cloned().unwrap_or(Value::Null)
}

#[test]
fn zero_cost_is_detected_per_direction_on_repeated_evidence() {
    let mut e = engine(mesh(4, true));
    let snap = view(&mut e, "snapshot", "");
    assert_eq!(edge(&snap, R1, R2)["zero_cost"], json!({"free": 4, "spent": 0, "likely": true}), "R2 relays R1 for free");
    let back = &edge(&snap, R2, R1)["zero_cost"];
    assert_eq!(back["likely"], false, "but R1 spends a hop on what it hears from R2");
    assert_eq!(back["spent"], 4);
    assert!(edge(&snap, O, R1)["zero_cost"].is_null(), "the originator's hop always costs: no evidence");

    let mut e = engine(mesh(4, false));
    let z = edge(&view(&mut e, "snapshot", ""), R1, R2)["zero_cost"].clone();
    assert_eq!(z["likely"], false);
    assert_eq!(z["spent"], 4);

    let mut e = engine(mesh(1, true));
    assert_eq!(edge(&view(&mut e, "snapshot", ""), R1, R2)["zero_cost"]["likely"], false, "one packet is not enough");
}

#[test]
fn reach_counts_hops_and_saves_one_on_a_zero_cost_link() {
    let need = |r: &Value, n: u32| r["nodes"].as_array().unwrap().iter().find(|x| x["id"] == format!("!{n:08x}")).map(|x| x["need"].as_u64().unwrap());
    let mut e = engine(mesh(4, false));
    let r = view(&mut e, "reach", &format!("!{O:08x}"));
    assert_eq!((need(&r, R1), need(&r, R2), need(&r, X), need(&r, Y)), (Some(0), Some(1), Some(2), Some(3)));
    assert_eq!(r["hop_start"], 3, "its own packets' hop limit");
    let mut e = engine(mesh(4, true));
    let r = view(&mut e, "reach", &format!("!{O:08x}"));
    // R2 passes R1's copy on for free, so X and Y each need one hop less after it.
    assert_eq!((need(&r, R1), need(&r, R2), need(&r, X), need(&r, Y)), (Some(0), Some(1), Some(2), Some(2)));
    let x = r["nodes"].as_array().unwrap().iter().find(|n| n["id"] == format!("!{X:08x}")).unwrap();
    assert_eq!(x["via"], format!("!{R2:08x}"));

    // A CLIENT_MUTE in the chain stops it.
    let mut rows = mesh(4, false);
    rows.push(role(7, R2, "CLIENT_MUTE"));
    let mut e = engine(rows);
    let r = view(&mut e, "reach", &format!("!{O:08x}"));
    assert_eq!((need(&r, R2), need(&r, X)), (Some(1), None));
}
