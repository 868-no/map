//! Channels per node and the modem preset inferred through radio contact (D-064).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000;
const G: u32 = 0x0c00000c; // gateway on a confirmed NarrowFast mesh
const A: u32 = 0x0a00000a;
const X: u32 = 0x0e00000e; // gateway on a separate LongFast mesh
const Y: u32 = 0x0f00000f;

fn rx(i: i64, src: u32, gw: u32, ch: &str, direct: bool) -> Value {
    json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": src, "g": gw, "y": "text", "c": ch, "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000),
        "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": if direct { 3 } else { 2 }, "dr": direct})
}
fn report(i: i64, src: u32, ch: &str, preset: &str, default_channel: bool) -> Value {
    json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": src, "g": src, "y": "mapreport", "c": ch, "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000),
        "sg": "not-applicable", "mr": {"modem_preset": preset, "has_default_channel": default_channel}})
}
fn radio(e: &mut Engine, id: u32) -> Value {
    let d: Value = serde_json::from_str(&e.view("node", T0 as f64, (T0 + 3_600_000) as f64, "{}", &format!("!{id:08x}")).unwrap()).unwrap();
    d["radio"].clone()
}
fn engine(rows: Value) -> Engine {
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    e
}

#[test]
fn channels_come_from_uplinks_and_the_map_report() {
    let mut e = engine(json!([
        report(1, G, "NarrowFast", "NARROW_FAST", true),
        rx(2, A, G, "NarrowFast", true),
        rx(3, A, G, "NarrowFast", true),
        rx(4, A, G, "Secret", false), // A is on a second channel too
    ]));
    let a = radio(&mut e, A);
    assert_eq!(a["channels"], json!([{"name": "NarrowFast", "sent": 2, "uplinked": 0}, {"name": "Secret", "sent": 1, "uplinked": 0}]));
    let g = radio(&mut e, G);
    assert_eq!(g["channels"], json!([{"name": "NarrowFast", "sent": 0, "uplinked": 2, "primary": true}, {"name": "Secret", "sent": 0, "uplinked": 1}]));
    assert_eq!(g["preset"]["basis"], "map_report");
    // A heard G directly: they share radio settings, so A is on G's confirmed preset.
    assert_eq!(a["preset"], json!({"preset": "NARROW_FAST", "basis": "radio_contact", "via": ["!0c00000c"], "group": 1, "direct": 1}));
}

#[test]
fn separate_meshes_keep_their_own_presets_and_a_bridge_shows_a_conflict() {
    let rows = json!([
        report(1, G, "NarrowFast", "NARROW_FAST", true),
        rx(2, A, G, "NarrowFast", true),
        report(3, X, "LongFast", "LONG_FAST", true),
        rx(4, Y, X, "LongFast", true),
        report(5, Y, "Custom", "LONG_FAST", false), // unconfirmed: not evidence
    ]);
    let mut e = engine(rows.clone());
    assert_eq!(radio(&mut e, A)["preset"]["preset"], "NARROW_FAST");
    assert_eq!(radio(&mut e, Y)["preset"], json!({"preset": "LONG_FAST", "basis": "radio_contact", "via": ["!0e00000e"], "group": 1, "direct": 1}));

    // One node heard directly on both meshes would mean they share settings: the evidence conflicts.
    let mut both = rows.as_array().unwrap().clone();
    both.push(rx(6, 0x0d00000d, G, "NarrowFast", true));
    both.push(rx(7, 0x0d00000d, X, "LongFast", true));
    let mut e = engine(Value::Array(both));
    let p = radio(&mut e, A)["preset"].clone();
    assert_eq!(p["basis"], "conflict");
    assert!(p["preset"].is_null());
    assert_eq!(p["conflict"], json!([["LONG_FAST", 1], ["NARROW_FAST", 1]]));
}

#[test]
fn channel_names_are_only_a_hint_and_zero_db_hops_do_not_join_groups() {
    let tr = |i: i64, snr: f64| {
        json!({"i": i, "t": T0 + i * 1000, "b": "it", "s": A, "d": Y, "g": G, "y": "traceroute", "c": "NarrowFast", "l": format!("{i:016x}"), "o": format!("{:016x}", i + 1000),
            "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "tr": {"valid": true, "is_reply": false, "route": [], "snr_towards": [snr], "route_back": [], "snr_back": []}})
    };
    let mut e = engine(json!([rx(1, A, G, "NarrowFast", false), report(2, X, "LongFast", "LONG_FAST", true), tr(3, 0.0)]));
    // A's only evidence is the default channel name it was heard on.
    assert_eq!(radio(&mut e, A)["preset"], json!({"preset": "NARROW_FAST", "basis": "channel_name", "group": 0, "direct": 0}));
    assert!(radio(&mut e, Y)["preset"].is_null(), "a hop at exactly 0 dB may be MQTT: no radio contact");
    let mut e = engine(json!([report(2, Y, "LongFast", "LONG_FAST", true), tr(3, 6.5)]));
    assert_eq!(radio(&mut e, A)["preset"]["basis"], "radio_contact", "a real traceroute hop is radio contact");
}

#[test]
fn health_and_the_node_panel_agree_on_a_nodes_preset() {
    // The mesh is heard on NarrowFast. A confirms LONG_FAST in its own map
    // report, yet is heard only on a secondary channel named MediumFast.
    let mut rows: Vec<Value> = (10..20).map(|i| rx(i, Y, G, "NarrowFast", true)).collect();
    rows.push(report(1, A, "MediumFast", "LONG_FAST", true));
    rows.extend((2..5).map(|i| rx(i, A, G, "MediumFast", false)));
    let mut e = engine(Value::Array(rows));
    assert_eq!(radio(&mut e, A)["preset"]["preset"], "LONG_FAST");
    let h: Value = serde_json::from_str(&e.view("health", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    let issue = h["issues"].as_array().unwrap().iter().find(|x| x["kind"] == "preset" && x["node"] == format!("!{A:08x}")).expect("flagged").clone();
    assert_eq!(issue["summary"], "Uses Long Fast while the mesh uses Narrow Fast", "the confirmed report outranks the channel name, in both");
}
