//! Gateways that uplink every copy they hear (D-084): the same packet from
//! one gateway several times, with different last hops.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000;
const M: u32 = 0x0d0000d4; // uplinks every copy
const G: u32 = 0x0c0000c3; // uplinks the first copy only (today's firmware)
const O: u32 = 0x0a0000a1; // where the packets come from
const A: u32 = 0x0b0000b1; // relays
const B: u32 = 0x0b0000b2;

fn row(i: i64, lp: i64, src: u32, gw: u32, hl: i16, relay: u32) -> Value {
    json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": src, "g": gw, "y": "text", "l": format!("{lp:016x}"), "o": format!("{i:016x}"),
        "sg": "unsigned", "sn": 4.0, "hs": 3, "hl": hl, "dr": hl == 3, "r": relay & 0xff})
}

fn flags(rows: Vec<Value>) -> (bool, bool, Value) {
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows).to_string(), f64::NEG_INFINITY).unwrap();
    let s: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    let flag = |n: u32| s["nodes"].as_array().unwrap().iter().find(|x| x["id"] == format!("!{n:08x}")).unwrap()["multi_uplink"] == json!(true);
    let detail: Value = serde_json::from_str(&e.view("node", T0 as f64, (T0 + 3_600_000) as f64, "{}", &format!("!{M:08x}")).unwrap()).unwrap();
    (flag(M), flag(G), detail["multi_uplink"].clone())
}

fn packets(n: i64) -> Vec<Value> {
    let mut rows = vec![];
    let mut i = 1;
    for k in 0..n {
        let lp = 0x100 + k;
        // M reports the packet three times: straight from O, via A, via B.
        rows.push(row(i, lp, O, M, 3, O));
        rows.push(row(i + 1, lp, O, M, 2, A));
        rows.push(row(i + 2, lp, O, M, 2, B));
        // G reports it once.
        rows.push(row(i + 3, lp, O, G, 3, O));
        i += 4;
    }
    rows
}

#[test]
fn a_gateway_reporting_several_copies_of_packets_uplinks_every_copy() {
    assert_eq!(flags(packets(3)), (true, false, json!(true)));
}

#[test]
fn a_couple_of_doubles_are_not_enough() {
    assert_eq!(flags(packets(2)), (false, false, Value::Null));
}

#[test]
fn a_reception_delivered_again_is_one_copy() {
    // Besides the usual traffic, G's one reception of three more packets each
    // arrives twice (a late re-upload, a bridge re-delivering after a
    // restart): another row, the same observation key.
    let mut rows = packets(3);
    for k in 0..3 {
        let lp = 0x200 + k;
        for i in [100 + k * 2, 101 + k * 2] {
            let mut r = row(i, lp, O, G, 3, O);
            r["o"] = json!(format!("{:016x}", 0x1000 + k));
            rows.push(r);
        }
    }
    assert_eq!(flags(rows), (true, false, json!(true)), "re-delivered receptions flagged G as uplinking every copy");
}
