//! Directional 0-cost links (D-068).
//!
//! Firmware lets a ROUTER, ROUTER_LATE or CLIENT_BASE rebroadcast without
//! spending a hop when the copy it heard came from a favourite of its own
//! that has one of those roles (`Router::shouldDecrementHopLimit`); the first
//! hop, heard from the originator, always spends one. Being a favourite is
//! one node's setting about another, so the rule is directional: U -> R can
//! be free while R -> U costs a hop.
//!
//! Gateways report the hop limit each transmitter sent: the originator's for
//! direct receptions, the relay's (resolved from the last-hop byte) for
//! rebroadcasts. For a relay R and a transmitter U that R hears, R sending
//! the same hop limit as U is evidence that U -> R is free; one less, that it
//! costs a hop. A packet counts only when exactly one transmitter R hears
//! explains R's value. Transmitters no gateway heard can still mislead a
//! single packet, so a link is called 0-cost only on repeated, consistent
//! evidence.

use serde::Serialize;

use crate::copies::Heard;
use crate::graph::zero_cost_role;
use crate::util::{map, FxMap, FxSet};

/// Evidence for one directed link U -> R (R relays what it heard from U).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct ZeroCost {
    /// Packets R rebroadcast with U's hop limit (no hop spent).
    pub free: u32,
    /// Packets R rebroadcast with one hop less than U sent.
    pub spent: u32,
    /// Enough consistent evidence to call the link 0-cost.
    pub likely: bool,
}

/// At least this many free packets, making up at least this share.
pub const MIN_FREE: u32 = 3;
pub const MIN_SHARE: f64 = 0.8;

/// Evidence per directed pair (U, R). packets: every packet's radio copies
/// (`copies::by_packet`); hears: (tx, rx) pairs where rx heard tx over the
/// radio; roles: announced roles (unknown roles are allowed).
pub fn detect(packets: &[Vec<Heard>], hears: &FxSet<(u32, u32)>, roles: &FxMap<u32, String>) -> FxMap<(u32, u32), ZeroCost> {
    let can = |n: u32| roles.get(&n).is_none_or(|r| r.is_empty() || zero_cost_role(r));
    let mut out: FxMap<(u32, u32), ZeroCost> = map();
    for all in packets {
        // Copies with both hop fields only.
        let copies: Vec<&Heard> = all.iter().filter(|h| h.row.hs.is_some() && h.row.hl.is_some()).collect();
        let Some(first) = copies.first() else { continue };
        let origin = first.row.src;
        // The hop limit each transmitter sent; a transmitter seen with two
        // values (two rebroadcasts, or a misresolved byte) is left out.
        let mut sent: FxMap<u32, i16> = map();
        let mut conflict: FxSet<u32> = FxSet::default();
        let mut note = |n: u32, l: i16| match sent.get(&n) {
            Some(&v) if v != l => {
                conflict.insert(n);
            }
            Some(_) => {}
            None => {
                sent.insert(n, l);
            }
        };
        note(origin, first.row.hs.unwrap());
        for h in &copies {
            if let Some(sender) = h.sender {
                note(sender, h.row.hl.unwrap());
            }
        }
        for c in &conflict {
            sent.remove(c);
        }
        for (&relay, &l) in &sent {
            if relay == origin || !can(relay) {
                continue;
            }
            let mut free = None;
            let (mut frees, mut paid, mut payer) = (0, 0, 0u32);
            for (&u, &lu) in &sent {
                if u == relay || !hears.contains(&(u, relay)) {
                    continue;
                }
                if lu == l + 1 {
                    paid += 1;
                    payer = u;
                } else if lu == l && u != origin && can(u) {
                    frees += 1;
                    free = Some(u);
                }
            }
            match (frees, paid) {
                (1, 0) => out.entry((free.unwrap(), relay)).or_default().free += 1,
                // The origin's hop always costs: it says nothing about favourites.
                (0, 1) if payer != origin => out.entry((payer, relay)).or_default().spent += 1,
                _ => {}
            }
        }
    }
    for z in out.values_mut() {
        z.likely = z.free >= MIN_FREE && z.free as f64 >= MIN_SHARE * (z.free + z.spent) as f64;
    }
    out
}
