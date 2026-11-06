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

fn snapshot(rows: &Value) -> Value {
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
    let s = snapshot(&rows);
    let n = node(&s, M);
    assert_eq!(n["moved_at"], "2026-10-31T00:10:00.000Z");
    assert_eq!(n["track"].as_array().unwrap().len(), 2, "one point per distinct place");
    assert_eq!(link_samples(&s), Some(2), "only the receptions after the move count");
}

#[test]
fn jumping_between_coarse_cells_is_not_a_move() {
    // 13-bit positions one cell (~4.9 km) apart: precision, not movement.
    let rows = json!([pos(1, 1, 63.40, 13, None), pos(2, 10, 63.444, 13, None)]);
    let s = snapshot(&rows);
    assert!(node(&s, M)["moved_at"].is_null());
    assert_eq!(link_samples(&s), Some(2));
}

#[test]
fn airborne_needs_height_and_movement() {
    // Moving at 1200 m: airborne.
    let s = snapshot(&json!([pos(1, 1, 63.40, 32, Some(1100)), pos(2, 5, 63.45, 32, Some(1200))]));
    assert_eq!(node(&s, M)["airborne"], true);
    // A mountain site at 1600 m that stays put: not.
    let s = snapshot(&json!([pos(1, 1, 63.40, 32, Some(1600)), pos(2, 5, 63.40, 32, Some(1600))]));
    assert!(node(&s, M)["airborne"].is_null());
    // Moving at sea level: not.
    let s = snapshot(&json!([pos(1, 1, 63.40, 32, Some(20)), pos(2, 5, 63.45, 32, Some(20))]));
    assert!(node(&s, M)["airborne"].is_null());
}

#[test]
fn a_slow_mover_counts_once_it_has_drifted_far_enough() {
    // 150 m steps (well under 300 m each), heard directly at every one of them.
    let step = 150.0 / 111_320.0;
    let rows: Vec<Value> = (0..6).map(|k| pos(k + 1, k * 5, 63.40 + step * k as f64, 32, None)).collect();
    let s = snapshot(&Value::Array(rows));
    let n = node(&s, M);
    // 300 m from the start after the third step: moved then; the next reference is there.
    assert_eq!(n["moved_at"], "2026-10-31T00:15:00.000Z", "{n}");
    assert_eq!(n["track"].as_array().unwrap().len(), 6);
    assert_eq!(link_samples(&s), Some(3), "receptions from its current place on");
}

#[test]
fn precise_positions_decide_even_with_coarse_map_reports_in_between() {
    // 32-bit positions 700 m apart, with 13-bit reports of the same places mixed in:
    // judged on the precise ones alone, so the move is seen.
    let east = 700.0 / 111_320.0;
    let rows = json!([pos(1, 1, 63.40, 32, None), pos(2, 2, 63.40, 13, None), pos(3, 10, 63.40 + east, 32, None), pos(4, 11, 63.40 + east, 13, None)]);
    assert_eq!(node(&snapshot(&rows), M)["moved_at"], "2026-10-31T00:10:00.000Z");
}


// D-077: reports jumping around one place narrow down where the node is.
const CELL15: f64 = 1e-7 * 131_072.0; // a 15-bit cell, in degrees

#[test]
fn jitter_across_a_cell_edge_picks_a_cell_but_never_goes_finer_than_shared() {
    // Reports alternate between two cells either side of an edge, one more often.
    // Design §6.10: no narrowing to the edge between them, only the better-supported cell.
    let (south, north) = (63.40, 63.40 + CELL15);
    let rows: Vec<Value> = [south, north, south, north, south, south].iter().enumerate().map(|(k, &lat)| pos(k as i64 + 1, k as i64 * 10, lat, 15, None)).collect();
    let n = node(&snapshot(&Value::Array(rows)), M);
    assert!(n["refined"].is_null(), "the latest report already names that cell at that precision: nothing to add");
    assert!(n["moved_at"].is_null(), "jitter is not movement");
    assert!((n["position"]["lat"].as_f64().unwrap() - south).abs() < 1e-9);
}

#[test]
fn nested_precisions_narrow_to_the_finest_cell() {
    // 15-bit positions and coarse 13-bit map reports of the same spot, the latest a coarse one.
    let rows: Vec<Value> = (0..6).map(|k| pos(k + 1, k * 10, 63.40, if k % 2 == 0 { 15 } else { 13 }, None)).collect();
    let r = node(&snapshot(&Value::Array(rows)), M)["refined"].clone();
    assert!(r["radius_m"].as_f64().unwrap() < 900.0, "the 15-bit cell, not the 13-bit one: {r}");
}

#[test]
fn one_off_noise_is_set_aside_without_false_precision() {
    // A home cell reported again and again, and scattered one-off readings within a few km.
    let mut rows: Vec<Value> = (0..7).map(|k| pos(k + 1, k * 8, 63.40, 15, None)).collect();
    rows.insert(2, pos(20, 15, 63.40 + 2.0 * CELL15, 15, None));
    rows.insert(5, pos(21, 35, 63.40 - 3.0 * CELL15, 15, None));
    let n = node(&snapshot(&Value::Array(rows)), M);
    let r = &n["refined"];
    assert_eq!((r["agree"].as_u64(), r["reports"].as_u64()), (Some(7), Some(9)), "{r}");
    assert!((r["lat"].as_f64().unwrap() - 63.40).abs() < 1e-9, "the home cell");
    assert!(r["radius_m"].as_f64().unwrap() > 700.0, "only as sure as the home cell itself: {r}");
    assert!(n["moved_at"].is_null(), "noise is not movement");
}

#[test]
fn noise_beyond_small_jitter_gets_no_false_precision() {
    // FerretNet on 2026-11-01: a home cell, and cells touching it at opposite
    // corners (2.6 km apart). No single corner fits them all: the home cell only.
    let c = 1e-7 * 524_288.0; // 13-bit cell
    let at = |i: i64, t: i64, dlat: f64, dlon: f64| {
        json!({"i": i, "t": T0 + t * 60_000, "b": "it", "s": M, "g": G, "y": "position", "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000),
            "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "dr": true, "po": {"lat": 59.899904 + dlat, "lon": 10.8265472 + dlon, "precision_bits": 13, "precision_known": true}})
    };
    let rows = json!([at(1, 1, 0.0, 0.0), at(2, 5, c, -c), at(3, 9, c, c), at(4, 13, c, -c), at(5, 17, 0.0, 0.0), at(6, 21, 0.0, 0.0), at(7, 25, 0.0, 0.0)]);
    let n = node(&snapshot(&rows), M);
    let r = &n["refined"];
    assert!(r.is_null() || r["radius_m"].as_f64().unwrap() > 3000.0, "no corner claim: {r}");
    assert!(n["moved_at"].is_null());
}


fn nodeinfo(i: i64, role: &str) -> Value {
    json!({"i": i, "t": T0, "b": "it", "s": M, "g": G, "y": "nodeinfo", "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000),
        "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "dr": true, "ni": {"long_name": "R", "role": role}})
}

// D-139: a router's unstable GPS wanders hundreds of metres, in runs of
// readings, around one place. Precise readings never repeat, so they are
// judged around the one nearest all the others. For a router that is noise:
// no move, no trail, every reception counts. The same wander from a client
// is movement, as before.
#[test]
fn a_routers_unstable_gps_is_not_movement() {
    // Home at 63.408, readings never the same twice; twice it wanders ~900 m
    // south for two readings in a row (a single spike would be set aside anyway).
    let lats = [63.4080, 63.4082, 63.4001, 63.4003, 63.4079, 63.4083, 63.4000, 63.4002, 63.4081, 63.4084];
    let reports: Vec<Value> = lats.iter().enumerate().map(|(k, &lat)| pos(k as i64 + 1, k as i64 + 1, lat, 32, None)).collect();
    let mut with_role = reports.clone();
    with_role.push(nodeinfo(100, "ROUTER"));
    let s = snapshot(&Value::Array(with_role));
    assert!(node(&s, M)["moved_at"].is_null(), "a router's wandering GPS is no move");
    assert_eq!(link_samples(&s), Some(lats.len() as u64 + 1), "every reception counts");
    let mut client = reports;
    client.push(nodeinfo(100, "CLIENT"));
    assert!(!node(&snapshot(&Value::Array(client)), M)["moved_at"].is_null(), "the same wander from a client is movement");
}

// A router that really moves, kilometres away, still counts as moving.
#[test]
fn a_router_that_moves_far_still_moves() {
    let rows = json!([nodeinfo(100, "ROUTER"), pos(1, 1, 63.40, 32, None), pos(2, 2, 63.40, 32, None), pos(3, 10, 63.45, 32, None), pos(4, 11, 63.45, 32, None)]);
    assert!(!node(&snapshot(&rows), M)["moved_at"].is_null());
}
