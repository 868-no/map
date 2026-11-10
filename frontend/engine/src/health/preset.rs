//! Wrong preset: the mesh's preset from its channel names (each packet once
//! per name); a node the node panel's inference puts on another preset.

use super::{Ctx, Issues};
use crate::util::{map, FxMap, FxSet};

pub(super) fn check(cx: &Ctx, out: &mut Issues) {
    let i = cx.i;
    let named: FxSet<(&'static str, u64)> = cx.rows.iter().filter_map(|r| i.preset(r.channel).map(|p| (p, r.lp))).collect();
    let mut by_preset: FxMap<&'static str, usize> = map();
    for &(p, _) in &named {
        *by_preset.entry(p).or_default() += 1;
    }
    let Some(mesh) = by_preset.iter().max_by_key(|&(p, c)| (*c, *p)).map(|(&p, _)| p) else { return };
    for (&n, pk) in &cx.own {
        let Some(g) = crate::channels::infer(n, cx.presets) else { continue };
        let Some(p) = g.preset.filter(|&p| p != mesh) else { continue };
        let why = match g.basis {
            "map_report" => "Its own map report confirms",
            "radio_contact" => "Map reports of nodes it shares radio contact with confirm",
            // Channel names are only a hint (a secondary channel can carry
            // such a name): never when it was also heard on the mesh's.
            "channel_name" if pk.len() >= 3 && !pk.values().any(|r| i.preset(r.channel) == Some(mesh)) => "Its packets were heard on a channel named for",
            _ => continue,
        };
        out.add(n, "preset", "warning", format!("Uses {} while the mesh uses {}", label(p), label(mesh)), format!("{why} the {} preset, but most of the mesh is heard on {}. Nodes on different presets cannot hear each other, so it is cut off from most of the mesh.", label(p), label(mesh)));
    }
}

/// NARROW_FAST -> Narrow Fast.
fn label(p: &str) -> String {
    p.split('_').map(|w| w[..1].to_uppercase() + &w[1..].to_lowercase()).collect::<Vec<_>>().join(" ")
}
