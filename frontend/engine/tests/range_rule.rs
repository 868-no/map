//! The relay range rule (D-177) counts one RF event once, however many
//! gateways uplinked it.

use meshmap_engine::graph::LatLon;
use meshmap_engine::row::{parse_rows, Interner, Row};
use meshmap_engine::util::{map, set, FxMap};
use meshmap_engine::views::{build_edges, traceroute_hops, Rules};

#[test]
fn one_traceroute_uplinked_twice_is_one_sighting_for_the_relay_range() {
    let (g, f, a, b) = (0x0000_aa01u32, 0x1111_1142u32, 0x2222_2201u32, 0x3333_3302u32);
    let (x1, x2, o) = (0x4444_4401u32, 0x4444_4402u32, 0x5555_5555u32);
    // copies: how many gateways uplinked the one traceroute A -> B.
    let run = |copies: u32| {
        let mut text: Vec<String> = (0..copies).map(|k| format!(
            r#"{{"i":{},"t":1000,"b":"x","g":{},"s":{a},"d":{b},"p":77,"y":"traceroute","l":"00000000000000aa","o":"00000000000000b{k}","sg":"unsigned","rr":"relayed","hs":3,"hl":2,"tr":{{"valid":true,"is_reply":false,"route":[],"snr_towards":[5.0]}}}}"#,
            10 + k, [x1, x2][k as usize])).collect();
        // A copy at G whose last-hop byte 0x42 only F (300 km from G) carries.
        text.push(format!(r#"{{"i":20,"t":2000,"b":"x","g":{g},"s":{o},"d":4294967295,"p":5,"y":"text","l":"00000000000000cc","o":"00000000000000cd","sg":"unsigned","rr":"relayed","hs":3,"hl":2,"r":66,"sn":1.0}}"#));
        let mut i = Interner::default();
        let rows: Vec<Row> = parse_rows(&format!("[{}]", text.join(",")), &mut i, |_| true).unwrap();
        let refs: Vec<&Row> = rows.iter().collect();
        let hops = traceroute_hops(&refs);
        let mut pos: FxMap<u32, LatLon> = map();
        pos.insert(g, LatLon { lat: 63.4, lon: 10.4 });
        pos.insert(f, LatLon { lat: 61.2, lon: 7.1 });
        pos.insert(a, LatLon { lat: 59.4, lon: 10.5 });
        pos.insert(b, LatLon { lat: 61.9, lon: 10.2 });
        let known = vec![g, f, a, b, x1, x2, o];
        let (er, ctx) = build_edges(&refs, &[], &hops.samples, &known, pos, set(), None, &map(), Rules::default(), set());
        let ab = er.edges.iter().find(|e| e.src_num == a && e.dst_num == b).unwrap();
        (ab.evidence.traceroute, ctx.max_range_m.round(), er.edges.iter().any(|e| e.src_num == f))
    };
    let one = run(1);
    let two = run(2);
    assert_eq!(one.0, two.0, "the link counts the traceroute once either way");
    assert_eq!(one.1, two.1, "the relay range should not depend on how many gateways uplinked one traceroute");
}
