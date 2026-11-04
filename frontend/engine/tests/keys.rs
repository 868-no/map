//! Node ids and keys (D-142): firmware 2.8 derives a node's id from its public
//! key (CRC-32, sent by the server as `key_id`), 2.7 and earlier from the
//! hardware. The identity says which; ids announcing one key while both are
//! active are flagged, a key passed on to a new id is not.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const H: i64 = 3_600_000;
const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z

/// A node's NodeInfo with key id `key` every hour in [from, to) hours.
fn announcing(rows: &mut Vec<Value>, node: u32, key: u32, from: i64, to: i64) {
    for h in from..to {
        let i = rows.len() as i64 + 1;
        rows.push(json!({"i": i, "t": T0 + h * H, "b": "it", "s": node, "g": 0x0900_0009u32, "d": 0xffff_ffffu32, "y": "nodeinfo",
            "l": format!("{i:016x}"), "o": format!("{:016x}", i + 10_000), "sg": "verified", "hs": 3, "hl": 3,
            "ni": {"long_name": format!("n{node:x}"), "short_name": format!("{:04x}", node & 0xffff), "has_public_key": true, "key_id": key}}));
    }
}

fn views(rows: &[Value]) -> (Value, Value) {
    let mut e = Engine::new();
    e.add_rows(&Value::Array(rows.to_vec()).to_string(), f64::NEG_INFINITY).unwrap();
    let (s, t) = (T0 as f64, (T0 + 24 * H) as f64);
    let snap = serde_json::from_str(&e.view("snapshot", s, t, "{}", "").unwrap()).unwrap();
    let health = serde_json::from_str(&e.view("health", s, t, "{}", "").unwrap()).unwrap();
    (snap, health)
}

fn identity<'a>(snap: &'a Value, id: &str) -> &'a Value {
    &snap["nodes"].as_array().unwrap().iter().find(|n| n["id"] == id).unwrap_or_else(|| panic!("{id} missing"))["identity"]
}

fn shared(health: &Value) -> Vec<(String, String, String)> {
    health["issues"].as_array().unwrap().iter().filter(|x| x["kind"] == "shared_key")
        .map(|x| (x["node"].as_str().unwrap().to_string(), x["summary"].as_str().unwrap().to_string(), x["detail"].as_str().unwrap().to_string()))
        .collect()
}

#[test]
fn an_upgrade_with_the_key_kept_changes_the_id_scheme_and_is_no_shared_key() {
    let mut rows = Vec::new();
    announcing(&mut rows, 0x0a00_000a, 0x0c0c_0c0c, 0, 3); // 2.7: id from the hardware
    announcing(&mut rows, 0x0c0c_0c0c, 0x0c0c_0c0c, 4, 9); // the same key on 2.8
    let (snap, health) = views(&rows);
    let old = identity(&snap, "!0a00000a");
    assert_eq!(old["node_id_from"], "hardware");
    assert_eq!(old["key_id"], "!0c0c0c0c", "the id it takes on 2.8");
    let new = identity(&snap, "!0c0c0c0c");
    assert_eq!(new["node_id_from"], "key");
    assert!(new.get("key_id").is_none(), "a 2.8 node's key id is its own");
    assert!(shared(&health).is_empty(), "the old id fell silent first: {:?}", shared(&health));
}

#[test]
fn ids_announcing_one_key_at_the_same_time_are_flagged() {
    let mut rows = Vec::new();
    announcing(&mut rows, 0x0d00_000d, 0x0f0f_0f0f, 0, 8); // two 2.7 devices from one backup
    announcing(&mut rows, 0x0e00_000e, 0x0f0f_0f0f, 1, 9);
    announcing(&mut rows, 0x1111_1111, 0x1111_1111, 0, 8); // a 2.8 node ...
    announcing(&mut rows, 0x1200_0012, 0x1111_1111, 2, 6); // ... and a 2.7 one with its key
    announcing(&mut rows, 0x1300_0013, 0x1300_0013, 0, 8); // an unrelated 2.8 node
    let (_, health) = views(&rows);
    let got = shared(&health);
    let nodes: Vec<&str> = got.iter().map(|x| x.0.as_str()).collect();
    assert_eq!(nodes, ["!0d00000d", "!0e00000e", "!11111111", "!12000012"], "{got:?}");
    assert!(got[0].1.contains("!0e00000e") && got[0].2.contains("would all take the id !0f0f0f0f"), "{got:?}");
    assert!(got[3].1.contains("!11111111") && got[3].2.contains("!11111111 already uses"), "{got:?}");
}

#[test]
fn a_short_overlap_while_a_key_changes_hands_is_not_flagged() {
    let mut rows = Vec::new();
    announcing(&mut rows, 0x0a00_000a, 0x0c0c_0c0c, 0, 3);
    // The new id's first NodeInfo comes in the old id's last hour: both are
    // heard at the same instant, but not for the 30 minutes a shared key needs.
    announcing(&mut rows, 0x0c0c_0c0c, 0x0c0c_0c0c, 2, 6);
    let (_, health) = views(&rows);
    assert!(shared(&health).is_empty(), "{:?}", shared(&health));
}
