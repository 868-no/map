//! Map reports name nodes heard no other way, and their preset counts only
//! when a default channel confirms it (firmware reports the stored preset
//! even under a custom modem config).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z

fn report(i: i64, src: u32, t: i64, mr: Value) -> Value {
    let mut r = json!({"i": i, "t": t, "b": "it", "s": src, "g": src, "y": "mapreport", "l": format!("{i:016x}"), "o": format!("{:016x}", i + 100),
        "sg": "not-applicable", "cr": "mqtt_map_report", "rr": "own_packet",
        "po": {"lat": 64.02, "lon": 11.54, "precision_bits": 15, "precision_known": true}});
    r["mr"] = mr;
    r
}

fn view(e: &mut Engine, kind: &str, arg: &str) -> Value {
    serde_json::from_str(&e.view(kind, T0 as f64, (T0 + 3_600_000) as f64, "{}", arg).unwrap()).unwrap()
}

#[test]
fn a_map_report_names_a_node_without_nodeinfo_and_nodeinfo_wins() {
    let ntmk = json!({"region": "EU_868", "modem_preset": "LONG_FAST", "long_name": "NT Motorklubb", "short_name": "NTMK", "hw_model": "SEEED_XIAO_S3", "role": "CLIENT_BASE"});
    let rows = json!([
        report(1, 0xae609008, T0 + 60_000, ntmk),
        report(2, 0x0b00000b, T0 + 60_000, json!({"long_name": "From report", "modem_preset": "MEDIUM_FAST", "has_default_channel": true})),
        {"i": 3, "t": T0 + 120_000, "b": "it", "s": 0x0b00000b, "g": 0x0c00000c, "y": "nodeinfo", "l": "0000000000000003", "o": "0000000000000103",
         "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "ni": {"long_name": "From NodeInfo"}},
    ]);
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    let snap = view(&mut e, "snapshot", "");
    let node = |id: &str| snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == id).cloned().unwrap();
    let a = node("!ae609008");
    assert_eq!(a["identity"]["long_name"], "NT Motorklubb");
    assert_eq!(a["identity"]["short_name"], "NTMK");
    assert_eq!(a["identity"]["role"], "CLIENT_BASE");
    assert_eq!(a["identity"]["source"], "mapreport");
    let b = node("!0b00000b");
    assert_eq!(b["identity"]["long_name"], "From NodeInfo", "NodeInfo beats a map report");
    assert!(b["identity"]["source"].is_null());

    let d = view(&mut e, "node", "!ae609008");
    assert_eq!(d["identity"]["long_name"], "NT Motorklubb", "the node panel too");
    assert_eq!(d["radio"]["reported"]["modem_preset"], "LONG_FAST");
    assert!(d["radio"]["reported"]["preset_confirmed"].is_null(), "no default channel: the preset is not confirmed");
    let d = view(&mut e, "node", "!0b00000b");
    assert_eq!(d["radio"]["reported"]["preset_confirmed"], true);
}
