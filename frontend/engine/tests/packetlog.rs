//! A node's packet log lists its invalid rows too (D-093), appended after
//! the rows the reply index was built from: replies still pair up.

use serde_json::{json, Value};

use meshmap_engine::Engine;

const T0: i64 = 1_793_404_800_000; // 2026-10-31T00:00:00Z

#[test]
fn a_packet_log_with_invalid_rows_still_lists_replies() {
    let rows = json!([
        {"i": 1, "t": T0 + 1_000, "b": "x", "g": 7, "s": 5, "d": 9, "p": 50, "y": "text", "l": "0000000000000001", "o": "0000000000000101", "sg": "not-applicable", "sn": 5.0, "hs": 3, "hl": 3},
        {"i": 2, "t": T0 + 2_000, "b": "x", "g": 7, "s": 9, "d": 5, "p": 51, "y": "routing", "l": "0000000000000002", "o": "0000000000000102", "sg": "not-applicable", "sn": 5.0, "hs": 3, "hl": 3,
         "rt": {"kind": "ack", "request_id": 50}},
        {"i": 3, "t": T0 + 3_000, "b": "x", "g": 7, "s": 5, "y": "invalid", "l": "0000000000000003", "o": "0000000000000103", "sg": "not-applicable", "iv": "sig_invalid"},
    ]);
    let mut e = Engine::new();
    e.add_rows(&rows.to_string(), f64::NEG_INFINITY).unwrap();
    let log: Value = serde_json::from_str(&e.view("packetlog", T0 as f64, (T0 + 3_600_000) as f64, "{}", "!00000005").unwrap()).unwrap();
    let text = log.to_string();
    assert!(text.contains("sig_invalid"), "the invalid row is listed: {text}");
    assert!(text.contains(r#""kind":"ack""#), "the ACK pairs with its request: {text}");
}
