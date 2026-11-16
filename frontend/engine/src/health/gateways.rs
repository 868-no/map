//! Gateways: uplinks arriving unencrypted, gateways that move, and gateways
//! whose topic root names another region than the one they are in (D-161).

use super::{Ctx, Issues};
use crate::landsdel::{misspelled_region, region_of_topic};
use crate::util::{map, set, FxMap, FxSet};

/// Uplinks arriving encrypted, after the last unencrypted one, that show
/// MQTT encryption switched back on (D-226).
pub const PLAINTEXT_FIXED_MIN: usize = 3;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    plaintext(cx, out);
    placement(cx, out);
}

/// Unencrypted uplinks, unless switched off within the window (D-226): at
/// least `PLAINTEXT_FIXED_MIN` uplinks that arrived encrypted on a channel
/// it had uplinked unencrypted, after its last unencrypted one. A gateway
/// with MQTT encryption off decrypts every channel it holds the key to, so
/// those prove it on; packets of channels it cannot read arrive encrypted
/// either way, and prove nothing.
fn plaintext(cx: &Ctx, out: &mut Issues) {
    let Some(plain) = cx.i.get("plaintext_uplink") else { return };
    let enc: Vec<u32> = ["ctr_unauthenticated", "ccm_authenticated"].iter().filter_map(|c| cx.i.get(c)).collect();
    // Per gateway: unencrypted uplinks, the last one's time, their channels.
    let mut gws: FxMap<u32, (usize, i64, FxSet<u32>)> = map();
    for &r in cx.rows {
        if r.crypto == plain
            && let Some(g) = r.gw
        {
            let e = gws.entry(g).or_insert_with(|| (0, i64::MIN, set()));
            e.0 += 1;
            e.1 = e.1.max(r.t);
            e.2.insert(r.channel);
        }
    }
    let mut since: FxMap<u32, usize> = map();
    for &r in cx.rows {
        if let Some((g, (_, last, chans))) = r.gw.and_then(|g| gws.get(&g).map(|e| (g, e)))
            && r.t > *last
            && enc.contains(&r.crypto)
            && chans.contains(&r.channel)
        {
            *since.entry(g).or_default() += 1;
        }
    }
    for (g, (c, _, _)) in gws {
        if since.get(&g).is_some_and(|&k| k >= PLAINTEXT_FIXED_MIN) {
            continue;
        }
        out.add(g, "plaintext_uplink", "notice", "Uplinks to MQTT unencrypted".into(), format!("{c} of its uplinks arrived decrypted (MQTT encryption off): anyone subscribed to the broker reads its channels' traffic in the clear, including channels whose key is not public."));
    }
}

/// Moving gateways, and topic roots against the region a gateway is in.
fn placement(cx: &Ctx, out: &mut Issues) {
    let i = cx.i;
    // Per gateway and root: uplinks, first and last.
    let mut roots: FxMap<u32, FxMap<u32, (usize, i64, i64)>> = map();
    for &r in cx.rows {
        if let Some(g) = r.gw.filter(|_| r.topic != 0) {
            let e = roots.entry(g).or_default().entry(r.topic).or_insert((0, i64::MAX, i64::MIN));
            *e = (e.0 + 1, e.1.min(r.t), e.2.max(r.t));
        }
    }
    // Only the roots in use since its newest root was first used: a root it
    // left before that was corrected (D-226). Roots used side by side (two
    // brokers) all stay.
    for rs in roots.values_mut() {
        let Some(&(_, from, _)) = rs.values().max_by_key(|e| (e.2, e.1)) else { continue };
        rs.retain(|_, e| e.2 >= from);
    }
    for x in cx.nodes.iter().filter(|x| x.is_gateway) {
        let n = x.num;
        if let Some(at) = &x.moved_at {
            out.add(n, "moving_gateway", "warning", "Moves while uplinking to MQTT".into(), format!("It moved in the window (last around {at}) while uplinking what it hears. The map places nodes and draws links from where gateways hear them, so a moving gateway's receptions are weaker evidence; and its topic root, set for one region, travels with it into others. A gateway is best left in one place; a node carried around can stay a client."));
        }
        let (Some(p), Some(rs)) = (&x.position, roots.get(&n)) else { continue };
        let Some(here) = cx.regions.region_at(p.lat, p.lon) else { continue };
        let mut used: Vec<(&str, usize)> = rs.iter().map(|(&t, &(c, _, _))| (i.s(t), c)).collect();
        used.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        let wrong: Vec<String> = used.iter().filter_map(|&(t, c)| region_of_topic(t).filter(|&r| r != here).map(|r| format!("{t} ({r}, {c} uplinks)"))).collect();
        let misspelt: Vec<String> = used.iter().filter(|&&(t, _)| region_of_topic(t).is_none()).filter_map(|&(t, c)| misspelled_region(t).map(|(seg, name)| format!("{t} ({c} uplinks: \"{seg}\" is not \"{name}\")"))).collect();
        let none: Vec<String> = used.iter().filter(|&&(t, _)| region_of_topic(t).is_none() && misspelled_region(t).is_none()).map(|&(t, c)| format!("{t} ({c} uplinks)")).collect();
        if !wrong.is_empty() {
            out.add(n, "topic_region", "warning", format!("Uplinks under another region's topic root, from {here}"), format!("Its position is in {here}, but it publishes under {}. Subscribers and maps that follow a region's root miss its traffic or place it in the wrong region; its root would normally end in /{here}.", wrong.join(", ")));
        } else if !misspelt.is_empty() {
            out.add(n, "topic_region", "warning", format!("Topic root misspells its region, from {here}"), format!("Its position is in {here}, but it publishes under {}. Region names in a root must be exact, case and æ, ø, å included ({}), or subscribers that follow the region's root miss its traffic; its root would normally end in /{here}.", misspelt.join(", "), crate::landsdel::NAMES.join(", ")));
        } else if !none.is_empty() {
            out.add(n, "topic_region", "notice", format!("Topic root names no region, from {here}"), format!("Its position is in {here}, but it publishes under {}, which names no region. Subscribers that follow a region's root miss its traffic; a root ending in /{here} would put it with its neighbours.", none.join(", ")));
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::health::tests::{gateway, node_issues};
    use crate::row::Interner;

    #[test]
    fn a_gateway_under_another_regions_root_is_flagged() {
        let mut i = Interner::default();
        // In Oslo: Trøndelag's root is a warning, no region a notice, its own none.
        let (oslo, wrong) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Trøndelag", 1);
        let got = node_issues(&[wrong], std::slice::from_ref(&oslo), &i);
        let t = got.iter().find(|x| x.kind == "topic_region").expect("flagged");
        assert_eq!(t.severity, "warning");
        assert!(t.summary.ends_with("from Østlandet") && t.detail.contains("msh/EU_868/NO/Trøndelag (Trøndelag, 1 uplinks)"), "{t:?}");
        let (_, bare) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO", 2);
        assert_eq!(node_issues(&[bare], std::slice::from_ref(&oslo), &i).iter().find(|x| x.kind == "topic_region").map(|x| x.severity), Some("notice"));
        // A misspelt region (ASCII for ø) is a warning naming the exact spelling.
        let (_, ascii) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Ostlandet", 5);
        let got = node_issues(&[ascii], std::slice::from_ref(&oslo), &i);
        let t = got.iter().find(|x| x.kind == "topic_region").expect("misspelt");
        assert!(t.severity == "warning" && t.detail.contains("\"Ostlandet\" is not \"Østlandet\""), "{t:?}");
        let (_, right) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Østlandet", 3);
        assert!(node_issues(&[right], &[oslo], &i).iter().all(|x| x.kind != "topic_region"));
        // Abroad there is no region to compare with.
        let (sthlm, any) = gateway(&mut i, 8, 59.33, 18.07, "msh/EU_868/NO/Trøndelag", 4);
        assert!(node_issues(&[any], &[sthlm], &i).iter().all(|x| x.kind != "topic_region"));
    }

    #[test]
    fn a_gateway_that_moved_is_flagged() {
        let mut i = Interner::default();
        let (mut x, r) = gateway(&mut i, 7, 63.43, 10.39, "msh/EU_868/NO/Trøndelag", 1);
        assert!(node_issues(std::slice::from_ref(&r), std::slice::from_ref(&x), &i).iter().all(|y| y.kind != "moving_gateway"));
        x.moved_at = Some("2026-11-04T12:00:00Z".into());
        let got = node_issues(std::slice::from_ref(&r), std::slice::from_ref(&x), &i);
        assert_eq!(got.iter().find(|y| y.kind == "moving_gateway").map(|y| y.severity), Some("warning"));
        // A node that moved but uplinks nothing is not.
        x.is_gateway = false;
        assert!(node_issues(&[r], &[x], &i).iter().all(|y| y.kind != "moving_gateway"));
    }

    #[test]
    fn a_topic_root_corrected_in_the_window_is_not_flagged() {
        let mut i = Interner::default();
        let (oslo, wrong) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Trøndelag", 1);
        let (_, right) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Østlandet", 2);
        let (_, right2) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Østlandet", 3);
        assert!(node_issues(&[wrong.clone(), right.clone()], std::slice::from_ref(&oslo), &i).iter().all(|x| x.kind != "topic_region"));
        // The other way round, it went wrong: flagged.
        let (_, wrong3) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Trøndelag", 3);
        assert!(node_issues(&[right.clone(), wrong3], std::slice::from_ref(&oslo), &i).iter().any(|x| x.kind == "topic_region"));
        // Two roots side by side (two brokers) both count.
        let (_, wrong2) = gateway(&mut i, 7, 59.91, 10.75, "msh/EU_868/NO/Trøndelag", 4);
        assert!(node_issues(&[wrong, right, right2, wrong2], &[oslo], &i).iter().any(|x| x.kind == "topic_region"));
    }

    #[test]
    fn uplinks_encrypted_again_dismiss_the_unencrypted_notice() {
        use crate::row::{JRow, Row};
        let mut i = Interner::default();
        let up = |i: &mut Interner, k: i64, ch: &str, cr: &str| -> Row {
            let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":7,"s":5,"c":"{ch}","y":"text","l":"{k:016x}","o":"{k:016x}","sg":"unsigned","cr":"{cr}"}}"#, k * 60_000);
            serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
        };
        let flagged = |rows: &[Row], i: &Interner| crate::health::tests::issues(rows, i).iter().any(|x| x.kind == "plaintext_uplink");
        let mut rows = vec![up(&mut i, 1, "LongFast", "plaintext_uplink"), up(&mut i, 2, "LongFast", "plaintext_uplink")];
        assert!(flagged(&rows, &i));
        // Encrypted on another channel proves nothing (it may hold no key).
        rows.extend((3..=6).map(|k| up(&mut i, k, "Private", "ctr_unauthenticated")));
        assert!(flagged(&rows, &i));
        // Two on the same channel are not yet enough; three are.
        rows.extend((7..=8).map(|k| up(&mut i, k, "LongFast", "ctr_unauthenticated")));
        assert!(flagged(&rows, &i));
        rows.push(up(&mut i, 9, "LongFast", "ccm_authenticated"));
        assert!(!flagged(&rows, &i));
        // Unencrypted again after that: flagged.
        rows.push(up(&mut i, 10, "LongFast", "plaintext_uplink"));
        assert!(flagged(&rows, &i));
    }
}
