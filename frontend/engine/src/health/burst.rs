//! Bursts (D-209): many of a node's own packets within a short time, of
//! any type and moving or not, which an hourly rate over the window
//! averages away.

use super::{Ctx, Issues};
use crate::row::{ty, Row};
use crate::util::time_mark;

/// A burst: at least `BURST_MIN` of a node's own packets within `BURST_MS`,
/// one a minute or faster, kept up.
pub const BURST_MIN: usize = 15;
pub const BURST_MS: i64 = 15 * 60_000;
/// Packet types that are conversation, counted in no burst: people
/// chatting, and the ACKs and NAKs their messages get.
const CONVERSATION: [&str; 3] = ["text", "direct_message", "routing"];

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let skip: Vec<u32> = CONVERSATION.iter().filter_map(|s| cx.i.get(s)).collect();
    // Answers to others' requests are theirs to account for.
    let counts = |r: &Row| !skip.contains(&r.ty) && !(r.ty == ty::TRACEROUTE && r.traceroute().is_some_and(|t| t.is_reply));
    for (&n, own) in &cx.own {
        let mut rows: Vec<&Row> = own.values().copied().filter(|r| counts(r)).collect();
        if rows.len() < BURST_MIN {
            continue;
        }
        rows.sort_unstable_by_key(|r| r.t);
        let Some((lo, hi)) = densest(&rows) else { continue };
        let run = &rows[lo..=hi];
        let (start, end) = (run[0].t, run[run.len() - 1].t);
        let gap = (end - start) as f64 / 1000.0 / (run.len() - 1) as f64;
        let mut kinds: Vec<(u32, usize)> = Vec::new();
        for r in run {
            match kinds.iter_mut().find(|k| k.0 == r.ty) {
                Some(k) => k.1 += 1,
                None => kinds.push((r.ty, 1)),
            }
        }
        kinds.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let what = kinds.iter().map(|&(t, c)| format!("{c} {}", cx.i.s(t).replace('_', " "))).collect::<Vec<_>>().join(", ");
        out.add(
            n,
            "burst",
            "warning",
            format!("Sent {} packets in 15 minutes", run.len()),
            format!(
                "{what}: about one every {gap:.0} s, from {} to {}. Each one is flooded through the mesh, so a node sending this often costs everyone airtime. Check its position, telemetry and NodeInfo intervals (and the smart broadcast minimum interval when it moves); NodeInfo and telemetry repeating every minute or two can also mean it keeps restarting. Messages, their ACKs and traceroute replies are not counted.",
                time_mark(start),
                time_mark(end)
            ),
        );
    }
}

/// The densest run of `rows` (in time order) within `BURST_MS`, as indices,
/// when it reaches `BURST_MIN`; the earliest of equally dense runs.
fn densest(rows: &[&Row]) -> Option<(usize, usize)> {
    let mut best: Option<(usize, usize)> = None;
    let mut lo = 0;
    for hi in 0..rows.len() {
        while rows[hi].t - rows[lo].t >= BURST_MS {
            lo += 1;
        }
        if hi - lo + 1 >= BURST_MIN && best.is_none_or(|(a, b)| hi - lo > b - a) {
            best = Some((lo, hi));
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use crate::health::tests::issues;
    use crate::row::{Interner, JRow, Row};

    /// Node 5's packets of type `y` at `secs` (seconds), one packet each.
    fn sent(i: &mut Interner, y: &str, first: usize, secs: &[i64]) -> Vec<Row> {
        secs.iter()
            .enumerate()
            .map(|(k, s)| {
                let k = first + k;
                let text = format!(r#"{{"i":{k},"t":{},"b":"x","g":99,"s":5,"y":"{y}","l":"{k:016x}","o":"{k:016x}","sg":"unsigned"}}"#, 1_800_000_000_000 + s * 1000);
                serde_json::from_str::<JRow>(&text).unwrap().into_row(i)
            })
            .collect()
    }

    #[test]
    fn packets_every_30_s_of_any_type_are_a_burst() {
        let mut i = Interner::default();
        let mut rows = sent(&mut i, "position", 0, &(0..25).map(|k| k * 30).collect::<Vec<_>>());
        rows.extend(sent(&mut i, "encrypted", 100, &(0..5).map(|k| 15 + k * 30).collect::<Vec<_>>()));
        let got = issues(&rows, &i);
        let b = got.iter().find(|x| x.kind == "burst").expect("burst flagged");
        assert_eq!((b.severity, b.summary.as_str()), ("warning", "Sent 30 packets in 15 minutes"));
        assert!(b.detail.starts_with("25 position, 5 encrypted: about one every 25 s"), "{}", b.detail);
    }

    #[test]
    fn slower_than_one_a_minute_or_conversation_is_not_a_burst() {
        let mut i = Interner::default();
        // 14 within any 15 minutes: one every 65 s.
        let slow = sent(&mut i, "telemetry", 0, &(0..60).map(|k| k * 65).collect::<Vec<_>>());
        assert!(issues(&slow, &i).iter().all(|x| x.kind != "burst"));
        // A chat: messages and their ACKs.
        let mut chat = sent(&mut i, "direct_message", 0, &(0..20).map(|k| k * 20).collect::<Vec<_>>());
        chat.extend(sent(&mut i, "routing", 100, &(0..20).map(|k| 10 + k * 20).collect::<Vec<_>>()));
        assert!(issues(&chat, &i).iter().all(|x| x.kind != "burst"));
    }
}
