//! Identities: ids announcing one public key while both active (D-142,
//! D-154), and short names that are not unique.

use super::{Ctx, Issues};
use crate::util::{map, node_id, FxMap};

/// Shared keys: how long two ids announcing one key must both be active (D-142).
pub const SHARED_KEY_OVERLAP_MS: i64 = 30 * 60_000;
/// Shared keys: how often the sender must switch between the two ids, in time
/// order, for them to be active together: an upgrade to 2.8 and a rollback
/// (or a second upgrade) switch at most three times (D-154).
pub const SHARED_KEY_MIN_SWITCHES: usize = 4;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    shared_keys(cx, out);
    duplicate_names(cx, out);
}

/// Shared keys (D-142): ids announcing the same public key while both
/// active. A key passed on (an upgrade to 2.8 with the key kept, or a key
/// restored onto new hardware) leaves the old id silent first: not flagged;
/// nor is a rollback to the old id, which spans the new one's time but
/// takes turns with it rather than interleaving (D-154).
/// Anyone can announce any key unsigned, so a node whose NodeInfo verified
/// (it proved holding the key) is never flagged; the ids claiming its key
/// are. Without such a proof the claims cannot be told from a copied key,
/// and are a notice.
fn shared_keys(cx: &Ctx, out: &mut Issues) {
    let own = &cx.own;
    let mut by_key: FxMap<u32, Vec<(u32, bool)>> = map();
    for x in cx.nodes {
        if let Some(id) = x.identity.as_ref()
            && let Some(k) = id.key_num
        {
            by_key.entry(k).or_default().push((x.num, id.signature == "verified" && k == x.num));
        }
    }
    let span = |n: u32| own.get(&n).map(|m| m.values().fold((i64::MAX, i64::MIN), |(lo, hi), r| (lo.min(r.t), hi.max(r.t))));
    // Both ids' packets in time order (ties by id, so either way round
    // counts alike), and how often the sender switches between them.
    let switches = |a: u32, b: u32| {
        let mut v: Vec<(i64, u32)> = [a, b].iter().flat_map(|&n| own.get(&n).into_iter().flat_map(move |m| m.values().map(move |r| (r.t, n)))).collect();
        v.sort_unstable();
        v.windows(2).filter(|w| w[0].1 != w[1].1).count()
    };
    let overlap = |a: u32, b: u32| matches!((span(a), span(b)), (Some((a0, a1)), Some((b0, b1))) if a1.min(b1) - a0.max(b0) >= SHARED_KEY_OVERLAP_MS) && switches(a, b) >= SHARED_KEY_MIN_SWITCHES;
    for (k, ids) in by_key.into_iter().filter(|(_, v)| v.len() > 1) {
        let holder = ids.iter().find(|&&(_, proved)| proved).map(|&(n, _)| n);
        for &(n, proved) in &ids {
            if proved {
                continue;
            }
            let mut with: Vec<u32> = ids.iter().map(|&(o, _)| o).filter(|&o| o != n && overlap(n, o)).collect();
            if with.is_empty() {
                continue;
            }
            with.sort_unstable();
            let others: Vec<String> = with.iter().map(|&o| node_id(o)).collect();
            // A proven key's claimants are warned even when only they overlap
            // (the holder silent meanwhile): it is still the holder's key.
            match holder {
                Some(h) => out.add(n, "shared_key", "warning", format!("Announces the public key of {}", node_id(h)), format!("{} proved holding this key (a verified signature; firmware 2.8 derives its id from it), while this id announced it unsigned{}. Either a device set up from {}'s backup or with its key copied, which can then read its direct messages, or someone announcing another node's key; signatures still tell them apart. A copy should get a new key.", node_id(h), if with.contains(&h) { " at the same time".to_string() } else { format!(", at the same time as {}", others.join(", ")) }, node_id(h))),
                None => out.add(n, "shared_key", "notice", format!("Announces the same public key as {}", others.join(", ")), format!("Active at the same time with the same key, and none of them proved holding it (no verified signature, as on firmware 2.7 and earlier). Devices set up from one backup or with a copied key can read each other's direct messages, and on firmware 2.8 they would all take the id {}; but an unsigned NodeInfo can also announce another node's key, so check the devices before acting.", node_id(k))),
            }
        }
    }
}

/// Short names used by more than one node. Ids announcing one key are one
/// device under two ids (an upgrade to 2.8, or a copy the shared-key rule
/// reports), not two nodes named alike.
fn duplicate_names(cx: &Ctx, out: &mut Issues) {
    let mut shorts: FxMap<&str, Vec<u32>> = map();
    for x in cx.nodes {
        if let Some(id) = x.identity.as_ref().filter(|id| !id.short_name.is_empty()) {
            shorts.entry(id.short_name.as_str()).or_default().push(x.num);
        }
    }
    let key_of: FxMap<u32, u32> = cx.nodes.iter().filter_map(|x| Some((x.num, x.identity.as_ref()?.key_num?))).collect();
    for (s, ns) in shorts.into_iter().filter(|(_, v)| v.len() > 1) {
        for &n in &ns {
            let k = key_of.get(&n);
            let others: Vec<String> = ns.iter().filter(|&&o| o != n && (k.is_none() || key_of.get(&o) != k)).map(|&o| node_id(o)).collect();
            if others.is_empty() {
                continue;
            }
            out.add(n, "duplicate_name", "notice", format!("Short name \"{s}\" is not unique"), format!("Also used by {}: easy to confuse on the map and in apps.", others.join(", ")));
        }
    }
}
