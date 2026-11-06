//! The snapshot's node limit is an option, kept until set again (D-182).

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z

fn nodes(e: &mut Engine) -> (usize, bool) {
    let s: Value = serde_json::from_str(&e.view("snapshot", T0 as f64, (T0 + 3_600_000) as f64, "{}", "").unwrap()).unwrap();
    (s["nodes"].as_array().unwrap().len(), s["counts"]["nodes_truncated"].as_bool().unwrap())
}

#[test]
fn the_node_limit_is_an_option_kept_until_set_again() {
    // Nodes 1, 2 and 3 each send one NodeInfo, uplinked by gateway 7.
    let rows: Vec<Value> = (1..=3)
        .map(|n: i64| json!({"i": n, "t": T0 + n * 1000, "b": "x", "g": 7, "s": n, "d": 4294967295u32, "p": 100 + n, "y": "nodeinfo", "l": format!("{:016x}", n), "o": format!("{:016x}", 0x100 + n),
            "sg": "unsigned", "sn": 5.0, "hs": 3, "hl": 3, "ni": {"long_name": format!("N{n}"), "short_name": format!("N{n}"), "hw_model": "HELTEC_V3", "role": "CLIENT", "has_public_key": false}}))
        .collect();
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows).to_string(), f64::NEG_INFINITY).unwrap();
    assert_eq!(nodes(&mut e), (4, false), "three senders and the gateway");
    let panel = |e: &mut Engine| -> Value { serde_json::from_str::<Value>(&e.view("node", T0 as f64, (T0 + 3_600_000) as f64, "{}", "!00000003").unwrap()).unwrap()["node"].clone() };
    let whole = panel(&mut e);
    e.set_options(&json!({"max_nodes": 2}).to_string()).unwrap();
    assert_eq!(nodes(&mut e), (2, true));
    assert_eq!(panel(&mut e), whole, "a node past the limit shows as the snapshot built it");
    e.set_options(&json!({"geo": null}).to_string()).unwrap();
    assert_eq!(nodes(&mut e), (2, true), "options without it keep it");
    e.set_options(&json!({"max_nodes": 10}).to_string()).unwrap();
    assert_eq!(nodes(&mut e), (4, false));
}
