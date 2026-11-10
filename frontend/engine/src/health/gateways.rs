//! Gateways: uplinks arriving unencrypted, gateways that move, and gateways
//! whose topic root names another region than the one they are in (D-161).

use super::{Ctx, Issues};
use crate::landsdel::{misspelled_region, region_of_topic};
use crate::util::{map, FxMap};

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    plaintext(cx, out);
    placement(cx, out);
}

/// Unencrypted uplinks.
fn plaintext(cx: &Ctx, out: &mut Issues) {
    let Some(plain) = cx.i.get("plaintext_uplink") else { return };
    let mut gws: FxMap<u32, usize> = map();
    for &r in cx.rows {
        if r.crypto == plain
            && let Some(g) = r.gw
        {
            *gws.entry(g).or_default() += 1;
        }
    }
    for (g, c) in gws {
        out.add(g, "plaintext_uplink", "notice", "Uplinks to MQTT unencrypted".into(), format!("{c} of its uplinks arrived decrypted (MQTT encryption off): anyone subscribed to the broker reads its channels' traffic in the clear, including channels whose key is not public."));
    }
}

/// Moving gateways, and topic roots against the region a gateway is in.
fn placement(cx: &Ctx, out: &mut Issues) {
    let i = cx.i;
    let mut roots: FxMap<u32, FxMap<u32, usize>> = map();
    for &r in cx.rows {
        if let Some(g) = r.gw.filter(|_| r.topic != 0) {
            *roots.entry(g).or_default().entry(r.topic).or_default() += 1;
        }
    }
    for x in cx.nodes.iter().filter(|x| x.is_gateway) {
        let n = x.num;
        if let Some(at) = &x.moved_at {
            out.add(n, "moving_gateway", "warning", "Moves while uplinking to MQTT".into(), format!("It moved in the window (last around {at}) while uplinking what it hears. The map places nodes and draws links from where gateways hear them, so a moving gateway's receptions are weaker evidence; and its topic root, set for one region, travels with it into others. A gateway is best left in one place; a node carried around can stay a client."));
        }
        let (Some(p), Some(rs)) = (&x.position, roots.get(&n)) else { continue };
        let Some(here) = cx.regions.region_at(p.lat, p.lon) else { continue };
        let mut used: Vec<(&str, usize)> = rs.iter().map(|(&t, &c)| (i.s(t), c)).collect();
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
}
