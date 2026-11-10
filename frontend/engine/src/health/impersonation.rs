//! Possible impersonation (D-108): packets claiming to be from a node whose
//! signature or key does not check out. Decoding failures are not counted.

use super::{Ctx, Issues};
use crate::util::{map, FxMap, FxSet};

/// Packets claiming to be from one node that failed verification before it
/// is flagged as possibly impersonated (D-108).
pub const SPOOF_MIN: usize = 3;

/// A claimed sender's rejected packets (lp), their rejection reasons with
/// counts, and the gateways that heard them.
type Claims = (FxSet<u64>, FxMap<u32, usize>, FxSet<u32>);

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let i = cx.i;
    let trust = ["sig_invalid", "sig_malformed", "first_contact_invalid", "nodeinfo_key_mismatch", "strict_unverifiable"];
    let mut claimed: FxMap<u32, Claims> = map();
    for &r in &cx.invalid {
        let Some(reason) = r.invalid().filter(|&v| trust.contains(&i.s(v))) else { continue };
        let e = claimed.entry(r.src).or_default();
        if e.0.insert(r.lp) {
            *e.1.entry(reason).or_default() += 1;
        }
        if let Some(g) = r.gw {
            e.2.insert(g);
        }
    }
    for (n, (packets, reasons, gws)) in claimed {
        if packets.len() < SPOOF_MIN {
            continue;
        }
        let mut rs: Vec<(String, usize)> = reasons.into_iter().map(|(k, c)| (i.s(k).to_string(), c)).collect();
        rs.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let list: Vec<String> = rs.iter().map(|(k, c)| format!("{c} × {}", k.replace('_', " "))).collect();
        let key_change = rs.iter().all(|(k, _)| k == "nodeinfo_key_mismatch");
        let first_contact = rs.iter().all(|(k, _)| k == "first_contact_invalid");
        let why = if first_contact {
            "No key is trusted for this node yet, and these signed NodeInfo packets did not establish one: the key they announce does not derive its node id, or their signature does not verify against that key. Someone may be announcing a key for its node number, or a gateway altered the packets on the way. They are kept out of the map, so they do not affect its links or counts."
        } else if key_change {
            "They announce a different public key than the one trusted for this node: most likely it was reset or reflashed and has a new key, which is trusted only once the old key's announcements leave retention. If not, someone is using its node number."
        } else {
            "Their signatures do not verify against the key trusted for this node: someone may be sending packets in its name, or its key changed. They are kept out of the map, so they do not affect its links or counts."
        };
        out.add(n, "spoofed", "warning", format!("{} packets in its name failed verification", packets.len()), format!("{} packets claiming to come from it ({}), reported by {} gateway{}. {why}", packets.len(), list.join(", "), gws.len(), if gws.len() == 1 { "" } else { "s" }));
    }
}

#[cfg(test)]
mod tests {
    use crate::channels::PresetIndex;
    use crate::copies::Copies;
    use crate::health::{health, Issue};
    use crate::row::{Interner, JRow, Row};
    use crate::views::link::LinkReadings;

    #[test]
    fn packets_in_a_nodes_name_that_fail_verification_are_flagged() {
        let mut i = Interner::default();
        let bad = |i: &mut Interner, k: i64, reason: &str| {
            let text = format!(r#"{{"i":{k},"t":{k},"b":"x","g":7,"s":5,"y":"invalid","l":"{k:016x}","o":"{k:016x}","sg":"not-applicable","iv":"{reason}"}}"#);
            serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
        };
        let forged: Vec<Row> = (1..=3).map(|k| bad(&mut i, k, "sig_invalid")).collect();
        let decode: Vec<Row> = (4..=9).map(|k| bad(&mut i, k, "payload_invalid")).collect();
        let refs: Vec<&Row> = forged.iter().chain(&decode).collect();
        let got = health(&[], &refs, &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        let s: Vec<&Issue> = got.iter().filter(|x| x.kind == "spoofed").collect();
        assert_eq!(s.len(), 1, "decoding failures alone are not impersonation");
        assert!(s[0].summary.starts_with("3 packets"));
        // A changed key is explained as a likely reset.
        let rekeyed: Vec<Row> = (1..=4).map(|k| bad(&mut i, k, "nodeinfo_key_mismatch")).collect();
        let refs: Vec<&Row> = rekeyed.iter().collect();
        let got = health(&[], &refs, &[], &[], &LinkReadings::default(), &Copies::default(), &PresetIndex::default(), &i, 48.0, &crate::landsdel::Regions::default()).issues;
        assert!(got.iter().any(|x| x.kind == "spoofed" && x.detail.contains("reset or reflashed")));
    }
}
