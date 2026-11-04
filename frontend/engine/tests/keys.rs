//! Node ids and keys (D-142): firmware 2.8 derives a node's id from its public
//! key (CRC-32, sent by the server as `key_id`), 2.7 and earlier from the
//! hardware. The identity says which; ids announcing one key while both are
//! active are flagged, a key passed on to a new id is not.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const H: i64 = 3_600_000;
const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z

/// A node's NodeInfo with key id `key` every hour in [from, to) hours: signed
/// and verified when the id derives from the key (firmware 2.8), unsigned
/// otherwise (2.7, or anyone announcing a key they do not hold).
fn announcing(rows: &mut Vec<Value>, node: u32, key: u32, from: i64, to: i64) {
    for h in from..to {
        let i = rows.len() as i64 + 1;
        rows.push(json!({"i": i, "t": T0 + h * H, "b": "it", "s": node, "g": 0x0900_0009u32, "d": 0xffff_ffffu32, "y": "nodeinfo",
            "l": format!("{i:016x}"), "o": format!("{:016x}", i + 10_000), "sg": if node == key { "verified" } else { "unsigned" }, "hs": 3, "hl": 3,
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

/// (node, severity, summary, detail) of each shared-key issue.
fn shared(health: &Value) -> Vec<(String, String, String, String)> {
    health["issues"].as_array().unwrap().iter().filter(|x| x["kind"] == "shared_key")
        .map(|x| ["node", "severity", "summary", "detail"].map(|k| x[k].as_str().unwrap().to_string()).into())
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
    announcing(&mut rows, 0x1300_0013, 0x1300_0013, 0, 8); // an unrelated 2.8 node
    let (_, health) = views(&rows);
    let got = shared(&health);
    let nodes: Vec<&str> = got.iter().map(|x| x.0.as_str()).collect();
    assert_eq!(nodes, ["!0d00000d", "!0e00000e"], "{got:?}");
    // Neither proved holding the key: a notice, since a forged claim looks the same.
    assert!(got.iter().all(|x| x.1 == "notice"), "{got:?}");
    assert!(got[0].2.contains("!0e00000e") && got[0].3.contains("would all take the id !0f0f0f0f"), "{got:?}");
}

#[test]
fn a_node_that_proved_its_key_is_never_flagged_and_claimants_are() {
    let mut rows = Vec::new();
    announcing(&mut rows, 0x1111_1111, 0x1111_1111, 0, 8); // a 2.8 node, its NodeInfo verified
    announcing(&mut rows, 0x1200_0012, 0x1111_1111, 2, 6); // another id announcing its key, unsigned
    let (_, health) = views(&rows);
    let got = shared(&health);
    assert_eq!(got.len(), 1, "only the claimant: {got:?}");
    assert_eq!((got[0].0.as_str(), got[0].1.as_str()), ("!12000012", "warning"));
    assert!(got[0].2.contains("!11111111"), "{got:?}");
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

#[test]
fn an_upgrade_and_a_rollback_are_not_flagged() {
    let mut rows = Vec::new();
    announcing(&mut rows, 0x0a00_000a, 0x0c0c_0c0c, 0, 10); // 2.7
    announcing(&mut rows, 0x0c0c_0c0c, 0x0c0c_0c0c, 10, 13); // upgraded to 2.8, key proved
    announcing(&mut rows, 0x0a00_000a, 0x0c0c_0c0c, 13, 24); // rolled back to 2.7
    let (_, health) = views(&rows);
    assert!(shared(&health).is_empty(), "the old id's span covers the new one's, but they took turns: {:?}", shared(&health));
    // Two devices taking turns back and forth all day are flagged.
    let mut rows = Vec::new();
    for h in 0..24 {
        let n = if h % 2 == 0 { 0x0a00_000a } else { 0x0c0c_0c0c };
        announcing(&mut rows, n, 0x0c0c_0c0c, h, h + 1);
    }
    let (_, health) = views(&rows);
    let got = shared(&health);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!((got[0].0.as_str(), got[0].1.as_str()), ("!0a00000a", "warning"));
}

#[test]
fn an_upgraded_node_keeping_its_short_name_is_no_duplicate_name() {
    let mut rows = Vec::new();
    announcing(&mut rows, 0x0a00_000a, 0x0c0c_0c0c, 0, 3);
    announcing(&mut rows, 0x0c0c_0c0c, 0x0c0c_0c0c, 4, 9);
    announcing(&mut rows, 0x1500_0015, 0x1500_0015, 0, 9); // another node, same short name
    for r in &mut rows {
        r["ni"]["short_name"] = json!("SAME");
    }
    let (_, health) = views(&rows);
    let dup: Vec<(String, String)> = health["issues"].as_array().unwrap().iter().filter(|x| x["kind"] == "duplicate_name")
        .map(|x| (x["node"].as_str().unwrap().to_string(), x["detail"].as_str().unwrap().to_string())).collect();
    // Each id of the upgraded node names only the other node, never its own other id.
    assert_eq!(dup.len(), 3, "{dup:?}");
    for (n, d) in &dup {
        if n != "!15000015" {
            assert!(d.contains("!15000015") && !d.contains("!0a00000a") && !d.contains("!0c0c0c0c"), "{n}: {d}");
        }
    }
}
