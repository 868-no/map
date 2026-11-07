//! Nodes past the snapshot's node limit get no health checks (D-182).

use meshmap_engine::Engine;
#[test]
fn a_node_past_the_node_limit_gets_no_health_issues() {
    let mut rows = vec![];
    let mut id = 1;
    // B (0xb) sends 50 packets heard by gateway G (0x9); A (0xa) 12 packets only it uplinked.
    for k in 0..50 { rows.push(format!(r#"{{"i":{id},"t":{},"b":"x","g":9,"s":11,"d":4294967295,"p":{id},"y":"text","l":"{id:016x}","o":"{id:016x}","sg":"unsigned","rr":"relayed","hs":3,"hl":2}}"#, 1000 + k * 60_000)); id += 1; }
    for k in 0..12 { rows.push(format!(r#"{{"i":{id},"t":{},"b":"x","g":10,"s":10,"d":4294967295,"p":{id},"y":"text","l":"{id:016x}","o":"{id:016x}","sg":"unsigned","rr":"own_packet","hs":3,"hl":3}}"#, 2000 + k * 60_000)); id += 1; }
    let mut e = Engine::new();
    e.add_rows(&format!("[{}]", rows.join(",")), f64::NEG_INFINITY).unwrap();
    e.set_options(r#"{"max_nodes": 2}"#).unwrap();
    let snap: serde_json::Value = serde_json::from_str(&e.view("snapshot", 0.0, 1e13, "{}", "").unwrap()).unwrap();
    assert!(!snap["nodes"].as_array().unwrap().iter().any(|n| n["id"] == "!0000000a"), "it is past the cut");
    let h: serde_json::Value = serde_json::from_str(&e.view("health", 0.0, 1e13, "{}", "").unwrap()).unwrap();
    assert!(!h["issues"].as_array().unwrap().iter().any(|i| i["node"] == "!0000000a"), "D-182: nodes beyond the cut get no health checks");
}
