//! Moving nodes (D-073): links only from after the latest move, trails, and airborne.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000;
const M: u32 = 0x0a0000a1; // the node that moves
const G: u32 = 0x0b0000b2; // a gateway that hears it directly

fn pos(i: i64, t: i64, lat: f64, bits: u32, alt: Option<i32>) -> Value {
    let mut p = json!({"lat": lat, "lon": 10.4, "precision_bits": bits, "precision_known": true});
    if let Some(a) = alt {
        p["alt"] = json!(a);
    }
    json!({"i": i, "t": T0 + t * 60_000, "b": "it", "s": M, "g": G, "y": "position", "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000),
        "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "dr": true, "po": p})
}

fn snapshot(rows: Value) -> Value {
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap()
}

fn node(s: &Value, n: u32) -> Value {
    s["nodes"].as_array().unwrap().iter().find(|x| x["id"] == format!("!{n:08x}")).cloned().unwrap()
}

fn link_samples(s: &Value) -> Option<u64> {
    s["edges"].as_array().unwrap().iter().find(|e| e["src"] == format!("!{M:08x}") && e["dst"] == format!("!{G:08x}")).map(|e| e["samples"].as_u64().unwrap())
}

#[test]
fn a_move_drops_older_link_evidence_and_leaves_a_trail() {
    // Heard directly at 63.40 three times, then 2 km north twice.
    let rows = json!([pos(1, 1, 63.40, 32, None), pos(2, 2, 63.40, 32, None), pos(3, 3, 63.40, 32, None), pos(4, 10, 63.418, 32, None), pos(5, 11, 63.418, 32, None)]);
    let s = snapshot(rows);
    let n = node(&s, M);
    assert_eq!(n["moved_at"], "2026-10-31T00:10:00.000Z");
    assert_eq!(n["track"].as_array().unwrap().len(), 2, "one point per distinct place");
    assert_eq!(link_samples(&s), Some(2), "only the receptions after the move count");
}

#[test]
fn jumping_between_coarse_cells_is_not_a_move() {
    // 13-bit positions one cell (~4.9 km) apart: precision, not movement.
    let rows = json!([pos(1, 1, 63.40, 13, None), pos(2, 10, 63.444, 13, None)]);
    let s = snapshot(rows);
    assert!(node(&s, M)["moved_at"].is_null());
    assert_eq!(link_samples(&s), Some(2));
}

#[test]
fn airborne_needs_height_and_movement() {
    // Moving at 1200 m: airborne.
    let s = snapshot(json!([pos(1, 1, 63.40, 32, Some(1100)), pos(2, 5, 63.45, 32, Some(1200))]));
    assert_eq!(node(&s, M)["airborne"], true);
    // A mountain site at 1600 m that stays put: not.
    let s = snapshot(json!([pos(1, 1, 63.40, 32, Some(1600)), pos(2, 5, 63.40, 32, Some(1600))]));
    assert!(node(&s, M)["airborne"].is_null());
    // Moving at sea level: not.
    let s = snapshot(json!([pos(1, 1, 63.40, 32, Some(20)), pos(2, 5, 63.45, 32, Some(20))]));
    assert!(node(&s, M)["airborne"].is_null());
}
