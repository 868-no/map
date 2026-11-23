//! Signatures in firmware 2.8.0's layout (D-229): firmware 2.8.1 signs
//! another buffer, so newer nodes cannot verify them.

use super::{Ctx, Issues};
use crate::util::{map, FxMap, FxSet};

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let Some(reason) = cx.i.get("sig_2_8_0") else { return };
    let mut packets: FxMap<u32, FxSet<u64>> = map();
    for &r in &cx.invalid {
        if r.invalid() == Some(reason) {
            packets.entry(r.src).or_default().insert(r.lp);
        }
    }
    for (n, lp) in packets {
        let c = lp.len();
        out.add(n, "signature_2_8_0", "notice", "Signs its packets as firmware 2.8.0, which newer nodes cannot verify".to_string(), format!("{c} packet{} from it carr{} a signature in firmware 2.8.0's format, which 2.8.1 replaced. Nodes on 2.8.1 or later cannot verify it: they drop its signed NodeInfo, so they never learn its name or key and cannot send it direct messages, and the map keeps these packets out too. Updating its firmware fixes it.", if c == 1 { "" } else { "s" }, if c == 1 { "ies" } else { "y" }));
    }
}

#[cfg(test)]
mod tests {
    use crate::channels::PresetIndex;
    use crate::copies::Copies;
    use crate::health::health;
    use crate::row::{Interner, JRow, Row};
    use crate::views::link::LinkReadings;

    #[test]
    fn signatures_in_the_2_8_0_layout_are_noted_not_called_forged() {
        let mut i = Interner::default();
        let bad = |i: &mut Interner, k: i64, reason: &str| {
            let text = format!(r#"{{"i":{k},"t":{k},"b":"x","g":7,"s":5,"y":"invalid","l":"{k:016x}","o":"{k:016x}","sg":"not-applicable","iv":"{reason}"}}"#);
            serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
        };
        // Two gateways' copies of one packet, and two more packets.
        let mut rows: Vec<Row> = (1..=3).map(|k| bad(&mut i, k, "sig_2_8_0")).collect();
        rows.push(bad(&mut i, 1, "sig_2_8_0"));
        let refs: Vec<&Row> = rows.iter().collect();
        let got = health(&[], &refs, &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        let s: Vec<_> = got.iter().filter(|x| x.kind == "signature_2_8_0").collect();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].severity, "notice");
        assert!(s[0].detail.starts_with("3 packets"), "{}", s[0].detail);
        assert!(!got.iter().any(|x| x.kind == "spoofed"), "not impersonation");
    }
}
