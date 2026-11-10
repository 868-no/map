//! Remote-admin requests refused.

use super::{Ctx, Issues};
use crate::util::{map, FxMap, FxSet};

/// Distinct nodes refusing its remote-admin requests before it is noted.
pub const ADMIN_REFUSALS_MIN: usize = 2;

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let refused = ["ADMIN_PUBLIC_KEY_UNAUTHORIZED", "NOT_AUTHORIZED"].iter().filter_map(|s| cx.i.get(s)).collect::<FxSet<u32>>();
    let mut refusals: FxMap<u32, FxSet<u32>> = map();
    for &r in cx.rows {
        if let (Some(rt), Some(d)) = (r.routing(), r.dst)
            && refused.contains(&rt.error)
        {
            refusals.entry(d).or_default().insert(r.src);
        }
    }
    for (n, by) in refusals {
        if by.len() >= ADMIN_REFUSALS_MIN {
            out.add(n, "admin_refused", "notice", format!("Remote-admin requests refused by {} nodes", by.len()), format!("{} nodes answered its admin messages with \"not authorised\": it is sending remote-administration requests to nodes that have not authorised its key. Often an app's device-info request or a survey script; it costs airtime and never succeeds.", by.len()));
        }
    }
}
