//! Routers' relaying (D-078): seen relays out of packets they should relay.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000;
const R: u32 = 0x0b0000b2; // a ROUTER that is also a gateway
const W: u32 = 0x0c0000c3; // a gateway that hears R (its witness)
const O: u32 = 0x0a0000a1; // where the packets come from

fn row(i: i64, lp: i64, src: u32, gw: u32, hs: i16, hl: i16, relay: Option<u32>) -> Value {
    let mut r = json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": src, "g": gw, "y": "text", "l": format!("{lp:016x}"), "o": format!("{i:016x}"),
        "sg": "unsigned", "sn": 4.0, "hs": hs, "hl": hl, "dr": hs == hl});
    if let Some(n) = relay {
        r["r"] = json!(n & 0xff);
    }
    r
}

#[test]
fn counts_relays_seen_by_a_witness_out_of_packets_it_received_with_hops_left() {
    let mut rows = vec![json!({"i": 1, "t": T0, "b": "it", "s": R, "g": W, "y": "nodeinfo", "l": "00000000000000ff", "o": "00000000000000ff",
        "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "dr": true, "ni": {"long_name": "R", "role": "ROUTER"}})];
    let mut i = 10;
    // W hears R directly: R's own packets, so W is R's witness.
    for k in 0..3 {
        rows.push(row(i, 0x100 + k, R, W, 3, 3, Some(R)));
        i += 1;
    }
    // 12 packets from O that R uplinked itself with hops left (so R should rebroadcast).
    // W got 9 of them through R's rebroadcast, and 3 straight from O (R's copy unseen).
    for k in 0..12 {
        let lp = 0x200 + k;
        rows.push(row(i, lp, O, R, 3, 3, Some(O)));
        rows.push(if k < 9 { row(i + 1, lp, O, W, 3, 2, Some(R)) } else { row(i + 1, lp, O, W, 3, 3, Some(O)) });
        i += 2;
    }
    // A packet nobody but R heard: no witness, so it does not count.
    rows.push(row(i, 0x300, O, R, 3, 3, Some(O)));
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows).to_string(), f64::NEG_INFINITY).unwrap();
    let s: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    let r = s["nodes"].as_array().unwrap().iter().find(|n| n["id"] == format!("!{R:08x}")).unwrap()["relaying"].clone();
    assert_eq!(r, json!({"expected": 12, "seen": 9, "witnesses": 1, "received_as_gateway": 12}));
}
