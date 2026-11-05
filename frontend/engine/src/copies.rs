//! Each packet's gateway copies, grouped once per build with the transmitter
//! each copy was heard from (D-083). Zero-cost detection (D-068), router
//! reliability (D-078) and the airtime estimate (D-095) all walk every
//! packet's copies; grouping and resolving last-hop bytes (D-024) once
//! serves them all, and spotting gateways that uplink every copy they hear
//! (D-084).

use crate::graph::RelayContext;
use crate::row::{ty, HeardFrom, Row};
use crate::util::{map, set, FxMap, FxSet};

#[derive(Clone, Copy)]
pub struct Heard<'a> {
    pub row: &'a Row,
    /// Who the gateway heard this copy from: the originator for direct
    /// receptions, else the relay its last-hop byte resolves to. Only for
    /// copies with a hop limit, uplinked by a gateway other than the originator.
    pub sender: Option<u32>,
}

/// Radio copies reported by a gateway (no map reports, no copies that came
/// over MQTT or from outside RF), grouped by packet, in row order within a
/// packet. Copies are positions in the window's rows rather than references,
/// so the grouping is kept with the build (views::Built) for its views.
#[derive(Default)]
pub struct Copies {
    heard: Vec<(u32, Option<u32>)>, // (row position, sender), packet by packet
    ends: Vec<u32>,                 // where each packet's copies end in `heard`
}

/// One packet's copies.
#[derive(Clone, Copy)]
pub struct Packet<'s, 'a> {
    heard: &'s [(u32, Option<u32>)],
    rows: &'s [&'a Row],
}

impl<'s, 'a> Packet<'s, 'a> {
    pub fn first(&self) -> Heard<'a> {
        self.get(0)
    }
    fn get(&self, k: usize) -> Heard<'a> {
        let (p, sender) = self.heard[k];
        Heard { row: self.rows[p as usize], sender }
    }
    pub fn iter(&self) -> impl Iterator<Item = Heard<'a>> + '_ {
        (0..self.heard.len()).map(|k| self.get(k))
    }
}

impl Copies {
    /// `resolved`: relays already resolved with `ctx`, by row id
    /// (views::EdgeResult::resolved); other relayed copies resolve here.
    pub fn new(rows: &[&Row], ctx: &RelayContext, resolved: &FxMap<i64, Option<u32>>) -> Self {
        // Sorting (packet, position) pairs groups the copies with no map or
        // per-packet allocation, in row order within each packet.
        let mut keyed: Vec<(u64, u32)> = Vec::new();
        for (k, &r) in rows.iter().enumerate() {
            if r.gw.is_some() && r.ty != ty::MAPREPORT && r.rr != ty::VIA_MQTT && r.rr != ty::NON_RF {
                keyed.push((r.lp, k as u32));
            }
        }
        keyed.sort_unstable();
        let mut c = Copies { heard: Vec::with_capacity(keyed.len()), ends: Vec::new() };
        for (k, &(lp, p)) in keyed.iter().enumerate() {
            if k > 0 && keyed[k - 1].0 != lp {
                c.ends.push(k as u32);
            }
            let r = rows[p as usize];
            let gw = r.gw.unwrap();
            let sender = match (r.hl, r.heard_from()) {
                (Some(_), HeardFrom::Direct) => Some(r.src),
                (Some(_), HeardFrom::Relayed(Some(b))) => match resolved.get(&r.id) {
                    Some(&n) => n,
                    None => ctx.resolve(b, r.src, gw, r.rssi.map(f64::from)).and_then(Result::ok),
                },
                _ => None,
            };
            c.heard.push((p, sender));
        }
        if !keyed.is_empty() {
            c.ends.push(keyed.len() as u32);
        }
        c
    }

    /// Every packet's copies, by packet key; `rows`: the rows they were grouped from.
    pub fn packets<'s, 'a>(&'s self, rows: &'s [&'a Row]) -> impl Iterator<Item = Packet<'s, 'a>> {
        (0..self.ends.len()).map(move |k| {
            let a = if k == 0 { 0 } else { self.ends[k - 1] as usize };
            Packet { heard: &self.heard[a..self.ends[k] as usize], rows }
        })
    }
}

/// Packets a gateway must have uplinked more than one copy of before it
/// counts as uplinking every copy it hears.
pub const MULTI_UPLINK_MIN_PACKETS: usize = 3;

/// Gateways that uplink every copy they hear (D-084). Firmware today uplinks
/// only the first copy of a packet; a gateway with a future option to upload
/// each copy reports one packet several times, from different last hops (or
/// hop limits, or traceroute routes). Its own packets do not count. Copies
/// are distinct receptions: byte-identical re-deliveries collapse at ingest.
pub fn multi_uplinkers(rows: &[&Row]) -> FxSet<u32> {
    // Copies per (gateway, packet), then packets per gateway with more than one.
    let mut copies: FxMap<(u32, u64), usize> = map();
    for &r in rows {
        let Some(g) = r.gw else { continue };
        if g == r.src || r.ty == ty::MAPREPORT || r.rr == ty::VIA_MQTT || r.rr == ty::NON_RF {
            continue;
        }
        *copies.entry((g, r.lp)).or_default() += 1;
    }
    let mut count: FxMap<u32, usize> = map();
    for ((g, _), n) in copies {
        if n > 1 {
            *count.entry(g).or_default() += 1;
        }
    }
    let mut out = set();
    out.extend(count.into_iter().filter(|&(_, n)| n >= MULTI_UPLINK_MIN_PACKETS).map(|(g, _)| g));
    out
}
